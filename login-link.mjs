#!/usr/bin/env node
/**
 * login-link.mjs —— 「链接登录」：无需手动复制 sessionKey
 *
 * 流程：
 *   1. 启动一个带独立 user-data-dir 的 Chrome/Edge（可见窗口），打开 claude.ai 登录页
 *   2. 通过 CDP（Chrome DevTools Protocol）轮询 claude.ai 的 cookies
 *   3. 用户登录成功后自动捕获 sessionKey + cf_clearance + 其余 cookie + 浏览器精确 UA
 *      （cf_clearance 与 UA 必须配套，否则上游会触发 Cloudflare 挑战）
 *   4. 用完整 cookie 请求 /api/organizations 校验并发现 org
 *   5. 回调 onCapture 写入账号池，自动关闭浏览器并清理临时 profile
 *
 * 零外部依赖：Node 22 自带全局 WebSocket；CDP 走浏览器调试端口的 ws 连接。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { MaoMailClient } from './maomail.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function findBrowser() {
  if (process.env.LOGIN_BROWSER && fs.existsSync(process.env.LOGIN_BROWSER)) {
    return process.env.LOGIN_BROWSER;
  }
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  // 优先匹配当前系统的默认浏览器（若用户默认是 Edge 则优先拉起 Edge，避免调起未用的 Chrome 导致看不见窗口）
  let preferEdge = false;
  if (process.platform === 'win32') {
    try {
      const reg = execSync('reg query HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice /v ProgId', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      if (/edge/i.test(reg)) preferEdge = true;
    } catch {}
  }

  const order = preferEdge ? [...edgePaths, ...chromePaths] : [...chromePaths, ...edgePaths];
  for (const p of order) {
    try { if (fs.existsSync(p)) return p; } catch { /* noop */ }
  }
  throw new Error('找不到 Chrome/Edge，可用 LOGIN_BROWSER 环境变量指定浏览器 exe 路径');
}

const ALLOCATED_PORTS = new Set();
function freePort() {
  return new Promise((resolve, reject) => {
    function pick() {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => {
          if (ALLOCATED_PORTS.has(p)) {
            setTimeout(pick, 30);
          } else {
            ALLOCATED_PORTS.add(p);
            resolve(p);
          }
        });
      });
    }
    pick();
  });
}

/** 等 CDP 调试端口就绪；返回 version 信息，超时或进程提前退出返回 null */
async function waitCdp(port, timeoutSec, flow = null) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    if (flow?.proc && (flow.proc.exitCode !== null || flow.proc.killed)) {
      return null;
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(900) });
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    if (Date.now() >= deadline) return null;
    await sleep(400);
  }
}

/**
 * 把刚拉起的浏览器窗口拉到前台。
 *
 * 我们是无窗口的后台进程，spawn 出来的浏览器窗口**不一定在前台**，
 * 经常压在用户自己的浏览器后面 —— 用户看不到就以为"没打开新浏览器"。
 * 这里用 PowerShell + user32 把窗口恢复出来并置前（Windows 专属，内存执行，不落盘临时脚本）。
 */
function focusBrowserWindow(pid) {
  if (process.platform !== 'win32' || !pid) return;
  const ps = `$TargetPid = ${pid}; Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class Win32Focus {[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);}' -ErrorAction SilentlyContinue; $d = (Get-Date).AddSeconds(15); while ((Get-Date) -lt $d) { $p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p) { [Win32Focus]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [Win32Focus]::BringWindowToTop($p.MainWindowHandle) | Out-Null; [Win32Focus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; exit 0; }; Start-Sleep -Milliseconds 400; }; exit 1;`;
  try {
    const b64 = Buffer.from(ps, 'utf16le').toString('base64');
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {}
}

/** 极简 CDP 客户端（浏览器级 target） */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', ev => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (!m.id || !this.pending.has(m.id)) return;
      const { resolve, reject, timer } = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(timer);
      m.error ? reject(new Error(m.error.message || 'CDP error')) : resolve(m.result);
    });
  }

  static async connect(url) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('需要 Node.js 22+（全局 WebSocket）；当前版本不支持 CDP 连接');
    }
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP 连接超时')), 8000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP 连接失败（检查 --remote-allow-origins）')); }, { once: true });
    });
    return new CDP(ws);
  }

  call(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  close() { try { this.ws.close(); } catch { /* noop */ } }
}

/** 取回 claude.ai 域下的全部 cookie（含 HttpOnly） */
async function readCookies(flow) {
  // 1) 浏览器级 Storage.getCookies（Chrome/Edge 100+ 支持，覆盖所有 profile cookie）
  try {
    const r = await flow.cdp.call('Storage.getCookies');
    if (Array.isArray(r?.cookies)) return r.cookies;
  } catch { /* 老版本回退到页面 target */ }

  // 2) 页面级 Network.getAllCookies
  if (!flow.pageCdp || flow.pageCdp.ws.readyState !== 1) {
    await ensurePageCdp(flow);
  }
  const r = await flow.pageCdp.call('Network.getAllCookies');
  return r?.cookies || [];
}

function claudeCookies(cookies) {
  return cookies.filter(c => {
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    return d === 'claude.ai' || d.endsWith('.claude.ai');
  });
}

/** 取回/复用「页面级」CDP 连接（DOM 检测与跳转都用它） */
async function ensurePageCdp(flow) {
  if (flow.pageCdp && flow.pageCdp.ws.readyState === 1) return flow.pageCdp;
  const list = await (await fetch(`http://127.0.0.1:${flow.port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  })).json();
  const page = list.find(t => t.type === 'page' && /claude\.ai/.test(t.url))
    || list.find(t => t.type === 'page');
  if (!page) throw new Error('找不到浏览器页面 target');
  flow.pageCdp = await CDP.connect(page.webSocketDebuggerUrl);
  return flow.pageCdp;
}

/**
 * 在登录页上下文里检测「需要人工介入的验证」——返回 kind 或 null。
 * 判据全部基于**当前是否可见**，页面没弹验证时不会误报：
 *   hcaptcha/recaptcha 人机验证框、Cloudflare 挑战、空的验证码输入框。
 * （本流程只负责提示用户去人工完成，不代为通过验证。）
 */
const VERIFY_EXPR = `(() => {
  const vis = el => { try {
    if (!el || !el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  } catch (e) { return false; } };
  const src = f => { try { return String(f.src || '').toLowerCase(); } catch (e) { return ''; } };
  const frames = Array.prototype.slice.call(document.querySelectorAll('iframe')).filter(vis);
  if (frames.some(f => src(f).indexOf('hcaptcha.com') >= 0)) return 'hcaptcha';
  if (Array.prototype.slice.call(document.querySelectorAll('.h-captcha,#hcaptcha-container,[data-hcaptcha-widget-id]')).some(vis)) return 'hcaptcha';
  if (frames.some(f => src(f).indexOf('challenges.cloudflare.com') >= 0)) return 'cloudflare';
  if (String(document.title || '').toLowerCase().indexOf('just a moment') === 0) return 'cloudflare';
  if (frames.some(f => src(f).indexOf('recaptcha') >= 0)) return 'recaptcha';
  const inputs = Array.prototype.slice.call(document.querySelectorAll('input')).filter(vis);
  const codePending = inputs.some(i => {
    const type = String(i.type || '').toLowerCase();
    const mode = String(i.inputMode || '').toLowerCase();
    const ac = String(i.autocomplete || '').toLowerCase();
    const txt = [i.name, i.id, i.placeholder, i.getAttribute('aria-label')].join(' ').toLowerCase();
    const looksCode = type === 'tel' || mode === 'numeric' || ac === 'one-time-code'
      || txt.indexOf('code') >= 0 || txt.indexOf('verification') >= 0 || txt.indexOf('otp') >= 0;
    return looksCode && !String(i.value || '').trim();
  });
  if (codePending) return 'email_code';
  return null;
})()`;

const VERIFY_LABEL = {
  hcaptcha: 'hCaptcha 人机验证',
  cloudflare: 'Cloudflare 安全检查',
  recaptcha: 'reCAPTCHA 人机验证',
  email_code: '邮箱验证码',
  email_link: '邮件登录链接',
};

const VERIFY_HINT = {
  hcaptcha: '⚠️ 需要人工验证：请到弹出的浏览器窗口完成 hCaptcha（勾选「我是人类」或完成图片选择）。'
    + '完成后无需刷新、无需任何操作 —— 本流程会自动继续并捕获登录态',
  cloudflare: '⚠️ 需要人工验证：浏览器窗口正显示 Cloudflare 安全检查，请在窗口里点选通过。完成后会自动继续',
  recaptcha: '⚠️ 需要人工验证：请到浏览器窗口完成 reCAPTCHA 验证，完成后会自动继续',
  email_code: '📧 需要人工验证：请查收登录邮箱的验证码并在浏览器窗口中输入；'
    + '也可以把邮件里的登录链接粘贴到本页下方，完成后会自动捕获',
  email_link: '📧 需要登录邮件：魔法链接已发送，请查收邮件 —— 可在浏览器窗口里完成，'
    + '或把邮件里的登录链接粘贴到本页下方，完成后会自动捕获',
};

/** 当前是否卡在需要人工介入的验证上：先看页面 DOM，再看 pendingLogin cookie */
async function detectVerify(f, cookies) {
  try {
    const cdp = await ensurePageCdp(f);
    const r = await cdp.call('Runtime.evaluate', { expression: VERIFY_EXPR, returnByValue: true });
    const v = r?.result?.value;
    if (typeof v === 'string' && v) return v;
  } catch { /* 页面导航中/读取失败：当作无验证，下一轮再判 */ }
  // 魔法链接已发出（send_magic_link 成功）：等用户查收邮件
  if (cookies?.some(c => c.name === 'pendingLogin' && c.value && c.value !== 'false')) return 'email_link';
  return null;
}

/** 用完整 cookie + UA 校验登录态并发现组织 */
async function validateLogin({ cookie, ua, base }) {
  const r = await fetch(`${base}/api/organizations`, {
    headers: {
      cookie,
      'user-agent': ua,
      accept: 'application/json',
      origin: base,
      referer: base + '/',
    },
    signal: AbortSignal.timeout(15000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 120)}`);
  let arr;
  try { arr = JSON.parse(txt); } catch { throw new Error('组织接口返回非 JSON'); }
  const list = Array.isArray(arr) ? arr : (arr.data || []);
  const org = list[0]?.uuid;
  if (!org) throw new Error('未返回组织信息（登录可能未完成）');
  return { org, name: list[0]?.name || '', plan: list[0]?.rate_limit_tier || '' };
}

/**
 * 登录流程管理器。
 * @param {{onCapture: Function, baseUrl: string, webBase?: string, timeoutMs?: number, loginUrl?: string}} opts
 */
export function createLoginManager(opts) {
  const {
    onCapture,
    baseUrl = 'http://127.0.0.1:8787',
    webBase = 'https://claude.ai',
    timeoutMs = 5 * 60 * 1000,
    loginUrl = 'https://claude.ai/login',
    getMaoMailToken = () => '',
    getMaoMailBaseUrl = () => 'https://zjkdongao.cn',
  } = opts;

  const flows = new Map();
  let active = null;
  const LIVE = new Set(['starting', 'waiting', 'capturing']);

  function stateOf(f) {
    return {
      id: f.id,
      state: f.state,
      message: f.message,
      link: f.link,
      browser: f.browser || '',
      startedAt: f.startedAt,
      expiresAt: f.expiresAt,
      account: f.account || null,
      auto_email: f.autoEmail || '',
      // 需要人工验证：true 时用户必须到浏览器窗口完成验证/查收邮件，完成后流程自动继续
      need_verify: !!f.needVerify,
      verify: f.verify || null,
      verify_label: f.verify ? (VERIFY_LABEL[f.verify] || f.verify) : null,
    };
  }

  async function submitEmailToClaude(flow, email) {
    const cdp = await ensurePageCdp(flow);
    const start = Date.now();
    while (Date.now() - start < 20000) {
      if (!LIVE.has(flow.state)) return false;
      try {
        const r = await cdp.call('Runtime.evaluate', {
          expression: `(() => {
            const input = document.querySelector('input[type="email"], input[name="email"], input#email');
            if (!input) return false;
            input.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) {
              setter.call(input, ${JSON.stringify(email)});
            } else {
              input.value = ${JSON.stringify(email)};
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            const btn = document.querySelector('button[type="submit"]')
              || [...document.querySelectorAll('button')].find(b => /continue|继续|login|登录/i.test(b.innerText || ''));
            if (btn && !btn.disabled) {
              btn.click();
              return true;
            }
            return 'ready';
          })()`,
          returnByValue: true
        });
        if (r?.result?.value === true) return true;
      } catch {}
      await sleep(600);
    }
    return false;
  }

  async function fillCodeInClaude(flow, code) {
    try {
      const cdp = await ensurePageCdp(flow);
      const digits = String(code).trim().split('');
      await cdp.call('Runtime.evaluate', {
        expression: `(() => {
          const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="tel"], input[inputmode="numeric"]'));
          const digits = ${JSON.stringify(digits)};
          if (inputs.length === 6) {
            inputs.forEach((inp, idx) => {
              inp.value = digits[idx] || '';
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
            });
            const btn = document.querySelector('button[type="submit"]')
              || [...document.querySelectorAll('button')].find(b => /continue|验证|verify/i.test(b.innerText || ''));
            if (btn && !btn.disabled) btn.click();
            return true;
          }
          const single = document.querySelector('input[name*="code" i], input[id*="code" i]');
          if (single) {
            single.value = ${JSON.stringify(code)};
            single.dispatchEvent(new Event('input', { bubbles: true }));
            single.dispatchEvent(new Event('change', { bubbles: true }));
            const btn = document.querySelector('button[type="submit"]')
              || [...document.querySelectorAll('button')].find(b => /continue|验证|verify/i.test(b.innerText || ''));
            if (btn && !btn.disabled) btn.click();
            return true;
          }
          return false;
        })()`,
        returnByValue: true
      });
    } catch {}
  }

  async function autoHandleMaoMail(f) {
    if (f._handlingMaoMail) return;
    f._handlingMaoMail = true;
    const token = typeof getMaoMailToken === 'function' ? getMaoMailToken() : getMaoMailToken;
    if (!token) {
      console.log(`[login] ${f.id} 未配置肥猫猫 Token，跳过自动收信`);
      return;
    }
    const baseUrl = typeof getMaoMailBaseUrl === 'function' ? getMaoMailBaseUrl() : getMaoMailBaseUrl;
    const client = new MaoMailClient({ token, baseUrl });

    try {
      f.message = `已提交邮箱 ${f.autoEmail}，正在从肥猫猫自动轮询验证邮件…`;
      console.log(`[login] ${f.id} 开始轮询肥猫猫邮箱: ${f.autoEmail}`);
      const detail = await client.waitForVerification({
        email: f.autoEmail,
        sinceTimestamp: f.startedAt,
        timeoutMs: 120000,
        isAborted: () => !LIVE.has(f.state) || f.state === 'closed' || f.state === 'cancelled',
        onProgress: msg => {
          if (LIVE.has(f.state) && f.state !== 'capturing') {
            f.message = msg;
          }
        }
      });

      if (detail.magicLink) {
        console.log(`[login] ${f.id} 自动捕获到 Claude 魔法链接: ${detail.magicLink}`);
        f.message = '已收到 Claude 魔法登录链接，正在自动跳转完成登录…';
        const cdp = await ensurePageCdp(f);
        await cdp.call('Page.navigate', { url: detail.magicLink });
        console.log(`[login] ${f.id} 已执行魔法链接跳转导航`);
      } else if (detail.code) {
        console.log(`[login] ${f.id} 自动捕获到 Claude 验证码: ${detail.code}`);
        f.message = `已收到 Claude 验证码 ${detail.code}，正在自动填入…`;
        await fillCodeInClaude(f, detail.code);
      }
    } catch (err) {
      console.warn(`[login] ${f.id} 自动收信异常: ${err.message}`);
      if (LIVE.has(f.state) && f.state !== 'capturing') {
        f.message = `自动收信提示: ${err.message}。你也可以在浏览器中手动完成。`;
      }
    }
  }

  function cleanup(f) {
    if (f.port) ALLOCATED_PORTS.delete(f.port);
    try { f.pageCdp?.close(); } catch { /* noop */ }
    try { f.cdp?.close(); } catch { /* noop */ }
    if (f.proc && !f.proc.killed && f.proc.exitCode === null) {
      // Windows 上 Chrome 会有子进程树，taskkill /T 才能干净退出并释放 profile
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/PID', String(f.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* noop */ }
      } else {
        try { f.proc.kill('SIGTERM'); } catch { /* noop */ }
      }
    }
    if (f.profile) {
      // 登录态已入库，临时 profile 里的 cookie 不再需要，删掉避免凭据残留
      setTimeout(() => {
        try { fs.rmSync(f.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* noop */ }
      }, 800);
    }
    if (active === f) active = null;
  }

  /**
   * 轮询 cookie → 捕获 sessionKey → 校验组织 → 入池。
   * 抽成独立函数，是为了让「调试端口迟到就绪」的后台重试也能接着跑。
   */
  async function captureLoop(f) {
    let lastHint = '';
    let consecutiveFails = 0;
    while (Date.now() < f.expiresAt && f.state !== 'cancelled' && f.state !== 'closed') {
      if (f.proc && (f.proc.exitCode !== null || f.proc.killed)) {
        console.log(`[login] ${f.id} 浏览器进程已关闭，停止轮询`);
        f.state = 'closed';
        f.message = '登录浏览器窗口已被关闭，请点击下方「重新发起登录」重新打开';
        if (active === f) active = null;
        break;
      }

      let cookies = [];
      try {
        cookies = claudeCookies(await readCookies(f));
        consecutiveFails = 0;
      } catch (e) {
        consecutiveFails++;
        lastHint = ` · 读取 cookie 中（${e.message}）`;
        // 如果连续 4 次（约 5 秒）连不上调试端口，判断浏览器已断开或被关闭
        if (consecutiveFails >= 4) {
          console.warn(`[login] ${f.id} 连续 ${consecutiveFails} 次读取 cookie 失败，判断浏览器连接已断开`);
          f.state = 'closed';
          f.message = '登录浏览器已关闭或连接断开，请点击下方「重新发起登录」重新打开';
          if (active === f) active = null;
          break;
        }
      }

      const sk = cookies.find(c => c.name === 'sessionKey' && c.value);
      if (sk) {
        f.state = 'capturing';
        f.message = '已捕获登录凭据，正在校验组织信息…';
        const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        try {
          const base = typeof webBase === 'function' ? webBase() : webBase;
          const info = await validateLogin({ cookie, ua: f.ua, base });
          const account = await onCapture({
            sessionKey: sk.value,
            cookie,
            ua: f.ua,
            org: info.org,
            name: info.name,
            plan: info.plan,
          });
          f.account = account;
          f.state = 'done';
          f.message = '登录成功，账号已自动加入账号池（含 cf_clearance 与匹配 UA）';
          break;
        } catch (e) {
          // sessionKey 刚出现但组织校验未过：可能页面还在跳转，继续等
          f.state = 'waiting';
          f.message = `正在等待登录完成…（${e.message}）`;
        }
      } else if (f.state !== 'capturing') {
        f.state = 'waiting';
        // —— 人工验证检测：需要用户介入时把话说清楚，用户完成后自动继续捕获 ——
        const kind = await detectVerify(f, cookies);
        if (kind) {
          if (f.verify !== kind) {
            f.verify = kind;
            console.log(`[login] ${f.id} 需要人工验证：${VERIFY_LABEL[kind] || kind}（等待用户完成后自动继续）`);
            // 验证常要换邮箱/等邮件/过页面加载，给一轮新的等待窗口（最多补 4 次，防止无限等）
            if ((f.verifyExtends || 0) < 4) {
              f.verifyExtends = (f.verifyExtends || 0) + 1;
              f.expiresAt = Math.max(f.expiresAt, Date.now() + timeoutMs);
            }
            // 把登录窗口提到最前，用户能立刻看到要验证的地方
            try { await (await ensurePageCdp(f)).call('Page.bringToFront'); }
            catch { /* 置顶失败不影响流程 */ }
          }
          f.needVerify = true;

          // 自动肥猫猫收信联动：若是邮件验证，启动自动轮询收信
          if ((kind === 'email_link' || kind === 'email_code') && f.autoEmail && !f._handlingMaoMail) {
            autoHandleMaoMail(f);
          } else if ((kind === 'email_link' || kind === 'email_code') && !f.autoEmail && !f._handlingMaoMail) {
            // 尝试从页面探测用户手动输入的邮箱
            try {
              const cdp = await ensurePageCdp(f);
              const r = await cdp.call('Runtime.evaluate', {
                expression: `(() => {
                  const m = document.body.innerText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                  return m ? m[1] : '';
                })()`,
                returnByValue: true
              });
              const detected = r?.result?.value;
              if (detected && typeof detected === 'string' && detected.includes('@')) {
                f.autoEmail = detected.trim();
                console.log(`[login] ${f.id} 从页面探测到邮箱: ${f.autoEmail}，启动肥猫猫自动收信`);
                autoHandleMaoMail(f);
              }
            } catch {}
          }

          f.message = VERIFY_HINT[kind] || `需要人工验证（${VERIFY_LABEL[kind] || kind}），到浏览器窗口完成后会自动继续`;
        } else if (f.verify) {
          // 验证消失了 = 用户已完成，自动往下走（无需刷新/重启）
          f.verify = null;
          f.needVerify = false;
          f.verifyPassedAt = Date.now();
          f.message = '✅ 验证已通过，正在自动继续捕获登录态…';
          console.log(`[login] ${f.id} 验证已通过，自动继续捕获`);
        } else if (f.verifyPassedAt && Date.now() - f.verifyPassedAt < 6000) {
          f.message = '✅ 验证已通过，正在自动继续捕获登录态…';
        } else {
          f.verifyPassedAt = 0;
          if (!f.autoEmail) {
            f.message = '等待登录中… 请在浏览器窗口里完成 claude.ai 登录'
              + '（窗口会自动置前；若被压在其它窗口后面，看任务栏闪烁图标）' + lastHint;
          }
        }
      }
      await sleep(1200);
    }

    if (LIVE.has(f.state)) {
      f.state = 'timeout';
      f.message = '登录超时（5 分钟未检测到有效 sessionKey），可重新发起';
    }
  }

  /** 调试端口迟到就绪时，后台接上并继续自动捕获（浏览器窗口不关） */
  async function waitCdpInBackground(f) {
    const ver = await waitCdp(f.port, 300, f);   // 再等 5 分钟
    if (!ver?.webSocketDebuggerUrl) return;
    if (f.state === 'cancelled' || f.state === 'closed' || f.state === 'done') return;
    try {
      f.cdp = await CDP.connect(ver.webSocketDebuggerUrl);
      try {
        const v = await f.cdp.call('Browser.getVersion');
        f.ua = v?.userAgent || f.ua || DEFAULT_UA;
      } catch { /* noop */ }
      console.log(`[login] ${f.id} 调试端口迟到了，已接上，继续自动捕获`);
      await captureLoop(f);
    } catch (e) {
      console.warn(`[login] ${f.id} 接上调试端口失败：${e.message}`);
    }
  }

  async function run(f) {
    try {
      const exe = findBrowser();
      f.browser = path.basename(exe);
      console.log(`[login] ${f.id} 正在启动登录浏览器: ${exe}`);
      f.port = await freePort();
      f.profile = path.join(os.tmpdir(), `claude-free-login-${f.id}`);
      fs.mkdirSync(f.profile, { recursive: true });

      const args = [
        `--remote-debugging-port=${f.port}`,
        `--user-data-dir=${f.profile}`,
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        '--new-window',
        loginUrl,
      ];
      f.proc = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
      f.proc.on('error', e => {
        console.warn(`[login] ${f.id} 浏览器启动失败: ${e.message}`);
        f.state = 'error';
        f.message = `浏览器启动失败：${e.message}`;
        if (active === f) active = null;
      });
      f.proc.on('exit', (code, sig) => {
        console.log(`[login] ${f.id} 浏览器窗口已退出 (code=${code})`);
        if (LIVE.has(f.state)) {
          f.state = 'closed';
          f.message = '登录浏览器窗口已被关闭，请点击下方「重新发起登录」重新打开';
        }
        if (active === f) active = null;
      });
      f.state = 'waiting';
      f.message = `已调起独立登录窗口（${f.browser}）—— 请在弹出的浏览器中完成 claude.ai 登录`
        + `（窗口会自动置前；若被压在其它窗口后面，看任务栏闪烁图标），完成后会自动捕获入池`;

      // 后台进程 spawn 出来的窗口不一定在前台 —— 主动拉到前台，别让用户以为"没打开"（批量模式下不抢焦点）
      if (!f._batchItem) focusBrowserWindow(f.proc.pid);

      // 等调试端口就绪（冷启动 + 安全软件扫描可能较慢，给 60s）
      const ver = await waitCdp(f.port, 60, f);
      if (!ver?.webSocketDebuggerUrl) {
        if (f.proc && (f.proc.exitCode !== null || f.proc.killed)) {
          f.state = 'closed';
          f.message = '登录浏览器窗口已关闭，请点击下方「重新发起登录」重新打开';
          if (active === f) active = null;
          return;
        }
        f.message = '浏览器已启动，但调试端口 60 秒内没就绪（可能被安全软件拦截）。'
          + '窗口仍然开着：请在窗口里登录后回本页用「手动输入」贴 sessionKey；'
          + '端口一旦就绪会自动继续捕获。';
        console.warn(`[login] ${f.id} CDP 端口未就绪，保留浏览器窗口并后台继续等待`);
        waitCdpInBackground(f);
        return;
      }

      f.cdp = await CDP.connect(ver.webSocketDebuggerUrl);
      try {
        const v = await f.cdp.call('Browser.getVersion');
        f.ua = v?.userAgent || DEFAULT_UA;
      } catch { f.ua = DEFAULT_UA; }

      // 如果指定了邮箱，后台自动尝试向 Claude 页面填入并提交
      if (f.autoEmail) {
        f.message = `正在向 Claude.ai 自动填入邮箱 ${f.autoEmail}…`;
        submitEmailToClaude(f, f.autoEmail).then(ok => {
          console.log(`[login] ${f.id} 自动提交邮箱 ${f.autoEmail} 结果: ${ok}`);
          autoHandleMaoMail(f);
        }).catch(e => {
          console.warn(`[login] ${f.id} 自动提交邮箱异常: ${e.message}`);
          autoHandleMaoMail(f);
        });
      }

      await captureLoop(f);
    } catch (e) {
      if (f.state !== 'cancelled' && f.state !== 'closed') {
        f.state = 'error';
        f.message = e.message || String(e);
      }
    } finally {
      cleanup(f);
    }
  }

  /* ---------------- 多邮箱并发批量登录引擎 ---------------- */
  let activeBatch = null;

  function batchStatus() {
    if (!activeBatch) return null;
    const done = activeBatch.items.filter(x => x.state === 'done').length;
    const failed = activeBatch.items.filter(x => x.state === 'error' || x.state === 'timeout' || x.state === 'closed').length;
    const running = activeBatch.items.filter(x => LIVE.has(x.state)).length;
    const pending = activeBatch.items.filter(x => x.state === 'pending').length;
    return {
      id: activeBatch.id,
      status: activeBatch.status,
      concurrency: activeBatch.concurrency,
      total: activeBatch.total,
      done,
      failed,
      running,
      pending,
      startedAt: activeBatch.startedAt,
      endedAt: activeBatch.endedAt,
      items: activeBatch.items.map(x => ({
        index: x.index,
        email: x.email,
        state: x.state,
        message: x.message,
        flowId: x.flowId,
        account: x.account,
        startedAt: x.startedAt,
        endedAt: x.endedAt,
        error: x.error,
      })),
    };
  }

  function cancelBatch() {
    if (!activeBatch || activeBatch.status !== 'running') {
      return batchStatus();
    }
    activeBatch._cancelled = true;
    activeBatch.status = 'cancelled';
    activeBatch.endedAt = Date.now();
    for (const it of activeBatch.items) {
      if (it.state === 'pending') {
        it.state = 'cancelled';
        it.message = '批量任务已终止';
      } else if (LIVE.has(it.state) && it.flowId) {
        const f = flows.get(it.flowId);
        if (f) {
          f.state = 'cancelled';
          f.message = '已取消';
          cleanup(f);
        }
        it.state = 'cancelled';
        it.message = '已终止，浏览器已关闭';
      }
    }
    return batchStatus();
  }

  function startBatch(emails = [], concurrency = 2, requestUrl = '') {
    if (activeBatch && activeBatch.status === 'running') {
      return { ok: false, message: '已有正在执行的批量任务，请等待完成或先终止' };
    }
    const cleanEmails = [...new Set(emails.map(e => String(e).trim()).filter(Boolean))];
    if (!cleanEmails.length) {
      return { ok: false, message: '没有有效的邮箱列表' };
    }
    const conc = Math.max(1, Math.min(5, +concurrency || 2));
    const batchId = randomBytes(4).toString('hex');
    const items = cleanEmails.map((email, idx) => ({
      index: idx + 1,
      email,
      state: 'pending',
      message: '排队等待启动…',
      flowId: null,
      account: null,
      startedAt: null,
      endedAt: null,
      error: null,
    }));

    activeBatch = {
      id: batchId,
      status: 'running',
      concurrency: conc,
      total: items.length,
      startedAt: Date.now(),
      endedAt: null,
      items,
      _cancelled: false,
    };

    runBatchQueue(activeBatch, requestUrl);

    return { ok: true, batch: batchStatus() };
  }

  async function runBatchQueue(batch, requestUrl) {
    let nextIdx = 0;
    let runningCount = 0;

    async function launchNext() {
      if (batch._cancelled) return;
      if (nextIdx >= batch.items.length) {
        if (runningCount === 0) {
          batch.status = batch._cancelled ? 'cancelled' : 'completed';
          batch.endedAt = Date.now();
          console.log(`[login] 批量登录任务 ${batch.id} 全部完成 (总数: ${batch.total})`);
        }
        return;
      }

      const item = batch.items[nextIdx++];
      item.state = 'starting';
      item.startedAt = Date.now();
      item.message = '正在调起独立浏览器…';
      runningCount++;

      const id = randomBytes(5).toString('hex');
      item.flowId = id;
      const base = requestUrl || baseUrl;
      const f = {
        id,
        state: 'starting',
        message: `正在使用 ${item.email} 启动全自动登录…`,
        link: `${base}/login/${id}`,
        startedAt: Date.now(),
        expiresAt: Date.now() + timeoutMs,
        browser: '',
        account: null,
        ua: DEFAULT_UA,
        autoEmail: item.email,
        autoLogin: true,
        _batchItem: item,
      };
      flows.set(id, f);

      const syncTimer = setInterval(() => {
        if (f.state !== 'starting') item.state = f.state;
        if (f.message) item.message = f.message;
        if (f.account) item.account = f.account;
        if (!LIVE.has(f.state) || batch._cancelled) {
          clearInterval(syncTimer);
        }
      }, 500);

      try {
        await run(f);
      } catch (err) {
        item.state = 'error';
        item.error = err.message || String(err);
        item.message = `失败: ${item.error}`;
      } finally {
        clearInterval(syncTimer);
        item.state = f.state;
        item.message = f.message;
        item.account = f.account;
        item.endedAt = Date.now();
        runningCount--;

        if (!batch._cancelled) {
          await sleep(1000);
          launchNext();
        }
      }
    }

    const initN = Math.min(batch.concurrency, batch.items.length);
    for (let i = 0; i < initN; i++) {
      launchNext();
    }
  }

  return {
    /** 发起一次登录；若已有进行中的流程，复用它（幂等，避免开出多个窗口） */
    start(requestUrl, opts = {}) {
      const email = typeof opts === 'string' ? opts : (opts?.email || '');
      const autoLogin = !!opts?.autoLogin || !!email;
      const force = !!opts?.force;
      if (active) {
        const isDeadProc = active.proc && (active.proc.exitCode !== null || active.proc.killed);
        const isExpired = Date.now() >= active.expiresAt;
        const notLive = !LIVE.has(active.state);
        const emailChanged = email && active.autoEmail && email.toLowerCase() !== active.autoEmail.toLowerCase();
        if (force || isDeadProc || isExpired || notLive || emailChanged) {
          console.log(`[login] 清理已失效或被覆盖的历史流程: ${active.id} (force=${force}, deadProc=${isDeadProc}, notLive=${notLive}, expired=${isExpired}, emailChanged=${emailChanged})`);
          cleanup(active);
          active = null;
        }
      }
      if (active && LIVE.has(active.state) && Date.now() < active.expiresAt) {
        return { ...stateOf(active), reused: true };
      }
      const id = randomBytes(5).toString('hex');
      const base = requestUrl || baseUrl;
      const f = {
        id, state: 'starting', message: email ? `正在使用 ${email} 启动全自动登录…` : '正在启动登录浏览器…',
        link: `${base}/login/${id}`,
        startedAt: Date.now(),
        expiresAt: Date.now() + timeoutMs,
        browser: '', account: null, ua: DEFAULT_UA,
        autoEmail: email ? String(email).trim() : '',
        autoLogin,
      };
      flows.set(id, f);
      active = f;
      // 保留最近 20 个流程供状态查询
      if (flows.size > 20) {
        const oldest = [...flows.keys()].find(k => flows.get(k) !== active);
        if (oldest) flows.delete(oldest);
      }
      run(f).catch(e => {
        if (f.state !== 'cancelled' && f.state !== 'closed') { f.state = 'error'; f.message = e.message || String(e); }
        cleanup(f);
      });
      return { ...stateOf(f), reused: false };
    },

    get(id) { return flows.get(id) || null; },
    state(id) { const f = flows.get(id); return f ? stateOf(f) : null; },

    cancel(id) {
      const f = flows.get(id);
      if (!f) return null;
      if (LIVE.has(f.state) || f.state === 'closed') {
        f.state = 'cancelled';
        f.message = '已取消，登录浏览器已关闭';
      }
      cleanup(f);
      return stateOf(f);
    },

    /** 在新标签重新打开 claude.ai 登录页（用户关掉窗口时用） */
    async reopen(id) {
      const f = flows.get(id);
      if (!f || !LIVE.has(f.state)) return false;
      if (!f.cdp) return false;
      try {
        await f.cdp.call('Target.createTarget', { url: loginUrl });
        f.message = '已重新打开登录页，请在浏览器窗口中完成登录';
        return true;
      } catch { return false; }
    },

    /**
     * 把用户粘贴的「邮件登录链接」跳转进受控登录窗口（受控环境里完成魔法链接换 sessionKey）。
     * 只允许 claude.ai 主机的 http(s) 链接——防止把任意 URL 塞进本机浏览器。
     */
    async goto(id, rawUrl) {
      const f = flows.get(id);
      if (!f || !LIVE.has(f.state)) return { ok: false, message: '登录流程不存在或已结束' };
      let u;
      try { u = new URL(String(rawUrl || '').trim()); } catch {
        return { ok: false, message: '链接格式不正确，请粘贴邮件里完整的登录链接' };
      }
      if (!/^https?:$/.test(u.protocol) || !/(\.|^)claude\.ai$/i.test(u.hostname)) {
        return { ok: false, message: '只接受 claude.ai 的登录链接（其他链接不会被打开）' };
      }
      try {
        const cdp = await ensurePageCdp(f);
        await cdp.call('Page.navigate', { url: u.href });
        f.message = '已打开邮件登录链接，正在自动捕获登录态…';
        console.log(`[login] ${f.id} 跳转粘贴的魔法链接：${u.origin}${u.pathname}`);
        return { ok: true, message: f.message };
      } catch (e) {
        return { ok: false, message: '跳转失败：' + (e.message || String(e)) };
      }
    },

    /** 多邮箱并发批量登录 */
    startBatch(emails, concurrency, requestUrl) {
      return startBatch(emails, concurrency, requestUrl);
    },
    batchStatus() {
      return batchStatus();
    },
    cancelBatch() {
      return cancelBatch();
    },
  };
}

/** 登录状态页（免鉴权，本机回环）—— 用户可以把这个链接复制到任何浏览器打开 */
export function loginPage(id) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>链接登录 · Claude 反代</title>
<style>
 body{font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1f2328;margin:0;padding:40px 16px}
 .card{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,.05)}
 h1{font-size:20px;margin:0 0 6px} .sub{color:#6b7280;font-size:13px;margin-bottom:22px}
 .st{padding:16px;border-radius:10px;background:#f1f5ff;border:1px solid #d8e4ff;margin-bottom:18px;min-height:48px;transition:background .3s,border-color .3s}
 .st.done{background:#eafaef;border-color:#b7e4c7} .st.error,.st.timeout,.st.cancelled{background:#fff2f0;border-color:#ffccc7}
 .st.verify{background:#fffbe6;border-color:#ffe58f;animation:vp 1.6s infinite}
 @keyframes vp{50%{border-color:#faad14}}
 .mlink{display:none;gap:8px;margin:-8px 0 18px}
 .mlink.on{display:flex}
 .mlink input{flex:1;min-width:0;padding:9px 11px;border:1px solid #d0d7de;border-radius:8px;font:inherit;font-size:13px}
 .mlink .tip{font-size:12px;color:#92400e;flex-basis:100%;line-height:1.6}
 .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3b82f6;margin-right:8px;animation:p 1s infinite}
 @keyframes p{50%{opacity:.25}}
 b{font-size:14px} .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
 button,.btn{font:inherit;border:1px solid #d0d7de;background:#fff;border-radius:8px;padding:9px 16px;cursor:pointer;color:#24292f;text-decoration:none}
 .primary{background:#24292f;color:#fff;border-color:#24292f} button:disabled{opacity:.5;cursor:not-allowed}
 .hint{color:#6b7280;font-size:12.5px;margin-top:18px;line-height:1.7}
 code{background:#f3f4f6;padding:2px 5px;border-radius:4px;font-size:12px}
</style></head><body><div class="card">
<h1>🔗 链接登录</h1>
<div class="sub">登录窗口已在桌面浏览器打开；本页实时显示进度</div>
<div class="st" id="st"><span class="dot"></span><b id="msg">正在连接…</b></div>
<div class="mlink" id="mlinkRow">
  <input id="mlink" placeholder="粘贴邮件里的登录链接（https://claude.ai/…）" autocomplete="off">
  <button id="mlinkGo">打开并捕获</button>
  <div class="tip">📮 需要查收登录邮件时，可把邮件里的登录链接粘贴到这里 —— 会在登录窗口里打开并自动完成捕获，无需手动复制 Cookie。</div>
</div>
<div class="row">
  <button class="primary" id="reopen">重新打开登录窗口</button>
  <a class="btn" href="/ui">返回管理控制台</a>
</div>
<div class="hint">在浏览器里登录 <code>claude.ai</code> 后会自动捕获 <code>sessionKey</code>、
<code>cf_clearance</code> 与浏览器 UA 并写入账号池，<b>不需要手动复制任何 Cookie</b>。<br>
登录成功后可关闭本页；凭据仅保存在本机 <code>accounts.json</code>。</div>
</div><script>
const id=${JSON.stringify(id)};
let busy=false,verifying=false,blinkTimer=null;
const TERMINAL=['done','error','timeout','cancelled','closed'];
function setTitleVerify(on){
  if(on&&!blinkTimer){let t=false;blinkTimer=setInterval(()=>{t=!t;document.title=(t?'⚠️ 需要验证 · ':'')+'链接登录 · Claude 反代';},1000);}
  if(!on&&blinkTimer){clearInterval(blinkTimer);blinkTimer=null;document.title='链接登录 · Claude 反代';}
}
async function tick(){
  try{
    const r=await fetch('/login/'+id+'/state');const j=await r.json();
    if(!j){document.getElementById('msg').textContent='登录流程不存在或已过期';return;}
    const done=TERMINAL.includes(j.state);
    const st=document.getElementById('st');
    let cls='st'+(done?' '+j.state:(j.need_verify?' verify':''));
    st.className=cls;
    const esc=s=>String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    document.getElementById('msg').innerHTML=(done&&j.state==='done'?'✅ ':done?'⚠️ ':j.need_verify?'⚠️ ':'<span class="dot"></span>')+esc(j.message||j.state);
    if(j.state==='done'&&j.account){document.getElementById('msg').innerHTML+='<br>账号：<b>'+esc(j.account.label||'')+'</b>';}
    // 验证阶段：常驻粘贴链接入口 + 标题闪烁，让用户在别的标签页也能看到
    const showPaste=!done&&(j.need_verify||j.verify==='email_link'||j.verify==='email_code');
    document.getElementById('mlinkRow').className='mlink'+(showPaste?' on':'');
    if(!done)setTitleVerify(!!j.need_verify);
    verifying=!!j.need_verify;
    if(!done)setTimeout(tick,1500);
  }catch(e){document.getElementById('msg').textContent='状态获取失败：'+e.message;setTimeout(tick,2500);}
}
document.getElementById('reopen').onclick=async e=>{
  if(busy)return;busy=true;e.target.disabled=true;
  try{const r=await fetch('/login/'+id+'/open',{method:'POST'});const j=await r.json();
    if(!j.ok)alert(j.message||'无法重新打开，请回控制台重新发起登录');}catch(err){alert(err.message)}
  busy=false;e.target.disabled=false;
};
document.getElementById('mlinkGo').onclick=async e=>{
  const inp=document.getElementById('mlink');
  const url=inp.value.trim();
  if(!url){inp.focus();return;}
  if(busy)return;busy=true;e.target.disabled=true;
  try{
    const r=await fetch('/login/'+id+'/goto',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})});
    const j=await r.json();
    if(j.ok){inp.value='';}
    else{alert(j.message||'跳转失败');}
  }catch(err){alert(err.message)}
  busy=false;e.target.disabled=false;
};
document.getElementById('mlink').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('mlinkGo').click();});
tick();
</script></body></html>`;
}

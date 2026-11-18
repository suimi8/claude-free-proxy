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
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export function getDefaultBrowserWindows() {
  if (process.platform !== 'win32') return null;
  try {
    const raw = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
    });
    const progMatch = raw.match(/ProgId\s+REG_SZ\s+(\S+)/);
    if (!progMatch) return null;
    const progId = progMatch[1];
    const cmdRaw = execSync(`reg query "HKCR\\${progId}\\shell\\open\\command" /ve`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
    });
    const cmdMatch = cmdRaw.match(/REG_SZ\s+(.+)/);
    if (!cmdMatch) return null;
    const str = cmdMatch[1].trim();
    const exeMatch = str.match(/^"([^"]+)"/) || str.match(/^(\S+)/);
    const exe = exeMatch ? exeMatch[1] : null;
    if (exe && fs.existsSync(exe)) return exe;
  } catch {}
  return null;
}

export function activateBrowserWindow(pid) {
  if (process.platform !== 'win32') return;
  const ps = `
    $names = @('chrome', 'msedge', 'brave', 'chromium')
    $procs = Get-Process $names -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
    if ($procs) {
      $sig = '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'
      $type = Add-Type -MemberDefinition $sig -Name NativeAct -Namespace Win32 -PassThru -ErrorAction SilentlyContinue
      foreach ($p in $procs) {
        [Native.NativeAct]::ShowWindowAsync($p.MainWindowHandle, 9)
        [Native.NativeAct]::SetForegroundWindow($p.MainWindowHandle)
      }
    }
  `;
  try {
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch {}
}

export function findBrowser(opts = {}) {
  const preferDefault = typeof opts === 'boolean' ? opts : !!opts?.preferDefault;
  if (process.env.LOGIN_BROWSER && fs.existsSync(process.env.LOGIN_BROWSER)) {
    return process.env.LOGIN_BROWSER;
  }

  // 1. Linux 平台（虚拟机环境优先使用自带的 Chromium，不优先使用 Google Chrome）
  if (process.platform === 'linux') {
    const linuxPaths = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/lib/chromium/chromium',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
    ];
    for (const p of linuxPaths) {
      try { if (fs.existsSync(p)) return p; } catch {}
    }
    try {
      const found = execSync('which chromium chromium-browser microsoft-edge edge google-chrome 2>/dev/null', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      if (found && fs.existsSync(found)) return found;
    } catch {}
    throw new Error('找不到系统自带的 Chromium 浏览器，可用 LOGIN_BROWSER 环境变量指定浏览器路径');
  }

  // 2. macOS 平台
  if (process.platform === 'darwin') {
    const macPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    for (const p of macPaths) {
      try { if (fs.existsSync(p)) return p; } catch {}
    }
    throw new Error('找不到 Chrome/Edge，可用 LOGIN_BROWSER 环境变量指定浏览器路径');
  }

  // 3. Windows 平台
  const defaultBrowser = getDefaultBrowserWindows();

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];

  // 如果优先系统默认浏览器且默认浏览器存在且为 Chromium 系
  if (preferDefault && defaultBrowser && /chrome|edge|brave|chromium|vivaldi|360/i.test(defaultBrowser)) {
    return defaultBrowser;
  }

  // 优先检测 Chrome
  for (const p of chromePaths) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }

  // 如果没有独立 Chrome，优先回退到系统默认浏览器（如 Edge、Brave 等）
  if (defaultBrowser && /chrome|edge|brave|chromium|vivaldi|360/i.test(defaultBrowser)) {
    return defaultBrowser;
  }

  // 再次回退到系统常见 Edge 路径
  for (const p of edgePaths) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }

  if (defaultBrowser) return defaultBrowser;

  throw new Error('找不到可用的浏览器（Chrome/Edge/默认浏览器），可用 LOGIN_BROWSER 环境变量指定浏览器 exe 路径');
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
  if (process.platform === 'win32') {
    const ps = `$TargetPid = ${pid || 0}; Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class Win32Focus {[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);}' -ErrorAction SilentlyContinue; $d = (Get-Date).AddSeconds(12); while ((Get-Date) -lt $d) { $p = $null; if ($TargetPid -gt 0) { $p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; }; if (-not $p) { $p = Get-Process -Name chrome, msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -Last 1; }; if ($p) { [Win32Focus]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [Win32Focus]::BringWindowToTop($p.MainWindowHandle) | Out-Null; [Win32Focus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; exit 0; }; Start-Sleep -Milliseconds 400; }; exit 1;`;
    try {
      const b64 = Buffer.from(ps, 'utf16le').toString('base64');
      spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {}
  } else if (process.platform === 'linux') {
    try {
      const targetPid = pid ? Number(pid) : 0;
      const shCmd = targetPid > 0
        ? `wids=$(xdotool search --all --pid ${targetPid} 2>/dev/null); for w in $wids; do xdotool windowactivate --sync "$w" 2>/dev/null; xdotool windowraise "$w" 2>/dev/null; done; xdotool search --onlyvisible --class chromium windowactivate 2>/dev/null || true`
        : `xdotool search --onlyvisible --class chromium windowactivate 2>/dev/null || true`;
      spawn('sh', ['-c', shCmd], { stdio: 'ignore', env: process.env });
    } catch {}
  }
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

/** 检测是否处于 Claude Cage 虚拟机原生环境 */
export function isCageBrowserAvailable() {
  if (process.platform !== 'linux') return false;
  try {
    return fs.existsSync('/etc/claude-cage/browser-control.json');
  } catch {
    return false;
  }
}

function getCageControlConfig() {
  try {
    return JSON.parse(fs.readFileSync('/etc/claude-cage/browser-control.json', 'utf8'));
  } catch {
    return null;
  }
}

async function cageApi(endpoint, data = null) {
  const cfg = getCageControlConfig();
  if (!cfg?.token) throw new Error('Cage 控制凭据不可用');
  const body = data ? JSON.stringify(data) : null;
  const res = await fetch(`http://127.0.0.1:18500${endpoint}`, {
    method: data ? 'POST' : 'GET',
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body || undefined,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Cage API ${endpoint} 失败: ${res.status} ${errText}`);
  }
  return await res.json();
}

/** 包装 Cage 原生浏览器 Tab 为标准 CDP 对象，全套 DOM 自动化、跳转与凭据捕获直接兼容复用 */
class CageCdp {
  constructor(tabId) {
    this.tabId = tabId;
    this.ws = { readyState: 1 };
  }
  async call(method, params = {}) {
    if (method === 'Page.navigate') {
      await cageApi('/navigate', { id: this.tabId, url: params.url });
      return {};
    }
    if (method === 'Page.reload') {
      await cageApi('/reload', { id: this.tabId });
      return {};
    }
    if (method === 'Page.bringToFront') {
      await cageApi('/activate', { id: this.tabId });
      return {};
    }
    if (method === 'Input.insertText') {
      await cageApi('/insert-text', { id: this.tabId, text: params.text });
      return {};
    }
    if (method === 'Input.dispatchKeyEvent') {
      if (params.key === 'Enter' || params.code === 'Enter') {
        try { execSync('env DISPLAY=:77 xdotool key Return', { stdio: 'ignore' }); } catch {}
      }
      return {};
    }
    if (method === 'Input.dispatchMouseEvent') {
      return {};
    }
    if (method === 'Runtime.evaluate') {
      return { result: { value: null } };
    }
    if (method === 'Storage.getCookies' || method === 'Network.getCookies' || method === 'Network.getAllCookies') {
      const list = await cageApi('/cookies', { id: this.tabId, mode: 'list', scope: 'site' }).catch(() => null);
      if (!list?.cookies) return { cookies: [] };
      const cookies = [];
      for (const c of list.cookies) {
        if (c.name === 'sessionKey' || c.name === 'cf_clearance' || c.name === 'lastActiveOrg' || c.name === '__cf_bm' || c.name === '_cfuvid') {
          try {
            const detail = await cageApi('/cookies', { id: this.tabId, mode: 'details', cookieKey: c.key });
            cookies.push({ ...c, value: detail?.value || '' });
          } catch {
            cookies.push({ ...c, value: '' });
          }
        } else {
          cookies.push(c);
        }
      }
      return { cookies };
    }
    return {};
  }
  close() {}
}

/** 取回 claude.ai 域下的全部 cookie（含 HttpOnly） */
async function readCookies(flow) {
  if (flow.isCage && flow.tabId) {
    const list = await cageApi('/cookies', { id: flow.tabId, mode: 'list', scope: 'site' }).catch(() => null);
    if (!list?.cookies) return [];
    return await Promise.all(list.cookies.map(async c => {
      if (c.value) return c;
      if (!c.key) return c;
      try {
        const detail = await cageApi('/cookies', { id: flow.tabId, mode: 'details', cookieKey: c.key });
        return { ...c, value: detail?.value || '' };
      } catch {
        return { ...c, value: '' };
      }
    }));
  }
  // 1) 页面级 Network.getCookies（限定 claude.ai）——无痕窗口的独立内存 jar
  //    只有页面级会话能看到，浏览器级读的是默认 jar（恒空）
  try {
    if (flow.pageCdp && flow.pageCdp.ws.readyState === 1) {
      const r = await flow.pageCdp.call('Network.getCookies', { urls: ['https://claude.ai/'] });
      if (Array.isArray(r?.cookies) && r.cookies.length) return r.cookies;
    }
  } catch { /* 断线走下面兜底 */ }

  // 2) 浏览器级 Storage.getCookies（Chrome/Edge 100+，非无痕模式兜底）
  try {
    const r = await flow.cdp.call('Storage.getCookies');
    if (Array.isArray(r?.cookies)) return r.cookies;
  } catch { /* 老版本回退到页面 target */ }

  // 3) 页面级 Network.getAllCookies
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
async function ensurePageCdp(flow, loginUrl = 'https://claude.ai/login') {
  if (flow.isCage && flow.pageCdp) return flow.pageCdp;
  if (flow.pageCdp && flow.pageCdp.ws.readyState === 1) return flow.pageCdp;
  let page = null;
  // 多次轮询探测可用 page target
  for (let i = 0; i < 6; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${flow.port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      })).json();
      page = list.find(t => t.type === 'page' && /claude\.ai/.test(t.url))
        || list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) break;
    } catch {}

    // 如果没有 page target（如 Linux Chromium 冷启动时默认未创建），显式触发 /json/new
    if (!page) {
      try {
        const created = await (await fetch(`http://127.0.0.1:${flow.port}/json/new`, {
          method: 'PUT',
          signal: AbortSignal.timeout(2000),
        })).json();
        if (created?.webSocketDebuggerUrl && (created.type === 'page' || !created.type)) {
          page = created;
          break;
        }
      } catch {}
    }
    await sleep(400);
  }

  if (!page?.webSocketDebuggerUrl) throw new Error('找不到浏览器页面 target');
  flow.pageCdp = await CDP.connect(page.webSocketDebuggerUrl);

  // 必须显式激活并导航到登录页，确保 0 秒直达，不卡在 about:blank
  try {
    await flow.pageCdp.call('Page.enable');
    await flow.pageCdp.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}`,
    }).catch(() => {});
    await flow.pageCdp.call('Runtime.evaluate', {
      expression: `try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}`,
    }).catch(() => {});
    const u = String(page.url || '');
    if (!u || u === 'about:blank' || !/claude\.ai/i.test(u)) {
      await flow.pageCdp.call('Page.navigate', { url: loginUrl });
    }
  } catch {}

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
  if (document.querySelector('div#challenge-stage, div#turnstile-wrapper, div[class*="cf-turnstile"], div#cf-turnstile, [data-turnstile]')) return 'cloudflare';
  const title = String(document.title || '').toLowerCase();
  if (/just a moment|少しお待ちください|安全を確認|请稍候|checking your browser|attention required/i.test(title)) return 'cloudflare';
  if (frames.some(f => src(f).indexOf('recaptcha') >= 0)) return 'recaptcha';
  const bodyText = (document.body ? document.body.innerText : '') || '';
  if (/无法验证您的浏览器|Unable to verify your browser|ブラウザを確認できませんでした|確認できません/i.test(bodyText)) return 'browser_not_verified';
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

/** 自动处理新账号欢迎引导 (Onboarding / 姓名 / 18岁勾选 / Continue) */
const ONBOARDING_EXPR = `(() => {
  try {
    // 只有在明确处于 onboarding 路径，或者页面存在欢迎引导专属特征时才执行！
    const path = window.location.pathname || '';
    const bodyText = (document.body ? document.body.innerText : '') || '';
    const isOnboarding = path.includes('onboarding') || /what should we call you|how should claude call you|お名前|お呼びすれば|18歳以上/i.test(bodyText);
    if (!isOnboarding) return false;

    let acted = false;
    // 1. 查找姓名输入框
    const nameInp = document.querySelector('input[name*="name" i], input[data-testid*="name" i], input[placeholder*="name" i], input[placeholder*="お名前" i], input[placeholder*="名前" i], input[placeholder*="名字" i]');
    if (nameInp && !nameInp.value) {
      const defName = 'User_' + Math.random().toString(36).slice(2, 6);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(nameInp, defName);
      else nameInp.value = defName;
      nameInp.dispatchEvent(new Event('input', { bubbles: true }));
      nameInp.dispatchEvent(new Event('change', { bubbles: true }));
      acted = true;
    }

    // 2. 查找 18 岁 / 条款确认勾选框
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    for (const cb of checkboxes) {
      if (!cb.checked) {
        cb.click();
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        acted = true;
      }
    }

    // 3. 查找 Continue / 同意 / 続行 / Acknowledge / Next 按钮（严禁点击 Google / Apple 登录按钮！）
    const btns = Array.from(document.querySelectorAll('button'));
    const contBtn = btns.find(b => {
      if (b.disabled) return false;
      const t = (b.innerText || b.textContent || '').trim().toLowerCase();
      if (/google|apple/i.test(t)) return false;
      return /continue|get started|続行|同意|次へ|acknowledge|agree/i.test(t);
    });
    if (contBtn) {
      contBtn.click();
      acted = true;
    }
    return acted;
  } catch (e) {
    return false;
  }
})()`;

/** 检测页面是否命中致命阻断（账号封禁、禁用、无法完成登录），命中时立即拉黑销毁邮箱并切换下一个 */
const BANNED_OR_BLOCKED_EXPR = `(() => {
  try {
    const text = (document.body ? document.body.innerText : '') || '';
    // 1. 账号已被官方禁用 / 停用 / 封禁 (アカウントが無効化されています / Your account has been disabled)
    if (/アカウントが無効化|アカウントが停止|アカウント停止|無効化されました/i.test(text)) {
      return { matched: true, reason: 'account_disabled', label: '账号已被官方禁用 (アカウントが無効化されています)' };
    }
    if (/account.*has been disabled|account.*disabled|account.*suspended/i.test(text)) {
      return { matched: true, reason: 'account_disabled', label: '账号已被官方禁用 (Account has been disabled)' };
    }
    if (/账号已被禁用|账户已被禁用|账号已被停用|账户已被停用/i.test(text)) {
      return { matched: true, reason: 'account_disabled', label: '账号已被官方禁用' };
    }
    if (document.querySelector('a[href*="8241253-trust-and-safety-warnings-and-appeals"]')) {
      return { matched: true, reason: 'account_disabled', label: '账号已被官方禁用 (Trust & Safety Appeals)' };
    }

    // 2. 登录受阻 / 无法完成登录 (サインインを完了できませんでした / Unable to complete sign in)
    if (/サインインを完了できませんでした|別のブラウザからサインインをお試し/i.test(text)) {
      return { matched: true, reason: 'signin_failed', label: '登录受阻（サインインを完了できませんでした）' };
    }
    if (/unable to complete sign in|could not complete sign in|try signing in from a different browser|try signing in from another browser/i.test(text)) {
      return { matched: true, reason: 'signin_failed', label: '登录受阻（Unable to complete sign in）' };
    }
    if (/无法完成登录|请尝试从其他浏览器登录/i.test(text)) {
      return { matched: true, reason: 'signin_failed', label: '登录受阻（无法完成登录）' };
    }
    if (document.querySelector('a[href*="9015913-how-to-get-support"]')) {
      return { matched: true, reason: 'signin_failed', label: '登录受阻（无法完成登录）' };
    }

    return { matched: false };
  } catch (e) {
    return { matched: false };
  }
})()`;

const VERIFY_LABEL = {
  browser_not_verified: '浏览器环境验证未通过',
  hcaptcha: 'hCaptcha 人机验证',
  cloudflare: 'Cloudflare 安全检查',
  recaptcha: 'reCAPTCHA 人机验证',
  email_code: '邮箱验证码',
  email_link: '邮件登录链接',
};

const VERIFY_HINT = {
  browser_not_verified: '⚠️ 页面提示「无法验证您的浏览器」：正在自动尝试重新提交；您也可以在弹出的浏览器窗口中直接点击「使用电子邮箱继续」或刷新重试。',
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
  // 注意：若已经收到并跳转 magicLink 或收到 emailCode，不应再标记为 email_link 阻碍交互验证判断
  if (!f.magicLink && !f.emailCode && cookies?.some(c => c.name === 'pendingLogin' && c.value && c.value !== 'false')) {
    return 'email_link';
  }
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
/* 临时 Chrome profile 登记表：在跑的流程占用中，启动清扫时跳过防止误删 */
const PROFILES_IN_USE = new Set();

/**
 * 清扫上次异常退出（崩溃/强杀/断电）遗留的临时 Chrome profile。
 * 非无痕时期的 profile 里落盘过 sessionKey / cf_clearance，属于凭据残留，必须删；
 * 正常流程的 cleanup 会删自己的（含 800ms 延迟兜底），这里只兜底收尸体。
 * 在管理器创建（代理启动）时调用 —— 此时本进程还没有任何在跑的流程。
 */
function sweepStaleProfiles() {
  let entries;
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    // 本仓库两类临时 Chrome profile + 早期手工测试目录；前缀匹配（后缀是随机 flow id/时间戳）
    if (!/^(?:claude-cf-verify-|claude-free-login-|claude-free-har-|cfv-manual-test)/.test(ent.name)) continue;
    const full = path.join(os.tmpdir(), ent.name);
    if (PROFILES_IN_USE.has(full)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      console.log(`[profile-sweep] 已清理遗留临时目录 ${ent.name}`);
    } catch { /* 可能被残留 Chrome 进程占用，下次启动再清 */ }
  }
}

export function createLoginManager(opts) {
  const {
    onCapture,
    baseUrl = 'http://127.0.0.1:8787',
    webBase = 'https://claude.ai',
    timeoutMs = 5 * 60 * 1000,
    loginUrl = 'https://claude.ai/login',
  } = opts;

  // 启动即清扫上次异常退出遗留的临时 Chrome profile（可能含落盘凭据）
  sweepStaleProfiles();

  let verificationProvider = typeof opts.onAutoVerification === 'function' ? opts.onAutoVerification : null;
  let accountBannedHandler = typeof opts.onAccountBanned === 'function' ? opts.onAccountBanned : null;

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
      magicLink: f.magicLink || null,
      emailCode: f.emailCode || null,
    };
  }

  /* ---------------- 全局人机验证互斥锁 (防并发窗口抢占) ---------------- */
  // 当批量并发登录中有某个账号遇到 hCaptcha / Cloudflare / 人机验证时，独占前台焦点与用户操作界面。
  // 其他并发账号检测到验证或尝试提交时自动排队等待，绝不抢占前台或弹出打扰用户，待正在验证的账号完成后依次唤醒。
  const VERIFY_LOCK = {
    holderId: null,
    holderEmail: '',
    kind: null,
    acquiredAt: 0,
  };
  const VERIFY_QUEUE = [];

  function isInteractiveVerify(kind) {
    return kind === 'hcaptcha' || kind === 'recaptcha' || kind === 'cloudflare' || kind === 'browser_not_verified';
  }

  function tryAcquireVerifyLock(flow, kind) {
    if (!VERIFY_LOCK.holderId || VERIFY_LOCK.holderId === flow.id) {
      VERIFY_LOCK.holderId = flow.id;
      VERIFY_LOCK.holderEmail = flow.autoEmail || flow.id;
      VERIFY_LOCK.kind = kind;
      VERIFY_LOCK.acquiredAt = Date.now();
      const qIdx = VERIFY_QUEUE.findIndex(x => x.id === flow.id);
      if (qIdx !== -1) VERIFY_QUEUE.splice(qIdx, 1);
      return true;
    }
    if (!VERIFY_QUEUE.some(x => x.id === flow.id)) {
      VERIFY_QUEUE.push(flow);
    }
    return false;
  }

  async function releaseVerifyLock(flow) {
    const qIdx = VERIFY_QUEUE.findIndex(x => x && x.id === flow.id);
    if (qIdx !== -1) VERIFY_QUEUE.splice(qIdx, 1);

    if (VERIFY_LOCK.holderId !== flow.id) return;

    console.log(`[login] ${flow.id} (${flow.autoEmail || ''}) 释放人机验证互斥锁`);
    VERIFY_LOCK.holderId = null;
    VERIFY_LOCK.holderEmail = '';
    VERIFY_LOCK.kind = null;
    VERIFY_LOCK.acquiredAt = 0;

    // 唤醒下一个在队列中等待的 flow
    while (VERIFY_QUEUE.length > 0) {
      const nextFlow = VERIFY_QUEUE.shift();
      if (nextFlow && LIVE.has(nextFlow.state)) {
        VERIFY_LOCK.holderId = nextFlow.id;
        VERIFY_LOCK.holderEmail = nextFlow.autoEmail || nextFlow.id;
        VERIFY_LOCK.kind = nextFlow.verify || 'verify';
        VERIFY_LOCK.acquiredAt = Date.now();
        nextFlow._verifyFocused = true;
        console.log(`[login] 人机验证互斥锁移交给排队账号: ${nextFlow.id} (${nextFlow.autoEmail || ''})`);

        try {
          const cdp = await ensurePageCdp(nextFlow);
          await cdp.call('Page.bringToFront');
          focusBrowserWindow(nextFlow.proc?.pid);
        } catch {}

        const k = nextFlow.verify;
        nextFlow.message = VERIFY_HINT[k] || `需要人工验证（${VERIFY_LABEL[k] || k}），请在当前窗口完成`;
        break;
      }
    }
  }

  /* Cage 虚拟机独占输入锁：防止多账号并发时在同一个 X11 屏幕互相抢焦点打架 */
  let cageInputQueue = Promise.resolve();
  function acquireCageInputLock() {
    let release;
    const p = new Promise(resolve => { release = resolve; });
    const cur = cageInputQueue;
    cageInputQueue = cur.then(() => p);
    return cur.then(() => release);
  }

  async function submitEmailToClaude(flow, email) {
    if (flow.isCage) {
      console.log(`[login] ${flow.id} [Cage] 等待输入锁以填入邮箱: ${email}`);
      const release = await acquireCageInputLock();
      try {
        console.log(`[login] ${flow.id} [Cage] 正在激活标签页 ${flow.tabId} 并填入邮箱: ${email}`);
        await cageApi('/activate', { id: flow.tabId }).catch(() => {});
        
        // 激活 Chromium 顶层窗口
        try {
          const winList = execSync('DISPLAY=:77 xdotool search --class Chromium 2>/dev/null', { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
          const winId = winList.pop();
          if (winId) execSync(`DISPLAY=:77 xdotool windowactivate ${winId}`, { stdio: 'ignore' });
        } catch {}

        // 首个或无痕标签页冷启动渲染耗时较长（等待 React 组件和输入框完全挂载，避开白屏/加载圆环状态）
        await sleep(4000);

        // 精准聚焦邮箱输入框 (x=413, y=709，对应 1614x994 全屏视口居中输入框)
        execSync('DISPLAY=:77 xdotool mousemove 413 709 click 1', { stdio: 'ignore' });
        await sleep(200);

        // 关闭可能弹出的浏览器历史邮箱推荐悬浮窗
        execSync('DISPLAY=:77 xdotool key Escape', { stdio: 'ignore' });
        await sleep(100);

        // 全选清空输入框，防止残留字符
        execSync('DISPLAY=:77 xdotool key ctrl+a BackSpace', { stdio: 'ignore' });
        await sleep(150);

        // 键入邮箱文本
        execSync(`DISPLAY=:77 xdotool type --delay 25 ${JSON.stringify(email)}`, { stdio: 'ignore' });
        await sleep(400);

        // 表单内直接按回车提交
        execSync('DISPLAY=:77 xdotool key Return', { stdio: 'ignore' });
        await sleep(350);

        // 双重保险：精准点击「メールで続ける」按钮 (x=413, y=797)
        execSync('DISPLAY=:77 xdotool mousemove 413 797 mousedown 1 sleep 0.1 mouseup 1', { stdio: 'ignore' });
        console.log(`[login] ${flow.id} [Cage] 已在 Cage 窗口内精准填入邮箱并提交`);
        await sleep(800);
        return true;
      } catch (err) {
        console.warn(`[login] ${flow.id} [Cage] 填入提交异常: ${err.message}`);
        return false;
      } finally {
        release();
      }
    }

    const cdp = await ensurePageCdp(flow);
    const start = Date.now();
    let retryCount = 0;
    const maxRetries = 5;

    while (Date.now() - start < 90000) {
      if (!LIVE.has(flow.state)) return false;

      // 如果当前已有其它并发账号正在经历人机验证码，暂停提交，绝不抢占前台或并发触发多重验证码
      while (VERIFY_LOCK.holderId && VERIFY_LOCK.holderId !== flow.id && LIVE.has(flow.state)) {
        const holder = VERIFY_LOCK.holderEmail ? `「${VERIFY_LOCK.holderEmail}」` : '前一个账号';
        flow.message = `⏳ 等待 ${holder} 完成验证码后再继续…`;
        await sleep(1500);
      }
      try {
        // 1. 检查页面是否已进入验证码输入页 (code_view)
        const checkCode = await cdp.call('Runtime.evaluate', {
          expression: `(() => {
            const codeInput = document.querySelector('input#code, input[data-testid="code"], input[name*="code" i], cds-text-input input[name*="code" i]');
            return !!codeInput;
          })()`,
          returnByValue: true,
        }).catch(() => null);
        if (checkCode?.result?.value) return true;

        // 2. 查找邮箱输入框与登录按钮位置及状态
        const findRes = await cdp.call('Runtime.evaluate', {
          expression: `(() => {
            // 自动关闭 Cookie 提示
            const consent = document.querySelector('[data-testid="consent-accept"]');
            if (consent && consent.offsetWidth && consent.offsetHeight) consent.click();

            // 查找 input (精确匹配用户提供的 input: <input id="email" data-testid="email" type="email" autocomplete="email" dir="ltr" aria-label="メール" placeholder="メールアドレスを入力" required="">)
            let input = document.querySelector('input[data-testid="email"]')
              || document.querySelector('input#email')
              || document.querySelector('input[placeholder="メールアドレスを入力"]')
              || document.querySelector('input[aria-label="メール"]')
              || document.querySelector('input[autocomplete="email"]')
              || document.querySelector('cds-text-input input')
              || document.querySelector('input[type="email"]')
              || Array.from(document.querySelectorAll('input')).find(i => /email|mail|メール/i.test([i.placeholder, i.name, i.id, i.getAttribute('aria-label')].join(' ')));

            if (!input) {
              const cds = document.querySelector('cds-text-input');
              if (cds && cds.shadowRoot) input = cds.shadowRoot.querySelector('input');
            }

            if (!input) return { status: 'no_input' };

            // 查找 continue 按钮 (精确匹配用户提供的 button: <button type="submit" data-testid="continue" aria-describedby="si-legal-line" data-cds="Button" data-variant="primary" data-size="lg"><span data-submit-label="email">メールで続ける</span></button>)
            const btn = document.querySelector('button[data-testid="continue"]')
              || document.querySelector('[data-submit-label="email"]')?.closest('button')
              || document.querySelector('button[type="submit"][data-cds="Button"]')
              || document.querySelector('button[type="submit"]')
              || Array.from(document.querySelectorAll('button')).find(b => !/google|apple/i.test(b.innerText || '') && /メールで続ける|email|继续|continue|login|登录/i.test((b.innerText || '').trim()));

            input.scrollIntoView({ block: 'center' });
            const inRect = input.getBoundingClientRect();

            let btnRect = null;
            let btnDisabled = false;
            if (btn) {
              btn.scrollIntoView({ block: 'center' });
              btnRect = btn.getBoundingClientRect();
              btnDisabled = !!btn.disabled || btn.getAttribute('aria-disabled') === 'true';
            }

            const bodyText = (document.body ? document.body.innerText : '') || '';
            const hasBrowserErr = /无法验证您的浏览器|Unable to verify your browser|ブラウザを確認できませんでした|確認できません/i.test(bodyText);

            return {
              status: 'found',
              inputVal: input.value || '',
              inX: Math.round(inRect.left + inRect.width / 2),
              inY: Math.round(inRect.top + inRect.height / 2),
              hasBtn: !!btn,
              btnDisabled,
              btnX: btnRect ? Math.round(btnRect.left + btnRect.width / 2) : 0,
              btnY: btnRect ? Math.round(btnRect.top + btnRect.height / 2) : 0,
              hasBrowserErr,
            };
          })()`,
          returnByValue: true,
        }).catch(() => null);

        const info = findRes?.result?.value;
        if (!info || info.status === 'no_input') {
          await sleep(1000);
          continue;
        }

        // 3. 如果输入框内容不等于目标邮箱，使用 CDP 真实键入 + DOM 原型注入双保险
        if (info.inputVal !== email) {
          console.log(`[login] ${flow.id} 正在填入邮箱: ${email}`);
          // A. 鼠标点击输入框聚焦
          if (info.inX > 0 && info.inY > 0) {
            await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.inX, y: info.inY, button: 'left', clickCount: 1, buttons: 1 }).catch(() => {});
            await sleep(50);
            await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.inX, y: info.inY, button: 'left', clickCount: 1, buttons: 0 }).catch(() => {});
            await sleep(80);
          }

          // B. 全选清空现有内容 (Ctrl+A + Backspace)
          await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['selectAll'], key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }).catch(() => {});
          await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 }).catch(() => {});
          await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }).catch(() => {});
          await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }).catch(() => {});
          await sleep(50);

          // C. 使用 CDP 原生 Input.insertText 真实输入（突破 React 与 cds-text-input 限制）
          await cdp.call('Input.insertText', { text: email }).catch(() => {});
          await sleep(100);

          // D. 在 DOM 层同步设置并派发全套合成事件以确保 React 18+ 状态追踪完全同步
          await cdp.call('Runtime.evaluate', {
            expression: `(() => {
              const input = document.querySelector('input[data-testid="email"]')
                || document.querySelector('input#email')
                || document.querySelector('input[placeholder="メールアドレスを入力"]')
                || document.querySelector('input[aria-label="メール"]')
                || document.querySelector('input[autocomplete="email"]')
                || document.querySelector('cds-text-input input')
                || document.querySelector('input[type="email"]');
              if (!input) return;

              // 突破 React _valueTracker
              const tracker = input._valueTracker;
              if (tracker) tracker.setValue('');

              const proto = window.HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(input, ${JSON.stringify(email)});
              else input.value = ${JSON.stringify(email)};

              input.dispatchEvent(new Event('focus', { bubbles: true, composed: true }));
              input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertText', data: ${JSON.stringify(email)} }));
              input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ${JSON.stringify(email)} }));
              input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
              input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true }));
              input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true }));
            })()`,
          }).catch(() => {});
          await sleep(300);
        }

        // 4. 等待登录按钮变为可点击状态 (最多等 2.5 秒)
        let btnReady = false;
        const waitStart = Date.now();
        while (Date.now() - waitStart < 2500) {
          const btnCheck = await cdp.call('Runtime.evaluate', {
            expression: `(() => {
              const btn = document.querySelector('button[data-testid="continue"]')
                || document.querySelector('[data-submit-label="email"]')?.closest('button')
                || document.querySelector('button[type="submit"][data-cds="Button"]')
                || document.querySelector('button[type="submit"]');
              if (!btn) return null;
              const disabled = !!btn.disabled || btn.getAttribute('aria-disabled') === 'true';
              return { disabled };
            })()`,
            returnByValue: true,
          }).catch(() => null);

          const bState = btnCheck?.result?.value;
          if (bState && !bState.disabled) {
            btnReady = true;
            break;
          }
          await sleep(200);
        }

        // 5. 点击提交按钮（优先 DOM 原生事件精确点击与表单提交，绝不使用易受缩放偏移影响的绝对坐标点击，彻底避免误触 Google 登录）
        if (info.hasBrowserErr) {
          console.log(`[login] ${flow.id} 检测到「无法验证您的浏览器」，准备自动重试提交 (${retryCount + 1}/${maxRetries})...`);
          flow.message = `页面提示「无法验证您的浏览器」，正在自动重试提交 (${retryCount + 1}/${maxRetries})…`;
        }

        await cdp.call('Runtime.evaluate', {
          expression: `(() => {
            const btn = document.querySelector('button[data-testid="continue"]')
              || document.querySelector('[data-submit-label="email"]')?.closest('button')
              || document.querySelector('button[type="submit"][data-cds="Button"]')
              || document.querySelector('button[type="submit"]')
              || Array.from(document.querySelectorAll('button')).find(b => !/google|apple/i.test(b.innerText || '') && /メールで続ける|email|继续|continue|login|登录/i.test((b.innerText || '').trim()));
            if (!btn) return false;
            btn.removeAttribute('disabled');
            btn.removeAttribute('aria-disabled');
            const emailSpan = btn.querySelector('[data-submit-label="email"]') || btn.querySelector('[data-cds-button-label]');
            if (emailSpan) emailSpan.click();
            btn.click();
            const form = btn.closest('form') || document.querySelector('form');
            if (form && typeof form.requestSubmit === 'function') {
              try { form.requestSubmit(btn); } catch { form.requestSubmit(); }
            }
            return true;
          })()`,
        }).catch(() => {});

        // 同时在输入框派发 Enter 键双重保底
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }).catch(() => {});
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }).catch(() => {});

        // 6. 点击后观察页面状态 (跳转到验证码页、成功凭据、频率限制等)
        const clickTime = Date.now();
        let advanceDetected = false;
        while (Date.now() - clickTime < 4500) {
          await sleep(800);
          const check = await cdp.call('Runtime.evaluate', {
            expression: `(() => {
              const bodyText = (document.body ? document.body.innerText : '') || '';
              const codeInput = document.querySelector('input#code, input[data-testid="code"], input[name*="code" i], cds-text-input input[name*="code" i]');
              const hasBrowserErr = /无法验证您的浏览器|Unable to verify your browser|ブラウザを確認できませんでした|確認できません/i.test(bodyText);
              const isRateLimited = /試行回数が多|too_many_attempts|しばらくしてから再度お試し|尝试次数过多/i.test(bodyText);
              const fatalErr = (() => {
                if (/アカウントが無効化|アカウントが停止|アカウント停止|無効化されました/i.test(bodyText)) return '账号已被官方禁用 (アカウントが無効化されています)';
                if (/account.*has been disabled|account.*disabled|account.*suspended/i.test(bodyText)) return '账号已被官方禁用 (Account has been disabled)';
                if (/账号已被禁用|账户已被禁用|账号已被停用|账户已被停用/i.test(bodyText)) return '账号已被官方禁用';
                if (document.querySelector('a[href*="8241253-trust-and-safety-warnings-and-appeals"]')) return '账号已被官方禁用 (Trust & Safety Appeals)';
                if (/サインインを完了できませんでした|別のブラウザからサインインをお試し|Unable to complete sign in|Could not complete sign in|Try signing in from a different browser|Try signing in from another browser|无法完成登录|请尝试从其他浏览器登录/i.test(bodyText) || !!document.querySelector('a[href*="9015913-how-to-get-support"]')) return '登录受阻（サインインを完了できませんでした / 无法完成登录）';
                return null;
              })();
              return { hasCode: !!codeInput, hasBrowserErr, isRateLimited, fatalErr };
            })()`,
            returnByValue: true,
          }).catch(() => null);

          const st = check?.result?.value;
          if (st?.fatalErr) {
            flow.isSigninFailed = true;
            flow.fatalReason = st.fatalErr;
            flow.message = `❌ ${st.fatalErr}，已停止捕获并自动拉黑删除该邮箱`;
            return false;
          }
          if (st?.hasCode) {
            advanceDetected = true;
            return true;
          }
          if (st?.isRateLimited) {
            flow.message = '该邮箱触发了登录频率限制，请稍后再试或更换邮箱';
            return false;
          }
          if (st?.hasBrowserErr) {
            break;
          }
        }

        if (advanceDetected) return true;

        const cookies = await readCookies(flow).catch(() => []);
        if (cookies.some(c => c.name === 'pendingLogin' && c.value && c.value !== 'false')) {
          return true;
        }

        retryCount++;
        if (retryCount >= maxRetries) {
          console.log(`[login] ${flow.id} 「无法验证您的浏览器」重试超限，重新加载登录页...`);
          flow.message = '正在重载登录页并重试…';
          await cdp.call('Page.reload').catch(() => {});
          retryCount = 0;
          await sleep(3000);
        } else {
          await sleep(2000);
        }
      } catch (err) {
        console.warn(`[login] ${flow.id} submitEmailToClaude 循环异常: ${err.message}`);
      }
      await sleep(800);
    }
    return false;
  }

  async function fillCodeInClaude(flow, code) {
    if (flow.isCage) {
      const release = await acquireCageInputLock();
      try {
        await cageApi('/activate', { id: flow.tabId }).catch(() => {});
        await sleep(500);
        try {
          const winList = execSync('DISPLAY=:77 xdotool search --class Chromium 2>/dev/null', { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
          const winId = winList.pop();
          if (winId) execSync(`DISPLAY=:77 xdotool windowactivate ${winId}`, { stdio: 'ignore' });
        } catch {}
        await sleep(300);
        execSync(`DISPLAY=:77 xdotool type --delay 30 ${JSON.stringify(String(code).trim())} key Return`, { stdio: 'ignore' });
        return true;
      } catch (e) {
        console.warn(`[login] ${flow.id} [Cage] 自动输入验证码异常: ${e.message}`);
        return false;
      } finally {
        release();
      }
    }

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
              || [...document.querySelectorAll('button')].find(b => !/google|apple/i.test(b.innerText || '') && /continue|验证|verify/i.test(b.innerText || ''));
            if (btn && !btn.disabled) btn.click();
            return true;
          }
          const single = document.querySelector('input[data-testid="code"], input#code, input[name*="code" i]');
          if (single) {
            single.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) {
              setter.call(single, ${JSON.stringify(code)});
            } else {
              single.value = ${JSON.stringify(code)};
            }
            single.dispatchEvent(new Event('input', { bubbles: true }));
            single.dispatchEvent(new Event('change', { bubbles: true }));
            single.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            const btn = document.querySelector('button[data-testid="continue"]')
              || document.querySelector('button[type="submit"]')
              || [...document.querySelectorAll('button')].find(b => !/google|apple/i.test(b.innerText || '') && /continue|验证|verify|確認/i.test(b.innerText || ''));
            if (btn && !btn.disabled) {
              btn.click();
            } else {
              // 没有可点的提交按钮时，靠回车提交（只走一条路，避免重复提交）
              for (const type of ['keydown', 'keypress', 'keyup']) {
                single.dispatchEvent(new KeyboardEvent(type, {
                  key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
                }));
              }
              const form = single.closest('form');
              if (form && typeof form.requestSubmit === 'function') { try { form.requestSubmit(); } catch {} }
            }
            return true;
          }
          return false;
        })()`,
        returnByValue: true
      });
    } catch {}
  }

  function cleanup(f) {
    releaseVerifyLock(f);
    if (f.isCage && f.tabId) {
      cageApi('/close', { id: f.tabId }).catch(() => {});
      f.tabId = null;
    }
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
        PROFILES_IN_USE.delete(f.profile);
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
      if (f.isCage) {
        try {
          const tabsRes = await cageApi('/tabs');
          const exists = tabsRes.tabs?.some(t => t.id === f.tabId);
          if (!exists) {
            console.log(`[login] ${f.id} Cage 浏览器标签页已关闭，停止轮询`);
            f.state = 'closed';
            f.message = '登录标签页已被关闭，请点击下方「重新发起登录」重新打开';
            if (active === f) active = null;
            break;
          }
        } catch { /* cageApi temporary error, ignore */ }
      } else if (f.proc && (f.proc.exitCode !== null || f.proc.killed)) {
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
        await releaseVerifyLock(f);
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
          const errMsg = String(e?.message || e || '');
          if (/account_banned|permission_error/i.test(errMsg)) {
            f.state = 'error';
            f.error = 'account_banned';
            f.message = `❌ 该账号已被官方封禁 (account_banned)，已停止捕获并自动删除该邮箱`;
            console.warn(`[login] ${f.id} (${f.autoEmail || ''}) 账号已被封禁: ${errMsg}`);
            if (typeof accountBannedHandler === 'function' && f.autoEmail) {
              try {
                await accountBannedHandler(f.autoEmail, f);
              } catch (banErr) {
                console.warn(`[login] 自动清理封禁邮箱异常: ${banErr.message}`);
              }
            }
            break;
          }
          // sessionKey 刚出现但组织校验未过：可能页面还在跳转，继续等
          f.state = 'waiting';
          f.message = `正在等待登录完成…（${e.message}）`;
        }
      } else if (f.state !== 'capturing') {
        f.state = 'waiting';

        // 关键检测：检查页面是否出现「アカウントが無効化されています / 账号禁用」或「サインインを完了できませんでした / 无法完成登录」致命阻断
        let fatalCheck = null;
        try {
          const pageCdp = await ensurePageCdp(f);
          const chk = await pageCdp.call('Runtime.evaluate', {
            expression: BANNED_OR_BLOCKED_EXPR,
            returnByValue: true,
          }).catch(() => null);
          fatalCheck = chk?.result?.value;
        } catch {}

        if (fatalCheck?.matched) {
          f.state = 'error';
          f.error = fatalCheck.reason || 'account_banned';
          f.message = `❌ ${fatalCheck.label}，已停止捕获并自动拉黑删除该邮箱`;
          console.warn(`[login] ${f.id} (${f.autoEmail || ''}) 检测到致命阻断：${fatalCheck.label}，判定为不可用邮箱，执行拉黑销毁并切换下一个`);
          if (typeof accountBannedHandler === 'function' && f.autoEmail) {
            try {
              await accountBannedHandler(f.autoEmail, f);
            } catch (banErr) {
              console.warn(`[login] 自动清理封禁/受阻邮箱异常: ${banErr.message}`);
            }
          }
          if (f._batchItem) {
            f._batchItem.state = 'error';
            f._batchItem.error = f.error;
            f._batchItem.message = f.message;
          }
          break;
        }

        // 尝试自动推进新账号 Onboarding 引导（输入姓名、勾选18岁条款、点击继续）
        try {
          const pageCdp = await ensurePageCdp(f);
          const onboardRes = await pageCdp.call('Runtime.evaluate', {
            expression: ONBOARDING_EXPR,
            returnByValue: true,
          }).catch(() => null);
          if (onboardRes?.result?.value) {
            console.log(`[login] ${f.id} 自动推进新账号 Onboarding 引导流程`);
            f.message = '检测到新账号欢迎流程，已自动填入姓名与确认条款，正在进入主界面…';
          }
        } catch {}

        // —— 人工验证检测：需要用户介入时把话说清楚，用户完成后自动继续捕获 ——
        const kind = await detectVerify(f, cookies);
        if (kind) {
          f.needVerify = true;
          f.verify = kind;

          if (isInteractiveVerify(kind)) {
            const gotLock = tryAcquireVerifyLock(f, kind);
            if (gotLock) {
              if (!f._verifyFocused) {
                f._verifyFocused = true;
                console.log(`[login] ${f.id} 获取验证锁，将窗口置顶：${VERIFY_LABEL[kind] || kind}`);
                if ((f.verifyExtends || 0) < 4) {
                  f.verifyExtends = (f.verifyExtends || 0) + 1;
                  f.expiresAt = Math.max(f.expiresAt, Date.now() + timeoutMs);
                }
                try {
                  await (await ensurePageCdp(f)).call('Page.bringToFront');
                  focusBrowserWindow(f.proc?.pid);
                } catch { /* 置顶失败不影响流程 */ }
              }
              f.message = VERIFY_HINT[kind] || `需要人工验证（${VERIFY_LABEL[kind] || kind}），到浏览器窗口完成后会自动继续`;
            } else {
              // 锁被其它账号占用：绝不抢占前台！静默等待排队
              f._verifyFocused = false;
              const holder = VERIFY_LOCK.holderEmail ? `「${VERIFY_LOCK.holderEmail}」` : '前一个账号';
              f.message = `⏳ 验证码排队等待中：当前正在处理 ${holder} 的验证码，请勿抢占，完成后将自动切换到此窗口…`;
            }
          } else {
            if ((kind === 'email_link' || kind === 'email_code') && f.autoVerifying && f.autoVerifyMsg) {
              f.message = f.autoVerifyMsg;
            } else {
              f.message = VERIFY_HINT[kind] || `需要人工验证（${VERIFY_LABEL[kind] || kind}），到浏览器窗口完成后会自动继续`;
            }
          }
        } else if (f.verify) {
          // 验证消失了 = 用户已完成，自动往下走（无需刷新/重启）
          f.verify = null;
          f.needVerify = false;
          f._verifyFocused = false;
          f.verifyPassedAt = Date.now();
          f.message = '✅ 验证已通过，正在自动继续捕获登录态…';
          console.log(`[login] ${f.id} 验证已通过，释放验证锁并继续`);
          await releaseVerifyLock(f);
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
      // 虚拟机专属：如果处于 Claude Cage 虚拟机环境，使用 Cage 原生浏览器（在 Cage 标签页中打开），不调用外部独立 Chrome
      if (isCageBrowserAvailable()) {
        f.isCage = true;
        f.browser = 'Cage 原生浏览器';
        console.log(`[login] ${f.id} 检测到 Cage 虚拟机环境，正在 Cage 原生浏览器中打开登录标签页...`);
        const tab = await cageApi('/new', { url: loginUrl, incognito: true });
        f.tabId = tab.id;
        f.pageCdp = new CageCdp(f.tabId);
        f.cdp = f.pageCdp;
        await f.pageCdp.call('Page.bringToFront');
        f.state = 'waiting';
        f.message = `已在 Cage 原生浏览器中打开登录标签页，正在自动填入邮箱…`;

        if (f.autoEmail) {
          f.message = `已在 Cage 原生浏览器中打开登录标签页，正在自动填入邮箱 ${f.autoEmail}…`;
          submitEmailToClaude(f, f.autoEmail).then(async ok => {
            console.log(`[login] ${f.id} 自动提交邮箱 ${f.autoEmail} 结果: ${ok}`);
            if (!ok) {
              if (f.isSigninFailed) {
                f.state = 'error';
                f.error = 'signin_failed';
                f.message = '❌ 登录受阻（サインインを完了できませんでした / 无法完成登录），已停止捕获并自动拉黑删除该邮箱';
                console.warn(`[login] ${f.id} (${f.autoEmail || ''}) 提交邮箱后页面提示无法完成登录，执行拉黑销毁`);
                if (typeof accountBannedHandler === 'function' && f.autoEmail) {
                  try { await accountBannedHandler(f.autoEmail, f); } catch {}
                }
                if (f._batchItem) {
                  f._batchItem.state = 'error';
                  f._batchItem.error = 'signin_failed';
                  f._batchItem.message = f.message;
                }
                cleanup(f);
                return;
              }
              if (LIVE.has(f.state)) f.message = `未能自动填入邮箱（页面可能需要人工验证或加载较慢），可在标签页直接操作`;
              return;
            }
            f.autoVerifying = true;
            f.autoVerifyMsg = `已提交邮箱 ${f.autoEmail}，正在等待 Claude 验证邮件…`;
            if (LIVE.has(f.state)) f.message = f.autoVerifyMsg;
            if (typeof verificationProvider === 'function') {
              try {
                console.log(`[login] ${f.id} 正在启动自动接码监听 (邮箱: ${f.autoEmail})...`);
                const res = await verificationProvider(f.autoEmail, f, (msg) => {
                  f.autoVerifyMsg = `📨 ${msg}`;
                  if (LIVE.has(f.state)) f.message = f.autoVerifyMsg;
                });
                if (res?.magicLink) {
                  f.magicLink = res.magicLink;
                  if (f._batchItem) f._batchItem.magicLink = res.magicLink;
                  f.autoVerifyMsg = '🔗 收到 Magic Link，正在浏览器中自动跳转登录…';
                  f.message = f.autoVerifyMsg;
                  console.log(`[login] ${f.id} 自动跳转 Magic Link: ${res.magicLink.slice(0, 60)}...`);
                  await f.pageCdp.call('Page.navigate', { url: res.magicLink });
                  await f.pageCdp.call('Page.bringToFront');
                } else if (res?.code) {
                  f.emailCode = res.code;
                  if (f._batchItem) f._batchItem.emailCode = res.code;
                  f.autoVerifyMsg = `🔢 收到验证码 [${res.code}]，正在浏览器中自动输入…`;
                  f.message = f.autoVerifyMsg;
                  console.log(`[login] ${f.id} 自动输入验证码: ${res.code}`);
                  await fillCodeInClaude(f, res.code);
                }
              } catch (vErr) {
                f.autoVerifying = false;
                console.warn(`[login] ${f.id} 自动接码提示: ${vErr.message}`);
                await releaseVerifyLock(f);
                if (f._batchItem) {
                  f.state = 'error';
                  f.error = 'timeout';
                  f.message = `❌ 接码超时 (${vErr.message})，自动跳过此邮箱并继续排队`;
                  f._batchItem.state = 'timeout';
                  f._batchItem.message = f.message;
                  cleanup(f);
                  return;
                }
                f.autoVerifyMsg = `自动接码失败：${vErr.message}，可在页面手动输入`;
                if (LIVE.has(f.state)) f.message = f.autoVerifyMsg;
              }
            }
          }).catch(e => {
            console.warn(`[login] ${f.id} 自动填入邮箱发生异常:`, e.message);
          });
        }

        await captureLoop(f);
        return;
      }

      // 以下为真机（Windows / macOS / 普通 Linux）标准独立 Chrome 浏览器启动逻辑
      const exe = findBrowser();
      f.browser = path.basename(exe);
      console.log(`[login] ${f.id} 正在启动登录浏览器: ${exe}`);
      f.port = await freePort();
      f.profile = path.join(os.tmpdir(), `claude-free-login-${f.id}`);
      fs.mkdirSync(f.profile, { recursive: true });
      PROFILES_IN_USE.add(f.profile);

      const args = [
        `--remote-debugging-port=${f.port}`,
        `--user-data-dir=${f.profile}`,
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=msStartupBoost,Translate,OptimizationHints',
        '--disable-background-mode',
        '--disable-backgrounding-occluded-windows',
        '--disable-infobars',
        '--new-window',
        loginUrl,
      ];

      // 自动挂载并配置 YesCaptcha Assistant 浏览器打码扩展（打码功能可选开启）
      const extDir = path.resolve(ROOT, 'tools', 'extensions', 'yescaptcha');
      let isYesCaptchaEnabled = false;

      if (fs.existsSync(path.join(extDir, 'manifest.json'))) {
        try {
          const cfgP = path.join(ROOT, 'config.json');
          let cfgObj = {};
          if (fs.existsSync(cfgP)) {
            try { cfgObj = JSON.parse(fs.readFileSync(cfgP, 'utf8')); } catch {}
          }
          const settings = cfgObj.settings || {};
          let yKey = (settings.yescaptchaClientKey || settings.yescaptchaKey || process.env.YESCAPTCHA_CLIENT_KEY || '').trim();

          // 可选开启判定：显式设为 false 时绝不挂载；有 key 且未显式关闭（或显式设为 true）才启用
          isYesCaptchaEnabled = settings.yescaptchaEnabled === true || (settings.yescaptchaEnabled !== false && !!yKey);

          if (isYesCaptchaEnabled) {
            const cfgJsPath = path.join(extDir, 'config.js');
            if (fs.existsSync(cfgJsPath)) {
              let js = fs.readFileSync(cfgJsPath, 'utf8');
              if (yKey) {
                js = js.replace(/clientKey:\s*['"][^'"]*['"]/, `clientKey: '${yKey}'`);
              }
              js = js.replace(/isOpenCloudflare:\s*false/, 'isOpenCloudflare: true');
              js = js.replace(/isAutoClickCheckBox:\s*false/, 'isAutoClickCheckBox: true');
              js = js.replace(/isAutoSubmit:\s*false/, 'isAutoSubmit: true');
              fs.writeFileSync(cfgJsPath, js, 'utf8');
              if (yKey) {
                console.log(`[login] ${f.id} [智能打码已开启] 已注入 YesCaptcha 授权 (ClientKey: ${yKey.slice(0, 6)}...)`);
              }
            }
          }
        } catch (e) {
          console.warn(`[login] ${f.id} 配置 YesCaptcha 异常:`, e.message);
        }

        if (isYesCaptchaEnabled) {
          args.unshift(`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`);
          console.log(`[login] ${f.id} [智能打码已开启] 浏览器已自动挂载 YesCaptcha Assistant 扩展插件`);
        } else {
          console.log(`[login] ${f.id} [智能打码未开启] 启动纯净原生浏览器（不挂载打码扩展插件）`);
        }
      }


      const env = { ...process.env };
      if (process.platform === 'linux') {
        if (!env.DISPLAY) {
          try {
            const xFiles = fs.readdirSync('/tmp/.X11-unix');
            const found = xFiles.find(name => /^X\d+$/.test(name));
            if (found) env.DISPLAY = ':' + found.slice(1);
          } catch {}
          if (!env.DISPLAY) env.DISPLAY = ':77';
        }
      }

      f.proc = spawn(exe, args, { stdio: 'ignore', windowsHide: false, env });
      f.proc.on('error', e => {
        console.warn(`[login] ${f.id} 浏览器启动失败: ${e.message}`);
        f.state = 'error';
        f.message = `浏览器启动失败：${e.message}`;
        if (active === f) active = null;
      });
      f.proc.on('exit', (code, sig) => {
        console.log(`[login] ${f.id} 浏览器窗口已退出 (code=${code})`);
        if (LIVE.has(f.state)) {
          if (code && code !== 0 && (Date.now() - f.startedAt) < 6000) {
            f.state = 'error';
            f.message = `浏览器启动异常退出 (exitCode=${code})，请检查显示环境`;
          } else {
            f.state = 'closed';
            f.message = '登录浏览器窗口已被关闭，请点击下方「重新发起登录」重新打开';
          }
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
        submitEmailToClaude(f, f.autoEmail).then(async ok => {
          console.log(`[login] ${f.id} 自动提交邮箱 ${f.autoEmail} 结果: ${ok}`);
          if (!ok) {
            if (f.isSigninFailed) {
              f.state = 'error';
              f.error = 'signin_failed';
              f.message = '❌ 登录受阻（サインインを完了できませんでした / 无法完成登录），已停止捕获并自动拉黑删除该邮箱';
              console.warn(`[login] ${f.id} (${f.autoEmail || ''}) 提交邮箱后页面提示无法完成登录，执行拉黑销毁`);
              if (typeof accountBannedHandler === 'function' && f.autoEmail) {
                try { await accountBannedHandler(f.autoEmail, f); } catch {}
              }
              if (f._batchItem) {
                f._batchItem.state = 'error';
                f._batchItem.error = 'signin_failed';
                f._batchItem.message = f.message;
              }
              cleanup(f);
              return;
            }
            if (LIVE.has(f.state)) f.message = `未能自动填入邮箱（页面可能需要人工验证或加载较慢），可在浏览器窗口直接操作`;
            return;
          }
          f.autoVerifying = true;
          f.autoVerifyMsg = `已提交邮箱 ${f.autoEmail}，正在等待 Claude 验证邮件…`;
          f.message = f.autoVerifyMsg;
          if (typeof verificationProvider === 'function') {
            try {
              const res = await verificationProvider(f.autoEmail, f, (msg) => {
                f.autoVerifyMsg = `📨 ${msg}`;
                if (LIVE.has(f.state)) f.message = f.autoVerifyMsg;
              });
              if (res?.magicLink) {
                f.magicLink = res.magicLink;
                if (f._batchItem) f._batchItem.magicLink = res.magicLink;
                f.autoVerifyMsg = '🔗 收到 Magic Link，正在浏览器中自动跳转登录…';
                f.message = f.autoVerifyMsg;
                console.log(`[login] ${f.id} 自动跳转 Magic Link: ${res.magicLink.slice(0, 60)}...`);
                const pageCdp = await ensurePageCdp(f);
                await pageCdp.call('Page.navigate', { url: res.magicLink });
                await pageCdp.call('Page.bringToFront').catch(() => {});
                focusBrowserWindow(f.proc?.pid);
              } else if (res?.code) {
                f.emailCode = res.code;
                if (f._batchItem) f._batchItem.emailCode = res.code;
                f.autoVerifyMsg = `🔢 收到验证码 [${res.code}]，正在浏览器中自动输入…`;
                f.message = f.autoVerifyMsg;
                console.log(`[login] ${f.id} 自动输入验证码: ${res.code}`);
                await fillCodeInClaude(f, res.code);
              }
            } catch (err) {
              f.autoVerifying = false;
              console.warn(`[login] ${f.id} 自动接码提示: ${err.message}`);
              await releaseVerifyLock(f);
              if (f._batchItem) {
                f.state = 'error';
                f.error = 'timeout';
                f.message = `❌ 接码超时 (${err.message})，自动跳过此邮箱并继续排队`;
                f._batchItem.state = 'timeout';
                f._batchItem.message = f.message;
                cleanup(f);
                return;
              }
              if (LIVE.has(f.state)) f.message = `等待邮件超时 (${err.message})，可在浏览器窗口手动完成`;
            }
          }
        }).catch(e => {
          f.autoVerifying = false;
          console.warn(`[login] ${f.id} 自动提交邮箱异常: ${e.message}`);
          if (LIVE.has(f.state)) f.message = `自动填入邮箱异常: ${e.message}`;
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
        link: x.link || (x.flowId ? `${baseUrl}/login/${x.flowId}` : null),
        needVerify: !!x.needVerify,
        verify: x.verify || null,
        magicLink: x.magicLink || null,
        emailCode: x.emailCode || null,
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
    VERIFY_LOCK.holderId = null;
    VERIFY_LOCK.holderEmail = '';
    VERIFY_LOCK.kind = null;
    VERIFY_QUEUE.length = 0;
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
        item.link = f.link;
        item.needVerify = !!f.needVerify;
        item.verify = f.verify || null;
        if (f.magicLink) item.magicLink = f.magicLink;
        if (f.emailCode) item.emailCode = f.emailCode;
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

    /** 唤醒并置顶指定登录窗口，并将人机验证焦点切换为此账号 */
    async focus(id) {
      const f = flows.get(id);
      if (!f || !LIVE.has(f.state)) return { ok: false, message: '登录流程不存在或已结束' };

      // 1. 将人机验证互斥锁强制切换为此账号，允许用户自由逐一处理任意账号的验证码
      VERIFY_LOCK.holderId = f.id;
      VERIFY_LOCK.holderEmail = f.autoEmail || f.id;
      VERIFY_LOCK.kind = f.verify || 'verify';
      VERIFY_LOCK.acquiredAt = Date.now();
      f._verifyFocused = true;
      f.expiresAt = Math.max(f.expiresAt, Date.now() + timeoutMs); // 延长超时时间防中断

      // 2. CDP / 浏览器激活页面到最前
      try {
        const cdp = await ensurePageCdp(f);
        await cdp.call('Page.bringToFront');
      } catch {}

      // 3. 操作系统级别窗口置顶激活 (Cage 环境无需系统级窗口置顶，仅真机调用)
      if (!f.isCage) {
        focusBrowserWindow(f.proc?.pid);
      }

      return {
        ok: true,
        message: f.isCage
          ? `已切换到 Cage 原生浏览器中「${f.autoEmail || f.id}」的登录标签页！`
          : `已将「${f.autoEmail || f.id}」的登录窗口置顶到前台！`,
        link: f.link,
        magicLink: f.magicLink || null,
        emailCode: f.emailCode || null,
        verify: f.verify || null,
      };
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
    registerVerificationProvider(fn) {
      verificationProvider = fn;
    },
    registerAccountBannedHandler(fn) {
      accountBannedHandler = fn;
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

/* ---------------------------------------------------------------------- */
/* 手动过 Cloudflare：弹真浏览器 → 用户手动过挑战 → 收新 cf_clearance + UA  */
/* ---------------------------------------------------------------------- */

/**
 * 「手动过CF」管理器。
 *
 * 适用场景：池中账号的 cf_clearance 被 Cloudflare 作废（上游集体返回
 * cloudflare_challenge）。此时不打码、不重试 —— 直接弹一个有头 Chrome
 * （临时 profile），只种 sessionKey（旧 clearance 已作废，不种，避免污染
 * 新会话），打开 claude.ai 让用户手动过挑战。浏览器一旦拿到新 cf_clearance：
 *   1. 读回全部 claude.ai cookie + 浏览器精确 UA（clearance 与 UA 必须配套）
 *   2. validateLogin 用「新 cookie + 新 UA」校验 sessionKey 仍有效
 *   3. onCapture 回调（反代侧写回账号池并清冷却）
 *   4. 关浏览器、删临时 profile
 * 同一时刻只允许一个流程（弹窗是稀缺交互资源）；超时默认 5 分钟。
 *
 * 复用本模块私有工具：findBrowser / freePort / waitCdp / focusBrowserWindow /
 * CDP / readCookies / claudeCookies / validateLogin。
 * 不复用 ensurePageCdp —— 它的兜底导航固定指向登录页，这里需要的是首页。
 *
 * @param {{onCapture: Function, webUrl?: string|Function, timeoutMs?: number}} opts
 *   onCapture({ accountId, cookie, ua, org, name, plan }) → 反代负责写回账号池
 */
export function createCfVerifyManager(opts) {
  const {
    onCapture,
    webUrl = 'https://claude.ai/',
    timeoutMs = 5 * 60 * 1000,
  } = opts;

  // 创建时顺手清扫上次遗留的临时 Chrome profile（崩溃/强杀留下的尸体）
  sweepStaleProfiles();

  const flows = new Map();
  let active = null;
  const LIVE = new Set(['starting', 'waiting', 'capturing']);

  function stateOf(f) {
    return {
      id: f.id,
      account_id: f.accountId,
      state: f.state,
      message: f.message,
      browser: f.browser || '',
      fingerprint: f.fingerprint || null,
      startedAt: f.startedAt,
      expiresAt: f.expiresAt,
      account: f.account || null,
    };
  }

  function state(fid) {
    const f = flows.get(fid);
    if (f) return stateOf(f);
    if (batch && batch.id === fid) return batchStateOf(batch);
    return null;
  }

  function activeFlow() {
    return active && LIVE.has(active.state) ? active : null;
  }

  function cleanup(f) {
    if (f.port) ALLOCATED_PORTS.delete(f.port);
    try { f.pageCdp?.close(); } catch { /* noop */ }
    try { f.cdp?.close(); } catch { /* noop */ }
    if (f.proc && !f.proc.killed && f.proc.exitCode === null) {
      // Windows 上 Chrome 有子进程树，taskkill /T 才能干净退出并释放 profile
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/PID', String(f.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* noop */ }
      } else {
        try { f.proc.kill('SIGTERM'); } catch { /* noop */ }
      }
    }
    if (f.profile) {
      // 新 clearance 已入库，临时 profile 里的 cookie 不再需要，删掉避免凭据残留
      setTimeout(() => {
        try { fs.rmSync(f.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* noop */ }
        PROFILES_IN_USE.delete(f.profile);
      }, 800);
    }
    if (active === f) active = null;
  }

  /** 连接页面 target 并确保导航到目标 URL（启动参数通常已直达，这里只兜底 about:blank） */
  async function connectPage(f, url) {
    for (let i = 0; i < 12; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${f.port}/json/list`, {
          signal: AbortSignal.timeout(2000),
        })).json();
        const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) {
          const p = await CDP.connect(page.webSocketDebuggerUrl);
          try {
            await p.call('Page.enable');
            await p.call('Page.addScriptToEvaluateOnNewDocument', {
              source: `try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}`,
            }).catch(() => {});
            await p.call('Runtime.evaluate', {
              expression: `try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}`,
            }).catch(() => {});
            const cur = String(page.url || '');
            if (!cur || cur === 'about:blank') await p.call('Page.navigate', { url });
          } catch { /* 导航失败不影响 cookie 捕获 */ }
          return p;
        }
      } catch { /* 端口还没就绪 */ }
      await sleep(500);
    }
    return null;
  }

  async function run(f) {
    try {
      const exe = findBrowser();
      f.browser = path.basename(exe);
      console.log(`[cfverify] ${f.id} 正在启动过CF浏览器: ${exe}`);
      f.port = await freePort();
      f.profile = path.join(os.tmpdir(), `claude-cf-verify-${f.id}`);
      fs.mkdirSync(f.profile, { recursive: true });
      PROFILES_IN_USE.add(f.profile);

      const target = typeof webUrl === 'function' ? webUrl() : webUrl;
      // 指纹随机（每次过CF现场抽签）：窗口尺寸 8 组池 + ±12px 抖动避开标准值，
      // Accept-Language 4 组 ja 系变体随机；无痕模式 cookie 只进内存不落盘。
      // 时区固定 Asia/Tokyo、UA 保持真实版本——这两项与账号/真机绑定，不能随机。
      const rnd = (n) => Math.floor(Math.random() * n);
      const pick = (arr) => arr[rnd(arr.length)];
      const SIZES = [[1366, 768], [1440, 900], [1536, 864], [1600, 900], [1680, 1050], [1920, 1080], [1280, 800], [1856, 1044]];
      const LANGS = ['ja-JP,ja,en-US,en;q=0.8', 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7', 'ja,en-US;q=0.9,en;q=0.8', 'ja-JP,ja,en;q=0.8'];
      const [pw, ph] = pick(SIZES);
      const fsize = [pw + rnd(25) - 12, ph + rnd(25) - 12];
      const flang = pick(LANGS);
      f.fingerprint = { size: `${fsize[0]}x${fsize[1]}`, lang: flang, tz: 'Asia/Tokyo', incognito: true };
      console.log(`[cfverify] ${f.id} 账号 ${f.accountId} 随机指纹: ${f.fingerprint.size} / ${flang} / 无痕`);
      const args = [
        `--remote-debugging-port=${f.port}`,
        `--user-data-dir=${f.profile}`,
        '--incognito',
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,OptimizationHints',
        '--disable-infobars',
        `--window-size=${fsize[0]},${fsize[1]}`,
        `--accept-lang=${flang}`,
        '--new-window',
        target,
      ];
      const env = { ...process.env };
      if (process.platform === 'linux') {
        if (!env.DISPLAY) {
          try {
            const xFiles = fs.readdirSync('/tmp/.X11-unix');
            const found = xFiles.find(name => /^X\d+$/.test(name));
            if (found) env.DISPLAY = ':' + found.slice(1);
          } catch {}
          if (!env.DISPLAY) env.DISPLAY = ':77';
        }
      }

      f.proc = spawn(exe, args, { stdio: 'ignore', windowsHide: false, env });
      f.proc.on('error', e => {
        console.warn(`[cfverify] ${f.id} 浏览器启动失败: ${e.message}`);
        f.state = 'error';
        f.message = `浏览器启动失败：${e.message}`;
        if (active === f) active = null;
      });
      f.proc.on('exit', code => {
        console.log(`[cfverify] ${f.id} 浏览器窗口已退出 (code=${code})`);
        if (LIVE.has(f.state)) {
          f.state = 'closed';
          f.message = '浏览器窗口已被关闭，未捕获到新的 cf_clearance；可重新发起';
        }
        if (active === f) active = null;
      });

      // 等调试端口就绪（冷启动 + 安全软件扫描可能较慢，给 60s）
      const ver = await waitCdp(f.port, 60, f);
      if (!ver?.webSocketDebuggerUrl) {
        f.state = 'error';
        f.message = '浏览器已启动，但调试端口 60 秒内没就绪（可能被安全软件拦截），请重试';
        return;
      }
      f.cdp = await CDP.connect(ver.webSocketDebuggerUrl);
      // UA 必须与新 clearance 配套保存 —— 取这个浏览器的真实 UA
      try { const v = await f.cdp.call('Browser.getVersion'); f.ua = v?.userAgent || ''; } catch {}

      f.pageCdp = await connectPage(f, target);
      if (!f.pageCdp) {
        f.state = 'error';
        f.message = '无法连接页面调试通道，无痕模式下无法种入登录态，请重试';
        if (active === f) active = null;
        try { f.proc.kill(); } catch { /* noop */ }
        return;
      }
      // 时区/区域覆盖：对挑战页 JS 同样生效（CDP Emulation 级），刷新前套好
      try { await f.pageCdp.call('Emulation.setTimezoneOverride', { timezoneId: f.fingerprint.tz }); } catch { /* 老内核不支持就算了 */ }
      try { await f.pageCdp.call('Emulation.setLocaleOverride', { locale: 'ja-JP' }); } catch { /* noop */ }
      // 只种 sessionKey：旧 cf_clearance 已被 CF 作废，种进去反而污染新会话。
      // 无痕窗口用独立内存 jar，浏览器级 Storage.setCookies 写的是默认 jar
      // （无痕页看不见），必须走页面级 Network.setCookie；种完刷新一次生效。
      const seeded = await f.pageCdp.call('Network.setCookie', {
        name: 'sessionKey',
        value: f.sessionKey,
        domain: '.claude.ai',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      }).catch(() => null);
      if (!(seeded === true || seeded?.success === true)) {
        f.state = 'error';
        f.message = '种入 sessionKey 失败（页面级 CDP 拒绝），请重试';
        if (active === f) active = null;
        try { f.proc.kill(); } catch { /* noop */ }
        return;
      }
      await f.pageCdp.call('Page.reload', { ignoreCache: true }).catch(() => {});

      focusBrowserWindow(f.proc.pid);
      f.state = 'waiting';
      f.message = '已弹出浏览器并载入 claude.ai —— 请在窗口里完成 Cloudflare 验证'
        + '（「确认您是真人」点选等），通过后自动捕获新 cf_clearance 并写回账号池';

      let consecutiveFails = 0;
      while (Date.now() < f.expiresAt && f.state !== 'cancelled' && f.state !== 'closed') {
        if (f.proc && (f.proc.exitCode !== null || f.proc.killed)) break; // exit 事件已收尾
        let cookies = [];
        try {
          cookies = claudeCookies(await readCookies(f));
          consecutiveFails = 0;
        } catch (e) {
          // 连续 4 次（约 6 秒）读不到 → 浏览器连接已断开
          console.warn(`[cfverify] ${f.id} 读取 cookie 失败: ${e.message}`);
          f.message = `读取浏览器 cookie 失败（${e.message}），重试中…`;
          if (++consecutiveFails >= 4) {
            f.state = 'closed';
            f.message = '浏览器连接已断开，未捕获到新的 cf_clearance；可重新发起';
            if (active === f) active = null;
            break;
          }
          cookies = [];
        }

        if (cookies.some(c => c.name === 'cf_clearance' && c.value)) {
          f.state = 'capturing';
          f.message = '✅ 检测到新 cf_clearance，正在校验登录态并写回账号池…';
          const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          const ua = f.ua || DEFAULT_UA;
          // 用「新 cookie + 新 UA」校验：sessionKey 失效会在这里原样报出来
          const info = await validateLogin({ cookie, ua, base: 'https://claude.ai' });
          const account = await onCapture({
            accountId: f.accountId,
            cookie,
            ua,
            org: info.org,
            name: info.name,
            plan: info.plan,
          });
          f.account = account || { id: f.accountId };
          f.state = 'done';
          f.message = '✅ cf_clearance 已更新并写回账号池，该账号已解除 Cloudflare 拦截';
          console.log(`[cfverify] ${f.id} 账号 ${f.accountId} 新 cf_clearance 已入池 (org=${info.org} plan=${info.plan || '-'})`);
          break;
        }
        await sleep(1500);
      }

      if (LIVE.has(f.state)) {
        f.state = 'timeout';
        f.message = '过CF超时（5 分钟内未捕获到新 cf_clearance），可重新发起';
      }
    } catch (e) {
      if (f.state !== 'cancelled' && f.state !== 'closed') {
        f.state = 'error';
        f.message = e.message || String(e);
        console.warn(`[cfverify] ${f.id} 流程异常: ${f.message}`);
      }
    } finally {
      cleanup(f);
    }
  }

  /* —— 批量过CF：顺序弹窗逐个捕获，一次只弹一个浏览器窗口 —— */
  const BATCH_LIVE = new Set(['starting', 'running']);
  let batch = null;

  function batchStateOf(b) {
    return {
      id: b.id,
      state: b.state,
      // 动态拼接当前账号的实时进度（b.current.message 每秒都在变）
      message: b.current ? `${b.index + 1}/${b.total} · ${b.current.message}` : b.message,
      startedAt: b.startedAt,
      batch: {
        index: b.index,
        total: b.total,
        current_account_id: b.current ? b.current.accountId : null,
        results: b.results,
      },
    };
  }

  function batchLive() {
    return batch && BATCH_LIVE.has(batch.state) ? batch : null;
  }

  function makeFlow(accountId, sessionKey) {
    const f = {
      id: 'cf' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      accountId,
      sessionKey: String(sessionKey || '').trim(),
      state: 'starting',
      message: '正在启动浏览器…',
      startedAt: Date.now(),
      expiresAt: Date.now() + timeoutMs,
    };
    flows.set(f.id, f);
    active = f;
    return f;
  }

  async function driveBatch(b) {
    while (b.queue.length && b.state === 'running') {
      const item = b.queue.shift();
      const f = makeFlow(item.id, item.sessionKey);
      b.current = f;
      console.log(`[cfverify] 批量 ${b.index + 1}/${b.total}：账号 ${item.id} 开始过CF`);
      await run(f); // 等这个账号终态（浏览器已关）再弹下一个
      b.results.push({ id: item.id, ok: f.state === 'done', state: f.state, message: f.message });
      b.index++;
      b.current = null;
      // 用户主动关掉浏览器窗口 = 停止批量（否则关一个会立刻弹下一个，停不下来）
      if (f.state === 'closed' && b.state === 'running' && b.queue.length) {
        b.state = 'cancelled';
        b.message = '检测到浏览器窗口被关闭，批量已停止';
        console.log(`[cfverify] ${b.message}`);
      }
    }
    const okN = b.results.filter(x => x.ok).length;
    const cancelled = b.state === 'cancelled';
    b.message = `批量过CF结束：成功 ${okN}/${b.total}` + (cancelled ? '（中途取消，剩余账号未处理）' : '');
    b.state = cancelled ? 'cancelled' : 'done';
    console.log(`[cfverify] ${b.message} (${b.results.map(x => `${x.id}:${x.ok ? 'ok' : x.state}`).join(' ')})`);
  }

  return {
    /**
     * 发起一次「手动过CF」。
     * @param {string} accountId 账号池 id
     * @param {string} sessionKey 该账号当前 sessionKey（只种这一个 cookie）
     * @returns {{ok: true, flowId: string, reused?: boolean} | {ok: false, error: string}}
     */
    start(accountId, sessionKey) {
      const sk = String(sessionKey || '').trim();
      if (!sk) return { ok: false, error: '该账号没有 sessionKey，无法过CF（请重新登录导入）' };
      const b = batchLive();
      if (b) return { ok: false, error: `批量过CF进行中（${b.index + 1}/${b.total}），等它完成` };
      const cur = activeFlow();
      if (cur) {
        if (cur.accountId === accountId) return { ok: true, flowId: cur.id, reused: true };
        return { ok: false, error: `已有一个过CF流程在进行中（账号 ${cur.accountId}），等它完成后再试` };
      }
      const f = makeFlow(accountId, sk);
      run(f); // 后台跑，不 await
      return { ok: true, flowId: f.id };
    },

    /**
     * 一键批量过CF：把队列里的账号顺序过一遍（每个账号弹一次浏览器，
     * 终态后自动换下一个）。任何时刻只有一个浏览器窗口。
     * @param {Array<{id: string, sessionKey: string}>} items 由反代从账号池组装
     */
    startBatch(items) {
      const list = (Array.isArray(items) ? items : []).filter(x => x && x.id && x.sessionKey);
      if (!list.length) return { ok: false, error: '没有可过CF的账号（缺 sessionKey）' };
      const cur = batchLive();
      if (cur) return { ok: true, flowId: cur.id, reused: true };
      const single = activeFlow();
      if (single) return { ok: false, error: `单个过CF流程进行中（账号 ${single.accountId}），等它完成后再批量` };
      const b = {
        id: 'cfB' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        queue: list.map(x => ({ id: x.id, sessionKey: x.sessionKey })),
        index: 0,
        total: list.length,
        results: [],
        current: null,
        state: 'running',
        message: `批量过CF：共 ${list.length} 个账号，逐个弹出浏览器…`,
        startedAt: Date.now(),
      };
      batch = b;
      driveBatch(b).catch(e => { b.state = 'error'; b.message = e.message || String(e); });
      return { ok: true, flowId: b.id };
    },

    /** 取消批量：当前账号跑完后不再弹下一个（不杀正在进行的浏览器窗口） */
    cancel(fid) {
      if (batch && batch.id === fid && BATCH_LIVE.has(batch.state)) {
        batch.state = 'cancelled';
        batch.message = '正在取消（当前账号完成后停止）…';
        return true;
      }
      return false;
    },

    state,
    activeFlow: () => (active ? stateOf(active) : null),
  };
}

/**
 * 一键打开并登录 Claude 官方网页端
 * 启动一个独立 Chrome 窗口，通过 CDP 种入 sessionKey（及 cf_clearance/org），
 * 然后直达 claude.ai/new，保持浏览器打开供用户日常使用。
 */
export async function openClaudeWebBrowser({ sessionKey, org = '', cookie = '', ua = '', targetUrl = 'https://claude.ai/new' }) {
  if (!sessionKey || !sessionKey.startsWith('sk-ant-')) {
    throw new Error('无效的 sessionKey');
  }
  const exe = findBrowser({ preferDefault: true });
  const port = await freePort();
  const profile = path.join(os.tmpdir(), `claude-web-user-${Buffer.from(sessionKey).toString('hex').slice(-8)}`);
  fs.mkdirSync(profile, { recursive: true });

  // 清除旧的 Singleton 锁，防止重复点击或残留锁阻止浏览器弹出
  if (process.platform === 'win32') {
    try {
      for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const p = path.join(profile, f);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch {}
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msStartupBoost,Translate,OptimizationHints',
    '--disable-background-mode',
    '--disable-backgrounding-occluded-windows',
    '--new-window',
    'about:blank',
  ];


  const proc = spawn(exe, args, {
    stdio: 'ignore',
    windowsHide: false,
    env: process.env,
    detached: true,
  });
  proc.unref();
  const browserPid = proc.pid;

  // 等待 CDP 调试端口就绪
  const ver = await waitCdp(port, 25);
  if (!ver?.webSocketDebuggerUrl) {
    throw new Error('浏览器已启动，但调试端口连接超时');
  }

  // 连接页面 Target
  let pageCdp = null;
  for (let i = 0; i < 15; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        pageCdp = await CDP.connect(page.webSocketDebuggerUrl);
        break;
      }
    } catch {}
    await sleep(400);
  }

  if (!pageCdp) throw new Error('无法连接浏览器页面调试通道');

  try {
    await pageCdp.call('Page.enable');
    await pageCdp.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}`,
    }).catch(() => {});

    // 种入 sessionKey
    await pageCdp.call('Network.setCookie', {
      name: 'sessionKey',
      value: sessionKey,
      domain: '.claude.ai',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });

    // 如果有 cf_clearance，从 cookie 解析并种入
    if (cookie) {
      const cfMatch = /(?:^|;\s*)cf_clearance=([^;]+)/.exec(cookie);
      if (cfMatch) {
        await pageCdp.call('Network.setCookie', {
          name: 'cf_clearance',
          value: cfMatch[1],
          domain: '.claude.ai',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'None',
        }).catch(() => {});
      }
    }

    // 如果有 org，种入 lastActiveOrg
    if (org) {
      await pageCdp.call('Network.setCookie', {
        name: 'lastActiveOrg',
        value: org,
        domain: '.claude.ai',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      }).catch(() => {});
    }

    // 导航到 targetUrl
    await pageCdp.call('Page.navigate', { url: targetUrl }).catch(() => {});

    // 聚焦窗口拉到前台
    activateBrowserWindow(browserPid);
    focusBrowserWindow(browserPid);
  } catch (err) {
    console.warn(`[open-web] 设置 cookie 或导航异常: ${err.message}`);
  } finally {
    if (pageCdp) {
      try { pageCdp.close(); } catch {}
    }
  }

  return { ok: true, browser: path.basename(exe), pid: browserPid };
}


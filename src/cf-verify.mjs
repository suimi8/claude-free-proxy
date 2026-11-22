#!/usr/bin/env node
/**
 * cf-verify.mjs —— 「过CF验证」辅助管理器
 *
 * 核心功能：
 *   1. 调起系统可见的 Chrome/Edge 浏览器窗口，直达 claude.ai
 *   2. 通过 CDP 种入待恢复账号的 sessionKey，并监听 Cloudflare 验证完成
 *   3. 用户在可见窗口内完成「确认您是真人」点选后，CDP 自动捕获新 cf_clearance 及配套 User-Agent
 *   4. 校验组织并回调 onCapture 写回账号池，重置冷却与错误，关闭浏览器并清理临时 profile
 *   5. 支持单账号即时过CF与多账号一键批量过CF（队列顺序弹窗，始终只开 1 个浏览器窗口）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execSync } from 'node:child_process';

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

  // 1. Linux 平台
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

  if (preferDefault && defaultBrowser && /chrome|edge|brave|chromium|vivaldi|360/i.test(defaultBrowser)) {
    return defaultBrowser;
  }

  for (const p of chromePaths) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }

  if (defaultBrowser && /chrome|edge|brave|chromium|vivaldi|360/i.test(defaultBrowser)) {
    return defaultBrowser;
  }

  for (const p of edgePaths) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }

  if (defaultBrowser) return defaultBrowser;

  throw new Error('找不到可用的浏览器（Chrome/Edge/默认浏览器），可用 LOGIN_BROWSER 环境变量指定浏览器 exe 路径');
}

const ALLOCATED_PORTS = new Set();
export function freePort() {
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
export async function waitCdp(port, timeoutSec, flow = null) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    if (flow?.proc && (flow.proc.exitCode !== null || flow.proc.killed)) {
      return null;
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(900) });
      if (r.ok) return await r.json();
    } catch { /* 端口未就绪 */ }
    if (Date.now() >= deadline) return null;
    await sleep(400);
  }
}

/**
 * 把刚拉起的浏览器窗口拉到前台（防止被遮挡）
 */
export function focusBrowserWindow(pid) {
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

/** 极简 CDP 客户端 */
export class CDP {
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

export function claudeCookies(cookies) {
  return (cookies || []).filter(c => {
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    return d === 'claude.ai' || d.endsWith('.claude.ai');
  });
}

/** 取回 claude.ai 域下的全部 cookie（含 HttpOnly） */
export async function readCookies(flow) {
  // 1) 页面级 Network.getCookies（限定 claude.ai）
  try {
    if (flow.pageCdp && flow.pageCdp.ws.readyState === 1) {
      const r = await flow.pageCdp.call('Network.getCookies', { urls: ['https://claude.ai/'] });
      if (Array.isArray(r?.cookies) && r.cookies.length) return r.cookies;
    }
  } catch { /* 断线走下面兜底 */ }

  // 2) 浏览器级 Storage.getCookies（Chrome/Edge 100+，非无痕模式兜底）
  try {
    if (flow.cdp && flow.cdp.ws.readyState === 1) {
      const r = await flow.cdp.call('Storage.getCookies');
      if (Array.isArray(r?.cookies)) return r.cookies;
    }
  } catch { /* 老版本回退到页面 target */ }

  // 3) 页面级 Network.getAllCookies
  if (flow.pageCdp && flow.pageCdp.ws.readyState === 1) {
    try {
      const r = await flow.pageCdp.call('Network.getAllCookies');
      return r?.cookies || [];
    } catch {}
  }
  return [];
}

/** 用新捕获的 cookie 和 ua 验证登录态并获取组织信息 */
export async function validateLogin({ cookie, ua, base = 'https://claude.ai' }) {
  const headers = {
    cookie,
    'user-agent': ua,
    accept: 'application/json',
    origin: base,
    referer: base + '/',
  };

  let email = '';
  try {
    const bootR = await fetch(`${base}/api/bootstrap`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (bootR.ok) {
      const bootData = await bootR.json().catch(() => null);
      if (bootData?.account?.email_address) {
        email = String(bootData.account.email_address).toLowerCase().trim();
      }
    }
  } catch {}

  const r = await fetch(`${base}/api/organizations`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 120)}`);
  let arr;
  try { arr = JSON.parse(txt); } catch { throw new Error('组织接口返回非 JSON'); }
  const list = Array.isArray(arr) ? arr : (arr.data || []);
  const org = list[0]?.uuid;
  if (!org) throw new Error('未返回组织信息（登录可能未完成）');
  return { org, name: list[0]?.name || '', plan: list[0]?.rate_limit_tier || '', email };
}

/* 临时 Chrome profile 登记表：在跑的流程占用中，启动清扫时跳过防止误删 */
const PROFILES_IN_USE = new Set();

/** 清扫遗留的临时 profile */
export function sweepStaleProfiles() {
  let entries;
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!/^(?:claude-cf-verify-|claude-free-login-|claude-free-har-|cfv-manual-test)/.test(ent.name)) continue;
    const full = path.join(os.tmpdir(), ent.name);
    if (PROFILES_IN_USE.has(full)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      console.log(`[profile-sweep] 已清理遗留临时目录 ${ent.name}`);
    } catch { /* 可能被残留 Chrome 进程占用，下次启动再清 */ }
  }
}

/**
 * 创建过CF流程管理器。
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

  // 创建时顺手清扫上次遗留的临时 Chrome profile
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
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/PID', String(f.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* noop */ }
      } else {
        try { f.proc.kill('SIGTERM'); } catch { /* noop */ }
      }
    }
    if (f.profile) {
      setTimeout(() => {
        try { fs.rmSync(f.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* noop */ }
        PROFILES_IN_USE.delete(f.profile);
      }, 800);
    }
    if (active === f) active = null;
  }

  /** 连接页面 target 并确保导航到目标 URL */
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
          } catch { /* 导航失败不影响后续 */ }
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

      const ver = await waitCdp(f.port, 60, f);
      if (!ver?.webSocketDebuggerUrl) {
        f.state = 'error';
        f.message = '浏览器已启动，但调试端口 60 秒内没就绪（可能被安全软件拦截），请重试';
        return;
      }
      f.cdp = await CDP.connect(ver.webSocketDebuggerUrl);
      try { const v = await f.cdp.call('Browser.getVersion'); f.ua = v?.userAgent || ''; } catch {}

      f.pageCdp = await connectPage(f, target);
      if (!f.pageCdp) {
        f.state = 'error';
        f.message = '无法连接页面调试通道，无痕模式下无法种入登录态，请重试';
        if (active === f) active = null;
        try { f.proc.kill(); } catch { /* noop */ }
        return;
      }
      try { await f.pageCdp.call('Emulation.setTimezoneOverride', { timezoneId: f.fingerprint.tz }); } catch { /* noop */ }
      try { await f.pageCdp.call('Emulation.setLocaleOverride', { locale: 'ja-JP' }); } catch { /* noop */ }

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
        if (f.proc && (f.proc.exitCode !== null || f.proc.killed)) break;
        let cookies = [];
        try {
          cookies = claudeCookies(await readCookies(f));
          consecutiveFails = 0;
        } catch (e) {
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
      await run(f);
      b.results.push({ id: item.id, ok: f.state === 'done', state: f.state, message: f.message });
      b.index++;
      b.current = null;
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
     * @param {string} sessionKey 该账号当前 sessionKey
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
      run(f);
      return { ok: true, flowId: f.id };
    },

    /**
     * 一键批量过CF：把队列里的账号顺序过一遍（每个账号弹一次浏览器，
     * 终态后自动换下一个）。任何时刻只有一个浏览器窗口。
     * @param {Array<{id: string, sessionKey: string}>} items
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

    /** 取消批量：当前账号跑完后不再弹下一个 */
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
 */
export async function openClaudeWebBrowser({ sessionKey, org = '', cookie = '', ua = '', targetUrl = 'https://claude.ai/new' }) {
  if (!sessionKey || !sessionKey.startsWith('sk-ant-')) {
    throw new Error('无效的 sessionKey');
  }
  const exe = findBrowser({ preferDefault: true });
  const port = await freePort();
  const profile = path.join(os.tmpdir(), `claude-web-user-${Buffer.from(sessionKey).toString('hex').slice(-8)}`);
  fs.mkdirSync(profile, { recursive: true });

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

  const ver = await waitCdp(port, 25);
  if (!ver?.webSocketDebuggerUrl) {
    throw new Error('浏览器已启动，但调试端口连接超时');
  }

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

    await pageCdp.call('Network.setCookie', {
      name: 'sessionKey',
      value: sessionKey,
      domain: '.claude.ai',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });

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

    await pageCdp.call('Page.navigate', { url: targetUrl }).catch(() => {});

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

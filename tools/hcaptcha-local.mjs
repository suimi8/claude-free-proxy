#!/usr/bin/env node
// @ts-check
/**
 * 本机真实浏览器 (Chrome/Chromium + CDP) hCaptcha 打码器
 *
 * 背景：
 *   claude.ai 的注册链路用 hCaptcha 作为「客户端证明 (client attestation)」。
 *   第三方打码平台是在 **他们自己的机房 IP + 他们自己的浏览器** 中完成验证码的，
 *   而 claude.ai 的风控会把「验证码签发环境」与「请求环境」做比对，
 *   在「兑换 sessionKey / 建号」这一步以 sign_in_not_permitted 拒绝。
 *
 *   本模块让验证码在 **本机浏览器** 中完成，因此签发 IP、UA、指纹与后续请求完全一致。
 *
 * 用法（独立调试）：
 *   node tools/hcaptcha-local.mjs <sitekey> [pageUrl]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ───────────────────────── 浏览器定位 ───────────────────────── */

export function findBrowser() {
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome / Chromium 可执行文件');
}

/** Xvfb 可执行文件（Linux 虚拟显示器） */
export function hasXvfb() {
  for (const p of ['/usr/bin/Xvfb', '/usr/local/bin/Xvfb']) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── 极简 CDP 客户端 ───────────────────────── */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(timer);
        m.error ? reject(new Error(m.error.message || 'CDP error')) : resolve(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP 连接超时')), 10000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    return new CDP(ws);
  }
  call(method, params = {}, timeoutMs = 20000, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      try { this.ws.send(JSON.stringify(msg)); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

/* ───────────────────────── 页面内注入脚本 ───────────────────────── */

function injectScript(sitekey) {
  return `(async () => {
    const SITEKEY = ${JSON.stringify(sitekey)};
    window.__hcToken = null;
    window.__hcError = null;
    const URLS = [
      'https://js.hcaptcha.com/1/api.js?render=explicit&recaptchacompat=off&hl=en',
      'https://js.hcaptcha.com/1/api.js?render=explicit&recaptchacompat=off',
      'https://www.hcaptcha.com/1/api.js?render=explicit&hl=en',
    ];
    const loadOne = (src) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true; s.defer = true;
      s.onload = () => (window.hcaptcha ? resolve(window.hcaptcha) : reject(new Error('no hcaptcha')));
      s.onerror = () => reject(new Error('load error: ' + src));
      (document.head || document.documentElement).appendChild(s);
    });    const loadApi = async () => {
      if (window.hcaptcha) return window.hcaptcha;
      let lastErr = null;
      for (const u of URLS) {
        try { return await loadOne(u); } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('api.js load error');
    };
    try {
      const api = await loadApi();
      let host = document.getElementById('__hc_host');
      if (!host) {
        host = document.createElement('div');
        host.id = '__hc_host';
        // 保持可见尺寸，display:none / opacity:0 会被 hCaptcha 判为不可见组件
        host.style.cssText = 'position:fixed;left:24px;top:24px;width:304px;height:80px;z-index:2147483647';
        (document.body || document.documentElement).appendChild(host);
      }
      const wid = api.render(host, {
        sitekey: SITEKEY,
        size: 'invisible',
        callback: (t) => { window.__hcToken = t; },
        'error-callback': () => { window.__hcError = 'hCaptcha error-callback'; },
        'expired-callback': () => { window.__hcError = 'hCaptcha expired-callback'; },
      });
      setTimeout(() => { try { api.execute(wid); } catch (e) { /* invisible 组件已自动执行 */ } }, 1200);
    } catch (e) {
      window.__hcError = 'inject: ' + (e && e.message ? e.message : String(e));
    }
    return true;
  })()`;
}

/* ───────────────────────── 本机浏览器会话 ───────────────────────── */

/**
 * 复用一个本机浏览器进程，完成多次 hCaptcha 求解。
 * 浏览器 UA 会在第一次启动后固定下来，供协议请求使用。
 */
export class LocalCaptchaBrowser {
  /**
   * @param {{ headless?: boolean, onProgress?: (m: string) => void }} [opts]
   */
  constructor(opts = {}) {
    if (opts.headless !== undefined) this.headless = opts.headless;
    else this.headless = !(process.platform === 'win32' || process.platform === 'darwin' || hasXvfb());
    this.proxy = opts.proxy || '';
    this.onProgress = opts.onProgress || (() => {});
    this.proc = null;
    this.cdp = null;
    this.port = 0;
    this.profile = '';
    this.userAgent = '';
    this.xvfb = null;
    this.display = process.env.DISPLAY || '';
    this.ownedDisplay = '';
  }

  /** 没有显示器时自己拉一个 Xvfb 虚拟屏 */
  async _ensureDisplay() {
    if (this.display || process.platform !== 'linux') return;
    const bin = hasXvfb();
    if (!bin) return;
    for (let n = 90; n < 120; n++) {
      if (fs.existsSync(`/tmp/.X11-unix/X${n}`)) continue;
      const p = spawn(bin, [`:${n}`, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], {
        stdio: 'ignore', detached: false,
      });
      // 等 socket 出现
      for (let i = 0; i < 40; i++) {
        await sleep(150);
        if (fs.existsSync(`/tmp/.X11-unix/X${n}`)) {
          this.xvfb = p;
          this.display = `:${n}`;
          this.ownedDisplay = `:${n}`;
          this.onProgress(`启动虚拟显示器 Xvfb ${this.display} (1440x900x24)`);
          return;
        }
        if (p.exitCode !== null) break;
      }
      try { p.kill(); } catch { /* noop */ }
    }
    throw new Error('无法启动 Xvfb 虚拟显示器');
  }

  async launch() {
    if (this.cdp) return this;
    await this._ensureDisplay();
    if (!this.display && process.platform === 'linux') this.headless = true;
    const exe = findBrowser();
    this.port = await freePort();
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hc-'));
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profile}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--window-size=1280,900',
      // 抹掉自动化特征，否则 hCaptcha 会直接判定为机器人
      '--disable-blink-features=AutomationControlled',
      '--disable-features=AutomationControlled,Translate,OptimizationHints',
      '--lang=ja-JP',
    ];
    if (this.headless) {
      args.push('--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        '--hide-scrollbars', '--mute-audio', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding');
    } else {
      args.push('--window-position=0,0', '--disable-dev-shm-usage');
    }
    // 浏览器整体走代理（如 VM 出口 IP 被 hCaptcha CDN 拉黑时换出口）
    if (this.proxy) args.push(`--proxy-server=${this.proxy}`);
    args.push('about:blank');
    const env = { ...process.env };
    if (this.display) env.DISPLAY = this.display;
    this.onProgress(`启动本机浏览器: ${path.basename(exe)} (port ${this.port}${this.headless ? ', headless' : `, display ${this.display || 'native'}`})`);
    this.proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true, env });

    let ver = null;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (r.ok) { ver = await r.json(); break; }
      } catch { /* 未就绪 */ }
      await sleep(500);
    }
    if (!ver?.webSocketDebuggerUrl) throw new Error('浏览器调试端口未就绪');
    this.cdp = await CDP.connect(ver.webSocketDebuggerUrl);
    const v = await this.cdp.call('Browser.getVersion');
    // 无头浏览器会被 hCaptcha 识别，这里把 UA 里的 Headless 抹掉
    this.userAgent = String(v?.userAgent || '').replace('HeadlessChrome', 'Chrome');
    this.onProgress(`浏览器 UA: ${this.userAgent}`);
    return this;
  }

  /**
   * 求解一次 hCaptcha（失败时换一个全新浏览器 profile 重试）
   * @param {string} sitekey
   * @param {string} pageUrl
   * @param {number} [timeoutMs]
   * @param {{ classify?: Function, retries?: number }} [opts]
   */
  async solveWithRetry(sitekey, pageUrl, timeoutMs = 150000, opts = {}) {
    const retries = opts.retries ?? 1;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          this.onProgress(`重试第 ${attempt} 次（换新浏览器 profile）…`);
          this.close();
          await this.launch();
        }
        return await this.solve(sitekey, pageUrl, timeoutMs, opts);
      } catch (e) {
        lastErr = e;
        this.onProgress(`第 ${attempt + 1} 次尝试失败: ${e.message}`);
      }
    }
    throw lastErr || new Error('验证码求解失败');
  }

  /**
   * 求解一次 hCaptcha
   * @param {string} sitekey
   * @param {string} pageUrl
   * @param {number} [timeoutMs]
   * @param {{ classify?: Function }} [opts]
   */
  async solve(sitekey, pageUrl, timeoutMs = 150000, opts = {}) {
    await this.launch();
    // 新开标签页并导航
    const created = await this.cdp.call('Target.createTarget', { url: 'about:blank' });
    const targetId = created?.targetId;
    const list = await fetch(`http://127.0.0.1:${this.port}/json/list`).then((r) => r.json()).catch(() => []);
    const target = list.find((t) => t.id === targetId) || list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!target) throw new Error('未找到浏览器页面 target');

    const page = await CDP.connect(target.webSocketDebuggerUrl);
    try {
      await page.call('Page.enable');
      await page.call('Runtime.enable');
      await page.call('DOM.enable').catch(() => { /* 忽略 */ });
      await page.call('Emulation.setUserAgentOverride', {
        userAgent: this.userAgent,
        acceptLanguage: 'ja-JP,ja;q=0.9',
        platform: 'Linux',
      }).catch(() => { /* 忽略 */ });
      // 抹掉 navigator.webdriver 之类的自动化痕迹
      await page.call('Page.addScriptToEvaluateOnNewDocument', {
        source: `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`,
      }).catch(() => { /* 忽略 */ });
      await page.call('Page.navigate', { url: pageUrl }, 60000).catch((e) => {
        this.onProgress(`导航告警: ${e.message}`);
      });

      const deadline0 = Date.now() + 45000;
      while (Date.now() < deadline0) {
        const r = await page.call('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        }).catch(() => null);
        if (/complete/.test(String(r?.result?.value || ''))) break;
        await sleep(400);
      }

      // 把页面内容清空，只留一个干净的 claude.ai 文档：
      //   - 避免 Anthropic 自己渲染的 hCaptcha 组件与我们的组件抢同一个 sitekey；
      //   - 但保留 origin（https://claude.ai），hCaptcha 的 host 校验才能通过。
      if (opts.isolate !== false) {
        try {
          const tree = await page.call('Page.getFrameTree');
          const frameId = tree?.frameTree?.frame?.id;
          if (frameId) {
            await page.call('Page.setDocumentContent', {
              frameId,
              html: '<!doctype html><html><head><title>hc</title></head><body></body></html>',
            });
            this.onProgress('已清空页面内容（保留 claude.ai origin）');
          }
        } catch (e) {
          this.onProgress(`清空页面告警: ${e.message}`);
        }
      }

      this.onProgress('页面已加载，注入验证码组件…');

      // 模拟一点真人操作痕迹（鼠标移动 / 滚轮），提高 hCaptcha 的风险评分
      await this._humanize(page).catch(() => { /* 非关键 */ });

      await page.call('Runtime.evaluate', {
        expression: injectScript(sitekey),
        awaitPromise: true,
        returnByValue: true,
      }).catch((e) => this.onProgress(`注入告警: ${e.message}`));

      // 图形题求解器（题目出现时才用得上）
      let solver = null;
      if (opts.classify) {
        const { HcaptchaChallengeSolver } = await import('./hcaptcha-challenge.mjs');
        solver = new HcaptchaChallengeSolver({
          page,
          browser: this.cdp,
          classify: opts.classify,
          onProgress: (m) => this.onProgress(m),
        });
      }

      const deadline = Date.now() + timeoutMs;
      /** 已处理过的挑战实例（挑战框被刷新时会产生新的实例） */
      const handled = new Set();
      while (Date.now() < deadline) {
        const r = await page.call('Runtime.evaluate', {
          expression: 'JSON.stringify({t: window.__hcToken, e: window.__hcError})',
          returnByValue: true,
        }).catch(() => null);
        const raw = r?.result?.value;
        if (raw) {
          const st = JSON.parse(raw);
          if (st.t) {
            this.onProgress('打码完成 ✅');
            return { token: st.t, userAgent: this.userAgent };
          }
          if (st.e) throw new Error(`验证码求解失败: ${st.e}`);
        }
        // 没拿到 token → 看看有没有待处理的图形题
        if (solver) {
          const cur = await solver._findChallengeSession().catch(() => null);
          const key = cur ? (cur.targetId || cur.frameId || 'frame') : null;
          if (key && !handled.has(key)) {
            handled.add(key);
            this.onProgress('检测到 hCaptcha 图形题，开始识别与点击…');
            const ok = await solver.handleChallenge().catch((e) => {
              this.onProgress(`图形题处理异常: ${e.message}`);
              return false;
            });
            if (ok) this.onProgress('图形题已通过 ✅');
          }
        }
        await sleep(800);
      }
      throw new Error('验证码求解超时');
    } finally {
      page.close();
      try { await this.cdp.call('Target.closeTarget', { targetId }); } catch { /* noop */ }
    }
  }

  /** 模拟真人操作痕迹（鼠标轨迹 + 滚轮），提高 hCaptcha 风险评分 */
  async _humanize(page) {
    const rand = (a, b) => a + Math.random() * (b - a);
    let x = rand(200, 900);
    let y = rand(200, 600);
    for (let i = 0; i < 6; i++) {
      const nx = rand(120, 1150);
      const ny = rand(120, 780);
      const steps = 6 + Math.floor(Math.random() * 8);
      for (let s = 1; s <= steps; s++) {
        await page.call('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(x + ((nx - x) * s) / steps),
          y: Math.round(y + ((ny - y) * s) / steps),
        }, 5000).catch(() => { /* noop */ });
      }
      x = nx; y = ny;
      await sleep(rand(120, 380));
    }
    await page.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: Math.round(rand(60, 180)),
    }, 5000).catch(() => { /* noop */ });
    await sleep(rand(300, 700));
  }

  /** 页面上是否出现了 hCaptcha **挑战框**（invisible 组件常驻的 checkbox 框不算） */  async _hasChallenge(page) {
    try {
      // 同进程 iframe：在页面 frame tree 里找
      const tree = await page.call('Page.getFrameTree');
      const all = [];
      const walk = (n) => {
        if (!n) return;
        all.push(n);
        for (const c of n.childFrames || []) walk(c);
      };
      walk(tree?.frameTree);
      if (all.some((f) => /frame=challenge/.test(f.url || ''))) return true;

      // OOPIF：独立 target
      const targets = await this.cdp.call('Target.getTargets').catch(() => null);
      return (targets?.targetInfos || []).some((t) => /frame=challenge/.test(t.url || ''));
    } catch {
      return false;
    }
  }

  close() {
    try { this.cdp?.close(); } catch { /* noop */ }
    try { this.proc?.kill(); } catch { /* noop */ }
    if (this.xvfb) {
      try { this.xvfb.kill(); } catch { /* noop */ }
      // 自己起的虚拟屏要一起回收，否则下一轮会指向一个已经死掉的 DISPLAY
      if (this.display && this.display === this.ownedDisplay) this.display = '';
    }
    this.cdp = null;
    this.proc = null;
    this.xvfb = null;
    this.ownedDisplay = '';
    if (this.profile) {
      const p = this.profile;
      setTimeout(() => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch { /* noop */ } }, 1500);
    }
  }
}

/**
 * 一次性求解（独立调用）
 * @param {{ sitekey: string, pageUrl: string, timeoutMs?: number, headless?: boolean, onProgress?: (m: string) => void }} opts
 */
export async function solveWithLocalBrowser(opts) {
  const b = new LocalCaptchaBrowser(opts);
  try {
    return await b.solve(opts.sitekey, opts.pageUrl, opts.timeoutMs);
  } finally {
    b.close();
  }
}

/* ───────────────────────── CLI ───────────────────────── */

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const sitekey = process.argv[2];
  const pageUrl = process.argv[3] || 'https://claude.ai/login';
  if (!sitekey) {
    console.error('用法: node tools/hcaptcha-local.mjs <sitekey> [pageUrl]');
    process.exit(1);
  }
  solveWithLocalBrowser({
    sitekey,
    pageUrl,
    onProgress: (m) => console.log('·', m),
  }).then((r) => {
    console.log('\n✅ token:', r.token.slice(0, 80), `(${r.token.length} 字符)`);
    console.log('   ua   :', r.userAgent);
  }).catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}

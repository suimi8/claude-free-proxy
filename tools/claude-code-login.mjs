#!/usr/bin/env node
// @ts-check
/**
 * Claude 账号登录/注册（浏览器辅助 + 验证码兑换，无需解魔法链接页的 hCaptcha）
 *
 * 流程：
 *   1. 真实 Chrome（Linux 无显示器时自动拉 Xvfb）打开 /login，填邮箱并提交 → 发送魔法链接
 *   2. 从临时邮箱取出魔法链接，解析 nonce / encoded_email_address
 *   3. 在页面内 POST /api/auth/exchange_nonce_for_code {nonce, encoded_email_address, source:"claude"}
 *      → { code: "123456" }        ← 该接口**不需要** client_attestation
 *   4. 把 6 位码填进登录页的 #code，点「メールアドレスを確認」提交
 *      → verify_magic_link 由页面自己发起，attestation 也由页面自己 mint
 *   5. 轮询 cookie 拿 sessionKey → 校验 /api/organizations → 可选写入反代账号池
 *
 * 用法：
 *   node tools/claude-code-login.mjs --email xxx@gayg.gay
 *   node tools/claude-code-login.mjs --email xxx@gayg.gay --pool
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 日志：每次运行写一个文件（logs/claude-login-<时间>-<邮箱>.log），方便回查卡点 */
const LOG_DIR = path.join(ROOT, 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
const RUN_ID = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
let logFile = '';
const writeLog = (line) => {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
};
const ts = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
const log = (m) => {
  const line = `[${ts()}] ${typeof m === 'string' ? m : JSON.stringify(m)}`;
  console.log(line);
  writeLog(line);
};
const setLogFile = (email) => {
  const tag = String(email || 'run').split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '') || 'run';
  logFile = path.join(LOG_DIR, `claude-login-${RUN_ID}-${tag}.log`);
  writeLog(`=== run start ${RUN_ID} | argv: ${process.argv.slice(2).map((a) => (/KEY|TOKEN|secret/i.test(a) ? a.slice(0, 12) + '…' : a)).join(' ')} | pid=${process.pid} ===`);
};
process.on('exit', (code) => writeLog(`=== exit code=${code} ${ts()} ===`));
process.on('uncaughtException', (e) => { writeLog(`[uncaughtException] ${e?.stack || e}`); console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { writeLog(`[unhandledRejection] ${e?.stack || e}`); console.error(e); process.exit(1); });

/* ────────────────────────────── 参数 ────────────────────────────── */

function parseArgs(argv) {
  const out = {
    email: '', base: 'https://claude.ai', proxyBase: 'http://127.0.0.1:8787',
    proxyKey: process.env.PROXY_API_KEY || '', pool: false, label: '', timeoutMs: 8 * 60 * 1000,
    attachPort: 0, sinceMinutes: 0, code: '', send: false, newTab: false, proto: false, link: false, page: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--email') out.email = next();
    else if (a === '--label') out.label = next();
    else if (a === '--base') out.base = next();
    else if (a === '--proxy-base') out.proxyBase = next();
    else if (a === '--proxy-key') out.proxyKey = next();
    else if (a === '--attach-port') out.attachPort = Number(next());
    else if (a === '--since') out.sinceMinutes = Number(next());
    else if (a === '--code') out.code = String(next() || '').trim();
    else if (a === '--send') out.send = true;
    else if (a === '--new-tab') out.newTab = true;
    else if (a === '--proto') out.proto = true;
    else if (a === '--link') out.link = true;
    else if (a === '--page') out.page = true;
    else if (a === '--browser-proxy') out.browserProxy = next();
    else if (a === '--pool') out.pool = true;
    else if (a === '--auto') out.auto = true;
    else if (a === '--timeout') out.timeoutMs = Number(next());
    else if (a === '-h' || a === '--help') {
      console.log(`
Claude 浏览器辅助登录（验证码兑换路径）

  node tools/claude-code-login.mjs --email <邮箱> [选项]

选项:
  --email <地址>       要登录的邮箱（与 --auto 二选一）
  --auto               从临时邮箱平台自动挑一个未使用邮箱
  --label <名称>       入池后的账号标签（默认用邮箱）
  --pool               登录成功后写入反代账号池
  --proxy-base <url>   反代地址，默认 http://127.0.0.1:8787
  --proxy-key <key>    反代 API Key（默认读 PROXY_API_KEY）
  --base <url>         claude.ai 地址，默认 https://claude.ai
  --attach-port <端口> 附加到已运行的 Chrome（默认跳过发信，复用已发链接）
  --new-tab            附加模式下新建标签页再操作（不影响原标签页）
  --send               附加模式下也重新发信（配合 --new-tab）
  --proto              纯协议发信：不点页面按钮，直接用 YesCaptcha send token
  --link               verify 免积分：收信后让浏览器直接打开魔法链接（页面自铸 attestation，不用打码积分）
  --page               完全零积分：页面自己发信+自铸 attestation，全程不调用打码 API
  --browser-proxy <u>  浏览器整体走代理（如 --proxy-server），用于绕过 VM 出口被 hCaptcha CDN 拉黑
  --since <分钟>       邮件搜索回溯分钟数（附加模式默认 20，发信时默认 0）
  --code <6 位码>      已知验证码时直接使用，跳过收信与兑换
  --timeout <毫秒>     整体超时，默认 8 分钟
`);
      process.exit(0);
    }
  }
  return out;
}

/* ────────────────────────────── CDP ────────────────────────────── */

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      let seq = 0;
      const pending = new Map();
      const events = [];
      ws.addEventListener('message', (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && pending.has(m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          clearTimeout(p.timer);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
          return;
        }
        if (m.method) {
          events.push(m);
          if (events.length > 500) events.shift();
        }
      });
      const call = (method, params = {}, timeoutMs = 60000, sessionId = undefined) => new Promise((res, rej) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`CDP 超时: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve: res, reject: rej, timer });
        try {
          ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        }
        catch (e) { clearTimeout(timer); pending.delete(id); rej(e); }
      });
      resolve({
        call, events,
        get closed() { return ws.readyState !== 1; },
        close() { try { ws.close(); } catch { /* noop */ } },
      });
    }, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });
}

async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  return r.json();
}

/* ────────────────────────────── 配置 ────────────────────────────── */

function loadMailConfig() {
  let token = process.env.MAOMAIL_TOKEN || '';
  let baseUrl = process.env.MAOMAIL_BASE_URL || 'https://zjkdongao.cn';
  if (!token) {
    try {
      const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
      const m = txt.match(/MAOMAIL_TOKEN='?([^'\n]+)'?/); if (m) token = m[1];
      const b = txt.match(/MAOMAIL_BASE_URL='?([^'\n]+)'?/); if (b) baseUrl = b[1];
    } catch { /* ignore */ }
  }
  return { token, baseUrl };
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

const args = parseArgs(process.argv.slice(2));
if (!args.email && !args.auto) { console.log('缺少 --email（或加 --auto 自动挑邮箱）'); process.exit(1); }
setLogFile(args.email);
log(`主机: ${os?.hostname?.() || ''} node=${process.version}`);

const { LocalCaptchaBrowser } = await import(path.join(ROOT, 'tools/hcaptcha-local.mjs'));
const { MaoMailClient } = await import(path.join(ROOT, 'plugins/maomail-auto-login/maomail.mjs'));
const { decodePng, solveDrag, solveIcons } = await import(path.join(ROOT, 'tools/hcaptcha-canvas-solvers.mjs'));

const mailCfg = loadMailConfig();
if (!mailCfg.token) { console.log('缺少 MAOMAIL_TOKEN'); process.exit(1); }
const mail = new MaoMailClient({ token: mailCfg.token, baseUrl: mailCfg.baseUrl });

const attached = Boolean(args.attachPort);

let browser;
if (attached) {
  log(`\n[0/6] 附加到已有浏览器 (端口 ${args.attachPort})${args.send ? '，将新建标签页重新发信' : '，跳过发信'}`);
  browser = { port: Number(args.attachPort), userAgent: '', close() { /* 保持浏览器运行 */ } };
} else {
  browser = new LocalCaptchaBrowser({ onProgress: (m) => log('  · ' + m), proxy: args.browserProxy || '' });
  await browser.launch();
}
process.on('exit', () => { try { browser.close(); } catch { /* ignore */ } });

let created = null;
if (attached && args.newTab) {
  const r = await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`新建标签页失败: HTTP ${r.status}`);
  const info = await r.json();
  created = { targetId: info.id };
  log('  · 已新建标签页 ' + String(info.id).slice(0, 8));
}
if (!attached) created = await browser.cdp.call('Target.createTarget', { url: 'about:blank' });
let tab = null;
let tabId = created ? created.targetId : '';

async function attach() {
  const list = await listTargets(browser.port);
  const info = (tabId && list.find((t) => t.id === tabId))
    || list.find((t) => t.type === 'page' && /claude\.ai/.test(t.url || ''))
    || list.find((t) => t.type === 'page');
  if (!info?.webSocketDebuggerUrl) throw new Error('找不到页面 target');
  tabId = info.id;
  const t = await connect(info.webSocketDebuggerUrl);
  await t.call('Page.enable').catch(() => {});
  await t.call('Runtime.enable').catch(() => {});
  await t.call('Network.enable').catch(() => {});
  if (browser.userAgent) {
    await t.call('Emulation.setUserAgentOverride', {
      userAgent: browser.userAgent, acceptLanguage: 'ja-JP,ja;q=0.9', platform: 'Linux',
    }).catch(() => {});
  }
  tab = t;
  return t;
}

/** 带一次自动重连的页面求值 */
async function evalPage(expression, { timeoutMs = 60000, awaitPromise = true } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!tab || tab.closed) await attach();
      const r = await tab.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, timeoutMs);
      if (r?.exceptionDetails) {
        return { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300) };
      }
      return r?.result?.value;
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(500);
      await attach().catch(() => {});
    }
  }
  return undefined;
}

await attach();
if (attached && !browser.userAgent) {
  browser.userAgent = String(await evalPage('navigator.userAgent').catch(() => '') || '');
  log('  · UA: ' + browser.userAgent);
}

/* 浏览器级 CDP（枚举 OOPIF 挑战 target 用） */
let browserCdp = browser.cdp || null;
if (!browserCdp) {
  const ver = await (await fetch(`http://127.0.0.1:${browser.port}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
  browserCdp = await connect(ver.webSocketDebuggerUrl);
}

/* ──────────── canvas 挑战本地求解基建（0 积分，源自 probe-drag.mjs 已验证链路） ────────────
 * hCaptcha 图形题在 OOPIF（frame=challenge）里：浏览器级 attachToTarget 拿 sessionId，
 * 在 frame 里 eval 抓 canvas 位图 → 本地解数数题/拖拽题 → 浏览器级 Input 派发点击/拖拽。 */
async function attachChallenge() {
  const tg = await browserCdp.call('Target.getTargets', {}, 10000).catch(() => null);
  const t = (tg?.targetInfos || []).filter((x) => /frame=challenge/.test(x.url || ''))
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
  if (!t) return null;
  const a2 = await browserCdp.call('Target.attachToTarget', { targetId: t.targetId, flatten: true }, 15000).catch(() => null);
  return a2?.sessionId ? { targetId: t.targetId, sid: a2.sessionId } : null;
}
const evalIn = async (sid, expr) => {
  const r = await browserCdp.call('Runtime.evaluate', { expression: expr, returnByValue: true }, 30000, sid).catch(() => null);
  return r?.result?.value ?? null;
};
const grabCanvas = (sid) => evalIn(sid, `(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  let data = '';
  try { data = c.toDataURL('image/png'); } catch (e) { return JSON.stringify({ tainted: true }); }
  return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height, data: data.slice(0, 6_000_000) });
})()`);
/** 挑战 iframe 在主页面里的偏移（页面坐标 = iframe 原点 + frame 内坐标） */
const iframeOrigin = async () => {
  const s = await evalPage(`(() => {
    const f = Array.from(document.querySelectorAll('iframe'))
      .filter(x => (x.src || '').includes('frame=challenge'))
      .map(x => x.getBoundingClientRect())
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return f ? JSON.stringify({ x: f.left, y: f.top }) : null;
  })()`).catch(() => null);
  try { return JSON.parse(String(s)) || { x: 0, y: 0 }; } catch { return { x: 0, y: 0 }; }
};
const clickAt = async (x, y) => {
  await browserCdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(200);
  await browserCdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(120);
  await browserCdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
};
const submitChallenge = async (sid, io) => {
  const sinfo = await evalIn(sid, `(() => {
    const s = document.querySelector('.button-submit');
    if (!s || !s.offsetWidth) return null;
    const r = s.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: s.disabled || s.getAttribute('aria-disabled') === 'true' });
  })()`);
  if (!sinfo) { log('    无提交按钮'); return; }
  const s = JSON.parse(sinfo);
  if (s.disabled) { log('    提交按钮禁用（选择数不符？）'); return; }
  await clickAt(io.x + s.x, io.y + s.y);
  log(`    已点提交 (${io.x + s.x | 0},${io.y + s.y | 0})`);
};
const clickSkip = async (sid) => {
  const sinfo = await evalIn(sid, `(() => {
    let s = document.querySelector('.button-skip') || Array.from(document.querySelectorAll('button, .button')).find((b2) => /スキップ|skip/i.test(b2.textContent || ''));
    if (!s || !s.offsetWidth) return null;
    const r = s.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`);
  if (!sinfo) { log('    无スキップ按钮，等 5s'); await sleep(5000); return; }
  const s = JSON.parse(sinfo);
  const io = await iframeOrigin();
  await clickAt(io.x + s.x, io.y + s.y);
  log(`    已点スキップ (${io.x + s.x | 0},${io.y + s.y | 0})，等新题`);
  await sleep(4000);
};
const drag = async (x0, y0, x1, y1) => {
  await browserCdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, buttons: 0 });
  await sleep(300);
  await browserCdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(250);
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await browserCdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, button: 'left', buttons: 1 });
    await sleep(30 + Math.random() * 40);
  }
  await sleep(350);
  await browserCdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 0 });
};

/* 打码器：只在真的出现可见图形题时才动手 */
const envFile = (() => {
  try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return ''; }
})();
const yesKey = process.env.YESCAPTCHA_CLIENT_KEY
  || (envFile.match(/YESCAPTCHA_CLIENT_KEY='?([^'\n]+)'?/) || [])[1] || '';
let yesCaptcha = null;
let challengeSolver = null;
if (yesKey) {
  const { YesCaptcha } = await import(path.join(ROOT, 'tools/yescaptcha.mjs'));
  const { HcaptchaChallengeSolver } = await import(path.join(ROOT, 'tools/hcaptcha-challenge.mjs'));
  yesCaptcha = new YesCaptcha({ clientKey: yesKey });
  challengeSolver = HcaptchaChallengeSolver;
} else {
  log('  ⚠️ 未配置 YESCAPTCHA_CLIENT_KEY：canvas 数数/拖拽题仍可本地 0 积分求解，DOM 语义题将 スキップ 换题');
}

const solvedTargets = new Set();

async function challengeState() {
  const r = await tab.call('Runtime.evaluate', {
    expression: `(() => {
      const f = Array.from(document.querySelectorAll('iframe'))
        .filter(x => (x.src || '').includes('frame=challenge'))
        .map(x => ({ rc: x.getBoundingClientRect() }))
        .sort((a, b) => (b.rc.width * b.rc.height) - (a.rc.width * a.rc.height))[0];
      if (!f) return 'none';
      const t = (document.body ? document.body.innerText : '');
      if (/Please try again|无法验证您的浏览器|Unable to verify your browser|ブラウザを確認できませんでした|確認できません/i.test(t)) return 'error';
      if (f.rc.width < 200 || f.rc.height < 200) return 'small';
      if (f.rc.top < -1000 || f.rc.left < -1000) return 'offscreen';
      return 'visible';
    })()`,
    returnByValue: true,
  }, 8000).catch(() => null);
  return String(r?.result?.value || 'none');
}

/** 出现可见图形题就解一次；返回 none / visible / solved / failed / handled
 *  策略：canvas 数数题/拖拽题本地求解（0 积分，失败免费スキップ换题）；
 *  DOM 语义题本地无解 → 有 YesCaptcha key 才打码。 */
let lastIconPlanKey = '';
async function solveIfVisible() {
  const st = await challengeState();
  if (st !== 'visible') return st;
  const ch = await attachChallenge();
  if (!ch) return 'visible';

  await sleep(2500); // 题面渲染
  const cinfo = await grabCanvas(ch.sid);
  if (cinfo) {
    let ci = null;
    try { ci = JSON.parse(cinfo); } catch { /* noop */ }
    if (ci?.tainted) {
      log('  · [验证码] canvas 被污染，无法读取像素');
    } else if (ci?.data) {
      const img = decodePng(Buffer.from(String(ci.data).split(',')[1], 'base64'));
      const io = await iframeOrigin();
      const dpr = img.W / ci.w;
      const ts = Date.now();

      // 分支 1：数数题（胶囊 → 网格点选）
      const icons = solveIcons(img, (m) => log('    ' + m));
      if (!icons.error && icons.plan.length) {
        const planKey = icons.plan.map((p) => `${p.x | 0},${p.y | 0}`).join(';');
        log(`  · [验证码] 数数题 ${icons.plan.length} 次点击（${Date.now() - ts}ms）`);
        if (planKey === lastIconPlanKey) {
          log('    计划与上轮相同（挑战未刷新）→ スキップ换题');
          lastIconPlanKey = '';
          await clickSkip(ch.sid);
          return 'handled';
        }
        lastIconPlanKey = planKey;
        for (const p of icons.plan) {
          const px = io.x + ci.x + p.x / dpr, py = io.y + ci.y + p.y / dpr;
          log(`    点 (${px | 0},${py | 0}) 置信 ${(p.score * 100) | 0}%`);
          await clickAt(px, py);
          await sleep(700);
        }
        await submitChallenge(ch.sid, io);
        return 'solved';
      }

      // 分支 2：拖拽题
      const sol = solveDrag(img);
      if (!sol.error) {
        log(`  · [验证码] 拖拽题 命中 ${(sol.score * 100) | 0}%（${Date.now() - ts}ms）`);
        const sx0 = io.x + ci.x + sol.fx / dpr, sy0 = io.y + ci.y + sol.fy / dpr;
        const sx1 = io.x + ci.x + sol.tx / dpr, sy1 = io.y + ci.y + sol.ty / dpr;
        log(`    拖拽(页面) (${sx0 | 0},${sy0 | 0}) → (${sx1 | 0},${sy1 | 0})  dpr=${dpr}`);
        await drag(sx0, sy0, sx1, sy1);
        return 'solved';
      }

      // 分支 3：两个本地求解器都不认 → 免费换题
      log(`  · [验证码] 本地求解失败（icons=${icons.error} drag=${sol.error}）→ スキップ换题`);
      await clickSkip(ch.sid);
      return 'handled';
    }
  }

  // 无 canvas：DOM 语义题 → YesCaptcha 兜底（仅当配置了 key）
  if (!challengeSolver) {
    log('  · [验证码] DOM 语义题且未配置 YESCAPTCHA_CLIENT_KEY → スキップ换题');
    await clickSkip(ch.sid);
    return 'handled';
  }
  const t = await browserCdp.call('Target.getTargets', {}, 8000).catch(() => null);
  const hit = (t?.targetInfos || []).find((x) => /frame=challenge/.test(x.url || ''));
  if (!hit) return 'visible';
  if (solvedTargets.has(hit.targetId)) return 'handled';
  solvedTargets.add(hit.targetId);
  log('  · [验证码] DOM 语义题，YesCaptcha 识别与点击…');
  const solver = new challengeSolver({
    page: tab,
    browser: browserCdp,
    classify: ({ question, queries, anchors }) => yesCaptcha.classifyHCaptcha({ question, queries, anchors }),
    onProgress: (m) => log(`  · [验证码] ${m}`),
  });
  const ok = await solver.handleChallenge(6).catch((e) => {
    log(`  · [验证码] 处理失败: ${e.message}`);
    return false;
  });
  if (!ok) solvedTargets.delete(hit.targetId); // 失败时允许下一轮重试同一目标
  log(`  · [验证码] ${ok ? '已提交' : '未完成'}`);
  return ok ? 'solved' : 'failed';
}

/** 真实鼠标点击可见的「メールアドレスを確認」按钮 */
async function clickContinue() {
  const raw = await evalPage(`(() => {
    const b = Array.from(document.querySelectorAll('button[data-testid="continue"]'))
      .find((x) => x.offsetWidth && x.offsetHeight && !x.disabled);
    if (!b) return 'no-btn';
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, text: (b.innerText || '').trim().slice(0, 16) });
  })()`);
  let rc = null;
  try { rc = JSON.parse(String(raw)); } catch { return String(raw); }
  if (!rc) return 'bad-rect';
  const x = Math.round(rc.x);
  const y = Math.round(rc.y);
  await tab.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }).catch(() => {});
  await sleep(120 + Math.random() * 160);
  await tab.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }).catch(() => {});
  await sleep(70 + Math.random() * 80);
  await tab.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 }).catch(() => {});
  return 'clicked:' + rc.text;
}

const sinceMs = args.sinceMinutes > 0
  ? args.sinceMinutes * 60000
  : (attached && !args.send ? 20 * 60000 : 5000);
const t0 = Date.now() - sinceMs;

if (!attached || args.send) {
/* 1. 打开登录页 */
log('\n[1/6] 打开登录页');
await tab.call('Page.navigate', { url: `${args.base}/login` }, 90000).catch(() => {});
let ready = false;
for (let i = 0; i < 150; i++) {
  await sleep(1000);
  if ((await evalPage(`!!document.querySelector('input#email')`).catch(() => false)) === true) { ready = true; break; }
  if (i % 15 === 14) {
    const st = await evalPage(`JSON.stringify({
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 160),
    })`).catch(() => '');
    log('  · 等待中: ' + String(st).slice(0, 240));
  }
}
if (!ready) throw new Error('登录页 150s 内未就绪');
log('  ✓ 页面就绪');

/* 2. 填邮箱并提交 */
log('\n[2/6] 提交邮箱');
let submitted = false;
if (args.proto) {
  const st = await evalPage(`(() => {
    const c = document.querySelector('[data-testid="consent-accept"]');
    if (c && c.offsetWidth && c.offsetHeight) c.click();
    const input = document.querySelector('input#email');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(args.email)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'filled';
  })()`);
  submitted = st === 'filled';
  log('  ✓ 已填邮箱（协议发信模式，不点页面按钮）');
} else {
  for (let i = 0; i < 40; i++) {
    const st = await evalPage(`(() => {
      const c = document.querySelector('[data-testid="consent-accept"]');
      if (c && c.offsetWidth && c.offsetHeight) c.click();
      const input = document.querySelector('input#email');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(args.email)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const btn = Array.from(document.querySelectorAll('button[data-testid="continue"]'))
        .find((b) => b.offsetWidth && b.offsetHeight && !b.disabled);
      if (btn) { btn.click(); return 'clicked:' + (btn.innerText || '').trim().slice(0, 16); }
      return 'filled';
    })()`);
    if (typeof st === 'string' && st.startsWith('clicked')) { submitted = true; break; }
    await sleep(800);
  }
  if (!submitted) throw new Error('无法提交邮箱');
  log('  ✓ 已提交');
}
} else {
  log('\n[1-2/6] 跳过（复用已有会话）');
  if (args.newTab) {
    log('  · 在新标签页打开登录页以建立同源上下文');
    await tab.call('Page.navigate', { url: `${args.base}/login` }, 90000).catch(() => {});
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      if ((await evalPage(`!!document.querySelector('input#email')`).catch(() => false)) === true) break;
    }
  }
}

/** 在页面里发任意 /api/auth/* 请求 */
async function pageFetch(pathname, body, method = 'POST') {
  const bodyExpr = body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body));
  const raw = await evalPage(`(async () => {
    const r = await fetch(${JSON.stringify(pathname)}, {
      method: ${JSON.stringify(method)}, credentials: 'include',
      headers: { 'content-type': 'application/json', 'anthropic-client-build': '1794807535' },
      body: ${bodyExpr},
      signal: AbortSignal.timeout(60000),
    });
    return JSON.stringify({ status: r.status, text: (await r.text()).slice(0, 700) });
  })()`, { timeoutMs: 90000 });
  try { return JSON.parse(String(raw)); } catch { return { status: 0, text: String(raw) }; }
}

const SEND_SITEKEY = 'f1b21a9c-9100-4022-a928-8d5c29de2e6a';

/** 协议发信：login_methods → YesCaptcha send token → send_magic_link */
async function protocolSend(email) {
  const lm = await pageFetch(`/api/auth/login_methods?email=${encodeURIComponent(email)}&source=claude-ai`, undefined, 'GET');
  log(`    login_methods → ${lm.status} ${String(lm.text).slice(0, 140)}`);

  let sendToken = '';
  try {
    const sol = await yesCaptcha.solveHCaptcha({
      websiteURL: `${args.base}/login`,
      websiteKey: SEND_SITEKEY,
      isInvisible: true,
      userAgent: browser.userAgent || undefined,
    });
    sendToken = sol?.token || sol?.gRecaptchaResponse || sol?.solution?.gRecaptchaResponse || '';
  } catch (e) {
    log('    · send hCaptcha 求解失败: ' + String(e.message || e).slice(0, 140));
  }
  if (!sendToken) return { status: 0, text: 'no-token' };

  log(`    · send token=${sendToken.slice(0, 16)}… (${sendToken.length} 字符)`);
  const sent = await pageFetch('/api/auth/send_magic_link', {
    utc_offset: -540,
    email_address: email,
    login_intent: null,
    locale: 'ja-JP',
    return_to: null,
    source: 'claude',
    client_attestation: { hcaptcha_token: sendToken },
  });
  log(`    send_magic_link → ${sent.status} ${String(sent.text).slice(0, 220)}`);
  return sent;
}

/* 2b. 页面没推进（没有 #code）时，用 YesCaptcha token 直接发信 */
if (!args.code && !args.page && (!attached || args.send) && yesCaptcha) {
  let advanced = false;
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    if (await evalPage(`!!document.querySelector('input#code')`).catch(() => false)) { advanced = true; break; }
  }
  if (advanced) {
    log('  · 页面已进入验证码视图，跳过协议发信');
  } else {
    log('  · 页面未推进，改用协议发信（YesCaptcha send token）');
    await protocolSend(args.email);
  }
}

/* 3. 等验证码输入框 + 提交按钮 */
log('\n[3/6] 等待验证码输入框');
let viewReady = false;
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  const st = await evalPage(`(() => {
    const pick = () => {
      const all = Array.from(document.querySelectorAll('button[data-testid="continue"]'));
      return all.find((b) => b.offsetWidth && b.offsetHeight) || null;
    };
    const input = document.querySelector('input#code');
    const btn = pick();
    return JSON.stringify({
      input: !!input,
      btn: !!btn,
      disabled: btn ? !!btn.disabled : true,
      text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 200),
    });
  })()`).catch(() => '');
  let s = {};
  try { s = JSON.parse(String(st)); } catch { /* ignore */ }
  if (s.input && s.btn && !s.disabled) { viewReady = true; break; }
  // 限流 / 拦截类错误：直接失败，别空等
  const text = String(s.text || '');
  if (/試行回数が多すぎ|試行回数が多|too_many_attempts|しばらくしてから再度お試し/.test(text)) {
    throw new Error('该邮箱/IP 触发了登录限流（ログイン試行回数が多すぎます），需要等待冷却或换邮箱');
  }
  if (/レート制限|rate_limit|リクエストが多すぎ/.test(text)) {
    throw new Error('触发了速率限制（rate_limit），需要等待冷却');
  }
  if (/无法验证您的浏览器|Unable to verify your browser|ブラウザを確認できませんでした/.test(text)) {
    log('  ⚠️ 检测到「无法验证您的浏览器」，正在尝试重新点击提交…');
    await clickContinue().catch(() => {});
    await sleep(2500);
  }
  if (/利用できないアカウント|アカウントが停止|sign_in_not_permitted/.test(text)) {
    throw new Error('该账号被风控拦截（sign_in_not_permitted）');
  }
}
if (!viewReady) {
  // 纯协议路径（YesCaptcha token）不依赖验证码输入框，只要在 claude.ai 页面内发请求即可
  if (yesCaptcha && !args.code) {
    log('  · 未出现验证码输入框，但已启用协议校验，继续执行');
  } else {
    throw new Error('验证码页面未就绪');
  }
} else {
  log('  ✓ 验证码输入框与提交按钮已就绪');
}

/* 4. 取邮件：只要 nonce + encoded_email_address（验证码兜底时才兑换） */
let nonce = '';
let enc = '';
let magicLinkUrl = '';
const KNOWN_SITEKEY = 'a8086506-2036-46f4-ae50-00d8be805efa';

log('\n[4/6] 读取登录邮件');
if (args.code) {
  log(`  · 已指定验证码 code=${args.code}，跳过收信`);
} else {
  const detail = await mail.waitForVerification({
    email: args.email,
    sinceTimestamp: t0,
    timeoutMs: Math.min(args.timeoutMs, 4 * 60 * 1000),
    onProgress: (m) => log('  · ' + m),
  });
  magicLinkUrl = String(detail?.magicLink || '');
  [nonce, enc] = magicLinkUrl.split('#')[1]?.split(':') || [];
  if (!nonce || !enc) throw new Error('魔法链接解析失败');
  log(`  · nonce=${nonce.slice(0, 8)}…  enc.len=${enc.length}`);
}

/** 在页面里 POST /api/auth/verify_magic_link */
async function postVerify(body) {
  const raw = await evalPage(`(async () => {
    const r = await fetch('/api/auth/verify_magic_link', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'anthropic-client-build': '1794807535' },
      body: JSON.stringify(${JSON.stringify(body)}),
    });
    return JSON.stringify({ status: r.status, text: (await r.text()).slice(0, 700) });
  })()`, { timeoutMs: 120000 });
  try { return JSON.parse(String(raw)); } catch { return { status: 0, text: String(raw) }; }
}

/** 当前页面 challenge iframe 的 sitekey（取不到就用已知值） */
async function pageSitekey() {
  const raw = await evalPage(`(() => {
    const srcs = Array.from(document.querySelectorAll('iframe')).map((f) => f.src || '');
    for (const s of srcs) {
      const m = s.match(/[?&]sitekey=([a-f0-9-]{30,40})/i);
      if (m) return m[1];
    }
    const el = document.querySelector('[data-sitekey]');
    if (el) return el.getAttribute('data-sitekey') || '';
    const m2 = document.documentElement.innerHTML.match(/sitekey[^a-f0-9]{1,6}([a-f0-9-]{30,40})/i);
    return m2 ? m2[1] : '';
  })()`).catch(() => '');
  const s = String(raw || '').trim();
  return /^[a-f0-9-]{30,40}$/i.test(s) ? s : KNOWN_SITEKEY;
}

/** 真实鼠标点击「再送信する」 */
async function clickResend() {
  const raw = await evalPage(`(() => {
    const b = Array.from(document.querySelectorAll('button, a'))
      .find((x) => x.offsetWidth && x.offsetHeight && !x.disabled && /再送信|再送|resend/i.test(x.innerText || ''));
    if (!b) return 'no-btn';
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, text: (b.innerText || '').trim().slice(0, 16) });
  })()`);
  let rc = null;
  try { rc = JSON.parse(String(raw)); } catch { return String(raw); }
  if (!rc) return 'bad-rect';
  const x = Math.round(rc.x);
  const y = Math.round(rc.y);
  await tab.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }).catch(() => {});
  await sleep(120 + Math.random() * 160);
  await tab.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }).catch(() => {});
  await sleep(70 + Math.random() * 80);
  await tab.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 }).catch(() => {});
  return 'clicked:' + rc.text;
}

let verifyOk = false;
let lastErr = '';
let tokenUnavailable = false;
let resentOnce = false;

/* 5-Link. 浏览器直接打开魔法链接：页面自铸 attestation 完成校验（0 打码积分） */
if (args.link && magicLinkUrl) {
  log('\n[5/6] 浏览器打开魔法链接（页面自铸 attestation，0 积分）');
  await tab.call('Page.navigate', { url: magicLinkUrl }, 90000).catch((e) => log('  · 导航失败: ' + (e.message || e)));
  const until = Date.now() + 120000;
  let seen = false;
  while (Date.now() < until && !verifyOk) {
    await sleep(3000);
    await solveIfVisible().catch(() => {});
    const vr = tab.events.filter((e) => e.method === 'Network.requestWillBeSent' && /verify_magic_link/.test(e.params.request.url)).pop();
    if (vr && !seen) {
      seen = true;
      log('  → 页面已发出 verify_magic_link，等待响应…');
      const outcome = await verifyOutcome(vr).catch(() => null);
      log(`  ← HTTP ${outcome?.status ?? '?'}: ${String(outcome?.text || '').slice(0, 220)}`);
      lastErr = String(outcome?.text || lastErr || '');
      if (outcome?.status === 200 && /["']success["']\s*:\s*true/.test(String(outcome.text || ''))) verifyOk = true;
      break;
    }
  }
  if (!seen && !verifyOk) log('  · ⚠️ 120s 内未见 verify_magic_link 请求（可能有可见挑战，交由 [6/6] 循环继续）');
  if (verifyOk) log('  ✓ 链接校验通过');
}

/* 5a. 纯协议：YesCaptcha 出 hCaptcha token，直接兑现 nonce（不需要页面解题） */
if (!args.code && !args.page && !args.link && yesCaptcha) {
  log('\n[5/6] 协议校验（YesCaptcha hCaptcha token）');
  for (let attempt = 1; attempt <= 3 && !verifyOk && nonce; attempt++) {
    const sitekey = await pageSitekey();
    log(`  · 第 ${attempt} 次：sitekey=${sitekey}`);

    let token = '';
    try {
      const sol = await yesCaptcha.solveHCaptcha({
        websiteURL: `${args.base}/login`,
        websiteKey: sitekey,
        isInvisible: true,
        userAgent: browser.userAgent || undefined,
      });
      token = sol?.token || sol?.gRecaptchaResponse || sol?.solution?.gRecaptchaResponse || '';
    } catch (e) {
      tokenUnavailable = true;
      log('    · hCaptcha 求解失败: ' + String(e.message || e).slice(0, 140));
      break;
    }
    if (!token) { tokenUnavailable = true; log('    · 没拿到 hCaptcha token'); break; }
    log(`    · token=${String(token).slice(0, 18)}… (${String(token).length} 字符)`);

    const r = await postVerify({
      credentials: { method: 'nonce', nonce, encoded_email_address: enc },
      locale: 'ja-JP',
      client_attestation: { hcaptcha_token: token },
      source: 'claude',
    });
    log(`    ← HTTP ${r.status}: ${String(r.text || '').slice(0, 220)}`);

    if (r.status === 200 && /["']success["']\s*:\s*true/.test(String(r.text || ''))) { verifyOk = true; break; }
    lastErr = String(r.text || `HTTP ${r.status}`);

    // 邮箱被风控标记 → 该邮箱已废，立即放弃（重试只会白烧积分）
    if (/sign_in_not_permitted/.test(lastErr)) {
      log('    · ✋ sign_in_not_permitted：该邮箱/账号被风控标记，放弃此邮箱（不重试、不重发，省积分）');
      break;
    }
    // 链接过期/已用 → 协议重发一封新邮件，换新 nonce 再来（最多重发 1 次）
    if (/login_link_expired|login_link_already_used/.test(lastErr)) {
      if (resentOnce) { log('    · 已重发过 1 次，不再重发'); break; }
      resentOnce = true;
      log('    · 链接失效，协议重发登录邮件（第 1/1 次）');
      const sent = await protocolSend(args.email).catch((e) => ({ status: 0, text: String(e.message || e) }));
      if (!(sent.status === 200 && /"sent"\s*:\s*true/.test(String(sent.text || '')))) {
        log('      · 重发失败，停止重试');
        break;
      }
      try {
        const fresh = await mail.waitForVerification({
          email: args.email,
          sinceTimestamp: Date.now() - 15000,
          timeoutMs: Math.min(args.timeoutMs, 3 * 60 * 1000),
          onProgress: (m) => log('      · ' + m),
        });
        [nonce, enc] = String(fresh?.magicLink || '').split('#')[1]?.split(':') || [];
        if (!nonce || !enc) { log('      · 新邮件解析失败'); break; }
        log(`      · 新 nonce=${nonce.slice(0, 8)}…  enc.len=${enc.length}`);
        continue;
      } catch (e) {
        log('      · 等新邮件失败: ' + String(e.message || e).slice(0, 120));
        break;
      }
    }
    // 任何其他失败（含 token 被拒）→ 立即停止，不重解 token（积分硬上限）
    log('    · 校验失败，按积分硬上限策略停止重试');
    break;
  }
  log(verifyOk ? '  ✓ 协议校验通过' : `  ⚠️ 协议校验未成功: ${lastErr.slice(0, 180)}`);
}

/* 5b. 页面兜底：兑换验证码 → 填码 → 真实点击（需要页面自 mint attestation） */
const fillCode = async (code) => evalPage(`(() => {
  const input = document.querySelector('input#code');
  if (!input) return 'no-input';
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(code)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  return 'ok:' + input.value;
})()`);

async function verifyOutcome(vr) {
  if (!vr) return { status: 0, text: '' };
  for (let i = 0; i < 40; i++) {
    const rr = tab.events.find((e) => e.method === 'Network.responseReceived' && e.params.requestId === vr.params.requestId);
    if (rr) {
      const body = await tab.call('Network.getResponseBody', { requestId: vr.params.requestId }, 15000).catch(() => null);
      return { status: rr.params.response.status, text: String(body?.body || '') };
    }
    await sleep(500);
  }
  return { status: 0, text: '' };
}

if (!verifyOk) {
  let code = args.code || '';
  const linkDead = /login_link_expired|login_link_already_used/.test(lastErr);

  if (!code && (linkDead || tokenUnavailable)) {
    log('  ⚠️ 链接已失效或打码平台不可用，跳过页面兜底（保留链接供稍后重试）');
  } else {
    log('\n[5b/6] 页面兜底：兑换验证码 + 真实点击');
    if (!code) {
      for (let attempt = 1; attempt <= 3 && !code; attempt++) {
        const raw = await evalPage(`(async () => {
          const r = await fetch('/api/auth/exchange_nonce_for_code', {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              nonce: ${JSON.stringify(nonce)},
              encoded_email_address: ${JSON.stringify(enc)},
              source: 'claude',
            }),
          });
          return JSON.stringify({ status: r.status, text: await r.text() });
        })()`, { timeoutMs: 120000 });
        let parsed = {};
        try { parsed = JSON.parse(String(raw)); } catch { /* ignore */ }
        if (parsed.status === 200) {
          try { code = JSON.parse(parsed.text).code || ''; } catch { /* ignore */ }
        } else {
          log(`  · 兑换失败 (${parsed.status || raw}): ${String(parsed.text || '').slice(0, 160)}`);
        }
        if (!code) await sleep(2000);
      }
    }
    if (!code) log('  ⚠️ 没有拿到验证码');
    else {
      log(`  ✓ code=${code}`);
      for (let attempt = 1; attempt <= 3 && !verifyOk; attempt++) {
        const before = tab.events.filter((e) => e.method === 'Network.requestWillBeSent' && /verify_magic_link/.test(e.params.request.url)).length;

        log(`  · 第 ${attempt} 次提交`);
        log('    ' + await fillCode(code));

        const clicked = await clickContinue();
        log('    ' + clicked);
        if (!String(clicked).startsWith('clicked')) { await sleep(1500); continue; }

        // 一边等请求发出，一边解图形题（mint 会在这里被页面触发）
        const until = Date.now() + 30000;
        let vr = null;
        while (Date.now() < until) {
          await sleep(1200);
          const now = tab.events.filter((e) => e.method === 'Network.requestWillBeSent' && /verify_magic_link/.test(e.params.request.url));
          if (now.length > before) { vr = now.pop(); break; }
          const st = await solveIfVisible();
          if (st === 'solved' || st === 'failed') await sleep(1500);
        }

        if (!vr) { log('    · 没等到 verify_magic_link 请求'); continue; }

        log('    → ' + String(vr.params.request.postData || '').slice(0, 300));
        const outcome = await verifyOutcome(vr);
        log(`    ← HTTP ${outcome.status}: ${outcome.text.slice(0, 260)}`);

        if (outcome.status === 200 && /"success"\s*:\s*true/.test(outcome.text)) { verifyOk = true; break; }
        lastErr = outcome.text || `HTTP ${outcome.status}`;

        if (/login_link_already_used|too_many_attempts|rate_limit|sign_in_not_permitted/.test(outcome.text)) break;
        // missing_client_attestation / browser_not_verified → 再给一次机会重解
        await sleep(1500);
      }
    }
  }
  if (!verifyOk) log(`  ⚠️ 登录校验未成功: ${lastErr.slice(0, 200)}`);
}

/* 6. 等 sessionKey */
log('\n[6/6] 等待 sessionKey');
let sessionKey = '';
let cookies = [];
const deadline = Date.now() + args.timeoutMs;
let lastText = '';
let loggedReq = false;
let loggedResp = false;
let pageErr = '';
while (Date.now() < deadline) {
  await sleep(2000);
  const c = await tab.call('Network.getAllCookies').catch(() => null);
  cookies = c?.cookies || [];
  const sk = cookies.find((x) => x.name === 'sessionKey' && x.value);
  if (sk) { sessionKey = sk.value; break; }

  // 万一页面还要再解一轮验证码
  await solveIfVisible().catch(() => {});

  const txt = await evalPage(`(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,200)`).catch(() => '');
  if (typeof txt === 'string' && txt && txt !== lastText) {
    lastText = txt;
    log('  · ' + txt.slice(0, 140));
  }

  // 观察 verify_magic_link 的请求与响应，便于定位失败原因
  const vr = tab.events
    .filter((e) => e.method === 'Network.requestWillBeSent' && /verify_magic_link/.test(e.params.request.url))
    .pop();
  if (vr && !loggedReq) {
    loggedReq = true;
    log('  → verify_magic_link: ' + String(vr.params.request.postData || '').slice(0, 320));
  }
  if (vr && !loggedResp) {
    const rr = tab.events.find((e) => e.method === 'Network.responseReceived' && e.params.requestId === vr.params.requestId);
    if (rr) {
      loggedResp = true;
      const body = await tab.call('Network.getResponseBody', { requestId: vr.params.requestId }, 15000).catch(() => null);
      const text = String(body?.body || '').slice(0, 320);
      log(`  ← HTTP ${rr.params.response.status}: ${text}`);
      if (!verifyOk && /login_link_already_used|too_many_attempts|rate_limit|browser_not_verified|missing_client_attestation|invalid_request_error/.test(text)) {
        pageErr = text;
        break;
      }
    }
  }
}
if (!sessionKey && pageErr) throw new Error('验证码校验失败: ' + pageErr.slice(0, 240));
if (!sessionKey) throw new Error('超时未拿到 sessionKey');
log(`\n🎉 sessionKey: ${sessionKey.slice(0, 14)}… (${sessionKey.length} 字符)`);

/* 组织信息（新账号需要先完成 onboarding 才会有 org） */
async function apiCall(pathname, init = {}) {
  const raw = await evalPage(`(async () => {
    const r = await fetch(${JSON.stringify(pathname)}, {
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      ...${JSON.stringify(init)},
    });
    return JSON.stringify({ status: r.status, text: await r.text() });
  })()`, { timeoutMs: 60000 }).catch(() => '');
  try {
    const parsed = JSON.parse(String(raw));
    let body = null;
    try { body = JSON.parse(parsed.text); } catch { body = parsed.text; }
    return { status: parsed.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

async function readOrgs() {
  const r = await apiCall('/api/organizations');
  if (r.status !== 200 || !Array.isArray(r.body)) return [];
  return r.body;
}

let orgList = await readOrgs();
let org = '';
let plan = '';
let orgName = '';

if (!orgList.length) {
  log('  · 账号还没有 org，尝试完成 onboarding…');
  // 1) 同意法律条款  2) 补一个名字  3) 创建个人 chat org
  const legal = await apiCall('/api/account/accept_legal_docs', { method: 'PUT' });
  log(`    accept_legal_docs → ${legal.status}`);
  const prof = await apiCall('/api/account_profile', {
    method: 'PUT',
    body: JSON.stringify({ full_name: 'User', locale: 'ja-JP' }),
  });
  log(`    account_profile → ${prof.status}`);
  const created = await apiCall('/api/accounts/me/organizations/get_or_create_chat_organization', { method: 'POST' });
  log(`    get_or_create_chat_organization → ${created.status} ${JSON.stringify(created.body || {}).slice(0, 160)}`);
  orgList = await readOrgs();
}

if (orgList.length) {
  org = orgList[0].uuid || '';
  orgName = orgList[0].name || '';
  plan = orgList[0].rate_limit_tier || '';
}
log(`🏢 org: ${org || '(未获取)'}  ${orgName}  plan: ${plan || '-'}`);

// onboarding 可能重新签发 cookie，这里再读一次
const fresh = await tab.call('Network.getAllCookies').catch(() => null);
if (fresh?.cookies?.length) {
  cookies = fresh.cookies;
  const sk2 = cookies.find((x) => x.name === 'sessionKey' && x.value);
  if (sk2) sessionKey = sk2.value;
}

const claudeCookies = cookies.filter((c) => /(^|\.)claude\.ai$/.test(c.domain));const cookieHeader = claudeCookies.map((c) => `${c.name}=${c.value}`).join('; ');
log(`🍪 Cookie: ${claudeCookies.length} 项（含 ${claudeCookies.some((c) => c.name === 'cf_clearance') ? 'cf_clearance' : '无 cf_clearance'}）`);

const result = {
  label: args.label || args.email,
  email: args.email,
  sessionKey,
  cookie: cookieHeader,
  ua: browser.userAgent,
  org, orgName, plan,
  base: args.base,
};
fs.writeFileSync('/tmp/claude-login-result.json', JSON.stringify(result, null, 2));
writeLog('[result] ' + JSON.stringify({
  ...result,
  sessionKey: result.sessionKey ? `${result.sessionKey.slice(0, 10)}…(${result.sessionKey.length})` : '',
  cookie: result.cookie ? `${result.cookie.split(';').length} cookies` : '',
}));
log('→ /tmp/claude-login-result.json');

/* 入池 */
if (args.pool) {
  const headers = { 'Content-Type': 'application/json' };
  if (args.proxyKey) headers.Authorization = `Bearer ${args.proxyKey}`;
  const r = await fetch(`${args.proxyBase}/v1/accounts`, {
    method: 'POST', headers,
    body: JSON.stringify({
      label: result.label, sessionKey, cookie: cookieHeader, ua: browser.userAgent,
      org, base: args.base,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`入池失败 (HTTP ${r.status}): ${text.slice(0, 200)}`);
  log(`📥 已入池 (HTTP ${r.status}): ${text.slice(0, 200)}`);
} else {
  log('ℹ️  未加 --pool，仅输出结果');
}

browser.close();
process.exit(0);

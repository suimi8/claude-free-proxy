#!/usr/bin/env node
// @ts-check
/**
 * Claude 账号「浏览器辅助」注册/登录工具
 *
 * 为什么需要它：
 *   纯协议流程（claude-reg-protocol.mjs）走到 verify_magic_link 时，
 *   claude.ai 会把「hCaptcha 的签发环境」和「请求环境」做比对，
 *   只要验证码不是在同一个浏览器/IP 里完成的，就会返回 403 sign_in_not_permitted。
 *
 *   本工具改成：**让 claude.ai 自己的页面完成 attestation**。
 *     1. 用真实 Chrome（Linux 无显示器时自动拉 Xvfb）打开 /login；
 *     2. 自动填入邮箱并提交 —— send_magic_link 由页面自己发起，验证码也由页面自己求解；
 *     3. 从临时邮箱平台取回魔法链接，在同一浏览器里打开 —— verify_magic_link 同样由页面完成；
 *     4. 捕获 sessionKey + 全部 Cookie + 精确 UA，校验组织后写入反代账号池。
 *
 * 结果是完全真实的登录态（含 cf_clearance），可以直接给反代用。
 *
 * 用法：
 *   node tools/claude-reg-browser.mjs --email xxx@gayg.gay
 *   node tools/claude-reg-browser.mjs --auto --count 3
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) { console.log(msg); }

/* ────────────────────────────── 参数 ────────────────────────────── */

function parseArgs(argv) {
  const out = {
    email: '', proxyBase: 'http://127.0.0.1:8787', proxyKey: process.env.PROXY_API_KEY || '',
    base: 'https://claude.ai', timeoutMs: 8 * 60 * 1000, count: 1, skipPool: false,
    yescaptchaKey: process.env.YESCAPTCHA_CLIENT_KEY || '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--email') out.email = next();
    else if (a === '--proxy-base') out.proxyBase = next();
    else if (a === '--proxy-key') out.proxyKey = next();
    else if (a === '--base') out.base = next();
    else if (a === '--timeout') out.timeoutMs = Number(next());
    else if (a === '--count') out.count = Number(next());
    else if (a === '--yescaptcha-key') out.yescaptchaKey = next();
    else if (a === '--skip-pool') out.skipPool = true;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  console.log(`
Claude 账号「浏览器辅助」注册工具

  node tools/claude-reg-browser.mjs --email <邮箱> [选项]

选项:
  --email <地址>        注册/登录用的邮箱（必填，或先手工在该平台建好邮箱）
  --count <n>           连续注册几个账号，默认 1（需要 --auto 选邮箱）
  --proxy-base <url>    反代地址，默认 http://127.0.0.1:8787
  --proxy-key <key>     反代 API Key（默认读环境变量 PROXY_API_KEY）
  --yescaptcha-key <k>  打码平台 Key（图形题识别用，默认读 YESCAPTCHA_CLIENT_KEY）
  --base <url>          claude.ai 地址，默认 https://claude.ai
  --timeout <毫秒>      单个账号的整体超时，默认 8 分钟
  --skip-pool           只打印结果，不写入反代账号池

环境变量:
  PROXY_API_KEY         反代 API Key
  MAOMAIL_TOKEN         临时邮箱平台 Token
  MAOMAIL_BASE_URL      临时邮箱平台地址
  LOGIN_BROWSER         指定浏览器可执行文件
`);
}

/* ────────────────────────────── 配置 ────────────────────────────── */

function loadMaoMailConfig() {
  let file = {};
  try {
    const p = path.join(ROOT, 'config.json');
    if (fs.existsSync(p)) file = (JSON.parse(fs.readFileSync(p, 'utf8')).settings || {});
  } catch { /* ignore */ }
  return {
    token: process.env.MAOMAIL_TOKEN || file.maomailToken || '',
    baseUrl: process.env.MAOMAIL_BASE_URL || file.maomailBaseUrl || 'https://zjkdongao.cn',
  };
}

async function loadModule(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) throw new Error(`缺少模块: ${rel}`);
  return import(pathToFileURL(p).href);
}

/* ──────────────────────────── 虚拟显示器 ──────────────────────────── */

function hasXvfb() {
  for (const p of ['/usr/bin/Xvfb', '/usr/local/bin/Xvfb']) if (fs.existsSync(p)) return p;
  return '';
}

/** 无显示器时拉一个 Xvfb，返回 {display, proc} */
async function ensureDisplay() {
  if (process.platform !== 'linux' || process.env.DISPLAY) return null;
  const bin = hasXvfb();
  if (!bin) return null;
  for (let n = 77; n < 100; n++) {
    if (fs.existsSync(`/tmp/.X11-unix/X${n}`)) continue;
    const proc = spawn(bin, [`:${n}`, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      if (fs.existsSync(`/tmp/.X11-unix/X${n}`)) {
        process.env.DISPLAY = `:${n}`;
        log(`🖥️  启动虚拟显示器 Xvfb :${n} (1440x900x24)`);
        return { display: `:${n}`, proc };
      }
      if (proc.exitCode !== null) break;
    }
    try { proc.kill(); } catch { /* noop */ }
  }
  return null;
}

/* ─────────────────────────────── 主流程 ─────────────────────────────── */

/** 极简 CDP 客户端（只用于「第二个标签页」：打开魔法链接读回退验证码） */
class MiniCdp {
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    });
    return new MiniCdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const p = m.id && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    });
  }

  call(method, params = {}, timeoutMs = 90000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, { res, rej, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); rej(e); }
    });
  }

  close() { try { this.ws.close(); } catch { /* noop */ } }
}

/**
 * 在**同一个浏览器**（同一份 cookie）里另开一个标签页打开魔法链接，
 * 读取页面回退出来的 6 位验证码。
 *
 * 背景：magic-link 页面要求 hCaptcha（area-select），一旦验证失败/复用了链接，
 * 页面会显示「認証コードを使用して続行」+ 6 位验证码，并提示
 * 「最初にサインインを試みた場所で、この認証コードを入力してください」。
 * 于是：标签页 A = /login 的验证码输入框，标签页 B = 魔法链接页取码。
 */
async function readFallbackCode(flow, magicLink, progress) {
  if (!flow?.cdp) return '';
  let targetId = '';
  let tab = null;
  try {
    progress('正在另开标签页读取回退验证码…');
    const created = await flow.cdp.call('Target.createTarget', { url: 'about:blank' }, 30000);
    targetId = created?.targetId || '';
    if (!targetId) throw new Error('createTarget 未返回 targetId');

    // 从 /json/list 拿到这个新标签页的 ws 地址（需要等它注册）
    let info = null;
    for (let i = 0; i < 25 && !info; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${flow.port}/json/list`, {
          signal: AbortSignal.timeout(3000),
        })).json();
        info = list.find((t) => t.id === targetId) || null;
      } catch { /* 继续等 */ }
    }
    if (!info?.webSocketDebuggerUrl) throw new Error('新标签页未就绪');

    tab = await MiniCdp.connect(info.webSocketDebuggerUrl);
    await tab.call('Page.enable', {}, 20000).catch(() => {});
    await tab.call('Runtime.enable', {}, 20000).catch(() => {});
    await tab.call('Page.navigate', { url: magicLink }, 90000).catch(() => {});

    // 第一遍：正常打开魔法链接（可能出 hCaptcha）；
    // 之后重载 —— nonce 已被消费，页面会回退成「認証コードを使用して続行」+ 6 位码。
    let lastText = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await sleep(1500);
        const r = await tab.call('Runtime.evaluate', {
          expression: `(() => {
            const t = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ');
            const m = t.match(/(\\d{6})/);
            return JSON.stringify({ text: t.slice(0, 200), code: m ? m[1] : '' });
          })()`,
          returnByValue: true,
        }, 20000).catch(() => null);
        const raw = r?.result?.value;
        if (!raw) continue;
        let st;
        try { st = JSON.parse(raw); } catch { continue; }
        lastText = st.text || lastText;
        if (st.code && /認証コード|verification code|代码/i.test(st.text)) {
          progress(`已从魔法链接页读到验证码 [${st.code}]`);
          return st.code;
        }
      }
      progress(`第 ${attempt} 次读取未出码，重载魔法链接页…`);
      await tab.call('Page.reload', {}, 90000).catch(() => {});
    }
    progress(`魔法链接页未给出验证码（停留在：${lastText.slice(0, 80)}）`);
    return '';
  } catch (e) {
    progress(`读取回退验证码失败: ${e.message}`);
    return '';
  } finally {
    try { tab?.close(); } catch { /* noop */ }
    if (targetId) {
      try { await flow.cdp.call('Target.closeTarget', { targetId }, 10000); } catch { /* noop */ }
    }
  }
}

/**
 * 兜底：如果 hCaptcha 在真实页面里仍然弹出 3×3 图形题，
 * 用打码平台识别 + 本机真实鼠标点击来通过（token 仍由本机页面签发）。
 */
async function watchChallenges(flow, args) {
  if (!flow || !args.yescaptchaKey) return;
  const { YesCaptcha } = await loadModule('tools/yescaptcha.mjs');
  const { HcaptchaChallengeSolver } = await loadModule('tools/hcaptcha-challenge.mjs');
  const yc = new YesCaptcha({ clientKey: args.yescaptchaKey });
  const handled = new Set();

  /**
   * 只有「页面里真的有一个可见的图形题」才动手。
   * hCaptcha 会常驻一个隐藏的 frame=challenge 目标（invisible checkbox / display-error），
   * 盲目点击会把它越点越糟。
   */
  const visibleChallenge = async () => {
    const r = await flow.pageCdp.call('Runtime.evaluate', {
      expression: `(() => {
        const f = Array.from(document.querySelectorAll('iframe'))
          .filter(x => (x.src || '').includes('frame=challenge'))
          .map(x => ({ el: x, rc: x.getBoundingClientRect() }))
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
  };

  while (flow && !['done', 'error', 'closed', 'timeout', 'cancelled'].includes(flow.state)) {
    try {
      if (flow.pageCdp && flow.cdp) {
        const state = await visibleChallenge();
        if (state === 'visible') {
          const targets = await flow.cdp.call('Target.getTargets', {}, 5000);
          const hit = (targets?.targetInfos || []).find((t) => /frame=challenge/.test(t.url || ''));
          if (hit && !handled.has(hit.targetId)) {
            handled.add(hit.targetId);
            log('   · [验证码] 检测到可见图形题，开始识别与点击…');
            const solver = new HcaptchaChallengeSolver({
              page: flow.pageCdp,
              browser: flow.cdp,
              classify: ({ question, queries, anchors }) => yc.classifyHCaptcha({ question, queries, anchors }),
              onProgress: (m) => log(`   · [验证码] ${m}`),
            });
            const ok = await solver.handleChallenge().catch((e) => {
              log(`   · [验证码] 处理失败: ${e.message}`);
              return false;
            });
            if (ok) log('   · [验证码] 已提交 ✅');
          }
        }
      }
    } catch { /* 浏览器可能已关闭 */ }
    await sleep(2000);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) {
    printHelp();
    throw new Error('缺少 --email');
  }

  const mailCfg = loadMaoMailConfig();
  if (!mailCfg.token) throw new Error('未配置临时邮箱 Token（MAOMAIL_TOKEN 或 config.json settings.maomailToken）');

  const { MaoMailClient } = await loadModule('plugins/maomail-auto-login/maomail.mjs');
  const { createLoginManager } = await loadModule('src/login-link.mjs');
  const mail = new MaoMailClient({ token: mailCfg.token, baseUrl: mailCfg.baseUrl });

  const display = await ensureDisplay();

  let captured = null;
  const manager = createLoginManager({
    baseUrl: args.proxyBase,
    webBase: args.base,
    timeoutMs: args.timeoutMs,

    /** 页面发出 send_magic_link 后，由我们从临时邮箱取回凭据交给浏览器 */
    onAutoVerification: async (email, flow, progress) => {
      const detail = await mail.waitForVerification({
        email,
        timeoutMs: Math.min(args.timeoutMs, 4 * 60 * 1000),
        onProgress: (m) => progress(m),
      });
      if (detail?.code) return detail;   // 邮件里直接带了验证码（罕见）
      if (!detail?.magicLink) throw new Error('邮件里没有可用的登录凭据');

      // 优先走「回退验证码」：另开标签页打开魔法链接，读 6 位码，
      // 回到登录页的 #code 输入框提交（不依赖魔法链接页的 hCaptcha）
      const code = await readFallbackCode(flow, detail.magicLink, progress);
      if (code) return { code, magicLink: detail.magicLink };
      return detail;                     // 兜底：直接跳转魔法链接
    },

    /** 捕获到 sessionKey 后的处理：默认写入反代账号池 */
    onCapture: async (acc) => {
      captured = acc;
      log(`\n🔑 sessionKey: ${acc.sessionKey.slice(0, 12)}… (${acc.sessionKey.length} 字符)`);
      log(`🏢 org: ${acc.org || '(未获取)'}  plan: ${acc.plan || '-'}  name: ${acc.name || '-'}`);
      log(`🖥️  UA: ${acc.ua}`);
      log(`🍪 Cookie: ${acc.cookie.split('; ').length} 项`);

      if (args.skipPool) {
        log('ℹ️  --skip-pool：不写入账号池');
        return { label: args.email, sessionKey: acc.sessionKey };
      }
      const headers = { 'Content-Type': 'application/json' };
      if (args.proxyKey) headers.Authorization = `Bearer ${args.proxyKey}`;
      const r = await fetch(`${args.proxyBase}/v1/accounts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          label: args.email,
          sessionKey: acc.sessionKey,
          cookie: acc.cookie,
          ua: acc.ua,
          org: acc.org,
          base: args.base,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const t = await r.text();
      if (!r.ok) throw new Error(`写入账号池失败 (HTTP ${r.status}): ${t.slice(0, 200)}`);
      log(`📥 已入池 (HTTP ${r.status}): ${t.slice(0, 200)}`);
      return { label: args.email, sessionKey: acc.sessionKey };
    },
  });

  const started = manager.start(`${args.proxyBase}/v1/accounts`, { email: args.email, autoLogin: true });
  log(`🚀 登录流程已启动 (${started.id})，浏览器正在打开 claude.ai…`);

  // 图形题兜底（不阻塞主流程）
  watchChallenges(manager.get(started.id), args).catch(() => { /* 忽略 */ });

  const deadline = Date.now() + args.timeoutMs + 60000;
  let lastMsg = '';
  while (Date.now() < deadline) {
    const st = manager.state(started.id);
    if (!st) break;
    if (st.message && st.message !== lastMsg) {
      lastMsg = st.message;
      log(`   · ${st.message}`);
    }
    if (st.state === 'done' || st.state === 'error' || st.state === 'closed'
      || st.state === 'timeout' || st.state === 'cancelled') {
      if (st.state !== 'done') throw new Error(`流程结束于 ${st.state}: ${st.message}`);
      break;
    }
    await sleep(1500);
  }

  if (!captured) throw new Error('流程结束但没有捕获到账号凭据');

  log('\n' + '='.repeat(64));
  log('🎉 完成');
  log('='.repeat(64));
  log(JSON.stringify({
    label: args.email,
    org: captured.org,
    plan: captured.plan,
    ua: captured.ua,
    sessionKey: `${captured.sessionKey.slice(0, 12)}…`,
    cookies: captured.cookie.split('; ').map((c) => c.split('=')[0]),
  }, null, 2));

  display?.proc?.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n❌ 失败: ${e.message}`);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});

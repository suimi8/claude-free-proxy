#!/usr/bin/env node
// @ts-check
/**
 * Claude 账号「纯协议」注册脚本 (Pure HTTP, 无浏览器)
 *
 * 完整复刻 claude.ai 网页端注册/登录协议链路：
 *   1. GET  /login                              建立会话 Cookie + 解析客户端版本指纹
 *   2. GET  /api/auth/login_methods             查询该邮箱支持的登录方式
 *   3. 打码  sitekey=f1b21a9c-...               (login 页 hCaptcha)
 *   4. POST /api/auth/send_magic_link           请求魔法链接邮件
 *   5. 轮询邮箱 → 解析 Magic Link 中的 nonce
 *   6. 打码  sitekey=a8086506-...               (magic-link 页 hCaptcha)
 *   7. POST /api/auth/verify_magic_link         兑换 sessionKey
 *   8. 补齐 onboarding（法定文书 / 年龄确认 / 显示名）
 *   9. 校验组织信息并写入反代账号池
 *
 * 用法：
 *   node tools/claude-reg-protocol.mjs --email user@example.com
 *   node tools/claude-reg-protocol.mjs --email user@example.com --magic-link "https://claude.ai/magic-link#nonce:b64"
 *   node tools/claude-reg-protocol.mjs --auto            # 从临时邮箱平台自动挑一个邮箱
 *
 * 环境变量：
 *   YESCAPTCHA_CLIENT_KEY   打码平台 Key（也可用 --yescaptcha-key 传入）
 *   MAOMAIL_TOKEN           临时邮箱平台 Token（默认读 config.json settings.maomailToken）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { YesCaptcha } from './yescaptcha.mjs';
import { LocalCaptchaBrowser } from './hcaptcha-local.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const BASE = 'https://claude.ai';
/** login 页 hCaptcha sitekey（发魔法链接前校验） */
const SITEKEY_LOGIN = 'f1b21a9c-9100-4022-a928-8d5c29de2e6a';
/** magic-link 页 hCaptcha sitekey（兑换 sessionKey 前校验） */
const SITEKEY_MAGIC = 'a8086506-2036-46f4-ae50-00d8be805efa';
const CLIENT_CAPABILITIES =
  'mfa_sms_v1, mfa_email_v1, plugin_reach_v2, saved_notice_line_v1, greeting_timed_line_v1, tawny_sandpiper_v1';

/* ────────────────────────────── 参数解析 ────────────────────────────── */

function parseArgs(argv) {
  const out = {
    email: '', magicLink: '', yescaptchaKey: '', proxyBase: 'http://127.0.0.1:8787',
    locale: 'ja-JP', lang: 'ja-JP,ja;q=0.9', utcOffset: -540, displayName: '', auto: false,
    skipPool: false, dryRun: false, timeoutMs: 120000, captcha: 'yescaptcha',
    proxyKey: process.env.PROXY_API_KEY || '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--email') out.email = next();
    else if (a === '--magic-link') out.magicLink = next();
    else if (a === '--yescaptcha-key') out.yescaptchaKey = next();
    else if (a === '--proxy-base') out.proxyBase = next();
    else if (a === '--proxy-key') out.proxyKey = next();
    else if (a === '--locale') out.locale = next();
    else if (a === '--lang') out.lang = next();
    else if (a === '--utc-offset') out.utcOffset = Number(next());
    else if (a === '--display-name') out.displayName = next();
    else if (a === '--timeout') out.timeoutMs = Number(next());
    else if (a === '--captcha') out.captcha = next();
    else if (a === '--auto') out.auto = true;
    else if (a === '--skip-pool') out.skipPool = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  console.log(`
Claude 纯协议注册脚本

  node tools/claude-reg-protocol.mjs --email <邮箱> [选项]

选项:
  --email <地址>          注册用的邮箱
  --auto                  从临时邮箱平台自动挑选一个未使用的邮箱
  --magic-link <url>      直接使用已有的魔法链接（跳过发信与收信）
  --captcha <引擎>        yescaptcha（默认，第三方打码）| local（本机浏览器打码，同 IP 同指纹）
  --yescaptcha-key <key>  打码平台 Key（默认读环境变量 YESCAPTCHA_CLIENT_KEY）
  --proxy-base <url>      反代地址，默认 http://127.0.0.1:8787
  --proxy-key <key>       反代 API Key（默认读环境变量 PROXY_API_KEY）
  --display-name <名>     设置显示名（默认取邮箱前缀）
  --locale / --lang       语言，默认 ja-JP
  --utc-offset <分>       时区偏移（分钟），默认 -540
  --skip-pool             只打印结果，不写入反代账号池
  --dry-run               只跑到「发送魔法链接」为止

环境变量:
  YESCAPTCHA_CLIENT_KEY   打码平台 Key
  PROXY_API_KEY           反代 API Key（写入账号池时用）
  MAOMAIL_TOKEN           临时邮箱平台 Token（默认读 config.json settings.maomailToken）
  MAOMAIL_BASE_URL        临时邮箱平台地址（默认 https://zjkdongao.cn）
`);
}

/* ────────────────────────────── 工具函数 ────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const step = (n, total, msg) => console.log(`\n[${n}/${total}] ${msg}`);

function uuid() {
  return crypto.randomUUID();
}

/** 极简 Cookie 罐（只关心 claude.ai 域下同名 cookie） */
class CookieJar {
  constructor() { this.map = new Map(); }
  absorb(res) {
    let list = [];
    try { list = res.headers.getSetCookie?.() || []; } catch { list = []; }
    if (!list.length) {
      const raw = res.headers.get('set-cookie');
      if (raw) list = [raw];
    }
    for (const line of list) {
      const pair = String(line).split(';')[0];
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!name) continue;
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(String(line))) this.map.delete(name);
      else this.map.set(name, value);
    }
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
  get(name) { return this.map.get(name); }
  set(name, value) { this.map.set(name, value); }
  all() { return Object.fromEntries(this.map); }
}

/** 解析 Claude 魔法链接里的 nonce 与 base64 邮箱 */
function parseMagicLink(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const m = text.match(/https?:\/\/claude\.ai\/magic-link([?#][^\s"'<>]*)?/i);
  let hash = '', query = '';
  if (m) {
    const tail = m[1] || '';
    const hi = tail.indexOf('#');
    const qi = tail.indexOf('?');
    if (qi >= 0) query = tail.slice(qi + 1, hi >= 0 ? hi : undefined);
    if (hi >= 0) hash = tail.slice(hi + 1);
  } else {
    hash = text.startsWith('#') ? text.slice(1) : text;
  }

  // 形如 nonce:base64(email)
  if (hash && !hash.includes('=') || (hash && /^[0-9a-f]{16,}:/i.test(hash))) {
    const [nonce, b64] = hash.split(':');
    if (nonce) return { nonce, encodedEmailAddress: b64 || '' };
  }
  // 形如 nonce=xxx&email=yyy
  const params = new URLSearchParams(query || hash.replace(/&/g, '&'));
  const nonce = params.get('nonce');
  if (nonce) {
    const email = params.get('email') || '';
    return { nonce, encodedEmailAddress: email ? Buffer.from(email).toString('base64') : '' };
  }
  // 裸 nonce（32 位十六进制）
  if (/^[0-9a-f]{16,64}$/i.test(hash)) return { nonce: hash, encodedEmailAddress: '' };
  return null;
}

/* ────────────────────────────── 邮箱适配 ────────────────────────────── */

/** 读取临时邮箱平台配置：环境变量优先，其次 config.json */
function loadMaoMailConfig() {
  const env = {
    token: process.env.MAOMAIL_TOKEN || '',
    baseUrl: process.env.MAOMAIL_BASE_URL || '',
  };
  let file = {};
  try {
    const p = path.join(ROOT, 'config.json');
    if (fs.existsSync(p)) file = (JSON.parse(fs.readFileSync(p, 'utf8')).settings || {});
  } catch { /* ignore */ }
  return {
    token: env.token || file.maomailToken || '',
    baseUrl: env.baseUrl || file.maomailBaseUrl || 'https://zjkdongao.cn',
  };
}

/**
 * 懒加载临时邮箱客户端（plugins/ 目录被 gitignore，缺失时优雅降级）
 */
async function loadMailClient() {
  const mod = path.join(ROOT, 'plugins', 'maomail-auto-login', 'maomail.mjs');
  if (!fs.existsSync(mod)) return null;
  try {
    const { MaoMailClient } = await import(pathToFileURL(mod).href);
    return MaoMailClient;
  } catch (e) {
    console.warn(`⚠ 加载临时邮箱客户端失败: ${e.message}`);
    return null;
  }
}

/** 从 stdin 读取一行（用于 --magic-link - 场景） */
async function readLineFromStdin() {
  const chunks = [];
  for await (const c of process.stdin) {
    const s = String(c);
    chunks.push(s);
    if (s.includes('\n')) break;
  }
  return chunks.join('').trim();
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ycKey = args.yescaptchaKey || process.env.YESCAPTCHA_CLIENT_KEY || '';
  if (!ycKey) throw new Error('缺少打码平台 Key：请设置 YESCAPTCHA_CLIENT_KEY 或 --yescaptcha-key');

  const yc = new YesCaptcha({ clientKey: ycKey });
  const bal = await yc.balance();
  log(`💰 YesCaptcha 余额: ${bal} 点`);
  if (bal <= 0) throw new Error('打码平台余额不足');

  /**
   * 验证码求解器。
   *  - yescaptcha：第三方打码平台（在他们的机房 IP / 浏览器完成）
   *  - local     ：本机浏览器完成，签发 IP 与后续请求完全一致
   */
  const useLocal = args.captcha === 'local';
  let localBrowser = null;
  if (useLocal) {
    localBrowser = new LocalCaptchaBrowser({ onProgress: (m) => log(`   · ${m}`) });
    globalThis.__localBrowser = localBrowser;
    await localBrowser.launch();
  }

  const solveCaptcha = async (sitekey, pageUrl) => {
    if (useLocal) {
      const r = await localBrowser.solveWithRetry(sitekey, pageUrl, args.timeoutMs, {
        // 图形题：题图交给打码平台识别，点击动作在本机浏览器里做
        classify: async ({ question, queries, anchors }) => {
          const sol = await yc.classifyHCaptcha({ question, queries, anchors });
          return sol;
        },
      });
      return { token: r.token, userAgent: r.userAgent };
    }
    const r = await yc.solveHCaptcha(
      { websiteURL: pageUrl, websiteKey: sitekey, isInvisible: true, userAgent: ua },
      { onProgress: (m) => log(`   · ${m}`) },
    );
    return { token: r.token, userAgent: r.userAgent };
  };
  log(`🧩 验证码引擎: ${useLocal ? '本机浏览器 (local)' : 'YesCaptcha'}`);

  const jar = new CookieJar();
  // 打码平台官方 UA —— 必须与携带 token 的提交请求保持一致
  let ua = useLocal ? localBrowser.userAgent : await yc.userAgent();
  if (ua) log(`🖥️  UA: ${ua}`);

  const clientInfo = {
    build: '', sha: '', version: '1.0.0', capabilities: CLIENT_CAPABILITIES,
    platform: 'web_claude_ai', anonymousId: `claudeai.v1.${uuid()}`,
  };

  /** 统一请求封装 */
  async function api(pathname, { method = 'GET', body, headers = {}, referer } = {}) {
    const h = {
      accept: '*/*',
      'accept-language': args.lang,
      'user-agent': ua,
      'content-type': 'application/json',
      'anthropic-client-platform': clientInfo.platform,
      'anthropic-client-version': clientInfo.version,
      'anthropic-client-build': clientInfo.build,
      'anthropic-client-sha': clientInfo.sha,
      'anthropic-client-capabilities': clientInfo.capabilities,
      'anthropic-anonymous-id': clientInfo.anonymousId,
      'anthropic-device-id': jar.get('anthropic-device-id') || '',
      'x-activity-session-id': jar.get('activitySessionId') || '',
      origin: BASE,
      referer: referer || `${BASE}/`,
      'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': 'Windows',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      cookie: jar.header(),
      ...headers,
    };
    if (!h['anthropic-device-id']) delete h['anthropic-device-id'];
    if (!h['x-activity-session-id']) delete h['x-activity-session-id'];

    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(45000),
    });
    jar.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return { status: res.status, text, json, headers: res.headers };
  }

  // 直接给定魔法链接时，可跳过「打码 + 发信」两步（省一次打码费用）
  const reuseLink = !!args.magicLink;
  const STEPS = reuseLink
    ? ['GET /login 建立会话', '准备邮箱', '查询登录方式', '解析魔法链接',
       '求解 hCaptcha (magic-link)', '兑换 sessionKey', '补齐 onboarding', '发现组织并入池']
    : ['GET /login 建立会话', '准备邮箱', '查询登录方式', '求解 hCaptcha (login)',
       '发送魔法链接', '等待验证邮件', '求解 hCaptcha (magic-link)', '兑换 sessionKey',
       '补齐 onboarding', '发现组织并入池'];
  const TOTAL = STEPS.length;
  let stepNo = 0;
  const nextStep = (msg) => step(++stepNo, TOTAL, msg);

  /* ── 1. 建立会话 ─────────────────────────────────────────── */
  nextStep('GET /login 建立会话…');
  {
    const res = await fetch(`${BASE}/login`, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': args.lang,
        'user-agent': ua,
        'upgrade-insecure-requests': '1',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    jar.absorb(res);
    const html = await res.text();
    if (res.status >= 400) throw new Error(`/login 返回 HTTP ${res.status}`);
    const build = html.match(/data-build-timestamp="([^"]+)"/)?.[1] || '';
    const sha = html.match(/data-git-hash="([^"]+)"/)?.[1] || '';
    const version = html.match(/data-version="([^"]+)"/)?.[1] || '1.0.0';
    clientInfo.build = build;
    clientInfo.sha = sha;
    clientInfo.version = version;
    // ajs_anonymous_id 与 anthropic-anonymous-id 保持一致（浏览器端行为）
    jar.set('ajs_anonymous_id', clientInfo.anonymousId);
    log(`   ✓ 指纹 build=${build} sha=${sha.slice(0, 12)}…`);
    log(`   ✓ Cookie: ${[...jar.map.keys()].join(', ')}`);
  }

  /* ── 2. 选择邮箱 ─────────────────────────────────────────── */
  nextStep('准备邮箱…');
  const mailCfg = loadMaoMailConfig();
  const MaoMailClient = await loadMailClient();
  const mail = MaoMailClient && mailCfg.token
    ? new MaoMailClient({ token: mailCfg.token, baseUrl: mailCfg.baseUrl })
    : null;

  let email = args.email;
  if (!email && args.auto) {
    if (!mail) throw new Error('--auto 需要临时邮箱平台：请在 config.json 配置 settings.maomailToken');
    const boxes = await mail.listMailboxes(100);
    if (!boxes.length) throw new Error('临时邮箱平台没有可用邮箱');
    email = boxes[0].email;
    log(`   ✓ 自动选用邮箱: ${email}`);
  }
  if (!email) throw new Error('缺少 --email 或 --auto');
  email = email.trim().toLowerCase();

  /* ── 3. 查询登录方式 ─────────────────────────────────────── */
  nextStep(`GET /api/auth/login_methods (${email})…`);
  {
    const q = new URLSearchParams({ email, source: 'claude-ai' });
    const res = await api(`/api/auth/login_methods?${q}`, { referer: `${BASE}/login` });
    if (res.status !== 200) throw new Error(`login_methods 返回 HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    log(`   ✓ 可用登录方式: ${JSON.stringify(res.json?.methods)}`);
    const methods = res.json?.methods || [];
    if (methods.length && !methods.includes('magic_link')) {
      throw new Error(`该邮箱不支持魔法链接登录（可用: ${methods.join(',')}），请换一个邮箱`);
    }
  }

  /* ── 4. 打码（登录页 sitekey） ───────────────────────────── */
  let cap1 = null;
  if (!reuseLink) {
    nextStep('求解 hCaptcha (login sitekey)…');
    cap1 = await solveCaptcha(SITEKEY_LOGIN, `${BASE}/login`, 'login');
    if (cap1.userAgent && cap1.userAgent !== ua) {
      log(`   · 打码 UA 与请求 UA 不一致，已切换为打码 UA`);
      ua = cap1.userAgent;
    }
    if (!ua) ua = cap1.userAgent || ua;
    log(`   ✓ token: ${cap1.token.slice(0, 48)}… (${cap1.token.length} 字符)`);

    /* ── 5. 发送魔法链接 ───────────────────────────────────── */
    nextStep('POST /api/auth/send_magic_link…');
    const res = await api('/api/auth/send_magic_link', {
      method: 'POST',
      referer: `${BASE}/login`,
      body: {
        utc_offset: args.utcOffset,
        email_address: email,
        login_intent: null,
        locale: args.locale,
        return_to: null,
        source: 'claude',
        client_attestation: { hcaptcha_token: cap1.token },
      },
    });
    if (res.status !== 200) {
      throw new Error(`send_magic_link 返回 HTTP ${res.status}: ${res.text.slice(0, 400)}`);
    }
    log(`   ✓ 邮件已发送: ${JSON.stringify(res.json).slice(0, 160)}`);
    if (args.dryRun) {
      log('\n🧪 --dry-run：到此为止，未继续兑换。');
      return;
    }
  }

  /* ── 6. 收取魔法链接 ─────────────────────────────────────── */
  nextStep(reuseLink ? '解析已有魔法链接…' : '等待验证邮件…');
  let rawLink = args.magicLink;
  if (rawLink === '-') {
    log('   · 从 stdin 等待魔法链接…');
    rawLink = await readLineFromStdin();
    log(`   · 已从 stdin 收到链接 (${String(rawLink).length} 字符)`);
  }
  let magic = parseMagicLink(rawLink);
  if (!magic && rawLink) {
    throw new Error(`无法解析魔法链接: ${String(rawLink).slice(0, 120)}`);
  }
  if (!magic) {
    if (!mail) throw new Error('未提供 --magic-link，且没有可用的临时邮箱客户端');
    const detail = await mail.waitForVerification({
      email,
      timeoutMs: args.timeoutMs,
      onProgress: (m) => log(`   · ${m}`),
    });
    if (!detail.magicLink) throw new Error('邮件中未找到魔法链接');
    magic = parseMagicLink(detail.magicLink);
    if (!magic) throw new Error(`魔法链接解析失败: ${detail.magicLink.slice(0, 160)}`);
  }
  if (!magic.encodedEmailAddress) {
    magic.encodedEmailAddress = Buffer.from(email).toString('base64');
  }
  log(`   ✓ nonce=${magic.nonce}  email(b64)=${magic.encodedEmailAddress}`);

  /* ── 7. 打码（magic-link sitekey） ───────────────────────── */
  nextStep('求解 hCaptcha (magic-link sitekey)…');

  // 浏览器拿到链接后一定会先访问一次 /magic-link（会带回该页面专属 Cookie）
  const magicPageUrl = `${BASE}/magic-link`;
  try {
    const pageRes = await fetch(magicPageUrl, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': args.lang,
        'user-agent': ua,
        referer: `${BASE}/`,
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        cookie: jar.header(),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    jar.absorb(pageRes);
    await pageRes.text();
    log(`   ✓ 已访问 ${magicPageUrl} (HTTP ${pageRes.status})`);
  } catch (e) {
    log(`   ⚠ 访问 /magic-link 失败: ${e.message}`);
  }

  const cap2 = await solveCaptcha(
    SITEKEY_MAGIC,
    // 带 hash 的完整链接能让打码端复现真实浏览器的验证码渲染状态
    `${magicPageUrl}#${magic.nonce}:${magic.encodedEmailAddress}`,
    'magic-link',
  );
  if (cap2.userAgent && cap2.userAgent !== ua) ua = cap2.userAgent;
  log(`   ✓ token: ${cap2.token.slice(0, 48)}… (${cap2.token.length} 字符)`);

  /* ── 8. 兑换 sessionKey ──────────────────────────────────── */
  nextStep('POST /api/auth/verify_magic_link…');
  let sessionKey = '';
  let account = null;
  {
    const res = await api('/api/auth/verify_magic_link', {
      method: 'POST',
      body: {
        credentials: {
          method: 'nonce',
          nonce: magic.nonce,
          encoded_email_address: magic.encodedEmailAddress,
        },
        locale: args.locale,
        client_attestation: { hcaptcha_token: cap2.token },
        source: 'claude',
      },
    });
    if (res.status !== 200) {
      throw new Error(`verify_magic_link 返回 HTTP ${res.status}: ${res.text.slice(0, 500)}`);
    }
    sessionKey = jar.get('sessionKey') || '';
    account = res.json?.account || null;
    if (!sessionKey) throw new Error('未捕获到 sessionKey Cookie');
    log(`   ✓ 登录成功，sessionKey 已捕获`);
    log(`   ✓ account=${account?.email_address}  uuid=${account?.uuid}  created=${res.json?.created}`);
  }

  /* ── 9. 补齐 onboarding ──────────────────────────────────── */
  nextStep('补齐 onboarding（法定文书 / 年龄 / 显示名）…');
  {
    const bestEffort = async (label, fn) => {
      try { await fn(); log(`   ✓ ${label}`); }
      catch (e) { log(`   ⚠ ${label} 失败: ${e.message}`); }
    };
    await bestEffort('设置资料 locale', () =>
      api('/api/account_profile', { method: 'PUT', body: { locale: args.locale } }));
    await bestEffort('开始 onboarding', () =>
      api('/api/account/settings', { method: 'PATCH', body: { has_started_claudeai_onboarding: true } }));
    await bestEffort('接受法定文书', () =>
      api('/api/account/accept_legal_docs', {
        method: 'PUT',
        body: {
          acceptances: [
            { document_id: 'v3:aup:fbaea72f-9ddc-47cc-bb3e-45c94c0b4dd1', accepted_via_checkbox: true },
            { document_id: 'v3:consumer-terms:79dbc8c6-7f64-43d6-8101-207cede59a4d', accepted_via_checkbox: true },
            { document_id: 'v3:privacy:baeb68ac-c81c-4931-9539-58f46b6f090c', accepted_via_checkbox: false },
          ],
          marketing_email: { choice: 'unticked', form: 'legal_notices' },
        },
      }));
    await bestEffort('年龄确认', () =>
      api('/api/account?statsig_hashing_algorithm=djb2', { method: 'PUT', body: { age_is_verified: true } }));

    const displayName = args.displayName || email.split('@')[0].slice(0, 40);
    await bestEffort('设置显示名', () =>
      api('/api/account?statsig_hashing_algorithm=djb2', {
        method: 'PUT',
        body: { display_name: displayName, full_name: displayName },
      }));
    await bestEffort('完成 onboarding', () =>
      api('/api/account/settings', {
        method: 'PATCH',
        body: { has_finished_claudeai_onboarding: true, work_function: 'Other', onboarding_use_case: 'personal' },
      }));
  }

  /* ── 组织发现 & 入池 ─────────────────────────────────────── */
  log('\n🔎 发现组织信息…');
  let org = '', orgName = '', plan = '';
  {
    const res = await api('/api/organizations', { referer: `${BASE}/` });
    if (res.status === 200) {
      const list = Array.isArray(res.json) ? res.json : (res.json?.data || []);
      org = list[0]?.uuid || '';
      orgName = list[0]?.name || '';
      plan = list[0]?.rate_limit_tier || '';
      log(`   ✓ org=${org}  name=${orgName}  plan=${plan}`);
    } else {
      log(`   ⚠ 组织接口 HTTP ${res.status}（登录态可能需要 cf_clearance）`);
    }
  }

  const cookie = jar.header();
  const result = {
    email,
    sessionKey,
    cookie,
    ua,
    org,
    orgName,
    plan,
    label: email,
  };

  if (!args.skipPool) {
    log('\n📥 写入反代账号池…');
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (args.proxyKey) headers.Authorization = `Bearer ${args.proxyKey}`;
      const r = await fetch(`${args.proxyBase}/v1/accounts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          label: email, sessionKey, cookie, ua, org,
          base: BASE,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const t = await r.text();
      if (r.ok) log(`   ✓ 已入池 (HTTP ${r.status}): ${t.slice(0, 240)}`);
      else log(`   ⚠ 入池失败 (HTTP ${r.status}): ${t.slice(0, 240)}`);
    } catch (e) {
      log(`   ⚠ 无法连接反代服务 ${args.proxyBase}: ${e.message}`);
    }
  }

  console.log('\n' + '='.repeat(64));
  console.log('🎉 注册完成');
  console.log('='.repeat(64));
  console.log(JSON.stringify({ ...result, sessionKey: result.sessionKey.slice(0, 12) + '…' }, null, 2));
}

main()
  .catch((e) => {
    console.error(`\n❌ 失败: ${e.message}`);
    if (process.env.DEBUG) console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    try { globalThis.__localBrowser?.close(); } catch { /* noop */ }
  });

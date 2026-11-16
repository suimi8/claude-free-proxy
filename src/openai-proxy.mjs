#!/usr/bin/env node
/**
 * openai-proxy.mjs —— 把 Claude Desktop (free 账号) 的上游反代成 OpenAI 兼容接口
 *
 * 上游不是 Anthropic 官方 API，而是 Claude Desktop 真正在用的 claude.ai completion 接口：
 *
 *   POST https://claude.ai/api/organizations/{org}/chat_conversations          (建会话)
 *   POST https://claude.ai/api/organizations/{org}/chat_conversations/{id}/completion
 *
 * 认证用 Desktop profile 里解密出的 sessionKey + cf_clearance cookie，
 * UA 必须与 cf_clearance 绑定（Electron 45.2.1 -> Chrome 140），否则触发 Cloudflare 挑战。
 *
 * 上游实测约束（自由档）：
 *   - 接受 prompt / model / parent_message_uuid / timezone / attachments /
 *     files / rendering_mode / tools / effort / top_p
 *     files = file_uuid 字符串数组：图片先 POST /api/{org}/upload 换 uuid 再填进来
 *     （attachments 是文本附件，需要 extracted_content，图片不走它）
 *   - system、max_tokens、temperature、thinking、reasoning_effort 等传了会
 *     400 "Extra inputs are not permitted"
 *   - extended thinking 的开关是 effort 字段（枚举 low/medium/high/xhigh/max，
 *     high 起才出思考块；上游只回 thinking_summary_delta 摘要，原始 CoT 不给）
 *     -> 客户端的 thinking/reasoning_effort 统一映射成 effort（见 pickEffort）
 *   - 永远返回 SSE（即使不带 stream）
 *   - 响应里没有 usage 字段 -> 本地估算
 *
 * 多账号：accounts.json 里存 N 个 sessionKey，按策略轮询，每账号有并发上限，
 * 挂了自动冷却并 failover 到下一个账号。
 *
 * 对外端点：
 *   GET  /                        WebUI 管理界面（/ui 同；页面免鉴权，API 调用带 key）
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream / 非 stream / tools)
 *   POST /v1/responses          (OpenAI Responses API)
 *   POST /v1/messages           (Anthropic 格式 -> 同一上游)
 *   GET  /healthz
 *   GET  /v1/accounts           账号列表（sessionKey 打码，含额度/切走标记）
 *   POST /v1/accounts           添加账号 {label, sessionKey, org?}
 *   PATCH /v1/accounts/{id}     {enabled, label, org}
 *   DELETE /v1/accounts/{id}    删除账号
 *   GET  /v1/accounts/{id}/test 连通性测试（org 发现，不耗额度）
 *   POST /v1/accounts/{id}/quota 主动查额度（取 message_limit + rate_limits，消耗 1 条最小消息）
 *   POST /v1/accounts/refresh   重新从 Desktop 解密
 *   POST /v1/pool               {strategy, perAccountConcurrency, minQuotaRemaining}
 *   GET  /v1/usage              token 用量汇总（range=today|yesterday|7d|all，可按账号/模型过滤）
 *   GET  /v1/usage/logs         请求明细日志
 *   GET  /v1/usage              token 用量汇总（range=today|yesterday|7d|all，可按账号/模型过滤）
 *   GET  /v1/usage/logs         请求明细日志
 *   POST /v1/login              发起「链接登录」：打开浏览器登录 claude.ai，自动捕获凭据入池
 *   GET  /v1/login/{id}         登录进度  |  POST /v1/login/{id}/cancel  取消
 *   GET  /login/{id}            登录状态页（免鉴权，可复制到任意浏览器打开）
 *
 * 用法:
 *   node openai-proxy.mjs
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AccountPool, discoverOrg, DEFAULT_UA, sleep } from './accounts.mjs';
import { createLoginManager, loginPage } from './login-link.mjs';
import { createConfigStore } from './config.mjs';
import { probeQuota } from './quota-probe.mjs';
import { checkKyc } from './kyc.mjs';
import { createUsageLog, prefixOf } from './usage-log.mjs';
import { fetch as undiciFetch } from 'undici';
import { pruneMessageImages, pruneToolOutputs, optimizeContext } from './context-optimizer.mjs';
import { getSharedDispatcher } from './network-optimizer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.existsSync(path.join(HERE, '..', 'start.cmd')) || fs.existsSync(path.join(HERE, '..', 'LICENSE'))
  ? path.resolve(HERE, '..')
  : HERE;

const UPSTREAM_FILE = process.env.UPSTREAM_FILE || (fs.existsSync(path.join(ROOT, 'upstream.json')) ? path.join(ROOT, 'upstream.json') : path.join(ROOT, 'config', 'upstream.json'));
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || (fs.existsSync(path.join(ROOT, 'accounts.json')) ? path.join(ROOT, 'accounts.json') : path.join(ROOT, 'config', 'accounts.json'));
const SESSION_SCRIPT = fs.existsSync(path.join(ROOT, 'tools', 'desktop_session.py'))
  ? path.join(ROOT, 'tools', 'desktop_session.py')
  : path.join(HERE, 'desktop_session.py');

/**
 * 配置全部来自 config.json（端口 / 监听地址 / 各 API Key）。
 * 环境变量只作为临时覆盖，方便调试；代码里不内置任何密钥。
 */
const CONFIG_FILE = process.env.CONFIG_FILE || (fs.existsSync(path.join(ROOT, 'config.json')) ? path.join(ROOT, 'config.json') : path.join(ROOT, 'config', 'config.json'));
const KEYS = createConfigStore(CONFIG_FILE);
KEYS.load();
const _srv = KEYS.serverConfig();

const PORT = +(process.env.PORT || _srv.port || 8787);
// 默认只监听回环（本机）。要让手机 / 另一台电脑用，在 config.json 里把 host 改成 0.0.0.0。
const HOST = process.env.HOST || _srv.host || '127.0.0.1';
const isLanExposed = HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1';
// 兼容旧行为：仍支持 LOCAL_API_KEY 作为「额外」的等价 key（不再是唯一凭据）
const LEGACY_KEY = process.env.LOCAL_API_KEY || '';

/** 本机所有地址（回环 + 各网卡），用于判断「是不是这台机器在访问」 */
let _localIps = null;
function localIpSet() {
  if (!_localIps) {
    _localIps = new Set(['127.0.0.1', '::1']);
    try {
      for (const n of Object.values(os.networkInterfaces()).flat()) {
        if (n && n.address) _localIps.add(n.address.replace(/^::ffff:/, ''));
      }
    } catch (e) { /* 拿不到就只认回环 */ }
  }
  return _localIps;
}

/**
 * 请求是否来自「本机」（回环，或用本机的局域网 IP 访问自己）。
 * 用于限制「链接登录」等只该在运行反代的机器上操作的端点。
 */
function isLoopbackReq(req) {
  const ip = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return localIpSet().has(ip);
}

// 硬性保护：开放局域网却一个 key 都没有，等于把账号额度公开给整个网络
if (isLanExposed && KEYS.keyCount() === 0) {
  console.error('[openai-proxy] 拒绝启动：host=' + HOST + ' 表示对外开放，但 config.json 里没有任何 API Key');
  console.error('[openai-proxy]   打开 config.json 添加一个 keys 条目（或用 WebUI / POST /v1/keys 创建）');
  process.exit(1);
}
const TZ = process.env.TZ || 'Asia/Shanghai';

function loadUpstream() {
  try { return JSON.parse(fs.readFileSync(UPSTREAM_FILE, 'utf8')); } catch { return {}; }
}
let UP = loadUpstream();

/** 账号池 */
const POOL = new AccountPool(ACCOUNTS_FILE, {
  strategy: process.env.ACCOUNT_STRATEGY || '',
});

/** 请求级用量日志（按账号 / 按小时 / 全局聚合；CACHE_MODE=off|stats|reuse） */
const USAGE = createUsageLog({
  dir: process.env.USAGE_DIR || path.join(ROOT, 'usage'),
});

/**
 * 按账号的 token 累计（权威口径：完整输入含缓存 + 输出，且包含失败请求）。
 * /v1/accounts 被 WebUI 每 3 秒轮询，日志会随天数增长，所以做 30 秒缓存。
 */
let ACCT_TOKENS = { at: 0, map: new Map() };
function accountTokenStats() {
  const now = Date.now();
  if (ACCT_TOKENS.map.size && now - ACCT_TOKENS.at < 30000) return ACCT_TOKENS.map;
  try {
    const u = USAGE.summary('all');
    ACCT_TOKENS = { at: now, map: new Map((u.by_account || []).map(x => [x.account_id, x])) };
  } catch (e) { /* 读日志失败就沿用上一次结果 */ }
  return ACCT_TOKENS.map;
}

/**
 * 「链接登录」管理器：捕获后直接写入账号池（以 sessionKey 去重，重复登录不会新增账号）。
 * label 用组织名 + 日期，方便区分多账号；cf_clearance / UA 一并保存，避免 CF 挑战。
 */
const LOGIN = createLoginManager({
  baseUrl: `http://127.0.0.1:${PORT}`,
  webBase: () => UP.web_base || 'https://claude.ai',
  timeoutMs: +(process.env.LOGIN_TIMEOUT_MS || 5 * 60 * 1000),
  onCapture: ({ sessionKey, cookie, ua, org, name, plan }) => {
    const label = `${(name || 'claude.ai').slice(0, 28)} · ${new Date().toLocaleDateString('zh-CN')}`;
    const { account, created } = POOL.add({
      label, sessionKey, cookie, ua, org,
      base: UP.web_base || 'https://claude.ai',
      source: 'link',
    });
    console.log(`[login] captured account ${account.id} label=${label} org=${org} plan=${plan || '-'} created=${created}`);
    return { id: account.id, label: account.label, org: account.org, created };
  },
});

/**
 * 把 upstream.json（Desktop 解密产物）同步进账号池。
 * 以 sessionKey 为幂等键，每次刷新都会覆盖 cookie/org。
 */
function syncDesktopAccount(up) {
  if (!up?.web_session_key) return null;
  return POOL.upsert({
    label: up.web_account_label || 'desktop',
    sessionKey: up.web_session_key,
    cookie: up.web_cookie || '',
    org: up.web_org || '',
    ua: up.web_ua || DEFAULT_UA,
    base: up.web_base || undefined,
    source: 'desktop',
  });
}

/**
 * 异步刷新一次凭据（绝不阻塞事件循环）。
 *
 * 桌面端（claude.exe）运行时 Cookies 库被独占，python 侧会退避重试几秒；
 * 用 spawnSync 会把整个代理卡住同样久，所以必须走 spawn。
 * 失败时保留现有 upstream.json 凭据继续服务（sessionKey 很少变）。
 * 返回 Promise<boolean>，同时提供 non-void 结果给 /v1/accounts/refresh。
 */
let refreshing = null;   // 去重：同一时刻只跑一个刷新
function refreshSession(force = false) {
  // 非 Windows 平台（如 Linux/Docker）或显式关闭时跳过桌面端本地解密
  if (process.platform !== 'win32' || process.env.DESKTOP_SYNC === '0') return Promise.resolve(false);
  const age = Date.now() - (UP.web_cookie_at || 0);
  if (!force && age < 10 * 60 * 1000) return Promise.resolve(false);
  if (refreshing) return refreshing;                                      // 已有一次在跑，复用
  refreshing = new Promise((resolve) => {
    let out = '', err = '';
    let done = false;
    const p = spawn('python', [SESSION_SCRIPT]);
    p.stdout?.on('data', d => { out += d; });
    p.stderr?.on('data', d => { err += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 60000);
    const finish = (ok, why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      refreshing = null;
      if (ok) {
        UP = loadUpstream();
        const acct = syncDesktopAccount(UP);
        console.log('[creds] session refreshed:', out.trim());
        if (acct) console.log(`[pool] desktop account -> ${acct.label} org=${acct.org}`);
      } else if (why !== undefined) {
        console.warn('[creds] refresh failed:', (err || out || why || '').trim().slice(0, 300));
      }
      resolve(ok);
    };
    p.on('error', e => finish(false, e.message));
    p.on('close', code => finish(code === 0, `exit ${code}`));
  }).finally(() => { refreshing = null; });
  return refreshing;
}

// ---------------------------------------------------------------- 上游请求
function webHeaders(acct) {
  return {
    'cookie': acct.cookie || `sessionKey=${acct.sessionKey}`,
    'user-agent': acct.ua || DEFAULT_UA,
    'accept': 'application/json, text/event-stream',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    'origin': acct.base || 'https://claude.ai',
    'referer': (acct.base || 'https://claude.ai') + '/',
    'sec-ch-ua': '"Chromium";v="140", "Not?A_Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };
}

function isChallenge(text) {
  return /Just a moment|cf-browser-verification|challenge-platform/i.test(text || '');
}

/**
 * 从上游 429 响应体里抠出「配额窗口恢复时刻」。
 * 上游把 exceeded_limit 塞在 error.message 里（还是一层转义后的 JSON），所以直接扫文本。
 * @returns {number|null} epoch 毫秒（上游给的是秒）
 */
function parseResetsAt(text) {
  if (!text) return null;
  const m = /resetsAt\\?":\s*(\d{9,})/.exec(text);
  if (!m) return null;
  let ts = +m[1];
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (ts < 1e12) ts *= 1000;          // 上游给的是秒
  return ts;
}

/** 配额窗口类型（five_hour / seven_day / per_model），只用于展示 */
function parseLimitReason(text) {
  const m = /representativeClaim\\?":\s*\\?"?([a-z_]+)/.exec(text || '');
  return m ? m[1] : '';
}

/** 把上游状态码/正文归类成 { kind, retryable, resetsAt, reason }，供池做冷却与 failover 决策 */
function classify(status, text) {
  if (isChallenge(text)) return { kind: 'challenge', retryable: true };
  if (status === 429) {
    // 上游有两种 429：账号并发满（concurrent_limit_reached，resetsAt 为 null）与
    // 配额用尽（exceeded_limit，resetsAt 是具体时间戳）。实测语料：并发型 103/103 含
    // resetsAt":null、配额型 0/38 含 null —— 所以 null 优先判，再退回 concurr 字样兜底。
    // 并发型等几秒即可恢复，绝不能按配额限流冷却 1~30 分钟。
    if (/resetsAt\\?":\s*null/.test(text || '')) return { kind: 'concurrency', retryable: true };
    if (/resetsAt\\?":\s*\d+/.test(text || '')) {
      // 配额用尽：带上精确恢复时刻 -> 列入「429 耗尽池」，到点自动回有效池
      return {
        kind: 'rate_limit', retryable: true,
        resetsAt: parseResetsAt(text), reason: parseLimitReason(text),
      };
    }
    if (/concurr/i.test(text || '')) return { kind: 'concurrency', retryable: true };
    return { kind: 'rate_limit', retryable: true };
  }
  if (status === 401 || status === 403) return { kind: 'auth', retryable: true };
  // 没有状态码 = fetch 网络层失败（DNS/连接重置/超时）；5xx = 上游抖动。
  // 两者都值得重试，且不排除账号（换个账号也可能撞上同一段网络问题）。
  if (status == null || status === 0) return { kind: 'transient', retryable: true };
  if (status >= 500) return { kind: 'transient', retryable: true };
  return { kind: 'error', retryable: false };   // 400 等：换账号也没用，别浪费
}

/** 客户端断连统一错误：不算上游故障，不触发账号冷却/失败计数 */
function clientGoneError() {
  return Object.assign(new Error('client disconnected'), {
    name: 'AbortError', kind: 'client_gone', retryable: false, status: 499,
  });
}

/**
 * fetch 包装：网络层 reject（fetch failed / ECONNRESET / 超时）没有状态码，
 * 单独归类成 transient，避免被当成 400 类"不可重试"错误直接打挂整个请求。
 * 客户端断连触发的 AbortError 单独上抛（绝不能按 transient 冷却账号）。
 */
async function upstreamFetch(url, init = {}) {
  try {
    const dispatcher = getSharedDispatcher();
    return await undiciFetch(url, { ...init, dispatcher });
  } catch (e) {
    if (e?.name === 'AbortError' || init?.signal?.aborted) throw clientGoneError();
    const inner = e?.cause ? `: ${e.cause.code || e.cause.message || e.cause}` : '';
    throw Object.assign(new Error(`upstream network error: ${e?.message || e}${inner}`),
      { status: 0, kind: 'transient', retryable: true });
  }
}

function upstreamError(msg, status, text) {
  const { kind, retryable, resetsAt, reason } = classify(status, text);
  return Object.assign(new Error(msg), { status, kind, retryable, resetsAt, reason });
}

async function createConversation(acct, name, signal) {
  const uuid = randomUUID();
  const base = acct.base || 'https://claude.ai';
  const r = await upstreamFetch(`${base}/api/organizations/${acct.org}/chat_conversations`, {
    method: 'POST',
    headers: webHeaders(acct),
    body: JSON.stringify({ uuid, name: (name || 'proxy').slice(0, 60), is_temporary: true }),
    signal,
  });
  const txt = await r.text();
  if (r.ok || r.status === 201) return uuid;
  if (isChallenge(txt)) {
    throw Object.assign(new Error('cloudflare_challenge'), { kind: 'challenge', retryable: true, status: 403 });
  }
  throw upstreamError(`create_conversation ${r.status}: ${txt.slice(0, 300)}`, r.status, txt);
}

/** 打上游 completion，返回 SSE 的 ReadableStream */
async function callCompletion(acct, convId, body, signal) {
  const base = acct.base || 'https://claude.ai';
  const url = `${base}/api/organizations/${acct.org}/chat_conversations/${convId}/completion`;
  const r = await upstreamFetch(url, {
    method: 'POST', headers: webHeaders(acct), body: JSON.stringify(body), signal,
  });
  if (!r.ok) {
    const txt = await r.text();
    if (isChallenge(txt)) {
      throw Object.assign(new Error('cloudflare_challenge'), { kind: 'challenge', retryable: true, status: 403 });
    }
    throw upstreamError(`completion ${r.status}: ${txt.slice(0, 400)}`, r.status, txt);
  }
  return r.body;
}

// --------------------------------------------------- 图片：采集 / 下载 / 上传
//
// 上游 claude.ai 的图片不走 attachments（那是文本附件，必须带 extracted_content），
// 走 files：completion 请求体里 files 是 file_uuid 字符串数组（已实测通过 schema 校验，
// 形状不对会 400 "Could not parse request body"，对了才轮到 429 限流）。
// 流程：解析请求里的图片 -> POST /api/{org}/upload 换 file_uuid -> 填进 files。
//
// prompt 里的图片位置保留 [image] 占位符；某张图传不上去时不打断请求，
// 而是在 prompt 末尾追加一句失败说明，让模型知道自己"看不到图"。
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;   // 单图字节上限（本地先挡，超了上游也会 400）
const IMAGE_CACHE = new Map();              // `${acctId}\n${sha256(bytes)}` -> { uuid, at }（按账号隔离）
const IMAGE_CACHE_TTL = 60 * 60 * 1000;     // uuid 缓存 1 小时：过期宁可重传，也不拿失效 uuid 撞 400
const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/bmp': 'bmp',
};

function imgError(msg, retryable, status = 400) {
  return Object.assign(new Error(msg), {
    retryable, status, kind: retryable ? 'transient' : 'error',
  });
}

/** data:image/png;base64,xxxx -> { bytes, mime }；不是 image/* 或解不出来返回 null */
function parseDataUrl(s) {
  const m = /^data:([^;,]+)?(;charset=[^;,]+)?(;base64)?,(.*)$/s.exec(s);
  if (!m) return null;
  const mime = (m[1] || '').toLowerCase();
  if (!mime.startsWith('image/')) return null;
  try {
    const bytes = m[3] ? Buffer.from(m[4], 'base64') : Buffer.from(decodeURIComponent(m[4]), 'utf8');
    if (!bytes.length) return null;
    return { bytes, mime };
  } catch {
    return null;
  }
}

/** 取到图片字节：data URL 直接解码；http(s) URL 匿名下载（绝不带账号 cookie） */
async function resolveImage(ref, signal) {
  const s = String(ref || '').trim();
  if (!s) throw imgError('图片引用为空', false);
  if (s.startsWith('data:')) {
    const p = parseDataUrl(s);
    if (!p) throw imgError('无法解析的图片 data URL（非 image/* 或 base64 坏损）', false);
    if (p.bytes.length > MAX_IMAGE_BYTES) throw imgError(`图片过大 ${p.bytes.length}B > ${MAX_IMAGE_BYTES}B`, false);
    return { ...p, name: `image.${EXT_BY_MIME[p.mime] || 'bin'}` };
  }
  if (/^https?:\/\//i.test(s)) {
    const sigs = [AbortSignal.timeout(30000)];
    if (signal) sigs.push(signal);
    let r;
    try {
      const dispatcher = getSharedDispatcher();
      r = await undiciFetch(s, {
        redirect: 'follow', signal: AbortSignal.any(sigs),
        headers: { accept: 'image/*,*/*;q=0.8', 'user-agent': DEFAULT_UA },
        dispatcher,
      });
    } catch (e) {
      // 下载失败与账号无关，换账号也没用 -> 不可重试，由调用方记进失败说明
      throw imgError(`下载远程图片失败: ${e?.message || e}`, false);
    }
    if (!r.ok) throw imgError(`下载远程图片 HTTP ${r.status}`, false);
    const mime = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    if (!mime.startsWith('image/')) throw imgError(`远程资源不是图片: ${mime}`, false);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (!bytes.length) throw imgError('远程图片内容为空', false);
    if (bytes.length > MAX_IMAGE_BYTES) throw imgError(`远程图片过大 ${bytes.length}B > ${MAX_IMAGE_BYTES}B`, false);
    return { bytes, mime, name: `image.${EXT_BY_MIME[mime] || 'bin'}` };
  }
  throw imgError(`不支持的图片引用（仅 data URL / http(s)）: ${s.slice(0, 60)}`, false);
}

/** 内容里是否有能抽出图片的块（用于决定要不要保留块数组而不是压成字符串） */
function hasImgBlocks(content) {
  return Array.isArray(content) && imagesOfContent(content).length > 0;
}

/** 从 chat / anthropic 内容块里抽出图片引用（data URL 或 http(s) URL） */
function imagesOfContent(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const t = typeof c.type === 'string' ? c.type : '';
    if (t === 'image_url') {
      const u = typeof c.image_url === 'string' ? c.image_url : c.image_url?.url;
      if (typeof u === 'string' && u) out.push(u);
      continue;
    }
    if (!t.includes('image')) continue;
    const src = c.source;
    if (src && src.type === 'base64' && typeof src.data === 'string') {
      out.push(`data:${src.media_type || 'image/png'};base64,${src.data}`);
    } else if (typeof src?.url === 'string' && src.url) out.push(src.url);
    else if (typeof c.image_url === 'string' && c.image_url) out.push(c.image_url);
    else if (typeof c.image_url?.url === 'string' && c.image_url.url) out.push(c.image_url.url);
    else if (typeof c.url === 'string' && c.url) out.push(c.url);
    else if (typeof c.data === 'string' && c.data) {
      out.push(`data:${c.media_type || c.mime_type || 'image/png'};base64,${c.data}`);
    }
    // 其余形状（source.type=file / file_id 等）取不到字节，不进列表，只留 [image] 占位
  }
  return out;
}

/**
 * 本轮要上传的图片：按 renderPrompt 的渲染顺序收集**全部**消息里的图片。
 *
 * 上游 files 与 prompt 里的 [image] 占位是一一对应、按出现顺序配对的，
 * 所以两者必须同序同集合。之前只取最后一条 user 消息，一旦图片不在最后
 * 一条 user 消息里（历史图 / harness 把图和文字拆成多条消息发），
 * prompt 里有 [image] 占位、files 里却没有对应文件 —— 模型只看到占位文字，
 * 于是回复「无法识图」。
 *
 * 遍历顺序对齐 renderPrompt：先 system/developer（进 [SYSTEM] 段，body.system
 * 不走 textOf 不会产生占位），再按消息顺序处理其余角色；renderPrompt 不渲染
 * 的角色直接跳过（它们不会产生占位，收了反而让 files 多出对不上的项）。
 */
function collectImages(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const rendered = m => m && (m.role === 'system' || m.role === 'developer' ||
    m.role === 'user' || m.role === 'assistant' || m.role === 'tool' || m.role === 'function');
  const isSys = m => m.role === 'system' || m.role === 'developer';
  const out = [];
  for (const m of msgs) if (rendered(m) && isSys(m)) out.push(...imagesOfContent(m.content));
  for (const m of msgs) if (rendered(m) && !isSys(m)) out.push(...imagesOfContent(m.content));
  return out;
}

/** 上传单张图，返回 file_uuid；失败按 classify 归类（可重试的上抛交给 failover） */
async function uploadOne(acct, img, signal) {
  const base = acct.base || 'https://claude.ai';
  const headers = webHeaders(acct);
  delete headers['content-type'];        // FormData 必须自带 multipart boundary
  const form = new FormData();
  form.append('file', new Blob([img.bytes], { type: img.mime }), img.name);
  const r = await upstreamFetch(`${base}/api/${acct.org}/upload`, {
    method: 'POST', headers, body: form, signal,
  });
  if (!r.ok) {
    const txt = await r.text();
    if (isChallenge(txt)) {
      throw Object.assign(new Error('cloudflare_challenge'), { kind: 'challenge', retryable: true, status: 403 });
    }
    const { kind, retryable, resetsAt, reason } = classify(r.status, txt);
    throw Object.assign(new Error(`upload ${r.status}: ${txt.slice(0, 300)}`),
      { status: r.status, kind, retryable, resetsAt, reason });
  }
  let j;
  try { j = await r.json(); } catch {
    throw imgError('upload 响应不是 JSON', true, 502);
  }
  const uuid = j.file_uuid || j.uuid;
  if (!uuid) throw imgError(`upload 没有 file_uuid: ${JSON.stringify(j).slice(0, 200)}`, true, 502);
  return uuid;
}

/**
 * 批量上传图片，返回 { uuids, failed }。
 * - 全量并发上传，大幅降低多张历史图片和换号 failover 时的等待耗时
 * - 可重试错误（429/401/403/5xx/网络/挑战）上抛 -> runCompletion 换账号或排队
 * - 不可重试（400 不支持、过大、远程下载失败）吞掉 -> 记进 failed，由调用方写进 prompt
 * - 同一张图（同账号）只传一次，结果按 sha256 缓存
 */
async function uploadImages(acct, images, signal) {
  const tasks = images.map(async ref => {
    if (signal?.aborted) throw clientGoneError();
    try {
      const img = await resolveImage(ref, signal);
      const key = `${acct.id}\n${createHash('sha256').update(img.bytes).digest('hex')}`;
      const hit = IMAGE_CACHE.get(key);
      let uuid = hit && Date.now() - hit.at < IMAGE_CACHE_TTL ? hit.uuid : null;
      if (!uuid) {
        uuid = await uploadOne(acct, img, signal);
        IMAGE_CACHE.set(key, { uuid, at: Date.now() });
        if (IMAGE_CACHE.size > 512) IMAGE_CACHE.delete(IMAGE_CACHE.keys().next().value);
      }
      return { ok: true, uuid };
    } catch (e) {
      if (e?.name === 'AbortError' || signal?.aborted) throw clientGoneError();
      if (e?.retryable) throw e;
      console.warn(`[image] 本张跳过: ${String(e.message || e).slice(0, 160)}`);
      return { ok: false, err: String(e.message || e).slice(0, 160) };
    }
  });

  const results = await Promise.all(tasks);
  const uuids = results.filter(r => r.ok).map(r => r.uuid);
  const failed = results.filter(r => !r.ok).map(r => r.err);
  return { uuids, failed };
}

// --------------------------------------------------- OpenAI -> 上游 prompt
function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => {
      if (typeof c === 'string') return c;
      if (!c || typeof c !== 'object') return '';
      if (typeof c.type === 'string' && c.type.includes('image')) return '[image]';  // 图片留占位，真实内容在 files 里
      if (typeof c.text === 'string') return c.text;
      if (typeof c.content === 'string') return c.content;
      if (Array.isArray(c.content)) return textOf(c.content);
      if (typeof c.refusal === 'string') return c.refusal;
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

// ---- 上下文智能瘦身 (Context Pruner) -------------------------------------
// 针对编程 Agent (Codex/Cline/Claude Code 等) 历史轮次产生的大文件、长终端日志输出，
// 保留首尾关键代码与结构，折叠中间冗余内容，彻底防止上下文滚雪球膨胀到十几万甚至上百万 Tokens。
// - 倒数最近 PRUNE_KEEP_RECENT_TOOLS 个工具输出 100% 完整保留（当前轮次绝不截断）
// - 超过 PRUNE_MAX_TOOL_CHARS 的更早历史工具输出折叠中间内容
// - 用户最新的一轮输入、系统指令 100% 完整保留
const PRUNE_ENABLED = process.env.PRUNE_CONTEXT !== 'off';
const PRUNE_MAX_TOOL_CHARS = +(process.env.PRUNE_MAX_TOOL_CHARS || 8000); // 历史工具结果上限（约 2000 Tokens）
const PRUNE_KEEP_RECENT_TOOLS = +(process.env.PRUNE_KEEP_RECENT_TOOLS || 4); // 最近几个工具输出全量保留

function cleanTerminalNoise(text) {
  if (!text || typeof text !== 'string') return text;
  // 1. 去除 ANSI 颜色与终端控制码
  let s = text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  // 2. 清理终端覆盖式进度条 (如 npm/pip 产生的海量 \r 重绘，只保留每行最后一次绘制)
  if (s.includes('\r')) {
    s = s.split('\n').map(l => {
      const idx = l.lastIndexOf('\r');
      return idx >= 0 ? l.slice(idx + 1) : l;
    }).join('\n');
  }
  return s;
}

function pruneToolText(text, maxChars = PRUNE_MAX_TOOL_CHARS) {
  if (!text || text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.6); // 保留头部 60% (如 import、函数声明)
  const tailLen = Math.floor(maxChars * 0.3); // 保留尾部 30% (如 return、报错摘要、结尾)
  const omitted = text.length - (headLen + tailLen);
  if (omitted <= 300) return text;
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  return `${head}\n\n[...反代智能瘦身: 中间省略 ${omitted} 字符 (历史工具输出已折叠，不影响当前任务)...]\n\n${tail}`;
}

/**
 * 上游只有一个 prompt 字段，所以把整个 messages 历史渲染成一段结构化文本。
 * system 单独抽出来放最前面（上游不接受 system 字段）。
 */
function renderPrompt(body) {
  const parts = [];
  const systems = [];
  if (typeof body.system === 'string') systems.push(body.system);
  else if (Array.isArray(body.system)) systems.push(...body.system.map(s => (typeof s === 'string' ? s : s.text)));

  const msgs = body.messages || [];

  const pruneEnabled = (typeof POOL?.data?.pruneContext === 'boolean') ? POOL.data.pruneContext : PRUNE_ENABLED;
  const pruneMaxChars = (typeof POOL?.data?.pruneMaxToolChars === 'number') ? POOL.data.pruneMaxToolChars : PRUNE_MAX_TOOL_CHARS;
  const pruneKeepRecent = (typeof POOL?.data?.pruneKeepRecentTools === 'number') ? POOL.data.pruneKeepRecentTools : PRUNE_KEEP_RECENT_TOOLS;

  // 找出所有 tool/function 角色的消息索引
  const toolIndices = [];
  for (let idx = 0; idx < msgs.length; idx++) {
    const role = msgs[idx]?.role;
    if (role === 'tool' || role === 'function') {
      toolIndices.push(idx);
    }
  }

  // 只有倒数 pruneKeepRecent 个工具输出保留完整，更早的历史工具结果允许瘦身
  const recentToolThresholdIdx = toolIndices.length > pruneKeepRecent
    ? toolIndices[toolIndices.length - pruneKeepRecent]
    : -1;

  let prunedCount = 0;
  let savedChars = 0;

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'system' || m.role === 'developer') {
      systems.push(textOf(m.content));
      continue;
    }
    if (m.role === 'user') {
      const uText = cleanTerminalNoise(textOf(m.content));
      parts.push(`[USER]\n${uText}`);
    } else if (m.role === 'assistant') {
      let t = textOf(m.content);
      for (const tc of m.tool_calls || []) {
        t += `\n[TOOL_CALL ${tc.function?.name || 'unknown'}] ${tc.function?.arguments || '{}'}`;
      }
      parts.push(`[ASSISTANT]\n${t || '(no content)'}`);
    } else if (m.role === 'tool' || m.role === 'function') {
      let rawText = cleanTerminalNoise(textOf(m.content));
      if (pruneEnabled && i < recentToolThresholdIdx && rawText.length > pruneMaxChars) {
        const pruned = pruneToolText(rawText, pruneMaxChars);
        savedChars += (rawText.length - pruned.length);
        prunedCount++;
        rawText = pruned;
      }
      parts.push(`[TOOL_RESULT ${m.name || m.tool_call_id || ''}]\n${rawText}`);
    }
  }

  // 避免模型在长上下文中受历史 [TOOL_CALL] 纯文本影响产生模仿幻觉，同时抑制官方网页端特有的 /mnt/skills 和 view 内部工具
  const hasTools = (Array.isArray(body?.tools) && body.tools.length > 0) ||
                   (Array.isArray(body?.functions) && body.functions.length > 0);
  systems.push(
    '[ENVIRONMENT & TOOL CONSTRAINTS]\n' +
    '1. You are running in an external API coding environment. Sandboxed directories like "/mnt/skills" and internal sandbox tools such as "view", "repl", or "artifacts" do NOT exist here.\n' +
    '2. NEVER attempt to call "view" or inspect "/mnt/skills/...". Answer or execute directly using available tools.' +
    (hasTools ? '\n3. You are equipped with real tools via native tool_use. The tags "[TOOL_CALL ...]" in previous messages are historical markers only. Invoke only the tools explicitly declared in the tools list, and NEVER output literal "[TOOL_CALL ...]" markers.' : '')
  );

  let prompt = '';
  if (systems.length) prompt += `[SYSTEM]\n${systems.join('\n\n')}\n\n`;
  prompt += parts.join('\n\n');

  if (prunedCount > 0 && savedChars > 0) {
    console.log(`[prune] 上下文智能瘦身: 修剪了 ${prunedCount} 处历史工具大输出, 节省约 ${savedChars} 字符 (~${Math.round(savedChars / 4)} Tokens)`);
  }

  return prompt.trim() || 'hi';
}

function mapModel(m) {
  const s = (m || '').toLowerCase();
  if (s.includes('haiku')) return 'claude-haiku-5-5';
  // free 档没有 Opus / Fable 权限，降级到 Sonnet
  return 'claude-sonnet-5-5';
}

/**
 * 工具定义归一化：把各种协议形状统一成内部 function 形状。
 *
 * 之前 responsesToChat 直接丢掉 type=custom / hosted 工具，导致 Codex CLI 等
 * 客户端声明的 bash_tool / local_shell 全部消失，模型却仍按 instructions 以为
 * 有工具可用 -> 发出调用后被工具层拒绝（unsupported call: bash_tool）。
 *
 * 覆盖：
 *   - chat completions: {type:'function', function:{name, description, parameters}}
 *   - responses function: {type:'function', name, description, parameters}
 *   - responses custom:  {type:'custom', name, description, format/schema}
 *   - hosted:            {type:'local_shell'|'web_search'|...}
 *   - anthropic:         {name, description, input_schema}
 */
function normalizeTool(t) {
  if (!t || typeof t !== 'object') return null;
  const f = (t.function && typeof t.function === 'object') ? t.function : t;
  const name = f.name || t.name || (typeof t.type === 'string' ? t.type : '');
  if (!name) return null;
  const schema = f.parameters || f.input_schema || t.parameters || t.input_schema ||
    t.schema || (t.format && typeof t.format === 'object' ? t.format : null) ||
    (t.custom && typeof t.custom === 'object' ? t.custom : null);
  return {
    type: 'function',
    name: String(name).slice(0, 64),
    description: String(f.description || t.description || '').slice(0, 1000),
    parameters: (schema && typeof schema === 'object' && !Array.isArray(schema))
      ? schema : { type: 'object', properties: {} },
  };
}

function mapTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = [];
  for (const t of tools) {
    const n = normalizeTool(t);
    if (!n) continue;
    out.push({ name: n.name, description: n.description, input_schema: n.parameters });
  }
  return out.length ? out : undefined;
}

/**
 * 伪工具调用提取器 (Fallback Tool Call Extractor):
 * 在多轮 Agent 长会话中，Claude 模型若产生幻觉直接在正文输出了
 * `[TOOL_CALL <func_name>] <json_arguments>`，本函数将其自动解析并剔除，
 * 转换为 OpenAI 标准的 tool_calls 列表，避免客户端卡死或断连。
 */
function extractPseudoToolCalls(fullText) {
  if (!fullText || typeof fullText !== 'string') return { cleanText: fullText || '', toolCalls: [] };
  
  const markerRegex = /\[TOOL_CALL(?::|\s+)?([a-zA-Z0-9_\-\.]+)\s*\]/g;
  let match;
  const matches = [];
  while ((match = markerRegex.exec(fullText)) !== null) {
    matches.push({
      name: match[1],
      startIndex: match.index,
      argsStart: match.index + match[0].length,
    });
  }

  if (matches.length === 0) {
    return { cleanText: fullText, toolCalls: [] };
  }

  const toolCalls = [];
  let firstCallIdx = fullText.length;

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const nextStart = (i + 1 < matches.length) ? matches[i + 1].startIndex : fullText.length;
    let candidate = fullText.slice(cur.argsStart, nextStart).trim();

    let parsedArgs = null;
    let jsonStr = candidate;

    const braceStart = candidate.indexOf('{');
    if (braceStart !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;
      let braceEnd = -1;
      for (let pos = braceStart; pos < candidate.length; pos++) {
        const ch = candidate[pos];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              braceEnd = pos;
              break;
            }
          }
        }
      }
      if (braceEnd !== -1) {
        jsonStr = candidate.slice(braceStart, braceEnd + 1);
      }
    }

    try {
      JSON.parse(jsonStr);
      parsedArgs = jsonStr;
    } catch {
      parsedArgs = JSON.stringify({ input: jsonStr });
    }

    toolCalls.push({
      id: 'call_' + randomUUID().replace(/-/g, '').slice(0, 9),
      type: 'function',
      function: {
        name: cur.name,
        arguments: parsedArgs,
      },
    });

    if (cur.startIndex < firstCallIdx) {
      firstCallIdx = cur.startIndex;
    }
  }

  const cleanText = fullText.slice(0, firstCallIdx).trimEnd();
  return { cleanText, toolCalls };
}

function buildUpstreamBody(body, model) {
  const out = {
    prompt: renderPrompt(body),
    model,
    parent_message_uuid: randomUUID(),   // 首条消息用随机 uuid，上游会 discard
    timezone: TZ,
    attachments: [],
    files: [],
    rendering_mode: 'messages',
  };
  const tools = mapTools(body.tools);
  if (tools) out.tools = tools;
  const effort = pickEffort(body);
  if (effort) out.effort = effort;
  return out;
}

// ---- extended thinking ----------------------------------------------------
// 实测（2026-11）：上游不认 thinking / reasoning_effort / extended_thinking 等字段
// （schema 拒绝 400 "Extra inputs are not permitted"），认的是 effort 字段，
// 枚举 low/medium/high/xhigh/max —— low/medium 不思考，high 起才出 thinking 块，
// 档位越高思考越久（同题实测 6.5s / 7.6s / 11.8s，对照不思考 5.9s）。
// 上游只回 thinking_summary_delta（思考摘要），原始 CoT 被 truncated 扣留。
// 客户端的思考意图统一映射成 effort；谁都没传时用 DEFAULT_EFFORT。
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT = EFFORTS.includes(String(process.env.DEFAULT_EFFORT || '').toLowerCase())
  ? String(process.env.DEFAULT_EFFORT).toLowerCase() : 'max';   // 用户选定：默认 max

function pickEffort(body) {
  const curDef = (POOL?.data?.defaultEffort && EFFORTS.includes(POOL.data.defaultEffort))
    ? POOL.data.defaultEffort
    : DEFAULT_EFFORT;
  if (!body || typeof body !== 'object') return curDef;
  const norm = v => (typeof v === 'string' && EFFORTS.includes(v.toLowerCase())) ? v.toLowerCase() : null;
  const direct = norm(body.effort);                       // 客户端直接发 effort（透传）
  if (direct) return direct;
  const re = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.toLowerCase() : '';
  if (re === 'none' || re === 'off') return null;         // 显式关闭思考
  if (re === 'minimal') return 'low';                     // OpenAI minimal -> 最低档
  const mapped = norm(re);
  if (mapped) return mapped;
  const th = body.thinking;
  if (th && typeof th === 'object') {
    if (th.type === 'disabled') return null;              // Anthropic 显式关
    if (th.type === 'enabled') {
      const b = +th.budget_tokens || 0;
      // budget 映射：>=10k max，>=4k xhigh，其余 high（high 是出思考块的最低档）
      return b >= 10000 ? 'max' : b >= 4096 ? 'xhigh' : 'high';
    }
  }
  return curDef;
}

// --------------------------------------------------- 上游 SSE -> OpenAI
function mapStopReason(r) {
  switch (r) {
    case 'tool_use': return 'tool_calls';
    case 'max_tokens': return 'length';
    case 'stop_sequence': return 'stop';
    case 'refusal': return 'content_filter';
    default: return 'stop';
  }
}

/** 把上游 SSE 流解析成事件数组（流式时边解析边回调） */
async function* parseSse(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const p = line.slice(5).trim();
          if (!p || p === '[DONE]') continue;
          try { yield JSON.parse(p); } catch { /* 忽略坏行 */ }
        }
      }
    }
  } finally {
    // 提前收尾时（上游说完了但连接还吊着）把 body 取消掉：
    // 既释放上游 socket，也让 undici 别继续往内存里灌这条流
    try { await reader.cancel(); } catch { /* noop */ }
    try { reader.releaseLock(); } catch { /* noop */ }
  }
}

function newChatId() { return `chatcmpl-${randomUUID()}`; }

/**
 * 归一化上游 SSE。
 *
 * 关键行为：上游发起 tool_use 后，会停在 content_block_stop 只发 ping，
 * 等客户端回传 tool_result（它是 agentic 多轮协议）。但本反代是无状态的 ——
 * 客户端拿到 tool_calls 后会自己执行工具、再发一个新请求。
 * 所以一旦 tool_use block 全部结束又只等到 ping，就主动补上
 * message_delta(stop_reason=tool_use) + message_stop 收尾，否则连接永远挂着。
 */
async function* normalizeSse(stream, acct, ctx) {
  const pending = new Set();
  let sawTool = false;
  let ended = false;
  // 真实输出速度要靠「文本 + 时间轴」两头都准，所以这里分开记：
  //   textStr  可见正文（用户真正看到的字）
  //   thinkStr 思考摘要（上游只给截断版）
  //   jsonStr  工具入参（模型也生成了，但不算"输出正文"）
  let textStr = '';
  let thinkStr = '';
  let jsonStr = '';
  let firstDeltaAt = null;   // 第一个内容增量
  let firstTextAt = null;    // 第一个正文增量
  let lastDeltaAt = null;    // 最后一个内容增量
  let lastTextAt = null;     // 最后一个正文增量

  try {
  for await (const ev of parseSse(stream)) {
    // 上游会带 message_limit 事件（free 档 5h/7d 窗口用量），记到账号上供轮询策略用
    if (ev.type === 'message_limit' && acct) {
      POOL.updateQuota(acct, ev.message_limit);
    }
    if (ev.type === 'message_start' && ctx && ev.message?.uuid) {
      ctx.parent_uuid = ev.message.uuid;      // 供 CACHE_MODE=reuse 续聊
    }
    // 本地估算输出 token（上游不返回 usage，只累计"已用"，不是配额）
    if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      const now = Date.now();
      const piece = (typeof d.text === 'string' ? d.text.length : 0) +
        (typeof d.partial_json === 'string' ? d.partial_json.length : 0) +
        (typeof d.thinking === 'string' ? d.thinking.length : 0) +           // 思考增量
        (typeof d.summary?.summary === 'string' ? d.summary.summary.length : 0);  // 思考摘要
      if (piece) {
        if (firstDeltaAt == null) firstDeltaAt = now;
        lastDeltaAt = now;
        if (ctx && ctx.ttfb_ms == null) ctx.ttfb_ms = now - ctx.startedAt;   // 首字
      }
      if (typeof d.text === 'string' && d.text) {
        textStr += d.text;
        if (firstTextAt == null) firstTextAt = now;
        lastTextAt = now;
      } else if (typeof d.partial_json === 'string' && d.partial_json) {
        jsonStr += d.partial_json;
      } else if (typeof d.thinking === 'string' && d.thinking) {
        thinkStr += d.thinking;                       // 思考增量
      } else if (typeof d.summary?.summary === 'string' && d.summary.summary) {
        thinkStr += d.summary.summary;                // 思考摘要
      }
    }
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      sawTool = true;
      pending.add(ev.index);
      yield ev;
      continue;
    }
    if (ev.type === 'content_block_stop') {
      pending.delete(ev.index);
      yield ev;
      continue;
    }
    if (ev.type === 'ping') {
      if (sawTool && pending.size === 0 && !ended) {
        ended = true;
        yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } };
        yield { type: 'message_stop' };
        return;
      }
      continue;   // 普通心跳，丢给上层没有意义
    }
    if (ev.type === 'message_stop') {
      ended = true;
      yield ev;
      // 上游已经明确「这条回复结束了」，就立刻收尾，不要等它把连接关掉。
      //
      // claude.ai 的 free 档在内容发完后经常把 SSE 连接吊着不关（keep-alive），
      // 我们要是傻等到 EOF，这段纯空闲会被算进 latency —— 而 latency 正是
      // 客户端显示「输出速度」的分母，于是 258 个 token / 134 秒 = 1.9 tok/s。
      // 实测 94 个慢请求里 78 个的生成时间 ≡ 14.1s (mod 15s)，与输出量完全无关，
      // 就是这段吊着连接的时间。
      //
      // SSE_END_ON_STOP=0 可以恢复旧行为（等 EOF）。
      if (process.env.SSE_END_ON_STOP !== '0') break;
      continue;
    }
    yield ev;
  }
  } finally {
    // 真实 token 数：中文 1 字 1 token，其余 4 字符 1 token（见 countTokens）
    const textTokens = countTokens(textStr);
    const thinkTokens = countTokens(thinkStr);
    const jsonTokens = countTokens(jsonStr);
    const outTokens = Math.max(1, textTokens + thinkTokens + jsonTokens);
    if (acct) POOL.noteTokens(acct, 0, outTokens);
    if (ctx) {
      const end = Date.now();
      ctx.output_tokens = outTokens;
      ctx.text_tokens = textTokens;
      ctx.think_tokens = thinkTokens;
      ctx.latency_ms = end - ctx.startedAt;

      // ---- 真实输出速度：把时间轴拆开，别让空闲/思考混进分母 ----
      //   ttfb_ms  首字延迟（上游预填充 + 排队）
      //   think_ms 思考期（首个增量 -> 首个正文）
      //   write_ms 真正在写正文的那段时间（首正文 -> 末正文）
      //   idle_ms  最后一个增量之后到收尾之间的空闲（上游吊连接）
      //   gen_ms   整个吐字窗口（首增量 -> 末增量）
      ctx.gen_ms = (firstDeltaAt != null && lastDeltaAt != null) ? lastDeltaAt - firstDeltaAt : 0;
      ctx.write_ms = (firstTextAt != null && lastTextAt != null) ? lastTextAt - firstTextAt : 0;
      ctx.think_ms = (firstDeltaAt != null && firstTextAt != null) ? Math.max(0, firstTextAt - firstDeltaAt) : 0;
      ctx.idle_ms = (lastDeltaAt != null) ? Math.max(0, end - lastDeltaAt) : 0;
      // 真实出字速度：可见正文 token ÷ 真正在写正文的那段时间
      // 窗口太短（比如只回了一个字）算出来的速率没有意义，取最小窗口 100ms
      const MIN_WIN = 100;
      ctx.tps = ctx.write_ms >= MIN_WIN ? (textTokens / (ctx.write_ms / 1000)) : 0;
      // 端到端吐字速度（含思考摘要，口径接近客户端看到的）
      ctx.tps_e2e = ctx.gen_ms >= MIN_WIN ? (outTokens / (ctx.gen_ms / 1000)) : 0;
      // 老口径（输出 ÷ 收尾前的全部时间），留着对比用
      const legacyWin = end - ctx.startedAt - (ctx.ttfb_ms ?? 0);
      ctx.tps_legacy = legacyWin >= MIN_WIN ? (outTokens / (legacyWin / 1000)) : 0;
    }
  }
}

/** 非流式：吃完整个 SSE 再组装 */
async function collect(stream, acct, ctx, body = null) {
  let text = '';
  const thinkParts = [];   // thinking 块内容（上游只给摘要，多段用换行连接）
  const toolCalls = [];
  const slot = new Map();
  const ignoredToolIndices = new Set();
  const declaredToolNames = new Set((body?.tools || []).map(t => t.function?.name || t.name).filter(Boolean));
  let stop = null, model = null, id = null, limit = null;

  for await (const ev of normalizeSse(stream, acct, ctx)) {
    switch (ev.type) {
      case 'message_start':
        id = ev.message?.id; model = ev.message?.model; break;
      case 'content_block_start': {
        const cb = ev.content_block || {};
        if (cb.type === 'tool_use') {
          if (declaredToolNames.size > 0 && !declaredToolNames.has(cb.name) && (cb.name === 'view' || cb.name === 'repl' || cb.name === 'artifacts')) {
            console.warn(`[tool] 拦截未在客户端声明的内部沙盒工具调用: ${cb.name}`);
            ignoredToolIndices.add(ev.index);
            break;
          }
          const idx = slot.size;
          slot.set(ev.index, idx);
          toolCalls.push({ id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } });
        }
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta || {};
        if (d.type === 'text_delta') text += d.text;
        else if (d.type === 'thinking_summary_delta' || d.type === 'thinking_delta') {
          const s = d.type === 'thinking_delta' ? (d.thinking || '') : (d.summary?.summary || '');
          if (s) thinkParts.push(s);
        }
        else if (d.type === 'input_json_delta') {
          if (ignoredToolIndices.has(ev.index)) break;
          const idx = slot.get(ev.index) ?? 0;
          if (toolCalls[idx]) toolCalls[idx].function.arguments += d.partial_json || '';
        }
        break;
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
        break;
      case 'message_limit':
        limit = ev.message_limit; break;
      case 'error':
        throw new Error(ev.error?.message || 'upstream error');
      default: break;
    }
  }

  // 兜底补救：如果模型在正文中输出了伪工具指令且上游没出原生 tool_use，自动转换
  if (toolCalls.length === 0 && text) {
    const extracted = extractPseudoToolCalls(text);
    if (extracted.toolCalls.length > 0) {
      console.log(`[tool_fallback] (非流式) 检测到模型在正文中输出了伪工具指令，已自动转换为 ${extracted.toolCalls.length} 个原生 tool_calls`);
      return {
        text: extracted.cleanText,
        toolCalls: extracted.toolCalls,
        stop: 'tool_use',
        model, id, limit,
        reasoning: thinkParts.join('\n')
      };
    }
  }

  return { text, toolCalls, stop, model, id, limit, reasoning: thinkParts.join('\n') };
}

/** 流式：把上游事件逐个转成 OpenAI chunk 写出去 */
async function streamToClient(res, stream, model, chatId, acct, ctx, body = null) {
  const created = Math.floor(Date.now() / 1000);
  try { res.on('error', () => {}); } catch {}
  const send = o => {
    if (!res.writableEnded && !res.destroyed) {
      try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch {}
    }
  };
  const chunk = (delta, finish = null) =>
    send({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });

  // 定期发送 SSE 心跳保活，防止客户端或网关因空闲超时掐断连接（如 pi-ai stream idle timeout）
  const keepAliveTimer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      try { res.write(': keep-alive\n\n'); } catch { clearInterval(keepAliveTimer); }
    } else {
      clearInterval(keepAliveTimer);
    }
  }, 10000);

  let started = false;
  const slot = new Map();
  let stop = null;
  let sawTool = false;
  let reasoning = '';   // 累积思考（用于段间补换行，最终与非流式拼接结果一致）
  let accumulatedText = '';
  let sentTextLength = 0;
  let pseudoToolMode = false;
  let finishedSent = false;

  const declaredToolNames = new Set((body?.tools || []).map(t => t.function?.name || t.name).filter(Boolean));
  const ignoredToolIndices = new Set();

  const flushToolFallbackIfNeeded = () => {
    if (sawTool) return;
    if (pseudoToolMode || accumulatedText.includes('[TOOL_CALL')) {
      const extracted = extractPseudoToolCalls(accumulatedText);
      if (extracted.toolCalls.length > 0) {
        console.log(`[tool_fallback] (流式) 拦截到模型输出伪工具指令，已自动下发 ${extracted.toolCalls.length} 个原生 tool_calls 给客户端`);
        for (let i = 0; i < extracted.toolCalls.length; i++) {
          const tc = extracted.toolCalls[i];
          chunk({
            tool_calls: [{
              index: i,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              }
            }]
          });
        }
        sawTool = true;
        stop = 'tool_use';
        return;
      }
    }
    // 未命中伪工具，把缓冲区剩余的文字发完
    if (accumulatedText.length > sentTextLength) {
      chunk({ content: accumulatedText.slice(sentTextLength) });
      sentTextLength = accumulatedText.length;
    }
  };

  try {
    for await (const ev of normalizeSse(stream, acct, ctx)) {
      switch (ev.type) {
        case 'message_start':
          if (!started) { started = true; chunk({ role: 'assistant', content: '' }); }
          break;
        case 'content_block_start': {
          const cb = ev.content_block || {};
          if (cb.type === 'tool_use') {
            if (declaredToolNames.size > 0 && !declaredToolNames.has(cb.name) && (cb.name === 'view' || cb.name === 'repl' || cb.name === 'artifacts')) {
              console.warn(`[tool] 拦截未在客户端声明的内部沙盒工具调用: ${cb.name}`);
              ignoredToolIndices.add(ev.index);
              break;
            }
            const idx = slot.size;
            slot.set(ev.index, idx);
            sawTool = true;
            chunk({ tool_calls: [{ index: idx, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }] });
          }
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta || {};
          if (d.type === 'text_delta') {
            accumulatedText += d.text;
            if (!sawTool) {
              if (pseudoToolMode) {
                // 处于拦截状态，静默累积，不向客户端发 content
              } else {
                const toolIdx = accumulatedText.indexOf('[TOOL_CALL');
                if (toolIdx !== -1) {
                  pseudoToolMode = true;
                  if (toolIdx > sentTextLength) {
                    chunk({ content: accumulatedText.slice(sentTextLength, toolIdx) });
                    sentTextLength = toolIdx;
                  }
                } else {
                  // 安全窗口：暂存最后 15 字符防止 [TOOL_CALL 被断词
                  const safeLen = Math.max(0, accumulatedText.length - 15);
                  if (safeLen > sentTextLength) {
                    chunk({ content: accumulatedText.slice(sentTextLength, safeLen) });
                    sentTextLength = safeLen;
                  }
                }
              }
            } else {
              chunk({ content: d.text });
            }
          }
          else if (d.type === 'thinking_summary_delta' || d.type === 'thinking_delta') {
            // 思考过程：上游只回摘要（thinking_summary_delta），转成 OpenAI 生态通用的
            // reasoning_content 增量下发（DeepSeek/Qwen 系客户端都认这个字段）
            const s = d.type === 'thinking_delta' ? (d.thinking || '') : (d.summary?.summary || '');
            if (s) {
              const piece = reasoning ? '\n' + s : s;
              reasoning += piece;
              chunk({ reasoning_content: piece });
            }
          }
          else if (d.type === 'input_json_delta') {
            if (ignoredToolIndices.has(ev.index)) break;
            const idx = slot.get(ev.index) ?? 0;
            chunk({ tool_calls: [{ index: idx, function: { arguments: d.partial_json || '' } }] });
          }
          break;
        }
        case 'message_delta':
          flushToolFallbackIfNeeded();
          if (ev.delta?.stop_reason) {
            stop = sawTool ? 'tool_use' : ev.delta.stop_reason;
            chunk({}, sawTool ? 'tool_calls' : mapStopReason(stop));
            finishedSent = true;
          }
          break;
        case 'error':
          send({ error: { message: ev.error?.message || 'upstream error', type: 'upstream_error' } });
          break;
        default: break;
      }
    }

    flushToolFallbackIfNeeded();
    if (!finishedSent) {
      chunk({}, sawTool ? 'tool_calls' : mapStopReason(stop));
    }
    if (!started) chunk({ role: 'assistant', content: '' });
    if (!res.writableEnded && !res.destroyed) {
      try { res.write('data: [DONE]\n\n'); } catch {}
    }
  } finally {
    clearInterval(keepAliveTimer);
    try { if (!res.writableEnded) res.end(); } catch {}
  }
}

// ------------------------------------------------------------- 估算 usage
/**
 * 估算 token 数（上游 claude.ai 不返回 usage，只能估）。
 *
 * 以前一律「字符 ÷ 4」，那是英文的口径 —— 中文大约 1 字 1 token，
 * 一段中文回复会被低估 3~4 倍，于是「输出速度」算出来严重偏低
 * （同样 1 秒出 20 个汉字，真实是 20 tok/s，按字符÷4 只算出 5 tok/s）。
 * 这里按中英文分开估：汉字/中文标点 1 字 1 token，其余 4 字符 1 token。
 */
function countTokens(s) {
  if (!s) return 0;
  const str = String(s);
  let cjk = 0, other = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x3000 && cp <= 0x303f) ||   // 中文标点
        (cp >= 0x3040 && cp <= 0x30ff) ||   // 日文假名
        (cp >= 0x3400 && cp <= 0x4dbf) ||   // 汉字扩展 A
        (cp >= 0x4e00 && cp <= 0x9fff) ||   // 基本汉字
        (cp >= 0xf900 && cp <= 0xfaff)) {   // 兼容汉字
      cjk++;
    } else other++;
  }
  return Math.ceil(cjk + other / 4);
}

function estimateUsage(prompt, completion) {
  const pt = Math.max(1, countTokens(prompt));
  const ct = Math.max(1, countTokens(completion));
  return { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct };
}

/**
 * 上游在发起 tool_use 时有时仍回报 end_turn（而不是 tool_use），
 * 所以只要拿到了 tool_calls，就以 tool_calls 为准 —— 否则客户端不会去执行工具。
 */
function resolveFinish(result) {
  if (result.toolCalls.length) return 'tool_calls';
  return mapStopReason(result.stop);
}

function ant2oaiText(result, model, prompt) {
  const toolCalls = result.toolCalls.length ? result.toolCalls : undefined;
  const text = toolCalls && !result.text ? null : (result.text || null);
  const message = { role: 'assistant', content: text };
  if (result.reasoning) message.reasoning_content = result.reasoning;   // 思考摘要
  if (toolCalls) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl-${result.id || randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model || model,
    choices: [{
      index: 0,
      message,
      finish_reason: resolveFinish(result),
    }],
    usage: estimateUsage(prompt, (result.text || '') + (result.reasoning || '')),
  };
}

// ------------------------------------------- OpenAI Responses API 适配
// 客户端有一部分只讲 Responses API（POST /v1/responses），这里把它的
// input/instructions/tools 转成内部 chat 形状复用同一条上游链路，
// 再把结果回填成 response 对象（流式按官方事件序列发）。
const RESP_STORE = new Map();   // resp_id -> {response, messages}，内存保留最近 50 条（供 previous_response_id / GET）
const KYC_CACHE = new Map();    // account_id -> {at, data}，KYC 查询结果缓存 5 分钟（只读接口，别频繁打上游）

function newRespId() { return `resp_${randomUUID().replace(/-/g, '')}`; }
function newItemId(prefix) { return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`; }

function rememberResponse(id, response, messages) {
  RESP_STORE.set(id, { response, messages });
  while (RESP_STORE.size > 50) RESP_STORE.delete(RESP_STORE.keys().next().value);
}

/** Responses 的 input（字符串或条目数组）-> chat messages */
function responsesInputToMessages(input) {
  if (input == null) return [];
  if (typeof input === 'string') return input.trim() ? [{ role: 'user', content: input }] : [];
  if (!Array.isArray(input)) return [{ role: 'user', content: JSON.stringify(input) }];

  const messages = [];
  const callNames = new Map();   // call_id -> 函数名（function_call_output 显示用）
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type || (item.role ? 'message' : '');
    if (type === 'message') {
      const role = item.role || 'user';
      const c = item.content;
      let text = '';
      const images = [];
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        const texts = [];
        for (const p of c) {
          if (typeof p === 'string') { texts.push(p); continue; }
          if (!p) continue;
          if (typeof p.text === 'string') texts.push(p.text);       // input_text / output_text
          else if (typeof p.refusal === 'string') texts.push(p.refusal);
          else if (typeof p.type === 'string' && p.type.includes('image')) {
            images.push(...imagesOfContent([p]));                   // input_image / image_url
          }
        }
        text = texts.filter(Boolean).join('\n');
      }
      // 有图片时保留内容块数组（textOf 渲染 [image] 占位，collectImages 负责上传）
      const content = images.length
        ? [...(text ? [{ type: 'text', text }] : []),
           ...images.map(u => ({ type: 'image_url', image_url: { url: u } }))]
        : text;
      messages.push({ role, content });
    } else if (type === 'function_call') {
      if (item.call_id) callNames.set(item.call_id, item.name || '');
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: item.call_id || newItemId('call'),
          type: 'function',
          function: { name: item.name || 'unknown', arguments: item.arguments || '{}' },
        }],
      });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output' ||
               type === 'local_shell_call_output' || type === 'computer_call_output') {
      const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        name: callNames.get(item.call_id) || '',
        content: out,
      });
    } else if (type === 'custom_tool_call' || type === 'local_shell_call' || type === 'computer_call') {
      // Codex CLI 的 custom / shell 工具调用，在下一轮 input 里回放历史
      const nm = item.name || type;
      if (item.call_id) callNames.set(item.call_id, nm);
      const args = typeof item.arguments === 'string' ? item.arguments
        : JSON.stringify(item.arguments ?? item.input ?? {});
      messages.push({
        role: 'assistant', content: '',
        tool_calls: [{
          id: item.call_id || newItemId('call'), type: 'function',
          function: { name: nm, arguments: args },
        }],
      });
    } else if (type === 'reasoning' || type === 'item_reference') {
      // 推理摘要/条目引用对上游无意义（且上游是无状态 prompt 渲染）
      continue;
    } else if (type) {
      console.warn(`[responses] 忽略不支持的 input 条目: ${type}`);
    }
  }
  return messages;
}

/** Responses 请求体 -> chat 形状（messages/tools/system），供 runCompletion 消费 */
function responsesToChat(rb) {
  const systems = [];
  if (typeof rb.instructions === 'string' && rb.instructions.trim()) systems.push(rb.instructions);

  // 上游不支持结构化输出，用指令兜底（inferred：能提高但不保证 JSON 合法性）
  const fmt = rb.text && rb.text.format;
  if (fmt && fmt.type === 'json_schema') {
    systems.push(
      'Respond with a single valid JSON value only — no markdown fences, no prose. ' +
      `It must match this JSON Schema${fmt.name ? ` (${fmt.name})` : ''}:\n` +
      JSON.stringify(fmt.schema || {}));
  } else if (fmt && fmt.type === 'json_object') {
    systems.push('Respond with a single valid JSON value only — no markdown fences, no prose.');
  }

  const messages = [];
  if (rb.previous_response_id) {
    const prev = RESP_STORE.get(rb.previous_response_id);
    if (prev) messages.push(...prev.messages);
    else console.warn(`[responses] previous_response_id=${rb.previous_response_id} 不在内存缓存，忽略（上下文可能不完整）`);
  }
  messages.push(...responsesInputToMessages(rb.input));

  const chat = { messages };
  if (systems.length) chat.system = systems.join('\n\n');
  // 思考档位：Responses 的 reasoning:{effort}（或 reasoning_effort）传下去，
  // pickEffort 会把它（或默认值）映射成上游的 effort 字段
  const rEffort = (rb.reasoning && typeof rb.reasoning === 'object' && rb.reasoning.effort != null)
    ? rb.reasoning.effort : rb.reasoning_effort;
  if (rEffort != null) chat.reasoning_effort = String(rEffort);

  if (rb.tool_choice === 'none') return chat;               // 显式要求不给工具
  const rawTools = Array.isArray(rb.tools) ? rb.tools : [];
  if (rawTools.length && process.env.TOOL_PASSTHROUGH !== 'off') {
    const mapped = rawTools.map(normalizeTool).filter(Boolean);
    if (mapped.length) chat.tools = mapped;
    const dropped = rawTools.length - mapped.length;
    if (dropped > 0) console.warn(`[responses] 跳过 ${dropped} 个无法识别的工具定义（缺 name / type）`);
    // 打印原始类型 -> 映射后名字，方便核对客户端到底声明了什么
    console.log('[responses] tools:', rawTools.map((t, i) =>
      `${t?.type || '?'}:${normalizeTool(t)?.name || 'dropped'}`).join(', '));
  } else if (rawTools.length) {
    console.warn(`[responses] TOOL_PASSTHROUGH=off，忽略全部 ${rawTools.length} 个工具定义`);
  }
  return chat;
}

function usageOf(prompt, completion, reasoning) {
  const r = typeof reasoning === 'string' ? reasoning : '';
  const u = estimateUsage(prompt, (completion || '') + r);
  return {
    input_tokens: u.prompt_tokens,
    output_tokens: u.completion_tokens,
    total_tokens: u.total_tokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: countTokens(r) },
  };
}

function resultToItems(result) {
  const items = [];
  if (result.reasoning) {
    // 思考摘要在最前（与上游事件顺序一致）
    items.push({
      type: 'reasoning', id: newItemId('rs'), status: 'completed',
      summary: [{ type: 'summary_text', text: result.reasoning }],
    });
  }
  if (result.text) {
    items.push({
      type: 'message', id: newItemId('msg'), status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: result.text, annotations: [] }],
    });
  }
  for (const tc of result.toolCalls) {
    items.push({
      type: 'function_call', id: newItemId('fc'), call_id: tc.id,
      name: tc.function?.name || 'unknown', arguments: tc.function?.arguments || '{}',
      status: 'completed',
    });
  }
  return items;
}

function respShell(rb, model, id, created, status, output, usage) {
  return {
    id, object: 'response', created_at: created, status,
    error: null, incomplete_details: null,
    instructions: typeof rb.instructions === 'string' ? rb.instructions : null,
    max_output_tokens: rb.max_output_tokens ?? null,
    model, output: output || [],
    parallel_tool_calls: rb.parallel_tool_calls !== false,
    previous_response_id: rb.previous_response_id || null,
    reasoning: null,
    store: !!rb.store,
    temperature: rb.temperature ?? null,
    text: { format: (rb.text && rb.text.format) || { type: 'text' }, verbosity: (rb.text && rb.text.verbosity) || 'medium' },
    tool_choice: rb.tool_choice || 'auto',
    tools: Array.isArray(rb.tools) ? rb.tools : [],
    top_p: rb.top_p ?? null,
    truncation: rb.truncation || 'auto',
    usage: usage || null,
    metadata: rb.metadata || {},
  };
}

function resultToAssistantMessage(result) {
  const m = { role: 'assistant', content: result.text || '' };
  if (result.toolCalls.length) {
    m.tool_calls = result.toolCalls.map(tc => ({
      id: tc.id, type: 'function',
      function: { name: tc.function?.name || 'unknown', arguments: tc.function?.arguments || '{}' },
    }));
  }
  return m;
}

/**
 * 流式：按 Responses 官方事件序列输出
 * response.created -> response.in_progress ->
 *   output_item.added / content_part.added / output_text.delta（文本）
 *   output_item.added / function_call_arguments.delta（工具）->
 *   ...done -> response.completed
 */
async function streamResponses(res, run, model, id, rb, promptText, baseMessages) {
  const created = Math.floor(Date.now() / 1000);
  let seq = 0;
  const shell = (status, output, usage) => respShell(rb, model, id, created, status, output, usage);
  const send = (type, payload) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);

  send('response.created', { response: shell('in_progress') });
  send('response.in_progress', { response: shell('in_progress') });

  const items = [];
  const slot = new Map();          // 上游 content_block index -> {item, index}
  const rsSlot = new Map();        // 思考块 -> {item, index, snap}（与工具块分开，收尾逻辑不同）
  let msgRef = null;
  let text = '';
  let rsText = '';                 // 思考摘要全文（供 usage reasoning_tokens 估算）
  let failed = null;

  try {
    for await (const ev of normalizeSse(run.stream, run.account, run.ctx)) {
      switch (ev.type) {
        case 'content_block_start': {
          const cb = ev.content_block || {};
          if (cb.type === 'thinking') {
            const item = { type: 'reasoning', id: newItemId('rs'), summary: [], status: 'in_progress' };
            const index = items.length;
            items.push(item);
            rsSlot.set(ev.index, { item, index, snap: '' });
            send('response.output_item.added', { output_index: index, item: { ...item } });
            send('response.reasoning_summary_part.added', {
              item_id: item.id, output_index: index, content_index: 0,
              part: { type: 'summary_text', text: '' },
            });
          } else if (cb.type === 'tool_use') {
            const item = {
              type: 'function_call', id: newItemId('fc'),
              call_id: cb.id || newItemId('call'), name: cb.name || 'unknown',
              arguments: '', status: 'in_progress',
            };
            const index = items.length;
            items.push(item);
            slot.set(ev.index, { item, index });
            send('response.output_item.added', { output_index: index, item: { ...item } });
          }
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta || {};
          if (d.type === 'text_delta' && d.text) {
            if (!msgRef) {
              const item = { type: 'message', id: newItemId('msg'), status: 'in_progress', role: 'assistant', content: [] };
              const index = items.length;
              items.push(item);
              msgRef = { item, index };
              send('response.output_item.added', { output_index: index, item: { ...item, content: [] } });
              send('response.content_part.added', {
                item_id: item.id, output_index: index, content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] },
              });
            }
            text += d.text;
            send('response.output_text.delta', {
              item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0,
              delta: d.text, snapshot: text,
            });
          } else if (d.type === 'thinking_summary_delta' || d.type === 'thinking_delta') {
            const s = d.type === 'thinking_delta' ? (d.thinking || '') : (d.summary?.summary || '');
            const rs = rsSlot.get(ev.index);
            if (!rs || !s) break;
            const delta = rs.snap ? '\n' + s : s;
            rs.snap += delta;
            rsText += (rsText ? '\n' : '') + s;
            send('response.reasoning_summary_text.delta', {
              item_id: rs.item.id, output_index: rs.index, content_index: 0,
              delta, snapshot: rs.snap,
            });
          } else if (d.type === 'input_json_delta') {
            const s = slot.get(ev.index);
            if (!s) break;
            s.item.arguments += d.partial_json || '';
            send('response.function_call_arguments.delta', {
              item_id: s.item.id, output_index: s.index,
              delta: d.partial_json || '', snapshot: s.item.arguments,
            });
          }
          break;
        }
        case 'error':
          failed = ev.error?.message || 'upstream error';
          break;
        default: break;
      }
    }
  } catch (e) {
    // 客户端断连导致的中止：静默退出（handler 的 finally 会归还并发额度）
    if (e?.name === 'AbortError' || res.destroyed) return;
    failed = e.message;
  }

  if (failed) {
    const r = shell('failed', items, null);
    r.error = { code: 'upstream_error', message: failed };
    send('response.failed', { response: r });
    res.end();
    return;
  }

  // 思考条目收尾（先于 message/function_call 发，保持 output 顺序与 stream 一致）
  for (const { item, index, snap } of rsSlot.values()) {
    const part = { type: 'summary_text', text: snap || '' };
    item.summary = snap ? [part] : [];
    item.status = 'completed';
    send('response.reasoning_summary_part.done', {
      item_id: item.id, output_index: index, content_index: 0, part,
    });
    send('response.output_item.done', { output_index: index, item: { ...item } });
  }
  if (msgRef) {
    const part = { type: 'output_text', text, annotations: [] };
    msgRef.item.content = [part];
    msgRef.item.status = 'completed';
    send('response.output_text.done', {
      item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0, text,
    });
    send('response.content_part.done', {
      item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0, part,
    });
    send('response.output_item.done', { output_index: msgRef.index, item: { ...msgRef.item } });
  }
  for (const { item, index } of slot.values()) {
    item.status = 'completed';
    send('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
    send('response.output_item.done', { output_index: index, item: { ...item } });
  }

  send('response.completed', { response: shell('completed', items, usageOf(promptText, text, rsText)) });
  res.end();

  // 存档以支持 previous_response_id 续聊
  const asst = { role: 'assistant', content: text };
  const tcs = [...slot.values()].map(s => ({
    id: s.item.call_id, type: 'function',
    function: { name: s.item.name, arguments: s.item.arguments },
  }));
  if (tcs.length) asst.tool_calls = tcs;
  rememberResponse(id, shell('completed', items, usageOf(promptText, text, rsText)), [...baseMessages, asst]);
}

// ---------------------------------------------------------------- HTTP 服务
function json(res, code, obj, headers) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': b.length,
    'access-control-allow-origin': '*',
    ...(headers || {}),
  });
  res.end(b);
}

/**
 * 客户端断连检测（Codex 打断 steer、客户端超时等场景）：
 * 响应没写完连接就关掉 -> abort，用于中止上游 fetch。
 * 否则上游流会继续跑完，白占上游的并发槽，下一个请求就会撞 concurrents 429。
 */
function onClientGone(res) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  return ac;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => {
      d += c;
      if (d.length > 64 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/**
 * 统一鉴权。所有 API Key 来自 config.json，各自带独立的额度 / 到期 / 限速 / 白名单。
 * 返回 { key } 或 { error: {status, message, type, hint} }。
 * 环境变量 LOCAL_API_KEY 若存在，仍作为一个「无限制」的等价 key 保留（向后兼容）。
 */
const LEGACY_KEY_OBJ = {
  id: '_legacy', name: 'LOCAL_API_KEY(env)', enabled: true, expiresAt: null,
  models: [], rpm: 0, tpm: 0, ipWhitelist: [],
  quota: { limitTokens: 0, usedTokens: 0, limitRequests: 0, usedRequests: 0 },
};
function authenticate(req) {
  const h = req.headers['authorization'] || '';
  const raw = String(h).replace(/^Bearer\s+/i, '').trim();

  if (LEGACY_KEY && raw === LEGACY_KEY) return { key: LEGACY_KEY_OBJ };

  if (KEYS.keyCount() === 0) {
    return {
      error: {
        status: 401, message: 'no api key configured', type: 'authentication_error',
        hint: 'config.json 的 keys 是空的：打开配置文件加一个 key，或设置环境变量 LOCAL_API_KEY',
      },
    };
  }
  const ip = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return KEYS.identify(raw, ip);
}

const UI_FILE = [
  path.join(ROOT, 'web', 'webui.local.html'),
  path.join(ROOT, 'webui.local.html'),
  path.join(ROOT, 'web', 'webui.html'),
  path.join(ROOT, 'webui.html'),
  path.join(HERE, 'webui.html'),
].find(p => fs.existsSync(p)) || path.join(ROOT, 'web', 'webui.html');
let uiCache = null;
/** 读取并缓存 WebUI 页面（文件更新后自动生效，不用重启） */
function uiHtml() {
  try {
    const m = fs.statSync(UI_FILE).mtimeMs;
    if (!uiCache || uiCache.mtime !== m) {
      uiCache = { mtime: m, html: fs.readFileSync(UI_FILE, 'utf8') };
    }
    return uiCache.html;
  } catch { return null; }
}

function modelList() {
  const ids = (process.env.MODELS
    ? process.env.MODELS.split(',')
    : (UP.models || ['claude-sonnet-5-5', 'claude-haiku-5-5'])
  ).map(s => s.trim()).filter(Boolean);
  const now = Math.floor(Date.now() / 1000);
  return ids.map(id => ({ id, object: 'model', created: now, owned_by: 'anthropic' }));
}

/**
 * 会话粘性路由缓存：保持同一对话锁定在同一账号上，
 * 彻底激活 Anthropic 官方前缀缓存 (Prompt Caching，命中率 85%+)，
 * 防止多账号交叉轮换导致 100 万 Tokens 爆炸与 429 封盘。
 */
const CONV_ROUTING = new Map();
const CONV_ROUTING_TTL = 15 * 60 * 1000; // 15 分钟无活动自动过期

function getConversationKey(body, req) {
  if (!body) return null;
  // 1. 客户端显式传递的会话头或会话 ID
  const hId = req?.headers?.['x-session-id'] || req?.headers?.['x-conversation-id'];
  if (hId) return `h:${hId}`;
  if (body.conversation_id) return `c:${body.conversation_id}`;
  if (body.chat_id) return `c:${body.chat_id}`;

  // 2. 稳定的前置消息指纹（跨轮次绝对不变）
  // 无论对话扩展多少轮，首条用户指令 (messages[0]) 或 system 设定始终是整条会话树的锚点
  const msgs = body.messages || [];
  const firstUser = msgs.find(m => m.role === 'user');
  if (firstUser) {
    const sys = typeof body.system === 'string' ? body.system.slice(0, 100) : '';
    const userContent = typeof firstUser.content === 'string'
      ? firstUser.content
      : JSON.stringify(firstUser.content || '');
    return `fp:${createHash('sha1').update(`${sys}::${userContent.slice(0, 200)}`).digest('hex').slice(0, 16)}`;
  }
  return null;
}

function cleanupConvRouting() {
  const now = Date.now();
  for (const [k, v] of CONV_ROUTING.entries()) {
    if (now - v.at > CONV_ROUTING_TTL) CONV_ROUTING.delete(k);
  }
}
setInterval(cleanupConvRouting, 60 * 1000);

/**
 * 核心：选一个账号跑一次 completion，失败自动换下一个账号（failover）。
 *
 * 返回 { stream, upBody, account, release } —— 调用方消费完流后必须调 release()
 * 释放并发额度（无论成功失败）。
 */
async function runCompletion(body, model, signal, apiKey, req) {
  const convKey = getConversationKey(body, req);
  let preferredId = convKey ? CONV_ROUTING.get(convKey)?.accountId : null;

  // ── 上下文优化：修剪历史旧图片与冗长工具输出，大幅减小 prompt 体积 ──
  // 仅当池配置启用 pruneContext 时生效（默认 true）
  if (POOL?.data?.pruneContext !== false && Array.isArray(body.messages)) {
    const maxToolChars = +(POOL?.data?.pruneMaxToolChars || 8000);
    const keepRecentTools = +(POOL?.data?.pruneKeepRecentTools || 4);
    body = {
      ...body,
      messages: optimizeContext(body.messages, {
        keepRecentTurns: Math.max(2, +(POOL?.data?.pruneKeepRecentTools || 4)),
        maxImages: 3,
        maxChars: maxToolChars,
      }),
    };
  }

  const upBody = buildUpstreamBody(body, model);
  const images = collectImages(body);          // 本轮要上传的图片（与 prompt 里 [image] 占位同序同集合）
  const tried = new Set();
  let lastErr = null;
  // 「换账号」与「等并发槽」分开计：
  //   failovers   —— 账号真的坏了才换，受 maxFailover 约束
  //   queueWaits  —— 上游并发满，槽位几秒后就释放，只排队不换账号，不受 maxFailover 约束
  // 原来两者混在 for 的 attempt 里，7 个子代理抢 2 个槽位时，请求只等约 9 秒就集体失败，
  // 客户端再用 8 秒退避重试，新请求继续插队，形成 429 死循环。
  let failovers = 0;
  let queueWaits = 0;
  const queueStart = Date.now();
  const queueBudget = +(process.env.ACCOUNT_QUEUE_BUDGET_MS || 30000);

  for (;;) {
    // 客户端已断连：别再选账号/打上游
    if (signal?.aborted) throw clientGoneError();
    const maxFail = +(POOL?.data?.maxFailover ?? POOL.opts.maxFailover ?? 3);
    if (failovers > maxFail) break;
    // 池里还有没试过的可用账号吗？没有就别等了
    //
    // 「可用」分两种：立刻能用的（不在冷却、不在 429 耗尽池），
    // 和冷却很快就要结束、值得排队等的（并发满 1.5s / 网络抖动）。
    // 剩下全是「429 配额耗尽」的话就别空等了 —— 那是几小时后的事，
    // 白等 30 秒还只会把 failover 配额耗光。
    const nowMs = Date.now();
    const candidates = POOL.accounts().filter(a =>
      a.enabled && a.sessionKey && a.org && !tried.has(a.id));
    const readyNow = candidates.filter(a =>
      nowMs >= (a.cooldownUntil || 0) && !(a.exhaustedUntil > nowMs));
    const soon = candidates.filter(a =>
      !readyNow.includes(a) && (a.cooldownUntil || 0) - nowMs <= queueBudget);
    if (!readyNow.length && !soon.length) break;

    const targetPref = (preferredId && !tried.has(preferredId)) ? preferredId : null;
    const acct = await acquireAccount(tried, signal, targetPref);
    if (!acct) {
      if (signal?.aborted) throw clientGoneError();
      break;
    }

    if (convKey) {
      CONV_ROUTING.set(convKey, { accountId: acct.id, at: Date.now() });
    }

    // 稳定前缀链（按账号隔离）——缓存命中率与「新增输入」都基于它
    const pfx = prefixOf(body, acct.id, model);
    const hist = (body.messages || []).filter(m => m.role !== 'system' && m.role !== 'developer');
    // 会话复用保护：只用于纯多轮文本对话。工具调用 / 工具结果 / 并发同会话会串台，
    // 这些场景一律新建会话走全量 prompt（正确性优先于命中率）。
    const hasToolFlow = hist.some(m => m.role === 'tool' || m.role === 'function' ||
      (m.role === 'assistant' && (m.tool_calls || []).length));
    const canReuse = images.length === 0 && hist.length >= 2 &&
      hist[hist.length - 1].role === 'user' && !hasToolFlow;   // 有图片必须走全量（复用增量会丢图）
    const reuse = canReuse ? USAGE.reusable(acct.id, pfx.candidates) : null;
    const ctx = {
      startedAt: Date.now(),
      account_id: acct.id, account_label: acct.label,
      model, api: 'chat.completions',
      input_tokens: 0, output_tokens: 0,
      prefix_hash: pfx.hash, prefix_tokens: pfx.tokens,
      prefix_candidates: pfx.candidates,
      conv_id: '', parent_uuid: '',
      ttfb_ms: null, latency_ms: 0, status: 200, ok: true, error: '',
      // 真实输出速度相关（normalizeSse 的 finally 里回填）
      text_tokens: 0, think_tokens: 0,
      gen_ms: 0, write_ms: 0, think_ms: 0, idle_ms: 0,
      tps: 0, tps_e2e: 0, tps_legacy: 0,
      effort: upBody.effort || '',        // 本轮实际用的思考档位（排查「输出速度慢」用）
      reused_upstream: false, _logged: false,
    };

    try {
      let conv, reqBody = upBody;
      if (images.length) {
        // 图片上传放在选中账号之后：uuid 按账号隔离缓存，failover 换账号要重传
        const up = await uploadImages(acct, images, signal);
        reqBody = { ...upBody, files: up.uuids };
        if (up.failed.length) {
          reqBody.prompt = `${upBody.prompt}\n\n[系统提示] 本次有 ${up.failed.length} 张图片上传失败，你无法看到它们：${up.failed.join('；')}`;
        }
        ctx.image_files = up.uuids.length;
        if (up.failed.length) ctx.image_errors = up.failed.join('; ').slice(0, 200);
        if (up.uuids.length) console.log(`[image] ${acct.label}: ${up.uuids.length} 张已上传, ${up.failed.length} 张失败`);
      }
      if (reuse) {
        // CACHE_MODE=reuse：复用上游会话，只发本轮增量（真正减少重复输入）
        conv = reuse.conv_id;
        const last = hist[hist.length - 1];
        reqBody = {
          ...upBody,
          prompt: textOf(last?.content) || 'hi',
          parent_message_uuid: reuse.parent_uuid,
        };
        ctx.reused_upstream = true;
        ctx.parent_uuid = reuse.parent_uuid;
      } else {
        conv = await createConversation(acct, 'proxy', signal);
      }
      ctx.conv_id = conv;
      ctx.input_tokens = Math.max(1, Math.ceil((reqBody.prompt || '').length / 4));

      const stream = await callCompletion(acct, conv, reqBody, signal);
      let released = false;
      const release = (ok = true, why = '', kind = 'transient') => {
        if (released) return;
        released = true;
        // 客户端断连后收尾：只归还并发额度，不记成功/失败，别污染 failStreak 与冷却
        if (signal?.aborted) { POOL.release(acct, false); }
        else if (ok) POOL.release(acct, true);
        else POOL.fail(acct, kind, why || 'stream failed');
        // 统一在这里落请求级用量日志（流式 / 非流式 / Responses / Messages 全覆盖）
        if (!ctx._logged) {
          ctx._logged = true;
          ctx.ok = ok && !signal?.aborted;
          ctx.status = ctx.ok ? 200 : 499;
          if (!ctx.ok) ctx.error = String(why || (signal?.aborted ? 'client disconnected' : '') || '').slice(0, 200);
          ctx.latency_ms = ctx.latency_ms || Date.now() - ctx.startedAt;
          USAGE.record(ctx);
          // 计入该 API Key 的额度（含缓存命中的输入，口径与账号用量一致）
          if (apiKey && apiKey.id !== '_legacy') {
            KEYS.noteTokens(apiKey, (ctx.input_tokens || 0) + (ctx.output_tokens || 0));
          }
        }
      };
      if (failovers > 0 || queueWaits > 0) {
        console.log(`[pool] ${failovers > 0 ? 'failover' : 'queued'} -> ${acct.label} (waits=${queueWaits})`);
      }
      // 本地估算输入 token（上游不返回 usage；只累计"已用"，不是配额）
      if (ctx.input_tokens) POOL.noteTokens(acct, ctx.input_tokens, 0);
      return { stream, upBody: reqBody, account: acct, release, ctx };
    } catch (e) {
      if (!ctx._logged) {
        ctx._logged = true;
        ctx.ok = false; ctx.status = e.status || 502;
        ctx.error = String(e.message || '').slice(0, 200);
        ctx.latency_ms = Date.now() - ctx.startedAt;
        USAGE.record(ctx);
      }
      if (e?.name === 'AbortError' || signal?.aborted) {
        POOL.release(acct, false);   // 中性归还 inflight（fail 会记失败+冷却，不能用）
        throw clientGoneError();
      }
      lastErr = e;
      const kind = e.kind || 'error';
      // rate_limit 且上游给了 resetsAt -> 精确收紧到 429 耗尽池（到点自动回有效池）
      const cool = POOL.fail(acct, kind, e.message, { resetsAt: e.resetsAt, reason: e.reason });
      console.warn(`[pool] ${acct.label} ${kind} -> cooldown ${Math.round(cool / 1000)}s: ${String(e.message).slice(0, 160)}`);
      if (!e.retryable) break;                 // 400 之类，换账号也没用
      // concurrency（上游并发满）与 transient（网络抖动/5xx）都不是账号坏了：
      // 并发槽几秒后自然释放，所以只排队等、不换账号、不拉黑、不消耗 failover 配额，
      // 只有排队总预算（ACCOUNT_QUEUE_BUDGET_MS，默认 30s）耗尽才真正失败。
      if (kind === 'concurrency' || kind === 'transient') {
        if (Date.now() - queueStart >= queueBudget) break;
        queueWaits++;
        if (kind === 'concurrency') {
          // 上游的并发/速率窗口是短期滚动限制（实测 8~66s 自动恢复），紧跟在成功请求后爆发。
          // 旧的 1.2s/2.4s…8s 快退避 + 客户端 2s 退避两层自激，会把窗口一直顶着：
          // 改成 6s→12s→18s→20s（上限 20s）长退避，且本轮直接弃用该账号换下一个
          //（仅当还有其他真正可用账号时才弃，避免无备胎时直接失败）。
          const others = POOL.eligible(Date.now(), tried).filter(a => a.id !== acct.id);
          if (others.length) tried.add(acct.id);
          const backoff = Math.min(20000, 6000 * queueWaits);
          console.log(`[pool] ${acct.label} concurrency-429 -> ${others.length ? `弃用换号(剩${others.length})` : '无备胎原地等'}，退避 ${Math.round(backoff / 1000)}s (waits=${queueWaits})`);
          await sleep(backoff);
          continue;
        }
        // transient：网络抖动/5xx，秒级重试即可
        await sleep(Math.min(8000, 300 * Math.max(1, queueWaits)));
        continue;
      }
      tried.add(acct.id);                      // rate_limit / auth / challenge：这个账号本轮别再用了
      failovers++;
      // 若当前故障账号正是会话绑定的粘性账号，解除该会话绑定，允许换号重新选择
      if (convKey && preferredId === acct.id) {
        CONV_ROUTING.delete(convKey);
        preferredId = null;
      }
      const maxFail = +(POOL?.data?.maxFailover ?? POOL.opts.maxFailover ?? 3);
      if (failovers <= maxFail) await sleep(300);
    }
  }
  if (signal?.aborted) throw clientGoneError();
  throw lastErr || Object.assign(new Error('no eligible account (all cooling down or disabled)'),
    { kind: 'rate_limit', retryable: false, status: 429 });
}

/**
 * 等一个可用账号。
 * 所有账号都在冷却/满载时不会立刻失败，而是等到 waitTimeoutMs（默认 30s），
 * 让 429 冷却中的账号有机会恢复。signal 中止（客户端断连）时立即放弃。
 */
async function acquireAccount(exclude, signal, preferredId) {
  const waitMs = +(POOL?.data?.waitTimeoutMs ?? POOL.opts.waitTimeoutMs ?? 30000);
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (signal?.aborted) return null;
    const a = POOL.acquire(exclude, preferredId);
    if (a) return a;
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

// ---------------------------------------------------------- 本地私有插件挂载机制
// 动态挂载本地 plugins/ 目录下的扩展（plugins/ 目录被 .gitignore 忽略，不进入公开仓库）
const PLUGIN_ROUTES = new Map();
async function loadLocalPlugins() {
  const pDir = path.join(ROOT, 'plugins');
  if (!fs.existsSync(pDir)) return;
  try {
    for (const d of fs.readdirSync(pDir, { withFileTypes: true })) {
      if (d.isDirectory()) {
        const entry = path.join(pDir, d.name, 'plugin.mjs');
        if (fs.existsSync(entry)) {
          const mod = await import(`file://${entry}`);
          if (typeof mod.registerPlugin === 'function') {
            await mod.registerPlugin({
              onRoute: (p, fn) => PLUGIN_ROUTES.set(p, fn),
              KEYS,
              POOL,
              LOGIN,
              json,
              readBody,
            });
            console.log(`[plugin] 已挂载本地私有扩展: ${d.name}`);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[plugin] 加载本地扩展异常:', err.message);
  }
}
await loadLocalPlugins();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    });
    return res.end();
  }

  // 优先执行本地扩展插件注册的自定义路由
  const pluginHandler = PLUGIN_ROUTES.get(url.pathname);
  if (pluginHandler) {
    try {
      const handled = await pluginHandler(req, res, { url, json, readBody });
      if (handled !== false) return;
    } catch (e) {
      return json(res, 500, { error: { message: e.message, type: 'plugin_error' } });
    }
  }

  // ---------------------------------------------------------- WebUI（页面本身免鉴权，本机回环访问；
  // 页面里的 API 调用仍要带 Bearer key）
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui' || url.pathname === '/ui/')) {
    let html = uiHtml();
    if (!html) {
      return json(res, 500, { error: { message: 'webui.html 不在反代同目录，无法提供管理界面', type: 'proxy_error' } });
    }
    // 本机访问：把 config.json 里第一个可用 key 注入页面，省去手填。
    // 安全边界不变——本机用户本来就能直接读 config.json；局域网访问绝不注入。
    // 想关掉：config.json 里 settings.injectKeyToLocalUI = false
    if (isLoopbackReq(req) && KEYS.settings().injectKeyToLocalUI !== false) {
      const cand = KEYS.list().find(x => x.enabled !== false && !x.expired);
      if (cand && cand.key) {
        const boot = `<script>window.__BOOT_KEY__=${JSON.stringify(cand.key)};</script>\n</head>`;
        html = html.replace('</head>', boot);
      }
    }
    const b = Buffer.from(html);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': b.length,
      'cache-control': 'no-cache',
    });
    return res.end(b);
  }

    // ---------------------------------------------------------- API Key 管理（仅本机可操作）
    // 放在统一鉴权之前：只校验「本机 + key 有效」，不检查该 key 的额度 / 到期 / 限速。
    // 否则额度用尽后连管理接口都进不去，无法自救。
    if (url.pathname === '/v1/keys' || url.pathname.startsWith('/v1/keys/')) {
      if (!isLoopbackReq(req)) {
        return json(res, 403, { error: { message: 'Key 管理只能在运行反代的机器上操作（需本机访问）', type: 'permission_error' } });
      }
      const rawKey = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
      const known = (LEGACY_KEY && rawKey === LEGACY_KEY) || KEYS.list().some(k => k.key === rawKey);
      if (!known) {
        return json(res, 401, { error: { message: 'invalid api key', type: 'authentication_error', hint: '管理接口也要带一个有效的 Bearer key' } });
      }
      const rest = url.pathname.slice('/v1/keys'.length).replace(/^\//, '');
      const parts = rest ? rest.split('/') : [];
      const kid = parts[0] || '';
      const action = parts[1] || '';

      if (!kid && req.method === 'GET') {
        return json(res, 200, { keys: KEYS.list(), settings: KEYS.settings(), config_file: path.basename(CONFIG_FILE) });
      }
      if (!kid && req.method === 'POST') {
        const b = await readBody(req);
        const k = KEYS.create(b);
        return json(res, 201, { key: KEYS.list().find(x => x.id === k.id), secret: k.key });
      }
      if (kid && action === 'reset' && req.method === 'POST') {
        return json(res, KEYS.resetUsage(kid) ? 200 : 404, { ok: true });
      }
      if (kid && req.method === 'PATCH') {
        const b = await readBody(req);
        const k = KEYS.update(kid, b);
        if (!k) return json(res, 404, { error: { message: 'key not found', type: 'invalid_request_error' } });
        return json(res, 200, { key: KEYS.list().find(x => x.id === kid) });
      }
      if (kid && req.method === 'DELETE') {
        return json(res, KEYS.remove(kid) ? 200 : 404, { ok: true });
      }
      return json(res, 405, { error: { message: 'method not allowed', type: 'invalid_request_error' } });
    }

  // ---------------------------------------------------------- 链接登录状态页（免鉴权，仅本机回环；
  // 不含任何凭据，方便把链接复制到任意浏览器查看进度 / 重新打开登录窗口）
  // 开放局域网后必须显式限制：远程设备既看不到本机弹出的浏览器窗口，
  // 也不该能触发「重新打开登录窗口」——这属于本机操作。
  if (url.pathname.startsWith('/login/') && !isLoopbackReq(req)) {
    return json(res, 403, {
      error: { message: '登录流程只能在运行反代的机器上操作（需本机回环访问）', type: 'permission_error' },
    });
  }
  if (url.pathname.startsWith('/login/') && url.pathname.endsWith('/state') && req.method === 'GET') {
    const id = url.pathname.slice('/login/'.length, -'/state'.length);
    const s = LOGIN.state(id);
    return json(res, s ? 200 : 404, s || { error: { message: '登录流程不存在或已过期', type: 'invalid_request_error' } });
  }
  if (url.pathname.startsWith('/login/') && url.pathname.endsWith('/open') && req.method === 'POST') {
    const id = url.pathname.slice('/login/'.length, -'/open'.length);
    const ok = await LOGIN.reopen(id);
    return json(res, ok ? 200 : 409, { ok, message: ok ? '已重新打开登录页' : '登录窗口不可用，请回控制台重新发起登录' });
  }
  if (url.pathname.startsWith('/login/') && url.pathname.endsWith('/goto') && req.method === 'POST') {
    const id = url.pathname.slice('/login/'.length, -'/goto'.length);
    let body;
    try { body = await readBody(req); } catch { body = {}; }
    const r = await LOGIN.goto(id, body?.url);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (req.method === 'GET' && /^\/login\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.slice('/login/'.length);
    if (!LOGIN.get(id)) {
      return json(res, 404, { error: { message: '登录流程不存在或已过期', type: 'invalid_request_error' } });
    }
    const b = Buffer.from(loginPage(id));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': b.length,
      'cache-control': 'no-cache',
    });
    return res.end(b);
  }

  const auth = authenticate(req);
  if (auth.error) {
    const e = auth.error;
    return json(res, e.status, { error: { message: e.message, type: e.type, hint: e.hint } });
  }
  req.apiKey = auth.key;
  // 计入该 key 的请求数与 RPM 窗口（额度检查在 authenticate 里已经做过）
  if (req.apiKey && req.apiKey.id !== '_legacy') {
    KEYS.noteRequest(req.apiKey, (req.socket?.remoteAddress || '').replace(/^::ffff:/, ''));
  }
  // 每个请求都挂断连检测；补全类端点把它传给上游 fetch（见 runCompletion）
  const gone = onClientGone(res);

  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const age = Math.round((Date.now() - (UP.web_cookie_at || 0)) / 1000);
      const st = POOL.status();
      return json(res, 200, {
        ok: st.eligible_now > 0,
        upstream: `${UP.web_base}/api/organizations/{org}/chat_conversations/{id}/completion`,
        plan: UP.plan || 'unknown',
        cookie_age_seconds: age,
        models: modelList().map(m => m.id),
        local_auth: KEYS.keyCount() > 0 ? 'on' : 'off',
        api_keys: KEYS.keyCount(),
        pool: {
          strategy: st.strategy,
          total: st.total,
          enabled: st.enabled,
          valid_pool: st.valid_pool,
          exhausted_pool: st.exhausted_pool,
          next_restore_at: st.next_restore_at,
          eligible_now: st.eligible_now,
          per_account_concurrency: st.per_account_concurrency,
          min_quota_remaining: st.min_quota_remaining,
          max_failover: st.max_failover,
          wait_timeout_ms: st.wait_timeout_ms,
          session_affinity: st.session_affinity !== false,
          prune_context: st.prune_context,
          prune_max_tool_chars: st.prune_max_tool_chars,
          prune_keep_recent_tools: st.prune_keep_recent_tools,
          default_effort: st.default_effort,
        },
        accounts: st.accounts.map(a => ({
          id: a.id, label: a.label, enabled: a.enabled,
          inflight: a.inflight, capacity: a.capacity,
          cooldown_remaining_s: a.cooldown_remaining_s,
          exhausted: a.exhausted,
          exhausted_until: a.exhausted_until,
          exhausted_reason: a.exhausted_reason,
          pool: a.pool,
          ok: a.ok, fail: a.fail, last_error: a.last_error,
          quota_5h: a.quota_5h,
        })),
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: modelList() });
    }

    // ---------------------------------------------------------- 账号管理
    if (url.pathname === '/v1/accounts' && req.method === 'GET') {
      const st = POOL.status();
      const setts = KEYS.settings() || {};
      Object.assign(st, setts);
      st.price_per_million_tokens = setts.pricePerMillionTokens || 0;
      st.maomail_token = setts.maomailToken || setts.maomail_token || '';
      st.maomail_base_url = setts.maomailBaseUrl || setts.maomail_base_url || 'https://zjkdongao.cn';
      st.server = KEYS.serverConfig();
      // 用请求级用量日志校准「已用 token」：
      // 账号池的 tokensInEst 只在请求成功时累加——失败的 429 请求同样消耗了输入，
      // 重启也会丢，所以它只能算运行时参考值。日志是权威源，且 input_tokens 用的是
      // 「完整输入」口径：缓存命中的部分依然要占上游上下文和额度，必须一起计入。
      try {
        const byId = accountTokenStats();
        for (const a of st.accounts) {
          const x = byId.get(a.id);
          if (!x) continue;
          a.tokens_total = x.total_tokens;             // 完整口径 = 输入（含缓存）+ 输出
          a.tokens_in = x.input_tokens;                // 含缓存命中的输入
          a.tokens_out = x.output_tokens;
          a.tokens_cached = x.cached_tokens;           // 命中缓存的部分（已包含在 tokens_in 里）
          a.tokens_new_input = x.new_input_tokens;     // 未命中缓存的新增输入
          a.requests_total = x.requests;
          a.tokens_source = 'usage-log';
        }
      } catch (e) { /* 日志不可用时退回账号池计数器 */ }
      return json(res, 200, st);
    }

    // ---------------------------------------------------------- KYC 状态查询
    // GET /v1/kyc[?id=<accountId>][&fresh=1]
    // 只读 GET /api/organizations + /kyc_status，不发消息、不消耗额度。
    // 结果按账号缓存 5 分钟；fresh=1 强制重查。全量查询并发 3，避免打满上游。
    if (url.pathname === '/v1/kyc' && req.method === 'GET') {
      const wantId = url.searchParams.get('id');
      const fresh = url.searchParams.get('fresh') === '1';
      const TTL = 5 * 60 * 1000;
      let targets = POOL.accounts().filter(a => a.enabled && (a.sessionKey || a.cookie));
      if (wantId) {
        targets = targets.filter(a => a.id === wantId);
        if (!targets.length) {
          return json(res, 404, { error: { message: 'account not found', type: 'invalid_request_error' } });
        }
      }
      const results = {};
      const todo = [];
      for (const a of targets) {
        const hit = KYC_CACHE.get(a.id);
        if (!fresh && hit && Date.now() - hit.at < TTL) results[a.id] = hit.data;
        else todo.push(a);
      }
      let idx = 0;
      const workers = Array.from({ length: Math.min(3, todo.length) }, async () => {
        while (idx < todo.length) {
          const a = todo[idx++];
          try {
            const data = await checkKyc({ base: a.base || UP.web_base, headers: webHeaders(a) });
            KYC_CACHE.set(a.id, { at: Date.now(), data });
            results[a.id] = data;
          } catch (e) {
            results[a.id] = { ok: false, error: { code: 'network', message: String(e?.message || e) } };
          }
        }
      });
      await Promise.all(workers);
      return json(res, 200, { results, checked: todo.length, cached: targets.length - todo.length });
    }

    if (url.pathname === '/v1/accounts' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.sessionKey) {
        return json(res, 400, { error: { message: 'sessionKey is required', type: 'invalid_request_error' } });
      }
      let org = b.org || '';
      if (!org) {
        try {
          const d = await discoverOrg(b.sessionKey, b.base || undefined, b.ua || undefined);
          org = d.org;
        } catch (e) {
          return json(res, e.status || 502, {
            error: { message: `org 自动发现失败: ${e.message}（可手动传 org 字段）`, type: 'proxy_error' },
          });
        }
      }
      const { account, created } = POOL.add({ ...b, org });
      return json(res, created ? 201 : 200, { created, account: maskAccount(account) });
    }

    if (url.pathname.startsWith('/v1/accounts/')) {
      const rest = url.pathname.slice('/v1/accounts/'.length);

      if (rest === 'refresh' && req.method === 'POST') {
        const ok = await refreshSession(true);
        return json(res, ok ? 200 : 503, {
          refreshed: ok,
          error: ok ? undefined : {
            message: '凭据刷新失败：桌面端可能正在运行并占用 Cookies 库（已保留旧凭据继续服务，稍后会自动重试）',
            type: 'proxy_error',
          },
          accounts: POOL.status().accounts.map(a => ({ id: a.id, label: a.label, org: a.org })),
        });
      }

      const id = rest;
      if (req.method === 'GET' && id.endsWith('/test')) {
        // 连通性测试：用该账号的 sessionKey 打一次 GET /api/organizations（不消耗对话额度）
        const acct = POOL.get(id.slice(0, -'/test'.length));
        if (!acct) return json(res, 404, { error: { message: 'account not found', type: 'invalid_request_error' } });
        try {
          const d = await discoverOrg(acct.sessionKey, acct.base, acct.ua);
          return json(res, 200, { ok: true, org: d.org, name: d.name, plan: d.plan });
        } catch (e) {
          return json(res, e.status || 502, {
            ok: false,
            error: { message: `登录态校验失败: ${e.message}`, type: 'proxy_error' },
          });
        }
      }
      if (req.method === 'POST' && id.endsWith('/quota')) {
        // 主动查额度：发一条最小消息取 message_limit 事件 + 查 rate_limits（消耗 1 条最小消息）
        const acct = POOL.get(id.slice(0, -'/quota'.length));
        if (!acct) return json(res, 404, { error: { message: 'account not found', type: 'invalid_request_error' } });
        try {
          const r = await probeQuota(acct, { base: UP.web_base || 'https://claude.ai' });
          if (r.limit) {
            POOL.updateQuota(acct, { ...r.limit, rate_limits: r.rate_limits, probedAt: Date.now() });
          }
          const st = POOL.status().accounts.find(x => x.id === acct.id);
          return json(res, 200, {
            ok: !!r.limit,
            quota: {
              '5h': r.limit?.windows?.['5h'] || null,
              '7d': r.limit?.windows?.['7d'] || null,
              remaining: r.limit?.remaining ?? null,
              per_model_limit: r.limit?.perModelLimit ?? null,
              spend: r.limit?.resolved?.spend ?? null,
              representative_claim: r.limit?.representativeClaim || null,
              resolved_limit: r.limit?.resolved?.limit || null,
            },
            rate_limits: r.rate_limits,
            account: st,
            note: r.note,
          });
        } catch (e) {
          const status = e.status || (/429/.test(e.message) ? 429 : 502);
          const c = classify(status, e.message);
          if (c.kind === 'rate_limit' && c.resetsAt) {
            POOL.fail(acct, 'rate_limit', e.message, { resetsAt: c.resetsAt, reason: c.reason });
            POOL.updateQuota(acct, {
              windows: {
                '5h': { status: 'exceeded_limit', resets_at: Math.floor(c.resetsAt / 1000), utilization: 1 },
              },
              remaining: 0,
              resetsAt: Math.floor(c.resetsAt / 1000),
              representativeClaim: c.reason || 'five_hour',
              resolved: { limit: { percent: 1, resets_at: new Date(c.resetsAt).toISOString() } },
              probedAt: Date.now(),
            });
          } else if (c.kind === 'rate_limit' || c.kind === 'auth') {
            POOL.fail(acct, c.kind, e.message);
          }
          const st = POOL.status().accounts.find(x => x.id === acct.id);
          return json(res, status, {
            ok: false,
            error: { message: `额度探测失败: ${e.message}`, type: 'proxy_error' },
            account: st,
          });
        }
      }
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        const a = POOL.set(id, b);
        if (!a) return json(res, 404, { error: { message: 'account not found', type: 'invalid_request_error' } });
        return json(res, 200, { account: maskAccount(a) });
      }
      if (req.method === 'DELETE') {
        if (!POOL.remove(id)) {
          return json(res, 404, { error: { message: 'account not found', type: 'invalid_request_error' } });
        }
        return json(res, 200, { removed: id });
      }
    }

    if (url.pathname === '/v1/pool') {
      if (req.method === 'GET') {
        const st = POOL.status();
        const setts = KEYS.settings() || {};
        return json(res, 200, {
          strategy: st.strategy,
          per_account_concurrency: st.per_account_concurrency,
          min_quota_remaining: st.min_quota_remaining,
          max_failover: st.max_failover,
          wait_timeout_ms: st.wait_timeout_ms,
          session_affinity: st.session_affinity !== false,
          prune_context: st.prune_context,
          prune_max_tool_chars: st.prune_max_tool_chars,
          prune_keep_recent_tools: st.prune_keep_recent_tools,
          default_effort: st.default_effort,
          price_per_million_tokens: setts.pricePerMillionTokens || 0,
          maomail_token: setts.maomailToken || setts.maomail_token || '',
          maomail_base_url: setts.maomailBaseUrl || setts.maomail_base_url || 'https://zjkdongao.cn',
          server: KEYS.serverConfig(),
        });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        try {
          KEYS.updateSettings(b);
          const cfg = POOL.configure(b);
          return json(res, 200, {
            ...cfg,
            ...(KEYS.settings() || {}),
            price_per_million_tokens: KEYS.settings()?.pricePerMillionTokens || 0,
          });
        } catch (e) {
          return json(res, e.status || 400, { error: { message: e.message, type: 'invalid_request_error' } });
        }
      }
    }

    // ---------------------------------------------------------- 用量统计（分账号 / 按小时 / 全局）
    if (req.method === 'GET' && url.pathname === '/v1/usage') {
      const range = url.searchParams.get('range') || 'today';
      const accountId = url.searchParams.get('accountId') || '';
      const model = url.searchParams.get('model') || '';
      const s = USAGE.summary(range, { accountId, model });
      // 附上账号池里所有账号（包括今天还没产生请求的，已用 token 显示 0）
      s.accounts_all = POOL.status().accounts.map(a => ({
        id: a.id, label: a.label, enabled: a.enabled,
        tokens_in_est: a.tokens_in_est, tokens_out_est: a.tokens_out_est,
        total_tokens_est: (a.tokens_in_est || 0) + (a.tokens_out_est || 0),
        quota_remaining: a.quota_remaining,
      }));
      return json(res, 200, s);
    }
    if (req.method === 'GET' && url.pathname === '/v1/usage/logs') {
      return json(res, 200, {
        logs: USAGE.logs({
          range: url.searchParams.get('range') || 'today',
          accountId: url.searchParams.get('accountId') || '',
          limit: +(url.searchParams.get('limit') || 100),
        }),
      });
    }

    // ---------------------------------------------------------- 链接登录（无需手动粘贴 sessionKey）
    if (url.pathname === '/v1/login/batch' && req.method === 'POST') {
      const host = req.headers.host || `127.0.0.1:${PORT}`;
      let body = {};
      try { body = await readBody(req); } catch {}
      const emails = Array.isArray(body.emails) ? body.emails : [];
      const concurrency = +body.concurrency || 2;
      const resData = LOGIN.startBatch(emails, concurrency, `http://${host}`);
      return json(res, resData.ok ? 200 : 400, resData);
    }
    if (url.pathname === '/v1/login/batch' && req.method === 'GET') {
      return json(res, 200, { ok: true, batch: LOGIN.batchStatus() });
    }
    if (url.pathname === '/v1/login/batch/cancel' && req.method === 'POST') {
      return json(res, 200, { ok: true, batch: LOGIN.cancelBatch() });
    }
    if (url.pathname === '/v1/login' && req.method === 'POST') {
      const host = req.headers.host || `127.0.0.1:${PORT}`;
      let body = {};
      try { body = await readBody(req); } catch {}
      return json(res, 200, LOGIN.start(`http://${host}`, body));
    }
    if (url.pathname.startsWith('/v1/login/')) {
      const rest = url.pathname.slice('/v1/login/'.length);
      if (rest.endsWith('/cancel') && req.method === 'POST') {
        const s = LOGIN.cancel(rest.slice(0, -'/cancel'.length));
        return s ? json(res, 200, s)
          : json(res, 404, { error: { message: '登录流程不存在', type: 'invalid_request_error' } });
      }
      if (req.method === 'GET') {
        const s = LOGIN.state(rest);
        return s ? json(res, 200, s)
          : json(res, 404, { error: { message: '登录流程不存在或已过期', type: 'invalid_request_error' } });
      }
    }

    // ---------------------------------------------------------- 补全
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readBody(req);
      const model = mapModel(body.model);
      // 模型范围限制：Key 配了 models 白名单就只允许那些模型
      if (req.apiKey && !KEYS.modelAllowed(req.apiKey, model)) {
        return json(res, 403, { error: { message: `模型 ${model} 不在该 Key 的允许范围内`, type: 'permission_error' } });
      }
      const prompt = renderPrompt(body);

      const run = await runCompletion(body, model, gone.signal, req.apiKey, req);
      const chatId = newChatId();

      if (body.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        try {
          return await streamToClient(res, run.stream, model, chatId, run.account, run.ctx, body);
        } catch (streamErr) {
          if (!res.writableEnded && !res.destroyed) {
            try { res.write(`data: ${JSON.stringify({ error: { message: streamErr.message, type: 'proxy_error' } })}\n\n`); } catch {}
            try { res.write('data: [DONE]\n\n'); } catch {}
            try { res.end(); } catch {}
          }
          throw streamErr;
        } finally {
          run.release();
        }
      }

      try {
        const result = await collect(run.stream, run.account, run.ctx, body);
        return json(res, 200, ant2oaiText(result, model, prompt));
      } finally {
        run.release();
      }
    }

    if (req.method === 'POST' && url.pathname === '/v1/responses') {
      // OpenAI Responses API -> 复用同一条上游链路
      const rb = await readBody(req);
      const chat = responsesToChat(rb);
      if (!chat.messages.length) {
        return json(res, 400, { error: { message: 'input is required', type: 'invalid_request_error', param: 'input' } });
      }
      const model = mapModel(rb.model);
      // 模型范围限制：Key 配了 models 白名单就只允许那些模型
      if (req.apiKey && !KEYS.modelAllowed(req.apiKey, model)) {
        return json(res, 403, { error: { message: `模型 ${model} 不在该 Key 的允许范围内`, type: 'permission_error' } });
      }
      const prompt = renderPrompt(chat);
      const id = newRespId();
      const stream = rb.stream !== false;   // Responses 默认流式

      const run = await runCompletion(chat, model, gone.signal, req.apiKey, req); run.ctx.api = 'responses';
      if (stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        try {
          return await streamResponses(res, run, model, id, rb, prompt, chat.messages);
        } finally {
          run.release();
        }
      }

      try {
        const result = await collect(run.stream, run.account, run.ctx, chat);
        const resp = respShell(rb, model, id, Math.floor(Date.now() / 1000), 'completed',
          resultToItems(result), usageOf(prompt, result.text || '', result.reasoning));
        rememberResponse(id, resp, [...chat.messages, resultToAssistantMessage(result)]);
        return json(res, 200, resp);
      } finally {
        run.release();
      }
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/responses/')) {
      const id = url.pathname.slice('/v1/responses/'.length);
      const hit = RESP_STORE.get(id);
      if (!hit) {
        return json(res, 404, {
          error: { message: `response ${id} not found (本反代仅内存保留最近 50 条)`, type: 'invalid_request_error' },
        });
      }
      return json(res, 200, hit.response);
    }

    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      // Anthropic 格式 -> 复用同一条链路
      const body = await readBody(req);
      const oai = {
        model: body.model,
        stream: !!body.stream,
        thinking: body.thinking,               // 供 pickEffort 映射上游 effort（不进 prompt）
        reasoning_effort: body.reasoning_effort,
        system: body.system,
        messages: (body.messages || []).flatMap(m => {
          if (m.role === 'assistant') {
            const text = textOf(m.content);
            const tcs = (m.content || []).filter(c => c.type === 'tool_use')
              .map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } }));
            // 有图片块时保留数组：压成字符串会把 [image] 变成纯文本，
            // collectImages 就再也抽不出图，files 与占位对不上（模型看不到图）
            const content = hasImgBlocks(m.content) ? m.content : text;
            return [{ role: 'assistant', content, tool_calls: tcs.length ? tcs : undefined }];
          }
          if (m.role === 'user') {
            const hasToolResult = Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result');
            if (hasToolResult) {
              const res = [];
              for (const c of m.content) {
                if (c && c.type === 'tool_result') {
                  const trc = hasImgBlocks(c.content) ? c.content : textOf(c.content);
                  res.push({ role: 'tool', tool_call_id: c.tool_use_id, content: trc });
                } else if (c && c.type === 'text' && c.text) {
                  res.push({ role: 'user', content: c.text });
                }
              }
              return res.length ? res : [{ role: 'user', content: textOf(m.content) }];
            }
            // 带图片时保留原始块（textOf 渲染 [image]，imagesOfContent 负责上传）
            if (Array.isArray(m.content) && imagesOfContent(m.content).length) {
              return [{ role: 'user', content: m.content }];
            }
            return [{ role: 'user', content: textOf(m.content) }];
          }
          // system 等其余角色：有图片块也保留数组（否则占位留得下、图抽不出）
          if (hasImgBlocks(m.content)) return [{ role: m.role, content: m.content }];
          return [{ role: m.role, content: textOf(m.content) }];
        }),
        tools: body.tools,
      };
      const model = mapModel(oai.model);
      // 模型范围限制：Key 配了 models 白名单就只允许那些模型
      if (req.apiKey && !KEYS.modelAllowed(req.apiKey, model)) {
        return json(res, 403, { error: { message: `模型 ${model} 不在该 Key 的允许范围内`, type: 'permission_error' } });
      }
      const prompt = renderPrompt(oai);
      const run = await runCompletion(oai, model, gone.signal, req.apiKey, req); run.ctx.api = 'messages';

      try {
        if (oai.stream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'access-control-allow-origin': '*',
          });
          // 转成 Anthropic 事件
          const send = o => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
          const keepAliveTimer = setInterval(() => {
            try { res.write(': keep-alive\n\n'); } catch { clearInterval(keepAliveTimer); }
          }, 10000);
          let started = false;
          let rsnPieces = 0;   // 思考段计数（多段摘要之间补换行）
          try {
            for await (const ev of normalizeSse(run.stream, run.account, run.ctx)) {
              // 上游思考只回摘要（thinking_summary_delta 不是 Anthropic 标准事件，
              // 客户端 SDK 会丢弃）→ 转成标准 thinking_delta 下发，SDK 才能展示思考过程
              if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_summary_delta') {
                const s = ev.delta.summary?.summary || '';
                if (s) {
                  send({ type: 'content_block_delta', index: ev.index,
                    delta: { type: 'thinking_delta', thinking: (rsnPieces++ ? '\n' : '') + s } });
                }
                continue;
              }
              send(ev);
              if (ev.type === 'message_start') started = true;
            }
            if (!started) send({ type: 'message_start', message: { id: 'msg_' + randomUUID(), model, content: [] } });
          } finally {
            clearInterval(keepAliveTimer);
            res.end();
          }
          return;
        }

        const result = await collect(run.stream, run.account, run.ctx, body);
        const content = [];
        if (result.reasoning) {
          // Anthropic 规范：thinking 块在正文之前（signature 留空——摘要不是可回放的
          // 原始 CoT，且本反代历史回放时本就丢弃 thinking 块，不影响多轮）
          content.push({ type: 'thinking', thinking: result.reasoning, signature: '' });
        }
        if (result.text) content.push({ type: 'text', text: result.text });
        for (const tc of result.toolCalls) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* noop */ }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
        const u = estimateUsage(prompt, (result.text || '') + (result.reasoning || ''));
        return json(res, 200, {
          id: result.id || 'msg_' + randomUUID(),
          type: 'message',
          role: 'assistant',
          model: result.model || model,
          content,
          stop_reason: result.stop || 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens },
        });
      } finally {
        run.release();
      }
    }

    return json(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  } catch (e) {
    // 客户端提前断开（Codex 打断等）：无需也无法回写响应
    if (e?.name === 'AbortError') {
      console.log('[req] client disconnected -> upstream aborted');
      return;
    }
    if (res.headersSent || res.destroyed) {
      console.warn(`[req] ${String(e?.message || e).slice(0, 200)}（连接已断，跳过回写）`);
      return;
    }
    const msg = String(e?.message || e);
    const kind = e.kind;
    const code = kind === 'challenge' || kind === 'transient' ? 502
      : kind === 'rate_limit' || kind === 'concurrency' || e.status === 429 ? 429
      : kind === 'auth' || e.status === 401 || e.status === 403 ? 401
      : e.status >= 400 && e.status < 500 ? e.status : 500;

    // 429 按上游真实原因区分文案 + Retry-After（原来是通用兜底文案「配额用尽」，会误导排查）
    let hint;
    let retryAfter;
    if (code === 429) {
      const m = /resetsAt\\?":\s*(\d+)/.exec(msg);
      const resetsAt = m ? +m[1] : null;
      if (kind === 'concurrency' || /resetsAt\\?":\s*null/.test(msg)) {
        // 并发型：短期滚动窗口（实测 8~66s 自动恢复），不是配额
        hint = '账号短期并发/速率窗口已满（不是配额用尽），通常 1 分钟内自动恢复；代理已对该账号退避并换号，稍后重试即可';
        retryAfter = 30;
      } else if (/no eligible account/i.test(msg)) {
        // 有效池空了：把「429 耗尽池」的情况说清楚，并给出最近恢复时刻
        const st = POOL.status();
        const nextAt = st.next_restore_at;
        const exh = st.exhausted_pool || 0;
        hint = exh
          ? `有效池已空：${exh} 个账号因配额耗尽进了 429 耗尽池`
            + (nextAt ? `，最早 ${new Date(nextAt).toLocaleString('zh-CN')} 自动回池` : '')
            + '；其余账号在冷却中。可加账号或等恢复'
          : '所有账号都不可调度（冷却中/403 被自动禁用/低于额度阈值），可查看 GET /v1/accounts、加账号或等冷却结束';
        retryAfter = nextAt ? Math.min(Math.max(30, Math.ceil((nextAt - Date.now()) / 1000)), 3600) : 30;
      } else if (resetsAt && resetsAt * 1000 > Date.now()) {
        const sec = Math.ceil(resetsAt - Date.now() / 1000);
        hint = `所有账号 5 小时配额已用尽，预计 ${new Date(resetsAt * 1000).toLocaleTimeString('zh-CN')} 恢复；可加账号或等重置`;
        retryAfter = Math.min(sec, 3600);
      } else {
        hint = '所有账号都在冷却中（配额用尽），可加账号或等冷却结束';
        retryAfter = 30;
      }
    } else if (code === 401) {
      hint = '所有账号登录态失效，请重新登录 Claude Desktop 或 POST /v1/accounts/refresh'
        + '（401/403 连续 3 次的账号会被自动禁用 60 分钟，PATCH /v1/accounts/{id} {"enabled":true} 可立即恢复）';
    }

    return json(res, code, {
      error: {
        message: msg,
        type: code === 401 ? 'authentication_error' : code === 429 ? 'rate_limit_error' : 'proxy_error',
        hint,
      },
    }, retryAfter ? { 'retry-after': String(retryAfter) } : undefined);
  }
});

function maskAccount(a) {
  const sk = a.sessionKey || '';
  return {
    id: a.id, label: a.label, source: a.source, enabled: a.enabled, org: a.org,
    base: a.base,
    session_key: sk ? sk.slice(0, 18) + '...' + sk.slice(-4) : '',
    cooldown_remaining_s: Math.max(0, Math.ceil((a.cooldownUntil - Date.now()) / 1000)),
    ok: a.stats.ok, fail: a.stats.fail, last_error: a.stats.lastError,
  };
}

// 定期重解密 cookie（Desktop 换号/重新登录后自动跟上）
setInterval(() => { UP = loadUpstream(); }, 5000);
setInterval(() => refreshSession(false), 10 * 60 * 1000);
// accounts.json 被手工编辑时热加载，不用重启
setInterval(() => {
  POOL.autoRestoreDisabled();   // 401/403 自动禁用 60 分钟到期 -> 恢复启用
  // 先热加载再判定恢复：顺序反了的话，「文件里写了已过期」这一轮会错过恢复判定
  if (POOL.reloadIfChanged()) {
    const st = POOL.status();
    console.log(`[pool] accounts.json reloaded: total=${st.total} eligible=${st.eligible_now} strategy=${st.strategy}`);
  }
  POOL.restoreExhausted();      // 429 配额窗口到期 -> 自动回到有效池（用上游给的 resetsAt）
}, 2000);

// config.json 改了也热加载（key / 额度 / 到期时间立即生效；port/host 需要重启）
setInterval(() => {
  if (KEYS.reloadIfChanged()) {
    console.log(`[config] config.json reloaded: keys=${KEYS.keyCount()}（port/host 变更需重启）`);
  }
}, 3000);

server.listen(PORT, HOST, () => {
  refreshSession(false);
  const st = POOL.status();
  console.log(`[openai-proxy] http://127.0.0.1:${PORT}/v1`);
  // 首次启动会生成 config.json：把默认 key 打出来，否则用户不知道拿什么调
  if (KEYS.wasCreated()) {
    const first = (KEYS.snapshot().keys || [])[0];
    console.warn(`[openai-proxy] 首次启动，已生成配置文件 ${path.basename(CONFIG_FILE)}`);
    if (first) {
      console.warn(`[openai-proxy]   默认 API Key: ${first.key}`);
      console.warn('[openai-proxy]   端口 / 监听地址 / 所有 Key 都在这个文件里改，改完自动热加载');
    }
  }
  if (isLanExposed) {
    // 列出本机所有非回环 IPv4，方便直接把地址发给其他设备
    const nets = Object.values(os.networkInterfaces()).flat()
      .filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    console.warn(`[openai-proxy] 已开放到局域网 HOST=${HOST}，其他设备可用：`);
    for (const ip of nets) console.warn(`[openai-proxy]   http://${ip}:${PORT}/v1   (API Key 用你的 LOCAL_API_KEY)`);
    console.warn('[openai-proxy] 注意：任何能访问该端口的人都会消耗你的账号额度；sessionKey 等同账号凭据，切勿暴露到公网');
    // key 的强弱由 config.json 决定，这里不再提示
  }
  console.log(`[openai-proxy] pool strategy=${st.strategy} accounts=${st.total} enabled=${st.enabled} eligible=${st.eligible_now} concurrency=${st.per_account_concurrency}/acct`);
  console.log(`[openai-proxy] plan=${UP.plan} apiKeys=${KEYS.keyCount()} config=${path.basename(CONFIG_FILE)} models=${(UP.models || []).join(',')}`);
  for (const a of st.accounts) console.log(`[pool]   ${a.id} ${a.label} org=${a.org || '(none)'} ${a.session_key} ${a.enabled ? 'on' : 'OFF'}`);
  if (!st.total) console.warn('[openai-proxy] 账号池为空 —— 先跑 python desktop_session.py，或 POST /v1/accounts 添加');
});

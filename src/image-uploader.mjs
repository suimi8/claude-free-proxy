/**
 * image-uploader.mjs —— 图片收集、解析、缓存与并发上传模块
 *
 * 核心职责：
 * 1. 深度收集消息链中的图片引用（支持 data:URL、HTTP/HTTPS、Anthropic/OpenAI 复合结构）
 * 2. SHA-256 内容指纹去重与多账号隔离的 LRU+TTL 缓存 (IMAGE_CACHE)
 * 3. 并发上传至上游 /api/{org}/upload 接口，换取 file_uuid
 * 4. 降级容错机制：瞬时/鉴权/频控错误上抛以触发账号 failover，格式错误静默降级避免阻断主请求
 */

import { createHash, randomUUID } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { getSharedDispatcher } from './network-optimizer.mjs';
import { discoverOrg, DEFAULT_UA, DEFAULT_BASE } from './accounts.mjs';
import { fetchPublicBytes } from './public-http.mjs';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 单图字节上限 20MB
export const IMAGE_CACHE_TTL = 60 * 60 * 1000;   // uuid 缓存 1 小时：过期宁可重传，也不拿失效 uuid 撞 400
export const MAX_CACHE_ENTRIES = 1000;          // 缓存最大条数上限，避免无界膨胀

export const EXT_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
});

export function imgError(msg, retryable = false, status = 400) {
  return Object.assign(new Error(msg), {
    retryable,
    status,
    kind: retryable ? 'transient' : 'error',
  });
}

function clientGoneError() {
  return Object.assign(new Error('client disconnected'), {
    name: 'AbortError',
    kind: 'client_gone',
    retryable: false,
    status: 499,
  });
}

/**
 * LRU + TTL 双重淘汰机制的图片缓存
 */
export class ImageCache {
  constructor(options = {}) {
    this.max = options.max || MAX_CACHE_ENTRIES;
    this.ttl = options.ttl || IMAGE_CACHE_TTL;
    this._map = new Map();
  }

  get size() {
    return this._map.size;
  }

  get(key) {
    if (!key) return undefined;
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttl) {
      this._map.delete(key);
      return undefined;
    }
    // LRU refresh
    this._map.delete(key);
    this._map.set(key, entry);
    return entry;
  }

  set(key, val) {
    if (!key) return this;
    const entry = (val && typeof val === 'object' && 'uuid' in val)
      ? { uuid: val.uuid, at: val.at || Date.now() }
      : { uuid: String(val), at: Date.now() };

    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this.max) {
      const oldestKey = this._map.keys().next().value;
      if (oldestKey !== undefined) this._map.delete(oldestKey);
    }
    this._map.set(key, entry);
    return this;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    return this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  keys() {
    return this._map.keys();
  }

  values() {
    return this._map.values();
  }

  entries() {
    return this._map.entries();
  }

  [Symbol.iterator]() {
    return this._map.entries();
  }

  prune() {
    const now = Date.now();
    for (const [k, v] of this._map.entries()) {
      if (now - v.at > this.ttl) this._map.delete(k);
    }
  }
}

/** 全局图片缓存单例（`${acctId}\n${sha256}` -> { uuid, at }） */
export const IMAGE_CACHE = new ImageCache({ max: MAX_CACHE_ENTRIES, ttl: IMAGE_CACHE_TTL });

// 定期淘汰清理
const pruneTimer = setInterval(() => {
  IMAGE_CACHE.prune();
}, 10 * 60 * 1000);
if (pruneTimer?.unref) pruneTimer.unref();

/**
 * 解析 data URL：data:image/png;base64,xxxx -> { bytes, mime }
 */
export function parseDataUrl(s) {
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

/**
 * 获取图片字节：
 * - data URL 直接解码
 * - http(s) URL 匿名下载（通过 public-http 绝不带账号 cookie）
 */
export async function resolveImage(ref, signal) {
  const s = String(ref || '').trim();
  if (!s) throw imgError('图片引用为空', false);
  if (s.startsWith('data:')) {
    const p = parseDataUrl(s);
    if (!p) throw imgError('无法解析的图片 data URL（非 image/* 或 base64 坏损）', false);
    if (p.bytes.length > MAX_IMAGE_BYTES) throw imgError(`图片过大 ${p.bytes.length}B > ${MAX_IMAGE_BYTES}B`, false);
    return { ...p, name: `image.${EXT_BY_MIME[p.mime] || 'bin'}` };
  }
  if (/^https?:\/\//i.test(s)) {
    let bytes, mime;
    try {
      ({ bytes, mime } = await fetchPublicBytes(s, {
        signal,
        maxBytes: MAX_IMAGE_BYTES,
        timeoutMs: 30000,
        accept: 'image/*',
        image: true,
      }));
    } catch (e) {
      throw imgError(e.message, false, e.status || 502);
    }
    if (!bytes || !bytes.length) throw imgError('远程图片内容为空', false);
    return { bytes, mime, name: `image.${EXT_BY_MIME[mime] || 'bin'}` };
  }
  throw imgError(`不支持的图片引用（仅 data URL / http(s)）: ${s.slice(0, 60)}`, false);
}

/**
 * 从 content 结构中抽出所有图片引用
 */
export function imagesOfContent(content) {
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
    } else if (typeof src?.url === 'string' && src.url) {
      out.push(src.url);
    } else if (typeof c.image_url === 'string' && c.image_url) {
      out.push(c.image_url);
    } else if (typeof c.image_url?.url === 'string' && c.image_url.url) {
      out.push(c.image_url.url);
    } else if (typeof c.url === 'string' && c.url) {
      out.push(c.url);
    } else if (typeof c.data === 'string' && c.data) {
      out.push(`data:${c.media_type || c.mime_type || 'image/png'};base64,${c.data}`);
    }
  }
  return out;
}

/**
 * 检查内容里是否含有能抽出图片的块
 */
export function hasImgBlocks(content) {
  return Array.isArray(content) && imagesOfContent(content).length > 0;
}

/**
 * 收集消息链中全部待上传图片。
 * 支持传入包含 messages 的 body 对象，或直接传入 messages 数组。
 *
 * 遍历顺序与 renderPrompt 完全一致：
 * 1. 先收集 system/developer 角色中的图片
 * 2. 再按对话先后顺序收集其余有效角色 (user/assistant/tool/function)
 */
export function collectImages(input) {
  const msgs = Array.isArray(input) ? input : (Array.isArray(input?.messages) ? input.messages : []);
  const rendered = m => m && (m.role === 'system' || m.role === 'developer' ||
    m.role === 'user' || m.role === 'assistant' || m.role === 'tool' || m.role === 'function');
  const isSys = m => m.role === 'system' || m.role === 'developer';
  const out = [];
  for (const m of msgs) if (rendered(m) && isSys(m)) out.push(...imagesOfContent(m.content));
  for (const m of msgs) if (rendered(m) && !isSys(m)) out.push(...imagesOfContent(m.content));
  return out;
}

function buildWebHeaders(acct, base, ua) {
  const userAgent = ua || acct?.ua || DEFAULT_UA;
  const major = (String(userAgent).match(/Chrome\/(\d+)/) || [])[1] || '140';
  const platform = /Macintosh|Mac OS/i.test(userAgent) ? '"macOS"' : /Linux/i.test(userAgent) ? '"Linux"' : '"Windows"';
  const targetBase = base || acct?.base || DEFAULT_BASE || 'https://claude.ai';
  return {
    'cookie': acct?.cookie || (acct?.sessionKey ? `sessionKey=${acct.sessionKey}` : ''),
    'user-agent': userAgent,
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'origin': targetBase,
    'referer': `${targetBase}/new`,
    'sec-ch-ua': `"Chromium";v="${major}", "Not?A_Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': platform,
  };
}

/**
 * 上传单张图片到上游 /api/{org}/upload
 */
export async function uploadOne(acct, img, options = {}) {
  const signal = options.signal;
  const base = options.base || acct?.base || DEFAULT_BASE || 'https://claude.ai';
  const ua = options.ua || acct?.ua || DEFAULT_UA;

  let org = acct?.org;
  if (!org && acct?.sessionKey) {
    try {
      const d = await discoverOrg(acct.sessionKey, base, ua);
      org = d.org;
      acct.org = org;
    } catch {}
  }
  if (!org) {
    throw Object.assign(new Error('未找到账号 Organization ID'), {
      status: 401,
      kind: 'auth',
      retryable: true,
    });
  }

  const headers = buildWebHeaders(acct, base, ua);
  const boundary = `----WebKitFormBoundary${randomUUID().replace(/-/g, '')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${img.name}"\r\nContent-Type: ${img.mime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const bodyBuffer = Buffer.concat([head, img.bytes, tail]);
  headers['content-type'] = `multipart/form-data; boundary=${boundary}`;

  const dispatcher = getSharedDispatcher();
  let r, txt;
  try {
    r = await undiciFetch(`${base}/api/${org}/upload`, {
      method: 'POST',
      headers,
      body: bodyBuffer,
      signal,
      dispatcher,
    });
    txt = await r.text();
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      throw clientGoneError();
    }
    throw Object.assign(new Error(`upload network error: ${err.message || err}`), {
      status: 0,
      kind: 'transient',
      retryable: true,
    });
  }

  if (!r.ok) {
    if (/Just a moment|cf-browser-verification|challenge-platform/i.test(txt)) {
      throw Object.assign(new Error('cloudflare_challenge'), { kind: 'challenge', retryable: true, status: 403 });
    }
    const isRetryable = r.status === 429 || r.status === 401 || r.status === 403 || r.status >= 500;
    const kind = r.status === 429 ? 'rate_limit' : (r.status === 401 || r.status === 403 ? 'auth' : (r.status >= 500 ? 'transient' : 'error'));
    throw Object.assign(new Error(`upload ${r.status}: ${txt.slice(0, 300)}`), {
      status: r.status,
      kind,
      retryable: isRetryable,
    });
  }

  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    throw imgError('upload 响应不是 JSON', true, 502);
  }
  const uuid = j.file_uuid || j.uuid;
  if (!uuid) {
    throw imgError(`upload 没有 file_uuid: ${JSON.stringify(j).slice(0, 200)}`, true, 502);
  }
  return uuid;
}

/**
 * 批量并发上传图片，返回 { uuids, failed }。
 *
 * 参数兼容两种调用范式：
 * 1. uploadImages(images, acct, base, ua, signal) 或 uploadImages(images, acct, { base, ua, signal })
 * 2. uploadImages(acct, images, signal)
 *
 * 核心逻辑：
 * - 全量并发上传 (Promise.all)
 * - SHA-256 去重与 IMAGE_CACHE 账号隔离缓存
 * - 降级容错：可重试错误上抛触发轮询切换，不可重试错误收集至 failed 避免截断会话
 */
export async function uploadImages(arg1, arg2, arg3, arg4, arg5) {
  let images, acct, base, ua, signal;

  if (Array.isArray(arg1)) {
    images = arg1;
    acct = arg2 || {};
    if (arg3 && typeof arg3 === 'object' && !(arg3 instanceof AbortSignal)) {
      base = arg3.base;
      ua = arg3.ua;
      signal = arg3.signal;
    } else {
      base = typeof arg3 === 'string' ? arg3 : undefined;
      ua = typeof arg4 === 'string' ? arg4 : undefined;
      signal = arg5?.signal || (arg5 instanceof AbortSignal ? arg5 : undefined);
      if (!signal && (arg4 instanceof AbortSignal || arg4?.signal)) {
        signal = arg4.signal || arg4;
      }
      if (!signal && (arg3 instanceof AbortSignal || arg3?.signal)) {
        signal = arg3.signal || arg3;
      }
    }
  } else {
    acct = arg1 || {};
    images = Array.isArray(arg2) ? arg2 : [];
    if (arg3 instanceof AbortSignal || arg3?.aborted !== undefined) {
      signal = arg3;
    } else if (arg3 && typeof arg3 === 'object') {
      signal = arg3.signal;
      base = arg3.base;
      ua = arg3.ua;
    }
  }

  base = base || acct?.base || DEFAULT_BASE || 'https://claude.ai';
  ua = ua || acct?.ua || DEFAULT_UA;

  const tasks = images.map(async ref => {
    if (signal?.aborted) throw clientGoneError();
    try {
      const img = await resolveImage(ref, signal);
      const acctKey = acct?.id || acct?.sessionKey || 'default';
      const key = `${acctKey}\n${createHash('sha256').update(img.bytes).digest('hex')}`;
      const hit = IMAGE_CACHE.get(key);
      let uuid = hit ? hit.uuid : null;
      if (!uuid) {
        uuid = await uploadOne(acct, img, { base, ua, signal });
        IMAGE_CACHE.set(key, { uuid, at: Date.now() });
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

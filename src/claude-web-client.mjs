/**
 * claude-web-client.mjs —— 上游 Claude 逆向驱动模块
 *
 * 彻底将向 Claude 网页端发起的私有通信协议（会话创建、Completion 发起、上游请求分类、
 * 风暴与重试退避判断）封装成自洽的 Client 驱动层。
 */
import { randomUUID } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { DEFAULT_UA } from './accounts.mjs';
import { getSharedDispatcher } from './network-optimizer.mjs';

/* —— CF challenge 风暴检测：近 5 分钟 challenge 失败次数，供 WebUI 弹横幅提醒批量过CF —— */
export const CF_CHALLENGE_EVENTS = [];
export const CF_STORM_WINDOW_MS = 5 * 60 * 1000;
export const CF_STORM_MIN = +(process.env.CF_STORM_MIN || 10);

/**
 * 记录一次 Cloudflare challenge 拦截事件
 */
export function noteChallenge() {
  const now = Date.now();
  CF_CHALLENGE_EVENTS.push(now);
  while (CF_CHALLENGE_EVENTS.length && now - CF_CHALLENGE_EVENTS[0] > CF_STORM_WINDOW_MS) {
    CF_CHALLENGE_EVENTS.shift();
  }
}

/**
 * 判断当前是否处于 CF challenge 风暴状态
 * @returns {{ active: boolean, count: number, window_min: number, threshold: number }}
 */
export function cfStormActive() {
  const now = Date.now();
  while (CF_CHALLENGE_EVENTS.length && now - CF_CHALLENGE_EVENTS[0] > CF_STORM_WINDOW_MS) {
    CF_CHALLENGE_EVENTS.shift();
  }
  return {
    active: CF_CHALLENGE_EVENTS.length >= CF_STORM_MIN,
    count: CF_CHALLENGE_EVENTS.length,
    window_min: CF_STORM_WINDOW_MS / 60000,
    threshold: CF_STORM_MIN,
  };
}

/**
 * 清空所有 CF challenge 事件（例如手动清空冷却时）
 */
export function resetChallengeStorm() {
  CF_CHALLENGE_EVENTS.length = 0;
}
export const clearChallengeEvents = resetChallengeStorm;

/**
 * 构造访问 Claude Web 接口所需的 HTTP 请求头
 * @param {object} acct - 账号对象
 * @returns {Record<string, string>}
 */
export function webHeaders(acct) {
  const ua = acct?.ua || DEFAULT_UA;
  const major = (String(ua).match(/Chrome\/(\d+)/) || [])[1] || '140';
  const platform = /Macintosh|Mac OS/i.test(ua) ? '"macOS"' : /Linux/i.test(ua) ? '"Linux"' : '"Windows"';
  return {
    'cookie': acct?.cookie || `sessionKey=${acct?.sessionKey}`,
    'user-agent': ua,
    'accept': 'application/json, text/event-stream',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    'origin': acct?.base || 'https://claude.ai',
    'referer': (acct?.base || 'https://claude.ai') + '/',
    'sec-ch-ua': `"Chromium";v="${major}", "Not?A_Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': platform,
  };
}

/**
 * 判断响应正文是否包含 Cloudflare 质询特征
 * @param {string} text
 * @returns {boolean}
 */
export function isChallenge(text) {
  return /Just a moment|cf-browser-verification|challenge-platform/i.test(text || '');
}

/**
 * 从上游 429 响应体里抠出「配额窗口恢复时刻」。
 * 上游把 exceeded_limit 塞在 error.message 里（还是一层转义后的 JSON），所以直接扫文本。
 * @param {string} text
 * @returns {number|null} epoch 毫秒（上游给的是秒）
 */
export function parseResetsAt(text) {
  if (!text) return null;
  const m = /resetsAt\\?":\s*\\?"?(\d{9,})/.exec(text);
  if (!m) return null;
  let ts = +m[1];
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (ts < 1e12) ts *= 1000;          // 上游给的是秒
  return ts;
}

/**
 * 配额窗口类型（five_hour / seven_day / per_model），只用于展示
 * @param {string} text
 * @returns {string}
 */
export function parseLimitReason(text) {
  const m = /representativeClaim\\?":\s*\\?"?([a-z_]+)/.exec(text || '');
  return m ? m[1] : '';
}

/**
 * 把上游状态码/正文归类成 { kind, retryable, resetsAt, reason }，供池做冷却与 failover 决策
 * @param {number|null} status
 * @param {string} text
 * @returns {{ kind: string, retryable: boolean, resetsAt?: number|null, reason?: string }}
 */
export function classify(status, text) {
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

/**
 * 客户端断连统一错误：不算上游故障，不触发账号冷却/失败计数
 * @returns {Error}
 */
export function clientGoneError() {
  return Object.assign(new Error('client disconnected'), {
    name: 'AbortError', kind: 'client_gone', retryable: false, status: 499,
  });
}

/**
 * 判断网络异常是否为 Socket 重置错误
 * @param {any} e
 * @returns {boolean}
 */
export function isSocketResetError(e) {
  if (!e) return false;
  const code = e.code || e.cause?.code;
  const msg = String(e.message || e.cause?.message || '');
  return code === 'UND_ERR_SOCKET' ||
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    /other side closed|socket|econnreset|und_err_socket|broken pipe/i.test(msg);
}

/**
 * 向 Claude 上游发送网络请求并自带长连接与 Socket 抖动自动重试
 * @param {string} url
 * @param {object} init
 * @param {number} attempts
 * @returns {Promise<Response>}
 */
export async function upstreamFetch(url, init = {}, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const dispatcher = getSharedDispatcher();
      return await undiciFetch(url, { ...init, dispatcher });
    } catch (e) {
      if (e?.name === 'AbortError' || init?.signal?.aborted) throw clientGoneError();
      lastErr = e;
      if (i < attempts - 1 && isSocketResetError(e) && !init?.signal?.aborted) {
        console.warn(`[network] upstreamFetch socket reset (${e?.cause?.code || e.message}), retrying immediately with fresh socket...`);
        continue;
      }
      const inner = e?.cause ? `: ${e.cause.code || e.cause.message || e.cause}` : '';
      throw Object.assign(new Error(`upstream network error: ${e?.message || e}${inner}`),
        { status: 0, kind: 'transient', retryable: true, socketReset: isSocketResetError(e) });
    }
  }
  throw lastErr;
}

/**
 * 封装上游错误并附加分类诊断字段
 * @param {string} msg
 * @param {number} status
 * @param {string} text
 * @returns {Error}
 */
export function upstreamError(msg, status, text) {
  const { kind, retryable, resetsAt, reason } = classify(status, text);
  return Object.assign(new Error(msg), { status, kind, retryable, resetsAt, reason });
}

/**
 * 在上游 Claude 组织下创建临时对话会话
 * @param {object} acct - 账号凭据对象
 * @param {string} name - 会话标题
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} 会话 UUID
 */
export async function createConversation(acct, name, signal) {
  const uuid = randomUUID();
  const base = acct?.base || 'https://claude.ai';
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

/**
 * 发起上游 completion 请求，返回 SSE ReadableStream
 * @param {object} acct - 账号凭据对象
 * @param {string} convId - 会话 UUID
 * @param {object} body - 请求载荷
 * @param {AbortSignal} [signal]
 * @returns {Promise<ReadableStream>}
 */
export async function callCompletion(acct, convId, body, signal) {
  const base = acct?.base || 'https://claude.ai';
  const url = `${base}/api/organizations/${acct.org}/chat_conversations/${convId}/completion`;
  const r = await upstreamFetch(url, {
    method: 'POST',
    headers: webHeaders(acct),
    body: JSON.stringify(body),
    signal,
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

/**
 * 面向对象的 Claude 网页驱动客户端封装
 */
export class ClaudeWebClient {
  constructor(account, options = {}) {
    this.account = account;
    this.options = options;
  }

  getHeaders() {
    return webHeaders(this.account);
  }

  createConversation(name, signal) {
    return createConversation(this.account, name, signal);
  }

  callCompletion(convId, body, signal) {
    return callCompletion(this.account, convId, body, signal);
  }

  fetch(url, init, attempts) {
    return upstreamFetch(url, init, attempts);
  }
}

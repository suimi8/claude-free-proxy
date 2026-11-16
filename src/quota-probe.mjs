#!/usr/bin/env node
/**
 * quota-probe.mjs —— 主动查询 claude.ai 账号额度
 *
 * 实测结论（2026-11-13，free 档 / default_claude_ai）：
 *   - `/api/organizations/{org}/usage` 所有额度字段都是 null、limits: [] —— 拿不到绝对条数
 *   - `/api/organizations/{org}/rate_limits` 只给并发数（concurrents）与档位
 *   - 唯一带"用量"的数据在 completion 响应的 SSE `message_limit` 事件里，
 *     但只有 windows.5h / windows.7d 的 utilization(0~1) + resets_at，
 *     remaining / perModelLimit / spend 全是 null —— 上游不提供 token 或消息条数配额
 *
 * 因此"主动查额度"= 发一条最小消息把 message_limit 事件取回来，并附带查 rate_limits。
 * 会消耗一次极小的消息（prompt "hi"，默认最便宜的 haiku 模型）。
 */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function headers(acct, base) {
  return {
    cookie: acct.cookie || `sessionKey=${acct.sessionKey}`,
    'user-agent': acct.ua || DEFAULT_UA,
    accept: 'application/json',
    origin: base,
    referer: base + '/',
  };
}

/** 查限流档位 / 每模型并发上限（不消耗消息） */
export async function fetchRateLimits(acct, base, H) {
  try {
    const r = await fetch(`${base}/api/organizations/${acct.org}/rate_limits`, {
      headers: H, signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const concurrents = {};
    for (const x of (j.tier_model_rate_limiters || [])) {
      if (x.limiter === 'concurrents') concurrents[x.model_group] = x.value;
    }
    return { tier: j.rate_limit_tier || null, concurrents, spend_threshold: j.spend_threshold ?? null };
  } catch { return null; }
}

/**
 * 主动探测一次额度。
 * @returns {{limit: object|null, rate_limits: object|null, model: string, note: string}}
 */
export async function probeQuota(acct, opts = {}) {
  const base = acct.base || opts.base || 'https://claude.ai';
  const H = headers(acct, base);
  const model = opts.model || 'claude-haiku-5-5';
  const prompt = opts.prompt || 'hi';

  const rateLimits = await fetchRateLimits(acct, base, H);

  const cr = await fetch(`${base}/api/organizations/${acct.org}/chat_conversations`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ uuid: crypto.randomUUID(), name: '', is_temporary: true }),
    signal: AbortSignal.timeout(15000),
  });
  if (!cr.ok) {
    const t = await cr.text();
    throw Object.assign(new Error(`create_conversation ${cr.status}: ${t.slice(0, 180)}`), { status: cr.status });
  }
  const conv = await cr.json();

  const rr = await fetch(`${base}/api/organizations/${acct.org}/chat_conversations/${conv.uuid}/completion`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt, model,
      parent_message_uuid: '00000000-0000-4000-8000-000000000000',
      timezone: opts.timezone || 'Asia/Shanghai',
      attachments: [], files: [], rendering_mode: 'messages', tools: [],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!rr.ok) {
    const t = await rr.text();
    throw Object.assign(new Error(`completion ${rr.status}: ${t.slice(0, 180)}`), { status: rr.status });
  }

  const txt = await rr.text();
  let limit = null, upError = null;
  for (const line of txt.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const ev = JSON.parse(raw);
      if (ev.type === 'message_limit') limit = ev.message_limit || null;
      else if (ev.type === 'error') upError = ev.error;
    } catch { /* 单行 JSON 之外的行忽略 */ }
  }
  if (upError && !limit) throw new Error(upError.message || 'upstream error');

  return {
    limit,
    rate_limits: rateLimits,
    model,
    note: 'free 档按滚动 5h/7d 窗口的消息使用强度限额，上游只返回利用率百分比与重置时间，不返回 token 或消息条数配额',
  };
}

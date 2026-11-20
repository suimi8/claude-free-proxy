#!/usr/bin/env node
/**
 * usage-log.mjs —— 请求级 token 用量日志与聚合
 *
 * 输入按渲染后的上下文和 tools 估算，输出包含正文、思考和工具参数。
 * 汉字等 CJK 字符各计 1，其余每 4 个字符计 1，
 * 每条日志带 estimated: true，绝不冒充官方计费数字。
 *
 * 按天存 usage/YYYY-MM-DD.jsonl（追加写、重启不丢、不覆盖），
 * 提供：分账号 / 分模型 / 按小时 / 全局汇总 / 请求明细。
 *
 * 缓存命中口径（与 new-api 类看板一致）：
 *   cache_hit_rate = cached_tokens / input_tokens
 *   new_input      = input - cached
 *
 * 前缀链（关键）：Anthropic prompt cache 是「最长公共前缀」语义。
 * 每次请求对 system + tools + 历史消息的【每一个前缀】都算一个 hash，
 * 与同账号近 5 分钟内的记录比对，取最长命中 —— 这样多轮对话的命中率
 * 会随着轮次自然上升，而不是每轮都 miss。
 *
 * CACHE_MODE=off|stats|reuse：
 *   off   不统计缓存
 *   stats 只统计可命中的重复前缀（默认，完全不改变上游请求）
 *   reuse 真正复用上游会话并只发增量（见 openai-proxy.mjs / README）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 16);

function dayFile(dir, ts) {
  const d = new Date(ts);
  return path.join(dir,
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`);
}
function hourKey(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
}
function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/**
 * 稳定前缀链。返回从短到长的候选（含 system+tools 的空历史基线）。
 * 注意：history 只取「最后一条用户消息之前」的消息，最后一条是本次新增输入。
 */
export function prefixOf(body, accountId = '', model = '') {
  const systems = [];
  if (typeof body?.system === 'string') systems.push(body.system);
  else if (Array.isArray(body?.system)) systems.push(...body.system.map(s => (typeof s === 'string' ? s : s?.text || '')));
  const msgs = (body?.messages || []).filter(m => m.role !== 'system' && m.role !== 'developer');
  const head = {
    system: systems.join('\n'),
    tools: JSON.stringify(body?.tools || []),
  };
  const base = sha(`${accountId}|${model}|${JSON.stringify(head)}|0`);
  const candidates = [{ hash: base, tokens: Math.ceil(JSON.stringify(head).length / 4) }];
  let acc = JSON.stringify(head).length;
  for (let i = 0; i < msgs.length - 1; i++) {
    const m = msgs[i];
    const seg = JSON.stringify({ r: m.role, c: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '') });
    acc += seg.length + 1;
    candidates.push({ hash: sha(`${accountId}|${model}|${JSON.stringify(head)}|${i + 1}|${sha(seg)}|${candidates[i].hash}`), tokens: Math.ceil(acc / 4) });
  }
  return {
    hash: candidates[candidates.length - 1].hash,       // 最长前缀
    tokens: candidates[candidates.length - 1].tokens,  // 最长前缀的估算 token
    candidates,                                        // 短 -> 长
    chars: acc,
  };
}

export function createUsageLog(opts = {}) {
  const dir = opts.dir;
  const mode = opts.mode || process.env.CACHE_MODE || 'stats';
  const ttl = +(opts.ttlMs || process.env.CACHE_TTL_MS || 5 * 60 * 1000);
  fs.mkdirSync(dir, { recursive: true });

  // hash -> 最近一次出现（内存索引，重启后由当天日志重建）
  const idx = new Map();
  function key(accountId, hash) { return `${accountId}|${hash}`; }
  function rebuild() {
    const rows = readLines(dayFile(dir, Date.now()));
    for (const e of rows) {
      if (e.ok === false) continue;
      for (const c of (e.prefix_candidates || [])) {
        const k = key(e.account_id, c.hash);
        const prev = idx.get(k);
        if (!prev || prev.ts < e.ts) {
          idx.set(k, { ts: e.ts, tokens: c.tokens, conv_id: e.conv_id || '', parent_uuid: e.parent_uuid || '' });
        }
      }
    }
  }
  rebuild();

  function record(e) {
    const ts = e.ts || Date.now();
    const candidates = e.prefix_candidates || [];
    const entry = {
      ts,
      account_id: e.account_id || '',
      account_label: e.account_label || '',
      model: e.model || '',
      api: e.api || 'chat.completions',
      attempts: e.attempts ?? 1,
      input_tokens: e.input_tokens || 0,
      output_tokens: e.output_tokens || 0,
      cached_tokens: 0,
      new_input_tokens: e.input_tokens || 0,
      cache_hit: false,
      matched_prefix: '',
      cache_mode: mode,
      prefix_hash: e.prefix_hash || '',
      prefix_tokens: e.prefix_tokens || 0,
      prefix_candidates: candidates.map(c => ({ hash: c.hash, tokens: c.tokens })),
      conv_id: e.conv_id || '',
      parent_uuid: e.parent_uuid || '',
      reused_upstream: !!e.reused_upstream,
      status: e.status ?? 200,
      ok: e.ok !== false,
      latency_ms: e.latency_ms ?? 0,
      ttfb_ms: e.ttfb_ms ?? null,
      effort: e.effort || '',
      // ---- 真实输出速度（时间轴拆开，不让思考/空闲混进分母）----
      text_tokens: e.text_tokens || 0,
      think_tokens: e.think_tokens || 0,
      gen_ms: e.gen_ms || 0,        // 整个吐字窗口（首增量 -> 末增量）
      write_ms: e.write_ms || 0,    // 真正在写正文的时间（首正文 -> 末正文）
      think_ms: e.think_ms || 0,    // 思考期
      idle_ms: e.idle_ms || 0,      // 末增量之后的空闲（上游吊连接）
      tps: e.tps || 0,              // 真实出字速度：正文 token / 书写秒数
      tps_e2e: e.tps_e2e || 0,      // 端到端吐字速度（含思考摘要）
      tps_legacy: e.tps_legacy || 0, // 老口径（输出 ÷ 收尾前全部时间），仅对比用
      error: e.error || '',
      estimated: true,
    };

    // 最长公共前缀命中
    if (mode !== 'off' && entry.ok && candidates.length) {
      for (let i = candidates.length - 1; i >= 0; i--) {
        const c = candidates[i];
        const prev = idx.get(key(entry.account_id, c.hash));
        if (prev && ts - prev.ts <= ttl && prev.tokens > 0) {
          entry.cached_tokens = Math.min(entry.input_tokens, prev.tokens);
          entry.matched_prefix = c.hash;
          entry.cache_hit = entry.cached_tokens > 0;
          break;
        }
      }
    }
    entry.new_input_tokens = Math.max(0, entry.input_tokens - entry.cached_tokens);

    try { fs.appendFileSync(dayFile(dir, ts), JSON.stringify(entry) + '\n', 'utf8'); }
    catch (err) { console.warn('[usage] append failed:', err.message); }

    if (!entry.ok) return entry;
    for (const c of candidates) {
      const k = key(entry.account_id, c.hash);
      const prev = idx.get(k);
      if (!prev || prev.ts <= ts) {
        idx.set(k, { ts, tokens: c.tokens, conv_id: entry.conv_id, parent_uuid: entry.parent_uuid });
      }
    }
    return entry;
  }

  /** CACHE_MODE=reuse：找可复用的上游会话（返回最长命中项） */
  function reusable(accountId, candidates = []) {
    if (mode !== 'reuse' || !candidates.length) return null;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i];
      const p = idx.get(key(accountId, c.hash));
      if (p && Date.now() - p.ts <= ttl && p.conv_id && p.parent_uuid) {
        return { ...p, hash: c.hash, tokens: c.tokens };
      }
    }
    return null;
  }

  function allEntries(range = 'today') {
    const now = Date.now();
    let files;
    if (range === 'today') files = [dayFile(dir, now)];
    else if (range === 'yesterday') files = [dayFile(dir, now - DAY)];
    else if (range === '7d') files = Array.from({ length: 7 }, (_, i) => dayFile(dir, now - i * DAY));
    else {
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); }
      catch { files = []; }
    }
    return files.flatMap(readLines).sort((a, b) => a.ts - b.ts);
  }

  function summary(range = 'today', filter = {}) {
    let rows = allEntries(range);
    if (filter.accountId) rows = rows.filter(r => r.account_id === filter.accountId);
    if (filter.model) rows = rows.filter(r => r.model === filter.model);

    const hours = new Map(), accounts = new Map(), models = new Map();
    let requests = 0, okRequests = 0, input = 0, output = 0, cached = 0, newInput = 0, hits = 0, latencySum = 0;
    // 真实输出速度的聚合
    let tpsSum = 0, tpsN = 0, textTokSum = 0, writeMsSum = 0, thinkMsSum = 0, idleMsSum = 0, idleN = 0;

    for (const e of rows) {
      requests++;
      if (e.ok) okRequests++;
      input += e.input_tokens || 0;
      output += e.output_tokens || 0;
      cached += e.cached_tokens || 0;
      newInput += e.new_input_tokens ?? 0;
      if (e.cache_hit) hits++;
      latencySum += e.latency_ms || 0;
      if (e.tps > 0) { tpsSum += e.tps; tpsN++; }
      textTokSum += e.text_tokens || 0;
      writeMsSum += e.write_ms || 0;
      thinkMsSum += e.think_ms || 0;
      if (e.idle_ms > 0) { idleMsSum += e.idle_ms; idleN++; }

      const hk = hourKey(e.ts);
      const h = hours.get(hk) || { hour: hk, requests: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
      h.requests++; h.input_tokens += e.input_tokens || 0; h.output_tokens += e.output_tokens || 0; h.cached_tokens += e.cached_tokens || 0;
      hours.set(hk, h);

      const ak = e.account_id || 'unknown';
      const a = accounts.get(ak) || {
        account_id: ak, account_label: e.account_label || ak, requests: 0, ok_requests: 0,
        input_tokens: 0, output_tokens: 0, cached_tokens: 0, new_input_tokens: 0, cache_hits: 0,
      };
      a.requests++; if (e.ok) a.ok_requests++;
      a.input_tokens += e.input_tokens || 0; a.output_tokens += e.output_tokens || 0;
      a.cached_tokens += e.cached_tokens || 0; a.new_input_tokens += e.new_input_tokens ?? 0;
      if (e.cache_hit) a.cache_hits++;
      accounts.set(ak, a);

      const mk = e.model || 'unknown';
      const m = models.get(mk) || { model: mk, requests: 0, input_tokens: 0, output_tokens: 0 };
      m.requests++; m.input_tokens += e.input_tokens || 0; m.output_tokens += e.output_tokens || 0;
      models.set(mk, m);
    }
    for (const a of accounts.values()) {
      a.total_tokens = a.input_tokens + a.output_tokens;
      a.cache_hit_rate = a.input_tokens ? a.cached_tokens / a.input_tokens : 0;
    }
    for (const m of models.values()) m.total_tokens = m.input_tokens + m.output_tokens;

    return {
      range, from: rows.length ? rows[0].ts : null, to: rows.length ? rows[rows.length - 1].ts : null,
      total_requests: requests, ok_requests: okRequests,
      total_input_tokens: input, total_output_tokens: output, total_tokens: input + output,
      new_input_tokens: newInput, cached_tokens: cached,
      cache_hit_rate: input ? cached / input : 0,
      cache_hit_requests: hits,
      cache_hit_request_rate: requests ? hits / requests : 0,
      avg_latency_ms: requests ? Math.round(latencySum / requests) : 0,
      // ---- 真实输出速度（正文 token ÷ 真正在写正文的时间）----
      avg_tps: tpsN ? +(tpsSum / tpsN).toFixed(1) : 0,
      avg_tps_weighted: writeMsSum > 0 ? +((textTokSum / (writeMsSum / 1000)).toFixed(1)) : 0,
      avg_think_ms: okRequests ? Math.round(thinkMsSum / okRequests) : 0,
      avg_idle_ms: idleN ? Math.round(idleMsSum / idleN) : 0,
      cost: null, estimated: true, cache_mode: mode, cache_ttl_ms: ttl,
      hourly: [...hours.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
      by_account: [...accounts.values()].sort((a, b) => b.total_tokens - a.total_tokens),
      by_model: [...models.values()].sort((a, b) => b.total_tokens - a.total_tokens),
      logs: rows.slice(-50).reverse(),
    };
  }

  function logs(opts = {}) {
    let rows = allEntries(opts.range || 'today');
    if (opts.accountId) rows = rows.filter(r => r.account_id === opts.accountId);
    return rows.reverse().slice(0, +(opts.limit || 100));
  }

  return { record, summary, logs, reusable, prefixOf, mode, ttl, dir };
}

/**
 * completion-engine.mjs —— 核心推理与模型调度引擎
 *
 * 负责模型映射、工具规范化、上下文优化、上游请求体构建、SSE 流规范化、
 * 账号池智能调度与故障转移（Failover）以及首字前故障重试机制（Stream Recovery）。
 */
import { randomUUID } from 'node:crypto';
import { optimizeContext } from './context-optimizer.mjs';
import {
  renderPrompt,
  textOf,
  pickEffort,
  countTokens,
  estimateInputTokens,
} from './prompt-renderer.mjs';
import { normalizeTool } from './responses-api.mjs';
import { collectImages, uploadImages, hasImgBlocks } from './image-uploader.mjs';
import { validatedEvents } from './upstream-events.mjs';
import { getConversationKey, CONV_ROUTING } from './conversation-router.mjs';
import { prefixOf } from './usage-log.mjs';
import { sleep } from './accounts.mjs';
import {
  noteChallenge,
  clientGoneError,
  createConversation,
  callCompletion,
} from './claude-web-client.mjs';

let _defaultEngine = null;

export function setDefaultEngine(engine) {
  _defaultEngine = engine;
}

export function getDefaultEngine() {
  return _defaultEngine;
}

/**
 * 将多模态消息及历史工具结果块转换为统一的 Chat Completion 消息列表
 */
export function messageToChat({ role, content }) {
  if (!Array.isArray(content)) return [{ role, content }];
  const payload = blocks => hasImgBlocks(blocks) ? blocks : textOf(blocks);
  if (role === 'assistant') {
    const calls = content.filter(b => b.type === 'tool_use').map(b => ({
      id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
    }));
    return [{ role, content: payload(content), tool_calls: calls.length ? calls : undefined }];
  }
  if (role !== 'user' || !content.some(b => b.type === 'tool_result')) {
    return [{ role, content: payload(content) }];
  }
  const messages = [];
  let siblings = [];
  for (const block of content) {
    if (block.type !== 'tool_result') {
      siblings.push(block);
      continue;
    }
    if (siblings.length) messages.push({ role, content: payload(siblings) });
    siblings = [];
    messages.push({
      role: 'tool',
      tool_call_id: block.tool_use_id,
      is_error: block.is_error === true,
      content: payload(block.content),
    });
  }
  if (siblings.length) messages.push({ role, content: payload(siblings) });
  return messages;
}

/**
 * 映射请求模型名称至上游 Claude 支持的模型
 */
export function mapModel(m) {
  if (m != null && typeof m !== 'string') throw Object.assign(new Error('model must be a string'), { status: 400 });
  const s = (m || '').toLowerCase();
  if (s.includes('haiku')) return 'claude-haiku-5-5';
  // free 档没有 Opus / Fable 权限，统一映射到 Sonnet
  return 'claude-sonnet-5-5';
}

/**
 * 工具定义归一化：把各种协议形状统一成内部 function 形状
 */
export function mapTools(tools) {
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
 * 上下文优化：修剪历史旧图片与冗长工具输出，大幅减小 prompt 体积
 */
export function prepareContext(body, pool = null) {
  const p = pool || (this instanceof CompletionEngine ? this.pool : null) || getDefaultEngine()?.pool;
  if (p?.data?.pruneContext !== false && Array.isArray(body?.messages)) {
    const maxToolChars = +(p?.data?.pruneMaxToolChars || 8000);
    return {
      ...body,
      messages: optimizeContext(body.messages, {
        keepRecentTurns: Math.max(2, +(p?.data?.pruneKeepRecentTools || 4)),
        maxImages: 3,
        maxChars: maxToolChars,
      }),
    };
  }
  return body;
}

/**
 * 构建发往上游 Claude Web 的请求体
 */
export function buildUpstreamBody(body, model, { pool = null, tz = null } = {}) {
  const p = pool || (this instanceof CompletionEngine ? this.pool : null) || getDefaultEngine()?.pool;
  const timezone = tz || (this instanceof CompletionEngine ? this.tz : null) || getDefaultEngine()?.tz || process.env.TZ || 'Asia/Shanghai';
  const out = {
    prompt: renderPrompt(body, {
      pool: p,
      onPruned: ({ prunedCount, savedChars }) => {
        console.log(`[prune] 上下文智能瘦身: 修剪了 ${prunedCount} 处历史工具大输出, 节省约 ${savedChars} 字符 (~${Math.round(savedChars / 4)} Tokens)`);
      },
    }),
    model,
    parent_message_uuid: randomUUID(),
    timezone,
    attachments: [],
    files: [],
    rendering_mode: 'messages',
  };
  const rawTools = body.tools || (Array.isArray(body.functions) ? body.functions : null);
  const tools = mapTools(rawTools);
  if (tools) out.tools = tools;
  const effort = pickEffort(body, p);
  if (effort) out.effort = effort;
  return out;
}

/**
 * 收集来自上游校验事件的时间线与用量信息，并生成规范化流事件
 */
export async function* normalizeSse(stream, acct, ctx, pool = null, options = {}) {
  let textStr = '';
  let thinkStr = '';
  let jsonStr = '';
  let totals;
  function outputUsage() {
    if (!totals) {
      const text = countTokens(textStr), thinking = countTokens(thinkStr);
      totals = { text, thinking, output: text + thinking + countTokens(jsonStr) };
    }
    return totals;
  }
  let sawStopReason = false;
  let firstDeltaAt = null;
  let firstTextAt = null;
  let lastDeltaAt = null;
  let lastTextAt = null;

  try {
    for await (let ev of validatedEvents(stream, ctx?._tools, options)) {
      ctx?._turn?.observe(ev);
      if (ev.type === 'message_limit' && acct && pool) {
        pool.updateQuota(acct, ev.message_limit);
      }
      if (ev.type === 'message_start' && ctx) {
        if (ev.message?.uuid) ctx.parent_uuid = ev.message.uuid;
        ev = { ...ev, message: { ...ev.message, usage: { ...ev.message?.usage, input_tokens: ctx.input_tokens, output_tokens: 0 } } };
      }
      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        const now = Date.now();
        const piece = (typeof d.text === 'string' ? d.text.length : 0) +
          (typeof d.partial_json === 'string' ? d.partial_json.length : 0) +
          (typeof d.thinking === 'string' ? d.thinking.length : 0) +
          (typeof d.summary?.summary === 'string' ? d.summary.summary.length : 0);
        if (piece) {
          if (firstDeltaAt == null) firstDeltaAt = now;
          lastDeltaAt = now;
          if (ctx && ctx.ttfb_ms == null) ctx.ttfb_ms = now - ctx.startedAt;
        }
        if (typeof d.text === 'string' && d.text) {
          textStr += d.text;
          if (firstTextAt == null) firstTextAt = now;
          lastTextAt = now;
        } else if (typeof d.partial_json === 'string' && d.partial_json) {
          jsonStr += d.partial_json;
        } else if (typeof d.thinking === 'string' && d.thinking) {
          thinkStr += d.thinking;
        } else if (typeof d.summary?.summary === 'string' && d.summary.summary) {
          thinkStr += d.summary.summary;
        }
      }
      if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
        sawStopReason = true;
        ev = { ...ev, usage: { ...ev.usage, input_tokens: ctx?.input_tokens || 0, output_tokens: outputUsage().output } };
      } else if (ev.type === 'message_stop' && !sawStopReason) {
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { input_tokens: ctx?.input_tokens || 0, output_tokens: outputUsage().output },
        };
      }
      yield ev;
    }
  } finally {
    const { text: textTokens, thinking: thinkTokens, output: outTokens } = outputUsage();
    if (acct && pool) {
      if (typeof pool.addTokens === 'function') pool.addTokens(acct, 0, outTokens);
      else if (typeof pool.noteTokens === 'function') pool.noteTokens(acct, 0, outTokens);
    }
    if (ctx) {
      const end = Date.now();
      ctx.output_tokens = outTokens;
      ctx.text_tokens = textTokens;
      ctx.think_tokens = thinkTokens;
      ctx.latency_ms = end - ctx.startedAt;

      ctx.gen_ms = (firstDeltaAt != null && lastDeltaAt != null) ? lastDeltaAt - firstDeltaAt : 0;
      ctx.write_ms = (firstTextAt != null && lastTextAt != null) ? lastTextAt - firstTextAt : 0;
      ctx.think_ms = (firstDeltaAt != null && firstTextAt != null) ? Math.max(0, firstTextAt - firstDeltaAt) : 0;
      ctx.idle_ms = (lastDeltaAt != null) ? Math.max(0, end - lastDeltaAt) : 0;

      const MIN_WIN = 100;
      ctx.tps = ctx.write_ms >= MIN_WIN ? (textTokens / (ctx.write_ms / 1000)) : 0;
      ctx.tps_e2e = ctx.gen_ms >= MIN_WIN ? (outTokens / (ctx.gen_ms / 1000)) : 0;
      const legacyWin = end - ctx.startedAt - (ctx.ttfb_ms ?? 0);
      ctx.tps_legacy = legacyWin >= MIN_WIN ? (outTokens / (legacyWin / 1000)) : 0;
    }
  }
}

/**
 * 根据异常类型映射 HTTP 响应状态码
 */
export function completionErrorStatus(e) {
  if (!e) return 500;
  if (e.name === 'AbortError') return 499;
  const kind = e.kind;
  return kind === 'challenge' || kind === 'transient' || kind === 'upstream_stream' ? 502
      : kind === 'rate_limit' || kind === 'concurrency' || e.status === 429 ? 429
      : kind === 'auth' || e.status === 401 || e.status === 403 ? 401
      : e.status >= 400 && e.status < 500 ? e.status : 500;
}

/**
 * 记录单次推理调用的用量日志
 */
export function recordCompletion(ctx, status, error = '', usage = null) {
  if (!ctx) return;
  ctx.status = status;
  ctx.ok = status >= 200 && status < 300;
  ctx.error = String(error).slice(0, 200);
  ctx.latency_ms = Date.now() - (ctx.startedAt || Date.now());
  if (usage?.record) usage.record(ctx);
}

/**
 * 判定事件是否已经产生了用户可见内容或工具调用
 */
export function hasGeneratedOutput(ev) {
  if (!ev) return false;
  if (ev.type === 'content_block_start') {
    const block = ev.content_block || {};
    // 纯思考块开始 (type === 'thinking') 或空文本块尚未产生任何正文，不视为已产生实质性输出
    return block.type === 'tool_use' || (block.type === 'text' && !!block.text);
  }
  if (ev.type !== 'content_block_delta') return false;
  const delta = ev.delta || {};
  return (delta.type === 'text_delta' && !!delta.text) ||
    (delta.type === 'input_json_delta' && !!delta.partial_json) ||
    (delta.type === 'thinking_delta' && !!delta.thinking) ||
    (delta.type === 'thinking_summary_delta' && !!delta.summary?.summary);
}

/**
 * 判定事件是否为思考增量
 */
export function isThinkingOutput(ev) {
  if (!ev || ev.type !== 'content_block_delta') return false;
  const delta = ev.delta || {};
  return (delta.type === 'thinking_delta' && !!delta.thinking) ||
    (delta.type === 'thinking_summary_delta' && !!delta.summary?.summary);
}

/**
 * 等待并获取可用账号（带超时等待，让 429 冷却中的账号有机会恢复）
 * 兼容 (exclude, signal, preferredId, pool) 与 (pool, exclude, signal, preferredId) 两种调用形态
 */
export async function acquireAccount(arg1, arg2, arg3, arg4) {
  let pool, exclude, signal, preferredId;
  if (arg1 && typeof arg1.acquire === 'function') {
    pool = arg1;
    exclude = arg2;
    signal = arg3;
    preferredId = arg4;
  } else {
    exclude = arg1;
    signal = arg2;
    preferredId = arg3;
    pool = arg4 || this?.pool || getDefaultEngine()?.pool;
  }
  if (!pool) return null;
  const waitMs = +(pool?.data?.waitTimeoutMs ?? pool?.opts?.waitTimeoutMs ?? 30000);
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (signal?.aborted) return null;
    const a = pool.acquire(exclude, preferredId);
    if (a) return a;
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

/**
 * 挂载首字输出前的自动故障转移流包装器（Stream Recovery）
 */
export function attachStreamRecovery(run, body, model, signal, req, ctx, deps = {}) {
  const engine = (this instanceof CompletionEngine ? this : null) || deps.engine || getDefaultEngine();
  const pool = deps.pool || engine?.pool;
  const runCompletionFn = deps.runCompletion || engine?.runCompletion || runCompletion;
  let current = run;
  let consumed = false;
  const initialRelease = run.release;
  run.release = (...args) => current === run ? initialRelease(...args) : current.release(...args);
  run.events = () => {
    if (consumed) throw new Error('completion stream already consumed');
    consumed = true;
    return (async function* () {
      const isStream = Boolean(body?.stream);
      let committed = false;
      let retries = 0;
      let conflictRetries = 0;
      let pending = [];
      let pendingBytes = 0;
      for (;;) {
        try {
          for await (const event of normalizeSse(current.stream, current.account, ctx, pool, { signal })) {
            // ping 事件属于保活心跳包，不携带实质回答内容，优先下发给下游以重置客户端 SSE idle 计时器
            if (event.type === 'ping') {
              yield event;
              continue;
            }
            // 流式模式下产生首个可见输出才提交并开始向下游下发；非流式模式下全量缓冲保障整段重试自愈能力
            if (isStream && !committed && hasGeneratedOutput(event)) {
              for (const buffered of pending) yield buffered;
              pending = [];
              pendingBytes = 0;
              committed = true;
            }
            if (committed) yield event;
            else {
              const eventBytes = Buffer.byteLength(JSON.stringify(event));
              if (pending.length >= 8192 || pendingBytes + eventBytes > 8 * 1024 * 1024) {
                for (const buffered of pending) yield buffered;
                pending = [];
                pendingBytes = 0;
                committed = true;
                yield event;
              } else {
                pending.push(event);
                pendingBytes += eventBytes;
              }
            }
          }
          for (const buffered of pending) yield buffered;
          return;
        } catch (error) {
          const conflict = error.code === 'UPSTREAM_MESSAGE_CONFLICT';
          if (conflict) conflictRetries++;
          const isTransportOrStall = error.code === 'UPSTREAM_TRANSPORT_INTERRUPTED' ||
            error.code === 'UPSTREAM_STALLED' ||
            error.code === 'UPSTREAM_ERROR_EVENT' ||
            error.kind === 'transient' ||
            /stopped making progress|stalled|transport interrupted|fetch failed|timeout|upstream reported an error/i.test(error.message || '');
          if (committed || retries >= 3 || conflictRetries > 1 || signal?.aborted || (!conflict && !isTransportOrStall)) throw error;
          const failed = current;
          failed.release(false, error.message, 'neutral');
          retries++;
          try {
            console.log(`[stream] pre-output failure (${error.message || error.code}) on ${failed.account.label} -> 自动故障转移至备选账号 (第${retries}次)`);
            const others = pool ? pool.eligible(Date.now(), new Set([failed.account.id])) : [];
            const exclude = (others.length > 0 && !conflict) ? [failed.account.id] : [];
            current = await runCompletionFn.call(engine, body, model, signal, req, ctx, exclude, false, {
              ...deps,
              pool,
              engine,
            });
          } catch (retryError) {
            console.warn(`[stream] pre-output recovery unavailable: kind=${retryError?.kind || 'unknown'} status=${retryError?.status || 0}`);
            throw error;
          }
          delete ctx.status;
          ctx.error = '';
          pending = [];
          pendingBytes = 0;
        }
      }
    })();
  };
  return run;
}

/**
 * 核心：选一个账号跑一次 completion，失败自动换下一个账号（failover）
 */
export async function runCompletion(body, model, signal, req, ctx, excludedAccounts = [], withRecovery = true, deps = {}) {
  const engine = (this instanceof CompletionEngine ? this : null) || deps.engine || getDefaultEngine() || {};
  const pool = deps.pool || engine.pool;
  const usage = deps.usage || engine.usage;
  const keys = deps.keys || engine.keys;
  const legacyKeyObj = deps.legacyKeyObj || engine.legacyKeyObj;
  const tz = deps.tz || engine.tz || process.env.TZ || 'Asia/Shanghai';

  if (!pool) throw new Error('AccountPool is required for runCompletion');

  const session = getConversationKey(body, req);
  const convKey = session && `${req?.keyScope}:${session}`;
  let preferredId = convKey ? CONV_ROUTING.get(convKey)?.accountId : null;

  const originalBody = body;
  body = prepareContext(body, pool);
  const upBody = buildUpstreamBody(body, model, { pool, tz });
  const inputTokens = estimateInputTokens(upBody);
  const images = collectImages(body);
  const tried = new Set(excludedAccounts);
  let lastErr = null;
  let failovers = 0;
  let queueWaits = 0;
  const queueStart = Date.now();
  const queueBudget = +(process.env.ACCOUNT_QUEUE_BUDGET_MS || 30000);

  for (;;) {
    if (signal?.aborted) throw clientGoneError();

    const nowMs = Date.now();
    const candidates = pool.accounts().filter(a =>
      a.enabled && a.sessionKey && a.org && !tried.has(a.id));
    const readyNow = candidates.filter(a =>
      nowMs >= (a.cooldownUntil || 0) && !(a.exhaustedUntil > nowMs));
    const soon = candidates.filter(a =>
      !readyNow.includes(a) && (a.cooldownUntil || 0) - nowMs <= queueBudget);

    const configuredMaxFail = +(pool?.data?.maxFailover ?? pool.opts.maxFailover ?? 3);
    const dynamicMaxFail = Math.max(configuredMaxFail, Math.min(20, Math.max(8, candidates.length)));
    if (failovers >= dynamicMaxFail && !readyNow.length) break;

    if (!readyNow.length && !soon.length) break;

    const targetPref = (preferredId && !tried.has(preferredId)) ? preferredId : null;
    const acct = await acquireAccount(pool, tried, signal, targetPref);
    if (!acct) {
      if (signal?.aborted) throw clientGoneError();
      break;
    }

    if (ctx) {
      ctx.attempts = (ctx.attempts || 0) + 1;
      Object.assign(ctx, {
        account_id: acct.id, account_label: acct.label, input_tokens: 0,
        conv_id: '', parent_uuid: '', reused_upstream: false,
      });
    }

    try {
      if (convKey) {
        CONV_ROUTING.set(convKey, { accountId: acct.id, at: Date.now() });
      }

      const pfx = prefixOf(body, JSON.stringify([req?.keyScope, acct.id]), model);
      const hist = (body.messages || []).filter(m => m.role !== 'system' && m.role !== 'developer');
      const turn = !images.length && ctx && ctx.attempts === 1 && usage?.beginTurn
        ? usage.beginTurn(originalBody, req?.keyScope, acct.id, model, session) : null;
      if (ctx) {
        ctx._turn = turn;
        Object.assign(ctx, {
          _tools: upBody.tools || [], effort: upBody.effort || '',
          prefix_hash: pfx.hash, prefix_tokens: pfx.tokens, prefix_candidates: pfx.candidates,
        });
      }
      const reuse = turn?.parent;

      let conv, reqBody = upBody;
      if (images.length) {
        const up = await uploadImages(acct, images, signal);
        reqBody = { ...upBody, files: up.uuids };
        if (up.failed.length) {
          reqBody.prompt = `${upBody.prompt}\n\n[系统提示] 本次有 ${up.failed.length} 张图片上传失败，你无法看到它们：${up.failed.join('；')}`;
        }
        if (ctx) {
          ctx.image_files = up.uuids.length;
          if (up.failed.length) ctx.image_errors = up.failed.join('; ').slice(0, 200);
        }
        if (up.uuids.length) console.log(`[image] ${acct.label}: ${up.uuids.length} 张已上传, ${up.failed.length} 张失败`);
      }
      if (reuse) {
        conv = reuse.conv_id;
        const last = hist[hist.length - 1];
        reqBody = {
          ...upBody,
          prompt: textOf(last?.content) || 'hi',
          parent_message_uuid: reuse.parent_uuid,
        };
        if (ctx) ctx.reused_upstream = true;
      } else {
        conv = await createConversation(acct, 'proxy', signal);
      }
      if (ctx) {
        ctx.conv_id = conv;
        ctx.input_tokens = inputTokens;
      }

      const stream = await callCompletion(acct, conv, reqBody, signal);
      let released = false;
      const release = (ok = true, why = '', kind = 'transient') => {
        if (released) return;
        released = true;
        if (ok && !signal?.aborted) turn?.save(conv);
        if (signal?.aborted) { pool.release(acct, false); }
        else if (ok) pool.release(acct, true);
        else if (kind === 'neutral') pool.release(acct, false);
        else pool.fail(acct, kind, why || 'stream failed');
        if (!ok && ctx) {
          ctx.status = 502;
          ctx.error = why;
        }
        if (req?.apiKey && keys && req.apiKey !== legacyKeyObj) {
          keys.noteTokens(req.apiKey, (ctx?.input_tokens || 0) + (ctx?.output_tokens || 0));
        }
      };
      if (failovers > 0 || queueWaits > 0) {
        console.log(`[pool] ${failovers > 0 ? 'failover' : 'queued'} -> ${acct.label} (waits=${queueWaits})`);
      }
      if (ctx?.input_tokens && pool) {
        if (typeof pool.addTokens === 'function') pool.addTokens(acct, ctx.input_tokens, 0);
        else if (typeof pool.noteTokens === 'function') pool.noteTokens(acct, ctx.input_tokens, 0);
      }
      const run = { stream, upBody: reqBody, account: acct, release, ctx };
      const streamDeps = { pool, runCompletion: engine?.runCompletion ? engine.runCompletion.bind(engine) : runCompletion, engine };
      return withRecovery ? attachStreamRecovery.call(engine, run, body, model, signal, req, ctx, streamDeps) : run;
    } catch (e) {
      if (e?.name === 'AbortError' || signal?.aborted) {
        pool.release(acct, false);
        throw clientGoneError();
      }
      lastErr = e;
      const kind = e.kind || 'error';
      if (kind === 'challenge') noteChallenge();
      if (e?.socketReset) {
        console.warn(`[pool] ${acct.label} socket reset (${e.message}) -> neutral release (不触发账号冷却), 换号或重试`);
        pool.release(acct, false);
      } else {
        const cool = pool.fail(acct, kind, e.message, { resetsAt: e.resetsAt, reason: e.reason });
        console.warn(`[pool] ${acct.label} ${kind} -> cooldown ${Math.round(cool / 1000)}s: ${String(e.message).slice(0, 160)}`);
      }
      if (!e.retryable) break;
      if (kind === 'concurrency' || kind === 'transient') {
        if (Date.now() - queueStart >= queueBudget) break;
        queueWaits++;
        if (kind === 'concurrency') {
          const others = pool.eligible(Date.now(), tried).filter(a => a.id !== acct.id);
          if (others.length) {
            tried.add(acct.id);
            console.log(`[pool] ${acct.label} concurrency-429 -> 立即切换其他可用备选账号(剩${others.length}个)`);
            await sleep(50);
            continue;
          }
          const backoff = Math.min(5000, 1500 * queueWaits);
          console.log(`[pool] ${acct.label} concurrency-429 -> 无备胎原地等待 ${Math.round(backoff / 1000)}s (waits=${queueWaits})`);
          await sleep(backoff);
          continue;
        }
        if (kind === 'transient') {
          const others = pool.eligible(Date.now(), tried).filter(a => a.id !== acct.id);
          if (others.length) {
            tried.add(acct.id);
            console.log(`[pool] ${acct.label} transient(${e.message}) -> 立即切换其他可用备选账号(剩${others.length}个)`);
            await sleep(50);
            continue;
          }
          if (queueWaits >= 3) break;
          await sleep(Math.min(5000, 500 * queueWaits));
          continue;
        }
      }
      tried.add(acct.id);
      failovers++;
      if (convKey && preferredId === acct.id) {
        CONV_ROUTING.delete(convKey);
        preferredId = null;
      }
      const maxFail = +(pool?.data?.maxFailover ?? pool.opts.maxFailover ?? 3);
      if (failovers <= maxFail) {
        await sleep(kind === 'rate_limit' && !e.resetsAt ? 1000 : 300);
      }
    }
  }
  if (signal?.aborted) throw clientGoneError();
  throw lastErr || Object.assign(new Error('no eligible account (all cooling down or disabled)'),
    { kind: 'rate_limit', retryable: false, status: 429 });
}

/**
 * 获取可用模型列表
 */
export function modelList(upstreamModels) {
  const defaultModels = ['claude-sonnet-5-5', 'claude-haiku-5-5'];
  const baseModels = Array.isArray(upstreamModels) && upstreamModels.length ? upstreamModels : defaultModels;
  const ids = (process.env.MODELS
    ? process.env.MODELS.split(',')
    : baseModels
  ).map(s => s.trim()).filter(Boolean);
  const now = Math.floor(Date.now() / 1000);
  return ids.map(id => ({ id, object: 'model', created: now, owned_by: 'anthropic' }));
}

/**
 * CompletionEngine 核心引擎封装类
 */
export class CompletionEngine {
  constructor({ pool, usage, keys, legacyKeyObj, tz = process.env.TZ || 'Asia/Shanghai', getUpstream } = {}) {
    this.pool = pool;
    this.usage = usage;
    this.keys = keys;
    this.legacyKeyObj = legacyKeyObj;
    this.tz = tz;
    this.getUpstream = typeof getUpstream === 'function' ? getUpstream : (() => ({}));
    if (!_defaultEngine) {
      _defaultEngine = this;
    }
  }

  modelList() {
    const up = this.getUpstream();
    return modelList(up.models);
  }

  mapModel(m) {
    return mapModel(m);
  }

  mapTools(tools) {
    return mapTools(tools);
  }

  messageToChat(msg) {
    return messageToChat(msg);
  }

  prepareContext(body) {
    return prepareContext(body, this.pool);
  }

  buildUpstreamBody(body, model) {
    return buildUpstreamBody(body, model, { pool: this.pool, tz: this.tz });
  }

  normalizeSse(stream, acct, ctx, options = {}) {
    return normalizeSse(stream, acct, ctx, this.pool, options);
  }

  completionErrorStatus(e) {
    return completionErrorStatus(e);
  }

  recordCompletion(ctx, status, error = '') {
    return recordCompletion(ctx, status, error, this.usage);
  }

  hasGeneratedOutput(ev) {
    return hasGeneratedOutput(ev);
  }

  isThinkingOutput(ev) {
    return isThinkingOutput(ev);
  }

  acquireAccount(exclude, signal, preferredId) {
    return acquireAccount(this.pool, exclude, signal, preferredId);
  }

  attachStreamRecovery(run, body, model, signal, req, ctx) {
    return attachStreamRecovery.call(this, run, body, model, signal, req, ctx, {
      pool: this.pool,
      engine: this,
      runCompletion: this.runCompletion.bind(this),
    });
  }

  runCompletion(body, model, signal, req, ctx, excludedAccounts = [], withRecovery = true) {
    return runCompletion.call(this, body, model, signal, req, ctx, excludedAccounts, withRecovery, {
      pool: this.pool,
      usage: this.usage,
      keys: this.keys,
      legacyKeyObj: this.legacyKeyObj,
      tz: this.tz,
      engine: this,
    });
  }
}

/**
 * 创建 CompletionEngine 实例的工厂函数
 */
export function createCompletionEngine(options = {}) {
  return new CompletionEngine(options);
}

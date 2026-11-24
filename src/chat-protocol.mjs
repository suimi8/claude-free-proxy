/**
 * chat-protocol.mjs —— OpenAI Chat & 补全协议序列化引擎
 *
 * 负责 OpenAI Chat 协议映射、SSE 流式数据帧下发、非流式事件收集组装以及保持连接的心跳。
 */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { extractPseudoToolCalls, findToolCallTrigger } from './pseudo-tools.mjs';

/**
 * 背压感知写入函数：支持当写缓冲区打满时等待 drain 事件，并在连接关闭或异常时快速中断
 * @param {object} res HTTP 响应流
 * @param {string|Buffer} data 要写入的数据
 * @returns {Promise<boolean>} 是否成功写入
 */
export async function safeWrite(res, data) {
  if (!res || res.destroyed || res.writableEnded) return false;
  const canContinue = res.write(data);
  if (!canContinue && canContinue !== undefined && !res.destroyed && !res.writableEnded) {
    if (typeof res.once === 'function') {
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      res.once('close', onAbort);
      res.once('error', onAbort);
      try {
        await once(res, 'drain', { signal: ac.signal });
      } catch {
        return false;
      } finally {
        res.removeListener?.('close', onAbort);
        res.removeListener?.('error', onAbort);
      }
    }
  }
  return !res.destroyed && !res.writableEnded;
}

/**
 * 将上游停机原因映射为 OpenAI finish_reason
 * @param {string} r
 * @returns {string}
 */
export function mapStopReason(r) {
  switch (r) {
    case 'tool_use': return 'tool_calls';
    case 'max_tokens': return 'length';
    case 'stop_sequence': return 'stop';
    case 'refusal': return 'content_filter';
    default: return 'stop';
  }
}

/**
 * 生成新 Chat Completion ID
 * @returns {string}
 */
export function newChatId() {
  return `chatcmpl-${randomUUID()}`;
}

/**
 * 计算 Chat Completion 格式的 usage
 * @param {object} ctx
 * @returns {{prompt_tokens: number, completion_tokens: number, total_tokens: number}}
 */
export function chatUsage(ctx) {
  const inTokens = ctx?.input_tokens ?? 0;
  const outTokens = ctx?.output_tokens ?? 0;
  return {
    prompt_tokens: inTokens,
    completion_tokens: outTokens,
    total_tokens: inTokens + outTokens,
  };
}

/**
 * 确定最终完成原因：只要包含有效 tool_calls，优先以 tool_calls 为准
 * @param {object} result
 * @returns {string}
 */
export function resolveFinish(result) {
  if (result?.toolCalls?.length) return 'tool_calls';
  return mapStopReason(result?.stop);
}

/**
 * 将内部/上游收集到的完整结果序列化为 OpenAI Chat Completion 响应对象
 * @param {object} result
 * @param {string} model
 * @param {object} ctx
 * @returns {object}
 */
export function ant2oaiText(result, model, ctx) {
  const toolCalls = result?.toolCalls?.length ? result.toolCalls : undefined;
  const text = toolCalls && !result?.text ? null : (result?.text || null);
  const message = { role: 'assistant', content: text };
  if (result?.reasoning) message.reasoning_content = result.reasoning; // 思考摘要
  if (toolCalls) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl-${result?.id || randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result?.model || model,
    choices: [{
      index: 0,
      message,
      finish_reason: resolveFinish(result),
    }],
    usage: chatUsage(ctx),
  };
}

/**
 * 非流式：吃完整个上游 SSE 事件流再组装成结构化数据
 * 包含伪工具指令检测与兜底转换。
 *
 * @param {AsyncIterable} events
 * @param {object} ctx
 * @returns {Promise<{text: string, toolCalls: Array, stop: string|null, model: string|null, id: string|null, limit: any, reasoning: string}>}
 */
export async function collect(events, ctx) {
  let text = '';
  const thoughtBlocks = new Map();
  const toolCalls = [];
  const slot = new Map();
  let stop = null, model = null, id = null, limit = null;

  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start':
        id = ev.message?.id;
        model = ev.message?.model;
        break;
      case 'content_block_start': {
        const cb = ev.content_block || {};
        if (cb.type === 'tool_use') {
          const idx = slot.size;
          slot.set(ev.index, idx);
          toolCalls.push({ id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } });
        }
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta || {};
        if (d.type === 'text_delta') {
          text += d.text;
        } else if (d.type === 'thinking_summary_delta' || d.type === 'thinking_delta') {
          const s = d.type === 'thinking_delta' ? (d.thinking || '') : (d.summary?.summary || '');
          if (s) {
            const prev = thoughtBlocks.get(ev.index) || '';
            const separator = prev && d.type === 'thinking_summary_delta' ? '\n' : '';
            thoughtBlocks.set(ev.index, prev + separator + s);
          }
        } else if (d.type === 'input_json_delta') {
          const idx = slot.get(ev.index);
          if (toolCalls[idx]) toolCalls[idx].function.arguments += d.partial_json || '';
        }
        break;
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
        break;
      case 'message_limit':
        limit = ev.message_limit;
        break;
      case 'error':
        throw new Error(ev.error?.message || 'upstream error');
      default:
        break;
    }
  }

  // 兜底补救：如果模型在正文中输出了伪工具指令/XML调用且上游没出原生 tool_use，自动转换
  if (toolCalls.length === 0 && text) {
    const extracted = extractPseudoToolCalls(text);
    if (extracted.toolCalls.length > 0) {
      console.log(`[tool_fallback] (非流式) 拦截到模型正文输出伪工具/XML指令，已自动转换为 ${extracted.toolCalls.length} 个原生 tool_calls`);
      return {
        text: extracted.cleanText,
        toolCalls: extracted.toolCalls,
        stop: 'tool_use',
        model,
        id,
        limit,
        reasoning: [...thoughtBlocks.values()].join('\n'),
      };
    }
  }

  return {
    text,
    toolCalls,
    stop,
    model,
    id,
    limit,
    reasoning: [...thoughtBlocks.values()].join('\n'),
  };
}

/**
 * 维持客户端 SSE 连接心跳（定期下发 keep-alive / ping）
 * @param {object} res
 * @param {boolean} [isAnthropic=false]
 * @returns {() => void} 停止心跳回调
 */
export function heartbeat(res, isAnthropic = false) {
  const ping = async () => {
    if (!res?.destroyed && !res?.writableEnded) {
      if (isAnthropic) {
        await safeWrite(res, ': keep-alive\n\nevent: ping\ndata: {"type": "ping"}\n\n');
      } else {
        await safeWrite(res, ': keep-alive\n\n');
      }
    }
  };
  ping().catch(() => {});
  const timer = setInterval(() => { ping().catch(() => {}); }, 10000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * 流式：把上游事件逐个转成 OpenAI chunk 写出到客户端
 *
 * @param {object} res HTTP 响应对象
 * @param {object} run 执行运行器
 * @param {string} model 模型名称
 * @param {string} chatId 会话 ID
 * @param {boolean} includeUsage 是否在末尾 chunk 输出 usage
 */
export async function streamToClient(res, run, model, chatId, includeUsage = false) {
  const ctx = run?.ctx;
  const created = Math.floor(Date.now() / 1000);
  const stopHeartbeat = heartbeat(res, false);

  let aborted = false;
  const onClientDisconnect = () => {
    aborted = true;
    try { run?.stream?.destroy?.(); } catch {}
    try { run?.release?.(false, 'client disconnected'); } catch {}
  };

  res?.once?.('close', onClientDisconnect);
  res?.once?.('error', onClientDisconnect);

  const send = async (choices, usage) => {
    if (aborted || res?.destroyed || res?.writableEnded) return false;
    const data = { id: chatId, object: 'chat.completion.chunk', created, model, choices };
    if (includeUsage) data.usage = usage ?? null;
    const ok = await safeWrite(res, 'data: ' + JSON.stringify(data) + '\n\n');
    if (!ok) aborted = true;
    return ok;
  };
  const chunk = async (delta, finish_reason = null) => await send([{ index: 0, delta, finish_reason }]);
  const slot = new Map();
  let stop = null;
  let accumulatedText = '';
  let sentTextLength = 0;
  let pseudoToolMode = false;
  let finishedToolEmitted = false;
  const SAFE_WINDOW = 25;

  const flushFallbackToolsIfNeeded = async () => {
    if (aborted || slot.size > 0 || finishedToolEmitted) return;
    if (pseudoToolMode || findToolCallTrigger(accumulatedText) !== -1) {
      const extracted = extractPseudoToolCalls(accumulatedText);
      if (extracted.toolCalls.length > 0) {
        console.log(`[tool_fallback] (流式) 拦截到模型输出伪工具/XML指令，已自动下发 ${extracted.toolCalls.length} 个原生 tool_calls 给客户端`);
        if (extracted.cleanText.length > sentTextLength) {
          await chunk({ content: extracted.cleanText.slice(sentTextLength) });
          sentTextLength = extracted.cleanText.length;
        }
        for (let i = 0; i < extracted.toolCalls.length; i++) {
          if (aborted || res?.destroyed || res?.writableEnded) break;
          const tc = extracted.toolCalls[i];
          await chunk({
            tool_calls: [{
              index: i,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            }],
          });
        }
        finishedToolEmitted = true;
        stop = 'tool_use';
        return;
      }
    }
    if (accumulatedText.length > sentTextLength) {
      await chunk({ content: accumulatedText.slice(sentTextLength) });
      sentTextLength = accumulatedText.length;
    }
  };

  try {
    for await (const ev of run.events()) {
      if (aborted || res?.destroyed || res?.writableEnded) {
        break;
      }
      if (ev.type === 'ping') {
        const ok = await safeWrite(res, ': keep-alive\n\n');
        if (!ok) { aborted = true; break; }
        continue;
      }
      const d = ev.delta || {}, cb = ev.content_block || {};
      if (ev.type === 'message_start') {
        const ok = await chunk({ role: 'assistant', content: '' });
        if (!ok) { aborted = true; break; }
      }
      if (ev.type === 'content_block_start' && cb.type === 'tool_use') {
        if (accumulatedText.length > sentTextLength) {
          const ok = await chunk({ content: accumulatedText.slice(sentTextLength) });
          if (!ok) { aborted = true; break; }
          sentTextLength = accumulatedText.length;
        }
        slot.set(ev.index, { index: slot.size, id: cb.id, name: cb.name });
      }
      if (ev.type === 'content_block_delta') {
        if (d.type === 'text_delta') {
          accumulatedText += (d.text || '');
          if (slot.size === 0) {
            if (pseudoToolMode) {
              // 处于伪工具拦截状态，静默缓冲，不向客户端发 content
            } else {
              const toolIdx = findToolCallTrigger(accumulatedText);
              if (toolIdx !== -1) {
                pseudoToolMode = true;
                if (toolIdx > sentTextLength) {
                  const ok = await chunk({ content: accumulatedText.slice(sentTextLength, toolIdx) });
                  if (!ok) { aborted = true; break; }
                  sentTextLength = toolIdx;
                }
              } else {
                const safeLen = Math.max(0, accumulatedText.length - SAFE_WINDOW);
                if (safeLen > sentTextLength) {
                  const ok = await chunk({ content: accumulatedText.slice(sentTextLength, safeLen) });
                  if (!ok) { aborted = true; break; }
                  sentTextLength = safeLen;
                }
              }
            }
          } else {
            const ok = await chunk({ content: d.text });
            if (!ok) { aborted = true; break; }
          }
        } else if (d.type === 'input_json_delta') {
          // One complete call per chunk: a reader never sees a name without its arguments.
          const s = slot.get(ev.index);
          if (s) {
            const { index, id, name } = s;
            const ok = await chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: d.partial_json } }] });
            if (!ok) { aborted = true; break; }
          }
        } else if (d.thinking || d.summary?.summary) {
          const ok = await chunk({ reasoning_content: d.thinking || d.summary.summary });
          if (!ok) { aborted = true; break; }
        }
      }
      if (ev.type === 'message_delta') {
        await flushFallbackToolsIfNeeded();
        if (d.stop_reason) stop = d.stop_reason;
      }
    }
    if (!aborted && !res?.destroyed && !res?.writableEnded) {
      await flushFallbackToolsIfNeeded();
      await chunk({}, (slot.size || finishedToolEmitted) ? 'tool_calls' : mapStopReason(stop));
      if (includeUsage) await send([], chatUsage(ctx));
      if (!res.destroyed && !res.writableEnded) {
        res.end('data: [DONE]\n\n');
      }
    }
  } finally {
    res?.removeListener?.('close', onClientDisconnect);
    res?.removeListener?.('error', onClientDisconnect);
    stopHeartbeat?.();
    if (aborted) {
      try { run?.stream?.destroy?.(); } catch {}
      try { run?.release?.(false, 'client aborted'); } catch {}
    }
  }
}

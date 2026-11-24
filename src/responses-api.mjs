/**
 * responses-api.mjs —— OpenAI Responses API 协议适配引擎
 *
 * 负责 OpenAI Responses API（POST /v1/responses）输入转换、工具归一化、
 * 响应对象组装、状态保持以及流式与非流式协议帧下发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractPseudoToolCalls, findToolCallTrigger } from './pseudo-tools.mjs';
import { imagesOfContent } from './image-uploader.mjs';
import { safeWrite } from './chat-protocol.mjs';
import { DATA } from './paths.mjs';

export { safeWrite };

const RESPONSES_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时未访问自动淘汰

/**
 * 获取响应暂存最大容量（默认 50，支持环境变量 RESPONSES_STORE_MAX 弹性扩展）
 */
export function getMaxStoreSize() {
  return Number(process.env.RESPONSES_STORE_MAX) || 50;
}

/**
 * resp_id -> { owner, response, messages, savedAt }，内存保留最近 N 条（供 previous_response_id / GET）
 */
export const RESP_STORE = new Map();

function getRespCacheFile() {
  return path.join(DATA, 'usage', '.responses_cache.json');
}

/**
 * 保存暂存响应至磁盘（持久化）
 */
export function saveResponsesCache(filePath = null) {
  try {
    const file = filePath || getRespCacheFile();
    const now = Date.now();
    const items = [];
    for (const [id, val] of RESP_STORE.entries()) {
      if (!val || (val.savedAt && now - val.savedAt > RESPONSES_TTL_MS)) continue;
      items.push({ id, ...val });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(items), { mode: 0o600, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 从磁盘恢复暂存响应
 */
export function loadResponsesCache(filePath = null) {
  try {
    const file = filePath || getRespCacheFile();
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, 'utf8');
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return 0;
    const now = Date.now();
    let loaded = 0;
    for (const item of items) {
      if (!item || !item.id) continue;
      if (item.savedAt && now - item.savedAt > RESPONSES_TTL_MS) continue;
      const { id, ...val } = item;
      RESP_STORE.set(id, val);
      loaded++;
    }
    return loaded;
  } catch {
    return 0;
  }
}

// 模块加载时尝试恢复未过期的会话上下文
try { loadResponsesCache(); } catch {}

/**
 * 生成新响应 ID
 * @returns {string}
 */
export function newRespId() {
  return `resp_${randomUUID().replace(/-/g, '')}`;
}

/**
 * 生成响应条目 ID
 * @param {string} [prefix='item']
 * @returns {string}
 */
export function newItemId(prefix = 'item') {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * 记录响应并维护最多 RESPONSES_STORE_MAX 条 FIFO 缓存
 * @param {string} owner
 * @param {string} id
 * @param {object} response
 * @param {Array} messages
 */
export function rememberResponse(owner, id, response, messages) {
  if (!response || response.store === false) return;
  RESP_STORE.set(id, { owner, response, messages, savedAt: Date.now() });
  const maxLimit = getMaxStoreSize();
  while (RESP_STORE.size > maxLimit) {
    RESP_STORE.delete(RESP_STORE.keys().next().value);
  }
}

/**
 * 获取已暂存的响应
 * @param {string} id
 * @returns {{owner: string, response: object, messages: Array, savedAt?: number}|undefined}
 */
export function getResponse(id) {
  const item = RESP_STORE.get(id);
  if (!item) return undefined;
  if (item.savedAt && Date.now() - item.savedAt > RESPONSES_TTL_MS) {
    RESP_STORE.delete(id);
    return undefined;
  }
  return item;
}

/**
 * 清空暂存响应（测试或维护用）
 */
export function clearResponses() {
  RESP_STORE.clear();
  try {
    const file = getRespCacheFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

/**
 * 工具定义归一化：把各种协议形状统一成内部 function 形状。
 * 覆盖：
 *   - chat completions: {type:'function', function:{name, description, parameters}}
 *   - responses function: {type:'function', name, description, parameters}
 *   - responses custom:   {type:'custom', name, description, format/schema}
 *   - hosted:             {type:'local_shell'|'web_search'|...}
 *   - anthropic:          {name, description, input_schema}
 * @param {object} t
 * @returns {object|null}
 */
export function normalizeTool(t) {
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

/**
 * Responses 的 input（字符串或条目数组）-> chat messages
 * @param {string|Array} input
 * @returns {Array<object>}
 */
export function responsesInputToMessages(input) {
  if (input == null) return [];
  if (typeof input === 'string') return input.trim() ? [{ role: 'user', content: input }] : [];
  if (!Array.isArray(input)) return [{ role: 'user', content: JSON.stringify(input) }];

  const messages = [];
  const callNames = new Map(); // call_id -> 函数名（function_call_output 显示用）
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type || (item.role ? 'message' : '');
    if (type === 'message') {
      const role = item.role || 'user';
      const c = item.content;
      let text = '';
      const images = [];
      if (typeof c === 'string') {
        text = c;
      } else if (Array.isArray(c)) {
        const texts = [];
        for (const p of c) {
          if (typeof p === 'string') {
            texts.push(p);
            continue;
          }
          if (!p) continue;
          if (typeof p.text === 'string') texts.push(p.text); // input_text / output_text
          else if (typeof p.refusal === 'string') texts.push(p.refusal);
          else if (typeof p.type === 'string' && p.type.includes('image')) {
            images.push(...imagesOfContent([p])); // input_image / image_url
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
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: item.call_id || newItemId('call'),
          type: 'function',
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

/**
 * Responses 请求体 -> chat 形状（messages/tools/system），供 runCompletion 消费
 * @param {object} rb
 * @param {string} [owner]
 * @returns {{messages: Array, system?: string, tools?: Array, reasoning_effort?: string}}
 */
export function responsesToChat(rb = {}, owner = null) {
  const systems = [];
  if (typeof rb.instructions === 'string' && rb.instructions.trim()) {
    systems.push(rb.instructions);
  }

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
    const prev = getResponse(rb.previous_response_id);
    if (!prev || prev.owner !== owner) {
      throw Object.assign(new Error('previous_response_id not found'), { status: 404 });
    }
    messages.push(...prev.messages);
  }
  messages.push(...responsesInputToMessages(rb.input));

  const chat = { messages };
  if (systems.length) chat.system = systems.join('\n\n');

  // 思考档位：Responses 的 reasoning:{effort}（或 reasoning_effort）传下去
  const rEffort = (rb.reasoning && typeof rb.reasoning === 'object' && rb.reasoning.effort != null)
    ? rb.reasoning.effort : rb.reasoning_effort;
  if (rEffort != null) chat.reasoning_effort = String(rEffort);

  if (rb.tool_choice === 'none') return chat; // 显式要求不给工具
  const rawTools = Array.isArray(rb.tools) ? rb.tools : [];
  if (rawTools.length && process.env.TOOL_PASSTHROUGH !== 'off') {
    const mapped = rawTools.map(normalizeTool).filter(Boolean);
    if (mapped.length) chat.tools = mapped;
    const dropped = rawTools.length - mapped.length;
    if (dropped > 0) console.warn(`[responses] 跳过 ${dropped} 个无法识别的工具定义（缺 name / type）`);
    console.log('[responses] tools:', rawTools.map((t) =>
      `${t?.type || '?'}:${normalizeTool(t)?.name || 'dropped'}`).join(', '));
  } else if (rawTools.length) {
    console.warn(`[responses] TOOL_PASSTHROUGH=off，忽略全部 ${rawTools.length} 个工具定义`);
  }
  return chat;
}

/**
 * 计算 Responses API 格式的 usage
 * @param {object} ctx
 * @returns {object}
 */
export function responsesUsage(ctx) {
  const inTokens = ctx?.input_tokens ?? 0;
  const outTokens = ctx?.output_tokens ?? 0;
  const thinkTokens = ctx?.think_tokens ?? 0;
  return {
    input_tokens: inTokens,
    output_tokens: outTokens,
    total_tokens: inTokens + outTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: thinkTokens },
  };
}

/**
 * 映射停止原因为响应状态
 * @param {string} stop
 * @returns {'incomplete'|'completed'}
 */
export function responseStatus(stop) {
  return stop === 'max_tokens' ? 'incomplete' : 'completed';
}

/**
 * 构建 responses 顶层响应对象骨架
 */
export function respShell(rb = {}, model = '', id = '', created = Math.floor(Date.now() / 1000), status = 'completed', output = [], usage = null) {
  return {
    id,
    object: 'response',
    created_at: created,
    status,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: typeof rb.instructions === 'string' ? rb.instructions : null,
    max_output_tokens: rb.max_output_tokens ?? null,
    model,
    output: output || [],
    parallel_tool_calls: rb.parallel_tool_calls !== false,
    previous_response_id: rb.previous_response_id || null,
    reasoning: null,
    store: rb.store !== false,
    temperature: rb.temperature ?? null,
    text: {
      format: (rb.text && rb.text.format) || { type: 'text' },
      verbosity: (rb.text && rb.text.verbosity) || 'medium',
    },
    tool_choice: rb.tool_choice || 'auto',
    tools: Array.isArray(rb.tools) ? rb.tools : [],
    top_p: rb.top_p ?? null,
    truncation: rb.truncation || 'auto',
    usage: usage || null,
    metadata: rb.metadata || {},
  };
}

/**
 * 辅助写入 JSON 响应
 */
function writeJson(res, code, obj, headers) {
  const b = Buffer.from(JSON.stringify(obj));
  const finalHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': b.length,
    ...(headers || {}),
  };
  if (typeof res?.writeHead === 'function') {
    res.writeHead(code, finalHeaders);
  } else if (typeof res?.setHeader === 'function') {
    res.statusCode = code;
    for (const [k, v] of Object.entries(finalHeaders)) {
      res.setHeader(k, v);
    }
  }
  res?.end?.(b);
}

/**
 * JSON、SSE 和存储结果共享按块组装的同一个 response。
 * 流式按官方标准事件序列下发，非流式直接输出完整 JSON 结构并暂存。
 *
 * @param {object} res HTTP 响应对象
 * @param {object} run 执行运行器
 * @param {string} model 模型名
 * @param {string} id 响应 ID
 * @param {object} rb 原始 Responses 请求体
 * @param {Array} baseMessages 基础消息历史
 * @param {string} owner 所属用户/Key
 */
export async function sendResponsesResult(res, run, model, id, rb = {}, baseMessages = [], owner = null) {
  const created = Math.floor(Date.now() / 1000);
  let seq = 0;
  const shell = (status, output, usage) => respShell(rb, model, id, created, status, output, usage);

  let aborted = false;
  const onClientDisconnect = () => {
    aborted = true;
    try { run?.stream?.destroy?.(); } catch {}
    try { run?.release?.(false, 'client disconnected'); } catch {}
  };
  if (rb.stream === true) {
    res?.once?.('close', onClientDisconnect);
    res?.once?.('error', onClientDisconnect);
  }

  const send = rb.stream === true ? async (type, payload) => {
    if (aborted || res?.destroyed || res?.writableEnded) return false;
    res?._markSseActivity?.();
    const ok = await safeWrite(res, `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
    if (!ok) aborted = true;
    return ok;
  } : undefined;

  await send?.('response.created', { response: shell('in_progress') });
  await send?.('response.in_progress', { response: shell('in_progress') });

  const items = [];
  const slot = new Map();   // 上游 content_block index -> {item, index}
  const rsSlot = new Map(); // 上游思考块索引 -> 对应输出条目
  let msgRef = null;
  let text = '';
  let stop = null;
  let lastItem = null;
  let sentTextLength = 0;
  let pseudoToolMode = false;
  let finishedToolEmitted = false;
  const SAFE_WINDOW = 25;

  const ensureMsgRef = async () => {
    if (!msgRef) {
      const item = { type: 'message', id: newItemId('msg'), status: 'in_progress', role: 'assistant', content: [] };
      const index = items.length;
      items.push(item);
      msgRef = { item, index };
      lastItem = item;
      await send?.('response.output_item.added', { output_index: index, item: { ...item, content: [] } });
      await send?.('response.content_part.added', {
        item_id: item.id, output_index: index, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
  };

  const flushFallbackToolsIfNeeded = async () => {
    if (aborted || slot.size > 0 || finishedToolEmitted) return;
    if (pseudoToolMode || findToolCallTrigger(text) !== -1) {
      const extracted = extractPseudoToolCalls(text);
      if (extracted.toolCalls.length > 0) {
        console.log(`[tool_fallback] (Responses API) 拦截到模型正文输出伪工具/XML指令，已自动转换为 ${extracted.toolCalls.length} 个原生 function_call`);
        // 1. 如果有未发送的前置干净文本，补发
        if (extracted.cleanText.length > sentTextLength) {
          await ensureMsgRef();
          await send?.('response.output_text.delta', {
            item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0,
            delta: extracted.cleanText.slice(sentTextLength), logprobs: [],
          });
          sentTextLength = extracted.cleanText.length;
        }
        // 2. 如果存在 msgRef，完成该 message item
        if (msgRef) {
          const part = { type: 'output_text', text: extracted.cleanText, annotations: [] };
          msgRef.item.content = [part];
          msgRef.item.status = 'completed';
          const ref = { item_id: msgRef.item.id, output_index: msgRef.index };
          await send?.('response.output_text.done', { ...ref, content_index: 0, text: extracted.cleanText, logprobs: [] });
          await send?.('response.content_part.done', { ...ref, content_index: 0, part });
          await send?.('response.output_item.done', { output_index: msgRef.index, item: msgRef.item });
        }
        // 3. 逐个下发转换后的 function_call
        for (let i = 0; i < extracted.toolCalls.length; i++) {
          if (aborted || res?.destroyed || res?.writableEnded) break;
          const tc = extracted.toolCalls[i];
          const item = {
            type: 'function_call',
            id: newItemId('fc'),
            call_id: tc.id || newItemId('call'),
            name: tc.function.name,
            arguments: tc.function.arguments || '{}',
            status: 'completed',
          };
          const index = items.length;
          items.push(item);
          slot.set(`fallback_${i}`, { item, index });
          lastItem = item;
          await send?.('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', arguments: '' } });
          await send?.('response.function_call_arguments.delta', {
            item_id: item.id, output_index: index,
            delta: item.arguments,
          });
          await send?.('response.function_call_arguments.done', {
            item_id: item.id, output_index: index,
            arguments: item.arguments,
          });
          await send?.('response.output_item.done', { output_index: index, item });
        }
        finishedToolEmitted = true;
        stop = 'tool_use';
        text = extracted.cleanText;
        return;
      }
    }
    // 未发现伪工具，将缓冲区剩余文本补发
    if (text.length > sentTextLength) {
      await ensureMsgRef();
      await send?.('response.output_text.delta', {
        item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0,
        delta: text.slice(sentTextLength), logprobs: [],
      });
      sentTextLength = text.length;
    }
  };

  try {
    for await (const ev of run.events()) {
      if (aborted || (rb.stream && (res?.destroyed || res?.writableEnded))) {
        break;
      }
      switch (ev.type) {
        case 'ping': {
          if (rb.stream === true && !res?.destroyed && !res?.writableEnded) {
            res?._markSseActivity?.();
            await safeWrite(res, ': keep-alive\n\nevent: ping\ndata: {"type":"ping"}\n\n');
          }
          break;
        }
        case 'content_block_start': {
          const cb = ev.content_block || {};
          if (cb.type === 'thinking') {
            const item = { type: 'reasoning', id: newItemId('rs'), summary: [], status: 'in_progress' };
            const index = items.length;
            items.push(item);
            rsSlot.set(ev.index, { item, index });
            lastItem = item;
            await send?.('response.output_item.added', { output_index: index, item: { ...item } });
            item.summary = [{ type: 'summary_text', text: '' }];
            await send?.('response.reasoning_summary_part.added', {
              item_id: item.id, output_index: index, summary_index: 0, part: item.summary[0],
            });
          } else if (cb.type === 'tool_use') {
            if (text.length > sentTextLength) {
              await ensureMsgRef();
              await send?.('response.output_text.delta', {
                item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0,
                delta: text.slice(sentTextLength), logprobs: [],
              });
              sentTextLength = text.length;
            }
            const item = {
              type: 'function_call', id: newItemId('fc'),
              call_id: cb.id || newItemId('call'), name: cb.name || 'unknown',
              arguments: '', status: 'in_progress',
            };
            const index = items.length;
            items.push(item);
            slot.set(ev.index, { item, index });
            lastItem = item;
            await send?.('response.output_item.added', { output_index: index, item: { ...item } });
          }
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta || {};
          if (d.type === 'text_delta' && d.text) {
            text += d.text;
            if (slot.size === 0) {
              if (pseudoToolMode) {
                // 处于伪工具拦截状态，静默缓冲，不向客户端发 content
              } else {
                const toolIdx = findToolCallTrigger(text);
                if (toolIdx !== -1) {
                  pseudoToolMode = true;
                  if (toolIdx > sentTextLength) {
                    await ensureMsgRef();
                    await send?.('response.output_text.delta', {
                      item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0,
                      delta: text.slice(sentTextLength, toolIdx), logprobs: [],
                    });
                    sentTextLength = toolIdx;
                  }
                } else {
                  const safeLen = Math.max(0, text.length - SAFE_WINDOW);
                  if (safeLen > sentTextLength) {
                    await ensureMsgRef();
                    await send?.('response.output_text.delta', {
                      item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0,
                      delta: text.slice(sentTextLength, safeLen), logprobs: [],
                    });
                    sentTextLength = safeLen;
                  }
                }
              }
            } else {
              await ensureMsgRef();
              await send?.('response.output_text.delta', {
                item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0,
                delta: d.text, logprobs: [],
              });
              sentTextLength = text.length;
            }
          } else if (d.type === 'thinking_summary_delta' || d.type === 'thinking_delta') {
            const s = d.type === 'thinking_delta' ? (d.thinking || '') : (d.summary?.summary || '');
            const rs = rsSlot.get(ev.index);
            if (!rs || !s) break;
            const summary = rs.item.summary[0];
            const delta = summary.text && d.type === 'thinking_summary_delta' ? '\n' + s : s;
            summary.text += delta;
            lastItem = rs.item;
            await send?.('response.reasoning_summary_text.delta', {
              item_id: rs.item.id, output_index: rs.index, summary_index: 0,
              delta,
            });
          } else if (d.type === 'input_json_delta') {
            const s = slot.get(ev.index);
            if (!s) break;
            lastItem = s.item;
            s.item.arguments += d.partial_json || '';
            await send?.('response.function_call_arguments.delta', {
              item_id: s.item.id, output_index: s.index,
              delta: d.partial_json || '',
            });
          }
          break;
        }
        case 'message_delta':
          await flushFallbackToolsIfNeeded();
          if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
          break;
        case 'error':
          throw new Error(ev.error?.message || 'upstream error');
        default: break;
      }
    }
    await flushFallbackToolsIfNeeded();
  } catch (e) {
    if (res?.destroyed || e.name === 'AbortError' || !send) throw e;
    run?.release?.(false, e.message);
    const response = shell('failed', items, null);
    response.error = { code: 'upstream_error', message: e.message };
    await send('response.failed', { response });
    if (!res.destroyed && !res.writableEnded) res?.end?.();
    return response;
  } finally {
    if (rb.stream === true) {
      res?.removeListener?.('close', onClientDisconnect);
      res?.removeListener?.('error', onClientDisconnect);
      if (aborted) {
        try { run?.stream?.destroy?.(); } catch {}
        try { run?.release?.(false, 'client aborted'); } catch {}
      }
    }
  }

  if (aborted) {
    return shell('failed', items, null);
  }

  const status = responseStatus(stop);
  for (const [index, item] of items.entries()) {
    if (aborted) break;
    if (finishedToolEmitted && item.status === 'completed') {
      continue;
    }
    item.status = item === lastItem ? status : 'completed';
    const ref = { item_id: item.id, output_index: index };
    if (item.type === 'reasoning') {
      const part = item.summary[0];
      if (!part.text) item.summary = [];
      await send?.('response.reasoning_summary_text.done', { ...ref, summary_index: 0, text: part.text });
      await send?.('response.reasoning_summary_part.done', { ...ref, summary_index: 0, part,
        ...(item.status === 'incomplete' ? { status: 'incomplete' } : {}) });
    } else if (item.type === 'message') {
      const part = { type: 'output_text', text, annotations: [] };
      item.content = [part];
      await send?.('response.output_text.done', { ...ref, content_index: 0, text, logprobs: [] });
      await send?.('response.content_part.done', { ...ref, content_index: 0, part });
    } else if (item.type === 'function_call') {
      await send?.('response.function_call_arguments.done', { ...ref, arguments: item.arguments });
    }
    await send?.('response.output_item.done', { output_index: index, item });
  }

  // 存档以支持 previous_response_id 续聊
  const asst = { role: 'assistant', content: text };
  const tcs = [...slot.values()].map(s => ({
    id: s.item.call_id,
    type: 'function',
    function: { name: s.item.name, arguments: s.item.arguments },
  }));
  if (tcs.length) asst.tool_calls = tcs;
  const response = shell(status, items, responsesUsage(run?.ctx));
  rememberResponse(owner, id, response, [...baseMessages, asst]);
  if (!send) {
    writeJson(res, 200, response);
    return response;
  }
  if (!aborted && !res.destroyed && !res.writableEnded) {
    await send(`response.${status}`, { response });
    res?.end?.();
  }
  return response;
}

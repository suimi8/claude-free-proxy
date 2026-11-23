// Parse complete SSE records across arbitrary byte boundaries. Never turn untrusted text,
// a partially received JSON object, or EOF in the middle of a turn into an executable call.
const MAX_FRAME = 8 * 1024 * 1024,
  MAX_ARGS = 16 * 1024 * 1024;
const IDLE = Symbol('idle');
const bad = (reason) =>
  Object.assign(new Error(`Invalid upstream stream: ${reason}`), { kind: 'upstream_stream', status: 502 });
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const DELTA_FIELDS = [
  'partial_json', 'input', 'signature', 'text', 'thinking', 'summary',
  'message', 'display_content', 'tool_use_id', 'arguments', 'args', 'input_json', 'json', 'delta',
];
const TOOL_ARGUMENT_FIELDS = ['partial_json', 'arguments', 'args', 'input_json', 'json', 'delta'];
const TOOL_DELTA_METADATA = new Set([
  'id', 'name', 'index', 'tool_use_id', 'tool_call_id', 'call_id', 'content_block_id',
  'tool_name', 'function_name', 'sequence', 'offset',
]);
const TOOL_UPDATE_DELTA = Symbol('tool_update_delta');
const TOOL_UPDATE_FIELDS = new Set(['type', 'message', 'display_content', 'tool_use_id']);
const UNSUPPORTED_TOOL_TEXT = '上游请求了本次请求未声明的工具；未执行该调用。';
function valueShape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (!object(value)) return typeof value;
  if (depth >= 2) return 'object';
  const keys = Object.keys(value);
  const nested = keys.slice(0, 4).map((key) => `${safeFieldName(key)}:${valueShape(value[key], depth + 1)}`);
  if (keys.length > nested.length) nested.push(`+${keys.length - nested.length}`);
  return `object${nested.length ? `{${nested.join(',')}}` : ''}`;
}
function safeFieldName(key) {
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/.test(key) ? key : '<key>';
}
function safeTypeToken(type) {
  return typeof type === 'string' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,47}$/.test(type) ? type : 'other-string';
}
function invalidToolDelta(d) {
  const type = typeof d?.type === 'string' ? safeTypeToken(d.type) : typeof d?.type;
  const fields = object(d) ? DELTA_FIELDS.filter((key) => Object.hasOwn(d, key)) : [];
  const entries = object(d) ? Object.entries(d).filter(([key]) => key !== 'type') : [];
  const extras = entries.filter(([key]) => !DELTA_FIELDS.includes(key));
  const extraFields = extras.length;
  const shape = entries.slice(0, 8).map(([key, value]) => `${safeFieldName(key)}:${valueShape(value)}`);
  if (entries.length > shape.length) shape.push(`+${entries.length - shape.length}`);
  const partialJson = object(d) && Object.hasOwn(d, 'partial_json') ? typeof d.partial_json : 'missing';
  return bad(`invalid tool delta (type=${type}, partial_json=${partialJson}, fields=${fields.join(',') || 'none'}, extra_fields=${extraFields}, shape=${shape.join(',') || 'none'})`);
}
function matchesToolId(value, block, sourceId) {
  return typeof value === 'string' && value.trim() && (value === block.id || !sourceId || value === sourceId);
}
function toolUseBlockUpdate(d, blockIndex, block, sourceId) {
  if (!object(d) || d.type !== 'tool_use_block_update_delta') return null;
  if (
    typeof d.message !== 'string' ||
    !Object.hasOwn(d, 'display_content') ||
    !(d.display_content === null || typeof d.display_content === 'string' || object(d.display_content) || Array.isArray(d.display_content)) ||
    !matchesToolId(d.tool_use_id, block, sourceId) ||
    Object.keys(d).some((key) => !TOOL_UPDATE_FIELDS.has(key))
  ) return null;
  return TOOL_UPDATE_DELTA;
}
function toolArgumentFragment(d, blockIndex, block, sourceId) {
  if (!object(d)) return null;
  const update = toolUseBlockUpdate(d, blockIndex, block, sourceId);
  if (update) return update;
  if (d.type === 'input_json_delta') return typeof d.partial_json === 'string' ? d.partial_json : null;
  if (typeof d.type !== 'string' || !/^(?:tool|function|input|argument|json)(?:$|[_:.:-])/i.test(d.type)) return null;

  const candidates = TOOL_ARGUMENT_FIELDS.filter((key) => typeof d[key] === 'string');
  if (candidates.length !== 1) return null;
  const allowed = new Set(['type', ...TOOL_ARGUMENT_FIELDS, ...TOOL_DELTA_METADATA]);
  if (Object.keys(d).some((key) => !allowed.has(key))) return null;

  for (const key of ['name', 'tool_name', 'function_name']) {
    if (d[key] === undefined) continue;
    if (typeof d[key] !== 'string' || resolveToolName(d[key], new Map([[block.name, null]])) !== block.name)
      return null;
  }
  for (const key of ['id', 'tool_use_id', 'tool_call_id', 'call_id', 'content_block_id']) {
    if (d[key] !== undefined && !matchesToolId(d[key], block, sourceId)) return null;
  }
  if (d.index !== undefined && d.index !== blockIndex) return null;
  for (const key of ['sequence', 'offset']) {
    if (d[key] !== undefined && (!Number.isSafeInteger(d[key]) || d[key] < 0)) return null;
  }
  return d[candidates[0]];
}
function invalidMessageStopReason(ev, state) {
  const reason = ev?.delta?.stop_reason;
  const token = typeof reason === 'string' ? safeTypeToken(reason) : typeof reason;
  return bad(`invalid message stop reason (stop_reason=${token}, started=${state.started}, open_blocks=${state.openBlocks}, reason_seen=${state.reasonSeen})`);
}
function resolveToolName(name, declared) {
  if (typeof name === 'string' && declared.has(name)) return name;
  if (name == null || (typeof name === 'string' && !name.trim()))
    return declared.size === 1 ? declared.keys().next().value : null;
  if (typeof name !== 'string') return null;
  let candidate = name.trim();
  for (const prefix of ['functions.', 'function.']) {
    if (candidate.toLowerCase().startsWith(prefix)) {
      candidate = candidate.slice(prefix.length);
      break;
    }
  }
  const normalized = candidate.toLowerCase();
  const matches = [...declared.keys()].filter((toolName) => toolName.toLowerCase() === normalized);
  return matches.length === 1 ? matches[0] : null;
}
function uniqueToolId(id, index, used) {
  if (typeof id === 'string' && id.trim() && !used.has(id)) return id;
  let generated = `toolu_compat_${index}`;
  while (used.has(generated)) generated += '_';
  return generated;
}
function duration(value, fallback, min) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= 1800000 ? n : fallback;
}

// Keep the longer deadline through a gap between thinking and the first nonempty text.
// Once a tool starts, its buffered arguments must still complete on the normal deadline.
// Compare only stable envelope fields. Usage and other counters can change on a repeated header.
function startIdentity(message) {
  if (message !== undefined && !object(message)) throw bad('invalid message start');
  if (message?.content !== undefined && (!Array.isArray(message.content) || message.content.length))
    throw bad('unexpected initial message content');
  const identity = {};
  for (const key of ['id', 'uuid', 'role', 'model', 'type']) {
    const value = message?.[key];
    if (value == null || value === '') continue;
    if (typeof value !== 'string' || !value.trim()) throw bad('invalid message start identity');
    identity[key] = value;
  }
  return identity;
}

function mergeStartIdentity(first, next, inPrelude) {
  const clash = Object.keys(next).some(key => first[key] && next[key] !== first[key]);
  const shared = ['id', 'uuid'].some(key => first[key] && first[key] === next[key]);
  const placeholder = !(first.id || first.uuid) || !(next.id || next.uuid);
  if (clash || (!shared && !(inPrelude && placeholder))) {
    throw Object.assign(bad('conflicting message start'), { code: 'UPSTREAM_MESSAGE_CONFLICT' });
  }
  return { ...first, ...next };
}

function progressPhase(ev, current, toolPending) {
  switch (ev.type) {
    case 'message_start': return 'initial';
    case 'message_delta': return ev.delta?.stop_reason ? 'finish' : null;
    case 'message_stop': return 'finish';
    case 'content_block_stop': return current;
    case 'content_block_start': {
      const block = ev.content_block;
      if (toolPending || block?.type === 'tool_use') return 'tool';
      if (block?.type === 'thinking' || block?.type === 'redacted_thinking') return 'thinking';
      if (block?.type === 'text' && !block.text && current === 'thinking') return 'thinking';
      return 'content';
    }
    case 'content_block_delta': {
      const d = ev.delta;
      if (toolPending || d?.type === 'input_json_delta') return 'tool';
      if (d?.type === 'thinking_delta') return d.thinking ? 'thinking' : null;
      if (d?.type === 'thinking_summary_delta') return d.summary?.summary ? 'thinking' : null;
      if (d?.type === 'text_delta') return d.text ? 'content' : null;
      return current;
    }
    default: return null; // metadata and keepalives do not extend either budget
  }
}

function stalled(clock) {
  const age = clock.lastByteAt === null ? 'none' : Math.max(0, Date.now() - clock.lastByteAt);
  const err = bad(`upstream stopped making progress (phase=${clock.phase}, timeout_ms=${clock.timeoutMs}, last_byte_age_ms=${age})`);
  err.code = 'UPSTREAM_STALLED';
  return err;
}

async function readBy(reader, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return IDLE;
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, remaining, IDLE);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function* frames(stream, clock) {
  const reader = stream.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let pieces = [],
    lines = [],
    size = 0,
    skipLF = false;
  try {
    for (;;) {
      // A partially arrived frame is never an idle boundary. Give it the normal stall
      // timeout; if it still doesn't finish, report an error rather than dropping it.
      const grace = !size && clock.graceAt !== null && clock.graceAt <= clock.stallAt;
      let r;
      try {
        r = await readBy(reader, grace ? clock.graceAt : clock.stallAt);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        const interrupted = bad('transport interrupted');
        interrupted.code = 'UPSTREAM_TRANSPORT_INTERRUPTED';
        throw interrupted;
      }
      if (r === IDLE) {
        if (clock.ended) return;
        if (!grace) throw stalled(clock);
        yield IDLE;
        return;
      }
      if (r.done) {
        if (size) throw bad('incomplete SSE frame');
        return;
      }
      const bytes = Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength);
      if (bytes.length) clock.lastByteAt = Date.now();
      let start = 0;
      for (let i = 0; i < bytes.length; i++) {
        const ch = bytes[i];
        if (skipLF) {
          skipLF = false;
          if (ch === 10) {
            start = i + 1;
            continue;
          }
        }
        if (++size > MAX_FRAME) throw bad('SSE frame too large');
        if (ch !== 13 && ch !== 10) continue;
        skipLF = ch === 13;
        if (i > start) pieces.push(bytes.subarray(start, i));
        start = i + 1;
        if (pieces.length) {
          const line = decoder.decode(pieces.length === 1 ? pieces[0] : Buffer.concat(pieces));
          pieces = [];
          if (line === 'data') lines.push('');
          else if (line.startsWith('data:')) lines.push(line.slice(line[5] === ' ' ? 6 : 5));
        } else {
          const data = lines.join('\n');
          lines = [];
          size = 0;
          if (!data || data === '[DONE]') continue;
          let ev;
          try {
            ev = JSON.parse(data);
          } catch {
            throw bad('invalid SSE JSON');
          }
          if (typeof ev?.type !== 'string') throw bad('event has no type');
          yield ev;
        }
      }
      if (bytes.length > start) pieces.push(bytes.subarray(start));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
    } finally {
      reader.releaseLock();
    }
  }
}

function finishArgs(t) {
  const initial = t.start.content_block.input;
  if (!t.parts.length && initial === undefined) throw bad('missing tool arguments');
  if (t.parts.length && initial != null && (!object(initial) || Object.keys(initial).length))
    throw bad('ambiguous tool input');
  const args = t.parts.length ? t.parts.join('') : JSON.stringify(initial);
  let value;
  try {
    value = JSON.parse(args);
  } catch {
    throw bad('incomplete tool arguments');
  }
  if (
    !object(value) ||
    (Array.isArray(t.schema.required) && t.schema.required.some((k) => !Object.hasOwn(value, k)))
  ) {
    throw bad('invalid or missing required tool arguments');
  }
  // Only declared top-level JSON types are checked here; this is not a full JSON Schema validator.
  for (const [k, desc] of Object.entries(t.schema.properties || {})) {
    if (!Object.hasOwn(value, k) || !desc?.type) continue;
    const v = value[k],
      types = Array.isArray(desc.type) ? desc.type : [desc.type];
    const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    if (!types.includes(type) && !(Number.isInteger(v) && types.includes('integer')))
      throw bad('incorrect tool argument type');
  }
  return args;
}

export async function* validatedEvents(stream, tools = [], options = {}) {
  const configuredIdle = options.idleMs ?? process.env.SSE_IDLE_TIMEOUT_MS;
  const idleMs = duration(configuredIdle, 120_000, 1);
  const thinkingIdleMs = duration(options.thinkingIdleMs ?? process.env.SSE_THINKING_IDLE_TIMEOUT_MS ?? configuredIdle, 360_000, 1);
  const graceMs = duration(options.graceMs ?? process.env.TOOL_PING_GRACE_MS, 2000, 0);
  const clock = { phase: 'initial', timeoutMs: idleMs, stallAt: Date.now() + idleMs, graceAt: null, lastByteAt: null };
  const declared = new Map(tools.map((t) => [t.name, t.input_schema || {}]));
  const open = new Map(),
    seen = new Set(),
    toolIds = new Set();
  let held = null,
    heldBytes = 0,
    argBytes = 0,
    executableTools = 0,
    identity = null,
    pendingStart = null,
    lastWasTool = false,
    reason = false;
  // Once a tool starts, hold the rest of the turn until commit. Preserve original START
  // order even when two tools' fragments/stops are interleaved. Text before it stays live.
  function* commit() {
    for (const entry of held || []) {
      if (entry.unsupported) {
        // Never forward an undeclared call as executable; make the compatibility fallback visible.
        yield { type: 'content_block_start', index: entry.index, content_block: { type: 'text', text: '' } };
        yield {
          type: 'content_block_delta',
          index: entry.index,
          delta: { type: 'text_delta', text: UNSUPPORTED_TOOL_TEXT },
        };
        yield { type: 'content_block_stop', index: entry.index };
        continue;
      }
      if (entry.start) {
        const ev = entry.start;
        yield { ...ev, content_block: { ...ev.content_block, input: {} } };
        yield {
          type: 'content_block_delta',
          index: ev.index,
          delta: { type: 'input_json_delta', partial_json: entry.args },
        };
        yield { type: 'content_block_stop', index: ev.index };
      } else yield entry.event;
    }
  }
  function closeImplicitToolBlocks() {
    if (!open.size) return true;
    for (const [index, t] of open) {
      if (!t) return false;
      if (!t.unsupported) {
        t.args = finishArgs(t);
        t.parts = null;
      }
      open.delete(index);
    }
    lastWasTool = true;
    return true;
  }
  try {
    for await (let ev of frames(stream, clock)) {
      if (ev === IDLE) break;
      if (clock.ended) {
        // Optional timing diagnostics: drain metadata only, never accept content after the stop.
        if (Date.now() >= clock.stallAt) return;
        if (ev.type === 'message_limit') yield ev;
        continue;
      }
      if (ev.type === 'ping') {
        if (clock.graceAt === null && Date.now() >= clock.stallAt)
          throw stalled(clock);
        if (graceMs && lastWasTool && !open.size) clock.graceAt ??= Date.now() + graceMs;
        yield ev;
        continue;
      }
      if (ev.type === 'message_start') {
        const next = startIdentity(ev.message);
        if (identity) {
          // Repeated headers are metadata. They must not renew the progress or tool deadlines.
          if (Date.now() >= clock.stallAt) throw stalled(clock);
          identity = mergeStartIdentity(identity, next, !seen.size && !reason);
          if (pendingStart && ev.message) pendingStart = { ...pendingStart,
            message: { ...pendingStart.message, ...ev.message, ...identity } };
          continue;
        }
        identity = next;
        pendingStart = ev;
      } else if (pendingStart) {
        yield pendingStart;
        pendingStart = null;
      }
      const phase = progressPhase(ev, clock.phase, held !== null);
      if (phase !== null) {
        clock.phase = phase;
        clock.timeoutMs = phase === 'thinking' ? thinkingIdleMs : idleMs;
        clock.stallAt = Date.now() + clock.timeoutMs;
      }
      if (ev.type === 'error') {
        const errObj = ev.error || {};
        const errType = errObj.type || ev.error_type || 'upstream_error';
        const errMsg = errObj.message || ev.message || 'upstream reported an error';
        const err = Object.assign(new Error(`upstream reported an error: [${errType}] ${errMsg}`), {
          kind: 'transient',
          code: 'UPSTREAM_ERROR_EVENT',
          status: 502,
          errorType: errType,
          rawError: errObj
        });
        throw err;
      }
      if (ev.type === 'message_start') continue;
      if (ev.type === 'content_block_start') {
        if (
          !identity ||
          reason ||
          !Number.isSafeInteger(ev.index) ||
          ev.index < 0 ||
          seen.has(ev.index) ||
          !object(ev.content_block)
        )
          throw bad('invalid block start');
        if (seen.size >= 4096) throw bad('too many blocks');
        seen.add(ev.index);
        clock.graceAt = null;
        lastWasTool = false;
        const cb = ev.content_block;
        if (cb.type === 'tool_use') {
          argBytes += Buffer.byteLength(JSON.stringify(cb));
          if (argBytes > MAX_ARGS) throw bad('tool arguments too large');
          const name = resolveToolName(cb.name, declared);
          if (!name) {
            const t = { unsupported: true, index: ev.index };
            (held ??= []).push(t);
            open.set(ev.index, t);
            continue;
          }
          const id = uniqueToolId(cb.id, ev.index, toolIds);
          toolIds.add(id);
          const start = { ...ev, content_block: { ...cb, id, name } };
          const sourceId = typeof cb.id === 'string' && cb.id.trim() ? cb.id : null;
          const t = { start, parts: [], schema: declared.get(name), sourceId };
          executableTools++;
          (held ??= []).push(t);
          open.set(ev.index, t);
          continue;
        }
        open.set(ev.index, null);
      } else if (ev.type === 'content_block_delta') {
        if (!open.has(ev.index)) throw bad('delta without an open block');
        const t = open.get(ev.index),
          d = ev.delta;
        if (t) {
          if (t.unsupported) {
            argBytes += Buffer.byteLength(JSON.stringify(ev));
            if (argBytes > MAX_ARGS) throw bad('tool arguments too large');
            continue;
          }
          const partialJson = toolArgumentFragment(d, ev.index, t.start.content_block, t.sourceId);
          if (partialJson === TOOL_UPDATE_DELTA) continue;
          if (partialJson === null) throw invalidToolDelta(d);
          argBytes += Buffer.byteLength(partialJson);
          if (argBytes > MAX_ARGS) throw bad('tool arguments too large');
          if (partialJson) t.parts.push(partialJson);
          continue;
        }
        if (d?.type === 'input_json_delta') throw bad('tool delta outside tool block');
      } else if (ev.type === 'content_block_stop') {
        if (!open.has(ev.index)) throw bad('stop without an open block');
        const t = open.get(ev.index);
        open.delete(ev.index);
        if (t && !t.unsupported) {
          t.args = finishArgs(t);
          t.parts = null;
        }
        lastWasTool = !!t || (!open.size && !!held);
        if (t) continue; // commit emits the complete block in start order
      } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
        if (!identity || reason || typeof ev.delta.stop_reason !== 'string')
          throw invalidMessageStopReason(ev, { started: !!identity, openBlocks: open.size, reasonSeen: reason });
        if (open.size && !closeImplicitToolBlocks())
          throw invalidMessageStopReason(ev, { started: !!identity, openBlocks: open.size, reasonSeen: reason });
        if (!held && ev.delta.stop_reason === 'tool_use') {
          // 上游返回了 tool_use 但实际正文中输出的是文本伪工具/XML或无原生 tool 块，
          // 容错降级为 end_turn，由下游伪工具提取器解析或作为正常文本结束，严禁抛错中断客户端连接
          ev = { ...ev, delta: { ...ev.delta, stop_reason: 'end_turn' } };
        }
        if (executableTools && !['tool_use', 'end_turn', 'pause_turn'].includes(ev.delta.stop_reason))
          throw bad('tool turn ended without completing normally');
        reason = true;
        if (held) {
          const stopReason = executableTools
            ? 'tool_use'
            : ev.delta.stop_reason === 'tool_use' ? 'end_turn' : ev.delta.stop_reason;
          ev = { ...ev, delta: { ...ev.delta, stop_reason: stopReason } };
        }
      } else if (ev.type === 'message_stop') {
        if (!identity || (open.size && !closeImplicitToolBlocks())) throw bad('message stopped before block completion');
        yield* commit();
        if (held && !reason)
          yield { type: 'message_delta', delta: { stop_reason: executableTools ? 'tool_use' : 'end_turn', stop_sequence: null } };
        yield ev;
        if (process.env.SSE_END_ON_STOP !== '0') return;
        clock.ended = true;
        clock.graceAt = null;
        continue;
      }
      if (!held) yield ev;
      else {
        heldBytes += Buffer.byteLength(JSON.stringify(ev));
        if (held.length >= 65536 || heldBytes > MAX_ARGS) throw bad('too much buffered tool-turn data');
        held.push({ event: ev });
      }
    }
    if (clock.ended) return;
    if (!held || open.size || clock.graceAt === null) throw bad('unexpected EOF before message completion');
    yield* commit();
    if (!reason) yield { type: 'message_delta', delta: { stop_reason: executableTools ? 'tool_use' : 'end_turn', stop_sequence: null } };
    yield { type: 'message_stop' };
  } catch (e) {
    if (e.kind || e.code || e.name === 'AbortError') throw e;
    const interrupted = bad('transport interrupted');
    interrupted.code = 'UPSTREAM_TRANSPORT_INTERRUPTED';
    throw interrupted;
  }
}

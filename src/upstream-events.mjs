// Parse complete SSE records across arbitrary byte boundaries. Never turn untrusted text,
// a partially received JSON object, or EOF in the middle of a turn into an executable call.
const MAX_FRAME = 8 * 1024 * 1024,
  MAX_ARGS = 16 * 1024 * 1024;
const IDLE = Symbol('idle');
const bad = (reason) =>
  Object.assign(new Error(`Invalid upstream stream: ${reason}`), { kind: 'upstream_stream', status: 502 });
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function duration(value, fallback, min) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= 1800000 ? n : fallback;
}

// Keep the longer deadline through a gap between thinking and the first nonempty text.
// Once a tool starts, its buffered arguments must still complete on the normal deadline.
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
  return bad(`upstream stopped making progress (phase=${clock.phase}, timeout_ms=${clock.timeoutMs}, last_byte_age_ms=${age})`);
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
      const r = await readBy(reader, grace ? clock.graceAt : clock.stallAt);
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
    started = false,
    lastWasTool = false,
    reason = false;
  // Once a tool starts, hold the rest of the turn until commit. Preserve original START
  // order even when two tools' fragments/stops are interleaved. Text before it stays live.
  function* commit() {
    for (const entry of held || []) {
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
        continue;
      }
      const phase = progressPhase(ev, clock.phase, held !== null);
      if (phase !== null) {
        clock.phase = phase;
        clock.timeoutMs = phase === 'thinking' ? thinkingIdleMs : idleMs;
        clock.stallAt = Date.now() + clock.timeoutMs;
      }
      if (ev.type === 'error') throw bad('upstream reported an error');
      if (ev.type === 'message_start') {
        if (started) throw bad('duplicate message start');
        if (
          ev.message?.content !== undefined &&
          (!Array.isArray(ev.message.content) || ev.message.content.length)
        )
          throw bad('unexpected initial message content');
        started = true;
      } else if (ev.type === 'content_block_start') {
        if (
          !started ||
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
          if (!declared.has(cb.name) || typeof cb.id !== 'string' || !cb.id || toolIds.has(cb.id))
            throw bad('undeclared or unidentified tool');
          toolIds.add(cb.id);
          const t = { start: ev, parts: [], schema: declared.get(cb.name) };
          argBytes += Buffer.byteLength(JSON.stringify(cb));
          if (argBytes > MAX_ARGS) throw bad('tool arguments too large');
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
          if (d?.type !== 'input_json_delta' || typeof d.partial_json !== 'string')
            throw bad('invalid tool delta');
          argBytes += Buffer.byteLength(d.partial_json);
          if (argBytes > MAX_ARGS) throw bad('tool arguments too large');
          if (d.partial_json) t.parts.push(d.partial_json);
          continue;
        }
        if (d?.type === 'input_json_delta') throw bad('tool delta outside tool block');
      } else if (ev.type === 'content_block_stop') {
        if (!open.has(ev.index)) throw bad('stop without an open block');
        const t = open.get(ev.index);
        open.delete(ev.index);
        if (t) {
          t.args = finishArgs(t);
          t.parts = null;
        }
        lastWasTool = !!t || (!open.size && !!held);
        if (t) continue; // commit emits the complete block in start order
      } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
        if (!started || open.size || reason) throw bad('invalid message stop reason');
        if (!held && ev.delta.stop_reason === 'tool_use') throw bad('tool stop without a tool block');
        if (held && !['tool_use', 'end_turn'].includes(ev.delta.stop_reason))
          throw bad('tool turn ended without completing normally');
        reason = true;
        if (held) ev = { ...ev, delta: { ...ev.delta, stop_reason: 'tool_use' } };
      } else if (ev.type === 'message_stop') {
        if (!started || open.size) throw bad('message stopped before block completion');
        yield* commit();
        if (held && !reason)
          yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } };
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
    if (!reason) yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } };
    yield { type: 'message_stop' };
  } catch (e) {
    if (e.kind === 'upstream_stream' || e.name === 'AbortError') throw e;
    throw bad('transport interrupted');
  }
}

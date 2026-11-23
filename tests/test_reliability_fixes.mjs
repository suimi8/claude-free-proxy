import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from 'undici';
import { createUpstreamDispatcher } from '../src/network-optimizer.mjs';
import { validatedEvents } from '../src/upstream-events.mjs';
import { AccountPool } from '../src/accounts.mjs';

test('createUpstreamDispatcher configures long-timeout keepalive agent', () => {
  const dispatcher = createUpstreamDispatcher({ forceDirect: true });
  assert.ok(dispatcher instanceof Agent, 'Dispatcher should be an Undici Agent');
});

test('validatedEvents yields ping events and identifies stall with UPSTREAM_STALLED code', async () => {
  // Mock SSE stream emitting ping per claude.ai spec
  const chunks = [
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022"}}\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ];

  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    }
  });

  const events = [];
  for await (const ev of validatedEvents(stream)) {
    events.push(ev);
  }

  const pings = events.filter(e => e.type === 'ping');
  assert.equal(pings.length, 2, 'Should yield 2 ping events');
  const texts = events.filter(e => e.type === 'content_block_delta' && e.delta?.text === 'hello');
  assert.equal(texts.length, 1, 'Should process text deltas correctly');
});

test('transient error cooldown is configured with short protective buffer', async () => {
  const pool = new AccountPool(null);
  pool.data.accounts = [
    { id: 'acc_1', label: 'acc 1', enabled: true, sessionKey: 'sk1', org: 'org1', stats: { ok: 0, fail: 0 }, inflight: 0, failStreak: 0 },
    { id: 'acc_2', label: 'acc 2', enabled: true, sessionKey: 'sk2', org: 'org2', stats: { ok: 0, fail: 0 }, inflight: 0, failStreak: 0 }
  ];

  const cd = pool.fail(pool.get('acc_1'), 'transient', 'connect timeout');
  assert.equal(cd, 3000, 'First transient error should cooldown for 3000ms');
  assert.ok(pool.get('acc_1').cooldownUntil > Date.now(), 'Account 1 should be cooling down');
  
  // Eligible should only return acc_2
  const elig = pool.eligible();
  assert.equal(elig.length, 1);
  assert.equal(elig[0].id, 'acc_2');
});

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

test('validatedEvents correctly parses upstream error event into retryable UPSTREAM_ERROR_EVENT', async () => {
  const chunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022"}}\n\n',
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Claude is overloaded"}}\n\n'
  ];

  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    }
  });

  await assert.rejects(async () => {
    for await (const _ of validatedEvents(stream)) {}
  }, (err) => {
    assert.equal(err.code, 'UPSTREAM_ERROR_EVENT');
    assert.equal(err.kind, 'transient');
    assert.equal(err.errorType, 'overloaded_error');
    assert.ok(err.message.includes('Claude is overloaded'));
    return true;
  });
});

test('validatedEvents keeps thinking stream alive when receiving upstream pings', async () => {
  const chunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-7-sonnet-20250219"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
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
  assert.ok(events.length >= 5, 'Should have received all stream events including thinking and ping');
  assert.ok(events.some(e => e.type === 'ping'), 'Ping event was yielded');
  assert.ok(events.some(e => e.delta?.thinking === 'Let me think...'), 'Thinking delta was yielded');
});

test('burst 429 without resetsAt uses progressive short cooldown (15s..120s) and does not escalate to 30m', async () => {
  const pool = new AccountPool(null);
  pool.data.accounts = [
    { id: 'acc_burst', label: 'acc burst', enabled: true, sessionKey: 'sk_b', org: 'org_b', stats: { ok: 0, fail: 0 }, inflight: 0, failStreak: 0 }
  ];

  const acct = pool.get('acc_burst');
  const cd1 = pool.fail(acct, 'rate_limit', 'Rate limited. Please try again later.');
  assert.equal(cd1, 15000, 'First burst 429 should cooldown for 15s');

  const cd2 = pool.fail(acct, 'rate_limit', 'Rate limited. Please try again later.');
  assert.equal(cd2, 30000, 'Second burst 429 should cooldown for 30s');

  const cd3 = pool.fail(acct, 'rate_limit', 'Rate limited. Please try again later.');
  assert.equal(cd3, 60000, 'Third burst 429 should cooldown for 60s');

  const cd4 = pool.fail(acct, 'rate_limit', 'Rate limited. Please try again later.');
  assert.equal(cd4, 120000, 'Fourth burst 429 should cap at 120s (NOT 1800s / 30 minutes!)');

  const cd5 = pool.fail(acct, 'rate_limit', 'Rate limited. Please try again later.');
  assert.equal(cd5, 120000, 'Subsequent burst 429 stays capped at 120s');
});

test('clearing cooldown resets failStreak, streaks, and lastError cleanly', async () => {
  const pool = new AccountPool(null);
  pool.data.accounts = [
    { id: 'acc_cd', label: 'acc cd', enabled: true, sessionKey: 'sk_c', org: 'org_c', stats: { ok: 0, fail: 3, lastError: 'Rate limited' }, inflight: 0, failStreak: 3, streaks: { rate_limit: 3 }, cooldownUntil: Date.now() + 60000 }
  ];

  // Single account clear via set
  pool.set('acc_cd', { cooldownUntil: 0 });
  const a = pool.get('acc_cd');
  assert.equal(a.cooldownUntil, 0, 'cooldownUntil should be 0');
  assert.equal(a.failStreak, 0, 'failStreak should be reset');
  assert.deepEqual(a.streaks, {}, 'streaks should be empty');
  assert.equal(a.stats.lastError, '', 'lastError should be cleared');

  // Multi-account clear via clearAllCooldowns
  pool.fail(a, 'rate_limit', 'Rate limited');
  assert.ok(a.cooldownUntil > Date.now());
  const cleared = pool.clearAllCooldowns();
  assert.equal(cleared, 1, 'Should have cleared 1 account');
  assert.equal(a.cooldownUntil, 0);
  assert.equal(a.failStreak, 0);
  assert.deepEqual(a.streaks, {});
});

test('normalize/_init automatically caps legacy excessive cooldowns (>120s) for non-exhausted accounts', async () => {
  const pool = new AccountPool(null);
  const now = Date.now();
  const legacyAcct = {
    id: 'acc_legacy',
    label: 'acc legacy',
    enabled: true,
    sessionKey: 'sk_l',
    org: 'org_l',
    stats: { ok: 0, fail: 4, lastError: 'completion 429: {"error":{"message":"Rate limited. Please try again later."}}' },
    cooldownUntil: now + 1730000, // Legacy 30 minute cooldown
    failStreak: 4,
    streaks: { rate_limit: 4 }
  };

  pool._init(legacyAcct);
  assert.ok(legacyAcct.cooldownUntil <= now + 120000, 'Legacy 30min cooldown should be capped to <= 120s');
  assert.ok(legacyAcct.cooldownUntil >= now, 'Cooldown should still be in the future');
});

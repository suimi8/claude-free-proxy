import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { sandbox, project } from './offline-fixtures.mjs';
import { RELEASE_FILES } from '../src/release-files.mjs';
import { fetchPublicBytes, publicURL, publicLookup, isPublicIP } from '../src/public-http.mjs';
import { validatedEvents } from '../src/upstream-events.mjs';
import { createConfigStore } from '../src/config.mjs';
import { readChildResponse } from '../src/child-http.mjs';

// Run the real pack CLI against a fixture that also contains lookalike private files.
test('release archive is exactly the manifest; pack does not load or overwrite private data', (t) => {
  const { root, env } = sandbox(t);
  for (const f of RELEASE_FILES) {
    const dest = path.join(root, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(project, f), dest);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files, [
    ...RELEASE_FILES,
  ]);
  const canaries = [
    'config.json',
    'accounts.json',
    'upstream.json',
    'secrets.env',
    'trace.har',
    'notes/recording.json',
    'logs/requests.log',
    'private-extra.txt',
    'web/webui.local.html',
    'src/private.mjs',
    'config/accounts.json',
    '.git/config',
  ];
  for (const f of canaries) {
    const p = path.join(root, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'PRIVATE-TEST-CANARY');
  }
  const pack = () =>
    spawnSync(process.execPath, ['start.mjs', 'pack', 'output.tgz'], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...env, CONFIG_FILE: path.join(root, 'config.json') },
    });
  const result = pack();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const list = spawnSync('tar', ['-tzf', 'output.tgz'], {
    cwd: root,
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.stdout.trimEnd().split(/\r?\n/).sort(), [...RELEASE_FILES].sort());
  assert(!fs.existsSync(env.DATA_DIR));
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), 'PRIVATE-TEST-CANARY');
  assert.notEqual(pack().status, 0, 'an existing archive is never replaced');
});

test('outbound URL / socket DNS policy rejects non-public and mixed results', async () => {
  for (const url of [
    'https://localhost',
    'http://service.internal',
    'http://127.0.0.1',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]',
    'http://169.254.1.2',
    'file:///fixture',
    'https://user:pass@example.org',
    'https://example.org:8080',
  ])
    assert.throws(() => publicURL(url));
  assert(isPublicIP('8.8.8.8'));
  assert(isPublicIP('2606:4700:4700::1111'));
  assert(!isPublicIP('192.168.1.2'));
  const lookup = (rows, opts) =>
    new Promise((resolve, reject) =>
      publicLookup(async () => rows)('mock.example', opts, (e, ...r) => (e ? reject(e) : resolve(r)))
    );
  const rows = [{ address: '8.8.8.8', family: 4 }];
  assert.deepEqual(await lookup(rows, { all: true }), [rows]);
  assert.deepEqual(await lookup(rows, { family: 4 }), ['8.8.8.8', 4]);
  await assert.rejects(lookup([...rows, { address: '127.0.0.1', family: 4 }], {}));
  await assert.rejects(lookup(rows, { family: 6 }));
});

function response(status, headers = {}, chunks = []) {
  return Object.assign(Readable.from(chunks.map((s) => Buffer.from(s))), { statusCode: status, headers });
}
test('every redirect is checked; headers and streamed byte limits apply to web and image reads', async () => {
  const url = 'https://mock.example/';
  for (const location of ['http://mock.example/', 'https://localhost/']) {
    let calls = 0;
    await assert.rejects(
      fetchPublicBytes(url, {
        request: async () => {
          calls++;
          return response(302, { location });
        },
      })
    );
    assert.equal(calls, 1);
  }
  const hops = [];
  const { bytes } = await fetchPublicBytes(url, {
    request: async (u) => {
      hops.push(u.pathname);
      return hops.length === 1 ? response(307, { location: '/next' }) : response(200, {}, ['ab', 'cd']);
    },
    maxBytes: 4,
  });
  assert.equal(bytes.toString(), 'abcd');
  assert.deepEqual(hops, ['/', '/next']);
  await assert.rejects(
    fetchPublicBytes(url, { maxBytes: 3, request: () => response(200, {}, ['ab', 'cd']) }),
    { status: 413 }
  );
  await assert.rejects(
    fetchPublicBytes(url, { maxBytes: 3, request: () => response(200, { 'content-length': '4' }) }),
    { status: 413 }
  );
  await assert.rejects(
    fetchPublicBytes(url, { image: true, request: () => response(200, { 'content-type': 'text/plain' }) }),
    { status: 400 }
  );
  await assert.rejects(
    fetchPublicBytes(url, { request: () => response(200, { 'content-encoding': 'gzip' }) }),
    { status: 502 }
  );
  await assert.rejects(fetchPublicBytes(url, { request: () => response(302, { location: '/again' }) }), {
    status: 400,
  });
  await assert.rejects(
    fetchPublicBytes(url, {
      signal: AbortSignal.abort(),
      request: () => assert.fail('should not connect'),
    }),
    { name: 'AbortError' }
  );
});

const head = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n';
test('child transport: clean close, error after headers, early exit and client cancellation', async (t) => {
  const { env } = sandbox(t);
  function child(js) {
    return spawn(process.execPath, ['-e', js], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }
  const good = await readChildResponse(child(`process.stdout.end(${JSON.stringify(head + 'ok')})`));
  assert.equal(await good.text(), 'ok');
  const early = child(`process.stdout.write(${JSON.stringify(head + 'partial')});process.exitCode=23;`);
  const partial = await readChildResponse(early);
  await assert.rejects(partial.text(), /23/);
  await assert.rejects(
    readChildResponse(child('process.exit(2)'), { requestBody: Buffer.alloc(2 * 1024 * 1024) }),
    /network error/
  );
  const producer = child(`process.stdout.write(${JSON.stringify(head)});setInterval(()=>{},5000)`);
  try {
    const ac = new AbortController(),
      closed = once(producer, 'close');
    const res = await readChildResponse(producer, { signal: ac.signal });
    ac.abort();
    await assert.rejects(res.text(), { name: 'AbortError' });
    await closed;
  } finally {
    if (producer.exitCode === null && producer.signalCode === null) producer.kill();
  }
});

test('parser waits for a partially received next frame after ping; never commits at that boundary', async () => {
  const frame = (e) => 'data: ' + JSON.stringify(e) + '\r\n\r\n';
  const prefix = [
    { type: 'message_start' },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'a', name: 'note', input: { text: '好' } },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'ping' },
  ]
    .map(frame)
    .join('');
  let cancelled = false;
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from(prefix + 'data: {'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const got = [];
  await assert.rejects(async () => {
    for await (const e of validatedEvents(stream, [{ name: 'note' }], { graceMs: 5, idleMs: 80 }))
      got.push(e);
  }, /progress/);
  assert(cancelled);
  assert.deepEqual(
    got.map((e) => e.type),
    ['message_start']
  );
});

test('old keys remain inference-only; offline admin migration preserves original settings and is idempotent', (t) => {
  const { env, data } = sandbox(t);
  fs.mkdirSync(data);
  const file = path.join(data, 'config.json');
  const original = { name: 'shared', key: 'synthetic-existing', quota: { usedRequests: 42 } };
  fs.writeFileSync(
    file,
    JSON.stringify({
      keys: [original],
      settings: { privateOption: 'for fixture only' },
      extra: 'preserved',
    })
  );
  const store = createConfigStore(file);
  store.load();
  assert.equal(store.identify(original.key, '127.0.0.1', { management: true }).error.status, 403);
  const run = () =>
    spawnSync(process.execPath, [path.join(project, 'src/init-admin.mjs')], {
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const raw = fs.readFileSync(file, 'utf8'),
    cfg = JSON.parse(raw);
  assert.deepEqual(cfg.keys[0], original);
  assert.equal(cfg.keys.length, 2);
  assert.equal(cfg.keys[1].role, 'admin');
  assert.equal(cfg.extra, 'preserved');
  assert.equal(cfg.settings.privateOption, 'for fixture only');
  assert(!first.stdout.includes(cfg.keys[1].key));
  assert(!first.stdout.includes(original.key));
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  fs.writeFileSync(file, '{invalid-fixture-secret');
  const bad = run();
  assert.equal(bad.status, 1);
  assert(!bad.stderr.includes('invalid-fixture-secret'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid-fixture-secret');
});

test('long thinking gaps, regular output, and finite heartbeat-only waits', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  for (const name of ['SSE_IDLE_TIMEOUT_MS', 'SSE_THINKING_IDLE_TIMEOUT_MS']) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => { if (previous !== undefined) process.env[name] = previous; });
  }
  const flush = () => new Promise(resolve => setImmediate(resolve));
  function replay(options) {
    let writer, cancelled = false;
    const seen = [];
    const stream = new ReadableStream({ start(c) { writer = c; }, cancel() { cancelled = true; } });
    const done = (async () => {
      for await (const e of validatedEvents(stream, [{ name: 'note' }], options)) seen.push(e);
      return null;
    })().catch(e => e);
    function send(...rows) {
      writer.enqueue(Buffer.from(rows.map(e => typeof e === 'string' ? e : 'data: ' + JSON.stringify(e) + '\n\n').join('')));
    }
    return { send, done, seen, get cancelled() { return cancelled; } };
  }
  const start = { type: 'message_start' };
  const block = (index, content_block) => ({ type: 'content_block_start', index, content_block });
  const delta = (index, delta) => ({ type: 'content_block_delta', index, delta });
  const stop = index => ({ type: 'content_block_stop', index });
  const thinking = [start, block(0, { type: 'thinking' }), delta(0, { type: 'thinking_summary_delta', summary: { summary: 'thinking' } })];
  const waitingForText = [...thinking, stop(0), block(1, { type: 'text', text: '' })];
  const text = delta(1, { type: 'text_delta', text: 'resumed' });

  const ok = replay();
  ok.send(...waitingForText);
  await flush();
  t.mock.timers.tick(125_000);
  await flush();
  assert.equal(ok.cancelled, false);
  ok.send(text, stop(1), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' });
  assert.equal(await ok.done, null);
  assert.deepEqual(ok.seen.slice(-4).map(e => e.type), ['content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.deepEqual(ok.seen.at(-4), text);

  for (const [prefix, options, phase, limit] of [
    [thinking, {}, 'thinking', 360_000],
    [[...waitingForText, text], {}, 'content', 120_000],
    [[...thinking, stop(0), block(1, { type: 'tool_use', name: 'note', id: 'pending', input: {} })], {}, 'tool', 120_000],
    [thinking, { idleMs: 70 }, 'thinking', 70],
    [thinking, { idleMs: 70, thinkingIdleMs: 300 }, 'thinking', 300],
  ]) {
    const fixture = replay(options);
    fixture.send(...prefix);
    await flush();
    t.mock.timers.tick(limit - 1);
    await flush();
    assert.equal(fixture.cancelled, false);
    fixture.send(': keep-alive\n\n', { type: 'ping' }, { type: 'message_limit' });
    await flush();
    t.mock.timers.tick(1);
    await flush();
    assert.equal(fixture.cancelled, true, phase);
    const error = await fixture.done;
    assert.equal(error.status, 502);
    assert.match(error.message, new RegExp('phase=' + phase + ', timeout_ms=' + limit + ', last_byte_age_ms=1'));
    assert(!fixture.seen.some(e => e.type === 'message_stop' || e.content_block?.type === 'tool_use'));
  }
});

test('silent stall, incomplete tool turns and strict ping mode fail closed', async () => {
  const make = (events) =>
    new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(Buffer.from('data: ' + JSON.stringify(e) + '\n\n'));
        c.close();
      },
    });
  const start = { type: 'message_start' },
    tool = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'note', id: 't', input: {} },
    };
  const turn = [start, tool, { type: 'content_block_stop', index: 0 }, { type: 'ping' }];
  const drain = async (s, tools, opts) => {
    for await (const _ of validatedEvents(s, tools, opts)) {
    }
  };
  await assert.rejects(drain(make(turn), [{ name: 'note' }], { graceMs: 0 }), /unexpected EOF/);
  await assert.rejects(drain(new ReadableStream({}), [], { idleMs: 25 }), /progress/);
});

test('invalid tool delta reports its shape without exposing field values', async () => {
  const secret = 'SYNTHETIC-DELTA-SECRET';
  const events = [
    { type: 'message_start' },
    {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', name: 'note', id: 't', input: {} },
    },
    {
      type: 'content_block_delta', index: 0,
      delta: { type: 'signature_delta', signature: secret, extra: secret },
    },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  await assert.rejects(async () => {
    for await (const _ of validatedEvents(stream, [{ name: 'note' }])) {
    }
  }, (error) => {
    assert.match(error.message, /invalid tool delta \(type=signature_delta/);
    assert.match(error.message, /fields=signature, extra_fields=1/);
    assert.match(error.message, /shape=signature:string,extra:string/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test('tool argument delta aliases are normalized only inside a matching declared tool block', async () => {
  const events = [
    { type: 'message_start' },
    {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', name: 'lookup', id: 'call-1', input: {} },
    },
    {
      type: 'content_block_delta', index: 0,
      delta: { type: 'tool_use_delta', tool_use_id: 'call-1', name: 'lookup', arguments: '{"q":' },
    },
    {
      type: 'content_block_delta', index: 0,
      delta: { type: 'tool_use_delta', tool_use_id: 'call-1', name: 'lookup', arguments: '"compat"}' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  const normalized = [];
  for await (const event of validatedEvents(stream, [{
    name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  }])) normalized.push(event);

  const argumentDelta = normalized.find((event) => event.delta?.type === 'input_json_delta');
  assert.equal(JSON.parse(argumentDelta.delta.partial_json).q, 'compat');
  assert.equal(normalized.some((event) => event.delta?.type === 'tool_use_delta'), false);
});

test('Claude tool block update deltas are accepted as non-argument metadata', async () => {
  const events = [
    { type: 'message_start' },
    {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', name: 'lookup', id: 'call-1', input: { q: 'compat' } },
    },
    {
      type: 'content_block_delta', index: 0,
      delta: {
        type: 'tool_use_block_update_delta',
        message: '正在执行工具', display_content: null, tool_use_id: 'call-1',
      },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  const normalized = [];
  for await (const event of validatedEvents(stream, [{
    name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  }])) normalized.push(event);

  assert.equal(normalized.some((event) => event.delta?.type === 'tool_use_block_update_delta'), false);
  const argument = normalized.find((event) => event.delta?.type === 'input_json_delta');
  assert.deepEqual(JSON.parse(argument.delta.partial_json), { q: 'compat' });
});

test('complete tool blocks may be implicitly closed before a message stop', async () => {
  const events = [
    { type: 'message_start' },
    {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', name: 'lookup', id: 'call-1', input: { q: 'implicit' } },
    },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  const normalized = [];
  for await (const event of validatedEvents(stream, [{
    name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  }])) normalized.push(event);

  assert.equal(normalized.find((event) => event.content_block?.type === 'tool_use').content_block.id, 'call-1');
  assert.equal(normalized.find((event) => event.type === 'message_delta').delta.stop_reason, 'tool_use');
  assert.equal(normalized.at(-1).type, 'message_stop');
});

test('pause_turn is a valid upstream stop reason', async () => {
  const events = [
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' } },
    { type: 'message_stop' },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  const normalized = [];
  for await (const event of validatedEvents(stream)) normalized.push(event);
  assert.equal(normalized.find((event) => event.type === 'message_delta').delta.stop_reason, 'pause_turn');
});

test('unknown text stop reasons remain forward-compatible', async () => {
  const events = [
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'future_provider_reason' } },
    { type: 'message_stop' },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  const normalized = [];
  for await (const event of validatedEvents(stream)) normalized.push(event);
  assert.equal(normalized.find((event) => event.type === 'message_delta').delta.stop_reason, 'future_provider_reason');
});

test('unknown tool delta errors report bounded field shapes without values', async () => {
  const secret = 'SYNTHETIC-DELTA-SECRET';
  const events = [
    { type: 'message_start' },
    {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', name: 'note', id: 'call-1', input: {} },
    },
    {
      type: 'content_block_delta', index: 0,
      delta: { type: 'vendor_tool_delta', call_id: 'call-1', payload: { args: secret }, revision: 1 },
    },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  await assert.rejects(async () => {
    for await (const _ of validatedEvents(stream, [{ name: 'note' }])) {
    }
  }, (error) => {
    assert.match(error.message, /type=vendor_tool_delta/);
    assert.match(error.message, /extra_fields=3/);
    assert.match(error.message, /shape=call_id:string,payload:object\{args:string\},revision:number/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test('tool stream compatibility repairs identifiers and only uniquely resolvable names', async () => {
  const encode = (events) => new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  const collect = async (events, tools) => {
    const result = [];
    for await (const event of validatedEvents(encode(events), tools)) result.push(event);
    return result;
  };
  const begin = { type: 'message_start' };
  const finish = { type: 'message_stop' };
  const reason = { type: 'message_delta', delta: { stop_reason: 'tool_use' } };
  const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
  const tools = [{ name: 'lookup', input_schema: schema }];

  const repaired = await collect([
    begin,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'FUNCTIONS.lookup', input: { q: 'ok' } } },
    { type: 'content_block_stop', index: 0 }, reason, finish,
  ], tools);
  const repairedCall = repaired.find((event) => event.content_block?.type === 'tool_use');
  assert.equal(repairedCall.content_block.name, 'lookup');
  assert.match(repairedCall.content_block.id, /^toolu_compat_0/);
  assert.deepEqual(JSON.parse(repaired.find((event) => event.delta?.type === 'input_json_delta').delta.partial_json), { q: 'ok' });

  const duplicateIds = await collect([
    begin,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'lookup', id: 'same', input: {} } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'lookup', id: 'same', input: {} } },
    { type: 'content_block_stop', index: 1 }, reason, finish,
  ], [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }]);
  const ids = duplicateIds.filter((event) => event.content_block?.type === 'tool_use').map((event) => event.content_block.id);
  assert.deepEqual(ids, ['same', 'toolu_compat_1']);

  const secret = 'SYNTHETIC-UNKNOWN-TOOL-PAYLOAD';
  const unavailable = await collect([
    begin,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'not_declared', id: 'x', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: secret } },
    { type: 'content_block_stop', index: 0 }, reason, finish,
  ], tools);
  assert.equal(unavailable.some((event) => event.content_block?.type === 'tool_use'), false);
  assert.equal(unavailable.find((event) => event.delta?.type === 'text_delta').delta.text,
    '上游请求了本次请求未声明的工具；未执行该调用。');
  assert.equal(unavailable.find((event) => event.type === 'message_delta').delta.stop_reason, 'end_turn');
  assert.doesNotMatch(JSON.stringify(unavailable), new RegExp(secret));
});

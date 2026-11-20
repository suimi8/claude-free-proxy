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
    'plugins/test/plugin.mjs',
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

test('silent stall, undeclared calls and strict ping mode fail closed', async () => {
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
  await assert.rejects(drain(make(turn), [], {}), /undeclared/);
  await assert.rejects(drain(make(turn), [{ name: 'note' }], { graceMs: 0 }), /unexpected EOF/);
  await assert.rejects(drain(new ReadableStream({}), [], { idleMs: 25 }), /progress/);
});

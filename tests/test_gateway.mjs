import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { sandbox, project } from './offline-fixtures.mjs';

const start = {
  type: 'message_start',
  message: { type: 'message', id: 'fixture', role: 'assistant', model: 'fixture', content: [] },
};
const end = { type: 'message_stop' },
  ping = { type: 'ping' };
const block = (index, content_block) => ({ type: 'content_block_start', index, content_block });
const stop = (index) => ({ type: 'content_block_stop', index });
const delta = (index, delta) => ({ type: 'content_block_delta', index, delta });
const reason = (stop_reason) => ({ type: 'message_delta', delta: { stop_reason, stop_sequence: null } });
const arg = (i, s) => delta(i, { type: 'input_json_delta', partial_json: s });
const tool = (i, id, input = {}) => block(i, { type: 'tool_use', name: 'write', id, input });
const args = [
  { file_path: 'note.md', content: '中文🌱\nsecond line' },
  { file_path: 'other.md', content: 'two' },
];
const textEvents = (s = '下一轮正常') => [
  start,
  block(0, { type: 'text', text: '' }),
  delta(0, { type: 'text_delta', text: s }),
  stop(0),
  reason('end_turn'),
  end,
];
const piece = '0123456789abcdef';
const largeArgs = { file_path: 'note.md', content: '' };
largeArgs.content = 'a'.repeat(1036 - Buffer.byteLength(JSON.stringify(largeArgs)));
const series = {
  longText: [start, block(0, { type: 'text', text: '' }),
    ...Array.from({ length: 256 }, () => delta(0, { type: 'text_delta', text: piece })),
    stop(0), reason('end_turn'), end],
  truncated: [start, block(0, { type: 'thinking', thinking: '' }),
    delta(0, { type: 'thinking_delta', thinking: 'think' }),
    delta(0, { type: 'thinking_delta', thinking: 'ing' }), stop(0),
    block(1, { type: 'text', text: '' }), delta(1, { type: 'text_delta', text: 'partial text' }),
    stop(1), reason('max_tokens'), end],
  truncatedThinking: [start, block(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'first' }), stop(0),
    block(1, { type: 'thinking', thinking: '' }), delta(1, { type: 'thinking_summary_delta', summary: { summary: 'second' } }),
    stop(1), reason('max_tokens'), end],
  truncatedTool: [start, tool(0, 'a', args[0]), stop(0), reason('max_tokens'), end],
  largeTool: [start, tool(0, 'tool-fixture'), arg(0, JSON.stringify(largeArgs)), stop(0), reason('tool_use'), end],
  pauseStream: [start, block(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'partial' })],
  text: textEvents(),
  pseudo: textEvents('<tool_call>{"name":"write","arguments":{}}</tool_call>'),
  // Stop the SECOND block first. Both arrival order and call IDs must be retained.
  interleaved: [
    start,
    tool(0, 'a'),
    arg(0, '{"file_path":"note.md",'),
    ping,
    tool(1, 'b'),
    arg(1, JSON.stringify(args[1])),
    stop(1),
    arg(0, '"content":"中文🌱\\nsecond line"}'),
    stop(0),
    reason('end_turn'),
    end,
  ],
  hanging: [start, tool(0, 'a', args[0]), stop(0), ping],
  noCall: [start, reason('tool_use'), end],
  wrongType: [start, tool(0, 'a', { file_path: 'note.md', content: null }), stop(0), end],
  missing: [start, tool(0, 'a'), arg(0, '{"file_path":"note.md"}'), stop(0), reason('tool_use'), end],
  malformed: [
    start,
    tool(0, 'a', args[0]),
    stop(0),
    ping,
    tool(1, 'b'),
    arg(1, '{"file_path":'),
    stop(1),
    end,
  ],
  interrupted: [start, tool(0, 'a'), arg(0, '{"file_path":"note.md",'), ping],
  eof: [start, tool(0, 'a'), arg(0, '{"file_path":"note.md",')],
  late: [
    start,
    tool(0, 'a', args[0]),
    stop(0),
    ping,
    tool(1, 'b', args[1]),
    stop(1),
    reason('tool_use'),
    end,
  ],
};
function mockUpstream() {
  const state = { mode: 'text', bodies: [], uploads: [], requests: 0, closedWaits: 0 };
  state.server = http.createServer(async (req, res) => {
    state.requests++;
    const body = [];
    for await (const chunk of req) body.push(chunk);
    if (req.url.endsWith('/chat_conversations')) {
      res.writeHead(201);
      return res.end('{}');
    }
    if (req.url.endsWith('/upload')) {
      const multipart = Buffer.concat(body);
      const bytes = multipart.subarray(multipart.indexOf('\r\n\r\n') + 4, multipart.lastIndexOf('\r\n--'));
      const id = createHash('sha256').update(bytes).digest('hex');
      state.uploads.push(id);
      return res.end(JSON.stringify({ file_uuid: id }));
    }
    if (!req.url.endsWith('/completion')) {
      res.writeHead(404);
      return res.end();
    }
    state.bodies.push(JSON.parse(Buffer.concat(body)));
    const mode = state.mode, uuid = 'message-fixture-' + state.bodies.length;
    if (mode === 'pauseHeaders') {
      state.server.emit('holding-headers');
      return;
    }
    if (mode === 'reject' || mode === 'retryOnce') {
      state.mode = 'text';
      res.writeHead(mode === 'reject' ? 400 : 503);
      return res.end('upstream fixture rejected this request');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    for (const ev of series[mode]) {
      // Multi-line SSE data + CRLF; also split inside a UTF-8 scalar on the wire.
      const event = ev === start ? { ...ev, message: { ...ev.message, uuid } } : ev;
      const data = JSON.stringify(event).replace('{', '{\n');
      const buf = Buffer.from(
        'event: ' +
          ev.type +
          '\r\n' +
          data
            .split('\n')
            .map((l) => 'data: ' + l)
            .join('\r\n') +
          '\r\n\r\n'
      );
      const split = buf.indexOf(Buffer.from('中'));
      if (split >= 0) {
        res.write(buf.subarray(0, split + 1));
        await delay(2);
        res.write(buf.subarray(split + 1));
      } else res.write(buf);
      if (mode === 'late' && ev === ping) await delay(10);
    }
    if (mode === 'pauseStream') return;
    if (mode === 'hanging') {
      res.on('close', () => state.closedWaits++);
      return;
    } // do not send EOF
    if (mode === 'interrupted') {
      await delay(15);
      return res.destroy();
    }
    res.end();
  });
  return state;
}
function startGateway(app, env) {
  const child = spawn(process.execPath, [path.join(app, 'src/openai-proxy.mjs')], {
    cwd: app,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const closed = once(child, 'close');
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture gateway startup timed out: ' + output)), 7000);
    child.stdout.on('data', (b) => {
      output += b;
      const m = /\[openai-proxy\] http:\/\/127\.0\.0\.1:(\d+)\/v1/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(+m[1]);
      }
    });
    child.stderr.on('data', (b) => {
      output += b;
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (c) => {
      clearTimeout(timer);
      reject(new Error('fixture exited ' + c + ': ' + output));
    });
  });
  return {
    ready,
    child,
    get output() {
      return output;
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    },
  };
}
function request(
  port,
  route,
  { key, body, method = body === undefined ? 'GET' : 'POST', raw, headers = {}, signal = AbortSignal.timeout(5000) } = {}
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method,
        agent: false,
        signal,
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: 'Bearer ' + key } : {}),
          ...headers,
        },
      },
      (res) => {
        const bufs = [];
        res.on('data', (b) => bufs.push(b));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(bufs).toString();
          resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      }
    );
    req.on('error', reject);
    req.end(raw ?? JSON.stringify(body));
  });
}
const schema = {
  type: 'object',
  properties: { file_path: { type: 'string' }, content: { type: 'string' } },
  required: ['file_path', 'content'],
};
const routes = { chat: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages' };
function payload(api, stream) {
  const common = { stream, model: 'fixture' };
  if (api === 'responses')
    return {
      ...common,
      input: 'write test',
      tools: [{ type: 'function', name: 'write', parameters: schema }],
    };
  const messages = [{ role: 'user', content: 'write test' }];
  if (api === 'messages') return { ...common, messages, tools: [{ name: 'write', input_schema: schema }] };
  return {
    ...common,
    messages,
    tools: [{ type: 'function', function: { name: 'write', parameters: schema } }],
  };
}
function events(r) {
  return r.text
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map((l) => JSON.parse(l.slice(6)));
}
function calls(api, stream, r) {
  if (!stream) {
    const j = r.json();
    if (api === 'chat') {
      assert.equal(j.choices[0].finish_reason, 'tool_calls');
      return j.choices[0].message.tool_calls.map((t) => [t.id, JSON.parse(t.function.arguments)]);
    }
    if (api === 'responses') {
      assert.equal(j.status, 'completed');
      return j.output
        .filter((t) => t.type === 'function_call')
        .map((t) => [t.call_id, JSON.parse(t.arguments)]);
    }
    assert.equal(j.stop_reason, 'tool_use');
    return j.content.filter((t) => t.type === 'tool_use').map((t) => [t.id, t.input]);
  }
  const es = events(r);
  if (api === 'responses') {
    assert.equal(es.at(-1).type, 'response.completed');
    const fc = es.filter((e) => e.type === 'response.output_item.done' && e.item.type === 'function_call');
    for (const { item, output_index } of fc)
      assert.equal(
        es
          .filter(
            (e) =>
              e.type === 'response.function_call_arguments.delta' &&
              e.item_id === item.id &&
              e.output_index === output_index
          )
          .map((e) => e.delta)
          .join(''),
        item.arguments
      );
    return fc.map(({ item }) => [item.call_id, JSON.parse(item.arguments)]);
  }
  const slots = new Map();
  if (api === 'chat') {
    assert.equal(es.at(-1).choices[0].finish_reason, 'tool_calls');
    assert.match(r.text, /data: \[DONE\]/);
    for (const e of es)
      for (const t of e.choices[0].delta.tool_calls || []) {
        if (t.id) slots.set(t.index, { id: t.id, args: '' });
        slots.get(t.index).args += t.function.arguments || '';
      }
  } else {
    assert.equal(es.at(-1).type, 'message_stop');
    assert.equal(es.find((e) => e.type === 'message_delta').delta.stop_reason, 'tool_use');
    for (const e of es) {
      if (e.content_block?.type === 'tool_use') slots.set(e.index, { id: e.content_block.id, args: '' });
      if (e.delta?.type === 'input_json_delta') slots.get(e.index).args += e.delta.partial_json;
    }
  }
  return [...slots.values()].map((t) => [t.id, JSON.parse(t.args)]);
}

// Construct the runtime image layout in a directory that has no private config, plugins or tools.
function stageApp(root) {
  const app = path.join(root, 'app');
  const files = fs
    .readFileSync(path.join(project, '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('!') && !l.endsWith('/'))
    .map((l) => l.slice(1));
  for (const file of files) {
    const dst = path.join(app, file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(project, file), dst);
  }
  const require = createRequire(import.meta.url),
    dep = path.dirname(require.resolve('undici/package.json'));
  fs.mkdirSync(path.join(app, 'node_modules'));
  fs.symlinkSync(
    dep,
    path.join(app, 'node_modules/undici'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  return app;
}

test('isolated gateway with loopback mock upstream', { timeout: 100000 }, async (t) => {
  const box = sandbox(t),
    app = stageApp(box.root),
    data = path.join(app, 'data');
  const env = {
    ...box.env,
    DATA_DIR: data,
    LOCAL_API_KEY: 'legacy-fixture-only',
    TOOL_PING_GRACE_MS: '150',
    ACCOUNT_QUEUE_BUDGET_MS: '1000',
  };
  const mock = mockUpstream();
  mock.server.listen(0, '127.0.0.1');
  await once(mock.server, 'listening');
  const base = 'http://127.0.0.1:' + mock.server.address().port;
  const pluginDir = path.join(app, 'plugins', 'fixture');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'plugin.mjs'),
    "export function registerPlugin({onRoute,json}){onRoute('/v1/private-plugin',(req,res)=>json(res,200,{fixture:true}));}"
  );
  fs.writeFileSync(path.join(app, 'web/webui.local.html'), 'PRIVATE-LAYOUT-FIXTURE');
  let gw = startGateway(app, env),
    port;
  try {
    port = await gw.ready;
    const cfgFile = path.join(data, 'config.json'),
      cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    const admin = cfg.keys.find((k) => k.role === 'admin').key,
      user = cfg.keys.find((k) => k.role === 'inference').key;
    const acctSecret = 'SYNTHETIC-account-credential',
      mail = 'SYNTHETIC-mail-secret';
    const call = (route, opts) => request(port, route, opts);
    const logs = async () => (await call('/v1/usage/logs?range=all&limit=1000', { key: admin })).json().logs;
    const countRoute = '/v1/messages/count_tokens';
    async function logFor(uuid) {
      for (let i = 0; i < 100; i++) {
        const rows = (await logs()).filter(row => row.parent_uuid === uuid);
        if (rows.length) {
          assert.equal(rows.length, 1, uuid);
          return rows[0];
        }
        await delay(10);
      }
      assert.fail('missing log for ' + uuid);
    }
    await t.test('token count is offline with an empty pool and obeys Messages permissions', async () => {
      const body = payload('messages', false);
      const before = mock.requests;
      const short = await call(countRoute, { headers: { 'x-api-key': user }, body: { messages: body.messages } });
      const full = await call(countRoute, { key: user, body });
      assert.equal(short.status, 200, short.text);
      assert.equal(full.status, 200, full.text);
      assert.deepEqual(Object.keys(full.json()), ['input_tokens']);
      assert.equal(full.headers['x-token-count-source'], 'local-estimate');
      assert(full.json().input_tokens > short.json().input_tokens);
      const restricted = (await call('/v1/keys', { key: admin, body: { name: 'restricted', models: ['claude-haiku-5-5'] } })).json().secret;
      for (const route of [countRoute, routes.messages]) {
        assert.equal((await call(route, { body })).status, 401);
        assert.equal((await call(route, { key: restricted, body })).status, 403);
        assert.equal((await call(route, { key: user, body: { messages: [] } })).status, 400);
      }
      const validationRows = await logs();
      assert.deepEqual(validationRows.map(r => [r.api, r.status, r.attempts]).sort((a, b) => a[1] - b[1]),
        [['messages', 400, 0], ['messages', 403, 0]]);
      const beforeRows = validationRows.length;
      const failed = await call(routes.messages, { key: user, body });
      assert.equal(failed.status, 429);
      assert.equal(mock.requests, before);
      const rows = await logs();
      assert.equal(rows.length, beforeRows + 1);
      const row = rows[0];
      assert.deepEqual([row.api, row.status, row.attempts, row.ok, row.account_id, row.input_tokens, row.output_tokens],
        ['messages', 429, 0, false, '', 0, 0]);
    });
    await t.test('fresh volume, public readiness, private UI shell and restart persistence', async () => {
      assert.notEqual(admin, user);
      assert(!gw.output.includes(admin));
      assert(!gw.output.includes(user));
      const ready = await call('/readyz');
      assert.deepEqual(ready.json(), { status: 'ready' });
      assert.equal(ready.headers['x-gateway-service'], 'claude-desktop-proxy');
      const doctor = spawnSync(process.execPath, [path.join(app, 'src/doctor.mjs'), String(port)], {
        env,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(doctor.status, 0, doctor.stderr);
      const ui = await call('/ui');
      assert.equal(ui.status, 200);
      for (const s of [
        admin,
        user,
        '__BOOT_KEY__',
        '/v1/accounts/export',
        '/credentials',
        'fetchExportData',
      ])
        assert(!ui.text.includes(s), s);
      assert(!ui.text.includes('PRIVATE-LAYOUT-FIXTURE'));
      assert.equal((await call('/v1/private-plugin', { key: admin })).status, 404);
      const status = await call('/login/fixture');
      assert.equal(status.status, 200);
      assert(!status.text.includes(admin));
      assert.match(status.text, /authorization:/i);
      const a = await call('/v1/accounts', {
        key: admin,
        body: { id: 'fixture', label: 'only test', sessionKey: acctSecret, org: 'org-fixture', base },
      });
      assert([200, 201].includes(a.status), a.text);
      const setting = await call('/v1/pool', {
        key: admin,
        body: { maomailToken: mail, pricePerMillionTokens: 7 },
      });
      assert.equal(setting.status, 200, setting.text);
      assert(!setting.text.includes(mail));
      assert(fs.existsSync(path.join(data, 'accounts.json')));
      assert(!fs.existsSync(path.join(app, 'accounts.json')));
      assert(!fs.existsSync(path.join(app, 'config.json')));
      await gw.stop();
      gw = startGateway(app, { ...env, ENABLE_LOCAL_PLUGINS: '1' });
      port = await gw.ready;
      assert.deepEqual((await call('/v1/private-plugin', { key: admin })).json(), { fixture: true });
      assert.equal(
        JSON.parse(fs.readFileSync(cfgFile, 'utf8')).keys.find((k) => k.role === 'admin').key,
        admin
      );
      const st = (await call('/v1/accounts', { key: admin })).json();
      assert.equal(st.total, 1);
      assert.equal(st.price_per_million_tokens, 7);
      assert.equal(st.has_mail_token, true);
    });
    const secondKey = (await call('/v1/keys', { key: admin, body: { name: 'second caller' } })).json();
    const second = secondKey.secret;
    assert(second);
    await t.test('management always requires admin; secrets never appear on read or in URLs', async () => {
      for (const route of [
        '/healthz',
        '/v1/accounts',
        '/v1/pool',
        '/v1/keys',
        '/login/fixture/state',
        '/v1/operations',
        '/v1/private-plugin',
      ]) {
        assert.equal((await call(route)).status, 401, route);
        for (const key of [user, env.LOCAL_API_KEY])
          assert.equal((await call(route, { key })).status, 403, route);
      }
      for (const route of ['/v1/keys', '/v1/accounts', '/v1/pool', '/healthz']) {
        const r = await call(route, { key: admin });
        assert.equal(r.status, 200, route);
        for (const s of [acctSecret, admin, user, second, mail])
          assert(!r.text.includes(s), 'secret in ' + route);
      }
      const id = (await call('/v1/accounts', { key: admin })).json().accounts[0].id;
      for (const route of ['/v1/accounts/export', '/v1/accounts/' + id + '/credentials'])
        assert.equal((await call(route, { key: admin })).status, 410);
      assert.equal((await call('/v1/keys?k=' + admin)).status, 401);
      assert.equal(
        (await call('/v1/pool', { key: admin, headers: { origin: 'https://other.example' } })).status,
        403
      );
      assert.equal((await call('/v1/keys', { key: admin, method: 'POST', raw: '{invalid' })).status, 400);
      assert.equal((await call('/v1/models', { key: env.LOCAL_API_KEY })).status, 200);
      assert.equal((await call('/v1/fetch', { key: user, body: { url: 'http://127.0.0.1' } })).status, 400);
    });
    await t.test('DSH with a /v1 base shares Messages auth, counts, streaming and logs', async () => {
      const body = payload('messages', true);
      const countAlias = '/v1' + countRoute;
      const messagesAlias = '/v1' + routes.messages;
      const restricted = (await call('/v1/keys', {
        key: admin, body: { name: 'alias model restriction', models: ['claude-haiku-5-5'] },
      })).json().secret;
      const before = mock.requests;
      for (const route of [countAlias, messagesAlias]) {
        assert.equal((await call(route, { body })).status, 401);
        assert.equal((await call(route, { key: restricted, body })).status, 403);
      }
      assert.equal((await call('/v1/v1/keys', { key: admin, method: 'POST', raw: '{invalid' })).status, 404);
      const count = await call(countAlias, { headers: { 'x-api-key': user }, body });
      assert.equal(count.status, 200);
      assert.equal(count.headers['x-token-count-source'], 'local-estimate');
      assert.deepEqual(count.json(), (await call(countRoute, { key: user, body })).json());
      assert.equal(mock.requests, before);

      const r = await call(messagesAlias + '?beta=true', { headers: { 'x-api-key': user }, body });
      assert.equal(r.status, 200, r.text);
      assert.equal(events(r).at(-1).type, 'message_stop');
      const row = await logFor('message-fixture-' + mock.bodies.length);
      assert.deepEqual([row.api, row.status, row.attempts], ['messages', 200, 1]);
    });
    await t.test('request effort reaches the upstream on all three APIs', async () => {
      const cases = [
        ['messages', { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } }, 'medium'],
        ['messages', { output_config: { effort: 'low' } }, 'low'],
        ['messages', { output_config: { effort: 'invalid' }, reasoning_effort: 'high' }, 'high'],
        ['messages', { thinking: { type: 'disabled' } }, undefined],
        ['messages', {}, 'max'],
        ['chat', { reasoning_effort: 'medium' }, 'medium'],
        ['responses', { reasoning: { effort: 'medium' } }, 'medium'],
      ];
      for (const [api, settings, expected] of cases) {
        const before = mock.bodies.length;
        const r = await call(routes[api], { key: user, body: { ...payload(api, false), ...settings } });
        assert.equal(r.status, 200, r.text);
        assert.equal(mock.bodies.length, before + 1);
        const sent = mock.bodies[before];
        assert.equal(sent.effort, expected, `${api} ${JSON.stringify(settings)}`);
        assert(!Object.hasOwn(sent, 'output_config'));
      }
    });
    await t.test(
      'string and block Messages histories serialize to identical upstream prompts',
      async () => {
        for (const content of ['上一条', [{ type: 'text', text: '上一条' }]]) {
          const r = await call(routes.messages, {
            key: user,
            body: {
              messages: [
                { role: 'user', content: '开始' },
                { role: 'assistant', content },
                { role: 'user', content: '继续' },
              ],
            },
          });
          assert.equal(r.status, 200, r.text);
        }
        const [a, b] = mock.bodies.slice(-2);
        assert.equal(a.prompt, b.prompt);
        assert.match(a.prompt, /上一条/);
        assert.equal(
          (
            await call(routes.messages, {
              key: user,
              body: { messages: [{ role: 'assistant', content: 42 }] },
            })
          ).status,
          400
        );
      }
    );
    await t.test(
      'DSH-style Messages round trip replays both validated calls and their matching results',
      async () => {
        mock.mode = 'interleaved';
        const body = payload('messages', false);
        const first = await call(routes.messages, { key: user, body });
        assert.equal(first.status, 200, first.text);
        const blocks = first.json().content;
        assert.deepEqual(
          blocks.map((b) => b.id),
          ['a', 'b']
        );
        body.messages.push(
          { role: 'assistant', content: blocks },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'b', content: 'second result' },
              { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'first result' }] },
              { type: 'text', text: 'continue now' },
            ],
          }
        );
        mock.mode = 'text';
        const next = await call(routes.messages, { key: user, body });
        assert.equal(next.status, 200, next.text);
        const prompt = mock.bodies.at(-1).prompt;
        for (const s of [
          '[TOOL_CALL write id=a]',
          '[TOOL_CALL write id=b]',
          '[TOOL_RESULT b]\nsecond result',
          '[TOOL_RESULT a]\nfirst result',
          'continue now',
        ])
          assert(prompt.includes(s), s);
      }
    );
    await t.test('DSH retains tool result errors, matching IDs and nested and sibling screenshots', async () => {
      mock.mode = 'text';
      const screenshot = data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
      const first = screenshot('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBcQAAAAASUVORK5CYII=');
      const second = screenshot('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
      const id = img => createHash('sha256').update(Buffer.from(img.source.data, 'base64')).digest('hex');
      const text = value => ({ type: 'text', text: value });
      const toolResult = (content, is_error) => ({ type: 'tool_result', tool_use_id: 'shot-1', is_error, content });
      const replay = async blocks => {
        const body = payload('messages', false);
        body.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'shot-1', name: 'write', input: args[0] }] },
          { role: 'user', content: blocks });
        const requests = mock.requests;
        const counted = await call(countRoute, { key: user, body });
        assert.equal(mock.requests, requests, 'counting must not upload images or contact the upstream');
        const r = await call(routes.messages, { key: user, body });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json().usage.input_tokens, counted.json().input_tokens);
        return mock.bodies.at(-1);
      };
      const nested = await replay([toolResult([text('inside'), first], false)]);
      const sibling = await replay([toolResult('inside', false), first]);
      for (const body of [nested, sibling]) {
        assert.deepEqual(body.files, [id(first)]);
        assert.equal(body.prompt.match(/\[image\]/g).length, 1);
      }
      assert.match(nested.prompt, /\[TOOL_RESULT shot-1\]\ninside\n\[image\]/);
      assert.match(sibling.prompt, /\[TOOL_RESULT shot-1\]\ninside\n\n\[USER\]\n\[image\]/);
      const mixed = await replay([toolResult([text('inside'), second, text('after nested')], true),
        text('before sibling'), first, text('after sibling')]);
      assert.deepEqual(mixed.files, [id(second), id(first)]);
      assert(mixed.prompt.includes('[TOOL_RESULT shot-1 is_error=true]\ninside\n[image]\nafter nested\n\n[USER]\nbefore sibling\n[image]\nafter sibling'));
      const success = await replay([toolResult([text('inside'), second, text('after nested')], false),
        text('before sibling'), first, text('after sibling')]);
      assert.equal(mixed.prompt.replace(' is_error=true', ''), success.prompt);
    });
    await t.test('Responses defaults to JSON and streams linear-size reconstructible deltas on request', async (t) => {
      mock.mode = 'text';
      for (const body of [{ input: 'text' }, { input: 'text', stream: false }]) {
        const r = await call(routes.responses, { key: user, body });
        assert.equal(r.status, 200, r.text);
        assert.match(r.headers['content-type'], /^application\/json/);
        assert.equal(r.json().status, 'completed');
      }
      mock.mode = 'longText';
      const r = await call(routes.responses, { key: user, body: { input: 'text', stream: true } });
      assert.match(r.headers['content-type'], /^text\/event-stream/);
      const es = events(r), deltas = es.filter(e => e.type === 'response.output_text.delta');
      assert.equal(deltas.length, 256);
      assert(deltas.every(e => !Object.hasOwn(e, 'snapshot')));
      assert.deepEqual(es.map(e => e.sequence_number), es.map((_, i) => i));
      assert.equal(es.at(-1).type, 'response.completed');
      const content = deltas.map(e => e.delta).join('');
      assert.equal(content, piece.repeat(256));
      assert.equal(es.find(e => e.type === 'response.output_text.done').text, content);
      assert.equal(es.at(-1).response.output[0].content[0].text, content);
      const bytes = Buffer.byteLength(r.text);
      assert(bytes < 90000, '4 KiB streamed as ' + bytes + ' bytes');
      t.diagnostic('4096 output bytes, 256 deltas, ' + bytes + ' SSE body bytes');
    });
    await t.test('Responses preserves a truncated answer, its reasoning and terminal status on retrieval', async () => {
      mock.mode = 'truncated';
      for (const stream of [false, true]) {
        const r = await call(routes.responses, { key: user, body: { input: 'test', stream } });
        assert.equal(r.status, 200, r.text);
        const es = stream ? events(r) : [];
        const response = stream ? es.at(-1).response : r.json();
        assert.equal(response.status, 'incomplete');
        assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });
        assert.deepEqual(response.output.map(i => [i.type, i.status]), [['reasoning', 'completed'], ['message', 'incomplete']]);
        assert.equal(response.output[0].summary[0].text, 'thinking');
        assert.equal(response.output[1].content[0].text, 'partial text');
        assert.equal(response.usage.output_tokens_details.reasoning_tokens, 2);
        assert.equal(response.usage.output_tokens, 5);
        const stored = await call(routes.responses + '/' + response.id, { key: user });
        assert.deepEqual(stored.json(), response);
        if (stream) {
          assert.equal(es.at(-1).type, 'response.incomplete');
          assert(!es.some(e => e.type === 'response.completed'));
          const parts = es.filter(e => e.type === 'response.reasoning_summary_text.delta');
          assert.deepEqual(parts.map(e => e.delta), ['think', 'ing']);
          assert(parts.every(e => e.summary_index === 0 && !Object.hasOwn(e, 'snapshot')));
          assert.equal(es.find(e => e.type === 'response.reasoning_summary_text.done').text, 'thinking');
          assert.equal(es.filter(e => e.type === 'response.output_item.done').at(-1).item.status, 'incomplete');
        }
      }
      mock.mode = 'truncatedThinking';
      for (const stream of [false, true]) {
        const r = await call(routes.responses, { key: user, body: { input: 'test', stream } });
        const es = stream ? events(r) : [];
        const response = stream ? es.at(-1).response : r.json();
        assert.deepEqual(response.output.map(i => [i.type, i.status]), [['message', 'completed'], ['reasoning', 'incomplete']]);
        if (stream) {
          assert.equal(es.find(e => e.type === 'response.reasoning_summary_part.done').status, 'incomplete');
          assert.deepEqual(es.filter(e => e.type === 'response.output_item.done').map(e => e.output_index), [0, 1]);
        }
      }
      mock.mode = 'text';
    });
    await t.test('1,036 bytes of tool arguments have identical usage across all APIs, streams and request logs', async () => {
      mock.mode = 'largeTool';
      const expectedInput = (await call(countRoute, { key: user, body: payload('messages', false) })).json().input_tokens;
      assert.equal(Buffer.byteLength(JSON.stringify(largeArgs)), 1036);
      for (const api of Object.keys(routes)) for (const stream of [false, true]) {
        const body = payload(api, stream);
        if (api === 'chat' && stream) body.stream_options = { include_usage: true };
        const r = await call(routes[api], { key: user, body });
        assert.equal(r.status, 200, r.text);
        const es = stream ? events(r) : [];
        let usage;
        if (api === 'messages' && stream) {
          assert.equal(es[0].message.usage.input_tokens, expectedInput);
          usage = es.find(e => e.type === 'message_delta').usage;
        } else if (api === 'chat' && stream) {
          assert.deepEqual(es.at(-1).choices, []);
          assert(es.slice(0, -1).every(e => e.usage === null));
          usage = es.at(-1).usage;
        } else usage = stream ? es.at(-1).response.usage : r.json().usage;
        const row = await logFor('message-fixture-' + mock.bodies.length);
        assert.equal(row.api, api === 'chat' ? 'chat.completions' : api);
        assert.deepEqual([row.input_tokens, row.output_tokens, row.attempts], [expectedInput, 259, 1]);
        assert.equal(usage.output_tokens ?? usage.completion_tokens, row.output_tokens);
        assert.equal(usage.input_tokens ?? usage.prompt_tokens, row.input_tokens);
      }
      mock.mode = 'text';
    });
    await t.test('Responses retrieval and continuation are scoped to the creating key', async () => {
      const r = await call(routes.responses, {
        key: user,
        body: { input: 'private-note-fixture', stream: false },
      });
      assert.equal(r.status, 200, r.text);
      const id = r.json().id;
      assert.equal((await call(routes.responses + '/' + id, { key: user })).status, 200);
      const n = mock.bodies.length;
      for (const key of [second, admin]) {
        assert.equal((await call(routes.responses + '/' + id, { key })).status, 404);
        assert.equal(
          (
            await call(routes.responses, {
              key,
              body: { previous_response_id: id, input: 'next', stream: false },
            })
          ).status,
          404
        );
      }
      assert.equal(mock.bodies.length, n);
      const continued = await call(routes.responses, {
        key: user,
        body: { previous_response_id: id, input: 'next', stream: false },
      });
      assert.equal(continued.status, 200, continued.text);
      assert.match(mock.bodies.at(-1).prompt, /private-note-fixture/);
    });
    await t.test('stateless responses and rotated keys cannot retrieve stored content', async () => {
      for (const stream of [false, true]) {
        const r = await call(routes.responses, {
          key: user,
          body: { input: 'do not store', store: false, stream },
        });
        const response = stream ? events(r).at(-1).response : r.json();
        assert.equal(response.store, false);
        assert.equal((await call(routes.responses + '/' + response.id, { key: user })).status, 404);
      }
      const r = await call(routes.responses, {
        key: second,
        body: { input: 'before rotation', stream: false },
      });
      const id = r.json().id;
      const newKey = 'rotated-test-caller-key';
      assert.equal(
        (await call('/v1/keys/' + secondKey.key.id, { key: admin, method: 'PATCH', body: { key: newKey } }))
          .status,
        200
      );
      assert.equal((await call(routes.responses + '/' + id, { key: second })).status, 401);
      assert.equal((await call(routes.responses + '/' + id, { key: newKey })).status, 404);
    });
    for (const api of Object.keys(routes))
      for (const stream of [false, true]) {
        await t.test(
          `${api} ${stream ? 'stream' : 'JSON'}: complete, interleaved, hanging, malformed, interrupted and recovered`,
          async () => {
            const send = (mode) => {
              mock.mode = mode;
              return call(routes[api], { key: user, body: payload(api, stream) });
            };
            for (const mode of ['interleaved', 'late', 'hanging']) {
              const r = await send(mode);
              assert.equal(r.status, 200, r.text);
              assert.deepEqual(
                calls(api, stream, r),
                mode === 'hanging'
                  ? [['a', args[0]]]
                  : [
                      ['a', args[0]],
                      ['b', args[1]],
                    ]
              );
            }
            for (const mode of ['missing', 'wrongType', 'noCall', 'malformed', 'eof', 'interrupted', 'truncatedTool']) {
              const r = await send(mode);
              assert.equal(r.status, stream ? 200 : 502, r.text);
              assert.match(r.text, /Invalid upstream stream/);
              assert.doesNotMatch(
                r.text,
                /note\.md|other\.md|"tool_calls":\[|"type":"(?:tool_use|function_call|input_json_delta)"|event: response\.function_call_arguments|\[DONE\]|event: (?:response\.completed|message_stop)/
              );
              if (stream) {
                const last = events(r).at(-1);
                assert(
                  api === 'chat'
                    ? last.error
                    : api === 'messages'
                      ? last.type === 'error'
                      : last.type === 'response.failed'
                );
              }
              const ok = await send('text');
              assert.equal(ok.status, 200, ok.text);
              assert.match(ok.text, /下一轮正常/);
            }
            const pseudo = await send('pseudo');
            assert.match(pseudo.text, /tool_call>/);
            assert.doesNotMatch(pseudo.text, /"tool_calls":\[|"type":"(?:tool_use|function_call)"/);
          }
        );
      }
    await t.test('upstream retries, cancellations and final rejection produce one terminal log per request', async () => {
      const beforeRetry = (await logs()).length;
      const beforeAttempts = mock.bodies.length;
      mock.mode = 'retryOnce';
      const recovered = await call(routes.responses, { key: user, body: { input: 'retry fixture' } });
      assert.equal(recovered.status, 200, recovered.text);
      assert.equal(mock.bodies.length, beforeAttempts + 2);
      const retried = await logFor('message-fixture-' + mock.bodies.length);
      assert.deepEqual([retried.api, retried.status, retried.attempts, retried.ok], ['responses', 200, 2, true]);
      assert.equal((await logs()).length, beforeRetry + 1);

      async function rowAfter(count) {
        for (let i = 0; i < 150; i++) {
          const rows = await logs();
          if (rows.length > count) { assert.equal(rows.length, count + 1); return rows[0]; }
          await delay(10);
        }
        assert.fail('cancelled request log did not arrive');
      }
      const beforeHeaders = (await logs()).length;
      mock.mode = 'pauseHeaders';
      const abortHeaders = new AbortController();
      const started = once(mock.server, 'holding-headers', { signal: AbortSignal.timeout(4000) });
      const cancellation = assert.rejects(call(routes.messages, { key: user, body: payload('messages', false),
        signal: AbortSignal.any([abortHeaders.signal, AbortSignal.timeout(5000)]) }), { name: 'AbortError' });
      try { await started; } finally { abortHeaders.abort(); }
      await cancellation;
      const early = await rowAfter(beforeHeaders);
      assert.deepEqual([early.api, early.status, early.attempts, early.ok], ['messages', 499, 1, false]);

      const beforeStream = (await logs()).length;
      mock.mode = 'pauseStream';
      const abortStream = new AbortController();
      const streamed = await fetch('http://127.0.0.1:' + port + routes.responses, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + user },
        body: JSON.stringify({ input: 'cancel fixture', stream: true }),
        signal: AbortSignal.any([abortStream.signal, AbortSignal.timeout(5000)]),
      });
      try {
        const reader = streamed.body.getReader();
        let text = '';
        while (!text.includes('response.output_text.delta')) {
          const { done, value } = await reader.read();
          assert(!done);
          text += Buffer.from(value).toString();
        }
      } finally { abortStream.abort(); }
      const cancelled = await logFor('message-fixture-' + mock.bodies.length);
      assert.deepEqual([cancelled.api, cancelled.status, cancelled.attempts, cancelled.ok, cancelled.output_tokens],
        ['responses', 499, 1, false, 2]);
      assert.equal((await logs()).length, beforeStream + 1);

      const before400 = (await logs()).length;
      mock.mode = 'reject';
      const rejected = await call(routes.messages, { key: user, body: payload('messages', false) });
      assert.equal(rejected.status, 400);
      const rows = await logs();
      assert.equal(rows.length, before400 + 1);
      const row = rows[0];
      assert.deepEqual([row.api, row.status, row.attempts, row.ok], ['messages', 400, 1, false]);
    });
    assert.equal(mock.closedWaits, 6, 'each hanging HTTP producer must be cancelled once');
    assert.equal((await call('/readyz')).status, 200);
    assert.equal(gw.child.exitCode, null);
  } finally {
    await gw.stop();
    mock.server.closeAllConnections();
    await new Promise((done) => mock.server.close(done));
  }
});

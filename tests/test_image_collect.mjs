// 端到端：验证「prompt 里的 [image] 占位」与「上游 files」同序同集合
//
// 之前 collectImages 只取最后一条 user 模型，图片一旦在历史消息里 / 被拆成多条
// user 消息，prompt 有占位、files 却是空的 —— 模型只看到 [image] 文字，于是回复
// 「无法识图」。本测试用隔离实例 + 假上游，逐形状断言两者对得上。
//
// 每张图内嵌一个未压缩的 tEXt 标记（marker=XX），假上游在 upload 的 multipart
// 里能直接读出来，因此可以断言「上传顺序 == 消息里出现顺序」，而不只是数量。
import { deflateSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'e2eimg-'));

// ---- PNG：纯色 + tEXt(marker=XX) 标记 ----
function crc32(buf) {
  let t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = t[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
function makePng(size, r, g, b, marker) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0marker=${marker};`, 'latin1')),   // 未压缩，multipart 里可直接读到
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const url = (r, g, b, marker) =>
  `data:image/png;base64,${makePng(32, r, g, b, marker).toString('base64')}`;

// ---- 假上游：记录 upload 的标记顺序 + completion 的 prompt/files ----
const uploads = [];   // { marker, uuid }
const completions = [];  // { prompt, files }
let upSeq = 0;

const up = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const path = req.url || '';

    if (req.method === 'GET' && path === '/api/organizations') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ uuid: 'org-img-1111', name: 'Img Org' }]));
    }
    if (/^\/api\/organizations\/[^/]+\/chat_conversations$/.test(path) && req.method === 'POST') {
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ uuid: 'conv-1', name: 'proxy' }));
    }
    if (/^\/api\/[^/]+\/upload$/.test(path) && req.method === 'POST') {
      const m = /marker=([A-Z0-9]+);/.exec(raw.toString('latin1'));
      const uuid = 'u' + (++upSeq);
      uploads.push({ marker: m ? m[1] : '(none)', uuid });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ file_uuid: uuid, uuid }));
    }
    if (/\/completion$/.test(path) && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* noop */ }
      completions.push({ prompt: String(body.prompt || ''), files: Array.isArray(body.files) ? body.files : [] });
      const text = 'ok';
      const ev = [
        ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: body.model, content: [] } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }],
        ['message_limit', { type: 'message_limit', message_limit: { windows: { '5h': { utilization: 0.1, resets_at: Date.now() + 3600e3 } } } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      for (const [e, d] of ev) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      return res.end();
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"nf"}');
  });
});
await new Promise(r => up.listen(0, '127.0.0.1', r));
const UP = `http://127.0.0.1:${up.address().port}`;

// ---- 隔离实例 ----
const accFile = join(dir, 'accounts.json');
writeFileSync(accFile, JSON.stringify({
  strategy: 'least-loaded', perAccountConcurrency: 2, minQuotaRemaining: 0,
  accounts: [
    { id: 'i1', label: 'img', sessionKey: 'sk-img', org: 'org-img-1111',
      base: UP, enabled: true, source: 'manual', createdAt: Date.now(),
      stats: { ok: 0, fail: 0, lastUsedAt: 0, lastError: '', tokensInEst: 0, tokensOutEst: 0 }, quota: {} },
  ],
}, null, 2));
writeFileSync(join(dir, 'upstream.json'), JSON.stringify({
  web_base: UP, web_ua: 'Mozilla/5.0 Test',
  web_cookie: 'sessionKey=sk-img', web_org: 'org-img-1111', models: ['claude-sonnet-5-5'],
}, null, 2));

const KEY = 'img-collect-key';
const PORT = 8796;
const child = spawn(process.execPath, [join(HERE, '..', 'src', 'openai-proxy.mjs')], {
  cwd: join(HERE, '..'),
  env: { ...process.env, PORT: String(PORT), ACCOUNTS_FILE: accFile,
         UPSTREAM_FILE: join(dir, 'upstream.json'), USAGE_DIR: join(dir, 'usage'),
         DESKTOP_SYNC: '0', LOCAL_API_KEY: KEY, CONFIG_FILE: join(dir, 'config.json'),
         ACCOUNT_WAIT_TIMEOUT_MS: '2000', CACHE_MODE: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', d => { log += d; });
child.stderr.on('data', d => { log += d; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (cond, name) => { cond ? pass++ : (fail++, console.log('  FAIL:', name)); };
const post = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const nPh = s => (s.match(/\[image\]/g) || []).length;

/**
 * 跑一个形状，断言 files ↔ [image] 同序同集合。
 * expect = { markers: ['A','B'], around: ['[A]', '[B]'] }
 *   around 用来断言占位在 prompt 里出现的先后（占位本身无法区分，靠相邻文字定位）
 */
async function check(name, path, body, expect) {
  uploads.length = 0; completions.length = 0;
  const r = await post(path, body);
  const txt = await r.text();
  assert(r.status === 200, `${name}: HTTP 200（实际 ${r.status}）${txt.slice(0, 200)}`);
  const c = completions[completions.length - 1];
  if (!c) { assert(false, `${name}: 假上游没收到 completion`); return; }

  const want = expect.markers.length;
  assert(nPh(c.prompt) === want, `${name}: 占位数 ${nPh(c.prompt)} == ${want}`);
  assert(c.files.length === want, `${name}: files 数 ${c.files.length} == ${want}`);
  assert(uploads.map(u => u.marker).join(',') === expect.markers.join(','),
    `${name}: 上传顺序 [${uploads.map(u => u.marker)}] == [${expect.markers}]`);
  assert(c.files.join(',') === uploads.map(u => u.uuid).join(','),
    `${name}: files 与上传返回的 uuid 同序（${c.files} vs ${uploads.map(u => u.uuid)}）`);
  assert(!/上传失败/.test(c.prompt), `${name}: 没有追加「上传失败」说明`);

  // 占位出现顺序 == 图片在消息里的出现顺序
  let prev = -1, orderOk = true;
  for (const a of expect.around) {
    const i = c.prompt.indexOf(a, prev + 1);
    if (i < 0 || i < prev) { orderOk = false; break; }
    prev = i;
  }
  assert(orderOk, `${name}: 占位顺序与消息顺序一致（定位串 ${JSON.stringify(expect.around)}）`);
}

try {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.status === 200) break; } catch {}
    await sleep(250);
  }

  console.log('[1] responses：图片与文字拆成两条 user 消息（harness 常见形状）');
  await check('split', '/v1/responses', {
    model: 'claude-sonnet-5-5', stream: false,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: url(255, 0, 255, 'C1') }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[NOW] 图里是什么？' }] },
    ],
  }, { markers: ['C1'], around: ['[USER]\n[image]', '[NOW]'] });

  console.log('[2] responses：图片在历史消息里，本轮只发文字');
  await check('hist-resp', '/v1/responses', {
    model: 'claude-sonnet-5-5', stream: false,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[OLD]' }, { type: 'input_image', image_url: url(0, 255, 255, 'C2') }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '看到了' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[NOW] 再描述一次' }] },
    ],
  }, { markers: ['C2'], around: ['[OLD]\n[image]', '[NOW]'] });

  console.log('[3] chat：图片在第一条 user，最后一条是纯文字');
  await check('hist-chat', '/v1/chat/completions', {
    model: 'claude-sonnet-5-5', stream: false,
    messages: [
      { role: 'user', content: [{ type: 'text', text: '[OLD]' }, { type: 'image_url', image_url: { url: url(255, 128, 0, 'C3') } }] },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '[NOW] 里面有什么' },
    ],
  }, { markers: ['C3'], around: ['[OLD]\n[image]', '[NOW]'] });

  console.log('[4] chat：两条 user 消息各带一张图（两张都要上传且顺序对）');
  await check('two-img', '/v1/chat/completions', {
    model: 'claude-sonnet-5-5', stream: false,
    messages: [
      { role: 'user', content: [{ type: 'text', text: '[A]' }, { type: 'image_url', image_url: { url: url(255, 0, 0, 'C4A') } }] },
      { role: 'assistant', content: '第一张是红的' },
      { role: 'user', content: [{ type: 'text', text: '[B]' }, { type: 'image_url', image_url: { url: url(0, 0, 255, 'C4B') } }] },
    ],
  }, { markers: ['C4A', 'C4B'], around: ['[A]\n[image]', '[B]\n[image]'] });

  console.log('[5] messages（Anthropic）：图片在历史 user 消息');
  await check('hist-msg', '/v1/messages', {
    model: 'claude-sonnet-5-5', stream: false, max_tokens: 100,
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: makePng(32, 0, 255, 0, 'C5').toString('base64') } }] },
      { role: 'assistant', content: [{ type: 'text', text: '绿色' }] },
      { role: 'user', content: [{ type: 'text', text: '[NOW] 什么颜色' }] },
    ],
  }, { markers: ['C5'], around: ['[USER]\n[image]', '[NOW]'] });

  console.log('[6] 回归：图片就在最后一条 user 消息（旧逻辑也应正确）');
  await check('last-user', '/v1/chat/completions', {
    model: 'claude-sonnet-5-5', stream: false,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: '[NOW] 什么颜色' }, { type: 'image_url', image_url: { url: url(128, 0, 128, 'C6') } }],
    }],
  }, { markers: ['C6'], around: ['什么颜色\n[image]'] });

  console.log('[7] 回归：纯文本请求不产生占位 / files');
  {
    uploads.length = 0; completions.length = 0;
    const r = await post('/v1/chat/completions', {
      model: 'claude-sonnet-5-5', stream: false,
      messages: [{ role: 'user', content: '[PLAIN] 只有文字' }],
    });
    assert(r.status === 200, 'plain: HTTP 200');
    const c = completions[completions.length - 1];
    assert(!!c, 'plain: 收到 completion');
    assert(nPh(c.prompt) === 0, `plain: 0 个占位（实际 ${nPh(c.prompt)}）`);
    assert(c.files.length === 0, `plain: files 空（实际 ${c.files.length}）`);
    assert(uploads.length === 0, 'plain: 没有上传任何图');
  }
} catch (e) {
  fail++; console.log('  FAIL(异常):', e?.message);
} finally {
  child.kill();
  up.close();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}

if (fail) console.log('--- 服务日志尾部 ---\n' + log.slice(-2000));
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

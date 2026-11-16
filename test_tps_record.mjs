// 验证「真实输出速度」的记录是否准确
//
// 假上游：分 5 次、每 200ms 吐 40 个汉字（共 200 字 = 200 token），
//         吐完 message_stop 后把连接吊着 10 秒（模拟上游 keep-alive）。
// 期望：
//   text_tokens = 200            （中文 1 字 1 token，不是 字符/4=50）
//   write_ms   ≈ 800ms          （真正在写正文的时间）
//   tps        ≈ 200/0.8 = 250  （真实出字速度）
//   idle_ms    = 10s（SSE_END_ON_STOP=0 时）/ ≈0（=1，收到 message_stop 就收尾）
//   tps_legacy 明显低于 tps     （老口径把空闲算进了分母）
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'e2etps2-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHUNKS = 5, CHARS = 40, GAP = 200, HOLD = 10000;
const TOTAL_CHARS = CHUNKS * CHARS;

const up = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    if (req.url === '/api/organizations') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ uuid: 'org-r1', name: 'R' }]));
    }
    if (/^\/api\/organizations\/[^/]+\/chat_conversations$/.test(req.url)) {
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ uuid: 'conv-1', name: 'proxy' }));
    }
    if (/\/completion$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      const send = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [] } });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (let i = 0; i < CHUNKS; i++) {
        await sleep(GAP);
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '汉'.repeat(CHARS) } });
      }
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } });
      send('message_stop', { type: 'message_stop' });
      for (let left = HOLD; left > 0; left -= 5000) {
        await sleep(Math.min(5000, left));
        if (res.destroyed) return;
        send('ping', { type: 'ping' });
      }
      if (!res.destroyed) res.end();
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise(r => up.listen(0, '127.0.0.1', r));
const UP = `http://127.0.0.1:${up.address().port}`;

const accFile = join(dir, 'accounts.json');
writeFileSync(accFile, JSON.stringify({
  strategy: 'round-robin', perAccountConcurrency: 2, minQuotaRemaining: 0,
  accounts: [{ id: 'r1', label: 'rec', sessionKey: 'sk-r', org: 'org-r1',
    base: UP, enabled: true, source: 'manual', createdAt: Date.now(),
    stats: { ok: 0, fail: 0, lastUsedAt: 0, lastError: '', tokensInEst: 0, tokensOutEst: 0 }, quota: {} }],
}, null, 2));
writeFileSync(join(dir, 'upstream.json'), JSON.stringify({
  web_base: UP, web_ua: 'Mozilla/5.0 Test', web_cookie: 'sessionKey=sk-r',
  web_org: 'org-r1', models: ['claude-sonnet-5-5'],
}, null, 2));

const KEY = 'rec-key';
const PORT = 8798;

async function runCase(label, envExtra) {
  const usageDir = join(dir, 'usage-' + label);
  const child = spawn(process.execPath, ['openai-proxy.mjs'], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT), ACCOUNTS_FILE: accFile,
           UPSTREAM_FILE: join(dir, 'upstream.json'), USAGE_DIR: usageDir,
           DESKTOP_SYNC: '0', LOCAL_API_KEY: KEY, CONFIG_FILE: join(dir, 'config.json'),
           CACHE_MODE: 'off', ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.status === 200) break; } catch {}
    await sleep(200);
  }
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '写' }] }] }),
  });
  const j = await r.json().catch(() => ({}));
  const clientWait = Date.now() - t0;
  await sleep(400);
  child.kill();
  await sleep(200);

  // 从用量日志读回记录
  let row = null;
  try {
    const files = require('node:fs');
  } catch { /* ignore */ }
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(usageDir).filter(f => f.endsWith('.jsonl'))) {
    const lines = readFileSync(join(usageDir, f), 'utf8').trim().split('\n');
    for (const l of lines) { try { row = JSON.parse(l); } catch { /* ignore */ } }
  }
  const txt = (j.output || []).filter(o => o.type === 'message').flatMap(o => o.content || []).map(c => c.text || '').join('');
  return { label, clientWait, row, txt, usage: j.usage || {}, log };
}

let pass = 0, fail = 0;
const assert = (c, n, extra = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, extra)); };

const oldWay = await runCase('hold', { SSE_END_ON_STOP: '0' });
const newWay = await runCase('cut', { SSE_END_ON_STOP: '1' });

for (const c of [oldWay, newWay]) {
  console.log(`\n[${c.label}] 客户端等待 ${(c.clientWait / 1000).toFixed(1)}s  usage.output_tokens=${c.usage.output_tokens}`);
  const r = c.row;
  if (!r) { assert(false, `${c.label}: 没有用量记录`); continue; }
  console.log(`  text_tokens=${r.text_tokens} think_tokens=${r.think_tokens} output_tokens=${r.output_tokens}`);
  console.log(`  ttfb=${r.ttfb_ms}ms  think=${r.think_ms}ms  write=${r.write_ms}ms  gen=${r.gen_ms}ms  idle=${r.idle_ms}ms`);
  console.log(`  tps=${r.tps}  tps_e2e=${r.tps_e2e}  tps_legacy=${r.tps_legacy}`);
  assert(c.txt.length === TOTAL_CHARS, `${c.label}: 正文 ${TOTAL_CHARS} 字`);
  assert(r.text_tokens === TOTAL_CHARS, `${c.label}: text_tokens=${r.text_tokens}（中文 1 字 1 token，应为 ${TOTAL_CHARS}）`);
  assert(r.write_ms >= GAP * (CHUNKS - 1) - 120 && r.write_ms <= GAP * (CHUNKS - 1) + 400,
    `${c.label}: write_ms=${r.write_ms}（应≈${GAP * (CHUNKS - 1)}）`);
  const expectTps = TOTAL_CHARS / (r.write_ms / 1000);
  assert(Math.abs(r.tps - expectTps) < 1, `${c.label}: tps=${r.tps} 应=正文token/书写秒=${expectTps.toFixed(1)}`);
  assert(r.tps > 150, `${c.label}: 真实速度应 >150 tok/s（实际 ${r.tps}）`);
  assert(c.usage.output_tokens === TOTAL_CHARS, `${c.label}: 客户端拿到的 output_tokens=${c.usage.output_tokens}（应 ${TOTAL_CHARS}）`);
}

console.log('\n--- 收尾空闲 ---');
assert(oldWay.row.idle_ms >= HOLD - 1500, `旧行为 idle_ms=${oldWay.row.idle_ms}（应≈${HOLD}）`);
assert(oldWay.row.tps_legacy < oldWay.row.tps / 5, `旧行为老口径被拖低（${oldWay.row.tps_legacy} vs ${oldWay.row.tps}）`);
assert(newWay.row.idle_ms <= 1500, `新行为 idle_ms=${newWay.row.idle_ms}（应≈0，已收尾）`);
assert(newWay.clientWait < oldWay.clientWait / 2, `新行为客户端等待更短（${(newWay.clientWait / 1000).toFixed(1)}s vs ${(oldWay.clientWait / 1000).toFixed(1)}s）`);

up.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

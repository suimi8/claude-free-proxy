// 验证「上游吊着连接」对「输出速度(TPS)」的影响，以及修复是否有效
//
// 场景：上游把内容发完（258 token ≈ 4 秒）后不关连接，吊着 30 秒才关。
//  - 旧行为（等 EOF）：客户端被吊 30 秒 -> TPS = 258/30 ≈ 8.6 tok/s（虚低）
//  - 新行为（收到 message_stop 就收尾）：客户端立刻拿到完整回复 -> TPS 回到 ~65
// 用 SSE_END_ON_STOP=0/1 在同一份代码上做 A/B。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'e2etps-'));
const HOLD_MS = 30000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 假上游：发完内容后把连接吊着 HOLD_MS ----
const completions = [];
const up = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    if (req.url === '/api/organizations') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ uuid: 'org-tps-1', name: 'TPS Org' }]));
    }
    if (/^\/api\/organizations\/[^/]+\/chat_conversations$/.test(req.url)) {
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ uuid: 'conv-1', name: 'proxy' }));
    }
    if (/\/completion$/.test(req.url)) {
      let body = {}; try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* noop */ }
      completions.push({ prompt: body.prompt, effort: body.effort, at: Date.now() });
      // 一段像样的正文（约 1000 字符 ≈ 258 token）
      const text = '深夜的地铁末班车像一条缓慢爬行的铁甲虫，灯光在隧道壁上一下一下地抹过去。'.repeat(14);
      const events = [
        ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: body.model, content: [] } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }],
        ['message_limit', { type: 'message_limit', message_limit: { windows: { '5h': { utilization: 0.1, resets_at: Date.now() + 3600e3 } } } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      for (const [ev, d] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
      // 内容发完，连接吊着不关
      for (let left = HOLD_MS; left > 0; left -= 15000) {
        await sleep(Math.min(15000, left));
        if (res.destroyed) return;
        res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);
      }
      if (!res.destroyed) res.end();
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise(r => up.listen(0, '127.0.0.1', r));
const UP = `http://127.0.0.1:${up.address().port}`;

// ---- 隔离实例 ----
const accFile = join(dir, 'accounts.json');
writeFileSync(accFile, JSON.stringify({
  strategy: 'round-robin', perAccountConcurrency: 2, minQuotaRemaining: 0,
  accounts: [{ id: 't1', label: 'tps', sessionKey: 'sk-tps', org: 'org-tps-1',
    base: UP, enabled: true, source: 'manual', createdAt: Date.now(),
    stats: { ok: 0, fail: 0, lastUsedAt: 0, lastError: '', tokensInEst: 0, tokensOutEst: 0 }, quota: {} }],
}, null, 2));
writeFileSync(join(dir, 'upstream.json'), JSON.stringify({
  web_base: UP, web_ua: 'Mozilla/5.0 Test', web_cookie: 'sessionKey=sk-tps',
  web_org: 'org-tps-1', models: ['claude-sonnet-5-5'],
}, null, 2));

const KEY = 'tps-key';
const PORT = 8797;

async function runCase(label, envExtra) {
  const child = spawn(process.execPath, ['openai-proxy.mjs'], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT), ACCOUNTS_FILE: accFile,
           UPSTREAM_FILE: join(dir, 'upstream.json'), USAGE_DIR: join(dir, 'usage'),
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
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '写一段话' }] }] }),
  });
  const j = await r.json().catch(() => ({}));
  const clientWait = Date.now() - t0;
  const txt = (j.output || []).filter(o => o.type === 'message').flatMap(o => o.content || []).map(c => c.text || '').join('');
  const usage = j.usage || {};
  child.kill();
  await sleep(300);
  return { label, clientWait, textLen: txt.length, usage, log };
}

let pass = 0, fail = 0;
const assert = (c, n) => { c ? pass++ : (fail++, console.log('  FAIL:', n)); };

console.log(`假上游：内容发完后把连接吊 ${HOLD_MS / 1000}s 才关\n`);

const old = await runCase('旧行为(等 EOF)', { SSE_END_ON_STOP: '0' });
console.log(`[旧行为] 客户端等待 ${(old.clientWait / 1000).toFixed(1)}s  可见 ${old.textLen}字  usage.out=${old.usage.output_tokens}`);
const oldTps = old.usage.output_tokens / ((old.clientWait / 1000) || 1);
console.log(`         客户端视角 TPS = ${oldTps.toFixed(1)} tok/s`);

const neu = await runCase('新行为(message_stop 即收尾)', { SSE_END_ON_STOP: '1' });
console.log(`[新行为] 客户端等待 ${(neu.clientWait / 1000).toFixed(1)}s  可见 ${neu.textLen}字  usage.out=${neu.usage.output_tokens}`);
const newTps = neu.usage.output_tokens / ((neu.clientWait / 1000) || 1);
console.log(`         客户端视角 TPS = ${newTps.toFixed(1)} tok/s`);

console.log('');
assert(old.clientWait >= HOLD_MS * 0.8, `旧行为确实被吊住（${(old.clientWait / 1000).toFixed(1)}s）`);
assert(neu.clientWait <= HOLD_MS * 0.4, `新行为不再被吊（${(neu.clientWait / 1000).toFixed(1)}s）`);
assert(neu.textLen === old.textLen, '两种行为拿到的正文一样长');
assert(newTps > oldTps * 3, `TPS 提升 ${oldTps.toFixed(1)} -> ${newTps.toFixed(1)}`);

up.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

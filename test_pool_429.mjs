// 验证「429 额度耗尽池 / 有效池」的分离与自动恢复
//
// 场景：3 个账号
//   A：上游回 429 exceeded_limit（带 resetsAt = now+120s）-> 应进 429 耗尽池
//   B：正常
//   C：正常
// 期望：
//   [1] 请求 failover 到 B/C 成功（不能因为 A 429 就整池挂掉）
//   [2] A 进耗尽池，restore 时刻 = 上游给的 resetsAt（不是 1m/3m/10m 阶梯）
//   [3] A 之后的请求不再被选中（不"胡乱调用"）
//   [4] resetsAt 到了之后，A 自动回到有效池、重新参与调度
//   [5] 并发型 429（resetsAt=null）不进耗尽池，只短暂冷却
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'e2e429-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MOCK_PORT = 8799;
const RESETS_IN = 15;                 // A 号配额窗口 15 秒后恢复（等真实到期，验证自动回池）
const resetsAtSec = Math.floor(Date.now() / 1000) + RESETS_IN;

// ---- 拉起 mock 上游：A 号配额耗尽 ----
const mock = spawn(process.execPath, ['mock_claude.mjs'], {
  cwd: HERE,
  env: { ...process.env, PORT: String(MOCK_PORT), FAKE_RATELIMIT: 'sk-a', FAKE_RESETS_AT: String(resetsAtSec) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let mockLog = '';
mock.stdout.on('data', d => { mockLog += d; });
mock.stderr.on('data', d => { mockLog += d; });
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/__stats`); if (r.status === 200) break; } catch {}
  await sleep(200);
}

// ---- 隔离实例：3 个账号 ----
const accFile = join(dir, 'accounts.json');
writeFileSync(accFile, JSON.stringify({
  strategy: 'round-robin', perAccountConcurrency: 2, minQuotaRemaining: 0,
  accounts: [
    { id: 'a1', label: 'A-耗尽', sessionKey: 'sk-a', org: 'org-a', base: `http://127.0.0.1:${MOCK_PORT}`,
      enabled: true, source: 'manual', createdAt: Date.now(),
      stats: { ok: 0, fail: 0, lastUsedAt: 0, lastError: '', tokensInEst: 0, tokensOutEst: 0 }, quota: {} },
    { id: 'b1', label: 'B-正常', sessionKey: 'sk-b', org: 'org-b', base: `http://127.0.0.1:${MOCK_PORT}`,
      enabled: true, source: 'manual', createdAt: Date.now(),
      stats: { ok: 0, fail: 0, lastUsedAt: 0, lastError: '', tokensInEst: 0, tokensOutEst: 0 }, quota: {} },
    { id: 'c1', label: 'C-正常', sessionKey: 'sk-c', org: 'org-c', base: `http://127.0.0.1:${MOCK_PORT}`,
      enabled: true, source: 'manual', createdAt: Date.now(),
      stats: { ok: 0, fail: 0, lastUsedAt: 0, lastError: '', tokensInEst: 0, tokensOutEst: 0 }, quota: {} },
  ],
}, null, 2));
writeFileSync(join(dir, 'upstream.json'), JSON.stringify({
  web_base: `http://127.0.0.1:${MOCK_PORT}`, web_ua: 'Mozilla/5.0 Test',
  web_cookie: 'sessionKey=sk-b', web_org: 'org-b', models: ['claude-sonnet-5-5'],
}, null, 2));

const KEY = 'p429';
const PORT = 8795;
const child = spawn(process.execPath, ['openai-proxy.mjs'], {
  cwd: HERE,
  env: { ...process.env, PORT: String(PORT), ACCOUNTS_FILE: accFile,
         UPSTREAM_FILE: join(dir, 'upstream.json'), USAGE_DIR: join(dir, 'usage'),
         DESKTOP_SYNC: '0', LOCAL_API_KEY: KEY, CONFIG_FILE: join(dir, 'config.json'),
         CACHE_MODE: 'off', ACCOUNT_WAIT_TIMEOUT_MS: '2000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });

const get = p => fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { authorization: `Bearer ${KEY}` } });
const post = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let pass = 0, fail = 0;
const assert = (c, n, extra = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, extra)); };

const chat = () => post('/v1/chat/completions', {
  model: 'claude-sonnet-5-5', stream: false,
  messages: [{ role: 'user', content: 'hi' }],
});

try {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.status === 200) break; } catch {}
    await sleep(200);
  }

  console.log('[1] 首次请求：A 撞 429，应 failover 到 B/C 成功');
  {
    const r = await chat();
    const j = await r.json().catch(() => ({}));
    assert(r.status === 200, `请求成功（实际 ${r.status}）`, JSON.stringify(j).slice(0, 200));
  }

  console.log('[2] A 进入 429 耗尽池，恢复时刻 = 上游 resetsAt');
  {
    const st = await (await get('/v1/accounts')).json();
    const a = st.accounts.find(x => x.id === 'a1');
    console.log(`  A: exhausted=${a.exhausted} pool=${a.pool} until=${a.exhausted_until} reason=${a.exhausted_reason} in=${a.exhausted_restore_in_s}s`);
    console.log(`  池: 有效=${st.valid_pool} 耗尽=${st.exhausted_pool} 最近恢复=${st.next_restore_at ? new Date(st.next_restore_at).toISOString() : '-'}`);
    assert(a.exhausted === true, 'A 被标记为耗尽');
    assert(a.pool === 'exhausted', 'A 的 pool=exhausted');
    assert(st.exhausted_pool === 1, `耗尽池 1 个（实际 ${st.exhausted_pool}）`);
    assert(st.valid_pool === 2, `有效池 2 个（实际 ${st.valid_pool}）`);
    const expectUntil = resetsAtSec * 1000;
    assert(Math.abs(a.exhausted_until - expectUntil) < 2000,
      `恢复时刻=${a.exhausted_until} 应≈${expectUntil}（上游 resetsAt）`);
    assert(a.exhausted_restore_in_s > 60 && a.exhausted_restore_in_s <= RESETS_IN + 5,
      `剩余恢复时间 ${a.exhausted_restore_in_s}s 在 120s 附近`);
    assert(!!a.exhausted_reason, `耗尽原因已记录（${a.exhausted_reason}）`);
  }

  console.log('[3] A 不再被选中（不胡乱调用）');
  {
    const before = (await (await get('/v1/accounts')).json()).accounts.find(x => x.id === 'a1');
    for (let i = 0; i < 6; i++) { await chat(); await sleep(120); }
    const after = (await (await get('/v1/accounts')).json()).accounts.find(x => x.id === 'a1');
    console.log(`  A 的 ok 计数 ${before.ok} -> ${after.ok}`);
    assert(after.ok === before.ok, 'A 的成功次数没涨（没再被选中）');
    assert(after.fail === before.fail, 'A 的失败次数没涨（没再被撞）');
  }

  console.log('[4] resetsAt 到了 -> 自动回到有效池（等真实窗口到期）');
  {
    // 不去改 accounts.json：池自己也在写这个文件，改了会被覆盖。
    // 直接等上游给的 resetsAt（这里设的 15 秒）真的到期，验证自动回池。
    let a = null, st = null;
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      st = await (await get('/v1/accounts')).json();
      a = st.accounts.find(x => x.id === 'a1');
      if (!a.exhausted) break;
    }
    console.log(`  用了 ${((Date.now() - t0) / 1000).toFixed(1)}s  A: exhausted=${a.exhausted} pool=${a.pool}`);
    assert(a.exhausted === false, 'A 已退出耗尽池');
    assert(a.pool === 'valid', 'A 回到有效池');
    assert(st.exhausted_pool === 0, `耗尽池清空（实际 ${st.exhausted_pool}）`);
    assert(st.valid_pool === 3, `有效池 3 个（实际 ${st.valid_pool}）`);
    assert(/回到有效池/.test(log), '日志里有「回到有效池」提示');
  }

  console.log('[5] 普通 429（没有精确 resetsAt）不进耗尽池，只短暂冷却');
  {
    // 只留 C 号，避免轮询选不到
    await fetch(`http://127.0.0.1:${PORT}/v1/accounts/a1`, {
      method: 'PATCH', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    await fetch(`http://127.0.0.1:${PORT}/v1/accounts/b1`, {
      method: 'PATCH', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    // sk-c 返回普通 429（没有 exceeded_limit 结构 -> 没有 resetsAt）
    await fetch(`http://127.0.0.1:${MOCK_PORT}/__config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rateLimit: [], bad: ['sk-c'] }),
    });
    await chat();
    await sleep(200);
    const st = await (await get('/v1/accounts')).json();
    const c = st.accounts.find(x => x.id === 'c1');
    console.log(`  C: exhausted=${c.exhausted} cooldown=${c.cooldown_remaining_s}s last_error=${String(c.last_error).slice(0, 70)}`);
    assert(c.exhausted === false, 'C 没有进耗尽池（没有精确 resetsAt）');
    assert(c.cooldown_remaining_s > 0, `C 处于冷却中（${c.cooldown_remaining_s}s）`);
  }
} catch (e) {
  fail++; console.log('  FAIL(异常):', e?.message);
} finally {
  child.kill(); mock.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}

if (fail) console.log('--- 服务日志尾部 ---\n' + log.slice(-2500));
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

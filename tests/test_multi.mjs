/**
 * test_multi.mjs —— 多账号池的确定性验证（对 mock 上游，自包含）
 *
 * 自己拉起 mock 上游 + 反代，用一份临时 accounts.json（2 个账号，都指向 mock）。
 *
 * 覆盖：
 *   [1] 轮询分布：2 个账号各拿一半请求
 *   [2] 并发进行：12 个并发全部成功且摊到 2 个账号
 *   [3] 账号管理端点：list / disable / enable / eligible 计数
 *   [4] failover：把 A 的 sessionKey 改成坏值（热加载）-> 请求仍成功
 *   [5] 冷却：A 进入冷却后不再被打到
 *   [6] 全挂：两个账号都坏 -> 返回 429 而不是挂死
 *   [7] tools 流式在多账号下正常（finish_reason=tool_calls）
 *   [8] 客户端断连：立即中止上游并归还并发额度（不记失败、不冷却）
 *   [9] WebUI 托管 + 额度低于 20% 自动切换账号
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = '8799';
const PX_PORT = '8798';
const BASE = `http://127.0.0.1:${PX_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const H = { authorization: 'Bearer sk-local', 'content-type': 'application/json' };

const ACCT_FILE = path.join(HERE, 'accounts.test.json');
const results = [];
const kids = [];

function ok(name, pass, detail = '') {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
}

function start(cmd, args, env, tag) {
  const p = spawn(cmd, args, { cwd: path.join(HERE, '..'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', d => { log += d; });
  p.stderr.on('data', d => { log += d; });
  p.getLog = () => log;
  p.tag = tag;
  kids.push(p);
  return p;
}

async function waitHttp(url, headers, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return await r.json().catch(() => ({}));
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

async function chat(body) {
  const t = Date.now();
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: H, body: JSON.stringify(body),
    });
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { /* stream */ }
    return { status: r.status, json, text: txt, secs: (Date.now() - t) / 1000 };
  } catch (e) {
    return { status: -1, json: null, text: e.message, secs: (Date.now() - t) / 1000 };
  }
}

const msg = content => ({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content }] });
const accounts = async () => (await fetch(`${BASE}/v1/accounts`, { headers: H })).json();
const mockStats = async () => (await fetch(`${MOCK}/__stats`)).json();

function writeAccounts(mutate) {
  const d = JSON.parse(fs.readFileSync(ACCT_FILE, 'utf8'));
  mutate(d);
  fs.writeFileSync(ACCT_FILE, JSON.stringify(d, null, 2));
}

async function main() {
  // ---- 准备：临时账号文件（2 个账号，都指向 mock）
  const BAD_KEY = 'sk-ant-sid02-ACCOUNT_A_IS_BAD';
  const A_KEY = 'sk-ant-sid02-ACCOUNT_A_OK';
  const B_KEY = 'sk-ant-sid02-ACCOUNT_B_OK';
  fs.writeFileSync(ACCT_FILE, JSON.stringify({
    version: 1,
    strategy: 'round-robin',
    perAccountConcurrency: 2,
    accounts: [
      { id: 'acc-a', label: 'acc-a', sessionKey: A_KEY, org: 'org-aaaaaa', base: MOCK, ua: 'mock-ua', enabled: true, source: 'manual' },
      { id: 'acc-b', label: 'acc-b', sessionKey: B_KEY, org: 'org-bbbbbb', base: MOCK, ua: 'mock-ua', enabled: true, source: 'manual' },
    ],
  }, null, 2));

  const mock = start('node', [path.join(HERE, 'mock_claude.mjs')], { PORT: MOCK_PORT, FAKE_LATENCY_MS: '120' }, 'mock');
  const px = start('node', [path.join(HERE, '..', 'src', 'openai-proxy.mjs')], {
    PORT: PX_PORT,
    LOCAL_API_KEY: 'sk-local',
    ACCOUNTS_FILE: ACCT_FILE,
    ACCOUNT_WAIT_TIMEOUT_MS: '5000',
    MAX_FAILOVER: '3',
    // 关掉 Desktop 自动同步，避免它把 mock 账号覆盖掉
    UPSTREAM_FILE: path.join(HERE, 'upstream.nonexistent.json'),
    DESKTOP_SYNC: '0',
  }, 'proxy');

  const health = await waitHttp(`${BASE}/healthz`, H);
  if (!health) {
    ok('反代启动', false, px.getLog().slice(0, 800));
    return finish();
  }
  ok('反代启动 + 2 账号加载', health.pool?.total === 2,
    `strategy=${health.pool?.strategy} total=${health.pool?.total} eligible=${health.pool?.eligible_now}`);

  // ---- [1] 轮询分布
  {
    const before = await mockStats();
    let fail = 0;
    for (let i = 0; i < 8; i++) {
      const r = await chat(msg(`ping ${i}`));
      if (r.status !== 200) { fail++; if (fail === 1) ok('轮询分布', false, `http=${r.status} ${r.text.slice(0, 200)}`); }
    }
    const after = await mockStats();
    const delta = {};
    for (const k of [A_KEY, B_KEY]) delta[k.slice(-9)] = (after.byAccount[k] || 0) - (before.byAccount[k] || 0);
    const vals = Object.values(delta);
    ok('轮询分布（8 请求摊到 2 账号）', fail === 0 && vals.length === 2 && Math.abs(vals[0] - vals[1]) <= 1,
      `fail=${fail} dist=${JSON.stringify(delta)}`);
  }

  // ---- [2] 并发进行（mock 有 120ms 延迟，能看出真实在途数）
  {
    const before = await mockStats();
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => chat(msg(`burst ${i}`))));
    const bad = rs.filter(r => r.status !== 200);
    const after = await mockStats();
    const dist = {};
    for (const k of [A_KEY, B_KEY]) dist[k.slice(-9)] = (after.byAccount[k] || 0) - (before.byAccount[k] || 0);
    const spread = Object.values(dist).filter(v => v > 0).length === 2;
    // 每账号上限 2 -> 全池最多 4 个在途
    const capped = after.maxConcurrent <= 4;
    ok('并发进行（12 并发全成功 + 摊到 2 账号 + 上限生效）',
      bad.length === 0 && spread && after.maxConcurrent >= 2 && capped,
      `fail=${bad.length} dist=${JSON.stringify(dist)} maxConcurrent=${after.maxConcurrent} (cap=4)`);
  }

  // ---- [3] 账号管理端点
  {
    let st = await accounts();
    ok('GET /v1/accounts', st.total === 2 && st.accounts[0].session_key.includes('...'),
      `total=${st.total} masked=${st.accounts[0].session_key}`);

    await fetch(`${BASE}/v1/accounts/acc-b`, { method: 'PATCH', headers: H, body: JSON.stringify({ enabled: false }) });
    st = await accounts();
    ok('PATCH disable', st.accounts.find(a => a.id === 'acc-b').enabled === false && st.eligible_now === 1,
      `eligible=${st.eligible_now}`);

    const r = await chat(msg('single'));
    ok('单账号仍可用', r.status === 200, `http=${r.status}`);

    await fetch(`${BASE}/v1/accounts/acc-b`, { method: 'PATCH', headers: H, body: JSON.stringify({ enabled: true }) });
    st = await accounts();
    ok('PATCH enable 恢复', st.eligible_now === 2, `eligible=${st.eligible_now}`);

    // 新增账号：org 自动发现（mock 的 /api/organizations）
    const addR = await fetch(`${BASE}/v1/accounts`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ label: 'acc-c', sessionKey: 'sk-ant-sid02-ACCOUNT_C_NEW', base: MOCK }),
    });
    const addJ = await addR.json();
    ok('POST /v1/accounts + org 自动发现', addR.status === 201 && addJ.account?.org?.startsWith('org-'),
      `http=${addR.status} org=${addJ.account?.org} ${addJ.error?.message || ''}`);

    await fetch(`${BASE}/v1/accounts/${addJ.account?.id}`, { method: 'DELETE', headers: H });
    st = await accounts();
    ok('DELETE /v1/accounts', st.total === 2, `total=${st.total}`);
  }

  // ---- [3b] accounts.json 手工编辑热加载（不重启）
  {
    writeAccounts(d => { d.accounts.find(a => a.id === 'acc-a').label = 'acc-a-renamed'; });
    let loaded = false;
    for (let i = 0; i < 24; i++) {
      const st = await accounts();
      if (st.accounts.find(a => a.id === 'acc-a')?.label === 'acc-a-renamed') { loaded = true; break; }
      await new Promise(r => setTimeout(r, 300));
    }
    ok('accounts.json 热加载（改 label 无需重启）', loaded);
    const r = await chat(msg('after reload'));
    ok('热加载后仍可服务', r.status === 200, `http=${r.status}`);
  }

  // ---- [4][5] failover + 冷却（通过 mock 注入 429，不动账号文件）
  {
    const cfg = await fetch(`${MOCK}/__config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bad: [A_KEY] }),
    }).then(r => r.json());
    ok('mock 注入：账号 A 返回 429', cfg.bad?.includes(A_KEY), `bad=${cfg.bad?.length}`);

    const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => chat(msg(`failover ${i}`))));
    const bad = rs.filter(r => r.status !== 200);
    ok('failover：坏账号 429 时请求仍成功', bad.length === 0,
      `fail=${bad.length}/${rs.length} ${bad[0] ? bad[0].text.slice(0, 200) : ''}`);

    const st = await accounts();
    const badAcct = st.accounts.find(a => a.id === 'acc-a');
    ok('坏账号进入冷却', (badAcct?.cooldown_remaining_s || 0) > 0,
      `cooldown=${badAcct?.cooldown_remaining_s}s streak=${badAcct?.fail_streak} err=${(badAcct?.last_error || '').slice(0, 70)}`);

    const before = await mockStats();
    for (let i = 0; i < 4; i++) await chat(msg(`cooldown ${i}`));
    const after = await mockStats();
    const hits = (after.byAccount[A_KEY] || 0) - (before.byAccount[A_KEY] || 0);
    ok('冷却期内不再打坏账号', hits === 0, `bad hits=${hits}`);

    // 清掉故障注入 -> 账号自然恢复
    await fetch(`${MOCK}/__config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bad: [] }),
    });
  }

  // ---- [6] 全挂 -> 429 而不是挂死
  {
    await fetch(`${MOCK}/__config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bad: [A_KEY, B_KEY] }),
    });
    // 等 A 的冷却过期不太现实，直接把两个账号都标成 429，
    // 新请求会先打到还没冷却的 B -> 429 -> 冷却 -> 然后全部冷却
    const t = Date.now();
    let last = null;
    for (let i = 0; i < 3; i++) last = await chat(msg('all dead'));
    const secs = (Date.now() - t) / 1000;
    ok('全挂返回 429（不挂死）', last.status === 429 && secs < 20,
      `http=${last.status} ${secs.toFixed(1)}s ${last.text.slice(0, 180)}`);

    // 清故障 -> 等冷却过期后恢复（rate_limit 第一档 60s，这里直接把冷却清零）
    await fetch(`${MOCK}/__config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bad: [] }),
    });
    const st = await accounts();
    for (const a of st.accounts) {
      await fetch(`${BASE}/v1/accounts/${a.id}`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ cooldownUntil: 0, enabled: true }),
      });
    }
    const back = await chat(msg('recovered'));
    ok('恢复后重新可用', back.status === 200, `http=${back.status} ${back.text.slice(0, 80)}`);
  }

  // ---- [7] tools 流式在多账号下正常
  {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5', stream: true,
        messages: [{ role: 'user', content: '天气 TOOL' }],
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'x', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      }),
    });
    const txt = await r.text();
    const evs = [...txt.matchAll(/data: (.+)/g)].map(m => m[1]);
    const objs = evs.filter(c => c !== '[DONE]').map(c => { try { return JSON.parse(c); } catch { return null; } }).filter(Boolean);
    const finish = objs.find(c => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason;
    const args = objs.flatMap(c => c.choices?.[0]?.delta?.tool_calls || []).map(x => x.function?.arguments || '').join('');
    ok('多账号下流式 tools', finish === 'tool_calls' && args.includes('广州') && evs.includes('[DONE]'),
      `finish=${finish} args=${args} DONE=${evs.includes('[DONE]')}`);
  }

  // ---- [8] 客户端断连：立即中止上游、归还并发额度，且不记失败/不冷却
  {
    const inflight = async () => {
      const st = await accounts();
      return st.accounts.reduce((s, a) => s + a.inflight, 0);
    };
    const waitInflight = async (target, maxMs) => {
      const t = Date.now();
      for (;;) {
        const n = await inflight();
        if (n === target) return Date.now() - t;
        if (Date.now() - t > maxMs) return -1;
        await new Promise(r => setTimeout(r, 100));
      }
    };
    const cfg = body => fetch(`${MOCK}/__config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const fire = () => {
      const ac = new AbortController();
      const p = fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST', headers: H, signal: ac.signal,
        body: JSON.stringify({ ...msg('abort marker'), stream: true }),
      }).catch(() => null);
      return { ac, p };
    };

    const st0 = await accounts();
    const fail0 = st0.accounts.reduce((s, a) => s + a.fail, 0);

    // [8a] 上游还没回（延迟 2000ms）就断开：必须在远早于 2000ms 内归还
    await cfg({ latency: 2000, streamDelay: 0 });
    const r1 = fire();
    const held1 = await waitInflight(1, 3000);
    r1.ac.abort();
    const rel1 = await waitInflight(0, 1200);   // 自然完成要等满 2000ms，>1200ms 即视为没中止
    await r1.p;
    ok('[8a] 断连（上游未响应阶段）立即释放 inflight', held1 >= 0 && rel1 >= 0,
      `held=${held1}ms release=${rel1}ms（自然完成需 ≥2000ms）`);
    if (rel1 < 0) await waitInflight(0, 4000);   // 失败时兜底等自然完成，别污染下一条

    // [8b] 流式进行中断开（慢速流式 300ms/事件，全程约 2.7s）
    await cfg({ latency: 0, streamDelay: 300 });
    const r2 = fire();
    const held2 = await waitInflight(1, 3000);
    await new Promise(r => setTimeout(r, 600));   // 确认已进入流式吐字阶段
    r2.ac.abort();
    const rel2 = await waitInflight(0, 1000);     // 自然完成还有 ~1.9s
    await r2.p;
    ok('[8b] 断连（流式中途）立即释放 inflight', held2 >= 0 && rel2 >= 0,
      `held=${held2}ms release=${rel2}ms（自然完成还有 ~1900ms）`);
    if (rel2 < 0) await waitInflight(0, 4000);

    // [8c] 断连不算账号失败，也不进冷却
    const st1 = await accounts();
    const fail1 = st1.accounts.reduce((s, a) => s + a.fail, 0);
    const cooling = st1.accounts.filter(a => a.cooldown_remaining_s > 0);
    ok('[8c] 断连不记失败、不进冷却', fail1 === fail0 && cooling.length === 0,
      `fail ${fail0}->${fail1} cooling=${cooling.map(a => a.label).join(',') || '-'}`);

    // 恢复 mock 延迟并确认账号还能用
    await cfg({ latency: 120, streamDelay: 0 });
    const rec = await chat(msg('after abort'));
    ok('[8d] 断连后账号立即可用', rec.status === 200, `http=${rec.status} ${rec.text.slice(0, 60)}`);
  }

  // ---- [9] WebUI 托管 + 额度低于阈值自动切换
  {
    // UI 页面：根路径与 /ui 都返回 HTML（页面免鉴权，本机直开）
    const ui1 = await fetch(`${BASE}/`);
    const ui2 = await fetch(`${BASE}/ui`);
    const html = await ui1.text();
    ok('[9a] WebUI 托管在反代进程', ui1.status === 200 && ui2.status === 200 &&
      /text\/html/.test(ui1.headers.get('content-type') || '') && html.includes('Claude Proxy 控制台'),
      `http=${ui1.status}/${ui2.status}`);

    // 让 A 的 5h 用量上报为 95%（剩 5% < 20%）
    await fetch(`${MOCK}/__config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quotaBy: { [A_KEY]: 0.95 } }),
    });
    // 轮询下两个请求必有一个落到 A -> A 拿到 message_limit
    await chat(msg('quota warm 1'));
    await chat(msg('quota warm 2'));
    let st = await accounts();
    const accA = st.accounts.find(a => a.id === 'acc-a');
    ok('[9b] A 上报额度 95%（剩5%）', accA?.quota_5h != null &&
      Math.abs((accA.quota_remaining ?? 0) - 0.05) < 0.011,
      `remaining=${accA?.quota_remaining} low=${accA?.low_quota}`);
    ok('[9c] A 被标记 low_quota（阈值 20%）', accA?.low_quota === true && st.min_quota_remaining === 0.2,
      `thr=${st.min_quota_remaining}`);

    // 后续 4 个请求应全部绕开 A、落在 B
    const before = await mockStats();
    for (let i = 0; i < 4; i++) await chat(msg(`quota skip ${i}`));
    const after = await mockStats();
    const hitsA = (after.byAccount[A_KEY] || 0) - (before.byAccount[A_KEY] || 0);
    const hitsB = (after.byAccount[B_KEY] || 0) - (before.byAccount[B_KEY] || 0);
    ok('[9d] 剩5%的账号被切走（4 连发全到 B）', hitsA === 0 && hitsB === 4,
      `A+${hitsA} B+${hitsB}`);

    // 阈值调 0 -> A 恢复参与轮询
    const cfg = await fetch(`${BASE}/v1/pool`, {
      method: 'POST', headers: H, body: JSON.stringify({ minQuotaRemaining: 0 }),
    }).then(r => r.json());
    st = await accounts();
    const accA2 = st.accounts.find(a => a.id === 'acc-a');
    const before2 = await mockStats();
    await chat(msg('quota rejoin'));
    const after2 = await mockStats();
    const rejoined = ((after2.byAccount[A_KEY] || 0) - (before2.byAccount[A_KEY] || 0)) > 0;
    ok('[9e] 阈值 0 关闭切换后 A 恢复轮询', cfg.min_quota_remaining === 0 &&
      accA2?.low_quota === false && rejoined,
      `thr=${cfg.min_quota_remaining} low=${accA2?.low_quota} A命中=${rejoined}`);

    // 恢复现场：阈值 0.2、清 quotaBy
    await fetch(`${BASE}/v1/pool`, { method: 'POST', headers: H, body: JSON.stringify({ minQuotaRemaining: 0.2 }) });
    await fetch(`${MOCK}/__config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quotaBy: {} }),
    });
  }

  // ---- 策略切换
  {
    const r = await fetch(`${BASE}/v1/pool`, { method: 'POST', headers: H, body: JSON.stringify({ strategy: 'least-loaded' }) });
    const j = await r.json();
    const st = await accounts();
    ok('POST /v1/pool 切换策略', r.status === 200 && st.strategy === 'least-loaded', `strategy=${st.strategy}`);

    // 验证 least-loaded 会偏向用量低的账号
    const before = await mockStats();
    for (let i = 0; i < 6; i++) await chat(msg(`least ${i}`));
    const after = await mockStats();
    const dist = {};
    for (const k of [A_KEY, B_KEY]) dist[k.slice(-9)] = (after.byAccount[k] || 0) - (before.byAccount[k] || 0);
    const vals = Object.values(dist);
    ok('least-loaded 可用', vals.some(v => v > 0), `dist=${JSON.stringify(dist)}`);

    await fetch(`${BASE}/v1/pool`, { method: 'POST', headers: H, body: JSON.stringify({ strategy: 'round-robin' }) });
  }

  return finish();
}

function finish() {
  for (const k of kids) { try { k.kill(); } catch { /* noop */ } }
  try { fs.unlinkSync(ACCT_FILE); } catch { /* noop */ }
  try { fs.unlinkSync(ACCT_FILE + '.bak'); } catch { /* noop */ }
  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.log(results.join('\n'));
  console.error('ERR', e);
  for (const k of kids) { try { k.kill(); } catch { /* noop */ } }
  process.exit(1);
});

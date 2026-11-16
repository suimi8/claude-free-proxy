/**
 * test_accounts.mjs —— 账号池冷却档位的单元验证（不联网、不起服务）
 *
 * 覆盖“每类错误独立计数”语义（429 根因修复之一）：
 *   - concurrency 自己的阶梯 3s/10s/30s
 *   - transient / rate_limit 不被 concurrency 的连续失败顶档
 *   - 成功一次后所有类别的 streak 清零
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountPool } from '../src/accounts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, `accounts.unit.${process.pid}.json`);

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
}

try {
  const pool = new AccountPool(TMP);
  const { account: a } = pool.add({ sessionKey: 'sk-ant-sid01-UNIT_TEST', org: 'org-unit', label: 'unit' });

  // concurrency 固定 1.5s，不随失败次数递增（并发槽是确定性释放，惩罚性递增会让多子代理场景雪崩）
  const c1 = pool.fail(a, 'concurrency', '429 concurrents');
  ok('concurrency 第1次 -> 1.5s', c1 === 1500, `ms=${c1}`);
  const c2 = pool.fail(a, 'concurrency', '429 concurrents');
  ok('concurrency 第2次仍 1.5s（不递增）', c2 === 1500, `ms=${c2}`);

  // transient 独立起算：不受上面 2 次 concurrency 影响（旧实现此刻是共享 streak 第3档 -> 10s）
  const t1 = pool.fail(a, 'transient', 'upstream network error: ECONNRESET');
  ok('transient 不受 concurrency 污染 -> 0ms', t1 === 0, `ms=${t1}`);

  // rate_limit 也独立起算：第一档 60s（旧实现此刻会被顶到更高档）
  const r1 = pool.fail(a, 'rate_limit', '{"type":"exceeded_limit"}');
  ok('rate_limit 独立起算 -> 60s', r1 === 60000, `ms=${r1}`);
  ok('fail_streak（总）跨类别累计展示', a.failStreak === 4, `failStreak=${a.failStreak}`);

  // 成功一次：所有类别清零，再失败回到各自第一档
  pool.release(a, true);
  const c3 = pool.fail(a, 'concurrency', '429 concurrents');
  ok('成功后 streak 清零 -> concurrency 仍 1.5s', c3 === 1500, `ms=${c3}`);

  // fail 计数与状态字段
  ok('stats.fail 正确累计', a.stats.fail === 5, `fail=${a.stats.fail} streaks=${JSON.stringify(a.streaks)}`);
  ok('成功清零后 failStreak 重新起算', a.failStreak === 1, `failStreak=${a.failStreak}`);

  // 重新加载：streaks 随文件持久化
  const pool2 = new AccountPool(TMP);
  const a2 = pool2.get(a.id);
  ok('streaks 落盘持久化', a2 && a2.streaks?.concurrency === 1 && a2.failStreak === 1,
    `streaks=${JSON.stringify(a2?.streaks)} failStreak=${a2?.failStreak}`);

  // 启用（set enabled）会清零
  pool2.set(a.id, { enabled: false });
  pool2.set(a.id, { enabled: true });
  ok('disable/enable 清零 streaks', (pool2.get(a.id).streaks?.concurrency || 0) === 0,
    `streaks=${JSON.stringify(pool2.get(a.id).streaks)}`);

  // ---- 额度低于阈值自动切换（acquire 过滤 + configure）----
  const TMP2 = path.join(HERE, `accounts.quota.${process.pid}.json`);
  try {
    const q = new AccountPool(TMP2);
    // 这组断言考的是「额度阈值过滤」，不是「按负载挑号」。
    // 账号池默认策略是 least-loaded（A 号 5h 已用 75% -> 更忙 -> 会被跳过），
    // 那样断言就变成了在考 least-loaded。显式切成 round-robin，才是断言本意。
    q.configure({ strategy: 'round-robin' });
    const A = q.add({ sessionKey: 'sk-ant-sid01-QUOTA_A', org: 'org-aa', label: 'quota-a' }).account;
    const B = q.add({ sessionKey: 'sk-ant-sid01-QUOTA_B', org: 'org-bb', label: 'quota-b' }).account;
    const acquire0 = () => { q.rr = 0; return q.acquire(); };   // 每次从头轮询，断言确定性

    // 基线：两账号都无额度数据 -> 正常轮到 A
    let p = acquire0();
    ok('基线轮询选中 A', p?.id === A.id, `pick=${p?.label}`);
    if (p) q.release(p, true);

    // A 5h 用量 95% -> 剩 5% < 20% -> 本轮跳过 A 选 B
    q.updateQuota(A, { windows: { '5h': { utilization: 0.95 } } });
    p = acquire0();
    ok('剩5% -> 切走 A 选 B', p?.id === B.id, `pick=${p?.label}`);
    if (p) q.release(p, true);

    // 边界：剩 25%（>= 20%）不切
    q.updateQuota(A, { windows: { '5h': { utilization: 0.75 } } });
    p = acquire0();
    ok('剩25% >= 阈值仍选 A', p?.id === A.id, `pick=${p?.label}`);
    if (p) q.release(p, true);

    // 7d 窗口更紧（5h 剩 50%，7d 剩 10%）也要切
    q.updateQuota(A, { windows: { '5h': { utilization: 0.5 }, '7d': { utilization: 0.9 } } });
    p = acquire0();
    ok('7d 剩10% 也切走', p?.id === B.id, `pick=${p?.label}`);
    if (p) q.release(p, true);

    // utilization 百分比写法（95 代表 95%）
    q.updateQuota(A, { windows: { '5h': { utilization: 95 } } });
    p = acquire0();
    ok('utilization=95 百分比写法兼容', p?.id === B.id, `pick=${p?.label}`);
    if (p) q.release(p, true);

    // 全都低于阈值 -> 降级照用，不拒服
    q.updateQuota(B, { windows: { '5h': { utilization: 0.99 } } });
    p = acquire0();
    ok('全部低额度仍能选到账号（降级）', p != null, `pick=${p?.label}`);
    if (p) q.release(p, true);

    // 只剩一个低额度账号 -> 照用
    q.remove(B.id);
    p = acquire0();
    ok('唯一账号低额度仍可用', p?.id === A.id, `pick=${p?.label}`);
    if (p) q.release(p, true);

    // 阈值调 0 = 关闭切换
    const cfg = q.configure({ minQuotaRemaining: 0 });
    ok('configure 阈值 0（关闭切换）', cfg.min_quota_remaining === 0, JSON.stringify(cfg));
    p = acquire0();
    ok('阈值0时低额度账号恢复参与', p?.id === A.id, `pick=${p?.label}`);
    if (p) q.release(p, true);

    // configure 校验：越界一律 400
    let t = null; try { q.configure({ minQuotaRemaining: 1.5 }); } catch (e) { t = e; }
    ok('阈值越界 -> 400', t?.status === 400, `status=${t?.status} ${t?.message || ''}`);
    t = null; try { q.configure({ perAccountConcurrency: 0 }); } catch (e) { t = e; }
    ok('并发越界 -> 400', t?.status === 400, `status=${t?.status}`);
    t = null; try { q.configure({ strategy: 'bad' }); } catch (e) { t = e; }
    ok('策略非法 -> 400', t?.status === 400, `status=${t?.status}`);
    const cfg2 = q.configure({ strategy: 'least-loaded', perAccountConcurrency: 2 });
    ok('configure 正常写入', cfg2.strategy === 'least-loaded' && cfg2.per_account_concurrency === 2,
      JSON.stringify(cfg2));

    // 池配置落盘，重启后保留
    const q2 = new AccountPool(TMP2);
    ok('池配置落盘持久化', q2.data.strategy === 'least-loaded' && q2.data.minQuotaRemaining === 0,
      `strategy=${q2.data.strategy} thr=${q2.data.minQuotaRemaining}`);
  } finally {
    try { fs.unlinkSync(TMP2); } catch { /* noop */ }
  }
} finally {
  try { fs.unlinkSync(TMP); } catch { /* noop */ }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

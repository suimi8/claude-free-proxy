/**
 * test_network_optimizer.mjs —— 网络连接池、代理支持与健康调度模块单元测试
 *
 * 测试覆盖：
 * 1. Dispatcher 连接池与代理构造：
 *    - 直连模式创建 undici Agent，验证连接池长连接参数；
 *    - 代理配置模式（options.proxy 为字符串或对象）创建 ProxyAgent；
 *    - 环境变量代理（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY）自动识别；
 *    - forceDirect 强制直连参数生效；
 *    - getSharedDispatcher 与 resetSharedDispatcher 单例生命周期。
 * 2. 账号健康评分（scoreAccountHealth）：
 *    - 剩余额度充足度对评分的线性提升；
 *    - 低额度（低于 20%）触发警戒惩罚；
 *    - 会话粘性加分（Prompt Cache 保护）：额度健康时大幅加分，额度耗尽时不盲目加分；
 *    - 并发在途负载（inflight）扣分与满载惩罚；
 *    - 10 分钟内 429 / 限频记录惩罚（过期记录不惩罚）；
 *    - 冷却中、耗尽中、被禁用状态重罚。
 * 3. 最佳健康账号选择（selectOptimalAccount）：
 *    - 正常场景优选最高健康分账号；
 *    - 会话粘性优先锁定首选账号；
 *    - 首选账号额度告急时平滑切至备用健康账号（避免踩雷）；
 *    - 并发槽满载时跳过，优选空闲账号；
 *    - 自动规避近期发生 429 的脆弱账号；
 *    - triedIds 排除项生效；
 *    - 账号禁用/冷却/耗尽状态过滤，无可用账号时安全返回 null。
 */

import { Agent, ProxyAgent, Dispatcher } from 'undici';
import {
  createUpstreamDispatcher,
  resolveProxySetting,
  getQuotaRemaining,
  hasRecentRateLimit,
  scoreAccountHealth,
  selectOptimalAccount,
  rankAccountsByHealth,
  getSharedDispatcher,
  resetSharedDispatcher,
  DEFAULT_DISPATCHER_CONFIG,
  DEFAULT_HEALTH_CONFIG,
} from '../src/network-optimizer.mjs';

let passed = 0;
let failed = 0;

function assert(name, condition, extra = '') {
  if (condition) {
    passed++;
    console.log(`\x1b[32mPASS\x1b[0m  ${name}${extra ? ' | ' + extra : ''}`);
  } else {
    failed++;
    console.error(`\x1b[31mFAIL\x1b[0m  ${name}${extra ? ' | ' + extra : ''}`);
  }
}

// 缓存初始环境变量以便测试后恢复
const ORIGINAL_ENV = {
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  https_proxy: process.env.https_proxy,
  HTTP_PROXY: process.env.HTTP_PROXY,
  http_proxy: process.env.http_proxy,
  ALL_PROXY: process.env.ALL_PROXY,
  all_proxy: process.env.all_proxy,
};

function clearProxyEnv() {
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
}

function restoreProxyEnv() {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
}

console.log('\n===== 1. 测试 Dispatcher 连接池与代理构造 =====');

try {
  clearProxyEnv();

  // 1.1 默认直连模式：应返回 undici Agent
  const directDispatcher = createUpstreamDispatcher();
  assert('默认无代理返回 undici.Agent 实例', directDispatcher instanceof Agent);
  assert('直连 Agent 是 undici.Dispatcher', directDispatcher instanceof Dispatcher);

  // 1.2 自定义 Agent 参数
  const customDispatcher = createUpstreamDispatcher({
    keepAliveTimeout: 45000,
    keepAliveMaxTimeout: 90000,
    maxSockets: 64,
  });
  assert('支持自定义 keepAlive 参数构建 Agent', customDispatcher instanceof Agent);

  // 1.3 通过 options.proxy 传入字符串 URL
  const proxyDispatcherStr = createUpstreamDispatcher({ proxy: 'http://127.0.0.1:7890' });
  assert('options.proxy (字符串) 返回 ProxyAgent 实例', proxyDispatcherStr instanceof ProxyAgent);
  assert('ProxyAgent 也是 undici.Dispatcher', proxyDispatcherStr instanceof Dispatcher);

  // 1.4 通过 options.proxy 传入对象
  const proxyDispatcherObj = createUpstreamDispatcher({
    proxy: { uri: 'http://proxy.internal:8080' },
  });
  assert('options.proxy (对象配置) 返回 ProxyAgent 实例', proxyDispatcherObj instanceof ProxyAgent);

  // 1.5 环境变量代理检测：HTTPS_PROXY
  process.env.HTTPS_PROXY = 'http://127.0.0.1:10808';
  const envHttpsDispatcher = createUpstreamDispatcher();
  assert('环境变量 HTTPS_PROXY 生效并返回 ProxyAgent', envHttpsDispatcher instanceof ProxyAgent);
  clearProxyEnv();

  // 1.6 环境变量代理检测：HTTP_PROXY 与 ALL_PROXY
  process.env.HTTP_PROXY = 'http://127.0.0.1:8081';
  const envHttpDispatcher = createUpstreamDispatcher();
  assert('环境变量 HTTP_PROXY 生效并返回 ProxyAgent', envHttpDispatcher instanceof ProxyAgent);
  clearProxyEnv();

  process.env.ALL_PROXY = 'socks5://127.0.0.1:1080';
  const envAllDispatcher = createUpstreamDispatcher();
  assert('环境变量 ALL_PROXY 生效并返回 ProxyAgent', envAllDispatcher instanceof ProxyAgent);

  // 1.7 forceDirect 强制忽略环境变量代理
  const forcedDirect = createUpstreamDispatcher({ forceDirect: true });
  assert('forceDirect: true 时忽略环境代理，返回直连 Agent', forcedDirect instanceof Agent);
  clearProxyEnv();

  // 1.8 resolveProxySetting 优先级测试
  assert('无代理配置时 resolveProxySetting 返回 null', resolveProxySetting() === null);
  process.env.ALL_PROXY = 'http://all-proxy:80';
  process.env.HTTPS_PROXY = 'http://https-proxy:443';
  assert(
    'HTTPS_PROXY 优先级高于 ALL_PROXY',
    resolveProxySetting() === 'http://https-proxy:443'
  );
  assert(
    'options.proxy 优先级高于环境变量',
    resolveProxySetting({ proxy: 'http://opt-proxy:8080' }) === 'http://opt-proxy:8080'
  );
  clearProxyEnv();

  // 1.9 单例管理 getSharedDispatcher / resetSharedDispatcher
  resetSharedDispatcher();
  const s1 = getSharedDispatcher();
  const s2 = getSharedDispatcher();
  assert('getSharedDispatcher 返回单例', s1 === s2);
  resetSharedDispatcher();
  const s3 = getSharedDispatcher();
  assert('resetSharedDispatcher 后重新创建实例', s1 !== s3);
  resetSharedDispatcher();

} finally {
  restoreProxyEnv();
}

console.log('\n===== 2. 测试账号健康评分（scoreAccountHealth） =====');

{
  const now = Date.now();

  // 2.1 额度提取兼容性
  const accWithExplicit = { id: 'a1', remainingQuota: 0.75 };
  assert('getQuotaRemaining 读取 remainingQuota', getQuotaRemaining(accWithExplicit) === 0.75);

  const accWithWindows = {
    id: 'a2',
    quota: {
      windows: {
        '5h': { utilization: 0.3 }, // 剩余 70%
        '7d': { utilization: 0.5 }, // 剩余 50%
      },
    },
  };
  assert('getQuotaRemaining 读取 5h/7d 窗口更紧张者 (50%)', getQuotaRemaining(accWithWindows) === 0.5);

  const accWithPercent = {
    id: 'a3',
    quota: { windows: { '5h': { utilization: 80 } } }, // 百分比写法：剩余 20%
  };
  assert('getQuotaRemaining 兼容百分比写法 (剩余 20%)', Math.abs(getQuotaRemaining(accWithPercent) - 0.2) < 0.001);

  const accExhausted = { id: 'a4', exhaustedUntil: now + 60000, remainingQuota: 0.9 };
  assert('处于 exhaustedUntil 的账号剩余额度视为 0', getQuotaRemaining(accExhausted) === 0);

  // 2.2 额度充足度对评分的正面作用
  const fullQuotaAcc = { id: 'full', remainingQuota: 1.0, inflight: 0 };
  const halfQuotaAcc = { id: 'half', remainingQuota: 0.5, inflight: 0 };
  const lowQuotaAcc  = { id: 'low',  remainingQuota: 0.1, inflight: 0 };

  const fullScore = scoreAccountHealth(fullQuotaAcc);
  const halfScore = scoreAccountHealth(halfQuotaAcc);
  const lowScore  = scoreAccountHealth(lowQuotaAcc);

  assert('满额度得分高于半额度', fullScore > halfScore, `full=${fullScore}, half=${halfScore}`);
  assert('半额度得分高于低额度（且触发告急惩罚）', halfScore > lowScore, `half=${halfScore}, low=${lowScore}`);

  // 2.3 会话粘性加分与额度健康保护
  // 额度健康时，粘性账号得分大幅提高
  const prefHealthy = { id: 'pref', remainingQuota: 0.8, inflight: 0 };
  const prefHealthyScore = scoreAccountHealth(prefHealthy, 'pref');
  const otherHealthy = { id: 'other', remainingQuota: 0.95, inflight: 0 };
  const otherScore = scoreAccountHealth(otherHealthy, 'pref');

  assert(
    '首选账号且额度健康时获得大幅加分，胜过额度稍高的非首选账号（保护 Prompt Cache）',
    prefHealthyScore > otherScore,
    `pref=${prefHealthyScore}, other=${otherScore}`
  );

  // 额度不健康时（低于 20%），首选账号不应获得粘性加分，并且扣分，以便调度器切号
  const prefDepleted = { id: 'pref', remainingQuota: 0.08, inflight: 0 };
  const prefDepletedScore = scoreAccountHealth(prefDepleted, 'pref');
  assert(
    '首选账号额度告急时失去粘性加分并被惩罚，得分显著低于健康备用账号',
    prefDepletedScore < otherScore,
    `prefDepleted=${prefDepletedScore}, other=${otherScore}`
  );

  // 2.4 并发负载（inflight）对得分的惩罚
  const idleAcc = { id: 'idle', remainingQuota: 0.8, inflight: 0 };
  const busyAcc = { id: 'busy', remainingQuota: 0.8, inflight: 2 };
  assert(
    '并发数越高得分越低（inflight 惩罚生效）',
    scoreAccountHealth(idleAcc) > scoreAccountHealth(busyAcc),
    `idle=${scoreAccountHealth(idleAcc)}, busy=${scoreAccountHealth(busyAcc)}`
  );

  // 2.5 10 分钟内 429 / 限频惩罚
  const recent429Acc = {
    id: 'rec429',
    remainingQuota: 0.9,
    inflight: 0,
    lastRateLimitAt: now - 3 * 60 * 1000, // 3 分钟前 429
  };
  const cleanAcc = {
    id: 'clean',
    remainingQuota: 0.9,
    inflight: 0,
  };
  assert('hasRecentRateLimit 正确识别 3 分钟前的 429', hasRecentRateLimit(recent429Acc, now) === true);
  assert('hasRecentRateLimit 对无限频记录账号返回 false', hasRecentRateLimit(cleanAcc, now) === false);

  const old429Acc = {
    id: 'old429',
    remainingQuota: 0.9,
    inflight: 0,
    lastRateLimitAt: now - 15 * 60 * 1000, // 15 分钟前 429（已过 10 分钟考察期）
  };
  assert('15 分钟前的限频记录已过期', hasRecentRateLimit(old429Acc, now) === false);

  const rec429Score = scoreAccountHealth(recent429Acc);
  const cleanScore  = scoreAccountHealth(cleanAcc);
  const old429Score = scoreAccountHealth(old429Acc);

  assert(
    '近期 10 分钟内有 429 的账号得分显著低于干净账号',
    rec429Score < cleanScore,
    `rec429=${rec429Score}, clean=${cleanScore}`
  );
  assert(
    '15 分钟前 429 的账号不受近期 429 惩罚',
    old429Score > rec429Score,
    `old429=${old429Score}, rec429=${rec429Score}`
  );

  // 2.6 异常状态重度惩罚
  const disabledAcc = { id: 'dis', enabled: false, remainingQuota: 1.0 };
  const inCoolAcc   = { id: 'cool', cooldownUntil: now + 30000, remainingQuota: 1.0 };
  const exUntilAcc  = { id: 'ex', exhaustedUntil: now + 30000, remainingQuota: 1.0 };

  assert('禁用账号得分极低', scoreAccountHealth(disabledAcc) < -1000);
  assert('冷却期账号得分极低', scoreAccountHealth(inCoolAcc) < -1000);
  assert('耗尽池账号得分极低', scoreAccountHealth(exUntilAcc) < -1000);
}

console.log('\n===== 3. 测试最佳账号选择（selectOptimalAccount） =====');

{
  const now = Date.now();

  const accounts = [
    { id: 'acc_a', label: '账号A-首选', sessionKey: 'sk-a', remainingQuota: 0.85, inflight: 0, enabled: true },
    { id: 'acc_b', label: '账号B-高额度', sessionKey: 'sk-b', remainingQuota: 0.95, inflight: 0, enabled: true },
    { id: 'acc_c', label: '账号C-半额度', sessionKey: 'sk-c', remainingQuota: 0.50, inflight: 1, enabled: true },
  ];

  // 3.1 会话粘性优先：指定 preferredId = 'acc_a'
  const picked1 = selectOptimalAccount(accounts, new Set(), 'acc_a');
  assert('会话粘性命中：正确优先选出首选账号 acc_a', picked1?.id === 'acc_a');

  // 3.2 无 preferredId 时选择健康度最高者（acc_b 额度最高且无并发）
  const picked2 = selectOptimalAccount(accounts, new Set(), null);
  assert('无首选账号时优选全局最健康账号 acc_b', picked2?.id === 'acc_b');

  // 3.3 首选账号额度耗尽时自动切走（避免 failover 雪崩）
  const accountsWithDepletedPref = [
    { id: 'acc_a', label: '账号A-额度告急', sessionKey: 'sk-a', remainingQuota: 0.05, inflight: 0, enabled: true },
    { id: 'acc_b', label: '账号B-健康充沛', sessionKey: 'sk-b', remainingQuota: 0.90, inflight: 0, enabled: true },
  ];
  const picked3 = selectOptimalAccount(accountsWithDepletedPref, new Set(), 'acc_a');
  assert('首选账号额度告急(<20%)时自动切换到健康备用账号 acc_b', picked3?.id === 'acc_b');

  // 3.4 排除已尝试过的账号 (triedIds)
  const tried = new Set(['acc_b']);
  const picked4 = selectOptimalAccount(accounts, tried, null);
  assert('triedIds 生效：已尝试过的 acc_b 被排除，优选 acc_a', picked4?.id === 'acc_a');

  // 3.5 并发饱和降级：当首选账号并发达到上限时切至空闲账号
  const accountsBusyPref = [
    { id: 'acc_a', label: '账号A-满载', sessionKey: 'sk-a', remainingQuota: 0.90, inflight: 3, maxConcurrency: 3, enabled: true },
    { id: 'acc_b', label: '账号B-空闲', sessionKey: 'sk-b', remainingQuota: 0.85, inflight: 0, maxConcurrency: 3, enabled: true },
  ];
  const picked5 = selectOptimalAccount(accountsBusyPref, new Set(), 'acc_a');
  assert('首选账号并发满载时跳过，选用空闲备用账号 acc_b', picked5?.id === 'acc_b');

  // 3.6 规避近期 429 账号：优先选用干净账号
  const accountsWith429 = [
    {
      id: 'acc_bad',
      label: '账号-近期429',
      sessionKey: 'sk-bad',
      remainingQuota: 0.95,
      inflight: 0,
      enabled: true,
      lastRateLimitAt: now - 2 * 60 * 1000, // 2分钟前限频
    },
    {
      id: 'acc_good',
      label: '账号-正常',
      sessionKey: 'sk-good',
      remainingQuota: 0.70, // 额度虽略低但没有限频
      inflight: 0,
      enabled: true,
    },
  ];
  const picked6 = selectOptimalAccount(accountsWith429, new Set(), null);
  assert('自动规避近期 10 分钟内发生 429 的脆弱账号，优选正常账号 acc_good', picked6?.id === 'acc_good');

  // 3.7 状态过滤：禁用、冷却中或耗尽池中的账号一律不选
  const unusableAccounts = [
    { id: 'u1', sessionKey: 'sk-u1', enabled: false, remainingQuota: 1.0 },
    { id: 'u2', sessionKey: 'sk-u2', enabled: true, cooldownUntil: now + 60000, remainingQuota: 1.0 },
    { id: 'u3', sessionKey: 'sk-u3', enabled: true, exhaustedUntil: now + 60000, remainingQuota: 1.0 },
  ];
  const pickedNone = selectOptimalAccount(unusableAccounts, new Set(), null);
  assert('所有账号均不可用时安全返回 null', pickedNone === null);

  // 3.8 rankAccountsByHealth 返回完整评分清单
  const ranking = rankAccountsByHealth(accounts, new Set(), 'acc_a');
  assert('rankAccountsByHealth 返回有效数组', Array.isArray(ranking) && ranking.length === accounts.length);
  assert('rankAccountsByHealth 首位与 selectOptimalAccount 一致', ranking[0].account.id === 'acc_a');
  assert('rankAccountsByHealth 包含 score, quota, inflight, isPreferred 字段',
    typeof ranking[0].score === 'number' &&
    typeof ranking[0].quota === 'number' &&
    ranking[0].isPreferred === true
  );
}

console.log('\n=================================================');
console.log(`测试完成: ${passed} 通过, ${failed} 失败`);
console.log('=================================================\n');

if (failed > 0) {
  process.exit(1);
}

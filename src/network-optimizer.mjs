/**
 * network-optimizer.mjs —— 网络连接池、代理支持与健康调度模块
 *
 * 核心职责：
 * 1. createUpstreamDispatcher(options)
 *    使用 undici (Node 18+ 原生内置连接引擎) 构建高性能复用连接池：
 *    - 避免每次请求重复进行 TLS 握手（省去 400~600ms 握手开销）；
 *    - 自动侦测并支持代理环境（options.proxy 或 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY）；
 *    - 返回 ProxyAgent 或长连接 Agent。
 *
 * 2. scoreAccountHealth(account, preferredId, options)
 *    计算账号的实时健康度评分：
 *    - 会话粘性加分：当 account.id === preferredId 且额度健康时大幅加分（锁定 Anthropic Prompt Cache）；
 *    - 剩余额度收益：额度越充足得分越高；低于警戒阈值施加降级惩罚；
 *    - 429 规避惩罚：近期 10 分钟内有 429 或限频记录的账号扣分，防止频繁踩雷与 failover 雪崩；
 *    - 并发负载惩罚：当前 inflight 在途并发越低得分越高，避免局部过载。
 *
 * 3. selectOptimalAccount(accounts, triedIds, preferredId, options)
 *    综合过滤可用账号并按健康评分由高到低优选最佳账号。
 */

import { Agent, ProxyAgent } from 'undici';

/** 默认连接池参数 */
export const DEFAULT_DISPATCHER_CONFIG = {
  keepAliveTimeout: 60000,      // 空闲连接保持 60s
  keepAliveMaxTimeout: 120000,  // 最大存活 120s
  maxSockets: 128,              // 最大连接数
};

/** 默认健康评分权重配置 */
export const DEFAULT_HEALTH_CONFIG = {
  baseScore: 100,               // 基准分
  preferredBonus: 80,           // 会话粘性加分（足以覆盖额度差异，优先保障 Prompt Cache）
  quotaWeight: 40,              // 剩余额度权重（0..1 对应 0..40 分）
  lowQuotaThreshold: 0.2,       // 额度健康警戒线（低于 20% 视为不健康）
  lowQuotaPenalty: 60,          // 额度危险惩罚
  inflightPenaltyPerReq: 20,    // 每 1 个在途请求扣分
  recentRateLimitWindowMs: 10 * 60 * 1000, // 429 考察窗口：10 分钟
  recentRateLimitPenalty: 60,   // 近期 429 惩罚分
  cooldownPenalty: 2000,        // 冷却期重罚
  exhaustedPenalty: 5000,       // 额度耗尽池重罚
  disabledPenalty: 10000,       // 禁用状态重罚
};

/**
 * 侦测代理配置（按优先级：options.proxy -> HTTPS_PROXY -> HTTP_PROXY -> ALL_PROXY）
 * @param {object} [options]
 * @returns {string|object|null}
 */
export function resolveProxySetting(options = {}) {
  if (options.forceDirect) return null;
  if (options.proxy) return options.proxy;

  const env = process.env;
  const proxy =
    env.HTTPS_PROXY || env.https_proxy ||
    env.HTTP_PROXY  || env.http_proxy  ||
    env.ALL_PROXY   || env.all_proxy;

  return proxy ? proxy.trim() : null;
}

/**
 * 创建高性能的上游连接池 Dispatcher
 * @param {object} [options]
 * @param {string|object} [options.proxy] - 显式指定的代理地址（如 http://127.0.0.1:7890）
 * @param {boolean} [options.forceDirect] - 是否强制直连（忽略环境变量代理）
 * @param {number} [options.keepAliveTimeout] - keepAlive 超时毫秒数（默认 60000）
 * @param {number} [options.keepAliveMaxTimeout] - 最大 keepAlive 毫秒数（默认 120000）
 * @param {number} [options.maxSockets] - 最大并发 socket 数（默认 128）
 * @param {object} [options.agentOptions] - 传递给 undici Agent / ProxyAgent 的其他参数
 * @returns {ProxyAgent|Agent}
 */
export function createUpstreamDispatcher(options = {}) {
  const proxy = resolveProxySetting(options);

  const keepAliveTimeout = options.keepAliveTimeout ?? DEFAULT_DISPATCHER_CONFIG.keepAliveTimeout;
  const keepAliveMaxTimeout = options.keepAliveMaxTimeout ?? DEFAULT_DISPATCHER_CONFIG.keepAliveMaxTimeout;
  const maxSockets = options.maxSockets ?? DEFAULT_DISPATCHER_CONFIG.maxSockets;

  const agentDefaults = {
    keepAliveTimeout,
    keepAliveMaxTimeout,
    maxSockets,
    // 超时与长连接保护：给上游深度思考和生成预留充足时间，防止 Undici 误判 socket/body 超时
    headersTimeout: 300_000, // 5 分钟
    bodyTimeout: 0,          // 流式生成不设 body 超时
    allowH2: false,          // 强制 HTTP/1.1：Cloudflare 对 Undici HTTP/2 握手指纹拦截（403 挑战），HTTP/1.1 携带 cf_clearance 可完美通行
    pipelining: 0,
    connect: {
      timeout: 15_000,       // 15s 握手超时（比默认 10s 宽容，防止跨国网络首包抖动）
      keepAlive: true,
      ...(options.agentOptions?.connect || {}),
    },
    ...(options.agentOptions || {}),
  };

  if (proxy) {
    if (typeof proxy === 'string') {
      return new ProxyAgent({
        uri: proxy,
        ...agentDefaults,
      });
    }
    if (typeof proxy === 'object' && proxy !== null) {
      return new ProxyAgent({
        ...proxy,
        ...agentDefaults,
      });
    }
  }

  return new Agent(agentDefaults);
}

/**
 * 提取账号剩余额度比例（0..1）
 * 兼容 accounts.mjs 的 windows 结构以及显式 remaining 字段
 * @param {object} account
 * @returns {number} 0..1 之间的比例
 */
export function getQuotaRemaining(account) {
  if (!account) return 0;
  const now = Date.now();
  if (account.exhaustedUntil && account.exhaustedUntil > now) return 0;

  // 显式字段兼容
  if (typeof account.remainingQuota === 'number') return Math.max(0, Math.min(1, account.remainingQuota));
  if (typeof account.quotaRemaining === 'number') return Math.max(0, Math.min(1, account.quotaRemaining));
  if (typeof account.remaining === 'number') return Math.max(0, Math.min(1, account.remaining));

  const w = account.quota?.windows;
  if (w && typeof w === 'object') {
    let min = null;
    for (const k of ['5h', '7d']) {
      const u = w[k]?.utilization ?? w[k]?.utilised ?? w[k]?.used;
      if (typeof u !== 'number') continue;
      const used = u > 1 ? u / 100 : u;
      const r = Math.max(0, Math.min(1, 1 - used));
      min = min == null ? r : Math.min(min, r);
    }
    if (min !== null) return min;
  }

  // 尚未产生上游 quota 数据时，视为全新充足
  return 1.0;
}

/**
 * 判定账号在指定时间窗口内（默认 10 分钟）是否有 429 或限频记录
 * @param {object} account
 * @param {number} [now]
 * @param {number} [windowMs]
 * @returns {boolean}
 */
export function hasRecentRateLimit(account, now = Date.now(), windowMs = DEFAULT_HEALTH_CONFIG.recentRateLimitWindowMs) {
  if (!account) return false;

  // 显式标记
  if (account.recentRateLimit === true || account.hasRecent429 === true) return true;

  // 明确的限频时间戳记录
  if (account.lastRateLimitAt && (now - account.lastRateLimitAt < windowMs)) return true;
  if (account.last429At && (now - account.last429At < windowMs)) return true;
  if (account.exhaustedAt && (now - account.exhaustedAt < windowMs)) return true;

  // 账号最后一次报错记录
  const lastUsedAt = account.stats?.lastUsedAt || 0;
  if (lastUsedAt && (now - lastUsedAt < windowMs)) {
    const lastErr = String(account.stats?.lastError || '');
    if (/429|exceeded_limit|rate_limit|rate\s*limit|quota/i.test(lastErr)) {
      return true;
    }
  }

  // 错误计数（rate_limit 连续失败记录且近期使用过）
  if (account.streaks?.rate_limit > 0 && lastUsedAt && (now - lastUsedAt < windowMs)) {
    return true;
  }

  return false;
}

/**
 * 计算账号的健康评分
 *
 * 评分准则：
 * 1. 会话粘性加分：当 account.id === preferredId 且额度健康（>= 20% 且未耗尽），给予大幅加分，保护 Prompt Cache；
 * 2. 额度收益：剩余额度越充足得分越高（+0~40分）；低于 20% 警戒线施加低额度惩罚；
 * 3. 429 惩罚：近期 10 分钟内有 429 或限频记录的降分（-60分及连败扣分）；
 * 4. 并发惩罚：当前正在处理的在途并发请求数（inflight）越少得分越高（每个 -20 分）；
 * 5. 状态严惩：处于冷却期、耗尽池或被禁用的账号给予重罚。
 *
 * @param {object} account
 * @param {string|null} [preferredId]
 * @param {object} [customConfig]
 * @returns {number} 健康评分（越高越健康）
 */
export function scoreAccountHealth(account, preferredId = null, customConfig = {}) {
  if (!account || typeof account !== 'object') return -Infinity;

  const cfg = { ...DEFAULT_HEALTH_CONFIG, ...customConfig };
  const now = Date.now();
  let score = cfg.baseScore;

  // 1. 硬性状态检查（重度降分）
  if (account.enabled === false) {
    score -= cfg.disabledPenalty;
  }
  if (account.exhaustedUntil && account.exhaustedUntil > now) {
    score -= cfg.exhaustedPenalty;
  }
  if (account.cooldownUntil && account.cooldownUntil > now) {
    score -= cfg.cooldownPenalty;
  }

  // 2. 额度健康评估
  const quotaRem = getQuotaRemaining(account);
  score += Math.round(quotaRem * cfg.quotaWeight);

  const isHealthyQuota = quotaRem >= cfg.lowQuotaThreshold &&
    !(account.exhaustedUntil && account.exhaustedUntil > now);

  if (!isHealthyQuota) {
    // 额度告急：扣除危险惩罚分
    score -= cfg.lowQuotaPenalty;
  }

  // 3. 会话粘性加分（Prompt Cache 保护）
  // 必须是指定 preferredId 且额度健康，才大幅加分
  if (preferredId && account.id === preferredId && isHealthyQuota) {
    score += cfg.preferredBonus;
  }

  // 4. 并发负载惩罚（inflight 越少得分越高）
  const inflight = Math.max(0, account.inflight || 0);
  score -= inflight * cfg.inflightPenaltyPerReq;

  const maxCap = account.maxConcurrency || account.cap || 3;
  if (inflight >= maxCap) {
    // 达到或超过并发上限，额外施加过载惩罚
    score -= 100;
  }

  // 5. 10 分钟内 429 / 限频记录惩罚
  if (hasRecentRateLimit(account, now, cfg.recentRateLimitWindowMs)) {
    score -= cfg.recentRateLimitPenalty;
    const streak = account.streaks?.rate_limit || 0;
    if (streak > 1) {
      score -= (streak - 1) * 20;
    }
  }

  // 6. 微调：成功率与连续失败轻微影响
  if (account.stats?.ok) {
    score += Math.min(10, Math.floor(account.stats.ok / 10));
  }
  if (account.failStreak && account.failStreak > 0) {
    score -= Math.min(30, account.failStreak * 5);
  }

  return score;
}

/**
 * 从候选账号列表中按健康评分由高到低排序，选出最佳健康账号
 *
 * @param {Array<object>} accounts - 待选账号列表
 * @param {Set<string>|Array<string>} [triedIds=new Set()] - 本轮 failover 已经试过的账号 ID 集合
 * @param {string|null} [preferredId=null] - 会话首选账号 ID
 * @param {object} [options={}] - 调度选项
 * @param {number} [options.perAccountConcurrency=3] - 默认单账号并发上限
 * @param {boolean} [options.allowInCooldown=false] - 是否允许选中冷却中的账号（通常为 false）
 * @returns {object|null} 选出的最优账号对象，无可用账号时返回 null
 */
export function selectOptimalAccount(accounts, triedIds = new Set(), preferredId = null, options = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;

  const now = Date.now();
  const tried = triedIds instanceof Set
    ? triedIds
    : new Set(Array.isArray(triedIds) ? triedIds : (triedIds ? [triedIds] : []));

  const defaultCap = options.perAccountConcurrency || 3;

  // 过滤出具备可用资格的候选账号
  const eligible = accounts.filter(a => {
    if (!a || typeof a !== 'object') return false;
    // 排除已尝试过的
    if (tried.has(a.id)) return false;
    // 排除已禁用的
    if (a.enabled === false) return false;
    // 排除缺失核心凭据的
    if (a.sessionKey !== undefined && !a.sessionKey) return false;
    // 排除仍处于 429 耗尽池的
    if (a.exhaustedUntil && a.exhaustedUntil > now) return false;
    // 排除仍处于冷却期的
    if (!options.allowInCooldown && a.cooldownUntil && a.cooldownUntil > now) return false;
    // 排除并发槽位已满的
    const cap = a.maxConcurrency || a.cap || defaultCap;
    if ((a.inflight || 0) >= cap) return false;

    return true;
  });

  if (eligible.length === 0) return null;

  // 计算健康评分并排序
  const scored = eligible.map(a => ({
    account: a,
    score: scoreAccountHealth(a, preferredId, options),
  }));

  scored.sort((x, y) => {
    // 1. 健康分高的优先
    if (y.score !== x.score) return y.score - x.score;
    // 2. 分数相同时，在途并发更少的优先
    const infDiff = (x.account.inflight || 0) - (y.account.inflight || 0);
    if (infDiff !== 0) return infDiff;
    // 3. 闲置更久的优先（负载均衡）
    const lastX = x.account.stats?.lastUsedAt || 0;
    const lastY = y.account.stats?.lastUsedAt || 0;
    return lastX - lastY;
  });

  return scored[0].account;
}

/**
 * 诊断辅助：对当前账号池输出健康度排序清单与详细评分
 * @param {Array<object>} accounts
 * @param {Set<string>|Array<string>} [triedIds=new Set()]
 * @param {string|null} [preferredId=null]
 * @param {object} [options={}]
 * @returns {Array<{account: object, score: number, quota: number, inflight: number, recentRateLimit: boolean}>}
 */
export function rankAccountsByHealth(accounts, triedIds = new Set(), preferredId = null, options = {}) {
  if (!Array.isArray(accounts)) return [];
  const tried = triedIds instanceof Set
    ? triedIds
    : new Set(Array.isArray(triedIds) ? triedIds : (triedIds ? [triedIds] : []));
  const now = Date.now();

  return accounts
    .filter(a => a && !tried.has(a.id))
    .map(a => ({
      account: a,
      score: scoreAccountHealth(a, preferredId, options),
      quota: getQuotaRemaining(a),
      inflight: a.inflight || 0,
      recentRateLimit: hasRecentRateLimit(a, now),
      isPreferred: preferredId ? a.id === preferredId : false,
    }))
    .sort((x, y) => y.score - x.score);
}

// 单例共享 Dispatcher 缓存（避免重复构建）
let _sharedDispatcher = null;

/**
 * 获取全局共享的 Dispatcher 实例
 * @param {object} [options]
 * @returns {ProxyAgent|Agent}
 */
export function getSharedDispatcher(options = {}) {
  if (!_sharedDispatcher) {
    _sharedDispatcher = createUpstreamDispatcher(options);
  }
  return _sharedDispatcher;
}

/**
 * 重置全局共享的 Dispatcher 实例
 */
export function resetSharedDispatcher() {
  if (_sharedDispatcher && typeof _sharedDispatcher.close === 'function') {
    try { _sharedDispatcher.close(); } catch {}
  }
  _sharedDispatcher = null;
}

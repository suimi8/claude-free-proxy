/**
 * conversation-router.mjs —— 会话粘性路由与状态管理模块
 *
 * 核心职责：
 * 1. 提取稳定的对话路由 Key（优先客户端显式头/ID，兜底首条消息指纹，保证会话树锚点一致）
 * 2. 维护对话与账号的映射关系 (CONV_ROUTING)，激活 Anthropic 官方前缀缓存 (Prompt Caching)
 * 3. 解决审计中发现的内存泄露：施加绝对容量上限 (默认 10,000 条) 与 LRU 淘汰机制
 * 4. 提供统一的状态查询与解绑接口 (getBoundAccount, bindAccount, unbindAccount)
 */

import { createHash } from 'node:crypto';

export const CONV_ROUTING_TTL = 15 * 60 * 1000;   // 15 分钟无活动自动过期
export const MAX_CONV_ROUTING_ENTRIES = 10000;    // 绝对容量上限，杜绝无界 Map 内存泄露

/**
 * 支持容量上限与 TTL 淘汰的会话路由表
 */
export class ConversationRoutingMap {
  constructor(options = {}) {
    this.ttl = options.ttl || CONV_ROUTING_TTL;
    this.maxSize = options.maxSize || MAX_CONV_ROUTING_ENTRIES;
    this._map = new Map();
  }

  get size() {
    return this._map.size;
  }

  get(key) {
    if (!key) return undefined;
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttl) {
      this._map.delete(key);
      return undefined;
    }
    // LRU 顺序刷新
    this._map.delete(key);
    this._map.set(key, entry);
    return entry;
  }

  set(key, value) {
    if (!key) return this;
    const now = Date.now();
    const entry = (value && typeof value === 'object' && 'accountId' in value)
      ? { accountId: value.accountId, at: value.at || now }
      : { accountId: String(value), at: now };

    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this.maxSize) {
      // 触发容量上限淘汰：按 LRU 顺序移除最久未访问的条目
      const oldestKey = this._map.keys().next().value;
      if (oldestKey !== undefined) this._map.delete(oldestKey);
    }
    this._map.set(key, entry);
    return this;
  }

  delete(key) {
    return this._map.delete(key);
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  clear() {
    this._map.clear();
  }

  entries() {
    return this._map.entries();
  }

  keys() {
    return this._map.keys();
  }

  values() {
    return this._map.values();
  }

  [Symbol.iterator]() {
    return this._map.entries();
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [k, v] of this._map.entries()) {
      if (now - v.at > this.ttl) this._map.delete(k);
    }
  }
}

/** 全局会话路由表单例 */
export const CONV_ROUTING = new ConversationRoutingMap({
  ttl: CONV_ROUTING_TTL,
  maxSize: MAX_CONV_ROUTING_ENTRIES,
});

// 每分钟执行一次 TTL 过期垃圾清理
const cleanupInterval = setInterval(() => {
  CONV_ROUTING.cleanupExpired();
}, 60 * 1000);
if (cleanupInterval?.unref) cleanupInterval.unref();

/**
 * 获取请求或请求体的会话路由键
 *
 * 兼容两种入参顺序：
 * - getConversationKey(req, body)
 * - getConversationKey(body, req)
 */
export function getConversationKey(arg1, arg2) {
  let req, body;
  if (arg1 && (arg1.headers || arg1.method || arg1.url)) {
    req = arg1;
    body = arg2;
  } else if (arg2 && (arg2.headers || arg2.method || arg2.url)) {
    req = arg2;
    body = arg1;
  } else if (arg1 && (arg1.messages || arg1.prompt || arg1.conversation_id || arg1.chat_id)) {
    body = arg1;
    req = arg2;
  } else {
    req = arg1;
    body = arg2;
  }

  if (!body) return null;

  // 1. 客户端显式传递的会话头或会话 ID
  const hId = req?.headers?.['x-session-id'] || req?.headers?.['x-conversation-id'];
  if (hId) return `h:${hId}`;
  if (body.conversation_id) return `c:${body.conversation_id}`;
  if (body.chat_id) return `c:${body.chat_id}`;

  // 2. 稳定的前置消息指纹（跨轮次绝对不变）
  // 无论对话扩展多少轮，首条用户指令 (messages[0]) 或 system 设定始终是整条会话树的锚点
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const firstUser = msgs.find(m => m && m.role === 'user');
  if (firstUser) {
    const sys = typeof body.system === 'string' ? body.system.slice(0, 100) : '';
    const userContent = typeof firstUser.content === 'string'
      ? firstUser.content
      : JSON.stringify(firstUser.content || '');
    return `fp:${createHash('sha1').update(`${sys}::${userContent.slice(0, 200)}`).digest('hex').slice(0, 16)}`;
  }

  // 3. 兜底：处理 prompt 文本输入
  if (typeof body.prompt === 'string' && body.prompt) {
    return `fp:${createHash('sha1').update(body.prompt.slice(0, 200)).digest('hex').slice(0, 16)}`;
  }

  return null;
}

/**
 * 获取会话绑定的账号 ID。若无绑定或已过期则返回 null。
 */
export function getBoundAccount(convKey) {
  if (!convKey) return null;
  const entry = CONV_ROUTING.get(convKey);
  return entry?.accountId || null;
}

/**
 * 绑定会话与账号，自动刷新时间戳并受容量上限约束
 */
export function bindAccount(convKey, accountId) {
  if (!convKey || !accountId) return false;
  CONV_ROUTING.set(convKey, { accountId, at: Date.now() });
  return true;
}

/**
 * 解绑会话与账号
 */
export function unbindAccount(convKey) {
  if (!convKey) return false;
  return CONV_ROUTING.delete(convKey);
}

/**
 * 手动执行一次过期淘汰扫描
 */
export function cleanupExpired() {
  CONV_ROUTING.cleanupExpired();
}

/**
 * 清空所有路由映射
 */
export function clearRouting() {
  CONV_ROUTING.clear();
}

/**
 * 获取路由表运行指标统计
 */
export function getRoutingStats() {
  return {
    size: CONV_ROUTING.size,
    maxSize: CONV_ROUTING.maxSize,
    ttlMs: CONV_ROUTING.ttl,
  };
}

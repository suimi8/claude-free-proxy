/**
 * http-auth.mjs —— HTTP 网络边界安全与认证辅助模块
 *
 * 核心功能：
 *   1. isLoopbackReq(req, trustProxy)：检测请求是否来自本地回环（防反向代理伪造、支持 TRUST_PROXY、兼容 IPv6 大小写）
 *   2. getReqIp(req, trustProxy)：安全提取请求客户端真实 IP
 *   3. validateHost(req, allowedHost)：HTTP Host 标头安全校验（防 DNS 重绑定攻击）
 *   4. safeCompareKey(a, b)：时间恒定比较 API Key，消除计时侧信道攻击 (Timing Attack)
 */
import { timingSafeEqual, createHash } from 'node:crypto';

/**
 * 是否启用反向代理信任 (TRUST_PROXY=1 / true / yes)
 * @returns {boolean}
 */
export function isTrustProxyEnabled() {
  const val = process.env.TRUST_PROXY;
  return val === '1' || val === 'true' || val === 'yes';
}

/**
 * 校验 IP 字符串是否为回环地址 (IPv4: 127.0.0.0/8, IPv6: ::1, 0:0:0:0:0:0:0:1)
 * 兼容 ::ffff: 映射及大小写
 * @param {string} ip
 * @returns {boolean}
 */
export function isLoopbackIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const clean = ip.trim().replace(/^::ffff:/i, '').toLowerCase();
  if (clean === '::1' || clean === '0:0:0:0:0:0:0:1') return true;
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(clean) || /^127\./.test(clean)) return true;
  return false;
}

/**
 * 提取请求的真实客户端 IP。
 * 仅在 trustProxy 显式启用时才读取 X-Forwarded-For 或 X-Real-IP 标头，杜绝未经验证的 IP 伪造。
 * @param {object} req - HTTP 请求对象
 * @param {boolean} [trustProxy=isTrustProxyEnabled()] - 是否信任代理头
 * @returns {string} 客户端 IP 字符串
 */
export function getReqIp(req, trustProxy = isTrustProxyEnabled()) {
  const rawSocketIp = (req?.socket?.remoteAddress || '').replace(/^::ffff:/i, '');
  if (trustProxy) {
    const forwarded = req?.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      const firstIp = forwarded.split(',')[0].trim().replace(/^::ffff:/i, '');
      if (firstIp) return firstIp;
    }
    const realIp = req?.headers?.['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) {
      return realIp.trim().replace(/^::ffff:/i, '');
    }
  }
  return rawSocketIp;
}

/**
 * 缺陷 4 修复：判定请求是否来自受信任的本地回环
 *
 * 安全原则：
 * 1. 物理连接层 (req.socket.remoteAddress) 必须是回环 IP。如果直接连接来自外部公网 IP，
 *    即使请求头伪造 X-Forwarded-For: 127.0.0.1 也绝不认定为回环请求。
 * 2. 如果开启了 TRUST_PROXY（如部署在本地 nginx / docker 之后）：
 *    物理连接为回环时，进一步验证真实客户端 IP。若 X-Forwarded-For 表明外部用户通过 nginx 访问，
 *    同样拒绝认定为本地回环管理员请求。
 * 3. 完整支持 IPv6 (::1, ::ffff:127.0.0.1) 大小写与展开格式。
 *
 * @param {object} req - HTTP 请求对象
 * @param {boolean} [trustProxy=isTrustProxyEnabled()] - 是否信任代理头
 * @returns {boolean}
 */
export function isLoopbackReq(req, trustProxy = isTrustProxyEnabled()) {
  const socketIp = (req?.socket?.remoteAddress || '').replace(/^::ffff:/i, '');
  if (!isLoopbackIp(socketIp)) {
    return false;
  }
  if (trustProxy) {
    const clientIp = getReqIp(req, true);
    return isLoopbackIp(clientIp);
  }
  return true;
}

/**
 * 校验 Host 标头是否匹配允许的主机名，防止 DNS Rebinding 攻击
 * @param {object} req - HTTP 请求对象
 * @param {string|string[]|Set<string>} [allowedHost] - 允许的主机名或主机列表
 * @returns {boolean}
 */
export function validateHost(req, allowedHost) {
  if (!req || !req.headers) return false;
  const hostHeader = req.headers.host || '';
  if (!hostHeader) return false;

  const rawHost = hostHeader.trim().toLowerCase();
  const hostWithoutPort = rawHost.split(':')[0];

  if (!allowedHost) return true;

  if (Array.isArray(allowedHost) || allowedHost instanceof Set) {
    const list = Array.from(allowedHost).map(h => String(h).trim().toLowerCase());
    return list.some(target => {
      const targetWithoutPort = target.split(':')[0];
      return rawHost === target || hostWithoutPort === targetWithoutPort;
    });
  }

  const target = String(allowedHost).trim().toLowerCase();
  const targetWithoutPort = target.split(':')[0];
  return rawHost === target || hostWithoutPort === targetWithoutPort;
}

/**
 * 时间恒定比较 API Key，消除针对密钥比较的计时侧信道攻击 (Timing Attack)
 * 先将两值进行 SHA-256 散列以保证 Buffer 长度严格一致（32 字节），再执行 crypto.timingSafeEqual
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeCompareKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!a || !b) return false;
  try {
    const hashA = createHash('sha256').update(a).digest();
    const hashB = createHash('sha256').update(b).digest();
    return timingSafeEqual(hashA, hashB);
  } catch {
    return false;
  }
}

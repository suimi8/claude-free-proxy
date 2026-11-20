// Untrusted destinations (web tools / image URLs) never use an upstream account or an environment proxy.
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const denied = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  denied.addSubnet(ip, bits, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
])
  denied.addSubnet(ip, bits, 'ipv6');
const error = (message, status = 400) => Object.assign(new Error(message), { status });
export function isPublicIP(address) {
  const n = isIP(address);
  if (n === 4) return !denied.check(address, 'ipv4');
  return (
    n === 6 && !address.includes('%') && global6.check(address, 'ipv6') && !denied.check(address, 'ipv6')
  );
}
export function publicURL(value, base) {
  let u;
  try {
    u = new URL(value, base);
  } catch {
    throw error('无效的远程 URL');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port)
    throw error('仅允许标准端口的公共 HTTP(S) URL，且不能带凭据');
  const host = u.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (
    isIP(host)
      ? !isPublicIP(host)
      : !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(host)
  )
    throw error('不允许访问该网络地址');
  return u;
}
// The socket uses precisely the validated DNS result, not a second resolution. Reject mixed answers.
export function publicLookup(resolve = lookup) {
  return (host, opts, cb) => {
    resolve(host, { all: true, verbatim: true })
      .then((rows) => {
        if (!rows.length || rows.some((r) => !isPublicIP(r.address))) throw error('域名未解析到公共地址');
        const family = typeof opts === 'number' ? opts : opts?.family;
        const candidates = rows.filter((r) => !family || r.family === family);
        if (!candidates.length) throw error('无可用的公共地址');
        if (opts?.all) cb(null, candidates);
        else cb(null, candidates[0].address, candidates[0].family);
      })
      .catch(cb);
  };
}
function requestPublic(u, { signal, accept }) {
  return new Promise((resolve, reject) => {
    const transport = u.protocol === 'https:' ? https : http;
    transport
      .get(
        u,
        {
          agent: false,
          lookup: publicLookup(),
          signal,
          headers: {
            accept,
            'accept-encoding': 'identity',
            'user-agent': 'Mozilla/5.0 (compatible; GatewayFetch/1.0)',
          },
        },
        resolve
      )
      .on('error', reject);
  });
}
// request is injectable for offline transport tests only (never derived from client input).
export async function fetchPublicBytes(
  value,
  {
    maxBytes = 2 * 1024 * 1024,
    timeoutMs = 15000,
    signal,
    accept = '*/*',
    image = false,
    request = requestPublic,
  } = {}
) {
  let u = publicURL(value);
  const timeout = AbortSignal.timeout(timeoutMs);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  for (let hops = 0; ; hops++) {
    deadline.throwIfAborted();
    const res = await request(u, { signal: deadline, accept });
    try {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (hops >= 4 || !res.headers.location) throw error('重定向无效或次数过多');
        const next = publicURL(res.headers.location, u);
        if (u.protocol === 'https:' && next.protocol !== 'https:') throw error('不允许 HTTPS 降级重定向');
        u = next;
        continue;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) throw error(`远程 HTTP ${res.statusCode}`, 502);
      const mime = String(res.headers['content-type'] || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (image && !mime.startsWith('image/')) throw error('远程资源不是图片');
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
        throw error('不接受压缩的远程正文', 502);
      if (Number(res.headers['content-length']) > maxBytes) throw error('远程正文超过大小限制', 413);
      let used = 0;
      const chunks = [];
      for await (const chunk of res) {
        deadline.throwIfAborted();
        used += chunk.length;
        if (used > maxBytes) throw error('远程正文超过大小限制', 413);
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks, used), mime };
    } finally {
      res.destroy();
    }
  }
}

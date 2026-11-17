// 把 VM 上跑出的 /tmp/claude-login-result.json 推进本机反代账号池。
// 用法: node tools/push-login-result.mjs <result.json 路径> [--label 自定义备注]
// API key 自动从 config.json 读，不落任何凭据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [,, resultPath] = process.argv;
if (!resultPath) { console.log('用法: node tools/push-login-result.mjs <result.json> [--label xxx]'); process.exit(1); }
const labelArg = (() => {
  const i = process.argv.indexOf('--label');
  return i > 0 ? process.argv[i + 1] : '';
})();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const key = (cfg.keys || [])[0]?.key || (cfg.keys || [])[0] || process.env.LOCAL_API_KEY;
if (!key) { console.log('config.json 里没有 API key'); process.exit(1); }

const r = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
if (!r.sessionKey) { console.log('result 里没有 sessionKey（登录没成功？）'); process.exit(1); }

const resp = await fetch('http://127.0.0.1:8787/v1/accounts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    label: labelArg || r.label,
    sessionKey: r.sessionKey,
    cookie: r.cookie,
    ua: r.ua,
    org: r.org,
    base: r.base,
  }),
  signal: AbortSignal.timeout(30000),
});
const text = await resp.text();
console.log(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
if (!resp.ok) process.exit(1);
console.log('✅ 已入池');

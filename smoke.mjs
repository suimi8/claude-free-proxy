// smoke.mjs —— start-proxy.ps1 用的真实调用冒烟测试
// 用法: node smoke.mjs <port> <key>
const port = process.argv[2] || '8787';
const key = process.argv[3] || '';
const base = `http://127.0.0.1:${port}/v1`;
const headers = { 'content-type': 'application/json' };
if (key) headers.authorization = `Bearer ${key}`;

try {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '只回复两个字：你好' }],
    }),
  });
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content;
  if (r.ok && text) {
    console.log(`  OK  ${text}`);
    if (j.usage) console.log(`  usage  ${JSON.stringify(j.usage)}`);
  } else {
    console.log(`  FAIL http=${r.status}  ${JSON.stringify(j.error || j).slice(0, 300)}`);
    process.exitCode = 1;
  }
} catch (e) {
  console.log(`  FAIL ${e.message}`);
  process.exitCode = 1;
}

// test_e2e.mjs —— 对真实上游做端到端回归
const base = 'http://127.0.0.1:8787/v1';
const H = { authorization: 'Bearer sk-local', 'content-type': 'application/json' };
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

async function chat(body) {
  const r = await fetch(base + '/chat/completions', {
    method: 'POST', headers: H, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

const weatherTool = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询城市天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}];

const results = [];

// 1) 流式 + tools（曾经挂死的组合）
{
  const t = Date.now();
  const r = await fetch(base + '/chat/completions', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model: 'claude-sonnet-4-5', stream: true,
      messages: [{ role: 'user', content: '广州天气？必须调用工具' }],
      tools: weatherTool,
    }),
  });
  const txt = await r.text();
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  const evs = [...txt.matchAll(/data: (.+)/g)].map(m => m[1]);
  const objs = evs.filter(c => c !== '[DONE]')
    .map(c => { try { return JSON.parse(c); } catch { return null; } })
    .filter(Boolean);
  const finish = objs.find(c => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason;
  const args = objs.flatMap(c => c.choices?.[0]?.delta?.tool_calls || [])
    .map(x => x.function?.arguments || '').join('');
  results.push(`[1] stream+tools  ${secs}s  finish=${finish}  args=${args}  DONE=${evs.includes('[DONE]')}`);
}

// 2) 非流式 + tools
{
  const { status, json } = await chat({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: '成都天气？必须调用工具' }],
    tools: weatherTool,
  });
  const c = json.choices?.[0];
  results.push(`[2] nonstream+tools  http=${status}  finish=${c?.finish_reason}  calls=${JSON.stringify(c?.message?.tool_calls)}`);
}

// 3) 流式纯文本 + 中文
{
  const t = Date.now();
  const r = await fetch(base + '/chat/completions', {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'claude-sonnet-4-5', stream: true, messages: [{ role: 'user', content: '数到三' }] }),
  });
  const txt = await r.text();
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  const content = [...txt.matchAll(/"content":"([^"]*)"/g)].map(m => m[1]).join('');
  results.push(`[3] stream text  ${secs}s  ${JSON.stringify(content.slice(0, 60))}  DONE=${txt.includes('[DONE]')}`);
}

// 4) 中文 + system
{
  const { json } = await chat({
    model: 'claude-haiku-5-5', system: '你是简洁的助手，只用中文回答',
    messages: [{ role: 'user', content: '只回复四个字：中文正常' }],
  });
  results.push(`[4] zh+system  ${JSON.stringify(json.choices?.[0]?.message?.content)}`);
}

// 5) 多轮记忆
{
  const { json } = await chat({
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'user', content: '我叫小红，记住它' },
      { role: 'assistant', content: '好的，小红' },
      { role: 'user', content: '我叫什么？只答名字' },
    ],
  });
  results.push(`[5] multiturn  ${JSON.stringify(json.choices?.[0]?.message?.content)}`);
}

// 6) /v1/messages 透传
{
  const r = await fetch(base + '/messages', {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: '只回复两个字：收到' }] }),
  });
  const j = await r.json();
  results.push(`[6] /v1/messages  ${JSON.stringify(j.content || j.error)}`);
}

// 7) 本地鉴权
{
  const r = await fetch(base + '/models');
  results.push(`[7] no-auth  http=${r.status} (期望 401)`);
}

console.log(results.join('\n'));
console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)}s`);

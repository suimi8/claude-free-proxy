/**
 * test_responses.mjs —— OpenAI Responses API 端点回归（打真实上游）
 *
 * 覆盖：非流式文本 / 流式文本 / 流式 tools / previous_response_id 续聊 /
 *       GET /v1/responses/{id} / 空 input 400 / 无鉴权 401
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const KEY = process.env.KEY || 'sk-local';
const H = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

let pass = 0, fail = 0;
function line(ok, name, extra = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`);
}

function parseEvents(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const em = block.match(/^event: (.+)$/m);
    const dm = block.match(/^data: (.+)$/m);
    if (!em || !dm) continue;
    try { out.push({ event: em[1], data: JSON.parse(dm[1]) }); } catch { /* skip */ }
  }
  return out;
}

const TOOLS = [{
  type: 'function',
  name: 'get_weather',
  description: '查询城市天气',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  strict: true,
}];

async function main() {
  // [1] 非流式文本
  let t0 = Date.now();
  let r = await fetch(`${BASE}/v1/responses`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'gpt-5', input: '用五个字回复：反代已就绪', instructions: '简洁回答', stream: false }),
  });
  let j = await r.json();
  const txt1 = j.output?.find(o => o.type === 'message')?.content?.[0]?.text || '';
  line(r.status === 200 && j.status === 'completed' && txt1.length > 0,
    '[1] 非流式文本',
    `${((Date.now() - t0) / 1000).toFixed(1)}s status=${j.status} text=${JSON.stringify(txt1).slice(0, 60)} usage=${j.usage ? j.usage.total_tokens + 'tok' : 'none'}`);
  if (r.status !== 200) console.log('    body=' + JSON.stringify(j).slice(0, 400));
  const respId = j.id;

  // [2] 流式文本（默认 stream）
  t0 = Date.now();
  r = await fetch(`${BASE}/v1/responses`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'gpt-5', input: '从1数到3，用顿号分隔' }),
  });
  const raw2 = await r.text();
  const evs2 = parseEvents(raw2);
  const names2 = [...new Set(evs2.map(e => e.event))];
  const text2 = evs2.filter(e => e.event === 'response.output_text.delta').map(e => e.data.delta).join('');
  const completed2 = evs2.find(e => e.event === 'response.completed');
  line(r.status === 200 && text2.length > 0 && completed2 && names2.includes('response.created'),
    '[2] 流式文本',
    `${((Date.now() - t0) / 1000).toFixed(1)}s events=${names2.length} text=${JSON.stringify(text2).slice(0, 60)} completed=${!!completed2}`);
  if (!text2.length) console.log('    raw=' + raw2.slice(0, 500));

  // [3] 流式 tools（Codex 类客户端的核心路径）
  t0 = Date.now();
  r = await fetch(`${BASE}/v1/responses`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model: 'gpt-5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '广州天气？必须调用工具' }] }],
      tools: TOOLS,
    }),
  });
  const raw3 = await r.text();
  const evs3 = parseEvents(raw3);
  const fcDelta = evs3.filter(e => e.event === 'response.function_call_arguments.delta').map(e => e.data.delta).join('');
  const fcDone = evs3.find(e => e.event === 'response.function_call_arguments.done');
  const itemAdded = evs3.find(e => e.event === 'response.output_item.added' && e.data.item?.type === 'function_call');
  const done3 = evs3.find(e => e.event === 'response.completed');
  const outTypes = (done3?.data.response.output || []).map(o => o.type);
  let argsOk = false;
  try { argsOk = JSON.parse(fcDone?.data.arguments || '{}').city === '广州'; } catch { /* noop */ }
  line(r.status === 200 && !!itemAdded && argsOk && outTypes.includes('function_call'),
    '[3] 流式 tools',
    `${((Date.now() - t0) / 1000).toFixed(1)}s args=${fcDone?.data.arguments} output=[${outTypes.join(',')}]`);
  if (!argsOk) console.log('    raw=' + raw3.slice(0, 600));

  // [4] GET /v1/responses/{id}
  r = await fetch(`${BASE}/v1/responses/${respId}`, { headers: H });
  j = await r.json();
  line(r.status === 200 && j.id === respId,
    '[4] GET /v1/responses/{id}', `http=${r.status} status=${j.status}`);

  // [5] previous_response_id 续聊
  t0 = Date.now();
  r = await fetch(`${BASE}/v1/responses`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'gpt-5', input: '我刚才让你回复哪五个字？只复述那五个字。', previous_response_id: respId, stream: false }),
  });
  j = await r.json();
  const txt5 = j.output?.find(o => o.type === 'message')?.content?.[0]?.text || '';
  line(r.status === 200 && txt5.includes('反代已就绪'),
    '[5] previous_response_id 续聊（记得上文）',
    `${((Date.now() - t0) / 1000).toFixed(1)}s text=${JSON.stringify(txt5).slice(0, 60)}`);

  // [6] 空 input -> 400
  r = await fetch(`${BASE}/v1/responses`, { method: 'POST', headers: H, body: JSON.stringify({ model: 'gpt-5', input: '' }) });
  j = await r.json();
  line(r.status === 400, '[6] 空 input 400', `http=${r.status} ${j.error?.type}`);

  // [7] 无鉴权 -> 401
  r = await fetch(`${BASE}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'x' }) });
  line(r.status === 401, '[7] 无鉴权 401', `http=${r.status}`);

  // [8] 旧端点没被新代码破坏
  r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: '回复：ok' }] }),
  });
  j = await r.json();
  line(r.status === 200 && !!j.choices?.[0]?.message?.content,
    '[8] /v1/chat/completions 未回归', `http=${r.status} reply=${JSON.stringify(j.choices?.[0]?.message?.content || '').slice(0, 40)}`);

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('ERR', e); process.exit(1); });

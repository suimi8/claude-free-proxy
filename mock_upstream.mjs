// mock_upstream.mjs —— 本地假 Anthropic 上游，用于验证 openai-proxy.mjs 的转换
import http from 'node:http';
const PORT = +(process.argv[2] || 8799);
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const req_ = JSON.parse(body || '{}');
  const model = req_.model || 'mock';
  console.error('[mock] headers', JSON.stringify({ auth: req.headers.authorization, key: req.headers['x-api-key'], beta: req.headers['anthropic-beta'] }));
  console.error('[mock] body', JSON.stringify(req_).slice(0, 600));

  if (req_.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: 'message_start', message: { id: 'msg_1', model, usage: { input_tokens: 11, output_tokens: 0 } } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const t of ['He', 'llo', ' 模拟']) ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"BJ"}' } });
    ev({ type: 'content_block_stop', index: 1 });
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } });
    ev({ type: 'message_stop' });
    res.end(); return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: '你好，来自 mock 上游' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 9 },
  }));
}).listen(PORT, '127.0.0.1', () => console.error('[mock] listening', PORT));

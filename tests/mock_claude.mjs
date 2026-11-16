/**
 * mock_claude.mjs —— claude.ai 格式的假上游，用来确定性验证多账号池
 *
 * 端点（与真实上游一致）：
 *   GET  /api/organizations
 *   POST /api/organizations/{org}/chat_conversations
 *   POST /api/organizations/{org}/chat_conversations/{id}/completion  -> SSE
 *
 * 通过 cookie 里的 sessionKey 区分账号，可对指定账号注入故障：
 *   FAKE_BAD=key1,key2     这些账号一律 429（验证 failover）
 *   FAKE_401=key1          这些账号一律 401（验证 auth 冷却）
 *   FAKE_LATENCY_MS=200    每次 completion 的延迟（验证并发）
 *   FAKE_QUOTA=0.9         message_limit 里回报的 5h 用量（验证 least-loaded）
 *
 * 请求体里带 marker 的 prompt 会在回复里回显，方便断言。
 */
import http from 'node:http';

const PORT = +(process.env.PORT || 8799);
let BAD = new Set((process.env.FAKE_BAD || '').split(',').map(s => s.trim()).filter(Boolean));
let UNAUTH = new Set((process.env.FAKE_401 || '').split(',').map(s => s.trim()).filter(Boolean));
// 配额耗尽型 429（exceeded_limit，带 resetsAt）——用来验证「429 耗尽池」
let RL = new Set((process.env.FAKE_RATELIMIT || '').split(',').map(s => s.trim()).filter(Boolean));
let RESETS_AT = +(process.env.FAKE_RESETS_AT || 0);
let LATENCY = +(process.env.FAKE_LATENCY_MS || 0);
let STREAM_DELAY = +(process.env.FAKE_STREAM_DELAY_MS || 0);   // 每条 SSE 事件间隔（慢速流式，断连测试用）
const HOLD = +(process.env.FAKE_HOLD_MS || 0);   // 内容发完后把连接吊着多久才关（模拟上游 keep-alive）
const QUOTA = process.env.FAKE_QUOTA != null ? +process.env.FAKE_QUOTA : 0.5;
let QUOTA_BY = {};   // 按 sessionKey 覆盖 5h 用量（验证“额度低于 20% 切换账号”）

const stats = { byAccount: {}, completions: 0, concurrent: 0, maxConcurrent: 0 };

function keyOf(req) {
  const c = req.headers.cookie || '';
  const m = /(?:^|;\s*)sessionKey=([^;]+)/.exec(c);
  return m ? m[1] : '(none)';
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  // STREAM_DELAY>0 时逐条慢发，模拟真实流式（供“客户端断连中止”测试制造窗口）
  const writeAll = async () => {
    for (const [ev, data] of events) {
      if (STREAM_DELAY > 0) await new Promise(r => setTimeout(r, STREAM_DELAY));
      if (res.destroyed) return;   // 对端（反代）已中止
      res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    // 内容发完了，但上游把连接吊着不关（真实 claude.ai 就是这样），
    // 这段时间对客户端是纯等待 —— 会被算进「生成速度」的分母
    if (HOLD > 0) {
      for (let left = HOLD; left > 0; left -= 15000) {
        await new Promise(r => setTimeout(r, Math.min(15000, left)));
        if (res.destroyed) return;
        res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);
      }
    }
    if (!res.destroyed) res.end();
  };
  writeAll().catch(e => console.warn('[mock-claude] sse write failed:', e.message));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = keyOf(req);

  let body = '';
  for await (const c of req) body += c;
  let parsed = {};
  try { parsed = body ? JSON.parse(body) : {}; } catch { /* noop */ }

  // ---- 组织列表（验证 org 自动发现）
  if (req.method === 'GET' && url.pathname === '/api/organizations') {
    if (UNAUTH.has(key)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid session', type: 'authentication_error' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify([
      { uuid: 'org-' + key.slice(-6), name: 'Mock Org', rate_limit_tier: 'default_claude_ai' },
    ]));
  }

  const m = /^\/api\/organizations\/([^/]+)\/chat_conversations$/.exec(url.pathname);
  if (req.method === 'POST' && m) {
    if (!parsed.uuid || !parsed.name) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'name: Field required', type: 'invalid_request_error' } }));
    }
    res.writeHead(201, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ uuid: parsed.uuid, name: parsed.name, is_temporary: !!parsed.is_temporary }));
  }

  const mc = /^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)\/completion$/.exec(url.pathname);
  if (req.method === 'POST' && mc) {
    stats.completions++;
    stats.byAccount[key] = (stats.byAccount[key] || 0) + 1;
    stats.concurrent++;
    stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
    const done = () => { stats.concurrent--; };

    if (UNAUTH.has(key)) {
      done();
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'session expired', type: 'authentication_error' } }));
    }
    if (RL.has(key)) {
      // 真实上游的「配额用尽」响应体（exceeded_limit + resetsAt），逐字照抄
      const resetsAt = RESETS_AT || Math.floor(Date.now() / 1000) + 3600;
      done();
      res.writeHead(429, { 'content-type': 'application/json' });
      const inner = JSON.stringify({
        type: 'exceeded_limit', resetsAt, remaining: null, perModelLimit: false,
        representativeClaim: 'five_hour', overageDisabledReason: 'usage_limit',
      });
      return res.end(JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: inner },
      }));
    }
    if (BAD.has(key)) {
      done();
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Rate limited. Please try again later.', type: 'rate_limit_error' } }));
    }
    if (!parsed.prompt) {
      done();
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'prompt: Field required', type: 'invalid_request_error' } }));
    }

    if (LATENCY) await new Promise(r => setTimeout(r, LATENCY));

    // 如果 prompt 里要求 tool，回一个 tool_use block（否则回文本）
    const wantTool = /\bTOOL\b/.test(parsed.prompt);
    const quota = typeof QUOTA_BY[key] === 'number' ? QUOTA_BY[key] : QUOTA;
    const msgId = 'chatcompl_' + Math.random().toString(36).slice(2, 14);
    const events = [['message_start', {
      type: 'message_start',
      message: { id: msgId, type: 'message', role: 'assistant', model: parsed.model || 'claude-sonnet-5-5', content: [] },
    }]];

    if (wantTool) {
      events.push(['content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'toolu_' + Math.random().toString(36).slice(2, 14), name: 'get_weather', input: {} },
      }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city": "广州"}' } }]);
      events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
      // 复现真实上游行为：tool_use 后不发 message_delta/message_stop，只发 ping
      events.push(['ping', { type: 'ping' }]);
      events.push(['message_limit', { type: 'message_limit', message_limit: { windows: { '5h': { utilization: quota, resets_at: Date.now() + 3600e3 } } } }]);
      done();
      return sse(res, events);
    }

    const text = `echo:${parsed.prompt.slice(0, 60)}`;
    events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]);
    for (let i = 0; i < text.length; i += 10) {
      events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 10) } }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
    events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }]);
    events.push(['message_limit', { type: 'message_limit', message_limit: { windows: { '5h': { utilization: quota, resets_at: Date.now() + 3600e3 } } } }]);
    events.push(['message_stop', { type: 'message_stop' }]);
    done();
    return sse(res, events);
  }

  if (url.pathname === '/__stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(stats, null, 2));
  }

  // 运行时改故障注入，免得测试为了制造 429 去改账号文件
  if (url.pathname === '/__config' && req.method === 'POST') {
    if (Array.isArray(parsed.bad)) BAD = new Set(parsed.bad);
    if (Array.isArray(parsed.unauth)) UNAUTH = new Set(parsed.unauth);
    if (Array.isArray(parsed.rateLimit)) RL = new Set(parsed.rateLimit);
    if (typeof parsed.resetsAt === 'number') RESETS_AT = parsed.resetsAt;
    if (typeof parsed.latency === 'number') LATENCY = parsed.latency;
    if (typeof parsed.streamDelay === 'number') STREAM_DELAY = parsed.streamDelay;
    if (parsed.quotaBy && typeof parsed.quotaBy === 'object') QUOTA_BY = parsed.quotaBy;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ bad: [...BAD], unauth: [...UNAUTH], rateLimit: [...RL], resetsAt: RESETS_AT, latency: LATENCY, streamDelay: STREAM_DELAY, quotaBy: QUOTA_BY }));
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-claude] http://127.0.0.1:${PORT}`);
  console.log(`[mock-claude] bad=${[...BAD] || '-'}  401=${[...UNAUTH] || '-'}  latency=${LATENCY}ms  quota=${QUOTA}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  webHeaders,
  isChallenge,
  parseResetsAt,
  parseLimitReason,
  classify,
  noteChallenge,
  cfStormActive,
  clearChallengeEvents,
  clientGoneError,
  isSocketResetError,
  upstreamError,
  createConversation,
  callCompletion,
  ClaudeWebClient,
} from '../src/claude-web-client.mjs';

import {
  COMPLETION_APIS,
  MESSAGES_POST_ALIASES,
  INFERENCE_ROUTES,
  handleStatic,
  handleTools,
  handleLogs,
  handleAdmin,
  handleInference,
  dispatchRequest,
  maskAccount,
  parseImportLines,
  json,
} from '../src/gateway-routes.mjs';

// ======================================================================
// 1. claude-web-client 模块单元测试
// ======================================================================
test('claude-web-client: webHeaders 生成符合规范的请求头', () => {
  const acct1 = { sessionKey: 'sk-test-123', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36' };
  const h1 = webHeaders(acct1);
  assert.equal(h1['cookie'], 'sessionKey=sk-test-123');
  assert.equal(h1['user-agent'], acct1.ua);
  assert.equal(h1['content-type'], 'application/json');
  assert.equal(h1['sec-ch-ua-platform'], '"Windows"');

  const acct2 = { cookie: 'sessionKey=custom; cf_clearance=abc', base: 'https://custom.claude.ai', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0 Safari/537.36' };
  const h2 = webHeaders(acct2);
  assert.equal(h2['cookie'], 'sessionKey=custom; cf_clearance=abc');
  assert.equal(h2['origin'], 'https://custom.claude.ai');
  assert.equal(h2['referer'], 'https://custom.claude.ai/');
  assert.equal(h2['sec-ch-ua-platform'], '"macOS"');
});

test('claude-web-client: isChallenge, parseResetsAt, parseLimitReason, classify 解析准确', () => {
  assert.equal(isChallenge('Just a moment... Enable JavaScript and cookies'), true);
  assert.equal(isChallenge('cf-browser-verification required'), true);
  assert.equal(isChallenge('{"error":{"message":"Normal error"}}'), false);

  // parseResetsAt
  assert.equal(parseResetsAt('{"resetsAt":1700000000}'), 1700000000000);
  assert.equal(parseResetsAt('{"resetsAt\\":\\"1700000000000\\"}'), 1700000000000);
  assert.equal(parseResetsAt('{"resetsAt":null}'), null);
  assert.equal(parseResetsAt(''), null);

  // parseLimitReason
  assert.equal(parseLimitReason('{"representativeClaim":"five_hour"}'), 'five_hour');
  assert.equal(parseLimitReason(''), '');

  // classify
  const c1 = classify(403, 'Just a moment...');
  assert.equal(c1.kind, 'challenge');
  assert.equal(c1.retryable, true);

  const c2 = classify(429, '{"resetsAt":null,"error":"concurrent_limit_reached"}');
  assert.equal(c2.kind, 'concurrency');
  assert.equal(c2.retryable, true);

  const c3 = classify(429, '{"resetsAt":1700000000,"representativeClaim":"five_hour"}');
  assert.equal(c3.kind, 'rate_limit');
  assert.equal(c3.resetsAt, 1700000000000);
  assert.equal(c3.reason, 'five_hour');

  const c4 = classify(401, 'Unauthorized');
  assert.equal(c4.kind, 'auth');

  const c5 = classify(502, 'Bad Gateway');
  assert.equal(c5.kind, 'transient');

  const c6 = classify(400, 'Bad Request');
  assert.equal(c6.kind, 'error');
  assert.equal(c6.retryable, false);
});

test('claude-web-client: CF challenge 风暴事件滑动窗口与判定', () => {
  clearChallengeEvents();
  assert.equal(cfStormActive().active, false);

  for (let i = 0; i < 9; i++) noteChallenge();
  assert.equal(cfStormActive().active, false);

  noteChallenge(); // 达到 10 次
  assert.equal(cfStormActive().active, true);
  assert.equal(cfStormActive().count >= 10, true);

  clearChallengeEvents();
  assert.equal(cfStormActive().active, false);
});

test('claude-web-client: clientGoneError 与 isSocketResetError', () => {
  const err = clientGoneError();
  assert.equal(err.name, 'AbortError');
  assert.equal(err.kind, 'client_gone');
  assert.equal(err.status, 499);

  assert.equal(isSocketResetError({ code: 'UND_ERR_SOCKET' }), true);
  assert.equal(isSocketResetError({ code: 'ECONNRESET' }), true);
  assert.equal(isSocketResetError({ cause: { code: 'ETIMEDOUT' } }), true);
  assert.equal(isSocketResetError(new Error('other side closed')), true);
  assert.equal(isSocketResetError(new Error('general error')), false);
  assert.equal(isSocketResetError(null), false);
});

test('claude-web-client: ClaudeWebClient 驱动类实例创建与方法透传', () => {
  const acct = { id: 'a1', sessionKey: 'sk-123', org: 'org-test' };
  const client = new ClaudeWebClient(acct);
  assert.equal(typeof client.getHeaders, 'function');
  assert.equal(typeof client.createConversation, 'function');
  assert.equal(typeof client.callCompletion, 'function');
  assert.equal(typeof client.fetch, 'function');

  const headers = client.getHeaders();
  assert.equal(headers['cookie'], 'sessionKey=sk-123');
});

// ======================================================================
// 2. gateway-routes 模块单元测试
// ======================================================================
test('gateway-routes: maskAccount 账号脱敏转换', () => {
  const acct = {
    id: 'acc_1',
    label: '测试账号',
    source: 'manual',
    enabled: true,
    org: 'org_xyz',
    base: 'https://claude.ai',
    sessionKey: 'sk-ant-sid02-secret-key-12345',
    cooldownUntil: Date.now() + 30000,
    stats: { ok: 10, fail: 1, lastError: '429' },
  };
  const masked = maskAccount(acct);
  assert.equal(masked.id, 'acc_1');
  assert.equal(masked.session_key, '••••');
  assert.ok(masked.cooldown_remaining_s > 0);
  assert.equal(masked.ok, 10);
  assert.equal(masked.fail, 1);
  assert.equal(masked.last_error, '429');
});

test('gateway-routes: parseImportLines 多格式凭据解析', () => {
  // 1. JSON 数组
  const jsonArr = JSON.stringify([
    { sessionKey: 'sk-ant-sid02-key1', label: 'acc 1' },
    { sessionKey: 'sk-ant-sid02-key2', label: 'acc 2' }
  ]);
  const res1 = parseImportLines(jsonArr);
  assert.equal(res1.length, 2);
  assert.equal(res1[0].sessionKey, 'sk-ant-sid02-key1');
  assert.equal(res1[0].label, 'acc 1');

  // 2. JSONL
  const jsonl = '{"sessionKey":"sk-ant-sid02-jsonl1","label":"acc l1"}\n{"sessionKey":"sk-ant-sid02-jsonl2","label":"acc l2"}';
  const res2 = parseImportLines(jsonl);
  assert.equal(res2.length, 2);
  assert.equal(res2[1].sessionKey, 'sk-ant-sid02-jsonl2');

  // 3. 分割线 ----
  const customLines = 'sk-ant-sid02-delim1 ---- 账号A\n账号B ---- sk-ant-sid02-delim2';
  const res3 = parseImportLines(customLines);
  assert.equal(res3.length, 2);
  assert.equal(res3[0].sessionKey, 'sk-ant-sid02-delim1');
  assert.equal(res3[0].label, '账号A');

  // 4. 单行 Cookie
  const cookieLine = 'sessionKey=sk-ant-sid02-rawcookie; cf_clearance=xyz';
  const res4 = parseImportLines(cookieLine);
  assert.equal(res4.length, 1);
  assert.equal(res4[0].sessionKey, 'sk-ant-sid02-rawcookie');
});

function mockRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.body = '';
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    Object.assign(res.headers, headers);
  };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.write = chunk => { res.body += chunk; return true; };
  res.end = chunk => { if (chunk) res.body += chunk; res.emit('finish'); return res; };
  return res;
}

test('gateway-routes: handleStatic 处理基础探活与版本', async () => {
  const res1 = mockRes();
  const req1 = { method: 'GET', url: '/readyz' };
  const handled1 = await handleStatic(req1, res1, new URL('http://127.0.0.1/readyz'), {});
  assert.ok(handled1);
  assert.equal(res1.statusCode, 200);
  assert.ok(res1.body.includes('ready'));

  const res2 = mockRes();
  const req2 = { method: 'GET', url: '/v1/version' };
  const helpers2 = { updates: { status: () => ({ current: '0.5.5' }) } };
  const handled2 = await handleStatic(req2, res2, new URL('http://127.0.0.1/v1/version'), helpers2);
  assert.ok(handled2);
  assert.equal(res2.statusCode, 200);
  assert.ok(res2.body.includes('0.5.5'));
});

test('gateway-routes: handleTools 处理搜索与内容抓取', async () => {
  const res1 = mockRes();
  const req1 = { method: 'GET', url: '/v1/tools/search?q=test' };
  const helpers1 = {
    searchDuckDuckGo: async (q, count) => [{ url: 'https://example.com', title: 'Test' }]
  };
  const handled1 = await handleTools(req1, res1, new URL('http://127.0.0.1' + req1.url), null, helpers1);
  assert.ok(handled1);
  assert.equal(res1.statusCode, 200);
  assert.ok(res1.body.includes('https://example.com'));

  const res2 = mockRes();
  const req2 = { method: 'GET', url: '/v1/tools/fetch?url=https://example.com' };
  const helpers2 = {
    fetchWebContent: async url => 'example page content'
  };
  const handled2 = await handleTools(req2, res2, new URL('http://127.0.0.1' + req2.url), null, helpers2);
  assert.ok(handled2);
  assert.equal(res2.statusCode, 200);
  assert.ok(res2.body.includes('example page content'));
});

test('gateway-routes: handleLogs 查询审计与用量', async () => {
  const res1 = mockRes();
  const req1 = { method: 'GET', url: '/v1/operations' };
  const helpers1 = {
    queryOperations: () => ({ operations: [], total: 0 }),
    getOperationStats: () => ({ total: 0 }),
  };
  const handled1 = await handleLogs(req1, res1, new URL('http://127.0.0.1' + req1.url), helpers1);
  assert.ok(handled1);
  assert.equal(res1.statusCode, 200);
  assert.ok(res1.body.includes('"ok":true'));
});

test('gateway-routes: dispatchRequest 跨站检测与基础路由派发', async () => {
  // 1. 跨站拦截
  const res1 = mockRes();
  const req1 = {
    method: 'GET',
    url: '/v1/models',
    headers: { host: '127.0.0.1:8787', origin: 'http://evil.com' },
  };
  await dispatchRequest(req1, res1, {});
  assert.equal(res1.statusCode, 403);
  assert.ok(res1.body.includes('不允许跨站访问'));

  // 2. OPTIONS 请求返回 204
  const res2 = mockRes();
  const req2 = {
    method: 'OPTIONS',
    url: '/v1/chat/completions',
    headers: { host: '127.0.0.1:8787' },
  };
  await dispatchRequest(req2, res2, {});
  assert.equal(res2.statusCode, 204);
});

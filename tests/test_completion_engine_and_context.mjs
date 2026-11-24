import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CompletionEngine,
  createCompletionEngine,
  messageToChat,
  mapModel,
  mapTools,
  prepareContext,
  buildUpstreamBody,
  completionErrorStatus,
  recordCompletion,
  modelList,
} from '../src/completion-engine.mjs';

import {
  ServerContext,
  createServerContext,
  resolveServerContext,
} from '../src/gateway-routes.mjs';

// ======================================================================
// Part 1: completion-engine.mjs 单元测试
// ======================================================================
test('completion-engine: mapModel 映射 Claude 模型', () => {
  assert.equal(mapModel('claude-3-5-haiku-20241022'), 'claude-haiku-5-5');
  assert.equal(mapModel('claude-3-5-sonnet-20241022'), 'claude-sonnet-5-5');
  assert.equal(mapModel('claude-opus-4-0'), 'claude-sonnet-5-5');
  assert.equal(mapModel(null), 'claude-sonnet-5-5');
  assert.throws(() => mapModel(123), /model must be a string/);
});

test('completion-engine: messageToChat 规范化多模态与工具消息', () => {
  // 1. 普通文本
  const m1 = { role: 'user', content: 'hello' };
  assert.deepEqual(messageToChat(m1), [{ role: 'user', content: 'hello' }]);

  // 2. assistant tool_use 转换
  const m2 = {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'test' } },
    ],
  };
  const res2 = messageToChat(m2);
  assert.equal(res2.length, 1);
  assert.equal(res2[0].role, 'assistant');
  assert.equal(res2[0].tool_calls?.[0].id, 'call_1');
  assert.equal(res2[0].tool_calls?.[0].function.name, 'search');
  assert.equal(res2[0].tool_calls?.[0].function.arguments, '{"q":"test"}');

  // 3. user tool_result 拆分
  const m3 = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: 'search result' },
      { type: 'text', text: 'what next?' },
    ],
  };
  const res3 = messageToChat(m3);
  assert.equal(res3.length, 2);
  assert.equal(res3[0].role, 'tool');
  assert.equal(res3[0].tool_call_id, 'call_1');
  assert.equal(res3[0].content, 'search result');
  assert.equal(res3[1].role, 'user');
  assert.equal(res3[1].content, 'what next?');
});

test('completion-engine: mapTools 统一归一化各种协议工具', () => {
  assert.equal(mapTools(null), undefined);
  assert.equal(mapTools([]), undefined);

  const tools = [
    { type: 'function', function: { name: 'f1', description: 'desc1', parameters: { type: 'object' } } },
    { name: 'f2', description: 'desc2', parameters: { type: 'object' } },
  ];
  const mapped = mapTools(tools);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].name, 'f1');
  assert.equal(mapped[0].description, 'desc1');
  assert.equal(mapped[1].name, 'f2');
});

test('completion-engine: prepareContext 与 buildUpstreamBody 上下文装配', () => {
  const pool = { data: { pruneContext: false } };
  const body = {
    messages: [{ role: 'user', content: 'test message' }],
  };
  const prep = prepareContext(body, pool);
  assert.equal(prep.messages.length, 1);

  const up = buildUpstreamBody(prep, 'claude-sonnet-5-5', { pool, tz: 'UTC' });
  assert.equal(up.model, 'claude-sonnet-5-5');
  assert.equal(up.timezone, 'UTC');
  assert.ok(up.prompt.includes('test message'));
  assert.ok(up.parent_message_uuid);
});

test('completion-engine: completionErrorStatus 与 recordCompletion', () => {
  assert.equal(completionErrorStatus({ name: 'AbortError' }), 499);
  assert.equal(completionErrorStatus({ kind: 'challenge' }), 502);
  assert.equal(completionErrorStatus({ kind: 'transient' }), 502);
  assert.equal(completionErrorStatus({ kind: 'rate_limit' }), 429);
  assert.equal(completionErrorStatus({ kind: 'concurrency' }), 429);
  assert.equal(completionErrorStatus({ kind: 'auth' }), 401);
  assert.equal(completionErrorStatus({ status: 404 }), 404);

  const recorded = [];
  const fakeUsage = { record: ctx => recorded.push(ctx) };
  const traceCtx = { startedAt: Date.now() - 50 };
  recordCompletion(traceCtx, 200, '', fakeUsage);
  assert.equal(traceCtx.status, 200);
  assert.equal(traceCtx.ok, true);
  assert.equal(recorded.length, 1);
});

test('completion-engine: CompletionEngine 实例包装方法', () => {
  const fakePool = { data: { pruneContext: false } };
  const engine = createCompletionEngine({
    pool: fakePool,
    getUpstream: () => ({ models: ['claude-sonnet-5-5'] }),
  });
  assert.equal(engine.mapModel('haiku'), 'claude-haiku-5-5');
  const models = engine.modelList();
  assert.ok(Array.isArray(models));
  assert.ok(models.some(m => m.id === 'claude-sonnet-5-5'));
});

// ======================================================================
// Part 2: ServerContext 服务容器单元测试
// ======================================================================
test('ServerContext: 领域隔离与结构化访问', () => {
  const services = {
    auth: { authenticate: () => ({ ok: true }) },
    accounts: { pool: { total: 3 } },
    pool: { total: 3 },
    logs: { logOperation: () => {} },
  };
  const engine = {
    completionEngine: { mapModel: m => 'sonnet' },
  };
  const config = {
    keys: { keyCount: () => 2 },
    server: { port: 8787 },
  };

  const ctx = createServerContext({ services, engine, config });
  assert.equal(ctx.services.auth.authenticate().ok, true);
  assert.equal(ctx.services.pool.total, 3);
  assert.equal(ctx.engine.completionEngine.mapModel('test'), 'sonnet');
  assert.equal(ctx.config.server.port, 8787);

  // 向后兼容扁平属性访问 (通过 Proxy 拦截)
  assert.equal(ctx.authenticate().ok, true);
  assert.equal(ctx.POOL.total, 3);
  assert.equal(ctx.mapModel('test'), 'sonnet');
  assert.equal(ctx.KEYS.keyCount(), 2);
});

test('ServerContext: resolveServerContext 正确兼容老旧 flat helpers 对象', () => {
  const legacyHelpers = {
    POOL: { status: () => ({ total: 5 }) },
    KEYS: { keyCount: () => 1 },
    searchDuckDuckGo: async () => [],
    mapModel: () => 'claude-haiku-5-5',
    isLoopbackReq: () => true,
  };

  const ctx = resolveServerContext(legacyHelpers);
  assert.ok(ctx instanceof ServerContext);
  assert.equal(ctx.services.pool.status().total, 5);
  assert.equal(ctx.config.keys.keyCount(), 1);
  assert.equal(typeof ctx.services.tools.searchDuckDuckGo, 'function');
  assert.equal(ctx.engine.completionEngine.mapModel(), 'claude-haiku-5-5');
  assert.equal(ctx.services.auth.isLoopbackReq(), true);

  // 扁平透传依然生效
  assert.equal(ctx.POOL.status().total, 5);
  assert.equal(ctx.isLoopbackReq(), true);
});

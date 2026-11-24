import test from 'node:test';
import assert from 'node:assert/strict';

// 1. 直接导入新抽离的独立模块
import {
  decodeHtmlEntities,
  searchDuckDuckGo,
  fetchWebContent,
} from '../src/external-tools.mjs';

import {
  newRespId,
  newItemId,
  rememberResponse,
  getResponse,
  clearResponses,
  RESP_STORE,
  normalizeTool,
  responsesInputToMessages,
  responsesToChat,
  responsesUsage,
  responseStatus,
  respShell,
  sendResponsesResult,
} from '../src/responses-api.mjs';

import {
  mapStopReason,
  newChatId,
  chatUsage,
  resolveFinish,
  ant2oaiText,
  collect,
  heartbeat,
  streamToClient,
} from '../src/chat-protocol.mjs';

// 2. 导入主入口进行向后兼容性验证
import * as ProxyExports from '../src/openai-proxy.mjs';

// ======================================================================
// Part 1: external-tools.mjs 单元测试
// ======================================================================
test('external-tools: decodeHtmlEntities 正确解码常规实体、十进制和十六进制', () => {
  assert.equal(decodeHtmlEntities(null), '');
  assert.equal(decodeHtmlEntities(undefined), '');
  assert.equal(decodeHtmlEntities(123), '');
  assert.equal(decodeHtmlEntities(''), '');

  // 基础实体
  const html = '&lt;div class=&quot;box&quot;&gt;Tom &amp; &#39;Jerry&#39; &nbsp; &#x27;fun&#x27;&lt;/div&gt;';
  assert.equal(decodeHtmlEntities(html), '<div class="box">Tom & \'Jerry\'   \'fun\'</div>');

  // 十进制与十六进制数字实体 (含 Unicode 汉字)
  const numeric = '&#65;&#66;&#67; &#x41;&#x42;&#x43; &#20320;&#x597d;';
  assert.equal(decodeHtmlEntities(numeric), 'ABC ABC 你好');
});

test('external-tools: searchDuckDuckGo 入参校验与空值处理', async () => {
  assert.deepEqual(await searchDuckDuckGo(''), []);
  assert.deepEqual(await searchDuckDuckGo('   '), []);
  assert.deepEqual(await searchDuckDuckGo(null), []);
  assert.deepEqual(await searchDuckDuckGo(undefined), []);
});

test('external-tools: fetchWebContent 入参校验', async () => {
  await assert.rejects(
    async () => fetchWebContent(''),
    (err) => err.status === 400 && err.message.includes('url is required')
  );
  await assert.rejects(
    async () => fetchWebContent(null),
    (err) => err.status === 400
  );
});

// ======================================================================
// Part 2: responses-api.mjs 单元测试
// ======================================================================
test('responses-api: newRespId 与 newItemId 格式校验', () => {
  const respId = newRespId();
  assert.match(respId, /^resp_[a-f0-9]{32}$/, 'newRespId 应符合 resp_ + 32位hex 格式');

  const callId = newItemId('call');
  assert.match(callId, /^call_[a-f0-9]{24}$/, 'newItemId 应生成指定前缀及24位ID');

  const msgId = newItemId('msg');
  assert.match(msgId, /^msg_[a-f0-9]{24}$/);
});

test('responses-api: RESP_STORE 缓存管理、检索与 FIFO 淘汰', () => {
  clearResponses();
  assert.equal(RESP_STORE.size, 0);

  // 1. 正常存储与获取
  const id1 = newRespId();
  rememberResponse('user_1', id1, { store: true, id: id1 }, [{ role: 'user', content: 'hi' }]);
  assert.equal(RESP_STORE.size, 1);
  const found = getResponse(id1);
  assert.ok(found);
  assert.equal(found.owner, 'user_1');
  assert.equal(found.response.id, id1);
  assert.equal(found.messages.length, 1);

  // 2. store: false 时不暂存
  const idNoStore = newRespId();
  rememberResponse('user_1', idNoStore, { store: false, id: idNoStore }, []);
  assert.equal(getResponse(idNoStore), undefined, 'store=false 不应暂存');

  // 3. FIFO 淘汰至最大 50 条
  clearResponses();
  for (let i = 0; i < 55; i++) {
    const id = `resp_test_${i}`;
    rememberResponse('user_1', id, { store: true, i }, []);
  }
  assert.equal(RESP_STORE.size, 50, '容量应被严格限制在 50 条');
  assert.equal(getResponse('resp_test_0'), undefined, '前 5 条应已被 FIFO 淘汰');
  assert.ok(getResponse('resp_test_54'), '最新的应在缓存中');
  clearResponses();
});

test('responses-api: normalizeTool 统一转换各类工具格式', () => {
  // 1. OpenAI Chat 格式
  const t1 = {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather info',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  };
  const n1 = normalizeTool(t1);
  assert.equal(n1.name, 'get_weather');
  assert.equal(n1.description, 'Get weather info');
  assert.deepEqual(n1.parameters, t1.function.parameters);

  // 2. Responses API function 格式 (无嵌套 function 对象)
  const t2 = {
    type: 'function',
    name: 'calc',
    description: 'calculator',
    parameters: { type: 'object' },
  };
  const n2 = normalizeTool(t2);
  assert.equal(n2.name, 'calc');
  assert.equal(n2.description, 'calculator');

  // 3. Codex CLI custom / hosted 工具 (如 bash_tool, local_shell)
  const t3 = {
    type: 'custom',
    name: 'bash_tool',
    description: 'Execute bash command',
    format: { type: 'object', properties: { cmd: { type: 'string' } } },
  };
  const n3 = normalizeTool(t3);
  assert.equal(n3.name, 'bash_tool');
  assert.deepEqual(n3.parameters, t3.format);

  // 4. Anthropic 格式 (input_schema)
  const t4 = {
    name: 'search_docs',
    input_schema: { type: 'object', properties: { q: { type: 'string' } } },
  };
  const n4 = normalizeTool(t4);
  assert.equal(n4.name, 'search_docs');
  assert.deepEqual(n4.parameters, t4.input_schema);

  // 5. 非法工具对象容错
  assert.equal(normalizeTool(null), null);
  assert.equal(normalizeTool({}), null);
});

test('responses-api: responsesInputToMessages 解析文本、多模态、工具调用与输出', () => {
  // 1. 简单字符串
  assert.deepEqual(responsesInputToMessages('Hello Claude'), [{ role: 'user', content: 'Hello Claude' }]);
  assert.deepEqual(responsesInputToMessages(''), []);
  assert.deepEqual(responsesInputToMessages(null), []);

  // 2. 混合条目：消息、函数调用、函数执行结果
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check weather' }] },
    {
      type: 'function_call',
      call_id: 'call_123',
      name: 'get_weather',
      arguments: '{"city":"Tokyo"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_123',
      output: 'Sunny 22C',
    },
    {
      type: 'custom_tool_call',
      call_id: 'call_custom_1',
      name: 'bash_tool',
      arguments: '{"cmd":"ls"}',
    },
    {
      type: 'local_shell_call_output',
      call_id: 'call_custom_1',
      output: 'file1.txt\nfile2.txt',
    },
    { type: 'reasoning', id: 'rs_ignore' }, // 应被忽略
  ];

  const messages = responsesInputToMessages(input);
  assert.equal(messages.length, 5);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'Check weather');

  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].tool_calls[0].id, 'call_123');
  assert.equal(messages[1].tool_calls[0].function.name, 'get_weather');

  assert.equal(messages[2].role, 'tool');
  assert.equal(messages[2].tool_call_id, 'call_123');
  assert.equal(messages[2].name, 'get_weather');
  assert.equal(messages[2].content, 'Sunny 22C');

  assert.equal(messages[3].role, 'assistant');
  assert.equal(messages[3].tool_calls[0].function.name, 'bash_tool');

  assert.equal(messages[4].role, 'tool');
  assert.equal(messages[4].tool_call_id, 'call_custom_1');
  assert.equal(messages[4].content, 'file1.txt\nfile2.txt');
});

test('responses-api: responsesToChat 整合指令、历史续聊与工具配置', () => {
  clearResponses();
  // 1. 基础转换 + instructions
  const rb = {
    instructions: 'You are a helpful coding assistant.',
    input: 'Write a quicksort',
    reasoning: { effort: 'high' },
  };
  const chat = responsesToChat(rb, 'user_1');
  assert.equal(chat.system, 'You are a helpful coding assistant.');
  assert.equal(chat.reasoning_effort, 'high');
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].content, 'Write a quicksort');

  // 2. 结构化输出 json_schema
  const rbSchema = {
    input: 'List 3 colors',
    text: { format: { type: 'json_schema', name: 'Colors', schema: { type: 'array' } } },
  };
  const chatSchema = responsesToChat(rbSchema, 'user_1');
  assert.ok(chatSchema.system.includes('JSON Schema (Colors)'));

  // 3. previous_response_id 续聊
  const prevId = newRespId();
  rememberResponse('user_1', prevId, { store: true }, [
    { role: 'user', content: 'Turn 1' },
    { role: 'assistant', content: 'Ans 1' },
  ]);
  const rbContinuation = {
    previous_response_id: prevId,
    input: 'Turn 2',
  };
  const chatCont = responsesToChat(rbContinuation, 'user_1');
  assert.equal(chatCont.messages.length, 3);
  assert.equal(chatCont.messages[0].content, 'Turn 1');
  assert.equal(chatCont.messages[1].content, 'Ans 1');
  assert.equal(chatCont.messages[2].content, 'Turn 2');

  // 4. previous_response_id 跨用户访问拦截
  assert.throws(
    () => responsesToChat(rbContinuation, 'user_other'),
    (err) => err.status === 404
  );
  clearResponses();
});

test('responses-api: responsesUsage 与 responseStatus', () => {
  const usage = responsesUsage({ input_tokens: 100, output_tokens: 50, think_tokens: 20 });
  assert.deepEqual(usage, {
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 20 },
  });

  assert.equal(responseStatus('max_tokens'), 'incomplete');
  assert.equal(responseStatus('end_turn'), 'completed');
  assert.equal(responseStatus('tool_use'), 'completed');
});

test('responses-api: respShell 结构完整性校验', () => {
  const shell = respShell({ instructions: 'Be concise' }, 'claude-3-7-sonnet', 'resp_123', 1700000000, 'completed', []);
  assert.equal(shell.id, 'resp_123');
  assert.equal(shell.object, 'response');
  assert.equal(shell.created_at, 1700000000);
  assert.equal(shell.model, 'claude-3-7-sonnet');
  assert.equal(shell.status, 'completed');
  assert.equal(shell.instructions, 'Be concise');
  assert.equal(shell.error, null);
  assert.deepEqual(shell.output, []);
});

test('responses-api: sendResponsesResult 非流式响应与缓存存档', async () => {
  clearResponses();
  const mockRun = {
    ctx: { input_tokens: 15, output_tokens: 10, think_tokens: 0 },
    events: async function* () {
      yield { type: 'message_start', message: { id: 'msg_1', model: 'claude-3-7-sonnet' } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello, World!' } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
    },
  };

  let writtenCode = 0;
  let writtenBody = null;
  const mockRes = {
    writeHead(code, headers) { writtenCode = code; },
    end(body) { writtenBody = body ? JSON.parse(body.toString()) : null; },
  };

  const id = newRespId();
  const result = await sendResponsesResult(mockRes, mockRun, 'claude-3-7-sonnet', id, { stream: false }, [], 'owner_a');

  assert.equal(writtenCode, 200);
  assert.ok(writtenBody);
  assert.equal(writtenBody.id, id);
  assert.equal(writtenBody.status, 'completed');
  assert.equal(writtenBody.output.length, 1);
  assert.equal(writtenBody.output[0].type, 'message');
  assert.equal(writtenBody.output[0].content[0].text, 'Hello, World!');

  // 验证已存档进 RESP_STORE
  const stored = getResponse(id);
  assert.ok(stored);
  assert.equal(stored.owner, 'owner_a');
  clearResponses();
});

test('responses-api: sendResponsesResult 流式响应与伪工具兜底', async () => {
  const mockRun = {
    ctx: { input_tokens: 10, output_tokens: 25, think_tokens: 0 },
    events: async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      // 模拟模型输出 XML 伪工具调用
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Result is: <invoke name="calculator"><arg name="expr">2+2</arg></invoke>' } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
    },
  };

  const writtenChunks = [];
  const mockRes = {
    write(chunk) { writtenChunks.push(chunk); },
    end() {},
  };

  const id = newRespId();
  await sendResponsesResult(mockRes, mockRun, 'claude-3-7-sonnet', id, { stream: true }, [], 'owner_b');

  const fullText = writtenChunks.join('');
  assert.ok(fullText.includes('event: response.created'), '应输出 response.created');
  assert.ok(fullText.includes('response.function_call_arguments.delta'), '应将伪工具转为原生 function_call 事件');
  assert.ok(fullText.includes('calculator'), '应包含计算器工具名');
  assert.ok(fullText.includes('event: response.completed'));
});

// ======================================================================
// Part 3: chat-protocol.mjs 单元测试
// ======================================================================
test('chat-protocol: mapStopReason 停止原因映射', () => {
  assert.equal(mapStopReason('tool_use'), 'tool_calls');
  assert.equal(mapStopReason('max_tokens'), 'length');
  assert.equal(mapStopReason('stop_sequence'), 'stop');
  assert.equal(mapStopReason('refusal'), 'content_filter');
  assert.equal(mapStopReason('end_turn'), 'stop');
  assert.equal(mapStopReason(null), 'stop');
});

test('chat-protocol: newChatId 格式校验', () => {
  const cid = newChatId();
  assert.match(cid, /^chatcmpl-[a-f0-9-]+$/);
});

test('chat-protocol: chatUsage 与 resolveFinish', () => {
  assert.deepEqual(chatUsage({ input_tokens: 20, output_tokens: 30 }), {
    prompt_tokens: 20,
    completion_tokens: 30,
    total_tokens: 50,
  });
  assert.deepEqual(chatUsage(null), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });

  // 工具调用优先
  assert.equal(resolveFinish({ toolCalls: [{ id: 'tc_1' }], stop: 'end_turn' }), 'tool_calls');
  // 无工具调用时跟随上游 stop 状态
  assert.equal(resolveFinish({ toolCalls: [], stop: 'max_tokens' }), 'length');
  assert.equal(resolveFinish({ toolCalls: [], stop: 'end_turn' }), 'stop');
});

test('chat-protocol: ant2oaiText 将聚合结果序列化为 OpenAI Chat Completion', () => {
  const result = {
    id: 'test_uuid',
    model: 'claude-3-7-sonnet',
    text: 'Hello there!',
    toolCalls: [],
    stop: 'end_turn',
    reasoning: 'Thinking deeply...',
  };
  const ctx = { input_tokens: 12, output_tokens: 8 };
  const oai = ant2oaiText(result, 'claude-3-7-sonnet', ctx);

  assert.equal(oai.object, 'chat.completion');
  assert.equal(oai.id, 'chatcmpl-test_uuid');
  assert.equal(oai.model, 'claude-3-7-sonnet');
  assert.equal(oai.choices[0].message.role, 'assistant');
  assert.equal(oai.choices[0].message.content, 'Hello there!');
  assert.equal(oai.choices[0].message.reasoning_content, 'Thinking deeply...');
  assert.equal(oai.choices[0].finish_reason, 'stop');
  assert.deepEqual(oai.usage, { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
});

test('chat-protocol: collect 收集正文、思考与工具调用，并支持伪工具回退', async () => {
  // 1. 正常原生工具流
  const nativeEvents = (async function* () {
    yield { type: 'message_start', message: { id: 'm1', model: 'claude-3-7-sonnet' } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan a' } };
    yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'search' } };
    yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"antigravity"}' } };
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } };
  })();

  const r1 = await collect(nativeEvents, {});
  assert.equal(r1.reasoning, 'plan a');
  assert.equal(r1.toolCalls.length, 1);
  assert.equal(r1.toolCalls[0].function.name, 'search');
  assert.equal(r1.toolCalls[0].function.arguments, '{"q":"antigravity"}');
  assert.equal(r1.stop, 'tool_use');

  // 2. 伪工具转换 (模型在正文中输出了 XML 工具标记)
  const pseudoEvents = (async function* () {
    yield { type: 'message_start', message: { id: 'm2', model: 'claude-3-7-sonnet' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here: <invoke name="lookup"><arg name="id">42</arg></invoke>' } };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
  })();

  const r2 = await collect(pseudoEvents, {});
  assert.equal(r2.stop, 'tool_use');
  assert.equal(r2.toolCalls.length, 1);
  assert.equal(r2.toolCalls[0].function.name, 'lookup');
  assert.ok(r2.toolCalls[0].function.arguments.includes('42'));
});

test('chat-protocol: heartbeat 维持心跳并能安全停止', () => {
  const written = [];
  const mockRes = {
    destroyed: false,
    writableEnded: false,
    write(str) { written.push(str); },
  };

  const stop1 = heartbeat(mockRes, false);
  assert.ok(written.includes(': keep-alive\n\n'));
  stop1();

  written.length = 0;
  const stop2 = heartbeat(mockRes, true);
  assert.ok(written.some((w) => w.includes('event: ping')));
  stop2();
});

test('chat-protocol: streamToClient 下发完整 OpenAI 兼容流式 Chunk', async () => {
  const mockRun = {
    ctx: { input_tokens: 8, output_tokens: 14 },
    events: async function* () {
      yield { type: 'message_start' };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Streaming chunk 1. ' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Streaming chunk 2.' } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
    },
  };

  const chunks = [];
  let ended = false;
  const mockRes = {
    destroyed: false,
    writableEnded: false,
    write(c) { chunks.push(c); },
    end(c) { if (c) chunks.push(c); ended = true; },
  };

  await streamToClient(mockRes, mockRun, 'claude-3-7-sonnet', 'chatcmpl-test', true);

  assert.ok(ended, '流应被结束');
  const full = chunks.join('');
  assert.ok(full.includes('chat.completion.chunk'));
  assert.ok(full.includes('"finish_reason":"stop"'));
  assert.ok(full.includes('data: [DONE]'));
  assert.ok(full.includes('"prompt_tokens":8'));

  // 聚合所有 chunk 的 delta.content，验证文本完整性
  const content = chunks
    .map((c) => {
      const match = c.match(/^data: ({.*})$/m);
      if (!match) return '';
      try {
        const obj = JSON.parse(match[1]);
        return obj.choices?.[0]?.delta?.content || '';
      } catch {
        return '';
      }
    })
    .join('');
  assert.equal(content, 'Streaming chunk 1. Streaming chunk 2.');
});

// ======================================================================
// Part 4: 完整向后兼容性验证 (从 src/openai-proxy.mjs 导入验证)
// ======================================================================
test('openai-proxy: 确保所有抽离出的外置工具与协议适配方法在主入口仍然可访问', () => {
  // external-tools
  assert.equal(typeof ProxyExports.decodeHtmlEntities, 'function');
  assert.equal(typeof ProxyExports.searchDuckDuckGo, 'function');
  assert.equal(typeof ProxyExports.fetchWebContent, 'function');

  // responses-api
  assert.equal(typeof ProxyExports.newRespId, 'function');
  assert.equal(typeof ProxyExports.newItemId, 'function');
  assert.equal(typeof ProxyExports.rememberResponse, 'function');
  assert.equal(typeof ProxyExports.getResponse, 'function');
  assert.ok(ProxyExports.RESP_STORE instanceof Map);
  assert.equal(typeof ProxyExports.responsesInputToMessages, 'function');
  assert.equal(typeof ProxyExports.responsesToChat, 'function');
  assert.equal(typeof ProxyExports.responsesUsage, 'function');
  assert.equal(typeof ProxyExports.responseStatus, 'function');
  assert.equal(typeof ProxyExports.respShell, 'function');
  assert.equal(typeof ProxyExports.sendResponsesResult, 'function');
  assert.equal(typeof ProxyExports.normalizeTool, 'function');

  // chat-protocol
  assert.equal(typeof ProxyExports.mapStopReason, 'function');
  assert.equal(typeof ProxyExports.newChatId, 'function');
  assert.equal(typeof ProxyExports.chatUsage, 'function');
  assert.equal(typeof ProxyExports.resolveFinish, 'function');
  assert.equal(typeof ProxyExports.ant2oaiText, 'function');
  assert.equal(typeof ProxyExports.collect, 'function');
  assert.equal(typeof ProxyExports.heartbeat, 'function');
  assert.equal(typeof ProxyExports.streamToClient, 'function');
});

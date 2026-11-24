/**
 * test_architectural_improvements.mjs
 *
 * 验证三大核心架构完善特性：
 * 1. 敏感凭据透明字段级 AES-256-GCM 安全保险库与账号池集成（包含明文向后兼容）
 * 2. 外部搜索工具的 LRU+TTL 缓存与并发去重合并
 * 3. Responses API 状态持久化、容量弹性与 TTL 淘汰机制
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import {
  encryptField,
  decryptField,
  getVaultKey,
  resetVaultKey,
  isVaultActive,
} from '../src/crypto-vault.mjs';

import { AccountPool } from '../src/accounts.mjs';

import {
  searchDuckDuckGo,
  fetchWebContent,
  clearExternalToolsCache,
  getExternalToolsCacheStats,
  SEARCH_CACHE,
  FETCH_CACHE,
} from '../src/external-tools.mjs';

import {
  RESP_STORE,
  rememberResponse,
  getResponse,
  clearResponses,
  saveResponsesCache,
  loadResponsesCache,
} from '../src/responses-api.mjs';

import {
  hasGeneratedOutput,
  attachStreamRecovery,
} from '../src/completion-engine.mjs';

import { heartbeat } from '../src/chat-protocol.mjs';
import { validatedEvents } from '../src/upstream-events.mjs';

// ============================================================================
// 1. 凭据加解密与安全保险库测试
// ============================================================================
test('crypto-vault: 默认未配置密钥时明文平滑透传', () => {
  delete process.env.DATA_ENCRYPTION_KEY;
  delete process.env.CREDENTIAL_SECRET;
  delete process.env.ENCRYPT_CREDENTIALS;
  resetVaultKey();

  assert.equal(isVaultActive(), false);
  const plain = 'sk-ant-sid02-test-secret-token-12345';
  const enc = encryptField(plain);
  assert.equal(enc, plain, '未启用加密时应原样透传明文');
  assert.equal(decryptField(enc), plain, '解密明文时应直接返回');
});

test('crypto-vault: 配置密钥后透明执行 AES-256-GCM 加密与解密', () => {
  const secret = 'my-super-secure-vault-passphrase-2026';
  process.env.DATA_ENCRYPTION_KEY = secret;
  resetVaultKey();

  assert.equal(isVaultActive(), true);
  const plain = 'sk-ant-sid02-my-confidential-claude-session';
  const cookie = 'sessionKey=sk-ant-sid02; cf_clearance=abc123xyz;';

  const enc1 = encryptField(plain);
  assert.match(enc1, /^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i, '密文应满足 enc:v1:iv:tag:ciphertext 格式');
  assert.notEqual(enc1, plain);

  const dec1 = decryptField(enc1);
  assert.equal(dec1, plain, '解密后内容应与原文完全一致');

  // Cookie 加密解密
  const encCookie = encryptField(cookie);
  assert.notEqual(encCookie, cookie);
  assert.equal(decryptField(encCookie), cookie);

  // 防二次重复加密
  const encTwice = encryptField(enc1);
  assert.equal(encTwice, enc1, '已加密密文不应被重复加密');

  // 篡改防护测试
  const parts = enc1.split(':');
  parts[3] = parts[3].slice(0, -2) + 'ff'; // 篡改密文最后字节
  const tampered = parts.join(':');
  const decTampered = decryptField(tampered);
  assert.equal(decTampered, tampered, '密文被篡改时应安全降级返回密文本身，绝不崩溃');

  delete process.env.DATA_ENCRYPTION_KEY;
  resetVaultKey();
});

test('crypto-vault & AccountPool: 账号池落盘透明加密与无缝加载（含明文向后兼容）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-vault-test-'));
  const accountsFile = path.join(tmpDir, 'accounts.json');

  const secret = 'vault-test-master-key-xyz';
  process.env.DATA_ENCRYPTION_KEY = secret;
  resetVaultKey();

  try {
    const pool = new AccountPool(accountsFile);
    pool.add({
      label: 'secure-acc-1',
      sessionKey: 'sk-ant-sid02-real-token-999',
      cookie: 'cf_clearance=cleared-cookie-data;',
      org: 'org-uuid-111',
    });
    pool.flushSave();

    // 验证磁盘文件内容被加密
    const fileContent = fs.readFileSync(accountsFile, 'utf8');
    const jsonOnDisk = JSON.parse(fileContent);
    const savedAcc = jsonOnDisk.accounts[0];

    assert.match(savedAcc.sessionKey, /^enc:v1:/, '磁盘中 sessionKey 必须处于加密状态');
    assert.match(savedAcc.cookie, /^enc:v1:/, '磁盘中 cookie 必须处于加密状态');

    // 实例化新 Pool 读取同一加密文件
    const pool2 = new AccountPool(accountsFile);
    const loadedAcc = pool2.get(savedAcc.id);
    assert.equal(loadedAcc.sessionKey, 'sk-ant-sid02-real-token-999', '内存中 sessionKey 必须还原为明文供上游使用');
    assert.equal(loadedAcc.cookie, 'cf_clearance=cleared-cookie-data;', '内存中 cookie 必须还原为明文');

    // 向后兼容性验证：手工在 accounts.json 中添加一条未加密的明文账号
    jsonOnDisk.accounts.push({
      id: 'legacy-plaintext-acc',
      label: 'plaintext-account',
      sessionKey: 'sk-ant-sid02-plaintext-session-legacy',
      cookie: '',
      org: 'org-legacy',
      enabled: true,
      stats: {},
    });
    fs.writeFileSync(accountsFile, JSON.stringify(jsonOnDisk, null, 2), 'utf8');

    const pool3 = new AccountPool(accountsFile);
    const legacyAcc = pool3.get('legacy-plaintext-acc');
    assert.equal(legacyAcc.sessionKey, 'sk-ant-sid02-plaintext-session-legacy', '明文账号应无缝直读兼容');

    // 下次保存时，明文账号应自动升级加密
    pool3.save();
    const updatedRaw = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    const newlyEncrypted = updatedRaw.accounts.find(a => a.id === 'legacy-plaintext-acc');
    assert.match(newlyEncrypted.sessionKey, /^enc:v1:/, '再次保存时明文账号应被自动升级加密');

  } finally {
    delete process.env.DATA_ENCRYPTION_KEY;
    resetVaultKey();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. 外部搜索工具 LRU+TTL 缓存与并发合并测试
// ============================================================================
test('external-tools: 搜索与网页抓取 LRU+TTL 缓存命中与状态统计', async () => {
  clearExternalToolsCache();

  // 手工预置一条已解析的搜索结果到缓存
  const testQuery = 'Node.js stream processing';
  const cacheKey = `${testQuery.toLowerCase()}:10`;
  const mockResults = [
    { url: 'https://nodejs.org/api/stream.html', title: 'Stream | Node.js', snippet: 'Streams are...', summary: 'Streams...', date: null },
  ];

  SEARCH_CACHE.set(cacheKey, {
    results: mockResults,
    expiresAt: Date.now() + 60000, // 1分钟后过期
  });

  // 执行搜索，应立即命中缓存，无需请求网络
  const res = await searchDuckDuckGo(testQuery, 10);
  assert.equal(res.length, 1);
  assert.equal(res[0].url, 'https://nodejs.org/api/stream.html');

  // 网页抓取缓存验证
  FETCH_CACHE.set('https://example.com/cached-page', {
    content: 'Cached Article Body Text',
    expiresAt: Date.now() + 60000,
  });

  const content = await fetchWebContent('https://example.com/cached-page');
  assert.equal(content, 'Cached Article Body Text');

  // 缓存监控统计
  const stats = getExternalToolsCacheStats();
  assert.equal(stats.searchActive, 1);
  assert.equal(stats.fetchActive, 1);

  clearExternalToolsCache();
  const clearedStats = getExternalToolsCacheStats();
  assert.equal(clearedStats.searchEntries, 0);
  assert.equal(clearedStats.fetchEntries, 0);
});

// ============================================================================
// 3. Responses API 状态持久化与容量弹性测试
// ============================================================================
test('responses-api: 状态暂存容量扩展、持久化与恢复测试', () => {
  process.env.RESPONSES_STORE_MAX = '100';
  clearResponses();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-resp-test-'));
  const stateFile = path.join(tmpDir, 'test_responses.json');

  try {
    // 写入 60 条响应（突破原 50 条限制）
    for (let i = 1; i <= 60; i++) {
      rememberResponse('owner_key_1', `resp_${i}`, { id: `resp_${i}`, model: 'sonnet' }, [{ role: 'user', content: `q${i}` }]);
    }

    assert.equal(RESP_STORE.size, 60, 'Responses 缓存容量应允许超过旧版 50 条上限');
    assert.ok(getResponse('resp_60'), '最新条目必须存在');
    assert.ok(getResponse('resp_1'), '第 1 条也应保留未被 50 槽位挤出');

    // 持久化到文件
    const saved = saveResponsesCache(stateFile);
    assert.equal(saved, true);
    assert.ok(fs.existsSync(stateFile));

    // 清空内存
    clearResponses();
    assert.equal(RESP_STORE.size, 0);

    // 从磁盘恢复
    const loadedCount = loadResponsesCache(stateFile);
    assert.equal(loadedCount, 60, '应成功从文件恢复 60 条响应');
    const item = getResponse('resp_60');
    assert.equal(item?.owner, 'owner_key_1');
    assert.equal(item?.response?.id, 'resp_60');

  } finally {
    delete process.env.RESPONSES_STORE_MAX;
    clearResponses();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. 彻底根治 transport interrupted：首字前与思考阶段容灾状态机测试
// ============================================================================
test('completion-engine: hasGeneratedOutput 精确识别实质性输出，思考块开始不造成过早提交锁死', () => {
  // 1. content_block_start
  assert.equal(hasGeneratedOutput({ type: 'content_block_start', content_block: { type: 'thinking' } }), false, '纯思考块 start 不应判定为已产生可见输出');
  assert.equal(hasGeneratedOutput({ type: 'content_block_start', content_block: { type: 'text', text: '' } }), false, '空文本 start 不应判定为已产生可见输出');
  assert.equal(hasGeneratedOutput({ type: 'content_block_start', content_block: { type: 'text', text: 'hi' } }), true);
  assert.equal(hasGeneratedOutput({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'call_1', name: 'calc' } }), true);

  // 2. content_block_delta
  assert.equal(hasGeneratedOutput({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }), false);
  assert.equal(hasGeneratedOutput({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'token' } }), true);
  assert.equal(hasGeneratedOutput({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } }), false);
  assert.equal(hasGeneratedOutput({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me think...' } }), true);
  assert.equal(hasGeneratedOutput({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a":1}' } }), true);
});

test('completion-engine: 思考块 start 阶段上游断连 (transport interrupted) 允许自动故障转移重试', async () => {
  let callCount = 0;
  // 模拟上游已下发 message_start 与 content_block_start (thinking)，但思考阶段连接意外中断
  const brokenThinkingRun = {
    account: { id: 'acc_think_1', label: 'Thinking Account 1' },
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_think"}}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n'));
        // 模拟 Undici keepAliveMaxTimeout 触发或网络中断抛出 UPSTREAM_TRANSPORT_INTERRUPTED
        const err = Object.assign(new Error('Invalid upstream stream: transport interrupted'), {
          code: 'UPSTREAM_TRANSPORT_INTERRUPTED',
          kind: 'upstream_stream',
        });
        controller.error(err);
      },
    }),
    release: () => {},
  };

  const recoveredRun = {
    account: { id: 'acc_think_2', label: 'Thinking Account 2' },
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"thinking failover success"}}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    }),
    release: () => {},
  };

  const mockEngine = {
    pool: {
      eligible: () => [{ id: 'acc_think_2', label: 'Thinking Account 2' }],
    },
    runCompletion: async () => {
      callCount++;
      return recoveredRun;
    },
  };

  const wrapped = attachStreamRecovery(brokenThinkingRun, { stream: true }, 'claude-sonnet-5-5', null, {}, {}, {
    engine: mockEngine,
    pool: mockEngine.pool,
  });

  const events = [];
  for await (const ev of wrapped.events()) {
    events.push(ev);
  }

  assert.equal(callCount, 1, '思考块 start 阶段连接中断应透明重试并调用 runCompletion 1 次');
  assert.ok(events.some(e => e.delta?.text === 'thinking failover success'));
});

test('completion-engine: 非流式调用 (!stream) 中途断连全量缓冲并自动故障转移', async () => {
  let callCount = 0;
  // 模拟非流式请求下，中间产生部分文本后断连
  const partialRun = {
    account: { id: 'acc_nonstream_1', label: 'NonStream Account 1' },
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_part"}}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial..."}}\n\n'));
        const err = Object.assign(new Error('Invalid upstream stream: transport interrupted'), {
          code: 'UPSTREAM_TRANSPORT_INTERRUPTED',
          kind: 'upstream_stream',
        });
        controller.error(err);
      },
    }),
    release: () => {},
  };

  const fullCleanRun = {
    account: { id: 'acc_nonstream_2', label: 'NonStream Account 2' },
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_full"}}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"complete non-stream text"}}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    }),
    release: () => {},
  };

  const mockEngine = {
    pool: {
      eligible: () => [{ id: 'acc_nonstream_2', label: 'NonStream Account 2' }],
    },
    runCompletion: async () => {
      callCount++;
      return fullCleanRun;
    },
  };

  const wrapped = attachStreamRecovery(partialRun, { stream: false }, 'claude-sonnet-5-5', null, {}, {}, {
    engine: mockEngine,
    pool: mockEngine.pool,
  });

  const events = [];
  for await (const ev of wrapped.events()) {
    events.push(ev);
  }

  assert.equal(callCount, 1, '非流式中途崩溃应无感重试并调用 runCompletion 1 次');
  assert.ok(events.some(e => e.delta?.text === 'complete non-stream text'));
  assert.equal(events.some(e => e.delta?.text === 'partial...'), false, '脏数据不应漏出给下游');
});

// ============================================================================
// 5. 客户端心跳保活与客户端断连精准识别测试（解决 idle timeout waiting for SSE）
// ============================================================================
test('heartbeat: 针对 OpenAI/Anthropic/Responses 协议精准发送保活帧，防止客户端 idle timeout', async () => {
  // 1. OpenAI 模式：应同时输出 : keep-alive 和空增量 data 帧
  const writtenOpenAI = [];
  const fakeResOai = {
    destroyed: false,
    writableEnded: false,
    write(chunk) { writtenOpenAI.push(chunk); return true; },
  };
  const stopOai = heartbeat(fakeResOai, 'openai', { chatId: 'chat_test_1', model: 'sonnet', intervalMs: 20 });
  await new Promise(r => setTimeout(r, 60));
  stopOai();
  assert.ok(writtenOpenAI.length >= 1, 'OpenAI heartbeat 应触发');
  const oaiMsg = writtenOpenAI.join('');
  assert.ok(oaiMsg.includes(': keep-alive'), '应包含注释保持中间代理连通');
  assert.ok(oaiMsg.includes('data: {"id":"chat_test_1"'), '应包含合法 data 帧以重置客户端 idle 计时器');
  assert.ok(oaiMsg.includes('"choices":[{"index":0,"delta":{}}]'), '应为不污染文本的合法空 delta 帧');

  // 2. Anthropic / Responses 模式：应输出 event: ping
  const writtenAnt = [];
  const fakeResAnt = {
    destroyed: false,
    writableEnded: false,
    write(chunk) { writtenAnt.push(chunk); return true; },
  };
  const stopAnt = heartbeat(fakeResAnt, 'anthropic', { intervalMs: 20 });
  await new Promise(r => setTimeout(r, 60));
  stopAnt();
  const antMsg = writtenAnt.join('');
  assert.ok(antMsg.includes('event: ping'));
  assert.ok(antMsg.includes('data: {"type": "ping"}') || antMsg.includes('data: {"type":"ping"}'));

  // 3. 活跃数据抑制特性：当近期已有正文输出，心跳应静默不打扰
  const writtenActive = [];
  const fakeResActive = {
    destroyed: false,
    writableEnded: false,
    write(chunk) { writtenActive.push(chunk); return true; },
  };
  const stopActive = heartbeat(fakeResActive, 'openai', { intervalMs: 30 });
  writtenActive.length = 0; // 重置初始握手包
  // 持续标记正文活动
  const keepAliveActive = setInterval(() => { fakeResActive._markSseActivity?.(); }, 10);
  await new Promise(r => setTimeout(r, 70));
  clearInterval(keepAliveActive);
  stopActive();
  assert.equal(writtenActive.length, 0, '正文频繁输出时应抑制冗余心跳包');
});

test('completion-engine: attachStreamRecovery 即时下发 ping 事件给下游，不造成提交锁死', async () => {
  let callCount = 0;
  // 模拟上游首字前下发了 ping 心跳事件，之后抛出断连
  const streamWithPing = {
    account: { id: 'acc_ping_1', label: 'Ping Account 1' },
    stream: new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'));
        await new Promise(r => setTimeout(r, 10));
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_p"}}\n\n'));
        await new Promise(r => setTimeout(r, 10));
        const err = Object.assign(new Error('upstream connection reset'), {
          code: 'UPSTREAM_TRANSPORT_INTERRUPTED',
          kind: 'upstream_stream',
        });
        controller.error(err);
      },
    }),
    release: () => {},
  };

  const recoveredRun = {
    account: { id: 'acc_ping_2', label: 'Ping Account 2' },
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_p2"}}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recovered after ping"}}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    }),
    release: () => {},
  };

  const mockEngine = {
    pool: {
      eligible: () => [{ id: 'acc_ping_2', label: 'Ping Account 2' }],
    },
    runCompletion: async () => {
      callCount++;
      return recoveredRun;
    },
  };

  const wrapped = attachStreamRecovery(streamWithPing, { stream: true }, 'claude-sonnet-5-5', null, {}, {}, {
    engine: mockEngine,
    pool: mockEngine.pool,
  });

  const events = [];
  for await (const ev of wrapped.events()) {
    events.push(ev);
  }

  // ping 事件应直接下发给下游（保证客户端不断连）
  assert.ok(events.some(e => e.type === 'ping'), 'ping 事件应及时下发给下游');
  // 并且 ping 事件不应导致 committed=true，故障后应成功重试
  assert.equal(callCount, 1, '下发 ping 后遭遇故障仍应成功故障转移重试 1 次');
  assert.ok(events.some(e => e.delta?.text === 'recovered after ping'));
});

test('upstream-events: 客户端提前断开连接准确识别为 client_gone (499)，杜绝误判 transport interrupted', async () => {
  const abortCtrl = new AbortController();
  const feed = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"type":"ping"}\n\n'));
      // 客户端中断
      abortCtrl.abort();
      controller.error(new Error('Premature close'));
    },
  });

  let thrown = null;
  try {
    for await (const ev of validatedEvents(feed, [], { signal: abortCtrl.signal })) {
      // 消费
    }
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, '应捕获异常');
  assert.equal(thrown.name, 'AbortError', '客户端断开应抛出 AbortError');
  assert.equal(thrown.kind, 'client_gone', '错误分类应为 client_gone');
  assert.equal(thrown.status, 499, '状态码应映射为 499 (Client Closed Request)');
  assert.notEqual(thrown.code, 'UPSTREAM_TRANSPORT_INTERRUPTED', '绝不应误判为上游传输中断');
});

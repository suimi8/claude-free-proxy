import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectImages,
  IMAGE_CACHE,
  ImageCache,
  parseDataUrl,
  resolveImage,
  MAX_IMAGE_BYTES,
  MAX_CACHE_ENTRIES,
  uploadImages
} from '../src/image-uploader.mjs';
import {
  getConversationKey,
  CONV_ROUTING,
  ConversationRoutingMap,
  bindAccount,
  getBoundAccount,
  unbindAccount,
  getRoutingStats,
  clearRouting
} from '../src/conversation-router.mjs';
import {
  countTokens,
  isCjkCodePoint,
  estimateInputTokens,
  calculateTps,
  calculateTimingMetrics,
  StreamMetricsTracker
} from '../src/stream-metrics.mjs';

test('image-uploader: collectImages accurately extracts images across roles in prompt order', () => {
  const messages = [
    { role: 'system', content: [{ type: 'image_url', image_url: 'data:image/png;base64,sys_base64' }] },
    { role: 'user', content: 'What is in this picture?' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,user_base64' } }] },
    { role: 'assistant', content: 'Checking...' },
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'anthropic_base64' } }] }
  ];

  const imgsFromArr = collectImages(messages);
  assert.equal(imgsFromArr.length, 3);
  assert.equal(imgsFromArr[0], 'data:image/png;base64,sys_base64');
  assert.equal(imgsFromArr[1], 'data:image/jpeg;base64,user_base64');
  assert.equal(imgsFromArr[2], 'data:image/png;base64,anthropic_base64');

  const imgsFromBody = collectImages({ messages });
  assert.equal(imgsFromBody.length, 3);
});

test('image-uploader: parseDataUrl and resolveImage handle data URLs correctly', async () => {
  const sample = 'data:image/png;base64,SGVsbG8gV29ybGQ=';
  const parsed = parseDataUrl(sample);
  assert.ok(parsed);
  assert.equal(parsed.mime, 'image/png');
  assert.equal(parsed.bytes.toString('utf8'), 'Hello World');

  const resolved = await resolveImage(sample);
  assert.equal(resolved.mime, 'image/png');
  assert.equal(resolved.name, 'image.png');
  assert.equal(resolved.bytes.toString('utf8'), 'Hello World');
});

test('image-uploader: ImageCache enforces LRU eviction and TTL', async () => {
  const cache = new ImageCache({ max: 2, ttl: 40 });
  cache.set('key1', { uuid: 'uuid1' });
  cache.set('key2', { uuid: 'uuid2' });

  assert.equal(cache.get('key1')?.uuid, 'uuid1'); // refreshes key1, so key2 becomes LRU
  cache.set('key3', { uuid: 'uuid3' });

  assert.equal(cache.size, 2);
  assert.equal(cache.get('key2'), undefined, 'key2 should be evicted by LRU');
  assert.equal(cache.get('key1')?.uuid, 'uuid1');
  assert.equal(cache.get('key3')?.uuid, 'uuid3');

  // Test TTL
  await new Promise(r => setTimeout(r, 50));
  assert.equal(cache.get('key1'), undefined, 'key1 should have expired by TTL');
});

test('conversation-router: getConversationKey supports headers, explicit IDs, and stable fingerprints', () => {
  // 1. headers
  const reqWithHeader = { headers: { 'x-session-id': 'sess-456' } };
  const body = { messages: [{ role: 'user', content: 'test question' }] };
  assert.equal(getConversationKey(reqWithHeader, body), 'h:sess-456');
  assert.equal(getConversationKey(body, reqWithHeader), 'h:sess-456');

  // 2. body id
  assert.equal(getConversationKey({}, { conversation_id: 'conv-789' }), 'c:conv-789');
  assert.equal(getConversationKey({ chat_id: 'chat-999' }, null), 'c:chat-999');

  // 3. fingerprint
  const fpKey = getConversationKey({}, body);
  assert.ok(fpKey.startsWith('fp:'));
  // Stable fingerprint for repeated requests
  const fpKey2 = getConversationKey({}, body);
  assert.equal(fpKey, fpKey2);
});

test('conversation-router: ConversationRoutingMap memory leak protection and capacity limits', () => {
  clearRouting();
  const map = new ConversationRoutingMap({ maxSize: 3, ttl: 1000 });
  map.set('k1', 'acc1');
  map.set('k2', 'acc2');
  map.set('k3', 'acc3');
  assert.equal(map.size, 3);

  // Access k1 to make k2 oldest
  map.get('k1');
  map.set('k4', 'acc4');

  assert.equal(map.size, 3);
  assert.equal(map.get('k2'), undefined, 'Oldest unaccessed k2 must be evicted');
  assert.equal(map.get('k1')?.accountId, 'acc1');
  assert.equal(map.get('k3')?.accountId, 'acc3');
  assert.equal(map.get('k4')?.accountId, 'acc4');

  // Test helper bindings
  bindAccount('conv-test', 'acc-test');
  assert.equal(getBoundAccount('conv-test'), 'acc-test');
  unbindAccount('conv-test');
  assert.equal(getBoundAccount('conv-test'), null);
});

test('stream-metrics: countTokens CJK weighted calculation', () => {
  // Pure English
  assert.equal(countTokens('abcdefgh'), 2); // 8 chars / 4 = 2
  assert.equal(countTokens('hello world'), 3); // 11 chars / 4 = 2.75 -> 3

  // CJK characters (1 char = 1 token)
  assert.equal(countTokens('你好世界'), 4);
  assert.equal(countTokens('这是一个用于测试的句子。'), 12); // 11 汉字 + 1 中文句号 = 12 tokens

  // Fullwidth forms
  assert.equal(countTokens('！'), 1);
  assert.equal(countTokens('？'), 1);

  // Mixed CJK and Latin
  // 4 CJK chars + 5 latin ("hello") -> 4 + ceil(5/4) = 6
  assert.equal(countTokens('你好世界hello'), 6);
});

test('stream-metrics: StreamMetricsTracker tracks timing and calculates accurate throughput', () => {
  const startedAt = Date.now() - 300;
  const tracker = new StreamMetricsTracker({ startedAt });

  // 1. Thinking phase
  tracker.observe({ type: 'content_block_delta', delta: { thinking: 'thinking process...' } });
  // 2. Text phase
  tracker.observe({ type: 'content_block_delta', delta: { text: '这是测试文本，用于验证流速计算。' } });
  // 3. Tool call / JSON
  tracker.observe({ type: 'content_block_delta', delta: { partial_json: '{"arg":"val"}' } });

  const usage = tracker.outputUsage();
  assert.ok(usage.text > 0);
  assert.ok(usage.thinking > 0);
  assert.equal(usage.output, usage.text + usage.thinking + countTokens('{"arg":"val"}'));

  const ctx = { startedAt };
  const finalized = tracker.finalize(ctx);

  assert.equal(ctx.output_tokens, usage.output);
  assert.equal(ctx.text_tokens, usage.text);
  assert.equal(ctx.think_tokens, usage.thinking);
  assert.ok(typeof ctx.ttfb_ms === 'number');
  assert.ok(typeof ctx.latency_ms === 'number');
  assert.ok(typeof ctx.tps === 'number');
  assert.ok(typeof ctx.tps_e2e === 'number');
});

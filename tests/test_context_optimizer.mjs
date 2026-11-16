/**
 * tests/test_context_optimizer.mjs - 媒体与长上下文性能优化模块单测
 *
 * 验证：
 * 1. 单张图、多张图、长轮次（15 轮以上）对话时，最新图片保留真实内容，早期历史图片降级为占位符；
 * 2. maxImages 阈值约束生效，超额时优先保留最新图片；
 * 3. 工具输出在最近 2 轮完整保留，早期 > 2000 字符的工具结果保留首尾 15 行并插入中间省略标记；
 * 4. 工具输出修剪不损坏 JSON 结构（JSON 字符串/对象解析依然合法）及消息数组结构；
 * 5. 纯函数特性：原 messages 列表及嵌套对象绝不被原地篡改。
 */

import assert from 'node:assert/strict';
import {
  pruneMessageImages,
  pruneToolOutputs,
  optimizeContext,
  computeTurnDistances,
  IMAGE_PLACEHOLDER,
} from '../src/context-optimizer.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

console.log('=== [1] computeTurnDistances 轮次距离计算测试 ===');

test('基础轮次距离计算（system + user/assistant 交替）', () => {
  const messages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'turn 0' },
    { role: 'assistant', content: 'reply 0' },
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: 'reply 1' },
    { role: 'user', content: 'turn 2 (current)' },
  ];
  const dists = computeTurnDistances(messages);
  assert.equal(dists[0], Infinity, '系统消息距离应为 Infinity');
  assert.equal(dists[1], 2, '第 0 轮 user 距离末尾应为 2');
  assert.equal(dists[2], 2, '第 0 轮 assistant 距离末尾应为 2');
  assert.equal(dists[3], 1, '第 1 轮 user 距离末尾应为 1');
  assert.equal(dists[4], 1, '第 1 轮 assistant 距离末尾应为 1');
  assert.equal(dists[5], 0, '当前轮 user 距离末尾应为 0');
});

test('连续 user 消息（图片与文字分发）计为同一交互轮次', () => {
  const messages = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,A' } }] },
    { role: 'user', content: '图里是什么？' },
    { role: 'assistant', content: '是一只猫' },
    { role: 'user', content: '什么颜色？' },
  ];
  const dists = computeTurnDistances(messages);
  assert.equal(dists[0], 1, '第 0 轮图片与文字应同属上一轮 (dist=1)');
  assert.equal(dists[1], 1, '第 0 轮文字应为上一轮 (dist=1)');
  assert.equal(dists[2], 1, '第 0 轮 assistant 回复应为上一轮 (dist=1)');
  assert.equal(dists[3], 0, '第 1 轮当前输入应为 dist=0');
});

test('纯 user 消息序列（无 assistant）每条视为独立轮次', () => {
  const messages = [
    { role: 'user', content: 'msg 0' },
    { role: 'user', content: 'msg 1' },
    { role: 'user', content: 'msg 2' },
  ];
  const dists = computeTurnDistances(messages);
  assert.deepEqual(dists, [2, 1, 0]);
});

console.log('\n=== [2] pruneMessageImages 图片修剪测试 ===');

test('单张图在当前轮次：完整保留图片 URL', () => {
  const imgUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const messages = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: imgUrl } }] },
  ];

  const result = pruneMessageImages(messages, 2, 3);
  assert.equal(result.length, 1);
  assert.equal(result[0].content[0].type, 'image_url');
  assert.equal(result[0].content[0].image_url.url, imgUrl);
});

test('多张图在最近 2 轮内（未超 maxImages=3）：全部保留', () => {
  const img1 = 'data:image/png;base64,IMG1';
  const img2 = 'data:image/png;base64,IMG2';
  const messages = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: img1 } }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: img2 } }] },
  ];

  const result = pruneMessageImages(messages, 2, 3);
  assert.equal(result[0].content[0].image_url.url, img1);
  assert.equal(result[2].content[0].image_url.url, img2);
});

test('长轮次对话（15 轮以上）：仅最近 2 轮图片保留，早期历史图片全部降级为占位符', () => {
  const messages = [];
  for (let i = 0; i < 16; i++) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: `Turn ${i} prompt` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,DATA_${i}` } },
      ],
    });
    messages.push({
      role: 'assistant',
      content: `Turn ${i} answer`,
    });
  }
  // 此时共 16 轮对话 (0..15)，消息总数 32 条
  // 最新 2 轮为 Turn 14 (dist 1) 与 Turn 15 (dist 0)
  const result = pruneMessageImages(messages, 2, 3);
  assert.equal(result.length, 32);

  // 早期轮次 (0..13) 的图片块降级为文本占位符，但前面的 text 块完好保留
  for (let i = 0; i <= 13; i++) {
    const userMsg = result[i * 2];
    assert.equal(userMsg.content[0].text, `Turn ${i} prompt`, `Turn ${i} 的提示文本应完好`);
    assert.equal(userMsg.content[1].type, 'text', `Turn ${i} 的图片类型应降级为 text`);
    assert.equal(userMsg.content[1].text, IMAGE_PLACEHOLDER, `Turn ${i} 应被替换为占位符`);
  }

  // 最新 2 轮 (14, 15) 的图片保持真实内容
  assert.equal(result[28].content[1].type, 'image_url');
  assert.equal(result[28].content[1].image_url.url, 'data:image/png;base64,DATA_14');

  assert.equal(result[30].content[1].type, 'image_url');
  assert.equal(result[30].content[1].image_url.url, 'data:image/png;base64,DATA_15');
});

test('maxImages 约束测试：最近轮次有 4 张图，maxImages=3 时仅保留最新的 3 张', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,IMG_A' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,IMG_B' } },
      ],
    },
    { role: 'assistant', content: 'got 2 images' },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,IMG_C' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,IMG_D' } },
      ],
    },
  ];
  // 2 轮内共 4 张图。maxImages=3 限制下，最老的 IMG_A 应被降级，IMG_B、IMG_C、IMG_D 应保留
  const result = pruneMessageImages(messages, 2, 3);
  assert.equal(result[0].content[0].text, IMAGE_PLACEHOLDER, '最老的一张图 IMG_A 应被降级');
  assert.equal(result[0].content[1].image_url.url, 'data:image/png;base64,IMG_B', 'IMG_B 应保留');
  assert.equal(result[2].content[0].image_url.url, 'data:image/png;base64,IMG_C', 'IMG_C 应保留');
  assert.equal(result[2].content[1].image_url.url, 'data:image/png;base64,IMG_D', 'IMG_D 应保留');
});

test('多协议格式兼容测试（Anthropic, Responses API, 纯 Base64 字符串）', () => {
  const messages = [
    // Turn 0: Anthropic 格式 (早期轮次，应降级)
    {
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ANTHROPIC_DATA' } }],
    },
    { role: 'assistant', content: 'ok' },
    // Turn 1: Responses API 格式 (早期轮次，应降级)
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,RESP_DATA' }],
    },
    { role: 'assistant', content: 'ok' },
    // Turn 2: 纯字符串 data URL (上一轮，应保留)
    {
      role: 'user',
      content: 'data:image/png;base64,PURE_STR_DATA',
    },
    { role: 'assistant', content: 'ok' },
    // Turn 3: OpenAI 格式 (当前轮，应保留)
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: 'data:image/png;base64,OAI_DATA' }],
    },
  ];

  const result = pruneMessageImages(messages, 2, 3);
  // Turn 0 (dist 3) -> 降级为 text 占位
  assert.equal(result[0].content[0].text, IMAGE_PLACEHOLDER);
  // Turn 1 (dist 2) -> 降级为 input_text 占位
  assert.equal(result[2].content[0].type, 'input_text');
  assert.equal(result[2].content[0].text, IMAGE_PLACEHOLDER);
  // Turn 2 (dist 1) -> 保持字符串
  assert.equal(result[4].content, 'data:image/png;base64,PURE_STR_DATA');
  // Turn 3 (dist 0) -> 保持 image_url
  assert.equal(result[6].content[0].image_url, 'data:image/png;base64,OAI_DATA');
});

test('纯函数验证：输入原 messages 结构未被破坏或原地篡改', () => {
  const orig = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,ORIG' } }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'current' },
  ];
  const snap = JSON.parse(JSON.stringify(orig));
  const result = pruneMessageImages(orig, 2, 3);

  assert.deepEqual(orig, snap, '原 messages 数组及其属性不可被修改');
  assert.notEqual(result, orig, '返回应为全新数组');
  assert.equal(result[0].content[0].text, IMAGE_PLACEHOLDER, '结果中早期图片已降级');
});

console.log('\n=== [3] pruneToolOutputs 工具输出修剪测试 ===');

test('最近 2 轮内的工具输出 100% 完整保留（即使超过 2000 字符）', () => {
  const longOutput = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: ${'#'.repeat(50)}`).join('\n');
  assert(longOutput.length > 2000, '测试输出应大于 2000 字符');

  const messages = [
    { role: 'user', content: 'run tool' },
    { role: 'assistant', content: 'calling', tool_calls: [{ id: 'call_1', function: { name: 'test' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: longOutput }, // 当前轮，dist = 0
  ];

  const result = pruneToolOutputs(messages);
  assert.equal(result[2].content, longOutput, '最近轮次的工具输出不应被修剪');
  assert.equal(result[2].tool_call_id, 'call_1', 'tool_call_id 应保留');
  assert.equal(result[2].role, 'tool', 'role 应保留');
});

test('早期工具输出（> 2000 字符，50 行）：修剪为首尾各 15 行并标明省略行数', () => {
  const lines50 = Array.from({ length: 50 }, (_, i) => `Log line ${String(i + 1).padStart(2, '0')}: detail info ${'x'.repeat(40)}`);
  const longOutput = lines50.join('\n');
  assert(longOutput.length > 2000);

  const messages = [
    // Turn 0: 早期轮次 (dist = 2)
    { role: 'user', content: 'turn 0 start' },
    { role: 'assistant', content: 'calling tool 1' },
    { role: 'tool', tool_call_id: 'call_old', name: 'bash', content: longOutput },
    { role: 'assistant', content: 'done 1' },
    // Turn 1: 早期轮次 (dist = 1)
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: 'done 2' },
    // Turn 2: 当前轮次 (dist = 0)
    { role: 'user', content: 'turn 2 now' },
  ];

  const result = pruneToolOutputs(messages, { keepRecentTurns: 2 });
  const prunedToolMsg = result[2];

  assert.equal(prunedToolMsg.role, 'tool');
  assert.equal(prunedToolMsg.tool_call_id, 'call_old');
  assert.equal(prunedToolMsg.name, 'bash');

  const outLines = prunedToolMsg.content.split('\n');
  // 15 首行 + 1 行省略标记 + 15 尾行 = 31 行
  assert.equal(outLines.length, 31, `总行数应为 31 行，实际为 ${outLines.length}`);
  // 检查首行与尾行
  assert.equal(outLines[0], lines50[0], '头部第一行正确');
  assert.equal(outLines[14], lines50[14], '头部第 15 行正确');
  assert.equal(outLines[15], '... [已省略中间 20 行输出] ...', '中间省略行数标记正确 (50 - 30 = 20)');
  assert.equal(outLines[16], lines50[35], '尾部第一行正确');
  assert.equal(outLines[30], lines50[49], '尾部最后一行正确');
});

test('早期工具输出小于等于 2000 字符时不予修剪', () => {
  const shortOutput = 'Command executed successfully in 12ms.\nExit code: 0';
  const messages = [
    { role: 'user', content: 'run short' },
    { role: 'assistant', content: 'calling' },
    { role: 'tool', tool_call_id: 'call_short', content: shortOutput },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'now' },
  ];

  const result = pruneToolOutputs(messages);
  assert.equal(result[2].content, shortOutput, '短输出不应被篡改');
});

test('JSON 工具输出测试：修剪后 JSON 结构依然合法，能正常 JSON.parse', () => {
  const logs50 = Array.from({ length: 50 }, (_, i) => `log line ${i + 1}: ${'a'.repeat(45)}`).join('\n');
  const jsonPayload = {
    status: 'success',
    exit_code: 0,
    stdout: logs50,
  };
  const jsonStr = JSON.stringify(jsonPayload, null, 2);
  assert(jsonStr.length > 2000);

  const messages = [
    { role: 'user', content: 'run json' },
    { role: 'assistant', content: 'calling' },
    { role: 'tool', tool_call_id: 'call_json', content: jsonStr },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'turn 2' },
  ];

  const result = pruneToolOutputs(messages);
  const toolContent = result[2].content;

  // 1. 验证依然是合法 JSON
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(toolContent);
  }, '修剪后的工具输出必须能被正常 JSON.parse 解析，不得破坏 JSON 语法结构');

  // 2. 验证关键字段完好
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.exit_code, 0);

  // 3. 验证超长文本字段被合理修剪
  assert(parsed.stdout.includes('... [已省略中间 20 行输出] ...'), 'stdout 字段内部应被合理修剪');
  assert(toolContent.length < jsonStr.length, '总字符数应明显减少');
});

test('消息数组结构及全量 JSON 序列化保证', () => {
  const messages = [
    { role: 'system', content: 'system message' },
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: 'I will call a tool',
      tool_calls: [{ id: 'call_xyz', type: 'function', function: { name: 'calc', arguments: '{"x":1}' } }],
    },
    { role: 'tool', tool_call_id: 'call_xyz', name: 'calc', content: 'line\n'.repeat(60) + 'tail' },
    { role: 'assistant', content: 'calc finished' },
    { role: 'user', content: 'step 2' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'step 3' },
  ];

  const result = pruneToolOutputs(messages);
  // 确保所有键名完整
  assert.equal(result[3].role, 'tool');
  assert.equal(result[3].tool_call_id, 'call_xyz');
  assert.equal(result[3].name, 'calc');

  // 确保整条 messages 数组可合法 JSON 序列化与反序列化
  let stringified;
  assert.doesNotThrow(() => {
    stringified = JSON.stringify(result);
  });
  const reloaded = JSON.parse(stringified);
  assert.equal(reloaded.length, messages.length);
  assert.equal(reloaded[3].name, 'calc');
});

test('Anthropic 协议 tool_result 块兼容测试', () => {
  const longText = Array.from({ length: 60 }, (_, i) => `record line ${i}: ${'x'.repeat(45)}`).join('\n');
  assert(longText.length > 2000, '测试文本必须大于 2000 字符');
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_123', content: longText },
      ],
    },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'turn 2' },
  ];

  const result = pruneToolOutputs(messages);
  const userMsg = result[0];
  assert.equal(userMsg.role, 'user');
  assert.equal(userMsg.content[0].type, 'tool_result');
  assert.equal(userMsg.content[0].tool_use_id, 'toolu_123');
  assert(userMsg.content[0].content.includes('... [已省略中间'));
});

test('CRLF 换行符的工具输出修剪及首尾拼接', () => {
  const crlfLines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: CRLF test line ${'#'.repeat(50)}`).join('\r\n');
  assert(crlfLines.length > 2000);
  const messages = [
    { role: 'user', content: 'run crlf' },
    { role: 'assistant', content: 'calling' },
    { role: 'tool', tool_call_id: 'call_crlf', content: crlfLines },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'turn 2' },
  ];

  const result = pruneToolOutputs(messages);
  const content = result[2].content;
  assert(content.includes('... [已省略中间 10 行输出] ...'), '40 - 30 = 10 行省略');
  const lines = content.split('\n');
  assert.equal(lines.length, 31);
});

test('直接传入 JSON Object 类型的 content', () => {
  const longData = Array.from({ length: 50 }, (_, i) => `data ${i}: ${'z'.repeat(50)}`).join('\n');
  const messages = [
    { role: 'user', content: 'run obj' },
    { role: 'assistant', content: 'calling' },
    {
      role: 'tool',
      tool_call_id: 'call_obj',
      content: {
        success: true,
        nested: {
          stdout: longData,
        },
      },
    },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'turn 2' },
  ];

  const result = pruneToolOutputs(messages);
  const prunedObj = result[2].content;
  assert.equal(typeof prunedObj, 'object');
  assert.equal(prunedObj.success, true);
  assert(prunedObj.nested.stdout.includes('... [已省略中间 20 行输出] ...'));
});

test('边界输入鲁棒性：空数组、null/undefined 消息、异常 content 均不崩溃', () => {
  assert.deepEqual(pruneMessageImages([]), []);
  assert.deepEqual(pruneToolOutputs([]), []);
  assert.equal(pruneMessageImages(null), null);
  assert.equal(pruneToolOutputs(undefined), undefined);

  const messyMessages = [
    null,
    undefined,
    {},
    { role: 'user', content: null },
    { role: 'tool', content: '' },
    { role: 'tool', content: 12345 },
  ];
  assert.doesNotThrow(() => {
    pruneMessageImages(messyMessages);
    pruneToolOutputs(messyMessages);
    optimizeContext(messyMessages);
  });
});

console.log('\n=== [4] optimizeContext 组合优化测试 ===');

test('长对话（15 轮）集成测试：同时修剪历史图片与历史巨量工具结果', () => {
  const messages = [];
  for (let i = 0; i < 15; i++) {
    const longTool = Array.from({ length: 60 }, (_, k) => `Turn ${i} output line ${k}: ${'#'.repeat(45)}`).join('\n');
    assert(longTool.length > 2000);
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: `Question ${i}` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,RAW_IMG_${i}` } },
      ],
    });
    messages.push({
      role: 'assistant',
      content: `Calling tool ${i}`,
      tool_calls: [{ id: `call_${i}`, function: { name: 'exec' } }],
    });
    messages.push({
      role: 'tool',
      tool_call_id: `call_${i}`,
      content: longTool,
    });
    messages.push({
      role: 'assistant',
      content: `Answer ${i}`,
    });
  }

  // 15 轮，每轮 4 条消息，共 60 条消息
  assert.equal(messages.length, 60);

  const optimized = optimizeContext(messages, { keepRecentTurns: 2, maxImages: 3 });
  assert.equal(optimized.length, 60);

  // Turn 0 的图片应被替换为占位符
  assert.equal(optimized[0].content[1].text, IMAGE_PLACEHOLDER);
  // Turn 0 的工具输出应被修剪
  assert(optimized[2].content.includes('... [已省略中间'));

  // Turn 14（最后一轮）的图片应保留
  assert.equal(optimized[56].content[1].image_url.url, 'data:image/png;base64,RAW_IMG_14');
  // Turn 14 的工具输出应完整保留
  assert.equal(optimized[58].content.split('\n').length, 60, '最新轮次工具结果 60 行完整保留');

  // 整体序列化测试
  const serialized = JSON.stringify({ messages: optimized });
  assert(serialized.length > 0);
});

console.log(`\n========================================`);
console.log(`测试结果: ${passed} 项通过, ${failed} 项失败`);
console.log(`========================================`);

if (failed > 0) {
  process.exit(1);
}

// @ts-check
import assert from 'node:assert';
import { createCfVerifyManager, findBrowser, openClaudeWebBrowser, sweepStaleProfiles } from '../src/cf-verify.mjs';

console.log('=== 测试 cf-verify 模块与接口 ===');

// 1. 验证浏览器发现
const browserPath = findBrowser();
assert.ok(browserPath, '应能找到可用浏览器');
console.log(`PASS: findBrowser 成功找到浏览器: ${browserPath}`);

// 2. 验证 createCfVerifyManager 实例及方法
let captured = null;
const cfm = createCfVerifyManager({
  onCapture: async data => { captured = data; return { id: data.accountId }; },
});

assert.strictEqual(typeof cfm.start, 'function');
assert.strictEqual(typeof cfm.startBatch, 'function');
assert.strictEqual(typeof cfm.state, 'function');
assert.strictEqual(typeof cfm.cancel, 'function');
assert.strictEqual(typeof cfm.activeFlow, 'function');
assert.strictEqual(typeof cfm.activeBatch, 'function');
console.log('PASS: createCfVerifyManager 实例方法校验通过');

// 3. 验证参数校验
const emptyStart = cfm.start('acc1', '');
assert.strictEqual(emptyStart.ok, false);
assert.ok(emptyStart.error.includes('sessionKey'));
console.log('PASS: start 空 sessionKey 拦截正常');

const emptyBatch = cfm.startBatch([]);
assert.strictEqual(emptyBatch.ok, false);
console.log('PASS: startBatch 空列表拦截正常');

// 4. 验证批量流程创建与状态查询
const batchRes = cfm.startBatch([
  { id: 'test_acc_1', sessionKey: 'sk-ant-test1' },
  { id: 'test_acc_2', sessionKey: 'sk-ant-test2' },
]);
assert.strictEqual(batchRes.ok, true);
assert.ok(batchRes.flowId.startsWith('cfB'));

const batchState = cfm.state(batchRes.flowId);
assert.ok(batchState, '应能查询到 batch 状态');
assert.strictEqual(batchState.batch.total, 2);
console.log('PASS: startBatch 批量任务启动与状态追踪正常');

// 取消该测试批次
const cancelRes = cfm.cancel(batchRes.flowId);
assert.strictEqual(cancelRes, true);
console.log('PASS: cancel 取消批量任务正常');

console.log('====================================');
console.log('全部 cf-verify 测试通过！');

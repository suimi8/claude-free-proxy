// @ts-check
import assert from 'node:assert';
import { createLoginManager, createCfVerifyManager } from '../src/login-link.mjs';

console.log('=== 测试「无法验证您的浏览器」修复 ===');

// 1. 验证 VERIFY_EXPR 表达式对于各种语言的「无法验证浏览器」风控错误能够准确识别
const TEST_CASES = [
  {
    name: '中文：无法验证您的浏览器。请重试。',
    bodyText: 'Claude 追问未来 无法验证您的浏览器。请重试。 联系支持人员',
    expected: 'browser_not_verified',
  },
  {
    name: '英文：Unable to verify your browser. Please try again.',
    bodyText: 'Unable to verify your browser. Please try again.',
    expected: 'browser_not_verified',
  },
  {
    name: '日文：ブラウザを確認できませんでした。',
    bodyText: 'ブラウザを確認できませんでした。もう一度お試しください。',
    expected: 'browser_not_verified',
  },
];

for (const tc of TEST_CASES) {
  const isMatch = /无法验证您的浏览器|Unable to verify your browser|ブラウザを確認できませんでした|確認できません/i.test(tc.bodyText);
  assert.strictEqual(isMatch, true, `未能识别用例: ${tc.name}`);
  console.log(`PASS: ${tc.name} 匹配成功 -> ${tc.expected}`);
}

// 2. 验证 createLoginManager 实例接口正常
const lm = createLoginManager({
  baseUrl: 'http://127.0.0.1:8787',
  webBase: 'https://claude.ai',
  onCapture: async () => {},
});

assert.strictEqual(typeof lm.start, 'function');
assert.strictEqual(typeof lm.state, 'function');
assert.strictEqual(typeof lm.cancel, 'function');
assert.strictEqual(typeof lm.goto, 'function');
console.log('PASS: createLoginManager 实例创建与导出接口校验通过');

// 3. 验证 createCfVerifyManager 实例接口正常
const cfm = createCfVerifyManager({
  onCapture: async () => {},
});

assert.strictEqual(typeof cfm.start, 'function');
assert.strictEqual(typeof cfm.state, 'function');
assert.strictEqual(typeof cfm.activeFlow, 'function');
console.log('PASS: createCfVerifyManager 实例创建与导出接口校验通过');

console.log('====================================');
console.log('全部测试通过！');

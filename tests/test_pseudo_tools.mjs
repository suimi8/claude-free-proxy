import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPseudoToolCalls, findToolCallTrigger } from '../src/openai-proxy.mjs';

test('extract XML function calls', () => {
  const input = `<function_calls> <invoke name="pwsh"> <parameter name="description">在拷贝里对 menu 和 meta 各跑一遍合并检查，并列出页面名和 NOTES 末行</parameter> <parameter name="command">[Console]::OutputEncoding=[System.Text.Encoding]::UTF8 \ng\n=\n′\nD\n:...</parameter> <parameter name="timeoutMs">200000</parameter> <parameter name="workdir">D:\\Downloads\\game</parameter> </invoke> </function_calls>`;
  const res = extractPseudoToolCalls(input);
  assert.equal(res.cleanText, '');
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].function.name, 'pwsh');
  const args = JSON.parse(res.toolCalls[0].function.arguments);
  assert.equal(args.description, '在拷贝里对 menu 和 meta 各跑一遍合并检查，并列出页面名和 NOTES 末行');
  assert.equal(args.timeoutMs, 200000);
  assert.equal(args.workdir, 'D:\\Downloads\\game');
  assert.ok(args.command.includes('[Console]::OutputEncoding'));
});

test('extract [TOOL_CALL ...] format', () => {
  const input = `I will check the agents.\n[TOOL_CALL list_agents id=toolu_01LiSTagentsAfterRestart] {}`;
  const res = extractPseudoToolCalls(input);
  assert.equal(res.cleanText, 'I will check the agents.');
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].function.name, 'list_agents');
  assert.equal(res.toolCalls[0].id, 'toolu_01LiSTagentsAfterRestart');
  assert.deepEqual(JSON.parse(res.toolCalls[0].function.arguments), {});
});

test('plain text without tool calls', () => {
  const input = `Hello, how can I help you today?`;
  const res = extractPseudoToolCalls(input);
  assert.equal(res.cleanText, input);
  assert.equal(res.toolCalls.length, 0);
});

test('extract XML function calls with XML entities and preamble text', () => {
  const input = `I am going to check files now.\n<function_calls>\n<invoke name="pwsh">\n<parameter name="command">if ($a &lt; 10 &amp;&amp; $b &gt; 5) { Write-Output &quot;OK&quot; }</parameter>\n</invoke>\n</function_calls>`;
  const res = extractPseudoToolCalls(input);
  assert.equal(res.cleanText, 'I am going to check files now.');
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].function.name, 'pwsh');
  const args = JSON.parse(res.toolCalls[0].function.arguments);
  assert.equal(args.command, 'if ($a < 10 && $b > 5) { Write-Output "OK" }');
});

test('extract multiple XML invokes', () => {
  const input = `<function_calls>\n<invoke name="read_file"><parameter name="path">a.txt</parameter></invoke>\n<invoke name="read_file"><parameter name="path">b.txt</parameter></invoke>\n</function_calls>`;
  const res = extractPseudoToolCalls(input);
  assert.equal(res.cleanText, '');
  assert.equal(res.toolCalls.length, 2);
  assert.equal(res.toolCalls[0].function.name, 'read_file');
  assert.equal(JSON.parse(res.toolCalls[0].function.arguments).path, 'a.txt');
  assert.equal(res.toolCalls[1].function.name, 'read_file');
  assert.equal(JSON.parse(res.toolCalls[1].function.arguments).path, 'b.txt');
});

test('extract multiple [TOOL_CALL ...]', () => {
  const input = `Running steps:\n[TOOL_CALL step1] {"target": 1}\n[TOOL_CALL step2] {"target": 2}`;
  const res = extractPseudoToolCalls(input);
  assert.equal(res.cleanText, 'Running steps:');
  assert.equal(res.toolCalls.length, 2);
  assert.equal(res.toolCalls[0].function.name, 'step1');
  assert.equal(JSON.parse(res.toolCalls[0].function.arguments).target, 1);
  assert.equal(res.toolCalls[1].function.name, 'step2');
  assert.equal(JSON.parse(res.toolCalls[1].function.arguments).target, 2);
});

test('streaming simulation with intercepted XML tool call', async () => {
  const chunks = [
    'I will run the command now:\n',
    '<function_c',
    'alls>\n<invoke name="p',
    'wsh">\n<parameter name="command">',
    'Get-Process',
    '</parameter>\n</invoke>\n</function_calls>'
  ];

  const emitted = [];
  const chunk = (delta, finish_reason = null) => {
    emitted.push({ delta, finish_reason });
  };

  let accumulatedText = '';
  let sentTextLength = 0;
  let pseudoToolMode = false;
  let finishedToolEmitted = false;
  let stop = null;
  const SAFE_WINDOW = 25;

  function findToolCallTrigger(text) {
    const triggers = ['[TOOL_CALL', '<function_calls', '<invoke name=', '<function_call name='];
    let minIdx = -1;
    for (const t of triggers) {
      const idx = text.toLowerCase().indexOf(t.toLowerCase());
      if (idx !== -1 && (minIdx === -1 || idx < minIdx)) {
        minIdx = idx;
      }
    }
    return minIdx;
  }

  const flushFallbackTools = () => {
    if (finishedToolEmitted) return;
    if (pseudoToolMode || findToolCallTrigger(accumulatedText) !== -1) {
      const extracted = extractPseudoToolCalls(accumulatedText);
      if (extracted.toolCalls.length > 0) {
        if (extracted.cleanText.length > sentTextLength) {
          chunk({ content: extracted.cleanText.slice(sentTextLength) });
          sentTextLength = extracted.cleanText.length;
        }
        for (let i = 0; i < extracted.toolCalls.length; i++) {
          const tc = extracted.toolCalls[i];
          chunk({
            tool_calls: [{
              index: i,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              }
            }]
          });
        }
        finishedToolEmitted = true;
        stop = 'tool_use';
        return;
      }
    }
    if (accumulatedText.length > sentTextLength) {
      chunk({ content: accumulatedText.slice(sentTextLength) });
      sentTextLength = accumulatedText.length;
    }
  };

  for (const textPiece of chunks) {
    accumulatedText += textPiece;
    if (pseudoToolMode) {
      // accumulating
    } else {
      const toolIdx = findToolCallTrigger(accumulatedText);
      if (toolIdx !== -1) {
        pseudoToolMode = true;
        if (toolIdx > sentTextLength) {
          chunk({ content: accumulatedText.slice(sentTextLength, toolIdx) });
          sentTextLength = toolIdx;
        }
      } else {
        const safeLen = Math.max(0, accumulatedText.length - SAFE_WINDOW);
        if (safeLen > sentTextLength) {
          chunk({ content: accumulatedText.slice(sentTextLength, safeLen) });
          sentTextLength = safeLen;
        }
      }
    }
  }

  flushFallbackTools();
  chunk({}, finishedToolEmitted ? 'tool_calls' : (stop || 'stop'));

  // 校验发送的内容：绝不能包含 <function_calls>
  const contentPushed = emitted.filter(e => e.delta?.content).map(e => e.delta.content).join('');
  assert.equal(contentPushed.trim(), 'I will run the command now:');
  assert.ok(!contentPushed.includes('<function_calls>'));

  // 校验 tool_calls
  const toolCallsEmitted = emitted.filter(e => e.delta?.tool_calls);
  assert.equal(toolCallsEmitted.length, 1);
  assert.equal(toolCallsEmitted[0].delta.tool_calls[0].function.name, 'pwsh');
  assert.deepEqual(JSON.parse(toolCallsEmitted[0].delta.tool_calls[0].function.arguments), { command: 'Get-Process' });

  // 校验 finish_reason
  const lastChunk = emitted[emitted.length - 1];
  assert.equal(lastChunk.finish_reason, 'tool_calls');
});

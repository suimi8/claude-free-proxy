import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPseudoToolCalls, findToolCallTrigger } from '../src/openai-proxy.mjs';
import { validatedEvents } from '../src/upstream-events.mjs';

test('validatedEvents does not crash on stop_reason tool_use without held block', async () => {
  const sseLines = [
    'data: {"type": "message_start", "message": {"id": "msg_1", "role": "assistant"}}',
    '',
    'data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}',
    '',
    'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "test"}}',
    '',
    'data: {"type": "content_block_stop", "index": 0}',
    '',
    'data: {"type": "message_delta", "delta": {"stop_reason": "tool_use"}}',
    '',
    'data: {"type": "message_stop"}',
    '',
    ''
  ].join('\n');

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseLines));
      controller.close();
    }
  });

  const events = [];
  for await (const ev of validatedEvents(stream, [])) {
    events.push(ev);
  }

  const msgDelta = events.find(e => e.type === 'message_delta');
  assert.ok(msgDelta, 'should have message_delta');
  assert.equal(msgDelta.delta.stop_reason, 'end_turn');
});

test('end-to-end integration: upstream emits XML in text + stop_reason tool_use', async () => {
  const xmlPayload = '<function_calls><invoke name="pwsh"><parameter name="command">Get-Process</parameter></invoke></function_calls>';
  const sseLines = [
    'data: {"type": "message_start", "message": {"id": "msg_2", "role": "assistant"}}',
    '',
    'data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}',
    '',
    `data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": ${JSON.stringify(xmlPayload)}}}`,
    '',
    'data: {"type": "content_block_stop", "index": 0}',
    '',
    'data: {"type": "message_delta", "delta": {"stop_reason": "tool_use"}}',
    '',
    'data: {"type": "message_stop"}',
    '',
    ''
  ].join('\n');

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseLines));
      controller.close();
    }
  });

  let fullText = '';
  let stopReason = null;
  for await (const ev of validatedEvents(stream, [])) {
    if (ev.type === 'content_block_delta' && ev.delta?.text) {
      fullText += ev.delta.text;
    }
    if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
      stopReason = ev.delta.stop_reason;
    }
  }

  // 校验事件流正常结束，没有抛出 502
  assert.equal(stopReason, 'end_turn');

  // 校验下游兜底解析器成功提取工具调用
  const extracted = extractPseudoToolCalls(fullText);
  assert.equal(extracted.toolCalls.length, 1);
  assert.equal(extracted.toolCalls[0].function.name, 'pwsh');
  assert.deepEqual(JSON.parse(extracted.toolCalls[0].function.arguments), { command: 'Get-Process' });
});

test('extract XML function calls when closing invoke or function_calls is omitted', () => {
  const input = `<function_calls> <invoke name="pwsh"> <parameter name="description">只读：确认 hdraw 里 now 的单位，查已有流程在 t.mjs 的接入写法和 skin_flow 开头</parameter> <parameter name="command">[Console]::OutputEncoding=[System.Text.Encoding]::UTF8 \ng\n=\n′\nD\n:...\n</parameter> <parameter name="timeoutMs">30000</parameter> <parameter name="workdir">D:\\Downloads\\game</parameter>`;
  const res = extractPseudoToolCalls(input);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].function.name, 'pwsh');
  const args = JSON.parse(res.toolCalls[0].function.arguments);
  assert.equal(args.timeoutMs, 30000);
  assert.equal(args.workdir, 'D:\\Downloads\\game');
});

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

test('streaming simulation with intercepted unclosed XML tool call', async () => {
  const chunks = [
    '<function_calls> <invoke name="pwsh"> ',
    '<parameter name="description">只读测试</parameter> ',
    '<parameter name="command">dir</parameter> ',
    '<parameter name="timeoutMs">30000</parameter> ',
    '<parameter name="workdir">D:\\Downloads\\game</parameter>'
    // 注意：末尾完全没有 </invoke> </function_calls>，模拟截断
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

  // 校验发送的内容：绝不能有任何 content 泄露给客户端
  const contentPushed = emitted.filter(e => e.delta?.content).map(e => e.delta.content).join('');
  assert.equal(contentPushed, '');

  // 校验 tool_calls 正常下发
  const toolCallsEmitted = emitted.filter(e => e.delta?.tool_calls);
  assert.equal(toolCallsEmitted.length, 1);
  assert.equal(toolCallsEmitted[0].delta.tool_calls[0].function.name, 'pwsh');
  const args = JSON.parse(toolCallsEmitted[0].delta.tool_calls[0].function.arguments);
  assert.equal(args.description, '只读测试');
  assert.equal(args.command, 'dir');
  assert.equal(args.timeoutMs, 30000);
  assert.equal(args.workdir, 'D:\\Downloads\\game');

  // 校验 finish_reason
  const lastChunk = emitted[emitted.length - 1];
  assert.equal(lastChunk.finish_reason, 'tool_calls');
});

test('extract XML function calls with exec_command and unclosed tag (user case)', () => {
  const input = `<function_calls>
<invoke name="exec_command">
<parameter name="cmd">[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = (Get-Location).Path
Get-ChildItem -Recurse -File -Include .py,.sh,.md,.txt,.toml,.yml,*.json |
Where-Object { $.FullName -notmatch 'pycache' } |
Select-String -Pattern 'pwsh|powershell|.ps1' -Encoding UTF8 |
ForEach-Object { '{0}:{1}: {2}' -f $.Path.Substring($root.Length + 1), $_.LineNumber, (($_.Line.Trim()) -replace '\\s+', ' ') } |
Select-Object -First 80</parameter>
<parameter name="workdir">D:\\Desktop\\Agent-Reach-main</parameter>
<parameter name="max_output_tokens">6000</parameter>`;

  const res = extractPseudoToolCalls(input);
  assert.equal(res.cleanText, '');
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].function.name, 'exec_command');
  const args = JSON.parse(res.toolCalls[0].function.arguments);
  assert.ok(args.cmd.includes('[Console]::OutputEncoding'));
  assert.equal(args.workdir, 'D:\\Desktop\\Agent-Reach-main');
  assert.equal(args.max_output_tokens, 6000);
});

test('extract XML function calls with <function> and <param> / <arg> tags and attributes', () => {
  const input = `<function_calls>
<function name="web_search" id="call_custom_99">
<arg name="query">Anthropic Claude</arg>
<param name="max_results">5</param>
</function>
</function_calls>`;
  const res = extractPseudoToolCalls(input);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].function.name, 'web_search');
  assert.equal(res.toolCalls[0].id, 'call_custom_99');
  const args = JSON.parse(res.toolCalls[0].function.arguments);
  assert.equal(args.query, 'Anthropic Claude');
  assert.equal(args.max_results, 5);
});

test('Responses API streaming simulation with intercepted XML tool call', () => {
  const chunks = [
    '<function_calls>\n<invoke name="exec_command">\n',
    '<parameter name="cmd">[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\nGet-Process</parameter>\n',
    '<parameter name="workdir">D:\\Desktop\\Agent-Reach-main</parameter>\n',
    '<parameter name="max_output_tokens">6000</parameter>'
  ];

  const events = [];
  const send = (type, payload) => events.push({ type, payload });

  const items = [];
  const slot = new Map();
  let msgRef = null;
  let text = '';
  let stop = null;
  let lastItem = null;
  let sentTextLength = 0;
  let pseudoToolMode = false;
  let finishedToolEmitted = false;
  const SAFE_WINDOW = 25;

  const ensureMsgRef = () => {
    if (!msgRef) {
      const item = { type: 'message', id: 'msg_1', status: 'in_progress', role: 'assistant', content: [] };
      const index = items.length;
      items.push(item);
      msgRef = { item, index };
      lastItem = item;
      send('response.output_item.added', { output_index: index, item: { ...item, content: [] } });
      send('response.content_part.added', {
        item_id: item.id, output_index: index, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
  };

  const flushFallbackToolsIfNeeded = () => {
    if (slot.size > 0 || finishedToolEmitted) return;
    if (pseudoToolMode || findToolCallTrigger(text) !== -1) {
      const extracted = extractPseudoToolCalls(text);
      if (extracted.toolCalls.length > 0) {
        if (extracted.cleanText.length > sentTextLength) {
          ensureMsgRef();
          send('response.output_text.delta', {
            item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0,
            delta: extracted.cleanText.slice(sentTextLength), logprobs: [],
          });
          sentTextLength = extracted.cleanText.length;
        }
        if (msgRef) {
          const part = { type: 'output_text', text: extracted.cleanText, annotations: [] };
          msgRef.item.content = [part];
          msgRef.item.status = 'completed';
          const ref = { item_id: msgRef.item.id, output_index: msgRef.index };
          send('response.output_text.done', { ...ref, content_index: 0, text: extracted.cleanText, logprobs: [] });
          send('response.content_part.done', { ...ref, content_index: 0, part });
          send('response.output_item.done', { output_index: msgRef.index, item: msgRef.item });
        }
        for (let i = 0; i < extracted.toolCalls.length; i++) {
          const tc = extracted.toolCalls[i];
          const item = {
            type: 'function_call',
            id: 'fc_1',
            call_id: tc.id || 'call_1',
            name: tc.function.name,
            arguments: tc.function.arguments || '{}',
            status: 'completed',
          };
          const index = items.length;
          items.push(item);
          slot.set(`fallback_${i}`, { item, index });
          lastItem = item;
          send('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', arguments: '' } });
          send('response.function_call_arguments.delta', {
            item_id: item.id, output_index: index,
            delta: item.arguments,
          });
          send('response.function_call_arguments.done', {
            item_id: item.id, output_index: index,
            arguments: item.arguments,
          });
          send('response.output_item.done', { output_index: index, item });
        }
        finishedToolEmitted = true;
        stop = 'tool_use';
        text = extracted.cleanText;
        return;
      }
    }
    if (text.length > sentTextLength) {
      ensureMsgRef();
      send('response.output_text.delta', {
        item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0,
        delta: text.slice(sentTextLength), logprobs: [],
      });
      sentTextLength = text.length;
    }
  };

  for (const piece of chunks) {
    text += piece;
    if (slot.size === 0) {
      if (pseudoToolMode) {
        // 处于伪工具拦截状态，静默缓冲
      } else {
        const toolIdx = findToolCallTrigger(text);
        if (toolIdx !== -1) {
          pseudoToolMode = true;
          if (toolIdx > sentTextLength) {
            ensureMsgRef();
            send('response.output_text.delta', {
              item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0,
              delta: text.slice(sentTextLength, toolIdx), logprobs: [],
            });
            sentTextLength = toolIdx;
          }
        } else {
          const safeLen = Math.max(0, text.length - SAFE_WINDOW);
          if (safeLen > sentTextLength) {
            ensureMsgRef();
            send('response.output_text.delta', {
              item_id: msgRef.item.id, output_index: msgRef.index, content_index: 0,
              delta: text.slice(sentTextLength, safeLen), logprobs: [],
            });
            sentTextLength = safeLen;
          }
        }
      }
    }
  }

  flushFallbackToolsIfNeeded();

  // 校验没有文本内容泄露
  const textDeltas = events.filter(e => e.type === 'response.output_text.delta');
  assert.equal(textDeltas.length, 0);

  // 校验生成了 function_call output item
  const itemAdded = events.find(e => e.type === 'response.output_item.added');
  assert.ok(itemAdded, 'should emit output_item.added');
  assert.equal(itemAdded.payload.item.type, 'function_call');
  assert.equal(itemAdded.payload.item.name, 'exec_command');

  // 校验参数正常下发
  const argsDelta = events.find(e => e.type === 'response.function_call_arguments.delta');
  assert.ok(argsDelta, 'should emit function_call_arguments.delta');
  const parsedArgs = JSON.parse(argsDelta.payload.delta);
  assert.ok(parsedArgs.cmd.includes('[Console]::OutputEncoding'));
  assert.equal(parsedArgs.workdir, 'D:\\Desktop\\Agent-Reach-main');
  assert.equal(parsedArgs.max_output_tokens, 6000);

  // 校验 output_item.done
  const itemDone = events.find(e => e.type === 'response.output_item.done');
  assert.ok(itemDone);
  assert.equal(itemDone.payload.item.type, 'function_call');
  assert.equal(itemDone.payload.item.status, 'completed');
  assert.equal(stop, 'tool_use');
});

test('Anthropic Messages SSE streaming simulation with intercepted XML tool call', () => {
  const chunks = [
    '<function_calls>\n<invoke name="exec_command">\n',
    '<parameter name="cmd">dir</parameter>\n',
    '<parameter name="workdir">D:\\Desktop</parameter>\n',
    '</invoke>\n</function_calls>'
  ];

  const events = [];
  const send = o => events.push(o);

  let hasNativeTool = false;
  let textBlockIndex = 0;
  let textBlockStarted = false;
  let textBlockClosed = false;
  let accumulatedText = '';
  let sentTextLength = 0;
  let pseudoToolMode = false;
  let fallbackToolsEmitted = false;
  let nextBlockIndex = 0;
  const SAFE_WINDOW = 25;

  const flushAnthropicFallback = () => {
    if (hasNativeTool || fallbackToolsEmitted) return;
    if (pseudoToolMode || findToolCallTrigger(accumulatedText) !== -1) {
      const extracted = extractPseudoToolCalls(accumulatedText);
      if (extracted.toolCalls.length > 0) {
        if (extracted.cleanText.length > sentTextLength) {
          const chunk = extracted.cleanText.slice(sentTextLength);
          if (!textBlockStarted && textBlockIndex !== -1) {
            send({ type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } });
            textBlockStarted = true;
          }
          if (textBlockStarted) {
            send({ type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: chunk } });
          }
          sentTextLength = extracted.cleanText.length;
        }
        if (textBlockStarted && !textBlockClosed) {
          send({ type: 'content_block_stop', index: textBlockIndex });
          textBlockClosed = true;
        }
        for (const tc of extracted.toolCalls) {
          const bIdx = nextBlockIndex++;
          send({
            type: 'content_block_start',
            index: bIdx,
            content_block: {
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: {},
            }
          });
          send({
            type: 'content_block_delta',
            index: bIdx,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments,
            }
          });
          send({ type: 'content_block_stop', index: bIdx });
        }
        fallbackToolsEmitted = true;
        return;
      }
    }
    if (accumulatedText.length > sentTextLength) {
      const chunk = accumulatedText.slice(sentTextLength);
      if (!textBlockStarted && textBlockIndex !== -1) {
        send({ type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } });
        textBlockStarted = true;
      }
      if (textBlockStarted) {
        send({ type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: chunk } });
      }
      sentTextLength = accumulatedText.length;
    }
    if (textBlockStarted && !textBlockClosed) {
      send({ type: 'content_block_stop', index: textBlockIndex });
      textBlockClosed = true;
    }
  };

  for (const piece of chunks) {
    accumulatedText += piece;
    if (pseudoToolMode) {
      // 缓冲中
    } else {
      const toolIdx = findToolCallTrigger(accumulatedText);
      if (toolIdx !== -1) {
        pseudoToolMode = true;
        if (toolIdx > sentTextLength) {
          const chunk = accumulatedText.slice(sentTextLength, toolIdx);
          if (!textBlockStarted && textBlockIndex !== -1) {
            send({ type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } });
            textBlockStarted = true;
          }
          if (textBlockStarted) {
            send({ type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: chunk } });
          }
          sentTextLength = toolIdx;
        }
      } else {
        const safeLen = Math.max(0, accumulatedText.length - SAFE_WINDOW);
        if (safeLen > sentTextLength) {
          const chunk = accumulatedText.slice(sentTextLength, safeLen);
          if (!textBlockStarted && textBlockIndex !== -1) {
            send({ type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } });
            textBlockStarted = true;
          }
          if (textBlockStarted) {
            send({ type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: chunk } });
          }
          sentTextLength = safeLen;
        }
      }
    }
  }

  flushAnthropicFallback();

  let msgDelta = { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
  if (fallbackToolsEmitted) {
    msgDelta = { ...msgDelta, delta: { ...msgDelta.delta, stop_reason: 'tool_use' } };
  }
  send(msgDelta);

  // 校验事件：必须包含 tool_use 的 content_block_start 与 input_json_delta
  const blockStart = events.find(e => e.type === 'content_block_start');
  assert.ok(blockStart);
  assert.equal(blockStart.content_block.type, 'tool_use');
  assert.equal(blockStart.content_block.name, 'exec_command');

  const jsonDelta = events.find(e => e.type === 'content_block_delta');
  assert.ok(jsonDelta);
  assert.equal(jsonDelta.delta.type, 'input_json_delta');
  const parsed = JSON.parse(jsonDelta.delta.partial_json);
  assert.equal(parsed.cmd, 'dir');
  assert.equal(parsed.workdir, 'D:\\Desktop');

  assert.equal(msgDelta.delta.stop_reason, 'tool_use');
});

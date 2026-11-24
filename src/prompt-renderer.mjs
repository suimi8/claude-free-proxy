/**
 * prompt-renderer.mjs —— 提示词渲染、格式化与清洗模块
 *
 * 核心功能：
 *   1. cleanTerminalNoise(text)：清理终端控制码、ANSI 颜色代码及进度条覆盖重绘符
 *   2. escapePromptMarkers(text)：安全转义用户与工具文本中的特殊标记 [SYSTEM]、[USER]、[ASSISTANT]、
 *      [TOOL_CALL]、[TOOL_RESULT] 为 [\u200B$1，彻底防御提示词注入攻击 (Defect 3)
 *   3. textOf(content)：多格式内容块（string, block array, image placeholder）文本安全提取
 *   4. renderPrompt(body, opts)：将多轮消息、系统提示、工具说明统一渲染为上游结构化 prompt
 *   5. pickEffort(body, pool)：思考档位映射 (low/medium/high/xhigh/max)
 *   6. pruneToolText(text, maxChars)：单段工具文本智能折叠
 *   7. countTokens(s), estimateInputTokens(...)：中英双口径 Token 估算
 */

export const PRUNE_ENABLED = process.env.PRUNE_CONTEXT !== 'off';
export const PRUNE_MAX_TOOL_CHARS = +(process.env.PRUNE_MAX_TOOL_CHARS || 8000);
export const PRUNE_KEEP_RECENT_TOOLS = +(process.env.PRUNE_KEEP_RECENT_TOOLS || 4);

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_EFFORT = EFFORTS.includes(String(process.env.DEFAULT_EFFORT || '').toLowerCase())
  ? String(process.env.DEFAULT_EFFORT).toLowerCase() : 'max';

/**
 * 清理 ANSI 颜色与终端控制码，规范化行结束符并去除覆盖式重绘进度条
 * @param {string} text
 * @returns {string}
 */
export function cleanTerminalNoise(text) {
  if (!text || typeof text !== 'string') return text;
  // 1. 去除 ANSI 颜色与终端控制码
  let s = text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  // 2. 先将 Windows CRLF 规范化为 LF，避免行尾的 \r 导致整行被 slice 吞噬
  s = s.replace(/\r\n/g, '\n');
  // 3. 清理终端覆盖式进度条 (如 npm/pip 产生的海量 \r 重绘，只保留每行最后一次绘制)
  if (s.includes('\r')) {
    s = s.split('\n').map(l => {
      const idx = l.lastIndexOf('\r');
      return idx >= 0 ? l.slice(idx + 1) : l;
    }).join('\n');
  }
  return s;
}

/**
 * 修复缺陷 3：对消息与工具文本中的对话标记进行安全转义，
 * 在左括号后插入零宽空格 \u200B，防止用户或第三方工具返回内容伪造角色边界与系统指令。
 *   [SYSTEM] -> [\u200BSYSTEM]
 *   [USER] -> [\u200BUSER]
 *   [ASSISTANT] -> [\u200BASSISTANT]
 *   [TOOL_CALL] -> [\u200BTOOL_CALL]
 *   [TOOL_RESULT] -> [\u200BTOOL_RESULT]
 *
 * @param {string} text
 * @returns {string}
 */
export function escapePromptMarkers(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/\[(SYSTEM|USER|ASSISTANT|TOOL_CALL|TOOL_RESULT)/gi, '[\u200B$1');
}

/**
 * 递归/安全提取多类型内容块的纯文本表示
 * @param {*} content
 * @returns {string}
 */
export function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => {
      if (typeof c === 'string') return c;
      if (!c || typeof c !== 'object') return '';
      if (typeof c.type === 'string' && c.type.includes('image')) return '[image]';
      if (typeof c.text === 'string') return c.text;
      if (typeof c.content === 'string') return c.content;
      if (Array.isArray(c.content)) return textOf(c.content);
      if (typeof c.refusal === 'string') return c.refusal;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') {
    try { return JSON.stringify(content); } catch { return ''; }
  }
  return '';
}

/**
 * 历史超长工具输出折叠：保留头部 60% 与尾部 30% 关键信息，折叠中间冗余字符
 * @param {string} text
 * @param {number} [maxChars=PRUNE_MAX_TOOL_CHARS]
 * @returns {string}
 */
export function pruneToolText(text, maxChars = PRUNE_MAX_TOOL_CHARS) {
  if (!text || text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.floor(maxChars * 0.3);
  const omitted = text.length - (headLen + tailLen);
  if (omitted <= 300) return text;
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  return `${head}\n\n[...反代智能瘦身: 中间省略 ${omitted} 字符 (历史工具输出已折叠，不影响当前任务)...]\n\n${tail}`;
}

/**
 * 将多轮 messages 历史渲染成一段结构化 prompt 文本。
 * 用户和工具输入自动经过 cleanTerminalNoise 与 escapePromptMarkers 处理。
 *
 * @param {object} body - OpenAI 格式请求体
 * @param {object} [opts={}] - 可选配置 { pool, pruneEnabled, pruneMaxChars, pruneKeepRecent, onPruned }
 * @returns {string} 渲染后的 prompt 文本
 */
export function renderPrompt(body, opts = {}) {
  const parts = [];
  const systems = [];
  if (typeof body.system === 'string') systems.push(body.system);
  else if (Array.isArray(body.system)) systems.push(...body.system.map(s => (typeof s === 'string' ? s : s.text)));

  const msgs = body.messages || [];

  const pool = opts.pool;
  const pruneEnabled = opts.pruneEnabled ?? ((typeof pool?.data?.pruneContext === 'boolean') ? pool.data.pruneContext : PRUNE_ENABLED);
  const pruneMaxChars = opts.pruneMaxChars ?? ((typeof pool?.data?.pruneMaxToolChars === 'number') ? pool.data.pruneMaxToolChars : PRUNE_MAX_TOOL_CHARS);
  const pruneKeepRecent = opts.pruneKeepRecent ?? ((typeof pool?.data?.pruneKeepRecentTools === 'number') ? pool.data.pruneKeepRecentTools : PRUNE_KEEP_RECENT_TOOLS);

  // 找出所有 tool/function 角色的消息索引
  const toolIndices = [];
  for (let idx = 0; idx < msgs.length; idx++) {
    const role = msgs[idx]?.role;
    if (role === 'tool' || role === 'function') {
      toolIndices.push(idx);
    }
  }

  const recentToolThresholdIdx = toolIndices.length > pruneKeepRecent
    ? toolIndices[toolIndices.length - pruneKeepRecent]
    : -1;

  let prunedCount = 0;
  let savedChars = 0;

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'system' || m.role === 'developer') {
      systems.push(textOf(m.content));
      continue;
    }
    if (m.role === 'user') {
      const uText = escapePromptMarkers(cleanTerminalNoise(textOf(m.content)));
      parts.push(`[USER]\n${uText}`);
    } else if (m.role === 'assistant') {
      let t = escapePromptMarkers(textOf(m.content));
      for (const tc of m.tool_calls || []) {
        t += `\n[TOOL_CALL ${tc.function?.name || 'unknown'}${tc.id ? ' id=' + tc.id : ''}] ${tc.function?.arguments || '{}'}`;
      }
      parts.push(`[ASSISTANT]\n${t || '(no content)'}`);
    } else if (m.role === 'tool' || m.role === 'function') {
      let rawText = cleanTerminalNoise(textOf(m.content));
      if (pruneEnabled && i < recentToolThresholdIdx && rawText.length > pruneMaxChars) {
        const pruned = pruneToolText(rawText, pruneMaxChars);
        savedChars += (rawText.length - pruned.length);
        prunedCount++;
        rawText = pruned;
      }
      const safeRawText = escapePromptMarkers(rawText);
      const label = m.name && m.tool_call_id ? `${m.name} id=${m.tool_call_id}` : (m.name || m.tool_call_id || '');
      parts.push(`[TOOL_RESULT ${label}${m.is_error === true ? ' is_error=true' : ''}]\n${safeRawText}`);
    }
  }

  const hasTools = (Array.isArray(body?.tools) && body.tools.length > 0) ||
                   (Array.isArray(body?.functions) && body.functions.length > 0);
  if (hasTools) {
    systems.push(
      '[TOOL CALLING INSTRUCTION]\n' +
      '1. You are equipped with real tools via native tool_use. Invoke only the tools explicitly declared in the tools list.\n' +
      '2. The tags "[TOOL_CALL ...]" and "[TOOL_RESULT ...]" in previous messages are historical conversation transcription markers only.\n' +
      '3. CRITICAL: When calling tools, you MUST invoke native tool calls (tool_use). NEVER output literal "[TOOL_CALL ...]", "<function_calls>", or "<invoke>" text in your response content.\n' +
      '4. Internal sandbox tools such as "view", "repl", or "/mnt/skills" do NOT exist. Answer or execute directly using available tools.'
    );
  }

  let prompt = '';
  if (systems.length) prompt += `[SYSTEM]\n${systems.join('\n\n')}\n\n`;
  prompt += parts.join('\n\n');

  if (prunedCount > 0 && savedChars > 0 && typeof opts.onPruned === 'function') {
    opts.onPruned({ prunedCount, savedChars });
  }

  return prompt.trim() || 'hi';
}

/**
 * 思考档位映射
 * @param {object} body
 * @param {object} [pool=null]
 * @returns {string|null}
 */
export function pickEffort(body, pool = null) {
  const poolDefault = pool?.data?.defaultEffort;
  const curDef = (poolDefault && EFFORTS.includes(poolDefault))
    ? poolDefault
    : DEFAULT_EFFORT;
  if (!body || typeof body !== 'object') return curDef;
  const norm = v => (typeof v === 'string' && EFFORTS.includes(v.toLowerCase())) ? v.toLowerCase() : null;
  const direct = norm(body.effort);
  if (direct) return direct;
  const re = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.toLowerCase() : '';
  if (re === 'none' || re === 'off') return null;
  if (re === 'minimal') return 'low';
  const mapped = norm(re);
  if (mapped) return mapped;
  const th = body.thinking;
  if (th && typeof th === 'object') {
    if (th.type === 'disabled') return null;
    if (th.type === 'enabled') {
      const b = +th.budget_tokens || 0;
      return b >= 10000 ? 'max' : b >= 4096 ? 'xhigh' : 'high';
    }
  }
  return curDef;
}

/**
 * 中英文 Token 估算：汉字 1 字 1 token，其余字符约 4 字符 1 token
 * @param {string} s
 * @returns {number}
 */
export function countTokens(s) {
  if (!s) return 0;
  const str = String(s);
  let cjk = 0, other = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x3000 && cp <= 0x303f) ||
        (cp >= 0x3040 && cp <= 0x30ff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0xf900 && cp <= 0xfaff)) {
      cjk++;
    } else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 估算逻辑输入 Token 总量
 * @param {{ prompt: string, tools?: any }} param0
 * @returns {number}
 */
export function estimateInputTokens({ prompt, tools }) {
  return Math.max(1, countTokens(prompt) + (tools ? countTokens(JSON.stringify(tools)) : 0));
}

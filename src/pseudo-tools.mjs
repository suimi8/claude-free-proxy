/**
 * pseudo-tools.mjs —— 伪工具调用 / XML 工具调用提取与 AST 解析模块
 *
 * 核心功能：
 *   1. 拦截与提取 LLM 幻觉在正文中输出的 XML (<function_calls>, <invoke>, <function>, <param>, <arg>)
 *      以及历史标记格式 ([TOOL_CALL <name> id=<id>] <args>)
 *   2. 支持白名单过滤 (declaredToolNames)：仅当工具名称在白名单中时才提取，防止非工具 XML 被误当成工具
 *   3. 容错解析：处理属性引号缺失、未闭合标签、末尾截断等复杂生成边界
 *   4. XML 实体与转义参数还原 (unescapeXml, unescapeArg)
 */
import { randomUUID } from 'node:crypto';

/**
 * 还原常见 XML 转义实体
 * @param {string} str
 * @returns {string}
 */
export function unescapeXml(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 还原并解析参数值：先解 XML 实体，若为合法的 JSON 基本类型或复合类型则自动转换
 * @param {*} val
 * @returns {*}
 */
export function unescapeArg(val) {
  if (typeof val !== 'string') return val;
  const unescaped = unescapeXml(val.trim());
  try {
    const parsed = JSON.parse(unescaped);
    if (typeof parsed === 'number' || typeof parsed === 'boolean' || Array.isArray(parsed) || (parsed && typeof parsed === 'object')) {
      return parsed;
    }
  } catch {}
  return unescaped;
}

/**
 * 快速探测文本中是否包含伪工具调用的触发标记，用于流式输出时暂停吐字并进入缓冲模式
 * @param {string} text
 * @returns {number} 首次出现的索引，未匹配返回 -1
 */
export function findToolCallTrigger(text) {
  if (!text || typeof text !== 'string') return -1;
  const match = /(?:\[TOOL_CALL|<function_calls|<(?:invoke|function_call|function)\b)/i.exec(text);
  return match ? match.index : -1;
}

/**
 * 伪工具调用 / XML 工具调用提取器 (Fallback Tool Call Extractor):
 * 在多轮 Agent 会话中，Claude 模型若在正文中输出了工具调用标签，
 * 本函数将其自动解析、提取并从正文中剥离，转换为 OpenAI 标准的 tool_calls 列表。
 *
 * @param {string} fullText - 待解析的完整响应文本
 * @param {string[]|Set<string>|null} [declaredToolNames=null] - 可选声明工具白名单列表
 * @returns {{ cleanText: string, toolCalls: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }> }}
 */
export function extractPseudoToolCalls(fullText, declaredToolNames = null) {
  if (!fullText || typeof fullText !== 'string') return { cleanText: fullText || '', toolCalls: [] };

  const allowedSet = declaredToolNames
    ? (declaredToolNames instanceof Set ? declaredToolNames : new Set(Array.isArray(declaredToolNames) ? declaredToolNames : [declaredToolNames]))
    : null;

  const isAllowed = name => !allowedSet || allowedSet.size === 0 || allowedSet.has(name);

  const toolCalls = [];
  let firstCallIdx = fullText.length;

  // 1. 匹配 XML <function_calls> 或 <invoke name="..."> 或 <function_call name="..."> 或 <function name="...">
  // 容错：允许任意属性顺序、类型声明以及末尾省略 </invoke> 或 </function_calls>（LLM 生成截断或未闭合）
  const xmlInvokeStartRegex = /<(?:invoke|function_call|function)\b([^>]*?)>/gi;
  const invokeMatches = [];
  let m;
  while ((m = xmlInvokeStartRegex.exec(fullText)) !== null) {
    const attrs = m[1];
    const nameMatch = /\bname=["']?([a-zA-Z0-9_\-\.]+)["']?/i.exec(attrs);
    if (!nameMatch) continue;
    const toolName = nameMatch[1];
    if (!isAllowed(toolName)) continue;
    const idMatch = /\bid=["']?([a-zA-Z0-9_\-\.]+)["']?/i.exec(attrs);
    invokeMatches.push({
      name: toolName,
      id: idMatch ? idMatch[1] : undefined,
      startIndex: m.index,
      bodyStart: m.index + m[0].length,
    });
  }

  for (let i = 0; i < invokeMatches.length; i++) {
    const cur = invokeMatches[i];
    const nextStart = (i + 1 < invokeMatches.length) ? invokeMatches[i + 1].startIndex : fullText.length;
    let slice = fullText.slice(cur.bodyStart, nextStart);

    // 检查是否有闭合标签 </invoke> 或 </function_call> 或 </function> 或 </function_calls>
    const closeMatch = /<\/(?:invoke|function_call|function|function_calls)>/i.exec(slice);
    const body = closeMatch ? slice.slice(0, closeMatch.index) : slice;

    const args = {};
    // 支持闭合的 <parameter ...>...</parameter> / <param ...> / <arg ...>，以及末尾未闭合的参数标签
    const paramRegex = /<(?:parameter|param|arg)\b([^>]*?)(?:\/>|>([\s\S]*?)(?:<\/(?:parameter|param|arg)>|(?=<(?:parameter|param|arg)\b)|$))/gi;
    let paramMatch;
    let hasParams = false;
    while ((paramMatch = paramRegex.exec(body)) !== null) {
      const pAttrs = paramMatch[1];
      const pNameMatch = /\bname=["']?([a-zA-Z0-9_\-\.]+)["']?/i.exec(pAttrs);
      if (!pNameMatch) continue;
      hasParams = true;
      const pName = pNameMatch[1];
      const pVal = paramMatch[2] !== undefined ? unescapeArg(paramMatch[2]) : '';
      args[pName] = pVal;
    }
    let argsStr = '{}';
    if (hasParams) {
      argsStr = JSON.stringify(args);
    } else {
      const trimmed = body.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        argsStr = trimmed;
      }
    }

    const startIdx = cur.startIndex;
    const fcTag = '<function_calls>';
    const fcIdx = fullText.lastIndexOf(fcTag, startIdx);
    let effectiveStart = startIdx;
    if (fcIdx !== -1 && fullText.slice(fcIdx + fcTag.length, startIdx).trim() === '') {
      effectiveStart = fcIdx;
    }
    if (effectiveStart < firstCallIdx) firstCallIdx = effectiveStart;

    toolCalls.push({
      id: cur.id || ('call_' + randomUUID().replace(/-/g, '').slice(0, 9)),
      type: 'function',
      function: {
        name: cur.name,
        arguments: argsStr
      }
    });
  }

  // 2. 匹配 [TOOL_CALL <name> ...] 标记
  if (toolCalls.length === 0) {
    const markerRegex = /\[TOOL_CALL(?::|\s+)?([a-zA-Z0-9_\-\.]+)(?:\s+id=([a-zA-Z0-9_\-\.]+))?\s*\]/g;
    let match;
    const matches = [];
    while ((match = markerRegex.exec(fullText)) !== null) {
      const toolName = match[1];
      if (!isAllowed(toolName)) continue;
      matches.push({
        name: toolName,
        id: match[2],
        startIndex: match.index,
        argsStart: match.index + match[0].length,
      });
    }

    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      const nextStart = (i + 1 < matches.length) ? matches[i + 1].startIndex : fullText.length;
      let candidate = fullText.slice(cur.argsStart, nextStart).trim();

      let parsedArgs = '{}';
      const braceStart = candidate.indexOf('{');
      if (braceStart !== -1) {
        let depth = 0;
        let inString = false;
        let escape = false;
        let braceEnd = -1;
        for (let pos = braceStart; pos < candidate.length; pos++) {
          const ch = candidate[pos];
          if (escape) { escape = false; continue; }
          if (ch === '\\') { escape = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (!inString) {
            if (ch === '{') depth++;
            else if (ch === '}') {
              depth--;
              if (depth === 0) { braceEnd = pos; break; }
            }
          }
        }
        if (braceEnd !== -1) {
          parsedArgs = candidate.slice(braceStart, braceEnd + 1);
        }
      }
      try {
        JSON.parse(parsedArgs);
      } catch {
        parsedArgs = JSON.stringify({ input: parsedArgs });
      }

      toolCalls.push({
        id: cur.id || ('call_' + randomUUID().replace(/-/g, '').slice(0, 9)),
        type: 'function',
        function: {
          name: cur.name,
          arguments: parsedArgs
        }
      });
      if (cur.startIndex < firstCallIdx) firstCallIdx = cur.startIndex;
    }
  }

  const cleanText = fullText.slice(0, firstCallIdx).trimEnd();
  return { cleanText, toolCalls };
}

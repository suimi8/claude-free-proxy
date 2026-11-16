/**
 * context-optimizer.mjs - 媒体与长上下文性能优化模块
 *
 * 背景与目标：
 * 在长对话（如 15 轮以上）中，用户历史中积累了多张图片和巨量工具调用结果，
 * 导致每次向反代或上游发请求都要全量上传所有历史旧图片、传输海量 Prompt，
 * 进而导致首字延迟（TTFB）极慢并浪费带宽与上下文窗口。
 *
 * 本模块导出纯函数：
 * 1. pruneMessageImages(messages, keepRecentTurns = 2, maxImages = 3)
 *    智能扫描 messages 列表，计算每条消息距离最后的轮次。
 *    仅最近 keepRecentTurns 轮（且总数不超过 maxImages 张）的图片保留真实图片内容，
 *    更早的历史图片自动降级为文本占位：[历史图片: 早期对话已接收并分析完毕]。
 *
 * 2. pruneToolOutputs(messages, options = {})
 *    智能修剪早期的 tool/function 输出。最近 2 轮的工具结果保留完整；
 *    早期的工具结果如果超过 2000 字符，保留头部 15 行 + 尾部 15 行，
 *    中间替换为 "... [已省略中间 N 行输出] ..."，且严格保证不损坏 JSON 结构或消息数组结构。
 */

export const IMAGE_PLACEHOLDER = '[历史图片: 早期对话已接收并分析完毕]';

/**
 * 计算 messages 列表中每条消息距离末尾的对话轮次（Turn Distance）。
 * 0 表示当前/最新轮次，1 表示倒数第二轮，以此类推。
 * 系统/开发者消息返回 Infinity。
 *
 * @param {Array} messages
 * @returns {number[]} 每个索引对应的轮次距离
 */
export function computeTurnDistances(messages) {
  if (!Array.isArray(messages)) return [];
  const hasAssistant = messages.some(m => m && m.role === 'assistant');
  const turns = new Array(messages.length).fill(0);
  let currentTurn = -1;
  let prevRole = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') {
      turns[i] = Math.max(0, currentTurn);
      continue;
    }
    const role = m.role;
    if (role === 'system' || role === 'developer') {
      turns[i] = -1; // 系统提示词不计入交互轮次
      continue;
    }

    if (role === 'user') {
      // 若无 assistant 消息（如纯 user 消息列表测试），每条 user 视为独立一轮；
      // 若存在 assistant 交互，连续的 user 消息属于同一交互轮次（如图片与文字拆开发送）
      if (!hasAssistant || prevRole !== 'user' || currentTurn === -1) {
        currentTurn++;
      }
      prevRole = 'user';
      turns[i] = currentTurn;
    } else {
      if (currentTurn === -1) {
        currentTurn = 0;
      }
      prevRole = role;
      turns[i] = currentTurn;
    }
  }

  const maxTurn = Math.max(0, currentTurn);
  return turns.map(t => (t === -1 ? Infinity : maxTurn - t));
}

/**
 * 判定一个内容块或对象是否为图片
 * @param {*} block
 * @returns {boolean}
 */
export function isImageBlock(block) {
  if (!block) return false;
  if (typeof block === 'string') {
    return block.startsWith('data:image/');
  }
  if (typeof block !== 'object') return false;

  const type = typeof block.type === 'string' ? block.type : '';
  if (type === 'image_url' || type === 'input_image' || type === 'image') return true;
  if (type.includes('image')) return true;

  if (block.image_url != null) return true;

  const src = block.source;
  if (src && typeof src === 'object') {
    if (src.type === 'base64' || src.type === 'url') {
      if (typeof src.media_type === 'string' && src.media_type.startsWith('image/')) return true;
      if (type.includes('image')) return true;
    }
  }

  return false;
}

/**
 * 将图片块降级替换为文本占位块
 * @param {*} originalBlock
 * @returns {object}
 */
function createPrunedImageBlock(originalBlock) {
  if (originalBlock && typeof originalBlock === 'object') {
    if (originalBlock.type === 'input_image') {
      return { type: 'input_text', text: IMAGE_PLACEHOLDER };
    }
  }
  return { type: 'text', text: IMAGE_PLACEHOLDER };
}

/**
 * 智能修剪消息列表中的图片。
 *
 * 智能扫描 messages 列表，计算每条消息距离最后的轮次。
 * 只有最近 keepRecentTurns 轮（或不超过 maxImages 张）的图片保留真实的 image_url / data base64 内容；
 * 更早的历史图片自动替换为文本占位 `[历史图片: 早期对话已接收并分析完毕]`，杜绝把早期久远的图片每次都重复上传给上游。
 *
 * @param {Array} messages - 消息列表
 * @param {number} [keepRecentTurns=2] - 最近保留的轮次数（默认 2 轮）
 * @param {number} [maxImages=3] - 最大保留图片总张数（默认 3 张，超出时保留最新图片）
 * @returns {Array} 修剪后的全新消息列表（纯函数，绝不原地修改原数组）
 */
export function pruneMessageImages(messages, keepRecentTurns = 2, maxImages = 3) {
  if (!Array.isArray(messages)) return messages;
  if (messages.length === 0) return [];

  const turnDistances = computeTurnDistances(messages);

  // 1. 收集全部图片位置与轮次信息
  const imageEntries = []; // { msgIndex, blockIndex, turnDist, block }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const dist = turnDistances[i];

    if (Array.isArray(m.content)) {
      for (let j = 0; j < m.content.length; j++) {
        const block = m.content[j];
        if (isImageBlock(block)) {
          imageEntries.push({ msgIndex: i, blockIndex: j, turnDist: dist, block });
        }
      }
    } else if (typeof m.content === 'string' && m.content.startsWith('data:image/')) {
      imageEntries.push({ msgIndex: i, blockIndex: -1, turnDist: dist, block: m.content });
    } else if (isImageBlock(m.content)) {
      imageEntries.push({ msgIndex: i, blockIndex: -2, turnDist: dist, block: m.content });
    }
  }

  // 2. 计算保留集合：
  //    - 属于最近 keepRecentTurns 轮（turnDist < keepRecentTurns）
  //    - 最多保留 maxImages 张（优先保留最新/最后出现的图片）
  const eligible = imageEntries.filter(e => e.turnDist < keepRecentTurns);
  const keepLimit = Math.max(0, maxImages);
  const keptEntries = keepLimit > 0 ? eligible.slice(-keepLimit) : [];
  const keptSet = new Set(keptEntries);

  // 3. 构造全新消息列表
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') {
      result.push(m);
      continue;
    }

    const msgImages = imageEntries.filter(e => e.msgIndex === i);
    if (msgImages.length === 0) {
      result.push({ ...m });
      continue;
    }

    const newMsg = { ...m };
    if (Array.isArray(m.content)) {
      newMsg.content = m.content.map((block, j) => {
        const entry = msgImages.find(e => e.blockIndex === j);
        if (!entry) return block;
        if (keptSet.has(entry)) {
          return block; // 保留真实图片内容
        }
        return createPrunedImageBlock(block); // 降级为占位符
      });
    } else if (typeof m.content === 'string') {
      const entry = msgImages.find(e => e.blockIndex === -1);
      if (entry && !keptSet.has(entry)) {
        newMsg.content = IMAGE_PLACEHOLDER;
      }
    } else if (typeof m.content === 'object' && m.content !== null) {
      const entry = msgImages.find(e => e.blockIndex === -2);
      if (entry && !keptSet.has(entry)) {
        newMsg.content = createPrunedImageBlock(m.content);
      }
    }

    result.push(newMsg);
  }

  return result;
}

/**
 * 修剪单段纯文本输出：
 * 保留头部 headLines 行 + 尾部 tailLines 行，中间替换为 `... [已省略中间 N 行输出] ...`
 *
 * @param {string} text
 * @param {number} [headLines=15]
 * @param {number} [tailLines=15]
 * @returns {string}
 */
export function pruneLines(text, headLines = 15, tailLines = 15) {
  if (typeof text !== 'string') return text;
  const lines = text.split(/\r?\n/);
  if (lines.length > headLines + tailLines) {
    const head = lines.slice(0, headLines);
    const tail = lines.slice(-tailLines);
    const omitted = lines.length - headLines - tailLines;
    return [...head, `... [已省略中间 ${omitted} 行输出] ...`, ...tail].join('\n');
  }

  // 若行数 <= headLines + tailLines，但总字符长（如多行密集长输出）：
  if (lines.length > 2) {
    const halfHead = Math.min(headLines, Math.floor((lines.length - 1) / 2));
    const halfTail = Math.min(tailLines, Math.floor((lines.length - 1) / 2));
    const omitted = lines.length - halfHead - halfTail;
    if (omitted > 0) {
      const head = lines.slice(0, halfHead);
      const tail = lines.slice(-halfTail);
      return [...head, `... [已省略中间 ${omitted} 行输出] ...`, ...tail].join('\n');
    }
  }

  // 单行或极少行但超出 2000 字符的极端超长输出
  const keepChars = 800;
  if (text.length > keepChars * 2 + 100) {
    const head = text.slice(0, keepChars);
    const tail = text.slice(-keepChars);
    const omittedChars = text.length - keepChars * 2;
    return `${head}\n... [已省略中间 ${omittedChars} 字符输出] ...\n${tail}`;
  }

  return text;
}

/**
 * 递归安全修剪 JSON 结构，确保 JSON 语义有效且不被破坏
 * @param {*} obj
 * @param {object} opts
 * @returns {*}
 */
function pruneJsonObject(obj, opts) {
  const { maxChars, headLines, tailLines } = opts;
  if (obj === null || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    if (obj.length > headLines + tailLines) {
      const head = obj.slice(0, headLines).map(item => pruneJsonObject(item, opts));
      const tail = obj.slice(-tailLines).map(item => pruneJsonObject(item, opts));
      const omitted = obj.length - headLines - tailLines;
      return [...head, `... [已省略中间 ${omitted} 行输出] ...`, ...tail];
    }
    return obj.map(item => pruneJsonObject(item, opts));
  }

  const entries = Object.entries(obj);
  // 若对象键超长且整体需压缩
  if (entries.length > headLines + tailLines) {
    const head = entries.slice(0, headLines);
    const tail = entries.slice(-tailLines);
    const omitted = entries.length - headLines - tailLines;
    const res = {};
    for (const [k, v] of head) res[k] = pruneJsonObject(v, opts);
    res['_omitted'] = `... [已省略中间 ${omitted} 行输出] ...`;
    for (const [k, v] of tail) res[k] = pruneJsonObject(v, opts);
    return res;
  }

  const res = {};
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      if (value.length > maxChars) {
        res[key] = pruneLines(value, headLines, tailLines);
      } else {
        res[key] = value;
      }
    } else if (typeof value === 'object' && value !== null) {
      res[key] = pruneJsonObject(value, opts);
    } else {
      res[key] = value;
    }
  }
  return res;
}

/**
 * 修剪工具内容（支持纯文本、JSON 字符串以及 JSON 对象/数组）
 *
 * @param {*} content
 * @param {object} options
 * @returns {*}
 */
export function pruneToolContent(content, options = {}) {
  const maxChars = options.maxChars ?? options.maxToolChars ?? 2000;
  const headLines = options.headLines ?? 15;
  const tailLines = options.tailLines ?? 15;
  const opts = { maxChars, headLines, tailLines };

  if (typeof content === 'string') {
    if (content.length <= maxChars) return content;

    // 智能检查是否为 JSON 字符串，优先保留 JSON 语义结构
    const trimmed = content.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(content);
        const prunedObj = pruneJsonObject(parsed, opts);
        const isMultiLine = content.includes('\n');
        return isMultiLine ? JSON.stringify(prunedObj, null, 2) : JSON.stringify(prunedObj);
      } catch {
        // 非合法 JSON，按纯文本行修剪
      }
    }

    return pruneLines(content, headLines, tailLines);
  }

  if (typeof content === 'object' && content !== null) {
    if (Array.isArray(content)) {
      return content.map(item => pruneToolContent(item, options));
    }
    return pruneJsonObject(content, opts);
  }

  return content;
}

/**
 * 智能修剪早期的 tool/function 输出。
 *
 * 最近 2 轮的工具结果保留完整；
 * 早期的工具结果如果超过 2000 字符，保留头部 15 行 + 尾部 15 行，
 * 中间替换为 `... [已省略中间 N 行输出] ...`。
 * 严格保证不损坏 JSON 结构或消息数组结构。
 *
 * @param {Array} messages - 消息列表
 * @param {object} [options={}] - 配置项
 * @param {number} [options.keepRecentTurns=2] - 最近保留完整输出的轮次数（默认 2 轮）
 * @param {number} [options.maxChars=2000] - 超过该字符数才修剪（默认 2000）
 * @param {number} [options.headLines=15] - 保留头部行数（默认 15）
 * @param {number} [options.tailLines=15] - 保留尾部行数（默认 15）
 * @returns {Array} 修剪后的全新消息列表（纯函数，绝不原地修改原数组）
 */
export function pruneToolOutputs(messages, options = {}) {
  if (!Array.isArray(messages)) return messages;
  if (messages.length === 0) return [];

  const keepRecentTurns = options.keepRecentTurns ?? 2;
  const turnDistances = computeTurnDistances(messages);

  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') {
      result.push(m);
      continue;
    }

    const dist = turnDistances[i];
    // 最近 2 轮的工具结果保留完整
    if (dist < keepRecentTurns) {
      result.push({ ...m });
      continue;
    }

    const role = m.role;
    // 检查是否为工具输出消息（OpenAI 的 tool / function，或 Anthropic 的 tool_result）
    if (role === 'tool' || role === 'function') {
      result.push({
        ...m,
        content: pruneToolContent(m.content, options),
      });
    } else if (role === 'user' && Array.isArray(m.content) && m.content.some(c => c && c.type === 'tool_result')) {
      // Anthropic 格式的 tool_result 块
      const newContent = m.content.map(b => {
        if (b && b.type === 'tool_result') {
          return {
            ...b,
            content: pruneToolContent(b.content, options),
          };
        }
        return b;
      });
      result.push({
        ...m,
        content: newContent,
      });
    } else {
      result.push({ ...m });
    }
  }

  return result;
}

/**
 * 组合优化器：同时执行媒体图片修剪与长工具输出修剪
 * @param {Array} messages
 * @param {object} [options={}]
 * @returns {Array}
 */
export function optimizeContext(messages, options = {}) {
  const keepRecentTurns = options.keepRecentTurns ?? 2;
  const maxImages = options.maxImages ?? 3;
  const step1 = pruneMessageImages(messages, keepRecentTurns, maxImages);
  return pruneToolOutputs(step1, options);
}

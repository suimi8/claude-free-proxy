/**
 * stream-metrics.mjs —— 流式度量、时序指标追踪与精准 Token 计数模块
 *
 * 核心职责：
 * 1. 精准 CJK Unicode 区间加权 Token 估算：
 *    - 针对汉字、中文标点、假名、全角字符采用 1 字 1 token 真实比例
 *    - 其余西文/数字按 4 字符 1 token 计算，杜绝中文回复速度被低估 3~4 倍
 * 2. 端到端流式时序指标追踪 (StreamMetricsTracker)：
 *    - TTFT (Time To First Token) / TTFB 首字延迟
 *    - think_ms 思考期耗时
 *    - write_ms 正文净生成耗时
 *    - gen_ms 整个吐字窗口耗时
 *    - idle_ms 尾部空闲挂起耗时
 *    - tps 正文真实出字速度 (tok/s)
 *    - tps_e2e 端到端含思考出字速度 (tok/s)
 *    - tps_legacy 兼容旧口径流速
 */

/**
 * 判断 Unicode 码点是否落在 CJK 及相关东亚全角区间内
 */
export function isCjkCodePoint(cp) {
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // 中文标点符号
    (cp >= 0x3040 && cp <= 0x309f) || // 日文平假名
    (cp >= 0x30a0 && cp <= 0x30ff) || // 日文片假名
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 汉字扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本汉字 (Unified Ideographs)
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容汉字
    (cp >= 0xff00 && cp <= 0xffef) || // 全角 ASCII、全角标点与半宽片假名 (！，？：等)
    (cp >= 0x20000 && cp <= 0x2fa1f)  // CJK 扩展 B/C/D/E/F/G 及补充
  );
}

/**
 * 估算 token 数：汉字/日文假名/中文及全角标点 1 字 1 token，其余 4 字符 1 token
 */
export function countTokens(s) {
  if (!s) return 0;
  const str = String(s);
  let cjk = 0, other = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (isCjkCodePoint(cp)) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 估算请求逻辑输入 Tokens（含剪枝后 prompt 与序列化后的 tools）
 */
export function estimateInputTokens({ prompt, tools } = {}) {
  const pTokens = prompt ? countTokens(prompt) : 0;
  const tTokens = tools ? countTokens(typeof tools === 'string' ? tools : JSON.stringify(tools)) : 0;
  return Math.max(1, pTokens + tTokens);
}

/**
 * 计算 Token 流速 (tok/s)，支持最小时间窗口保护 (默认 100ms)
 */
export function calculateTps(tokens, durationMs, minWindowMs = 100) {
  if (!tokens || durationMs == null || durationMs < minWindowMs) return 0;
  return +(tokens / (durationMs / 1000)).toFixed(2);
}

/**
 * 计算时序耗时分布与多种流速指标
 */
export function calculateTimingMetrics({
  startedAt,
  firstDeltaAt,
  firstTextAt,
  lastDeltaAt,
  lastTextAt,
  endedAt = Date.now(),
  textTokens = 0,
  outputTokens = 0,
  minWindowMs = 100,
} = {}) {
  const ttfb_ms = (firstDeltaAt != null && startedAt != null) ? Math.max(0, firstDeltaAt - startedAt) : null;
  const ttft_ms = (firstTextAt != null && startedAt != null) ? Math.max(0, firstTextAt - startedAt) : ttfb_ms;
  const latency_ms = startedAt != null ? Math.max(0, endedAt - startedAt) : 0;
  const gen_ms = (firstDeltaAt != null && lastDeltaAt != null) ? Math.max(0, lastDeltaAt - firstDeltaAt) : 0;
  const write_ms = (firstTextAt != null && lastTextAt != null) ? Math.max(0, lastTextAt - firstTextAt) : 0;
  const think_ms = (firstDeltaAt != null && firstTextAt != null) ? Math.max(0, firstTextAt - firstDeltaAt) : 0;
  const idle_ms = (lastDeltaAt != null) ? Math.max(0, endedAt - lastDeltaAt) : 0;

  const tps = calculateTps(textTokens, write_ms, minWindowMs);
  const tps_e2e = calculateTps(outputTokens, gen_ms, minWindowMs);
  const legacyWin = startedAt != null ? endedAt - startedAt - (ttfb_ms ?? 0) : 0;
  const tps_legacy = calculateTps(outputTokens, legacyWin, minWindowMs);

  return {
    ttfb_ms,
    ttft_ms,
    latency_ms,
    gen_ms,
    write_ms,
    think_ms,
    idle_ms,
    tps,
    tps_e2e,
    tps_legacy,
  };
}

/**
 * 流式请求时序与 Token 度量追踪器
 */
export class StreamMetricsTracker {
  constructor(options = {}) {
    this.startedAt = options.startedAt || Date.now();
    this.firstDeltaAt = null;
    this.firstTextAt = null;
    this.lastDeltaAt = null;
    this.lastTextAt = null;
    this.endedAt = null;

    this.textStr = '';
    this.thinkStr = '';
    this.jsonStr = '';
    this._cachedUsage = null;
  }

  /**
   * 观察上游流式事件（如 content_block_delta 等）
   */
  observe(ev) {
    if (!ev || ev.type !== 'content_block_delta') return;
    const d = ev.delta || {};
    const now = Date.now();
    const piece = (typeof d.text === 'string' ? d.text.length : 0) +
      (typeof d.partial_json === 'string' ? d.partial_json.length : 0) +
      (typeof d.thinking === 'string' ? d.thinking.length : 0) +
      (typeof d.summary?.summary === 'string' ? d.summary.summary.length : 0);

    if (piece) {
      if (this.firstDeltaAt == null) this.firstDeltaAt = now;
      this.lastDeltaAt = now;
    }

    if (typeof d.text === 'string' && d.text) {
      this.textStr += d.text;
      if (this.firstTextAt == null) this.firstTextAt = now;
      this.lastTextAt = now;
      this._cachedUsage = null;
    } else if (typeof d.partial_json === 'string' && d.partial_json) {
      this.jsonStr += d.partial_json;
      this._cachedUsage = null;
    } else if (typeof d.thinking === 'string' && d.thinking) {
      this.thinkStr += d.thinking;
      this._cachedUsage = null;
    } else if (typeof d.summary?.summary === 'string' && d.summary.summary) {
      this.thinkStr += d.summary.summary;
      this._cachedUsage = null;
    }
  }

  /**
   * 统计当前通道的输出 Token 用量
   */
  outputUsage() {
    if (!this._cachedUsage) {
      const text = countTokens(this.textStr);
      const thinking = countTokens(this.thinkStr);
      const jsonTokens = countTokens(this.jsonStr);
      this._cachedUsage = {
        text,
        thinking,
        output: text + thinking + jsonTokens,
      };
    }
    return this._cachedUsage;
  }

  /**
   * 流结束时完成度量结算，并将全部指标回填至请求上下文 ctx
   */
  finalize(ctx) {
    this.endedAt = Date.now();
    const { text: textTokens, thinking: thinkTokens, output: outTokens } = this.outputUsage();

    const metrics = calculateTimingMetrics({
      startedAt: ctx?.startedAt || this.startedAt,
      firstDeltaAt: this.firstDeltaAt,
      firstTextAt: this.firstTextAt,
      lastDeltaAt: this.lastDeltaAt,
      lastTextAt: this.lastTextAt,
      endedAt: this.endedAt,
      textTokens,
      outputTokens: outTokens,
    });

    if (ctx) {
      ctx.output_tokens = outTokens;
      ctx.text_tokens = textTokens;
      ctx.think_tokens = thinkTokens;
      ctx.ttfb_ms = metrics.ttfb_ms;
      ctx.ttft_ms = metrics.ttft_ms;
      ctx.latency_ms = metrics.latency_ms;
      ctx.gen_ms = metrics.gen_ms;
      ctx.write_ms = metrics.write_ms;
      ctx.think_ms = metrics.think_ms;
      ctx.idle_ms = metrics.idle_ms;
      ctx.tps = metrics.tps;
      ctx.tps_e2e = metrics.tps_e2e;
      ctx.tps_legacy = metrics.tps_legacy;
    }

    return {
      textTokens,
      thinkTokens,
      outputTokens: outTokens,
      ...metrics,
    };
  }

  getMetrics() {
    const { text: textTokens, thinking: thinkTokens, output: outputTokens } = this.outputUsage();
    return {
      textTokens,
      thinkTokens,
      outputTokens,
      ...calculateTimingMetrics({
        startedAt: this.startedAt,
        firstDeltaAt: this.firstDeltaAt,
        firstTextAt: this.firstTextAt,
        lastDeltaAt: this.lastDeltaAt,
        lastTextAt: this.lastTextAt,
        endedAt: this.endedAt || Date.now(),
        textTokens,
        outputTokens,
      }),
    };
  }
}

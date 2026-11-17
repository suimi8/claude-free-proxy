// @ts-check
/**
 * YesCaptcha 打码客户端（纯协议实现，零第三方依赖）
 *
 * 用法：
 *   const yc = new YesCaptcha({ clientKey: 'xxx' });
 *   const sol = await yc.solveHCaptcha({ websiteURL, websiteKey, isInvisible: true });
 *   sol.gRecaptchaResponse  // 提交给目标站的 token
 *   sol.userAgent          // 必须与提交请求的 User-Agent 保持一致
 *   sol.respKey            // 部分站点要求一并回传
 *
 * 官方文档：https://docs.yescaptcha.com/en/tasks/hcaptcha
 */

export class YesCaptcha {
  /**
   * @param {{ clientKey: string, apiBase?: string }} opts
   */
  constructor(opts) {
    if (!opts?.clientKey) throw new Error('YesCaptcha 需要 clientKey');
    this.clientKey = opts.clientKey;
    this.apiBase = (opts.apiBase || 'https://api.yescaptcha.com').replace(/\/+$/, '');
  }

  /**
   * 调用官方接口，errorId != 0 时抛出可读错误。
   * @param {string} method createTask / getTaskResult / getBalance
   * @param {object} payload
   */
  async call(method, payload = {}) {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: this.clientKey, ...payload }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`YesCaptcha ${method} 返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (data.errorId) {
      throw new Error(`YesCaptcha ${method} 失败 [${data.errorCode}]: ${data.errorDescription || ''}`);
    }
    return data;
  }

  /** 查询余额（点数） */
  async balance() {
    const d = await this.call('getBalance');
    return d.balance ?? 0;
  }

  /**
   * 获取官方认可的 User-Agent。
   * hCaptcha token 与 UA 强绑定，只有 /useragent 返回的值才会被接受。
   */
  async userAgent() {
    const res = await fetch(`${this.apiBase}/useragent`, { signal: AbortSignal.timeout(15000) });
    const text = (await res.text()).trim();
    if (!res.ok) throw new Error(`YesCaptcha useragent 返回 HTTP ${res.status}: ${text.slice(0, 120)}`);
    // 该接口返回纯文本 UA（部分版本返回 JSON）
    if (text.startsWith('{')) {
      const data = JSON.parse(text);
      if (data.errorId) throw new Error(`YesCaptcha useragent 失败 [${data.errorCode}]`);
      return String(data.userAgent || '').trim();
    }
    return text;
  }

  /**
   * 异步任务轮询求解
   * @param {object} task
   * @param {{ timeoutMs?: number, intervalMs?: number, onProgress?: (msg: string) => void }} [opts]
   */
  async solve(task, opts = {}) {
    const { timeoutMs = 180000, intervalMs = 5000, onProgress = () => {} } = opts;
    const created = await this.call('createTask', { task });
    if (created.status === 'ready') return created.solution;

    const taskId = created.taskId;
    if (!taskId) throw new Error('YesCaptcha createTask 未返回 taskId');
    onProgress(`打码任务已提交 (${taskId})，等待求解…`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const result = await this.call('getTaskResult', { taskId });
      if (result.status === 'ready') {
        onProgress('打码完成 ✅');
        return result.solution;
      }
      if (result.status === 'failed') {
        throw new Error(`打码失败 [${result.errorCode}]: ${result.errorDescription || ''}`);
      }
    }
    throw new Error(`打码超时 (${Math.round(timeoutMs / 1000)}s, task=${taskId})`);
  }

  /**
   * hCaptcha 图片题识别（同步接口，只给哪些图是目标，不给 token）
   * @param {{ question: string, queries: string[], anchors?: string[] }} params
   * @returns {Promise<{ objects?: boolean[], top_k?: number[], box?: any }>}
   */
  async classifyHCaptcha(params) {
    const { question, queries, anchors } = params;
    const task = { type: 'HCaptchaClassification', question, queries };
    if (anchors && anchors.length) task.anchors = anchors;
    const r = await this.call('createTask', { task });
    if (r.status === 'ready' && r.solution) return r.solution;
    throw new Error(`图片识别未返回结果 [${r.errorCode || 'unknown'}]: ${r.errorDescription || ''}`);
  }

  /**
   * 求解 hCaptcha
   * @param {{
   *   websiteURL: string,
   *   websiteKey: string,
   *   isInvisible?: boolean,
   *   rqdata?: string,
   *   userAgent?: string,
   *   taskType?: string,
   * }} params
   * @param {{ onProgress?: (msg: string) => void }} [opts]
   */
  async solveHCaptcha(params, opts = {}) {
    const { websiteURL, websiteKey, isInvisible, rqdata, userAgent, taskType } = params;
    const task = {
      type: taskType || 'HCaptchaTaskProxyless',
      websiteURL,
      websiteKey,
    };
    if (isInvisible !== undefined) task.isInvisible = !!isInvisible;
    if (rqdata) task.rqdata = rqdata;
    if (userAgent) task.userAgent = userAgent;

    const solution = await this.solve(task, opts);
    const token = solution?.gRecaptchaResponse || solution?.token || solution?.solution;
    if (!token) throw new Error('YesCaptcha 未返回 token');
    return {
      token,
      userAgent: solution.userAgent || userAgent || '',
      respKey: solution.respKey || '',
      raw: solution,
    };
  }
}

export default YesCaptcha;

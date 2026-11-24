/**
 * gateway-routes.mjs —— 轻量路由分发与控制器模块
 *
 * 将 API 网关核心请求生命周期彻底解耦为高内聚的领域控制器：
 *   - handleInference: 推理端点 (/v1/chat/completions, /v1/messages, /v1/responses, /v1/models, /v1/messages/count_tokens)
 *   - handleAdmin: 管理端点 (/v1/accounts*, /v1/keys*, /v1/pool*, /v1/cfverify*, /v1/kyc*)
 *   - handleLogs: 审计与用量端点 (/v1/usage*, /v1/operations*)
 *   - handleTools: 外部搜索与抓取端点 (/v1/tools/search, /v1/tools/fetch)
 *   - handleStatic: 探活、版本与静态 WebUI (/readyz, /healthz, /v1/version*, /)
 *   - dispatchRequest: 统一路由派发入口
 */
import http from 'node:http';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { extractPseudoToolCalls, findToolCallTrigger } from './pseudo-tools.mjs';
import { classify, webHeaders } from './claude-web-client.mjs';
import { DEFAULT_BASE, DEFAULT_UA } from './accounts.mjs';

export const COMPLETION_APIS = new Map([
  ['/v1/chat/completions', 'chat.completions'],
  ['/v1/messages', 'messages'],
  ['/v1/responses', 'responses'],
]);

export const MESSAGES_POST_ALIASES = new Map([
  ['/v1/v1/messages', '/v1/messages'],
  ['/v1/v1/messages/count_tokens', '/v1/messages/count_tokens'],
]);

export const INFERENCE_ROUTES = new Set([
  ...COMPLETION_APIS.keys(),
  '/v1/models',
  '/v1/messages/count_tokens',
  '/v1/tools/search', '/tools/search', '/v1/search', '/search',
  '/v1/tools/fetch', '/tools/fetch', '/v1/fetch', '/fetch',
]);

/**
 * 响应 JSON 结果辅助函数
 */
export function json(res, code, obj, headers = {}) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': b.length,
    ...headers,
  });
  res.end(b);
  return true;
}

function makeJsonSender(context) {
  const fn = context?.json || json;
  return (res, code, obj, headers) => {
    fn(res, code, obj, headers);
    return true;
  };
}

/**
 * 读取并解析请求体 JSON
 */
export async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  try {
    return bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

/**
 * 客户端断连检测
 */
export function onClientGone(res) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  return ac;
}

/**
 * 账号脱敏对象生成
 */
export function maskAccount(a) {
  if (!a) return null;
  const sk = a.sessionKey || '';
  return {
    id: a.id,
    label: a.label,
    source: a.source,
    enabled: a.enabled,
    org: a.org,
    base: a.base,
    session_key: sk ? '••••' : '',
    cooldown_remaining_s: Math.max(0, Math.ceil(((a.cooldownUntil || 0) - Date.now()) / 1000)),
    ok: a.stats?.ok ?? a.ok ?? 0,
    fail: a.stats?.fail ?? a.fail ?? 0,
    last_error: a.stats?.lastError ?? a.last_error ?? '',
  };
}

/**
 * 导入凭据文本解析器：支持整段 JSON、JSONL、多字段分割（----、逗号、制表符）以及原始 sessionKey
 */
export function parseImportLines(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
    try {
      const parsed = JSON.parse(raw);
      const items = [];
      const extractItem = it => {
        if (!it) return;
        if (typeof it === 'string') {
          const m = /(sk-ant-sid02-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+)/.exec(it.trim());
          if (m) items.push({ sessionKey: m[1], label: '' });
        } else if (typeof it === 'object') {
          const sk = it.sessionKey || it.session_key || it.key || it.token || '';
          if (sk && typeof sk === 'string' && sk.includes('sk-ant-')) {
            const m = /(sk-ant-sid02-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+)/.exec(sk.trim());
            if (m) items.push({ sessionKey: m[1], label: String(it.label || it.name || it.remark || '').trim(), org: String(it.org || '').trim() });
          }
        }
      };

      if (Array.isArray(parsed)) {
        for (const item of parsed) extractItem(item);
        if (items.length) return items;
      } else if (typeof parsed === 'object') {
        const arr = parsed.accounts || parsed.keys || parsed.items || parsed.data || parsed.list;
        if (Array.isArray(arr)) {
          for (const item of arr) extractItem(item);
          if (items.length) return items;
        }
        extractItem(parsed);
        if (items.length) return items;
      }
    } catch { /* 不是合法完整 JSON，回退到按行解析 */ }
  }

  const lines = raw.split(/\r?\n/);
  const items = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const obj = JSON.parse(line);
        const sk = obj.sessionKey || obj.session_key || obj.key || obj.token || '';
        if (sk && typeof sk === 'string' && sk.includes('sk-ant-')) {
          const m = /(sk-ant-sid02-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+)/.exec(sk.trim());
          if (m) {
            items.push({ sessionKey: m[1], label: String(obj.label || obj.name || obj.remark || '').trim(), org: String(obj.org || '').trim() });
            continue;
          }
        }
      } catch {}
    }

    let sk = '';
    let label = '';
    if (line.includes('----')) {
      const parts = line.split('----').map(s => s.trim());
      const skIdx = parts.findIndex(p => p.includes('sk-ant-'));
      if (skIdx >= 0) {
        sk = (/(sk-ant-sid02-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+)/.exec(parts[skIdx]) || [])[0] || parts[skIdx];
        label = parts.find((_, i) => i !== skIdx) || '';
      }
    } else if (line.includes(',') || line.includes('\t')) {
      const parts = line.split(/[\t,]/).map(s => s.trim());
      const skIdx = parts.findIndex(p => p.includes('sk-ant-'));
      if (skIdx >= 0) {
        sk = (/(sk-ant-sid02-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+)/.exec(parts[skIdx]) || [])[0] || parts[skIdx];
        label = parts.find((_, i) => i !== skIdx) || '';
      }
    } else {
      const m = /(?:sessionKey=)?(sk-ant-sid02-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+)/.exec(line);
      if (m) {
        sk = m[1];
        const rem = line.replace(m[0], '').replace(/^[;,=\s]+|[;,=\s]+$/g, '').trim();
        if (rem && !rem.includes('cf_clearance') && rem.length < 50) label = rem;
      }
    }
    if (sk) {
      items.push({ sessionKey: sk, label });
    }
  }
  return items;
}

/**
 * ServerContext —— 结构化服务容器
 *
 * 将散装依赖按领域严格拆分为:
 * - ctx.services: 基础设施与业务领域服务 (auth, accounts, pool, kyc, logs, updates, tools, verify)
 * - ctx.engine: 模型推理与协议引擎 (completionEngine, promptRenderer, responseAdapter, chatProtocol)
 * - ctx.config: 运行配置与环境 (keys, server, publicSettings, isLanExposed, upstream, defaultBase, defaultUa)
 */
export class ServerContext {
  constructor({ services = {}, engine = {}, config = {} } = {}) {
    this.services = services;
    this.engine = engine;
    this.config = config;
    this.isServerContext = true;

    // 返回支持扁平向后兼容回退的代理容器
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);

        // 扁平回退：services
        const s = target.services;
        if (s) {
          if (prop in s) return s[prop];
          if (s.auth && prop in s.auth) return s.auth[prop];
          if (s.accounts && prop in s.accounts) return s.accounts[prop];
          if (s.logs && prop in s.logs) return s.logs[prop];
          if (s.tools && prop in s.tools) return s.tools[prop];
          if (s.verify && prop in s.verify) return s.verify[prop];
          if (s.updates && prop in s.updates) return s.updates[prop];
          if (prop === 'POOL') return s.pool || s.accounts?.pool;
          if (prop === 'USAGE') return s.logs?.USAGE;
          if (prop === 'CFVERIFY') return s.verify?.cfVerify || s.verify?.CFVERIFY;
          if (prop === 'KYC_CACHE') return s.kyc?.cache;
        }

        // 扁平回退：engine
        const e = target.engine;
        if (e) {
          if (prop in e) return e[prop];
          if (e.completionEngine && prop in e.completionEngine) {
            const val = e.completionEngine[prop];
            return typeof val === 'function' ? val.bind(e.completionEngine) : val;
          }
          if (e.chatProtocol && prop in e.chatProtocol) return e.chatProtocol[prop];
          if (e.responseAdapter && prop in e.responseAdapter) return e.responseAdapter[prop];
          if (e.promptRenderer && prop in e.promptRenderer) return e.promptRenderer[prop];
        }

        // 扁平回退：config
        const c = target.config;
        if (c) {
          if (prop in c) return c[prop];
          if (prop === 'KEYS') return c.keys;
          if (prop === 'UP') return c.upstream;
          if (prop === 'CONFIG_FILE') return c.configFile;
          if (prop === 'DEFAULT_BASE') return c.defaultBase;
          if (prop === 'DEFAULT_UA') return c.defaultUa;
          if (c.server && prop in c.server) return c.server[prop];
        }

        return undefined;
      },
    });
  }
}

/**
 * 工厂函数：创建 ServerContext 实例
 */
export function createServerContext(options = {}) {
  return new ServerContext(options);
}

/**
 * 适配器：将传入的 context 或散装 helpers 规范化为 ServerContext
 */
export function resolveServerContext(contextOrHelpers) {
  if (!contextOrHelpers) return new ServerContext();
  if (contextOrHelpers.isServerContext) return contextOrHelpers;
  if (contextOrHelpers.services && contextOrHelpers.engine && contextOrHelpers.config) {
    return new ServerContext(contextOrHelpers);
  }

  const h = contextOrHelpers;
  return new ServerContext({
    services: {
      auth: {
        authenticate: h.authenticate,
        isLoopbackReq: h.isLoopbackReq,
        getReqIp: h.getReqIp,
        safeCompareKey: h.safeCompareKey,
        validateHost: h.validateHost,
        onClientGone: h.onClientGone || onClientGone,
        LEGACY_KEY: h.LEGACY_KEY,
        LEGACY_KEY_OBJ: h.LEGACY_KEY_OBJ,
      },
      accounts: {
        pool: h.POOL,
        maskAccount: h.maskAccount || maskAccount,
        parseImportLines: h.parseImportLines || parseImportLines,
        accountTokenStats: h.accountTokenStats,
        discoverOrg: h.discoverOrg,
        checkKyc: h.checkKyc,
        probeQuota: h.probeQuota,
      },
      pool: h.POOL,
      kyc: {
        cache: h.KYC_CACHE,
        checkKyc: h.checkKyc,
        discoverOrg: h.discoverOrg,
      },
      logs: {
        USAGE: h.USAGE,
        logOperation: h.logOperation,
        queryOperations: h.queryOperations,
        getOperationStats: h.getOperationStats,
        clearOperations: h.clearOperations,
      },
      updates: h.updates,
      tools: {
        searchDuckDuckGo: h.searchDuckDuckGo,
        fetchWebContent: h.fetchWebContent,
        decodeHtmlEntities: h.decodeHtmlEntities,
      },
      verify: {
        cfVerify: h.CFVERIFY,
        cfStormActive: h.cfStormActive,
        clearChallengeEvents: h.clearChallengeEvents,
        openClaudeWebBrowser: h.openClaudeWebBrowser,
      },
    },
    engine: {
      completionEngine: {
        runCompletion: h.runCompletion,
        mapModel: h.mapModel,
        modelList: h.modelList,
        prepareContext: h.prepareContext,
        buildUpstreamBody: h.buildUpstreamBody,
        normalizeSse: h.normalizeSse,
        completionErrorStatus: h.completionErrorStatus,
        recordCompletion: h.recordCompletion,
        messageToChat: h.messageToChat,
        estimateInputTokens: h.estimateInputTokens,
      },
      promptRenderer: {
        renderPrompt: h.renderPrompt,
        textOf: h.textOf,
        pickEffort: h.pickEffort,
      },
      responseAdapter: {
        responsesToChat: h.responsesToChat,
        newRespId: h.newRespId,
        RESP_STORE: h.RESP_STORE,
        sendResponsesResult: h.sendResponsesResult,
      },
      chatProtocol: {
        newChatId: h.newChatId,
        streamToClient: h.streamToClient,
        collect: h.collect,
        ant2oaiText: h.ant2oaiText,
        heartbeat: h.heartbeat,
      },
    },
    config: {
      keys: h.KEYS,
      configFile: h.CONFIG_FILE,
      publicSettings: h.publicSettings,
      upstream: h.UP,
      defaultBase: h.DEFAULT_BASE || DEFAULT_BASE,
      defaultUa: h.DEFAULT_UA || DEFAULT_UA,
      uiHtml: h.uiHtml,
      withVersionPanel: h.withVersionPanel,
      versionAsset: h.versionAsset,
    },
  });
}

// --------------------------------------------------------------------------------
// 1. handleStatic: 探活、版本检查与静态管理页面控制器
// --------------------------------------------------------------------------------
export async function handleStatic(req, res, url, context = {}) {
  const ctx = resolveServerContext(context);
  const sendJson = makeJsonSender(ctx);
  const updates = ctx.services?.updates;
  const pool = ctx.services?.pool || ctx.POOL;
  const config = ctx.config;
  const engine = ctx.engine;

  // GET /readyz (免鉴权基础存活探针)
  if (req.method === 'GET' && url.pathname === '/readyz') {
    return sendJson(res, 200, { status: 'ready' }, {
      'x-gateway-service': 'claude-desktop-proxy',
      ...(process.env.GATEWAY_INSTANCE ? { 'x-gateway-instance': process.env.GATEWAY_INSTANCE } : {}),
    });
  }

  // GET /v1/version
  if (req.method === 'GET' && url.pathname === '/v1/version') {
    return sendJson(res, 200, updates?.status ? updates.status() : (ctx.updates?.status ? ctx.updates.status() : {}));
  }

  // 静态版本面板静态资源
  const versionAsset = updates?.versionAsset || config?.versionAsset || ctx.versionAsset;
  if (req.method === 'GET' && versionAsset && versionAsset(url.pathname, res)) {
    return true;
  }

  // WebUI 管理界面
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui' || url.pathname === '/ui/')) {
    const rawHtml = config?.server?.uiHtml ? config.server.uiHtml() : (config?.uiHtml ? config.uiHtml() : (ctx.uiHtml ? ctx.uiHtml() : null));
    const withVersionPanel = updates?.withVersionPanel || config?.withVersionPanel || ctx.withVersionPanel;
    let html = withVersionPanel ? withVersionPanel(rawHtml) : rawHtml;
    if (!html) {
      return sendJson(res, 500, { error: { message: 'webui.html 不在反代同目录，无法提供管理界面', type: 'proxy_error' } });
    }
    const b = Buffer.from(html);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': b.length,
      'cache-control': 'no-store',
    });
    return res.end(b);
  }

  // POST /v1/version/check 与 POST /v1/version/install (需在鉴权后触发)
  if (url.pathname === '/v1/version/check' || url.pathname === '/v1/version/install') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: { message: 'Method not allowed' } });
    }
    const checking = url.pathname.endsWith('/check');
    if (!updates) {
      return sendJson(res, 500, { error: { message: 'Update service unavailable', type: 'proxy_error' } });
    }
    const data = checking ? await updates.check() : await updates.install();
    return sendJson(res, checking ? 200 : 202, data);
  }

  // GET /healthz (需管理员权限)
  if (req.method === 'GET' && url.pathname === '/healthz') {
    const up = config?.upstream || ctx.UP || {};
    const age = Math.round((Date.now() - (up?.web_cookie_at || 0)) / 1000);
    const st = pool?.status ? pool.status() : (ctx.POOL?.status ? ctx.POOL.status() : { eligible_now: 0, accounts: [] });
    const upBase = up?.web_base || config?.defaultBase || ctx.DEFAULT_BASE || 'https://claude.ai';
    const models = engine?.completionEngine?.modelList ? engine.completionEngine.modelList() : (ctx.modelList ? ctx.modelList() : []);
    const keys = config?.keys || ctx.KEYS;
    return sendJson(res, 200, {
      ok: st.eligible_now > 0,
      upstream: `${upBase}/api/organizations/{org}/chat_conversations/{id}/completion`,
      plan: up?.plan || 'unknown',
      cookie_age_seconds: age,
      models: models.map(m => m.id),
      local_auth: keys?.keyCount?.() > 0 ? 'on' : 'off',
      api_keys: keys?.keyCount?.() || 0,
      pool: {
        strategy: st.strategy,
        total: st.total,
        enabled: st.enabled,
        valid_pool: st.valid_pool,
        exhausted_pool: st.exhausted_pool,
        next_restore_at: st.next_restore_at,
        eligible_now: st.eligible_now,
        per_account_concurrency: st.per_account_concurrency,
        min_quota_remaining: st.min_quota_remaining,
        max_failover: st.max_failover,
        wait_timeout_ms: st.wait_timeout_ms,
        session_affinity: st.session_affinity !== false,
        prune_context: st.prune_context,
        prune_max_tool_chars: st.prune_max_tool_chars,
        prune_keep_recent_tools: st.prune_keep_recent_tools,
        default_effort: st.default_effort,
      },
      accounts: (st.accounts || []).map(a => ({
        id: a.id, label: a.label, enabled: a.enabled,
        inflight: a.inflight, capacity: a.capacity,
        cooldown_remaining_s: a.cooldown_remaining_s,
        exhausted: a.exhausted,
        exhausted_until: a.exhausted_until,
        exhausted_reason: a.exhausted_reason,
        pool: a.pool,
        ok: a.ok, fail: a.fail, last_error: a.last_error,
        quota_5h: a.quota_5h,
      })),
    });
  }

  return false;
}

// --------------------------------------------------------------------------------
// 2. handleTools: 外部搜索与抓取控制器
// --------------------------------------------------------------------------------
export async function handleTools(req, res, url, body = null, context = {}, signal = null) {
  const ctx = resolveServerContext(context);
  const sendJson = makeJsonSender(ctx);
  const parseBody = ctx.readBody || readBody;
  const tools = ctx.services?.tools || ctx.tools || ctx;
  const sig = signal || ctx?.gone?.signal;

  const isSearchPath = url.pathname === '/v1/tools/search' || url.pathname === '/tools/search'
    || url.pathname === '/v1/search' || url.pathname === '/search';
  if (isSearchPath) {
    try {
      let query = '';
      let count = 10;
      if (req.method === 'POST') {
        const b = body || await parseBody(req);
        query = b.query || b.q || b.prompt || b.ori_question || '';
        count = +(b.count || b.max_results || b.maxResults || 10);
      } else if (req.method === 'GET') {
        query = url.searchParams.get('query') || url.searchParams.get('q') || '';
        count = +(url.searchParams.get('count') || 10);
      } else {
        return sendJson(res, 405, { error: { message: 'Method Not Allowed', type: 'invalid_request_error' } });
      }

      if (!query) {
        return sendJson(res, 200, { results: [] });
      }

      const searchDuckDuckGo = tools.searchDuckDuckGo || ctx.searchDuckDuckGo;
      const results = await searchDuckDuckGo(query, Math.min(Math.max(1, count), 30), sig);
      console.log(`[web-search] 返回 ${results.length} 条搜索结果`);
      return sendJson(res, 200, { results });
    } catch (e) {
      console.error('[web-search] 搜索异常:', e.message);
      return sendJson(res, e.status || 502, { error: { message: `搜索失败: ${e.message}`, type: 'search_error' } });
    }
  }

  const isFetchPath = url.pathname === '/v1/tools/fetch' || url.pathname === '/tools/fetch'
    || url.pathname === '/v1/fetch' || url.pathname === '/fetch';
  if (isFetchPath) {
    try {
      let targetUrl = '';
      if (req.method === 'POST') {
        const b = body || await parseBody(req);
        targetUrl = b.url || '';
      } else if (req.method === 'GET') {
        targetUrl = url.searchParams.get('url') || '';
      } else {
        return sendJson(res, 405, { error: { message: 'Method Not Allowed', type: 'invalid_request_error' } });
      }

      if (!targetUrl) {
        return sendJson(res, 400, { error: { message: 'url is required', type: 'invalid_request_error' } });
      }

      const fetchWebContent = tools.fetchWebContent || ctx.fetchWebContent;
      const content = await fetchWebContent(targetUrl, sig);
      return sendJson(res, 200, { content });
    } catch (e) {
      console.error('[web-fetch] 抓取异常:', e.message);
      return sendJson(res, e.status || 502, { error: { message: `抓取失败: ${e.message}`, type: 'fetch_error' } });
    }
  }

  return false;
}

// --------------------------------------------------------------------------------
// 3. handleLogs: 操作审计与用量统计控制器
// --------------------------------------------------------------------------------
export async function handleLogs(req, res, url, context = {}) {
  const ctx = resolveServerContext(context);
  const sendJson = makeJsonSender(ctx);
  const logs = ctx.services?.logs || ctx.logs || ctx;
  const auth = ctx.services?.auth || ctx.auth || ctx;
  const pool = ctx.services?.pool || ctx.POOL;

  // GET /v1/operations: 查询审计日志
  if (url.pathname === '/v1/operations' && req.method === 'GET') {
    const category = url.searchParams.get('category') || '';
    const status = url.searchParams.get('status') || '';
    const q = url.searchParams.get('q') || '';
    const limit = +(url.searchParams.get('limit') || 100);
    const offset = +(url.searchParams.get('offset') || 0);
    const result = (logs.queryOperations || ctx.queryOperations)({ category, status, query: q, limit, offset });
    const stats = (logs.getOperationStats || ctx.getOperationStats)();
    return sendJson(res, 200, { ok: true, ...result, stats });
  }

  // POST /v1/operations/clear: 清空审计日志 (本机回环)
  if (url.pathname === '/v1/operations/clear' && req.method === 'POST') {
    const isLoopbackReq = auth.isLoopbackReq || ctx.isLoopbackReq;
    if (isLoopbackReq && !isLoopbackReq(req)) {
      return sendJson(res, 403, { error: { message: '清空操作日志需本机访问', type: 'permission_error' } });
    }
    const clearOperations = logs.clearOperations || ctx.clearOperations;
    const logOperation = logs.logOperation || ctx.logOperation;
    const getReqIp = auth.getReqIp || ctx.getReqIp;
    if (clearOperations) clearOperations();
    if (logOperation) {
      logOperation({
        category: '系统配置',
        action: '清空日志',
        target: 'operations',
        status: 'success',
        detail: '操作审计日志已被清空',
        ip: getReqIp ? getReqIp(req) : '',
      });
    }
    return sendJson(res, 200, { ok: true, message: '操作日志已清空' });
  }

  // GET /v1/usage: 用量汇总
  if (req.method === 'GET' && url.pathname === '/v1/usage') {
    const range = url.searchParams.get('range') || 'today';
    const accountId = url.searchParams.get('accountId') || '';
    const model = url.searchParams.get('model') || '';
    const USAGE = logs.USAGE || ctx.USAGE;
    const s = USAGE ? USAGE.summary(range, { accountId, model }) : {};
    const accounts = pool?.status ? pool.status().accounts : (ctx.POOL?.status ? ctx.POOL.status().accounts : []);
    s.accounts_all = (accounts || []).map(a => ({
      id: a.id, label: a.label, enabled: a.enabled,
      tokens_in_est: a.tokens_in_est, tokens_out_est: a.tokens_out_est,
      total_tokens_est: (a.tokens_in_est || 0) + (a.tokens_out_est || 0),
      quota_remaining: a.quota_remaining,
    }));
    return sendJson(res, 200, s);
  }

  // GET /v1/usage/logs: 用量流水日志
  if (req.method === 'GET' && url.pathname === '/v1/usage/logs') {
    const USAGE = logs.USAGE || ctx.USAGE;
    return sendJson(res, 200, {
      logs: USAGE ? USAGE.logs({
        range: url.searchParams.get('range') || 'today',
        accountId: url.searchParams.get('accountId') || '',
        limit: +(url.searchParams.get('limit') || 100),
      }) : [],
    });
  }

  return false;
}

// --------------------------------------------------------------------------------
// 4. handleAdmin: 账号、密钥、池配置与过CF管理控制器
// --------------------------------------------------------------------------------
export async function handleAdmin(req, res, url, body = null, context = {}) {
  const ctx = resolveServerContext(context);
  const sendJson = makeJsonSender(ctx);
  const parseBody = ctx.readBody || readBody;
  const accounts = ctx.services?.accounts || ctx;
  const pool = ctx.services?.pool || accounts?.pool || ctx.POOL;
  const kyc = ctx.services?.kyc || ctx;
  const verify = ctx.services?.verify || ctx;
  const logs = ctx.services?.logs || ctx;
  const auth = ctx.services?.auth || ctx;
  const config = ctx.config || ctx;
  const toMask = accounts?.maskAccount || ctx.maskAccount || maskAccount;

  // 1. API Keys 管理路由 (/v1/keys)
  if (url.pathname === '/v1/keys' || url.pathname.startsWith('/v1/keys/')) {
    const rest = url.pathname.slice('/v1/keys'.length).replace(/^\//, '');
    const parts = rest ? rest.split('/') : [];
    const kid = parts[0] || '';
    const action = parts[1] || '';
    const keys = config.keys || ctx.KEYS;
    const publicSettingsFn = config.publicSettings || ctx.publicSettings;
    const configFile = config.configFile || ctx.CONFIG_FILE;

    if (!kid && req.method === 'GET') {
      return sendJson(res, 200, {
        keys: keys.list(),
        settings: publicSettingsFn(keys.settings()),
        config_file: path.basename(configFile),
      });
    }
    if (!kid && req.method === 'POST') {
      const b = body || await parseBody(req);
      const k = keys.create(b);
      return sendJson(res, 201, { key: keys.list().find(x => x.id === k.id), secret: k.key });
    }
    if (kid && action === 'reset' && req.method === 'POST') {
      return sendJson(res, keys.resetUsage(kid) ? 200 : 404, { ok: true });
    }
    if (kid && req.method === 'PATCH') {
      const b = body || await parseBody(req);
      const k = keys.update(kid, b);
      if (!k) return sendJson(res, 404, { error: { message: 'key not found', type: 'invalid_request_error' } });
      return sendJson(res, 200, { key: keys.list().find(x => x.id === kid) });
    }
    if (kid && req.method === 'DELETE') {
      return sendJson(res, keys.remove(kid) ? 200 : 404, { ok: true });
    }
    return sendJson(res, 405, { error: { message: 'method not allowed', type: 'invalid_request_error' } });
  }

  // 2. 账号列表查询 (GET /v1/accounts)
  if (url.pathname === '/v1/accounts' && req.method === 'GET') {
    const keys = config.keys || ctx.KEYS;
    const publicSettingsFn = config.publicSettings || ctx.publicSettings;
    const st = pool.status();
    const setts = keys?.settings() || {};
    Object.assign(st, publicSettingsFn(setts));
    st.server = keys?.serverConfig();
    const cfStorm = verify.cfStormActive || ctx.cfStormActive;
    st.cf_storm = cfStorm ? cfStorm() : { active: false };
    const cfVerify = verify.cfVerify || ctx.CFVERIFY;
    st.cf_batch = cfVerify?.activeBatch ? cfVerify.activeBatch() : null;
    try {
      const tokenStatsFn = accounts.accountTokenStats || ctx.accountTokenStats;
      const byId = tokenStatsFn ? tokenStatsFn() : new Map();
      for (const a of st.accounts) {
        const x = byId.get(a.id);
        if (!x) continue;
        a.tokens_total = x.total_tokens;
        a.tokens_in = x.input_tokens;
        a.tokens_out = x.output_tokens;
        a.tokens_cached = x.cached_tokens;
        a.tokens_new_input = x.new_input_tokens;
        a.requests_total = x.requests;
        a.tokens_source = 'usage-log';
      }
    } catch { /* 容错 */ }
    return sendJson(res, 200, st);
  }

  // 3. KYC 状态查询 (GET /v1/kyc)
  if (url.pathname === '/v1/kyc' && req.method === 'GET') {
    const wantId = url.searchParams.get('id');
    const fresh = url.searchParams.get('fresh') === '1';
    const TTL = 5 * 60 * 1000;
    let targets = pool.accounts().filter(a => a.enabled && (a.sessionKey || a.cookie));
    if (wantId) {
      targets = targets.filter(a => a.id === wantId);
      if (!targets.length) {
        return sendJson(res, 404, { error: { message: 'account not found', type: 'invalid_request_error' } });
      }
    }
    const results = {};
    const todo = [];
    const kycCache = kyc.cache || ctx.KYC_CACHE;
    const checkKycFn = kyc.checkKyc || ctx.checkKyc;
    const webHeadersFn = ctx.webHeaders || webHeaders;
    const upBase = config.upstream?.web_base || ctx.UP?.web_base || DEFAULT_BASE;

    for (const a of targets) {
      const hit = kycCache?.get(a.id);
      if (!fresh && hit && Date.now() - hit.at < TTL) results[a.id] = hit.data;
      else todo.push(a);
    }
    let idx = 0;
    const workers = Array.from({ length: Math.min(3, todo.length) }, async () => {
      while (idx < todo.length) {
        const a = todo[idx++];
        try {
          const data = await checkKycFn({ base: a.base || upBase, headers: webHeadersFn(a) });
          kycCache?.set(a.id, { at: Date.now(), data });
          results[a.id] = data;
        } catch (e) {
          results[a.id] = { ok: false, error: { code: 'network', message: String(e?.message || e) } };
        }
      }
    });
    await Promise.all(workers);
    const logOp = logs.logOperation || ctx.logOperation;
    const reqIp = (auth.getReqIp || ctx.getReqIp)(req);
    if (logOp) {
      logOp({
        category: '额度风控',
        action: '查询KYC',
        target: wantId ? (targets[0]?.label || wantId) : `全部账号(${targets.length})`,
        status: 'success',
        detail: `已查询 ${targets.length} 个账号 (重新探测: ${todo.length}, 缓存: ${targets.length - todo.length})`,
        ip: reqIp,
      });
    }
    return sendJson(res, 200, { results, checked: todo.length, cached: targets.length - todo.length });
  }

  // 4. 添加单账号 (POST /v1/accounts)
  if (url.pathname === '/v1/accounts' && req.method === 'POST') {
    const b = body || await parseBody(req);
    if (!b.sessionKey) {
      return sendJson(res, 400, { error: { message: 'sessionKey is required', type: 'invalid_request_error' } });
    }
    let org = b.org || '';
    if (!org) {
      try {
        const discoverOrgFn = accounts.discoverOrg || ctx.discoverOrg;
        const d = await discoverOrgFn(b.sessionKey, b.base || undefined, b.ua || undefined);
        org = d.org;
      } catch (e) {
        return sendJson(res, e.status || 502, {
          error: { message: `org 自动发现失败: ${e.message}（可手动传 org 字段）`, type: 'proxy_error' },
        });
      }
    }
    const { account, created } = pool.add({ ...b, org });
    const logOp = logs.logOperation || ctx.logOperation;
    const reqIp = (auth.getReqIp || ctx.getReqIp)(req);
    if (logOp) {
      logOp({
        category: '账号管理',
        action: created ? '添加账号' : '更新账号',
        target: account.label || account.id,
        status: 'success',
        detail: `${created ? '新增账号成功' : '更新账号成功'} (org: ${account.org || '-'})`,
        ip: reqIp,
      });
    }
    return sendJson(res, created ? 201 : 200, { created, account: toMask(account) });
  }

  // 5. 账号子路径路由 (/v1/accounts/*)
  if (url.pathname.startsWith('/v1/accounts/')) {
    const rest = url.pathname.slice('/v1/accounts/'.length);
    const id = rest;

    // 批量导入
    if (rest === 'batch-import' && req.method === 'POST') {
      const isLoopback = auth.isLoopbackReq || ctx.isLoopbackReq;
      if (isLoopback && !isLoopback(req)) {
        return sendJson(res, 403, { error: { message: '批量导入凭据只能在运行反代的机器上操作（需本机访问）', type: 'permission_error' } });
      }
      let b;
      try { b = body || await parseBody(req); } catch { b = {}; }
      let rawItems = [];
      const parseImportLinesFn = accounts.parseImportLines || ctx.parseImportLines || parseImportLines;
      if (Array.isArray(b.items)) {
        rawItems = b.items;
      } else if (typeof b.text === 'string') {
        rawItems = parseImportLinesFn(b.text);
      }
      if (!rawItems.length) {
        return sendJson(res, 400, { error: { message: '未解析出任何有效的 sessionKey', type: 'invalid_request_error' } });
      }
      const onConflict = b.onConflict || 'update';
      const seen = new Set();
      const unique = [];
      for (const it of rawItems) {
        const k = String(it.sessionKey || '').trim();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        unique.push({ sessionKey: k, label: (it.label || '').trim(), org: (it.org || '').trim() });
      }

      const results = {
        total: unique.length,
        imported: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        accounts: [],
        errors: [],
      };

      const CONCURRENCY = 4;
      let idx = 0;
      const discoverOrgFn = accounts.discoverOrg || ctx.discoverOrg;
      const upBase = config.upstream?.web_base || ctx.UP?.web_base || DEFAULT_BASE;
      const defaultUa = config.defaultUa || ctx.DEFAULT_UA || DEFAULT_UA;

      const workers = Array.from({ length: Math.min(CONCURRENCY, unique.length) }, async () => {
        while (idx < unique.length) {
          const item = unique[idx++];
          const existing = pool.accounts().find(a => a.sessionKey === item.sessionKey);
          if (existing && onConflict === 'skip') {
            results.skipped++;
            results.accounts.push({ id: existing.id, label: existing.label, status: 'skipped' });
            continue;
          }
          let org = item.org;
          let name = '';
          if (!org) {
            try {
              const d = await discoverOrgFn(item.sessionKey, upBase, defaultUa);
              org = d.org;
              name = d.name || '';
            } catch (e) {
              results.failed++;
              results.errors.push({ sessionKey: item.sessionKey.slice(0, 16) + '...', error: e.message });
              continue;
            }
          }
          const label = item.label || name || (existing ? existing.label : `账号 ${results.imported + results.updated + 1}`);
          const { account, created } = pool.add({
            sessionKey: item.sessionKey,
            label,
            org,
            source: 'batch_import',
            enabled: true,
          });
          if (created) results.imported++;
          else results.updated++;
          results.accounts.push({ id: account.id, label: account.label, org: account.org, status: created ? 'created' : 'updated' });
        }
      });
      await Promise.all(workers);
      const logOp = logs.logOperation || ctx.logOperation;
      const reqIp = (auth.getReqIp || ctx.getReqIp)(req);
      if (logOp) {
        logOp({
          category: '账号管理',
          action: '批量导入',
          target: `${unique.length}个凭据`,
          status: (results.imported + results.updated > 0) ? 'success' : 'failed',
          detail: `成功导入: ${results.imported} 新增, ${results.updated} 更新, ${results.skipped} 跳过, ${results.failed} 失败`,
          ip: reqIp,
        });
      }
      return sendJson(res, 200, results);
    }

    // 凭据反查
    if (rest === 'lookup' && req.method === 'POST') {
      const b = body || await parseBody(req);
      const sk = String(b.sessionKey || '').trim();
      if (!sk) {
        return sendJson(res, 400, { error: { message: 'sessionKey is required', type: 'invalid_request_error' } });
      }
      const hit = pool.accounts().find(x => x.sessionKey === sk);
      if (hit) {
        return sendJson(res, 200, {
          matched: true,
          account: {
            id: hit.id, label: hit.label, org: hit.org || '',
            enabled: !!hit.enabled, source: hit.source || 'manual',
          },
        });
      }
      try {
        const discoverOrgFn = accounts.discoverOrg || ctx.discoverOrg;
        const d = await discoverOrgFn(sk, b.base || undefined, b.ua || undefined);
        return sendJson(res, 200, { matched: false, org: d.org, name: d.name || '', plan: d.plan || '' });
      } catch (e) {
        return sendJson(res, e.status || 502, { error: { message: `查询失败: ${e.message}`, type: 'proxy_error' } });
      }
    }

    // 清空全部冷却
    if (rest === 'clear-cooldowns' && req.method === 'POST') {
      const b = body || await parseBody(req).catch(() => ({}));
      const clearExhausted = !!b?.clearExhausted;
      const cleared = pool.clearAllCooldowns(clearExhausted);
      const clearChall = verify.clearChallengeEvents || ctx.clearChallengeEvents;
      if (clearChall) clearChall();
      const logOp = logs.logOperation || ctx.logOperation;
      const reqIp = (auth.getReqIp || ctx.getReqIp)(req);
      if (logOp) {
        logOp({
          category: '额度风控',
          action: '清空所有冷却',
          target: clearExhausted ? '全量账号(含429耗尽池)' : '全量账号(冷却中)',
          status: 'success',
          detail: `已清空 ${cleared} 个账号的冷却与连续失败状态` + (clearExhausted ? '（含 429 配额耗尽池）' : ''),
          ip: reqIp,
        });
      }
      return sendJson(res, 200, { ok: true, cleared });
    }

    // 导出防护 (410 Gone)
    if (rest === 'export' || id.endsWith('/credentials')) {
      return sendJson(res, 410, { error: { type: 'permission_error', message: '明文凭据不再通过 HTTP 导出；请在主机上管理私有数据文件。' } });
    }

    // 连通性测试
    if (req.method === 'GET' && id.endsWith('/test')) {
      const acct = pool.get(id.slice(0, -'/test'.length));
      if (!acct) return sendJson(res, 404, { error: { message: 'account not found', type: 'invalid_request_error' } });
      const discoverOrgFn = accounts.discoverOrg || ctx.discoverOrg;
      const logOp = logs.logOperation || ctx.logOperation;
      const reqIp = (auth.getReqIp || ctx.getReqIp)(req);
      try {
        const d = await discoverOrgFn(acct.sessionKey, acct.base, acct.ua);
        if (logOp) {
          logOp({
            category: '额度风控',
            action: '连通性测试',
            target: acct.label || acct.id,
            status: 'success',
            detail: `组织: ${d.name || d.org}, 计划: ${d.plan || 'free'}`,
            ip: reqIp,
          });
        }
        return sendJson(res, 200, { ok: true, org: d.org, name: d.name, plan: d.plan });
      } catch (e) {
        if (logOp) {
          logOp({
            category: '额度风控',
            action: '连通性测试',
            target: acct.label || acct.id,
            status: 'failed',
            detail: e.message,
            ip: reqIp,
          });
        }
        return sendJson(res, e.status || 502, {
          ok: false,
          error: { message: `登录态校验失败: ${e.message}`, type: 'proxy_error' },
        });
      }
    }

    // 主动探测额度
    if (req.method === 'POST' && id.endsWith('/quota')) {
      const acct = pool.get(id.slice(0, -'/quota'.length));
      if (!acct) return sendJson(res, 404, { error: { message: 'account not found', type: 'invalid_request_error' } });
      const probeQuotaFn = accounts.probeQuota || ctx.probeQuota;
      const upBase = config.upstream?.web_base || ctx.UP?.web_base || 'https://claude.ai';
      const logOp = logs.logOperation || ctx.logOperation;
      const reqIp = (auth.getReqIp || ctx.getReqIp)(req);

      try {
        const r = await probeQuotaFn(acct, { base: upBase });
        if (r.limit) {
          pool.updateQuota(acct, { ...r.limit, rate_limits: r.rate_limits, probedAt: Date.now() });
          pool.set(acct.id, { cooldownUntil: 0, clearError: true });
        }
        const st = pool.status().accounts.find(x => x.id === acct.id);
        const u5 = Math.round((r.limit?.windows?.['5h']?.utilization ?? 0) * 100);
        const u7 = Math.round((r.limit?.windows?.['7d']?.utilization ?? 0) * 100);
        if (logOp) {
          logOp({
            category: '额度风控',
            action: '主动查额度',
            target: acct.label || acct.id,
            status: 'success',
            detail: `会话5h用量: ${u5}%, 7天周额度用量: ${u7}% (剩余: ${Math.round((r.limit?.remaining ?? 1) * 100)}%)`,
            ip: reqIp,
          });
        }
        return sendJson(res, 200, {
          ok: !!r.limit,
          quota: {
            '5h': r.limit?.windows?.['5h'] || null,
            '7d': r.limit?.windows?.['7d'] || null,
            remaining: r.limit?.remaining ?? null,
            per_model_limit: r.limit?.perModelLimit ?? null,
            spend: r.limit?.resolved?.spend ?? null,
            representative_claim: r.limit?.representativeClaim || null,
            resolved_limit: r.limit?.resolved?.limit || null,
          },
          rate_limits: r.rate_limits,
          account: st,
          note: r.note,
        });
      } catch (e) {
        const status = e.status || (/429/.test(e.message) ? 429 : 502);
        const classifyFn = ctx.classify || classify;
        const c = classifyFn(status, e.message);
        if (c.kind === 'rate_limit' && c.resetsAt) {
          pool.fail(acct, 'rate_limit', e.message, { resetsAt: c.resetsAt, reason: c.reason });
          pool.updateQuota(acct, {
            windows: {
              '5h': { status: 'exceeded_limit', resets_at: Math.floor(c.resetsAt / 1000), utilization: 1 },
            },
            remaining: 0,
            resetsAt: Math.floor(c.resetsAt / 1000),
            representativeClaim: c.reason || 'five_hour',
            resolved: { limit: { percent: 1, resets_at: new Date(c.resetsAt).toISOString() } },
            probedAt: Date.now(),
          });
        } else if (c.kind === 'rate_limit' || c.kind === 'auth') {
          pool.fail(acct, c.kind, e.message);
        }
        const st = pool.status().accounts.find(x => x.id === acct.id);
        if (logOp) {
          logOp({
            category: '额度风控',
            action: '主动查额度',
            target: acct.label || acct.id,
            status: 'failed',
            detail: e.message,
            ip: reqIp,
          });
        }
        return sendJson(res, status, {
          ok: false,
          error: { message: `额度探测失败: ${e.message}`, type: 'proxy_error' },
          account: st,
        });
      }
    }

    // 单账号过CF发起
    if (req.method === 'POST' && id.endsWith('/cfverify')) {
      const isLoopback = auth.isLoopbackReq || ctx.isLoopbackReq;
      if (isLoopback && !isLoopback(req)) {
        return sendJson(res, 403, {
          error: { message: '过CF流程会弹出本机浏览器窗口，只能在运行反代的机器上操作（需本机回环访问）', type: 'permission_error' },
        });
      }
      const acctId = id.slice(0, -'/cfverify'.length);
      const acct = pool.get(acctId);
      if (!acct) return sendJson(res, 404, { error: { message: 'account not found', type: 'invalid_request_error' } });
      const cfVerify = verify.cfVerify || ctx.CFVERIFY;
      const r = cfVerify.start(acctId, acct.sessionKey);
      if (!r.ok) return sendJson(res, 409, { error: { message: r.error, type: 'invalid_request_error' } });
      console.log(`[cfverify] 账号 ${acctId} 发起手动过CF (flow=${r.flowId}${r.reused ? ' 复用进行中的流程' : ''})`);
      return sendJson(res, 200, { ok: true, flowId: r.flowId, reused: !!r.reused });
    }

    // 调起网页浏览器端登录
    if (req.method === 'POST' && (id.endsWith('/open-web') || rest === 'open-web')) {
      const isLoopback = auth.isLoopbackReq || ctx.isLoopbackReq;
      if (isLoopback && !isLoopback(req)) {
        return sendJson(res, 403, { error: { message: '打开网页端只能在运行反代的机器上操作（需本机访问）', type: 'permission_error' } });
      }
      const acctId = id.endsWith('/open-web') ? id.slice(0, -'/open-web'.length) : '';
      let sk = '';
      let org = '';
      let cookie = '';
      let ua = '';
      if (acctId) {
        const a = pool.get(acctId);
        if (!a) return sendJson(res, 404, { error: { message: 'account not found', type: 'invalid_request_error' } });
        sk = a.sessionKey;
        org = a.org || '';
        cookie = a.cookie || '';
        ua = a.ua || '';
      } else {
        const b = body || await parseBody(req);
        sk = b.sessionKey;
        org = b.org || '';
      }
      if (!sk) return sendJson(res, 400, { error: { message: 'sessionKey is required', type: 'invalid_request_error' } });
      const openClaudeWebBrowserFn = verify.openClaudeWebBrowser || ctx.openClaudeWebBrowser;
      const logOp = logs.logOperation || ctx.logOperation;
      const reqIp = (auth.getReqIp || ctx.getReqIp)(req);

      try {
        const r = await openClaudeWebBrowserFn({ sessionKey: sk, org, cookie, ua });
        if (logOp) {
          logOp({
            category: '客户端调起',
            action: '打开网页端',
            target: acctId || '当前账号',
            status: 'success',
            detail: `在 ${r.browser} 浏览器打开官方网页端并登录 (PID: ${r.pid || '-'})`,
            ip: reqIp,
          });
        }
        return sendJson(res, 200, { ok: true, message: `已成功在 ${r.browser} 浏览器中打开官方网页端并登录！`, ...r });
      } catch (e) {
        if (logOp) {
          logOp({
            category: '客户端调起',
            action: '打开网页端',
            target: acctId || '当前账号',
            status: 'failed',
            detail: e.message,
            ip: reqIp,
          });
        }
        return sendJson(res, 500, { error: { message: `调起浏览器失败: ${e.message}`, type: 'proxy_error' } });
      }
    }

    // 修改账号 (PATCH)
    if (req.method === 'PATCH') {
      const b = body || await parseBody(req);
      const a = pool.set(id, b);
      if (!a) return sendJson(res, 404, { error: { message: 'account not found', type: 'invalid_request_error' } });
      const isClearCd = b.cooldownUntil === 0;
      const logOp = logs.logOperation || ctx.logOperation;
      const reqIp = (auth.getReqIp || ctx.getReqIp)(req);
      if (logOp) {
        logOp({
          category: isClearCd ? '额度风控' : '账号管理',
          action: isClearCd ? '清空冷却' : '修改账号',
          target: a.label || id,
          status: 'success',
          detail: isClearCd ? '手动清空 429 冷却与重试等待' : `更新设置: ${Object.keys(b).join(', ')}`,
          ip: reqIp,
        });
      }
      return sendJson(res, 200, { account: toMask(a) });
    }

    // 删除账号 (DELETE)
    if (req.method === 'DELETE') {
      const a = pool.get(id);
      const lbl = a?.label || id;
      if (!pool.remove(id)) {
        return sendJson(res, 404, { error: { message: 'account not found', type: 'invalid_request_error' } });
      }
      const logOp = logs.logOperation || ctx.logOperation;
      const reqIp = (auth.getReqIp || ctx.getReqIp)(req);
      if (logOp) {
        logOp({
          category: '账号管理',
          action: '删除账号',
          target: lbl,
          status: 'success',
          detail: `账号 ${id} 已从账号池彻底移除`,
          ip: reqIp,
        });
      }
      return sendJson(res, 200, { removed: id });
    }
  }

  // 6. 过CF状态与批量控制端点 (/v1/cfverify/*)
  if (/^\/v1\/cfverify\/[^/]+\/state$/.test(url.pathname) && req.method === 'GET') {
    const isLoopback = auth.isLoopbackReq || ctx.isLoopbackReq;
    if (isLoopback && !isLoopback(req)) {
      return sendJson(res, 403, { error: { message: '过CF流程只能在运行反代的机器上查看（需本机回环访问）', type: 'permission_error' } });
    }
    const fid = url.pathname.split('/')[3];
    const cfVerify = verify.cfVerify || ctx.CFVERIFY;
    const s = cfVerify.state(fid);
    return sendJson(res, s ? 200 : 404, s || { error: { message: '过CF流程不存在或已过期', type: 'invalid_request_error' } });
  }

  if (url.pathname === '/v1/cfverify/batch' && req.method === 'POST') {
    const isLoopback = auth.isLoopbackReq || ctx.isLoopbackReq;
    if (isLoopback && !isLoopback(req)) {
      return sendJson(res, 403, { error: { message: '批量过CF会弹出本机浏览器窗口，只能在运行反代的机器上操作（需本机回环访问）', type: 'permission_error' } });
    }
    let b;
    try { b = body || await parseBody(req); } catch { b = {}; }
    const ids = Array.isArray(b?.ids) ? b.ids.filter(x => typeof x === 'string' && x) : [];
    if (!ids.length) {
      return sendJson(res, 400, { error: { message: 'ids 数组为空', type: 'invalid_request_error' } });
    }
    const items = [];
    const skipped = [];
    for (const aid of ids) {
      const acct = pool.get(aid);
      if (acct && acct.sessionKey) items.push({ id: aid, sessionKey: acct.sessionKey });
      else skipped.push(aid);
    }
    const cfVerify = verify.cfVerify || ctx.CFVERIFY;
    const r = cfVerify.startBatch(items);
    if (!r.ok) return sendJson(res, 409, { error: { message: r.error, type: 'invalid_request_error' } });
    console.log(`[cfverify] 批量过CF发起：${items.length} 个账号${skipped.length ? `（跳过 ${skipped.length} 个无效 id）` : ''}`);
    return sendJson(res, 200, { ok: true, flowId: r.flowId, total: items.length, skipped, reused: !!r.reused });
  }

  if (/^\/v1\/cfverify\/[^/]+\/cancel$/.test(url.pathname) && req.method === 'POST') {
    const isLoopback = auth.isLoopbackReq || ctx.isLoopbackReq;
    if (isLoopback && !isLoopback(req)) {
      return sendJson(res, 403, { error: { message: '过CF流程只能在运行反代的机器上操作（需本机回环访问）', type: 'permission_error' } });
    }
    const fid = url.pathname.split('/')[3];
    const cfVerify = verify.cfVerify || ctx.CFVERIFY;
    const ok = cfVerify.cancel(fid);
    return sendJson(res, ok ? 200 : 404, { ok, message: ok ? '已请求取消，当前账号完成后停止' : '流程不存在或已结束' });
  }

  // 7. 账号池配置 (/v1/pool)
  if (url.pathname === '/v1/pool') {
    const keys = config.keys || ctx.KEYS;
    const publicSettingsFn = config.publicSettings || ctx.publicSettings;
    if (req.method === 'GET') {
      const st = pool.status();
      const setts = keys?.settings() || {};
      return sendJson(res, 200, {
        strategy: st.strategy,
        per_account_concurrency: st.per_account_concurrency,
        min_quota_remaining: st.min_quota_remaining,
        max_failover: st.max_failover,
        wait_timeout_ms: st.wait_timeout_ms,
        session_affinity: st.session_affinity !== false,
        prune_context: st.prune_context,
        prune_max_tool_chars: st.prune_max_tool_chars,
        prune_keep_recent_tools: st.prune_keep_recent_tools,
        default_effort: st.default_effort,
        ...publicSettingsFn(setts),
        server: keys?.serverConfig(),
      });
    }
    if (req.method === 'POST') {
      const b = body || await parseBody(req);
      const logOp = logs.logOperation || ctx.logOperation;
      const reqIp = (auth.getReqIp || ctx.getReqIp)(req);
      try {
        const cfg = pool.configure(b);
        const patch = {};
        if (typeof b.pricePerMillionTokens === 'number' && Number.isFinite(b.pricePerMillionTokens) && b.pricePerMillionTokens >= 0) {
          patch.pricePerMillionTokens = b.pricePerMillionTokens;
        }
        if (Object.keys(patch).length && keys?.updateSettings) {
          keys.updateSettings(patch);
        }
        if (logOp) {
          logOp({
            category: '系统配置',
            action: '修改系统设置',
            target: 'pool/settings',
            status: 'success',
            detail: `调度策略: ${b.strategy || '-'}, 并发: ${b.perAccountConcurrency || '-'}, 额度阈值: ${b.minQuotaRemaining != null ? Math.round(b.minQuotaRemaining * 100) + '%' : '-'}`,
            ip: reqIp,
          });
        }
        return sendJson(res, 200, {
          ...cfg,
          ...publicSettingsFn(keys?.settings()),
        });
      } catch (e) {
        if (logOp) {
          logOp({
            category: '系统配置',
            action: '修改系统设置',
            target: 'pool/settings',
            status: 'failed',
            detail: e.message,
            ip: reqIp,
          });
        }
        return sendJson(res, e.status || 400, { error: { message: e.message, type: 'invalid_request_error' } });
      }
    }
  }

  return false;
}

// --------------------------------------------------------------------------------
// 5. handleInference: 模型与核心推理端点控制器
// --------------------------------------------------------------------------------
export async function handleInference(req, res, url, body = null, ctx = null, context = {}, gone = null) {
  const srv = resolveServerContext(context);
  const sendJson = makeJsonSender(srv);
  const parseBody = srv.readBody || readBody;
  const g = gone || srv?.gone || { signal: null };
  const engine = srv.engine || srv;
  const completionEngine = engine.completionEngine || srv.completionEngine || srv;
  const chatProtocol = engine.chatProtocol || srv.chatProtocol || srv;
  const responseAdapter = engine.responseAdapter || srv.responseAdapter || srv;
  const promptRenderer = engine.promptRenderer || srv.promptRenderer || srv;
  const keys = srv.config?.keys || srv.KEYS;

  // GET /v1/models
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const models = completionEngine.modelList ? completionEngine.modelList() : (srv.modelList ? srv.modelList() : []);
    return sendJson(res, 200, { object: 'list', data: models });
  }

  // POST /v1/chat/completions (OpenAI Chat API)
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const b = body || await parseBody(req);
    if (!Array.isArray(b?.messages) || !b.messages.length || b.messages.some(m => !m || typeof m.role !== 'string')) {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'messages must be a nonempty array of messages' } });
    }
    const mapModelFn = completionEngine.mapModel || srv.mapModel;
    const model = mapModelFn(b.model);
    if (ctx) ctx.model = model;
    if (req.apiKey && keys && !keys.modelAllowed(req.apiKey, model)) {
      return sendJson(res, 403, { error: { message: `模型 ${model} 不在该 Key 的允许范围内`, type: 'permission_error' } });
    }

    const runCompletionFn = completionEngine.runCompletion ? (...a) => completionEngine.runCompletion(...a) : srv.runCompletion;
    const run = await runCompletionFn(b, model, g.signal, req, ctx);
    const newChatIdFn = chatProtocol.newChatId || srv.newChatId;
    const chatId = newChatIdFn ? newChatIdFn() : `chatcmpl-${randomUUID()}`;

    try {
      if (b.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.flushHeaders?.();
        const streamToClientFn = chatProtocol.streamToClient || srv.streamToClient;
        return await streamToClientFn(res, run, model, chatId, b.stream_options?.include_usage === true);
      }

      const collectFn = chatProtocol.collect || srv.collect;
      const ant2oaiTextFn = chatProtocol.ant2oaiText || srv.ant2oaiText;
      const result = await collectFn(run.events(), run.ctx);
      return sendJson(res, 200, ant2oaiTextFn(result, model, run.ctx));
    } catch (streamErr) {
      run.release(false, streamErr.message);
      if (b.stream && !res.writableEnded && !res.destroyed) {
        try { res.write(`data: ${JSON.stringify({ error: { message: streamErr.message, type: 'proxy_error' } })}\n\n`); } catch {}
        try { res.end(); } catch {}
      }
      throw streamErr;
    } finally {
      run.release();
    }
  }

  // POST /v1/responses (OpenAI Responses API)
  if (req.method === 'POST' && url.pathname === '/v1/responses') {
    const rb = body || await parseBody(req);
    if (!rb || typeof rb !== 'object' || Array.isArray(rb)) {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'request body must be an object' } });
    }
    if (rb.stream != null && typeof rb.stream !== 'boolean') {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'stream must be a boolean', param: 'stream' } });
    }
    const responsesToChatFn = responseAdapter.responsesToChat || srv.responsesToChat;
    const chat = responsesToChatFn(rb, req.keyScope);
    if (!chat.messages.length) {
      return sendJson(res, 400, { error: { message: 'input is required', type: 'invalid_request_error', param: 'input' } });
    }
    const mapModelFn = completionEngine.mapModel || srv.mapModel;
    const model = mapModelFn(rb.model);
    if (ctx) ctx.model = model;
    if (req.apiKey && keys && !keys.modelAllowed(req.apiKey, model)) {
      return sendJson(res, 403, { error: { message: `模型 ${model} 不在该 Key 的允许范围内`, type: 'permission_error' } });
    }
    const newRespIdFn = responseAdapter.newRespId || srv.newRespId;
    const id = newRespIdFn ? newRespIdFn() : `resp_${randomUUID().replace(/-/g, '')}`;
    const stream = rb.stream === true;

    const runCompletionFn = completionEngine.runCompletion ? (...a) => completionEngine.runCompletion(...a) : srv.runCompletion;
    const run = await runCompletionFn(chat, model, g.signal, req, ctx);
    let stopHeartbeat;
    try {
      if (stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.flushHeaders?.();
        const heartbeatFn = chatProtocol.heartbeat || srv.heartbeat;
        stopHeartbeat = heartbeatFn ? heartbeatFn(res, 'responses') : null;
      }
      const sendResponsesResultFn = responseAdapter.sendResponsesResult || srv.sendResponsesResult;
      return await sendResponsesResultFn(res, run, model, id, rb, chat.messages, req.keyScope);
    } catch (e) {
      run.release(false, e.message);
      throw e;
    } finally {
      stopHeartbeat?.();
      run.release();
    }
  }

  // GET /v1/responses/:id
  if (req.method === 'GET' && url.pathname.startsWith('/v1/responses/')) {
    const id = url.pathname.slice('/v1/responses/'.length);
    const respStore = responseAdapter.RESP_STORE || srv.RESP_STORE;
    const hit = respStore?.get(id);
    if (!hit || hit.owner !== req.keyScope) {
      return sendJson(res, 404, {
        error: { message: `response ${id} not found (本反代仅内存保留最近 50 条)`, type: 'invalid_request_error' },
      });
    }
    return sendJson(res, 200, hit.response);
  }

  // POST /v1/messages & POST /v1/messages/count_tokens (Anthropic Messages API)
  if (req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/v1/messages/count_tokens')) {
    const b = body || await parseBody(req);
    const validContent = content => typeof content === 'string' || (Array.isArray(content) &&
      content.every(block => block && typeof block === 'object' && !Array.isArray(block)));
    if (!Array.isArray(b?.messages) || !b.messages.length || b.messages.some(m => !validContent(m?.content))) {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'messages[].content must be a string or an array of blocks' } });
    }
    const messageToChatFn = completionEngine.messageToChat || srv.messageToChat;
    const oai = {
      model: b.model,
      stream: !!b.stream,
      thinking: b.thinking,
      effort: b.output_config?.effort,
      reasoning_effort: b.reasoning_effort,
      system: b.system,
      messages: b.messages.flatMap(messageToChatFn),
      tools: b.tools,
    };
    const mapModelFn = completionEngine.mapModel || srv.mapModel;
    const model = mapModelFn(oai.model);
    if (ctx) ctx.model = model;
    if (req.apiKey && keys && !keys.modelAllowed(req.apiKey, model)) {
      return sendJson(res, 403, { error: { message: `模型 ${model} 不在该 Key 的允许范围内`, type: 'permission_error' } });
    }

    if (url.pathname === '/v1/messages/count_tokens') {
      const prepareContextFn = completionEngine.prepareContext || srv.prepareContext;
      const buildUpstreamBodyFn = completionEngine.buildUpstreamBody || srv.buildUpstreamBody;
      const estimateInputTokensFn = promptRenderer.estimateInputTokens || srv.estimateInputTokens;
      const prepared = buildUpstreamBodyFn(prepareContextFn(oai), model);
      return sendJson(res, 200, { input_tokens: estimateInputTokensFn(prepared) }, { 'x-token-count-source': 'local-estimate' });
    }

    const runCompletionFn = completionEngine.runCompletion ? (...a) => completionEngine.runCompletion(...a) : srv.runCompletion;
    const run = await runCompletionFn(oai, model, g.signal, req, ctx);

    try {
      if (oai.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.flushHeaders?.();

        const send = o => {
          res?._markSseActivity?.();
          return res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
        };
        const heartbeatFn = chatProtocol.heartbeat || srv.heartbeat;
        const stopHeartbeat = heartbeatFn ? heartbeatFn(res, 'anthropic') : () => {};
        const summaryBlocks = new Set();
        let hasNativeTool = false;
        let textBlockIndex = -1;
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
              console.log(`[tool_fallback] (Messages SSE) 拦截到模型输出伪工具/XML指令，已自动转换为 ${extracted.toolCalls.length} 个原生 tool_use 块`);
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

        try {
          for await (let ev of run.events()) {
            if (ev.type === 'ping') {
              send({ type: 'ping' });
              continue;
            }
            if (ev.type === 'message_start') {
              send(ev);
              continue;
            }
            if (ev.type === 'content_block_start') {
              nextBlockIndex = Math.max(nextBlockIndex, ((ev.index ?? 0) + 1));
              const cb = ev.content_block || {};
              if (cb.type === 'tool_use') {
                hasNativeTool = true;
                send(ev);
                continue;
              }
              if (cb.type === 'text') {
                textBlockIndex = ev.index;
                continue;
              }
              send(ev);
              continue;
            }
            if (ev.type === 'content_block_delta') {
              const d = ev.delta || {};
              if (d.type === 'thinking_summary_delta' || d.type === 'thinking_delta') {
                const s = d.type === 'thinking_delta' ? (d.thinking || '') : (d.summary?.summary || '');
                if (s) {
                  send({
                    type: 'content_block_delta', index: ev.index,
                    delta: { type: 'thinking_delta', thinking: (summaryBlocks.has(ev.index) ? '\n' : '') + s }
                  });
                  summaryBlocks.add(ev.index);
                }
                continue;
              }
              if (d.type === 'input_json_delta') {
                hasNativeTool = true;
                send(ev);
                continue;
              }
              if (d.type === 'text_delta') {
                if (hasNativeTool) {
                  send(ev);
                  continue;
                }
                accumulatedText += (d.text || '');
                if (!pseudoToolMode) {
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
                continue;
              }
              send(ev);
              continue;
            }
            if (ev.type === 'content_block_stop') {
              if (ev.index === textBlockIndex && !hasNativeTool) {
                continue;
              }
              send(ev);
              continue;
            }
            if (ev.type === 'message_delta') {
              flushAnthropicFallback();
              if (fallbackToolsEmitted) {
                ev = { ...ev, delta: { ...ev.delta, stop_reason: 'tool_use' } };
              }
              send(ev);
              continue;
            }
            if (ev.type === 'message_stop') {
              flushAnthropicFallback();
              send(ev);
              continue;
            }
            send(ev);
          }
          flushAnthropicFallback();
        } catch (e) {
          run.release(false, e.message);
          // 容错与优雅降级保护：
          // 若属于传输中断/超时等网络层异常 (isTransportOrStall)，且已向下游客户端发送了部分正文或工具，
          // 进行优雅封口 (content_block_stop -> message_delta -> message_stop)，避免客户端 turn 崩溃报错 (如 PT_AT_ERROR)；
          // 若为 UPSTREAM_MESSAGE_CONFLICT 等协议冲突，保持原样抛出以供上层诊断或重试
          const isTransportOrStall = e.code !== 'UPSTREAM_MESSAGE_CONFLICT' && (
            e.code === 'UPSTREAM_TRANSPORT_INTERRUPTED' ||
            e.code === 'UPSTREAM_STALLED' ||
            /stopped making progress|stalled|transport interrupted|fetch failed|timeout|socket|econnreset|other side closed|premature close/i.test(e.message || '')
          );
          if (isTransportOrStall && (sentTextLength > 0 || hasNativeTool || fallbackToolsEmitted || accumulatedText.length > 0)) {
            console.warn(`[gateway] 流式中断 (${e.message})，但已有部分输出 (sent=${sentTextLength}, tools=${hasNativeTool || fallbackToolsEmitted})，执行优雅封口`);
            try {
              flushAnthropicFallback();
              if (textBlockStarted && !textBlockClosed) {
                send({ type: 'content_block_stop', index: textBlockIndex });
                textBlockClosed = true;
              }
              send({ type: 'message_delta', delta: { stop_reason: (hasNativeTool || fallbackToolsEmitted) ? 'tool_use' : 'end_turn', stop_sequence: null } });
              send({ type: 'message_stop' });
            } catch (err) {
              console.error(`[gateway] 优雅封口异常:`, err);
            }
          } else {
            if (!res.destroyed) send({ type: 'error', error: { type: 'api_error', message: e.message } });
          }
        } finally {
          stopHeartbeat();
          res.end();
        }
        return;
      }

      const collectFn = chatProtocol.collect || srv.collect;
      const result = await collectFn(run.events(), run.ctx);
      const content = [];
      if (result.reasoning) {
        content.push({ type: 'thinking', thinking: result.reasoning, signature: '' });
      }
      if (result.text) content.push({ type: 'text', text: result.text });
      for (const tc of result.toolCalls) {
        let input = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = { input: tc.function.arguments };
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      return sendJson(res, 200, {
        id: result.id || 'msg_' + randomUUID(),
        type: 'message',
        role: 'assistant',
        model: result.model || model,
        content,
        stop_reason: result.toolCalls.length ? 'tool_use' : (result.stop || 'end_turn'),
        stop_sequence: null,
        usage: { input_tokens: run.ctx.input_tokens, output_tokens: run.ctx.output_tokens },
      });
    } catch (e) {
      run.release(false, e.message);
      throw e;
    } finally {
      run.release();
    }
  }

  return false;
}

// --------------------------------------------------------------------------------
// 6. dispatchRequest: 统一路由派发入口
// --------------------------------------------------------------------------------
export async function dispatchRequest(req, res, context = {}) {
  const ctx = resolveServerContext(context);
  const sendJson = makeJsonSender(ctx);
  const auth = ctx.services?.auth || ctx;
  const keys = ctx.config?.keys || ctx.KEYS;
  const pool = ctx.services?.pool || ctx.POOL;
  const completionEngine = ctx.engine?.completionEngine || ctx;

  let url;
  try {
    url = new URL(req.url, 'http://gateway.invalid');
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid URL' } });
  }

  const origin = req.headers.origin;
  if ((origin && !['http://' + req.headers.host, 'https://' + req.headers.host].includes(origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
    return sendJson(res, 403, { error: { type: 'permission_error', message: '不允许跨站访问' } });
  }

  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1. 免鉴权基础探活与 WebUI 前端资源
  const isEarlyStatic = (req.method === 'GET' && (url.pathname === '/readyz' || url.pathname === '/v1/version' || url.pathname === '/' || url.pathname === '/ui' || url.pathname === '/ui/'))
    || (req.method === 'GET' && (url.pathname.startsWith('/ui/') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css')));
  if (isEarlyStatic) {
    const handled = await handleStatic(req, res, url, ctx);
    if (handled) return;
  }

  // 2. 路由前缀别名转换 (如 DSH 客户端追加的 /v1/v1/messages)
  const messagesPath = req.method === 'POST' && MESSAGES_POST_ALIASES.get(url.pathname);
  if (messagesPath) url.pathname = messagesPath;

  const inference = INFERENCE_ROUTES.has(url.pathname) || /^\/v1\/responses\/[^/]+$/.test(url.pathname);
  const authenticateFn = auth.authenticate || ctx.authenticate || (() => ({ key: {} }));
  const authRes = authenticateFn(req, !inference);
  if (authRes.error) return sendJson(res, authRes.error.status, { error: authRes.error });

  const isLoopback = auth.isLoopbackReq || ctx.isLoopbackReq;
  if (!inference && isLoopback && !isLoopback(req) && process.env.ALLOW_REMOTE_ADMIN !== '1') {
    return sendJson(res, 403, { error: { message: '远程管理未启用', type: 'permission_error' } });
  }
  req.apiKey = authRes.key;

  // 3. 需管理员鉴权的版本控制端点
  if (url.pathname === '/v1/version/check' || url.pathname === '/v1/version/install') {
    return await handleStatic(req, res, url, ctx);
  }

  const legacyKeyObj = auth.LEGACY_KEY_OBJ || ctx.LEGACY_KEY_OBJ;
  const legacyKey = auth.LEGACY_KEY ?? ctx.LEGACY_KEY ?? '';
  req.keyScope = createHash('sha256').update(authRes.key === legacyKeyObj ? legacyKey : (authRes.key?.key || '')).digest('hex');

  // 4. API Keys 管理路由
  if (url.pathname === '/v1/keys' || url.pathname.startsWith('/v1/keys/')) {
    return await handleAdmin(req, res, url, null, ctx);
  }

  if (inference && req.apiKey !== legacyKeyObj && keys?.noteRequest) {
    const getReqIpFn = auth.getReqIp || ctx.getReqIp;
    keys.noteRequest(req.apiKey, getReqIpFn ? getReqIpFn(req) : '');
  }

  const clientGoneFn = auth.onClientGone || ctx.onClientGone || onClientGone;
  const gone = clientGoneFn(res);
  const api = req.method === 'POST' && COMPLETION_APIS.get(url.pathname);
  const usage = api ? { api, startedAt: Date.now(), attempts: 0, input_tokens: 0, output_tokens: 0 } : null;

  try {
    // 5. 需鉴权的基础信息探活
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return await handleStatic(req, res, url, ctx);
    }

    // 6. 网页搜索与抓取端点
    const isSearchPath = url.pathname === '/v1/tools/search' || url.pathname === '/tools/search'
      || url.pathname === '/v1/search' || url.pathname === '/search';
    const isFetchPath = url.pathname === '/v1/tools/fetch' || url.pathname === '/tools/fetch'
      || url.pathname === '/v1/fetch' || url.pathname === '/fetch';
    if (isSearchPath || isFetchPath) {
      return await handleTools(req, res, url, null, ctx, gone.signal);
    }

    // 7. 账号管理、KYC、过CF验证与调度池管理
    const isAccountsPath = url.pathname === '/v1/accounts' || url.pathname.startsWith('/v1/accounts/') || url.pathname === '/v1/kyc';
    const isCfVerifyPath = url.pathname.startsWith('/v1/cfverify/');
    const isPoolPath = url.pathname === '/v1/pool';
    if (isAccountsPath || isCfVerifyPath || isPoolPath) {
      return await handleAdmin(req, res, url, null, ctx);
    }

    // 8. 审计与用量流水
    const isLogsPath = url.pathname === '/v1/operations' || url.pathname === '/v1/operations/clear'
      || url.pathname === '/v1/usage' || url.pathname === '/v1/usage/logs';
    if (isLogsPath) {
      return await handleLogs(req, res, url, ctx);
    }

    // 9. 核心模型与推理端点
    const isInference = (req.method === 'GET' && url.pathname === '/v1/models')
      || (req.method === 'POST' && url.pathname === '/v1/chat/completions')
      || (req.method === 'POST' && url.pathname === '/v1/responses')
      || (req.method === 'GET' && url.pathname.startsWith('/v1/responses/'))
      || (req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/v1/messages/count_tokens'));

    if (isInference) {
      return await handleInference(req, res, url, null, usage, ctx, gone);
    }

    return sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  } catch (e) {
    const errorStatusFn = completionEngine?.completionErrorStatus || ctx.completionErrorStatus || (() => 500);
    if (usage) {
      usage.status ??= errorStatusFn(e);
      usage.error = e.message;
    }
    if (e?.name === 'AbortError') {
      console.log('[req] client disconnected -> upstream aborted');
      return;
    }
    if (res.headersSent || res.destroyed) {
      console.warn(`[req] ${String(e?.message || e).slice(0, 200)}（连接已断，跳过回写）`);
      return;
    }
    const msg = String(e?.message || e);
    const kind = e.kind;
    const code = errorStatusFn(e);

    let hint;
    let retryAfter;
    if (code === 429) {
      const m = /resetsAt\\?":\s*(\d+)/.exec(msg);
      const resetsAt = m ? +m[1] : null;
      if (kind === 'concurrency' || /resetsAt\\?":\s*null/.test(msg)) {
        hint = '账号短期并发/速率窗口已满（不是配额用尽），通常 1 分钟内自动恢复；代理已对该账号退避并换号，稍后重试即可';
        retryAfter = 2;
      } else if (/no eligible account/i.test(msg)) {
        const st = pool?.status ? pool.status() : {};
        const nextAt = st.next_restore_at;
        const exh = st.exhausted_pool || 0;
        hint = exh
          ? `有效池已空：${exh} 个账号因配额耗尽进了 429 耗尽池`
            + (nextAt ? `，最早 ${new Date(nextAt).toLocaleString('zh-CN')} 自动回池` : '')
            + '；其余账号在冷却中。可加账号或等恢复'
          : '所有账号都不可调度（冷却中/403 被自动禁用/低于额度阈值），可查看 GET /v1/accounts、加账号或等冷却结束';
        retryAfter = 2;
      } else if (resetsAt && resetsAt * 1000 > Date.now()) {
        hint = `账号 5 小时配额已用尽，预计 ${new Date(resetsAt * 1000).toLocaleTimeString('zh-CN')} 恢复；可加账号或等重置`;
        retryAfter = 2;
      } else {
        hint = '账号冷却中（配额用尽），可加账号或稍后重试';
        retryAfter = 2;
      }
    } else if (code === 401) {
      hint = '所有账号登录态失效，请在账号池中更新已授权的会话'
        + '（401/403 连续 3 次的账号会被自动禁用 60 分钟，PATCH /v1/accounts/{id} {"enabled":true} 可立即恢复）';
    }

    return sendJson(res, code, {
      error: {
        message: msg,
        type: code === 401 ? 'authentication_error' : code === 429 ? 'rate_limit_error' : 'proxy_error',
        hint,
      },
    }, retryAfter ? { 'retry-after': String(retryAfter) } : undefined);
  } finally {
    if (usage) {
      const status = gone.signal.aborted ? 499 : (usage.status ?? res.statusCode);
      const error = status === 499 ? 'client disconnected' : usage.error || (status >= 400 ? http.STATUS_CODES[status] : '');
      const recordCompletionFn = completionEngine?.recordCompletion || ctx.recordCompletion;
      if (recordCompletionFn) recordCompletionFn(usage, status, error);
    }
  }
}

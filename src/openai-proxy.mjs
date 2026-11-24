/**
 * openai-proxy.mjs —— 高内聚应用装配器与服务引导入口 (Composition Root)
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AccountPool, discoverOrg, DEFAULT_UA, DEFAULT_BASE } from './accounts.mjs';
import { createConfigStore, publicSettings } from './config.mjs';
import { ROOT, DATA, dataFile } from './paths.mjs';
import { probeQuota } from './quota-probe.mjs';
import { checkKyc } from './kyc.mjs';
import { createUsageLog } from './usage-log.mjs';
import { logOperation, queryOperations, getOperationStats, clearOperations } from './operation-log.mjs';
import { createCfVerifyManager, openClaudeWebBrowser } from './cf-verify.mjs';
import { createUpdateService, versionAsset, withVersionPanel } from './update-service.mjs';
import { VERSION } from './github-releases.mjs';
import { createCompletionEngine, setDefaultEngine } from './completion-engine.mjs';
import { dispatchRequest, createServerContext, maskAccount, parseImportLines, onClientGone } from './gateway-routes.mjs';
import { isLoopbackReq, getReqIp, validateHost, safeCompareKey, isLoopbackIp, isTrustProxyEnabled } from './http-auth.mjs';
import * as promptRenderer from './prompt-renderer.mjs';
import * as pseudoTools from './pseudo-tools.mjs';
import * as externalTools from './external-tools.mjs';
import * as responseAdapter from './responses-api.mjs';
import * as chatProtocol from './chat-protocol.mjs';
import * as claudeWebClient from './claude-web-client.mjs';

// 向后兼容模块导出
export { extractPseudoToolCalls, findToolCallTrigger, unescapeXml, unescapeArg } from './pseudo-tools.mjs';
export { cleanTerminalNoise, escapePromptMarkers, renderPrompt, textOf, pickEffort, countTokens, estimateInputTokens } from './prompt-renderer.mjs';
export { isLoopbackReq, getReqIp, validateHost, safeCompareKey, isLoopbackIp, isTrustProxyEnabled } from './http-auth.mjs';
export { decodeHtmlEntities, searchDuckDuckGo, fetchWebContent } from './external-tools.mjs';
export { newRespId, newItemId, rememberResponse, getResponse, RESP_STORE, responsesInputToMessages, responsesToChat, responsesUsage, responseStatus, respShell, sendResponsesResult, normalizeTool } from './responses-api.mjs';
export { mapStopReason, newChatId, chatUsage, resolveFinish, ant2oaiText, collect, heartbeat, streamToClient } from './chat-protocol.mjs';
export { webHeaders, isChallenge, parseResetsAt, parseLimitReason, classify, noteChallenge, cfStormActive, clientGoneError, isSocketResetError, upstreamError, upstreamFetch, createConversation, callCompletion, clearChallengeEvents, ClaudeWebClient } from './claude-web-client.mjs';
export { COMPLETION_APIS, MESSAGES_POST_ALIASES, INFERENCE_ROUTES, handleInference, handleAdmin, handleLogs, handleTools, handleStatic, dispatchRequest, maskAccount, parseImportLines, json, readBody, ServerContext, createServerContext } from './gateway-routes.mjs';
export {
  CompletionEngine,
  createCompletionEngine,
  setDefaultEngine,
  getDefaultEngine,
  runCompletion,
  acquireAccount,
  attachStreamRecovery,
  mapModel,
  mapTools,
  prepareContext,
  buildUpstreamBody,
  normalizeSse,
  hasGeneratedOutput,
  isThinkingOutput,
  completionErrorStatus,
  recordCompletion,
  messageToChat,
  modelList,
} from './completion-engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM_FILE = dataFile('upstream.json', process.env.UPSTREAM_FILE);
const ACCOUNTS_FILE = dataFile('accounts.json', process.env.ACCOUNTS_FILE);
const CONFIG_FILE = dataFile('config.json', process.env.CONFIG_FILE);

const KEYS = createConfigStore(CONFIG_FILE);
KEYS.load();
const _srv = KEYS.serverConfig();
const PORT = +(process.env.PORT || _srv.port || 8787), HOST = process.env.HOST || _srv.host || '127.0.0.1';
const isLanExposed = HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1';
const LEGACY_KEY = process.env.LOCAL_API_KEY || '', TZ = process.env.TZ || 'Asia/Shanghai';

if (isLanExposed && KEYS.keyCount() === 0) {
  console.error(`[openai-proxy] 拒绝启动：host=${HOST} 表示对外开放，但 config.json 里没有任何 API Key`);
  process.exit(1);
}

function loadUpstream() {
  try { return JSON.parse(fs.readFileSync(UPSTREAM_FILE, 'utf8')); } catch { return {}; }
}
let UP = loadUpstream();

const LEGACY_KEY_OBJ = {
  id: '_legacy', name: 'LOCAL_API_KEY(env)', enabled: true, expiresAt: null,
  models: [], rpm: 0, tpm: 0, ipWhitelist: [],
  quota: { limitTokens: 0, usedTokens: 0, limitRequests: 0, usedRequests: 0 },
};

function authenticate(req, management = false) {
  const h = req.headers.authorization || req.headers['x-api-key'] || '';
  const raw = String(h).replace(/^Bearer\s+/i, '').trim();
  if (LEGACY_KEY && safeCompareKey(raw, LEGACY_KEY)) {
    return management ? { error: { status: 403, message: '调用 Key 无管理权限', type: 'permission_error' } } : { key: LEGACY_KEY_OBJ };
  }
  if (KEYS.keyCount() === 0) {
    return { error: { status: 401, message: 'no api key configured', type: 'authentication_error' } };
  }
  return KEYS.identify(raw, getReqIp(req), { management });
}

const POOL = new AccountPool(ACCOUNTS_FILE, { strategy: process.env.ACCOUNT_STRATEGY || '' });
const USAGE = createUsageLog({ dir: process.env.USAGE_DIR || path.join(DATA, 'usage') });
const KYC_CACHE = new Map();

const CFVERIFY = createCfVerifyManager({
  webUrl: () => (UP.web_base || 'https://claude.ai') + '/',
  timeoutMs: +(process.env.CFVERIFY_TIMEOUT_MS || 5 * 60 * 1000),
  onCapture: ({ accountId, cookie, ua, org }) => {
    const prev = POOL.get(accountId);
    if (!prev) return null;
    const account = POOL.set(accountId, { cookie, ua, ...(org ? { org } : {}), ...(prev.enabled !== false ? { enabled: true } : {}), cooldownUntil: 0, clearError: true });
    logOperation({ category: '额度风控', action: '过CF成功', target: account?.label || accountId, status: 'success', detail: '新 cf_clearance 与 UA 已更新入池，冷却已解除', ip: '127.0.0.1' });
    return account ? { id: account.id, label: account.label, org: account.org } : null;
  },
});

let acctTokensCache = { at: 0, map: new Map() };
function accountTokenStats() {
  const now = Date.now();
  if (acctTokensCache.map.size && now - acctTokensCache.at < 30000) return acctTokensCache.map;
  try {
    const u = USAGE.summary('all');
    acctTokensCache = { at: now, map: new Map((u.by_account || []).map(x => [x.account_id, x])) };
  } catch {}
  return acctTokensCache.map;
}

const codeRoot = path.resolve(HERE, '..');
const UI_FILE = [path.join(codeRoot, 'web', 'webui.html'), path.join(ROOT, 'web', 'webui.html'), path.join(ROOT, 'webui.html'), path.join(HERE, 'webui.html')].find(fs.existsSync) || path.join(ROOT, 'web', 'webui.html');
let uiCache = null;
function uiHtml() {
  try {
    const m = fs.statSync(UI_FILE).mtimeMs;
    if (!uiCache || uiCache.mtime !== m) uiCache = { mtime: m, html: fs.readFileSync(UI_FILE, 'utf8') };
    return uiCache.html;
  } catch { return null; }
}

const updates = createUpdateService();

export const completionEngine = createCompletionEngine({
  pool: POOL, usage: USAGE, keys: KEYS, legacyKeyObj: LEGACY_KEY_OBJ, tz: TZ, getUpstream: () => UP,
});
setDefaultEngine(completionEngine);

export const serverContext = createServerContext({
  services: {
    auth: { authenticate, isLoopbackReq, getReqIp, validateHost, safeCompareKey, isLoopbackIp, isTrustProxyEnabled, onClientGone, LEGACY_KEY, LEGACY_KEY_OBJ },
    accounts: { pool: POOL, maskAccount, parseImportLines, accountTokenStats, discoverOrg, checkKyc, probeQuota },
    pool: POOL, kyc: { cache: KYC_CACHE, checkKyc, discoverOrg },
    logs: { USAGE, logOperation, queryOperations, getOperationStats, clearOperations },
    updates: { ...updates, status: () => updates.status(), check: () => updates.check(), install: () => updates.install(), versionAsset, withVersionPanel },
    tools: { searchDuckDuckGo: externalTools.searchDuckDuckGo, fetchWebContent: externalTools.fetchWebContent, decodeHtmlEntities: externalTools.decodeHtmlEntities },
    verify: { cfVerify: CFVERIFY, cfStormActive: claudeWebClient.cfStormActive, clearChallengeEvents: claudeWebClient.clearChallengeEvents, openClaudeWebBrowser },
  },
  engine: { completionEngine, promptRenderer, responseAdapter, chatProtocol },
  config: { keys: KEYS, server: { port: PORT, host: HOST, tz: TZ, uiHtml }, publicSettings, isLanExposed, configFile: CONFIG_FILE, get upstream() { return UP; }, defaultBase: DEFAULT_BASE, defaultUa: DEFAULT_UA },
});

export async function handleRequest(req, res) {
  return dispatchRequest(req, res, serverContext);
}

export const server = http.createServer((req, res) => {
  const control = req.method === 'GET' && ['/readyz', '/v1/version', '/ui/version-panel.js', '/ui/version-panel.css'].includes(req.url);
  const release = control ? () => {} : updates.enter();
  if (!release) {
    res.setHeader('Retry-After', '2');
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: { message: '网关正在切换版本，请稍后重试' } }));
  }
  let handled = false, delivered = false;
  const complete = () => { delivered = true; if (handled) release(); };
  res.once('finish', complete); res.once('close', complete);
  handleRequest(req, res).catch(e => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) return res.end();
    const status = e.status >= 400 && e.status < 500 ? e.status : 500;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { type: 'request_error', message: status < 500 ? e.message : 'Request failed' } }));
  }).finally(() => { handled = true; if (delivered) release(); });
});

setInterval(() => { UP = loadUpstream(); }, 5000).unref();
setInterval(() => {
  POOL.autoRestoreDisabled();
  if (POOL.reloadIfChanged()) console.log(`[pool] accounts.json reloaded: ${POOL.status().total} accounts`);
  POOL.restoreExhausted();
}, 2000).unref();

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  setInterval(() => { if (KEYS.reloadIfChanged()) console.log(`[config] config.json reloaded: keys=${KEYS.keyCount()}`); }, 3000).unref();
  if (process.send) {
    process.on('message', msg => {
      if (msg?.type === 'drain') updates.drain(() => { updates.close(); server.close(() => process.exit(0)); server.closeIdleConnections(); });
      if (msg?.type === 'refused') updates.refuse();
    });
    process.on('disconnect', () => process.exit(0));
  }
  server.listen(PORT, HOST, () => {
    updates.start();
    process.send?.({ type: 'listening', address: server.address().address, port: server.address().port, version: VERSION });
    const st = POOL.status();
    console.log(`[openai-proxy] http://127.0.0.1:${server.address().port}/v1`);
    if (isLanExposed) {
      const nets = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
      for (const ip of nets) console.warn(`[openai-proxy]   http://${ip}:${PORT}/v1`);
    }
    console.log(`[openai-proxy] pool strategy=${st.strategy} accounts=${st.total} enabled=${st.enabled} eligible=${st.eligible_now}`);
  });
}

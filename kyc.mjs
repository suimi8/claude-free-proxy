/**
 * kyc.mjs —— Claude 账号 KYC 状态查询（只读，不消耗对话额度）
 *
 * 查询思路与分类逻辑移植自 https://github.com/VallierDev/claude-kyc-checker （MIT）：
 *   1. GET {base}/api/organizations            -> 组织列表（uuid / name / capabilities）
 *   2. GET {base}/api/organizations/{uuid}/kyc_status  -> 该组织的 KYC 状态
 *
 * 与 Chrome 扩展版的差异：本模块跑在反代服务端，直接用账号池里的
 * sessionKey/cookie 发请求（webHeaders 同款认证），不需要浏览器页面登录态。
 * 两个接口都是只读 GET —— 不发消息、不消耗额度。
 *
 * 状态含义（接口 status 字段）：
 *   not_required  无需 KYC，可直接升级          (ok)
 *   pending       需要做 KYC 或正在审核中        (warn)
 *   verified/approved  KYC 已通过               (ok)
 *   denied        KYC 被拒绝，无法升级          (danger)
 *
 * vendor_inquiry_url 按域名分类：
 *   *.withpersona.com     订阅 KYC（Persona），常规验证        (ok)
 *   portal.anthropic.com  门户 KYC，公开教程称有封号风险        (danger)
 *   其他                   未知链接，谨慎操作                   (warn)
 */

const STATUS_MAP = {
  not_required: { key: 'not_required', label: '无需 KYC', tone: 'ok', explanation: '升级无需身份验证，可直接升级。' },
  pending: { key: 'pending', label: '审核中', tone: 'warn', explanation: '需要完成 KYC，或正在审核中。' },
  verified: { key: 'verified', label: '已通过', tone: 'ok', explanation: 'KYC 已通过。' },
  approved: { key: 'approved', label: '已通过', tone: 'ok', explanation: 'KYC 已通过（旧版状态 approved）。' },
  denied: { key: 'denied', label: '已拒绝', tone: 'danger', explanation: 'KYC 被拒绝，无法升级。' },
};

const PLAN_CAP_RE = /^(claude_|raven|pro|max|team|enterprise|billing)/i;
const REGION_RE = /region|unavailable in|not available|country|geographic|unsupported (region|country)|access from your|不是可用地区|当前地区/;

/** status 字段 -> 展示信息（未知值原样展示，标记 neutral） */
export function classifyStatus(status) {
  if (status == null || String(status).trim() === '') {
    return { key: 'unknown', raw: status == null ? null : String(status), label: '未知', tone: 'neutral', explanation: '接口未返回 status 字段。' };
  }
  const raw = String(status);
  const mapped = STATUS_MAP[raw];
  if (mapped) return { ...mapped, raw };
  return { key: 'other', raw, label: raw, tone: 'neutral', explanation: '未知状态，请以接口返回值为准。' };
}

/** vendor_inquiry_url -> 链接分类（域名判定，不做网络访问） */
export function classifyInquiryUrl(url) {
  if (url == null || String(url).trim() === '') {
    return { kind: 'none', label: '无验证链接', tone: 'neutral', warning: false, explanation: '当前没有 vendor_inquiry_url。', url: null };
  }
  const raw = String(url).trim();
  let host = '';
  try { host = new URL(raw).hostname.toLowerCase(); } catch {
    return { kind: 'invalid', label: '链接无效', tone: 'warn', warning: true, explanation: 'vendor_inquiry_url 不是有效的 URL。', url: raw };
  }
  if (host === 'withpersona.com' || host.endsWith('.withpersona.com')) {
    return { kind: 'subscription', label: '订阅 KYC（Persona）', tone: 'ok', warning: false, explanation: '这是常规的订阅 KYC 验证链接（Persona），一般可以正常完成。', url: raw };
  }
  if (host === 'portal.anthropic.com' || host.endsWith('.portal.anthropic.com')) {
    return { kind: 'portal', label: '门户 KYC', tone: 'danger', warning: true, explanation: '这是门户 KYC（portal.anthropic.com）。公开教程称此类验证有封号风险，建议不要进行。', url: raw };
  }
  return { kind: 'unknown', label: '未知类型链接', tone: 'warn', warning: true, explanation: '未能识别该验证链接来源，请谨慎操作。', url: raw };
}

/** 从组织对象提取方案标签（capabilities 里匹配 claude_/raven/pro/max 等） */
export function extractPlan(org) {
  const source = org && typeof org === 'object' ? org : {};
  const caps = Array.isArray(source.capabilities) ? source.capabilities.map(String) : [];
  const planLike = caps.filter(c => PLAN_CAP_RE.test(c));
  const extras = [];
  for (const key of ['billing_type', 'rate_limit_tier', 'plan', 'organization_type']) {
    if (source[key]) extras.push(String(source[key]));
  }
  const labels = planLike.length ? planLike : extras;
  return { capabilities: caps, planLabels: [...new Set(labels)] };
}

/** 组织列表响应归一化（数组 / {data} / {organizations} / 单对象） */
export function normalizeOrganizationsPayload(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.organizations)) return data.organizations;
  if (data && data.uuid) return [data];
  return [];
}

function looksLikeRegionBlock(text) {
  return REGION_RE.test(String(text || '').toLowerCase());
}

/** HTTP 失败 -> { code, message }（permission/auth/region/challenge/non_json/http） */
export function describeHttpError(status, isJson, textPreview, data) {
  // 上游应用层明确拒绝（实测：Individual Org 的 kyc_status 返回
  // {"error":{"type":"permission_error"},"code":"permission_denied"}）——
  // 这是「该组织不让查」，不是登录问题。原版扩展会把 401/403 一律误报成
  // 「请先登录」，这里读响应体把真实原因区分出来。
  if (data && typeof data === 'object') {
    const err = data.error && typeof data.error === 'object' ? data.error : data;
    if (err.type === 'permission_error' || data.code === 'permission_denied') {
      return { code: 'permission', message: '该组织无查询权限（上游 permission_denied，非登录问题）' };
    }
  }
  if (looksLikeRegionBlock(textPreview)) {
    return { code: 'region', message: '当前地区可能无法使用 claude.ai，请求被拒绝。' };
  }
  if (status === 401) return { code: 'auth', message: '登录态失效（HTTP 401），请重新登录该账号' };
  if (status === 403) {
    // 403 + Cloudflare 挑战页（HTML）才是 cookie 失效的典型形态
    if (/Just a moment|cf-browser-verification|challenge-platform/i.test(String(textPreview || ''))) {
      return { code: 'challenge', message: 'Cloudflare 挑战（HTTP 403），cookie 可能过期，稍后重试' };
    }
    return { code: 'auth', message: '登录态失效（HTTP 403），请重新登录该账号' };
  }
  if (!isJson) return { code: 'non_json', message: '接口返回了非 JSON 内容（HTTP ' + status + '）。' };
  return { code: 'http', message: '请求失败（HTTP ' + status + '）。' };
}

export function shortenUuid(uuid) {
  const raw = String(uuid || '');
  if (raw.length <= 16) return raw || '—';
  return raw.slice(0, 8) + '…' + raw.slice(-4);
}

async function fetchJson(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
    const text = await res.text();
    let data = null, isJson = false;
    try { data = JSON.parse(text); isJson = true; } catch { /* noop */ }
    return { ok: res.ok, status: res.status, isJson, data, textPreview: text.slice(0, 240) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查一个账号的 KYC 状态。
 * @param {{ base?: string, headers: Record<string,string>, timeoutMs?: number }} opts
 *   base   上游地址（默认 https://claude.ai）
 *   headers 认证头（cookie/ua/origin，与 completion 请求同款）
 * @returns {Promise<object>} 成功 { ok:true, fetchedAt, orgs:[...] }
 *   失败 { ok:false, error:{ code, message } }
 */
export async function checkKyc({ base, headers, timeoutMs = 15000 }) {
  const root = (base || 'https://claude.ai').replace(/\/+$/, '');
  let orgsRes;
  try {
    orgsRes = await fetchJson(`${root}/api/organizations`, headers, timeoutMs);
  } catch (e) {
    return { ok: false, error: { code: 'network', message: `网络错误：${e?.message || e}` } };
  }
  if (!orgsRes.ok || !orgsRes.isJson) {
    return { ok: false, error: describeHttpError(orgsRes.status, orgsRes.isJson, orgsRes.textPreview, orgsRes.data) };
  }
  const orgs = normalizeOrganizationsPayload(orgsRes.data);
  const items = [];
  for (const org of orgs) {
    const uuid = org && (org.uuid || org.id);
    if (!uuid) continue;
    const plan = extractPlan(org);
    let kycRes;
    try {
      kycRes = await fetchJson(`${root}/api/organizations/${encodeURIComponent(uuid)}/kyc_status`, headers, timeoutMs);
    } catch (e) {
      items.push({ uuid, name: org.name || '未命名组织', planLabels: plan.planLabels,
        error: { code: 'network', message: `网络错误：${e?.message || e}` } });
      continue;
    }
    if (!kycRes.ok || !kycRes.isJson || !kycRes.data) {
      items.push({ uuid, name: org.name || '未命名组织', planLabels: plan.planLabels,
        error: describeHttpError(kycRes.status, kycRes.isJson, kycRes.textPreview, kycRes.data) });
      continue;
    }
    const kyc = kycRes.data;
    items.push({
      uuid,
      name: org.name || '未命名组织',
      planLabels: plan.planLabels,
      status: classifyStatus(kyc.status),
      link: classifyInquiryUrl(kyc.vendor_inquiry_url),
      check_kind: kyc.check_kind ?? null,
      created_at: kyc.created_at ?? null,
      updated_at: kyc.updated_at ?? null,
      completed_at: kyc.completed_at ?? null,
    });
  }
  return { ok: true, fetchedAt: new Date().toISOString(), orgs: items };
}

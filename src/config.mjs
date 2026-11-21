/**
 * config.mjs —— 配置文件（config.json）读写 + 多 API Key 鉴权 / 限额中心
 *
 * 设计要点：
 *   1. 端口、监听地址、所有 API Key 全部来自 config.json，代码里不内置任何密钥。
 *   2. 首次启动若没有 config.json，自动生成一份并分别生成调用和管理 Key（只写入私有配置）。
 *   3. 每个 key 独立限制：额度（tokens / 请求数）、到期时间、模型范围、RPM、TPM、IP 白名单。
 *   4. 用量在内存累加，debounce 落盘，重启不丢；运行时窗口（_win）不落盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function generateKey() {
  return 'sk-' + randomBytes(18).toString('hex');
}

export function generateId() {
  return 'k_' + randomBytes(4).toString('hex');
}

// Write next to the destination so readers see either the old complete JSON or the new one.
export function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const tmp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, {force:true}); }
}

/** 默认配置（仅新文件才生成 Key） */
function blankConfig() {
  return {
    version: 1,
    server: { port: 8787, host: '127.0.0.1' },
    // 单价仅用于「约合 ¥」展示，0 表示不展示金额
    settings: { pricePerMillionTokens: 0 },
    keys: [],
  };
}

/** 单个 key 的默认字段 */
function normalizeKey(k) {
  const quota = k.quota || {};
  return {
    id: k.id || generateId(),
    name: k.name || '未命名',
    key: k.key || generateKey(),
    role: k.role === 'admin' ? 'admin' : 'inference',
    enabled: k.enabled !== false,
    createdAt: k.createdAt || Date.now(),
    expiresAt: k.expiresAt ?? null,      // null = 永不过期；数字 = 毫秒时间戳
    models: Array.isArray(k.models) ? k.models : [],   // 空数组 = 全部模型
    rpm: +k.rpm || 0,                    // 0 = 不限
    tpm: +k.tpm || 0,                    // 0 = 不限
    ipWhitelist: Array.isArray(k.ipWhitelist) ? k.ipWhitelist : [],
    quota: {
      limitTokens: +quota.limitTokens || 0,       // 0 = 不限
      usedTokens: +quota.usedTokens || 0,
      limitRequests: +quota.limitRequests || 0,   // 0 = 不限
      usedRequests: +quota.usedRequests || 0,
    },
    lastUsedAt: k.lastUsedAt || null,
    lastIp: k.lastIp || null,
  };
}

const WINDOW_MS = 60 * 1000;

export function createConfigStore(file) {
  let data = null;
  let mtime = 0;
  let saveTimer = null;
  let created = false;

  /** 运行时窗口（RPM/TPM 滑动窗口），按 key.id 存，不落盘 */
  const windows = new Map();

  function readDisk() {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const cfg = { ...blankConfig(), ...parsed };
    cfg.server = { ...blankConfig().server, ...(parsed.server || {}) };
    cfg.settings = { ...blankConfig().settings, ...(parsed.settings || {}) };
    cfg.keys = (Array.isArray(parsed.keys) ? parsed.keys : []).map(normalizeKey);
    return cfg;
  }

  function load() {
    try {
      const st = fs.statSync(file);
      mtime = st.mtimeMs;
      data = readDisk();
      return data;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      data = blankConfig();
      data.keys = [normalizeKey({ name: '调用 Key' }), normalizeKey({ name: '管理 Key', role: 'admin' })];
      created = true;
      writeNow();
      return data;
    }
  }

  /** 落盘：剔除运行时字段（_ 开头） */
  function writeNow() {
    if (!data) return;

    // 关键：写盘前先看磁盘是否被外部改过（用户手工编辑 config.json）。
    // 否则内存里的旧数据会把用户的修改整片覆盖掉——用量是 debounce 写的，
    // 用户改完文件后 1 秒内一次用量落盘就能把改动抹平。
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs !== mtime) {
        const fresh = readDisk();
        // 以磁盘为准，但用量取两者较大值，避免丢掉刚累计的计数
        for (const nk of fresh.keys) {
          const old = data.keys.find(o => o.id === nk.id);
          if (old) {
            nk.quota.usedTokens = Math.max(nk.quota.usedTokens, old.quota.usedTokens);
            nk.quota.usedRequests = Math.max(nk.quota.usedRequests, old.quota.usedRequests);
          }
        }
        data = fresh;
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }

    const out = {
      version: data.version,
      server: data.server,
      settings: data.settings,
      keys: data.keys.map(k => {
        const clean = {};
        for (const [k2, v] of Object.entries(k)) if (!k2.startsWith('_')) clean[k2] = v;
        return clean;
      }),
    };
    writePrivateJson(file, out);
    try { mtime = fs.statSync(file).mtimeMs; } catch (e) { /* ignore */ }
  }

  /** 用量变化很频繁，合并成 1 秒一次写盘 */
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { writeNow(); } catch (e) { console.warn('[config] 保存失败:', e.code || e.name); }
    }, 1000);
    if (saveTimer.unref) saveTimer.unref();
  }

  /** 外部编辑 config.json 时热加载（保留内存里的用量计数，避免被旧文件覆盖） */
  function reloadIfChanged() {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs === mtime) return false;
      const fresh = readDisk();
      // 用量取两者较大值：内存里通常更新
      for (const nk of fresh.keys) {
        const old = data.keys.find(o => o.id === nk.id);
        if (old) {
          nk.quota.usedTokens = Math.max(nk.quota.usedTokens, old.quota.usedTokens);
          nk.quota.usedRequests = Math.max(nk.quota.usedRequests, old.quota.usedRequests);
        }
      }
      data = fresh;
      mtime = st.mtimeMs;
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------- 窗口 / 限额
  function winOf(k) {
    const now = Date.now();
    let w = windows.get(k.id);
    if (!w) { w = []; windows.set(k.id, w); }
    while (w.length && now - w[0].ts > WINDOW_MS) w.shift();
    return w;
  }

  function windowStats(k) {
    const w = winOf(k);
    return { rpm: w.length, tpm: w.reduce((s, e) => s + (e.tokens || 0), 0) };
  }

  /** 请求前检查：返回 { key } 或 { error: {status, message, type, hint} } */
  function identify(rawKey, ip, { management = false } = {}) {
    if (!data) load();
    const key = String(rawKey || '').replace(/^Bearer\s+/i, '').trim();
    if (!key) {
      return { error: { status: 401, message: 'missing api key', type: 'authentication_error', hint: '请在请求头带 Authorization: Bearer <key>' } };
    }
    const k = data.keys.find(x => x.key === key);
    if (!k) {
      return { error: { status: 401, message: 'invalid api key', type: 'authentication_error', hint: '这个 key 不在 config.json 里' } };
    }
    if (k.enabled === false) {
      return { error: { status: 403, message: 'api key disabled', type: 'permission_error', hint: `key「${k.name}」已被停用` } };
    }
    if (k.expiresAt && Date.now() > k.expiresAt) {
      return { error: { status: 403, message: 'api key expired', type: 'permission_error', hint: `key「${k.name}」已于 ${new Date(k.expiresAt).toLocaleString()} 到期` } };
    }
    if (k.ipWhitelist.length) {
      const bare = String(ip || '').replace(/^::ffff:/, '');
      if (!k.ipWhitelist.includes(bare)) {
        return { error: { status: 403, message: 'ip not allowed', type: 'permission_error', hint: `来源 IP ${bare} 不在白名单` } };
      }
    }
    if (management) {
      return k.role === 'admin' ? { key: k } : { error: { status: 403, type: 'permission_error', message: '需要独立的管理员 Key' } };
    }
    const q = k.quota;
    if (q.limitRequests > 0 && q.usedRequests >= q.limitRequests) {
      return { error: { status: 403, message: 'quota exceeded', type: 'quota_error', hint: `key「${k.name}」请求数已达上限 ${q.limitRequests}` } };
    }
    if (q.limitTokens > 0 && q.usedTokens >= q.limitTokens) {
      return { error: { status: 403, message: 'quota exceeded', type: 'quota_error', hint: `key「${k.name}」额度已用尽（${q.usedTokens}/${q.limitTokens} tokens）` } };
    }
    const st = windowStats(k);
    if (k.rpm > 0 && st.rpm >= k.rpm) {
      return { error: { status: 429, message: 'rpm limit exceeded', type: 'rate_limit_error', hint: `key「${k.name}」每分钟最多 ${k.rpm} 次请求` } };
    }
    if (k.tpm > 0 && st.tpm >= k.tpm) {
      return { error: { status: 429, message: 'tpm limit exceeded', type: 'rate_limit_error', hint: `key「${k.name}」每分钟最多 ${k.tpm} tokens` } };
    }
    return { key: k };
  }

  /** 模型是否允许 */
  function modelAllowed(k, model) {
    if (!k || !k.models || !k.models.length) return true;
    return k.models.includes(model);
  }

  /** 请求开始：计入窗口与请求数 */
  function noteRequest(k, ip) {
    if (!k) return;
    const w = winOf(k);
    w.push({ ts: Date.now(), tokens: 0 });
    k.quota.usedRequests++;
    k.lastUsedAt = Date.now();
    if (ip) k.lastIp = String(ip).replace(/^::ffff:/, '');
    scheduleSave();
  }

  /** 请求结束：累计 token（同时记进当前分钟窗口，供 TPM 判定） */
  function noteTokens(k, tokens) {
    if (!k || !tokens) return;
    const w = winOf(k);
    if (w.length) w[w.length - 1].tokens += tokens;
    else w.push({ ts: Date.now(), tokens });
    k.quota.usedTokens += tokens;
    scheduleSave();
  }

  // ---------------------------------------------------------------- CRUD
  function list() {
    if (!data) load();
    return data.keys.map(({key, ...k}) => ({
      ...k,
      key_masked: maskKey(key),
      // 运行时状态
      rpm_current: windowStats(k).rpm,
      tpm_current: windowStats(k).tpm,
      expired: !!(k.expiresAt && Date.now() > k.expiresAt),
      quota_exhausted: (k.quota.limitTokens > 0 && k.quota.usedTokens >= k.quota.limitTokens) ||
        (k.quota.limitRequests > 0 && k.quota.usedRequests >= k.quota.limitRequests),
    }));
  }

  function get(id) {
    if (!data) load();
    return data.keys.find(k => k.id === id) || null;
  }

  function create(input = {}) {
    if (!data) load();
    const k = normalizeKey({ ...input, id: generateId(), createdAt: Date.now() });
    if (!input.key) k.key = generateKey();
    data.keys.push(k);
    writeNow();
    return k;
  }

  function update(id, patch = {}) {
    if (!data) load();
    const k = get(id);
    if (!k) return null;
    const fields = ['name', 'enabled', 'expiresAt', 'models', 'rpm', 'tpm', 'ipWhitelist', 'key'];
    for (const f of fields) if (patch[f] !== undefined) k[f] = patch[f];
    if (patch.quota && typeof patch.quota === 'object') {
      for (const f of ['limitTokens', 'usedTokens', 'limitRequests', 'usedRequests']) {
        if (patch.quota[f] !== undefined) k.quota[f] = +patch.quota[f] || 0;
      }
    }
    if (patch.expiresAt !== undefined) k.expiresAt = patch.expiresAt === null ? null : +patch.expiresAt;
    if (patch.rpm !== undefined) k.rpm = +patch.rpm || 0;
    if (patch.tpm !== undefined) k.tpm = +patch.tpm || 0;
    if (patch.models !== undefined) k.models = Array.isArray(patch.models) ? patch.models : [];
    if (patch.ipWhitelist !== undefined) k.ipWhitelist = Array.isArray(patch.ipWhitelist) ? patch.ipWhitelist : [];
    writeNow();
    return k;
  }

  function remove(id) {
    if (!data) load();
    const i = data.keys.findIndex(k => k.id === id);
    if (i < 0) return false;
    data.keys.splice(i, 1);
    windows.delete(id);
    writeNow();
    return true;
  }

  /** 重置某个 key 的已用量 */
  function resetUsage(id) {
    const k = get(id);
    if (!k) return false;
    k.quota.usedTokens = 0;
    k.quota.usedRequests = 0;
    windows.delete(id);
    writeNow();
    return true;
  }

  function serverConfig() {
    if (!data) load();
    return {host:data.server.host, port:data.server.port};
  }

  function settings() {
    if (!data) load();
    return data.settings;
  }

  function updateServer(patch = {}) {
    if (!data) load();
    for (const f of ['port', 'host']) if (patch[f] !== undefined) data.server[f] = patch[f];
    writeNow();
    return data.server;
  }

  function updateSettings(patch = {}) {
    if (!data) load();
    if (!data.settings) data.settings = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) data.settings[k] = v;
    }
    writeNow();
    return data.settings;
  }

  function keyCount() {
    if (!data) load();
    return data.keys.length;
  }

  return {
    load, reloadIfChanged, save: writeNow,
    identify, modelAllowed, noteRequest, noteTokens,
    list, get, create, update, remove, resetUsage,
    serverConfig, updateServer, settings, updateSettings, keyCount,
    wasCreated: () => created,
    snapshot: () => data,
  };
}

export function maskKey(k) {
  if (!k) return '';
  if (k.length <= 12) return '••••';
  return k.slice(0, 8) + '…' + k.slice(-4);
}

// Public projection; never spread the settings object into an HTTP response.
export function publicSettings(settings = {}) {
  const price = Number(settings.pricePerMillionTokens);
  return {
    price_per_million_tokens: Number.isFinite(price) && price >= 0 ? price : 0,
  };
}

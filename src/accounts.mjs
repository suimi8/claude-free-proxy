/**
 * accounts.mjs —— 多账号池
 *
 * 职责：
 *   - 账号存储（accounts.json，原子写）
 *   - 选择策略：round-robin（默认）/ least-loaded（按 5h 窗口用量）
 *   - 每账号并发上限（perAccountConcurrency）
 *   - 失败冷却（rate_limit / auth / challenge / error，按连续失败次数指数退避）
 *   - 池级 failover（一个账号挂了自动换下一个）
 *   - quota 记录（上游 SSE 的 message_limit 事件）
 *
 * 账号字段：
 *   id            池内唯一 id
 *   label         显示名
 *   sessionKey    认证凭据（sk-ant-sid02-...），必填
 *   cookie        完整 cookie 串（可选，Desktop 账号带 cf_clearance 时用）
 *   org           组织 uuid，必填（可由 discoverOrg 自动补全）
 *   base          上游 base，默认 https://claude.ai（测试时可指向 mock）
 *   ua            与 cf_clearance 绑定的 UA
 *   enabled       是否参与轮询
 *   source        desktop | manual
 *
 * 运行时字段（不落盘）：inflight
 */
import fs from 'node:fs';
import path from 'node:path';
import { hasRecentRateLimit, selectOptimalAccount } from './network-optimizer.mjs';

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export const DEFAULT_BASE = 'https://claude.ai';

/** 冷却档位（毫秒），按连续失败次数递增 */
const COOLDOWN = {
  rate_limit:   [60e3, 180e3, 600e3, 1800e3], // 429 配额用尽：1m/3m/10m/30m
  // 429 concurrents：上游并发槽是「确定性释放」——前一个 completion 跑完就空出来（实测 1~5s）。
  // 所以固定 1.5s 冷却，不随 failStreak 递增：并发满只是排队，不是账号出问题，
  // 惩罚性递增（3s/10s/30s）会让多子代理并发场景雪崩式恶化。
  concurrency:  [1500],
  auth:         [300e3, 900e3, 1800e3],       // 401/403：5m/15m/30m
  challenge:    [300e3, 900e3, 1800e3],       // Cloudflare 挑战：5m/15m/30m
  transient:    [0, 2e3, 10e3],               // 网络抖动/5xx：几乎不冷却，快速重试
  error:        [15e3, 60e3, 300e3],          // 其它：15s/1m/5m
};

/** 401/403 连续 3 次后自动禁用的时长，到期自动恢复 */
const AUTO_DISABLE_MS = 60 * 60 * 1000;
/** auth 连续失败多少次自动禁用账号 */
const AUTO_DISABLE_STREAK = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 同步睡 ms（Node 没有同步 sleep；Atomics.wait 可以）——给原子落盘的重试用 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* noop */ }
}

/** 负载分：优先 5h 窗口用量，再看在途请求数 */
function loadScore(a) {
  const w = a.quota?.windows || {};
  let u = w['5h']?.utilization ?? w['5h']?.utilised ?? w['5h']?.used;
  if (typeof u !== 'number') u = 0;
  else if (u > 1) u = u / 100;      // 兼容百分比写法
  return u * 100 + a.inflight * 0.01;
}

/**
 * 账号剩余额度比例 0..1：取 5h（当前会话）与 7d（本周）里更紧的那个窗口。
 * 两个窗口都没有数据返回 null（还没请求过 -> 视为充足）。
 * utilization 兼容 0..1 与 0..100 两种写法。
 */
function quotaRemaining(a) {
  if (a.exhaustedUntil && a.exhaustedUntil > Date.now()) return 0;
  const w = a.quota?.windows || {};
  let min = null;
  for (const k of ['5h', '7d']) {
    const u = w[k]?.utilization ?? w[k]?.utilised ?? w[k]?.used;
    if (typeof u !== 'number') continue;
    const used = u > 1 ? u / 100 : u;
    const r = Math.max(0, Math.min(1, 1 - used));
    min = min == null ? r : Math.min(min, r);
  }
  return min;
}

export class AccountPool {
  /**
   * @param {string} file  accounts.json 路径
   * @param {object} opts  { strategy, perAccountConcurrency, maxFailover, waitTimeoutMs }
   */
  constructor(file, opts = {}) {
    this.file = file;
    // 只有显式给了（env 或参数）才覆盖 accounts.json 里的值，否则以文件为准
    const envConc = process.env.PER_ACCOUNT_CONCURRENCY;
    this.opts = {
      strategy: opts.strategy || process.env.ACCOUNT_STRATEGY || '',
      perAccountConcurrency: opts.perAccountConcurrency != null ? +opts.perAccountConcurrency
        : (envConc != null && envConc !== '' ? +envConc : 0),
      maxFailover: +(opts.maxFailover || process.env.MAX_FAILOVER || 3),
      waitTimeoutMs: +(opts.waitTimeoutMs || process.env.ACCOUNT_WAIT_TIMEOUT_MS || 30000),
    };
    this.data = {
      version: 1,
      strategy: this.opts.strategy || 'least-loaded',
      perAccountConcurrency: this.opts.perAccountConcurrency || 3,
      minQuotaRemaining: 0.2,
      maxFailover: this.opts.maxFailover || 3,
      waitTimeoutMs: this.opts.waitTimeoutMs || 30000,
      sessionAffinity: true,
      pruneContext: true,
      pruneMaxToolChars: 8000,
      pruneKeepRecentTools: 4,
      defaultEffort: 'max',
      accounts: [],
    };
    this.rr = 0;
    this.load();
  }

  // ---------------------------------------------------------------- 存储
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && Array.isArray(raw.accounts)) {
        this.data = { ...this.data, ...raw, accounts: raw.accounts };
      }
    } catch { /* 首次运行，用空池 */ }
    try { this._mtime = fs.statSync(this.file).mtimeMs; } catch { /* noop */ }

    // 环境变量/构造参数优先于文件；都没给就保留文件值，兜底 3
    if (this.opts.strategy) this.data.strategy = this.opts.strategy;
    if (this.opts.perAccountConcurrency > 0) {
      this.data.perAccountConcurrency = this.opts.perAccountConcurrency;
    } else if (!(this.data.perAccountConcurrency > 0)) {
      this.data.perAccountConcurrency = 3;
    }

    // 额度切换阈值：文件里有就用文件（WebUI 可改），否则 MIN_QUOTA_REMAINING，默认 0.2（剩余 20% 切走）
    if (typeof this.data.minQuotaRemaining !== 'number') {
      const e = process.env.MIN_QUOTA_REMAINING;
      this.data.minQuotaRemaining =
        e != null && e !== '' && Number.isFinite(+e) ? Math.min(0.99, Math.max(0, +e)) : 0.2;
    }

    if (typeof this.data.maxFailover !== 'number' || this.data.maxFailover < 1) {
      this.data.maxFailover = this.opts.maxFailover || 3;
    }
    if (typeof this.data.waitTimeoutMs !== 'number' || this.data.waitTimeoutMs < 1000) {
      this.data.waitTimeoutMs = this.opts.waitTimeoutMs || 30000;
    }
    if (typeof this.data.sessionAffinity !== 'boolean') {
      this.data.sessionAffinity = true;
    }
    if (typeof this.data.pruneContext !== 'boolean') {
      this.data.pruneContext = process.env.PRUNE_CONTEXT !== 'off';
    }
    if (typeof this.data.pruneMaxToolChars !== 'number' || this.data.pruneMaxToolChars < 200) {
      this.data.pruneMaxToolChars = +(process.env.PRUNE_MAX_TOOL_CHARS || 8000);
    }
    if (typeof this.data.pruneKeepRecentTools !== 'number' || this.data.pruneKeepRecentTools < 0) {
      this.data.pruneKeepRecentTools = +(process.env.PRUNE_KEEP_RECENT_TOOLS || 4);
    }
    if (typeof this.data.defaultEffort !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max'].includes(this.data.defaultEffort)) {
      this.data.defaultEffort = (process.env.DEFAULT_EFFORT || 'max').toLowerCase();
    }

    // 保留已有账号的运行时状态，避免刷新凭据时把冷却/在途计数清零
    const prev = this._byId || new Map();
    this._byId = new Map();
    for (const a of this.data.accounts) {
      this._init(a);
      const old = prev.get(a.id);
      if (old) {
        a.inflight = old.inflight;
        if (old.sessionKey !== a.sessionKey) {
          // 凭据换了（手工轮换 sessionKey）：视为新账号，清掉旧冷却
          a.cooldownUntil = 0;
          a.failStreak = 0;
          a.streaks = {};
          a.stats = { ok: old.stats.ok, fail: 0, lastUsedAt: old.stats.lastUsedAt, lastError: '' };
        } else {
          a.cooldownUntil = old.cooldownUntil;
          a.failStreak = old.failStreak;
          a.streaks = old.streaks || {};
          a.stats = { ...a.stats, ...old.stats };
        }
      }
      this._byId.set(a.id, a);
    }
    return this.data.accounts;
  }

  _init(a) {
    a.enabled = a.enabled !== false;
    a.inflight = a.inflight || 0;
    a.cooldownUntil = a.cooldownUntil || 0;
    a.autoDisabledAt = a.autoDisabledAt || 0;   // auth 连败自动禁用的时刻（0=未被自动禁用）
    a.exhaustedUntil = a.exhaustedUntil || 0;   // 429 配额耗尽：配额窗口恢复的时刻（0=不在耗尽池）
    a.exhaustedReason = a.exhaustedReason || '';
    a.exhaustedAt = a.exhaustedAt || 0;
    a.failStreak = a.failStreak || 0;
    a.streaks = a.streaks || {};   // 每类错误独立的连续失败计数（决定各自冷却档位）
    a.stats = { ok: 0, fail: 0, lastUsedAt: 0, lastError: '', tokensInEst: 0, tokensOutEst: 0, ...(a.stats || {}) };
    a.quota = a.quota || {};
    a.ua = a.ua || DEFAULT_UA;
    a.base = a.base || DEFAULT_BASE;
    a.createdAt = a.createdAt || Date.now();

    // 智能校准：若最后一次报错包含明确的 resetsAt 且当前仍在限制窗口内，
    // 自动补齐 exhaustedUntil 与 cooldownUntil，杜绝「无冷却显示但实际用不了」的悬空状态。
    const now = Date.now();
    if ((!a.exhaustedUntil || a.exhaustedUntil <= now) && a.stats?.lastError) {
      const m = /resetsAt\\?":\s*(\d{9,})/.exec(a.stats.lastError);
      if (m) {
        let ts = +m[1];
        if (ts < 1e12) ts *= 1000;
        if (ts > now) {
          a.exhaustedUntil = ts;
          a.exhaustedReason = a.exhaustedReason || 'five_hour';
          a.cooldownUntil = Math.max(a.cooldownUntil || 0, ts);
          if (!a.exhaustedAt) a.exhaustedAt = a.stats.lastUsedAt || now;
        }
      }
    }
  }

  save() {
    const out = {
      ...this.data,
      accounts: this.data.accounts.map(a => {
        const { inflight, ...rest } = a;   // 运行时字段不落盘
        return rest;
      }),
    };
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), {recursive:true, mode:0o700});
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), {mode:0o600});
    // Windows 上目标文件被别的进程短暂打开时，rename 会抛 EPERM/EACCES/EBUSY。
    // 以前直接往上抛，这一次的落盘就整个丢了（账号冷却、统计不落盘），
    // 这里重试几次，绕开那个毫秒级窗口。
    let lastErr = null;
    for (let i = 0; i < 6; i++) {
      try {
        fs.renameSync(tmp, this.file);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) break;
        sleepSync(25 * (i + 1));
      }
    }
    if (lastErr) throw lastErr;
    try { this._mtime = fs.statSync(this.file).mtimeMs; } catch { /* noop */ }
  }

  // ---------------------------------------------------------------- 查询
  accounts() { return this.data.accounts; }
  get(id) { return this.data.accounts.find(a => a.id === id) || null; }

  /** 可参与本轮选择的账号 */
  eligible(now = Date.now(), exclude) {
    const cap = this.data.perAccountConcurrency;
    return this.data.accounts.filter(a =>
      a.enabled && a.sessionKey && a.org &&
      now >= (a.cooldownUntil || 0) &&
      !(a.exhaustedUntil > now) &&          // 429 耗尽池：配额窗口没过之前一律不选
      a.inflight < cap &&
      (!exclude || !exclude.has(a.id)));
  }

  /**
   * 选一个账号并占用一个并发额度。
   * @param {Set<string>} [exclude] 本轮 failover 已经试过的账号
   * @param {string} [preferredId] 智能会话粘性：优先使用同一会话上次处理的账号（保护 Prompt Cache）
   * @returns {object|null} 拿不到返回 null
   */
  acquire(exclude, preferredId) {
    const now = Date.now();
    let list = this.eligible(now, exclude);
    if (!list.length) return null;

    const thr = +this.data.minQuotaRemaining;

    // 智能会话粘性 (Session Affinity)：
    // 只要该会话首选账号在可用列表中（eligible 已保证其 inflight < 3 且未冷却未排除），
    // 且剩余额度未破阈值，优先锁定该账号，确保吃满 Anthropic 官方前缀缓存（命中率 85%+）。
    if (this.data.sessionAffinity !== false && preferredId) {
      const pref = list.find(a => a.id === preferredId);
      if (pref) {
        const r = quotaRemaining(pref);
        if (r == null || thr <= 0 || r >= thr) {
          pref.inflight++;
          pref.stats.lastUsedAt = Date.now();
          return pref;
        }
      }
    }

    // 额度低于阈值就切走：剩余 < minQuotaRemaining（默认 20%）的账号本轮不选。
    // 只剩一个候选、或全都低于阈值时降级照用，避免整个池拒绝服务。
    if (thr > 0 && list.length > 1) {
      const fresh = list.filter(a => {
        const r = quotaRemaining(a);
        return r == null || r >= thr;
      });
      if (fresh.length && fresh.length < list.length) {
        const skipped = list.filter(a => !fresh.includes(a)).map(a => a.label).join(',');
        if (Date.now() - (this._quotaLogAt || 0) > 10000) {   // 限频，避免每请求刷屏
          this._quotaLogAt = Date.now();
          console.warn(`[pool] quota remaining < ${Math.round(thr * 100)}% -> switch, skip: ${skipped}`);
        }
        list = fresh;
      }
    }

    // 优先选择近期没有 429 / 限频记录的绝对健康账号
    const nonRateLimited = list.filter(a => !hasRecentRateLimit(a));
    const effectiveList = nonRateLimited.length ? nonRateLimited : list;

    let pick;
    if (this.data.strategy === 'least-loaded') {
      pick = effectiveList.slice().sort((x, y) => {
        const x429 = hasRecentRateLimit(x) ? 1 : 0;
        const y429 = hasRecentRateLimit(y) ? 1 : 0;
        if (x429 !== y429) return x429 - y429;
        const rx = quotaRemaining(x) ?? 1;
        const ry = quotaRemaining(y) ?? 1;
        if (Math.abs(rx - ry) > 0.1) return ry - rx;
        return (loadScore(x) - loadScore(y)) || (x.stats.lastUsedAt - y.stats.lastUsedAt);
      })[0];
    } else if (this.data.strategy === 'optimal') {
      pick = selectOptimalAccount(effectiveList, exclude, preferredId, {
        perAccountConcurrency: this.data.perAccountConcurrency,
      });
    } else {
      // round-robin：优先在健康列表中循环
      const ids = new Set(effectiveList.map(a => a.id));
      const n = this.data.accounts.length;
      for (let i = 0; i < n; i++) {
        const idx = (this.rr + i) % n;
        const a = this.data.accounts[idx];
        if (ids.has(a.id)) { pick = a; this.rr = (idx + 1) % n; break; }
      }
      pick = pick || effectiveList[0];
    }

    if (!pick) return null;

    pick.inflight++;
    pick.stats.lastUsedAt = Date.now();
    return pick;
  }

  release(a, ok = true) {
    if (!a) return;
    const cur = this.get(a.id) || a;   // 热加载后对象可能已被替换，按 id 找当前对象
    cur.inflight = Math.max(0, cur.inflight - 1);
    if (ok) {
      cur.stats.ok++;
      cur.failStreak = 0;
      cur.streaks = {};          // 成功一次：所有类别的连续失败计数清零
      // 请求成功后清除账号上一次的错误状态。
      cur.stats.lastError = '';
      // 注意：账号还挂在「429 耗尽池」时，不能因为别的在途请求成功就把冷却清掉 ——
      // 配额窗口没过之前它还是用不了。
      if (cur.exhaustedUntil > Date.now()) {
        cur.cooldownUntil = Math.max(cur.cooldownUntil || 0, cur.exhaustedUntil);
      } else {
        cur.cooldownUntil = 0;
      }
    }
    this.save();
  }

  /**
   * 记一次失败并进入冷却。
   * @param {'rate_limit'|'auth'|'challenge'|'transient'|'error'|'concurrency'} kind
   * @param {string} message
   * @param {{resetsAt?:number, reason?:string}} [extra] extra.resetsAt = 上游给的配额恢复时刻(ms)
   * @returns {number} 冷却毫秒数
   */
  fail(a, kind, message, extra = {}) {
    if (!a) return 0;
    const cur = this.get(a.id) || a;
    cur.inflight = Math.max(0, cur.inflight - 1);
    cur.stats.fail++;
    cur.stats.lastError = String(message || '').slice(0, 200);
    cur.failStreak++;
    // 按错误类别各自累计再选档：concurrency/transient 这类秒级故障连续出现，
    // 不该把 rate_limit 的 1m/30m 档位顶上去（反之亦然）。
    cur.streaks = cur.streaks || {};
    cur.streaks[kind] = (cur.streaks[kind] || 0) + 1;

    let ms;
    if (kind === 'rate_limit' && extra.resetsAt) {
      // 配额用尽（上游 exceeded_limit）：上游给了**精确的恢复时刻**，
      // 就按那个时刻收紧进「429 耗尽池」，不要按 1m/3m/10m/30m 的阶梯反复试 ——
      // 阶梯冷却会在窗口还没恢复时又把账号拿出来撞，白白消耗 failover 配额。
      const until = extra.resetsAt;
      cur.exhaustedUntil = until;
      cur.exhaustedReason = extra.reason || 'quota';
      cur.exhaustedAt = Date.now();
      cur.last429At = Date.now();
      cur.lastRateLimitAt = Date.now();
      cur.cooldownUntil = Math.max(cur.cooldownUntil || 0, until);
      ms = Math.max(0, until - Date.now());
      console.warn(`[pool] ${cur.label} 配额用尽(${cur.exhaustedReason}) -> 列入 429 耗尽池，`
        + `${new Date(until).toLocaleString('zh-CN')} 恢复（约 ${Math.ceil(ms / 60000)} 分钟后自动回到有效池）`);
    } else {
      const ladder = COOLDOWN[kind] || COOLDOWN.error;
      ms = ladder[Math.min(cur.streaks[kind] - 1, ladder.length - 1)];
      cur.cooldownUntil = Date.now() + ms;
    }

    // 401/403 连续 3 次：登录态基本已失效，自动禁用，别再反复消耗 failover 配额
    //（冷却档位最多 30 分钟，过期后又会被选中、又 403，无限循环）。
    // 60 分钟后自动恢复一次（streaks 保留 -> 再坏就再一次失败即重新禁用，每小时至多探测 1 次）；
    // 手动恢复 PATCH /v1/accounts/{id} {"enabled":true} 会清零 streaks，给全新机会。
    if (kind === 'auth' && cur.enabled && (cur.streaks.auth || 0) >= AUTO_DISABLE_STREAK) {
      cur.enabled = false;
      cur.autoDisabledAt = Date.now();
      console.warn(`[pool] ${cur.label} 连续 ${cur.streaks.auth} 次 401/403 -> 自动禁用 60 分钟（恢复：PATCH /v1/accounts/${cur.id} {"enabled":true} 或等自动恢复）`);
    }

    this.save();
    return ms;
  }

  /**
   * 被自动禁用的账号到期后恢复（由 openai-proxy 的定时器调用）。
   * 不清 streaks：账号若真坏了，恢复后第一次 403 就会重新禁用（每小时至多探测 1 次）；
   * 若好了，成功一次即清零所有 streaks。
   */
  autoRestoreDisabled(now = Date.now()) {
    let n = 0;
    for (const a of this.data.accounts) {
      if (a.enabled === false && a.autoDisabledAt && now - a.autoDisabledAt >= AUTO_DISABLE_MS) {
        a.enabled = true;
        a.autoDisabledAt = 0;
        n++;
        console.log(`[pool] ${a.label} 自动禁用 60 分钟到期 -> 恢复启用（连续失败计数保留，再坏会立即重新禁用）`);
      }
    }
    if (n) this.save();
    return n;
  }

  /**
   * 429 耗尽池的账号：配额窗口到期后自动回到有效池（由 openai-proxy 的定时器调用）。
   * 恢复时刻用上游给的 resetsAt，不自己拍脑袋。
   */
  restoreExhausted(now = Date.now()) {
    let n = 0;
    for (const a of this.data.accounts) {
      if (!a.exhaustedUntil) continue;
      if (now < a.exhaustedUntil) continue;
      const waited = Math.round((now - (a.exhaustedAt || now)) / 60000);
      const until = a.exhaustedUntil;
      a.exhaustedUntil = 0;
      a.exhaustedReason = '';
      a.exhaustedAt = 0;
      // 收紧时设的冷却也要一起清掉，否则账号虽然出池了，冷却还挂在未来 -> 依然选不到。
      // 只清「就是这条耗尽冷却」的那一个（之后别的错误另设的冷却不动）。
      if (a.cooldownUntil && a.cooldownUntil <= until + 1000) a.cooldownUntil = 0;
      a.failStreak = 0;
      a.streaks = {};
      n++;
      console.log(`[pool] ${a.label} 配额窗口已恢复（等了 ${waited} 分钟）-> 回到有效池，重新参与调度`);
    }
    if (n) this.save();
    return n;
  }

  /** 池里下一个「429 耗尽」账号恢复的时刻（ms），没有则 null */
  nextRestoreAt() {
    let t = 0;
    for (const a of this.data.accounts) {
      if (a.exhaustedUntil && (!t || a.exhaustedUntil < t)) t = a.exhaustedUntil;
    }
    return t || null;
  }

  /** 记录上游 SSE 的 message_limit 事件，供 least-loaded 策略使用（落盘，重启不丢） */
  updateQuota(a, limit) {
    if (!a || !limit || typeof limit !== 'object') return;
    a.quota = { ...limit, updatedAt: Date.now() };
    this.save();
  }

  /** 累计本地估算 token（上游不返回 usage；只用于展示"已用多少"，不是配额） */
  noteTokens(a, inEst = 0, outEst = 0) {
    if (!a || (!inEst && !outEst)) return;
    const cur = this.get(a.id) || a;
    cur.stats.tokensInEst = (cur.stats.tokensInEst || 0) + inEst;
    cur.stats.tokensOutEst = (cur.stats.tokensOutEst || 0) + outEst;
    this.save();
  }

  // ---------------------------------------------------------------- 变更
  add(input) {
    const sk = String(input.sessionKey || '').trim();
    if (!sk) throw Object.assign(new Error('sessionKey is required'), { status: 400 });

    let a = this.data.accounts.find(x => x.sessionKey === sk);
    if (a) {
      if (input.org) a.org = input.org;
      if (input.label) a.label = input.label;
      if (input.ua) a.ua = input.ua;
      if (input.cookie) a.cookie = input.cookie;
      if (input.base) a.base = input.base;
      if (input.email) a.email = input.email;
      a.enabled = true;
      a.failStreak = 0;
      a.streaks = {};
      a.cooldownUntil = 0;
      a.autoDisabledAt = 0;   // 重新导入/刷新凭据 = 全新机会
      this.save();
      return { account: a, created: false };
    }

    a = {
      id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      label: input.label || `account-${this.data.accounts.length + 1}`,
      sessionKey: sk,
      cookie: input.cookie || '',
      org: input.org || '',
      email: input.email || '',
      base: input.base || DEFAULT_BASE,
      ua: input.ua || DEFAULT_UA,
      enabled: true,
      source: input.source || 'manual',
      createdAt: Date.now(),
    };
    this._init(a);
    this.data.accounts.push(a);
    this.save();
    return { account: a, created: true };
  }

  /** 以 sessionKey 为幂等键更新（Desktop 账号每次刷新都走这里） */
  upsert(input) {
    return this.add({ ...input, source: input.source || 'desktop' }).account;
  }

  remove(id) {
    const i = this.data.accounts.findIndex(a => a.id === id);
    if (i < 0) return false;
    this.data.accounts.splice(i, 1);
    this.save();
    return true;
  }

  set(id, patch) {
    const a = this.get(id);
    if (!a) return null;
    if (typeof patch.enabled === 'boolean') a.enabled = patch.enabled;
    if (patch.label) a.label = String(patch.label).slice(0, 60);
    if (patch.org) a.org = patch.org;
    if (patch.sessionKey && patch.sessionKey !== a.sessionKey) {
      a.sessionKey = String(patch.sessionKey).trim();
      a.cooldownUntil = 0;      // 换了凭据就别再沿用旧冷却
      a.failStreak = 0;
      a.streaks = {};
      a.stats.lastError = '';
    }
    if (patch.cookie !== undefined) a.cookie = String(patch.cookie || '');
    if (patch.clearError && a.stats) a.stats.lastError = '';
    if (patch.base) a.base = patch.base;
    if (patch.ua) a.ua = patch.ua;
    if (typeof patch.cooldownUntil === 'number') a.cooldownUntil = patch.cooldownUntil;
    if (patch.enabled) { a.failStreak = 0; a.streaks = {}; a.cooldownUntil = 0; a.autoDisabledAt = 0; }
    this.save();
    return a;
  }

  /** 一键清除所有账号的冷却与连续失败状态（例如误报恢复后） */
  clearAllCooldowns() {
    let count = 0;
    for (const a of this.data.accounts) {
      if ((a.cooldownUntil && a.cooldownUntil > 0) || (a.failStreak && a.failStreak > 0) || (a.stats && /cloudflare|challenge/i.test(a.stats.lastError || ''))) {
        a.cooldownUntil = 0;
        a.failStreak = 0;
        a.streaks = {};
        if (a.stats && /cloudflare|challenge/i.test(a.stats.lastError || '')) {
          a.stats.lastError = '';
        }
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  /**
   * 文件被外部改动时热加载（手工编辑 accounts.json 不用重启）。
   * 保留运行时状态：inflight / cooldown / failStreak。
   */
  reloadIfChanged() {
    let mtime = 0;
    try { mtime = fs.statSync(this.file).mtimeMs; } catch { return false; }
    if (mtime === this._mtime) return false;
    this._mtime = mtime;
    this.load();
    return true;
  }

  setStrategy(s) {
    if (!['round-robin', 'least-loaded', 'optimal'].includes(s)) {
      throw Object.assign(new Error('strategy must be round-robin | least-loaded | optimal'), { status: 400 });
    }
    this.data.strategy = s;
    this.save();
  }

  /** 池配置（WebUI 设置用）：缺哪个字段就只改哪个 */
  configure(opts = {}) {
    if (opts.strategy != null && opts.strategy !== '') this.setStrategy(opts.strategy);
    if (opts.perAccountConcurrency != null) {
      const c = +opts.perAccountConcurrency;
      if (!Number.isFinite(c) || c < 1 || c > 32) {
        throw Object.assign(new Error('perAccountConcurrency 必须在 1..32 之间'), { status: 400 });
      }
      this.data.perAccountConcurrency = Math.floor(c);
    }
    if (opts.minQuotaRemaining != null) {
      const q = +opts.minQuotaRemaining;
      if (!Number.isFinite(q) || q < 0 || q >= 1) {
        throw Object.assign(new Error('minQuotaRemaining 必须在 0..0.99 之间'), { status: 400 });
      }
      this.data.minQuotaRemaining = q;
    }
    if (opts.maxFailover != null) {
      const f = +opts.maxFailover;
      if (!Number.isFinite(f) || f < 1 || f > 20) {
        throw Object.assign(new Error('maxFailover 必须在 1..20 之间'), { status: 400 });
      }
      this.data.maxFailover = Math.floor(f);
    }
    if (opts.waitTimeoutMs != null) {
      const w = +opts.waitTimeoutMs;
      if (!Number.isFinite(w) || w < 1000 || w > 300000) {
        throw Object.assign(new Error('waitTimeoutMs 必须在 1000..300000 毫秒之间'), { status: 400 });
      }
      this.data.waitTimeoutMs = Math.floor(w);
    }
    if (opts.pruneContext != null) {
      this.data.pruneContext = Boolean(opts.pruneContext);
    }
    if (opts.pruneMaxToolChars != null) {
      const m = +opts.pruneMaxToolChars;
      if (!Number.isFinite(m) || m < 200 || m > 100000) {
        throw Object.assign(new Error('pruneMaxToolChars 必须在 200..100000 之间'), { status: 400 });
      }
      this.data.pruneMaxToolChars = Math.floor(m);
    }
    if (opts.pruneKeepRecentTools != null) {
      const k = +opts.pruneKeepRecentTools;
      if (!Number.isFinite(k) || k < 0 || k > 20) {
        throw Object.assign(new Error('pruneKeepRecentTools 必须在 0..20 之间'), { status: 400 });
      }
      this.data.pruneKeepRecentTools = Math.floor(k);
    }
    if (opts.sessionAffinity !== undefined) {
      this.data.sessionAffinity = Boolean(opts.sessionAffinity);
    }
    if (opts.defaultEffort != null && opts.defaultEffort !== '') {
      const eff = String(opts.defaultEffort).toLowerCase();
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(eff)) {
        throw Object.assign(new Error('defaultEffort 必须是 low|medium|high|xhigh|max 之一'), { status: 400 });
      }
      this.data.defaultEffort = eff;
    }
    this.save();
    return {
      strategy: this.data.strategy,
      per_account_concurrency: this.data.perAccountConcurrency,
      min_quota_remaining: this.data.minQuotaRemaining,
      max_failover: this.data.maxFailover,
      wait_timeout_ms: this.data.waitTimeoutMs,
      session_affinity: this.data.sessionAffinity !== false,
      prune_context: this.data.pruneContext,
      prune_max_tool_chars: this.data.pruneMaxToolChars,
      prune_keep_recent_tools: this.data.pruneKeepRecentTools,
      default_effort: this.data.defaultEffort,
    };
  }

  /** 对外状态（sessionKey 打码） */
  status() {
    const now = Date.now();
    const thr = +this.data.minQuotaRemaining;
    return {
      strategy: this.data.strategy,
      per_account_concurrency: this.data.perAccountConcurrency,
      min_quota_remaining: this.data.minQuotaRemaining,
      max_failover: this.data.maxFailover,
      wait_timeout_ms: this.data.waitTimeoutMs,
      session_affinity: this.data.sessionAffinity !== false,
      prune_context: this.data.pruneContext,
      prune_max_tool_chars: this.data.pruneMaxToolChars,
      prune_keep_recent_tools: this.data.pruneKeepRecentTools,
      default_effort: this.data.defaultEffort,
      total: this.data.accounts.length,
      enabled: this.data.accounts.filter(a => a.enabled).length,
      eligible_now: this.eligible(now).length,
      // ---- 两个池：有效池 / 429 额度耗尽池 ----
      valid_pool: this.data.accounts.filter(a => a.enabled && !(a.exhaustedUntil > now)).length,
      exhausted_pool: this.data.accounts.filter(a => a.exhaustedUntil > now).length,
      next_restore_at: this.nextRestoreAt(),
      accounts: this.data.accounts.map(a => {
        const sk = a.sessionKey || '';
        const remaining = quotaRemaining(a);
        return {
          id: a.id,
          label: a.label,
          source: a.source,
          enabled: a.enabled,
          org: a.org,
          session_key: sk ? '••••' : '',
          inflight: a.inflight,
          capacity: this.data.perAccountConcurrency,
          cooldown_remaining_s: Math.max(0, Math.ceil((a.cooldownUntil - now) / 1000)),
          // 429 额度耗尽池：配额窗口恢复前不进有效池
          exhausted: a.exhaustedUntil > now,
          exhausted_until: a.exhaustedUntil || null,
          exhausted_reason: a.exhaustedReason || null,
          exhausted_restore_in_s: a.exhaustedUntil > now
            ? Math.max(0, Math.ceil((a.exhaustedUntil - now) / 1000)) : 0,
          pool: a.exhaustedUntil > now ? 'exhausted' : (a.enabled ? 'valid' : 'disabled'),
          auto_disabled: !!a.autoDisabledAt,          // 401/403 连败被自动禁用（60 分钟后自动恢复）
          auto_disabled_at: a.autoDisabledAt || null,
          fail_streak: a.failStreak,
          auth_fail_streak: a.streaks?.auth || 0,     // 登录态连续失败次数（3 次自动禁用）
          ok: a.stats.ok,
          fail: a.stats.fail,
          last_error: a.stats.lastError,
          quota_5h: a.quota?.windows?.['5h'] ?? null,
          quota_7d: a.quota?.windows?.['7d'] ?? null,
          quota_remaining: remaining,                       // 0..1（两窗口取更紧的），null=无数据
          low_quota: remaining != null && thr > 0 && remaining < thr,   // 低于阈值 -> 轮询已切走
          quota_updated_at: a.quota?.updatedAt || null,
          quota_detail: a.quota?.windows ? {
            status: a.quota.type || a.quota.resolved?.status || null,
            representative_claim: a.quota.representativeClaim || null,
            resolved_limit: a.quota.resolved?.limit || null,
            rate_limits: a.quota.rate_limits || null,
            probed: !!a.quota.probedAt,
            windows_raw: a.quota.windows || null,
          } : null,
          tokens_in_est: a.stats.tokensInEst || 0,
          tokens_out_est: a.stats.tokensOutEst || 0,
          created_at: a.createdAt || null,
          last_used_at: a.stats.lastUsedAt || null,
        };
      }),
    };
  }
}

/**
 * 只用 sessionKey 自动发现 org。
 * 实测 GET /api/organizations 只要 sessionKey 就返回 200。
 */
export async function discoverOrg(sessionKey, base = DEFAULT_BASE, ua = DEFAULT_UA) {
  const r = await fetch(`${base}/api/organizations`, {
    headers: {
      cookie: `sessionKey=${sessionKey}`,
      'user-agent': ua,
      accept: 'application/json',
      origin: base,
      referer: base + '/',
    },
  });
  const txt = await r.text();
  if (!r.ok) {
    throw Object.assign(new Error(`discover_org ${r.status}: ${txt.slice(0, 200)}`),
      { status: r.status, kind: r.status === 429 ? 'rate_limit' : 'auth' });
  }
  const arr = JSON.parse(txt);
  const list = Array.isArray(arr) ? arr : (arr.data || []);
  const org = list[0]?.uuid;
  if (!org) throw Object.assign(new Error('no organization returned'), { status: 404 });
  return { org, name: list[0]?.name || '', plan: list[0]?.rate_limit_tier || '' };
}

export { sleep };

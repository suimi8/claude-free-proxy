// @ts-check
/**
 * hCaptcha 图形题求解器（CDP 版）
 *
 * 场景：hCaptcha 的 invisible 组件偶尔会升级成 3×3 图片题，
 *       第三方打码平台能出 token，但 token 的签发环境（IP/指纹）
 *       与我们后续的协议请求不一致，会被 claude.ai 风控拦在建号那一步。
 *
 * 做法：
 *   1. 让 **本机浏览器** 出题（IP 与指纹天然一致）；
 *   2. 把题目图片交给打码平台做 **图片识别**（只要「哪几张是目标」）；
 *   3. 在本机浏览器里用 **真实鼠标事件** 点选并提交；
 *   4. hCaptcha 于是把 token 签发给我们的 IP。
 *
 * 本模块只负责 CDP 侧的「读题 / 读图 / 点击」，
 * 识别通过外部传入的 classify 回调完成。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────── 页面内脚本（在挑战框上下文执行） ───────────────────── */

/** 读取当前挑战的题目与九宫格图片信息 */
const READ_CHALLENGE = `(() => {
  const q = document.querySelector('.prompt-text');
  const tiles = Array.from(document.querySelectorAll('.task-image'));
  const imgs = tiles.map((t) => {
    const el = t.querySelector('.image');
    // 图片是异步加载后由 JS 写进 background-image 的
    const bg = el ? (getComputedStyle(el).backgroundImage || el.getAttribute('style') || '') : '';
    const m = bg.match(/url\\(["']?(.*?)["']?\\)/);
    const r = t.getBoundingClientRect();
    return { url: m ? m[1] : null, x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const submit = document.querySelector('.button-submit');
  const sr = submit ? submit.getBoundingClientRect() : null;
  // スキップ按钮：拖拽题/出错态用它换一道题
  let skip = document.querySelector('.button-skip');
  if (!skip) {
    skip = Array.from(document.querySelectorAll('button, .button')).find((b) => /スキップ|skip/i.test(b.textContent || '')) || null;
  }
  const kr = skip && skip.offsetWidth ? skip.getBoundingClientRect() : null;
  return JSON.stringify({
    question: q ? (q.textContent || '').trim() : '',
    loaded: imgs.filter((i) => i.url).length,
    images: imgs,
    submit: sr ? { x: sr.left, y: sr.top, w: sr.width, h: sr.height } : null,
    skip: kr ? { x: kr.left, y: kr.top, w: kr.width, h: kr.height } : null,
    anchors: Array.from(document.querySelectorAll('.prompt-images img, .example img')).map((i) => i.src).filter(Boolean),
    bodyText: (document.body && document.body.innerText || '').slice(0, 300),
  });
})()`;

/* ───────────────────── 主类 ───────────────────── */

export class HcaptchaChallengeSolver {
  /**
   * @param {{
   *   page: any,              // 页面级 CDP 连接
   *   browser: any,           // 浏览器级 CDP 连接（用于枚举 OOPIF target）
   *   classify: (q: {question: string, queries: string[], anchors: string[]}) => Promise<{objects?: boolean[], top_k?: number[]}>,
   *   onProgress?: (m: string) => void,
   * }} opts
   */
  constructor(opts) {
    this.page = opts.page;
    this.browser = opts.browser;
    this.classify = opts.classify;
    this.onProgress = opts.onProgress || (() => {});
    /** @type {Map<string, string>} targetId -> sessionId */
    this.sessions = new Map();
  }

  /* ── 目标/会话管理 ── */

  /** 找到承载挑战的会话（可能是页面内 frame，也可能是独立 OOPIF target） */
  async _findChallengeSession() {
    // 1) 同进程 iframe：在页面 frame tree 里找
    const tree = await this.page.call('Page.getFrameTree').catch(() => null);
    const frames = [];
    const walk = (n) => {
      if (!n) return;
      frames.push(n.frame);
      for (const c of n.childFrames || []) walk(c);
    };
    walk(tree?.frameTree);
    const inPage = frames.find((f) => /frame=challenge/.test(f?.url || ''));
    if (inPage) return { kind: 'frame', frameId: inPage.id, sessionId: null };

    // 2) OOPIF：独立 target
    const targets = await this.browser.call('Target.getTargets').catch(() => null);
    const list = targets?.targetInfos || [];
    const hit = list.find((t) => /frame=challenge/.test(t.url || ''));
    if (!hit) return null;
    let sid = this.sessions.get(hit.targetId);
    if (!sid) {
      const att = await this.browser.call('Target.attachToTarget', {
        targetId: hit.targetId,
        flatten: true,
      }).catch(() => null);
      sid = att?.sessionId || null;
      if (sid) this.sessions.set(hit.targetId, sid);
    }
    if (!sid) return null;
    return { kind: 'target', targetId: hit.targetId, sessionId: sid };
  }

  /** 在挑战会话里建隔离世界并执行表达式 */
  async _evalIn(session, expression) {
    let ctx = null;
    if (session.kind === 'frame') {
      const w = await this.page.call('Page.createIsolatedWorld', {
        frameId: session.frameId,
        worldName: 'hcaptcha-solver',
        grantUniveralAccess: true,
      }).catch(() => null);
      ctx = w?.executionContextId || null;
    } else {
      // OOPIF：先拿它自己的 frame tree，再建世界
      const t = await this.browser.call('Page.getFrameTree', {}, 10000, session.sessionId).catch(() => null);
      const fid = t?.frameTree?.frame?.id;
      if (fid) {
        const w = await this.browser.call('Page.createIsolatedWorld', {
          frameId: fid,
          worldName: 'hcaptcha-solver',
          grantUniveralAccess: true,
        }, 10000, session.sessionId).catch(() => null);
        ctx = w?.executionContextId || null;
      }
      if (!ctx) {
        // 退化：直接在该 target 的默认上下文执行
        const r = await this.browser.call('Runtime.evaluate', {
          expression, returnByValue: true,
        }, 10000, session.sessionId).catch(() => null);
        const v = r?.result?.value;
        if (typeof v !== 'string') return null;
        try { return JSON.parse(v); } catch { return null; }
      }
    }
    if (!ctx) return null;
    const r = await this.browser.call('Runtime.evaluate', {
      expression, contextId: ctx, returnByValue: true,
    }, 10000, session.sessionId).catch(() => null);
    const v = r?.result?.value;
    if (typeof v !== 'string') return null;
    try { return JSON.parse(v); } catch { return null; }
  }

  /** 挑战 iframe 在页面坐标系里的内容区原点 */
  async _frameOriginInPage() {
    const r = await this.page.call('Runtime.evaluate', {
      expression: `(() => {
        const f = Array.from(document.querySelectorAll('iframe')).find(x => (x.src||'').includes('frame=challenge'));
        if (!f) return null;
        const b = f.getBoundingClientRect();
        const cs = getComputedStyle(f);
        return JSON.stringify({
          x: b.left, y: b.top,
          bl: parseFloat(cs.borderLeftWidth) || 0,
          bt: parseFloat(cs.borderTopWidth) || 0,
          w: b.width, h: b.height,
        });
      })()`,
      returnByValue: true,
    }).catch(() => null);
    const raw = r?.result?.value;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /** 真实鼠标点击（页面绝对坐标） */
  async _click(x, y) {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await this.page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
    await this.page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 });
    await this.page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  }

  /**
   * 处理图形题（可能多轮）
   * @returns {Promise<boolean>} 是否成功提交
   */
  async handleChallenge(maxRounds = 4) {
    for (let round = 0; round < maxRounds; round++) {
      let session = await this._findChallengeSession();
      if (!session) {
        this.onProgress('未找到挑战框（可能已通过或未出现）');
        return false;
      }

      const state = await this._evalIn(session, READ_CHALLENGE);
      if (!state) {
        this.onProgress('挑战框读取失败');
        return false;
      }

      // 挑战框刚创建时内容是空的；等九宫格渲染出来且图片加载完成
      let ready = state.images?.length > 0 && state.loaded >= state.images.length;
      if (!ready) {
        this.onProgress('等待挑战框渲染…');
        for (let i = 0; i < 30; i++) {
          await sleep(700);
          const s2 = await this._evalIn(session, READ_CHALLENGE);
          if (!s2) continue;
          Object.assign(state, s2);
          if (state.images?.length && state.loaded >= state.images.length) { ready = true; break; }
          // 挑战框被换掉了（刷新过题目）就重新找会话
          const again = await this._findChallengeSession();
          if (!again) break;
          session = again;
        }
      }
      if (!state.images?.length) {
        // 拖拽题/出错态：点「スキップ」换一道题（可能换成可解的九宫格）
        if (state.skip && state.skip.w > 10) {
          const origin = await this._frameOriginInPage();
          if (origin) {
            const ox = origin.x + origin.bl;
            const oy = origin.y + origin.bt;
            this.onProgress(`题目不可解（${String(state.bodyText || '').replace(/\s+/g, ' ').slice(0, 40)}），点スキップ换题`);
            await this._click(ox + state.skip.x + state.skip.w / 2, oy + state.skip.y + state.skip.h / 2);
            await sleep(2500);
            continue;
          }
        }
        this.onProgress(`挑战框里没读到九宫格: ${JSON.stringify(state).slice(0, 200)}`);
        return false;
      }
      if (state.loaded < state.images.length) {
        this.onProgress(`图片未全部加载 (${state.loaded}/${state.images.length})，按已加载的算`);
      }

      this.onProgress(`题目: ${state.question || '(无题干)'} | 图片 ${state.loaded}/${state.images.length} | ${String(state.bodyText || '').replace(/\s+/g, ' ').slice(0, 60)}`);

      // 下载九宫格图片
      const queries = [];
      for (const img of state.images) {
        if (!img.url) { queries.push(''); continue; }
        try {
          const buf = Buffer.from(await (await fetch(img.url)).arrayBuffer());
          queries.push(buf.toString('base64'));
        } catch { queries.push(''); }
      }

      // 示例图
      const anchors = [];
      for (const u of (state.anchors || []).slice(0, 4)) {
        try {
          const buf = Buffer.from(await (await fetch(u)).arrayBuffer());
          anchors.push(buf.toString('base64'));
        } catch { /* 忽略 */ }
      }

      let hits = [];
      try {
        const sol = await this.classify({ question: state.question, queries, anchors });
        hits = sol.objects || (sol.top_k || []).map((i) => !!state.images[i]);
      } catch (e) {
        this.onProgress(`图片识别失败: ${e.message}`);
        return false;
      }
      const idx = state.images.map((_, i) => i).filter((i) => hits[i]);
      this.onProgress(`识别结果: 选中 ${idx.length} 张 [${idx.join(',')}]`);
      if (!idx.length) return false;

      const origin = await this._frameOriginInPage();
      if (!origin) {
        this.onProgress('无法定位挑战 iframe 的页面坐标');
        return false;
      }
      const ox = origin.x + origin.bl;
      const oy = origin.y + origin.bt;
      for (const i of idx) {
        const t = state.images[i];
        await this._click(ox + t.x + t.w / 2, oy + t.y + t.h / 2);
        await sleep(350);
      }

      if (state.submit) {
        await this._click(ox + state.submit.x + state.submit.w / 2, oy + state.submit.y + state.submit.h / 2);
        this.onProgress('已提交本轮选择');
      }
      await sleep(3000);

      // 还有下一轮就继续
      const next = await this._findChallengeSession();
      if (!next) return true;
      this.onProgress('进入下一轮题目…');
    }
    return false;
  }
}

export default HcaptchaChallengeSolver;

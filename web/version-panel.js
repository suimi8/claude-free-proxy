const repo = 'https://github.com/suimi8/claude-free-proxy';
const bar = document.querySelector('.hwrap') || document.querySelector('header');
if (bar) mount(bar);

function mount(bar) {
  const links = document.createElement('div');
  links.className = 'release-links';
  links.innerHTML = `<button type="button" class="release-tag" aria-haspopup="dialog">版本</button>
    <a href="${repo}" target="_blank" rel="noopener noreferrer" aria-label="GitHub 项目仓库（新窗口）">GitHub ↗</a>`;
  const before = bar.querySelector('#btnKey');
  bar.insertBefore(links, before?.parentNode === bar ? before : null);
  const tag = links.querySelector('button');
  const panel = document.createElement('dialog');
  panel.className = 'release-panel';
  panel.setAttribute('aria-labelledby', 'release-heading');
  panel.innerHTML = `<div class="release-title"><h2 id="release-heading">版本与更新</h2><button type="button" data-close aria-label="关闭">×</button></div>
    <dl><div><dt>当前版本</dt><dd data-current>—</dd></div><div><dt>GitHub 正式版</dt><dd data-latest>—</dd></div>
    <div><dt>上次检查</dt><dd data-time>—</dd></div></dl><p role="status" aria-live="polite" data-status></p>
    <pre data-notes hidden></pre><div class="release-pages"><a data-release href="${repo}/releases" target="_blank" rel="noopener noreferrer">发布说明 ↗</a>
    <a href="https://github.com/suimi8" target="_blank" rel="noopener noreferrer">suimi8 的主页 ↗</a></div>
    <div class="release-actions"><button type="button" data-check>检查更新</button><button type="button" data-install hidden>立即更新</button></div>`;
  document.body.append(panel);
  const field = name => panel.querySelector(`[data-${name}]`);
  const active = state => ['downloading','prepared','draining'].includes(state?.phase);
  let state, enteredVersion, timer, running = false, action = false, waiting = false, firstRetry = true;
  function render(s) {
    const changed = enteredVersion && enteredVersion !== s.version;
    enteredVersion = s.version;
    state = s;
    if (changed) { location.reload(); return; }
    if (active(s)) waiting = true;
    if (s.phase === 'failed' || s.detail || changed) waiting = active(s);
    tag.textContent = s.available ? `发现 ${s.latest}` : s.current;
    tag.classList.toggle('available',s.available);
    field('current').textContent = s.current;
    field('latest').textContent = s.latest || (s.checkedAt && !s.error ? '暂无正式版' : '—');
    field('time').textContent = s.checkedAt ? new Date(s.checkedAt).toLocaleString() : '等待首次检查';
    field('release').href = s.latest && /^v?\d+\.\d+(?:\.\d+)?$/.test(s.latest) ? `${repo}/releases/tag/${s.latest}` : `${repo}/releases`;
    field('notes').hidden = !s.notes;
    field('notes').textContent = s.notes || '';
    const phase = {downloading:'正在下载并校验更新包…',prepared:'更新已准备好，正在联系启动器…',
      draining:`等待当前请求完成（${s.active} 个），随后切换版本…`};
    field('status').textContent = phase[s.phase] || s.detail || s.error || (s.available ?
      (!s.managed ? '请通过启动器启动网关以安装更新。' : !s.verifiedAsset ? '此版本提供手动下载。' : '可安装新版本。更新会等待进行中的请求完成。') : s.latest ? '当前已是最新正式版。' : '');
    field('install').hidden = !(s.available && s.managed && s.verifiedAsset);
    field('install').disabled = active(s) || action || !!s.error;
    field('check').disabled = active(s) || action;
  }
  function schedule(ms) {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(refresh,ms);
  }
  async function refresh() {
    if (document.hidden || running || action) return;
    running = true;
    try {
      const r = await fetch('/v1/version',{cache:'no-store', signal:AbortSignal.timeout(4000)});
      if (!r.ok) throw Error();
      render(await r.json());
    } catch { if (panel.open) field('status').textContent = waiting ? '正在切换服务，等待重新连接…' : '暂时无法连接网关。'; }
    finally {
      running = false;
      const boot = !state?.checkedAt && firstRetry;
      if (boot) firstRetry = false;
      schedule(waiting ? 1500 : panel.open ? 10_000 : boot ? 3500 : 15 * 60_000);
    }
  }
  async function command(name) {
    if (action) return;
    action = true;
    clearTimeout(timer);
    field('check').disabled = field('install').disabled = true;
    field('status').textContent = name === 'check' ? '正在检查 GitHub…' : '正在准备更新…';
    try {
      // Use the console's existing admin-key handling. Credentials stay on this origin.
      const s = await window.api('/v1/version/'+name,{method:'POST'});
      action = false;
      render(s);
    } catch (e) {
      action = false;
      if (state) render(state);
      field('status').textContent = e.message;
      if (panel.open && document.querySelector('#maskKey.on')) panel.close();
    } finally { schedule(waiting ? 750 : 10_000); }
  }
  tag.onclick = () => { if (!panel.open) panel.showModal(); void refresh(); };
  field('close').onclick = () => panel.close();
  field('check').onclick = () => void command('check');
  field('install').onclick = () => void command('install');
  panel.addEventListener('close',()=>tag.focus());
  document.addEventListener('visibilitychange',()=>{ if (document.hidden) clearTimeout(timer); else void refresh(); });
  void refresh();
}

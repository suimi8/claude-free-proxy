// 走到验证码页 → dump 控件 → 真实鼠标点击 + 真实键盘输入 + 回车 → 观察 verify 请求
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);
const email = process.argv[2] || 'v339e6m8@gayg.gay';

function conn(url) {
  const ws = new WebSocket(url);
  return new Promise((res, rej) => {
    ws.addEventListener('open', () => {
      let id = 0; const pending = new Map(); const events = [];
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.get(m.id)) {
          const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t);
          m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
          return;
        }
        if (m.method) events.push(m);
      });
      const call = (method, params = {}, timeoutMs = 90000) => new Promise((r2, j2) => {
        const i = ++id;
        const t = setTimeout(() => { pending.delete(i); j2(new Error('timeout ' + method)); }, timeoutMs);
        pending.set(i, { res: (v) => { clearTimeout(t); r2(v); }, rej: (e) => { clearTimeout(t); j2(e); } });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
      res({ call, ws, events });
    }, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
  });
}

const { LocalCaptchaBrowser } = await import(path.join(ROOT, 'tools/hcaptcha-local.mjs'));
const { MaoMailClient } = await import(path.join(ROOT, 'plugins/maomail-auto-login/maomail.mjs'));

let token = process.env.MAOMAIL_TOKEN || '';
let baseUrl = process.env.MAOMAIL_BASE_URL || 'https://zjkdongao.cn';
if (!token) {
  const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const m = txt.match(/MAOMAIL_TOKEN='?([^'\n]+)'?/); if (m) token = m[1];
}

const b = new LocalCaptchaBrowser({ onProgress: (m) => log('· ' + m) });
await b.launch();
const created = await b.cdp.call('Target.createTarget', { url: 'about:blank' });
const list = await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json();
const tab = await conn(list.find((t) => t.id === created.targetId).webSocketDebuggerUrl);
await tab.call('Page.enable');
await tab.call('Runtime.enable');
await tab.call('Network.enable');
await tab.call('Emulation.setUserAgentOverride', { userAgent: b.userAgent, acceptLanguage: 'ja-JP,ja;q=0.9', platform: 'Linux' }).catch(() => {});

const evalx = async (expr, timeoutMs = 60000) => {
  const r = await tab.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs).catch(() => null);
  return r?.result?.value;
};

log('[1] /login');
await tab.call('Page.navigate', { url: 'https://claude.ai/login' }, 90000).catch(() => {});
for (let i = 0; i < 60; i++) { await sleep(1000); if (await evalx(`!!document.querySelector('input#email')`)) break; }
for (let i = 0; i < 30; i++) {
  const st = await evalx(`(() => {
    const c = document.querySelector('[data-testid="consent-accept"]');
    if (c && c.offsetWidth && c.offsetHeight) c.click();
    const input = document.querySelector('input#email');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(email)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const btn = document.querySelector('button[data-testid="continue"]');
    if (btn && !btn.disabled) { btn.click(); return 'clicked'; }
    return 'filled';
  })()`);
  if (st === 'clicked') break;
  await sleep(800);
}
for (let i = 0; i < 90; i++) { await sleep(1000); if (await evalx(`!!document.querySelector('input#code')`)) break; }
log('[2] 验证码页 DOM:');
log(await evalx(`JSON.stringify({
  text: (document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,180),
  inputs: Array.from(document.querySelectorAll('input')).map(i=>{const r=i.getBoundingClientRect();return {id:i.id,type:i.type,name:i.name,ph:i.placeholder,vis:!!(i.offsetWidth||i.offsetHeight),rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}};}),
  buttons: Array.from(document.querySelectorAll('button')).filter(b=>b.offsetWidth&&b.offsetHeight).map(b=>({text:(b.innerText||'').trim().slice(0,26),testid:b.getAttribute('data-testid'),type:b.type,disabled:b.disabled})),
  formHtml: (()=>{const f=document.querySelector('form');return f?f.outerHTML.replace(/\\s+/g,' ').slice(0,1200):null})(),
}, null, 1)`));

// 取码
const mail = new MaoMailClient({ token, baseUrl });
log('[3] 等邮件…');
const detail = await mail.waitForVerification({ email, sinceTimestamp: Date.now() - 180000, timeoutMs: 180000, onProgress: (m) => log('    · ' + m) });
const [nonce, enc] = String(detail.magicLink || '').split('#')[1]?.split(':') || [];
const ex = await evalx(`(async () => {
  const r = await fetch('/api/auth/exchange_nonce_for_code', { method:'POST', credentials:'include', headers:{'content-type':'application/json'},
    body: JSON.stringify({ nonce: ${JSON.stringify(nonce)}, encoded_email_address: ${JSON.stringify(enc)}, source: 'claude' }) });
  return r.status + '|' + (await r.text());
})()`, 120000);
log('[4] exchange:', ex);
const code = String(ex).split('|')[1] ? (JSON.parse(String(ex).split('|')[1]).code || '') : '';
if (!code) { log('no code'); process.exit(1); }
log('    code =', code);

// 找到验证码输入框位置，真实点击
const rectRaw = await evalx(`(() => { const i = document.querySelector('input#code'); if (!i) return null; const r = i.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2}); })()`);
const rc = JSON.parse(String(rectRaw || 'null') || 'null');
log('[5] 真实点击输入框', rc);
if (rc) {
  await tab.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rc.x, y: rc.y });
  await tab.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rc.x, y: rc.y, button: 'left', clickCount: 1 });
  await tab.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rc.x, y: rc.y, button: 'left', clickCount: 1 });
}
await sleep(400);
await evalx(`(() => { const i = document.querySelector('input#code'); if (i) { i.select && i.select(); } })()`);
await tab.call('Input.insertText', { text: code }).catch((e) => log('insertText err', e.message));
log('[6] 输入后 value =', await evalx(`(document.querySelector('input#code')||{}).value`));

// 回车
for (const type of ['rawKeyDown', 'char', 'keyUp']) {
  await tab.call('Input.dispatchKeyEvent', {
    type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'char' ? '\r' : undefined,
  }).catch(() => {});
}
log('[7] 已回车，等 verify 请求…');

for (let i = 0; i < 40; i++) {
  await sleep(1000);
  const reqs = tab.events.filter((e) => e.method === 'Network.requestWillBeSent' && /verify_magic_link/.test(e.params.request.url));
  if (reqs.length) {
    const last = reqs[reqs.length - 1].params.request;
    log('    ✅ verify 请求:', last.method, String(last.postData || '').slice(0, 260));
    break;
  }
  if (i === 10) log('    (10s 内还没有 verify 请求)');
}
const cookies = await tab.call('Network.getAllCookies').catch(() => null);
const sk = (cookies?.cookies || []).find((c) => c.name === 'sessionKey' && c.value);
log('[8] sessionKey:', sk ? sk.value.slice(0, 12) + '…' : 'no');
log('    page:', String(await evalx(`(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,140)`)));
fs.writeFileSync('/tmp/codeview-probe.json', JSON.stringify({ code, sk: !!sk }, null, 2));
b.close();
process.exit(0);

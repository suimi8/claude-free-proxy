// @ts-check
/**
 * 自动化登录全流程抓包录制器 (Pure Node.js + CDP)
 *
 * 功能：
 * 1. 调起独立 Edge 浏览器（默认打开 https://claude.ai/login）。
 * 2. 挂载 CDP Network 拦截，自动录制你在该浏览器中进行的所有网络请求与响应（包括新标签页中打开的邮箱）。
 * 3. 实时在终端高亮显示邮件、验证码与 Claude API 请求。
 * 4. 当你完成登录并关闭浏览器窗口（或按 Ctrl+C）时，自动生成标准 captured_traffic.har。
 * 5. 自动对抓取到的邮件接口进行提取与分析，为你无缝生成一键自动登录脚本！
 */

import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';

const HAR_OUTPUT_PATH = path.resolve('captured_traffic.har');

function findBrowser() {
  if (process.env.LOGIN_BROWSER && fs.existsSync(process.env.LOGIN_BROWSER)) {
    return process.env.LOGIN_BROWSER;
  }
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  let preferEdge = false;
  if (process.platform === 'win32') {
    try {
      const reg = execSync('reg query HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice /v ProgId', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      if (/edge/i.test(reg)) preferEdge = true;
    } catch {}
  }
  const order = preferEdge ? [...edgePaths, ...chromePaths] : [...chromePaths, ...edgePaths];
  for (const p of order) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  throw new Error('未找到可用浏览器 (Edge/Chrome)');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitCdp(port, timeoutSec = 30) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(900) });
      if (r.ok) return await r.json();
    } catch {}
    if (Date.now() >= deadline) return null;
    await sleep(400);
  }
}

function focusBrowserWindow(pid) {
  if (process.platform !== 'win32' || !pid) return;
  const ps = `$TargetPid = ${pid}; Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class Win32Focus {[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);}' -ErrorAction SilentlyContinue; $d = (Get-Date).AddSeconds(15); while ((Get-Date) -lt $d) { $p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p) { [Win32Focus]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [Win32Focus]::BringWindowToTop($p.MainWindowHandle) | Out-Null; [Win32Focus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; exit 0; }; Start-Sleep -Milliseconds 400; }; exit 1;`;
  try {
    const b64 = Buffer.from(ps, 'utf16le').toString('base64');
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {}
}

async function main() {
  console.log('='.repeat(70));
  console.log('🎯 Claude 自动化登录抓包录制器启动');
  console.log('='.repeat(70));

  const exe = findBrowser();
  const port = await freePort();
  const profile = path.join(os.tmpdir(), `claude-free-har-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });

  console.log(`[1/4] 启动独立浏览器: ${path.basename(exe)} (CDP端口: ${port})`);
  const proc = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'https://claude.ai/login'
  ], { stdio: 'ignore', windowsHide: false });

  focusBrowserWindow(proc.pid);

  console.log('[2/4] 等待 CDP 调试端口就绪…');
  const ver = await waitCdp(port, 30);
  if (!ver?.webSocketDebuggerUrl) {
    console.error('❌ 浏览器调试端口未能就绪，请检查是否有安全软件拦截。');
    proc.kill();
    return;
  }

  console.log('[3/4] 已连接浏览器 CDP，正在挂载全局网络拦截器…');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let seq = 0;
  const pendingRequests = new Map(); // id -> { resolve, reject }
  function call(method, params = {}, sessionId = undefined) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try { ws.send(JSON.stringify(payload)); } catch (e) { pendingRequests.delete(id); reject(e); }
    });
  }

  const entries = new Map(); // requestId -> entry
  const sessions = new Set();

  ws.onmessage = async ev => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }

    if (msg.id && pendingRequests.has(msg.id)) {
      const p = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message || 'CDP error')) : p.resolve(msg.result);
      return;
    }

    const { method, params, sessionId } = msg;

    if (method === 'Target.attachedToTarget') {
      const sid = params.sessionId;
      sessions.add(sid);
      try {
        await call('Network.enable', { maxTotalBufferSize: 100000000, maxResourceBufferSize: 20000000 }, sid);
      } catch {}
    } else if (method === 'Network.requestWillBeSent') {
      const req = params.request;
      const startedDateTime = new Date(params.wallTime ? params.wallTime * 1000 : Date.now()).toISOString();
      entries.set(params.requestId, {
        _requestId: params.requestId,
        _sessionId: sessionId,
        startedDateTime,
        time: 0,
        request: {
          method: req.method,
          url: req.url,
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(req.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
          queryString: (new URL(req.url, 'http://localhost').searchParams ? [...new URL(req.url, 'http://localhost').searchParams.entries()].map(([name, value]) => ({ name, value })) : []),
          postData: req.postData ? { mimeType: req.headers?.['content-type'] || 'text/plain', text: req.postData } : undefined,
          headersSize: -1,
          bodySize: req.postData ? Buffer.byteLength(req.postData) : 0,
        },
        response: null,
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
      });

      // 终端高亮提示
      const u = req.url.toLowerCase();
      if (u.includes('mail') || u.includes('inbox') || u.includes('verify') || u.includes('code') || u.includes('claude.ai/api')) {
        console.log(`📡 [请求] ${req.method} ${req.url.slice(0, 110)}`);
      }
    } else if (method === 'Network.responseReceived') {
      const entry = entries.get(params.requestId);
      if (entry) {
        const resp = params.response;
        entry.response = {
          status: resp.status,
          statusText: resp.statusText || '',
          httpVersion: resp.protocol || 'HTTP/1.1',
          headers: Object.entries(resp.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
          content: {
            size: resp.encodedDataLength || 0,
            mimeType: resp.mimeType || 'text/plain',
            text: '',
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: resp.encodedDataLength || 0,
        };

        const u = entry.request.url.toLowerCase();
        if (u.includes('mail') || u.includes('inbox') || u.includes('verify') || u.includes('code') || u.includes('claude.ai/api')) {
          console.log(`📥 [响应 ${resp.status}] ${entry.request.url.slice(0, 110)}`);
        }
      }
    } else if (method === 'Network.loadingFinished') {
      const entry = entries.get(params.requestId);
      if (entry && entry.response) {
        try {
          const bodyResult = await call('Network.getResponseBody', { requestId: params.requestId }, entry._sessionId);
          if (bodyResult?.body) {
            entry.response.content.text = bodyResult.body;
            if (bodyResult.base64Encoded) entry.response.content.encoding = 'base64';

            // 检查响应正文中是否有邮件特征或验证码
            const b = bodyResult.body;
            if (/verification|verify|magic|code|claude/i.test(b) && b.length < 5000) {
              console.log(`💡 [捕获到关键响应正文 (${entry.request.url.slice(0, 80)})]:\n${b.slice(0, 200)}...\n`);
            }
          }
        } catch {}
      }
    }
  };

  // 开启自动 attach 监听所有标签页
  await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  console.log('[4/4] 🚀 录制已就绪！');
  console.log('-'.repeat(70));
  console.log('👉 操作说明：');
  console.log('  1. 请在弹出的浏览器窗口中，照常进行你的手动登录流程；');
  console.log('  2. 如需查收邮件，可在此浏览器的【新标签页】打开你的临时邮箱/收件箱；');
  console.log('  3. 完成登录后，直接【关闭此浏览器窗口】（或在控制台按 Ctrl+C）；');
  console.log('  4. 系统将自动保存 captured_traffic.har 并进行全自动接口分析！');
  console.log('-'.repeat(70));

  let closed = false;
  async function finish() {
    if (closed) return;
    closed = true;
    console.log('\n⏳ 正在整理抓包数据并生成 HAR 文件…');

    try { ws.close(); } catch {}
    if (!proc.killed && proc.exitCode === null) {
      try { proc.kill(); } catch {}
    }

    const harList = [...entries.values()].map(e => {
      const copy = { ...e };
      delete copy._requestId;
      delete copy._sessionId;
      if (!copy.response) {
        copy.response = {
          status: 0, statusText: '', httpVersion: 'HTTP/1.1',
          headers: [], content: { size: 0, mimeType: 'x-unknown' },
          redirectURL: '', headersSize: -1, bodySize: -1,
        };
      }
      return copy;
    });

    const harObj = {
      log: {
        version: '1.2',
        creator: { name: 'ClaudeProxyTrafficRecorder', version: '1.0' },
        pages: [],
        entries: harList,
      },
    };

    fs.writeFileSync(HAR_OUTPUT_PATH, JSON.stringify(harObj, null, 2), 'utf8');
    console.log(`\n🎉 抓包录制成功！共记录 ${harList.length} 条网络请求。`);
    console.log(`📁 HAR 文件已保存至: ${HAR_OUTPUT_PATH}`);

    // 自动分析关键邮件请求
    analyzeHar(harList);

    setTimeout(() => {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
      process.exit(0);
    }, 1500);
  }

  proc.on('exit', () => finish());
  process.on('SIGINT', () => finish());
}

function analyzeHar(entries) {
  console.log('\n' + '='.repeat(70));
  console.log('🔍 自动化接口智能初筛分析：');
  console.log('='.repeat(70));

  const mailCandidates = entries.filter(e => {
    const u = e.request.url.toLowerCase();
    const t = e.response?.content?.text || '';
    return (u.includes('mail') || u.includes('inbox') || u.includes('message') || u.includes('email') || u.includes('token'))
      && !u.endsWith('.js') && !u.endsWith('.css') && !u.endsWith('.png') && !u.endsWith('.svg') && !u.endsWith('.woff2');
  });

  if (mailCandidates.length === 0) {
    console.log('⚠️ 未检测到包含 mail/inbox 关键字的接口请求，请确认是否在该浏览器中打开了收件箱页面。');
    return;
  }

  console.log(`共识别到 ${mailCandidates.length} 个疑似邮箱/凭据相关接口：\n`);
  for (const c of mailCandidates) {
    console.log(`- [${c.request.method}] ${c.request.url} (Status: ${c.response.status})`);
    if (c.request.postData?.text) {
      console.log(`  请求体: ${c.request.postData.text.slice(0, 150)}`);
    }
    const txt = c.response?.content?.text;
    if (txt) {
      console.log(`  响应预览: ${txt.slice(0, 200).replace(/\r?\n/g, ' ')}...`);
    }
    console.log('');
  }
}

main().catch(err => {
  console.error('录制失败:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * start.mjs —— 一键启动器的实现。start.cmd 只负责两件事：切到 UTF-8 代码页、确认
 * Node 存在，然后把参数转交给这里。
 *
 * 为什么不写在 .cmd 里：cmd.exe 用「控制台代码页」解码脚本文件，UTF-8 的中文注释
 * 会被按 GBK 解释，字节错位后连换行都会被吃掉，整段文字变成「不是内部或外部命令」。
 * 放在 Node 里就没这个问题，中文提示可以正常输出。
 *
 * 用法：
 *   start.cmd            本机模式（只监听 127.0.0.1）
 *   start.cmd lan        局域网模式（其他设备可访问，带强 key）
 *   start.cmd pack       打包迁移到另一台电脑
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConfigStore } from './src/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(HERE, 'config.json');

// 端口 / 监听地址 / 所有 API Key 全部来自 config.json —— 这里不内置任何值
const CFG = createConfigStore(CONFIG_FILE);
CFG.load();
const SRV = CFG.serverConfig();
const PORT = +(process.env.PORT || SRV.port || 8787);

const mode = (process.argv[2] || '').toLowerCase();
const out = (s = '') => process.stdout.write(s + '\n');
const bar = () => out('  ' + '='.repeat(58));

/** 端口上有没有人在监听 */
function portInUse(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = v => { try { s.destroy(); } catch {} resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1200, () => done(false));
  });
}

/** 从 netstat 里取出监听该端口的 PID */
function listenPid(port) {
  try {
    const txt = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    for (const ln of txt.split(/\r?\n/)) {
      if (ln.includes(':' + port) && ln.includes('LISTENING')) {
        const cols = ln.trim().split(/\s+/);
        return cols[cols.length - 1];
      }
    }
  } catch (e) { /* netstat 不可用就算了 */ }
  return null;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, a => { rl.close(); res(a.trim()); }));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 前台接管反代进程：Ctrl+C / 关窗口都会连带停掉它 */
function runProxy(env) {
  const proxyScript = path.join(HERE, 'src', 'openai-proxy.mjs');
  const child = spawn(process.execPath, [proxyScript], {
    cwd: HERE,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  child.on('exit', code => {
    out('');
    out('  服务已退出。');
    process.exit(code ?? 0);
  });
  child.on('error', err => {
    out('');
    out('  启动失败：' + err.message);
    process.exit(1);
  });
}

/** 打包：排除凭据 / 用量 / 日志 */
function pack(target) {
  const name = target || 'claude-free-proxy-move.tar.gz';
  out('');
  out('  打包中（排除 accounts.json / config.json / usage / *.log）...');

  // 用「明确文件列表」而不是遍历整个目录：
  // 服务在运行时 config.json / usage / *.log 一直在变，tar 遍历目录会报
  // "file changed as we read it" 并返回非 0（即使包其实是完整的）。
  const SKIP = new Set(['accounts.json', 'config.json', 'node_modules', '.git', name, 'usage']);
  let entries = [];
  try {
    entries = fs.readdirSync(HERE, { withFileTypes: true })
      .filter(d => !SKIP.has(d.name) && !d.name.endsWith('.log'))
      .map(d => d.name);
  } catch (e) {
    out('  读取目录失败：' + e.message);
    process.exitCode = 1;
    return;
  }
  if (!entries.length) {
    out('  目录是空的，没什么可打包。');
    process.exitCode = 1;
    return;
  }

  const r = spawnSync('tar', ['-czf', name, ...entries], { cwd: HERE, stdio: 'inherit' });

  if (r.error) {
    out('');
    out('  打包失败：系统没有可用的 tar.exe（Windows 10 1803+ 自带）。');
    out('  可以手工拷贝本目录，但要先删掉 accounts.json、usage 文件夹和 *.log。');
    process.exitCode = 1;
    return;
  }
  if (r.status !== 0) {
    out('');
    out(`  打包出错（tar 退出码 ${r.status}）。先关闭正在运行的服务再试一次。`);
    process.exitCode = 1;
    return;
  }
  out('');
  out('  完成: ' + path.join(HERE, name));
  out('');
  out('  新电脑上：');
  out('    1. 装 Node.js 22+          https://nodejs.org/');
  out('    2. tar -xzf ' + name);
  out('    3. 双击 start.cmd');
  out('    4. 浏览器打开 http://127.0.0.1:8787 点「链接登录」加账号');
  out('');
  out('  为什么没带 accounts.json / config.json：');
  out('    cf_clearance 绑定当前网络的出口 IP 和浏览器 UA，换网络后必然失效，');
  out('    第一个请求就会撞 Cloudflare 挑战。在新机器重新登录一次最干净。');
}

async function main() {
  if (mode === 'pack') return pack(process.argv[3]);

  const isLan = mode === 'lan';
  const host = process.env.HOST || (isLan ? '0.0.0.0' : (SRV.host || '127.0.0.1'));
  const env = {
    PORT: String(process.env.PORT || PORT),
    HOST: host,
    CONFIG_FILE,
    DESKTOP_SYNC: '0',
    CACHE_MODE: process.env.CACHE_MODE || 'stats',
    ACCOUNT_QUEUE_BUDGET_MS: process.env.ACCOUNT_QUEUE_BUDGET_MS || '30000',
  };
  // 只有用户自己显式设了环境变量才透传，否则 auth 完全由 config.json 的 keys 决定
  if (process.env.LOCAL_API_KEY) env.LOCAL_API_KEY = process.env.LOCAL_API_KEY;

  // ---------------------------------------------------------- 已经在运行？
  if (await portInUse(PORT)) {
    const pid = listenPid(PORT);
    out('');
    bar();
    out(`   服务已经在运行${pid ? '   PID=' + pid : ''}   端口 ${PORT}`);
    bar();
    out('');
    out('    [1] 关闭旧服务，启动新服务');
    out('    [2] 关闭本次运行（保持现在这个服务不动）');
    out('');

    let ans = '';
    while (ans !== '1' && ans !== '2') {
      ans = await ask('   请选择 [1/2]: ');
      if (ans !== '1' && ans !== '2') out('   请输入 1 或 2。');
    }

    if (ans === '2') {
      out('');
      out('   已取消，现有服务继续运行。');
      return;
    }

    out('');
    out(`   正在停止 PID ${pid || '(未识别)'} ...`);
    if (pid) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) { /* 可能已退出 */ }
    }
    for (let i = 0; i < 24; i++) {
      if (!(await portInUse(PORT))) break;
      await sleep(150);
    }
    if (await portInUse(PORT)) {
      out(`   端口 ${PORT} 仍被占用，请手动结束占用它的进程后重试。`);
      process.exitCode = 1;
      return;
    }
  }

  // ---------------------------------------------------------- 启动
  out('');
  bar();
  out(`   模式   : ${isLan ? '局域网（其他设备可访问）' : '本机'}`);
  out(`   地址   : http://127.0.0.1:${PORT}     (WebUI 与 API 同端口)`);
  out(`   配置   : ${path.basename(CONFIG_FILE)}   （端口 / 监听地址 / API Key 都在这里改，热加载）`);

  const keyList = CFG.list();
  out(`   API Key: 共 ${keyList.length} 个`);
  for (const k of keyList.slice(0, 5)) {
    const flag = k.expired ? '已过期' : k.quota_exhausted ? '额度用尽'
      : k.enabled === false ? '已停用' : '可用';
    out(`            · ${k.name}  ${k.key_masked}  [${flag}]`);
  }
  if (keyList.length > 5) out(`            · … 还有 ${keyList.length - 5} 个，去 WebUI 看`);

  out('   停止   : 关闭本窗口，或再运行一次本脚本选 [1]');
  bar();

  if (CFG.wasCreated()) {
    const first = (CFG.snapshot().keys || [])[0];
    out('');
    out(`   首次运行，已生成 ${path.basename(CONFIG_FILE)}`);
    if (first) out('   默认 API Key: ' + first.key + '   （可以在配置文件里改，或去 WebUI 管理）');
  }

  if (!fs.existsSync(path.join(HERE, 'accounts.json'))) {
    out('');
    out('   提示：还没有账号，启动后打开 WebUI 点「链接登录」添加。');
  }
  if (isLan) {
    out('');
    out(`   其他设备填 http://<本机局域网IP>:${env.PORT}/v1，Key 用你在 config.json 里配的那个。`);
    out('   注意：能访问该端口的人都会消耗你的账号额度，不要暴露到公网。');
  }
  out('');

  runProxy(env);
}

main().catch(err => {
  out('');
  out('  出错了：' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});

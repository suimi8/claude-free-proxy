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
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataFile } from './src/paths.mjs';
import { packRelease } from './src/release-files.mjs';
import { createConfigStore } from './src/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = dataFile('config.json', process.env.CONFIG_FILE);
const mode = (process.argv[2] || '').toLowerCase();

// 端口 / 监听地址 / 所有 API Key 全部来自 config.json —— 这里不内置任何值
const CFG = createConfigStore(CONFIG_FILE);
const SRV = mode === 'pack' ? {} : (CFG.load(), CFG.serverConfig());
const PORT = +(process.env.PORT || SRV.port || 8787);

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

// Only offer an interactive restart for a ready gateway from this exact checkout.
function localGatewayPid(port) {
  const entry = path.join(HERE, 'src', 'openai-proxy.mjs');
  if (process.platform === 'win32') {
    // No shell interpolation of entry/port. Return only the listener PID, not its command line.
    const probe = [
      "$ErrorActionPreference='Stop'",
      "$ids=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:GATEWAY_PROBE_PORT) | Select-Object -ExpandProperty OwningProcess -Unique)",
      "if ($ids.Count -eq 1) { $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ids[0]); if ($p.Name -eq 'node.exe' -and $p.CommandLine.IndexOf($env:GATEWAY_PROBE_ENTRY,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $p.ProcessId } }",
    ].join('; ');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], {
      encoding:'utf8', windowsHide:true, timeout:5000, env:{...process.env,GATEWAY_PROBE_PORT:String(port),GATEWAY_PROBE_ENTRY:entry},
    });
    return r.status === 0 && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : null;
  }
  const r = spawnSync('lsof',['-nP','-t',`-iTCP:${port}`,'-sTCP:LISTEN'],{encoding:'utf8',timeout:2000});
  const pid = r.stdout?.trim();
  if (!/^\d+$/.test(pid || '')) return null;
  const args = spawnSync('ps',['-ww','-p',pid,'-o','args='],{encoding:'utf8',timeout:2000});
  return args.stdout?.trimEnd().endsWith(entry) || args.stdout?.trimEnd().endsWith(entry+'"') ? Number(pid) : null;
}

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

async function main() {
  if (mode === 'pack') return out('已校验发布包：' + packRelease(HERE, process.argv[3]));

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
    const check = spawnSync(process.execPath, [path.join(HERE, 'src/doctor.mjs'), String(PORT)], {stdio:'inherit', windowsHide:true});
    if (check.status !== 0) {
      out('   该端口被其他服务或旧版本占用；现有进程继续运行。请核对端口和原启动窗口。');
      process.exitCode = 1;
      return;
    }
    out('   已有就绪网关在运行。');
    if (!process.stdin.isTTY) return;
    const pid = localGatewayPid(PORT);
    if (!pid) { out('   如需更新，请从原启动窗口重启。'); return; }
    const input = createInterface({input:process.stdin, output:process.stdout});
    let choice;
    try { choice = (await input.question('   [1] 使用现有服务（默认）  [2] 重启本项目服务  [3] 取消：')).trim(); }
    finally { input.close(); }
    if (choice !== '2') return;
    if (localGatewayPid(PORT) !== pid) throw new Error('端口归属已变化，请重新检查');
    process.kill(pid, 'SIGTERM');
    for (let n = 0; n < 25 && await portInUse(PORT); n++) await delay(200);
    if (await portInUse(PORT)) throw new Error('端口尚未释放，请检查原启动窗口');
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

  out('   停止   : 在原启动窗口按 Ctrl+C');
  bar();

  if (CFG.wasCreated()) {
    out('首次运行：请在本机私有 config.json 中查看管理和调用 Key，不要分享该文件。');
  }

  if (!fs.existsSync(dataFile('accounts.json', process.env.ACCOUNTS_FILE))) {
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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReleaseChecker } from './github-releases.mjs';
import { downloadUpdate, stageUpdate } from './update-package.mjs';

export const codeRoot = fileURLToPath(new URL('../', import.meta.url));
export function createUpdateService() {
  const checker = createReleaseChecker();
  const managed = !!(process.send && process.env.GATEWAY_UPDATES_DIR && fs.existsSync(path.join(codeRoot,'release-integrity.json')));
  let phase = 'idle', detail = process.env.GATEWAY_UPDATE_RESULT || '', busy = false, active = 0, onDrained;
  let progress = { step: 0, total_steps: 4, pct: 0, label: '', bytes_curr: 0, bytes_total: 0 };
  function settled() {
    if (phase === 'draining' && active === 0 && onDrained) {
      const callback = onDrained;
      onDrained = null;
      callback();
    }
  }
  function enter() {
    // 坚决不因处于 draining 状态而拒绝请求返回 503！
    // 只要当前进程仍在运行，所有在途和新请求都继续正常受理并平滑处理
    active++;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        active--;
        if (phase === 'draining') {
          progress = {
            step: 4, total_steps: 4, pct: 95,
            label: active > 0 ? `在途请求处理中（剩余 ${active} 个），持续正常服务...` : '在途请求已就绪，正在无缝切入新版本...',
            bytes_curr: 0, bytes_total: 0
          };
        }
        settled();
      }
    };
  }
  function status() { return { ...checker.snapshot(), managed, phase, detail, active, progress }; }
  async function install() {
    if (busy) throw Object.assign(Error('更新正在进行'),{status:409});
    if (!managed) throw Object.assign(Error('请通过启动器或 Compose 启动服务以安装更新'),{status:409});
    const asset = checker.asset();
    if (!checker.snapshot().available || !asset) throw Object.assign(Error('当前没有已校验的可安装版本，请检查更新'),{status:409});
    busy = true; phase = 'downloading'; detail = '';
    progress = { step: 1, total_steps: 4, pct: 5, label: '正在准备下载更新包...', bytes_curr: 0, bytes_total: asset.size };
    void (async () => {
      try {
        const bytes = await downloadUpdate(asset, fetch, (curr, total) => {
          const pct = Math.min(50, Math.max(5, Math.round((curr / total) * 50)));
          progress = {
            step: 1, total_steps: 4, pct,
            label: `正在下载更新包 (${(curr / 1024).toFixed(0)} KB / ${(total / 1024).toFixed(0)} KB)...`,
            bytes_curr: curr, bytes_total: total
          };
        });
        phase = 'staging';
        progress = { step: 2, total_steps: 4, pct: 65, label: '正在校验 SHA-256 并解压暂存文件...', bytes_curr: asset.size, bytes_total: asset.size };
        const next = await stageUpdate({bytes,tag:asset.tag,currentRoot:codeRoot,installRoot:process.env.GATEWAY_INSTALL_ROOT,updatesDir:process.env.GATEWAY_UPDATES_DIR});
        phase = 'prepared';
        progress = { step: 3, total_steps: 4, pct: 85, label: '更新就绪，联系主进程平滑交接...', bytes_curr: asset.size, bytes_total: asset.size };
        await new Promise((resolve,reject) => process.send({type:'activate',...next}, err=>err?reject(err):resolve()));
      } catch (e) {
        detail = /^(运行文件|新版运行|更新包|不支持|更新文件)/.test(e.message) ? e.message : '准备更新失败，请检查网络和数据目录写权限';
        phase = 'failed'; busy = false;
        progress = { step: 0, total_steps: 4, pct: 0, label: '更新失败: ' + detail, bytes_curr: 0, bytes_total: 0 };
      }
    })();
    return status();
  }
  return {status, install, enter, check:async()=>{await checker.check(true);return status();},
    start:()=>{if(process.env.GATEWAY_UPDATE_CHECK !== '0') checker.start();},close:()=>checker.close(),
    drain(callback){
      phase = 'draining';
      progress = {
        step: 4, total_steps: 4, pct: 95,
        label: active > 0 ? `在途请求处理中（剩余 ${active} 个），持续正常服务...` : '在途请求已就绪，正在无缝切入新版本...',
        bytes_curr: 0, bytes_total: 0
      };
      onDrained = callback;
      settled();
    },
    refuse(){phase='failed';busy=false;detail='启动器未接受此次更新';},
  };
}

const staticAssets = new Map([['/ui/version-panel.js',['version-panel.js','text/javascript']],['/ui/version-panel.css',['version-panel.css','text/css']]]);
export function versionAsset(url,res) {
  const asset = staticAssets.get(url);
  if (!asset) return false;
  res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8'});
  res.end(fs.readFileSync(path.join(codeRoot,'web',asset[0])));
  return true;
}
export function withVersionPanel(html) {
  return html?.replace('</head>', '<link rel="stylesheet" href="/ui/version-panel.css"><script type="module" src="/ui/version-panel.js"></script></head>');
}

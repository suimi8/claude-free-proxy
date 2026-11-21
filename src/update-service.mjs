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
  function settled() {
    if (phase === 'draining' && active === 0 && onDrained) {
      const callback = onDrained;
      onDrained = null;
      callback();
    }
  }
  function enter() {
    if (phase === 'draining') return null;
    active++;
    let done = false;
    return () => { if (!done) { done = true; active--; settled(); } };
  }
  function status() { return { ...checker.snapshot(), managed, phase, detail, active }; }
  async function install() {
    if (busy) throw Object.assign(Error('更新正在进行'),{status:409});
    if (!managed) throw Object.assign(Error('请通过启动器或 Compose 启动服务以安装更新'),{status:409});
    const asset = checker.asset();
    if (!checker.snapshot().available || !asset) throw Object.assign(Error('当前没有已校验的可安装版本，请检查更新'),{status:409});
    busy = true; phase = 'downloading'; detail = '';
    void (async () => {
      try {
        const bytes = await downloadUpdate(asset);
        const next = await stageUpdate({bytes,tag:asset.tag,currentRoot:codeRoot,installRoot:process.env.GATEWAY_INSTALL_ROOT,updatesDir:process.env.GATEWAY_UPDATES_DIR});
        phase = 'prepared';
        await new Promise((resolve,reject) => process.send({type:'activate',...next}, err=>err?reject(err):resolve()));
      } catch (e) {
        detail = /^(运行文件|新版运行|更新包|不支持|更新文件)/.test(e.message) ? e.message : '准备更新失败，请检查网络和数据目录写权限';
        phase = 'failed'; busy = false;
      }
    })();
    return status();
  }
  return {status, install, enter, check:async()=>{await checker.check(true);return status();},
    start:()=>{if(process.env.GATEWAY_UPDATE_CHECK !== '0') checker.start();},close:()=>checker.close(),
    drain(callback){phase='draining'; onDrained=callback; settled();},
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

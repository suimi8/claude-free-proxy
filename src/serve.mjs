import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { removeSlot, slotName } from './update-package.mjs';
import { versionAfter } from './github-releases.mjs';

const installRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
function jsonFile(file) {return fs.readFile(file,'utf8').then(JSON.parse);}
export async function supervise({root=installRoot, env=process.env, onReady=()=>{}}={}) {
  const data = path.resolve(env.DATA_DIR || root);
  const updates = path.join(data,'.gateway-updates',String(Number(env.PORT || 8787)));
  const pointer = path.join(updates,'active.json');
  await fs.mkdir(updates,{recursive:true,mode:0o700});
  const rootFor = id => id === null ? root : slotName(id) ? path.join(updates,id) : (()=>{throw Error('Invalid active slot');})();
  let state = await jsonFile(pointer).catch(e=>{if(e.code !== 'ENOENT')throw e;return {active:null,previous:null};});
  rootFor(state.active);rootFor(state.previous);
  let live, stopping = false, switching = false;
  const writePointer = async next => {
    const temp = path.join(updates,randomUUID()+'.tmp');
    try {await fs.writeFile(temp,JSON.stringify(next),{flag:'wx',mode:0o600});await fs.rename(temp,pointer);state=next;}
    finally {await fs.rm(temp,{force:true});}
  };
  function launch(id,result='') {
    const dir = rootFor(id), token = randomUUID();
    const child = fork(path.join(dir,'src','openai-proxy.mjs'),[],{cwd:root,stdio:['ignore','inherit','inherit','ipc'],windowsHide:true,execArgv:[],
      env:{...env,GATEWAY_INSTALL_ROOT:root,GATEWAY_UPDATES_DIR:updates,GATEWAY_INSTANCE:token,GATEWAY_UPDATE_RESULT:result}});
    const exited = once(child,'exit');
    let accept,reject;
    const ready = new Promise((ok,fail)=>{accept=ok;reject=fail;});
    const timeout = setTimeout(()=>reject(Error('服务就绪检查超时')),15_000);
    const item = {child,ready,exited,id,version:null,expectedExit:false};
    live = item;
    child.on('message', async msg=>{
      if (msg?.type === 'listening') {
        try {
          const bound = msg.address === '::' ? '::1' : msg.address === '0.0.0.0' ? '127.0.0.1' : msg.address;
          const host = isIP(bound) === 6 ? `[${bound}]` : isIP(bound) === 4 ? bound : '127.0.0.1';
          const response=await fetch(`http://${host}:${Number(msg.port)}/readyz`,{signal:AbortSignal.timeout(3000)});
          await response.body?.cancel();
          if(response.status!==200 || response.headers.get('x-gateway-service')!=='claude-desktop-proxy' || response.headers.get('x-gateway-instance')!==token)throw Error('网关就绪身份校验失败');
          item.version=msg.version;accept();
        }catch(e){reject(e);}
      } else if (msg?.type === 'activate') {
        if (item!==live || switching || stopping || !slotName(msg.id) || !versionAfter(msg.version,item.version)) { if(child.connected)child.send({type:'refused'});return; }
        switching=true;
        void activate(item,msg).catch(e=>{console.error('[update]',e.message);process.exitCode=1;}).finally(()=>{switching=false;});
      }
    });
    exited.then(([code])=>{
      reject(Error(`网关进程退出 (${code ?? 'signal'})`));
      if(!item.expectedExit && !switching && !stopping && item.version) process.exitCode=code ?? 1;
    },reject);
    ready.then(()=>clearTimeout(timeout),()=>clearTimeout(timeout));
    return item;
  }
  async function halt(item) {
    item.expectedExit=true;
    if(item.child.exitCode==null && item.child.signalCode==null)item.child.kill();
    await item.exited.catch(()=>{});
  }
  async function start(id,result) {
    const item=launch(id,result);
    try {await item.ready;return item;}catch(e){await halt(item);throw e;}
  }
  async function activate(old,msg) {
    const previous=state.active, retired=state.previous;
    try {
      const meta=await jsonFile(path.join(rootFor(msg.id),'release-integrity.json'));
      if(meta.version!==msg.version)throw Error('暂存版本校验失败');
    }catch{if(old.child.connected)old.child.send({type:'refused'});return;}
    old.expectedExit=true;
    old.child.send({type:'drain'});
    await old.exited;
    if(stopping)return;
    try {
      const candidate=await start(msg.id,'更新成功');
      if(candidate.version!==msg.version)throw Error('新进程版本校验失败');
      await writePointer({active:msg.id,previous});
      onReady(candidate.version);
      if (retired && retired !== previous && retired !== msg.id) await removeSlot(updates,retired).catch(()=>{});
    }catch{
      if(live!==old)await halt(live);
      if(!stopping){const restored=await start(previous,'新版启动失败，已回退到上一版本');onReady(restored.version);}
      await removeSlot(updates,msg.id).catch(()=>{});
    }
  }
  const stop=()=>{stopping=true;if(live)void halt(live);};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  // A newer installation on disk takes precedence over an older downloaded slot.
  let selected = state.active;
  if (selected) {
    const staged = await jsonFile(path.join(rootFor(selected), 'package.json')).catch(() => null);
    const installed = await jsonFile(path.join(root, 'package.json'));
    if (staged && versionAfter(installed.version, staged.version)) selected = null;
  }
  try {
    const first = await start(selected, '');
    if (selected !== state.active) await writePointer({active:selected, previous:state.active});
    onReady(first.version);
  }
  catch(e){
    if(stopping)return;
    if(!state.active)throw e;
    const fallback=selected === null ? state.active : state.previous;
    const previous=await start(fallback,'启动失败，已恢复上一版本');await writePointer({active:fallback,previous:null});onReady(previous.version);
  }
  return {stop};
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) supervise().catch(e=>{console.error('[gateway]',e.message);process.exitCode=1;});

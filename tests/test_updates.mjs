import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createReleaseChecker, displayVersion, versionAfter, RELEASE_API, REPO_URL } from '../src/github-releases.mjs';
import { buildUpdate, downloadUpdate, hash, RUNTIME, stageUpdate } from '../src/update-package.mjs';
import { sandbox, project } from './offline-fixtures.mjs';

function metadata(tag, bytes = Buffer.from('sample')) {
  const name = `gateway-${tag}.update.json.gz`;
  return {tag_name:tag, draft:false, prerelease:false, body:'release notes', assets:[{
    name, browser_download_url:`${REPO_URL}/releases/download/${tag}/${name}`, digest:'sha256:'+hash(bytes), size:bytes.length,
  }]};
}

test('release checks compare versions numerically, share requests, revalidate and retain the last good result', async () => {
  assert.equal(displayVersion('0.4.0'),'v0.4');
  assert.ok(versionAfter('v0.10','0.9.8'));
  for (const v of ['v0.4','v0.3','v0.5-rc.1','v01.5','latest']) assert.equal(versionAfter(v,'0.4.0'),false);
  let now=0, hits=0, result=200;
  const checker=createReleaseChecker({version:'0.4.0',now:()=>now,fetchImpl:async(url,init)=>{
    assert.equal(url,RELEASE_API);hits++;
    assert.equal(init.headers.Authorization,undefined);
    if(hits>1) assert.equal(init.headers['If-None-Match'],'"one"');
    return new Response(result===200?JSON.stringify(metadata('v0.5')):null,{status:result,headers:{etag:'"one"'}});
  }});
  const [a,b]=await Promise.all([checker.check(),checker.check(true)]);
  assert.equal(hits,1);assert.deepEqual(a,b);assert.ok(a.available && a.verifiedAsset);
  await checker.check(true);assert.equal(hits,1);
  now+=61_000;result=304;assert.equal((await checker.check(true)).latest,'v0.5');
  now+=61_000;result=503;const failed=await checker.check(true);assert.equal(failed.latest,'v0.5');assert.ok(failed.error);assert.equal(checker.asset(),null);
  now+=61_000;result=404;const empty=await checker.check(true);assert.equal(empty.latest,null);assert.equal(empty.available,false);
  checker.close();
});

test('no prerelease or unverified download is installable and GitHub rate limits cover manual refresh', async()=>{
  for(const body of [{...metadata('v0.5'),prerelease:true}, {...metadata('v0.5'),draft:true}, metadata('latest'),{...metadata('v0.5'),assets:[]}]) {
    const checker=createReleaseChecker({fetchImpl:async()=>Response.json(body)});await checker.check();assert.equal(checker.asset(),null);checker.close();
  }
  let now=1000,hits=0;
  const checker=createReleaseChecker({now:()=>now,fetchImpl:async()=>{hits++;return new Response(null,{status:429,headers:{'retry-after':'480'}});}});
  await checker.check();now+=360_000;await checker.check(true);assert.equal(hits,1);now+=121_000;await checker.check(true);assert.equal(hits,2);checker.close();
});

test('verified download rejects modified content, unknown redirects, oversized streams and bad package paths', async(t)=>{
  const bytes=Buffer.from('update'),checker=createReleaseChecker({version:'0.4.0',fetchImpl:async()=>Response.json(metadata('v0.5',bytes))});
  await checker.check();const asset=checker.asset();
  assert.deepEqual(await downloadUpdate(asset,async()=>new Response(bytes)),bytes);
  await assert.rejects(downloadUpdate(asset,async()=>new Response('xxxxxx')),/SHA-256/);
  await assert.rejects(downloadUpdate(asset,async()=>Response.redirect('https://invalid.example/download')),/GitHub/);
  await assert.rejects(downloadUpdate(asset,async()=>new Response('oversized')),/长度/);
  const {root}=sandbox(t);
  const files=Object.fromEntries(RUNTIME.map(p=>[p,'']));files['../outside']='x';
  const invalid=gzipSync(JSON.stringify({schema:1,version:'0.5.0',files}));
  await assert.rejects(stageUpdate({bytes:invalid,tag:'v0.5',currentRoot:root,installRoot:root,updatesDir:path.join(root,'state')}),/清单/);
  assert.deepEqual(await fs.readdir(root),['tmp']);checker.close();
});

async function eventually(fn, ms=12_000) {
  const end=Date.now()+ms;let last;
  while (Date.now()<end) {try { const value=await fn(); if(value)return value; } catch(e){last=e;} await delay(80);}
  throw Error('Timed out waiting for test condition',{cause:last});
}

test('real launcher and HTTP gateway drain an in-flight request, switch, persist and roll back a broken release', {timeout:60_000}, async(t)=>{
  const box=sandbox(t),root=path.join(box.root,'app');
  await fs.mkdir(root);await fs.mkdir(path.join(root,'web'));
  await fs.cp(path.join(project,'src'),path.join(root,'src'),{recursive:true});
  for(const f of RUNTIME.filter(n=>!n.startsWith('src/'))) await fs.copyFile(path.join(project,f),path.join(root,f));
  await fs.symlink(await fs.realpath(path.join(project,'node_modules')),path.join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
  const initial=await buildUpdate(root);
  await fs.writeFile(path.join(root,'release-integrity.json'),JSON.stringify(initial.baseline));
  const installed=initial.baseline.version;
  const [major,minor]=installed.split('.').map(Number);
  const next=`${major}.${minor+1}.0`, broken=`${major}.${minor+2}.0`;
  const artifact=path.join(box.root,'asset.bin'),info=path.join(box.root,'metadata.json');
  async function publish(version, corrupt=false) {
    const payload=JSON.parse(gunzipSync(initial.bytes));payload.version=version;
    for(const name of ['package.json','package-lock.json']) {const j=JSON.parse(payload.files[name]);j.version=version;if(j.packages)j.packages[''].version=version;payload.files[name]=JSON.stringify(j,null,2)+'\n';}
    if(corrupt) payload.files['src/openai-proxy.mjs']='process.exit(42);\n';
    const bytes=gzipSync(JSON.stringify(payload));
    await fs.writeFile(artifact,bytes);await fs.writeFile(info,JSON.stringify(metadata(displayVersion(version),bytes)));
    return bytes;
  }
  const good=await publish(next);
  const loader=path.join(box.root,'offline.mjs');
  await fs.writeFile(loader,`import fs from 'node:fs/promises';
    const real=fetch;
    globalThis.fetch=async(url,init)=>{ const u=String(url); if(u===${JSON.stringify(RELEASE_API)})return new Response(await fs.readFile(${JSON.stringify(info)}));
    if(u.startsWith(${JSON.stringify(REPO_URL+'/releases/download/')}))return new Response(await fs.readFile(${JSON.stringify(artifact)}));
    if(new URL(u).hostname!=='127.0.0.1')throw Error('Unexpected external test request');return real(url,init);};`);
  const bind=http.createServer();bind.listen(0,'127.0.0.1');await once(bind,'listening');const port=bind.address().port;await new Promise(r=>bind.close(r));
  let child,closed,diagnostics='';
  async function launch() {
    child=spawn(process.execPath,['src/serve.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...box.env,PORT:String(port),GATEWAY_UPDATE_CHECK:'0',NODE_OPTIONS:'--import='+new URL('file:///'+loader.replaceAll('\\','/').replace(/^\//,'')).href}});
    closed=once(child,'exit');for(const stream of [child.stdout,child.stderr])stream.on('data',s=>{diagnostics=(diagnostics+s).slice(-900);});
    await eventually(async()=>{if(child.exitCode!==null)throw Error('Launcher exited: '+diagnostics);return (await request('/readyz')).ok;});
  }
  async function terminate(){if(child && child.exitCode===null && child.signalCode===null)child.kill();if(closed)await closed;}
  t.after(terminate);
  async function request(route,key,method='GET') {return fetch('http://127.0.0.1:'+port+route,{method,headers:key?{authorization:'Bearer '+key}:{},signal:AbortSignal.timeout(1500)});}
  async function status(){return (await request('/v1/version')).json();}
  await launch();
  const keys=JSON.parse(await fs.readFile(path.join(box.data,'config.json'),'utf8')).keys;
  const key=role=>keys.find(k=>k.role===role).key;
  assert.equal((await request('/v1/version/install',key('inference'),'POST')).status,403);
  assert.equal((await request('/v1/version/check',null,'POST')).status,401);
  const panel=await(await request('/')).text();assert.ok(panel.includes('/ui/version-panel.js'));assert.equal((await request('/ui/version-panel.css')).status,200);
  assert.ok((await(await request('/v1/version/check',key('admin'),'POST')).json()).available);
  const gate=http.request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer '+key('inference'),'content-type':'application/json'}});
  gate.on('error',()=>{});gate.on('response',res=>res.resume());gate.write('{');
  t.after(()=>gate.destroy());
  await eventually(async()=>(await status()).active>0);
  assert.equal((await request('/v1/version/install',key('admin'),'POST')).status,202);
  await eventually(async()=>(await status()).phase==='draining');assert.equal((await status()).version,installed);
  assert.equal((await request('/v1/models',key('inference'))).status,503);
  gate.end('}');await eventually(async()=>(await status()).version===next);
  await eventually(()=>fs.access(path.join(box.data,'.gateway-updates',String(port),'active.json')).then(()=>true));
  await terminate();await launch();assert.equal((await status()).version,next);
  await publish(broken,true);await request('/v1/version/check',key('admin'),'POST');await request('/v1/version/install',key('admin'),'POST');
  await eventually(async()=>{const s=await status();return s.version===next && s.detail.includes('回退');});
  assert.equal((await request('/healthz',key('admin'))).status,200);
  await terminate();
  const altered=JSON.parse(gunzipSync(good));altered.files['web/webui.html']+='\nnew';await fs.appendFile(path.join(root,'web/webui.html'),'\nlocal change');
  await assert.rejects(stageUpdate({bytes:gzipSync(JSON.stringify(altered)),tag:displayVersion(next),currentRoot:root,installRoot:root,updatesDir:path.join(box.root,'conflict')}),/冲突/);
});

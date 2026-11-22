import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseVersion, REPO_URL } from './github-releases.mjs';

// The bundle is data until its origin, digest, schema and filenames have been checked.
export const RUNTIME = Object.freeze([
  'package.json', 'package-lock.json', 'web/webui.html', 'web/version-panel.css', 'web/version-panel.js',
  ...['accounts','cf-verify','config','context-optimizer','network-optimizer','openai-proxy','child-http','init-admin',
    'operation-log','quota-probe','usage-log','kyc','paths','public-http','upstream-events','doctor',
    'github-releases','update-package','update-service','serve'].map(n => `src/${n}.mjs`),
]);
export const hash = data => createHash('sha256').update(data).digest('hex');
const canonical = text => text.replace(/\r\n/g, '\n');
const fp = text => hash(canonical(text));
const maxExpanded = 24 * 1024 * 1024;
export const slotName = id => typeof id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id);
const safeFile = name => RUNTIME.includes(name) || /^(src\/[a-z][a-z0-9-]*\.mjs|web\/[a-z][a-z0-9-]*\.(?:js|css))$/.test(name);

export async function buildUpdate(root, names = RUNTIME) {
  const files = Object.create(null);
  for (const name of names) {
    if (!safeFile(name)) throw Error('Unexpected runtime filename');
    const file = path.join(root, name);
    if (!(await fs.lstat(file)).isFile()) throw Error('Expected regular runtime file');
    files[name] = canonical(await fs.readFile(file, 'utf8'));
  }
  const version = JSON.parse(files['package.json']).version;
  const baseline = { version, files: Object.fromEntries(Object.entries(files).map(([name,text]) => [name,fp(text)])) };
  return { baseline, bytes: gzipSync(Buffer.from(JSON.stringify({ schema: 1, version, files })), { level: 9 }) };
}

export async function downloadUpdate(asset, fetchImpl = fetch) {
  if (!asset || !parseVersion(asset.tag) || asset.url !== `${REPO_URL}/releases/download/${asset.tag}/gateway-${asset.tag}.update.json.gz`
      || !/^[a-f0-9]{64}$/.test(asset.digest) || !(asset.size > 0 && asset.size <= 8 * 1024 * 1024)) throw Error('更新包元数据无效');
  let url = asset.url;
  const signal = AbortSignal.timeout(60_000);
  for (let hops = 0; hops <= 3; hops++) {
    const res = await fetchImpl(url, { redirect:'manual', credentials:'omit', signal, headers:{Accept:'application/octet-stream'} });
    if ([301,302,303,307,308].includes(res.status)) {
      await res.body?.cancel();
      const next = new URL(res.headers.get('location') || '', url);
      if (next.protocol !== 'https:' || next.username || next.password || next.port ||
          !['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname)) throw Error('更新包下载地址不在 GitHub 发布域中');
      url = next.href;
      continue;
    }
    if (res.status !== 200 || !res.body) { await res.body?.cancel(); throw Error(`更新包下载失败 (HTTP ${res.status})`); }
    let length = 0;
    const chunks = [];
    for await (const chunk of res.body) {
      if ((length += chunk.length) > asset.size) throw Error('更新包长度校验失败');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (length !== asset.size || hash(bytes) !== asset.digest) throw Error('更新包 SHA-256 或长度校验失败');
    return bytes;
  }
  throw Error('更新包重定向次数过多');
}

// Compare the dependency graph independently of the application's own version.
function dependencies(text) {
  const { packages = {}, lockfileVersion } = JSON.parse(text);
  const { version, ...definition } = packages[''] || {};
  return JSON.stringify([lockfileVersion, { ...packages, '': definition }]);
}

function mergeFile(name, local, next, baseHash) {
  if (local === null && baseHash === undefined) return next;
  if (local !== null && (fp(local) === baseHash || fp(local) === fp(next))) return next;
  if (fp(next) === baseHash && local !== null) return local;
  if (name === 'package.json' && local !== null) {
    const before = JSON.parse(local), after = JSON.parse(next);
    // A locally maintained script or packaging list can coexist with a version bump.
    if (JSON.stringify(before.dependencies) === JSON.stringify(after.dependencies) && before.type === after.type && before.name === after.name) {
      return JSON.stringify({ ...before, version:after.version }, null, 2) + '\n';
    }
  }
  throw Error(`运行文件与发布基线冲突，请先合并 ${name}`);
}

export async function stageUpdate({ bytes, tag, currentRoot, installRoot, updatesDir }) {
  const payload = JSON.parse(gunzipSync(bytes, {maxOutputLength:maxExpanded}).toString('utf8'));
  const {schema, version, files} = payload;
  if (schema !== 1 || !parseVersion(tag) || !parseVersion(version) || parseVersion(tag).join('.') !== parseVersion(version).join('.') || !files || Array.isArray(files)) throw Error('不支持的更新包版本');
  const entries = Object.entries(files);
  if (entries.length > 150 || RUNTIME.some(name => typeof files[name] !== 'string') || entries.some(([name,text]) => !safeFile(name) || typeof text !== 'string')) throw Error('更新文件清单无效');
  const pkg = JSON.parse(files['package.json']);
  if (pkg.name !== 'claude-desktop-proxy' || pkg.version !== version) throw Error('更新包项目或版本不匹配');
  const old = JSON.parse(await fs.readFile(path.join(currentRoot,'release-integrity.json'),'utf8'));
  if (dependencies(await fs.readFile(path.join(currentRoot,'package-lock.json'),'utf8')) !== dependencies(files['package-lock.json'])) throw Error('新版运行依赖已变化，请用完整发布包升级');
  if (fp(files['src/serve.mjs']) !== fp(await fs.readFile(path.join(installRoot,'src/serve.mjs'),'utf8'))) throw Error('新版运行启动器已变化，请用完整发布包升级');
  await fs.mkdir(updatesDir,{recursive:true,mode:0o700});
  if (!(await fs.lstat(updatesDir)).isDirectory()) throw Error('更新数据目录无效');
  const id = randomUUID(), dir = path.join(updatesDir,id);
  await fs.mkdir(dir,{mode:0o700});
  try {
    await fs.mkdir(path.join(dir,'src'));
    await fs.mkdir(path.join(dir,'web'));
    const digests = {};
    for (const [name, text] of entries) {
      const local = await fs.readFile(path.join(currentRoot,name),'utf8').catch(e => {if(e.code !== 'ENOENT') throw e; return null;});
      const merged = mergeFile(name, local, text, old.files[name]);
      await fs.writeFile(path.join(dir,name),merged,{flag:'wx'});
      digests[name] = fp(text);
    }
    // Retain additional local modules in a customized installation. Data and external resources stay at their original paths.
    for (const item of await fs.readdir(path.join(currentRoot,'src'),{withFileTypes:true})) {
      if (item.isFile() && /^[\w-]+\.mjs$/.test(item.name) && !Object.hasOwn(files, 'src/'+item.name) && !Object.hasOwn(old.files, 'src/'+item.name)) {
        await fs.copyFile(path.join(currentRoot,'src',item.name),path.join(dir,'src',item.name));
      }
    }
    await fs.writeFile(path.join(dir,'release-integrity.json'),JSON.stringify({version,files:digests})+'\n');
    const deps = await fs.realpath(path.join(installRoot,'node_modules'));
    await fs.symlink(deps,path.join(dir,'node_modules'),process.platform === 'win32' ? 'junction' : 'dir');
    return {id, version};
  } catch(e) {
    await removeSlot(updatesDir,id);
    throw e;
  }
}

export async function removeSlot(updatesDir,id) {
  if (!slotName(id)) throw Error('Invalid update slot');
  const base = await fs.realpath(updatesDir), slot = path.join(base,id);
  const resolved = await fs.realpath(slot).catch(e => {if(e.code !== 'ENOENT') throw e; return null;});
  if (!resolved) return;
  if (path.dirname(resolved) !== base || resolved !== slot) throw Error('Invalid slot path');
  // Detach the shared dependency directory before deleting the version directory.
  const link = path.join(slot,'node_modules');
  if ((await fs.lstat(link).catch(() => null))?.isSymbolicLink()) await fs.unlink(link);
  await fs.rm(slot,{recursive:true,force:true,maxRetries:3,retryDelay:80});
}

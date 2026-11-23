import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RELEASE_FILES, packRelease } from '../src/release-files.mjs';
import { buildUpdate, hash } from '../src/update-package.mjs';
import { displayVersion, VERSION } from '../src/github-releases.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const out = process.argv[2];
if (!out) throw Error('用法：npm run release:build -- <输出目录>');
const tracked = execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
// Every path in the public Git tree is reviewed, including files outside the installers.
const sourceOnly = ['.gitignore', '.gitattributes', 'tools/accounts.ps1', ...tracked.filter(f => f.startsWith('tests/'))];
const allowed = new Set([...RELEASE_FILES, ...sourceOnly]);
for (const name of tracked) if (!allowed.has(name)) throw Error('请从公开发布工作区构建');
const inputs = [...RELEASE_FILES.filter(name => name !== 'release-integrity.json'), ...sourceOnly];
if (inputs.some(name => !tracked.includes(name))) throw Error('请先暂存完整的公开文件清单');
execFileSync('git', ['diff', '--quiet', '--', ...inputs], {cwd:root});
const {baseline,bytes} = await buildUpdate(root);
baseline.source = {};
for (const name of RELEASE_FILES) {
  if (name !== 'release-integrity.json') {
    const file = path.join(root,name);
    if (!(await fs.lstat(file)).isFile() || await fs.realpath(file) !== file) throw Error('发布源文件无效');
    baseline.source[name] = hash((await fs.readFile(file,'utf8')).replace(/\r\n/g,'\n'));
  }
}
const directory=path.resolve(out);
await fs.mkdir(directory,{recursive:true});
const tag=displayVersion(VERSION);
await fs.writeFile(path.join(root,'release-integrity.json'), JSON.stringify(baseline,null,2)+'\n');
const archive=packRelease(root,path.join(directory,`claude-free-proxy-${tag}.tgz`));
await fs.writeFile(path.join(directory,`gateway-${tag}.update.json.gz`),bytes,{flag:'wx'});
console.log(`已生成 ${path.basename(archive)} 和 ${tag} 热更新包`);

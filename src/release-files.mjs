import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { displayVersion } from './github-releases.mjs';
import { RUNTIME, hash } from './update-package.mjs';

export const RELEASE_FILES = Object.freeze([
  '.dockerignore','Dockerfile','docker-compose.yml','LICENSE','README.md','start.cmd','start.sh','start.mjs',
  'config/accounts.example.json','config/config.example.json','config/upstream.example.json',
  ...RUNTIME,'src/release-files.mjs','release-integrity.json','tools/build-release.mjs',
]);

const canonical = bytes => bytes.toString('utf8').replace(/\r\n/g, '\n');

// In a customized checkout the exact published blob can be recovered from the local tag.
// Its digest must still match the installation's release manifest. No network access is used.
function verifiedSource(base, name, digest, tag) {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw Error(`发布清单缺少摘要 ${name}`);
  const file = path.join(base, name);
  if (fs.existsSync(file) && fs.lstatSync(file).isFile() && fs.realpathSync(file) === file) {
    const bytes = fs.readFileSync(file);
    if (hash(canonical(bytes)) === digest) return bytes;
  }
  if (fs.existsSync(path.join(base, '.git'))) {
    const blob = spawnSync('git', ['cat-file', 'blob', `refs/tags/${tag}:${name}`], {
      cwd:base, windowsHide:true, maxBuffer:16 * 1024 * 1024,
    });
    if (blob.status === 0 && hash(canonical(blob.stdout)) === digest) return blob.stdout;
  }
  throw Error(`此工作目录与公开发布清单不同 ${name}。请获取对应版本标签或使用 GitHub 完整发布包。`);
}

export function packRelease(root, target) {
  const base = fs.realpathSync(root);
  const dest = path.resolve(base, target || 'claude-free-proxy-move.tar.gz');
  if (!/\.(?:tar\.gz|tgz)$/i.test(dest) || fs.existsSync(dest)) throw Error('请选择尚不存在的 .tar.gz 或 .tgz 文件');
  const index = JSON.parse(fs.readFileSync(path.join(base, 'release-integrity.json'), 'utf8'));
  const tag = displayVersion(index.version);
  const sources = RELEASE_FILES.filter(name => name !== 'release-integrity.json');
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gateway-release-'));
  const snapshot = path.join(directory, 'content');
  const archive = path.join(directory, 'release.tgz');
  try {
    const source = {}, files = {};
    for (const name of sources) {
      const bytes = verifiedSource(base, name, index.source?.[name], tag);
      source[name] = index.source[name];
      if (RUNTIME.includes(name)) files[name] = source[name];
      const file = path.join(snapshot, name);
      fs.mkdirSync(path.dirname(file), {recursive:true});
      fs.writeFileSync(file, bytes, {flag:'wx', mode:name === 'start.sh' ? 0o755 : 0o644});
    }
    fs.writeFileSync(path.join(snapshot, 'release-integrity.json'), JSON.stringify({version:index.version, files, source}, null, 2) + '\n');
    const tar = args => {
      const result = spawnSync('tar', args, {cwd:snapshot, windowsHide:true, encoding:'utf8'});
      if (result.status !== 0) throw Error('归档处理失败');
      return result.stdout;
    };
    tar(['-czf', '../release.tgz', ...RELEASE_FILES]);
    const names = tar(['-tzf', '../release.tgz']).trim().split(/\r?\n/).sort();
    if (JSON.stringify(names) !== JSON.stringify([...RELEASE_FILES].sort())) throw Error('归档内容与清单不符');
    fs.copyFileSync(archive, dest, fs.constants.COPYFILE_EXCL);
    return dest;
  } finally {
    const target = fs.realpathSync(directory);
    if (path.dirname(target) === fs.realpathSync(os.tmpdir()) && target === directory) fs.rmSync(target, {recursive:true, force:true});
  }
}

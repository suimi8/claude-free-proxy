import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Reviewed regular files only. Never walk the worktree, even when Git is unavailable.
export const RELEASE_FILES = Object.freeze([
  '.dockerignore',
  'Dockerfile',
  'docker-compose.yml',
  'LICENSE',
  'README.md',
  'package.json',
  'package-lock.json',
  'start.cmd',
  'start.sh',
  'start.mjs',
  'web/webui.html',
  'config/accounts.example.json',
  'config/config.example.json',
  'config/upstream.example.json',
  ...[
    'accounts',
    'config',
    'context-optimizer',
    'kyc',
    'login-link',
    'network-optimizer',
    'openai-proxy',
    'child-http',
    'init-admin',
    'operation-log',
    'quota-probe',
    'usage-log',
    'paths',
    'release-files',
    'public-http',
    'upstream-events',
    'doctor',
  ].map((n) => `src/${n}.mjs`),
  ...[
    'offline-fixtures',
    'test_accounts',
    'test_context_optimizer',
    'test_network_optimizer',
    'test_hardening',
    'test_gateway',
  ].map((n) => `tests/${n}.mjs`),
]);
export function packRelease(root, target) {
  const base = fs.realpathSync(root);
  const dest = path.resolve(root, target || 'claude-free-proxy-move.tar.gz');
  if (!/\.(?:tar\.gz|tgz)$/i.test(dest) || fs.existsSync(dest))
    throw new Error('请选择尚不存在的 .tar.gz 或 .tgz 文件');
  for (const f of RELEASE_FILES) {
    const p = path.join(base, f);
    if (!fs.lstatSync(p).isFile() || fs.realpathSync(p) !== p) throw new Error(`拒绝非普通发布文件: ${f}`);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-release-'));
  const archive = path.join(temp, 'release.tgz');
  try {
    const tar = (args) => {
      const r = spawnSync('tar', args, { cwd: temp, encoding: 'utf8', windowsHide: true });
      if (r.error || r.status !== 0) throw new Error('tar 创建或校验失败');
      return r.stdout;
    };
    tar(['-czf', 'release.tgz', '-C', base, ...RELEASE_FILES]);
    const contents = tar(['-tzf', 'release.tgz']).trimEnd().split(/\r?\n/);
    if (JSON.stringify(contents.sort()) !== JSON.stringify([...RELEASE_FILES].sort()))
      throw new Error('发布包清单不匹配');
    fs.copyFileSync(archive, dest, fs.constants.COPYFILE_EXCL);
    return dest;
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmdirSync(temp);
  }
}

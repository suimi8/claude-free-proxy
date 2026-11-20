import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const project = fileURLToPath(new URL('../', import.meta.url));
export function sandbox(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'gateway-test-'));
  const tmp = path.join(root, 'tmp'),
    data = path.join(root, 'data');
  fs.mkdirSync(tmp);
  t.after(() => {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), parent);
    assert.match(path.basename(target), /^gateway-test-[\w-]+$/);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  // Whitelist OS necessities; never inherit tokens, config paths, HTTP proxies or Node preloads.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /^(path|systemroot|windir|comspec|pathext)$/i.test(k))
  );
  Object.assign(env, {
    DATA_DIR: data,
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    HOME: root,
    USERPROFILE: root,
    HOST: '127.0.0.1',
    PORT: '0',
    DESKTOP_SYNC: '0',
    UPSTREAM_IMPERSONATE: '0',
    CACHE_MODE: 'off',
  });
  return { root, data, env };
}

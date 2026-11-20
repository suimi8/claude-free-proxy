// Explicit offline migration. Stop the gateway first; never promote a distributed client key.
import fs from 'node:fs';
import { dataFile } from './paths.mjs';
import { generateId, generateKey, writePrivateJson } from './config.mjs';

const file = dataFile('config.json', process.env.CONFIG_FILE);
try {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(cfg?.keys)) throw new Error('invalid keys');
  if (cfg.keys.some((k) => k?.role === 'admin')) console.log('已有管理 Key；未修改配置。');
  else {
    cfg.keys.push({ id: generateId(), name: '管理 Key', role: 'admin', key: generateKey(), enabled: true });
    writePrivateJson(file, cfg);
    console.log('已新增独立管理 Key；请在主机私有 config.json 中查看，原调用 Key 保持不变。');
  }
} catch (e) {
  // A JSON parser may quote the malformed input in its message. Never print it here.
  console.error('未能迁移配置，请检查文件、JSON 格式及目录权限：', e.code || e.name);
  process.exitCode = 1;
}

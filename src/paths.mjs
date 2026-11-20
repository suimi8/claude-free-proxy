import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;
export function dataFile(name, override) {
  if (override) return path.resolve(override);
  const primary = path.join(DATA, name);
  const legacy = path.join(ROOT, 'config', name);
  return !process.env.DATA_DIR && !fs.existsSync(primary) && fs.existsSync(legacy) ? legacy : primary;
}

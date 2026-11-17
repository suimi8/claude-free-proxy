/**
 * 操作审计日志服务 (Operation Audit Logger)
 * 记录反代控制台所有关键操作（登录、账号增删查改、客户端调起、额度查询、风控处理、系统设置变更等）
 * 支持分类检索、状态过滤、全文搜索与持久化落盘。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'operations.jsonl');

const MAX_MEMORY_LOGS = 5000;
const memoryLogs = [];

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch {}
}

function formatTime(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

// 启动时从日志文件加载最近的历史记录到内存
function loadHistory() {
  ensureLogDir();
  if (!fs.existsSync(LOG_FILE)) return;
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const recent = lines.slice(-MAX_MEMORY_LOGS);
    for (const line of recent) {
      try {
        const item = JSON.parse(line);
        memoryLogs.push(item);
      } catch {}
    }
  } catch (err) {
    console.warn(`[operation-log] 加载历史日志失败: ${err.message}`);
  }
}

loadHistory();

/**
 * 记录一条操作日志
 * @param {Object} opt
 * @param {string} opt.category - 分类：登录认证 | 账号管理 | 客户端调起 | 额度风控 | 系统配置 | 凭据密钥
 * @param {string} opt.action - 操作名称：如 "批量导入", "打开桌面端", "查额度"
 * @param {string} [opt.target] - 操作对象：账号标识、邮箱、系统等
 * @param {'success'|'failed'} [opt.status='success'] - 状态
 * @param {string} [opt.detail=''] - 详细信息
 * @param {string} [opt.ip=''] - 来源 IP
 * @param {string} [opt.operator='WebUI'] - 操作来源
 */
export function logOperation({
  category = '账号管理',
  action = '未知操作',
  target = '-',
  status = 'success',
  detail = '',
  ip = '',
  operator = 'WebUI',
}) {
  const now = new Date();
  const record = {
    id: `op_${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: now.getTime(),
    time: formatTime(now),
    category: String(category).trim(),
    action: String(action).trim(),
    target: String(target || '-').trim(),
    status: status === 'failed' ? 'failed' : 'success',
    detail: String(detail || '').trim(),
    ip: String(ip || '').replace(/^::ffff:/, ''),
    operator: String(operator || 'WebUI'),
  };

  memoryLogs.push(record);
  if (memoryLogs.length > MAX_MEMORY_LOGS) {
    memoryLogs.shift();
  }

  // 异步追加落盘
  try {
    ensureLogDir();
    fs.appendFile(LOG_FILE, JSON.stringify(record) + '\n', 'utf8', () => {});
  } catch {}

  return record;
}

/**
 * 查询操作日志（支持分类、状态、关键字与分页）
 */
export function queryOperations({
  category = '',
  status = '',
  query = '',
  limit = 100,
  offset = 0,
} = {}) {
  let list = memoryLogs.slice().reverse(); // 最新优先

  if (category && category !== 'all' && category !== '全部') {
    list = list.filter(item => item.category === category);
  }

  if (status && status !== 'all' && status !== '全部') {
    list = list.filter(item => item.status === status);
  }

  if (query) {
    const q = String(query).toLowerCase().trim();
    list = list.filter(item => (
      item.action.toLowerCase().includes(q) ||
      item.target.toLowerCase().includes(q) ||
      item.detail.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q) ||
      item.ip.toLowerCase().includes(q) ||
      item.id.toLowerCase().includes(q)
    ));
  }

  const total = list.length;
  const start = Math.max(0, parseInt(offset, 10) || 0);
  const size = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const items = list.slice(start, start + size);

  return {
    total,
    offset: start,
    limit: size,
    items,
  };
}

/**
 * 汇总统计数据
 */
export function getOperationStats() {
  const now = new Date();
  const todayPrefix = formatTime(now).split(' ')[0]; // YYYY-MM-DD

  let todayCount = 0;
  let successCount = 0;
  let failedCount = 0;
  const categories = {};

  for (const item of memoryLogs) {
    if (item.time && item.time.startsWith(todayPrefix)) {
      todayCount++;
    }
    if (item.status === 'success') successCount++;
    else failedCount++;

    categories[item.category] = (categories[item.category] || 0) + 1;
  }

  return {
    total: memoryLogs.length,
    today: todayCount,
    success: successCount,
    failed: failedCount,
    categories,
  };
}

/**
 * 清空操作日志
 */
export function clearOperations() {
  memoryLogs.length = 0;
  try {
    ensureLogDir();
    fs.writeFileSync(LOG_FILE, '', 'utf8');
    return true;
  } catch (err) {
    console.warn(`[operation-log] 清空失败: ${err.message}`);
    return false;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The host selects trusted, installed plugins in its private manifest. Only the
// selected list handler is called, with an internal GET and a projected response.
const slug = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const text = value => typeof value === 'string' ? value.slice(0, 256) : '';
function quantity(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{1,16}(?:\.\d{1,8})?$/.test(value)) return value;
  return null;
}
const lists = new Map([
  ['mailboxes', {
    field: 'mailboxes', columns: ['邮箱', '创建时间'], action: '查看邮箱列表',
    row: m => [text(m.email || m.address || m.name), text(m.createdAt ?? m.created_at) || quantity(m.createdAt ?? m.created_at)],
  }],
  ['goods', {
    field: 'list', columns: ['商品', '库存', '单价（元）'], action: '查看商品库存',
    row: g => [text(g.name), quantity(g.stockCount), quantity(g.price)],
  }],
]);

function captureJson(response, status, body) {
  response.status = status;
  response.body = body;
}

function mailSettings(settings) {
  const keys = ['maomailToken', 'maomail_token', 'maomailBaseUrl', 'maomail_base_url'];
  return Object.fromEntries(keys.filter(k => typeof settings[k] === 'string').map(k => [k, settings[k]]));
}

async function readList(plugin) {
  if (!plugin) return [404, { error: { message: '未配置这个本地插件' } }];
  if (!plugin.handler) return [503, { error: { message: '插件的列表接口未能加载，请检查安装后重启网关' } }];
  const response = {};
  try {
    // Do not forward browser keys, cookies, query, body or socket to the plugin.
    const url = new URL(plugin.route, 'http://gateway.invalid');
    await plugin.handler({ method: 'GET', url: plugin.route, headers: {} }, response, { url, json: captureJson });
    const body = response.body;
    const items = body?.[plugin.list.field];
    if (response.status === 200 && body?.ok === true && Array.isArray(items)) {
      return [200, { columns: plugin.list.columns, total: items.length,
        rows: items.map(item => plugin.list.row(item || {})) }];
    }
  } catch { /* Provider errors may include credentials. */ }
  return [502, { error: { message: '列表读取失败，请检查插件的服务连接和登录配置后重试' } }];
}

async function bindList(directory, plugin, collection, getSettings) {
  const folder = path.join(directory, plugin.id), entry = path.join(folder, 'plugin.mjs');
  if (!fs.lstatSync(folder).isDirectory() || !fs.lstatSync(entry).isFile()) return;
  const { registerPlugin } = await import(pathToFileURL(entry).href);
  let selected;
  await registerPlugin({
    onRoute(p, fn) { if (p === plugin.route && typeof fn === 'function') selected = fn; },
    KEYS: { settings: () => collection === 'mailboxes' ? mailSettings(getSettings()) : {} },
    json: captureJson,
  });
  plugin.handler = selected;
}

export async function loadLocalPluginViews(directory, getSettings, disabled = false) {
  const installed = new Map();
  let manifestError = false;
  const registry = {
    has: id => installed.has(id),
    catalog: () => ({
      plugins: [...installed.values()].map(({ id, title, list, handler }) => ({
        id, title, action: list.action, available: Boolean(handler),
      })),
      ...(manifestError ? { notice: '本地插件清单无效，请检查本机配置。' } : {}),
    }),
    read: id => readList(installed.get(id)),
  };

  if (disabled) return registry;
  const manifest = path.join(directory, 'local-views.json');
  try {
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return registry;
    const stat = fs.lstatSync(manifest, { throwIfNoEntry: false });
    if (!stat) return registry;
    if (!stat.isFile() || stat.size > 32 * 1024) throw new Error();
    const views = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(views) || views.length > 64) throw new Error();
    for (const spec of views) {
      const { id, title, namespace, collection } = spec || {};
      const list = lists.get(collection);
      if (typeof id !== 'string' || !slug.test(id) || typeof namespace !== 'string' || !slug.test(namespace) ||
          !list || typeof title !== 'string' || !title.trim() || title.length > 80 || installed.has(id)) {
        manifestError = true;
        continue;
      }
      const plugin = { id, title, list, route: `/v1/${namespace}/${collection}`, handler: null };
      installed.set(id, plugin);
      try { await bindList(directory, plugin, collection, getSettings); }
      catch { /* Keep the next plugin available and report this one as unavailable. */ }
    }
  } catch { manifestError = true; }
  return registry;
}

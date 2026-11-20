import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The host selects trusted, installed plugins in its private manifest. Only the
// browser receives projected results. A plugin may also install its own local management forms.
const slug = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const text = value => typeof value === 'string' ? value.slice(0, 256) : '';
const localRequest = Symbol('local plugin view request');
const localResponse = Symbol('local plugin view response');
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

export async function parsePluginMultipart(contentType, body) {
  const request = new Request('http://gateway.invalid/', {
    method: 'POST', headers: { 'content-type': contentType }, body,
  });
  const form = await request.formData();
  const payload = Object.create(null);
  for (const [name, value] of form) {
    if (!Object.hasOwn(payload, name)) payload[name] = value;
    else if (Array.isArray(payload[name])) payload[name].push(value);
    else payload[name] = [payload[name], value];
  }
  return payload;
}

function mailSettings(settings) {
  const keys = ['maomailToken', 'maomail_token', 'maomailBaseUrl', 'maomail_base_url'];
  return Object.fromEntries(keys.filter(k => typeof settings[k] === 'string').map(k => [k, settings[k]]));
}

async function invoke(handler, route, method, payload) {
  const response = { [localResponse]: true };
  const url = new URL(route, 'http://gateway.invalid');
  const readBody = async () => payload;
  await handler({ method, url: route, headers: {}, payload, [localRequest]: true }, response,
    { url, json: captureJson, readBody });
  return response;
}

async function readList(plugin) {
  if (!plugin) return [404, { error: { message: '未配置这个本地插件' } }];
  if (!plugin.handler) return [503, { error: { message: '插件的列表接口未能加载，请检查安装后重启网关' } }];
  try {
    const response = await invoke(plugin.handler, plugin.route, 'GET');
    const body = response.body;
    const items = body?.[plugin.list.field];
    if (response.status === 200 && body?.ok === true && Array.isArray(items)) {
      const shopSettings = plugin.collection === 'goods' && plugin.management;
      const columns = shopSettings ? [...plugin.list.columns, '商品 ID', '累计销量'] : plugin.list.columns;
      const rows = items.map(item => {
        const row = plugin.list.row(item || {});
        if (shopSettings) row.push(quantity(item?.id), quantity(item?.sellCount));
        return row;
      });
      return [200, { columns, total: items.length, rows }];
    }
  } catch { /* Provider errors may include credentials. */ }
  return [502, { error: { message: '列表读取失败，请检查插件的服务连接和登录配置后重试' } }];
}

async function bindList(directory, plugin, collection, getSettings, writeSettings, registerRoute, runtime) {
  const folder = path.join(directory, plugin.id);
  if (!fs.lstatSync(folder).isDirectory()) return;
  let management;
  let managementError = false;
  const localEntry = path.join(folder, 'management.mjs');
  if (fs.lstatSync(localEntry, { throwIfNoEntry: false })?.isFile()) {
    try {
      const local = await import(pathToFileURL(localEntry).href);
      management = await local.createManagement({
        invoke, readList: () => readList(plugin),
        ...(collection === 'mailboxes' ? {
          getSettings: () => mailSettings(getSettings()),
          saveSettings: patch => { writeSettings(mailSettings(patch)); },
        } : {}),
      });
    } catch { managementError = true; }
  }
  plugin.managementError = managementError;
  if (management) plugin.management = management;

  const entry = path.join(folder, 'plugin.mjs');
  if (!fs.lstatSync(entry, { throwIfNoEntry: false })?.isFile()) return;
  const { registerPlugin } = await import(pathToFileURL(entry).href);
  let selected;
  const pluginJson = (res, ...args) => {
    if (res?.[localResponse]) return captureJson(res, ...args);
    if (typeof runtime.json === 'function') return runtime.json(res, ...args);
    return captureJson(res, ...args);
  };
  const pluginReadBody = req => {
    if (req?.[localRequest]) return Promise.resolve(req.payload ?? {});
    if (typeof runtime.readBody === 'function') return runtime.readBody(req);
    return Promise.resolve(req?.payload ?? {});
  };
  await registerPlugin({
    ...runtime,
    onRoute(p, fn) {
      if (p === plugin.route && typeof fn === 'function') selected = fn;
      if (typeof registerRoute === 'function' && typeof p === 'string' && typeof fn === 'function') {
        registerRoute(p, fn, plugin.id);
      }
      management?.onRoute?.(p, fn);
    },
    readBody: pluginReadBody,
    KEYS: runtime.KEYS || { settings: () => collection === 'mailboxes' ? mailSettings(getSettings()) : {} },
    json: pluginJson,
  });
  plugin.handler = selected;
}

function managementResult(plugin, action, payload) {
  const management = plugin?.management;
  const form = action && management?.forms.find(f => f.id === action);
  if (!management || (action && !form)) return [404, { error: { message: '未安装这项插件操作' } }];
  // A config update must not overwrite credentials from a simultaneous manual login.
  const next = (plugin.pending || Promise.resolve()).then(async () => {
    try {
      if (!form) return [200, await management.status()];
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).some(k => !form.fields.some(f => f.name === k))) {
        return [400, { error: { message: '表单字段无效' } }];
      }
      return await form.submit(payload);
    } catch {
      return [502, { error: { message: '插件操作失败，请检查服务连接和配置' } }];
    }
  });
  plugin.pending = next.then(() => {});
  return next;
}

export async function loadLocalPluginViews(directory, getSettings, disabled = false, writeSettings, registerRoute, runtime = {}) {
  const installed = new Map();
  let manifestError = false;
  const registry = {
    has: id => installed.has(id),
    catalog: () => ({
      plugins: [...installed.values()].map(({ id, title, list, handler, collection, management, managementError }) => ({
        id, title, action: list.action, available: Boolean(handler), collection, managementError,
        forms: (management?.forms || []).map(({ id, label, fields, confirmField, refreshList }) => ({
          id, label, fields,
          ...(confirmField && fields.some(field => field.name === confirmField) ? { confirmField } : {}),
          ...(refreshList === true ? { refreshList: true } : {}),
        })),
      })),
      ...(manifestError ? { notice: '本地插件清单无效，请检查本机配置。' } : {}),
    }),
    read: id => readList(installed.get(id)),
    status: id => managementResult(installed.get(id)),
    submit: (id, action, payload) => managementResult(installed.get(id), action, payload),
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
      const plugin = { id, title, list, collection, route: `/v1/${namespace}/${collection}`, handler: null };
      installed.set(id, plugin);
      try { await bindList(directory, plugin, collection, getSettings, writeSettings, registerRoute, runtime); }
      catch { /* Keep the next plugin available and report this one as unavailable. */ }
    }
  } catch { manifestError = true; }
  return registry;
}

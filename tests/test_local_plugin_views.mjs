import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLocalPluginViews, parsePluginMultipart } from '../src/local-plugin-views.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-plugin-views-'));
try {
  const pluginDir = path.join(root, 'fixture');
  fs.mkdirSync(pluginDir);
  const brokenDir = path.join(root, 'broken');
  fs.mkdirSync(brokenDir);
  const uploadOnlyDir = path.join(root, 'upload-only');
  fs.mkdirSync(uploadOnlyDir);
  const formOnlyDir = path.join(root, 'form-only');
  fs.mkdirSync(formOnlyDir);
  fs.writeFileSync(path.join(root, 'local-views.json'), JSON.stringify([
    { id: 'fixture', title: 'Fixture', namespace: 'fixture', collection: 'mailboxes' },
    { id: 'broken', title: 'Broken fixture', namespace: 'broken', collection: 'goods' },
    { id: 'upload-only', title: 'Upload only', namespace: 'upload_only', collection: 'goods' },
    { id: 'form-only', title: 'Form only', namespace: 'form_only', collection: 'goods' },
  ]));
  fs.writeFileSync(path.join(pluginDir, 'plugin.mjs'), `
    export async function registerPlugin({ onRoute, KEYS, POOL, LOGIN, json, readBody }) {
      onRoute('/v1/fixture/mailboxes', async (_req, res) => {
        await readBody(_req);
        json(res, 200, { ok: true, mailboxes: [{ email: 'test@example.invalid', createdAt: '2026-01-01' }] });
      });
      onRoute('/v1/fixture/create', async (req, res) => {
        const body = await readBody(req);
        json(res, 201, { ok: true, created: body.created, settings: KEYS.settings().fixture,
          pool: POOL.fixture, login: LOGIN.fixture });
      });
    }
  `);
  fs.writeFileSync(path.join(pluginDir, 'management.mjs'), `
    export async function createManagement() {
      return {
        forms: [{
          id: 'save', label: 'Save',
          fields: [
            { name: 'value', label: 'Value', type: 'text' },
            { name: 'keys', label: 'Session keys', type: 'textarea', rows: 4, sensitive: true },
          ],
          submit: async payload => [200, { message: 'saved', value: payload.value, keys: payload.keys }],
        }, {
          id: 'upload', label: 'Upload',
          fields: [
            { name: 'caption', label: 'Caption', type: 'text' },
            { name: 'file', label: 'File', type: 'file', accept: 'image/*', multiple: true },
          ],
          submit: async payload => [200, {
            message: 'upload accepted', caption: payload.caption,
            files: await Promise.all(payload.file.map(async file => ({
              name: file.name, type: file.type,
              bytes: [...new Uint8Array(await file.arrayBuffer())],
            }))),
          }],
        }],
        status: async () => ({ message: 'ready', values: {} }),
      };
    }
  `);
  fs.writeFileSync(path.join(brokenDir, 'plugin.mjs'), `
    export async function registerPlugin({ onRoute }) {
      onRoute('/v1/broken/goods', async (_req, res, { json }) => json(res, 200, { ok: true, list: [] }));
    }
  `);
  fs.writeFileSync(path.join(brokenDir, 'management.mjs'), `
    export function createManagement() { throw new Error('synthetic management load failure'); }
  `);
  fs.writeFileSync(path.join(uploadOnlyDir, 'plugin.mjs'), `
    export async function registerPlugin() {}
  `);
  fs.writeFileSync(path.join(uploadOnlyDir, 'management.mjs'), `
    export async function createManagement() {
      return {
        forms: [{
          id: 'upload', label: 'Upload sessionKey',
          fields: [{ name: 'sessionKey', label: 'sessionKey', type: 'textarea', sensitive: true }],
          submit: async payload => [200, { message: 'uploaded', count: payload.sessionKey.split('\\n').length }],
        }],
        status: async () => ({ message: 'ready', values: {} }),
      };
    }
  `);
  fs.writeFileSync(path.join(formOnlyDir, 'management.mjs'), `
    export async function createManagement() {
      return {
        forms: [{
          id: 'upload', label: 'Upload sessionKey',
          fields: [{ name: 'sessionKey', label: 'sessionKey', type: 'textarea', sensitive: true }],
          submit: async payload => [200, { message: 'uploaded', count: payload.sessionKey.split('\\n').length }],
        }],
        status: async () => ({ message: 'ready', values: {} }),
      };
    }
  `);

  const routes = new Map();
  const runtime = {
    KEYS: { settings: () => ({ fixture: 'setting' }) },
    POOL: { fixture: 'pool' },
    LOGIN: { fixture: 'login' },
    json: (res, status, body) => Object.assign(res, { status, body }),
    readBody: async req => req.body || {},
  };
  const views = await loadLocalPluginViews(root, () => ({}), false, () => {},
    (route, handler) => routes.set(route, handler), runtime);
  assert.deepEqual([...routes.keys()].sort(), [
    '/v1/broken/goods', '/v1/fixture/create', '/v1/fixture/mailboxes',
  ]);
  const [status, list] = await views.read('fixture');
  assert.equal(status, 200);
  assert.deepEqual(list, {
    columns: ['邮箱', '创建时间'],
    total: 1,
    rows: [['test@example.invalid', '2026-01-01']],
  });
  const uploadFormSpec = views.catalog().plugins[0].forms.find(form => form.id === 'upload');
  assert.equal(views.catalog().plugins[0].managementError, false);
  const brokenPlugin = views.catalog().plugins.find(plugin => plugin.id === 'broken');
  assert.equal(brokenPlugin.managementError, true);
  assert.deepEqual(brokenPlugin.forms, []);
  const uploadOnlyPlugin = views.catalog().plugins.find(plugin => plugin.id === 'upload-only');
  assert.equal(uploadOnlyPlugin.available, false);
  assert.equal(uploadOnlyPlugin.forms[0].id, 'upload');
  assert.deepEqual(await views.submit('upload-only', 'upload', { sessionKey: 'sk-test-1\nsk-test-2' }), [200, {
    message: 'uploaded', count: 2,
  }]);
  const formOnlyPlugin = views.catalog().plugins.find(plugin => plugin.id === 'form-only');
  assert.equal(formOnlyPlugin.available, false);
  assert.equal(formOnlyPlugin.forms[0].id, 'upload');
  assert.deepEqual(await views.submit('form-only', 'upload', { sessionKey: 'sk-test-1\nsk-test-2' }), [200, {
    message: 'uploaded', count: 2,
  }]);
  assert.equal(views.catalog().plugins[0].forms.find(form => form.id === 'save').fields[1].type, 'textarea');
  assert.deepEqual(uploadFormSpec.fields.map(({ name, type, accept, multiple }) =>
    ({ name, type, accept, multiple })), [
    { name: 'caption', type: 'text', accept: undefined, multiple: undefined },
    { name: 'file', type: 'file', accept: 'image/*', multiple: true },
  ]);
  assert.deepEqual(await views.submit('fixture', 'save', { value: 'synthetic setting', keys: 'sk-test-1\nsk-test-2' }), [200, {
    message: 'saved', value: 'synthetic setting', keys: 'sk-test-1\nsk-test-2',
  }]);

  const uploadForm = new FormData();
  uploadForm.set('caption', 'synthetic fixture');
  uploadForm.append('file', new Blob([Uint8Array.from([0, 1, 2, 255])], { type: 'image/png' }), 'first.png');
  uploadForm.append('file', new Blob([Uint8Array.from([10, 20, 30])], { type: 'image/jpeg' }), 'second.jpg');
  const encoded = new Request('http://gateway.invalid/upload', { method: 'POST', body: uploadForm });
  const multipartPayload = await parsePluginMultipart(encoded.headers.get('content-type'),
    Buffer.from(await encoded.arrayBuffer()));
  assert.equal(multipartPayload.caption, 'synthetic fixture');
  assert.equal(Array.isArray(multipartPayload.file), true);
  assert.deepEqual(multipartPayload.file.map(file => [file.name, file.type]), [
    ['first.png', 'image/png'], ['second.jpg', 'image/jpeg'],
  ]);

  const [uploadStatus, uploadResult] = await views.submit('fixture', 'upload', multipartPayload);
  assert.equal(uploadStatus, 200);
  assert.deepEqual(uploadResult, {
    message: 'upload accepted', caption: 'synthetic fixture',
    files: [
      { name: 'first.png', type: 'image/png', bytes: [0, 1, 2, 255] },
      { name: 'second.jpg', type: 'image/jpeg', bytes: [10, 20, 30] },
    ],
  });

  const response = {};
  await routes.get('/v1/fixture/create')({ method: 'POST', url: '/v1/fixture/create', body: { created: true } }, response, {
    url: new URL('http://gateway.invalid/v1/fixture/create'),
    json: runtime.json,
    readBody: runtime.readBody,
  });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, {
    ok: true, created: true, settings: 'setting', pool: 'pool', login: 'login',
  });
  console.log('PASS local plugin views: list projection, host runtime context, JSON operations, and multipart file uploads');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

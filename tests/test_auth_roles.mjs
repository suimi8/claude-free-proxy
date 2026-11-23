import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createConfigStore } from '../src/config.mjs';

test('RBAC: admin key vs inference key permissions', async () => {
  const tmpFile = path.join(process.cwd(), 'tests', 'temp_test_config.json');
  try {
    const initialConfig = {
      version: 1,
      server: { port: 8787, host: '127.0.0.1' },
      keys: [
        {
          id: 'k_admin',
          name: '测试管理员',
          key: 'sk-admin-test-key-12345',
          role: 'admin',
          enabled: true,
        },
        {
          id: 'k_user',
          name: '普通用户调用Key',
          key: 'sk-user-test-key-67890',
          role: 'inference',
          enabled: true,
        }
      ]
    };
    fs.writeFileSync(tmpFile, JSON.stringify(initialConfig, null, 2));
    const store = createConfigStore(tmpFile);
    store.load();

    // 1. 管理员 Key 进行 management 认证
    const adminMgmt = store.identify('sk-admin-test-key-12345', '127.0.0.1', { management: true });
    assert.equal(adminMgmt.error, undefined);
    assert.equal(adminMgmt.key.role, 'admin');

    // 2. 普通 Key 进行 management 认证 -> 拦截 403
    const userMgmt = store.identify('sk-user-test-key-67890', '127.0.0.1', { management: true });
    assert.ok(userMgmt.error);
    assert.equal(userMgmt.error.status, 403);
    assert.match(userMgmt.error.message, /仅限调用 API/);

    // 3. 普通 Key 进行 inference 认证 -> 成功放行
    const userInference = store.identify('sk-user-test-key-67890', '127.0.0.1', { management: false });
    assert.equal(userInference.error, undefined);
    assert.equal(userInference.key.role, 'inference');

    // 4. 管理员 Key 进行 inference 认证 -> 同样成功放行
    const adminInference = store.identify('sk-admin-test-key-12345', '127.0.0.1', { management: false });
    assert.equal(adminInference.error, undefined);

    // 5. 更新 role 字段测试
    store.update('k_user', { role: 'admin' });
    const userUpdated = store.identify('sk-user-test-key-67890', '127.0.0.1', { management: true });
    assert.equal(userUpdated.error, undefined);
    assert.equal(userUpdated.key.role, 'admin');

    // 6. 还原为 inference
    store.update('k_user', { role: 'inference' });
    const userDemoted = store.identify('sk-user-test-key-67890', '127.0.0.1', { management: true });
    assert.equal(userDemoted.error.status, 403);

  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

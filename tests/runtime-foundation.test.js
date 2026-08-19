'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assertRuntimeIsolation, MAIN_PARTITION } = require('../main/bootstrap/runtime-paths');
const { safeRendererPath, serveRenderer } = require('../main/protocol/app-protocol');

test('3.0 运行目录与会话分区必须独立', () => {
  assert.equal(assertRuntimeIsolation({
    userData: 'C:\\Users\\fixture\\AppData\\Roaming\\deepshui-translator-3',
    sessionData: 'C:\\Temp\\deepshui-translator-3-session',
    cache: 'C:\\Users\\fixture\\AppData\\Roaming\\deepshui-translator-3\\cache',
    logs: 'C:\\Users\\fixture\\AppData\\Roaming\\deepshui-translator-3\\logs',
    crashDumps: 'C:\\Users\\fixture\\AppData\\Roaming\\deepshui-translator-3\\crashDumps',
    partition: MAIN_PARTITION,
  }), true);
  assert.throws(() => assertRuntimeIsolation({
    userData: 'C:\\Users\\fixture\\AppData\\Roaming\\deepshui-translator',
    sessionData: 'C:\\Temp\\deepshui-translator-session',
    partition: MAIN_PARTITION,
  }), /未隔离/);
});

test('app://local 静态服务阻止目录穿越并发送严格 CSP', async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepshui-protocol-'));
  t.after(() => fsp.rm(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempDir, 'index.html'), '<!doctype html><title>fixture</title>');
  assert.equal(safeRendererPath(tempDir, '/../../secret.txt'), null);
  const response = await serveRenderer(new Request('app://local/index.html'), tempDir);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await response.text(), /fixture/);
});

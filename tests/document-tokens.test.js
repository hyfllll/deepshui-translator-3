'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DocumentTokenStore } = require('../main/services/document-tokens');

test('文档令牌限制窗口并正确处理 Range 请求', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepshui-token-'));
  const filePath = path.join(tempDir, 'fixture.pdf');
  await fs.writeFile(filePath, Buffer.from('%PDF-1234567890'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const store = new DocumentTokenStore({ ttlMs: 60_000 });
  const issued = store.issue({
    documentId: 'doc-1', filePath, webContentsId: 7,
    sessionPartition: 'persist:deepshui-translator-3', generation: 3,
  });
  assert.match(issued.url, /^app:\/\/local\/document\//);
  assert.equal(store.authorizeRequest({
    url: issued.url, method: 'GET', webContentsId: 7,
    sessionPartition: 'persist:deepshui-translator-3',
  }), true);
  const response = await store.handleRequest({
    url: issued.url,
    method: 'GET',
    headers: new Headers({ range: 'bytes=5-8' }),
  }, 'persist:deepshui-translator-3');
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 5-8/15');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(await response.text(), '1234');

  assert.equal(store.authorizeRequest({
    url: issued.url, method: 'GET', webContentsId: 8,
    sessionPartition: 'persist:deepshui-translator-3',
  }), false);
  assert.equal(store.authorizeRequest({
    url: issued.url, method: 'GET', webContentsId: 7,
    sessionPartition: 'persist:another-session',
  }), false);
  assert.equal(store.authorizeRequest({
    url: issued.url, method: 'POST', webContentsId: 7,
    sessionPartition: 'persist:deepshui-translator-3',
  }), false);

  store.revokeFor(7, 3);
  const revoked = await store.handleRequest({
    url: issued.url,
    method: 'GET',
    headers: new Headers(),
  }, 'persist:deepshui-translator-3');
  assert.equal(revoked.status, 403);
});

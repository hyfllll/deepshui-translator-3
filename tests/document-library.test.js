'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseClient } = require('../main/database/client');
const { DocumentLibraryService } = require('../main/services/document-library');

test('引用/托管导入按内容去重，托管副本可独立打开', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepshui-library-'));
  const sourcePath = path.join(tempDir, 'source.pdf');
  await fs.writeFile(sourcePath, Buffer.from('%PDF-1.4\n% minimal test fixture\n'));
  const client = new DatabaseClient(path.join(tempDir, 'library.sqlite'));
  const library = new DocumentLibraryService({ db: client, userDataPath: tempDir });
  t.after(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  await client.start();
  await library.init();

  const referenced = await library.importFile(sourcePath, { mode: 'reference' });
  const managed = await library.importFile(sourcePath, { mode: 'managed' });
  assert.equal(managed.document_id, referenced.document_id);
  assert.equal(managed.locations.length, 2);

  await fs.rm(sourcePath);
  const resolved = await library.resolveDocument(referenced.document_id);
  assert.equal(resolved.location.kind, 'managed');
  assert.match(resolved.location.canonical_path, /library[\\/][a-f0-9]{64}\.pdf$/);
});

test('重新定位拒绝内容不同的 PDF', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepshui-relink-'));
  const original = path.join(tempDir, 'original.pdf');
  const different = path.join(tempDir, 'different.pdf');
  await fs.writeFile(original, Buffer.from('%PDF-1.4\noriginal\n'));
  await fs.writeFile(different, Buffer.from('%PDF-1.4\ndifferent\n'));
  const client = new DatabaseClient(path.join(tempDir, 'library.sqlite'));
  const library = new DocumentLibraryService({ db: client, userDataPath: tempDir });
  t.after(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  await client.start();
  await library.init();
  const document = await library.importFile(original, { mode: 'reference' });
  await assert.rejects(() => library.relinkDocument(document.document_id, different), /内容与原文档不一致/);
});

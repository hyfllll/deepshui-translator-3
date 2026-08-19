'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseClient } = require('../main/database/client');

test('数据库迁移、文档去重和单调阅读进度', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepshui-db-'));
  const client = new DatabaseClient(path.join(tempDir, 'library.sqlite'));
  t.after(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const init = await client.start();
  assert.equal(init.schemaVersion, 4);

  const contentHash = crypto.createHash('sha256').update('same-pdf').digest('hex');
  const first = await client.call('upsertDocumentLocation', {
    documentId: crypto.randomUUID(),
    locationId: crypto.randomUUID(),
    kind: 'reference',
    canonicalPath: path.join(tempDir, 'paper.pdf'),
    contentHash,
    sizeBytes: 10,
    mtimeMs: 100,
    fileIdHint: '1:1',
    title: 'Paper',
  });
  const second = await client.call('upsertDocumentLocation', {
    documentId: crypto.randomUUID(),
    locationId: crypto.randomUUID(),
    kind: 'reference',
    canonicalPath: path.join(tempDir, 'paper-copy.pdf'),
    contentHash,
    sizeBytes: 10,
    mtimeMs: 100,
    fileIdHint: '1:2',
    title: 'Paper copy',
  });
  assert.equal(second.document_id, first.document_id);

  const session = await client.call('beginDocumentSession', { documentId: first.document_id });
  assert.equal(session.generation, 1);
  assert.deepEqual(await client.call('saveProgress', {
    documentId: first.document_id,
    page: 8,
    scrollRatio: 0.5,
    zoom: 1.25,
    generation: session.generation,
    baseRevision: session.revision,
  }), { accepted: true, revision: 1 });
  assert.deepEqual(await client.call('saveProgress', {
    documentId: first.document_id,
    page: 2,
    scrollRatio: 0.1,
    zoom: 1,
    generation: session.generation - 1,
    baseRevision: 1,
  }), { accepted: false, reason: 'stale_generation', currentRevision: 1 });
  const progress = await client.call('getProgress', { documentId: first.document_id });
  assert.equal(progress.page, 8);
  assert.equal(progress.revision, 1);
  const documents = await client.call('listDocuments');
  assert.equal(documents.length, 1);
  assert.equal(documents[0].current_page, 8);
});

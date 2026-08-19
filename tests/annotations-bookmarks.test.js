'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseClient } = require('../main/database/client');

test('书签与批注绑定文档 generation 并使用 CAS revision', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepshui-annotations-'));
  const client = new DatabaseClient(path.join(tempDir, 'library.sqlite'), { appVersion: 'test' });
  t.after(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  await client.start();
  const document = await client.call('upsertDocumentLocation', {
    documentId: crypto.randomUUID(), locationId: crypto.randomUUID(), kind: 'reference',
    canonicalPath: path.join(tempDir, 'fixture.pdf'), contentHash: 'a'.repeat(64),
    sizeBytes: 10, mtimeMs: 1, title: 'fixture',
  });
  const session = await client.call('beginDocumentSession', { documentId: document.document_id });
  const added = await client.call('toggleBookmark', {
    bookmarkId: crypto.randomUUID(), documentId: document.document_id,
    pageIndex: 2, generation: session.generation,
  });
  assert.equal(added.active, true);
  assert.equal((await client.call('listBookmarks', { documentId: document.document_id })).length, 1);
  const removed = await client.call('toggleBookmark', {
    bookmarkId: crypto.randomUUID(), documentId: document.document_id,
    pageIndex: 2, generation: session.generation,
  });
  assert.equal(removed.active, false);

  const annotationId = crypto.randomUUID();
  const annotation = await client.call('createAnnotation', {
    annotationId, documentId: document.document_id, pageIndex: 0,
    type: 'highlight', quads: [[1, 2, 3, 4, 5, 6, 7, 8]],
    generation: session.generation, exactText: 'hello', color: '#ffd54f',
  });
  assert.equal(annotation.revision, 1);
  assert.deepEqual(await client.call('updateAnnotation', {
    annotationId, documentId: document.document_id, generation: session.generation,
    baseRevision: 0, color: '#fff000',
  }), { accepted: false, reason: 'revision_conflict', currentRevision: 1 });
  assert.deepEqual(await client.call('updateAnnotation', {
    annotationId, documentId: document.document_id, generation: session.generation,
    baseRevision: 1, color: '#fff000',
  }), { accepted: true, revision: 2 });
  assert.deepEqual(await client.call('deleteAnnotation', {
    annotationId, documentId: document.document_id, generation: session.generation,
    baseRevision: 2,
  }), { accepted: true });
  assert.equal((await client.call('listAnnotations', { documentId: document.document_id })).length, 0);

  const newerSession = await client.call('beginDocumentSession', { documentId: document.document_id });
  assert.equal(newerSession.generation, session.generation + 1);
  await assert.rejects(() => client.call('toggleBookmark', {
    bookmarkId: crypto.randomUUID(), documentId: document.document_id,
    pageIndex: 1, generation: session.generation,
  }), /文档会话已过期/);
});

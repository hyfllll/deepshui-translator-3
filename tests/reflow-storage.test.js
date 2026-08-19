'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseClient } = require('../main/database/client');

test('本地排版缓存绑定 PDF 内容与阅读会话，并保留来源定位和视觉资源', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepshui-reflow-'));
  const client = new DatabaseClient(path.join(tempDir, 'library.sqlite'), { appVersion: 'test' });
  t.after(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  await client.start();
  const document = await client.call('upsertDocumentLocation', {
    documentId: crypto.randomUUID(),
    locationId: crypto.randomUUID(),
    kind: 'reference',
    canonicalPath: path.join(tempDir, 'paper.pdf'),
    contentHash: 'b'.repeat(64),
    sizeBytes: 128,
    mtimeMs: 1,
    title: 'paper',
  });
  const session = await client.call('beginDocumentSession', { documentId: document.document_id });
  const preferences = await client.call('saveReaderPreferences', {
    documentId: document.document_id,
    generation: session.generation,
    viewMode: 'reflow',
    zoomMode: 'fit-page',
    sidebarWidth: 512,
    sidebarCollapsed: true,
    focusMode: false,
  });
  assert.equal(preferences.view_mode, 'reflow');
  assert.equal(preferences.zoom_mode, 'fit-page');
  assert.equal(preferences.sidebar_width, 512);
  assert.equal(preferences.sidebar_collapsed, 1);

  const published = await client.call('publishReflowDocument', {
    documentId: document.document_id,
    generation: session.generation,
    sourceContentHash: 'b'.repeat(64),
    extractorVersion: 'pdfjs-renderer-v1',
    reflowVersion: 'local-heuristic-v1',
    blocks: [{
      type: 'heading',
      sourcePageStart: 0,
      sourcePageEnd: 0,
      sourceRect: { left: 0.1, top: 0.1, width: 0.8, height: 0.05 },
      textContent: 'A locally reflowed heading',
      confidence: 0.92,
      meta: { local: true },
    }, {
      type: 'paragraph',
      sourcePageStart: 0,
      sourcePageEnd: 0,
      textContent: 'The source text remains local and can be traced back to page one.',
      confidence: 0.83,
      meta: { local: true },
    }, {
      type: 'figure',
      sourcePageStart: 0,
      sourcePageEnd: 0,
      sourceRect: { left: 0.2, top: 0.3, width: 0.6, height: 0.35 },
      textContent: 'Figure on page one',
      confidence: 0.9,
      meta: { local: true, visualPreserved: true },
      asset: {
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        width: 1,
        height: 1,
      },
    }],
  });
  assert.equal(published.state, 'ready');
  assert.equal(published.blocks.length, 3);
  assert.deepEqual(published.blocks[0].source_rect, { left: 0.1, top: 0.1, width: 0.8, height: 0.05 });
  assert.equal(published.blocks[1].text_content, 'The source text remains local and can be traced back to page one.');
  assert.equal(published.blocks[2].block_type, 'figure');
  assert.equal(published.blocks[2].asset.mimeType, 'image/png');
  assert.equal(published.blocks[2].asset.width, 1);
  assert.ok(published.blocks[2].asset.bytes.byteLength > 0);

  await assert.rejects(() => client.call('publishReflowDocument', {
    documentId: document.document_id,
    generation: session.generation,
    sourceContentHash: 'b'.repeat(64),
    blocks: [{ type: 'figure', sourcePageStart: 0, sourcePageEnd: 0, textContent: 'missing asset', confidence: 1 }],
  }), /排版资源无效/);

  await assert.rejects(() => client.call('publishReflowDocument', {
    documentId: document.document_id,
    generation: session.generation,
    sourceContentHash: 'c'.repeat(64),
    blocks: [{ type: 'paragraph', sourcePageStart: 0, sourcePageEnd: 0, textContent: 'stale', confidence: 1 }],
  }), /PDF 内容已变化/);

  const changedDocument = await client.call('upsertDocumentLocation', {
    documentId: crypto.randomUUID(),
    locationId: crypto.randomUUID(),
    kind: 'reference',
    canonicalPath: path.join(tempDir, 'paper.pdf'),
    contentHash: 'c'.repeat(64),
    sizeBytes: 256,
    mtimeMs: 2,
    title: 'paper',
  });
  const changed = await client.call('getReflowDocument', { documentId: changedDocument.document_id });
  assert.equal(changed.state, 'missing');
  assert.deepEqual(changed.blocks, []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DatabaseClient } = require('../main/database/client');
const { MIGRATIONS } = require('../main/database/schema');

test('Schema 4 锁定批注、书签、任务与带视觉资源的本地排版缓存约束', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepshui-schema-'));
  const client = new DatabaseClient(path.join(tempDir, 'library.sqlite'), { appVersion: 'test' });
  t.after(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const init = await client.start();
  assert.equal(init.schemaVersion, 4);
  const result = await client.call('inspectSchema');
  for (const name of ['annotations', 'bookmarks', 'notes', 'note_annotations', 'document_pages', 'jobs', 'import_runs', 'import_items', 'document_search_unicode', 'document_search_trigram', 'reader_preferences', 'reflow_documents', 'reflow_blocks']) {
    assert.ok(result.tables.includes(name), `missing table: ${name}`);
  }
  assert.ok(result.indexes.includes('idx_bookmarks_active_page'));
  assert.ok(result.indexes.includes('idx_reflow_blocks_document_page'));
  assert.equal(result.foreignKeyViolations.length, 0);
  assert.equal(result.integrity, 'ok');
  assert.match(crypto.createHash('sha256').update(result.schemaSql.join('\n')).digest('hex'), /^[a-f0-9]{64}$/);
});

test('Schema 3 排版文字块升级到 Schema 4 后保持可读', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepshui-schema3-upgrade-'));
  const dbPath = path.join(tempDir, 'library.sqlite');
  const legacy = new DatabaseSync(dbPath);
  for (const migration of MIGRATIONS.filter((item) => item.version <= 3)) {
    legacy.exec(migration.sql);
    legacy.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(migration.version, new Date().toISOString());
    legacy.exec(`PRAGMA user_version = ${migration.version};`);
  }
  const documentId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  legacy.prepare(`
    INSERT INTO documents(document_id, content_hash, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(documentId, 'd'.repeat(64), 'legacy paper', timestamp, timestamp);
  legacy.prepare(`
    INSERT INTO reflow_documents(
      document_id, source_content_hash, extractor_version, reflow_version,
      state, block_count, revision, created_at, updated_at
    ) VALUES (?, ?, 'pdfjs-renderer-v1', 'local-heuristic-v1', 'ready', 1, 1, ?, ?)
  `).run(documentId, 'd'.repeat(64), timestamp, timestamp);
  legacy.prepare(`
    INSERT INTO reflow_blocks(
      document_id, reflow_revision, block_index, block_type, source_page_start,
      source_page_end, text_content, confidence, meta_json
    ) VALUES (?, 1, 0, 'paragraph', 0, 0, 'legacy paragraph', 0.8, '{}')
  `).run(documentId);
  legacy.close();

  const client = new DatabaseClient(dbPath, { appVersion: 'test' });
  t.after(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  assert.equal((await client.start()).schemaVersion, 4);
  const reflow = await client.call('getReflowDocument', { documentId });
  assert.equal(reflow.blocks.length, 1);
  assert.equal(reflow.blocks[0].text_content, 'legacy paragraph');
  assert.equal(reflow.blocks[0].asset, null);
});

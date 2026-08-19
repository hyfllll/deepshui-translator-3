'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DatabaseClient } = require('../main/database/client');
const { MIGRATIONS } = require('../main/database/schema');
const { fileHash } = require('../main/database/backups');

test('从 schema 1 升级前创建可校验的版本化备份', async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepshui-backup-'));
  const dbPath = path.join(tempDir, 'library.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(MIGRATIONS[0].sql);
  db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
  db.exec('PRAGMA user_version = 1;');
  db.close();

  const client = new DatabaseClient(dbPath, { appVersion: '3.0.0-test' });
  t.after(async () => {
    await client.close();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  assert.equal((await client.start()).schemaVersion, 4);
  const backupRoot = path.join(tempDir, 'backups');
  const manifestName = fs.readdirSync(backupRoot).find((name) => name.endsWith('.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, manifestName), 'utf8'));
  const backupPath = path.join(backupRoot, manifest.databaseFile);
  assert.equal(manifest.fromSchemaVersion, 1);
  assert.equal(manifest.toSchemaVersion, 4);
  assert.equal(manifest.sha256, fileHash(backupPath));
  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(backupDb.prepare('PRAGMA user_version').get().user_version, 1);
  backupDb.close();
});

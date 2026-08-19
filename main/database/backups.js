'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEEP_BACKUPS = 3;

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createMigrationBackup(dbPath, { fromVersion, toVersion, appVersion = 'unknown' }) {
  if (!fs.existsSync(dbPath)) return null;
  const backupRoot = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `library-v${fromVersion}-before-v${toVersion}-${timestamp}`;
  const backupPath = path.join(backupRoot, `${baseName}.sqlite`);
  fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
  const manifestPath = path.join(backupRoot, `${baseName}.json`);
  const manifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    appVersion,
    fromSchemaVersion: fromVersion,
    toSchemaVersion: toVersion,
    databaseFile: path.basename(backupPath),
    bytes: fs.statSync(backupPath).size,
    sha256: fileHash(backupPath),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  pruneBackups(backupRoot);
  return { backupPath, manifestPath, manifest };
}

function pruneBackups(backupRoot, keep = KEEP_BACKUPS) {
  const manifests = fs.readdirSync(backupRoot)
    .filter((name) => /^library-v\d+-before-v\d+-.*\.json$/.test(name))
    .map((name) => ({ name, path: path.join(backupRoot, name), mtimeMs: fs.statSync(path.join(backupRoot, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const old of manifests.slice(keep)) {
    let databaseFile = null;
    try { databaseFile = JSON.parse(fs.readFileSync(old.path, 'utf8')).databaseFile; } catch {}
    fs.unlinkSync(old.path);
    if (databaseFile) {
      try { fs.unlinkSync(path.join(backupRoot, databaseFile)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

module.exports = { createMigrationBackup, pruneBackups, fileHash, KEEP_BACKUPS };

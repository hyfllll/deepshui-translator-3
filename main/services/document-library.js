'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function fileIdentity(stat) {
  return `${String(stat.dev || '')}:${String(stat.ino || '')}`;
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function canonicalize(filePath) {
  const real = await fsp.realpath(filePath);
  return path.normalize(real);
}

class DocumentLibraryService {
  constructor({ db, userDataPath }) {
    this.db = db;
    this.userDataPath = userDataPath;
    this.libraryDir = path.join(userDataPath, 'library');
    this.incomingDir = path.join(this.libraryDir, '.incoming');
    this.trashDir = path.join(this.libraryDir, '.trash');
    this.importQueue = Promise.resolve();
  }

  async init() {
    await Promise.all([
      fsp.mkdir(this.libraryDir, { recursive: true }),
      fsp.mkdir(this.incomingDir, { recursive: true }),
      fsp.mkdir(this.trashDir, { recursive: true }),
    ]);
    await this.recoverPendingOperations();
  }

  enqueue(task) {
    const next = this.importQueue.then(task, task);
    this.importQueue = next.catch(() => {});
    return next;
  }

  importFile(sourcePath, options = {}) {
    return this.enqueue(() => this.importFileInternal(sourcePath, options));
  }

  async inspectPdf(sourcePath) {
    if (!sourcePath || path.extname(sourcePath).toLowerCase() !== '.pdf') {
      throw new Error('仅支持 PDF 文件');
    }
    const canonicalPath = await canonicalize(sourcePath);
    const before = await fsp.stat(canonicalPath, { bigint: false });
    if (!before.isFile()) throw new Error('目标不是文件');

    const handle = await fsp.open(canonicalPath, 'r');
    try {
      const header = Buffer.alloc(5);
      await handle.read(header, 0, 5, 0);
      if (header.toString('ascii') !== '%PDF-') throw new Error('文件不是有效的 PDF');
    } finally {
      await handle.close();
    }

    const contentHash = await hashFile(canonicalPath);
    const after = await fsp.stat(canonicalPath, { bigint: false });
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || fileIdentity(before) !== fileIdentity(after)) {
      throw new Error('文件在导入过程中发生变化，请重试');
    }
    return {
      canonicalPath,
      contentHash,
      sizeBytes: after.size,
      mtimeMs: after.mtimeMs,
      fileIdHint: fileIdentity(after),
      title: path.basename(canonicalPath, path.extname(canonicalPath)),
    };
  }

  async importFileInternal(sourcePath, options = {}) {
    const mode = options.mode === 'managed' ? 'managed' : 'reference';
    const inspected = await this.inspectPdf(sourcePath);
    const documentId = crypto.randomUUID();
    const locationId = crypto.randomUUID();

    if (mode === 'reference') {
      return this.db.call('upsertDocumentLocation', {
        documentId,
        locationId,
        kind: 'reference',
        ...inspected,
      });
    }

    const operationId = crypto.randomUUID();
    const tempPath = path.join(this.incomingDir, `${operationId}-${inspected.contentHash}.pdf.part`);
    const finalPath = path.join(this.libraryDir, `${inspected.contentHash}.pdf`);
    let payload = {
      sourcePath: inspected.canonicalPath,
      tempPath,
      finalPath,
      contentHash: inspected.contentHash,
      documentId,
      locationId,
      title: inspected.title,
    };

    await this.db.call('createOperation', {
      operationId,
      type: 'managed_import',
      state: 'planned',
      payload,
    });

    try {
      await this.db.call('updateOperation', { operationId, state: 'copying', payload });
      await fsp.copyFile(inspected.canonicalPath, tempPath);
      const tempHandle = await fsp.open(tempPath, 'r+');
      try { await tempHandle.sync(); } finally { await tempHandle.close(); }
      const copiedHash = await hashFile(tempPath);
      if (copiedHash !== inspected.contentHash) throw new Error('托管副本校验失败');

      await this.db.call('updateOperation', { operationId, state: 'verified', payload });
      try {
        await fsp.rename(tempPath, finalPath);
      } catch (error) {
        const targetExists = await fsp.access(finalPath).then(() => true, () => false);
        if (!targetExists) throw error;
        const existingHash = await hashFile(finalPath);
        if (existingHash !== inspected.contentHash) throw error;
        await fsp.rm(tempPath, { force: true });
      }

      const stat = await fsp.stat(finalPath);
      const canonicalPath = await canonicalize(finalPath);
      payload = { ...payload, finalPath: canonicalPath };
      await this.db.call('updateOperation', { operationId, state: 'file_ready', payload });
      const document = await this.db.call('upsertDocumentLocation', {
        documentId,
        locationId,
        kind: 'managed',
        canonicalPath,
        contentHash: inspected.contentHash,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        fileIdHint: fileIdentity(stat),
        title: inspected.title,
      });
      await this.db.call('updateOperation', { operationId, state: 'completed', payload });
      return document;
    } catch (error) {
      await this.db.call('updateOperation', {
        operationId,
        state: 'failed',
        payload,
        error: error.message,
      }).catch(() => {});
      throw error;
    }
  }

  async recoverPendingOperations() {
    const operations = await this.db.call('listPendingOperations');
    for (const operation of operations) {
      if (operation.type !== 'managed_import') continue;
      const payload = operation.payload || {};
      try {
        const finalExists = payload.finalPath && fs.existsSync(payload.finalPath);
        const tempExists = payload.tempPath && fs.existsSync(payload.tempPath);
        if (finalExists) {
          const stat = await fsp.stat(payload.finalPath);
          const contentHash = await hashFile(payload.finalPath);
          if (contentHash !== payload.contentHash) throw new Error('恢复时发现托管文件校验失败');
          await this.db.call('upsertDocumentLocation', {
            documentId: payload.documentId,
            locationId: payload.locationId,
            kind: 'managed',
            canonicalPath: await canonicalize(payload.finalPath),
            contentHash,
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
            fileIdHint: fileIdentity(stat),
            title: payload.title || path.basename(payload.finalPath, '.pdf'),
          });
          await this.db.call('updateOperation', {
            operationId: operation.operation_id,
            state: 'completed',
            payload,
          });
        } else {
          if (tempExists) await fsp.rm(payload.tempPath, { force: true });
          await this.db.call('updateOperation', {
            operationId: operation.operation_id,
            state: 'rolled_back',
            payload,
          });
        }
      } catch (error) {
        await this.db.call('updateOperation', {
          operationId: operation.operation_id,
          state: 'failed',
          payload,
          error: error.message,
        }).catch(() => {});
      }
    }
  }

  async listDocuments() {
    const documents = await this.db.call('listDocuments');
    for (const document of documents) {
      if (!document.file_path) continue;
      try {
        await fsp.access(document.file_path, fs.constants.R_OK);
      } catch {
        const full = await this.db.call('getDocument', { documentId: document.document_id });
        const location = full && full.locations.find((item) => item.canonical_path === document.file_path);
        if (location) await this.db.call('markLocationState', { locationId: location.location_id, state: 'missing' });
        const alternate = await this.db.call('getAvailableLocation', { documentId: document.document_id });
        document.file_path = alternate ? alternate.canonical_path : null;
        document.location_kind = alternate ? alternate.kind : null;
      }
    }
    return documents;
  }

  async resolveDocument(documentId) {
    const document = await this.db.call('getDocument', { documentId });
    if (!document) throw new Error('文档不存在');
    for (const location of document.locations.filter((item) => item.state === 'available')) {
      try {
        const stat = await fsp.stat(location.canonical_path);
        if (stat.size !== location.size_bytes || stat.mtimeMs !== location.mtime_ms) {
          await this.db.call('markLocationState', { locationId: location.location_id, state: 'stale' });
          continue;
        }
        await this.db.call('touchOpened', { documentId });
        return { document, location };
      } catch {
        await this.db.call('markLocationState', { locationId: location.location_id, state: 'missing' });
      }
    }
    throw new Error('文档文件已丢失或发生变化，请重新定位');
  }

  async relinkDocument(documentId, sourcePath) {
    const inspected = await this.inspectPdf(sourcePath);
    const document = await this.db.call('getDocument', { documentId });
    if (!document) throw new Error('文档不存在');
    if (inspected.contentHash !== document.content_hash) {
      throw new Error('所选文件内容与原文档不一致，请作为新文档导入');
    }
    const missing = document.locations.find((item) => item.state !== 'available') || document.locations[0];
    if (!missing) throw new Error('没有可重新定位的位置记录');
    return this.db.call('relinkLocation', {
      documentId,
      locationId: missing.location_id,
      ...inspected,
    });
  }
}

module.exports = { DocumentLibraryService, hashFile, canonicalize, fileIdentity };

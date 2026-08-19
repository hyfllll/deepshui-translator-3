'use strict';

const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { MIGRATIONS, SCHEMA_VERSION, MIN_SUPPORTED_SCHEMA_VERSION } = require('./schema');
const { createMigrationBackup } = require('./backups');

let db = null;

const REFLOW_TEXT_TYPES = new Set(['heading', 'paragraph', 'list', 'code', 'caption', 'equation']);
const REFLOW_ASSET_TYPES = new Set(['figure', 'table', 'formula-image']);
const REFLOW_ALLOWED_TYPES = new Set([...REFLOW_TEXT_TYPES, ...REFLOW_ASSET_TYPES]);
const REFLOW_ALLOWED_ASSET_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_REFLOW_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_REFLOW_DOCUMENT_ASSET_BYTES = 80 * 1024 * 1024;

function decodeReflowAsset(asset, blockIndex) {
  if (!asset || typeof asset !== 'object') throw new Error(`第 ${blockIndex + 1} 个排版资源无效`);
  const dataUrl = String(asset.dataUrl || '');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
  if (!match || !REFLOW_ALLOWED_ASSET_MIME_TYPES.has(match[1])) {
    throw new Error(`第 ${blockIndex + 1} 个排版资源格式无效`);
  }
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!bytes.length || bytes.length > MAX_REFLOW_ASSET_BYTES) {
    throw new Error(`第 ${blockIndex + 1} 个排版资源超过 5 MB 上限`);
  }
  const width = Number(asset.width);
  const height = Number(asset.height);
  if (!Number.isSafeInteger(width) || width < 1 || width > 8192
    || !Number.isSafeInteger(height) || height < 1 || height > 8192) {
    throw new Error(`第 ${blockIndex + 1} 个排版资源尺寸无效`);
  }
  return { mimeType: match[1], bytes, width, height };
}

function now() {
  return new Date().toISOString();
}

function openDatabase() {
  if (db) return;
  fs.mkdirSync(path.dirname(workerData.dbPath), { recursive: true });
  db = new DatabaseSync(workerData.dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  const current = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (current > SCHEMA_VERSION) {
    const error = new Error(`数据库版本 ${current} 高于程序支持的 ${SCHEMA_VERSION}；请使用新版程序或恢复兼容备份`);
    error.code = 'SCHEMA_TOO_NEW';
    throw error;
  }
  if (current > 0 && current < MIN_SUPPORTED_SCHEMA_VERSION) {
    const error = new Error(`数据库版本 ${current} 低于程序支持的最低版本 ${MIN_SUPPORTED_SCHEMA_VERSION}`);
    error.code = 'SCHEMA_TOO_OLD';
    throw error;
  }
  if (current > 0 && current < SCHEMA_VERSION) {
    db.exec('PRAGMA wal_checkpoint(FULL);');
    db.close();
    db = null;
    createMigrationBackup(workerData.dbPath, {
      fromVersion: current,
      toVersion: SCHEMA_VERSION,
      appVersion: workerData.appVersion,
    });
    db = new DatabaseSync(workerData.dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE;');
    try {
      migration.sql.split(/;\s*(?:\r?\n|$)/).forEach((statement) => {
        const sql = statement.trim();
        if (sql) db.exec(sql + ';');
      });
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(migration.version, now());
      db.exec(`PRAGMA user_version = ${migration.version};`);
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  }
}

function listDocuments() {
  return db.prepare(`
    SELECT d.*,
      (SELECT canonical_path FROM document_locations l
       WHERE l.document_id = d.document_id AND l.state = 'available'
       ORDER BY CASE l.kind WHEN 'managed' THEN 0 ELSE 1 END, l.updated_at DESC LIMIT 1) AS file_path,
      (SELECT kind FROM document_locations l
       WHERE l.document_id = d.document_id AND l.state = 'available'
       ORDER BY CASE l.kind WHEN 'managed' THEN 0 ELSE 1 END, l.updated_at DESC LIMIT 1) AS location_kind,
      COALESCE(p.page, 1) AS current_page,
      COALESCE(p.zoom, 1) AS zoom,
      COALESCE(p.scroll_ratio, 0) AS scroll_ratio
    FROM documents d
    LEFT JOIN reading_progress p ON p.document_id = d.document_id
    WHERE d.status != 'trashed'
    ORDER BY COALESCE(d.last_opened_at, d.updated_at) DESC
  `).all();
}

function getDocument({ documentId }) {
  const document = db.prepare('SELECT * FROM documents WHERE document_id = ?').get(documentId);
  if (!document) return null;
  document.locations = db.prepare(`
    SELECT * FROM document_locations WHERE document_id = ?
    ORDER BY CASE kind WHEN 'managed' THEN 0 ELSE 1 END, updated_at DESC
  `).all(documentId);
  document.progress = db.prepare('SELECT * FROM reading_progress WHERE document_id = ?').get(documentId) || null;
  return document;
}

function getDocumentByHash({ contentHash }) {
  return db.prepare('SELECT * FROM documents WHERE content_hash = ?').get(contentHash) || null;
}

function upsertDocumentLocation(payload) {
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE;');
  try {
    let document = db.prepare('SELECT * FROM documents WHERE content_hash = ?').get(payload.contentHash);
    if (!document) {
      db.prepare(`
        INSERT INTO documents(document_id, content_hash, title, page_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(payload.documentId, payload.contentHash, payload.title, payload.pageCount || null, timestamp, timestamp);
      document = db.prepare('SELECT * FROM documents WHERE document_id = ?').get(payload.documentId);
    }

    db.prepare(`
      INSERT INTO document_locations(
        location_id, document_id, kind, canonical_path, size_bytes, mtime_ms,
        file_id_hint, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)
      ON CONFLICT(canonical_path) DO UPDATE SET
        document_id = excluded.document_id,
        kind = excluded.kind,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        file_id_hint = excluded.file_id_hint,
        state = 'available',
        updated_at = excluded.updated_at
    `).run(
      payload.locationId,
      document.document_id,
      payload.kind,
      payload.canonicalPath,
      payload.sizeBytes,
      payload.mtimeMs,
      payload.fileIdHint || null,
      timestamp,
      timestamp,
    );
    db.prepare('UPDATE documents SET updated_at = ?, status = ? WHERE document_id = ?')
      .run(timestamp, 'active', document.document_id);
    db.exec('COMMIT;');
    return getDocument({ documentId: document.document_id });
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  }
}

function getAvailableLocation({ documentId }) {
  return db.prepare(`
    SELECT * FROM document_locations
    WHERE document_id = ? AND state = 'available'
    ORDER BY CASE kind WHEN 'managed' THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 1
  `).get(documentId) || null;
}

function markLocationState({ locationId, state }) {
  db.prepare('UPDATE document_locations SET state = ?, updated_at = ? WHERE location_id = ?')
    .run(state, now(), locationId);
  return true;
}

function relinkLocation(payload) {
  db.prepare(`
    UPDATE document_locations
    SET canonical_path = ?, size_bytes = ?, mtime_ms = ?, file_id_hint = ?, state = 'available', updated_at = ?
    WHERE location_id = ? AND document_id = ?
  `).run(
    payload.canonicalPath,
    payload.sizeBytes,
    payload.mtimeMs,
    payload.fileIdHint || null,
    now(),
    payload.locationId,
    payload.documentId,
  );
  return getDocument({ documentId: payload.documentId });
}

function touchOpened({ documentId }) {
  const timestamp = now();
  db.prepare('UPDATE documents SET last_opened_at = ?, updated_at = ? WHERE document_id = ?')
    .run(timestamp, timestamp, documentId);
  return true;
}

function setFavorite({ documentId, favorite }) {
  db.prepare('UPDATE documents SET favorite = ?, updated_at = ? WHERE document_id = ?')
    .run(favorite ? 1 : 0, now(), documentId);
  return true;
}

function getProgress({ documentId }) {
  return db.prepare('SELECT * FROM reading_progress WHERE document_id = ?').get(documentId) || null;
}

function beginDocumentSession({ documentId }) {
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const current = db.prepare('SELECT * FROM reading_progress WHERE document_id = ?').get(documentId);
    if (!current) {
      db.prepare(`
        INSERT INTO reading_progress(document_id, page, scroll_ratio, zoom, sidebar_mode, generation, revision, updated_at)
        VALUES (?, 1, 0, 1, 'translation', 1, 0, ?)
      `).run(documentId, timestamp);
    } else {
      db.prepare('UPDATE reading_progress SET generation = generation + 1, updated_at = ? WHERE document_id = ?')
        .run(timestamp, documentId);
    }
    const result = db.prepare('SELECT * FROM reading_progress WHERE document_id = ?').get(documentId);
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  }
}

function saveProgress(payload) {
  const current = db.prepare('SELECT generation, revision FROM reading_progress WHERE document_id = ?').get(payload.documentId);
  if (!current) return { accepted: false, reason: 'session_required', currentRevision: 0 };
  const generation = Number(payload.generation);
  const baseRevision = Number(payload.baseRevision);
  if (!Number.isSafeInteger(generation) || generation !== current.generation) {
    return { accepted: false, reason: 'stale_generation', currentRevision: current.revision };
  }
  if (!Number.isSafeInteger(baseRevision) || baseRevision !== current.revision) {
    return { accepted: false, reason: 'revision_conflict', currentRevision: current.revision };
  }
  const nextRevision = current.revision + 1;
  const result = db.prepare(`
    UPDATE reading_progress SET page = ?, scroll_ratio = ?, zoom = ?, sidebar_mode = ?,
      revision = ?, updated_at = ?
    WHERE document_id = ? AND generation = ? AND revision = ?
  `).run(
    Math.max(1, Number(payload.page) || 1),
    Math.min(1, Math.max(0, Number(payload.scrollRatio) || 0)),
    Math.max(0.1, Number(payload.zoom) || 1),
    String(payload.sidebarMode || 'translation'),
    nextRevision,
    now(),
    payload.documentId,
    generation,
    baseRevision,
  );
  return result.changes === 1
    ? { accepted: true, revision: nextRevision }
    : { accepted: false, reason: 'revision_conflict', currentRevision: current.revision };
}

function getSetting({ key }) {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value_json); } catch { return null; }
}

function setSetting({ key, value }) {
  db.prepare(`
    INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now());
  return true;
}

function getReaderPreferences({ documentId }) {
  const row = db.prepare('SELECT * FROM reader_preferences WHERE document_id = ?').get(documentId);
  return row || {
    document_id: documentId,
    view_mode: 'original',
    zoom_mode: 'fit-width',
    sidebar_width: 360,
    sidebar_collapsed: 0,
    focus_mode: 0,
    revision: 0,
  };
}

function saveReaderPreferences(payload) {
  assertCurrentGeneration(payload.documentId, payload.generation);
  const current = getReaderPreferences({ documentId: payload.documentId });
  const viewMode = ['original', 'reflow'].includes(payload.viewMode) ? payload.viewMode : current.view_mode;
  const zoomMode = ['fit-width', 'fit-page', 'actual-size', 'manual'].includes(payload.zoomMode)
    ? payload.zoomMode
    : current.zoom_mode;
  const sidebarWidth = Number.isFinite(payload.sidebarWidth)
    ? Math.max(280, Math.min(640, Math.round(payload.sidebarWidth)))
    : current.sidebar_width;
  const sidebarCollapsed = payload.sidebarCollapsed === undefined ? current.sidebar_collapsed : (payload.sidebarCollapsed ? 1 : 0);
  const focusMode = payload.focusMode === undefined ? current.focus_mode : (payload.focusMode ? 1 : 0);
  const nextRevision = Number(current.revision || 0) + 1;
  db.prepare(`
    INSERT INTO reader_preferences(
      document_id, view_mode, zoom_mode, sidebar_width, sidebar_collapsed, focus_mode, revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_id) DO UPDATE SET
      view_mode = excluded.view_mode,
      zoom_mode = excluded.zoom_mode,
      sidebar_width = excluded.sidebar_width,
      sidebar_collapsed = excluded.sidebar_collapsed,
      focus_mode = excluded.focus_mode,
      revision = excluded.revision,
      updated_at = excluded.updated_at
  `).run(payload.documentId, viewMode, zoomMode, sidebarWidth, sidebarCollapsed, focusMode, nextRevision, now());
  return getReaderPreferences({ documentId: payload.documentId });
}

function getReflowDocument({ documentId }) {
  const document = db.prepare('SELECT content_hash FROM documents WHERE document_id = ?').get(documentId);
  if (!document) return { state: 'missing', blocks: [] };
  const reflow = db.prepare(`
    SELECT * FROM reflow_documents WHERE document_id = ? AND source_content_hash = ?
  `).get(documentId, document.content_hash);
  if (!reflow || reflow.state !== 'ready') {
    return { state: reflow ? reflow.state : 'missing', reflow: reflow || null, blocks: [] };
  }
  const blocks = db.prepare(`
    SELECT * FROM reflow_blocks
    WHERE document_id = ? AND reflow_revision = ?
    ORDER BY block_index ASC
  `).all(documentId, reflow.revision).map((block) => {
    try { block.source_rect = block.source_rect_json ? JSON.parse(block.source_rect_json) : null; } catch { block.source_rect = null; }
    try { block.meta = JSON.parse(block.meta_json); } catch { block.meta = {}; }
    if (block.asset_bytes && block.asset_mime_type) {
      block.asset = {
        mimeType: block.asset_mime_type,
        bytes: Uint8Array.from(block.asset_bytes),
        width: block.asset_width,
        height: block.asset_height,
      };
    } else {
      block.asset = null;
    }
    delete block.source_rect_json;
    delete block.meta_json;
    delete block.asset_mime_type;
    delete block.asset_bytes;
    delete block.asset_width;
    delete block.asset_height;
    return block;
  });
  return { state: 'ready', reflow, blocks };
}

function publishReflowDocument(payload) {
  assertCurrentGeneration(payload.documentId, payload.generation);
  const document = db.prepare('SELECT content_hash FROM documents WHERE document_id = ?').get(payload.documentId);
  if (!document) throw new Error('排版目标文档不存在');
  if (document.content_hash !== payload.sourceContentHash) throw new Error('PDF 内容已变化，请重新生成排版');
  if (!Array.isArray(payload.blocks) || !payload.blocks.length || payload.blocks.length > 50_000) {
    throw new Error('排版块数量无效');
  }
  let totalChars = 0;
  let totalAssetBytes = 0;
  const blocks = payload.blocks.map((block, index) => {
    const text = String(block && block.textContent || '').trim();
    if (!text || text.length > 32_000) throw new Error(`第 ${index + 1} 个排版块内容无效`);
    totalChars += text.length;
    if (totalChars > 25_000_000) throw new Error('排版缓存超出单篇文档容量上限');
    if (!REFLOW_ALLOWED_TYPES.has(block.type)) throw new Error(`第 ${index + 1} 个排版块类型无效`);
    const start = Number(block.sourcePageStart);
    const end = Number(block.sourcePageEnd);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start) {
      throw new Error(`第 ${index + 1} 个排版块来源页无效`);
    }
    const asset = REFLOW_ASSET_TYPES.has(block.type) ? decodeReflowAsset(block.asset, index) : null;
    if (!asset && block.asset) throw new Error(`第 ${index + 1} 个文字排版块不能包含图片资源`);
    totalAssetBytes += asset ? asset.bytes.length : 0;
    if (totalAssetBytes > MAX_REFLOW_DOCUMENT_ASSET_BYTES) throw new Error('单篇文档的排版图片缓存超过 80 MB 上限');
    return {
      type: block.type,
      sourcePageStart: start,
      sourcePageEnd: end,
      sourceRect: block.sourceRect && typeof block.sourceRect === 'object' ? block.sourceRect : null,
      text,
      confidence: Math.max(0, Math.min(1, Number(block.confidence) || 0)),
      meta: block.meta && typeof block.meta === 'object' ? block.meta : {},
      asset,
    };
  });
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const existing = db.prepare('SELECT revision FROM reflow_documents WHERE document_id = ?').get(payload.documentId);
    const revision = Number(existing && existing.revision || 0) + 1;
    db.prepare(`
      INSERT INTO reflow_documents(
        document_id, source_content_hash, extractor_version, reflow_version, state,
        block_count, error_code, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'ready', ?, NULL, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET
        source_content_hash = excluded.source_content_hash,
        extractor_version = excluded.extractor_version,
        reflow_version = excluded.reflow_version,
        state = 'ready', block_count = excluded.block_count, error_code = NULL,
        revision = excluded.revision, updated_at = excluded.updated_at
    `).run(
      payload.documentId,
      payload.sourceContentHash,
      String(payload.extractorVersion || 'pdfjs-local-v1'),
      String(payload.reflowVersion || 'heuristic-v1'),
      blocks.length,
      revision,
      existing ? timestamp : timestamp,
      timestamp,
    );
    db.prepare('DELETE FROM reflow_blocks WHERE document_id = ?').run(payload.documentId);
    const insert = db.prepare(`
      INSERT INTO reflow_blocks(
        document_id, reflow_revision, block_index, block_type, source_page_start,
        source_page_end, source_rect_json, text_content, confidence, meta_json,
        asset_mime_type, asset_bytes, asset_width, asset_height
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      insert.run(
        payload.documentId, revision, index, block.type, block.sourcePageStart, block.sourcePageEnd,
        block.sourceRect ? JSON.stringify(block.sourceRect) : null, block.text, block.confidence, JSON.stringify(block.meta),
        block.asset ? block.asset.mimeType : null,
        block.asset ? block.asset.bytes : null,
        block.asset ? block.asset.width : null,
        block.asset ? block.asset.height : null,
      );
    }
    db.exec('COMMIT;');
    return getReflowDocument({ documentId: payload.documentId });
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  }
}

function createOperation(payload) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO operations(operation_id, type, state, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(payload.operationId, payload.type, payload.state, JSON.stringify(payload.payload || {}), timestamp, timestamp);
  return true;
}

function updateOperation(payload) {
  db.prepare(`
    UPDATE operations SET state = ?, payload_json = ?, error = ?, updated_at = ?
    WHERE operation_id = ?
  `).run(
    payload.state,
    JSON.stringify(payload.payload || {}),
    payload.error || null,
    now(),
    payload.operationId,
  );
  return true;
}

function listPendingOperations() {
  return db.prepare(`
    SELECT * FROM operations
    WHERE state NOT IN ('completed', 'rolled_back')
      AND (state != 'failed' OR type = 'managed_import')
    ORDER BY created_at ASC
  `).all().map((row) => {
    try { row.payload = JSON.parse(row.payload_json); } catch { row.payload = {}; }
    return row;
  });
}

function inspectSchema() {
  const objects = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type, name
  `).all();
  return {
    tables: objects.filter((row) => row.type === 'table').map((row) => row.name),
    indexes: objects.filter((row) => row.type === 'index').map((row) => row.name),
    schemaSql: objects.map((row) => row.sql),
    foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all(),
    integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
  };
}

function enqueueJob(payload) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO jobs(
      job_id, idempotency_key, type, document_id, page_index, input_version,
      priority, state, max_attempts, checkpoint_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `).run(
    payload.jobId,
    payload.idempotencyKey,
    payload.type,
    payload.documentId || null,
    Number.isSafeInteger(payload.pageIndex) ? payload.pageIndex : null,
    String(payload.inputVersion),
    Number.isFinite(payload.priority) ? Number(payload.priority) : 100,
    Math.max(1, Number(payload.maxAttempts) || 3),
    JSON.stringify(payload.checkpoint || null),
    timestamp,
    timestamp,
  );
  return db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(payload.idempotencyKey);
}

function leaseNextJob(payload) {
  const timestamp = now();
  const leaseExpiresAt = new Date(Date.now() + Math.max(1000, Number(payload.leaseMs) || 30000)).toISOString();
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE jobs SET state = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'queued' END,
        lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ?
      WHERE state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    `).run(timestamp, timestamp);
    const supportedTypes = Array.isArray(payload.types) ? payload.types.filter(Boolean) : [];
    if (!supportedTypes.length) {
      db.exec('COMMIT;');
      return null;
    }
    const placeholders = supportedTypes.map(() => '?').join(',');
    const job = db.prepare(`
      SELECT * FROM jobs
      WHERE state = 'queued' AND cancel_requested = 0 AND attempt < max_attempts
        AND type IN (${placeholders})
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `).get(...supportedTypes);
    if (!job) {
      db.exec('COMMIT;');
      return null;
    }
    const result = db.prepare(`
      UPDATE jobs SET state = 'running', lease_owner = ?, lease_expires_at = ?,
        heartbeat_at = ?, attempt = attempt + 1, updated_at = ?
      WHERE job_id = ? AND state = 'queued'
    `).run(payload.workerId, leaseExpiresAt, timestamp, timestamp, job.job_id);
    const leased = result.changes === 1 ? db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.job_id) : null;
    db.exec('COMMIT;');
    return leased;
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  }
}

function heartbeatJob(payload) {
  const timestamp = now();
  const leaseExpiresAt = new Date(Date.now() + Math.max(1000, Number(payload.leaseMs) || 30000)).toISOString();
  const result = db.prepare(`
    UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
    WHERE job_id = ? AND state = 'running' AND lease_owner = ?
  `).run(timestamp, leaseExpiresAt, timestamp, payload.jobId, payload.workerId);
  return { accepted: result.changes === 1, leaseExpiresAt };
}

function checkpointJob(payload) {
  const result = db.prepare(`
    UPDATE jobs SET checkpoint_json = ?, updated_at = ?
    WHERE job_id = ? AND state = 'running' AND lease_owner = ?
  `).run(JSON.stringify(payload.checkpoint || null), now(), payload.jobId, payload.workerId);
  return { accepted: result.changes === 1 };
}

function completeJob(payload) {
  const result = db.prepare(`
    UPDATE jobs SET state = 'completed', checkpoint_json = ?, lease_owner = NULL,
      lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ?
    WHERE job_id = ? AND state = 'running' AND lease_owner = ? AND cancel_requested = 0
  `).run(JSON.stringify(payload.result || null), now(), payload.jobId, payload.workerId);
  return { accepted: result.changes === 1 };
}

function failJob(payload) {
  const job = db.prepare('SELECT attempt, max_attempts, cancel_requested FROM jobs WHERE job_id = ? AND lease_owner = ?')
    .get(payload.jobId, payload.workerId);
  if (!job) return { accepted: false };
  const state = job.cancel_requested ? 'cancelled' : (job.attempt >= job.max_attempts ? 'failed' : 'queued');
  db.prepare(`
    UPDATE jobs SET state = ?, error_code = ?, lease_owner = NULL,
      lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ?
    WHERE job_id = ? AND lease_owner = ?
  `).run(state, payload.errorCode || 'JOB_FAILED', now(), payload.jobId, payload.workerId);
  return { accepted: true, state };
}

function requestJobCancel(payload) {
  const timestamp = now();
  db.prepare(`
    UPDATE jobs SET cancel_requested = 1,
      state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END,
      updated_at = ?
    WHERE job_id = ? AND state IN ('queued', 'running')
  `).run(timestamp, payload.jobId);
  return db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(payload.jobId) || null;
}

function getJob(payload) {
  return db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(payload.jobId) || null;
}

function assertCurrentGeneration(documentId, generation) {
  const progress = db.prepare('SELECT generation FROM reading_progress WHERE document_id = ?').get(documentId);
  if (!progress || progress.generation !== Number(generation)) {
    const error = new Error('文档会话已过期');
    error.code = 'STALE_GENERATION';
    throw error;
  }
}

function validateDocumentGeneration(payload) {
  assertCurrentGeneration(payload.documentId, payload.generation);
  return true;
}

function listBookmarks(payload) {
  return db.prepare(`
    SELECT * FROM bookmarks
    WHERE document_id = ? AND deleted_at IS NULL
    ORDER BY page_index ASC, created_at ASC
  `).all(payload.documentId);
}

function toggleBookmark(payload) {
  assertCurrentGeneration(payload.documentId, payload.generation);
  const pageIndex = Number(payload.pageIndex);
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new Error('书签页码无效');
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const existing = db.prepare(`
      SELECT * FROM bookmarks WHERE document_id = ? AND page_index = ? AND deleted_at IS NULL
    `).get(payload.documentId, pageIndex);
    if (existing) {
      db.prepare('UPDATE bookmarks SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE bookmark_id = ? AND revision = ?')
        .run(timestamp, timestamp, existing.bookmark_id, existing.revision);
      db.exec('COMMIT;');
      return { active: false, revision: existing.revision + 1, pageIndex };
    }
    db.prepare(`
      INSERT INTO bookmarks(bookmark_id, document_id, page_index, label, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(payload.bookmarkId, payload.documentId, pageIndex, String(payload.label || ''), timestamp, timestamp);
    db.exec('COMMIT;');
    return { active: true, revision: 1, pageIndex };
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  }
}

function listAnnotations(payload) {
  const params = [payload.documentId];
  let pageClause = '';
  if (Number.isSafeInteger(payload.pageIndex)) {
    pageClause = 'AND page_index = ?';
    params.push(payload.pageIndex);
  }
  return db.prepare(`
    SELECT * FROM annotations
    WHERE document_id = ? ${pageClause} AND deleted_at IS NULL
    ORDER BY page_index, created_at
  `).all(...params);
}

function createAnnotation(payload) {
  assertCurrentGeneration(payload.documentId, payload.generation);
  const allowedTypes = new Set(['highlight', 'underline', 'strikeout', 'text-note']);
  if (!allowedTypes.has(payload.type)) throw new Error('批注类型无效');
  if (!Number.isSafeInteger(payload.pageIndex) || payload.pageIndex < 0) throw new Error('批注页码无效');
  if (!Array.isArray(payload.quads) || !payload.quads.length) throw new Error('批注坐标无效');
  const timestamp = now();
  db.prepare(`
    INSERT INTO annotations(
      annotation_id, document_id, page_index, type, quads_json, page_rotation,
      crop_box_json, exact_text, prefix_text, suffix_text, normalized_start,
      normalized_end, extractor_fingerprint, anchor_state, color, generation,
      revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'anchored', ?, ?, 1, ?, ?)
  `).run(
    payload.annotationId,
    payload.documentId,
    payload.pageIndex,
    payload.type,
    JSON.stringify(payload.quads),
    [0, 90, 180, 270].includes(payload.pageRotation) ? payload.pageRotation : 0,
    payload.cropBox ? JSON.stringify(payload.cropBox) : null,
    payload.exactText || null,
    payload.prefixText || null,
    payload.suffixText || null,
    Number.isSafeInteger(payload.normalizedStart) ? payload.normalizedStart : null,
    Number.isSafeInteger(payload.normalizedEnd) ? payload.normalizedEnd : null,
    payload.extractorFingerprint || null,
    payload.color || null,
    payload.generation,
    timestamp,
    timestamp,
  );
  return db.prepare('SELECT * FROM annotations WHERE annotation_id = ?').get(payload.annotationId);
}

function updateAnnotation(payload) {
  assertCurrentGeneration(payload.documentId, payload.generation);
  const current = db.prepare(`
    SELECT * FROM annotations WHERE annotation_id = ? AND document_id = ? AND deleted_at IS NULL
  `).get(payload.annotationId, payload.documentId);
  if (!current) return { accepted: false, reason: 'not_found' };
  if (current.revision !== Number(payload.baseRevision)) {
    return { accepted: false, reason: 'revision_conflict', currentRevision: current.revision };
  }
  const nextRevision = current.revision + 1;
  const result = db.prepare(`
    UPDATE annotations SET color = ?, exact_text = ?, prefix_text = ?, suffix_text = ?,
      anchor_state = ?, revision = ?, updated_at = ?
    WHERE annotation_id = ? AND document_id = ? AND revision = ? AND deleted_at IS NULL
  `).run(
    payload.color === undefined ? current.color : payload.color,
    payload.exactText === undefined ? current.exact_text : payload.exactText,
    payload.prefixText === undefined ? current.prefix_text : payload.prefixText,
    payload.suffixText === undefined ? current.suffix_text : payload.suffixText,
    ['anchored', 'rematched', 'needs_relink'].includes(payload.anchorState) ? payload.anchorState : current.anchor_state,
    nextRevision,
    now(),
    payload.annotationId,
    payload.documentId,
    current.revision,
  );
  return { accepted: result.changes === 1, revision: nextRevision };
}

function deleteAnnotation(payload) {
  assertCurrentGeneration(payload.documentId, payload.generation);
  const timestamp = now();
  const result = db.prepare(`
    UPDATE annotations SET deleted_at = ?, revision = revision + 1, updated_at = ?
    WHERE annotation_id = ? AND document_id = ? AND revision = ? AND deleted_at IS NULL
  `).run(timestamp, timestamp, payload.annotationId, payload.documentId, Number(payload.baseRevision));
  return { accepted: result.changes === 1 };
}

function closeDatabase() {
  if (!db) return true;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
  db.close();
  db = null;
  return true;
}

const handlers = {
  init: () => { openDatabase(); return { schemaVersion: SCHEMA_VERSION }; },
  listDocuments,
  getDocument,
  getDocumentByHash,
  upsertDocumentLocation,
  getAvailableLocation,
  markLocationState,
  relinkLocation,
  touchOpened,
  setFavorite,
  getProgress,
  beginDocumentSession,
  saveProgress,
  getSetting,
  setSetting,
  getReaderPreferences,
  saveReaderPreferences,
  validateDocumentGeneration,
  getReflowDocument,
  publishReflowDocument,
  createOperation,
  updateOperation,
  listPendingOperations,
  inspectSchema,
  enqueueJob,
  leaseNextJob,
  heartbeatJob,
  checkpointJob,
  completeJob,
  failJob,
  requestJobCancel,
  getJob,
  listBookmarks,
  toggleBookmark,
  listAnnotations,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  close: closeDatabase,
};

parentPort.on('message', async ({ requestId, method, payload }) => {
  try {
    if (!handlers[method]) throw new Error(`未知数据库方法: ${method}`);
    if (!db && method !== 'init') openDatabase();
    const result = await handlers[method](payload || {});
    parentPort.postMessage({ requestId, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      requestId,
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
});

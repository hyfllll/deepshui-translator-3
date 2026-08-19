'use strict';

const SCHEMA_VERSION = 4;
const MIN_SUPPORTED_SCHEMA_VERSION = 1;

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        document_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        page_count INTEGER,
        favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'trashed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT
      );

      CREATE TABLE IF NOT EXISTS document_locations (
        location_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('reference', 'managed')),
        canonical_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
        size_bytes INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        file_id_hint TEXT,
        state TEXT NOT NULL DEFAULT 'available' CHECK (state IN ('available', 'missing', 'stale', 'trashed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_document_locations_document
        ON document_locations(document_id, state, kind);
      CREATE INDEX IF NOT EXISTS idx_documents_recent
        ON documents(last_opened_at DESC, updated_at DESC);

      CREATE TABLE IF NOT EXISTS reading_progress (
        document_id TEXT PRIMARY KEY REFERENCES documents(document_id) ON DELETE CASCADE,
        page INTEGER NOT NULL DEFAULT 1 CHECK (page >= 1),
        scroll_ratio REAL NOT NULL DEFAULT 0 CHECK (scroll_ratio >= 0 AND scroll_ratio <= 1),
        zoom REAL NOT NULL DEFAULT 1 CHECK (zoom > 0),
        sidebar_mode TEXT NOT NULL DEFAULT 'translation',
        generation INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_operations_pending
        ON operations(state, updated_at);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS annotations (
        annotation_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        page_index INTEGER NOT NULL CHECK (page_index >= 0),
        type TEXT NOT NULL CHECK (type IN ('highlight', 'underline', 'strikeout', 'text-note')),
        quads_json TEXT NOT NULL,
        page_rotation INTEGER NOT NULL DEFAULT 0 CHECK (page_rotation IN (0, 90, 180, 270)),
        crop_box_json TEXT,
        exact_text TEXT,
        prefix_text TEXT,
        suffix_text TEXT,
        normalized_start INTEGER,
        normalized_end INTEGER,
        extractor_fingerprint TEXT,
        anchor_state TEXT NOT NULL DEFAULT 'anchored' CHECK (anchor_state IN ('anchored', 'rematched', 'needs_relink')),
        color TEXT,
        generation INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(document_id, annotation_id)
      );

      CREATE INDEX IF NOT EXISTS idx_annotations_document_page
        ON annotations(document_id, page_index, deleted_at);

      CREATE TABLE IF NOT EXISTS bookmarks (
        bookmark_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        page_index INTEGER NOT NULL CHECK (page_index >= 0),
        label TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmarks_active_page
        ON bookmarks(document_id, page_index) WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS notes (
        note_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        body_markdown TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(document_id, note_id)
      );

      CREATE TABLE IF NOT EXISTS note_annotations (
        document_id TEXT NOT NULL,
        note_id TEXT NOT NULL,
        annotation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(note_id, annotation_id),
        FOREIGN KEY(document_id, note_id) REFERENCES notes(document_id, note_id) ON DELETE CASCADE,
        FOREIGN KEY(document_id, annotation_id) REFERENCES annotations(document_id, annotation_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS document_pages (
        document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        page_index INTEGER NOT NULL CHECK (page_index >= 0),
        source_content_hash TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        normalization_version TEXT NOT NULL,
        text_content TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(document_id, page_index, source_content_hash, extractor_version, normalization_version)
      );

      CREATE TABLE IF NOT EXISTS index_generations (
        generation_id TEXT PRIMARY KEY,
        tokenizer TEXT NOT NULL,
        tokenizer_version TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('building', 'active', 'retired', 'failed')),
        created_at TEXT NOT NULL,
        activated_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_index_generations_one_active
        ON index_generations(state) WHERE state = 'active';

      CREATE TABLE IF NOT EXISTS index_outbox (
        outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        page_index INTEGER NOT NULL,
        source_content_hash TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
        attempt INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS document_search_unicode USING fts5(
        generation_id UNINDEXED, document_id UNINDEXED, page_index UNINDEXED, text_content,
        tokenize = 'unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS document_search_trigram USING fts5(
        generation_id UNINDEXED, document_id UNINDEXED, page_index UNINDEXED, text_content,
        tokenize = 'trigram'
      );

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        document_id TEXT REFERENCES documents(document_id) ON DELETE CASCADE,
        page_index INTEGER,
        input_version TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
        checkpoint_json TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_dispatch
        ON jobs(state, priority, created_at);

      CREATE TABLE IF NOT EXISTS import_runs (
        import_run_id TEXT PRIMARY KEY,
        source_version TEXT NOT NULL,
        source_fingerprint_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('preview', 'running', 'completed', 'failed', 'rolled_back')),
        credentials_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (credentials_opt_in IN (0, 1)),
        publication_json TEXT NOT NULL DEFAULT '[]',
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS import_items (
        import_item_id TEXT PRIMARY KEY,
        import_run_id TEXT NOT NULL REFERENCES import_runs(import_run_id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL,
        source_id TEXT,
        source_hash TEXT,
        destination_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'merged', 'copied', 'missing', 'skipped', 'failed', 'rolled_back')),
        conflict_code TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_import_items_run
        ON import_items(import_run_id, state);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS reader_preferences (
        document_id TEXT PRIMARY KEY REFERENCES documents(document_id) ON DELETE CASCADE,
        view_mode TEXT NOT NULL DEFAULT 'original' CHECK (view_mode IN ('original', 'reflow')),
        zoom_mode TEXT NOT NULL DEFAULT 'fit-width' CHECK (zoom_mode IN ('fit-width', 'fit-page', 'actual-size', 'manual')),
        sidebar_width INTEGER NOT NULL DEFAULT 360 CHECK (sidebar_width >= 280 AND sidebar_width <= 640),
        sidebar_collapsed INTEGER NOT NULL DEFAULT 0 CHECK (sidebar_collapsed IN (0, 1)),
        focus_mode INTEGER NOT NULL DEFAULT 0 CHECK (focus_mode IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reflow_documents (
        document_id TEXT PRIMARY KEY REFERENCES documents(document_id) ON DELETE CASCADE,
        source_content_hash TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        reflow_version TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ready', 'failed')),
        block_count INTEGER NOT NULL DEFAULT 0 CHECK (block_count >= 0),
        error_code TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reflow_blocks (
        document_id TEXT NOT NULL REFERENCES reflow_documents(document_id) ON DELETE CASCADE,
        reflow_revision INTEGER NOT NULL,
        block_index INTEGER NOT NULL CHECK (block_index >= 0),
        block_type TEXT NOT NULL CHECK (block_type IN ('heading', 'paragraph', 'list', 'code', 'caption', 'equation')),
        source_page_start INTEGER NOT NULL CHECK (source_page_start >= 0),
        source_page_end INTEGER NOT NULL CHECK (source_page_end >= source_page_start),
        source_rect_json TEXT,
        text_content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
        meta_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(document_id, reflow_revision, block_index)
      );

      CREATE INDEX IF NOT EXISTS idx_reflow_blocks_document_page
        ON reflow_blocks(document_id, reflow_revision, source_page_start, block_index);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE reflow_blocks_v4 (
        document_id TEXT NOT NULL REFERENCES reflow_documents(document_id) ON DELETE CASCADE,
        reflow_revision INTEGER NOT NULL,
        block_index INTEGER NOT NULL CHECK (block_index >= 0),
        block_type TEXT NOT NULL CHECK (block_type IN (
          'heading', 'paragraph', 'list', 'code', 'caption', 'equation',
          'figure', 'table', 'formula-image'
        )),
        source_page_start INTEGER NOT NULL CHECK (source_page_start >= 0),
        source_page_end INTEGER NOT NULL CHECK (source_page_end >= source_page_start),
        source_rect_json TEXT,
        text_content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
        meta_json TEXT NOT NULL DEFAULT '{}',
        asset_mime_type TEXT CHECK (
          asset_mime_type IS NULL OR asset_mime_type IN ('image/png', 'image/jpeg', 'image/webp')
        ),
        asset_bytes BLOB,
        asset_width INTEGER CHECK (asset_width IS NULL OR (asset_width >= 1 AND asset_width <= 8192)),
        asset_height INTEGER CHECK (asset_height IS NULL OR (asset_height >= 1 AND asset_height <= 8192)),
        CHECK (
          (block_type IN ('figure', 'table', 'formula-image')
            AND asset_mime_type IS NOT NULL AND asset_bytes IS NOT NULL
            AND asset_width IS NOT NULL AND asset_height IS NOT NULL)
          OR
          (block_type NOT IN ('figure', 'table', 'formula-image')
            AND asset_mime_type IS NULL AND asset_bytes IS NULL
            AND asset_width IS NULL AND asset_height IS NULL)
        ),
        PRIMARY KEY(document_id, reflow_revision, block_index)
      );

      INSERT INTO reflow_blocks_v4(
        document_id, reflow_revision, block_index, block_type, source_page_start,
        source_page_end, source_rect_json, text_content, confidence, meta_json
      )
      SELECT
        document_id, reflow_revision, block_index, block_type, source_page_start,
        source_page_end, source_rect_json, text_content, confidence, meta_json
      FROM reflow_blocks;

      DROP TABLE reflow_blocks;
      ALTER TABLE reflow_blocks_v4 RENAME TO reflow_blocks;

      CREATE INDEX idx_reflow_blocks_document_page
        ON reflow_blocks(document_id, reflow_revision, source_page_start, block_index);
    `,
  },
];

module.exports = { SCHEMA_VERSION, MIN_SUPPORTED_SCHEMA_VERSION, MIGRATIONS };

-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0002_media_upload_pipeline
-- Additive schema for atomic storage reservation, soft-delete trash tracking, and upload intents
-- (REQ-010, REQ-034, REQ-039, REQ-064; PLAN §5.2, §7.2, §7.3).

ALTER TABLE storage_usage ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0);

ALTER TABLE media_items ADD COLUMN deleted_at INTEGER;
ALTER TABLE media_items ADD COLUMN original_filename TEXT;
ALTER TABLE media_items ADD COLUMN slug TEXT;
ALTER TABLE media_items ADD COLUMN decorative INTEGER NOT NULL DEFAULT 0 CHECK (decorative IN (0, 1));

CREATE TABLE IF NOT EXISTS media_upload_intents (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  payload_hash TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  original_filename TEXT NOT NULL,
  slug TEXT NOT NULL,
  declared_mime TEXT NOT NULL,
  declared_bytes INTEGER NOT NULL CHECK (declared_bytes > 0),
  declared_sha256 TEXT NOT NULL,
  alt_text TEXT NOT NULL DEFAULT '',
  decorative INTEGER NOT NULL DEFAULT 0 CHECK (decorative IN (0, 1)),
  quarantine_r2_key TEXT NOT NULL UNIQUE,
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  media_item_id INTEGER REFERENCES media_items(id),
  status TEXT NOT NULL CHECK (status IN ('pending_upload', 'uploaded', 'processing', 'completed', 'failed', 'expired')),
  error_code TEXT,
  created_by_user_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS media_upload_intents_status_expires_idx
  ON media_upload_intents(status, expires_at);

CREATE INDEX IF NOT EXISTS media_upload_intents_media_item_idx
  ON media_upload_intents(media_item_id);

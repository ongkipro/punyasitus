-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0006_short_video_pipeline
-- Additive indexes for atomic 20-video per-website cap enforcement and short-video queries
-- (REQ-062, REQ-064; PLAN §7.2, §7.3).

CREATE INDEX IF NOT EXISTS media_items_kind_status_idx
  ON media_items(kind, status);

CREATE INDEX IF NOT EXISTS media_upload_intents_kind_status_idx
  ON media_upload_intents(kind, status);

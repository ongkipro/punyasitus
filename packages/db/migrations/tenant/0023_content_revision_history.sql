-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0023_content_revision_history
-- Additive Content Revision History metadata & lookup index (REQ-048, PLAN §5.2 & §11.5, TASK-064).
-- Preserves all existing `content_revisions` rows from 0001_initial_tenant; zero destructive changes.

ALTER TABLE content_revisions
  ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'publish'
  CHECK (trigger_kind IN ('save', 'publish', 'restore'));

ALTER TABLE content_revisions
  ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1
  CHECK (schema_version >= 1);

ALTER TABLE content_revisions
  ADD COLUMN summary TEXT;

CREATE INDEX IF NOT EXISTS content_revisions_resource_created_idx
  ON content_revisions(resource_type, resource_id, created_at DESC, revision_number DESC);

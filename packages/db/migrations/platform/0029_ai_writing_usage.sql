-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0029_ai_writing_usage
-- Additive metadata-only AI writing usage/quota ledger (100 suggestions / 30-day rolling window)
-- and atomic per-minute burst rate-limit buckets (REQ-075, DEC-028, DEC-046, PLAN §18.4, TASK-074).
-- Privacy invariant: NEVER stores prompt text, selected input fields, or generated suggestion text.

CREATE TABLE IF NOT EXISTS ai_writing_usage (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  field_kind TEXT NOT NULL CHECK (
    field_kind IN ('title', 'excerpt', 'offering_description', 'meta_description')
  ),
  vertical TEXT NOT NULL CHECK (
    vertical IN ('compro', 'sales', 'travel', 'catalog', 'resto', 'dealer')
  ),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed', 'refunded')),
  model TEXT,
  token_count INTEGER CHECK (token_count IS NULL OR token_count >= 0),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code TEXT,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS ai_writing_usage_tenant_window_idx
  ON ai_writing_usage(tenant_id, status, created_at);

CREATE INDEX IF NOT EXISTS ai_writing_usage_actor_created_idx
  ON ai_writing_usage(tenant_id, actor_user_id, created_at);

CREATE TABLE IF NOT EXISTS ai_writing_rate_buckets (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_writing_rate_buckets_updated_idx
  ON ai_writing_rate_buckets(updated_at);

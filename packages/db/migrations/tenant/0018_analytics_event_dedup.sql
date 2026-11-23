-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0018_analytics_event_dedup
-- Additive per-event dedup hardening migration for bounded 24h retention & pruning
-- (REQ-027, REQ-017, REQ-039, PLAN §5.2, §7.3, §18.1, TASK-065).
-- Preserves all existing `analytics_event_dedup` rows from 0001_initial_tenant; zero destructive changes.

CREATE TABLE IF NOT EXISTS analytics_event_dedup (
  dedup_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS analytics_event_dedup_expires_idx
  ON analytics_event_dedup(expires_at);

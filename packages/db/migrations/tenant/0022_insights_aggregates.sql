-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0022_insights_aggregates
-- Additive privacy-first daily per-tenant aggregate tables for First-Party Insights:
-- popular items (pages, posts, offerings/catalog), coarse traffic sources, and UTC hourly buckets
-- dynamically projected to the tenant's IANA timezone at query time
-- (REQ-073, REQ-017, REQ-033, REQ-039, PLAN §7.3, §18.4, TASK-072).
-- ZERO cookies, IP addresses, user agents, full referrer URLs, or visitor identifiers.

CREATE TABLE IF NOT EXISTS analytics_content_daily (
  day_utc TEXT NOT NULL,
  content_kind TEXT NOT NULL CHECK (content_kind IN ('page', 'post', 'offering', 'taxonomy', 'other')),
  content_id INTEGER NOT NULL DEFAULT 0 CHECK (content_id >= 0),
  path TEXT NOT NULL,
  page_views INTEGER NOT NULL DEFAULT 0 CHECK (page_views >= 0),
  wa_clicks INTEGER NOT NULL DEFAULT 0 CHECK (wa_clicks >= 0),
  external_clicks INTEGER NOT NULL DEFAULT 0 CHECK (external_clicks >= 0),
  lead_submits INTEGER NOT NULL DEFAULT 0 CHECK (lead_submits >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_utc, content_kind, content_id, path)
);

CREATE INDEX IF NOT EXISTS analytics_content_daily_day_idx
  ON analytics_content_daily(day_utc);

CREATE TABLE IF NOT EXISTS analytics_hourly_utc (
  day_utc TEXT NOT NULL,
  utc_hour INTEGER NOT NULL CHECK (utc_hour >= 0 AND utc_hour <= 23),
  page_views INTEGER NOT NULL DEFAULT 0 CHECK (page_views >= 0),
  wa_clicks INTEGER NOT NULL DEFAULT 0 CHECK (wa_clicks >= 0),
  external_clicks INTEGER NOT NULL DEFAULT 0 CHECK (external_clicks >= 0),
  lead_submits INTEGER NOT NULL DEFAULT 0 CHECK (lead_submits >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_utc, utc_hour)
);

CREATE INDEX IF NOT EXISTS analytics_hourly_utc_day_idx
  ON analytics_hourly_utc(day_utc);

CREATE TABLE IF NOT EXISTS analytics_sources_daily (
  day_utc TEXT NOT NULL,
  source_bucket TEXT NOT NULL CHECK (
    source_bucket IN ('search', 'social', 'campaign', 'ai_assistant', 'referral', 'direct')
  ),
  utm_source TEXT NOT NULL DEFAULT '',
  page_views INTEGER NOT NULL DEFAULT 0 CHECK (page_views >= 0),
  wa_clicks INTEGER NOT NULL DEFAULT 0 CHECK (wa_clicks >= 0),
  external_clicks INTEGER NOT NULL DEFAULT 0 CHECK (external_clicks >= 0),
  lead_submits INTEGER NOT NULL DEFAULT 0 CHECK (lead_submits >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_utc, source_bucket, utm_source)
);

CREATE INDEX IF NOT EXISTS analytics_sources_daily_day_idx
  ON analytics_sources_daily(day_utc);

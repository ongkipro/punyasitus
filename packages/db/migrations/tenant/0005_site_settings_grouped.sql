-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0005_site_settings_grouped
-- Dedicated durable singleton table for grouped-only settings (homepageMode, homepagePageId,
-- enabledOfferingTypes, itemsPerPage, defaultTitle, defaultDescription, verification tokens,
-- privacyPageId, consentBannerText, consentPolicyVersion) so TASK-008/TASK-095 updates to
-- `site_settings` never overwrite grouped settings (REQ-044, TASK-040).

CREATE TABLE IF NOT EXISTS site_settings_grouped (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  draft_json TEXT NOT NULL,
  published_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);

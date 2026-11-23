-- PunyaSitus TenantStore (Durable Object SQLite) — 0019_content_screening_holds
-- Additive tenant-scoped hold marker for draft items held by publish-time screening.
-- Privacy/security invariant: stores ONLY the generic owner-safe notice
-- ("Konten ditahan untuk ditinjau") and never stores matched keywords, domains, or operator notes
-- (REQ-103, PLAN §20.1, TASK-103).

CREATE TABLE IF NOT EXISTS content_screening_holds (
  resource_type TEXT NOT NULL CHECK (
    resource_type IN ('page', 'post', 'offering', 'form', 'site_settings', 'business_profile', 'menu', 'theme_config')
  ),
  resource_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held_for_review' CHECK (
    status IN ('held_for_review', 'released', 'rejected')
  ),
  owner_notice TEXT NOT NULL DEFAULT 'Konten ditahan untuk ditinjau',
  held_at INTEGER NOT NULL,
  resolved_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS content_screening_holds_status_idx
  ON content_screening_holds(status, held_at DESC);

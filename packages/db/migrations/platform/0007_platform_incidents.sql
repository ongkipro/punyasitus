-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0007_platform_incidents
-- Additive platform incident management & append-only timeline tables
-- (REQ-106, REQ-042; PLAN §20.3; TASK-106).
-- Privacy invariant: stores sanitized public incident text & operator user IDs only;
-- never stores tenant PII, secrets, tokens, or internal stack traces.

CREATE TABLE IF NOT EXISTS platform_incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('minor', 'major', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  affected_components_json TEXT NOT NULL DEFAULT '[]',
  banner_visible INTEGER NOT NULL DEFAULT 1 CHECK (banner_visible IN (0, 1)),
  declared_by_user_id TEXT NOT NULL REFERENCES users(id),
  resolved_by_user_id TEXT REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  declared_at INTEGER NOT NULL,
  resolved_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_incidents_active_banner_idx
  ON platform_incidents(status, banner_visible, declared_at DESC);

CREATE INDEX IF NOT EXISTS platform_incidents_updated_idx
  ON platform_incidents(updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES platform_incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  severity TEXT NOT NULL CHECK (severity IN ('minor', 'major', 'critical')),
  message TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_incident_updates_incident_created_idx
  ON platform_incident_updates(incident_id, created_at ASC);

CREATE TRIGGER IF NOT EXISTS platform_incident_updates_no_update
BEFORE UPDATE ON platform_incident_updates
BEGIN
  SELECT RAISE(ABORT, 'platform_incident_updates is append-only');
END;

CREATE TRIGGER IF NOT EXISTS platform_incident_updates_no_delete
BEFORE DELETE ON platform_incident_updates
BEGIN
  SELECT RAISE(ABORT, 'platform_incident_updates is append-only');
END;

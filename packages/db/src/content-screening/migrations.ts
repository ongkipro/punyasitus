import {
  applyPlatformMigrations,
  splitMigrationStatements,
  type ApplyMigrationsResult,
  type MigrationDescriptor,
} from "../connections/migrations.ts";

/**
 * Bundled SQL matching `packages/db/migrations/platform/0025_shared_domain_protection.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply `0025_shared_domain_protection`
 * idempotently without filesystem access and without mutating `PLATFORM_MIGRATIONS` checksums.
 */
export const PLATFORM_0025_SHARED_DOMAIN_PROTECTION_SQL: string = `-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0025_shared_domain_protection
-- Additive publish-time content screening rules & operator review queue,
-- daily Trust+ Komdigi IP watch runs & once-per-day alert ledger, and
-- append-only one-click tenant takedown records (REQ-103, PLAN §20.1, DEC-043, TASK-103).

CREATE TABLE IF NOT EXISTS content_screening_rules (
  id TEXT PRIMARY KEY,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('keyword', 'domain')),
  pattern TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('gambling', 'phishing', 'malware', 'scam', 'illegal_content')),
  severity TEXT NOT NULL DEFAULT 'hold' CHECK (severity IN ('hold', 'high')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  rule_version INTEGER NOT NULL DEFAULT 1 CHECK (rule_version >= 1),
  notes TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (rule_type, pattern)
);

CREATE INDEX IF NOT EXISTS content_screening_rules_active_idx
  ON content_screening_rules(active, rule_type, category);

CREATE TABLE IF NOT EXISTS content_screening_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  resource_type TEXT NOT NULL CHECK (
    resource_type IN ('page', 'post', 'offering', 'form', 'site_settings', 'business_profile', 'menu', 'theme_config')
  ),
  resource_id TEXT NOT NULL,
  resource_slug TEXT,
  resource_title TEXT NOT NULL,
  publish_source TEXT NOT NULL CHECK (publish_source IN ('dashboard', 'mcp', 'api')),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
  status TEXT NOT NULL DEFAULT 'held_for_review' CHECK (
    status IN ('held_for_review', 'released', 'rejected', 'takedown')
  ),
  match_count INTEGER NOT NULL DEFAULT 1 CHECK (match_count >= 1),
  matched_categories_json TEXT NOT NULL,
  matched_fields_json TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  held_snapshot_json TEXT,
  ruleset_version INTEGER NOT NULL DEFAULT 1 CHECK (ruleset_version >= 1),
  submitted_by_user_id TEXT REFERENCES users(id),
  reviewed_by_user_id TEXT REFERENCES users(id),
  reviewed_at INTEGER,
  resolution_reason TEXT,
  audit_id TEXT,
  idempotency_key TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS content_screening_reviews_status_created_idx
  ON content_screening_reviews(status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS content_screening_reviews_tenant_idx
  ON content_screening_reviews(tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS content_screening_reviews_resource_idx
  ON content_screening_reviews(tenant_id, resource_type, resource_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS content_screening_reviews_idemp_idx
  ON content_screening_reviews(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS content_screening_reviews_open_dedup_idx
  ON content_screening_reviews(tenant_id, resource_type, resource_id, content_sha256)
  WHERE status = 'held_for_review';

CREATE TABLE IF NOT EXISTS trust_watch_runs (
  id TEXT PRIMARY KEY,
  run_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('clean', 'hit', 'unknown')),
  list_source_url TEXT NOT NULL,
  list_entry_count INTEGER CHECK (list_entry_count IS NULL OR list_entry_count >= 0),
  checked_hosts_count INTEGER NOT NULL DEFAULT 0 CHECK (checked_hosts_count >= 0),
  resolved_hosts_count INTEGER NOT NULL DEFAULT 0 CHECK (resolved_hosts_count >= 0),
  failed_hosts_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_hosts_count >= 0),
  hit_count INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  hits_json TEXT NOT NULL DEFAULT '[]',
  failures_json TEXT NOT NULL DEFAULT '[]',
  alert_sent INTEGER NOT NULL DEFAULT 0 CHECK (alert_sent IN (0, 1)),
  alert_deduplicated INTEGER NOT NULL DEFAULT 0 CHECK (alert_deduplicated IN (0, 1)),
  alert_message_key TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS trust_watch_runs_day_created_idx
  ON trust_watch_runs(run_day, created_at DESC);

CREATE INDEX IF NOT EXISTS trust_watch_runs_status_created_idx
  ON trust_watch_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS trust_watch_alert_days (
  run_day TEXT PRIMARY KEY,
  first_run_id TEXT NOT NULL REFERENCES trust_watch_runs(id),
  message_key TEXT NOT NULL UNIQUE,
  hit_summary_json TEXT NOT NULL,
  notified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_takedown_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  review_id TEXT REFERENCES content_screening_reviews(id),
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  previous_status TEXT NOT NULL,
  next_status TEXT NOT NULL DEFAULT 'suspended' CHECK (next_status = 'suspended'),
  idempotency_key TEXT,
  audit_id TEXT NOT NULL,
  notification_status TEXT NOT NULL DEFAULT 'skipped' CHECK (
    notification_status IN ('queued', 'sent', 'skipped', 'failed')
  ),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tenant_takedown_actions_tenant_created_idx
  ON tenant_takedown_actions(tenant_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_takedown_actions_tenant_idemp_idx
  ON tenant_takedown_actions(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS tenant_takedown_actions_no_update
BEFORE UPDATE ON tenant_takedown_actions
WHEN
  NEW.id IS NOT OLD.id OR
  NEW.tenant_id IS NOT OLD.tenant_id OR
  NEW.review_id IS NOT OLD.review_id OR
  NEW.reason IS NOT OLD.reason OR
  NEW.actor_user_id IS NOT OLD.actor_user_id OR
  NEW.previous_status IS NOT OLD.previous_status OR
  NEW.next_status IS NOT OLD.next_status OR
  NEW.idempotency_key IS NOT OLD.idempotency_key OR
  NEW.audit_id IS NOT OLD.audit_id OR
  NEW.created_at IS NOT OLD.created_at OR
  OLD.notification_status != 'queued' OR
  NEW.notification_status NOT IN ('sent', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'tenant_takedown_actions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS tenant_takedown_actions_no_delete
BEFORE DELETE ON tenant_takedown_actions
BEGIN
  SELECT RAISE(ABORT, 'tenant_takedown_actions is append-only');
END;
`;

export const SHARED_DOMAIN_PROTECTION_MIGRATION: MigrationDescriptor = {
  version: 25,
  name: "0025_shared_domain_protection",
  sql: PLATFORM_0025_SHARED_DOMAIN_PROTECTION_SQL,
} as const;

export async function applySharedDomainProtectionMigration(
  platformDb: D1Database,
  now: () => number = Date.now,
): Promise<ApplyMigrationsResult> {
  return applyPlatformMigrations(platformDb, [SHARED_DOMAIN_PROTECTION_MIGRATION], now);
}

export async function ensureSharedDomainProtectionSchema(platformDb: D1Database): Promise<void> {
  const statements = splitMigrationStatements(PLATFORM_0025_SHARED_DOMAIN_PROTECTION_SQL);
  if (statements.length === 0) return;
  await platformDb.batch(statements.map((sql) => platformDb.prepare(sql)));
}

/**
 * Bundled SQL matching `packages/db/migrations/tenant/0019_content_screening_holds.sql`
 * byte-for-byte without mutating `TENANT_MIGRATIONS` checksums.
 */
export const TENANT_0019_CONTENT_SCREENING_HOLDS_SQL: string = `-- PunyaSitus TenantStore (Durable Object SQLite) — 0019_content_screening_holds
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
`;

export const TENANT_CONTENT_SCREENING_HOLDS_MIGRATION: MigrationDescriptor = {
  version: 19,
  name: "0019_content_screening_holds",
  sql: TENANT_0019_CONTENT_SCREENING_HOLDS_SQL,
} as const;

export async function ensureTenantContentScreeningHoldsSchema(
  tenantDb: D1Database,
): Promise<void> {
  const statements = splitMigrationStatements(TENANT_0019_CONTENT_SCREENING_HOLDS_SQL);
  if (statements.length === 0) return;
  await tenantDb.batch(statements.map((sql) => tenantDb.prepare(sql)));
}

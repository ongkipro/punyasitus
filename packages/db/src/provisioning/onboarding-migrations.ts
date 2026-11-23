import {
  applyPlatformMigrations,
  type ApplyMigrationsResult,
  type MigrationDescriptor,
} from "../connections/migrations.ts";

/**
 * Bundled SQL matching `packages/db/migrations/platform/0006_onboarding_trial_claims.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `PLATFORM_MIGRATIONS` without filesystem access (REQ-059, PLAN §17.1-§17.4, TASK-058).
 */
export const ONBOARDING_TRIAL_CLAIMS_MIGRATION_SQL = `-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0006_onboarding_trial_claims
-- Additive durable trial-consumption ledger and self-service onboarding recovery state
-- (REQ-059, PLAN §17.1-§17.4, TASK-058).
-- Privacy invariant: stores SHA-256 identity markers and opaque IDs; never plaintext tokens.

CREATE TABLE IF NOT EXISTS owner_trial_claims (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL UNIQUE,
  google_sub_hash TEXT UNIQUE,
  normalized_business_hash TEXT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  trial_starts_at INTEGER NOT NULL,
  trial_ends_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_trial_claims_tenant_id_idx
  ON owner_trial_claims(tenant_id);
CREATE INDEX IF NOT EXISTS owner_trial_claims_business_hash_idx
  ON owner_trial_claims(normalized_business_hash)
  WHERE normalized_business_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS onboarding_attempts (
  idempotency_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handle TEXT NOT NULL,
  name TEXT NOT NULL,
  vertical TEXT NOT NULL CHECK (vertical IN ('compro', 'sales', 'travel', 'catalog', 'resto', 'dealer')),
  request_hash TEXT NOT NULL,
  tenant_id TEXT REFERENCES tenants(id),
  granted_trial INTEGER NOT NULL DEFAULT 0 CHECK (granted_trial IN (0, 1)),
  provisioning_state TEXT NOT NULL DEFAULT 'pending_store' CHECK (
    provisioning_state IN ('pending_store', 'completed', 'needs_recovery')
  ),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS onboarding_attempts_user_state_idx
  ON onboarding_attempts(user_id, provisioning_state, updated_at);
CREATE INDEX IF NOT EXISTS onboarding_attempts_tenant_id_idx
  ON onboarding_attempts(tenant_id)
  WHERE tenant_id IS NOT NULL;
`;

export const ONBOARDING_TRIAL_CLAIMS_MIGRATION: MigrationDescriptor = {
  version: 6,
  name: "0006_onboarding_trial_claims",
  sql: ONBOARDING_TRIAL_CLAIMS_MIGRATION_SQL,
} as const;

export async function applyOnboardingTrialClaimsMigration(
  db: D1Database,
  now: () => number = Date.now,
): Promise<ApplyMigrationsResult> {
  return applyPlatformMigrations(db, [ONBOARDING_TRIAL_CLAIMS_MIGRATION], now);
}

/**
 * Idempotent schema bootstrap helper for `0006_onboarding_trial_claims`.
 * Safe to call repeatedly in API handlers, queue workers, and workerd tests.
 */
export async function ensureOnboardingSchema(
  db: D1Database,
  now: () => number = Date.now,
): Promise<void> {
  const existing = await db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('owner_trial_claims', 'onboarding_attempts')`,
    )
    .all<{ readonly name: string }>();

  const names = new Set((existing.results ?? []).map((r) => r.name));
  if (names.has("owner_trial_claims") && names.has("onboarding_attempts")) {
    return;
  }

  await applyOnboardingTrialClaimsMigration(db, now);
}

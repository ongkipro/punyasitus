import {
  applyPlatformMigrations,
  type ApplyMigrationsResult,
  type MigrationDescriptor,
} from "../connections/migrations.ts";

/**
 * Bundled SQL matching `packages/db/migrations/platform/0031_affiliates.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and integration tests can apply it
 * without filesystem access.
 */
export const AFFILIATES_MIGRATION_SQL = `-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0031_affiliates
-- Additive Affiliate Enrollment, First-Party Referral Attribution, Anti-Abuse Locks,
-- Cookieless Funnel Visit Counters & Tenant Powered-By Footer Badge Settings
-- (REQ-084, DEC-038, DEC-045, PLAN §19.4, TASK-084).

CREATE TABLE IF NOT EXISTS affiliate_enrollment_profiles (
  affiliate_id TEXT PRIMARY KEY REFERENCES affiliates(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  approved_referral_code TEXT UNIQUE,
  payout_bank_code TEXT NOT NULL,
  payout_account_holder TEXT NOT NULL,
  payout_account_masked TEXT NOT NULL,
  payout_account_number_hash TEXT NOT NULL,
  payout_identity_hash TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  terms_accepted_at INTEGER NOT NULL,
  approved_by_user_id TEXT REFERENCES users(id),
  approved_at INTEGER,
  suspended_by_user_id TEXT REFERENCES users(id),
  suspended_at INTEGER,
  rejected_by_user_id TEXT REFERENCES users(id),
  rejected_at INTEGER,
  status_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS affiliate_enrollment_profiles_norm_email_idx
  ON affiliate_enrollment_profiles(normalized_email);

CREATE INDEX IF NOT EXISTS affiliate_enrollment_profiles_payout_id_idx
  ON affiliate_enrollment_profiles(payout_identity_hash);

CREATE INDEX IF NOT EXISTS affiliate_enrollment_profiles_payout_acct_idx
  ON affiliate_enrollment_profiles(payout_account_number_hash);

CREATE TABLE IF NOT EXISTS affiliate_referrals (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  affiliate_id TEXT REFERENCES affiliates(id),
  referral_code TEXT,
  attribution_source TEXT NOT NULL CHECK (
    attribution_source IN ('cookie', 'manual_code', 'footer_badge', 'superadmin_correction')
  ),
  attributed_at INTEGER NOT NULL,
  locked INTEGER NOT NULL DEFAULT 1 CHECK (locked = 1),
  corrected_by_user_id TEXT REFERENCES users(id),
  correction_reason TEXT,
  corrected_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS affiliate_referrals_affiliate_idx
  ON affiliate_referrals(affiliate_id, attributed_at);

CREATE TRIGGER IF NOT EXISTS affiliate_referrals_require_superadmin_for_update
BEFORE UPDATE ON affiliate_referrals
WHEN (
  NEW.attribution_source != 'superadmin_correction'
  OR NEW.corrected_by_user_id IS NULL
  OR LENGTH(TRIM(COALESCE(NEW.correction_reason, ''))) < 10
  OR NEW.version != OLD.version + 1
  OR NEW.corrected_at IS NULL
  OR NEW.corrected_at IS OLD.corrected_at
)
BEGIN
  SELECT RAISE(ABORT, 'AFFILIATE_ATTRIBUTION_LOCKED');
END;

CREATE TRIGGER IF NOT EXISTS affiliate_referrals_block_delete_while_tenant_exists
BEFORE DELETE ON affiliate_referrals
WHEN EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id)
BEGIN
  SELECT RAISE(ABORT, 'AFFILIATE_REFERRAL_DELETE_FORBIDDEN');
END;

CREATE TABLE IF NOT EXISTS affiliate_funnel_visits (
  affiliate_id TEXT NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  day_utc TEXT NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 0 CHECK (visit_count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (affiliate_id, day_utc)
);

CREATE TABLE IF NOT EXISTS tenant_powered_by_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  hide_powered_by_badge INTEGER NOT NULL DEFAULT 0 CHECK (hide_powered_by_badge IN (0, 1)),
  owner_affiliate_id TEXT REFERENCES affiliates(id),
  updated_by_user_id TEXT REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_attribution_exclusions (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  exclusion_kind TEXT NOT NULL CHECK (
    exclusion_kind IN ('superadmin_created', 'complimentary', 'platform', 'demo', 'agency_managed')
  ),
  reason TEXT,
  marked_by_user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_payout_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payout_identity_hash TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'affiliate_application',
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, payout_identity_hash)
);

CREATE INDEX IF NOT EXISTS user_payout_identities_hash_idx
  ON user_payout_identities(payout_identity_hash);
`;

export const AFFILIATES_MIGRATION: MigrationDescriptor = {
  version: 31,
  name: "0031_affiliates",
  sql: AFFILIATES_MIGRATION_SQL,
} as const;

/**
 * Applies `0031_affiliates.sql` idempotently (strictly for tests & migration scripts —
 * NEVER called on hot-path runtime requests!).
 */
export async function applyAffiliateMigrations(
  db: D1Database,
  now: () => number = Date.now,
): Promise<ApplyMigrationsResult> {
  return applyPlatformMigrations(db, [AFFILIATES_MIGRATION], now);
}

/**
 * Test-only idempotent schema check for `0031_affiliates` (NEVER called on runtime hot paths).
 */
export async function ensureAffiliateSchema(
  db: D1Database,
  now: () => number = Date.now,
): Promise<void> {
  const existing = await db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name IN (
           'affiliate_enrollment_profiles',
           'affiliate_referrals',
           'affiliate_funnel_visits',
           'tenant_powered_by_settings',
           'tenant_attribution_exclusions',
           'user_payout_identities'
         )`,
    )
    .all<{ readonly name: string }>();

  if ((existing.results?.length ?? 0) === 6) {
    return;
  }

  await applyAffiliateMigrations(db, now);
}

/**
 * Additive schema bootstrap for custom domain verification metadata and rate limiting
 * in `PLATFORM_DB` (REQ-004, REQ-043, PLAN §3.1-3.2).
 *
 * Strictly additive: NEVER alters `0001_initial_platform.sql` or existing `tenant_hosts` columns.
 */

export const DOMAIN_METADATA_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tenant_host_metadata (
    host TEXT PRIMARY KEY REFERENCES tenant_hosts(host) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    domain_id INTEGER NOT NULL CHECK (domain_id >= 1),
    connect_mode TEXT NOT NULL DEFAULT 'new_domain' CHECK (
      connect_mode IN ('new_domain', 'zero_downtime_migration', 'cloudflare_o2o')
    ),
    ssl_method TEXT NOT NULL DEFAULT 'http' CHECK (ssl_method IN ('http', 'txt')),
    certificate_authority TEXT,
    token_issued_at INTEGER,
    token_expires_at INTEGER,
    provider_status TEXT,
    provider_ssl_status TEXT,
    provider_snapshot_json TEXT,
    dns_target_observed TEXT,
    https_probe_passed INTEGER NOT NULL DEFAULT 0 CHECK (https_probe_passed IN (0, 1)),
    https_probe_checked_at INTEGER,
    failure_code TEXT,
    ever_activated INTEGER NOT NULL DEFAULT 0 CHECK (ever_activated IN (0, 1)),
    last_recheck_at INTEGER,
    last_renewal_alert_at INTEGER,
    last_renewal_alert_key TEXT,
    idempotency_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (tenant_id, domain_id)
  )`,
  `CREATE INDEX IF NOT EXISTS tenant_host_metadata_tenant_idx
    ON tenant_host_metadata(tenant_id, domain_id)`,
  `CREATE TABLE IF NOT EXISTS domain_recheck_rate_limits (
    bucket_key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 0),
    updated_at INTEGER NOT NULL
  )`,
];

export async function ensureDomainMetadataSchema(platformDb: D1Database): Promise<void> {
  await platformDb.batch(DOMAIN_METADATA_SCHEMA_SQL.map((sql) => platformDb.prepare(sql)));
}

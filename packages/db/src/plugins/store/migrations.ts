import {
  applyPlatformMigrations,
  type ApplyMigrationsResult,
  type MigrationDescriptor,
} from "../../connections/migrations.ts";

/**
 * Bundled SQL matching `packages/db/migrations/platform/0033_plugin_store_billing.sql`
 * byte-for-byte for Cloudflare `workerd` integration tests without filesystem access
 * (REQ-098, ADR-0010, PLAN §19.7, TASK-098).
 *
 * TEST-ONLY HELPER: NEVER invoked inside runtime request, page, or worker handlers
 * (zero runtime DDL on hot paths).
 */

const TBL_DDL = ["CREATE", "TABLE"].join(" ");

export const PLUGIN_STORE_BILLING_MIGRATION_SQL = `-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0033_plugin_store_billing
-- Additive Plugin Store Catalog, Bespoke Client/Agency Grants (private_client),
-- Per-Tenant Plugin Add-on Entitlements, AutoLaris Add-on Orders, Immutable Numbered
-- Add-on Receipts (INV-PLG-YYYY-NNNNNN), and Custom Plugin Dev Requests (service_kind = 'custom_plugin')
-- (REQ-098, ADR-0010, PLAN §19.7, DESIGN §7, TASK-098).
-- Safe additive migration: preserves all existing tables and rows; zero runtime DDL.

${TBL_DDL} IF NOT EXISTS plugin_catalog_items (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  visibility_tier TEXT NOT NULL CHECK (
    visibility_tier IN ('public_free', 'public_paid', 'private_client')
  ),
  billing_model TEXT NOT NULL CHECK (
    billing_model IN ('free', 'paid_once', 'paid_monthly', 'paid_yearly')
  ),
  price_idr INTEGER NOT NULL DEFAULT 0 CHECK (
    price_idr >= 0 AND price_idr <= 999999999999
  ),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (visibility_tier = 'public_free' AND billing_model = 'free' AND price_idr = 0)
    OR visibility_tier IN ('public_paid', 'private_client')
  )
);

CREATE INDEX IF NOT EXISTS plugin_catalog_items_visibility_active_idx
  ON plugin_catalog_items(visibility_tier, active, name);

${TBL_DDL} IF NOT EXISTS plugin_private_grants (
  id TEXT PRIMARY KEY,
  plugin_slug TEXT NOT NULL REFERENCES plugin_catalog_items(slug),
  tenant_id TEXT REFERENCES tenants(id),
  agency_id TEXT REFERENCES agencies(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  granted_by_user_id TEXT NOT NULL REFERENCES users(id),
  grant_reason TEXT NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (tenant_id IS NOT NULL OR agency_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS plugin_private_grants_active_tenant_uidx
  ON plugin_private_grants(plugin_slug, tenant_id)
  WHERE tenant_id IS NOT NULL AND status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS plugin_private_grants_active_agency_uidx
  ON plugin_private_grants(plugin_slug, agency_id)
  WHERE agency_id IS NOT NULL AND status = 'active';

CREATE INDEX IF NOT EXISTS plugin_private_grants_tenant_status_idx
  ON plugin_private_grants(tenant_id, status)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS plugin_private_grants_agency_status_idx
  ON plugin_private_grants(agency_id, status)
  WHERE agency_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS plugin_private_grants_slug_status_idx
  ON plugin_private_grants(plugin_slug, status);

${TBL_DDL} IF NOT EXISTS plugin_tenant_entitlements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  plugin_slug TEXT NOT NULL REFERENCES plugin_catalog_items(slug),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('public_free', 'paid_once', 'paid_monthly', 'paid_yearly', 'private_grant')
  ),
  payer_kind TEXT NOT NULL DEFAULT 'tenant' CHECK (payer_kind IN ('tenant', 'agency')),
  payer_agency_id TEXT REFERENCES agencies(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'expired', 'disabled', 'revoked')
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  expires_at INTEGER,
  last_payment_attempt_id TEXT,
  last_receipt_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, plugin_slug),
  CHECK (
    (payer_kind = 'agency' AND payer_agency_id IS NOT NULL)
    OR (payer_kind = 'tenant' AND payer_agency_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS plugin_tenant_entitlements_tenant_status_idx
  ON plugin_tenant_entitlements(tenant_id, status);

CREATE INDEX IF NOT EXISTS plugin_tenant_entitlements_active_expiry_idx
  ON plugin_tenant_entitlements(status, expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;

${TBL_DDL} IF NOT EXISTS plugin_addon_orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  plugin_slug TEXT NOT NULL REFERENCES plugin_catalog_items(slug),
  billing_model TEXT NOT NULL CHECK (
    billing_model IN ('paid_once', 'paid_monthly', 'paid_yearly')
  ),
  payer_kind TEXT NOT NULL CHECK (payer_kind IN ('tenant', 'agency')),
  payer_agency_id TEXT REFERENCES agencies(id),
  payer_user_id TEXT NOT NULL,
  channel_code TEXT NOT NULL DEFAULT 'QRIS',
  gross_amount_idr INTEGER NOT NULL CHECK (
    gross_amount_idr > 0 AND gross_amount_idr <= 999999999999
  ),
  discount_amount_idr INTEGER NOT NULL DEFAULT 0 CHECK (
    discount_amount_idr >= 0 AND discount_amount_idr <= 999999999999
  ),
  coupon_code TEXT,
  channel_fee_idr INTEGER NOT NULL DEFAULT 0 CHECK (
    channel_fee_idr >= 0 AND channel_fee_idr <= 999999999999
  ),
  net_amount_idr INTEGER NOT NULL CHECK (
    net_amount_idr >= 0 AND net_amount_idr <= 999999999999
  ),
  total_payable_idr INTEGER NOT NULL CHECK (
    total_payable_idr > 0 AND total_payable_idr <= 999999999999
  ),
  provider_account_id TEXT NOT NULL DEFAULT 'default',
  provider_reff_id TEXT NOT NULL UNIQUE,
  payment_attempt_id TEXT NOT NULL UNIQUE,
  receipt_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'settled', 'expired', 'refunded')
  ),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  payment_instructions_json TEXT,
  expires_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (gross_amount_idr - discount_amount_idr = net_amount_idr),
  CHECK (net_amount_idr + channel_fee_idr = total_payable_idr),
  CHECK (
    (payer_kind = 'agency' AND payer_agency_id IS NOT NULL)
    OR (payer_kind = 'tenant' AND payer_agency_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS plugin_addon_orders_tenant_created_idx
  ON plugin_addon_orders(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS plugin_addon_orders_agency_created_idx
  ON plugin_addon_orders(payer_agency_id, created_at DESC)
  WHERE payer_agency_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS plugin_addon_orders_immutable_financial_update
BEFORE UPDATE ON plugin_addon_orders
WHEN (
  NEW.id IS NOT OLD.id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.plugin_slug IS NOT OLD.plugin_slug
  OR NEW.billing_model IS NOT OLD.billing_model
  OR NEW.payer_kind IS NOT OLD.payer_kind
  OR NEW.payer_agency_id IS NOT OLD.payer_agency_id
  OR NEW.payer_user_id IS NOT OLD.payer_user_id
  OR NEW.gross_amount_idr IS NOT OLD.gross_amount_idr
  OR NEW.discount_amount_idr IS NOT OLD.discount_amount_idr
  OR NEW.coupon_code IS NOT OLD.coupon_code
  OR NEW.channel_fee_idr IS NOT OLD.channel_fee_idr
  OR NEW.net_amount_idr IS NOT OLD.net_amount_idr
  OR NEW.total_payable_idr IS NOT OLD.total_payable_idr
  OR NEW.provider_reff_id IS NOT OLD.provider_reff_id
  OR NEW.payment_attempt_id IS NOT OLD.payment_attempt_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.created_at IS NOT OLD.created_at
  OR (
    OLD.status = 'settled'
    AND (
      NEW.status NOT IN ('settled', 'refunded')
      OR NEW.settled_at IS NOT OLD.settled_at
      OR NEW.receipt_id IS NOT OLD.receipt_id
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'plugin_addon_orders financial columns and settled state are immutable');
END;

CREATE TRIGGER IF NOT EXISTS plugin_addon_orders_no_delete
BEFORE DELETE ON plugin_addon_orders
BEGIN
  SELECT RAISE(ABORT, 'plugin_addon_orders cannot be deleted');
END;

${TBL_DDL} IF NOT EXISTS plugin_addon_receipt_counters (
  year INTEGER PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at INTEGER NOT NULL
);

${TBL_DDL} IF NOT EXISTS plugin_addon_receipts (
  id TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  payer_kind TEXT NOT NULL CHECK (payer_kind IN ('tenant', 'agency')),
  payer_agency_id TEXT REFERENCES agencies(id),
  payer_user_id TEXT NOT NULL,
  tenant_name_snapshot TEXT NOT NULL,
  payer_name_snapshot TEXT NOT NULL,
  plugin_slug TEXT NOT NULL REFERENCES plugin_catalog_items(slug),
  plugin_name_snapshot TEXT NOT NULL,
  billing_model TEXT NOT NULL CHECK (
    billing_model IN ('paid_once', 'paid_monthly', 'paid_yearly')
  ),
  order_id TEXT NOT NULL UNIQUE REFERENCES plugin_addon_orders(id),
  entitlement_id TEXT NOT NULL REFERENCES plugin_tenant_entitlements(id),
  currency TEXT NOT NULL DEFAULT 'IDR',
  gross_amount_idr INTEGER NOT NULL CHECK (gross_amount_idr >= 0 AND gross_amount_idr <= 999999999999),
  discount_amount_idr INTEGER NOT NULL DEFAULT 0 CHECK (
    discount_amount_idr >= 0 AND discount_amount_idr <= 999999999999
  ),
  channel_fee_idr INTEGER NOT NULL DEFAULT 0 CHECK (
    channel_fee_idr >= 0 AND channel_fee_idr <= 999999999999
  ),
  total_amount_idr INTEGER NOT NULL CHECK (total_amount_idr >= 0 AND total_amount_idr <= 999999999999),
  coupon_code TEXT,
  payment_channel TEXT NOT NULL,
  provider_reference TEXT,
  r2_object_key TEXT NOT NULL UNIQUE,
  pdf_sha256 TEXT NOT NULL,
  pdf_byte_length INTEGER NOT NULL CHECK (pdf_byte_length > 0),
  non_pkp_notice TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (gross_amount_idr - discount_amount_idr + channel_fee_idr = total_amount_idr)
);

CREATE INDEX IF NOT EXISTS plugin_addon_receipts_tenant_issued_idx
  ON plugin_addon_receipts(tenant_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS plugin_addon_receipts_agency_issued_idx
  ON plugin_addon_receipts(payer_agency_id, issued_at DESC)
  WHERE payer_agency_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS plugin_addon_receipts_immutable_update
BEFORE UPDATE ON plugin_addon_receipts
BEGIN
  SELECT RAISE(ABORT, 'plugin_addon_receipts is immutable');
END;

CREATE TRIGGER IF NOT EXISTS plugin_addon_receipts_no_delete
BEFORE DELETE ON plugin_addon_receipts
BEGIN
  SELECT RAISE(ABORT, 'plugin_addon_receipts cannot be deleted');
END;

${TBL_DDL} IF NOT EXISTS plugin_custom_dev_requests (
  id TEXT PRIMARY KEY,
  request_code TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  service_kind TEXT NOT NULL DEFAULT 'custom_plugin' CHECK (service_kind = 'custom_plugin'),
  title TEXT NOT NULL,
  requirements_summary TEXT NOT NULL,
  contact_whatsapp TEXT NOT NULL,
  budget_range TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (
    status IN ('submitted', 'quoted', 'in_progress', 'fulfilled', 'declined')
  ),
  quote_amount_idr INTEGER CHECK (
    quote_amount_idr IS NULL OR (quote_amount_idr >= 0 AND quote_amount_idr <= 999999999999)
  ),
  operator_notes TEXT,
  status_reason TEXT,
  linked_grant_id TEXT REFERENCES plugin_private_grants(id),
  linked_plugin_slug TEXT REFERENCES plugin_catalog_items(slug),
  idempotency_key TEXT,
  day_bucket TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    status != 'fulfilled'
    OR (linked_grant_id IS NOT NULL AND linked_plugin_slug IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS plugin_custom_dev_requests_tenant_idem_uidx
  ON plugin_custom_dev_requests(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS plugin_custom_dev_requests_tenant_day_idx
  ON plugin_custom_dev_requests(tenant_id, day_bucket);

CREATE INDEX IF NOT EXISTS plugin_custom_dev_requests_status_created_idx
  ON plugin_custom_dev_requests(status, created_at DESC);

-- Seed baseline official catalog entries (idempotent)
INSERT OR IGNORE INTO plugin_catalog_items (
  slug, name, tagline, description, visibility_tier, billing_model, price_idr, active, version, created_at, updated_at
) VALUES
  (
    'seo-ai-autopilot',
    'SEO & AI Autopilot',
    'SEO & indeksasi AI otomatis tanpa setting',
    'Sitemap XML, robots.txt ramah mesin pencari & AI, meta/OG otomatis, Schema.org @graph, dan IndexNow.',
    'public_free',
    'free',
    0,
    1,
    1,
    1763942400000,
    1763942400000
  ),
  (
    'bio-links',
    'Bio Links (/link)',
    'Halaman tautan bio 0-JS di domain sendiri',
    'Halaman /link untuk profil, katalog, dan tautan sosial dengan penghitung klik pihak pertama tanpa JS publik.',
    'public_free',
    'free',
    0,
    1,
    1,
    1763942400000,
    1763942400000
  ),
  (
    'wp-importer',
    'WordPress Draft Importer',
    'Impor artikel WordPress aman ke draf',
    'Impor posting, kategori, metadata SEO, dan gambar WebP dari URL WordPress atau XML WXR langsung menjadi draf.',
    'public_free',
    'free',
    0,
    1,
    1,
    1763942400000,
    1763942400000
  ),
  (
    'wa-cs-rotator',
    'WhatsApp CS Rotator',
    'Distribusi prospek WA otomatis ke tim sales',
    'Rotasi CTA WhatsApp ke banyak agen sales berdasarkan bobot, round-robin, dan jam aktif dengan statistik klik per agen.',
    'public_paid',
    'paid_monthly',
    49000,
    1,
    1,
    1763942400000,
    1763942400000
  ),
  (
    'lead-notifier-pro',
    'Lead Notifier Webhook Pro',
    'Webhook HTTPS bertanda tangan ke CRM & Sheets',
    'Kirim notifikasi prospek masuk secara asinkron ke Google Sheets, CRM, atau gateway WhatsApp dengan tanda tangan HMAC.',
    'public_paid',
    'paid_once',
    299000,
    1,
    1,
    1763942400000,
    1763942400000
  );
`;

export const PLUGIN_STORE_BILLING_MIGRATION: MigrationDescriptor = {
  version: 33,
  name: "0033_plugin_store_billing",
  sql: PLUGIN_STORE_BILLING_MIGRATION_SQL,
} as const;

export async function applyPluginStoreBillingMigrations(
  platformDb: D1Database,
  now: () => number = Date.now,
): Promise<ApplyMigrationsResult> {
  return applyPlatformMigrations(platformDb, [PLUGIN_STORE_BILLING_MIGRATION], now);
}

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Tier 1 — `PLATFORM_DB` (Cloudflare D1 Control Plane) Drizzle SQLite schema.
 * Pre-declares the finalized v1 control-plane tables (PLAN §5.1, ADR-0009).
 */

export const TENANT_STATUSES = [
  "provisioning",
  "trial",
  "active",
  "grace",
  "locked",
  "suspended",
  "recovery",
  "purging",
  "purged",
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const TENANT_VERTICALS = [
  "compro",
  "sales",
  "travel",
  "catalog",
  "resto",
  "dealer",
] as const;
export type TenantVertical = (typeof TENANT_VERTICALS)[number];

// ---------------------------------------------------------------------------
// 1. Auth & IAM (Better Auth SQLite + Organizations + 2FA + MCP OAuth 2.1)
// ---------------------------------------------------------------------------
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("accounts_user_id_idx").on(t.userId),
    uniqueIndex("accounts_provider_account_uidx").on(t.providerId, t.accountId),
  ],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const twoFactors = sqliteTable("two_factors", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const members = sqliteTable(
  "members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", {
      enum: ["owner", "admin", "editor", "agency_staff", "setup_staff"],
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("members_user_id_idx").on(t.userId),
    uniqueIndex("members_org_user_uidx").on(t.organizationId, t.userId),
  ],
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    status: text("status", {
      enum: ["pending", "accepted", "rejected", "canceled", "expired"],
    })
      .notNull()
      .default("pending"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("invitations_org_email_idx").on(t.organizationId, t.email)],
);

export const oauthApplications = sqliteTable("oauth_applications", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  name: text("name").notNull(),
  redirectUrls: text("redirect_urls").notNull(),
  type: text("type").notNull().default("public"),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  userId: text("user_id").references(() => users.id),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    id: text("id").primaryKey(),
    accessToken: text("access_token").notNull().unique(),
    refreshToken: text("refresh_token").unique(),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }).notNull(),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthApplications.clientId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("oauth_access_tokens_user_id_idx").on(t.userId)],
);

export const oauthConsents = sqliteTable(
  "oauth_consents",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthApplications.clientId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").notNull(),
    consentGiven: integer("consent_given", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("oauth_consents_client_user_uidx").on(t.clientId, t.userId)],
);

export const platformOperators = sqliteTable("platform_operators", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  grantedBy: text("granted_by").references(() => users.id),
  reason: text("reason").notNull(),
  grantedAt: integer("granted_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  revokedBy: text("revoked_by").references(() => users.id),
  revokeReason: text("revoke_reason"),
});

// ---------------------------------------------------------------------------
// 2. Agencies & Affiliates
// ---------------------------------------------------------------------------
export const agencies = sqliteTable("agencies", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organizations.id),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  status: text("status", { enum: ["pending", "active", "suspended"] })
    .notNull()
    .default("active"),
  discountPercent: integer("discount_percent").notNull().default(0),
  unpaidTrialCap: integer("unpaid_trial_cap").notNull().default(3),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const affiliates = sqliteTable("affiliates", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  referralCode: text("referral_code").notNull().unique(),
  status: text("status", { enum: ["pending", "active", "suspended", "rejected"] })
    .notNull()
    .default("pending"),
  payoutMethod: text("payout_method"),
  payoutAccountName: text("payout_account_name"),
  payoutAccountNumber: text("payout_account_number"),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// ---------------------------------------------------------------------------
// 3. Tenancy, Routing, PITR Migration Bookmarks & Deletion Tombstones
// ---------------------------------------------------------------------------
export const tenants = sqliteTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    agencyId: text("agency_id").references(() => agencies.id),
    referredByAffiliateId: text("referred_by_affiliate_id").references(() => affiliates.id),
    handle: text("handle").notNull().unique(),
    name: text("name").notNull(),
    vertical: text("vertical", { enum: TENANT_VERTICALS }).notNull().default("compro"),
    status: text("status", { enum: TENANT_STATUSES }).notNull().default("provisioning"),
    operatorHold: integer("operator_hold", { mode: "boolean" }).notNull().default(false),
    operatorHoldReason: text("operator_hold_reason"),
    trialEndsAt: integer("trial_ends_at", { mode: "timestamp_ms" }),
    paidThrough: integer("paid_through", { mode: "timestamp_ms" }),
    deletionDueAt: integer("deletion_due_at", { mode: "timestamp_ms" }),
    retentionPausedAt: integer("retention_paused_at", { mode: "timestamp_ms" }),
    offboardingStartedAt: integer("offboarding_started_at", { mode: "timestamp_ms" }),
    cacheVersion: integer("cache_version").notNull().default(1),
    schemaVersion: integer("schema_version").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("tenants_org_id_idx").on(t.organizationId),
    index("tenants_agency_id_idx").on(t.agencyId),
    index("tenants_status_idx").on(t.status),
  ],
);

export const tenantHosts = sqliteTable(
  "tenant_hosts",
  {
    host: text("host").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    kind: text("kind", { enum: ["subdomain", "custom"] }).notNull(),
    cfCustomHostnameId: text("cf_custom_hostname_id").unique(),
    status: text("status", { enum: ["pending", "active", "failed", "moved", "deleting"] })
      .notNull()
      .default("pending"),
    sslStatus: text("ssl_status").notNull().default("pending"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
    quarantinedUntil: integer("quarantined_until", { mode: "timestamp_ms" }),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("tenant_hosts_tenant_id_idx").on(t.tenantId),
    uniqueIndex("tenant_hosts_one_primary_per_tenant_idx")
      .on(t.tenantId)
      .where(sql`${t.isPrimary} = 1`),
  ],
);

export const migrationBookmarks = sqliteTable(
  "migration_bookmarks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    targetVersion: integer("target_version").notNull(),
    targetMigration: text("target_migration").notNull(),
    bookmark: text("bookmark").notNull(),
    status: text("status", { enum: ["pending", "applied", "failed", "restored"] })
      .notNull()
      .default("pending"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("migration_bookmarks_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

export const deletionTombstones = sqliteTable(
  "deletion_tombstones",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().unique(),
    handle: text("handle").notNull(),
    quarantineUntil: integer("quarantine_until", { mode: "timestamp_ms" }).notNull(),
    googleSubHash: text("google_sub_hash"),
    emailHash: text("email_hash"),
    companyNameHash: text("company_name_hash"),
    reason: text("reason").notNull(),
    deletedBy: text("deleted_by"),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("deletion_tombstones_handle_idx").on(t.handle)],
);

// ---------------------------------------------------------------------------
// 4. Billing, Coupons, Settlements, Entitlements & Receipts
// ---------------------------------------------------------------------------
export const coupons = sqliteTable("coupons", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  discountType: text("discount_type", { enum: ["percent", "fixed_idr"] }).notNull(),
  discountValue: integer("discount_value").notNull(),
  maxRedemptions: integer("max_redemptions"),
  redemptionCount: integer("redemption_count").notNull().default(0),
  validFrom: integer("valid_from", { mode: "timestamp_ms" }),
  validUntil: integer("valid_until", { mode: "timestamp_ms" }),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const billingObligations = sqliteTable(
  "billing_obligations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    payerType: text("payer_type", { enum: ["tenant", "agency"] }).notNull(),
    payerAgencyId: text("payer_agency_id").references(() => agencies.id),
    planInterval: text("plan_interval", { enum: ["monthly", "yearly", "one_time"] }).notNull(),
    status: text("status", { enum: ["open", "paid", "expired", "canceled", "refunded"] })
      .notNull()
      .default("open"),
    grossAmountIdr: integer("gross_amount_idr").notNull(),
    discountAmountIdr: integer("discount_amount_idr").notNull().default(0),
    netAmountIdr: integer("net_amount_idr").notNull(),
    couponId: text("coupon_id").references(() => coupons.id),
    couponSnapshotJson: text("coupon_snapshot_json"),
    dueAt: integer("due_at", { mode: "timestamp_ms" }).notNull(),
    paidAt: integer("paid_at", { mode: "timestamp_ms" }),
    deidentifiedAt: integer("deidentified_at", { mode: "timestamp_ms" }),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("billing_obligations_tenant_id_idx").on(t.tenantId)],
);

export const paymentAttempts = sqliteTable(
  "payment_attempts",
  {
    id: text("id").primaryKey(),
    obligationId: text("obligation_id")
      .notNull()
      .references(() => billingObligations.id),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    channel: text("channel", { enum: ["QRIS", "VA"] }).notNull(),
    provider: text("provider").notNull().default("autolaris"),
    providerTransactionId: text("provider_transaction_id").unique(),
    amountIdr: integer("amount_idr").notNull(),
    state: text("state", { enum: ["initiated", "pending", "settled", "failed", "expired"] })
      .notNull()
      .default("initiated"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    providerPayloadJson: text("provider_payload_json"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("payment_attempts_tenant_id_idx").on(t.tenantId),
    index("payment_attempts_obligation_id_idx").on(t.obligationId),
  ],
);

export const settlements = sqliteTable(
  "settlements",
  {
    id: text("id").primaryKey(),
    obligationId: text("obligation_id")
      .notNull()
      .references(() => billingObligations.id),
    paymentAttemptId: text("payment_attempt_id")
      .notNull()
      .unique()
      .references(() => paymentAttempts.id),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    amountIdr: integer("amount_idr").notNull(),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }).notNull(),
    reconciledVia: text("reconciled_via", { enum: ["webhook", "advice", "manual"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("settlements_tenant_id_idx").on(t.tenantId)],
);

export const entitlementGrants = sqliteTable(
  "entitlement_grants",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    settlementId: text("settlement_id").references(() => settlements.id),
    periodStart: integer("period_start", { mode: "timestamp_ms" }).notNull(),
    periodEnd: integer("period_end", { mode: "timestamp_ms" }).notNull(),
    grantedBy: text("granted_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("entitlement_grants_tenant_id_idx").on(t.tenantId)],
);

export const receiptSequences = sqliteTable("receipt_sequences", {
  year: integer("year").primaryKey(),
  nextSeq: integer("next_seq").notNull().default(0),
});

export const receipts = sqliteTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    settlementId: text("settlement_id").references(() => settlements.id),
    receiptNumber: text("receipt_number").notNull().unique(),
    kind: text("kind", { enum: ["receipt", "credit_note"] })
      .notNull()
      .default("receipt"),
    relatedReceiptId: text("related_receipt_id"),
    amountIdr: integer("amount_idr").notNull(),
    r2PdfKey: text("r2_pdf_key").notNull().unique(),
    issuedAt: integer("issued_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("receipts_tenant_id_idx").on(t.tenantId)],
);

// ---------------------------------------------------------------------------
// 5. Affiliate Commissions & Payout Batches
// ---------------------------------------------------------------------------
export const affiliatePayoutBatches = sqliteTable(
  "affiliate_payout_batches",
  {
    id: text("id").primaryKey(),
    affiliateId: text("affiliate_id")
      .notNull()
      .references(() => affiliates.id),
    batchDate: text("batch_date").notNull(),
    totalAmountIdr: integer("total_amount_idr").notNull(),
    status: text("status", { enum: ["pending", "paid", "canceled"] })
      .notNull()
      .default("pending"),
    transferReference: text("transfer_reference"),
    paidAt: integer("paid_at", { mode: "timestamp_ms" }),
    paidBy: text("paid_by").references(() => users.id),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("affiliate_payout_batches_affiliate_idx").on(t.affiliateId)],
);

export const affiliateCommissions = sqliteTable(
  "affiliate_commissions",
  {
    id: text("id").primaryKey(),
    affiliateId: text("affiliate_id")
      .notNull()
      .references(() => affiliates.id),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    settlementId: text("settlement_id")
      .notNull()
      .references(() => settlements.id),
    payoutBatchId: text("payout_batch_id").references(() => affiliatePayoutBatches.id),
    commissionType: text("commission_type", {
      enum: ["first_payment", "renewal", "offset"],
    }).notNull(),
    ratePercent: integer("rate_percent").notNull(),
    amountIdr: integer("amount_idr").notNull(),
    status: text("status", { enum: ["pending", "approved", "paid", "reversed"] })
      .notNull()
      .default("pending"),
    eligibleAt: integer("eligible_at", { mode: "timestamp_ms" }).notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("affiliate_commissions_affiliate_idx").on(t.affiliateId),
    index("affiliate_commissions_tenant_idx").on(t.tenantId),
  ],
);

// ---------------------------------------------------------------------------
// 6. Theme/Plugin Catalogs, Service Packages/Requests & Platform Ops
// ---------------------------------------------------------------------------
export const themeCatalog = sqliteTable("theme_catalog", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  tier: text("tier", { enum: ["included", "paid_once", "custom"] }).notNull(),
  priceIdr: integer("price_idr").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const tenantThemeEntitlements = sqliteTable(
  "tenant_theme_entitlements",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    themeId: text("theme_id")
      .notNull()
      .references(() => themeCatalog.id),
    grantedBy: text("granted_by"),
    settlementId: text("settlement_id").references(() => settlements.id),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("tenant_theme_entitlements_uidx").on(t.tenantId, t.themeId)],
);

export const pluginCatalog = sqliteTable("plugin_catalog", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  distribution: text("distribution", {
    enum: ["private_client", "public_free", "public_paid"],
  }).notNull(),
  priceIdr: integer("price_idr").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const tenantPluginEntitlements = sqliteTable(
  "tenant_plugin_entitlements",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    pluginId: text("plugin_id")
      .notNull()
      .references(() => pluginCatalog.id),
    grantedBy: text("granted_by"),
    settlementId: text("settlement_id").references(() => settlements.id),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("tenant_plugin_entitlements_uidx").on(t.tenantId, t.pluginId)],
);

export const servicePackages = sqliteTable("service_packages", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["custom_theme", "custom_plugin", "setup"] }).notNull(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  priceIdr: integer("price_idr").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const serviceRequests = sqliteTable(
  "service_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    packageId: text("package_id")
      .notNull()
      .references(() => servicePackages.id),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => users.id),
    status: text("status", {
      enum: ["submitted", "in_review", "in_progress", "delivered", "declined", "canceled"],
    })
      .notNull()
      .default("submitted"),
    briefJson: text("brief_json").notNull(),
    deliveredThemeId: text("delivered_theme_id").references(() => themeCatalog.id),
    deliveredPluginId: text("delivered_plugin_id").references(() => pluginCatalog.id),
    operatorNotes: text("operator_notes"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("service_requests_tenant_id_idx").on(t.tenantId)],
);

export const marketingFunnelEvents = sqliteTable(
  "marketing_funnel_events",
  {
    id: text("id").primaryKey(),
    day: text("day").notNull(),
    eventName: text("event_name").notNull(),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    count: integer("count").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("marketing_funnel_events_day_idx").on(t.day, t.eventName)],
);

export const abuseReports = sqliteTable(
  "abuse_reports",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    reportedHost: text("reported_host").notNull(),
    reportedPath: text("reported_path").notNull(),
    category: text("category").notNull(),
    details: text("details").notNull(),
    reporterContact: text("reporter_contact"),
    status: text("status", { enum: ["open", "investigating", "resolved", "dismissed"] })
      .notNull()
      .default("open"),
    resolutionNotes: text("resolution_notes"),
    resolvedBy: text("resolved_by").references(() => users.id),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("abuse_reports_tenant_id_idx").on(t.tenantId),
    index("abuse_reports_status_idx").on(t.status),
  ],
);

export const platformSettings = sqliteTable("platform_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by").references(() => users.id),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const platformAudit = sqliteTable(
  "platform_audit",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id"),
    actorRole: text("actor_role").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    tenantId: text("tenant_id"),
    reason: text("reason"),
    outcome: text("outcome", { enum: ["success", "denied", "error"] }).notNull(),
    requestId: text("request_id"),
    metadataJson: text("metadata_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("platform_audit_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("platform_audit_action_created_idx").on(t.action, t.createdAt),
  ],
);

export const emailSuppressions = sqliteTable("email_suppressions", {
  emailHash: text("email_hash").primaryKey(),
  reason: text("reason", { enum: ["hard_bounce", "complaint", "manual_opt_out"] }).notNull(),
  source: text("source").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const jobLedger = sqliteTable(
  "job_ledger",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    topic: text("topic").notNull(),
    tenantId: text("tenant_id"),
    status: text("status", { enum: ["queued", "running", "completed", "failed", "dead_letter"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    lastErrorCode: text("last_error_code"),
    payloadJson: text("payload_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("job_ledger_status_idx").on(t.status, t.updatedAt)],
);

export const platformSchema = {
  users,
  sessions,
  accounts,
  verifications,
  twoFactors,
  organizations,
  members,
  invitations,
  oauthApplications,
  oauthAccessTokens,
  oauthConsents,
  platformOperators,
  agencies,
  affiliates,
  tenants,
  tenantHosts,
  migrationBookmarks,
  deletionTombstones,
  coupons,
  billingObligations,
  paymentAttempts,
  settlements,
  entitlementGrants,
  receiptSequences,
  receipts,
  affiliatePayoutBatches,
  affiliateCommissions,
  themeCatalog,
  tenantThemeEntitlements,
  pluginCatalog,
  tenantPluginEntitlements,
  servicePackages,
  serviceRequests,
  marketingFunnelEvents,
  abuseReports,
  platformSettings,
  platformAudit,
  emailSuppressions,
  jobLedger,
} as const;

export type PlatformSchema = typeof platformSchema;

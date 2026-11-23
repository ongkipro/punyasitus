import {
  DEFAULT_AFFILIATE_MARKETING_ORIGIN,
  resolveTenantPoweredByBadge,
  type ResolvedTenantPoweredByBadge,
} from "@punyasitus/core/affiliates/index";
import { buildPlatformAuditStatement } from "../platform/audit.ts";
import {
  AffiliateError,
  type UpdateTenantPoweredBySettingsInput,
  type UpdateTenantPoweredBySettingsResult,
} from "./types.ts";

/**
 * Persistence and live resolution of tenant "Dibuat dengan PunyaSitus" footer badge settings
 * (`packages/db/src/affiliates/powered-by.ts`; REQ-084, DEC-038, TASK-084).
 */

interface TenantBadgeQueryRow {
  readonly tenant_id: string;
  readonly organization_id: string;
  readonly tenant_status: string;
  readonly hide_powered_by_badge: number | null;
  readonly owner_affiliate_id: string | null;
  readonly affiliate_status: string | null;
  readonly affiliate_referral_code: string | null;
  readonly affiliate_user_id: string | null;
}

const PAID_STATUSES = new Set(["active", "grace", "locked"]);

/**
 * Resolves the live minimalist "Dibuat dengan PunyaSitus" badge state for a tenant:
 * - Trial sites ALWAYS render the visible plain badge (cannot hide or attach ref).
 * - Paid sites respect `hide_powered_by_badge` or attach the verified active owner affiliate code.
 */
export async function getTenantPoweredByBadgeForTenant(
  platformDb: D1Database,
  tenantId: string,
  marketingOrigin: string = DEFAULT_AFFILIATE_MARKETING_ORIGIN,
): Promise<ResolvedTenantPoweredByBadge | null> {
  const row = await platformDb
    .prepare(
      `SELECT
        t.id AS tenant_id,
        t.organization_id,
        t.status AS tenant_status,
        s.hide_powered_by_badge,
        s.owner_affiliate_id,
        a.status AS affiliate_status,
        a.referral_code AS affiliate_referral_code,
        a.user_id AS affiliate_user_id
       FROM tenants t
       LEFT JOIN tenant_powered_by_settings s ON s.tenant_id = t.id
       LEFT JOIN affiliates a ON a.id = s.owner_affiliate_id
       WHERE t.id = ?
       LIMIT 1`,
    )
    .bind(tenantId.trim())
    .first<TenantBadgeQueryRow>();

  if (!row) return null;

  let verifiedReferralCode: string | null = null;
  let verifiedAffiliateStatus: string | null = null;

  if (row.owner_affiliate_id && row.affiliate_user_id && row.affiliate_status === "active") {
    // Verify the linked affiliate still belongs to a member of this tenant's organization
    const member = await platformDb
      .prepare("SELECT id FROM members WHERE organization_id = ? AND user_id = ? LIMIT 1")
      .bind(row.organization_id, row.affiliate_user_id)
      .first<{ readonly id: string }>();
    if (member) {
      verifiedReferralCode = row.affiliate_referral_code;
      verifiedAffiliateStatus = row.affiliate_status;
    }
  }

  return resolveTenantPoweredByBadge({
    tenantStatus: row.tenant_status,
    hidePoweredByBadge: row.hide_powered_by_badge === 1,
    affiliateReferralCode: verifiedReferralCode,
    affiliateStatus: verifiedAffiliateStatus,
    marketingOrigin,
  });
}

/**
 * Updates a paid tenant's powered-by badge preference (1-click hide or attach own verified affiliate `?ref=<code>`).
 * Trial tenants cannot hide the badge (`403 TRIAL_BADGE_LOCKED`).
 */
export async function updateTenantPoweredBySettings(
  platformDb: D1Database,
  input: UpdateTenantPoweredBySettingsInput,
): Promise<UpdateTenantPoweredBySettingsResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const tenantId = input.tenantId.trim();
  const actorUserId = input.actorUserId.trim();
  const marketingOrigin = input.marketingOrigin ?? DEFAULT_AFFILIATE_MARKETING_ORIGIN;

  const tenant = await platformDb
    .prepare("SELECT id, organization_id, status FROM tenants WHERE id = ? LIMIT 1")
    .bind(tenantId)
    .first<{ readonly id: string; readonly organization_id: string; readonly status: string }>();

  if (!tenant) {
    throw new AffiliateError(404, "NOT_FOUND", "Situs tenant tidak ditemukan.");
  }

  // Enforce active tenant owner membership before mutating powered-by settings.
  const ownerMembership = await platformDb
    .prepare(
      `SELECT id FROM members
       WHERE organization_id = ?
         AND user_id = ?
         AND role = 'owner'
       LIMIT 1`,
    )
    .bind(tenant.organization_id, actorUserId)
    .first<{ readonly id: string }>();

  if (!ownerMembership) {
    throw new AffiliateError(
      403,
      "FORBIDDEN",
      "Hanya pemilik situs (owner) yang dapat mengubah pengaturan badge footer.",
    );
  }

  const normalizedTenantStatus = tenant.status.trim().toLowerCase();
  if (!PAID_STATUSES.has(normalizedTenantStatus)) {
    throw new AffiliateError(
      403,
      "TRIAL_BADGE_LOCKED",
      'Badge "Dibuat dengan PunyaSitus" tidak dapat disembunyikan atau diubah selama masa trial.',
    );
  }

  let ownerAffiliateId: string | null = null;
  let affiliateReferralCode: string | null = null;
  let affiliateStatus: string | null = null;

  if (!input.hidePoweredByBadge && input.attachOwnAffiliateRef === true) {
    const affiliate = await platformDb
      .prepare(
        `SELECT id, status, referral_code
         FROM affiliates
         WHERE user_id = ?
         LIMIT 1`,
      )
      .bind(actorUserId)
      .first<{ readonly id: string; readonly status: string; readonly referral_code: string }>();

    if (!affiliate || affiliate.status !== "active") {
      throw new AffiliateError(
        403,
        "AFFILIATE_NOT_APPROVED",
        "Hanya akun afiliasi yang telah disetujui dan aktif yang dapat menautkan kode referral pada footer.",
      );
    }
    ownerAffiliateId = affiliate.id;
    affiliateReferralCode = affiliate.referral_code;
    affiliateStatus = affiliate.status;
  }

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(platformDb, {
    actorUserId,
    actorRole: "owner",
    action: "tenant.powered_by.update",
    targetType: "tenant",
    targetId: tenant.id,
    tenantId: tenant.id,
    outcome: "success",
    requestId: input.requestId ?? null,
    createdAtMs: nowMs,
    metadata: {
      hidePoweredByBadge: input.hidePoweredByBadge,
      ownerAffiliateId,
    },
  });

  await platformDb.batch([
    platformDb
      .prepare(
        `INSERT INTO tenant_powered_by_settings (
          tenant_id, hide_powered_by_badge, owner_affiliate_id,
          updated_by_user_id, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (tenant_id)
        DO UPDATE SET
          hide_powered_by_badge = excluded.hide_powered_by_badge,
          owner_affiliate_id = excluded.owner_affiliate_id,
          updated_by_user_id = excluded.updated_by_user_id,
          version = version + 1,
          updated_at = excluded.updated_at`,
      )
      .bind(
        tenant.id,
        input.hidePoweredByBadge ? 1 : 0,
        ownerAffiliateId,
        actorUserId,
        nowMs,
        nowMs,
      ),
    auditStmt,
  ]);

  const badge = resolveTenantPoweredByBadge({
    tenantStatus: tenant.status,
    hidePoweredByBadge: input.hidePoweredByBadge,
    affiliateReferralCode,
    affiliateStatus,
    marketingOrigin,
  });

  return {
    badge,
    hidePoweredByBadge: input.hidePoweredByBadge,
    ownerAffiliateId,
    audit,
  };
}

import {
  AFFILIATE_COOKIE_FUTURE_SKEW_SECONDS,
  AFFILIATE_COOKIE_TTL_MS,
  computePayoutAccountNumberHash,
  computePayoutIdentityHash,
  normalizeAffiliateReferralCode,
  normalizeEmailForAntiAbuse,
  type AffiliateAttributionSource,
  type TenantAttributionExclusionKind,
} from "@punyasitus/core/affiliates/index";
import {
  buildPlatformAuditStatement,
  PlatformAuditError,
  validateOperatorReason,
} from "../platform/audit.ts";
import {
  AffiliateError,
  type AttributionSkipReason,
  type CorrectTenantAffiliateAttributionInput,
  type CorrectTenantAffiliateAttributionResult,
  type LockTenantAffiliateAttributionInput,
  type LockTenantAffiliateAttributionResult,
  type TenantAffiliateAttributionRecord,
  type TenantAttributionEligibilityFlags,
} from "./types.ts";

/**
 * Immutable trial-creation affiliate attribution lock, anti-abuse self-referral &
 * ineligible-tenant guards, and audited superadmin attribution correction
 * (`packages/db/src/affiliates/attribution.ts`; REQ-084, PLAN §19.4, TASK-084).
 *
 * Security invariants:
 * - At most one affiliate per tenant (`affiliate_referrals.tenant_id` PRIMARY KEY +
 *   `tenants.referred_by_affiliate_id`).
 * - Once locked, no subsequent signup, retry, or non-superadmin write/delete can overwrite
 *   or erase attribution (enforced atomically via mutually conditional SQL batch statements
 *   AND `affiliate_referrals_require_superadmin_for_update` /
 *   `affiliate_referrals_block_delete_while_tenant_exists` SQLite triggers).
 * - Expired (>30d) or timestamp-missing cookies, unknown/pending/rejected/suspended affiliates,
 *   self-referrals (matching `user_id`, org membership, normalized email, OAuth identity, or
 *   `payout_identity_hash`), and ineligible tenants (agency-managed, superadmin-created,
 *   complimentary, platform, demo, or malformed org metadata) STRICTLY produce zero attribution.
 * - Superadmin attribution correction verifies active `platform_operators` grant (`403 FORBIDDEN`),
 *   enforces OCC (`expectedVersion`, `409 STALE_VERSION`), requires a 10-500 char reason, and
 *   commits atomically with `platform_audit`.
 */

interface TenantForAttributionRow {
  readonly id: string;
  readonly organization_id: string;
  readonly agency_id: string | null;
  readonly referred_by_affiliate_id: string | null;
  readonly handle: string;
  readonly status: string;
  readonly org_metadata: string | null;
}

interface AffiliateCandidateRow {
  readonly id: string;
  readonly user_id: string;
  readonly referral_code: string;
  readonly status: string;
  readonly user_email: string | null;
  readonly profile_normalized_email: string | null;
  readonly payout_identity_hash: string | null;
  readonly payout_account_number_hash: string | null;
}

interface ReferralRow {
  readonly tenant_id: string;
  readonly affiliate_id: string | null;
  readonly referral_code: string | null;
  readonly attribution_source: AffiliateAttributionSource;
  readonly attributed_at: number;
  readonly locked: number;
  readonly corrected_by_user_id: string | null;
  readonly correction_reason: string | null;
  readonly corrected_at: number | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

function mapReferralRow(row: ReferralRow): TenantAffiliateAttributionRecord {
  return {
    tenantId: row.tenant_id,
    affiliateId: row.affiliate_id,
    referralCode: row.referral_code,
    attributionSource: row.attribution_source,
    attributedAt: row.attributed_at,
    locked: true,
    correctedByUserId: row.corrected_by_user_id,
    correctionReason: row.correction_reason,
    correctedAt: row.corrected_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isNoSuchTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(message);
}

function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(message);
}

function parseMetadataExclusionReason(rawMetadata: string | null): AttributionSkipReason | null {
  if (rawMetadata === null || rawMetadata.trim() === "") return null;
  let parsed: Record<string, unknown>;
  try {
    const val: unknown = JSON.parse(rawMetadata);
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      // Fail closed on malformed/unexpected organization metadata
      return "ineligible_invalid_metadata";
    }
    parsed = val as Record<string, unknown>;
  } catch {
    // Fail closed on corrupted organization metadata JSON
    return "ineligible_invalid_metadata";
  }

  const kind =
    typeof parsed.tenantKind === "string"
      ? parsed.tenantKind.trim().toLowerCase()
      : typeof parsed.kind === "string"
        ? parsed.kind.trim().toLowerCase()
        : "";

  if (parsed.agencyId || parsed.isAgencyManaged === true || kind === "agency" || kind === "agency_managed") {
    return "ineligible_agency_managed";
  }
  if (parsed.isDemo === true || parsed.demo === true || kind === "demo") {
    return "ineligible_demo";
  }
  if (parsed.isComplimentary === true || parsed.complimentary === true || kind === "complimentary") {
    return "ineligible_complimentary";
  }
  if (parsed.isPlatform === true || parsed.platform === true || kind === "platform") {
    return "ineligible_platform";
  }
  const provisionedBy =
    typeof parsed.provisionedBy === "string" ? parsed.provisionedBy.trim().toLowerCase() : "";
  if (
    parsed.isSuperadminCreated === true ||
    parsed.superadminCreated === true ||
    kind === "superadmin" ||
    kind === "superadmin_created" ||
    provisionedBy === "operator" ||
    provisionedBy === "superadmin" ||
    provisionedBy === "platform_operator"
  ) {
    return "ineligible_superadmin_created";
  }

  return null;
}

function mapExclusionKindToReason(kind: TenantAttributionExclusionKind): AttributionSkipReason {
  switch (kind) {
    case "agency_managed":
      return "ineligible_agency_managed";
    case "superadmin_created":
      return "ineligible_superadmin_created";
    case "complimentary":
      return "ineligible_complimentary";
    case "platform":
      return "ineligible_platform";
    case "demo":
      return "ineligible_demo";
  }
}

export async function markTenantAttributionExcluded(
  platformDb: D1Database,
  params: {
    readonly tenantId: string;
    readonly exclusionKind: TenantAttributionExclusionKind;
    readonly reason?: string | null;
    readonly markedByUserId?: string | null;
    readonly nowMs?: number;
  },
): Promise<void> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  await platformDb
    .prepare(
      `INSERT INTO tenant_attribution_exclusions (
        tenant_id, exclusion_kind, reason, marked_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id)
      DO UPDATE SET
        exclusion_kind = excluded.exclusion_kind,
        reason = excluded.reason,
        marked_by_user_id = excluded.marked_by_user_id`,
    )
    .bind(
      params.tenantId.trim(),
      params.exclusionKind,
      params.reason ?? null,
      params.markedByUserId ?? null,
      nowMs,
    )
    .run();
}

/**
 * Evaluates whether a tenant is eligible for affiliate attribution.
 * Blocks agency-managed, superadmin-created, complimentary, platform, demo, and malformed-metadata tenants.
 */
export async function evaluateTenantAttributionEligibility(
  platformDb: D1Database,
  tenant: TenantForAttributionRow,
  flags?: TenantAttributionEligibilityFlags,
): Promise<{ readonly eligible: true } | { readonly eligible: false; readonly reason: AttributionSkipReason }> {
  if (flags?.isAgencyManaged) return { eligible: false, reason: "ineligible_agency_managed" };
  if (flags?.isSuperadminCreated) return { eligible: false, reason: "ineligible_superadmin_created" };
  if (flags?.isComplimentary) return { eligible: false, reason: "ineligible_complimentary" };
  if (flags?.isPlatform) return { eligible: false, reason: "ineligible_platform" };
  if (flags?.isDemo) return { eligible: false, reason: "ineligible_demo" };

  // 1. Direct agency link on tenants table
  if (tenant.agency_id !== null && tenant.agency_id.trim() !== "") {
    return { eligible: false, reason: "ineligible_agency_managed" };
  }

  // 2. Organization metadata markers (fails closed on malformed JSON)
  const metaExclusion = parseMetadataExclusionReason(tenant.org_metadata);
  if (metaExclusion) {
    return { eligible: false, reason: metaExclusion };
  }

  // 3. Explicit tenant_attribution_exclusions table
  const exclusionRow = await platformDb
    .prepare("SELECT exclusion_kind FROM tenant_attribution_exclusions WHERE tenant_id = ? LIMIT 1")
    .bind(tenant.id)
    .first<{ readonly exclusion_kind: TenantAttributionExclusionKind }>();
  if (exclusionRow) {
    return { eligible: false, reason: mapExclusionKindToReason(exclusionRow.exclusion_kind) };
  }

  // 4. Agency client link table (from 0028_agency_portal — swallow ONLY missing table, rethrow real DB errors)
  try {
    const agencyLink = await platformDb
      .prepare("SELECT agency_id FROM agency_client_links WHERE tenant_id = ? LIMIT 1")
      .bind(tenant.id)
      .first<{ readonly agency_id: string }>();
    if (agencyLink) {
      return { eligible: false, reason: "ineligible_agency_managed" };
    }
  } catch (err) {
    if (!isNoSuchTableError(err)) {
      throw err;
    }
  }

  // 5. Superadmin-provisioned tenants recorded in platform_audit
  const superadminAudit = await platformDb
    .prepare(
      `SELECT id FROM platform_audit
       WHERE tenant_id = ?
         AND actor_role = 'platform_operator'
         AND action IN ('console.tenant.provision', 'tenant.provision')
         AND outcome = 'success'
       LIMIT 1`,
    )
    .bind(tenant.id)
    .first<{ readonly id: string }>();
  if (superadminAudit) {
    return { eligible: false, reason: "ineligible_superadmin_created" };
  }

  // 6. Complimentary entitlement grants (non-settlement grants)
  const complimentaryGrant = await platformDb
    .prepare(
      `SELECT id FROM entitlement_grants
       WHERE tenant_id = ? AND settlement_id IS NULL
       LIMIT 1`,
    )
    .bind(tenant.id)
    .first<{ readonly id: string }>();
  if (complimentaryGrant) {
    return { eligible: false, reason: "ineligible_complimentary" };
  }

  return { eligible: true };
}

async function detectSelfReferral(
  platformDb: D1Database,
  params: {
    readonly tenantOrganizationId: string;
    readonly ownerUserId: string;
    readonly affiliate: AffiliateCandidateRow;
    readonly ownerPayoutIdentityHash?: string | null;
    readonly ownerPayoutAccount?: {
      readonly payoutBankCode: string;
      readonly payoutAccountNumber: string;
    } | null;
  },
): Promise<AttributionSkipReason | null> {
  const { ownerUserId, affiliate } = params;

  // 1. Direct user_id match
  if (ownerUserId === affiliate.user_id) {
    return "self_referral_user_id";
  }

  // 2. Affiliate user is already a member of the tenant's organization
  const orgMember = await platformDb
    .prepare("SELECT id FROM members WHERE organization_id = ? AND user_id = ? LIMIT 1")
    .bind(params.tenantOrganizationId, affiliate.user_id)
    .first<{ readonly id: string }>();
  if (orgMember) {
    return "self_referral_org_member";
  }

  // 3. Normalized email match (case-insensitive + Gmail dot/plus canonicalization)
  const ownerRow = await platformDb
    .prepare("SELECT email FROM users WHERE id = ? LIMIT 1")
    .bind(ownerUserId)
    .first<{ readonly email: string }>();

  const ownerNormalizedEmail = ownerRow?.email ? normalizeEmailForAntiAbuse(ownerRow.email) : null;
  const affiliateNormalizedEmail =
    affiliate.profile_normalized_email ??
    (affiliate.user_email ? normalizeEmailForAntiAbuse(affiliate.user_email) : null);

  if (ownerNormalizedEmail && affiliateNormalizedEmail && ownerNormalizedEmail === affiliateNormalizedEmail) {
    return "self_referral_email";
  }

  // 4. Shared OAuth account identity (e.g., same Google sub)
  const sharedOAuth = await platformDb
    .prepare(
      `SELECT a1.id
       FROM accounts a1
       INNER JOIN accounts a2
         ON a1.provider_id = a2.provider_id
        AND a1.account_id = a2.account_id
       WHERE a1.user_id = ?
         AND a2.user_id = ?
       LIMIT 1`,
    )
    .bind(ownerUserId, affiliate.user_id)
    .first<{ readonly id: string }>();
  if (sharedOAuth) {
    return "self_referral_oauth_identity";
  }

  // 5. Payout identity hash match (same bank + account number hash across users)
  const affiliatePayoutHashes = new Set<string>();
  if (affiliate.payout_identity_hash) affiliatePayoutHashes.add(affiliate.payout_identity_hash);
  if (affiliate.payout_account_number_hash) affiliatePayoutHashes.add(affiliate.payout_account_number_hash);

  if (affiliatePayoutHashes.size > 0) {
    const ownerCandidateHashes = new Set<string>();

    if (params.ownerPayoutIdentityHash?.trim()) {
      ownerCandidateHashes.add(params.ownerPayoutIdentityHash.trim());
    }

    if (params.ownerPayoutAccount) {
      const [idHash, acctHash] = await Promise.all([
        computePayoutIdentityHash(params.ownerPayoutAccount),
        computePayoutAccountNumberHash(
          params.ownerPayoutAccount.payoutBankCode,
          params.ownerPayoutAccount.payoutAccountNumber,
        ),
      ]);
      ownerCandidateHashes.add(idHash);
      ownerCandidateHashes.add(acctHash);
    }

    // Check if the owner also has an affiliate enrollment profile (pending/active/suspended/rejected)
    const ownerProfile = await platformDb
      .prepare(
        `SELECT payout_identity_hash, payout_account_number_hash
         FROM affiliate_enrollment_profiles
         WHERE user_id = ?
         LIMIT 1`,
      )
      .bind(ownerUserId)
      .first<{
        readonly payout_identity_hash: string | null;
        readonly payout_account_number_hash: string | null;
      }>();
    if (ownerProfile?.payout_identity_hash) {
      ownerCandidateHashes.add(ownerProfile.payout_identity_hash);
    }
    if (ownerProfile?.payout_account_number_hash) {
      ownerCandidateHashes.add(ownerProfile.payout_account_number_hash);
    }

    // Check recorded user payout identities for the owner
    const ownerPayoutRows = await platformDb
      .prepare("SELECT payout_identity_hash FROM user_payout_identities WHERE user_id = ?")
      .bind(ownerUserId)
      .all<{ readonly payout_identity_hash: string }>();
    for (const row of ownerPayoutRows.results ?? []) {
      if (row.payout_identity_hash) {
        ownerCandidateHashes.add(row.payout_identity_hash);
      }
    }

    for (const h of ownerCandidateHashes) {
      if (affiliatePayoutHashes.has(h)) {
        return "self_referral_payout_identity";
      }
    }
  }

  return null;
}

export async function getTenantAffiliateAttribution(
  platformDb: D1Database,
  tenantId: string,
): Promise<TenantAffiliateAttributionRecord | null> {
  const row = await platformDb
    .prepare("SELECT * FROM affiliate_referrals WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId.trim())
    .first<ReferralRow>();
  return row ? mapReferralRow(row) : null;
}

/**
 * Evaluates all anti-abuse & eligibility rules and locks affiliate attribution immutably
 * on a newly created tenant. Any violation or prior lock produces zero attribution (never overwrites).
 */
export async function lockTenantAffiliateAttribution(
  platformDb: D1Database,
  input: LockTenantAffiliateAttributionInput,
): Promise<LockTenantAffiliateAttributionResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const tenantId = input.tenantId.trim();
  const ownerUserId = input.ownerUserId.trim();

  if (!input.referralCode || !input.referralCode.trim()) {
    return { attributed: false, reason: "no_referral_candidate" };
  }

  // 1. Strict cookie TTL enforcement server-side: cookie & footer_badge MUST supply a valid timestamp!
  if (input.attributionSource === "cookie" || input.attributionSource === "footer_badge") {
    if (typeof input.cookieIssuedAtMs !== "number" || !Number.isFinite(input.cookieIssuedAtMs)) {
      return { attributed: false, reason: "cookie_expired" };
    }
    if (input.cookieIssuedAtMs > nowMs + AFFILIATE_COOKIE_FUTURE_SKEW_SECONDS * 1000) {
      return { attributed: false, reason: "cookie_expired" };
    }
    if (nowMs - input.cookieIssuedAtMs > AFFILIATE_COOKIE_TTL_MS) {
      return { attributed: false, reason: "cookie_expired" };
    }
  }

  // 2. Referral code format validation
  const normalizedCode = normalizeAffiliateReferralCode(input.referralCode);
  if (!normalizedCode) {
    return { attributed: false, reason: "invalid_code" };
  }

  // 3. Load tenant + organization metadata
  const tenant = await platformDb
    .prepare(
      `SELECT
        t.id,
        t.organization_id,
        t.agency_id,
        t.referred_by_affiliate_id,
        t.handle,
        t.status,
        o.metadata AS org_metadata
       FROM tenants t
       LEFT JOIN organizations o ON o.id = t.organization_id
       WHERE t.id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<TenantForAttributionRow>();

  if (!tenant) {
    return { attributed: false, reason: "tenant_not_found" };
  }

  // 4. Immutability check: never overwrite an existing lock
  const existingLock = await platformDb
    .prepare("SELECT affiliate_id FROM affiliate_referrals WHERE tenant_id = ? LIMIT 1")
    .bind(tenant.id)
    .first<{ readonly affiliate_id: string | null }>();

  if (existingLock || tenant.referred_by_affiliate_id !== null) {
    return {
      attributed: false,
      reason: "already_locked",
      existingAffiliateId: existingLock?.affiliate_id ?? tenant.referred_by_affiliate_id,
    };
  }

  // 5. Tenant eligibility check (agency, superadmin, complimentary, platform, demo, malformed metadata)
  const eligibility = await evaluateTenantAttributionEligibility(
    platformDb,
    tenant,
    input.eligibilityFlags,
  );
  if (!eligibility.eligible) {
    return { attributed: false, reason: eligibility.reason };
  }

  // 6. Look up affiliate by normalized referral code & verify active status
  const affiliate = await platformDb
    .prepare(
      `SELECT
        a.id,
        a.user_id,
        a.referral_code,
        a.status,
        u.email AS user_email,
        p.normalized_email AS profile_normalized_email,
        p.payout_identity_hash,
        p.payout_account_number_hash
       FROM affiliates a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN affiliate_enrollment_profiles p ON p.affiliate_id = a.id
       WHERE UPPER(a.referral_code) = ?
         AND SUBSTR(LOWER(a.referral_code), 1, 10) != '__pending_'
       LIMIT 1`,
    )
    .bind(normalizedCode)
    .first<AffiliateCandidateRow>();

  if (!affiliate) {
    return { attributed: false, reason: "affiliate_not_found" };
  }

  if (affiliate.status !== "active") {
    return { attributed: false, reason: "affiliate_not_active" };
  }

  // 7. Self-referral anti-abuse checks
  const selfRefReason = await detectSelfReferral(platformDb, {
    tenantOrganizationId: tenant.organization_id,
    ownerUserId,
    affiliate,
    ownerPayoutIdentityHash: input.ownerPayoutIdentityHash,
    ownerPayoutAccount: input.ownerPayoutAccount,
  });
  if (selfRefReason) {
    return { attributed: false, reason: selfRefReason };
  }

  // 8. Atomic, mutually conditional immutable lock commit (zero store divergence on races!)
  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: ownerUserId,
      actorRole: "owner",
      action: "affiliate.attribution.lock",
      targetType: "tenant",
      targetId: tenant.id,
      tenantId: tenant.id,
      outcome: "success",
      requestId: input.requestId ?? null,
      createdAtMs: nowMs,
      metadata: {
        affiliateId: affiliate.id,
        referralCode: normalizedCode,
        attributionSource: input.attributionSource,
      },
    },
    { onlyIfPreviousChanged: true },
  );

  const results = await platformDb.batch([
    platformDb
      .prepare(
        `INSERT OR IGNORE INTO affiliate_referrals (
          tenant_id, affiliate_id, referral_code, attribution_source,
          attributed_at, locked, version, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, 1, 1, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM tenants
          WHERE id = ?
            AND referred_by_affiliate_id IS NULL
            AND agency_id IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM tenant_attribution_exclusions
          WHERE tenant_id = ?
        )`,
      )
      .bind(
        tenant.id,
        affiliate.id,
        normalizedCode,
        input.attributionSource,
        nowMs,
        nowMs,
        nowMs,
        tenant.id,
        tenant.id,
      ),
    platformDb
      .prepare(
        `UPDATE tenants
         SET referred_by_affiliate_id = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = ?
           AND referred_by_affiliate_id IS NULL
           AND agency_id IS NULL
           AND EXISTS (
             SELECT 1 FROM affiliate_referrals
             WHERE tenant_id = ?
               AND affiliate_id = ?
           )`,
      )
      .bind(affiliate.id, nowMs, tenant.id, tenant.id, affiliate.id),
    auditStmt,
  ]);

  const inserted = results[0]?.meta?.changes ?? 0;
  const updatedTenant = results[1]?.meta?.changes ?? 0;

  if (inserted !== 1 || updatedTenant !== 1) {
    const current = await getTenantAffiliateAttribution(platformDb, tenant.id);
    return {
      attributed: false,
      reason: "already_locked",
      existingAffiliateId: current?.affiliateId ?? null,
    };
  }

  const saved = await getTenantAffiliateAttribution(platformDb, tenant.id);
  if (!saved) {
    return { attributed: false, reason: "already_locked" };
  }

  return { attributed: true, attribution: saved, audit };
}

/**
 * Explicit audited superadmin correction of a tenant's affiliate attribution
 * (the ONLY permitted path to change or clear a locked `referred_by_affiliate_id`).
 *
 * Enforces:
 * - Active `platform_operators` grant verification (`403 FORBIDDEN`)
 * - Mandatory 10-500 char reason (`422 VALIDATION_ERROR`)
 * - Optimistic concurrency control (`expectedVersion`, `409 STALE_VERSION`)
 * - Anti-abuse & tenant eligibility checks when assigning a non-null affiliate
 */
export async function correctTenantAffiliateAttribution(
  platformDb: D1Database,
  input: CorrectTenantAffiliateAttributionInput,
): Promise<CorrectTenantAffiliateAttributionResult> {
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId) {
    throw new AffiliateError(
      403,
      "FORBIDDEN",
      "Hanya operator platform aktif yang diizinkan mengoreksi atribusi afiliasi.",
    );
  }

  // 1. Live superadmin / operator grant verification
  const operatorGrant = await platformDb
    .prepare(
      `SELECT user_id FROM platform_operators
       WHERE user_id = ? AND revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(actorUserId)
    .first<{ readonly user_id: string }>();

  if (!operatorGrant) {
    throw new AffiliateError(
      403,
      "FORBIDDEN",
      "Hanya operator platform aktif yang diizinkan mengoreksi atribusi afiliasi.",
    );
  }

  // 2. Mandatory reason validation
  let validatedReason: string;
  try {
    validatedReason = validateOperatorReason(input.reason);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new AffiliateError(422, "VALIDATION_ERROR", err.message, {
        field: "reason",
        cause: err,
      });
    }
    throw err;
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const tenantId = input.tenantId.trim();

  const tenant = await platformDb
    .prepare(
      `SELECT
        t.id,
        t.organization_id,
        t.agency_id,
        t.referred_by_affiliate_id,
        t.handle,
        t.status,
        o.metadata AS org_metadata
       FROM tenants t
       LEFT JOIN organizations o ON o.id = t.organization_id
       WHERE t.id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<TenantForAttributionRow>();

  if (!tenant) {
    throw new AffiliateError(404, "NOT_FOUND", "Situs tenant tidak ditemukan.");
  }

  const existingReferral = await getTenantAffiliateAttribution(platformDb, tenant.id);
  const previousAffiliateId = existingReferral?.affiliateId ?? tenant.referred_by_affiliate_id;

  // 3. Optimistic concurrency check (`expectedVersion`)
  if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
    const currentVersion = existingReferral?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      throw new AffiliateError(
        409,
        "STALE_VERSION",
        "Versi atribusi afiliasi sudah berubah. Muat ulang sebelum melakukan koreksi.",
      );
    }
  }

  let targetAffiliateId: string | null = null;
  let targetReferralCode: string | null = null;

  if (input.newAffiliateId !== null && input.newAffiliateId.trim() !== "") {
    const eligibility = await evaluateTenantAttributionEligibility(platformDb, tenant);
    if (!eligibility.eligible) {
      throw new AffiliateError(
        422,
        "TENANT_INELIGIBLE_FOR_ATTRIBUTION",
        `Tenant tidak memenuhi syarat atribusi afiliasi (${eligibility.reason}).`,
      );
    }

    const affiliate = await platformDb
      .prepare(
        `SELECT
          a.id,
          a.user_id,
          a.referral_code,
          a.status,
          u.email AS user_email,
          p.normalized_email AS profile_normalized_email,
          p.payout_identity_hash,
          p.payout_account_number_hash
         FROM affiliates a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN affiliate_enrollment_profiles p ON p.affiliate_id = a.id
         WHERE a.id = ?
         LIMIT 1`,
      )
      .bind(input.newAffiliateId.trim())
      .first<AffiliateCandidateRow>();

    if (!affiliate) {
      throw new AffiliateError(404, "AFFILIATE_NOT_FOUND", "Akun afiliasi tujuan tidak ditemukan.");
    }
    if (affiliate.status !== "active") {
      throw new AffiliateError(
        422,
        "AFFILIATE_NOT_ACTIVE",
        "Hanya afiliasi berstatus aktif yang dapat ditetapkan pada koreksi atribusi.",
      );
    }

    // Check self-referral against the tenant's owner (includes user_id, org member, email, OAuth & payout hashes)
    const ownerMember = await platformDb
      .prepare(
        "SELECT user_id FROM members WHERE organization_id = ? AND role = 'owner' ORDER BY created_at ASC LIMIT 1",
      )
      .bind(tenant.organization_id)
      .first<{ readonly user_id: string }>();

    if (ownerMember) {
      const selfRef = await detectSelfReferral(platformDb, {
        tenantOrganizationId: tenant.organization_id,
        ownerUserId: ownerMember.user_id,
        affiliate,
      });
      if (selfRef) {
        throw new AffiliateError(
          422,
          "SELF_REFERRAL_FORBIDDEN",
          `Koreksi atribusi ditolak karena terdeteksi self-referral (${selfRef}).`,
        );
      }
    }

    targetAffiliateId = affiliate.id;
    targetReferralCode = normalizeAffiliateReferralCode(affiliate.referral_code);
  }

  const effectiveCorrectedAt =
    existingReferral && existingReferral.correctedAt !== null && existingReferral.correctedAt >= nowMs
      ? existingReferral.correctedAt + 1
      : nowMs;

  const nextVersion = existingReferral ? existingReferral.version + 1 : 1;

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: "platform_operator",
      action: "console.affiliate.attribution.correct",
      targetType: "tenant",
      targetId: tenant.id,
      tenantId: tenant.id,
      reason: validatedReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      createdAtMs: nowMs,
      metadata: {
        previousAffiliateId,
        newAffiliateId: targetAffiliateId,
        newReferralCode: targetReferralCode,
        previousVersion: existingReferral?.version ?? 0,
        newVersion: nextVersion,
      },
    },
    { onlyIfPreviousChanged: true },
  );

  try {
    if (existingReferral) {
      const results = await platformDb.batch([
        platformDb
          .prepare(
            `UPDATE affiliate_referrals
             SET affiliate_id = ?,
                 referral_code = ?,
                 attribution_source = 'superadmin_correction',
                 corrected_by_user_id = ?,
                 correction_reason = ?,
                 corrected_at = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE tenant_id = ? AND version = ?`,
          )
          .bind(
            targetAffiliateId,
            targetReferralCode,
            actorUserId,
            validatedReason,
            effectiveCorrectedAt,
            nowMs,
            tenant.id,
            existingReferral.version,
          ),
        platformDb
          .prepare(
            `UPDATE tenants
             SET referred_by_affiliate_id = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ?
               AND changes() = 1
               AND EXISTS (
                 SELECT 1 FROM affiliate_referrals
                 WHERE tenant_id = ?
                   AND version = ?
                   AND affiliate_id IS ?
                   AND corrected_at = ?
               )`,
          )
          .bind(
            targetAffiliateId,
            nowMs,
            tenant.id,
            tenant.id,
            nextVersion,
            targetAffiliateId,
            effectiveCorrectedAt,
          ),
        auditStmt,
      ]);

      if ((results[0]?.meta?.changes ?? 0) !== 1) {
        throw new AffiliateError(
          409,
          "STALE_VERSION",
          "Versi atribusi afiliasi berubah secara bersamaan. Silakan muat ulang.",
        );
      }
    } else {
      await platformDb.batch([
        platformDb
          .prepare(
            `INSERT INTO affiliate_referrals (
              tenant_id, affiliate_id, referral_code, attribution_source,
              attributed_at, locked, corrected_by_user_id, correction_reason,
              corrected_at, version, created_at, updated_at
            ) VALUES (?, ?, ?, 'superadmin_correction', ?, 1, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(
            tenant.id,
            targetAffiliateId,
            targetReferralCode,
            nowMs,
            actorUserId,
            validatedReason,
            effectiveCorrectedAt,
            nowMs,
            nowMs,
          ),
        platformDb
          .prepare(
            `UPDATE tenants
             SET referred_by_affiliate_id = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ?`,
          )
          .bind(targetAffiliateId, nowMs, tenant.id),
        auditStmt,
      ]);
    }
  } catch (err) {
    if (err instanceof AffiliateError) throw err;
    if (isUniqueConstraintError(err)) {
      throw new AffiliateError(
        409,
        "STALE_VERSION",
        "Atribusi afiliasi untuk tenant ini baru saja diubah secara bersamaan. Silakan muat ulang.",
        { cause: err },
      );
    }
    throw new AffiliateError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menyimpan koreksi atribusi afiliasi secara atomik.",
      { cause: err },
    );
  }

  const saved = await getTenantAffiliateAttribution(platformDb, tenant.id);
  if (!saved) {
    throw new AffiliateError(500, "AUDIT_PERSISTENCE_FAILED", "Gagal memuat hasil koreksi atribusi.");
  }

  return {
    attribution: saved,
    previousAffiliateId,
    audit,
  };
}

import {
  BILLING_CURRENCY,
  BillingConflictError,
  BillingValidationError,
  DEFAULT_OBLIGATION_TTL_MS,
  assertExactIdrInteger,
  buildImmutableObligationSnapshot,
  computeSubscriptionPeriodPreview,
  generateBillingUlid,
  type BillingPlanInterval,
} from "@punyasitus/core/billing/index";
import {
  computeServerTrialWindow,
  sha256Hex,
  validateOnboardingHandleFormat,
} from "@punyasitus/core/onboarding/index";
import {
  expireStaleOpenObligationsForTenant,
  findOpenSubscriptionObligation,
  getTenantObligationById,
  getTenantPaymentAttemptById,
  loadPlatformBillingPricing,
  loadTenantBillingContext,
  type BeginDurableAttemptResult,
  type BillingObligationRecord,
  type PaymentAttemptRecord,
  type PlatformBillingPricing,
} from "../billing/repository.ts";
import { listAgencyPaymentReceipts, type PaymentReceiptRecord } from "../billing/receipts/repository.ts";
import type { TenantStoreNamespaceLike } from "../connections/index.ts";
import {
  buildPlatformAuditStatement,
  generatePlatformAuditId,
  validateOperatorReason,
  type PlatformAuditRecord,
} from "../platform/audit.ts";
import { TENANT_VERTICALS, type TenantStatus, type TenantVertical } from "../platform/schema.ts";
import {
  DEFAULT_INITIAL_OWNER_INVITE_TTL_MS,
  DEFAULT_SAAS_ZONE,
  PROVISIONING_RESERVED_HANDLES,
  initializeTenantStoreDefaults,
} from "../provisioning/index.ts";
import { computeEffectiveTenantStatus } from "../routing/resolver.ts";
import {
  computeAgencyClientCheckoutAmounts,
  computeEffectiveAgencyDiscountPercent,
  evaluateAgencyTrialQuota,
  parseStoredDiscountTiersJson,
  validateAgencyDiscountPercent,
  validateAgencyDiscountTiers,
} from "./pricing.ts";
import {
  AgencyError,
  DEFAULT_AGENCY_TERMS_VERSION,
  DEFAULT_AGENCY_UNPAID_TRIAL_CAP,
  type AgencyCheckoutAmounts,
  type AgencyClientContextBannerPayload,
  type AgencyClientSummary,
  type AgencyDiscountTier,
  type AgencyEnrollmentSource,
  type AgencyInvitationRecord,
  type AgencyMemberRecord,
  type AgencyMemberRole,
  type AgencyStatus,
  type AgencySummary,
  type UserAgencyMembership,
} from "./types.ts";

/**
 * Authoritative D1 repository for Agency / Reseller Portal, Client Provisioning,
 * Atomic Unpaid-Trial Cap Enforcement, Scoped Context Switching, and Agency-Payer Billing
 * (REQ-083, PLAN §19.4, TASK-083).
 *
 * ZERO runtime DDL on hot paths — relies on applied `0028_agency_portal.sql` migration.
 */

const SIMPLE_EMAIL_RE = /^[^\s@<>,;"'\\]+@[^\s@<>,;"'\\]+\.[^\s@<>,;"'\\]{2,}$/;
const SAFE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const DEFAULT_INVITATION_TTL_MS = 72 * 60 * 60 * 1000; // 72h
const VERTICAL_SET = new Set<string>(TENANT_VERTICALS);

function generateAgencyUlid(nowMs: number): string {
  return generateBillingUlid(nowMs);
}

function generateSecureToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 254 || !SIMPLE_EMAIL_RE.test(trimmed)) {
    throw new AgencyError(422, "VALIDATION_ERROR", "Format alamat email tidak valid.");
  }
  return trimmed;
}

function normalizeAgencyName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length < 2 || trimmed.length > 100) {
    throw new AgencyError(
      422,
      "VALIDATION_ERROR",
      "Nama agensi harus terdiri dari 2 hingga 100 karakter.",
    );
  }
  return trimmed;
}

function normalizeClientName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length < 2 || trimmed.length > 100) {
    throw new AgencyError(
      422,
      "VALIDATION_ERROR",
      "Nama situs klien harus terdiri dari 2 hingga 100 karakter.",
    );
  }
  return trimmed;
}

function buildOrgSlug(prefix: string, name: string, nowMs: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${prefix}-${base || "workspace"}-${nowMs.toString(36)}-${rand}`.slice(0, 60);
}

function normalizeVertical(raw?: string | null): TenantVertical {
  const candidate = (raw ?? "compro").trim().toLowerCase();
  if (!VERTICAL_SET.has(candidate)) {
    throw new AgencyError(
      422,
      "VALIDATION_ERROR",
      `Kategori situs "${raw}" tidak dikenali.`,
    );
  }
  return candidate as TenantVertical;
}

function isOwnerUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("UNIQUE") &&
    (msg.includes("agencies.owner_user_id") || msg.includes("agencies_owner_user_uidx"))
  );
}

interface RawAgencyRow {
  readonly id: string;
  readonly organization_id: string;
  readonly owner_user_id: string;
  readonly owner_email: string | null;
  readonly owner_name: string | null;
  readonly name: string;
  readonly status: AgencyStatus;
  readonly discount_percent: number;
  readonly unpaid_trial_cap: number;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly enrollment_source: AgencyEnrollmentSource | null;
  readonly terms_version: string | null;
  readonly terms_accepted_at: number | null;
  readonly billing_email: string | null;
  readonly billing_name: string | null;
  readonly discount_tiers_json: string | null;
  readonly total_client_count: number;
  readonly unpaid_trial_count: number;
  readonly paid_client_count: number;
}

interface RawUserAgencyRow extends RawAgencyRow {
  readonly member_role: AgencyMemberRole;
}

const AGENCY_SUMMARY_COLUMNS_SQL = `
  a.id,
  a.organization_id,
  a.owner_user_id,
  u.email AS owner_email,
  u.name AS owner_name,
  a.name,
  a.status,
  a.discount_percent,
  a.unpaid_trial_cap,
  a.version,
  a.created_at,
  a.updated_at,
  aer.enrollment_source,
  aer.terms_version,
  aer.terms_accepted_at,
  aer.billing_email,
  aer.billing_name,
  aer.discount_tiers_json,
  (
    SELECT COUNT(*)
    FROM tenants t
    WHERE t.agency_id = a.id
      AND t.status != 'purged'
  ) AS total_client_count,
  (
    SELECT COUNT(*)
    FROM agency_client_links acl
    INNER JOIN tenants t ON t.id = acl.tenant_id
    WHERE acl.agency_id = a.id
      AND t.status != 'purged'
      AND acl.is_unpaid_trial = 1
      AND acl.first_settled_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.tenant_id = t.id)
  ) AS unpaid_trial_count,
  (
    SELECT COUNT(DISTINCT t.id)
    FROM tenants t
    LEFT JOIN agency_client_links acl ON acl.tenant_id = t.id
    WHERE t.agency_id = a.id
      AND t.status != 'purged'
      AND (
        acl.first_settled_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM settlements s WHERE s.tenant_id = t.id)
      )
  ) AS paid_client_count
`.trim();

const AGENCY_SUMMARY_SELECT_SQL = `
  SELECT ${AGENCY_SUMMARY_COLUMNS_SQL}
  FROM agencies a
  LEFT JOIN users u ON u.id = a.owner_user_id
  LEFT JOIN agency_enrollment_records aer ON aer.agency_id = a.id
`.trim();

function mapAgencySummaryRow(row: RawAgencyRow): AgencySummary {
  const discountTiers = parseStoredDiscountTiersJson(row.discount_tiers_json);
  const paidClientCount = Math.max(0, Number(row.paid_client_count ?? 0));
  const unpaidTrialCount = Math.max(0, Number(row.unpaid_trial_count ?? 0));
  const totalClientCount = Math.max(0, Number(row.total_client_count ?? 0));
  const baseDiscountPercent = Math.max(0, Number(row.discount_percent ?? 0));
  const unpaidTrialCap = Math.max(
    0,
    Number(row.unpaid_trial_cap ?? DEFAULT_AGENCY_UNPAID_TRIAL_CAP),
  );

  const effective = computeEffectiveAgencyDiscountPercent({
    baseDiscountPercent,
    discountTiers,
    paidClientCount,
  });

  const trialQuota = evaluateAgencyTrialQuota({
    unpaidTrialCount,
    paidClientCount,
    unpaidTrialCap,
  });

  return {
    id: row.id,
    organizationId: row.organization_id,
    ownerUserId: row.owner_user_id,
    ownerEmail: row.owner_email,
    ownerName: row.owner_name,
    name: row.name,
    status: row.status,
    enrollmentSource: row.enrollment_source ?? "self_registered",
    termsVersion: row.terms_version,
    termsAcceptedAt: row.terms_accepted_at,
    billingEmail: row.billing_email ?? row.owner_email ?? "",
    billingName: row.billing_name ?? row.name,
    baseDiscountPercent,
    effectiveDiscountPercent: effective.effectiveDiscountPercent,
    discountTierCode: effective.tierCode,
    discountTiers,
    unpaidTrialCap,
    totalClientCount,
    trialQuota,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getAgencyById(
  db: D1Database,
  agencyId: string,
): Promise<AgencySummary | null> {
  const cleanId = agencyId.trim();
  if (!cleanId) return null;
  const row = await db
    .prepare(`${AGENCY_SUMMARY_SELECT_SQL} WHERE a.id = ? LIMIT 1`)
    .bind(cleanId)
    .first<RawAgencyRow>();
  return row ? mapAgencySummaryRow(row) : null;
}

/**
 * Resolves a user's active agency memberships strictly from `agency_members` (`status = 'active'`).
 * NEVER matches a user whose `agency_members.status = 'revoked'` via fallback `members` or
 * `agencies.owner_user_id` rows!
 */
export async function listUserAgencyMemberships(
  db: D1Database,
  userId: string,
  options: { readonly includeSuspended?: boolean } = {},
): Promise<readonly UserAgencyMembership[]> {
  const cleanUserId = userId.trim();
  if (!cleanUserId) return [];

  const statusClause = options.includeSuspended ? "" : "AND a.status = 'active'";
  const res = await db
    .prepare(
      `SELECT ${AGENCY_SUMMARY_COLUMNS_SQL},
              am.role AS member_role
       FROM agencies a
       INNER JOIN agency_members am
         ON am.agency_id = a.id
        AND am.user_id = ?
        AND am.status = 'active'
       LEFT JOIN users u ON u.id = a.owner_user_id
       LEFT JOIN agency_enrollment_records aer ON aer.agency_id = a.id
       WHERE 1 = 1
       ${statusClause}
       ORDER BY a.created_at ASC`,
    )
    .bind(cleanUserId)
    .all<RawUserAgencyRow>();

  return (res.results ?? []).map((row) => ({
    agency: mapAgencySummaryRow(row),
    role: row.member_role,
  }));
}

export async function listUserAgencies(
  db: D1Database,
  userId: string,
  options: { readonly includeSuspended?: boolean } = {},
): Promise<readonly AgencySummary[]> {
  const memberships = await listUserAgencyMemberships(db, userId, options);
  return memberships.map((m) => m.agency);
}

export async function listConsoleAgencies(
  db: D1Database,
  options: { readonly status?: AgencyStatus; readonly limit?: number } = {},
): Promise<readonly AgencySummary[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));

  if (options.status) {
    const res = await db
      .prepare(`${AGENCY_SUMMARY_SELECT_SQL} WHERE a.status = ? ORDER BY a.created_at DESC LIMIT ?`)
      .bind(options.status, limit)
      .all<RawAgencyRow>();
    return (res.results ?? []).map(mapAgencySummaryRow);
  }

  const res = await db
    .prepare(`${AGENCY_SUMMARY_SELECT_SQL} ORDER BY a.created_at DESC LIMIT ?`)
    .bind(limit)
    .all<RawAgencyRow>();
  return (res.results ?? []).map(mapAgencySummaryRow);
}

export interface SelfRegisterAgencyInput {
  readonly userId: string;
  readonly agencyName: string;
  readonly billingEmail?: string | null;
  readonly billingName?: string | null;
  readonly acceptTerms: boolean;
  readonly termsVersion?: string | null;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export async function selfRegisterAgency(
  db: D1Database,
  input: SelfRegisterAgencyInput,
): Promise<{ readonly agency: AgencySummary; readonly audit: PlatformAuditRecord }> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const userId = input.userId.trim();
  if (!userId) {
    throw new AgencyError(401, "FORBIDDEN", "Autentikasi diperlukan untuk pendaftaran agensi.");
  }

  if (input.acceptTerms !== true) {
    throw new AgencyError(
      422,
      "AGENCY_TERMS_REQUIRED",
      "Anda wajib menyetujui syarat dan ketentuan program agensi PunyaSitus.",
    );
  }

  const agencyName = normalizeAgencyName(input.agencyName);
  const termsVersion = (input.termsVersion?.trim() || DEFAULT_AGENCY_TERMS_VERSION).slice(0, 64);

  const userRow = await db
    .prepare("SELECT id, name, email, email_verified FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{
      readonly id: string;
      readonly name: string;
      readonly email: string;
      readonly email_verified: number;
    }>();

  if (!userRow) {
    throw new AgencyError(404, "NOT_FOUND", "Akun pengguna tidak ditemukan.");
  }
  if (userRow.email_verified !== 1) {
    throw new AgencyError(
      403,
      "EMAIL_NOT_VERIFIED",
      "Email akun harus terverifikasi sebelum mendaftar sebagai agensi.",
    );
  }

  const existingAgency = await db
    .prepare("SELECT id FROM agencies WHERE owner_user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ readonly id: string }>();
  if (existingAgency) {
    throw new AgencyError(
      409,
      "AGENCY_ALREADY_EXISTS",
      "Akun ini sudah terdaftar sebagai pemilik agensi.",
    );
  }

  const billingEmail = input.billingEmail
    ? normalizeEmail(input.billingEmail)
    : userRow.email.toLowerCase();
  const billingName = input.billingName?.trim()
    ? normalizeAgencyName(input.billingName)
    : agencyName;

  const agencyId = generateAgencyUlid(nowMs);
  const orgId = generateAgencyUlid(nowMs);
  const orgMemberId = generateAgencyUlid(nowMs);
  const agencyMemberId = generateAgencyUlid(nowMs);
  const orgSlug = buildOrgSlug("agency", agencyName, nowMs);

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(db, {
    actorUserId: userId,
    actorRole: "agency_owner",
    action: "agency.self_register",
    targetType: "agency",
    targetId: agencyId,
    reason: `Self-registered agency "${agencyName}" with 0% initial discount`,
    requireReason: false,
    outcome: "success",
    requestId: input.requestId ?? null,
    metadata: {
      agencyId,
      enrollmentSource: "self_registered",
      termsVersion,
      initialDiscountPercent: 0,
      unpaidTrialCap: DEFAULT_AGENCY_UNPAID_TRIAL_CAP,
    },
    createdAtMs: nowMs,
  });

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO organizations (id, name, slug, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(orgId, agencyName, orgSlug, nowMs, nowMs),
      db
        .prepare(
          `INSERT INTO members (id, organization_id, user_id, role, created_at)
           VALUES (?, ?, ?, 'owner', ?)`,
        )
        .bind(orgMemberId, orgId, userId, nowMs),
      db
        .prepare(
          `INSERT INTO agencies (
             id, organization_id, owner_user_id, name, status,
             discount_percent, unpaid_trial_cap, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'active', 0, ?, 1, ?, ?)`,
        )
        .bind(agencyId, orgId, userId, agencyName, DEFAULT_AGENCY_UNPAID_TRIAL_CAP, nowMs, nowMs),
      db
        .prepare(
          `INSERT INTO agency_members (
             id, agency_id, user_id, role, status, invited_by_user_id, created_at, updated_at
           ) VALUES (?, ?, ?, 'agency_owner', 'active', ?, ?, ?)`,
        )
        .bind(agencyMemberId, agencyId, userId, userId, nowMs, nowMs),
      db
        .prepare(
          `INSERT INTO agency_enrollment_records (
             agency_id, enrollment_source, terms_version, terms_accepted_at,
             terms_accepted_by_user_id, billing_email, billing_name,
             discount_tier_code, discount_tiers_json, created_at, updated_at
           ) VALUES (?, 'self_registered', ?, ?, ?, ?, ?, 'standard_0', '[]', ?, ?)`,
        )
        .bind(
          agencyId,
          termsVersion,
          nowMs,
          userId,
          billingEmail,
          billingName,
          nowMs,
          nowMs,
        ),
      auditStmt,
    ]);
  } catch (err) {
    if (isOwnerUniqueViolation(err)) {
      throw new AgencyError(
        409,
        "AGENCY_ALREADY_EXISTS",
        "Akun ini sudah terdaftar sebagai pemilik agensi.",
        err,
      );
    }
    throw err;
  }

  const agency = await getAgencyById(db, agencyId);
  if (!agency) {
    throw new AgencyError(500, "AUDIT_PERSISTENCE_FAILED", "Gagal memuat agensi setelah pendaftaran.");
  }

  return { agency, audit };
}

export interface CreateOperatorAgencyInvitationInput {
  readonly actorUserId: string;
  readonly actorRole?: string;
  readonly email: string;
  readonly agencyName: string;
  readonly reason: string;
  readonly expiresInHours?: number;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export async function createOperatorAgencyInvitation(
  db: D1Database,
  input: CreateOperatorAgencyInvitationInput,
): Promise<{
  readonly invitation: AgencyInvitationRecord;
  readonly rawToken: string;
  readonly acceptPath: string;
  readonly audit: PlatformAuditRecord;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const email = normalizeEmail(input.email);
  const agencyName = normalizeAgencyName(input.agencyName);
  const reason = validateOperatorReason(input.reason);
  const ttlHours = Math.max(1, Math.min(168, Math.trunc(input.expiresInHours ?? 72)));
  const expiresAt = nowMs + ttlHours * 60 * 60 * 1000;

  const invitationId = generateAgencyUlid(nowMs);
  const rawToken = generateSecureToken();
  const tokenHash = await sha256Hex(rawToken);

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(db, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole ?? "platform_operator",
    action: "console.agency.invite",
    targetType: "agency_invitation",
    targetId: invitationId,
    reason,
    requireReason: true,
    outcome: "success",
    requestId: input.requestId ?? null,
    metadata: {
      invitationId,
      agencyName,
      expiresAt,
      initialDiscountPercent: 0,
    },
    createdAtMs: nowMs,
  });

  await db.batch([
    db
      .prepare(
        `INSERT INTO agency_invitations (
           id, kind, agency_id, email, agency_name, role, token_hash,
           status, invited_by_user_id, expires_at, created_at, updated_at
         ) VALUES (?, 'agency_onboarding', NULL, ?, ?, 'agency_owner', ?, 'pending', ?, ?, ?, ?)`,
      )
      .bind(invitationId, email, agencyName, tokenHash, input.actorUserId, expiresAt, nowMs, nowMs),
    auditStmt,
  ]);

  const invitation: AgencyInvitationRecord = {
    id: invitationId,
    kind: "agency_onboarding",
    agencyId: null,
    email,
    agencyName,
    role: "agency_owner",
    status: "pending",
    invitedByUserId: input.actorUserId,
    acceptedByUserId: null,
    acceptedAt: null,
    expiresAt,
    createdAt: nowMs,
    updatedAt: nowMs,
  };

  return {
    invitation,
    rawToken,
    acceptPath: `/agency?invite=${encodeURIComponent(rawToken)}`,
    audit,
  };
}

export async function listPendingAgencyOnboardingInvitations(
  db: D1Database,
  options: { readonly limit?: number } = {},
): Promise<readonly AgencyInvitationRecord[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
  const res = await db
    .prepare(
      `SELECT id, kind, agency_id, email, agency_name, role, status,
              invited_by_user_id, accepted_by_user_id, accepted_at,
              expires_at, created_at, updated_at
       FROM agency_invitations
       WHERE kind = 'agency_onboarding'
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{
      readonly id: string;
      readonly kind: "agency_onboarding" | "agency_member";
      readonly agency_id: string | null;
      readonly email: string;
      readonly agency_name: string | null;
      readonly role: AgencyMemberRole;
      readonly status: "pending" | "accepted" | "revoked" | "expired";
      readonly invited_by_user_id: string;
      readonly accepted_by_user_id: string | null;
      readonly accepted_at: number | null;
      readonly expires_at: number;
      readonly created_at: number;
      readonly updated_at: number;
    }>();

  return (res.results ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    agencyId: r.agency_id,
    email: r.email,
    agencyName: r.agency_name,
    role: r.role,
    status: r.status,
    invitedByUserId: r.invited_by_user_id,
    acceptedByUserId: r.accepted_by_user_id,
    acceptedAt: r.accepted_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export interface AcceptAgencyOnboardingInvitationInput {
  readonly userId: string;
  readonly rawToken: string;
  readonly agencyName?: string | null;
  readonly billingEmail?: string | null;
  readonly billingName?: string | null;
  readonly acceptTerms: boolean;
  readonly termsVersion?: string | null;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

/**
 * Race-free, single-batch atomic acceptance of an operator-issued agency onboarding invitation:
 * 1. Claims `agency_invitations` FIRST (`WHERE id = ? AND status = 'pending' AND expires_at > ?`).
 * 2. Gates ALL downstream inserts (`organizations`, `members`, `agencies`, `agency_members`,
 *    `agency_enrollment_records`, `platform_audit`) on `WHERE EXISTS (SELECT 1 FROM agency_invitations
 *    WHERE id = ? AND status = 'accepted' AND accepted_by_user_id = ? AND accepted_at = ?)` so a
 *    concurrent replay commits ZERO rows and cleanly returns `409 INVALID_INVITATION`.
 * 3. `agencies_owner_user_uidx` UNIQUE constraint atomically aborts the entire batch if the user
 *    already owns an agency (`409 AGENCY_ALREADY_EXISTS`).
 */
export async function acceptAgencyOnboardingInvitation(
  db: D1Database,
  input: AcceptAgencyOnboardingInvitationInput,
): Promise<{ readonly agency: AgencySummary; readonly audit: PlatformAuditRecord }> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const rawToken = input.rawToken.trim();
  if (rawToken.length < 16 || rawToken.length > 128) {
    throw new AgencyError(404, "INVALID_INVITATION", "Token undangan agensi tidak valid.");
  }

  if (input.acceptTerms !== true) {
    throw new AgencyError(
      422,
      "AGENCY_TERMS_REQUIRED",
      "Anda wajib menyetujui syarat dan ketentuan program agensi PunyaSitus.",
    );
  }

  const userRow = await db
    .prepare("SELECT id, name, email, email_verified FROM users WHERE id = ? LIMIT 1")
    .bind(input.userId.trim())
    .first<{
      readonly id: string;
      readonly name: string;
      readonly email: string;
      readonly email_verified: number;
    }>();

  if (!userRow) {
    throw new AgencyError(404, "NOT_FOUND", "Akun pengguna tidak ditemukan.");
  }
  if (userRow.email_verified !== 1) {
    throw new AgencyError(
      403,
      "EMAIL_NOT_VERIFIED",
      "Email akun harus terverifikasi sebelum menerima undangan agensi.",
    );
  }

  const tokenHash = await sha256Hex(rawToken);
  const invite = await db
    .prepare(
      `SELECT id, kind, agency_id, email, agency_name, role, status, expires_at
       FROM agency_invitations
       WHERE token_hash = ? AND kind = 'agency_onboarding'
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<{
      readonly id: string;
      readonly kind: string;
      readonly agency_id: string | null;
      readonly email: string;
      readonly agency_name: string | null;
      readonly role: AgencyMemberRole;
      readonly status: string;
      readonly expires_at: number;
    }>();

  if (!invite) {
    throw new AgencyError(404, "INVALID_INVITATION", "Undangan agensi tidak ditemukan.");
  }
  if (invite.status !== "pending") {
    throw new AgencyError(409, "INVALID_INVITATION", "Undangan agensi ini sudah digunakan atau dicabut.");
  }
  if (invite.expires_at <= nowMs) {
    await db
      .prepare(
        "UPDATE agency_invitations SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .bind(nowMs, invite.id)
      .run();
    throw new AgencyError(410, "INVITATION_EXPIRED", "Undangan agensi telah kedaluwarsa.");
  }
  if (invite.email.toLowerCase() !== userRow.email.toLowerCase()) {
    throw new AgencyError(
      403,
      "INVITATION_EMAIL_MISMATCH",
      "Email akun Anda tidak cocok dengan email penerima undangan agensi ini.",
    );
  }

  const existingAgency = await db
    .prepare("SELECT id FROM agencies WHERE owner_user_id = ? LIMIT 1")
    .bind(userRow.id)
    .first<{ readonly id: string }>();
  if (existingAgency) {
    throw new AgencyError(
      409,
      "AGENCY_ALREADY_EXISTS",
      "Akun ini sudah terdaftar sebagai pemilik agensi.",
    );
  }

  const agencyName = normalizeAgencyName(
    input.agencyName?.trim() || invite.agency_name || userRow.name,
  );
  const billingEmail = input.billingEmail
    ? normalizeEmail(input.billingEmail)
    : userRow.email.toLowerCase();
  const billingName = input.billingName?.trim()
    ? normalizeAgencyName(input.billingName)
    : agencyName;
  const termsVersion = (input.termsVersion?.trim() || DEFAULT_AGENCY_TERMS_VERSION).slice(0, 64);

  const agencyId = generateAgencyUlid(nowMs);
  const orgId = generateAgencyUlid(nowMs);
  const orgMemberId = generateAgencyUlid(nowMs);
  const agencyMemberId = generateAgencyUlid(nowMs);
  const orgSlug = buildOrgSlug("agency", agencyName, nowMs);
  const auditId = generatePlatformAuditId(nowMs);
  const auditMetadataJson = JSON.stringify({
    agencyId,
    invitationId: invite.id,
    enrollmentSource: "operator_invited",
    termsVersion,
    initialDiscountPercent: 0,
  });

  // Condition verifying THIS exact call claimed the pending, unexpired invitation
  const CLAIM_GATE_SQL = `
    EXISTS (
      SELECT 1
      FROM agency_invitations
      WHERE id = ?
        AND status = 'accepted'
        AND accepted_by_user_id = ?
        AND accepted_at = ?
        AND agency_id IS NULL
    )
  `.trim();

  let batchResults: D1Result<unknown>[];
  try {
    batchResults = await db.batch([
      // 1. Atomic claim FIRST
      db
        .prepare(
          `UPDATE agency_invitations
           SET status = 'accepted',
               accepted_by_user_id = ?,
               accepted_at = ?,
               updated_at = ?
           WHERE id = ?
             AND status = 'pending'
             AND expires_at > ?`,
        )
        .bind(userRow.id, nowMs, nowMs, invite.id, nowMs),
      // 2. Gated organizations insert
      db
        .prepare(
          `INSERT INTO organizations (id, name, slug, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?
           WHERE ${CLAIM_GATE_SQL}`,
        )
        .bind(orgId, agencyName, orgSlug, nowMs, nowMs, invite.id, userRow.id, nowMs),
      // 3. Gated members insert
      db
        .prepare(
          `INSERT INTO members (id, organization_id, user_id, role, created_at)
           SELECT ?, ?, ?, 'owner', ?
           WHERE ${CLAIM_GATE_SQL}`,
        )
        .bind(orgMemberId, orgId, userRow.id, nowMs, invite.id, userRow.id, nowMs),
      // 4. Gated agencies insert (protected by UNIQUE agencies_owner_user_uidx!)
      db
        .prepare(
          `INSERT INTO agencies (
             id, organization_id, owner_user_id, name, status,
             discount_percent, unpaid_trial_cap, version, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, 'active', 0, ?, 1, ?, ?
           WHERE ${CLAIM_GATE_SQL}`,
        )
        .bind(
          agencyId,
          orgId,
          userRow.id,
          agencyName,
          DEFAULT_AGENCY_UNPAID_TRIAL_CAP,
          nowMs,
          nowMs,
          invite.id,
          userRow.id,
          nowMs,
        ),
      // 5. Gated agency_members insert
      db
        .prepare(
          `INSERT INTO agency_members (
             id, agency_id, user_id, role, status, invited_by_user_id, created_at, updated_at
           )
           SELECT ?, ?, ?, 'agency_owner', 'active', ?, ?, ?
           WHERE ${CLAIM_GATE_SQL}`,
        )
        .bind(
          agencyMemberId,
          agencyId,
          userRow.id,
          userRow.id,
          nowMs,
          nowMs,
          invite.id,
          userRow.id,
          nowMs,
        ),
      // 6. Gated agency_enrollment_records insert
      db
        .prepare(
          `INSERT INTO agency_enrollment_records (
             agency_id, enrollment_source, terms_version, terms_accepted_at,
             terms_accepted_by_user_id, billing_email, billing_name,
             discount_tier_code, discount_tiers_json, created_at, updated_at
           )
           SELECT ?, 'operator_invited', ?, ?, ?, ?, ?, 'standard_0', '[]', ?, ?
           WHERE ${CLAIM_GATE_SQL}`,
        )
        .bind(
          agencyId,
          termsVersion,
          nowMs,
          userRow.id,
          billingEmail,
          billingName,
          nowMs,
          nowMs,
          invite.id,
          userRow.id,
          nowMs,
        ),
      // 7. Link agency_id onto claimed invitation row
      db
        .prepare(
          `UPDATE agency_invitations
           SET agency_id = ?
           WHERE id = ?
             AND status = 'accepted'
             AND accepted_by_user_id = ?
             AND accepted_at = ?
             AND agency_id IS NULL`,
        )
        .bind(agencyId, invite.id, userRow.id, nowMs),
      // 8. Gated platform_audit insert
      db
        .prepare(
          `INSERT INTO platform_audit (
             id, actor_user_id, actor_role, action, target_type, target_id,
             tenant_id, reason, outcome, request_id, metadata_json, created_at
           )
           SELECT ?, ?, 'agency_owner', 'agency.invite.accept', 'agency', ?,
                  NULL, ?, 'success', ?, ?, ?
           WHERE EXISTS (
             SELECT 1
             FROM agency_invitations
             WHERE id = ?
               AND status = 'accepted'
               AND accepted_by_user_id = ?
               AND accepted_at = ?
               AND agency_id = ?
           )`,
        )
        .bind(
          auditId,
          userRow.id,
          agencyId,
          `Accepted operator agency invitation "${invite.id}"`,
          input.requestId ?? null,
          auditMetadataJson,
          nowMs,
          invite.id,
          userRow.id,
          nowMs,
          agencyId,
        ),
    ]);
  } catch (err) {
    if (isOwnerUniqueViolation(err)) {
      throw new AgencyError(
        409,
        "AGENCY_ALREADY_EXISTS",
        "Akun ini sudah terdaftar sebagai pemilik agensi.",
        err,
      );
    }
    throw err;
  }

  if ((batchResults[0]?.meta?.changes ?? 0) !== 1) {
    throw new AgencyError(
      409,
      "INVALID_INVITATION",
      "Undangan agensi sudah digunakan atau telah kedaluwarsa.",
    );
  }

  const agency = await getAgencyById(db, agencyId);
  if (!agency) {
    throw new AgencyError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal memuat agensi setelah menerima undangan.",
    );
  }

  const audit: PlatformAuditRecord = {
    id: auditId,
    actorUserId: userRow.id,
    actorRole: "agency_owner",
    action: "agency.invite.accept",
    targetType: "agency",
    targetId: agencyId,
    tenantId: null,
    reason: `Accepted operator agency invitation "${invite.id}"`,
    outcome: "success",
    requestId: input.requestId ?? null,
    metadataJson: auditMetadataJson,
    createdAt: nowMs,
  };

  return { agency, audit };
}

export async function addAgencyMember(
  db: D1Database,
  params: {
    readonly agencyId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
    readonly role: Exclude<AgencyMemberRole, "agency_owner">;
    readonly requestId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{ readonly member: AgencyMemberRecord; readonly audit: PlatformAuditRecord }> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const agency = await getAgencyById(db, params.agencyId);
  if (!agency) {
    throw new AgencyError(404, "NOT_FOUND", "Agensi tidak ditemukan.");
  }

  const memberId = generateAgencyUlid(nowMs);
  const orgMemberId = generateAgencyUlid(nowMs);

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(db, {
    actorUserId: params.actorUserId,
    actorRole: "agency_admin",
    action: "agency.member.add",
    targetType: "agency_member",
    targetId: params.targetUserId,
    reason: `Added ${params.role} to agency ${agency.id}`,
    requireReason: false,
    outcome: "success",
    requestId: params.requestId ?? null,
    metadata: {
      agencyId: agency.id,
      targetUserId: params.targetUserId,
      role: params.role,
    },
    createdAtMs: nowMs,
  });

  await db.batch([
    db
      .prepare(
        `INSERT INTO agency_members (
           id, agency_id, user_id, role, status, invited_by_user_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT(agency_id, user_id) DO UPDATE SET
           role = excluded.role,
           status = 'active',
           revoked_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(memberId, agency.id, params.targetUserId, params.role, params.actorUserId, nowMs, nowMs),
    db
      .prepare(
        `INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'agency_staff', ?)`,
      )
      .bind(orgMemberId, agency.organizationId, params.targetUserId, nowMs),
    auditStmt,
  ]);

  const user = await db
    .prepare("SELECT email, name FROM users WHERE id = ? LIMIT 1")
    .bind(params.targetUserId)
    .first<{ readonly email: string; readonly name: string }>();

  return {
    member: {
      id: memberId,
      agencyId: agency.id,
      userId: params.targetUserId,
      email: user?.email ?? null,
      name: user?.name ?? null,
      role: params.role,
      status: "active",
      invitedByUserId: params.actorUserId,
      createdAt: nowMs,
      updatedAt: nowMs,
      revokedAt: null,
    },
    audit,
  };
}

/**
 * Atomically revokes an agency member across the ENTIRE agency boundary in ONE `D1Database.batch`:
 * 1. Marks `agency_members.status = 'revoked'` + sets `revoked_at`.
 * 2. Deletes the user's `members` row on the agency's own organization.
 * 3. Deletes ALL `members` rows (`role = 'agency_staff'`) for that user across EVERY client
 *    organization owned by this agency (`tenants.agency_id = agencyId`).
 * 4. Appends a `platform_audit` entry (`agency.member.revoke`).
 */
export async function revokeAgencyMember(
  db: D1Database,
  params: {
    readonly agencyId: string;
    readonly targetUserId: string;
    readonly actorUserId: string;
    readonly reason?: string | null;
    readonly requestId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{ readonly revoked: boolean; readonly audit: PlatformAuditRecord }> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const agency = await getAgencyById(db, params.agencyId);
  if (!agency) {
    throw new AgencyError(404, "NOT_FOUND", "Agensi tidak ditemukan.");
  }

  const targetUserId = params.targetUserId.trim();
  if (targetUserId === agency.ownerUserId) {
    throw new AgencyError(
      409,
      "FORBIDDEN",
      "Pemilik utama agensi tidak dapat dicabut tanpa pengalihan kepemilikan.",
    );
  }

  const existing = await db
    .prepare(
      `SELECT id, role, status
       FROM agency_members
       WHERE agency_id = ? AND user_id = ?
       LIMIT 1`,
    )
    .bind(agency.id, targetUserId)
    .first<{ readonly id: string; readonly role: AgencyMemberRole; readonly status: string }>();

  if (!existing || existing.status !== "active") {
    throw new AgencyError(404, "NOT_FOUND", "Anggota agensi aktif tidak ditemukan.");
  }

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(db, {
    actorUserId: params.actorUserId,
    actorRole: "agency_admin",
    action: "agency.member.revoke",
    targetType: "agency_member",
    targetId: targetUserId,
    reason: params.reason?.trim() || `Revoked agency member (${existing.role}) from agency ${agency.id}`,
    requireReason: false,
    outcome: "success",
    requestId: params.requestId ?? null,
    metadata: {
      agencyId: agency.id,
      targetUserId,
      previousRole: existing.role,
      clientMembershipsCleared: true,
    },
    createdAtMs: nowMs,
  });

  await db.batch([
    db
      .prepare(
        `UPDATE agency_members
         SET status = 'revoked',
             revoked_at = ?,
             updated_at = ?
         WHERE agency_id = ? AND user_id = ? AND status = 'active'`,
      )
      .bind(nowMs, nowMs, agency.id, targetUserId),
    db
      .prepare("DELETE FROM members WHERE organization_id = ? AND user_id = ?")
      .bind(agency.organizationId, targetUserId),
    db
      .prepare(
        `DELETE FROM members
         WHERE user_id = ?
           AND role = 'agency_staff'
           AND organization_id IN (
             SELECT organization_id FROM tenants WHERE agency_id = ?
           )`,
      )
      .bind(targetUserId, agency.id),
    auditStmt,
  ]);

  return { revoked: true, audit };
}

export interface UpdateAgencyConfigurationInput {
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorRole?: string;
  readonly expectedVersion: number;
  readonly discountPercent?: number;
  readonly discountTiers?: readonly AgencyDiscountTier[];
  readonly unpaidTrialCap?: number;
  readonly status?: AgencyStatus;
  readonly reason: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

/**
 * Single-batch atomic optimistic CAS configuration update for `/api/console/agencies/[agencyId]`.
 * Guarantees `agencies`, `agency_enrollment_records`, and `platform_audit` commit together in ONE
 * atomic `D1Database.batch([...])` — configuration can NEVER mutate without its audit row, and a
 * stale `expectedVersion` writes ZERO rows to any table.
 */
export async function updateAgencyConfigurationFromConsole(
  db: D1Database,
  input: UpdateAgencyConfigurationInput,
): Promise<{ readonly agency: AgencySummary; readonly audit: PlatformAuditRecord }> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const reason = validateOperatorReason(input.reason);

  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new AgencyError(
      422,
      "VALIDATION_ERROR",
      "expectedVersion wajib berupa bilangan bulat positif.",
    );
  }

  const current = await getAgencyById(db, input.agencyId);
  if (!current) {
    throw new AgencyError(404, "NOT_FOUND", "Agensi tidak ditemukan.");
  }

  const nextDiscountPercent =
    input.discountPercent !== undefined
      ? validateAgencyDiscountPercent(input.discountPercent)
      : current.baseDiscountPercent;

  const nextDiscountTiers =
    input.discountTiers !== undefined
      ? validateAgencyDiscountTiers(input.discountTiers)
      : current.discountTiers;

  let nextUnpaidTrialCap = current.unpaidTrialCap;
  if (input.unpaidTrialCap !== undefined) {
    if (
      typeof input.unpaidTrialCap !== "number" ||
      !Number.isInteger(input.unpaidTrialCap) ||
      input.unpaidTrialCap < 0 ||
      input.unpaidTrialCap > 50
    ) {
      throw new AgencyError(
        422,
        "VALIDATION_ERROR",
        "Batas uji coba belum berbayar harus berupa bilangan bulat 0–50.",
      );
    }
    nextUnpaidTrialCap = input.unpaidTrialCap;
  }

  let nextStatus: AgencyStatus = current.status;
  if (input.status !== undefined) {
    if (input.status !== "pending" && input.status !== "active" && input.status !== "suspended") {
      throw new AgencyError(422, "VALIDATION_ERROR", "Status agensi tidak valid.");
    }
    nextStatus = input.status;
  }

  const effective = computeEffectiveAgencyDiscountPercent({
    baseDiscountPercent: nextDiscountPercent,
    discountTiers: nextDiscountTiers,
    paidClientCount: current.trialQuota.paidClientCount,
  });

  const tiersJson = JSON.stringify(nextDiscountTiers);
  const nextVersion = input.expectedVersion + 1;
  const auditId = generatePlatformAuditId(nowMs);
  const actorRole = input.actorRole ?? "platform_operator";
  const auditMetadata = {
    agencyId: current.id,
    previousDiscountPercent: current.baseDiscountPercent,
    nextDiscountPercent,
    nextDiscountTiers,
    previousUnpaidTrialCap: current.unpaidTrialCap,
    nextUnpaidTrialCap,
    previousStatus: current.status,
    nextStatus,
  };

  // Single atomic D1 batch: CAS update + version-gated enrollment upsert + version-gated audit insert
  const batchResults = await db.batch([
    db
      .prepare(
        `UPDATE agencies
         SET discount_percent = ?,
             unpaid_trial_cap = ?,
             status = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(
        nextDiscountPercent,
        nextUnpaidTrialCap,
        nextStatus,
        nowMs,
        current.id,
        input.expectedVersion,
      ),
    db
      .prepare(
        `INSERT INTO agency_enrollment_records (
           agency_id, enrollment_source, terms_version, terms_accepted_at,
           terms_accepted_by_user_id, billing_email, billing_name,
           discount_tier_code, discount_tiers_json, created_at, updated_at
         )
         SELECT ?, 'operator_invited', ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM agencies WHERE id = ? AND version = ? AND updated_at = ?
         )
         ON CONFLICT(agency_id) DO UPDATE SET
           discount_tier_code = excluded.discount_tier_code,
           discount_tiers_json = excluded.discount_tiers_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        current.id,
        current.termsVersion ?? DEFAULT_AGENCY_TERMS_VERSION,
        current.termsAcceptedAt ?? nowMs,
        current.ownerUserId,
        current.billingEmail || current.ownerEmail || "agency@punyasitus.com",
        current.billingName || current.name,
        effective.tierCode,
        tiersJson,
        nowMs,
        nowMs,
        current.id,
        nextVersion,
        nowMs,
      ),
    db
      .prepare(
        `INSERT INTO platform_audit (
           id, actor_user_id, actor_role, action, target_type, target_id,
           tenant_id, reason, outcome, request_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, 'console.agency.update', 'agency', ?,
                NULL, ?, 'success', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM agencies WHERE id = ? AND version = ? AND updated_at = ?
         )`,
      )
      .bind(
        auditId,
        input.actorUserId,
        actorRole,
        current.id,
        reason,
        input.requestId ?? null,
        JSON.stringify(auditMetadata),
        nowMs,
        current.id,
        nextVersion,
        nowMs,
      ),
  ]);

  if ((batchResults[0]?.meta?.changes ?? 0) !== 1) {
    throw new AgencyError(
      409,
      "STALE_VERSION",
      "Konfigurasi agensi telah berubah oleh operator lain. Muat ulang dan coba lagi.",
    );
  }

  const updated = await getAgencyById(db, current.id);
  if (!updated) {
    throw new AgencyError(404, "NOT_FOUND", "Agensi tidak ditemukan setelah pembaruan.");
  }

  const audit: PlatformAuditRecord = {
    id: auditId,
    actorUserId: input.actorUserId,
    actorRole,
    action: "console.agency.update",
    targetType: "agency",
    targetId: current.id,
    tenantId: null,
    reason,
    outcome: "success",
    requestId: input.requestId ?? null,
    metadataJson: JSON.stringify(auditMetadata),
    createdAt: nowMs,
  };

  return { agency: updated, audit };
}

export interface ProvisionAgencyClientInput {
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorAgencyRole?: AgencyMemberRole;
  readonly handle: string;
  readonly name: string;
  readonly vertical?: TenantVertical;
  readonly clientOwnerEmail?: string | null;
  readonly idempotencyKey: string;
  readonly saasZone?: string;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export async function provisionAgencyClientTenant(
  db: D1Database,
  input: ProvisionAgencyClientInput,
): Promise<{
  readonly client: AgencyClientSummary;
  readonly replayed: boolean;
  readonly clientOwnerInvitationId: string | null;
  readonly trialQuota: AgencySummary["trialQuota"];
  readonly auditId: string;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const agencyId = input.agencyId.trim();
  const actorUserId = input.actorUserId.trim();
  const idempotencyKey = input.idempotencyKey.trim();

  if (!SAFE_IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new AgencyError(
      422,
      "VALIDATION_ERROR",
      "Idempotency-Key tidak valid (8–128 karakter alfanumerik/.-_:).",
    );
  }

  const agency = await getAgencyById(db, agencyId);
  if (!agency) {
    throw new AgencyError(404, "NOT_FOUND", "Agensi tidak ditemukan.");
  }
  if (agency.status !== "active") {
    throw new AgencyError(
      403,
      "AGENCY_SUSPENDED",
      "Agensi sedang tidak aktif dan tidak dapat membuat situs klien baru.",
    );
  }

  const handleCheck = validateOnboardingHandleFormat(input.handle);
  if (!handleCheck.ok) {
    throw new AgencyError(422, handleCheck.code, handleCheck.message);
  }
  const normalizedHandle = handleCheck.normalizedHandle;
  if (PROVISIONING_RESERVED_HANDLES.has(normalizedHandle)) {
    throw new AgencyError(
      422,
      "RESERVED_HANDLE",
      `Handle "${normalizedHandle}" dicadangkan oleh sistem.`,
    );
  }

  const clientName = normalizeClientName(input.name);
  const vertical = normalizeVertical(input.vertical);
  const saasZone = (input.saasZone?.trim() || DEFAULT_SAAS_ZONE).toLowerCase();
  const primaryHost = `${normalizedHandle}.${saasZone}`;

  // Validate optional clientOwnerEmail format; NEVER silently attach an arbitrary existing user
  // into `members` without invitation acceptance! Create a pending `invitations` row instead.
  const normalizedClientOwnerEmail =
    input.clientOwnerEmail && input.clientOwnerEmail.trim().length > 0
      ? normalizeEmail(input.clientOwnerEmail)
      : null;

  // 1. Idempotent replay check
  const existingLink = await db
    .prepare(
      `SELECT acl.tenant_id, t.handle, t.name, t.vertical
       FROM agency_client_links acl
       INNER JOIN tenants t ON t.id = acl.tenant_id
       WHERE acl.agency_id = ? AND acl.idempotency_key = ?
       LIMIT 1`,
    )
    .bind(agencyId, idempotencyKey)
    .first<{
      readonly tenant_id: string;
      readonly handle: string;
      readonly name: string;
      readonly vertical: string;
    }>();

  if (existingLink) {
    if (
      existingLink.handle !== normalizedHandle ||
      existingLink.name !== clientName ||
      existingLink.vertical !== vertical
    ) {
      throw new AgencyError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key sudah digunakan untuk parameter klien yang berbeda.",
      );
    }
    const existingClient = await getAgencyClientBySelector(db, agencyId, existingLink.tenant_id, nowMs);
    const refreshedAgency = await getAgencyById(db, agencyId);
    if (!existingClient || !refreshedAgency) {
      throw new AgencyError(404, "NOT_FOUND", "Situs klien tidak ditemukan.");
    }
    return {
      client: existingClient,
      replayed: true,
      clientOwnerInvitationId: null,
      trialQuota: refreshedAgency.trialQuota,
      auditId: `replay_${existingClient.tenantId}`,
    };
  }

  // 2. Fast pre-check for unpaid trial cap (SQLite BEFORE INSERT trigger ALSO enforces atomically!)
  if (!agency.trialQuota.canCreateTrial) {
    throw new AgencyError(
      409,
      "AGENCY_TRIAL_LIMIT_REACHED",
      `Batas maksimal ${agency.trialQuota.unpaidTrialCap} situs uji coba belum berbayar tercapai. Aktifkan langganan berbayar pada minimal 1 situs klien terlebih dahulu untuk membuka kuota klien baru.`,
    );
  }

  // 3. Handle uniqueness & quarantine check
  const [existingTenant, existingHost, tombstone] = await Promise.all([
    db
      .prepare("SELECT id FROM tenants WHERE handle = ? LIMIT 1")
      .bind(normalizedHandle)
      .first<{ readonly id: string }>(),
    db
      .prepare("SELECT host FROM tenant_hosts WHERE host = ? LIMIT 1")
      .bind(primaryHost)
      .first<{ readonly host: string }>(),
    db
      .prepare(
        "SELECT id FROM deletion_tombstones WHERE handle = ? AND quarantine_until > ? LIMIT 1",
      )
      .bind(normalizedHandle, nowMs)
      .first<{ readonly id: string }>(),
  ]);

  if (existingTenant || existingHost || tombstone) {
    throw new AgencyError(
      409,
      "HANDLE_TAKEN",
      `Subdomain "${normalizedHandle}.${saasZone}" sudah digunakan atau sedang dikarantina.`,
    );
  }

  const trialWindow = computeServerTrialWindow(nowMs);
  const tenantId = generateAgencyUlid(nowMs);
  const clientOrgId = generateAgencyUlid(nowMs);
  const clientOrgSlug = buildOrgSlug("client", normalizedHandle, nowMs);
  const actorMemberId = generateAgencyUlid(nowMs);
  const ownerAgencyMemberId = generateAgencyUlid(nowMs);
  const clientInvitationId = normalizedClientOwnerEmail ? generateAgencyUlid(nowMs) : null;
  const auditId = generatePlatformAuditId(nowMs);

  const { statement: auditStmt } = buildPlatformAuditStatement(db, {
    id: auditId,
    actorUserId,
    actorRole: input.actorAgencyRole ?? "agency_admin",
    action: "agency.client.provision",
    targetType: "tenant",
    targetId: tenantId,
    tenantId,
    reason: `Agency "${agency.name}" provisioned linked client "${normalizedHandle}" (billing_payer=agency)`,
    requireReason: false,
    outcome: "success",
    requestId: input.requestId ?? null,
    metadata: {
      agencyId: agency.id,
      agencyName: agency.name,
      handle: normalizedHandle,
      vertical,
      billingPayer: "agency",
      trialEndsAtMs: trialWindow.trialEndsAtMs,
      clientOwnerInvitationId: clientInvitationId,
    },
    createdAtMs: nowMs,
  });

  const batchStmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(clientOrgId, clientName, clientOrgSlug, nowMs, nowMs),
    db
      .prepare(
        `INSERT INTO tenants (
           id, organization_id, agency_id, handle, name, vertical, status,
           operator_hold, trial_ends_at, paid_through, cache_version, schema_version,
           version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'trial', 0, ?, NULL, 1, 0, 1, ?, ?)`,
      )
      .bind(
        tenantId,
        clientOrgId,
        agency.id,
        normalizedHandle,
        clientName,
        vertical,
        trialWindow.trialEndsAtMs,
        nowMs,
        nowMs,
      ),
    db
      .prepare(
        `INSERT INTO tenant_hosts (
           host, tenant_id, kind, status, ssl_status, is_primary,
           verified_at, version, created_at, updated_at
         ) VALUES (?, ?, 'subdomain', 'active', 'active', 1, ?, 1, ?, ?)`,
      )
      .bind(primaryHost, tenantId, nowMs, nowMs, nowMs),
    db
      .prepare(
        `INSERT INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'agency_staff', ?)`,
      )
      .bind(actorMemberId, clientOrgId, actorUserId, nowMs),
  ];

  if (agency.ownerUserId !== actorUserId) {
    batchStmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at)
           VALUES (?, ?, ?, 'agency_staff', ?)`,
        )
        .bind(ownerAgencyMemberId, clientOrgId, agency.ownerUserId, nowMs),
    );
  }

  // Record a pending invitation rather than silently attaching any unconsented existing user
  if (normalizedClientOwnerEmail && clientInvitationId) {
    batchStmts.push(
      db
        .prepare(
          `INSERT INTO invitations (id, organization_id, email, role, status, expires_at, inviter_id, created_at)
           VALUES (?, ?, ?, 'owner', 'pending', ?, ?, ?)`,
        )
        .bind(
          clientInvitationId,
          clientOrgId,
          normalizedClientOwnerEmail,
          nowMs + DEFAULT_INITIAL_OWNER_INVITE_TTL_MS,
          actorUserId,
          nowMs,
        ),
    );
  }

  // Atomic trial-cap trigger fires HERE inside the same D1 batch!
  batchStmts.push(
    db
      .prepare(
        `INSERT INTO agency_client_links (
           tenant_id, agency_id, billing_payer, provisioned_by_user_id,
           is_unpaid_trial, first_settled_at, idempotency_key, created_at, updated_at
         ) VALUES (?, ?, 'agency', ?, 1, NULL, ?, ?, ?)`,
      )
      .bind(tenantId, agency.id, actorUserId, idempotencyKey, nowMs, nowMs),
    auditStmt,
  );

  try {
    await db.batch(batchStmts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("AGENCY_TRIAL_LIMIT_REACHED")) {
      throw new AgencyError(
        409,
        "AGENCY_TRIAL_LIMIT_REACHED",
        `Batas maksimal ${agency.unpaidTrialCap} situs uji coba belum berbayar tercapai. Selesaikan pembayaran minimal 1 situs klien terlebih dahulu.`,
        err,
      );
    }
    if (msg.includes("UNIQUE") && (msg.includes("tenants.handle") || msg.includes("tenant_hosts.host"))) {
      throw new AgencyError(
        409,
        "HANDLE_TAKEN",
        `Subdomain "${normalizedHandle}.${saasZone}" sudah digunakan.`,
        err,
      );
    }
    throw err;
  }

  if (input.tenantStore) {
    try {
      await initializeTenantStoreDefaults(db, input.tenantStore, {
        tenantId,
        name: clientName,
        vertical,
        initialStatus: "trial",
        nowMs,
      });
    } catch {
      // Non-fatal in preview environments; TenantStore initializes lazily on first access.
    }
  }

  const [client, refreshedAgency] = await Promise.all([
    getAgencyClientBySelector(db, agency.id, tenantId, nowMs),
    getAgencyById(db, agency.id),
  ]);

  if (!client || !refreshedAgency) {
    throw new AgencyError(500, "AUDIT_PERSISTENCE_FAILED", "Gagal memuat situs klien yang baru dibuat.");
  }

  return {
    client,
    replayed: false,
    clientOwnerInvitationId: clientInvitationId,
    trialQuota: refreshedAgency.trialQuota,
    auditId,
  };
}

interface RawAgencyClientRow {
  readonly id: string;
  readonly organization_id: string;
  readonly agency_id: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: TenantVertical;
  readonly status: TenantStatus;
  readonly operator_hold: number;
  readonly trial_ends_at: number | null;
  readonly paid_through: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly primary_host: string | null;
  readonly is_unpaid_trial: number | null;
  readonly first_settled_at: number | null;
  readonly settled_count: number;
  readonly open_obligation_id: string | null;
  readonly open_obligation_net_idr: number | null;
}

const AGENCY_CLIENT_SELECT_SQL = `
  SELECT
    t.id,
    t.organization_id,
    t.agency_id,
    t.handle,
    t.name,
    t.vertical,
    t.status,
    t.operator_hold,
    t.trial_ends_at,
    t.paid_through,
    t.created_at,
    t.updated_at,
    (
      SELECT th.host
      FROM tenant_hosts th
      WHERE th.tenant_id = t.id AND th.is_primary = 1
      LIMIT 1
    ) AS primary_host,
    acl.is_unpaid_trial,
    acl.first_settled_at,
    (
      SELECT COUNT(*)
      FROM settlements s
      WHERE s.tenant_id = t.id
    ) AS settled_count,
    (
      SELECT bo.id
      FROM billing_obligations bo
      WHERE bo.tenant_id = t.id AND bo.status = 'open'
      ORDER BY bo.created_at DESC
      LIMIT 1
    ) AS open_obligation_id,
    (
      SELECT bo.net_amount_idr
      FROM billing_obligations bo
      WHERE bo.tenant_id = t.id AND bo.status = 'open'
      ORDER BY bo.created_at DESC
      LIMIT 1
    ) AS open_obligation_net_idr
  FROM tenants t
  LEFT JOIN agency_client_links acl ON acl.tenant_id = t.id
`.trim();

function mapAgencyClientRow(
  row: RawAgencyClientRow,
  nowMs: number,
  saasZone: string = DEFAULT_SAAS_ZONE,
): AgencyClientSummary {
  const effectiveStatus = computeEffectiveTenantStatus(
    {
      storedStatus: row.status,
      operatorHold: row.operator_hold === 1,
      trialEndsAt: row.trial_ends_at,
      paidThrough: row.paid_through,
    },
    nowMs,
  );
  const hasSettledPayment = row.first_settled_at !== null || Number(row.settled_count ?? 0) > 0;
  const isUnpaidTrial =
    !hasSettledPayment &&
    (row.is_unpaid_trial === null ? effectiveStatus === "trial" : row.is_unpaid_trial === 1);

  return {
    tenantId: row.id,
    organizationId: row.organization_id,
    agencyId: row.agency_id,
    handle: row.handle,
    name: row.name,
    vertical: row.vertical,
    status: row.status,
    effectiveStatus,
    primaryHost: row.primary_host ?? `${row.handle}.${saasZone}`,
    billingPayer: "agency",
    isUnpaidTrial,
    hasSettledPayment,
    trialEndsAt: row.trial_ends_at,
    paidThrough: row.paid_through,
    openObligationId: row.open_obligation_id,
    openObligationNetIdr: row.open_obligation_net_idr,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAgencyClients(
  db: D1Database,
  agencyId: string,
  options: { readonly limit?: number; readonly nowMs?: number; readonly saasZone?: string } = {},
): Promise<readonly AgencyClientSummary[]> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));

  const res = await db
    .prepare(
      `${AGENCY_CLIENT_SELECT_SQL}
       WHERE t.agency_id = ?
         AND t.status != 'purged'
       ORDER BY t.created_at DESC
       LIMIT ?`,
    )
    .bind(agencyId.trim(), limit)
    .all<RawAgencyClientRow>();

  return (res.results ?? []).map((r) => mapAgencyClientRow(r, nowMs, options.saasZone));
}

export async function getAgencyClientBySelector(
  db: D1Database,
  agencyId: string,
  tenantIdOrHandle: string,
  nowMs = Date.now(),
  saasZone: string = DEFAULT_SAAS_ZONE,
): Promise<AgencyClientSummary | null> {
  const selector = tenantIdOrHandle.trim();
  if (!selector || !agencyId.trim()) return null;

  const row = await db
    .prepare(
      `${AGENCY_CLIENT_SELECT_SQL}
       WHERE t.agency_id = ?
         AND t.status != 'purged'
         AND (t.id = ? OR t.handle = ?)
       LIMIT 1`,
    )
    .bind(agencyId.trim(), selector, selector.toLowerCase())
    .first<RawAgencyClientRow>();

  return row ? mapAgencyClientRow(row, Math.trunc(nowMs), saasZone) : null;
}

export async function switchAgencyIntoClientContext(
  db: D1Database,
  params: {
    readonly agencyId: string;
    readonly actorUserId: string;
    readonly actorAgencyRole?: AgencyMemberRole;
    readonly sessionId?: string | null;
    readonly tenantIdOrHandle: string;
    readonly requestId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{
  readonly client: AgencyClientSummary;
  readonly agencyClientContext: AgencyClientContextBannerPayload;
  readonly audit: PlatformAuditRecord;
}> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const agency = await getAgencyById(db, params.agencyId);
  if (!agency) {
    throw new AgencyError(404, "NOT_FOUND", "Agensi tidak ditemukan.");
  }
  if (agency.status !== "active") {
    throw new AgencyError(403, "AGENCY_SUSPENDED", "Agensi sedang ditangguhkan.");
  }

  const client = await getAgencyClientBySelector(db, agency.id, params.tenantIdOrHandle, nowMs);
  if (!client) {
    throw new AgencyError(404, "NOT_FOUND", "Situs klien tidak ditemukan.");
  }

  const memberId = generateAgencyUlid(nowMs);
  const dashboardUrl = `/dashboard/${encodeURIComponent(client.handle)}`;

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(db, {
    actorUserId: params.actorUserId,
    actorRole: params.actorAgencyRole ?? "agency_admin",
    action: "agency.client.switch",
    targetType: "tenant",
    targetId: client.tenantId,
    tenantId: client.tenantId,
    reason: `Agency user switched into linked client "${client.handle}" via agency "${agency.name}"`,
    requireReason: false,
    outcome: "success",
    requestId: params.requestId ?? null,
    metadata: {
      agencyId: agency.id,
      agencyName: agency.name,
      agencyActorUserId: params.actorUserId,
      agencyActorRole: params.actorAgencyRole ?? "agency_admin",
      clientTenantId: client.tenantId,
      clientHandle: client.handle,
      clientName: client.name,
      dashboardUrl,
    },
    createdAtMs: nowMs,
  });

  const batchStmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'agency_staff', ?)`,
      )
      .bind(memberId, client.organizationId, params.actorUserId, nowMs),
    auditStmt,
  ];

  if (params.sessionId && params.sessionId.trim().length > 0) {
    batchStmts.push(
      db
        .prepare(
          "UPDATE sessions SET active_organization_id = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        )
        .bind(client.organizationId, nowMs, params.sessionId.trim(), params.actorUserId),
    );
  }

  await db.batch(batchStmts);

  return {
    client,
    agencyClientContext: {
      agencyId: agency.id,
      agencyName: agency.name,
      clientTenantId: client.tenantId,
      clientName: client.name,
      clientHandle: client.handle,
      returnHref: "/agency/clients",
      dashboardUrl,
    },
    audit,
  };
}

export async function markAgencyClientFirstSettled(
  db: D1Database,
  params: {
    readonly agencyId: string;
    readonly tenantId: string;
    readonly settledAtMs: number;
    readonly nowMs?: number;
  },
): Promise<void> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const settledAt = Math.trunc(params.settledAtMs);

  await db.batch([
    db
      .prepare(
        `UPDATE agency_client_links
         SET is_unpaid_trial = 0,
             first_settled_at = COALESCE(first_settled_at, ?),
             updated_at = ?
         WHERE tenant_id = ? AND agency_id = ?`,
      )
      .bind(settledAt, nowMs, params.tenantId, params.agencyId),
    db
      .prepare(
        `UPDATE agency_enrollment_records
         SET first_paid_at = COALESCE(first_paid_at, ?),
             first_paid_tenant_id = COALESCE(first_paid_tenant_id, ?),
             updated_at = ?
         WHERE agency_id = ?`,
      )
      .bind(settledAt, params.tenantId, nowMs, params.agencyId),
  ]);
}

export interface BeginAgencyClientBillingCheckoutInput {
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorAgencyRole?: AgencyMemberRole;
  readonly tenantIdOrHandle: string;
  readonly plan: BillingPlanInterval;
  readonly channelKind: "QRIS" | "VA";
  readonly channelCode: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly estimatedChannelFeeIdr: number;
  readonly providerAccountId?: string;
  readonly nowMs: number;
}

export async function beginAgencyClientBillingCheckout(
  db: D1Database,
  input: BeginAgencyClientBillingCheckoutInput,
): Promise<{
  readonly result: BeginDurableAttemptResult;
  readonly client: AgencyClientSummary;
  readonly amounts: AgencyCheckoutAmounts;
  readonly agency: AgencySummary;
}> {
  const agency = await getAgencyById(db, input.agencyId);
  if (!agency) {
    throw new AgencyError(404, "NOT_FOUND", "Agensi tidak ditemukan.");
  }
  if (agency.status !== "active") {
    throw new AgencyError(403, "AGENCY_SUSPENDED", "Agensi sedang tidak aktif.");
  }

  const client = await getAgencyClientBySelector(db, agency.id, input.tenantIdOrHandle, input.nowMs);
  if (!client) {
    throw new AgencyError(404, "NOT_FOUND", "Situs klien tidak ditemukan.");
  }

  const [tenantCtx, pricing] = await Promise.all([
    loadTenantBillingContext(db, client.tenantId),
    loadPlatformBillingPricing(db),
  ]);
  if (!tenantCtx) {
    throw new AgencyError(404, "NOT_FOUND", "Situs klien tidak ditemukan.");
  }
  if (tenantCtx.status === "purged" || tenantCtx.offboardingStartedAtMs !== null) {
    throw new BillingConflictError(
      "CONFLICT",
      "TENANT_OFFBOARDING_IN_PROGRESS",
      "Situs klien sedang atau telah melalui proses penghapusan.",
    );
  }

  const existingAttempt = await db
    .prepare(
      `SELECT id, obligation_id, request_hash, lifecycle_state
       FROM payment_attempts
       WHERE tenant_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(client.tenantId, input.idempotencyKey)
    .first<{
      readonly id: string;
      readonly obligation_id: string;
      readonly request_hash: string | null;
      readonly lifecycle_state: string;
    }>();

  const baseAmountIdr =
    input.plan === "yearly" ? pricing.yearlyPriceIdr : pricing.monthlyPriceIdr;
  const amounts = computeAgencyClientCheckoutAmounts({
    baseAmountIdr,
    agencyDiscountPercent: agency.effectiveDiscountPercent,
  });

  if (existingAttempt) {
    if (existingAttempt.request_hash && existingAttempt.request_hash !== input.requestHash) {
      throw new BillingConflictError(
        "CONFLICT",
        "IDEMPOTENCY_KEY_REUSE_MISMATCH",
        "Idempotency-Key yang sama tidak dapat digunakan dengan parameter berbeda.",
      );
    }
    const [obl, foundAttempt] = await Promise.all([
      getTenantObligationById(db, client.tenantId, existingAttempt.obligation_id),
      getTenantPaymentAttemptById(db, client.tenantId, existingAttempt.id),
    ]);
    if (!obl) {
      throw new BillingConflictError(
        "CONFLICT",
        "ORPHANED_PAYMENT_ATTEMPT",
        "Tagihan terkait Idempotency-Key tidak ditemukan.",
      );
    }
    if (!foundAttempt) {
      throw new BillingConflictError(
        "CONFLICT",
        "ORPHANED_PAYMENT_ATTEMPT",
        "Percobaan pembayaran tidak ditemukan.",
      );
    }
    if (foundAttempt.state === "creating") {
      throw new BillingConflictError(
        "CONFLICT",
        "PAYMENT_CREATION_IN_PROGRESS",
        "Permintaan pembayaran sedang diproses.",
      );
    }
    if (foundAttempt.state === "creation_unknown" || foundAttempt.state === "review") {
      throw new BillingConflictError(
        "CONFLICT",
        "RECONCILIATION_REQUIRED",
        "Transaksi menunggu rekonsiliasi server.",
      );
    }
    return {
      result: { mode: "replay", obligation: obl.obligation, attempt: foundAttempt },
      client,
      amounts,
      agency,
    };
  }

  await expireStaleOpenObligationsForTenant(db, client.tenantId, input.nowMs);
  let obligation = await findOpenSubscriptionObligation(db, client.tenantId);

  const estimatedFeeIdr = assertExactIdrInteger(
    input.estimatedChannelFeeIdr,
    "estimatedChannelFeeIdr",
    { min: 0 },
  );

  if (obligation) {
    const oblDetails = await getTenantObligationById(db, client.tenantId, obligation.id);
    const latest = oblDetails?.latestAttempt ?? null;
    const unresolved =
      latest &&
      (latest.state === "creating" ||
        latest.state === "creation_unknown" ||
        latest.state === "pending" ||
        latest.state === "review")
        ? latest
        : null;
    if (unresolved) {
      throw new BillingConflictError(
        "CONFLICT",
        unresolved.state === "creation_unknown" || unresolved.state === "review"
          ? "RECONCILIATION_REQUIRED"
          : "ACTIVE_ATTEMPT_EXISTS",
        "Tagihan klien ini sudah memiliki instruksi pembayaran aktif yang menunggu penyelesaian.",
      );
    }
    if (obligation.plan !== input.plan) {
      throw new BillingConflictError(
        "CONFLICT",
        "OPEN_OBLIGATION_PLAN_MISMATCH",
        `Tagihan terbuka saat ini memakai paket "${obligation.plan}".`,
      );
    }
  } else {
    const period = computeSubscriptionPeriodPreview({
      plan: input.plan,
      tenantStatus: client.effectiveStatus,
      paidThroughMs: tenantCtx.paidThroughMs,
      trialEndsAtMs: tenantCtx.trialEndsAtMs,
      nowMs: input.nowMs,
    });

    const baseSnapshot = buildImmutableObligationSnapshot({
      plan: input.plan,
      baseAmountIdr: amounts.baseAmountIdr,
      discountAmountIdr: amounts.totalDiscountIdr,
      estimatedChannelFeeIdr: estimatedFeeIdr,
      pricingSource: pricing.source,
      period,
      createdAtMs: input.nowMs,
    });

    const agencySnapshot = {
      ...baseSnapshot,
      payerKind: "agency" as const,
      agencyId: agency.id,
      agencyName: agency.name,
      agencyDiscountPercent: amounts.agencyDiscountPercent,
      agencyDiscountIdr: amounts.agencyDiscountIdr,
    };

    const newObligationId = generateAgencyUlid(input.nowMs);
    const dueAtMs = input.nowMs + DEFAULT_OBLIGATION_TTL_MS;

    await db
      .prepare(
        `INSERT INTO billing_obligations (
           id, tenant_id, payer_type, payer_agency_id, plan_interval, status,
           gross_amount_idr, discount_amount_idr, net_amount_idr, currency,
           period_start_at, period_end_at, snapshot_json, idempotency_key,
           request_hash, due_at, paid_at, review_required, version, created_at, updated_at
         ) VALUES (?, ?, 'agency', ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, ?, ?)`,
      )
      .bind(
        newObligationId,
        client.tenantId,
        agency.id,
        input.plan,
        amounts.baseAmountIdr,
        amounts.totalDiscountIdr,
        amounts.netAmountIdr,
        BILLING_CURRENCY,
        period.periodStartAtMs,
        period.periodEndAtMs,
        JSON.stringify(agencySnapshot),
        input.idempotencyKey,
        input.requestHash,
        dueAtMs,
        input.nowMs,
        input.nowMs,
      )
      .run();

    const reloaded = await getTenantObligationById(db, client.tenantId, newObligationId);
    if (!reloaded) {
      throw new BillingValidationError("OBLIGATION_CREATE_FAILED", "Gagal membuat tagihan klien.");
    }
    obligation = reloaded.obligation;
  }

  const attemptId = generateAgencyUlid(input.nowMs);
  const reffId = `PSAG-${attemptId.slice(-14)}`;
  const providerAccountId = input.providerAccountId?.trim() || "default";
  const totalPayableIdr = obligation.netAmountIdr + estimatedFeeIdr;

  const { statement: auditStmt } = buildPlatformAuditStatement(db, {
    actorUserId: input.actorUserId,
    actorRole: input.actorAgencyRole ?? "agency_admin",
    action: "agency.billing.checkout_initiated",
    targetType: "billing_obligation",
    targetId: obligation.id,
    tenantId: client.tenantId,
    reason: `Agency "${agency.name}" initiated ${input.plan} checkout for client "${client.handle}"`,
    requireReason: false,
    outcome: "success",
    metadata: {
      agencyId: agency.id,
      tenantId: client.tenantId,
      obligationId: obligation.id,
      attemptId,
      plan: input.plan,
      channelKind: input.channelKind,
      baseAmountIdr: obligation.baseAmountIdr,
      discountAmountIdr: obligation.discountAmountIdr,
      netAmountIdr: obligation.netAmountIdr,
      agencyDiscountPercent: amounts.agencyDiscountPercent,
    },
    createdAtMs: input.nowMs,
  });

  await db.batch([
    db
      .prepare(
        `INSERT INTO payment_attempts (
           id, obligation_id, tenant_id, channel, provider, provider_account_id,
           provider_transaction_id, reff_id, channel_code, idempotency_key,
           request_hash, amount_idr, state, lifecycle_state,
           base_amount_idr, discount_amount_idr, channel_fee_idr, total_payable_idr,
           expires_at, provider_payload_json, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'autolaris', ?, NULL, ?, ?, ?, ?, ?, 'initiated', 'creating', ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
      )
      .bind(
        attemptId,
        obligation.id,
        client.tenantId,
        input.channelKind,
        providerAccountId,
        reffId,
        input.channelCode,
        input.idempotencyKey,
        input.requestHash,
        totalPayableIdr,
        obligation.baseAmountIdr,
        obligation.discountAmountIdr,
        estimatedFeeIdr,
        totalPayableIdr,
        input.nowMs,
        input.nowMs,
      ),
    auditStmt,
  ]);

  const [reloadedAfter, createdAttempt] = await Promise.all([
    getTenantObligationById(db, client.tenantId, obligation.id),
    getTenantPaymentAttemptById(db, client.tenantId, attemptId),
  ]);
  if (!reloadedAfter || !createdAttempt) {
    throw new BillingValidationError(
      "ATTEMPT_CREATE_FAILED",
      "Gagal menyimpan percobaan pembayaran agensi.",
    );
  }

  return {
    result: {
      mode: "created",
      obligation: reloadedAfter.obligation,
      attempt: createdAttempt,
    },
    client,
    amounts,
    agency,
  };
}

export interface AgencyBillingOverview {
  readonly agency: AgencySummary;
  readonly pricing: {
    readonly currency: typeof BILLING_CURRENCY;
    readonly baseMonthlyIdr: number;
    readonly baseYearlyIdr: number;
    readonly effectiveDiscountPercent: number;
    readonly discountedMonthlyIdr: number;
    readonly discountedYearlyIdr: number;
    readonly yearlySavingsIdr: number;
    readonly source: PlatformBillingPricing["source"];
  };
  readonly clients: readonly AgencyClientSummary[];
  readonly receipts: readonly PaymentReceiptRecord[];
}

export async function getAgencyBillingOverview(
  db: D1Database,
  agencyId: string,
  options: { readonly nowMs?: number } = {},
): Promise<AgencyBillingOverview | null> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const agency = await getAgencyById(db, agencyId);
  if (!agency) return null;

  const [pricing, clients] = await Promise.all([
    loadPlatformBillingPricing(db),
    listAgencyClients(db, agency.id, { nowMs, limit: 200 }),
  ]);

  let receipts: readonly PaymentReceiptRecord[];
  try {
    receipts = await listAgencyPaymentReceipts(db, agency.id, { limit: 100 });
  } catch {
    receipts = [];
  }

  const monthlyAmounts = computeAgencyClientCheckoutAmounts({
    baseAmountIdr: pricing.monthlyPriceIdr,
    agencyDiscountPercent: agency.effectiveDiscountPercent,
  });
  const yearlyAmounts = computeAgencyClientCheckoutAmounts({
    baseAmountIdr: pricing.yearlyPriceIdr,
    agencyDiscountPercent: agency.effectiveDiscountPercent,
  });

  return {
    agency,
    pricing: {
      currency: BILLING_CURRENCY,
      baseMonthlyIdr: pricing.monthlyPriceIdr,
      baseYearlyIdr: pricing.yearlyPriceIdr,
      effectiveDiscountPercent: agency.effectiveDiscountPercent,
      discountedMonthlyIdr: monthlyAmounts.netAmountIdr,
      discountedYearlyIdr: yearlyAmounts.netAmountIdr,
      yearlySavingsIdr: Math.max(0, monthlyAmounts.netAmountIdr * 12 - yearlyAmounts.netAmountIdr),
      source: pricing.source,
    },
    clients,
    receipts,
  };
}

export interface AgencyAuditEntrySummary {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly actorRole: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly tenantId: string | null;
  readonly outcome: string;
  readonly createdAt: number;
}

export async function listAgencyAuditEntries(
  db: D1Database,
  agencyId: string,
  options: { readonly limit?: number } = {},
): Promise<readonly AgencyAuditEntrySummary[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 30)));
  const res = await db
    .prepare(
      `SELECT id, actor_user_id, actor_role, action, target_type, target_id,
              tenant_id, outcome, created_at
       FROM platform_audit
       WHERE (target_type = 'agency' AND target_id = ?)
          OR tenant_id IN (SELECT id FROM tenants WHERE agency_id = ?)
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(agencyId, agencyId, limit)
    .all<{
      readonly id: string;
      readonly actor_user_id: string | null;
      readonly actor_role: string;
      readonly action: string;
      readonly target_type: string;
      readonly target_id: string;
      readonly tenant_id: string | null;
      readonly outcome: string;
      readonly created_at: number;
    }>();

  return (res.results ?? []).map((r) => ({
    id: r.id,
    actorUserId: r.actor_user_id,
    actorRole: r.actor_role,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    tenantId: r.tenant_id,
    outcome: r.outcome,
    createdAt: r.created_at,
  }));
}

export type { BillingObligationRecord, PaymentAttemptRecord, PaymentReceiptRecord };
export { DEFAULT_INVITATION_TTL_MS };

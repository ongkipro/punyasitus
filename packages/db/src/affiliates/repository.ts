import {
  AFFILIATE_PENDING_CODE_PREFIX,
  AffiliateValidationError,
  buildAffiliateReferralLink,
  computeNormalizedEmailHash,
  computePayoutAccountNumberHash,
  computePayoutIdentityHash,
  DEFAULT_AFFILIATE_MARKETING_ORIGIN,
  normalizeAffiliateReferralCode,
  normalizeEmailForAntiAbuse,
  validateAffiliateApplicationPayload,
  type AffiliateDbStatus,
} from "@punyasitus/core/affiliates/index";
import {
  buildPlatformAuditStatement,
  generatePlatformAuditId,
  PlatformAuditError,
  validateOperatorReason,
  type PlatformAuditRecord,
} from "../platform/audit.ts";
import {
  AffiliateError,
  type AffiliateAccountRecord,
  type ApplyAffiliateInput,
  type ApplyAffiliateResult,
  type ApproveAffiliateInput,
  type PublicAffiliateSummaryDto,
  type RejectAffiliateInput,
  type SuspendAffiliateInput,
} from "./types.ts";

/**
 * Affiliate account enrollment, superadmin approval/suspension/rejection, and
 * cookieless funnel visit counter repository (`packages/db/src/affiliates/repository.ts`;
 * REQ-084, PLAN §19.4, TASK-084).
 *
 * Security invariants:
 * - Zero runtime DDL on hot paths (migrations applied via `0031_affiliates.sql`).
 * - Separate affiliate account model (`affiliates` + `affiliate_enrollment_profiles`),
 *   one unique affiliate account per `user_id` (`409 AFFILIATE_ALREADY_EXISTS`).
 * - Raw payout bank/e-wallet account numbers are NEVER written to `platform_audit` or
 *   returned in DTOs; only masked displays and normalized SHA-256 hashes are persisted.
 * - Referral codes are issued strictly upon superadmin approval (`status = 'active'`).
 */

const REFERRAL_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

interface AffiliateJoinRow {
  readonly id: string;
  readonly user_id: string;
  readonly referral_code: string;
  readonly status: AffiliateDbStatus;
  readonly payout_method: string | null;
  readonly payout_account_name: string | null;
  readonly payout_account_number: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly email: string | null;
  readonly approved_referral_code: string | null;
  readonly payout_bank_code: string | null;
  readonly payout_account_holder: string | null;
  readonly payout_account_masked: string | null;
  readonly payout_account_number_hash: string | null;
  readonly payout_identity_hash: string | null;
  readonly terms_version: string | null;
  readonly terms_accepted_at: number | null;
  readonly approved_by_user_id: string | null;
  readonly approved_at: number | null;
  readonly suspended_by_user_id: string | null;
  readonly suspended_at: number | null;
  readonly rejected_by_user_id: string | null;
  readonly rejected_at: number | null;
  readonly status_reason: string | null;
}

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly email_verified: number;
}

function generatePublicReferralCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (let i = 0; i < bytes.length; i += 1) {
    suffix += REFERRAL_CODE_ALPHABET[(bytes[i] ?? 0) % REFERRAL_CODE_ALPHABET.length] ?? "A";
  }
  return `PS${suffix}`;
}

function formatUtcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function mapAffiliateRow(
  row: AffiliateJoinRow,
  marketingOrigin: string = DEFAULT_AFFILIATE_MARKETING_ORIGIN,
): AffiliateAccountRecord {
  const rawCode = row.approved_referral_code ?? row.referral_code;
  const publicCode =
    rawCode && !rawCode.toLowerCase().startsWith(AFFILIATE_PENDING_CODE_PREFIX)
      ? normalizeAffiliateReferralCode(rawCode)
      : null;

  const referralLink =
    row.status === "active" && publicCode
      ? buildAffiliateReferralLink(publicCode, marketingOrigin)
      : null;

  return {
    id: row.id,
    userId: row.user_id,
    email: row.email ?? "",
    status: row.status,
    referralCode: publicCode,
    referralLink,
    payoutBankCode: row.payout_bank_code ?? row.payout_method ?? "",
    payoutAccountHolder: row.payout_account_holder ?? row.payout_account_name ?? "",
    payoutAccountMasked: row.payout_account_masked ?? row.payout_account_number ?? "",
    payoutAccountNumberHash: row.payout_account_number_hash ?? "",
    payoutIdentityHash: row.payout_identity_hash ?? "",
    termsVersion: row.terms_version ?? "",
    termsAcceptedAt: row.terms_accepted_at ?? row.created_at,
    approvedByUserId: row.approved_by_user_id ?? null,
    approvedAt: row.approved_at ?? null,
    suspendedByUserId: row.suspended_by_user_id ?? null,
    suspendedAt: row.suspended_at ?? null,
    rejectedByUserId: row.rejected_by_user_id ?? null,
    rejectedAt: row.rejected_at ?? null,
    statusReason: row.status_reason ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function formatPublicAffiliateSummaryDto(
  record: AffiliateAccountRecord,
): PublicAffiliateSummaryDto {
  return {
    id: record.id,
    userId: record.userId,
    status: record.status,
    referralCode: record.referralCode,
    referralLink: record.referralLink,
    payoutBankCode: record.payoutBankCode,
    payoutAccountHolder: record.payoutAccountHolder,
    payoutAccountMasked: record.payoutAccountMasked,
    termsVersion: record.termsVersion,
    termsAcceptedAt: record.termsAcceptedAt,
    approvedAt: record.approvedAt,
    suspendedAt: record.suspendedAt,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const AFFILIATE_JOIN_SELECT = `
  SELECT
    a.id,
    a.user_id,
    a.referral_code,
    a.status,
    a.payout_method,
    a.payout_account_name,
    a.payout_account_number,
    a.version,
    a.created_at,
    a.updated_at,
    p.email,
    p.approved_referral_code,
    p.payout_bank_code,
    p.payout_account_holder,
    p.payout_account_masked,
    p.payout_account_number_hash,
    p.payout_identity_hash,
    p.terms_version,
    p.terms_accepted_at,
    p.approved_by_user_id,
    p.approved_at,
    p.suspended_by_user_id,
    p.suspended_at,
    p.rejected_by_user_id,
    p.rejected_at,
    p.status_reason
  FROM affiliates a
  LEFT JOIN affiliate_enrollment_profiles p ON p.affiliate_id = a.id
`;

export async function getAffiliateById(
  platformDb: D1Database,
  affiliateId: string,
  marketingOrigin: string = DEFAULT_AFFILIATE_MARKETING_ORIGIN,
): Promise<AffiliateAccountRecord | null> {
  const row = await platformDb
    .prepare(`${AFFILIATE_JOIN_SELECT} WHERE a.id = ? LIMIT 1`)
    .bind(affiliateId.trim())
    .first<AffiliateJoinRow>();
  return row ? mapAffiliateRow(row, marketingOrigin) : null;
}

export async function getAffiliateByUserId(
  platformDb: D1Database,
  userId: string,
  marketingOrigin: string = DEFAULT_AFFILIATE_MARKETING_ORIGIN,
): Promise<AffiliateAccountRecord | null> {
  const row = await platformDb
    .prepare(`${AFFILIATE_JOIN_SELECT} WHERE a.user_id = ? LIMIT 1`)
    .bind(userId.trim())
    .first<AffiliateJoinRow>();
  return row ? mapAffiliateRow(row, marketingOrigin) : null;
}

export async function getAffiliateByReferralCode(
  platformDb: D1Database,
  rawCode: string,
  marketingOrigin: string = DEFAULT_AFFILIATE_MARKETING_ORIGIN,
): Promise<AffiliateAccountRecord | null> {
  const normalized = normalizeAffiliateReferralCode(rawCode);
  if (!normalized) return null;

  const row = await platformDb
    .prepare(
      `${AFFILIATE_JOIN_SELECT}
       WHERE UPPER(a.referral_code) = ?
         AND SUBSTR(LOWER(a.referral_code), 1, 10) != '__pending_'
       LIMIT 1`,
    )
    .bind(normalized)
    .first<AffiliateJoinRow>();
  return row ? mapAffiliateRow(row, marketingOrigin) : null;
}

function isUniqueConstraintError(err: unknown, fragment?: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (!/UNIQUE constraint failed/i.test(message)) return false;
  if (!fragment) return true;
  return message.toLowerCase().includes(fragment.toLowerCase());
}

/**
 * Submits a verified user's affiliate application in `pending` state atomically with
 * `affiliate_enrollment_profiles`, `user_payout_identities`, and PII-free `platform_audit`.
 */
export async function applyForAffiliateAccount(
  platformDb: D1Database,
  input: ApplyAffiliateInput,
): Promise<ApplyAffiliateResult> {
  const userId = input.userId.trim();
  if (!userId) {
    throw new AffiliateError(401, "UNAUTHENTICATED", "Sesi pengguna terautentikasi wajib digunakan.");
  }

  // Enforce verified-email gate BEFORE payload validation so unverified users always receive 403.
  const user = await platformDb
    .prepare("SELECT id, email, email_verified FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<UserRow>();

  if (!user) {
    throw new AffiliateError(401, "UNAUTHENTICATED", "Akun pengguna tidak ditemukan.");
  }

  if (user.email_verified !== 1) {
    throw new AffiliateError(
      403,
      "EMAIL_NOT_VERIFIED",
      "Verifikasi alamat email Anda terlebih dahulu sebelum mendaftar sebagai afiliasi.",
    );
  }

  let validated: ReturnType<typeof validateAffiliateApplicationPayload>;
  try {
    validated = validateAffiliateApplicationPayload(input.payload);
  } catch (err) {
    if (err instanceof AffiliateValidationError) {
      throw new AffiliateError(err.status, err.code, err.message, {
        field: err.field,
        cause: err,
      });
    }
    throw err;
  }

  const existing = await platformDb
    .prepare("SELECT id FROM affiliates WHERE user_id = ? LIMIT 1")
    .bind(user.id)
    .first<{ readonly id: string }>();

  if (existing) {
    throw new AffiliateError(
      409,
      "AFFILIATE_ALREADY_EXISTS",
      "Akun Anda sudah terdaftar dalam program afiliasi.",
    );
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const affiliateId = generatePlatformAuditId(nowMs);
  const payoutIdentityRowId = generatePlatformAuditId(nowMs + 1);
  const pendingCode = `${AFFILIATE_PENDING_CODE_PREFIX}${affiliateId}`;

  const emailLower = user.email.trim().toLowerCase();
  const normalizedEmail = normalizeEmailForAntiAbuse(emailLower);
  const [emailHash, payoutAccountNumberHash, payoutIdentityHash] = await Promise.all([
    computeNormalizedEmailHash(emailLower),
    computePayoutAccountNumberHash(validated.payoutBankCode, validated.payoutAccountNumberDigits),
    computePayoutIdentityHash({
      payoutBankCode: validated.payoutBankCode,
      payoutAccountNumber: validated.payoutAccountNumberDigits,
    }),
  ]);

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(platformDb, {
    actorUserId: user.id,
    actorRole: "affiliate_applicant",
    action: "affiliate.apply",
    targetType: "affiliate",
    targetId: affiliateId,
    outcome: "success",
    requestId: input.requestId ?? null,
    createdAtMs: nowMs,
    // Strictly PII-free & zero raw bank account digits in platform_audit!
    metadata: {
      status: "pending",
      payoutBankCode: validated.payoutBankCode,
      payoutAccountMasked: validated.payoutAccountMasked,
      termsVersion: validated.termsVersion,
    },
  });

  try {
    await platformDb.batch([
      platformDb
        .prepare(
          `INSERT INTO affiliates (
            id, user_id, referral_code, status,
            payout_method, payout_account_name, payout_account_number,
            version, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          affiliateId,
          user.id,
          pendingCode,
          validated.payoutBankCode,
          validated.payoutAccountHolder,
          validated.payoutAccountMasked,
          nowMs,
          nowMs,
        ),
      platformDb
        .prepare(
          `INSERT INTO affiliate_enrollment_profiles (
            affiliate_id, user_id, email, normalized_email, email_hash,
            approved_referral_code, payout_bank_code, payout_account_holder,
            payout_account_masked, payout_account_number_hash, payout_identity_hash,
            terms_version, terms_accepted_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          affiliateId,
          user.id,
          emailLower,
          normalizedEmail,
          emailHash,
          validated.payoutBankCode,
          validated.payoutAccountHolder,
          validated.payoutAccountMasked,
          payoutAccountNumberHash,
          payoutIdentityHash,
          validated.termsVersion,
          nowMs,
          nowMs,
          nowMs,
        ),
      platformDb
        .prepare(
          `INSERT OR IGNORE INTO user_payout_identities (
            id, user_id, payout_identity_hash, source, created_at
          ) VALUES (?, ?, ?, 'affiliate_application', ?)`,
        )
        .bind(payoutIdentityRowId, user.id, payoutIdentityHash, nowMs),
      auditStmt,
    ]);
  } catch (err) {
    if (isUniqueConstraintError(err, "user_id")) {
      throw new AffiliateError(
        409,
        "AFFILIATE_ALREADY_EXISTS",
        "Akun Anda sudah terdaftar dalam program afiliasi.",
        { cause: err },
      );
    }
    throw new AffiliateError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menyimpan pendaftaran afiliasi secara atomik.",
      { cause: err },
    );
  }

  const created = await getAffiliateById(platformDb, affiliateId);
  if (!created) {
    throw new AffiliateError(500, "AUDIT_PERSISTENCE_FAILED", "Data afiliasi tidak ditemukan setelah penyimpanan.");
  }

  return { affiliate: created, audit };
}

function validateSuperadminReasonOrThrow(rawReason: string): string {
  try {
    return validateOperatorReason(rawReason);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new AffiliateError(422, "VALIDATION_ERROR", err.message, {
        field: "reason",
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Superadmin approval of a `pending` (or re-activation of a `suspended`) affiliate account.
 * Issues a unique public referral code and records an atomic `platform_audit` entry.
 */
export async function approveAffiliate(
  platformDb: D1Database,
  input: ApproveAffiliateInput,
): Promise<{ readonly affiliate: AffiliateAccountRecord; readonly audit: PlatformAuditRecord }> {
  const validatedReason = validateSuperadminReasonOrThrow(input.reason);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const marketingOrigin = input.marketingOrigin ?? DEFAULT_AFFILIATE_MARKETING_ORIGIN;

  const existing = await getAffiliateById(platformDb, input.affiliateId, marketingOrigin);
  if (!existing) {
    throw new AffiliateError(404, "AFFILIATE_NOT_FOUND", "Akun afiliasi tidak ditemukan.");
  }

  if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
    throw new AffiliateError(
      409,
      "STALE_VERSION",
      "Versi data afiliasi sudah berubah. Muat ulang sebelum menyetujui.",
    );
  }

  if (existing.status === "active") {
    throw new AffiliateError(
      409,
      "INVALID_STATE_TRANSITION",
      "Akun afiliasi sudah berstatus aktif/disetujui.",
    );
  }
  if (existing.status === "rejected") {
    throw new AffiliateError(
      409,
      "INVALID_STATE_TRANSITION",
      "Akun afiliasi yang telah ditolak tidak dapat disetujui langsung.",
    );
  }

  let issuedCode: string;
  if (input.referralCode !== undefined && input.referralCode !== null && input.referralCode.trim() !== "") {
    const normalized = normalizeAffiliateReferralCode(input.referralCode);
    if (!normalized) {
      throw new AffiliateError(
        422,
        "INVALID_REFERRAL_CODE",
        "Format kode referral harus 4-32 karakter alfanumerik, garis bawah, atau tanda hubung.",
        { field: "referralCode" },
      );
    }
    const conflict = await platformDb
      .prepare("SELECT id FROM affiliates WHERE UPPER(referral_code) = ? AND id != ? LIMIT 1")
      .bind(normalized, existing.id)
      .first<{ readonly id: string }>();
    if (conflict) {
      throw new AffiliateError(
        409,
        "REFERRAL_CODE_TAKEN",
        `Kode referral "${normalized}" sudah digunakan oleh afiliasi lain.`,
        { field: "referralCode" },
      );
    }
    issuedCode = normalized;
  } else if (existing.status === "suspended" && existing.referralCode) {
    issuedCode = existing.referralCode;
  } else {
    let generated = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generatePublicReferralCode();
      const conflict = await platformDb
        .prepare("SELECT id FROM affiliates WHERE UPPER(referral_code) = ? LIMIT 1")
        .bind(candidate)
        .first<{ readonly id: string }>();
      if (!conflict) {
        generated = candidate;
        break;
      }
    }
    if (!generated) {
      throw new AffiliateError(500, "AUDIT_PERSISTENCE_FAILED", "Gagal menghasilkan kode referral unik.");
    }
    issuedCode = generated;
  }

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "platform_operator",
      action: "console.affiliate.approve",
      targetType: "affiliate",
      targetId: existing.id,
      reason: validatedReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      createdAtMs: nowMs,
      metadata: {
        previousStatus: existing.status,
        newStatus: "active",
        referralCode: issuedCode,
      },
    },
    { onlyIfPreviousChanged: true },
  );

  try {
    const results = await platformDb.batch([
      platformDb
        .prepare(
          `UPDATE affiliates
           SET status = 'active',
               referral_code = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(issuedCode, nowMs, existing.id, existing.version),
      auditStmt,
      platformDb
        .prepare(
          `UPDATE affiliate_enrollment_profiles
           SET approved_referral_code = ?,
               approved_by_user_id = ?,
               approved_at = ?,
               suspended_by_user_id = NULL,
               suspended_at = NULL,
               status_reason = ?,
               updated_at = ?
           WHERE affiliate_id = ?`,
        )
        .bind(issuedCode, input.actorUserId, nowMs, validatedReason, nowMs, existing.id),
    ]);

    const updatedCount = results[0]?.meta?.changes ?? 0;
    if (updatedCount !== 1) {
      throw new AffiliateError(
        409,
        "STALE_VERSION",
        "Versi data afiliasi berubah secara bersamaan. Silakan coba lagi.",
      );
    }
  } catch (err) {
    if (err instanceof AffiliateError) throw err;
    if (isUniqueConstraintError(err, "referral_code")) {
      throw new AffiliateError(
        409,
        "REFERRAL_CODE_TAKEN",
        `Kode referral "${issuedCode}" sudah digunakan oleh afiliasi lain.`,
        { cause: err },
      );
    }
    throw new AffiliateError(500, "AUDIT_PERSISTENCE_FAILED", "Gagal menyetujui akun afiliasi.", {
      cause: err,
    });
  }

  const updated = await getAffiliateById(platformDb, existing.id, marketingOrigin);
  if (!updated) {
    throw new AffiliateError(404, "AFFILIATE_NOT_FOUND", "Akun afiliasi tidak ditemukan.");
  }

  return { affiliate: updated, audit };
}

/**
 * Superadmin suspension of an affiliate account. Suspended affiliates immediately produce
 * zero new referral attribution and cannot attach `?ref=` on tenant footer badges.
 */
export async function suspendAffiliate(
  platformDb: D1Database,
  input: SuspendAffiliateInput,
): Promise<{ readonly affiliate: AffiliateAccountRecord; readonly audit: PlatformAuditRecord }> {
  const validatedReason = validateSuperadminReasonOrThrow(input.reason);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());

  const existing = await getAffiliateById(platformDb, input.affiliateId);
  if (!existing) {
    throw new AffiliateError(404, "AFFILIATE_NOT_FOUND", "Akun afiliasi tidak ditemukan.");
  }

  if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
    throw new AffiliateError(
      409,
      "STALE_VERSION",
      "Versi data afiliasi sudah berubah. Muat ulang sebelum menangguhkan.",
    );
  }

  if (existing.status === "suspended") {
    throw new AffiliateError(409, "INVALID_STATE_TRANSITION", "Akun afiliasi sudah berstatus ditangguhkan.");
  }

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "platform_operator",
      action: "console.affiliate.suspend",
      targetType: "affiliate",
      targetId: existing.id,
      reason: validatedReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      createdAtMs: nowMs,
      metadata: {
        previousStatus: existing.status,
        newStatus: "suspended",
        referralCode: existing.referralCode,
      },
    },
    { onlyIfPreviousChanged: true },
  );

  const results = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE affiliates
         SET status = 'suspended',
             version = version + 1,
             updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(nowMs, existing.id, existing.version),
    auditStmt,
    platformDb
      .prepare(
        `UPDATE affiliate_enrollment_profiles
         SET suspended_by_user_id = ?,
             suspended_at = ?,
             status_reason = ?,
             updated_at = ?
         WHERE affiliate_id = ?`,
      )
      .bind(input.actorUserId, nowMs, validatedReason, nowMs, existing.id),
  ]);

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    throw new AffiliateError(409, "STALE_VERSION", "Versi data afiliasi berubah secara bersamaan.");
  }

  const updated = await getAffiliateById(platformDb, existing.id);
  if (!updated) {
    throw new AffiliateError(404, "AFFILIATE_NOT_FOUND", "Akun afiliasi tidak ditemukan.");
  }
  return { affiliate: updated, audit };
}

/**
 * Superadmin rejection of a `pending` affiliate application with mandatory audited reason.
 */
export async function rejectAffiliate(
  platformDb: D1Database,
  input: RejectAffiliateInput,
): Promise<{ readonly affiliate: AffiliateAccountRecord; readonly audit: PlatformAuditRecord }> {
  const validatedReason = validateSuperadminReasonOrThrow(input.reason);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());

  const existing = await getAffiliateById(platformDb, input.affiliateId);
  if (!existing) {
    throw new AffiliateError(404, "AFFILIATE_NOT_FOUND", "Akun afiliasi tidak ditemukan.");
  }

  if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
    throw new AffiliateError(409, "STALE_VERSION", "Versi data afiliasi sudah berubah.");
  }

  if (existing.status !== "pending") {
    throw new AffiliateError(
      409,
      "INVALID_STATE_TRANSITION",
      "Hanya pendaftaran afiliasi berstatus pending yang dapat ditolak.",
    );
  }

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "platform_operator",
      action: "console.affiliate.reject",
      targetType: "affiliate",
      targetId: existing.id,
      reason: validatedReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      createdAtMs: nowMs,
      metadata: {
        previousStatus: existing.status,
        newStatus: "rejected",
      },
    },
    { onlyIfPreviousChanged: true },
  );

  const results = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE affiliates
         SET status = 'rejected',
             version = version + 1,
             updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(nowMs, existing.id, existing.version),
    auditStmt,
    platformDb
      .prepare(
        `UPDATE affiliate_enrollment_profiles
         SET rejected_by_user_id = ?,
             rejected_at = ?,
             status_reason = ?,
             updated_at = ?
         WHERE affiliate_id = ?`,
      )
      .bind(input.actorUserId, nowMs, validatedReason, nowMs, existing.id),
  ]);

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    throw new AffiliateError(409, "STALE_VERSION", "Versi data afiliasi berubah secara bersamaan.");
  }

  const updated = await getAffiliateById(platformDb, existing.id);
  if (!updated) {
    throw new AffiliateError(404, "AFFILIATE_NOT_FOUND", "Akun afiliasi tidak ditemukan.");
  }
  return { affiliate: updated, audit };
}

/**
 * Increments the cookieless daily referral visit counter for an active affiliate.
 * Strictly zero visitor PII (no IP, email, cookie, or user-agent).
 */
export async function recordAffiliateFunnelVisit(
  platformDb: D1Database,
  referralCode: string,
  nowMs: number = Date.now(),
): Promise<{ readonly recorded: boolean; readonly affiliateId: string | null }> {
  const normalized = normalizeAffiliateReferralCode(referralCode);
  if (!normalized) return { recorded: false, affiliateId: null };

  const activeAffiliate = await platformDb
    .prepare(
      `SELECT id FROM affiliates
       WHERE UPPER(referral_code) = ?
         AND status = 'active'
         AND SUBSTR(LOWER(referral_code), 1, 10) != '__pending_'
       LIMIT 1`,
    )
    .bind(normalized)
    .first<{ readonly id: string }>();

  if (!activeAffiliate) {
    return { recorded: false, affiliateId: null };
  }

  const ts = Math.trunc(nowMs);
  const dayUtc = formatUtcDay(ts);
  await platformDb
    .prepare(
      `INSERT INTO affiliate_funnel_visits (affiliate_id, day_utc, visit_count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (affiliate_id, day_utc)
       DO UPDATE SET visit_count = visit_count + 1, updated_at = excluded.updated_at`,
    )
    .bind(activeAffiliate.id, dayUtc, ts)
    .run();

  return { recorded: true, affiliateId: activeAffiliate.id };
}

export async function getAffiliateFunnelVisitsTotal(
  platformDb: D1Database,
  affiliateId: string,
): Promise<number> {
  const row = await platformDb
    .prepare(
      "SELECT COALESCE(SUM(visit_count), 0) AS total FROM affiliate_funnel_visits WHERE affiliate_id = ?",
    )
    .bind(affiliateId.trim())
    .first<{ readonly total: number }>();
  return Number(row?.total ?? 0);
}

/**
 * Persists a normalized payout identity hash associated with a user for anti-self-referral matching.
 */
export async function recordUserPayoutIdentityHash(
  platformDb: D1Database,
  params: {
    readonly userId: string;
    readonly payoutBankCode: string;
    readonly payoutAccountNumber: string;
    readonly source?: string;
    readonly nowMs?: number;
  },
): Promise<{ readonly payoutIdentityHash: string }> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const payoutIdentityHash = await computePayoutIdentityHash({
    payoutBankCode: params.payoutBankCode,
    payoutAccountNumber: params.payoutAccountNumber,
  });
  const id = generatePlatformAuditId(nowMs);
  await platformDb
    .prepare(
      `INSERT OR IGNORE INTO user_payout_identities (id, user_id, payout_identity_hash, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, params.userId.trim(), payoutIdentityHash, params.source ?? "owner_profile", nowMs)
    .run();

  return { payoutIdentityHash };
}

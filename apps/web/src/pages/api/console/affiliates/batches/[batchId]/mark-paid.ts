import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  parseStrictConsoleJsonBody,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import { markAffiliatePayoutBatchPaid } from "@punyasitus/db/affiliates/ledger/index";
import { PlatformAuditError, validateOperatorReason } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import {
  assertConsoleAffiliateSuperadminRole,
  evaluateAffiliatePayoutCompliance,
  mapConsoleAffiliateErrorToResponse,
  resolveConsoleAffiliatesRuntimeEnv,
} from "../../_shared.ts";

/**
 * `POST /api/console/affiliates/batches/[batchId]/mark-paid`
 * Audited superadmin payout settlement endpoint (`console.punyasitus.com` ONLY;
 * REQ-086, REQ-095, REQ-051, REQ-068, PLAN §19.4, TASK-086).
 *
 * Security & Compliance Invariants:
 * - Console host isolation + CSRF/Origin.
 * - Active `platform_superadmin` operator + fresh 10-minute 2FA step-up (`403 REAUTH_REQUIRED`).
 * - Mandatory 10–500 char `reason`, `transferReference` (3–120 chars), and OCC `expectedVersion`.
 * - Enforces REQ-095 affiliate tax & terms compliance gate BEFORE any payout mutation:
 *   returns `422 AFFILIATE_COMPLIANCE_INCOMPLETE` unless BOTH platform tax/terms reminders
 *   AND the affiliate's `terms_accepted_at` / payout details are resolved.
 * - Delegates atomic batch + entries + `platform_audit` update to `markAffiliatePayoutBatchPaid`.
 */

const MARK_PAID_ALLOWED_KEYS = new Set(["transferReference", "reason", "expectedVersion"]);

export async function handleConsoleMarkPayoutBatchPaidRequest(
  batchId: string,
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  if (method !== "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.affiliates.batch.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode POST untuk menandai batch payout afiliasi sebagai dibayar.",
      authz.ctx.requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.affiliates.batch.mark_paid", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const rbacErr = assertConsoleAffiliateSuperadminRole(authz.ctx.actor, authz.ctx.requestId);
  if (rbacErr) return rbacErr;

  const parsed = await parseStrictConsoleJsonBody(
    request,
    authz.ctx.requestId,
    MARK_PAID_ALLOWED_KEYS,
  );
  if (!parsed.ok) return parsed.response;

  const rawExpectedVersion = parsed.body.expectedVersion;
  if (
    typeof rawExpectedVersion !== "number" ||
    !Number.isSafeInteger(rawExpectedVersion) ||
    rawExpectedVersion < 1
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field expectedVersion wajib berupa bilangan bulat positif untuk proteksi konkurensi.",
      authz.ctx.requestId,
      { field: "expectedVersion" },
    );
  }

  const rawTransferRef =
    typeof parsed.body.transferReference === "string" ? parsed.body.transferReference.trim() : "";
  if (rawTransferRef.length < 3 || rawTransferRef.length > 120) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Referensi transfer bank wajib diisi (3 hingga 120 karakter).",
      authz.ctx.requestId,
      { field: "transferReference" },
    );
  }

  const rawReason = typeof parsed.body.reason === "string" ? parsed.body.reason : "";
  try {
    validateOperatorReason(rawReason);
  } catch (err) {
    const msg =
      err instanceof PlatformAuditError
        ? err.message
        : "Alasan audit operator wajib diisi (10 hingga 500 karakter).";
    return consoleErrorResponse(422, "VALIDATION_ERROR", msg, authz.ctx.requestId, {
      field: "reason",
    });
  }

  try {
    const cleanBatchId = batchId.trim();
    const batchRow = await authz.ctx.platformDb
      .prepare(
        `SELECT id, affiliate_id, status, version
         FROM affiliate_commission_payout_batches
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(cleanBatchId)
      .first<{
        readonly id: string;
        readonly affiliate_id: string;
        readonly status: string;
        readonly version: number;
      }>();

    if (!batchRow) {
      return consoleErrorResponse(
        404,
        "NOT_FOUND",
        "Batch payout afiliasi tidak ditemukan.",
        authz.ctx.requestId,
      );
    }

    if (batchRow.status !== "pending_review") {
      return consoleErrorResponse(
        409,
        "INVALID_STATE_TRANSITION",
        `Batch payout berstatus "${batchRow.status}" dan tidak dapat ditandai dibayar lagi.`,
        authz.ctx.requestId,
      );
    }

    if (batchRow.version !== rawExpectedVersion) {
      return consoleErrorResponse(
        409,
        "STALE_VERSION",
        "Versi batch payout sudah berubah. Muat ulang sebelum melanjutkan.",
        authz.ctx.requestId,
      );
    }

    // REQ-095 Tax & Terms Compliance Gate (blocks payment until both platform & affiliate compliance resolved)
    const compliance = await evaluateAffiliatePayoutCompliance(
      authz.ctx.platformDb,
      batchRow.affiliate_id,
    );
    if (!compliance.resolved) {
      return consoleErrorResponse(
        422,
        "AFFILIATE_COMPLIANCE_INCOMPLETE",
        "Batch payout tidak dapat ditandai dibayar sebelum persyaratan ketentuan dan tinjauan pajak afiliasi (REQ-095) terselesaikan.",
        authz.ctx.requestId,
        {
          missing: compliance.missing,
          compliance,
        },
      );
    }

    const result = await markAffiliatePayoutBatchPaid(authz.ctx.platformDb, {
      batchId: cleanBatchId,
      actorUserId: authz.ctx.user.id,
      transferReference: rawTransferRef,
      reason: rawReason,
      expectedVersion: rawExpectedVersion,
      requestId: authz.ctx.requestId,
      nowMs: authz.ctx.nowMs,
    });

    return consoleJsonResponse(200, {
      success: true,
      batch: {
        id: result.batch.id,
        affiliateId: result.batch.affiliateId,
        payoutPeriodKey: result.batch.payoutPeriodKey,
        totalAmountIdr: result.batch.totalAmountIdr,
        entryCount: result.batch.entryCount,
        status: result.batch.status,
        transferReference: result.batch.transferReference,
        paidAt: result.batch.paidAt !== null ? new Date(result.batch.paidAt).toISOString() : null,
        paidByUserId: result.batch.paidByUserId,
        statusReason: result.batch.statusReason,
        version: result.batch.version,
        createdAt: new Date(result.batch.createdAt).toISOString(),
        updatedAt: new Date(result.batch.updatedAt).toISOString(),
      },
      paidEntryCount: result.paidEntryCount,
      auditId: result.audit.id,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapConsoleAffiliateErrorToResponse(err, authz.ctx.requestId);
  }
}

export const POST: APIRoute = ({ params, request }) =>
  handleConsoleMarkPayoutBatchPaidRequest(
    params.batchId ?? "",
    request,
    resolveConsoleAffiliatesRuntimeEnv(env as unknown as Record<string, unknown>),
  );

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleMarkPayoutBatchPaidRequest(
    params.batchId ?? "",
    request,
    resolveConsoleAffiliatesRuntimeEnv(env as unknown as Record<string, unknown>),
  );

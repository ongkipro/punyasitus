import { env } from "cloudflare:workers";
import {
  agencyErrorResponse,
  agencyJsonResponse,
  authorizeAgencyRequest,
  createAgencyRequestId,
  parseStrictAgencyJsonBody,
  type AgencyHandlerOptions,
  type AgencyRuntimeEnv,
} from "@punyasitus/auth/agency/index";
import {
  DEFAULT_PRODUCTION_SETTLEMENT_POLICY,
  type AdviceSettlementPolicy,
} from "@punyasitus/core/billing/index";
import {
  getAgencyClientBySelector,
  markAgencyClientFirstSettled,
} from "@punyasitus/db/agencies/index";
import {
  getLatestReconcilableAttemptForObligation,
  getReconcilableAttemptById,
} from "@punyasitus/db/billing/index";
import { appendPlatformAudit } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import type { AutoLarisBillingClient } from "../../../../../../../packages/integrations/src/autolaris/index.ts";
import {
  reconcilePaymentAttemptViaAdvice,
} from "../../../../worker/queues/billing/advice-reconciliation.ts";
import {
  mapAgencyErrorToResponse,
  resolveAgencyAutoLarisClient,
  resolveAgencyRuntimeEnv,
  resolveAuthorizedTargetMembership,
} from "../_shared.ts";

/**
 * `POST /api/agency/billing/reconcile` — Server-verified AutoLaris Advice reconciliation
 * for a linked agency client's payment attempt (REQ-083, REQ-057, REQ-081).
 *
 * Security invariants:
 * - Requires mandatory TOTP 2FA, CSRF/Origin, active agency membership, and `agency:billing:write` RBAC.
 * - NEVER trusts client-supplied payment proof, status, amount, or paid flags!
 * - Verifies strictly via server-side AutoLaris Advice port (`reconcilePaymentAttemptViaAdvice`).
 * - Cross-agency or unknown client tenant -> neutral `404 NOT_FOUND`.
 * - Enforces a 15-second per-attempt cooldown (`429 RATE_LIMITED` + `Retry-After`) so user polling
 *   cannot hammer AutoLaris Advice.
 * - User-triggered polls NEVER exhaust `maxPolls` into `review` (preserves scheduled reconciler budget).
 * - Appends explicit `platform_audit` with the ACTUAL agency user ID & `agencyRole` (never `"system"`).
 */

export const AGENCY_RECONCILE_COOLDOWN_MS = 15_000 as const;

const RECONCILE_ALLOWED_KEYS = new Set([
  "agencyId",
  "tenantId",
  "attemptId",
  "obligationId",
]);

export interface AgencyBillingReconcileOptions extends AgencyHandlerOptions {
  readonly autolarisClient?: AutoLarisBillingClient | null;
  readonly autolarisFetch?: typeof fetch;
  readonly settlementPolicy?: AdviceSettlementPolicy;
}

export async function handleAgencyBillingReconcileRequest(
  request: Request,
  runtimeEnv: AgencyRuntimeEnv,
  options: AgencyBillingReconcileOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createAgencyRequestId();
  const url = new URL(request.url);
  const queryAgencyId = url.searchParams.get("agencyId");

  const authz = await authorizeAgencyRequest(
    request,
    runtimeEnv,
    {
      action: "agency.billing.reconcile",
      requestedAgencyId: queryAgencyId,
      requireAgencyMembership: true,
      requiredPermission: "agency:billing:write",
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "POST") {
    return agencyErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode POST untuk rekonsiliasi status pembayaran agensi.",
      authz.ctx.requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const parsed = await parseStrictAgencyJsonBody(
    request,
    authz.ctx.requestId,
    RECONCILE_ALLOWED_KEYS,
    { rejectForbiddenBillingFields: true },
  );
  if (!parsed.ok) return parsed.response;

  const bodyAgencyId =
    typeof parsed.body.agencyId === "string" && parsed.body.agencyId.trim().length > 0
      ? parsed.body.agencyId.trim()
      : null;
  const resolvedTarget = resolveAuthorizedTargetMembership(
    authz.ctx.actor,
    bodyAgencyId,
    "agency:billing:write",
    authz.ctx.requestId,
  );
  if (!resolvedTarget.ok) return resolvedTarget.response;
  const targetAgency = resolvedTarget.membership.agency;

  const tenantSelector =
    typeof parsed.body.tenantId === "string" ? parsed.body.tenantId.trim() : "";
  const attemptId =
    typeof parsed.body.attemptId === "string" && parsed.body.attemptId.trim().length > 0
      ? parsed.body.attemptId.trim()
      : undefined;
  const obligationId =
    typeof parsed.body.obligationId === "string" && parsed.body.obligationId.trim().length > 0
      ? parsed.body.obligationId.trim()
      : undefined;

  if (!tenantSelector || (!attemptId && !obligationId)) {
    return agencyErrorResponse(
      422,
      "VALIDATION_ERROR",
      "tenantId dan salah satu dari attemptId atau obligationId wajib diisi.",
      authz.ctx.requestId,
    );
  }

  try {
    // Strictly verify client belongs to this agency -> neutral 404 otherwise!
    const client = await getAgencyClientBySelector(
      authz.ctx.platformDb,
      targetAgency.id,
      tenantSelector,
      authz.ctx.nowMs,
      runtimeEnv.SAAS_ZONE,
    );
    if (!client) {
      return agencyErrorResponse(404, "NOT_FOUND", "Situs klien tidak ditemukan.", authz.ctx.requestId);
    }

    // Inspect attempt for per-attempt cooldown (15s) and non-exhausting poll ceiling
    const existingAttempt = attemptId
      ? await getReconcilableAttemptById(authz.ctx.platformDb, attemptId, {
          tenantId: client.tenantId,
        })
      : obligationId
        ? await getLatestReconcilableAttemptForObligation(authz.ctx.platformDb, obligationId, {
            tenantId: client.tenantId,
          })
        : null;

    if (!existingAttempt) {
      return agencyErrorResponse(
        404,
        "NOT_FOUND",
        "Percobaan pembayaran tidak ditemukan.",
        authz.ctx.requestId,
      );
    }

    if (
      existingAttempt.lifecycleState !== "paid" &&
      existingAttempt.lastPolledAtMs !== null &&
      authz.ctx.nowMs - existingAttempt.lastPolledAtMs < AGENCY_RECONCILE_COOLDOWN_MS
    ) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil(
          (AGENCY_RECONCILE_COOLDOWN_MS - (authz.ctx.nowMs - existingAttempt.lastPolledAtMs)) /
            1000,
        ),
      );
      return agencyErrorResponse(
        429,
        "RATE_LIMITED",
        `Harap tunggu ${retryAfterSec} detik sebelum memeriksa ulang status pembayaran ini.`,
        authz.ctx.requestId,
        { retryAfterSeconds: retryAfterSec },
        { "Retry-After": String(retryAfterSec) },
      );
    }

    const autolarisClient = resolveAgencyAutoLarisClient(
      runtimeEnv,
      options.autolarisClient,
      options.autolarisFetch,
    );

    // Ensure user-triggered polling NEVER exhausts `maxPolls` into `review`
    const nonExhaustingMaxPolls = Math.min(
      100,
      Math.max(existingAttempt.maxPolls, existingAttempt.pollCount + 3),
    );
    const previousPollCount = existingAttempt.pollCount;

    const outcome = await reconcilePaymentAttemptViaAdvice({
      db: authz.ctx.platformDb,
      autolarisClient,
      tenantId: client.tenantId,
      attemptId: existingAttempt.attemptId,
      obligationId: existingAttempt.obligationId,
      settlementPolicy: options.settlementPolicy ?? DEFAULT_PRODUCTION_SETTLEMENT_POLICY,
      actorUserId: authz.ctx.actor.userId,
      actorRole: "system",
      maxPolls: nonExhaustingMaxPolls,
      requestId: authz.ctx.requestId,
      nowMs: authz.ctx.nowMs,
      mediaBucket: runtimeEnv.MEDIA_BUCKET ?? null,
      emailPort: options.emailPort,
      cloudflareEmailBinding: runtimeEnv.EMAIL ?? null,
      platformDomain: runtimeEnv.PLATFORM_DOMAIN,
    });

    // Preserve scheduled reconciler's poll_count budget while persisting `last_polled_at` for the 15s cooldown!
    if (outcome.outcome === "pending" || outcome.outcome === "review") {
      await authz.ctx.platformDb
        .prepare(
          `INSERT INTO billing_reconciliation_leases (
             payment_attempt_id, obligation_id, tenant_id,
             poll_count, max_polls, next_poll_after, last_polled_at,
             last_provider_rc, last_provider_status, last_outcome, updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(payment_attempt_id) DO UPDATE SET
             poll_count = excluded.poll_count,
             last_polled_at = excluded.last_polled_at,
             last_provider_rc = excluded.last_provider_rc,
             last_provider_status = excluded.last_provider_status,
             last_outcome = excluded.last_outcome,
             updated_at = excluded.updated_at`,
        )
        .bind(
          existingAttempt.attemptId,
          existingAttempt.obligationId,
          client.tenantId,
          previousPollCount,
          existingAttempt.maxPolls,
          authz.ctx.nowMs + AGENCY_RECONCILE_COOLDOWN_MS,
          authz.ctx.nowMs,
          outcome.providerRc,
          outcome.providerStatus,
          outcome.outcome,
          authz.ctx.nowMs,
        )
        .run();
    }

    if (outcome.outcome === "settled" || outcome.outcome === "already_settled") {
      await markAgencyClientFirstSettled(authz.ctx.platformDb, {
        agencyId: targetAgency.id,
        tenantId: client.tenantId,
        settledAtMs: authz.ctx.nowMs,
        nowMs: authz.ctx.nowMs,
      });
    }

    // Explicit agency-attributed audit log using the ACTUAL agency member role on the target agency (never "system")
    const actualRole = resolvedTarget.membership.role;
    await appendPlatformAudit(authz.ctx.platformDb, {
      actorUserId: authz.ctx.actor.userId,
      actorRole: actualRole,
      action: "agency.billing.reconcile",
      targetType: "payment_attempt",
      targetId: outcome.attemptId,
      tenantId: client.tenantId,
      reason: `Agency member (${actualRole}) triggered server-verified Advice reconciliation`,
      requireReason: false,
      outcome: "success",
      requestId: authz.ctx.requestId,
      metadata: {
        agencyId: targetAgency.id,
        obligationId: outcome.obligationId,
        reconciliationOutcome: outcome.outcome,
        reasonCode: outcome.reasonCode,
        settlementId: outcome.settlementId,
        receiptNumber: outcome.receiptNumber ?? null,
      },
      createdAtMs: authz.ctx.nowMs,
    });

    return agencyJsonResponse(200, {
      success: true,
      reconciliation: {
        attemptId: outcome.attemptId,
        obligationId: outcome.obligationId,
        tenantId: outcome.tenantId,
        outcome: outcome.outcome,
        reasonCode: outcome.reasonCode,
        grantApplied: outcome.grantApplied,
        settlementId: outcome.settlementId,
        receiptId: outcome.receiptId ?? null,
        receiptNumber: outcome.receiptNumber ?? null,
        receiptPdfUrl: outcome.receiptId
          ? `/api/agency/billing/receipts/${encodeURIComponent(outcome.receiptId)}/pdf`
          : null,
      },
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapAgencyErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ request, locals }) =>
  handleAgencyBillingReconcileRequest(
    request,
    resolveAgencyRuntimeEnv(env as unknown as Record<string, unknown>),
    {
      session: locals.authSession
        ? { id: locals.authSession.id, userId: locals.authSession.userId }
        : null,
      user: locals.authUser
        ? { id: locals.authUser.id, email: locals.authUser.email, name: locals.authUser.name }
        : null,
    },
  );

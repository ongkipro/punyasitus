import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  parseStrictConsoleJsonBody,
} from "@punyasitus/auth/platform/index";
import { BillingValidationError } from "@punyasitus/core/billing/index";
import { validateOperatorReason } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import { reconcilePaymentAttemptViaAdvice } from "../../../../worker/queues/billing/advice-reconciliation.ts";
import {
  mapConsoleBillingErrorToResponse,
  resolveConsoleAutoLarisClient,
  resolveConsoleBillingRuntimeEnv,
  type ConsoleBillingHandlerOptions,
  type ConsoleBillingRuntimeEnv,
} from "./_shared.ts";

/**
 * `POST /api/console/billing/recheck` — Audited platform operator Advice recheck for
 * a specific `attemptId` or `obligationId` (REQ-057, REQ-058; PLAN §16.3, §16.4; TASK-056).
 *
 * Security & correctness invariants:
 * - Strictly `console.punyasitus.com` host ONLY (404 elsewhere).
 * - Active platform operator + mandatory 2FA + recent 2FA step-up (`requireStepUp: true`).
 * - CSRF / Origin check enforced.
 * - Mandatory 10-500 char scrubbed audit reason.
 * - STRICT allowlist of request keys (`attemptId`, `obligationId`, `tenantId`, `reason`):
 *   ZERO arbitrary "mark paid" toggle or manual settlement bypass!
 * - Atomic `platform_audit` persistence: if audit insert fails, ALL billing state changes roll back!
 */

const ALLOWED_RECHECK_BODY_KEYS: ReadonlySet<string> = new Set([
  "attemptId",
  "obligationId",
  "tenantId",
  "reason",
]);

export async function handleConsoleBillingRecheckRequest(
  request: Request,
  runtimeEnv: ConsoleBillingRuntimeEnv,
  options: ConsoleBillingHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  if (method !== "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.billing.recheck.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode POST untuk menjalankan Advice recheck.",
      authz.ctx.requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.billing.advice_recheck", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const parsed = await parseStrictConsoleJsonBody(
    request,
    authz.ctx.requestId,
    ALLOWED_RECHECK_BODY_KEYS,
  );
  if (!parsed.ok) return parsed.response;

  try {
    const validatedReason = validateOperatorReason(parsed.body.reason);
    const attemptId =
      typeof parsed.body.attemptId === "string" && parsed.body.attemptId.trim().length > 0
        ? parsed.body.attemptId.trim()
        : undefined;
    const obligationId =
      typeof parsed.body.obligationId === "string" && parsed.body.obligationId.trim().length > 0
        ? parsed.body.obligationId.trim()
        : undefined;
    const tenantId =
      typeof parsed.body.tenantId === "string" && parsed.body.tenantId.trim().length > 0
        ? parsed.body.tenantId.trim()
        : undefined;

    if (!attemptId && !obligationId) {
      throw new BillingValidationError(
        "MISSING_TARGET_ID",
        "attemptId atau obligationId wajib disertakan untuk Advice recheck.",
        [
          {
            field: "attemptId",
            code: "MISSING_TARGET_ID",
            message: "Provide attemptId or obligationId.",
          },
        ],
      );
    }

    const autolarisClient = resolveConsoleAutoLarisClient(runtimeEnv, options);
    const result = await reconcilePaymentAttemptViaAdvice({
      db: authz.ctx.platformDb,
      autolarisClient,
      attemptId,
      obligationId,
      tenantId,
      settlementPolicy: options.settlementPolicy,
      actorUserId: authz.ctx.actor.userId,
      actorRole: "platform_operator",
      reason: validatedReason,
      requestId: authz.ctx.requestId,
      nowMs: authz.ctx.nowMs,
      logger: options.logger,
    });

    return consoleJsonResponse(200, {
      success: true,
      recheck: {
        attemptId: result.attemptId,
        obligationId: result.obligationId,
        tenantId: result.tenantId,
        outcome: result.outcome,
        reasonCode: result.reasonCode,
        providerCalled: result.providerCalled,
        providerRc: result.providerRc,
        providerStatus: result.providerStatus,
        grantApplied: result.grantApplied,
        alreadyGranted: result.alreadyGranted,
        settlementId: result.settlementId,
        grantId: result.grantId,
        operatorHoldPreserved: result.operatorHoldPreserved,
        deferredTerminalState: result.deferredTerminalState,
        policyProfile: result.policyProfile,
        policyVersion: result.policyVersion,
      },
      auditId: result.auditId,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapConsoleBillingErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ request }) =>
  handleConsoleBillingRecheckRequest(
    request,
    resolveConsoleBillingRuntimeEnv(env as unknown as Record<string, unknown>),
  );

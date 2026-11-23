import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  parseStrictConsoleJsonBody,
} from "@punyasitus/auth/platform/index";
import { BillingValidationError } from "@punyasitus/core/billing/index";
import { recordAuditedBillingRefund } from "@punyasitus/db/billing/index";
import type { APIRoute } from "astro";
import {
  mapConsoleBillingErrorToResponse,
  resolveConsoleBillingRuntimeEnv,
  type ConsoleBillingHandlerOptions,
  type ConsoleBillingRuntimeEnv,
} from "./_shared.ts";

/**
 * `POST /api/console/billing/refund` — Audited manual refund recording for duplicate,
 * mistaken, or post-purge late payments (`DEC-035 C6`, `REQ-057`, `REQ-058`; TASK-056).
 *
 * Security & correctness invariants:
 * - Strictly `console.punyasitus.com` host ONLY (404 elsewhere).
 * - Active platform operator + mandatory 2FA + recent 2FA step-up (`requireStepUp: true`).
 * - CSRF / Origin check enforced.
 * - Mandatory 10-500 char scrubbed audit reason.
 * - STRICT allowlist of keys: NEVER exposes an arbitrary "mark paid" toggle or mutates
 *   entitlement grants!
 * - Atomic `platform_audit` persistence: if audit insert fails, refund recording rolls back!
 */

const ALLOWED_REFUND_BODY_KEYS: ReadonlySet<string> = new Set([
  "obligationId",
  "paymentAttemptId",
  "tenantId",
  "refundKind",
  "amountIdr",
  "externalReference",
  "reason",
]);

export async function handleConsoleBillingRefundRequest(
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
      { action: "console.billing.refund.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode POST untuk mencatat pengembalian dana manual.",
      authz.ctx.requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.billing.refund_record", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const parsed = await parseStrictConsoleJsonBody(
    request,
    authz.ctx.requestId,
    ALLOWED_REFUND_BODY_KEYS,
  );
  if (!parsed.ok) return parsed.response;

  try {
    const obligationId =
      typeof parsed.body.obligationId === "string" ? parsed.body.obligationId.trim() : "";
    const paymentAttemptId =
      typeof parsed.body.paymentAttemptId === "string" && parsed.body.paymentAttemptId.trim().length > 0
        ? parsed.body.paymentAttemptId.trim()
        : null;
    const tenantId =
      typeof parsed.body.tenantId === "string" && parsed.body.tenantId.trim().length > 0
        ? parsed.body.tenantId.trim()
        : null;
    const refundKind =
      typeof parsed.body.refundKind === "string" ? parsed.body.refundKind.trim() : "";
    const amountIdr =
      typeof parsed.body.amountIdr === "number" ? parsed.body.amountIdr : Number.NaN;
    const externalReference =
      typeof parsed.body.externalReference === "string" && parsed.body.externalReference.trim().length > 0
        ? parsed.body.externalReference.trim()
        : null;
    const reason = typeof parsed.body.reason === "string" ? parsed.body.reason : "";

    if (!obligationId) {
      throw new BillingValidationError(
        "INVALID_OBLIGATION_ID",
        "obligationId wajib diisi.",
        [{ field: "obligationId", code: "INVALID_OBLIGATION_ID", message: "obligationId is required." }],
      );
    }

    const recorded = await recordAuditedBillingRefund(authz.ctx.platformDb, {
      obligationId,
      paymentAttemptId,
      tenantId,
      refundKind,
      amountIdr,
      externalReference,
      reason,
      actorUserId: authz.ctx.actor.userId,
      requestId: authz.ctx.requestId,
      nowMs: authz.ctx.nowMs,
    });

    return consoleJsonResponse(201, {
      success: true,
      refund: recorded.refund,
      auditId: recorded.auditId,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapConsoleBillingErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ request }) =>
  handleConsoleBillingRefundRequest(
    request,
    resolveConsoleBillingRuntimeEnv(env as unknown as Record<string, unknown>),
  );

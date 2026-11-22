import { getTenantPaymentAttemptById } from "@punyasitus/db/billing/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBillingRequest,
  billingErrorResponse,
  billingJsonResponse,
  createRequestId,
  formatAttemptInstruction,
  mapBillingDomainErrorToResponse,
  type TenantBillingHandlerOptions,
  type TenantBillingRuntimeEnv,
} from "../_shared.ts";
import { buildBillingRuntimeEnv } from "../index.ts";

/**
 * Tenant Owner-Only Single Payment Attempt Detail endpoint:
 * - `GET /api/tenants/:tenantId/billing/attempts/:attemptId`
 */

export async function handleTenantBillingAttemptDetailRequest(
  tenantId: string,
  attemptId: string,
  request: Request,
  runtimeEnv: TenantBillingRuntimeEnv,
  options: TenantBillingHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  const auth = await authorizeTenantBillingRequest(
    tenantId,
    request,
    runtimeEnv,
    "billing:read",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  if (method !== "GET") {
    return billingErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk detail percobaan pembayaran.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const cleanAttemptId = attemptId.trim();
  if (!cleanAttemptId) {
    return billingErrorResponse(404, "NOT_FOUND", "Percobaan pembayaran tidak ditemukan.", requestId);
  }

  try {
    const attempt = await getTenantPaymentAttemptById(
      auth.ctx.platformDb,
      auth.ctx.member.tenantId,
      cleanAttemptId,
    );
    if (!attempt) {
      return billingErrorResponse(
        404,
        "NOT_FOUND",
        "Percobaan pembayaran tidak ditemukan.",
        requestId,
      );
    }

    return billingJsonResponse(200, formatAttemptInstruction(attempt));
  } catch (err) {
    return mapBillingDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantBillingAttemptDetailRequest(
    params.tenantId ?? "",
    params.attemptId ?? "",
    request,
    buildBillingRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );

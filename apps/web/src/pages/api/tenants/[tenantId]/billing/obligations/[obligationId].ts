import { getTenantObligationById } from "@punyasitus/db/billing/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBillingRequest,
  billingErrorResponse,
  billingJsonResponse,
  createRequestId,
  formatAttemptInstruction,
  formatObligationSummary,
  mapBillingDomainErrorToResponse,
  type TenantBillingHandlerOptions,
  type TenantBillingRuntimeEnv,
} from "../_shared.ts";
import { buildBillingRuntimeEnv } from "../index.ts";

/**
 * Tenant Owner-Only Single Obligation Detail endpoint:
 * - `GET /api/tenants/:tenantId/billing/obligations/:obligationId`
 *
 * Strictly tenant-scoped: cross-tenant or unknown obligation IDs return neutral `404 NOT_FOUND`.
 */

export async function handleTenantBillingObligationDetailRequest(
  tenantId: string,
  obligationId: string,
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
      "Metode HTTP tidak diizinkan untuk detail kewajiban langganan.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const cleanObligationId = obligationId.trim();
  if (!cleanObligationId) {
    return billingErrorResponse(404, "NOT_FOUND", "Tagihan langganan tidak ditemukan.", requestId);
  }

  try {
    const detail = await getTenantObligationById(
      auth.ctx.platformDb,
      auth.ctx.member.tenantId,
      cleanObligationId,
    );
    if (!detail) {
      return billingErrorResponse(404, "NOT_FOUND", "Tagihan langganan tidak ditemukan.", requestId);
    }

    return billingJsonResponse(200, {
      obligation: formatObligationSummary(detail.obligation),
      snapshot: detail.obligation.snapshot,
      attempt: detail.latestAttempt ? formatAttemptInstruction(detail.latestAttempt) : null,
    });
  } catch (err) {
    return mapBillingDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantBillingObligationDetailRequest(
    params.tenantId ?? "",
    params.obligationId ?? "",
    request,
    buildBillingRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );

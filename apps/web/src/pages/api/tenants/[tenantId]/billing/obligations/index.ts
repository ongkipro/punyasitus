import { listTenantObligations } from "@punyasitus/db/billing/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBillingRequest,
  billingErrorResponse,
  billingJsonResponse,
  createDurableBillingObligationAndInstruction,
  createRequestId,
  extractValidatedIdempotencyKey,
  formatAttemptInstruction,
  formatObligationSummary,
  mapBillingDomainErrorToResponse,
  parseStrictBillingJsonBody,
  type TenantBillingHandlerOptions,
  type TenantBillingRuntimeEnv,
} from "../_shared.ts";
import { buildBillingRuntimeEnv } from "../index.ts";

/**
 * Tenant Owner-Only Subscription Obligations endpoint:
 * - `GET  /api/tenants/:tenantId/billing/obligations` -> list scoped obligations (`billing:read`)
 * - `POST /api/tenants/:tenantId/billing/obligations` -> create/replay open obligation + AutoLaris QRIS/VA instruction (`billing:pay`)
 *
 * TASK-055 (`REQ-056`, PLAN §16 & §17).
 */

const OBLIGATION_CREATE_ALLOWED_KEYS = new Set([
  "plan",
  "channelCode",
  "channelKind",
  "couponCode",
]);

export async function handleTenantBillingObligationsRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantBillingRuntimeEnv,
  options: TenantBillingHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET" && method !== "POST") {
    const auth = await authorizeTenantBillingRequest(
      tenantId,
      request,
      runtimeEnv,
      "billing:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return billingErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint kewajiban langganan.",
      requestId,
      undefined,
      { Allow: "GET, POST" },
    );
  }

  const requiredPermission = method === "GET" ? "billing:read" : "billing:pay";
  const auth = await authorizeTenantBillingRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  try {
    if (method === "GET") {
      const obligations = await listTenantObligations(
        auth.ctx.platformDb,
        auth.ctx.member.tenantId,
      );
      return billingJsonResponse(200, {
        items: obligations.map(formatObligationSummary),
      });
    }

    const parsedBody = await parseStrictBillingJsonBody(
      request,
      OBLIGATION_CREATE_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const idempotency = extractValidatedIdempotencyKey(request, undefined, requestId, {
      allowBodyFallback: false,
    });
    if (!idempotency.ok) {
      return idempotency.response;
    }

    const result = await createDurableBillingObligationAndInstruction(
      auth.ctx,
      runtimeEnv,
      {
        plan: parsedBody.body.plan,
        channelCode: parsedBody.body.channelCode,
        channelKind: parsedBody.body.channelKind,
        couponCode: parsedBody.body.couponCode,
        idempotencyKey: idempotency.idempotencyKey,
      },
      options,
    );

    return billingJsonResponse(result.status, {
      obligation: formatObligationSummary(result.obligation),
      snapshot: result.obligation.snapshot,
      attempt: formatAttemptInstruction(result.attempt),
      replayed: result.replayed,
    });
  } catch (err) {
    return mapBillingDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantBillingObligationsRequest(params.tenantId ?? "", request, buildBillingRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });

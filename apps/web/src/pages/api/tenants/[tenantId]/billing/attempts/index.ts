import type { APIRoute } from "astro";
import {
  authorizeTenantBillingRequest,
  billingErrorResponse,
  billingJsonResponse,
  createDurableBillingObligationAndInstruction,
  createRequestId,
  extractValidatedIdempotencyKey,
  formatAttemptInstruction,
  mapBillingDomainErrorToResponse,
  parseStrictBillingJsonBody,
  type TenantBillingHandlerOptions,
  type TenantBillingRuntimeEnv,
} from "../_shared.ts";
import { buildBillingRuntimeEnv } from "../index.ts";

/**
 * Tenant Owner-Only Checkout Attempt Creation endpoint (PLAN §16.4 OpenAPI contract):
 * - `POST /api/tenants/:tenantId/billing/attempts`
 *
 * Delegates directly to the same durable obligation & AutoLaris instruction engine
 * as `/obligations`, returning `CheckoutInstruction`.
 */

const ATTEMPT_CREATE_ALLOWED_KEYS = new Set([
  "plan",
  "channelKind",
  "channelCode",
  "couponCode",
  "idempotencyKey",
]);

export async function handleTenantBillingAttemptsRequest(
  tenantId: string,
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
    "billing:pay",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  if (method !== "POST") {
    return billingErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint percobaan pembayaran.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  try {
    const parsedBody = await parseStrictBillingJsonBody(
      request,
      ATTEMPT_CREATE_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const idempotency = extractValidatedIdempotencyKey(
      request,
      parsedBody.body.idempotencyKey,
      requestId,
      { allowBodyFallback: true },
    );
    if (!idempotency.ok) {
      return idempotency.response;
    }

    const result = await createDurableBillingObligationAndInstruction(
      auth.ctx,
      runtimeEnv,
      {
        plan: parsedBody.body.plan,
        channelKind: parsedBody.body.channelKind,
        channelCode: parsedBody.body.channelCode,
        couponCode: parsedBody.body.couponCode,
        idempotencyKey: idempotency.idempotencyKey,
      },
      options,
    );

    return billingJsonResponse(result.status, formatAttemptInstruction(result.attempt));
  } catch (err) {
    return mapBillingDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantBillingAttemptsRequest(params.tenantId ?? "", request, buildBillingRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });

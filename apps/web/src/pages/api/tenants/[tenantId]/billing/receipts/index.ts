import { listTenantPaymentReceipts } from "@punyasitus/db/billing/receipts/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantReceiptRequest,
  buildTenantReceiptRuntimeEnv,
  createReceiptRequestId,
  formatReceiptSummaryDto,
  receiptErrorResponse,
  receiptJsonResponse,
  type TenantReceiptHandlerOptions,
  type TenantReceiptRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/tenants/[tenantId]/billing/receipts` — Lists numbered payment receipts and
 * linked credit notes for the authenticated website payer (REQ-081, REQ-058; TASK-081).
 */

export async function handleTenantBillingReceiptsListRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantReceiptRuntimeEnv,
  options: TenantReceiptHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createReceiptRequestId();

  const auth = await authorizeTenantReceiptRequest(tenantId, request, runtimeEnv, {
    ...options,
    requestId,
  });
  if (!auth.ok) {
    return auth.response;
  }

  if (method !== "GET") {
    return receiptErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan metode GET untuk melihat daftar kuitansi pembayaran.",
      auth.ctx.requestId,
      { Allow: "GET" },
    );
  }

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const parsedLimit = rawLimit !== null ? Number.parseInt(rawLimit, 10) : undefined;
  const limit =
    typeof parsedLimit === "number" && Number.isFinite(parsedLimit) ? parsedLimit : undefined;

  const receipts = await listTenantPaymentReceipts(auth.ctx.platformDb, auth.ctx.tenantId, {
    limit,
  });

  return receiptJsonResponse(200, {
    tenantId: auth.ctx.tenantId,
    payerKind: auth.ctx.payerKind,
    receipts: receipts.map((r) =>
      formatReceiptSummaryDto(
        r,
        `/api/tenants/${encodeURIComponent(auth.ctx.tenantId)}/billing/receipts/${encodeURIComponent(r.id)}/pdf`,
      ),
    ),
    requestId: auth.ctx.requestId,
  });
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantBillingReceiptsListRequest(
    params.tenantId ?? "",
    request,
    buildTenantReceiptRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );

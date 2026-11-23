import {
  listAgencyPaymentReceipts,
  type PaymentReceiptRecord,
} from "@punyasitus/db/billing/receipts/index";
import type { APIRoute } from "astro";
import {
  authorizeAgencyReceiptRequest,
  buildAgencyReceiptRuntimeEnv,
  createReceiptRequestId,
  formatReceiptSummaryDto,
  receiptErrorResponse,
  receiptJsonResponse,
  type AgencyReceiptHandlerOptions,
  type AgencyReceiptRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/agency/receipts` — Lists numbered payment receipts and linked credit notes
 * owned by the authenticated agency (REQ-081, REQ-083; TASK-081).
 */

export async function handleAgencyReceiptsListRequest(
  request: Request,
  runtimeEnv: AgencyReceiptRuntimeEnv,
  options: AgencyReceiptHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createReceiptRequestId();

  const auth = await authorizeAgencyReceiptRequest(request, runtimeEnv, {
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
      "Gunakan metode GET untuk melihat daftar kuitansi agensi.",
      auth.ctx.requestId,
      { Allow: "GET" },
    );
  }

  const url = new URL(request.url);
  const requestedAgencyId = url.searchParams.get("agencyId")?.trim() || null;
  if (requestedAgencyId && !auth.ctx.agencyIds.has(requestedAgencyId)) {
    return receiptErrorResponse(
      404,
      "NOT_FOUND",
      "Agensi tidak ditemukan.",
      auth.ctx.requestId,
    );
  }

  const targetAgencyIds = requestedAgencyId
    ? [requestedAgencyId]
    : [...auth.ctx.agencyIds];

  const tenantFilter = url.searchParams.get("tenantId")?.trim() || undefined;
  if (tenantFilter) {
    const tenantRow = await auth.ctx.platformDb
      .prepare("SELECT id, agency_id FROM tenants WHERE id = ? LIMIT 1")
      .bind(tenantFilter)
      .first<{ readonly id: string; readonly agency_id: string | null }>();
    if (!tenantRow || !tenantRow.agency_id || !targetAgencyIds.includes(tenantRow.agency_id)) {
      return receiptErrorResponse(
        404,
        "NOT_FOUND",
        "Tenant agensi tidak ditemukan.",
        auth.ctx.requestId,
      );
    }
  }

  const rawLimit = url.searchParams.get("limit");
  const parsedLimit = rawLimit !== null ? Number.parseInt(rawLimit, 10) : undefined;
  const limit =
    typeof parsedLimit === "number" && Number.isFinite(parsedLimit) ? parsedLimit : undefined;

  const collected: PaymentReceiptRecord[] = [];
  for (const agencyId of targetAgencyIds) {
    const rows = await listAgencyPaymentReceipts(auth.ctx.platformDb, agencyId, {
      tenantId: tenantFilter,
      limit,
    });
    collected.push(...rows);
  }

  collected.sort(
    (a, b) =>
      b.issuedAtMs - a.issuedAtMs || b.receiptNumber.localeCompare(a.receiptNumber),
  );

  const bounded = limit ? collected.slice(0, Math.max(1, Math.min(100, limit))) : collected;

  return receiptJsonResponse(200, {
    agencyId: requestedAgencyId ?? auth.ctx.primaryAgencyId,
    receipts: bounded.map((r) =>
      formatReceiptSummaryDto(r, `/api/agency/receipts/${encodeURIComponent(r.id)}/pdf`),
    ),
    requestId: auth.ctx.requestId,
  });
}

export const ALL: APIRoute = ({ request, locals }) =>
  handleAgencyReceiptsListRequest(request, buildAgencyReceiptRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });

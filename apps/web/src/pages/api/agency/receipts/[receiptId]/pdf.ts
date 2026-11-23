import { BillingConflictError } from "@punyasitus/core/billing/index";
import { findPaymentReceiptById } from "@punyasitus/db/billing/receipts/index";
import type { APIRoute } from "astro";
import { loadVerifiedReceiptPdfFromR2 } from "../../../../../worker/queues/billing/receipt-delivery.ts";
import {
  authorizeAgencyReceiptRequest,
  buildAgencyReceiptRuntimeEnv,
  createReceiptRequestId,
  receiptErrorResponse,
  receiptPdfDownloadResponse,
  type AgencyReceiptHandlerOptions,
  type AgencyReceiptRuntimeEnv,
} from "../_shared.ts";

/**
 * `GET /api/agency/receipts/[receiptId]/pdf` — Streams immutable SHA-256-verified
 * PDF receipt/credit-note bytes ONLY for authenticated staff/owners of the owning `agency_id`.
 */

export async function handleAgencyReceiptPdfRequest(
  receiptId: string,
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
      "Gunakan metode GET untuk mengunduh PDF kuitansi agensi.",
      auth.ctx.requestId,
      { Allow: "GET" },
    );
  }

  if (!runtimeEnv.MEDIA_BUCKET) {
    return receiptErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan dokumen kuitansi sementara tidak tersedia.",
      auth.ctx.requestId,
      { "Retry-After": "60" },
    );
  }

  try {
    const receipt = await findPaymentReceiptById(auth.ctx.platformDb, receiptId);
    if (!receipt || !receipt.agencyId || !auth.ctx.agencyIds.has(receipt.agencyId)) {
      return receiptErrorResponse(
        404,
        "NOT_FOUND",
        "Dokumen kuitansi tidak ditemukan.",
        auth.ctx.requestId,
      );
    }

    const pdfBytes = await loadVerifiedReceiptPdfFromR2(runtimeEnv.MEDIA_BUCKET, receipt);
    if (!pdfBytes) {
      return receiptErrorResponse(
        404,
        "NOT_FOUND",
        "Berkas PDF kuitansi tidak ditemukan di penyimpanan.",
        auth.ctx.requestId,
      );
    }

    return receiptPdfDownloadResponse(receipt, pdfBytes);
  } catch (err) {
    if (err instanceof BillingConflictError) {
      return receiptErrorResponse(409, "CONFLICT", err.message, auth.ctx.requestId);
    }
    return receiptErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal memuat dokumen PDF kuitansi sementara waktu.",
      auth.ctx.requestId,
      { "Retry-After": "60" },
    );
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleAgencyReceiptPdfRequest(
    params.receiptId ?? "",
    request,
    buildAgencyReceiptRuntimeEnv(),
    {
      session: locals.authSession
        ? { id: locals.authSession.id, userId: locals.authSession.userId }
        : null,
      user: locals.authUser
        ? { id: locals.authUser.id, email: locals.authUser.email, name: locals.authUser.name }
        : null,
    },
  );

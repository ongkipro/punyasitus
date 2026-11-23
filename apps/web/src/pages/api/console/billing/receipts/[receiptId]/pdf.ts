import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  createConsoleRequestId,
} from "@punyasitus/auth/platform/index";
import { findPaymentReceiptById } from "@punyasitus/db/billing/receipts/index";
import { appendPlatformAudit } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import { loadVerifiedReceiptPdfFromR2 } from "../../../../../../worker/queues/billing/receipt-delivery.ts";
import {
  mapConsoleBillingErrorToResponse,
  resolveConsoleBillingRuntimeEnv,
  type ConsoleBillingHandlerOptions,
  type ConsoleBillingRuntimeEnv,
} from "../../_shared.ts";

/**
 * `GET /api/console/billing/receipts/[receiptId]/pdf` — Scoped platform operator
 * receipt / credit-note PDF download (REQ-081, REQ-051, REQ-068; PLAN §13, §19.3; TASK-081).
 *
 * Security invariants:
 * - Strictly `console.punyasitus.com` host ONLY (neutral 404 elsewhere).
 * - Requires active platform operator + verified 2FA (`authorizeConsoleRequest`).
 * - Appends an immutable `platform_audit` row BEFORE returning PDF bytes; if audit fails,
 *   fails closed with 500 without serving the PDF.
 * - Verifies R2 PDF SHA-256 digest against `payment_receipts.pdf_sha256`.
 */

export async function handleConsoleBillingReceiptPdfRequest(
  receiptId: string,
  request: Request,
  runtimeEnv: ConsoleBillingRuntimeEnv,
  options: ConsoleBillingHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    {
      action:
        method === "GET"
          ? "console.billing.receipt_download"
          : "console.billing.receipt_download.method_check",
      requireStepUp: false,
      enforceCsrf: false,
    },
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  if (method !== "GET") {
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode GET untuk mengunduh PDF kuitansi.",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  if (!runtimeEnv.MEDIA_BUCKET) {
    return consoleErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan dokumen kuitansi sementara tidak tersedia.",
      authz.ctx.requestId,
      undefined,
      { "Retry-After": "60" },
    );
  }

  try {
    const receipt = await findPaymentReceiptById(authz.ctx.platformDb, receiptId);
    if (!receipt) {
      return consoleErrorResponse(
        404,
        "NOT_FOUND",
        "Dokumen kuitansi tidak ditemukan.",
        authz.ctx.requestId,
      );
    }

    const pdfBytes = await loadVerifiedReceiptPdfFromR2(runtimeEnv.MEDIA_BUCKET, receipt);
    if (!pdfBytes) {
      return consoleErrorResponse(
        404,
        "NOT_FOUND",
        "Berkas PDF kuitansi tidak ditemukan di penyimpanan.",
        authz.ctx.requestId,
      );
    }

    await appendPlatformAudit(authz.ctx.platformDb, {
      actorUserId: authz.ctx.actor.userId,
      actorRole: "platform_operator",
      action: "console.billing.receipt_downloaded",
      targetType: "payment_receipt",
      targetId: receipt.id,
      tenantId: receipt.tenantId,
      reason: "Operator platform mengunduh salinan PDF kuitansi/nota kredit",
      requireReason: false,
      outcome: "success",
      requestId: authz.ctx.requestId,
      metadata: {
        receiptNumber: receipt.receiptNumber,
        documentKind: receipt.documentKind,
        obligationId: receipt.obligationId,
        settlementId: receipt.settlementId,
        refundId: receipt.refundId,
      },
      createdAtMs: authz.ctx.nowMs,
    });

    const bodyCopy = new Uint8Array(pdfBytes.byteLength);
    bodyCopy.set(pdfBytes);

    return new Response(bodyCopy, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${receipt.receiptNumber}.pdf"`,
        "Content-Length": String(bodyCopy.byteLength),
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
        ETag: `"${receipt.pdfSha256}"`,
      },
    });
  } catch (err) {
    return mapConsoleBillingErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleBillingReceiptPdfRequest(
    params.receiptId ?? "",
    request,
    resolveConsoleBillingRuntimeEnv(env as unknown as Record<string, unknown>),
  );

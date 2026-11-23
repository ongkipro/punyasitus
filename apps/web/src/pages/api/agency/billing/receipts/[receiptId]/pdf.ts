import { env } from "cloudflare:workers";
import {
  agencyErrorResponse,
  authorizeAgencyRequest,
  canAgencyRolePerform,
  createAgencyRequestId,
  type AgencyHandlerOptions,
  type AgencyRuntimeEnv,
} from "@punyasitus/auth/agency/index";
import { BillingConflictError } from "@punyasitus/core/billing/index";
import { findPaymentReceiptById } from "@punyasitus/db/billing/receipts/index";
import type { APIRoute } from "astro";
import { loadVerifiedReceiptPdfFromR2 } from "../../../../../../worker/queues/billing/receipt-delivery.ts";
import { resolveAgencyRuntimeEnv } from "../../../_shared.ts";

/**
 * `GET /api/agency/billing/receipts/[receiptId]/pdf` — Mandatory-2FA-gated,
 * SHA-256-verified immutable PDF download strictly scoped to the agency's own receipts.
 * Cross-agency or direct-tenant receipts ALWAYS return neutral `404 NOT_FOUND`.
 */
export async function handleAgencyBillingReceiptPdfRequest(
  receiptId: string,
  request: Request,
  runtimeEnv: AgencyRuntimeEnv,
  options: AgencyHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createAgencyRequestId();
  const url = new URL(request.url);
  const requestedAgencyId = url.searchParams.get("agencyId");

  const authz = await authorizeAgencyRequest(
    request,
    runtimeEnv,
    {
      action: "agency.billing.receipt_pdf",
      requestedAgencyId,
      requireAgencyMembership: true,
      requiredPermission: "agency:billing:read",
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "GET") {
    return agencyErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode GET untuk mengunduh PDF kuitansi agensi.",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  if (!runtimeEnv.MEDIA_BUCKET) {
    return agencyErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan dokumen kuitansi sementara tidak tersedia.",
      authz.ctx.requestId,
      undefined,
      { "Retry-After": "60" },
    );
  }

  try {
    const ownedAgencyIds = requestedAgencyId
      ? new Set([authz.ctx.actor.activeAgency!.id])
      : new Set(
          authz.ctx.actor.memberships
            .filter(
              (m) =>
                m.agency.status !== "suspended" &&
                canAgencyRolePerform(m.role, "agency:billing:read"),
            )
            .map((m) => m.agency.id),
        );
    const receipt = await findPaymentReceiptById(authz.ctx.platformDb, receiptId.trim());
    if (!receipt || !receipt.agencyId || !ownedAgencyIds.has(receipt.agencyId)) {
      return agencyErrorResponse(
        404,
        "NOT_FOUND",
        "Dokumen kuitansi tidak ditemukan.",
        authz.ctx.requestId,
      );
    }

    const pdfBytes = await loadVerifiedReceiptPdfFromR2(runtimeEnv.MEDIA_BUCKET, receipt);
    if (!pdfBytes) {
      return agencyErrorResponse(
        404,
        "NOT_FOUND",
        "Berkas PDF kuitansi tidak ditemukan di penyimpanan.",
        authz.ctx.requestId,
      );
    }

    const bodyCopy = new Uint8Array(pdfBytes.byteLength);
    bodyCopy.set(pdfBytes);
    return new Response(bodyCopy, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${receipt.receiptNumber}.pdf"`,
        "Content-Length": String(pdfBytes.byteLength),
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
        "X-PunyaSitus-Receipt-Number": receipt.receiptNumber,
        "X-PunyaSitus-Receipt-Sha256": receipt.pdfSha256,
      },
    });
  } catch (err) {
    if (err instanceof BillingConflictError) {
      return agencyErrorResponse(409, "CONFLICT", err.message, authz.ctx.requestId);
    }
    return agencyErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal memuat dokumen PDF kuitansi.",
      authz.ctx.requestId,
      undefined,
      { "Retry-After": "60" },
    );
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleAgencyBillingReceiptPdfRequest(
    params.receiptId ?? "",
    request,
    resolveAgencyRuntimeEnv(env as unknown as Record<string, unknown>),
    {
      session: locals.authSession
        ? { id: locals.authSession.id, userId: locals.authSession.userId }
        : null,
      user: locals.authUser
        ? { id: locals.authUser.id, email: locals.authUser.email, name: locals.authUser.name }
        : null,
    },
  );

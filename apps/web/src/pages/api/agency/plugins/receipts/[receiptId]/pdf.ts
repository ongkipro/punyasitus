import { env } from "cloudflare:workers";
import {
  agencyErrorResponse,
  authorizeAgencyRequest,
  createAgencyRequestId,
  type AgencyHandlerOptions,
  type AgencyRuntimeEnv,
} from "@punyasitus/auth/agency/index";
import { generatePluginAddonReceiptPdf } from "@punyasitus/core/plugins/billing";
import { getPluginAddonReceiptById } from "@punyasitus/db/plugins/store/index";
import type { APIRoute } from "astro";
import {
  resolveAgencyRuntimeEnv,
  resolveAuthorizedTargetMembership,
} from "../../../_shared.ts";

/**
 * `GET /api/agency/plugins/receipts/:receiptId/pdf`
 * Downloads the immutable numbered PDF receipt (`INV-PLG-YYYY-NNNNNN`) strictly scoped
 * to the authorized target agency (REQ-098, REQ-081, REQ-083, TASK-098).
 */

export async function handleAgencyPluginReceiptPdfRequest(
  receiptId: string,
  request: Request,
  runtimeEnv: AgencyRuntimeEnv,
  options: AgencyHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createAgencyRequestId();
  const url = new URL(request.url);
  const queryAgencyId = url.searchParams.get("agencyId");

  const authz = await authorizeAgencyRequest(
    request,
    runtimeEnv,
    {
      action: "agency.plugins.receipt.pdf",
      requestedAgencyId: queryAgencyId,
      requireAgencyMembership: true,
      requiredPermission: "agency:billing:read",
      enforceCsrf: false,
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "GET") {
    return agencyErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode GET.",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const resolvedTarget = resolveAuthorizedTargetMembership(
    authz.ctx.actor,
    queryAgencyId,
    "agency:billing:read",
    authz.ctx.requestId,
  );
  if (!resolvedTarget.ok) return resolvedTarget.response;
  const targetAgency = resolvedTarget.membership.agency;

  const receipt = await getPluginAddonReceiptById(authz.ctx.platformDb, receiptId);
  if (!receipt || receipt.payerAgencyId !== targetAgency.id) {
    return agencyErrorResponse(404, "NOT_FOUND", "Kuitansi plugin tidak ditemukan.", authz.ctx.requestId);
  }

  let pdfBytes: Uint8Array | null = null;
  if (runtimeEnv.MEDIA_BUCKET) {
    const obj = await runtimeEnv.MEDIA_BUCKET.get(receipt.r2ObjectKey);
    if (obj) {
      pdfBytes = new Uint8Array(await obj.arrayBuffer());
    }
  }

  if (!pdfBytes) {
    const tenantRow = await authz.ctx.platformDb
      .prepare("SELECT handle FROM tenants WHERE id = ? LIMIT 1")
      .bind(receipt.tenantId)
      .first<{ readonly handle: string }>();

    const generated = await generatePluginAddonReceiptPdf({
      receiptNumber: receipt.receiptNumber,
      issuedAtMs: receipt.issuedAtMs,
      tenantName: receipt.tenantNameSnapshot,
      tenantHandle: tenantRow?.handle ?? receipt.tenantId,
      payerKind: receipt.payerKind,
      payerName: receipt.payerNameSnapshot,
      pluginSlug: receipt.pluginSlug,
      pluginName: receipt.pluginNameSnapshot,
      billingModel: receipt.billingModel,
      orderId: receipt.orderId,
      grossAmountIdr: receipt.grossAmountIdr,
      discountAmountIdr: receipt.discountAmountIdr,
      channelFeeIdr: receipt.channelFeeIdr,
      totalAmountIdr: receipt.totalAmountIdr,
      couponCode: receipt.couponCode,
      paymentChannel: receipt.paymentChannel,
      providerReference: receipt.providerReference,
      nonPkpNotice: receipt.nonPkpNotice,
    });
    pdfBytes = generated.bytes;
  }

  const pdfBody = new ArrayBuffer(pdfBytes.byteLength);
  new Uint8Array(pdfBody).set(pdfBytes);

  return new Response(pdfBody, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${receipt.receiptNumber}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "X-Receipt-Number": receipt.receiptNumber,
    },
  });
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleAgencyPluginReceiptPdfRequest(
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

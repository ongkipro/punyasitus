import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { generatePluginAddonReceiptPdf } from "@punyasitus/core/plugins/billing";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  getPluginAddonReceiptById,
  resolveTenantAgencyContext,
} from "@punyasitus/db/plugins/store/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantPluginRequest,
  createPluginRequestId,
  pluginErrorResponse,
  type TenantPluginHandlerOptions,
  type TenantPluginRuntimeEnv,
} from "../../_shared.ts";

/**
 * `GET /api/tenants/:tenantId/plugins/receipts/:receiptId/pdf`
 * Downloads the immutable numbered PDF receipt (`INV-PLG-YYYY-NNNNNN`) for a tenant's
 * plugin add-on purchase. Strictly blocks cross-tenant access (`404`) and agency-managed
 * client users (`403 AGENCY_PAYER_ONLY`).
 *
 * (REQ-098, REQ-081, REQ-083, TASK-098).
 */

export async function handleTenantPluginReceiptPdfRequest(
  tenantId: string,
  receiptId: string,
  request: Request,
  runtimeEnv: TenantPluginRuntimeEnv,
  options: TenantPluginHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createPluginRequestId();

  const auth = await authorizeTenantPluginRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:read",
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  if (method !== "GET") {
    return pluginErrorResponse(405, "BAD_REQUEST", "Gunakan metode GET.", requestId, {
      Allow: "GET",
    });
  }

  const platformDb = auth.ctx.runtimeDeps.platformDb;
  const tenantCtx = await resolveTenantAgencyContext(platformDb, auth.ctx.tenant.id);
  if (tenantCtx?.owningAgencyId !== null) {
    return pluginErrorResponse(
      403,
      "AGENCY_PAYER_ONLY",
      "Kuitansi add-on untuk situs klien hanya tersedia melalui Portal Agensi.",
      requestId,
    );
  }

  const receipt = await getPluginAddonReceiptById(platformDb, receiptId);
  if (!receipt || receipt.tenantId !== auth.ctx.tenant.id || receipt.payerKind !== "tenant") {
    return pluginErrorResponse(404, "NOT_FOUND", "Kuitansi plugin tidak ditemukan.", requestId);
  }

  let pdfBytes: Uint8Array | null = null;
  if (runtimeEnv.MEDIA_BUCKET) {
    const obj = await runtimeEnv.MEDIA_BUCKET.get(receipt.r2ObjectKey);
    if (obj) {
      pdfBytes = new Uint8Array(await obj.arrayBuffer());
    }
  }

  if (!pdfBytes) {
    const generated = await generatePluginAddonReceiptPdf({
      receiptNumber: receipt.receiptNumber,
      issuedAtMs: receipt.issuedAtMs,
      tenantName: receipt.tenantNameSnapshot,
      tenantHandle: auth.ctx.tenant.handle,
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

function buildRuntimeEnv(): TenantPluginRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    MEDIA_BUCKET: runtimeEnv.MEDIA_BUCKET,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPluginReceiptPdfRequest(
    params.tenantId ?? "",
    params.receiptId ?? "",
    request,
    buildRuntimeEnv(),
    { authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null },
  );

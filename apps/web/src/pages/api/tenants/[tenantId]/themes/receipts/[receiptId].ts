import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { generateThemeStoreReceiptPdf } from "@punyasitus/core/theme/variants";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { getTenantThemeStoreReceiptById } from "@punyasitus/db/themes/store/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantThemesRequest,
  createThemesRequestId,
  mapThemesDomainErrorToResponse,
  themesErrorResponse,
  themesJsonResponse,
  type TenantThemesHandlerOptions,
  type TenantThemesRuntimeEnv,
} from "../_shared.ts";

/**
 * Commercial Theme Store Numbered PDF Receipt Download endpoint:
 * - `GET /api/tenants/:tenantId/themes/receipts/:receiptId`
 * - `GET /api/tenants/:tenantId/themes/receipts/:receiptId?format=json`
 *
 * Strictly scoped to THIS `tenantId` (`404` for foreign tenant receipts!).
 * Returns valid `%PDF-1.4` bytes with `Cache-Control: private, no-store` and
 * `X-Robots-Tag: noindex, nofollow`.
 *
 * TASK-096 (`REQ-096`, `REQ-081`).
 */

export async function handleTenantThemeReceiptRequest(
  tenantId: string,
  receiptId: string,
  request: Request,
  runtimeEnv: TenantThemesRuntimeEnv,
  options: TenantThemesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createThemesRequestId();

  if (method !== "GET") {
    const auth = await authorizeTenantThemesRequest(
      tenantId,
      request,
      runtimeEnv,
      "settings:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return themesErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan metode GET untuk mengunduh kuitansi pembelian tema.",
      requestId,
      { extraHeaders: { Allow: "GET" } },
    );
  }

  const auth = await authorizeTenantThemesRequest(
    tenantId,
    request,
    runtimeEnv,
    "settings:read",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const found = await getTenantThemeStoreReceiptById(
      auth.ctx.platformDb,
      auth.ctx.member.tenantId,
      receiptId,
    );
    if (!found) {
      return themesErrorResponse(
        404,
        "THEME_RECEIPT_NOT_FOUND",
        "Kuitansi tema tidak ditemukan untuk situs ini.",
        requestId,
      );
    }

    const url = new URL(request.url);
    if (url.searchParams.get("format") === "json") {
      return themesJsonResponse(200, {
        receipt: found.receipt,
        themeName: found.themeName,
      });
    }

    // Serve from R2 if stored, otherwise deterministically regenerate identical PDF bytes
    let pdfBytes: Uint8Array | null = null;
    if (runtimeEnv.MEDIA_BUCKET) {
      const obj = await runtimeEnv.MEDIA_BUCKET.get(found.receipt.r2ObjectKey);
      if (obj) {
        pdfBytes = new Uint8Array(await obj.arrayBuffer());
      }
    }

    if (!pdfBytes) {
      // Regenerate strictly from immutable receipt snapshots so bytes match `pdf_sha256` bit-for-bit!
      const generated = await generateThemeStoreReceiptPdf({
        receiptNumber: found.receipt.receiptNumber,
        issuedAtMs: found.receipt.issuedAtMs,
        tenantName: found.receipt.tenantNameSnapshot || auth.ctx.member.tenantName,
        tenantHandle: auth.ctx.member.handle,
        payerName: found.receipt.payerNameSnapshot || "Pemilik Situs",
        themeId: found.receipt.themeId,
        themeName: found.themeName,
        orderId: found.receipt.orderId,
        baseAmountIdr: found.receipt.baseAmountIdr,
        discountAmountIdr: found.receipt.discountAmountIdr,
        channelFeeIdr: found.receipt.channelFeeIdr,
        totalAmountIdr: found.receipt.totalAmountIdr,
        couponCode: found.receipt.couponCode,
        paymentChannel: found.receipt.paymentChannel,
        providerReference: found.receipt.providerReference,
        nonPkpNotice: found.receipt.nonPkpNotice,
      });
      pdfBytes = generated.bytes;
    }

    const responseBytes = new Uint8Array(pdfBytes.byteLength);
    responseBytes.set(pdfBytes);

    return new Response(responseBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${found.receipt.receiptNumber}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
        "X-Receipt-Number": found.receipt.receiptNumber,
        "X-Receipt-Sha256": found.receipt.pdfSha256,
      },
    });
  } catch (err) {
    return mapThemesDomainErrorToResponse(err, requestId);
  }
}

function buildRuntimeEnv(): TenantThemesRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly MEDIA_BUCKET?: R2Bucket;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
    MEDIA_BUCKET: runtimeEnv.MEDIA_BUCKET ?? null,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantThemeReceiptRequest(
    params.tenantId ?? "",
    params.receiptId ?? "",
    request,
    buildRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );

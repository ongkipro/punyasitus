import { env } from "cloudflare:workers";
import { createAuth, enforceSessionLifetimeCeiling } from "@punyasitus/auth";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import type { ApiErrorCode, TenantStatus } from "@punyasitus/core/schemas";
import type { PaymentReceiptRecord } from "@punyasitus/db/billing/receipts/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../../middleware/auth.ts";

/**
 * Shared payer-only authorization, formatting, and PDF response builders for
 * `/api/tenants/[tenantId]/billing/receipts/**` (REQ-081, REQ-058; PLAN §17.2, §19.3; TASK-081).
 *
 * Strict authorization matrix:
 * - Platform `app` host ONLY (neutral `404` on tenant/marketing/console hosts).
 * - Unauthenticated -> `401 UNAUTHENTICATED`.
 * - Direct tenant (`agency_id IS NULL`):
 *   - `owner` -> `200` (including `trial`, `active`, `grace`, `locked`, `suspended`).
 *   - `admin`, `editor`, `setup_staff` -> `403 FORBIDDEN`.
 *   - Non-member / other tenant / purged -> neutral `404 NOT_FOUND`.
 * - Agency-managed tenant (`agency_id IS NOT NULL`):
 *   - Authorized `agency_staff` / owning agency staff/owner -> `200`.
 *   - Client tenant members (`owner`, `admin`, `editor`, `setup_staff`) -> `403 FORBIDDEN`.
 *   - Non-member / other agency / other tenant -> neutral `404 NOT_FOUND`.
 */

const PRIVATE_JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export interface TenantReceiptRuntimeEnv extends AuthRuntimeEnv {
  readonly MEDIA_BUCKET?: R2Bucket | null;
}

export interface TenantReceiptHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
}

export interface AuthorizedTenantReceiptContext {
  readonly requestId: string;
  readonly nowMs: number;
  readonly userId: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly agencyId: string | null;
  readonly payerKind: "tenant" | "agency";
  readonly platformDb: D1Database;
}

export function createReceiptRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function receiptJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(PRIVATE_JSON_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function receiptErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  extraHeaders?: HeadersInit,
): Response {
  return receiptJsonResponse(
    status,
    {
      error: { code, message },
      requestId,
    },
    extraHeaders,
  );
}

export function receiptPdfDownloadResponse(
  receipt: Pick<PaymentReceiptRecord, "receiptNumber" | "pdfSha256">,
  pdfBytes: Uint8Array,
): Response {
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
}

export function formatReceiptSummaryDto(
  receipt: PaymentReceiptRecord,
  downloadPath: string,
): Record<string, unknown> {
  return {
    id: receipt.id,
    receiptNumber: receipt.receiptNumber,
    documentKind: receipt.documentKind,
    tenantId: receipt.tenantId,
    agencyId: receipt.agencyId,
    obligationId: receipt.obligationId,
    settlementId: receipt.settlementId,
    refundId: receipt.refundId,
    linkedReceiptId: receipt.linkedReceiptId,
    currency: receipt.currency,
    baseAmountIdr: receipt.baseAmountIdr,
    discountAmountIdr: receipt.discountAmountIdr,
    channelFeeIdr: receipt.channelFeeIdr,
    totalAmountIdr: receipt.totalAmountIdr,
    planCode: receipt.planCode,
    periodStartAt:
      receipt.periodStartMs !== null ? new Date(receipt.periodStartMs).toISOString() : null,
    periodEndAt:
      receipt.periodEndMs !== null ? new Date(receipt.periodEndMs).toISOString() : null,
    paymentChannel: receipt.paymentChannel,
    providerReference: receipt.providerReference,
    nonPkpNotice: receipt.nonPkpNotice,
    pdfByteLength: receipt.pdfByteLength,
    pdfSha256: receipt.pdfSha256,
    issuedAt: receipt.issuedAtIso,
    emailedAt: receipt.emailedAtIso,
    downloadUrl: downloadPath,
  };
}

export function buildTenantReceiptRuntimeEnv(): TenantReceiptRuntimeEnv {
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
  };
}

export async function resolveAuthenticatedAppUser(
  request: Request,
  runtimeEnv: AuthRuntimeEnv,
  hostCtx: { readonly baseURL: string; readonly expectedOrigin: string },
  options: {
    readonly authenticatedUser?: { readonly id: string } | null;
    readonly activeOrganizationId?: string | null;
    readonly emailPort?: EmailPort | null;
    readonly nowMs: number;
  },
): Promise<
  | { readonly ok: true; readonly userId: string; readonly activeOrganizationId: string | null }
  | { readonly ok: false; readonly status: 401 | 503; readonly code: ApiErrorCode; readonly message: string }
> {
  if (options.authenticatedUser?.id?.trim()) {
    return {
      ok: true,
      userId: options.authenticatedUser.id.trim(),
      activeOrganizationId: options.activeOrganizationId ?? null,
    };
  }

  const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
  if (!secret || !runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Konfigurasi autentikasi belum lengkap.",
    };
  }

  try {
    const auth = createAuth(runtimeEnv.PLATFORM_DB, {
      baseURL: hostCtx.baseURL,
      secret,
      surface: "app",
      trustedOrigins: [hostCtx.expectedOrigin],
      emailPort: resolveAuthEmailPort(runtimeEnv, options.emailPort),
    });
    const sessionResult = await auth.api.getSession({ headers: request.headers });
    if (sessionResult?.user && sessionResult.session) {
      const pathname = new URL(request.url).pathname.toLowerCase();
      const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
        sessionId: sessionResult.session.id,
        userId: sessionResult.user.id,
        surface: "app",
        pathname,
        nowMs: options.nowMs,
      });
      if (lifetime.valid) {
        const rawSession = sessionResult.session as typeof sessionResult.session & {
          activeOrganizationId?: string | null;
        };
        return {
          ok: true,
          userId: sessionResult.user.id,
          activeOrganizationId: rawSession.activeOrganizationId ?? null,
        };
      }
    }
  } catch {
    // Fall through to 401
  }

  return {
    ok: false,
    status: 401,
    code: "UNAUTHENTICATED",
    message: "Autentikasi diperlukan untuk mengakses kuitansi pembayaran.",
  };
}

export async function authorizeTenantReceiptRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantReceiptRuntimeEnv,
  options: TenantReceiptHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedTenantReceiptContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createReceiptRequestId();
  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: receiptErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: receiptErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        { "Retry-After": "60" },
      ),
    };
  }

  const sessionRes = await resolveAuthenticatedAppUser(request, runtimeEnv, hostCtx, {
    authenticatedUser: options.authenticatedUser,
    activeOrganizationId: options.activeOrganizationId,
    emailPort: options.emailPort,
    nowMs,
  });
  if (!sessionRes.ok) {
    return {
      ok: false,
      response: receiptErrorResponse(
        sessionRes.status,
        sessionRes.code,
        sessionRes.message,
        requestId,
        sessionRes.status === 503 ? { "Retry-After": "60" } : undefined,
      ),
    };
  }

  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: receiptErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  const tenantRow = await runtimeEnv.PLATFORM_DB.prepare(
    `SELECT id, organization_id, agency_id, handle, status
     FROM tenants
     WHERE id = ? OR LOWER(handle) = LOWER(?)
     LIMIT 1`,
  )
    .bind(trimmedSelector, trimmedSelector)
    .first<{
      readonly id: string;
      readonly organization_id: string;
      readonly agency_id: string | null;
      readonly handle: string;
      readonly status: TenantStatus;
    }>();

  if (!tenantRow || tenantRow.status === "purged") {
    return {
      ok: false,
      response: receiptErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  const memberRow = await runtimeEnv.PLATFORM_DB.prepare(
    `SELECT role
     FROM members
     WHERE organization_id = ? AND user_id = ?
     LIMIT 1`,
  )
    .bind(tenantRow.organization_id, sessionRes.userId)
    .first<{ readonly role: string }>();

  // Case A: Direct tenant (agency_id IS NULL) — ONLY tenant owner can access receipts
  if (tenantRow.agency_id === null) {
    if (!memberRow) {
      return {
        ok: false,
        response: receiptErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
      };
    }

    if (
      sessionRes.activeOrganizationId &&
      sessionRes.activeOrganizationId.trim().length > 0 &&
      sessionRes.activeOrganizationId.trim() !== tenantRow.organization_id
    ) {
      return {
        ok: false,
        response: receiptErrorResponse(
          403,
          "FORBIDDEN",
          "Konteks organisasi aktif tidak cocok dengan tenant yang diminta.",
          requestId,
        ),
      };
    }

    if (memberRow.role !== "owner") {
      return {
        ok: false,
        response: receiptErrorResponse(
          403,
          "FORBIDDEN",
          "Hanya pemilik situs (owner) yang berwenang mengakses kuitansi pembayaran.",
          requestId,
        ),
      };
    }

    if (tenantRow.status === "recovery" || tenantRow.status === "purging") {
      return {
        ok: false,
        response: receiptErrorResponse(
          403,
          "SUBSCRIPTION_LOCKED",
          "Akses kuitansi sementara tidak tersedia saat situs dalam pemulihan atau penghapusan.",
          requestId,
        ),
      };
    }

    return {
      ok: true,
      ctx: {
        requestId,
        nowMs,
        userId: sessionRes.userId,
        tenantId: tenantRow.id,
        tenantHandle: tenantRow.handle,
        agencyId: null,
        payerKind: "tenant",
        platformDb: runtimeEnv.PLATFORM_DB,
      },
    };
  }

  // Case B: Agency-managed tenant (agency_id IS NOT NULL) — ONLY authorized staff/owner of an ACTIVE agency
  const agencyRow = await runtimeEnv.PLATFORM_DB.prepare(
    `SELECT id, organization_id, owner_user_id, status
     FROM agencies
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(tenantRow.agency_id)
    .first<{
      readonly id: string;
      readonly organization_id: string;
      readonly owner_user_id: string;
      readonly status: string;
    }>();

  let isAuthorizedAgencyUser = false;
  if (agencyRow && agencyRow.status === "active") {
    if (agencyRow.owner_user_id === sessionRes.userId) {
      isAuthorizedAgencyUser = true;
    } else if (memberRow?.role === "agency_staff") {
      isAuthorizedAgencyUser = true;
    } else {
      const agencyOrgMember = await runtimeEnv.PLATFORM_DB.prepare(
        `SELECT role
         FROM members
         WHERE organization_id = ? AND user_id = ? AND role IN ('owner', 'admin', 'agency_staff')
         LIMIT 1`,
      )
        .bind(agencyRow.organization_id, sessionRes.userId)
        .first<{ readonly role: string }>();
      isAuthorizedAgencyUser = Boolean(agencyOrgMember);
    }
  }

  if (isAuthorizedAgencyUser) {
    if (tenantRow.status === "recovery" || tenantRow.status === "purging") {
      return {
        ok: false,
        response: receiptErrorResponse(
          403,
          "SUBSCRIPTION_LOCKED",
          "Akses kuitansi sementara tidak tersedia saat situs dalam pemulihan atau penghapusan.",
          requestId,
        ),
      };
    }

    return {
      ok: true,
      ctx: {
        requestId,
        nowMs,
        userId: sessionRes.userId,
        tenantId: tenantRow.id,
        tenantHandle: tenantRow.handle,
        agencyId: tenantRow.agency_id,
        payerKind: "agency",
        platformDb: runtimeEnv.PLATFORM_DB,
      },
    };
  }

  // Client tenant members (owner/admin/editor) on an agency-managed tenant get explicit 403
  if (memberRow) {
    return {
      ok: false,
      response: receiptErrorResponse(
        403,
        "FORBIDDEN",
        "Tagihan dan kuitansi situs ini dikelola oleh agensi.",
        requestId,
      ),
    };
  }

  // Non-member / different agency / cross-tenant -> neutral 404
  return {
    ok: false,
    response: receiptErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
  };
}

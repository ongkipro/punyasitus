import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import {
  resolvePlatformAuthHostContext,
  type AuthRuntimeEnv,
} from "../../../../middleware/auth.ts";
import {
  createReceiptRequestId,
  formatReceiptSummaryDto,
  receiptErrorResponse,
  receiptJsonResponse,
  receiptPdfDownloadResponse,
  resolveAuthenticatedAppUser,
} from "../../tenants/[tenantId]/billing/receipts/_shared.ts";

/**
 * Shared agency authorization & helpers for `/api/agency/receipts/**`
 * (REQ-081, REQ-083; PLAN §17.2, §19.3, §19.4; TASK-081).
 *
 * Security boundaries:
 * - Platform `app` host ONLY (neutral `404` on tenant/marketing/console hosts).
 * - Unauthenticated -> `401 UNAUTHENTICATED`.
 * - Non-agency user -> `403 FORBIDDEN`.
 * - Agency staff/owner ONLY sees receipts owned by their active `agency_id`;
 *   another agency's or direct tenant's receipts return neutral `404 NOT_FOUND`.
 */

export {
  createReceiptRequestId,
  formatReceiptSummaryDto,
  receiptErrorResponse,
  receiptJsonResponse,
  receiptPdfDownloadResponse,
};

export interface AgencyReceiptRuntimeEnv extends AuthRuntimeEnv {
  readonly MEDIA_BUCKET?: R2Bucket | null;
}

export interface AgencyReceiptHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
}

export interface AuthorizedAgencyReceiptContext {
  readonly requestId: string;
  readonly nowMs: number;
  readonly userId: string;
  readonly agencyIds: ReadonlySet<string>;
  readonly primaryAgencyId: string;
  readonly platformDb: D1Database;
}

export function buildAgencyReceiptRuntimeEnv(): AgencyReceiptRuntimeEnv {
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

export async function authorizeAgencyReceiptRequest(
  request: Request,
  runtimeEnv: AgencyReceiptRuntimeEnv,
  options: AgencyReceiptHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedAgencyReceiptContext }
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

  // Resolve all active agencies the authenticated user belongs to:
  // 1) Agency owner (`agencies.owner_user_id`),
  // 2) Member of the agency's own organization (`owner`/`admin`/`agency_staff`), or
  // 3) Assigned `agency_staff` member on any tenant belonging to that active agency.
  const rows = await runtimeEnv.PLATFORM_DB.prepare(
    `SELECT DISTINCT a.id
     FROM agencies a
     WHERE a.status = 'active'
       AND (
         a.owner_user_id = ?
         OR EXISTS (
           SELECT 1
           FROM members m
           WHERE m.organization_id = a.organization_id
             AND m.user_id = ?
             AND m.role IN ('owner', 'admin', 'agency_staff')
         )
         OR EXISTS (
           SELECT 1
           FROM tenants t
           INNER JOIN members mt ON mt.organization_id = t.organization_id
           WHERE t.agency_id = a.id
             AND mt.user_id = ?
             AND mt.role = 'agency_staff'
         )
       )
     ORDER BY a.created_at ASC`,
  )
    .bind(sessionRes.userId, sessionRes.userId, sessionRes.userId)
    .all<{ readonly id: string }>();

  const ids = (rows.results ?? []).map((r) => r.id);
  if (ids.length === 0) {
    return {
      ok: false,
      response: receiptErrorResponse(
        403,
        "FORBIDDEN",
        "Akses kuitansi agensi hanya diizinkan untuk staf agensi terotorisasi.",
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
      agencyIds: new Set(ids),
      primaryAgencyId: ids[0]!,
      platformDb: runtimeEnv.PLATFORM_DB,
    },
  };
}

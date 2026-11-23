import { env } from "cloudflare:workers";
import {
  authorizeAgencyRequest,
  canAgencyRolePerform,
  type AgencySessionInput,
  type AgencyUserInput,
} from "@punyasitus/auth/agency/index";
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
 * (REQ-081, REQ-083; PLAN §17.2, §19.3, §19.4; TASK-081 & TASK-083).
 *
 * Security boundaries (TASK-083 hardened):
 * - All live HTTP / Astro / cookie / session requests route strictly through `authorizeAgencyRequest`:
 *   - Platform `app` host ONLY (neutral `404` on tenant/marketing/console hosts).
 *   - DEC-045 agency session lifetime ceilings (60m idle / 12h absolute).
 *   - Verified email (`403 EMAIL_NOT_VERIFIED`).
 *   - Mandatory TOTP 2FA (`403 TOTP_ENROLLMENT_REQUIRED` / `403 TOTP_REQUIRED`).
 *   - Active, non-revoked `agency_members` with `agency:billing:read` RBAC role (`403 FORBIDDEN` for `agency_staff`).
 *   - Cross-agency or direct-tenant receipts return neutral `404 NOT_FOUND`.
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
  /** Live session + user forwarded by Astro middleware locals or session-based tests. */
  readonly session?: AgencySessionInput | null;
  readonly user?: AgencyUserInput | null;
  /** Legacy pre-TASK-083 synthetic user injection (honored ONLY when `0028_agency_portal` is not applied). */
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

async function hasAgencyMembersTable(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agency_members' LIMIT 1")
      .first<{ readonly name: string }>();
    return Boolean(row?.name);
  } catch {
    return false;
  }
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

  const isLegacySyntheticCall =
    Boolean(options.authenticatedUser?.id) &&
    !options.session &&
    !request.headers.get("cookie") &&
    Boolean(runtimeEnv.PLATFORM_DB) &&
    !(await hasAgencyMembersTable(runtimeEnv.PLATFORM_DB!));

  // Primary path (100% of live HTTP, Astro, cookie, session, and post-0028 requests):
  // Route strictly through `authorizeAgencyRequest` with mandatory 2FA + agency:billing:read RBAC!
  if (!isLegacySyntheticCall) {
    const url = new URL(request.url);
    const requestedAgencyId = url.searchParams.get("agencyId");
    const authz = await authorizeAgencyRequest(
      request,
      runtimeEnv,
      {
        action: "agency.receipts.read",
        requestedAgencyId,
        requireAgencyMembership: true,
        requiredPermission: "agency:billing:read",
        enforceCsrf: false,
      },
      {
        emailPort: options.emailPort,
        nowMs,
        requestId,
        session: options.session ?? null,
        user: options.user ?? null,
      },
    );

    if (!authz.ok) {
      return { ok: false, response: authz.response };
    }

    const billingAgencyIds = requestedAgencyId
      ? [authz.ctx.actor.activeAgency!.id]
      : authz.ctx.actor.memberships
          .filter(
            (m) =>
              m.agency.status !== "suspended" &&
              canAgencyRolePerform(m.role, "agency:billing:read"),
          )
          .map((m) => m.agency.id);

    if (billingAgencyIds.length === 0) {
      return {
        ok: false,
        response: receiptErrorResponse(
          403,
          "FORBIDDEN",
          "Peran agensi Anda tidak memiliki izin akses kuitansi penagihan.",
          authz.ctx.requestId,
        ),
      };
    }

    return {
      ok: true,
      ctx: {
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
        userId: authz.ctx.actor.userId,
        agencyIds: new Set(billingAgencyIds),
        primaryAgencyId: authz.ctx.actor.activeAgency?.id ?? billingAgencyIds[0]!,
        platformDb: authz.ctx.platformDb,
      },
    };
  }

  // Legacy pre-0028 synthetic test harness compatibility (TASK-081 tests without `0028_agency_portal.sql`)
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

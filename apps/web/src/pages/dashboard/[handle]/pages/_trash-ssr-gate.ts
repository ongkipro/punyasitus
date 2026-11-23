import { canPerform, isActionAllowedForTenantStatus } from "@punyasitus/auth";
import type { Role, TenantStatus } from "@punyasitus/core/schemas";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import type { TenantVertical } from "@punyasitus/db/platform";

/**
 * Strict SSR Lifecycle & RBAC Gate for Content Trash & Recovery pages
 * (`apps/web/src/pages/dashboard/[handle]/{pages,posts,catalog}/trash.astro`;
 * TASK-044, REQ-048, REQ-034, PLAN §11.5).
 *
 * Enforces ALL gates BEFORE any `TenantStore` DB open or query:
 * - Invalid handle / non-app host / unauthenticated / non-member -> neutral `404`
 *   (`Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`), ZERO tenant DB reads.
 * - `purging` / `purged` -> neutral `404` (`Cache-Control: private, no-store`,
 *   `X-Robots-Tag: noindex, nofollow`), ZERO tenant DB reads.
 * - `suspended` / `recovery` / `operatorHold` -> `302` redirect to
 *   `/dashboard/[handle]/service-status`, ZERO tenant DB reads.
 * - `locked` -> read-only (`isLocked: true`, mutations disabled; APIs reject with `403 SUBSCRIPTION_LOCKED`).
 * - Owner/Admin/Agency Admin can purge permanently (`canPurgeContent: true` when not locked);
 *   Editor can read & restore (`canWriteContent: true`, `canPurgeContent: false`).
 */

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const PERMANENT_PURGE_ROLES = new Set<Role>(["owner", "admin", "agency_admin"]);

export type TrashLifecycleStatus = "trial" | "active" | "grace" | "locked" | "suspended";

export interface TrashAdminPermissions {
  readonly role: Role;
  readonly roleLabel: string;
  readonly tenantStatus: TenantStatus;
  readonly isLocked: boolean;
  readonly canWriteContent: boolean;
  readonly canPublishContent: boolean;
  readonly canManageMedia: boolean;
  readonly canUploadMedia: boolean;
  readonly canManageMenus: boolean;
  readonly canManageSettings: boolean;
  readonly canPurgeContent: boolean;
}

export interface TrashSsrContext {
  readonly tenantId: string;
  readonly handle: string;
  readonly workspaceName: string;
  readonly workspaceSubtitle: string;
  readonly basePath: string;
  readonly publicSiteHref: string;
  readonly offeringLabel: string;
  readonly vertical: TenantVertical;
  readonly lifecycleStatus: TrashLifecycleStatus;
  readonly lifecycleDaysRemaining?: number;
  readonly lifecycleReason?: string;
  readonly userDisplayName: string;
  readonly permissions: TrashAdminPermissions;
  readonly tenantDb: D1Database;
}

export type TrashSsrGateResult =
  | { readonly ok: true; readonly ctx: TrashSsrContext }
  | { readonly ok: false; readonly response: Response };

export interface TrashSsrGateEnvOverride {
  readonly APP_ENV?: string;
  readonly SAAS_ZONE?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TrashSsrGateAstroLike {
  readonly params: Record<string, string | undefined>;
  readonly locals: App.Locals;
  readonly response: { readonly headers: Headers };
}

export interface TrashSsrGateOptions {
  readonly envOverride?: TrashSsrGateEnvOverride;
  readonly bindTenantDb?: (
    ns: TenantStoreNamespaceLike,
    tenantId: string,
  ) => D1Database;
  readonly nowMs?: number;
}

function neutralNotFoundResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Halaman tidak ditemukan</title></head><body><main><h1>Halaman tidak ditemukan</h1></main></body></html>`,
    {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "Content-Security-Policy": "default-src 'none'",
      },
    },
  );
}

function serviceStatusRedirectResponse(handle: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/dashboard/${encodeURIComponent(handle)}/service-status`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function mapRoleLabel(role: Role): string {
  switch (role) {
    case "owner":
      return "Pemilik Situs";
    case "admin":
      return "Admin";
    case "editor":
      return "Editor";
    case "agency_admin":
      return "Admin Agensi";
    default:
      return "Operator";
  }
}

function mapLifecycle(status: TenantStatus): TrashLifecycleStatus {
  if (
    status === "trial" ||
    status === "active" ||
    status === "grace" ||
    status === "locked" ||
    status === "suspended"
  ) {
    return status;
  }
  return "suspended";
}

function offeringLabelForVertical(vertical?: TenantVertical): string {
  switch (vertical) {
    case "catalog":
    case "resto":
      return "Produk";
    case "travel":
      return "Paket Tur";
    case "dealer":
      return "Kendaraan";
    default:
      return "Layanan";
  }
}

export async function resolveTrashSsrGate(
  astro: TrashSsrGateAstroLike,
  runtimeEnv: TrashSsrGateEnvOverride,
  options: Omit<TrashSsrGateOptions, "envOverride"> = {},
): Promise<TrashSsrGateResult> {

  const rawHandle = (astro.params.handle ?? "").trim().toLowerCase();
  const isLocalEnv = runtimeEnv.APP_ENV === "local";
  const isLocalLoopback = Boolean(astro.locals.isLocalLoopback) && isLocalEnv;

  // 1. Host surface & handle check (ZERO DB reads)
  if (!HANDLE_RE.test(rawHandle) || (!isLocalLoopback && astro.locals.surface !== "app")) {
    return { ok: false, response: neutralNotFoundResponse() };
  }

  // 2. Authenticated tenant membership check (cross-tenant -> neutral 404, ZERO TenantStore reads)
  const authorized = astro.locals.authorizedTenantMember;
  const authUser = astro.locals.authUser;
  if (!authorized || !authUser || authorized.handle.toLowerCase() !== rawHandle) {
    return { ok: false, response: neutralNotFoundResponse() };
  }

  // 3. RBAC `content:read` gate BEFORE any TenantStore DB reads
  if (!canPerform(authorized.role, "content:read")) {
    return {
      ok: false,
      response: new Response("Akses ditolak untuk peran akun Anda.", {
        status: 403,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      }),
    };
  }

  // 4. Lifecycle gate BEFORE any TenantStore DB reads:
  //    - purging / purged -> neutral 404
  //    - suspended / recovery -> 302 to /dashboard/[handle]/service-status
  if (authorized.tenantStatus === "purging" || authorized.tenantStatus === "purged") {
    return { ok: false, response: neutralNotFoundResponse() };
  }
  if (authorized.tenantStatus === "suspended" || authorized.tenantStatus === "recovery") {
    return { ok: false, response: serviceStatusRedirectResponse(authorized.handle) };
  }

  // Also check live PLATFORM_DB status & operator_hold BEFORE opening TenantStore
  const verifiedLocalsTenant =
    astro.locals.tenant?.id === authorized.tenantId ? astro.locals.tenant : null;
  let vertical: TenantVertical = verifiedLocalsTenant?.vertical ?? "compro";
  let verifiedPrimaryHost: string | null = verifiedLocalsTenant?.primaryHost ?? null;
  let operatorHoldReason: string | null = null;
  let trialEndsAt: number | null = null;
  let effectiveStatus: TenantStatus = authorized.tenantStatus;

  if (runtimeEnv.PLATFORM_DB) {
    try {
      const meta = await runtimeEnv.PLATFORM_DB.prepare(
        `SELECT
           t.status AS status,
           t.operator_hold AS operator_hold,
           t.vertical AS vertical,
           t.operator_hold_reason AS operator_hold_reason,
           t.trial_ends_at AS trial_ends_at,
           ph.host AS primary_host
         FROM tenants t
         LEFT JOIN tenant_hosts ph
           ON ph.tenant_id = t.id
           AND ph.is_primary = 1
           AND ph.status = 'active'
           AND ph.ssl_status = 'active'
         WHERE t.id = ?
         LIMIT 1`,
      )
        .bind(authorized.tenantId)
        .first<{
          readonly status: TenantStatus;
          readonly operator_hold: number | boolean;
          readonly vertical: TenantVertical;
          readonly operator_hold_reason: string | null;
          readonly trial_ends_at: number | null;
          readonly primary_host: string | null;
        }>();

      if (meta) {
        const liveStatus = meta.status;
        const isOperatorHold = meta.operator_hold === 1 || meta.operator_hold === true;
        if (liveStatus === "purging" || liveStatus === "purged") {
          return { ok: false, response: neutralNotFoundResponse() };
        }
        if (liveStatus === "suspended" || liveStatus === "recovery" || isOperatorHold) {
          return { ok: false, response: serviceStatusRedirectResponse(authorized.handle) };
        }
        effectiveStatus = liveStatus;
        vertical = meta.vertical;
        operatorHoldReason = meta.operator_hold_reason;
        trialEndsAt = meta.trial_ends_at;
        if (meta.primary_host) {
          verifiedPrimaryHost = meta.primary_host;
        }
      }
    } catch {
      // Fail closed with 503 if live PLATFORM_DB lifecycle verification fails (ZERO TenantStore reads)
      return {
        ok: false,
        response: new Response("Layanan verifikasi status situs sementara tidak tersedia.", {
          status: 503,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "private, no-store",
            "X-Robots-Tag": "noindex, nofollow",
            "Retry-After": "30",
          },
        }),
      };
    }
  }

  // Final status-action verification before opening TenantStore
  const readLifecycleCheck = isActionAllowedForTenantStatus(effectiveStatus, "content:read");
  if (!readLifecycleCheck.allowed) {
    if (readLifecycleCheck.status === 404) {
      return { ok: false, response: neutralNotFoundResponse() };
    }
    return { ok: false, response: serviceStatusRedirectResponse(authorized.handle) };
  }

  // 5. ONLY NOW bind TenantStore strictly from verified `authorized.tenantId`
  const binder =
    options.bindTenantDb ??
    ((ns: TenantStoreNamespaceLike, tenantId: string) =>
      createTenantDb(openTenantStoreStub(ns, tenantId)));
  const tenantDb = runtimeEnv.TENANT_STORE
    ? binder(runtimeEnv.TENANT_STORE, authorized.tenantId)
    : astro.locals.tenant?.id === authorized.tenantId
      ? astro.locals.tenantDb
      : null;

  if (!tenantDb) {
    return {
      ok: false,
      response: new Response("Penyimpanan data tenant sementara tidak tersedia.", {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "Retry-After": "30",
        },
      }),
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  const saasZone = runtimeEnv.SAAS_ZONE || "situsku.click";
  const lifecycleStatus = mapLifecycle(effectiveStatus);
  const lifecycleDaysRemaining =
    lifecycleStatus === "trial" && typeof trialEndsAt === "number"
      ? Math.max(0, Math.ceil((trialEndsAt - nowMs) / 86_400_000))
      : undefined;

  const isLocked = effectiveStatus === "locked";
  const allow = (action: Parameters<typeof canPerform>[1]) =>
    canPerform(authorized.role, action) &&
    isActionAllowedForTenantStatus(effectiveStatus, action).allowed;

  const permissions: TrashAdminPermissions = {
    role: authorized.role,
    roleLabel: mapRoleLabel(authorized.role),
    tenantStatus: effectiveStatus,
    isLocked,
    canWriteContent: allow("content:write"),
    canPublishContent: allow("content:publish"),
    canManageMedia: allow("media:manage"),
    canUploadMedia: allow("media:upload"),
    canManageMenus: allow("menu:manage"),
    canManageSettings: allow("settings:write"),
    canPurgeContent: PERMANENT_PURGE_ROLES.has(authorized.role) && !isLocked,
  };

  astro.response.headers.set("Cache-Control", "private, no-store");
  astro.response.headers.set("X-Robots-Tag", "noindex, nofollow");

  const workspaceSubtitle = verifiedPrimaryHost ?? `${authorized.handle}.${saasZone}`;

  return {
    ok: true,
    ctx: {
      tenantId: authorized.tenantId,
      handle: authorized.handle,
      workspaceName: authorized.tenantName,
      workspaceSubtitle,
      basePath: `/dashboard/${authorized.handle}`,
      publicSiteHref: `https://${workspaceSubtitle}`,
      offeringLabel: offeringLabelForVertical(vertical),
      vertical,
      lifecycleStatus,
      lifecycleDaysRemaining,
      lifecycleReason: operatorHoldReason ?? undefined,
      userDisplayName: authUser.name || authUser.email || "Pengguna",
      permissions,
      tenantDb,
    },
  };
}

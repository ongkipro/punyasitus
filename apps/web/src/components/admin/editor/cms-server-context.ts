import { env } from "cloudflare:workers";
import { canPerform, isActionAllowedForTenantStatus } from "@punyasitus/auth";
import type { Role, TenantStatus } from "@punyasitus/core/schemas";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { TenantVertical } from "@punyasitus/db/platform";
import type { LifecycleStatus } from "@/components/admin/navigation";
import { bindTenantDatabase } from "@/core/tenant";

/**
 * Shared server-side context resolver for TASK-033 CMS admin Astro routes
 * under `apps/web/src/pages/dashboard/[handle]/**`.
 *
 * Enforces:
 * - Strict handle validation
 * - App-host isolation (`404` on tenant/marketing/console hosts)
 * - Authenticated tenant membership verification (`404` for unauthorized/non-members)
 * - Authoritative `content:read` RBAC + service-gate enforcement BEFORE any TenantStore DB reads
 *   (tenants in `suspended`/`recovery`/`purging` redirect cleanly to `/dashboard/[handle]/service-status`)
 * - Strictly binds `TenantStore` DB and metadata ONLY from verified `authorized.tenantId`
 * - Sets `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow` on ALL response paths.
 */

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export interface CmsAdminPermissions {
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
}

export interface CmsAdminServerContext {
  readonly tenantId: string;
  readonly handle: string;
  readonly workspaceName: string;
  readonly workspaceSubtitle: string;
  readonly basePath: string;
  readonly publicSiteHref: string;
  readonly offeringLabel: string;
  readonly vertical: TenantVertical;
  readonly lifecycleStatus: LifecycleStatus;
  readonly lifecycleDaysRemaining?: number;
  readonly lifecycleReason?: string;
  readonly userDisplayName: string;
  readonly permissions: CmsAdminPermissions;
  readonly tenantDb: D1Database;
  readonly mediaPublicBaseUrl: string;
}

export type CmsAdminContextResult =
  | { readonly ok: true; readonly ctx: CmsAdminServerContext }
  | { readonly ok: false; readonly response: Response };

export function neutralAdminNotFoundResponse(): Response {
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

function mapLifecycle(status: TenantStatus): LifecycleStatus {
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

export async function resolveCmsAdminServerContext(
  astro: {
    readonly params: Record<string, string | undefined>;
    readonly locals: App.Locals;
    readonly response: { readonly headers: Headers };
  },
): Promise<CmsAdminContextResult> {
  const rawHandle = (astro.params.handle ?? "").trim().toLowerCase();
  const isLocalEnv = env.APP_ENV === "local";
  const isLocalLoopback = astro.locals.isLocalLoopback && isLocalEnv;

  if (!HANDLE_RE.test(rawHandle) || (!isLocalLoopback && astro.locals.surface !== "app")) {
    return { ok: false, response: neutralAdminNotFoundResponse() };
  }

  const authorized = astro.locals.authorizedTenantMember;
  const authUser = astro.locals.authUser;
  if (!authorized || !authUser || authorized.handle.toLowerCase() !== rawHandle) {
    return { ok: false, response: neutralAdminNotFoundResponse() };
  }

  // Enforce RBAC `content:read` before opening TenantStore or querying any CMS rows
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

  // Enforce tenant service-lifecycle gate BEFORE any TenantStore DB reads:
  // `suspended`, `recovery`, `purging` tenants cannot read CMS tables; redirect cleanly to service-status.
  const readLifecycleCheck = isActionAllowedForTenantStatus(authorized.tenantStatus, "content:read");
  if (!readLifecycleCheck.allowed) {
    if (readLifecycleCheck.status === 404) {
      return { ok: false, response: neutralAdminNotFoundResponse() };
    }
    return {
      ok: false,
      response: new Response(null, {
        status: 302,
        headers: {
          Location: `/dashboard/${encodeURIComponent(authorized.handle)}/service-status`,
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      }),
    };
  }

  // Always bind TenantStore strictly from verified `authorized.tenantId` (never trust unbound locals.tenantDb)
  const tenantDb = env.TENANT_STORE
    ? bindTenantDatabase(
        env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
        authorized.tenantId,
      )
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

  const verifiedLocalsTenant =
    astro.locals.tenant?.id === authorized.tenantId ? astro.locals.tenant : null;
  let vertical: TenantVertical = verifiedLocalsTenant?.vertical ?? "compro";
  let verifiedPrimaryHost: string | null = verifiedLocalsTenant?.primaryHost ?? null;
  let operatorHoldReason: string | null = null;
  let trialEndsAt: number | null = null;

  if (env.PLATFORM_DB) {
    try {
      const meta = await env.PLATFORM_DB.prepare(
        `SELECT
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
          readonly vertical: TenantVertical;
          readonly operator_hold_reason: string | null;
          readonly trial_ends_at: number | null;
          readonly primary_host: string | null;
        }>();
      if (meta) {
        vertical = meta.vertical;
        operatorHoldReason = meta.operator_hold_reason;
        trialEndsAt = meta.trial_ends_at;
        if (meta.primary_host) {
          verifiedPrimaryHost = meta.primary_host;
        }
      }
    } catch {
      // Keep verified fallback metadata cleanly
    }
  }

  const saasZone = env.SAAS_ZONE || "situsku.click";
  const platformDomain = (env.PLATFORM_DOMAIN || "punyasitus.com").trim().toLowerCase();
  const lifecycleStatus = mapLifecycle(authorized.tenantStatus);
  const lifecycleDaysRemaining =
    lifecycleStatus === "trial" && typeof trialEndsAt === "number"
      ? Math.max(0, Math.ceil((trialEndsAt - Date.now()) / 86_400_000))
      : undefined;

  const isLocked =
    authorized.tenantStatus === "locked" ||
    authorized.tenantStatus === "suspended" ||
    authorized.tenantStatus === "recovery" ||
    authorized.tenantStatus === "purging";

  const allow = (action: Parameters<typeof canPerform>[1]) =>
    canPerform(authorized.role, action) &&
    isActionAllowedForTenantStatus(authorized.tenantStatus, action).allowed;

  const permissions: CmsAdminPermissions = {
    role: authorized.role,
    roleLabel: mapRoleLabel(authorized.role),
    tenantStatus: authorized.tenantStatus,
    isLocked,
    canWriteContent: allow("content:write"),
    canPublishContent: allow("content:publish"),
    canManageMedia: allow("media:manage"),
    canUploadMedia: allow("media:upload"),
    canManageMenus: allow("menu:manage"),
    canManageSettings: allow("settings:write"),
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
      mediaPublicBaseUrl: `https://media.${platformDomain}`,
    },
  };
}

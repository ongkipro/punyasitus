import { env } from "cloudflare:workers";
import { canPerform } from "@punyasitus/auth";
import { loadLiveTenantEntitlement } from "@punyasitus/auth/entitlements/index";
import type { Role, TenantStatus } from "@punyasitus/core/schemas";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { TenantVertical } from "@punyasitus/db/platform";
import type { LifecycleStatus } from "../../../../components/admin/navigation.ts";
import { bindTenantDatabase } from "../../../../core/tenant.ts";

/**
 * Shared SSR Lifecycle & RBAC Gate for `/dashboard/[handle]/plugins/**`
 * (`TASK-097`, `REQ-097`, `REQ-034`, `REQ-060`).
 *
 * CRITICAL R3 INVARIANT:
 * Every host, auth, RBAC, and tenant lifecycle check executes STRICTLY BEFORE
 * opening `TenantStore` or running any tenant DB read:
 * - `purging` / `purged` -> neutral `404` (`Cache-Control: private, no-store`,
 *   `X-Robots-Tag: noindex, nofollow`), ZERO `TenantStore` reads.
 * - `suspended` / `recovery` / `operatorHold` -> `302` to `/dashboard/[handle]/service-status`,
 *   ZERO `TenantStore` reads.
 * - `locked` -> read-only shell (`isLocked: true`, `canManagePlugins: false`).
 * - `editor` -> read-only shell (`canManagePlugins: false`).
 */

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export interface PluginAdminPermissions {
  readonly role: Role;
  readonly roleLabel: string;
  readonly tenantStatus: TenantStatus;
  readonly isLocked: boolean;
  readonly canManagePlugins: boolean;
}

export interface PluginAdminServerContext {
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
  readonly userId: string;
  readonly userDisplayName: string;
  readonly permissions: PluginAdminPermissions;
  readonly platformDb: D1Database;
  readonly tenantStore: TenantStoreNamespaceLike | null;
  readonly tenantDb: D1Database;
}

export type PluginAdminContextResult =
  | { readonly ok: true; readonly ctx: PluginAdminServerContext }
  | { readonly ok: false; readonly response: Response };

export interface ResolvePluginAdminContextOptions {
  readonly platformDb?: D1Database | null;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly appEnv?: string;
  readonly saasZone?: string;
  readonly nowMs?: number;
  readonly resolveTenantDb?: (tenantId: string) => D1Database;
}

export function neutralPluginNotFoundResponse(): Response {
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

export async function resolvePluginAdminServerContext(
  astro: {
    readonly params: Record<string, string | undefined>;
    readonly locals: App.Locals;
    readonly response: { readonly headers: Headers };
  },
  options: ResolvePluginAdminContextOptions = {},
): Promise<PluginAdminContextResult> {
  const rawHandle = (astro.params.handle ?? "").trim().toLowerCase();
  const appEnv = options.appEnv ?? env.APP_ENV;
  const isLocalLoopback = astro.locals.isLocalLoopback && appEnv === "local";

  // 1. Surface & handle validation BEFORE any DB touch
  if (!HANDLE_RE.test(rawHandle) || (!isLocalLoopback && astro.locals.surface !== "app")) {
    return { ok: false, response: neutralPluginNotFoundResponse() };
  }

  // 2. Authenticated tenant membership verification BEFORE any DB touch
  const authorized = astro.locals.authorizedTenantMember;
  const authUser = astro.locals.authUser;
  if (!authorized || !authUser || authorized.handle.toLowerCase() !== rawHandle) {
    return { ok: false, response: neutralPluginNotFoundResponse() };
  }

  // 3. RBAC check BEFORE any DB touch
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

  const platformDb = options.platformDb ?? env.PLATFORM_DB;
  if (!platformDb) {
    return {
      ok: false,
      response: new Response("Layanan basis data platform sementara tidak tersedia.", {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      }),
    };
  }

  // 4. Authoritative live lifecycle & operatorHold gate BEFORE any TenantStore DB reads
  const liveEntitlement =
    astro.locals.tenantEntitlement?.tenantId === authorized.tenantId
      ? astro.locals.tenantEntitlement
      : await loadLiveTenantEntitlement(
          platformDb,
          { tenantId: authorized.tenantId },
          { nowMs: options.nowMs },
        );

  const effectiveStatus: TenantStatus =
    liveEntitlement?.evaluation.effectiveStatus ?? authorized.tenantStatus;
  const storedStatus: TenantStatus =
    liveEntitlement?.evaluation.storedStatus ?? authorized.tenantStatus;
  const isOperatorHold = Boolean(liveEntitlement?.evaluation.operatorHold);

  // `purging` / `purged` -> neutral 404, ZERO TenantStore reads
  if (
    effectiveStatus === "purged" ||
    effectiveStatus === "purging" ||
    storedStatus === "purged" ||
    storedStatus === "purging"
  ) {
    return { ok: false, response: neutralPluginNotFoundResponse() };
  }

  // `suspended` / `recovery` / `operatorHold` -> 302 to `/dashboard/[handle]/service-status`, ZERO TenantStore reads
  if (
    isOperatorHold ||
    effectiveStatus === "suspended" ||
    effectiveStatus === "recovery" ||
    storedStatus === "suspended" ||
    storedStatus === "recovery"
  ) {
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

  // 5. Only AFTER all lifecycle & RBAC gates pass do we bind TenantStore
  const tenantStore =
    options.tenantStore !== undefined
      ? options.tenantStore
      : (env.TENANT_STORE as unknown as TenantStoreNamespaceLike | null);

  const tenantDb = options.resolveTenantDb
    ? options.resolveTenantDb(authorized.tenantId)
    : tenantStore
      ? bindTenantDatabase(tenantStore, authorized.tenantId)
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

  let vertical: TenantVertical = astro.locals.tenant?.vertical ?? "compro";
  let verifiedPrimaryHost: string | null = astro.locals.tenant?.primaryHost ?? null;
  let trialEndsAt: number | null = null;
  let operatorHoldReason: string | null = null;

  try {
    const meta = await platformDb
      .prepare(
        `SELECT t.vertical AS vertical,
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
    // Keep safe verified fallback metadata
  }

  const saasZone = options.saasZone ?? env.SAAS_ZONE ?? "situsku.click";
  const lifecycleStatus = mapLifecycle(effectiveStatus);
  const nowMs = options.nowMs ?? Date.now();
  const lifecycleDaysRemaining =
    lifecycleStatus === "trial" && typeof trialEndsAt === "number"
      ? Math.max(0, Math.ceil((trialEndsAt - nowMs) / 86_400_000))
      : undefined;

  const isLocked = effectiveStatus === "locked";
  const canManagePlugins = canPerform(authorized.role, "settings:write") && !isLocked;

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
      userId: authUser.id,
      userDisplayName: authUser.name || authUser.email || "Pengguna",
      permissions: {
        role: authorized.role,
        roleLabel: mapRoleLabel(authorized.role),
        tenantStatus: effectiveStatus,
        isLocked,
        canManagePlugins,
      },
      platformDb,
      tenantStore,
      tenantDb,
    },
  };
}

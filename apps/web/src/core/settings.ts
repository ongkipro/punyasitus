import { env } from "cloudflare:workers";
import { canPerform, isActionAllowedForTenantStatus } from "@punyasitus/auth";
import type { Role, TenantStatus } from "@punyasitus/core/schemas";
import {
  ALL_OFFERING_TYPES,
  filterPublicNavigationForSettings,
  FIXED_PUBLIC_ROUTES,
  formatDateOnlyPreservingSemantics,
  formatTimestampInTenantTimezone,
  isPublicRouteEnabledBySettings,
  type GroupedSettingsSnapshot,
  type PublicReadingDefaults,
} from "@punyasitus/core/settings/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { TenantVertical } from "@punyasitus/db/platform";
import {
  getPublishedGroupedSettings,
  type PublishedGroupedSettingsDto,
} from "@punyasitus/db/settings/index";
import type { LifecycleStatus } from "../components/admin/navigation.ts";
import type { TenantShellData } from "./public-data.ts";
import { bindTenantDatabase } from "./tenant.ts";

/**
 * Web-layer Grouped Admin Settings SSR Guard & Public Defaults Helper
 * (`apps/web/src/core/settings.ts`; TASK-040, REQ-044, REQ-026, REQ-034, REQ-036, REQ-039).
 *
 * Critical R3 Invariants:
 * 1. ZERO runtime DDL.
 * 2. SSR Lifecycle & RBAC Gate runs BEFORE any `TenantStore` DB reads on every
 *    `/dashboard/[handle]/settings/**` page:
 *    - `purging` / `purged` -> neutral `404` (`private, no-store`, `noindex, nofollow`), ZERO tenant DB reads.
 *    - `suspended` / `recovery` / `operatorHold` -> `302` redirect to `/dashboard/[handle]/service-status`,
 *      ZERO tenant DB reads.
 *    - Missing `settings:read` (e.g. `editor`) -> `403` (`private, no-store`, `noindex, nofollow`),
 *      ZERO tenant DB reads.
 *    - `locked` -> allowed read-only (`canWriteSettings: false`, `canPublishSettings: false`).
 * 3. Every admin SSR response carries `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
 */

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export const ADMIN_SETTINGS_SECURITY_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface GroupedSettingsPermissions {
  readonly role: Role;
  readonly roleLabel: string;
  readonly tenantStatus: TenantStatus;
  readonly isLocked: boolean;
  readonly canReadSettings: boolean;
  readonly canWriteSettings: boolean;
  readonly canPublishSettings: boolean;
  readonly canManageDomains: boolean;
  readonly canManageMembers: boolean;
  readonly canAccessBilling: boolean;
}

export interface GroupedSettingsServerContext {
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
  readonly permissions: GroupedSettingsPermissions;
  readonly tenantDb: D1Database;
  readonly mediaPublicBaseUrl: string;
}

export type GroupedSettingsContextResult =
  | { readonly ok: true; readonly ctx: GroupedSettingsServerContext }
  | { readonly ok: false; readonly response: Response };

export interface SettingsServerGateEnv {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly SAAS_ZONE?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface SettingsAstroContextLike {
  readonly params: Record<string, string | undefined>;
  readonly locals: App.Locals;
  readonly response: { readonly headers: Headers };
}

export function neutralSettingsNotFoundResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Halaman tidak ditemukan</title></head><body><main><h1>Halaman tidak ditemukan</h1></main></body></html>`,
    {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...ADMIN_SETTINGS_SECURITY_HEADERS,
        "Content-Security-Policy": "default-src 'none'",
      },
    },
  );
}

export function settingsForbiddenResponse(
  message = "Akses ditolak. Pengaturan situs hanya dapat diakses oleh Pemilik Situs atau Admin.",
): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Akses Ditolak</title></head><body><main><h1>Akses Ditolak</h1><p>${message}</p></main></body></html>`,
    {
      status: 403,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...ADMIN_SETTINGS_SECURITY_HEADERS,
        "Content-Security-Policy": "default-src 'none'",
      },
    },
  );
}

export function settingsServiceStatusRedirectResponse(handle: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/dashboard/${encodeURIComponent(handle)}/service-status`,
      ...ADMIN_SETTINGS_SECURITY_HEADERS,
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

/**
 * Authoritative SSR lifecycle + RBAC gate for `/dashboard/[handle]/settings/**` pages.
 * Runs strictly BEFORE opening or querying `TenantStore`.
 */
export async function resolveGroupedSettingsServerContext(
  astro: SettingsAstroContextLike,
  runtimeEnvOverride?: SettingsServerGateEnv,
  options?: {
    readonly resolveTenantDb?: (tenantId: string) => D1Database | null;
  },
): Promise<GroupedSettingsContextResult> {
  const runtimeEnv: SettingsServerGateEnv = runtimeEnvOverride ?? {
    APP_ENV: env.APP_ENV,
    PLATFORM_DOMAIN: env.PLATFORM_DOMAIN,
    SAAS_ZONE: env.SAAS_ZONE,
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
  };

  const rawHandle = (astro.params.handle ?? "").trim().toLowerCase();
  const isLocalEnv = runtimeEnv.APP_ENV === "local";
  const isLocalLoopback = Boolean(astro.locals.isLocalLoopback) && isLocalEnv;

  if (!HANDLE_RE.test(rawHandle) || (!isLocalLoopback && astro.locals.surface !== "app")) {
    return { ok: false, response: neutralSettingsNotFoundResponse() };
  }

  const authorized = astro.locals.authorizedTenantMember;
  const authUser = astro.locals.authUser;
  if (!authorized || !authUser || authorized.handle.toLowerCase() !== rawHandle) {
    return { ok: false, response: neutralSettingsNotFoundResponse() };
  }

  // 1. Lifecycle gate BEFORE any TenantStore DB reads (and before RBAC leaks status of purged tenants)
  const effectiveStatus =
    astro.locals.tenantEntitlement?.evaluation.effectiveStatus ?? authorized.tenantStatus;
  if (effectiveStatus === "purging" || effectiveStatus === "purged") {
    return { ok: false, response: neutralSettingsNotFoundResponse() };
  }

  const hasLocalsOperatorHold = Boolean(astro.locals.tenantEntitlement?.evaluation.operatorHold);
  if (
    effectiveStatus === "suspended" ||
    effectiveStatus === "recovery" ||
    hasLocalsOperatorHold
  ) {
    return {
      ok: false,
      response: settingsServiceStatusRedirectResponse(authorized.handle),
    };
  }

  // 2. RBAC `settings:read` gate BEFORE any TenantStore DB reads (`editor` -> 403)
  if (!canPerform(authorized.role, "settings:read")) {
    return { ok: false, response: settingsForbiddenResponse() };
  }

  // 3. Check authoritative PLATFORM_DB tenant metadata (including `operator_hold`) BEFORE opening TenantStore
  const verifiedLocalsTenant =
    astro.locals.tenant?.id === authorized.tenantId ? astro.locals.tenant : null;
  let vertical: TenantVertical = verifiedLocalsTenant?.vertical ?? "compro";
  let verifiedPrimaryHost: string | null = verifiedLocalsTenant?.primaryHost ?? null;
  let operatorHoldReason: string | null = null;
  let trialEndsAt: number | null = null;
  let isAgencyManaged = false;

  if (runtimeEnv.PLATFORM_DB) {
    try {
      const meta = await runtimeEnv.PLATFORM_DB.prepare(
        `SELECT
           t.status AS status,
           t.operator_hold AS operator_hold,
           t.vertical AS vertical,
           t.agency_id AS agency_id,
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
          readonly operator_hold: number;
          readonly vertical: TenantVertical;
          readonly agency_id: string | null;
          readonly operator_hold_reason: string | null;
          readonly trial_ends_at: number | null;
          readonly primary_host: string | null;
        }>();

      if (meta) {
        if (meta.status === "purging" || meta.status === "purged") {
          return { ok: false, response: neutralSettingsNotFoundResponse() };
        }
        if (
          meta.status === "suspended" ||
          meta.status === "recovery" ||
          Number(meta.operator_hold) === 1
        ) {
          return {
            ok: false,
            response: settingsServiceStatusRedirectResponse(authorized.handle),
          };
        }
        vertical = meta.vertical;
        isAgencyManaged = Boolean(meta.agency_id);
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

  // 4. Only now open the verified tenant's isolated TenantStore
  let tenantDb: D1Database | null = null;
  if (options?.resolveTenantDb) {
    tenantDb = options.resolveTenantDb(authorized.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = bindTenantDatabase(runtimeEnv.TENANT_STORE, authorized.tenantId);
  } else if (astro.locals.tenant?.id === authorized.tenantId) {
    tenantDb = astro.locals.tenantDb;
  }

  if (!tenantDb) {
    return {
      ok: false,
      response: new Response("Penyimpanan data tenant sementara tidak tersedia.", {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...ADMIN_SETTINGS_SECURITY_HEADERS,
          "Retry-After": "30",
        },
      }),
    };
  }

  const saasZone = runtimeEnv.SAAS_ZONE || "situsku.click";
  const platformDomain = (runtimeEnv.PLATFORM_DOMAIN || "punyasitus.com").trim().toLowerCase();
  const lifecycleStatus = mapLifecycle(effectiveStatus);
  const lifecycleDaysRemaining =
    lifecycleStatus === "trial" && typeof trialEndsAt === "number"
      ? Math.max(0, Math.ceil((trialEndsAt - Date.now()) / 86_400_000))
      : undefined;

  const isLocked = effectiveStatus === "locked";
  const allow = (action: Parameters<typeof canPerform>[1]) =>
    canPerform(authorized.role, action) &&
    isActionAllowedForTenantStatus(effectiveStatus, action).allowed;

  const permissions: GroupedSettingsPermissions = {
    role: authorized.role,
    roleLabel: mapRoleLabel(authorized.role),
    tenantStatus: effectiveStatus,
    isLocked,
    canReadSettings: allow("settings:read"),
    canWriteSettings: allow("settings:write"),
    canPublishSettings: allow("settings:publish"),
    canManageDomains:
      canPerform(authorized.role, "domain:connect") || canPerform(authorized.role, "domain:read"),
    canManageMembers:
      canPerform(authorized.role, "member:invite") || canPerform(authorized.role, "member:read"),
    canAccessBilling: !isAgencyManaged && canPerform(authorized.role, "billing:read"),
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

// ---------------------------------------------------------------------------
// Published Public Defaults Bridge (Zero Draft Leakage)
// ---------------------------------------------------------------------------

export interface PublicSettingsDefaults {
  readonly published: GroupedSettingsSnapshot | null;
  readonly reading: PublicReadingDefaults;
  readonly seoDefaults: {
    readonly defaultTitle: string | null;
    readonly defaultDescription: string | null;
    readonly siteVisibility: "public" | "noindex";
    readonly ogImageMediaId: number | null;
    readonly googleSiteVerification: string | null;
    readonly bingSiteVerification: string | null;
  };
  readonly timezone: string;
  readonly locale: string;
  readonly version: number;
}

/**
 * Loads ONLY published public defaults from `TenantStore` (`site_settings` + `business_profile`).
 * Never reads `draft_json`.
 */
export async function loadPublishedPublicSettingsDefaults(
  tenantDb: D1Database,
): Promise<PublicSettingsDefaults> {
  const dto: PublishedGroupedSettingsDto | null = await getPublishedGroupedSettings(tenantDb);
  if (!dto) {
    return {
      published: null,
      reading: {
        homepageMode: "modular",
        homepagePageId: null,
        blogEnabled: true,
        catalogEnabled: true,
        enabledOfferingTypes: [...ALL_OFFERING_TYPES],
        itemsPerPage: 12,
      },
      seoDefaults: {
        defaultTitle: null,
        defaultDescription: null,
        siteVisibility: "public",
        ogImageMediaId: null,
        googleSiteVerification: null,
        bingSiteVerification: null,
      },
      timezone: "Asia/Jakarta",
      locale: "id-ID",
      version: 0,
    };
  }

  return {
    published: dto.settings,
    reading: {
      homepageMode: dto.settings.reading.homepageMode,
      homepagePageId: dto.settings.reading.homepagePageId,
      blogEnabled: dto.settings.reading.blogEnabled,
      catalogEnabled: dto.settings.reading.catalogEnabled,
      enabledOfferingTypes: dto.settings.reading.enabledOfferingTypes,
      itemsPerPage: dto.settings.reading.itemsPerPage,
    },
    seoDefaults: {
      defaultTitle: dto.settings.seo.defaultTitle,
      defaultDescription: dto.settings.seo.defaultDescription,
      siteVisibility: dto.settings.seo.siteVisibility,
      ogImageMediaId: dto.settings.seo.ogImageMediaId,
      googleSiteVerification: dto.settings.seo.googleSiteVerification,
      bingSiteVerification: dto.settings.seo.bingSiteVerification,
    },
    timezone: dto.settings.general.timezone,
    locale: dto.settings.general.locale,
    version: dto.version,
  };
}

/**
 * Applies published reading defaults onto a resolved `TenantShellData` object,
 * pruning disabled `/blog` and disabled catalog/offering links from public navigation menus
 * without modifying stored menu records.
 */
export function applyPublishedSettingsToShell(
  shell: TenantShellData,
  defaults: PublicSettingsDefaults,
): TenantShellData {
  const effectiveReading: PublicReadingDefaults = {
    ...defaults.reading,
    blogEnabled: shell.site.blogEnabled && defaults.reading.blogEnabled,
    catalogEnabled: shell.site.catalogEnabled && defaults.reading.catalogEnabled,
  };

  return {
    ...shell,
    menus: {
      header: filterPublicNavigationForSettings(shell.menus.header, effectiveReading),
      footer: filterPublicNavigationForSettings(shell.menus.footer, effectiveReading),
      mobile: filterPublicNavigationForSettings(shell.menus.mobile, effectiveReading),
    },
  };
}

export {
  filterPublicNavigationForSettings,
  FIXED_PUBLIC_ROUTES,
  formatDateOnlyPreservingSemantics,
  formatTimestampInTenantTimezone,
  isPublicRouteEnabledBySettings,
};

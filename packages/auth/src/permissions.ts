import type { ApiErrorCode, Role, SurfaceKind, TenantStatus } from "@punyasitus/core/schemas";

/**
 * Canonical PunyaSitus RBAC matrix, tenant-isolation assertion, and
 * surface-to-route access matrix (PLAN §2, §3.3, §4, §13, §16, §17.1; REQ-034).
 *
 * Core invariant: a tenant ID or handle is a selector, NEVER authorization.
 * Cross-tenant access always fails with 404 (not revealing existence);
 * same-tenant role denial fails with 403.
 */

export const CANONICAL_ROLES: readonly Role[] = [
  "owner",
  "admin",
  "editor",
  "platform_operator",
  "agency_admin",
] as const;

export type PermissionAction =
  // CMS & Content
  | "content:read"
  | "content:write"
  | "content:publish"
  | "media:upload"
  | "media:manage"
  | "taxonomy:manage"
  | "menu:manage"
  // Settings, Theme, Outlets, Analytics
  | "settings:read"
  | "settings:write"
  | "settings:publish"
  | "theme:activate"
  | "theme:custom_request"
  | "outlet:manage"
  | "analytics:read"
  // Leads
  | "lead:read"
  | "lead:update"
  | "lead:delete"
  | "lead:export_csv"
  // Domains
  | "domain:read"
  | "domain:connect"
  | "domain:recheck"
  | "domain:make_primary"
  | "domain:remove_inactive"
  | "domain:remove_active"
  // Members & Ownership
  | "member:read"
  | "member:invite"
  | "member:update_role"
  | "member:remove"
  | "tenant:transfer_owner"
  // Billing (payer only)
  | "billing:read"
  | "billing:pay"
  | "billing:recheck"
  | "billing:receipts"
  // Agency portal
  | "agency:portal:access"
  | "agency:tenants:manage"
  // Superadmin console (console.punyasitus.com)
  | "console:tenants:read"
  | "console:tenants:provision"
  | "console:tenants:state"
  | "console:themes:grant"
  | "console:domains:manage"
  | "console:jobs:retry"
  | "console:moderation:resolve"
  | "console:operators:manage"
  | "console:billing:recheck"
  | "console:audit:read"
  | "console:health:read";

const EDITOR_ACTIONS: readonly PermissionAction[] = [
  "content:read",
  "content:write",
  "content:publish",
  "media:upload",
  "media:manage",
  "taxonomy:manage",
  "menu:manage",
];

const ADMIN_ACTIONS: readonly PermissionAction[] = [
  ...EDITOR_ACTIONS,
  "settings:read",
  "settings:write",
  "settings:publish",
  "theme:activate",
  "theme:custom_request",
  "outlet:manage",
  "analytics:read",
  "lead:read",
  "lead:update",
  "lead:delete",
  "domain:read",
  "member:read",
];

const OWNER_ACTIONS: readonly PermissionAction[] = [
  ...ADMIN_ACTIONS,
  "lead:export_csv",
  "domain:connect",
  "domain:recheck",
  "domain:make_primary",
  "domain:remove_inactive",
  "member:invite",
  "member:update_role",
  "member:remove",
  "tenant:transfer_owner",
  "billing:read",
  "billing:pay",
  "billing:recheck",
  "billing:receipts",
];

const AGENCY_ADMIN_ACTIONS: readonly PermissionAction[] = [
  ...ADMIN_ACTIONS,
  "lead:export_csv",
  "domain:connect",
  "domain:recheck",
  "domain:make_primary",
  "domain:remove_inactive",
  "member:invite",
  "member:update_role",
  "member:remove",
  "billing:read",
  "billing:pay",
  "billing:recheck",
  "billing:receipts",
  "agency:portal:access",
  "agency:tenants:manage",
];

const PLATFORM_OPERATOR_ACTIONS: readonly PermissionAction[] = [
  "domain:remove_active",
  "console:tenants:read",
  "console:tenants:provision",
  "console:tenants:state",
  "console:themes:grant",
  "console:domains:manage",
  "console:jobs:retry",
  "console:moderation:resolve",
  "console:operators:manage",
  "console:billing:recheck",
  "console:audit:read",
  "console:health:read",
];

/**
 * Canonical role -> permission set matching PLAN §4.
 * Note: `platform_operator` is strictly separate from tenant organization roles;
 * operator actions inside a tenant require explicit audited tenant context (PLAN §4 & §13).
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<PermissionAction>>> = {
  owner: new Set(OWNER_ACTIONS),
  admin: new Set(ADMIN_ACTIONS),
  editor: new Set(EDITOR_ACTIONS),
  agency_admin: new Set(AGENCY_ADMIN_ACTIONS),
  platform_operator: new Set(PLATFORM_OPERATOR_ACTIONS),
};

const CONSOLE_ONLY_ACTIONS = new Set<PermissionAction>(PLATFORM_OPERATOR_ACTIONS);

const AGENCY_PORTAL_ACTIONS = new Set<PermissionAction>([
  "agency:portal:access",
  "agency:tenants:manage",
]);

const SENSITIVE_CONSOLE_REAUTH_ACTIONS = new Set<PermissionAction>([
  "console:operators:manage",
  "console:tenants:state",
  "console:domains:manage",
  "console:themes:grant",
  "domain:remove_active",
]);

const LOCKED_TENANT_ALLOWED_ACTIONS = new Set<PermissionAction>([
  "content:read",
  "settings:read",
  "analytics:read",
  "lead:read",
  "lead:export_csv",
  "domain:read",
  "member:read",
  "billing:read",
  "billing:pay",
  "billing:recheck",
  "billing:receipts",
]);

const SUSPENDED_TENANT_ALLOWED_ACTIONS = new Set<PermissionAction>([
  "lead:export_csv",
  "billing:read",
  "billing:pay",
  "billing:recheck",
  "billing:receipts",
]);

const AUDITED_OPERATOR_TENANT_ACTIONS = new Set<PermissionAction>([
  ...ADMIN_ACTIONS,
  "domain:connect",
  "domain:recheck",
  "domain:make_primary",
  "domain:remove_inactive",
  "member:invite",
  "member:remove",
]);

export function canPerform(role: Role, action: PermissionAction): boolean {
  return ROLE_PERMISSIONS[role].has(action);
}

export class AuthorizationError extends Error {
  readonly status: 401 | 403 | 404;
  readonly code: ApiErrorCode;

  constructor(status: 401 | 403 | 404, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.status = status;
    this.code = code;
  }
}

export interface AuditedTenantContext {
  readonly tenantId: string;
  readonly reason: string;
  readonly auditId: string;
}

export interface AuthorizationContext {
  readonly actorId: string | null;
  readonly surface: SurfaceKind;
  readonly role: Role;
  /** Primary verified tenant membership ID bound to the current request (never unverified client input). */
  readonly tenantId?: string | null;
  /** Optional explicit set of verified tenant IDs the actor is authorized to access. */
  readonly memberTenantIds?: ReadonlySet<string>;
  readonly tenantStatus?: TenantStatus;
  readonly platformGrantActive?: boolean;
  readonly totpVerified?: boolean;
  readonly reauthenticated?: boolean;
  readonly auditedTenantContext?: AuditedTenantContext | null;
}

function actorBelongsToTenant(ctx: AuthorizationContext, targetTenantId: string): boolean {
  if (ctx.tenantId && ctx.tenantId === targetTenantId) {
    return true;
  }
  if (ctx.memberTenantIds?.has(targetTenantId)) {
    return true;
  }
  return false;
}

/**
 * Authoritative server-side RBAC + tenant-scope + service-state assertion (PLAN §4, §13, §17.1).
 *
 * - Unauthenticated actor -> 401 UNAUTHENTICATED
 * - Wrong surface for console/app routes -> 404 NOT_FOUND
 * - Cross-tenant target -> 404 NOT_FOUND (never reveals whether another tenant exists)
 * - Role denial within a valid tenant -> 403 FORBIDDEN
 * - Missing mandatory TOTP / recent reauth -> 403 TOTP_REQUIRED / REAUTH_REQUIRED
 * - Locked / suspended / trial domain restriction -> 403 SUBSCRIPTION_LOCKED / TRIAL_DOMAIN_FORBIDDEN
 */
export function assertAuthorized(
  ctx: AuthorizationContext,
  action: PermissionAction,
  targetTenantId?: string,
): void {
  if (!ctx.actorId) {
    throw new AuthorizationError(401, "UNAUTHENTICATED", "Authentication is required");
  }

  // 1. Platform console actions (`console.punyasitus.com`)
  if (CONSOLE_ONLY_ACTIONS.has(action)) {
    if (ctx.surface !== "console") {
      throw new AuthorizationError(
        404,
        "NOT_FOUND",
        "Console operations are only available on console.punyasitus.com",
      );
    }
    if (ctx.role !== "platform_operator" || !ctx.platformGrantActive) {
      throw new AuthorizationError(
        403,
        "FORBIDDEN",
        "Active platform operator grant is required",
      );
    }
    if (!ctx.totpVerified) {
      throw new AuthorizationError(
        403,
        "TOTP_REQUIRED",
        "Verified TOTP two-factor authentication is required for platform operators",
      );
    }
    if (SENSITIVE_CONSOLE_REAUTH_ACTIONS.has(action) && !ctx.reauthenticated) {
      throw new AuthorizationError(
        403,
        "REAUTH_REQUIRED",
        "Recent second-factor reauthentication within 10 minutes is required",
      );
    }
    return;
  }

  // 2. Agency portal actions (`app.punyasitus.com/agency`)
  if (AGENCY_PORTAL_ACTIONS.has(action)) {
    if (ctx.surface !== "app") {
      throw new AuthorizationError(404, "NOT_FOUND", "Agency portal is only served on app surface");
    }
    if (ctx.role !== "agency_admin") {
      throw new AuthorizationError(403, "FORBIDDEN", "Agency admin role is required");
    }
    if (!ctx.totpVerified) {
      throw new AuthorizationError(
        403,
        "TOTP_REQUIRED",
        "TOTP two-factor authentication is required for agency admins",
      );
    }
    return;
  }

  // 3. Tenant-scoped actions (`app.punyasitus.com/api/tenants/{tenantId}/...`)
  if (ctx.surface !== "app") {
    throw new AuthorizationError(
      404,
      "NOT_FOUND",
      "Tenant admin APIs are only served on app.punyasitus.com",
    );
  }

  if (!targetTenantId || targetTenantId.trim().length === 0) {
    throw new AuthorizationError(404, "NOT_FOUND", "Target tenant selector is missing");
  }

  // Platform operator accessing a tenant requires explicit audited tenant context
  if (ctx.role === "platform_operator") {
    if (!ctx.platformGrantActive) {
      throw new AuthorizationError(403, "FORBIDDEN", "Platform operator grant is inactive");
    }
    if (!ctx.totpVerified) {
      throw new AuthorizationError(403, "TOTP_REQUIRED", "TOTP is required for platform operators");
    }
    const audited = ctx.auditedTenantContext;
    if (!audited || audited.tenantId !== targetTenantId) {
      throw new AuthorizationError(
        404,
        "NOT_FOUND",
        "No active audited operator context matches the requested tenant",
      );
    }
    if (audited.reason.trim().length < 10 || !AUDITED_OPERATOR_TENANT_ACTIONS.has(action)) {
      throw new AuthorizationError(
        403,
        "FORBIDDEN",
        "Action is not permitted under audited operator tenant context",
      );
    }
    return;
  }

  // Tenant ID / handle is a selector only — verify actor membership for targetTenantId first!
  if (!actorBelongsToTenant(ctx, targetTenantId)) {
    throw new AuthorizationError(
      404,
      "NOT_FOUND",
      "Requested tenant was not found for this account",
    );
  }

  if (ctx.role === "agency_admin" && !ctx.totpVerified) {
    throw new AuthorizationError(
      403,
      "TOTP_REQUIRED",
      "TOTP two-factor authentication is required for agency admins",
    );
  }

  if (!canPerform(ctx.role, action)) {
    throw new AuthorizationError(
      403,
      "FORBIDDEN",
      `Role "${ctx.role}" is not permitted to perform "${action}"`,
    );
  }

  if (action === "tenant:transfer_owner" && !ctx.reauthenticated) {
    throw new AuthorizationError(
      403,
      "REAUTH_REQUIRED",
      "Recent reauthentication is required to transfer tenant ownership",
    );
  }

  // Service lifecycle overrides (PLAN §4 & §17.1)
  if (ctx.tenantStatus) {
    if (ctx.tenantStatus === "trial" && action === "domain:connect") {
      throw new AuthorizationError(
        403,
        "TRIAL_DOMAIN_FORBIDDEN",
        "Custom domains cannot be connected during the 7-day trial",
      );
    }
    if (ctx.tenantStatus === "locked" && !LOCKED_TENANT_ALLOWED_ACTIONS.has(action)) {
      throw new AuthorizationError(
        403,
        "SUBSCRIPTION_LOCKED",
        "Tenant is locked (read, leads CSV export, and renewal payment only)",
      );
    }
    if (ctx.tenantStatus === "suspended" && !SUSPENDED_TENANT_ALLOWED_ACTIONS.has(action)) {
      throw new AuthorizationError(
        403,
        "SUBSCRIPTION_LOCKED",
        "Tenant is suspended (renewal payment and leads CSV recovery only)",
      );
    }
    if (ctx.tenantStatus === "recovery" || ctx.tenantStatus === "purging") {
      throw new AuthorizationError(
        403,
        "SUBSCRIPTION_LOCKED",
        `Tenant operations are unavailable while status is "${ctx.tenantStatus}"`,
      );
    }
    if (ctx.tenantStatus === "purged") {
      throw new AuthorizationError(404, "NOT_FOUND", "Tenant has been purged");
    }
  }
}

export type RouteGroup =
  | "marketing_public"
  | "app_dashboard"
  | "app_agency"
  | "app_affiliate"
  | "app_auth"
  | "app_account"
  | "app_tenant_api"
  | "app_mcp_oauth"
  | "console_ui"
  | "console_api"
  | "tenant_public_site"
  | "tenant_dcv_well_known"
  | "tenant_anonymous_post_api";

/**
 * Canonical 4-surface route access matrix (PLAN §2 & §3.3).
 * Any route group NOT allowed on a surface must return neutral 404 (or 301 for marketing redirect on app/console).
 */
export const SURFACE_ROUTE_ACCESS_MATRIX: Readonly<Record<SurfaceKind, ReadonlySet<RouteGroup>>> = {
  marketing: new Set<RouteGroup>(["marketing_public"]),
  app: new Set<RouteGroup>([
    "app_dashboard",
    "app_agency",
    "app_affiliate",
    "app_auth",
    "app_account",
    "app_tenant_api",
    "app_mcp_oauth",
  ]),
  console: new Set<RouteGroup>(["console_ui", "console_api", "app_auth"]),
  tenant: new Set<RouteGroup>([
    "tenant_public_site",
    "tenant_dcv_well_known",
    "tenant_anonymous_post_api",
  ]),
};

export function isRouteGroupAllowedOnSurface(surface: SurfaceKind, group: RouteGroup): boolean {
  return SURFACE_ROUTE_ACCESS_MATRIX[surface].has(group);
}

const TENANT_ANONYMOUS_API_PATHS = new Set<string>([
  "/api/leads",
  "/api/events",
  "/api/abuse-report",
]);

const PLATFORM_ONLY_PREFIXES = [
  "/dashboard",
  "/agency",
  "/affiliate",
  "/console",
  "/auth",
  "/account",
  "/mcp",
  "/oauth2",
  "/api/console",
  "/api/tenants",
  "/api/auth",
  "/api/account",
] as const;

export interface SurfaceRouteCheckResult {
  readonly allowed: boolean;
  readonly status: 200 | 404;
  readonly reason: string;
}

/**
 * Evaluates whether a pathname may be routed on a given classified host surface (PLAN §2 & §3.3).
 */
export function checkSurfaceRouteAccess(
  surface: SurfaceKind,
  pathname: string,
): SurfaceRouteCheckResult {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;

  if (surface === "tenant") {
    if (
      normalized.startsWith("/.well-known/pki-validation/") ||
      normalized.startsWith("/.well-known/acme-challenge/")
    ) {
      return { allowed: true, status: 200, reason: "HTTP DCV pass-through" };
    }
    if (TENANT_ANONYMOUS_API_PATHS.has(normalized)) {
      return { allowed: true, status: 200, reason: "Host-scoped anonymous tenant POST endpoint" };
    }
    if (normalized.startsWith("/api/")) {
      return { allowed: false, status: 404, reason: "Non-public API path denied on tenant host" };
    }
    for (const prefix of PLATFORM_ONLY_PREFIXES) {
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
        return {
          allowed: false,
          status: 404,
          reason: `Platform prefix "${prefix}" returns 404 on tenant hosts`,
        };
      }
    }
    return { allowed: true, status: 200, reason: "Public tenant site route" };
  }

  if (surface === "console") {
    if (
      normalized === "/" ||
      normalized.startsWith("/api/console") ||
      normalized.startsWith("/api/auth") ||
      normalized.startsWith("/auth") ||
      normalized.startsWith("/tenants") ||
      normalized.startsWith("/domains") ||
      normalized.startsWith("/jobs") ||
      normalized.startsWith("/audit") ||
      normalized.startsWith("/health") ||
      normalized.startsWith("/operators") ||
      normalized.startsWith("/settings") ||
      normalized.startsWith("/custom-themes")
    ) {
      return { allowed: true, status: 200, reason: "Console surface route" };
    }
    return { allowed: false, status: 404, reason: "Route not exposed on console.punyasitus.com" };
  }

  if (surface === "app") {
    if (
      normalized.startsWith("/console") ||
      normalized.startsWith("/api/console") ||
      TENANT_ANONYMOUS_API_PATHS.has(normalized)
    ) {
      return { allowed: false, status: 404, reason: "Console or tenant-host route denied on app surface" };
    }
    if (
      normalized === "/" ||
      normalized.startsWith("/dashboard") ||
      normalized.startsWith("/agency") ||
      normalized.startsWith("/affiliate") ||
      normalized.startsWith("/auth") ||
      normalized.startsWith("/account") ||
      normalized.startsWith("/api/auth") ||
      normalized.startsWith("/api/account") ||
      normalized.startsWith("/api/tenants/") ||
      normalized.startsWith("/api/agency") ||
      normalized.startsWith("/api/affiliate") ||
      normalized === "/mcp" ||
      normalized.startsWith("/oauth2/") ||
      normalized.startsWith("/.well-known/oauth-")
    ) {
      return { allowed: true, status: 200, reason: "App surface route" };
    }
    return { allowed: false, status: 404, reason: "Route not exposed on app.punyasitus.com" };
  }

  // marketing (`punyasitus.com`)
  if (
    normalized === "/" ||
    normalized.startsWith("/pricing") ||
    normalized.startsWith("/demo") ||
    normalized.startsWith("/legal") ||
    normalized === "/api/marketing/events"
  ) {
    return { allowed: true, status: 200, reason: "Marketing surface route" };
  }
  return { allowed: false, status: 404, reason: "Route not exposed on marketing surface" };
}

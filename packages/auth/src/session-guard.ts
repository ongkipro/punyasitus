import type { ApiErrorCode, Role, SurfaceKind, TenantStatus } from "@punyasitus/core/schemas";
import { createSqliteDrizzle } from "@punyasitus/db/connections";
import { members, platformSchema, tenants } from "@punyasitus/db/platform";
import { and, eq } from "drizzle-orm";
import { hasHostSessionCookie } from "./cookies.ts";
import { assertAuthorized, AuthorizationError, type PermissionAction } from "./permissions.ts";

/**
 * Server-side CSRF/Origin, MCP bearer-only, and live membership guards (PLAN §4, §17.1; REQ-034).
 *
 * Core invariants:
 * - Cookie-authenticated state-changing admin requests require `Content-Type: application/json`
 *   AND `Origin === expectedAdminOrigin` (never accepts tenant subdomain origins or null/missing Origin).
 * - `/mcp`, `/oauth2/token`, `/oauth2/register`, and `/.well-known/oauth-*` NEVER accept
 *   `__Host-` session cookies as authentication credentials.
 * - Tenant membership is rechecked live against `PLATFORM_DB` (`tenants JOIN members`) on every
 *   request: revoked/non-member handles return 404 (not 403); valid members lacking role permission
 *   return 403; forged `activeOrganizationId` / org selectors are rejected.
 */

const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const GRACE_WINDOW_MS = 72 * 60 * 60 * 1000; // H+1..H+3
const LOCKED_WINDOW_MS = 168 * 60 * 60 * 1000; // H+4..H+7

export interface GuardCheckSuccess {
  readonly ok: true;
}

export interface GuardCheckFailure {
  readonly ok: false;
  readonly status: 401 | 403 | 404;
  readonly code: ApiErrorCode;
  readonly reason: string;
}

export type GuardCheckResult = GuardCheckSuccess | GuardCheckFailure;

function normalizeOriginString(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      // Exact origin headers never contain path/query/hash
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function isJsonContentType(contentTypeHeader: string | null): boolean {
  if (!contentTypeHeader) return false;
  const mediaType = (contentTypeHeader.split(";")[0] ?? "").trim().toLowerCase();
  return mediaType === "application/json";
}

/**
 * Computes the exact expected admin Origin for CSRF verification.
 * Returns `null` when the surface is not an authenticated platform surface.
 */
export function resolveExpectedAdminOrigin(
  request: Request,
  options: {
    readonly surface: SurfaceKind | "unknown";
    readonly platformDomain?: string;
    readonly isLocalLoopback?: boolean;
  },
): string | null {
  if (options.isLocalLoopback) {
    try {
      const url = new URL(request.url);
      return url.origin;
    } catch {
      return null;
    }
  }

  const domain = (options.platformDomain ?? "punyasitus.com").trim().toLowerCase();
  if (options.surface === "app") {
    return `https://app.${domain}`;
  }
  if (options.surface === "console") {
    return `https://console.${domain}`;
  }
  return null;
}

/**
 * Enforces PLAN §4 admin CSRF & Origin rules for state-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`):
 * 1. `Content-Type` media type MUST be `application/json`.
 * 2. `Origin` header MUST be present, non-null, and EXACTLY equal to `expectedAdminOrigin`
 *    (rejects tenant subdomains `*.situsku.click`, custom domains, marketing apex, null/missing Origin).
 */
export function assertAdminCsrfAndOrigin(
  request: Request,
  expectedAdminOrigin: string,
): GuardCheckResult {
  const method = request.method.toUpperCase();
  if (SAFE_HTTP_METHODS.has(method)) {
    return { ok: true };
  }

  const normalizedExpected = normalizeOriginString(expectedAdminOrigin);
  if (!normalizedExpected) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      reason: "Expected admin origin is invalid",
    };
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      reason: "State-changing admin requests require Content-Type: application/json",
    };
  }

  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      reason: "Missing Origin header on state-changing admin request",
    };
  }

  const normalizedOrigin = normalizeOriginString(rawOrigin);
  if (!normalizedOrigin || normalizedOrigin !== normalizedExpected) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      reason: `Origin "${rawOrigin}" does not match expected admin origin "${normalizedExpected}"`,
    };
  }

  return { ok: true };
}

/**
 * Returns true if `pathname` is an MCP or OAuth 2.1 non-cookie protocol endpoint (PLAN §4, ADR-0008).
 */
export function isMcpOrOAuthProtocolPath(pathname: string): boolean {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return (
    normalized === "/mcp" ||
    normalized.startsWith("/mcp/") ||
    normalized === "/oauth2/token" ||
    normalized === "/oauth2/revoke" ||
    normalized === "/oauth2/register" ||
    normalized.startsWith("/.well-known/oauth-")
  );
}

/**
 * Enforces PLAN §4 MCP/OAuth bearer-only boundary:
 * Rejects any request on `/mcp`, `/oauth2/token`, `/oauth2/register`, or `/.well-known/oauth-*`
 * that attempts to authenticate using `__Host-` session cookies.
 */
export function assertMcpBearerOnly(request: Request): GuardCheckResult {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHENTICATED",
      reason: "Malformed request URL",
    };
  }

  if (!isMcpOrOAuthProtocolPath(pathname)) {
    return { ok: true };
  }

  const cookieHeader = request.headers.get("cookie");
  if (hasHostSessionCookie(cookieHeader)) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHENTICATED",
      reason: "Session cookies are never accepted as MCP or OAuth bearer credentials",
    };
  }

  return { ok: true };
}

/**
 * Maps a persisted `members.role` value from `PLATFORM_DB` to the canonical RBAC `Role`.
 */
export function mapMemberRoleToCanonicalRole(
  dbRole: "owner" | "admin" | "editor" | "agency_staff" | "setup_staff",
): Role {
  if (dbRole === "owner" || dbRole === "admin" || dbRole === "editor") {
    return dbRole;
  }
  if (dbRole === "agency_staff") {
    return "agency_admin";
  }
  return "editor";
}

function computeEffectiveTenantStatus(
  row: {
    readonly status: TenantStatus;
    readonly operatorHold: boolean;
    readonly trialEndsAt: Date | null;
    readonly paidThrough: Date | null;
  },
  nowMs: number,
): TenantStatus {
  if (row.status === "provisioning" || row.status === "purging" || row.status === "purged") {
    return row.status;
  }
  if (row.operatorHold) return "suspended";
  if (row.status === "recovery") return "recovery";

  if (row.paidThrough) {
    const paidMs = row.paidThrough.getTime();
    if (nowMs < paidMs) return "active";
    if (nowMs < paidMs + GRACE_WINDOW_MS) return "grace";
    if (nowMs < paidMs + LOCKED_WINDOW_MS) return "locked";
    return "suspended";
  }

  if (row.trialEndsAt) {
    return nowMs < row.trialEndsAt.getTime() ? "trial" : "suspended";
  }

  return row.status;
}

export interface ResolveAuthorizedTenantMemberParams {
  readonly userId: string;
  readonly handle?: string;
  readonly tenantId?: string;
  readonly requiredPermission?: PermissionAction;
  readonly surface?: SurfaceKind;
  /** Optional organization selector (e.g. session.activeOrganizationId or client param) to verify against forgery. */
  readonly claimedOrganizationId?: string | null;
  readonly totpVerified?: boolean;
  readonly reauthenticated?: boolean;
  readonly nowMs?: number;
}

export interface AuthorizedTenantMember {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly tenantStatus: TenantStatus;
  readonly memberId: string;
  readonly userId: string;
  readonly dbRole: "owner" | "admin" | "editor" | "agency_staff" | "setup_staff";
  readonly role: Role;
}

/**
 * Authoritatively rechecks live tenant membership in `PLATFORM_DB` (`tenants JOIN members`)
 * on EVERY request (PLAN §4; REQ-034).
 *
 * - Non-existent handle/tenantId, purged tenant, or non-member/revoked user -> throws 404 `NOT_FOUND`
 * - Forged `claimedOrganizationId` that does not match the resolved tenant's organization -> throws 403 `FORBIDDEN`
 * - Valid member whose role lacks `requiredPermission` -> throws 403 `FORBIDDEN` (via `assertAuthorized`)
 */
export async function resolveAuthorizedTenantMember(
  platformDb: D1Database,
  params: ResolveAuthorizedTenantMemberParams,
): Promise<AuthorizedTenantMember> {
  const userId = params.userId.trim();
  if (!userId) {
    throw new AuthorizationError(401, "UNAUTHENTICATED", "Authentication is required");
  }

  const handle = params.handle?.trim().toLowerCase();
  const tenantId = params.tenantId?.trim();
  if (!handle && !tenantId) {
    throw new AuthorizationError(404, "NOT_FOUND", "Target tenant selector is missing");
  }

  const db = createSqliteDrizzle(platformDb, platformSchema);
  const selectorCondition = tenantId
    ? handle
      ? and(eq(tenants.id, tenantId), eq(tenants.handle, handle))
      : eq(tenants.id, tenantId)
    : eq(tenants.handle, handle ?? "");

  const rows = await db
    .select({
      tenantId: tenants.id,
      organizationId: tenants.organizationId,
      handle: tenants.handle,
      tenantName: tenants.name,
      status: tenants.status,
      operatorHold: tenants.operatorHold,
      trialEndsAt: tenants.trialEndsAt,
      paidThrough: tenants.paidThrough,
      memberId: members.id,
      memberRole: members.role,
    })
    .from(tenants)
    .innerJoin(
      members,
      and(eq(members.organizationId, tenants.organizationId), eq(members.userId, userId)),
    )
    .where(selectorCondition)
    .limit(1);

  const row = rows[0];
  if (!row || row.status === "purged") {
    throw new AuthorizationError(404, "NOT_FOUND", "Requested tenant was not found for this account");
  }

  if (
    params.claimedOrganizationId !== undefined &&
    params.claimedOrganizationId !== null &&
    params.claimedOrganizationId.trim().length > 0 &&
    params.claimedOrganizationId.trim() !== row.organizationId
  ) {
    throw new AuthorizationError(
      403,
      "FORBIDDEN",
      "Organization selector does not match the authorized tenant",
    );
  }

  const effectiveStatus = computeEffectiveTenantStatus(
    {
      status: row.status,
      operatorHold: row.operatorHold,
      trialEndsAt: row.trialEndsAt,
      paidThrough: row.paidThrough,
    },
    params.nowMs ?? Date.now(),
  );

  const canonicalRole = mapMemberRoleToCanonicalRole(row.memberRole);

  if (params.requiredPermission) {
    assertAuthorized(
      {
        actorId: userId,
        surface: params.surface ?? "app",
        role: canonicalRole,
        tenantId: row.tenantId,
        tenantStatus: effectiveStatus,
        totpVerified: params.totpVerified,
        reauthenticated: params.reauthenticated,
      },
      params.requiredPermission,
      row.tenantId,
    );
  }

  return {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    handle: row.handle,
    tenantName: row.tenantName,
    tenantStatus: effectiveStatus,
    memberId: row.memberId,
    userId,
    dbRole: row.memberRole,
    role: canonicalRole,
  };
}

/**
 * Rechecks live organization membership in `PLATFORM_DB` to reject forged `activeOrganizationId`
 * selectors or revoked memberships.
 */
export async function assertOrganizationMembership(
  platformDb: D1Database,
  userId: string,
  organizationId: string,
): Promise<{
  readonly memberId: string;
  readonly organizationId: string;
  readonly dbRole: "owner" | "admin" | "editor" | "agency_staff" | "setup_staff";
  readonly role: Role;
}> {
  const cleanUser = userId.trim();
  const cleanOrg = organizationId.trim();
  if (!cleanUser) {
    throw new AuthorizationError(401, "UNAUTHENTICATED", "Authentication is required");
  }
  if (!cleanOrg) {
    throw new AuthorizationError(404, "NOT_FOUND", "Organization selector is missing");
  }

  const db = createSqliteDrizzle(platformDb, platformSchema);
  const rows = await db
    .select({
      memberId: members.id,
      organizationId: members.organizationId,
      role: members.role,
    })
    .from(members)
    .where(and(eq(members.userId, cleanUser), eq(members.organizationId, cleanOrg)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new AuthorizationError(
      403,
      "FORBIDDEN",
      "You are not an active member of the requested organization",
    );
  }

  return {
    memberId: row.memberId,
    organizationId: row.organizationId,
    dbRole: row.role,
    role: mapMemberRoleToCanonicalRole(row.role),
  };
}

import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
  type PermissionAction,
} from "@punyasitus/auth";
import {
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  StaleRevisionError,
} from "@punyasitus/core/content/index";
import type { EmailPort } from "@punyasitus/core/email/index";
import {
  buildPreviewResponseHeaders,
  PREVIEW_API_CSP_HEADER,
  PREVIEW_IFRAME_SANDBOX,
  PreviewPayloadTooLargeError,
  PreviewThemeError,
  PreviewValidationError,
} from "@punyasitus/core/preview/index";
import {
  FORBIDDEN_TENANT_SELECTOR_KEYS,
  type ApiErrorCode,
  type Role,
  type TenantStatus,
} from "@punyasitus/core/schemas";
import {
  evaluateThemeCompatibility,
  SectionRegistryValidationError,
  ThemeIncompatibleError,
  ThemeNotFoundError,
  ThemeNotGrantedError,
  ThemeValidationError,
  type ThemeCompatibilityCandidate,
  type ThemeCompatibilityReport,
  type ThemeConfigSnapshot,
  type ThemeLibraryErrorCode,
  type ThemeRequiredModule,
  type ThemeTokens,
} from "@punyasitus/core/theme/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  activateTenantThemeAtomically,
  loadTenantPlatformThemeContext,
  loadTenantThemeLibraryDbState,
  type TenantPlatformThemeContext,
  type TenantThemeLibraryDbState,
} from "@punyasitus/db/themes/index";
import {
  renderSemanticPreviewShellFallback,
  renderTenantDraftPreview,
  type RenderPreviewShellDocumentFn,
} from "../../../../../core/preview/service.ts";
import type { ThemeSurfacePalette } from "../../../../../core/public-data.ts";
import {
  buildThemeCompatibilityCandidate,
  listGrantedThemesForTenant,
  resolveGrantedThemeForActivation,
  type RegisteredThemeEntry,
  type TenantThemeEntitlementContext,
} from "../../../../../core/theme-registry.ts";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared authorization, strict DTO validation, grant filtering, compatibility evaluation,
 * draft compatibility preview, and atomic activation helpers for
 * `/api/tenants/:tenantId/themes/**` (REQ-046, REQ-018, REQ-021, REQ-034, REQ-036; TASK-042).
 */

export const MAX_THEMES_BODY_BYTES = 65_536 as const; // 64 KiB hard ceiling
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const THEMES_FORBIDDEN_SELECTOR_KEYS = [
  ...FORBIDDEN_TENANT_SELECTOR_KEYS,
  "userId",
  "user_id",
  "ownerId",
  "owner_id",
  "role",
  "roles",
  "actorId",
  "actor_id",
  "platformOperator",
  "isSuperadmin",
] as const;

const FORBIDDEN_SELECTOR_KEY_SET: ReadonlySet<string> = new Set(THEMES_FORBIDDEN_SELECTOR_KEYS);

export const THEMES_PREVIEW_ALLOWED_KEYS: ReadonlySet<string> = new Set(["themeId"]);

export const THEMES_ACTIVATE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "themeId",
  "expectedVersion",
  "version",
  "confirm",
]);

export const THEMES_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export type ThemesApiErrorCode = ApiErrorCode | ThemeLibraryErrorCode;

export interface TenantThemesRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface ExtraRegisteredThemeSpec extends RegisteredThemeEntry {
  readonly requiredModules?: readonly ThemeRequiredModule[];
}

export interface TenantThemesHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
  readonly renderShellDocument?: RenderPreviewShellDocumentFn;
  /** Test-only extension hook to register synthetic custom themes with restricted compatibility. */
  readonly extraRegisteredThemes?: readonly ExtraRegisteredThemeSpec[];
}

export interface AuthorizedThemesRequestContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
}

export interface ThemeLibraryItemDto {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly schemaVersion: number;
  readonly tier: "included" | "custom";
  readonly isCustom: boolean;
  readonly isActive: boolean;
  readonly isRecommended: boolean;
  readonly grantSource: "platform_included" | "tenant_grant" | "agency_grant";
  readonly grantedAt: string | null;
  readonly hasSavedConfig: boolean;
  readonly savedConfigUpdatedAt: string | null;
  readonly savedTokens: ThemeTokens | null;
  readonly defaultTokens: ThemeTokens;
  readonly palette: ThemeSurfacePalette;
  readonly recommendedOfferingTypes: readonly string[];
  readonly supportedRoutes: readonly string[];
  readonly supportedSectionTypes: readonly string[];
  readonly compatibility: ThemeCompatibilityReport;
}

export interface ThemeLibraryStateDto {
  readonly tenantId: string;
  readonly handle: string;
  readonly vertical: string;
  readonly activeThemeId: string;
  readonly version: number;
  readonly cacheVersion: number;
  readonly themes: readonly ThemeLibraryItemDto[];
  readonly contentSummary: {
    readonly pages: number;
    readonly posts: number;
    readonly offerings: number;
    readonly menus: number;
    readonly media: number;
  };
  readonly permissions: {
    readonly canPreview: boolean;
    readonly canActivate: boolean;
    readonly isLocked: boolean;
    readonly role: Role;
    readonly tenantStatus: TenantStatus;
  };
  readonly updatedAt: string | null;
}

export interface ThemeLibraryPreviewResultDto {
  readonly html: string;
  readonly themeId: string;
  readonly themeName: string;
  readonly isCustom: boolean;
  readonly sandbox: typeof PREVIEW_IFRAME_SANDBOX;
  readonly compatibility: ThemeCompatibilityReport;
  readonly hasSavedConfig: boolean;
  readonly isPreview: true;
  readonly version: number;
}

export interface ThemeLibraryActivateResultDto extends ThemeLibraryStateDto {
  readonly activatedThemeId: string;
  readonly previousThemeId: string;
  readonly recoveredExistingConfig: boolean;
  readonly activatedAt: string;
}

export interface ThemeLibraryMemberScope {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly userId: string;
  readonly role: Role;
  readonly tenantStatus: TenantStatus;
}

export function createThemesRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function themesJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(THEMES_NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function themesPreviewJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = buildPreviewResponseHeaders({
    contentType: "application/json; charset=utf-8",
    csp: PREVIEW_API_CSP_HEADER,
    extraHeaders,
  });
  return new Response(JSON.stringify(body), { status, headers });
}

export function themesErrorResponse(
  status: number,
  code: ThemesApiErrorCode,
  message: string,
  requestId: string,
  options: {
    readonly fields?: readonly {
      readonly field: string;
      readonly code: string;
      readonly message: string;
    }[];
    readonly compatibility?: ThemeCompatibilityReport;
    readonly extraHeaders?: HeadersInit;
  } = {},
): Response {
  return themesJsonResponse(
    status,
    {
      error: {
        code,
        message,
        ...(options.fields && options.fields.length > 0 ? { fields: options.fields } : {}),
        ...(options.compatibility ? { compatibility: options.compatibility } : {}),
      },
      requestId,
    },
    options.extraHeaders,
  );
}

/**
 * Enforces:
 * 1. Platform `app` host isolation (`404` on tenant/console/marketing hosts).
 * 2. CSRF & Origin check on state-changing methods (`403` on missing/mismatched Origin or non-JSON).
 * 3. Better Auth session verification + `enforceSessionLifetimeCeiling` (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership + RBAC + tenant lifecycle status gate (`404` cross-tenant/non-member,
 *    `403 FORBIDDEN` wrong role, `403 SUBSCRIPTION_LOCKED` on locked/suspended write).
 * 5. Opens ONLY the verified tenant's physically isolated `TenantStore`.
 */
export async function authorizeTenantThemesRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantThemesRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantThemesHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedThemesRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createThemesRequestId();

  // 1. Platform app host isolation
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: themesErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin check on state-changing methods
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: themesErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: themesErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        { extraHeaders: { "Retry-After": "60" } },
      ),
    };
  }

  // 4. Verify Better Auth session + lifetime ceiling
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: themesErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Konfigurasi autentikasi belum lengkap.",
          requestId,
          { extraHeaders: { "Retry-After": "60" } },
        ),
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
          userId = sessionResult.user.id;
          const rawSession = sessionResult.session as typeof sessionResult.session & {
            activeOrganizationId?: string | null;
          };
          activeOrganizationId = rawSession.activeOrganizationId ?? null;
        }
      }
    } catch {
      userId = null;
    }
  }

  if (!userId) {
    return {
      ok: false,
      response: themesErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Sesi Anda telah berakhir atau tidak valid. Silakan masuk kembali untuk mengelola tema.",
        requestId,
      ),
    };
  }

  // 5. Live membership + RBAC + tenant status check
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: themesErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  const isUlidSelector = ULID_PATTERN.test(trimmedSelector);
  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      ...(isUlidSelector ? { tenantId: trimmedSelector } : { handle: trimmedSelector }),
      requiredPermission,
      surface: "app",
      claimedOrganizationId: activeOrganizationId,
      nowMs: options.nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        response: themesErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: themesErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        { extraHeaders: { "Retry-After": "60" } },
      ),
    };
  }

  // 6. Open ONLY verified tenant's isolated TenantStore
  let tenantDb: D1Database | null = null;
  if (options.resolveTenantDb) {
    tenantDb = await options.resolveTenantDb(member.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
  }

  if (!tenantDb) {
    return {
      ok: false,
      response: themesErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan data tenant sementara tidak tersedia.",
        requestId,
        { extraHeaders: { "Retry-After": "60" } },
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      requestId,
      member,
      platformDb: runtimeEnv.PLATFORM_DB,
      tenantDb,
    },
  };
}

function findNestedForbiddenKey(value: unknown, pathPrefix = ""): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNestedForbiddenKey(value[i], `${pathPrefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (FORBIDDEN_SELECTOR_KEY_SET.has(key)) {
      return nextPath;
    }
    const hit = findNestedForbiddenKey(nested, nextPath);
    if (hit) return hit;
  }
  return null;
}

export async function parseStrictThemesJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  let rawBytes: Uint8Array;
  try {
    rawBytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return {
      ok: false,
      response: themesErrorResponse(400, "BAD_REQUEST", "Gagal membaca body permintaan.", requestId),
    };
  }

  if (rawBytes.byteLength > MAX_THEMES_BODY_BYTES) {
    return {
      ok: false,
      response: themesErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_THEMES_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (!rawText) {
    return {
      ok: false,
      response: themesErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: themesErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: themesErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
        {
          fields: [{ field: "body", code: "INVALID_PAYLOAD", message: "Expected a JSON object." }],
        },
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  const forbiddenPath = findNestedForbiddenKey(record);
  if (forbiddenPath) {
    return {
      ok: false,
      response: themesErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Field "${forbiddenPath}" tidak diizinkan dalam body permintaan tema.`,
        requestId,
        {
          fields: [
            {
              field: forbiddenPath,
              code: "FORBIDDEN_TENANT_SELECTOR",
              message: `Forbidden selector or privilege field "${forbiddenPath}" is not allowed.`,
            },
          ],
        },
      ),
    };
  }

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        response: themesErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field tidak dikenal "${key}".`,
          requestId,
          {
            fields: [
              {
                field: key,
                code: "UNKNOWN_FIELD",
                message: `Unknown field "${key}" is not allowed.`,
              },
            ],
          },
        ),
      };
    }
  }

  return { ok: true, body: record };
}

function isValidVersionInt(val: unknown): val is number {
  return typeof val === "number" && Number.isSafeInteger(val) && val >= 0 && val <= 2_147_483_647;
}

export function extractThemesExpectedVersion(
  body: Record<string, unknown>,
  requestId: string,
):
  | { readonly ok: true; readonly expectedVersion: number }
  | { readonly ok: false; readonly response: Response } {
  const hasVersion = body.version !== undefined;
  const hasExpectedVersion = body.expectedVersion !== undefined;

  if (hasVersion && hasExpectedVersion && body.version !== body.expectedVersion) {
    return {
      ok: false,
      response: themesErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version dan expectedVersion harus sama bila keduanya diberikan.",
        requestId,
        {
          fields: [
            {
              field: "expectedVersion",
              code: "INVALID_VERSION",
              message: "Conflicting version and expectedVersion values.",
            },
          ],
        },
      ),
    };
  }

  const raw = hasExpectedVersion ? body.expectedVersion : body.version;
  if (raw === undefined) {
    return {
      ok: false,
      response: themesErrorResponse(
        422,
        "VALIDATION_ERROR",
        "expectedVersion wajib disertakan untuk melindungi aktivasi tema dari konflik versi.",
        requestId,
        {
          fields: [
            {
              field: "expectedVersion",
              code: "REQUIRED",
              message: "expectedVersion is required for theme activation.",
            },
          ],
        },
      ),
    };
  }

  if (!isValidVersionInt(raw)) {
    return {
      ok: false,
      response: themesErrorResponse(
        422,
        "VALIDATION_ERROR",
        "expectedVersion harus berupa bilangan bulat non-negatif.",
        requestId,
        {
          fields: [
            {
              field: hasExpectedVersion ? "expectedVersion" : "version",
              code: "INVALID_VERSION",
              message: "Expected a non-negative integer version.",
            },
          ],
        },
      ),
    };
  }

  return { ok: true, expectedVersion: raw };
}

export function mapThemesDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof ThemeNotFoundError) {
    return themesErrorResponse(404, "THEME_NOT_FOUND", err.message, requestId, {
      fields: err.fields,
    });
  }
  if (err instanceof ThemeNotGrantedError) {
    return themesErrorResponse(403, "THEME_NOT_GRANTED", err.message, requestId, {
      fields: err.fields,
    });
  }
  if (err instanceof ThemeIncompatibleError) {
    return themesErrorResponse(422, "THEME_INCOMPATIBLE", err.message, requestId, {
      fields: err.fields,
      compatibility: err.compatibility,
    });
  }
  if (err instanceof StaleRevisionError) {
    return themesErrorResponse(409, "STALE_VERSION", err.message, requestId, {
      fields: [
        {
          field: "expectedVersion",
          code: "STALE_VERSION",
          message: err.message,
        },
      ],
    });
  }
  if (err instanceof PreviewPayloadTooLargeError) {
    return themesErrorResponse(413, "PAYLOAD_TOO_LARGE", err.message, requestId);
  }
  if (
    err instanceof ThemeValidationError ||
    err instanceof SectionRegistryValidationError ||
    err instanceof PreviewValidationError ||
    err instanceof PreviewThemeError ||
    err instanceof PublicationValidationError
  ) {
    return themesErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, {
      fields: err.fields,
    });
  }
  if (err instanceof PublicationNotFoundError) {
    return themesErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof AuthorizationError) {
    return themesErrorResponse(err.status, err.code, err.message, requestId);
  }
  if (err instanceof PublicationAtomicError) {
    return themesErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal mengaktifkan tema secara atomik. Status tema sebelumnya tetap aman.",
      requestId,
      { extraHeaders: { "Retry-After": "60" } },
    );
  }
  return themesErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Gagal memproses permintaan perpustakaan tema.",
    requestId,
    { extraHeaders: { "Retry-After": "60" } },
  );
}

// ---------------------------------------------------------------------------
// Theme Library Domain Assembly, Preview & Atomic Activation Services
// ---------------------------------------------------------------------------

function buildEntitlementContext(
  platformCtx: TenantPlatformThemeContext,
  tenantStatus: TenantStatus,
): TenantThemeEntitlementContext {
  return {
    tenantId: platformCtx.tenantId,
    tenantStatus,
    agencyId: platformCtx.agencyId,
    tenantGrants: platformCtx.grants.map((g) => ({
      tenantId: g.tenantId,
      themeId: g.themeId,
      active: g.active,
      grantedBy: g.grantedBy,
    })),
  };
}

function buildCandidateFromEntry(entry: ExtraRegisteredThemeSpec): ThemeCompatibilityCandidate {
  const base = buildThemeCompatibilityCandidate(entry);
  return {
    ...base,
    ...(entry.requiredModules ? { requiredModules: entry.requiredModules } : {}),
  };
}

function buildCompatibilityForEntry(
  entry: ExtraRegisteredThemeSpec,
  platformCtx: TenantPlatformThemeContext,
  dbState: TenantThemeLibraryDbState,
): ThemeCompatibilityReport {
  return evaluateThemeCompatibility(buildCandidateFromEntry(entry), {
    vertical: platformCtx.vertical,
    blogEnabled: dbState.blogEnabled,
    catalogEnabled: dbState.catalogEnabled,
    sections: dbState.pageSections,
    contentCounts: dbState.contentCounts,
  });
}

function collectGrantedEntriesForTenant(
  entitlement: TenantThemeEntitlementContext,
  extraEntries: readonly ExtraRegisteredThemeSpec[] = [],
): readonly ExtraRegisteredThemeSpec[] {
  const baseGranted = [...listGrantedThemesForTenant(entitlement)];
  const seen = new Set(baseGranted.map((e) => e.id));

  for (const extra of extraEntries) {
    if (seen.has(extra.id)) continue;
    try {
      const resolved = resolveGrantedThemeForActivation(
        {
          ...entitlement,
          requestedThemeId: extra.id,
        },
        extraEntries,
      );
      if (resolved.entry.id === extra.id) {
        baseGranted.push(extra);
        seen.add(extra.id);
      }
    } catch {
      // Not granted to this tenant -> strictly excluded from list!
    }
  }

  return baseGranted;
}

export async function loadTenantThemeLibraryState(
  platformDb: D1Database,
  tenantDb: D1Database,
  member: ThemeLibraryMemberScope,
  options: { readonly extraRegisteredThemes?: readonly ExtraRegisteredThemeSpec[] } = {},
): Promise<ThemeLibraryStateDto> {
  const [platformCtx, dbState] = await Promise.all([
    loadTenantPlatformThemeContext(platformDb, member.tenantId),
    loadTenantThemeLibraryDbState(tenantDb),
  ]);

  if (!platformCtx) {
    throw new AuthorizationError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }

  const entitlement = buildEntitlementContext(platformCtx, member.tenantStatus);
  const grantedEntries = collectGrantedEntriesForTenant(
    entitlement,
    options.extraRegisteredThemes,
  );
  const grantByThemeId = new Map(platformCtx.grants.map((g) => [g.themeId, g]));

  const themes: ThemeLibraryItemDto[] = grantedEntries.map((entry) => {
    const grant = grantByThemeId.get(entry.id) ?? null;
    const saved = dbState.savedThemeConfigs.get(entry.id) ?? null;
    const compatibility = buildCompatibilityForEntry(entry, platformCtx, dbState);

    return {
      id: entry.id,
      slug: entry.slug,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      schemaVersion: entry.schemaVersion,
      tier: entry.tier,
      isCustom: entry.isCustom,
      isActive: dbState.activeThemeId === entry.id,
      isRecommended: !entry.isCustom && entry.id === platformCtx.vertical,
      grantSource: entry.isCustom ? "tenant_grant" : "platform_included",
      grantedAt: grant ? new Date(grant.grantedAt).toISOString() : null,
      hasSavedConfig: saved !== null && saved.hasPublished,
      savedConfigUpdatedAt:
        saved && saved.hasPublished ? new Date(saved.updatedAt).toISOString() : null,
      savedTokens: saved?.hasPublished ? saved.tokens : null,
      defaultTokens: entry.defaultTokens,
      palette: entry.palette,
      recommendedOfferingTypes: entry.recommendedOfferingTypes,
      supportedRoutes: entry.supportedRoutes,
      supportedSectionTypes: entry.supportedSectionTypes,
      compatibility,
    };
  });

  const isOwnerOrAdmin =
    member.role === "owner" || member.role === "admin" || member.role === "agency_admin";
  const isLocked = member.tenantStatus === "locked" || member.tenantStatus === "suspended";

  return {
    tenantId: member.tenantId,
    handle: member.handle,
    vertical: platformCtx.vertical,
    activeThemeId: dbState.activeThemeId,
    version: dbState.siteSettingsVersion,
    cacheVersion: platformCtx.cacheVersion,
    themes,
    contentSummary: {
      pages: dbState.contentCounts.pages,
      posts: dbState.contentCounts.posts,
      offerings: dbState.contentCounts.offerings,
      menus: dbState.contentCounts.menus,
      media: dbState.contentCounts.media,
    },
    permissions: {
      canPreview: isOwnerOrAdmin && member.tenantStatus !== "suspended",
      canActivate: isOwnerOrAdmin && !isLocked,
      isLocked,
      role: member.role,
      tenantStatus: member.tenantStatus,
    },
    updatedAt: dbState.siteSettingsUpdatedAt
      ? new Date(dbState.siteSettingsUpdatedAt).toISOString()
      : null,
  };
}

/**
 * Renders an in-process compatibility draft preview (`sandbox=""` iframe HTML)
 * of the tenant's real public content under a candidate granted theme WITHOUT
 * mutating `site_settings`, `theme_configs`, or `PLATFORM_DB.tenants.cache_version`.
 */
export async function previewTenantThemeCompatibility(
  platformDb: D1Database,
  tenantDb: D1Database,
  member: ThemeLibraryMemberScope,
  themeId: unknown,
  options: {
    readonly renderShellDocument?: RenderPreviewShellDocumentFn;
    readonly extraRegisteredThemes?: readonly ExtraRegisteredThemeSpec[];
  } = {},
): Promise<ThemeLibraryPreviewResultDto> {
  const [platformCtx, dbState] = await Promise.all([
    loadTenantPlatformThemeContext(platformDb, member.tenantId),
    loadTenantThemeLibraryDbState(tenantDb),
  ]);

  if (!platformCtx) {
    throw new AuthorizationError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }

  const entitlement = buildEntitlementContext(platformCtx, member.tenantStatus);
  const { entry } = resolveGrantedThemeForActivation(
    {
      ...entitlement,
      requestedThemeId: themeId,
    },
    options.extraRegisteredThemes,
  );

  const extraMatch = options.extraRegisteredThemes?.find((e) => e.id === entry.id);
  const effectiveEntry: ExtraRegisteredThemeSpec = extraMatch ?? entry;
  const compatibility = buildCompatibilityForEntry(effectiveEntry, platformCtx, dbState);

  if (!compatibility.compatible) {
    throw new ThemeIncompatibleError(effectiveEntry.id, compatibility);
  }

  const saved = dbState.savedThemeConfigs.get(effectiveEntry.id) ?? null;
  const previewThemeConfig: ThemeConfigSnapshot = {
    themeId: effectiveEntry.id,
    tokens: saved?.tokens ?? effectiveEntry.defaultTokens,
    variants: saved?.variants ?? effectiveEntry.defaultVariants,
  };

  const rendered = await renderTenantDraftPreview(
    {
      platformDb,
      tenantDb,
      tenantId: member.tenantId,
      tenantHandle: member.handle,
      tenantName: member.tenantName,
      input: {
        resourceKind: "home",
        themeId: effectiveEntry.id,
        draftOverride: {
          themeConfig: previewThemeConfig,
        },
      },
    },
    options.renderShellDocument ?? renderSemanticPreviewShellFallback,
  );

  return {
    html: rendered.html,
    themeId: effectiveEntry.id,
    themeName: effectiveEntry.name,
    isCustom: effectiveEntry.isCustom,
    sandbox: PREVIEW_IFRAME_SANDBOX,
    compatibility,
    hasSavedConfig: saved !== null,
    isPreview: true,
    version: dbState.siteSettingsVersion,
  };
}

/**
 * Validates grant + compatibility + optimistic version and atomically switches
 * the tenant's active theme while preserving prior theme config and all content.
 */
export async function activateTenantThemeFromLibrary(
  platformDb: D1Database,
  tenantDb: D1Database,
  member: ThemeLibraryMemberScope,
  input: {
    readonly themeId: unknown;
    readonly expectedVersion: number;
    readonly nowMs?: number;
  },
  options: { readonly extraRegisteredThemes?: readonly ExtraRegisteredThemeSpec[] } = {},
): Promise<ThemeLibraryActivateResultDto> {
  const [platformCtx, dbState] = await Promise.all([
    loadTenantPlatformThemeContext(platformDb, member.tenantId),
    loadTenantThemeLibraryDbState(tenantDb),
  ]);

  if (!platformCtx) {
    throw new AuthorizationError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }

  const entitlement = buildEntitlementContext(platformCtx, member.tenantStatus);
  const { entry } = resolveGrantedThemeForActivation(
    {
      ...entitlement,
      requestedThemeId: input.themeId,
    },
    options.extraRegisteredThemes,
  );

  const extraMatch = options.extraRegisteredThemes?.find((e) => e.id === entry.id);
  const effectiveEntry: ExtraRegisteredThemeSpec = extraMatch ?? entry;
  const compatibility = buildCompatibilityForEntry(effectiveEntry, platformCtx, dbState);

  if (!compatibility.compatible) {
    throw new ThemeIncompatibleError(effectiveEntry.id, compatibility);
  }

  const activated = await activateTenantThemeAtomically({
    platformDb,
    tenantDb,
    tenantId: member.tenantId,
    tenantName: member.tenantName,
    actorUserId: member.userId,
    actorRole: member.role,
    targetTheme: {
      id: effectiveEntry.id,
      name: effectiveEntry.name,
      defaultTokens: effectiveEntry.defaultTokens,
      defaultVariants: effectiveEntry.defaultVariants,
    },
    expectedVersion: input.expectedVersion,
    compatibility,
    nowMs: input.nowMs,
  });

  const refreshedState = await loadTenantThemeLibraryState(platformDb, tenantDb, member, options);

  return {
    ...refreshedState,
    activatedThemeId: activated.activatedThemeId,
    previousThemeId: activated.previousThemeId,
    recoveredExistingConfig: activated.recoveredExistingConfig,
    cacheVersion: activated.cacheVersion,
    activatedAt: activated.activatedAt,
  };
}

/**
 * HTTP handler for `POST /api/tenants/:tenantId/themes/preview` (kept `.astro`-free in
 * `_shared.ts` so both Astro routes and root `tsc`/workerd integration tests can import it cleanly).
 */
export async function handleTenantThemesPreviewRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantThemesRuntimeEnv,
  options: TenantThemesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createThemesRequestId();

  if (method !== "POST") {
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
      "Gunakan metode POST dengan body JSON untuk merender pratinjau kompatibilitas tema.",
      requestId,
      { extraHeaders: { Allow: "POST" } },
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
    const parsedBody = await parseStrictThemesJsonBody(
      request,
      THEMES_PREVIEW_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const rawThemeId = parsedBody.body.themeId;
    if (typeof rawThemeId !== "string" || !rawThemeId.trim()) {
      return themesErrorResponse(
        422,
        "VALIDATION_ERROR",
        "themeId wajib diisi untuk pratinjau kompatibilitas tema.",
        requestId,
        {
          fields: [
            {
              field: "themeId",
              code: "REQUIRED",
              message: "themeId is required.",
            },
          ],
        },
      );
    }

    const result = await previewTenantThemeCompatibility(
      auth.ctx.platformDb,
      auth.ctx.tenantDb,
      auth.ctx.member,
      rawThemeId,
      {
        renderShellDocument: options.renderShellDocument,
        extraRegisteredThemes: options.extraRegisteredThemes,
      },
    );

    return themesPreviewJsonResponse(200, result);
  } catch (err) {
    return mapThemesDomainErrorToResponse(err, requestId);
  }
}

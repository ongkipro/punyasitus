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
  buildPublishedSnapshot,
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  serializeDraftStoragePayload,
  StaleRevisionError,
  type PublicationValidationField,
} from "@punyasitus/core/content/index";
import type { EmailPort } from "@punyasitus/core/email/index";
import {
  FORBIDDEN_TENANT_SELECTOR_KEYS,
  type ApiErrorCode,
  type Role,
  type TenantStatus,
} from "@punyasitus/core/schemas";
import {
  ALLOWED_THEME_FONTS,
  convertPublicPageSectionDtoToSectionInput,
  ensureAccessibleBrandColor,
  isHealthBusinessCategory,
  parseAndValidateThemeJson,
  PLATFORM_THEME_IDS,
  resolveThemeSectionProfile,
  SectionRegistryValidationError,
  THEME_FONT_STACKS,
  ThemeValidationError,
  validatePageSections,
  type AccessibleBrandColorResult,
  type AllowedThemeFont,
  type AnyValidatedPageSection,
  type ClosedSectionType,
  type PlatformThemeId,
  type SectionValidationWarning,
  type ThemeConfigSnapshot,
  type ThemeTokens,
  type ThemeVariants,
} from "@punyasitus/core/theme/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  bumpTenantCacheVersion,
  getDraftResourceForAdmin,
} from "@punyasitus/db/publication/index";
import {
  PLATFORM_THEME_PRESETS,
  type PlatformThemePreset,
} from "../../../../../core/public-data.ts";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";
import {
  buildHomepageSnapshotFromSections,
  computePublicSectionsSignature,
  convertValidatedSectionToPublicDto,
} from "../../../../dashboard/[handle]/appearance/_customizer-helpers.ts";

export { buildHomepageSnapshotFromSections, convertValidatedSectionToPublicDto };

/**
 * Shared authorization, strict DTO validation, WCAG AA contrast evaluation,
 * section registry adapter, and single-batch atomic SQLite draft/publish engine
 * for `/api/tenants/:tenantId/theme/**` (TASK-034; REQ-037, REQ-019, REQ-020, REQ-036).
 */

export const MAX_THEME_BODY_BYTES = 131_072 as const; // 128 KiB hard ceiling
const MAX_RETAINED_REVISIONS = 20 as const;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PLATFORM_THEME_SET: ReadonlySet<string> = new Set<string>(PLATFORM_THEME_IDS);

export const THEME_FORBIDDEN_SELECTOR_KEYS = [
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

const FORBIDDEN_SELECTOR_KEY_SET: ReadonlySet<string> = new Set(THEME_FORBIDDEN_SELECTOR_KEYS);

export const THEME_PATCH_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "tokens",
  "variants",
  "sections",
  "expectedVersion",
  "version",
  "expectedVersions",
]);

export const THEME_PUBLISH_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "expectedVersion",
  "version",
  "expectedVersions",
]);

export const THEME_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export interface TenantThemeRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantThemeHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

export interface AuthorizedThemeRequestContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
}

export interface ExpectedRowVersions {
  readonly themeConfig?: number;
  readonly homepage?: number;
}

export interface FontOptionInfo {
  readonly id: AllowedThemeFont;
  readonly label: string;
  readonly stack: string;
  readonly isSystem: boolean;
}

export const THEME_FONT_OPTIONS: readonly FontOptionInfo[] = ALLOWED_THEME_FONTS.map((id) => {
  const labels: Readonly<Record<AllowedThemeFont, string>> = {
    system: "Font Sistem (Default Tercepat — 0 KiB)",
    "plus-jakarta-sans": "Plus Jakarta Sans",
    inter: "Inter",
    "dm-sans": "DM Sans",
    poppins: "Poppins",
    manrope: "Manrope",
    "source-sans-3": "Source Sans 3",
    lora: "Lora (Serif)",
    merriweather: "Merriweather (Serif)",
    "playfair-display": "Playfair Display (Serif)",
  };
  return {
    id,
    label: labels[id],
    stack: THEME_FONT_STACKS[id],
    isSystem: id === "system",
  };
});

export interface ThemeCustomizerSnapshotPayload {
  readonly themeId: string;
  readonly tokens: ThemeTokens;
  readonly variants: ThemeVariants;
  readonly sections: readonly AnyValidatedPageSection[];
}

export interface ThemeCustomizerAdminState {
  readonly themeId: string;
  readonly homepageId: number | null;
  readonly homepageSlug: string;
  readonly homepageTitle: string;
  readonly draft: ThemeCustomizerSnapshotPayload;
  readonly published: ThemeCustomizerSnapshotPayload | null;
  readonly contrast: {
    readonly primary: AccessibleBrandColorResult;
    readonly secondary: AccessibleBrandColorResult;
  };
  readonly version: number;
  readonly versions: {
    readonly themeConfig: number;
    readonly homepage: number;
  };
  readonly hasUnpublishedChanges: boolean;
  readonly isHealthCategory: boolean;
  readonly businessCategory: string;
  readonly permenkesWarnings: readonly SectionValidationWarning[];
  readonly availableThemes: readonly PlatformThemePreset[];
  readonly allowedFonts: readonly FontOptionInfo[];
  readonly permissions: {
    readonly canEdit: boolean;
    readonly canPublish: boolean;
    readonly isLocked: boolean;
    readonly role: Role;
    readonly tenantStatus: TenantStatus;
  };
  readonly updatedAt: string | null;
  readonly publishedAt: string | null;
}

export function createThemeRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function themeJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(THEME_NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function themeErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return themeJsonResponse(
    status,
    {
      error: {
        code,
        message,
        ...(fields && fields.length > 0 ? { fields } : {}),
      },
      requestId,
    },
    extraHeaders,
  );
}

/**
 * Enforces:
 * 1. Platform `app` host isolation (`404` on tenant/console/marketing hosts).
 * 2. CSRF & Origin check on state-changing methods.
 * 3. Better Auth session verification + `enforceSessionLifetimeCeiling` (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership + RBAC + tenant lifecycle status gate (`404` cross-tenant/non-member,
 *    `403 FORBIDDEN` wrong role, `403 SUBSCRIPTION_LOCKED` on locked/suspended write).
 * 5. Opens ONLY the verified tenant's physically isolated `TenantStore`.
 */
export async function authorizeTenantThemeRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantThemeRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantThemeHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedThemeRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createThemeRequestId();

  // 1. Platform app host isolation
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: themeErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin check on state-changing methods
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: themeErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: themeErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
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
        response: themeErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Konfigurasi autentikasi belum lengkap.",
          requestId,
          undefined,
          { "Retry-After": "60" },
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
      response: themeErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Sesi Anda telah berakhir atau tidak valid. Silakan masuk kembali untuk mengatur tema.",
        requestId,
      ),
    };
  }

  // 5. Live membership + RBAC + tenant status check
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: themeErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
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
        response: themeErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: themeErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        undefined,
        { "Retry-After": "60" },
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
      response: themeErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan data tenant sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
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

export type ParsedThemeJsonResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response };

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

export async function parseStrictThemeJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
  options: { readonly allowEmptyBody?: boolean } = {},
): Promise<ParsedThemeJsonResult> {
  let rawBytes: Uint8Array;
  try {
    rawBytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return {
      ok: false,
      response: themeErrorResponse(400, "BAD_REQUEST", "Gagal membaca body permintaan.", requestId),
    };
  }

  if (rawBytes.byteLength > MAX_THEME_BODY_BYTES) {
    return {
      ok: false,
      response: themeErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_THEME_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (rawText.length === 0) {
    if (options.allowEmptyBody) {
      return { ok: true, body: {} };
    }
    return {
      ok: false,
      response: themeErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: themeErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: themeErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
        [{ field: "body", code: "INVALID_PAYLOAD", message: "Expected a JSON object." }],
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  const forbiddenPath = findNestedForbiddenKey(record);
  if (forbiddenPath) {
    return {
      ok: false,
      response: themeErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Field "${forbiddenPath}" tidak diizinkan dalam body permintaan tema.`,
        requestId,
        [
          {
            field: forbiddenPath,
            code: "FORBIDDEN_TENANT_SELECTOR",
            message: `Forbidden selector or privilege field "${forbiddenPath}" is not allowed.`,
          },
        ],
      ),
    };
  }

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        response: themeErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field tidak dikenal "${key}".`,
          requestId,
          [
            {
              field: key,
              code: "UNKNOWN_FIELD",
              message: `Unknown field "${key}" is not allowed.`,
            },
          ],
        ),
      };
    }
  }

  return { ok: true, body: record };
}

function isValidVersionInt(val: unknown): val is number {
  return typeof val === "number" && Number.isSafeInteger(val) && val >= 0 && val <= 2_147_483_647;
}

/**
 * Extracts and requires `expectedVersion` (or `version`) plus optional per-row
 * `expectedVersions` (`{ themeConfig?, homepage? }`). Returns `422 VALIDATION_ERROR`
 * when `expectedVersion` is omitted on mutating endpoints (`PATCH` / `POST /publish`).
 */
export function extractThemeExpectedVersion(
  body: Record<string, unknown>,
  requestId: string,
):
  | {
      readonly ok: true;
      readonly expectedVersion: number;
      readonly expectedVersions?: ExpectedRowVersions;
    }
  | { readonly ok: false; readonly response: Response } {
  const hasVersion = body.version !== undefined;
  const hasExpectedVersion = body.expectedVersion !== undefined;

  if (hasVersion && hasExpectedVersion && body.version !== body.expectedVersion) {
    return {
      ok: false,
      response: themeErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version dan expectedVersion harus sama bila keduanya diberikan.",
        requestId,
        [
          {
            field: "expectedVersion",
            code: "INVALID_VERSION",
            message: "Conflicting version and expectedVersion values.",
          },
        ],
      ),
    };
  }

  const raw = hasExpectedVersion ? body.expectedVersion : body.version;
  if (raw === undefined) {
    return {
      ok: false,
      response: themeErrorResponse(
        422,
        "VALIDATION_ERROR",
        "expectedVersion wajib disertakan untuk melindungi perubahan tema dari konflik versi.",
        requestId,
        [
          {
            field: "expectedVersion",
            code: "REQUIRED",
            message: "expectedVersion is required for theme mutations.",
          },
        ],
      ),
    };
  }

  if (!isValidVersionInt(raw)) {
    return {
      ok: false,
      response: themeErrorResponse(
        422,
        "VALIDATION_ERROR",
        "expectedVersion harus berupa bilangan bulat non-negatif.",
        requestId,
        [
          {
            field: hasExpectedVersion ? "expectedVersion" : "version",
            code: "INVALID_VERSION",
            message: "Expected a non-negative integer version.",
          },
        ],
      ),
    };
  }

  let expectedVersions: ExpectedRowVersions | undefined;
  if (body.expectedVersions !== undefined) {
    if (
      typeof body.expectedVersions !== "object" ||
      body.expectedVersions === null ||
      Array.isArray(body.expectedVersions)
    ) {
      return {
        ok: false,
        response: themeErrorResponse(
          422,
          "VALIDATION_ERROR",
          "expectedVersions harus berupa objek.",
          requestId,
          [
            {
              field: "expectedVersions",
              code: "INVALID_VERSION",
              message: "expectedVersions must be an object with themeConfig and/or homepage.",
            },
          ],
        ),
      };
    }

    const ev = body.expectedVersions as Record<string, unknown>;
    const allowedEvKeys = new Set(["themeConfig", "homepage"]);
    for (const k of Object.keys(ev)) {
      if (!allowedEvKeys.has(k)) {
        return {
          ok: false,
          response: themeErrorResponse(
            422,
            "VALIDATION_ERROR",
            `Field tidak dikenal "expectedVersions.${k}".`,
            requestId,
            [
              {
                field: `expectedVersions.${k}`,
                code: "UNKNOWN_FIELD",
                message: `Unknown key "${k}" in expectedVersions.`,
              },
            ],
          ),
        };
      }
    }

    if (ev.themeConfig !== undefined && !isValidVersionInt(ev.themeConfig)) {
      return {
        ok: false,
        response: themeErrorResponse(
          422,
          "VALIDATION_ERROR",
          "expectedVersions.themeConfig harus berupa bilangan bulat non-negatif.",
          requestId,
          [
            {
              field: "expectedVersions.themeConfig",
              code: "INVALID_VERSION",
              message: "Expected a non-negative integer version.",
            },
          ],
        ),
      };
    }

    if (ev.homepage !== undefined && !isValidVersionInt(ev.homepage)) {
      return {
        ok: false,
        response: themeErrorResponse(
          422,
          "VALIDATION_ERROR",
          "expectedVersions.homepage harus berupa bilangan bulat non-negatif.",
          requestId,
          [
            {
              field: "expectedVersions.homepage",
              code: "INVALID_VERSION",
              message: "Expected a non-negative integer version.",
            },
          ],
        ),
      };
    }

    expectedVersions = {
      ...(ev.themeConfig !== undefined ? { themeConfig: ev.themeConfig } : {}),
      ...(ev.homepage !== undefined ? { homepage: ev.homepage } : {}),
    };
  }

  return {
    ok: true,
    expectedVersion: raw,
    ...(expectedVersions ? { expectedVersions } : {}),
  };
}

export function mapThemeDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (
    err instanceof ThemeValidationError ||
    err instanceof SectionRegistryValidationError ||
    err instanceof PublicationValidationError
  ) {
    const fields: PublicationValidationField[] = err.fields.map((f) => ({
      field: f.field,
      code: f.code,
      message: f.message,
    }));
    return themeErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, fields);
  }
  if (err instanceof StaleRevisionError) {
    return themeErrorResponse(409, "STALE_VERSION", err.message, requestId, [
      {
        field: "expectedVersion",
        code: "STALE_VERSION",
        message: err.message,
      },
    ]);
  }
  if (err instanceof PublicationNotFoundError) {
    return themeErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof AuthorizationError) {
    return themeErrorResponse(err.status, err.code, err.message, requestId);
  }
  if (err instanceof PublicationAtomicError) {
    return themeErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal menerbitkan perubahan tema secara atomik.",
      requestId,
      undefined,
      { "Retry-After": "60" },
    );
  }
  return themeErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Gagal memproses permintaan kustomisasi tema.",
    requestId,
    undefined,
    { "Retry-After": "60" },
  );
}

// ---------------------------------------------------------------------------
// Starter Sections & Version-Aware Draft Sections Metadata Envelope
// ---------------------------------------------------------------------------

interface StoredDraftSectionsMeta {
  readonly schemaVersion: 1;
  readonly sourceVersion: number;
  readonly enabledSignature: string;
  readonly sections: readonly AnyValidatedPageSection[];
}

function serializeDraftSectionsMeta(params: {
  readonly sourceVersion: number;
  readonly enabledSignature: string;
  readonly sections: readonly AnyValidatedPageSection[];
}): string {
  const envelope: StoredDraftSectionsMeta = {
    schemaVersion: 1,
    sourceVersion: params.sourceVersion,
    enabledSignature: params.enabledSignature,
    sections: params.sections,
  };
  return JSON.stringify(envelope);
}

function parseDraftSectionsFromMetadata(
  draftMetadata: Readonly<Record<string, unknown>>,
  currentHomepageVersion: number,
  currentDraftEnabledSignature: string | null,
  businessCategory: string,
): ReturnType<typeof validatePageSections> | null {
  const rawJson = draftMetadata.draftSectionsJson;
  if (typeof rawJson !== "string" || !rawJson.trim()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rawJson);

    // Structured version- & signature-checked envelope (prevents clobbering external homepage edits)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (rec.schemaVersion === 1 && Array.isArray(rec.sections)) {
        const sourceVersion =
          typeof rec.sourceVersion === "number" ? rec.sourceVersion : null;
        const storedSignature =
          typeof rec.enabledSignature === "string" ? rec.enabledSignature : null;

        // If external page editor moved the homepage ahead or changed enabled sections, discard stale metadata!
        if (sourceVersion !== null && sourceVersion !== currentHomepageVersion) {
          return null;
        }
        if (
          currentDraftEnabledSignature !== null &&
          storedSignature !== null &&
          storedSignature !== currentDraftEnabledSignature
        ) {
          return null;
        }
        return validatePageSections(rec.sections, { businessCategory });
      }
      return null;
    }

    // Legacy raw array format: only accept when its enabled output still matches live draft_sections_json
    if (Array.isArray(parsed)) {
      const validated = validatePageSections(parsed, { businessCategory });
      if (currentDraftEnabledSignature !== null) {
        const liveSnap = buildHomepageSnapshotFromSections(validated.sections);
        if (computePublicSectionsSignature(liveSnap.sections) !== currentDraftEnabledSignature) {
          return null;
        }
      }
      return validated;
    }

    return null;
  } catch {
    return null;
  }
}

function buildStarterSectionEntry(
  type: ClosedSectionType,
  businessName: string,
): {
  readonly id: string;
  readonly type: ClosedSectionType;
  readonly schemaVersion: 1;
  readonly enabled?: boolean;
  readonly config: Record<string, unknown>;
} {
  switch (type) {
    case "hero":
      return {
        id: "sec-hero",
        type: "hero",
        schemaVersion: 1,
        enabled: true,
        config: {
          heading: `Selamat Datang di ${businessName}`,
          subheading: "Solusi profesional terpercaya untuk kebutuhan Anda.",
          primaryCta: { label: "Hubungi Kami", href: "#kontak", variant: "primary" },
        },
      };
    case "features":
    case "highlights":
      return {
        id: `sec-${type}`,
        type,
        schemaVersion: 1,
        enabled: true,
        config: {
          heading: "Keunggulan Utama",
          subheading: "Alasan pelanggan memilih layanan kami.",
          columns: 3,
          items: [
            {
              title: "Respon Cepat",
              description: "Tim kami siap membantu kebutuhan Anda setiap hari kerja.",
            },
          ],
        },
      };
    case "about":
    case "rich_text":
      return {
        id: `sec-${type}`,
        type,
        schemaVersion: 1,
        enabled: true,
        config: {
          heading: `Tentang ${businessName}`,
          subheading: "Profil singkat usaha dan pengalaman kami.",
          bodyHtml: "<p>Kami berkomitmen menghadirkan kualitas layanan terbaik dan transparan.</p>",
        },
      };
    case "offerings_grid":
    case "services_grid":
    case "products_grid":
    case "tours_grid":
    case "vehicles_grid":
      return {
        id: `sec-${type}`,
        type,
        schemaVersion: 1,
        enabled: true,
        config: {
          heading: "Penawaran Unggulan",
          subheading: "Pilihan layanan dan produk utama yang tersedia.",
          limit: 6,
          items: [],
        },
      };
    case "testimonials":
      return {
        id: "sec-testimonials",
        type: "testimonials",
        schemaVersion: 1,
        // Intentionally omit `enabled` so `validatePageSections` enforces Permenkes default OFF on health categories!
        config: {
          heading: "Ulasan Pelanggan",
          subheading: "Pengalaman klien yang telah bekerja sama bersama kami.",
          items: [],
        },
      };
    case "faq":
      return {
        id: "sec-faq",
        type: "faq",
        schemaVersion: 1,
        enabled: true,
        config: {
          heading: "Pertanyaan Umum",
          subheading: "Jawaban atas pertanyaan yang paling sering diajukan.",
          items: [],
        },
      };
    case "cta_banner":
    case "cta_band":
    case "custom_form":
      return {
        id: `sec-${type}`,
        type,
        schemaVersion: 1,
        enabled: true,
        config: {
          heading: "Siap Memulai Konsultasi?",
          subheading: "Diskusikan kebutuhan Anda bersama tim kami hari ini.",
          primaryCta: { label: "Mulai Konsultasi", href: "#kontak", variant: "primary" },
        },
      };
    case "contact_location":
    case "contact":
    case "branches":
      return {
        id: `sec-${type}`,
        type,
        schemaVersion: 1,
        enabled: true,
        config: {
          heading: "Kontak & Lokasi",
          subheading: "Hubungi kami melalui WhatsApp, telepon, atau kunjungi kantor kami.",
        },
      };
    case "blog_latest":
    case "latest_posts":
      return {
        id: `sec-${type}`,
        type,
        schemaVersion: 1,
        enabled: true,
        config: {
          heading: "Artikel Terbaru",
          subheading: "Tips dan informasi terbaru dari tim kami.",
          limit: 3,
          posts: [],
        },
      };
    case "gallery":
      return {
        id: "sec-gallery",
        type: "gallery",
        schemaVersion: 1,
        enabled: true,
        config: {
          heading: "Galeri Dokumentasi",
          subheading: "Portofolio dan kegiatan terbaru kami.",
          columns: 3,
          items: [],
        },
      };
    case "trust_logos":
    case "team":
      return {
        id: `sec-${type}`,
        type,
        schemaVersion: 1,
        enabled: true,
        config: {
          heading: type === "team" ? "Tim Kami" : "Mitra & Kredensial",
          subheading: null,
          items: [],
        },
      };
  }
}

export function buildDefaultStarterHomepageSections(
  themeId: string,
  businessName: string,
  businessCategory: string,
): {
  readonly sections: readonly AnyValidatedPageSection[];
  readonly warnings: readonly SectionValidationWarning[];
  readonly isHealthCategory: boolean;
} {
  const profile = resolveThemeSectionProfile(themeId);
  const starterTypes: readonly ClosedSectionType[] = [
    "hero",
    profile.defaultSectionOrder.includes("offerings_grid") ? "offerings_grid" : "features",
    "about",
    "testimonials",
    "faq",
    "contact_location",
  ];

  const rawEntries = starterTypes.map((type) => buildStarterSectionEntry(type, businessName));
  const validated = validatePageSections(rawEntries, { businessCategory });
  return {
    sections: validated.sections,
    warnings: validated.warnings,
    isHealthCategory: validated.isHealthCategory,
  };
}

function resolveBaseThemePreset(themeId: string): PlatformThemePreset {
  if (PLATFORM_THEME_SET.has(themeId)) {
    return PLATFORM_THEME_PRESETS[themeId as PlatformThemeId];
  }
  return PLATFORM_THEME_PRESETS.compro;
}

// ---------------------------------------------------------------------------
// DB Loader & Single-Batch Atomic SQLite Draft / Publish Engine
// ---------------------------------------------------------------------------

export interface ThemeMemberScope {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly userId: string;
  readonly role: Role;
  readonly tenantStatus: TenantStatus;
}

async function resolveHomepageRowId(tenantDb: D1Database): Promise<number | null> {
  const row = await tenantDb
    .prepare("SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL LIMIT 1")
    .first<{ readonly id: number }>();
  return row && typeof row.id === "number" ? row.id : null;
}

export async function loadThemeCustomizerAdminState(
  tenantDb: D1Database,
  member: ThemeMemberScope,
): Promise<ThemeCustomizerAdminState> {
  const [settingsDto, profileDto, rawSettingsRow, rawProfileRow, homepageId] = await Promise.all([
    getDraftResourceForAdmin(tenantDb, { resourceType: "site_settings" }),
    getDraftResourceForAdmin(tenantDb, { resourceType: "business_profile" }),
    tenantDb
      .prepare("SELECT active_theme_id FROM site_settings WHERE id = 1 LIMIT 1")
      .first<{ readonly active_theme_id: string }>(),
    tenantDb
      .prepare("SELECT business_name, business_category FROM business_profile WHERE id = 1 LIMIT 1")
      .first<{ readonly business_name: string; readonly business_category: string }>(),
    resolveHomepageRowId(tenantDb),
  ]);

  const activeThemeId =
    settingsDto?.draft?.activeThemeId ??
    settingsDto?.published?.activeThemeId ??
    rawSettingsRow?.active_theme_id ??
    "compro";
  const businessName =
    profileDto?.draft?.businessName ??
    profileDto?.published?.businessName ??
    rawProfileRow?.business_name ??
    member.tenantName;
  const businessCategory =
    profileDto?.draft?.businessCategory ??
    profileDto?.published?.businessCategory ??
    rawProfileRow?.business_category ??
    "LocalBusiness";
  const isHealthCategory = isHealthBusinessCategory(businessCategory);
  const preset = resolveBaseThemePreset(activeThemeId);

  const [themeDto, homepageDto] = await Promise.all([
    getDraftResourceForAdmin(tenantDb, {
      resourceType: "theme_config",
      resourceId: activeThemeId,
    }),
    homepageId !== null
      ? getDraftResourceForAdmin(tenantDb, {
          resourceType: "page",
          resourceId: homepageId,
        })
      : Promise.resolve(null),
  ]);

  const themeConfigVersion = themeDto?.version ?? 0;
  const homepageVersion = homepageDto?.version ?? 0;

  const draftThemeSnapshot: ThemeConfigSnapshot = themeDto?.draft ??
    themeDto?.published ?? {
      themeId: activeThemeId,
      tokens: { ...preset.tokens },
      variants: { ...preset.variants },
    };

  // Draft homepage sections: only honor `_draftMetadata.draftSectionsJson` when its
  // sourceVersion & enabledSignature match the live homepage draft row (never clobber external edits!).
  let draftSectionsResult: {
    readonly sections: readonly AnyValidatedPageSection[];
    readonly warnings: readonly SectionValidationWarning[];
  };

  const currentDraftEnabledSignature = homepageDto?.draft
    ? computePublicSectionsSignature(homepageDto.draft.sections)
    : null;

  const metadataSections = homepageDto
    ? parseDraftSectionsFromMetadata(
        homepageDto.draftMetadata,
        homepageVersion,
        currentDraftEnabledSignature,
        businessCategory,
      )
    : null;

  if (metadataSections) {
    draftSectionsResult = {
      sections: metadataSections.sections,
      warnings: metadataSections.warnings,
    };
  } else if (homepageDto?.draft && homepageDto.draft.sections.length > 0) {
    const converted = homepageDto.draft.sections.map((dto) =>
      convertPublicPageSectionDtoToSectionInput(dto),
    );
    const validated = validatePageSections(converted, { businessCategory });
    draftSectionsResult = { sections: validated.sections, warnings: validated.warnings };
  } else if (homepageDto?.published && homepageDto.published.sections.length > 0) {
    const converted = homepageDto.published.sections.map((dto) =>
      convertPublicPageSectionDtoToSectionInput(dto),
    );
    const validated = validatePageSections(converted, { businessCategory });
    draftSectionsResult = { sections: validated.sections, warnings: validated.warnings };
  } else {
    const starter = buildDefaultStarterHomepageSections(
      activeThemeId,
      businessName,
      businessCategory,
    );
    draftSectionsResult = { sections: starter.sections, warnings: starter.warnings };
  }

  let publishedPayload: ThemeCustomizerSnapshotPayload | null = null;
  if (themeDto?.published || homepageDto?.published) {
    const pubTheme = themeDto?.published ?? {
      themeId: activeThemeId,
      tokens: { ...preset.tokens },
      variants: { ...preset.variants },
    };
    let pubSections: readonly AnyValidatedPageSection[] = [];
    if (homepageDto?.published && homepageDto.published.sections.length > 0) {
      const convertedPub = homepageDto.published.sections.map((dto) =>
        convertPublicPageSectionDtoToSectionInput(dto, true),
      );
      pubSections = validatePageSections(convertedPub, { businessCategory }).sections;
    }
    publishedPayload = {
      themeId: pubTheme.themeId,
      tokens: pubTheme.tokens,
      variants: pubTheme.variants,
      sections: pubSections,
    };
  }

  const surfaceHex = draftThemeSnapshot.tokens.surfaceColor ?? "#ffffff";
  const primaryContrast = ensureAccessibleBrandColor(
    draftThemeSnapshot.tokens.primaryColor,
    surfaceHex,
  );
  const secondaryContrast = ensureAccessibleBrandColor(
    draftThemeSnapshot.tokens.secondaryColor,
    surfaceHex,
  );

  const hasUnpublishedChanges =
    Boolean(themeDto?.hasUnpublishedChanges) ||
    Boolean(homepageDto?.hasUnpublishedChanges) ||
    publishedPayload === null;

  const canEdit =
    member.role === "owner" || member.role === "admin" || member.role === "agency_admin";
  const isLocked = member.tenantStatus === "locked" || member.tenantStatus === "suspended";

  const latestUpdatedMs = Math.max(themeDto?.updatedAt ?? 0, homepageDto?.updatedAt ?? 0);
  const publishedAtMs = homepageDto?.publishedAt ?? null;

  return {
    themeId: activeThemeId,
    homepageId,
    homepageSlug: homepageDto?.draft?.slug ?? homepageDto?.published?.slug ?? "beranda",
    homepageTitle: homepageDto?.draft?.title ?? homepageDto?.published?.title ?? "Beranda",
    draft: {
      themeId: draftThemeSnapshot.themeId,
      tokens: draftThemeSnapshot.tokens,
      variants: draftThemeSnapshot.variants,
      sections: draftSectionsResult.sections,
    },
    published: publishedPayload,
    contrast: {
      primary: primaryContrast,
      secondary: secondaryContrast,
    },
    version: themeConfigVersion + homepageVersion,
    versions: {
      themeConfig: themeConfigVersion,
      homepage: homepageVersion,
    },
    hasUnpublishedChanges,
    isHealthCategory,
    businessCategory,
    permenkesWarnings: draftSectionsResult.warnings,
    availableThemes: PLATFORM_THEME_IDS.map((id) => PLATFORM_THEME_PRESETS[id]),
    allowedFonts: THEME_FONT_OPTIONS,
    permissions: {
      canEdit: canEdit && !isLocked,
      canPublish: canEdit && !isLocked,
      isLocked,
      role: member.role,
      tenantStatus: member.tenantStatus,
    },
    updatedAt: latestUpdatedMs > 0 ? new Date(latestUpdatedMs).toISOString() : null,
    publishedAt: publishedAtMs !== null ? new Date(publishedAtMs).toISOString() : null,
  };
}

/**
 * Helper verifying combined `expectedVersion` AND optional per-row
 * `expectedVersions` (`themeConfig`, `homepage`) BEFORE any write.
 */
function assertOptimisticVersionsMatch(
  current: ThemeCustomizerAdminState,
  expectedVersion: number,
  expectedVersions?: ExpectedRowVersions,
): void {
  if (expectedVersion !== current.version) {
    throw new StaleRevisionError({
      resourceType: "theme_config",
      resourceId: current.themeId,
      expectedVersion,
      actualVersion: current.version,
    });
  }
  if (
    expectedVersions?.themeConfig !== undefined &&
    expectedVersions.themeConfig !== current.versions.themeConfig
  ) {
    throw new StaleRevisionError({
      resourceType: "theme_config",
      resourceId: current.themeId,
      expectedVersion: expectedVersions.themeConfig,
      actualVersion: current.versions.themeConfig,
    });
  }
  if (
    expectedVersions?.homepage !== undefined &&
    expectedVersions.homepage !== current.versions.homepage
  ) {
    throw new StaleRevisionError({
      resourceType: "page",
      resourceId: current.homepageId ?? "home",
      expectedVersion: expectedVersions.homepage,
      actualVersion: current.versions.homepage,
    });
  }
}

function buildThemeGuardClause(themeId: string, expectedThemeVersion: number): {
  readonly sql: string;
  readonly args: readonly unknown[];
} {
  if (expectedThemeVersion > 0) {
    return {
      sql: "EXISTS (SELECT 1 FROM theme_configs WHERE theme_id = ? AND version = ?)",
      args: [themeId, expectedThemeVersion],
    };
  }
  return {
    sql: "NOT EXISTS (SELECT 1 FROM theme_configs WHERE theme_id = ?)",
    args: [themeId],
  };
}

function buildHomepageGuardClause(
  homepageId: number | null,
  expectedHomepageVersion: number,
): {
  readonly sql: string;
  readonly args: readonly unknown[];
} {
  if (homepageId !== null && expectedHomepageVersion > 0) {
    return {
      sql: "EXISTS (SELECT 1 FROM pages WHERE id = ? AND is_homepage = 1 AND deleted_at IS NULL AND version = ?)",
      args: [homepageId, expectedHomepageVersion],
    };
  }
  return {
    sql: "NOT EXISTS (SELECT 1 FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL)",
    args: [],
  };
}

export interface SaveThemeCustomizerDraftInput {
  readonly tokens?: Record<string, unknown>;
  readonly variants?: Record<string, unknown>;
  readonly sections?: unknown;
  readonly expectedVersion: number;
  readonly expectedVersions?: ExpectedRowVersions;
  readonly nowMs?: number;
}

/**
 * Validates and persists theme tokens/variants and/or homepage sections strictly
 * to DRAFT columns inside ONE atomic SQLite `tenantDb.batch([...])` transaction
 * guarded by BOTH row versions. Zero side effects on stale/invalid requests!
 */
export async function saveThemeCustomizerDraft(
  tenantDb: D1Database,
  member: ThemeMemberScope,
  input: SaveThemeCustomizerDraftInput,
): Promise<ThemeCustomizerAdminState> {
  const nowMs = input.nowMs ?? Date.now();
  const current = await loadThemeCustomizerAdminState(tenantDb, member);

  // 1. Validate tokens & variants strictly BEFORE any version check or DB write
  const hasThemePatch = input.tokens !== undefined || input.variants !== undefined;
  let validatedTheme: ThemeConfigSnapshot = {
    themeId: current.themeId,
    tokens: current.draft.tokens,
    variants: current.draft.variants,
  };

  if (hasThemePatch) {
    if (
      input.tokens !== undefined &&
      (typeof input.tokens !== "object" || input.tokens === null || Array.isArray(input.tokens))
    ) {
      throw new ThemeValidationError("tokens harus berupa objek konfigurasi token tema.", [
        { field: "tokens", code: "INVALID_TOKENS", message: "Expected an object for tokens" },
      ]);
    }
    if (
      input.variants !== undefined &&
      (typeof input.variants !== "object" ||
        input.variants === null ||
        Array.isArray(input.variants))
    ) {
      throw new ThemeValidationError("variants harus berupa objek konfigurasi varian tema.", [
        { field: "variants", code: "INVALID_VARIANTS", message: "Expected an object for variants" },
      ]);
    }

    // Support `headingFontFamily: null` to explicitly clear an optional custom heading font (REQ-020)
    const mergedTokens: Record<string, unknown> = { ...current.draft.tokens };
    if (input.tokens !== undefined) {
      for (const [key, val] of Object.entries(input.tokens)) {
        if (key === "headingFontFamily" && val === null) {
          delete mergedTokens.headingFontFamily;
        } else {
          mergedTokens[key] = val;
        }
      }
    }

    const mergedVariants =
      input.variants !== undefined
        ? { ...current.draft.variants, ...input.variants }
        : current.draft.variants;

    validatedTheme = parseAndValidateThemeJson(
      current.themeId,
      JSON.stringify(mergedTokens),
      JSON.stringify(mergedVariants),
    );
  }

  // 2. Validate homepage sections strictly BEFORE any write
  const hasSectionsPatch = input.sections !== undefined;
  let validatedSections: readonly AnyValidatedPageSection[] | null = null;
  if (hasSectionsPatch) {
    const res = validatePageSections(input.sections, {
      businessCategory: current.businessCategory,
    });
    validatedSections = res.sections;
  }

  if (!hasThemePatch && !hasSectionsPatch) {
    throw new PublicationValidationError(
      "Sertakan minimal satu perubahan pada tokens, variants, atau sections.",
      [
        {
          field: "body",
          code: "EMPTY_PATCH",
          message: "At least one of tokens, variants, or sections must be provided",
        },
      ],
    );
  }

  // 3. Optimistic concurrency check BEFORE touching SQLite (zero side effects!)
  assertOptimisticVersionsMatch(current, input.expectedVersion, input.expectedVersions);

  const expectedThemeVersion = current.versions.themeConfig;
  const expectedHomepageVersion = current.versions.homepage;
  const nextThemeVersion = expectedThemeVersion + 1;
  const nextHomepageVersion = expectedHomepageVersion + 1;

  const themeGuard = buildThemeGuardClause(current.themeId, expectedThemeVersion);
  const homepageGuard = buildHomepageGuardClause(current.homepageId, expectedHomepageVersion);

  // Prepare serialized payloads BEFORE opening batch
  const serializedThemeDraft = hasThemePatch
    ? serializeDraftStoragePayload("theme_config", validatedTheme)
    : null;

  let serializedPageDraftJson: string | null = null;
  let pageSlug = current.homepageSlug;
  let pageTitle = current.homepageTitle;

  if (hasSectionsPatch && validatedSections !== null) {
    const existingHomepageDto =
      current.homepageId !== null
        ? await getDraftResourceForAdmin(tenantDb, {
            resourceType: "page",
            resourceId: current.homepageId,
          })
        : null;
    const basePage = existingHomepageDto?.draft ?? existingHomepageDto?.published;
    pageSlug = basePage?.slug ?? current.homepageSlug;
    pageTitle = basePage?.title ?? current.homepageTitle;

    const pageSnapshot = buildHomepageSnapshotFromSections(validatedSections, {
      slug: pageSlug,
      title: pageTitle,
      layoutMode: basePage?.layoutMode ?? "standard",
      seo: basePage?.seo ?? null,
    });

    const draftSectionsMetaJson = serializeDraftSectionsMeta({
      sourceVersion: nextHomepageVersion,
      enabledSignature: computePublicSectionsSignature(pageSnapshot.sections),
      sections: validatedSections,
    });

    serializedPageDraftJson = serializeDraftStoragePayload("page", {
      ...pageSnapshot,
      draftSectionsJson: draftSectionsMetaJson,
    }).json;
  }

  // 4. Execute ALL draft mutations inside ONE atomic SQLite `tenantDb.batch([...])`!
  const statements: D1PreparedStatement[] = [];
  let themeStmtIdx = -1;
  let pageStmtIdx = -1;

  if (hasThemePatch && serializedThemeDraft !== null) {
    themeStmtIdx = statements.length;
    if (expectedThemeVersion === 0) {
      const preset = resolveBaseThemePreset(current.themeId);
      statements.push(
        tenantDb
          .prepare(
            `INSERT INTO theme_configs
               (theme_id, tokens_json, variants_json, draft_json, published_json, version, updated_at)
             SELECT ?, ?, ?, ?, NULL, 1, ?
             WHERE ${themeGuard.sql} AND ${homepageGuard.sql}`,
          )
          .bind(
            current.themeId,
            JSON.stringify(preset.tokens),
            JSON.stringify(preset.variants),
            serializedThemeDraft.json,
            nowMs,
            ...themeGuard.args,
            ...homepageGuard.args,
          ),
      );
    } else {
      statements.push(
        tenantDb
          .prepare(
            `UPDATE theme_configs
             SET draft_json = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE theme_id = ?
               AND version = ?
               AND ${homepageGuard.sql}`,
          )
          .bind(
            serializedThemeDraft.json,
            nowMs,
            current.themeId,
            expectedThemeVersion,
            ...homepageGuard.args,
          ),
      );
    }
  }

  if (hasSectionsPatch && serializedPageDraftJson !== null) {
    // Gate homepage write on THIS exact batch's theme write having modified 1 row (`changes() = 1`)
    // AND matching our exact serialized draft payload + version + timestamp (eliminates N -> N+1 race!).
    const effectiveThemeGuard = hasThemePatch
      ? {
          sql: "changes() = 1 AND EXISTS (SELECT 1 FROM theme_configs WHERE theme_id = ? AND version = ? AND draft_json = ? AND updated_at = ?)",
          args: [
            current.themeId,
            nextThemeVersion,
            serializedThemeDraft!.json,
            nowMs,
          ] as readonly unknown[],
        }
      : themeGuard;

    pageStmtIdx = statements.length;
    if (current.homepageId === null) {
      statements.push(
        tenantDb
          .prepare(
            `INSERT INTO pages
               (id, slug, title, is_homepage, draft_sections_json, published_sections_json, status, version, created_at, updated_at)
             SELECT MAX(COALESCE((SELECT next FROM sequences WHERE kind = 'page'), 0), COALESCE((SELECT MAX(id) FROM pages), 0)) + 1,
                    ?, ?, 1, ?, NULL, 'draft', 1, ?, ?
             WHERE ${effectiveThemeGuard.sql}
               AND NOT EXISTS (SELECT 1 FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL)`,
          )
          .bind(
            pageSlug,
            pageTitle,
            serializedPageDraftJson,
            nowMs,
            nowMs,
            ...effectiveThemeGuard.args,
          ),
      );
      // Sync sequences allocator ONLY if the preceding homepage INSERT actually inserted 1 row
      statements.push(
        tenantDb
          .prepare(
            `INSERT INTO sequences (kind, next)
             SELECT 'page', id
             FROM pages
             WHERE changes() = 1 AND is_homepage = 1 AND deleted_at IS NULL AND version = 1 AND updated_at = ?
             ON CONFLICT(kind) DO UPDATE SET next = MAX(sequences.next, excluded.next)`,
          )
          .bind(nowMs),
      );
    } else {
      statements.push(
        tenantDb
          .prepare(
            `UPDATE pages
             SET draft_sections_json = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ?
               AND is_homepage = 1
               AND deleted_at IS NULL
               AND version = ?
               AND ${effectiveThemeGuard.sql}`,
          )
          .bind(
            serializedPageDraftJson,
            nowMs,
            current.homepageId,
            expectedHomepageVersion,
            ...effectiveThemeGuard.args,
          ),
      );
    }
  }

  const batchResults = await tenantDb.batch(statements);
  const themeChanges = themeStmtIdx >= 0 ? (batchResults[themeStmtIdx]?.meta?.changes ?? 0) : 1;
  const pageChanges = pageStmtIdx >= 0 ? (batchResults[pageStmtIdx]?.meta?.changes ?? 0) : 1;

  if (themeChanges !== 1 || pageChanges !== 1) {
    const latest = await loadThemeCustomizerAdminState(tenantDb, member);
    throw new StaleRevisionError({
      resourceType: themeChanges !== 1 ? "theme_config" : "page",
      resourceId: themeChanges !== 1 ? current.themeId : (current.homepageId ?? "home"),
      expectedVersion: input.expectedVersion,
      actualVersion: latest.version,
    });
  }

  return loadThemeCustomizerAdminState(tenantDb, member);
}

export interface PublishThemeCustomizerResult {
  readonly state: ThemeCustomizerAdminState;
  readonly cacheVersion: number;
  readonly publishedAt: string;
}

/**
 * Truly atomic single-batch publication of BOTH `theme_configs` AND homepage `pages`
 * (+ `content_revisions` + retention trim) inside ONE SQLite `tenantDb.batch([...])`
 * transaction guarded by BOTH expected row versions, followed by a SINGLE
 * `PLATFORM_DB.tenants.cache_version` bump (with version-guarded compensation
 * ONLY if the `PLATFORM_DB` bump fails).
 */
export async function publishThemeCustomizerAtomically(
  platformDb: D1Database,
  tenantDb: D1Database,
  member: ThemeMemberScope,
  input: {
    readonly expectedVersion: number;
    readonly expectedVersions?: ExpectedRowVersions;
    readonly nowMs?: number;
  },
): Promise<PublishThemeCustomizerResult> {
  const nowMs = input.nowMs ?? Date.now();
  const current = await loadThemeCustomizerAdminState(tenantDb, member);

  // 1. Optimistic concurrency check BEFORE any DB write (zero side effects!)
  assertOptimisticVersionsMatch(current, input.expectedVersion, input.expectedVersions);

  // 2. Strictly re-validate theme tokens + homepage sections before touching SQLite
  const validatedTheme = parseAndValidateThemeJson(
    current.themeId,
    JSON.stringify(current.draft.tokens),
    JSON.stringify(current.draft.variants),
  );
  const validatedSections = validatePageSections(current.draft.sections, {
    businessCategory: current.businessCategory,
  });

  const expectedThemeVersion = current.versions.themeConfig;
  const expectedHomepageVersion = current.versions.homepage;
  const nextThemeVersion = expectedThemeVersion + 1;
  const nextHomepageVersion = expectedHomepageVersion + 1;

  // Snapshot prior rows for version-guarded compensation ONLY if PLATFORM_DB bump fails
  const [priorThemeRow, priorPageRow, existingHomepageDto] = await Promise.all([
    expectedThemeVersion > 0
      ? tenantDb
          .prepare(
            "SELECT tokens_json, variants_json, draft_json, published_json, version, updated_at FROM theme_configs WHERE theme_id = ? LIMIT 1",
          )
          .bind(current.themeId)
          .first<{
            readonly tokens_json: string;
            readonly variants_json: string;
            readonly draft_json: string | null;
            readonly published_json: string | null;
            readonly version: number;
            readonly updated_at: number;
          }>()
      : Promise.resolve(null),
    current.homepageId !== null
      ? tenantDb
          .prepare(
            "SELECT id, slug, title, is_homepage, draft_sections_json, published_sections_json, seo_json, status, published_at, content_modified_at, version, updated_at FROM pages WHERE id = ? LIMIT 1",
          )
          .bind(current.homepageId)
          .first<{
            readonly id: number;
            readonly slug: string;
            readonly title: string;
            readonly is_homepage: number;
            readonly draft_sections_json: string;
            readonly published_sections_json: string | null;
            readonly seo_json: string | null;
            readonly status: string;
            readonly published_at: number | null;
            readonly content_modified_at: number | null;
            readonly version: number;
            readonly updated_at: number;
          }>()
      : Promise.resolve(null),
    current.homepageId !== null
      ? getDraftResourceForAdmin(tenantDb, {
          resourceType: "page",
          resourceId: current.homepageId,
        })
      : Promise.resolve(null),
  ]);

  // Build canonical frozen published snapshots
  const themeEnvelope = buildPublishedSnapshot("theme_config", validatedTheme, {
    publishedAt: nowMs,
    contentModifiedAt: nowMs,
  });
  const publishedThemeJson = JSON.stringify(themeEnvelope);
  const draftThemePayloadJson = serializeDraftStoragePayload("theme_config", validatedTheme).json;

  const basePage = existingHomepageDto?.draft ?? existingHomepageDto?.published;
  const pageSlug = basePage?.slug ?? current.homepageSlug;
  const pageTitle = basePage?.title ?? current.homepageTitle;
  const homepagePublishSnapshot = buildHomepageSnapshotFromSections(validatedSections.sections, {
    slug: pageSlug,
    title: pageTitle,
    layoutMode: basePage?.layoutMode ?? "standard",
    seo: basePage?.seo ?? null,
  });

  const priorPublishedAt = priorPageRow?.published_at ?? nowMs;
  const pageEnvelope = buildPublishedSnapshot("page", homepagePublishSnapshot, {
    publishedAt: priorPublishedAt,
    contentModifiedAt: nowMs,
  });
  const publishedPageJson = JSON.stringify(pageEnvelope);

  // Keep draft_sections_json synchronized with nextHomepageVersion while preserving disabled sections
  const syncedDraftSectionsMetaJson = serializeDraftSectionsMeta({
    sourceVersion: nextHomepageVersion,
    enabledSignature: computePublicSectionsSignature(homepagePublishSnapshot.sections),
    sections: validatedSections.sections,
  });
  const syncedDraftPageJson = serializeDraftStoragePayload("page", {
    ...homepagePublishSnapshot,
    draftSectionsJson: syncedDraftSectionsMetaJson,
  }).json;

  const themeGuard = buildThemeGuardClause(current.themeId, expectedThemeVersion);
  const homepageGuard = buildHomepageGuardClause(current.homepageId, expectedHomepageVersion);

  // 3. Build ONE atomic SQLite `tenantDb.batch([...])` swapping BOTH `theme_configs` and `pages`
  const statements: D1PreparedStatement[] = [];

  // Statement 0: `theme_configs` atomic publish (guarded by BOTH themeGuard AND homepageGuard!)
  if (expectedThemeVersion === 0) {
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO theme_configs
             (theme_id, tokens_json, variants_json, draft_json, published_json, version, updated_at)
           SELECT ?, ?, ?, ?, ?, 1, ?
           WHERE ${themeGuard.sql} AND ${homepageGuard.sql}`,
        )
        .bind(
          current.themeId,
          JSON.stringify(themeEnvelope.data.tokens),
          JSON.stringify(themeEnvelope.data.variants),
          draftThemePayloadJson,
          publishedThemeJson,
          nowMs,
          ...themeGuard.args,
          ...homepageGuard.args,
        ),
    );
  } else {
    statements.push(
      tenantDb
        .prepare(
          `UPDATE theme_configs
           SET tokens_json = ?,
               variants_json = ?,
               published_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE theme_id = ?
             AND version = ?
             AND ${homepageGuard.sql}`,
        )
        .bind(
          JSON.stringify(themeEnvelope.data.tokens),
          JSON.stringify(themeEnvelope.data.variants),
          publishedThemeJson,
          nowMs,
          current.themeId,
          expectedThemeVersion,
          ...homepageGuard.args,
        ),
    );
  }

  // Statement 1: homepage `pages` atomic publish (gated on Statement 0 having modified 1 row
  // via `changes() = 1` AND matching our exact published_json + version + updated_at — zero N->N+1 race!)
  const themeSwappedGuardSql =
    "changes() = 1 AND EXISTS (SELECT 1 FROM theme_configs WHERE theme_id = ? AND version = ? AND published_json = ? AND updated_at = ?)";

  if (current.homepageId === null) {
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO pages
             (id, slug, title, is_homepage, draft_sections_json, published_sections_json, seo_json, status, published_at, content_modified_at, version, created_at, updated_at)
           SELECT MAX(COALESCE((SELECT next FROM sequences WHERE kind = 'page'), 0), COALESCE((SELECT MAX(id) FROM pages), 0)) + 1,
                  ?, ?, 1, ?, ?, ?, 'published', ?, ?, 1, ?, ?
           WHERE ${themeSwappedGuardSql}
             AND NOT EXISTS (SELECT 1 FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL)`,
        )
        .bind(
          pageSlug,
          pageTitle,
          syncedDraftPageJson,
          publishedPageJson,
          homepagePublishSnapshot.seo ? JSON.stringify(homepagePublishSnapshot.seo) : null,
          pageEnvelope.publishedAt,
          pageEnvelope.contentModifiedAt,
          nowMs,
          nowMs,
          current.themeId,
          nextThemeVersion,
          publishedThemeJson,
          nowMs,
        ),
    );
    // Sync sequences allocator ONLY if the preceding homepage INSERT actually modified 1 row
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO sequences (kind, next)
           SELECT 'page', id
           FROM pages
           WHERE changes() = 1 AND is_homepage = 1 AND deleted_at IS NULL AND version = 1 AND updated_at = ?
           ON CONFLICT(kind) DO UPDATE SET next = MAX(sequences.next, excluded.next)`,
        )
        .bind(nowMs),
    );
  } else {
    statements.push(
      tenantDb
        .prepare(
          `UPDATE pages
           SET slug = ?,
               title = ?,
               is_homepage = 1,
               seo_json = ?,
               draft_sections_json = ?,
               published_sections_json = ?,
               status = 'published',
               published_at = COALESCE(published_at, ?),
               content_modified_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND is_homepage = 1
             AND deleted_at IS NULL
             AND version = ?
             AND ${themeSwappedGuardSql}`,
        )
        .bind(
          pageSlug,
          pageTitle,
          homepagePublishSnapshot.seo ? JSON.stringify(homepagePublishSnapshot.seo) : null,
          syncedDraftPageJson,
          publishedPageJson,
          pageEnvelope.publishedAt,
          pageEnvelope.contentModifiedAt,
          nowMs,
          current.homepageId,
          expectedHomepageVersion,
          current.themeId,
          nextThemeVersion,
          publishedThemeJson,
          nowMs,
        ),
    );
  }

  // Record homepage content revision + trim to MAX_RETAINED_REVISIONS inside the EXACT same atomic batch!
  statements.push(
    tenantDb
      .prepare(
        `INSERT INTO content_revisions (resource_type, resource_id, revision_number, snapshot_json, created_by, created_at)
         SELECT 'page', p.id,
                COALESCE((SELECT MAX(revision_number) FROM content_revisions WHERE resource_type = 'page' AND resource_id = p.id), 0) + 1,
                ?, ?, ?
         FROM pages p
         WHERE p.is_homepage = 1
           AND p.deleted_at IS NULL
           AND p.version = ?
           AND p.published_sections_json = ?
           AND p.updated_at = ?
           AND EXISTS (
             SELECT 1 FROM theme_configs
             WHERE theme_id = ? AND version = ? AND published_json = ? AND updated_at = ?
           )`,
      )
      .bind(
        publishedPageJson,
        member.userId,
        nowMs,
        nextHomepageVersion,
        publishedPageJson,
        nowMs,
        current.themeId,
        nextThemeVersion,
        publishedThemeJson,
        nowMs,
      ),
  );

  statements.push(
    tenantDb
      .prepare(
        `DELETE FROM content_revisions
         WHERE changes() = 1
           AND resource_type = 'page'
           AND resource_id = (SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL LIMIT 1)
           AND revision_number NOT IN (
             SELECT revision_number
             FROM content_revisions
             WHERE resource_type = 'page'
               AND resource_id = (SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL LIMIT 1)
             ORDER BY revision_number DESC
             LIMIT ?
           )`,
      )
      .bind(MAX_RETAINED_REVISIONS),
  );

  const batchResults = await tenantDb.batch(statements);
  const themeChanges = batchResults[0]?.meta?.changes ?? 0;
  const pageChanges = batchResults[1]?.meta?.changes ?? 0;

  if (themeChanges !== 1 || pageChanges !== 1) {
    const latest = await loadThemeCustomizerAdminState(tenantDb, member);
    throw new StaleRevisionError({
      resourceType: themeChanges !== 1 ? "theme_config" : "page",
      resourceId: themeChanges !== 1 ? current.themeId : (current.homepageId ?? "home"),
      expectedVersion: input.expectedVersion,
      actualVersion: latest.version,
    });
  }

  // 4. Bump PLATFORM_DB.tenants.cache_version EXACTLY ONCE!
  //    On failure, execute a single version-guarded compensating batch (never clobbering concurrent writes).
  let cacheVersion: number;
  try {
    cacheVersion = await bumpTenantCacheVersion(platformDb, member.tenantId, nowMs);
  } catch (platformErr) {
    let compensated: boolean;
    try {
      const rollbackStmts: D1PreparedStatement[] = [];
      if (priorThemeRow) {
        rollbackStmts.push(
          tenantDb
            .prepare(
              `UPDATE theme_configs
               SET tokens_json = ?, variants_json = ?, draft_json = ?, published_json = ?, version = ?, updated_at = ?
               WHERE theme_id = ? AND version = ?`,
            )
            .bind(
              priorThemeRow.tokens_json,
              priorThemeRow.variants_json,
              priorThemeRow.draft_json,
              priorThemeRow.published_json,
              priorThemeRow.version,
              priorThemeRow.updated_at,
              current.themeId,
              nextThemeVersion,
            ),
        );
      } else {
        rollbackStmts.push(
          tenantDb
            .prepare("DELETE FROM theme_configs WHERE theme_id = ? AND version = 1 AND updated_at = ?")
            .bind(current.themeId, nowMs),
        );
      }

      if (priorPageRow) {
        rollbackStmts.push(
          tenantDb
            .prepare(
              `UPDATE pages
               SET slug = ?, title = ?, is_homepage = ?, draft_sections_json = ?, published_sections_json = ?,
                   seo_json = ?, status = ?, published_at = ?, content_modified_at = ?, version = ?, updated_at = ?
               WHERE id = ? AND version = ?`,
            )
            .bind(
              priorPageRow.slug,
              priorPageRow.title,
              priorPageRow.is_homepage,
              priorPageRow.draft_sections_json,
              priorPageRow.published_sections_json,
              priorPageRow.seo_json,
              priorPageRow.status,
              priorPageRow.published_at,
              priorPageRow.content_modified_at,
              priorPageRow.version,
              priorPageRow.updated_at,
              priorPageRow.id,
              nextHomepageVersion,
            ),
        );
      } else {
        rollbackStmts.push(
          tenantDb
            .prepare("DELETE FROM pages WHERE is_homepage = 1 AND version = 1 AND updated_at = ?")
            .bind(nowMs),
        );
      }

      rollbackStmts.push(
        tenantDb
          .prepare(
            `DELETE FROM content_revisions
             WHERE changes() = 1
               AND resource_type = 'page'
               AND snapshot_json = ?
               AND created_at = ?
               AND (? IS NULL OR resource_id = ?)`,
          )
          .bind(
            publishedPageJson,
            nowMs,
            priorPageRow?.id ?? null,
            priorPageRow?.id ?? null,
          ),
      );

      const rbRes = await tenantDb.batch(rollbackStmts);
      compensated =
        (rbRes[0]?.meta?.changes ?? 0) === 1 && (rbRes[1]?.meta?.changes ?? 0) === 1;
    } catch {
      compensated = false;
    }

    throw new PublicationAtomicError(
      `Failed to bump tenant cache_version during atomic theme publish${
        compensated ? "; TenantStore rolled back cleanly" : "; TenantStore compensation incomplete"
      }`,
      { compensated, cause: platformErr },
    );
  }

  const freshState = await loadThemeCustomizerAdminState(tenantDb, member);
  return {
    state: freshState,
    cacheVersion,
    publishedAt: new Date(nowMs).toISOString(),
  };
}

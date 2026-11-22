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
  PublicationNotFoundError,
  PublicationValidationError,
  StaleRevisionError,
} from "@punyasitus/core/content/index";
import type { EmailPort } from "@punyasitus/core/email/index";
import {
  buildPreviewResponseHeaders,
  MAX_PREVIEW_REQUEST_BYTES,
  PREVIEW_API_CSP_HEADER,
  PREVIEW_IFRAME_SANDBOX,
  PreviewPayloadTooLargeError,
  PreviewThemeError,
  PreviewValidationError,
  validateDraftPreviewInput,
  type DraftPreviewApiResponse,
  type ValidatedDraftPreviewInput,
} from "@punyasitus/core/preview/index";
import type { ApiErrorCode } from "@punyasitus/core/schemas";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  renderSemanticPreviewShellFallback,
  renderTenantDraftPreview,
  type RenderPreviewShellDocumentFn,
} from "../../../../../core/preview/service.ts";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared server authorization, strict DTO parsing, and in-process preview handler
 * for `POST /api/tenants/:tenantId/preview` (REQ-036, REQ-001, REQ-034, REQ-039; PLAN §14; TASK-050).
 */

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface TenantPreviewRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantPreviewHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  /** Optional pre-resolved authenticated user (e.g. from Astro middleware `locals.authUser`). */
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  /** Optional hook to supply a TenantStore D1Database handle directly in tests. */
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
  /**
   * In-process Astro shell document renderer.
   * Production Astro endpoints ALWAYS pass `renderPreviewDocumentInProcess` (`Layout.astro`).
   */
  readonly renderShellDocument?: RenderPreviewShellDocumentFn;
}

export interface AuthorizedPreviewRequestContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
}

export function createPreviewRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function previewJsonResponse(
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

export function previewErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return previewJsonResponse(
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
 * Determines the exact RBAC permission required for a validated preview request:
 * - Previewing `theme` or `identity` drafts (or supplying `themeId`/`siteSettings`/`businessProfile`/`themeConfig`
 *   overrides) requires `"settings:write"` (Owner/Admin only; Editor gets `403 FORBIDDEN`).
 * - Previewing `page`/`post`/`offering`/`home`/`menu` with an inline `draftOverride` requires `"content:write"`.
 * - Previewing saved content drafts without inline overrides requires `"content:read"`.
 */
export function resolveRequiredPreviewPermission(
  input: ValidatedDraftPreviewInput,
): PermissionAction {
  const touchesSettingsOrTheme =
    input.resourceKind === "theme" ||
    input.resourceKind === "identity" ||
    input.themeId !== undefined ||
    input.draftOverride?.themeConfig !== undefined ||
    input.draftOverride?.siteSettings !== undefined ||
    input.draftOverride?.businessProfile !== undefined;

  if (touchesSettingsOrTheme) {
    return "settings:write";
  }

  if (input.draftOverride !== undefined) {
    return "content:write";
  }

  return "content:read";
}

/**
 * Enforces:
 * 1. Platform `app` host isolation (`404` on tenant/console/marketing hosts).
 * 2. CSRF & Origin check on state-changing requests (`403` on missing/mismatched Origin or non-JSON).
 * 3. Better Auth session verification + `enforceSessionLifetimeCeiling` (`401 UNAUTHENTICATED`;
 *    expired sessions are rejected and CANNOT refresh/render previews).
 * 4. Live `PLATFORM_DB` membership + RBAC + tenant lifecycle status gate (`404` for wrong-tenant /
 *    non-member; `403` for wrong-role or locked/suspended service state).
 * 5. Opens ONLY the verified tenant's own physically isolated `TenantStore`.
 */
export async function authorizeTenantPreviewRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantPreviewRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantPreviewHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedPreviewRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createPreviewRequestId();

  // 1. Platform app host isolation — NEVER served on tenant hosts or console host!
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: previewErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin validation for POST
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: previewErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: previewErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // 4. Verify Better Auth session + strict lifetime ceiling (expired sessions MUST fail with 401 and CANNOT refresh)
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: previewErrorResponse(
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
      response: previewErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Sesi Anda telah berakhir atau tidak valid. Silakan masuk kembali untuk memuat pratinjau.",
        requestId,
      ),
    };
  }

  // 5. Live membership + RBAC + tenant lifecycle status check against PLATFORM_DB
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: previewErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
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
        response: previewErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: previewErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // 6. Open ONLY the verified tenant's physically isolated TenantStore
  let tenantDb: D1Database | null = null;
  if (options.resolveTenantDb) {
    tenantDb = await options.resolveTenantDb(member.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
  }

  if (!tenantDb) {
    return {
      ok: false,
      response: previewErrorResponse(
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

function mapPreviewDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof PreviewPayloadTooLargeError) {
    return previewErrorResponse(413, "PAYLOAD_TOO_LARGE", err.message, requestId);
  }
  if (
    err instanceof PreviewThemeError ||
    err instanceof PreviewValidationError ||
    err instanceof PublicationValidationError
  ) {
    return previewErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof StaleRevisionError) {
    return previewErrorResponse(409, "STALE_VERSION", err.message, requestId, [
      {
        field: "expectedVersion",
        code: "STALE_VERSION",
        message: err.message,
      },
    ]);
  }
  if (err instanceof PublicationNotFoundError) {
    return previewErrorResponse(
      404,
      "NOT_FOUND",
      "Draf konten yang diminta tidak ditemukan.",
      requestId,
    );
  }
  if (err instanceof AuthorizationError) {
    return previewErrorResponse(err.status, err.code, err.message, requestId);
  }
  return previewErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Pratinjau draf sementara tidak dapat dirender. Draf tersimpan Anda tetap aman.",
    requestId,
    undefined,
    { "Retry-After": "15" },
  );
}

/**
 * Full server-authorized handler for `POST /api/tenants/:tenantId/preview` (PLAN §14; TASK-050).
 */
export async function handleTenantPreviewRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantPreviewRuntimeEnv,
  options: TenantPreviewHandlerOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createPreviewRequestId();
  const method = request.method.toUpperCase();

  // Only POST is permitted (CSRF + JSON body boundary)
  if (method !== "POST") {
    const auth = await authorizeTenantPreviewRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return previewErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan metode POST dengan body JSON untuk merender pratinjau draf.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  // First enforce host, CSRF/Origin, session + ceiling, and baseline tenant membership BEFORE parsing payload
  const baseAuth = await authorizeTenantPreviewRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:read",
    { ...options, requestId },
  );
  if (!baseAuth.ok) {
    return baseAuth.response;
  }

  // Enforce hard 128 KiB byte ceiling BEFORE JSON.parse
  let rawBytes: Uint8Array;
  try {
    rawBytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return previewErrorResponse(400, "BAD_REQUEST", "Gagal membaca body permintaan.", requestId);
  }

  if (rawBytes.byteLength > MAX_PREVIEW_REQUEST_BYTES) {
    return previewErrorResponse(
      413,
      "PAYLOAD_TOO_LARGE",
      `Ukuran payload pratinjau melebihi batas maksimum ${MAX_PREVIEW_REQUEST_BYTES} byte.`,
      requestId,
    );
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (!rawText) {
    return previewErrorResponse(
      400,
      "BAD_REQUEST",
      "Body JSON pratinjau tidak boleh kosong.",
      requestId,
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    return previewErrorResponse(400, "BAD_REQUEST", "Format JSON pratinjau tidak valid.", requestId);
  }

  let validatedInput: ValidatedDraftPreviewInput;
  try {
    validatedInput = validateDraftPreviewInput(parsedJson);
  } catch (err) {
    return mapPreviewDomainErrorToResponse(err, requestId);
  }

  // Re-verify stricter RBAC permission if the validated request requires content:write or settings:write
  const requiredPermission = resolveRequiredPreviewPermission(validatedInput);
  if (requiredPermission !== "content:read") {
    const strictAuth = await authorizeTenantPreviewRequest(
      tenantId,
      request,
      runtimeEnv,
      requiredPermission,
      {
        ...options,
        requestId,
        authenticatedUser: { id: baseAuth.ctx.member.userId },
        activeOrganizationId: baseAuth.ctx.member.organizationId,
      },
    );
    if (!strictAuth.ok) {
      return strictAuth.response;
    }
  }

  try {
    const rendered = await renderTenantDraftPreview(
      {
        platformDb: baseAuth.ctx.platformDb,
        tenantDb: baseAuth.ctx.tenantDb,
        tenantId: baseAuth.ctx.member.tenantId,
        tenantHandle: baseAuth.ctx.member.handle,
        tenantName: baseAuth.ctx.member.tenantName,
        input: validatedInput,
      },
      options.renderShellDocument ?? renderSemanticPreviewShellFallback,
    );

    const payload: DraftPreviewApiResponse = {
      html: rendered.html,
      themeId: rendered.model.themeId,
      version: rendered.model.version,
      resourceKind: rendered.model.resourceKind,
      resourceId: rendered.model.resourceId,
      layoutMode: rendered.model.layoutMode,
      isPreview: true,
      hasUnpublishedChanges: rendered.model.hasUnpublishedChanges,
      sandbox: PREVIEW_IFRAME_SANDBOX,
    };

    return previewJsonResponse(200, payload);
  } catch (err) {
    return mapPreviewDomainErrorToResponse(err, requestId);
  }
}

import { env } from "cloudflare:workers";
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
  assertNoForbiddenTenantSelectors,
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  StaleRevisionError,
} from "@punyasitus/core/content/index";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";
import { SlugValidationError } from "@punyasitus/core/slug/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  PostAuthorConflictError,
  PostAuthorNotFoundError,
  PostAuthorStaleVersionError,
  PostAuthorValidationError,
  TaxonomyConflictError,
  TaxonomyNotFoundError,
  TaxonomyStaleVersionError,
  type BlogTaxonomyRecord,
  type PostAuthorRecord,
  type PostRecord,
} from "@punyasitus/db/posts/index";
import {
  TrashConflictError,
  TrashNotFoundError,
  TrashProtectedReferenceError,
  TrashValidationError,
} from "@punyasitus/db/trash/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared security, host-isolation, CSRF/Origin, Better Auth session lifetime,
 * live membership + RBAC + tenant-lock guard, strict JSON parser, and error mapper
 * for `/api/tenants/:tenantId/{posts,categories,tags}/**`
 * (TASK-006; REQ-009, REQ-034, REQ-036, REQ-061).
 */

export const MAX_POST_BODY_BYTES = 262_144 as const; // 256 KiB ceiling
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TENANT_SELECTOR_KEYS);

export const BLOG_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface TenantBlogRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
  readonly MEDIA_PUBLIC_BASE_URL?: string;
}

export interface TenantBlogHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

export interface AuthorizedBlogRequestContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
}

export function createBlogRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function blogJsonResponse(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(BLOG_NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function blogNoContentResponse(extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(null, { status: 204, headers });
}

export function blogErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return blogJsonResponse(
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

export function formatPostRecordResponse(post: PostRecord): Record<string, unknown> {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    status: post.status,
    body: post.body,
    sanitizedHtml: post.sanitizedHtml,
    toc: post.toc,
    readingTimeMinutes: post.readingTimeMinutes,
    featuredMediaId: post.featuredMediaId,
    coverMediaId: post.coverMediaId,
    primaryCategoryId: post.primaryCategoryId,
    categoryIds: post.categoryIds,
    tagIds: post.tagIds,
    authorId: post.authorId,
    authorProfileId: post.authorProfileId,
    authorUserId: post.authorUserId,
    authorName: post.authorName,
    enableToc: post.enableToc,
    showToc: post.showToc,
    tocEnabled: post.tocEnabled,
    seo: post.seo,
    published: post.published,
    hasUnpublishedChanges: post.hasUnpublishedChanges,
    formerSlugs: post.formerSlugs,
    version: post.version,
    publishedAt: post.publishedAt,
    contentModifiedAt: post.contentModifiedAt,
    contentFingerprint: post.contentFingerprint,
    deletedAt: post.deletedAt,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

export function formatAuthorRecordResponse(author: PostAuthorRecord): Record<string, unknown> {
  return {
    id: author.id,
    name: author.name,
    slug: author.slug,
    roleTitle: author.roleTitle,
    role_title: author.roleTitle,
    bio: author.bio,
    avatarMediaId: author.avatarMediaId,
    avatar_media_id: author.avatarMediaId,
    avatar: author.avatar,
    sameAs: author.sameAs,
    postCount: author.postCount,
    publishedPostCount: author.publishedPostCount,
    version: author.version,
    createdAt: author.createdAt,
    updatedAt: author.updatedAt,
  };
}

export function formatTaxonomyRecordResponse(tax: BlogTaxonomyRecord): Record<string, unknown> {
  return {
    id: tax.id,
    kind: tax.kind,
    name: tax.name,
    slug: tax.slug,
    description: tax.description,
    parentId: tax.parentId,
    depth: tax.depth,
    sortOrder: tax.sortOrder,
    publishedCount: tax.publishedCount,
    usageCount: tax.usageCount,
    indexable: tax.indexable,
    formerSlugs: tax.formerSlugs,
    version: tax.version,
    createdAt: tax.createdAt,
    updatedAt: tax.updatedAt,
  };
}

export function buildBlogRuntimeEnv(): TenantBlogRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly MEDIA_PUBLIC_BASE_URL?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
    MEDIA_PUBLIC_BASE_URL: runtimeEnv.MEDIA_PUBLIC_BASE_URL,
  };
}

/**
 * Enforces:
 * 1. Platform `app` host surface check (neutral `404` on tenant/marketing/console hosts).
 * 2. Admin CSRF & Origin check on state-changing methods (`POST`/`PUT`/`PATCH`/`DELETE`).
 * 3. Better Auth session verification + lifetime ceiling (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership, RBAC (`content:read`/`content:write`/`content:publish`/`taxonomy:manage`),
 *    and tenant lifecycle lock (`locked`/`suspended` -> `403`, non-member -> `404`).
 * 5. Opens ONLY the verified tenant's physically isolated `TenantStore` via `member.tenantId`.
 */
export async function authorizeTenantBlogRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantBlogRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantBlogHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedBlogRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createBlogRequestId();

  // 1. Platform `app` host check
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: blogErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin enforcement on state-changing methods
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: blogErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed PLATFORM_DB check
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: blogErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // 4. Resolve authenticated session user
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: blogErrorResponse(
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
      response: blogErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Autentikasi diperlukan untuk mengakses blog tenant.",
        requestId,
      ),
    };
  }

  // 5. Live membership + RBAC + tenant lifecycle check against PLATFORM_DB
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: blogErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
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
        response: blogErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: blogErrorResponse(
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
      response: blogErrorResponse(
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
    ctx: { requestId, member, platformDb: runtimeEnv.PLATFORM_DB, tenantDb },
  };
}

export function parseSequentialIdParam(
  rawId: string,
  field: string,
  label: string,
  requestId: string,
): { readonly ok: true; readonly id: number } | { readonly ok: false; readonly response: Response } {
  const trimmed = rawId.trim();
  if (!/^[1-9]\d{0,9}$/.test(trimmed)) {
    return {
      ok: false,
      response: blogErrorResponse(
        422,
        "VALIDATION_ERROR",
        `ID ${label} harus berupa bilangan bulat positif.`,
        requestId,
        [
          {
            field,
            code: "INVALID_ID",
            message: `Expected a positive sequential integer for ${field}.`,
          },
        ],
      ),
    };
  }
  const id = Number(trimmed);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) {
    return {
      ok: false,
      response: blogErrorResponse(
        422,
        "VALIDATION_ERROR",
        `ID ${label} di luar rentang yang diizinkan.`,
        requestId,
        [
          {
            field,
            code: "INVALID_ID",
            message: `${field} must be between 1 and 2147483647.`,
          },
        ],
      ),
    };
  }
  return { ok: true, id };
}

export type ParsedBlogJsonBodyResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response };

export async function parseStrictBlogJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
  options: { readonly allowEmptyBody?: boolean } = {},
): Promise<ParsedBlogJsonBodyResult> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_POST_BODY_BYTES) {
    return {
      ok: false,
      response: blogErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_POST_BODY_BYTES} byte.`,
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
      response: blogErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json") && !contentType.includes("+json")) {
    return {
      ok: false,
      response: blogErrorResponse(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type harus application/json.",
        requestId,
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: blogErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: blogErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
        [{ field: "body", code: "INVALID_PAYLOAD", message: "Expected a JSON object." }],
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_TENANT_KEY_SET.has(key)) {
      return {
        ok: false,
        response: blogErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field "${key}" tidak diizinkan dalam body permintaan tenant.`,
          requestId,
          [
            {
              field: key,
              code: "FORBIDDEN_TENANT_SELECTOR",
              message: `Tenant selector field "${key}" is forbidden in request body.`,
            },
          ],
        ),
      };
    }
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        response: blogErrorResponse(
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

  try {
    assertNoForbiddenTenantSelectors(record);
  } catch (err) {
    if (err instanceof PublicationValidationError) {
      return {
        ok: false,
        response: blogErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields),
      };
    }
    throw err;
  }

  return { ok: true, body: record };
}

export function extractBlogExpectedVersion(
  body: Record<string, unknown>,
  requestId: string,
  options: { readonly required?: boolean } = {},
):
  | { readonly ok: true; readonly expectedVersion: number | undefined }
  | { readonly ok: false; readonly response: Response } {
  const hasVersion = body.version !== undefined;
  const hasExpectedVersion = body.expectedVersion !== undefined;

  if (hasVersion && hasExpectedVersion && body.version !== body.expectedVersion) {
    return {
      ok: false,
      response: blogErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version dan expectedVersion harus bernilai sama jika keduanya dikirim.",
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
    if (options.required) {
      return {
        ok: false,
        response: blogErrorResponse(
          422,
          "VALIDATION_ERROR",
          "Field version wajib dikirim untuk kontrol konkurensi optimistik.",
          requestId,
          [
            {
              field: "version",
              code: "REQUIRED",
              message: "Optimistic concurrency version is required.",
            },
          ],
        ),
      };
    }
    return { ok: true, expectedVersion: undefined };
  }

  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > 2_147_483_647) {
    return {
      ok: false,
      response: blogErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version harus berupa bilangan bulat non-negatif.",
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

  return { ok: true, expectedVersion: raw };
}

export function parseListPaginationParams(
  url: URL,
  requestId: string,
):
  | {
      readonly ok: true;
      readonly limit: number;
      readonly sortOrder: "asc" | "desc";
      readonly cursor: string | undefined;
    }
  | { readonly ok: false; readonly response: Response } {
  const rawLimit = url.searchParams.get("limit");
  let limit = 20;
  if (rawLimit !== null && rawLimit.trim() !== "") {
    if (!/^\d+$/.test(rawLimit.trim())) {
      return {
        ok: false,
        response: blogErrorResponse(
          422,
          "VALIDATION_ERROR",
          "Parameter limit harus berupa bilangan bulat antara 1 hingga 100.",
          requestId,
          [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be an integer 1..100" }],
        ),
      };
    }
    const parsedLimit = Number(rawLimit.trim());
    if (parsedLimit < 1 || parsedLimit > 100) {
      return {
        ok: false,
        response: blogErrorResponse(
          422,
          "VALIDATION_ERROR",
          "Parameter limit harus antara 1 hingga 100.",
          requestId,
          [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be between 1 and 100" }],
        ),
      };
    }
    limit = parsedLimit;
  }

  const rawSortOrder = url.searchParams.get("sortOrder")?.trim() ?? "desc";
  if (rawSortOrder !== "asc" && rawSortOrder !== "desc") {
    return {
      ok: false,
      response: blogErrorResponse(
        422,
        "VALIDATION_ERROR",
        'Parameter sortOrder harus "asc" atau "desc".',
        requestId,
        [{ field: "sortOrder", code: "INVALID_SORT_ORDER", message: 'sortOrder must be "asc" or "desc"' }],
      ),
    };
  }

  const cursor = url.searchParams.get("cursor") ?? undefined;
  return { ok: true, limit, sortOrder: rawSortOrder, cursor };
}

export function mapBlogDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof TrashProtectedReferenceError) {
    return blogJsonResponse(409, {
      error: {
        code: err.code,
        message: err.message,
        fields: err.fields,
        protectedReferences: err.references,
      },
      requestId,
    });
  }
  if (err instanceof TrashConflictError) {
    return blogJsonResponse(409, {
      error: {
        code: err.code,
        message: err.message,
        fields: err.fields,
        ...(err.suggestedSlug ? { suggestedSlug: err.suggestedSlug } : {}),
        ...(err.conflictKind ? { conflictKind: err.conflictKind } : {}),
      },
      requestId,
    });
  }
  if (err instanceof TrashValidationError) {
    return blogErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof TrashNotFoundError) {
    return blogErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof SlugValidationError) {
    return blogErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof PostAuthorValidationError) {
    return blogErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof PostAuthorStaleVersionError) {
    return blogErrorResponse(409, "STALE_VERSION", err.message, requestId, [
      {
        field: "version",
        code: "STALE_VERSION",
        message: err.message,
      },
    ]);
  }
  if (err instanceof PostAuthorConflictError) {
    return blogJsonResponse(409, {
      error: {
        code: "CONFLICT",
        reason: err.reason,
        message: err.message,
        fields: err.fields,
        postCount: err.postCount,
        publishedPostCount: err.publishedPostCount,
      },
      requestId,
    });
  }
  if (err instanceof PostAuthorNotFoundError) {
    return blogErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof PublicationValidationError) {
    return blogErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof StaleRevisionError || err instanceof TaxonomyStaleVersionError) {
    return blogErrorResponse(409, "STALE_VERSION", err.message, requestId, [
      {
        field: "version",
        code: "STALE_VERSION",
        message: err.message,
      },
    ]);
  }
  if (err instanceof TaxonomyConflictError) {
    return blogErrorResponse(409, "CONFLICT", err.message, requestId, err.fields);
  }
  if (err instanceof PublicationNotFoundError || err instanceof TaxonomyNotFoundError) {
    return blogErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof PublicationAtomicError) {
    return blogErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal menyelesaikan operasi publikasi atomik artikel blog.",
      requestId,
      undefined,
      { "Retry-After": "5" },
    );
  }
  if (err instanceof AuthorizationError) {
    return blogErrorResponse(err.status, err.code, err.message, requestId);
  }
  return blogErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Gagal memproses operasi blog tenant.",
    requestId,
    undefined,
    { "Retry-After": "60" },
  );
}

import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
  type PermissionAction,
} from "@punyasitus/auth";
import { FORBIDDEN_TENANT_SELECTOR_KEYS } from "@punyasitus/core/schemas";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import type { MediaItemRecord } from "@punyasitus/db/media/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";
import type { JobQueuePayload } from "../../../../../worker/env.d.ts";
import type { MediaWorkerR2BucketLike } from "../../../../../worker/queues/media/index.ts";

export interface MediaApiErrorField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export const MEDIA_NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface MediaApiRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
  readonly MEDIA_BUCKET?: MediaWorkerR2BucketLike | null;
  readonly JOBS_QUEUE?: { send(message: JobQueuePayload): Promise<unknown> } | null;
  readonly MEDIA_PUBLIC_BASE_URL?: string;
}

export interface MediaApiHandlerOptions {
  /** Optional explicit authenticated userId (used when session was already verified by middleware or tests). */
  readonly authenticatedUserId?: string | null;
  /** Optional pre-opened tenant DB override (defaults to opening `env.TENANT_STORE` by resolved `member.tenantId`). */
  readonly resolveTenantDb?: (tenantId: string) => D1Database;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly hourlyLimit?: number;
  readonly dailyLimit?: number;
  readonly intentTtlMs?: number;
}

export function createRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function createMediaJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...MEDIA_NO_STORE_HEADERS,
      ...extraHeaders,
    },
  });
}

export function createMediaErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  options?: {
    readonly fields?: readonly MediaApiErrorField[];
    readonly retryAfterSeconds?: number;
    readonly extra?: Record<string, unknown>;
  },
): Response {
  const headers: Record<string, string> = {};
  if (options?.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(options.retryAfterSeconds)));
  }
  return createMediaJsonResponse(
    status,
    {
      error: {
        code,
        message,
        ...(options?.fields && options.fields.length > 0 ? { fields: options.fields } : {}),
        ...(options?.extra ?? {}),
      },
      requestId,
    },
    headers,
  );
}

/**
 * Validates exact `Origin === expectedOrigin` for state-changing requests that carry
 * non-JSON bodies (e.g. streaming binary uploads) or empty bodies (e.g. DELETE).
 */
export function assertExactAdminOrigin(
  request: Request,
  expectedOrigin: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin || rawOrigin.trim().toLowerCase() === "null") {
    return { ok: false, reason: "Missing or null Origin header on state-changing admin request." };
  }
  try {
    const parsed = new URL(rawOrigin.trim());
    if (
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password ||
      parsed.origin !== expectedOrigin
    ) {
      return {
        ok: false,
        reason: `Origin "${rawOrigin}" does not match expected admin origin "${expectedOrigin}".`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "Malformed Origin header." };
  }
}

export type AuthorizedMediaContextResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly expectedOrigin: string;
      readonly member: AuthorizedTenantMember;
      readonly tenantDb: D1Database;
      readonly nowMs: number;
    }
  | { readonly ok: false; readonly response: Response };

/**
 * Authenticates the caller on `app.punyasitus.com`, enforces CSRF/Origin rules,
 * verifies live `PLATFORM_DB` membership + RBAC + tenant lifecycle write-locks via
 * `resolveAuthorizedTenantMember`, and opens the tenant's isolated `TenantStore` DB.
 */
export async function authorizeMediaApiRequest(
  request: Request,
  tenantHandleParam: string,
  runtimeEnv: MediaApiRuntimeEnv,
  config: {
    readonly requiredPermission: PermissionAction;
    readonly csrfMode: "none" | "json" | "origin_only";
  },
  options: MediaApiHandlerOptions = {},
): Promise<AuthorizedMediaContextResult> {
  const requestId = options.requestId ?? createRequestId();
  const nowMs = options.nowMs ?? Date.now();

  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: createMediaErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // CSRF / Origin enforcement
  if (config.csrfMode === "json") {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: createMediaErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  } else if (config.csrfMode === "origin_only") {
    const originCheck = assertExactAdminOrigin(request, hostCtx.expectedOrigin);
    if (!originCheck.ok) {
      return {
        ok: false,
        response: createMediaErrorResponse(403, "FORBIDDEN", originCheck.reason, requestId),
      };
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: createMediaErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data sedang tidak tersedia.",
        requestId,
        { retryAfterSeconds: 30 },
      ),
    };
  }

  // Resolve authenticated userId via explicit option or live Better Auth session cookie
  let userId = options.authenticatedUserId?.trim() || "";
  if (!userId && options.authenticatedUserId === undefined) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: createMediaErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Konfigurasi autentikasi belum lengkap.",
          requestId,
          { retryAfterSeconds: 30 },
        ),
      };
    }
    const emailPort = resolveAuthEmailPort(runtimeEnv);
    const auth = createAuth(runtimeEnv.PLATFORM_DB, {
      baseURL: hostCtx.baseURL,
      secret,
      surface: "app",
      trustedOrigins: [hostCtx.expectedOrigin],
      emailPort,
    });
    const sessionRes = await auth.api.getSession({ headers: request.headers });
    userId = sessionRes?.user?.id?.trim() ?? "";
  }

  if (!userId) {
    return {
      ok: false,
      response: createMediaErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Sesi Anda telah berakhir. Silakan masuk kembali.",
        requestId,
      ),
    };
  }

  const handle = tenantHandleParam.trim().toLowerCase();
  if (!handle) {
    return {
      ok: false,
      response: createMediaErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      handle,
      requiredPermission: config.requiredPermission,
      surface: "app",
      nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        response: createMediaErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: createMediaErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        { retryAfterSeconds: 30 },
      ),
    };
  }

  let tenantDb: D1Database;
  if (options.resolveTenantDb) {
    tenantDb = options.resolveTenantDb(member.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
  } else {
    return {
      ok: false,
      response: createMediaErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan tenant sementara tidak tersedia.",
        requestId,
        { retryAfterSeconds: 30 },
      ),
    };
  }

  return {
    ok: true,
    requestId,
    expectedOrigin: hostCtx.expectedOrigin,
    member,
    tenantDb,
    nowMs,
  };
}

export function detectForbiddenTenantSelectors(
  body: Record<string, unknown>,
): readonly MediaApiErrorField[] {
  const fields: MediaApiErrorField[] = [];
  for (const key of FORBIDDEN_TENANT_SELECTOR_KEYS) {
    if (key in body) {
      fields.push({
        field: key,
        code: "FORBIDDEN_FIELD",
        message: `Field "${key}" is forbidden in tenant-scoped requests.`,
      });
    }
  }
  return fields;
}

export function buildPublicMediaUrl(
  media: MediaItemRecord,
  runtimeEnv: Pick<MediaApiRuntimeEnv, "PLATFORM_DOMAIN" | "MEDIA_PUBLIC_BASE_URL">,
): string | null {
  // Never emit a public URL for quarantined, processing, failed, or trashed items (zero public original fallback!)
  if (media.status !== "ready" || media.dbStatus !== "ready" || media.deletedAt !== null) {
    return null;
  }
  if (!media.r2Key.includes("/media/") || media.r2Key.includes("/quarantine/")) {
    return null;
  }
  const base =
    runtimeEnv.MEDIA_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ||
    `https://media.${(runtimeEnv.PLATFORM_DOMAIN ?? "punyasitus.com").trim().toLowerCase()}`;
  return `${base}/${media.r2Key}`;
}

export function serializeMediaItemRecord(
  media: MediaItemRecord,
  runtimeEnv: Pick<MediaApiRuntimeEnv, "PLATFORM_DOMAIN" | "MEDIA_PUBLIC_BASE_URL">,
): Record<string, unknown> {
  return {
    id: media.id,
    kind: media.kind,
    status: media.status,
    alt: media.altText,
    normalizedBytes: media.bytes,
    width: media.width,
    height: media.height,
    publicUrl: buildPublicMediaUrl(media, runtimeEnv),
    version: media.version,
    createdAt: new Date(media.createdAt).toISOString(),
  };
}

export function parsePositiveIntParam(raw: string | undefined): number | null {
  if (!raw || !/^[1-9][0-9]*$/.test(raw.trim())) return null;
  const num = Number(raw.trim());
  if (!Number.isSafeInteger(num) || num < 1 || num > 2_147_483_647) return null;
  return num;
}

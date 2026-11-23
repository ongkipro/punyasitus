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
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  buildLeadWhatsAppFollowUpUrl,
  LeadNotFoundError,
  LeadStaleVersionError,
  LeadStorageError,
  LeadValidationError,
  type LeadRecord,
} from "@punyasitus/db/leads/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared auth, RBAC, host-isolation, CSRF, JSON parsing, and response helpers for
 * `/api/tenants/:tenantId/leads/**` (TASK-021, REQ-031, REQ-032, REQ-038, REQ-039, REQ-060).
 */

export const MAX_LEAD_ADMIN_BODY_BYTES = 16_384 as const;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const HANDLE_SELECTOR_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TENANT_SELECTOR_KEYS);

export const PRIVATE_NO_STORE_JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  Vary: "Cookie",
} as const;

export interface TenantLeadsRuntimeEnv extends AuthRuntimeEnv {
  readonly SAAS_ZONE?: string;
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantLeadsHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

export interface AuthorizedLeadRequestContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
  readonly primaryOrigin: string;
}

export function createRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function leadJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(PRIVATE_NO_STORE_JSON_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function leadErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return leadJsonResponse(
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

export function formatLeadRecordResponse(
  lead: LeadRecord,
  primaryOrigin: string,
): Record<string, unknown> {
  return {
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    message: lead.message,
    status: lead.status,
    preferredDate: lead.preferredDate,
    preferredTime: lead.preferredTime,
    branchId: lead.branchId,
    sourceCategory: lead.sourceCategory,
    utm: lead.utm,
    pagePath: lead.pagePath,
    internalNotes: lead.internalNotes,
    version: lead.version,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
    whatsappFollowUpUrl: buildLeadWhatsAppFollowUpUrl({
      phone: lead.phone,
      leadName: lead.name,
      primaryOrigin,
      pagePath: lead.pagePath,
    }),
  };
}

export function buildLeadsRuntimeEnv(): TenantLeadsRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly SAAS_ZONE?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    SAAS_ZONE: runtimeEnv.SAAS_ZONE,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
  };
}

async function resolveTenantPrimaryOrigin(
  platformDb: D1Database,
  tenantId: string,
  handle: string,
  saasZone: string,
): Promise<string> {
  try {
    const row = await platformDb
      .prepare(
        `SELECT host
         FROM tenant_hosts
         WHERE tenant_id = ?
           AND is_primary = 1
           AND status = 'active'
           AND ssl_status = 'active'
         LIMIT 1`,
      )
      .bind(tenantId)
      .first<{ readonly host: string }>();
    if (row?.host && row.host.trim().length > 0) {
      return `https://${row.host.trim().toLowerCase()}`;
    }
  } catch {
    // Fall back to canonical subdomain host
  }
  return `https://${handle}.${saasZone}`;
}

/**
 * Authorizes a tenant-scoped Lead Inbox API request:
 * 1. Platform `app` host only (`404` on tenant/marketing/console).
 * 2. CSRF & Origin check on state-changing methods.
 * 3. Session verification + lifetime ceiling (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership + RBAC + entitlement status check (`404` cross-tenant/non-member,
 *    `403` role denial or `SUBSCRIPTION_LOCKED` on blocked mutations).
 * 5. Opens verified tenant's physically isolated `TenantStore`.
 */
export async function authorizeTenantLeadRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantLeadsRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantLeadsHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedLeadRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createRequestId();

  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: leadErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: leadErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: leadErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: leadErrorResponse(
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
      response: leadErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Autentikasi diperlukan untuk mengakses pesan masuk tenant.",
        requestId,
      ),
    };
  }

  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: leadErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  const isHandleSelector = HANDLE_SELECTOR_PATTERN.test(trimmedSelector);
  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      ...(isHandleSelector ? { handle: trimmedSelector } : { tenantId: trimmedSelector }),
      requiredPermission,
      surface: "app",
      claimedOrganizationId: activeOrganizationId,
      nowMs: options.nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        response: leadErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: leadErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  let tenantDb: D1Database | null = null;
  if (options.resolveTenantDb) {
    tenantDb = await options.resolveTenantDb(member.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
  }

  if (!tenantDb) {
    return {
      ok: false,
      response: leadErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan data tenant sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  const saasZone = runtimeEnv.SAAS_ZONE?.trim() || "situsku.click";
  const primaryOrigin = await resolveTenantPrimaryOrigin(
    runtimeEnv.PLATFORM_DB,
    member.tenantId,
    member.handle,
    saasZone,
  );

  return {
    ok: true,
    ctx: { requestId, member, platformDb: runtimeEnv.PLATFORM_DB, tenantDb, primaryOrigin },
  };
}

export function parseLeadIdParam(
  rawLeadId: string,
  requestId: string,
): { readonly ok: true; readonly leadId: number } | { readonly ok: false; readonly response: Response } {
  const trimmed = rawLeadId.trim();
  if (!/^[1-9]\d{0,9}$/.test(trimmed)) {
    return {
      ok: false,
      response: leadErrorResponse(
        422,
        "VALIDATION_ERROR",
        "ID pesan masuk harus berupa bilangan bulat positif.",
        requestId,
        [{ field: "leadId", code: "INVALID_LEAD_ID", message: "Expected positive integer lead ID." }],
      ),
    };
  }
  const leadId = Number(trimmed);
  if (!Number.isSafeInteger(leadId) || leadId < 1 || leadId > 2_147_483_647) {
    return {
      ok: false,
      response: leadErrorResponse(
        422,
        "VALIDATION_ERROR",
        "ID pesan masuk di luar rentang yang diizinkan.",
        requestId,
        [{ field: "leadId", code: "INVALID_LEAD_ID", message: "Lead ID out of range." }],
      ),
    };
  }
  return { ok: true, leadId };
}

export async function parseStrictLeadJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_LEAD_ADMIN_BODY_BYTES) {
    return {
      ok: false,
      response: leadErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_LEAD_ADMIN_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (!rawText) {
    return {
      ok: false,
      response: leadErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json") && !contentType.includes("+json")) {
    return {
      ok: false,
      response: leadErrorResponse(
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
      response: leadErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: leadErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
        [{ field: "body", code: "INVALID_PAYLOAD", message: "Expected JSON object." }],
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_TENANT_KEY_SET.has(key)) {
      return {
        ok: false,
        response: leadErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field "${key}" tidak diizinkan dalam body permintaan tenant.`,
          requestId,
          [
            {
              field: key,
              code: "FORBIDDEN_TENANT_SELECTOR",
              message: `Tenant selector "${key}" is forbidden.`,
            },
          ],
        ),
      };
    }
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        response: leadErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field tidak dikenal "${key}".`,
          requestId,
          [{ field: key, code: "UNKNOWN_FIELD", message: `Unknown field "${key}".` }],
        ),
      };
    }
  }

  return { ok: true, body: record };
}

export function mapLeadDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof LeadValidationError) {
    return leadErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof LeadNotFoundError) {
    return leadErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof LeadStaleVersionError) {
    return leadErrorResponse(409, "STALE_VERSION", err.message, requestId, [
      { field: "version", code: "STALE_VERSION", message: err.message },
    ]);
  }
  if (err instanceof AuthorizationError) {
    return leadErrorResponse(err.status, err.code, err.message, requestId);
  }
  if (err instanceof LeadStorageError) {
    return leadErrorResponse(503, "SERVICE_UNAVAILABLE", err.message, requestId, undefined, {
      "Retry-After": "60",
    });
  }
  return leadErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Gagal memproses operasi pesan masuk.",
    requestId,
    undefined,
    { "Retry-After": "60" },
  );
}

import { env } from "cloudflare:workers";
import {
  assertAdminCsrfAndOrigin,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
} from "@punyasitus/auth";
import {
  submitMcpConsentDecision,
  verifyLiveMcpMemberAndEntitlement,
} from "@punyasitus/auth/mcp/index";
import {
  McpPublishApprovalActionSchema,
  McpRevokeGrantSchema,
  type FetchCimdOptions,
} from "@punyasitus/core/mcp/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  executeHumanPublishApproval,
  getMcpGrantById,
  getMcpPublishApprovalByToken,
  listUserMcpGrants,
  revokeMcpGrantById,
} from "@punyasitus/db/mcp/index";
import { generatePlatformAuditId } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../middleware/auth.ts";

/**
 * Cookie-authenticated + CSRF/Origin-protected JSON endpoints for human MCP management
 * under `/api/auth/mcp/{action}` (REQ-076, ADR-0008, PLAN §18.3, TASK-075):
 *
 * - `POST /api/auth/mcp/consent`          -> Approve or deny OAuth 2.1 consent (Owner/Admin only)
 * - `GET  /api/auth/mcp/grants`           -> List signed-in user's connected AI apps
 * - `POST /api/auth/mcp/revoke`           -> Immediately revoke a grant + all its tokens
 * - `POST /api/auth/mcp/publish-approval` -> Human browser confirmation/rejection of a draft publish link
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface McpAccountApiRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface McpAccountApiOptions extends FetchCimdOptions {
  readonly openTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
  readonly nowMs?: number;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

async function parseJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export async function handleMcpAccountApiRequest(
  action: string,
  request: Request,
  runtimeEnv: McpAccountApiRuntimeEnv,
  options: McpAccountApiOptions = {},
): Promise<Response> {
  // Strictly admin (`app`) host ONLY
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return jsonResponse(404, { success: false, code: "NOT_FOUND" });
  }

  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return jsonResponse(csrf.status, {
        success: false,
        code: csrf.code,
        message: csrf.reason,
      });
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return jsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan aplikasi AI sedang tidak tersedia.",
    });
  }

  const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
  if (!secret) {
    return jsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Konfigurasi autentikasi belum lengkap.",
    });
  }

  const auth = createAuth(runtimeEnv.PLATFORM_DB, {
    baseURL: hostCtx.baseURL,
    secret,
    surface: "app",
    trustedOrigins: [hostCtx.expectedOrigin],
    emailPort: resolveAuthEmailPort(runtimeEnv),
  });

  const sessionResult = await auth.api.getSession({ headers: request.headers });
  if (!sessionResult?.user || !sessionResult.session) {
    return jsonResponse(401, {
      success: false,
      code: "UNAUTHENTICATED",
      message: "Sesi Anda telah berakhir. Silakan masuk kembali.",
    });
  }

  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const requestPathname = (() => {
    try {
      return new URL(request.url).pathname.toLowerCase();
    } catch {
      return "/api/auth/mcp";
    }
  })();

  // Enforce DEC-045 session idle & absolute lifetime ceiling
  const lifetimeCheck = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
    sessionId: sessionResult.session.id,
    userId: sessionResult.user.id,
    surface: "app",
    pathname: requestPathname,
    nowMs,
  });
  if (!lifetimeCheck.valid) {
    return jsonResponse(401, {
      success: false,
      code: "UNAUTHENTICATED",
      message: "Sesi Anda telah melampaui batas waktu aktif. Silakan masuk kembali.",
    });
  }

  const user = sessionResult.user;
  const requestId =
    request.headers.get("x-request-id")?.trim() || `mcpui_${generatePlatformAuditId(nowMs)}`;

  // 1. POST /api/auth/mcp/consent
  if (action === "consent" && method === "POST") {
    const body = await parseJsonObject(request);
    if (!body) {
      return jsonResponse(400, {
        success: false,
        code: "BAD_REQUEST",
        message: "Body JSON persetujuan tidak valid.",
      });
    }

    const result = await submitMcpConsentDecision(runtimeEnv.PLATFORM_DB, {
      userId: user.id,
      rawBody: body,
      adminOrigin: hostCtx.expectedOrigin,
      requestId,
      nowMs,
      fetchFn: options.fetchFn,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
    });

    if (!result.ok) {
      return jsonResponse(result.status, {
        success: false,
        code: result.code,
        message: result.message,
      });
    }

    return jsonResponse(200, {
      success: true,
      decision: result.decision,
      redirectTo: result.redirectTo,
      ...(result.grantId ? { grantId: result.grantId } : {}),
    });
  }

  // 2. GET /api/auth/mcp/grants
  if (action === "grants" && method === "GET") {
    const url = new URL(request.url);
    const includeRevoked = url.searchParams.get("includeRevoked") === "1";
    const grants = await listUserMcpGrants(runtimeEnv.PLATFORM_DB, user.id, {
      includeRevoked,
      includeOwnedTenantGrants: true,
    });
    return jsonResponse(200, {
      success: true,
      grants: grants.map((g) => ({
        id: g.id,
        clientId: g.clientId,
        clientName: g.clientName,
        clientUri: g.clientUri,
        tenantId: g.tenantId,
        tenantHandle: g.tenantHandle,
        tenantName: g.tenantName,
        resource: g.resource,
        scopes: g.scopes,
        piiConsentAcked: g.piiConsentAcked,
        status: g.status,
        revokedAt: g.revokedAt ? new Date(g.revokedAt).toISOString() : null,
        revokedReason: g.revokedReason,
        lastUsedAt: g.lastUsedAt ? new Date(g.lastUsedAt).toISOString() : null,
        createdAt: new Date(g.createdAt).toISOString(),
      })),
    });
  }

  // 3. POST /api/auth/mcp/revoke
  // Authorized if caller is the grant's own user OR a live `owner` of the grant's tenant.
  if (action === "revoke" && method === "POST") {
    const body = await parseJsonObject(request);
    const parsed = McpRevokeGrantSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: "ID akses aplikasi AI wajib diisi.",
      });
    }

    const existingGrant = await getMcpGrantById(runtimeEnv.PLATFORM_DB, parsed.data.grantId);
    if (!existingGrant) {
      return jsonResponse(404, {
        success: false,
        code: "NOT_FOUND",
        message: "Akses aplikasi AI tidak ditemukan pada akun Anda.",
      });
    }

    const isSelf = existingGrant.userId === user.id;
    let isTenantOwner = false;
    if (!isSelf) {
      try {
        const member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
          userId: user.id,
          tenantId: existingGrant.tenantId,
          surface: "app",
          nowMs,
        });
        isTenantOwner = member.dbRole === "owner";
      } catch {
        isTenantOwner = false;
      }
    }

    if (!isSelf && !isTenantOwner) {
      return jsonResponse(404, {
        success: false,
        code: "NOT_FOUND",
        message: "Akses aplikasi AI tidak ditemukan pada akun Anda.",
      });
    }

    const res = await revokeMcpGrantById(runtimeEnv.PLATFORM_DB, {
      grantId: parsed.data.grantId,
      actorUserId: user.id,
      reason:
        parsed.data.reason?.trim() ||
        (isTenantOwner && !isSelf
          ? "tenant_owner_revoked_member_grant"
          : "user_revoked_from_connected_apps"),
      actorRole: isTenantOwner ? "owner" : "tenant_member",
      requestId,
      nowMs,
    });

    if (!res.revoked) {
      return jsonResponse(404, {
        success: false,
        code: "NOT_FOUND",
        message: "Akses aplikasi AI tidak ditemukan pada akun Anda.",
      });
    }

    return jsonResponse(200, {
      success: true,
      revoked: true,
      grantId: parsed.data.grantId,
    });
  }

  // 4. POST /api/auth/mcp/publish-approval
  if (action === "publish-approval" && method === "POST") {
    const body = await parseJsonObject(request);
    const parsed = McpPublishApprovalActionSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: "Token persetujuan publikasi dan keputusan wajib diisi.",
      });
    }

    const approval = await getMcpPublishApprovalByToken(runtimeEnv.PLATFORM_DB, parsed.data.token);
    if (!approval) {
      return jsonResponse(404, {
        success: false,
        code: "APPROVAL_NOT_FOUND",
        message: "Tautan persetujuan publikasi tidak ditemukan.",
      });
    }

    // Live Owner/Admin membership + entitlement verification on the approval's tenant
    const live = await verifyLiveMcpMemberAndEntitlement(runtimeEnv.PLATFORM_DB, {
      userId: user.id,
      tenantId: approval.tenantId,
      nowMs,
    });
    if (!live.ok) {
      return jsonResponse(403, {
        success: false,
        code: live.code,
        message: live.message,
      });
    }

    const openTenantDb =
      options.openTenantDb ??
      ((tenantId: string): D1Database => {
        if (!runtimeEnv.TENANT_STORE) {
          throw new Error("TENANT_STORE binding tidak tersedia.");
        }
        return createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, tenantId));
      });

    const tenantDb = await openTenantDb(approval.tenantId);
    const outcome = await executeHumanPublishApproval(runtimeEnv.PLATFORM_DB, tenantDb, {
      rawToken: parsed.data.token,
      actorUserId: user.id,
      actorRole: live.member.dbRole as "owner" | "admin",
      decision: parsed.data.decision,
      requestId,
      nowMs,
    });

    if (!outcome.ok) {
      return jsonResponse(outcome.status, {
        success: false,
        code: outcome.code,
        message: outcome.message,
      });
    }

    return jsonResponse(200, {
      success: true,
      ...outcome,
    });
  }

  return jsonResponse(404, { success: false, code: "NOT_FOUND" });
}

export const ALL: APIRoute = ({ params, request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return handleMcpAccountApiRequest(params.action ?? "", request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
  });
};

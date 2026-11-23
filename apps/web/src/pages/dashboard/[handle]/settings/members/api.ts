import { env } from "cloudflare:workers";
import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  resolveExpectedAdminOrigin,
} from "@punyasitus/auth";
import {
  assertTenantOwnerBillingAccess,
  createMemberInvitation,
  InvitationError,
  listTenantMembersAndInvitations,
  removeTenantMember,
  revokeMemberInvitation,
  transferTenantOwnership,
  updateTenantMemberRole,
} from "@punyasitus/auth/invitations/index";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import type { APIRoute } from "astro";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Tenant Member Management, 5-Member Cap Invitations, Final-Owner Protection &
 * Atomic Owner Transfer endpoint under `/dashboard/[handle]/settings/members/api`
 * (TASK-026, REQ-035, REQ-034, REQ-065; PLAN §4 & §11.2).
 *
 * Actions (`POST` JSON `{ action, ... }`):
 * - `invite`              -> Owner invites admin/editor (48h expiry, atomic 5-seat cap)
 * - `revoke-invitation`   -> Owner revokes pending invitation
 * - `update-role`         -> Owner updates member role (protects final owner)
 * - `remove-member`       -> Owner removes member (protects final owner)
 * - `transfer-owner`      -> Owner transfers ownership atomically (REQUIRES reauth + handle confirm)
 * - `accept-invitation`   -> Authenticated user accepts identity-bound single-use invite token
 * - `billing-access-check`-> Verifies live owner-only billing access for current user
 */

export interface MembersApiHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function jsonResponse(status: number, body: Readonly<Record<string, unknown>>): Response {
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

export async function handleMembersApiRequest(
  rawHandle: string,
  request: Request,
  runtimeEnv: AuthRuntimeEnv,
  options: MembersApiHandlerOptions = {},
): Promise<Response> {
  const handle = rawHandle.trim().toLowerCase();
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || (!hostCtx.isLocalLoopback && hostCtx.surface !== "app")) {
    return jsonResponse(404, { success: false, code: "NOT_FOUND" });
  }

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return jsonResponse(405, {
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Metode HTTP tidak diizinkan.",
    });
  }

  if (STATE_CHANGING_METHODS.has(method)) {
    const expectedOrigin =
      resolveExpectedAdminOrigin(request, {
        surface: hostCtx.isLocalLoopback ? "app" : hostCtx.surface,
        platformDomain: runtimeEnv.PLATFORM_DOMAIN,
        isLocalLoopback: hostCtx.isLocalLoopback,
      }) ?? hostCtx.expectedOrigin;
    const csrf = assertAdminCsrfAndOrigin(request, expectedOrigin);
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
      message: "Layanan keanggotaan sedang tidak tersedia.",
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

  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const requestId =
    request.headers.get("x-request-id")?.trim() ||
    `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  const emailPort = resolveAuthEmailPort(runtimeEnv, options.emailPort);
  const auth = createAuth(runtimeEnv.PLATFORM_DB, {
    baseURL: hostCtx.baseURL,
    secret,
    surface: "app",
    trustedOrigins: [hostCtx.expectedOrigin],
    emailPort,
  });

  const sessionResult = await auth.api.getSession({ headers: request.headers });
  if (!sessionResult?.user || !sessionResult.session) {
    return jsonResponse(401, {
      success: false,
      code: "UNAUTHENTICATED",
      message: "Sesi Anda telah berakhir. Silakan masuk kembali.",
    });
  }

  const lifetimeCheck = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
    sessionId: sessionResult.session.id,
    userId: sessionResult.user.id,
    surface: "app",
    pathname: new URL(request.url).pathname,
    nowMs,
  });
  if (!lifetimeCheck.valid) {
    return jsonResponse(401, {
      success: false,
      code: "SESSION_EXPIRED",
      message: "Sesi Anda telah kedaluwarsa. Silakan masuk kembali.",
    });
  }

  const user = sessionResult.user;
  const session = sessionResult.session;

  try {
    if (method === "GET") {
      const authorized = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
        userId: user.id,
        handle,
        surface: "app",
        nowMs,
      });
      const snapshot = await listTenantMembersAndInvitations(runtimeEnv.PLATFORM_DB, {
        tenantId: authorized.tenantId,
        nowMs,
      });
      const canManageMembers =
        authorized.role === "owner" || authorized.role === "agency_admin";
      const canAccessBilling =
        !snapshot.agencyManaged && authorized.role === "owner";

      return jsonResponse(200, {
        success: true,
        currentUserId: user.id,
        currentRole: authorized.role,
        currentDbRole: authorized.dbRole,
        tenantStatus: authorized.tenantStatus,
        canManageMembers,
        canAccessBilling,
        ...snapshot,
      });
    }

    const body = await parseJsonObject(request);
    if (!body || typeof body.action !== "string") {
      return jsonResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: "Field action wajib diisi.",
      });
    }

    if (body.action === "billing-access-check") {
      const billing = await assertTenantOwnerBillingAccess(runtimeEnv.PLATFORM_DB, {
        userId: user.id,
        handle,
        action: "billing:read",
        nowMs,
      });
      return jsonResponse(200, {
        success: true,
        allowed: true,
        tenantId: billing.tenantId,
        role: billing.role,
      });
    }

    if (body.action === "invite") {
      const authorized = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
        userId: user.id,
        handle,
        requiredPermission: "member:invite",
        surface: "app",
        nowMs,
      });

      if (typeof body.email !== "string" || (body.role !== "admin" && body.role !== "editor")) {
        return jsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: 'Email dan peran ("admin" atau "editor") wajib diisi.',
        });
      }

      const created = await createMemberInvitation(runtimeEnv.PLATFORM_DB, {
        organizationId: authorized.organizationId,
        tenantId: authorized.tenantId,
        tenantName: authorized.tenantName,
        handle: authorized.handle,
        inviterUserId: user.id,
        inviterName: user.name,
        email: body.email,
        role: body.role,
        emailPort,
        baseURL: hostCtx.baseURL,
        requestId,
        nowMs,
      });

      return jsonResponse(201, {
        success: true,
        invitation: created.invitation,
        expiresInSeconds: created.expiresInSeconds,
        emailDispatched: created.emailDispatched,
      });
    }

    if (body.action === "revoke-invitation") {
      const authorized = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
        userId: user.id,
        handle,
        requiredPermission: "member:invite",
        surface: "app",
        nowMs,
      });
      if (typeof body.invitationId !== "string" || !body.invitationId.trim()) {
        return jsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: "invitationId wajib diisi.",
        });
      }
      const revoked = await revokeMemberInvitation(runtimeEnv.PLATFORM_DB, {
        organizationId: authorized.organizationId,
        tenantId: authorized.tenantId,
        invitationId: body.invitationId,
        actorUserId: user.id,
        requestId,
        nowMs,
      });
      return jsonResponse(200, { success: true, invitationId: revoked.invitationId });
    }

    if (body.action === "update-role") {
      const authorized = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
        userId: user.id,
        handle,
        requiredPermission: "member:update_role",
        surface: "app",
        nowMs,
      });
      if (
        typeof body.memberId !== "string" ||
        !body.memberId.trim() ||
        (body.role !== "admin" && body.role !== "editor")
      ) {
        return jsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: 'memberId dan peran baru ("admin" atau "editor") wajib diisi.',
        });
      }
      const updated = await updateTenantMemberRole(runtimeEnv.PLATFORM_DB, {
        organizationId: authorized.organizationId,
        tenantId: authorized.tenantId,
        actorUserId: user.id,
        targetMemberId: body.memberId,
        newRole: body.role,
        requestId,
        nowMs,
      });
      return jsonResponse(200, {
        success: true,
        memberId: updated.memberId,
        role: updated.role,
      });
    }

    if (body.action === "remove-member") {
      const authorized = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
        userId: user.id,
        handle,
        requiredPermission: "member:remove",
        surface: "app",
        nowMs,
      });
      if (typeof body.memberId !== "string" || !body.memberId.trim()) {
        return jsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: "memberId wajib diisi.",
        });
      }
      const removed = await removeTenantMember(runtimeEnv.PLATFORM_DB, {
        organizationId: authorized.organizationId,
        tenantId: authorized.tenantId,
        actorUserId: user.id,
        targetMemberId: body.memberId,
        requestId,
        nowMs,
      });
      return jsonResponse(200, {
        success: true,
        removedMemberId: removed.removedMemberId,
      });
    }

    if (body.action === "transfer-owner") {
      // Note: pass `reauthenticated: true` to RBAC check here ONLY because `transferTenantOwnership`
      // strictly verifies password / recent 2FA / reauthenticatedAtMs right below and rejects with 403 REAUTH_REQUIRED.
      const authorized = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
        userId: user.id,
        handle,
        requiredPermission: "tenant:transfer_owner",
        reauthenticated: true,
        surface: "app",
        nowMs,
      });
      if (typeof body.targetMemberId !== "string" || !body.targetMemberId.trim()) {
        return jsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: "Pilih anggota aktif tujuan untuk alih kepemilikan.",
        });
      }
      if (
        typeof body.confirmTenantHandle !== "string" ||
        body.confirmTenantHandle.trim().toLowerCase() !== authorized.handle
      ) {
        return jsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: `Ketik handle situs "${authorized.handle}" untuk mengonfirmasi alih kepemilikan.`,
        });
      }

      const transferred = await transferTenantOwnership(runtimeEnv.PLATFORM_DB, {
        organizationId: authorized.organizationId,
        tenantId: authorized.tenantId,
        tenantHandle: authorized.handle,
        confirmTenantHandle: body.confirmTenantHandle,
        actorUserId: user.id,
        actorSessionId: session.id,
        targetMemberId: body.targetMemberId,
        currentPassword:
          typeof body.currentPassword === "string" ? body.currentPassword : undefined,
        requestId,
        nowMs,
      });

      return jsonResponse(200, {
        success: true,
        previousOwnerUserId: transferred.previousOwnerUserId,
        newOwnerUserId: transferred.newOwnerUserId,
        newOwnerMemberId: transferred.newOwnerMemberId,
        reauthMethod: transferred.reauthMethod,
      });
    }

    return jsonResponse(422, {
      success: false,
      code: "VALIDATION_ERROR",
      message: `Aksi "${body.action}" tidak dikenali.`,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return jsonResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    if (err instanceof InvitationError) {
      return jsonResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    return jsonResponse(500, {
      success: false,
      code: "INTERNAL_ERROR",
      message: "Terjadi kesalahan saat memproses permintaan keanggotaan.",
    });
  }
}

export const GET: APIRoute = ({ params, request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return handleMembersApiRequest(params.handle ?? "", request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  });
};

export const POST: APIRoute = ({ params, request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return handleMembersApiRequest(params.handle ?? "", request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  });
};

import { env } from "cloudflare:workers";
import { validateSetupStaffAccessActionInput } from "@punyasitus/core/custom-themes/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  approveSetupServiceStaffAccess,
  revokeSetupServiceStaffAccess,
} from "@punyasitus/db/custom-themes/index";
import { getPlatformSettings } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import {
  authorizeTenantServiceRequest,
  createServiceRequestId,
  formatTenantSeatsDto,
  formatTenantSetupRequestDto,
  mapTenantServiceRequestErrorToResponse,
  parseStrictServiceRequestJsonBody,
  serviceRequestErrorResponse,
  serviceRequestJsonResponse,
  type TenantServiceRequestHandlerOptions,
  type TenantServiceRequestRuntimeEnv,
} from "../_shared.ts";

/**
 * `POST /api/tenants/:tenantId/service-requests/:requestId/staff-access`
 *
 * Strictly **Owner-only** (`role === "owner"` && `dbRole === "owner"`; `agency_admin`,
 * `admin`, `editor`, and `setup_staff` are denied with `403 FORBIDDEN`) endpoint to
 * approve or revoke a named platform staff account's temporary `setup_staff`
 * (canonical `editor`) membership for Terima Beres delivery.
 *
 * Security & Concurrency Invariants (REQ-070, REQ-035, REQ-065, PLAN §18.2, TASK-069):
 * - Approval requires `status === "in_progress"` and non-locked tenant lifecycle status.
 * - Revocation is allowed for strict `owner` even when tenant status is `locked` or
 *   `suspended`, so an owner can always revoke temporary staff access cleanly.
 * - Enforces atomic 5-member seat cap (`active members + unexpired pending invitations < 5`).
 * - If 5/5 seats are occupied, records `staff_access_state = 'waiting_seat'` with clear
 *   Bahasa Indonesia explanation and audit entry instead of bypassing the cap.
 * - `revoke` is idempotent and deletes ONLY the exact `staff_member_id` row with `role = 'setup_staff'`.
 * - Every mutation requires `expectedVersion` (OCC) and commits `platform_audit` atomically.
 */

export async function handleTenantSetupStaffAccessRequest(
  tenantId: string,
  targetRequestId: string,
  request: Request,
  runtimeEnv: TenantServiceRequestRuntimeEnv,
  options: TenantServiceRequestHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createServiceRequestId();

  // Step 1: Verify host isolation, CSRF/Origin, session, and live tenant membership first
  // (allow locked/suspended through initial auth so strict owner `revoke` can succeed cleanly;
  // `approve` explicitly enforces non-locked status right below!).
  const auth = await authorizeTenantServiceRequest(tenantId, request, runtimeEnv, {
    ...options,
    requestId,
    requiredPermission: null,
    allowLockedOrSuspended: true,
  });
  if (!auth.ok) return auth.response;

  // Strictly Owner ONLY (`role === "owner"` && `dbRole === "owner"`):
  // denies `agency_admin`, `admin`, `editor`, and `setup_staff` with `403 FORBIDDEN`!
  if (auth.ctx.member.role !== "owner" || auth.ctx.member.dbRole !== "owner") {
    return serviceRequestErrorResponse(
      403,
      "FORBIDDEN",
      "Hanya Pemilik Situs (Owner) yang dapat menyetujui atau mencabut akses sementara Tim Setup.",
      auth.ctx.requestId,
    );
  }

  if (method !== "POST") {
    return serviceRequestErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Metode HTTP tidak diizinkan untuk persetujuan akses Tim Setup. Gunakan POST.",
      auth.ctx.requestId,
      { extraHeaders: { Allow: "POST" } },
    );
  }

  const parsed = await parseStrictServiceRequestJsonBody(request, auth.ctx.requestId);
  if (!parsed.ok) return parsed.response;

  try {
    const validated = validateSetupStaffAccessActionInput(parsed.body);
    const settings = await getPlatformSettings(auth.ctx.platformDb);
    const salesWhatsapp = settings.salesWhatsapp || null;

    if (validated.action === "approve") {
      if (
        auth.ctx.member.tenantStatus === "locked" ||
        auth.ctx.member.tenantStatus === "suspended" ||
        auth.ctx.member.tenantStatus === "recovery"
      ) {
        return serviceRequestErrorResponse(
          403,
          "SUBSCRIPTION_LOCKED",
          "Persetujuan akses Tim Setup tidak tersedia saat situs dalam status terkunci atau ditangguhkan.",
          auth.ctx.requestId,
        );
      }

      const result = await approveSetupServiceStaffAccess(auth.ctx.platformDb, {
        tenantId: auth.ctx.member.tenantId,
        requestId: targetRequestId,
        expectedVersion: validated.expectedVersion,
        actorUserId: auth.ctx.member.userId,
        actorRole: auth.ctx.member.role,
        reason: validated.reason,
        httpRequestId: auth.ctx.requestId,
        nowMs: auth.ctx.nowMs,
      });

      return serviceRequestJsonResponse(200, {
        success: true,
        action: "approve",
        joined: result.joined,
        alreadyActive: result.alreadyActive,
        waitingForSeat: result.waitingForSeat,
        waitReason: result.waitReason,
        request: formatTenantSetupRequestDto(result.request, salesWhatsapp),
        seats: formatTenantSeatsDto(result.seats),
        auditId: result.audit?.id ?? null,
        requestId: auth.ctx.requestId,
      });
    }

    // `action === "revoke"`: permitted for strict `owner` even when tenant is `locked`/`suspended`!
    const result = await revokeSetupServiceStaffAccess(auth.ctx.platformDb, {
      tenantId: auth.ctx.member.tenantId,
      requestId: targetRequestId,
      expectedVersion: validated.expectedVersion,
      actorUserId: auth.ctx.member.userId,
      actorRole: auth.ctx.member.role,
      reason: validated.reason,
      httpRequestId: auth.ctx.requestId,
      nowMs: auth.ctx.nowMs,
    });

    return serviceRequestJsonResponse(200, {
      success: true,
      action: "revoke",
      removed: result.removed,
      alreadyRevoked: result.alreadyRevoked,
      request: formatTenantSetupRequestDto(result.request, salesWhatsapp),
      seats: formatTenantSeatsDto(result.seats),
      auditId: result.audit?.id ?? null,
      requestId: auth.ctx.requestId,
    });
  } catch (err) {
    return mapTenantServiceRequestErrorToResponse(err, auth.ctx.requestId);
  }
}

function buildRuntimeEnv(): TenantServiceRequestRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantSetupStaffAccessRequest(
    params.tenantId ?? "",
    params.requestId ?? "",
    request,
    buildRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );

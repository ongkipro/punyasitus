import { validateDeletionConfirmationInput } from "@punyasitus/core/exports/index";
import {
  DeletionConflictError,
  getTenantDeletionStatus,
  requestTenantSelfServiceDeletion,
} from "@punyasitus/db/exports/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantOwnerDataRequest,
  buildOwnerDataRuntimeEnv,
  createDataRequestId,
  dataErrorResponse,
  dataJsonResponse,
  inspectOwnerAuthCapabilities,
  parseStrictOwnerDataJsonBody,
  serializeDeletionStatusDto,
  verifyOwnerStepUpForDeletion,
  type TenantOwnerDataHandlerOptions,
  type TenantOwnerDataRuntimeEnv,
} from "../exports/_shared.ts";
import { handleTenantDeletionCancelRequest } from "./cancel.ts";

/**
 * Owner-Only Self-Service Website Deletion Endpoint (REQ-107, PLAN §20.4, TASK-107):
 * - `GET    /api/tenants/:tenantId/deletion` — inspect active/latest deletion state & undo deadline
 * - `POST   /api/tenants/:tenantId/deletion` — schedule deletion (step-up 2FA/reauth + typed handle)
 * - `DELETE /api/tenants/:tenantId/deletion` — cancel active deletion within 7-day undo window
 */

const POST_DELETION_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "confirmHandle",
  "currentPassword",
  "reason",
]);

export async function handleTenantDeletionRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantOwnerDataRuntimeEnv,
  options: TenantOwnerDataHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createDataRequestId();

  if (method === "DELETE") {
    return handleTenantDeletionCancelRequest(tenantId, request, runtimeEnv, {
      ...options,
      requestId,
    });
  }

  const auth = await authorizeTenantOwnerDataRequest(tenantId, request, runtimeEnv, {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  const { member, platformDb, sessionId, sessionCreatedAtMs } = auth.ctx;
  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  if (method === "GET") {
    try {
      const [statusView, capabilities] = await Promise.all([
        getTenantDeletionStatus(platformDb, member.tenantId, nowMs),
        inspectOwnerAuthCapabilities(platformDb, member.userId, sessionId, nowMs),
      ]);
      if (!statusView) {
        return dataErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId);
      }
      return dataJsonResponse(200, {
        deletion: serializeDeletionStatusDto(statusView, capabilities),
        requestId,
      });
    } catch {
      return dataErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memuat status penghapusan situs.",
        requestId,
        undefined,
        { "Retry-After": "30" },
      );
    }
  }

  if (method === "POST") {
    const parsedBody = await parseStrictOwnerDataJsonBody(
      request,
      POST_DELETION_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) return parsedBody.response;

    const confirmCheck = validateDeletionConfirmationInput({
      expectedHandle: member.handle,
      confirmHandle: parsedBody.body.confirmHandle,
      reason: parsedBody.body.reason,
    });
    if (!confirmCheck.ok) {
      return dataErrorResponse(422, "VALIDATION_ERROR", confirmCheck.message, requestId, [
        {
          field: confirmCheck.field,
          code: "INVALID_CONFIRMATION",
          message: confirmCheck.message,
        },
      ]);
    }

    const currentPassword =
      typeof parsedBody.body.currentPassword === "string"
        ? parsedBody.body.currentPassword
        : undefined;

    const stepUp = await verifyOwnerStepUpForDeletion(platformDb, {
      userId: member.userId,
      sessionId,
      sessionCreatedAtMs,
      currentPassword,
      reauthenticatedAtMs: options.reauthenticatedAtMs,
      nowMs,
    });
    if (!stepUp.ok) {
      return dataErrorResponse(403, stepUp.code, stepUp.message, requestId);
    }

    try {
      await requestTenantSelfServiceDeletion(platformDb, {
        tenantId: member.tenantId,
        requestedByUserId: member.userId,
        confirmationMethod: stepUp.method,
        reason: confirmCheck.reason,
        nowMs,
        requestId,
      });

      const updatedView = await getTenantDeletionStatus(platformDb, member.tenantId, nowMs);
      if (!updatedView) {
        return dataErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId);
      }

      return dataJsonResponse(202, {
        deletion: serializeDeletionStatusDto(updatedView),
        requestId,
      });
    } catch (err) {
      if (err instanceof DeletionConflictError) {
        return dataErrorResponse(err.status, err.code, err.message, requestId);
      }
      return dataErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal menjadwalkan penghapusan situs.",
        requestId,
        undefined,
        { "Retry-After": "30" },
      );
    }
  }

  return dataErrorResponse(
    405,
    "BAD_REQUEST",
    "Metode HTTP tidak diizinkan.",
    requestId,
    undefined,
    { Allow: "GET, POST, DELETE" },
  );
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantDeletionRequest(params.tenantId ?? "", request, buildOwnerDataRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    authenticatedSession: locals.authSession
      ? { id: locals.authSession.id, createdAt: locals.authSession.createdAt }
      : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });

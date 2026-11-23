import { MAX_DELETION_REASON_LENGTH } from "@punyasitus/core/exports/index";
import {
  cancelTenantSelfServiceDeletion,
  DeletionConflictError,
  DeletionNotFoundError,
  DeletionWindowExpiredError,
  getTenantDeletionStatus,
} from "@punyasitus/db/exports/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantOwnerDataRequest,
  buildOwnerDataRuntimeEnv,
  createDataRequestId,
  dataErrorResponse,
  dataJsonResponse,
  parseStrictOwnerDataJsonBody,
  serializeDeletionStatusDto,
  type TenantOwnerDataHandlerOptions,
  type TenantOwnerDataRuntimeEnv,
} from "../exports/_shared.ts";

/**
 * Owner-Only Self-Service Deletion Undo Endpoint (REQ-107, PLAN §20.4, TASK-107):
 * - `POST /api/tenants/:tenantId/deletion/cancel` (also reachable via `DELETE /api/tenants/:tenantId/deletion`)
 */

const CANCEL_ALLOWED_KEYS: ReadonlySet<string> = new Set(["reason"]);

export async function handleTenantDeletionCancelRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantOwnerDataRuntimeEnv,
  options: TenantOwnerDataHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createDataRequestId();

  if (method !== "POST" && method !== "DELETE") {
    return dataErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan.",
      requestId,
      undefined,
      { Allow: "POST, DELETE" },
    );
  }

  const auth = await authorizeTenantOwnerDataRequest(tenantId, request, runtimeEnv, {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  const parsedBody = await parseStrictOwnerDataJsonBody(
    request,
    CANCEL_ALLOWED_KEYS,
    requestId,
    { allowEmptyBody: true },
  );
  if (!parsedBody.ok) return parsedBody.response;

  let cancelReason: string | null = null;
  if (parsedBody.body.reason !== undefined && parsedBody.body.reason !== null) {
    if (typeof parsedBody.body.reason !== "string") {
      return dataErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Alasan pembatalan harus berupa teks.",
        requestId,
      );
    }
    const trimmed = parsedBody.body.reason.trim();
    if (trimmed.length > MAX_DELETION_REASON_LENGTH) {
      return dataErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Alasan pembatalan maksimal ${MAX_DELETION_REASON_LENGTH} karakter.`,
        requestId,
      );
    }
    cancelReason = trimmed.length > 0 ? trimmed : null;
  }

  const { member, platformDb } = auth.ctx;
  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  try {
    const result = await cancelTenantSelfServiceDeletion(platformDb, {
      tenantId: member.tenantId,
      canceledByUserId: member.userId,
      cancelReason,
      nowMs,
      requestId,
    });

    const updatedView = await getTenantDeletionStatus(platformDb, member.tenantId, nowMs);
    return dataJsonResponse(200, {
      canceled: true,
      restoredStatus: result.restoredStatus,
      deletion: updatedView ? serializeDeletionStatusDto(updatedView) : null,
      requestId,
    });
  } catch (err) {
    if (err instanceof DeletionNotFoundError) {
      return dataErrorResponse(404, "NOT_FOUND", err.message, requestId);
    }
    if (err instanceof DeletionWindowExpiredError) {
      return dataErrorResponse(409, err.code, err.message, requestId);
    }
    if (err instanceof DeletionConflictError) {
      return dataErrorResponse(err.status, err.code, err.message, requestId);
    }
    return dataErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal membatalkan jadwal penghapusan situs.",
      requestId,
      undefined,
      { "Retry-After": "30" },
    );
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantDeletionCancelRequest(params.tenantId ?? "", request, buildOwnerDataRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    authenticatedSession: locals.authSession
      ? { id: locals.authSession.id, createdAt: locals.authSession.createdAt }
      : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });

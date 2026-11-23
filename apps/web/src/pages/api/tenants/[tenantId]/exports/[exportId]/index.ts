import { getTenantExportJobById } from "@punyasitus/db/exports/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantOwnerDataRequest,
  buildOwnerDataRuntimeEnv,
  createDataRequestId,
  dataErrorResponse,
  dataJsonResponse,
  serializeExportJobDto,
  type TenantOwnerDataHandlerOptions,
  type TenantOwnerDataRuntimeEnv,
} from "../_shared.ts";

/**
 * Owner-Only Single Export Job Inspection Endpoint (REQ-107, TASK-107):
 * - `GET /api/tenants/:tenantId/exports/:exportId`
 */

const EXPORT_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

export async function handleTenantExportDetailRequest(
  tenantId: string,
  exportId: string,
  request: Request,
  runtimeEnv: TenantOwnerDataRuntimeEnv,
  options: TenantOwnerDataHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createDataRequestId();

  const auth = await authorizeTenantOwnerDataRequest(tenantId, request, runtimeEnv, {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  if (method !== "GET") {
    return dataErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const cleanExportId = exportId.trim();
  if (!EXPORT_ID_RE.test(cleanExportId)) {
    return dataErrorResponse(404, "NOT_FOUND", "Arsip ekspor tidak ditemukan.", requestId);
  }

  const { member, platformDb, signingSecret } = auth.ctx;
  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  try {
    const job = await getTenantExportJobById(platformDb, member.tenantId, cleanExportId, nowMs);
    if (!job) {
      return dataErrorResponse(404, "NOT_FOUND", "Arsip ekspor tidak ditemukan.", requestId);
    }

    const dto = await serializeExportJobDto(job, { signingSecret, nowMs });
    return dataJsonResponse(200, { export: dto, requestId });
  } catch {
    return dataErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal memuat detail arsip ekspor situs.",
      requestId,
      undefined,
      { "Retry-After": "30" },
    );
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantExportDetailRequest(
    params.tenantId ?? "",
    params.exportId ?? "",
    request,
    buildOwnerDataRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      authenticatedSession: locals.authSession
        ? { id: locals.authSession.id, createdAt: locals.authSession.createdAt }
        : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );

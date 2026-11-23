import {
  hashExportDownloadToken,
  verifyExportDownloadToken,
} from "@punyasitus/core/exports/index";
import { recordTenantExportDownload } from "@punyasitus/db/exports/index";
import { isTenantScopedR2Key } from "@punyasitus/db/privacy/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantOwnerDataRequest,
  buildOwnerDataRuntimeEnv,
  createDataRequestId,
  dataErrorResponse,
  type TenantOwnerDataHandlerOptions,
  type TenantOwnerDataRuntimeEnv,
} from "../_shared.ts";

/**
 * Owner-Only Signed Ephemeral Export ZIP Download Endpoint (REQ-107, PLAN §20.4, TASK-107):
 * - `GET /api/tenants/:tenantId/exports/:exportId/download?token=...`
 *
 * Security invariants:
 * - Strictly owner-only session bound to verified tenant (`403` for admin/editor/agency non-owner,
 *   `404` for cross-tenant/non-member).
 * - Verifies HMAC-SHA256 signed token bound to `(exportId, tenantId, ownerUserId, expiresAtMs)`
 *   AND verifies SHA-256 hash stored in `tenant_export_jobs.download_token_hash`.
 * - Strictly stops working after 24 hours (`410 EXPORT_EXPIRED`).
 * - Strictly enforces R2 key prefix `t/<tenantId>/exports/` before fetching object.
 */

const EXPORT_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

export async function handleTenantExportDownloadRequest(
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

  let rawToken: string;
  try {
    rawToken = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  } catch {
    rawToken = "";
  }

  if (!rawToken) {
    return dataErrorResponse(
      403,
      "FORBIDDEN",
      "Tautan unduhan tidak valid atau token unduhan tidak ditemukan.",
      requestId,
    );
  }

  const { member, platformDb, signingSecret } = auth.ctx;
  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  const verified = await verifyExportDownloadToken(signingSecret, rawToken, {
    exportId: cleanExportId,
    tenantId: member.tenantId,
    ownerUserId: member.userId,
    nowMs,
  });

  if (!verified.ok) {
    if (verified.reason === "expired") {
      return dataErrorResponse(
        410,
        "EXPORT_EXPIRED",
        "Tautan unduhan arsip ekspor telah kedaluwarsa setelah 24 jam.",
        requestId,
      );
    }
    return dataErrorResponse(
      403,
      "FORBIDDEN",
      "Tautan unduhan arsip ekspor tidak valid atau bukan milik akun ini.",
      requestId,
    );
  }

  const tokenHash = await hashExportDownloadToken(rawToken);
  const record = await recordTenantExportDownload(platformDb, {
    tenantId: member.tenantId,
    exportId: cleanExportId,
    actorUserId: member.userId,
    tokenHash,
    nowMs,
    requestId,
  });

  if (!record.ok) {
    if (record.reason === "not_found") {
      return dataErrorResponse(404, "NOT_FOUND", "Arsip ekspor tidak ditemukan.", requestId);
    }
    if (record.reason === "expired") {
      return dataErrorResponse(
        410,
        "EXPORT_EXPIRED",
        "Tautan unduhan arsip ekspor telah kedaluwarsa setelah 24 jam.",
        requestId,
      );
    }
    if (record.reason === "not_ready") {
      return dataErrorResponse(
        409,
        "EXPORT_NOT_READY",
        "Arsip ekspor belum siap diunduh. Silakan tunggu beberapa saat.",
        requestId,
      );
    }
    return dataErrorResponse(
      403,
      "FORBIDDEN",
      "Token unduhan arsip ekspor tidak cocok.",
      requestId,
    );
  }

  const r2Key = record.job.r2Key;
  if (
    !r2Key ||
    !isTenantScopedR2Key(member.tenantId, r2Key) ||
    !r2Key.startsWith(`t/${member.tenantId}/exports/`)
  ) {
    return dataErrorResponse(
      404,
      "NOT_FOUND",
      "Berkas arsip ekspor tidak ditemukan di penyimpanan.",
      requestId,
    );
  }

  const mediaBucket =
    options.mediaBucket !== undefined ? options.mediaBucket : (runtimeEnv.MEDIA_BUCKET ?? null);
  if (!mediaBucket) {
    return dataErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Layanan penyimpanan arsip sementara tidak tersedia.",
      requestId,
      undefined,
      { "Retry-After": "30" },
    );
  }

  const obj = await mediaBucket.get(r2Key);
  if (!obj) {
    return dataErrorResponse(
      410,
      "EXPORT_EXPIRED",
      "Berkas arsip ekspor sudah tidak tersedia atau telah kedaluwarsa.",
      requestId,
    );
  }

  const safeHandle = member.handle.replace(/[^a-z0-9-]/gi, "") || "situs";
  const safeDay = record.job.requestDay.replace(/[^0-9-]/g, "") || "arsip";

  // Stream R2 object body directly into Response to stay well under 128 MB Worker memory limit.
  const headers: Record<string, string> = {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="punyasitus-${safeHandle}-${safeDay}.zip"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
    Vary: "Cookie",
    ...(record.job.archiveSha256 ? { "X-Archive-SHA256": record.job.archiveSha256 } : {}),
  };

  if (obj.body) {
    const contentLength =
      typeof obj.size === "number" && Number.isFinite(obj.size)
        ? obj.size
        : record.job.archiveBytes;
    if (typeof contentLength === "number" && Number.isFinite(contentLength)) {
      headers["Content-Length"] = String(Math.trunc(contentLength));
    }
    return new Response(obj.body, { status: 200, headers });
  }

  const bytes = await obj.arrayBuffer();
  headers["Content-Length"] = String(bytes.byteLength);
  return new Response(bytes, { status: 200, headers });
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantExportDownloadRequest(
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

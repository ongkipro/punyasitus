import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  affiliateErrorResponse,
  affiliateJsonResponse,
  authorizeAffiliateRequest,
  loadOwnedAffiliatePayoutBatchDetail,
  mapAffiliatePortalErrorToResponse,
  resolveAffiliatePortalRuntimeEnv,
  type AffiliatePortalAuthOptions,
  type AffiliatePortalRuntimeEnv,
} from "../_shared.ts";

/**
 * `GET /api/affiliate/batches/[batchId]`
 * Strictly self-scoped payout batch detail endpoint (`app` host ONLY; REQ-086, TASK-086).
 * Foreign affiliate batch IDs ALWAYS return neutral `404 NOT_FOUND`.
 */

export async function handleAffiliateBatchDetailRequest(
  batchId: string,
  request: Request,
  runtimeEnv: AffiliatePortalRuntimeEnv,
  options: AffiliatePortalAuthOptions = {},
): Promise<Response> {
  const authz = await authorizeAffiliateRequest(
    request,
    runtimeEnv,
    { requireAffiliateAccount: true, enforceCsrf: false },
    options,
  );
  if (!authz.ok) return authz.response;

  if (request.method.toUpperCase() !== "GET") {
    return affiliateErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode GET untuk membaca detail batch pencairan afiliasi.",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  try {
    const detail = await loadOwnedAffiliatePayoutBatchDetail(
      authz.ctx.platformDb,
      authz.ctx.affiliate!,
      batchId,
    );
    if (!detail) {
      return affiliateErrorResponse(
        404,
        "NOT_FOUND",
        "Batch pencairan afiliasi tidak ditemukan.",
        authz.ctx.requestId,
      );
    }

    return affiliateJsonResponse(200, {
      success: true,
      ...detail,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapAffiliatePortalErrorToResponse(err, authz.ctx.requestId);
  }
}

export const GET: APIRoute = ({ params, request }) =>
  handleAffiliateBatchDetailRequest(
    params.batchId ?? "",
    request,
    resolveAffiliatePortalRuntimeEnv(env as unknown as Record<string, unknown>),
  );

export const ALL: APIRoute = ({ params, request }) =>
  handleAffiliateBatchDetailRequest(
    params.batchId ?? "",
    request,
    resolveAffiliatePortalRuntimeEnv(env as unknown as Record<string, unknown>),
  );

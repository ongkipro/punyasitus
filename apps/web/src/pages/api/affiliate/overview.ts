import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  affiliateErrorResponse,
  affiliateJsonResponse,
  authorizeAffiliateRequest,
  loadAffiliatePortalOverview,
  loadOwnedAffiliatePayoutBatchDetail,
  mapAffiliatePortalErrorToResponse,
  resolveAffiliatePortalRuntimeEnv,
  type AffiliatePortalAuthOptions,
  type AffiliatePortalRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/affiliate/overview`
 * Authenticated affiliate self-service dashboard API (`app` host ONLY; REQ-086, PLAN §19.4, TASK-086).
 *
 * Security & Privacy Invariants:
 * - Strictly `app` host (`404` on marketing/console/tenant hosts).
 * - Better Auth `app` session + lifetime ceiling (`401 UNAUTHENTICATED`).
 * - Separate affiliate account isolation: tenant-only users receive `403 AFFILIATE_ACCOUNT_REQUIRED`.
 * - Rejects foreign `?affiliateId=` selector probing with `403 FORBIDDEN` and foreign `?batchId=`
 *   probing with `404 NOT_FOUND`.
 * - Zero tenant PII: referred tenants use masked handles ONLY.
 */

export async function handleAffiliateOverviewRequest(
  request: Request,
  runtimeEnv: AffiliatePortalRuntimeEnv,
  options: AffiliatePortalAuthOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();

  const authz = await authorizeAffiliateRequest(
    request,
    runtimeEnv,
    { requireAffiliateAccount: true, enforceCsrf: false },
    options,
  );
  if (!authz.ok) return authz.response;

  if (method !== "GET") {
    return affiliateErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode GET untuk membaca ringkasan Portal Afiliasi.",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const affiliate = authz.ctx.affiliate!;

  // Explicitly block cross-affiliate selector injection via query parameters
  const url = new URL(request.url);
  const requestedAffiliateId = url.searchParams.get("affiliateId")?.trim();
  if (requestedAffiliateId && requestedAffiliateId !== affiliate.id) {
    return affiliateErrorResponse(
      403,
      "FORBIDDEN",
      "Akses lintas akun afiliasi tidak diizinkan.",
      authz.ctx.requestId,
    );
  }

  const requestedBatchId = url.searchParams.get("batchId")?.trim();
  if (requestedBatchId) {
    try {
      const ownedBatch = await loadOwnedAffiliatePayoutBatchDetail(
        authz.ctx.platformDb,
        affiliate,
        requestedBatchId,
      );
      if (!ownedBatch) {
        return affiliateErrorResponse(
          404,
          "NOT_FOUND",
          "Batch pencairan afiliasi tidak ditemukan.",
          authz.ctx.requestId,
        );
      }
      return affiliateJsonResponse(200, {
        success: true,
        ...ownedBatch,
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapAffiliatePortalErrorToResponse(err, authz.ctx.requestId);
    }
  }

  try {
    const overview = await loadAffiliatePortalOverview(authz.ctx.platformDb, affiliate, {
      nowMs: authz.ctx.nowMs,
    });

    return affiliateJsonResponse(200, {
      success: true,
      ...overview,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapAffiliatePortalErrorToResponse(err, authz.ctx.requestId);
  }
}

export const GET: APIRoute = ({ request }) =>
  handleAffiliateOverviewRequest(
    request,
    resolveAffiliatePortalRuntimeEnv(env as unknown as Record<string, unknown>),
  );

export const ALL: APIRoute = ({ request }) =>
  handleAffiliateOverviewRequest(
    request,
    resolveAffiliatePortalRuntimeEnv(env as unknown as Record<string, unknown>),
  );

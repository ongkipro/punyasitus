import { env } from "cloudflare:workers";
import type { OfferingType } from "@punyasitus/core/schemas/common";
import { publishCatalogOffering } from "@punyasitus/db/catalog/index";
import type { APIRoute } from "astro";
import {
  enqueueIndexNowPublishPing,
  type IndexNowEnqueueEnv,
} from "../../../../../../worker/queues/seo/index.ts";
import {
  authorizeTenantCatalogRequest,
  buildCatalogRuntimeEnv,
  catalogErrorResponse,
  catalogJsonResponse,
  createRequestId,
  extractCatalogExpectedVersion,
  mapCatalogDomainErrorToResponse,
  parseSequentialPathId,
  parseStrictCatalogJsonBody,
  type TenantCatalogHandlerOptions,
  type TenantCatalogRuntimeEnv,
} from "../_shared.ts";

/**
 * Tenant-scoped catalog offering publish endpoint:
 * - `POST /api/tenants/:tenantId/catalog/:offeringId/publish`
 *
 * Atomically validates & publishes the offering snapshot via `publishResourceAtomically`
 * and bumps `PLATFORM_DB.tenants.cache_version` (TASK-009, REQ-012, REQ-013, REQ-016, REQ-036,
 * TASK-095 `REQ-095` IndexNow hook).
 */

const PUBLISH_ALLOWED_KEYS = new Set(["version", "expectedVersion", "confirmSlugChange"]);

const OFFERING_PUBLIC_PREFIX: Readonly<Record<OfferingType, string>> = {
  service: "/layanan",
  product: "/produk",
  tour: "/tour",
  vehicle: "/kendaraan",
};

export type TenantCatalogPublishRuntimeEnv = TenantCatalogRuntimeEnv & {
  readonly JOBS_QUEUE?: IndexNowEnqueueEnv["JOBS_QUEUE"] | null;
  readonly SAAS_ZONE?: string;
};

export async function handleTenantCatalogOfferingPublishRequest(
  tenantId: string,
  rawOfferingId: string,
  request: Request,
  runtimeEnv: TenantCatalogPublishRuntimeEnv,
  options: TenantCatalogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantCatalogRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return catalogErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP harus POST untuk mempublikasikan penawaran.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantCatalogRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:publish",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const offeringId = parseSequentialPathId(rawOfferingId);
  if (offeringId === null) {
    return catalogErrorResponse(404, "NOT_FOUND", "Penawaran tidak ditemukan.", requestId);
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    const parsedBody = await parseStrictCatalogJsonBody(request, PUBLISH_ALLOWED_KEYS, requestId);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    if (
      parsedBody.body.confirmSlugChange !== undefined &&
      typeof parsedBody.body.confirmSlugChange !== "boolean"
    ) {
      return catalogErrorResponse(
        422,
        "VALIDATION_ERROR",
        "confirmSlugChange harus berupa boolean.",
        requestId,
        [{ field: "confirmSlugChange", code: "INVALID_PAYLOAD", message: "Expected a boolean." }],
      );
    }

    const versionCheck = extractCatalogExpectedVersion(parsedBody.body, requestId, {
      required: true,
    });
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    const result = await publishCatalogOffering(platformDb, tenantDb, {
      tenantId: member.tenantId,
      offeringId,
      expectedVersion: versionCheck.expectedVersion!,
      actorUserId: member.userId,
      nowMs: options.nowMs,
    });

    if (runtimeEnv.JOBS_QUEUE) {
      const prefix = OFFERING_PUBLIC_PREFIX[result.offering.offeringType];
      const publicPath = `${prefix}/${result.offering.slug}`;
      try {
        await enqueueIndexNowPublishPing(
          {
            PLATFORM_DB: platformDb,
            JOBS_QUEUE: runtimeEnv.JOBS_QUEUE,
            tenantDb,
          },
          {
            tenantId: member.tenantId,
            urls: [publicPath],
            source: "cms",
            nowMs: options.nowMs,
            saasZone: runtimeEnv.SAAS_ZONE,
          },
        );
      } catch {
        // Non-blocking best-effort IndexNow ping; never fail a committed publish.
      }
    }

    return catalogJsonResponse(200, {
      ...result.offering,
      cacheVersion: result.cacheVersion,
      revisionNumber: result.revisionNumber,
    });
  } catch (err) {
    return mapCatalogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCatalogOfferingPublishRequest(
    params.tenantId ?? "",
    params.offeringId ?? "",
    request,
    {
      ...buildCatalogRuntimeEnv(),
      JOBS_QUEUE: env.JOBS_QUEUE,
      SAAS_ZONE: env.SAAS_ZONE,
    },
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );

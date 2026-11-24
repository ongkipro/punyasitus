import { env } from "cloudflare:workers";
import {
  ContentScreeningError,
  publishResourceWithScreening,
} from "@punyasitus/db/content-screening/index";
import { publishPage } from "@punyasitus/db/pages/index";
import type { APIRoute } from "astro";
import {
  enqueueIndexNowPublishPing,
  type IndexNowEnqueueEnv,
} from "../../../../../../worker/queues/seo/index.ts";
import {
  authorizeTenantPageRequest,
  buildPagesRuntimeEnv,
  createRequestId,
  extractPageExpectedVersion,
  formatPageRecordResponse,
  mapPageDomainErrorToResponse,
  pageErrorResponse,
  pageJsonResponse,
  parsePageIdParam,
  parseStrictPageJsonBody,
  type TenantPagesHandlerOptions,
  type TenantPagesRuntimeEnv,
} from "../_shared.ts";

/**
 * `POST /api/tenants/:tenantId/pages/:pageId/publish`
 * Atomically publishes a page draft snapshot and bumps `PLATFORM_DB.tenants.cache_version`.
 *
 * TASK-005 (`REQ-008`, `REQ-034`, `REQ-036`, `REQ-061`), TASK-095 (`REQ-095` IndexNow hook).
 */

const PUBLISH_ALLOWED_KEYS = new Set(["version", "expectedVersion", "confirmSlugChange"]);

export type TenantPagePublishRuntimeEnv = TenantPagesRuntimeEnv & {
  readonly JOBS_QUEUE?: IndexNowEnqueueEnv["JOBS_QUEUE"] | null;
  readonly SAAS_ZONE?: string;
};

export async function handleTenantPagePublishRequest(
  tenantId: string,
  rawPageId: string,
  request: Request,
  runtimeEnv: TenantPagePublishRuntimeEnv,
  options: TenantPagesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantPageRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return pageErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan POST untuk mempublikasikan halaman.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantPageRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:publish",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const parsedId = parsePageIdParam(rawPageId, requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  const parsedBody = await parseStrictPageJsonBody(request, PUBLISH_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractPageExpectedVersion(parsedBody.body, requestId, { required: true });
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  if (
    parsedBody.body.confirmSlugChange !== undefined &&
    typeof parsedBody.body.confirmSlugChange !== "boolean"
  ) {
    return pageErrorResponse(
      422,
      "VALIDATION_ERROR",
      "confirmSlugChange harus berupa boolean.",
      requestId,
      [
        {
          field: "confirmSlugChange",
          code: "INVALID_TYPE",
          message: "Expected a boolean for confirmSlugChange.",
        },
      ],
    );
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    const gateOutcome = await publishResourceWithScreening(platformDb, tenantDb, {
      tenantId: member.tenantId,
      resourceType: "page",
      resourceId: parsedId.pageId,
      expectedVersion: versionCheck.expectedVersion!,
      publishSource: "dashboard",
      actorUserId: member.userId,
      nowMs: options.nowMs,
      executePublish: () =>
        publishPage(platformDb, tenantDb, {
          tenantId: member.tenantId,
          pageId: parsedId.pageId,
          expectedVersion: versionCheck.expectedVersion!,
          confirmSlugChange: parsedBody.body.confirmSlugChange as boolean | undefined,
          actorUserId: member.userId,
          nowMs: options.nowMs,
        }),
    });

    if (gateOutcome.outcome === "held_for_review") {
      return pageJsonResponse(
        202,
        {
          outcome: "held_for_review",
          held: true,
          status: gateOutcome.ownerNotice.status,
          reason: gateOutcome.ownerNotice.reason,
          reviewId: gateOutcome.reviewId,
          message: gateOutcome.ownerNotice.message,
          ownerNotice: gateOutcome.ownerNotice,
          requestId,
        },
        { "Cache-Control": "private, no-store" },
      );
    }

    const result = gateOutcome.published;

    if (runtimeEnv.JOBS_QUEUE) {
      const publicPath = result.page.isHomepage ? "/" : `/${result.page.slug}`;
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

    return pageJsonResponse(200, {
      ...formatPageRecordResponse(result.page),
      cacheVersion: result.cacheVersion,
      revisionNumber: result.revisionNumber,
    });
  } catch (err) {
    if (err instanceof ContentScreeningError) {
      if (err.code === "STALE_VERSION") {
        return pageErrorResponse(409, "STALE_VERSION", err.message, requestId, [
          { field: "version", code: "STALE_VERSION", message: err.message },
        ]);
      }
      if (err.code === "NOT_FOUND") {
        return pageErrorResponse(404, "NOT_FOUND", err.message, requestId);
      }
      if (err.code === "TOO_MANY_PENDING_REVIEWS") {
        return pageErrorResponse(429, "RATE_LIMITED", err.message, requestId);
      }
      if (err.code === "VALIDATION_ERROR") {
        return pageErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
      }
      return pageErrorResponse(503, "SERVICE_UNAVAILABLE", err.message, requestId);
    }
    return mapPageDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPagePublishRequest(
    params.tenantId ?? "",
    params.pageId ?? "",
    request,
    {
      ...buildPagesRuntimeEnv(),
      JOBS_QUEUE: env.JOBS_QUEUE,
      SAAS_ZONE: env.SAAS_ZONE,
    },
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );

import { env } from "cloudflare:workers";
import { MediaMetadataUpdateRequestSchema } from "@punyasitus/core/schemas";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  getMediaItemById,
  purgeMediaItem,
  trashMediaItem,
  updateMediaMetadata,
} from "@punyasitus/db/media/index";
import type { APIRoute } from "astro";
import type { MediaWorkerR2BucketLike } from "../../../../../worker/queues/media/index.ts";
import {
  authorizeMediaApiRequest,
  createMediaErrorResponse,
  createMediaJsonResponse,
  detectForbiddenTenantSelectors,
  MEDIA_NO_STORE_HEADERS,
  parsePositiveIntParam,
  serializeMediaItemRecord,
  type MediaApiHandlerOptions,
  type MediaApiRuntimeEnv,
} from "./helpers.ts";

/**
 * Single media item endpoints:
 * - `GET    /api/tenants/{tenantId}/media/{resourceId}`
 * - `PATCH  /api/tenants/{tenantId}/media/{resourceId}` (OpenAPI `tenantUpdateMediaMetadata`)
 * - `DELETE /api/tenants/{tenantId}/media/{resourceId}` (soft-delete to trash, or `?permanent=true` purge)
 */

export async function handleMediaItemGet(
  tenantHandle: string,
  resourceIdParam: string,
  request: Request,
  runtimeEnv: MediaApiRuntimeEnv,
  options: MediaApiHandlerOptions = {},
): Promise<Response> {
  const auth = await authorizeMediaApiRequest(
    request,
    tenantHandle,
    runtimeEnv,
    { requiredPermission: "content:read", csrfMode: "none" },
    options,
  );
  if (!auth.ok) return auth.response;

  const mediaId = parsePositiveIntParam(resourceIdParam);
  if (!mediaId) {
    return createMediaErrorResponse(404, "NOT_FOUND", "Media tidak ditemukan.", auth.requestId);
  }

  const item = await getMediaItemById(auth.tenantDb, mediaId);
  if (!item) {
    return createMediaErrorResponse(404, "NOT_FOUND", "Media tidak ditemukan.", auth.requestId);
  }

  return createMediaJsonResponse(200, serializeMediaItemRecord(item, runtimeEnv));
}

export async function handleMediaItemPatch(
  tenantHandle: string,
  resourceIdParam: string,
  request: Request,
  runtimeEnv: MediaApiRuntimeEnv,
  options: MediaApiHandlerOptions = {},
): Promise<Response> {
  const auth = await authorizeMediaApiRequest(
    request,
    tenantHandle,
    runtimeEnv,
    { requiredPermission: "media:manage", csrfMode: "json" },
    options,
  );
  if (!auth.ok) return auth.response;

  const mediaId = parsePositiveIntParam(resourceIdParam);
  if (!mediaId) {
    return createMediaErrorResponse(404, "NOT_FOUND", "Media tidak ditemukan.", auth.requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return createMediaErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", auth.requestId);
  }

  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return createMediaErrorResponse(
      400,
      "BAD_REQUEST",
      "Body permintaan harus berupa objek JSON.",
      auth.requestId,
    );
  }

  const forbidden = detectForbiddenTenantSelectors(rawBody as Record<string, unknown>);
  if (forbidden.length > 0) {
    return createMediaErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field selector tenant tidak diizinkan.",
      auth.requestId,
      { fields: forbidden },
    );
  }

  const parsed = MediaMetadataUpdateRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return createMediaErrorResponse(
      422,
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Validasi metadata media gagal.",
      auth.requestId,
      {
        fields: parsed.error.issues.map((i) => ({
          field: i.path.join(".") || "body",
          code: i.code,
          message: i.message,
        })),
      },
    );
  }

  const updated = await updateMediaMetadata(auth.tenantDb, {
    mediaId,
    altText: parsed.data.alt,
    version: parsed.data.version,
    nowMs: auth.nowMs,
  });

  if (!updated.ok) {
    return createMediaErrorResponse(updated.status, updated.code, updated.message, auth.requestId);
  }

  return createMediaJsonResponse(200, serializeMediaItemRecord(updated.media, runtimeEnv));
}

export async function handleMediaItemDelete(
  tenantHandle: string,
  resourceIdParam: string,
  request: Request,
  runtimeEnv: MediaApiRuntimeEnv,
  options: MediaApiHandlerOptions = {},
): Promise<Response> {
  const auth = await authorizeMediaApiRequest(
    request,
    tenantHandle,
    runtimeEnv,
    { requiredPermission: "media:manage", csrfMode: "origin_only" },
    options,
  );
  if (!auth.ok) return auth.response;

  const mediaId = parsePositiveIntParam(resourceIdParam);
  if (!mediaId) {
    return createMediaErrorResponse(404, "NOT_FOUND", "Media tidak ditemukan.", auth.requestId);
  }

  const url = new URL(request.url);
  const permanent = url.searchParams.get("permanent") === "true";

  if (permanent) {
    const purged = await purgeMediaItem(auth.tenantDb, {
      tenantId: auth.member.tenantId,
      mediaId,
      mediaBucket: runtimeEnv.MEDIA_BUCKET ?? null,
      nowMs: auth.nowMs,
    });
    if (!purged.ok) {
      return createMediaErrorResponse(purged.status, purged.code, purged.message, auth.requestId, {
        ...(purged.references ? { extra: { references: purged.references } } : {}),
      });
    }
    return new Response(null, {
      status: 204,
      headers: MEDIA_NO_STORE_HEADERS,
    });
  }

  const trashed = await trashMediaItem(auth.tenantDb, mediaId, auth.nowMs);
  if (!trashed.ok) {
    return createMediaErrorResponse(trashed.status, trashed.code, trashed.message, auth.requestId, {
      ...(trashed.references ? { extra: { references: trashed.references } } : {}),
    });
  }

  return createMediaJsonResponse(200, serializeMediaItemRecord(trashed.media, runtimeEnv));
}

function buildRuntimeEnv(): MediaApiRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    MEDIA_BUCKET: runtimeEnv.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
  };
}

export const GET: APIRoute = ({ params, request }) =>
  handleMediaItemGet(params.tenantId ?? "", params.resourceId ?? "", request, buildRuntimeEnv());

export const PATCH: APIRoute = ({ params, request }) =>
  handleMediaItemPatch(params.tenantId ?? "", params.resourceId ?? "", request, buildRuntimeEnv());

export const DELETE: APIRoute = ({ params, request }) =>
  handleMediaItemDelete(params.tenantId ?? "", params.resourceId ?? "", request, buildRuntimeEnv());

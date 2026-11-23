import { env } from "cloudflare:workers";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  purgeMediaItem,
  restoreTrashedMediaItem,
  trashMediaItem,
} from "@punyasitus/db/media/index";
import {
  failVideoUploadIntent,
  prepareFailedVideoRetry,
} from "@punyasitus/db/media/video";
import type { APIRoute } from "astro";
import type { MediaWorkerR2BucketLike } from "../../../../../../worker/queues/media/index.ts";
import { MEDIA_PROCESS_VIDEO_TOPIC } from "../../../../../../worker/queues/media/video/index.ts";
import {
  authorizeMediaApiRequest,
  createMediaErrorResponse,
  createMediaJsonResponse,
  MEDIA_NO_STORE_HEADERS,
  parsePositiveIntParam,
  serializeMediaItemRecord,
  type MediaApiHandlerOptions,
  type MediaApiRuntimeEnv,
} from "../helpers.ts";

/**
 * Explicit lifecycle action endpoints for media items:
 * - `POST /api/tenants/{tenantId}/media/{resourceId}/trash`
 * - `POST /api/tenants/{tenantId}/media/{resourceId}/restore`
 * - `POST /api/tenants/{tenantId}/media/{resourceId}/purge`
 */

export async function handleMediaItemActionPost(
  tenantHandle: string,
  resourceIdParam: string,
  actionParam: string,
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

  const action = actionParam.trim().toLowerCase();

  if (action === "trash") {
    const trashed = await trashMediaItem(auth.tenantDb, mediaId, auth.nowMs);
    if (!trashed.ok) {
      return createMediaErrorResponse(
        trashed.status,
        trashed.code,
        trashed.message,
        auth.requestId,
        { ...(trashed.references ? { extra: { references: trashed.references } } : {}) },
      );
    }
    return createMediaJsonResponse(200, serializeMediaItemRecord(trashed.media, runtimeEnv));
  }

  if (action === "restore") {
    let version: number | undefined;
    try {
      const body = (await request.json()) as { version?: unknown };
      if (typeof body?.version === "number" && Number.isInteger(body.version)) {
        version = body.version;
      }
    } catch {
      return createMediaErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", auth.requestId);
    }
    const restored = await restoreTrashedMediaItem(auth.tenantDb, mediaId, version, auth.nowMs);
    if (!restored.ok) {
      return createMediaErrorResponse(
        restored.status,
        restored.code,
        restored.message,
        auth.requestId,
      );
    }
    return createMediaJsonResponse(200, serializeMediaItemRecord(restored.media, runtimeEnv));
  }

  if (action === "purge") {
    const purged = await purgeMediaItem(auth.tenantDb, {
      tenantId: auth.member.tenantId,
      mediaId,
      mediaBucket: runtimeEnv.MEDIA_BUCKET ?? null,
      nowMs: auth.nowMs,
    });
    if (!purged.ok) {
      return createMediaErrorResponse(
        purged.status,
        purged.code,
        purged.message,
        auth.requestId,
        { ...(purged.references ? { extra: { references: purged.references } } : {}) },
      );
    }
    return new Response(null, {
      status: 204,
      headers: MEDIA_NO_STORE_HEADERS,
    });
  }

  if (action === "retry") {
    if (!runtimeEnv.MEDIA_BUCKET || !runtimeEnv.JOBS_QUEUE) {
      return createMediaErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan penyimpanan atau antrean video sementara tidak tersedia.",
        auth.requestId,
        { retryAfterSeconds: 30 },
      );
    }

    const prepared = await prepareFailedVideoRetry(auth.tenantDb, {
      tenantId: auth.member.tenantId,
      mediaId,
      maxVideos: options.maxVideos,
      nowMs: auth.nowMs,
    });
    if (!prepared.ok) {
      return createMediaErrorResponse(
        prepared.status,
        prepared.code,
        prepared.message,
        auth.requestId,
      );
    }

    // Verify quarantine source still exists in R2 before re-enqueuing
    const existingObj = await runtimeEnv.MEDIA_BUCKET.get(prepared.intent.quarantineR2Key);
    if (!existingObj) {
      await failVideoUploadIntent(
        auth.tenantDb,
        prepared.intent.id,
        "RETRY_SOURCE_EXPIRED",
        auth.nowMs,
      );
      return createMediaErrorResponse(
        409,
        "RETRY_SOURCE_EXPIRED",
        "Berkas sumber karantina telah kedaluwarsa. Silakan unggah ulang video.",
        auth.requestId,
      );
    }

    const jobIdempotencyKey = `media-video-retry:${auth.member.tenantId}:${prepared.intent.id}:${auth.nowMs}`;
    try {
      await runtimeEnv.JOBS_QUEUE.send({
        idempotencyKey: jobIdempotencyKey,
        topic: MEDIA_PROCESS_VIDEO_TOPIC,
        tenantId: auth.member.tenantId,
        payload: {
          intentId: prepared.intent.id,
          mediaId,
          quarantineR2Key: prepared.intent.quarantineR2Key,
          originalFilename: prepared.intent.originalFilename,
        },
      });
    } catch {
      await failVideoUploadIntent(
        auth.tenantDb,
        prepared.intent.id,
        "QUEUE_ENQUEUE_FAILED",
        auth.nowMs,
      );
      return createMediaErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal menjadwalkan ulang pemrosesan video.",
        auth.requestId,
        { retryAfterSeconds: 15 },
      );
    }

    return createMediaJsonResponse(202, {
      ...serializeMediaItemRecord(prepared.media, runtimeEnv),
      jobIdempotencyKey,
    });
  }

  return createMediaErrorResponse(404, "NOT_FOUND", "Aksi media tidak ditemukan.", auth.requestId);
}

export const POST: APIRoute = ({ params, request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return handleMediaItemActionPost(
    params.tenantId ?? "",
    params.resourceId ?? "",
    params.action ?? "",
    request,
    {
      APP_ENV: runtimeEnv.APP_ENV,
      PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
      PLATFORM_DB: runtimeEnv.PLATFORM_DB,
      TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      MEDIA_BUCKET: runtimeEnv.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
      JOBS_QUEUE: runtimeEnv.JOBS_QUEUE,
      AUTH_SECRET: runtimeEnv.AUTH_SECRET,
      CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    },
  );
};

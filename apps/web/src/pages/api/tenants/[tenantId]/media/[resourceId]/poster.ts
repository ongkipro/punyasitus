import { env } from "cloudflare:workers";
import {
  inspectImageBinary,
  MAX_NORMALIZED_MASTER_BYTES,
  readBoundedStream,
  type CloudflareImagesBinding,
} from "@punyasitus/core/media/index";
import {
  buildVideoDerivativeKeys,
  MAX_POSTER_UPLOAD_BYTES,
  MAX_VIDEO_HEIGHT,
  MAX_VIDEO_WIDTH,
} from "@punyasitus/core/media/video";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  getVideoMediaItemById,
  updateVideoPoster,
} from "@punyasitus/db/media/video";
import type { APIRoute } from "astro";
import type { MediaWorkerR2BucketLike } from "../../../../../../worker/queues/media/index.ts";
import {
  authorizeMediaApiRequest,
  createMediaErrorResponse,
  createMediaJsonResponse,
  parsePositiveIntParam,
  serializeMediaItemRecord,
  type MediaApiHandlerOptions,
  type MediaApiRuntimeEnv,
} from "../helpers.ts";

/**
 * Client-captured video poster upload endpoint:
 * `PUT` / `POST /api/tenants/{tenantId}/media/{resourceId}/poster`
 *
 * Accepts a client-captured frame (WebP/JPEG/PNG <= 2 MB), converts/strips EXIF via
 * Cloudflare Images binding when available (or verifies valid `image/webp`), stores
 * strictly as `image/webp` under `t/<tenantId>/media/<mediaId>/<slug>-poster.webp`,
 * and updates `media_items.poster_r2_key`.
 */

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

export async function handleVideoPosterUpload(
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
    return createMediaErrorResponse(404, "NOT_FOUND", "Media video tidak ditemukan.", auth.requestId);
  }

  if (!runtimeEnv.MEDIA_BUCKET) {
    return createMediaErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Layanan penyimpanan media sementara tidak tersedia.",
      auth.requestId,
      { retryAfterSeconds: 30 },
    );
  }

  const existing = await getVideoMediaItemById(auth.tenantDb, mediaId);
  if (!existing) {
    return createMediaErrorResponse(404, "NOT_FOUND", "Media video tidak ditemukan.", auth.requestId);
  }
  if (existing.kind !== "video") {
    return createMediaErrorResponse(
      422,
      "NOT_A_VIDEO",
      "Poster video hanya dapat diunggah untuk media bertipe video.",
      auth.requestId,
    );
  }
  if (existing.deletedAt !== null) {
    return createMediaErrorResponse(
      409,
      "MEDIA_TRASHED",
      "Media video berada di folder Sampah dan tidak dapat diperbarui.",
      auth.requestId,
    );
  }
  if (existing.dbStatus !== "processing" && existing.dbStatus !== "ready") {
    return createMediaErrorResponse(
      409,
      "INVALID_MEDIA_STATE",
      `Poster video tidak dapat diunggah saat status media "${existing.dbStatus}".`,
      auth.requestId,
    );
  }

  const bounded = await readBoundedStream(request.body, MAX_POSTER_UPLOAD_BYTES);
  if (!bounded.ok) {
    return createMediaErrorResponse(
      bounded.status,
      bounded.code === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR",
      bounded.message,
      auth.requestId,
    );
  }

  const rawContentType = (request.headers.get("content-type")?.split(";")[0] ?? "")
    .trim()
    .toLowerCase();
  const declaredMime =
    rawContentType && rawContentType !== "application/octet-stream" ? rawContentType : undefined;

  const inspected = inspectImageBinary(bounded.bytes, declaredMime);
  if (!inspected.ok) {
    return createMediaErrorResponse(
      inspected.status,
      inspected.status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "VALIDATION_ERROR",
      inspected.message,
      auth.requestId,
      { extra: { reasonCode: inspected.code } },
    );
  }

  let webpPosterBytes: Uint8Array;
  if (runtimeEnv.IMAGES && typeof runtimeEnv.IMAGES.input === "function") {
    const out = await runtimeEnv.IMAGES.input(bytesToStream(bounded.bytes))
      .transform({
        width: Math.min(inspected.width, MAX_VIDEO_WIDTH),
        height: Math.min(inspected.height, MAX_VIDEO_HEIGHT),
        fit: "scale-down",
        metadata: "none",
        anim: false,
      })
      .output({
        format: "image/webp",
        quality: 80,
      });
    const read = await readBoundedStream(out.image(), MAX_NORMALIZED_MASTER_BYTES);
    if (!read.ok) {
      return createMediaErrorResponse(
        422,
        "POSTER_NORMALIZATION_FAILED",
        "Gagal mengoptimalkan poster video ke format WebP.",
        auth.requestId,
      );
    }
    const verified = inspectImageBinary(read.bytes, "image/webp");
    if (!verified.ok || verified.mimeType !== "image/webp") {
      return createMediaErrorResponse(
        422,
        "POSTER_NORMALIZATION_FAILED",
        "Poster hasil konversi bukan format image/webp yang valid.",
        auth.requestId,
      );
    }
    webpPosterBytes = read.bytes;
  } else if (inspected.mimeType === "image/webp") {
    webpPosterBytes = bounded.bytes;
  } else {
    return createMediaErrorResponse(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Poster video harus berupa format image/webp saat layanan konversi gambar tidak tersedia.",
      auth.requestId,
    );
  }

  const keys = buildVideoDerivativeKeys(
    auth.member.tenantId,
    mediaId,
    existing.slug ?? existing.originalFilename ?? `video-${mediaId}`,
  );

  await runtimeEnv.MEDIA_BUCKET.put(keys.poster, webpPosterBytes, {
    httpMetadata: {
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      tenantId: auth.member.tenantId,
      mediaId: String(mediaId),
      posterSource: "client_frame",
    },
  });

  const updated = await updateVideoPoster(auth.tenantDb, {
    tenantId: auth.member.tenantId,
    mediaId,
    posterR2Key: keys.poster,
    posterSource: "client_frame",
    nowMs: auth.nowMs,
  });

  if (!updated.ok) {
    return createMediaErrorResponse(updated.status, updated.code, updated.message, auth.requestId);
  }

  return createMediaJsonResponse(200, serializeMediaItemRecord(updated.media, runtimeEnv));
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
    IMAGES: runtimeEnv.IMAGES as CloudflareImagesBinding | undefined,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
  };
}

export const PUT: APIRoute = ({ params, request }) =>
  handleVideoPosterUpload(params.tenantId ?? "", params.resourceId ?? "", request, buildRuntimeEnv());

export const POST: APIRoute = ({ params, request }) =>
  handleVideoPosterUpload(params.tenantId ?? "", params.resourceId ?? "", request, buildRuntimeEnv());

import { env } from "cloudflare:workers";
import { readBoundedStream } from "@punyasitus/core/media/index";
import {
  buildVideoDerivativeKeys,
  MAX_CAPTION_VTT_BYTES,
  validateAndSanitizeWebVtt,
  validateCaptionLanguageTag,
} from "@punyasitus/core/media/video";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  getVideoMediaItemById,
  updateVideoCaptions,
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
 * Optional WebVTT caption upload endpoint for short videos:
 * `PUT` / `POST /api/tenants/{tenantId}/media/{resourceId}/captions`
 *
 * Strictly validates:
 * - Tenant auth + `media:manage` RBAC + locked-tenant write block
 * - Media item exists in tenant DB and has `kind === "video"`
 * - Hard size ceiling (`<= 256,000` bytes)
 * - Valid UTF-8 + W3C `WEBVTT` magic header + valid cue timings + XSS/script/HTML stripping
 */

export async function handleVideoCaptionsUpload(
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
      "Takarir WebVTT hanya dapat diunggah untuk media bertipe video.",
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
  if (existing.dbStatus !== "ready") {
    return createMediaErrorResponse(
      409,
      "INVALID_MEDIA_STATE",
      `Takarir WebVTT hanya dapat diunggah untuk video berstatus siap (saat ini "${existing.dbStatus}").`,
      auth.requestId,
    );
  }

  const url = new URL(request.url);
  const langParam = request.headers.get("x-caption-lang") ?? url.searchParams.get("lang") ?? "id";
  const safeLang = validateCaptionLanguageTag(langParam);
  if (!safeLang) {
    return createMediaErrorResponse(
      422,
      "INVALID_CAPTION_LANG",
      'Kode bahasa takarir tidak valid (contoh: "id", "en", "id-ID").',
      auth.requestId,
    );
  }
  const safeLabel = (
    request.headers.get("x-caption-label") ??
    url.searchParams.get("label") ??
    (safeLang.startsWith("en") ? "English" : "Bahasa Indonesia")
  )
    .replace(/[\r\n\t<>]/g, "")
    .trim()
    .slice(0, 60) || "Bahasa Indonesia";

  const bounded = await readBoundedStream(request.body, MAX_CAPTION_VTT_BYTES);
  if (!bounded.ok) {
    return createMediaErrorResponse(
      bounded.status,
      bounded.code === "PAYLOAD_TOO_LARGE" ? "CAPTION_TOO_LARGE" : "EMPTY_CAPTION",
      bounded.message,
      auth.requestId,
    );
  }

  const validated = validateAndSanitizeWebVtt(bounded.bytes);
  if (!validated.ok) {
    return createMediaErrorResponse(
      validated.status,
      validated.code,
      validated.message,
      auth.requestId,
    );
  }

  const keys = buildVideoDerivativeKeys(
    auth.member.tenantId,
    mediaId,
    existing.slug ?? existing.originalFilename ?? `video-${mediaId}`,
  );

  await runtimeEnv.MEDIA_BUCKET.put(keys.captions, validated.sanitizedBytes, {
    httpMetadata: {
      contentType: "text/vtt; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      tenantId: auth.member.tenantId,
      mediaId: String(mediaId),
      lang: safeLang,
      cueCount: String(validated.cueCount),
    },
  });

  const updated = await updateVideoCaptions(auth.tenantDb, {
    tenantId: auth.member.tenantId,
    mediaId,
    captionsR2Key: keys.captions,
    captionsLang: safeLang,
    captionsLabel: safeLabel,
    nowMs: auth.nowMs,
  });

  if (!updated.ok) {
    return createMediaErrorResponse(updated.status, updated.code, updated.message, auth.requestId);
  }

  return createMediaJsonResponse(200, {
    ...serializeMediaItemRecord(updated.media, runtimeEnv),
    cueCount: validated.cueCount,
    strippedHtml: validated.strippedHtml,
  });
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

export const PUT: APIRoute = ({ params, request }) =>
  handleVideoCaptionsUpload(params.tenantId ?? "", params.resourceId ?? "", request, buildRuntimeEnv());

export const POST: APIRoute = ({ params, request }) =>
  handleVideoCaptionsUpload(params.tenantId ?? "", params.resourceId ?? "", request, buildRuntimeEnv());

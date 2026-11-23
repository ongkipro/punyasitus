import { env } from "cloudflare:workers";
import {
  assertTenantR2Key,
  computeSha256Hex,
  readBoundedStream,
} from "@punyasitus/core/media/index";
import {
  inspectVideoBinary,
  MAX_VIDEO_UPLOAD_BYTES,
} from "@punyasitus/core/media/video";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  failVideoUploadIntent,
  getVideoUploadIntentById,
  markVideoIntentQuarantinedAndCreateMedia,
} from "@punyasitus/db/media/video";
import type { APIRoute } from "astro";
import type { MediaWorkerR2BucketLike } from "../../../../../../../worker/queues/media/index.ts";
import { MEDIA_PROCESS_VIDEO_TOPIC } from "../../../../../../../worker/queues/media/video/index.ts";
import {
  authorizeMediaApiRequest,
  createMediaErrorResponse,
  createMediaJsonResponse,
  type MediaApiHandlerOptions,
  type MediaApiRuntimeEnv,
} from "../../helpers.ts";

/**
 * Same-origin streaming short-video upload endpoint:
 * `PUT` / `POST /api/tenants/{tenantId}/media/video/upload/{intentId}`
 *
 * Security invariants (REQ-062, REQ-034, REQ-064; PLAN §7.2–7.3):
 * - Same quarantine/finalize boundary as images — NO presigned browser PUT URLs.
 * - Rejects foreign R2 keys (`x-r2-key`, `x-object-key`, `?r2Key=`, `?key=`, `?objectKey=`).
 * - Hard streaming byte ceiling `min(10,000,000, intent.declaredBytes)` — aborts on byte
 *   10,000,001 or `declaredBytes + 1` and releases reserved bytes & video slot cleanly.
 * - Verifies exact declared byte length and SHA-256 digest.
 * - Runs strict binary container/codec/resolution/fps inspection (`<= 1920x1080`, `<= 60 fps`,
 *   MP4/MOV/WebM, zero spoofed MIME or corrupt containers).
 * - Writes validated binary to private R2 quarantine `t/<tenantId>/quarantine/<intentId>/<slug>`.
 * - Allocates sequential `media_items` (`kind = 'video'`, `status = 'processing'`) and enqueues
 *   `media.process_video` durable job.
 */

export async function handleVideoStreamUpload(
  tenantHandle: string,
  intentIdParam: string,
  request: Request,
  runtimeEnv: MediaApiRuntimeEnv,
  options: MediaApiHandlerOptions = {},
): Promise<Response> {
  const auth = await authorizeMediaApiRequest(
    request,
    tenantHandle,
    runtimeEnv,
    { requiredPermission: "media:upload", csrfMode: "origin_only" },
    options,
  );
  if (!auth.ok) return auth.response;

  const intentId = intentIdParam.trim();
  if (!intentId) {
    return createMediaErrorResponse(
      404,
      "NOT_FOUND",
      "Upload intent video tidak ditemukan.",
      auth.requestId,
    );
  }

  // Reject any client-supplied R2 object key override (direct finalize bypass guard)
  const url = new URL(request.url);
  if (
    request.headers.has("x-r2-key") ||
    request.headers.has("x-object-key") ||
    url.searchParams.has("r2Key") ||
    url.searchParams.has("key") ||
    url.searchParams.has("objectKey")
  ) {
    return createMediaErrorResponse(
      403,
      "FORBIDDEN",
      "Client-supplied object keys are forbidden.",
      auth.requestId,
    );
  }

  if (!runtimeEnv.MEDIA_BUCKET || !runtimeEnv.JOBS_QUEUE) {
    return createMediaErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Layanan penyimpanan atau antrean pemrosesan video sementara tidak tersedia.",
      auth.requestId,
      { retryAfterSeconds: 30 },
    );
  }

  const intent = await getVideoUploadIntentById(auth.tenantDb, intentId);
  if (!intent) {
    return createMediaErrorResponse(
      404,
      "NOT_FOUND",
      "Upload intent video tidak ditemukan untuk tenant ini.",
      auth.requestId,
    );
  }

  if (intent.kind !== "video") {
    return createMediaErrorResponse(
      409,
      "CONFLICT",
      "Upload intent ini bukan untuk unggahan video.",
      auth.requestId,
    );
  }

  try {
    assertTenantR2Key(auth.member.tenantId, intent.quarantineR2Key, ["quarantine"]);
  } catch {
    return createMediaErrorResponse(
      403,
      "FORBIDDEN",
      "Kunci objek karantina tidak sesuai dengan tenant yang sah.",
      auth.requestId,
    );
  }

  if (intent.status !== "pending_upload") {
    return createMediaErrorResponse(
      409,
      "CONFLICT",
      `Upload intent tidak lagi menerima unggahan (status: ${intent.status}).`,
      auth.requestId,
    );
  }

  if (intent.expiresAt <= auth.nowMs) {
    await failVideoUploadIntent(auth.tenantDb, intent.id, "UPLOAD_INTENT_EXPIRED", auth.nowMs);
    return createMediaErrorResponse(
      410,
      "UPLOAD_INTENT_EXPIRED",
      "Upload intent video telah kedaluwarsa. Silakan buat intent baru.",
      auth.requestId,
    );
  }

  // Hard Content-Length fast-fail before reading stream
  const maxAllowedBytes = Math.min(MAX_VIDEO_UPLOAD_BYTES, intent.declaredBytes);
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const parsedLength = Number(contentLengthHeader);
    if (Number.isFinite(parsedLength) && parsedLength > maxAllowedBytes) {
      await failVideoUploadIntent(auth.tenantDb, intent.id, "PAYLOAD_TOO_LARGE", auth.nowMs);
      return createMediaErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran video melebihi batas ${maxAllowedBytes} byte.`,
        auth.requestId,
      );
    }
  }

  // Stream body through hard byte counter (aborts immediately on byte maxAllowedBytes + 1)
  const bounded = await readBoundedStream(request.body, maxAllowedBytes);
  if (!bounded.ok) {
    await failVideoUploadIntent(auth.tenantDb, intent.id, bounded.code, auth.nowMs);
    return createMediaErrorResponse(
      bounded.status,
      bounded.code === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR",
      bounded.message,
      auth.requestId,
    );
  }

  if (bounded.byteLength !== intent.declaredBytes) {
    await failVideoUploadIntent(auth.tenantDb, intent.id, "BYTE_LENGTH_MISMATCH", auth.nowMs);
    return createMediaErrorResponse(
      422,
      "VALIDATION_ERROR",
      `Jumlah byte unggahan (${bounded.byteLength}) tidak cocok dengan declaredBytes (${intent.declaredBytes}).`,
      auth.requestId,
    );
  }

  // Verify exact SHA-256 checksum
  const actualSha256 = await computeSha256Hex(bounded.bytes);
  if (actualSha256 !== intent.declaredSha256) {
    await failVideoUploadIntent(auth.tenantDb, intent.id, "CHECKSUM_MISMATCH", auth.nowMs);
    return createMediaErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Checksum SHA-256 berkas video tidak cocok dengan upload intent.",
      auth.requestId,
    );
  }

  // Strict container, codec, dimension (<= 1920x1080), fps (<= 60), and MIME spoofing inspection
  const inspected = inspectVideoBinary(bounded.bytes, intent.declaredMime);
  if (!inspected.ok) {
    await failVideoUploadIntent(auth.tenantDb, intent.id, inspected.code, auth.nowMs);
    const apiCode =
      inspected.status === 415
        ? "UNSUPPORTED_MEDIA_TYPE"
        : inspected.status === 413
          ? "PAYLOAD_TOO_LARGE"
          : "VALIDATION_ERROR";
    return createMediaErrorResponse(inspected.status, apiCode, inspected.message, auth.requestId, {
      extra: { reasonCode: inspected.code },
    });
  }

  // Reject spoofed request Content-Type header if caller explicitly sent a mismatched type
  const rawReqContentType = (request.headers.get("content-type")?.split(";")[0] ?? "")
    .trim()
    .toLowerCase();
  if (
    rawReqContentType &&
    rawReqContentType !== "application/octet-stream" &&
    rawReqContentType !== inspected.mimeType
  ) {
    await failVideoUploadIntent(auth.tenantDb, intent.id, "MIME_SPOOFING", auth.nowMs);
    return createMediaErrorResponse(
      422,
      "VALIDATION_ERROR",
      `Header Content-Type "${rawReqContentType}" tidak cocok dengan konten biner "${inspected.mimeType}".`,
      auth.requestId,
      { extra: { reasonCode: "MIME_SPOOFING" } },
    );
  }

  // Claim intent & allocate sequential media_items BEFORE writing R2
  const quarantined = await markVideoIntentQuarantinedAndCreateMedia(auth.tenantDb, {
    tenantId: auth.member.tenantId,
    intentId: intent.id,
    quarantineR2Key: intent.quarantineR2Key,
    detectedMime: inspected.mimeType,
    sha256: actualSha256,
    width: inspected.width,
    height: inspected.height,
    durationSeconds: inspected.durationSeconds,
    nowMs: auth.nowMs,
  });

  if (!quarantined.ok) {
    return createMediaErrorResponse(
      quarantined.status,
      quarantined.code,
      quarantined.message,
      auth.requestId,
    );
  }

  // Write validated video binary to private R2 quarantine prefix
  try {
    await runtimeEnv.MEDIA_BUCKET.put(intent.quarantineR2Key, bounded.bytes, {
      httpMetadata: {
        contentType: inspected.mimeType,
      },
      customMetadata: {
        tenantId: auth.member.tenantId,
        intentId: intent.id,
        quarantinedAtMs: String(auth.nowMs),
        originalFilename: intent.originalFilename,
        processingPath: inspected.processingPath,
      },
    });
  } catch {
    await failVideoUploadIntent(auth.tenantDb, intent.id, "R2_QUARANTINE_WRITE_FAILED", auth.nowMs);
    return createMediaErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal menulis berkas video ke karantina media. Silakan coba lagi.",
      auth.requestId,
      { retryAfterSeconds: 15 },
    );
  }

  // Enqueue bounded video processing job
  const jobIdempotencyKey = `media-video-process:${auth.member.tenantId}:${intent.id}`;
  try {
    await runtimeEnv.JOBS_QUEUE.send({
      idempotencyKey: jobIdempotencyKey,
      topic: MEDIA_PROCESS_VIDEO_TOPIC,
      tenantId: auth.member.tenantId,
      payload: {
        intentId: intent.id,
        mediaId: quarantined.mediaId,
        quarantineR2Key: intent.quarantineR2Key,
        originalFilename: intent.originalFilename,
      },
    });
  } catch {
    try {
      await runtimeEnv.MEDIA_BUCKET.delete(intent.quarantineR2Key);
    } catch {
      // Best-effort cleanup
    }
    await failVideoUploadIntent(auth.tenantDb, intent.id, "QUEUE_ENQUEUE_FAILED", auth.nowMs);
    return createMediaErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal menjadwalkan pemrosesan video. Silakan coba lagi.",
      auth.requestId,
      { retryAfterSeconds: 15 },
    );
  }

  return createMediaJsonResponse(202, {
    mediaId: quarantined.mediaId,
    intentId: intent.id,
    status: "processing",
    processingPath: inspected.processingPath,
    jobIdempotencyKey,
    width: inspected.width,
    height: inspected.height,
    fps: inspected.fps,
    durationSeconds: inspected.durationSeconds,
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
    JOBS_QUEUE: runtimeEnv.JOBS_QUEUE,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
  };
}

export const PUT: APIRoute = ({ params, request }) =>
  handleVideoStreamUpload(params.tenantId ?? "", params.intentId ?? "", request, buildRuntimeEnv());

export const POST: APIRoute = ({ params, request }) =>
  handleVideoStreamUpload(params.tenantId ?? "", params.intentId ?? "", request, buildRuntimeEnv());

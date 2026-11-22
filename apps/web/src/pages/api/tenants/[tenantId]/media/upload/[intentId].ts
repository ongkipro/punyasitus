import { env } from "cloudflare:workers";
import {
  assertTenantR2Key,
  computeSha256Hex,
  inspectImageBinary,
  MAX_SOURCE_UPLOAD_BYTES,
  readBoundedStream,
} from "@punyasitus/core/media/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  failMediaUploadIntent,
  getMediaUploadIntent,
  markUploadIntentQuarantinedAndCreateMedia,
} from "@punyasitus/db/media/index";
import type { APIRoute } from "astro";
import {
  MEDIA_PROCESS_IMAGE_TOPIC,
  type MediaWorkerR2BucketLike,
} from "../../../../../../worker/queues/media/index.ts";
import {
  authorizeMediaApiRequest,
  createMediaErrorResponse,
  createMediaJsonResponse,
  type MediaApiHandlerOptions,
  type MediaApiRuntimeEnv,
} from "../helpers.ts";

/**
 * Same-origin streaming media upload endpoint:
 * `PUT` / `POST /api/tenants/{tenantId}/media/upload/{intentId}`
 *
 * Security invariants (REQ-010, REQ-034, REQ-064; PLAN §7.2–7.3):
 * - NO presigned browser PUT URLs: all bytes stream directly through this admin endpoint.
 * - Rejects any client-supplied foreign object key overrides (`x-r2-key`, `?r2Key=`, `?key=`).
 * - Enforces hard streaming byte counter `min(5,000,000, intent.declaredBytes)` — aborts
 *   immediately on byte 5,000,001 or byte `declaredBytes + 1` without buffering unbounded data.
 * - Verifies exact declared byte length and SHA-256 digest.
 * - Runs strict magic-byte + header inspection (accepts JPG, PNG, WebP, HEIC/HEIF, GIF, TIFF;
 *   rejects zero-byte, corrupt, SVG, BMP, AVIF, video, MIME spoofing, oversized pixels).
 * - Writes validated binary to private R2 quarantine `t/<tenantId>/quarantine/<intentId>/<slug>`.
 * - Allocates sequential `media_items` row and enqueues `media.process_image` durable job.
 */

export async function handleMediaStreamUpload(
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
    return createMediaErrorResponse(404, "NOT_FOUND", "Upload intent tidak ditemukan.", auth.requestId);
  }

  // Reject any attempt to supply or override an R2 object key directly (direct finalize bypass guard)
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
      "Layanan penyimpanan atau antrean pemrosesan media sementara tidak tersedia.",
      auth.requestId,
      { retryAfterSeconds: 30 },
    );
  }

  // 1. Load & validate intent ownership, state, expiry, and quarantine R2 key
  const intent = await getMediaUploadIntent(auth.tenantDb, intentId);
  if (!intent) {
    return createMediaErrorResponse(
      404,
      "NOT_FOUND",
      "Upload intent tidak ditemukan untuk tenant ini.",
      auth.requestId,
    );
  }

  // Enforce strict tenant prefix on persisted quarantine key
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
    await failMediaUploadIntent(auth.tenantDb, intent.id, "UPLOAD_INTENT_EXPIRED", auth.nowMs);
    return createMediaErrorResponse(
      410,
      "UPLOAD_INTENT_EXPIRED",
      "Upload intent telah kedaluwarsa. Silakan buat intent unggahan baru.",
      auth.requestId,
    );
  }

  // 2. Hard Content-Length fast-fail before reading stream
  const maxAllowedBytes = Math.min(MAX_SOURCE_UPLOAD_BYTES, intent.declaredBytes);
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const parsedLength = Number(contentLengthHeader);
    if (Number.isFinite(parsedLength) && parsedLength > maxAllowedBytes) {
      await failMediaUploadIntent(auth.tenantDb, intent.id, "PAYLOAD_TOO_LARGE", auth.nowMs);
      return createMediaErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas ${maxAllowedBytes} byte.`,
        auth.requestId,
      );
    }
  }

  // 3. Stream body through hard byte counter (aborts immediately on byte maxAllowedBytes + 1)
  const bounded = await readBoundedStream(request.body, maxAllowedBytes);
  if (!bounded.ok) {
    await failMediaUploadIntent(auth.tenantDb, intent.id, bounded.code, auth.nowMs);
    return createMediaErrorResponse(
      bounded.status,
      bounded.code === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR",
      bounded.message,
      auth.requestId,
    );
  }

  if (bounded.byteLength !== intent.declaredBytes) {
    await failMediaUploadIntent(auth.tenantDb, intent.id, "BYTE_LENGTH_MISMATCH", auth.nowMs);
    return createMediaErrorResponse(
      422,
      "VALIDATION_ERROR",
      `Jumlah byte unggahan (${bounded.byteLength}) tidak cocok dengan declaredBytes (${intent.declaredBytes}).`,
      auth.requestId,
    );
  }

  // 4. Verify SHA-256 digest matches declared checksum
  const actualSha256 = await computeSha256Hex(bounded.bytes);
  if (actualSha256 !== intent.declaredSha256) {
    await failMediaUploadIntent(auth.tenantDb, intent.id, "CHECKSUM_MISMATCH", auth.nowMs);
    return createMediaErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Checksum SHA-256 berkas tidak cocok dengan upload intent.",
      auth.requestId,
    );
  }

  // 5. Strict magic-byte sniffing, real pixel bounds, and MIME spoofing check
  const inspected = inspectImageBinary(bounded.bytes, intent.declaredMime);
  if (!inspected.ok) {
    await failMediaUploadIntent(auth.tenantDb, intent.id, inspected.code, auth.nowMs);
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

  // Also reject spoofed request Content-Type header if caller explicitly sent a mismatched image/* or video/* type
  const rawReqContentType = (request.headers.get("content-type")?.split(";")[0] ?? "")
    .trim()
    .toLowerCase();
  if (
    rawReqContentType &&
    rawReqContentType !== "application/octet-stream" &&
    rawReqContentType !== inspected.mimeType &&
    !(
      (rawReqContentType === "image/heic" || rawReqContentType === "image/heif") &&
      (inspected.mimeType === "image/heic" || inspected.mimeType === "image/heif")
    )
  ) {
    await failMediaUploadIntent(auth.tenantDb, intent.id, "MIME_SPOOFING", auth.nowMs);
    return createMediaErrorResponse(
      422,
      "VALIDATION_ERROR",
      `Header Content-Type "${rawReqContentType}" tidak cocok dengan konten biner "${inspected.mimeType}".`,
      auth.requestId,
      { extra: { reasonCode: "MIME_SPOOFING" } },
    );
  }

  // 6. Atomically claim the intent and allocate sequential media_items row BEFORE writing R2
  //    so a concurrent upload race loser NEVER overwrites or deletes the winner's R2 object.
  const quarantined = await markUploadIntentQuarantinedAndCreateMedia(auth.tenantDb, {
    tenantId: auth.member.tenantId,
    intentId: intent.id,
    quarantineR2Key: intent.quarantineR2Key,
    detectedMime: inspected.mimeType,
    sha256: actualSha256,
    width: inspected.width,
    height: inspected.height,
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

  // 7. Write validated binary into private R2 quarantine prefix (rollback reservation on failure)
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
      },
    });
  } catch {
    await failMediaUploadIntent(auth.tenantDb, intent.id, "R2_QUARANTINE_WRITE_FAILED", auth.nowMs);
    return createMediaErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal menulis berkas ke karantina media. Silakan coba lagi.",
      auth.requestId,
      { retryAfterSeconds: 15 },
    );
  }

  // 8. Enqueue bounded Cloudflare Images processing job on JOBS_QUEUE (fail-closed rollback on failure)
  const jobIdempotencyKey = `media-process:${auth.member.tenantId}:${intent.id}`;
  try {
    await runtimeEnv.JOBS_QUEUE.send({
      idempotencyKey: jobIdempotencyKey,
      topic: MEDIA_PROCESS_IMAGE_TOPIC,
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
      // Best-effort cleanup; quarantine sweeper handles orphans
    }
    await failMediaUploadIntent(auth.tenantDb, intent.id, "QUEUE_ENQUEUE_FAILED", auth.nowMs);
    return createMediaErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal menjadwalkan pemrosesan gambar. Silakan coba lagi.",
      auth.requestId,
      { retryAfterSeconds: 15 },
    );
  }

  return createMediaJsonResponse(202, {
    mediaId: quarantined.mediaId,
    intentId: intent.id,
    status: "processing",
    jobIdempotencyKey,
    width: inspected.width,
    height: inspected.height,
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
  handleMediaStreamUpload(params.tenantId ?? "", params.intentId ?? "", request, buildRuntimeEnv());

export const POST: APIRoute = ({ params, request }) =>
  handleMediaStreamUpload(params.tenantId ?? "", params.intentId ?? "", request, buildRuntimeEnv());

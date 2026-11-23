import { env } from "cloudflare:workers";
import { computeSha256Hex } from "@punyasitus/core/media/index";
import {
  ELIGIBLE_VIDEO_MIMES,
  MAX_VIDEO_UPLOAD_BYTES,
  validateVideoPlacement,
} from "@punyasitus/core/media/video";
import {
  IdempotencyKeySchema,
  MediaUploadIntentRequestSchema,
} from "@punyasitus/core/schemas";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { createVideoUploadIntent } from "@punyasitus/db/media/video";
import type { APIRoute } from "astro";
import {
  authorizeMediaApiRequest,
  createMediaErrorResponse,
  createMediaJsonResponse,
  detectForbiddenTenantSelectors,
  type MediaApiHandlerOptions,
  type MediaApiRuntimeEnv,
} from "../helpers.ts";

/**
 * `POST /api/tenants/{tenantId}/media/video/upload-intent` (REQ-062, REQ-064; PLAN §7.2–7.3).
 *
 * Atomically enforces:
 * - Authenticated app session + live membership (`404` non-member) + `media:upload` RBAC + lifecycle lock (`403`)
 * - Same-origin CSRF & `application/json`
 * - Kill-switch (`VIDEO_UPLOAD_DISABLED=true` -> `503` rollback gate without affecting images)
 * - Exact 10,000,000-byte ceiling (`10,000,001` -> `413 PAYLOAD_TOO_LARGE`)
 * - MP4 (`video/mp4`), MOV (`video/quicktime`), WebM (`video/webm`) only (`415 UNSUPPORTED_MEDIA_TYPE` otherwise)
 * - Rejects `placement: "hero"` (`422 VIDEO_HERO_PLACEMENT_FORBIDDEN`)
 * - Atomic 20-video per-website cap (`422 VIDEO_LIMIT_REACHED` — parallel intents can never exceed 20)
 * - Atomic upload rate limits (`429 RATE_LIMITED`) and storage quota reservation (`422 STORAGE_QUOTA_EXCEEDED`)
 * - Returns same-origin admin streaming upload path `/api/tenants/{handle}/media/video/upload/{intentId}`
 */

export async function handleVideoUploadIntentPost(
  tenantHandle: string,
  request: Request,
  runtimeEnv: MediaApiRuntimeEnv,
  options: MediaApiHandlerOptions = {},
): Promise<Response> {
  const auth = await authorizeMediaApiRequest(
    request,
    tenantHandle,
    runtimeEnv,
    { requiredPermission: "media:upload", csrfMode: "json" },
    options,
  );
  if (!auth.ok) return auth.response;

  // Rollback kill-switch (TASK-060 Rollback/Migration State)
  if (runtimeEnv.VIDEO_UPLOAD_DISABLED === "true") {
    return createMediaErrorResponse(
      503,
      "VIDEO_UPLOAD_DISABLED",
      "Unggahan video sementara dinonaktifkan untuk pemeliharaan.",
      auth.requestId,
      { retryAfterSeconds: 60 },
    );
  }

  const rawIdempotencyKey = request.headers.get("idempotency-key")?.trim() || null;
  if (rawIdempotencyKey !== null) {
    const keyCheck = IdempotencyKeySchema.safeParse(rawIdempotencyKey);
    if (!keyCheck.success) {
      return createMediaErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Header Idempotency-Key harus berupa UUID yang valid.",
        auth.requestId,
        {
          fields: [
            {
              field: "Idempotency-Key",
              code: "INVALID_UUID",
              message: "Idempotency-Key must be a valid RFC 4122 UUID.",
            },
          ],
        },
      );
    }
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return createMediaErrorResponse(
      400,
      "BAD_REQUEST",
      "Format JSON permintaan tidak valid.",
      auth.requestId,
    );
  }

  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return createMediaErrorResponse(
      400,
      "BAD_REQUEST",
      "Body permintaan harus berupa objek JSON.",
      auth.requestId,
    );
  }

  const record = rawBody as Record<string, unknown>;
  const forbiddenSelectors = detectForbiddenTenantSelectors(record);
  if (forbiddenSelectors.length > 0) {
    return createMediaErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field selector tenant tidak diizinkan pada body permintaan.",
      auth.requestId,
      { fields: forbiddenSelectors },
    );
  }

  // Optional placement validation: strictly reject hero placement (REQ-062)
  if (record.placement !== undefined) {
    const placementCheck = validateVideoPlacement(record.placement);
    if (!placementCheck.ok) {
      return createMediaErrorResponse(
        422,
        placementCheck.code,
        placementCheck.messageId,
        auth.requestId,
        {
          fields: [
            {
              field: "placement",
              code: placementCheck.code,
              message: placementCheck.message,
            },
          ],
        },
      );
    }
  }

  // Reject autoplay if caller attempts to request it
  if (record.autoplay === true) {
    return createMediaErrorResponse(
      422,
      "VIDEO_AUTOPLAY_FORBIDDEN",
      "Putar otomatis (autoplay) tidak diizinkan pada video pendek.",
      auth.requestId,
    );
  }

  // Early 413 for exact 10,000,001+ bytes
  if (
    typeof record.declaredBytes === "number" &&
    record.declaredBytes > MAX_VIDEO_UPLOAD_BYTES
  ) {
    return createMediaErrorResponse(
      413,
      "PAYLOAD_TOO_LARGE",
      `Ukuran video melebihi batas maksimum ${MAX_VIDEO_UPLOAD_BYTES} byte (10 MB).`,
      auth.requestId,
    );
  }

  // Validate MIME early for clean 415
  if (
    typeof record.mimeType === "string" &&
    !(ELIGIBLE_VIDEO_MIMES as readonly string[]).includes(record.mimeType.trim().toLowerCase())
  ) {
    return createMediaErrorResponse(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Format video tidak didukung. Unggah berkas MP4, MOV, atau WebM.",
      auth.requestId,
      {
        fields: [
          {
            field: "mimeType",
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "Video MIME type must be video/mp4, video/quicktime, or video/webm.",
          },
        ],
      },
    );
  }

  // Strip validated optional `placement` before strict schema check
  const baseIntentRecord: Record<string, unknown> = { ...record };
  delete baseIntentRecord.placement;
  const candidate = {
    ...baseIntentRecord,
    kind: record.kind ?? "video",
  };

  if (candidate.kind !== "video") {
    return createMediaErrorResponse(
      422,
      "VALIDATION_ERROR",
      'Endpoint ini hanya menerima unggahan dengan kind "video".',
      auth.requestId,
    );
  }

  const parsed = MediaUploadIntentRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      code: issue.code,
      message: issue.message,
    }));
    const isMimeRejection = parsed.error.issues.some((i) => i.path[0] === "mimeType");
    return createMediaErrorResponse(
      isMimeRejection ? 415 : 422,
      isMimeRejection ? "UNSUPPORTED_MEDIA_TYPE" : "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Validasi upload intent video gagal.",
      auth.requestId,
      { fields },
    );
  }

  const data = parsed.data;
  const payloadCanonical = JSON.stringify({
    kind: "video",
    filename: data.filename,
    mimeType: data.mimeType,
    declaredBytes: data.declaredBytes,
    sha256: data.sha256,
    alt: data.alt,
  });
  const payloadHash = await computeSha256Hex(new TextEncoder().encode(payloadCanonical));

  const created = await createVideoUploadIntent(auth.tenantDb, {
    tenantId: auth.member.tenantId,
    tenantStatus: auth.member.tenantStatus,
    filename: data.filename,
    declaredMime: data.mimeType,
    declaredBytes: data.declaredBytes,
    declaredSha256: data.sha256,
    altText: data.alt,
    idempotencyKey: rawIdempotencyKey,
    payloadHash,
    createdByUserId: auth.member.userId,
    ttlMs: options.intentTtlMs,
    nowMs: auth.nowMs,
    hourlyLimit: options.hourlyLimit,
    dailyLimit: options.dailyLimit,
    maxVideos: options.maxVideos,
  });

  if (!created.ok) {
    if (created.status === 429) {
      return createMediaErrorResponse(
        429,
        created.code,
        created.message,
        auth.requestId,
        {
          retryAfterSeconds: created.retryAfterSeconds,
          extra: { window: created.window },
        },
      );
    }
    if (created.code === "VIDEO_LIMIT_REACHED") {
      return createMediaErrorResponse(
        422,
        created.code,
        created.message,
        auth.requestId,
        {
          extra: {
            videoSlotsUsed: created.videoSlots.usedSlots,
            videoSlotsLimit: created.videoSlots.maxSlots,
          },
        },
      );
    }
    if (created.code === "STORAGE_QUOTA_EXCEEDED") {
      return createMediaErrorResponse(
        422,
        created.code,
        created.message,
        auth.requestId,
        {
          extra: {
            usedBytes: created.usage.usedBytes,
            reservedBytes: created.usage.reservedBytes,
            quotaBytes: created.usage.quotaBytes,
          },
        },
      );
    }
    return createMediaErrorResponse(created.status, created.code, created.message, auth.requestId);
  }

  const uploadPath = `/api/tenants/${auth.member.handle}/media/video/upload/${created.intent.id}`;

  return createMediaJsonResponse(created.replayed ? 200 : 201, {
    intentId: created.intent.id,
    uploadPath,
    expiresAt: new Date(created.intent.expiresAt).toISOString(),
    reservedBytes: created.intent.reservedBytes,
    quotaUsedBytes: created.usage.usedBytes + created.usage.reservedBytes,
    quotaLimitBytes: created.usage.quotaBytes,
    videoSlotsUsed: created.videoSlots.usedSlots,
    videoSlotsLimit: created.videoSlots.maxSlots,
  });
}

export const POST: APIRoute = ({ params, request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly VIDEO_UPLOAD_DISABLED?: string;
  };
  return handleVideoUploadIntentPost(params.tenantId ?? "", request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    VIDEO_UPLOAD_DISABLED: runtimeEnv.VIDEO_UPLOAD_DISABLED,
  });
};

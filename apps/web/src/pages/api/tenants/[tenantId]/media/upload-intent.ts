import { env } from "cloudflare:workers";
import { computeSha256Hex, MAX_SOURCE_UPLOAD_BYTES } from "@punyasitus/core/media/index";
import {
  IdempotencyKeySchema,
  MediaUploadIntentRequestSchema,
} from "@punyasitus/core/schemas";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { createMediaUploadIntent } from "@punyasitus/db/media/index";
import type { APIRoute } from "astro";
import {
  authorizeMediaApiRequest,
  createMediaErrorResponse,
  createMediaJsonResponse,
  detectForbiddenTenantSelectors,
  type MediaApiHandlerOptions,
  type MediaApiRuntimeEnv,
} from "./helpers.ts";

/**
 * `POST /api/tenants/{tenantId}/media/upload-intent` (OpenAPI `tenantCreateMediaUploadIntent`).
 *
 * Atomically enforces:
 * - Authenticated app session + live membership (`404` non-member) + `media:upload` RBAC + lifecycle lock (`403`)
 * - Same-origin CSRF & `application/json`
 * - Rejects video uploads here (deferred strictly to TASK-060)
 * - Rejects SVG, BMP, AVIF, oversized `declaredBytes > 5,000,000`, and forbidden tenant selectors
 * - Enforces 50/hour and 200/day rate limits (`429 RATE_LIMITED` + `Retry-After`)
 * - Enforces atomic storage quota reservation (`422 STORAGE_QUOTA_EXCEEDED` at +1 byte over limit)
 * - Returns same-origin admin streaming upload path `/api/tenants/{handle}/media/upload/{intentId}`
 *   (NEVER a presigned browser PUT URL).
 */

export async function handleMediaUploadIntentPost(
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

  // Validate optional/required Idempotency-Key header
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

  // Parse JSON body safely
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

  // Explicitly reject video uploads in TASK-007 (handled only by TASK-060)
  if (record.kind === "video") {
    return createMediaErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Unggahan video tidak ditangani oleh pipeline gambar (TASK-060).",
      auth.requestId,
      {
        fields: [
          {
            field: "kind",
            code: "VIDEO_NOT_SUPPORTED",
            message: "Video uploads are rejected by the image pipeline and handled only by TASK-060.",
          },
        ],
      },
    );
  }

  // Check declared byte ceiling early for clean 413 response
  if (
    typeof record.declaredBytes === "number" &&
    record.declaredBytes > MAX_SOURCE_UPLOAD_BYTES
  ) {
    return createMediaErrorResponse(
      413,
      "PAYLOAD_TOO_LARGE",
      `Ukuran gambar melebihi batas maksimum ${MAX_SOURCE_UPLOAD_BYTES} byte.`,
      auth.requestId,
    );
  }

  const parsed = MediaUploadIntentRequestSchema.safeParse(record);
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
      parsed.error.issues[0]?.message ?? "Validasi upload intent gagal.",
      auth.requestId,
      { fields },
    );
  }

  const data = parsed.data;
  const decorative = request.headers.get("x-media-decorative")?.trim().toLowerCase() === "true";

  // Compute deterministic payload hash for idempotency conflict checks
  const payloadCanonical = JSON.stringify({
    kind: data.kind,
    filename: data.filename,
    mimeType: data.mimeType,
    declaredBytes: data.declaredBytes,
    sha256: data.sha256,
    alt: data.alt,
    decorative,
  });
  const payloadHash = await computeSha256Hex(new TextEncoder().encode(payloadCanonical));

  const created = await createMediaUploadIntent(auth.tenantDb, {
    tenantId: auth.member.tenantId,
    tenantStatus: auth.member.tenantStatus,
    filename: data.filename,
    declaredMime: data.mimeType,
    declaredBytes: data.declaredBytes,
    declaredSha256: data.sha256,
    altText: data.alt,
    decorative,
    idempotencyKey: rawIdempotencyKey,
    payloadHash,
    createdByUserId: auth.member.userId,
    ttlMs: options.intentTtlMs,
    nowMs: auth.nowMs,
    hourlyLimit: options.hourlyLimit,
    dailyLimit: options.dailyLimit,
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
    if (created.status === 422) {
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

  const uploadPath = `/api/tenants/${auth.member.handle}/media/upload/${created.intent.id}`;

  return createMediaJsonResponse(created.replayed ? 200 : 201, {
    intentId: created.intent.id,
    uploadPath,
    expiresAt: new Date(created.intent.expiresAt).toISOString(),
    reservedBytes: created.intent.reservedBytes,
    quotaUsedBytes: created.usage.usedBytes + created.usage.reservedBytes,
    quotaLimitBytes: created.usage.quotaBytes,
  });
}

export const POST: APIRoute = ({ params, request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return handleMediaUploadIntentPost(params.tenantId ?? "", request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
  });
};

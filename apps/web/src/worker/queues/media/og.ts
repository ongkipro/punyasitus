import {
  assertTenantR2Key,
  buildMediaDerivativeKeys,
  inspectImageBinary,
  MAX_OG_DERIVATIVE_BYTES,
  readBoundedStream,
  type CloudflareImagesBinding,
  type MediaVariantEntry,
} from "@punyasitus/core/media/index";
import {
  buildOgImageCandidateFromMediaRecord,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_MAX_BYTES,
  OG_IMAGE_WIDTH,
  type OgImageCandidate,
} from "@punyasitus/core/og-generator";
import { getMediaItemById, type MediaItemRecord } from "@punyasitus/db/media/index";
import type { MediaWorkerR2BucketLike } from "./index.ts";

/**
 * Open Graph `1200x630` (`<= 300 KiB` / `307_200` bytes) Image Derivative Helper
 * & Tenant-Scoped Media Resolver (REQ-023, PLAN §7.3, TASK-016).
 *
 * Integrates with TASK-007's Cloudflare Images binding contract:
 * - Cover-crops to exact `1200x630` `image/webp` with `metadata: "none"` (EXIF/GPS stripped)
 *   and `anim: false` (first frame for GIF).
 * - Steps down quality cleanly across `OG_QUALITY_LADDER` when initial output exceeds `307_200` bytes.
 * - Fails cleanly with a structured error result (never buffering unbounded streams or throwing
 *   unhandled errors) so callers can safely fall back to tenant default / platform fallback.
 * - Resolves tenant-scoped `media_items` + optional R2 object verification before emitting OG URLs.
 */

export const OG_DERIVATIVE_WIDTH = OG_IMAGE_WIDTH;
export const OG_DERIVATIVE_HEIGHT = OG_IMAGE_HEIGHT;
export const OG_DERIVATIVE_MAX_BYTES = MAX_OG_DERIVATIVE_BYTES; // 307_200 (300 KiB)
export const OG_QUALITY_LADDER = [82, 72, 62, 52, 42, 32] as const;

export interface OgR2BucketLike extends MediaWorkerR2BucketLike {
  head?(key: string): Promise<R2Object | null>;
}

export interface GenerateOgDerivativeOptions {
  /** Maximum byte budget (capped at `307_200` = 300 KiB). */
  readonly maxBytes?: number;
  /** Ordered descending WebP quality steps to attempt. */
  readonly qualityLadder?: readonly number[];
}

export type GenerateOgDerivativeResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly byteLength: number;
      readonly width: typeof OG_DERIVATIVE_WIDTH;
      readonly height: typeof OG_DERIVATIVE_HEIGHT;
      readonly mimeType: "image/webp";
      readonly qualityUsed: number;
      readonly attempts: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | "EMPTY_SOURCE"
        | "INVALID_OUTPUT_FORMAT"
        | "INVALID_OUTPUT_DIMENSIONS"
        | "OG_BUDGET_EXCEEDED"
        | "TRANSFORM_FAILED";
      readonly message: string;
      readonly attempts: number;
      readonly lastByteLength: number | null;
    };

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function resolveQualitySteps(custom?: readonly number[]): readonly number[] {
  if (!custom || custom.length === 0) {
    return OG_QUALITY_LADDER;
  }
  const valid = custom.filter((q) => Number.isInteger(q) && q >= 10 && q <= 100);
  return valid.length > 0 ? valid : OG_QUALITY_LADDER;
}

/**
 * Produces and validates a `1200x630` cover-cropped WebP OG derivative (`<= 307_200` bytes)
 * through the Cloudflare Workers Images binding, stepping down quality automatically until
 * the output fits within the 300 KiB WhatsApp/social preview budget.
 */
export async function generateOgDerivative(
  images: CloudflareImagesBinding,
  sourceBytes: Uint8Array,
  options: GenerateOgDerivativeOptions = {},
): Promise<GenerateOgDerivativeResult> {
  if (!sourceBytes || sourceBytes.byteLength === 0) {
    return {
      ok: false,
      code: "EMPTY_SOURCE",
      message: "Source image bytes are empty; cannot generate OG derivative.",
      attempts: 0,
      lastByteLength: 0,
    };
  }

  const maxBytes =
    options.maxBytes !== undefined && Number.isInteger(options.maxBytes) && options.maxBytes > 0
      ? Math.min(options.maxBytes, OG_DERIVATIVE_MAX_BYTES)
      : OG_DERIVATIVE_MAX_BYTES;
  const qualities = resolveQualitySteps(options.qualityLadder);

  let attempts = 0;
  let lastByteLength: number | null = null;

  for (const quality of qualities) {
    attempts += 1;
    let output;
    try {
      output = await images
        .input(bytesToReadableStream(sourceBytes))
        .transform({
          width: OG_DERIVATIVE_WIDTH,
          height: OG_DERIVATIVE_HEIGHT,
          fit: "cover",
          metadata: "none",
          anim: false,
        })
        .output({
          format: "image/webp",
          quality,
        });
    } catch (err) {
      return {
        ok: false,
        code: "TRANSFORM_FAILED",
        message: err instanceof Error ? err.message : "Cloudflare Images OG transform failed.",
        attempts,
        lastByteLength,
      };
    }

    const read = await readBoundedStream(output.image(), maxBytes);
    if (!read.ok) {
      lastByteLength = read.bytesRead;
      if (read.code === "PAYLOAD_TOO_LARGE") {
        // Step down to next lower quality in ladder
        continue;
      }
      return {
        ok: false,
        code: "INVALID_OUTPUT_FORMAT",
        message: "Cloudflare Images binding returned an empty OG derivative stream.",
        attempts,
        lastByteLength,
      };
    }

    lastByteLength = read.byteLength;
    const inspected = inspectImageBinary(read.bytes, "image/webp");
    if (!inspected.ok || inspected.mimeType !== "image/webp") {
      return {
        ok: false,
        code: "INVALID_OUTPUT_FORMAT",
        message: "Cloudflare Images binding returned a non-WebP OG derivative.",
        attempts,
        lastByteLength,
      };
    }

    if (inspected.width !== OG_DERIVATIVE_WIDTH || inspected.height !== OG_DERIVATIVE_HEIGHT) {
      return {
        ok: false,
        code: "INVALID_OUTPUT_DIMENSIONS",
        message: `OG derivative dimensions (${inspected.width}x${inspected.height}) did not match ${OG_DERIVATIVE_WIDTH}x${OG_DERIVATIVE_HEIGHT}.`,
        attempts,
        lastByteLength,
      };
    }

    return {
      ok: true,
      bytes: read.bytes,
      byteLength: read.byteLength,
      width: OG_DERIVATIVE_WIDTH,
      height: OG_DERIVATIVE_HEIGHT,
      mimeType: "image/webp",
      qualityUsed: quality,
      attempts,
    };
  }

  return {
    ok: false,
    code: "OG_BUDGET_EXCEEDED",
    message: `OG derivative could not fit within ${maxBytes} bytes after ${attempts} quality step-downs.`,
    attempts,
    lastByteLength,
  };
}

export interface GenerateAndStoreTenantOgDerivativeInput {
  readonly tenantId: string;
  readonly mediaId: number;
  readonly originalFilename: string;
  readonly sourceBytes: Uint8Array;
  readonly images: CloudflareImagesBinding;
  readonly mediaBucket: OgR2BucketLike;
  readonly maxBytes?: number;
  readonly qualityLadder?: readonly number[];
}

export type GenerateAndStoreTenantOgDerivativeResult =
  | {
      readonly ok: true;
      readonly variant: MediaVariantEntry;
      readonly qualityUsed: number;
      readonly attempts: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | "INVALID_R2_KEY"
        | "EMPTY_SOURCE"
        | "INVALID_OUTPUT_FORMAT"
        | "INVALID_OUTPUT_DIMENSIONS"
        | "OG_BUDGET_EXCEEDED"
        | "TRANSFORM_FAILED";
      readonly message: string;
      readonly attempts: number;
    };

/**
 * Generates a bounded `1200x630 <= 300 KiB` WebP OG derivative and persists it to the
 * tenant's isolated R2 namespace (`t/<tenantId>/media/<mediaId>/<slug>-og.webp`).
 */
export async function generateAndStoreTenantOgDerivative(
  input: GenerateAndStoreTenantOgDerivativeInput,
): Promise<GenerateAndStoreTenantOgDerivativeResult> {
  let ogKey: string;
  try {
    const keys = buildMediaDerivativeKeys(input.tenantId, input.mediaId, input.originalFilename);
    ogKey = assertTenantR2Key(input.tenantId, keys.og, ["media"]);
  } catch (err) {
    return {
      ok: false,
      code: "INVALID_R2_KEY",
      message: err instanceof Error ? err.message : "Invalid tenant R2 key for OG derivative.",
      attempts: 0,
    };
  }

  const generated = await generateOgDerivative(input.images, input.sourceBytes, {
    maxBytes: input.maxBytes,
    qualityLadder: input.qualityLadder,
  });

  if (!generated.ok) {
    return {
      ok: false,
      code: generated.code,
      message: generated.message,
      attempts: generated.attempts,
    };
  }

  await input.mediaBucket.put(ogKey, generated.bytes, {
    httpMetadata: {
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      tenantId: input.tenantId,
      mediaId: String(input.mediaId),
      variant: "og",
      exifStripped: "true",
      ogQuality: String(generated.qualityUsed),
    },
  });

  return {
    ok: true,
    variant: {
      key: ogKey,
      width: generated.width,
      height: generated.height,
      bytes: generated.byteLength,
      mimeType: "image/webp",
    },
    qualityUsed: generated.qualityUsed,
    attempts: generated.attempts,
  };
}

export interface ResolveTenantOgImageInput {
  readonly tenantId: string;
  readonly tenantDb: D1Database;
  readonly mediaId: number | null | undefined;
  readonly mediaBucket?: OgR2BucketLike | null;
  readonly mediaPublicBaseUrl?: string | null;
  readonly platformDomain?: string | null;
  readonly fallbackAlt?: string | null;
  /** When `true` and `mediaBucket` is supplied, verifies object existence & actual stored byte size in R2. */
  readonly verifyR2Object?: boolean;
}

export type ResolveTenantOgImageResult =
  | {
      readonly ok: true;
      readonly candidate: OgImageCandidate;
      readonly media: MediaItemRecord;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "MISSING_MEDIA_ID"
        | "NOT_FOUND"
        | "NOT_IMAGE"
        | "NOT_READY"
        | "TRASHED"
        | "MISSING_OG_DERIVATIVE"
        | "CROSS_TENANT_OR_INVALID_KEY"
        | "INVALID_DIMENSIONS"
        | "OVERSIZED"
        | "R2_OBJECT_MISSING"
        | "R2_OBJECT_OVERSIZED";
      readonly candidate: null;
    };

/**
 * Resolves and strictly verifies a tenant-scoped OG derivative metadata record from
 * `TenantStore.media_items` (and optionally live R2 object size/existence) before passing
 * it into `generateOpenGraphMetadata`.
 */
export async function resolveTenantOgImageCandidate(
  input: ResolveTenantOgImageInput,
): Promise<ResolveTenantOgImageResult> {
  if (!input.mediaId || !Number.isInteger(input.mediaId) || input.mediaId < 1) {
    return { ok: false, reason: "MISSING_MEDIA_ID", candidate: null };
  }

  const media = await getMediaItemById(input.tenantDb, input.mediaId);
  if (!media) {
    return { ok: false, reason: "NOT_FOUND", candidate: null };
  }

  if (media.kind !== "image") {
    return { ok: false, reason: "NOT_IMAGE", candidate: null };
  }

  if (media.deletedAt !== null || media.status === "trashed") {
    return { ok: false, reason: "TRASHED", candidate: null };
  }

  if (media.status !== "ready" || media.dbStatus !== "ready") {
    return { ok: false, reason: "NOT_READY", candidate: null };
  }

  const ogVariant = media.variants?.og;
  if (!ogVariant) {
    return { ok: false, reason: "MISSING_OG_DERIVATIVE", candidate: null };
  }

  try {
    assertTenantR2Key(input.tenantId, ogVariant.key, ["media"]);
  } catch {
    return { ok: false, reason: "CROSS_TENANT_OR_INVALID_KEY", candidate: null };
  }

  if (ogVariant.width !== OG_DERIVATIVE_WIDTH || ogVariant.height !== OG_DERIVATIVE_HEIGHT) {
    return { ok: false, reason: "INVALID_DIMENSIONS", candidate: null };
  }

  if (!Number.isInteger(ogVariant.bytes) || ogVariant.bytes <= 0 || ogVariant.bytes > OG_IMAGE_MAX_BYTES) {
    return { ok: false, reason: "OVERSIZED", candidate: null };
  }

  let effectiveBytes = ogVariant.bytes;

  if (input.verifyR2Object && input.mediaBucket) {
    const obj =
      typeof input.mediaBucket.head === "function"
        ? await input.mediaBucket.head(ogVariant.key)
        : await input.mediaBucket.get(ogVariant.key);
    if (!obj) {
      return { ok: false, reason: "R2_OBJECT_MISSING", candidate: null };
    }
    if (obj.size <= 0 || obj.size > OG_IMAGE_MAX_BYTES) {
      return { ok: false, reason: "R2_OBJECT_OVERSIZED", candidate: null };
    }
    // Check customMetadata tenant ownership when stamped by TASK-007 / TASK-016 workers
    const stampedTenantId = obj.customMetadata?.tenantId?.trim();
    if (stampedTenantId && stampedTenantId !== input.tenantId) {
      return { ok: false, reason: "CROSS_TENANT_OR_INVALID_KEY", candidate: null };
    }
    effectiveBytes = obj.size;
  }

  const candidate = buildOgImageCandidateFromMediaRecord({
    tenantId: input.tenantId,
    media: {
      ...media,
      variants: media.variants
        ? {
            ...media.variants,
            og: {
              ...ogVariant,
              bytes: effectiveBytes,
            },
          }
        : null,
    },
    mediaPublicBaseUrl: input.mediaPublicBaseUrl,
    platformDomain: input.platformDomain,
    fallbackAlt: input.fallbackAlt,
  });

  if (!candidate) {
    return { ok: false, reason: "MISSING_OG_DERIVATIVE", candidate: null };
  }

  return {
    ok: true,
    candidate,
    media,
  };
}

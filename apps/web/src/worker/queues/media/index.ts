import {
  assertTenantR2Key,
  buildMediaDerivativeKeys,
  computeSha256Hex,
  inspectImageBinary,
  MAX_NORMALIZED_MASTER_BYTES,
  MAX_NORMALIZED_MASTER_EDGE_PX,
  MAX_OG_DERIVATIVE_BYTES,
  MAX_SOURCE_UPLOAD_BYTES,
  readBoundedStream,
  slugifyMediaFilename,
  type CloudflareImagesBinding,
  type CloudflareImagesTransformOptions,
  type MediaVariantEntry,
  type MediaVariantsManifest,
} from "@punyasitus/core/media/index";
import { NonRetryableJobError } from "@punyasitus/core/jobs/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  failMediaUploadIntent,
  finalizeProcessedMediaAtomically,
  getMediaItemById,
  getMediaUploadIntent,
  type MediaItemRecord,
} from "@punyasitus/db/media/index";
import {
  releaseExpiredReservations,
  STALE_PROCESSING_TTL_MS,
} from "@punyasitus/db/storage-usage/index";
import type {
  DurableJobHandler,
  DurableJobRegistry,
  DurableQueueEnv,
  JobExecutionContext,
} from "../consumer.ts";
import {
  createBrandAssetsQueueHandler,
  deriveBrandAssetsFromLogo,
  MEDIA_DERIVE_BRAND_ASSETS_TOPIC,
  type DeriveBrandAssetsFromLogoResult,
} from "./brand-assets.ts";

export {
  createBrandAssetsQueueHandler,
  deriveBrandAssetsFromLogo,
  MEDIA_DERIVE_BRAND_ASSETS_TOPIC,
};
export type {
  DeriveBrandAssetsFromLogoInput,
  DeriveBrandAssetsFromLogoResult,
  DeriveBrandAssetsJobPayload,
} from "./brand-assets.ts";

/**
 * Bounded Cloudflare Images derivative queue worker (REQ-010, REQ-039, REQ-064; PLAN §7.2–7.3).
 *
 * Guarantees:
 * - Strict tenant-scoped R2 key guards for both quarantine input and public derivative outputs.
 * - Produces a <= 2,000,000-byte <= 2560px `image/webp` normalized master + `w640`, `w1280`,
 *   `thumb` (400x400), and `og` (1200x630 <= 300 KiB) WebP derivatives with slugified original names.
 * - Always sets `metadata: "none"` and `anim: false` (EXIF/GPS stripped, GIF first frame).
 * - Deletes quarantine original after processing (zero public original fallback).
 * - Strictly idempotent on retry: never double-counts `storage_usage.used_bytes`.
 */

export const MEDIA_PROCESS_IMAGE_TOPIC = "media.process_image" as const;
export const MEDIA_QUARANTINE_SWEEP_TOPIC = "media.quarantine_sweep" as const;

export const DEFAULT_QUARANTINE_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h (PLAN §5, DEC-045)

export interface MediaProcessImageJobPayload {
  readonly intentId: string;
  readonly mediaId: number;
  readonly quarantineR2Key: string;
  readonly originalFilename: string;
  /** Optional asset role: `"logo"` auto-derives unset `32x32`+`180x180` favicons and `1200x630 <=300 KiB` OG (REQ-091). */
  readonly purpose?: "general" | "logo";
}

export interface MediaWorkerR2BucketLike {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list?(options?: R2ListOptions): Promise<R2Objects>;
}

export interface ProcessImageMediaJobDeps {
  readonly tenantId: string;
  readonly tenantDb: D1Database;
  readonly mediaBucket: MediaWorkerR2BucketLike;
  readonly images: CloudflareImagesBinding;
  readonly nowMs?: number;
}

export interface ProcessImageMediaJobResult {
  readonly status: "completed" | "already_ready";
  readonly media: MediaItemRecord;
  readonly quarantineDeleted: boolean;
  readonly brandAssetsDerivation?: DeriveBrandAssetsFromLogoResult | null;
}

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

async function renderWebpVariant(
  images: CloudflareImagesBinding,
  sourceBytes: Uint8Array,
  transform: CloudflareImagesTransformOptions,
  quality: number,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly reason: "TOO_LARGE" | "INVALID_WEBP"; readonly byteLength: number }
> {
  const output = await images
    .input(bytesToReadableStream(sourceBytes))
    .transform({
      ...transform,
      metadata: "none",
      anim: false,
    })
    .output({
      format: "image/webp",
      quality,
    });

  // Read up to maxBytes + 1 so we detect overshoot without unbounded memory growth
  const read = await readBoundedStream(output.image(), maxBytes);
  if (!read.ok) {
    return {
      ok: false,
      reason: read.code === "PAYLOAD_TOO_LARGE" ? "TOO_LARGE" : "INVALID_WEBP",
      byteLength: read.bytesRead,
    };
  }

  const inspected = inspectImageBinary(read.bytes, "image/webp");
  if (!inspected.ok || inspected.mimeType !== "image/webp") {
    return {
      ok: false,
      reason: "INVALID_WEBP",
      byteLength: read.byteLength,
    };
  }

  return {
    ok: true,
    bytes: read.bytes,
    width: inspected.width,
    height: inspected.height,
  };
}

async function renderNormalizedMaster(
  images: CloudflareImagesBinding,
  sourceBytes: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
): Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number }> {
  const attempts: readonly { readonly maxEdge: number; readonly quality: number }[] = [
    { maxEdge: MAX_NORMALIZED_MASTER_EDGE_PX, quality: 82 },
    { maxEdge: MAX_NORMALIZED_MASTER_EDGE_PX, quality: 70 },
    { maxEdge: MAX_NORMALIZED_MASTER_EDGE_PX, quality: 58 },
    { maxEdge: 1920, quality: 50 },
    { maxEdge: 1280, quality: 40 },
  ];

  for (const step of attempts) {
    const targetW = Math.min(sourceWidth, step.maxEdge);
    const targetH = Math.min(sourceHeight, step.maxEdge);
    const rendered = await renderWebpVariant(
      images,
      sourceBytes,
      {
        width: targetW,
        height: targetH,
        fit: "scale-down",
      },
      step.quality,
      MAX_NORMALIZED_MASTER_BYTES,
    );
    if (rendered.ok) {
      return rendered;
    }
    if (rendered.reason === "INVALID_WEBP") {
      throw new NonRetryableJobError(
        "Cloudflare Images binding returned a non-WebP output for normalized master.",
        "E_IMAGES_INVALID_OUTPUT",
      );
    }
  }

  throw new NonRetryableJobError(
    `Normalized master could not fit within ${MAX_NORMALIZED_MASTER_BYTES} bytes.`,
    "E_NORMALIZED_MASTER_TOO_LARGE",
  );
}

async function renderOgDerivative(
  images: CloudflareImagesBinding,
  sourceBytes: Uint8Array,
): Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number }> {
  const qualities = [80, 68, 55, 42] as const;
  for (const quality of qualities) {
    const rendered = await renderWebpVariant(
      images,
      sourceBytes,
      {
        width: 1200,
        height: 630,
        fit: "cover",
      },
      quality,
      MAX_OG_DERIVATIVE_BYTES,
    );
    if (rendered.ok) {
      return rendered;
    }
    if (rendered.reason === "INVALID_WEBP") {
      throw new NonRetryableJobError(
        "Cloudflare Images binding returned a non-WebP output for OG derivative.",
        "E_IMAGES_INVALID_OUTPUT",
      );
    }
  }

  throw new NonRetryableJobError(
    `OG derivative could not fit within ${MAX_OG_DERIVATIVE_BYTES} bytes.`,
    "E_OG_DERIVATIVE_TOO_LARGE",
  );
}

async function safeDeleteR2Keys(
  bucket: MediaWorkerR2BucketLike,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  try {
    await bucket.delete([...keys]);
  } catch {
    // Best-effort cleanup; expired objects are also swept by retention/quarantine cleanup
  }
}

/**
 * Executes a single bounded image normalization & WebP derivative generation job.
 */
export async function processImageMediaJob(
  payload: MediaProcessImageJobPayload,
  deps: ProcessImageMediaJobDeps,
): Promise<ProcessImageMediaJobResult> {
  const nowMs = deps.nowMs ?? Date.now();

  // 1. Validate tenant R2 quarantine key boundary strictly
  try {
    assertTenantR2Key(deps.tenantId, payload.quarantineR2Key, ["quarantine"]);
  } catch {
    throw new NonRetryableJobError(
      "Foreign or malformed quarantine R2 key rejected.",
      "E_FOREIGN_QUARANTINE_KEY",
    );
  }

  // 2. Load media record & verify idempotency BEFORE touching R2 or Cloudflare Images
  const existingMedia = await getMediaItemById(deps.tenantDb, payload.mediaId);
  if (!existingMedia) {
    throw new NonRetryableJobError(
      `Media item #${payload.mediaId} not found in tenant store.`,
      "E_MEDIA_NOT_FOUND",
    );
  }

  if (existingMedia.dbStatus === "ready") {
    // Idempotent retry: guarantee quarantine object is gone, zero double-counting!
    await safeDeleteR2Keys(deps.mediaBucket, [payload.quarantineR2Key]);
    return {
      status: "already_ready",
      media: existingMedia,
      quarantineDeleted: true,
    };
  }

  // Verify the intent matches this media item and quarantine key (rejects forged job payloads)
  const intent = await getMediaUploadIntent(deps.tenantDb, payload.intentId);
  if (!intent || intent.quarantineR2Key !== payload.quarantineR2Key) {
    throw new NonRetryableJobError(
      "Upload intent does not match quarantine R2 key.",
      "E_INTENT_KEY_MISMATCH",
    );
  }

  // 3. Fetch private quarantine source object from R2
  const quarantineObj = await deps.mediaBucket.get(payload.quarantineR2Key);
  if (!quarantineObj) {
    await failMediaUploadIntent(deps.tenantDb, payload.intentId, "QUARANTINE_OBJECT_MISSING", nowMs);
    throw new NonRetryableJobError(
      "Quarantine source object missing from R2.",
      "E_QUARANTINE_OBJECT_MISSING",
    );
  }

  const readSource = await readBoundedStream(quarantineObj.body, MAX_SOURCE_UPLOAD_BYTES);
  if (!readSource.ok) {
    await failMediaUploadIntent(deps.tenantDb, payload.intentId, readSource.code, nowMs);
    await safeDeleteR2Keys(deps.mediaBucket, [payload.quarantineR2Key]);
    throw new NonRetryableJobError(readSource.message, `E_${readSource.code}`);
  }

  // Defense-in-depth binary re-inspection inside worker
  const inspectedSource = inspectImageBinary(readSource.bytes, intent.declaredMime);
  if (!inspectedSource.ok) {
    await failMediaUploadIntent(deps.tenantDb, payload.intentId, inspectedSource.code, nowMs);
    await safeDeleteR2Keys(deps.mediaBucket, [payload.quarantineR2Key]);
    throw new NonRetryableJobError(inspectedSource.message, `E_${inspectedSource.code}`);
  }

  const slug = slugifyMediaFilename(payload.originalFilename || intent.originalFilename);
  const keys = buildMediaDerivativeKeys(deps.tenantId, payload.mediaId, slug);
  const writtenKeys: string[] = [];

  try {
    // 4. Transform via Cloudflare Images binding (metadata: "none", anim: false, WebP only)
    const master = await renderNormalizedMaster(
      deps.images,
      readSource.bytes,
      inspectedSource.width,
      inspectedSource.height,
    );

    const w640 = await renderWebpVariant(
      deps.images,
      readSource.bytes,
      { width: Math.min(master.width, 640), fit: "scale-down" },
      80,
      MAX_NORMALIZED_MASTER_BYTES,
    );
    if (!w640.ok) {
      throw new NonRetryableJobError("Failed to generate w640 WebP derivative.", "E_DERIVATIVE_W640");
    }

    const w1280 = await renderWebpVariant(
      deps.images,
      readSource.bytes,
      { width: Math.min(master.width, 1280), fit: "scale-down" },
      80,
      MAX_NORMALIZED_MASTER_BYTES,
    );
    if (!w1280.ok) {
      throw new NonRetryableJobError(
        "Failed to generate w1280 WebP derivative.",
        "E_DERIVATIVE_W1280",
      );
    }

    const thumb = await renderWebpVariant(
      deps.images,
      readSource.bytes,
      { width: 400, height: 400, fit: "cover" },
      78,
      MAX_NORMALIZED_MASTER_BYTES,
    );
    if (!thumb.ok) {
      throw new NonRetryableJobError(
        "Failed to generate thumb WebP derivative.",
        "E_DERIVATIVE_THUMB",
      );
    }

    const og = await renderOgDerivative(deps.images, readSource.bytes);

    // 5. Store normalized master + all WebP derivatives in R2 under tenant-scoped public keys
    const putOpts = (variant: string): R2PutOptions => ({
      httpMetadata: {
        contentType: "image/webp",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: {
        tenantId: deps.tenantId,
        mediaId: String(payload.mediaId),
        variant,
        exifStripped: "true",
      },
    });

    const outputs: readonly { readonly key: string; readonly name: string; readonly data: Uint8Array }[] =
      [
        { key: keys.master, name: "master", data: master.bytes },
        { key: keys.w640, name: "w640", data: w640.bytes },
        { key: keys.w1280, name: "w1280", data: w1280.bytes },
        { key: keys.thumb, name: "thumb", data: thumb.bytes },
        { key: keys.og, name: "og", data: og.bytes },
      ];

    for (const item of outputs) {
      await deps.mediaBucket.put(item.key, item.data, putOpts(item.name));
      writtenKeys.push(item.key);
    }

    const masterSha256 = await computeSha256Hex(master.bytes);
    const makeEntry = (
      key: string,
      out: { readonly width: number; readonly height: number; readonly bytes: Uint8Array },
    ): MediaVariantEntry => ({
      key,
      width: out.width,
      height: out.height,
      bytes: out.bytes.byteLength,
      mimeType: "image/webp",
    });

    const variants: MediaVariantsManifest = {
      slug,
      master: makeEntry(keys.master, master),
      w640: makeEntry(keys.w640, w640),
      w1280: makeEntry(keys.w1280, w1280),
      thumb: makeEntry(keys.thumb, thumb),
      og: makeEntry(keys.og, og),
    };

    // 6. Atomically finalize media record + reconcile storage_usage (idempotent!)
    const finalized = await finalizeProcessedMediaAtomically(deps.tenantDb, {
      tenantId: deps.tenantId,
      mediaId: payload.mediaId,
      intentId: payload.intentId,
      masterR2Key: keys.master,
      normalizedMasterBytes: master.bytes.byteLength,
      masterSha256,
      masterWidth: master.width,
      masterHeight: master.height,
      variants,
      nowMs,
    });

    if (!finalized.ok) {
      await safeDeleteR2Keys(deps.mediaBucket, writtenKeys);
      await failMediaUploadIntent(deps.tenantDb, payload.intentId, finalized.code, nowMs);
      await safeDeleteR2Keys(deps.mediaBucket, [payload.quarantineR2Key]);
      throw new NonRetryableJobError(finalized.message, `E_${finalized.code}`);
    }

    // 7. Delete quarantine original so NO public original fallback ever exists
    await deps.mediaBucket.delete(payload.quarantineR2Key);

    // 8. When uploaded as site logo, auto-derive unset 32x32+180x180 favicons & <=300 KiB 1200x630 OG (REQ-091)
    let brandAssetsDerivation: DeriveBrandAssetsFromLogoResult | null = null;
    if (payload.purpose === "logo") {
      brandAssetsDerivation = await deriveBrandAssetsFromLogo({
        tenantId: deps.tenantId,
        tenantDb: deps.tenantDb,
        logoMediaId: payload.mediaId,
        originalFilename: payload.originalFilename || intent.originalFilename,
        sourceBytes: master.bytes,
        images: deps.images,
        mediaBucket: deps.mediaBucket,
        nowMs,
      });
    }

    return {
      status: finalized.alreadyReady ? "already_ready" : "completed",
      media: finalized.media,
      quarantineDeleted: true,
      ...(brandAssetsDerivation ? { brandAssetsDerivation } : {}),
    };
  } catch (err) {
    if (err instanceof NonRetryableJobError) {
      await safeDeleteR2Keys(deps.mediaBucket, writtenKeys);
      await failMediaUploadIntent(deps.tenantDb, payload.intentId, err.code, nowMs);
      await safeDeleteR2Keys(deps.mediaBucket, [payload.quarantineR2Key]);
    }
    throw err;
  }
}

export interface CreateMediaQueueHandlerOptions {
  readonly images?: CloudflareImagesBinding;
  readonly mediaBucket?: MediaWorkerR2BucketLike;
  readonly resolveTenantDb?: (tenantId: string, env: DurableQueueEnv) => D1Database;
  readonly maxAttempts?: number;
  readonly leaseDurationMs?: number;
}

function parseMediaJobPayload(ctx: JobExecutionContext): MediaProcessImageJobPayload {
  const raw = ctx.payload;
  const intentId = typeof raw.intentId === "string" ? raw.intentId.trim() : "";
  const mediaId = typeof raw.mediaId === "number" ? raw.mediaId : Number(raw.mediaId);
  const quarantineR2Key =
    typeof raw.quarantineR2Key === "string" ? raw.quarantineR2Key.trim() : "";
  const originalFilename =
    typeof raw.originalFilename === "string" ? raw.originalFilename.trim() : "media";

  if (!intentId || !Number.isInteger(mediaId) || mediaId < 1 || !quarantineR2Key) {
    throw new NonRetryableJobError(
      "Malformed media.process_image job payload.",
      "E_INVALID_MEDIA_JOB_PAYLOAD",
    );
  }
  const purpose = raw.purpose === "logo" ? "logo" : "general";
  return {
    intentId,
    mediaId,
    quarantineR2Key,
    originalFilename,
    purpose,
  };
}

/**
 * Creates a `DurableJobHandler` for `media.process_image` compatible with
 * TASK-028 `processDurableQueueBatch`.
 */
export function createMediaQueueHandler(
  options: CreateMediaQueueHandlerOptions = {},
): DurableJobHandler {
  return {
    maxAttempts: options.maxAttempts ?? 4,
    leaseDurationMs: options.leaseDurationMs ?? 60_000,
    async execute(ctx: JobExecutionContext): Promise<void> {
      const tenantId = ctx.tenantId?.trim();
      if (!tenantId) {
        throw new NonRetryableJobError(
          "media.process_image requires a non-empty tenantId.",
          "E_MISSING_TENANT_ID",
        );
      }
      const payload = parseMediaJobPayload(ctx);

      const mediaBucket =
        options.mediaBucket ?? (ctx.env.MEDIA_BUCKET as MediaWorkerR2BucketLike | undefined);
      if (!mediaBucket) {
        throw new Error("MEDIA_BUCKET binding is unavailable");
      }

      const images =
        options.images ?? (ctx.env.IMAGES as CloudflareImagesBinding | undefined);
      if (!images || typeof images.input !== "function") {
        throw new Error("IMAGES binding is unavailable");
      }

      let tenantDb: D1Database;
      if (options.resolveTenantDb) {
        tenantDb = options.resolveTenantDb(tenantId, ctx.env);
      } else {
        const ns = ctx.env.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined;
        if (!ns) {
          throw new Error("TENANT_STORE binding is unavailable");
        }
        tenantDb = createTenantDb(openTenantStoreStub(ns, tenantId));
      }

      await processImageMediaJob(payload, {
        tenantId,
        tenantDb,
        mediaBucket,
        images,
        nowMs: ctx.nowMs,
      });
    },
  };
}

export interface SweepExpiredQuarantineResult {
  readonly expiredIntentIds: readonly string[];
  readonly staleProcessingIntentIds: readonly string[];
  readonly releasedBytes: number;
  readonly deletedQuarantineKeys: readonly string[];
}

/**
 * Sweeps expired `pending_upload` reservations, stale `uploaded`/`processing` intents,
 * failed/expired quarantine objects, and orphaned R2 quarantine objects older than
 * `quarantineRetentionMs` (default 24h) for a single tenant.
 */
export async function sweepExpiredQuarantineObjects(
  tenantDb: D1Database,
  mediaBucket: MediaWorkerR2BucketLike,
  tenantId: string,
  options?: {
    readonly nowMs?: number;
    readonly quarantineRetentionMs?: number;
    readonly staleProcessingTtlMs?: number;
  },
): Promise<SweepExpiredQuarantineResult> {
  const nowMs = options?.nowMs ?? Date.now();
  const retentionMs = options?.quarantineRetentionMs ?? DEFAULT_QUARANTINE_RETENTION_MS;
  const cutoffMs = nowMs - retentionMs;

  // 1. Release all expired pending_upload + stale uploaded/processing reservations atomically
  const released = await releaseExpiredReservations(tenantDb, nowMs, {
    staleProcessingTtlMs: options?.staleProcessingTtlMs ?? STALE_PROCESSING_TTL_MS,
  });

  const keysToDelete = new Set<string>();
  for (const key of released.quarantineKeys) {
    try {
      assertTenantR2Key(tenantId, key, ["quarantine"]);
      keysToDelete.add(key);
    } catch {
      // Ignore any malformed key
    }
  }

  // 2. Collect failed/expired intent quarantine keys
  const staleIntents = await tenantDb
    .prepare(
      `SELECT quarantine_r2_key FROM media_upload_intents
       WHERE status IN ('failed', 'expired') AND updated_at <= ?`,
    )
    .bind(nowMs)
    .all<{ quarantine_r2_key: string }>();

  for (const row of staleIntents.results) {
    try {
      assertTenantR2Key(tenantId, row.quarantine_r2_key, ["quarantine"]);
      keysToDelete.add(row.quarantine_r2_key);
    } catch {
      // Ignore malformed keys
    }
  }

  // 3. Scan R2 quarantine prefix for abandoned/orphaned objects older than cutoffMs
  const prefix = `t/${tenantId}/quarantine/`;
  if (typeof mediaBucket.list === "function") {
    let cursor: string | undefined;
    for (;;) {
      const listed = await mediaBucket.list({
        prefix,
        cursor,
        include: ["customMetadata"],
      });
      for (const obj of listed.objects) {
        try {
          assertTenantR2Key(tenantId, obj.key, ["quarantine"]);
        } catch {
          continue;
        }
        const metaTs = Number(obj.customMetadata?.quarantinedAtMs ?? "");
        const ts = Number.isFinite(metaTs) && metaTs > 0 ? metaTs : obj.uploaded.getTime();
        if (ts <= cutoffMs) {
          keysToDelete.add(obj.key);
        }
      }
      if (!listed.truncated || !listed.cursor) break;
      cursor = listed.cursor;
    }
  }

  const deletedKeys = [...keysToDelete];
  if (deletedKeys.length > 0) {
    await mediaBucket.delete(deletedKeys);
  }

  return {
    expiredIntentIds: released.expiredIntentIds,
    staleProcessingIntentIds: released.staleProcessingIntentIds,
    releasedBytes: released.releasedBytes,
    deletedQuarantineKeys: deletedKeys,
  };
}

export interface SweepAllTenantsQuarantineSummary {
  readonly tenantsSwept: number;
  readonly totalReleasedBytes: number;
  readonly totalDeletedKeys: number;
}

/**
 * Safely iterates over all active/migrated tenants in `PLATFORM_DB` and runs
 * `sweepExpiredQuarantineObjects` per tenant. Idempotent and safe to invoke from
 * the Worker's hourly `scheduled()` cron handler even on fresh/empty environments.
 */
export async function sweepAllTenantsExpiredQuarantine(
  env: DurableQueueEnv,
  options?: {
    readonly nowMs?: number;
    readonly pageSize?: number;
    readonly quarantineRetentionMs?: number;
    readonly staleProcessingTtlMs?: number;
    readonly mediaBucket?: MediaWorkerR2BucketLike;
    readonly resolveTenantDb?: (tenantId: string, env: DurableQueueEnv) => D1Database;
  },
): Promise<SweepAllTenantsQuarantineSummary> {
  const mediaBucket =
    options?.mediaBucket ?? (env.MEDIA_BUCKET as MediaWorkerR2BucketLike | undefined);
  const tenantNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined;
  if (!mediaBucket || (!tenantNs && !options?.resolveTenantDb)) {
    return { tenantsSwept: 0, totalReleasedBytes: 0, totalDeletedKeys: 0 };
  }

  const nowMs = options?.nowMs ?? Date.now();
  const pageSize = Math.max(1, options?.pageSize ?? 100);
  let afterId = "";
  let tenantsSwept = 0;
  let totalReleasedBytes = 0;
  let totalDeletedKeys = 0;

  for (;;) {
    let rows: readonly { id: string }[];
    try {
      const res = await env.PLATFORM_DB.prepare(
        `SELECT id FROM tenants
         WHERE status NOT IN ('provisioning', 'purged')
           AND schema_version >= 1
           AND id > ?
         ORDER BY id ASC
         LIMIT ?`,
      )
        .bind(afterId, pageSize)
        .all<{ id: string }>();
      rows = res.results;
    } catch {
      // Fresh/unmigrated platform DB -> skip safely without failing cron tick
      break;
    }

    if (rows.length === 0) break;

    for (const row of rows) {
      const tenantDb = options?.resolveTenantDb
        ? options.resolveTenantDb(row.id, env)
        : createTenantDb(openTenantStoreStub(tenantNs!, row.id));
      const swept = await sweepExpiredQuarantineObjects(tenantDb, mediaBucket, row.id, {
        nowMs,
        quarantineRetentionMs: options?.quarantineRetentionMs,
        staleProcessingTtlMs: options?.staleProcessingTtlMs,
      });
      tenantsSwept += 1;
      totalReleasedBytes += swept.releasedBytes;
      totalDeletedKeys += swept.deletedQuarantineKeys.length;
    }

    afterId = rows[rows.length - 1]!.id;
    if (rows.length < pageSize) break;
  }

  return { tenantsSwept, totalReleasedBytes, totalDeletedKeys };
}

export function createMediaQuarantineSweepQueueHandler(
  options: CreateMediaQueueHandlerOptions = {},
): DurableJobHandler {
  return {
    maxAttempts: options.maxAttempts ?? 3,
    leaseDurationMs: options.leaseDurationMs ?? 60_000,
    async execute(ctx: JobExecutionContext): Promise<void> {
      const nowMs =
        typeof ctx.payload.nowMs === "number" && Number.isFinite(ctx.payload.nowMs)
          ? ctx.payload.nowMs
          : ctx.nowMs;
      await sweepAllTenantsExpiredQuarantine(ctx.env, {
        nowMs,
        mediaBucket: options.mediaBucket,
        resolveTenantDb: options.resolveTenantDb,
      });
    },
  };
}

/**
 * Builds the media job handler registry wired into `apps/web/src/worker/index.ts`.
 */
export function createMediaJobRegistry(
  options: CreateMediaQueueHandlerOptions = {},
): DurableJobRegistry {
  return {
    [MEDIA_PROCESS_IMAGE_TOPIC]: createMediaQueueHandler(options),
    [MEDIA_QUARANTINE_SWEEP_TOPIC]: createMediaQuarantineSweepQueueHandler(options),
    [MEDIA_DERIVE_BRAND_ASSETS_TOPIC]: createBrandAssetsQueueHandler(options),
  };
}

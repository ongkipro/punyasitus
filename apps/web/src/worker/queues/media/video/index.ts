import { NonRetryableJobError } from "@punyasitus/core/jobs/index";
import {
  assertTenantR2Key,
  computeSha256Hex,
  inspectImageBinary,
  MAX_NORMALIZED_MASTER_BYTES,
  readBoundedStream,
  slugifyMediaFilename,
  type CloudflareImagesBinding,
} from "@punyasitus/core/media/index";
import {
  buildVideoDerivativeKeys,
  getDefaultVideoPosterWebpBytes,
  inspectVideoBinary,
  MAX_POSTER_UPLOAD_BYTES,
  MAX_VIDEO_FPS_TOLERANCE,
  MAX_VIDEO_HEIGHT,
  MAX_VIDEO_UPLOAD_BYTES,
  MAX_VIDEO_WIDTH,
  rewriteMp4FastStartAndStripMetadata,
  type VideoMetadataManifest,
} from "@punyasitus/core/media/video";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import type { MediaItemRecord } from "@punyasitus/db/media/index";
import {
  failVideoUploadIntent,
  finalizeProcessedVideoAtomically,
  getVideoMediaItemById,
  getVideoUploadIntentById,
} from "@punyasitus/db/media/video";
import type {
  DurableJobHandler,
  DurableJobRegistry,
  DurableQueueEnv,
  JobExecutionContext,
} from "../../consumer.ts";
import type { MediaWorkerR2BucketLike } from "../index.ts";
import {
  buildBoundedTranscodeRequest,
  createContainerVideoTranscoderAdapter,
  type ContainerFetcherLike,
  type VideoTranscoderContainerBinding,
} from "./transcoder.ts";

export {
  buildBoundedTranscodeRequest,
  createContainerVideoTranscoderAdapter,
  VIDEO_TRANSCODER_CONCURRENCY,
  VIDEO_TRANSCODER_DEFAULT_TIMEOUT_MS,
  type ContainerFetcherLike,
  type VideoTranscodeRequestOptions,
  type VideoTranscodeResponsePayload,
  type VideoTranscoderContainerBinding,
} from "./transcoder.ts";

/**
 * Bounded Short Video Processing Queue Worker (REQ-062, REQ-039, REQ-040, REQ-064;
 * PLAN §7.2–7.3; TASK-060).
 *
 * Dual-path processing contract:
 * 1. Already-compliant H.264/AAC MP4 -> pure-JS Worker fast-start (`moov` before `mdat`)
 *    & metadata-strip (`udta`/`meta`/`uuid`) box rewrite. Zero native binaries, zero container calls.
 * 2. MOV / WebM / non-H.264/AAC MP4 -> invokes bounded scale-to-zero `VideoTranscoder`
 *    Cloudflare Container (`ffmpeg`, concurrency 1, no upscaling, metadata stripped, poster extracted).
 * 3. Poster output is ALWAYS `image/webp` (from client-captured frame, container-extracted frame
 *    converted via Cloudflare Images binding, or valid built-in WebP default poster).
 * 4. Deletes quarantine source object(s) after atomic finalize so zero public source exists before ready.
 * 5. Strictly idempotent on retry: never double-counts `storage_usage.used_bytes`.
 */

export const MEDIA_PROCESS_VIDEO_TOPIC = "media.process_video" as const;

export interface MediaProcessVideoJobPayload {
  readonly intentId: string;
  readonly mediaId: number;
  readonly quarantineR2Key: string;
  readonly originalFilename: string;
  readonly posterQuarantineR2Key?: string | null;
}

export interface ProcessVideoMediaJobDeps {
  readonly tenantId: string;
  readonly tenantDb: D1Database;
  readonly mediaBucket: MediaWorkerR2BucketLike;
  readonly images?: CloudflareImagesBinding | null;
  readonly videoTranscoder?: VideoTranscoderContainerBinding | null;
  readonly nowMs?: number;
}

export interface ProcessVideoMediaJobResult {
  readonly status: "completed" | "already_ready";
  readonly processingPath: "worker_faststart" | "container_transcode";
  readonly transcoderInvoked: boolean;
  readonly posterSource: "client_frame" | "container_frame" | "default";
  readonly media: MediaItemRecord;
  readonly quarantineDeleted: boolean;
}

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

async function safeDeleteR2Keys(
  bucket: MediaWorkerR2BucketLike,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  try {
    await bucket.delete([...keys]);
  } catch {
    // Best-effort cleanup; quarantine sweeper handles orphans
  }
}

async function convertPosterBytesToWebp(
  rawPosterBytes: Uint8Array,
  declaredMime: string | undefined,
  images: CloudflareImagesBinding | null | undefined,
): Promise<Uint8Array | null> {
  const inspected = inspectImageBinary(rawPosterBytes, declaredMime);
  if (!inspected.ok) {
    return null;
  }

  if (images && typeof images.input === "function") {
    const out = await images
      .input(bytesToReadableStream(rawPosterBytes))
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
    if (!read.ok) return null;
    const verified = inspectImageBinary(read.bytes, "image/webp");
    if (!verified.ok || verified.mimeType !== "image/webp") return null;
    return read.bytes;
  }

  // If no Images binding is provided and the bytes are already verified WebP, use them directly
  if (inspected.mimeType === "image/webp") {
    return rawPosterBytes;
  }

  return null;
}

async function resolveVideoPosterWebp(params: {
  readonly tenantId: string;
  readonly posterQuarantineR2Key?: string | null;
  readonly extractedPosterBytes?: Uint8Array | null;
  readonly extractedPosterMime?: string | null;
  readonly mediaBucket: MediaWorkerR2BucketLike;
  readonly images?: CloudflareImagesBinding | null;
}): Promise<{ readonly bytes: Uint8Array; readonly source: "client_frame" | "container_frame" | "default" }> {
  // 1. Prefer client-captured poster frame if present in tenant quarantine
  if (params.posterQuarantineR2Key) {
    assertTenantR2Key(params.tenantId, params.posterQuarantineR2Key, ["quarantine"]);
    const posterObj = await params.mediaBucket.get(params.posterQuarantineR2Key);
    if (posterObj) {
      const bounded = await readBoundedStream(posterObj.body, MAX_POSTER_UPLOAD_BYTES);
      if (bounded.ok) {
        const converted = await convertPosterBytesToWebp(
          bounded.bytes,
          posterObj.httpMetadata?.contentType,
          params.images,
        );
        if (converted) {
          return { bytes: converted, source: "client_frame" };
        }
      }
    }
  }

  // 2. Fallback to container-extracted poster frame converted to WebP via Images binding
  if (params.extractedPosterBytes && params.extractedPosterBytes.byteLength > 0) {
    const converted = await convertPosterBytesToWebp(
      params.extractedPosterBytes,
      params.extractedPosterMime ?? undefined,
      params.images,
    );
    if (converted) {
      return { bytes: converted, source: "container_frame" };
    }
  }

  // 3. Always guarantee a valid `image/webp` default poster
  return {
    bytes: getDefaultVideoPosterWebpBytes(),
    source: "default",
  };
}

/**
 * Executes a single bounded short-video processing job.
 */
export async function processVideoMediaJob(
  payload: MediaProcessVideoJobPayload,
  deps: ProcessVideoMediaJobDeps,
): Promise<ProcessVideoMediaJobResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const quarantineKeysToClean = [payload.quarantineR2Key];
  if (payload.posterQuarantineR2Key) {
    quarantineKeysToClean.push(payload.posterQuarantineR2Key);
  }

  // 1. Strict tenant R2 quarantine key boundary guard
  try {
    assertTenantR2Key(deps.tenantId, payload.quarantineR2Key, ["quarantine"]);
    if (payload.posterQuarantineR2Key) {
      assertTenantR2Key(deps.tenantId, payload.posterQuarantineR2Key, ["quarantine"]);
    }
  } catch {
    throw new NonRetryableJobError(
      "Foreign or malformed quarantine R2 key rejected.",
      "E_FOREIGN_QUARANTINE_KEY",
    );
  }

  // 2. Load media item & enforce idempotency BEFORE touching R2 or transcoder
  const existingMedia = await getVideoMediaItemById(deps.tenantDb, payload.mediaId);
  if (!existingMedia || existingMedia.kind !== "video") {
    throw new NonRetryableJobError(
      `Video media item #${payload.mediaId} not found in tenant store.`,
      "E_MEDIA_NOT_FOUND",
    );
  }

  if (existingMedia.dbStatus === "ready") {
    await safeDeleteR2Keys(deps.mediaBucket, quarantineKeysToClean);
    return {
      status: "already_ready",
      processingPath: existingMedia.videoMetadata?.processingPath ?? "worker_faststart",
      transcoderInvoked: false,
      posterSource: existingMedia.videoMetadata?.posterSource ?? "default",
      media: existingMedia,
      quarantineDeleted: true,
    };
  }

  // 3. Verify upload intent matches quarantine key & kind === 'video'
  const intent = await getVideoUploadIntentById(deps.tenantDb, payload.intentId);
  if (!intent || intent.kind !== "video" || intent.quarantineR2Key !== payload.quarantineR2Key) {
    throw new NonRetryableJobError(
      "Video upload intent does not match quarantine R2 key.",
      "E_INTENT_KEY_MISMATCH",
    );
  }

  // 4. Fetch private quarantine source video from R2 through hard 10,000,000-byte counter
  const quarantineObj = await deps.mediaBucket.get(payload.quarantineR2Key);
  if (!quarantineObj) {
    await failVideoUploadIntent(deps.tenantDb, payload.intentId, "QUARANTINE_OBJECT_MISSING", nowMs);
    throw new NonRetryableJobError(
      "Quarantine video object missing from R2.",
      "E_QUARANTINE_OBJECT_MISSING",
    );
  }

  const readSource = await readBoundedStream(quarantineObj.body, MAX_VIDEO_UPLOAD_BYTES);
  if (!readSource.ok) {
    await failVideoUploadIntent(deps.tenantDb, payload.intentId, readSource.code, nowMs);
    await safeDeleteR2Keys(deps.mediaBucket, quarantineKeysToClean);
    throw new NonRetryableJobError(readSource.message, `E_${readSource.code}`);
  }

  // 5. Defense-in-depth binary inspection inside Worker
  const inspectedSource = inspectVideoBinary(readSource.bytes, intent.declaredMime);
  if (!inspectedSource.ok) {
    await failVideoUploadIntent(deps.tenantDb, payload.intentId, inspectedSource.code, nowMs);
    await safeDeleteR2Keys(deps.mediaBucket, quarantineKeysToClean);
    throw new NonRetryableJobError(inspectedSource.message, `E_${inspectedSource.code}`);
  }

  const slug = slugifyMediaFilename(payload.originalFilename || intent.originalFilename);
  const keys = buildVideoDerivativeKeys(deps.tenantId, payload.mediaId, slug);
  const writtenKeys: string[] = [];

  try {
    let finalMp4Bytes: Uint8Array;
    let finalWidth = inspectedSource.width;
    let finalHeight = inspectedSource.height;
    let finalFps = inspectedSource.fps;
    let finalDuration = inspectedSource.durationSeconds;
    let finalVideoCodec = inspectedSource.videoCodec;
    let finalAudioCodec = inspectedSource.audioCodec;
    let transcoderInvoked = false;
    let extractedPosterBytes: Uint8Array | null = null;
    let extractedPosterMime: string | null = null;

    if (inspectedSource.processingPath === "worker_faststart") {
      // Path A: Pure-JS fast-start (moov before mdat) & metadata-strip box rewrite in Worker!
      const rewritten = rewriteMp4FastStartAndStripMetadata(readSource.bytes);
      if (!rewritten.ok) {
        throw new NonRetryableJobError(rewritten.message, `E_${rewritten.code}`);
      }
      finalMp4Bytes = rewritten.bytes;
    } else {
      // Path B: MOV / WebM / non-H.264/AAC -> bounded scale-to-zero VideoTranscoder Container
      if (!deps.videoTranscoder) {
        // Fail fast (non-retryable) when Cloudflare Container binding is not provisioned:
        // marks media_items & intent failed with VIDEO_TRANSCODER_UNAVAILABLE, deletes quarantine,
        // releases reserved bytes, and never loops until DLQ!
        throw new NonRetryableJobError(
          "Konversi MOV/WebM membutuhkan layanan transkode yang belum aktif; unggah MP4 H.264/AAC.",
          "VIDEO_TRANSCODER_UNAVAILABLE",
        );
      }

      const transcodeReq = buildBoundedTranscodeRequest({
        tenantId: deps.tenantId,
        mediaId: payload.mediaId,
        sourceFormat: inspectedSource.format,
        sourceMimeType: inspectedSource.mimeType,
        sourceBytes: readSource.bytes,
        sourceWidth: inspectedSource.width,
        sourceHeight: inspectedSource.height,
        sourceFps: inspectedSource.fps,
        extractPoster: !payload.posterQuarantineR2Key,
      });

      transcoderInvoked = true;
      const transcoded = await deps.videoTranscoder.transcode(transcodeReq);

      if (transcoded.mp4Bytes.byteLength === 0 || transcoded.mp4Bytes.byteLength > MAX_VIDEO_UPLOAD_BYTES) {
        throw new NonRetryableJobError(
          `Transcoded MP4 output (${transcoded.mp4Bytes.byteLength} bytes) violates size bounds.`,
          "E_TRANSCODE_OUTPUT_TOO_LARGE",
        );
      }

      // Verify transcoded output strictly obeys H.264/AAC MP4, NO upscaling, <= 1920x1080, <= 60 fps
      const inspectedOut = inspectVideoBinary(transcoded.mp4Bytes, "video/mp4");
      if (!inspectedOut.ok || !inspectedOut.isCompliantH264AacMp4) {
        throw new NonRetryableJobError(
          "VideoTranscoder output failed H.264/AAC MP4 verification.",
          "E_TRANSCODE_INVALID_OUTPUT",
        );
      }

      if (
        inspectedOut.width > inspectedSource.width ||
        inspectedOut.height > inspectedSource.height ||
        inspectedOut.width > MAX_VIDEO_WIDTH ||
        inspectedOut.height > MAX_VIDEO_HEIGHT
      ) {
        throw new NonRetryableJobError(
          `VideoTranscoder upscaled output (${inspectedOut.width}x${inspectedOut.height}) above source (${inspectedSource.width}x${inspectedSource.height}).`,
          "E_TRANSCODE_UPSCALE_VIOLATION",
        );
      }

      if (inspectedOut.fps > MAX_VIDEO_FPS_TOLERANCE) {
        throw new NonRetryableJobError(
          `VideoTranscoder output fps (${inspectedOut.fps}) exceeds 60 fps.`,
          "E_TRANSCODE_FPS_VIOLATION",
        );
      }

      // Guarantee fast-start + metadata strip on container output too
      const normalizedOut = rewriteMp4FastStartAndStripMetadata(transcoded.mp4Bytes);
      if (!normalizedOut.ok) {
        throw new NonRetryableJobError(normalizedOut.message, `E_${normalizedOut.code}`);
      }

      finalMp4Bytes = normalizedOut.bytes;
      finalWidth = inspectedOut.width;
      finalHeight = inspectedOut.height;
      finalFps = inspectedOut.fps;
      finalDuration = transcoded.durationSeconds ?? inspectedOut.durationSeconds ?? inspectedSource.durationSeconds;
      finalVideoCodec = inspectedOut.videoCodec;
      finalAudioCodec = inspectedOut.audioCodec;
      extractedPosterBytes = transcoded.posterBytes ?? null;
      extractedPosterMime = transcoded.posterMimeType ?? null;
    }

    // 6. Produce guaranteed `image/webp` poster (client frame -> container frame -> default WebP)
    const poster = await resolveVideoPosterWebp({
      tenantId: deps.tenantId,
      posterQuarantineR2Key: payload.posterQuarantineR2Key,
      extractedPosterBytes,
      extractedPosterMime,
      mediaBucket: deps.mediaBucket,
      images: deps.images,
    });

    // 7. Write processed MP4 + WebP poster to tenant-scoped public R2 keys
    await deps.mediaBucket.put(keys.video, finalMp4Bytes, {
      httpMetadata: {
        contentType: "video/mp4",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: {
        tenantId: deps.tenantId,
        mediaId: String(payload.mediaId),
        processingPath: inspectedSource.processingPath,
        moovBeforeMdat: "true",
        metadataStripped: "true",
      },
    });
    writtenKeys.push(keys.video);

    await deps.mediaBucket.put(keys.poster, poster.bytes, {
      httpMetadata: {
        contentType: "image/webp",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: {
        tenantId: deps.tenantId,
        mediaId: String(payload.mediaId),
        posterSource: poster.source,
      },
    });
    writtenKeys.push(keys.poster);

    const videoSha256 = await computeSha256Hex(finalMp4Bytes);
    const manifest: VideoMetadataManifest = {
      kind: "video",
      slug,
      videoCodec: finalVideoCodec,
      audioCodec: finalAudioCodec,
      fps: finalFps,
      processingPath: inspectedSource.processingPath,
      moovBeforeMdat: true,
      metadataStripped: true,
      posterSource: poster.source,
      posterMimeType: "image/webp",
    };

    // 8. Atomically finalize media record + reconcile storage_usage (idempotent!)
    const finalized = await finalizeProcessedVideoAtomically(deps.tenantDb, {
      tenantId: deps.tenantId,
      mediaId: payload.mediaId,
      intentId: payload.intentId,
      videoR2Key: keys.video,
      posterR2Key: keys.poster,
      processedVideoBytes: finalMp4Bytes.byteLength,
      videoSha256,
      width: finalWidth,
      height: finalHeight,
      durationSeconds: finalDuration,
      manifest,
      nowMs,
    });

    if (!finalized.ok) {
      await safeDeleteR2Keys(deps.mediaBucket, writtenKeys);
      await failVideoUploadIntent(deps.tenantDb, payload.intentId, finalized.code, nowMs);
      await safeDeleteR2Keys(deps.mediaBucket, quarantineKeysToClean);
      throw new NonRetryableJobError(finalized.message, `E_${finalized.code}`);
    }

    // 9. Remove quarantine source(s) so NO public original fallback ever exists
    await safeDeleteR2Keys(deps.mediaBucket, quarantineKeysToClean);

    return {
      status: finalized.alreadyReady ? "already_ready" : "completed",
      processingPath: inspectedSource.processingPath,
      transcoderInvoked,
      posterSource: poster.source,
      media: finalized.media,
      quarantineDeleted: true,
    };
  } catch (err) {
    if (err instanceof NonRetryableJobError) {
      await safeDeleteR2Keys(deps.mediaBucket, writtenKeys);
      await failVideoUploadIntent(deps.tenantDb, payload.intentId, err.code, nowMs);
      await safeDeleteR2Keys(deps.mediaBucket, quarantineKeysToClean);
    }
    throw err;
  }
}

export interface CreateVideoQueueHandlerOptions {
  readonly images?: CloudflareImagesBinding | null;
  readonly mediaBucket?: MediaWorkerR2BucketLike;
  readonly videoTranscoder?: VideoTranscoderContainerBinding | null;
  readonly resolveTenantDb?: (tenantId: string, env: DurableQueueEnv) => D1Database;
  readonly maxAttempts?: number;
  readonly leaseDurationMs?: number;
}

function parseVideoJobPayload(ctx: JobExecutionContext): MediaProcessVideoJobPayload {
  const raw = ctx.payload;
  const intentId = typeof raw.intentId === "string" ? raw.intentId.trim() : "";
  const mediaId = typeof raw.mediaId === "number" ? raw.mediaId : Number(raw.mediaId);
  const quarantineR2Key =
    typeof raw.quarantineR2Key === "string" ? raw.quarantineR2Key.trim() : "";
  const originalFilename =
    typeof raw.originalFilename === "string" ? raw.originalFilename.trim() : "video";
  const posterQuarantineR2Key =
    typeof raw.posterQuarantineR2Key === "string" && raw.posterQuarantineR2Key.trim()
      ? raw.posterQuarantineR2Key.trim()
      : null;

  if (!intentId || !Number.isInteger(mediaId) || mediaId < 1 || !quarantineR2Key) {
    throw new NonRetryableJobError(
      "Malformed media.process_video job payload.",
      "E_INVALID_VIDEO_JOB_PAYLOAD",
    );
  }
  return {
    intentId,
    mediaId,
    quarantineR2Key,
    originalFilename,
    posterQuarantineR2Key,
  };
}

export function createVideoQueueHandler(
  options: CreateVideoQueueHandlerOptions = {},
): DurableJobHandler {
  return {
    maxAttempts: options.maxAttempts ?? 4,
    leaseDurationMs: options.leaseDurationMs ?? 90_000,
    async execute(ctx: JobExecutionContext): Promise<void> {
      const tenantId = ctx.tenantId?.trim();
      if (!tenantId) {
        throw new NonRetryableJobError(
          "media.process_video requires a non-empty tenantId.",
          "E_MISSING_TENANT_ID",
        );
      }

      const payload = parseVideoJobPayload(ctx);
      const mediaBucket =
        options.mediaBucket ?? (ctx.env.MEDIA_BUCKET as MediaWorkerR2BucketLike | undefined);
      if (!mediaBucket) {
        throw new Error("MEDIA_BUCKET binding is unavailable");
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

      const images =
        options.images !== undefined
          ? options.images
          : ((ctx.env.IMAGES as CloudflareImagesBinding | undefined) ?? null);

      let videoTranscoder: VideoTranscoderContainerBinding | null = null;
      if (options.videoTranscoder !== undefined) {
        videoTranscoder = options.videoTranscoder;
      } else {
        const rawBinding = (ctx.env as Record<string, unknown>).VIDEO_TRANSCODER;
        if (rawBinding && typeof rawBinding === "object") {
          if (typeof (rawBinding as VideoTranscoderContainerBinding).transcode === "function") {
            videoTranscoder = rawBinding as VideoTranscoderContainerBinding;
          } else if (typeof (rawBinding as ContainerFetcherLike).fetch === "function") {
            videoTranscoder = createContainerVideoTranscoderAdapter(
              rawBinding as ContainerFetcherLike,
            );
          }
        }
      }

      await processVideoMediaJob(payload, {
        tenantId,
        tenantDb,
        mediaBucket,
        images,
        videoTranscoder,
        nowMs: ctx.nowMs,
      });
    },
  };
}

/**
 * Builds the short-video durable job registry ready to spread into `WORKER_JOB_REGISTRY`.
 */
export function createVideoJobRegistry(
  options: CreateVideoQueueHandlerOptions = {},
): DurableJobRegistry {
  return {
    [MEDIA_PROCESS_VIDEO_TOPIC]: createVideoQueueHandler(options),
  };
}

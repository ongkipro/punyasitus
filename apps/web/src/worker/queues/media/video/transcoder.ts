import {
  MAX_VIDEO_FPS,
  MAX_VIDEO_HEIGHT,
  MAX_VIDEO_UPLOAD_BYTES,
  MAX_VIDEO_WIDTH,
  type VideoContainerFormat,
} from "@punyasitus/core/media/video";

/**
 * Bounded, scale-to-zero `VideoTranscoder` Cloudflare Container adapter interface
 * (REQ-062, ADR-0009; PLAN §7.3; TASK-060).
 *
 * Invariants:
 * - Used ONLY for MOV, WebM, or non-H.264/AAC MP4 inputs (never for already-compliant
 *   H.264/AAC MP4, which runs the pure-JS Worker fast-start box rewriter instead).
 * - Strictly single-flight (`concurrency: 1`) and bounded in output size (`<= 10,000,000` bytes),
 *   resolution (NEVER upscales above source dimensions, capped at `1920x1080`), frame rate
 *   (`<= 60 fps`), metadata stripping (`stripMetadata: true`), and poster extraction.
 * - Cleanly mockable in `workerd` integration tests without calling external live services.
 */

export const VIDEO_TRANSCODER_CONCURRENCY = 1 as const;
export const VIDEO_TRANSCODER_DEFAULT_TIMEOUT_MS = 45_000 as const;

export interface VideoTranscodeRequestOptions {
  readonly tenantId: string;
  readonly mediaId: number;
  readonly sourceFormat: VideoContainerFormat;
  readonly sourceMimeType: string;
  readonly sourceBytes: Uint8Array;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly sourceFps: number;
  /** Output width ceiling — always `<= min(sourceWidth, 1920)` (no upscaling!). */
  readonly maxWidth: number;
  /** Output height ceiling — always `<= min(sourceHeight, 1080)` (no upscaling!). */
  readonly maxHeight: number;
  readonly maxFps: number;
  readonly maxOutputBytes: number;
  readonly noUpscale: true;
  readonly stripMetadata: true;
  readonly extractPoster: boolean;
  readonly targetContainer: "mp4";
  readonly targetVideoCodec: "h264";
  readonly targetAudioCodec: "aac";
  readonly timeoutMs: number;
}

export interface VideoTranscodeResponsePayload {
  readonly mp4Bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSeconds: number | null;
  readonly metadataStripped: boolean;
  /** Extracted poster frame bytes (WebP, PNG, or JPEG — normalized to WebP via Images binding). */
  readonly posterBytes?: Uint8Array | null;
  readonly posterMimeType?: "image/webp" | "image/png" | "image/jpeg" | null;
}

export interface VideoTranscoderContainerBinding {
  readonly name: string;
  readonly concurrency: 1;
  transcode(request: VideoTranscodeRequestOptions): Promise<VideoTranscodeResponsePayload>;
}

export interface ContainerFetcherLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Builds canonical bounded transcode options guaranteeing zero upscaling and full
 * metadata stripping for the `VideoTranscoder` Cloudflare Container (`ffmpeg`).
 */
export function buildBoundedTranscodeRequest(input: {
  readonly tenantId: string;
  readonly mediaId: number;
  readonly sourceFormat: VideoContainerFormat;
  readonly sourceMimeType: string;
  readonly sourceBytes: Uint8Array;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly sourceFps: number;
  readonly extractPoster: boolean;
  readonly timeoutMs?: number;
}): VideoTranscodeRequestOptions {
  return {
    tenantId: input.tenantId,
    mediaId: input.mediaId,
    sourceFormat: input.sourceFormat,
    sourceMimeType: input.sourceMimeType,
    sourceBytes: input.sourceBytes,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    sourceFps: input.sourceFps,
    maxWidth: Math.max(1, Math.min(input.sourceWidth, MAX_VIDEO_WIDTH)),
    maxHeight: Math.max(1, Math.min(input.sourceHeight, MAX_VIDEO_HEIGHT)),
    maxFps: Math.max(1, Math.min(input.sourceFps, MAX_VIDEO_FPS)),
    maxOutputBytes: MAX_VIDEO_UPLOAD_BYTES,
    noUpscale: true,
    stripMetadata: true,
    extractPoster: input.extractPoster,
    targetContainer: "mp4",
    targetVideoCodec: "h264",
    targetAudioCodec: "aac",
    timeoutMs: Math.min(
      Math.max(1_000, input.timeoutMs ?? VIDEO_TRANSCODER_DEFAULT_TIMEOUT_MS),
      60_000,
    ),
  };
}

/**
 * Production Cloudflare Container HTTP adapter wrapping a Container binding's `Fetcher`.
 * Enforces single-flight execution (`concurrency: 1`) and strict timeout/header contracts.
 */
export function createContainerVideoTranscoderAdapter(
  fetcher: ContainerFetcherLike,
  options?: { readonly endpointUrl?: string },
): VideoTranscoderContainerBinding {
  const endpointUrl = options?.endpointUrl ?? "http://video-transcoder.internal/transcode";
  let inFlight: Promise<unknown> = Promise.resolve();

  return {
    name: "VideoTranscoder",
    concurrency: VIDEO_TRANSCODER_CONCURRENCY,
    async transcode(request: VideoTranscodeRequestOptions): Promise<VideoTranscodeResponsePayload> {
      const run = async (): Promise<VideoTranscodeResponsePayload> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), request.timeoutMs);
        try {
          const bodyCopy = new Uint8Array(request.sourceBytes.byteLength);
          bodyCopy.set(request.sourceBytes);

          const res = await fetcher.fetch(endpointUrl, {
            method: "POST",
            headers: {
              "Content-Type": request.sourceMimeType,
              "X-Tenant-Id": request.tenantId,
              "X-Media-Id": String(request.mediaId),
              "X-Source-Format": request.sourceFormat,
              "X-Max-Width": String(request.maxWidth),
              "X-Max-Height": String(request.maxHeight),
              "X-Max-Fps": String(request.maxFps),
              "X-Max-Output-Bytes": String(request.maxOutputBytes),
              "X-No-Upscale": "true",
              "X-Strip-Metadata": "true",
              "X-Extract-Poster": request.extractPoster ? "true" : "false",
            },
            body: bodyCopy,
            signal: controller.signal,
          });

          if (!res.ok) {
            throw new Error(`VideoTranscoder container returned HTTP ${res.status}`);
          }

          const mp4Buffer = await res.arrayBuffer();
          const mp4Bytes = new Uint8Array(mp4Buffer);
          const width = Number(res.headers.get("x-output-width") ?? request.maxWidth);
          const height = Number(res.headers.get("x-output-height") ?? request.maxHeight);
          const fps = Number(res.headers.get("x-output-fps") ?? request.maxFps);
          const rawDuration = res.headers.get("x-output-duration-seconds");
          const durationSeconds =
            rawDuration !== null && Number.isFinite(Number(rawDuration))
              ? Number(rawDuration)
              : null;

          const posterBase64 = res.headers.get("x-output-poster-base64");
          let posterBytes: Uint8Array | null = null;
          if (posterBase64) {
            const bin = atob(posterBase64);
            posterBytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) {
              posterBytes[i] = bin.charCodeAt(i);
            }
          }

          return {
            mp4Bytes,
            width: Number.isFinite(width) ? Math.floor(width) : request.maxWidth,
            height: Number.isFinite(height) ? Math.floor(height) : request.maxHeight,
            fps: Number.isFinite(fps) ? fps : request.maxFps,
            durationSeconds,
            metadataStripped: res.headers.get("x-metadata-stripped") !== "false",
            posterBytes,
            posterMimeType: posterBytes
              ? ((res.headers.get("x-output-poster-mime") as "image/webp" | "image/png" | "image/jpeg" | null) ??
                "image/webp")
              : null,
          };
        } finally {
          clearTimeout(timer);
        }
      };

      // Strictly serialize container transcode jobs (concurrency = 1)
      const next = inFlight.then(run, run);
      inFlight = next.catch(() => undefined);
      return next;
    },
  };
}

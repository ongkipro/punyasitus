import {
  ELIGIBLE_VIDEO_MIMES,
  MAX_CAPTION_VTT_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  MAX_VIDEOS_PER_TENANT,
  validateAndSanitizeWebVtt,
  type EligibleVideoMime,
} from "@punyasitus/core/media/video";
import { computeBufferSha256Hex } from "./client-image-processor";

/**
 * Browser-side Short Video pre-upload validator, SHA-256 digester, optional
 * client-captured WebP poster extractor, and WebVTT caption validator (REQ-062;
 * DESIGN.md §8; TASK-060).
 */

export const MAX_CLIENT_VIDEO_BYTES = MAX_VIDEO_UPLOAD_BYTES;
export const MAX_CLIENT_VIDEOS_PER_SITE = MAX_VIDEOS_PER_TENANT;
export const MAX_CLIENT_CAPTION_BYTES = MAX_CAPTION_VTT_BYTES;

export type VideoClientValidationErrorKind = "size" | "format" | "empty" | "caption" | "limit";

export class VideoClientValidationError extends Error {
  readonly kind: VideoClientValidationErrorKind;
  readonly code: string;

  constructor(kind: VideoClientValidationErrorKind, code: string, message: string) {
    super(message);
    this.name = "VideoClientValidationError";
    this.kind = kind;
    this.code = code;
  }
}

export interface PreparedVideoUpload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: EligibleVideoMime;
  readonly declaredBytes: number;
  readonly sha256: string;
  readonly posterWebpBytes?: Uint8Array | null;
}

const VIDEO_EXT_TO_MIME: Record<string, EligibleVideoMime> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function resolveEligibleVideoMime(file: Pick<File, "name" | "type">): EligibleVideoMime | null {
  const normType = (file.type?.split(";")[0] ?? "").trim().toLowerCase();
  if ((ELIGIBLE_VIDEO_MIMES as readonly string[]).includes(normType)) {
    return normType as EligibleVideoMime;
  }
  const extMatch = /\.([a-z0-9]{1,8})$/i.exec(file.name.trim());
  const ext = extMatch?.[1]?.toLowerCase() ?? "";
  if (ext && ext in VIDEO_EXT_TO_MIME) {
    return VIDEO_EXT_TO_MIME[ext] ?? null;
  }
  return null;
}

/**
 * Best-effort client-side video first-frame WebP capture via `<video>` + `<canvas>`.
 * Returns `null` cleanly if browser codecs or canvas WebP export are unavailable
 * (server falls back to container-extracted frame or default WebP poster).
 */
export async function tryCaptureClientVideoPosterWebp(file: File): Promise<Uint8Array | null> {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return null;
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 4_000);
      video.onloadeddata = () => {
        clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("decode_error"));
      };
    });

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;

    const canvas = document.createElement("canvas");
    canvas.width = Math.min(w, 1280);
    canvas.height = Math.round((canvas.width / w) * h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/webp", 0.82);
    });
    if (!blob || blob.type !== "image/webp" || blob.size === 0) {
      return null;
    }
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Validates size (`<= 10,000,000` bytes), format (`MP4`, `MOV`, `WebM`), and computes
 * exact SHA-256 digest before calling the tenant video upload-intent API.
 */
export async function prepareVideoFileForUpload(
  file: File,
  options?: { readonly capturePoster?: boolean },
): Promise<PreparedVideoUpload> {
  if (file.size <= 0) {
    throw new VideoClientValidationError(
      "empty",
      "EMPTY_FILE",
      "Berkas video kosong (0 byte). Pilih berkas MP4, MOV, atau WebM yang valid.",
    );
  }

  if (file.size > MAX_CLIENT_VIDEO_BYTES) {
    throw new VideoClientValidationError(
      "size",
      "PAYLOAD_TOO_LARGE",
      `Ukuran video (${(file.size / 1_000_000).toFixed(2)} MB) melebihi batas maksimum 10 MB (10.000.000 byte). Untuk video panjang, gunakan tautan YouTube.`,
    );
  }

  const mimeType = resolveEligibleVideoMime(file);
  if (!mimeType) {
    throw new VideoClientValidationError(
      "format",
      "UNSUPPORTED_MEDIA_TYPE",
      "Format video tidak didukung. Hanya MP4, MOV, dan WebM yang diterima.",
    );
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const sha256 = await computeBufferSha256Hex(bytes);

  const posterWebpBytes =
    options?.capturePoster !== false ? await tryCaptureClientVideoPosterWebp(file) : null;

  return {
    bytes,
    filename: file.name || `video.${mimeType === "video/webm" ? "webm" : mimeType === "video/quicktime" ? "mov" : "mp4"}`,
    mimeType,
    declaredBytes: bytes.byteLength,
    sha256,
    posterWebpBytes,
  };
}

/**
 * Validates an optional `.vtt` caption file client-side before uploading to
 * `/api/tenants/{handle}/media/{id}/captions`.
 */
export async function prepareWebVttCaptionFile(file: File): Promise<{
  readonly sanitizedVtt: string;
  readonly sanitizedBytes: Uint8Array;
  readonly cueCount: number;
  readonly strippedHtml: boolean;
}> {
  if (file.size === 0) {
    throw new VideoClientValidationError(
      "caption",
      "EMPTY_CAPTION",
      "Berkas takarir (.vtt) kosong.",
    );
  }
  if (file.size > MAX_CLIENT_CAPTION_BYTES) {
    throw new VideoClientValidationError(
      "caption",
      "CAPTION_TOO_LARGE",
      "Ukuran berkas takarir (.vtt) melebihi batas maksimum 256 KB.",
    );
  }
  const lowerName = file.name.toLowerCase();
  if (lowerName && !lowerName.endsWith(".vtt") && file.type !== "text/vtt") {
    throw new VideoClientValidationError(
      "caption",
      "INVALID_WEBVTT_HEADER",
      "Format takarir harus berupa berkas WebVTT (.vtt).",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const validated = validateAndSanitizeWebVtt(bytes);
  if (!validated.ok) {
    throw new VideoClientValidationError("caption", validated.code, validated.message);
  }
  return {
    sanitizedVtt: validated.sanitizedVtt,
    sanitizedBytes: validated.sanitizedBytes,
    cueCount: validated.cueCount,
    strippedHtml: validated.strippedHtml,
  };
}

/**
 * Short Video Upload Validation, Pure-JS MP4 Fast-Start & Metadata-Strip Rewriter,
 * WebVTT Caption Sanitizer, Placement Guard, and Tenant-Scoped R2 Key Builders
 * (REQ-062, REQ-039, REQ-040, REQ-064; PLAN §7.2–7.3; TASK-060).
 *
 * Runtime-neutral: works identically in Node unit tests and Cloudflare `workerd`
 * well within Worker CPU and memory budgets (zero native binaries, zero external deps).
 */

import {
  assertTenantR2Key,
  InvalidTenantR2KeyError,
  slugifyMediaFilename,
} from "./index.ts";

// ---------------------------------------------------------------------------
// 1. Canonical Short Video Limits & Constants
// ---------------------------------------------------------------------------

export const MAX_VIDEO_UPLOAD_BYTES = 10_000_000 as const; // Exact 10 MB (REQ-062)
export const MAX_VIDEOS_PER_TENANT = 20 as const; // Max 20 videos per website (REQ-062)
export const MAX_VIDEO_WIDTH = 1_920 as const;
export const MAX_VIDEO_HEIGHT = 1_080 as const;
export const MAX_VIDEO_FPS = 60 as const;
export const MAX_VIDEO_FPS_TOLERANCE = 60.05 as const; // Allows 60.000 fps / 59.94 fps rounding, rejects >= 60.1 fps
export const MAX_POSTER_UPLOAD_BYTES = 2_000_000 as const;
export const MAX_CAPTION_VTT_BYTES = 256_000 as const; // 256 KiB cap
export const MAX_CAPTION_CUES = 1_000 as const;
export const MAX_VIDEO_TITLE_LENGTH = 160 as const;
export const MAX_VIDEO_CAPTION_TEXT_LENGTH = 250 as const;

export const ELIGIBLE_VIDEO_MIMES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;

export type EligibleVideoMime = (typeof ELIGIBLE_VIDEO_MIMES)[number];

export type VideoContainerFormat = "mp4" | "mov" | "webm";
export type VideoProcessingPath = "worker_faststart" | "container_transcode";

export const ALLOWED_VIDEO_PLACEMENTS = [
  "portfolio",
  "gallery",
  "offering",
  "post",
  "rich_text",
] as const;

export const FORBIDDEN_VIDEO_PLACEMENTS = ["hero"] as const;

export type VideoPlacement =
  | (typeof ALLOWED_VIDEO_PLACEMENTS)[number]
  | (typeof FORBIDDEN_VIDEO_PLACEMENTS)[number];

export type VideoRejectionCode =
  | "EMPTY_FILE"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "CORRUPT_VIDEO"
  | "MIME_SPOOFING"
  | "OVERSIZED_DIMENSIONS"
  | "OVERSIZED_FRAMERATE"
  | "UNSUPPORTED_CODEC";

export interface InspectedVideoSuccess {
  readonly ok: true;
  readonly mimeType: EligibleVideoMime;
  readonly format: VideoContainerFormat;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSeconds: number | null;
  readonly videoCodec: string;
  readonly audioCodec: string | null;
  readonly isCompliantH264AacMp4: boolean;
  readonly processingPath: VideoProcessingPath;
  readonly moovBeforeMdat: boolean | null;
  readonly hasFragments?: boolean;
  readonly videoTrackCount?: number;
  readonly hasAuxiliaryTracks?: boolean;
  readonly byteLength: number;
}

export interface InspectedVideoFailure {
  readonly ok: false;
  readonly code: VideoRejectionCode;
  readonly status: 413 | 415 | 422;
  readonly message: string;
}

export type InspectVideoResult = InspectedVideoSuccess | InspectedVideoFailure;

export interface VideoDerivativeKeys {
  readonly video: string;
  readonly poster: string;
  readonly captions: string;
}

export interface VideoMetadataManifest {
  readonly kind: "video";
  readonly slug: string;
  readonly videoCodec: string;
  readonly audioCodec: string | null;
  readonly fps: number;
  readonly processingPath: VideoProcessingPath;
  readonly moovBeforeMdat: boolean;
  readonly metadataStripped: boolean;
  readonly posterSource: "client_frame" | "container_frame" | "default";
  readonly posterMimeType: "image/webp";
  readonly captionsLang?: string | null;
  readonly captionsLabel?: string | null;
  readonly errorCode?: string | null;
}

// ---------------------------------------------------------------------------
// 2. Built-In Valid Default WebP Poster (Zero-Network Fallback, 16x9 aspect)
// ---------------------------------------------------------------------------

/**
 * Valid lossless `image/webp` (VP8L, 1x1 dark slate pixel `#132220`) encoded as
 * raw bytes. Passes `inspectImageBinary(..., "image/webp")` deterministically in
 * both Node and Cloudflare `workerd` without external fetches or native decoders.
 */
const DEFAULT_VIDEO_POSTER_WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x24, 0x00, 0x00, 0x00, // RIFF chunk size (36 bytes)
  0x57, 0x45, 0x42, 0x50, // "WEBP"
  0x56, 0x50, 0x38, 0x4c, // "VP8L"
  0x18, 0x00, 0x00, 0x00, // VP8L payload size (24 bytes)
  0x2f,                   // VP8L signature byte
  0x3f, 0x10, 0x0e, 0x00, // width = 64 (0x3f + 1), height = 36 (0x23 + 1), alpha=0, version=0
  0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe,
  0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00,
]);

/**
 * Returns a fresh copy of the valid `image/webp` default video poster binary.
 */
export function getDefaultVideoPosterWebpBytes(): Uint8Array {
  return new Uint8Array(DEFAULT_VIDEO_POSTER_WEBP_BYTES);
}

// ---------------------------------------------------------------------------
// 3. Low-Level Binary Readers & Bounds Helpers
// ---------------------------------------------------------------------------

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  const v = value >>> 0;
  bytes[offset] = (v >>> 24) & 0xff;
  bytes[offset + 1] = (v >>> 16) & 0xff;
  bytes[offset + 2] = (v >>> 8) & 0xff;
  bytes[offset + 3] = v & 0xff;
}

function readUint64BEAsSafeNumber(bytes: Uint8Array, offset: number): number | null {
  const hi = readUint32BE(bytes, offset);
  const lo = readUint32BE(bytes, offset + 4);
  if (hi > 0x1fffff) return null; // exceeds Number.MAX_SAFE_INTEGER
  return hi * 0x1_0000_0000 + lo;
}

function writeUint64BE(bytes: Uint8Array, offset: number, value: number): void {
  const hi = Math.floor(value / 0x1_0000_0000) >>> 0;
  const lo = value >>> 0;
  writeUint32BE(bytes, offset, hi);
  writeUint32BE(bytes, offset + 4, lo);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  const end = Math.min(bytes.byteLength, offset + length);
  for (let i = offset; i < end; i += 1) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

function looksLikeMarkupOrScript(bytes: Uint8Array): boolean {
  let start = 0;
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    start = 3;
  }
  const sampleLen = Math.min(bytes.byteLength - start, 512);
  if (sampleLen <= 0) return false;
  const sample = readAscii(bytes, start, sampleLen).trimStart().toLowerCase();
  return (
    sample.startsWith("<svg") ||
    sample.startsWith("<?xml") ||
    sample.startsWith("<!doctype") ||
    sample.startsWith("<html") ||
    sample.startsWith("<script")
  );
}

// ---------------------------------------------------------------------------
// 4. ISO BMFF (MP4 / QuickTime MOV) Box Parser & Codec/Dimension/FPS Inspector
// ---------------------------------------------------------------------------

const MAX_BMFF_BOXES_PER_LEVEL = 4_096;
const MAX_BMFF_DEPTH = 12;

const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "dash",
  "mp71",
  "f4v ",
]);

const QUICKTIME_BRANDS = new Set(["qt  "]);
const NON_VIDEO_IMAGE_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "avif",
  "avis",
  "mif1",
  "msf1",
]);

const H264_CODEC_FOURCCS = new Set(["avc1", "avc3"]);
const AAC_CODEC_FOURCCS = new Set(["mp4a"]);

interface BmffBox {
  readonly type: string;
  readonly start: number;
  readonly headerSize: number;
  readonly payloadStart: number;
  readonly end: number;
}

function readBmffBox(bytes: Uint8Array, offset: number, limit: number): BmffBox | null {
  if (offset + 8 > limit) return null;
  let size = readUint32BE(bytes, offset);
  const type = readAscii(bytes, offset + 4, 4);
  let headerSize = 8;

  if (size === 0) {
    size = limit - offset;
  } else if (size === 1) {
    if (offset + 16 > limit) return null;
    const extSize = readUint64BEAsSafeNumber(bytes, offset + 8);
    if (extSize === null || extSize > MAX_VIDEO_UPLOAD_BYTES) return null;
    size = extSize;
    headerSize = 16;
  }

  if (size < headerSize || offset + size > limit) {
    return null;
  }

  return {
    type,
    start: offset,
    headerSize,
    payloadStart: offset + headerSize,
    end: offset + size,
  };
}

function listBmffBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
): readonly BmffBox[] | null {
  const boxes: BmffBox[] = [];
  let cursor = start;
  let count = 0;

  while (cursor < end) {
    if (count >= MAX_BMFF_BOXES_PER_LEVEL) {
      return null;
    }
    const box = readBmffBox(bytes, cursor, end);
    if (!box || box.end <= cursor) {
      return null;
    }
    boxes.push(box);
    cursor = box.end;
    count += 1;
  }

  return boxes;
}

interface ParsedTrackInfo {
  readonly handlerType: string | null;
  readonly tkhdWidth: number;
  readonly tkhdHeight: number;
  readonly sampleEntryWidth: number;
  readonly sampleEntryHeight: number;
  readonly codecFourcc: string | null;
  readonly mdhdTimescale: number;
  readonly mdhdDuration: number;
  readonly sttsSampleCount: number;
  readonly sttsTotalDelta: number;
  readonly sttsMinPositiveDelta: number | null;
}

function parseMvhdDuration(bytes: Uint8Array, box: BmffBox): number | null {
  const p = box.payloadStart;
  if (p + 4 > box.end) return null;
  const version = bytes[p] ?? 0;
  if (version === 0) {
    if (p + 20 > box.end) return null;
    const timescale = readUint32BE(bytes, p + 12);
    const duration = readUint32BE(bytes, p + 16);
    if (timescale === 0) return null;
    return duration / timescale;
  }
  if (version === 1) {
    if (p + 32 > box.end) return null;
    const timescale = readUint32BE(bytes, p + 20);
    const duration = readUint64BEAsSafeNumber(bytes, p + 24);
    if (timescale === 0 || duration === null) return null;
    return duration / timescale;
  }
  return null;
}

function parseTkhdDimensions(
  bytes: Uint8Array,
  box: BmffBox,
): { width: number; height: number } {
  const p = box.payloadStart;
  if (p + 4 > box.end) return { width: 0, height: 0 };
  const version = bytes[p] ?? 0;
  const widthOffset = version === 1 ? p + 88 : p + 76;
  const heightOffset = widthOffset + 4;
  if (heightOffset + 4 > box.end) return { width: 0, height: 0 };
  // Fixed-point 16.16 integer pixel dimensions
  const width = Math.round(readUint32BE(bytes, widthOffset) / 65536);
  const height = Math.round(readUint32BE(bytes, heightOffset) / 65536);
  return { width, height };
}

function parseMdhdTiming(
  bytes: Uint8Array,
  box: BmffBox,
): { timescale: number; duration: number } {
  const p = box.payloadStart;
  if (p + 4 > box.end) return { timescale: 0, duration: 0 };
  const version = bytes[p] ?? 0;
  if (version === 0) {
    if (p + 20 > box.end) return { timescale: 0, duration: 0 };
    return {
      timescale: readUint32BE(bytes, p + 12),
      duration: readUint32BE(bytes, p + 16),
    };
  }
  if (version === 1) {
    if (p + 32 > box.end) return { timescale: 0, duration: 0 };
    const duration = readUint64BEAsSafeNumber(bytes, p + 24) ?? 0;
    return {
      timescale: readUint32BE(bytes, p + 20),
      duration,
    };
  }
  return { timescale: 0, duration: 0 };
}

function parseHdlrType(bytes: Uint8Array, box: BmffBox): string | null {
  const p = box.payloadStart;
  if (p + 12 > box.end) return null;
  return readAscii(bytes, p + 8, 4);
}

function parseStsdEntry(
  bytes: Uint8Array,
  box: BmffBox,
): { codecFourcc: string | null; width: number; height: number } {
  const p = box.payloadStart;
  // FullBox: 4 bytes version/flags + 4 bytes entry_count
  if (p + 16 > box.end) return { codecFourcc: null, width: 0, height: 0 };
  const entryCount = readUint32BE(bytes, p + 4);
  if (entryCount < 1) return { codecFourcc: null, width: 0, height: 0 };
  const entry = readBmffBox(bytes, p + 8, box.end);
  if (!entry) return { codecFourcc: null, width: 0, height: 0 };

  let width = 0;
  let height = 0;
  // VisualSampleEntry layout: 6 reserved + 2 data_ref_idx + 16 pre_defined/reserved + 2 width + 2 height
  if (entry.payloadStart + 28 <= entry.end) {
    width = readUint16BE(bytes, entry.payloadStart + 24);
    height = readUint16BE(bytes, entry.payloadStart + 26);
  }
  return {
    codecFourcc: entry.type,
    width,
    height,
  };
}

function parseStts(
  bytes: Uint8Array,
  box: BmffBox,
): { sampleCount: number; totalDelta: number; minPositiveDelta: number | null } {
  const p = box.payloadStart;
  if (p + 8 > box.end) {
    return { sampleCount: 0, totalDelta: 0, minPositiveDelta: null };
  }
  const entryCount = readUint32BE(bytes, p + 4);
  const maxEntries = Math.min(entryCount, 65_536);
  let sampleCount = 0;
  let totalDelta = 0;
  let minPositiveDelta: number | null = null;

  for (let i = 0; i < maxEntries; i += 1) {
    const entryOff = p + 8 + i * 8;
    if (entryOff + 8 > box.end) break;
    const count = readUint32BE(bytes, entryOff);
    const delta = readUint32BE(bytes, entryOff + 4);
    sampleCount += count;
    totalDelta += count * delta;
    if (count > 0 && delta > 0) {
      if (minPositiveDelta === null || delta < minPositiveDelta) {
        minPositiveDelta = delta;
      }
    }
  }

  return { sampleCount, totalDelta, minPositiveDelta };
}

function parseTrakBox(bytes: Uint8Array, trakBox: BmffBox): ParsedTrackInfo | null {
  const children = listBmffBoxes(bytes, trakBox.payloadStart, trakBox.end);
  if (!children) return null;

  let handlerType: string | null = null;
  let tkhdWidth = 0;
  let tkhdHeight = 0;
  let sampleEntryWidth = 0;
  let sampleEntryHeight = 0;
  let codecFourcc: string | null = null;
  let mdhdTimescale = 0;
  let mdhdDuration = 0;
  let sttsSampleCount = 0;
  let sttsTotalDelta = 0;
  let sttsMinPositiveDelta: number | null = null;

  for (const child of children) {
    if (child.type === "tkhd") {
      const dims = parseTkhdDimensions(bytes, child);
      tkhdWidth = dims.width;
      tkhdHeight = dims.height;
    } else if (child.type === "mdia") {
      const mdiaChildren = listBmffBoxes(bytes, child.payloadStart, child.end);
      if (!mdiaChildren) return null;
      for (const mChild of mdiaChildren) {
        if (mChild.type === "mdhd") {
          const timing = parseMdhdTiming(bytes, mChild);
          mdhdTimescale = timing.timescale;
          mdhdDuration = timing.duration;
        } else if (mChild.type === "hdlr") {
          handlerType = parseHdlrType(bytes, mChild);
        } else if (mChild.type === "minf") {
          const minfChildren = listBmffBoxes(bytes, mChild.payloadStart, mChild.end);
          if (!minfChildren) return null;
          for (const minfChild of minfChildren) {
            if (minfChild.type === "stbl") {
              const stblChildren = listBmffBoxes(bytes, minfChild.payloadStart, minfChild.end);
              if (!stblChildren) return null;
              for (const stblChild of stblChildren) {
                if (stblChild.type === "stsd") {
                  const stsd = parseStsdEntry(bytes, stblChild);
                  codecFourcc = stsd.codecFourcc;
                  sampleEntryWidth = stsd.width;
                  sampleEntryHeight = stsd.height;
                } else if (stblChild.type === "stts") {
                  const stts = parseStts(bytes, stblChild);
                  sttsSampleCount = stts.sampleCount;
                  sttsTotalDelta = stts.totalDelta;
                  sttsMinPositiveDelta = stts.minPositiveDelta;
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    handlerType,
    tkhdWidth,
    tkhdHeight,
    sampleEntryWidth,
    sampleEntryHeight,
    codecFourcc,
    mdhdTimescale,
    mdhdDuration,
    sttsSampleCount,
    sttsTotalDelta,
    sttsMinPositiveDelta,
  };
}

function inspectIsoBmffVideo(bytes: Uint8Array): InspectVideoResult | null {
  if (bytes.byteLength < 16 || readAscii(bytes, 4, 4) !== "ftyp") {
    return null;
  }

  const topBoxes = listBmffBoxes(bytes, 0, bytes.byteLength);
  if (!topBoxes || topBoxes.length === 0) {
    return {
      ok: false,
      code: "CORRUPT_VIDEO",
      status: 422,
      message: "Corrupt or truncated MP4/MOV box structure.",
    };
  }

  const ftyp = topBoxes[0];
  if (!ftyp || ftyp.type !== "ftyp" || ftyp.end < 16) {
    return {
      ok: false,
      code: "CORRUPT_VIDEO",
      status: 422,
      message: "Invalid MP4/MOV ftyp header box.",
    };
  }

  const majorBrand = readAscii(bytes, ftyp.payloadStart, 4);
  const allBrands = new Set<string>([majorBrand]);
  for (let pos = ftyp.payloadStart + 8; pos + 4 <= ftyp.end; pos += 4) {
    allBrands.add(readAscii(bytes, pos, 4));
  }

  // Reject still-image ISO BMFF formats (HEIC, HEIF, AVIF)
  if (NON_VIDEO_IMAGE_BRANDS.has(majorBrand)) {
    return {
      ok: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
      message: "Image containers (HEIC/HEIF/AVIF) are not accepted by the video pipeline.",
    };
  }

  let format: "mp4" | "mov" | null = null;
  if (QUICKTIME_BRANDS.has(majorBrand)) {
    format = "mov";
  } else if (MP4_BRANDS.has(majorBrand)) {
    format = "mp4";
  } else {
    for (const b of allBrands) {
      if (QUICKTIME_BRANDS.has(b)) {
        format = "mov";
        break;
      }
      if (MP4_BRANDS.has(b)) {
        format = "mp4";
        break;
      }
    }
  }

  if (!format) {
    return {
      ok: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
      message: `Unsupported ISO BMFF brand "${majorBrand}". Upload MP4, MOV, or WebM.`,
    };
  }

  const moovIndex = topBoxes.findIndex((b) => b.type === "moov");
  const mdatIndex = topBoxes.findIndex((b) => b.type === "mdat");
  if (moovIndex === -1 || mdatIndex === -1) {
    return {
      ok: false,
      code: "CORRUPT_VIDEO",
      status: 422,
      message: "Corrupt MP4/MOV container: missing required moov or mdat box.",
    };
  }

  const moovBox = topBoxes[moovIndex]!;
  const moovChildren = listBmffBoxes(bytes, moovBox.payloadStart, moovBox.end);
  if (!moovChildren) {
    return {
      ok: false,
      code: "CORRUPT_VIDEO",
      status: 422,
      message: "Corrupt MP4/MOV moov box children.",
    };
  }

  // Detect fragmented MP4 (`moof` at top-level or `mvex` inside `moov`)
  const hasFragments =
    topBoxes.some((b) => b.type === "moof") || moovChildren.some((c) => c.type === "mvex");

  let movieDuration: number | null = null;
  const videoTracks: ParsedTrackInfo[] = [];
  const audioTracks: ParsedTrackInfo[] = [];
  let hasAuxiliaryTracks = false;

  for (const child of moovChildren) {
    if (child.type === "mvhd") {
      movieDuration = parseMvhdDuration(bytes, child);
    } else if (child.type === "trak") {
      const parsedTrack = parseTrakBox(bytes, child);
      if (!parsedTrack) {
        return {
          ok: false,
          code: "CORRUPT_VIDEO",
          status: 422,
          message: "Corrupt MP4/MOV track box.",
        };
      }
      if (parsedTrack.handlerType === "vide") {
        videoTracks.push(parsedTrack);
      } else if (parsedTrack.handlerType === "soun") {
        audioTracks.push(parsedTrack);
      } else {
        // Any non-vide/soun track (e.g. `mebx`, `meta`, `gps `, `tmcd`, `text`, `sbtl`)
        // MUST NOT pass through pure-JS fast-start unstripped!
        hasAuxiliaryTracks = true;
      }
    }
  }

  const videoTrack = videoTracks[0] ?? null;
  const audioTrack = audioTracks[0] ?? null;

  if (!videoTrack) {
    return {
      ok: false,
      code: "CORRUPT_VIDEO",
      status: 422,
      message: "Container does not contain a valid video track.",
    };
  }

  // Validate resolution and frame rate across EVERY video track (prevents hiding oversized secondary tracks)
  let primaryWidth = 0;
  let primaryHeight = 0;
  let primaryFps = 30;
  let primaryDurationSeconds: number | null = movieDuration;

  for (let i = 0; i < videoTracks.length; i += 1) {
    const vt = videoTracks[i]!;
    const w = vt.sampleEntryWidth > 0 ? vt.sampleEntryWidth : vt.tkhdWidth;
    const h = vt.sampleEntryHeight > 0 ? vt.sampleEntryHeight : vt.tkhdHeight;

    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
      return {
        ok: false,
        code: "CORRUPT_VIDEO",
        status: 422,
        message: "Video track has missing or invalid pixel dimensions.",
      };
    }

    if (w > MAX_VIDEO_WIDTH || h > MAX_VIDEO_HEIGHT) {
      return {
        ok: false,
        code: "OVERSIZED_DIMENSIONS",
        status: 422,
        message: `Video resolution (${w}x${h}) exceeds maximum ${MAX_VIDEO_WIDTH}x${MAX_VIDEO_HEIGHT}.`,
      };
    }

    let trackFps = 30;
    let trackDur: number | null = movieDuration;
    if (vt.mdhdTimescale > 0) {
      if (vt.sttsSampleCount > 0 && vt.sttsTotalDelta > 0) {
        const avgFps = (vt.sttsSampleCount * vt.mdhdTimescale) / vt.sttsTotalDelta;
        const peakFps =
          vt.sttsMinPositiveDelta && vt.sttsMinPositiveDelta > 0
            ? vt.mdhdTimescale / vt.sttsMinPositiveDelta
            : avgFps;
        trackFps = Math.max(avgFps, peakFps);
        trackDur = vt.sttsTotalDelta / vt.mdhdTimescale;
      } else if (vt.mdhdDuration > 0) {
        trackDur = vt.mdhdDuration / vt.mdhdTimescale;
      }
    }

    if (!Number.isFinite(trackFps) || trackFps <= 0) {
      return {
        ok: false,
        code: "CORRUPT_VIDEO",
        status: 422,
        message: "Video track has invalid frame rate metadata.",
      };
    }

    if (trackFps > MAX_VIDEO_FPS_TOLERANCE) {
      return {
        ok: false,
        code: "OVERSIZED_FRAMERATE",
        status: 422,
        message: `Video frame rate (${Math.round(trackFps * 100) / 100} fps) exceeds maximum ${MAX_VIDEO_FPS} fps.`,
      };
    }

    if (i === 0) {
      primaryWidth = w;
      primaryHeight = h;
      primaryFps = trackFps;
      primaryDurationSeconds = trackDur;
    }
  }

  const videoCodec = videoTrack.codecFourcc ?? "unknown";
  const audioCodec = audioTrack?.codecFourcc ?? null;

  // Pure-JS Worker fast-start is ONLY eligible for single-video-track, non-fragmented MP4
  // with zero auxiliary/timed-metadata tracks (`mebx`, `meta`, `gps `, `tmcd`, `text`, etc.)
  // and compliant H.264 + optional single AAC audio track.
  const isCompliantH264AacMp4 =
    format === "mp4" &&
    !hasFragments &&
    videoTracks.length === 1 &&
    audioTracks.length <= 1 &&
    !hasAuxiliaryTracks &&
    H264_CODEC_FOURCCS.has(videoCodec) &&
    (audioCodec === null || AAC_CODEC_FOURCCS.has(audioCodec));

  return {
    ok: true,
    mimeType: format === "mp4" ? "video/mp4" : "video/quicktime",
    format,
    width: primaryWidth,
    height: primaryHeight,
    fps: Math.round(primaryFps * 100) / 100,
    durationSeconds:
      primaryDurationSeconds !== null &&
      Number.isFinite(primaryDurationSeconds) &&
      primaryDurationSeconds >= 0
        ? Math.round(primaryDurationSeconds * 1000) / 1000
        : null,
    videoCodec,
    audioCodec,
    isCompliantH264AacMp4,
    processingPath: isCompliantH264AacMp4 ? "worker_faststart" : "container_transcode",
    moovBeforeMdat: moovIndex < mdatIndex,
    hasFragments,
    videoTrackCount: videoTracks.length,
    hasAuxiliaryTracks,
    byteLength: bytes.byteLength,
  };
}

// ---------------------------------------------------------------------------
// 5. EBML / WebM Parser & Dimension/FPS Inspector
// ---------------------------------------------------------------------------

const MAX_EBML_ELEMENTS = 4_096;

interface EbmlVint {
  readonly value: number;
  readonly rawId: number;
  readonly length: number;
}

function readEbmlId(bytes: Uint8Array, offset: number, limit: number): EbmlVint | null {
  if (offset >= limit) return null;
  const first = bytes[offset] ?? 0;
  if (first === 0) return null;

  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) {
    mask >>>= 1;
    length += 1;
  }
  if (length > 4 || offset + length > limit) return null;

  let rawId = 0;
  for (let i = 0; i < length; i += 1) {
    rawId = rawId * 256 + (bytes[offset + i] ?? 0);
  }
  return { value: rawId, rawId, length };
}

function readEbmlSize(bytes: Uint8Array, offset: number, limit: number): EbmlVint | null {
  if (offset >= limit) return null;
  const first = bytes[offset] ?? 0;
  if (first === 0) return null;

  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > limit) return null;

  let value = first & ~mask;
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i += 1) {
    const b = bytes[offset + i] ?? 0;
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }

  // Unknown-size EBML element (all data bits 1) extends to parent limit
  if (allOnes) {
    return { value: limit - (offset + length), rawId: -1, length };
  }
  return { value, rawId: 0, length };
}

function readEbmlUint(bytes: Uint8Array, start: number, size: number): number {
  let out = 0;
  const bounded = Math.min(size, 6);
  for (let i = 0; i < bounded; i += 1) {
    out = out * 256 + (bytes[start + i] ?? 0);
  }
  return out;
}

function readEbmlFloat(bytes: Uint8Array, start: number, size: number): number | null {
  if (size !== 4 && size !== 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, size);
  const val = size === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
  return Number.isFinite(val) ? val : null;
}

function inspectWebmVideo(bytes: Uint8Array): InspectVideoResult | null {
  if (
    bytes.byteLength < 12 ||
    bytes[0] !== 0x1a ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0xdf ||
    bytes[3] !== 0xa3
  ) {
    return null;
  }

  let cursor = 0;
  const limit = bytes.byteLength;
  const ebmlId = readEbmlId(bytes, cursor, limit);
  if (!ebmlId || ebmlId.rawId !== 0x1a45dfa3) {
    return { ok: false, code: "CORRUPT_VIDEO", status: 422, message: "Invalid WebM EBML header." };
  }
  cursor += ebmlId.length;
  const ebmlSize = readEbmlSize(bytes, cursor, limit);
  if (!ebmlSize || cursor + ebmlSize.length + ebmlSize.value > limit) {
    return { ok: false, code: "CORRUPT_VIDEO", status: 422, message: "Truncated WebM EBML header." };
  }
  cursor += ebmlSize.length;
  const ebmlEnd = cursor + ebmlSize.value;

  let docType = "";
  let elemCount = 0;
  while (cursor < ebmlEnd) {
    if (++elemCount > MAX_EBML_ELEMENTS) {
      return { ok: false, code: "CORRUPT_VIDEO", status: 422, message: "WebM header exceeds element limit." };
    }
    const id = readEbmlId(bytes, cursor, ebmlEnd);
    if (!id) return { ok: false, code: "CORRUPT_VIDEO", status: 422, message: "Corrupt WebM header element." };
    cursor += id.length;
    const sz = readEbmlSize(bytes, cursor, ebmlEnd);
    if (!sz || cursor + sz.length + sz.value > ebmlEnd) {
      return { ok: false, code: "CORRUPT_VIDEO", status: 422, message: "Corrupt WebM header size." };
    }
    cursor += sz.length;
    if (id.rawId === 0x4282) {
      docType = readAscii(bytes, cursor, sz.value).replace(/\0+$/, "").toLowerCase();
    }
    cursor += sz.value;
  }

  if (docType !== "webm") {
    return {
      ok: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
      message: `Unsupported EBML container DocType "${docType || "unknown"}". Only WebM is accepted.`,
    };
  }

  // Locate Segment (0x18538067)
  let segStart = -1;
  let segEnd = -1;
  while (cursor < limit) {
    if (++elemCount > MAX_EBML_ELEMENTS) break;
    const id = readEbmlId(bytes, cursor, limit);
    if (!id) break;
    cursor += id.length;
    const sz = readEbmlSize(bytes, cursor, limit);
    if (!sz || cursor + sz.length + sz.value > limit) {
      return { ok: false, code: "CORRUPT_VIDEO", status: 422, message: "Truncated WebM Segment element." };
    }
    cursor += sz.length;
    if (id.rawId === 0x18538067) {
      segStart = cursor;
      segEnd = cursor + sz.value;
      break;
    }
    cursor += sz.value;
  }

  if (segStart === -1) {
    return { ok: false, code: "CORRUPT_VIDEO", status: 422, message: "Corrupt WebM: missing Segment element." };
  }

  let timestampScale = 1_000_000; // ns
  let rawDuration: number | null = null;
  let videoWidth = 0;
  let videoHeight = 0;
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let defaultDurationNs = 0;
  let hasCluster = false;

  let sc = segStart;
  while (sc < segEnd) {
    if (++elemCount > MAX_EBML_ELEMENTS) break;
    const id = readEbmlId(bytes, sc, segEnd);
    if (!id) break;
    sc += id.length;
    const sz = readEbmlSize(bytes, sc, segEnd);
    if (!sz || sc + sz.length + sz.value > segEnd) {
      return { ok: false, code: "CORRUPT_VIDEO", status: 422, message: "Truncated WebM Segment child element." };
    }
    sc += sz.length;
    const childEnd = sc + sz.value;

    if (id.rawId === 0x1549a966) {
      // Info
      let ic = sc;
      while (ic < childEnd) {
        const iid = readEbmlId(bytes, ic, childEnd);
        if (!iid) break;
        ic += iid.length;
        const isz = readEbmlSize(bytes, ic, childEnd);
        if (!isz || ic + isz.length + isz.value > childEnd) break;
        ic += isz.length;
        if (iid.rawId === 0x2ad7b1) {
          const ts = readEbmlUint(bytes, ic, isz.value);
          if (ts > 0) timestampScale = ts;
        } else if (iid.rawId === 0x4489) {
          rawDuration = readEbmlFloat(bytes, ic, isz.value);
        }
        ic += isz.value;
      }
    } else if (id.rawId === 0x1654ae6b) {
      // Tracks
      let tc = sc;
      while (tc < childEnd) {
        const tid = readEbmlId(bytes, tc, childEnd);
        if (!tid) break;
        tc += tid.length;
        const tsz = readEbmlSize(bytes, tc, childEnd);
        if (!tsz || tc + tsz.length + tsz.value > childEnd) break;
        tc += tsz.length;
        const entryEnd = tc + tsz.value;

        if (tid.rawId === 0xae) {
          // TrackEntry
          let trackType = 0;
          let codecId = "";
          let trackDefaultDur = 0;
          let pxW = 0;
          let pxH = 0;

          let ec = tc;
          while (ec < entryEnd) {
            const eid = readEbmlId(bytes, ec, entryEnd);
            if (!eid) break;
            ec += eid.length;
            const esz = readEbmlSize(bytes, ec, entryEnd);
            if (!esz || ec + esz.length + esz.value > entryEnd) break;
            ec += esz.length;
            const elemEnd = ec + esz.value;

            if (eid.rawId === 0x83) {
              trackType = readEbmlUint(bytes, ec, esz.value);
            } else if (eid.rawId === 0x86) {
              codecId = readAscii(bytes, ec, esz.value).replace(/\0+$/, "");
            } else if (eid.rawId === 0x23e383) {
              trackDefaultDur = readEbmlUint(bytes, ec, esz.value);
            } else if (eid.rawId === 0xe0) {
              // Video sub-element
              let vc = ec;
              while (vc < elemEnd) {
                const vid = readEbmlId(bytes, vc, elemEnd);
                if (!vid) break;
                vc += vid.length;
                const vsz = readEbmlSize(bytes, vc, elemEnd);
                if (!vsz || vc + vsz.length + vsz.value > elemEnd) break;
                vc += vsz.length;
                if (vid.rawId === 0xb0) {
                  pxW = readEbmlUint(bytes, vc, vsz.value);
                } else if (vid.rawId === 0xba) {
                  pxH = readEbmlUint(bytes, vc, vsz.value);
                }
                vc += vsz.value;
              }
            }
            ec = elemEnd;
          }

          if (trackType === 1 && !videoCodec) {
            videoCodec = codecId || "V_VP9";
            videoWidth = pxW;
            videoHeight = pxH;
            defaultDurationNs = trackDefaultDur;
          } else if (trackType === 2 && !audioCodec) {
            audioCodec = codecId || "A_OPUS";
          }
        }
        tc = entryEnd;
      }
    } else if (id.rawId === 0x1f43b675) {
      hasCluster = true;
    }

    sc = childEnd;
  }

  if (!videoCodec || !hasCluster || videoWidth < 1 || videoHeight < 1) {
    return {
      ok: false,
      code: "CORRUPT_VIDEO",
      status: 422,
      message: "Corrupt or incomplete WebM container (missing video track dimensions or media cluster).",
    };
  }

  if (videoWidth > MAX_VIDEO_WIDTH || videoHeight > MAX_VIDEO_HEIGHT) {
    return {
      ok: false,
      code: "OVERSIZED_DIMENSIONS",
      status: 422,
      message: `Video resolution (${videoWidth}x${videoHeight}) exceeds maximum ${MAX_VIDEO_WIDTH}x${MAX_VIDEO_HEIGHT}.`,
    };
  }

  const fps = defaultDurationNs > 0 ? 1_000_000_000 / defaultDurationNs : 30;
  if (!Number.isFinite(fps) || fps <= 0) {
    return {
      ok: false,
      code: "CORRUPT_VIDEO",
      status: 422,
      message: "WebM video track has invalid frame duration.",
    };
  }

  if (fps > MAX_VIDEO_FPS_TOLERANCE) {
    return {
      ok: false,
      code: "OVERSIZED_FRAMERATE",
      status: 422,
      message: `Video frame rate (${Math.round(fps * 100) / 100} fps) exceeds maximum ${MAX_VIDEO_FPS} fps.`,
    };
  }

  const durationSeconds =
    rawDuration !== null && rawDuration >= 0
      ? Math.round(((rawDuration * timestampScale) / 1_000_000_000) * 1000) / 1000
      : null;

  return {
    ok: true,
    mimeType: "video/webm",
    format: "webm",
    width: videoWidth,
    height: videoHeight,
    fps: Math.round(fps * 100) / 100,
    durationSeconds,
    videoCodec,
    audioCodec,
    isCompliantH264AacMp4: false,
    processingPath: "container_transcode",
    moovBeforeMdat: null,
    byteLength: bytes.byteLength,
  };
}

// ---------------------------------------------------------------------------
// 6. Public Entry Point: `inspectVideoBinary`
// ---------------------------------------------------------------------------

function normalizeMime(mime: string | undefined): string {
  return (mime?.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * Inspects raw video upload bytes via container magic-byte sniffing, codec detection,
 * resolution bounds (`<= 1920x1080`), frame-rate bounds (`<= 60 fps`), and strict
 * MIME spoofing checks.
 */
export function inspectVideoBinary(
  bytes: Uint8Array,
  declaredMime?: string,
): InspectVideoResult {
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      code: "EMPTY_FILE",
      status: 422,
      message: "Empty video upload is rejected.",
    };
  }

  if (bytes.byteLength > MAX_VIDEO_UPLOAD_BYTES) {
    return {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
      message: `Video exceeds maximum ${MAX_VIDEO_UPLOAD_BYTES} byte upload ceiling.`,
    };
  }

  if (looksLikeMarkupOrScript(bytes)) {
    return {
      ok: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
      message: "SVG, XML, and HTML payloads are rejected by the video pipeline.",
    };
  }

  // Try ISO BMFF (MP4 / QuickTime MOV) first, then WebM (EBML)
  let detected = inspectIsoBmffVideo(bytes);
  if (!detected) {
    detected = inspectWebmVideo(bytes);
  }

  if (!detected) {
    // Detect explicitly unsupported container formats (AVI, Ogg, FLV, raster images)
    const isRasterOrOther =
      (bytes.byteLength >= 4 && readAscii(bytes, 0, 4) === "RIFF") ||
      (bytes.byteLength >= 4 && readAscii(bytes, 0, 4) === "OggS") ||
      (bytes.byteLength >= 3 && readAscii(bytes, 0, 3) === "FLV") ||
      (bytes.byteLength >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50) ||
      (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8);

    return {
      ok: false,
      code: isRasterOrOther ? "UNSUPPORTED_MEDIA_TYPE" : "CORRUPT_VIDEO",
      status: isRasterOrOther ? 415 : 422,
      message: isRasterOrOther
        ? "Unsupported media format. Upload MP4, MOV, or WebM video only."
        : "Unrecognized or corrupt video container header.",
    };
  }

  if (!detected.ok) {
    return detected;
  }

  if (declaredMime !== undefined) {
    const normDeclared = normalizeMime(declaredMime);
    if (!normDeclared || normDeclared !== detected.mimeType) {
      return {
        ok: false,
        code: "MIME_SPOOFING",
        status: 422,
        message: `Declared MIME type "${declaredMime}" does not match detected video format "${detected.mimeType}".`,
      };
    }
  }

  return detected;
}

// ---------------------------------------------------------------------------
// 7. Pure-JS MP4 Fast-Start (`moov` before `mdat`) & Metadata-Strip Rewriter
// ---------------------------------------------------------------------------

const STRIPPED_METADATA_BOX_TYPES = new Set([
  "udta",
  "meta",
  "uuid",
  "free",
  "skip",
  "wide",
  "junk",
  "XMP_",
]);

const RECURSIVE_CONTAINER_BOX_TYPES = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "dinf",
]);

export interface RewriteMp4Result {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly moovBeforeMdat: true;
  readonly wasAlreadyFastStart: boolean;
  readonly strippedBoxTypes: readonly string[];
  readonly chunkOffsetDelta: number;
  readonly patchedChunkOffsets: number;
}

export interface RewriteMp4Failure {
  readonly ok: false;
  readonly code: "CORRUPT_VIDEO" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_FASTSTART";
  readonly message: string;
}

function concatUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function wrapBmffBox(type: string, payload: Uint8Array): Uint8Array {
  const totalSize = 8 + payload.byteLength;
  const out = new Uint8Array(totalSize);
  writeUint32BE(out, 0, totalSize);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i) & 0xff;
  }
  out.set(payload, 8);
  return out;
}

function stripMetadataRecursively(
  bytes: Uint8Array,
  box: BmffBox,
  strippedTypes: string[],
  depth: number,
): Uint8Array | null {
  if (depth > MAX_BMFF_DEPTH) return null;

  if (!RECURSIVE_CONTAINER_BOX_TYPES.has(box.type)) {
    return bytes.slice(box.start, box.end);
  }

  const children = listBmffBoxes(bytes, box.payloadStart, box.end);
  if (!children) return null;

  const keptPayloads: Uint8Array[] = [];
  for (const child of children) {
    if (STRIPPED_METADATA_BOX_TYPES.has(child.type)) {
      strippedTypes.push(child.type);
      continue;
    }
    const rebuilt = stripMetadataRecursively(bytes, child, strippedTypes, depth + 1);
    if (!rebuilt) return null;
    keptPayloads.push(rebuilt);
  }

  return wrapBmffBox(box.type, concatUint8Arrays(keptPayloads));
}

interface MdatShiftMapEntry {
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly delta: number;
}

function computeAdjustedOffset(
  oldOffset: number,
  shifts: readonly MdatShiftMapEntry[],
  fallbackDelta: number,
): number {
  for (const entry of shifts) {
    if (oldOffset >= entry.oldStart && oldOffset < entry.oldEnd) {
      return oldOffset + entry.delta;
    }
  }
  return oldOffset + fallbackDelta;
}

function patchChunkOffsetsInMoov(
  moovBytes: Uint8Array,
  start: number,
  end: number,
  shifts: readonly MdatShiftMapEntry[],
  fallbackDelta: number,
  depth: number,
): { ok: boolean; patchedCount: number } {
  if (depth > MAX_BMFF_DEPTH) return { ok: false, patchedCount: 0 };
  const boxes = listBmffBoxes(moovBytes, start, end);
  if (!boxes) return { ok: false, patchedCount: 0 };

  let patchedCount = 0;
  for (const box of boxes) {
    if (box.type === "stco") {
      // FullBox: 4 version/flags + 4 entry_count + entry_count * 4-byte uint32
      if (box.payloadStart + 8 > box.end) return { ok: false, patchedCount };
      const count = readUint32BE(moovBytes, box.payloadStart + 4);
      if (box.payloadStart + 8 + count * 4 > box.end) return { ok: false, patchedCount };
      for (let i = 0; i < count; i += 1) {
        const pos = box.payloadStart + 8 + i * 4;
        const oldOff = readUint32BE(moovBytes, pos);
        const nextOff = computeAdjustedOffset(oldOff, shifts, fallbackDelta);
        if (nextOff < 0 || nextOff > 0xffffffff) return { ok: false, patchedCount };
        writeUint32BE(moovBytes, pos, nextOff);
        patchedCount += 1;
      }
    } else if (box.type === "co64") {
      // FullBox: 4 version/flags + 4 entry_count + entry_count * 8-byte uint64
      if (box.payloadStart + 8 > box.end) return { ok: false, patchedCount };
      const count = readUint32BE(moovBytes, box.payloadStart + 4);
      if (box.payloadStart + 8 + count * 8 > box.end) return { ok: false, patchedCount };
      for (let i = 0; i < count; i += 1) {
        const pos = box.payloadStart + 8 + i * 8;
        const oldOff = readUint64BEAsSafeNumber(moovBytes, pos);
        if (oldOff === null) return { ok: false, patchedCount };
        const nextOff = computeAdjustedOffset(oldOff, shifts, fallbackDelta);
        if (nextOff < 0) return { ok: false, patchedCount };
        writeUint64BE(moovBytes, pos, nextOff);
        patchedCount += 1;
      }
    } else if (RECURSIVE_CONTAINER_BOX_TYPES.has(box.type)) {
      const nested = patchChunkOffsetsInMoov(
        moovBytes,
        box.payloadStart,
        box.end,
        shifts,
        fallbackDelta,
        depth + 1,
      );
      if (!nested.ok) return nested;
      patchedCount += nested.patchedCount;
    }
  }

  return { ok: true, patchedCount };
}

/**
 * Pure-JS Worker box rewriter for already-compliant H.264/AAC MP4 files:
 * 1. Strips top-level and nested metadata/location boxes (`udta`, `meta`, `uuid`, `free`, `skip`, `wide`).
 * 2. Moves `moov` immediately after `ftyp` and strictly before `mdat` (fast-start progressive playback).
 * 3. Accurately shifts every `stco` / `co64` chunk offset inside `moov` to match the relocated `mdat` bytes.
 */
export function rewriteMp4FastStartAndStripMetadata(
  bytes: Uint8Array,
): RewriteMp4Result | RewriteMp4Failure {
  if (bytes.byteLength > MAX_VIDEO_UPLOAD_BYTES) {
    return {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      message: `MP4 input exceeds ${MAX_VIDEO_UPLOAD_BYTES} bytes.`,
    };
  }

  const topBoxes = listBmffBoxes(bytes, 0, bytes.byteLength);
  if (!topBoxes || topBoxes.length < 2) {
    return {
      ok: false,
      code: "CORRUPT_VIDEO",
      message: "Cannot rewrite MP4: invalid top-level box layout.",
    };
  }

  const ftyp = topBoxes.find((b) => b.type === "ftyp");
  const moovIdx = topBoxes.findIndex((b) => b.type === "moov");
  const firstMdatIdx = topBoxes.findIndex((b) => b.type === "mdat");
  if (!ftyp || moovIdx === -1 || firstMdatIdx === -1) {
    return {
      ok: false,
      code: "CORRUPT_VIDEO",
      message: "Cannot rewrite MP4: missing ftyp, moov, or mdat box.",
    };
  }

  const moovBox = topBoxes[moovIdx]!;

  // Defensively block fragmented MP4s (`moof` / `mvex`), multi-video tracks, and
  // non-vide/soun timed-metadata tracks (`mebx`, `meta`, `gps `, `tmcd`, etc.) from fast-start rewrite
  const moovChildrenCheck = listBmffBoxes(bytes, moovBox.payloadStart, moovBox.end);
  if (!moovChildrenCheck) {
    return {
      ok: false,
      code: "CORRUPT_VIDEO",
      message: "Cannot rewrite MP4: corrupt moov child boxes.",
    };
  }
  if (
    topBoxes.some((b) => b.type === "moof") ||
    moovChildrenCheck.some((c) => c.type === "mvex")
  ) {
    return {
      ok: false,
      code: "UNSUPPORTED_FASTSTART",
      message: "Fragmented MP4 (moof/mvex) cannot use pure-JS fast-start; route through VideoTranscoder.",
    };
  }
  let fastStartVideoTracks = 0;
  for (const child of moovChildrenCheck) {
    if (child.type !== "trak") continue;
    const parsedTrak = parseTrakBox(bytes, child);
    if (!parsedTrak) {
      return {
        ok: false,
        code: "CORRUPT_VIDEO",
        message: "Cannot rewrite MP4: corrupt track box.",
      };
    }
    if (parsedTrak.handlerType === "vide") {
      fastStartVideoTracks += 1;
    } else if (parsedTrak.handlerType !== "soun") {
      return {
        ok: false,
        code: "UNSUPPORTED_FASTSTART",
        message: `Auxiliary/timed-metadata track "${parsedTrak.handlerType ?? "unknown"}" cannot bypass VideoTranscoder.`,
      };
    }
  }
  if (fastStartVideoTracks !== 1) {
    return {
      ok: false,
      code: "UNSUPPORTED_FASTSTART",
      message: `Expected exactly 1 video track for pure-JS fast-start (found ${fastStartVideoTracks}).`,
    };
  }

  const wasAlreadyFastStart = moovIdx < firstMdatIdx;
  const strippedBoxTypes: string[] = [];

  const ftypBytes = bytes.slice(ftyp.start, ftyp.end);
  const rebuiltMoov = stripMetadataRecursively(bytes, moovBox, strippedBoxTypes, 0);
  if (!rebuiltMoov) {
    return {
      ok: false,
      code: "CORRUPT_VIDEO",
      message: "Cannot rewrite MP4: corrupt moov child boxes.",
    };
  }

  // Collect remaining non-metadata top-level boxes (mdat and any other essential payload boxes)
  const tailBoxes: BmffBox[] = [];
  for (const box of topBoxes) {
    if (box === ftyp || box === moovBox) continue;
    if (STRIPPED_METADATA_BOX_TYPES.has(box.type)) {
      strippedBoxTypes.push(box.type);
      continue;
    }
    tailBoxes.push(box);
  }

  // Compute exact byte-offset shifts for every relocated mdat/tail box
  let nextStart = ftypBytes.byteLength + rebuiltMoov.byteLength;
  const shiftEntries: MdatShiftMapEntry[] = [];
  const tailSlices: Uint8Array[] = [];

  for (const box of tailBoxes) {
    const slice = bytes.slice(box.start, box.end);
    shiftEntries.push({
      oldStart: box.start,
      oldEnd: box.end,
      delta: nextStart - box.start,
    });
    tailSlices.push(slice);
    nextStart += slice.byteLength;
  }

  const primaryDelta = shiftEntries[0]?.delta ?? 0;

  // Patch stco / co64 chunk offsets inside rebuiltMoov
  const patched = patchChunkOffsetsInMoov(
    rebuiltMoov,
    8,
    rebuiltMoov.byteLength,
    shiftEntries,
    primaryDelta,
    0,
  );
  if (!patched.ok) {
    return {
      ok: false,
      code: "CORRUPT_VIDEO",
      message: "Cannot rewrite MP4: failed to patch stco/co64 chunk offsets.",
    };
  }

  const output = concatUint8Arrays([ftypBytes, rebuiltMoov, ...tailSlices]);
  if (output.byteLength > MAX_VIDEO_UPLOAD_BYTES) {
    return {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      message: `Rewritten MP4 exceeds ${MAX_VIDEO_UPLOAD_BYTES} bytes.`,
    };
  }

  return {
    ok: true,
    bytes: output,
    moovBeforeMdat: true,
    wasAlreadyFastStart,
    strippedBoxTypes,
    chunkOffsetDelta: primaryDelta,
    patchedChunkOffsets: patched.patchedCount,
  };
}

// ---------------------------------------------------------------------------
// 8. Strict WebVTT Caption Validator & XSS/HTML Sanitizer
// ---------------------------------------------------------------------------

export type WebVttErrorCode =
  | "EMPTY_CAPTION"
  | "CAPTION_TOO_LARGE"
  | "INVALID_UTF8"
  | "INVALID_WEBVTT_HEADER"
  | "FORBIDDEN_WEBVTT_STYLE"
  | "INVALID_WEBVTT_CUE"
  | "TOO_MANY_CUES"
  | "INVALID_CAPTION_LANG";

export interface ValidatedWebVttSuccess {
  readonly ok: true;
  readonly sanitizedVtt: string;
  readonly sanitizedBytes: Uint8Array;
  readonly cueCount: number;
  readonly strippedHtml: boolean;
}

export interface ValidatedWebVttFailure {
  readonly ok: false;
  readonly code: WebVttErrorCode;
  readonly status: 413 | 422;
  readonly message: string;
}

export type ValidateWebVttResult = ValidatedWebVttSuccess | ValidatedWebVttFailure;

const VTT_TIMESTAMP_RE = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;
const ALLOWED_VTT_SETTING_RE =
  /^(?:vertical:(?:rl|lr)|line:(?:-?\d+%?|\d+%?(?:,(?:start|center|end))?)|position:\d{1,3}%(?:,(?:line-left|center|line-right))?|size:\d{1,3}%|align:(?:start|center|end|left|right))$/;
const BCP47_LANG_RE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

function parseVttTimestampMs(token: string): number | null {
  const m = VTT_TIMESTAMP_RE.exec(token.trim());
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const mins = Number(m[2]);
  const secs = Number(m[3]);
  const ms = Number(m[4]);
  if (!Number.isFinite(hours) || !Number.isFinite(mins) || !Number.isFinite(secs) || !Number.isFinite(ms)) {
    return null;
  }
  return ((hours * 60 + mins) * 60 + secs) * 1000 + ms;
}

function sanitizeCuePayloadText(rawLines: readonly string[]): {
  readonly text: string;
  readonly strippedHtml: boolean;
} {
  let joined = rawLines.join("\n");
  const original = joined;

  // 1. Remove dangerous blocks including their inner body completely (<script>, <style>, <iframe>, <svg>, <object>)
  joined = joined.replace(
    /<\s*(script|style|iframe|svg|object|embed)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    "",
  );
  // 2. Strip any remaining HTML/WebVTT tags or unclosed tag fragments
  joined = joined.replace(/<[^>]*>/g, "");
  // 3. Strip dangling `<` or `>` characters that could break markup parsers
  joined = joined.replace(/[<>]/g, "");
  // 4. Neutralize javascript:/vbscript:/data: URI tokens or inline event handler tokens if pasted raw
  joined = joined.replace(/\b(?:javascript|vbscript)\s*:/gi, "");
  joined = joined.replace(/\bon[a-z]{2,20}\s*=/gi, "");

  // Trim per-line whitespace and collapse empty lines
  const cleanLines = joined
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const sanitized = cleanLines.join("\n");
  return {
    text: sanitized,
    strippedHtml: sanitized !== original.trim(),
  };
}

export function validateCaptionLanguageTag(rawLang: string | null | undefined): string | null {
  if (!rawLang || !rawLang.trim()) return "id";
  const trimmed = rawLang.trim();
  return BCP47_LANG_RE.test(trimmed) ? trimmed : null;
}

/**
 * Strictly validates and sanitizes an optional WebVTT subtitle/caption file:
 * - Enforces byte cap (`<= 256,000` bytes) and valid UTF-8 encoding
 * - Enforces W3C `WEBVTT` magic header on line 1
 * - Rejects `STYLE` blocks (prevents CSS injection) and malformed/reversed timestamps
 * - Strips `<script>`, `<style>`, `<iframe>`, HTML/XSS tags, and `NOTE` comments
 * - Requires at least 1 valid non-empty cue and at most `1,000` cues
 */
export function validateAndSanitizeWebVtt(
  input: string | Uint8Array,
): ValidateWebVttResult {
  let text: string;
  if (typeof input === "string") {
    const encoded = new TextEncoder().encode(input);
    if (encoded.byteLength === 0) {
      return {
        ok: false,
        code: "EMPTY_CAPTION",
        status: 422,
        message: "WebVTT caption file is empty.",
      };
    }
    if (encoded.byteLength > MAX_CAPTION_VTT_BYTES) {
      return {
        ok: false,
        code: "CAPTION_TOO_LARGE",
        status: 413,
        message: `WebVTT caption file exceeds maximum ${MAX_CAPTION_VTT_BYTES} bytes.`,
      };
    }
    text = input;
  } else {
    if (input.byteLength === 0) {
      return {
        ok: false,
        code: "EMPTY_CAPTION",
        status: 422,
        message: "WebVTT caption file is empty.",
      };
    }
    if (input.byteLength > MAX_CAPTION_VTT_BYTES) {
      return {
        ok: false,
        code: "CAPTION_TOO_LARGE",
        status: 413,
        message: `WebVTT caption file exceeds maximum ${MAX_CAPTION_VTT_BYTES} bytes.`,
      };
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return {
        ok: false,
        code: "INVALID_UTF8",
        status: 422,
        message: "WebVTT caption file must be valid UTF-8 text.",
      };
    }
  }

  // Strip optional UTF-8 BOM and normalize line endings
  if (text.startsWith("\uFEFF")) {
    text = text.slice(1);
  }
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Reject disallowed ASCII control characters
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f)) {
      return {
        ok: false,
        code: "INVALID_WEBVTT_CUE",
        status: 422,
        message: "WebVTT caption contains forbidden control characters.",
      };
    }
  }

  const lines = text.split("\n");
  const firstLine = lines[0] ?? "";
  if (
    firstLine !== "WEBVTT" &&
    !firstLine.startsWith("WEBVTT ") &&
    !firstLine.startsWith("WEBVTT\t")
  ) {
    return {
      ok: false,
      code: "INVALID_WEBVTT_HEADER",
      status: 422,
      message: 'WebVTT file must begin with the "WEBVTT" header on line 1.',
    };
  }

  // Split remaining content into blank-line-delimited blocks
  const restText = lines.slice(1).join("\n").trim();
  if (!restText) {
    return {
      ok: false,
      code: "INVALID_WEBVTT_CUE",
      status: 422,
      message: "WebVTT file must contain at least one valid caption cue.",
    };
  }

  const rawBlocks = restText.split(/\n{2,}/);
  const sanitizedCues: string[] = [];
  let strippedHtmlAny = false;

  for (const rawBlock of rawBlocks) {
    const blockLines = rawBlock.split("\n").map((l) => l.trimEnd());
    const head = (blockLines[0] ?? "").trim();
    if (!head) continue;

    // Skip NOTE comments cleanly
    if (head === "NOTE" || head.startsWith("NOTE ") || head.startsWith("NOTE\t")) {
      continue;
    }

    // Reject STYLE and REGION blocks (prevents CSS injection)
    if (head === "STYLE" || head.startsWith("STYLE ") || head === "REGION" || head.startsWith("REGION ")) {
      return {
        ok: false,
        code: "FORBIDDEN_WEBVTT_STYLE",
        status: 422,
        message: "WebVTT STYLE/REGION blocks are forbidden for security.",
      };
    }

    // Determine whether line 0 is an optional cue identifier or the timing line
    let timingIdx = 0;
    if (!head.includes("-->")) {
      if (blockLines.length < 2 || !(blockLines[1] ?? "").includes("-->")) {
        return {
          ok: false,
          code: "INVALID_WEBVTT_CUE",
          status: 422,
          message: `Malformed WebVTT cue block near "${head.slice(0, 40)}".`,
        };
      }
      timingIdx = 1;
    }

    const timingLine = (blockLines[timingIdx] ?? "").trim();
    const arrowIdx = timingLine.indexOf("-->");
    if (arrowIdx === -1) {
      return {
        ok: false,
        code: "INVALID_WEBVTT_CUE",
        status: 422,
        message: "Missing WebVTT cue timing separator (-->).",
      };
    }

    const startToken = timingLine.slice(0, arrowIdx).trim();
    const rightParts = timingLine
      .slice(arrowIdx + 3)
      .trim()
      .split(/\s+/)
      .filter((p) => p.length > 0);
    const endToken = rightParts[0] ?? "";
    const settingTokens = rightParts.slice(1);

    const startMs = parseVttTimestampMs(startToken);
    const endMs = parseVttTimestampMs(endToken);
    if (startMs === null || endMs === null || endMs <= startMs) {
      return {
        ok: false,
        code: "INVALID_WEBVTT_CUE",
        status: 422,
        message: `Invalid WebVTT cue timing "${timingLine}".`,
      };
    }

    // Keep only safe allowlisted cue settings
    const safeSettings: string[] = [];
    for (const token of settingTokens) {
      if (!ALLOWED_VTT_SETTING_RE.test(token)) {
        return {
          ok: false,
          code: "INVALID_WEBVTT_CUE",
          status: 422,
          message: `Unsupported WebVTT cue setting "${token}".`,
        };
      }
      safeSettings.push(token);
    }

    const payloadLines = blockLines.slice(timingIdx + 1);
    if (payloadLines.length === 0) {
      return {
        ok: false,
        code: "INVALID_WEBVTT_CUE",
        status: 422,
        message: "WebVTT cue must include caption text.",
      };
    }

    const cleaned = sanitizeCuePayloadText(payloadLines);
    if (cleaned.strippedHtml) strippedHtmlAny = true;
    if (!cleaned.text) {
      return {
        ok: false,
        code: "INVALID_WEBVTT_CUE",
        status: 422,
        message: "WebVTT cue contains no valid plain text after HTML/script sanitization.",
      };
    }

    const normalizedTiming =
      safeSettings.length > 0
        ? `${startToken} --> ${endToken} ${safeSettings.join(" ")}`
        : `${startToken} --> ${endToken}`;
    sanitizedCues.push(`${normalizedTiming}\n${cleaned.text}`);

    if (sanitizedCues.length > MAX_CAPTION_CUES) {
      return {
        ok: false,
        code: "TOO_MANY_CUES",
        status: 422,
        message: `WebVTT exceeds maximum ${MAX_CAPTION_CUES} cues.`,
      };
    }
  }

  if (sanitizedCues.length === 0) {
    return {
      ok: false,
      code: "INVALID_WEBVTT_CUE",
      status: 422,
      message: "WebVTT file contains zero valid cues.",
    };
  }

  const sanitizedVtt = `WEBVTT\n\n${sanitizedCues.join("\n\n")}\n`;
  const sanitizedBytes = new TextEncoder().encode(sanitizedVtt);
  return {
    ok: true,
    sanitizedVtt,
    sanitizedBytes,
    cueCount: sanitizedCues.length,
    strippedHtml: strippedHtmlAny,
  };
}

// ---------------------------------------------------------------------------
// 9. Video Placement Guard (Hero Rejected!) & Safe Public Media URL Sanitizers
// ---------------------------------------------------------------------------

export type ValidateVideoPlacementResult =
  | { readonly ok: true; readonly placement: (typeof ALLOWED_VIDEO_PLACEMENTS)[number] }
  | {
      readonly ok: false;
      readonly code: "VIDEO_HERO_PLACEMENT_FORBIDDEN" | "INVALID_VIDEO_PLACEMENT";
      readonly status: 422;
      readonly message: string;
      readonly messageId: string;
    };

/**
 * Strictly rejects `hero` placement for short videos (REQ-062, REQ-040; PLAN §7.3).
 */
export function validateVideoPlacement(rawPlacement: unknown): ValidateVideoPlacementResult {
  if (typeof rawPlacement !== "string") {
    return {
      ok: false,
      code: "INVALID_VIDEO_PLACEMENT",
      status: 422,
      message: "Video placement must be a valid section placement string.",
      messageId: "Lokasi penempatan video tidak valid.",
    };
  }

  const normalized = rawPlacement.trim().toLowerCase();
  if (normalized === "hero") {
    return {
      ok: false,
      code: "VIDEO_HERO_PLACEMENT_FORBIDDEN",
      status: 422,
      message:
        "Video placement in the hero section is strictly forbidden (REQ-062). Use a WebP hero image instead.",
      messageId:
        "Video tidak diizinkan pada bagian Hero agar kecepatan muat (LCP) tetap optimal. Tempatkan video di Portofolio, Galeri, Penawaran, atau Artikel.",
    };
  }

  if ((ALLOWED_VIDEO_PLACEMENTS as readonly string[]).includes(normalized)) {
    return {
      ok: true,
      placement: normalized as (typeof ALLOWED_VIDEO_PLACEMENTS)[number],
    };
  }

  return {
    ok: false,
    code: "INVALID_VIDEO_PLACEMENT",
    status: 422,
    message: `Unsupported video placement "${rawPlacement}". Allowed: ${ALLOWED_VIDEO_PLACEMENTS.join(", ")}.`,
    messageId: "Lokasi penempatan video tidak didukung.",
  };
}

export interface ShortVideoBlockInput {
  readonly mediaId: number;
  readonly src: string;
  readonly posterUrl: string;
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly placement: string;
  readonly caption?: string | null;
  readonly captionsUrl?: string | null;
  readonly captionsLang?: string | null;
  readonly captionsLabel?: string | null;
  readonly durationSeconds?: number | null;
  readonly autoplay?: boolean;
}

export interface ShortVideoBlock {
  readonly kind: "video";
  readonly mediaId: number;
  readonly src: string;
  readonly posterUrl: string;
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly placement: (typeof ALLOWED_VIDEO_PLACEMENTS)[number];
  readonly autoplay: false;
  readonly preload: "none";
  readonly playsinline: true;
  readonly controls: true;
  readonly caption?: string | null;
  readonly captionsUrl?: string | null;
  readonly captionsLang?: string;
  readonly captionsLabel?: string;
  readonly durationSeconds?: number | null;
}

export type CreateShortVideoBlockResult =
  | { readonly ok: true; readonly block: ShortVideoBlock }
  | {
      readonly ok: false;
      readonly field: string;
      readonly code: string;
      readonly message: string;
      readonly messageId: string;
    };

/**
 * Validates that a public video / poster / caption URL is either a safe
 * tenant-relative path (`/media/...` or `/t/...`) or an `https://` URL,
 * never a `/quarantine/` path, `javascript:`, `data:`, or traversal `..`.
 */
export function sanitizePublicVideoAssetUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 1024 || /\s/.test(trimmed)) return null;
  if (trimmed.includes("..") || trimmed.includes("\\") || trimmed.includes("\0")) return null;
  if (/[\r\n\t]/.test(trimmed)) return null;

  const lower = trimmed.toLowerCase();
  if (lower.includes("/quarantine/") || lower.includes("%2e%2e") || lower.includes("%5c")) {
    return null;
  }

  if (trimmed.startsWith("/media/") || trimmed.startsWith("/t/")) {
    return trimmed;
  }

  if (trimmed.startsWith("https://")) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
      if (parsed.pathname.toLowerCase().includes("/quarantine/")) return null;
      return parsed.toString();
    } catch {
      return null;
    }
  }

  return null;
}

export function createShortVideoBlock(
  input: ShortVideoBlockInput,
): CreateShortVideoBlockResult {
  const placementCheck = validateVideoPlacement(input.placement);
  if (!placementCheck.ok) {
    return {
      ok: false,
      field: "placement",
      code: placementCheck.code,
      message: placementCheck.message,
      messageId: placementCheck.messageId,
    };
  }

  if (input.autoplay === true) {
    return {
      ok: false,
      field: "autoplay",
      code: "VIDEO_AUTOPLAY_FORBIDDEN",
      message: "Autoplay is strictly forbidden on short videos (REQ-062).",
      messageId: "Putar otomatis (autoplay) tidak diizinkan pada video pendek.",
    };
  }

  if (!Number.isInteger(input.mediaId) || input.mediaId < 1) {
    return {
      ok: false,
      field: "mediaId",
      code: "INVALID_MEDIA_ID",
      message: "mediaId must be a positive integer.",
      messageId: "Pilih video siap pakai dari Pustaka Media terlebih dahulu.",
    };
  }

  const safeSrc = sanitizePublicVideoAssetUrl(input.src);
  if (!safeSrc) {
    return {
      ok: false,
      field: "src",
      code: "INVALID_VIDEO_URL",
      message: "Video src must be a published tenant media URL (quarantine URLs are forbidden).",
      messageId: "URL video tidak valid atau belum selesai diproses.",
    };
  }

  const safePoster = sanitizePublicVideoAssetUrl(input.posterUrl);
  if (!safePoster) {
    return {
      ok: false,
      field: "posterUrl",
      code: "INVALID_POSTER_URL",
      message: "Video poster must be a published WebP media URL.",
      messageId: "URL poster video tidak valid.",
    };
  }

  if (
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    input.width > MAX_VIDEO_WIDTH ||
    input.height > MAX_VIDEO_HEIGHT
  ) {
    return {
      ok: false,
      field: "dimensions",
      code: "OVERSIZED_DIMENSIONS",
      message: `Video dimensions must be between 1x1 and ${MAX_VIDEO_WIDTH}x${MAX_VIDEO_HEIGHT}.`,
      messageId: `Dimensi video harus antara 1×1 hingga ${MAX_VIDEO_WIDTH}×${MAX_VIDEO_HEIGHT} px.`,
    };
  }

  const title = input.title.trim();
  if (title.length < 1 || title.length > MAX_VIDEO_TITLE_LENGTH) {
    return {
      ok: false,
      field: "title",
      code: "INVALID_TITLE",
      message: `Video title must be between 1 and ${MAX_VIDEO_TITLE_LENGTH} characters.`,
      messageId: `Judul video wajib diisi (1–${MAX_VIDEO_TITLE_LENGTH} karakter).`,
    };
  }

  let safeCaptionsUrl: string | null = null;
  if (input.captionsUrl !== undefined && input.captionsUrl !== null && input.captionsUrl.trim() !== "") {
    safeCaptionsUrl = sanitizePublicVideoAssetUrl(input.captionsUrl);
    if (!safeCaptionsUrl) {
      return {
        ok: false,
        field: "captionsUrl",
        code: "INVALID_CAPTIONS_URL",
        message: "Captions URL must be a valid published tenant media URL.",
        messageId: "URL takarir (WebVTT) tidak valid.",
      };
    }
  }

  const safeLang = validateCaptionLanguageTag(input.captionsLang) ?? "id";
  const safeCaption = input.caption?.trim().slice(0, MAX_VIDEO_CAPTION_TEXT_LENGTH) || null;
  const safeCaptionsLabel = input.captionsLabel?.trim().slice(0, 60) || "Bahasa Indonesia";

  return {
    ok: true,
    block: {
      kind: "video",
      mediaId: input.mediaId,
      src: safeSrc,
      posterUrl: safePoster,
      width: input.width,
      height: input.height,
      title,
      placement: placementCheck.placement,
      autoplay: false,
      preload: "none",
      playsinline: true,
      controls: true,
      ...(safeCaption ? { caption: safeCaption } : {}),
      ...(safeCaptionsUrl
        ? {
            captionsUrl: safeCaptionsUrl,
            captionsLang: safeLang,
            captionsLabel: safeCaptionsLabel,
          }
        : {}),
      ...(typeof input.durationSeconds === "number" && Number.isFinite(input.durationSeconds)
        ? { durationSeconds: input.durationSeconds }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 10. Tenant-Scoped Video Derivative R2 Key Builders
// ---------------------------------------------------------------------------

export function buildVideoDerivativeKeys(
  tenantId: string,
  mediaId: number,
  originalFilenameOrSlug: string,
): VideoDerivativeKeys {
  if (!Number.isInteger(mediaId) || mediaId < 1) {
    throw new InvalidTenantR2KeyError("mediaId must be a positive sequential integer.");
  }
  const safeTenantId = tenantId.trim();
  const slug = slugifyMediaFilename(originalFilenameOrSlug);
  const base = `t/${safeTenantId}/media/${mediaId}/${slug}`;
  const keys: VideoDerivativeKeys = {
    video: `${base}.mp4`,
    poster: `${base}-poster.webp`,
    captions: `${base}-captions.vtt`,
  };
  assertTenantR2Key(safeTenantId, keys.video, ["media"]);
  assertTenantR2Key(safeTenantId, keys.poster, ["media"]);
  assertTenantR2Key(safeTenantId, keys.captions, ["media"]);
  return keys;
}

export function buildVideoPosterQuarantineKey(
  tenantId: string,
  intentId: string,
  originalFilenameOrSlug: string,
): string {
  const safeTenantId = tenantId.trim();
  const safeIntentId = intentId.trim();
  const slug = slugifyMediaFilename(originalFilenameOrSlug);
  const key = `t/${safeTenantId}/quarantine/${safeIntentId}/${slug}-poster`;
  assertTenantR2Key(safeTenantId, key, ["quarantine"]);
  return key;
}

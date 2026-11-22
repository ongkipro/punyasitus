/**
 * Media Library validation, magic-byte sniffing, real pixel dimension parsing,
 * bounded streaming byte counter, deterministic SEO derivative filenames, and
 * strict tenant-scoped R2 key guards (REQ-010, REQ-064; PLAN §7.2–7.3).
 *
 * Runtime-neutral: works identically in Node unit tests and Cloudflare `workerd`.
 */

export const MAX_SOURCE_UPLOAD_BYTES = 5_000_000 as const;
export const MAX_NORMALIZED_MASTER_BYTES = 2_000_000 as const;
export const MAX_NORMALIZED_MASTER_EDGE_PX = 2_560 as const;
export const MAX_OG_DERIVATIVE_BYTES = 307_200 as const; // 300 KiB (PLAN §7.3)
export const MAX_PIXEL_WIDTH = 8_000 as const;
export const MAX_PIXEL_HEIGHT = 8_000 as const;
export const MAX_TOTAL_PIXELS = 40_000_000 as const;

export const ELIGIBLE_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/tiff",
] as const;

export type EligibleImageMime = (typeof ELIGIBLE_IMAGE_MIMES)[number];

export type MediaRejectionCode =
  | "EMPTY_FILE"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_FORMAT_SVG"
  | "UNSUPPORTED_FORMAT_BMP"
  | "UNSUPPORTED_FORMAT_AVIF"
  | "VIDEO_NOT_SUPPORTED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "CORRUPT_IMAGE"
  | "MIME_SPOOFING"
  | "OVERSIZED_DIMENSIONS";

export interface InspectedImageSuccess {
  readonly ok: true;
  readonly mimeType: EligibleImageMime;
  readonly format: "jpeg" | "png" | "webp" | "heic" | "heif" | "gif" | "tiff";
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
}

export interface InspectedImageFailure {
  readonly ok: false;
  readonly code: MediaRejectionCode;
  readonly status: 413 | 415 | 422;
  readonly message: string;
}

export type InspectImageResult = InspectedImageSuccess | InspectedImageFailure;

export type BoundedStreamResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly byteLength: number }
  | {
      readonly ok: false;
      readonly code: "EMPTY_FILE" | "PAYLOAD_TOO_LARGE";
      readonly status: 413 | 422;
      readonly bytesRead: number;
      readonly message: string;
    };

export class InvalidTenantR2KeyError extends Error {
  readonly code = "INVALID_R2_KEY" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidTenantR2KeyError";
  }
}

export interface MediaDerivativeKeys {
  readonly master: string;
  readonly w640: string;
  readonly w1280: string;
  readonly thumb: string;
  readonly og: string;
}

export interface MediaVariantEntry {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly mimeType: "image/webp";
}

export interface MediaVariantsManifest {
  readonly slug: string;
  readonly master: MediaVariantEntry;
  readonly w640: MediaVariantEntry;
  readonly w1280: MediaVariantEntry;
  readonly thumb: MediaVariantEntry;
  readonly og: MediaVariantEntry;
}

/**
 * Official Cloudflare Workers Images Binding structural interface.
 * Matches `env.IMAGES` in production Cloudflare Workers and allows deterministic
 * `workerd` integration test doubles.
 */
export interface CloudflareImagesTransformOptions {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: "scale-down" | "contain" | "cover" | "crop" | "pad" | "squeeze";
  readonly quality?: number;
  readonly metadata?: "none" | "copyright" | "keep";
  readonly anim?: boolean;
}

export interface CloudflareImagesOutputOptions {
  readonly format: "image/webp" | "image/avif" | "image/jpeg" | "image/png";
  readonly quality?: number;
}

export interface CloudflareImagesOutputResult {
  image(): ReadableStream<Uint8Array>;
  response(): Response;
  contentType(): string;
}

export interface CloudflareImagesTransformPipeline {
  transform(options: CloudflareImagesTransformOptions): CloudflareImagesTransformPipeline;
  output(options: CloudflareImagesOutputOptions): Promise<CloudflareImagesOutputResult>;
}

export interface CloudflareImagesBinding {
  input(stream: ReadableStream<Uint8Array>): CloudflareImagesTransformPipeline;
}

// ---------------------------------------------------------------------------
// 1. Streaming Hard Byte Counter (NEVER buffers unbounded uploads)
// ---------------------------------------------------------------------------

/**
 * Reads a `ReadableStream<Uint8Array>` with a strict cumulative byte ceiling.
 * Aborts and cancels the stream immediately the instant cumulative bytes exceed
 * `maxBytes` (e.g. 5,000,001 bytes aborts without buffering the over-limit chunk).
 */
export async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number = MAX_SOURCE_UPLOAD_BYTES,
): Promise<BoundedStreamResult> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive integer");
  }
  if (!stream) {
    return {
      ok: false,
      code: "EMPTY_FILE",
      status: 422,
      bytesRead: 0,
      message: "Upload body is empty.",
    };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel("PAYLOAD_TOO_LARGE");
        } catch {
          // Stream may already be errored/closed by runtime
        }
        return {
          ok: false,
          code: "PAYLOAD_TOO_LARGE",
          status: 413,
          bytesRead: totalBytes,
          message: `Upload size exceeded the maximum allowed ${maxBytes} bytes.`,
        };
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released
    }
  }

  if (totalBytes === 0) {
    return {
      ok: false,
      code: "EMPTY_FILE",
      status: 422,
      bytesRead: 0,
      message: "Upload body is empty (0 bytes).",
    };
  }

  if (chunks.length === 1 && chunks[0]) {
    return { ok: true, bytes: chunks[0], byteLength: totalBytes };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: combined, byteLength: totalBytes };
}

// ---------------------------------------------------------------------------
// 2. Magic-Byte Sniffing & Real Header Pixel Dimension Parsers
// ---------------------------------------------------------------------------

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
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

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  const end = Math.min(bytes.byteLength, offset + length);
  for (let i = offset; i < end; i += 1) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

function looksLikeSvgOrMarkup(bytes: Uint8Array): boolean {
  let start = 0;
  // Strip UTF-8 BOM if present
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    start = 3;
  }
  const sampleLen = Math.min(bytes.byteLength - start, 1024);
  if (sampleLen <= 0) return false;
  const sample = readAscii(bytes, start, sampleLen).trimStart().toLowerCase();
  if (
    sample.startsWith("<svg") ||
    sample.startsWith("<?xml") ||
    sample.startsWith("<!doctype") ||
    sample.startsWith("<html") ||
    sample.startsWith("<script") ||
    sample.includes("<svg")
  ) {
    return true;
  }
  return false;
}

function isPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  const ihdrLen = readUint32BE(bytes, 8);
  const chunkType = readAscii(bytes, 12, 4);
  if (ihdrLen !== 13 || chunkType !== "IHDR") return null;
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function isJpegSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isJpegSofMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  const len = bytes.byteLength;

  while (offset + 1 < len) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    while (offset < len && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= len) return null;

    const marker = bytes[offset] ?? 0;
    offset += 1;

    // Standalone markers with no payload length
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    // EOI or SOS before finding SOF means corrupt/incomplete header
    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }

    if (offset + 2 > len) return null;
    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > len) {
      return null;
    }

    if (isJpegSofMarker(marker)) {
      if (segmentLength < 7) return null;
      const height = readUint16BE(bytes, offset + 3);
      const width = readUint16BE(bytes, offset + 5);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }

    offset += segmentLength;
  }

  return null;
}

function isWebpSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 16 &&
    readAscii(bytes, 0, 4) === "RIFF" &&
    readAscii(bytes, 8, 4) === "WEBP"
  );
}

function parseWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 20) return null;
  const chunk = readAscii(bytes, 12, 4);

  if (chunk === "VP8 ") {
    if (bytes.byteLength < 30) return null;
    // Keyframe start code 0x9D 0x01 0x2A at byte 23..25
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return null;
    }
    const width = readUint16LE(bytes, 26) & 0x3fff;
    const height = readUint16LE(bytes, 28) & 0x3fff;
    if (width === 0 || height === 0) return null;
    return { width, height };
  }

  if (chunk === "VP8L") {
    if (bytes.byteLength < 25) return null;
    if (bytes[20] !== 0x2f) return null;
    const bits = readUint32LE(bytes, 21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    if (width === 0 || height === 0) return null;
    return { width, height };
  }

  if (chunk === "VP8X") {
    if (bytes.byteLength < 30) return null;
    const width = 1 + readUint24LE(bytes, 24);
    const height = 1 + readUint24LE(bytes, 27);
    if (width === 0 || height === 0) return null;
    return { width, height };
  }

  return null;
}

function isGifSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 6) return false;
  const hdr = readAscii(bytes, 0, 6);
  return hdr === "GIF87a" || hdr === "GIF89a";
}

function parseGifDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 10) return null;
  const width = readUint16LE(bytes, 6);
  const height = readUint16LE(bytes, 8);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function isTiffSignature(bytes: Uint8Array): "le" | "be" | null {
  if (bytes.byteLength < 8) return null;
  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) {
    return "le";
  }
  if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a) {
    return "be";
  }
  return null;
}

function parseTiffDimensions(
  bytes: Uint8Array,
  endian: "le" | "be",
): { width: number; height: number } | null {
  const u16 = endian === "le" ? readUint16LE : readUint16BE;
  const u32 = endian === "le" ? readUint32LE : readUint32BE;

  const ifdOffset = u32(bytes, 4);
  if (ifdOffset < 8 || ifdOffset + 2 > bytes.byteLength) return null;

  const entryCount = u16(bytes, ifdOffset);
  if (entryCount === 0 || entryCount > 512) return null;
  if (ifdOffset + 2 + entryCount * 12 > bytes.byteLength) return null;

  let width = 0;
  let height = 0;

  for (let i = 0; i < entryCount; i += 1) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const tag = u16(bytes, entryOffset);
    const fieldType = u16(bytes, entryOffset + 2);
    const count = u32(bytes, entryOffset + 4);

    if ((tag === 256 || tag === 257) && count === 1) {
      let value: number;
      if (fieldType === 3) {
        // SHORT (2 bytes stored at start of 4-byte value field)
        value = u16(bytes, entryOffset + 8);
      } else if (fieldType === 4) {
        // LONG (4 bytes)
        value = u32(bytes, entryOffset + 8);
      } else {
        continue;
      }
      if (tag === 256) width = value;
      if (tag === 257) height = value;
    }
  }

  if (width === 0 || height === 0) return null;
  return { width, height };
}

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);
const VIDEO_FTYP_BRANDS = new Set([
  "isom",
  "iso2",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "M4V ",
  "M4A ",
  "qt  ",
  "avc1",
  "3gp4",
  "3gp5",
  "3gp6",
  "MSNV",
  "dash",
  "f4v ",
]);

interface IsoBmffBox {
  readonly type: string;
  readonly start: number;
  readonly headerSize: number;
  readonly end: number;
}

function readBmffBox(bytes: Uint8Array, offset: number, limit: number): IsoBmffBox | null {
  if (offset + 8 > limit) return null;
  let size = readUint32BE(bytes, offset);
  const type = readAscii(bytes, offset + 4, 4);
  let headerSize = 8;

  if (size === 0) {
    size = limit - offset;
  } else if (size === 1) {
    if (offset + 16 > limit) return null;
    const hi = readUint32BE(bytes, offset + 8);
    const lo = readUint32BE(bytes, offset + 12);
    if (hi > 0) return null; // > 4 GiB exceeds any valid upload
    size = lo;
    headerSize = 16;
  }

  if (size < headerSize || offset + size > limit) return null;
  return { type, start: offset, headerSize, end: offset + size };
}

function findIspeDimensionsInRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  depth = 0,
): { width: number; height: number } | null {
  if (depth > 6) return null;
  let cursor = start;
  let best: { width: number; height: number } | null = null;

  while (cursor + 8 <= end) {
    const box = readBmffBox(bytes, cursor, end);
    if (!box) break;

    if (box.type === "ispe") {
      // FullBox: 4-byte version/flags + 4-byte width + 4-byte height
      const payloadStart = box.start + box.headerSize;
      if (payloadStart + 12 <= box.end) {
        const width = readUint32BE(bytes, payloadStart + 4);
        const height = readUint32BE(bytes, payloadStart + 8);
        if (width > 0 && height > 0) {
          if (!best || width * height > best.width * best.height) {
            best = { width, height };
          }
        }
      }
    } else if (box.type === "meta") {
      // `meta` is a FullBox (4 bytes version/flags before child boxes)
      const childStart = box.start + box.headerSize + 4;
      if (childStart < box.end) {
        const nested = findIspeDimensionsInRange(bytes, childStart, box.end, depth + 1);
        if (nested && (!best || nested.width * nested.height > best.width * best.height)) {
          best = nested;
        }
      }
    } else if (box.type === "iprp" || box.type === "ipco") {
      const childStart = box.start + box.headerSize;
      const nested = findIspeDimensionsInRange(bytes, childStart, box.end, depth + 1);
      if (nested && (!best || nested.width * nested.height > best.width * best.height)) {
        best = nested;
      }
    }

    if (box.end <= cursor) break;
    cursor = box.end;
  }

  return best;
}

function inspectIsoBmff(
  bytes: Uint8Array,
):
  | { readonly kind: "heic" | "heif"; readonly width: number; readonly height: number }
  | { readonly kind: "avif" }
  | { readonly kind: "video" }
  | { readonly kind: "corrupt" }
  | null {
  if (bytes.byteLength < 16 || readAscii(bytes, 4, 4) !== "ftyp") {
    return null;
  }
  const ftypBox = readBmffBox(bytes, 0, bytes.byteLength);
  if (!ftypBox || ftypBox.end < 16) {
    return { kind: "corrupt" };
  }

  const majorBrand = readAscii(bytes, 8, 4);
  const allBrands = new Set<string>([majorBrand]);
  for (let pos = 16; pos + 4 <= ftypBox.end; pos += 4) {
    allBrands.add(readAscii(bytes, pos, 4));
  }

  // Explicitly reject AVIF (Cloudflare Images AVIF input is Enterprise-only; browser island converts client-side)
  for (const b of allBrands) {
    if (AVIF_BRANDS.has(b)) {
      return { kind: "avif" };
    }
  }

  let isHeic = HEIC_BRANDS.has(majorBrand);
  let isHeif = HEIF_BRANDS.has(majorBrand);
  for (const b of allBrands) {
    if (HEIC_BRANDS.has(b)) isHeic = true;
    if (HEIF_BRANDS.has(b)) isHeif = true;
  }

  if (!isHeic && !isHeif) {
    for (const b of allBrands) {
      if (VIDEO_FTYP_BRANDS.has(b)) {
        return { kind: "video" };
      }
    }
    return null;
  }

  // Reject video containers masquerading with mif1 compatible brand if majorBrand is a video brand
  if (VIDEO_FTYP_BRANDS.has(majorBrand) && !HEIC_BRANDS.has(majorBrand)) {
    return { kind: "video" };
  }

  const dims = findIspeDimensionsInRange(bytes, ftypBox.end, bytes.byteLength, 0);
  if (!dims) {
    return { kind: "corrupt" };
  }

  return {
    kind: isHeic ? "heic" : "heif",
    width: dims.width,
    height: dims.height,
  };
}

function isVideoContainerSignature(bytes: Uint8Array): boolean {
  // WebM / Matroska EBML header
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return true;
  }
  // AVI
  if (
    bytes.byteLength >= 12 &&
    readAscii(bytes, 0, 4) === "RIFF" &&
    readAscii(bytes, 8, 4) === "AVI "
  ) {
    return true;
  }
  // Ogg
  if (bytes.byteLength >= 4 && readAscii(bytes, 0, 4) === "OggS") {
    return true;
  }
  // FLV
  if (bytes.byteLength >= 4 && readAscii(bytes, 0, 3) === "FLV" && bytes[3] === 0x01) {
    return true;
  }
  return false;
}

function isMimeCompatible(detectedMime: EligibleImageMime, declaredMime: string): boolean {
  const normalized = (declaredMime.split(";")[0] ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === detectedMime) return true;
  // iOS/macOS commonly interchange image/heic and image/heif for HEIF image containers
  if (
    (detectedMime === "image/heic" || detectedMime === "image/heif") &&
    (normalized === "image/heic" || normalized === "image/heif")
  ) {
    return true;
  }
  return false;
}

function validatePixelBounds(
  width: number,
  height: number,
): { ok: true } | InspectedImageFailure {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return {
      ok: false,
      code: "CORRUPT_IMAGE",
      status: 422,
      message: "Image dimensions are invalid or missing.",
    };
  }
  if (
    width > MAX_PIXEL_WIDTH ||
    height > MAX_PIXEL_HEIGHT ||
    width * height > MAX_TOTAL_PIXELS
  ) {
    return {
      ok: false,
      code: "OVERSIZED_DIMENSIONS",
      status: 422,
      message: `Image dimensions (${width}x${height}) exceed the maximum ${MAX_PIXEL_WIDTH}x${MAX_PIXEL_HEIGHT} or ${MAX_TOTAL_PIXELS} total pixels.`,
    };
  }
  return { ok: true };
}

/**
 * Inspects raw binary upload bytes via magic-byte sniffing and real header
 * dimension parsing. Enforces:
 * - Size <= 5,000,000 bytes and > 0 bytes
 * - Eligible formats: JPG/JPEG, PNG, WebP, HEIC/HEIF, GIF (first frame), TIFF
 * - Explicit rejection of SVG/XML/HTML, BMP, AVIF, and video formats (MP4/MOV/WebM/etc.)
 * - Real width/height <= 8000x8000 and total pixels <= 40,000,000
 * - Strict MIME spoofing rejection when `declaredMime` disagrees with detected magic bytes
 */
export function inspectImageBinary(
  bytes: Uint8Array,
  declaredMime?: string,
): InspectImageResult {
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      code: "EMPTY_FILE",
      status: 422,
      message: "Empty image upload is rejected.",
    };
  }

  if (bytes.byteLength > MAX_SOURCE_UPLOAD_BYTES) {
    return {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
      message: `Image exceeds the maximum ${MAX_SOURCE_UPLOAD_BYTES} byte upload ceiling.`,
    };
  }

  // Reject SVG / XML / HTML even if disguised with a raster extension or MIME
  if (looksLikeSvgOrMarkup(bytes)) {
    return {
      ok: false,
      code: "UNSUPPORTED_FORMAT_SVG",
      status: 415,
      message: "SVG and XML/HTML payloads are forbidden in the Media Library.",
    };
  }

  // Reject BMP explicitly
  if (bytes.byteLength >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return {
      ok: false,
      code: "UNSUPPORTED_FORMAT_BMP",
      status: 415,
      message: "BMP images are not supported. Upload JPG, PNG, WebP, HEIC, GIF, or TIFF.",
    };
  }

  // Reject non-BMFF video containers (WebM, AVI, Ogg, FLV)
  if (isVideoContainerSignature(bytes)) {
    return {
      ok: false,
      code: "VIDEO_NOT_SUPPORTED",
      status: 415,
      message: "Video uploads are not accepted by the image media pipeline.",
    };
  }

  let detectedFormat: InspectedImageSuccess["format"] | null = null;
  let detectedMime: EligibleImageMime | null = null;
  let dims: { width: number; height: number } | null = null;

  if (isPngSignature(bytes)) {
    detectedFormat = "png";
    detectedMime = "image/png";
    dims = parsePngDimensions(bytes);
  } else if (isJpegSignature(bytes)) {
    detectedFormat = "jpeg";
    detectedMime = "image/jpeg";
    dims = parseJpegDimensions(bytes);
  } else if (isWebpSignature(bytes)) {
    detectedFormat = "webp";
    detectedMime = "image/webp";
    dims = parseWebpDimensions(bytes);
  } else if (isGifSignature(bytes)) {
    detectedFormat = "gif";
    detectedMime = "image/gif";
    dims = parseGifDimensions(bytes);
  } else {
    const tiffEndian = isTiffSignature(bytes);
    if (tiffEndian) {
      detectedFormat = "tiff";
      detectedMime = "image/tiff";
      dims = parseTiffDimensions(bytes, tiffEndian);
    } else {
      const bmff = inspectIsoBmff(bytes);
      if (bmff) {
        if (bmff.kind === "avif") {
          return {
            ok: false,
            code: "UNSUPPORTED_FORMAT_AVIF",
            status: 415,
            message:
              "AVIF images must be converted client-side to PNG or WebP before upload.",
          };
        }
        if (bmff.kind === "video") {
          return {
            ok: false,
            code: "VIDEO_NOT_SUPPORTED",
            status: 415,
            message: "Video uploads are not accepted by the image media pipeline.",
          };
        }
        if (bmff.kind === "corrupt") {
          return {
            ok: false,
            code: "CORRUPT_IMAGE",
            status: 422,
            message: "Corrupt or incomplete HEIC/HEIF container header.",
          };
        }
        detectedFormat = bmff.kind;
        detectedMime = bmff.kind === "heic" ? "image/heic" : "image/heif";
        dims = { width: bmff.width, height: bmff.height };
      }
    }
  }

  if (!detectedFormat || !detectedMime) {
    // If client explicitly declared a video MIME type, give a clear rejection
    const normDeclared = (declaredMime?.split(";")[0] ?? "").trim().toLowerCase();
    if (normDeclared.startsWith("video/")) {
      return {
        ok: false,
        code: "VIDEO_NOT_SUPPORTED",
        status: 415,
        message: "Video uploads are not accepted by the image media pipeline.",
      };
    }
    return {
      ok: false,
      code: "CORRUPT_IMAGE",
      status: 422,
      message: "Unrecognized or corrupt image binary header.",
    };
  }

  if (!dims) {
    return {
      ok: false,
      code: "CORRUPT_IMAGE",
      status: 422,
      message: `Corrupt or truncated ${detectedFormat.toUpperCase()} image header.`,
    };
  }

  if (declaredMime !== undefined && !isMimeCompatible(detectedMime, declaredMime)) {
    return {
      ok: false,
      code: "MIME_SPOOFING",
      status: 422,
      message: `Declared MIME type "${declaredMime}" does not match detected image type "${detectedMime}".`,
    };
  }

  const boundsCheck = validatePixelBounds(dims.width, dims.height);
  if (!boundsCheck.ok) {
    return boundsCheck;
  }

  return {
    ok: true,
    mimeType: detectedMime,
    format: detectedFormat,
    width: dims.width,
    height: dims.height,
    byteLength: bytes.byteLength,
  };
}

// ---------------------------------------------------------------------------
// 3. Deterministic SEO Slug Naming & Tenant-Scoped R2 Key Guard
// ---------------------------------------------------------------------------

const MAX_MEDIA_SLUG_LENGTH = 60;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Generates a deterministic ASCII lowercase hyphenated slug from an uploaded filename
 * for SEO-friendly WebP derivatives (fallback: `"media"`).
 */
export function slugifyMediaFilename(originalFilename: string): string {
  const leaf = (originalFilename.split(/[/\\]/).pop() ?? "").trim();
  // Strip final extension (e.g. .jpg, .heic, .webp)
  const withoutExt = leaf.replace(/\.[A-Za-z0-9]{1,10}$/, "");
  const normalized = withoutExt
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    return "media";
  }

  if (normalized.length <= MAX_MEDIA_SLUG_LENGTH) {
    return normalized;
  }

  const sliced = normalized.slice(0, MAX_MEDIA_SLUG_LENGTH);
  const lastHyphen = sliced.lastIndexOf("-");
  const bounded = (lastHyphen >= 16 ? sliced.slice(0, lastHyphen) : sliced).replace(/-+$/g, "");
  return bounded || "media";
}

function assertSafeTenantId(tenantId: string): string {
  const trimmed = tenantId.trim();
  if (!trimmed || !SAFE_SEGMENT_RE.test(trimmed) || trimmed.includes("..")) {
    throw new InvalidTenantR2KeyError("Invalid tenantId for R2 media key.");
  }
  return trimmed;
}

export function buildQuarantineR2Key(
  tenantId: string,
  intentId: string,
  originalFilenameOrSlug: string,
): string {
  const safeTenantId = assertSafeTenantId(tenantId);
  const safeIntentId = intentId.trim();
  if (!safeIntentId || !SAFE_SEGMENT_RE.test(safeIntentId) || safeIntentId.includes("..")) {
    throw new InvalidTenantR2KeyError("Invalid intentId for quarantine R2 key.");
  }
  const slug = slugifyMediaFilename(originalFilenameOrSlug);
  const key = `t/${safeTenantId}/quarantine/${safeIntentId}/${slug}`;
  assertTenantR2Key(safeTenantId, key, ["quarantine"]);
  return key;
}

export function buildMediaDerivativeKeys(
  tenantId: string,
  mediaId: number,
  originalFilenameOrSlug: string,
): MediaDerivativeKeys {
  const safeTenantId = assertSafeTenantId(tenantId);
  if (!Number.isInteger(mediaId) || mediaId < 1) {
    throw new InvalidTenantR2KeyError("mediaId must be a positive sequential integer.");
  }
  const slug = slugifyMediaFilename(originalFilenameOrSlug);
  const base = `t/${safeTenantId}/media/${mediaId}/${slug}`;
  const keys: MediaDerivativeKeys = {
    master: `${base}-master.webp`,
    w640: `${base}-w640.webp`,
    w1280: `${base}-w1280.webp`,
    thumb: `${base}-thumb.webp`,
    og: `${base}-og.webp`,
  };
  for (const key of Object.values(keys)) {
    assertTenantR2Key(safeTenantId, key, ["media"]);
  }
  return keys;
}

/**
 * Strictly asserts that an R2 key belongs to `t/<tenantId>/(quarantine|media|trash)/...`
 * with zero path traversal (`..`), backslashes, null bytes, encoded separators, or
 * foreign tenant prefixes.
 */
export function assertTenantR2Key(
  tenantId: string,
  key: string,
  allowedAreas: readonly ("quarantine" | "media" | "trash")[] = ["quarantine", "media"],
): string {
  const safeTenantId = assertSafeTenantId(tenantId);
  if (typeof key !== "string" || key.length === 0 || key.length > 512) {
    throw new InvalidTenantR2KeyError("R2 key must be a non-empty string up to 512 chars.");
  }
  if (
    key.includes("..") ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.includes("//") ||
    /%(?:2e|2f|5c|00)/i.test(key) ||
    /[\r\n\t]/.test(key)
  ) {
    throw new InvalidTenantR2KeyError(`R2 key contains forbidden path characters: "${key}"`);
  }

  const expectedPrefix = `t/${safeTenantId}/`;
  if (!key.startsWith(expectedPrefix)) {
    throw new InvalidTenantR2KeyError(
      `R2 key does not belong to authorized tenant "${safeTenantId}".`,
    );
  }

  const remainder = key.slice(expectedPrefix.length);
  const segments = remainder.split("/");
  const area = segments[0];
  if (
    !area ||
    !(allowedAreas as readonly string[]).includes(area) ||
    segments.length < 2 ||
    segments.some((s) => s.length === 0 || s === "." || s === "..")
  ) {
    throw new InvalidTenantR2KeyError(
      `R2 key must reside under an allowed tenant media area (${allowedAreas.join(", ")}).`,
    );
  }

  return key;
}

// ---------------------------------------------------------------------------
// 4. Crypto & ULID Utilities
// ---------------------------------------------------------------------------

export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generates a Crockford Base32 26-character ULID matching `UlidSchema`.
 */
export function generateUlid(nowMs: number = Date.now()): string {
  let time = Math.max(0, Math.floor(nowMs));
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = ULID_ALPHABET[time % 32] ?? "0";
    time = Math.floor(time / 32);
  }

  const randBytes = new Uint8Array(16);
  crypto.getRandomValues(randBytes);
  const randChars = new Array<string>(16);
  for (let i = 0; i < 16; i += 1) {
    randChars[i] = ULID_ALPHABET[(randBytes[i] ?? 0) % 32] ?? "0";
  }

  return `${timeChars.join("")}${randChars.join("")}`;
}

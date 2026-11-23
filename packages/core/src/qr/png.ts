import {
  DEFAULT_QR_BACKGROUND,
  DEFAULT_QR_FOREGROUND,
  generateQrMatrix,
  normalizeQrHexColor,
  normalizeQrQuietZone,
  type QrCodeMatrix,
} from "./encoder.ts";

/**
 * Pure-TypeScript PNG encoder for QR Code bitmaps (`REQ-108`, `PLAN §20.5`).
 *
 * Emits a 100% ISO/IEC 15948 compliant 1-bit indexed-color PNG (`IHDR` + `PLTE` + `IDAT` + `IEND`)
 * using RFC 1950 zlib stored DEFLATE blocks, Adler-32, and IEEE 802.3 CRC-32.
 *
 * Security & runtime invariants:
 * - Zero third-party npm dependencies and zero Node-only APIs (`node:zlib` is not required).
 * - Synchronous and 100% deterministic in Node, Cloudflare `workerd`, and browsers.
 * - Produces crisp, high-contrast scannable PNG bytes (~15–45 KiB at default 10px/module scale).
 */

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const DEFAULT_QR_PNG_MODULE_SIZE = 10 as const;

export interface QrPngRenderOptions {
  /** Quiet zone in modules around the QR code. Clamped to 2..8 (default 4). */
  readonly quietZone?: number;
  /** Pixels per QR module. Clamped to 1..32 (default 10). */
  readonly moduleSize?: number;
  /** Foreground hex color (`#rrggbb`, default `#182522`). */
  readonly foreground?: string;
  /** Background hex color (`#rrggbb`, default `#ffffff`). */
  readonly background?: string;
}

// IEEE 802.3 CRC-32 lookup table (polynomial 0xedb88320)
const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[n] = c >>> 0;
}

function crc32Bytes(typeBytes: Uint8Array, data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < typeBytes.length; i += 1) {
    c = (CRC32_TABLE[(c ^ (typeBytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  for (let i = 0; i < data.length; i += 1) {
    c = (CRC32_TABLE[(c ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32Bytes(data: Uint8Array): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] ?? 0)) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function parseHexRgb(hex: string): readonly [number, number, number] {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return [r & 0xff, g & 0xff, b & 0xff];
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([
    type.charCodeAt(0) & 0xff,
    type.charCodeAt(1) & 0xff,
    type.charCodeAt(2) & 0xff,
    type.charCodeAt(3) & 0xff,
  ]);
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  writeUint32BE(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeUint32BE(chunk, 8 + data.length, crc32Bytes(typeBytes, data));
  return chunk;
}

/**
 * Encodes raw uncompressed PNG scanlines into a valid RFC 1950 zlib stream
 * using stored DEFLATE blocks (BTYPE=00), avoiding any runtime-specific compression API.
 */
function encodeZlibStored(raw: Uint8Array): Uint8Array {
  const MAX_BLOCK = 65535;
  const blockCount = Math.max(1, Math.ceil(raw.length / MAX_BLOCK));
  const out = new Uint8Array(2 + raw.length + blockCount * 5 + 4);

  // Zlib header: CMF=0x78 (Deflate, 32K window), FLG=0x01 (FCHECK valid: 0x7801 % 31 === 0)
  out[0] = 0x78;
  out[1] = 0x01;

  let srcOffset = 0;
  let dstOffset = 2;
  for (let b = 0; b < blockCount; b += 1) {
    const remaining = raw.length - srcOffset;
    const len = Math.min(MAX_BLOCK, remaining);
    const isFinal = b === blockCount - 1 ? 1 : 0;
    const nlen = ~len & 0xffff;

    out[dstOffset] = isFinal; // BFINAL=isFinal, BTYPE=00 (uncompressed)
    out[dstOffset + 1] = len & 0xff;
    out[dstOffset + 2] = (len >>> 8) & 0xff;
    out[dstOffset + 3] = nlen & 0xff;
    out[dstOffset + 4] = (nlen >>> 8) & 0xff;
    dstOffset += 5;

    if (len > 0) {
      out.set(raw.subarray(srcOffset, srcOffset + len), dstOffset);
      srcOffset += len;
      dstOffset += len;
    }
  }

  writeUint32BE(out, dstOffset, adler32Bytes(raw));
  return out;
}

/**
 * Renders a crisp scannable QR Code as valid binary PNG bytes (`Uint8Array`).
 * Palette index 0 = background (light), palette index 1 = foreground (dark).
 */
export function renderQrPngBytes(
  textOrMatrix: string | QrCodeMatrix,
  options: QrPngRenderOptions = {},
): Uint8Array {
  const matrix = typeof textOrMatrix === "string" ? generateQrMatrix(textOrMatrix) : textOrMatrix;
  const quietZone = normalizeQrQuietZone(options.quietZone);
  const moduleSize =
    typeof options.moduleSize === "number" && Number.isFinite(options.moduleSize)
      ? Math.max(1, Math.min(32, Math.trunc(options.moduleSize)))
      : DEFAULT_QR_PNG_MODULE_SIZE;
  const fgHex = normalizeQrHexColor(options.foreground, DEFAULT_QR_FOREGROUND);
  const bgHex = normalizeQrHexColor(options.background, DEFAULT_QR_BACKGROUND);
  const [fgR, fgG, fgB] = parseHexRgb(fgHex);
  const [bgR, bgG, bgB] = parseHexRgb(bgHex);

  const totalModules = matrix.size + quietZone * 2;
  const width = totalModules * moduleSize;
  const height = width;

  // 1-bit indexed scanlines: 1 filter byte (0 = None) + ceil(width / 8) packed pixel bytes
  const rowBytes = Math.ceil(width / 8);
  const stride = 1 + rowBytes;
  const rawScanlines = new Uint8Array(height * stride);

  // Pre-build packed row template for each module row (saves work across moduleSize repetitions)
  for (let mr = 0; mr < totalModules; mr += 1) {
    const qrRow = mr - quietZone;
    const isInQrRow = qrRow >= 0 && qrRow < matrix.size;
    const packedRow = new Uint8Array(stride);
    packedRow[0] = 0; // Filter type 0 (None)

    if (isInQrRow) {
      for (let mc = 0; mc < matrix.size; mc += 1) {
        if (matrix.modules[qrRow * matrix.size + mc] !== 1) continue;
        const startX = (mc + quietZone) * moduleSize;
        for (let dx = 0; dx < moduleSize; dx += 1) {
          const px = startX + dx;
          const byteIdx = 1 + (px >>> 3);
          const bitMask = 1 << (7 - (px & 7));
          packedRow[byteIdx] = (packedRow[byteIdx] ?? 0) | bitMask;
        }
      }
    }

    const startY = mr * moduleSize;
    for (let dy = 0; dy < moduleSize; dy += 1) {
      rawScanlines.set(packedRow, (startY + dy) * stride);
    }
  }

  // IHDR: width, height, bitDepth=1, colorType=3 (indexed), compression=0, filter=0, interlace=0
  const ihdrData = new Uint8Array(13);
  writeUint32BE(ihdrData, 0, width);
  writeUint32BE(ihdrData, 4, height);
  ihdrData[8] = 1; // bit depth: 1-bit
  ihdrData[9] = 3; // color type: indexed palette
  ihdrData[10] = 0; // compression: deflate
  ihdrData[11] = 0; // filter: adaptive
  ihdrData[12] = 0; // interlace: none

  // PLTE: index 0 = background, index 1 = foreground
  const plteData = new Uint8Array([bgR, bgG, bgB, fgR, fgG, fgB]);
  const idatData = encodeZlibStored(rawScanlines);

  const ihdrChunk = makePngChunk("IHDR", ihdrData);
  const plteChunk = makePngChunk("PLTE", plteData);
  const idatChunk = makePngChunk("IDAT", idatData);
  const iendChunk = makePngChunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(
    PNG_SIGNATURE.length +
      ihdrChunk.length +
      plteChunk.length +
      idatChunk.length +
      iendChunk.length,
  );
  let offset = 0;
  png.set(PNG_SIGNATURE, offset);
  offset += PNG_SIGNATURE.length;
  png.set(ihdrChunk, offset);
  offset += ihdrChunk.length;
  png.set(plteChunk, offset);
  offset += plteChunk.length;
  png.set(idatChunk, offset);
  offset += idatChunk.length;
  png.set(iendChunk, offset);

  return png;
}

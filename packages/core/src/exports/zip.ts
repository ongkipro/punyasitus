import { MAX_EXPORT_ARCHIVE_BYTES } from "./constants.ts";

/**
 * Pure-JS, zero-dependency PKZIP (ZIP 2.0, STORE method 0 + IEEE CRC-32 + UTF-8 flag)
 * archive builder and verifier for Node.js and Cloudflare `workerd` (REQ-107, TASK-107).
 *
 * Security invariants:
 * - Zero path traversal: rejects absolute paths, backslashes, drive letters, NUL bytes,
 *   `.` / `..` segments, and control characters before encoding any header.
 * - Strict bounded memory: verifies total entry + ZIP overhead size against `maxTotalBytes`
 *   BEFORE allocating the output buffer.
 * - Strict CRC-32 verification in `parseZipArchive` for deterministic round-trip checks.
 */

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_GENERAL_PURPOSE_FLAG = 0x0800;
const ZIP_VERSION_NEEDED = 20;
const ZIP_VERSION_MADE_BY = 20;
const COMPRESSION_STORE = 0;

const MAX_ZIP_ENTRY_NAME_BYTES = 240;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class ZipArchiveError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ZipArchiveError";
    this.code = code;
  }
}

export interface ZipEntryInput {
  readonly path: string;
  readonly data: Uint8Array | string;
  readonly modifiedAtMs?: number;
}

export interface ParsedZipEntry {
  readonly path: string;
  readonly data: Uint8Array;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly compressionMethod: number;
}

export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const idx = (crc ^ (bytes[i] ?? 0)) & 0xff;
    crc = (CRC32_TABLE[idx] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Validates and normalizes an archive entry path, guaranteeing zero path traversal,
 * zero absolute paths, zero Windows drive prefixes, and zero control/backslash characters.
 */
export function assertSafeZipEntryPath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new ZipArchiveError("ZIP_INVALID_PATH", "ZIP entry path must be non-empty.");
  }
  if (
    rawPath.includes("\\") ||
    rawPath.includes("\0") ||
    rawPath.startsWith("/") ||
    /^[A-Za-z]:/.test(rawPath) ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(rawPath)
  ) {
    throw new ZipArchiveError(
      "ZIP_PATH_TRAVERSAL",
      `Unsafe characters or absolute path in ZIP entry: "${rawPath}"`,
    );
  }

  const segments = rawPath.split("/");
  const cleanSegments: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new ZipArchiveError(
        "ZIP_PATH_TRAVERSAL",
        `Path traversal or empty segment rejected in ZIP entry: "${rawPath}"`,
      );
    }
    cleanSegments.push(seg);
  }

  const normalized = cleanSegments.join("/");
  if (textEncoder.encode(normalized).byteLength > MAX_ZIP_ENTRY_NAME_BYTES) {
    throw new ZipArchiveError("ZIP_PATH_TOO_LONG", `ZIP entry path exceeds ${MAX_ZIP_ENTRY_NAME_BYTES} bytes.`);
  }
  return normalized;
}

function encodeDosDateTime(epochMs: number): { readonly dosTime: number; readonly dosDate: number } {
  const safeMs = Number.isFinite(epochMs) ? epochMs : Date.UTC(2026, 0, 1, 0, 0, 0);
  const d = new Date(safeMs);
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const seconds = Math.floor(d.getUTCSeconds() / 2);

  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Builds a standards-compliant PKZIP archive (STORE method 0) with bounded memory ceiling.
 */
export function buildZipArchive(
  entries: readonly ZipEntryInput[],
  options: {
    readonly maxTotalBytes?: number;
    readonly defaultModifiedAtMs?: number;
  } = {},
): Uint8Array {
  const maxTotalBytes = Math.max(1024, Math.trunc(options.maxTotalBytes ?? MAX_EXPORT_ARCHIVE_BYTES));
  const defaultModifiedAtMs = options.defaultModifiedAtMs ?? Date.now();

  if (entries.length > 65_535) {
    throw new ZipArchiveError("ZIP_TOO_MANY_ENTRIES", "ZIP archive exceeds 65,535 entry limit.");
  }

  const seenPaths = new Set<string>();
  const prepared: {
    readonly nameBytes: Uint8Array;
    readonly dataBytes: Uint8Array;
    readonly crc32: number;
    readonly dosTime: number;
    readonly dosDate: number;
  }[] = [];

  let localSectionBytes = 0;
  let centralDirBytes = 0;

  for (const entry of entries) {
    const safePath = assertSafeZipEntryPath(entry.path);
    if (seenPaths.has(safePath)) {
      throw new ZipArchiveError("ZIP_DUPLICATE_PATH", `Duplicate ZIP entry path: "${safePath}"`);
    }
    seenPaths.add(safePath);

    const nameBytes = textEncoder.encode(safePath);
    const dataBytes = typeof entry.data === "string" ? textEncoder.encode(entry.data) : entry.data;

    localSectionBytes += 30 + nameBytes.byteLength + dataBytes.byteLength;
    centralDirBytes += 46 + nameBytes.byteLength;

    if (localSectionBytes + centralDirBytes + 22 > maxTotalBytes) {
      throw new ZipArchiveError(
        "ZIP_SIZE_LIMIT_EXCEEDED",
        `ZIP archive exceeds maximum allowed size of ${maxTotalBytes} bytes.`,
      );
    }

    const { dosTime, dosDate } = encodeDosDateTime(entry.modifiedAtMs ?? defaultModifiedAtMs);
    prepared.push({
      nameBytes,
      dataBytes,
      crc32: computeCrc32(dataBytes),
      dosTime,
      dosDate,
    });
  }

  const totalBytes = localSectionBytes + centralDirBytes + 22;
  if (totalBytes > maxTotalBytes) {
    throw new ZipArchiveError(
      "ZIP_SIZE_LIMIT_EXCEEDED",
      `ZIP archive exceeds maximum allowed size of ${maxTotalBytes} bytes.`,
    );
  }

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const localOffsets: number[] = [];
  let offset = 0;

  // 1. Write Local File Headers + file data
  for (const item of prepared) {
    localOffsets.push(offset);
    view.setUint32(offset, LOCAL_FILE_HEADER_SIG, true);
    view.setUint16(offset + 4, ZIP_VERSION_NEEDED, true);
    view.setUint16(offset + 6, UTF8_GENERAL_PURPOSE_FLAG, true);
    view.setUint16(offset + 8, COMPRESSION_STORE, true);
    view.setUint16(offset + 10, item.dosTime, true);
    view.setUint16(offset + 12, item.dosDate, true);
    view.setUint32(offset + 14, item.crc32, true);
    view.setUint32(offset + 18, item.dataBytes.byteLength, true);
    view.setUint32(offset + 22, item.dataBytes.byteLength, true);
    view.setUint16(offset + 26, item.nameBytes.byteLength, true);
    view.setUint16(offset + 28, 0, true); // extra field length
    offset += 30;

    out.set(item.nameBytes, offset);
    offset += item.nameBytes.byteLength;

    out.set(item.dataBytes, offset);
    offset += item.dataBytes.byteLength;
  }

  // 2. Write Central Directory Headers
  const centralDirOffset = offset;
  for (let i = 0; i < prepared.length; i += 1) {
    const item = prepared[i]!;
    const localHeaderOffset = localOffsets[i]!;

    view.setUint32(offset, CENTRAL_DIR_HEADER_SIG, true);
    view.setUint16(offset + 4, ZIP_VERSION_MADE_BY, true);
    view.setUint16(offset + 6, ZIP_VERSION_NEEDED, true);
    view.setUint16(offset + 8, UTF8_GENERAL_PURPOSE_FLAG, true);
    view.setUint16(offset + 10, COMPRESSION_STORE, true);
    view.setUint16(offset + 12, item.dosTime, true);
    view.setUint16(offset + 14, item.dosDate, true);
    view.setUint32(offset + 16, item.crc32, true);
    view.setUint32(offset + 20, item.dataBytes.byteLength, true);
    view.setUint32(offset + 24, item.dataBytes.byteLength, true);
    view.setUint16(offset + 28, item.nameBytes.byteLength, true);
    view.setUint16(offset + 30, 0, true); // extra length
    view.setUint16(offset + 32, 0, true); // comment length
    view.setUint16(offset + 34, 0, true); // disk number start
    view.setUint16(offset + 36, 0, true); // internal file attrs
    view.setUint32(offset + 38, 0, true); // external file attrs
    view.setUint32(offset + 42, localHeaderOffset, true);
    offset += 46;

    out.set(item.nameBytes, offset);
    offset += item.nameBytes.byteLength;
  }

  const centralDirSize = offset - centralDirOffset;

  // 3. Write End of Central Directory Record (EOCD)
  view.setUint32(offset, EOCD_SIG, true);
  view.setUint16(offset + 4, 0, true); // disk number
  view.setUint16(offset + 6, 0, true); // central dir disk
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralDirSize, true);
  view.setUint32(offset + 16, centralDirOffset, true);
  view.setUint16(offset + 20, 0, true); // comment length

  return out;
}

/**
 * Parses and verifies a PKZIP (STORE method 0) archive, checking EOCD, Central Directory,
 * Local File Headers, safe entry paths, and IEEE CRC-32 checksums.
 */
export function parseZipArchive(bytes: Uint8Array): readonly ParsedZipEntry[] {
  if (bytes.byteLength < 22) {
    throw new ZipArchiveError("ZIP_TRUNCATED", "Input is too small to be a valid ZIP archive.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate EOCD record near the end of the buffer
  const minEocdOffset = Math.max(0, bytes.byteLength - 65_557);
  let eocdOffset = -1;
  for (let pos = bytes.byteLength - 22; pos >= minEocdOffset; pos -= 1) {
    if (view.getUint32(pos, true) === EOCD_SIG) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new ZipArchiveError("ZIP_MISSING_EOCD", "End of central directory record not found.");
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (centralDirOffset + centralDirSize > eocdOffset) {
    throw new ZipArchiveError("ZIP_CORRUPT_DIRECTORY", "Central directory bounds exceed archive size.");
  }

  const results: ParsedZipEntry[] = [];
  let cdPos = centralDirOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (cdPos + 46 > bytes.byteLength || view.getUint32(cdPos, true) !== CENTRAL_DIR_HEADER_SIG) {
      throw new ZipArchiveError("ZIP_CORRUPT_HEADER", `Invalid central directory header at entry ${i}.`);
    }

    const compressionMethod = view.getUint16(cdPos + 10, true);
    const expectedCrc = view.getUint32(cdPos + 16, true);
    const compressedSize = view.getUint32(cdPos + 20, true);
    const uncompressedSize = view.getUint32(cdPos + 24, true);
    const nameLen = view.getUint16(cdPos + 28, true);
    const extraLen = view.getUint16(cdPos + 30, true);
    const commentLen = view.getUint16(cdPos + 32, true);
    const localHeaderOffset = view.getUint32(cdPos + 42, true);

    const nameSlice = bytes.subarray(cdPos + 46, cdPos + 46 + nameLen);
    const rawName = textDecoder.decode(nameSlice);
    const safePath = assertSafeZipEntryPath(rawName);
    cdPos += 46 + nameLen + extraLen + commentLen;

    if (
      localHeaderOffset + 30 > bytes.byteLength ||
      view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIG
    ) {
      throw new ZipArchiveError("ZIP_CORRUPT_LOCAL_HEADER", `Invalid local file header for "${safePath}".`);
    }

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > bytes.byteLength) {
      throw new ZipArchiveError("ZIP_TRUNCATED_ENTRY", `Truncated payload for "${safePath}".`);
    }

    if (compressionMethod !== COMPRESSION_STORE) {
      throw new ZipArchiveError(
        "ZIP_UNSUPPORTED_METHOD",
        `Unsupported compression method ${compressionMethod} for "${safePath}".`,
      );
    }

    const data = bytes.slice(dataStart, dataEnd);
    const actualCrc = computeCrc32(data);
    if (actualCrc !== expectedCrc) {
      throw new ZipArchiveError("ZIP_CRC_MISMATCH", `CRC-32 mismatch for "${safePath}".`);
    }

    results.push({
      path: safePath,
      data,
      crc32: actualCrc,
      compressedSize,
      uncompressedSize,
      compressionMethod,
    });
  }

  return results;
}

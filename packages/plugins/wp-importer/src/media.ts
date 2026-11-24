import {
  computeSha256Hex,
  inspectImageBinary,
  MAX_NORMALIZED_MASTER_BYTES,
  MAX_NORMALIZED_MASTER_EDGE_PX,
  readBoundedStream,
  slugifyMediaFilename,
  type CloudflareImagesBinding,
} from "@punyasitus/core/media/index";
import { guardedFetch } from "./ssrf.ts";
import {
  WP_IMPORTER_LIMITS,
  WpImporterError,
  type WpEncodedWebpResult,
  type WpImportedMediaReportItem,
  type WpImporterFetchPort,
  type WpImporterMediaStoragePort,
  type WpImporterWebpEncoderPort,
} from "./types.ts";

/**
 * SSRF-Guarded Image Fetcher, Magic-Byte Sniffer, WebP Normalizer, and
 * Hard Tenant Storage Quota Enforcer for `wp-importer` (`TASK-100`, `REQ-100`).
 *
 * Security & Quota Invariants:
 * - Every image URL (and every redirect target) passes `guardedFetch` SSRF checks.
 * - Never trusts `Content-Type` or file extension alone: inspects raw magic bytes via
 *   `inspectImageBinary` AND explicitly blocks SVG, HTML, JS, PHP, PE/ELF/Mach-O/shebang
 *   executables, polyglot markup headers, BMP, AVIF, and video streams.
 * - Normalizes accepted images to WebP (stripping EXIF metadata) and validates output
 *   is genuine `image/webp` (`RIFF....WEBP`) within `<= 2,000,000` bytes.
 * - Checks tenant storage quota (`usedBytes + reservedBytes + incomingBytes <= quotaBytes`)
 *   BEFORE every R2 write so an import can NEVER exceed the website's storage quota.
 */

const FORBIDDEN_DECLARED_MIMES = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "application/x-php",
  "text/x-php",
  "application/x-msdownload",
  "application/x-executable",
  "application/x-sh",
  "application/x-dosexec",
  "application/octet-stream+exe",
]);

const TEXT_DECODER_ASCII = new TextDecoder("latin1");

function hasExecutableOrScriptMagic(bytes: Uint8Array): { readonly blocked: boolean; readonly reason: string } {
  if (bytes.byteLength < 2) {
    return { blocked: true, reason: "Berkas gambar kosong atau terlalu kecil." };
  }

  // PE / Windows executable: `MZ`
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return { blocked: true, reason: "Berkas executable (PE/MZ) diblokir." };
  }
  // ELF binary: `\x7fELF`
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  ) {
    return { blocked: true, reason: "Berkas executable (ELF) diblokir." };
  }
  // Shebang script: `#!`
  if (bytes[0] === 0x23 && bytes[1] === 0x21) {
    return { blocked: true, reason: "Skrip shell (#!) diblokir." };
  }
  // Mach-O binaries
  if (
    bytes.byteLength >= 4 &&
    ((bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfa && (bytes[3] === 0xce || bytes[3] === 0xcf)) ||
      (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) ||
      (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe))
  ) {
    return { blocked: true, reason: "Berkas executable (Mach-O/Java class) diblokir." };
  }
  // ZIP / JAR / PHAR archive (`PK\x03\x04`)
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    return { blocked: true, reason: "Arsip ZIP/JAR diblokir pada impor gambar." };
  }

  // Inspect leading 1024 bytes for SVG / HTML / PHP / JS payloads or polyglots
  const headText = TEXT_DECODER_ASCII.decode(bytes.subarray(0, Math.min(bytes.byteLength, 1024)))
    .replace(/\0/g, "")
    .trimStart()
    .toLowerCase();

  if (
    headText.startsWith("<svg") ||
    headText.startsWith("<?xml") ||
    headText.includes("<svg") ||
    headText.startsWith("<!doctype html") ||
    headText.startsWith("<html") ||
    headText.startsWith("<script") ||
    headText.includes("<?php") ||
    headText.includes("<script")
  ) {
    return {
      blocked: true,
      reason: "Payload SVG, HTML, PHP, atau skrip diblokir demi keamanan.",
    };
  }

  return { blocked: false, reason: "" };
}

export interface WebpContainerSafetyResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Strictly parses a RIFF/WEBP container chunk-by-chunk to verify that an already-WebP
 * file passed through without re-encoding contains:
 * - Zero trailing polyglot bytes past `riffSize + 8`
 * - Zero `EXIF` or `XMP ` metadata chunks (and zero VP8X EXIF/XMP flags)
 * - Valid non-overrunning chunk lengths
 */
export function inspectWebpContainerSafety(bytes: Uint8Array): WebpContainerSafetyResult {
  if (bytes.byteLength < 12) {
    return { ok: false, reason: "Header kontainer RIFF/WEBP terlalu pendek." };
  }
  const riffTag = TEXT_DECODER_ASCII.decode(bytes.subarray(0, 4));
  const webpTag = TEXT_DECODER_ASCII.decode(bytes.subarray(8, 12));
  if (riffTag !== "RIFF" || webpTag !== "WEBP") {
    return { ok: false, reason: "Signature RIFF/WEBP tidak valid." };
  }

  const riffSize =
    ((bytes[4] ?? 0) |
      ((bytes[5] ?? 0) << 8) |
      ((bytes[6] ?? 0) << 16) |
      ((bytes[7] ?? 0) << 24)) >>>
    0;
  const declaredTotal = riffSize + 8;

  if (declaredTotal < 12 || bytes.byteLength < declaredTotal) {
    return { ok: false, reason: "Kontainer WebP terpotong atau ukuran RIFF tidak valid." };
  }
  if (bytes.byteLength > declaredTotal) {
    return {
      ok: false,
      reason: `Berkas WebP mengandung ${bytes.byteLength - declaredTotal} trailing bytes setelah akhir kontainer RIFF (potensi polyglot).`,
    };
  }

  let offset = 12;
  let chunkCount = 0;
  while (offset < declaredTotal) {
    if (offset + 8 > declaredTotal) {
      return { ok: false, reason: "Header chunk WebP terpotong." };
    }
    chunkCount += 1;
    if (chunkCount > 128) {
      return { ok: false, reason: "Jumlah chunk kontainer WebP melebihi batas aman." };
    }

    const fourCC = TEXT_DECODER_ASCII.decode(bytes.subarray(offset, offset + 4));
    const chunkSize =
      ((bytes[offset + 4] ?? 0) |
        ((bytes[offset + 5] ?? 0) << 8) |
        ((bytes[offset + 6] ?? 0) << 16) |
        ((bytes[offset + 7] ?? 0) << 24)) >>>
      0;
    const payloadStart = offset + 8;
    const paddedEnd = payloadStart + chunkSize + (chunkSize % 2);

    if (payloadStart + chunkSize > declaredTotal || paddedEnd > declaredTotal) {
      return { ok: false, reason: `Chunk WebP "${fourCC}" melampaui batas kontainer RIFF.` };
    }

    if (fourCC === "EXIF" || fourCC === "XMP ") {
      return {
        ok: false,
        reason: `WebP mengandung chunk metadata ${fourCC.trim()} yang tidak dapat dibersihkan tanpa encoder gambar.`,
      };
    }

    if (fourCC === "VP8X" && chunkSize >= 1) {
      const flags = bytes[payloadStart] ?? 0;
      // VP8X flags: bit 3 (0x08) = EXIF metadata, bit 2 (0x04) = XMP metadata
      if ((flags & 0x08) !== 0 || (flags & 0x04) !== 0) {
        return {
          ok: false,
          reason: "Header VP8X menandakan metadata EXIF/XMP yang harus dibersihkan melalui encoder gambar.",
        };
      }
    }

    offset = paddedEnd;
  }

  return { ok: true };
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

/**
 * Wraps Cloudflare Workers `IMAGES` binding into `WpImporterWebpEncoderPort` matching
 * the core media normalization contract (`metadata: "none"`, `format: "image/webp"`, `<= 2 MB`).
 */
export function createCloudflareImagesWebpEncoder(
  images: CloudflareImagesBinding,
): WpImporterWebpEncoderPort {
  return async ({ sourceBytes, sourceWidth, sourceHeight, maxEdgePx, maxBytes }) => {
    const attempts = [
      { edge: maxEdgePx, quality: 82 },
      { edge: maxEdgePx, quality: 70 },
      { edge: 1920, quality: 58 },
      { edge: 1280, quality: 45 },
    ] as const;

    for (const step of attempts) {
      const targetW = Math.max(1, Math.min(sourceWidth, step.edge));
      const targetH = Math.max(1, Math.min(sourceHeight, step.edge));
      const output = await images
        .input(bytesToStream(sourceBytes))
        .transform({
          width: targetW,
          height: targetH,
          fit: "scale-down",
          metadata: "none",
          anim: false,
        })
        .output({
          format: "image/webp",
          quality: step.quality,
        });

      const read = await readBoundedStream(output.image(), maxBytes);
      if (!read.ok) {
        if (read.code === "PAYLOAD_TOO_LARGE") continue;
        throw new WpImporterError(
          422,
          "MEDIA_REJECTED",
          "Encoder gambar mengembalikan output kosong.",
        );
      }

      const inspected = inspectImageBinary(read.bytes, "image/webp");
      if (!inspected.ok || inspected.mimeType !== "image/webp") {
        throw new WpImporterError(
          422,
          "MEDIA_REJECTED",
          "Output normalisasi gambar bukan WebP yang valid.",
        );
      }

      return {
        bytes: read.bytes,
        width: inspected.width,
        height: inspected.height,
        mimeType: "image/webp",
      };
    }

    throw new WpImporterError(
      413,
      "MEDIA_REJECTED",
      `Gambar tidak dapat dikompresi menjadi WebP di bawah ${maxBytes} byte.`,
    );
  };
}

export interface ValidatedDownloadedImage {
  readonly sourceUrl: string;
  readonly filename: string;
  readonly sourceBytes: Uint8Array;
  readonly sourceMime: string;
  readonly sourceFormat: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Fetches an external image URL via SSRF-guarded fetch and validates its real binary
 * magic bytes (strictly rejecting SVG, HTML, PHP, executables, polyglots, spoofed MIMEs).
 */
export async function fetchAndValidateExternalImage(
  sourceUrl: string,
  options: {
    readonly fetchImpl?: WpImporterFetchPort;
    readonly allowHttp?: boolean;
    readonly maxSourceBytes?: number;
  } = {},
): Promise<ValidatedDownloadedImage> {
  const maxSourceBytes = options.maxSourceBytes ?? WP_IMPORTER_LIMITS.maxImageSourceBytes;

  const fetched = await guardedFetch(sourceUrl, {
    fetchImpl: options.fetchImpl,
    allowHttp: options.allowHttp,
    maxBytes: maxSourceBytes,
    accept: "image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1",
    contextLabel: "URL gambar WordPress",
  });

  if (fetched.status < 200 || fetched.status >= 300) {
    throw new WpImporterError(
      502,
      "FETCH_FAILED",
      `Gagal mengunduh gambar (HTTP ${fetched.status}).`,
      { status: fetched.status, sourceUrl },
    );
  }

  const declaredMime = (fetched.contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (declaredMime && FORBIDDEN_DECLARED_MIMES.has(declaredMime)) {
    throw new WpImporterError(
      415,
      "MEDIA_REJECTED",
      `Tipe media "${declaredMime}" diblokir (hanya gambar raster JPEG/PNG/WebP/GIF yang diizinkan).`,
      { declaredMime, sourceUrl },
    );
  }

  const execCheck = hasExecutableOrScriptMagic(fetched.bytes);
  if (execCheck.blocked) {
    throw new WpImporterError(415, "MEDIA_REJECTED", execCheck.reason, { sourceUrl });
  }

  // Sniff real magic bytes (ignore generic/empty Content-Type when server omits it,
  // but reject MIME spoofing when server declares an incompatible image/* type)
  const declaredForSniff =
    declaredMime && declaredMime.startsWith("image/") ? declaredMime : undefined;
  const inspected = inspectImageBinary(fetched.bytes, declaredForSniff);
  if (!inspected.ok) {
    throw new WpImporterError(
      inspected.status === 413 ? 413 : inspected.status === 415 ? 415 : 422,
      "MEDIA_REJECTED",
      inspected.message,
      { mediaCode: inspected.code, sourceUrl },
    );
  }

  // Only allow safe web raster formats (JPEG, PNG, WebP, GIF)
  if (
    inspected.format !== "jpeg" &&
    inspected.format !== "png" &&
    inspected.format !== "webp" &&
    inspected.format !== "gif"
  ) {
    throw new WpImporterError(
      415,
      "MEDIA_REJECTED",
      `Format gambar "${inspected.format}" tidak didukung untuk impor WordPress.`,
      { format: inspected.format, sourceUrl },
    );
  }

  let filename = "wp-image.webp";
  try {
    const pathname = new URL(fetched.finalUrl).pathname;
    const leaf = pathname.split("/").pop() || "wp-image";
    filename = `${slugifyMediaFilename(leaf)}.webp`;
  } catch {
    // keep default
  }

  return {
    sourceUrl,
    filename,
    sourceBytes: fetched.bytes,
    sourceMime: inspected.mimeType,
    sourceFormat: inspected.format,
    width: inspected.width,
    height: inspected.height,
  };
}

export interface ProcessWpImageInput {
  readonly tenantId: string;
  readonly sourceUrl: string;
  readonly altText: string;
  readonly mode: "dry_run" | "import";
  readonly fetchImpl?: WpImporterFetchPort;
  readonly allowHttp?: boolean;
  readonly webpEncoder?: WpImporterWebpEncoderPort;
  readonly imagesBinding?: CloudflareImagesBinding | null;
  readonly mediaPort?: WpImporterMediaStoragePort;
  readonly remainingQuotaBytes: number | null;
  readonly nowMs: number;
}

export interface ProcessWpImageOutcome {
  readonly reportItem: WpImportedMediaReportItem;
  readonly bytesConsumed: number;
  readonly mediaId: number | null;
  readonly quotaExceeded: boolean;
}

/**
 * End-to-end safe image ingestion pipeline for a single WordPress image reference:
 * 1. SSRF-guarded download + real magic-byte sniffing (rejects SVG/HTML/JS/PHP/executables).
 * 2. WebP normalization (validating `RIFF....WEBP` magic bytes on output).
 * 3. Pre-write storage quota check (`bytes <= remainingQuotaBytes`) so quota is NEVER exceeded.
 * 4. In `import` mode with `mediaPort`, persists tenant-scoped R2 WebP object.
 */
export async function processWpImageReference(
  input: ProcessWpImageInput,
): Promise<ProcessWpImageOutcome> {
  let validated: ValidatedDownloadedImage;
  try {
    validated = await fetchAndValidateExternalImage(input.sourceUrl, {
      fetchImpl: input.fetchImpl,
      allowHttp: input.allowHttp,
    });
  } catch (err) {
    const code = err instanceof WpImporterError ? err.code : "MEDIA_REJECTED";
    const message = err instanceof Error ? err.message : "Gambar ditolak.";
    return {
      reportItem: {
        sourceUrl: input.sourceUrl,
        status: "rejected",
        reasonCode: code,
        message,
      },
      bytesConsumed: 0,
      mediaId: null,
      quotaExceeded: false,
    };
  }

  // Dry-run mode: validate SSRF + magic bytes + estimate quota WITHOUT writing R2 or DB
  if (input.mode === "dry_run") {
    const estimatedBytes = validated.sourceBytes.byteLength;
    if (input.remainingQuotaBytes !== null && estimatedBytes > input.remainingQuotaBytes) {
      return {
        reportItem: {
          sourceUrl: input.sourceUrl,
          status: "quota_exceeded",
          bytes: estimatedBytes,
          width: validated.width,
          height: validated.height,
          reasonCode: "STORAGE_QUOTA_EXCEEDED",
          message: `Kuota penyimpanan situs tidak cukup untuk gambar ini (${estimatedBytes} byte > sisa ${input.remainingQuotaBytes} byte).`,
        },
        bytesConsumed: 0,
        mediaId: null,
        quotaExceeded: true,
      };
    }
    return {
      reportItem: {
        sourceUrl: input.sourceUrl,
        status: "dry_run_valid",
        mimeType: "image/webp",
        bytes: estimatedBytes,
        width: validated.width,
        height: validated.height,
      },
      bytesConsumed: estimatedBytes,
      mediaId: null,
      quotaExceeded: false,
    };
  }

  // Import mode: normalize to WebP
  const encoder: WpImporterWebpEncoderPort | null =
    input.webpEncoder ??
    (input.imagesBinding ? createCloudflareImagesWebpEncoder(input.imagesBinding) : null);

  let encoded: WpEncodedWebpResult;
  try {
    if (encoder) {
      encoded = await encoder({
        sourceBytes: validated.sourceBytes,
        sourceMime: validated.sourceMime,
        sourceWidth: validated.width,
        sourceHeight: validated.height,
        maxEdgePx: MAX_NORMALIZED_MASTER_EDGE_PX,
        maxBytes: MAX_NORMALIZED_MASTER_BYTES,
      });
      // Re-verify encoded output magic bytes strictly as WebP!
      const checkWebp = inspectImageBinary(encoded.bytes, "image/webp");
      if (!checkWebp.ok || checkWebp.mimeType !== "image/webp") {
        throw new WpImporterError(
          422,
          "MEDIA_REJECTED",
          "Hasil normalisasi WebP gagal verifikasi magic-byte RIFF/WEBP.",
        );
      }
    } else if (
      validated.sourceFormat === "webp" &&
      validated.sourceBytes.byteLength <= MAX_NORMALIZED_MASTER_BYTES
    ) {
      // Pass-through source WebP ONLY if RIFF/WEBP container has zero EXIF/XMP metadata and zero trailing polyglot bytes!
      const containerSafety = inspectWebpContainerSafety(validated.sourceBytes);
      if (!containerSafety.ok) {
        throw new WpImporterError(
          415,
          "MEDIA_REJECTED",
          containerSafety.reason ?? "Berkas WebP gagal pemeriksaan kontainer RIFF.",
        );
      }
      encoded = {
        bytes: validated.sourceBytes,
        width: validated.width,
        height: validated.height,
        mimeType: "image/webp",
      };
    } else {
      return {
        reportItem: {
          sourceUrl: input.sourceUrl,
          status: "skipped",
          reasonCode: "WEBP_ENCODER_UNAVAILABLE",
          message:
            "Normalisasi WebP tidak tersedia pada runtime ini untuk gambar non-WebP; gambar dilewati agar tidak menyimpan format non-WebP.",
        },
        bytesConsumed: 0,
        mediaId: null,
        quotaExceeded: false,
      };
    }
  } catch (err) {
    const code = err instanceof WpImporterError ? err.code : "MEDIA_REJECTED";
    const message = err instanceof Error ? err.message : "Gagal menormalisasi gambar ke WebP.";
    return {
      reportItem: {
        sourceUrl: input.sourceUrl,
        status: "rejected",
        reasonCode: code,
        message,
      },
      bytesConsumed: 0,
      mediaId: null,
      quotaExceeded: false,
    };
  }

  // Hard pre-write quota gate: NEVER write to R2 if it would exceed storage quota!
  if (input.remainingQuotaBytes !== null && encoded.bytes.byteLength > input.remainingQuotaBytes) {
    return {
      reportItem: {
        sourceUrl: input.sourceUrl,
        status: "quota_exceeded",
        bytes: encoded.bytes.byteLength,
        width: encoded.width,
        height: encoded.height,
        reasonCode: "STORAGE_QUOTA_EXCEEDED",
        message: `Kuota penyimpanan tidak mencukupi (${encoded.bytes.byteLength} byte dibutuhkan, tersisa ${input.remainingQuotaBytes} byte).`,
      },
      bytesConsumed: 0,
      mediaId: null,
      quotaExceeded: true,
    };
  }

  if (!input.mediaPort) {
    return {
      reportItem: {
        sourceUrl: input.sourceUrl,
        status: "skipped",
        mimeType: "image/webp",
        bytes: encoded.bytes.byteLength,
        width: encoded.width,
        height: encoded.height,
        reasonCode: "MEDIA_STORAGE_UNAVAILABLE",
        message:
          "Penyimpanan media R2 tidak tersedia pada runtime ini; gambar dilewati dan tidak dicatat sebagai terimpor.",
      },
      bytesConsumed: 0,
      mediaId: null,
      quotaExceeded: false,
    };
  }

  const sha256 = await computeSha256Hex(encoded.bytes);
  let stored: Awaited<ReturnType<WpImporterMediaStoragePort["storeWebpAsset"]>>;
  try {
    stored = await input.mediaPort.storeWebpAsset({
      tenantId: input.tenantId,
      filename: validated.filename,
      altText: input.altText || validated.filename,
      webpBytes: encoded.bytes,
      width: encoded.width,
      height: encoded.height,
      sha256,
      nowMs: input.nowMs,
    });
  } catch (err) {
    return {
      reportItem: {
        sourceUrl: input.sourceUrl,
        status: "rejected",
        bytes: encoded.bytes.byteLength,
        width: encoded.width,
        height: encoded.height,
        reasonCode: "STORAGE_ERROR",
        message:
          err instanceof Error
            ? `Gagal menyimpan aset WebP: ${err.message}`
            : "Gagal menyimpan aset WebP ke penyimpanan situs.",
      },
      bytesConsumed: 0,
      mediaId: null,
      quotaExceeded: false,
    };
  }

  if (!stored.ok) {
    const isQuota = stored.code === "STORAGE_QUOTA_EXCEEDED";
    return {
      reportItem: {
        sourceUrl: input.sourceUrl,
        status: isQuota ? "quota_exceeded" : "rejected",
        bytes: encoded.bytes.byteLength,
        width: encoded.width,
        height: encoded.height,
        reasonCode: stored.code,
        message: stored.message,
      },
      bytesConsumed: 0,
      mediaId: null,
      quotaExceeded: isQuota,
    };
  }

  return {
    reportItem: {
      sourceUrl: input.sourceUrl,
      status: "imported",
      mediaId: stored.mediaId,
      r2Key: stored.r2Key,
      mimeType: "image/webp",
      bytes: stored.bytes,
      width: encoded.width,
      height: encoded.height,
    },
    bytesConsumed: stored.bytes,
    mediaId: stored.mediaId,
    quotaExceeded: false,
  };
}

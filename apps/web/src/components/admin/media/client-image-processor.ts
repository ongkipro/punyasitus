/**
 * Client-side Pre-Upload Image Processor (`TASK-033`, `REQ-010`, `REQ-037`, `PLAN §7.2-7.3`).
 *
 * Responsibilities:
 * 1. Detect `image/avif` (by MIME, `.avif` extension, or ISO BMFF `ftyp` header) and
 *    convert client-side via `<canvas>` to `image/webp` (with `image/png` fallback).
 * 2. Downscale large phone photos client-side when longest edge > 2560 px, preserving
 *    aspect ratio (`longestEdge <= 2560`).
 * 3. Compute SHA-256 hex digest for same-origin `POST /upload-intent` + `PUT /upload/:intentId`.
 * 4. Keep server validation strictly authoritative: client processing never bypasses
 *    server magic-byte sniffing, quota checks, or RBAC/lock enforcement.
 */

export const MAX_CLIENT_IMAGE_LONGEST_EDGE = 2560 as const;
export const MAX_CLIENT_IMAGE_BYTES = 5_000_000 as const;

export interface TargetDimensions {
  readonly width: number;
  readonly height: number;
  readonly resized: boolean;
}

export interface ProcessedUploadImage {
  readonly file: File;
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
  readonly declaredBytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly originalWidth: number | null;
  readonly originalHeight: number | null;
  readonly wasAvifConverted: boolean;
  readonly wasResized: boolean;
}

/**
 * Pure aspect-preserving downscale math: ensures `Math.max(width, height) <= maxEdge`.
 */
export function computeTargetDimensions(
  width: number,
  height: number,
  maxEdge: number = MAX_CLIENT_IMAGE_LONGEST_EDGE,
): TargetDimensions {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Dimensi gambar tidak valid.");
  }
  const safeMax = Math.max(1, Math.floor(maxEdge));
  const longest = Math.max(width, height);
  if (longest <= safeMax) {
    return {
      width: Math.round(width),
      height: Math.round(height),
      resized: false,
    };
  }
  const scale = safeMax / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

/**
 * Checks ISO BMFF `ftyp` box bytes for AVIF / AVIS brand signatures.
 */
export function hasAvifHeaderBytes(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.byteLength < 12) return false;
  // ISO BMFF box type at offset 4..7 is "ftyp"
  if (
    bytes[4] !== 0x66 || // f
    bytes[5] !== 0x74 || // t
    bytes[6] !== 0x79 || // y
    bytes[7] !== 0x70 // p
  ) {
    return false;
  }
  const sliceLen = Math.min(bytes.byteLength, 64);
  let ascii = "";
  for (let i = 8; i < sliceLen; i += 1) {
    ascii += String.fromCharCode(bytes[i]!);
  }
  return ascii.includes("avif") || ascii.includes("avis");
}

/**
 * Detects AVIF images by MIME type, `.avif` extension, or ISO BMFF header bytes.
 */
export function isAvifInput(
  file: { readonly name?: string; readonly type?: string },
  headerBytes?: Uint8Array | null,
): boolean {
  const mime = (file.type ?? "").trim().toLowerCase();
  if (mime === "image/avif") return true;
  const name = (file.name ?? "").trim().toLowerCase();
  if (name.endsWith(".avif")) return true;
  return hasAvifHeaderBytes(headerBytes);
}

/**
 * Replaces or appends a safe file extension for converted WebP/PNG outputs.
 */
export function replaceFilenameExtension(
  originalName: string,
  targetMime: "image/webp" | "image/png" | "image/jpeg",
): string {
  const ext =
    targetMime === "image/webp" ? ".webp" : targetMime === "image/png" ? ".png" : ".jpg";
  const cleaned = originalName.trim().replace(/[/\\:*?"<>|]+/g, "-") || "gambar";
  const withoutExt = cleaned.replace(/\.[a-z0-9]{1,8}$/i, "");
  const base = withoutExt.slice(0, 140) || "gambar";
  return `${base}${ext}`;
}

export async function computeBufferSha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface CanvasRasterizerAdapter {
  decodeImage(file: File): Promise<{
    readonly source: CanvasImageSource;
    readonly width: number;
    readonly height: number;
    readonly cleanup?: () => void;
  }>;
  encodeCanvas(
    source: CanvasImageSource,
    width: number,
    height: number,
    preferredMime: "image/webp" | "image/png",
    quality: number,
  ): Promise<{ readonly blob: Blob; readonly mimeType: "image/webp" | "image/png" }>;
}

const defaultBrowserRasterizer: CanvasRasterizerAdapter = {
  async decodeImage(file: File) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file);
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          cleanup: () => bitmap.close(),
        };
      } catch {
        // Fall back to HTMLImageElement below
      }
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Gagal membaca berkas gambar di peramban."));
        el.src = objectUrl;
      });
      return {
        source: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        cleanup: () => URL.revokeObjectURL(objectUrl),
      };
    } catch (err) {
      URL.revokeObjectURL(objectUrl);
      throw err;
    }
  },

  async encodeCanvas(source, width, height, preferredMime, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Kanvas 2D tidak tersedia untuk mengonversi gambar.");
    }
    ctx.drawImage(source, 0, 0, width, height);

    const toBlobAsync = (mime: "image/webp" | "image/png", q?: number): Promise<Blob | null> =>
      new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), mime, q);
      });

    if (preferredMime === "image/webp") {
      const webpBlob = await toBlobAsync("image/webp", quality);
      if (webpBlob && webpBlob.size > 0 && webpBlob.type === "image/webp") {
        return { blob: webpBlob, mimeType: "image/webp" };
      }
    }

    const pngBlob = await toBlobAsync("image/png");
    if (!pngBlob || pngBlob.size === 0) {
      throw new Error("Gagal mengonversi gambar ke WebP atau PNG.");
    }
    return { blob: pngBlob, mimeType: "image/png" };
  },
};

export interface ProcessImageOptions {
  readonly maxLongestEdge?: number;
  readonly webpQuality?: number;
  readonly rasterizer?: CanvasRasterizerAdapter;
}

/**
 * Prepares a user-selected image for upload:
 * - Converts AVIF to WebP (with PNG fallback) via `<canvas>`.
 * - Downscales oversized images so longest edge <= 2560 px preserving aspect ratio.
 * - Leaves other valid formats untouched when already <= 2560 px so server validation
 *   remains authoritative (including rejecting SVG/BMP/corrupt files on the server).
 */
export async function processImageFileForUpload(
  file: File,
  options: ProcessImageOptions = {},
): Promise<ProcessedUploadImage> {
  const maxEdge = options.maxLongestEdge ?? MAX_CLIENT_IMAGE_LONGEST_EDGE;
  const quality = options.webpQuality ?? 0.86;
  const rasterizer = options.rasterizer ?? defaultBrowserRasterizer;

  const rawBytes = new Uint8Array(await file.arrayBuffer());
  const headerSlice = rawBytes.subarray(0, Math.min(64, rawBytes.byteLength));
  const avifDetected = isAvifInput(file, headerSlice);

  // Never try to canvas-rasterize SVG or BMP — pass straight through (or let UI warn)
  // so server validation remains authoritative for disallowed formats.
  const lowerMime = (file.type || "").trim().toLowerCase();
  const lowerName = (file.name || "").trim().toLowerCase();
  const isNonRasterOrBlocked =
    lowerMime === "image/svg+xml" ||
    lowerName.endsWith(".svg") ||
    lowerMime === "image/bmp" ||
    lowerName.endsWith(".bmp") ||
    lowerMime === "image/heic" ||
    lowerMime === "image/heif" ||
    lowerName.endsWith(".heic") ||
    lowerName.endsWith(".heif") ||
    lowerMime === "image/tiff" ||
    lowerName.endsWith(".tiff") ||
    lowerName.endsWith(".tif");

  if (!avifDetected && isNonRasterOrBlocked) {
    const sha256 = await computeBufferSha256Hex(rawBytes);
    return {
      file,
      bytes: rawBytes,
      filename: file.name || "gambar",
      mimeType: lowerMime || "application/octet-stream",
      declaredBytes: rawBytes.byteLength,
      sha256,
      width: null,
      height: null,
      originalWidth: null,
      originalHeight: null,
      wasAvifConverted: false,
      wasResized: false,
    };
  }

  // Try decoding dimensions to detect > 2560px phone photos or convert AVIF
  let decoded: Awaited<ReturnType<CanvasRasterizerAdapter["decodeImage"]>>;
  try {
    decoded = await rasterizer.decodeImage(file);
  } catch (err) {
    if (avifDetected) {
      throw new Error(
        err instanceof Error
          ? `Gagal mengonversi gambar AVIF di peramban: ${err.message}`
          : "Gagal mengonversi gambar AVIF di peramban.",
        { cause: err },
      );
    }
    // Non-AVIF unreadable by browser canvas (e.g. corrupt test fixture): pass raw bytes so server validates authoritatively
    const sha256 = await computeBufferSha256Hex(rawBytes);
    return {
      file,
      bytes: rawBytes,
      filename: file.name || "gambar",
      mimeType: lowerMime || "application/octet-stream",
      declaredBytes: rawBytes.byteLength,
      sha256,
      width: null,
      height: null,
      originalWidth: null,
      originalHeight: null,
      wasAvifConverted: false,
      wasResized: false,
    };
  }

  try {
    const target = computeTargetDimensions(decoded.width, decoded.height, maxEdge);
    const mustTransform = avifDetected || target.resized;

    if (!mustTransform) {
      const sha256 = await computeBufferSha256Hex(rawBytes);
      return {
        file,
        bytes: rawBytes,
        filename: file.name || "gambar",
        mimeType: lowerMime || "image/png",
        declaredBytes: rawBytes.byteLength,
        sha256,
        width: decoded.width,
        height: decoded.height,
        originalWidth: decoded.width,
        originalHeight: decoded.height,
        wasAvifConverted: false,
        wasResized: false,
      };
    }

    const encoded = await rasterizer.encodeCanvas(
      decoded.source,
      target.width,
      target.height,
      "image/webp",
      quality,
    );
    const outBytes = new Uint8Array(await encoded.blob.arrayBuffer());
    const outFilename = replaceFilenameExtension(file.name || "gambar", encoded.mimeType);
    const outFile = new File([outBytes], outFilename, { type: encoded.mimeType });
    const sha256 = await computeBufferSha256Hex(outBytes);

    return {
      file: outFile,
      bytes: outBytes,
      filename: outFilename,
      mimeType: encoded.mimeType,
      declaredBytes: outBytes.byteLength,
      sha256,
      width: target.width,
      height: target.height,
      originalWidth: decoded.width,
      originalHeight: decoded.height,
      wasAvifConverted: avifDetected,
      wasResized: target.resized,
    };
  } finally {
    decoded.cleanup?.();
  }
}

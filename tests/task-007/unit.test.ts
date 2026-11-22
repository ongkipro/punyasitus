import fs from "node:fs";
import path from "node:path";
import {
  assertTenantR2Key,
  buildMediaDerivativeKeys,
  buildQuarantineR2Key,
  inspectImageBinary,
  InvalidTenantR2KeyError,
  MAX_SOURCE_UPLOAD_BYTES,
  readBoundedStream,
  slugifyMediaFilename,
} from "@punyasitus/core/media/index";
import { MEDIA_PIPELINE_MIGRATION_SQL } from "@punyasitus/db/storage-usage/index";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

// ---------------------------------------------------------------------------
// Minimal valid binary image builders for deterministic unit tests
// ---------------------------------------------------------------------------

function makePng(width: number, height: number, extraBytes = 0): Uint8Array {
  const buf = new Uint8Array(33 + extraBytes);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  buf.set(sig, 0);
  const view = new DataView(buf.buffer);
  view.setUint32(8, 13, false); // IHDR length
  buf.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  buf[24] = 8; // bit depth
  buf[25] = 6; // RGBA
  return buf;
}

function makeJpeg(width: number, height: number, withExif = false): Uint8Array {
  const parts: number[] = [0xff, 0xd8]; // SOI
  if (withExif) {
    // APP1 EXIF segment containing simulated GPS marker
    const exifText = Array.from(new TextEncoder().encode("Exif\0\0GPS_LAT_6.2088"));
    const segLen = exifText.length + 2;
    parts.push(0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff, ...exifText);
  }
  // SOF0 segment (length = 11)
  parts.push(
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  );
  parts.push(0xff, 0xd9); // EOI
  return new Uint8Array(parts);
}

function makeWebpVp8(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(32);
  const enc = new TextEncoder();
  buf.set(enc.encode("RIFF"), 0);
  const view = new DataView(buf.buffer);
  view.setUint32(4, 24, true);
  buf.set(enc.encode("WEBP"), 8);
  buf.set(enc.encode("VP8 "), 12);
  view.setUint32(16, 12, true);
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a;
  view.setUint16(26, width & 0x3fff, true);
  view.setUint16(28, height & 0x3fff, true);
  return buf;
}

function makeWebpVp8L(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(28);
  const enc = new TextEncoder();
  buf.set(enc.encode("RIFF"), 0);
  const view = new DataView(buf.buffer);
  view.setUint32(4, 20, true);
  buf.set(enc.encode("WEBP"), 8);
  buf.set(enc.encode("VP8L"), 12);
  view.setUint32(16, 8, true);
  buf[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  view.setUint32(21, bits >>> 0, true);
  return buf;
}

function makeWebpVp8X(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(30);
  const enc = new TextEncoder();
  buf.set(enc.encode("RIFF"), 0);
  const view = new DataView(buf.buffer);
  view.setUint32(4, 22, true);
  buf.set(enc.encode("WEBP"), 8);
  buf.set(enc.encode("VP8X"), 12);
  view.setUint32(16, 10, true);
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  buf[24] = wMinus1 & 0xff;
  buf[25] = (wMinus1 >> 8) & 0xff;
  buf[26] = (wMinus1 >> 16) & 0xff;
  buf[27] = hMinus1 & 0xff;
  buf[28] = (hMinus1 >> 8) & 0xff;
  buf[29] = (hMinus1 >> 16) & 0xff;
  return buf;
}

function makeGif(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(14);
  buf.set(new TextEncoder().encode("GIF89a"), 0);
  const view = new DataView(buf.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return buf;
}

function makeTiff(width: number, height: number, endian: "le" | "be" = "le"): Uint8Array {
  const little = endian === "le";
  // 8-byte header + 2-byte count + 2*12-byte entries + 4-byte next IFD = 38 bytes
  const buf = new Uint8Array(38);
  const view = new DataView(buf.buffer);
  if (little) {
    buf.set([0x49, 0x49, 0x2a, 0x00], 0);
  } else {
    buf.set([0x4d, 0x4d, 0x00, 0x2a], 0);
  }
  view.setUint32(4, 8, little); // IFD0 offset
  view.setUint16(8, 2, little); // 2 entries
  // Entry 0: tag 256 (ImageWidth), LONG (4), count 1, value = width
  view.setUint16(10, 256, little);
  view.setUint16(12, 4, little);
  view.setUint32(14, 1, little);
  view.setUint32(18, width, little);
  // Entry 1: tag 257 (ImageLength), LONG (4), count 1, value = height
  view.setUint16(22, 257, little);
  view.setUint16(24, 4, little);
  view.setUint32(26, 1, little);
  view.setUint32(30, height, little);
  return buf;
}

function makeBmffBox(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.byteLength, false);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
}

function makeIsoBmffImage(
  majorBrand: string,
  compatibleBrands: readonly string[],
  width: number,
  height: number,
): Uint8Array {
  const enc = new TextEncoder();
  const ftypPayload = new Uint8Array(8 + compatibleBrands.length * 4);
  ftypPayload.set(enc.encode(majorBrand), 0);
  // minor version 0 at 4..7
  compatibleBrands.forEach((b, i) => {
    ftypPayload.set(enc.encode(b), 8 + i * 4);
  });
  const ftypBox = makeBmffBox("ftyp", ftypPayload);

  const ispePayload = new Uint8Array(12);
  const ispeView = new DataView(ispePayload.buffer);
  ispeView.setUint32(4, width, false);
  ispeView.setUint32(8, height, false);
  const ispeBox = makeBmffBox("ispe", ispePayload);
  const ipcoBox = makeBmffBox("ipco", ispeBox);
  const iprpBox = makeBmffBox("iprp", ipcoBox);

  const metaPayload = new Uint8Array(4 + iprpBox.byteLength);
  metaPayload.set(iprpBox, 4); // FullBox version/flags = 0
  const metaBox = makeBmffBox("meta", metaPayload);

  const out = new Uint8Array(ftypBox.byteLength + metaBox.byteLength);
  out.set(ftypBox, 0);
  out.set(metaBox, ftypBox.byteLength);
  return out;
}

describe("TASK-007 unit tests — Media validation, magic-byte sniffing, streaming counter & R2 key guards", () => {
  it("keeps bundled 0002_media_upload_pipeline SQL byte-for-byte identical to disk", () => {
    const onDisk = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/tenant/0002_media_upload_pipeline.sql"),
      "utf8",
    );
    expect(MEDIA_PIPELINE_MIGRATION_SQL).toBe(onDisk);

    // Verify Worker entrypoint wires media.process_image & scheduled quarantine sweep
    const workerEntry = fs.readFileSync(
      path.join(ROOT, "apps/web/src/worker/index.ts"),
      "utf8",
    );
    expect(workerEntry).toContain("createMediaJobRegistry()");
    expect(workerEntry).toContain("sweepAllTenantsExpiredQuarantine");
  });

  it("accepts all 6 eligible image formats with real dimension parsing", () => {
    const jpeg = inspectImageBinary(makeJpeg(1600, 1200, true), "image/jpeg");
    expect(jpeg).toEqual({
      ok: true,
      mimeType: "image/jpeg",
      format: "jpeg",
      width: 1600,
      height: 1200,
      byteLength: expect.any(Number),
    });

    const png = inspectImageBinary(makePng(1920, 1080), "image/png");
    expect(png).toMatchObject({ ok: true, mimeType: "image/png", width: 1920, height: 1080 });

    const webpVp8 = inspectImageBinary(makeWebpVp8(1200, 800), "image/webp");
    expect(webpVp8).toMatchObject({ ok: true, mimeType: "image/webp", width: 1200, height: 800 });

    const webpVp8L = inspectImageBinary(makeWebpVp8L(640, 480), "image/webp");
    expect(webpVp8L).toMatchObject({ ok: true, mimeType: "image/webp", width: 640, height: 480 });

    const webpVp8X = inspectImageBinary(makeWebpVp8X(1280, 720), "image/webp");
    expect(webpVp8X).toMatchObject({ ok: true, mimeType: "image/webp", width: 1280, height: 720 });

    const heic = inspectImageBinary(makeIsoBmffImage("heic", ["mif1", "heic"], 4032, 3024), "image/heic");
    expect(heic).toMatchObject({ ok: true, mimeType: "image/heic", width: 4032, height: 3024 });

    const heif = inspectImageBinary(makeIsoBmffImage("mif1", ["mif1"], 2000, 1500), "image/heif");
    expect(heif).toMatchObject({ ok: true, mimeType: "image/heif", width: 2000, height: 1500 });

    const gif = inspectImageBinary(makeGif(500, 500), "image/gif");
    expect(gif).toMatchObject({ ok: true, mimeType: "image/gif", width: 500, height: 500 });

    const tiffLe = inspectImageBinary(makeTiff(2048, 1536, "le"), "image/tiff");
    expect(tiffLe).toMatchObject({ ok: true, mimeType: "image/tiff", width: 2048, height: 1536 });

    const tiffBe = inspectImageBinary(makeTiff(1024, 768, "be"), "image/tiff");
    expect(tiffBe).toMatchObject({ ok: true, mimeType: "image/tiff", width: 1024, height: 768 });
  });

  it("rejects SVG, BMP, AVIF, video containers, zero-byte, corrupt headers, MIME spoofing & oversized pixels", () => {
    // Zero-byte
    expect(inspectImageBinary(new Uint8Array(0), "image/png")).toMatchObject({
      ok: false,
      code: "EMPTY_FILE",
    });

    // SVG (plain, XML declaration, BOM, disguised as image/png)
    const svgPlain = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(inspectImageBinary(svgPlain, "image/png")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_FORMAT_SVG",
      status: 415,
    });
    const svgXml = new TextEncoder().encode('<?xml version="1.0"?><svg></svg>');
    expect(inspectImageBinary(svgXml, "image/jpeg")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_FORMAT_SVG",
    });

    // BMP
    const bmp = new Uint8Array([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(inspectImageBinary(bmp, "image/png")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_FORMAT_BMP",
      status: 415,
    });

    // AVIF (rejected server-side; browser island converts client-side)
    const avif = makeIsoBmffImage("avif", ["avif", "mif1"], 1200, 800);
    expect(inspectImageBinary(avif, "image/heif")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_FORMAT_AVIF",
      status: 415,
    });

    // Video formats (MP4, MOV, WebM)
    const mp4 = makeIsoBmffImage("isom", ["isom", "mp42"], 1920, 1080);
    expect(inspectImageBinary(mp4, "image/heic")).toMatchObject({
      ok: false,
      code: "VIDEO_NOT_SUPPORTED",
      status: 415,
    });
    const mov = makeIsoBmffImage("qt  ", ["qt  "], 1920, 1080);
    expect(inspectImageBinary(mov, "image/heic")).toMatchObject({
      ok: false,
      code: "VIDEO_NOT_SUPPORTED",
    });
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
    expect(inspectImageBinary(webm, "image/webp")).toMatchObject({
      ok: false,
      code: "VIDEO_NOT_SUPPORTED",
    });

    // Corrupt / truncated headers
    expect(inspectImageBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png")).toMatchObject({
      ok: false,
      code: "CORRUPT_IMAGE",
    });
    expect(inspectImageBinary(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg")).toMatchObject({
      ok: false,
      code: "CORRUPT_IMAGE",
    });
    expect(inspectImageBinary(new TextEncoder().encode("not an image at all"), "image/jpeg")).toMatchObject({
      ok: false,
      code: "CORRUPT_IMAGE",
    });

    // MIME spoofing (PNG binary declared as image/jpeg)
    expect(inspectImageBinary(makePng(800, 600), "image/jpeg")).toMatchObject({
      ok: false,
      code: "MIME_SPOOFING",
      status: 422,
    });

    // Pixel bounds: exact 8000x5000 = 40,000,000 passes; 8001x100, 100x8001, and 7000x7000 = 49M fail
    expect(inspectImageBinary(makePng(8000, 5000), "image/png")).toMatchObject({ ok: true });
    expect(inspectImageBinary(makePng(8001, 100), "image/png")).toMatchObject({
      ok: false,
      code: "OVERSIZED_DIMENSIONS",
    });
    expect(inspectImageBinary(makePng(100, 8001), "image/png")).toMatchObject({
      ok: false,
      code: "OVERSIZED_DIMENSIONS",
    });
    expect(inspectImageBinary(makePng(7000, 7000), "image/png")).toMatchObject({
      ok: false,
      code: "OVERSIZED_DIMENSIONS",
    });
  });

  it("enforces hard streaming byte counter at 5,000,000 vs 5,000,001 bytes and aborts mid-stream", async () => {
    // Exact 5,000,000 bytes passes
    const exactChunks = [
      new Uint8Array(2_000_000),
      new Uint8Array(2_000_000),
      new Uint8Array(1_000_000),
    ];
    const exactStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of exactChunks) controller.enqueue(c);
        controller.close();
      },
    });
    const exactRes = await readBoundedStream(exactStream, MAX_SOURCE_UPLOAD_BYTES);
    expect(exactRes.ok).toBe(true);
    if (exactRes.ok) {
      expect(exactRes.byteLength).toBe(5_000_000);
    }

    // 5,000,001 bytes aborts immediately without pulling subsequent chunks
    let pulledChunks = 0;
    let cancelled = false;
    const overStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulledChunks += 1;
        if (pulledChunks === 1) {
          controller.enqueue(new Uint8Array(3_000_000));
        } else if (pulledChunks === 2) {
          controller.enqueue(new Uint8Array(2_000_001)); // crosses 5,000,000!
        } else {
          // Should never be reached
          controller.enqueue(new Uint8Array(10_000_000));
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });

    const overRes = await readBoundedStream(overStream, MAX_SOURCE_UPLOAD_BYTES);
    expect(overRes.ok).toBe(false);
    if (!overRes.ok) {
      expect(overRes.code).toBe("PAYLOAD_TOO_LARGE");
      expect(overRes.status).toBe(413);
      expect(overRes.bytesRead).toBe(5_000_001);
    }
    expect(cancelled).toBe(true);
    expect(pulledChunks).toBe(2);
  });

  it("generates deterministic slugified derivative filenames and enforces strict tenant R2 key guards", () => {
    expect(slugifyMediaFilename("Café Promo Bali 2026!!.HEIC")).toBe("cafe-promo-bali-2026");
    expect(slugifyMediaFilename("../../secret/Foto Produk Utama.PNG")).toBe("foto-produk-utama");
    expect(slugifyMediaFilename("🔥🔥🔥.jpg")).toBe("media");

    const keys = buildMediaDerivativeKeys("01JTESTTENANTALPHA00000001", 42, "Paket Wisata Ubud.jpg");
    expect(keys).toEqual({
      master: "t/01JTESTTENANTALPHA00000001/media/42/paket-wisata-ubud-master.webp",
      w640: "t/01JTESTTENANTALPHA00000001/media/42/paket-wisata-ubud-w640.webp",
      w1280: "t/01JTESTTENANTALPHA00000001/media/42/paket-wisata-ubud-w1280.webp",
      thumb: "t/01JTESTTENANTALPHA00000001/media/42/paket-wisata-ubud-thumb.webp",
      og: "t/01JTESTTENANTALPHA00000001/media/42/paket-wisata-ubud-og.webp",
    });

    const qKey = buildQuarantineR2Key(
      "01JTESTTENANTALPHA00000001",
      "01JINTENT00000000000000001",
      "Paket Wisata Ubud.jpg",
    );
    expect(qKey).toBe(
      "t/01JTESTTENANTALPHA00000001/quarantine/01JINTENT00000000000000001/paket-wisata-ubud",
    );

    // Tenant R2 key guard accepts valid keys
    expect(assertTenantR2Key("tenantA", "t/tenantA/quarantine/intent1/hero", ["quarantine"])).toBe(
      "t/tenantA/quarantine/intent1/hero",
    );
    expect(assertTenantR2Key("tenantA", "t/tenantA/media/1/hero-master.webp", ["media"])).toBe(
      "t/tenantA/media/1/hero-master.webp",
    );

    // Rejects foreign tenant, traversal, encoded separators, wrong area
    for (const badKey of [
      "t/tenantB/media/1/hero-master.webp",
      "t/tenantA/media/../tenantB/1/hero.webp",
      "t/tenantA/media/%2e%2e/secret.webp",
      "t/tenantA/backups/db.sql",
      "t/tenantA/media//double.webp",
      "t/tenantA/quarantine\\win",
    ]) {
      expect(() => assertTenantR2Key("tenantA", badKey, ["quarantine", "media"])).toThrow(
        InvalidTenantR2KeyError,
      );
    }
  });
});

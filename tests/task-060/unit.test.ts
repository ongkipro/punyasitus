import fs from "node:fs";
import path from "node:path";
import { inspectImageBinary } from "@punyasitus/core/media/index";
import {
  buildVideoDerivativeKeys,
  createShortVideoBlock,
  getDefaultVideoPosterWebpBytes,
  inspectVideoBinary,
  MAX_CAPTION_VTT_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  rewriteMp4FastStartAndStripMetadata,
  sanitizePublicVideoAssetUrl,
  validateAndSanitizeWebVtt,
  validateVideoPlacement,
} from "@punyasitus/core/media/video";
import { SHORT_VIDEO_PIPELINE_MIGRATION_SQL } from "@punyasitus/db/media/video";
import { describe, expect, it } from "vitest";
import {
  createVideoJobRegistry,
  MEDIA_PROCESS_VIDEO_TOPIC,
} from "../../apps/web/src/worker/queues/media/video/index.ts";
import {
  buildSyntheticIsoBmffVideo,
  buildSyntheticWebmVideo,
  readStcoOffsetsFromMp4,
  SAMPLE_VALID_WEBVTT,
  SAMPLE_XSS_WEBVTT,
} from "./fixtures.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-060 unit: Short video inspection, pure-JS fast-start rewriter, WebVTT sanitizer & placement guards", () => {
  it("keeps bundled 0006_short_video_pipeline SQL byte-for-byte identical to disk", () => {
    const diskSql = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/tenant/0006_short_video_pipeline.sql"),
      "utf8",
    );
    expect(SHORT_VIDEO_PIPELINE_MIGRATION_SQL).toBe(diskSql);
  });

  it("accepts exact 10,000,000-byte MP4/MOV/WebM and rejects 10,000,001 bytes with 413", () => {
    const exactMp4 = buildSyntheticIsoBmffVideo({
      brand: "mp4",
      width: 1920,
      height: 1080,
      fps: 60,
      targetTotalBytes: MAX_VIDEO_UPLOAD_BYTES,
    });
    expect(exactMp4.byteLength).toBe(10_000_000);
    const mp4Res = inspectVideoBinary(exactMp4, "video/mp4");
    expect(mp4Res).toMatchObject({
      ok: true,
      mimeType: "video/mp4",
      format: "mp4",
      width: 1920,
      height: 1080,
      fps: 60,
      isCompliantH264AacMp4: true,
      processingPath: "worker_faststart",
    });

    const overMp4 = buildSyntheticIsoBmffVideo({
      brand: "mp4",
      targetTotalBytes: MAX_VIDEO_UPLOAD_BYTES + 1,
    });
    expect(overMp4.byteLength).toBe(10_000_001);
    expect(inspectVideoBinary(overMp4, "video/mp4")).toMatchObject({
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });

    const exactMov = buildSyntheticIsoBmffVideo({
      brand: "mov",
      width: 1280,
      height: 720,
      fps: 30,
      videoCodec: "hvc1",
      targetTotalBytes: MAX_VIDEO_UPLOAD_BYTES,
    });
    expect(exactMov.byteLength).toBe(10_000_000);
    expect(inspectVideoBinary(exactMov, "video/quicktime")).toMatchObject({
      ok: true,
      mimeType: "video/quicktime",
      format: "mov",
      isCompliantH264AacMp4: false,
      processingPath: "container_transcode",
    });

    const exactWebm = buildSyntheticWebmVideo({
      width: 1280,
      height: 720,
      fps: 30,
      targetTotalBytes: MAX_VIDEO_UPLOAD_BYTES,
    });
    expect(exactWebm.byteLength).toBe(10_000_000);
    expect(inspectVideoBinary(exactWebm, "video/webm")).toMatchObject({
      ok: true,
      mimeType: "video/webm",
      format: "webm",
      isCompliantH264AacMp4: false,
      processingPath: "container_transcode",
    });
  });

  it("rejects spoofed MIME, >1920x1080 resolution, >60 fps, corrupt containers, and non-video payloads", () => {
    const mp4 = buildSyntheticIsoBmffVideo({ brand: "mp4", width: 1280, height: 720, fps: 30 });
    expect(inspectVideoBinary(mp4, "video/webm")).toMatchObject({
      ok: false,
      code: "MIME_SPOOFING",
      status: 422,
    });
    expect(inspectVideoBinary(mp4, "video/quicktime")).toMatchObject({
      ok: false,
      code: "MIME_SPOOFING",
      status: 422,
    });

    const oversizedResMp4 = buildSyntheticIsoBmffVideo({ width: 1921, height: 1080, fps: 30 });
    expect(inspectVideoBinary(oversizedResMp4, "video/mp4")).toMatchObject({
      ok: false,
      code: "OVERSIZED_DIMENSIONS",
      status: 422,
    });

    const oversizedHeightWebm = buildSyntheticWebmVideo({ width: 1920, height: 1081, fps: 30 });
    expect(inspectVideoBinary(oversizedHeightWebm, "video/webm")).toMatchObject({
      ok: false,
      code: "OVERSIZED_DIMENSIONS",
      status: 422,
    });

    const highFpsMp4 = buildSyntheticIsoBmffVideo({ width: 1280, height: 720, fps: 120 });
    expect(inspectVideoBinary(highFpsMp4, "video/mp4")).toMatchObject({
      ok: false,
      code: "OVERSIZED_FRAMERATE",
      status: 422,
    });

    const highFpsWebm = buildSyntheticWebmVideo({ width: 1280, height: 720, fps: 90 });
    expect(inspectVideoBinary(highFpsWebm, "video/webm")).toMatchObject({
      ok: false,
      code: "OVERSIZED_FRAMERATE",
      status: 422,
    });

    // MKV DocType rejected
    const mkv = buildSyntheticWebmVideo({ docType: "matroska" });
    expect(inspectVideoBinary(mkv, "video/webm")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
    });

    // Empty, SVG, PNG disguised as video, truncated MP4
    expect(inspectVideoBinary(new Uint8Array(0), "video/mp4")).toMatchObject({
      ok: false,
      code: "EMPTY_FILE",
      status: 422,
    });
    expect(
      inspectVideoBinary(new TextEncoder().encode("<svg><script>alert(1)</script></svg>"), "video/mp4"),
    ).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
    });
    expect(inspectVideoBinary(mp4.slice(0, 48), "video/mp4")).toMatchObject({
      ok: false,
      code: "CORRUPT_VIDEO",
      status: 422,
    });
  });

  it("rewrites compliant H.264/AAC MP4 fast-start (moov before mdat), strips GPS metadata, patches stco offsets accurately, and stays fast within Worker CPU budget", () => {
    const input = buildSyntheticIsoBmffVideo({
      brand: "mp4",
      width: 1280,
      height: 720,
      fps: 30,
      moovFirst: false,
      includeLocationMetadata: true,
      targetTotalBytes: 2_000_000, // 2 MB realistic short video benchmark
    });

    const beforeAscii = new TextDecoder("latin1").decode(input);
    expect(beforeAscii).toContain("GPS_PRIVATE_COORDS");
    expect(beforeAscii).toContain("PRIVATE_CAMERA_META_EXIF");
    expect(beforeAscii).toContain("TRAK_DEVICE_SERIAL_SECRET_12345");

    const beforeInspected = inspectVideoBinary(input, "video/mp4");
    expect(beforeInspected).toMatchObject({ ok: true, moovBeforeMdat: false });

    const t0 = performance.now();
    const rewritten = rewriteMp4FastStartAndStripMetadata(input);
    const elapsedMs = performance.now() - t0;

    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;

    expect(rewritten.moovBeforeMdat).toBe(true);
    expect(rewritten.wasAlreadyFastStart).toBe(false);
    expect(rewritten.strippedBoxTypes).toContain("udta");
    expect(rewritten.strippedBoxTypes).toContain("meta");
    expect(rewritten.patchedChunkOffsets).toBeGreaterThanOrEqual(2);
    // Must stay well within Cloudflare Worker CPU limits (expect < 100ms even on slow CI)
    expect(elapsedMs).toBeLessThan(250);

    // Zero GPS / EXIF / device serial bytes remain anywhere in output!
    const afterAscii = new TextDecoder("latin1").decode(rewritten.bytes);
    expect(afterAscii).not.toContain("GPS_PRIVATE_COORDS");
    expect(afterAscii).not.toContain("PRIVATE_CAMERA_META_EXIF");
    expect(afterAscii).not.toContain("TRAK_DEVICE_SERIAL_SECRET_12345");

    // Re-inspecting rewritten MP4 proves valid structure AND moov before mdat
    const afterInspected = inspectVideoBinary(rewritten.bytes, "video/mp4");
    expect(afterInspected).toMatchObject({
      ok: true,
      width: 1280,
      height: 720,
      fps: 30,
      moovBeforeMdat: true,
      isCompliantH264AacMp4: true,
    });

    // Verify stco chunk offsets point to the exact relocated `PS_MDAT_START!` marker inside `mdat`!
    const stcoOffsets = readStcoOffsetsFromMp4(rewritten.bytes);
    expect(stcoOffsets.length).toBeGreaterThanOrEqual(2);
    for (const off of stcoOffsets) {
      const marker = new TextDecoder("latin1").decode(rewritten.bytes.slice(off, off + 14));
      expect(marker).toBe("PS_MDAT_START!");
    }
  });

  it("provides a built-in default poster that passes strict image/webp binary verification", () => {
    const poster = getDefaultVideoPosterWebpBytes();
    const inspected = inspectImageBinary(poster, "image/webp");
    expect(inspected).toMatchObject({
      ok: true,
      mimeType: "image/webp",
      format: "webp",
    });
  });

  it("validates WebVTT strictly: header, cue syntax, XSS/HTML stripping, STYLE block rejection, and size cap", () => {
    const valid = validateAndSanitizeWebVtt(SAMPLE_VALID_WEBVTT);
    expect(valid).toMatchObject({ ok: true, cueCount: 2, strippedHtml: false });

    const xss = validateAndSanitizeWebVtt(SAMPLE_XSS_WEBVTT);
    expect(xss.ok).toBe(true);
    if (xss.ok) {
      expect(xss.strippedHtml).toBe(true);
      expect(xss.sanitizedVtt).not.toContain("<script");
      expect(xss.sanitizedVtt).not.toContain("alert(");
      expect(xss.sanitizedVtt).not.toContain("onerror");
      expect(xss.sanitizedVtt).not.toContain("<img");
      expect(xss.sanitizedVtt).not.toContain("NOTE");
      expect(xss.sanitizedVtt).toContain("Halo pengunjung kami.");
    }

    // Script-only cue becomes empty after stripping -> rejected 422
    const scriptOnly = validateAndSanitizeWebVtt(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<script>alert(1)</script>\n",
    );
    expect(scriptOnly).toMatchObject({ ok: false, code: "INVALID_WEBVTT_CUE", status: 422 });

    // Missing WEBVTT header
    expect(
      validateAndSanitizeWebVtt("00:00:00.000 --> 00:00:02.000\nHalo\n"),
    ).toMatchObject({ ok: false, code: "INVALID_WEBVTT_HEADER", status: 422 });

    // STYLE block rejected (CSS injection vector)
    expect(
      validateAndSanitizeWebVtt(
        "WEBVTT\n\nSTYLE\n::cue { color: red; }\n\n00:00:00.000 --> 00:00:02.000\nHalo\n",
      ),
    ).toMatchObject({ ok: false, code: "FORBIDDEN_WEBVTT_STYLE", status: 422 });

    // Reversed timestamp rejected
    expect(
      validateAndSanitizeWebVtt("WEBVTT\n\n00:00:05.000 --> 00:00:02.000\nTerbalik\n"),
    ).toMatchObject({ ok: false, code: "INVALID_WEBVTT_CUE", status: 422 });

    // Size cap > 256,000 bytes -> 413
    const oversizedVtt = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${"a".repeat(MAX_CAPTION_VTT_BYTES)}\n`;
    expect(validateAndSanitizeWebVtt(oversizedVtt)).toMatchObject({
      ok: false,
      code: "CAPTION_TOO_LARGE",
      status: 413,
    });
  });

  it("rejects hero placement, autoplay, and quarantine/hostile URLs while building tenant-scoped R2 keys", () => {
    expect(validateVideoPlacement("hero")).toMatchObject({
      ok: false,
      code: "VIDEO_HERO_PLACEMENT_FORBIDDEN",
      status: 422,
    });
    expect(validateVideoPlacement("portfolio")).toMatchObject({
      ok: true,
      placement: "portfolio",
    });

    expect(
      createShortVideoBlock({
        mediaId: 1,
        src: "/media/t/tenant-a/media/1/promo.mp4",
        posterUrl: "/media/t/tenant-a/media/1/promo-poster.webp",
        width: 1280,
        height: 720,
        title: "Video Hero Terlarang",
        placement: "hero",
      }),
    ).toMatchObject({ ok: false, code: "VIDEO_HERO_PLACEMENT_FORBIDDEN" });

    expect(
      createShortVideoBlock({
        mediaId: 1,
        src: "/media/t/tenant-a/media/1/promo.mp4",
        posterUrl: "/media/t/tenant-a/media/1/promo-poster.webp",
        width: 1280,
        height: 720,
        title: "Autoplay Terlarang",
        placement: "portfolio",
        autoplay: true,
      }),
    ).toMatchObject({ ok: false, code: "VIDEO_AUTOPLAY_FORBIDDEN" });

    // Quarantine & javascript URLs strictly rejected
    expect(sanitizePublicVideoAssetUrl("https://media.punyasitus.com/t/abc/quarantine/1/x.mp4")).toBeNull();
    expect(sanitizePublicVideoAssetUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizePublicVideoAssetUrl("/media/t/abc/../other/x.mp4")).toBeNull();

    const keys = buildVideoDerivativeKeys("01JT060TENANT0000000000001", 7, "Profil Kantor 2026!.MOV");
    expect(keys).toEqual({
      video: "t/01JT060TENANT0000000000001/media/7/profil-kantor-2026.mp4",
      poster: "t/01JT060TENANT0000000000001/media/7/profil-kantor-2026-poster.webp",
      captions: "t/01JT060TENANT0000000000001/media/7/profil-kantor-2026-captions.vtt",
    });
  });

  it("wires media.process_video into production WORKER_JOB_REGISTRY (apps/web/src/worker/index.ts)", () => {
    const registry = createVideoJobRegistry();
    expect(registry[MEDIA_PROCESS_VIDEO_TOPIC]).toBeDefined();
    expect(typeof registry[MEDIA_PROCESS_VIDEO_TOPIC]?.execute).toBe("function");

    const workerSource = fs.readFileSync(
      path.join(ROOT, "apps/web/src/worker/index.ts"),
      "utf8",
    );
    expect(workerSource).toMatch(/import\s*\{[^}]*createVideoJobRegistry[^}]*\}\s*from\s*["']\.\/queues\/media\/video\/index\.ts["']/);
    expect(workerSource).toMatch(/WORKER_JOB_REGISTRY[\s\S]*\.\.\.createVideoJobRegistry\(\)/);
  });

  it("excludes fragmented MP4 (moof/mvex), multi-video-track MP4, and timed-metadata (mebx) tracks from pure-JS worker_faststart", () => {
    // 1. Fragmented MP4 (moof + mvex) -> MUST NOT take worker_faststart!
    const fragmentedMp4 = buildSyntheticIsoBmffVideo({
      brand: "mp4",
      width: 1280,
      height: 720,
      fps: 30,
      fragmented: true,
    });
    expect(inspectVideoBinary(fragmentedMp4, "video/mp4")).toMatchObject({
      ok: true,
      hasFragments: true,
      isCompliantH264AacMp4: false,
      processingPath: "container_transcode",
    });
    expect(rewriteMp4FastStartAndStripMetadata(fragmentedMp4)).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_FASTSTART",
    });

    // 2. Timed-metadata track (`mebx` — e.g. iPhone/GoPro timed GPS stream) -> MUST NOT take worker_faststart!
    const mebxMp4 = buildSyntheticIsoBmffVideo({
      brand: "mp4",
      width: 1280,
      height: 720,
      fps: 30,
      auxiliaryTrackHandler: "mebx",
    });
    expect(inspectVideoBinary(mebxMp4, "video/mp4")).toMatchObject({
      ok: true,
      hasAuxiliaryTracks: true,
      isCompliantH264AacMp4: false,
      processingPath: "container_transcode",
    });
    expect(rewriteMp4FastStartAndStripMetadata(mebxMp4)).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_FASTSTART",
    });

    // 3. Multi-video-track MP4 -> MUST NOT take worker_faststart!
    const multiVideoMp4 = buildSyntheticIsoBmffVideo({
      brand: "mp4",
      width: 1280,
      height: 720,
      fps: 30,
      extraVideoTrack: { width: 640, height: 360, fps: 30 },
    });
    expect(inspectVideoBinary(multiVideoMp4, "video/mp4")).toMatchObject({
      ok: true,
      videoTrackCount: 2,
      isCompliantH264AacMp4: false,
      processingPath: "container_transcode",
    });
    expect(rewriteMp4FastStartAndStripMetadata(multiVideoMp4)).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_FASTSTART",
    });

    // 4. Secondary oversized video track (> 1920x1080) hidden behind a 720p first track -> REJECTED!
    const hidden4kSecondTrack = buildSyntheticIsoBmffVideo({
      brand: "mp4",
      width: 1280,
      height: 720,
      fps: 30,
      extraVideoTrack: { width: 3840, height: 2160, fps: 30 },
    });
    expect(inspectVideoBinary(hidden4kSecondTrack, "video/mp4")).toMatchObject({
      ok: false,
      code: "OVERSIZED_DIMENSIONS",
      status: 422,
    });
  });
});

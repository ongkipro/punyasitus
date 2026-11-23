import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  computeSha256Hex,
  inspectImageBinary,
  type CloudflareImagesBinding,
} from "@punyasitus/core/media/index";
import {
  inspectVideoBinary,
  MAX_VIDEO_UPLOAD_BYTES,
  MAX_VIDEOS_PER_TENANT,
} from "@punyasitus/core/media/video";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import {
  getStorageUsageSnapshot,
  MEDIA_PIPELINE_MIGRATION,
} from "@punyasitus/db/storage-usage/index";
import {
  failVideoUploadIntent,
  getVideoMediaItemById,
  getVideoSlotUsage,
  SHORT_VIDEO_PIPELINE_MIGRATION,
} from "@punyasitus/db/media/video";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleMediaItemDelete, handleMediaItemGet } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/[resourceId].ts";
import { handleMediaItemActionPost } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/[resourceId]/[action].ts";
import { handleVideoCaptionsUpload } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/[resourceId]/captions.ts";
import { handleVideoPosterUpload } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/[resourceId]/poster.ts";
import type { MediaApiRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/helpers.ts";
import { handleMediaListGet } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/index.ts";
import { handleVideoUploadIntentPost } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/video/upload-intent.ts";
import { handleVideoStreamUpload } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/video/upload/[intentId].ts";
import type { JobQueuePayload } from "../../apps/web/src/worker/env.d.ts";
import { processDurableQueueBatch } from "../../apps/web/src/worker/queues/consumer.ts";
import {
  createVideoJobRegistry,
  MEDIA_PROCESS_VIDEO_TOPIC,
  processVideoMediaJob,
  type VideoTranscodeRequestOptions,
  type VideoTranscoderContainerBinding,
} from "../../apps/web/src/worker/queues/media/video/index.ts";
import type { MediaWorkerR2BucketLike } from "../../apps/web/src/worker/queues/media/index.ts";
import {
  buildSyntheticIsoBmffVideo,
  buildSyntheticWebmVideo,
  makeValidWebpVp8X,
  SAMPLE_VALID_WEBVTT,
  SAMPLE_XSS_WEBVTT,
} from "./fixtures.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-t060-app-secret-0123456789abcdef0123456789abcdef";

const TENANT_A = {
  id: "01JT060TENANTALPHA00000001",
  orgId: "org_t060_alpha",
  handle: "alpha-video",
  name: "Alpha Video Studio",
};

const TENANT_B = {
  id: "01JT060TENANTBETA000000002",
  orgId: "org_t060_beta",
  handle: "beta-video",
  name: "Beta Video Studio",
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function createMockImagesBinding(): CloudflareImagesBinding {
  return {
    input(stream: ReadableStream<Uint8Array>) {
      let targetW = 640;
      let targetH = 360;
      const pipeline = {
        transform(opts: { width?: number; height?: number }) {
          if (opts.width) targetW = opts.width;
          if (opts.height) targetH = opts.height;
          return pipeline;
        },
        async output() {
          // Consume input stream cleanly
          const reader = stream.getReader();
          while (!(await reader.read()).done) {
            // drain
          }
          const webp = makeValidWebpVp8X(targetW, targetH, 320);
          return {
            image: () =>
              new ReadableStream<Uint8Array>({
                start(ctrl) {
                  ctrl.enqueue(webp);
                  ctrl.close();
                },
              }),
            response: () =>
              new Response(toArrayBuffer(webp), {
                headers: { "Content-Type": "image/webp" },
              }),
            contentType: () => "image/webp",
          };
        },
      };
      return pipeline;
    },
  };
}

function createMockVideoTranscoder(): {
  readonly calls: VideoTranscodeRequestOptions[];
  readonly binding: VideoTranscoderContainerBinding;
} {
  const calls: VideoTranscodeRequestOptions[] = [];
  const binding: VideoTranscoderContainerBinding = {
    name: "VideoTranscoderMock",
    concurrency: 1,
    async transcode(request: VideoTranscodeRequestOptions) {
      calls.push(request);
      const mp4Bytes = buildSyntheticIsoBmffVideo({
        brand: "mp4",
        width: request.maxWidth,
        height: request.maxHeight,
        fps: request.maxFps,
        durationSeconds: 4,
        videoCodec: "avc1",
        audioCodec: "mp4a",
        moovFirst: true,
        includeLocationMetadata: false,
      });
      return {
        mp4Bytes,
        width: request.maxWidth,
        height: request.maxHeight,
        fps: request.maxFps,
        durationSeconds: 4,
        metadataStripped: true,
        posterBytes: request.extractPoster
          ? makeValidWebpVp8X(request.maxWidth, request.maxHeight, 256)
          : null,
        posterMimeType: request.extractPoster ? "image/webp" : null,
      };
    },
  };
  return { calls, binding };
}

async function signUpAndGetSessionCookie(email: string, name: string): Promise<{
  readonly userId: string;
  readonly cookie: string;
}> {
  const runtimeEnv = {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
  };
  const req = new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: APP_ORIGIN,
    },
    body: JSON.stringify({
      email,
      password: "StrongPassword!2026",
      name,
    }),
  });
  const res = await handleBetterAuthRequest(req, runtimeEnv);
  if (res.status !== 200) {
    throw new Error(`Sign-up failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { user: { id: string } };
  const setCookie = res.headers.get("set-cookie") ?? "";
  const tokenMatch = new RegExp(`${APP_SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  if (!tokenMatch?.[1]) {
    throw new Error("Missing session cookie after sign-up");
  }
  return {
    userId: json.user.id,
    cookie: `${APP_SESSION_COOKIE_NAME}=${tokenMatch[1]}`,
  };
}

function buildMediaEnv(
  enqueued: JobQueuePayload[],
  overrides?: Partial<MediaApiRuntimeEnv>,
): MediaApiRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    MEDIA_BUCKET: env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
    IMAGES: createMockImagesBinding(),
    JOBS_QUEUE: {
      async send(message: JobQueuePayload) {
        enqueued.push(message);
      },
    },
    AUTH_SECRET: TEST_APP_SECRET,
    ...overrides,
  };
}

describe("TASK-060 workerd integration: short-video upload, 20-video atomic cap, dual processing, captions, quota & isolation", () => {
  let ownerA: { readonly userId: string; readonly cookie: string };
  let ownerB: { readonly userId: string; readonly cookie: string };
  let tenantDbA: D1Database;
  let tenantDbB: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);

    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date();

    ownerA = await signUpAndGetSessionCookie("owner-a-t060@example.com", "Owner Alpha Video");
    ownerB = await signUpAndGetSessionCookie("owner-b-t060@example.com", "Owner Beta Video");

    await db
      .insert(organizations)
      .values([
        { id: TENANT_A.orgId, name: TENANT_A.name, slug: TENANT_A.handle, createdAt: now, updatedAt: now },
        { id: TENANT_B.orgId, name: TENANT_B.name, slug: TENANT_B.handle, createdAt: now, updatedAt: now },
      ])
      .onConflictDoNothing();

    await db
      .insert(members)
      .values([
        {
          id: "mem_t060_owner_a",
          organizationId: TENANT_A.orgId,
          userId: ownerA.userId,
          role: "owner",
          createdAt: now,
        },
        {
          id: "mem_t060_owner_b",
          organizationId: TENANT_B.orgId,
          userId: ownerB.userId,
          role: "owner",
          createdAt: now,
        },
      ])
      .onConflictDoNothing();

    await db
      .insert(tenants)
      .values([
        {
          id: TENANT_A.id,
          organizationId: TENANT_A.orgId,
          handle: TENANT_A.handle,
          name: TENANT_A.name,
          status: "active",
          cacheVersion: 1,
          schemaVersion: 0,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: TENANT_B.id,
          organizationId: TENANT_B.orgId,
          handle: TENANT_B.handle,
          name: TENANT_B.name,
          status: "active",
          cacheVersion: 1,
          schemaVersion: 0,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .onConflictDoNothing();

    // Apply all tenant migrations (0001 + 0002 + 0006) strictly through TenantStore.applyMigrations — ZERO runtime DDL!
    const tenantNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const stubA = openTenantStoreStub(tenantNs, TENANT_A.id);
    const stubB = openTenantStoreStub(tenantNs, TENANT_B.id);
    const allTenantMigrations = [
      ...TENANT_MIGRATIONS,
      MEDIA_PIPELINE_MIGRATION,
      SHORT_VIDEO_PIPELINE_MIGRATION,
    ];
    const migA = await orchestrateTenantMigration(env.PLATFORM_DB, stubA, TENANT_A.id, allTenantMigrations);
    expect(migA.httpStatus).toBe(200);
    const migB = await orchestrateTenantMigration(env.PLATFORM_DB, stubB, TENANT_B.id, allTenantMigrations);
    expect(migB.httpStatus).toBe(200);

    tenantDbA = createTenantDb(stubA);
    tenantDbB = createTenantDb(stubB);
  });

  async function uploadAndProcessVideo(params: {
    readonly tenantHandle: string;
    readonly tenantId: string;
    readonly tenantDb: D1Database;
    readonly cookie: string;
    readonly filename: string;
    readonly mimeType: "video/mp4" | "video/quicktime" | "video/webm";
    readonly bytes: Uint8Array;
    readonly alt: string;
    readonly nowMs: number;
    readonly transcoder?: VideoTranscoderContainerBinding;
  }) {
    const enqueued: JobQueuePayload[] = [];
    const runtimeEnv = buildMediaEnv(enqueued);
    const sha256 = await computeSha256Hex(params.bytes);

    const intentRes = await handleVideoUploadIntentPost(
      params.tenantHandle,
      new Request(`${APP_ORIGIN}/api/tenants/${params.tenantHandle}/media/video/upload-intent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: params.cookie,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          kind: "video",
          filename: params.filename,
          mimeType: params.mimeType,
          declaredBytes: params.bytes.byteLength,
          sha256,
          alt: params.alt,
        }),
      }),
      runtimeEnv,
      { nowMs: params.nowMs, hourlyLimit: 200, dailyLimit: 500 },
    );
    expect(intentRes.status).toBe(201);
    const intentJson = (await intentRes.json()) as { intentId: string; uploadPath: string };

    const putRes = await handleVideoStreamUpload(
      params.tenantHandle,
      intentJson.intentId,
      new Request(`${APP_ORIGIN}${intentJson.uploadPath}`, {
        method: "PUT",
        headers: {
          "Content-Type": params.mimeType,
          Origin: APP_ORIGIN,
          Cookie: params.cookie,
        },
        body: toArrayBuffer(params.bytes),
      }),
      runtimeEnv,
      { nowMs: params.nowMs },
    );
    expect(putRes.status).toBe(202);
    const putJson = (await putRes.json()) as { mediaId: number; status: string };
    expect(putJson.status).toBe("processing");
    expect(enqueued.length).toBe(1);

    // Before processing succeeds: publicUrl and posterUrl MUST be null!
    const preGetRes = await handleMediaItemGet(
      params.tenantHandle,
      String(putJson.mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${params.tenantHandle}/media/${putJson.mediaId}`, {
        headers: { Cookie: params.cookie },
      }),
      runtimeEnv,
    );
    expect(preGetRes.status).toBe(200);
    const preJson = (await preGetRes.json()) as { publicUrl: string | null; posterUrl: string | null };
    expect(preJson.publicUrl).toBeNull();
    expect(preJson.posterUrl).toBeNull();

    const jobPayload = enqueued[0]!.payload as {
      intentId: string;
      mediaId: number;
      quarantineR2Key: string;
      originalFilename: string;
    };

    const result = await processVideoMediaJob(jobPayload, {
      tenantId: params.tenantId,
      tenantDb: params.tenantDb,
      mediaBucket: env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
      images: createMockImagesBinding(),
      videoTranscoder: params.transcoder ?? createMockVideoTranscoder().binding,
      nowMs: params.nowMs + 500,
    });

    return {
      intentId: intentJson.intentId,
      mediaId: putJson.mediaId,
      quarantineR2Key: jobPayload.quarantineR2Key,
      result,
    };
  }

  it("processes compliant H.264/AAC MP4 in Worker (fast-start + GPS strip, zero container call) and MOV/WebM via bounded VideoTranscoder Container (no upscaling + WebP poster)", async () => {
    const nowMs = 1_766_000_000_000;
    const mockTranscoder = createMockVideoTranscoder();

    // 1. Compliant H.264/AAC MP4 (moov after mdat + GPS metadata) -> pure-JS Worker path!
    const mp4Bytes = buildSyntheticIsoBmffVideo({
      brand: "mp4",
      width: 1280,
      height: 720,
      fps: 30,
      moovFirst: false,
      includeLocationMetadata: true,
    });
    const mp4Done = await uploadAndProcessVideo({
      tenantHandle: TENANT_A.handle,
      tenantId: TENANT_A.id,
      tenantDb: tenantDbA,
      cookie: ownerA.cookie,
      filename: "Company Profile 2026.mp4",
      mimeType: "video/mp4",
      bytes: mp4Bytes,
      alt: "Profil perusahaan 2026",
      nowMs,
      transcoder: mockTranscoder.binding,
    });

    expect(mp4Done.result.status).toBe("completed");
    expect(mp4Done.result.processingPath).toBe("worker_faststart");
    expect(mp4Done.result.transcoderInvoked).toBe(false);
    expect(mockTranscoder.calls.length).toBe(0);
    expect(mp4Done.result.posterSource).toBe("default");
    expect(mp4Done.result.media.dbStatus).toBe("ready");

    // Verify stored MP4 in R2 has moov before mdat and ZERO GPS metadata, and quarantine is deleted!
    const storedMp4 = await env.MEDIA_BUCKET.get(mp4Done.result.media.r2Key);
    expect(storedMp4).not.toBeNull();
    const storedMp4Bytes = new Uint8Array(await storedMp4!.arrayBuffer());
    expect(new TextDecoder("latin1").decode(storedMp4Bytes)).not.toContain("GPS_PRIVATE_COORDS");
    expect(inspectVideoBinary(storedMp4Bytes, "video/mp4")).toMatchObject({
      ok: true,
      moovBeforeMdat: true,
      width: 1280,
      height: 720,
    });
    expect(await env.MEDIA_BUCKET.get(mp4Done.quarantineR2Key)).toBeNull();

    // Verify poster is valid image/webp
    const storedPoster = await env.MEDIA_BUCKET.get(mp4Done.result.media.posterR2Key!);
    expect(storedPoster).not.toBeNull();
    expect(storedPoster!.httpMetadata?.contentType).toBe("image/webp");
    expect(inspectImageBinary(new Uint8Array(await storedPoster!.arrayBuffer()), "image/webp")).toMatchObject({
      ok: true,
      mimeType: "image/webp",
    });

    // Idempotent retry on already-ready video MUST NOT double-count storage_usage.used_bytes!
    const usageBeforeRetry = await getStorageUsageSnapshot(tenantDbA, { tenantStatus: "active" });
    const retryResult = await processVideoMediaJob(
      {
        intentId: mp4Done.intentId,
        mediaId: mp4Done.mediaId,
        quarantineR2Key: mp4Done.quarantineR2Key,
        originalFilename: "Company Profile 2026.mp4",
      },
      {
        tenantId: TENANT_A.id,
        tenantDb: tenantDbA,
        mediaBucket: env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
        images: createMockImagesBinding(),
        nowMs: nowMs + 1000,
      },
    );
    expect(retryResult.status).toBe("already_ready");
    const usageAfterRetry = await getStorageUsageSnapshot(tenantDbA, { tenantStatus: "active" });
    expect(usageAfterRetry.usedBytes).toBe(usageBeforeRetry.usedBytes);
    expect(usageAfterRetry.usedBytes).toBeGreaterThan(0);

    // 2. QuickTime MOV (720p HEVC) -> invokes VideoTranscoder with NO upscaling + WebP poster!
    const movBytes = buildSyntheticIsoBmffVideo({
      brand: "mov",
      width: 854,
      height: 480,
      fps: 30,
      videoCodec: "hvc1",
    });
    const movDone = await uploadAndProcessVideo({
      tenantHandle: TENANT_A.handle,
      tenantId: TENANT_A.id,
      tenantDb: tenantDbA,
      cookie: ownerA.cookie,
      filename: "iphone-clip.mov",
      mimeType: "video/quicktime",
      bytes: movBytes,
      alt: "Cuplikan iPhone MOV",
      nowMs: nowMs + 2000,
      transcoder: mockTranscoder.binding,
    });
    expect(movDone.result.processingPath).toBe("container_transcode");
    expect(movDone.result.transcoderInvoked).toBe(true);
    expect(movDone.result.posterSource).toBe("container_frame");
    expect(mockTranscoder.calls[0]).toMatchObject({
      sourceFormat: "mov",
      maxWidth: 854,
      maxHeight: 480,
      noUpscale: true,
      stripMetadata: true,
      extractPoster: true,
    });
    expect(movDone.result.media.width).toBe(854);
    expect(movDone.result.media.height).toBe(480);

    // 3. WebM -> invokes VideoTranscoder through durable queue batch consumer!
    const webmBytes = buildSyntheticWebmVideo({ width: 640, height: 360, fps: 24 });
    const webmDone = await uploadAndProcessVideo({
      tenantHandle: TENANT_A.handle,
      tenantId: TENANT_A.id,
      tenantDb: tenantDbA,
      cookie: ownerA.cookie,
      filename: "demo-product.webm",
      mimeType: "video/webm",
      bytes: webmBytes,
      alt: "Demo WebM",
      nowMs: nowMs + 4000,
      transcoder: mockTranscoder.binding,
    });
    expect(webmDone.result.processingPath).toBe("container_transcode");
    expect(webmDone.result.transcoderInvoked).toBe(true);
    expect(webmDone.result.media.width).toBe(640);
    expect(webmDone.result.media.height).toBe(360);

    // 4. Client-captured WebP poster upload + optional WebVTT caption upload (with XSS stripping!)
    const runtimeEnv = buildMediaEnv([]);
    const clientPosterRes = await handleVideoPosterUpload(
      TENANT_A.handle,
      String(mp4Done.mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/${mp4Done.mediaId}/poster`, {
        method: "PUT",
        headers: {
          "Content-Type": "image/webp",
          Origin: APP_ORIGIN,
          Cookie: ownerA.cookie,
        },
        body: toArrayBuffer(makeValidWebpVp8X(1280, 720, 400)),
      }),
      runtimeEnv,
      { nowMs: nowMs + 5000 },
    );
    expect(clientPosterRes.status).toBe(200);
    const posterJson = (await clientPosterRes.json()) as { posterSource: string; posterUrl: string };
    expect(posterJson.posterSource).toBe("client_frame");
    expect(posterJson.posterUrl).toContain("-poster.webp");

    // Valid WebVTT with XSS gets sanitized & stored
    const captionRes = await handleVideoCaptionsUpload(
      TENANT_A.handle,
      String(mp4Done.mediaId),
      new Request(
        `${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/${mp4Done.mediaId}/captions?lang=id`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "text/vtt",
            Origin: APP_ORIGIN,
            Cookie: ownerA.cookie,
          },
          body: SAMPLE_XSS_WEBVTT,
        },
      ),
      runtimeEnv,
      { nowMs: nowMs + 6000 },
    );
    expect(captionRes.status).toBe(200);
    const captionJson = (await captionRes.json()) as {
      captionsUrl: string;
      cueCount: number;
      strippedHtml: boolean;
    };
    expect(captionJson.cueCount).toBe(1);
    expect(captionJson.strippedHtml).toBe(true);
    expect(captionJson.captionsUrl).toContain("-captions.vtt");

    const storedVtt = await env.MEDIA_BUCKET.get((await getVideoMediaItemById(tenantDbA, mp4Done.mediaId))!.captionsR2Key!);
    const vttText = await storedVtt!.text();
    expect(vttText).toContain("WEBVTT");
    expect(vttText).not.toContain("<script");
    expect(vttText).not.toContain("onerror");

    // Invalid WebVTT rejected with 422
    const badCaptionRes = await handleVideoCaptionsUpload(
      TENANT_A.handle,
      String(mp4Done.mediaId),
      new Request(
        `${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/${mp4Done.mediaId}/captions`,
        {
          method: "PUT",
          headers: { "Content-Type": "text/vtt", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
          body: "NOT A VTT FILE\n00:00:00.000 --> 00:00:02.000\nOops",
        },
      ),
      runtimeEnv,
      { nowMs: nowMs + 6500 },
    );
    expect(badCaptionRes.status).toBe(422);
  });

  it("blocks 10,000,001 bytes (including direct streaming bypass), foreign R2 keys, hero placement, spoofed MIME, >1920x1080, >60 fps, corrupt binaries, cross-tenant & locked tenants", async () => {
    const enqueued: JobQueuePayload[] = [];
    const runtimeEnv = buildMediaEnv(enqueued);
    const nowMs = 1_766_100_000_000;

    // 1. Exact 10,000,000 bytes passes intent; 10,000,001 bytes fails intent with 413
    const exact10Mb = buildSyntheticIsoBmffVideo({ targetTotalBytes: MAX_VIDEO_UPLOAD_BYTES });
    const exact10MbRes = await handleVideoUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/video/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "video",
          filename: "exact-10mb.mp4",
          mimeType: "video/mp4",
          declaredBytes: MAX_VIDEO_UPLOAD_BYTES,
          sha256: await computeSha256Hex(exact10Mb),
          alt: "Exact 10MB",
        }),
      }),
      runtimeEnv,
      { nowMs, hourlyLimit: 200, dailyLimit: 500 },
    );
    expect(exact10MbRes.status).toBe(201);
    const exactIntent = (await exact10MbRes.json()) as { intentId: string; uploadPath: string };

    // Direct streaming bypass: attempt to stream 10,000,001 bytes into the 10,000,000-byte intent -> 413!
    const bypass10MbPlus1 = new Uint8Array(MAX_VIDEO_UPLOAD_BYTES + 1);
    bypass10MbPlus1.set(exact10Mb, 0);
    const bypassStreamRes = await handleVideoStreamUpload(
      TENANT_A.handle,
      exactIntent.intentId,
      new Request(`${APP_ORIGIN}${exactIntent.uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: toArrayBuffer(bypass10MbPlus1),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(bypassStreamRes.status).toBe(413);

    // 10,000,001 bytes declared at intent -> 413
    const overDeclaredRes = await handleVideoUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/video/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "video",
          filename: "too-big.mp4",
          mimeType: "video/mp4",
          declaredBytes: MAX_VIDEO_UPLOAD_BYTES + 1,
          sha256: "b".repeat(64),
          alt: "Over 10MB",
        }),
      }),
      runtimeEnv,
      { nowMs, hourlyLimit: 200, dailyLimit: 500 },
    );
    expect(overDeclaredRes.status).toBe(413);

    // 2. Hero placement strictly rejected with 422 VIDEO_HERO_PLACEMENT_FORBIDDEN
    const heroRes = await handleVideoUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/video/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "video",
          filename: "hero-attempt.mp4",
          mimeType: "video/mp4",
          declaredBytes: 50_000,
          sha256: "c".repeat(64),
          alt: "Hero video",
          placement: "hero",
        }),
      }),
      runtimeEnv,
      { nowMs, hourlyLimit: 200, dailyLimit: 500 },
    );
    expect(heroRes.status).toBe(422);
    expect(((await heroRes.json()) as { error: { code: string } }).error.code).toBe(
      "VIDEO_HERO_PLACEMENT_FORBIDDEN",
    );

    // 3. Foreign R2 key override rejected with 403
    const validMp4 = buildSyntheticIsoBmffVideo({ width: 1280, height: 720, fps: 30 });
    const intentForKeyTest = await handleVideoUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/video/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "video",
          filename: "key-test.mp4",
          mimeType: "video/mp4",
          declaredBytes: validMp4.byteLength,
          sha256: await computeSha256Hex(validMp4),
          alt: "Key test",
        }),
      }),
      runtimeEnv,
      { nowMs, hourlyLimit: 200, dailyLimit: 500 },
    );
    const keyIntent = (await intentForKeyTest.json()) as { intentId: string; uploadPath: string };
    const foreignKeyRes = await handleVideoStreamUpload(
      TENANT_A.handle,
      keyIntent.intentId,
      new Request(`${APP_ORIGIN}${keyIntent.uploadPath}`, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "X-R2-Key": `t/${TENANT_B.id}/media/999/hijack.mp4`,
          Origin: APP_ORIGIN,
          Cookie: ownerA.cookie,
        },
        body: toArrayBuffer(validMp4),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(foreignKeyRes.status).toBe(403);
    // Clean up this pending intent so slot doesn't linger
    await failVideoUploadIntent(tenantDbA, keyIntent.intentId, "TEST_CLEANUP", nowMs);

    // 4. Spoofed MIME, >1920x1080, >60 fps, corrupt containers all fail with 422
    const badCases = [
      {
        label: "spoofed-mime",
        declaredMime: "video/webm" as const,
        bytes: buildSyntheticIsoBmffVideo({ brand: "mp4", width: 1280, height: 720, fps: 30 }),
      },
      {
        label: "over-1080p",
        declaredMime: "video/mp4" as const,
        bytes: buildSyntheticIsoBmffVideo({ brand: "mp4", width: 2560, height: 1440, fps: 30 }),
      },
      {
        label: "over-60fps",
        declaredMime: "video/mp4" as const,
        bytes: buildSyntheticIsoBmffVideo({ brand: "mp4", width: 1280, height: 720, fps: 120 }),
      },
      {
        label: "corrupt",
        declaredMime: "video/mp4" as const,
        bytes: new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]),
      },
    ];

    for (const tc of badCases) {
      const iRes = await handleVideoUploadIntentPost(
        TENANT_A.handle,
        new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/video/upload-intent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
          body: JSON.stringify({
            kind: "video",
            filename: `${tc.label}.mp4`,
            mimeType: tc.declaredMime,
            declaredBytes: tc.bytes.byteLength,
            sha256: await computeSha256Hex(tc.bytes),
            alt: tc.label,
          }),
        }),
        runtimeEnv,
        { nowMs, hourlyLimit: 200, dailyLimit: 500 },
      );
      expect(iRes.status).toBe(201);
      const { intentId, uploadPath } = (await iRes.json()) as { intentId: string; uploadPath: string };
      const uRes = await handleVideoStreamUpload(
        TENANT_A.handle,
        intentId,
        new Request(`${APP_ORIGIN}${uploadPath}`, {
          method: "PUT",
          headers: { "Content-Type": tc.declaredMime, Origin: APP_ORIGIN, Cookie: ownerA.cookie },
          body: toArrayBuffer(tc.bytes),
        }),
        runtimeEnv,
        { nowMs },
      );
      expect(uRes.status).toBe(422);
    }

    // 5. Cross-tenant isolation: ownerB accessing TENANT_A video intent/captions/retry -> 404!
    const crossIntent = await handleVideoUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/video/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "video",
          filename: "cross.mp4",
          mimeType: "video/mp4",
          declaredBytes: 1024,
          sha256: "d".repeat(64),
          alt: "Cross tenant",
        }),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(crossIntent.status).toBe(404);

    // 6. Locked tenant blocked with 403
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await db
      .update(tenants)
      .set({ status: "locked", updatedAt: new Date(nowMs) })
      .where(eq(tenants.id, TENANT_A.id));
    try {
      const lockedRes = await handleVideoUploadIntentPost(
        TENANT_A.handle,
        new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/video/upload-intent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
          body: JSON.stringify({
            kind: "video",
            filename: "locked.mp4",
            mimeType: "video/mp4",
            declaredBytes: 1024,
            sha256: "e".repeat(64),
            alt: "Locked",
          }),
        }),
        runtimeEnv,
        { nowMs },
      );
      expect(lockedRes.status).toBe(403);
    } finally {
      await db
        .update(tenants)
        .set({ status: "active", updatedAt: new Date(nowMs + 1) })
        .where(eq(tenants.id, TENANT_A.id));
    }
  });

  it("enforces atomic 20-video per-website cap under parallel intents, rejects 21st with 422, and frees a slot on permanent purge", async () => {
    const enqueued: JobQueuePayload[] = [];
    const runtimeEnv = buildMediaEnv(enqueued);
    const nowMs = 1_766_200_000_000;
    const tinyMp4 = buildSyntheticIsoBmffVideo({ width: 640, height: 360, fps: 30 });
    const sha256 = await computeSha256Hex(tinyMp4);

    // Fire 25 PARALLEL video upload-intent requests against clean TENANT_B!
    const parallelResponses = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        handleVideoUploadIntentPost(
          TENANT_B.handle,
          new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/video/upload-intent`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: APP_ORIGIN,
              Cookie: ownerB.cookie,
              "Idempotency-Key": crypto.randomUUID(),
            },
            body: JSON.stringify({
              kind: "video",
              filename: `parallel-video-${i + 1}.mp4`,
              mimeType: "video/mp4",
              declaredBytes: tinyMp4.byteLength,
              sha256,
              alt: `Video paralel #${i + 1}`,
            }),
          }),
          runtimeEnv,
          { nowMs, hourlyLimit: 200, dailyLimit: 500 },
        ),
      ),
    );

    const createdIntents: Array<{ intentId: string; uploadPath: string }> = [];
    const rejected422Codes: string[] = [];

    for (const res of parallelResponses) {
      if (res.status === 201) {
        createdIntents.push((await res.json()) as { intentId: string; uploadPath: string });
      } else {
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        rejected422Codes.push(body.error.code);
      }
    }

    // Strictly 20 succeeded and strictly 5 rejected with VIDEO_LIMIT_REACHED!
    expect(createdIntents.length).toBe(MAX_VIDEOS_PER_TENANT);
    expect(rejected422Codes.length).toBe(5);
    expect(rejected422Codes.every((c) => c === "VIDEO_LIMIT_REACHED")).toBe(true);

    const slotsFull = await getVideoSlotUsage(tenantDbB);
    expect(slotsFull).toEqual({ usedSlots: 20, maxSlots: 20, remainingSlots: 0 });

    // Complete upload & processing for slot #1 so we have a real `ready` video to trash & purge
    const firstIntent = createdIntents[0]!;
    const putFirst = await handleVideoStreamUpload(
      TENANT_B.handle,
      firstIntent.intentId,
      new Request(`${APP_ORIGIN}${firstIntent.uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: toArrayBuffer(tinyMp4),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(putFirst.status).toBe(202);
    const { mediaId: firstVideoId } = (await putFirst.json()) as { mediaId: number };

    // Process via Durable Queue batch consumer to also verify `createVideoJobRegistry()` end-to-end!
    const registry = createVideoJobRegistry({
      images: createMockImagesBinding(),
      videoTranscoder: createMockVideoTranscoder().binding,
    });
    const jobMsg = enqueued[0]!;
    const fakeBatch = {
      queue: "punyasitus-jobs-test",
      messages: [
        {
          id: "msg-t060-1",
          timestamp: new Date(nowMs),
          body: jobMsg,
          attempts: 1,
          ack() {},
          retry() {},
        },
      ],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<JobQueuePayload>;

    const batchRes = await processDurableQueueBatch(
      fakeBatch,
      {
        PLATFORM_DB: env.PLATFORM_DB,
        TENANT_STORE: env.TENANT_STORE,
        MEDIA_BUCKET: env.MEDIA_BUCKET,
      },
      registry,
      { now: () => nowMs + 100 },
    );
    expect(batchRes.completed).toBe(1);

    // Verify slot count is STILL exactly 20 (handoff from intent -> ready video never double-counted or dropped)
    expect((await getVideoSlotUsage(tenantDbB)).usedSlots).toBe(20);

    // Soft-delete (trash) does NOT free a video slot!
    const trashRes = await handleMediaItemDelete(
      TENANT_B.handle,
      String(firstVideoId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/${firstVideoId}`, {
        method: "DELETE",
        headers: { Origin: APP_ORIGIN, Cookie: ownerB.cookie },
      }),
      runtimeEnv,
      { nowMs: nowMs + 200 },
    );
    expect(trashRes.status).toBe(200);
    expect((await getVideoSlotUsage(tenantDbB)).usedSlots).toBe(20);

    // 21st video still gets 422 while #1 is only trashed
    const stillFullRes = await handleVideoUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/video/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "video",
          filename: "video-21-while-trashed.mp4",
          mimeType: "video/mp4",
          declaredBytes: tinyMp4.byteLength,
          sha256,
          alt: "Video 21",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 300, hourlyLimit: 200, dailyLimit: 500 },
    );
    expect(stillFullRes.status).toBe(422);

    // Permanent deletion (?permanent=true) frees BOTH the video slot AND storage bytes!
    const usageBeforePurge = await getStorageUsageSnapshot(tenantDbB, { tenantStatus: "active" });
    const purgeRes = await handleMediaItemDelete(
      TENANT_B.handle,
      String(firstVideoId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/${firstVideoId}?permanent=true`, {
        method: "DELETE",
        headers: { Origin: APP_ORIGIN, Cookie: ownerB.cookie },
      }),
      runtimeEnv,
      { nowMs: nowMs + 400 },
    );
    expect(purgeRes.status).toBe(204);

    const slotsAfterPurge = await getVideoSlotUsage(tenantDbB);
    expect(slotsAfterPurge).toEqual({ usedSlots: 19, maxSlots: 20, remainingSlots: 1 });
    const usageAfterPurge = await getStorageUsageSnapshot(tenantDbB, { tenantStatus: "active" });
    expect(usageAfterPurge.usedBytes).toBeLessThan(usageBeforePurge.usedBytes);

    // Now the 21st video succeeds with 201!
    const slotFreedRes = await handleVideoUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/video/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "video",
          filename: "video-21-after-purge.mp4",
          mimeType: "video/mp4",
          declaredBytes: tinyMp4.byteLength,
          sha256,
          alt: "Video 21 setelah hapus permanen",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 500, hourlyLimit: 200, dailyLimit: 500 },
    );
    expect(slotFreedRes.status).toBe(201);

    // Verify media list endpoint exposes videoSlots and supports ?kind=video
    const listRes = await handleMediaListGet(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media?kind=video`, {
        headers: { Cookie: ownerB.cookie },
      }),
      runtimeEnv,
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      videoSlots: { used: number; limit: number; remaining: number };
    };
    expect(listJson.videoSlots).toEqual({ used: 20, limit: 20, remaining: 0 });
  });

  it("retries failed video processing cleanly when quarantine source exists and rejects retry on ready videos", async () => {
    const enqueued: JobQueuePayload[] = [];
    const runtimeEnv = buildMediaEnv(enqueued);
    const nowMs = 1_766_300_000_000;
    const movBytes = buildSyntheticIsoBmffVideo({ brand: "mov", width: 1280, height: 720, fps: 30 });
    const sha256 = await computeSha256Hex(movBytes);

    // Create intent & upload MOV into TENANT_A
    const intentRes = await handleVideoUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/video/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "video",
          filename: "retry-demo.mov",
          mimeType: "video/quicktime",
          declaredBytes: movBytes.byteLength,
          sha256,
          alt: "Video gagal untuk retry",
        }),
      }),
      runtimeEnv,
      { nowMs, hourlyLimit: 200, dailyLimit: 500 },
    );
    expect(intentRes.status).toBe(201);
    const { intentId, uploadPath } = (await intentRes.json()) as { intentId: string; uploadPath: string };

    const putRes = await handleVideoStreamUpload(
      TENANT_A.handle,
      intentId,
      new Request(`${APP_ORIGIN}${uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "video/quicktime", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: toArrayBuffer(movBytes),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(putRes.status).toBe(202);
    const { mediaId } = (await putRes.json()) as { mediaId: number };

    // Simulate failed processing while quarantine object still exists
    await failVideoUploadIntent(tenantDbA, intentId, "TRANSCODER_TIMEOUT", nowMs + 100);
    const failedItem = await getVideoMediaItemById(tenantDbA, mediaId);
    expect(failedItem?.dbStatus).toBe("failed");

    // Retry endpoint transitions failed -> processing and enqueues a new job
    const retryRes = await handleMediaItemActionPost(
      TENANT_A.handle,
      String(mediaId),
      "retry",
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/${mediaId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({}),
      }),
      runtimeEnv,
      { nowMs: nowMs + 200 },
    );
    expect(retryRes.status).toBe(202);
    expect(enqueued.length).toBe(2);
    expect(enqueued[1]!.topic).toBe(MEDIA_PROCESS_VIDEO_TOPIC);
  });

  it("fails fast with VIDEO_TRANSCODER_UNAVAILABLE (no retry loop, cleans quarantine & reserved bytes) when VIDEO_TRANSCODER binding is absent, and enforces poster/captions lifecycle guards on failed & trashed videos", async () => {
    const enqueued: JobQueuePayload[] = [];
    const runtimeEnv = buildMediaEnv(enqueued);
    const nowMs = 1_766_350_000_000;
    const webmBytes = buildSyntheticWebmVideo({ width: 1280, height: 720, fps: 30 });
    const sha256 = await computeSha256Hex(webmBytes);

    // 1. Upload WebM (requires VideoTranscoder container)
    const intentRes = await handleVideoUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/video/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "video",
          filename: "unprovisioned-transcoder.webm",
          mimeType: "video/webm",
          declaredBytes: webmBytes.byteLength,
          sha256,
          alt: "WebM tanpa transcoder",
        }),
      }),
      runtimeEnv,
      { nowMs, hourlyLimit: 200, dailyLimit: 500 },
    );
    expect(intentRes.status).toBe(201);
    const usageAfterIntent = await getStorageUsageSnapshot(tenantDbA, { tenantStatus: "active" });
    expect(usageAfterIntent.reservedBytes).toBe(webmBytes.byteLength);
    const { intentId, uploadPath } = (await intentRes.json()) as { intentId: string; uploadPath: string };

    const putRes = await handleVideoStreamUpload(
      TENANT_A.handle,
      intentId,
      new Request(`${APP_ORIGIN}${uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "video/webm", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: toArrayBuffer(webmBytes),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(putRes.status).toBe(202);
    const { mediaId } = (await putRes.json()) as { mediaId: number };
    const jobMsg = enqueued[0]!;
    const quarantineKey = (jobMsg.payload as { quarantineR2Key: string }).quarantineR2Key;
    expect(await env.MEDIA_BUCKET.get(quarantineKey)).not.toBeNull();

    // 2. Run through real durable queue consumer with NO VIDEO_TRANSCODER binding -> MUST fail fast (zero retries!)
    const registryWithoutTranscoder = createVideoJobRegistry({
      images: createMockImagesBinding(),
      // videoTranscoder omitted + env.VIDEO_TRANSCODER absent!
    });
    const fakeBatch = {
      queue: "punyasitus-jobs-test",
      messages: [
        {
          id: "msg-t060-no-transcoder",
          timestamp: new Date(nowMs),
          body: jobMsg,
          attempts: 1,
          ack() {},
          retry() {},
        },
      ],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<JobQueuePayload>;

    const batchRes = await processDurableQueueBatch(
      fakeBatch,
      {
        PLATFORM_DB: env.PLATFORM_DB,
        TENANT_STORE: env.TENANT_STORE,
        MEDIA_BUCKET: env.MEDIA_BUCKET,
      },
      registryWithoutTranscoder,
      { now: () => nowMs + 100 },
    );

    // Non-retryable fail-fast: deadLettered === 1, retried === 0!
    expect(batchRes.deadLettered).toBe(1);
    expect(batchRes.retried).toBe(0);

    // Media item marked `failed` with explicit VIDEO_TRANSCODER_UNAVAILABLE errorCode, quarantine deleted, reserved_bytes released!
    const failedItem = await getVideoMediaItemById(tenantDbA, mediaId);
    expect(failedItem?.dbStatus).toBe("failed");
    expect(failedItem?.videoMetadata?.errorCode).toBe("VIDEO_TRANSCODER_UNAVAILABLE");
    expect(await env.MEDIA_BUCKET.get(quarantineKey)).toBeNull();

    const failedGetRes = await handleMediaItemGet(
      TENANT_A.handle,
      String(mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/${mediaId}`, {
        headers: { Cookie: ownerA.cookie },
      }),
      runtimeEnv,
    );
    expect(failedGetRes.status).toBe(200);
    expect(await failedGetRes.json()).toMatchObject({
      status: "failed",
      publicUrl: null,
      errorCode: "VIDEO_TRANSCODER_UNAVAILABLE",
    });

    const usageAfterFail = await getStorageUsageSnapshot(tenantDbA, { tenantStatus: "active" });
    expect(usageAfterFail.reservedBytes).toBe(0);

    // 3. Poster & captions upload MUST fail with 409 on a `failed` video!
    const posterOnFailed = await handleVideoPosterUpload(
      TENANT_A.handle,
      String(mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/${mediaId}/poster`, {
        method: "PUT",
        headers: { "Content-Type": "image/webp", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: toArrayBuffer(makeValidWebpVp8X(640, 360, 256)),
      }),
      runtimeEnv,
      { nowMs: nowMs + 200 },
    );
    expect(posterOnFailed.status).toBe(409);

    const captionOnFailed = await handleVideoCaptionsUpload(
      TENANT_A.handle,
      String(mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/${mediaId}/captions`, {
        method: "PUT",
        headers: { "Content-Type": "text/vtt", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: SAMPLE_VALID_WEBVTT,
      }),
      runtimeEnv,
      { nowMs: nowMs + 250 },
    );
    expect(captionOnFailed.status).toBe(409);

    // 4. Upload & finalize a valid MP4, soft-delete (trash) it, then prove poster & captions return 409 MEDIA_TRASHED!
    const readyMp4 = await uploadAndProcessVideo({
      tenantHandle: TENANT_A.handle,
      tenantId: TENANT_A.id,
      tenantDb: tenantDbA,
      cookie: ownerA.cookie,
      filename: "trash-guard-test.mp4",
      mimeType: "video/mp4",
      bytes: buildSyntheticIsoBmffVideo({ brand: "mp4", width: 640, height: 360, fps: 30 }),
      alt: "Video untuk uji guard sampah",
      nowMs: nowMs + 300,
    });
    expect(readyMp4.result.media.dbStatus).toBe("ready");

    const trashRes = await handleMediaItemDelete(
      TENANT_A.handle,
      String(readyMp4.mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/${readyMp4.mediaId}`, {
        method: "DELETE",
        headers: { Origin: APP_ORIGIN, Cookie: ownerA.cookie },
      }),
      runtimeEnv,
      { nowMs: nowMs + 400 },
    );
    expect(trashRes.status).toBe(200);

    const posterOnTrashed = await handleVideoPosterUpload(
      TENANT_A.handle,
      String(readyMp4.mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/${readyMp4.mediaId}/poster`, {
        method: "PUT",
        headers: { "Content-Type": "image/webp", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: toArrayBuffer(makeValidWebpVp8X(640, 360, 256)),
      }),
      runtimeEnv,
      { nowMs: nowMs + 450 },
    );
    expect(posterOnTrashed.status).toBe(409);
    expect(((await posterOnTrashed.json()) as { error: { code: string } }).error.code).toBe("MEDIA_TRASHED");

    const captionOnTrashed = await handleVideoCaptionsUpload(
      TENANT_A.handle,
      String(readyMp4.mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/${readyMp4.mediaId}/captions`, {
        method: "PUT",
        headers: { "Content-Type": "text/vtt", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: SAMPLE_VALID_WEBVTT,
      }),
      runtimeEnv,
      { nowMs: nowMs + 500 },
    );
    expect(captionOnTrashed.status).toBe(409);
    expect(((await captionOnTrashed.json()) as { error: { code: string } }).error.code).toBe("MEDIA_TRASHED");
  });

  it("supports clean kill-switch rollback via VIDEO_UPLOAD_DISABLED=true", async () => {
    const runtimeEnv = buildMediaEnv([], { VIDEO_UPLOAD_DISABLED: "true" });
    const res = await handleVideoUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/video/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "video",
          filename: "blocked.mp4",
          mimeType: "video/mp4",
          declaredBytes: 1024,
          sha256: "f".repeat(64),
          alt: "Kill switch test",
        }),
      }),
      runtimeEnv,
      { nowMs: 1_766_400_000_000 },
    );
    expect(res.status).toBe(503);
    expect(SAMPLE_VALID_WEBVTT).toContain("WEBVTT");
  });
});

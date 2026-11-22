import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  computeSha256Hex,
  inspectImageBinary,
  MAX_NORMALIZED_MASTER_BYTES,
  MAX_OG_DERIVATIVE_BYTES,
  type CloudflareImagesBinding,
  type CloudflareImagesTransformOptions,
} from "@punyasitus/core/media/index";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  finalizeProcessedMediaAtomically,
  getMediaItemById,
  getMediaUploadIntent,
  markUploadIntentQuarantinedAndCreateMedia,
  purgeMediaItem,
} from "@punyasitus/db/media/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import {
  ensureMediaPipelineSchema,
  getStorageUsageSnapshot,
  MEDIA_PIPELINE_MIGRATION,
  PAID_STORAGE_QUOTA_BYTES,
  releaseExpiredReservations,
  STALE_PROCESSING_TTL_MS,
  TRIAL_STORAGE_QUOTA_BYTES,
} from "@punyasitus/db/storage-usage/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import {
  handleMediaItemDelete,
  handleMediaItemGet,
  handleMediaItemPatch,
} from "../../apps/web/src/pages/api/tenants/[tenantId]/media/[resourceId].ts";
import { handleMediaItemActionPost } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/[resourceId]/[action].ts";
import type { MediaApiRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/helpers.ts";
import { handleMediaListGet } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/index.ts";
import { handleMediaStreamUpload } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/upload/[intentId].ts";
import { handleMediaUploadIntentPost } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/upload-intent.ts";
import type { JobQueuePayload } from "../../apps/web/src/worker/env.d.ts";
import { processDurableQueueBatch } from "../../apps/web/src/worker/queues/consumer.ts";
import {
  createMediaJobRegistry,
  createMediaQueueHandler,
  MEDIA_PROCESS_IMAGE_TOPIC,
  MEDIA_QUARANTINE_SWEEP_TOPIC,
  processImageMediaJob,
  sweepAllTenantsExpiredQuarantine,
  sweepExpiredQuarantineObjects,
  type MediaWorkerR2BucketLike,
} from "../../apps/web/src/worker/queues/media/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";

const TENANT_A = {
  id: "01JT007TENANTALPHA00000001",
  orgId: "org_t007_alpha",
  handle: "alpha-media",
  name: "Alpha Media Studio",
};

const TENANT_B = {
  id: "01JT007TENANTBETA000000002",
  orgId: "org_t007_beta",
  handle: "beta-media",
  name: "Beta Media Studio",
};

// ---------------------------------------------------------------------------
// Valid binary fixtures + Deterministic Cloudflare Images mock binding
// ---------------------------------------------------------------------------

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function makeValidJpegWithExif(width: number, height: number, padBytes = 0): Uint8Array {
  const exifMarker = new TextEncoder().encode("Exif\0\0GPS_COORDS_-6.2088_106.8456");
  const app1Len = exifMarker.byteLength + 2;
  const header: number[] = [
    0xff,
    0xd8,
    0xff,
    0xe1,
    (app1Len >> 8) & 0xff,
    app1Len & 0xff,
    ...exifMarker,
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
  ];
  const out = new Uint8Array(header.length + padBytes + 2);
  out.set(header, 0);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

function makeValidPng(width: number, height: number, totalSize?: number): Uint8Array {
  const size = Math.max(33, totalSize ?? 64);
  const buf = new Uint8Array(size);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(buf.buffer);
  view.setUint32(8, 13, false);
  buf.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  buf[24] = 8;
  buf[25] = 6;
  return buf;
}

function makeValidWebpVp8X(width: number, height: number, totalSize = 512): Uint8Array {
  const size = Math.max(30, totalSize);
  const buf = new Uint8Array(size);
  const enc = new TextEncoder();
  buf.set(enc.encode("RIFF"), 0);
  const view = new DataView(buf.buffer);
  view.setUint32(4, size - 8, true);
  buf.set(enc.encode("WEBP"), 8);
  buf.set(enc.encode("VP8X"), 12);
  view.setUint32(16, 10, true);
  const wMinus1 = Math.max(0, width - 1);
  const hMinus1 = Math.max(0, height - 1);
  buf[24] = wMinus1 & 0xff;
  buf[25] = (wMinus1 >> 8) & 0xff;
  buf[26] = (wMinus1 >> 16) & 0xff;
  buf[27] = hMinus1 & 0xff;
  buf[28] = (hMinus1 >> 8) & 0xff;
  buf[29] = (hMinus1 >> 16) & 0xff;
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

function makeValidHeic(width: number, height: number): Uint8Array {
  const enc = new TextEncoder();
  const ftypPayload = new Uint8Array(16);
  ftypPayload.set(enc.encode("heic"), 0);
  ftypPayload.set(enc.encode("mif1"), 8);
  ftypPayload.set(enc.encode("heic"), 12);
  const ftyp = makeBmffBox("ftyp", ftypPayload);

  const ispePayload = new Uint8Array(12);
  const v = new DataView(ispePayload.buffer);
  v.setUint32(4, width, false);
  v.setUint32(8, height, false);
  const metaPayload = new Uint8Array(4 + 8 + 8 + 8 + 12);
  const iprp = makeBmffBox("iprp", makeBmffBox("ipco", makeBmffBox("ispe", ispePayload)));
  metaPayload.set(iprp, 4);
  const meta = makeBmffBox("meta", metaPayload);

  const out = new Uint8Array(ftyp.byteLength + meta.byteLength);
  out.set(ftyp, 0);
  out.set(meta, ftyp.byteLength);
  return out;
}

interface RecordedImageTransformCall {
  readonly transform: CloudflareImagesTransformOptions;
  readonly format: string;
  readonly quality: number | undefined;
}

/**
 * Deterministic Cloudflare Images binding test double that validates
 * `metadata: "none"`, strips all EXIF bytes, scales dimensions, and emits
 * genuine decodable WebP headers.
 */
function createMockCloudflareImagesBinding(options?: {
  readonly masterOutputBytes?: number;
  readonly ogOutputBytes?: number;
}): {
  readonly binding: CloudflareImagesBinding;
  readonly calls: RecordedImageTransformCall[];
} {
  const calls: RecordedImageTransformCall[] = [];

  const binding: CloudflareImagesBinding = {
    input(stream: ReadableStream<Uint8Array>) {
      let mergedTransform: CloudflareImagesTransformOptions = {};
      const pipeline = {
        transform(opts: CloudflareImagesTransformOptions) {
          mergedTransform = { ...mergedTransform, ...opts };
          return pipeline;
        },
        async output(outOpts: { readonly format: "image/webp" | "image/avif" | "image/jpeg" | "image/png"; readonly quality?: number }) {
          // Consume input stream cleanly
          const reader = stream.getReader();
          let inputSize = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            inputSize += value?.byteLength ?? 0;
          }

          calls.push({
            transform: mergedTransform,
            format: outOpts.format,
            quality: outOpts.quality,
          });

          const outW = mergedTransform.width ?? 1200;
          const outH = mergedTransform.height ?? Math.max(1, Math.round(outW * 0.75));
          const isOg = outW === 1200 && outH === 630;
          const isMaster = outW > 1280 || (outW === 1600 && outH === 1200) || mergedTransform.fit === "scale-down";

          let byteSize: number;
          if (isOg) {
            byteSize = options?.ogOutputBytes ?? 18_000;
          } else if (isMaster && options?.masterOutputBytes !== undefined) {
            byteSize = options.masterOutputBytes;
          } else {
            // Simulate realistic WebP compression <= 2MB
            byteSize = Math.min(Math.max(1_024, Math.floor(inputSize * 0.5)), 250_000);
          }

          // Emit a fresh WebP buffer containing ZERO source EXIF/GPS strings
          const webpBytes = makeValidWebpVp8X(outW, outH, byteSize);

          return {
            image() {
              return new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(webpBytes);
                  controller.close();
                },
              });
            },
            response() {
              return new Response(toArrayBuffer(webpBytes), {
                headers: { "Content-Type": outOpts.format },
              });
            },
            contentType() {
              return outOpts.format;
            },
          };
        },
      };
      return pipeline;
    },
  };

  return { binding, calls };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

async function signUpUser(email: string, name: string): Promise<{ userId: string; cookie: string }> {
  const res = await handleBetterAuthRequest(
    new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
        "cf-connecting-ip": "203.0.113.55",
      },
      body: JSON.stringify({ email, password: "MediaStrongPassword!123", name }),
    }),
    {
      APP_ENV: "test",
      PLATFORM_DOMAIN: "punyasitus.com",
      PLATFORM_DB: env.PLATFORM_DB,
      AUTH_SECRET: TEST_APP_SECRET,
    },
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { user?: { id: string } };
  const sessionCookie = getSetCookies(res.headers)
    .find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`))
    ?.split(";")[0];
  expect(sessionCookie).toBeTruthy();
  return { userId: data.user!.id, cookie: sessionCookie! };
}

async function seedTenantWithOwner(opts: {
  tenantId: string;
  orgId: string;
  handle: string;
  name: string;
  ownerUserId: string;
  status: "trial" | "active" | "grace" | "locked" | "suspended";
}) {
  const now = new Date();
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  await pDb
    .insert(organizations)
    .values({
      id: opts.orgId,
      name: opts.name,
      slug: opts.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenants)
    .values({
      id: opts.tenantId,
      organizationId: opts.orgId,
      handle: opts.handle,
      name: opts.name,
      status: opts.status,
      cacheVersion: 1,
      schemaVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(members)
    .values({
      id: `mem_${opts.tenantId}_${opts.ownerUserId}`,
      organizationId: opts.orgId,
      userId: opts.ownerUserId,
      role: "owner",
      createdAt: now,
    })
    .onConflictDoNothing();

  const tenantNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const stub = openTenantStoreStub(tenantNs, opts.tenantId);
  const migRes = await orchestrateTenantMigration(env.PLATFORM_DB, stub, opts.tenantId, TENANT_MIGRATIONS);
  expect(migRes.httpStatus).toBe(200);
  const tenantDb = createTenantDb(stub);
  await ensureMediaPipelineSchema(tenantDb);
  return tenantDb;
}

function buildMediaEnv(enqueued: JobQueuePayload[]): MediaApiRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    MEDIA_BUCKET: env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
    AUTH_SECRET: TEST_APP_SECRET,
    JOBS_QUEUE: {
      async send(message: JobQueuePayload) {
        enqueued.push(message);
      },
    },
  };
}

function createFakeQueueBatch(messages: readonly JobQueuePayload[]): {
  readonly batch: MessageBatch<unknown>;
  readonly acked: string[];
  readonly retried: string[];
} {
  const acked: string[] = [];
  const retried: string[] = [];
  const batch = {
    queue: "punyasitus-jobs-test",
    messages: messages.map((body, idx) => ({
      id: `msg-${idx}-${body.idempotencyKey}`,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack() {
        acked.push(body.idempotencyKey);
      },
      retry() {
        retried.push(body.idempotencyKey);
      },
    })),
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<unknown>;
  return { batch, acked, retried };
}

describe("TASK-007 workerd integration — Streaming Media Pipeline, Cloudflare Images, Atomic Quota & Reference Protection", () => {
  let ownerA: { userId: string; cookie: string };
  let ownerB: { userId: string; cookie: string };
  let tenantADb: D1Database;
  let tenantBDb: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    ownerA = await signUpUser("media.owner.a@example.test", "Owner Alpha");
    ownerB = await signUpUser("media.owner.b@example.test", "Owner Beta");

    tenantADb = await seedTenantWithOwner({
      tenantId: TENANT_A.id,
      orgId: TENANT_A.orgId,
      handle: TENANT_A.handle,
      name: TENANT_A.name,
      ownerUserId: ownerA.userId,
      status: "trial",
    });
    tenantBDb = await seedTenantWithOwner({
      tenantId: TENANT_B.id,
      orgId: TENANT_B.orgId,
      handle: TENANT_B.handle,
      name: TENANT_B.name,
      ownerUserId: ownerB.userId,
      status: "active",
    });
  });

  it("executes full streaming upload -> R2 quarantine -> Cloudflare Images WebP derivatives -> EXIF stripped -> quarantine deleted (JPG & HEIC)", async () => {
    const enqueued: JobQueuePayload[] = [];
    const runtimeEnv = buildMediaEnv(enqueued);
    const nowMs = 1_765_000_000_000;

    // Upload 1: JPEG with embedded EXIF/GPS metadata
    const jpgBytes = makeValidJpegWithExif(2400, 1800, 8_000);
    const jpgSha = await computeSha256Hex(jpgBytes);

    const intentRes = await handleMediaUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/upload-intent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: ownerA.cookie,
          "Idempotency-Key": "11111111-1111-4111-8111-111111111111",
        },
        body: JSON.stringify({
          kind: "image",
          filename: "Kopi Arabika Gayo 2026!.JPG",
          mimeType: "image/jpeg",
          declaredBytes: jpgBytes.byteLength,
          sha256: jpgSha,
          alt: "Biji kopi Arabika Gayo pilihan",
        }),
      }),
      runtimeEnv,
      { nowMs },
    );

    expect(intentRes.status).toBe(201);
    expect(intentRes.headers.get("cache-control")).toBe("no-store");
    const intentJson = (await intentRes.json()) as {
      intentId: string;
      uploadPath: string;
      reservedBytes: number;
      quotaLimitBytes: number;
    };
    // Strictly same-origin admin upload path — NEVER a presigned browser PUT URL!
    expect(intentJson.uploadPath).toBe(
      `/api/tenants/${TENANT_A.handle}/media/upload/${intentJson.intentId}`,
    );
    expect(intentJson.uploadPath).not.toContain("r2.cloudflarestorage.com");
    expect(intentJson.reservedBytes).toBe(jpgBytes.byteLength);
    expect(intentJson.quotaLimitBytes).toBe(TRIAL_STORAGE_QUOTA_BYTES);

    // Stream upload through same-origin admin endpoint
    const uploadRes = await handleMediaStreamUpload(
      TENANT_A.handle,
      intentJson.intentId,
      new Request(`${APP_ORIGIN}${intentJson.uploadPath}`, {
        method: "PUT",
        headers: {
          "Content-Type": "image/jpeg",
          Origin: APP_ORIGIN,
          Cookie: ownerA.cookie,
        },
        body: toArrayBuffer(jpgBytes),
      }),
      runtimeEnv,
      { nowMs: nowMs + 1_000 },
    );
    expect(uploadRes.status).toBe(202);
    const uploadJson = (await uploadRes.json()) as { mediaId: number; status: string };
    expect(uploadJson.status).toBe("processing");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe(MEDIA_PROCESS_IMAGE_TOPIC);

    const quarantineKey = String(enqueued[0]!.payload?.quarantineR2Key ?? "");
    expect(quarantineKey).toBe(
      `t/${TENANT_A.id}/quarantine/${intentJson.intentId}/kopi-arabika-gayo-2026`,
    );
    // Quarantine object exists before job runs, and media has NO publicUrl yet
    expect(await env.MEDIA_BUCKET.head(quarantineKey)).not.toBeNull();
    const preJobGet = await handleMediaItemGet(
      TENANT_A.handle,
      String(uploadJson.mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/${uploadJson.mediaId}`, {
        headers: { Cookie: ownerA.cookie },
      }),
      runtimeEnv,
    );
    const preJobBody = (await preJobGet.json()) as { publicUrl: string | null };
    expect(preJobBody.publicUrl).toBeNull();

    // Run bounded Cloudflare Images job through durable queue consumer
    const mockImages = createMockCloudflareImagesBinding({ masterOutputBytes: 42_000 });
    const registry = {
      [MEDIA_PROCESS_IMAGE_TOPIC]: createMediaQueueHandler({
        images: mockImages.binding,
        mediaBucket: env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
      }),
    };
    const { batch, acked } = createFakeQueueBatch(enqueued);
    const batchRes = await processDurableQueueBatch(
      batch,
      {
        PLATFORM_DB: env.PLATFORM_DB,
        TENANT_STORE: env.TENANT_STORE,
        MEDIA_BUCKET: env.MEDIA_BUCKET,
      },
      registry,
      { now: () => nowMs + 2_000, logger: () => {} },
    );
    expect(batchRes.completed).toBe(1);
    expect(acked).toHaveLength(1);

    // Every Images binding transform stripped EXIF metadata and emitted image/webp
    expect(mockImages.calls.length).toBe(5);
    for (const call of mockImages.calls) {
      expect(call.transform.metadata).toBe("none");
      expect(call.transform.anim).toBe(false);
      expect(call.format).toBe("image/webp");
    }

    // Quarantine original is DELETED (zero public original fallback!)
    expect(await env.MEDIA_BUCKET.head(quarantineKey)).toBeNull();

    // Verify all 5 slugified WebP outputs exist in R2, decode as valid WebP, and carry ZERO EXIF/GPS
    const readyMedia = await getMediaItemById(tenantADb, uploadJson.mediaId);
    expect(readyMedia?.status).toBe("ready");
    expect(readyMedia?.bytes).toBe(42_000);
    expect(readyMedia?.bytes).toBeLessThanOrEqual(MAX_NORMALIZED_MASTER_BYTES);
    expect(readyMedia?.r2Key).toBe(
      `t/${TENANT_A.id}/media/${uploadJson.mediaId}/kopi-arabika-gayo-2026-master.webp`,
    );
    expect(readyMedia?.variants?.w640.key).toBe(
      `t/${TENANT_A.id}/media/${uploadJson.mediaId}/kopi-arabika-gayo-2026-w640.webp`,
    );
    expect(readyMedia?.variants?.w1280.key).toBe(
      `t/${TENANT_A.id}/media/${uploadJson.mediaId}/kopi-arabika-gayo-2026-w1280.webp`,
    );
    expect(readyMedia?.variants?.thumb.key).toBe(
      `t/${TENANT_A.id}/media/${uploadJson.mediaId}/kopi-arabika-gayo-2026-thumb.webp`,
    );
    expect(readyMedia?.variants?.og.key).toBe(
      `t/${TENANT_A.id}/media/${uploadJson.mediaId}/kopi-arabika-gayo-2026-og.webp`,
    );
    expect(readyMedia!.variants!.og.bytes).toBeLessThanOrEqual(MAX_OG_DERIVATIVE_BYTES);

    for (const key of [
      readyMedia!.variants!.master.key,
      readyMedia!.variants!.w640.key,
      readyMedia!.variants!.w1280.key,
      readyMedia!.variants!.thumb.key,
      readyMedia!.variants!.og.key,
    ]) {
      const obj = await env.MEDIA_BUCKET.get(key);
      expect(obj).not.toBeNull();
      expect(obj?.httpMetadata?.contentType).toBe("image/webp");
      const raw = new Uint8Array(await obj!.arrayBuffer());
      expect(inspectImageBinary(raw, "image/webp").ok).toBe(true);
      expect(new TextDecoder().decode(raw)).not.toContain("GPS_COORDS");
    }

    // Storage usage replaced reserved_bytes with exact normalized master bytes
    const usageAfter = await getStorageUsageSnapshot(tenantADb);
    expect(usageAfter.usedBytes).toBe(42_000);
    expect(usageAfter.reservedBytes).toBe(0);

    // Idempotent retry: re-running processImageMediaJob on already-ready media NEVER double-counts!
    const retryRes = await processImageMediaJob(
      {
        intentId: intentJson.intentId,
        mediaId: uploadJson.mediaId,
        quarantineR2Key: quarantineKey,
        originalFilename: "Kopi Arabika Gayo 2026!.JPG",
      },
      {
        tenantId: TENANT_A.id,
        tenantDb: tenantADb,
        mediaBucket: env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
        images: mockImages.binding,
        nowMs: nowMs + 5_000,
      },
    );
    expect(retryRes.status).toBe("already_ready");
    const usageAfterRetry = await getStorageUsageSnapshot(tenantADb);
    expect(usageAfterRetry.usedBytes).toBe(42_000);

    // Upload 2: iPhone HEIC converts cleanly end-to-end
    const heicBytes = makeValidHeic(3024, 4032);
    const heicSha = await computeSha256Hex(heicBytes);
    const heicIntentRes = await handleMediaUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/upload-intent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: ownerA.cookie,
        },
        body: JSON.stringify({
          kind: "image",
          filename: "IMG_4821_Iphone.HEIC",
          mimeType: "image/heic",
          declaredBytes: heicBytes.byteLength,
          sha256: heicSha,
          alt: "Foto produk dari iPhone",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 6_000 },
    );
    expect(heicIntentRes.status).toBe(201);
    const heicIntent = (await heicIntentRes.json()) as { intentId: string; uploadPath: string };
    const heicUpRes = await handleMediaStreamUpload(
      TENANT_A.handle,
      heicIntent.intentId,
      new Request(`${APP_ORIGIN}${heicIntent.uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "image/heic", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: toArrayBuffer(heicBytes),
      }),
      runtimeEnv,
      { nowMs: nowMs + 7_000 },
    );
    expect(heicUpRes.status).toBe(202);
    const heicUp = (await heicUpRes.json()) as { mediaId: number };
    const heicJob = enqueued[enqueued.length - 1]!;
    const heicProcessed = await processImageMediaJob(
      heicJob.payload as {
        intentId: string;
        mediaId: number;
        quarantineR2Key: string;
        originalFilename: string;
      },
      {
        tenantId: TENANT_A.id,
        tenantDb: tenantADb,
        mediaBucket: env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
        images: createMockCloudflareImagesBinding({ masterOutputBytes: 18_000 }).binding,
        nowMs: nowMs + 8_000,
      },
    );
    expect(heicProcessed.status).toBe("completed");
    expect(heicProcessed.media.mimeType).toBe("image/webp");
    expect(heicProcessed.media.id).toBe(heicUp.mediaId);

    // Cross-tenant isolation: Owner B receives 404 on Tenant A media endpoints
    const crossList = await handleMediaListGet(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media`, {
        headers: { Cookie: ownerB.cookie },
      }),
      runtimeEnv,
    );
    expect(crossList.status).toBe(404);
  });

  it("blocks direct upload/finalize bypasses: 5,000,001 bytes, foreign keys, expired intents, video, SVG/BMP/AVIF/spoofed MIME", async () => {
    const enqueued: JobQueuePayload[] = [];
    const runtimeEnv = buildMediaEnv(enqueued);
    const nowMs = 1_765_100_000_000;

    // 1. Video upload rejected cleanly (handled only by TASK-060)
    const videoIntentRes = await handleMediaUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "video",
          filename: "promo.mp4",
          mimeType: "video/mp4",
          declaredBytes: 100_000,
          sha256: "a".repeat(64),
          alt: "Video promo",
        }),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(videoIntentRes.status).toBe(422);

    // 2. 5,000,001 bytes declared fails with 413 at intent creation
    const overDeclaredRes = await handleMediaUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "too-big.png",
          mimeType: "image/png",
          declaredBytes: 5_000_001,
          sha256: "b".repeat(64),
          alt: "Too big",
        }),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(overDeclaredRes.status).toBe(413);

    // 3. Exact 5,000,000 bytes PNG passes, while 5,000,001-byte stream bypass aborts with 413!
    const exact5MbPng = makeValidPng(1000, 1000, 5_000_000);
    const exact5MbSha = await computeSha256Hex(exact5MbPng);
    const intent5MbRes = await handleMediaUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "exact-5mb.png",
          mimeType: "image/png",
          declaredBytes: 5_000_000,
          sha256: exact5MbSha,
          alt: "Exact 5MB PNG",
        }),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(intent5MbRes.status).toBe(201);
    const intent5Mb = (await intent5MbRes.json()) as { intentId: string; uploadPath: string };

    // Attempt to stream 5,000,001 bytes into the 5,000,000-byte intent -> aborts with 413!
    const over5MbStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2_500_000));
        controller.enqueue(new Uint8Array(2_500_001));
        controller.close();
      },
    });
    const overStreamRes = await handleMediaStreamUpload(
      TENANT_A.handle,
      intent5Mb.intentId,
      new Request(`${APP_ORIGIN}${intent5Mb.uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: over5MbStream,
      }),
      runtimeEnv,
      { nowMs: nowMs + 100 },
    );
    expect(overStreamRes.status).toBe(413);

    // Valid 5,000,000-byte PNG upload succeeds!
    const intentExactOkRes = await handleMediaUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "exact-5mb-ok.png",
          mimeType: "image/png",
          declaredBytes: 5_000_000,
          sha256: exact5MbSha,
          alt: "Exact 5MB PNG valid",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 200 },
    );
    expect(intentExactOkRes.status).toBe(201);
    const intentExactOk = (await intentExactOkRes.json()) as { intentId: string; uploadPath: string };
    const exactUpRes = await handleMediaStreamUpload(
      TENANT_A.handle,
      intentExactOk.intentId,
      new Request(`${APP_ORIGIN}${intentExactOk.uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: toArrayBuffer(exact5MbPng),
      }),
      runtimeEnv,
      { nowMs: nowMs + 300 },
    );
    expect(exactUpRes.status).toBe(202);

    // 4. Foreign object key header bypass -> 403 FORBIDDEN
    const foreignKeyRes = await handleMediaStreamUpload(
      TENANT_A.handle,
      intentExactOk.intentId,
      new Request(`${APP_ORIGIN}${intentExactOk.uploadPath}`, {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          Origin: APP_ORIGIN,
          Cookie: ownerA.cookie,
          "X-R2-Key": `t/${TENANT_B.id}/quarantine/hijack/img`,
        },
        body: toArrayBuffer(makeValidPng(100, 100)),
      }),
      runtimeEnv,
      { nowMs: nowMs + 400 },
    );
    expect(foreignKeyRes.status).toBe(403);

    // 5. Direct DB finalize bypass with foreign R2 key -> 403 FORBIDDEN
    const directForeign = await markUploadIntentQuarantinedAndCreateMedia(tenantADb, {
      tenantId: TENANT_A.id,
      intentId: intentExactOk.intentId,
      quarantineR2Key: `t/${TENANT_B.id}/quarantine/forged/evil`,
      detectedMime: "image/png",
      sha256: exact5MbSha,
      width: 100,
      height: 100,
      nowMs: nowMs + 500,
    });
    expect(directForeign).toMatchObject({ ok: false, status: 403 });

    // 6. Expired upload intent fails with 410 and releases reservation
    const smallPng = makeValidPng(400, 300, 2_048);
    const smallSha = await computeSha256Hex(smallPng);
    const expIntentRes = await handleMediaUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "will-expire.png",
          mimeType: "image/png",
          declaredBytes: smallPng.byteLength,
          sha256: smallSha,
          alt: "Expiring upload",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 1_000, intentTtlMs: 5_000 },
    );
    expect(expIntentRes.status).toBe(201);
    const expIntent = (await expIntentRes.json()) as { intentId: string; uploadPath: string };

    const expiredUpRes = await handleMediaStreamUpload(
      TENANT_A.handle,
      expIntent.intentId,
      new Request(`${APP_ORIGIN}${expIntent.uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: toArrayBuffer(smallPng),
      }),
      runtimeEnv,
      { nowMs: nowMs + 10_000 },
    );
    expect(expiredUpRes.status).toBe(410);

    // 7. SVG disguised as PNG rejected with 415 and frees reserved_bytes
    const svgPayload = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
    const svgSha = await computeSha256Hex(svgPayload);
    const svgIntentRes = await handleMediaUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "disguised.png",
          mimeType: "image/png",
          declaredBytes: svgPayload.byteLength,
          sha256: svgSha,
          alt: "Disguised SVG",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 11_000 },
    );
    expect(svgIntentRes.status).toBe(201);
    const svgIntent = (await svgIntentRes.json()) as { intentId: string; uploadPath: string };
    const svgUpRes = await handleMediaStreamUpload(
      TENANT_A.handle,
      svgIntent.intentId,
      new Request(`${APP_ORIGIN}${svgIntent.uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: toArrayBuffer(svgPayload),
      }),
      runtimeEnv,
      { nowMs: nowMs + 12_000 },
    );
    expect(svgUpRes.status).toBe(415);

    // 8. Worker rejects foreign quarantine key even if injected directly into job payload
    await expect(
      processImageMediaJob(
        {
          intentId: "01JFORGED00000000000000001",
          mediaId: 1,
          quarantineR2Key: `t/${TENANT_B.id}/quarantine/forged/img`,
          originalFilename: "evil.png",
        },
        {
          tenantId: TENANT_A.id,
          tenantDb: tenantADb,
          mediaBucket: env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
          images: createMockCloudflareImagesBinding().binding,
        },
      ),
    ).rejects.toThrow(/quarantine/i);
  });

  it("enforces exact 100 MB trial & 1 GB paid quota boundaries, parallel concurrency safety, expired release, trash accounting & 50/hr + 200/day rate limits", async () => {
    const enqueued: JobQueuePayload[] = [];
    const runtimeEnv = buildMediaEnv(enqueued);
    const baseMs = 1_766_000_000_000;

    // Reset Tenant B storage_usage for deterministic boundary assertions
    await tenantBDb
      .prepare(
        `INSERT INTO storage_usage
           (id, used_bytes, reserved_bytes, quota_bytes, hourly_uploads, hourly_window_start, daily_uploads, daily_window_start, updated_at)
         VALUES (1, ?, 0, ?, 0, ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           used_bytes = excluded.used_bytes,
           reserved_bytes = 0,
           quota_bytes = excluded.quota_bytes,
           hourly_uploads = 0,
           hourly_window_start = excluded.hourly_window_start,
           daily_uploads = 0,
           daily_window_start = excluded.daily_window_start,
           updated_at = excluded.updated_at`,
      )
      .bind(
        PAID_STORAGE_QUOTA_BYTES - 1_000_000, // 999,000,000 bytes used
        PAID_STORAGE_QUOTA_BYTES, // 1,000,000,000 bytes limit
        baseMs,
        baseMs,
        baseMs,
      )
      .run();

    // 1. Paid (1 GB): +1 byte over (1,000,001 bytes) FAILS with 422 STORAGE_QUOTA_EXCEEDED
    const paidOverRes = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "one-byte-over.jpg",
          mimeType: "image/jpeg",
          declaredBytes: 1_000_001,
          sha256: "c".repeat(64),
          alt: "One byte over 1GB",
        }),
      }),
      runtimeEnv,
      { nowMs: baseMs + 10 },
    );
    expect(paidOverRes.status).toBe(422);
    const paidOverBody = (await paidOverRes.json()) as { error: { code: string } };
    expect(paidOverBody.error.code).toBe("STORAGE_QUOTA_EXCEEDED");

    // 2. Paid (1 GB): exact 1,000,000 bytes PASSES (reaches exact 1,000,000,000)
    const paidExactRes = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "exact-1gb.jpg",
          mimeType: "image/jpeg",
          declaredBytes: 1_000_000,
          sha256: "d".repeat(64),
          alt: "Exact 1GB boundary",
        }),
      }),
      runtimeEnv,
      { nowMs: baseMs + 20, intentTtlMs: 5_000 },
    );
    expect(paidExactRes.status).toBe(201);

    // One more 1-byte upload now fails because used + reserved == 1,000,000,000
    const paidZeroRoomRes = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "extra-byte.jpg",
          mimeType: "image/jpeg",
          declaredBytes: 1,
          sha256: "e".repeat(64),
          alt: "Extra byte",
        }),
      }),
      runtimeEnv,
      { nowMs: baseMs + 30 },
    );
    expect(paidZeroRoomRes.status).toBe(422);

    // 3. Expired intent releases reservation automatically + quarantine sweep deletes abandoned R2 object
    const expiredReleased = await releaseExpiredReservations(tenantBDb, baseMs + 10_000);
    expect(expiredReleased.releasedBytes).toBe(1_000_000);
    const orphanQKey = `t/${TENANT_B.id}/quarantine/01JORPHAN00000000000000001/abandoned`;
    await env.MEDIA_BUCKET.put(orphanQKey, new Uint8Array([1, 2, 3]), {
      customMetadata: { quarantinedAtMs: String(baseMs - 48 * 60 * 60 * 1000) },
    });
    const sweepRes = await sweepExpiredQuarantineObjects(
      tenantBDb,
      env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
      TENANT_B.id,
      { nowMs: baseMs + 10_000 },
    );
    expect(sweepRes.deletedQuarantineKeys).toContain(orphanQKey);
    expect(await env.MEDIA_BUCKET.head(orphanQKey)).toBeNull();

    // 4. Parallel concurrent intents cannot exceed quota:
    //    2,000,000 bytes free -> 5 parallel intents of 1,000,000 bytes -> strictly 2 pass, 3 fail!
    await tenantBDb
      .prepare("UPDATE storage_usage SET used_bytes = ?, reserved_bytes = 0 WHERE id = 1")
      .bind(PAID_STORAGE_QUOTA_BYTES - 2_000_000)
      .run();

    const parallelResults = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        handleMediaUploadIntentPost(
          TENANT_B.handle,
          new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
            body: JSON.stringify({
              kind: "image",
              filename: `parallel-${n}.jpg`,
              mimeType: "image/jpeg",
              declaredBytes: 1_000_000,
              sha256: `${n}`.repeat(64),
              alt: `Parallel ${n}`,
            }),
          }),
          runtimeEnv,
          { nowMs: baseMs + 20_000, intentTtlMs: 2_000 },
        ),
      ),
    );
    const parallelStatuses = parallelResults.map((r) => r.status).sort();
    expect(parallelStatuses).toEqual([201, 201, 422, 422, 422]);
    const snapAfterParallel = await getStorageUsageSnapshot(tenantBDb);
    expect(snapAfterParallel.usedBytes + snapAfterParallel.reservedBytes).toBe(
      PAID_STORAGE_QUOTA_BYTES,
    );

    // 5. Trial quota (100 MB = 100,000,000 bytes): exact limit passes, +1 byte fails!
    await tenantADb
      .prepare(
        `UPDATE storage_usage
         SET used_bytes = ?, reserved_bytes = 0, quota_bytes = ?,
             hourly_uploads = 0, hourly_window_start = ?,
             daily_uploads = 0, daily_window_start = ?, updated_at = ?
         WHERE id = 1`,
      )
      .bind(
        TRIAL_STORAGE_QUOTA_BYTES - 500_000,
        TRIAL_STORAGE_QUOTA_BYTES,
        baseMs,
        baseMs,
        baseMs,
      )
      .run();

    const trialOver = await handleMediaUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "trial-over.jpg",
          mimeType: "image/jpeg",
          declaredBytes: 500_001,
          sha256: "f".repeat(64),
          alt: "Trial over",
        }),
      }),
      runtimeEnv,
      { nowMs: baseMs + 100 },
    );
    expect(trialOver.status).toBe(422);

    const trialExact = await handleMediaUploadIntentPost(
      TENANT_A.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerA.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "trial-exact.jpg",
          mimeType: "image/jpeg",
          declaredBytes: 500_000,
          sha256: "f".repeat(64),
          alt: "Trial exact",
        }),
      }),
      runtimeEnv,
      { nowMs: baseMs + 200 },
    );
    expect(trialExact.status).toBe(201);

    // 6. Rate limits: 50/hour -> 51st returns 429; 200/day -> 201st returns 429!
    const rlBase = baseMs + 1_000_000;
    await tenantBDb
      .prepare(
        `UPDATE storage_usage
         SET used_bytes = 0, reserved_bytes = 0,
             hourly_uploads = 49, hourly_window_start = ?,
             daily_uploads = 49, daily_window_start = ?, updated_at = ?
         WHERE id = 1`,
      )
      .bind(rlBase, rlBase, rlBase)
      .run();

    // 50th intent in hour succeeds
    const fifty = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "hour-50.jpg",
          mimeType: "image/jpeg",
          declaredBytes: 100,
          sha256: "a".repeat(64),
          alt: "50th",
        }),
      }),
      runtimeEnv,
      { nowMs: rlBase + 1_000 },
    );
    expect(fifty.status).toBe(201);

    // 51st intent in same hour returns 429 RATE_LIMITED with Retry-After
    const fiftyOne = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "hour-51.jpg",
          mimeType: "image/jpeg",
          declaredBytes: 100,
          sha256: "b".repeat(64),
          alt: "51st",
        }),
      }),
      runtimeEnv,
      { nowMs: rlBase + 2_000 },
    );
    expect(fiftyOne.status).toBe(429);
    expect(Number(fiftyOne.headers.get("retry-after"))).toBeGreaterThan(0);

    // 200th intent in day succeeds (fresh hour window), 201st returns 429!
    await tenantBDb
      .prepare(
        `UPDATE storage_usage
         SET hourly_uploads = 0, hourly_window_start = ?,
             daily_uploads = 199, daily_window_start = ?, updated_at = ?
         WHERE id = 1`,
      )
      .bind(rlBase + 4_000_000, rlBase, rlBase + 4_000_000)
      .run();

    const day200 = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "day-200.jpg",
          mimeType: "image/jpeg",
          declaredBytes: 100,
          sha256: "c".repeat(64),
          alt: "200th",
        }),
      }),
      runtimeEnv,
      { nowMs: rlBase + 4_001_000 },
    );
    expect(day200.status).toBe(201);

    const day201 = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "day-201.jpg",
          mimeType: "image/jpeg",
          declaredBytes: 100,
          sha256: "d".repeat(64),
          alt: "201st",
        }),
      }),
      runtimeEnv,
      { nowMs: rlBase + 4_002_000 },
    );
    expect(day201.status).toBe(429);
    expect(Number(day201.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("protects published references with 409 MEDIA_IN_USE, counts trashed media until purge, and blocks writes when tenant is locked", async () => {
    const enqueued: JobQueuePayload[] = [];
    const runtimeEnv = buildMediaEnv(enqueued);
    const nowMs = 1_767_000_000_000;

    // Reset Tenant B storage usage and upload a clean image
    await tenantBDb
      .prepare(
        `UPDATE storage_usage
         SET used_bytes = 0, reserved_bytes = 0,
             hourly_uploads = 0, hourly_window_start = ?,
             daily_uploads = 0, daily_window_start = ?, updated_at = ?
         WHERE id = 1`,
      )
      .bind(nowMs, nowMs, nowMs)
      .run();

    const pngBytes = makeValidPng(1200, 900, 4_000);
    const pngSha = await computeSha256Hex(pngBytes);
    const intentRes = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "Hero Banner Utama.png",
          mimeType: "image/png",
          declaredBytes: pngBytes.byteLength,
          sha256: pngSha,
          alt: "Hero banner awal",
        }),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(intentRes.status).toBe(201);
    const intent = (await intentRes.json()) as { intentId: string; uploadPath: string };

    const upRes = await handleMediaStreamUpload(
      TENANT_B.handle,
      intent.intentId,
      new Request(`${APP_ORIGIN}${intent.uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: toArrayBuffer(pngBytes),
      }),
      runtimeEnv,
      { nowMs: nowMs + 100 },
    );
    expect(upRes.status).toBe(202);
    const { mediaId } = (await upRes.json()) as { mediaId: number };

    const jobPayload = enqueued[0]!.payload as {
      intentId: string;
      mediaId: number;
      quarantineR2Key: string;
      originalFilename: string;
    };
    const processed = await processImageMediaJob(jobPayload, {
      tenantId: TENANT_B.id,
      tenantDb: tenantBDb,
      mediaBucket: env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
      images: createMockCloudflareImagesBinding({ masterOutputBytes: 55_000 }).binding,
      nowMs: nowMs + 200,
    });
    expect(processed.status).toBe("completed");
    expect((await getStorageUsageSnapshot(tenantBDb)).usedBytes).toBe(55_000);

    // Update ALT metadata with optimistic concurrency
    const patchRes = await handleMediaItemPatch(
      TENANT_B.handle,
      String(mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/${mediaId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({ alt: "Hero banner diperbarui", version: processed.media.version }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 300 },
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { alt: string; version: number };
    expect(patched.alt).toBe("Hero banner diperbarui");

    // Reference this media in a PUBLISHED offering's gallery
    await tenantBDb
      .prepare(
        `INSERT INTO offerings (
           id, offering_type, slug, title, gallery_media_ids_json,
           status, published_at, version, created_at, updated_at
         ) VALUES (1, 'product', 'produk-unggulan', 'Produk Unggulan', ?, 'published', ?, 1, ?, ?)`,
      )
      .bind(JSON.stringify([mediaId]), nowMs, nowMs, nowMs)
      .run();

    // Soft-delete AND permanent purge MUST fail with 409 MEDIA_IN_USE!
    const blockedTrash = await handleMediaItemDelete(
      TENANT_B.handle,
      String(mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/${mediaId}`, {
        method: "DELETE",
        headers: { Origin: APP_ORIGIN, Cookie: ownerB.cookie },
      }),
      runtimeEnv,
      { nowMs: nowMs + 400 },
    );
    expect(blockedTrash.status).toBe(409);
    expect(((await blockedTrash.json()) as { error: { code: string } }).error.code).toBe("MEDIA_IN_USE");

    const blockedPurge = await handleMediaItemDelete(
      TENANT_B.handle,
      String(mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/${mediaId}?permanent=true`, {
        method: "DELETE",
        headers: { Origin: APP_ORIGIN, Cookie: ownerB.cookie },
      }),
      runtimeEnv,
      { nowMs: nowMs + 500 },
    );
    expect(blockedPurge.status).toBe(409);
    expect(((await blockedPurge.json()) as { error: { code: string } }).error.code).toBe("MEDIA_IN_USE");

    // Unpublish the offering -> now trashing succeeds, AND used_bytes STILL counts 55,000!
    await tenantBDb
      .prepare("UPDATE offerings SET status = 'draft', gallery_media_ids_json = '[]' WHERE id = 1")
      .run();

    const trashRes = await handleMediaItemDelete(
      TENANT_B.handle,
      String(mediaId),
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/${mediaId}`, {
        method: "DELETE",
        headers: { Origin: APP_ORIGIN, Cookie: ownerB.cookie },
      }),
      runtimeEnv,
      { nowMs: nowMs + 600 },
    );
    expect(trashRes.status).toBe(200);
    const trashedBody = (await trashRes.json()) as { status: string; version: number };
    expect(trashedBody.status).toBe("trashed");
    // Trashed media STILL counts toward storage_usage.used_bytes until purged!
    expect((await getStorageUsageSnapshot(tenantBDb)).usedBytes).toBe(55_000);

    // Restore from trash works
    const restoreRes = await handleMediaItemActionPost(
      TENANT_B.handle,
      String(mediaId),
      "restore",
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/${mediaId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({ version: trashedBody.version }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 700 },
    );
    expect(restoreRes.status).toBe(200);
    expect(((await restoreRes.json()) as { status: string }).status).toBe("ready");

    // Lock tenant -> write mutations fail with 403 SUBSCRIPTION_LOCKED
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await pDb
      .update(tenants)
      .set({ status: "locked" })
      .where(eq(tenants.id, TENANT_B.id));

    const lockedUploadRes = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "blocked.png",
          mimeType: "image/png",
          declaredBytes: 1024,
          sha256: "a".repeat(64),
          alt: "Blocked when locked",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 800 },
    );
    expect(lockedUploadRes.status).toBe(403);
    expect(((await lockedUploadRes.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );

    // Restore active status -> permanent purge deletes R2 objects AND frees used_bytes to 0!
    await pDb
      .update(tenants)
      .set({ status: "active" })
      .where(eq(tenants.id, TENANT_B.id));

    const purgeRes = await handleMediaItemActionPost(
      TENANT_B.handle,
      String(mediaId),
      "purge",
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/${mediaId}/purge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({}),
      }),
      runtimeEnv,
      { nowMs: nowMs + 900 },
    );
    expect(purgeRes.status).toBe(204);
    expect(await getMediaItemById(tenantBDb, mediaId)).toBeNull();
    expect(await env.MEDIA_BUCKET.head(processed.media.r2Key)).toBeNull();
    expect((await getStorageUsageSnapshot(tenantBDb)).usedBytes).toBe(0);
  });

  it("enforces single-batch atomic finalize concurrency, fail-closed JOBS_QUEUE rollback, stale processing reaper, concurrent schema init, and Worker registry dispatch", async () => {
    const enqueued: JobQueuePayload[] = [];
    const runtimeEnv = buildMediaEnv(enqueued);
    const baseMs = 1_768_000_000_000;

    // 1. Official 0001 + 0002 migrations apply cleanly in sequence on a fresh TenantStore DO
    const tenantNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const tenantCId = "01JT007TENANTC000000000003";
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date();
    await pDb
      .insert(organizations)
      .values({ id: "org_t007_c", name: "Tenant C", slug: "tenant-c-mig", createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await pDb
      .insert(tenants)
      .values({
        id: tenantCId,
        organizationId: "org_t007_c",
        handle: "tenant-c-mig",
        name: "Tenant C",
        status: "active",
        cacheVersion: 1,
        schemaVersion: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const stubC = openTenantStoreStub(tenantNs, tenantCId);
    const mig0001And0002 = await orchestrateTenantMigration(
      env.PLATFORM_DB,
      stubC,
      tenantCId,
      [...TENANT_MIGRATIONS, MEDIA_PIPELINE_MIGRATION],
    );
    expect(mig0001And0002.httpStatus).toBe(200);
    expect(mig0001And0002.applied).toEqual(["0001_initial_tenant", "0002_media_upload_pipeline"]);

    // 2. Concurrent ensureMediaPipelineSchema across 6 distinct D1Database handles on a 0001-only DO succeeds cleanly
    const tenantDId = "01JT007TENANTD000000000004";
    await pDb
      .insert(organizations)
      .values({ id: "org_t007_d", name: "Tenant D", slug: "tenant-d-ddl", createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await pDb
      .insert(tenants)
      .values({
        id: tenantDId,
        organizationId: "org_t007_d",
        handle: "tenant-d-ddl",
        name: "Tenant D",
        status: "active",
        cacheVersion: 1,
        schemaVersion: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const stubD = openTenantStoreStub(tenantNs, tenantDId);
    const mig0001Only = await orchestrateTenantMigration(
      env.PLATFORM_DB,
      stubD,
      tenantDId,
      TENANT_MIGRATIONS,
    );
    expect(mig0001Only.httpStatus).toBe(200);
    await expect(
      Promise.all(
        Array.from({ length: 6 }, () => ensureMediaPipelineSchema(createTenantDb(stubD))),
      ),
    ).resolves.toBeDefined();

    // Reset Tenant B usage for concurrency & rollback assertions
    await tenantBDb
      .prepare(
        `UPDATE storage_usage
         SET used_bytes = 0, reserved_bytes = 0,
             hourly_uploads = 0, hourly_window_start = ?,
             daily_uploads = 0, daily_window_start = ?, updated_at = ?
         WHERE id = 1`,
      )
      .bind(baseMs, baseMs, baseMs)
      .run();

    // 3. Missing JOBS_QUEUE fails closed with 503 SERVICE_UNAVAILABLE
    const png1 = makeValidPng(800, 600, 3_000);
    const sha1 = await computeSha256Hex(png1);
    const intentNoQueueRes = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: ownerB.cookie,
          "Idempotency-Key": "22222222-2222-4222-8222-222222222222",
        },
        body: JSON.stringify({
          kind: "image",
          filename: "no-queue.png",
          mimeType: "image/png",
          declaredBytes: png1.byteLength,
          sha256: sha1,
          alt: "No queue check",
        }),
      }),
      runtimeEnv,
      { nowMs: baseMs },
    );
    expect(intentNoQueueRes.status).toBe(201);
    const intentNoQueue = (await intentNoQueueRes.json()) as { intentId: string; uploadPath: string };

    const missingQueueUp = await handleMediaStreamUpload(
      TENANT_B.handle,
      intentNoQueue.intentId,
      new Request(`${APP_ORIGIN}${intentNoQueue.uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: toArrayBuffer(png1),
      }),
      { ...runtimeEnv, JOBS_QUEUE: null },
      { nowMs: baseMs + 50 },
    );
    expect(missingQueueUp.status).toBe(503);

    // 4. Failing JOBS_QUEUE.send rolls back reserved_bytes, deletes quarantine R2 object, and marks intent failed;
    //    replaying the failed intent's Idempotency-Key returns 409 IDEMPOTENCY_CONFLICT!
    const failingQueueEnv: MediaApiRuntimeEnv = {
      ...runtimeEnv,
      JOBS_QUEUE: {
        async send() {
          throw new Error("SIMULATED_QUEUE_OUTAGE");
        },
      },
    };
    const failedQueueUp = await handleMediaStreamUpload(
      TENANT_B.handle,
      intentNoQueue.intentId,
      new Request(`${APP_ORIGIN}${intentNoQueue.uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: toArrayBuffer(png1),
      }),
      failingQueueEnv,
      { nowMs: baseMs + 100 },
    );
    expect(failedQueueUp.status).toBe(503);
    expect((await getStorageUsageSnapshot(tenantBDb)).reservedBytes).toBe(0);
    const failedIntentRecord = await getMediaUploadIntent(tenantBDb, intentNoQueue.intentId);
    expect(failedIntentRecord?.status).toBe("failed");
    expect(await env.MEDIA_BUCKET.head(failedIntentRecord!.quarantineR2Key)).toBeNull();

    const deadKeyReplay = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: ownerB.cookie,
          "Idempotency-Key": "22222222-2222-4222-8222-222222222222",
        },
        body: JSON.stringify({
          kind: "image",
          filename: "no-queue.png",
          mimeType: "image/png",
          declaredBytes: png1.byteLength,
          sha256: sha1,
          alt: "No queue check",
        }),
      }),
      runtimeEnv,
      { nowMs: baseMs + 150 },
    );
    expect(deadKeyReplay.status).toBe(409);

    // 5. Concurrent upload race on the SAME intentId: strictly 1 wins (202), 1 loses (409),
    //    and winner's R2 quarantine object stays intact!
    const png2 = makeValidPng(1024, 768, 5_000);
    const sha2 = await computeSha256Hex(png2);
    const raceIntentRes = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "race-test.png",
          mimeType: "image/png",
          declaredBytes: png2.byteLength,
          sha256: sha2,
          alt: "Race upload test",
        }),
      }),
      runtimeEnv,
      { nowMs: baseMs + 200 },
    );
    expect(raceIntentRes.status).toBe(201);
    const raceIntent = (await raceIntentRes.json()) as { intentId: string; uploadPath: string };

    // Also create a second unrelated active intent (reserved_bytes = 9_000) to verify finalize doesn't eat it!
    const unrelatedRes = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "other-pending.png",
          mimeType: "image/png",
          declaredBytes: 9_000,
          sha256: "a".repeat(64),
          alt: "Other pending reservation",
        }),
      }),
      runtimeEnv,
      { nowMs: baseMs + 210 },
    );
    expect(unrelatedRes.status).toBe(201);
    const unrelatedIntent = (await unrelatedRes.json()) as { intentId: string };

    const [raceA, raceB] = await Promise.all([
      handleMediaStreamUpload(
        TENANT_B.handle,
        raceIntent.intentId,
        new Request(`${APP_ORIGIN}${raceIntent.uploadPath}`, {
          method: "PUT",
          headers: { "Content-Type": "image/png", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
          body: toArrayBuffer(png2),
        }),
        runtimeEnv,
        { nowMs: baseMs + 250 },
      ),
      handleMediaStreamUpload(
        TENANT_B.handle,
        raceIntent.intentId,
        new Request(`${APP_ORIGIN}${raceIntent.uploadPath}`, {
          method: "PUT",
          headers: { "Content-Type": "image/png", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
          body: toArrayBuffer(png2),
        }),
        runtimeEnv,
        { nowMs: baseMs + 250 },
      ),
    ]);
    expect([raceA.status, raceB.status].sort()).toEqual([202, 409]);
    const winnerResp = raceA.status === 202 ? raceA : raceB;
    const { mediaId: raceMediaId } = (await winnerResp.json()) as { mediaId: number };
    const raceIntentRow = await getMediaUploadIntent(tenantBDb, raceIntent.intentId);
    expect(await env.MEDIA_BUCKET.head(raceIntentRow!.quarantineR2Key)).not.toBeNull();

    // 6. Concurrent single-batch finalizeProcessedMediaAtomically (5 parallel calls):
    //    NEVER double-counts used_bytes AND preserves unrelated intent's 9,000 reserved_bytes!
    const masterKey = `t/${TENANT_B.id}/media/${raceMediaId}/race-test-master.webp`;
    const makeEntry = (suffix: string, w: number, h: number, b: number) => ({
      key: `t/${TENANT_B.id}/media/${raceMediaId}/race-test-${suffix}.webp`,
      width: w,
      height: h,
      bytes: b,
      mimeType: "image/webp" as const,
    });
    const finalizeResults = await Promise.all(
      Array.from({ length: 5 }, () =>
        finalizeProcessedMediaAtomically(tenantBDb, {
          tenantId: TENANT_B.id,
          mediaId: raceMediaId,
          intentId: raceIntent.intentId,
          masterR2Key: masterKey,
          normalizedMasterBytes: 12_345,
          masterSha256: "b".repeat(64),
          masterWidth: 1024,
          masterHeight: 768,
          variants: {
            slug: "race-test",
            master: makeEntry("master", 1024, 768, 12_345),
            w640: makeEntry("w640", 640, 480, 4_000),
            w1280: makeEntry("w1280", 1024, 768, 8_000),
            thumb: makeEntry("thumb", 400, 400, 3_000),
            og: makeEntry("og", 1200, 630, 9_000),
          },
          nowMs: baseMs + 300,
        }),
      ),
    );
    expect(finalizeResults.every((r) => r.ok)).toBe(true);
    const freshlyFinalizedCount = finalizeResults.filter((r) => r.ok && !r.alreadyReady).length;
    expect(freshlyFinalizedCount).toBe(1);

    const usageAfterConcurrentFinalize = await getStorageUsageSnapshot(tenantBDb);
    expect(usageAfterConcurrentFinalize.usedBytes).toBe(12_345);
    // Unrelated intent's 9,000-byte reservation is untouched!
    expect(usageAfterConcurrentFinalize.reservedBytes).toBe(9_000);

    // Clean up unrelated intent via expiry
    expect((await getMediaUploadIntent(tenantBDb, unrelatedIntent.intentId))?.reservedBytes).toBe(9_000);

    // 7. Purging a `processing` media item releases its linked intent's reserved_bytes cleanly
    const png3 = makeValidPng(600, 400, 4_500);
    const sha3 = await computeSha256Hex(png3);
    const procIntentRes = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "purge-while-processing.png",
          mimeType: "image/png",
          declaredBytes: png3.byteLength,
          sha256: sha3,
          alt: "Purge while processing",
        }),
      }),
      runtimeEnv,
      { nowMs: baseMs + 400 },
    );
    expect(procIntentRes.status).toBe(201);
    const procIntent = (await procIntentRes.json()) as { intentId: string; uploadPath: string };
    const procUpRes = await handleMediaStreamUpload(
      TENANT_B.handle,
      procIntent.intentId,
      new Request(`${APP_ORIGIN}${procIntent.uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: toArrayBuffer(png3),
      }),
      runtimeEnv,
      { nowMs: baseMs + 450 },
    );
    expect(procUpRes.status).toBe(202);
    const { mediaId: procMediaId } = (await procUpRes.json()) as { mediaId: number };
    expect((await getStorageUsageSnapshot(tenantBDb)).reservedBytes).toBe(9_000 + 4_500);

    const purgeProcRes = await purgeMediaItem(tenantBDb, {
      tenantId: TENANT_B.id,
      mediaId: procMediaId,
      mediaBucket: env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
      nowMs: baseMs + 500,
    });
    expect(purgeProcRes.ok).toBe(true);
    expect((await getStorageUsageSnapshot(tenantBDb)).reservedBytes).toBe(9_000);

    // 8. Stale `processing` intent reaper + Worker createMediaJobRegistry() + sweepAllTenantsExpiredQuarantine
    const png4 = makeValidPng(640, 480, 6_000);
    const sha4 = await computeSha256Hex(png4);
    const staleIntentRes = await handleMediaUploadIntentPost(
      TENANT_B.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/media/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: JSON.stringify({
          kind: "image",
          filename: "stuck-processing.png",
          mimeType: "image/png",
          declaredBytes: png4.byteLength,
          sha256: sha4,
          alt: "Stuck processing job",
        }),
      }),
      runtimeEnv,
      { nowMs: baseMs + 600 },
    );
    expect(staleIntentRes.status).toBe(201);
    const staleIntent = (await staleIntentRes.json()) as { intentId: string; uploadPath: string };
    const staleUpRes = await handleMediaStreamUpload(
      TENANT_B.handle,
      staleIntent.intentId,
      new Request(`${APP_ORIGIN}${staleIntent.uploadPath}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png", Origin: APP_ORIGIN, Cookie: ownerB.cookie },
        body: toArrayBuffer(png4),
      }),
      runtimeEnv,
      { nowMs: baseMs + 650 },
    );
    expect(staleUpRes.status).toBe(202);
    const { mediaId: staleMediaId } = (await staleUpRes.json()) as { mediaId: number };

    // Fast-forward past STALE_PROCESSING_TTL_MS (15m) and run Worker's sweepAllTenantsExpiredQuarantine
    const afterStaleMs = baseMs + 650 + STALE_PROCESSING_TTL_MS + 1_000;
    const sweepAllSummary = await sweepAllTenantsExpiredQuarantine(
      {
        PLATFORM_DB: env.PLATFORM_DB,
        TENANT_STORE: env.TENANT_STORE,
        MEDIA_BUCKET: env.MEDIA_BUCKET,
      },
      { nowMs: afterStaleMs },
    );
    expect(sweepAllSummary.tenantsSwept).toBeGreaterThanOrEqual(2);
    expect((await getMediaUploadIntent(tenantBDb, staleIntent.intentId))?.status).toBe("failed");
    expect((await getMediaItemById(tenantBDb, staleMediaId))?.status).toBe("failed");
    expect((await getStorageUsageSnapshot(tenantBDb)).reservedBytes).toBe(0);

    // 9. Verify createMediaJobRegistry() dispatches BOTH media.process_image & media.quarantine_sweep via durable queue
    const workerMediaRegistry = createMediaJobRegistry({
      images: createMockCloudflareImagesBinding({ masterOutputBytes: 15_000 }).binding,
      mediaBucket: env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
    });
    expect(workerMediaRegistry[MEDIA_PROCESS_IMAGE_TOPIC]).toBeDefined();
    expect(workerMediaRegistry[MEDIA_QUARANTINE_SWEEP_TOPIC]).toBeDefined();

    const { batch: sweepBatch, acked: sweepAcked } = createFakeQueueBatch([
      {
        idempotencyKey: "media-sweep-worker-test-1",
        topic: MEDIA_QUARANTINE_SWEEP_TOPIC,
        tenantId: null,
        payload: { nowMs: afterStaleMs + 5_000 },
      },
    ]);
    const sweepQueueRes = await processDurableQueueBatch(
      sweepBatch,
      {
        PLATFORM_DB: env.PLATFORM_DB,
        TENANT_STORE: env.TENANT_STORE,
        MEDIA_BUCKET: env.MEDIA_BUCKET,
      },
      workerMediaRegistry,
      { now: () => afterStaleMs + 5_000, logger: () => {} },
    );
    expect(sweepQueueRes.completed).toBe(1);
    expect(sweepAcked).toEqual(["media-sweep-worker-test-1"]);
  });
});

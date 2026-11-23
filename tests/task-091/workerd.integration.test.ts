import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import type { JobEnvelopeInput } from "@punyasitus/core/jobs/index";
import type { CloudflareImagesBinding } from "@punyasitus/core/media/index";
import {
  applyAutoDerivedBrandAssets,
  getPublishedStructuredBusinessProfile,
  getStructuredBusinessProfileForAdmin,
  PublicationAtomicError,
  publishStructuredBusinessProfile,
  saveStructuredBusinessProfileDraft,
} from "@punyasitus/db/business-profile/index";
import { BUSINESS_PROFILE_STRUCTURED_MIGRATION } from "@punyasitus/db/business-profile/migrations";
import {
  applyPlatformMigrations,
  applyTenantMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import { MEDIA_PIPELINE_MIGRATION } from "@punyasitus/db/storage-usage/migrations";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import type { TenantIdentityRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/identity/_shared.ts";
import { handleTenantBusinessProfileRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/identity/business-profile/index.ts";
import { handleTenantBusinessProfilePublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/identity/business-profile/publish.ts";
import { processDurableQueueBatch } from "../../apps/web/src/worker/queues/consumer.ts";
import {
  createMediaJobRegistry,
  deriveBrandAssetsFromLogo,
  MEDIA_DERIVE_BRAND_ASSETS_TOPIC,
  processImageMediaJob,
  type MediaWorkerR2BucketLike,
} from "../../apps/web/src/worker/queues/media/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 6, 30, 0);

/**
 * Generates a minimal valid WebP VP8X binary with exact requested pixel dimensions
 * and deterministic byte length so `inspectImageBinary` verifies real WebP headers.
 */
function makeValidWebpBytes(width: number, height: number, targetByteLength = 1024): Uint8Array {
  const size = Math.max(40, targetByteLength);
  const bytes = new Uint8Array(size);
  // "RIFF"
  bytes[0] = 0x52;
  bytes[1] = 0x49;
  bytes[2] = 0x46;
  bytes[3] = 0x46;
  const riffSize = size - 8;
  bytes[4] = riffSize & 0xff;
  bytes[5] = (riffSize >>> 8) & 0xff;
  bytes[6] = (riffSize >>> 16) & 0xff;
  bytes[7] = (riffSize >>> 24) & 0xff;
  // "WEBP"
  bytes[8] = 0x57;
  bytes[9] = 0x45;
  bytes[10] = 0x42;
  bytes[11] = 0x50;
  // "VP8X"
  bytes[12] = 0x56;
  bytes[13] = 0x50;
  bytes[14] = 0x38;
  bytes[15] = 0x58;
  // Chunk size = 10
  bytes[16] = 10;
  // VP8X canvas width - 1 (24-bit LE at bytes 24..26)
  const wMinus1 = Math.max(0, width - 1);
  bytes[24] = wMinus1 & 0xff;
  bytes[25] = (wMinus1 >>> 8) & 0xff;
  bytes[26] = (wMinus1 >>> 16) & 0xff;
  // VP8X canvas height - 1 (24-bit LE at bytes 27..29)
  const hMinus1 = Math.max(0, height - 1);
  bytes[27] = hMinus1 & 0xff;
  bytes[28] = (hMinus1 >>> 8) & 0xff;
  bytes[29] = (hMinus1 >>> 16) & 0xff;
  return bytes;
}

function createFakeImagesBinding(): {
  readonly binding: CloudflareImagesBinding;
  readonly calls: Array<{ readonly width?: number; readonly height?: number; readonly quality?: number }>;
} {
  const calls: Array<{ readonly width?: number; readonly height?: number; readonly quality?: number }> = [];
  const binding: CloudflareImagesBinding = {
    input(_stream) {
      let reqWidth = 800;
      let reqHeight = 800;
      const pipeline = {
        transform(opts: { readonly width?: number; readonly height?: number }) {
          if (opts.width) reqWidth = opts.width;
          if (opts.height) reqHeight = opts.height;
          return pipeline;
        },
        async output(outOpts: { readonly format: string; readonly quality?: number }) {
          calls.push({ width: reqWidth, height: reqHeight, quality: outOpts.quality });
          // Simulate realistic bounded WebP sizes (OG steps down nicely under 300 KiB)
          const byteLen =
            reqWidth === 1200 && reqHeight === 630
              ? (outOpts.quality ?? 80) >= 82
                ? 340_000 // forces quality step-down to <= 307_200!
                : 142_000
              : reqWidth === 180
                ? 6_400
                : reqWidth === 32
                  ? 1_100
                  : 24_000;
          const payload = makeValidWebpBytes(reqWidth, reqHeight, byteLen);
          return {
            image: () =>
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(payload);
                  controller.close();
                },
              }),
            response: () =>
              new Response(payload.buffer as ArrayBuffer, {
                headers: { "Content-Type": "image/webp" },
              }),
            contentType: () => "image/webp",
          };
        },
      };
      return pipeline;
    },
  };
  return { binding, calls };
}

function createInMemoryR2Bucket(): {
  readonly bucket: MediaWorkerR2BucketLike;
  readonly store: Map<string, { readonly bytes: Uint8Array; readonly customMetadata?: Record<string, string> }>;
} {
  const store = new Map<string, { readonly bytes: Uint8Array; readonly customMetadata?: Record<string, string> }>();
  const bucket: MediaWorkerR2BucketLike = {
    async get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      return {
        key,
        size: hit.bytes.byteLength,
        customMetadata: hit.customMetadata,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(hit.bytes));
            controller.close();
          },
        }),
      } as unknown as R2ObjectBody;
    },
    async put(key, value, options) {
      let bytes: Uint8Array;
      if (value instanceof Uint8Array) {
        bytes = new Uint8Array(value);
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else if (typeof value === "string") {
        bytes = new TextEncoder().encode(value);
      } else {
        bytes = new Uint8Array(0);
      }
      store.set(key, {
        bytes,
        customMetadata: options?.customMetadata,
      });
      return { key, size: bytes.byteLength } as unknown as R2Object;
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    },
  };
  return { bucket, store };
}

function buildRuntimeEnv(
  overrides: Partial<TenantIdentityRuntimeEnv> = {},
): TenantIdentityRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    ...overrides,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractSessionCookiePair(response: Response): string {
  const cookies = getSetCookies(response.headers);
  const hit = cookies.find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!hit) throw new Error(`Missing session cookie: ${JSON.stringify(cookies)}`);
  return (hit.split(";")[0] ?? "").trim();
}

function makeAdminRequest(
  url: string,
  method: "GET" | "POST" | "PUT" | "PATCH",
  options: { readonly cookie?: string; readonly body?: unknown } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
    headers.set("Origin", APP_ORIGIN);
  }
  return new Request(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function openMigratedTenantDb(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, (_instance, state) =>
    applyTenantMigrations(state.storage as unknown as StorageLike, [
      ...TENANT_MIGRATIONS,
      MEDIA_PIPELINE_MIGRATION,
      BUSINESS_PROFILE_STRUCTURED_MIGRATION,
    ]),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function signUpUser(
  email: string,
  name: string,
  runtimeEnv: TenantIdentityRuntimeEnv,
): Promise<{ readonly userId: string; readonly cookie: string }> {
  const res = await handleBetterAuthRequest(
    makeAdminRequest(`${APP_ORIGIN}/api/auth/sign-up/email`, "POST", {
      body: { email, password: "StrongPassword!2026", name },
    }),
    runtimeEnv,
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { user?: { id: string } };
  return {
    userId: data.user?.id ?? "",
    cookie: extractSessionCookiePair(res),
  };
}

async function seedReadyImageMedia(
  tenantDb: D1Database,
  tenantId: string,
  id: number,
  bucket?: MediaWorkerR2BucketLike,
): Promise<string> {
  const key = `t/${tenantId}/media/${id}/brand-logo-master.webp`;
  await tenantDb
    .prepare(
      `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, status, version, created_at, updated_at)
       VALUES (?, 'image', ?, 'image/webp', 24000, ?, 1200, 1200, 'Logo Merek', 'ready', 1, ?, ?)`,
    )
    .bind(id, key, "b".repeat(64), BASE_NOW_MS, BASE_NOW_MS)
    .run();
  if (bucket) {
    await bucket.put(key, makeValidWebpBytes(1200, 1200, 24_000));
  }
  return key;
}

describe("TASK-091 workerd integration — Structured Business Profile API, OCC Audit, Site Settings Preservation & Logo Auto-Derivation", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("enforces settings:read RBAC (Editor 403), preserves unrelated site_settings, validates credentials, writes WHERE changes()=1 audit, and rejects 409/locked mutations", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);
    const paidThrough = new Date(BASE_NOW_MS + 30 * 24 * 60 * 60 * 1000);

    const tenantId = "01JT091ALPHA00000000000001";
    const handle = "t091-alpha";
    const orgId = "org-t091-alpha";

    const owner = await signUpUser("owner.t091.a@example.test", "Owner T091", runtimeEnv);
    const editor = await signUpUser("editor.t091.a@example.test", "Editor T091", runtimeEnv);

    await db.insert(organizations).values({
      id: orgId,
      name: "Travel Rahmatan",
      slug: handle,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tenants).values({
      id: tenantId,
      organizationId: orgId,
      handle,
      name: "Travel Rahmatan",
      status: "active",
      paidThrough,
      cacheVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(members).values([
      { id: "mem-t091-owner", organizationId: orgId, userId: owner.userId, role: "owner", createdAt: now },
      { id: "mem-t091-editor", organizationId: orgId, userId: editor.userId, role: "editor", createdAt: now },
    ]);

    const tenantDb = await openMigratedTenantDb(tenantId);
    await seedReadyImageMedia(tenantDb, tenantId, 10);

    // Seed pre-existing site_settings with activeThemeId = 'travel' and analytics_config_json
    const seededAnalytics = JSON.stringify({ ga4MeasurementId: "G-T091TEST12" });
    await tenantDb
      .prepare(
        `INSERT INTO site_settings (
           id, site_title, tagline, timezone, locale, active_theme_id,
           blog_enabled, catalog_enabled, ai_training_policy, analytics_config_json,
           version, updated_at
         ) VALUES (1, 'Travel Rahmatan', 'Umrah Amanah', 'Asia/Jakarta', 'id-ID', 'travel', 1, 1, 'disallow', ?, 1, ?)`,
      )
      .bind(seededAnalytics, BASE_NOW_MS)
      .run();
    await tenantDb
      .prepare(
        `INSERT INTO business_profile (id, business_name, business_category, version, updated_at)
         VALUES (1, 'Travel Rahmatan', 'local_business', 1, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();

    // 1. Editor MUST be denied with 403 FORBIDDEN on GET (settings:read) and PATCH (settings:write)
    const editorGet = await handleTenantBusinessProfileRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/identity/business-profile`, "GET", {
        cookie: editor.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 100 },
    );
    expect(editorGet.status).toBe(403);
    expect(editorGet.headers.get("cache-control")).toBe("no-store");
    expect(editorGet.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    // 2. Reject deprecated ProfessionalService & invalid NIB with 422 without mutating DB
    const badCatRes = await handleTenantBusinessProfileRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/identity/business-profile`, "PATCH", {
        cookie: owner.cookie,
        body: {
          expectedVersion: 1,
          businessProfile: { businessCategory: "ProfessionalService" },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 200 },
    );
    expect(badCatRes.status).toBe(422);

    const badCredRes = await handleTenantBusinessProfileRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/identity/business-profile`, "PATCH", {
        cookie: owner.cookie,
        body: {
          expectedVersion: 1,
          businessProfile: { credentials: { nib: "12345" } },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 250 },
    );
    expect(badCredRes.status).toBe(422);

    // 3. Valid structured draft save (travel_umrah_agency + NIB + SK Kemenag + privacyContact + closedDays)
    const saveRes = await handleTenantBusinessProfileRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/identity/business-profile`, "PATCH", {
        cookie: owner.cookie,
        body: {
          expectedVersion: 1,
          siteSettings: { logoMediaId: 10 },
          businessProfile: {
            businessName: "Travel Rahmatan Nusantara",
            legalName: "PT Rahmatan Wisata Mandiri",
            businessCategory: "travel_umrah_agency",
            privacyContact: "privasi@rahmatan.id",
            whatsappE164: "0812-9988-7766",
            closedDays: ["sunday"],
            serviceAreas: ["Jabodetabek", "Bandung"],
            socialLinks: [{ platform: "instagram", url: "https://instagram.com/rahmatantravel" }],
            credentials: {
              nib: "1234567890123",
              skKemenagPpiu: "U.123 Tahun 2024",
            },
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as {
      version: number;
      siteSettings: { activeThemeId: string; aiTrainingPolicy: string; analyticsConfig: { ga4MeasurementId?: string } | null };
      businessProfile: {
        businessCategoryKey: string;
        resolvedSchemaType: string;
        legalName: string | null;
        privacyContact: string | null;
        closedDays: string[];
        credentials: { nib?: string; skKemenagPpiu?: string };
      };
    };
    expect(saved.version).toBe(2);
    expect(saved.businessProfile.businessCategoryKey).toBe("travel_umrah_agency");
    expect(saved.businessProfile.resolvedSchemaType).toBe("TravelAgency");
    expect(saved.businessProfile.legalName).toBe("PT Rahmatan Wisata Mandiri");
    expect(saved.businessProfile.privacyContact).toBe("privasi@rahmatan.id");
    expect(saved.businessProfile.closedDays).toEqual(["sunday"]);
    expect(saved.businessProfile.credentials).toEqual({
      nib: "1234567890123",
      skKemenagPpiu: "U.123 Tahun 2024",
    });

    // Unrelated site_settings fields MUST be 100% preserved!
    expect(saved.siteSettings.activeThemeId).toBe("travel");
    expect(saved.siteSettings.aiTrainingPolicy).toBe("disallow");
    expect(saved.siteSettings.analyticsConfig?.ga4MeasurementId).toBe("G-T091TEST12");

    // Draft MUST NOT leak publicly before publish
    expect(await getPublishedStructuredBusinessProfile(tenantDb)).toBeNull();

    // Verify audit entry recorded via `WHERE changes() = 1`
    const auditAfterSave = await tenantDb
      .prepare("SELECT action FROM tenant_activity_log ORDER BY id ASC")
      .all<{ readonly action: string }>();
    expect(auditAfterSave.results.map((r) => r.action)).toContain("business_profile.draft_saved");
    const countAfterSave = auditAfterSave.results.length;

    // 4. Stale expectedVersion -> 409 STALE_VERSION and ZERO new audit rows!
    const staleRes = await handleTenantBusinessProfileRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/identity/business-profile`, "PATCH", {
        cookie: owner.cookie,
        body: {
          expectedVersion: 1,
          businessProfile: { legalName: "Should Not Apply" },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_500 },
    );
    expect(staleRes.status).toBe(409);
    const auditAfterStale = await tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_activity_log")
      .first<{ readonly cnt: number }>();
    expect(Number(auditAfterStale?.cnt ?? 0)).toBe(countAfterSave);

    // 5. Atomic publish bumps PLATFORM_DB cache_version, exposes published DTO, and logs audit
    const pubRes = await handleTenantBusinessProfilePublishRequest(
      handle,
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${handle}/identity/business-profile/publish`,
        "POST",
        {
          cookie: owner.cookie,
          body: { expectedVersion: 2 },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_000 },
    );
    expect(pubRes.status).toBe(200);
    const pubBody = (await pubRes.json()) as { version: number; cacheVersion: number };
    expect(pubBody.cacheVersion).toBeGreaterThan(1);

    const publishedDto = await getPublishedStructuredBusinessProfile(tenantDb);
    expect(publishedDto?.businessProfile.resolvedSchemaType).toBe("TravelAgency");
    expect(publishedDto?.businessProfile.legalName).toBe("PT Rahmatan Wisata Mandiri");
    expect(publishedDto?.businessProfile.credentials.skKemenagPpiu).toBe("U.123 Tahun 2024");
    expect(publishedDto?.siteSettings.activeThemeId).toBe("travel");
    expect(publishedDto?.siteSettings.analyticsConfig?.ga4MeasurementId).toBe("G-T091TEST12");

    // 6. Locked tenant (H+4..H+7 past paidThrough) -> GET 200 read-only, PATCH & publish 403 SUBSCRIPTION_LOCKED
    const fiveDaysAgo = new Date(BASE_NOW_MS - 5 * 24 * 60 * 60 * 1000);
    await db
      .update(tenants)
      .set({ status: "locked", paidThrough: fiveDaysAgo })
      .where(eq(tenants.id, tenantId));

    const lockedGet = await handleTenantBusinessProfileRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/identity/business-profile`, "GET", {
        cookie: owner.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_000 },
    );
    expect(lockedGet.status).toBe(200);

    const lockedPatch = await handleTenantBusinessProfileRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/identity/business-profile`, "PATCH", {
        cookie: owner.cookie,
        body: { expectedVersion: pubBody.version, businessProfile: { legalName: "Blocked" } },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_100 },
    );
    expect(lockedPatch.status).toBe(403);
    expect(((await lockedPatch.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );
  });

  it("auto-derives 32x32+180x180 favicons & <=300 KiB 1200x630 OG on logo upload ONLY when unset, and NEVER overwrites explicit tenant overrides", async () => {
    const tenantId = "01JT091BRAND00000000000002";
    const tenantDb = await openMigratedTenantDb(tenantId);
    const { bucket, store } = createInMemoryR2Bucket();
    const { binding: images } = createFakeImagesBinding();

    // Seed baseline site_settings + business_profile with NO favicon or OG override
    await tenantDb
      .prepare(
        `INSERT INTO site_settings (id, site_title, version, updated_at)
         VALUES (1, 'Klinik Sehat', 1, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();
    await tenantDb
      .prepare(
        `INSERT INTO business_profile (id, business_name, business_category, version, updated_at)
         VALUES (1, 'Klinik Sehat', 'medical_clinic', 1, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();

    // Seed media upload intent + processing media #100 in quarantine and run processImageMediaJob(purpose: "logo")
    const quarantineKey = `t/${tenantId}/quarantine/01JINTENTLOGO0000000000001/logo-klinik.webp`;
    const sourceWebp = makeValidWebpBytes(1024, 1024, 16_000);
    await bucket.put(quarantineKey, sourceWebp);

    await tenantDb
      .prepare(
        `INSERT INTO storage_usage (id, used_bytes, reserved_bytes, quota_bytes, updated_at)
         VALUES (1, 0, 16000, 104857600, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();
    await tenantDb
      .prepare(
        `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, alt_text, status, version, created_at, updated_at)
         VALUES (100, 'image', ?, 'image/webp', 16000, ?, 'Logo Klinik', 'processing', 1, ?, ?)`,
      )
      .bind(quarantineKey, "c".repeat(64), BASE_NOW_MS, BASE_NOW_MS)
      .run();
    await tenantDb
      .prepare(
        `INSERT INTO media_upload_intents (
           id, kind, original_filename, slug, declared_mime, declared_bytes, declared_sha256,
           alt_text, decorative, quarantine_r2_key, reserved_bytes, media_item_id, status,
           expires_at, created_at, updated_at
         ) VALUES (
           '01JINTENTLOGO0000000000001', 'image', 'logo-klinik.webp', 'logo-klinik', 'image/webp',
           16000, ?, 'Logo Klinik', 0, ?, 16000, 100, 'processing', ?, ?, ?
         )`,
      )
      .bind("c".repeat(64), quarantineKey, BASE_NOW_MS + 600_000, BASE_NOW_MS, BASE_NOW_MS)
      .run();

    const jobRes = await processImageMediaJob(
      {
        intentId: "01JINTENTLOGO0000000000001",
        mediaId: 100,
        quarantineR2Key: quarantineKey,
        originalFilename: "logo-klinik.webp",
        purpose: "logo",
      },
      {
        tenantId,
        tenantDb,
        mediaBucket: bucket,
        images,
        nowMs: BASE_NOW_MS + 500,
      },
    );

    expect(jobRes.status).toBe("completed");
    expect(jobRes.quarantineDeleted).toBe(true);
    expect(jobRes.brandAssetsDerivation?.status).toBe("derived");
    expect(jobRes.brandAssetsDerivation?.derivedFavicon32?.width).toBe(32);
    expect(jobRes.brandAssetsDerivation?.derivedFavicon32?.height).toBe(32);
    expect(jobRes.brandAssetsDerivation?.derivedAppleTouch180?.width).toBe(180);
    expect(jobRes.brandAssetsDerivation?.derivedAppleTouch180?.height).toBe(180);
    expect(jobRes.brandAssetsDerivation?.derivedOg1200x630?.width).toBe(1200);
    expect(jobRes.brandAssetsDerivation?.derivedOg1200x630?.height).toBe(630);
    expect(jobRes.brandAssetsDerivation?.derivedOg1200x630?.bytes).toBeLessThanOrEqual(307_200);

    // Verify all 3 derived R2 keys exist under tenant namespace
    expect(store.has(jobRes.brandAssetsDerivation!.derivedFavicon32!.key)).toBe(true);
    expect(store.has(jobRes.brandAssetsDerivation!.derivedAppleTouch180!.key)).toBe(true);
    expect(store.has(jobRes.brandAssetsDerivation!.derivedOg1200x630!.key)).toBe(true);

    // Now simulate tenant selecting logo #202 + EXPLICIT custom favicon (#201) override while leaving OG unset!
    await seedReadyImageMedia(tenantDb, tenantId, 201, bucket);
    await seedReadyImageMedia(tenantDb, tenantId, 202, bucket);
    await saveStructuredBusinessProfileDraft(tenantDb, {
      expectedVersion: 1,
      siteSettings: { logoMediaId: 202, faviconMediaId: 201 },
      nowMs: BASE_NOW_MS + 1_500,
    });

    const partialRes = await deriveBrandAssetsFromLogo({
      tenantId,
      tenantDb,
      logoMediaId: 202,
      originalFilename: "logo-baru.webp",
      images,
      mediaBucket: bucket,
      nowMs: BASE_NOW_MS + 2_000,
    });

    expect(partialRes.status).toBe("partial_override_preserved");
    expect(partialRes.preservedFaviconOverride).toBe(true);
    expect(partialRes.derivedFavicon32).toBeNull();
    expect(partialRes.derivedAppleTouch180).toBeNull();
    expect(partialRes.derivedOg1200x630?.sourceLogoMediaId).toBe(202);
    expect(partialRes.derivedOg1200x630?.bytes).toBeLessThanOrEqual(307_200);
    expect(partialRes.brandAssets.effective.faviconSource).toBe("explicit_override");
    expect(partialRes.brandAssets.effective.effectiveFaviconOverrideMediaId).toBe(201);
    expect(partialRes.brandAssets.effective.ogImageSource).toBe("auto_derived_from_logo");

    // Now set BOTH explicit favicon (#201) AND explicit OG (#203) overrides -> logo upload MUST NOT overwrite either!
    await seedReadyImageMedia(tenantDb, tenantId, 203, bucket);
    await saveStructuredBusinessProfileDraft(tenantDb, {
      expectedVersion: 2,
      siteSettings: { logoMediaId: 202, faviconMediaId: 201, ogImageMediaId: 203 },
      nowMs: BASE_NOW_MS + 2_500,
    });

    const skippedRes = await deriveBrandAssetsFromLogo({
      tenantId,
      tenantDb,
      logoMediaId: 202,
      originalFilename: "logo-ketiga.webp",
      images,
      mediaBucket: bucket,
      nowMs: BASE_NOW_MS + 3_000,
    });
    expect(skippedRes.status).toBe("skipped_all_overridden");
    expect(skippedRes.preservedFaviconOverride).toBe(true);
    expect(skippedRes.preservedOgOverride).toBe(true);
    expect(skippedRes.derivedFavicon32).toBeNull();
    expect(skippedRes.derivedOg1200x630).toBeNull();

    const adminDto = await getStructuredBusinessProfileForAdmin(tenantDb);
    expect(adminDto.brandAssets.effective.faviconSource).toBe("explicit_override");
    expect(adminDto.brandAssets.effective.effectiveFaviconOverrideMediaId).toBe(201);
    expect(adminDto.brandAssets.effective.ogImageSource).toBe("explicit_override");
    expect(adminDto.brandAssets.effective.effectiveOgOverrideMediaId).toBe(203);
  });

  it("enforces strictly monotonic unified version across base (v5) and extension (v3), rejecting concurrent stale v5 with 409 and zero partial writes", async () => {
    const tenantId = "01JT091MONO000000000000003";
    const tenantDb = await openMigratedTenantDb(tenantId);

    // Seed base tables at v5 and structured extension at v3
    await tenantDb
      .prepare(
        `INSERT INTO site_settings (id, site_title, active_theme_id, version, updated_at)
         VALUES (1, 'Studio Monotonik', 'compro', 5, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();
    await tenantDb
      .prepare(
        `INSERT INTO business_profile (id, business_name, business_category, version, updated_at)
         VALUES (1, 'Studio Monotonik', 'b2b_corporate', 5, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();
    await tenantDb
      .prepare(
        `INSERT INTO business_profile_structured (
           id, legal_name, privacy_contact, closed_days_json, credentials_json,
           draft_json, published_json, version, updated_at
         ) VALUES (1, 'PT Awal', NULL, '[]', '{}', '{"legalName":"PT Awal","privacyContact":null,"personRoleTitle":null,"affiliatedOrgName":null,"closedDays":[],"credentials":{}}', NULL, 3, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();

    // Extension-only save with expectedVersion = 5 MUST advance unified version to 6 across ALL 3 tables
    const saved = await saveStructuredBusinessProfileDraft(tenantDb, {
      expectedVersion: 5,
      businessProfile: { legalName: "PT Monotonik Sejahtera" },
      actorUserId: "user_owner",
      actorRole: "owner",
      nowMs: BASE_NOW_MS + 1_000,
    });

    expect(saved.version).toBe(6);
    expect(saved.versions).toEqual({
      siteSettings: 6,
      businessProfile: 6,
      structuredExtension: 6,
    });
    expect(saved.businessProfile?.legalName).toBe("PT Monotonik Sejahtera");

    const auditCountAfterV6 = await tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_activity_log")
      .first<{ readonly cnt: number }>();
    expect(Number(auditCountAfterV6?.cnt ?? 0)).toBe(1);

    // Concurrent client still holding expectedVersion = 5 MUST get 409 STALE_VERSION with ZERO partial writes
    let caughtErr: unknown = null;
    try {
      await saveStructuredBusinessProfileDraft(tenantDb, {
        expectedVersion: 5,
        businessProfile: { legalName: "PT Stale Overwrite" },
        actorUserId: "user_admin",
        actorRole: "admin",
        nowMs: BASE_NOW_MS + 2_000,
      });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(Error);
    expect((caughtErr as { code?: string; httpStatus?: number }).httpStatus).toBe(409);
    expect((caughtErr as { code?: string }).code).toBe("STALE_VERSION");

    // Verify ZERO mutation and ZERO extra audit row
    const afterStale = await getStructuredBusinessProfileForAdmin(tenantDb);
    expect(afterStale.version).toBe(6);
    expect(afterStale.businessProfile?.legalName).toBe("PT Monotonik Sejahtera");
    const auditCountAfterStale = await tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_activity_log")
      .first<{ readonly cnt: number }>();
    expect(Number(auditCountAfterStale?.cnt ?? 0)).toBe(1);

    // Cross-tier publish compensation: if PLATFORM_DB cache_version bump fails, ALL tables & audit revert cleanly!
    const failingPlatformDb = {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                throw new Error("Simulated PLATFORM_DB outage");
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    let pubErr: unknown = null;
    try {
      await publishStructuredBusinessProfile(failingPlatformDb, tenantDb, {
        tenantId,
        expectedVersion: 6,
        actorUserId: "user_owner",
        actorRole: "owner",
        nowMs: BASE_NOW_MS + 3_000,
      });
    } catch (err) {
      pubErr = err;
    }
    expect(pubErr).toBeInstanceOf(PublicationAtomicError);
    expect((pubErr as PublicationAtomicError).compensated).toBe(true);

    const afterRollback = await getStructuredBusinessProfileForAdmin(tenantDb);
    expect(afterRollback.version).toBe(6);
    expect(afterRollback.published).toBeNull();
    const auditAfterRollback = await tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_activity_log WHERE action = 'business_profile.published'")
      .first<{ readonly cnt: number }>();
    expect(Number(auditAfterRollback?.cnt ?? 0)).toBe(0);
  });

  it("guards against stale logo derivation races — including published logo A finishing after unpublished draft logo B", async () => {
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);
    const paidThrough = new Date(BASE_NOW_MS + 30 * 24 * 60 * 60 * 1000);

    const tenantId = "01JT091STALE00000000000004";
    const handle = "t091-stale-race";
    const orgId = "org-t091-stale-race";

    await db.insert(organizations).values({
      id: orgId,
      name: "Brand Race Test",
      slug: handle,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tenants).values({
      id: tenantId,
      organizationId: orgId,
      handle,
      name: "Brand Race Test",
      status: "active",
      paidThrough,
      cacheVersion: 1,
      createdAt: now,
      updatedAt: now,
    });

    const tenantDb = await openMigratedTenantDb(tenantId);
    const { bucket } = createInMemoryR2Bucket();
    const { binding: images } = createFakeImagesBinding();

    await seedReadyImageMedia(tenantDb, tenantId, 301, bucket);
    await seedReadyImageMedia(tenantDb, tenantId, 302, bucket);

    // 1. Save AND PUBLISH logo A (#301) so `published_json` contains logo A (#301)!
    await saveStructuredBusinessProfileDraft(tenantDb, {
      expectedVersion: 0,
      siteSettings: { siteTitle: "Brand Race Test", logoMediaId: 301 },
      businessProfile: { businessName: "Brand Race Test", businessCategory: "local_business" },
      nowMs: BASE_NOW_MS,
    });
    await publishStructuredBusinessProfile(env.PLATFORM_DB, tenantDb, {
      tenantId,
      expectedVersion: 1,
      actorUserId: "user_owner",
      actorRole: "owner",
      nowMs: BASE_NOW_MS + 50,
    });

    const deriveA = await deriveBrandAssetsFromLogo({
      tenantId,
      tenantDb,
      logoMediaId: 301,
      originalFilename: "logo-a.webp",
      images,
      mediaBucket: bucket,
      nowMs: BASE_NOW_MS + 100,
    });
    expect(deriveA.status).toBe("derived");
    expect(deriveA.derivedFavicon32?.sourceLogoMediaId).toBe(301);

    // 2. Tenant switches to logo B (#302) as an UNPUBLISHED DRAFT (published_json STILL has logo A #301!)
    await saveStructuredBusinessProfileDraft(tenantDb, {
      expectedVersion: 2,
      siteSettings: { logoMediaId: 302 },
      nowMs: BASE_NOW_MS + 200,
    });

    const deriveB = await deriveBrandAssetsFromLogo({
      tenantId,
      tenantDb,
      logoMediaId: 302,
      originalFilename: "logo-b.webp",
      images,
      mediaBucket: bucket,
      nowMs: BASE_NOW_MS + 300,
    });
    expect(deriveB.status).toBe("derived");
    expect(deriveB.derivedFavicon32?.sourceLogoMediaId).toBe(302);
    expect(deriveB.derivedOg1200x630?.sourceLogoMediaId).toBe(302);

    // 3a. Late stale job for PUBLISHED logo A (#301) via deriveBrandAssetsFromLogo -> skipped_stale_logo!
    const lateDeriveA = await deriveBrandAssetsFromLogo({
      tenantId,
      tenantDb,
      logoMediaId: 301,
      originalFilename: "logo-a.webp",
      images,
      mediaBucket: bucket,
      nowMs: BASE_NOW_MS + 400,
    });
    expect(lateDeriveA.status).toBe("skipped_stale_logo");
    expect(lateDeriveA.derivedFavicon32).toBeNull();
    expect(lateDeriveA.derivedOg1200x630).toBeNull();

    // 3b. Direct TOCTOU applyAutoDerivedBrandAssets for PUBLISHED logo A (#301) -> MUST NOT match published_json or overwrite draft logo B!
    const directToctouRes = await applyAutoDerivedBrandAssets(tenantDb, {
      sourceLogoMediaId: 301,
      favicon32: {
        key: `t/${tenantId}/media/301/logo-a-favicon-32.webp`,
        width: 32,
        height: 32,
        bytes: 1100,
        mimeType: "image/webp",
        sourceLogoMediaId: 301,
        derivedAt: new Date(BASE_NOW_MS + 500).toISOString(),
      },
      appleTouch180: {
        key: `t/${tenantId}/media/301/logo-a-apple-touch-180.webp`,
        width: 180,
        height: 180,
        bytes: 6400,
        mimeType: "image/webp",
        sourceLogoMediaId: 301,
        derivedAt: new Date(BASE_NOW_MS + 500).toISOString(),
      },
      og1200x630: {
        key: `t/${tenantId}/media/301/logo-a-brand-og-1200x630.webp`,
        width: 1200,
        height: 630,
        bytes: 142000,
        mimeType: "image/webp",
        sourceLogoMediaId: 301,
        derivedAt: new Date(BASE_NOW_MS + 500).toISOString(),
      },
      nowMs: BASE_NOW_MS + 500,
    });
    expect(directToctouRes.appliedFavicon).toBe(false);
    expect(directToctouRes.appliedOgImage).toBe(false);
    expect(directToctouRes.staleLogoSkipped).toBe(true);

    // Logo B's derived assets MUST remain 100% intact!
    const finalState = await getStructuredBusinessProfileForAdmin(tenantDb);
    expect(finalState.brandAssets.sourceLogoMediaId).toBe(302);
    expect(finalState.brandAssets.derivedFavicon32?.sourceLogoMediaId).toBe(302);
    expect(finalState.brandAssets.derivedOg1200x630?.sourceLogoMediaId).toBe(302);
  });

  it("enqueues durable media.derive_brand_assets on PATCH logoMediaId and executes end-to-end via processDurableQueueBatch(createMediaJobRegistry())", async () => {
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);
    const paidThrough = new Date(BASE_NOW_MS + 30 * 24 * 60 * 60 * 1000);

    const tenantId = "01JT091QUEUE00000000000005";
    const handle = "t091-queue";
    const orgId = "org-t091-queue";

    const enqueuedMessages: JobEnvelopeInput[] = [];
    const { bucket, store } = createInMemoryR2Bucket();
    const { binding: images } = createFakeImagesBinding();

    const runtimeEnv = buildRuntimeEnv({
      MEDIA_BUCKET: bucket,
      IMAGES: images,
      JOBS_QUEUE: {
        async send(msg: JobEnvelopeInput) {
          enqueuedMessages.push(msg);
        },
      },
    });

    const owner = await signUpUser("owner.t091.q@example.test", "Owner Queue", runtimeEnv);
    await db.insert(organizations).values({
      id: orgId,
      name: "Kafe Queue Nusantara",
      slug: handle,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tenants).values({
      id: tenantId,
      organizationId: orgId,
      handle,
      name: "Kafe Queue Nusantara",
      status: "active",
      paidThrough,
      cacheVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(members).values({
      id: "mem-t091-q-owner",
      organizationId: orgId,
      userId: owner.userId,
      role: "owner",
      createdAt: now,
    });

    const tenantDb = await openMigratedTenantDb(tenantId);
    await seedReadyImageMedia(tenantDb, tenantId, 401, bucket);
    await seedReadyImageMedia(tenantDb, tenantId, 402, bucket); // explicit favicon override

    // PATCH setting logoMediaId = 401 AND explicit faviconMediaId = 402 (leaving OG unset)
    const patchRes = await handleTenantBusinessProfileRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/identity/business-profile`, "PATCH", {
        cookie: owner.cookie,
        body: {
          expectedVersion: 0,
          siteSettings: {
            siteTitle: "Kafe Queue Nusantara",
            logoMediaId: 401,
            faviconMediaId: 402,
          },
          businessProfile: {
            businessName: "Kafe Queue Nusantara",
            businessCategory: "cafe",
            credentials: { halalBpjh: "ID31110000123450123" },
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(patchRes.status).toBe(200);

    // 1. Verify durable job was enqueued onto JOBS_QUEUE and PLATFORM_DB.job_ledger
    expect(enqueuedMessages).toHaveLength(1);
    const queuedMsg = enqueuedMessages[0]!;
    expect(queuedMsg.topic).toBe(MEDIA_DERIVE_BRAND_ASSETS_TOPIC);
    expect(queuedMsg.tenantId).toBe(tenantId);
    expect(queuedMsg.payload).toEqual({ logoMediaId: 401 });

    // 2. Execute end-to-end through `processDurableQueueBatch` + `createMediaJobRegistry()`!
    const acked: string[] = [];
    const retried: string[] = [];
    const fakeBatch = {
      queue: "punyasitus-jobs",
      messages: [
        {
          id: "msg-t091-1",
          timestamp: new Date(BASE_NOW_MS + 1_100),
          body: queuedMsg,
          attempts: 1,
          ack: () => acked.push(queuedMsg.idempotencyKey),
          retry: () => retried.push(queuedMsg.idempotencyKey),
        },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<unknown>;

    const batchResult = await processDurableQueueBatch(
      fakeBatch,
      {
        PLATFORM_DB: env.PLATFORM_DB,
        TENANT_STORE: env.TENANT_STORE,
      },
      createMediaJobRegistry({
        images,
        mediaBucket: bucket,
        resolveTenantDb: () => tenantDb,
      }),
      { now: () => BASE_NOW_MS + 1_200 },
    );

    expect(batchResult.completed).toBe(1);
    expect(batchResult.deadLettered).toBe(0);
    expect(acked).toEqual([queuedMsg.idempotencyKey]);
    expect(retried).toEqual([]);

    // 3. Verify derived OG (1200x630 <= 300 KiB) persisted to R2 & TenantStore while explicit favicon override #402 was NEVER overwritten!
    const afterQueue = await getStructuredBusinessProfileForAdmin(tenantDb);
    expect(afterQueue.brandAssets.effective.faviconSource).toBe("explicit_override");
    expect(afterQueue.brandAssets.effective.effectiveFaviconOverrideMediaId).toBe(402);
    expect(afterQueue.brandAssets.derivedFavicon32).toBeNull();
    expect(afterQueue.brandAssets.effective.ogImageSource).toBe("auto_derived_from_logo");
    expect(afterQueue.brandAssets.derivedOg1200x630?.width).toBe(1200);
    expect(afterQueue.brandAssets.derivedOg1200x630?.height).toBe(630);
    expect(afterQueue.brandAssets.derivedOg1200x630?.bytes).toBeLessThanOrEqual(307_200);
    expect(store.has(afterQueue.brandAssets.derivedOg1200x630!.key)).toBe(true);
  });
});

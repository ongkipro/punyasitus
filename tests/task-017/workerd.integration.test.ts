import { env } from "cloudflare:workers";
import { buildQuarantineR2Key, computeSha256Hex, type CloudflareImagesBinding, type CloudflareImagesTransformOptions } from "@punyasitus/core/media/index";
import { DEFAULT_MEDIA_CDN_ORIGIN } from "@punyasitus/core/og-generator";
import {
  AI_TRAINING_ONLY_CRAWLERS,
  ALLOWED_SEARCH_AND_AI_FETCHERS,
  FACETED_FILTER_DISALLOW_PATTERNS,
} from "@punyasitus/core/seo/index";
import { createCatalogOffering, publishCatalogOffering, unpublishCatalogOffering, updateCatalogOffering } from "@punyasitus/db/catalog/index";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  createMediaUploadIntent,
  markUploadIntentQuarantinedAndCreateMedia,
} from "@punyasitus/db/media/index";
import { createPage, publishPage, unpublishPage, updatePage } from "@punyasitus/db/pages/index";
import {
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
} from "@punyasitus/db/platform";
import { createPost, publishPost, unpublishPost, updatePost } from "@punyasitus/db/posts/index";
import { bumpTenantCacheVersion, publishResourceAtomically, saveDraftResource } from "@punyasitus/db/publication/index";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  executeTenantMiddleware,
  type TenantMiddlewareLocals,
} from "../../apps/web/src/core/tenant.ts";
import {
  handleBlogFeedRequest,
  handleRobotsTxtRequest,
  handleSitemapIndexRequest,
  handleSubSitemapRequest,
  type DiscoveryHandlerDeps,
} from "../../apps/web/src/pages/sitemaps/_shared.ts";
import {
  processImageMediaJob,
  type MediaWorkerR2BucketLike,
} from "../../apps/web/src/worker/queues/media/index.ts";
import { getChildElements, getFirstChildText, parseStrictXml } from "./xml-parser.ts";

const BASE_TIME = 1_840_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TENANT_ALPHA = {
  id: "01JT017ALPHA00000000000001",
  orgId: "org_t017_alpha",
  handle: "t017-alpha",
  name: "Alpha Konstruksi & Logistik",
  subdomain: "t017-alpha.situsku.click",
  customDomain: "www.t017-alpha.id",
} as const;

const TENANT_BETA = {
  id: "01JT017BETA000000000000002",
  orgId: "org_t017_beta",
  handle: "t017-beta",
  name: "Beta Wisata Nusantara",
  subdomain: "t017-beta.situsku.click",
} as const;

const TENANT_TRIAL = {
  id: "01JT017TRIAL00000000000003",
  orgId: "org_t017_trial",
  handle: "t017-trial",
  name: "Trial Studio",
  subdomain: "t017-trial.situsku.click",
} as const;

const TENANT_SUSPENDED = {
  id: "01JT017SUSP000000000000004",
  orgId: "org_t017_suspended",
  handle: "t017-suspended",
  name: "Suspended Corp",
  subdomain: "t017-suspended.situsku.click",
} as const;

const TENANT_RECOVERY = {
  id: "01JT017RECV000000000000005",
  orgId: "org_t017_recovery",
  handle: "t017-recovery",
  name: "Recovery Corp",
  subdomain: "t017-recovery.situsku.click",
} as const;

const TENANT_PURGED = {
  id: "01JT017PURG000000000000006",
  orgId: "org_t017_purged",
  handle: "t017-purged",
  name: "Purged Corp",
  subdomain: "t017-purged.situsku.click",
} as const;

function makeValidPng(width: number, height: number, totalSize = 128): Uint8Array {
  const size = Math.max(33, totalSize);
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

function makeValidWebpVp8X(width: number, height: number, totalSize = 2048): Uint8Array {
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

function createDeterministicImagesBinding(): CloudflareImagesBinding {
  return {
    input() {
      let opts: CloudflareImagesTransformOptions = {};
      return {
        transform(next) {
          opts = { ...opts, ...next };
          return this;
        },
        async output() {
          const width = opts.width ?? 1280;
          const height = opts.height ?? 720;
          const bytes = makeValidWebpVp8X(width, height, 64_000);
          return {
            image() {
              return new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              });
            },
            response() {
              return new Response(new Uint8Array(bytes).buffer, {
                headers: { "Content-Type": "image/webp" },
              });
            },
            contentType() {
              return "image/webp";
            },
          };
        },
      };
    },
  };
}

async function seedTenantWithHost(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: "active" | "trial" | "suspended" | "recovery" | "purged";
  readonly subdomain: string;
  readonly customDomain?: string;
}): Promise<D1Database> {
  const now = new Date(BASE_TIME);
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  await pDb
    .insert(organizations)
    .values({
      id: spec.orgId,
      name: spec.name,
      slug: spec.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenants)
    .values({
      id: spec.id,
      organizationId: spec.orgId,
      handle: spec.handle,
      name: spec.name,
      status: spec.status,
      paidThrough: spec.status === "active" ? new Date(BASE_TIME + 30 * DAY_MS) : null,
      trialEndsAt: spec.status === "trial" ? new Date(BASE_TIME + 7 * DAY_MS) : null,
      cacheVersion: 1,
      schemaVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const hostRows = spec.customDomain
    ? [
        {
          host: spec.customDomain,
          tenantId: spec.id,
          kind: "custom" as const,
          status: "active" as const,
          sslStatus: "active" as const,
          isPrimary: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          host: spec.subdomain,
          tenantId: spec.id,
          kind: "subdomain" as const,
          status: "active" as const,
          sslStatus: "active" as const,
          isPrimary: false,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ]
    : [
        {
          host: spec.subdomain,
          tenantId: spec.id,
          kind: "subdomain" as const,
          status: "active" as const,
          sslStatus: "active" as const,
          isPrimary: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ];

  await pDb.insert(tenantHosts).values(hostRows).onConflictDoNothing();

  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const stub = openTenantStoreStub(ns, spec.id);
  if (spec.status !== "purged" && spec.status !== "recovery") {
    const mig = await orchestrateTenantMigration(env.PLATFORM_DB, stub, spec.id, TENANT_MIGRATIONS);
    expect(mig.httpStatus).toBe(200);
  }
  return createTenantDb(stub);
}

async function ingestReadyTenantImage(params: {
  readonly tenantId: string;
  readonly tenantDb: D1Database;
  readonly filename: string;
  readonly altText: string;
  readonly nowMs: number;
}): Promise<number> {
  const pngBytes = makeValidPng(1600, 900, 2048);
  const sha256 = await computeSha256Hex(pngBytes);
  const intentRes = await createMediaUploadIntent(params.tenantDb, {
    tenantId: params.tenantId,
    tenantStatus: "active",
    filename: params.filename,
    declaredMime: "image/png",
    declaredBytes: pngBytes.byteLength,
    declaredSha256: sha256,
    altText: params.altText,
    nowMs: params.nowMs,
  });
  expect(intentRes.ok).toBe(true);
  if (!intentRes.ok) throw new Error(intentRes.message);

  const quarantineKey = intentRes.intent.quarantineR2Key;
  expect(quarantineKey).toBe(
    buildQuarantineR2Key(params.tenantId, intentRes.intent.id, params.filename),
  );
  await env.MEDIA_BUCKET.put(quarantineKey, pngBytes, {
    httpMetadata: { contentType: "image/png" },
  });

  const marked = await markUploadIntentQuarantinedAndCreateMedia(params.tenantDb, {
    tenantId: params.tenantId,
    intentId: intentRes.intent.id,
    quarantineR2Key: quarantineKey,
    detectedMime: "image/png",
    sha256,
    width: 1600,
    height: 900,
    nowMs: params.nowMs + 100,
  });
  expect(marked.ok).toBe(true);
  if (!marked.ok) throw new Error(marked.message);

  const processed = await processImageMediaJob(
    {
      intentId: intentRes.intent.id,
      mediaId: marked.mediaId,
      quarantineR2Key: quarantineKey,
      originalFilename: params.filename,
    },
    {
      tenantId: params.tenantId,
      tenantDb: params.tenantDb,
      mediaBucket: env.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike,
      images: createDeterministicImagesBinding(),
      nowMs: params.nowMs + 200,
    },
  );
  expect(processed.status).toBe("completed");
  expect(processed.media.status).toBe("ready");
  return marked.mediaId;
}

function makeRuntimeDiscoveryDeps(
  overrides: Partial<DiscoveryHandlerDeps> = {},
): DiscoveryHandlerDeps {
  return {
    platformDb: env.PLATFORM_DB,
    tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    platformDomain: "punyasitus.com",
    saasZone: "situsku.click",
    nowMs: BASE_TIME + 50_000,
    bypassHostCache: true,
    ...overrides,
  };
}

/**
 * Runs a request end-to-end through the real `executeTenantMiddleware` (TASK-002)
 * and dispatches to the corresponding TASK-017 handler.
 */
async function dispatchThroughMiddleware(
  request: Request,
  options: { readonly nowMs?: number } = {},
): Promise<Response> {
  const locals: TenantMiddlewareLocals = {
    surface: "unknown",
    host: "",
    isLocalLoopback: false,
    tenant: null,
    tenantDb: null,
  };

  return executeTenantMiddleware(
    { request, locals },
    async () => {
      const pathname = new URL(request.url).pathname;
      const deps: DiscoveryHandlerDeps = {
        surface: locals.surface,
        host: locals.host,
        tenant: locals.tenant,
        tenantDb: locals.tenantDb,
        platformDb: env.PLATFORM_DB,
        tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
        platformDomain: "punyasitus.com",
        saasZone: "situsku.click",
        nowMs: options.nowMs ?? BASE_TIME + 50_000,
      };
      if (pathname === "/sitemap.xml") {
        return handleSitemapIndexRequest(request, deps);
      }
      if (pathname === "/robots.txt") {
        return handleRobotsTxtRequest(request, deps);
      }
      if (pathname === "/blog/feed.xml") {
        return handleBlogFeedRequest(request, deps);
      }
      const subMatch = /^\/sitemaps\/([^/]+)\.xml$/.exec(pathname);
      if (subMatch) {
        return handleSubSitemapRequest(request, subMatch[1], deps);
      }
      return new Response("not found", { status: 404 });
    },
    {
      APP_ENV: "production",
      PLATFORM_DOMAIN: "punyasitus.com",
      SAAS_ZONE: "situsku.click",
      PLATFORM_DB: env.PLATFORM_DB,
      TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    },
    {
      nowMs: options.nowMs ?? BASE_TIME + 50_000,
      bypassHostCache: true,
    },
  );
}

describe("TASK-017: Tenant-Scoped Sitemap, Sub-Sitemaps, Robots & Blog RSS on workerd", () => {
  let tenantDbAlpha: D1Database;
  let tenantDbBeta: D1Database;
  let tenantDbTrial: D1Database;
  let tenantDbSuspended: D1Database;
  let tenantDbRecovery: D1Database;

  let alphaHeroMediaId: number;
  let alphaGalleryMediaId: number;
  let alphaPostMediaId: number;
  let betaMediaId: number;

  let alphaPublishedPageId: number;
  let alphaPublishedPageVersion: number;
  let alphaPublishedPostId: number;
  let alphaPublishedPostVersion: number;
  let alphaPublishedOfferingId: number;
  let alphaPublishedOfferingVersion: number;

  const ALPHA_HOME_PUB_MS = BASE_TIME + 10_000;
  const ALPHA_ABOUT_PUB_MS = BASE_TIME + 11_000;
  const ALPHA_POST_PUB_MS = BASE_TIME + 12_000;
  const ALPHA_OFFERING_PUB_MS = BASE_TIME + 13_000;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);

    [tenantDbAlpha, tenantDbBeta, tenantDbTrial, tenantDbSuspended, tenantDbRecovery] =
      await Promise.all([
        seedTenantWithHost({ ...TENANT_ALPHA, status: "active" }),
        seedTenantWithHost({ ...TENANT_BETA, status: "active" }),
        seedTenantWithHost({ ...TENANT_TRIAL, status: "trial" }),
        seedTenantWithHost({ ...TENANT_SUSPENDED, status: "suspended" }),
        // Seed as active first so DO migrates and receives a published homepage, then transition to `recovery`
        seedTenantWithHost({ ...TENANT_RECOVERY, status: "active" }),
      ]);
    await seedTenantWithHost({ ...TENANT_PURGED, status: "purged" });

    // Ingest ready R2 images for Alpha & Beta
    alphaHeroMediaId = await ingestReadyTenantImage({
      tenantId: TENANT_ALPHA.id,
      tenantDb: tenantDbAlpha,
      filename: "gedung-alpha-utama.png",
      altText: 'Gedung Alpha & "Logistik" Utama',
      nowMs: BASE_TIME + 1_000,
    });
    alphaGalleryMediaId = await ingestReadyTenantImage({
      tenantId: TENANT_ALPHA.id,
      tenantDb: tenantDbAlpha,
      filename: "armada-truk-alpha.png",
      altText: "Armada Truk Logistik Alpha",
      nowMs: BASE_TIME + 1_500,
    });
    alphaPostMediaId = await ingestReadyTenantImage({
      tenantId: TENANT_ALPHA.id,
      tenantDb: tenantDbAlpha,
      filename: "artikel-konstruksi-hijau.png",
      altText: "Foto Konstruksi Hijau 2026",
      nowMs: BASE_TIME + 2_000,
    });
    betaMediaId = await ingestReadyTenantImage({
      tenantId: TENANT_BETA.id,
      tenantDb: tenantDbBeta,
      filename: "paket-raja-ampat.png",
      altText: "Wisata Bahari Raja Ampat",
      nowMs: BASE_TIME + 2_500,
    });

    // Seed unready (`quarantined`, `failed`, `processing`) images in Alpha to prove non-ready media is NEVER emitted even when referenced inline
    await tenantDbAlpha.batch([
      tenantDbAlpha
        .prepare(
          `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, variants_json, status, version, created_at, updated_at)
           VALUES (99, 'image', ?, 'image/webp', 1024, 'sha99', 800, 600, 'Quarantined Secret', NULL, 'quarantined', 1, ?, ?)`,
        )
        .bind(`t/${TENANT_ALPHA.id}/media/99/quarantined-secret.webp`, BASE_TIME, BASE_TIME),
      tenantDbAlpha
        .prepare(
          `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, variants_json, status, version, created_at, updated_at)
           VALUES (100, 'image', ?, 'image/webp', 1024, 'sha100', 800, 600, 'Failed Image', NULL, 'failed', 1, ?, ?)`,
        )
        .bind(`t/${TENANT_ALPHA.id}/media/100/failed-image.webp`, BASE_TIME, BASE_TIME),
      tenantDbAlpha
        .prepare(
          `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, variants_json, status, version, created_at, updated_at)
           VALUES (101, 'image', ?, 'image/webp', 1024, 'sha101', 800, 600, 'Processing Image', NULL, 'processing', 1, ?, ?)`,
        )
        .bind(`t/${TENANT_ALPHA.id}/media/101/processing-image.webp`, BASE_TIME, BASE_TIME),
    ]);

    // Seed published site_settings + business_profile for Alpha
    await tenantDbAlpha.batch([
      tenantDbAlpha
        .prepare(
          `INSERT INTO site_settings (id, site_title, tagline, active_theme_id, blog_enabled, catalog_enabled, ai_training_policy, version, updated_at)
           VALUES (1, 'Alpha Konstruksi & Logistik', 'Mitra B2B Nasional', 'compro', 1, 1, 'allow', 1, ?)`,
        )
        .bind(BASE_TIME),
      tenantDbAlpha
        .prepare(
          `INSERT INTO business_profile (id, business_name, business_category, whatsapp_e164, version, updated_at)
           VALUES (1, 'Alpha Konstruksi & Logistik', 'LocalBusiness', '+6281234567890', 1, ?)`,
        )
        .bind(BASE_TIME),
    ]);

    await publishResourceAtomically(env.PLATFORM_DB, tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 1,
      draftOverride: {
        siteTitle: "Alpha Konstruksi & Logistik",
        tagline: "Mitra B2B Nasional",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "compro",
        blogEnabled: true,
        catalogEnabled: true,
        aiTrainingPolicy: "allow",
        siteVisibility: "public",
      },
      nowMs: BASE_TIME + 5_000,
    });

    // Alpha pages:
    // 1. Homepage (published, with section image + OG image, then edited in draft later!)
    const alphaHome = await createPage(tenantDbAlpha, {
      title: "Beranda Alpha",
      slug: "beranda-alpha",
      isHomepage: true,
      sections: [
        {
          id: "hero-1",
          kind: "hero",
          heading: "Konstruksi B2B",
          subheading: "Standar Nasional",
          bodyHtml: "<p>Solusi pembangunan pabrik.</p>",
          media: [
            {
              url: `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ALPHA.id}/media/${alphaHeroMediaId}/gedung-alpha-utama-w1280.webp`,
              alt: "Hero Gedung Alpha",
              width: 1280,
              height: 720,
            },
            // Second verified ready inline section image (distinct from seo.ogImageMediaId)
            {
              url: `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ALPHA.id}/media/${alphaGalleryMediaId}/armada-truk-alpha-w1280.webp`,
              alt: "Inline Ready Armada Alpha",
              width: 1280,
              height: 720,
            },
            // Media CDN URL with no `/t/` prefix must be rejected!
            {
              url: `${DEFAULT_MEDIA_CDN_ORIGIN}/raw-image.webp`,
              alt: "No Prefix Leak",
              width: 1280,
              height: 720,
            },
            // Percent-encoded foreign path (`/%74/...`) must be rejected!
            {
              url: `${DEFAULT_MEDIA_CDN_ORIGIN}/%74/${TENANT_BETA.id}/media/${betaMediaId}/paket-raja-ampat-w1280.webp`,
              alt: "Encoded Foreign Leak",
              width: 1280,
              height: 720,
            },
            // Direct cross-tenant image URL injected in section media must be filtered out!
            {
              url: `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_BETA.id}/media/${betaMediaId}/paket-raja-ampat-w1280.webp`,
              alt: "Foreign Beta Leak",
              width: 1280,
              height: 720,
            },
            // Own-tenant `quarantined` / `failed` / `processing` media rows referenced inline must be rejected!
            {
              url: `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ALPHA.id}/media/99/quarantined-secret.webp`,
              alt: "Quarantined Inline",
              width: 800,
              height: 600,
            },
            {
              url: `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ALPHA.id}/media/100/failed-image.webp`,
              alt: "Failed Inline",
              width: 800,
              height: 600,
            },
            {
              url: `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ALPHA.id}/media/101/processing-image.webp`,
              alt: "Processing Inline",
              width: 800,
              height: 600,
            },
            // Own-tenant fabricated URL with no matching `media_items` row must be rejected!
            {
              url: `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ALPHA.id}/media/777/does-not-exist.webp`,
              alt: "Unregistered Inline",
              width: 800,
              height: 600,
            },
          ],
        },
      ],
      seo: { ogImageMediaId: alphaHeroMediaId },
      nowMs: BASE_TIME + 6_000,
    });
    const pubHome = await publishPage(env.PLATFORM_DB, tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
      pageId: alphaHome.id,
      expectedVersion: alphaHome.version,
      nowMs: ALPHA_HOME_PUB_MS,
    });

    // Save unpublished draft edit on homepage with MUCH LATER timestamp — must NOT leak to <lastmod> or <loc>!
    await saveDraftResource(tenantDbAlpha, {
      resourceType: "page",
      resourceId: alphaHome.id,
      expectedVersion: pubHome.page.version,
      draft: {
        slug: "beranda-alpha",
        title: "DRAF BERANDA RAHASIA",
        isHomepage: true,
        layoutMode: "standard",
        sections: [],
      },
      nowMs: BASE_TIME + 99_999,
    });

    // 2. Normal published page whose slug was renamed AFTER publishing (creates former slug `tentang-lama` is_current = 0!)
    const alphaAbout = await createPage(tenantDbAlpha, {
      title: "Tentang Alpha",
      slug: "tentang-lama",
      nowMs: BASE_TIME + 6_200,
    });
    const pubAbout1 = await publishPage(env.PLATFORM_DB, tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
      pageId: alphaAbout.id,
      expectedVersion: alphaAbout.version,
      nowMs: BASE_TIME + 10_500,
    });
    const renamedAbout = await updatePage(
      tenantDbAlpha,
      {
        pageId: alphaAbout.id,
        expectedVersion: pubAbout1.page.version,
        slug: "tentang-kami",
        confirmSlugChange: true,
        nowMs: BASE_TIME + 10_800,
      },
      { platformDb: env.PLATFORM_DB, tenantId: TENANT_ALPHA.id },
    );
    const pubAbout2 = await publishPage(env.PLATFORM_DB, tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
      pageId: alphaAbout.id,
      expectedVersion: renamedAbout.version,
      nowMs: ALPHA_ABOUT_PUB_MS,
    });
    alphaPublishedPageId = alphaAbout.id;
    alphaPublishedPageVersion = pubAbout2.page.version;

    // 3. Published page with `noindex: true` — MUST be excluded from sitemap!
    const alphaNoindexPage = await createPage(tenantDbAlpha, {
      title: "Halaman Internal Noindex",
      slug: "internal-noindex",
      seo: { noindex: true },
      nowMs: BASE_TIME + 6_300,
    });
    await publishPage(env.PLATFORM_DB, tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
      pageId: alphaNoindexPage.id,
      expectedVersion: alphaNoindexPage.version,
      nowMs: BASE_TIME + 11_200,
    });

    // 4. Draft-only page — MUST be excluded from sitemap!
    await createPage(tenantDbAlpha, {
      title: "Halaman Draf Belum Terbit",
      slug: "halaman-draf-rahasia",
      nowMs: BASE_TIME + 6_400,
    });

    // Alpha posts:
    // 1. Published post with featured cover image + in-content image, then edited in draft later!
    const alphaPost = await createPost(tenantDbAlpha, {
      title: 'Standar Konstruksi Hijau & "Efisien" 2026',
      slug: "konstruksi-hijau-2026",
      excerpt: "Panduan praktis membangun gedung hemat energi.",
      body: {
        schemaVersion: 1,
        blocks: [
          { type: "paragraph", text: "Konstruksi hijau menekan biaya operasional." },
          { type: "image", mediaId: alphaGalleryMediaId },
        ],
      },
      coverMediaId: alphaPostMediaId,
      nowMs: BASE_TIME + 7_000,
    });
    const pubPost = await publishPost(env.PLATFORM_DB, tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
      postId: alphaPost.id,
      expectedVersion: alphaPost.version,
      nowMs: ALPHA_POST_PUB_MS,
    });
    // Draft edit on published post MUST NOT leak to sitemap lastmod or RSS title/excerpt!
    const draftEditedPost = await updatePost(tenantDbAlpha, {
      postId: alphaPost.id,
      expectedVersion: pubPost.post.version,
      title: "DRAF JUDUL ARTIKEL RAHASIA",
      excerpt: "DRAF RINGKASAN RAHASIA",
      nowMs: BASE_TIME + 95_000,
    });
    alphaPublishedPostId = alphaPost.id;
    alphaPublishedPostVersion = draftEditedPost.version;

    // 2. Published post with `noindex: true` — MUST be excluded from sitemap AND RSS feed!
    const alphaNoindexPost = await createPost(tenantDbAlpha, {
      title: "Artikel Rahasia Noindex",
      slug: "artikel-rahasia-noindex",
      excerpt: "Tidak boleh muncul di sitemap maupun feed.",
      body: {
        schemaVersion: 1,
        blocks: [{ type: "paragraph", text: "Konten noindex." }],
      },
      seo: { noindex: true },
      nowMs: BASE_TIME + 7_100,
    });
    await publishPost(env.PLATFORM_DB, tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
      postId: alphaNoindexPost.id,
      expectedVersion: alphaNoindexPost.version,
      nowMs: BASE_TIME + 12_500,
    });

    // 3. Draft-only post — MUST NEVER appear!
    await createPost(tenantDbAlpha, {
      title: "Artikel Draf Saja",
      slug: "artikel-draf-saja",
      body: {
        schemaVersion: 1,
        blocks: [{ type: "paragraph", text: "Belum diterbitkan." }],
      },
      nowMs: BASE_TIME + 7_200,
    });

    // Alpha offering (service) with cover + gallery images
    const alphaOffering = await createCatalogOffering(
      tenantDbAlpha,
      {
        offeringType: "service",
        title: "Jasa Renovasi Gudang Industri",
        slug: "renovasi-gudang-industri",
        summary: "Renovasi menyeluruh untuk gudang logistik.",
        description: {
          schemaVersion: 1,
          blocks: [{ type: "paragraph", text: "Pengerjaan cepat dan terukur." }],
        },
        coverMediaId: alphaHeroMediaId,
        galleryMediaIds: [alphaGalleryMediaId],
        priceMode: "from",
        price: 150_000_000,
        ctaKind: "whatsapp",
      },
      { nowMs: BASE_TIME + 8_000 },
    );
    const pubOffering = await publishCatalogOffering(env.PLATFORM_DB, tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
      offeringId: alphaOffering.id,
      expectedVersion: alphaOffering.version,
      nowMs: ALPHA_OFFERING_PUB_MS,
    });
    // Draft edit on published offering must NOT change sitemap lastmod!
    const draftEditedOffering = await updateCatalogOffering(
      tenantDbAlpha,
      alphaOffering.id,
      { title: "DRAF JUDUL LAYANAN" },
      { expectedVersion: pubOffering.offering.version, nowMs: BASE_TIME + 96_000 },
    );
    alphaPublishedOfferingId = alphaOffering.id;
    alphaPublishedOfferingVersion = draftEditedOffering.version;

    // Seed Beta tenant (isolated DO) with its own settings, page, 25 published posts (to verify 20-item RSS cap!), and tour offering
    await tenantDbBeta.batch([
      tenantDbBeta
        .prepare(
          `INSERT INTO site_settings (id, site_title, tagline, active_theme_id, blog_enabled, catalog_enabled, ai_training_policy, version, updated_at)
           VALUES (1, 'Beta Wisata Nusantara', 'Trip Terbaik Indonesia', 'travel', 1, 1, 'disallow', 1, ?)`,
        )
        .bind(BASE_TIME),
      tenantDbBeta
        .prepare(
          `INSERT INTO business_profile (id, business_name, business_category, whatsapp_e164, version, updated_at)
           VALUES (1, 'Beta Wisata Nusantara', 'TravelAgency', '+6281999998888', 1, ?)`,
        )
        .bind(BASE_TIME),
    ]);

    await publishResourceAtomically(env.PLATFORM_DB, tenantDbBeta, {
      tenantId: TENANT_BETA.id,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 1,
      draftOverride: {
        siteTitle: "Beta Wisata Nusantara",
        tagline: "Trip Terbaik Indonesia",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "travel",
        blogEnabled: true,
        catalogEnabled: true,
        aiTrainingPolicy: "disallow",
        siteVisibility: "public",
      },
      nowMs: BASE_TIME + 5_000,
    });

    const betaHome = await createPage(tenantDbBeta, {
      title: "Beranda Beta Wisata",
      slug: "beranda-beta",
      isHomepage: true,
      nowMs: BASE_TIME + 6_000,
    });
    await publishPage(env.PLATFORM_DB, tenantDbBeta, {
      tenantId: TENANT_BETA.id,
      pageId: betaHome.id,
      expectedVersion: betaHome.version,
      nowMs: BASE_TIME + 10_000,
    });

    const betaTour = await createCatalogOffering(
      tenantDbBeta,
      {
        offeringType: "tour",
        title: "Paket Wisata Raja Ampat 4H3M",
        slug: "paket-raja-ampat-4h3m",
        summary: "Eksplorasi kepulauan Raja Ampat.",
        description: {
          schemaVersion: 1,
          blocks: [{ type: "paragraph", text: "Termasuk kapal dan penginapan." }],
        },
        coverMediaId: betaMediaId,
        priceMode: "fixed",
        price: 8_500_000,
        ctaKind: "whatsapp",
      },
      { nowMs: BASE_TIME + 6_500 },
    );
    await publishCatalogOffering(env.PLATFORM_DB, tenantDbBeta, {
      tenantId: TENANT_BETA.id,
      offeringId: betaTour.id,
      expectedVersion: betaTour.version,
      nowMs: BASE_TIME + 11_000,
    });

    // Seed 25 published posts in Beta to prove `/blog/feed.xml` caps at latest 20 ordered by published_at DESC!
    for (let i = 1; i <= 25; i += 1) {
      const post = await createPost(tenantDbBeta, {
        title: `Panduan Wisata #${String(i).padStart(2, "0")}`,
        slug: `panduan-wisata-${String(i).padStart(2, "0")}`,
        excerpt: `Ringkasan destinasi wisata ke-${i}.`,
        body: {
          schemaVersion: 1,
          blocks: [{ type: "paragraph", text: `Isi artikel panduan wisata #${i}.` }],
        },
        coverMediaId: i === 25 ? betaMediaId : null,
        nowMs: BASE_TIME + 15_000 + i * 100,
      });
      await publishPost(env.PLATFORM_DB, tenantDbBeta, {
        tenantId: TENANT_BETA.id,
        postId: post.id,
        expectedVersion: post.version,
        nowMs: BASE_TIME + 20_000 + i * 1_000,
      });
    }

    // Seed published homepage in Trial, Suspended, and Recovery tenants to prove gate enforcement
    for (const [tenantSpec, db] of [
      [TENANT_TRIAL, tenantDbTrial],
      [TENANT_SUSPENDED, tenantDbSuspended],
      [TENANT_RECOVERY, tenantDbRecovery],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO site_settings (id, site_title, active_theme_id, blog_enabled, catalog_enabled, version, updated_at)
           VALUES (1, ?, 'compro', 1, 1, 1, ?)`,
        )
        .bind(tenantSpec.name, BASE_TIME)
        .run();
      await publishResourceAtomically(env.PLATFORM_DB, db, {
        tenantId: tenantSpec.id,
        resourceType: "site_settings",
        resourceId: 1,
        expectedVersion: 1,
        nowMs: BASE_TIME + 5_000,
      });
      const home = await createPage(db, {
        title: `Beranda ${tenantSpec.name}`,
        slug: "beranda",
        isHomepage: true,
        nowMs: BASE_TIME + 6_000,
      });
      await publishPage(env.PLATFORM_DB, db, {
        tenantId: tenantSpec.id,
        pageId: home.id,
        expectedVersion: home.version,
        nowMs: BASE_TIME + 7_000,
      });
    }

    // Transition recovery tenant to `recovery` status after seeding its published homepage
    await env.PLATFORM_DB.prepare(
      `UPDATE tenants SET status = 'recovery', version = version + 1 WHERE id = ?`,
    )
      .bind(TENANT_RECOVERY.id)
      .run();
  });

  beforeEach(() => {
    clearHostResolutionCache();
  });

  it("serves valid XML sitemap index and sub-sitemaps on verified primary origin with images, published lastmod, and strict exclusions", async () => {
    // 1. Sitemap Index on Alpha's verified custom domain via middleware
    const indexRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemap.xml`),
    );
    expect(indexRes.status).toBe(200);
    expect(indexRes.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(indexRes.headers.get("cache-control")).toContain("public");
    expect(indexRes.headers.get("x-punyasitus-cache-version")).toBeTruthy();

    const indexXml = await indexRes.text();
    const indexRoot = parseStrictXml(indexXml);
    expect(indexRoot.name).toBe("sitemapindex");
    const sitemapNodes = getChildElements(indexRoot, "sitemap");
    const sitemapLocs = sitemapNodes.map((n) => getFirstChildText(n, "loc"));
    expect(sitemapLocs).toEqual([
      `https://${TENANT_ALPHA.customDomain}/sitemaps/pages.xml`,
      `https://${TENANT_ALPHA.customDomain}/sitemaps/posts.xml`,
      `https://${TENANT_ALPHA.customDomain}/sitemaps/offerings.xml`,
    ]);
    // Must NEVER emit subdomain alias or Beta URLs
    expect(indexXml).not.toContain(TENANT_ALPHA.subdomain);
    expect(indexXml).not.toContain(TENANT_BETA.subdomain);

    // 2. Pages sub-sitemap
    const pagesRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemaps/pages.xml`),
    );
    expect(pagesRes.status).toBe(200);
    const pagesXml = await pagesRes.text();
    const pagesRoot = parseStrictXml(pagesXml);
    const pageUrls = getChildElements(pagesRoot, "url");
    const pageLocs = pageUrls.map((u) => getFirstChildText(u, "loc"));

    // Homepage uses `/` (never `/beranda-alpha`); renamed page uses `/tentang-kami` (never former slug `/tentang-lama`)
    expect(pageLocs).toEqual([
      `https://${TENANT_ALPHA.customDomain}/`,
      `https://${TENANT_ALPHA.customDomain}/tentang-kami`,
    ]);
    expect(pagesXml).not.toContain("/beranda-alpha");
    expect(pagesXml).not.toContain("/tentang-lama");
    expect(pagesXml).not.toContain("/internal-noindex");
    expect(pagesXml).not.toContain("/halaman-draf-rahasia");
    expect(pagesXml).not.toContain("DRAF BERANDA RAHASIA");

    // Verify published snapshot lastmod (NOT the newer draft save at BASE_TIME + 99_999!)
    expect(getFirstChildText(pageUrls[0]!, "lastmod")).toBe(
      new Date(ALPHA_HOME_PUB_MS).toISOString(),
    );
    expect(getFirstChildText(pageUrls[1]!, "lastmod")).toBe(
      new Date(ALPHA_ABOUT_PUB_MS).toISOString(),
    );

    // Verify `<image:image>` entries on homepage include ONLY Alpha's two verified ready images
    // and reject no-prefix, percent-encoded foreign, direct foreign, quarantined/failed/processing, and unregistered URLs
    const homeImages = getChildElements(pageUrls[0]!, "image:image");
    expect(homeImages).toHaveLength(2);
    expect(homeImages.map((img) => getFirstChildText(img, "image:loc"))).toEqual([
      `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ALPHA.id}/media/${alphaHeroMediaId}/gedung-alpha-utama-w1280.webp`,
      `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ALPHA.id}/media/${alphaGalleryMediaId}/armada-truk-alpha-w1280.webp`,
    ]);
    expect(pagesXml).not.toContain(TENANT_BETA.id);
    expect(pagesXml).not.toContain("raw-image.webp");
    expect(pagesXml).not.toContain("%74");
    expect(pagesXml).not.toContain("quarantined-secret.webp");
    expect(pagesXml).not.toContain("failed-image.webp");
    expect(pagesXml).not.toContain("processing-image.webp");
    expect(pagesXml).not.toContain("does-not-exist.webp");

    // 3. Posts sub-sitemap (includes non-empty `/blog` archive + published post with cover & in-content images)
    const postsRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemaps/posts.xml`),
    );
    expect(postsRes.status).toBe(200);
    const postsXml = await postsRes.text();
    const postsRoot = parseStrictXml(postsXml);
    const postUrls = getChildElements(postsRoot, "url");
    expect(postUrls.map((u) => getFirstChildText(u, "loc"))).toEqual([
      `https://${TENANT_ALPHA.customDomain}/blog`,
      `https://${TENANT_ALPHA.customDomain}/blog/konstruksi-hijau-2026`,
    ]);
    expect(postsXml).not.toContain("artikel-rahasia-noindex");
    expect(postsXml).not.toContain("artikel-draf-saja");
    expect(postsXml).not.toContain("?page=2");

    // Verify post lastmod matches published snapshot (NOT draft edit at BASE_TIME + 95_000!)
    expect(getFirstChildText(postUrls[1]!, "lastmod")).toBe(
      new Date(ALPHA_POST_PUB_MS).toISOString(),
    );
    // Verify featured + in-content images are emitted and XML-escaped
    const postImages = getChildElements(postUrls[1]!, "image:image");
    expect(postImages).toHaveLength(2);
    expect(postImages.map((img) => getFirstChildText(img, "image:loc"))).toEqual([
      `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ALPHA.id}/media/${alphaPostMediaId}/artikel-konstruksi-hijau-w1280.webp`,
      `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ALPHA.id}/media/${alphaGalleryMediaId}/armada-truk-alpha-w1280.webp`,
    ]);

    // 4. Offerings sub-sitemap (includes `/layanan` non-empty archive + service detail; excludes empty `/produk`, `/tour`, `/kendaraan` & faceted filters)
    const offeringsRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemaps/offerings.xml`),
    );
    expect(offeringsRes.status).toBe(200);
    const offeringsXml = await offeringsRes.text();
    const offeringsRoot = parseStrictXml(offeringsXml);
    const offeringUrls = getChildElements(offeringsRoot, "url");
    expect(offeringUrls.map((u) => getFirstChildText(u, "loc"))).toEqual([
      `https://${TENANT_ALPHA.customDomain}/layanan`,
      `https://${TENANT_ALPHA.customDomain}/layanan/renovasi-gudang-industri`,
    ]);
    expect(getFirstChildText(offeringUrls[1]!, "lastmod")).toBe(
      new Date(ALPHA_OFFERING_PUB_MS).toISOString(),
    );
    expect(offeringsXml).not.toContain("/produk");
    expect(offeringsXml).not.toContain("/kendaraan");
    const offeringImages = getChildElements(offeringUrls[1]!, "image:image");
    expect(offeringImages).toHaveLength(2);
    expect(getFirstChildText(offeringImages[0]!, "image:title")).toBe(
      'Gedung Alpha & "Logistik" Utama',
    );

    // 5. HEAD request returns same status/headers with empty body
    const headRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemap.xml`, { method: "HEAD" }),
    );
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await headRes.text()).toBe("");
  });

  it("redirects alias host 301 to verified primary origin and strictly isolates two tenants + unknown/platform hosts", async () => {
    // 1. Alias host (`t017-alpha.situsku.click`) -> 301 redirect to `https://www.t017-alpha.id/sitemap.xml`
    const aliasMwRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.subdomain}/sitemap.xml`),
    );
    expect(aliasMwRes.status).toBe(301);
    expect(aliasMwRes.headers.get("location")).toBe(
      `https://${TENANT_ALPHA.customDomain}/sitemap.xml`,
    );

    // Direct handler invocation on alias host also 301 redirects (never serves alias sitemap copy)
    const aliasDirectRes = await handleSitemapIndexRequest(
      new Request(`https://${TENANT_ALPHA.subdomain}/sitemap.xml`),
      makeRuntimeDiscoveryDeps(),
    );
    expect(aliasDirectRes.status).toBe(301);
    expect(aliasDirectRes.headers.get("location")).toBe(
      `https://${TENANT_ALPHA.customDomain}/sitemap.xml`,
    );

    // 2. Two-tenant isolation: Beta's sitemap contains ONLY Beta's URLs, never Alpha's
    const betaPagesRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_BETA.subdomain}/sitemaps/pages.xml`),
    );
    expect(betaPagesRes.status).toBe(200);
    const betaPagesXml = await betaPagesRes.text();
    const betaPagesRoot = parseStrictXml(betaPagesXml);
    expect(
      getChildElements(betaPagesRoot, "url").map((u) => getFirstChildText(u, "loc")),
    ).toEqual([`https://${TENANT_BETA.subdomain}/`]);
    expect(betaPagesXml).not.toContain(TENANT_ALPHA.customDomain);
    expect(betaPagesXml).not.toContain("tentang-kami");

    const betaOfferingsRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_BETA.subdomain}/sitemaps/offerings.xml`),
    );
    const betaOfferingsXml = await betaOfferingsRes.text();
    expect(betaOfferingsXml).toContain(`https://${TENANT_BETA.subdomain}/tour/paket-raja-ampat-4h3m`);
    expect(betaOfferingsXml).not.toContain("renovasi-gudang-industri");

    // 3. Unknown host + forged X-Forwarded-Host / X-Tenant-ID NEVER receives any tenant's sitemap or feed!
    const forgedSitemapReq = new Request("https://evil-attacker.example.com/sitemap.xml", {
      headers: {
        "X-Forwarded-Host": TENANT_ALPHA.customDomain,
        "X-Tenant-ID": TENANT_ALPHA.id,
      },
    });
    const forgedMwRes = await dispatchThroughMiddleware(forgedSitemapReq);
    expect(forgedMwRes.status).toBe(404);
    const forgedMwBody = await forgedMwRes.text();
    expect(forgedMwBody).not.toContain(TENANT_ALPHA.customDomain);
    expect(forgedMwBody).not.toContain(TENANT_BETA.subdomain);

    const forgedDirectSitemap = await handleSitemapIndexRequest(
      forgedSitemapReq,
      makeRuntimeDiscoveryDeps(),
    );
    expect(forgedDirectSitemap.status).toBe(404);
    expect(await forgedDirectSitemap.text()).not.toContain(TENANT_ALPHA.customDomain);

    const forgedDirectFeed = await handleBlogFeedRequest(
      new Request("https://unknown-sub.situsku.click/blog/feed.xml", {
        headers: { "X-Forwarded-Host": TENANT_BETA.subdomain },
      }),
      makeRuntimeDiscoveryDeps(),
    );
    expect(forgedDirectFeed.status).toBe(404);
    expect(await forgedDirectFeed.text()).not.toContain("panduan-wisata");

    // 4. Platform hosts (`app.punyasitus.com`, `console.punyasitus.com`, `punyasitus.com`) NEVER leak tenant sitemaps/feeds
    for (const host of ["app.punyasitus.com", "console.punyasitus.com", "punyasitus.com"]) {
      const smRes = await dispatchThroughMiddleware(new Request(`https://${host}/sitemap.xml`));
      expect(smRes.status).toBe(404);
      const smBody = await smRes.text();
      expect(smBody).not.toContain(TENANT_ALPHA.customDomain);
      expect(smBody).not.toContain(TENANT_BETA.subdomain);
    }
  });

  it("caps /blog/feed.xml at latest 20 published posts ordered by published_at DESC and returns 404 when blog is disabled", async () => {
    // 1. Alpha's RSS feed uses published snapshot title/excerpt (never draft edit) and excludes noindex/draft posts
    const alphaFeedRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/feed.xml`),
    );
    expect(alphaFeedRes.status).toBe(200);
    expect(alphaFeedRes.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    const alphaFeedXml = await alphaFeedRes.text();
    const alphaFeedRoot = parseStrictXml(alphaFeedXml);
    const alphaChannel = getChildElements(alphaFeedRoot, "channel")[0]!;
    const alphaItems = getChildElements(alphaChannel, "item");
    expect(alphaItems).toHaveLength(1);
    expect(getFirstChildText(alphaItems[0]!, "title")).toBe(
      'Standar Konstruksi Hijau & "Efisien" 2026',
    );
    expect(getFirstChildText(alphaItems[0]!, "link")).toBe(
      `https://${TENANT_ALPHA.customDomain}/blog/konstruksi-hijau-2026`,
    );
    expect(getFirstChildText(alphaItems[0]!, "pubDate")).toBe(
      new Date(ALPHA_POST_PUB_MS).toUTCString(),
    );
    expect(alphaFeedXml).not.toContain("DRAF JUDUL ARTIKEL RAHASIA");
    expect(alphaFeedXml).not.toContain("artikel-rahasia-noindex");
    expect(alphaFeedXml).not.toContain("artikel-draf-saja");

    // 2. Beta has 25 published posts -> RSS feed returns strictly the latest 20 (#25 down to #06)
    const betaFeedRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_BETA.subdomain}/blog/feed.xml`),
    );
    expect(betaFeedRes.status).toBe(200);
    const betaFeedXml = await betaFeedRes.text();
    const betaRoot = parseStrictXml(betaFeedXml);
    const betaChannel = getChildElements(betaRoot, "channel")[0]!;
    const betaItems = getChildElements(betaChannel, "item");
    expect(betaItems).toHaveLength(20);
    expect(getFirstChildText(betaItems[0]!, "link")).toBe(
      `https://${TENANT_BETA.subdomain}/blog/panduan-wisata-25`,
    );
    expect(getFirstChildText(betaItems[19]!, "link")).toBe(
      `https://${TENANT_BETA.subdomain}/blog/panduan-wisata-06`,
    );
    // Older posts #01..#05 must not appear
    expect(betaFeedXml).not.toContain("panduan-wisata-05");
    expect(betaFeedXml).not.toContain("panduan-wisata-01");
    // Featured cover image enclosure present on post #25
    const enclosures = getChildElements(betaItems[0]!, "enclosure");
    expect(enclosures).toHaveLength(1);
    expect(enclosures[0]!.attributes.url).toContain(`/t/${TENANT_BETA.id}/media/${betaMediaId}/`);

    // 3. Disable blog on Beta (publish site_settings with blogEnabled: false) -> /blog/feed.xml AND /sitemaps/posts.xml return 404!
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbBeta, {
      tenantId: TENANT_BETA.id,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 2,
      draftOverride: {
        siteTitle: "Beta Wisata Nusantara",
        tagline: "Trip Terbaik Indonesia",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "travel",
        blogEnabled: false,
        catalogEnabled: true,
        aiTrainingPolicy: "disallow",
        siteVisibility: "public",
      },
      nowMs: BASE_TIME + 55_000,
    });
    clearHostResolutionCache();

    const disabledFeedRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_BETA.subdomain}/blog/feed.xml`),
      { nowMs: BASE_TIME + 56_000 },
    );
    expect(disabledFeedRes.status).toBe(404);
    expect(disabledFeedRes.headers.get("cache-control")).toBe("no-store");

    const disabledPostsSitemap = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_BETA.subdomain}/sitemaps/posts.xml`),
      { nowMs: BASE_TIME + 56_000 },
    );
    expect(disabledPostsSitemap.status).toBe(404);

    const betaIndexAfterDisable = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_BETA.subdomain}/sitemap.xml`),
      { nowMs: BASE_TIME + 56_000 },
    );
    expect(betaIndexAfterDisable.status).toBe(200);
    expect(await betaIndexAfterDisable.text()).not.toContain("/sitemaps/posts.xml");
  });

  it("serves tenant-scoped /robots.txt across active paid (allow vs disallow AI training), trial, suspended, recovery, purged, and unknown hosts", async () => {
    // 1. Alpha: Active paid with `aiTrainingPolicy: "allow"` -> allows search/AI fetchers + training crawlers, disallows faceted filters, emits primary Sitemap
    const alphaRobotsRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/robots.txt`),
    );
    expect(alphaRobotsRes.status).toBe(200);
    expect(alphaRobotsRes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const alphaRobots = await alphaRobotsRes.text();
    for (const bot of ALLOWED_SEARCH_AND_AI_FETCHERS) {
      expect(alphaRobots).toContain(`User-agent: ${bot}`);
    }
    for (const pattern of FACETED_FILTER_DISALLOW_PATTERNS) {
      expect(alphaRobots).toContain(`Disallow: ${pattern}`);
    }
    expect(alphaRobots).toContain(`Sitemap: https://${TENANT_ALPHA.customDomain}/sitemap.xml`);
    // Training crawlers allowed when aiTrainingPolicy === "allow"
    const alphaGptIdx = alphaRobots.indexOf("User-agent: GPTBot");
    expect(alphaGptIdx).toBeGreaterThan(-1);
    expect(alphaRobots.slice(alphaGptIdx, alphaGptIdx + 120)).toContain("Allow: /");

    // 2. Beta: Active paid with `aiTrainingPolicy: "disallow"` -> disallows training-only AI crawlers, still allows search/AI fetchers & emits Sitemap
    const betaRobotsRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_BETA.subdomain}/robots.txt`),
    );
    expect(betaRobotsRes.status).toBe(200);
    const betaRobots = await betaRobotsRes.text();
    for (const bot of AI_TRAINING_ONLY_CRAWLERS) {
      expect(betaRobots).toContain(`User-agent: ${bot}`);
    }
    const betaGptIdx = betaRobots.indexOf("User-agent: GPTBot");
    expect(betaRobots.slice(betaGptIdx, betaGptIdx + 120)).toContain("Disallow: /");
    expect(betaRobots).toContain(`Sitemap: https://${TENANT_BETA.subdomain}/sitemap.xml`);

    // 3. Trial tenant -> /robots.txt emits `Disallow: /` with NO Sitemap:; /sitemap.xml returns 404!
    const trialRobotsRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_TRIAL.subdomain}/robots.txt`),
    );
    expect(trialRobotsRes.status).toBe(200);
    expect(trialRobotsRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(trialRobotsRes.headers.get("cache-control")).toBe("no-store");
    const trialRobots = await trialRobotsRes.text();
    expect(trialRobots).toContain("Disallow: /");
    expect(trialRobots).not.toContain("Sitemap:");

    const trialSitemapRes = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_TRIAL.subdomain}/sitemap.xml`),
    );
    expect(trialSitemapRes.status).toBe(404);
    expect(trialSitemapRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(trialSitemapRes.headers.get("cache-control")).toBe("no-store");

    // 4. Suspended & Recovery tenants -> 503 with no-store, noindex, Disallow: /, NO Sitemap, NO cached tenant URLs
    for (const host of [TENANT_SUSPENDED.subdomain, TENANT_RECOVERY.subdomain]) {
      const suspRobots = await handleRobotsTxtRequest(
        new Request(`https://${host}/robots.txt`),
        makeRuntimeDiscoveryDeps(),
      );
      expect(suspRobots.status).toBe(503);
      expect(suspRobots.headers.get("cache-control")).toBe("no-store");
      expect(suspRobots.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      const body = await suspRobots.text();
      expect(body).toContain("Disallow: /");
      expect(body).not.toContain("Sitemap:");

      const suspSitemap = await handleSitemapIndexRequest(
        new Request(`https://${host}/sitemap.xml`),
        makeRuntimeDiscoveryDeps(),
      );
      expect(suspSitemap.status).toBe(503);
      expect(suspSitemap.headers.get("cache-control")).toBe("no-store");
      expect(await suspSitemap.text()).not.toContain("<loc>");
    }

    // 5. Purged / destroyed & unknown hosts -> 404 with Disallow: /, NO Sitemap
    for (const host of [TENANT_PURGED.subdomain, "does-not-exist.example.com"]) {
      const res = await handleRobotsTxtRequest(
        new Request(`https://${host}/robots.txt`),
        makeRuntimeDiscoveryDeps(),
      );
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain("Disallow: /");
      expect(body).not.toContain("Sitemap:");
    }
  });

  it("immediately removes unpublished pages, posts, and offerings from sitemaps and RSS feed, and honors chunking + seo-ai-autopilot toggle", async () => {
    // Unpublish Alpha's `/tentang-kami` page, `/blog/konstruksi-hijau-2026` post, and `/layanan/renovasi-gudang-industri` offering
    const [unpubPageRes, unpubPostRes, unpubOffRes] = await Promise.all([
      unpublishPage(env.PLATFORM_DB, tenantDbAlpha, {
        tenantId: TENANT_ALPHA.id,
        pageId: alphaPublishedPageId,
        expectedVersion: alphaPublishedPageVersion,
        nowMs: BASE_TIME + 70_000,
      }),
      unpublishPost(env.PLATFORM_DB, tenantDbAlpha, {
        tenantId: TENANT_ALPHA.id,
        postId: alphaPublishedPostId,
        expectedVersion: alphaPublishedPostVersion,
        nowMs: BASE_TIME + 70_100,
      }),
      unpublishCatalogOffering(env.PLATFORM_DB, tenantDbAlpha, {
        tenantId: TENANT_ALPHA.id,
        offeringId: alphaPublishedOfferingId,
        expectedVersion: alphaPublishedOfferingVersion,
        nowMs: BASE_TIME + 70_200,
      }),
    ]);

    expect(unpubPageRes.cacheVersion).toBeGreaterThan(1);
    expect(unpubPostRes.cacheVersion).toBeGreaterThan(1);
    expect(unpubOffRes.cacheVersion).toBeGreaterThan(1);
    clearHostResolutionCache();

    // 1. Sitemap index now lists ONLY `pages.xml` (posts & offerings became empty!)
    const indexAfter = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemap.xml`),
      { nowMs: BASE_TIME + 71_000 },
    );
    expect(indexAfter.status).toBe(200);
    const indexAfterXml = await indexAfter.text();
    const indexAfterRoot = parseStrictXml(indexAfterXml);
    expect(
      getChildElements(indexAfterRoot, "sitemap").map((s) => getFirstChildText(s, "loc")),
    ).toEqual([`https://${TENANT_ALPHA.customDomain}/sitemaps/pages.xml`]);

    // 2. Pages sub-sitemap no longer contains `/tentang-kami`
    const pagesAfter = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemaps/pages.xml`),
      { nowMs: BASE_TIME + 71_000 },
    );
    const pagesAfterXml = await pagesAfter.text();
    expect(pagesAfterXml).toContain(`https://${TENANT_ALPHA.customDomain}/`);
    expect(pagesAfterXml).not.toContain("/tentang-kami");

    // 3. Posts & offerings sub-sitemaps are empty valid XML (empty archives excluded!)
    const postsAfter = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemaps/posts.xml`),
      { nowMs: BASE_TIME + 71_000 },
    );
    expect(postsAfter.status).toBe(200);
    const postsAfterRoot = parseStrictXml(await postsAfter.text());
    expect(getChildElements(postsAfterRoot, "url")).toHaveLength(0);

    const offeringsAfter = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemaps/offerings.xml`),
      { nowMs: BASE_TIME + 71_000 },
    );
    expect(offeringsAfter.status).toBe(200);
    const offeringsAfterRoot = parseStrictXml(await offeringsAfter.text());
    expect(getChildElements(offeringsAfterRoot, "url")).toHaveLength(0);

    // 4. RSS feed immediately removed the unpublished post
    const feedAfter = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/feed.xml`),
      { nowMs: BASE_TIME + 71_000 },
    );
    expect(feedAfter.status).toBe(200);
    const feedAfterRoot = parseStrictXml(await feedAfter.text());
    const channelAfter = getChildElements(feedAfterRoot, "channel")[0]!;
    expect(getChildElements(channelAfter, "item")).toHaveLength(0);

    // 5. Out-of-range chunk & invalid sub-sitemap return 404
    const oobChunk = await handleSubSitemapRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemaps/pages-99.xml`),
      "pages-99",
      makeRuntimeDiscoveryDeps({ nowMs: BASE_TIME + 71_000 }),
    );
    expect(oobChunk.status).toBe(404);

    // 6. Disabling `seo-ai-autopilot` plugin (`REQ-066`) + bumping tenant cache_version makes `/sitemap.xml` return 404 while `/robots.txt` stays safe without Sitemap:
    await tenantDbAlpha
      .prepare(
        `INSERT INTO installed_plugins (plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at)
         VALUES ('seo-ai-autopilot', '1.0.0', 0, '{}', 1, ?, ?)`,
      )
      .bind(BASE_TIME, BASE_TIME + 72_000)
      .run();
    await bumpTenantCacheVersion(env.PLATFORM_DB, TENANT_ALPHA.id, BASE_TIME + 72_000);
    clearHostResolutionCache();

    const sitemapPluginOff = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemap.xml`),
      { nowMs: BASE_TIME + 73_000 },
    );
    expect(sitemapPluginOff.status).toBe(404);

    const robotsPluginOff = await dispatchThroughMiddleware(
      new Request(`https://${TENANT_ALPHA.customDomain}/robots.txt`),
      { nowMs: BASE_TIME + 73_000 },
    );
    expect(robotsPluginOff.status).toBe(200);
    const robotsPluginOffBody = await robotsPluginOff.text();
    expect(robotsPluginOffBody).toContain("Disallow: /api/");
    expect(robotsPluginOffBody).not.toContain("Sitemap:");
  });

  it("M1-FU-05: fails closed with 503 no-store on TenantStore DB outages and includes opted-in taxonomy archives", async () => {
    // 1. Fail-closed 503 Retry-After: 60 no-store noindex when TenantStore DB throws
    const failingTenantDb = {
      prepare() {
        return {
          bind() {
            return this;
          },
          first: async () => {
            throw new Error("D1_ERROR: simulated TenantStore outage");
          },
          all: async () => {
            throw new Error("D1_ERROR: simulated TenantStore outage");
          },
          run: async () => {
            throw new Error("D1_ERROR: simulated TenantStore outage");
          },
        };
      },
    } as unknown as D1Database;

    const outageDeps = {
      ...makeRuntimeDiscoveryDeps({ nowMs: BASE_TIME + 80_000 }),
      tenantDb: failingTenantDb,
    };

    const [indexOutage, subOutage, robotsOutage, feedOutage] = await Promise.all([
      handleSitemapIndexRequest(
        new Request(`https://${TENANT_ALPHA.customDomain}/sitemap.xml`),
        outageDeps,
      ),
      handleSubSitemapRequest(
        new Request(`https://${TENANT_ALPHA.customDomain}/sitemaps/pages.xml`),
        "pages",
        outageDeps,
      ),
      handleRobotsTxtRequest(
        new Request(`https://${TENANT_ALPHA.customDomain}/robots.txt`),
        outageDeps,
      ),
      handleBlogFeedRequest(
        new Request(`https://${TENANT_ALPHA.customDomain}/blog/feed.xml`),
        outageDeps,
      ),
    ]);

    for (const res of [indexOutage, subOutage, robotsOutage, feedOutage]) {
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("60");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
    expect(await robotsOutage.text()).toContain("Disallow: /");

    // 2. Opted-in taxonomy archive with useful intro & published post appears in posts.xml, while non-opted-in stays excluded
    await tenantDbAlpha
      .prepare("UPDATE installed_plugins SET enabled = 1 WHERE plugin_id = 'seo-ai-autopilot'")
      .run();
    await tenantDbAlpha
      .prepare(
        `CREATE TABLE IF NOT EXISTS taxonomy_archive_settings (
          taxonomy_id INTEGER PRIMARY KEY REFERENCES taxonomies(id) ON DELETE CASCADE,
          index_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (index_opt_in IN (0, 1)),
          updated_at INTEGER NOT NULL
        )`,
      )
      .run();

    // Re-publish the post properly via publishPost and link it to opted-in vs non-opted-in categories
    const postVerRow = await tenantDbAlpha
      .prepare("SELECT version FROM posts WHERE id = ?")
      .bind(alphaPublishedPostId)
      .first<{ readonly version: number }>();
    await publishPost(env.PLATFORM_DB, tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
      postId: alphaPublishedPostId,
      expectedVersion: Number(postVerRow?.version ?? 1),
      nowMs: BASE_TIME + 80_500,
    });
    clearHostResolutionCache();

    const longIntro =
      "Panduan lengkap dan studi kasus terverifikasi mengenai layanan konsultasi operasional bisnis skala nasional.";
    await tenantDbAlpha
      .prepare(
        `INSERT OR REPLACE INTO taxonomies (id, taxonomy_type, offering_type, parent_id, depth, slug, name, description, sort_order, version, created_at, updated_at)
         VALUES
           (901, 'post_category', NULL, NULL, 0, 'panduan-bisnis', 'Panduan Bisnis', ?, 1, 1, ?, ?),
           (902, 'post_category', NULL, NULL, 0, 'internal-notes', 'Internal Notes', ?, 2, 1, ?, ?)`,
      )
      .bind(longIntro, BASE_TIME, BASE_TIME, longIntro, BASE_TIME, BASE_TIME)
      .run();
    await tenantDbAlpha
      .prepare(
        `INSERT OR REPLACE INTO taxonomy_archive_settings (taxonomy_id, index_opt_in, updated_at)
         VALUES (901, 1, ?), (902, 0, ?)`,
      )
      .bind(BASE_TIME, BASE_TIME)
      .run();
    await tenantDbAlpha
      .prepare(
        `INSERT OR IGNORE INTO post_taxonomies (post_id, taxonomy_id) VALUES (?, 901), (?, 902)`,
      )
      .bind(alphaPublishedPostId, alphaPublishedPostId)
      .run();

    const postsWithTax = await handleSubSitemapRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemaps/posts.xml`),
      "posts",
      makeRuntimeDiscoveryDeps({ nowMs: BASE_TIME + 81_000 }),
    );
    expect(postsWithTax.status).toBe(200);
    const postsWithTaxXml = await postsWithTax.text();
    expect(postsWithTaxXml).toContain(
      `https://${TENANT_ALPHA.customDomain}/blog/category/panduan-bisnis`,
    );
    expect(postsWithTaxXml).not.toContain("/blog/category/internal-notes");
  });
});

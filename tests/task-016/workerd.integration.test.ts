import { env } from "cloudflare:workers";
import {
  buildQuarantineR2Key,
  computeSha256Hex,
  MAX_OG_DERIVATIVE_BYTES,
  type CloudflareImagesBinding,
  type CloudflareImagesTransformOptions,
} from "@punyasitus/core/media/index";
import {
  DEFAULT_MEDIA_CDN_ORIGIN,
  generateOpenGraphMetadata,
  generatePublishedResourceOpenGraph,
  renderSeoHeadHtml,
} from "@punyasitus/core/og-generator";
import {
  INDEXABLE_ROBOTS_DIRECTIVES,
  type VerifiedTenantHostInput,
} from "@punyasitus/core/seo/index";
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
import {
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
} from "@punyasitus/db/platform";
import {
  getPublishedResource,
  publishResourceAtomically,
  saveDraftResource,
} from "@punyasitus/db/publication/index";
import {
  clearHostResolutionCache,
  resolveTenantByHost,
  type HostResolutionResult,
} from "@punyasitus/db/routing/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadPublishedTenantShellData } from "../../apps/web/src/core/public-data.ts";
import {
  processImageMediaJob,
  type MediaWorkerR2BucketLike,
} from "../../apps/web/src/worker/queues/media/index.ts";
import {
  generateAndStoreTenantOgDerivative,
  resolveTenantOgImageCandidate,
  type OgR2BucketLike,
} from "../../apps/web/src/worker/queues/media/og.ts";

const BASE_TIME = 1_830_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TENANT_ALPHA = {
  id: "01JT016TENANTA000000000001",
  orgId: "org_t016_alpha",
  handle: "t016-alpha",
  name: "T016 Alpha Konstruksi",
  subdomain: "t016-alpha.situsku.click",
  customDomain: "www.t016-alpha.id",
} as const;

const TENANT_SUB = {
  id: "01JT016TENANTB000000000002",
  orgId: "org_t016_sub",
  handle: "t016-sub",
  name: "T016 Subdomain Studio",
  subdomain: "t016-sub.situsku.click",
} as const;

const TENANT_TRIAL = {
  id: "01JT016TENANTC000000000003",
  orgId: "org_t016_trial",
  handle: "t016-trial",
  name: "T016 Trial Bakery",
  subdomain: "t016-trial.situsku.click",
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

function createDeterministicImagesBinding(
  customSizeFn?: (quality: number, transform: CloudflareImagesTransformOptions) => number,
): CloudflareImagesBinding {
  return {
    input() {
      let opts: CloudflareImagesTransformOptions = {};
      return {
        transform(next) {
          opts = { ...opts, ...next };
          return this;
        },
        async output(outputOpts) {
          const width = opts.width ?? 1200;
          const height = opts.height ?? 630;
          const size = customSizeFn
            ? customSizeFn(outputOpts.quality ?? 80, opts)
            : width === 1200 && height === 630
              ? 148_000
              : 64_000;
          const bytes = makeValidWebpVp8X(width, height, size);
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

function toSeoTenantInput(
  resolved: Extract<HostResolutionResult, { readonly kind: "resolved" }>,
  verifiedTenantHosts: readonly string[],
): VerifiedTenantHostInput {
  return {
    tenantHandle: resolved.tenant.handle,
    tenantStatus: resolved.tenant.effectiveStatus,
    operatorHold: resolved.tenant.operatorHold,
    primaryHost: resolved.primaryHost,
    primaryHostKind: resolved.primaryHostKind,
    primaryHostStatus: "active",
    primaryHostSslStatus: "active",
    primaryHostVerified: true,
    servingHost: resolved.host,
    verifiedTenantHosts,
  };
}

async function seedTenantWithHost(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: "active" | "trial";
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
  const mig = await orchestrateTenantMigration(env.PLATFORM_DB, stub, spec.id, TENANT_MIGRATIONS);
  expect(mig.httpStatus).toBe(200);
  return createTenantDb(stub);
}

async function ingestReadyTenantMedia(params: {
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
  expect(processed.media.variants?.og.width).toBe(1200);
  expect(processed.media.variants?.og.height).toBe(630);
  expect(processed.media.variants?.og.bytes).toBeLessThanOrEqual(MAX_OG_DERIVATIVE_BYTES);

  return marked.mediaId;
}

describe("TASK-016: Open Graph, OG Derivative Worker & Head Rendering on workerd", () => {
  let tenantDbAlpha: D1Database;
  let tenantDbSub: D1Database;
  let tenantDbTrial: D1Database;
  let alphaReadyMediaId: number;
  let alphaDefaultMediaId: number;
  let subReadyMediaId: number;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    [tenantDbAlpha, tenantDbSub, tenantDbTrial] = await Promise.all([
      seedTenantWithHost({ ...TENANT_ALPHA, status: "active" }),
      seedTenantWithHost({ ...TENANT_SUB, status: "active" }),
      seedTenantWithHost({ ...TENANT_TRIAL, status: "trial" }),
    ]);

    // Ingest real media into R2 + TenantStore for Alpha (article + default OG) and Subdomain tenant
    alphaDefaultMediaId = await ingestReadyTenantMedia({
      tenantId: TENANT_ALPHA.id,
      tenantDb: tenantDbAlpha,
      filename: "default-company-card.png",
      altText: "Kartu Sosial Resmi Alpha Konstruksi",
      nowMs: BASE_TIME,
    });
    alphaReadyMediaId = await ingestReadyTenantMedia({
      tenantId: TENANT_ALPHA.id,
      tenantDb: tenantDbAlpha,
      filename: "proyek-gedung-jakarta.png",
      altText: "Proyek Gedung Perkantoran Alpha",
      nowMs: BASE_TIME + 1_000,
    });
    subReadyMediaId = await ingestReadyTenantMedia({
      tenantId: TENANT_SUB.id,
      tenantDb: tenantDbSub,
      filename: "studio-showcase.png",
      altText: "Portofolio Subdomain Studio",
      nowMs: BASE_TIME + 2_000,
    });

    // Seed published site_settings, page, and post for Tenant Alpha
    await tenantDbAlpha.batch([
      tenantDbAlpha
        .prepare(
          `INSERT INTO site_settings (id, site_title, tagline, active_theme_id, og_image_media_id, version, updated_at)
           VALUES (1, 'Alpha Konstruksi', 'Kontraktor B2B Nasional', 'compro', ?, 1, ?)`,
        )
        .bind(alphaDefaultMediaId, BASE_TIME),
      tenantDbAlpha
        .prepare(
          `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
           VALUES (1, 'beranda', 'Beranda Alpha', 1, '[]', 'draft', 1, ?, ?)`,
        )
        .bind(BASE_TIME, BASE_TIME),
      tenantDbAlpha
        .prepare(
          `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
           VALUES (2, 'draf-rahasia', 'HALAMAN DRAF RAHASIA', 0, '[]', 'draft', 1, ?, ?)`,
        )
        .bind(BASE_TIME, BASE_TIME),
      tenantDbAlpha
        .prepare(
          `INSERT INTO posts (id, slug, title, excerpt, draft_body_json, cover_media_id, status, version, created_at, updated_at)
           VALUES (1, 'standar-konstruksi-hijau', 'Standar Konstruksi Hijau 2026', 'Panduan bangunan ramah lingkungan.', '{"schemaVersion":1,"blocks":[{"type":"paragraph","text":"Panduan standar konstruksi hijau."}]}', ?, 'draft', 1, ?, ?)`,
        )
        .bind(alphaReadyMediaId, BASE_TIME, BASE_TIME),
    ]);

    await publishResourceAtomically(env.PLATFORM_DB, tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 1,
      draftOverride: {
        siteTitle: "Alpha Konstruksi",
        tagline: "Kontraktor B2B Nasional",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "compro",
        ogImageMediaId: alphaDefaultMediaId,
        blogEnabled: true,
        catalogEnabled: true,
        aiTrainingPolicy: "allow",
        siteVisibility: "public",
      },
      nowMs: BASE_TIME + 5_000,
    });

    await publishResourceAtomically(env.PLATFORM_DB, tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 1,
      draftOverride: {
        slug: "beranda",
        title: "Beranda Alpha",
        isHomepage: true,
        layoutMode: "standard",
        sections: [],
        seo: {
          titleOverride: "Alpha Konstruksi | Solusi Bangunan B2B",
          descriptionOverride: "Jasa konstruksi perkantoran dan gudang industri terstandar.",
          ogImageMediaId: alphaReadyMediaId,
        },
      },
      nowMs: BASE_TIME + 5_100,
    });

    await publishResourceAtomically(env.PLATFORM_DB, tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
      resourceType: "post",
      resourceId: 1,
      expectedVersion: 1,
      draftOverride: {
        slug: "standar-konstruksi-hijau",
        title: "Standar Konstruksi Hijau 2026",
        excerpt: "Panduan bangunan ramah lingkungan untuk gedung B2B.",
        body: {
          schemaVersion: 1,
          blocks: [{ type: "paragraph", text: "Panduan standar konstruksi hijau untuk proyek B2B modern." }],
        },
        coverMediaId: alphaReadyMediaId,
        readingTimeMinutes: 4,
        showToc: false,
        seo: {
          ogImageMediaId: alphaReadyMediaId,
        },
      },
      nowMs: BASE_TIME + 5_200,
    });

    // Save unpublished draft edit on page 1 so we prove public head uses published snapshot ONLY
    await saveDraftResource(tenantDbAlpha, {
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 2,
      draft: {
        slug: "beranda",
        title: "DRAF BERANDA BELUM TERBIT",
        isHomepage: true,
        layoutMode: "standard",
        sections: [],
      },
      nowMs: BASE_TIME + 5_300,
    });

    // Seed published site_settings + page for Subdomain tenant and Trial tenant
    await tenantDbSub.batch([
      tenantDbSub
        .prepare(
          `INSERT INTO site_settings (id, site_title, tagline, active_theme_id, og_image_media_id, version, updated_at)
           VALUES (1, 'Subdomain Studio', 'Desain Kreatif', 'sales', ?, 1, ?)`,
        )
        .bind(subReadyMediaId, BASE_TIME),
      tenantDbSub
        .prepare(
          `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
           VALUES (1, 'beranda', 'Beranda Studio', 1, '[]', 'draft', 1, ?, ?)`,
        )
        .bind(BASE_TIME, BASE_TIME),
    ]);
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbSub, {
      tenantId: TENANT_SUB.id,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_TIME + 6_000,
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbSub, {
      tenantId: TENANT_SUB.id,
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_TIME + 6_100,
    });

    await tenantDbTrial.batch([
      tenantDbTrial
        .prepare(
          `INSERT INTO site_settings (id, site_title, tagline, active_theme_id, version, updated_at)
           VALUES (1, 'Trial Bakery', 'Roti Segar Harian', 'resto', 1, ?)`,
        )
        .bind(BASE_TIME),
      tenantDbTrial
        .prepare(
          `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
           VALUES (1, 'beranda', 'Beranda Bakery', 1, '[]', 'draft', 1, ?, ?)`,
        )
        .bind(BASE_TIME, BASE_TIME),
    ]);
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbTrial, {
      tenantId: TENANT_TRIAL.id,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_TIME + 7_000,
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbTrial, {
      tenantId: TENANT_TRIAL.id,
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_TIME + 7_100,
    });
  });

  beforeEach(() => {
    clearHostResolutionCache();
  });

  it("renders verified custom-domain <head> with ready R2 1200x630 <=300KiB OG image and article tags", async () => {
    const hostRes = await resolveTenantByHost(env.PLATFORM_DB, TENANT_ALPHA.customDomain, {
      nowMs: BASE_TIME + 10_000,
    });
    expect(hostRes.kind).toBe("resolved");
    if (hostRes.kind !== "resolved") return;

    const [siteSettings, publishedPage, publishedPost, shell, resolvedImg, resolvedDefaultImg] =
      await Promise.all([
        getPublishedResource(tenantDbAlpha, { resourceType: "site_settings", resourceId: 1 }),
        getPublishedResource(tenantDbAlpha, { resourceType: "page", resourceId: 1 }),
        getPublishedResource(tenantDbAlpha, { resourceType: "post", resourceId: 1 }),
        loadPublishedTenantShellData(tenantDbAlpha),
        resolveTenantOgImageCandidate({
          tenantId: TENANT_ALPHA.id,
          tenantDb: tenantDbAlpha,
          mediaId: alphaReadyMediaId,
          mediaBucket: env.MEDIA_BUCKET as unknown as OgR2BucketLike,
          verifyR2Object: true,
        }),
        resolveTenantOgImageCandidate({
          tenantId: TENANT_ALPHA.id,
          tenantDb: tenantDbAlpha,
          mediaId: alphaDefaultMediaId,
          mediaBucket: env.MEDIA_BUCKET as unknown as OgR2BucketLike,
          verifyR2Object: true,
        }),
      ]);

    expect(shell.site.title).toBe("Alpha Konstruksi");
    expect(resolvedImg.ok).toBe(true);
    expect(resolvedDefaultImg.ok).toBe(true);
    if (!resolvedImg.ok || !resolvedDefaultImg.ok) return;

    const seoTenant = toSeoTenantInput(hostRes, [TENANT_ALPHA.customDomain, TENANT_ALPHA.subdomain]);

    // 1. Homepage (custom domain, published snapshot ignores newer draft edit)
    const homeOg = generatePublishedResourceOpenGraph({
      tenantId: TENANT_ALPHA.id,
      tenant: seoTenant,
      siteSettings: siteSettings?.data ?? null,
      resource: publishedPage,
      requestPathname: "/",
      query: "?utm_source=ig&fbclid=12345",
      resourceOgImage: resolvedImg.candidate,
      tenantDefaultOgImage: resolvedDefaultImg.candidate,
    });

    const homeHead = renderSeoHeadHtml(homeOg, {
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: shell.site.title,
        url: homeOg.canonical,
      },
    });

    expect(homeOg.canonical).toBe("https://www.t016-alpha.id/");
    expect(homeOg.robots).toBe(INDEXABLE_ROBOTS_DIRECTIVES);
    expect(homeHead).toContain('<link rel="canonical" href="https://www.t016-alpha.id/" />');
    expect(homeHead).toContain('<meta property="og:url" content="https://www.t016-alpha.id/" />');
    expect(homeHead).toContain(
      `<meta property="og:image" content="${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ALPHA.id}/media/${alphaReadyMediaId}/proyek-gedung-jakarta-og.webp" />`,
    );
    expect(homeHead).toContain('<meta property="og:image:width" content="1200" />');
    expect(homeHead).toContain('<meta property="og:image:height" content="630" />');
    expect(homeHead).toContain('<meta property="og:image:type" content="image/webp" />');
    expect(homeHead).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(homeHead).not.toContain("DRAF BERANDA BELUM TERBIT");

    // 2. Published Article on custom domain
    const postOg = generatePublishedResourceOpenGraph({
      tenantId: TENANT_ALPHA.id,
      tenant: seoTenant,
      siteSettings: siteSettings?.data ?? null,
      resource: publishedPost,
      requestPathname: "/blog/standar-konstruksi-hijau",
      resourceOgImage: resolvedImg.candidate,
      tenantDefaultOgImage: resolvedDefaultImg.candidate,
    });
    const postHead = renderSeoHeadHtml(postOg);
    expect(postOg.og.type).toBe("article");
    expect(postHead).toContain(
      '<link rel="canonical" href="https://www.t016-alpha.id/blog/standar-konstruksi-hijau" />',
    );
    expect(postHead).toContain('<meta property="og:type" content="article" />');
    expect(postHead).toContain('<meta property="article:published_time"');
    expect(postHead).toContain('<meta property="article:modified_time"');
  });

  it("renders published subdomain page, trial site (noindex, nofollow), and draft/preview (no canonical/og:url)", async () => {
    // 1. Published paid subdomain tenant
    const subHost = await resolveTenantByHost(env.PLATFORM_DB, TENANT_SUB.subdomain, {
      nowMs: BASE_TIME + 11_000,
    });
    expect(subHost.kind).toBe("resolved");
    if (subHost.kind !== "resolved") return;

    const [subSettings, subPage, subImg] = await Promise.all([
      getPublishedResource(tenantDbSub, { resourceType: "site_settings", resourceId: 1 }),
      getPublishedResource(tenantDbSub, { resourceType: "page", resourceId: 1 }),
      resolveTenantOgImageCandidate({
        tenantId: TENANT_SUB.id,
        tenantDb: tenantDbSub,
        mediaId: subReadyMediaId,
        mediaBucket: env.MEDIA_BUCKET as unknown as OgR2BucketLike,
        verifyR2Object: true,
      }),
    ]);
    expect(subImg.ok).toBe(true);
    if (!subImg.ok) return;

    const subOg = generatePublishedResourceOpenGraph({
      tenantId: TENANT_SUB.id,
      tenant: toSeoTenantInput(subHost, [TENANT_SUB.subdomain]),
      siteSettings: subSettings?.data ?? null,
      resource: subPage,
      resourceOgImage: subImg.candidate,
    });
    expect(subOg.canonical).toBe("https://t016-sub.situsku.click/");
    expect(subOg.robots).toBe(INDEXABLE_ROBOTS_DIRECTIVES);

    // 2. Trial site -> ALWAYS noindex, nofollow
    const trialHost = await resolveTenantByHost(env.PLATFORM_DB, TENANT_TRIAL.subdomain, {
      nowMs: BASE_TIME + 12_000,
    });
    expect(trialHost.kind).toBe("resolved");
    if (trialHost.kind !== "resolved") return;

    const [trialSettings, trialPage] = await Promise.all([
      getPublishedResource(tenantDbTrial, { resourceType: "site_settings", resourceId: 1 }),
      getPublishedResource(tenantDbTrial, { resourceType: "page", resourceId: 1 }),
    ]);
    const trialOg = generatePublishedResourceOpenGraph({
      tenantId: TENANT_TRIAL.id,
      tenant: toSeoTenantInput(trialHost, [TENANT_TRIAL.subdomain]),
      siteSettings: trialSettings?.data ?? null,
      resource: trialPage,
    });
    const trialHead = renderSeoHeadHtml(trialOg);
    expect(trialOg.robots).toBe("noindex, nofollow");
    expect(trialHead).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(trialHead).toContain('<link rel="canonical" href="https://t016-trial.situsku.click/" />');

    // 3. Draft-only unpublished page (page #2 on Alpha) -> getPublishedResource returns null -> noindex, no canonical, no og:url
    const alphaHost = await resolveTenantByHost(env.PLATFORM_DB, TENANT_ALPHA.customDomain, {
      nowMs: BASE_TIME + 13_000,
    });
    expect(alphaHost.kind).toBe("resolved");
    if (alphaHost.kind !== "resolved") return;

    const draftOnlyPage = await getPublishedResource(tenantDbAlpha, {
      resourceType: "page",
      resourceId: 2,
    });
    expect(draftOnlyPage).toBeNull();

    const draftPublicOg = generatePublishedResourceOpenGraph({
      tenantId: TENANT_ALPHA.id,
      tenant: toSeoTenantInput(alphaHost, [TENANT_ALPHA.customDomain, TENANT_ALPHA.subdomain]),
      resource: draftOnlyPage,
      requestPathname: "/draf-rahasia",
    });
    const draftPublicHead = renderSeoHeadHtml(draftPublicOg);
    expect(draftPublicOg.canonical).toBeNull();
    expect(draftPublicOg.og.url).toBeNull();
    expect(draftPublicHead).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(draftPublicHead).not.toContain('rel="canonical"');
    expect(draftPublicHead).not.toContain('property="og:url"');
    expect(draftPublicHead).not.toContain("HALAMAN DRAF RAHASIA");

    // 4. Authorized admin preview -> noindex, nofollow + NO canonical + NO og:url
    const previewOg = generateOpenGraphMetadata({
      seo: {
        surface: "preview",
        routeKind: "preview",
        pathname: "/preview/page/2",
        tenant: toSeoTenantInput(alphaHost, [TENANT_ALPHA.customDomain, TENANT_ALPHA.subdomain]),
      },
      tenantId: TENANT_ALPHA.id,
      siteName: "Alpha Konstruksi",
      resourceTitle: "Pratinjau Halaman Baru",
    });
    const previewHead = renderSeoHeadHtml(previewOg);
    expect(previewHead).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(previewHead).not.toContain('rel="canonical"');
    expect(previewHead).not.toContain('property="og:url"');
  });

  it("rejects oversized/quarantined R2 media, steps down OG quality into R2, and enforces two-tenant isolation", async () => {
    const r2Bucket = env.MEDIA_BUCKET as unknown as OgR2BucketLike;

    // 1. Worker OG derivative quality step-down + R2 write
    const pngSource = makeValidPng(2000, 1200, 4096);
    const stepImages = createDeterministicImagesBinding((quality) =>
      quality >= 70 ? MAX_OG_DERIVATIVE_BYTES + 10_000 : 195_000,
    );
    const stored = await generateAndStoreTenantOgDerivative({
      tenantId: TENANT_ALPHA.id,
      mediaId: 77,
      originalFilename: "Banner Promo 2026!.png",
      sourceBytes: pngSource,
      images: stepImages,
      mediaBucket: r2Bucket,
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.qualityUsed).toBe(62);
    expect(stored.variant.width).toBe(1200);
    expect(stored.variant.height).toBe(630);
    expect(stored.variant.bytes).toBe(195_000);
    expect(stored.variant.key).toBe(`t/${TENANT_ALPHA.id}/media/77/banner-promo-2026-og.webp`);

    const storedR2Obj = await env.MEDIA_BUCKET.get(stored.variant.key);
    expect(storedR2Obj).not.toBeNull();
    expect(storedR2Obj?.size).toBe(195_000);
    expect(storedR2Obj?.customMetadata?.tenantId).toBe(TENANT_ALPHA.id);
    expect(storedR2Obj?.customMetadata?.exifStripped).toBe("true");

    // 2. Seed an oversized (307,201-byte) media_items row + quarantined row in Alpha's TenantStore
    const oversizedKey = `t/${TENANT_ALPHA.id}/media/88/oversized-og.webp`;
    await env.MEDIA_BUCKET.put(oversizedKey, makeValidWebpVp8X(1200, 630, MAX_OG_DERIVATIVE_BYTES + 1), {
      httpMetadata: { contentType: "image/webp" },
      customMetadata: { tenantId: TENANT_ALPHA.id },
    });

    await tenantDbAlpha.batch([
      tenantDbAlpha
        .prepare(
          `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, variants_json, status, deleted_at, version, created_at, updated_at)
           VALUES (88, 'image', ?, 'image/webp', 500000, 'sha88', 1600, 900, 'Oversized OG', ?, 'ready', NULL, 1, ?, ?)`,
        )
        .bind(
          `t/${TENANT_ALPHA.id}/media/88/oversized-master.webp`,
          JSON.stringify({
            slug: "oversized",
            master: { key: `t/${TENANT_ALPHA.id}/media/88/oversized-master.webp`, width: 1600, height: 900, bytes: 500_000, mimeType: "image/webp" },
            w640: { key: `t/${TENANT_ALPHA.id}/media/88/oversized-w640.webp`, width: 640, height: 360, bytes: 40_000, mimeType: "image/webp" },
            w1280: { key: `t/${TENANT_ALPHA.id}/media/88/oversized-w1280.webp`, width: 1280, height: 720, bytes: 90_000, mimeType: "image/webp" },
            thumb: { key: `t/${TENANT_ALPHA.id}/media/88/oversized-thumb.webp`, width: 400, height: 400, bytes: 20_000, mimeType: "image/webp" },
            // Deliberately claim 200_000 in DB while real R2 object is 307_201 bytes -> verifyR2Object catches it!
            og: { key: oversizedKey, width: 1200, height: 630, bytes: 200_000, mimeType: "image/webp" },
          }),
          BASE_TIME,
          BASE_TIME,
        ),
      tenantDbAlpha
        .prepare(
          `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, variants_json, status, deleted_at, version, created_at, updated_at)
           VALUES (89, 'image', ?, 'image/png', 12000, 'sha89', 1200, 630, 'Quarantined Item', NULL, 'quarantined', NULL, 1, ?, ?)`,
        )
        .bind(`t/${TENANT_ALPHA.id}/quarantine/q89/raw.png`, BASE_TIME, BASE_TIME),
      // Tampered row pointing to Tenant Sub's R2 key!
      tenantDbAlpha
        .prepare(
          `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, variants_json, status, deleted_at, version, created_at, updated_at)
           VALUES (90, 'image', ?, 'image/webp', 80000, 'sha90', 1200, 630, 'Stolen Cross Tenant', ?, 'ready', NULL, 1, ?, ?)`,
        )
        .bind(
          `t/${TENANT_SUB.id}/media/${subReadyMediaId}/studio-showcase-master.webp`,
          JSON.stringify({
            slug: "studio-showcase",
            master: { key: `t/${TENANT_SUB.id}/media/${subReadyMediaId}/studio-showcase-master.webp`, width: 1200, height: 630, bytes: 80_000, mimeType: "image/webp" },
            w640: { key: `t/${TENANT_SUB.id}/media/${subReadyMediaId}/studio-showcase-w640.webp`, width: 640, height: 360, bytes: 20_000, mimeType: "image/webp" },
            w1280: { key: `t/${TENANT_SUB.id}/media/${subReadyMediaId}/studio-showcase-w1280.webp`, width: 1200, height: 630, bytes: 60_000, mimeType: "image/webp" },
            thumb: { key: `t/${TENANT_SUB.id}/media/${subReadyMediaId}/studio-showcase-thumb.webp`, width: 400, height: 400, bytes: 15_000, mimeType: "image/webp" },
            og: { key: `t/${TENANT_SUB.id}/media/${subReadyMediaId}/studio-showcase-og.webp`, width: 1200, height: 630, bytes: 148_000, mimeType: "image/webp" },
          }),
          BASE_TIME,
          BASE_TIME,
        ),
    ]);

    const [oversizedRes, quarantinedRes, crossTenantRes, defaultRes, subOwnRes] = await Promise.all([
      resolveTenantOgImageCandidate({
        tenantId: TENANT_ALPHA.id,
        tenantDb: tenantDbAlpha,
        mediaId: 88,
        mediaBucket: r2Bucket,
        verifyR2Object: true,
      }),
      resolveTenantOgImageCandidate({
        tenantId: TENANT_ALPHA.id,
        tenantDb: tenantDbAlpha,
        mediaId: 89,
        mediaBucket: r2Bucket,
        verifyR2Object: true,
      }),
      resolveTenantOgImageCandidate({
        tenantId: TENANT_ALPHA.id,
        tenantDb: tenantDbAlpha,
        mediaId: 90,
        mediaBucket: r2Bucket,
        verifyR2Object: true,
      }),
      resolveTenantOgImageCandidate({
        tenantId: TENANT_ALPHA.id,
        tenantDb: tenantDbAlpha,
        mediaId: alphaDefaultMediaId,
        mediaBucket: r2Bucket,
        verifyR2Object: true,
      }),
      resolveTenantOgImageCandidate({
        tenantId: TENANT_SUB.id,
        tenantDb: tenantDbSub,
        mediaId: subReadyMediaId,
        mediaBucket: r2Bucket,
        verifyR2Object: true,
      }),
    ]);

    expect(oversizedRes.ok).toBe(false);
    if (!oversizedRes.ok) expect(oversizedRes.reason).toBe("R2_OBJECT_OVERSIZED");

    expect(quarantinedRes.ok).toBe(false);
    if (!quarantinedRes.ok) expect(quarantinedRes.reason).toBe("NOT_READY");

    expect(crossTenantRes.ok).toBe(false);
    if (!crossTenantRes.ok) expect(crossTenantRes.reason).toBe("CROSS_TENANT_OR_INVALID_KEY");

    expect(defaultRes.ok).toBe(true);
    expect(subOwnRes.ok).toBe(true);
    if (!defaultRes.ok || !subOwnRes.ok) return;

    // Defense-in-depth: even if Tenant Sub's valid OgImageCandidate is handed to Alpha's generator, it is REJECTED!
    const alphaHost = await resolveTenantByHost(env.PLATFORM_DB, TENANT_ALPHA.customDomain, {
      nowMs: BASE_TIME + 14_000,
    });
    expect(alphaHost.kind).toBe("resolved");
    if (alphaHost.kind !== "resolved") return;

    const fallbackMetadata = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "page",
        pathname: "/proyek",
        tenant: toSeoTenantInput(alphaHost, [TENANT_ALPHA.customDomain, TENANT_ALPHA.subdomain]),
      },
      tenantId: TENANT_ALPHA.id,
      siteName: "Alpha Konstruksi",
      resourceTitle: "Proyek Kami",
      resourceOgImage: subOwnRes.candidate, // Foreign tenant candidate MUST be rejected!
      tenantDefaultOgImage: defaultRes.candidate,
    });

    expect(fallbackMetadata.og.image?.source).toBe("tenant_default");
    expect(fallbackMetadata.og.image?.url).toContain(`/t/${TENANT_ALPHA.id}/`);
    expect(fallbackMetadata.og.image?.url).not.toContain(TENANT_SUB.id);
    expect(fallbackMetadata.imageRejections).toEqual(
      expect.arrayContaining([expect.objectContaining({ slot: "resource", reason: "cross_tenant" })]),
    );
  });
});

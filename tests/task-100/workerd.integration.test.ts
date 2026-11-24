import { env } from "cloudflare:workers";
import {
  assertTenantR2Key,
  buildMediaDerivativeKeys,
  type CloudflareImagesBinding,
} from "@punyasitus/core/media/index";
import type { TenantStatus } from "@punyasitus/core/schemas";
import {
  applyPlatformMigrations,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  createMediaUploadIntent,
  finalizeProcessedMediaAtomically,
  markUploadIntentQuarantinedAndCreateMedia,
} from "@punyasitus/db/media/index";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import {
  applyPlatformPluginRuntimeMigration,
  TENANT_PLUGIN_LEDGER_MIGRATION,
} from "@punyasitus/db/plugins/index";
import {
  createBlogTaxonomy,
  createPost,
  listBlogTaxonomies,
} from "@punyasitus/db/posts/index";
import {
  ensureMediaPipelineSchema,
  getStorageUsageSnapshot,
  syncTenantStorageQuota,
} from "@punyasitus/db/storage-usage/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPluginRegistry } from "../../apps/web/src/core/plugin-registry.ts";
import { handleTenantPluginSubpathApiRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/[pluginId]/[...subpath].ts";
import { handleTenantPluginsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/index.ts";
import {
  createDefaultMediaPort,
  createWpImporterPlugin,
  WP_IMPORTER_PLUGIN_ID,
  type WpImporterCmsWriterPort,
  type WpImporterFetchPort,
  type WpImporterMediaStoragePort,
  type WpImportReport,
} from "../../packages/plugins/wp-importer/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const NOW_MS = Date.UTC(2026, 10, 24, 2, 0, 0);
const TEST_GET_BOOKMARK = async () => `bm_t100_${NOW_MS}`;

const TENANT_A = {
  id: "01JT100TENANTALPHA00000001",
  orgId: "org_t100_alpha",
  handle: "alpha-wp",
  name: "Alpha WP Studio",
  ownerId: "user_t100_owner_a",
  editorId: "user_t100_editor_a",
};

const TENANT_B = {
  id: "01JT100TENANTBETA000000002",
  orgId: "org_t100_beta",
  handle: "beta-wp",
  name: "Beta WP Co",
  ownerId: "user_t100_owner_b",
};

function getTenantStoreNs(): TenantStoreNamespaceLike {
  return env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
}

function buildRuntimeEnv() {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: getTenantStoreNs(),
  };
}

function makeAppRequest(
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Request {
  const method = init.method ?? "GET";
  const headers = new Headers();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("Origin", APP_ORIGIN);
    headers.set("Sec-Fetch-Site", "same-origin");
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
  }
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

function toBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function createValidPngBytes(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x20,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x73, 0x7a, 0x7a, 0xf4,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function createValidWebpBytes(width = 800, height = 600, totalBytes = 1024): Uint8Array {
  const size = Math.max(30, totalBytes);
  const bytes = new Uint8Array(size);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  const riffSize = size - 8;
  bytes[4] = riffSize & 0xff;
  bytes[5] = (riffSize >> 8) & 0xff;
  bytes[6] = (riffSize >> 16) & 0xff;
  bytes[7] = (riffSize >> 24) & 0xff;
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
  bytes[16] = 10;
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  bytes[24] = wMinus1 & 0xff;
  bytes[25] = (wMinus1 >> 8) & 0xff;
  bytes[26] = (wMinus1 >> 16) & 0xff;
  bytes[27] = hMinus1 & 0xff;
  bytes[28] = (hMinus1 >> 8) & 0xff;
  bytes[29] = (hMinus1 >> 16) & 0xff;
  return bytes;
}

function createMockImagesBinding(webpByteSize = 1024): CloudflareImagesBinding {
  const webpBytes = createValidWebpBytes(800, 600, webpByteSize);
  return {
    input() {
      const pipeline = {
        transform() {
          return pipeline;
        },
        async output() {
          return {
            image() {
              return new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array(webpBytes));
                  controller.close();
                },
              });
            },
            response() {
              return new Response(toBody(webpBytes), { headers: { "Content-Type": "image/webp" } });
            },
            contentType() {
              return "image/webp";
            },
          };
        },
      };
      return pipeline;
    },
  };
}

/**
 * Real TenantStore CMS writer adapter backed by `@punyasitus/db/posts/index`.
 * Strictly creates unpublished `draft` blog posts & taxonomies in the tenant's DO SQLite.
 */
function createRealTenantCmsWriter(
  tenantDb: D1Database,
  actorUserId: string,
): WpImporterCmsWriterPort {
  return {
    async ensureCategory({ name, slug, description, parentId, nowMs }) {
      const existing = await listBlogTaxonomies(tenantDb, { kind: "post_category", limit: 100 });
      const found = existing.items.find((c) => c.slug === slug);
      if (found) {
        return { id: found.id, slug: found.slug, created: false };
      }
      const created = await createBlogTaxonomy(tenantDb, {
        kind: "post_category",
        name,
        slug,
        description,
        parentId,
        nowMs,
      });
      return { id: created.id, slug: created.slug, created: true };
    },
    async ensureTag({ name, slug, description, nowMs }) {
      const existing = await listBlogTaxonomies(tenantDb, { kind: "post_tag", limit: 100 });
      const found = existing.items.find((t) => t.slug === slug);
      if (found) {
        return { id: found.id, slug: found.slug, created: false };
      }
      const created = await createBlogTaxonomy(tenantDb, {
        kind: "post_tag",
        name,
        slug,
        description,
        nowMs,
      });
      return { id: created.id, slug: created.slug, created: true };
    },
    async createDraftPost(input) {
      const created = await createPost(
        tenantDb,
        {
          title: input.title,
          slug: input.slug,
          excerpt: input.excerpt,
          body: input.body,
          coverMediaId: input.coverMediaId,
          primaryCategoryId: input.primaryCategoryId,
          categoryIds: input.categoryIds,
          tagIds: input.tagIds,
          seo: input.seo ?? undefined,
          nowMs: input.nowMs,
        },
        { actorUserId },
      );
      return {
        id: created.id,
        slug: created.slug,
        status: "draft",
        publishedAt: null,
      };
    },
  };
}

/**
 * Real TenantStore Media + Storage Quota adapter + mock R2 store backed by
 * `@punyasitus/db/media/index` & `@punyasitus/db/storage-usage/index`.
 */
function createRealTenantMediaPort(
  tenantId: string,
  tenantStatus: TenantStatus,
  tenantDb: D1Database,
  mockR2: Map<string, { readonly bytes: Uint8Array; readonly contentType: string }>,
): WpImporterMediaStoragePort {
  return {
    async getQuotaSnapshot() {
      const snap = await getStorageUsageSnapshot(tenantDb, { tenantStatus, nowMs: NOW_MS });
      return {
        usedBytes: snap.usedBytes,
        reservedBytes: snap.reservedBytes,
        quotaBytes: snap.quotaBytes,
        availableBytes: snap.availableBytes,
      };
    },
    async storeWebpAsset(asset) {
      const intentRes = await createMediaUploadIntent(tenantDb, {
        tenantId,
        tenantStatus,
        filename: asset.filename,
        declaredMime: "image/webp",
        declaredBytes: asset.webpBytes.byteLength,
        declaredSha256: asset.sha256,
        altText: asset.altText,
        nowMs: asset.nowMs,
      });
      if (!intentRes.ok) {
        return {
          ok: false,
          code: intentRes.code === "STORAGE_QUOTA_EXCEEDED" ? "STORAGE_QUOTA_EXCEEDED" : "STORAGE_ERROR",
          message: intentRes.message,
        };
      }

      const quarantined = await markUploadIntentQuarantinedAndCreateMedia(tenantDb, {
        tenantId,
        intentId: intentRes.intent.id,
        quarantineR2Key: intentRes.intent.quarantineR2Key,
        detectedMime: "image/webp",
        sha256: asset.sha256,
        width: asset.width,
        height: asset.height,
        nowMs: asset.nowMs,
      });
      if (!quarantined.ok) {
        return { ok: false, code: "STORAGE_ERROR", message: quarantined.message };
      }

      const keys = buildMediaDerivativeKeys(tenantId, quarantined.mediaId, asset.filename);
      assertTenantR2Key(tenantId, keys.master, ["media"]);

      const finalized = await finalizeProcessedMediaAtomically(tenantDb, {
        tenantId,
        mediaId: quarantined.mediaId,
        intentId: intentRes.intent.id,
        masterR2Key: keys.master,
        normalizedMasterBytes: asset.webpBytes.byteLength,
        masterSha256: asset.sha256,
        masterWidth: asset.width,
        masterHeight: asset.height,
        variants: {
          slug: intentRes.intent.slug,
          master: {
            key: keys.master,
            width: asset.width,
            height: asset.height,
            bytes: asset.webpBytes.byteLength,
            mimeType: "image/webp",
          },
          w640: {
            key: keys.w640,
            width: Math.min(640, asset.width),
            height: Math.min(480, asset.height),
            bytes: asset.webpBytes.byteLength,
            mimeType: "image/webp",
          },
          w1280: {
            key: keys.w1280,
            width: asset.width,
            height: asset.height,
            bytes: asset.webpBytes.byteLength,
            mimeType: "image/webp",
          },
          thumb: {
            key: keys.thumb,
            width: 320,
            height: 240,
            bytes: asset.webpBytes.byteLength,
            mimeType: "image/webp",
          },
          og: {
            key: keys.og,
            width: 1200,
            height: 630,
            bytes: asset.webpBytes.byteLength,
            mimeType: "image/webp",
          },
        },
        nowMs: asset.nowMs,
      });

      if (!finalized.ok) {
        return {
          ok: false,
          code: finalized.code === "STORAGE_QUOTA_EXCEEDED" ? "STORAGE_QUOTA_EXCEEDED" : "STORAGE_ERROR",
          message: finalized.message,
        };
      }

      mockR2.set(keys.master, {
        bytes: new Uint8Array(asset.webpBytes),
        contentType: "image/webp",
      });

      return {
        ok: true,
        mediaId: quarantined.mediaId,
        r2Key: keys.master,
        bytes: asset.webpBytes.byteLength,
      };
    },
  };
}

async function seedTenantFixture(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly ownerId: string;
  readonly editorId?: string;
  readonly status?: string;
}) {
  const db = env.PLATFORM_DB;
  const paidThrough = NOW_MS + 30 * 86_400_000;

  await db
    .prepare(
      `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, ?, ?)`,
    )
    .bind(spec.ownerId, `Owner ${spec.handle}`, `${spec.ownerId}@example.com`, NOW_MS, NOW_MS)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(spec.orgId, spec.name, spec.handle, NOW_MS, NOW_MS)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    )
    .bind(`mem_${spec.ownerId}`, spec.orgId, spec.ownerId, NOW_MS)
    .run();

  if (spec.editorId) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      )
      .bind(spec.editorId, `Editor ${spec.handle}`, `${spec.editorId}@example.com`, NOW_MS, NOW_MS)
      .run();
    await db
      .prepare(
        `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'editor', ?)`,
      )
      .bind(`mem_${spec.editorId}`, spec.orgId, spec.editorId, NOW_MS)
      .run();
  }

  await db
    .prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         paid_through, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', ?, 0, ?, 1, 1, 1, ?, ?)`,
    )
    .bind(
      spec.id,
      spec.orgId,
      spec.handle,
      spec.name,
      spec.status ?? "active",
      paidThrough,
      NOW_MS,
      NOW_MS,
    )
    .run();

  const stub = openTenantStoreStub(getTenantStoreNs(), spec.id);
  await orchestrateTenantMigration(
    db,
    stub,
    spec.id,
    [...TENANT_MIGRATIONS, TENANT_PLUGIN_LEDGER_MIGRATION],
    { getBookmark: TEST_GET_BOOKMARK, now: () => NOW_MS },
  );
  const tenantDb = createTenantDb(stub);
  await ensureMediaPipelineSchema(tenantDb);
}

async function cleanupTenantTables(tenantId: string) {
  const stub = openTenantStoreStub(getTenantStoreNs(), tenantId);
  const db = createTenantDb(stub);
  const existing = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ readonly name: string }>();
  const existingSet = new Set((existing.results ?? []).map((r) => r.name));
  const tables = [
    "post_taxonomies",
    "posts",
    "taxonomies",
    "resource_slugs",
    "media_upload_intents",
    "media_items",
    "storage_usage",
    "installed_plugins",
    "plg_wp_importer__staged_drafts",
    "plg_wp_importer__url_map",
    "plg_wp_importer__jobs",
  ];
  for (const tbl of tables) {
    if (existingSet.has(tbl)) {
      await db.prepare(`DELETE FROM ${tbl}`).run();
    }
  }
}

describe("TASK-100 Workerd Integration — wp-importer End-to-End Draft Import, R2 WebP, Quota & Isolation", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applyPlatformPluginRuntimeMigration(env.PLATFORM_DB);
    await seedTenantFixture(TENANT_A);
    await seedTenantFixture(TENANT_B);
  });

  beforeEach(async () => {
    await env.PLATFORM_DB.prepare("DELETE FROM tenant_plugin_entitlements").run();
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'active', paid_through = ? WHERE id IN (?, ?)",
    )
      .bind(NOW_MS + 30 * 86_400_000, TENANT_A.id, TENANT_B.id)
      .run();
    await cleanupTenantTables(TENANT_A.id);
    await cleanupTenantTables(TENANT_B.id);
  });

  it("installs wp-importer on Tenant A, imports /wp-json & WXR into real DRAFT posts + categories + R2 WebP + plg_wp_importer__* tables, and isolates Tenant B", async () => {
    const tenantDbA = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id));
    const mockR2 = new Map<string, { readonly bytes: Uint8Array; readonly contentType: string }>();
    const pngBytes = createValidPngBytes();

    const mockFetch: WpImporterFetchPort = async (input) => {
      const url = String(input);
      if (url.includes("/wp-json/wp/v2/categories")) {
        return new Response(
          JSON.stringify([{ id: 1, name: "Arsitektur", slug: "arsitektur", parent: 0 }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/wp-json/wp/v2/tags")) {
        return new Response(
          JSON.stringify([{ id: 2, name: "Minimalis", slug: "minimalis" }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/wp-json/wp/v2/posts")) {
        return new Response(
          JSON.stringify([
            {
              id: 301,
              slug: "desain-rumah-tropis-modern",
              status: "publish",
              link: "https://blog.arsitek.example.co.id/2026/03/desain-rumah-tropis-modern/",
              title: { rendered: "Desain Rumah Tropis Modern" },
              excerpt: { rendered: "<p>Konsep ventilasi silang untuk iklim Indonesia.</p>" },
              content: {
                rendered: `
                  <h2>Prinsip Ventilasi Silang</h2>
                  <p>Gunakan bukaan lebar dan <a href="https://arsitek.example.co.id/portofolio">lihat portofolio</a>.</p>
                  <script>alert('should_not_persist')</script>
                  <img src="https://cdn.arsitek.example.co.id/uploads/interior.png" alt="Interior tropis">
                `,
              },
              categories: [1],
              tags: [2],
              yoast_head_json: {
                title: "Desain Rumah Tropis Modern | Studio Arsitek",
                description: "Inspirasi desain rumah tropis hemat energi.",
              },
              _embedded: {
                "wp:featuredmedia": [
                  {
                    source_url: "https://cdn.arsitek.example.co.id/uploads/fasad.png",
                    alt_text: "Fasad rumah tropis",
                  },
                ],
              },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json", "X-WP-TotalPages": "1" } },
        );
      }
      if (url.endsWith(".png")) {
        return new Response(toBody(pngBytes), { status: 200, headers: { "Content-Type": "image/png" } });
      }
      return new Response("Not Found", { status: 404 });
    };

    const wiredPlugin = createWpImporterPlugin({
      fetchImpl: mockFetch,
      imagesBinding: createMockImagesBinding(1024),
      resolveMediaPort: (tid) =>
        tid === TENANT_A.id
          ? createRealTenantMediaPort(TENANT_A.id, "active", tenantDbA, mockR2)
          : undefined,
      resolveCmsWriter: (tid) =>
        tid === TENANT_A.id ? createRealTenantCmsWriter(tenantDbA, TENANT_A.ownerId) : undefined,
    });
    const registry = createPluginRegistry([wiredPlugin]);
    const runtimeEnv = buildRuntimeEnv();

    // 1. 1-click free install on Tenant A (runs `0001_wp_importer_tables` migration)
    const installRes = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`, {
        method: "POST",
        body: { pluginId: WP_IMPORTER_PLUGIN_ID },
      }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        registry,
        nowMs: NOW_MS,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    expect(installRes.status).toBe(200);

    // 2. Unentitled Tenant B is blocked (`403`) on Slot-3 endpoint
    const unentitledRes = await handleTenantPluginSubpathApiRequest(
      TENANT_B.handle,
      WP_IMPORTER_PLUGIN_ID,
      "status",
      makeAppRequest(`/api/tenants/${TENANT_B.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/status`),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_B.ownerId },
        registry,
        nowMs: NOW_MS,
      },
    );
    expect(unentitledRes.status).toBe(403);

    // 3. Dry-Run via Slot-3 HTTP API -> 200 report, ZERO rows created in `posts` or `mockR2`
    const dryRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "dry-run",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/dry-run`, {
        method: "POST",
        body: {
          sourceKind: "wp_json",
          siteUrl: "https://blog.arsitek.example.co.id",
          importImages: true,
        },
      }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        registry,
        nowMs: NOW_MS,
      },
    );
    expect(dryRes.status).toBe(200);
    const dryBody = (await dryRes.json()) as { readonly report: WpImportReport };
    expect(dryBody.report.mode).toBe("dry_run");
    expect(dryBody.report.counts.postsFound).toBe(1);
    expect(mockR2.size).toBe(0);

    const postsBeforeImport = await tenantDbA.prepare("SELECT COUNT(*) AS c FROM posts").first<{ c: number }>();
    expect(Number(postsBeforeImport?.c ?? 0)).toBe(0);

    // 4. Execute Import via Slot-3 HTTP API -> real DRAFT post, categories, tags, WebP R2 objects, job history & url_map
    const importRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "import",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/import`, {
        method: "POST",
        body: {
          sourceKind: "wp_json",
          siteUrl: "https://blog.arsitek.example.co.id",
          importImages: true,
        },
      }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        registry,
        nowMs: NOW_MS + 1000,
      },
    );
    expect(importRes.status).toBe(200);
    const importBody = (await importRes.json()) as { readonly report: WpImportReport };
    expect(importBody.report.counts.postsImported).toBe(1);
    expect(importBody.report.counts.imagesImported).toBe(2);
    expect(importBody.report.counts.categoriesImported).toBe(1);
    expect(importBody.report.counts.tagsImported).toBe(1);

    // Verify real `posts` row in TenantStore: STRICTLY DRAFT, NEVER PUBLISHED, SANITIZED!
    const postRow = await tenantDbA
      .prepare(
        `SELECT id, slug, title, status, published_at, published_body_json, draft_body_json, cover_media_id, primary_category_id, seo_json
         FROM posts LIMIT 1`,
      )
      .first<{
        readonly id: number;
        readonly slug: string;
        readonly title: string;
        readonly status: string;
        readonly published_at: number | null;
        readonly published_body_json: string | null;
        readonly draft_body_json: string;
        readonly cover_media_id: number | null;
        readonly primary_category_id: number | null;
        readonly seo_json: string | null;
      }>();

    expect(postRow).not.toBeNull();
    expect(postRow!.status).toBe("draft");
    expect(postRow!.published_at).toBeNull();
    expect(postRow!.published_body_json).toBeNull();
    expect(postRow!.slug).toBe("desain-rumah-tropis-modern");
    expect(postRow!.cover_media_id).toBeGreaterThan(0);
    expect(postRow!.primary_category_id).toBeGreaterThan(0);
    expect(postRow!.draft_body_json).not.toContain("should_not_persist");
    expect(postRow!.draft_body_json).not.toContain("<script");
    expect(postRow!.seo_json).toContain("Desain Rumah Tropis Modern | Studio Arsitek");

    // Verify real `media_items` + mock R2 WebP assets
    const mediaRows = await tenantDbA
      .prepare("SELECT id, r2_key, mime_type, bytes, status FROM media_items ORDER BY id ASC")
      .all<{
        readonly id: number;
        readonly r2_key: string;
        readonly mime_type: string;
        readonly bytes: number;
        readonly status: string;
      }>();
    expect(mediaRows.results).toHaveLength(2);
    for (const m of mediaRows.results) {
      expect(m.mime_type).toBe("image/webp");
      expect(m.status).toBe("ready");
      expect(m.r2_key.startsWith(`t/${TENANT_A.id}/media/`)).toBe(true);
      expect(mockR2.has(m.r2_key)).toBe(true);
      expect(mockR2.get(m.r2_key)!.contentType).toBe("image/webp");
    }

    // Verify `GET /jobs` & `GET /url-map`
    const jobsRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "jobs",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/jobs`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 2000 },
    );
    expect(jobsRes.status).toBe(200);
    const jobsData = (await jobsRes.json()) as { readonly jobs: readonly { id: string; mode: string }[] };
    expect(jobsData.jobs).toHaveLength(2); // dry_run + import

    const urlMapRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "url-map",
      makeAppRequest(
        `/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/url-map?jobId=${encodeURIComponent(importBody.report.jobId)}`,
      ),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 2000 },
    );
    expect(urlMapRes.status).toBe(200);
    const urlMapData = (await urlMapRes.json()) as {
      readonly items: readonly { sourcePath: string; targetPath: string; importedStatus: string }[];
    };
    expect(urlMapData.items).toHaveLength(1);
    expect(urlMapData.items[0]).toMatchObject({
      sourcePath: "/2026/03/desain-rumah-tropis-modern/",
      targetPath: "/blog/desain-rumah-tropis-modern",
      importedStatus: "draft",
    });

    // Cross-tenant isolation: Tenant B owner accessing Tenant A's plugin API receives neutral 404
    const crossTenantRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "jobs",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/jobs`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_B.ownerId }, registry, nowMs: NOW_MS + 2000 },
    );
    expect(crossTenantRes.status).toBe(404);
  });

  it("enforces real TenantStore storage_usage quota, blocks SSRF & XML bombs via HTTP API, and honors RBAC + locked lifecycle", async () => {
    const tenantDbA = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id));
    const mockR2 = new Map<string, { readonly bytes: Uint8Array; readonly contentType: string }>();
    const pngBytes = createValidPngBytes();

    const mockFetch: WpImporterFetchPort = async () =>
      new Response(toBody(pngBytes), { status: 200, headers: { "Content-Type": "image/png" } });

    const wiredPlugin = createWpImporterPlugin({
      fetchImpl: mockFetch,
      imagesBinding: createMockImagesBinding(2048),
      resolveMediaPort: (tid) =>
        tid === TENANT_A.id
          ? createRealTenantMediaPort(TENANT_A.id, "active", tenantDbA, mockR2)
          : undefined,
      resolveCmsWriter: (tid) =>
        tid === TENANT_A.id ? createRealTenantCmsWriter(tenantDbA, TENANT_A.ownerId) : undefined,
    });
    const registry = createPluginRegistry([wiredPlugin]);
    const runtimeEnv = buildRuntimeEnv();

    // Install plugin on Tenant A
    const installRes = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`, {
        method: "POST",
        body: { pluginId: WP_IMPORTER_PLUGIN_ID },
      }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        registry,
        nowMs: NOW_MS,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    expect(installRes.status).toBe(200);

    // Pre-fill storage_usage so only 1000 bytes remain (2048-byte WebP image MUST be refused!)
    const snap = await syncTenantStorageQuota(tenantDbA, "active", NOW_MS);
    await tenantDbA
      .prepare("UPDATE storage_usage SET used_bytes = ? WHERE id = 1")
      .bind(snap.quotaBytes - 1000)
      .run();

    const wxrWithImg = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <link>https://blog.quota.example.co.id</link>
    <item>
      <title>Artikel Uji Kuota</title>
      <link>https://blog.quota.example.co.id/artikel-uji-kuota/</link>
      <wp:post_id>901</wp:post_id>
      <wp:post_name>artikel-uji-kuota</wp:post_name>
      <wp:status>publish</wp:status>
      <wp:post_type>post</wp:post_type>
      <content:encoded><![CDATA[<p>Isi artikel.</p><img src="https://cdn.quota.example.co.id/big.png" alt="Foto besar">]]></content:encoded>
    </item>
  </channel>
</rss>`;

    const quotaImportRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "import",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/import`, {
        method: "POST",
        body: { sourceKind: "wxr", wxrXml: wxrWithImg, importImages: true },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 500 },
    );
    expect(quotaImportRes.status).toBe(200);
    const quotaData = (await quotaImportRes.json()) as { readonly report: WpImportReport };
    expect(quotaData.report.quota.exceeded).toBe(true);
    expect(quotaData.report.counts.imagesImported).toBe(0);
    expect(mockR2.size).toBe(0);

    const afterSnap = await getStorageUsageSnapshot(tenantDbA);
    expect(afterSnap.usedBytes).toBe(snap.quotaBytes - 1000);
    expect(afterSnap.usedBytes).toBeLessThanOrEqual(afterSnap.quotaBytes);

    // SSRF target blocked with 422 via HTTP API
    const ssrfRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "dry-run",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/dry-run`, {
        method: "POST",
        body: { sourceKind: "wp_json", siteUrl: "https://169.254.169.254/latest/meta-data/" },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 600 },
    );
    expect(ssrfRes.status).toBe(422);
    const ssrfJson = (await ssrfRes.json()) as { readonly error: { readonly code: string } };
    expect(ssrfJson.error.code).toBe("SSRF_BLOCKED");

    // XML Bomb blocked with 422 via HTTP API
    const xxeRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "dry-run",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/dry-run`, {
        method: "POST",
        body: {
          sourceKind: "wxr",
          wxrXml: `<!DOCTYPE x [<!ENTITY lol "lol">]><rss><channel><title>&lol;</title></channel></rss>`,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 700 },
    );
    expect(xxeRes.status).toBe(422);
    const xxeJson = (await xxeRes.json()) as { readonly error: { readonly code: string } };
    expect(xxeJson.error.code).toBe("WXR_XXE_FORBIDDEN");

    // RBAC: Editor cannot execute mutations (403 FORBIDDEN)
    const editorRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "import",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/import`, {
        method: "POST",
        body: { sourceKind: "wxr", wxrXml: wxrWithImg },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, registry, nowMs: NOW_MS + 800 },
    );
    expect(editorRes.status).toBe(403);

    // Lifecycle: Locked tenant (H+5 past due) blocks POST mutations (403 SUBSCRIPTION_LOCKED) while GET /jobs stays readable
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'locked', paid_through = ? WHERE id = ?",
    )
      .bind(NOW_MS - 5 * 86_400_000, TENANT_A.id)
      .run();

    const lockedPost = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "dry-run",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/dry-run`, {
        method: "POST",
        body: { sourceKind: "wxr", wxrXml: wxrWithImg },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 900 },
    );
    expect(lockedPost.status).toBe(403);

    const lockedGet = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "jobs",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/jobs`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 900 },
    );
    expect(lockedGet.status).toBe(200);
  });

  it("uses default wired CMS & R2 adapters (zero injected mocks) to create real draft posts, persists failed jobs & compact report_json, rejects allowHttp in API body, and compensates R2/quota on failure", async () => {
    const tenantDbA = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id));
    const cleanWebpBytes = createValidWebpBytes(800, 600, 30);

    const mockFetch: WpImporterFetchPort = async () =>
      new Response(toBody(cleanWebpBytes), {
        status: 200,
        headers: { "Content-Type": "image/webp" },
      });

    // ZERO custom `resolveCmsWriter` or `resolveMediaPort` injected: uses real default adapters
    // resolving `env.TENANT_STORE` + `env.MEDIA_BUCKET` from `cloudflare:workers`!
    const defaultWiredPlugin = createWpImporterPlugin({
      fetchImpl: mockFetch,
    });
    const registry = createPluginRegistry([defaultWiredPlugin]);
    const runtimeEnv = buildRuntimeEnv();

    // 1. Install plugin
    const installRes = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`, {
        method: "POST",
        body: { pluginId: WP_IMPORTER_PLUGIN_ID },
      }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        registry,
        nowMs: NOW_MS,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    expect(installRes.status).toBe(200);

    // 2. Reject client-controlled `allowHttp` in API payload (`422 VALIDATION_ERROR`)
    const allowHttpRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "dry-run",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/dry-run`, {
        method: "POST",
        body: {
          sourceKind: "wp_json",
          siteUrl: "http://blog.example.co.id",
          allowHttp: true,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 100 },
    );
    expect(allowHttpRes.status).toBe(422);

    // 3. Execute real WXR import using default adapters (real TenantStore + real R2 MEDIA_BUCKET!)
    const wxrPayload = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <link>https://blog.default-adapter.example.co.id</link>
    <item>
      <title>Artikel Default Adapter</title>
      <link>https://blog.default-adapter.example.co.id/artikel-default-adapter/</link>
      <wp:post_id>701</wp:post_id>
      <wp:post_name>artikel-default-adapter</wp:post_name>
      <wp:status>publish</wp:status>
      <wp:post_type>post</wp:post_type>
      <category domain="category" nicename="berita"><![CDATA[Berita]]></category>
      <content:encoded><![CDATA[<h2>Subjudul</h2><p>Isi artikel nyata.</p><img src="https://cdn.default-adapter.example.co.id/hero.webp" alt="Hero WebP">]]></content:encoded>
    </item>
  </channel>
</rss>`;

    const importRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "import",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/import`, {
        method: "POST",
        body: { sourceKind: "wxr", wxrXml: wxrPayload, importImages: true },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 200 },
    );
    expect(importRes.status).toBe(200);
    const importBody = (await importRes.json()) as { readonly report: WpImportReport };
    expect(importBody.report.counts.postsImported).toBe(1);
    expect(importBody.report.counts.imagesImported).toBe(1);

    // Confirm REAL `posts` row created in TenantStore (NOT staged-only fake success!)
    const realPost = await tenantDbA
      .prepare("SELECT id, slug, status, published_at, published_body_json FROM posts WHERE slug = ?")
      .bind("artikel-default-adapter")
      .first<{
        readonly id: number;
        readonly slug: string;
        readonly status: string;
        readonly published_at: number | null;
        readonly published_body_json: string | null;
      }>();
    expect(realPost).not.toBeNull();
    expect(realPost!.status).toBe("draft");
    expect(realPost!.published_at).toBeNull();
    expect(realPost!.published_body_json).toBeNull();

    // Confirm real R2 object exists in `env.MEDIA_BUCKET`
    const mediaRow = await tenantDbA
      .prepare("SELECT r2_key, mime_type, bytes, status FROM media_items LIMIT 1")
      .first<{ readonly r2_key: string; readonly mime_type: string; readonly bytes: number; readonly status: string }>();
    expect(mediaRow).not.toBeNull();
    expect(mediaRow!.mime_type).toBe("image/webp");
    expect(mediaRow!.status).toBe("ready");
    const r2Obj = await env.MEDIA_BUCKET.get(mediaRow!.r2_key);
    expect(r2Obj).not.toBeNull();

    // 4. Confirm persisted `report_json` in `plg_wp_importer__jobs` is COMPACT (drops bulky `sanitizedBody`)
    const persistedJob = await tenantDbA
      .prepare("SELECT status, report_json FROM plg_wp_importer__jobs WHERE id = ?")
      .bind(importBody.report.jobId)
      .first<{ readonly status: string; readonly report_json: string }>();
    expect(persistedJob?.status).toBe("completed");
    expect(persistedJob?.report_json).not.toContain('"sanitizedBody"');
    expect(persistedJob?.report_json).toContain('"blockCount"');

    // 5. Failed import (SSRF) records a `failed` job row with `error_code = 'SSRF_BLOCKED'`
    const failedRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WP_IMPORTER_PLUGIN_ID,
      "import",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WP_IMPORTER_PLUGIN_ID}/import`, {
        method: "POST",
        body: { sourceKind: "wp_json", siteUrl: "https://127.0.0.1.nip.io/wp-json" },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 300 },
    );
    expect(failedRes.status).toBe(422);
    const failedJob = await tenantDbA
      .prepare("SELECT status, error_code, completed_at FROM plg_wp_importer__jobs WHERE status = 'failed' LIMIT 1")
      .first<{ readonly status: string; readonly error_code: string | null; readonly completed_at: number | null }>();
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.error_code).toBe("SSRF_BLOCKED");
    expect(failedJob?.completed_at).not.toBeNull();

    // 6. R2 failure compensation: if R2 `put` fails mid-upload, zero orphan R2 objects and zero leaked `reserved_bytes`!
    const uploadedKeys: string[] = [];
    const deletedKeys: string[] = [];
    let putCalls = 0;
    const flakyBucket = {
      async put(key: string) {
        putCalls += 1;
        if (putCalls === 1) {
          uploadedKeys.push(key);
          return;
        }
        throw new Error("Simulated R2 outage on variant put");
      },
      async delete(keys: string | string[]) {
        if (Array.isArray(keys)) deletedKeys.push(...keys);
        else deletedKeys.push(keys);
      },
    };
    const flakyMediaPort = createDefaultMediaPort({
      tenantId: TENANT_A.id,
      tenantStatus: "active",
      tenantDb: tenantDbA,
      mediaBucket: flakyBucket,
      nowMs: NOW_MS + 400,
    })!;
    const beforeUsage = await getStorageUsageSnapshot(tenantDbA);
    const storeRes = await flakyMediaPort.storeWebpAsset({
      tenantId: TENANT_A.id,
      filename: "fail-compensate.webp",
      altText: "Test",
      webpBytes: cleanWebpBytes,
      width: 800,
      height: 600,
      sha256: "a".repeat(64),
      nowMs: NOW_MS + 400,
      extraVariants: {
        w640: { bytes: cleanWebpBytes, width: 640, height: 480 },
      },
    });
    expect(storeRes.ok).toBe(false);
    expect(uploadedKeys).toHaveLength(1);
    expect(deletedKeys).toEqual(uploadedKeys); // Master key cleaned up!
    const afterUsage = await getStorageUsageSnapshot(tenantDbA);
    expect(afterUsage.reservedBytes).toBe(beforeUsage.reservedBytes); // Zero leaked quota reservation!
    expect(afterUsage.usedBytes).toBe(beforeUsage.usedBytes);
  });
});

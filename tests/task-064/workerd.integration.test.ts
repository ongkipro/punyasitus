import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  createCatalogOffering,
  getCatalogOfferingById,
  publishCatalogOffering,
  updateCatalogOffering,
} from "@punyasitus/db/catalog/index";
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
  createPage,
  getPageById,
  getPublishedPage,
  PAGES_LAYOUT_MODE_MIGRATION,
  publishPage,
  updatePage,
} from "@punyasitus/db/pages/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import {
  BLOG_AUTHOR_TOC_MODIFIED_MIGRATION,
  createPost,
  getPostById,
  getPublishedPost,
  publishPost,
  updatePost,
} from "@punyasitus/db/posts/index";
import { getPublishedResource } from "@punyasitus/db/publication/index";
import {
  CONTENT_REVISION_HISTORY_MIGRATION,
  formatRevisionId,
  hasContentRevisionHistoryColumns,
  listContentRevisions,
  MAX_CONTENT_REVISIONS_PER_RESOURCE,
  purgeContentRevisionsForResource,
  restoreContentRevision,
} from "@punyasitus/db/revisions/index";
import { MEDIA_PIPELINE_MIGRATION } from "@punyasitus/db/storage-usage/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { purgeContentItem, trashContentItem } from "@punyasitus/db/trash/index";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantRevisionDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/revisions/[revisionId].ts";
import { handleTenantRevisionRestoreRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/revisions/[revisionId]/restore.ts";
import { handleTenantRevisionsListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/revisions/index.ts";
import type { TenantRevisionsRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/revisions/_shared.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 6, 0, 0);

function buildRuntimeEnv(
  overrides: Partial<TenantRevisionsRuntimeEnv> = {},
): TenantRevisionsRuntimeEnv {
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

function makeAdminRequest(
  url: string,
  method: string,
  options: {
    readonly cookie?: string;
    readonly origin?: string | null;
    readonly body?: unknown;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.origin !== null && method !== "GET" && method !== "HEAD") {
    headers.set("Origin", options.origin ?? APP_ORIGIN);
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }
  return new Request(url, { method, headers, body });
}

function extractCookiePair(res: Response, cookieName: string): string {
  const headersWithGetSetCookie = res.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies =
    typeof headersWithGetSetCookie.getSetCookie === "function"
      ? headersWithGetSetCookie.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const raw of setCookies) {
    const match = raw.match(new RegExp(`${cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]+)`));
    if (match?.[1]) {
      return `${cookieName}=${match[1]}`;
    }
  }
  throw new Error(`Missing Set-Cookie "${cookieName}"`);
}

async function signUpAppUser(
  runtimeEnv: TenantRevisionsRuntimeEnv,
  email: string,
  name: string,
  password = "PasswordAman#2026!",
): Promise<{ readonly userId: string; readonly cookie: string }> {
  const signUpReq = new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: APP_ORIGIN,
    },
    body: JSON.stringify({ email, password, name }),
  });
  const signUpRes = await handleBetterAuthRequest(signUpReq, runtimeEnv);
  expect(signUpRes.status).toBe(200);
  const body = (await signUpRes.json()) as { user: { id: string } };
  const cookie = extractCookiePair(signUpRes, APP_SESSION_COOKIE_NAME);
  return { userId: body.user.id, cookie };
}

interface SeededTenant {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly handle: string;
  readonly tenantDb: D1Database;
  readonly owner: { readonly userId: string; readonly cookie: string };
  readonly editor: { readonly userId: string; readonly cookie: string };
}

async function seedTenantWithUsers(
  suffix: string,
  runtimeEnv: TenantRevisionsRuntimeEnv,
  tenantStatus: "active" | "locked" | "suspended" = "active",
): Promise<SeededTenant> {
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const tenantId = `01J64REV${suffix.padStart(18, "0")}`;
  const organizationId = `org_t064_${suffix}`;
  const handle = `revsite-${suffix}`;
  const now = new Date(BASE_NOW_MS);

  const owner = await signUpAppUser(runtimeEnv, `owner-t064-${suffix}@example.com`, `Owner ${suffix}`);
  const editor = await signUpAppUser(runtimeEnv, `editor-t064-${suffix}@example.com`, `Editor ${suffix}`);

  await db.insert(organizations).values({
    id: organizationId,
    name: `Org ${handle}`,
    slug: handle,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(members).values([
    {
      id: `mem_owner_t064_${suffix}`,
      organizationId,
      userId: owner.userId,
      role: "owner",
      createdAt: now,
    },
    {
      id: `mem_editor_t064_${suffix}`,
      organizationId,
      userId: editor.userId,
      role: "editor",
      createdAt: now,
    },
  ]);
  await db.insert(tenants).values({
    id: tenantId,
    organizationId,
    handle,
    name: `Bisnis ${suffix}`,
    status: tenantStatus,
    trialEndsAt:
      tenantStatus === "active"
        ? new Date(BASE_NOW_MS + 7 * 86_400_000)
        : new Date(BASE_NOW_MS - 20 * 86_400_000),
    paidThrough:
      tenantStatus === "active"
        ? new Date(BASE_NOW_MS + 30 * 86_400_000)
        : tenantStatus === "locked"
          ? new Date(BASE_NOW_MS - 5 * 86_400_000)
          : new Date(BASE_NOW_MS - 10 * 86_400_000),
    cacheVersion: 1,
    schemaVersion: 23,
    createdAt: now,
    updatedAt: now,
  });

  const stub = openTenantStoreStub(env.TENANT_STORE as unknown as TenantStoreNamespaceLike, tenantId);
  await runInDurableObject(stub as unknown as DurableObjectStub, async (_instance, state) => {
    await applyTenantMigrations(state.storage as unknown as StorageLike, [
      ...TENANT_MIGRATIONS,
      MEDIA_PIPELINE_MIGRATION,
      PAGES_LAYOUT_MODE_MIGRATION,
      BLOG_AUTHOR_TOC_MODIFIED_MIGRATION,
      CONTENT_REVISION_HISTORY_MIGRATION,
    ]);
  });

  const tenantDb = createTenantDb(stub);
  await tenantDb
    .prepare(
      `INSERT INTO business_profile (id, business_name, business_category, whatsapp_e164, version, updated_at)
       VALUES (1, ?, 'LocalBusiness', '+6281234567890', 1, ?)`,
    )
    .bind(`Bisnis ${suffix}`, BASE_NOW_MS)
    .run();

  return { tenantId, organizationId, handle, tenantDb, owner, editor };
}

async function getTenantCacheVersion(tenantId: string): Promise<number> {
  const row = await env.PLATFORM_DB.prepare(`SELECT cache_version FROM tenants WHERE id = ?`)
    .bind(tenantId)
    .first<{ readonly cache_version: number }>();
  return Number(row?.cache_version ?? 0);
}

async function insertReadyMedia(tenantDb: D1Database, mediaId: number, tenantId: string): Promise<void> {
  await tenantDb
    .prepare(
      `INSERT INTO media_items (
         id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text,
         status, version, created_at, updated_at
       ) VALUES (?, 'image', ?, 'image/webp', 24000, ?, 1200, 800, 'Foto produk', 'ready', 1, ?, ?)`,
    )
    .bind(
      mediaId,
      `t/${tenantId}/media/${mediaId}.webp`,
      `sha256_media_${mediaId}`,
      BASE_NOW_MS,
      BASE_NOW_MS,
    )
    .run();
}

describe("TASK-064: Content Revision History & Safe Draft-Only Restore (workerd integration)", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("retains exact latest 20 revisions per page, post, and catalog offering across 25 saves + publish", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const tenant = await seedTenantWithUsers("01", runtimeEnv);

    // 1. Page: create + 25 draft updates -> 26 writes -> exact latest 20 retained (revs 7..26)
    let page = await createPage(tenant.tenantDb, {
      title: "Halaman Awal v1",
      slug: "halaman-uji-20",
      sections: [
        {
          id: "hero-1",
          kind: "hero",
          heading: "Judul Awal",
          subheading: null,
          bodyHtml: null,
          ctaLabel: "Hubungi",
          ctaHref: "/kontak",
        },
      ],
      actorUserId: tenant.editor.userId,
      nowMs: BASE_NOW_MS,
    });

    for (let i = 1; i <= 25; i += 1) {
      page = await updatePage(tenant.tenantDb, {
        pageId: page.id,
        expectedVersion: page.version,
        title: `Halaman Revisi Simpan #${i + 1}`,
        actorUserId: tenant.editor.userId,
        nowMs: BASE_NOW_MS + i * 1_000,
      });
    }

    const pageRevListRes = await handleTenantRevisionsListRequest(
      tenant.handle,
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.handle}/revisions?resourceType=page&resourceId=${page.id}`,
        "GET",
        { cookie: tenant.editor.cookie },
      ),
      runtimeEnv,
    );
    expect(pageRevListRes.status).toBe(200);
    const pageRevBody = (await pageRevListRes.json()) as {
      items: Array<{ revisionNumber: number; triggerKind: string; summary: string }>;
      maxRetained: number;
    };
    expect(pageRevBody.maxRetained).toBe(MAX_CONTENT_REVISIONS_PER_RESOURCE);
    expect(pageRevBody.items).toHaveLength(20);
    expect(pageRevBody.items[0]?.revisionNumber).toBe(26);
    expect(pageRevBody.items[0]?.triggerKind).toBe("save");
    expect(pageRevBody.items[19]?.revisionNumber).toBe(7);

    // Publish adds rev #27 (`triggerKind = 'publish'`) and still keeps exact 20 (8..27)
    await publishPage(env.PLATFORM_DB, tenant.tenantDb, {
      tenantId: tenant.tenantId,
      pageId: page.id,
      expectedVersion: page.version,
      actorUserId: tenant.owner.userId,
      nowMs: BASE_NOW_MS + 30_000,
    });
    const afterPubPageRevs = await listContentRevisions(tenant.tenantDb, {
      resourceType: "page",
      resourceId: page.id,
    });
    expect(afterPubPageRevs.items).toHaveLength(20);
    expect(afterPubPageRevs.items[0]?.revisionNumber).toBe(27);
    expect(afterPubPageRevs.items[0]?.triggerKind).toBe("publish");
    expect(afterPubPageRevs.items[19]?.revisionNumber).toBe(8);

    // 2. Post: create + 25 draft updates -> exact latest 20 retained (revs 7..26)
    let post = await createPost(
      tenant.tenantDb,
      {
        title: "Artikel Uji 1",
        slug: "artikel-uji-20",
        body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Isi awal artikel." }] },
        nowMs: BASE_NOW_MS,
      },
      { actorUserId: tenant.editor.userId },
    );
    for (let i = 1; i <= 25; i += 1) {
      post = await updatePost(
        tenant.tenantDb,
        {
          postId: post.id,
          expectedVersion: post.version,
          title: `Artikel Uji #${i + 1}`,
          nowMs: BASE_NOW_MS + i * 1_000,
        },
        { actorUserId: tenant.editor.userId },
      );
    }
    const postRevs = await listContentRevisions(tenant.tenantDb, {
      resourceType: "post",
      resourceId: post.id,
    });
    expect(postRevs.items).toHaveLength(20);
    expect(postRevs.items[0]?.revisionNumber).toBe(26);
    expect(postRevs.items[19]?.revisionNumber).toBe(7);

    // 3. Catalog Offering: create + 25 draft updates -> exact latest 20 retained (revs 7..26)
    let offering = await createCatalogOffering(
      tenant.tenantDb,
      {
        offeringType: "service",
        title: "Jasa Audit #1",
        slug: "jasa-audit-20",
        priceMode: "fixed",
        price: 1_500_000,
        ctaMode: "whatsapp",
      },
      { nowMs: BASE_NOW_MS, actorUserId: tenant.editor.userId },
    );
    for (let i = 1; i <= 25; i += 1) {
      offering = await updateCatalogOffering(
        tenant.tenantDb,
        offering.id,
        { title: `Jasa Audit #${i + 1}` },
        {
          expectedVersion: offering.version,
          nowMs: BASE_NOW_MS + i * 1_000,
          actorUserId: tenant.editor.userId,
        },
      );
    }
    const offRevs = await listContentRevisions(tenant.tenantDb, {
      resourceType: "offering",
      resourceId: offering.id,
    });
    expect(offRevs.items).toHaveLength(20);
    expect(offRevs.items[0]?.revisionNumber).toBe(26);
    expect(offRevs.items[19]?.revisionNumber).toBe(7);
  }, 30_000);

  it("restores page, post, and catalog offering strictly as DRAFT ONLY (zero live published mutation & zero cache_version bump) and enforces 409 STALE_VERSION", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const tenant = await seedTenantWithUsers("02", runtimeEnv);

    // --- PAGE ---
    const pageV1 = await createPage(tenant.tenantDb, {
      title: "Halaman Versi Satu",
      slug: "layanan-kami",
      sections: [
        {
          id: "hero-v1",
          kind: "hero",
          heading: "Heading Versi 1",
          subheading: null,
          bodyHtml: null,
          ctaLabel: "Kontak",
          ctaHref: "/kontak",
        },
      ],
      actorUserId: tenant.owner.userId,
      nowMs: BASE_NOW_MS,
    });
    const pageV2 = await updatePage(tenant.tenantDb, {
      pageId: pageV1.id,
      expectedVersion: pageV1.version,
      title: "Halaman Versi Dua (Live)",
      sections: [
        {
          id: "hero-v2",
          kind: "hero",
          heading: "Heading Live V2",
          subheading: null,
          bodyHtml: null,
          ctaLabel: "Kontak",
          ctaHref: "/kontak",
        },
      ],
      actorUserId: tenant.owner.userId,
      nowMs: BASE_NOW_MS + 1_000,
    });
    const pubPage = await publishPage(env.PLATFORM_DB, tenant.tenantDb, {
      tenantId: tenant.tenantId,
      pageId: pageV2.id,
      expectedVersion: pageV2.version,
      actorUserId: tenant.owner.userId,
      nowMs: BASE_NOW_MS + 2_000,
    });

    const cvBeforePageRestore = await getTenantCacheVersion(tenant.tenantId);

    // Stale expectedVersion -> 409 STALE_VERSION with zero writes
    const staleRes = await handleTenantRevisionRestoreRequest(
      tenant.handle,
      formatRevisionId("page", pageV1.id, 1),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.handle}/revisions/${formatRevisionId("page", pageV1.id, 1)}/restore`,
        "POST",
        {
          cookie: tenant.editor.cookie,
          body: { expectedVersion: pubPage.page.version - 1 },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_000 },
    );
    expect(staleRes.status).toBe(409);
    const staleBody = (await staleRes.json()) as { error: { code: string } };
    expect(staleBody.error.code).toBe("STALE_VERSION");

    // Valid restore of revision #1 -> DRAFT ONLY!
    const restorePageRes = await handleTenantRevisionRestoreRequest(
      tenant.handle,
      formatRevisionId("page", pageV1.id, 1),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.handle}/revisions/${formatRevisionId("page", pageV1.id, 1)}/restore`,
        "POST",
        {
          cookie: tenant.editor.cookie,
          body: { expectedVersion: pubPage.page.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4_000 },
    );
    expect(restorePageRes.status).toBe(200);
    const restorePageBody = (await restorePageRes.json()) as {
      restored: boolean;
      draftOnly: boolean;
      version: number;
      status: string;
      hasUnpublishedChanges: boolean;
      newRevisionNumber: number;
    };
    expect(restorePageBody.restored).toBe(true);
    expect(restorePageBody.draftOnly).toBe(true);
    expect(restorePageBody.version).toBe(pubPage.page.version + 1);
    expect(restorePageBody.status).toBe("published");
    expect(restorePageBody.hasUnpublishedChanges).toBe(true);

    // Live published page & cache_version MUST be 100% UNTOUCHED!
    expect(await getTenantCacheVersion(tenant.tenantId)).toBe(cvBeforePageRestore);
    const livePageAfterRestore = await getPublishedPage(tenant.tenantDb, { pageId: pageV1.id });
    expect(livePageAfterRestore?.data.title).toBe("Halaman Versi Dua (Live)");
    expect(livePageAfterRestore?.data.sections[0]?.heading).toBe("Heading Live V2");

    // Admin draft view reflects restored revision #1!
    const draftPageAfterRestore = await getPageById(tenant.tenantDb, pageV1.id);
    expect(draftPageAfterRestore?.title).toBe("Halaman Versi Satu");
    expect(draftPageAfterRestore?.sections[0]?.heading).toBe("Heading Versi 1");
    expect(draftPageAfterRestore?.hasUnpublishedChanges).toBe(true);

    // --- POST ---
    const postV1 = await createPost(
      tenant.tenantDb,
      {
        title: "Artikel V1 Asli",
        slug: "artikel-restorasi",
        body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Konten V1 Asli." }] },
        nowMs: BASE_NOW_MS,
      },
      { actorUserId: tenant.owner.userId },
    );
    const postV2 = await updatePost(
      tenant.tenantDb,
      {
        postId: postV1.id,
        expectedVersion: postV1.version,
        title: "Artikel V2 Live",
        body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Konten V2 Live." }] },
        nowMs: BASE_NOW_MS + 1_000,
      },
      { actorUserId: tenant.owner.userId },
    );
    const pubPost = await publishPost(env.PLATFORM_DB, tenant.tenantDb, {
      tenantId: tenant.tenantId,
      postId: postV2.id,
      expectedVersion: postV2.version,
      actorUserId: tenant.owner.userId,
      nowMs: BASE_NOW_MS + 2_000,
    });
    const cvBeforePostRestore = await getTenantCacheVersion(tenant.tenantId);

    const restorePostRes = await handleTenantRevisionRestoreRequest(
      tenant.handle,
      formatRevisionId("post", postV1.id, 1),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.handle}/revisions/${formatRevisionId("post", postV1.id, 1)}/restore`,
        "POST",
        {
          cookie: tenant.editor.cookie,
          body: { expectedVersion: pubPost.post.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5_000 },
    );
    expect(restorePostRes.status).toBe(200);
    expect(await getTenantCacheVersion(tenant.tenantId)).toBe(cvBeforePostRestore);
    const livePostAfterRestore = await getPublishedPost(tenant.tenantDb, { postId: postV1.id });
    expect(livePostAfterRestore?.data.title).toBe("Artikel V2 Live");
    const draftPostAfterRestore = await getPostById(tenant.tenantDb, postV1.id);
    expect(draftPostAfterRestore?.title).toBe("Artikel V1 Asli");
    expect(draftPostAfterRestore?.hasUnpublishedChanges).toBe(true);

    // --- CATALOG OFFERING ---
    const offV1 = await createCatalogOffering(
      tenant.tenantDb,
      {
        offeringType: "product",
        title: "Produk V1 Awal",
        slug: "produk-restorasi",
        priceMode: "fixed",
        price: 250_000,
        ctaMode: "whatsapp",
      },
      { nowMs: BASE_NOW_MS, actorUserId: tenant.owner.userId },
    );
    const offV2 = await updateCatalogOffering(
      tenant.tenantDb,
      offV1.id,
      { title: "Produk V2 Live", price: 300_000 },
      { expectedVersion: offV1.version, nowMs: BASE_NOW_MS + 1_000, actorUserId: tenant.owner.userId },
    );
    const pubOff = await publishCatalogOffering(env.PLATFORM_DB, tenant.tenantDb, {
      tenantId: tenant.tenantId,
      offeringId: offV2.id,
      expectedVersion: offV2.version,
      actorUserId: tenant.owner.userId,
      nowMs: BASE_NOW_MS + 2_000,
    });
    const cvBeforeOffRestore = await getTenantCacheVersion(tenant.tenantId);

    const restoreOffRes = await handleTenantRevisionRestoreRequest(
      tenant.handle,
      formatRevisionId("offering", offV1.id, 1),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.handle}/revisions/${formatRevisionId("offering", offV1.id, 1)}/restore`,
        "POST",
        {
          cookie: tenant.editor.cookie,
          body: { expectedVersion: pubOff.offering.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6_000 },
    );
    expect(restoreOffRes.status).toBe(200);
    expect(await getTenantCacheVersion(tenant.tenantId)).toBe(cvBeforeOffRestore);

    // Public catalog snapshot STILL serves V2 Live!
    const liveOffAfterRestore = await getPublishedResource(tenant.tenantDb, {
      resourceType: "offering",
      resourceId: offV1.id,
    });
    expect(liveOffAfterRestore?.data.title).toBe("Produk V2 Live");
    expect(liveOffAfterRestore?.data.price).toBe(300_000);

    // Admin draft offering now reflects V1 Awal!
    const draftOffAfterRestore = await getCatalogOfferingById(tenant.tenantDb, offV1.id);
    expect(draftOffAfterRestore?.title).toBe("Produk V1 Awal");
    expect(draftOffAfterRestore?.price).toBe(250_000);
  }, 30_000);

  it("validates snapshot schema (rejecting unsupported/corrupted 422), safely detaches deleted media/taxonomy/author references, and cleans up revisions on hard purge", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const tenant = await seedTenantWithUsers("03", runtimeEnv);

    // Seed media #301 (will be deleted), media #302 (kept), category #40 (will be deleted), author #50 (will be deleted)
    await insertReadyMedia(tenant.tenantDb, 301, tenant.tenantId);
    await insertReadyMedia(tenant.tenantDb, 302, tenant.tenantId);
    await tenant.tenantDb
      .prepare(
        `INSERT INTO taxonomies (id, taxonomy_type, depth, slug, name, sort_order, version, created_at, updated_at)
         VALUES (40, 'post_category', 0, 'kategori-lama', 'Kategori Lama', 0, 1, ?, ?)`,
      )
      .bind(BASE_NOW_MS, BASE_NOW_MS)
      .run();
    await tenant.tenantDb
      .prepare(
        `INSERT INTO authors (id, name, slug, version, created_at, updated_at)
         VALUES (50, 'Penulis Lama', 'penulis-lama', 1, ?, ?)`,
      )
      .bind(BASE_NOW_MS, BASE_NOW_MS)
      .run();

    // Create post referencing media #301 & #302, category #40, author #50 -> rev #1 recorded
    const post = await createPost(
      tenant.tenantDb,
      {
        title: "Artikel Dengan Referensi Media",
        slug: "artikel-media-ref",
        body: {
          schemaVersion: 1,
          blocks: [
            { type: "paragraph", text: "Paragraf tetap utuh." },
            { type: "image", mediaId: 301, text: "Akan dihapus" },
            { type: "image", mediaId: 302, text: "Tetap ada" },
          ],
        },
        coverMediaId: 301,
        primaryCategoryId: 40,
        categoryIds: [40],
        authorId: 50,
        nowMs: BASE_NOW_MS,
      },
      { actorUserId: tenant.owner.userId },
    );

    // Update post to remove references so we can delete media #301, category #40, author #50 cleanly
    const postV2 = await updatePost(
      tenant.tenantDb,
      {
        postId: post.id,
        expectedVersion: post.version,
        title: "Artikel Tanpa Media Lama",
        coverMediaId: 302,
        primaryCategoryId: null,
        categoryIds: [],
        authorId: null,
        body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Versi bersih." }] },
        nowMs: BASE_NOW_MS + 1_000,
      },
      { actorUserId: tenant.owner.userId },
    );

    await tenant.tenantDb.batch([
      tenant.tenantDb.prepare(`DELETE FROM media_items WHERE id = 301`),
      tenant.tenantDb.prepare(`DELETE FROM taxonomies WHERE id = 40`),
      tenant.tenantDb.prepare(`DELETE FROM authors WHERE id = 50`),
    ]);

    // 1. Inspect detail endpoint -> surfaces warnings for missing media #301, category #40, author #50
    const detailRes = await handleTenantRevisionDetailRequest(
      tenant.handle,
      formatRevisionId("post", post.id, 1),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.handle}/revisions/${formatRevisionId("post", post.id, 1)}`,
        "GET",
        { cookie: tenant.owner.cookie },
      ),
      runtimeEnv,
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      referenceReport: {
        missingMediaIds: number[];
        missingTaxonomyIds: number[];
        missingAuthorId: number | null;
        warnings: unknown[];
      };
    };
    expect(detailBody.referenceReport.missingMediaIds).toEqual([301]);
    expect(detailBody.referenceReport.missingTaxonomyIds).toEqual([40]);
    expect(detailBody.referenceReport.missingAuthorId).toBe(50);

    // 2. Restore with detachMissingReferences: false -> rejects 422!
    const strictRejectRes = await handleTenantRevisionRestoreRequest(
      tenant.handle,
      formatRevisionId("post", post.id, 1),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.handle}/revisions/${formatRevisionId("post", post.id, 1)}/restore`,
        "POST",
        {
          cookie: tenant.owner.cookie,
          body: { expectedVersion: postV2.version, detachMissingReferences: false },
        },
      ),
      runtimeEnv,
    );
    expect(strictRejectRes.status).toBe(422);

    // 3. Default restore (`detachMissingReferences: true`) -> succeeds 200, detaches deleted refs cleanly!
    const safeRestoreRes = await handleTenantRevisionRestoreRequest(
      tenant.handle,
      formatRevisionId("post", post.id, 1),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.handle}/revisions/${formatRevisionId("post", post.id, 1)}/restore`,
        "POST",
        {
          cookie: tenant.owner.cookie,
          body: { expectedVersion: postV2.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_000 },
    );
    expect(safeRestoreRes.status).toBe(200);
    const safeBody = (await safeRestoreRes.json()) as {
      version: number;
      warnings: Array<{ kind: string; id: number }>;
      resource: {
        title: string;
        coverMediaId: number | null;
        primaryCategoryId: number | null;
        categoryIds: number[];
        authorId: number | null;
        body: { blocks: unknown[] };
      };
    };
    expect(safeBody.resource.title).toBe("Artikel Dengan Referensi Media");
    expect(safeBody.resource.coverMediaId).toBeNull();
    expect(safeBody.resource.primaryCategoryId).toBeNull();
    expect(safeBody.resource.categoryIds).toEqual([]);
    expect(safeBody.resource.authorId).toBeNull();
    expect(safeBody.resource.body.blocks).toHaveLength(2); // paragraph + valid media #302
    expect(safeBody.warnings.length).toBeGreaterThanOrEqual(3);

    // 4. Unsupported schemaVersion (99) & corrupted JSON revisions MUST be rejected with 422
    await tenant.tenantDb.batch([
      tenant.tenantDb
        .prepare(
          `INSERT INTO content_revisions (resource_type, resource_id, revision_number, snapshot_json, created_by, created_at, trigger_kind, schema_version, summary)
           VALUES ('post', ?, 90, '{"schemaVersion":99,"snapshotVersion":99,"resourceType":"post","data":{}}', ?, ?, 'save', 99, 'Skema masa depan')`,
        )
        .bind(post.id, tenant.owner.userId, BASE_NOW_MS + 3_000),
      tenant.tenantDb
        .prepare(
          `INSERT INTO content_revisions (resource_type, resource_id, revision_number, snapshot_json, created_by, created_at, trigger_kind, schema_version, summary)
           VALUES ('post', ?, 91, '{corrupted_json', ?, ?, 'save', 1, 'Rusak')`,
        )
        .bind(post.id, tenant.owner.userId, BASE_NOW_MS + 4_000),
    ]);

    const unsupportedRes = await handleTenantRevisionRestoreRequest(
      tenant.handle,
      formatRevisionId("post", post.id, 90),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.handle}/revisions/${formatRevisionId("post", post.id, 90)}/restore`,
        "POST",
        { cookie: tenant.owner.cookie, body: { expectedVersion: safeBody.version } },
      ),
      runtimeEnv,
    );
    expect(unsupportedRes.status).toBe(422);

    const corruptedRes = await handleTenantRevisionRestoreRequest(
      tenant.handle,
      formatRevisionId("post", post.id, 91),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.handle}/revisions/${formatRevisionId("post", post.id, 91)}/restore`,
        "POST",
        { cookie: tenant.owner.cookie, body: { expectedVersion: safeBody.version } },
      ),
      runtimeEnv,
    );
    expect(corruptedRes.status).toBe(422);

    // 5. Trash & Hard Purge removes all revisions cleanly (and rejects restore while trashed with 409)
    const trashed = await trashContentItem(env.PLATFORM_DB, tenant.tenantDb, {
      tenantId: tenant.tenantId,
      resourceType: "post",
      resourceId: post.id,
      expectedVersion: safeBody.version,
      actorUserId: tenant.owner.userId,
      actorRole: "owner",
      nowMs: BASE_NOW_MS + 5_000,
    });

    const restoreWhileTrashed = await handleTenantRevisionRestoreRequest(
      tenant.handle,
      formatRevisionId("post", post.id, 1),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.handle}/revisions/${formatRevisionId("post", post.id, 1)}/restore`,
        "POST",
        { cookie: tenant.owner.cookie, body: { expectedVersion: trashed.version } },
      ),
      runtimeEnv,
    );
    expect(restoreWhileTrashed.status).toBe(409);

    const purged = await purgeContentItem(tenant.tenantDb, {
      resourceType: "post",
      resourceId: post.id,
      expectedVersion: trashed.version,
      actorUserId: tenant.owner.userId,
      actorRole: "owner",
      nowMs: BASE_NOW_MS + 6_000,
    });
    expect(purged.purged).toBe(true);
    expect(purged.clearedCounts.revisions).toBeGreaterThanOrEqual(4);

    const remainingAfterPurge = await tenant.tenantDb
      .prepare(`SELECT COUNT(*) AS cnt FROM content_revisions WHERE resource_type = 'post' AND resource_id = ?`)
      .bind(post.id)
      .first<{ readonly cnt: number }>();
    expect(Number(remainingAfterPurge?.cnt ?? 0)).toBe(0);

    // Direct helper verification on a fresh page
    const tempPage = await createPage(tenant.tenantDb, {
      title: "Halaman Sementara",
      slug: "halaman-sementara-purge",
      nowMs: BASE_NOW_MS + 7_000,
    });
    const purgedHelper = await purgeContentRevisionsForResource(tenant.tenantDb, "page", tempPage.id);
    expect(purgedHelper.deletedCount).toBe(1);
  }, 30_000);

  it("enforces cross-tenant 404 isolation, CSRF/Origin 403, unauthenticated 401, locked/suspended 403 SUBSCRIPTION_LOCKED, forbidden tenant selectors 422, and non-app host 404", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const tenantA = await seedTenantWithUsers("04", runtimeEnv, "active");
    const tenantB = await seedTenantWithUsers("05", runtimeEnv, "active");
    const lockedTenant = await seedTenantWithUsers("06", runtimeEnv, "locked");

    const pageA = await createPage(tenantA.tenantDb, {
      title: "Halaman Tenant A",
      slug: "rahasia-a",
      nowMs: BASE_NOW_MS,
    });
    const revIdA = formatRevisionId("page", pageA.id, 1);

    // 1. Cross-tenant list/get/restore by Tenant B owner against Tenant A -> ALL 404!
    const crossList = await handleTenantRevisionsListRequest(
      tenantA.handle,
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/revisions?resourceType=page&resourceId=${pageA.id}`,
        "GET",
        { cookie: tenantB.owner.cookie },
      ),
      runtimeEnv,
    );
    expect(crossList.status).toBe(404);

    const crossGet = await handleTenantRevisionDetailRequest(
      tenantA.handle,
      revIdA,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/revisions/${revIdA}`, "GET", {
        cookie: tenantB.owner.cookie,
      }),
      runtimeEnv,
    );
    expect(crossGet.status).toBe(404);

    const crossRestore = await handleTenantRevisionRestoreRequest(
      tenantA.handle,
      revIdA,
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/revisions/${revIdA}/restore`,
        "POST",
        { cookie: tenantB.owner.cookie, body: { expectedVersion: pageA.version } },
      ),
      runtimeEnv,
    );
    expect(crossRestore.status).toBe(404);

    // 2. CSRF/Origin failure on POST /restore -> 403!
    const badOriginRestore = await handleTenantRevisionRestoreRequest(
      tenantA.handle,
      revIdA,
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/revisions/${revIdA}/restore`,
        "POST",
        {
          cookie: tenantA.owner.cookie,
          origin: "https://evil.example.com",
          body: { expectedVersion: pageA.version },
        },
      ),
      runtimeEnv,
    );
    expect(badOriginRestore.status).toBe(403);

    // 3. Unauthenticated request -> 401!
    const unauthRes = await handleTenantRevisionsListRequest(
      tenantA.handle,
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/revisions?resourceType=page&resourceId=${pageA.id}`,
        "GET",
      ),
      runtimeEnv,
    );
    expect(unauthRes.status).toBe(401);

    // 4. Forbidden tenant selector in body -> 422!
    const forbiddenSelectorRes = await handleTenantRevisionRestoreRequest(
      tenantA.handle,
      revIdA,
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/revisions/${revIdA}/restore`,
        "POST",
        {
          cookie: tenantA.owner.cookie,
          body: { expectedVersion: pageA.version, tenantId: tenantB.tenantId },
        },
      ),
      runtimeEnv,
    );
    expect(forbiddenSelectorRes.status).toBe(422);

    // 5. Non-app host (tenant public domain) -> 404!
    const wrongHostRes = await handleTenantRevisionsListRequest(
      tenantA.handle,
      makeAdminRequest(
        `https://${tenantA.handle}.situsku.click/api/tenants/${tenantA.handle}/revisions?resourceType=page&resourceId=${pageA.id}`,
        "GET",
        { cookie: tenantA.owner.cookie },
      ),
      runtimeEnv,
    );
    expect(wrongHostRes.status).toBe(404);

    // 6. Locked tenant -> GET list works (200), POST restore blocked with 403 SUBSCRIPTION_LOCKED!
    const lockedPage = await createPage(lockedTenant.tenantDb, {
      title: "Halaman Locked",
      slug: "locked-page",
      nowMs: BASE_NOW_MS,
    });
    const lockedRevId = formatRevisionId("page", lockedPage.id, 1);

    const lockedListRes = await handleTenantRevisionsListRequest(
      lockedTenant.handle,
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${lockedTenant.handle}/revisions?resourceType=page&resourceId=${lockedPage.id}`,
        "GET",
        { cookie: lockedTenant.owner.cookie },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedListRes.status).toBe(200);

    const lockedRestoreRes = await handleTenantRevisionRestoreRequest(
      lockedTenant.handle,
      lockedRevId,
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${lockedTenant.handle}/revisions/${lockedRevId}/restore`,
        "POST",
        {
          cookie: lockedTenant.owner.cookie,
          body: { expectedVersion: lockedPage.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedRestoreRes.status).toBe(403);
    const lockedErr = (await lockedRestoreRes.json()) as { error: { code: string } };
    expect(lockedErr.error.code).toBe("SUBSCRIPTION_LOCKED");

    // 6b. Suspended tenant -> POST restore blocked with 403 SUBSCRIPTION_LOCKED!
    const suspendedTenant = await seedTenantWithUsers("07", runtimeEnv, "suspended");
    const suspPage = await createPage(suspendedTenant.tenantDb, {
      title: "Halaman Suspended",
      slug: "suspended-page",
      nowMs: BASE_NOW_MS,
    });
    const suspRestoreRes = await handleTenantRevisionRestoreRequest(
      suspendedTenant.handle,
      formatRevisionId("page", suspPage.id, 1),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${suspendedTenant.handle}/revisions/${formatRevisionId("page", suspPage.id, 1)}/restore`,
        "POST",
        {
          cookie: suspendedTenant.owner.cookie,
          body: { expectedVersion: suspPage.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(suspRestoreRes.status).toBe(403);
    const suspErr = (await suspRestoreRes.json()) as { error: { code: string } };
    expect(suspErr.error.code).toBe("SUBSCRIPTION_LOCKED");

    // 7. Revoked membership (removed from org) -> 404 on subsequent call!
    const platformDrizzle = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await platformDrizzle
      .delete(members)
      .where(eq(members.userId, tenantA.editor.userId));

    const revokedRestore = await handleTenantRevisionRestoreRequest(
      tenantA.handle,
      revIdA,
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/revisions/${revIdA}/restore`,
        "POST",
        {
          cookie: tenantA.editor.cookie,
          body: { expectedVersion: pageA.version },
        },
      ),
      runtimeEnv,
    );
    expect(revokedRestore.status).toBe(404);

    // 8. N4: Content-Length > 16 KiB fails fast with 413 PAYLOAD_TOO_LARGE before buffering
    const oversizedReq = new Request(
      `${APP_ORIGIN}/api/tenants/${tenantA.handle}/revisions/${revIdA}/restore`,
      {
        method: "POST",
        headers: {
          Cookie: tenantA.owner.cookie,
          Origin: APP_ORIGIN,
          "Content-Type": "application/json",
          "Content-Length": "999999",
        },
        body: JSON.stringify({ expectedVersion: pageA.version }),
      },
    );
    const oversizedRes = await handleTenantRevisionRestoreRequest(
      tenantA.handle,
      revIdA,
      oversizedReq,
      runtimeEnv,
    );
    expect(oversizedRes.status).toBe(413);

    // 9. N2: hasContentRevisionHistoryColumns rethrows genuine transient DO/SQL errors
    const transientDb = {
      prepare: () => ({
        all: async () => {
          throw new Error("Transient Durable Object SQLite busy timeout");
        },
      }),
    } as unknown as D1Database;
    await expect(hasContentRevisionHistoryColumns(transientDb)).rejects.toThrow(
      /Transient Durable Object SQLite busy timeout/,
    );
  }, 30_000);

  it("B1/B2 regressions: same-nowMs concurrent page & post restores emit zero orphan revisions/audits/taxonomy churn and page sections strip missing/trashed/quarantined media completely", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const tenant = await seedTenantWithUsers("08", runtimeEnv);

    // --- B1: Same-millisecond concurrent restore race on Page & Draft Post ---
    const pageV1 = await createPage(tenant.tenantDb, {
      title: "Page Race V1",
      slug: "page-race-v1",
      sections: [],
      actorUserId: tenant.owner.userId,
      nowMs: BASE_NOW_MS,
    });
    const pageV2 = await updatePage(tenant.tenantDb, {
      pageId: pageV1.id,
      expectedVersion: pageV1.version,
      title: "Page Race V2",
      actorUserId: tenant.owner.userId,
      nowMs: BASE_NOW_MS + 1_000,
    });

    const raceNowMs = BASE_NOW_MS + 5_000;
    let racedPageOnce = false;
    const racingPageDb = new Proxy(tenant.tenantDb, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!racedPageOnce) {
              racedPageOnce = true;
              // Winner commits the EXACT SAME revision at the EXACT SAME `nowMs` & `expectedVersion`
              // right before the loser's `batch()` executes!
              await restoreContentRevision(target, {
                resourceType: "page",
                resourceId: pageV1.id,
                revisionNumber: 1,
                expectedVersion: pageV2.version,
                actorUserId: tenant.owner.userId,
                actorRole: "owner",
                nowMs: raceNowMs,
              });
            }
            return target.batch(stmts);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(
      restoreContentRevision(racingPageDb, {
        resourceType: "page",
        resourceId: pageV1.id,
        revisionNumber: 1,
        expectedVersion: pageV2.version,
        actorUserId: tenant.editor.userId,
        actorRole: "editor",
        nowMs: raceNowMs,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: "STALE_VERSION" });

    // Confirm ONLY the winner's revision #3 and 1 audit row exist (ZERO orphan rows from loser!)
    const pageRevCount = await tenant.tenantDb
      .prepare(`SELECT COUNT(*) AS cnt FROM content_revisions WHERE resource_type = 'page' AND resource_id = ?`)
      .bind(pageV1.id)
      .first<{ readonly cnt: number }>();
    expect(Number(pageRevCount?.cnt ?? 0)).toBe(3); // v1 create, v2 update, 1 winner restore

    const pageAuditCount = await tenant.tenantDb
      .prepare(
        `SELECT COUNT(*) AS cnt FROM tenant_activity_log
         WHERE action = 'content.revision_restored' AND resource_type = 'page' AND resource_id = ?`,
      )
      .bind(String(pageV1.id))
      .first<{ readonly cnt: number }>();
    expect(Number(pageAuditCount?.cnt ?? 0)).toBe(1);

    // Same-millisecond concurrent restore race on draft Post with taxonomies
    await tenant.tenantDb
      .prepare(
        `INSERT INTO taxonomies (id, taxonomy_type, depth, slug, name, sort_order, version, created_at, updated_at)
         VALUES (80, 'post_category', 0, 'cat-v1', 'Cat V1', 0, 1, ?, ?),
                (81, 'post_category', 0, 'cat-v2', 'Cat V2', 0, 1, ?, ?)`,
      )
      .bind(BASE_NOW_MS, BASE_NOW_MS, BASE_NOW_MS, BASE_NOW_MS)
      .run();

    const postV1 = await createPost(
      tenant.tenantDb,
      {
        title: "Post Race V1",
        slug: "post-race-v1",
        body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "V1" }] },
        categoryIds: [80],
        nowMs: BASE_NOW_MS,
      },
      { actorUserId: tenant.owner.userId },
    );
    const postV2 = await updatePost(
      tenant.tenantDb,
      {
        postId: postV1.id,
        expectedVersion: postV1.version,
        title: "Post Race V2",
        categoryIds: [81],
        nowMs: BASE_NOW_MS + 1_000,
      },
      { actorUserId: tenant.owner.userId },
    );

    let racedPostOnce = false;
    const racingPostDb = new Proxy(tenant.tenantDb, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!racedPostOnce) {
              racedPostOnce = true;
              // Winner restores rev #2 (keeps cat 81) at exact same `nowMs`
              await restoreContentRevision(target, {
                resourceType: "post",
                resourceId: postV1.id,
                revisionNumber: 2,
                expectedVersion: postV2.version,
                actorUserId: tenant.owner.userId,
                actorRole: "owner",
                nowMs: raceNowMs,
              });
            }
            return target.batch(stmts);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    // Loser tries to restore rev #1 (cat 80) -> MUST throw 409 AND NOT clobber winner's cat 81!
    await expect(
      restoreContentRevision(racingPostDb, {
        resourceType: "post",
        resourceId: postV1.id,
        revisionNumber: 1,
        expectedVersion: postV2.version,
        actorUserId: tenant.editor.userId,
        actorRole: "editor",
        nowMs: raceNowMs,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: "STALE_VERSION" });

    const finalPost = await getPostById(tenant.tenantDb, postV1.id);
    expect(finalPost?.categoryIds).toEqual([81]);
    const postAuditCount = await tenant.tenantDb
      .prepare(
        `SELECT COUNT(*) AS cnt FROM tenant_activity_log
         WHERE action = 'content.revision_restored' AND resource_type = 'post' AND resource_id = ?`,
      )
      .bind(String(postV1.id))
      .first<{ readonly cnt: number }>();
    expect(Number(postAuditCount?.cnt ?? 0)).toBe(1);

    // --- B2: Page sections with missing + trashed + quarantined media stripped completely on restore ---
    await insertReadyMedia(tenant.tenantDb, 801, tenant.tenantId);
    await insertReadyMedia(tenant.tenantDb, 802, tenant.tenantId);
    await insertReadyMedia(tenant.tenantDb, 803, tenant.tenantId);
    await tenant.tenantDb
      .prepare(`UPDATE media_items SET deleted_at = ? WHERE id = 802`)
      .bind(BASE_NOW_MS)
      .run();
    await tenant.tenantDb
      .prepare(`UPDATE media_items SET status = 'quarantined' WHERE id = 803`)
      .run();

    const mediaPage = await createPage(tenant.tenantDb, {
      title: "Halaman Galeri Media",
      slug: "halaman-galeri-media",
      sections: [
        {
          id: "rich-1",
          kind: "rich_text",
          heading: "Galeri",
          subheading: null,
          bodyHtml:
            '<p>Konten tetap aman.</p><figure><img src="/media/801" alt="Valid"></figure><figure><img src="/media/802" alt="Trashed"></figure><figure><img src="/media/803" alt="Quarantined"></figure><figure><img src="/media/9999" alt="Missing"></figure>',
        },
      ],
      seo: { ogImageMediaId: 802 },
      nowMs: BASE_NOW_MS,
    });

    const restoredMediaPage = await restoreContentRevision(tenant.tenantDb, {
      resourceType: "page",
      resourceId: mediaPage.id,
      revisionNumber: 1,
      expectedVersion: mediaPage.version,
      actorUserId: tenant.owner.userId,
      actorRole: "owner",
      nowMs: BASE_NOW_MS + 2_000,
    });
    expect(restoredMediaPage.referenceReport.detachedMediaIds).toEqual([802, 803, 9999]);
    const reloadedMediaPage = await getPageById(tenant.tenantDb, mediaPage.id);
    const persistedHtml = reloadedMediaPage?.sections[0]?.bodyHtml ?? "";
    expect(persistedHtml).toContain("/media/801");
    expect(persistedHtml).not.toContain("/media/802");
    expect(persistedHtml).not.toContain("/media/803");
    expect(persistedHtml).not.toContain("/media/9999");
    expect(reloadedMediaPage?.seo?.ogImageMediaId ?? null).toBeNull();
  }, 30_000);
});

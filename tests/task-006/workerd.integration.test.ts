import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
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
  findResourceSlug,
  listResourceSlugsForResource,
  readCurrentSequenceValue,
} from "@punyasitus/db/identifiers/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import { getPublishedPost } from "@punyasitus/db/posts/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantCategoryItemRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/categories/[categoryId].ts";
import { handleTenantCategoriesCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/categories/index.ts";
import { handleTenantPostItemRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId].ts";
import { handleTenantPostPreviewRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/preview.ts";
import { handleTenantPostPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/publish.ts";
import { handleTenantPostRestoreRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/restore.ts";
import { handleTenantPostRevisionsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/revisions.ts";
import { handleTenantPostTrashRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/trash.ts";
import { handleTenantPostUnpublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/unpublish.ts";
import type { TenantBlogRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/_shared.ts";
import { handleTenantPostsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/index.ts";
import { handleTenantTagItemRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/tags/[tagId].ts";
import { handleTenantTagsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/tags/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 22, 16, 0, 0);

function buildRuntimeEnv(overrides: Partial<TenantBlogRuntimeEnv> = {}): TenantBlogRuntimeEnv {
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
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractSessionCookiePair(response: Response): string {
  const cookies = getSetCookies(response.headers);
  const sessionHeader = cookies.find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!sessionHeader) {
    throw new Error(`Expected ${APP_SESSION_COOKIE_NAME} in Set-Cookie, got: ${JSON.stringify(cookies)}`);
  }
  return (sessionHeader.split(";")[0] ?? "").trim();
}

function makeAdminRequest(
  url: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  options: {
    readonly cookie?: string;
    readonly body?: unknown;
    readonly origin?: string | null;
    readonly contentType?: string | null;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) {
    headers.set("Cookie", options.cookie);
  }
  if (method !== "GET") {
    if (options.contentType !== null) {
      headers.set("Content-Type", options.contentType ?? "application/json");
    }
    if (options.origin !== null) {
      headers.set("Origin", options.origin ?? APP_ORIGIN);
    }
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
    applyTenantMigrations(state.storage as unknown as StorageLike, TENANT_MIGRATIONS),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function seedMediaItem(
  tenantDb: D1Database,
  params: {
    readonly id: number;
    readonly tenantId: string;
    readonly kind?: "image" | "video";
    readonly status?: "processing" | "ready" | "failed" | "quarantined";
  },
): Promise<void> {
  const kind = params.kind ?? "image";
  const status = params.status ?? "ready";
  await tenantDb
    .prepare(
      `INSERT INTO media_items (
         id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, status, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 12345, ?, 1200, 630, 'Gambar Artikel', ?, 1, ?, ?)`,
    )
    .bind(
      params.id,
      kind,
      `t/${params.tenantId}/media/${params.id}.webp`,
      kind === "image" ? "image/webp" : "video/mp4",
      "a".repeat(64),
      status,
      BASE_NOW_MS,
      BASE_NOW_MS,
    )
    .run();
}

async function signUpUser(
  email: string,
  name: string,
  runtimeEnv: TenantBlogRuntimeEnv,
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

async function getTenantCacheVersion(tenantId: string): Promise<number> {
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const [row] = await pDb
    .select({ cacheVersion: tenants.cacheVersion })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new Error(`Tenant ${tenantId} not found`);
  return row.cacheVersion;
}

interface ProvisionedTwoTenants {
  readonly tenantA: { readonly id: string; readonly handle: string; readonly orgId: string; readonly db: D1Database };
  readonly tenantB: { readonly id: string; readonly handle: string; readonly orgId: string; readonly db: D1Database };
  readonly ownerA: { readonly userId: string; readonly cookie: string };
  readonly editorA: { readonly userId: string; readonly cookie: string };
  readonly ownerB: { readonly userId: string; readonly cookie: string };
}

async function provisionTwoTenants(
  suffix: string,
  runtimeEnv: TenantBlogRuntimeEnv,
): Promise<ProvisionedTwoTenants> {
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(BASE_NOW_MS);
  const paidThrough = new Date(BASE_NOW_MS + 30 * 24 * 60 * 60 * 1000);

  const tenantAId = `01JT006ALPHA${suffix.toUpperCase().padEnd(14, "0").slice(0, 14)}`;
  const tenantBId = `01JT006BETA0${suffix.toUpperCase().padEnd(14, "0").slice(0, 14)}`;
  const handleA = `alpha-b-${suffix}`;
  const handleB = `beta-b-${suffix}`;
  const orgAId = `org-b-alpha-${suffix}`;
  const orgBId = `org-b-beta-${suffix}`;

  const ownerA = await signUpUser(`b.owner.a.${suffix}@example.test`, "Owner Alpha", runtimeEnv);
  const editorA = await signUpUser(`b.editor.a.${suffix}@example.test`, "Editor Alpha", runtimeEnv);
  const ownerB = await signUpUser(`b.owner.b.${suffix}@example.test`, "Owner Beta", runtimeEnv);

  await db.insert(organizations).values([
    { id: orgAId, name: "Alpha Studio", slug: handleA, createdAt: now, updatedAt: now },
    { id: orgBId, name: "Beta Klinik", slug: handleB, createdAt: now, updatedAt: now },
  ]);

  await db.insert(tenants).values([
    {
      id: tenantAId,
      organizationId: orgAId,
      handle: handleA,
      name: "Alpha Studio",
      status: "active",
      cacheVersion: 1,
      paidThrough,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: tenantBId,
      organizationId: orgBId,
      handle: handleB,
      name: "Beta Klinik",
      status: "active",
      cacheVersion: 1,
      paidThrough,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(members).values([
    { id: `mem-b-oa-${suffix}`, organizationId: orgAId, userId: ownerA.userId, role: "owner", createdAt: now },
    { id: `mem-b-ea-${suffix}`, organizationId: orgAId, userId: editorA.userId, role: "editor", createdAt: now },
    { id: `mem-b-ob-${suffix}`, organizationId: orgBId, userId: ownerB.userId, role: "owner", createdAt: now },
  ]);

  const [dbA, dbB] = await Promise.all([
    openMigratedTenantDb(tenantAId),
    openMigratedTenantDb(tenantBId),
  ]);

  return {
    tenantA: { id: tenantAId, handle: handleA, orgId: orgAId, db: dbA },
    tenantB: { id: tenantBId, handle: handleB, orgId: orgBId, db: dbB },
    ownerA,
    editorA,
    ownerB,
  };
}

describe("TASK-006 workerd integration — Blog Posts, Categories, Tags, Rich Text & Concurrency", () => {
  const runtimeEnv = buildRuntimeEnv();

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("manages blog categories (max depth 3, cycle check, guarded delete) and flat tags with cross-tenant isolation", async () => {
    const fx = await provisionTwoTenants("tax1", runtimeEnv);

    // Create 3-level category hierarchy in Tenant A
    const c1Res = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Kafe Caffè & Kuliner" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(c1Res.status).toBe(201);
    const c1 = (await c1Res.json()) as { id: number; slug: string; depth: number; version: number };
    expect(c1.id).toBe(1);
    expect(c1.slug).toBe("kafe-caffe-kuliner");
    expect(c1.depth).toBe(1);

    // Auto-suffix -2 on duplicate category name
    const cDupRes = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Kafe Caffè & Kuliner" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10 },
    );
    expect(cDupRes.status).toBe(201);
    const cDup = (await cDupRes.json()) as { id: number; slug: string };
    expect(cDup.slug).toBe("kafe-caffe-kuliner-2");

    // Manual slug conflict -> 422 SLUG_CONFLICT
    const cConflictRes = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Lainnya", slug: "kafe-caffe-kuliner" },
      }),
      runtimeEnv,
    );
    expect(cConflictRes.status).toBe(422);

    // Depth 2 & Depth 3 succeed; Depth 4 fails
    const c2Res = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Kopi Nusantara", parentId: c1.id },
      }),
      runtimeEnv,
    );
    expect(c2Res.status).toBe(201);
    const c2 = (await c2Res.json()) as { id: number; depth: number };
    expect(c2.depth).toBe(2);

    const c3Res = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Arabika Gayo", parentId: c2.id },
      }),
      runtimeEnv,
    );
    expect(c3Res.status).toBe(201);
    const c3 = (await c3Res.json()) as { id: number; depth: number };
    expect(c3.depth).toBe(3);

    const c4Res = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Terlalu Dalam", parentId: c3.id },
      }),
      runtimeEnv,
    );
    expect(c4Res.status).toBe(422);

    // Cyclic parent update fails
    const cycleRes = await handleTenantCategoryItemRequest(
      fx.tenantA.handle,
      String(c1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${c1.id}`, "PATCH", {
        cookie: fx.editorA.cookie,
        body: { parentId: c3.id, version: c1.version },
      }),
      runtimeEnv,
    );
    expect(cycleRes.status).toBe(422);

    // Deleting a parent with children fails with 409
    const delParentRes = await handleTenantCategoryItemRequest(
      fx.tenantA.handle,
      String(c1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${c1.id}`, "DELETE", {
        cookie: fx.editorA.cookie,
        body: { version: c1.version },
      }),
      runtimeEnv,
    );
    expect(delParentRes.status).toBe(409);

    // Tags: flat only (parentId rejected)
    const badTagRes = await handleTenantTagsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Promo", parentId: c1.id },
      }),
      runtimeEnv,
    );
    expect(badTagRes.status).toBe(422);

    const t1Res = await handleTenantTagsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Promo UMKM" },
      }),
      runtimeEnv,
    );
    expect(t1Res.status).toBe(201);
    const t1 = (await t1Res.json()) as { id: number; slug: string; kind: string; version: number };
    expect(t1.slug).toBe("promo-umkm");
    expect(t1.kind).toBe("post_tag");

    // Update and delete tag via handleTenantTagItemRequest (including stale version 409 check)
    const t1PatchRes = await handleTenantTagItemRequest(
      fx.tenantA.handle,
      String(t1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags/${t1.id}`, "PATCH", {
        cookie: fx.editorA.cookie,
        body: { name: "Promo Ramadan", slug: "promo-ramadan", version: t1.version },
      }),
      runtimeEnv,
    );
    expect(t1PatchRes.status).toBe(200);
    const t1Updated = (await t1PatchRes.json()) as { id: number; slug: string; version: number };
    expect(t1Updated.slug).toBe("promo-ramadan");
    expect(t1Updated.version).toBe(t1.version + 1);

    const t1StaleDel = await handleTenantTagItemRequest(
      fx.tenantA.handle,
      String(t1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags/${t1.id}`, "DELETE", {
        cookie: fx.editorA.cookie,
        body: { version: t1.version },
      }),
      runtimeEnv,
    );
    expect(t1StaleDel.status).toBe(409);

    const t1Del = await handleTenantTagItemRequest(
      fx.tenantA.handle,
      String(t1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags/${t1.id}`, "DELETE", {
        cookie: fx.editorA.cookie,
        body: { version: t1Updated.version },
      }),
      runtimeEnv,
    );
    expect(t1Del.status).toBe(204);
    expect(await findResourceSlug(fx.tenantA.db, "blog_tag", "promo-ramadan")).toBeNull();

    // Tenant B can independently use the exact same category slug (tenant-local uniqueness)
    const bCatRes = await handleTenantCategoriesCollectionRequest(
      fx.tenantB.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantB.handle}/categories`, "POST", {
        cookie: fx.ownerB.cookie,
        body: { name: "Kafe Caffè & Kuliner" },
      }),
      runtimeEnv,
    );
    expect(bCatRes.status).toBe(201);
    const bCat = (await bCatRes.json()) as { id: number; slug: string };
    expect(bCat.slug).toBe("kafe-caffe-kuliner");

    // Cross-tenant read/write denied with neutral 404
    const crossRead = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "GET", {
        cookie: fx.ownerB.cookie,
      }),
      runtimeEnv,
    );
    expect(crossRead.status).toBe(404);
  });

  it("persists posts with sequential IDs, shared slug rules, sanitized rich text, reading time, author, and owned media", async () => {
    const fx = await provisionTwoTenants("post1", runtimeEnv);

    // Seed categories, tags, and media in Tenant A & Tenant B
    const catA = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { name: "Panduan Bisnis" },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number };

    const tagA = (await (
      await handleTenantTagsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { name: "SEO Lokal" },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number };

    const catB = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantB.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantB.handle}/categories`, "POST", {
          cookie: fx.ownerB.cookie,
          body: { name: "Kategori Beta" },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number };
    expect(catB.id).toBe(1);

    // Media in Tenant A: #10 ready image, #11 processing image, #12 failed image, #13 video
    await seedMediaItem(fx.tenantA.db, { id: 10, tenantId: fx.tenantA.id, status: "ready" });
    await seedMediaItem(fx.tenantA.db, { id: 11, tenantId: fx.tenantA.id, status: "processing" });
    await seedMediaItem(fx.tenantA.db, { id: 12, tenantId: fx.tenantA.id, status: "failed" });
    await seedMediaItem(fx.tenantA.db, { id: 13, tenantId: fx.tenantA.id, kind: "video", status: "ready" });
    // Media in Tenant B: #99 ready image (NOT in Tenant A!)
    await seedMediaItem(fx.tenantB.db, { id: 99, tenantId: fx.tenantB.id, status: "ready" });

    // Create post with hostile rich text, 450 words (~3 min reading time), categories, tags, media, SEO
    const words450 = Array.from({ length: 450 }, (_, i) => `konten${i + 1}`).join(" ");
    const hostileHtml = [
      "<h2>Strategi Digital UMKM</h2>",
      `<p>${words450}</p>`,
      '<script>alert("xss")</script>',
      '<img src="x" onerror="alert(2)">',
      '<svg onload="alert(3)"><circle r="5"/></svg>',
      '<p><a href="javascript:alert(4)">Bahaya</a> dan <a href="https://punyasitus.com/tips" target="_blank">Aman</a></p>',
    ].join("");

    const createRes = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
        cookie: fx.ownerA.cookie,
        body: {
          title: "Kafe Caffè Sêrū: Panduan UMKM!",
          excerpt: "Ringkasan strategi digital.",
          bodyHtml: hostileHtml,
          featuredMediaId: 10,
          primaryCategoryId: catA.id,
          categoryIds: [catA.id],
          tagIds: [tagA.id],
          enableToc: true,
          seo: {
            seoTitle: "Panduan UMKM Digital",
            seoDescription: "Tips lengkap pemasaran online.",
            canonicalOverride: "https://alphastudio.id/blog/kafe-caffe-seru-panduan-umkm",
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(createRes.status).toBe(201);
    const post = (await createRes.json()) as {
      id: number;
      slug: string;
      status: string;
      sanitizedHtml: string;
      readingTimeMinutes: number;
      authorUserId: string;
      authorName: string;
      featuredMediaId: number;
      primaryCategoryId: number;
      categoryIds: number[];
      tagIds: number[];
      toc: Array<{ id: string; text: string; level: number }>;
      version: number;
    };

    expect(post.id).toBe(1);
    expect(post.slug).toBe("kafe-caffe-seru-panduan-umkm");
    expect(post.status).toBe("draft");
    expect(post.readingTimeMinutes).toBe(3);
    expect(post.authorUserId).toBe(fx.ownerA.userId);
    expect(post.authorName).toBe("Owner Alpha");
    expect(post.featuredMediaId).toBe(10);
    expect(post.primaryCategoryId).toBe(catA.id);
    expect(post.categoryIds).toEqual([catA.id]);
    expect(post.tagIds).toEqual([tagA.id]);
    expect(post.toc).toEqual([{ id: "strategi-digital-umkm", text: "Strategi Digital UMKM", level: 2 }]);

    // Hostile HTML stripped completely; safe link carries rel="noopener noreferrer"
    expect(post.sanitizedHtml).toContain("<h2>Strategi Digital UMKM</h2>");
    expect(post.sanitizedHtml).toContain(
      '<a href="https://punyasitus.com/tips" rel="noopener noreferrer" target="_blank">Aman</a>',
    );
    expect(post.sanitizedHtml.toLowerCase()).not.toContain("<script");
    expect(post.sanitizedHtml.toLowerCase()).not.toContain("onerror");
    expect(post.sanitizedHtml.toLowerCase()).not.toContain("<svg");
    expect(post.sanitizedHtml.toLowerCase()).not.toContain("javascript:");

    // Valid same-tenant active member can be assigned as authorUserId
    const assignEditorRes = await handleTenantPostItemRequest(
      fx.tenantA.handle,
      String(post.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${post.id}`, "PATCH", {
        cookie: fx.ownerA.cookie,
        body: { authorUserId: fx.editorA.userId, authorName: null, version: post.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 100 },
    );
    expect(assignEditorRes.status).toBe(200);
    const updatedAuthor = (await assignEditorRes.json()) as { authorUserId: string; authorName: string };
    expect(updatedAuthor.authorUserId).toBe(fx.editorA.userId);
    expect(updatedAuthor.authorName).toBe("Editor Alpha");

    // Cross-tenant author forging MUST fail with 422
    const forgedAuthorRes = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
        cookie: fx.ownerA.cookie,
        body: {
          title: "Artikel Forged Author",
          bodyHtml: "<p>Isi</p>",
          authorUserId: fx.ownerB.userId,
        },
      }),
      runtimeEnv,
    );
    expect(forgedAuthorRes.status).toBe(422);

    // Cross-tenant / failed / video media MUST fail with 422
    for (const badMediaId of [99, 12, 13, 9999]) {
      const badMediaRes = await handleTenantPostsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { title: "Bad Media", bodyHtml: "<p>Isi</p>", featuredMediaId: badMediaId },
        }),
        runtimeEnv,
      );
      expect(badMediaRes.status).toBe(422);
    }

    // Processing media allowed on draft save, REJECTED on publish (422 MEDIA_NOT_READY)
    const procDraftRes = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { title: "Draft Processing Image", bodyHtml: "<p>Isi artikel.</p>", featuredMediaId: 11 },
      }),
      runtimeEnv,
    );
    expect(procDraftRes.status).toBe(201);
    const procDraft = (await procDraftRes.json()) as { id: number; version: number };

    const procPubRes = await handleTenantPostPublishRequest(
      fx.tenantA.handle,
      String(procDraft.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${procDraft.id}/publish`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { version: procDraft.version },
      }),
      runtimeEnv,
    );
    expect(procPubRes.status).toBe(422);

    // Wrong-tenant / wrong-type taxonomy rejection (422)
    const wrongTypeCat = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { title: "Tag As Cat", bodyHtml: "<p>Isi</p>", categoryIds: [tagA.id] },
      }),
      runtimeEnv,
    );
    expect(wrongTypeCat.status).toBe(422);

    const missingCat = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { title: "Missing Cat", bodyHtml: "<p>Isi</p>", categoryIds: [777] },
      }),
      runtimeEnv,
    );
    expect(missingCat.status).toBe(422);

    // Concurrent creates allocate monotonic sequential IDs without collision + auto-suffix -2, -3
    const concurrentCreates = await Promise.all(
      [1, 2, 3].map(() =>
        handleTenantPostsCollectionRequest(
          fx.tenantA.handle,
          makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
            cookie: fx.ownerA.cookie,
            body: { title: "Judul Sama", bodyHtml: "<p>Paragraf</p>" },
          }),
          runtimeEnv,
        ),
      ),
    );
    expect(concurrentCreates.every((r) => r.status === 201)).toBe(true);
    const createdPosts = (await Promise.all(
      concurrentCreates.map((r) => r.json()),
    )) as Array<{ id: number; slug: string }>;
    const ids = createdPosts.map((p) => p.id).sort((a, b) => a - b);
    expect(new Set(ids).size).toBe(3);
    const slugs = createdPosts.map((p) => p.slug).sort();
    expect(slugs).toEqual(["judul-sama", "judul-sama-2", "judul-sama-3"]);
  });

  it("enforces draft isolation, private preview headers, atomic publish/unpublish cache_version bump, former-slug redirect, and trash/restore", async () => {
    const fx = await provisionTwoTenants("pub1", runtimeEnv);

    const createRes = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { title: "Artikel Pertama", bodyHtml: "<p>Versi publik pertama.</p>" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: number; slug: string; version: number };

    // Draft MUST NOT be visible to public loader
    expect(await getPublishedPost(fx.tenantA.db, { postId: created.id })).toBeNull();
    expect(await getPublishedPost(fx.tenantA.db, { slug: created.slug })).toBeNull();

    // Private preview returns no-store & noindex and blocks unauthenticated / cross-tenant
    const unauthPreview = await handleTenantPostPreviewRequest(
      fx.tenantA.handle,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${created.id}/preview`, "GET"),
      runtimeEnv,
    );
    expect(unauthPreview.status).toBe(401);

    const crossPreview = await handleTenantPostPreviewRequest(
      fx.tenantA.handle,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${created.id}/preview`, "GET", {
        cookie: fx.ownerB.cookie,
      }),
      runtimeEnv,
    );
    expect(crossPreview.status).toBe(404);

    const previewRes = await handleTenantPostPreviewRequest(
      fx.tenantA.handle,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${created.id}/preview`, "GET", {
        cookie: fx.ownerA.cookie,
      }),
      runtimeEnv,
    );
    expect(previewRes.status).toBe(200);
    expect(previewRes.headers.get("Cache-Control")).toBe("no-store");
    expect(previewRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const previewData = (await previewRes.json()) as {
      preview: boolean;
      published: unknown;
      hasUnpublishedChanges: boolean;
      sanitizedHtml: string;
    };
    expect(previewData.preview).toBe(true);
    expect(previewData.published).toBeNull();
    expect(previewData.hasUnpublishedChanges).toBe(true);
    expect(previewData.sanitizedHtml).toContain("<p>Versi publik pertama.</p>");

    // Publish atomically bumps cache_version and records revision #1
    const cvBefore = await getTenantCacheVersion(fx.tenantA.id);
    const pubRes = await handleTenantPostPublishRequest(
      fx.tenantA.handle,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${created.id}/publish`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { version: created.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1000 },
    );
    expect(pubRes.status).toBe(200);
    const published = (await pubRes.json()) as {
      version: number;
      status: string;
      cacheVersion: number;
      revisionNumber: number;
      contentModifiedAt: string;
    };
    expect(published.status).toBe("published");
    expect(published.cacheVersion).toBe(cvBefore + 1);
    expect(published.revisionNumber).toBe(1);
    expect(await getTenantCacheVersion(fx.tenantA.id)).toBe(cvBefore + 1);

    // Draft edit after publish MUST NOT leak to public snapshot
    const editRes = await handleTenantPostItemRequest(
      fx.tenantA.handle,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${created.id}`, "PATCH", {
        cookie: fx.ownerA.cookie,
        body: { title: "Draf Rahasia Belum Rilis", version: published.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2000 },
    );
    expect(editRes.status).toBe(200);
    const edited = (await editRes.json()) as { version: number; title: string; hasUnpublishedChanges: boolean };
    expect(edited.title).toBe("Draf Rahasia Belum Rilis");
    expect(edited.hasUnpublishedChanges).toBe(true);

    const livePost = await getPublishedPost(fx.tenantA.db, { postId: created.id });
    expect(livePost?.data.title).toBe("Artikel Pertama");

    // Changing slug after first publish requires confirmSlugChange: true
    const unconfirmedSlugRes = await handleTenantPostItemRequest(
      fx.tenantA.handle,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${created.id}`, "PATCH", {
        cookie: fx.ownerA.cookie,
        body: { slug: "artikel-baru", version: edited.version },
      }),
      runtimeEnv,
    );
    expect(unconfirmedSlugRes.status).toBe(422);

    const confirmedSlugRes = await handleTenantPostItemRequest(
      fx.tenantA.handle,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${created.id}`, "PATCH", {
        cookie: fx.ownerA.cookie,
        body: { slug: "artikel-baru", confirmSlugChange: true, version: edited.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3000 },
    );
    expect(confirmedSlugRes.status).toBe(200);
    const renamed = (await confirmedSlugRes.json()) as { version: number; slug: string; formerSlugs: string[] };
    expect(renamed.slug).toBe("artikel-baru");
    expect(renamed.formerSlugs).toContain("artikel-pertama");

    const formerRow = await findResourceSlug(fx.tenantA.db, "blog", "artikel-pertama");
    expect(formerRow?.isCurrent).toBe(false);
    expect(formerRow?.redirectTargetSlug).toBe("artikel-baru");

    // Revisions list works
    const revRes = await handleTenantPostRevisionsRequest(
      fx.tenantA.handle,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${created.id}/revisions`, "GET", {
        cookie: fx.ownerA.cookie,
      }),
      runtimeEnv,
    );
    expect(revRes.status).toBe(200);
    const revData = (await revRes.json()) as { items: Array<{ revisionNumber: number }> };
    expect(revData.items.length).toBe(1);

    // Unpublish removes public snapshot and bumps cache_version
    const cvBeforeUnpub = await getTenantCacheVersion(fx.tenantA.id);
    const unpubRes = await handleTenantPostUnpublishRequest(
      fx.tenantA.handle,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${created.id}/unpublish`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { version: renamed.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4000 },
    );
    expect(unpubRes.status).toBe(200);
    const unpub = (await unpubRes.json()) as { version: number; status: string; cacheVersion: number };
    expect(unpub.status).toBe("draft");
    expect(unpub.cacheVersion).toBe(cvBeforeUnpub + 1);
    expect(await getPublishedPost(fx.tenantA.db, { postId: created.id })).toBeNull();

    // Trash & restore -> restored post is draft ONLY (never auto-published) and ID is never reused
    const trashRes = await handleTenantPostTrashRequest(
      fx.tenantA.handle,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${created.id}/trash`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { version: unpub.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );
    expect(trashRes.status).toBe(200);
    const trashed = (await trashRes.json()) as { version: number; status: string; deletedAt: string | null };
    expect(trashed.status).toBe("trashed");
    expect(trashed.deletedAt).not.toBeNull();

    const seqBefore = await readCurrentSequenceValue(fx.tenantA.db, "post");
    const restoreRes = await handleTenantPostRestoreRequest(
      fx.tenantA.handle,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${created.id}/restore`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { version: trashed.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6000 },
    );
    expect(restoreRes.status).toBe(200);
    const restored = (await restoreRes.json()) as { status: string; deletedAt: string | null };
    expect(restored.status).toBe("draft");
    expect(restored.deletedAt).toBeNull();
    expect(await getPublishedPost(fx.tenantA.db, { postId: created.id })).toBeNull();
    expect(await readCurrentSequenceValue(fx.tenantA.db, "post")).toBe(seqBefore);
  });

  it("handles real concurrent PATCH races on posts and categories with [200, 409] and ZERO orphan rows", async () => {
    const fx = await provisionTwoTenants("race1", runtimeEnv);

    // Create 2 categories and 2 tags
    const [cat1, cat2, tag1, tag2] = (await Promise.all([
      handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { name: "Cat One" },
        }),
        runtimeEnv,
      ).then((r) => r.json()),
      handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { name: "Cat Two" },
        }),
        runtimeEnv,
      ).then((r) => r.json()),
      handleTenantTagsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { name: "Tag One" },
        }),
        runtimeEnv,
      ).then((r) => r.json()),
      handleTenantTagsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { name: "Tag Two" },
        }),
        runtimeEnv,
      ).then((r) => r.json()),
    ])) as Array<{ id: number; version: number; slug: string }>;

    const post = (await (
      await handleTenantPostsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
          cookie: fx.ownerA.cookie,
          body: {
            title: "Race Target",
            slug: "race-initial",
            bodyHtml: "<p>Initial</p>",
            categoryIds: [cat1!.id],
            tagIds: [tag1!.id],
          },
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS },
      )
    ).json()) as { id: number; version: number };

    // Fire two concurrent PATCHes with IDENTICAL expectedVersion AND identical nowMs, changing slug + taxonomies!
    const [r1, r2] = await Promise.all([
      handleTenantPostItemRequest(
        fx.tenantA.handle,
        String(post.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${post.id}`, "PATCH", {
          cookie: fx.ownerA.cookie,
          body: {
            title: "Winner A",
            slug: "race-winner-a",
            categoryIds: [cat1!.id],
            tagIds: [tag1!.id],
            expectedVersion: post.version,
          },
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 500 },
      ),
      handleTenantPostItemRequest(
        fx.tenantA.handle,
        String(post.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${post.id}`, "PATCH", {
          cookie: fx.ownerA.cookie,
          body: {
            title: "Winner B",
            slug: "race-winner-b",
            categoryIds: [cat2!.id],
            tagIds: [tag2!.id],
            expectedVersion: post.version,
          },
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 500 },
      ),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const winnerRes = r1.status === 200 ? r1 : r2;
    const winner = (await winnerRes.json()) as {
      slug: string;
      categoryIds: number[];
      tagIds: number[];
      version: number;
    };
    expect(winner.version).toBe(post.version + 1);

    // Verify ZERO orphan rows in `resource_slugs` (only the winning slug exists for this draft post!)
    const postSlugs = await listResourceSlugsForResource(fx.tenantA.db, "blog", post.id);
    expect(postSlugs.length).toBe(1);
    expect(postSlugs[0]?.slug).toBe(winner.slug);

    // Verify ZERO orphan rows in `post_taxonomies` (matches ONLY the winning request's taxonomies!)
    const ptRows = await fx.tenantA.db
      .prepare(`SELECT taxonomy_id FROM post_taxonomies WHERE post_id = ? ORDER BY taxonomy_id ASC`)
      .bind(post.id)
      .all<{ readonly taxonomy_id: number }>();
    const actualTaxIds = ptRows.results.map((r) => Number(r.taxonomy_id)).sort((a, b) => a - b);
    const expectedTaxIds = [...winner.categoryIds, ...winner.tagIds].sort((a, b) => a - b);
    expect(actualTaxIds).toEqual(expectedTaxIds);

    // Also test concurrent PATCH race on a category changing slug
    const [cRace1, cRace2] = await Promise.all([
      handleTenantCategoryItemRequest(
        fx.tenantA.handle,
        String(cat1!.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${cat1!.id}`, "PATCH", {
          cookie: fx.ownerA.cookie,
          body: { name: "Cat Alpha", slug: "cat-alpha-win", expectedVersion: cat1!.version },
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 600 },
      ),
      handleTenantCategoryItemRequest(
        fx.tenantA.handle,
        String(cat1!.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${cat1!.id}`, "PATCH", {
          cookie: fx.ownerA.cookie,
          body: { name: "Cat Beta", slug: "cat-beta-win", expectedVersion: cat1!.version },
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 600 },
      ),
    ]);
    expect([cRace1.status, cRace2.status].sort((a, b) => a - b)).toEqual([200, 409]);
    const catWinner = (await (cRace1.status === 200 ? cRace1 : cRace2).json()) as { slug: string };
    const catSlugs = await listResourceSlugsForResource(fx.tenantA.db, "blog_category", cat1!.id);
    expect(catSlugs.length).toBe(1);
    expect(catSlugs[0]?.slug).toBe(catWinner.slug);
  });

  it("enforces host isolation (404), CSRF/Origin (403), locked/suspended guards (403), forbidden selectors & unknown fields (422)", async () => {
    const fx = await provisionTwoTenants("sec1", runtimeEnv);

    // 1. Wrong host (tenant public host & console host) -> neutral 404
    const wrongHostTenant = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`https://${fx.tenantA.handle}.situsku.click/api/tenants/${fx.tenantA.handle}/posts`, "GET", {
        cookie: fx.ownerA.cookie,
      }),
      runtimeEnv,
    );
    expect(wrongHostTenant.status).toBe(404);

    const wrongHostConsole = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`https://console.punyasitus.com/api/tenants/${fx.tenantA.handle}/posts`, "GET", {
        cookie: fx.ownerA.cookie,
      }),
      runtimeEnv,
    );
    expect(wrongHostConsole.status).toBe(404);

    // 2. Missing / cross-origin Origin on POST -> 403
    const crossOrigin = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
        cookie: fx.ownerA.cookie,
        origin: "https://evil.example",
        body: { title: "CSRF", bodyHtml: "<p>x</p>" },
      }),
      runtimeEnv,
    );
    expect(crossOrigin.status).toBe(403);

    // 3. Forbidden tenant selector & unknown field -> 422
    const forbiddenSelector = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { title: "Inject", bodyHtml: "<p>x</p>", tenantId: fx.tenantB.id },
      }),
      runtimeEnv,
    );
    expect(forbiddenSelector.status).toBe(422);

    const unknownField = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { title: "Unknown", bodyHtml: "<p>x</p>", unexpectedExtra: true },
      }),
      runtimeEnv,
    );
    expect(unknownField.status).toBe(422);

    // 4. Locked tenant (H+5 after paidThrough): GET succeeds (200), writes blocked (403 SUBSCRIPTION_LOCKED)
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const fiveDaysAgo = new Date(BASE_NOW_MS - 5 * 24 * 60 * 60 * 1000);
    await pDb
      .update(tenants)
      .set({ status: "locked", paidThrough: fiveDaysAgo })
      .where(eq(tenants.id, fx.tenantA.id));

    const lockedRead = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "GET", {
        cookie: fx.ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedRead.status).toBe(200);

    const lockedWrite = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { title: "Locked Write", bodyHtml: "<p>x</p>" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedWrite.status).toBe(403);

    const lockedCatWrite = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { name: "Locked Cat" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedCatWrite.status).toBe(403);

    // 5. Suspended tenant (H+10 after paidThrough): both reads and writes blocked (403 SUBSCRIPTION_LOCKED)
    const tenDaysAgo = new Date(BASE_NOW_MS - 10 * 24 * 60 * 60 * 1000);
    await pDb
      .update(tenants)
      .set({ status: "suspended", paidThrough: tenDaysAgo })
      .where(eq(tenants.id, fx.tenantA.id));

    const suspendedRead = await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "GET", {
        cookie: fx.ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(suspendedRead.status).toBe(403);
  });
});

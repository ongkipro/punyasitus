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
  allocateNextSequenceId,
  findResourceSlug,
  listResourceSlugsForResource,
  readCurrentSequenceValue,
} from "@punyasitus/db/identifiers/index";
import {
  getPublishedPage,
  PAGES_LAYOUT_MODE_MIGRATION,
} from "@punyasitus/db/pages/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantPageItemRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId].ts";
import { handleTenantPagePreviewRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/preview.ts";
import { handleTenantPagePublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/publish.ts";
import { handleTenantPageRestoreRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/restore.ts";
import { handleTenantPageRevisionsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/revisions.ts";
import { handleTenantPageTrashRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/trash.ts";
import { handleTenantPageUnpublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/unpublish.ts";
import { handleTenantPagesCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/index.ts";
import type { TenantPagesRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/_shared.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 22, 15, 0, 0);

function buildRuntimeEnv(overrides: Partial<TenantPagesRuntimeEnv> = {}): TenantPagesRuntimeEnv {
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

async function openMigratedTenantDb(
  tenantId: string,
  options: { readonly includeLayoutModeMigration?: boolean } = {},
): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  const migrations =
    options.includeLayoutModeMigration === false
      ? TENANT_MIGRATIONS
      : [...TENANT_MIGRATIONS, PAGES_LAYOUT_MODE_MIGRATION];
  await runInDurableObject(rawDoStub, (_instance, state) =>
    applyTenantMigrations(state.storage as unknown as StorageLike, migrations),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function signUpUser(
  email: string,
  name: string,
  runtimeEnv: TenantPagesRuntimeEnv,
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
  runtimeEnv: TenantPagesRuntimeEnv,
  options: { readonly includeLayoutModeMigration?: boolean } = {},
): Promise<ProvisionedTwoTenants> {
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(BASE_NOW_MS);
  const paidThrough = new Date(BASE_NOW_MS + 30 * 24 * 60 * 60 * 1000);

  const tenantAId = `01JT005ALPHA${suffix.toUpperCase().padEnd(14, "0").slice(0, 14)}`;
  const tenantBId = `01JT005BETA0${suffix.toUpperCase().padEnd(14, "0").slice(0, 14)}`;
  const handleA = `alpha-p-${suffix}`;
  const handleB = `beta-p-${suffix}`;
  const orgAId = `org-p-alpha-${suffix}`;
  const orgBId = `org-p-beta-${suffix}`;

  const ownerA = await signUpUser(`p.owner.a.${suffix}@example.test`, "Owner Alpha", runtimeEnv);
  const editorA = await signUpUser(`p.editor.a.${suffix}@example.test`, "Editor Alpha", runtimeEnv);
  const ownerB = await signUpUser(`p.owner.b.${suffix}@example.test`, "Owner Beta", runtimeEnv);

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
    {
      id: `mem-p-oa-${suffix}`,
      organizationId: orgAId,
      userId: ownerA.userId,
      role: "owner",
      createdAt: now,
    },
    {
      id: `mem-p-ea-${suffix}`,
      organizationId: orgAId,
      userId: editorA.userId,
      role: "editor",
      createdAt: now,
    },
    {
      id: `mem-p-ob-${suffix}`,
      organizationId: orgBId,
      userId: ownerB.userId,
      role: "owner",
      createdAt: now,
    },
  ]);

  const [dbA, dbB] = await Promise.all([
    openMigratedTenantDb(tenantAId, options),
    openMigratedTenantDb(tenantBId, options),
  ]);

  return {
    tenantA: { id: tenantAId, handle: handleA, orgId: orgAId, db: dbA },
    tenantB: { id: tenantBId, handle: handleB, orgId: orgBId, db: dbB },
    ownerA,
    editorA,
    ownerB,
  };
}

describe("TASK-005 workerd integration — Static Pages Manager API, Sequential IDs & Shared Slug Engine", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("allocates strictly monotonic per-tenant sequential IDs under concurrency without reuse after delete, plus auto-slug diacritics, -2 suffixing, 80-char cap & fallback", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const { tenantA, ownerA } = await provisionTwoTenants("01", runtimeEnv);

    // 1. Concurrent creates with identical diacritic title + long title + non-ASCII fallback title
    const concurrentBodies = [
      { title: "Kafe Caffè Sêrū" },
      { title: "Kafe Caffè Sêrū" },
      { title: "Kafe Caffè Sêrū" },
      {
        title:
          "Panduan Lengkap Memilih Paket Wisata Keluarga Bali Lombok Nusa Penida Terbaik Sepanjang Tahun 2026",
      },
      { title: "🎉🔥✨ 日本語タイトル" },
      { title: "Blog" }, // Reserved title -> must auto-suffix to `blog-2`
    ];

    const responses = await Promise.all(
      concurrentBodies.map((body, idx) =>
        handleTenantPagesCollectionRequest(
          tenantA.handle,
          makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
            cookie: ownerA.cookie,
            body,
          }),
          runtimeEnv,
          { nowMs: BASE_NOW_MS + idx },
        ),
      ),
    );

    const createdPages = await Promise.all(
      responses.map(async (res) => {
        expect(res.status).toBe(201);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        return (await res.json()) as {
          id: number;
          slug: string;
          title: string;
          status: string;
          version: number;
          layoutMode: string;
        };
      }),
    );

    // Strictly monotonic unique IDs 1..6 with zero collisions
    const ids = createdPages.map((p) => p.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6]);

    // Check diacritic normalization + -2, -3 suffixing
    const kafeSlugs = createdPages
      .filter((p) => p.title === "Kafe Caffè Sêrū")
      .map((p) => p.slug)
      .sort();
    expect(kafeSlugs).toEqual(["kafe-caffe-seru", "kafe-caffe-seru-2", "kafe-caffe-seru-3"]);

    // Check 80-character cap
    const longPage = createdPages.find((p) => p.title.startsWith("Panduan Lengkap"));
    expect(longPage).toBeDefined();
    expect(longPage!.slug.length).toBeLessThanOrEqual(80);
    expect(longPage!.slug.endsWith("-")).toBe(false);

    // Check non-ASCII fallback `<prefix>-<id>`
    const emojiPage = createdPages.find((p) => p.title.includes("日本語"));
    expect(emojiPage).toBeDefined();
    expect(emojiPage!.slug).toBe(`halaman-${emojiPage!.id}`);

    // Check reserved title auto-suffixed to `blog-2`
    const blogTitlePage = createdPages.find((p) => p.title === "Blog");
    expect(blogTitlePage?.slug).toBe("blog-2");

    // 2. Soft-delete highest ID (#6) and verify next create gets #7 (NEVER reuses deleted #6!)
    const deleteRes = await handleTenantPageItemRequest(
      tenantA.handle,
      "6",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/6`, "DELETE", {
        cookie: ownerA.cookie,
        body: { version: 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 100 },
    );
    expect(deleteRes.status).toBe(204);

    const afterDeleteRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        body: { title: "Halaman Baru Setelah Hapus" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 200 },
    );
    expect(afterDeleteRes.status).toBe(201);
    const afterDeletePage = (await afterDeleteRes.json()) as { id: number; slug: string };
    expect(afterDeletePage.id).toBe(7);
    expect(await readCurrentSequenceValue(tenantA.db, "page")).toBe(7);

    // 3. Shared sequence allocator works independently for other resource kinds too
    const [postId1, postId2, offeringId1] = await Promise.all([
      allocateNextSequenceId(tenantA.db, "post"),
      allocateNextSequenceId(tenantA.db, "post"),
      allocateNextSequenceId(tenantA.db, "offering"),
    ]);
    expect([postId1, postId2].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(offeringId1).toBe(1);
  });

  it("enforces manual slug 422 SLUG_CONFLICT, reserved slug 422, published slug-change confirmation + former slug preservation, and tenant-local isolation across two TenantStore DOs", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const { tenantA, tenantB, ownerA, ownerB } = await provisionTwoTenants("02", runtimeEnv);

    // 1. Reserved manual slugs return 422 RESERVED_SLUG
    for (const reserved of ["api", "dashboard", "sitemap.xml", ".well-known", "_astro", "produk"]) {
      const res = await handleTenantPagesCollectionRequest(
        tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
          cookie: ownerA.cookie,
          body: { title: "Halaman Uji", slug: reserved },
        }),
        runtimeEnv,
      );
      expect(res.status).toBe(422);
      const err = (await res.json()) as { error: { code: string; fields?: { code: string }[] } };
      expect(err.error.code).toBe("VALIDATION_ERROR");
      expect(err.error.fields?.[0]?.code).toBe("RESERVED_SLUG");
    }

    // 2. Create draft page in Tenant A with manual slug `promo-lebaran`
    const createRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        body: { title: "Promo Lebaran", slug: "promo-lebaran" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(createRes.status).toBe(201);
    const page1 = (await createRes.json()) as { id: number; slug: string; version: number };
    expect(page1.slug).toBe("promo-lebaran");

    // 3. Manual duplicate slug returns 422 SLUG_CONFLICT (NEVER silently renames!)
    const conflictRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        body: { title: "Promo Lain", slug: "promo-lebaran" },
      }),
      runtimeEnv,
    );
    expect(conflictRes.status).toBe(422);
    const conflictBody = (await conflictRes.json()) as {
      error: { code: string; message: string; fields?: { field: string; code: string }[] };
    };
    expect(conflictBody.error.fields?.[0]?.code).toBe("SLUG_CONFLICT");
    expect(conflictBody.error.message).toContain("promo-lebaran-2");

    // 4. Free slug edit while still draft (never published) succeeds WITHOUT confirmSlugChange
    const freeRenameRes = await handleTenantPageItemRequest(
      tenantA.handle,
      String(page1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${page1.id}`, "PATCH", {
        cookie: ownerA.cookie,
        body: { slug: "promo-awal", version: page1.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10 },
    );
    expect(freeRenameRes.status).toBe(200);
    const renamedDraft = (await freeRenameRes.json()) as {
      slug: string;
      version: number;
      formerSlugs: string[];
    };
    expect(renamedDraft.slug).toBe("promo-awal");
    expect(renamedDraft.formerSlugs).toEqual([]);
    // Unpublished draft slug `promo-lebaran` was freed cleanly (no orphan redirect row)
    expect(await findResourceSlug(tenantA.db, "pages", "promo-lebaran")).toBeNull();

    // 5. Publish page #1 at `promo-awal`
    const pubRes = await handleTenantPagePublishRequest(
      tenantA.handle,
      String(page1.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${page1.id}/publish`,
        "POST",
        {
          cookie: ownerA.cookie,
          body: { version: renamedDraft.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 20 },
    );
    expect(pubRes.status).toBe(200);
    const published = (await pubRes.json()) as { version: number; status: string };
    expect(published.status).toBe("published");

    // 6. Changing slug AFTER first publication WITHOUT confirmSlugChange fails 422
    const unconfirmedRes = await handleTenantPageItemRequest(
      tenantA.handle,
      String(page1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${page1.id}`, "PATCH", {
        cookie: ownerA.cookie,
        body: { slug: "promo-ramadan", version: published.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 30 },
    );
    expect(unconfirmedRes.status).toBe(422);
    const unconfirmedBody = (await unconfirmedRes.json()) as {
      error: { fields?: { code: string }[] };
    };
    expect(unconfirmedBody.error.fields?.[0]?.code).toBe("SLUG_CHANGE_CONFIRMATION_REQUIRED");

    // 7. Changing slug AFTER first publication WITH confirmSlugChange: true demotes old slug to is_current = 0
    const confirmedRes = await handleTenantPageItemRequest(
      tenantA.handle,
      String(page1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${page1.id}`, "PATCH", {
        cookie: ownerA.cookie,
        body: {
          slug: "promo-ramadan",
          confirmSlugChange: true,
          version: published.version,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 40 },
    );
    expect(confirmedRes.status).toBe(200);
    const movedPage = (await confirmedRes.json()) as {
      slug: string;
      formerSlugs: string[];
      version: number;
    };
    expect(movedPage.slug).toBe("promo-ramadan");
    expect(movedPage.formerSlugs).toEqual(["promo-awal"]);

    const oldSlugRow = await findResourceSlug(tenantA.db, "pages", "promo-awal");
    const newSlugRow = await findResourceSlug(tenantA.db, "pages", "promo-ramadan");
    expect(oldSlugRow).toMatchObject({
      namespace: "pages",
      slug: "promo-awal",
      resourceId: page1.id,
      isCurrent: false,
      redirectTargetSlug: "promo-ramadan",
    });
    expect(newSlugRow).toMatchObject({
      namespace: "pages",
      slug: "promo-ramadan",
      resourceId: page1.id,
      isCurrent: true,
      redirectTargetSlug: null,
    });

    // 8. Tenant A CANNOT reuse its own former slug `promo-awal` manually (422 SLUG_CONFLICT)
    const reuseFormerManualRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        body: { title: "Halaman Kedua", slug: "promo-awal" },
      }),
      runtimeEnv,
    );
    expect(reuseFormerManualRes.status).toBe(422);
    const reuseFormerErr = (await reuseFormerManualRes.json()) as {
      error: { fields?: { code: string }[] };
    };
    expect(reuseFormerErr.error.fields?.[0]?.code).toBe("SLUG_CONFLICT");

    // Auto-generating from title "Promo Awal" in Tenant A skips former slug -> `promo-awal-2`
    const reuseFormerAutoRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        body: { title: "Promo Awal" },
      }),
      runtimeEnv,
    );
    expect(reuseFormerAutoRes.status).toBe(201);
    const autoSkippedPage = (await reuseFormerAutoRes.json()) as { slug: string };
    expect(autoSkippedPage.slug).toBe("promo-awal-2");

    // 9. Tenant B (physically isolated TenantStore DO) CAN use Tenant A's current AND former slugs!
    const tenantBFormerRes = await handleTenantPagesCollectionRequest(
      tenantB.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/pages`, "POST", {
        cookie: ownerB.cookie,
        body: { title: "Promo Awal Beta", slug: "promo-awal" },
      }),
      runtimeEnv,
    );
    expect(tenantBFormerRes.status).toBe(201);
    expect(((await tenantBFormerRes.json()) as { slug: string }).slug).toBe("promo-awal");

    const tenantBCurrentRes = await handleTenantPagesCollectionRequest(
      tenantB.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/pages`, "POST", {
        cookie: ownerB.cookie,
        body: { title: "Promo Ramadan Beta", slug: "promo-ramadan" },
      }),
      runtimeEnv,
    );
    expect(tenantBCurrentRes.status).toBe(201);
    expect(((await tenantBCurrentRes.json()) as { slug: string }).slug).toBe("promo-ramadan");
  });

  it("supports layoutMode (standard vs focused), SEO overrides, private draft preview isolation, atomic publish/unpublish cache_version bumps, stale 409, trash/restore & status filtering", async () => {
    const runtimeEnv = buildRuntimeEnv();
    // Deliberately omit 0003 migration here to verify idempotent auto-heal (`ensurePagesLayoutModeColumn`)!
    const { tenantA, ownerA, editorA } = await provisionTwoTenants("03", runtimeEnv, {
      includeLayoutModeMigration: false,
    });

    const initialCacheVer = await getTenantCacheVersion(tenantA.id);

    // 1. Create Landing Page Focus Mode (`focused`) page with full SEO overrides & section
    const createRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: editorA.cookie,
        body: {
          title: "Penawaran Khusus Ads Campaign",
          slug: "penawaran-khusus",
          layoutMode: "focused",
          sections: [
            {
              id: "hero-1",
              kind: "hero",
              heading: "Diskon 30% Hari Ini",
              subheading: "Khusus pemesanan via WhatsApp",
              bodyHtml: "<p>Aman</p><script>alert(1)</script>",
              ctaLabel: "Chat WhatsApp",
              ctaHref: "https://wa.me/6281234567890",
            },
          ],
          seo: {
            seoTitle: "Promo Web UMKM Diskon 30%",
            seoDescription: "Landing page fokus konversi WhatsApp tanpa gangguan menu header dan footer.",
            ogImageMediaId: 9,
            noindex: true,
            canonicalOverride: "https://alpha-studio.id/penawaran-khusus",
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: number;
      slug: string;
      layoutMode: string;
      status: string;
      version: number;
      sections: { bodyHtml: string | null }[];
      seo: {
        seoTitle?: string;
        seoDescription?: string;
        ogImageMediaId?: number;
        noindex?: boolean;
        canonicalOverride?: string;
      };
    };
    expect(created.layoutMode).toBe("focused");
    expect(created.status).toBe("draft");
    expect(created.seo.seoTitle).toBe("Promo Web UMKM Diskon 30%");
    expect(created.seo.noindex).toBe(true);
    expect(created.seo.canonicalOverride).toBe("https://alpha-studio.id/penawaran-khusus");
    // Hostile <script> sanitized even in draft storage
    expect(created.sections[0]?.bodyHtml).toBe("<p>Aman</p>");

    // 2. Draft NEVER leaks to public loader (`getPublishedPage` -> null), while private preview works
    expect(await getPublishedPage(tenantA.db, { slug: "penawaran-khusus" })).toBeNull();

    const previewRes = await handleTenantPagePreviewRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${created.id}/preview`,
        "GET",
        { cookie: editorA.cookie },
      ),
      runtimeEnv,
    );
    expect(previewRes.status).toBe(200);
    expect(previewRes.headers.get("Cache-Control")).toBe("no-store");
    expect(previewRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const previewBody = (await previewRes.json()) as {
      preview: boolean;
      layoutMode: string;
      hideNavigationChrome: boolean;
      hasUnpublishedChanges: boolean;
      published: unknown;
      draft: { title: string; layoutMode: string };
    };
    expect(previewBody.preview).toBe(true);
    expect(previewBody.layoutMode).toBe("focused");
    expect(previewBody.hideNavigationChrome).toBe(true);
    expect(previewBody.hasUnpublishedChanges).toBe(true);
    expect(previewBody.published).toBeNull();
    expect(previewBody.draft.layoutMode).toBe("focused");

    // 3. Reject invalid SEO (>70 title) and invalid layoutMode with 422
    const badSeoRes = await handleTenantPageItemRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${created.id}`,
        "PATCH",
        {
          cookie: editorA.cookie,
          body: {
            version: created.version,
            seo: { seoTitle: "a".repeat(71) },
          },
        },
      ),
      runtimeEnv,
    );
    expect(badSeoRes.status).toBe(422);

    const badLayoutRes = await handleTenantPageItemRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${created.id}`,
        "PATCH",
        {
          cookie: editorA.cookie,
          body: {
            version: created.version,
            layoutMode: "ultra-minimal",
          },
        },
      ),
      runtimeEnv,
    );
    expect(badLayoutRes.status).toBe(422);

    // 4. Publish atomically -> bumps PLATFORM_DB.tenants.cache_version and records revision #1
    const pubRes = await handleTenantPagePublishRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${created.id}/publish`,
        "POST",
        {
          cookie: ownerA.cookie,
          body: { version: created.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1000 },
    );
    expect(pubRes.status).toBe(200);
    const pubBody = (await pubRes.json()) as {
      status: string;
      version: number;
      layoutMode: string;
      cacheVersion: number;
      revisionNumber: number;
      hasUnpublishedChanges: boolean;
    };
    expect(pubBody.status).toBe("published");
    expect(pubBody.layoutMode).toBe("focused");
    expect(pubBody.cacheVersion).toBe(initialCacheVer + 1);
    expect(pubBody.revisionNumber).toBe(1);
    expect(pubBody.hasUnpublishedChanges).toBe(false);
    expect(await getTenantCacheVersion(tenantA.id)).toBe(initialCacheVer + 1);

    // Public loader now returns the frozen published snapshot with layoutMode === "focused"
    const livePublished = await getPublishedPage(tenantA.db, { slug: "penawaran-khusus" });
    expect(livePublished?.data.layoutMode).toBe("focused");
    expect(livePublished?.data.title).toBe("Penawaran Khusus Ads Campaign");
    expect(livePublished?.data.seo?.seoTitle).toBe("Promo Web UMKM Diskon 30%");

    // 5. Draft edit AFTER publish stays isolated from public snapshot
    const draftEditRes = await handleTenantPageItemRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${created.id}`,
        "PATCH",
        {
          cookie: editorA.cookie,
          body: {
            title: "Draf Judul Baru Belum Tayang",
            layoutMode: "standard",
            version: pubBody.version,
          },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2000 },
    );
    expect(draftEditRes.status).toBe(200);
    const edited = (await draftEditRes.json()) as {
      version: number;
      title: string;
      layoutMode: string;
      hasUnpublishedChanges: boolean;
    };
    expect(edited.title).toBe("Draf Judul Baru Belum Tayang");
    expect(edited.layoutMode).toBe("standard");
    expect(edited.hasUnpublishedChanges).toBe(true);

    // Public snapshot STILL serves the previous published version (`focused` & old title)!
    const stillPublished = await getPublishedPage(tenantA.db, { slug: "penawaran-khusus" });
    expect(stillPublished?.data.title).toBe("Penawaran Khusus Ads Campaign");
    expect(stillPublished?.data.layoutMode).toBe("focused");

    // 6. Stale update returns 409 STALE_VERSION without modifying data
    const staleRes = await handleTenantPageItemRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${created.id}`,
        "PATCH",
        {
          cookie: ownerA.cookie,
          body: { title: "Stale Write", version: pubBody.version },
        },
      ),
      runtimeEnv,
    );
    expect(staleRes.status).toBe(409);
    const staleErr = (await staleRes.json()) as { error: { code: string } };
    expect(staleErr.error.code).toBe("STALE_VERSION");

    // 7. Revisions list endpoint returns recorded revision #1
    const revRes = await handleTenantPageRevisionsRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${created.id}/revisions`,
        "GET",
        { cookie: editorA.cookie },
      ),
      runtimeEnv,
    );
    expect(revRes.status).toBe(200);
    const revBody = (await revRes.json()) as { items: { revisionNumber: number }[] };
    expect(revBody.items).toHaveLength(1);
    expect(revBody.items[0]?.revisionNumber).toBe(1);

    // 8. Unpublish atomically -> bumps cache_version and removes from public loader
    const unpubRes = await handleTenantPageUnpublishRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${created.id}/unpublish`,
        "POST",
        {
          cookie: ownerA.cookie,
          body: { version: edited.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3000 },
    );
    expect(unpubRes.status).toBe(200);
    const unpubBody = (await unpubRes.json()) as {
      status: string;
      version: number;
      cacheVersion: number;
    };
    expect(unpubBody.status).toBe("draft");
    expect(unpubBody.cacheVersion).toBe(initialCacheVer + 2);
    expect(await getPublishedPage(tenantA.db, { slug: "penawaran-khusus" })).toBeNull();

    // 9. Trash & list with status filter & restore back to draft only
    const trashRes = await handleTenantPageTrashRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${created.id}/trash`,
        "POST",
        {
          cookie: ownerA.cookie,
          body: { version: unpubBody.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4000 },
    );
    expect(trashRes.status).toBe(200);
    const trashed = (await trashRes.json()) as { status: string; version: number; deletedAt: string | null };
    expect(trashed.status).toBe("trashed");
    expect(trashed.deletedAt).not.toBeNull();

    const listDraftsRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages?status=draft`,
        "GET",
        { cookie: editorA.cookie },
      ),
      runtimeEnv,
    );
    expect(listDraftsRes.status).toBe(200);
    expect(((await listDraftsRes.json()) as { items: unknown[] }).items).toHaveLength(0);

    const listTrashedRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages?status=trashed`,
        "GET",
        { cookie: editorA.cookie },
      ),
      runtimeEnv,
    );
    expect(listTrashedRes.status).toBe(200);
    expect(((await listTrashedRes.json()) as { items: { id: number }[] }).items[0]?.id).toBe(
      created.id,
    );

    const restoreRes = await handleTenantPageRestoreRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${created.id}/restore`,
        "POST",
        {
          cookie: ownerA.cookie,
          body: { version: trashed.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );
    expect(restoreRes.status).toBe(200);
    const restored = (await restoreRes.json()) as { status: string; deletedAt: string | null };
    expect(restored.status).toBe("draft");
    expect(restored.deletedAt).toBeNull();
  });

  it("enforces host isolation (404), auth (401), CSRF/Origin (403), cross-tenant non-member (404), forbidden selectors/unknown fields (422), and locked/suspended lifecycle guards (403)", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const { tenantA, ownerA, ownerB } = await provisionTwoTenants("04", runtimeEnv);

    // 1. Non-app host surfaces (tenant host & console host) return neutral 404
    const onTenantHost = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(
        `https://${tenantA.handle}.situsku.click/api/tenants/${tenantA.handle}/pages`,
        "GET",
        { cookie: ownerA.cookie },
      ),
      runtimeEnv,
    );
    expect(onTenantHost.status).toBe(404);

    const onConsoleHost = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(
        `https://console.punyasitus.com/api/tenants/${tenantA.handle}/pages`,
        "GET",
        { cookie: ownerA.cookie },
      ),
      runtimeEnv,
    );
    expect(onConsoleHost.status).toBe(404);

    // 2. Unauthenticated request returns 401
    const unauthRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "GET"),
      runtimeEnv,
    );
    expect(unauthRes.status).toBe(401);

    // 3. Cross-origin CSRF attempt returns 403
    const badOriginRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        origin: "https://evil.example",
        body: { title: "CSRF Attempt" },
      }),
      runtimeEnv,
    );
    expect(badOriginRes.status).toBe(403);

    // 4. Non-member (Owner B targeting Tenant A) returns neutral 404 (no tenant enumeration)
    const crossTenantGet = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "GET", {
        cookie: ownerB.cookie,
      }),
      runtimeEnv,
    );
    expect(crossTenantGet.status).toBe(404);

    const crossTenantPost = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerB.cookie,
        body: { title: "Cross-tenant Attack" },
      }),
      runtimeEnv,
    );
    expect(crossTenantPost.status).toBe(404);

    // 5. Forbidden tenant selector & unknown field rejected with 422
    const forbiddenSelectorRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        body: { title: "Sneaky", tenantId: "01JOTHER000000000000000001" },
      }),
      runtimeEnv,
    );
    expect(forbiddenSelectorRes.status).toBe(422);

    const unknownFieldRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        body: { title: "Unknown", extraField: true },
      }),
      runtimeEnv,
    );
    expect(unknownFieldRes.status).toBe(422);

    // 6. Lifecycle lock: `locked` (H+4..H+7 after paidThrough) allows GET (200) but blocks POST/PATCH/publish/DELETE with 403 SUBSCRIPTION_LOCKED
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const fiveDaysAgo = new Date(BASE_NOW_MS - 5 * 24 * 60 * 60 * 1000);
    await pDb
      .update(tenants)
      .set({ status: "locked", paidThrough: fiveDaysAgo })
      .where(eq(tenants.id, tenantA.id));

    const lockedGet = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedGet.status).toBe(200);

    const lockedPost = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        body: { title: "Blocked While Locked" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedPost.status).toBe(403);
    const lockedBody = (await lockedPost.json()) as { error: { code: string } };
    expect(lockedBody.error.code).toBe("SUBSCRIPTION_LOCKED");

    // 7. `suspended` (H+8+ after paidThrough) blocks even GET with 403 SUBSCRIPTION_LOCKED
    const tenDaysAgo = new Date(BASE_NOW_MS - 10 * 24 * 60 * 60 * 1000);
    await pDb
      .update(tenants)
      .set({ status: "suspended", paidThrough: tenDaysAgo })
      .where(eq(tenants.id, tenantA.id));

    const suspendedGet = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(suspendedGet.status).toBe(403);
    expect(((await suspendedGet.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );
  });

  it("keeps pages and resource_slugs strictly atomic under concurrent conflicting PATCHes (same expectedVersion, different slugs) on both draft and published pages", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const { tenantA, ownerA } = await provisionTwoTenants("05", runtimeEnv);

    // --- Part A: Draft page concurrent PATCH race ---
    const draftCreateRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        body: { title: "Draft Race", slug: "draft-initial" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(draftCreateRes.status).toBe(201);
    const draftPage = (await draftCreateRes.json()) as { id: number; version: number };

    const [draftRace1, draftRace2] = await Promise.all([
      handleTenantPageItemRequest(
        tenantA.handle,
        String(draftPage.id),
        makeAdminRequest(
          `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${draftPage.id}`,
          "PATCH",
          {
            cookie: ownerA.cookie,
            body: { slug: "draft-winner-a", version: draftPage.version },
          },
        ),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 10 },
      ),
      handleTenantPageItemRequest(
        tenantA.handle,
        String(draftPage.id),
        makeAdminRequest(
          `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${draftPage.id}`,
          "PATCH",
          {
            cookie: ownerA.cookie,
            body: { slug: "draft-winner-b", version: draftPage.version },
          },
        ),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 11 },
      ),
    ]);

    const draftStatuses = [draftRace1.status, draftRace2.status].sort((a, b) => a - b);
    expect(draftStatuses).toEqual([200, 409]);

    const draftWinRes = draftRace1.status === 200 ? draftRace1 : draftRace2;
    const draftLoseRes = draftRace1.status === 409 ? draftRace1 : draftRace2;
    const draftWinner = (await draftWinRes.json()) as { slug: string; version: number };
    const draftLoserErr = (await draftLoseRes.json()) as { error: { code: string } };
    expect(draftLoserErr.error.code).toBe("STALE_VERSION");

    const draftWinningSlug = draftWinner.slug;
    const draftLosingSlug =
      draftWinningSlug === "draft-winner-a" ? "draft-winner-b" : "draft-winner-a";

    // Zero orphan rows in `resource_slugs`: ONLY the winning slug exists for this draft page!
    const draftSlugs = await listResourceSlugsForResource(tenantA.db, "pages", draftPage.id);
    expect(draftSlugs.filter((s) => s.isCurrent).map((s) => s.slug)).toEqual([draftWinningSlug]);
    expect(draftSlugs).toHaveLength(1);
    expect(await findResourceSlug(tenantA.db, "pages", draftLosingSlug)).toBeNull();

    // The losing slug MUST remain free to be claimed by another page!
    const claimDraftLoserRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        body: { title: "Claim Draft Loser", slug: draftLosingSlug },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 20 },
    );
    expect(claimDraftLoserRes.status).toBe(201);

    // --- Part B: Published page concurrent PATCH race (with confirmSlugChange: true) ---
    const pubCreateRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        body: { title: "Live Race", slug: "live-original" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 30 },
    );
    expect(pubCreateRes.status).toBe(201);
    const pubCreated = (await pubCreateRes.json()) as { id: number; version: number };

    const pubActionRes = await handleTenantPagePublishRequest(
      tenantA.handle,
      String(pubCreated.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${pubCreated.id}/publish`,
        "POST",
        {
          cookie: ownerA.cookie,
          body: { version: pubCreated.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 40 },
    );
    expect(pubActionRes.status).toBe(200);
    const pubLive = (await pubActionRes.json()) as { version: number; cacheVersion: number };
    const cacheVerBeforeRace = pubLive.cacheVersion;

    const [liveRace1, liveRace2] = await Promise.all([
      handleTenantPageItemRequest(
        tenantA.handle,
        String(pubCreated.id),
        makeAdminRequest(
          `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${pubCreated.id}`,
          "PATCH",
          {
            cookie: ownerA.cookie,
            body: {
              slug: "live-moved-a",
              confirmSlugChange: true,
              version: pubLive.version,
            },
          },
        ),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 50 },
      ),
      handleTenantPageItemRequest(
        tenantA.handle,
        String(pubCreated.id),
        makeAdminRequest(
          `${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${pubCreated.id}`,
          "PATCH",
          {
            cookie: ownerA.cookie,
            body: {
              slug: "live-moved-b",
              confirmSlugChange: true,
              version: pubLive.version,
            },
          },
        ),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 51 },
      ),
    ]);

    const liveStatuses = [liveRace1.status, liveRace2.status].sort((a, b) => a - b);
    expect(liveStatuses).toEqual([200, 409]);

    const liveWinRes = liveRace1.status === 200 ? liveRace1 : liveRace2;
    const liveLoseRes = liveRace1.status === 409 ? liveRace1 : liveRace2;
    const liveWinner = (await liveWinRes.json()) as { slug: string; version: number };
    const liveLoserErr = (await liveLoseRes.json()) as { error: { code: string } };
    expect(liveLoserErr.error.code).toBe("STALE_VERSION");

    const liveWinningSlug = liveWinner.slug;
    const liveLosingSlug = liveWinningSlug === "live-moved-a" ? "live-moved-b" : "live-moved-a";

    // Assert exact `resource_slugs` invariants:
    // 1. Exactly ONE `is_current = 1` row (the winning slug)
    // 2. ALL former rows (`is_current = 0`) have `redirect_target_slug === liveWinningSlug`
    // 3. ZERO orphan rows for the losing slug
    const liveSlugs = await listResourceSlugsForResource(tenantA.db, "pages", pubCreated.id);
    const currentRows = liveSlugs.filter((s) => s.isCurrent);
    const formerRows = liveSlugs.filter((s) => !s.isCurrent);
    expect(currentRows.map((s) => s.slug)).toEqual([liveWinningSlug]);
    expect(formerRows.map((s) => s.slug)).toEqual(["live-original"]);
    expect(formerRows.every((s) => s.redirectTargetSlug === liveWinningSlug)).toBe(true);
    expect(await findResourceSlug(tenantA.db, "pages", liveLosingSlug)).toBeNull();

    // Live published snapshot & cache_version stayed consistent with the winning slug
    expect(await getTenantCacheVersion(tenantA.id)).toBe(cacheVerBeforeRace + 1);
    const publishedAfterRace = await getPublishedPage(tenantA.db, { slug: liveWinningSlug });
    expect(publishedAfterRace?.data.slug).toBe(liveWinningSlug);

    // Losing slug is still free to be claimed by a brand-new page!
    const claimLiveLoserRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: ownerA.cookie,
        body: { title: "Claim Live Loser", slug: liveLosingSlug },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 60 },
    );
    expect(claimLiveLoserRes.status).toBe(201);
  });
});

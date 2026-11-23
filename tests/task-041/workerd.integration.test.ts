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
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
} from "@punyasitus/db/platform";
import {
  createTaxonomy,
  deleteTaxonomy,
  updateTaxonomy,
} from "@punyasitus/db/taxonomy/index";
import { TAXONOMY_ARCHIVE_SETTINGS_MIGRATION } from "@punyasitus/db/taxonomy/migrations";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantCatalogOfferingPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/publish.ts";
import { handleTenantCatalogOfferingRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/index.ts";
import { handleTenantCatalogCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/index.ts";
import { handleTenantCategoryItemRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/categories/[categoryId].ts";
import { handleTenantCategoriesCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/categories/index.ts";
import { handleTenantIdentityRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/identity/index.ts";
import { handleTenantPostItemRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId].ts";
import { handleTenantPostPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/publish.ts";
import { handleTenantPostTrashRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/trash.ts";
import type { TenantBlogRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/_shared.ts";
import { handleTenantPostsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/index.ts";
import { handleTenantTagItemRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/tags/[tagId].ts";
import { handleTenantTagsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/tags/index.ts";
import {
  resolveBlogCategoryArchiveRoute,
  resolveBlogTagArchiveRoute,
  resolveOfferingCategoryArchiveRoute,
} from "../../apps/web/src/pages/blog/category/_archive-resolver.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 4, 30, 0);

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
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractSessionCookiePair(response: Response): string {
  const cookies = getSetCookies(response.headers);
  const sessionHeader = cookies.find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!sessionHeader) {
    throw new Error(`Expected ${APP_SESSION_COOKIE_NAME} cookie, got: ${JSON.stringify(cookies)}`);
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
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
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
    applyTenantMigrations(state.storage as unknown as StorageLike, [
      ...TENANT_MIGRATIONS,
      TAXONOMY_ARCHIVE_SETTINGS_MIGRATION,
    ]),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

/**
 * Wraps a real TenantStore `D1Database` to inject a deterministic interleaved write
 * immediately before the next `batch(...)` call — deterministically exercising TOCTOU races.
 */
function withBeforeNextBatchHook(
  baseDb: D1Database,
  hook: () => Promise<void>,
): D1Database {
  let fired = false;
  return new Proxy(baseDb, {
    get(target, prop, receiver) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            await hook();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seedTenantShell(
  tenantDb: D1Database,
  params: {
    readonly siteTitle: string;
    readonly businessName: string;
    readonly blogEnabled?: boolean;
    readonly catalogEnabled?: boolean;
  },
): Promise<void> {
  const now = BASE_NOW_MS;
  const blogEnabled = params.blogEnabled === false ? 0 : 1;
  const catalogEnabled = params.catalogEnabled === false ? 0 : 1;
  const publishedSettings = JSON.stringify({
    snapshotVersion: 1,
    resourceType: "site_settings",
    data: {
      siteTitle: params.siteTitle,
      tagline: "Mitra Bisnis Andal",
      timezone: "Asia/Jakarta",
      locale: "id-ID",
      activeThemeId: "compro",
      blogEnabled: blogEnabled === 1,
      catalogEnabled: catalogEnabled === 1,
      siteVisibility: "public",
      aiTrainingPolicy: "allow",
    },
  });
  const publishedBiz = JSON.stringify({
    snapshotVersion: 1,
    resourceType: "business_profile",
    data: {
      businessName: params.businessName,
      businessCategory: "LocalBusiness",
      description: `Layanan resmi ${params.businessName}`,
      whatsappE164: "6281234567890",
      phone: "6281234567890",
      email: "halo@example.id",
    },
  });
  await tenantDb.batch([
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO site_settings (
           id, site_title, tagline, timezone, locale, active_theme_id,
           blog_enabled, catalog_enabled, ai_training_policy,
           draft_json, published_json, published_at, version, updated_at
         ) VALUES (1, ?, 'Mitra Bisnis Andal', 'Asia/Jakarta', 'id-ID', 'compro', ?, ?, 'allow', ?, ?, ?, 1, ?)`,
      )
      .bind(params.siteTitle, blogEnabled, catalogEnabled, publishedSettings, publishedSettings, now, now),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO business_profile (
           id, business_name, business_category, description, whatsapp_e164, phone, email,
           draft_json, published_json, published_at, version, updated_at
         ) VALUES (1, ?, 'LocalBusiness', ?, '6281234567890', '6281234567890', 'halo@example.id', ?, ?, ?, 1, ?)`,
      )
      .bind(
        params.businessName,
        `Layanan resmi ${params.businessName}`,
        publishedBiz,
        publishedBiz,
        now,
        now,
      ),
  ]);
}

async function signUpUser(
  runtimeEnv: TenantBlogRuntimeEnv,
  params: { readonly email: string; readonly name: string; readonly password: string },
): Promise<{ readonly userId: string; readonly cookie: string }> {
  const res = await handleBetterAuthRequest(
    new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
      },
      body: JSON.stringify(params),
    }),
    runtimeEnv,
  );
  if (res.status !== 200) {
    throw new Error(`Sign-up failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { user?: { id?: string } };
  const userId = body.user?.id;
  if (!userId) throw new Error("Missing user.id from sign-up response");
  return { userId, cookie: extractSessionCookiePair(res) };
}

async function provisionTwoTenants(suffix: string, runtimeEnv: TenantBlogRuntimeEnv) {
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(BASE_NOW_MS);

  const tenantAId = `01JT41A${suffix.toUpperCase().padEnd(19, "0").slice(0, 19)}`;
  const tenantBId = `01JT41B${suffix.toUpperCase().padEnd(19, "0").slice(0, 19)}`;
  const orgAId = `org-t41-a-${suffix}`;
  const orgBId = `org-t41-b-${suffix}`;
  const handleA = `t41-alpha-${suffix}`;
  const handleB = `t41-beta-${suffix}`;
  const hostA = `${handleA}.situsku.click`;
  const hostB = `${handleB}.situsku.click`;

  const ownerA = await signUpUser(runtimeEnv, {
    email: `owner-a-${suffix}@example.com`,
    name: "Owner Alpha",
    password: "StrongPassword!2026",
  });
  const editorA = await signUpUser(runtimeEnv, {
    email: `editor-a-${suffix}@example.com`,
    name: "Editor Alpha",
    password: "StrongPassword!2026",
  });
  const ownerB = await signUpUser(runtimeEnv, {
    email: `owner-b-${suffix}@example.com`,
    name: "Owner Beta",
    password: "StrongPassword!2026",
  });

  await db.insert(organizations).values([
    { id: orgAId, name: "PT Alpha Taxonomy", slug: handleA, createdAt: now, updatedAt: now },
    { id: orgBId, name: "PT Beta Taxonomy", slug: handleB, createdAt: now, updatedAt: now },
  ]);

  await db.insert(tenants).values([
    {
      id: tenantAId,
      organizationId: orgAId,
      handle: handleA,
      name: "PT Alpha Taxonomy",
      vertical: "compro",
      status: "active",
      cacheVersion: 1,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: tenantBId,
      organizationId: orgBId,
      handle: handleB,
      name: "PT Beta Taxonomy",
      vertical: "dealer",
      status: "active",
      cacheVersion: 1,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(tenantHosts).values([
    {
      tenantId: tenantAId,
      host: hostA,
      kind: "subdomain",
      isPrimary: true,
      status: "active",
      sslStatus: "active",
      createdAt: now,
      updatedAt: now,
    },
    {
      tenantId: tenantBId,
      host: hostB,
      kind: "subdomain",
      isPrimary: true,
      status: "active",
      sslStatus: "active",
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(members).values([
    { id: `mem-oa-${suffix}`, organizationId: orgAId, userId: ownerA.userId, role: "owner", createdAt: now },
    { id: `mem-ea-${suffix}`, organizationId: orgAId, userId: editorA.userId, role: "editor", createdAt: now },
    { id: `mem-ob-${suffix}`, organizationId: orgBId, userId: ownerB.userId, role: "owner", createdAt: now },
  ]);

  const [dbA, dbB] = await Promise.all([
    openMigratedTenantDb(tenantAId),
    openMigratedTenantDb(tenantBId),
  ]);
  await Promise.all([
    seedTenantShell(dbA, { siteTitle: "PT Alpha Taxonomy", businessName: "PT Alpha Taxonomy" }),
    seedTenantShell(dbB, { siteTitle: "PT Beta Dealer", businessName: "PT Beta Dealer" }),
  ]);

  return {
    tenantA: { id: tenantAId, orgId: orgAId, handle: handleA, host: hostA, db: dbA },
    tenantB: { id: tenantBId, orgId: orgBId, handle: handleB, host: hostB, db: dbB },
    ownerA,
    editorA,
    ownerB,
  };
}

describe("TASK-041 workerd integration — Scoped Taxonomies, Safe Reassign/Detach, RBAC & Public Archives", () => {
  const runtimeEnv = buildRuntimeEnv();

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("enforces depth <= 3, cycle rejection (422 TAXONOMY_CYCLE_OR_DEPTH), flat tags, offeringType parent scope, and RBAC (editor allowed taxonomy, denied settings)", async () => {
    const fx = await provisionTwoTenants("hier", runtimeEnv);

    // Editor CAN create depth 1 -> 2 -> 3 blog categories
    const c1Res = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Operasional", description: "Panduan lengkap operasional bisnis harian UMKM." },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(c1Res.status).toBe(201);
    expect(c1Res.headers.get("cache-control")).toBe("private, no-store");
    expect(c1Res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const c1 = (await c1Res.json()) as { id: number; depth: number; version: number; slug: string };
    expect(c1.depth).toBe(1);

    const c2Res = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Logistik", parentId: c1.id },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10 },
    );
    expect(c2Res.status).toBe(201);
    const c2 = (await c2Res.json()) as { id: number; depth: number; version: number };
    expect(c2.depth).toBe(2);

    const c3Res = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Pengiriman Cepat", parentId: c2.id },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 20 },
    );
    expect(c3Res.status).toBe(201);
    const c3 = (await c3Res.json()) as { id: number; depth: number; version: number };
    expect(c3.depth).toBe(3);

    // Depth 4 MUST fail with 422 TAXONOMY_CYCLE_OR_DEPTH
    const c4Res = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Level Empat", parentId: c3.id },
      }),
      runtimeEnv,
    );
    expect(c4Res.status).toBe(422);
    const c4Err = (await c4Res.json()) as { error: { code: string } };
    expect(c4Err.error.code).toBe("TAXONOMY_CYCLE_OR_DEPTH");

    // Cycle A -> C -> B -> A MUST fail with 422 TAXONOMY_CYCLE_OR_DEPTH
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
    const cycleErr = (await cycleRes.json()) as { error: { code: string } };
    expect(cycleErr.error.code).toBe("TAXONOMY_CYCLE_OR_DEPTH");

    // Self-parenting A -> A MUST fail with 422 TAXONOMY_CYCLE_OR_DEPTH
    const selfRes = await handleTenantCategoryItemRequest(
      fx.tenantA.handle,
      String(c1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${c1.id}`, "PATCH", {
        cookie: fx.editorA.cookie,
        body: { parentId: c1.id, version: c1.version },
      }),
      runtimeEnv,
    );
    expect(selfRes.status).toBe(422);
    expect(((await selfRes.json()) as { error: { code: string } }).error.code).toBe(
      "TAXONOMY_CYCLE_OR_DEPTH",
    );

    // Flat tag rejects parentId with 422
    const badTagRes = await handleTenantTagsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Tag Invalid", parentId: c1.id },
      }),
      runtimeEnv,
    );
    expect(badTagRes.status).toBe(422);

    // Catalog categories scoped by offeringType: parent must match offeringType
    const svcCatRes = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: { kind: "offering_category", offeringType: "service", name: "Konsultasi" },
      }),
      runtimeEnv,
    );
    expect(svcCatRes.status).toBe(201);
    const svcCat = (await svcCatRes.json()) as { id: number; kind: string; offeringType: string };
    expect(svcCat.kind).toBe("offering_category");
    expect(svcCat.offeringType).toBe("service");

    const mismatchedChildRes = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: {
          kind: "offering_category",
          offeringType: "vehicle",
          name: "SUV Salah Induk",
          parentId: svcCat.id,
        },
      }),
      runtimeEnv,
    );
    expect(mismatchedChildRes.status).toBe(422);

    // Cross-tenant parent ID (exists in Tenant B, NOT Tenant A) rejected with 422
    const tenantBCatRes = await handleTenantCategoriesCollectionRequest(
      fx.tenantB.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantB.handle}/categories`, "POST", {
        cookie: fx.ownerB.cookie,
        body: { name: "Kategori Khusus Tenant B" },
      }),
      runtimeEnv,
    );
    expect(tenantBCatRes.status).toBe(201);
    const bCat = (await tenantBCatRes.json()) as { id: number };

    // Use a nonexistent ID in Tenant A (e.g. 9999) + cross-tenant access check
    const foreignParentRes = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.editorA.cookie,
        body: { name: "Anak Lintas Tenant", parentId: 9999 },
      }),
      runtimeEnv,
    );
    expect(foreignParentRes.status).toBe(422);

    // Cross-tenant API access returns neutral 404
    const crossGet = await handleTenantCategoryItemRequest(
      fx.tenantB.handle,
      String(bCat.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantB.handle}/categories/${bCat.id}`, "GET", {
        cookie: fx.editorA.cookie,
      }),
      runtimeEnv,
    );
    expect(crossGet.status).toBe(404);

    // Editor is STILL denied tenant settings mutations (403 FORBIDDEN)!
    const editorSettingsRes = await handleTenantIdentityRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/identity`, "PATCH", {
        cookie: fx.editorA.cookie,
        body: { siteTitle: "Tidak Boleh", version: 1 },
      }),
      runtimeEnv,
    );
    expect(editorSettingsRes.status).toBe(403);

    // Missing version on PATCH and DELETE returns 422
    const noVerPatch = await handleTenantCategoryItemRequest(
      fx.tenantA.handle,
      String(c3.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${c3.id}`, "PATCH", {
        cookie: fx.editorA.cookie,
        body: { name: "Tanpa Versi" },
      }),
      runtimeEnv,
    );
    expect(noVerPatch.status).toBe(422);

    const noVerDelete = await handleTenantCategoryItemRequest(
      fx.tenantA.handle,
      String(c3.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${c3.id}`, "DELETE", {
        cookie: fx.editorA.cookie,
        body: {},
      }),
      runtimeEnv,
    );
    expect(noVerDelete.status).toBe(422);

    // Stale version returns 409 STALE_VERSION with ZERO side effects and ZERO extra audit rows
    const auditBefore = await fx.tenantA.db
      .prepare(`SELECT COUNT(*) AS cnt FROM tenant_activity_log WHERE resource_type = 'taxonomy'`)
      .first<{ cnt: number }>();

    const stalePatch = await handleTenantCategoryItemRequest(
      fx.tenantA.handle,
      String(c3.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${c3.id}`, "PATCH", {
        cookie: fx.editorA.cookie,
        body: { name: "Stale Name", version: 99 },
      }),
      runtimeEnv,
    );
    expect(stalePatch.status).toBe(409);
    expect(((await stalePatch.json()) as { error: { code: string } }).error.code).toBe("STALE_VERSION");

    const auditAfter = await fx.tenantA.db
      .prepare(`SELECT COUNT(*) AS cnt FROM tenant_activity_log WHERE resource_type = 'taxonomy'`)
      .first<{ cnt: number }>();
    expect(Number(auditAfter?.cnt)).toBe(Number(auditBefore?.cnt));
    expect(Number(auditAfter?.cnt)).toBeGreaterThanOrEqual(4);

    // Locked tenant denied 403 SUBSCRIPTION_LOCKED on write, allowed on read
    const platformDrizzle = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await platformDrizzle
      .update(tenants)
      .set({ status: "locked" })
      .where(eq(tenants.id, fx.tenantA.id));

    const lockedRead = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "GET", {
        cookie: fx.ownerA.cookie,
      }),
      runtimeEnv,
    );
    expect(lockedRead.status).toBe(200);

    const lockedWrite = await handleTenantCategoriesCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { name: "Terkunci" },
      }),
      runtimeEnv,
    );
    expect(lockedWrite.status).toBe(403);
    expect(((await lockedWrite.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );
  });

  it("guards category/tag deletion (409 CATEGORY_HAS_CHILDREN, 409 TAXONOMY_IN_USE) and supports atomic reassign & detach without losing content", async () => {
    const fx = await provisionTwoTenants("del", runtimeEnv);

    // Create parent cat, child cat, target cat, and tag
    const parentCat = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.editorA.cookie,
          body: { name: "Induk Bisnis" },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; version: number };

    const childCat = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.editorA.cookie,
          body: { name: "Sub Keuangan", parentId: parentCat.id },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; version: number };

    const targetCat = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.editorA.cookie,
          body: { name: "Arsip Umum" },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; version: number };

    const tag1 = (await (
      await handleTenantTagsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags`, "POST", {
          cookie: fx.editorA.cookie,
          body: { name: "Pajak UMKM" },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; version: number };

    // Create & publish post #1 assigned to childCat + tag1, and create draft post #2 assigned to childCat
    const post1 = (await (
      await handleTenantPostsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
          cookie: fx.editorA.cookie,
          body: {
            title: "Laporan Kas UMKM",
            bodyHtml: "<p>Panduan pembukuan arus kas bulanan untuk bisnis kecil.</p>",
            primaryCategoryId: childCat.id,
            categoryIds: [childCat.id],
            tagIds: [tag1.id],
          },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; version: number };

    const pub1Res = await handleTenantPostPublishRequest(
      fx.tenantA.handle,
      String(post1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${post1.id}/publish`, "POST", {
        cookie: fx.editorA.cookie,
        body: { version: post1.version },
      }),
      runtimeEnv,
    );
    expect(pub1Res.status).toBe(200);

    const post2 = (await (
      await handleTenantPostsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
          cookie: fx.editorA.cookie,
          body: {
            title: "Draf Pajak Tahunan",
            bodyHtml: "<p>Catatan draf yang belum terbit.</p>",
            primaryCategoryId: childCat.id,
            categoryIds: [childCat.id],
            tagIds: [tag1.id],
          },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; version: number };

    // Verify full usage counts (published + draft) shown to editors
    const childGet = (await (
      await handleTenantCategoryItemRequest(
        fx.tenantA.handle,
        String(childCat.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${childCat.id}`, "GET", {
          cookie: fx.editorA.cookie,
        }),
        runtimeEnv,
      )
    ).json()) as { publishedCount: number; draftCount: number; totalUsageCount: number; childCount: number };
    expect(childGet.publishedCount).toBe(1);
    expect(childGet.draftCount).toBe(1);
    expect(childGet.totalUsageCount).toBe(2);

    // 1. Deleting parentCat with childCat fails 409 CATEGORY_HAS_CHILDREN
    const delParentRes = await handleTenantCategoryItemRequest(
      fx.tenantA.handle,
      String(parentCat.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${parentCat.id}`, "DELETE", {
        cookie: fx.editorA.cookie,
        body: { version: parentCat.version, detach: true },
      }),
      runtimeEnv,
    );
    expect(delParentRes.status).toBe(409);
    expect(((await delParentRes.json()) as { error: { code: string } }).error.code).toBe(
      "CATEGORY_HAS_CHILDREN",
    );

    // 2. Deleting referenced childCat without detach/reassign fails 409 TAXONOMY_IN_USE
    const delInUseRes = await handleTenantCategoryItemRequest(
      fx.tenantA.handle,
      String(childCat.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${childCat.id}`, "DELETE", {
        cookie: fx.editorA.cookie,
        body: { version: childCat.version },
      }),
      runtimeEnv,
    );
    expect(delInUseRes.status).toBe(409);
    expect(((await delInUseRes.json()) as { error: { code: string } }).error.code).toBe(
      "TAXONOMY_IN_USE",
    );

    // 3. Deleting childCat WITH reassignToId atomically reassigns BOTH posts to targetCat without article loss
    const delReassignRes = await handleTenantCategoryItemRequest(
      fx.tenantA.handle,
      String(childCat.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${childCat.id}`, "DELETE", {
        cookie: fx.editorA.cookie,
        body: { version: childCat.version, reassignToId: targetCat.id },
      }),
      runtimeEnv,
    );
    expect(delReassignRes.status).toBe(204);

    // Verify targetCat now owns 1 published + 1 draft post, and BOTH posts still exist!
    const targetAfter = (await (
      await handleTenantCategoryItemRequest(
        fx.tenantA.handle,
        String(targetCat.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${targetCat.id}`, "GET", {
          cookie: fx.editorA.cookie,
        }),
        runtimeEnv,
      )
    ).json()) as { publishedCount: number; draftCount: number; totalUsageCount: number };
    expect(targetAfter.publishedCount).toBe(1);
    expect(targetAfter.draftCount).toBe(1);
    expect(targetAfter.totalUsageCount).toBe(2);

    const post1After = (await (
      await handleTenantPostItemRequest(
        fx.tenantA.handle,
        String(post1.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${post1.id}`, "GET", {
          cookie: fx.editorA.cookie,
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; status: string; primaryCategoryId: number };
    expect(post1After.status).toBe("published");
    expect(post1After.primaryCategoryId).toBe(targetCat.id);

    const post2After = (await (
      await handleTenantPostItemRequest(
        fx.tenantA.handle,
        String(post2.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${post2.id}`, "GET", {
          cookie: fx.editorA.cookie,
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; status: string; primaryCategoryId: number };
    expect(post2After.status).toBe("draft");
    expect(post2After.primaryCategoryId).toBe(targetCat.id);

    // 4. Deleting tag1 without detach fails 409 TAXONOMY_IN_USE; with detach: true succeeds cleanly
    const delTagBlocked = await handleTenantTagItemRequest(
      fx.tenantA.handle,
      String(tag1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags/${tag1.id}`, "DELETE", {
        cookie: fx.editorA.cookie,
        body: { version: tag1.version },
      }),
      runtimeEnv,
    );
    expect(delTagBlocked.status).toBe(409);

    const delTagDetach = await handleTenantTagItemRequest(
      fx.tenantA.handle,
      String(tag1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags/${tag1.id}`, "DELETE", {
        cookie: fx.editorA.cookie,
        body: { version: tag1.version, detach: true },
      }),
      runtimeEnv,
    );
    expect(delTagDetach.status).toBe(204);

    // Both posts STILL exist after tag detach
    const remainingPosts = await fx.tenantA.db
      .prepare(`SELECT COUNT(*) AS cnt FROM posts`)
      .first<{ cnt: number }>();
    expect(Number(remainingPosts?.cnt)).toBe(2);
  });

  it("renders public zero-JS category/tag/catalog archives excluding drafts, draft assignments & trash, enforcing pagination, empty 200/noindex, default noindex vs opt-in, mixed-case/former-slug 308, and 404", async () => {
    const fx = await provisionTwoTenants("pub", runtimeEnv);

    // Create 2 blog categories (1 with opt-in + useful intro, 1 default/empty) and 1 tag
    const catGuide = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.ownerA.cookie,
          body: {
            name: "Panduan Strategi",
            description: "Kumpulan panduan praktis untuk operasional dan pertumbuhan usaha modern.",
            indexOptIn: true,
          },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; slug: string; version: number };

    const catEmpty = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.ownerA.cookie,
          body: {
            name: "Berita Kosong",
            description: "Kategori baru yang belum memiliki artikel terbit sama sekali.",
            indexOptIn: true,
          },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; slug: string; version: number };

    const catDefaultNoindex = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { name: "Arsip Bawaan" },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; slug: string; version: number };

    const tagPromo = (await (
      await handleTenantTagsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/tags`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { name: "Promo Lokal" },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; slug: string; version: number };

    // Create 3 published posts in catGuide (for pagination test with pageSize=2), 1 draft post, 1 trashed post
    for (let i = 1; i <= 3; i += 1) {
      const p = (await (
        await handleTenantPostsCollectionRequest(
          fx.tenantA.handle,
          makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
            cookie: fx.ownerA.cookie,
            body: {
              title: `Artikel Terbit ${i}`,
              bodyHtml: `<p>Isi artikel terbit nomor ${i} untuk uji arsip publik.</p>`,
              primaryCategoryId: catGuide.id,
              categoryIds: i === 1 ? [catGuide.id, catDefaultNoindex.id] : [catGuide.id],
              tagIds: [tagPromo.id],
            },
          }),
          runtimeEnv,
          { nowMs: BASE_NOW_MS + i * 1000 },
        )
      ).json()) as { id: number; version: number };

      const pub = await handleTenantPostPublishRequest(
        fx.tenantA.handle,
        String(p.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${p.id}/publish`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { version: p.version },
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + i * 1000 + 100 },
      );
      expect(pub.status).toBe(200);

      // Save an UNPUBLISHED DRAFT reassignment on post #1 assigning it to catEmpty!
      // Public archive of catEmpty MUST STILL BE EMPTY (zero draft assignment leak!).
      if (i === 1) {
        const pubBody = (await pub.json()) as { version: number };
        const draftPatch = await handleTenantPostItemRequest(
          fx.tenantA.handle,
          String(p.id),
          makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${p.id}`, "PATCH", {
            cookie: fx.ownerA.cookie,
            body: {
              version: pubBody.version,
              categoryIds: [catGuide.id, catDefaultNoindex.id, catEmpty.id],
            },
          }),
          runtimeEnv,
        );
        expect(draftPatch.status).toBe(200);
      }
    }

    // Draft-only post assigned to catGuide + catEmpty (MUST NOT appear publicly)
    await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
        cookie: fx.ownerA.cookie,
        body: {
          title: "Artikel Draf Rahasia",
          bodyHtml: "<p>Draf ini tidak boleh bocor ke arsip publik.</p>",
          primaryCategoryId: catGuide.id,
          categoryIds: [catGuide.id, catEmpty.id],
          tagIds: [tagPromo.id],
        },
      }),
      runtimeEnv,
    );

    // Published then trashed post (MUST NOT appear publicly)
    const trashedPost = (await (
      await handleTenantPostsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
          cookie: fx.ownerA.cookie,
          body: {
            title: "Artikel Masuk Sampah",
            bodyHtml: "<p>Akan dihapus ke tempat sampah.</p>",
            primaryCategoryId: catGuide.id,
            categoryIds: [catGuide.id],
          },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; version: number };
    const pubTrashed = (await (
      await handleTenantPostPublishRequest(
        fx.tenantA.handle,
        String(trashedPost.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${trashedPost.id}/publish`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { version: trashedPost.version },
        }),
        runtimeEnv,
      )
    ).json()) as { version: number };
    const trashRes = await handleTenantPostTrashRequest(
      fx.tenantA.handle,
      String(trashedPost.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${trashedPost.id}/trash`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { version: pubTrashed.version },
      }),
      runtimeEnv,
    );
    expect(trashRes.status).toBe(200);

    const publicDeps = {
      platformDb: env.PLATFORM_DB,
      tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      bypassHostCache: true,
    };

    // 1. Opted-in populated blog category archive (page 1, pageSize=2 -> 2 of 3 items, indexable!)
    const catPage1 = await resolveBlogCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/blog/category/${catGuide.slug}`),
      publicDeps,
      catGuide.slug,
      { pageSize: 2 },
    );
    expect(catPage1.kind).toBe("blog_taxonomy_archive");
    if (catPage1.kind === "blog_taxonomy_archive") {
      expect(catPage1.http.status).toBe(200);
      expect(catPage1.pagination.totalItems).toBe(3);
      expect(catPage1.pagination.totalPages).toBe(2);
      expect(catPage1.items.length).toBe(2);
      expect(catPage1.items.every((it) => it.title.startsWith("Artikel Terbit"))).toBe(true);
      expect(catPage1.pagination.nextHref).toBe(`/blog/category/${catGuide.slug}?page=2`);
      expect(catPage1.seoMetadata.seoDecision.indexable).toBe(true);
      expect(catPage1.seoMetadata.robots).toContain("index");
    }

    // 2. Pagination ?page=1 -> 301 clean base; ?page=2 -> 200 self-canonical; ?page=9 -> 404
    const page1Redirect = await resolveBlogCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/blog/category/${catGuide.slug}?page=1`),
      publicDeps,
      catGuide.slug,
      { pageSize: 2 },
    );
    expect(page1Redirect.kind).toBe("response");
    if (page1Redirect.kind === "response") {
      expect(page1Redirect.response.status).toBe(301);
      expect(page1Redirect.response.headers.get("location")).toBe(
        `https://${fx.tenantA.host}/blog/category/${catGuide.slug}`,
      );
    }

    const catPage2 = await resolveBlogCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/blog/category/${catGuide.slug}?page=2`),
      publicDeps,
      catGuide.slug,
      { pageSize: 2 },
    );
    expect(catPage2.kind).toBe("blog_taxonomy_archive");
    if (catPage2.kind === "blog_taxonomy_archive") {
      expect(catPage2.items.length).toBe(1);
      expect(catPage2.pagination.prevHref).toBe(`/blog/category/${catGuide.slug}`);
      expect(catPage2.seoMetadata.canonical).toBe(
        `https://${fx.tenantA.host}/blog/category/${catGuide.slug}?page=2`,
      );
    }

    const catPageOutOfRange = await resolveBlogCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/blog/category/${catGuide.slug}?page=9`),
      publicDeps,
      catGuide.slug,
      { pageSize: 2 },
    );
    expect(catPageOutOfRange.kind).toBe("not_found");
    if (catPageOutOfRange.kind === "not_found") {
      expect(catPageOutOfRange.http.status).toBe(404);
    }

    // 3. Empty valid archive (despite unpublished draft assignment & draft post!) -> 200 + noindex!
    const emptyArchive = await resolveBlogCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/blog/category/${catEmpty.slug}`),
      publicDeps,
      catEmpty.slug,
    );
    expect(emptyArchive.kind).toBe("blog_taxonomy_archive");
    if (emptyArchive.kind === "blog_taxonomy_archive") {
      expect(emptyArchive.http.status).toBe(200);
      expect(emptyArchive.items.length).toBe(0);
      expect(emptyArchive.seoMetadata.seoDecision.indexable).toBe(false);
      expect(emptyArchive.http.headers["X-Robots-Tag"]).toContain("noindex");
    }

    // 4. Populated archive WITHOUT indexOptIn -> 200 + default noindex (PLAN §15.2)!
    const defaultNoindexArchive = await resolveBlogCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/blog/category/${catDefaultNoindex.slug}`),
      publicDeps,
      catDefaultNoindex.slug,
    );
    expect(defaultNoindexArchive.kind).toBe("blog_taxonomy_archive");
    if (defaultNoindexArchive.kind === "blog_taxonomy_archive") {
      expect(defaultNoindexArchive.http.status).toBe(200);
      expect(defaultNoindexArchive.items.length).toBe(1);
      expect(defaultNoindexArchive.seoMetadata.seoDecision.indexable).toBe(false);
      expect(defaultNoindexArchive.http.headers["X-Robots-Tag"]).toContain("noindex");
    }

    // 5. Mixed-case slug -> single 308 to canonical lowercase URL
    const mixedCaseRes = await resolveBlogCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/blog/category/Panduan-Strategi`),
      publicDeps,
      "Panduan-Strategi",
    );
    expect(mixedCaseRes.kind).toBe("response");
    if (mixedCaseRes.kind === "response") {
      expect(mixedCaseRes.response.status).toBe(308);
      expect(mixedCaseRes.response.headers.get("location")).toBe(
        `https://${fx.tenantA.host}/blog/category/${catGuide.slug}`,
      );
    }

    // 6. Nonexistent slug -> branded 404 (noindex, zero canonical)
    const missingCat = await resolveBlogCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/blog/category/tidak-ada-sama-sekali`),
      publicDeps,
      "tidak-ada-sama-sekali",
    );
    expect(missingCat.kind).toBe("not_found");
    if (missingCat.kind === "not_found") {
      expect(missingCat.http.status).toBe(404);
      expect(missingCat.seoMetadata.canonical).toBeNull();
    }

    // 7. Blog tag archive `/blog/tag/[slug]` lists only 3 published posts & default noindex
    const tagArchive = await resolveBlogTagArchiveRoute(
      new Request(`https://${fx.tenantA.host}/blog/tag/${tagPromo.slug}`),
      publicDeps,
      tagPromo.slug,
    );
    expect(tagArchive.kind).toBe("blog_taxonomy_archive");
    if (tagArchive.kind === "blog_taxonomy_archive") {
      expect(tagArchive.http.status).toBe(200);
      expect(tagArchive.items.length).toBe(3);
      expect(tagArchive.http.headers["X-Robots-Tag"]).toContain("noindex");
    }

    // 8. Catalog category archives: `/layanan/category/[slug]` & `/kendaraan/category/[slug]`
    const svcCat = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.ownerA.cookie,
          body: {
            kind: "offering_category",
            offeringType: "service",
            name: "Renovasi Kantor",
            description: "Layanan renovasi dan interior ruang kantor profesional berstandar tinggi.",
            indexOptIn: true,
          },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; slug: string };

    const vehCat = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { kind: "offering_category", offeringType: "vehicle", name: "SUV Keluarga" },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; slug: string };

    // Create & publish a service offering in svcCat, plus a draft-only offering in svcCat
    const offPubRes = await handleTenantCatalogCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/catalog`, "POST", {
        cookie: fx.ownerA.cookie,
        body: {
          offeringType: "service",
          title: "Renovasi Ruang Rapat",
          priceMode: "from",
          price: 15000000,
          ctaMode: "whatsapp",
          categoryIds: [svcCat.id],
          attributes: { duration: "14 hari" },
        },
      }),
      runtimeEnv,
    );
    expect(offPubRes.status).toBe(201);
    const offPub = (await offPubRes.json()) as { id: number; version: number };

    const offPublishRes = await handleTenantCatalogOfferingPublishRequest(
      fx.tenantA.handle,
      String(offPub.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/catalog/${offPub.id}/publish`,
        "POST",
        { cookie: fx.ownerA.cookie, body: { version: offPub.version } },
      ),
      runtimeEnv,
    );
    expect(offPublishRes.status).toBe(200);

    // Draft-only service offering (MUST NOT appear on public archive)
    await handleTenantCatalogCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/catalog`, "POST", {
        cookie: fx.ownerA.cookie,
        body: {
          offeringType: "service",
          title: "Draf Renovasi Gudang",
          priceMode: "on_request",
          ctaMode: "whatsapp",
          categoryIds: [svcCat.id],
        },
      }),
      runtimeEnv,
    );

    // Publish a vehicle in vehCat, then save an UNPUBLISHED draft edit removing vehCat:
    // Frozen published snapshot MUST STILL show the vehicle until republished!
    const vehPub = (await (
      await handleTenantCatalogCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/catalog`, "POST", {
          cookie: fx.ownerA.cookie,
          body: {
            offeringType: "vehicle",
            title: "SUV Hybrid 2025",
            priceMode: "fixed",
            price: 450000000,
            ctaMode: "whatsapp",
            unitStatus: "available",
            categoryIds: [vehCat.id],
            attributes: { brand: "Toyota", model: "Cross", year: 2025, condition: "new" },
          },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; version: number };

    const vehPublishBody = (await (
      await handleTenantCatalogOfferingPublishRequest(
        fx.tenantA.handle,
        String(vehPub.id),
        makeAdminRequest(
          `${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/catalog/${vehPub.id}/publish`,
          "POST",
          { cookie: fx.ownerA.cookie, body: { version: vehPub.version } },
        ),
        runtimeEnv,
      )
    ).json()) as { version: number };

    // Save unpublished draft removing vehCat from offering_taxonomies
    const vehDraftEdit = await handleTenantCatalogOfferingRequest(
      fx.tenantA.handle,
      String(vehPub.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/catalog/${vehPub.id}`, "PATCH", {
        cookie: fx.ownerA.cookie,
        body: { version: vehPublishBody.version, categoryIds: [] },
      }),
      runtimeEnv,
    );
    expect(vehDraftEdit.status).toBe(200);

    // Check `/layanan/category/[slug]` shows ONLY the 1 published service & is indexable
    const layananArchive = await resolveOfferingCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/layanan/category/${svcCat.slug}`),
      publicDeps,
      "service",
      svcCat.slug,
    );
    expect(layananArchive.kind).toBe("offering_category_archive");
    if (layananArchive.kind === "offering_category_archive") {
      expect(layananArchive.http.status).toBe(200);
      expect(layananArchive.items.length).toBe(1);
      expect(layananArchive.items[0]!.title).toBe("Renovasi Ruang Rapat");
      expect(layananArchive.seoMetadata.seoDecision.indexable).toBe(true);
    }

    // Check `/kendaraan/category/[slug]` STILL shows the published vehicle from frozen snapshot
    const kendaraanArchive = await resolveOfferingCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/kendaraan/category/${vehCat.slug}`),
      publicDeps,
      "vehicle",
      vehCat.slug,
    );
    expect(kendaraanArchive.kind).toBe("offering_category_archive");
    if (kendaraanArchive.kind === "offering_category_archive") {
      expect(kendaraanArchive.http.status).toBe(200);
      expect(kendaraanArchive.items.length).toBe(1);
      expect(kendaraanArchive.items[0]!.title).toBe("SUV Hybrid 2025");
    }

    // Cross-offering-type category lookup (`/kendaraan/category/<service-cat>`) returns branded 404!
    const crossOfferingType = await resolveOfferingCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/kendaraan/category/${svcCat.slug}`),
      publicDeps,
      "vehicle",
      svcCat.slug,
    );
    expect(crossOfferingType.kind).toBe("not_found");

    // Disabled blog/catalog returns 404
    await seedTenantShell(fx.tenantA.db, {
      siteTitle: "PT Alpha Taxonomy",
      businessName: "PT Alpha Taxonomy",
      blogEnabled: false,
      catalogEnabled: false,
    });
    const disabledBlog = await resolveBlogCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/blog/category/${catGuide.slug}`),
      publicDeps,
      catGuide.slug,
    );
    expect(disabledBlog.kind).toBe("not_found");
    const disabledCatalog = await resolveOfferingCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/layanan/category/${svcCat.slug}`),
      publicDeps,
      "service",
      svcCat.slug,
    );
    expect(disabledCatalog.kind).toBe("not_found");
  });

  it("persists indexOptIn durably across tenant_activity_log pruning, blocks TOCTOU concurrency races cleanly, filters draft-only child links, and blocks mixed offeringType reassignments", async () => {
    const fx = await provisionTwoTenants("race", runtimeEnv);
    const publicDeps = {
      platformDb: env.PLATFORM_DB,
      tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      bypassHostCache: true,
    };

    // === 1. Durable indexOptIn survives 90-day tenant_activity_log pruning ===
    const durableCat = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.ownerA.cookie,
          body: {
            name: "Strategi Tahan Lama",
            description: "Panduan operasional yang tetap terindeks setelah log aktivitas dibersihkan.",
            indexOptIn: true,
          },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; slug: string; version: number; indexOptIn: boolean };
    expect(durableCat.indexOptIn).toBe(true);

    // Publish 1 post in durableCat
    const pDurable = (await (
      await handleTenantPostsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
          cookie: fx.ownerA.cookie,
          body: {
            title: "Artikel Tahan Pruning",
            bodyHtml: "<p>Konten artikel terbit yang membuktikan durabilitas indexOptIn.</p>",
            primaryCategoryId: durableCat.id,
            categoryIds: [durableCat.id],
          },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; version: number };
    await handleTenantPostPublishRequest(
      fx.tenantA.handle,
      String(pDurable.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${pDurable.id}/publish`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { version: pDurable.version },
      }),
      runtimeEnv,
    );

    // Simulate 90-day retention pruning of ALL rows in tenant_activity_log
    await fx.tenantA.db.prepare(`DELETE FROM tenant_activity_log`).run();

    // Admin GET and public archive MUST still see indexOptIn = true & indexable = true!
    const afterPruneAdmin = (await (
      await handleTenantCategoryItemRequest(
        fx.tenantA.handle,
        String(durableCat.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${durableCat.id}`, "GET", {
          cookie: fx.ownerA.cookie,
        }),
        runtimeEnv,
      )
    ).json()) as { indexOptIn: boolean; indexable: boolean };
    expect(afterPruneAdmin.indexOptIn).toBe(true);
    expect(afterPruneAdmin.indexable).toBe(true);

    const afterPrunePublic = await resolveBlogCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/blog/category/${durableCat.slug}`),
      publicDeps,
      durableCat.slug,
    );
    expect(afterPrunePublic.kind).toBe("blog_taxonomy_archive");
    if (afterPrunePublic.kind === "blog_taxonomy_archive") {
      expect(afterPrunePublic.seoMetadata.seoDecision.indexable).toBe(true);
    }

    // === 2. Public loadChildCategoryLinks excludes draft-only child categories ===
    const pubChild = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { name: "Sub Terbit", parentId: durableCat.id },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; slug: string };

    const draftOnlyChild = (await (
      await handleTenantCategoriesCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories`, "POST", {
          cookie: fx.ownerA.cookie,
          body: { name: "Sub Rahasia Draf", parentId: durableCat.id },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; slug: string };

    const pChild = (await (
      await handleTenantPostsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
          cookie: fx.ownerA.cookie,
          body: {
            title: "Artikel Sub Terbit",
            bodyHtml: "<p>Isi sub kategori terbit.</p>",
            primaryCategoryId: pubChild.id,
            categoryIds: [pubChild.id],
          },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; version: number };
    await handleTenantPostPublishRequest(
      fx.tenantA.handle,
      String(pChild.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${pChild.id}/publish`, "POST", {
        cookie: fx.ownerA.cookie,
        body: { version: pChild.version },
      }),
      runtimeEnv,
    );
    // Assign a DRAFT post to draftOnlyChild
    await handleTenantPostsCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
        cookie: fx.ownerA.cookie,
        body: {
          title: "Draf Sub Rahasia",
          bodyHtml: "<p>Belum terbit.</p>",
          primaryCategoryId: draftOnlyChild.id,
          categoryIds: [draftOnlyChild.id],
        },
      }),
      runtimeEnv,
    );

    const parentPublic = await resolveBlogCategoryArchiveRoute(
      new Request(`https://${fx.tenantA.host}/blog/category/${durableCat.slug}`),
      publicDeps,
      durableCat.slug,
    );
    expect(parentPublic.kind).toBe("blog_taxonomy_archive");
    if (parentPublic.kind === "blog_taxonomy_archive") {
      expect(parentPublic.childCategories.map((c) => c.slug)).toEqual([pubChild.slug]);
    }

    // === 3. Concurrent edit during deleteTaxonomy -> 409 STALE_VERSION & ZERO clobbered post content ===
    const catDeleteRace = await createTaxonomy(fx.tenantA.db, {
      kind: "post_category",
      name: "Kategori Race Delete",
    });
    const catFallback = await createTaxonomy(fx.tenantA.db, {
      kind: "post_category",
      name: "Kategori Fallback",
    });
    const racePost = (await (
      await handleTenantPostsCollectionRequest(
        fx.tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts`, "POST", {
          cookie: fx.ownerA.cookie,
          body: {
            title: "Judul Awal",
            bodyHtml: "<p>Isi awal sebelum suntingan bersamaan.</p>",
            primaryCategoryId: catDeleteRace.id,
            categoryIds: [catDeleteRace.id],
          },
        }),
        runtimeEnv,
      )
    ).json()) as { id: number; version: number };

    // Intercept right before deleteTaxonomy commits its batch: simulate a concurrent edit on racePost!
    const racingDeleteDb = withBeforeNextBatchHook(fx.tenantA.db, async () => {
      await handleTenantPostItemRequest(
        fx.tenantA.handle,
        String(racePost.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${racePost.id}`, "PATCH", {
          cookie: fx.ownerA.cookie,
          body: { title: "Judul Suntingan Baru", version: racePost.version },
        }),
        runtimeEnv,
      );
    });

    await expect(
      deleteTaxonomy(racingDeleteDb, {
        kind: "post_category",
        taxonomyId: catDeleteRace.id,
        expectedVersion: catDeleteRace.version,
        reassignToId: catFallback.id,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: "STALE_VERSION" });

    // Verify concurrent edit was NOT clobbered and category still exists!
    const postAfterAbortedDel = (await (
      await handleTenantPostItemRequest(
        fx.tenantA.handle,
        String(racePost.id),
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/posts/${racePost.id}`, "GET", {
          cookie: fx.ownerA.cookie,
        }),
        runtimeEnv,
      )
    ).json()) as { title: string; version: number };
    expect(postAfterAbortedDel.title).toBe("Judul Suntingan Baru");
    expect(postAfterAbortedDel.version).toBe(racePost.version + 1);

    // Now retry cleanly with fresh DB: succeeds AND bumps post version + updated_at!
    const beforeRetryRow = await fx.tenantA.db
      .prepare(`SELECT version, updated_at FROM posts WHERE id = ?`)
      .bind(racePost.id)
      .first<{ version: number; updated_at: number }>();
    await deleteTaxonomy(fx.tenantA.db, {
      kind: "post_category",
      taxonomyId: catDeleteRace.id,
      expectedVersion: catDeleteRace.version,
      reassignToId: catFallback.id,
      nowMs: BASE_NOW_MS + 99_999,
    });
    const afterRetryRow = await fx.tenantA.db
      .prepare(`SELECT version, updated_at, primary_category_id FROM posts WHERE id = ?`)
      .bind(racePost.id)
      .first<{ version: number; updated_at: number; primary_category_id: number }>();
    expect(Number(afterRetryRow?.version)).toBe(Number(beforeRetryRow?.version) + 1);
    expect(Number(afterRetryRow?.updated_at)).toBe(BASE_NOW_MS + 99_999);
    expect(Number(afterRetryRow?.primary_category_id)).toBe(catFallback.id);

    // === 4. Concurrent reparent cycle & concurrently deleted parent -> 422 (ZERO cycle, ZERO 503!) ===
    const nodeA = await createTaxonomy(fx.tenantA.db, { kind: "post_category", name: "Node Cycle A" });
    const nodeB = await createTaxonomy(fx.tenantA.db, { kind: "post_category", name: "Node Cycle B" });

    // Before updateTaxonomy(A -> parent B) commits, B is concurrently reparented under A!
    const cycleRaceDb = withBeforeNextBatchHook(fx.tenantA.db, async () => {
      await updateTaxonomy(fx.tenantA.db, {
        kind: "post_category",
        taxonomyId: nodeB.id,
        expectedVersion: nodeB.version,
        parentId: nodeA.id,
      });
    });

    await expect(
      updateTaxonomy(cycleRaceDb, {
        kind: "post_category",
        taxonomyId: nodeA.id,
        expectedVersion: nodeA.version,
        parentId: nodeB.id,
      }),
    ).rejects.toMatchObject({ httpStatus: 422, code: "TAXONOMY_CYCLE_OR_DEPTH" });

    // Confirm ZERO cycle in DB: A still has parent_id = NULL while B has parent_id = A.id
    const nodeARow = await fx.tenantA.db
      .prepare(`SELECT parent_id, depth FROM taxonomies WHERE id = ?`)
      .bind(nodeA.id)
      .first<{ parent_id: number | null; depth: number }>();
    expect(nodeARow?.parent_id).toBeNull();
    expect(Number(nodeARow?.depth)).toBe(1);

    // Concurrently deleted parent right before createTaxonomy commits -> 422 INVALID_PARENT (never 503!)
    const ephemeralParent = await createTaxonomy(fx.tenantA.db, {
      kind: "post_category",
      name: "Induk Akan Dihapus",
    });
    const deletedParentRaceDb = withBeforeNextBatchHook(fx.tenantA.db, async () => {
      await deleteTaxonomy(fx.tenantA.db, {
        kind: "post_category",
        taxonomyId: ephemeralParent.id,
        expectedVersion: ephemeralParent.version,
      });
    });
    await expect(
      createTaxonomy(deletedParentRaceDb, {
        kind: "post_category",
        name: "Anak Yatim",
        parentId: ephemeralParent.id,
      }),
    ).rejects.toMatchObject({ httpStatus: 422, code: "INVALID_PARENT" });

    // === 5. Interleaved assignment right before deleteTaxonomy (without detach/reassign) -> 409 TAXONOMY_IN_USE ===
    const unusedCat = await createTaxonomy(fx.tenantA.db, {
      kind: "post_category",
      name: "Kategori Baru Kosong",
    });
    const interleavedUsageDb = withBeforeNextBatchHook(fx.tenantA.db, async () => {
      await fx.tenantA.db
        .prepare(`INSERT INTO post_taxonomies (post_id, taxonomy_id) VALUES (?, ?)`)
        .bind(racePost.id, unusedCat.id)
        .run();
    });
    await expect(
      deleteTaxonomy(interleavedUsageDb, {
        kind: "post_category",
        taxonomyId: unusedCat.id,
        expectedVersion: unusedCat.version,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: "TAXONOMY_IN_USE" });

    // Confirm unusedCat still exists (NOT deleted!)
    const stillThere = await fx.tenantA.db
      .prepare(`SELECT id FROM taxonomies WHERE id = ?`)
      .bind(unusedCat.id)
      .first<{ id: number }>();
    expect(Number(stillThere?.id)).toBe(unusedCat.id);

    // === 6. Mixed offeringType reassignment (untyped offering_category with service -> vehicle category) -> 422 ===
    const untypedCat = await createTaxonomy(fx.tenantA.db, {
      kind: "offering_category",
      offeringType: null,
      name: "Kategori Umum Katalog",
    });
    const vehicleTypedCat = await createTaxonomy(fx.tenantA.db, {
      kind: "offering_category",
      offeringType: "vehicle",
      name: "Kategori Khusus Mobil",
    });
    const svcOfferingRes = await handleTenantCatalogCollectionRequest(
      fx.tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/catalog`, "POST", {
        cookie: fx.ownerA.cookie,
        body: {
          offeringType: "service",
          title: "Jasa Audit Sistem",
          priceMode: "on_request",
          ctaMode: "whatsapp",
          categoryIds: [untypedCat.id],
        },
      }),
      runtimeEnv,
    );
    expect(svcOfferingRes.status).toBe(201);

    const mixedReassignRes = await handleTenantCategoryItemRequest(
      fx.tenantA.handle,
      String(untypedCat.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${fx.tenantA.handle}/categories/${untypedCat.id}`, "DELETE", {
        cookie: fx.ownerA.cookie,
        body: { version: untypedCat.version, reassignToId: vehicleTypedCat.id },
      }),
      runtimeEnv,
    );
    expect(mixedReassignRes.status).toBe(422);
    expect(((await mixedReassignRes.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_REASSIGN_TARGET",
    );

    // === 7. O(1) bind parameters via json_each: deleting category with 40 posts succeeds atomically ===
    const bulkCat = await createTaxonomy(fx.tenantA.db, {
      kind: "post_category",
      name: "Kategori Skala Besar",
    });
    const bulkTargetCat = await createTaxonomy(fx.tenantA.db, {
      kind: "post_category",
      name: "Kategori Tujuan Skala Besar",
    });

    const bulkStmts: D1PreparedStatement[] = [];
    for (let i = 1; i <= 40; i += 1) {
      const postId = 1000 + i;
      const slug = `artikel-skala-${i}`;
      const snapshotJson = JSON.stringify({
        snapshotVersion: 1,
        resourceType: "post",
        data: {
          slug,
          title: `Artikel Skala ${i}`,
          excerpt: null,
          body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: `Isi ${i}` }] },
          sanitizedHtml: `<p>Isi ${i}</p>`,
          readingTimeMinutes: 1,
          primaryCategoryId: bulkCat.id,
          categoryIds: [bulkCat.id],
          tagIds: [],
          showToc: false,
        },
      });
      bulkStmts.push(
        fx.tenantA.db
          .prepare(
            `INSERT INTO posts (
               id, slug, title, excerpt, draft_body_json, published_body_json,
               primary_category_id, reading_time_minutes, show_toc,
               status, published_at, content_modified_at, deleted_at, version, created_at, updated_at
             ) VALUES (?, ?, ?, NULL, ?, ?, ?, 1, 0, 'published', ?, ?, NULL, 1, ?, ?)`,
          )
          .bind(
            postId,
            slug,
            `Artikel Skala ${i}`,
            snapshotJson,
            snapshotJson,
            bulkCat.id,
            BASE_NOW_MS,
            BASE_NOW_MS,
            BASE_NOW_MS,
            BASE_NOW_MS,
          ),
        fx.tenantA.db
          .prepare(`INSERT INTO post_taxonomies (post_id, taxonomy_id) VALUES (?, ?)`)
          .bind(postId, bulkCat.id),
      );
    }
    await fx.tenantA.db.batch(bulkStmts);

    // Reassign & delete category with 40 posts (far beyond D1/DO SQLite's 100-bind limit if O(N)!)
    const bulkDelResult = await deleteTaxonomy(fx.tenantA.db, {
      kind: "post_category",
      taxonomyId: bulkCat.id,
      expectedVersion: bulkCat.version,
      reassignToId: bulkTargetCat.id,
      nowMs: BASE_NOW_MS + 200_000,
    });
    expect(bulkDelResult.deletedId).toBe(bulkCat.id);
    expect(bulkDelResult.reassignedToId).toBe(bulkTargetCat.id);
    expect(bulkDelResult.affectedPublishedCount).toBe(40);

    // Verify ALL 40 posts survived, now belong to bulkTargetCat, and bumped version to 2
    const bulkCheck = await fx.tenantA.db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM posts
         WHERE id BETWEEN 1001 AND 1040
           AND primary_category_id = ?
           AND version = 2`,
      )
      .bind(bulkTargetCat.id)
      .first<{ cnt: number }>();
    expect(Number(bulkCheck?.cnt)).toBe(40);

    // === 8. Interleaved assignment right before detach-delete on 0-count category -> 409 STALE_VERSION ===
    const zeroDetachCat = await createTaxonomy(fx.tenantA.db, {
      kind: "post_category",
      name: "Kategori Kosong Detach Race",
    });
    const zeroDetachRaceDb = withBeforeNextBatchHook(fx.tenantA.db, async () => {
      await fx.tenantA.db
        .prepare(`INSERT INTO post_taxonomies (post_id, taxonomy_id) VALUES (?, ?)`)
        .bind(1001, zeroDetachCat.id)
        .run();
    });
    await expect(
      deleteTaxonomy(zeroDetachRaceDb, {
        kind: "post_category",
        taxonomyId: zeroDetachCat.id,
        expectedVersion: zeroDetachCat.version,
        detach: true,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: "STALE_VERSION" });
  });
});

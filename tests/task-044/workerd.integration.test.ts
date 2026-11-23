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
import { listCatalogOfferings } from "@punyasitus/db/catalog/index";
import { getPublishedPage, listPages, PAGES_LAYOUT_MODE_MIGRATION } from "@punyasitus/db/pages/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import { getPublishedPost, listPosts } from "@punyasitus/db/posts/index";
import { MEDIA_PIPELINE_MIGRATION } from "@punyasitus/db/storage-usage/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import {
  purgeContentItem,
  restoreContentItem,
  sweepExpiredTrashedContent,
  TRASH_RETENTION_MS,
  TrashConflictError,
  TrashProtectedReferenceError,
  type ProtectedReferencePurgeFailure,
} from "@punyasitus/db/trash/index";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantCatalogOfferingRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/index.ts";
import { handleTenantCatalogOfferingPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/publish.ts";
import { handleTenantCatalogPurgeRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/purge.ts";
import { handleTenantCatalogRestoreRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/restore.ts";
import { handleTenantCatalogTrashRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/trash.ts";
import { handleTenantCatalogCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/index.ts";
import { handleTenantCatalogTrashListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/trash.ts";
import { handleTenantPagePublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/publish.ts";
import { handleTenantPagePurgeRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/purge.ts";
import { handleTenantPageRestoreRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/restore.ts";
import { handleTenantPageTrashRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/trash.ts";
import { handleTenantPagesCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/index.ts";
import { handleTenantPagesTrashListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/trash.ts";
import type { TenantPagesRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/_shared.ts";
import { handleTenantPostPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/publish.ts";
import { handleTenantPostPurgeRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/purge.ts";
import { handleTenantPostRestoreRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/restore.ts";
import { handleTenantPostTrashRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/trash.ts";
import { handleTenantPostsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/index.ts";
import { handleTenantPostsTrashListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/trash.ts";
import { processDurableQueueBatch } from "../../apps/web/src/worker/queues/consumer.ts";
import {
  CONTENT_PURGE_SWEEP_TOPIC,
  createContentPurgeJobRegistry,
  type ContentPurgeQueueSummary,
} from "../../apps/web/src/worker/queues/content-purge/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 5, 0, 0);

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
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractSessionCookiePair(response: Response): string {
  const cookies = getSetCookies(response.headers);
  const found = cookies.find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!found) {
    throw new Error(`Expected ${APP_SESSION_COOKIE_NAME} in Set-Cookie, got: ${JSON.stringify(cookies)}`);
  }
  return (found.split(";")[0] ?? "").trim();
}

function makeAdminRequest(
  url: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
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
      PAGES_LAYOUT_MODE_MIGRATION,
    ]),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function signUpUser(
  runtimeEnv: TenantPagesRuntimeEnv,
  email: string,
  name: string,
): Promise<{ readonly userId: string; readonly cookie: string }> {
  const res = await handleBetterAuthRequest(
    new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
      body: JSON.stringify({ email, password: "StrongPassword!44", name }),
    }),
    runtimeEnv,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  return { userId: body.user.id, cookie: extractSessionCookiePair(res) };
}

async function seedTenantWithUsers(suffix: string, runtimeEnv: TenantPagesRuntimeEnv) {
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const tenantId = `01JTRASH4400000000000000${suffix}`;
  const orgId = `org_t044_${suffix}`;
  const handle = `trash-t044-${suffix.toLowerCase()}`;

  const owner = await signUpUser(runtimeEnv, `owner-${suffix}@trash44.test`, `Owner ${suffix}`);
  const admin = await signUpUser(runtimeEnv, `admin-${suffix}@trash44.test`, `Admin ${suffix}`);
  const editor = await signUpUser(runtimeEnv, `editor-${suffix}@trash44.test`, `Editor ${suffix}`);

  await db.insert(organizations).values({
    id: orgId,
    name: `Bisnis ${suffix}`,
    slug: handle,
    createdAt: new Date(BASE_NOW_MS),
    updatedAt: new Date(BASE_NOW_MS),
  });

  await db.insert(tenants).values({
    id: tenantId,
    organizationId: orgId,
    handle,
    name: `Bisnis ${suffix}`,
    vertical: "compro",
    status: "active",
    schemaVersion: 3,
    cacheVersion: 1,
    createdAt: new Date(BASE_NOW_MS),
    updatedAt: new Date(BASE_NOW_MS),
  });

  await db.insert(members).values([
    { id: `mem_owner_${suffix}`, organizationId: orgId, userId: owner.userId, role: "owner", createdAt: new Date(BASE_NOW_MS) },
    { id: `mem_admin_${suffix}`, organizationId: orgId, userId: admin.userId, role: "admin", createdAt: new Date(BASE_NOW_MS) },
    { id: `mem_editor_${suffix}`, organizationId: orgId, userId: editor.userId, role: "editor", createdAt: new Date(BASE_NOW_MS) },
  ]);

  const tenantDb = await openMigratedTenantDb(tenantId);
  return { tenantId, orgId, handle, tenantDb, owner, admin, editor };
}

async function readCacheVersion(tenantId: string): Promise<number> {
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const row = await db
    .select({ cacheVersion: tenants.cacheVersion })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .get();
  return row?.cacheVersion ?? 0;
}

async function insertReadyMedia(tenantDb: D1Database, id: number, tenantId: string): Promise<void> {
  await tenantDb
    .prepare(
      `INSERT INTO media_items (
         id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, status, version, created_at, updated_at
       ) VALUES (?, 'image', ?, 'image/webp', 2048, ?, 800, 600, 'Foto Bersama', 'ready', 1, ?, ?)`,
    )
    .bind(id, `t/${tenantId}/img/${id}.webp`, `sha256_media_${id}`, BASE_NOW_MS, BASE_NOW_MS)
    .run();
}

describe("TASK-044 integration: atomic trash, conflict-safe restore, media inspection, protected purge & 30-day worker", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("atomically unpublishes on trash, updates cache_version + audit, restores with 409 slug/version checks & media warnings without auto-publish", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const tenant = await seedTenantWithUsers("01", runtimeEnv);

    // Seed two media items: #101 (will be trashed before restore) and #102 (will be purged before restore)
    await insertReadyMedia(tenant.tenantDb, 101, tenant.tenantId);
    await insertReadyMedia(tenant.tenantDb, 102, tenant.tenantId);

    // 1. Create & publish Page, Post, and Catalog Offering
    const pageCreateRes = await handleTenantPagesCollectionRequest(
      tenant.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages`, "POST", {
        cookie: tenant.editor.cookie,
        body: {
          title: "Layanan Konsultasi",
          slug: "layanan-konsultasi",
          sections: [
            {
              id: "sec-hero",
              kind: "hero",
              heading: "Konsultasi Bisnis",
              subheading: "Pendampingan strategis untuk UMKM dan korporasi",
              bodyHtml: "<p>Layanan konsultasi terpadu.</p>",
            },
          ],
          seo: { ogImageMediaId: 102 },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(pageCreateRes.status).toBe(201);
    const createdPage = (await pageCreateRes.json()) as { id: number; slug: string; version: number };

    const pagePubRes = await handleTenantPagePublishRequest(
      tenant.handle,
      String(createdPage.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages/${createdPage.id}/publish`, "POST", {
        cookie: tenant.editor.cookie,
        body: { version: createdPage.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(pagePubRes.status).toBe(200);
    const publishedPage = (await pagePubRes.json()) as { id: number; version: number };
    expect(await getPublishedPage(tenant.tenantDb, { pageId: createdPage.id })).not.toBeNull();

    const cacheBeforeTrash = await readCacheVersion(tenant.tenantId);

    // 2. Trash published page -> atomic unpublish, cache_version bump, audit recorded, draft preserved
    const pageTrashRes = await handleTenantPageTrashRequest(
      tenant.handle,
      String(createdPage.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages/${createdPage.id}/trash`, "POST", {
        cookie: tenant.editor.cookie,
        body: { version: publishedPage.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_000 },
    );
    expect(pageTrashRes.status).toBe(200);
    const trashedPage = (await pageTrashRes.json()) as {
      id: number;
      status: string;
      version: number;
      published: unknown;
      sections: unknown[];
      trashMeta: { daysRemaining: number };
    };
    expect(trashedPage.status).toBe("trashed");
    expect(trashedPage.published).toBeNull();
    expect(trashedPage.sections.length).toBe(1);
    expect(trashedPage.trashMeta.daysRemaining).toBe(30);

    // Immediately removed from published queries / sitemap / active listing
    expect(await getPublishedPage(tenant.tenantDb, { pageId: createdPage.id })).toBeNull();
    const activePages = await listPages(tenant.tenantDb, { status: "published" });
    expect(activePages.items.find((p) => p.id === createdPage.id)).toBeUndefined();
    expect(await readCacheVersion(tenant.tenantId)).toBeGreaterThan(cacheBeforeTrash);

    // Audit row recorded atomically via WHERE changes() = 1
    const trashAudit = await tenant.tenantDb
      .prepare(`SELECT action, actor_role FROM tenant_activity_log WHERE action = 'content.trashed' AND resource_id = ?`)
      .bind(String(createdPage.id))
      .first<{ action: string; actor_role: string }>();
    expect(trashAudit?.action).toBe("content.trashed");
    expect(trashAudit?.actor_role).toBe("editor");

    // 3. Stale expectedVersion on restore -> 409 STALE_VERSION, zero mutation
    const staleRestoreRes = await handleTenantPageRestoreRequest(
      tenant.handle,
      String(createdPage.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages/${createdPage.id}/restore`, "POST", {
        cookie: tenant.editor.cookie,
        body: { expectedVersion: trashedPage.version - 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_000 },
    );
    expect(staleRestoreRes.status).toBe(409);
    const staleBody = (await staleRestoreRes.json()) as { error: { code: string } };
    expect(staleBody.error.code).toBe("STALE_VERSION");

    // 4. Create slug collision via active redirect on `/layanan-konsultasi` -> restore MUST return 409 CONFLICT with suggestedSlug
    await tenant.tenantDb
      .prepare(
        `INSERT INTO redirects (source_path, target_path, status_code, active, version, created_at, updated_at)
         VALUES ('/layanan-konsultasi', '/layanan-baru', 308, 1, 1, ?, ?)`,
      )
      .bind(BASE_NOW_MS, BASE_NOW_MS)
      .run();

    const conflictRestoreRes = await handleTenantPageRestoreRequest(
      tenant.handle,
      String(createdPage.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages/${createdPage.id}/restore`, "POST", {
        cookie: tenant.editor.cookie,
        body: { expectedVersion: trashedPage.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4_000 },
    );
    expect(conflictRestoreRes.status).toBe(409);
    const conflictBody = (await conflictRestoreRes.json()) as {
      error: { code: string; suggestedSlug?: string; conflictKind?: string; fields?: { code: string }[] };
    };
    expect(conflictBody.error.code).toBe("CONFLICT");
    expect(conflictBody.error.fields?.[0]?.code).toBe("SLUG_CONFLICT");
    expect(conflictBody.error.suggestedSlug).toBe("layanan-konsultasi-2");
    expect(conflictBody.error.conflictKind).toBe("custom_redirect");

    // Verify ZERO partial restore on 409 conflict
    const stillTrashed = await tenant.tenantDb
      .prepare(`SELECT status, deleted_at FROM pages WHERE id = ?`)
      .bind(createdPage.id)
      .first<{ status: string; deleted_at: number | null }>();
    expect(stillTrashed?.status).toBe("trashed");
    expect(stillTrashed?.deleted_at).not.toBeNull();

    // 5. Trash media #101 and permanently delete media #102 BEFORE restoring page -> media warnings reported cleanly without corrupting draft!
    await tenant.tenantDb
      .prepare(`UPDATE media_items SET deleted_at = ? WHERE id = 101`)
      .bind(BASE_NOW_MS + 4_500)
      .run();
    await tenant.tenantDb.prepare(`DELETE FROM media_items WHERE id = 102`).run();

    const resolvedRestoreRes = await handleTenantPageRestoreRequest(
      tenant.handle,
      String(createdPage.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages/${createdPage.id}/restore`, "POST", {
        cookie: tenant.editor.cookie,
        body: { expectedVersion: trashedPage.version, resolvedSlug: "layanan-konsultasi-pulih" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5_000 },
    );
    expect(resolvedRestoreRes.status).toBe(200);
    const restoredPage = (await resolvedRestoreRes.json()) as {
      status: string;
      slug: string;
      slugChanged: boolean;
      previousSlug: string;
      published: unknown;
      sections: unknown[];
      mediaReferences: {
        trashedMediaIds: number[];
        missingMediaIds: number[];
        warnings: { mediaId: number; status: string }[];
      };
    };
    expect(restoredPage.status).toBe("draft");
    expect(restoredPage.published).toBeNull(); // NEVER auto-published!
    expect(restoredPage.slug).toBe("layanan-konsultasi-pulih");
    expect(restoredPage.slugChanged).toBe(true);
    expect(restoredPage.previousSlug).toBe("layanan-konsultasi");
    expect(restoredPage.sections.length).toBe(1); // Draft content preserved intact!
    expect(restoredPage.mediaReferences.missingMediaIds).toEqual([102]);
    expect(restoredPage.mediaReferences.warnings.length).toBe(1);

    // 6. Verify Catalog Offering Trash & Restore as well (including public listing exclusion)
    const offCreateRes = await handleTenantCatalogCollectionRequest(
      tenant.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/catalog`, "POST", {
        cookie: tenant.editor.cookie,
        body: {
          offeringType: "service",
          title: "Jasa Audit Website",
          slug: "jasa-audit-website",
          priceMode: "fixed",
          price: 2500000,
          ctaMode: "inquiry",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6_000 },
    );
    expect(offCreateRes.status).toBe(201);
    const createdOff = (await offCreateRes.json()) as { id: number; version: number };

    const offPubRes = await handleTenantCatalogOfferingPublishRequest(
      tenant.handle,
      String(createdOff.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/catalog/${createdOff.id}/publish`, "POST", {
        cookie: tenant.editor.cookie,
        body: { expectedVersion: createdOff.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6_500 },
    );
    expect(offPubRes.status).toBe(200);
    const pubOff = (await offPubRes.json()) as { version: number };

    const offTrashRes = await handleTenantCatalogTrashRequest(
      tenant.handle,
      String(createdOff.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/catalog/${createdOff.id}/trash`, "POST", {
        cookie: tenant.editor.cookie,
        body: { expectedVersion: pubOff.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7_000 },
    );
    expect(offTrashRes.status).toBe(200);
    const trashedOff = (await offTrashRes.json()) as { status: string; version: number };
    expect(trashedOff.status).toBe("trashed");

    const activeCatalog = await listCatalogOfferings(tenant.tenantDb, { status: "published" });
    expect(activeCatalog.items.find((o) => o.id === createdOff.id)).toBeUndefined();

    const offRestoreRes = await handleTenantCatalogRestoreRequest(
      tenant.handle,
      String(createdOff.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/catalog/${createdOff.id}/restore`, "POST", {
        cookie: tenant.editor.cookie,
        body: { expectedVersion: trashedOff.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8_000 },
    );
    expect(offRestoreRes.status).toBe(200);
    const restoredOff = (await offRestoreRes.json()) as { status: string; version: number };
    expect(restoredOff.status).toBe("draft");

    // Re-trash catalog offering, list via /catalog/trash, verify editor cannot purge (403), owner purges cleanly (200)
    const offTrash2Res = await handleTenantCatalogTrashRequest(
      tenant.handle,
      String(createdOff.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/catalog/${createdOff.id}/trash`, "POST", {
        cookie: tenant.editor.cookie,
        body: { expectedVersion: restoredOff.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8_200 },
    );
    expect(offTrash2Res.status).toBe(200);
    const trashedOff2 = (await offTrash2Res.json()) as { version: number };

    const catTrashListRes = await handleTenantCatalogTrashListRequest(
      tenant.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/catalog/trash?offeringType=service`, "GET", {
        cookie: tenant.editor.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8_300 },
    );
    expect(catTrashListRes.status).toBe(200);
    const catTrashList = (await catTrashListRes.json()) as { items: { resourceId: number }[] };
    expect(catTrashList.items.some((it) => it.resourceId === createdOff.id)).toBe(true);

    const catEditorPurgeRes = await handleTenantCatalogPurgeRequest(
      tenant.handle,
      String(createdOff.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/catalog/${createdOff.id}/purge`, "POST", {
        cookie: tenant.editor.cookie,
        body: { expectedVersion: trashedOff2.version, confirmPermanentDelete: true },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8_400 },
    );
    expect(catEditorPurgeRes.status).toBe(403);

    const catOwnerPurgeRes = await handleTenantCatalogPurgeRequest(
      tenant.handle,
      String(createdOff.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/catalog/${createdOff.id}/purge`, "POST", {
        cookie: tenant.owner.cookie,
        body: { expectedVersion: trashedOff2.version, confirmPermanentDelete: true },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8_500 },
    );
    expect(catOwnerPurgeRes.status).toBe(200);

    // Also verify Post trash -> restore to draft (never auto-published) + trashed media reference warning (#101)
    // Restore media #101 briefly so post creation validates cleanly, then trash #101 again before post restore
    await tenant.tenantDb.prepare(`UPDATE media_items SET deleted_at = NULL WHERE id = 101`).run();
    const postDraftRes = await handleTenantPostsCollectionRequest(
      tenant.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/posts`, "POST", {
        cookie: tenant.editor.cookie,
        body: {
          title: "Artikel Pemulihan",
          slug: "artikel-pemulihan",
          coverMediaId: 101,
          body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Konten uji pemulihan." }] },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8_600 },
    );
    expect(postDraftRes.status).toBe(201);
    const createdPost = (await postDraftRes.json()) as { id: number; version: number };

    const postTrashRes = await handleTenantPostTrashRequest(
      tenant.handle,
      String(createdPost.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/posts/${createdPost.id}/trash`, "POST", {
        cookie: tenant.editor.cookie,
        body: { version: createdPost.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8_700 },
    );
    expect(postTrashRes.status).toBe(200);
    const trashedPost = (await postTrashRes.json()) as { version: number };

    await tenant.tenantDb
      .prepare(`UPDATE media_items SET deleted_at = ? WHERE id = 101`)
      .bind(BASE_NOW_MS + 8_750)
      .run();

    const postRestoreRes = await handleTenantPostRestoreRequest(
      tenant.handle,
      String(createdPost.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/posts/${createdPost.id}/restore`, "POST", {
        cookie: tenant.editor.cookie,
        body: { expectedVersion: trashedPost.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8_800 },
    );
    expect(postRestoreRes.status).toBe(200);
    const restoredPost = (await postRestoreRes.json()) as {
      status: string;
      mediaReferences: { trashedMediaIds: number[]; warnings: unknown[] };
    };
    expect(restoredPost.status).toBe("draft");
    expect(restoredPost.mediaReferences.trashedMediaIds).toEqual([101]);
    expect(restoredPost.mediaReferences.warnings.length).toBe(1);
  }, 25_000);

  it("enforces owner/admin purge RBAC, blocks protected homepage/policy/menu references, clears joins/slugs/revisions, preserves shared media, and isolates tenants + locked state", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const tenantA = await seedTenantWithUsers("02", runtimeEnv);
    const tenantB = await seedTenantWithUsers("03", runtimeEnv);

    // Seed shared media #201 used by BOTH Post 1 (to be purged) AND Post 2 (active)
    await insertReadyMedia(tenantA.tenantDb, 201, tenantA.tenantId);

    // Seed blog category & post_taxonomies + content_revisions
    await tenantA.tenantDb
      .prepare(
        `INSERT INTO taxonomies (id, taxonomy_type, depth, slug, name, sort_order, version, created_at, updated_at)
         VALUES (10, 'post_category', 0, 'panduan', 'Panduan', 0, 1, ?, ?)`,
      )
      .bind(BASE_NOW_MS, BASE_NOW_MS)
      .run();

    const post1Res = await handleTenantPostsCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/posts`, "POST", {
        cookie: tenantA.owner.cookie,
        body: {
          title: "Artikel Shared Media",
          slug: "artikel-shared-media",
          body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Isi artikel satu." }] },
          coverMediaId: 201,
          categoryIds: [10],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(post1Res.status).toBe(201);
    const post1 = (await post1Res.json()) as { id: number; version: number };

    // Publish post1 so it creates a revision in content_revisions and resource_slugs
    const pubPost1 = await handleTenantPostPublishRequest(
      tenantA.handle,
      String(post1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/posts/${post1.id}/publish`, "POST", {
        cookie: tenantA.owner.cookie,
        body: { version: post1.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(pubPost1.status).toBe(200);
    const pubPost1Body = (await pubPost1.json()) as { version: number };

    // Second active post referencing the SAME shared media #201
    const post2Res = await handleTenantPostsCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/posts`, "POST", {
        cookie: tenantA.owner.cookie,
        body: {
          title: "Artikel Tetap Aktif",
          slug: "artikel-tetap-aktif",
          body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Memakai media bersama." }] },
          coverMediaId: 201,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_500 },
    );
    expect(post2Res.status).toBe(201);

    // Trash post1
    const trashPost1Res = await handleTenantPostTrashRequest(
      tenantA.handle,
      String(post1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/posts/${post1.id}/trash`, "POST", {
        cookie: tenantA.editor.cookie,
        body: { version: pubPost1Body.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_000 },
    );
    expect(trashPost1Res.status).toBe(200);
    const trashedPost1 = (await trashPost1Res.json()) as { version: number };
    expect(await getPublishedPost(tenantA.tenantDb, { postId: post1.id })).toBeNull();
    expect((await listPosts(tenantA.tenantDb, { status: "published" })).items.length).toBe(0);

    // Cross-tenant isolation: Tenant B owner gets 404 on Tenant A trash list & purge!
    const crossListRes = await handleTenantPostsTrashListRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/posts/trash`, "GET", {
        cookie: tenantB.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_500 },
    );
    expect(crossListRes.status).toBe(404);

    const crossPurgeRes = await handleTenantPostPurgeRequest(
      tenantA.handle,
      String(post1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/posts/${post1.id}/purge`, "POST", {
        cookie: tenantB.owner.cookie,
        body: { expectedVersion: trashedPost1.version, confirmPermanentDelete: true },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_500 },
    );
    expect(crossPurgeRes.status).toBe(404);

    // Editor CANNOT permanently purge (403 FORBIDDEN)
    const editorPurgeRes = await handleTenantPostPurgeRequest(
      tenantA.handle,
      String(post1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/posts/${post1.id}/purge`, "POST", {
        cookie: tenantA.editor.cookie,
        body: { expectedVersion: trashedPost1.version, confirmPermanentDelete: true },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_000 },
    );
    expect(editorPurgeRes.status).toBe(403);

    // Missing confirmPermanentDelete -> 422 VALIDATION_ERROR
    const noConfirmPurgeRes = await handleTenantPostPurgeRequest(
      tenantA.handle,
      String(post1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/posts/${post1.id}/purge`, "POST", {
        cookie: tenantA.admin.cookie,
        body: { expectedVersion: trashedPost1.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_100 },
    );
    expect(noConfirmPurgeRes.status).toBe(422);

    // Admin permanently purges post1 -> clears post_taxonomies, resource_slugs, content_revisions, PRESERVES shared media #201!
    const adminPurgeRes = await handleTenantPostPurgeRequest(
      tenantA.handle,
      String(post1.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/posts/${post1.id}/purge`, "POST", {
        cookie: tenantA.admin.cookie,
        body: { expectedVersion: trashedPost1.version, confirmPermanentDelete: true },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_500 },
    );
    expect(adminPurgeRes.status).toBe(200);
    const purgedPostBody = (await adminPurgeRes.json()) as {
      purged: boolean;
      clearedCounts: { taxonomies: number; resourceSlugs: number; revisions: number };
      preservedMediaIds: number[];
    };
    expect(purgedPostBody.purged).toBe(true);
    expect(purgedPostBody.clearedCounts.taxonomies).toBeGreaterThanOrEqual(1);
    expect(purgedPostBody.clearedCounts.resourceSlugs).toBeGreaterThanOrEqual(1);
    expect(purgedPostBody.clearedCounts.revisions).toBeGreaterThanOrEqual(1);
    expect(purgedPostBody.preservedMediaIds).toContain(201);

    // Verify DB state: join rows, slugs, revisions, post row ALL gone; shared media #201 STILL intact!
    const remainingJoins = await tenantA.tenantDb
      .prepare(`SELECT COUNT(*) AS cnt FROM post_taxonomies WHERE post_id = ?`)
      .bind(post1.id)
      .first<{ cnt: number }>();
    expect(remainingJoins?.cnt).toBe(0);

    const remainingRevs = await tenantA.tenantDb
      .prepare(`SELECT COUNT(*) AS cnt FROM content_revisions WHERE resource_type = 'post' AND resource_id = ?`)
      .bind(post1.id)
      .first<{ cnt: number }>();
    expect(remainingRevs?.cnt).toBe(0);

    const remainingSlugs = await tenantA.tenantDb
      .prepare(`SELECT COUNT(*) AS cnt FROM resource_slugs WHERE namespace = 'blog' AND resource_id = ?`)
      .bind(post1.id)
      .first<{ cnt: number }>();
    expect(remainingSlugs?.cnt).toBe(0);

    const sharedMediaStillExists = await tenantA.tenantDb
      .prepare(`SELECT id, status FROM media_items WHERE id = 201`)
      .first<{ id: number; status: string }>();
    expect(sharedMediaStillExists?.id).toBe(201);
    expect(sharedMediaStillExists?.status).toBe("ready");

    // Protected references test: homepage page + policy setting + navigation menu reference MUST block permanent purge with 409!
    const homeCreateRes = await handleTenantPagesCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages`, "POST", {
        cookie: tenantA.owner.cookie,
        body: { title: "Beranda & Privasi", slug: "beranda-privasi", isHomepage: true },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4_000 },
    );
    expect(homeCreateRes.status).toBe(201);
    const homePage = (await homeCreateRes.json()) as { id: number; version: number };

    // Link page in site_settings privacyPageId AND header menu
    await tenantA.tenantDb
      .prepare(
        `INSERT OR REPLACE INTO site_settings (id, site_title, published_json, version, updated_at)
         VALUES (1, 'Bisnis 02', ?, 1, ?)`,
      )
      .bind(JSON.stringify({ privacyPageId: homePage.id }), BASE_NOW_MS + 4_100)
      .run();
    await tenantA.tenantDb
      .prepare(
        `INSERT OR REPLACE INTO menus (id, location, items_json, published_items_json, version, created_at, updated_at)
         VALUES (1, 'header', ?, ?, 1, ?, ?)`,
      )
      .bind(
        JSON.stringify([{ id: "m1", label: "Privasi", targetType: "page", targetResourceId: homePage.id }]),
        JSON.stringify([{ id: "m1", label: "Privasi", targetType: "page", targetResourceId: homePage.id }]),
        BASE_NOW_MS + 4_100,
        BASE_NOW_MS + 4_100,
      )
      .run();

    const homeTrashRes = await handleTenantPageTrashRequest(
      tenantA.handle,
      String(homePage.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${homePage.id}/trash`, "POST", {
        cookie: tenantA.owner.cookie,
        body: { version: homePage.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4_200 },
    );
    expect(homeTrashRes.status).toBe(200);
    const trashedHome = (await homeTrashRes.json()) as { version: number };

    const blockedPurgeRes = await handleTenantPagePurgeRequest(
      tenantA.handle,
      String(homePage.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${homePage.id}/purge`, "POST", {
        cookie: tenantA.owner.cookie,
        body: { expectedVersion: trashedHome.version, confirmPermanentDelete: true },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4_500 },
    );
    expect(blockedPurgeRes.status).toBe(409);
    const blockedBody = (await blockedPurgeRes.json()) as {
      error: {
        code: string;
        fields?: { code: string }[];
        protectedReferences?: { kind: string }[];
      };
    };
    expect(blockedBody.error.code).toBe("CONFLICT");
    expect(blockedBody.error.fields?.[0]?.code).toBe("PROTECTED_REFERENCE");
    const kinds = (blockedBody.error.protectedReferences ?? []).map((r) => r.kind);
    expect(kinds).toContain("homepage");
    expect(kinds).toContain("policy_setting");
    expect(kinds).toContain("navigation_menu");

    // Locked tenant: CAN read trash list (`200`), CANNOT restore or purge (`403 SUBSCRIPTION_LOCKED`)
    const platformDrizzle = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await platformDrizzle
      .update(tenants)
      .set({ status: "locked", updatedAt: new Date(BASE_NOW_MS + 5_000) })
      .where(eq(tenants.id, tenantA.tenantId));

    const lockedListRes = await handleTenantPagesTrashListRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/trash`, "GET", {
        cookie: tenantA.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5_100 },
    );
    expect(lockedListRes.status).toBe(200);

    const lockedPurgeRes = await handleTenantPagePurgeRequest(
      tenantA.handle,
      String(homePage.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/pages/${homePage.id}/purge`, "POST", {
        cookie: tenantA.owner.cookie,
        body: { expectedVersion: trashedHome.version, confirmPermanentDelete: true },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5_200 },
    );
    expect(lockedPurgeRes.status).toBe(403);
    expect(((await lockedPurgeRes.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );
  }, 25_000);

  it("executes 30-day scheduled purge worker: purges expired joins/slugs/revisions, preserves shared media & fresh trash, and reports protected-reference failures", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const tenant = await seedTenantWithUsers("04", runtimeEnv);
    const expiredAt = BASE_NOW_MS - TRASH_RETENTION_MS - 3_600_000; // 30d + 1h ago
    const recentAt = BASE_NOW_MS - 5 * 86_400_000; // 5 days ago (must NOT be purged!)

    await insertReadyMedia(tenant.tenantDb, 301, tenant.tenantId);

    // Create offering category & two offerings:
    // - offExpired: trashed > 30 days ago, has taxonomy join, revision, resource_slug, and shared media #301 -> MUST be purged!
    // - offBlocked: trashed > 30 days ago, linked in active footer menu -> MUST be skipped & reported as protected-reference failure!
    // - pageRecent: trashed 5 days ago -> MUST remain intact!
    await tenant.tenantDb
      .prepare(
        `INSERT INTO taxonomies (id, taxonomy_type, offering_type, depth, slug, name, sort_order, version, created_at, updated_at)
         VALUES (30, 'offering_category', 'product', 0, 'elektronik', 'Elektronik', 0, 1, ?, ?)`,
      )
      .bind(expiredAt, expiredAt)
      .run();

    const offExpRes = await handleTenantCatalogCollectionRequest(
      tenant.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/catalog`, "POST", {
        cookie: tenant.owner.cookie,
        body: {
          offeringType: "product",
          title: "Produk Kedaluwarsa",
          slug: "produk-kedaluwarsa",
          priceMode: "fixed",
          price: 150000,
          ctaMode: "inquiry",
          coverMediaId: 301,
          categoryIds: [30],
        },
      }),
      runtimeEnv,
      { nowMs: expiredAt - 10_000 },
    );
    expect(offExpRes.status).toBe(201);
    const offExp = (await offExpRes.json()) as { id: number; version: number };

    // Add a content_revisions row for TASK-064 readiness verification
    await tenant.tenantDb
      .prepare(
        `INSERT INTO content_revisions (resource_type, resource_id, revision_number, snapshot_json, created_by, created_at)
         VALUES ('offering', ?, 1, '{"title":"Produk Kedaluwarsa"}', ?, ?)`,
      )
      .bind(offExp.id, tenant.owner.userId, expiredAt - 5_000)
      .run();

    // Trash via DELETE endpoint at expiredAt
    const delExpRes = await handleTenantCatalogOfferingRequest(
      tenant.handle,
      String(offExp.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/catalog/${offExp.id}`, "DELETE", {
        cookie: tenant.owner.cookie,
        body: { expectedVersion: offExp.version },
      }),
      runtimeEnv,
      { nowMs: expiredAt },
    );
    expect(delExpRes.status).toBe(204);

    // Offering #2: expired, but protected by active footer menu!
    const offBlockedRes = await handleTenantCatalogCollectionRequest(
      tenant.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/catalog`, "POST", {
        cookie: tenant.owner.cookie,
        body: {
          offeringType: "product",
          title: "Produk Terlindung Menu",
          slug: "produk-terlindung-menu",
          priceMode: "on_request",
          ctaMode: "inquiry",
        },
      }),
      runtimeEnv,
      { nowMs: expiredAt - 10_000 },
    );
    expect(offBlockedRes.status).toBe(201);
    const offBlocked = (await offBlockedRes.json()) as { id: number; version: number };

    await handleTenantCatalogTrashRequest(
      tenant.handle,
      String(offBlocked.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/catalog/${offBlocked.id}/trash`, "POST", {
        cookie: tenant.owner.cookie,
        body: { expectedVersion: offBlocked.version },
      }),
      runtimeEnv,
      { nowMs: expiredAt },
    );

    await tenant.tenantDb
      .prepare(
        `INSERT OR REPLACE INTO menus (id, location, items_json, published_items_json, version, created_at, updated_at)
         VALUES (2, 'footer', ?, ?, 1, ?, ?)`,
      )
      .bind(
        JSON.stringify([{ id: "f1", label: "Produk Unggulan", targetType: "offering", targetResourceId: offBlocked.id }]),
        JSON.stringify([{ id: "f1", label: "Produk Unggulan", targetType: "offering", targetResourceId: offBlocked.id }]),
        expiredAt,
        expiredAt,
      )
      .run();

    // Recent trashed page (5 days old -> MUST survive sweep)
    const pageRecentRes = await handleTenantPagesCollectionRequest(
      tenant.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages`, "POST", {
        cookie: tenant.owner.cookie,
        body: { title: "Halaman Baru Dihapus", slug: "halaman-baru-dihapus" },
      }),
      runtimeEnv,
      { nowMs: recentAt - 1_000 },
    );
    const pageRecent = (await pageRecentRes.json()) as { id: number; version: number };
    await handleTenantPageTrashRequest(
      tenant.handle,
      String(pageRecent.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages/${pageRecent.id}/trash`, "POST", {
        cookie: tenant.owner.cookie,
        body: { version: pageRecent.version },
      }),
      runtimeEnv,
      { nowMs: recentAt },
    );

    // Run durable queue worker via processDurableQueueBatch
    const blockedEvents: ProtectedReferencePurgeFailure[] = [];
    const summaries: ContentPurgeQueueSummary[] = [];
    const logs: Record<string, unknown>[] = [];

    const registry = createContentPurgeJobRegistry({
      logger: (entry) => logs.push(entry),
      onProtectedReferenceBlocked: (failure) => {
        blockedEvents.push(failure);
      },
      onSweepCompleted: (summary) => {
        summaries.push(summary);
      },
    });

    const acked: string[] = [];
    const retried: string[] = [];
    const batch = {
      queue: "punyasitus-jobs",
      messages: [
        {
          id: "msg-purge-01",
          timestamp: new Date(BASE_NOW_MS),
          attempts: 1,
          body: {
            idempotencyKey: `purge:t044:${tenant.tenantId}:01`,
            topic: CONTENT_PURGE_SWEEP_TOPIC,
            tenantId: tenant.tenantId,
            payload: { nowMs: BASE_NOW_MS },
            enqueuedAt: BASE_NOW_MS,
          },
          ack: () => acked.push("msg-purge-01"),
          retry: () => retried.push("msg-purge-01"),
        },
      ],
    } as unknown as MessageBatch<unknown>;

    const batchResult = await processDurableQueueBatch(
      batch,
      { PLATFORM_DB: env.PLATFORM_DB, TENANT_STORE: env.TENANT_STORE },
      registry,
      { now: () => BASE_NOW_MS, logger: () => undefined },
    );

    expect(batchResult.completed).toBe(1);
    expect(acked).toEqual(["msg-purge-01"]);
    expect(retried).toEqual([]);

    expect(summaries.length).toBe(1);
    expect(summaries[0]?.purgedCount).toBe(1);
    expect(summaries[0]?.blockedCount).toBe(1);
    expect(blockedEvents.length).toBe(1);
    expect(blockedEvents[0]?.resourceType).toBe("offering");
    expect(blockedEvents[0]?.resourceId).toBe(offBlocked.id);
    expect(blockedEvents[0]?.protectedReferences[0]?.kind).toBe("navigation_menu");

    // Verify expired offering + joins + slugs + revisions purged, while shared media #301 preserved!
    expect(
      await tenant.tenantDb.prepare(`SELECT id FROM offerings WHERE id = ?`).bind(offExp.id).first(),
    ).toBeNull();
    expect(
      (
        await tenant.tenantDb
          .prepare(`SELECT COUNT(*) AS cnt FROM offering_taxonomies WHERE offering_id = ?`)
          .bind(offExp.id)
          .first<{ cnt: number }>()
      )?.cnt,
    ).toBe(0);
    expect(
      (
        await tenant.tenantDb
          .prepare(`SELECT COUNT(*) AS cnt FROM content_revisions WHERE resource_type = 'offering' AND resource_id = ?`)
          .bind(offExp.id)
          .first<{ cnt: number }>()
      )?.cnt,
    ).toBe(0);
    expect(
      await tenant.tenantDb.prepare(`SELECT id FROM media_items WHERE id = 301`).first<{ id: number }>(),
    ).toEqual({ id: 301 });

    // Verify protected offering & recent trashed page survived
    expect(
      await tenant.tenantDb.prepare(`SELECT id FROM offerings WHERE id = ?`).bind(offBlocked.id).first(),
    ).not.toBeNull();
    expect(
      await tenant.tenantDb.prepare(`SELECT id FROM pages WHERE id = ?`).bind(pageRecent.id).first(),
    ).not.toBeNull();

    // Operator-visible audit entry recorded for blocked item
    const blockedAudit = await tenant.tenantDb
      .prepare(
        `SELECT action, resource_id FROM tenant_activity_log
         WHERE action = 'content.purge_blocked_protected_ref' AND resource_id = ?`,
      )
      .bind(String(offBlocked.id))
      .first<{ action: string; resource_id: string }>();
    expect(blockedAudit?.action).toBe("content.purge_blocked_protected_ref");

    // Redelivery deduplicates via job_ledger without re-running
    const replayResult = await processDurableQueueBatch(
      batch,
      { PLATFORM_DB: env.PLATFORM_DB, TENANT_STORE: env.TENANT_STORE },
      registry,
      { now: () => BASE_NOW_MS + 1_000, logger: () => undefined },
    );
    expect(replayResult.deduplicated).toBe(1);
    expect(summaries.length).toBe(1);

    // Polish #5: Running sweep again on the SAME UTC day must NOT duplicate `content.purge_blocked_protected_ref` audit rows
    const secondSweep = await sweepExpiredTrashedContent(tenant.tenantDb, {
      tenantId: tenant.tenantId,
      nowMs: BASE_NOW_MS + 60_000,
    });
    expect(secondSweep.blockedCount).toBe(1);
    const blockedAuditCount = await tenant.tenantDb
      .prepare(
        `SELECT COUNT(*) AS cnt FROM tenant_activity_log
         WHERE action = 'content.purge_blocked_protected_ref' AND resource_id = ?`,
      )
      .bind(String(offBlocked.id))
      .first<{ cnt: number }>();
    expect(blockedAuditCount?.cnt).toBe(1);
  }, 25_000);

  it("enforces atomic in-SQL protected-reference purge race guard, atomic in-SQL slug-claim restore race guard, trashed ex-homepage replacement purge, and excludes purging/recovery tenants from sweep", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const tenant = await seedTenantWithUsers("05", runtimeEnv);

    // 1. Atomic protected-reference race guard inside purgeContentItem batch():
    //    Inject a menu reference RIGHT BEFORE batch() commits (after pre-check passed!) -> MUST reject 409 PROTECTED_REFERENCE with zero deletion!
    const racePageRes = await handleTenantPagesCollectionRequest(
      tenant.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages`, "POST", {
        cookie: tenant.owner.cookie,
        body: { title: "Halaman Race Purge", slug: "halaman-race-purge" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(racePageRes.status).toBe(201);
    const racePage = (await racePageRes.json()) as { id: number; version: number };

    // Add a revision row to prove joins/revisions/slugs are NOT deleted when atomic guard blocks
    await tenant.tenantDb
      .prepare(
        `INSERT INTO content_revisions (resource_type, resource_id, revision_number, snapshot_json, created_by, created_at)
         VALUES ('page', ?, 1, '{"title":"Halaman Race Purge"}', ?, ?)`,
      )
      .bind(racePage.id, tenant.owner.userId, BASE_NOW_MS)
      .run();

    const raceTrashRes = await handleTenantPageTrashRequest(
      tenant.handle,
      String(racePage.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages/${racePage.id}/trash`, "POST", {
        cookie: tenant.owner.cookie,
        body: { version: racePage.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(raceTrashRes.status).toBe(200);
    const trashedRacePage = (await raceTrashRes.json()) as { version: number };

    let injectedMenuOnce = false;
    const racingPurgeDb = new Proxy(tenant.tenantDb, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!injectedMenuOnce) {
              injectedMenuOnce = true;
              // Simulate a concurrent menu save referencing this page landing between pre-check and batch()
              await target
                .prepare(
                  `INSERT OR REPLACE INTO menus (id, location, items_json, draft_items_json, version, created_at, updated_at)
                   VALUES (1, 'header', ?, ?, 1, ?, ?)`,
                )
                .bind(
                  JSON.stringify([{ id: "m-race", label: "Race Link", targetType: "page", targetResourceId: racePage.id }]),
                  JSON.stringify([{ id: "m-race", label: "Race Link", targetType: "page", targetResourceId: racePage.id }]),
                  BASE_NOW_MS + 1_500,
                  BASE_NOW_MS + 1_500,
                )
                .run();
            }
            return target.batch(stmts);
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });

    await expect(
      purgeContentItem(racingPurgeDb, {
        resourceType: "page",
        resourceId: racePage.id,
        expectedVersion: trashedRacePage.version,
        actorUserId: tenant.owner.userId,
        actorRole: "owner",
        nowMs: BASE_NOW_MS + 2_000,
      }),
    ).rejects.toBeInstanceOf(TrashProtectedReferenceError);

    // Item, resource_slugs, and content_revisions MUST ALL remain 100% intact!
    expect(
      await tenant.tenantDb.prepare(`SELECT id FROM pages WHERE id = ?`).bind(racePage.id).first(),
    ).not.toBeNull();
    expect(
      (
        await tenant.tenantDb
          .prepare(`SELECT COUNT(*) AS cnt FROM content_revisions WHERE resource_type = 'page' AND resource_id = ?`)
          .bind(racePage.id)
          .first<{ cnt: number }>()
      )?.cnt,
    ).toBe(1);
    expect(
      (
        await tenant.tenantDb
          .prepare(`SELECT COUNT(*) AS cnt FROM resource_slugs WHERE namespace = 'pages' AND resource_id = ?`)
          .bind(racePage.id)
          .first<{ cnt: number }>()
      )?.cnt,
    ).toBeGreaterThanOrEqual(1);

    // Clear the menu reference for clean subsequent tests
    await tenant.tenantDb.prepare(`DELETE FROM menus WHERE id = 1`).run();

    // 2. Atomic slug-occupancy race guard inside restoreContentItem batch():
    //    Another resource claims the target slug in `resource_slugs` right BEFORE batch() commits -> MUST reject 409 SLUG_CONFLICT with zero partial writes!
    const raceRestorePageRes = await handleTenantPagesCollectionRequest(
      tenant.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages`, "POST", {
        cookie: tenant.owner.cookie,
        body: { title: "Halaman Race Restore", slug: "slug-balapan" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_100 },
    );
    expect(raceRestorePageRes.status).toBe(201);
    const raceRestorePage = (await raceRestorePageRes.json()) as { id: number; version: number };

    const raceRestoreTrashRes = await handleTenantPageTrashRequest(
      tenant.handle,
      String(raceRestorePage.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages/${raceRestorePage.id}/trash`, "POST", {
        cookie: tenant.owner.cookie,
        body: { version: raceRestorePage.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_200 },
    );
    const trashedRaceRestore = (await raceRestoreTrashRes.json()) as { version: number };

    // Remove the trashed page's own slug row so a competing resource can claim `slug-balapan` mid-race
    await tenant.tenantDb
      .prepare(`DELETE FROM resource_slugs WHERE namespace = 'pages' AND slug = 'slug-balapan'`)
      .run();

    let injectedSlugOnce = false;
    const racingRestoreDb = new Proxy(tenant.tenantDb, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!injectedSlugOnce) {
              injectedSlugOnce = true;
              // Simulate competing resource #999 claiming `slug-balapan` right before restore batch() runs
              await target
                .prepare(
                  `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
                   VALUES ('pages', 'slug-balapan', 999, 1, NULL, ?)`,
                )
                .bind(BASE_NOW_MS + 2_300)
                .run();
            }
            return target.batch(stmts);
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });

    let caughtSlugRace: unknown = null;
    try {
      await restoreContentItem(racingRestoreDb, {
        resourceType: "page",
        resourceId: raceRestorePage.id,
        expectedVersion: trashedRaceRestore.version,
        actorUserId: tenant.owner.userId,
        actorRole: "owner",
        nowMs: BASE_NOW_MS + 2_400,
      });
    } catch (err) {
      caughtSlugRace = err;
    }
    expect(caughtSlugRace).toBeInstanceOf(TrashConflictError);
    expect((caughtSlugRace as TrashConflictError).fieldCode).toBe("SLUG_CONFLICT");
    expect((caughtSlugRace as TrashConflictError).suggestedSlug).toBe("slug-balapan-2");

    // Verify ZERO partial restore: page still trashed, NO restore audit row, resource_slugs still owned by #999!
    const stillTrashedAfterRace = await tenant.tenantDb
      .prepare(`SELECT status, deleted_at, version FROM pages WHERE id = ?`)
      .bind(raceRestorePage.id)
      .first<{ status: string; deleted_at: number | null; version: number }>();
    expect(stillTrashedAfterRace?.status).toBe("trashed");
    expect(stillTrashedAfterRace?.deleted_at).not.toBeNull();
    expect(stillTrashedAfterRace?.version).toBe(trashedRaceRestore.version);

    const slugOwner = await tenant.tenantDb
      .prepare(`SELECT resource_id FROM resource_slugs WHERE namespace = 'pages' AND slug = 'slug-balapan'`)
      .first<{ resource_id: number }>();
    expect(slugOwner?.resource_id).toBe(999);

    const bogusRestoreAudit = await tenant.tenantDb
      .prepare(`SELECT COUNT(*) AS cnt FROM tenant_activity_log WHERE action = 'content.restored' AND resource_id = ?`)
      .bind(String(raceRestorePage.id))
      .first<{ cnt: number }>();
    expect(bogusRestoreAudit?.cnt).toBe(0);

    // 3. Ex-homepage deadlock fix:
    //    Sole trashed homepage is blocked (409 PROTECTED_REFERENCE), then setting a replacement active homepage UNBLOCKS permanent purge!
    const oldHomeRes = await handleTenantPagesCollectionRequest(
      tenant.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages`, "POST", {
        cookie: tenant.owner.cookie,
        body: { title: "Beranda Lama", slug: "beranda-lama", isHomepage: true },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_000 },
    );
    expect(oldHomeRes.status).toBe(201);
    const oldHome = (await oldHomeRes.json()) as { id: number; version: number };

    const oldHomeTrashRes = await handleTenantPageTrashRequest(
      tenant.handle,
      String(oldHome.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages/${oldHome.id}/trash`, "POST", {
        cookie: tenant.owner.cookie,
        body: { version: oldHome.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_100 },
    );
    const trashedOldHome = (await oldHomeTrashRes.json()) as { version: number };

    // Blocked while sole homepage
    const blockedSoleHomeRes = await handleTenantPagePurgeRequest(
      tenant.handle,
      String(oldHome.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages/${oldHome.id}/purge`, "POST", {
        cookie: tenant.owner.cookie,
        body: { expectedVersion: trashedOldHome.version, confirmPermanentDelete: true },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_200 },
    );
    expect(blockedSoleHomeRes.status).toBe(409);

    // Now create a replacement active homepage -> old trashed ex-homepage MUST purge cleanly!
    const newHomeRes = await handleTenantPagesCollectionRequest(
      tenant.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages`, "POST", {
        cookie: tenant.owner.cookie,
        body: { title: "Beranda Baru", slug: "beranda-baru", isHomepage: true },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_300 },
    );
    expect(newHomeRes.status).toBe(201);

    const unblockedPurgeRes = await handleTenantPagePurgeRequest(
      tenant.handle,
      String(oldHome.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/pages/${oldHome.id}/purge`, "POST", {
        cookie: tenant.owner.cookie,
        body: { expectedVersion: trashedOldHome.version, confirmPermanentDelete: true },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_400 },
    );
    expect(unblockedPurgeRes.status).toBe(200);
    expect(((await unblockedPurgeRes.json()) as { purged: boolean }).purged).toBe(true);

    // 4. Polish #6: Verify `recovery` and `purging` tenants are excluded from all-tenant queue sweep!
    const recoveryTenant = await seedTenantWithUsers("06", runtimeEnv);
    const purgingTenant = await seedTenantWithUsers("07", runtimeEnv);
    const platformDrizzle = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await platformDrizzle
      .update(tenants)
      .set({ status: "recovery", updatedAt: new Date(BASE_NOW_MS + 4_000) })
      .where(eq(tenants.id, recoveryTenant.tenantId));
    await platformDrizzle
      .update(tenants)
      .set({ status: "purging", updatedAt: new Date(BASE_NOW_MS + 4_000) })
      .where(eq(tenants.id, purgingTenant.tenantId));

    const sweepSummaries: ContentPurgeQueueSummary[] = [];
    const allTenantRegistry = createContentPurgeJobRegistry({
      logger: () => undefined,
      onSweepCompleted: (s) => {
        sweepSummaries.push(s);
      },
    });
    const allBatch = {
      queue: "punyasitus-jobs",
      messages: [
        {
          id: "msg-purge-all-tenants",
          timestamp: new Date(BASE_NOW_MS + 4_100),
          attempts: 1,
          body: {
            idempotencyKey: "purge:t044:all-tenants:01",
            topic: CONTENT_PURGE_SWEEP_TOPIC,
            tenantId: null,
            payload: { nowMs: BASE_NOW_MS + 4_100 },
            enqueuedAt: BASE_NOW_MS + 4_100,
          },
          ack: () => undefined,
          retry: () => undefined,
        },
      ],
    } as unknown as MessageBatch<unknown>;

    await processDurableQueueBatch(
      allBatch,
      { PLATFORM_DB: env.PLATFORM_DB, TENANT_STORE: env.TENANT_STORE },
      allTenantRegistry,
      { now: () => BASE_NOW_MS + 4_100, logger: () => undefined },
    );

    expect(sweepSummaries.length).toBe(1);
    const sweptIds = new Set((sweepSummaries[0]?.tenantResults ?? []).map((r) => r.tenantId));
    expect(sweptIds.has(tenant.tenantId)).toBe(true);
    expect(sweptIds.has(recoveryTenant.tenantId)).toBe(false);
    expect(sweptIds.has(purgingTenant.tenantId)).toBe(false);
  }, 25_000);
});

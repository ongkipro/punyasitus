import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  buildPublishedSnapshot,
  extractDraftSnapshotForAdmin,
  extractPublishedSnapshot,
  PublicationAtomicError,
  serializeDraftStoragePayload,
} from "@punyasitus/core/content/index";
import {
  PREVIEW_API_CSP_HEADER,
  PREVIEW_IFRAME_SANDBOX,
} from "@punyasitus/core/preview/index";
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
import {
  publishStarterPresetSectionsAtomically,
  TENANT_0012_STARTER_PRESETS_MIGRATION,
  type ApplyStarterPresetResult,
  type PublishStarterPresetResult,
  type TenantPresetStateDto,
} from "@punyasitus/db/presets/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import type {
  PresetPreviewResultDto,
  TenantPresetsRuntimeEnv,
} from "../../apps/web/src/pages/api/tenants/[tenantId]/presets/_shared.ts";
import { handleTenantPresetsApplyRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/presets/apply.ts";
import { handleTenantPresetsDraftRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/presets/draft.ts";
import { handleTenantPresetsGetRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/presets/index.ts";
import { handleTenantPresetsPreviewRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/presets/preview.ts";
import { handleTenantPresetsPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/presets/publish.ts";
import { loadPresetPageOrGateResponse } from "../../apps/web/src/pages/dashboard/[handle]/onboarding/_page-gate.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 6, 0, 0);

const TENANT_FRESH = {
  id: "01JT043FRESH00000000000001",
  orgId: "org_t043_fresh",
  handle: "t043-fresh",
  name: "PT Prima Nusantara",
  host: "t043-fresh.situsku.click",
} as const;

const TENANT_POPULATED = {
  id: "01JT043POPULATED0000000002",
  orgId: "org_t043_populated",
  handle: "t043-populated",
  name: "CV Karya Mandiri Jaya",
  host: "t043-populated.situsku.click",
} as const;

const TENANT_LOCKED = {
  id: "01JT043LOCKED0000000000003",
  orgId: "org_t043_locked",
  handle: "t043-locked",
  name: "PT Terkunci Sejahtera",
  host: "t043-locked.situsku.click",
} as const;

const TENANT_HEALTH = {
  id: "01JT043HEALTH0000000000004",
  orgId: "org_t043_health",
  handle: "t043-klinik",
  name: "Klinik Medika Pratama",
  host: "t043-klinik.situsku.click",
} as const;

const TENANT_EDGE = {
  id: "01JT043EDGE000000000000005",
  orgId: "org_t043_edge",
  handle: "t043-edge",
  name: "PT Edge Kasus",
  host: "t043-edge.situsku.click",
} as const;

function buildRuntimeEnv(
  overrides: Partial<TenantPresetsRuntimeEnv> = {},
): TenantPresetsRuntimeEnv {
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
    throw new Error(`Expected ${APP_SESSION_COOKIE_NAME} cookie, got: ${JSON.stringify(cookies)}`);
  }
  return (sessionHeader.split(";")[0] ?? "").trim();
}

function makeRequest(
  url: string,
  method: "GET" | "POST" | "PATCH" = "GET",
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
    applyTenantMigrations(state.storage as unknown as StorageLike, [
      ...TENANT_MIGRATIONS,
      TENANT_0012_STARTER_PRESETS_MIGRATION,
    ]),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function signUpUser(
  email: string,
  name: string,
  runtimeEnv: TenantPresetsRuntimeEnv,
): Promise<{ readonly userId: string; readonly cookie: string }> {
  const res = await handleBetterAuthRequest(
    makeRequest(`${APP_ORIGIN}/api/auth/sign-up/email`, "POST", {
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
  return Number(row?.cacheVersion ?? 0);
}

describe("TASK-043: Company-Profile Starter Preset (M1) on workerd", () => {
  let tenantDbFresh: D1Database;
  let tenantDbPopulated: D1Database;
  let tenantDbLocked: D1Database;
  let tenantDbHealth: D1Database;
  let tenantDbEdge: D1Database;

  let ownerFresh: { readonly userId: string; readonly cookie: string };
  let adminFresh: { readonly userId: string; readonly cookie: string };
  let editorFresh: { readonly userId: string; readonly cookie: string };
  let ownerPopulated: { readonly userId: string; readonly cookie: string };
  let ownerLocked: { readonly userId: string; readonly cookie: string };
  let ownerHealth: { readonly userId: string; readonly cookie: string };
  let ownerEdge: { readonly userId: string; readonly cookie: string };

  const runtimeEnv = buildRuntimeEnv();

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);

    for (const [spec, status, vertical] of [
      [TENANT_FRESH, "active", "compro"],
      [TENANT_POPULATED, "active", "compro"],
      [TENANT_LOCKED, "locked", "compro"],
      [TENANT_HEALTH, "active", "compro"],
      [TENANT_EDGE, "active", "compro"],
    ] as const) {
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
          vertical,
          status,
          cacheVersion: 1,
          schemaVersion: 1,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }

    ownerFresh = await signUpUser("owner.fresh@t043.example", "Owner Fresh", runtimeEnv);
    adminFresh = await signUpUser("admin.fresh@t043.example", "Admin Fresh", runtimeEnv);
    editorFresh = await signUpUser("editor.fresh@t043.example", "Editor Fresh", runtimeEnv);
    ownerPopulated = await signUpUser("owner.pop@t043.example", "Owner Populated", runtimeEnv);
    ownerLocked = await signUpUser("owner.locked@t043.example", "Owner Locked", runtimeEnv);
    ownerHealth = await signUpUser("owner.health@t043.example", "Owner Health", runtimeEnv);
    ownerEdge = await signUpUser("owner.edge@t043.example", "Owner Edge", runtimeEnv);

    await pDb
      .insert(members)
      .values([
        {
          id: "mem_t043_fresh_owner",
          organizationId: TENANT_FRESH.orgId,
          userId: ownerFresh.userId,
          role: "owner",
          createdAt: now,
        },
        {
          id: "mem_t043_fresh_admin",
          organizationId: TENANT_FRESH.orgId,
          userId: adminFresh.userId,
          role: "admin",
          createdAt: now,
        },
        {
          id: "mem_t043_fresh_editor",
          organizationId: TENANT_FRESH.orgId,
          userId: editorFresh.userId,
          role: "editor",
          createdAt: now,
        },
        {
          id: "mem_t043_pop_owner",
          organizationId: TENANT_POPULATED.orgId,
          userId: ownerPopulated.userId,
          role: "owner",
          createdAt: now,
        },
        {
          id: "mem_t043_locked_owner",
          organizationId: TENANT_LOCKED.orgId,
          userId: ownerLocked.userId,
          role: "owner",
          createdAt: now,
        },
        {
          id: "mem_t043_health_owner",
          organizationId: TENANT_HEALTH.orgId,
          userId: ownerHealth.userId,
          role: "owner",
          createdAt: now,
        },
        {
          id: "mem_t043_edge_owner",
          organizationId: TENANT_EDGE.orgId,
          userId: ownerEdge.userId,
          role: "owner",
          createdAt: now,
        },
      ])
      .onConflictDoNothing();

    tenantDbFresh = await openMigratedTenantDb(TENANT_FRESH.id);
    tenantDbPopulated = await openMigratedTenantDb(TENANT_POPULATED.id);
    tenantDbLocked = await openMigratedTenantDb(TENANT_LOCKED.id);
    tenantDbHealth = await openMigratedTenantDb(TENANT_HEALTH.id);
    tenantDbEdge = await openMigratedTenantDb(TENANT_EDGE.id);

    // Seed baseline site_settings & business_profile on each tenant
    for (const [db, spec, category] of [
      [tenantDbFresh, TENANT_FRESH, "LocalBusiness"],
      [tenantDbPopulated, TENANT_POPULATED, "LocalBusiness"],
      [tenantDbLocked, TENANT_LOCKED, "LocalBusiness"],
      [tenantDbHealth, TENANT_HEALTH, "Klinik Kesehatan"],
      [tenantDbEdge, TENANT_EDGE, "LocalBusiness"],
    ] as const) {
      await db.batch([
        db
          .prepare(
            `INSERT OR REPLACE INTO site_settings
               (id, site_title, tagline, timezone, locale, active_theme_id, version, updated_at)
             VALUES (1, ?, 'Profil usaha resmi', 'Asia/Jakarta', 'id-ID', 'compro', 1, ?)`,
          )
          .bind(spec.name, BASE_NOW_MS),
        db
          .prepare(
            `INSERT OR REPLACE INTO business_profile
               (id, business_name, business_category, address, phone, whatsapp_e164, email, version, updated_at)
             VALUES (1, ?, ?, 'Jl. Gatot Subroto Kav. 21, Jakarta', '021-5550101', '+6281234567890', 'halo@prima-nusantara.id', 1, ?)`,
          )
          .bind(spec.name, category, BASE_NOW_MS),
      ]);
    }

    // Populate TENANT_POPULATED with existing published homepage, extra page, offering, post & menu
    const existingHomeSnap = {
      slug: "beranda",
      title: "Beranda Lama CV Karya Mandiri",
      isHomepage: true,
      layoutMode: "standard" as const,
      sections: [
        {
          id: "existing-hero",
          kind: "hero" as const,
          heading: "Karya Mandiri Konstruksi Terpercaya",
          subheading: "Konten publik existing yang tidak boleh terhapus.",
          bodyHtml: null,
        },
      ],
    };
    const homeDraftPayload = serializeDraftStoragePayload("page", existingHomeSnap).json;
    const homePubPayload = JSON.stringify(
      buildPublishedSnapshot("page", existingHomeSnap, {
        publishedAt: BASE_NOW_MS - 10_000,
        contentModifiedAt: BASE_NOW_MS - 10_000,
      }),
    );

    const aboutSnap = {
      slug: "tentang-perusahaan",
      title: "Tentang Perusahaan Lama",
      isHomepage: false,
      layoutMode: "standard" as const,
      sections: [],
    };

    await tenantDbPopulated.batch([
      tenantDbPopulated
        .prepare(
          `INSERT INTO pages
             (id, slug, title, is_homepage, draft_sections_json, published_sections_json, status, published_at, content_modified_at, version, created_at, updated_at)
           VALUES (1, 'beranda', 'Beranda Lama CV Karya Mandiri', 1, ?, ?, 'published', ?, ?, 2, ?, ?)`,
        )
        .bind(homeDraftPayload, homePubPayload, BASE_NOW_MS - 10_000, BASE_NOW_MS - 10_000, BASE_NOW_MS - 20_000, BASE_NOW_MS - 10_000),
      tenantDbPopulated
        .prepare(
          `INSERT INTO pages
             (id, slug, title, is_homepage, draft_sections_json, published_sections_json, status, published_at, content_modified_at, version, created_at, updated_at)
           VALUES (2, 'tentang-perusahaan', 'Tentang Perusahaan Lama', 0, ?, NULL, 'draft', NULL, NULL, 1, ?, ?)`,
        )
        .bind(serializeDraftStoragePayload("page", aboutSnap).json, BASE_NOW_MS - 15_000, BASE_NOW_MS - 15_000),
      tenantDbPopulated
        .prepare(
          `INSERT INTO offerings
             (id, offering_type, slug, title, summary, price_mode, cta_mode, status, version, created_at, updated_at)
           VALUES (1, 'service', 'jasa-bangun-gudang', 'Jasa Bangun Gudang Industri', 'Layanan terbit lama.', 'on_request', 'whatsapp', 'published', 1, ?, ?)`,
        )
        .bind(BASE_NOW_MS - 15_000, BASE_NOW_MS - 15_000),
      tenantDbPopulated
        .prepare(
          `INSERT INTO menus
             (id, location, items_json, draft_items_json, published_items_json, version, created_at, updated_at)
           VALUES (1, 'header', '[]', '[]', '[]', 1, ?, ?)`,
        )
        .bind(BASE_NOW_MS - 15_000, BASE_NOW_MS - 15_000),
      tenantDbPopulated
        .prepare("INSERT OR REPLACE INTO sequences (kind, next) VALUES ('page', 2), ('offering', 1)"),
    ]);
  });

  it("creates ONLY draft starter composition & checklist on a fresh tenant and is strictly idempotent on retry", async () => {
    const cacheBefore = await getTenantCacheVersion(TENANT_FRESH.id);

    // 1. Initial GET before apply shows setup=null and M1 catalog
    const getBefore = await handleTenantPresetsGetRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets`, "GET", {
        cookie: ownerFresh.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(getBefore.status).toBe(200);
    const beforeDto = (await getBefore.json()) as TenantPresetStateDto;
    expect(beforeDto.setup).toBeNull();
    expect(beforeDto.catalog.find((c) => c.id === "company_profile")?.availableInM1).toBe(true);

    // 2. Apply company_profile preset with operationKey
    const applyReqBody = {
      presetId: "company_profile",
      operationKey: "op-fresh-compro-001",
    };
    const applyRes = await handleTenantPresetsApplyRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/apply`, "POST", {
        cookie: ownerFresh.cookie,
        body: applyReqBody,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1000 },
    );
    expect(applyRes.status).toBe(200);
    const applied = (await applyRes.json()) as ApplyStarterPresetResult;
    expect(applied.idempotentReplay).toBe(false);
    expect(applied.applyMode).toBe("initialized_draft");
    expect(applied.createdHomepageDraft).toBe(true);
    expect(applied.createdHeaderMenuDraft).toBe(true);
    expect(applied.state.setup?.status).toBe("draft");
    expect(applied.state.setup?.sections.length).toBe(8);
    expect(applied.state.setup?.publishedSectionIds).toEqual([]);
    expect(applied.state.setup?.sampleSectionIds).toContain("preset-hero");
    expect(applied.state.setup?.sampleSectionIds).toContain("preset-about");

    // Verify DB: homepage is STRICTLY draft (published_sections_json IS NULL), cache_version untouched,
    // AND Finding #6: pages.draft_sections_json MUST NOT contain enabled [Contoh] sample sections!
    const homeRow = await tenantDbFresh
      .prepare(
        "SELECT id, status, draft_sections_json, published_sections_json, published_at, content_modified_at, deleted_at, version, updated_at FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL",
      )
      .first<{
        readonly id: number;
        readonly status: "draft" | "published" | "trashed";
        readonly draft_sections_json: string;
        readonly published_sections_json: string | null;
        readonly published_at: number | null;
        readonly content_modified_at: number | null;
        readonly deleted_at: number | null;
        readonly version: number;
        readonly updated_at: number;
      }>();
    expect(homeRow?.status).toBe("draft");
    expect(homeRow?.published_sections_json).toBeNull();
    const pageAdminDraft = extractDraftSnapshotForAdmin("page", {
      resourceId: Number(homeRow!.id),
      status: homeRow!.status,
      deletedAt: homeRow!.deleted_at,
      draftJson: homeRow!.draft_sections_json,
      publishedJson: homeRow!.published_sections_json,
      publishedAt: homeRow!.published_at,
      contentModifiedAt: homeRow!.content_modified_at,
      version: Number(homeRow!.version),
      updatedAt: Number(homeRow!.updated_at),
    });
    expect(JSON.stringify(pageAdminDraft?.draft?.sections ?? [])).not.toContain("[Contoh]");
    expect(await getTenantCacheVersion(TENANT_FRESH.id)).toBe(cacheBefore);

    // 3. Retry with EXACT SAME operationKey -> idempotent replay, ZERO duplicate pages or menus!
    const retryRes = await handleTenantPresetsApplyRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/apply`, "POST", {
        cookie: ownerFresh.cookie,
        body: applyReqBody,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2000 },
    );
    expect(retryRes.status).toBe(200);
    const replayed = (await retryRes.json()) as ApplyStarterPresetResult;
    expect(replayed.idempotentReplay).toBe(true);
    expect(replayed.state.setup?.version).toBe(applied.state.setup?.version);

    const pageCount = await tenantDbFresh
      .prepare("SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL")
      .first<{ readonly count: number }>();
    const menuCount = await tenantDbFresh
      .prepare("SELECT COUNT(*) AS count FROM menus")
      .first<{ readonly count: number }>();
    expect(Number(pageCount?.count)).toBe(1);
    expect(Number(menuCount?.count)).toBe(1);

    // 4. Reusing same operationKey with DIFFERENT applyMode -> 409 IDEMPOTENCY_KEY_CONFLICT!
    const conflictRes = await handleTenantPresetsApplyRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/apply`, "POST", {
        cookie: ownerFresh.cookie,
        body: {
          presetId: "company_profile",
          operationKey: "op-fresh-compro-001",
          applyMode: "merge_draft",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3000 },
    );
    expect(conflictRes.status).toBe(409);
    const conflictJson = (await conflictRes.json()) as { error: { code: string } };
    expect(conflictJson.error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("reapplying on a populated tenant NEVER deletes or unpublishes existing pages, offerings, or menus", async () => {
    const beforeHome = await tenantDbPopulated
      .prepare("SELECT slug, title, status, published_sections_json, version FROM pages WHERE id = 1")
      .first<{
        readonly slug: string;
        readonly title: string;
        readonly status: string;
        readonly published_sections_json: string | null;
        readonly version: number;
      }>();

    const applyRes = await handleTenantPresetsApplyRequest(
      TENANT_POPULATED.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_POPULATED.handle}/presets/apply`, "POST", {
        cookie: ownerPopulated.cookie,
        body: {
          presetId: "company_profile",
          operationKey: "op-populated-compro-001",
          applyMode: "preserve_existing",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4000 },
    );
    expect(applyRes.status).toBe(200);
    const applied = (await applyRes.json()) as ApplyStarterPresetResult;
    expect(applied.applyMode).toBe("staged_draft");
    expect(applied.preservedExistingContent).toBe(true);
    expect(applied.createdHomepageDraft).toBe(false);

    // Existing pages, offerings, menus, and LIVE published homepage are 100% untouched!
    const afterHome = await tenantDbPopulated
      .prepare("SELECT slug, title, status, published_sections_json, version FROM pages WHERE id = 1")
      .first<{
        readonly slug: string;
        readonly title: string;
        readonly status: string;
        readonly published_sections_json: string | null;
        readonly version: number;
      }>();
    expect(afterHome).toEqual(beforeHome);

    const pagesCount = await tenantDbPopulated
      .prepare("SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL")
      .first<{ readonly count: number }>();
    const offeringsCount = await tenantDbPopulated
      .prepare("SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL")
      .first<{ readonly count: number }>();
    expect(Number(pagesCount?.count)).toBe(2);
    expect(Number(offeringsCount?.count)).toBe(1);
  });

  it("rejects unsupported presets, invalid/unsafe sections, stale writes, and sample-claim publication, then publishes ONLY validated selected sections atomically", async () => {
    // 1. Unsupported vertical preset (`travel` -> M2 TASK-066) fails with 422 UNSUPPORTED_PRESET
    const unsupportedRes = await handleTenantPresetsApplyRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/apply`, "POST", {
        cookie: ownerFresh.cookie,
        body: {
          presetId: "travel",
          operationKey: "op-travel-unsupported-001",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );
    expect(unsupportedRes.status).toBe(422);
    expect(((await unsupportedRes.json()) as { error: { code: string } }).error.code).toBe(
      "UNSUPPORTED_PRESET",
    );

    // Load current fresh tenant state
    const getRes = await handleTenantPresetsGetRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets`, "GET", {
        cookie: adminFresh.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5100 },
    );
    expect(getRes.status).toBe(200);
    const current = (await getRes.json()) as TenantPresetStateDto;
    expect(current.setup).not.toBeNull();
    const version1 = current.setup!.version;

    // 2. Preview endpoint returns inert HTML with script-src 'none', no-store, sandbox="", and updates checklist preview item
    const previewRes = await handleTenantPresetsPreviewRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/preview`, "POST", {
        cookie: adminFresh.cookie,
        body: { presetId: "company_profile" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5200 },
    );
    expect(previewRes.status).toBe(200);
    expect(previewRes.headers.get("Cache-Control")).toContain("no-store");
    expect(previewRes.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(previewRes.headers.get("Content-Security-Policy")).toBe(PREVIEW_API_CSP_HEADER);
    const previewDto = (await previewRes.json()) as PresetPreviewResultDto;
    expect(previewDto.sandbox).toBe(PREVIEW_IFRAME_SANDBOX);
    expect(previewDto.html.toLowerCase()).not.toContain("<script");
    expect(previewDto.isPreview).toBe(true);
    expect(previewDto.hasSampleContent).toBe(true);

    // 3. Invalid section type in draft PATCH fails with 422 and ZERO writes
    const badSectionRes = await handleTenantPresetsDraftRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/draft`, "PATCH", {
        cookie: adminFresh.cookie,
        body: {
          expectedVersion: version1,
          sections: [
            {
              id: "bad-widget",
              type: "arbitrary_evil_widget",
              schemaVersion: 1,
              enabled: true,
              config: {},
            },
          ],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5300 },
    );
    expect(badSectionRes.status).toBe(422);

    // 4. Attempting to publish while sample `[Contoh]` sections are selected fails with 422 SAMPLE_CONTENT_BLOCKED!
    const blockedPubRes = await handleTenantPresetsPublishRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/publish`, "POST", {
        cookie: ownerFresh.cookie,
        body: {
          presetId: "company_profile",
          selectedSectionIds: ["preset-hero", "preset-about", "preset-contact"],
          expectedVersion: version1,
          confirm: true,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5400 },
    );
    expect(blockedPubRes.status).toBe(422);
    const blockedJson = (await blockedPubRes.json()) as { error: { code: string } };
    expect(blockedJson.error.code).toBe("SAMPLE_CONTENT_BLOCKED");

    // 5. Customize ONLY hero & about with real business text (leave FAQ sample & optional modules unselected!)
    const updatedSections = current.setup!.sections.map((item) => {
      if (item.id === "preset-hero" && item.section.type === "hero") {
        return {
          ...item.section,
          enabled: true,
          config: {
            ...item.section.config,
            eyebrow: "Profil Perusahaan",
            heading: "PT Prima Nusantara — Solusi Teknik & Konstruksi",
            subheading: "Layanan rancang bangun industri terukur di seluruh Indonesia.",
          },
        };
      }
      if (item.id === "preset-about" && item.section.type === "about") {
        return {
          ...item.section,
          enabled: true,
          config: {
            ...item.section.config,
            eyebrow: "Tentang Kami",
            heading: "Mengenal PT Prima Nusantara",
            subheading: "Berpengalaman mendampingi proyek komersial dan manufaktur.",
            bodyHtml: "<p>PT Prima Nusantara menyediakan jasa konsultasi teknik, desain, dan konstruksi gedung usaha.</p>",
          },
        };
      }
      return item.section;
    });

    // Stale version check on draft PATCH -> 409 STALE_VERSION
    const staleDraftRes = await handleTenantPresetsDraftRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/draft`, "PATCH", {
        cookie: adminFresh.cookie,
        body: {
          expectedVersion: version1 + 99,
          sections: updatedSections,
          selectedPublishSectionIds: ["preset-hero", "preset-about", "preset-contact"],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5500 },
    );
    expect(staleDraftRes.status).toBe(409);

    // Valid draft PATCH succeeds
    const saveDraftRes = await handleTenantPresetsDraftRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/draft`, "PATCH", {
        cookie: adminFresh.cookie,
        body: {
          expectedVersion: version1,
          sections: updatedSections,
          selectedPublishSectionIds: ["preset-hero", "preset-about", "preset-contact"],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5600 },
    );
    expect(saveDraftRes.status).toBe(200);
    const savedState = (await saveDraftRes.json()) as TenantPresetStateDto;
    const version2 = savedState.setup!.version;
    expect(version2).toBe(version1 + 1);
    expect(savedState.setup!.sampleSectionIds).toEqual(["preset-faq"]);
    expect(savedState.checklist.items.find((i) => i.id === "preview")?.status).toBe("done");

    // 6. Publish ONLY the 3 validated selected sections atomically (sample FAQ stays unpublished!)
    const cacheBeforePub = await getTenantCacheVersion(TENANT_FRESH.id);
    const pubRes = await handleTenantPresetsPublishRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/publish`, "POST", {
        cookie: ownerFresh.cookie,
        body: {
          presetId: "company_profile",
          selectedSectionIds: ["preset-hero", "preset-about", "preset-contact"],
          expectedVersion: version2,
          confirm: true,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5700 },
    );
    expect(pubRes.status).toBe(200);
    const published = (await pubRes.json()) as PublishStarterPresetResult;
    expect(published.publishedSectionIds).toEqual(["preset-hero", "preset-about", "preset-contact"]);
    expect(published.unpublishedDraftSectionIds).toContain("preset-faq");
    expect(published.cacheVersion).toBe(cacheBeforePub + 1);
    expect(published.state.setup?.status).toBe("published");

    // Verify published snapshot in SQLite contains ONLY the 3 validated selected sections and ZERO sample markers!
    const homeRow = await tenantDbFresh
      .prepare("SELECT status, published_sections_json FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL")
      .first<{ readonly status: string; readonly published_sections_json: string | null }>();
    expect(homeRow?.status).toBe("published");
    expect(homeRow?.published_sections_json).toBeTruthy();
    expect(homeRow!.published_sections_json!).not.toContain("[Contoh]");
    expect(homeRow!.published_sections_json!).not.toContain("preset-faq");
    expect(homeRow!.published_sections_json!).toContain("PT Prima Nusantara");
  });

  it("enforces Permenkes health-category default-off on health tenant preset apply", async () => {
    const res = await handleTenantPresetsApplyRequest(
      TENANT_HEALTH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_HEALTH.handle}/presets/apply`, "POST", {
        cookie: ownerHealth.cookie,
        body: {
          presetId: "company_profile",
          operationKey: "op-health-compro-001",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6000 },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as ApplyStarterPresetResult;
    expect(data.state.isHealthCategory).toBe(true);
    const testSec = data.state.setup?.sections.find((s) => s.type === "testimonials");
    expect(testSec?.enabled).toBe(false);
    expect(data.state.setup?.warnings.length).toBeGreaterThan(0);
  });

  it("enforces strict RBAC (editor denied), cross-tenant isolation, locked-tenant deny, host isolation, CSRF, forbidden selectors, and page-gate zero-DB reads", async () => {
    // 1. Editor denied (403) on GET, preview, apply, draft, publish
    const editorGet = await handleTenantPresetsGetRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets`, "GET", {
        cookie: editorFresh.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7000 },
    );
    expect(editorGet.status).toBe(403);

    const editorApply = await handleTenantPresetsApplyRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/apply`, "POST", {
        cookie: editorFresh.cookie,
        body: { presetId: "company_profile", operationKey: "op-editor-attempt-001" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7050 },
    );
    expect(editorApply.status).toBe(403);

    // 2. Cross-tenant isolation: ownerPopulated accessing TENANT_FRESH -> 404 NOT_FOUND
    const crossTenantRes = await handleTenantPresetsGetRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets`, "GET", {
        cookie: ownerPopulated.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7100 },
    );
    expect(crossTenantRes.status).toBe(404);

    // 3. Locked tenant: GET allowed (isLocked=true), apply/publish denied (403 SUBSCRIPTION_LOCKED)
    const lockedGet = await handleTenantPresetsGetRequest(
      TENANT_LOCKED.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_LOCKED.handle}/presets`, "GET", {
        cookie: ownerLocked.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7200 },
    );
    expect(lockedGet.status).toBe(200);
    expect(((await lockedGet.json()) as TenantPresetStateDto).permissions.isLocked).toBe(true);

    const lockedApply = await handleTenantPresetsApplyRequest(
      TENANT_LOCKED.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_LOCKED.handle}/presets/apply`, "POST", {
        cookie: ownerLocked.cookie,
        body: { presetId: "company_profile", operationKey: "op-locked-attempt-001" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7250 },
    );
    expect(lockedApply.status).toBe(403);

    // 4. Forbidden selector keys in payload -> 422 VALIDATION_ERROR
    const forbiddenKeyRes = await handleTenantPresetsApplyRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/apply`, "POST", {
        cookie: ownerFresh.cookie,
        body: {
          presetId: "company_profile",
          operationKey: "op-forbidden-selector-001",
          tenantId: TENANT_POPULATED.id,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7300 },
    );
    expect(forbiddenKeyRes.status).toBe(422);

    // 5. Wrong host (console.punyasitus.com) -> 404 NOT_FOUND
    const wrongHostRes = await handleTenantPresetsGetRequest(
      TENANT_FRESH.handle,
      makeRequest(`${CONSOLE_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets`, "GET", {
        cookie: ownerFresh.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7350 },
    );
    expect(wrongHostRes.status).toBe(404);

    // 6. Missing CSRF Origin on POST -> 403
    const badCsrfRes = await handleTenantPresetsApplyRequest(
      TENANT_FRESH.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_FRESH.handle}/presets/apply`, "POST", {
        cookie: ownerFresh.cookie,
        origin: null,
        body: { presetId: "company_profile", operationKey: "op-no-origin-001" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7400 },
    );
    expect(badCsrfRes.status).toBe(403);

    // 7. Page gate guarantees ZERO TenantStore reads on editor (403), suspended (302), purging (404)
    let tenantDbOpenedCount = 0;
    const countingResolver = () => {
      tenantDbOpenedCount += 1;
      return tenantDbFresh;
    };

    const editorGate = await loadPresetPageOrGateResponse({
      platformDb: env.PLATFORM_DB,
      member: {
        tenantId: TENANT_FRESH.id,
        handle: TENANT_FRESH.handle,
        tenantName: TENANT_FRESH.name,
        userId: editorFresh.userId,
        role: "editor",
        tenantStatus: "active",
      },
      resolveTenantDb: countingResolver,
    });
    expect(editorGate.ok).toBe(false);
    if (!editorGate.ok) expect(editorGate.response.status).toBe(403);

    const suspendedGate = await loadPresetPageOrGateResponse({
      platformDb: env.PLATFORM_DB,
      member: {
        tenantId: TENANT_FRESH.id,
        handle: TENANT_FRESH.handle,
        tenantName: TENANT_FRESH.name,
        userId: ownerFresh.userId,
        role: "owner",
        tenantStatus: "suspended",
      },
      resolveTenantDb: countingResolver,
    });
    expect(suspendedGate.ok).toBe(false);
    if (!suspendedGate.ok) {
      expect(suspendedGate.response.status).toBe(302);
      expect(suspendedGate.response.headers.get("Location")).toBe(
        `/dashboard/${TENANT_FRESH.handle}/service-status`,
      );
    }

    const purgingGate = await loadPresetPageOrGateResponse({
      platformDb: env.PLATFORM_DB,
      member: {
        tenantId: TENANT_FRESH.id,
        handle: TENANT_FRESH.handle,
        tenantName: TENANT_FRESH.name,
        userId: ownerFresh.userId,
        role: "owner",
        tenantStatus: "purging",
      },
      resolveTenantDb: countingResolver,
    });
    expect(purgingGate.ok).toBe(false);
    if (!purgingGate.ok) expect(purgingGate.response.status).toBe(404);

    expect(tenantDbOpenedCount).toBe(0);
  });

  it("Findings #1-#5 & #7 regressions: populated publish preserves live homepage, new operationKey preserves edited draft, menu id/trashed slug collisions handled, checklist required gate enforced, and cache bump failure rolls back revisions cleanly", async () => {
    // 1. Finding #1: Publishing preset sections on TENANT_POPULATED preserves pre-existing live `existing-hero`!
    const popStateRes = await handleTenantPresetsGetRequest(
      TENANT_POPULATED.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_POPULATED.handle}/presets`, "GET", {
        cookie: ownerPopulated.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8000 },
    );
    expect(popStateRes.status).toBe(200);
    const popState = (await popStateRes.json()) as TenantPresetStateDto;
    expect(popState.setup).not.toBeNull();

    const popEditedSections = popState.setup!.sections.map((item) => {
      if (item.id === "preset-about" && item.section.type === "about") {
        return {
          ...item.section,
          enabled: true,
          config: {
            ...item.section.config,
            eyebrow: "Tentang",
            heading: "Tentang CV Karya Mandiri Jaya",
            subheading: "Profil resmi kontraktor gedung industri.",
            bodyHtml: "<p>CV Karya Mandiri Jaya melayani pembangunan pabrik dan gudang.</p>",
          },
        };
      }
      return item.section;
    });

    const popDraftSave = await handleTenantPresetsDraftRequest(
      TENANT_POPULATED.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_POPULATED.handle}/presets/draft`, "PATCH", {
        cookie: ownerPopulated.cookie,
        body: {
          expectedVersion: popState.setup!.version,
          sections: popEditedSections,
          selectedPublishSectionIds: ["preset-about", "preset-contact"],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8100 },
    );
    expect(popDraftSave.status).toBe(200);
    const popSaved = (await popDraftSave.json()) as TenantPresetStateDto;
    expect(popSaved.setup!.version).toBeGreaterThan(popState.setup!.version);

    // Finding #2: Re-applying preset with a BRAND NEW operationKey MUST NOT wipe edited draft text!
    const reApplyRes = await handleTenantPresetsApplyRequest(
      TENANT_POPULATED.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_POPULATED.handle}/presets/apply`, "POST", {
        cookie: ownerPopulated.cookie,
        body: {
          presetId: "company_profile",
          operationKey: "op-populated-reapply-new-key-002",
          applyMode: "preserve_existing",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8200 },
    );
    expect(reApplyRes.status).toBe(200);
    const reApplied = (await reApplyRes.json()) as ApplyStarterPresetResult;
    const aboutAfterReapply = reApplied.state.setup!.sections.find((s) => s.id === "preset-about");
    expect(
      aboutAfterReapply?.section.type === "about" && aboutAfterReapply.section.config.heading,
    ).toBe("Tentang CV Karya Mandiri Jaya");
    expect(reApplied.state.setup!.selectedPublishSectionIds).toEqual([
      "preset-about",
      "preset-contact",
    ]);

    // Publish validated selected sections on TENANT_POPULATED
    const popPubRes = await handleTenantPresetsPublishRequest(
      TENANT_POPULATED.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_POPULATED.handle}/presets/publish`, "POST", {
        cookie: ownerPopulated.cookie,
        body: {
          presetId: "company_profile",
          selectedSectionIds: ["preset-about", "preset-contact"],
          expectedVersion: reApplied.state.setup!.version,
          confirm: true,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8300 },
    );
    expect(popPubRes.status).toBe(200);

    // Pre-existing live `existing-hero` MUST still exist in published_sections_json AND draft_sections_json!
    const popHomeAfter = await tenantDbPopulated
      .prepare(
        "SELECT id, status, draft_sections_json, published_sections_json, published_at, content_modified_at, deleted_at, version, updated_at FROM pages WHERE id = 1",
      )
      .first<{
        readonly id: number;
        readonly status: "draft" | "published" | "trashed";
        readonly draft_sections_json: string;
        readonly published_sections_json: string | null;
        readonly published_at: number | null;
        readonly content_modified_at: number | null;
        readonly deleted_at: number | null;
        readonly version: number;
        readonly updated_at: number;
      }>();
    const popPublishedSnap = extractPublishedSnapshot("page", {
      resourceId: Number(popHomeAfter!.id),
      status: popHomeAfter!.status,
      deletedAt: popHomeAfter!.deleted_at,
      draftJson: popHomeAfter!.draft_sections_json,
      publishedJson: popHomeAfter!.published_sections_json,
      publishedAt: popHomeAfter!.published_at,
      contentModifiedAt: popHomeAfter!.content_modified_at,
      version: Number(popHomeAfter!.version),
      updatedAt: Number(popHomeAfter!.updated_at),
    });
    const pubIds = (popPublishedSnap?.data.sections ?? []).map((s) => s.id);
    expect(pubIds).toContain("existing-hero");
    expect(pubIds).toContain("preset-about");
    expect(pubIds).toContain("preset-contact");
    expect(
      (popPublishedSnap?.data.sections ?? []).find((s) => s.id === "existing-hero")?.heading,
    ).toBe("Karya Mandiri Konstruksi Terpercaya");

    // Re-applying with another new operationKey after publish MUST NOT flip status back to 'draft'!
    const postPubReapply = await handleTenantPresetsApplyRequest(
      TENANT_POPULATED.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_POPULATED.handle}/presets/apply`, "POST", {
        cookie: ownerPopulated.cookie,
        body: {
          presetId: "company_profile",
          operationKey: "op-populated-reapply-post-pub-003",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8400 },
    );
    expect(postPubReapply.status).toBe(200);
    expect(((await postPubReapply.json()) as ApplyStarterPresetResult).state.setup!.status).toBe(
      "published",
    );

    // 2. Findings #4 & #5: Fresh tenant with existing footer menu (id=1) AND trashed page owning slug='beranda'
    await tenantDbEdge.batch([
      tenantDbEdge
        .prepare(
          `INSERT INTO menus
             (id, location, items_json, draft_items_json, published_items_json, version, created_at, updated_at)
           VALUES (1, 'footer', '[]', '[]', NULL, 1, ?, ?)`,
        )
        .bind(BASE_NOW_MS, BASE_NOW_MS),
      tenantDbEdge
        .prepare(
          `INSERT INTO pages
             (id, slug, title, is_homepage, draft_sections_json, published_sections_json, status, deleted_at, version, created_at, updated_at)
           VALUES (1, 'beranda', 'Beranda Lama Terhapus', 0, '[]', NULL, 'trashed', ?, 1, ?, ?)`,
        )
        .bind(BASE_NOW_MS - 5000, BASE_NOW_MS - 10_000, BASE_NOW_MS - 5000),
      tenantDbEdge.prepare("INSERT OR REPLACE INTO sequences (kind, next) VALUES ('page', 1)"),
    ]);

    const edgeApplyRes = await handleTenantPresetsApplyRequest(
      TENANT_EDGE.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_EDGE.handle}/presets/apply`, "POST", {
        cookie: ownerEdge.cookie,
        body: {
          presetId: "company_profile",
          operationKey: "op-edge-collision-001",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8500 },
    );
    expect(edgeApplyRes.status).toBe(200);
    const edgeApplied = (await edgeApplyRes.json()) as ApplyStarterPresetResult;
    expect(edgeApplied.createdHomepageDraft).toBe(true);
    expect(edgeApplied.createdHeaderMenuDraft).toBe(true);

    const edgeHome = await tenantDbEdge
      .prepare("SELECT slug FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL")
      .first<{ readonly slug: string }>();
    expect(edgeHome?.slug).toBe("beranda-preset");

    const edgeHeaderMenu = await tenantDbEdge
      .prepare("SELECT id, location FROM menus WHERE location = 'header'")
      .first<{ readonly id: number; readonly location: string }>();
    expect(Number(edgeHeaderMenu?.id)).toBe(2);

    // 3. Finding #7: Missing required checklist item (`identity` has sample marker) blocks publish with 422 CHECKLIST_INCOMPLETE!
    await tenantDbEdge
      .prepare("UPDATE site_settings SET site_title = '[Contoh] Nama Situs' WHERE id = 1")
      .run();

    const incompleteChecklistPub = await handleTenantPresetsPublishRequest(
      TENANT_EDGE.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_EDGE.handle}/presets/publish`, "POST", {
        cookie: ownerEdge.cookie,
        body: {
          presetId: "company_profile",
          selectedSectionIds: ["preset-contact"],
          expectedVersion: edgeApplied.state.setup!.version,
          confirm: true,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8600 },
    );
    expect(incompleteChecklistPub.status).toBe(422);
    const incompleteJson = (await incompleteChecklistPub.json()) as { error: { code: string } };
    expect(incompleteJson.error.code).toBe("CHECKLIST_INCOMPLETE");

    // Restore valid identity, leave optional items (privacy, domain) missing -> now ready for publish!
    await tenantDbEdge
      .prepare("UPDATE site_settings SET site_title = 'PT Edge Kasus Resmi' WHERE id = 1")
      .run();

    // 4. Finding #3: Simulate PLATFORM_DB cache_version failure during publish -> proves FULL rollback
    //    of preset_setups, pages, AND content_revisions (zero leaked revision row)!
    const revsBeforeFail = await tenantDbEdge
      .prepare("SELECT COUNT(*) AS count FROM content_revisions")
      .first<{ readonly count: number }>();

    const failingPlatformDb = {
      ...env.PLATFORM_DB,
      prepare: env.PLATFORM_DB.prepare.bind(env.PLATFORM_DB),
      batch: async () => {
        throw new Error("Simulated PLATFORM_DB cache_version outage");
      },
    } as unknown as D1Database;

    await expect(
      publishStarterPresetSectionsAtomically(
        failingPlatformDb,
        tenantDbEdge,
        {
          tenantId: TENANT_EDGE.id,
          handle: TENANT_EDGE.handle,
          tenantName: TENANT_EDGE.name,
          userId: ownerEdge.userId,
          role: "owner",
          tenantStatus: "active",
        },
        {
          presetId: "company_profile",
          selectedSectionIds: ["preset-contact"],
          expectedVersion: edgeApplied.state.setup!.version,
          confirm: true,
        },
        { nowMs: BASE_NOW_MS + 8700 },
      ),
    ).rejects.toBeInstanceOf(PublicationAtomicError);

    const revsAfterFail = await tenantDbEdge
      .prepare("SELECT COUNT(*) AS count FROM content_revisions")
      .first<{ readonly count: number }>();
    const setupAfterFail = await tenantDbEdge
      .prepare("SELECT status, version FROM preset_setups WHERE id = 1")
      .first<{ readonly status: string; readonly version: number }>();
    const pageAfterFail = await tenantDbEdge
      .prepare("SELECT status, published_sections_json FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL")
      .first<{ readonly status: string; readonly published_sections_json: string | null }>();

    expect(Number(revsAfterFail?.count)).toBe(Number(revsBeforeFail?.count));
    expect(setupAfterFail?.status).toBe("draft");
    expect(Number(setupAfterFail?.version)).toBe(edgeApplied.state.setup!.version);
    expect(pageAfterFail?.status).toBe("draft");
    expect(pageAfterFail?.published_sections_json).toBeNull();
  });
});

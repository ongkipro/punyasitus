import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  PublicationAtomicError,
  serializeDraftStoragePayload,
  StaleRevisionError,
} from "@punyasitus/core/content/index";
import { PREVIEW_IFRAME_SANDBOX } from "@punyasitus/core/preview/index";
import { evaluateThemeCompatibility, PLATFORM_THEME_IDS } from "@punyasitus/core/theme/index";
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
  tenantThemeEntitlements,
  themeCatalog,
} from "@punyasitus/db/platform";
import {
  getDraftResourceForAdmin,
  getPublishedResource,
  publishResourceAtomically,
  saveDraftResource,
} from "@punyasitus/db/publication/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { activateTenantThemeAtomically } from "@punyasitus/db/themes/index";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildThemeCompatibilityCandidate,
  getRegisteredTheme,
} from "../../apps/web/src/core/theme-registry.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import {
  handleTenantThemesPreviewRequest,
  type ExtraRegisteredThemeSpec,
  type TenantThemesRuntimeEnv,
  type ThemeLibraryActivateResultDto,
  type ThemeLibraryPreviewResultDto,
  type ThemeLibraryStateDto,
} from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/_shared.ts";
import { handleTenantThemesActivateRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/activate.ts";
import { handleTenantThemesListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/index.ts";
import { loadThemeLibraryPageOrGateResponse } from "../../apps/web/src/pages/dashboard/[handle]/appearance/themes/_page-gate.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 3, 0, 0);

const TENANT_A = {
  id: "01JT042TENANTA000000000001",
  orgId: "org_t042_alpha",
  handle: "t042-alpha",
  name: "T042 Alpha Konsultan",
  host: "t042-alpha.situsku.click",
} as const;

const TENANT_B = {
  id: "01JT042TENANTB000000000002",
  orgId: "org_t042_beta",
  handle: "t042-beta",
  name: "T042 Beta Studio Agensi",
  host: "t042-beta.situsku.click",
} as const;

const TENANT_LOCKED = {
  id: "01JT042TENANTC000000000003",
  orgId: "org_t042_locked",
  handle: "t042-locked",
  name: "T042 Locked Tenant",
  host: "t042-locked.situsku.click",
} as const;

function buildRuntimeEnv(
  overrides: Partial<TenantThemesRuntimeEnv> = {},
): TenantThemesRuntimeEnv {
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
  method: "GET" | "POST" = "GET",
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

async function signUpUser(
  email: string,
  name: string,
  runtimeEnv: TenantThemesRuntimeEnv,
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

describe("TASK-042: Theme Library, Compatibility Preview & Atomic Activation on workerd", () => {
  let tenantDbA: D1Database;
  let tenantDbB: D1Database;
  let tenantDbLocked: D1Database;
  let ownerA: { readonly userId: string; readonly cookie: string };
  let adminA: { readonly userId: string; readonly cookie: string };
  let editorA: { readonly userId: string; readonly cookie: string };
  let ownerB: { readonly userId: string; readonly cookie: string };
  let ownerLocked: { readonly userId: string; readonly cookie: string };
  const runtimeEnv = buildRuntimeEnv();

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);

    for (const [spec, status, vertical] of [
      [TENANT_A, "active", "compro"],
      [TENANT_B, "active", "sales"],
      [TENANT_LOCKED, "locked", "compro"],
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

    // Register custom themes in PLATFORM_DB.theme_catalog
    await pDb
      .insert(themeCatalog)
      .values([
        {
          id: "custom-sample-agency",
          slug: "sample-agency",
          name: "Editorial Studio Agency (Sample)",
          tier: "custom",
          priceIdr: 0,
          active: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "custom-restricted-v2",
          slug: "restricted-v2",
          name: "Restricted Custom Theme",
          tier: "custom",
          priceIdr: 0,
          active: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .onConflictDoNothing();

    // Grant `custom-sample-agency` ONLY to Tenant B (NEVER Tenant A!)
    // Grant `custom-restricted-v2` to Tenant A (to prove incompatibility rejection on a granted theme!)
    await pDb
      .insert(tenantThemeEntitlements)
      .values([
        {
          id: "ent_t042_b_sample_agency",
          tenantId: TENANT_B.id,
          themeId: "custom-sample-agency",
          grantedBy: "platform_op_1",
          grantedAt: now,
        },
        {
          id: "ent_t042_a_restricted",
          tenantId: TENANT_A.id,
          themeId: "custom-restricted-v2",
          grantedBy: "platform_op_1",
          grantedAt: now,
        },
      ])
      .onConflictDoNothing();

    [tenantDbA, tenantDbB, tenantDbLocked] = await Promise.all([
      openMigratedTenantDb(TENANT_A.id),
      openMigratedTenantDb(TENANT_B.id),
      openMigratedTenantDb(TENANT_LOCKED.id),
    ]);

    ownerA = await signUpUser("owner-a@t042.example", "Owner Alpha", runtimeEnv);
    adminA = await signUpUser("admin-a@t042.example", "Admin Alpha", runtimeEnv);
    editorA = await signUpUser("editor-a@t042.example", "Editor Alpha", runtimeEnv);
    ownerB = await signUpUser("owner-b@t042.example", "Owner Beta", runtimeEnv);
    ownerLocked = await signUpUser("owner-locked@t042.example", "Owner Locked", runtimeEnv);

    await pDb
      .insert(members)
      .values([
        {
          id: "mem_t042_owner_a",
          organizationId: TENANT_A.orgId,
          userId: ownerA.userId,
          role: "owner",
          createdAt: now,
        },
        {
          id: "mem_t042_admin_a",
          organizationId: TENANT_A.orgId,
          userId: adminA.userId,
          role: "admin",
          createdAt: now,
        },
        {
          id: "mem_t042_editor_a",
          organizationId: TENANT_A.orgId,
          userId: editorA.userId,
          role: "editor",
          createdAt: now,
        },
        {
          id: "mem_t042_owner_b",
          organizationId: TENANT_B.orgId,
          userId: ownerB.userId,
          role: "owner",
          createdAt: now,
        },
        {
          id: "mem_t042_owner_locked",
          organizationId: TENANT_LOCKED.orgId,
          userId: ownerLocked.userId,
          role: "owner",
          createdAt: now,
        },
      ])
      .onConflictDoNothing();

    // Seed Tenant A with real published content (pages, posts, offerings, menus, media)
    // AND custom saved `compro` tokens (`#14532d`, `borderRadiusPx: 14`) to prove recovery!
    await tenantDbA.batch([
      tenantDbA
        .prepare(
          `INSERT INTO site_settings
             (id, site_title, tagline, timezone, locale, active_theme_id, blog_enabled, catalog_enabled, ai_training_policy, version, updated_at)
           VALUES (1, 'Alpha Konsultan Bisnis', 'Mitra Strategis UMKM', 'Asia/Jakarta', 'id-ID', 'compro', 1, 1, 'allow', 1, ?)`,
        )
        .bind(BASE_NOW_MS),
      tenantDbA
        .prepare(
          `INSERT INTO business_profile
             (id, business_name, business_category, description, version, updated_at)
           VALUES (1, 'Alpha Konsultan Bisnis', 'LocalBusiness', 'Layanan konsultasi manajemen dan keuangan.', 1, ?)`,
        )
        .bind(BASE_NOW_MS),
      tenantDbA
        .prepare(
          `INSERT INTO pages
             (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
           VALUES (1, 'beranda', 'Beranda Alpha', 1, '[]', 'draft', 1, ?, ?),
                  (2, 'tentang-kami', 'Tentang Alpha', 0, '[]', 'published', 1, ?, ?)`,
        )
        .bind(BASE_NOW_MS, BASE_NOW_MS, BASE_NOW_MS, BASE_NOW_MS),
      tenantDbA
        .prepare(
          `INSERT INTO posts
             (id, slug, title, excerpt, draft_body_json, status, version, created_at, updated_at)
           VALUES (1, 'strategi-tumbuh', 'Strategi Tumbuh 2026', 'Panduan praktis UMKM.', '{"schemaVersion":1,"blocks":[]}', 'published', 1, ?, ?)`,
        )
        .bind(BASE_NOW_MS, BASE_NOW_MS),
      tenantDbA
        .prepare(
          `INSERT INTO offerings
             (id, offering_type, slug, title, summary, price_mode, price, cta_mode, status, version, created_at, updated_at)
           VALUES (1, 'service', 'audit-operasional', 'Audit Operasional Bisnis', 'Evaluasi proses bisnis menyeluruh.', 'fixed', 4500000, 'whatsapp', 'published', 1, ?, ?)`,
        )
        .bind(BASE_NOW_MS, BASE_NOW_MS),
      tenantDbA
        .prepare(
          `INSERT INTO menus
             (id, location, items_json, version, created_at, updated_at)
           VALUES (1, 'header', '[{"label":"Beranda","href":"/","openInNewTab":false,"children":[]}]', 1, ?, ?)`,
        )
        .bind(BASE_NOW_MS, BASE_NOW_MS),
      tenantDbA
        .prepare(
          `INSERT INTO media_items
             (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, status, version, created_at, updated_at)
           VALUES (1, 'image', 't/alpha/hero.webp', 'image/webp', 48000, 'abc123', 1200, 800, 'Tim Alpha', 'ready', 1, ?, ?)`,
        )
        .bind(BASE_NOW_MS, BASE_NOW_MS),
      tenantDbA
        .prepare(
          `INSERT INTO theme_configs
             (theme_id, tokens_json, variants_json, version, updated_at)
           VALUES ('compro', ?, ?, 1, ?)`,
        )
        .bind(
          JSON.stringify({
            primaryColor: "#14532d",
            secondaryColor: "#0f4c5c",
            accentColor: "#1d4ed8",
            surfaceColor: "#ffffff",
            textColor: "#111c19",
            fontFamily: "plus-jakarta-sans",
            borderRadiusPx: 14,
            spacingScale: 1,
            containerMaxWidthPx: 1200,
            sectionPaddingYPx: 64,
            fastestSystemFont: false,
          }),
          JSON.stringify({
            styleVariant: "bold-corporate",
            headerVariant: "sticky-cta",
            footerVariant: "columns",
            heroVariant: "split",
            buttonStyle: "solid",
          }),
          BASE_NOW_MS,
        ),
    ]);

    // Publish homepage + site_settings + compro theme_config for Tenant A
    await saveDraftResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_NOW_MS + 100,
      draft: {
        slug: "beranda",
        title: "Beranda Alpha",
        isHomepage: true,
        layoutMode: "standard",
        sections: [
          {
            id: "sec-hero",
            kind: "hero",
            heading: "Alpha Konsultan — Solusi Bisnis Terpercaya",
            subheading: "Konten publik nyata yang harus tetap utuh saat ganti tema.",
            bodyHtml: null,
            ctaLabel: "Hubungi Kami",
            ctaHref: "#kontak",
          },
          {
            id: "sec-faq",
            kind: "faq",
            heading: "Pertanyaan Umum",
            subheading: "Informasi layanan konsultasi.",
            bodyHtml: null,
          },
        ],
      },
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 2,
      actorUserId: ownerA.userId,
      nowMs: BASE_NOW_MS + 200,
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 1,
      actorUserId: ownerA.userId,
      nowMs: BASE_NOW_MS + 300,
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "theme_config",
      resourceId: "compro",
      expectedVersion: 1,
      actorUserId: ownerA.userId,
      nowMs: BASE_NOW_MS + 400,
    });

    // Seed Tenant B & Tenant Locked baseline site_settings
    await tenantDbB
      .prepare(
        `INSERT INTO site_settings
           (id, site_title, timezone, locale, active_theme_id, blog_enabled, catalog_enabled, ai_training_policy, version, updated_at)
         VALUES (1, 'Beta Studio Agensi', 'Asia/Jakarta', 'id-ID', 'sales', 1, 1, 'allow', 1, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();

    await tenantDbLocked
      .prepare(
        `INSERT INTO site_settings
           (id, site_title, timezone, locale, active_theme_id, blog_enabled, catalog_enabled, ai_training_policy, version, updated_at)
         VALUES (1, 'Locked Site', 'Asia/Jakarta', 'id-ID', 'compro', 1, 1, 'allow', 1, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();
  });

  it("lists ONLY built-in platform themes + themes granted to THIS tenant (never leaks foreign custom grants)", async () => {
    const resA = await handleTenantThemesListRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
    );
    expect(resA.status).toBe(200);
    expect(resA.headers.get("cache-control")).toBe("private, no-store");
    expect(resA.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const dataA = (await resA.json()) as ThemeLibraryStateDto;
    expect(dataA.activeThemeId).toBe("compro");
    expect(dataA.themes.map((t) => t.id)).toEqual([...PLATFORM_THEME_IDS]);
    expect(dataA.themes.some((t) => t.id === "custom-sample-agency")).toBe(false);
    expect(dataA.contentSummary).toEqual({
      pages: 2,
      posts: 1,
      offerings: 1,
      menus: 1,
      media: 1,
    });

    // Tenant B sees the 6 platform themes + its granted `custom-sample-agency`
    const resB = await handleTenantThemesListRequest(
      TENANT_B.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_B.id}/themes`, "GET", {
        cookie: ownerB.cookie,
      }),
      runtimeEnv,
    );
    expect(resB.status).toBe(200);
    const dataB = (await resB.json()) as ThemeLibraryStateDto;
    expect(dataB.themes.map((t) => t.id)).toEqual([...PLATFORM_THEME_IDS, "custom-sample-agency"]);
    const customB = dataB.themes.find((t) => t.id === "custom-sample-agency");
    expect(customB?.isCustom).toBe(true);
    expect(customB?.grantSource).toBe("tenant_grant");
    expect(customB?.compatibility.compatible).toBe(true);
  });

  it("blocks direct preview & activation of another tenant's custom theme (403 THEME_NOT_GRANTED) and unknown themes (404 THEME_NOT_FOUND)", async () => {
    const listBefore = await handleTenantThemesListRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
    );
    const stateBefore = (await listBefore.json()) as ThemeLibraryStateDto;
    const cacheBefore = await getTenantCacheVersion(TENANT_A.id);

    // Tenant A tries to preview Tenant B's custom theme -> 403 THEME_NOT_GRANTED
    const previewRes = await handleTenantThemesPreviewRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/preview`, "POST", {
        cookie: ownerA.cookie,
        body: { themeId: "custom-sample-agency" },
      }),
      runtimeEnv,
    );
    expect(previewRes.status).toBe(403);
    const previewErr = (await previewRes.json()) as { error: { code: string } };
    expect(previewErr.error.code).toBe("THEME_NOT_GRANTED");

    // Tenant A tries to activate Tenant B's custom theme -> 403 THEME_NOT_GRANTED
    const activateRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        cookie: ownerA.cookie,
        body: {
          themeId: "custom-sample-agency",
          expectedVersion: stateBefore.version,
          confirm: true,
        },
      }),
      runtimeEnv,
    );
    expect(activateRes.status).toBe(403);
    const activateErr = (await activateRes.json()) as { error: { code: string } };
    expect(activateErr.error.code).toBe("THEME_NOT_GRANTED");

    // Unknown theme -> 404 THEME_NOT_FOUND
    const unknownRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        cookie: ownerA.cookie,
        body: {
          themeId: "custom-nonexistent-theme",
          expectedVersion: stateBefore.version,
          confirm: true,
        },
      }),
      runtimeEnv,
    );
    expect(unknownRes.status).toBe(404);
    const unknownErr = (await unknownRes.json()) as { error: { code: string } };
    expect(unknownErr.error.code).toBe("THEME_NOT_FOUND");

    // Zero side effects
    expect(await getTenantCacheVersion(TENANT_A.id)).toBe(cacheBefore);
  });

  it("rejects incompatible theme activation with 422 THEME_INCOMPATIBLE and zero side effects", async () => {
    const compro = getRegisteredTheme("compro")!;
    const incompatibleCustomTheme: ExtraRegisteredThemeSpec = {
      ...compro,
      id: "custom-restricted-v2",
      slug: "restricted-v2",
      name: "Restricted Custom Theme",
      tier: "custom",
      isCustom: true,
      // Tenant A's published homepage includes `faq`, which this theme does NOT support!
      supportedSectionTypes: ["hero", "about"],
    };

    const listRes = await handleTenantThemesListRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { extraRegisteredThemes: [incompatibleCustomTheme] },
    );
    const state = (await listRes.json()) as ThemeLibraryStateDto;
    const restrictedItem = state.themes.find((t) => t.id === "custom-restricted-v2");
    expect(restrictedItem).toBeDefined();
    expect(restrictedItem?.compatibility.compatible).toBe(false);
    expect(restrictedItem?.compatibility.unsupportedSections).toContain("faq");

    const cacheBefore = await getTenantCacheVersion(TENANT_A.id);

    const activateRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        cookie: ownerA.cookie,
        body: {
          themeId: "custom-restricted-v2",
          expectedVersion: state.version,
          confirm: true,
        },
      }),
      runtimeEnv,
      { extraRegisteredThemes: [incompatibleCustomTheme] },
    );

    expect(activateRes.status).toBe(422);
    const errJson = (await activateRes.json()) as {
      error: {
        code: string;
        compatibility?: { compatible: boolean; unsupportedSections: string[] };
      };
    };
    expect(errJson.error.code).toBe("THEME_INCOMPATIBLE");
    expect(errJson.error.compatibility?.compatible).toBe(false);
    expect(errJson.error.compatibility?.unsupportedSections).toContain("faq");

    // Zero side effects
    expect(await getTenantCacheVersion(TENANT_A.id)).toBe(cacheBefore);
    const siteRow = await tenantDbA
      .prepare("SELECT active_theme_id, version FROM site_settings WHERE id = 1")
      .first<{ active_theme_id: string; version: number }>();
    expect(siteRow?.active_theme_id).toBe("compro");
    expect(siteRow?.version).toBe(state.version);
  });

  it("renders compatibility preview with real tenant public content without mutating live state or cache_version", async () => {
    const cacheBefore = await getTenantCacheVersion(TENANT_A.id);
    const siteBefore = await tenantDbA
      .prepare("SELECT active_theme_id, version FROM site_settings WHERE id = 1")
      .first<{ active_theme_id: string; version: number }>();

    const previewRes = await handleTenantThemesPreviewRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/preview`, "POST", {
        cookie: ownerA.cookie,
        body: { themeId: "travel" },
      }),
      runtimeEnv,
    );

    expect(previewRes.status).toBe(200);
    expect(previewRes.headers.get("cache-control")).toContain("private, no-store");
    expect(previewRes.headers.get("x-robots-tag")).toContain("noindex, nofollow");
    expect(previewRes.headers.get("content-security-policy")).toContain("default-src 'none'");

    const preview = (await previewRes.json()) as ThemeLibraryPreviewResultDto;
    expect(preview.themeId).toBe("travel");
    expect(preview.sandbox).toBe(PREVIEW_IFRAME_SANDBOX);
    expect(preview.sandbox).toBe("");
    expect(preview.isPreview).toBe(true);
    expect(preview.compatibility.compatible).toBe(true);
    expect(preview.html).toContain('data-ps-theme="travel"');
    expect(preview.html).toContain("Alpha Konsultan — Solusi Bisnis Terpercaya");

    // Confirm ZERO mutation to live theme or cache_version!
    expect(await getTenantCacheVersion(TENANT_A.id)).toBe(cacheBefore);
    const siteAfter = await tenantDbA
      .prepare("SELECT active_theme_id, version FROM site_settings WHERE id = 1")
      .first<{ active_theme_id: string; version: number }>();
    expect(siteAfter?.active_theme_id).toBe(siteBefore?.active_theme_id);
    expect(siteAfter?.version).toBe(siteBefore?.version);
  });

  it("atomically switches Theme A -> Theme B -> Theme A, preserving all content and recovering Theme A's custom tokens", async () => {
    const listBeforeRes = await handleTenantThemesListRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
    );
    const stateBefore = (await listBeforeRes.json()) as ThemeLibraryStateDto;
    const cacheBefore = await getTenantCacheVersion(TENANT_A.id);

    // 1. Switch `compro` -> `travel` (using Admin role to verify admin is also authorized)
    const switchToTravelRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        cookie: adminA.cookie,
        body: {
          themeId: "travel",
          expectedVersion: stateBefore.version,
          confirm: true,
        },
      }),
      runtimeEnv,
    );
    expect(switchToTravelRes.status).toBe(200);
    const travelActivated = (await switchToTravelRes.json()) as ThemeLibraryActivateResultDto;
    expect(travelActivated.activeThemeId).toBe("travel");
    expect(travelActivated.activatedThemeId).toBe("travel");
    expect(travelActivated.previousThemeId).toBe("compro");
    expect(travelActivated.recoveredExistingConfig).toBe(false);
    expect(travelActivated.version).toBe(stateBefore.version + 1);
    expect(travelActivated.cacheVersion).toBe(cacheBefore + 1);

    // Confirm `compro`'s saved custom tokens are STILL intact in `theme_configs`
    const savedComproAfterSwitch = await getPublishedResource(tenantDbA, {
      resourceType: "theme_config",
      resourceId: "compro",
    });
    expect(savedComproAfterSwitch?.data.tokens.primaryColor).toBe("#14532d");
    expect(savedComproAfterSwitch?.data.tokens.borderRadiusPx).toBe(14);
    expect(savedComproAfterSwitch?.data.variants.styleVariant).toBe("bold-corporate");

    // Confirm ZERO tenant content was deleted or mutated
    expect(travelActivated.contentSummary).toEqual({
      pages: 2,
      posts: 1,
      offerings: 1,
      menus: 1,
      media: 1,
    });
    const [pageRow, postRow, offeringRow] = await Promise.all([
      tenantDbA.prepare("SELECT title FROM pages WHERE id = 2").first<{ title: string }>(),
      tenantDbA.prepare("SELECT title FROM posts WHERE id = 1").first<{ title: string }>(),
      tenantDbA.prepare("SELECT title, price FROM offerings WHERE id = 1").first<{
        title: string;
        price: number;
      }>(),
    ]);
    expect(pageRow?.title).toBe("Tentang Alpha");
    expect(postRow?.title).toBe("Strategi Tumbuh 2026");
    expect(offeringRow).toEqual({ title: "Audit Operasional Bisnis", price: 4500000 });

    // Confirm activity log & content_revisions recorded atomically
    const activityRow = await tenantDbA
      .prepare(
        "SELECT action, resource_id, actor_user_id FROM tenant_activity_log WHERE action = 'theme.activated' ORDER BY id DESC LIMIT 1",
      )
      .first<{ action: string; resource_id: string; actor_user_id: string }>();
    expect(activityRow).toEqual({
      action: "theme.activated",
      resource_id: "travel",
      actor_user_id: adminA.userId,
    });

    // 2. Switch BACK `travel` -> `compro`: proves full recovery of `compro`'s prior custom tokens!
    const switchBackRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        cookie: ownerA.cookie,
        body: {
          themeId: "compro",
          expectedVersion: travelActivated.version,
          confirm: true,
        },
      }),
      runtimeEnv,
    );
    expect(switchBackRes.status).toBe(200);
    const comproRecovered = (await switchBackRes.json()) as ThemeLibraryActivateResultDto;
    expect(comproRecovered.activeThemeId).toBe("compro");
    expect(comproRecovered.previousThemeId).toBe("travel");
    expect(comproRecovered.recoveredExistingConfig).toBe(true);
    expect(comproRecovered.cacheVersion).toBe(cacheBefore + 2);

    const publishedCompro = await getPublishedResource(tenantDbA, {
      resourceType: "theme_config",
      resourceId: "compro",
    });
    expect(publishedCompro?.data.tokens.primaryColor).toBe("#14532d");
    expect(publishedCompro?.data.tokens.borderRadiusPx).toBe(14);
    expect(publishedCompro?.data.tokens.fontFamily).toBe("plus-jakarta-sans");
    expect(publishedCompro?.data.variants.styleVariant).toBe("bold-corporate");
  });

  it("allows Tenant B to atomically activate its granted custom theme while keeping Tenant A isolated", async () => {
    const listBRes = await handleTenantThemesListRequest(
      TENANT_B.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_B.id}/themes`, "GET", {
        cookie: ownerB.cookie,
      }),
      runtimeEnv,
    );
    const stateB = (await listBRes.json()) as ThemeLibraryStateDto;

    const activateBRes = await handleTenantThemesActivateRequest(
      TENANT_B.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_B.id}/themes/activate`, "POST", {
        cookie: ownerB.cookie,
        body: {
          themeId: "custom-sample-agency",
          expectedVersion: stateB.version,
          confirm: true,
        },
      }),
      runtimeEnv,
    );
    expect(activateBRes.status).toBe(200);
    const activatedB = (await activateBRes.json()) as ThemeLibraryActivateResultDto;
    expect(activatedB.activeThemeId).toBe("custom-sample-agency");

    // Tenant A remains completely unaffected
    const siteA = await tenantDbA
      .prepare("SELECT active_theme_id FROM site_settings WHERE id = 1")
      .first<{ active_theme_id: string }>();
    expect(siteA?.active_theme_id).toBe("compro");
  });

  it("enforces required expectedVersion (422), stale & concurrent races (409 STALE_VERSION), RBAC, cross-tenant 404, locked 403, and CSRF", async () => {
    const listRes = await handleTenantThemesListRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
    );
    const current = (await listRes.json()) as ThemeLibraryStateDto;
    const cacheBefore = await getTenantCacheVersion(TENANT_A.id);

    // 1. Missing expectedVersion -> 422 VALIDATION_ERROR
    const missingVerRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        cookie: ownerA.cookie,
        body: { themeId: "catalog", confirm: true },
      }),
      runtimeEnv,
    );
    expect(missingVerRes.status).toBe(422);

    // 2. Stale expectedVersion -> 409 STALE_VERSION with zero writes
    const staleRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        cookie: ownerA.cookie,
        body: {
          themeId: "catalog",
          expectedVersion: current.version - 1,
          confirm: true,
        },
      }),
      runtimeEnv,
    );
    expect(staleRes.status).toBe(409);
    const staleBody = (await staleRes.json()) as { error: { code: string } };
    expect(staleBody.error.code).toBe("STALE_VERSION");
    expect(await getTenantCacheVersion(TENANT_A.id)).toBe(cacheBefore);

    // 3. Editor denied 403 on activate & preview, allowed read-only GET with canActivate=false
    const editorListRes = await handleTenantThemesListRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes`, "GET", {
        cookie: editorA.cookie,
      }),
      runtimeEnv,
    );
    expect(editorListRes.status).toBe(200);
    const editorState = (await editorListRes.json()) as ThemeLibraryStateDto;
    expect(editorState.permissions.canActivate).toBe(false);
    expect(editorState.permissions.role).toBe("editor");

    const editorActivateRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        cookie: editorA.cookie,
        body: { themeId: "catalog", expectedVersion: current.version, confirm: true },
      }),
      runtimeEnv,
    );
    expect(editorActivateRes.status).toBe(403);
    expect(((await editorActivateRes.json()) as { error: { code: string } }).error.code).toBe(
      "FORBIDDEN",
    );

    // 4. Cross-tenant (Owner B targeting Tenant A) -> neutral 404 NOT_FOUND
    const crossListRes = await handleTenantThemesListRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes`, "GET", {
        cookie: ownerB.cookie,
      }),
      runtimeEnv,
    );
    expect(crossListRes.status).toBe(404);

    const crossActivateRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        cookie: ownerB.cookie,
        body: { themeId: "catalog", expectedVersion: current.version, confirm: true },
      }),
      runtimeEnv,
    );
    expect(crossActivateRes.status).toBe(404);

    // 5. Console host -> neutral 404 NOT_FOUND
    const consoleHostRes = await handleTenantThemesListRequest(
      TENANT_A.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/tenants/${TENANT_A.id}/themes`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
    );
    expect(consoleHostRes.status).toBe(404);

    // 6. Locked tenant -> 403 SUBSCRIPTION_LOCKED on activate
    const lockedActivateRes = await handleTenantThemesActivateRequest(
      TENANT_LOCKED.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_LOCKED.id}/themes/activate`, "POST", {
        cookie: ownerLocked.cookie,
        body: { themeId: "travel", expectedVersion: 1, confirm: true },
      }),
      runtimeEnv,
    );
    expect(lockedActivateRes.status).toBe(403);
    expect(((await lockedActivateRes.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );

    // 7. CSRF Origin mismatch -> 403
    const csrfRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        cookie: ownerA.cookie,
        origin: "https://evil.example.com",
        body: { themeId: "catalog", expectedVersion: current.version, confirm: true },
      }),
      runtimeEnv,
    );
    expect(csrfRes.status).toBe(403);

    // 8. Concurrent race (`N -> N+1`): exactly ONE 200 and ONE 409 STALE_VERSION!
    const [race1, race2] = await Promise.all([
      handleTenantThemesActivateRequest(
        TENANT_A.id,
        makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
          cookie: ownerA.cookie,
          body: { themeId: "catalog", expectedVersion: current.version, confirm: true },
        }),
        runtimeEnv,
      ),
      handleTenantThemesActivateRequest(
        TENANT_A.id,
        makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
          cookie: adminA.cookie,
          body: { themeId: "resto", expectedVersion: current.version, confirm: true },
        }),
        runtimeEnv,
      ),
    ]);

    const statuses = [race1.status, race2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    expect(await getTenantCacheVersion(TENANT_A.id)).toBe(cacheBefore + 1);
  });

  it("B1: enforces SSR lifecycle & RBAC gate BEFORE any TenantStore DB read for suspended, recovery, purging, purged, and editor", async () => {
    let resolveTenantDbCalls = 0;
    const forbiddenDbResolver = () => {
      resolveTenantDbCalls += 1;
      throw new Error("TenantStore MUST NOT be opened for gated lifecycle/role states!");
    };

    // 1. purging & purged -> neutral 404, ZERO tenant DB reads
    for (const status of ["purging", "purged"] as const) {
      const res = await loadThemeLibraryPageOrGateResponse({
        platformDb: env.PLATFORM_DB,
        member: {
          tenantId: TENANT_A.id,
          handle: TENANT_A.handle,
          tenantName: TENANT_A.name,
          userId: ownerA.userId,
          role: "owner",
          tenantStatus: status,
        },
        resolveTenantDb: forbiddenDbResolver,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(404);
        expect(res.response.headers.get("cache-control")).toBe("private, no-store");
        expect(res.response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        const body = await res.response.text();
        expect(body).not.toContain("#14532d");
      }
    }

    // 2. suspended & recovery -> 302 redirect to /dashboard/{handle}/service-status, ZERO tenant DB reads
    for (const status of ["suspended", "recovery"] as const) {
      const res = await loadThemeLibraryPageOrGateResponse({
        platformDb: env.PLATFORM_DB,
        member: {
          tenantId: TENANT_A.id,
          handle: TENANT_A.handle,
          tenantName: TENANT_A.name,
          userId: ownerA.userId,
          role: "owner",
          tenantStatus: status,
        },
        resolveTenantDb: forbiddenDbResolver,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(302);
        expect(res.response.headers.get("location")).toBe(
          `/dashboard/${TENANT_A.handle}/service-status`,
        );
        expect(res.response.headers.get("cache-control")).toBe("private, no-store");
        expect(res.response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      }
    }

    // 3. editor lacking settings:read -> 403, ZERO tenant DB reads
    const editorGateRes = await loadThemeLibraryPageOrGateResponse({
      platformDb: env.PLATFORM_DB,
      member: {
        tenantId: TENANT_A.id,
        handle: TENANT_A.handle,
        tenantName: TENANT_A.name,
        userId: editorA.userId,
        role: "editor",
        tenantStatus: "active",
      },
      resolveTenantDb: forbiddenDbResolver,
    });
    expect(editorGateRes.ok).toBe(false);
    if (!editorGateRes.ok) {
      expect(editorGateRes.response.status).toBe(403);
      expect(editorGateRes.response.headers.get("cache-control")).toBe("private, no-store");
      expect(editorGateRes.response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }

    expect(resolveTenantDbCalls).toBe(0);

    // 4. locked owner -> allowed in read-only mode (canActivate === false)
    const lockedRes = await loadThemeLibraryPageOrGateResponse({
      platformDb: env.PLATFORM_DB,
      member: {
        tenantId: TENANT_LOCKED.id,
        handle: TENANT_LOCKED.handle,
        tenantName: TENANT_LOCKED.name,
        userId: ownerLocked.userId,
        role: "owner",
        tenantStatus: "locked",
      },
      resolveTenantDb: () => tenantDbLocked,
    });
    expect(lockedRes.ok).toBe(true);
    if (lockedRes.ok) {
      expect(lockedRes.initialState.permissions.isLocked).toBe(true);
      expect(lockedRes.initialState.permissions.canActivate).toBe(false);
    }
  });

  it("M1: aborts with 409 STALE_VERSION and ZERO writes to any table when theme_configs.version races mid-flight", async () => {
    const travelEntry = getRegisteredTheme("travel")!;
    const siteBefore = await tenantDbA
      .prepare("SELECT active_theme_id, version, updated_at FROM site_settings WHERE id = 1")
      .first<{ active_theme_id: string; version: number; updated_at: number }>();
    const travelBefore = await tenantDbA
      .prepare("SELECT version, updated_at FROM theme_configs WHERE theme_id = 'travel'")
      .first<{ version: number; updated_at: number }>();
    const activityCountBefore = await tenantDbA
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_activity_log")
      .first<{ cnt: number }>();
    const revCountBefore = await tenantDbA
      .prepare("SELECT COUNT(*) AS cnt FROM content_revisions")
      .first<{ cnt: number }>();
    const cacheBefore = await getTenantCacheVersion(TENANT_A.id);

    const compat = evaluateThemeCompatibility(buildThemeCompatibilityCandidate(travelEntry), {
      vertical: "compro",
    });

    await expect(
      activateTenantThemeAtomically({
        platformDb: env.PLATFORM_DB,
        tenantDb: tenantDbA,
        tenantId: TENANT_A.id,
        tenantName: TENANT_A.name,
        actorUserId: ownerA.userId,
        actorRole: "owner",
        targetTheme: {
          id: travelEntry.id,
          name: travelEntry.name,
          defaultTokens: travelEntry.defaultTokens,
          defaultVariants: travelEntry.defaultVariants,
        },
        expectedVersion: siteBefore!.version,
        compatibility: compat,
        nowMs: BASE_NOW_MS + 90_000,
        // Force a concurrent writer to bump `theme_configs.version` right after pre-read and before batch!
        beforeBatchWrite: async () => {
          await tenantDbA
            .prepare("UPDATE theme_configs SET version = version + 1, updated_at = ? WHERE theme_id = 'travel'")
            .bind(BASE_NOW_MS + 89_500)
            .run();
        },
      }),
    ).rejects.toBeInstanceOf(StaleRevisionError);

    // Assert true all-or-nothing: ZERO writes to site_settings, activity log, content_revisions, or cache_version!
    const siteAfter = await tenantDbA
      .prepare("SELECT active_theme_id, version, updated_at FROM site_settings WHERE id = 1")
      .first<{ active_theme_id: string; version: number; updated_at: number }>();
    const travelAfter = await tenantDbA
      .prepare("SELECT version, updated_at FROM theme_configs WHERE theme_id = 'travel'")
      .first<{ version: number; updated_at: number }>();
    const activityCountAfter = await tenantDbA
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_activity_log")
      .first<{ cnt: number }>();
    const revCountAfter = await tenantDbA
      .prepare("SELECT COUNT(*) AS cnt FROM content_revisions")
      .first<{ cnt: number }>();

    expect(siteAfter).toEqual(siteBefore);
    expect(travelAfter?.version).toBe((travelBefore?.version ?? 0) + 1);
    expect(activityCountAfter?.cnt).toBe(activityCountBefore?.cnt);
    expect(revCountAfter?.cnt).toBe(revCountBefore?.cnt);
    expect(await getTenantCacheVersion(TENANT_A.id)).toBe(cacheBefore);
  });

  it("M2: preserves unpublished site_settings.draft_json without silently publishing it on theme activation", async () => {
    const siteBefore = await tenantDbA
      .prepare("SELECT version, active_theme_id FROM site_settings WHERE id = 1")
      .first<{ version: number; active_theme_id: string }>();

    // Save an unpublished draft change on site_settings (`siteTitle` differs from published!)
    await saveDraftResource(tenantDbA, {
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: siteBefore!.version,
      nowMs: BASE_NOW_MS + 100_000,
      draft: {
        siteTitle: "Judul Draf Belum Diterbitkan",
        tagline: "Tagline Draf Rahasia",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: siteBefore!.active_theme_id,
        blogEnabled: true,
        catalogEnabled: true,
        aiTrainingPolicy: "allow",
        siteVisibility: "public",
      },
    });

    const listRes = await handleTenantThemesListRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
    );
    const state = (await listRes.json()) as ThemeLibraryStateDto;

    // Activate `sales` while unpublished site_settings draft is pending
    const activateRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        cookie: ownerA.cookie,
        body: {
          themeId: "sales",
          expectedVersion: state.version,
          confirm: true,
        },
      }),
      runtimeEnv,
    );
    expect(activateRes.status).toBe(200);

    const publishedSettings = await getPublishedResource(tenantDbA, {
      resourceType: "site_settings",
    });
    const adminSettings = await getDraftResourceForAdmin(tenantDbA, {
      resourceType: "site_settings",
    });

    // Published siteTitle stays unchanged; activeThemeId updated to `sales`
    expect(publishedSettings?.data.siteTitle).toBe("Alpha Konsultan Bisnis");
    expect(publishedSettings?.data.activeThemeId).toBe("sales");
    // Pending unpublished draft fields stay 100% preserved!
    expect(adminSettings?.draft?.siteTitle).toBe("Judul Draf Belum Diterbitkan");
    expect(adminSettings?.draft?.tagline).toBe("Tagline Draf Rahasia");
    expect(adminSettings?.draft?.activeThemeId).toBe("sales");
  });

  it("M3: does NOT publish target theme's unpublished draft_json on activation and keeps draft_json intact", async () => {
    const dealerEntry = getRegisteredTheme("dealer")!;
    const unpublishedDealerDraft = {
      themeId: "dealer",
      tokens: {
        ...dealerEntry.defaultTokens,
        primaryColor: "#991b1b",
        borderRadiusPx: 22,
      },
      variants: {
        ...dealerEntry.defaultVariants,
        styleVariant: "dark-showroom",
      },
    };
    const serializedDealerDraft = serializeDraftStoragePayload(
      "theme_config",
      unpublishedDealerDraft,
    ).json;

    // Seed `dealer` row with unpublished `draft_json` and `published_json = NULL`
    await tenantDbA
      .prepare(
        `INSERT INTO theme_configs
           (theme_id, tokens_json, variants_json, draft_json, published_json, version, updated_at)
         VALUES ('dealer', ?, ?, ?, NULL, 1, ?)`,
      )
      .bind(
        JSON.stringify(dealerEntry.defaultTokens),
        JSON.stringify(dealerEntry.defaultVariants),
        serializedDealerDraft,
        BASE_NOW_MS + 110_000,
      )
      .run();

    const listRes = await handleTenantThemesListRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
    );
    const state = (await listRes.json()) as ThemeLibraryStateDto;
    const dealerItem = state.themes.find((t) => t.id === "dealer");
    expect(dealerItem?.hasSavedConfig).toBe(false);

    // Activate `dealer`: must publish safe defaults, NEVER the unpublished draft tokens!
    const activateRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        cookie: ownerA.cookie,
        body: {
          themeId: "dealer",
          expectedVersion: state.version,
          confirm: true,
        },
      }),
      runtimeEnv,
    );
    expect(activateRes.status).toBe(200);
    const activated = (await activateRes.json()) as ThemeLibraryActivateResultDto;
    expect(activated.recoveredExistingConfig).toBe(false);

    const publishedDealer = await getPublishedResource(tenantDbA, {
      resourceType: "theme_config",
      resourceId: "dealer",
    });
    const adminDealer = await getDraftResourceForAdmin(tenantDbA, {
      resourceType: "theme_config",
      resourceId: "dealer",
    });

    // Live published config uses safe defaults, NOT unpublished draft `#991b1b` / `22`!
    expect(publishedDealer?.data.tokens.primaryColor).toBe(dealerEntry.defaultTokens.primaryColor);
    expect(publishedDealer?.data.tokens.borderRadiusPx).toBe(
      dealerEntry.defaultTokens.borderRadiusPx,
    );
    // Unpublished draft remains 100% intact!
    expect(adminDealer?.draft?.tokens.primaryColor).toBe("#991b1b");
    expect(adminDealer?.draft?.tokens.borderRadiusPx).toBe(22);
    expect(adminDealer?.draft?.variants.styleVariant).toBe("dark-showroom");
  });

  it("M4: chains changes() = 1 across cache-bump compensation (rolls back cleanly OR aborts safely on interleaved writer)", async () => {
    const restoEntry = getRegisteredTheme("resto")!;
    const compat = evaluateThemeCompatibility(buildThemeCompatibilityCandidate(restoEntry), {
      vertical: "compro",
    });
    const failingPlatformDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error("Simulated PLATFORM_DB outage");
          },
          run: async () => {
            throw new Error("Simulated PLATFORM_DB outage");
          },
        }),
      }),
    } as unknown as D1Database;

    // Sub-case A: Clean rollback when no interleaved writer ran
    const siteBeforeA = await tenantDbA
      .prepare("SELECT active_theme_id, version FROM site_settings WHERE id = 1")
      .first<{ active_theme_id: string; version: number }>();
    const revBeforeA = await tenantDbA
      .prepare("SELECT COUNT(*) AS cnt FROM content_revisions")
      .first<{ cnt: number }>();

    let errA: unknown = null;
    try {
      await activateTenantThemeAtomically({
        platformDb: failingPlatformDb,
        tenantDb: tenantDbA,
        tenantId: TENANT_A.id,
        tenantName: TENANT_A.name,
        actorUserId: ownerA.userId,
        actorRole: "owner",
        targetTheme: {
          id: restoEntry.id,
          name: restoEntry.name,
          defaultTokens: restoEntry.defaultTokens,
          defaultVariants: restoEntry.defaultVariants,
        },
        expectedVersion: siteBeforeA!.version,
        compatibility: compat,
        nowMs: BASE_NOW_MS + 120_000,
      });
    } catch (e) {
      errA = e;
    }

    expect(errA).toBeInstanceOf(PublicationAtomicError);
    expect((errA as PublicationAtomicError).compensated).toBe(true);

    const siteAfterA = await tenantDbA
      .prepare("SELECT active_theme_id, version FROM site_settings WHERE id = 1")
      .first<{ active_theme_id: string; version: number }>();
    const revAfterA = await tenantDbA
      .prepare("SELECT COUNT(*) AS cnt FROM content_revisions")
      .first<{ cnt: number }>();
    expect(siteAfterA).toEqual(siteBeforeA);
    expect(revAfterA?.cnt).toBe(revBeforeA?.cnt);

    // Sub-case B: Interleaved writer bumps site_settings.version before cache bump fails ->
    // compensation MUST abort cleanly (`changes() = 0`) and NOT revert theme_configs out from under it!
    const siteBeforeB = await tenantDbA
      .prepare("SELECT active_theme_id, version FROM site_settings WHERE id = 1")
      .first<{ active_theme_id: string; version: number }>();
    const restoBeforeB = await tenantDbA
      .prepare("SELECT version FROM theme_configs WHERE theme_id = 'resto'")
      .first<{ version: number }>();

    let errB: unknown = null;
    try {
      await activateTenantThemeAtomically({
        platformDb: failingPlatformDb,
        tenantDb: tenantDbA,
        tenantId: TENANT_A.id,
        tenantName: TENANT_A.name,
        actorUserId: ownerA.userId,
        actorRole: "owner",
        targetTheme: {
          id: restoEntry.id,
          name: restoEntry.name,
          defaultTokens: restoEntry.defaultTokens,
          defaultVariants: restoEntry.defaultVariants,
        },
        expectedVersion: siteBeforeB!.version,
        compatibility: compat,
        nowMs: BASE_NOW_MS + 130_000,
        beforeCacheBump: async () => {
          // Simulate an interleaved writer advancing site_settings after our batch committed
          await tenantDbA
            .prepare("UPDATE site_settings SET version = version + 1 WHERE id = 1")
            .run();
        },
      });
    } catch (e) {
      errB = e;
    }

    expect(errB).toBeInstanceOf(PublicationAtomicError);
    expect((errB as PublicationAtomicError).compensated).toBe(false);

    // Interleaved writer's version (+2 total) AND target theme_configs (+1) stay consistent (not half-reverted!)
    const siteAfterB = await tenantDbA
      .prepare("SELECT active_theme_id, version FROM site_settings WHERE id = 1")
      .first<{ active_theme_id: string; version: number }>();
    const restoAfterB = await tenantDbA
      .prepare("SELECT version FROM theme_configs WHERE theme_id = 'resto'")
      .first<{ version: number }>();
    expect(siteAfterB?.version).toBe(siteBeforeB!.version + 2);
    expect(restoAfterB?.version).toBe((restoBeforeB?.version ?? 0) + 1);
  });
});

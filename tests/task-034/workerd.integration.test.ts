import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import type { DraftPreviewApiResponse } from "@punyasitus/core/preview/index";
import {
  PERMENKES_TESTIMONIALS_WARNING_CODE,
  type AnyValidatedPageSection,
} from "@punyasitus/core/theme/index";
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
  getPublishedResource,
  publishResourceAtomically,
  saveDraftResource,
} from "@punyasitus/db/publication/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantPreviewRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/preview/_shared.ts";
import {
  buildHomepageSnapshotFromSections,
  publishThemeCustomizerAtomically,
  saveThemeCustomizerDraft,
  type TenantThemeRuntimeEnv,
  type ThemeCustomizerAdminState,
} from "../../apps/web/src/pages/api/tenants/[tenantId]/theme/_shared.ts";
import { handleTenantThemeRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/theme/index.ts";
import { handleTenantThemePublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/theme/publish.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 1, 0, 0);

const TENANT_A = {
  id: "01JT034TENANTA000000000001",
  orgId: "org_t034_alpha",
  handle: "t034-alpha",
  name: "T034 Alpha Arsitek",
  host: "t034-alpha.situsku.click",
} as const;

const TENANT_B = {
  id: "01JT034TENANTB000000000002",
  orgId: "org_t034_beta",
  handle: "t034-beta",
  name: "T034 Beta Klinik Gigi",
  host: "t034-beta.situsku.click",
} as const;

const TENANT_LOCKED = {
  id: "01JT034TENANTC000000000003",
  orgId: "org_t034_locked",
  handle: "t034-locked",
  name: "T034 Locked Tenant",
  host: "t034-locked.situsku.click",
} as const;

function buildRuntimeEnv(
  overrides: Partial<TenantThemeRuntimeEnv> = {},
): TenantThemeRuntimeEnv {
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
  method: "GET" | "PATCH" | "POST" = "GET",
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
  runtimeEnv: TenantThemeRuntimeEnv,
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

describe("TASK-034: Theme Customizer API & Atomic Publish on workerd", () => {
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

    for (const [spec, status] of [
      [TENANT_A, "active"],
      [TENANT_B, "active"],
      [TENANT_LOCKED, "locked"],
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
          status,
          cacheVersion: 1,
          schemaVersion: 1,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }

    [tenantDbA, tenantDbB, tenantDbLocked] = await Promise.all([
      openMigratedTenantDb(TENANT_A.id),
      openMigratedTenantDb(TENANT_B.id),
      openMigratedTenantDb(TENANT_LOCKED.id),
    ]);

    ownerA = await signUpUser("owner-a@t034.example", "Owner Alpha", runtimeEnv);
    adminA = await signUpUser("admin-a@t034.example", "Admin Alpha", runtimeEnv);
    editorA = await signUpUser("editor-a@t034.example", "Editor Alpha", runtimeEnv);
    ownerB = await signUpUser("owner-b@t034.example", "Owner Beta", runtimeEnv);
    ownerLocked = await signUpUser("owner-locked@t034.example", "Owner Locked", runtimeEnv);

    await pDb
      .insert(members)
      .values([
        {
          id: "mem_t034_owner_a",
          organizationId: TENANT_A.orgId,
          userId: ownerA.userId,
          role: "owner",
          createdAt: now,
        },
        {
          id: "mem_t034_admin_a",
          organizationId: TENANT_A.orgId,
          userId: adminA.userId,
          role: "admin",
          createdAt: now,
        },
        {
          id: "mem_t034_editor_a",
          organizationId: TENANT_A.orgId,
          userId: editorA.userId,
          role: "editor",
          createdAt: now,
        },
        {
          id: "mem_t034_owner_b",
          organizationId: TENANT_B.orgId,
          userId: ownerB.userId,
          role: "owner",
          createdAt: now,
        },
        {
          id: "mem_t034_owner_locked",
          organizationId: TENANT_LOCKED.orgId,
          userId: ownerLocked.userId,
          role: "owner",
          createdAt: now,
        },
      ])
      .onConflictDoNothing();

    // Seed Tenant A initial published theme_config + published homepage
    await tenantDbA
      .prepare(
        `INSERT INTO site_settings (id, site_title, active_theme_id, version, updated_at)
         VALUES (1, 'Alpha Arsitek', 'compro', 1, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();

    await tenantDbA
      .prepare(
        `INSERT INTO business_profile (id, business_name, business_category, version, updated_at)
         VALUES (1, 'PT Alpha Arsitek', 'LocalBusiness', 1, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();

    await tenantDbA
      .prepare(
        `INSERT INTO theme_configs (theme_id, tokens_json, variants_json, draft_json, published_json, version, updated_at)
         VALUES ('compro', '{}', '{}', NULL, NULL, 1, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();

    const initialThemeDraft = {
      themeId: "compro",
      tokens: {
        primaryColor: "#176b51",
        secondaryColor: "#0f4c5c",
        fontFamily: "system",
        borderRadiusPx: 8,
        spacingScale: 1,
        containerMaxWidthPx: 1200,
        sectionPaddingYPx: 64,
        fastestSystemFont: false,
      },
      variants: {
        styleVariant: "default",
        headerVariant: "standard",
        footerVariant: "columns",
        heroVariant: "split",
        buttonStyle: "solid",
      },
    };

    await saveDraftResource(tenantDbA, {
      resourceType: "theme_config",
      resourceId: "compro",
      expectedVersion: 1,
      draft: initialThemeDraft,
      nowMs: BASE_NOW_MS + 100,
    });

    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "theme_config",
      resourceId: "compro",
      expectedVersion: 2,
      actorUserId: ownerA.userId,
      nowMs: BASE_NOW_MS + 200,
    });

    await tenantDbA
      .prepare(
        `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
         VALUES (1, 'beranda', 'Beranda Alpha', 1, '[]', 'draft', 1, ?, ?)`,
      )
      .bind(BASE_NOW_MS, BASE_NOW_MS)
      .run();

    await saveDraftResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_NOW_MS + 300,
      draft: {
        slug: "beranda",
        title: "Beranda Alpha",
        isHomepage: true,
        layoutMode: "standard",
        sections: [
          {
            id: "sec-hero",
            kind: "hero",
            heading: "Hero Publik Alpha",
            subheading: "Sub",
            bodyHtml: null,
          },
          {
            id: "sec-about",
            kind: "about",
            heading: "Tentang Alpha",
            subheading: null,
            bodyHtml: "<p>Profil awal</p>",
          },
          { id: "sec-faq", kind: "faq", heading: "FAQ Alpha", subheading: null, bodyHtml: null },
          {
            id: "sec-contact",
            kind: "contact",
            heading: "Kontak Alpha",
            subheading: null,
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
      nowMs: BASE_NOW_MS + 400,
    });

    // Seed Tenant B as a fresh health/medical clinic with NO theme_configs or pages rows yet
    await tenantDbB
      .prepare(
        `INSERT INTO business_profile (id, business_name, business_category, version, updated_at)
         VALUES (1, 'Klinik Gigi Beta', 'Klinik Gigi', 1, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();

    // Seed Tenant Locked
    await tenantDbLocked
      .prepare(
        `INSERT INTO business_profile (id, business_name, business_category, version, updated_at)
         VALUES (1, 'Locked Corp', 'LocalBusiness', 1, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();
  });

  it("returns Permenkes health-category flag & default-OFF testimonials, and leaves ZERO stray rows on stale first-time draft save", async () => {
    const res = await handleTenantThemeRequest(
      TENANT_B.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/theme`, "GET", {
        cookie: ownerB.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1000 },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const data = (await res.json()) as ThemeCustomizerAdminState;
    expect(data.isHealthCategory).toBe(true);
    expect(data.version).toBe(0);
    expect(data.availableThemes).toHaveLength(6);
    expect(data.permenkesWarnings.some((w) => w.code === PERMENKES_TESTIMONIALS_WARNING_CODE)).toBe(
      true,
    );
    const testimonialSec = data.draft.sections.find((s) => s.type === "testimonials");
    expect(testimonialSec).toBeDefined();
    expect(testimonialSec?.enabled).toBe(false);

    // Stale first-time draft save (expectedVersion: 5 when actual is 0) -> 409 STALE_VERSION & ZERO stray rows!
    const staleFirstSave = await handleTenantThemeRequest(
      TENANT_B.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/theme`, "PATCH", {
        cookie: ownerB.cookie,
        body: {
          expectedVersion: 5,
          tokens: { primaryColor: "#0f4c81" },
          sections: data.draft.sections,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1100 },
    );
    expect(staleFirstSave.status).toBe(409);

    const themeRowCount = await tenantDbB
      .prepare("SELECT COUNT(*) AS cnt FROM theme_configs")
      .first<{ readonly cnt: number }>();
    const pageRowCount = await tenantDbB
      .prepare("SELECT COUNT(*) AS cnt FROM pages")
      .first<{ readonly cnt: number }>();
    expect(themeRowCount?.cnt).toBe(0);
    expect(pageRowCount?.cnt).toBe(0);
  });

  it("saves draft tokens & sections atomically without touching published snapshot, reflects in preview, then publishes in ONE batch bumping cache_version ONCE", async () => {
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const [tenantBefore] = await pDb
      .select({ cacheVersion: tenants.cacheVersion })
      .from(tenants)
      .where(eq(tenants.id, TENANT_A.id));
    const initialCacheVersion = tenantBefore?.cacheVersion ?? 1;

    // 1. GET initial state
    const getRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2000 },
    );
    expect(getRes.status).toBe(200);
    const initial = (await getRes.json()) as ThemeCustomizerAdminState;
    expect(initial.draft.tokens.primaryColor).toBe("#176b51");
    expect(initial.published?.tokens.primaryColor).toBe("#176b51");
    expect(initial.isHealthCategory).toBe(false);

    // Reorder sections: move `sec-faq` before `sec-about`, and toggle `sec-about` OFF!
    const reorderedSections: AnyValidatedPageSection[] = [
      initial.draft.sections[0]!, // sec-hero
      { ...initial.draft.sections[2]!, order: 1 }, // sec-faq
      { ...initial.draft.sections[1]!, enabled: false, order: 2 }, // sec-about (hidden!)
      { ...initial.draft.sections[3]!, order: 3 }, // sec-contact
    ];

    // 2. PATCH strictly to DRAFT (single atomic batch)
    const patchRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: ownerA.cookie,
        body: {
          expectedVersion: initial.version,
          expectedVersions: initial.versions,
          tokens: {
            primaryColor: "#1e40af",
            secondaryColor: "#0f766e",
            borderRadiusPx: 14,
            fontFamily: "inter",
          },
          sections: reorderedSections,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3000 },
    );
    expect(patchRes.status).toBe(200);
    expect(patchRes.headers.get("Cache-Control")).toBe("private, no-store");

    const saved = (await patchRes.json()) as ThemeCustomizerAdminState;
    expect(saved.version).toBe(initial.version + 2);
    expect(saved.versions.themeConfig).toBe(initial.versions.themeConfig + 1);
    expect(saved.versions.homepage).toBe(initial.versions.homepage + 1);
    expect(saved.hasUnpublishedChanges).toBe(true);
    expect(saved.draft.tokens.primaryColor).toBe("#1e40af");
    expect(saved.draft.tokens.borderRadiusPx).toBe(14);
    expect(saved.draft.sections.map((s) => `${s.id}:${s.enabled}`)).toEqual([
      "sec-hero:true",
      "sec-faq:true",
      "sec-about:false",
      "sec-contact:true",
    ]);

    // Published snapshots & cache_version MUST remain 100% untouched after draft save!
    const pubThemeBefore = await getPublishedResource(tenantDbA, {
      resourceType: "theme_config",
      resourceId: "compro",
    });
    expect(pubThemeBefore?.data.tokens.primaryColor).toBe("#176b51");
    expect(pubThemeBefore?.data.tokens.borderRadiusPx).toBe(8);

    const pubPageBefore = await getPublishedResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
    });
    expect(pubPageBefore?.data.sections.map((s) => s.id)).toEqual([
      "sec-hero",
      "sec-about",
      "sec-faq",
      "sec-contact",
    ]);

    const [tenantAfterDraft] = await pDb
      .select({ cacheVersion: tenants.cacheVersion })
      .from(tenants)
      .where(eq(tenants.id, TENANT_A.id));
    expect(tenantAfterDraft?.cacheVersion).toBe(initialCacheVersion);

    // 3. Preview endpoint reflects draft tokens & reordered/enabled sections in inert HTML
    const previewRes = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: ownerA.cookie,
        body: {
          resourceKind: "home",
          themeId: saved.themeId,
          draftOverride: {
            themeConfig: {
              themeId: saved.themeId,
              tokens: saved.draft.tokens,
              variants: saved.draft.variants,
            },
            page: buildHomepageSnapshotFromSections(saved.draft.sections, {
              slug: saved.homepageSlug,
              title: saved.homepageTitle,
            }),
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3500 },
    );
    expect(previewRes.status).toBe(200);
    const previewData = (await previewRes.json()) as DraftPreviewApiResponse;
    expect(previewData.html).toContain("--ps-brand-primary: #1e40af");
    expect(previewData.html).toContain('data-section-id="sec-faq"');
    expect(previewData.html).not.toContain('data-section-id="sec-about"');

    // 4. Simulate stale homepage version while theme_configs matches (and vice versa) during POST /publish:
    //    MUST fail 409 STALE_VERSION with ZERO mutation to theme_configs, ZERO to pages, ZERO cache_version bump!
    const staleHomepagePublish = await handleTenantThemePublishRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme/publish`, "POST", {
        cookie: ownerA.cookie,
        body: {
          expectedVersion: saved.version,
          expectedVersions: {
            themeConfig: saved.versions.themeConfig, // matches!
            homepage: saved.versions.homepage - 1, // stale!
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3700 },
    );
    expect(staleHomepagePublish.status).toBe(409);

    const staleThemePublish = await handleTenantThemePublishRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme/publish`, "POST", {
        cookie: ownerA.cookie,
        body: {
          expectedVersion: saved.version,
          expectedVersions: {
            themeConfig: saved.versions.themeConfig - 1, // stale!
            homepage: saved.versions.homepage, // matches!
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3800 },
    );
    expect(staleThemePublish.status).toBe(409);

    // Confirm ZERO mutation to theme_configs, ZERO mutation to pages, and ZERO cache_version bump!
    const pubThemeAfterStale = await getPublishedResource(tenantDbA, {
      resourceType: "theme_config",
      resourceId: "compro",
    });
    expect(pubThemeAfterStale?.data.tokens.primaryColor).toBe("#176b51");
    expect(pubThemeAfterStale?.version).toBe(saved.versions.themeConfig);

    const pubPageAfterStale = await getPublishedResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
    });
    expect(pubPageAfterStale?.version).toBe(saved.versions.homepage);

    const [tenantAfterStale] = await pDb
      .select({ cacheVersion: tenants.cacheVersion })
      .from(tenants)
      .where(eq(tenants.id, TENANT_A.id));
    expect(tenantAfterStale?.cacheVersion).toBe(initialCacheVersion);

    // 5. Atomic single-batch publish bumps tenants.cache_version EXACTLY ONCE (+1) and swaps BOTH published snapshots
    const publishRes = await handleTenantThemePublishRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme/publish`, "POST", {
        cookie: ownerA.cookie,
        body: {
          expectedVersion: saved.version,
          expectedVersions: saved.versions,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4000 },
    );
    expect(publishRes.status).toBe(200);
    expect(publishRes.headers.get("Cache-Control")).toBe("private, no-store");
    const publishedPayload = (await publishRes.json()) as ThemeCustomizerAdminState & {
      readonly cacheVersion: number;
    };
    expect(publishedPayload.cacheVersion).toBe(initialCacheVersion + 1);
    expect(publishedPayload.published?.tokens.primaryColor).toBe("#1e40af");
    expect(publishedPayload.published?.tokens.borderRadiusPx).toBe(14);
    expect(publishedPayload.published?.sections.map((s) => s.id)).toEqual([
      "sec-hero",
      "sec-faq",
      "sec-contact",
    ]);
    // Disabled `sec-about` stays preserved in draft for future re-enable!
    expect(publishedPayload.draft.sections.find((s) => s.id === "sec-about")?.enabled).toBe(false);

    // Verify published DB snapshots + single PLATFORM_DB.tenants.cache_version bump
    const pubThemeAfter = await getPublishedResource(tenantDbA, {
      resourceType: "theme_config",
      resourceId: "compro",
    });
    expect(pubThemeAfter?.data.tokens.primaryColor).toBe("#1e40af");

    const pubPageAfter = await getPublishedResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
    });
    expect(pubPageAfter?.data.sections.map((s) => s.id)).toEqual([
      "sec-hero",
      "sec-faq",
      "sec-contact",
    ]);

    const [tenantAfterPublish] = await pDb
      .select({ cacheVersion: tenants.cacheVersion })
      .from(tenants)
      .where(eq(tenants.id, TENANT_A.id));
    expect(tenantAfterPublish?.cacheVersion).toBe(initialCacheVersion + 1);
  });

  it("clears headingFontFamily cleanly via null (REQ-020) and never clobbers external homepage draft edits", async () => {
    const getRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4500 },
    );
    const before = (await getRes.json()) as ThemeCustomizerAdminState;

    // 1. Set headingFontFamily = "lora" with body fontFamily = "system"
    const setHeadingRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: ownerA.cookie,
        body: {
          expectedVersion: before.version,
          tokens: { fontFamily: "system", headingFontFamily: "lora" },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4600 },
    );
    expect(setHeadingRes.status).toBe(200);
    const withLora = (await setHeadingRes.json()) as ThemeCustomizerAdminState;
    expect(withLora.draft.tokens.headingFontFamily).toBe("lora");

    // 2. Switch body fontFamily to "inter" while clearing headingFontFamily: null -> 200 OK!
    const clearHeadingRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: ownerA.cookie,
        body: {
          expectedVersion: withLora.version,
          tokens: { fontFamily: "inter", headingFontFamily: null },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4700 },
    );
    expect(clearHeadingRes.status).toBe(200);
    const withInterOnly = (await clearHeadingRes.json()) as ThemeCustomizerAdminState;
    expect(withInterOnly.draft.tokens.fontFamily).toBe("inter");
    expect(withInterOnly.draft.tokens.headingFontFamily).toBeUndefined();

    // 3. Simulate an external page editor updating the homepage draft directly (bumping pages.version)
    await saveDraftResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
      expectedVersion: withInterOnly.versions.homepage,
      nowMs: BASE_NOW_MS + 4800,
      draft: {
        slug: "beranda",
        title: "Beranda Diubah Editor Halaman",
        isHomepage: true,
        layoutMode: "standard",
        sections: [
          {
            id: "sec-hero",
            kind: "hero",
            heading: "Headline Baru dari Editor Halaman",
            subheading: null,
            bodyHtml: null,
          },
          {
            id: "sec-contact",
            kind: "contact",
            heading: "Kontak Baru",
            subheading: null,
            bodyHtml: null,
          },
        ],
      },
    });

    // Reloading Theme Customizer MUST reflect the external homepage edit instead of stale metadata!
    const reloadRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4900 },
    );
    expect(reloadRes.status).toBe(200);
    const reloaded = (await reloadRes.json()) as ThemeCustomizerAdminState;
    expect(reloaded.draft.sections.map((s) => s.id)).toEqual(["sec-hero", "sec-contact"]);
    expect((reloaded.draft.sections[0]?.config as { heading?: string }).heading).toBe(
      "Headline Baru dari Editor Halaman",
    );
  });

  it("requires expectedVersion on PATCH and POST /publish (422) and rejects malformed CSS tokens, unknown sections, duplicate hero, forbidden selectors & unknown fields", async () => {
    const getRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "GET", {
        cookie: adminA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );
    const current = (await getRes.json()) as ThemeCustomizerAdminState;

    // 0a. Missing expectedVersion on PATCH -> 422 VALIDATION_ERROR (REQUIRED)
    const missingVerPatch = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: adminA.cookie,
        body: { tokens: { primaryColor: "#176b51" } },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5050 },
    );
    expect(missingVerPatch.status).toBe(422);
    const missingPatchBody = (await missingVerPatch.json()) as {
      error: { fields?: Array<{ field: string; code: string }> };
    };
    expect(
      missingPatchBody.error.fields?.some(
        (f) => f.field === "expectedVersion" && f.code === "REQUIRED",
      ),
    ).toBe(true);

    // 0b. Missing expectedVersion on POST /publish -> 422 VALIDATION_ERROR (REQUIRED)
    const missingVerPublish = await handleTenantThemePublishRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme/publish`, "POST", {
        cookie: adminA.cookie,
        body: {},
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5080 },
    );
    expect(missingVerPublish.status).toBe(422);

    // 1. Malformed / XSS CSS token
    const badCssRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: adminA.cookie,
        body: {
          expectedVersion: current.version,
          tokens: { primaryColor: "#111; } </style><script>alert(1)</script>" },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5100 },
    );
    expect(badCssRes.status).toBe(422);

    // 2. Unknown section type
    const unknownSecRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: adminA.cookie,
        body: {
          expectedVersion: current.version,
          sections: [
            {
              id: "sec-bad",
              type: "custom_xss_widget",
              schemaVersion: 1,
              enabled: true,
              config: {},
            },
          ],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5200 },
    );
    expect(unknownSecRes.status).toBe(422);
    const unknownSecBody = (await unknownSecRes.json()) as {
      error: { fields?: Array<{ code: string }> };
    };
    expect(unknownSecBody.error.fields?.some((f) => f.code === "UNKNOWN_SECTION_TYPE")).toBe(true);

    // 3. Duplicate singleton hero
    const dupHeroRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: adminA.cookie,
        body: {
          expectedVersion: current.version,
          sections: [
            {
              id: "hero-1",
              type: "hero",
              schemaVersion: 1,
              enabled: true,
              config: { heading: "Satu" },
            },
            {
              id: "hero-2",
              type: "hero",
              schemaVersion: 1,
              enabled: true,
              config: { heading: "Dua" },
            },
          ],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5300 },
    );
    expect(dupHeroRes.status).toBe(422);
    const dupHeroBody = (await dupHeroRes.json()) as {
      error: { fields?: Array<{ code: string }> };
    };
    expect(dupHeroBody.error.fields?.some((f) => f.code === "DUPLICATE_SINGLETON_SECTION")).toBe(
      true,
    );

    // 4. Forbidden tenant selector
    const forbiddenSelectorRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: adminA.cookie,
        body: {
          tenantId: TENANT_B.id,
          expectedVersion: current.version,
          tokens: { primaryColor: "#176b51" },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5400 },
    );
    expect(forbiddenSelectorRes.status).toBe(422);

    // 5. Unknown top-level field
    const unknownFieldRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: adminA.cookie,
        body: {
          expectedVersion: current.version,
          arbitraryInjectedKey: "boom",
          tokens: { primaryColor: "#176b51" },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5500 },
    );
    expect(unknownFieldRes.status).toBe(422);
  });

  it("enforces stale expectedVersion (409), RBAC (editor 403, admin 200), cross-tenant isolation (404), locked tenant (403 SUBSCRIPTION_LOCKED), host isolation & CSRF", async () => {
    const getRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6000 },
    );
    const current = (await getRes.json()) as ThemeCustomizerAdminState;

    // 1. Stale version on PATCH -> 409 STALE_VERSION
    const stalePatch = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: ownerA.cookie,
        body: {
          expectedVersion: Math.max(0, current.version - 1),
          tokens: { primaryColor: "#0f5c5c" },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6100 },
    );
    expect(stalePatch.status).toBe(409);
    expect(((await stalePatch.json()) as { error: { code: string } }).error.code).toBe(
      "STALE_VERSION",
    );

    // 2. Stale version on POST /publish -> 409 STALE_VERSION
    const stalePublish = await handleTenantThemePublishRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme/publish`, "POST", {
        cookie: ownerA.cookie,
        body: { expectedVersion: Math.max(0, current.version - 1) },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6200 },
    );
    expect(stalePublish.status).toBe(409);
    expect(((await stalePublish.json()) as { error: { code: string } }).error.code).toBe(
      "STALE_VERSION",
    );

    // 3. Editor gets 403 FORBIDDEN on PATCH & POST /publish
    const editorPatch = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: editorA.cookie,
        body: { expectedVersion: current.version, tokens: { primaryColor: "#0f5c5c" } },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6300 },
    );
    expect(editorPatch.status).toBe(403);
    expect(((await editorPatch.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");

    const editorPublish = await handleTenantThemePublishRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme/publish`, "POST", {
        cookie: editorA.cookie,
        body: { expectedVersion: current.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6350 },
    );
    expect(editorPublish.status).toBe(403);

    // 4. Admin IS permitted on PATCH (200)
    const adminPatch = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: adminA.cookie,
        body: { expectedVersion: current.version, tokens: { borderRadiusPx: 10 } },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6400 },
    );
    expect(adminPatch.status).toBe(200);

    // 5. Cross-tenant Owner B targeting Tenant A -> neutral 404
    const crossGet = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "GET", {
        cookie: ownerB.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6500 },
    );
    expect(crossGet.status).toBe(404);

    const crossPatch = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: ownerB.cookie,
        body: { expectedVersion: 1, tokens: { primaryColor: "#176b51" } },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6550 },
    );
    expect(crossPatch.status).toBe(404);

    // 6. Locked tenant: GET allowed read-only (200), PATCH & POST /publish blocked (403 SUBSCRIPTION_LOCKED)
    const lockedGet = await handleTenantThemeRequest(
      TENANT_LOCKED.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_LOCKED.handle}/theme`, "GET", {
        cookie: ownerLocked.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6600 },
    );
    expect(lockedGet.status).toBe(200);
    const lockedState = (await lockedGet.json()) as ThemeCustomizerAdminState;
    expect(lockedState.permissions.isLocked).toBe(true);
    expect(lockedState.permissions.canEdit).toBe(false);

    const lockedPatch = await handleTenantThemeRequest(
      TENANT_LOCKED.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_LOCKED.handle}/theme`, "PATCH", {
        cookie: ownerLocked.cookie,
        body: { expectedVersion: lockedState.version, tokens: { primaryColor: "#176b51" } },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6650 },
    );
    expect(lockedPatch.status).toBe(403);
    expect(((await lockedPatch.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );

    const lockedPublish = await handleTenantThemePublishRequest(
      TENANT_LOCKED.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_LOCKED.handle}/theme/publish`, "POST", {
        cookie: ownerLocked.cookie,
        body: { expectedVersion: lockedState.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6680 },
    );
    expect(lockedPublish.status).toBe(403);
    expect(((await lockedPublish.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );

    // 7. Wrong host (tenant host & console host) -> neutral 404
    const tenantHostRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`https://${TENANT_A.host}/api/tenants/${TENANT_A.handle}/theme`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6700 },
    );
    expect(tenantHostRes.status).toBe(404);

    const consoleHostRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${CONSOLE_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6720 },
    );
    expect(consoleHostRes.status).toBe(404);

    // 8. CSRF Origin mismatch -> 403
    const badOriginRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "PATCH", {
        cookie: ownerA.cookie,
        origin: `https://${TENANT_A.host}`,
        body: { expectedVersion: current.version, tokens: { primaryColor: "#176b51" } },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6750 },
    );
    expect(badOriginRes.status).toBe(403);

    // 9. Unauthenticated -> 401
    const unauthRes = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "GET"),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6800 },
    );
    expect(unauthRes.status).toBe(401);
  });

  it("blocks one-version interleaving race (concurrent N -> N+1 theme_configs bump before batch) with 409 and ZERO homepage mutation on both draft save and publish", async () => {
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const memberScope = {
      tenantId: TENANT_A.id,
      tenantName: TENANT_A.name,
      userId: ownerA.userId,
      role: "owner" as const,
      tenantStatus: "active" as const,
    };

    // Helper: creates a D1Database proxy that simulates another concurrent writer bumping
    // `theme_configs.version` from N -> N+1 right before `.batch(...)` runs!
    const createRacingTenantDb = (baseDb: D1Database): D1Database => {
      let racedOnce = false;
      return new Proxy(baseDb, {
        get(target, prop, receiver) {
          if (prop === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!racedOnce) {
                racedOnce = true;
                await baseDb
                  .prepare(
                    "UPDATE theme_configs SET version = version + 1, updated_at = updated_at + 1 WHERE theme_id = 'compro'",
                  )
                  .run();
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    // --- Case 1: Interleaving N -> N+1 race during draft save ---
    const getBeforeDraft = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7000 },
    );
    const stateBeforeDraft = (await getBeforeDraft.json()) as ThemeCustomizerAdminState;
    const pageRowBeforeDraft = await tenantDbA
      .prepare("SELECT version, draft_sections_json, published_sections_json FROM pages WHERE id = 1")
      .first<{
        readonly version: number;
        readonly draft_sections_json: string;
        readonly published_sections_json: string | null;
      }>();

    await expect(
      saveThemeCustomizerDraft(createRacingTenantDb(tenantDbA), memberScope, {
        expectedVersion: stateBeforeDraft.version,
        expectedVersions: stateBeforeDraft.versions,
        tokens: { primaryColor: "#0f4c81" },
        sections: [
          {
            id: "sec-hero",
            type: "hero",
            schemaVersion: 1,
            enabled: true,
            order: 0,
            config: { heading: "MUST NOT WRITE ON RACE", highlights: [] },
          },
        ],
        nowMs: BASE_NOW_MS + 7100,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: "STALE_VERSION" });

    const pageRowAfterDraftRace = await tenantDbA
      .prepare("SELECT version, draft_sections_json, published_sections_json FROM pages WHERE id = 1")
      .first<{
        readonly version: number;
        readonly draft_sections_json: string;
        readonly published_sections_json: string | null;
      }>();
    expect(pageRowAfterDraftRace).toEqual(pageRowBeforeDraft);

    // --- Case 2: Interleaving N -> N+1 race during atomic publish ---
    const getBeforePublish = await handleTenantThemeRequest(
      TENANT_A.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/theme`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7200 },
    );
    const stateBeforePublish = (await getBeforePublish.json()) as ThemeCustomizerAdminState;
    const pageRowBeforePublish = await tenantDbA
      .prepare("SELECT version, draft_sections_json, published_sections_json FROM pages WHERE id = 1")
      .first<{
        readonly version: number;
        readonly draft_sections_json: string;
        readonly published_sections_json: string | null;
      }>();
    const [tenantBeforePublishRace] = await pDb
      .select({ cacheVersion: tenants.cacheVersion })
      .from(tenants)
      .where(eq(tenants.id, TENANT_A.id));

    await expect(
      publishThemeCustomizerAtomically(
        env.PLATFORM_DB,
        createRacingTenantDb(tenantDbA),
        memberScope,
        {
          expectedVersion: stateBeforePublish.version,
          expectedVersions: stateBeforePublish.versions,
          nowMs: BASE_NOW_MS + 7300,
        },
      ),
    ).rejects.toMatchObject({ httpStatus: 409, code: "STALE_VERSION" });

    const pageRowAfterPublishRace = await tenantDbA
      .prepare("SELECT version, draft_sections_json, published_sections_json FROM pages WHERE id = 1")
      .first<{
        readonly version: number;
        readonly draft_sections_json: string;
        readonly published_sections_json: string | null;
      }>();
    expect(pageRowAfterPublishRace).toEqual(pageRowBeforePublish);

    const [tenantAfterPublishRace] = await pDb
      .select({ cacheVersion: tenants.cacheVersion })
      .from(tenants)
      .where(eq(tenants.id, TENANT_A.id));
    expect(tenantAfterPublishRace?.cacheVersion).toBe(tenantBeforePublishRace?.cacheVersion);
  });
});

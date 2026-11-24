import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import { extractServiceConsultationFromSnapshotJson } from "@punyasitus/core/catalog/service";
import { extractTravelPackageFromSnapshotJson } from "@punyasitus/core/catalog/travel";
import {
  buildPublishedSnapshot,
  extractDraftSnapshotForAdmin,
  PublicationAtomicError,
  serializeDraftStoragePayload,
} from "@punyasitus/core/content/index";
import { PREVIEW_API_CSP_HEADER, PREVIEW_IFRAME_SANDBOX } from "@punyasitus/core/preview/index";
import {
  applyPlatformMigrations,
  applyTenantMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { createOutlet, listOutletsForAdmin, listPublishedOutletsForPublic } from "@punyasitus/db/outlets/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import {
  applyVerticalStarterPresetAtomically,
  publishVerticalStarterPresetSectionsAtomically,
  TENANT_0012_STARTER_PRESETS_MIGRATION,
  type ApplyVerticalStarterPresetResult,
  type VerticalPresetDashboardStateDto,
} from "@punyasitus/db/presets/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import {
  handleDashboardOnboardingApiRequest,
  type DashboardOnboardingRuntimeEnv,
} from "../../apps/web/src/pages/dashboard/[handle]/onboarding/_api-handler.ts";
import { loadVerticalOnboardingPageOrGateResponse } from "../../apps/web/src/pages/dashboard/[handle]/onboarding/_page-gate.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 24, 6, 0, 0);

const TENANT_SERVICES = {
  id: "01JT066SERVICES00000000001",
  orgId: "org_t066_services",
  handle: "t066-services",
  name: "Kantor Konsultan Bintang",
} as const;

const TENANT_TRAVEL = {
  id: "01JT066TRAVEL0000000000002",
  orgId: "org_t066_travel",
  handle: "t066-travel",
  name: "PT Jelajah Nusantara",
} as const;

const TENANT_OUTLETS = {
  id: "01JT066OUTLETS000000000003",
  orgId: "org_t066_outlets",
  handle: "t066-outlets",
  name: "Kedai Kopi Nusantara",
} as const;

const TENANT_POPULATED = {
  id: "01JT066POPULATED0000000004",
  orgId: "org_t066_populated",
  handle: "t066-populated",
  name: "CV Sinar Abadi",
} as const;

const TENANT_LOCKED = {
  id: "01JT066LOCKED0000000000005",
  orgId: "org_t066_locked",
  handle: "t066-locked",
  name: "PT Terkunci Mandiri",
} as const;

function buildRuntimeEnv(
  overrides: Partial<DashboardOnboardingRuntimeEnv> = {},
): DashboardOnboardingRuntimeEnv {
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
  if (options.cookie) headers.set("Cookie", options.cookie);
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
  runtimeEnv: DashboardOnboardingRuntimeEnv,
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

describe("TASK-066 Integration: M2 Vertical Starter Presets on workerd + D1 + TenantStore", () => {
  let tenantDbServices: D1Database;
  let tenantDbTravel: D1Database;
  let tenantDbOutlets: D1Database;
  let tenantDbPopulated: D1Database;
  let tenantDbLocked: D1Database;

  let ownerServices: { readonly userId: string; readonly cookie: string };
  let editorServices: { readonly userId: string; readonly cookie: string };
  let ownerTravel: { readonly userId: string; readonly cookie: string };
  let ownerOutlets: { readonly userId: string; readonly cookie: string };
  let ownerPopulated: { readonly userId: string; readonly cookie: string };
  let ownerLocked: { readonly userId: string; readonly cookie: string };

  const runtimeEnv = buildRuntimeEnv();

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);

    for (const [spec, status, vertical] of [
      [TENANT_SERVICES, "active", "sales"],
      [TENANT_TRAVEL, "active", "travel"],
      [TENANT_OUTLETS, "active", "resto"],
      [TENANT_POPULATED, "active", "compro"],
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

    ownerServices = await signUpUser("owner.svc@t066.example", "Owner Services", runtimeEnv);
    editorServices = await signUpUser("editor.svc@t066.example", "Editor Services", runtimeEnv);
    ownerTravel = await signUpUser("owner.trv@t066.example", "Owner Travel", runtimeEnv);
    ownerOutlets = await signUpUser("owner.out@t066.example", "Owner Outlets", runtimeEnv);
    ownerPopulated = await signUpUser("owner.pop@t066.example", "Owner Populated", runtimeEnv);
    ownerLocked = await signUpUser("owner.lck@t066.example", "Owner Locked", runtimeEnv);

    await pDb
      .insert(members)
      .values([
        { id: "mem_t066_svc_o", organizationId: TENANT_SERVICES.orgId, userId: ownerServices.userId, role: "owner", createdAt: now },
        { id: "mem_t066_svc_e", organizationId: TENANT_SERVICES.orgId, userId: editorServices.userId, role: "editor", createdAt: now },
        { id: "mem_t066_trv_o", organizationId: TENANT_TRAVEL.orgId, userId: ownerTravel.userId, role: "owner", createdAt: now },
        { id: "mem_t066_out_o", organizationId: TENANT_OUTLETS.orgId, userId: ownerOutlets.userId, role: "owner", createdAt: now },
        { id: "mem_t066_pop_o", organizationId: TENANT_POPULATED.orgId, userId: ownerPopulated.userId, role: "owner", createdAt: now },
        { id: "mem_t066_lck_o", organizationId: TENANT_LOCKED.orgId, userId: ownerLocked.userId, role: "owner", createdAt: now },
      ])
      .onConflictDoNothing();

    tenantDbServices = await openMigratedTenantDb(TENANT_SERVICES.id);
    tenantDbTravel = await openMigratedTenantDb(TENANT_TRAVEL.id);
    tenantDbOutlets = await openMigratedTenantDb(TENANT_OUTLETS.id);
    tenantDbPopulated = await openMigratedTenantDb(TENANT_POPULATED.id);
    tenantDbLocked = await openMigratedTenantDb(TENANT_LOCKED.id);

    for (const [db, spec, category] of [
      [tenantDbServices, TENANT_SERVICES, "LocalBusiness"],
      [tenantDbTravel, TENANT_TRAVEL, "TravelAgency"],
      [tenantDbOutlets, TENANT_OUTLETS, "LocalBusiness"],
      [tenantDbPopulated, TENANT_POPULATED, "LocalBusiness"],
      [tenantDbLocked, TENANT_LOCKED, "LocalBusiness"],
    ] as const) {
      await db.batch([
        db
          .prepare(
            `INSERT OR REPLACE INTO site_settings
               (id, site_title, tagline, timezone, locale, active_theme_id, version, updated_at)
             VALUES (1, ?, 'Situs usaha resmi', 'Asia/Jakarta', 'id-ID', 'compro', 1, ?)`,
          )
          .bind(spec.name, BASE_NOW_MS),
        db
          .prepare(
            `INSERT OR REPLACE INTO business_profile
               (id, business_name, business_category, version, updated_at)
             VALUES (1, ?, ?, 1, ?)`,
          )
          .bind(spec.name, category, BASE_NOW_MS),
      ]);
    }

    // Seed TENANT_POPULATED with existing published homepage (including custom draft metadata!), offering, and published outlet!
    const existingHomeSnap = {
      slug: "beranda",
      title: "Beranda Lama CV Sinar Abadi",
      isHomepage: true,
      layoutMode: "standard" as const,
      sections: [
        {
          id: "existing-live-hero",
          kind: "hero" as const,
          heading: "CV Sinar Abadi — Beranda Resmi Lama",
          subheading: "Konten lama yang tidak boleh pernah hilang atau tertimpa.",
          bodyHtml: null,
        },
      ],
    };
    const existingTenantDraftSectionsMeta = JSON.stringify({
      schemaVersion: 1,
      sourceVersion: 2,
      sections: [
        {
          id: "tenant-custom-about",
          type: "about",
          schemaVersion: 1,
          enabled: true,
          order: 0,
          config: {
            eyebrow: "Profil Lama",
            heading: "Sejarah CV Sinar Abadi",
            subheading: "Draf internal milik tenant yang wajib terjaga.",
            bodyHtml: "<p>Draft catatan internal CV Sinar Abadi.</p>",
            milestones: [],
          },
        },
      ],
    });
    const homeDraftJson = serializeDraftStoragePayload("page", {
      ...existingHomeSnap,
      draftSectionsJson: existingTenantDraftSectionsMeta,
      draftNotes: "keep-me-intact",
    }).json;
    const homePubJson = JSON.stringify(
      buildPublishedSnapshot("page", existingHomeSnap, {
        publishedAt: BASE_NOW_MS - 10_000,
        contentModifiedAt: BASE_NOW_MS - 10_000,
      }),
    );

    await tenantDbPopulated.batch([
      tenantDbPopulated
        .prepare(
          `INSERT INTO pages
             (id, slug, title, is_homepage, draft_sections_json, published_sections_json, status, published_at, content_modified_at, version, created_at, updated_at)
           VALUES (1, 'beranda', 'Beranda Lama CV Sinar Abadi', 1, ?, ?, 'published', ?, ?, 2, ?, ?)`,
        )
        .bind(homeDraftJson, homePubJson, BASE_NOW_MS - 10_000, BASE_NOW_MS - 10_000, BASE_NOW_MS - 20_000, BASE_NOW_MS - 10_000),
      tenantDbPopulated
        .prepare(
          `INSERT INTO offerings
             (id, offering_type, slug, title, summary, price_mode, cta_mode, status, version, created_at, updated_at)
           VALUES (1, 'service', 'layanan-lama-resmi', 'Layanan Lama Resmi', 'Penawaran publik existing.', 'on_request', 'whatsapp', 'published', 1, ?, ?)`,
        )
        .bind(BASE_NOW_MS - 15_000, BASE_NOW_MS - 15_000),
      tenantDbPopulated
        .prepare("INSERT OR REPLACE INTO sequences (kind, next) VALUES ('page', 1), ('offering', 1)"),
    ]);

    await createOutlet(
      tenantDbPopulated,
      {
        name: "Gerai Pusat Lama",
        slug: "gerai-pusat-lama",
        address: "Jl. Asia Afrika No. 88, Bandung",
        status: "published",
        active: true,
        isPrimary: true,
      },
      { actorUserId: ownerPopulated.userId, actorRole: "owner", nowMs: BASE_NOW_MS - 15_000 },
    );
  });

  it("provisions professional_services preset as strictly DRAFT-ONLY using TASK-035 schema and is 100% idempotent on retry", async () => {
    const cacheBefore = await getTenantCacheVersion(TENANT_SERVICES.id);

    const res1 = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "POST", {
        cookie: ownerServices.cookie,
        body: {
          action: "apply",
          presetId: "professional_services",
          setupKey: "setup-svc-001",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1000 },
    );
    expect(res1.status).toBe(200);
    const applied = (await res1.json()) as ApplyVerticalStarterPresetResult;
    expect(applied.presetId).toBe("professional_services");
    expect(applied.alreadyApplied).toBe(false);
    expect(applied.idempotentReplay).toBe(false);
    expect(applied.createdHomepageDraft).toBe(true);
    expect(applied.createdPageSlugs).toContain("konsultasi-layanan");
    expect(applied.createdOfferingSlugs).toEqual(["contoh-layanan-konsultasi"]);
    expect(applied.createdOutletSlugs).toEqual([]);
    expect(applied.state.setup?.status).toBe("draft");
    expect(applied.state.checklist.items.map((i) => i.id)).toContain("services_pricing_tiers");

    // Verify draft header menu keeps `items_json = '[]'` and `published_items_json IS NULL` (MEDIUM-9)
    const headerMenuRow = await tenantDbServices
      .prepare("SELECT items_json, draft_items_json, published_items_json FROM menus WHERE location = 'header' LIMIT 1")
      .first<{
        readonly items_json: string;
        readonly draft_items_json: string | null;
        readonly published_items_json: string | null;
      }>();
    expect(headerMenuRow?.items_json).toBe("[]");
    expect(headerMenuRow?.published_items_json).toBeNull();
    expect(headerMenuRow?.draft_items_json).toContain("/layanan");

    // Verify ZERO published rows & ZERO cache_version bump
    expect(await getTenantCacheVersion(TENANT_SERVICES.id)).toBe(cacheBefore);

    const pages = await tenantDbServices
      .prepare("SELECT slug, status, published_sections_json, published_at FROM pages WHERE deleted_at IS NULL")
      .all<{ readonly slug: string; readonly status: string; readonly published_sections_json: string | null; readonly published_at: number | null }>();
    expect(pages.results.length).toBe(2);
    for (const p of pages.results) {
      expect(p.status).toBe("draft");
      expect(p.published_sections_json).toBeNull();
      expect(p.published_at).toBeNull();
    }

    const offering = await tenantDbServices
      .prepare("SELECT offering_type, slug, title, price_mode, price, status, draft_snapshot_json, published_snapshot_json, published_at FROM offerings WHERE deleted_at IS NULL")
      .first<{
        readonly offering_type: string;
        readonly slug: string;
        readonly title: string;
        readonly price_mode: string;
        readonly price: number | null;
        readonly status: string;
        readonly draft_snapshot_json: string | null;
        readonly published_snapshot_json: string | null;
        readonly published_at: number | null;
      }>();
    expect(offering?.offering_type).toBe("service");
    expect(offering?.status).toBe("draft");
    expect(offering?.published_snapshot_json).toBeNull();
    expect(offering?.published_at).toBeNull();
    expect(offering?.price_mode).toBe("on_request");
    expect(offering?.price).toBeNull();
    expect(offering?.title).toContain("CONTOH");

    // Verify lossless TASK-035 serviceConsultationV1 envelope stored in draft_snapshot_json!
    const extractedSvc = extractServiceConsultationFromSnapshotJson(offering?.draft_snapshot_json);
    expect(extractedSvc).not.toBeNull();
    expect(extractedSvc!.pricingMode).toBe("inquiry");
    expect(extractedSvc!.processSteps.length).toBe(3);

    // Retry with EXACT same setupKey -> idempotent replay, ZERO duplicate rows!
    const resRetry = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "POST", {
        cookie: ownerServices.cookie,
        body: {
          action: "apply",
          presetId: "professional_services",
          setupKey: "setup-svc-001",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2000 },
    );
    expect(resRetry.status).toBe(200);
    const replayed = (await resRetry.json()) as ApplyVerticalStarterPresetResult;
    expect(replayed.alreadyApplied).toBe(true);
    expect(replayed.idempotentReplay).toBe(true);

    const pageCountAfter = await tenantDbServices
      .prepare("SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL")
      .first<{ readonly count: number }>();
    const offeringCountAfter = await tenantDbServices
      .prepare("SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL")
      .first<{ readonly count: number }>();
    expect(Number(pageCountAfter?.count)).toBe(2);
    expect(Number(offeringCountAfter?.count)).toBe(1);

    // Reusing same setupKey with DIFFERENT presetId -> 409 IDEMPOTENCY_KEY_CONFLICT
    const conflictRes = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "POST", {
        cookie: ownerServices.cookie,
        body: {
          action: "apply",
          presetId: "travel_umrah",
          setupKey: "setup-svc-001",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2500 },
    );
    expect(conflictRes.status).toBe(409);
  });

  it("provisions travel_umrah preset as DRAFT general_tour only (DEC-042 compliant) using TASK-020 schema and is idempotent", async () => {
    const cacheBefore = await getTenantCacheVersion(TENANT_TRAVEL.id);

    const res1 = await handleDashboardOnboardingApiRequest(
      TENANT_TRAVEL.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_TRAVEL.handle}/onboarding/api`, "POST", {
        cookie: ownerTravel.cookie,
        body: {
          action: "apply",
          presetId: "travel_umrah",
          setupKey: "setup-trv-001",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3000 },
    );
    expect(res1.status).toBe(200);
    const applied = (await res1.json()) as ApplyVerticalStarterPresetResult;
    expect(applied.presetId).toBe("travel_umrah");
    expect(applied.alreadyApplied).toBe(false);
    expect(applied.createdPageSlugs).toContain("panduan-keberangkatan");
    expect(applied.createdOfferingSlugs).toEqual(["contoh-paket-wisata-3h2m"]);
    expect(applied.state.checklist.items.map((i) => i.id)).toContain("travel_umrah_ppiu_gate");
    expect(await getTenantCacheVersion(TENANT_TRAVEL.id)).toBe(cacheBefore);

    const tourRow = await tenantDbTravel
      .prepare("SELECT offering_type, status, price_mode, price, draft_snapshot_json, published_snapshot_json, published_at FROM offerings WHERE deleted_at IS NULL")
      .first<{
        readonly offering_type: string;
        readonly status: string;
        readonly price_mode: string;
        readonly price: number | null;
        readonly draft_snapshot_json: string | null;
        readonly published_snapshot_json: string | null;
        readonly published_at: number | null;
      }>();
    expect(tourRow?.offering_type).toBe("tour");
    expect(tourRow?.status).toBe("draft");
    expect(tourRow?.published_snapshot_json).toBeNull();
    expect(tourRow?.published_at).toBeNull();
    expect(tourRow?.price_mode).toBe("on_request");
    expect(tourRow?.price).toBeNull();

    // Lossless TASK-020 travelPackageV1 strictly general_tour (NEVER umrah, ZERO fabricated SK PPIU)
    const extractedTravel = extractTravelPackageFromSnapshotJson(tourRow?.draft_snapshot_json);
    expect(extractedTravel).not.toBeNull();
    expect(extractedTravel!.packageKind).toBe("general_tour");
    expect(extractedTravel!.skPpiuNumber).toBeUndefined();
    expect(extractedTravel!.itinerary.length).toBe(3);
    expect(extractedTravel!.departures?.[0]?.departureDate).toBe("2027-01-15");

    // Idempotent retry creates ZERO duplicates
    const res2 = await handleDashboardOnboardingApiRequest(
      TENANT_TRAVEL.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_TRAVEL.handle}/onboarding/api`, "POST", {
        cookie: ownerTravel.cookie,
        body: {
          action: "apply",
          presetId: "travel_umrah",
          setupKey: "setup-trv-001",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3500 },
    );
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as ApplyVerticalStarterPresetResult).alreadyApplied).toBe(true);
    const tourCount = await tenantDbTravel
      .prepare("SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL")
      .first<{ readonly count: number }>();
    expect(Number(tourCount?.count)).toBe(1);
  });

  it("provisions multi_outlet preset as DRAFT-ONLY outlet template via TASK-019 (zero public leakage) and is idempotent", async () => {
    const cacheBefore = await getTenantCacheVersion(TENANT_OUTLETS.id);

    const res1 = await handleDashboardOnboardingApiRequest(
      TENANT_OUTLETS.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_OUTLETS.handle}/onboarding/api`, "POST", {
        cookie: ownerOutlets.cookie,
        body: {
          action: "apply",
          presetId: "multi_outlet",
          setupKey: "setup-out-001",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4000 },
    );
    expect(res1.status).toBe(200);
    const applied = (await res1.json()) as ApplyVerticalStarterPresetResult;
    expect(applied.presetId).toBe("multi_outlet");
    expect(applied.createdPageSlugs).toContain("lokasi-gerai");
    expect(applied.createdOutletSlugs).toEqual(["contoh-gerai-utama"]);
    expect(applied.state.checklist.items.map((i) => i.id)).toContain("outlets_directory_hours");
    expect(applied.state.checklist.items.map((i) => i.id)).toContain("google_business_profile");
    expect(await getTenantCacheVersion(TENANT_OUTLETS.id)).toBe(cacheBefore);

    // Public outlet directory MUST return 0 rows; admin list has 1 draft inactive template!
    const publicOutlets = await listPublishedOutletsForPublic(tenantDbOutlets);
    expect(publicOutlets).toHaveLength(0);

    const adminOutlets = await listOutletsForAdmin(tenantDbOutlets);
    expect(adminOutlets.total).toBe(1);
    expect(adminOutlets.items[0]?.status).toBe("draft");
    expect(adminOutlets.items[0]?.active).toBe(false);
    expect(adminOutlets.items[0]?.name).toContain("CONTOH");
    expect(adminOutlets.items[0]?.latitude).toBeNull();
    expect(adminOutlets.items[0]?.longitude).toBeNull();
    expect(adminOutlets.items[0]?.weeklyHours).toEqual([]);

    // Idempotent retry creates ZERO duplicate outlets or pages
    const res2 = await handleDashboardOnboardingApiRequest(
      TENANT_OUTLETS.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_OUTLETS.handle}/onboarding/api`, "POST", {
        cookie: ownerOutlets.cookie,
        body: {
          action: "apply",
          presetId: "multi_outlet",
          setupKey: "setup-out-001",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4500 },
    );
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as ApplyVerticalStarterPresetResult).alreadyApplied).toBe(true);
    expect((await listOutletsForAdmin(tenantDbOutlets)).total).toBe(1);
  });

  it("preserves ALL pre-existing pages, offerings, and outlets untouched on a populated tenant across all 3 vertical presets", async () => {
    const beforeHome = await tenantDbPopulated
      .prepare("SELECT slug, title, status, published_sections_json, version FROM pages WHERE id = 1")
      .first();
    const beforeOffering = await tenantDbPopulated
      .prepare("SELECT slug, title, status, version FROM offerings WHERE id = 1")
      .first();
    const beforeOutlets = await listOutletsForAdmin(tenantDbPopulated);
    const cacheBefore = await getTenantCacheVersion(TENANT_POPULATED.id);

    for (const [idx, [presetId, setupKey]] of (
      [
        ["professional_services", "pop-svc-001"],
        ["travel_umrah", "pop-trv-002"],
        ["multi_outlet", "pop-out-003"],
      ] as const
    ).entries()) {
      const res = await handleDashboardOnboardingApiRequest(
        TENANT_POPULATED.handle,
        makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_POPULATED.handle}/onboarding/api`, "POST", {
          cookie: ownerPopulated.cookie,
          body: {
            action: "apply",
            presetId,
            setupKey,
            ...(idx > 0 ? { confirmSwitch: true } : {}),
          },
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 5000 + idx * 100 },
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as ApplyVerticalStarterPresetResult;
      expect(data.preservedExistingContent).toBe(true);
      expect(data.createdHomepageDraft).toBe(false);
      expect(data.createdPageSlugs).toEqual([]);
      expect(data.createdOfferingSlugs).toEqual([]);
      expect(data.createdOutletSlugs).toEqual([]);
    }

    const afterHome = await tenantDbPopulated
      .prepare("SELECT slug, title, status, published_sections_json, version FROM pages WHERE id = 1")
      .first();
    const afterOffering = await tenantDbPopulated
      .prepare("SELECT slug, title, status, version FROM offerings WHERE id = 1")
      .first();
    const afterOutlets = await listOutletsForAdmin(tenantDbPopulated);

    expect(afterHome).toEqual(beforeHome);
    expect(afterOffering).toEqual(beforeOffering);
    expect(afterOutlets.total).toBe(beforeOutlets.total);
    expect(afterOutlets.items[0]?.slug).toBe("gerai-pusat-lama");
    expect(afterOutlets.items[0]?.status).toBe("published");
    expect(await getTenantCacheVersion(TENANT_POPULATED.id)).toBe(cacheBefore);
  });

  it("enforces Auth, CSRF, RBAC, cross-tenant isolation, locked-tenant read-only, inert preview, and SSR page-gate zero-DB reads", async () => {
    // 1. Unauthenticated -> 401
    const unauthRes = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "GET"),
      runtimeEnv,
    );
    expect(unauthRes.status).toBe(401);

    // 2. Missing CSRF Origin on POST -> 403
    const noCsrfRes = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "POST", {
        cookie: ownerServices.cookie,
        origin: null,
        body: { action: "apply", presetId: "professional_services", setupKey: "csrf-test-001" },
      }),
      runtimeEnv,
    );
    expect(noCsrfRes.status).toBe(403);

    // 3. Editor role -> 403 on GET & POST
    const editorGet = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "GET", {
        cookie: editorServices.cookie,
      }),
      runtimeEnv,
    );
    expect(editorGet.status).toBe(403);

    const editorPost = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "POST", {
        cookie: editorServices.cookie,
        body: { action: "apply", presetId: "professional_services", setupKey: "ed-test-001" },
      }),
      runtimeEnv,
    );
    expect(editorPost.status).toBe(403);

    // 4. Cross-tenant isolation: ownerTravel accessing TENANT_SERVICES -> 404
    const crossTenant = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "GET", {
        cookie: ownerTravel.cookie,
      }),
      runtimeEnv,
    );
    expect(crossTenant.status).toBe(404);

    // 5. Locked tenant: GET 200 with isLocked=true, POST apply -> 403
    const lockedGet = await handleDashboardOnboardingApiRequest(
      TENANT_LOCKED.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_LOCKED.handle}/onboarding/api`, "GET", {
        cookie: ownerLocked.cookie,
      }),
      runtimeEnv,
    );
    expect(lockedGet.status).toBe(200);
    expect(((await lockedGet.json()) as VerticalPresetDashboardStateDto).permissions.isLocked).toBe(
      true,
    );

    const lockedPost = await handleDashboardOnboardingApiRequest(
      TENANT_LOCKED.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_LOCKED.handle}/onboarding/api`, "POST", {
        cookie: ownerLocked.cookie,
        body: { action: "apply", presetId: "multi_outlet", setupKey: "locked-001" },
      }),
      runtimeEnv,
    );
    expect(lockedPost.status).toBe(403);

    // 6. Wrong host (console.punyasitus.com) -> 404
    const wrongHost = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${CONSOLE_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "GET", {
        cookie: ownerServices.cookie,
      }),
      runtimeEnv,
    );
    expect(wrongHost.status).toBe(404);

    // 7. Forbidden selector key (`tenantId`) -> 422
    const forbiddenKey = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "POST", {
        cookie: ownerServices.cookie,
        body: {
          action: "apply",
          presetId: "professional_services",
          setupKey: "forb-001",
          tenantId: TENANT_TRAVEL.id,
        },
      }),
      runtimeEnv,
    );
    expect(forbiddenKey.status).toBe(422);

    // 8. Inert preview for travel_umrah returns CSP script-src 'none' & sandbox=""
    const previewRes = await handleDashboardOnboardingApiRequest(
      TENANT_TRAVEL.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_TRAVEL.handle}/onboarding/api`, "POST", {
        cookie: ownerTravel.cookie,
        body: { action: "preview", presetId: "travel_umrah" },
      }),
      runtimeEnv,
    );
    expect(previewRes.status).toBe(200);
    expect(previewRes.headers.get("Content-Security-Policy")).toBe(PREVIEW_API_CSP_HEADER);
    const previewJson = (await previewRes.json()) as {
      readonly html: string;
      readonly sandbox: string;
      readonly presetId: string;
    };
    expect(previewJson.presetId).toBe("travel_umrah");
    expect(previewJson.sandbox).toBe(PREVIEW_IFRAME_SANDBOX);
    expect(previewJson.html.toLowerCase()).not.toContain("<script");

    // 9. SSR page gate guarantees ZERO TenantStore reads on editor (403), suspended (302), purging (404)
    let tenantDbOpenedCount = 0;
    const countingResolver = () => {
      tenantDbOpenedCount += 1;
      return tenantDbServices;
    };

    const editorGate = await loadVerticalOnboardingPageOrGateResponse({
      platformDb: env.PLATFORM_DB,
      member: {
        tenantId: TENANT_SERVICES.id,
        handle: TENANT_SERVICES.handle,
        tenantName: TENANT_SERVICES.name,
        userId: editorServices.userId,
        role: "editor",
        tenantStatus: "active",
      },
      resolveTenantDb: countingResolver,
    });
    expect(editorGate.ok).toBe(false);
    if (!editorGate.ok) expect(editorGate.response.status).toBe(403);

    const suspendedGate = await loadVerticalOnboardingPageOrGateResponse({
      platformDb: env.PLATFORM_DB,
      member: {
        tenantId: TENANT_SERVICES.id,
        handle: TENANT_SERVICES.handle,
        tenantName: TENANT_SERVICES.name,
        userId: ownerServices.userId,
        role: "owner",
        tenantStatus: "suspended",
      },
      resolveTenantDb: countingResolver,
    });
    expect(suspendedGate.ok).toBe(false);
    if (!suspendedGate.ok) expect(suspendedGate.response.status).toBe(302);

    const purgingGate = await loadVerticalOnboardingPageOrGateResponse({
      platformDb: env.PLATFORM_DB,
      member: {
        tenantId: TENANT_SERVICES.id,
        handle: TENANT_SERVICES.handle,
        tenantName: TENANT_SERVICES.name,
        userId: ownerServices.userId,
        role: "owner",
        tenantStatus: "purging",
      },
      resolveTenantDb: countingResolver,
    });
    expect(purgingGate.ok).toBe(false);
    if (!purgingGate.ok) expect(purgingGate.response.status).toBe(404);

    // operatorHold === true -> 302 redirect with ZERO TenantStore reads (MEDIUM-8)
    const holdGate = await loadVerticalOnboardingPageOrGateResponse({
      platformDb: env.PLATFORM_DB,
      operatorHold: true,
      member: {
        tenantId: TENANT_SERVICES.id,
        handle: TENANT_SERVICES.handle,
        tenantName: TENANT_SERVICES.name,
        userId: ownerServices.userId,
        role: "owner",
        tenantStatus: "active",
      },
      resolveTenantDb: countingResolver,
    });
    expect(holdGate.ok).toBe(false);
    if (!holdGate.ok) expect(holdGate.response.status).toBe(302);
    expect(tenantDbOpenedCount).toBe(0);
  });

  it("Review hardening: fails closed without sessionId (HIGH-2), compensates cache-bump failure (HIGH-1), protects seeding retries (MEDIUM-5), guards preset switch (MEDIUM-3), preserves populated draft metadata (MEDIUM-4), rejects presetId mismatch, and prechecks Content-Length", async () => {
    // 1. HIGH-2: authenticatedUser WITHOUT authenticatedSessionId MUST fail closed with 401!
    const missingSessionIdRes = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "GET"),
      runtimeEnv,
      {
        authenticatedUser: { id: ownerServices.userId },
        authenticatedSessionId: null,
      },
    );
    expect(missingSessionIdRes.status).toBe(401);

    // 2. Content-Length precheck rejects oversized payload immediately with 413
    const oversizedHeaders = new Headers({
      Cookie: ownerServices.cookie,
      Origin: APP_ORIGIN,
      "Content-Type": "application/json",
      "Content-Length": String(256_000),
    });
    const oversizedRes = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      new Request(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, {
        method: "POST",
        headers: oversizedHeaders,
        body: JSON.stringify({ action: "apply", presetId: "professional_services", setupKey: "big-01" }),
      }),
      runtimeEnv,
    );
    expect(oversizedRes.status).toBe(413);

    // 3. MEDIUM-5: Failed offering seeding MUST NOT poison `preset_setup_operations`; retry with SAME setupKey succeeds!
    const failTenantId = "01JT066SEEDFAIL00000000006";
    const failOrgId = "org_t066_seedfail";
    const failHandle = "t066-seedfail";
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);
    await pDb
      .insert(organizations)
      .values({ id: failOrgId, name: "PT Retry Aman", slug: failHandle, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await pDb
      .insert(tenants)
      .values({
        id: failTenantId,
        organizationId: failOrgId,
        handle: failHandle,
        name: "PT Retry Aman",
        vertical: "sales",
        status: "active",
        cacheVersion: 1,
        schemaVersion: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const tenantDbRetry = await openMigratedTenantDb(failTenantId);
    await tenantDbRetry.batch([
      tenantDbRetry
        .prepare(
          `INSERT OR REPLACE INTO site_settings
             (id, site_title, tagline, timezone, locale, active_theme_id, version, updated_at)
           VALUES (1, 'PT Retry Aman', 'Profil', 'Asia/Jakarta', 'id-ID', 'sales', 1, ?)`,
        )
        .bind(BASE_NOW_MS),
      tenantDbRetry
        .prepare(
          `INSERT OR REPLACE INTO business_profile
             (id, business_name, business_category, version, updated_at)
           VALUES (1, 'PT Retry Aman', 'LocalBusiness', 1, ?)`,
        )
        .bind(BASE_NOW_MS),
    ]);

    const retryMember = {
      tenantId: failTenantId,
      handle: failHandle,
      tenantName: "PT Retry Aman",
      userId: ownerServices.userId,
      role: "owner" as const,
      tenantStatus: "active" as const,
    };

    await expect(
      applyVerticalStarterPresetAtomically(
        env.PLATFORM_DB,
        tenantDbRetry,
        retryMember,
        { presetId: "professional_services", setupKey: "setup-retry-safe-001" },
        {
          nowMs: BASE_NOW_MS + 9000,
          createOfferingFn: async () => {
            throw new Error("Simulated transient offering seed failure");
          },
        },
      ),
    ).rejects.toThrow("Simulated transient offering seed failure");

    // Confirm idempotency key was NOT poisoned
    const opCountAfterFail = await tenantDbRetry
      .prepare("SELECT COUNT(*) AS count FROM preset_setup_operations WHERE operation_key = ?")
      .bind("setup-retry-safe-001")
      .first<{ readonly count: number }>();
    expect(Number(opCountAfterFail?.count)).toBe(0);

    // Retry with EXACT SAME setupKey now succeeds cleanly with 1 draft offering!
    const retryOk = await applyVerticalStarterPresetAtomically(
      env.PLATFORM_DB,
      tenantDbRetry,
      retryMember,
      { presetId: "professional_services", setupKey: "setup-retry-safe-001" },
      { nowMs: BASE_NOW_MS + 9100 },
    );
    expect(retryOk.alreadyApplied).toBe(false);
    expect(retryOk.createdOfferingSlugs).toEqual(["contoh-layanan-konsultasi"]);

    // 3b. MEDIUM-5 crash-after-seed retry: simulate crash AFTER draft offering is seeded
    //     (before `preset_setups` / `preset_setup_operations` / `pages` / `menus` commit),
    //     then retry with the SAME setupKey -> MUST treat tenant as fresh (`preservedExistingContent === false`),
    //     create homepage + secondary page + draft menu, and reuse the starter draft offering with ZERO duplicates!
    const crashTenantId = "01JT066CRASHRETRY000000007";
    const crashOrgId = "org_t066_crashretry";
    const crashHandle = "t066-crashretry";
    await pDb
      .insert(organizations)
      .values({ id: crashOrgId, name: "PT Crash Retry", slug: crashHandle, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await pDb
      .insert(tenants)
      .values({
        id: crashTenantId,
        organizationId: crashOrgId,
        handle: crashHandle,
        name: "PT Crash Retry",
        vertical: "sales",
        status: "active",
        cacheVersion: 1,
        schemaVersion: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const tenantDbCrash = await openMigratedTenantDb(crashTenantId);
    await tenantDbCrash.batch([
      tenantDbCrash
        .prepare(
          `INSERT OR REPLACE INTO site_settings
             (id, site_title, tagline, timezone, locale, active_theme_id, version, updated_at)
           VALUES (1, 'PT Crash Retry', 'Profil', 'Asia/Jakarta', 'id-ID', 'sales', 1, ?)`,
        )
        .bind(BASE_NOW_MS),
      tenantDbCrash
        .prepare(
          `INSERT OR REPLACE INTO business_profile
             (id, business_name, business_category, version, updated_at)
           VALUES (1, 'PT Crash Retry', 'LocalBusiness', 1, ?)`,
        )
        .bind(BASE_NOW_MS),
    ]);

    const crashMember = {
      tenantId: crashTenantId,
      handle: crashHandle,
      tenantName: "PT Crash Retry",
      userId: ownerServices.userId,
      role: "owner" as const,
      tenantStatus: "active" as const,
    };

    // Wrap tenantDbCrash so `createCatalogOffering`'s batch succeeds, then the final `preset_setup_operations` batch throws!
    let batchCalls = 0;
    const crashingBatchTenantDb = {
      ...tenantDbCrash,
      prepare: tenantDbCrash.prepare.bind(tenantDbCrash),
      batch: async (stmts: D1PreparedStatement[]) => {
        batchCalls += 1;
        // Call 1 is `createCatalogOffering`'s INSERT batch; Call 2 is the final `preset_setups` + `preset_setup_operations` batch!
        if (batchCalls === 2) {
          throw new Error("Simulated crash right after seeding vertical draft offering");
        }
        return tenantDbCrash.batch(stmts);
      },
    } as unknown as D1Database;

    await expect(
      applyVerticalStarterPresetAtomically(
        env.PLATFORM_DB,
        crashingBatchTenantDb,
        crashMember,
        { presetId: "professional_services", setupKey: "setup-crash-after-seed-001" },
        { nowMs: BASE_NOW_MS + 9120 },
      ),
    ).rejects.toThrow("Simulated crash right after seeding vertical draft offering");

    // Verify intermediate crashed state: 1 draft starter offering exists, 0 pages, 0 preset_setups, 0 operations!
    const crashOfferingsMid = await tenantDbCrash
      .prepare("SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL AND status = 'draft' AND published_at IS NULL")
      .first<{ readonly count: number }>();
    const crashSetupMid = await tenantDbCrash
      .prepare("SELECT COUNT(*) AS count FROM preset_setups")
      .first<{ readonly count: number }>();
    expect(Number(crashOfferingsMid?.count)).toBe(1);
    expect(Number(crashSetupMid?.count)).toBe(0);

    // Retry with EXACT SAME setupKey against healthy tenantDbCrash!
    const recovered = await applyVerticalStarterPresetAtomically(
      env.PLATFORM_DB,
      tenantDbCrash,
      crashMember,
      { presetId: "professional_services", setupKey: "setup-crash-after-seed-001" },
      { nowMs: BASE_NOW_MS + 9150 },
    );
    expect(recovered.alreadyApplied).toBe(false);
    expect(recovered.preservedExistingContent).toBe(false);
    expect(recovered.applyMode).toBe("initialized_draft");
    expect(recovered.createdHomepageDraft).toBe(true);
    expect(recovered.createdPageSlugs).toEqual(["beranda", "konsultasi-layanan"]);
    expect(recovered.createdHeaderMenuDraft).toBe(true);
    expect(recovered.createdOfferingSlugs).toEqual(["contoh-layanan-konsultasi"]);

    // Verify ZERO duplicate offerings and both draft pages + draft header menu exist!
    const crashOfferingsAfter = await tenantDbCrash
      .prepare("SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL")
      .first<{ readonly count: number }>();
    const crashPagesAfter = await tenantDbCrash
      .prepare("SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL")
      .first<{ readonly count: number }>();
    const crashMenuAfter = await tenantDbCrash
      .prepare("SELECT COUNT(*) AS count FROM menus WHERE location = 'header'")
      .first<{ readonly count: number }>();
    expect(Number(crashOfferingsAfter?.count)).toBe(1);
    expect(Number(crashPagesAfter?.count)).toBe(2);
    expect(Number(crashMenuAfter?.count)).toBe(1);

    // 4. MEDIUM-3: Switching preset WITHOUT confirmSwitch -> 409 PRESET_SWITCH_CONFIRMATION_REQUIRED;
    //    WITH confirmSwitch: true -> preserves user-edited non-sample section & resets status='draft' + publishedSectionIds=[]!
    const switchWithoutConfirm = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "POST", {
        cookie: ownerServices.cookie,
        body: {
          action: "apply",
          presetId: "travel_umrah",
          setupKey: "switch-no-confirm-001",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 9200 },
    );
    expect(switchWithoutConfirm.status).toBe(409);
    expect(
      ((await switchWithoutConfirm.json()) as { error: { code: string } }).error.code,
    ).toBe("PRESET_SWITCH_CONFIRMATION_REQUIRED");

    // 5. Preset mismatch on publish -> 409 PRESET_MISMATCH
    const svcStateRes = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "GET", {
        cookie: ownerServices.cookie,
      }),
      runtimeEnv,
    );
    const svcState = (await svcStateRes.json()) as VerticalPresetDashboardStateDto;

    const mismatchPubRes = await handleDashboardOnboardingApiRequest(
      TENANT_SERVICES.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_SERVICES.handle}/onboarding/api`, "POST", {
        cookie: ownerServices.cookie,
        body: {
          action: "publish",
          presetId: "travel_umrah",
          selectedSectionIds: ["svc-hero"],
          expectedVersion: svcState.setup!.version,
          confirm: true,
        },
      }),
      runtimeEnv,
    );
    expect(mismatchPubRes.status).toBe(409);
    expect(((await mismatchPubRes.json()) as { error: { code: string } }).error.code).toBe(
      "PRESET_MISMATCH",
    );

    // 6. MEDIUM-4: Publishing selected preset sections on TENANT_POPULATED preserves existing tenant draft metadata
    //    (`tenant-custom-about` & `tenantCustomMetaTag`) AND existing published hero!
    const popStateRes = await handleDashboardOnboardingApiRequest(
      TENANT_POPULATED.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_POPULATED.handle}/onboarding/api`, "GET", {
        cookie: ownerPopulated.cookie,
      }),
      runtimeEnv,
    );
    const popState = (await popStateRes.json()) as VerticalPresetDashboardStateDto;
    const popCleanSections = popState.setup!.sections.map((item) => {
      if (item.id === "out-contact" && item.section.type === "contact_location") {
        return {
          ...item.section,
          enabled: true,
          config: {
            ...item.section.config,
            eyebrow: "Kontak",
            heading: "Hubungi CV Sinar Abadi",
            subheading: "Hubungi tim cabang resmi kami.",
            address: "Jl. Asia Afrika No. 88, Bandung",
          },
        };
      }
      return item.section;
    });

    const popSavedRes = await handleDashboardOnboardingApiRequest(
      TENANT_POPULATED.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_POPULATED.handle}/onboarding/api`, "POST", {
        cookie: ownerPopulated.cookie,
        body: {
          action: "save_draft",
          expectedVersion: popState.setup!.version,
          sections: popCleanSections,
          selectedPublishSectionIds: ["out-contact"],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 9400 },
    );
    expect(popSavedRes.status).toBe(200);
    const popSaved = (await popSavedRes.json()) as VerticalPresetDashboardStateDto;

    // 7. HIGH-1: Simulate PLATFORM_DB cache_version failure during publish -> FULL rollback + compensated=true!
    const revsBeforeFail = await tenantDbPopulated
      .prepare("SELECT COUNT(*) AS count FROM content_revisions")
      .first<{ readonly count: number }>();
    const homeBeforeFail = await tenantDbPopulated
      .prepare("SELECT status, draft_sections_json, published_sections_json, version FROM pages WHERE id = 1")
      .first();

    const failingPlatformDb = {
      ...env.PLATFORM_DB,
      prepare: env.PLATFORM_DB.prepare.bind(env.PLATFORM_DB),
      batch: async () => {
        throw new Error("Simulated PLATFORM_DB outage on vertical publish");
      },
    } as unknown as D1Database;

    let atomicErr: unknown = null;
    try {
      await publishVerticalStarterPresetSectionsAtomically(
        failingPlatformDb,
        tenantDbPopulated,
        {
          tenantId: TENANT_POPULATED.id,
          handle: TENANT_POPULATED.handle,
          tenantName: TENANT_POPULATED.name,
          userId: ownerPopulated.userId,
          role: "owner",
          tenantStatus: "active",
        },
        {
          presetId: "multi_outlet",
          selectedSectionIds: ["out-contact"],
          expectedVersion: popSaved.setup!.version,
          confirm: true,
        },
        { nowMs: BASE_NOW_MS + 9500 },
      );
    } catch (err) {
      atomicErr = err;
    }
    expect(atomicErr).toBeInstanceOf(PublicationAtomicError);
    expect((atomicErr as PublicationAtomicError).compensated).toBe(true);

    const revsAfterFail = await tenantDbPopulated
      .prepare("SELECT COUNT(*) AS count FROM content_revisions")
      .first<{ readonly count: number }>();
    const homeAfterFail = await tenantDbPopulated
      .prepare("SELECT status, draft_sections_json, published_sections_json, version FROM pages WHERE id = 1")
      .first();
    expect(Number(revsAfterFail?.count)).toBe(Number(revsBeforeFail?.count));
    expect(homeAfterFail).toEqual(homeBeforeFail);

    // Now publish cleanly and verify existing tenant draft metadata survived (MEDIUM-4)!
    const popPubRes = await handleDashboardOnboardingApiRequest(
      TENANT_POPULATED.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_POPULATED.handle}/onboarding/api`, "POST", {
        cookie: ownerPopulated.cookie,
        body: {
          action: "publish",
          presetId: "multi_outlet",
          selectedSectionIds: ["out-contact"],
          expectedVersion: popSaved.setup!.version,
          confirm: true,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 9600 },
    );
    expect(popPubRes.status).toBe(200);

    const homeAfterPub = await tenantDbPopulated
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
    const adminDraftAfterPub = extractDraftSnapshotForAdmin("page", {
      resourceId: Number(homeAfterPub!.id),
      status: homeAfterPub!.status,
      deletedAt: homeAfterPub!.deleted_at,
      draftJson: homeAfterPub!.draft_sections_json,
      publishedJson: homeAfterPub!.published_sections_json,
      publishedAt: homeAfterPub!.published_at,
      contentModifiedAt: homeAfterPub!.content_modified_at,
      version: Number(homeAfterPub!.version),
      updatedAt: Number(homeAfterPub!.updated_at),
    });
    expect(adminDraftAfterPub?.draftMetadata?.draftNotes).toBe("keep-me-intact");
    expect(String(adminDraftAfterPub?.draftMetadata?.draftSectionsJson ?? "")).toContain(
      "tenant-custom-about",
    );
    expect(homeAfterPub!.published_sections_json!).toContain("existing-live-hero");
    expect(homeAfterPub!.published_sections_json!).toContain("out-contact");

    // Confirmed preset switch AFTER publish resets setup status to 'draft' & publishedSectionIds to [] (MEDIUM-3)
    const switchAfterPub = await handleDashboardOnboardingApiRequest(
      TENANT_POPULATED.handle,
      makeRequest(`${APP_ORIGIN}/dashboard/${TENANT_POPULATED.handle}/onboarding/api`, "POST", {
        cookie: ownerPopulated.cookie,
        body: {
          action: "apply",
          presetId: "professional_services",
          setupKey: "switch-after-pub-001",
          confirmSwitch: true,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 9700 },
    );
    expect(switchAfterPub.status).toBe(200);
    const switchedDto = (await switchAfterPub.json()) as ApplyVerticalStarterPresetResult;
    expect(switchedDto.state.setup?.presetId).toBe("professional_services");
    expect(switchedDto.state.setup?.status).toBe("draft");
    expect(switchedDto.state.setup?.publishedSectionIds).toEqual([]);
    // User-edited non-sample `out-contact` was preserved across the confirmed switch!
    expect(switchedDto.state.setup?.sections.some((s) => s.id === "out-contact")).toBe(true);
  });
});

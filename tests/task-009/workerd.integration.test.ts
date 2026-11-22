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
  tenants,
} from "@punyasitus/db/platform";
import { getPublishedResource } from "@punyasitus/db/publication/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import type { TenantCatalogRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/_shared.ts";
import { handleTenantCatalogOfferingRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/index.ts";
import { handleTenantCatalogOfferingPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/publish.ts";
import { handleTenantCatalogOfferingUnpublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/unpublish.ts";
import { handleTenantCatalogCategoryRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/categories/[categoryId].ts";
import { handleTenantCatalogCategoriesRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/categories/index.ts";
import { handleTenantCatalogCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 22, 12, 0, 0);

function buildRuntimeEnv(
  overrides: Partial<TenantCatalogRuntimeEnv> = {},
): TenantCatalogRuntimeEnv {
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
    throw new Error(
      `Expected ${APP_SESSION_COOKIE_NAME} in Set-Cookie, got: ${JSON.stringify(cookies)}`,
    );
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

async function signUpUser(
  email: string,
  name: string,
  runtimeEnv: TenantCatalogRuntimeEnv,
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

interface ProvisionedCatalogTenants {
  readonly tenantA: {
    readonly id: string;
    readonly handle: string;
    readonly orgId: string;
    readonly db: D1Database;
  };
  readonly tenantB: {
    readonly id: string;
    readonly handle: string;
    readonly orgId: string;
    readonly db: D1Database;
  };
  readonly ownerA: { readonly userId: string; readonly cookie: string };
  readonly editorA: { readonly userId: string; readonly cookie: string };
  readonly ownerB: { readonly userId: string; readonly cookie: string };
}

async function provisionTwoCatalogTenants(
  suffix: string,
  runtimeEnv: TenantCatalogRuntimeEnv,
): Promise<ProvisionedCatalogTenants> {
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(BASE_NOW_MS);
  const paidThrough = new Date(BASE_NOW_MS + 30 * 24 * 60 * 60 * 1000);

  const tenantAId = `01JT009ALPHA${suffix.toUpperCase().padEnd(14, "0").slice(0, 14)}`;
  const tenantBId = `01JT009BETA0${suffix.toUpperCase().padEnd(14, "0").slice(0, 14)}`;
  const handleA = `alpha-c-${suffix}`;
  const handleB = `beta-c-${suffix}`;
  const orgAId = `org-t009-alpha-${suffix}`;
  const orgBId = `org-t009-beta-${suffix}`;

  const ownerA = await signUpUser(`owner.a.t009.${suffix}@example.test`, "Owner Alpha", runtimeEnv);
  const editorA = await signUpUser(`editor.a.t009.${suffix}@example.test`, "Editor Alpha", runtimeEnv);
  const ownerB = await signUpUser(`owner.b.t009.${suffix}@example.test`, "Owner Beta", runtimeEnv);

  await db.insert(organizations).values([
    { id: orgAId, name: "Alpha Catalog", slug: handleA, createdAt: now, updatedAt: now },
    { id: orgBId, name: "Beta Catalog", slug: handleB, createdAt: now, updatedAt: now },
  ]);

  await db.insert(tenants).values([
    {
      id: tenantAId,
      organizationId: orgAId,
      handle: handleA,
      name: "Alpha Catalog",
      status: "active",
      paidThrough,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: tenantBId,
      organizationId: orgBId,
      handle: handleB,
      name: "Beta Catalog",
      status: "active",
      paidThrough,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(members).values([
    {
      id: `mem-t009-oa-${suffix}`,
      organizationId: orgAId,
      userId: ownerA.userId,
      role: "owner",
      createdAt: now,
    },
    {
      id: `mem-t009-ea-${suffix}`,
      organizationId: orgAId,
      userId: editorA.userId,
      role: "editor",
      createdAt: now,
    },
    {
      id: `mem-t009-ob-${suffix}`,
      organizationId: orgBId,
      userId: ownerB.userId,
      role: "owner",
      createdAt: now,
    },
  ]);

  const dbA = await openMigratedTenantDb(tenantAId);
  const dbB = await openMigratedTenantDb(tenantBId);

  // Seed Tenant A business_profile with valid Indonesian WA E.164; Tenant B intentionally has NO WA configured!
  await dbA
    .prepare(
      `INSERT INTO business_profile (id, business_name, business_category, whatsapp_e164, updated_at)
       VALUES (1, 'Alpha Studio', 'LocalBusiness', '6281234567890', ?)`,
    )
    .bind(BASE_NOW_MS)
    .run();

  await dbB
    .prepare(
      `INSERT INTO business_profile (id, business_name, business_category, whatsapp_e164, updated_at)
       VALUES (1, 'Beta Tanpa WA', 'LocalBusiness', NULL, ?)`,
    )
    .bind(BASE_NOW_MS)
    .run();

  // Seed 12 ready images (#1..#12), 1 ready video (#50), and 1 quarantined image (#99) in Tenant A
  const mediaStmtsA: D1PreparedStatement[] = [];
  for (let i = 1; i <= 12; i += 1) {
    mediaStmtsA.push(
      dbA
        .prepare(
          `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, status, created_at, updated_at)
           VALUES (?, 'image', ?, 'image/webp', 120000, ?, 1200, 800, ?, 'ready', ?, ?)`,
        )
        .bind(
          i,
          `t/${tenantAId}/img-${i}.webp`,
          String(i).padStart(64, "a"),
          `Foto ${i}`,
          BASE_NOW_MS,
          BASE_NOW_MS,
        ),
    );
  }
  mediaStmtsA.push(
    dbA
      .prepare(
        `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, duration_seconds, status, created_at, updated_at)
         VALUES (50, 'video', ?, 'video/mp4', 1500000, ?, 1280, 720, 'Video Promo', 30, 'ready', ?, ?)`,
      )
      .bind(`t/${tenantAId}/vid-50.mp4`, "b".repeat(64), BASE_NOW_MS, BASE_NOW_MS),
    dbA
      .prepare(
        `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, status, created_at, updated_at)
         VALUES (99, 'image', ?, 'image/webp', 50000, ?, 800, 600, 'Karantina', 'quarantined', ?, ?)`,
      )
      .bind(`t/${tenantAId}/quar-99.webp`, "c".repeat(64), BASE_NOW_MS, BASE_NOW_MS),
  );
  await dbA.batch(mediaStmtsA);

  // Seed foreign media #901 exclusively inside Tenant B
  await dbB
    .prepare(
      `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, status, created_at, updated_at)
       VALUES (901, 'image', ?, 'image/webp', 90000, ?, 1200, 800, 'Foto Rahasia Beta', 'ready', ?, ?)`,
    )
    .bind(`t/${tenantBId}/secret-901.webp`, "d".repeat(64), BASE_NOW_MS, BASE_NOW_MS)
    .run();

  return {
    tenantA: { id: tenantAId, handle: handleA, orgId: orgAId, db: dbA },
    tenantB: { id: tenantBId, handle: handleB, orgId: orgBId, db: dbB },
    ownerA,
    editorA,
    ownerB,
  };
}

describe("TASK-009 workerd integration — Typed Offerings & Categories Management API", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("manages categories (hierarchy <= 3, auto -2 slugs, OCC) and full CRUD + publish/unpublish for all 4 offering types", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const { tenantA, ownerA, editorA } = await provisionTwoCatalogTenants("01", runtimeEnv);

    // 1. Create categories (depth 1 -> 2 -> 3, and verify depth 4 fails)
    const catRootRes = await handleTenantCatalogCategoriesRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories`, "POST", {
        cookie: ownerA.cookie,
        body: { name: "Jasa & Konsultasi", offeringType: "service", sortOrder: 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(catRootRes.status).toBe(201);
    expect(catRootRes.headers.get("cache-control")).toBe("no-store");
    const catRoot = (await catRootRes.json()) as { id: number; slug: string; depth: number; version: number };
    expect(catRoot.id).toBe(1);
    expect(catRoot.slug).toBe("jasa-konsultasi");
    expect(catRoot.depth).toBe(1);

    // Duplicate category title auto-suffixes to -2
    const catDupRes = await handleTenantCatalogCategoriesRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories`, "POST", {
        cookie: ownerA.cookie,
        body: { name: "Jasa & Konsultasi", offeringType: "service", parentId: catRoot.id },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 100 },
    );
    expect(catDupRes.status).toBe(201);
    const catChild = (await catDupRes.json()) as { id: number; slug: string; depth: number };
    expect(catChild.slug).toBe("jasa-konsultasi-2");
    expect(catChild.depth).toBe(2);

    const catGrandRes = await handleTenantCatalogCategoriesRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories`, "POST", {
        cookie: ownerA.cookie,
        body: { name: "Audit Pajak", offeringType: "service", parentId: catChild.id },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 200 },
    );
    expect(catGrandRes.status).toBe(201);
    const catGrand = (await catGrandRes.json()) as { id: number; depth: number };
    expect(catGrand.depth).toBe(3);

    // Depth 4 must fail with 422
    const catTooDeepRes = await handleTenantCatalogCategoriesRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories`, "POST", {
        cookie: ownerA.cookie,
        body: { name: "Terlalu Dalam", offeringType: "service", parentId: catGrand.id },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 300 },
    );
    expect(catTooDeepRes.status).toBe(422);

    // Shared category usable across product/tour/vehicle
    const catSharedRes = await handleTenantCatalogCategoriesRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories`, "POST", {
        cookie: editorA.cookie,
        body: { name: "Unggulan", description: "Penawaran terbaik kami" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 400 },
    );
    expect(catSharedRes.status).toBe(201);
    const catShared = (await catSharedRes.json()) as { id: number };

    // 2. Create all 4 typed offerings: service, product, tour, vehicle
    const orderedGallery12 = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

    // 2a. SERVICE (from + negotiable + whatsapp + ordered 12-image gallery + video + categories)
    const serviceCreateRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: editorA.cookie,
        body: {
          offeringType: "service",
          title: "Konsultasi Pajak & Pembukuan UMKM",
          summary: "Pendampingan pajak bulanan & SPT tahunan.",
          description: "<p>Layanan lengkap untuk UMKM.</p>",
          coverMediaId: 1,
          galleryMediaIds: orderedGallery12,
          videoMediaId: 50,
          priceMode: "from",
          price: 1_500_000,
          negotiable: true,
          badge: "Best Seller",
          badges: ["Best Seller", "Gratis Survey"],
          ctaMode: "whatsapp",
          whatsappTemplate: "Halo, saya tertarik dengan {{item_title}} ({{item_price}}) {{page_url}}",
          categoryIds: [catRoot.id, catShared.id],
          attributes: {
            duration: "Bulanan",
            deliverables: ["Laporan Laba Rugi", "Pelaporan SPT"],
            turnaround: "5 hari kerja",
            serviceMode: "hybrid",
            serviceArea: "Jakarta & Bandung",
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1000 },
    );
    expect(serviceCreateRes.status).toBe(201);
    const service = (await serviceCreateRes.json()) as {
      id: number;
      slug: string;
      publicPath: string;
      galleryMediaIds: number[];
      categoryIds: number[];
      badges: string[];
      attributes: Record<string, unknown>;
      status: string;
      version: number;
    };
    expect(service.id).toBe(1);
    expect(service.publicPath).toBe(`/layanan/${service.slug}`);
    expect(service.galleryMediaIds).toEqual(orderedGallery12);
    expect(service.categoryIds).toEqual([catRoot.id, catShared.id]);
    expect(service.badges).toEqual(["Best Seller", "Gratis Survey"]);
    expect(service.attributes.turnaround).toBe("5 hari kerja");
    expect(service.status).toBe("draft");
    expect(service.version).toBe(1);

    // 2b. PRODUCT (fixed + originalAmount + external_link)
    const productCreateRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "product",
          title: "Kopi Arabika Gayo 250g",
          coverMediaId: 2,
          galleryMediaIds: [2, 3, 4],
          priceMode: "fixed",
          price: 85_000,
          originalAmount: 110_000,
          badge: "Promo",
          ctaMode: "external_link",
          externalUrl: "https://www.tokopedia.com/alpha-studio/kopi-gayo-250g",
          categoryIds: [catShared.id],
          attributes: {
            sku: "KOP-GY-250",
            brand: "Alpha Roastery",
            stockStatus: "ready",
            moq: 2,
            unit: "pack",
            weightGrams: 250,
            material: "100% Arabika",
            variants: [{ name: "Roast", values: ["Medium", "Dark"] }],
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1100 },
    );
    expect(productCreateRes.status).toBe(201);
    const product = (await productCreateRes.json()) as {
      id: number;
      publicPath: string;
      externalUrl: string;
      version: number;
    };
    expect(product.id).toBe(2);
    expect(product.publicPath).toBe("/produk/kopi-arabika-gayo-250g");
    expect(product.externalUrl).toBe("https://www.tokopedia.com/alpha-studio/kopi-gayo-250g");

    // 2c. TOUR (range with priceMax >= price + book CTA + departures + PPIU license)
    const tourCreateRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "tour",
          title: "Umrah Plus Turki 12 Hari",
          coverMediaId: 5,
          galleryMediaIds: [5, 6],
          priceMode: "range",
          price: 28_500_000,
          priceMax: 34_000_000,
          badge: "Slot Terbatas",
          ctaMode: "book",
          categoryIds: [catShared.id],
          attributes: {
            durationDays: 12,
            destination: "Makkah, Madinah & Istanbul",
            departures: [
              { departureDate: "2027-03-10", seatsAvailable: 15, status: "open" },
              { departureDate: "2027-04-05", seatsAvailable: 3, status: "limited" },
            ],
            inclusions: ["Tiket Pesawat PP", "Visa Umrah", "Hotel Bintang 4"],
            exclusions: ["Biaya Paspor"],
            ppiuNumber: "PPIU-2026-0088",
            umrahLicense: "SK-KEMENAG-88",
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1200 },
    );
    expect(tourCreateRes.status).toBe(201);
    const tour = (await tourCreateRes.json()) as { id: number; publicPath: string; version: number };
    expect(tour.id).toBe(3);
    expect(tour.publicPath).toBe("/tour/umrah-plus-turki-12-hari");

    // 2d. VEHICLE (on_request + negotiable + inquiry CTA + vehicle attributes)
    const vehicleCreateRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "vehicle",
          title: "Toyota Innova Zenix Q Hybrid 2025",
          coverMediaId: 7,
          galleryMediaIds: [7, 8, 9],
          priceMode: "on_request",
          negotiable: true,
          ctaMode: "inquiry",
          unitStatus: "available",
          categoryIds: [catShared.id],
          attributes: {
            brand: "Toyota",
            model: "Innova Zenix",
            year: 2025,
            condition: "used",
            transmission: "cvt",
            fuelType: "hybrid",
            mileageKm: 8500,
            color: "Hitam Metalik",
            plateRegion: "B",
            otrPriceNote: "OTR Jabodetabek",
            unitStatus: "available",
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1300 },
    );
    expect(vehicleCreateRes.status).toBe(201);
    const vehicle = (await vehicleCreateRes.json()) as {
      id: number;
      publicPath: string;
      unitStatus: string;
      version: number;
    };
    expect(vehicle.id).toBe(4);
    expect(vehicle.publicPath).toBe("/kendaraan/toyota-innova-zenix-q-hybrid-2025");
    expect(vehicle.unitStatus).toBe("available");

    // 3. Publish all 4 offerings and verify atomic PLATFORM_DB.cache_version bump + published snapshots
    const beforeTenant = await createSqliteDrizzle(env.PLATFORM_DB, platformSchema)
      .select({ cacheVersion: tenants.cacheVersion })
      .from(tenants)
      .where(eq(tenants.id, tenantA.id))
      .get();
    const initialCacheVersion = beforeTenant?.cacheVersion ?? 1;

    for (const [idx, item] of [service, product, tour, vehicle].entries()) {
      const pubRes = await handleTenantCatalogOfferingPublishRequest(
        tenantA.handle,
        String(item.id),
        makeAdminRequest(
          `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/${item.id}/publish`,
          "POST",
          {
            cookie: ownerA.cookie,
            body: { expectedVersion: item.version },
          },
        ),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 2000 + idx * 100 },
      );
      expect(pubRes.status).toBe(200);
      const pubBody = (await pubRes.json()) as {
        status: string;
        version: number;
        cacheVersion: number;
        revisionNumber: number;
        attributes: Record<string, unknown>;
      };
      expect(pubBody.status).toBe("published");
      expect(pubBody.version).toBe(2);
      expect(pubBody.cacheVersion).toBe(initialCacheVersion + idx + 1);
      expect(pubBody.revisionNumber).toBe(1);

      // Verify published snapshot is readable via TASK-027 public extractor
      const publicDto = await getPublishedResource(tenantA.db, {
        resourceType: "offering",
        resourceId: item.id,
      });
      expect(publicDto).not.toBeNull();
      expect(publicDto?.data.offeringType).toBe(
        idx === 0 ? "service" : idx === 1 ? "product" : idx === 2 ? "tour" : "vehicle",
      );
    }

    // Verify rich per-type attributes survived publication intact on GET
    const getVehicleRes = await handleTenantCatalogOfferingRequest(
      tenantA.handle,
      String(vehicle.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/${vehicle.id}`,
        "GET",
        { cookie: ownerA.cookie },
      ),
      runtimeEnv,
    );
    expect(getVehicleRes.status).toBe(200);
    const reloadedVehicle = (await getVehicleRes.json()) as {
      attributes: { brand?: string; model?: string; otrPriceNote?: string };
      version: number;
    };
    expect(reloadedVehicle.attributes.brand).toBe("Toyota");
    expect(reloadedVehicle.attributes.otrPriceNote).toBe("OTR Jabodetabek");

    // 4. Draft PATCH on published service changes slug (tracking former slug) without leaking into published snapshot
    const patchRes = await handleTenantCatalogOfferingRequest(
      tenantA.handle,
      String(service.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/${service.id}`,
        "PATCH",
        {
          cookie: editorA.cookie,
          body: {
            expectedVersion: 2,
            title: "Konsultasi Pajak Pro",
            slug: "konsultasi-pajak-pro",
          },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3000 },
    );
    expect(patchRes.status).toBe(200);
    const patchedService = (await patchRes.json()) as { slug: string; version: number };
    expect(patchedService.slug).toBe("konsultasi-pajak-pro");
    expect(patchedService.version).toBe(3);

    // Former slug must block another service from stealing it (422 SLUG_CONFLICT)
    const stealFormerSlugRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "service",
          title: "Pencuri Slug",
          slug: service.slug,
          priceMode: "on_request",
          ctaMode: "inquiry",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3100 },
    );
    expect(stealFormerSlugRes.status).toBe(422);

    // Category referenced by published offering cannot be deleted (409)
    const delInUseCatRes = await handleTenantCatalogCategoryRequest(
      tenantA.handle,
      String(catRoot.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories/${catRoot.id}`,
        "DELETE",
        { cookie: ownerA.cookie, body: { expectedVersion: catRoot.version } },
      ),
      runtimeEnv,
    );
    expect(delInUseCatRes.status).toBe(409);

    // 5. Unpublish service -> returns to draft & getPublishedResource returns null
    const unpubRes = await handleTenantCatalogOfferingUnpublishRequest(
      tenantA.handle,
      String(service.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/${service.id}/unpublish`,
        "POST",
        {
          cookie: ownerA.cookie,
          body: { expectedVersion: patchedService.version },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4000 },
    );
    expect(unpubRes.status).toBe(200);
    const unpubBody = (await unpubRes.json()) as { status: string; version: number };
    expect(unpubBody.status).toBe("draft");
    expect(unpubBody.version).toBe(4);
    expect(
      await getPublishedResource(tenantA.db, {
        resourceType: "offering",
        resourceId: service.id,
      }),
    ).toBeNull();

    // 6. Soft delete product -> 204 & subsequent GET -> 404
    const delProductRes = await handleTenantCatalogOfferingRequest(
      tenantA.handle,
      String(product.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/${product.id}`,
        "DELETE",
        {
          cookie: ownerA.cookie,
          body: { expectedVersion: 2 },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );
    expect(delProductRes.status).toBe(204);
    expect(delProductRes.headers.get("cache-control")).toBe("no-store");

    const getDeletedRes = await handleTenantCatalogOfferingRequest(
      tenantA.handle,
      String(product.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/${product.id}`,
        "GET",
        { cookie: ownerA.cookie },
      ),
      runtimeEnv,
    );
    expect(getDeletedRes.status).toBe(404);
  });

  it("rejects cross-tenant media/category IDs, invalid prices, unsafe externalUrl, >12 gallery, and missing WA config with 422", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const { tenantA, tenantB, ownerA, ownerB } = await provisionTwoCatalogTenants("02", runtimeEnv);

    // Create category #1 exclusively inside Tenant B
    const catBRes = await handleTenantCatalogCategoriesRequest(
      tenantB.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/catalog/categories`, "POST", {
        cookie: ownerB.cookie,
        body: { name: "Kategori Eksklusif Beta" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(catBRes.status).toBe(201);
    const catB = (await catBRes.json()) as { id: number };

    // 1. Tenant A tries to reference Tenant B's media #901 -> 422 MEDIA_NOT_FOUND
    const foreignMediaRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "product",
          title: "Produk Media Asing",
          coverMediaId: 901,
          priceMode: "fixed",
          price: 100_000,
          ctaMode: "inquiry",
        },
      }),
      runtimeEnv,
    );
    expect(foreignMediaRes.status).toBe(422);
    const foreignMediaErr = (await foreignMediaRes.json()) as {
      error: { fields?: Array<{ code: string }> };
    };
    expect(foreignMediaErr.error.fields?.[0]?.code).toBe("MEDIA_NOT_FOUND");

    // 2. Quarantined media #99 in Tenant A -> 422 MEDIA_NOT_FOUND
    const quarantinedMediaRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "product",
          title: "Produk Media Karantina",
          galleryMediaIds: [1, 99],
          priceMode: "fixed",
          price: 100_000,
          ctaMode: "inquiry",
        },
      }),
      runtimeEnv,
    );
    expect(quarantinedMediaRes.status).toBe(422);

    // 3. Tenant A tries to reference Tenant B's category ID -> 422 CATEGORY_NOT_FOUND
    const foreignCatRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "product",
          title: "Produk Kategori Asing",
          categoryIds: [catB.id],
          priceMode: "fixed",
          price: 100_000,
          ctaMode: "inquiry",
        },
      }),
      runtimeEnv,
    );
    expect(foreignCatRes.status).toBe(422);
    const foreignCatErr = (await foreignCatRes.json()) as {
      error: { fields?: Array<{ code: string }> };
    };
    expect(foreignCatErr.error.fields?.[0]?.code).toBe("CATEGORY_NOT_FOUND");

    // 4. Gallery with 13 images -> 422 GALLERY_LIMIT_EXCEEDED
    const tooManyGalleryRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "product",
          title: "Galeri Kebanyakan",
          galleryMediaIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
          priceMode: "fixed",
          price: 100_000,
          ctaMode: "inquiry",
        },
      }),
      runtimeEnv,
    );
    expect(tooManyGalleryRes.status).toBe(422);

    // 5. Invalid range price (priceMax < price) -> 422
    const badPriceRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "tour",
          title: "Tur Harga Terbalik",
          priceMode: "range",
          price: 5_000_000,
          priceMax: 3_000_000,
          ctaMode: "book",
        },
      }),
      runtimeEnv,
    );
    expect(badPriceRes.status).toBe(422);

    // 6. Unsafe external_link URL -> 422
    const badLinkRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "product",
          title: "Link Berbahaya",
          priceMode: "fixed",
          price: 50_000,
          ctaMode: "external_link",
          externalUrl: "javascript:alert(document.cookie)",
        },
      }),
      runtimeEnv,
    );
    expect(badLinkRes.status).toBe(422);

    // 7. Tenant B (no WA configured!) using ctaMode: "whatsapp" without override -> 422 MISSING_WHATSAPP_CONFIG
    const missingWaRes = await handleTenantCatalogCollectionRequest(
      tenantB.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/catalog`, "POST", {
        cookie: ownerB.cookie,
        body: {
          offeringType: "service",
          title: "Layanan Tanpa WA",
          priceMode: "on_request",
          ctaMode: "whatsapp",
        },
      }),
      runtimeEnv,
    );
    expect(missingWaRes.status).toBe(422);
    const missingWaErr = (await missingWaRes.json()) as {
      error: { fields?: Array<{ code: string }> };
    };
    expect(missingWaErr.error.fields?.[0]?.code).toBe("MISSING_WHATSAPP_CONFIG");

    // 8. Forbidden tenantId in request body -> 422
    const forbiddenSelectorRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          tenantId: tenantB.id,
          offeringType: "service",
          title: "Serangan Selector",
          priceMode: "on_request",
          ctaMode: "inquiry",
        },
      }),
      runtimeEnv,
    );
    expect(forbiddenSelectorRes.status).toBe(422);
  });

  it("enforces optimistic concurrency (409), host isolation (404), non-member isolation (404), CSRF (403), and locked tenant read-only (403)", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const { tenantA, ownerA, ownerB } = await provisionTwoCatalogTenants("03", runtimeEnv);

    // Create offering #1 in Tenant A
    const createRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "service",
          title: "Layanan Awal",
          priceMode: "fixed",
          price: 500_000,
          ctaMode: "whatsapp",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: number; version: number };

    // Update once to version 2
    const patch1 = await handleTenantCatalogOfferingRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/${created.id}`,
        "PATCH",
        {
          cookie: ownerA.cookie,
          body: { expectedVersion: 1, title: "Layanan Revisi 2" },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 100 },
    );
    expect(patch1.status).toBe(200);

    // 1. Stale expectedVersion (1) on PATCH -> 409 STALE_VERSION
    const stalePatch = await handleTenantCatalogOfferingRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/${created.id}`,
        "PATCH",
        {
          cookie: ownerA.cookie,
          body: { expectedVersion: 1, title: "Harus Gagal" },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 200 },
    );
    expect(stalePatch.status).toBe(409);

    // 2. Stale expectedVersion (1) on publish -> 409 STALE_VERSION
    const stalePublish = await handleTenantCatalogOfferingPublishRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/${created.id}/publish`,
        "POST",
        {
          cookie: ownerA.cookie,
          body: { expectedVersion: 1 },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 300 },
    );
    expect(stalePublish.status).toBe(409);

    // 3. Non-member (ownerB) accessing Tenant A -> neutral 404
    const nonMemberGet = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "GET", {
        cookie: ownerB.cookie,
      }),
      runtimeEnv,
    );
    expect(nonMemberGet.status).toBe(404);

    // 4. Unauthenticated request -> 401
    const unauthGet = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "GET"),
      runtimeEnv,
    );
    expect(unauthGet.status).toBe(401);

    // 5. Public tenant host or console host -> neutral 404
    const wrongHost = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(
        `https://${tenantA.handle}.situsku.click/api/tenants/${tenantA.handle}/catalog`,
        "GET",
        { cookie: ownerA.cookie },
      ),
      runtimeEnv,
    );
    expect(wrongHost.status).toBe(404);

    // 6. Cross-origin POST -> 403 CSRF denial
    const badOrigin = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        origin: "https://evil.example",
        body: {
          offeringType: "service",
          title: "CSRF Attack",
          priceMode: "on_request",
          ctaMode: "inquiry",
        },
      }),
      runtimeEnv,
    );
    expect(badOrigin.status).toBe(403);

    // 7. Lock Tenant A (paidThrough expired 5 days ago -> H+4..H+7 locked window)
    const platformDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const fiveDaysAgo = new Date(BASE_NOW_MS - 5 * 24 * 60 * 60 * 1000);
    await platformDb
      .update(tenants)
      .set({ status: "locked", paidThrough: fiveDaysAgo })
      .where(eq(tenants.id, tenantA.id));

    const lockedGet = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedGet.status).toBe(200);

    const lockedCreate = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "service",
          title: "Tidak Boleh Saat Terkunci",
          priceMode: "on_request",
          ctaMode: "inquiry",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedCreate.status).toBe(403);
    const lockedCreateBody = (await lockedCreate.json()) as { error: { code: string } };
    expect(lockedCreateBody.error.code).toBe("SUBSCRIPTION_LOCKED");

    const lockedPublish = await handleTenantCatalogOfferingPublishRequest(
      tenantA.handle,
      String(created.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/${created.id}/publish`,
        "POST",
        {
          cookie: ownerA.cookie,
          body: { expectedVersion: 2 },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedPublish.status).toBe(403);

    const lockedCatCreate = await handleTenantCatalogCategoriesRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories`, "POST", {
        cookie: ownerA.cookie,
        body: { name: "Kategori Saat Terkunci" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedCatCreate.status).toBe(403);
  });

  it("guarantees zero side effects under concurrent PATCHes and stale/concurrent category DELETE, and blocks offeringType change on in-use categories", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const { tenantA, ownerA, editorA } = await provisionTwoCatalogTenants("04", runtimeEnv);

    // Seed two categories in Tenant A
    const cat1Res = await handleTenantCatalogCategoriesRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories`, "POST", {
        cookie: ownerA.cookie,
        body: { name: "Kategori Alpha", offeringType: "service" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(cat1Res.status).toBe(201);
    const cat1 = (await cat1Res.json()) as { id: number; slug: string; version: number };

    const cat2Res = await handleTenantCatalogCategoriesRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories`, "POST", {
        cookie: ownerA.cookie,
        body: { name: "Kategori Beta", offeringType: "service" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10 },
    );
    expect(cat2Res.status).toBe(201);
    const cat2 = (await cat2Res.json()) as { id: number; slug: string; version: number };

    // Create offering #1 initially linked to cat1
    const offRes = await handleTenantCatalogCollectionRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog`, "POST", {
        cookie: ownerA.cookie,
        body: {
          offeringType: "service",
          title: "Jasa Race Test",
          slug: "jasa-race-awal",
          priceMode: "fixed",
          price: 300_000,
          ctaMode: "whatsapp",
          categoryIds: [cat1.id],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 20 },
    );
    expect(offRes.status).toBe(201);
    const offering = (await offRes.json()) as { id: number; version: number };

    // 1. Changing cat1's offeringType while linked to offering #1 must fail with 422 CATEGORY_IN_USE
    const badCatTypeRes = await handleTenantCatalogCategoryRequest(
      tenantA.handle,
      String(cat1.id),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories/${cat1.id}`,
        "PATCH",
        {
          cookie: ownerA.cookie,
          body: { expectedVersion: cat1.version, offeringType: "product" },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 30 },
    );
    expect(badCatTypeRes.status).toBe(422);
    const badCatTypeBody = (await badCatTypeRes.json()) as {
      error: { fields?: Array<{ code: string }> };
    };
    expect(badCatTypeBody.error.fields?.[0]?.code).toBe("CATEGORY_IN_USE");

    // 2. Fire two concurrent PATCHes with the SAME expectedVersion=1, changing categories and slug
    const [raceResA, raceResB] = await Promise.all([
      handleTenantCatalogOfferingRequest(
        tenantA.handle,
        String(offering.id),
        makeAdminRequest(
          `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/${offering.id}`,
          "PATCH",
          {
            cookie: ownerA.cookie,
            body: {
              expectedVersion: offering.version,
              title: "Jasa Pemenang A",
              slug: "jasa-race-a",
              categoryIds: [cat1.id],
            },
          },
        ),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 100 },
      ),
      handleTenantCatalogOfferingRequest(
        tenantA.handle,
        String(offering.id),
        makeAdminRequest(
          `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/${offering.id}`,
          "PATCH",
          {
            cookie: editorA.cookie,
            body: {
              expectedVersion: offering.version,
              title: "Jasa Pemenang B",
              slug: "jasa-race-b",
              categoryIds: [cat2.id],
            },
          },
        ),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 101 },
      ),
    ]);

    const statuses = [raceResA.status, raceResB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const winnerRes = raceResA.status === 200 ? raceResA : raceResB;
    const loserRes = raceResA.status === 409 ? raceResA : raceResB;
    const winnerSlug = raceResA.status === 200 ? "jasa-race-a" : "jasa-race-b";
    const loserSlug = raceResA.status === 200 ? "jasa-race-b" : "jasa-race-a";
    const winnerCatId = raceResA.status === 200 ? cat1.id : cat2.id;
    const loserCatId = raceResA.status === 200 ? cat2.id : cat1.id;

    const winnerBody = (await winnerRes.json()) as { slug: string; version: number; categoryIds: number[] };
    const loserBody = (await loserRes.json()) as { error: { code: string } };
    expect(winnerBody.slug).toBe(winnerSlug);
    expect(winnerBody.version).toBe(2);
    expect(winnerBody.categoryIds).toEqual([winnerCatId]);
    expect(loserBody.error.code).toBe("STALE_VERSION");

    // Verify directly in TenantStore SQLite that ZERO loser categories or slugs were written!
    const storedLinks = await tenantA.db
      .prepare(`SELECT taxonomy_id FROM offering_taxonomies WHERE offering_id = ?`)
      .bind(offering.id)
      .all<{ taxonomy_id: number }>();
    expect(storedLinks.results.map((r) => Number(r.taxonomy_id))).toEqual([winnerCatId]);
    expect(storedLinks.results.map((r) => Number(r.taxonomy_id))).not.toContain(loserCatId);

    const storedSlugs = await tenantA.db
      .prepare(`SELECT slug, is_current FROM resource_slugs WHERE namespace = 'layanan' AND resource_id = ?`)
      .bind(offering.id)
      .all<{ slug: string; is_current: number }>();
    expect(storedSlugs.results.map((r) => r.slug)).toEqual([winnerSlug]);
    expect(storedSlugs.results.map((r) => r.slug)).not.toContain(loserSlug);

    // 3. Stale DELETE on winnerCatId (first bump its version to 2, then send DELETE with stale version 1)
    const catUpdateRes = await handleTenantCatalogCategoryRequest(
      tenantA.handle,
      String(winnerCatId),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories/${winnerCatId}`,
        "PATCH",
        {
          cookie: ownerA.cookie,
          body: { expectedVersion: 1, name: "Kategori Diperbarui" },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 200 },
    );
    expect(catUpdateRes.status).toBe(200);

    const staleDeleteCatRes = await handleTenantCatalogCategoryRequest(
      tenantA.handle,
      String(winnerCatId),
      makeAdminRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories/${winnerCatId}`,
        "DELETE",
        {
          cookie: ownerA.cookie,
          body: { expectedVersion: 1 },
        },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 210 },
    );
    expect(staleDeleteCatRes.status).toBe(409);
    const staleDeleteErr = (await staleDeleteCatRes.json()) as { error: { code: string } };
    expect(staleDeleteErr.error.code).toBe("STALE_VERSION");

    // Verify offering_taxonomies and resource_slugs for winnerCatId remain 100% intact!
    const catLinksAfterStale = await tenantA.db
      .prepare(`SELECT offering_id FROM offering_taxonomies WHERE taxonomy_id = ?`)
      .bind(winnerCatId)
      .all<{ offering_id: number }>();
    expect(catLinksAfterStale.results.map((r) => Number(r.offering_id))).toEqual([offering.id]);

    const catSlugsAfterStale = await tenantA.db
      .prepare(`SELECT slug FROM resource_slugs WHERE namespace = 'offering_category' AND resource_id = ?`)
      .bind(winnerCatId)
      .all<{ slug: string }>();
    expect(catSlugsAfterStale.results.length).toBeGreaterThanOrEqual(1);

    // 4. Concurrent PATCH (version 2) vs DELETE (version 2) on winnerCatId:
    //    whichever loses returns 409 STALE_VERSION and leaves the winner's state completely intact!
    const [catPatchRace, catDeleteRace] = await Promise.all([
      handleTenantCatalogCategoryRequest(
        tenantA.handle,
        String(winnerCatId),
        makeAdminRequest(
          `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories/${winnerCatId}`,
          "PATCH",
          {
            cookie: ownerA.cookie,
            body: { expectedVersion: 2, name: "Kategori Race Patch", slug: "kategori-race-patch" },
          },
        ),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 300 },
      ),
      handleTenantCatalogCategoryRequest(
        tenantA.handle,
        String(winnerCatId),
        makeAdminRequest(
          `${APP_ORIGIN}/api/tenants/${tenantA.handle}/catalog/categories/${winnerCatId}`,
          "DELETE",
          {
            cookie: editorA.cookie,
            body: { expectedVersion: 2 },
          },
        ),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 301 },
      ),
    ]);

    if (catPatchRace.status === 200) {
      expect(catDeleteRace.status).toBe(409);
      const linksStillIntact = await tenantA.db
        .prepare(`SELECT offering_id FROM offering_taxonomies WHERE taxonomy_id = ?`)
        .bind(winnerCatId)
        .all<{ offering_id: number }>();
      expect(linksStillIntact.results.map((r) => Number(r.offering_id))).toEqual([offering.id]);
      const slugsStillIntact = await tenantA.db
        .prepare(`SELECT slug FROM resource_slugs WHERE namespace = 'offering_category' AND resource_id = ? AND is_current = 1`)
        .bind(winnerCatId)
        .all<{ slug: string }>();
      expect(slugsStillIntact.results.map((r) => r.slug)).toEqual(["kategori-race-patch"]);
    } else {
      expect(catDeleteRace.status).toBe(204);
      expect([404, 409]).toContain(catPatchRace.status);
      const linksCleaned = await tenantA.db
        .prepare(`SELECT offering_id FROM offering_taxonomies WHERE taxonomy_id = ?`)
        .bind(winnerCatId)
        .all<{ offering_id: number }>();
      expect(linksCleaned.results).toEqual([]);
      const slugsCleaned = await tenantA.db
        .prepare(`SELECT slug FROM resource_slugs WHERE namespace = 'offering_category' AND resource_id = ?`)
        .bind(winnerCatId)
        .all<{ slug: string }>();
      expect(slugsCleaned.results).toEqual([]);
    }
  });
});

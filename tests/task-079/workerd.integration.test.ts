import { env } from "cloudflare:workers";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  sessions,
  tenantHosts,
  tenants,
  users,
} from "@punyasitus/db/platform";
import { publishResourceAtomically, saveDraftResource } from "@punyasitus/db/publication/index";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildGatedVehicleCreditEstimateTable,
  filterVehicleGridItems,
  type VehicleShowroomAttributes,
} from "../../packages/core/src/catalog/vehicle.ts";
import { generateSchemaGraph } from "../../packages/core/src/schema-generator.ts";
import {
  resolveOfferingDetailRoute,
  resolveOfferingListingRoute,
  type PublicRouteDeps,
} from "../../apps/web/src/core/public-routes.ts";
import {
  handleDashboardVehiclesApiRequest,
  loadFrozenPublishedVehicleBySlug,
  loadFrozenPublishedVehicleMapBySlugs,
  loadLosslessDraftVehicleMap,
  type DashboardVehiclesRuntimeEnv,
} from "../../apps/web/src/pages/dashboard/[handle]/catalog/vehicles/_api-handler.ts";

const BASE_TIME = 1_855_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TENANT_A = {
  id: "01JT079DEALERA000000000001",
  orgId: "org_t079_dealer_a",
  handle: "bintang-showroom",
  name: "Bintang Motor Showroom",
  subdomain: "bintang-showroom.situsku.click",
  customDomain: "www.bintangshowroom.id",
  ownerId: "user_t079_owner_a",
  sessionId: "sess_t079_owner_a",
} as const;

const TENANT_B = {
  id: "01JT079DEALERB000000000002",
  orgId: "org_t079_dealer_b",
  handle: "garuda-motor",
  name: "Garuda Motor",
  subdomain: "garuda-motor.situsku.click",
  ownerId: "user_t079_owner_b",
  sessionId: "sess_t079_owner_b",
} as const;

function makeRuntimeEnv(): DashboardVehiclesRuntimeEnv {
  return {
    APP_ENV: "production",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: "t079-workerd-test-secret-0123456789abcdef",
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
  };
}

function makePublicDeps(): PublicRouteDeps {
  return {
    platformDb: env.PLATFORM_DB,
    tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    platformDomain: "punyasitus.com",
    saasZone: "situsku.click",
    nowMs: BASE_TIME,
    bypassHostCache: true,
  };
}

function makeApiRequest(handle: string, body: unknown): Request {
  return new Request(
    `https://app.punyasitus.com/dashboard/${handle}/catalog/vehicles/api`,
    {
      method: "POST",
      headers: {
        Origin: "https://app.punyasitus.com",
        "X-PunyaSitus-CSRF": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

async function seedTenantWithOwner(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly subdomain: string;
  readonly customDomain?: string;
  readonly ownerId: string;
  readonly sessionId: string;
}): Promise<D1Database> {
  const now = new Date(BASE_TIME);
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  await pDb
    .insert(users)
    .values({
      id: spec.ownerId,
      name: `Owner ${spec.name}`,
      email: `${spec.handle}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(sessions)
    .values({
      id: spec.sessionId,
      userId: spec.ownerId,
      token: `tok_${spec.sessionId}`,
      activeOrganizationId: spec.orgId,
      expiresAt: new Date(BASE_TIME + 4 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

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
    .insert(members)
    .values({
      id: `mem_${spec.ownerId}`,
      organizationId: spec.orgId,
      userId: spec.ownerId,
      role: "owner",
      createdAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenants)
    .values({
      id: spec.id,
      organizationId: spec.orgId,
      handle: spec.handle,
      name: spec.name,
      status: "active",
      paidThrough: new Date(BASE_TIME + 30 * DAY_MS),
      cacheVersion: 1,
      schemaVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const hosts = spec.customDomain
    ? [
        {
          host: spec.customDomain,
          tenantId: spec.id,
          kind: "custom" as const,
          status: "active" as const,
          sslStatus: "active" as const,
          isPrimary: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          host: spec.subdomain,
          tenantId: spec.id,
          kind: "subdomain" as const,
          status: "active" as const,
          sslStatus: "active" as const,
          isPrimary: false,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ]
    : [
        {
          host: spec.subdomain,
          tenantId: spec.id,
          kind: "subdomain" as const,
          status: "active" as const,
          sslStatus: "active" as const,
          isPrimary: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ];

  for (const hr of hosts) {
    await pDb.insert(tenantHosts).values(hr).onConflictDoNothing();
  }

  const stub = openTenantStoreStub(
    env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    spec.id,
  );
  await orchestrateTenantMigration(env.PLATFORM_DB, stub, spec.id, TENANT_MIGRATIONS);
  const tenantDb = createTenantDb(stub);

  // Seed published site_settings & business_profile via canonical publication helpers
  await tenantDb
    .prepare(
      `INSERT OR IGNORE INTO site_settings (
         id, site_title, tagline, timezone, locale, active_theme_id,
         blog_enabled, catalog_enabled, ai_training_policy, version, updated_at
       ) VALUES (1, ?, 'Showroom Mobil & Motor Terpercaya', 'Asia/Jakarta', 'id-ID', 'dealer', 1, 1, 'allow', 1, ?)`,
    )
    .bind(spec.name, BASE_TIME)
    .run();

  await tenantDb
    .prepare(
      `INSERT OR IGNORE INTO business_profile (
         id, business_name, business_category, description,
         address, city, province, whatsapp_e164, phone, email,
         weekday_hours_json, version, updated_at
       ) VALUES (1, ?, 'AutoDealer', 'Showroom resmi mobil dan motor.', 'Jl. Fatmawati No. 88', 'Jakarta Selatan', 'DKI Jakarta', '6281122334455', '6281122334455', ?, 'Senin–Minggu 09.00–18.00 WIB', 1, ?)`,
    )
    .bind(spec.name, `halo@${spec.handle}.id`, BASE_TIME)
    .run();

  await saveDraftResource(tenantDb, {
    resourceType: "site_settings",
    resourceId: 1,
    expectedVersion: 1,
    nowMs: BASE_TIME,
    draft: {
      siteTitle: spec.name,
      tagline: "Showroom Mobil & Motor Terpercaya",
      timezone: "Asia/Jakarta",
      locale: "id-ID",
      activeThemeId: "dealer",
      blogEnabled: true,
      catalogEnabled: true,
      siteVisibility: "public",
      aiTrainingPolicy: "allow",
    },
  });
  await publishResourceAtomically(env.PLATFORM_DB, tenantDb, {
    tenantId: spec.id,
    resourceType: "site_settings",
    resourceId: 1,
    expectedVersion: 2,
    nowMs: BASE_TIME + 1,
  });

  await saveDraftResource(tenantDb, {
    resourceType: "business_profile",
    resourceId: 1,
    expectedVersion: 1,
    nowMs: BASE_TIME,
    draft: {
      businessName: spec.name,
      businessCategory: "AutoDealer",
      description: "Showroom resmi mobil dan motor.",
      address: "Jl. Fatmawati No. 88",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      whatsappE164: "6281122334455",
      phone: "6281122334455",
      email: `halo@${spec.handle}.id`,
      weekdayHours: "Senin–Minggu 09.00–18.00 WIB",
      socialLinks: [],
    },
  });
  await publishResourceAtomically(env.PLATFORM_DB, tenantDb, {
    tenantId: spec.id,
    resourceType: "business_profile",
    resourceId: 1,
    expectedVersion: 2,
    nowMs: BASE_TIME + 2,
  });

  return tenantDb;
}

describe("TASK-079 workerd Integration: Vehicle Showroom CRUD, OCC, Status Transitions & Frozen Public Reads", () => {
  let tenantADb: D1Database;
  let tenantBDb: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    tenantADb = await seedTenantWithOwner(TENANT_A);
    tenantBDb = await seedTenantWithOwner(TENANT_B);
  });

  beforeEach(() => {
    clearHostResolutionCache();
  });

  it("runs create -> reject invalid new+mileage -> OCC 409 -> atomic publish -> draft isolation -> booked/sold transitions -> indexable sold detail", async () => {
    const runtimeEnv = makeRuntimeEnv();
    const authOpts = {
      authenticatedUser: { id: TENANT_A.ownerId },
      authenticatedSessionId: TENANT_A.sessionId,
      activeOrganizationId: TENANT_A.orgId,
      nowMs: BASE_TIME,
    };

    // 0a. MEDIUM-3: authenticatedUser WITHOUT authenticatedSessionId MUST fail closed with 401!
    const noSessionRes = await handleDashboardVehiclesApiRequest(
      TENANT_A.handle,
      makeApiRequest(TENANT_A.handle, { action: "save_draft", title: "Should Fail 401" }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        authenticatedSessionId: null,
        activeOrganizationId: TENANT_A.orgId,
        nowMs: BASE_TIME,
      },
    );
    expect(noSessionRes.status).toBe(401);

    // 0b. MEDIUM-2: Content-Length > 128 KiB precheck returns 413 PAYLOAD_TOO_LARGE
    const oversizeReq = new Request(
      `https://app.punyasitus.com/dashboard/${TENANT_A.handle}/catalog/vehicles/api`,
      {
        method: "POST",
        headers: {
          Origin: "https://app.punyasitus.com",
          "X-PunyaSitus-CSRF": "1",
          "Content-Type": "application/json",
          "Content-Length": "200000",
        },
        body: JSON.stringify({ action: "save_draft" }),
      },
    );
    const oversizeRes = await handleDashboardVehiclesApiRequest(
      TENANT_A.handle,
      oversizeReq,
      runtimeEnv,
      authOpts,
    );
    expect(oversizeRes.status).toBe(413);

    // 1. Reject `new` motorcycle carrying mileageKm: 0 (422)
    const badNewRes = await handleDashboardVehiclesApiRequest(
      TENANT_A.handle,
      makeApiRequest(TENANT_A.handle, {
        action: "save_draft",
        title: "Yamaha NMAX Turbo 2026",
        vehicle: {
          vehicleCategory: "motorcycle",
          brand: "Yamaha",
          model: "NMAX Turbo",
          year: 2026,
          condition: "new",
          mileageKm: 0,
          transmission: "cvt",
          fuel: "bensin",
          bodyType: "matic",
          color: "Hitam",
          engineCc: 155,
          location: "Jakarta Selatan",
          priceModel: "fixed",
          priceIdr: 45_250_000,
          negotiable: false,
          unitStatus: "available",
          hideSoldInGrids: false,
        },
      }),
      runtimeEnv,
      authOpts,
    );
    expect(badNewRes.status).toBe(422);

    // 2. Create draft used car (`available` + `fixed` + credit estimate enabled + sales WA override)
    const usedCarPayload: VehicleShowroomAttributes = {
      vehicleCategory: "car",
      brand: "Toyota",
      model: "Kijang Innova Zenix",
      variant: "Q Hybrid Modellista",
      year: 2024,
      condition: "used",
      mileageKm: 18500,
      transmission: "cvt",
      fuel: "hybrid",
      bodyType: "mpv",
      color: "Putih Mutiara",
      seats: 7,
      engineCc: 1987,
      location: "Jakarta Selatan",
      plateRegion: "B (Jakarta)",
      stnkTaxExpiryDate: "2027-08-15",
      ownershipCount: 1,
      priceModel: "fixed",
      priceIdr: 485_000_000,
      negotiable: true,
      unitStatus: "available",
      hideSoldInGrids: false,
      salesWhatsappOverride: "+62 812-7777-8888",
      creditEstimate: {
        enabled: true,
        flatAnnualRateBps: 650,
        dpPercents: [20, 30, 40],
        tenorMonths: [12, 24, 36, 48],
      },
    };

    const createRes = await handleDashboardVehiclesApiRequest(
      TENANT_A.handle,
      makeApiRequest(TENANT_A.handle, {
        action: "save_draft",
        title: "Toyota Kijang Innova Zenix Q Hybrid 2024",
        summary: "Unit tangan pertama, servis rutin bengkel resmi.",
        vehicle: usedCarPayload,
      }),
      runtimeEnv,
      authOpts,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: number;
      slug: string;
      publicPath: string;
      status: string;
      version: number;
      unitStatus: string;
      attributes: VehicleShowroomAttributes;
    };
    expect(created.status).toBe("draft");
    expect(created.publicPath).toBe(`/kendaraan/${created.slug}`);
    expect(created.attributes.salesWhatsappOverride).toBe("6281277778888");

    // Verify lossless draft map & that frozen published snapshot is still null before publish
    const draftMap = await loadLosslessDraftVehicleMap(tenantADb, [created.id]);
    expect(draftMap.get(created.id)?.stnkTaxExpiryDate).toBe("2027-08-15");
    expect(await loadFrozenPublishedVehicleBySlug(tenantADb, created.slug)).toBeNull();

    // 3. Publish unit (`available` + `fixed`) -> frozen public read succeeds & credit table renders
    const pubRes = await handleDashboardVehiclesApiRequest(
      TENANT_A.handle,
      makeApiRequest(TENANT_A.handle, {
        action: "publish",
        id: created.id,
        expectedVersion: created.version,
        title: "Toyota Kijang Innova Zenix Q Hybrid 2024",
        summary: "Unit tangan pertama, servis rutin bengkel resmi.",
        vehicle: usedCarPayload,
      }),
      runtimeEnv,
      authOpts,
    );
    expect(pubRes.status).toBe(200);
    const published = (await pubRes.json()) as typeof created;
    expect(published.status).toBe("published");
    expect(published.version).toBeGreaterThan(created.version);

    const frozenAvail = await loadFrozenPublishedVehicleBySlug(tenantADb, published.slug);
    expect(frozenAvail).not.toBeNull();
    expect(frozenAvail!.unitStatus).toBe("available");
    expect(
      buildGatedVehicleCreditEstimateTable({
        publicationStatus: "published",
        unitStatus: frozenAvail!.unitStatus,
        priceModel: frozenAvail!.priceModel,
        priceIdr: frozenAvail!.priceIdr,
        creditEstimate: frozenAvail!.creditEstimate,
      }),
    ).not.toBeNull();

    // 4. Stale expectedVersion -> 409 STALE_VERSION
    const staleRes = await handleDashboardVehiclesApiRequest(
      TENANT_A.handle,
      makeApiRequest(TENANT_A.handle, {
        action: "save_draft",
        id: created.id,
        expectedVersion: created.version, // stale!
        title: "Stale Edit",
        vehicle: usedCarPayload,
      }),
      runtimeEnv,
      authOpts,
    );
    expect(staleRes.status).toBe(409);

    // 5. MEDIUM-4: Draft-only transition to `booked` AND price drop MUST NOT leak into frozen published snapshot
    //    (neither `/kendaraan/[slug]` detail NOR `/kendaraan` grid map)!
    const draftBookedRes = await handleDashboardVehiclesApiRequest(
      TENANT_A.handle,
      makeApiRequest(TENANT_A.handle, {
        action: "save_draft",
        id: created.id,
        expectedVersion: published.version,
        title: "Toyota Kijang Innova Zenix Q Hybrid 2024",
        vehicle: { ...usedCarPayload, unitStatus: "booked", priceIdr: 399_000_000 },
      }),
      runtimeEnv,
      authOpts,
    );
    expect(draftBookedRes.status).toBe(200);
    const draftBooked = (await draftBookedRes.json()) as typeof created;
    const stillFrozenDetail = await loadFrozenPublishedVehicleBySlug(tenantADb, published.slug);
    expect(stillFrozenDetail?.unitStatus).toBe("available");
    expect(stillFrozenDetail?.priceIdr).toBe(485_000_000);
    const stillFrozenGridMap = await loadFrozenPublishedVehicleMapBySlugs(tenantADb, [
      published.slug,
    ]);
    expect(stillFrozenGridMap.get(published.slug)?.unitStatus).toBe("available");
    expect(stillFrozenGridMap.get(published.slug)?.priceIdr).toBe(485_000_000);

    // 6. Publish `booked` -> frozen snapshot now `booked`, credit table hidden, JSON-LD omits availability
    const pubBookedRes = await handleDashboardVehiclesApiRequest(
      TENANT_A.handle,
      makeApiRequest(TENANT_A.handle, {
        action: "publish",
        id: created.id,
        expectedVersion: draftBooked.version,
        title: "Toyota Kijang Innova Zenix Q Hybrid 2024",
        vehicle: { ...usedCarPayload, unitStatus: "booked" },
      }),
      runtimeEnv,
      authOpts,
    );
    expect(pubBookedRes.status).toBe(200);
    const pubBooked = (await pubBookedRes.json()) as typeof created;

    const frozenBooked = await loadFrozenPublishedVehicleBySlug(tenantADb, published.slug);
    expect(frozenBooked?.unitStatus).toBe("booked");
    expect(
      buildGatedVehicleCreditEstimateTable({
        publicationStatus: "published",
        unitStatus: frozenBooked!.unitStatus,
        priceModel: frozenBooked!.priceModel,
        priceIdr: frozenBooked!.priceIdr,
        creditEstimate: frozenBooked!.creditEstimate,
      }),
    ).toBeNull();

    // 7. Publish `sold` -> detail route `/kendaraan/[slug]` STAYS 200 OK & indexable (NO noindex!),
    //    credit table hidden, SoldOut JSON-LD, and `hideSoldInGrids` filters it from grid!
    const pubSoldRes = await handleDashboardVehiclesApiRequest(
      TENANT_A.handle,
      makeApiRequest(TENANT_A.handle, {
        action: "publish",
        id: created.id,
        expectedVersion: pubBooked.version,
        title: "Toyota Kijang Innova Zenix Q Hybrid 2024",
        vehicle: { ...usedCarPayload, unitStatus: "sold", hideSoldInGrids: false },
      }),
      runtimeEnv,
      authOpts,
    );
    expect(pubSoldRes.status).toBe(200);

    // Also create & publish an available `new` motorcycle (`matic`, `on_request`)
    const motoRes = await handleDashboardVehiclesApiRequest(
      TENANT_A.handle,
      makeApiRequest(TENANT_A.handle, {
        action: "publish",
        title: "Yamaha NMAX Turbo Tech MAX 2026",
        summary: "Unit baru siap kirim warna Magma Black.",
        vehicle: {
          vehicleCategory: "motorcycle",
          brand: "Yamaha",
          model: "NMAX Turbo",
          variant: "Tech MAX",
          year: 2026,
          condition: "new",
          transmission: "cvt",
          fuel: "bensin",
          bodyType: "matic",
          color: "Magma Black",
          engineCc: 155,
          location: "Jakarta Selatan",
          priceModel: "on_request",
          negotiable: false,
          unitStatus: "available",
          hideSoldInGrids: false,
        },
      }),
      runtimeEnv,
      authOpts,
    );
    expect(motoRes.status).toBe(200);
    const pubMoto = (await motoRes.json()) as typeof created;

    // Resolve public detail route for SOLD car -> MUST be 200 OK and indexable!
    const soldDetail = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_A.customDomain}/kendaraan/${published.slug}`),
      makePublicDeps(),
      "vehicle",
      published.slug,
    );
    expect(soldDetail.kind).toBe("offering_detail");
    if (soldDetail.kind === "offering_detail") {
      expect(soldDetail.http.status).toBe(200);
      expect(soldDetail.seoMetadata.robots.toLowerCase()).not.toContain("noindex");
      expect(soldDetail.offering.unitStatus).toBe("sold");
      expect(soldDetail.offering.vehicleCreditRows).toEqual([]);
    }

    // Resolve listing route & verify `hideSoldInGrids` filters out sold car while keeping available motorcycle
    const listing = await resolveOfferingListingRoute(
      new Request(`https://${TENANT_A.customDomain}/kendaraan`),
      makePublicDeps(),
      "vehicle",
    );
    expect(listing.kind).toBe("offering_listing");
    if (listing.kind === "offering_listing") {
      expect(listing.items.length).toBe(2);
      const frozenMap = await loadFrozenPublishedVehicleMapBySlugs(
        tenantADb,
        listing.items.map((i) => i.slug),
      );
      expect(frozenMap.get(published.slug)?.unitStatus).toBe("sold");
      expect(frozenMap.get(pubMoto.slug)?.vehicleCategory).toBe("motorcycle");

      const allItems = listing.items.map((i) => ({
        slug: i.slug,
        unitStatus: frozenMap.get(i.slug)?.unitStatus ?? i.unitStatus,
      }));
      expect(filterVehicleGridItems(allItems, { hideSoldInGrids: false })).toHaveLength(2);
      const filtered = filterVehicleGridItems(allItems, { hideSoldInGrids: true });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.slug).toBe(pubMoto.slug);
    }

    // Verify Motorcycle on_request schema omits offers & mileage
    const frozenMoto = await loadFrozenPublishedVehicleBySlug(tenantADb, pubMoto.slug);
    const motoSchema = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: `/kendaraan/${pubMoto.slug}`,
        tenant: {
          tenantHandle: TENANT_A.handle,
          tenantStatus: "active",
          primaryHost: TENANT_A.customDomain,
          primaryHostKind: "custom",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
          verifiedTenantHosts: [TENANT_A.customDomain, TENANT_A.subdomain],
        },
      },
      siteName: TENANT_A.name,
      offering: {
        offeringType: "vehicle",
        title: "Yamaha NMAX Turbo Tech MAX 2026",
        priceMode: "on_request",
        price: null,
        ctaMode: "whatsapp",
        unitStatus: "available",
        attributes: frozenMoto!,
      },
    });
    const motoNode = motoSchema.nodes.find((n) => n["@type"] === "Motorcycle") as Record<
      string,
      unknown
    >;
    expect(motoNode).toBeDefined();
    expect(motoNode.offers).toBeUndefined();
    expect(motoNode.mileageFromOdometer).toBeUndefined();

    // 8. Cross-tenant isolation: Tenant B owner cannot mutate Tenant A workspace (neutral 404)
    const crossTenantRes = await handleDashboardVehiclesApiRequest(
      TENANT_A.handle,
      makeApiRequest(TENANT_A.handle, {
        action: "save_draft",
        title: "Cross-tenant Attack",
        vehicle: usedCarPayload,
      }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_B.ownerId },
        authenticatedSessionId: TENANT_B.sessionId,
        activeOrganizationId: TENANT_B.orgId,
        nowMs: BASE_TIME,
      },
    );
    expect(crossTenantRes.status).toBe(404);
    expect(await loadFrozenPublishedVehicleBySlug(tenantBDb, published.slug)).toBeNull();
  });
});

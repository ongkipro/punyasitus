import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import { applyTenantBranchesMigrations } from "@punyasitus/db/branches/migrations";
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
  getOutletById,
  listPublishedOutletsForPublic,
  mapOutletsToSchemaBranches,
  type OutletRecord,
} from "@punyasitus/db/outlets/index";
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
import {
  loadPublishedPublicOutlets,
  loadPublishedTenantShellData,
} from "../../apps/web/src/core/public-data.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantOutletItemRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/outlets/[outletId].ts";
import type { TenantOutletsRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/outlets/_shared.ts";
import { handleTenantOutletsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/outlets/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 9, 0, 0);

function buildRuntimeEnv(
  overrides: Partial<TenantOutletsRuntimeEnv> = {},
): TenantOutletsRuntimeEnv {
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
  const hit = cookies.find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!hit) throw new Error(`Missing session cookie: ${JSON.stringify(cookies)}`);
  return (hit.split(";")[0] ?? "").trim();
}

function makeAdminRequest(
  url: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  options: {
    readonly cookie?: string;
    readonly body?: unknown;
    readonly origin?: string | null;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (method !== "GET") {
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const originVal = options.origin === undefined ? APP_ORIGIN : options.origin;
    if (originVal !== null) {
      headers.set("Origin", originVal);
    }
  }
  return new Request(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function openMigratedTenantDb(tenantId: string, withBranchesMigration = true): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, (_instance, state) =>
    withBranchesMigration
      ? applyTenantBranchesMigrations(state.storage as unknown as StorageLike)
      : applyTenantMigrations(state.storage as unknown as StorageLike, TENANT_MIGRATIONS),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function signUpUser(
  email: string,
  name: string,
  runtimeEnv: TenantOutletsRuntimeEnv,
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

describe("TASK-019 workerd integration — Multi-Outlet CRUD, OCC 409, Cross-Tenant 404, CSRF 403 & Public Published-Only Filtering", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("persists weekly/holiday hours & coordinates, bumps cache_version, enforces OCC 409, cross-tenant 404, CSRF 403, RBAC, and published-only public filtering", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);
    const paidThrough = new Date(BASE_NOW_MS + 30 * 24 * 60 * 60 * 1000);

    const tenantAId = "01JT019ALPHA00000000000001";
    const handleA = "t019-alpha";
    const orgAId = "org-t019-alpha";

    const tenantBId = "01JT019BETA000000000000002";
    const handleB = "t019-beta";
    const orgBId = "org-t019-beta";

    const ownerA = await signUpUser("owner.t019.a@example.test", "Owner A", runtimeEnv);
    const editorA = await signUpUser("editor.t019.a@example.test", "Editor A", runtimeEnv);
    const ownerB = await signUpUser("owner.t019.b@example.test", "Owner B", runtimeEnv);

    await db.insert(organizations).values([
      { id: orgAId, name: "Kopi Kemang", slug: handleA, createdAt: now, updatedAt: now },
      { id: orgBId, name: "Toko Beta", slug: handleB, createdAt: now, updatedAt: now },
    ]);
    await db.insert(tenants).values([
      {
        id: tenantAId,
        organizationId: orgAId,
        handle: handleA,
        name: "Kopi Kemang",
        status: "active",
        vertical: "resto",
        paidThrough,
        cacheVersion: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: tenantBId,
        organizationId: orgBId,
        handle: handleB,
        name: "Toko Beta",
        status: "active",
        vertical: "catalog",
        paidThrough,
        cacheVersion: 1,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(members).values([
      { id: "mem-t019-owner-a", organizationId: orgAId, userId: ownerA.userId, role: "owner", createdAt: now },
      { id: "mem-t019-editor-a", organizationId: orgAId, userId: editorA.userId, role: "editor", createdAt: now },
      { id: "mem-t019-owner-b", organizationId: orgBId, userId: ownerB.userId, role: "owner", createdAt: now },
    ]);

    const tenantDbA = await openMigratedTenantDb(tenantAId, true);
    await openMigratedTenantDb(tenantBId, false); // Verify 0001-only schema also works cleanly!

    // 1. CSRF/Origin check: missing or evil Origin -> 403
    const badCsrfRes = await handleTenantOutletsCollectionRequest(
      handleA,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets`, "POST", {
        cookie: ownerA.cookie,
        origin: "https://evil.example",
        body: { name: "Gerai CSRF", address: "Jl. Evil No. 1" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(badCsrfRes.status).toBe(403);

    // 2. Editor CAN read (200) but CANNOT mutate (403)
    const editorGet = await handleTenantOutletsCollectionRequest(
      handleA,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets`, "GET", {
        cookie: editorA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(editorGet.status).toBe(200);

    const editorPost = await handleTenantOutletsCollectionRequest(
      handleA,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets`, "POST", {
        cookie: editorA.cookie,
        body: { name: "Gerai Editor", address: "Jl. Editor 1" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(editorPost.status).toBe(403);

    // 3. Authorized owner creates published outlet with full weekly hours, holiday hours & coordinates
    const createRes = await handleTenantOutletsCollectionRequest(
      handleA,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets`, "POST", {
        cookie: ownerA.cookie,
        body: {
          name: "Gerai Jakarta Kemang",
          slug: "gerai-jakarta-kemang",
          address: "Jl. Kemang Raya No. 12",
          city: "Jakarta Selatan",
          province: "DKI Jakarta",
          postalCode: "12730",
          phone: "021-719-1234",
          whatsappE164: "0812-3456-7891",
          latitude: -6.2607,
          longitude: 106.8133,
          weeklyHours: [
            { day: "monday", open: "08:00", close: "21:00", closed: false },
            { day: "tuesday", open: "08:00", close: "21:00", closed: false },
            { day: "wednesday", open: "08:00", close: "21:00", closed: false },
            { day: "thursday", open: "08:00", close: "21:00", closed: false },
            { day: "friday", open: "08:00", close: "21:00", closed: false },
            { day: "saturday", open: "09:00", close: "22:00", closed: false },
            { day: "sunday", open: null, close: null, closed: true },
          ],
          holidayHours: [
            { date: "2026-08-17", label: "HUT RI", open: "10:00", close: "18:00", closed: false },
            { date: "2026-12-25", label: "Hari Natal", open: null, close: null, closed: true },
          ],
          timezone: "Asia/Jakarta",
          isPrimary: true,
          status: "published",
          active: true,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as OutletRecord & { cacheVersionSynced: boolean };
    expect(created.id).toBe(1);
    expect(created.slug).toBe("gerai-jakarta-kemang");
    expect(created.phone).toBe("+62217191234");
    expect(created.whatsappE164).toBe("+6281234567891");
    expect(created.latitude).toBe(-6.2607);
    expect(created.longitude).toBe(106.8133);
    expect(created.directionsUrl).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=-6.2607,106.8133",
    );
    expect(created.weeklyHours).toHaveLength(7);
    expect(created.holidayHours).toHaveLength(2);
    expect(created.version).toBe(1);
    expect(created.cacheVersionSynced).toBe(true);

    // Verify atomic cache_version bump in PLATFORM_DB
    const [tenantAfterCreate] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantAId));
    expect(tenantAfterCreate?.cacheVersion).toBe(2);

    // 4. Create a DRAFT outlet + an INACTIVE published outlet -> must NOT appear in public loaders!
    const draftRes = await handleTenantOutletsCollectionRequest(
      handleA,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets`, "POST", {
        cookie: ownerA.cookie,
        body: {
          name: "Gerai Baru (Belum Buka)",
          slug: "gerai-baru-draf",
          address: "Jl. Senopati No. 99",
          status: "draft",
          active: true,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1000 },
    );
    expect(draftRes.status).toBe(201);

    const inactiveRes = await handleTenantOutletsCollectionRequest(
      handleA,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets`, "POST", {
        cookie: ownerA.cookie,
        body: {
          name: "Gerai Renovasi",
          slug: "gerai-renovasi",
          address: "Jl. Menteng No. 5",
          status: "published",
          active: false,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2000 },
    );
    expect(inactiveRes.status).toBe(201);

    // Duplicate slug rejected atomically with 409 CONFLICT
    const dupSlugRes = await handleTenantOutletsCollectionRequest(
      handleA,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets`, "POST", {
        cookie: ownerA.cookie,
        body: {
          name: "Gerai Duplikat",
          slug: "gerai-jakarta-kemang",
          address: "Jl. Lain No. 2",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3000 },
    );
    expect(dupSlugRes.status).toBe(409);
    expect(((await dupSlugRes.json()) as { error: { code: string } }).error.code).toBe("CONFLICT");

    // Concurrent duplicate slug race: strictly 1 succeeds (201) and 1 fails (409 CONFLICT)
    const [race1, race2] = await Promise.all([
      handleTenantOutletsCollectionRequest(
        handleA,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets`, "POST", {
          cookie: ownerA.cookie,
          body: {
            name: "Gerai Balap Satu",
            slug: "gerai-balap-unik",
            address: "Jl. Balap No. 1",
            status: "draft",
          },
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 3100 },
      ),
      handleTenantOutletsCollectionRequest(
        handleA,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets`, "POST", {
          cookie: ownerA.cookie,
          body: {
            name: "Gerai Balap Dua",
            slug: "gerai-balap-unik",
            address: "Jl. Balap No. 2",
            status: "draft",
          },
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 3101 },
      ),
    ]);
    const raceStatuses = [race1.status, race2.status].sort();
    expect(raceStatuses).toEqual([201, 409]);

    // Updating another outlet to an existing slug is also rejected atomically with 409 CONFLICT
    const draftJson = (await draftRes.json()) as OutletRecord;
    const dupUpdateRes = await handleTenantOutletItemRequest(
      handleA,
      String(draftJson.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets/${draftJson.id}`, "PATCH", {
        cookie: ownerA.cookie,
        body: {
          slug: "gerai-jakarta-kemang",
          expectedVersion: draftJson.version,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3200 },
    );
    expect(dupUpdateRes.status).toBe(409);

    // Legacy non-Google `maps_url` in SQL is neutralized on read and falls back to safe Google Maps directions URL
    await tenantDbA
      .prepare(`UPDATE branches SET maps_url = 'https://evil.example/phish' WHERE id = ?`)
      .bind(created.id)
      .run();
    const revalidated = await getOutletById(tenantDbA, created.id);
    expect(revalidated?.mapsUrl).toBeNull();
    expect(revalidated?.directionsUrl).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=-6.2607,106.8133",
    );

    // Legacy SQL `active = 0` deactivation (e.g. via TASK-088) is respected and never overridden by stale JSON
    await tenantDbA
      .prepare(`UPDATE branches SET active = 0 WHERE id = ?`)
      .bind(created.id)
      .run();
    const deactivatedBySql = await getOutletById(tenantDbA, created.id);
    expect(deactivatedBySql?.active).toBe(false);
    expect(await listPublishedOutletsForPublic(tenantDbA)).toHaveLength(0);
    // Restore active = 1 for remaining assertions
    await tenantDbA
      .prepare(`UPDATE branches SET active = 1, maps_url = NULL WHERE id = ?`)
      .bind(created.id)
      .run();

    // 5. Public-data published-only filtering (ZERO draft or inactive leaks!)
    const publicOutlets = await loadPublishedPublicOutlets(tenantDbA);
    expect(publicOutlets).toHaveLength(1);
    expect(publicOutlets[0]?.slug).toBe("gerai-jakarta-kemang");

    const shellData = await loadPublishedTenantShellData(tenantDbA);
    expect(shellData.outlets).toHaveLength(1);
    expect(shellData.outlets?.[0]?.name).toBe("Gerai Jakarta Kemang");

    // Verify Schema.org JSON-LD matches ONLY published outlets
    const schema = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: {
          tenantHandle: handleA,
          tenantStatus: "active",
          primaryHost: `${handleA}.situsku.click`,
          primaryHostKind: "subdomain",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
          verifiedTenantHosts: [`${handleA}.situsku.click`],
        },
      },
      siteName: "Kopi Kemang",
      business: {
        businessName: "Kopi Kemang",
        businessCategory: "cafe",
        branches: mapOutletsToSchemaBranches(publicOutlets),
      },
    });
    expect(schema.emitted).toBe(true);
    const parsedGraph = JSON.parse(schema.jsonLd!) as {
      "@graph": Array<Record<string, unknown>>;
    };
    const schemaBranches = parsedGraph["@graph"].filter(
      (n) => typeof n["@id"] === "string" && (n["@id"] as string).includes("#branch-"),
    );
    expect(schemaBranches).toHaveLength(1);
    expect(schemaBranches[0]?.name).toBe("Gerai Jakarta Kemang");
    expect(Array.isArray(schemaBranches[0]?.openingHoursSpecification)).toBe(true);
    expect(Array.isArray(schemaBranches[0]?.specialOpeningHoursSpecification)).toBe(true);

    // 6. Cross-tenant update & delete by Owner B against Tenant A -> neutral 404 with ZERO side effects!
    const crossUpdate = await handleTenantOutletItemRequest(
      handleA,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets/${created.id}`, "PATCH", {
        cookie: ownerB.cookie,
        body: { name: "HIJACKED", expectedVersion: 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4000 },
    );
    expect(crossUpdate.status).toBe(404);

    const crossDelete = await handleTenantOutletItemRequest(
      handleA,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets/${created.id}`, "DELETE", {
        cookie: ownerB.cookie,
        body: { expectedVersion: 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4500 },
    );
    expect(crossDelete.status).toBe(404);

    // Confirm Tenant A outlet untouched
    const verifyRes = await handleTenantOutletItemRequest(
      handleA,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets/${created.id}`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );
    expect(verifyRes.status).toBe(200);
    const verifiedOutlet = (await verifyRes.json()) as OutletRecord;
    expect(verifiedOutlet.name).toBe("Gerai Jakarta Kemang");
    expect(verifiedOutlet.version).toBe(1);

    // 7. Optimistic concurrency control: PATCH succeeds with v1 -> v2; stale v1 -> 409 STALE_VERSION!
    const updateOk = await handleTenantOutletItemRequest(
      handleA,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets/${created.id}`, "PATCH", {
        cookie: ownerA.cookie,
        body: {
          name: "Gerai Jakarta Kemang Flagship",
          latitude: -6.2611,
          longitude: 106.814,
          expectedVersion: 1,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6000 },
    );
    expect(updateOk.status).toBe(200);
    const updated = (await updateOk.json()) as OutletRecord;
    expect(updated.version).toBe(2);
    expect(updated.name).toBe("Gerai Jakarta Kemang Flagship");

    const stalePatch = await handleTenantOutletItemRequest(
      handleA,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets/${created.id}`, "PATCH", {
        cookie: ownerA.cookie,
        body: {
          name: "Stale Write Attempt",
          expectedVersion: 1,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7000 },
    );
    expect(stalePatch.status).toBe(409);
    const staleBody = (await stalePatch.json()) as { error: { code: string } };
    expect(staleBody.error.code).toBe("STALE_VERSION");

    // 8. Delete with stale version -> 409; Delete with valid version -> 200 & detaches lead FK!
    await tenantDbA
      .prepare(
        `INSERT INTO leads (id, name, phone_e164, message, branch_id, created_at, updated_at)
         VALUES (1, 'Budi', '6281234567890', 'Tanya lokasi', ?, ?, ?)`,
      )
      .bind(created.id, BASE_NOW_MS, BASE_NOW_MS)
      .run();

    const staleDelete = await handleTenantOutletItemRequest(
      handleA,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets/${created.id}`, "DELETE", {
        cookie: ownerA.cookie,
        body: { expectedVersion: 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8000 },
    );
    expect(staleDelete.status).toBe(409);

    const deleteOk = await handleTenantOutletItemRequest(
      handleA,
      String(created.id),
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets/${created.id}`, "DELETE", {
        cookie: ownerA.cookie,
        body: { expectedVersion: 2 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 9000 },
    );
    expect(deleteOk.status).toBe(200);

    // Lead row survives with detached branch_id = NULL
    const leadRow = await tenantDbA
      .prepare(`SELECT id, branch_id FROM leads WHERE id = 1`)
      .first<{ readonly id: number; readonly branch_id: number | null }>();
    expect(leadRow).toEqual({ id: 1, branch_id: null });

    // Public list is now empty
    const remainingPublic = await listPublishedOutletsForPublic(tenantDbA);
    expect(remainingPublic).toHaveLength(0);

    // 9. Locked tenant: GET -> 200 read-only, POST -> 403 SUBSCRIPTION_LOCKED
    await db
      .update(tenants)
      .set({ status: "locked", paidThrough: null, updatedAt: new Date(BASE_NOW_MS + 10_000) })
      .where(eq(tenants.id, tenantAId));

    const lockedGet = await handleTenantOutletsCollectionRequest(
      handleA,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10_000 },
    );
    expect(lockedGet.status).toBe(200);

    const lockedPost = await handleTenantOutletsCollectionRequest(
      handleA,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets`, "POST", {
        cookie: ownerA.cookie,
        body: { name: "Locked Create", address: "Jl. Locked 1" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10_000 },
    );
    expect(lockedPost.status).toBe(403);
    expect(((await lockedPost.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );

    // Suspended tenant: GET -> 403 SUBSCRIPTION_LOCKED
    await db
      .update(tenants)
      .set({ status: "suspended", paidThrough: null, updatedAt: new Date(BASE_NOW_MS + 10_500) })
      .where(eq(tenants.id, tenantAId));

    const suspendedGet = await handleTenantOutletsCollectionRequest(
      handleA,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleA}/outlets`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10_500 },
    );
    expect(suspendedGet.status).toBe(403);

    // 10. Verify Tenant B (legacy 0001-only schema without 0017_branches) also supports full CRUD!
    const tenantBCreate = await handleTenantOutletsCollectionRequest(
      handleB,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handleB}/outlets`, "POST", {
        cookie: ownerB.cookie,
        body: {
          name: "Gerai Beta Yogyakarta",
          address: "Jl. Malioboro No. 10",
          city: "Yogyakarta",
          province: "DI Yogyakarta",
          postalCode: "55271",
          latitude: -7.7926,
          longitude: 110.3658,
          weeklyHours: [{ day: "monday", open: "09:00", close: "20:00", closed: false }],
          status: "published",
          active: true,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 11_000 },
    );
    expect(tenantBCreate.status).toBe(201);
    const createdB = (await tenantBCreate.json()) as OutletRecord;
    expect(createdB.city).toBe("Yogyakarta");
    expect(createdB.weeklyHours).toHaveLength(1);
  });
});

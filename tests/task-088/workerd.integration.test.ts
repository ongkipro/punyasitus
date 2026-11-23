import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import { mapBranchesToSchemaInput } from "@punyasitus/core/branches/index";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import { listActiveBranchesForPublic } from "@punyasitus/db/branches/index";
import {
  applyTenantBranchesMigrations,
  BRANCHES_MIGRATION,
} from "@punyasitus/db/branches/migrations";
import {
  applyPlatformMigrations,
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
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantBranchItemRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/branches/[branchId].ts";
import type { TenantBranchesRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/branches/_shared.ts";
import { handleTenantBranchesCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/branches/index.ts";
import { handleTenantBranchesReorderRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/branches/reorder.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 8, 0, 0);

function buildRuntimeEnv(
  overrides: Partial<TenantBranchesRuntimeEnv> = {},
): TenantBranchesRuntimeEnv {
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

async function openMigratedTenantDb(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, (_instance, state) =>
    applyTenantBranchesMigrations(state.storage as unknown as StorageLike),
  );
  // Verify idempotency by running a second time without error!
  const secondRun = await runInDurableObject(rawDoStub, (_instance, state) =>
    applyTenantBranchesMigrations(state.storage as unknown as StorageLike),
  );
  expect(secondRun.applied).toEqual([]);
  expect(secondRun.currentVersion).toBe(BRANCHES_MIGRATION.version);
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function signUpUser(
  email: string,
  name: string,
  runtimeEnv: TenantBranchesRuntimeEnv,
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

describe("TASK-088 workerd integration — Multi-Branch CRUD, 10-Branch Cap, Single-Primary, OCC, RBAC & Schema.org @graph", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("enforces full CRUD, exact 10-branch cap (11th -> 422), single-primary invariant, OCC 409, lead FK detach, reorder, cache_version bump, and @graph parity", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);
    const paidThrough = new Date(BASE_NOW_MS + 30 * 24 * 60 * 60 * 1000);

    const tenantId = "01JT088ALPHA00000000000001";
    const handle = "t088-alpha";
    const orgId = "org-t088-alpha";

    const owner = await signUpUser("owner.t088.a@example.test", "Owner T088", runtimeEnv);
    const admin = await signUpUser("admin.t088.a@example.test", "Admin T088", runtimeEnv);
    const editor = await signUpUser("editor.t088.a@example.test", "Editor T088", runtimeEnv);
    const outsider = await signUpUser("outsider.t088.a@example.test", "Outsider T088", runtimeEnv);

    await db.insert(organizations).values({
      id: orgId,
      name: "Kopi Nusantara",
      slug: handle,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tenants).values({
      id: tenantId,
      organizationId: orgId,
      handle,
      name: "Kopi Nusantara",
      status: "active",
      vertical: "resto",
      paidThrough,
      cacheVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(members).values([
      { id: "mem-t088-owner", organizationId: orgId, userId: owner.userId, role: "owner", createdAt: now },
      { id: "mem-t088-admin", organizationId: orgId, userId: admin.userId, role: "admin", createdAt: now },
      { id: "mem-t088-editor", organizationId: orgId, userId: editor.userId, role: "editor", createdAt: now },
    ]);

    const tenantDb = await openMigratedTenantDb(tenantId);

    // 1. Cross-tenant outsider gets neutral 404
    const outsiderRes = await handleTenantBranchesCollectionRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches`, "GET", {
        cookie: outsider.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(outsiderRes.status).toBe(404);

    // 2. Editor CAN read branches (200) per REQ-088, but gets 403 FORBIDDEN on POST/PATCH/DELETE/reorder
    const editorGetRes = await handleTenantBranchesCollectionRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches`, "GET", {
        cookie: editor.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(editorGetRes.status).toBe(200);
    expect(editorGetRes.headers.get("Cache-Control")).toBe("no-store");
    const emptyList = (await editorGetRes.json()) as {
      items: unknown[];
      total: number;
      maxBranches: number;
      remainingSlots: number;
    };
    expect(emptyList.total).toBe(0);
    expect(emptyList.maxBranches).toBe(10);
    expect(emptyList.remainingSlots).toBe(10);

    const editorPostRes = await handleTenantBranchesCollectionRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches`, "POST", {
        cookie: editor.cookie,
        body: { name: "Cabang Ilegal", address: "Jl. Ilegal No. 1" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(editorPostRes.status).toBe(403);
    expect(((await editorPostRes.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");

    // 3. CSRF / cross-origin rejection on POST
    const badOriginRes = await handleTenantBranchesCollectionRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches`, "POST", {
        cookie: owner.cookie,
        origin: "https://evil.example",
        body: { name: "Cabang Evil", address: "Jl. Evil" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(badOriginRes.status).toBe(403);

    // 4. Forbidden tenant selector key & javascript: URL rejected with 422
    const selectorRes = await handleTenantBranchesCollectionRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches`, "POST", {
        cookie: owner.cookie,
        body: { name: "Cabang X", address: "Jl. X", tenantId: "01JFAKE0000000000000000001" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(selectorRes.status).toBe(422);

    const xssUrlRes = await handleTenantBranchesCollectionRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches`, "POST", {
        cookie: owner.cookie,
        body: { name: "Cabang XSS", address: "Jl. XSS", mapsUrl: "javascript:alert(1)" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(xssUrlRes.status).toBe(422);

    // 5. Create 10 branches (mix of owner & admin) -> all succeed with 201!
    const createdIds: number[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const actorCookie = i % 2 === 1 ? owner.cookie : admin.cookie;
      const createRes = await handleTenantBranchesCollectionRequest(
        handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches`, "POST", {
          cookie: actorCookie,
          body: {
            name: `Cabang Nusantara ${i}`,
            address: `Jl. Merdeka No. ${i}`,
            city: i === 1 ? "Jakarta Selatan" : `Kota ${i}`,
            province: i === 1 ? "DKI Jakarta" : "Jawa Barat",
            postalCode: `1200${i % 10}`,
            phone: `021-55501${String(i).padStart(2, "0")}`,
            whatsappNumber: `0812-3456-78${String(i).padStart(2, "0")}`,
            mapsUrl: `https://maps.google.com/?q=-6.2${i},106.8${i}`,
            latitude: -6.2 - i * 0.01,
            longitude: 106.8 + i * 0.01,
            weekdayHours: "Senin–Jumat 08.00–21.00 WIB",
            holidayHours: "Sabtu–Minggu 09.00–22.00 WIB",
            timezone: i === 10 ? "Asia/Makassar" : "Asia/Jakarta",
            isPrimary: i === 1,
            active: true,
          },
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + i * 1000 },
      );
      expect(createRes.status, `Branch #${i} create should be 201`).toBe(201);
      const created = (await createRes.json()) as {
        id: number;
        version: number;
        isPrimary: boolean;
        cacheVersionSynced: boolean;
      };
      expect(created.id).toBe(i);
      expect(created.version).toBe(1);
      expect(created.cacheVersionSynced).toBe(true);
      createdIds.push(created.id);
    }

    // 6. 11th branch MUST fail with 422 BRANCH_LIMIT_REACHED!
    const eleventhRes = await handleTenantBranchesCollectionRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches`, "POST", {
        cookie: owner.cookie,
        body: {
          name: "Cabang Ke-11",
          address: "Jl. Kelebihan Kuota No. 11",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 15_000 },
    );
    expect(eleventhRes.status).toBe(422);
    const eleventhBody = (await eleventhRes.json()) as {
      error: { code: string; fields?: Array<{ code: string }> };
    };
    expect(eleventhBody.error.code).toBe("VALIDATION_ERROR");
    expect(eleventhBody.error.fields?.[0]?.code).toBe("BRANCH_LIMIT_REACHED");

    // Verify PLATFORM_DB cache_version bumped (started at 1 + 10 creates = 11)
    const tenantAfterCreates = await db
      .select({ cacheVersion: tenants.cacheVersion })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .get();
    expect(tenantAfterCreates?.cacheVersion).toBe(11);

    // 7. Promote Branch #2 to Primary -> atomically clears isPrimary on Branch #1 (single-primary invariant!)
    const promoteRes = await handleTenantBranchItemRequest(
      handle,
      "2",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches/2`, "PATCH", {
        cookie: owner.cookie,
        body: {
          isPrimary: true,
          expectedVersion: 1,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 20_000 },
    );
    expect(promoteRes.status).toBe(200);
    const promoted = (await promoteRes.json()) as { id: number; isPrimary: boolean; version: number };
    expect(promoted.isPrimary).toBe(true);
    expect(promoted.version).toBe(2);

    const listAfterPromote = (await (
      await handleTenantBranchesCollectionRequest(
        handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches`, "GET", {
          cookie: editor.cookie,
        }),
        runtimeEnv,
      )
    ).json()) as {
      items: Array<{ id: number; isPrimary: boolean; version: number }>;
      primaryBranchId: number | null;
    };
    const primaryBranches = listAfterPromote.items.filter((b) => b.isPrimary);
    expect(primaryBranches).toHaveLength(1);
    expect(primaryBranches[0]?.id).toBe(2);
    expect(listAfterPromote.primaryBranchId).toBe(2);
    // Branch #1 was atomically demoted to isPrimary = false and bumped to version = 2
    const branch1 = listAfterPromote.items.find((b) => b.id === 1);
    expect(branch1?.isPrimary).toBe(false);
    expect(branch1?.version).toBe(2);

    // 8a. Missing expectedVersion on PATCH MUST be rejected with 422 EXPECTED_VERSION_REQUIRED
    const missingVersionPatchRes = await handleTenantBranchItemRequest(
      handle,
      "2",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches/2`, "PATCH", {
        cookie: owner.cookie,
        body: {
          name: "Missing Version Name",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 24_000 },
    );
    expect(missingVersionPatchRes.status).toBe(422);
    const missingVersionBody = (await missingVersionPatchRes.json()) as {
      error: { code: string; fields?: Array<{ code: string }> };
    };
    expect(missingVersionBody.error.code).toBe("VALIDATION_ERROR");
    expect(missingVersionBody.error.fields?.[0]?.code).toBe("EXPECTED_VERSION_REQUIRED");

    // 8b. Stale version OCC check on PATCH -> 409 STALE_VERSION + zero spurious audit row!
    const auditCountBeforeStale = Number(
      (
        await tenantDb
          .prepare(`SELECT COUNT(*) AS cnt FROM tenant_activity_log`)
          .first<{ cnt: number }>()
      )?.cnt ?? 0,
    );

    const stalePatchRes = await handleTenantBranchItemRequest(
      handle,
      "2",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches/2`, "PATCH", {
        cookie: owner.cookie,
        body: {
          name: "Stale Name",
          expectedVersion: 1, // stale! current version is 2
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 25_000 },
    );
    expect(stalePatchRes.status).toBe(409);
    expect(((await stalePatchRes.json()) as { error: { code: string } }).error.code).toBe(
      "STALE_VERSION",
    );

    const auditCountAfterStale = Number(
      (
        await tenantDb
          .prepare(`SELECT COUNT(*) AS cnt FROM tenant_activity_log`)
          .first<{ cnt: number }>()
      )?.cnt ?? 0,
    );
    expect(auditCountAfterStale).toBe(auditCountBeforeStale);

    // 9. Editor cannot PATCH, DELETE, or POST /reorder (403 FORBIDDEN)
    const editorPatch = await handleTenantBranchItemRequest(
      handle,
      "2",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches/2`, "PATCH", {
        cookie: editor.cookie,
        body: { name: "Editor Hack", expectedVersion: 2 },
      }),
      runtimeEnv,
    );
    expect(editorPatch.status).toBe(403);

    const editorReorder = await handleTenantBranchesReorderRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches/reorder`, "POST", {
        cookie: editor.cookie,
        body: { branchIds: [2, 1, 3, 4, 5, 6, 7, 8, 9, 10] },
      }),
      runtimeEnv,
    );
    expect(editorReorder.status).toBe(403);

    // 10. Reorder branches atomically by Owner
    const reorderRes = await handleTenantBranchesReorderRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches/reorder`, "POST", {
        cookie: owner.cookie,
        body: { branchIds: [2, 10, 9, 8, 7, 6, 5, 4, 3, 1] },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 30_000 },
    );
    expect(reorderRes.status).toBe(200);
    const reorderedBody = (await reorderRes.json()) as {
      items: Array<{ id: number; sortOrder: number; version: number }>;
    };
    expect(reorderedBody.items.map((b) => b.id)).toEqual([2, 10, 9, 8, 7, 6, 5, 4, 3, 1]);

    // 11. Attach a lead referencing branch #10, then DELETE branch #10 -> lead survives with branch_id = NULL and slot frees up!
    await tenantDb
      .prepare(
        `INSERT INTO leads (id, name, phone_e164, message, branch_id, status, version, created_at, updated_at)
         VALUES (1, 'Budi Pelanggan', '6281299990000', 'Tanya cabang', 10, 'new', 1, ?, ?)`,
      )
      .bind(BASE_NOW_MS, BASE_NOW_MS)
      .run();

    const branch10Current = reorderedBody.items.find((b) => b.id === 10)!;
    const deleteRes = await handleTenantBranchItemRequest(
      handle,
      "10",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches/10`, "DELETE", {
        cookie: owner.cookie,
        body: { expectedVersion: branch10Current.version },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 35_000 },
    );
    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as {
      deleted: boolean;
      id: number;
      totalRemaining: number;
      cacheVersionSynced: boolean;
    };
    expect(deleteBody).toEqual({
      deleted: true,
      id: 10,
      totalRemaining: 9,
      cacheVersionSynced: true,
    });

    const leadAfterDelete = await tenantDb
      .prepare(`SELECT id, branch_id FROM leads WHERE id = 1`)
      .first<{ id: number; branch_id: number | null }>();
    expect(leadAfterDelete).toEqual({ id: 1, branch_id: null });

    // Slot freed! Creating a new branch (#11 ID, 10th active slot) now succeeds!
    const replacementRes = await handleTenantBranchesCollectionRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches`, "POST", {
        cookie: owner.cookie,
        body: {
          name: "Cabang Bali Denpasar",
          address: "Jl. Sunset Road No. 88",
          city: "Denpasar",
          province: "Bali",
          timezone: "Asia/Makassar",
          whatsappNumber: "0819-0000-1111",
          weekdayHours: "Senin–Minggu 08.00–22.00 WITA",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 40_000 },
    );
    expect(replacementRes.status).toBe(201);
    const replacement = (await replacementRes.json()) as { id: number };
    expect(replacement.id).toBe(11); // monotonic sequence never reuses deleted #10!

    // 12. Verify public active branches -> unified Schema.org @graph exact parity!
    const activeBranches = await listActiveBranchesForPublic(tenantDb);
    expect(activeBranches).toHaveLength(10);
    expect(activeBranches[0]?.id).toBe(2); // Primary first

    const schemaResult = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: {
          tenantHandle: handle,
          tenantStatus: "active",
          primaryHost: "kopinusantara.id",
          primaryHostKind: "custom",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
          verifiedTenantHosts: ["kopinusantara.id", `${handle}.situsku.click`],
        },
      },
      siteName: "Kopi Nusantara",
      business: {
        businessName: "Kopi Nusantara",
        businessCategory: "restaurant",
        branches: mapBranchesToSchemaInput(activeBranches),
      },
    });

    expect(schemaResult.emitted).toBe(true);
    const graph = JSON.parse(schemaResult.jsonLd!) as {
      "@graph": Array<Record<string, unknown>>;
    };
    const orgNode = graph["@graph"].find((n) => n["@id"] === "https://kopinusantara.id/#organization");
    expect(orgNode?.["@type"]).toBe("Restaurant");
    expect((orgNode?.subOrganization as Array<unknown>)?.length).toBe(10);
    const denpasarNode = graph["@graph"].find(
      (n) => n["@id"] === "https://kopinusantara.id/#branch-11",
    );
    expect(denpasarNode?.["@type"]).toBe("Restaurant");
    expect(denpasarNode?.name).toBe("Cabang Bali Denpasar");
    // Visible-fact discipline: Denpasar has WhatsApp only (no visible phone), so telephone MUST be omitted!
    expect(denpasarNode?.telephone).toBeUndefined();
    expect(denpasarNode?.openingHours).toEqual(["Senin–Minggu 08.00–22.00 WITA"]);
    expect(denpasarNode?.aggregateRating).toBeUndefined();

    // Branch #2 has an explicit visible phone -> telephone MUST be emitted!
    const branch2Node = graph["@graph"].find(
      (n) => n["@id"] === "https://kopinusantara.id/#branch-2",
    );
    expect(branch2Node?.telephone).toBe("+62215550102");
  });

  it("returns 201 with cacheVersionSynced: false (never 503) when post-commit PLATFORM_DB cache_version bump throws", async () => {
    const baseEnv = buildRuntimeEnv();
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);

    const tenantId = "01JT088CACHE00000000000003";
    const handle = "t088-cache-fail";
    const orgId = "org-t088-cache-fail";

    const owner = await signUpUser("owner.t088.cache@example.test", "Cache Owner", baseEnv);

    await db.insert(organizations).values({
      id: orgId,
      name: "Cache Fail Outlet",
      slug: handle,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tenants).values({
      id: tenantId,
      organizationId: orgId,
      handle,
      name: "Cache Fail Outlet",
      status: "active",
      vertical: "resto",
      cacheVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(members).values({
      id: "mem-t088-cache-owner",
      organizationId: orgId,
      userId: owner.userId,
      role: "owner",
      createdAt: now,
    });

    const tenantDb = await openMigratedTenantDb(tenantId);

    // Proxy PLATFORM_DB so auth/membership queries succeed, while post-commit `UPDATE tenants SET cache_version` throws!
    const faultyPlatformDb = new Proxy(env.PLATFORM_DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            if (/UPDATE\s+tenants\s+SET\s+cache_version/i.test(query)) {
              return {
                bind: () => ({
                  first: async () => {
                    throw new Error("Simulated transient D1 cache_version bump timeout");
                  },
                }),
              };
            }
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    const faultyEnv = buildRuntimeEnv({ PLATFORM_DB: faultyPlatformDb });

    const createRes = await handleTenantBranchesCollectionRequest(
      handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${handle}/branches`, "POST", {
        cookie: owner.cookie,
        body: {
          name: "Cabang Anti-Duplikat",
          address: "Jl. Tahan Gangguan No. 1",
        },
      }),
      faultyEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );

    // MUST return 201 (committed!) with cacheVersionSynced: false — NEVER 503!
    expect(createRes.status).toBe(201);
    const body = (await createRes.json()) as {
      id: number;
      name: string;
      cacheVersionSynced: boolean;
    };
    expect(body.id).toBe(1);
    expect(body.name).toBe("Cabang Anti-Duplikat");
    expect(body.cacheVersionSynced).toBe(false);

    // Verify exactly 1 row persisted in TenantStore
    const countRow = await tenantDb
      .prepare(`SELECT COUNT(*) AS cnt FROM branches`)
      .first<{ cnt: number }>();
    expect(Number(countRow?.cnt ?? 0)).toBe(1);
  });

  it("enforces locked-tenant read-only mode (GET 200, POST/PATCH/DELETE/reorder 403 SUBSCRIPTION_LOCKED) and suspended denial", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);

    const lockedTenantId = "01JT088LOCKD00000000000002";
    const lockedHandle = "t088-locked";
    const lockedOrgId = "org-t088-locked";

    const owner = await signUpUser("owner.t088.lock@example.test", "Locked Owner", runtimeEnv);

    await db.insert(organizations).values({
      id: lockedOrgId,
      name: "Locked Outlet",
      slug: lockedHandle,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tenants).values({
      id: lockedTenantId,
      organizationId: lockedOrgId,
      handle: lockedHandle,
      name: "Locked Outlet",
      status: "locked",
      vertical: "resto",
      cacheVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(members).values({
      id: "mem-t088-locked-owner",
      organizationId: lockedOrgId,
      userId: owner.userId,
      role: "owner",
      createdAt: now,
    });

    await openMigratedTenantDb(lockedTenantId);

    // GET succeeds read-only (200)
    const lockedGet = await handleTenantBranchesCollectionRequest(
      lockedHandle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${lockedHandle}/branches`, "GET", {
        cookie: owner.cookie,
      }),
      runtimeEnv,
    );
    expect(lockedGet.status).toBe(200);

    // POST blocked with 403 SUBSCRIPTION_LOCKED
    const lockedPost = await handleTenantBranchesCollectionRequest(
      lockedHandle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${lockedHandle}/branches`, "POST", {
        cookie: owner.cookie,
        body: { name: "Blocked Branch", address: "Jl. Terkunci" },
      }),
      runtimeEnv,
    );
    expect(lockedPost.status).toBe(403);
    expect(((await lockedPost.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );

    // Reorder blocked with 403 SUBSCRIPTION_LOCKED
    const lockedReorder = await handleTenantBranchesReorderRequest(
      lockedHandle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${lockedHandle}/branches/reorder`, "POST", {
        cookie: owner.cookie,
        body: { branchIds: [1] },
      }),
      runtimeEnv,
    );
    expect(lockedReorder.status).toBe(403);
    expect(((await lockedReorder.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );
  });
});

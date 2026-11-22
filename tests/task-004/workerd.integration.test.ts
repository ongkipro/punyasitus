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
import { getTenantMenuByLocation } from "@punyasitus/db/menus/index";
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
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantMenuLocationRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/menus/[location].ts";
import { handleTenantMenusRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/menus/index.ts";
import type { TenantMenusRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/menus/_shared.ts";
import { SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 22, 12, 0, 0);

function buildRuntimeEnv(overrides: Partial<TenantMenusRuntimeEnv> = {}): TenantMenusRuntimeEnv {
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
    throw new Error(`Expected ${APP_SESSION_COOKIE_NAME} in Set-Cookie, got: ${JSON.stringify(cookies)}`);
  }
  return (sessionHeader.split(";")[0] ?? "").trim();
}

function makeAdminRequest(
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
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
  runtimeEnv: TenantMenusRuntimeEnv,
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

interface ProvisionedTwoTenants {
  readonly tenantA: { readonly id: string; readonly handle: string; readonly orgId: string; readonly db: D1Database };
  readonly tenantB: { readonly id: string; readonly handle: string; readonly orgId: string; readonly db: D1Database };
  readonly ownerA: { readonly userId: string; readonly cookie: string };
  readonly editorA: { readonly userId: string; readonly cookie: string };
  readonly ownerB: { readonly userId: string; readonly cookie: string };
}

async function provisionTwoTenants(
  suffix: string,
  runtimeEnv: TenantMenusRuntimeEnv,
): Promise<ProvisionedTwoTenants> {
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(BASE_NOW_MS);
  const paidThrough = new Date(BASE_NOW_MS + 30 * 24 * 60 * 60 * 1000);

  const tenantAId = `01JT004ALPHA${suffix.toUpperCase().padEnd(14, "0").slice(0, 14)}`;
  const tenantBId = `01JT004BETA0${suffix.toUpperCase().padEnd(14, "0").slice(0, 14)}`;
  const handleA = `alpha-m-${suffix}`;
  const handleB = `beta-m-${suffix}`;
  const orgAId = `org-alpha-${suffix}`;
  const orgBId = `org-beta-${suffix}`;

  const ownerA = await signUpUser(`owner.a.${suffix}@example.test`, "Owner Alpha", runtimeEnv);
  const editorA = await signUpUser(`editor.a.${suffix}@example.test`, "Editor Alpha", runtimeEnv);
  const ownerB = await signUpUser(`owner.b.${suffix}@example.test`, "Owner Beta", runtimeEnv);

  await db.insert(organizations).values([
    { id: orgAId, name: "Alpha Studio", slug: handleA, createdAt: now, updatedAt: now },
    { id: orgBId, name: "Beta Klinik", slug: handleB, createdAt: now, updatedAt: now },
  ]);

  await db.insert(tenants).values([
    {
      id: tenantAId,
      organizationId: orgAId,
      handle: handleA,
      name: "Alpha Studio",
      status: "active",
      paidThrough,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: tenantBId,
      organizationId: orgBId,
      handle: handleB,
      name: "Beta Klinik",
      status: "active",
      paidThrough,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(members).values([
    {
      id: `mem-oa-${suffix}`,
      organizationId: orgAId,
      userId: ownerA.userId,
      role: "owner",
      createdAt: now,
    },
    {
      id: `mem-ea-${suffix}`,
      organizationId: orgAId,
      userId: editorA.userId,
      role: "editor",
      createdAt: now,
    },
    {
      id: `mem-ob-${suffix}`,
      organizationId: orgBId,
      userId: ownerB.userId,
      role: "owner",
      createdAt: now,
    },
  ]);

  const dbA = await openMigratedTenantDb(tenantAId);
  const dbB = await openMigratedTenantDb(tenantBId);

  // Seed tenant-local pages/offerings in Tenant A (#10) and Tenant B (#777)
  await dbA
    .prepare(
      `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, created_at, updated_at)
       VALUES (10, 'tentang-alpha', 'Tentang Alpha', 0, '[]', 'published', ?, ?)`,
    )
    .bind(BASE_NOW_MS, BASE_NOW_MS)
    .run();

  await dbB
    .prepare(
      `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, created_at, updated_at)
       VALUES (777, 'rahasia-beta', 'Rahasia Beta', 0, '[]', 'published', ?, ?)`,
    )
    .bind(BASE_NOW_MS, BASE_NOW_MS)
    .run();

  return {
    tenantA: { id: tenantAId, handle: handleA, orgId: orgAId, db: dbA },
    tenantB: { id: tenantBId, handle: handleB, orgId: orgBId, db: dbB },
    ownerA,
    editorA,
    ownerB,
  };
}

describe("TASK-004 workerd integration — Hierarchical Navigation Menu Builder API & Isolation", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("saves and loads hierarchical 3-level menus preserving exact order, rel metadata, and publish snapshot", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const envSet = await provisionTwoTenants("01", runtimeEnv);
    const { tenantA, ownerA, editorA } = envSet;

    // 1. Initial GET returns empty menu with version 0
    const initialRes = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/header`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(initialRes.status).toBe(200);
    expect(initialRes.headers.get("cache-control")).toBe("no-store");
    expect(initialRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const initialBody = (await initialRes.json()) as {
      location: string;
      items: unknown[];
      version: number;
    };
    expect(initialBody.location).toBe("header");
    expect(initialBody.items).toEqual([]);
    expect(initialBody.version).toBe(0);

    // 2. Editor saves 3-level hierarchical menu using flat parentId + sortOrder + internal page ref + external link
    const saveRes = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/header`, "PUT", {
        cookie: editorA.cookie,
        body: {
          expectedVersion: 0,
          publish: true,
          items: [
            { id: "wa", parentId: null, sortOrder: 30, label: "Hubungi WA", href: "https://wa.me/6281234567890" },
            { id: "home", parentId: null, sortOrder: 10, label: "Beranda", href: "/" },
            { id: "about", parentId: null, sortOrder: 20, label: "Tentang Kami", targetType: "page", targetResourceId: 10 },
            { id: "team", parentId: "about", sortOrder: 2, label: "Tim", href: "/tentang-alpha#tim" },
            { id: "story", parentId: "about", sortOrder: 1, label: "Cerita", href: "/tentang-alpha#cerita" },
            { id: "founder", parentId: "story", sortOrder: 1, label: "Pendiri", href: "https://example.com/pendiri" },
          ],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1000 },
    );
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as {
      location: string;
      version: number;
      items: Array<{
        id: string;
        href: string;
        rel: string | null;
        isExternal: boolean;
        children: Array<{
          id: string;
          children: Array<{ id: string; rel: string | null; isExternal: boolean }>;
        }>;
      }>;
      flatItems: Array<{ id: string; depth: number; sortOrder: number }>;
    };

    expect(saved.location).toBe("header");
    expect(saved.version).toBe(1);
    expect(saved.items.map((i) => i.id)).toEqual(["home", "about", "wa"]);
    expect(saved.items[1]?.href).toBe("/tentang-alpha"); // resolved from Tenant A's page #10
    expect(saved.items[1]?.children.map((c) => c.id)).toEqual(["story", "team"]);
    expect(saved.items[1]?.children[0]?.children[0]).toMatchObject({
      id: "founder",
      isExternal: true,
      rel: "noopener noreferrer",
    });
    expect(saved.items[2]).toMatchObject({
      id: "wa",
      isExternal: true,
      rel: "noopener noreferrer",
    });

    // 3. Reload via GET /menus/header and GET /menus preserves exact order & published snapshot
    const reloadRes = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/header`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2000 },
    );
    expect(reloadRes.status).toBe(200);
    const reloaded = (await reloadRes.json()) as typeof saved;
    expect(reloaded.items).toEqual(saved.items);
    expect(reloaded.flatItems).toEqual(saved.flatItems);
    expect(reloaded.version).toBe(1);

    const storedRecord = await getTenantMenuByLocation(tenantA.db, "header");
    expect(storedRecord?.publishedItems).toEqual(saved.items);

    // 4. Save footer via POST /menus collection endpoint & list all menus
    const footerRes = await handleTenantMenusRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus`, "POST", {
        cookie: ownerA.cookie,
        body: {
          location: "footer",
          version: 0,
          items: [{ id: "footer-privacy", label: "Kebijakan Privasi", href: "/privasi" }],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3000 },
    );
    expect(footerRes.status).toBe(200);

    const listRes = await handleTenantMenusRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4000 },
    );
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { menus: Array<{ location: string; version: number }> };
    expect(listed.menus.map((m) => m.location)).toEqual(["header", "footer"]);
  });

  it("rejects cyclic, cross-menu, cross-tenant, depth > 3, and unsafe URL payloads without mutating stored data", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const envSet = await provisionTwoTenants("02", runtimeEnv);
    const { tenantA, tenantB, ownerA } = envSet;

    // Seed baseline header & footer menus for Tenant A
    const seedFooter = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "footer",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/footer`, "PUT", {
        cookie: ownerA.cookie,
        body: {
          version: 0,
          items: [{ id: "footer-item-1", label: "Footer Link", href: "/footer" }],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(seedFooter.status).toBe(200);

    const seedHeader = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/header`, "PUT", {
        cookie: ownerA.cookie,
        body: {
          version: 0,
          items: [{ id: "baseline-home", label: "Beranda Awal", href: "/" }],
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(seedHeader.status).toBe(200);

    const invalidCases: Array<{ readonly name: string; readonly body: Record<string, unknown>; readonly expectedFieldCode: string }> = [
      {
        name: "direct self-cycle",
        body: { version: 1, items: [{ id: "a", parentId: "a", label: "Loop", href: "/loop" }] },
        expectedFieldCode: "MENU_CYCLE_DETECTED",
      },
      {
        name: "2-node cycle",
        body: {
          version: 1,
          items: [
            { id: "a", parentId: "b", label: "A", href: "/a" },
            { id: "b", parentId: "a", label: "B", href: "/b" },
          ],
        },
        expectedFieldCode: "MENU_CYCLE_DETECTED",
      },
      {
        name: "cross-menu parent referencing footer item ID",
        body: {
          version: 1,
          items: [{ id: "h1", parentId: "footer-item-1", label: "Cross Menu", href: "/cross" }],
        },
        expectedFieldCode: "MENU_CROSS_MENU_PARENT",
      },
      {
        name: "depth 4 parent chain",
        body: {
          version: 1,
          items: [
            { id: "d1", parentId: null, label: "L1", href: "/1" },
            { id: "d2", parentId: "d1", label: "L2", href: "/2" },
            { id: "d3", parentId: "d2", label: "L3", href: "/3" },
            { id: "d4", parentId: "d3", label: "L4", href: "/4" },
          ],
        },
        expectedFieldCode: "MENU_MAX_DEPTH_EXCEEDED",
      },
      {
        name: "cross-tenant internal page #777 existing only in Tenant B",
        body: {
          version: 1,
          items: [
            {
              id: "steal-b",
              label: "Halaman Beta",
              targetType: "page",
              targetResourceId: 777,
            },
          ],
        },
        expectedFieldCode: "MENU_TARGET_RESOURCE_NOT_FOUND",
      },
      {
        name: "cross-tenant targetTenantId pointing to Tenant B",
        body: {
          version: 1,
          items: [
            {
              id: "forged-target",
              label: "Beta",
              href: "/beta",
              targetTenantId: tenantB.id,
            },
          ],
        },
        expectedFieldCode: "MENU_CROSS_TENANT_REFERENCE",
      },
      {
        name: "forged top-level tenantId in request body",
        body: {
          tenantId: tenantB.id,
          version: 1,
          items: [{ id: "ok", label: "OK", href: "/" }],
        },
        expectedFieldCode: "MENU_CROSS_TENANT_REFERENCE",
      },
      {
        name: "unsafe javascript: URL",
        body: {
          version: 1,
          items: [{ id: "xss", label: "Klik", href: "javascript:alert(1)" }],
        },
        expectedFieldCode: "MENU_UNSAFE_URL",
      },
      {
        name: "unsafe data: URL",
        body: {
          version: 1,
          items: [{ id: "xss2", label: "Data", href: "data:text/html,<script>alert(1)</script>" }],
        },
        expectedFieldCode: "MENU_UNSAFE_URL",
      },
      {
        name: "unsafe protocol-relative URL",
        body: {
          version: 1,
          items: [{ id: "proto", label: "Evil", href: "//evil.com/phish" }],
        },
        expectedFieldCode: "MENU_UNSAFE_URL",
      },
    ];

    for (const tc of invalidCases) {
      const res = await handleTenantMenuLocationRequest(
        tenantA.handle,
        "header",
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/header`, "PUT", {
          cookie: ownerA.cookie,
          body: tc.body,
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 1000 },
      );
      expect(res.status, tc.name).toBe(422);
      const errBody = (await res.json()) as {
        error: { code: string; fields?: Array<{ code: string }> };
      };
      expect(errBody.error.code, tc.name).toBe("VALIDATION_ERROR");
      expect(errBody.error.fields?.[0]?.code, tc.name).toBe(tc.expectedFieldCode);
    }

    // Verify Tenant A's baseline header menu was NEVER mutated (still version 1 with baseline-home)
    const afterInvalid = await getTenantMenuByLocation(tenantA.db, "header");
    expect(afterInvalid?.version).toBe(1);
    expect(afterInvalid?.items.map((i) => i.id)).toEqual(["baseline-home"]);

    // Verify Tenant B's store remains completely untouched
    const tenantBMenu = await getTenantMenuByLocation(tenantB.db, "header");
    expect(tenantBMenu).toBeNull();
  });

  it("enforces optimistic concurrency (409), auth (401), cross-tenant neutral 404, host isolation, and locked tenant (403)", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const envSet = await provisionTwoTenants("03", runtimeEnv);
    const { tenantA, tenantB, ownerA, ownerB } = envSet;

    // 1. Unauthenticated GET & PUT -> 401
    const unauthGet = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/header`, "GET"),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(unauthGet.status).toBe(401);

    // 2. Cross-tenant member (Owner A accessing Tenant B) -> neutral 404
    const crossTenantGet = await handleTenantMenuLocationRequest(
      tenantB.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/menus/header`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(crossTenantGet.status).toBe(404);

    const crossTenantPut = await handleTenantMenuLocationRequest(
      tenantB.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/menus/header`, "PUT", {
        cookie: ownerA.cookie,
        body: { version: 0, items: [{ id: "hack", label: "Hack", href: "/" }] },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(crossTenantPut.status).toBe(404);

    // 3. Public tenant host cannot reach admin menu endpoint -> neutral 404
    const tenantHostReq = makeAdminRequest(
      `https://${SYNTHETIC_TENANTS[0].subdomainHost}/api/tenants/${tenantA.handle}/menus/header`,
      "GET",
      { cookie: ownerA.cookie },
    );
    const tenantHostRes = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "header",
      tenantHostReq,
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(tenantHostRes.status).toBe(404);

    // 4. Forged Origin on PUT -> 403
    const badOriginRes = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/header`, "PUT", {
        cookie: ownerA.cookie,
        origin: `https://${SYNTHETIC_TENANTS[0].subdomainHost}`,
        body: { version: 0, items: [{ id: "x", label: "X", href: "/" }] },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(badOriginRes.status).toBe(403);

    // 5. Save v1 then attempt stale version 0 -> 409 CONFLICT without mutating DB
    const v1Res = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/header`, "PUT", {
        cookie: ownerA.cookie,
        body: { version: 0, items: [{ id: "v1-item", label: "Versi 1", href: "/v1" }] },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(v1Res.status).toBe(200);

    const staleRes = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/header`, "PUT", {
        cookie: ownerA.cookie,
        body: { expectedVersion: 0, items: [{ id: "stale", label: "Stale", href: "/stale" }] },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1000 },
    );
    expect(staleRes.status).toBe(409);
    const storedAfterStale = await getTenantMenuByLocation(tenantA.db, "header");
    expect(storedAfterStale?.version).toBe(1);
    expect(storedAfterStale?.items.map((i) => i.id)).toEqual(["v1-item"]);

    // 6. Locked tenant (paidThrough expired 5 days ago -> H+4..H+7 locked window)
    const platformDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const fiveDaysAgo = new Date(BASE_NOW_MS - 5 * 24 * 60 * 60 * 1000);
    await platformDb
      .update(tenants)
      .set({ status: "locked", paidThrough: fiveDaysAgo })
      .where(eq(tenants.id, tenantA.id));

    // Locked tenant can still READ (content:read)
    const lockedGet = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/header`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedGet.status).toBe(200);

    // Locked tenant CANNOT mutate (PUT / DELETE -> 403 SUBSCRIPTION_LOCKED)
    const lockedPut = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/header`, "PUT", {
        cookie: ownerA.cookie,
        body: { version: 1, items: [{ id: "v2", label: "Blocked", href: "/blocked" }] },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedPut.status).toBe(403);
    const lockedBody = (await lockedPut.json()) as { error: { code: string } };
    expect(lockedBody.error.code).toBe("SUBSCRIPTION_LOCKED");

    const lockedDelete = await handleTenantMenuLocationRequest(
      tenantA.handle,
      "header",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/menus/header`, "DELETE", {
        cookie: ownerA.cookie,
        body: { version: 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedDelete.status).toBe(403);

    // 7. Tenant B (active) saves & deletes cleanly with OCC
    const bSave = await handleTenantMenuLocationRequest(
      tenantB.handle,
      "mobile",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/menus/mobile`, "PUT", {
        cookie: ownerB.cookie,
        body: { version: 0, items: [{ id: "m1", label: "Mobile Home", href: "/" }] },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(bSave.status).toBe(200);

    const bDeleteStale = await handleTenantMenuLocationRequest(
      tenantB.handle,
      "mobile",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/menus/mobile`, "DELETE", {
        cookie: ownerB.cookie,
        body: { version: 99 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(bDeleteStale.status).toBe(409);

    const bDeleteOk = await handleTenantMenuLocationRequest(
      tenantB.handle,
      "mobile",
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/menus/mobile`, "DELETE", {
        cookie: ownerB.cookie,
        body: { version: 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(bDeleteOk.status).toBe(200);
    expect(await getTenantMenuByLocation(tenantB.db, "mobile")).toBeNull();
  });
});

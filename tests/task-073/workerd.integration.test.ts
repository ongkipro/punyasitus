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
  tenantHosts,
  tenants,
} from "@punyasitus/db/platform";
import {
  getGroupedSettingsForAdmin,
  getPublishedGoogleMapsReviewUrl,
  getPublishedGroupedSettings,
} from "@punyasitus/db/settings/index";
import { TENANT_0005_SITE_SETTINGS_GROUPED_MIGRATION } from "@punyasitus/db/settings/migrations";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantSettingsGroupRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/settings/[group].ts";
import { handleTenantSettingsPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/settings/publish.ts";
import type { TenantSettingsRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/settings/_shared.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-t073-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-t073-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 5, 0, 0);

const TENANT_A = {
  id: "01JT073TENANTA000000000001",
  orgId: "org_t073_alpha",
  handle: "t073-alpha",
  name: "Klinik Sehat T073",
  host: "t073-alpha.situsku.click",
} as const;

const TENANT_B = {
  id: "01JT073TENANTB000000000002",
  orgId: "org_t073_beta",
  handle: "t073-beta",
  name: "Bengkel Nusantara T073",
  host: "t073-beta.situsku.click",
} as const;

const TENANT_LOCKED = {
  id: "01JT073TENANTC000000000003",
  orgId: "org_t073_locked",
  handle: "t073-locked",
  name: "T073 Locked Corp",
  host: "t073-locked.situsku.click",
} as const;

function buildRuntimeEnv(): TenantSettingsRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractSessionCookie(response: Response): string {
  const cookies = getSetCookies(response.headers);
  const found = cookies.find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!found) {
    throw new Error(`Missing ${APP_SESSION_COOKIE_NAME} in ${JSON.stringify(cookies)}`);
  }
  return (found.split(";")[0] ?? "").trim();
}

function makeApiRequest(
  url: string,
  method: "GET" | "PATCH" | "POST" = "GET",
  options: {
    readonly cookie?: string;
    readonly body?: unknown;
    readonly origin?: string | null;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.origin !== undefined) {
    if (options.origin !== null) headers.set("Origin", options.origin);
  } else if (method !== "GET") {
    headers.set("Origin", new URL(url).origin);
  }
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function signUpAppUser(email: string, name: string): Promise<{
  readonly userId: string;
  readonly cookie: string;
}> {
  const req = new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
    body: JSON.stringify({
      email,
      password: "StrongPassword!T073#2026",
      name,
    }),
  });
  const res = await handleBetterAuthRequest(req, buildRuntimeEnv());
  expect(res.status, `signUp failed for ${email}: ${res.status}`).toBe(200);
  const json = (await res.json()) as { user?: { id?: string } };
  const userId = json.user?.id;
  if (!userId) throw new Error(`Missing userId for ${email}`);
  return { userId, cookie: extractSessionCookie(res) };
}

async function migrateTenantStore(tenantId: string): Promise<D1Database> {
  const stub = env.TENANT_STORE.get(env.TENANT_STORE.idFromName(tenantId));
  await runInDurableObject(stub, async (_instance, state) => {
    const storage = state.storage as unknown as StorageLike;
    applyTenantMigrations(storage, [...TENANT_MIGRATIONS, TENANT_0005_SITE_SETTINGS_GROUPED_MIGRATION]);
  });
  return createTenantDb(
    openTenantStoreStub(env.TENANT_STORE as unknown as TenantStoreNamespaceLike, tenantId),
  );
}

async function seedTenantPlatform(
  t: { readonly id: string; readonly orgId: string; readonly handle: string; readonly name: string; readonly host: string },
  status: "active" | "locked",
): Promise<void> {
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(BASE_NOW_MS);
  await db
    .insert(organizations)
    .values({
      id: t.orgId,
      name: t.name,
      slug: t.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(tenants)
    .values({
      id: t.id,
      organizationId: t.orgId,
      handle: t.handle,
      name: t.name,
      vertical: "compro",
      status,
      cacheVersion: 1,
      schemaVersion: 3,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(tenantHosts)
    .values({
      host: t.host,
      tenantId: t.id,
      kind: "subdomain",
      status: "active",
      sslStatus: "active",
      isPrimary: true,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

async function addMember(
  orgId: string,
  userId: string,
  role: "owner" | "admin" | "editor",
): Promise<void> {
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(BASE_NOW_MS);
  await db
    .insert(members)
    .values({
      id: `mem_${orgId}_${userId}_${role}`,
      organizationId: orgId,
      userId,
      role,
      createdAt: now,
    })
    .onConflictDoNothing();
}

describe("TASK-073 Workerd Integration: Google Maps Review Link API, RBAC, Validation & Draft/Publish Isolation", () => {
  let ownerCookie = "";
  let adminCookie = "";
  let editorCookie = "";
  let lockedOwnerCookie = "";
  let tenantADb!: D1Database;
  let tenantBDb!: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);

    await seedTenantPlatform(TENANT_A, "active");
    await seedTenantPlatform(TENANT_B, "active");
    await seedTenantPlatform(TENANT_LOCKED, "locked");

    tenantADb = await migrateTenantStore(TENANT_A.id);
    tenantBDb = await migrateTenantStore(TENANT_B.id);
    await migrateTenantStore(TENANT_LOCKED.id);

    const ownerA = await signUpAppUser("owner-a-t073@example.com", "Pemilik Alpha");
    const adminA = await signUpAppUser("admin-a-t073@example.com", "Admin Alpha");
    const editorA = await signUpAppUser("editor-a-t073@example.com", "Editor Alpha");
    const ownerB = await signUpAppUser("owner-b-t073@example.com", "Pemilik Beta");
    const ownerLocked = await signUpAppUser("owner-locked-t073@example.com", "Pemilik Locked");

    ownerCookie = ownerA.cookie;
    adminCookie = adminA.cookie;
    editorCookie = editorA.cookie;
    lockedOwnerCookie = ownerLocked.cookie;

    await addMember(TENANT_A.orgId, ownerA.userId, "owner");
    await addMember(TENANT_A.orgId, adminA.userId, "admin");
    await addMember(TENANT_A.orgId, editorA.userId, "editor");
    await addMember(TENANT_B.orgId, ownerB.userId, "owner");
    await addMember(TENANT_LOCKED.orgId, ownerLocked.userId, "owner");
  });

  it("saves valid Google Maps review URL in draft WITHOUT leaking to public, then publishes atomically", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const initial = await getGroupedSettingsForAdmin(tenantADb);
    expect(initial.draft.business.googleMapsReviewUrl).toBeNull();
    expect(await getPublishedGoogleMapsReviewUrl(tenantADb)).toBeNull();

    // 1. Save valid g.page review URL to draft
    const reviewUrl1 = "https://g.page/r/Cf1234567890_EBM/review";
    const patchRes = await handleTenantSettingsGroupRequest(
      TENANT_A.id,
      "business",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/settings/business`, "PATCH", {
        cookie: ownerCookie,
        body: {
          expectedVersion: initial.version,
          businessName: "Klinik Sehat T073",
          googleMapsReviewUrl: reviewUrl1,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      version: number;
      hasUnpublishedChanges: boolean;
      data: { googleMapsReviewUrl: string | null };
      publishedData: { googleMapsReviewUrl: string | null } | null;
    };
    expect(patchBody.data.googleMapsReviewUrl).toBe(reviewUrl1);
    expect(patchBody.hasUnpublishedChanges).toBe(true);
    expect(patchBody.publishedData).toBeNull();

    // Draft MUST NOT leak publicly before publish!
    expect(await getPublishedGroupedSettings(tenantADb)).toBeNull();
    expect(await getPublishedGoogleMapsReviewUrl(tenantADb)).toBeNull();

    // 2. Publish atomically -> now visible in published public DTO
    const pubRes = await handleTenantSettingsPublishRequest(
      TENANT_A.id,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/settings/publish`, "POST", {
        cookie: ownerCookie,
        body: { expectedVersion: patchBody.version, group: "business" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_000 },
    );
    expect(pubRes.status).toBe(200);
    const pubBody = (await pubRes.json()) as {
      version: number;
      cacheVersion: number;
      published: { business: { googleMapsReviewUrl: string | null } };
    };
    expect(pubBody.published.business.googleMapsReviewUrl).toBe(reviewUrl1);
    expect(pubBody.cacheVersion).toBeGreaterThanOrEqual(2);

    const publicPublished = await getPublishedGroupedSettings(tenantADb);
    expect(publicPublished?.settings.business.googleMapsReviewUrl).toBe(reviewUrl1);
    expect(await getPublishedGoogleMapsReviewUrl(tenantADb)).toBe(reviewUrl1);

    // 3. Subsequent draft edit stays isolated from live published URL until next publish
    const reviewUrl2 = "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4";
    const draft2Res = await handleTenantSettingsGroupRequest(
      TENANT_A.id,
      "business",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/settings/business`, "PATCH", {
        cookie: adminCookie,
        body: {
          expectedVersion: pubBody.version,
          googleMapsReviewUrl: reviewUrl2,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_000 },
    );
    expect(draft2Res.status).toBe(200);
    const draft2Body = (await draft2Res.json()) as {
      version: number;
      data: { googleMapsReviewUrl: string | null };
      publishedData: { googleMapsReviewUrl: string | null } | null;
    };
    expect(draft2Body.data.googleMapsReviewUrl).toBe(reviewUrl2);
    expect(draft2Body.publishedData?.googleMapsReviewUrl).toBe(reviewUrl1);
    expect(await getPublishedGoogleMapsReviewUrl(tenantADb)).toBe(reviewUrl1);

    // Publish second URL as admin -> succeeds
    const pub2Res = await handleTenantSettingsPublishRequest(
      TENANT_A.id,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/settings/publish`, "POST", {
        cookie: adminCookie,
        body: { expectedVersion: draft2Body.version, group: "business" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4_000 },
    );
    expect(pub2Res.status).toBe(200);
    expect(await getPublishedGoogleMapsReviewUrl(tenantADb)).toBe(reviewUrl2);
  });

  it("rejects www.google.com/url?... open redirect and unsafe URLs with 422 VALIDATION_ERROR without mutating DB", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const before = await getGroupedSettingsForAdmin(tenantADb);

    const maliciousUrls = [
      "https://www.google.com/url?q=https://evil.example/steal",
      "https://google.com/url?sa=t&url=https://evil.example",
      "http://g.page/r/Cf1234567890_EBM/review",
      "javascript:alert(1)",
      "https://evil.example/reviews",
      "https://search.google.com/local/writereview",
    ];

    for (const badUrl of maliciousUrls) {
      const res = await handleTenantSettingsGroupRequest(
        TENANT_A.id,
        "business",
        makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/settings/business`, "PATCH", {
          cookie: ownerCookie,
          body: {
            expectedVersion: before.version,
            googleMapsReviewUrl: badUrl,
          },
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 5_000 },
      );
      expect(res.status, `Expected 422 for ${badUrl}`).toBe(422);
      const errJson = (await res.json()) as {
        error: { code: string; fields?: Array<{ field: string; code: string }> };
      };
      expect(errJson.error.code).toBe("VALIDATION_ERROR");
      expect(errJson.error.fields?.[0]?.field).toBe("googleMapsReviewUrl");
      expect(errJson.error.fields?.[0]?.code).toBe("INVALID_GOOGLE_MAPS_REVIEW_URL");
    }

    const after = await getGroupedSettingsForAdmin(tenantADb);
    expect(after.version).toBe(before.version);
    expect(after.draft.business.googleMapsReviewUrl).toBe(
      before.draft.business.googleMapsReviewUrl,
    );
  });

  it("enforces RBAC (editor -> 403), cross-tenant isolation (404), CSRF/Origin (403), OCC (409), and locked tenant (403)", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const stateA = await getGroupedSettingsForAdmin(tenantADb);

    // 1. Editor rejected with 403 on GET, PATCH, and POST publish
    const editorGet = await handleTenantSettingsGroupRequest(
      TENANT_A.id,
      "business",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/settings/business`, "GET", {
        cookie: editorCookie,
      }),
      runtimeEnv,
    );
    expect(editorGet.status).toBe(403);

    const editorPatch = await handleTenantSettingsGroupRequest(
      TENANT_A.id,
      "business",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/settings/business`, "PATCH", {
        cookie: editorCookie,
        body: {
          expectedVersion: stateA.version,
          googleMapsReviewUrl: "https://maps.app.goo.gl/AbCdEf123456",
        },
      }),
      runtimeEnv,
    );
    expect(editorPatch.status).toBe(403);

    const editorPublish = await handleTenantSettingsPublishRequest(
      TENANT_A.id,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/settings/publish`, "POST", {
        cookie: editorCookie,
        body: { expectedVersion: stateA.version, group: "business" },
      }),
      runtimeEnv,
    );
    expect(editorPublish.status).toBe(403);

    // 2. Cross-tenant access: Tenant A owner targeting Tenant B -> 404
    const crossTenant = await handleTenantSettingsGroupRequest(
      TENANT_B.id,
      "business",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_B.id}/settings/business`, "PATCH", {
        cookie: ownerCookie,
        body: {
          expectedVersion: 0,
          googleMapsReviewUrl: "https://maps.app.goo.gl/AbCdEf123456",
        },
      }),
      runtimeEnv,
    );
    expect(crossTenant.status).toBe(404);
    expect(await getPublishedGoogleMapsReviewUrl(tenantBDb)).toBeNull();

    // 3. CSRF / Origin mismatch -> 403
    const csrfBad = await handleTenantSettingsGroupRequest(
      TENANT_A.id,
      "business",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/settings/business`, "PATCH", {
        cookie: ownerCookie,
        origin: "https://evil.example",
        body: {
          expectedVersion: stateA.version,
          googleMapsReviewUrl: "https://maps.app.goo.gl/AbCdEf123456",
        },
      }),
      runtimeEnv,
    );
    expect(csrfBad.status).toBe(403);

    // 4. Stale expectedVersion -> 409 STALE_VERSION
    const stale = await handleTenantSettingsGroupRequest(
      TENANT_A.id,
      "business",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/settings/business`, "PATCH", {
        cookie: ownerCookie,
        body: {
          expectedVersion: Math.max(0, stateA.version - 1),
          googleMapsReviewUrl: "https://maps.app.goo.gl/AbCdEf123456",
        },
      }),
      runtimeEnv,
    );
    expect(stale.status).toBe(409);

    // 5. Locked tenant -> PATCH rejected 403 SUBSCRIPTION_LOCKED
    const lockedPatch = await handleTenantSettingsGroupRequest(
      TENANT_LOCKED.id,
      "business",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_LOCKED.id}/settings/business`, "PATCH", {
        cookie: lockedOwnerCookie,
        body: {
          expectedVersion: 0,
          googleMapsReviewUrl: "https://maps.app.goo.gl/AbCdEf123456",
        },
      }),
      runtimeEnv,
    );
    expect(lockedPatch.status).toBe(403);
    const lockedJson = (await lockedPatch.json()) as { error: { code: string } };
    expect(lockedJson.error.code).toBe("SUBSCRIPTION_LOCKED");

    // 6. Clearing review URL back to null works cleanly
    const clearPatch = await handleTenantSettingsGroupRequest(
      TENANT_A.id,
      "business",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/settings/business`, "PATCH", {
        cookie: ownerCookie,
        body: {
          expectedVersion: stateA.version,
          googleMapsReviewUrl: null,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6_000 },
    );
    expect(clearPatch.status).toBe(200);
    const clearBody = (await clearPatch.json()) as { version: number; data: { googleMapsReviewUrl: string | null } };
    expect(clearBody.data.googleMapsReviewUrl).toBeNull();

    const clearPub = await handleTenantSettingsPublishRequest(
      TENANT_A.id,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/settings/publish`, "POST", {
        cookie: ownerCookie,
        body: { expectedVersion: clearBody.version, group: "business" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7_000 },
    );
    expect(clearPub.status).toBe(200);
    expect(await getPublishedGoogleMapsReviewUrl(tenantADb)).toBeNull();
  });
});

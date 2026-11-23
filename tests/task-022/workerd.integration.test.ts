import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import { getTenantAnalyticsSettings } from "@punyasitus/db/analytics-settings/index";
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
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import type { TenantAnalyticsRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/analytics/_shared.ts";
import { handleTenantAnalyticsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/analytics/index.ts";
import { SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 2, 0, 0);

function buildRuntimeEnv(
  overrides: Partial<TenantAnalyticsRuntimeEnv> = {},
): TenantAnalyticsRuntimeEnv {
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
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
  runtimeEnv: TenantAnalyticsRuntimeEnv,
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

async function countAnalyticsAuditRows(tenantDb: D1Database): Promise<number> {
  const row = await tenantDb
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM tenant_activity_log
       WHERE action = 'analytics.settings_updated'`,
    )
    .first<{ readonly cnt: number }>();
  return Number(row?.cnt ?? 0);
}

describe("TASK-022 Workerd Integration — Tenant Analytics Settings API & Atomic Persistence", () => {
  const [alpha, beta] = SYNTHETIC_TENANTS;
  const alphaOrgId = "org_t022_alpha_0000000001";
  const betaOrgId = "org_t022_beta_00000000002";
  const runtimeEnv = buildRuntimeEnv();
  const baseDate = new Date(BASE_NOW_MS);

  let alphaDb: D1Database;
  let betaDb: D1Database;

  let ownerCookie = "";
  let adminCookie = "";
  let editorCookie = "";
  let betaOwnerCookie = "";

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

    await db
      .insert(organizations)
      .values([
        {
          id: alphaOrgId,
          name: alpha.siteTitle,
          slug: alpha.handle,
          createdAt: baseDate,
          updatedAt: baseDate,
        },
        {
          id: betaOrgId,
          name: beta.siteTitle,
          slug: beta.handle,
          createdAt: baseDate,
          updatedAt: baseDate,
        },
      ])
      .onConflictDoNothing();

    await db
      .insert(tenants)
      .values([
        {
          id: alpha.id,
          organizationId: alphaOrgId,
          handle: alpha.handle,
          name: alpha.siteTitle,
          vertical: "compro",
          status: "active",
          cacheVersion: 1,
          createdAt: baseDate,
          updatedAt: baseDate,
        },
        {
          id: beta.id,
          organizationId: betaOrgId,
          handle: beta.handle,
          name: beta.siteTitle,
          vertical: "sales",
          status: "active",
          cacheVersion: 1,
          createdAt: baseDate,
          updatedAt: baseDate,
        },
      ])
      .onConflictDoNothing();

    alphaDb = await openMigratedTenantDb(alpha.id);
    betaDb = await openMigratedTenantDb(beta.id);

    // Seed pre-existing site_settings row in alpha (version 1) without any runtime DDL
    await alphaDb
      .prepare(
        `INSERT OR REPLACE INTO site_settings (
           id, site_title, timezone, locale, active_theme_id,
           blog_enabled, catalog_enabled, ai_training_policy,
           analytics_config_json, version, updated_at
         ) VALUES (1, 'Alpha Studio', 'Asia/Jakarta', 'id-ID', 'compro', 1, 1, 'allow', NULL, 1, ?)`,
      )
      .bind(BASE_NOW_MS)
      .run();

    const owner = await signUpUser("owner.t022@alpha.example", "Owner Alpha", runtimeEnv);
    const admin = await signUpUser("admin.t022@alpha.example", "Admin Alpha", runtimeEnv);
    const editor = await signUpUser("editor.t022@alpha.example", "Editor Alpha", runtimeEnv);
    const betaOwner = await signUpUser("owner.t022@beta.example", "Owner Beta", runtimeEnv);

    ownerCookie = owner.cookie;
    adminCookie = admin.cookie;
    editorCookie = editor.cookie;
    betaOwnerCookie = betaOwner.cookie;

    await db
      .insert(members)
      .values([
        {
          id: "mem_t022_alpha_owner",
          organizationId: alphaOrgId,
          userId: owner.userId,
          role: "owner",
          createdAt: baseDate,
        },
        {
          id: "mem_t022_alpha_admin",
          organizationId: alphaOrgId,
          userId: admin.userId,
          role: "admin",
          createdAt: baseDate,
        },
        {
          id: "mem_t022_alpha_editor",
          organizationId: alphaOrgId,
          userId: editor.userId,
          role: "editor",
          createdAt: baseDate,
        },
        {
          id: "mem_t022_beta_owner",
          organizationId: betaOrgId,
          userId: betaOwner.userId,
          role: "owner",
          createdAt: baseDate,
        },
      ])
      .onConflictDoNothing();
  });

  it("enforces app-host isolation (neutral 404), CSRF/Origin on PATCH, and private no-store headers", async () => {
    const wrongHostRes = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`https://${alpha.handle}.situsku.click/api/tenants/${alpha.handle}/analytics`, "GET", {
        cookie: ownerCookie,
      }),
      runtimeEnv,
    );
    expect(wrongHostRes.status).toBe(404);
    expect(wrongHostRes.headers.get("Cache-Control")).toBe("private, no-store");
    expect(wrongHostRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const badOriginRes = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "PATCH", {
        cookie: ownerCookie,
        origin: "https://evil.example",
        body: { ga4MeasurementId: "G-AB12CD34EF", expectedVersion: 1 },
      }),
      runtimeEnv,
    );
    expect(badOriginRes.status).toBe(403);
  });

  it("enforces cross-tenant neutral 404 and RBAC (owner/admin allowed, editor denied 403 on PATCH)", async () => {
    // Beta owner accessing Alpha -> neutral 404
    const crossGet = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "GET", {
        cookie: betaOwnerCookie,
      }),
      runtimeEnv,
    );
    expect(crossGet.status).toBe(404);

    const crossPatch = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "PATCH", {
        cookie: betaOwnerCookie,
        body: { ga4MeasurementId: "G-AB12CD34EF", expectedVersion: 1 },
      }),
      runtimeEnv,
    );
    expect(crossPatch.status).toBe(404);

    // Editor can GET (read-only view), but is DENIED 403 FORBIDDEN on PATCH
    const editorGet = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "GET", {
        cookie: editorCookie,
      }),
      runtimeEnv,
    );
    expect(editorGet.status).toBe(200);
    expect(editorGet.headers.get("Cache-Control")).toBe("private, no-store");
    expect(editorGet.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const editorPatch = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "PATCH", {
        cookie: editorCookie,
        body: { ga4MeasurementId: "G-AB12CD34EF", expectedVersion: 1 },
      }),
      runtimeEnv,
    );
    expect(editorPatch.status).toBe(403);
    const editorErr = (await editorPatch.json()) as { error: { code: string } };
    expect(editorErr.error.code).toBe("FORBIDDEN");
  });

  it("rejects missing expectedVersion (422), GTM IDs (422), and raw script/XSS snippets (422) with zero side effects", async () => {
    const auditsBefore = await countAnalyticsAuditRows(alphaDb);

    // Missing expectedVersion -> 422 VALIDATION_ERROR
    const noVerRes = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "PATCH", {
        cookie: ownerCookie,
        body: { ga4MeasurementId: "G-AB12CD34EF" },
      }),
      runtimeEnv,
    );
    expect(noVerRes.status).toBe(422);

    // GTM field -> 422 VALIDATION_ERROR
    const gtmFieldRes = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "PATCH", {
        cookie: ownerCookie,
        body: { gtmContainerId: "GTM-ABCD123", expectedVersion: 1 },
      }),
      runtimeEnv,
    );
    expect(gtmFieldRes.status).toBe(422);

    // GTM value in GA4 input -> 422 VALIDATION_ERROR
    const gtmValRes = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "PATCH", {
        cookie: ownerCookie,
        body: { ga4MeasurementId: "GTM-ABCD123", expectedVersion: 1 },
      }),
      runtimeEnv,
    );
    expect(gtmValRes.status).toBe(422);

    // XSS script snippet -> 422 VALIDATION_ERROR
    const xssRes = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "PATCH", {
        cookie: ownerCookie,
        body: { metaPixelId: "<script>alert(1)</script>", expectedVersion: 1 },
      }),
      runtimeEnv,
    );
    expect(xssRes.status).toBe(422);

    expect(await countAnalyticsAuditRows(alphaDb)).toBe(auditsBefore);
  });

  it("persists valid direct GA4/Meta/TikTok IDs atomically with audit row, and rejects stale expectedVersion (409) with zero side effects", async () => {
    const auditsBefore = await countAnalyticsAuditRows(alphaDb);

    // Owner updates version 1 -> version 2
    const ownerSave = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "PATCH", {
        cookie: ownerCookie,
        body: {
          ga4MeasurementId: "G-AB12CD34EF",
          metaPixelId: "123456789012345",
          tiktokPixelId: "C1234567890ABCDEF",
          expectedVersion: 1,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10_000 },
    );
    expect(ownerSave.status).toBe(200);
    const savedDto = (await ownerSave.json()) as {
      ga4MeasurementId: string | null;
      metaPixelId: string | null;
      tiktokPixelId: string | null;
      version: number;
      updatedAt: string | null;
    };
    expect(savedDto.ga4MeasurementId).toBe("G-AB12CD34EF");
    expect(savedDto.metaPixelId).toBe("123456789012345");
    expect(savedDto.tiktokPixelId).toBe("C1234567890ABCDEF");
    expect(savedDto.version).toBe(2);
    expect(savedDto.updatedAt).toBeTruthy();

    // Exactly 1 atomic audit row created
    expect(await countAnalyticsAuditRows(alphaDb)).toBe(auditsBefore + 1);

    // Stale expectedVersion (1 instead of 2) -> 409 STALE_VERSION with ZERO DB change and ZERO new audit row
    const staleRes = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "PATCH", {
        cookie: adminCookie,
        body: {
          ga4MeasurementId: "G-STALE99999",
          metaPixelId: null,
          tiktokPixelId: null,
          expectedVersion: 1,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 20_000 },
    );
    expect(staleRes.status).toBe(409);
    const staleJson = (await staleRes.json()) as { error: { code: string } };
    expect(staleJson.error.code).toBe("STALE_VERSION");

    // Verify DB state unchanged and zero audit row added on 409
    const currentDbState = await getTenantAnalyticsSettings(alphaDb);
    expect(currentDbState.version).toBe(2);
    expect(currentDbState.ga4MeasurementId).toBe("G-AB12CD34EF");
    expect(await countAnalyticsAuditRows(alphaDb)).toBe(auditsBefore + 1);

    // Admin updates cleanly with fresh expectedVersion 2 -> version 3
    const adminSave = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "PATCH", {
        cookie: adminCookie,
        body: {
          ga4MeasurementId: "G-ADMIN998877",
          metaPixelId: "123456789012345",
          tiktokPixelId: null,
          expectedVersion: 2,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 30_000 },
    );
    expect(adminSave.status).toBe(200);
    const adminDto = (await adminSave.json()) as { version: number; tiktokPixelId: string | null };
    expect(adminDto.version).toBe(3);
    expect(adminDto.tiktokPixelId).toBeNull();
    expect(await countAnalyticsAuditRows(alphaDb)).toBe(auditsBefore + 2);

    // Partial PATCH preservation + arbitrary extra JSON keys preservation:
    // 1. Seed all 3 direct providers + arbitrary extra keys in `analytics_config_json`
    const seededJson = JSON.stringify({
      ga4MeasurementId: "G-INITIAL111",
      metaPixelId: "998877665544332",
      tiktokPixelId: "CTIKTOKPRESERVE99",
      gtmContainerId: "GTM-KEEP123",
      gtmRiskAckVersion: 2,
      customFlag: "keep-me",
    });
    await alphaDb
      .prepare(`UPDATE site_settings SET analytics_config_json = ? WHERE id = 1`)
      .bind(seededJson)
      .run();

    // 2. PATCH ONLY `ga4MeasurementId` (omitting `metaPixelId` and `tiktokPixelId`) -> version 3 -> 4
    const partialRes = await handleTenantAnalyticsRequest(
      alpha.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "PATCH", {
        cookie: ownerCookie,
        body: {
          ga4MeasurementId: "G-UPDATED99",
          expectedVersion: 3,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 35_000 },
    );
    expect(partialRes.status).toBe(200);
    const partialDto = (await partialRes.json()) as {
      ga4MeasurementId: string | null;
      metaPixelId: string | null;
      tiktokPixelId: string | null;
      version: number;
    };
    expect(partialDto.version).toBe(4);
    expect(partialDto.ga4MeasurementId).toBe("G-UPDATED99");
    expect(partialDto.metaPixelId).toBe("998877665544332");
    expect(partialDto.tiktokPixelId).toBe("CTIKTOKPRESERVE99");

    // 3. Verify arbitrary unrelated keys in `site_settings.analytics_config_json` survived untouched!
    const rawRow = await alphaDb
      .prepare(`SELECT analytics_config_json FROM site_settings WHERE id = 1 LIMIT 1`)
      .first<{ readonly analytics_config_json: string | null }>();
    const storedObj = JSON.parse(rawRow?.analytics_config_json ?? "{}") as Record<string, unknown>;
    expect(storedObj.ga4MeasurementId).toBe("G-UPDATED99");
    expect(storedObj.metaPixelId).toBe("998877665544332");
    expect(storedObj.tiktokPixelId).toBe("CTIKTOKPRESERVE99");
    expect(storedObj.gtmContainerId).toBe("GTM-KEEP123");
    expect(storedObj.gtmRiskAckVersion).toBe(2);
    expect(storedObj.customFlag).toBe("keep-me");

    // Beta tenant (unseeded site_settings row) returns version 0 on GET and inserts atomically on expectedVersion 0
    const betaGet = await handleTenantAnalyticsRequest(
      beta.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${beta.handle}/analytics`, "GET", {
        cookie: betaOwnerCookie,
      }),
      runtimeEnv,
    );
    expect(betaGet.status).toBe(200);
    const betaInitial = (await betaGet.json()) as { version: number; ga4MeasurementId: string | null };
    expect(betaInitial.version).toBe(0);
    expect(betaInitial.ga4MeasurementId).toBeNull();

    const betaSave = await handleTenantAnalyticsRequest(
      beta.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${beta.handle}/analytics`, "PATCH", {
        cookie: betaOwnerCookie,
        body: { ga4MeasurementId: "G-BETA123456", expectedVersion: 0 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 40_000 },
    );
    expect(betaSave.status).toBe(200);
    const betaSaved = (await betaSave.json()) as { version: number; ga4MeasurementId: string | null };
    expect(betaSaved.version).toBe(1);
    expect(betaSaved.ga4MeasurementId).toBe("G-BETA123456");
    expect(await countAnalyticsAuditRows(betaDb)).toBe(1);
  });

  it("denies PATCH with 403 SUBSCRIPTION_LOCKED when tenant status is locked", async () => {
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await db
      .update(tenants)
      .set({ status: "locked", updatedAt: new Date(BASE_NOW_MS + 50_000) })
      .where(eq(tenants.id, alpha.id));

    try {
      const lockedPatch = await handleTenantAnalyticsRequest(
        alpha.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "PATCH", {
          cookie: ownerCookie,
          body: {
            ga4MeasurementId: "G-LOCKED1234",
            expectedVersion: 4,
          },
        }),
        runtimeEnv,
      );
      expect(lockedPatch.status).toBe(403);
      const lockedBody = (await lockedPatch.json()) as { error: { code: string } };
      expect(lockedBody.error.code).toBe("SUBSCRIPTION_LOCKED");

      // Read-only GET still allowed while locked
      const lockedGet = await handleTenantAnalyticsRequest(
        alpha.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${alpha.handle}/analytics`, "GET", {
          cookie: ownerCookie,
        }),
        runtimeEnv,
      );
      expect(lockedGet.status).toBe(200);
    } finally {
      await db
        .update(tenants)
        .set({ status: "active", updatedAt: new Date(BASE_NOW_MS + 60_000) })
        .where(eq(tenants.id, alpha.id));
    }
  });
});

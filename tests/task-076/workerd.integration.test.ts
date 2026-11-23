import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  APP_SESSION_COOKIE_NAME,
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
  recordSessionSecondFactorVerification,
} from "@punyasitus/auth";
import { GTM_RISK_ACK_VERSION } from "@punyasitus/core/analytics/gtm";
import { createLocalMailSink } from "@punyasitus/core/email/index";
import {
  applyGtmKillSwitchMigration,
  executeConsoleTenantGtmKillSwitch,
  getTenantFullAnalyticsSettings,
  GtmSettingsDomainError,
  updateTenantGtmSettings,
} from "@punyasitus/db/analytics-settings/index";
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
  ensurePlatformOperatorRolesSchema,
  listPlatformAuditEntries,
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { serializeConsentCookie } from "../../apps/web/src/core/privacy.ts";
import {
  executePublicCspMiddleware,
  executeTenantWithConsentAwareCspMiddleware,
} from "../../apps/web/src/middleware/csp.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleConsoleTenantGtmRequest } from "../../apps/web/src/pages/api/console/tenants/[tenantId]/gtm.ts";
import type { TenantAnalyticsRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/analytics/_shared.ts";
import { handleTenantGtmAnalyticsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/analytics/gtm.ts";
import { handleTenantGtmTemplateDownloadRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/analytics/gtm/template.ts";
import { SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TEST_APP_SECRET = "task076-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "task076-console-auth-secret-fedcba9876543210fedcba987654";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 8, 0, 0);

function buildAppEnv(): TenantAnalyticsRuntimeEnv {
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

function extractAppSessionCookie(res: Response): string {
  const pair = getSetCookies(res.headers).find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!pair) throw new Error("Missing app session cookie");
  return (pair.split(";")[0] ?? "").trim();
}

function makeAppRequest(
  pathname: string,
  method: "GET" | "PATCH" | "POST",
  opts: { cookie?: string; body?: unknown; origin?: string } = {},
): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
    headers.set("Origin", opts.origin ?? APP_ORIGIN);
  }
  return new Request(`${APP_ORIGIN}${pathname}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function openMigratedTenantDb(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const stub = env.TENANT_STORE.get(doId);
  await runInDurableObject(stub, (_instance, state) =>
    applyTenantMigrations(state.storage as unknown as StorageLike, TENANT_MIGRATIONS),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function signUpAppUser(email: string, name: string) {
  const res = await handleBetterAuthRequest(
    makeAppRequest("/api/auth/sign-up/email", "POST", {
      body: { email, password: "StrongPassword!2026", name },
    }),
    buildAppEnv(),
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { user?: { id: string } };
  return { userId: data.user?.id ?? "", cookie: extractAppSessionCookie(res) };
}

describe("TASK-076 Workerd Integration — Tenant GTM RBAC, Risk Ack, Mutual Exclusion, Kill Switch & CSP", () => {
  const [alpha, beta] = SYNTHETIC_TENANTS;
  const alphaOrgId = "org_t076_alpha_0000000001";
  const betaOrgId = "org_t076_beta_00000000002";
  const baseDate = new Date(BASE_NOW_MS);

  let alphaDb: D1Database;
  let betaDb: D1Database;

  let ownerCookie = "";
  let adminCookie = "";
  let editorCookie = "";
  let betaOwnerCookie = "";
  let operatorCookie = "";
  let operatorSessionId = "";
  let operatorUserId = "";

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await applyGtmKillSwitchMigration(env.PLATFORM_DB);

    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await db
      .insert(organizations)
      .values([
        { id: alphaOrgId, name: alpha.siteTitle, slug: alpha.handle, createdAt: baseDate, updatedAt: baseDate },
        { id: betaOrgId, name: beta.siteTitle, slug: beta.handle, createdAt: baseDate, updatedAt: baseDate },
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
          version: 1,
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
          version: 1,
          createdAt: baseDate,
          updatedAt: baseDate,
        },
      ])
      .onConflictDoNothing();

    alphaDb = await openMigratedTenantDb(alpha.id);
    betaDb = await openMigratedTenantDb(beta.id);

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

    const owner = await signUpAppUser("owner.t076@alpha.example", "Owner Alpha");
    const admin = await signUpAppUser("admin.t076@alpha.example", "Admin Alpha");
    const editor = await signUpAppUser("editor.t076@alpha.example", "Editor Alpha");
    const betaOwner = await signUpAppUser("owner.t076@beta.example", "Owner Beta");

    ownerCookie = owner.cookie;
    adminCookie = admin.cookie;
    editorCookie = editor.cookie;
    betaOwnerCookie = betaOwner.cookie;

    await db
      .insert(members)
      .values([
        { id: "mem_t076_owner", organizationId: alphaOrgId, userId: owner.userId, role: "owner", createdAt: baseDate },
        { id: "mem_t076_admin", organizationId: alphaOrgId, userId: admin.userId, role: "admin", createdAt: baseDate },
        { id: "mem_t076_editor", organizationId: alphaOrgId, userId: editor.userId, role: "editor", createdAt: baseDate },
        { id: "mem_t076_beta", organizationId: betaOrgId, userId: betaOwner.userId, role: "owner", createdAt: baseDate },
      ])
      .onConflictDoNothing();

    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: TEST_CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "superadmin.t076@punyasitus.com",
      password: "ConsoleOp!Pass2026",
      name: "Superadmin T076",
      nowMs: BASE_NOW_MS,
    });
    operatorCookie = op.cookieHeader;
    operatorSessionId = op.session.id;
    operatorUserId = op.user.id;
  });

  it("enforces RBAC: editor denied (403), admin may enter IDs but CANNOT turn GTM on (403 OWNER_ONLY_GTM_ACTIVATION), cross-tenant neutral 404", async () => {
    const appEnv = buildAppEnv();

    // Cross-tenant -> neutral 404
    const cross = await handleTenantGtmAnalyticsRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "GET", { cookie: betaOwnerCookie }),
      appEnv,
    );
    expect(cross.status).toBe(404);

    // Editor -> GET & template & PATCH ALL denied 403 (requires settings:read / settings:write)
    const editorGet = await handleTenantGtmAnalyticsRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "GET", { cookie: editorCookie }),
      appEnv,
    );
    expect(editorGet.status).toBe(403);

    const editorTpl = await handleTenantGtmTemplateDownloadRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm/template`, "GET", {
        cookie: editorCookie,
      }),
      appEnv,
    );
    expect(editorTpl.status).toBe(403);

    const editorPatch = await handleTenantGtmAnalyticsRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "PATCH", {
        cookie: editorCookie,
        body: { gtmContainerId: "GTM-ABC1234", expectedVersion: 1 },
      }),
      appEnv,
    );
    expect(editorPatch.status).toBe(403);

    // Owner/Admin GET succeeds (200) and redacts internal operator disabledBy field
    const adminGet = await handleTenantGtmAnalyticsRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "GET", { cookie: adminCookie }),
      appEnv,
    );
    expect(adminGet.status).toBe(200);
    const adminGetJson = (await adminGet.json()) as {
      operatorKillSwitch: Record<string, unknown>;
    };
    expect(adminGetJson.operatorKillSwitch.active).toBe(false);
    expect("disabledBy" in adminGetJson.operatorKillSwitch).toBe(false);

    // Admin enters GTM container ID + vendor modes (GTM stays off) -> 200 (v1 -> v2)
    const adminSaveId = await handleTenantGtmAnalyticsRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "PATCH", {
        cookie: adminCookie,
        body: {
          gtmContainerId: "GTM-ABC1234",
          vendorModes: { ga4: "gtm", meta: "direct", tiktok: "gtm" },
          metaPixelId: "123456789012345",
          expectedVersion: 1,
        },
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 1000 },
    );
    expect(adminSaveId.status).toBe(200);
    const saved = (await adminSaveId.json()) as { version: number; gtmEnabled: boolean; gtmContainerId: string };
    expect(saved.version).toBe(2);
    expect(saved.gtmContainerId).toBe("GTM-ABC1234");
    expect(saved.gtmEnabled).toBe(false);

    // Admin tries to turn GTM ON -> DENIED 403 OWNER_ONLY_GTM_ACTIVATION
    const adminEnable = await handleTenantGtmAnalyticsRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "PATCH", {
        cookie: adminCookie,
        body: {
          gtmEnabled: true,
          riskAcknowledgement: { accepted: true, version: GTM_RISK_ACK_VERSION },
          expectedVersion: 2,
        },
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 2000 },
    );
    expect(adminEnable.status).toBe(403);
    const adminErr = (await adminEnable.json()) as { error: { code: string } };
    expect(adminErr.error.code).toBe("OWNER_ONLY_GTM_ACTIVATION");
  });

  it("rejects dual-mode direct+GTM conflict (422), missing risk ack (422), invalid IDs (422), stale version (409), and allows owner audited activation", async () => {
    const appEnv = buildAppEnv();

    // Dual-mode conflict: GA4 is routed via GTM while also passing ga4MeasurementId -> 422 VENDOR_DUAL_MODE_CONFLICT
    const dual = await handleTenantGtmAnalyticsRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "PATCH", {
        cookie: ownerCookie,
        body: {
          vendorModes: { ga4: "gtm" },
          ga4MeasurementId: "G-DOUBLE1234",
          expectedVersion: 2,
        },
      }),
      appEnv,
    );
    expect(dual.status).toBe(422);
    const dualBody = (await dual.json()) as { error: { code: string } };
    expect(dualBody.error.code).toBe("VENDOR_DUAL_MODE_CONFLICT");

    // Owner tries to turn GTM on WITHOUT riskAcknowledgement -> 422 GTM_RISK_ACK_REQUIRED
    const noAck = await handleTenantGtmAnalyticsRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "PATCH", {
        cookie: ownerCookie,
        body: { gtmEnabled: true, expectedVersion: 2 },
      }),
      appEnv,
    );
    expect(noAck.status).toBe(422);
    const noAckBody = (await noAck.json()) as { error: { code: string } };
    expect(noAckBody.error.code).toBe("GTM_RISK_ACK_REQUIRED");

    // Owner turns GTM ON WITH versioned risk acknowledgement -> 200 (v2 -> v3) + audited in tenant_activity_log + analytics_risk_ack_at
    const ownerEnable = await handleTenantGtmAnalyticsRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "PATCH", {
        cookie: ownerCookie,
        body: {
          gtmEnabled: true,
          riskAcknowledgement: { accepted: true, version: GTM_RISK_ACK_VERSION },
          expectedVersion: 2,
        },
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );
    expect(ownerEnable.status).toBe(200);
    const enabledBody = (await ownerEnable.json()) as {
      version: number;
      gtmEnabled: boolean;
      gtmRiskAck: { accepted: boolean; version: number } | null;
    };
    expect(enabledBody.version).toBe(3);
    expect(enabledBody.gtmEnabled).toBe(true);
    expect(enabledBody.gtmRiskAck?.accepted).toBe(true);
    expect(enabledBody.gtmRiskAck?.version).toBe(GTM_RISK_ACK_VERSION);

    const riskAckRow = await alphaDb
      .prepare("SELECT analytics_risk_ack_at FROM site_settings WHERE id = 1")
      .first<{ analytics_risk_ack_at: number | null }>();
    expect(riskAckRow?.analytics_risk_ack_at).toBe(BASE_NOW_MS + 5000);

    const auditRow = await alphaDb
      .prepare("SELECT action, summary FROM tenant_activity_log WHERE action = 'analytics.gtm_enabled' ORDER BY id DESC LIMIT 1")
      .first<{ action: string; summary: string }>();
    expect(auditRow?.action).toBe("analytics.gtm_enabled");

    // Stale expectedVersion (2 instead of 3) -> 409 STALE_VERSION
    const stale = await handleTenantGtmAnalyticsRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "PATCH", {
        cookie: ownerCookie,
        body: { gtmEnabled: false, expectedVersion: 2 },
      }),
      appEnv,
    );
    expect(stale.status).toBe(409);

    // Downloadable container JSON template endpoint works for authenticated tenant member
    const tplRes = await handleTenantGtmTemplateDownloadRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm/template`, "GET", {
        cookie: ownerCookie,
      }),
      appEnv,
    );
    expect(tplRes.status).toBe(200);
    expect(tplRes.headers.get("content-disposition")).toContain("punyasitus-gtm-container-template-v1.json");
    const tplJson = (await tplRes.json()) as { exportFormatVersion: number };
    expect(tplJson.exportFormatVersion).toBe(2);
  });

  it("enforces strict CSP before consent and relaxed GTM CSP with per-response nonce ONLY after analytics consent on public tenant pages", async () => {
    const publicHtml = `<!doctype html><html><head><script type="application/json">{"ok":true}</script></head><body><script>window.__inlineRan=true;</script></body></html>`;
    const baseTenant = {
      id: alpha.id,
      organizationId: alphaOrgId,
      handle: alpha.handle,
      name: alpha.siteTitle,
      vertical: "compro" as const,
      status: "active" as const,
      storedStatus: "active" as const,
      operatorHold: false,
      cacheVersion: 1,
      schemaVersion: 1,
      host: `${alpha.handle}.situsku.click`,
      hostKind: "subdomain" as const,
      isPrimary: true,
      primaryHost: `${alpha.handle}.situsku.click`,
      primaryHostKind: "subdomain" as const,
    };

    // 1. Public page BEFORE consent -> strict CSP, zero GTM origins
    const preConsentRes = await executePublicCspMiddleware(
      {
        request: new Request(`https://${alpha.handle}.situsku.click/`),
        locals: {
          surface: "tenant",
          host: `${alpha.handle}.situsku.click`,
          isLocalLoopback: false,
          tenant: baseTenant,
          tenantDb: alphaDb,
          authUser: null,
          authSession: null,
          authorizedTenantMember: null,
        },
      },
      async () => new Response(publicHtml, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }),
      { PLATFORM_DB: env.PLATFORM_DB, APP_ENV: "test" },
    );
    expect(preConsentRes.headers.get("X-PunyaSitus-CSP-Profile")).toBe("strict");
    const strictCsp = preConsentRes.headers.get("Content-Security-Policy") ?? "";
    expect(strictCsp).not.toContain("googletagmanager.com");
    // Finding #2: strict CSP preserves Turnstile (script-src + frame-src) and YouTube-nocookie (frame-src)
    expect(strictCsp).toContain("https://challenges.cloudflare.com");
    expect(strictCsp).toContain("https://www.youtube-nocookie.com");

    // 2. Public page AFTER analytics consent -> relaxed GTM CSP with fresh per-response nonce & nonced inline scripts
    const consentCookie = serializeConsentCookie({
      version: 1,
      analytics: true,
      marketing: true,
      maps: false,
      updatedAt: new Date(BASE_NOW_MS + 6000).toISOString(),
    }).split(";")[0]!;

    const locals1 = {
      surface: "tenant" as const,
      host: `${alpha.handle}.situsku.click`,
      isLocalLoopback: false,
      tenant: baseTenant,
      tenantDb: alphaDb,
      authUser: null,
      authSession: null,
      authorizedTenantMember: null,
      cspNonce: null as string | null,
      cspProfile: "strict" as "strict" | "gtm-relaxed",
    };
    const postConsentRes1 = await executePublicCspMiddleware(
      {
        request: new Request(`https://${alpha.handle}.situsku.click/`, {
          headers: { Cookie: consentCookie },
        }),
        locals: locals1,
      },
      async () => new Response(publicHtml, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }),
      { PLATFORM_DB: env.PLATFORM_DB, APP_ENV: "test" },
    );
    expect(postConsentRes1.headers.get("X-PunyaSitus-CSP-Profile")).toBe("gtm-relaxed");
    const csp1 = postConsentRes1.headers.get("Content-Security-Policy") ?? "";
    expect(csp1).toContain(`'nonce-${locals1.cspNonce}'`);
    expect(csp1).toContain("https://www.googletagmanager.com");
    expect(csp1).toContain("https://connect.facebook.net");
    expect(csp1).toContain("https://analytics.tiktok.com");
    expect(csp1).toContain("https://challenges.cloudflare.com");
    expect(csp1).toContain("https://www.youtube-nocookie.com");
    expect(postConsentRes1.headers.get("Vary")).toContain("Cookie");
    const body1 = await postConsentRes1.text();
    expect(body1).toContain(`<script nonce="${locals1.cspNonce}">window.__inlineRan=true;</script>`);

    // 2b. Non-tenant `app` HTML surface keeps X-PunyaSitus-CSP-Profile: strict without clobbering app CSP
    const appSurfaceRes = await executePublicCspMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/dashboard/${alpha.handle}/settings/analytics`, {
          headers: { Cookie: consentCookie },
        }),
        locals: {
          surface: "app",
          host: "app.punyasitus.com",
          isLocalLoopback: false,
          tenant: null,
          tenantDb: null,
          authUser: null,
          authSession: null,
          authorizedTenantMember: null,
        },
      },
      async () => new Response("<html><body>app</body></html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }),
      { PLATFORM_DB: env.PLATFORM_DB, APP_ENV: "test" },
    );
    expect(appSurfaceRes.headers.get("X-PunyaSitus-CSP-Profile")).toBe("strict");
    expect(appSurfaceRes.headers.get("Content-Security-Policy")).toBeNull();

    // 2c. Warm edge cache regression (Finding #3): anonymous visitor warms strict cache,
    //     consented visitor MUST bypass warm anonymous cache and get gtm-relaxed + fresh nonce!
    await env.PLATFORM_DB.prepare(
      `INSERT OR IGNORE INTO tenant_hosts (
         host, tenant_id, kind, is_primary, status, ssl_status, created_at, updated_at
       ) VALUES (?, ?, 'subdomain', 1, 'active', 'active', ?, ?)`,
    )
      .bind(`${alpha.handle}.situsku.click`, alpha.id, BASE_NOW_MS, BASE_NOW_MS)
      .run();

    const cacheStore = new Map<string, Response>();
    const memoryCache = {
      async match(req: RequestInfo | URL): Promise<Response | undefined> {
        const key = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
        const found = cacheStore.get(key);
        return found ? found.clone() : undefined;
      },
      async put(req: RequestInfo | URL, res: Response): Promise<void> {
        const key = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
        cacheStore.set(key, res.clone());
      },
      async delete(req: RequestInfo | URL): Promise<boolean> {
        const key = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
        return cacheStore.delete(key);
      },
    } as unknown as Cache;

    let innerRenderCount = 0;
    const tenantMiddlewareEnv = {
      PLATFORM_DB: env.PLATFORM_DB,
      TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      SAAS_ZONE: "situsku.click",
      PLATFORM_DOMAIN: "punyasitus.com",
      APP_ENV: "test",
    };

    const runPublicReq = (cookie?: string) => {
      const locals = {
        surface: "unknown" as "tenant" | "app" | "console" | "marketing" | "unknown",
        host: `${alpha.handle}.situsku.click`,
        isLocalLoopback: false,
        tenant: null,
        tenantDb: null,
        authUser: null,
        authSession: null,
        authorizedTenantMember: null,
        cspNonce: null as string | null,
        cspProfile: "strict" as "strict" | "gtm-relaxed",
      };
      return executeTenantWithConsentAwareCspMiddleware(
        {
          request: new Request(`https://${alpha.handle}.situsku.click/`, {
            headers: cookie ? { Cookie: cookie } : undefined,
          }),
          locals,
        },
        async () => {
          innerRenderCount += 1;
          return new Response(publicHtml, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "public, max-age=60, s-maxage=300",
            },
          });
        },
        tenantMiddlewareEnv,
        { cache: memoryCache, nowMs: BASE_NOW_MS + 6500 },
      ).then((response) => ({ response, locals }));
    };

    // Visitor 1 (no consent) -> warms anonymous edge cache with strict CSP
    const warm1 = await runPublicReq();
    expect(warm1.response.headers.get("X-PunyaSitus-CSP-Profile")).toBe("strict");
    expect(innerRenderCount).toBe(1);

    // Visitor 1 repeat (no consent) -> served directly from warm anonymous cache (no re-render)
    const warmHit = await runPublicReq();
    expect(warmHit.response.headers.get("X-PunyaSitus-CSP-Profile")).toBe("strict");
    expect(warmHit.response.headers.get("X-PunyaSitus-Cache")).toBe("HIT");
    expect(innerRenderCount).toBe(1);

    // Visitor 2 (consented analytics=true) -> BYPASSES warm anonymous cache, gets gtm-relaxed + fresh nonce!
    const consentedLive1 = await runPublicReq(consentCookie);
    expect(innerRenderCount).toBe(2);
    expect(consentedLive1.response.headers.get("X-PunyaSitus-CSP-Profile")).toBe("gtm-relaxed");
    expect(consentedLive1.response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(consentedLive1.response.headers.get("Vary")).toContain("Cookie");
    expect(consentedLive1.locals.cspNonce).toBeTruthy();

    // Visitor 2b (consented analytics=true again) -> fresh unique nonce, never cached!
    const consentedLive2 = await runPublicReq(consentCookie);
    expect(innerRenderCount).toBe(3);
    expect(consentedLive2.response.headers.get("X-PunyaSitus-CSP-Profile")).toBe("gtm-relaxed");
    expect(consentedLive2.locals.cspNonce).toBeTruthy();
    expect(consentedLive2.locals.cspNonce).not.toBe(consentedLive1.locals.cspNonce);

    // 3. Non-GTM tenant (Beta) AFTER consent still gets STRICT CSP
    const betaRes = await executePublicCspMiddleware(
      {
        request: new Request(`https://${beta.handle}.situsku.click/`, {
          headers: { Cookie: consentCookie },
        }),
        locals: {
          surface: "tenant",
          host: `${beta.handle}.situsku.click`,
          isLocalLoopback: false,
          tenant: { ...baseTenant, id: beta.id, handle: beta.handle, host: `${beta.handle}.situsku.click` },
          tenantDb: betaDb,
          authUser: null,
          authSession: null,
          authorizedTenantMember: null,
        },
      },
      async () => new Response(publicHtml, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }),
      { PLATFORM_DB: env.PLATFORM_DB, APP_ENV: "test" },
    );
    expect(betaRes.headers.get("X-PunyaSitus-CSP-Profile")).toBe("strict");

    // 4. Maintenance 503 with `default-src 'none'` preserves strict CSP untouched
    const maintRes = await executePublicCspMiddleware(
      {
        request: new Request(`https://${alpha.handle}.situsku.click/`, {
          headers: { Cookie: consentCookie },
        }),
        locals: {
          surface: "tenant",
          host: `${alpha.handle}.situsku.click`,
          isLocalLoopback: false,
          tenant: baseTenant,
          tenantDb: alphaDb,
          authUser: null,
          authSession: null,
          authorizedTenantMember: null,
        },
      },
      async () =>
        new Response("<h1>Situs dalam perbaikan</h1>", {
          status: 503,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": "default-src 'none'",
          },
        }),
      { PLATFORM_DB: env.PLATFORM_DB, APP_ENV: "test" },
    );
    expect(maintRes.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(maintRes.headers.get("X-PunyaSitus-CSP-Profile")).toBe("strict");
  });

  it("enforces console host isolation (bare 404), step-up 2FA, audited operator kill switch, owner email notice, direct-tag preservation, and blocks owner re-enable until lifted", async () => {
    const mailSink = createLocalMailSink();
    const consoleEnv = {
      ...buildAppEnv(),
      SAAS_ZONE: "situsku.click",
    };

    // 1. Non-console host -> bare neutral 404 (zero console copy!)
    const wrongHost = await handleConsoleTenantGtmRequest(
      alpha.handle,
      new Request(`${APP_ORIGIN}/api/console/tenants/${alpha.handle}/gtm`, {
        method: "GET",
        headers: { Cookie: operatorCookie },
      }),
      consoleEnv,
    );
    expect(wrongHost.status).toBe(404);
    expect(await wrongHost.text()).toBe("Not Found");

    // 2. Stale 2FA (> 10 minutes) -> 403 REAUTH_REQUIRED on POST
    const staleStepUp = await handleConsoleTenantGtmRequest(
      alpha.handle,
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants/${alpha.handle}/gtm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: operatorCookie,
          "Idempotency-Key": "gtm-kill-stale-001",
        },
        body: JSON.stringify({
          action: "disable",
          reasonCategory: "malware",
          reason: "Detected unauthorized script injected inside GTM container",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs: BASE_NOW_MS + DEFAULT_SECOND_FACTOR_WINDOW_MS + 60_000 },
    );
    expect(staleStepUp.status).toBe(403);
    const staleBody = (await staleStepUp.json()) as { code: string };
    expect(staleBody.code).toBe("REAUTH_REQUIRED");

    // 3. Fresh 2FA step-up -> operator activates kill switch with reason -> audited + owner notified + direct Meta Pixel preserved!
    const freshNow = BASE_NOW_MS + 10_000;
    await recordSessionSecondFactorVerification(env.PLATFORM_DB, {
      sessionId: operatorSessionId,
      userId: operatorUserId,
      method: "totp",
      nowMs: freshNow,
    });

    // Read current tenant version (still 1 in PLATFORM_DB.tenants)
    const tenantBefore = await env.PLATFORM_DB.prepare("SELECT version FROM tenants WHERE id = ?")
      .bind(alpha.id)
      .first<{ version: number }>();

    const killRes = await handleConsoleTenantGtmRequest(
      alpha.handle,
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants/${alpha.handle}/gtm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: operatorCookie,
          "Idempotency-Key": "gtm-kill-alpha-001",
        },
        body: JSON.stringify({
          action: "disable",
          reasonCategory: "malware",
          reason: "Detected malicious third-party redirect tag inside tenant GTM container",
          expectedVersion: Number(tenantBefore?.version ?? 1),
        }),
      }),
      consoleEnv,
      { nowMs: freshNow + 1000, emailPort: mailSink },
    );
    expect(killRes.status).toBe(200);
    const killJson = (await killRes.json()) as {
      success: boolean;
      replayed: boolean;
      tenantMirrorSynced: boolean;
      killSwitch: { disabled: boolean; reasonCategory: string };
      auditId: string;
      ownerNotification: { attempted: boolean; directSent: boolean };
    };
    expect(killJson.success).toBe(true);
    expect(killJson.replayed).toBe(false);
    expect(killJson.tenantMirrorSynced).toBe(true);
    expect(killJson.killSwitch.disabled).toBe(true);
    expect(killJson.killSwitch.reasonCategory).toBe("malware");
    expect(killJson.auditId).toBeTruthy();
    expect(killJson.ownerNotification.attempted).toBe(true);
    expect(killJson.ownerNotification.directSent).toBe(true);

    // Finding #6: Tenant-facing GET redacts internal operator user ID (`disabledBy`) even while kill switch is active!
    const ownerGetKilled = await handleTenantGtmAnalyticsRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "GET", { cookie: ownerCookie }),
      buildAppEnv(),
    );
    expect(ownerGetKilled.status).toBe(200);
    const ownerKilledJson = (await ownerGetKilled.json()) as {
      operatorKillSwitch: Record<string, unknown>;
    };
    expect(ownerKilledJson.operatorKillSwitch.active).toBe(true);
    expect(ownerKilledJson.operatorKillSwitch.disabled).toBe(true);
    expect(ownerKilledJson.operatorKillSwitch.category).toBe("malware");
    expect(ownerKilledJson.operatorKillSwitch.reason).toContain("malicious third-party redirect tag");
    expect(ownerKilledJson.operatorKillSwitch.disabledAt).toBeTruthy();
    expect("disabledBy" in ownerKilledJson.operatorKillSwitch).toBe(false);

    // Owner email received via local sink
    const ownerMails = mailSink.findByTemplate("gtm-kill-switch-owner-notice");
    expect(ownerMails).toHaveLength(1);
    expect(ownerMails[0]?.to).toBe("owner.t076@alpha.example");
    expect(ownerMails[0]?.html).toContain("GTM-ABC1234");

    // Platform audit recorded atomically
    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      tenantId: alpha.id,
      action: "console.tenant.gtm_kill_switch.disable",
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // Direct Meta Pixel ID is STILL preserved and active while GTM is killed!
    const afterKill = await getTenantFullAnalyticsSettings(alphaDb, env.PLATFORM_DB, alpha.id);
    expect(afterKill.gtmEnabled).toBe(false);
    expect(afterKill.operatorKillSwitch.disabled).toBe(true);
    expect(afterKill.metaPixelId).toBe("123456789012345");

    // Idempotent replay with same key & payload returns 200 replayed: true without duplicate email!
    const replay = await handleConsoleTenantGtmRequest(
      alpha.handle,
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants/${alpha.handle}/gtm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: operatorCookie,
          "Idempotency-Key": "gtm-kill-alpha-001",
        },
        body: JSON.stringify({
          action: "disable",
          reasonCategory: "malware",
          reason: "Detected malicious third-party redirect tag inside tenant GTM container",
          expectedVersion: Number(tenantBefore?.version ?? 1),
        }),
      }),
      consoleEnv,
      { nowMs: freshNow + 2000, emailPort: mailSink },
    );
    expect(replay.status).toBe(200);
    const replayJson = (await replay.json()) as { replayed: boolean };
    expect(replayJson.replayed).toBe(true);
    expect(mailSink.findByTemplate("gtm-kill-switch-owner-notice")).toHaveLength(1);

    // Tenant owner CANNOT re-enable GTM while kill switch is active -> 403 GTM_DISABLED_BY_OPERATOR
    const ownerBlocked = await handleTenantGtmAnalyticsRequest(
      alpha.handle,
      makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "PATCH", {
        cookie: ownerCookie,
        body: {
          gtmEnabled: true,
          riskAcknowledgement: { accepted: true, version: GTM_RISK_ACK_VERSION },
          expectedVersion: afterKill.version,
        },
      }),
      buildAppEnv(),
      { nowMs: freshNow + 3000 },
    );
    expect(ownerBlocked.status).toBe(403);
    const blockedErr = (await ownerBlocked.json()) as { error: { code: string } };
    expect(blockedErr.error.code).toBe("GTM_DISABLED_BY_OPERATOR");

    // Middleware CSP immediately drops back to STRICT even with analytics consent cookie!
    const consentCookie = serializeConsentCookie({
      version: 1,
      analytics: true,
      marketing: true,
      maps: false,
      updatedAt: new Date(freshNow).toISOString(),
    }).split(";")[0]!;
    const killedPublicRes = await executePublicCspMiddleware(
      {
        request: new Request(`https://${alpha.handle}.situsku.click/`, {
          headers: { Cookie: consentCookie },
        }),
        locals: {
          surface: "tenant",
          host: `${alpha.handle}.situsku.click`,
          isLocalLoopback: false,
          tenant: {
            id: alpha.id,
            organizationId: alphaOrgId,
            handle: alpha.handle,
            name: alpha.siteTitle,
            vertical: "compro",
            status: "active",
            storedStatus: "active",
            operatorHold: false,
            cacheVersion: 2,
            schemaVersion: 1,
            host: `${alpha.handle}.situsku.click`,
            hostKind: "subdomain",
            isPrimary: true,
            primaryHost: `${alpha.handle}.situsku.click`,
            primaryHostKind: "subdomain",
          },
          tenantDb: alphaDb,
          authUser: null,
          authSession: null,
          authorizedTenantMember: null,
        },
      },
      async () => new Response("<html><body>ok</body></html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      { PLATFORM_DB: env.PLATFORM_DB, APP_ENV: "test" },
    );
    expect(killedPublicRes.headers.get("X-PunyaSitus-CSP-Profile")).toBe("strict");
    expect(killedPublicRes.headers.get("Content-Security-Policy")).not.toContain("googletagmanager.com");

    // Locked tenant still blocked 403 SUBSCRIPTION_LOCKED on GTM writes
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await db.update(tenants).set({ status: "locked" }).where(eq(tenants.id, alpha.id));
    try {
      const lockedRes = await handleTenantGtmAnalyticsRequest(
        alpha.handle,
        makeAppRequest(`/api/tenants/${alpha.handle}/analytics/gtm`, "PATCH", {
          cookie: ownerCookie,
          body: { gtmContainerId: "GTM-LOCKED1", expectedVersion: afterKill.version },
        }),
        buildAppEnv(),
      );
      expect(lockedRes.status).toBe(403);
    } finally {
      await db.update(tenants).set({ status: "active" }).where(eq(tenants.id, alpha.id));
    }
  });

  it("Findings #1, #4, #5 regressions: atomic stale-version kill-switch batch leaves policy/audit/ledger untouched, cache_version failure rolls back TenantStore, and mirror retries/reports honestly", async () => {
    // --- Finding #1: Stale-version race INSIDE PLATFORM_DB.batch leaves tenant_gtm_policies, platform_audit & job_ledger untouched ---
    const betaBefore = await env.PLATFORM_DB.prepare("SELECT version FROM tenants WHERE id = ?")
      .bind(beta.id)
      .first<{ version: number }>();
    const betaStartVersion = Number(betaBefore?.version ?? 1);

    const raceKey = "gtm-kill-race-beta-001";
    let raceInjected = false;
    const racingPlatformDb = new Proxy(env.PLATFORM_DB, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!raceInjected) {
              raceInjected = true;
              // Simulate a concurrent writer advancing tenants.version right before the atomic batch executes!
              await env.PLATFORM_DB.prepare(
                `UPDATE tenants SET version = version + 1, updated_at = ? WHERE id = ?`,
              )
                .bind(BASE_NOW_MS + 99_000, beta.id)
                .run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    let caughtStale: unknown = null;
    try {
      await executeConsoleTenantGtmKillSwitch(racingPlatformDb, {
        actorUserId: operatorUserId,
        actorRole: "platform_superadmin",
        tenantId: beta.id,
        action: "disable",
        reasonCategory: "abuse",
        reason: "Race condition regression test for stale version inside atomic batch",
        expectedVersion: betaStartVersion,
        idempotencyKey: raceKey,
        tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
        nowMs: BASE_NOW_MS + 100_000,
      });
    } catch (err) {
      caughtStale = err;
    }

    expect(caughtStale).toBeInstanceOf(GtmSettingsDomainError);
    expect((caughtStale as GtmSettingsDomainError).status).toBe(409);
    expect((caughtStale as GtmSettingsDomainError).code).toBe("STALE_VERSION");

    // Verify ZERO rows created/mutated in tenant_gtm_policies, platform_audit, or job_ledger!
    const betaPolicyAfterRace = await env.PLATFORM_DB.prepare(
      `SELECT COUNT(*) AS cnt FROM tenant_gtm_policies WHERE tenant_id = ?`,
    )
      .bind(beta.id)
      .first<{ cnt: number }>();
    const betaAuditAfterRace = await env.PLATFORM_DB.prepare(
      `SELECT COUNT(*) AS cnt FROM platform_audit WHERE tenant_id = ? AND action = 'console.tenant.gtm_kill_switch.disable'`,
    )
      .bind(beta.id)
      .first<{ cnt: number }>();
    const betaLedgerAfterRace = await env.PLATFORM_DB.prepare(
      `SELECT COUNT(*) AS cnt FROM job_ledger WHERE idempotency_key = ?`,
    )
      .bind(`gtm-kill-switch:${raceKey}`)
      .first<{ cnt: number }>();

    expect(Number(betaPolicyAfterRace?.cnt ?? -1)).toBe(0);
    expect(Number(betaAuditAfterRace?.cnt ?? -1)).toBe(0);
    expect(Number(betaLedgerAfterRace?.cnt ?? -1)).toBe(0);

    // --- Finding #4: cache_version bump failure compensates/rolls back TenantStore and throws 503 ---
    const alphaBeforeCacheFail = await getTenantFullAnalyticsSettings(alphaDb, env.PLATFORM_DB, alpha.id);
    const failingCachePlatformDb = new Proxy(env.PLATFORM_DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            if (query.includes("SET cache_version = cache_version + 1")) {
              return {
                bind: () => ({
                  run: async () => {
                    throw new Error("Simulated PLATFORM_DB cache_version failure");
                  },
                }),
              } as unknown as D1PreparedStatement;
            }
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    let caughtCacheFail: unknown = null;
    try {
      await updateTenantGtmSettings(alphaDb, failingCachePlatformDb, {
        tenantId: alpha.id,
        patch: {
          gtmContainerId: "GTM-ROLLBK1",
          vendorModes: { ga4: "direct", meta: "direct", tiktok: "direct" },
        },
        expectedVersion: alphaBeforeCacheFail.version,
        actorUserId: "usr_owner_rollback",
        actorRole: "owner",
        nowMs: BASE_NOW_MS + 110_000,
      });
    } catch (err) {
      caughtCacheFail = err;
    }

    expect(caughtCacheFail).toBeInstanceOf(GtmSettingsDomainError);
    expect((caughtCacheFail as GtmSettingsDomainError).status).toBe(503);
    expect((caughtCacheFail as GtmSettingsDomainError).code).toBe("STORAGE_UNAVAILABLE");

    // TenantStore MUST be rolled back cleanly to exact prior version & container ID!
    const alphaAfterCacheFail = await getTenantFullAnalyticsSettings(alphaDb, env.PLATFORM_DB, alpha.id);
    expect(alphaAfterCacheFail.version).toBe(alphaBeforeCacheFail.version);
    expect(alphaAfterCacheFail.gtmContainerId).toBe(alphaBeforeCacheFail.gtmContainerId);

    // --- Finding #5: TenantStore mirror bounded retry & honest tenantMirrorSynced status ---
    const betaVersionNow = await env.PLATFORM_DB.prepare("SELECT version FROM tenants WHERE id = ?")
      .bind(beta.id)
      .first<{ version: number }>();
    const brokenTenantStore = {
      getByName: () => {
        throw new Error("Simulated TenantStore unavailable");
      },
    } as unknown as TenantStoreNamespaceLike;

    const unsyncedResult = await executeConsoleTenantGtmKillSwitch(env.PLATFORM_DB, {
      actorUserId: operatorUserId,
      actorRole: "platform_superadmin",
      tenantId: beta.id,
      action: "disable",
      reasonCategory: "performance",
      reason: "Simulated TenantStore outage to verify honest tenantMirrorSynced flag",
      expectedVersion: Number(betaVersionNow?.version ?? 2),
      idempotencyKey: "gtm-kill-beta-unsynced-001",
      tenantStore: brokenTenantStore,
      nowMs: BASE_NOW_MS + 120_000,
    });
    expect(unsyncedResult.killSwitch.disabled).toBe(true);
    expect(unsyncedResult.tenantMirrorSynced).toBe(false);

    // Lift on beta with live TenantStore -> tenantMirrorSynced: true
    const liftedBeta = await executeConsoleTenantGtmKillSwitch(env.PLATFORM_DB, {
      actorUserId: operatorUserId,
      actorRole: "platform_superadmin",
      tenantId: beta.id,
      action: "lift",
      reason: "Lifting simulated outage test block with live TenantStore binding",
      expectedVersion: unsyncedResult.version,
      idempotencyKey: "gtm-lift-beta-synced-001",
      tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      nowMs: BASE_NOW_MS + 125_000,
    });
    expect(liftedBeta.killSwitch.disabled).toBe(false);
    expect(liftedBeta.tenantMirrorSynced).toBe(true);
  });
});

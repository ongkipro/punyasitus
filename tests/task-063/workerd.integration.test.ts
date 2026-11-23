import { env } from "cloudflare:workers";
import { AuthorizationError } from "@punyasitus/auth/permissions";
import {
  assertAdminCsrfAndOrigin,
  resolveAuthorizedTenantMember,
} from "@punyasitus/auth/session-guard";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { createPage, publishPage } from "@punyasitus/db/pages/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
  users,
} from "@punyasitus/db/platform";
import {
  PLATFORM_PLUGIN_RUNTIME_MIGRATION,
  TENANT_PLUGIN_LEDGER_MIGRATION,
} from "@punyasitus/db/plugins/migrations";
import { RATE_LIMIT_WINDOW_MS } from "@punyasitus/db/rate-limits/index";
import {
  clearHostResolutionCache,
  evictHostFromCache,
} from "@punyasitus/db/routing/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  installOrEnablePluginForTenant,
  resolveActivePluginForTenant,
} from "../../apps/web/src/core/plugin-runtime.ts";
import {
  buildTenantEdgeCacheKey,
  routeEdgeRequest,
  STATE_PAGE_MESSAGES,
  type TenantGateEnv,
} from "../../apps/web/src/core/tenant.ts";
import { resolveTenantTheme } from "../../apps/web/src/core/theme-registry.ts";
import { handlePublicEventPost } from "../../apps/web/src/pages/api/events.ts";
import { handlePublicLeadPost } from "../../apps/web/src/pages/api/leads.ts";
import { handleRobotsTxtRequest } from "../../apps/web/src/pages/robots.txt.ts";
import { handleSitemapIndexRequest } from "../../apps/web/src/pages/sitemap.xml.ts";
import { SAMPLE_AGENCY_THEME_ID } from "../../apps/web/src/themes/custom/sample-agency/theme.ts";
import { SEO_AI_AUTOPILOT_PLUGIN_ID } from "../../packages/plugins/seo-ai-autopilot/index.ts";

const TENANT_A = {
  id: "01JT063ALPHA00000000000001",
  orgId: "org_t063_alpha",
  handle: "t063-alpha",
  name: "PT Alpha Checkpoint",
  host: "t063-alpha.situsku.click",
  userId: "usr_t063_alpha_owner",
  email: "alpha-owner@t063.example",
} as const;

const TENANT_B = {
  id: "01JT063BETA000000000000002",
  orgId: "org_t063_beta",
  handle: "t063-beta",
  name: "CV Beta Terisolasi",
  host: "t063-beta.situsku.click",
  userId: "usr_t063_beta_owner",
  email: "beta-owner@t063.example",
} as const;

function buildGateEnv(): TenantGateEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
  };
}

function getDefaultCache(): Cache {
  return (caches as unknown as { readonly default: Cache }).default;
}

async function seedTenantFixture(
  t: typeof TENANT_A | typeof TENANT_B,
  status: "active" | "trial",
): Promise<D1Database> {
  const now = new Date();
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  await db
    .insert(users)
    .values({
      id: t.userId,
      email: t.email,
      name: t.name,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

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
    .insert(members)
    .values({
      id: `mem_${t.handle}`,
      organizationId: t.orgId,
      userId: t.userId,
      role: "owner",
      createdAt: now,
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
      operatorHold: false,
      paidThrough: status === "active" ? new Date(Date.now() + 30 * 86400_000) : null,
      trialEndsAt: status === "trial" ? new Date(Date.now() + 7 * 86400_000) : null,
      cacheVersion: 1,
      schemaVersion: 0,
      version: 1,
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
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const stub = openTenantStoreStub(
    env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    t.id,
  );
  await orchestrateTenantMigration(env.PLATFORM_DB, stub, t.id, [
    ...TENANT_MIGRATIONS,
    TENANT_PLUGIN_LEDGER_MIGRATION,
  ]);
  return createTenantDb(stub);
}

describe("TASK-063 M1 Cross-Surface Workerd Integration Checkpoint", () => {
  let tenantADb: D1Database;
  let tenantBDb: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, [
      ...PLATFORM_MIGRATIONS,
      PLATFORM_PLUGIN_RUNTIME_MIGRATION,
    ]);
    tenantADb = await seedTenantFixture(TENANT_A, "active");
    tenantBDb = await seedTenantFixture(TENANT_B, "trial");

    const nowMs = Date.now();
    // Seed Tenant A site settings, real published homepage snapshot, and enable seo-ai-autopilot plugin
    await tenantADb
      .prepare(
        `INSERT OR REPLACE INTO site_settings (id, site_title, tagline, active_theme_id, blog_enabled, catalog_enabled, ai_training_policy, version, updated_at)
         VALUES (1, ?, 'Solusi Digital', 'compro', 1, 1, 'disallow', 1, ?)`,
      )
      .bind(TENANT_A.name, nowMs)
      .run();
    const createdHome = await createPage(tenantADb, {
      title: "Beranda Alpha",
      slug: "beranda",
      isHomepage: true,
      sections: [],
    });
    await publishPage(env.PLATFORM_DB, tenantADb, {
      tenantId: TENANT_A.id,
      pageId: createdHome.id,
      expectedVersion: createdHome.version,
      actorUserId: TENANT_A.userId,
    });
    await tenantADb
      .prepare(
        `INSERT OR REPLACE INTO installed_plugins (plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at)
         VALUES (?, '1.0.0', 1, '{}', 0, ?, ?)`,
      )
      .bind(SEO_AI_AUTOPILOT_PLUGIN_ID, nowMs, nowMs)
      .run();

    // Seed Tenant B site settings (trial, zero plugins installed)
    await tenantBDb
      .prepare(
        `INSERT OR REPLACE INTO site_settings (id, site_title, tagline, active_theme_id, blog_enabled, catalog_enabled, ai_training_policy, version, updated_at)
         VALUES (1, ?, 'Trial Beta', 'compro', 1, 1, 'allow', 1, ?)`,
      )
      .bind(TENANT_B.name, nowMs)
      .run();
  });

  beforeEach(async () => {
    clearHostResolutionCache();
    // Ensure Tenant A is active at start of each test
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await db
      .update(tenants)
      .set({ status: "active", operatorHold: false })
      .where(eq(tenants.id, TENANT_A.id));
  });

  it("1. Isolates surfaces and immediately returns 503 no-store noindex when a warm-cached tenant is suspended", async () => {
    const gateEnv = buildGateEnv();
    const cache = getDefaultCache();

    // Platform prefix blocked on tenant host
    const blockedDash = await routeEdgeRequest(
      new Request(`https://${TENANT_A.host}/dashboard/${TENANT_A.handle}`),
      gateEnv,
      { cache, render: () => new Response("must-not-serve", { status: 200 }) },
    );
    expect(blockedDash.status).toBe(404);
    expect(blockedDash.headers.get("Cache-Control")).toBe("no-store");

    // Warm caches.default synthetic key for Tenant A
    const warmKey = buildTenantEdgeCacheKey(TENANT_A.id, 1, TENANT_A.host, "/");
    await cache.put(
      warmKey,
      new Response("<h1>Cached Alpha Secret HTML</h1>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    // Suspend Tenant A in PLATFORM_DB and evict host cache
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await db
      .update(tenants)
      .set({ status: "suspended", operatorHold: true })
      .where(eq(tenants.id, TENANT_A.id));
    evictHostFromCache(TENANT_A.host);

    const res = await routeEdgeRequest(new Request(`https://${TENANT_A.host}/`), gateEnv, {
      cache,
      render: () => new Response("must-not-render", { status: 200 }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const body = await res.text();
    expect(body).toContain(STATE_PAGE_MESSAGES.suspended);
    expect(body).not.toContain("Cached Alpha Secret HTML");
  });

  it("2. Enforces live A-to-B membership isolation (404) and CSRF Origin rejection (403)", async () => {
    // Owner A authorized on Tenant A
    const allowA = await resolveAuthorizedTenantMember(env.PLATFORM_DB, {
      userId: TENANT_A.userId,
      handle: TENANT_A.handle,
      requiredPermission: "content:write",
    });
    expect(allowA.tenantId).toBe(TENANT_A.id);
    expect(allowA.role).toBe("owner");

    // Owner A strictly denied on Tenant B (throws 404 non-member AuthorizationError)
    let caughtErr: unknown = null;
    try {
      await resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: TENANT_A.userId,
        handle: TENANT_B.handle,
        requiredPermission: "content:read",
      });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(AuthorizationError);
    expect((caughtErr as AuthorizationError).status).toBe(404);

    // CSRF Origin guard rejects tenant subdomain origin
    const badOriginReq = new Request("https://app.punyasitus.com/api/tenants/t063-alpha/pages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `https://${TENANT_A.host}`,
      },
      body: "{}",
    });
    const csrfRes = assertAdminCsrfAndOrigin(badOriginReq, "https://app.punyasitus.com");
    expect(csrfRes.ok).toBe(false);
    if (!csrfRes.ok) {
      expect(csrfRes.status).toBe(403);
    }
  });

  it("3. Enforces public lead rate-limit, event PII redaction/rejection, and physical TenantStore isolation", async () => {
    const salt = "t063-checkpoint-rate-limit-salt";
    const nowMs = Date.now();

    // Valid lead submission on Tenant A persists ONLY into Tenant A's TenantStore
    const leadRes = await handlePublicLeadPost(
      new Request(`https://${TENANT_A.host}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${TENANT_A.host}`,
          "CF-Connecting-IP": "198.51.100.42",
          "Idempotency-Key": "00000000-0000-4000-8000-000000000063",
        },
        body: JSON.stringify({
          name: "Siti Rahma",
          phone: "081234567890",
          email: "siti@example.com",
          message: "Ingin menjadwalkan demo layanan konsultasi bisnis.",
          privacyConsent: true,
        }),
      }),
      {
        surface: "tenant",
        tenant: {
          id: TENANT_A.id,
          handle: TENANT_A.handle,
          name: TENANT_A.name,
          host: TENANT_A.host,
          status: "active",
        },
        tenantDb: tenantADb,
        platformDb: env.PLATFORM_DB,
        appEnv: "test",
        rateLimitSalt: salt,
        nowMs,
      },
    );
    expect(leadRes.status).toBe(201);

    // Confirm Tenant B's TenantStore has ZERO leads from Tenant A
    const betaLeads = await tenantBDb
      .prepare("SELECT COUNT(*) AS cnt FROM leads")
      .first<{ readonly cnt: number }>();
    expect(betaLeads?.cnt ?? 0).toBe(0);

    // Rate limit enforcement on public lead capture (limit=1 -> 2nd returns 429)
    const rateLimitedLead = await handlePublicLeadPost(
      new Request(`https://${TENANT_A.host}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${TENANT_A.host}`,
          "CF-Connecting-IP": "198.51.100.42",
          "Idempotency-Key": "00000000-0000-4000-8000-000000000064",
        },
        body: JSON.stringify({
          name: "Pengirim Kedua",
          phone: "081234567891",
          message: "Permintaan kedua yang melebihi batas laju.",
          privacyConsent: true,
        }),
      }),
      {
        surface: "tenant",
        tenant: {
          id: TENANT_A.id,
          handle: TENANT_A.handle,
          name: TENANT_A.name,
          host: TENANT_A.host,
          status: "active",
        },
        tenantDb: tenantADb,
        platformDb: env.PLATFORM_DB,
        appEnv: "test",
        rateLimitSalt: salt,
        nowMs,
        rateLimitPolicy: {
          perNetworkMinute: {
            name: "lead_network_minute",
            limit: 1,
            windowMs: RATE_LIMIT_WINDOW_MS.minute,
          },
          perTenantHour: {
            name: "lead_tenant_hour",
            limit: 100,
            windowMs: RATE_LIMIT_WINDOW_MS.hour,
          },
        },
      },
    );
    expect(rateLimitedLead.status).toBe(429);

    // Public event endpoint rejects PII fields (`email`, `phone`) with 422
    const piiEventRes = await handlePublicEventPost(
      new Request(`https://${TENANT_A.host}/api/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${TENANT_A.host}`,
          "CF-Connecting-IP": "198.51.100.42",
        },
        body: JSON.stringify({
          eventType: "wa_click",
          path: "/",
          email: "leak@example.com",
        }),
      }),
      {
        surface: "tenant",
        tenant: { id: TENANT_A.id, host: TENANT_A.host },
        tenantDb: tenantADb,
        rateLimitSalt: salt,
        nowMs,
      },
    );
    expect(piiEventRes.status).toBe(422);

    // Valid cookieless event returns 204 and sets zero cookies
    const validEventRes = await handlePublicEventPost(
      new Request(`https://${TENANT_A.host}/api/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${TENANT_A.host}`,
          "CF-Connecting-IP": "198.51.100.42",
        },
        body: JSON.stringify({
          eventType: "wa_click",
          path: "/",
          eventId: "00000000-0000-4000-8000-000000000163",
        }),
      }),
      {
        surface: "tenant",
        tenant: { id: TENANT_A.id, host: TENANT_A.host },
        tenantDb: tenantADb,
        rateLimitSalt: salt,
        nowMs,
      },
    );
    expect(validEventRes.status).toBe(204);
    expect(validEventRes.headers.get("Set-Cookie")).toBeNull();
  });

  it("4. Enforces tenant-scoped SEO discovery (robots.txt & sitemap.xml) with zero cross-tenant bleed", async () => {
    const robotsA = await handleRobotsTxtRequest(new Request(`https://${TENANT_A.host}/robots.txt`), {
      platformDb: env.PLATFORM_DB,
      tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      bypassHostCache: true,
    });
    expect(robotsA.status).toBe(200);
    const robotsAText = await robotsA.text();
    expect(robotsAText).toContain(`Sitemap: https://${TENANT_A.host}/sitemap.xml`);
    expect(robotsAText).toContain("GPTBot");
    expect(robotsAText).not.toContain(TENANT_B.host);

    const sitemapA = await handleSitemapIndexRequest(
      new Request(`https://${TENANT_A.host}/sitemap.xml`),
      {
        platformDb: env.PLATFORM_DB,
        tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
        bypassHostCache: true,
      },
    );
    expect(sitemapA.status).toBe(200);
    const sitemapAXml = await sitemapA.text();
    expect(sitemapAXml).toContain(`https://${TENANT_A.host}/sitemaps/pages.xml`);
    expect(sitemapAXml).not.toContain(TENANT_B.host);

    // Tenant B is trial -> Disallow: / and X-Robots-Tag: noindex, nofollow
    const robotsB = await handleRobotsTxtRequest(new Request(`https://${TENANT_B.host}/robots.txt`), {
      platformDb: env.PLATFORM_DB,
      tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      bypassHostCache: true,
    });
    expect(robotsB.status).toBe(200);
    expect(robotsB.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const robotsBText = await robotsB.text();
    expect(robotsBText).toContain("Disallow: /");
    expect(robotsBText).not.toContain("Sitemap:");
  });

  it("5. Enforces custom theme entitlement boundaries and per-tenant plugin runtime isolation", async () => {
    // Tenant A holds explicit custom theme grant -> resolves custom theme
    const themeA = resolveTenantTheme({
      requestedThemeId: SAMPLE_AGENCY_THEME_ID,
      tenantId: TENANT_A.id,
      agencyId: null,
      tenantGrants: [
        {
          tenantId: TENANT_A.id,
          themeId: SAMPLE_AGENCY_THEME_ID,
          active: true,
        },
      ],
      agencyGrants: [],
    });
    expect(themeA.resolvedTheme.id).toBe(SAMPLE_AGENCY_THEME_ID);
    expect(themeA.grantSource).toBe("tenant_grant");

    // Tenant B lacks custom theme grant -> safely falls back to platform `compro`
    const themeB = resolveTenantTheme({
      requestedThemeId: SAMPLE_AGENCY_THEME_ID,
      tenantId: TENANT_B.id,
      agencyId: null,
      tenantGrants: [
        {
          tenantId: TENANT_A.id,
          themeId: SAMPLE_AGENCY_THEME_ID,
          active: true,
        },
      ],
      agencyGrants: [],
    });
    expect(themeB.resolvedTheme.id).toBe("compro");
    expect(themeB.grantSource).toBe("fallback");

    // Plugin runtime isolation: seo-ai-autopilot entitled & installed on Tenant A, NOT active on Tenant B
    const pluginDeps = {
      platformDb: env.PLATFORM_DB,
      tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      getBookmark: async () => "pitr-bm-test-t063-001",
    };
    const tenantASnapshot = {
      id: TENANT_A.id,
      handle: TENANT_A.handle,
      name: TENANT_A.name,
      status: "active" as const,
      primaryOrigin: `https://${TENANT_A.host}`,
    };
    const tenantBSnapshot = {
      id: TENANT_B.id,
      handle: TENANT_B.handle,
      name: TENANT_B.name,
      status: "trial" as const,
      primaryOrigin: `https://${TENANT_B.host}`,
    };

    const installA = await installOrEnablePluginForTenant(pluginDeps, {
      tenant: tenantASnapshot,
      pluginId: SEO_AI_AUTOPILOT_PLUGIN_ID,
      actorUserId: TENANT_A.userId,
      actorRole: "owner",
    });
    expect(installA.plugin.installed).toBe(true);
    expect(installA.plugin.enabled).toBe(true);

    const activeOnA = await resolveActivePluginForTenant(
      pluginDeps,
      tenantASnapshot,
      SEO_AI_AUTOPILOT_PLUGIN_ID,
    );
    const activeOnB = await resolveActivePluginForTenant(
      pluginDeps,
      tenantBSnapshot,
      SEO_AI_AUTOPILOT_PLUGIN_ID,
    );
    expect(activeOnA.active).toBe(true);
    expect(activeOnB.active).toBe(false);
  });
});

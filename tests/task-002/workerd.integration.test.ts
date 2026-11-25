import { env } from "cloudflare:workers";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
  type TenantStatus,
} from "@punyasitus/db/platform";
import {
  clearHostResolutionCache,
  evictHostFromCache,
  getHostResolutionCacheSize,
  MOVED_HOST_QUARANTINE_MS,
  quarantineMovedHost,
  resolveTenantByHost,
} from "@punyasitus/db/routing/index";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildTenantEdgeCacheKey,
  evaluateRequestGate,
  executeTenantMiddleware,
  routeEdgeRequest,
  STATE_PAGE_MESSAGES,
  type TenantGateEnv,
  type TenantMiddlewareLocals,
} from "../../apps/web/src/core/tenant.ts";

function buildEnv(overrides: Partial<TenantGateEnv> = {}): TenantGateEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    ...overrides,
  };
}

interface SeedTenantOptions {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly operatorHold?: boolean;
  readonly trialEndsAt?: Date | null;
  readonly paidThrough?: Date | null;
  readonly cacheVersion?: number;
  readonly hosts: readonly {
    readonly host: string;
    readonly kind: "subdomain" | "custom";
    readonly status: "pending" | "active" | "failed" | "moved" | "deleting";
    readonly sslStatus?: string;
    readonly isPrimary: boolean;
    readonly quarantinedUntil?: Date | null;
  }[];
}

async function seedTenant(opts: SeedTenantOptions): Promise<void> {
  const now = new Date();
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  await db
    .insert(organizations)
    .values({
      id: opts.orgId,
      name: opts.name,
      slug: opts.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(tenants)
    .values({
      id: opts.id,
      organizationId: opts.orgId,
      handle: opts.handle,
      name: opts.name,
      status: opts.status,
      operatorHold: opts.operatorHold ?? false,
      trialEndsAt: opts.trialEndsAt ?? null,
      paidThrough: opts.paidThrough ?? null,
      cacheVersion: opts.cacheVersion ?? 1,
      schemaVersion: 1,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  for (const h of opts.hosts) {
    await db
      .insert(tenantHosts)
      .values({
        host: h.host,
        tenantId: opts.id,
        kind: h.kind,
        status: h.status,
        sslStatus: h.sslStatus ?? "active",
        isPrimary: h.isPrimary,
        quarantinedUntil: h.quarantinedUntil ?? null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}

function getDefaultCache(): Cache {
  return (caches as unknown as { readonly default: Cache }).default;
}

describe("TASK-002 Host-Based Tenant Resolution & Request Gate on workerd", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);

    // 1. Active tenant with subdomain primary + pending/failed custom hosts
    await seedTenant({
      id: "01JT002ACTIVE0000000000001",
      orgId: "org_t002_active",
      handle: "t002-alpha",
      name: "Alpha Active Fixture",
      status: "active",
      hosts: [
        {
          host: "t002-alpha.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
        {
          host: "pending.t002-alpha.id",
          kind: "custom",
          status: "pending",
          sslStatus: "pending",
          isPrimary: false,
        },
        {
          host: "unverified-ssl.t002-alpha.id",
          kind: "custom",
          status: "active",
          sslStatus: "pending",
          isPrimary: false,
        },
        {
          host: "failed.t002-alpha.id",
          kind: "custom",
          status: "failed",
          sslStatus: "failed",
          isPrimary: false,
        },
      ],
    });

    // 2. Active tenant with active custom primary + subdomain alias + custom alias
    await seedTenant({
      id: "01JT002PRIMARY000000000002",
      orgId: "org_t002_primary",
      handle: "t002-custom",
      name: "Custom Primary Fixture",
      status: "active",
      hosts: [
        {
          host: "www.t002-custom.id",
          kind: "custom",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
        {
          host: "t002-custom.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: false,
        },
        {
          host: "t002-custom.id",
          kind: "custom",
          status: "active",
          sslStatus: "active",
          isPrimary: false,
        },
      ],
    });

    // 3. Trial tenant
    await seedTenant({
      id: "01JT002TRIAL00000000000003",
      orgId: "org_t002_trial",
      handle: "t002-trial",
      name: "Trial Tenant Fixture",
      status: "trial",
      trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      hosts: [
        {
          host: "t002-trial.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
      ],
    });

    // 4. Grace tenant
    await seedTenant({
      id: "01JT002GRACE00000000000004",
      orgId: "org_t002_grace",
      handle: "t002-grace",
      name: "Grace Tenant Fixture",
      status: "grace",
      hosts: [
        {
          host: "t002-grace.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
      ],
    });

    // 5. Locked tenant (still live and indexable per PLAN §17.1)
    await seedTenant({
      id: "01JT002LOCKED0000000000005",
      orgId: "org_t002_locked",
      handle: "t002-locked",
      name: "Locked Tenant Fixture",
      status: "locked",
      hosts: [
        {
          host: "t002-locked.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
      ],
    });

    // 6. Suspended tenant (unpaid) + Operator-hold tenant
    await seedTenant({
      id: "01JT002SUSPEND000000000006",
      orgId: "org_t002_suspended",
      handle: "t002-suspended",
      name: "Suspended Tenant Fixture",
      status: "suspended",
      hosts: [
        {
          host: "t002-suspended.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
      ],
    });

    await seedTenant({
      id: "01JT002HOLD000000000000007",
      orgId: "org_t002_hold",
      handle: "t002-hold",
      name: "Operator Hold Tenant Fixture",
      status: "active",
      operatorHold: true,
      hosts: [
        {
          host: "t002-hold.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
      ],
    });

    // 7. Recovery tenant (failed DO schema migration)
    await seedTenant({
      id: "01JT002RECOVER000000000008",
      orgId: "org_t002_recovery",
      handle: "t002-recovery",
      name: "Recovery Tenant Fixture",
      status: "recovery",
      hosts: [
        {
          host: "t002-recovery.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
      ],
    });

    // 8. Provisioning, purging, purged tenants
    for (const [idx, status] of (["provisioning", "purging", "purged"] as const).entries()) {
      await seedTenant({
        id: `01JT002TERM0000000000000${idx + 1}`,
        orgId: `org_t002_${status}`,
        handle: `t002-${status}`,
        name: `${status} Fixture`,
        status,
        hosts: [
          {
            host: `t002-${status}.situsku.click`,
            kind: "subdomain",
            status: "active",
            sslStatus: "active",
            isPrimary: true,
          },
        ],
      });
    }

    // 9. Tenant specifically for moved-host quarantine mutation test
    await seedTenant({
      id: "01JT002MOVE000000000000012",
      orgId: "org_t002_move",
      handle: "t002-move",
      name: "Move Quarantine Fixture",
      status: "active",
      hosts: [
        {
          host: "t002-move.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: false,
        },
        {
          host: "move-me.example.id",
          kind: "custom",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
      ],
    });
  });

  beforeEach(() => {
    clearHostResolutionCache();
  });

  it("Step 0: passes HTTP DCV paths untouched and NEVER passes cf-custom-hostname-challenge", async () => {
    const testEnv = buildEnv();

    for (const path of [
      "/.well-known/pki-validation/abc123.txt",
      "/.well-known/acme-challenge/token-xyz",
    ]) {
      const res = await routeEdgeRequest(
        new Request(`https://pending.t002-alpha.id${path}`),
        testEnv,
        {
          dcvPassThrough: () =>
            new Response("dcv-ok", { status: 200, headers: { "X-DCV-Pass-Through": "1" } }),
          render: () => new Response("should-not-render", { status: 500 }),
        },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("X-DCV-Pass-Through")).toBe("1");
      expect(await res.text()).toBe("dcv-ok");
    }

    // cf-custom-hostname-challenge is deliberately NOT passed through
    const cfChallenge = await routeEdgeRequest(
      new Request("https://pending.t002-alpha.id/.well-known/cf-custom-hostname-challenge/tok-1"),
      testEnv,
      {
        dcvPassThrough: () => new Response("wrong-passthrough", { status: 200 }),
        render: () => new Response("wrong-render", { status: 200 }),
      },
    );
    expect(cfChallenge.status).toBe(404);
    expect(await cfChallenge.text()).toContain(STATE_PAGE_MESSAGES.notFound);

    // Path traversal under .well-known is rejected (not passed through)
    const traversal = await evaluateRequestGate(
      new Request("https://unknown.invalid/.well-known/pki-validation/..%2fsecret"),
      testEnv,
    );
    expect(traversal.action).not.toBe("dcv_passthrough");
  });

  it("Steps 3 & 4: isolates all 4 platform surfaces, redirects www (308), situsku.click (301), and marketing paths on app/console (301)", async () => {
    const testEnv = buildEnv();
    const okRender = () => new Response("ok", { status: 200 });

    // www.punyasitus.com -> 308 apex preserving path & query
    const wwwApex = await routeEdgeRequest(
      new Request("https://www.punyasitus.com/harga?utm_source=ig&plan=yearly"),
      testEnv,
      { render: okRender },
    );
    expect(wwwApex.status).toBe(308);
    expect(wwwApex.headers.get("Location")).toBe(
      "https://punyasitus.com/harga?utm_source=ig&plan=yearly",
    );

    // situsku.click & www.situsku.click -> 301 punyasitus.com
    for (const saasApex of ["https://situsku.click/", "https://www.situsku.click/toko"]) {
      const res = await routeEdgeRequest(new Request(saasApex), testEnv, { render: okRender });
      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe("https://punyasitus.com/");
    }

    // Reserved SaaS handles -> neutral 404
    for (const reserved of ["fallback.situsku.click", "cname.situsku.click", "admin.situsku.click"]) {
      const res = await routeEdgeRequest(new Request(`https://${reserved}/`), testEnv, {
        render: okRender,
      });
      expect(res.status).toBe(404);
    }

    // punyasitus.com allows marketing, blocks app/console routes
    const mktOk = await routeEdgeRequest(new Request("https://punyasitus.com/harga"), testEnv, {
      render: okRender,
    });
    expect(mktOk.status).toBe(200);
    expect(mktOk.headers.get("X-PunyaSitus-Surface")).toBe("marketing");
    expect(mktOk.headers.get("X-Robots-Tag")).toBeNull();

    for (const blockedPath of ["/dashboard/t002-alpha", "/console", "/auth/login", "/mcp", "/api/console/tenants"]) {
      const res = await routeEdgeRequest(
        new Request(`https://punyasitus.com${blockedPath}`),
        testEnv,
        { render: okRender },
      );
      expect(res.status).toBe(404);
      if (blockedPath.startsWith("/api/")) {
        expect(await res.json()).toEqual({ success: false, code: "NOT_FOUND" });
      }
    }

    // app.punyasitus.com allows app/dashboard/agency/affiliate/auth/account/mcp/oauth2/api, sets noindex, blocks console, 301s marketing
    for (const allowedAppPath of [
      "/",
      "/dashboard/t002-alpha",
      "/agency",
      "/affiliate",
      "/auth/login",
      "/account",
      "/mcp",
      "/oauth2/token",
      "/.well-known/oauth-authorization-server",
      "/api/tenants",
    ]) {
      const res = await routeEdgeRequest(
        new Request(`https://app.punyasitus.com${allowedAppPath}`),
        testEnv,
        { render: okRender },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("X-PunyaSitus-Surface")).toBe("app");
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }

    const appBlockedConsole = await routeEdgeRequest(
      new Request("https://app.punyasitus.com/console/tenants"),
      testEnv,
      { render: okRender },
    );
    expect(appBlockedConsole.status).toBe(404);

    const appBlockedConsoleApi = await routeEdgeRequest(
      new Request("https://app.punyasitus.com/api/console/tenants"),
      testEnv,
      { render: okRender },
    );
    expect(appBlockedConsoleApi.status).toBe(404);
    expect(await appBlockedConsoleApi.json()).toEqual({ success: false, code: "NOT_FOUND" });

    const appMarketingRedirect = await routeEdgeRequest(
      new Request("https://app.punyasitus.com/harga?coupon=HEMAT"),
      testEnv,
      { render: okRender },
    );
    expect(appMarketingRedirect.status).toBe(301);
    expect(appMarketingRedirect.headers.get("Location")).toBe(
      "https://punyasitus.com/harga?coupon=HEMAT",
    );
    expect(appMarketingRedirect.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    // console.punyasitus.com serves ONLY console/api/console (plus root/health), sets noindex, blocks app routes, 301s marketing
    for (const allowedConsolePath of ["/", "/console", "/console/tenants", "/api/console/audit"]) {
      const res = await routeEdgeRequest(
        new Request(`https://console.punyasitus.com${allowedConsolePath}`),
        testEnv,
        { render: okRender },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("X-PunyaSitus-Surface")).toBe("console");
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }

    for (const blockedOnConsole of ["/dashboard/t002-alpha", "/agency", "/affiliate", "/auth/login", "/account", "/mcp", "/api/leads"]) {
      const res = await routeEdgeRequest(
        new Request(`https://console.punyasitus.com${blockedOnConsole}`),
        testEnv,
        { render: okRender },
      );
      expect(res.status).toBe(404);
    }

    const consoleMarketingRedirect = await routeEdgeRequest(
      new Request("https://console.punyasitus.com/demo/resto?ref=console"),
      testEnv,
      { render: okRender },
    );
    expect(consoleMarketingRedirect.status).toBe(301);
    expect(consoleMarketingRedirect.headers.get("Location")).toBe(
      "https://punyasitus.com/demo/resto?ref=console",
    );

    // Local loopback allowed ONLY when APP_ENV === "local"
    const devFixturesLocal = await routeEdgeRequest(
      new Request("http://127.0.0.1:4321/_dev/design-fixtures"),
      buildEnv({ APP_ENV: "local" }),
      { render: okRender },
    );
    expect(devFixturesLocal.status).toBe(200);

    const devFixturesTest = await routeEdgeRequest(
      new Request("http://127.0.0.1:4321/_dev/design-fixtures"),
      buildEnv({ APP_ENV: "test" }),
      { render: okRender },
    );
    expect(devFixturesTest.status).toBe(404);
  });

  it("Step 5: blocks all platform-only prefixes on tenant hosts with neutral 404", async () => {
    const testEnv = buildEnv();
    const blockedPrefixes = [
      "/dashboard",
      "/dashboard/t002-alpha",
      "/agency",
      "/affiliate",
      "/console",
      "/auth/login",
      "/account",
      "/mcp",
      "/oauth2/token",
      "/api/console/tenants",
      "/api/auth/session",
    ];

    for (const pathname of blockedPrefixes) {
      const res = await routeEdgeRequest(
        new Request(`https://t002-alpha.situsku.click${pathname}`),
        testEnv,
        { render: () => new Response("must-not-serve", { status: 200 }) },
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(res.headers.get("Content-Security-Policy")).toBe(
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      if (pathname.startsWith("/api/")) {
        expect(await res.json()).toEqual({ success: false, code: "NOT_FOUND" });
      } else {
        expect(await res.text()).toContain(STATE_PAGE_MESSAGES.notFound);
      }
    }
  });

  it("Step 6: resolves from PLATFORM_DB with <=5s active-only cache and 60s moved-host quarantine", async () => {
    const t0 = 1_800_000_000_000;

    // 1. Active host resolves from DB, caches for <= 5s (clamping excessive TTL)
    const first = await resolveTenantByHost(env.PLATFORM_DB, "t002-alpha.situsku.click", {
      nowMs: t0,
      cacheTtlMs: 30_000, // must clamp to 5_000ms
    });
    expect(first.kind).toBe("resolved");
    if (first.kind === "resolved") {
      expect(first.fromCache).toBe(false);
      expect(first.tenant.id).toBe("01JT002ACTIVE0000000000001");
    }
    expect(getHostResolutionCacheSize()).toBe(1);

    const hitWithin5s = await resolveTenantByHost(env.PLATFORM_DB, "t002-alpha.situsku.click", {
      nowMs: t0 + 4_999,
    });
    expect(hitWithin5s.kind).toBe("resolved");
    if (hitWithin5s.kind === "resolved") {
      expect(hitWithin5s.fromCache).toBe(true);
    }

    const missAfter5s = await resolveTenantByHost(env.PLATFORM_DB, "t002-alpha.situsku.click", {
      nowMs: t0 + 5_001,
    });
    expect(missAfter5s.kind).toBe("resolved");
    if (missAfter5s.kind === "resolved") {
      expect(missAfter5s.fromCache).toBe(false);
    }

    // Eviction helper clears immediately
    expect(evictHostFromCache("t002-alpha.situsku.click")).toBe(true);
    expect(getHostResolutionCacheSize()).toBe(0);

    // 2. Non-active & non-serving hosts are NEVER cached
    const uncacheableHosts = [
      "does-not-exist.invalid",
      "pending.t002-alpha.id",
      "unverified-ssl.t002-alpha.id",
      "failed.t002-alpha.id",
      "t002-suspended.situsku.click",
      "t002-hold.situsku.click",
      "t002-recovery.situsku.click",
      "t002-provisioning.situsku.click",
      "t002-purging.situsku.click",
      "t002-purged.situsku.click",
    ];

    for (const host of uncacheableHosts) {
      await resolveTenantByHost(env.PLATFORM_DB, host, { nowMs: t0 });
    }
    expect(getHostResolutionCacheSize()).toBe(0);

    // 3. 60s moved-host quarantine: warms cache, quarantines, immediately evicts, bumps cache_version, blocks for 60s
    const moveHost = "move-me.example.id";
    const moveTenantId = "01JT002MOVE000000000000012";
    const beforeMove = await resolveTenantByHost(env.PLATFORM_DB, moveHost, { nowMs: t0 });
    expect(beforeMove.kind).toBe("resolved");
    expect(getHostResolutionCacheSize()).toBe(1);
    const oldCacheVersion = beforeMove.kind === "resolved" ? beforeMove.tenant.cacheVersion : 0;

    const qRes = await quarantineMovedHost(env.PLATFORM_DB, {
      host: moveHost,
      tenantId: moveTenantId,
      nowMs: t0 + 1_000,
    });
    expect(qRes.updated).toBe(true);
    expect(qRes.quarantinedUntil).toBe(t0 + 1_000 + MOVED_HOST_QUARANTINE_MS);
    expect(getHostResolutionCacheSize()).toBe(0);

    // Immediate lookup (inside old 5s window!) returns quarantined, NOT stale cache
    const duringQuarantine = await resolveTenantByHost(env.PLATFORM_DB, moveHost, {
      nowMs: t0 + 1_500,
    });
    expect(duringQuarantine.kind).toBe("quarantined");
    expect(getHostResolutionCacheSize()).toBe(0);

    // Verify tenants.cache_version was bumped atomically
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const [updatedTenant] = await db
      .select({ cacheVersion: tenants.cacheVersion })
      .from(tenants)
      .where(eq(tenants.id, moveTenantId))
      .limit(1);
    expect(updatedTenant?.cacheVersion).toBe(oldCacheVersion + 1);

    // Even if status is prematurely set back to 'active', quarantine still blocks until 60s elapses
    await env.PLATFORM_DB.prepare("UPDATE tenant_hosts SET status = 'active' WHERE host = ?")
      .bind(moveHost)
      .run();
    const stillQuarantined = await resolveTenantByHost(env.PLATFORM_DB, moveHost, {
      nowMs: t0 + 1_000 + 59_999,
    });
    expect(stillQuarantined.kind).toBe("quarantined");

    const afterQuarantine = await resolveTenantByHost(env.PLATFORM_DB, moveHost, {
      nowMs: t0 + 1_000 + 60_000,
    });
    expect(afterQuarantine.kind).toBe("resolved");
  });

  it("returns byte-for-byte identical neutral 404 body across unknown, unverified, failed, quarantined, provisioning, purging, and purged hosts", async () => {
    const testEnv = buildEnv();
    const hosts = [
      "totally-unknown.invalid",
      "some-worker.workers.dev",
      "pending.t002-alpha.id",
      "unverified-ssl.t002-alpha.id",
      "failed.t002-alpha.id",
      "t002-provisioning.situsku.click",
      "t002-purging.situsku.click",
      "t002-purged.situsku.click",
    ];

    const htmlBodies = new Set<string>();
    const apiBodies = new Set<string>();

    for (const host of hosts) {
      const htmlRes = await routeEdgeRequest(new Request(`https://${host}/`), testEnv, {
        render: () => new Response("must-not-render", { status: 200 }),
      });
      expect(htmlRes.status).toBe(404);
      expect(htmlRes.headers.get("Cache-Control")).toBe("no-store");
      expect(htmlRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(htmlRes.headers.get("Content-Security-Policy")).toBe(
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      expect(htmlRes.headers.get("X-PunyaSitus-Surface")).toBe("unknown");
      const html = await htmlRes.text();
      expect(html).toContain(STATE_PAGE_MESSAGES.notFound);
      htmlBodies.add(html);

      const apiRes = await routeEdgeRequest(new Request(`https://${host}/api/leads`), testEnv, {
        render: () => new Response("must-not-render", { status: 200 }),
      });
      expect(apiRes.status).toBe(404);
      expect(apiRes.headers.get("Content-Type")).toContain("application/json");
      const apiText = await apiRes.text();
      expect(JSON.parse(apiText)).toEqual({ success: false, code: "NOT_FOUND" });
      apiBodies.add(apiText);
    }

    expect(htmlBodies.size).toBe(1);
    expect(apiBodies.size).toBe(1);
  });

  it("Step 8: enforces trial noindex, locked 200 live, and returns 503 for suspended/recovery EVEN WITH warm caches.default synthetic key", async () => {
    const testEnv = buildEnv();
    const cache = getDefaultCache();

    // Trial -> 200 + X-Robots-Tag: noindex, nofollow
    const trialRes = await routeEdgeRequest(
      new Request("https://t002-trial.situsku.click/"),
      testEnv,
      { cache, render: () => new Response("<h1>Trial Site</h1>", { status: 200 }) },
    );
    expect(trialRes.status).toBe(200);
    expect(trialRes.headers.get("X-PunyaSitus-Surface")).toBe("tenant");
    expect(trialRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    // Grace & Locked -> 200 live & indexable (no noindex)
    for (const host of ["t002-grace.situsku.click", "t002-locked.situsku.click"]) {
      const res = await routeEdgeRequest(new Request(`https://${host}/`), testEnv, {
        cache,
        render: () => new Response("<h1>Live Site</h1>", { status: 200 }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-PunyaSitus-Surface")).toBe("tenant");
      expect(res.headers.get("X-Robots-Tag")).toBeNull();
    }

    // Active tenant edge cache HIT/MISS works after Step 6/8
    let renderCalls = 0;
    const activeUrl = "https://t002-alpha.situsku.click/cache-probe";
    const firstActive = await routeEdgeRequest(new Request(activeUrl), testEnv, {
      cache,
      render: () => {
        renderCalls += 1;
        return new Response("<h1>Fresh Render</h1>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    });
    expect(firstActive.status).toBe(200);
    expect(firstActive.headers.get("X-PunyaSitus-Cache")).toBe("MISS");
    expect(renderCalls).toBe(1);

    const secondActive = await routeEdgeRequest(new Request(activeUrl), testEnv, {
      cache,
      render: () => {
        renderCalls += 1;
        return new Response("<h1>Should Not Run</h1>", { status: 200 });
      },
    });
    expect(secondActive.status).toBe(200);
    expect(secondActive.headers.get("X-PunyaSitus-Cache")).toBe("HIT");
    expect(await secondActive.text()).toBe("<h1>Fresh Render</h1>");
    expect(renderCalls).toBe(1);

    // Pre-warm caches.default synthetic keys for suspended, operator-hold, and recovery tenants!
    const warmEntries = [
      {
        tenantId: "01JT002SUSPEND000000000006",
        host: "t002-suspended.situsku.click",
        expectedMessage: STATE_PAGE_MESSAGES.suspended,
        expectedCode: "SITE_SUSPENDED",
      },
      {
        tenantId: "01JT002HOLD000000000000007",
        host: "t002-hold.situsku.click",
        expectedMessage: STATE_PAGE_MESSAGES.suspended,
        expectedCode: "SITE_SUSPENDED",
      },
      {
        tenantId: "01JT002RECOVER000000000008",
        host: "t002-recovery.situsku.click",
        expectedMessage: STATE_PAGE_MESSAGES.recovery,
        expectedCode: "SITE_RECOVERY",
      },
    ] as const;

    for (const entry of warmEntries) {
      const syntheticKey = buildTenantEdgeCacheKey(entry.tenantId, 1, entry.host, "/");
      await cache.put(
        new Request(syntheticKey, { method: "GET" }),
        new Response("<h1>STALE WARM CACHED HTML</h1>", {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=60",
          },
        }),
      );

      // Verify warm cache entry really exists in caches.default
      const warmed = await cache.match(new Request(syntheticKey, { method: "GET" }));
      expect(warmed?.status).toBe(200);

      // Gate MUST still return 503 + no-store and NEVER serve the warm cached HTML
      const htmlRes = await routeEdgeRequest(new Request(`https://${entry.host}/`), testEnv, {
        cache,
        render: () => new Response("must-not-render", { status: 200 }),
      });
      expect(htmlRes.status).toBe(503);
      expect(htmlRes.headers.get("Cache-Control")).toBe("no-store");
      expect(htmlRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(htmlRes.headers.get("Content-Security-Policy")).toBe(
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      expect(htmlRes.headers.get("Retry-After")).toBe("60");
      const body = await htmlRes.text();
      expect(body).toContain(entry.expectedMessage);
      expect(body).not.toContain("STALE WARM CACHED HTML");

      // API path returns JSON 503
      const apiRes = await routeEdgeRequest(
        new Request(`https://${entry.host}/api/events`),
        testEnv,
        { cache, render: () => new Response("must-not-render", { status: 200 }) },
      );
      expect(apiRes.status).toBe(503);
      expect(apiRes.headers.get("Retry-After")).toBe("60");
      expect(await apiRes.json()).toEqual({ success: false, code: entry.expectedCode });
    }
  });

  it("Step 7: redirects alias/subdomain GET & HEAD with 301 to active custom primary, preserving path+query, skipping /api/*, /.well-known/*, and POST", async () => {
    const testEnv = buildEnv();
    const okRender = ({ host }: { readonly host: string }) =>
      new Response(`served:${host}`, { status: 200 });

    // Subdomain alias -> 301 to active custom primary (keeping path + UTM/gclid)
    const subRedirect = await routeEdgeRequest(
      new Request("https://t002-custom.situsku.click/layanan/website?utm_source=meta&fbclid=abc"),
      testEnv,
      { render: okRender },
    );
    expect(subRedirect.status).toBe(301);
    expect(subRedirect.headers.get("Location")).toBe(
      "https://www.t002-custom.id/layanan/website?utm_source=meta&fbclid=abc",
    );

    // Custom alias (apex -> www) with HEAD + O2O header -> 301
    const apexRedirect = await routeEdgeRequest(
      new Request("https://t002-custom.id/produk?page=2", {
        method: "HEAD",
        headers: { "cf-connecting-o2o": "1" },
      }),
      testEnv,
      { render: okRender },
    );
    expect(apexRedirect.status).toBe(301);
    expect(apexRedirect.headers.get("Location")).toBe("https://www.t002-custom.id/produk?page=2");

    // Primary custom domain serves directly (no redirect loop)
    const primaryDirect = await routeEdgeRequest(
      new Request("https://www.t002-custom.id/layanan"),
      testEnv,
      { render: okRender },
    );
    expect(primaryDirect.status).toBe(200);
    expect(await primaryDirect.text()).toBe("served:www.t002-custom.id");

    // NEVER redirect /api/*, /.well-known/*, or POST on alias
    const apiAlias = await routeEdgeRequest(
      new Request("https://t002-custom.situsku.click/api/events"),
      testEnv,
      { render: okRender },
    );
    expect(apiAlias.status).toBe(200);

    const postAlias = await routeEdgeRequest(
      new Request("https://t002-custom.situsku.click/api/leads", { method: "POST" }),
      testEnv,
      { render: okRender },
    );
    expect(postAlias.status).toBe(200);

    const wellKnownAlias = await routeEdgeRequest(
      new Request("https://t002-custom.situsku.click/.well-known/security.txt"),
      testEnv,
      { render: okRender },
    );
    expect(wellKnownAlias.status).toBe(200);
  });

  it("Step 2: ignores spoofed X-Forwarded-Host and X-Tenant-ID headers completely", async () => {
    const testEnv = buildEnv();

    // 1. Valid tenant host with spoofed headers targeting another tenant
    const tenantRes = await routeEdgeRequest(
      new Request("https://t002-alpha.situsku.click/", {
        headers: {
          "X-Forwarded-Host": "t002-trial.situsku.click",
          "X-Tenant-ID": "01JT002TRIAL00000000000003",
        },
      }),
      testEnv,
      {
        render: ({ tenant }) =>
          Response.json({ tenantId: tenant?.id, handle: tenant?.handle }),
      },
    );
    expect(tenantRes.status).toBe(200);
    expect(await tenantRes.json()).toEqual({
      tenantId: "01JT002ACTIVE0000000000001",
      handle: "t002-alpha",
    });

    // 2. Unknown host with spoofed headers pointing at active tenant -> still 404
    const unknownSpoof = await routeEdgeRequest(
      new Request("https://evil.invalid/", {
        headers: {
          "X-Forwarded-Host": "t002-alpha.situsku.click",
          "X-Tenant-ID": "01JT002ACTIVE0000000000001",
        },
      }),
      testEnv,
      { render: () => new Response("must-not-serve", { status: 200 }) },
    );
    expect(unknownSpoof.status).toBe(404);

    // 3. Marketing host with spoofed X-Forwarded-Host=app.punyasitus.com trying /dashboard -> still 404
    const platformSpoof = await routeEdgeRequest(
      new Request("https://punyasitus.com/dashboard/t002-alpha", {
        headers: {
          "X-Forwarded-Host": "app.punyasitus.com",
        },
      }),
      testEnv,
      { render: () => new Response("must-not-serve", { status: 200 }) },
    );
    expect(platformSpoof.status).toBe(404);
  });

  it("returns 503 with Retry-After: 60 on PLATFORM_DB or TENANT_STORE outage", async () => {
    const failingDb = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                throw new Error("D1_OUTAGE_SIMULATED");
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const dbOutageHtml = await routeEdgeRequest(
      new Request("https://t002-alpha.situsku.click/"),
      buildEnv({ PLATFORM_DB: failingDb }),
      { render: () => new Response("must-not-render", { status: 200 }) },
    );
    expect(dbOutageHtml.status).toBe(503);
    expect(dbOutageHtml.headers.get("Retry-After")).toBe("60");
    expect(dbOutageHtml.headers.get("Cache-Control")).toBe("no-store");
    expect(dbOutageHtml.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(dbOutageHtml.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(await dbOutageHtml.text()).toContain(STATE_PAGE_MESSAGES.unavailable);

    const dbOutageApi = await routeEdgeRequest(
      new Request("https://t002-alpha.situsku.click/api/leads"),
      buildEnv({ PLATFORM_DB: failingDb }),
      { render: () => new Response("must-not-render", { status: 200 }) },
    );
    expect(dbOutageApi.status).toBe(503);
    expect(await dbOutageApi.json()).toEqual({ success: false, code: "SERVICE_UNAVAILABLE" });

    // TENANT_STORE binding unavailable -> 503
    const doOutage = await routeEdgeRequest(
      new Request("https://t002-alpha.situsku.click/"),
      buildEnv({ TENANT_STORE: null }),
      { render: () => new Response("must-not-render", { status: 200 }) },
    );
    expect(doOutage.status).toBe(503);
    expect(await doOutage.text()).toContain(STATE_PAGE_MESSAGES.unavailable);
  });

  it("middleware binds locals.{surface, tenant, tenantDb} to TenantStore DO and strips Domain= cookies on tenant hosts", async () => {
    const locals: TenantMiddlewareLocals = {
      surface: "unknown",
      host: "",
      isLocalLoopback: false,
      tenant: null,
      tenantDb: null,
    };

    const res = await executeTenantMiddleware(
      {
        request: new Request("https://t002-alpha.situsku.click/middleware-check?nocache=1"),
        locals,
      },
      async () => {
        expect(locals.surface).toBe("tenant");
        expect(locals.tenant?.id).toBe("01JT002ACTIVE0000000000001");
        expect(locals.tenantDb).not.toBeNull();

        // Execute a real SQLite query against the bound TenantStore DO
        const probe = await locals.tenantDb!.prepare("SELECT 1 AS ok").first<{ ok: number }>();
        expect(probe).toEqual({ ok: 1 });

        const headers = new Headers({ "Content-Type": "text/plain" });
        headers.append("Set-Cookie", "bad=1; Domain=situsku.click; Path=/");
        headers.append("Set-Cookie", "__Host-ps_consent=none; Path=/; Secure; HttpOnly");
        return new Response("middleware-ok", { status: 200, headers });
      },
      buildEnv(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-PunyaSitus-Surface")).toBe("tenant");
    const setCookies = (
      res.headers as Headers & { getSetCookie: () => string[] }
    ).getSetCookie();
    expect(setCookies).toEqual(["__Host-ps_consent=none; Path=/; Secure; HttpOnly"]);
    expect(await res.text()).toBe("middleware-ok");
  });
});

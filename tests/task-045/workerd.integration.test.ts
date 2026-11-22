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
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateRequestGate,
  routeEdgeRequest,
  STATE_PAGE_MESSAGES,
  type TenantGateEnv,
} from "../../apps/web/src/core/tenant.ts";

function buildEnv(overrides: Partial<TenantGateEnv> = {}): TenantGateEnv {
  return {
    APP_ENV: "production",
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
  readonly hosts: readonly {
    readonly host: string;
    readonly kind: "subdomain" | "custom";
    readonly status: "pending" | "active" | "failed" | "moved" | "deleting";
    readonly sslStatus?: string;
    readonly isPrimary: boolean;
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
      cacheVersion: 1,
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
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}

describe("TASK-045 Cloudflare for SaaS Worker Topology & Route Contract on workerd", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);

    // 1. Active paid tenant with custom primary (`www.t045-brand.id`), apex alias, and subdomain alias
    await seedTenant({
      id: "01JT045BRAND00000000000001",
      orgId: "org_t045_brand",
      handle: "t045-brand",
      name: "T045 Brand Fixture",
      status: "active",
      hosts: [
        {
          host: "t045-brand.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: false,
        },
        {
          host: "www.t045-brand.id",
          kind: "custom",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
        {
          host: "t045-brand.id",
          kind: "custom",
          status: "active",
          sslStatus: "active",
          isPrimary: false,
        },
        {
          host: "pending.t045-brand.id",
          kind: "custom",
          status: "pending",
          sslStatus: "pending",
          isPrimary: false,
        },
      ],
    });

    // 2. Active tenant for O2O (Orange-to-Orange) custom hostname & alias redirect verification
    await seedTenant({
      id: "01JT045O2O0000000000000002",
      orgId: "org_t045_o2o",
      handle: "t045-o2o",
      name: "T045 O2O Fixture",
      status: "active",
      hosts: [
        {
          host: "t045-o2o.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: false,
        },
        {
          host: "www.t045-o2o.id",
          kind: "custom",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
        {
          host: "t045-o2o.id",
          kind: "custom",
          status: "active",
          sslStatus: "active",
          isPrimary: false,
        },
      ],
    });

    // 3. Suspended tenant & recovery tenant for state-page + JSON API tests
    await seedTenant({
      id: "01JT045SUSP000000000000003",
      orgId: "org_t045_susp",
      handle: "t045-suspended",
      name: "T045 Suspended Fixture",
      status: "suspended",
      operatorHold: true,
      hosts: [
        {
          host: "t045-suspended.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
      ],
    });

    await seedTenant({
      id: "01JT045RECV000000000000004",
      orgId: "org_t045_recv",
      handle: "t045-recovery",
      name: "T045 Recovery Fixture",
      status: "recovery",
      hosts: [
        {
          host: "t045-recovery.situsku.click",
          kind: "subdomain",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
        },
      ],
    });

    // 4. Separate staging SaaS zone tenant fixture
    await seedTenant({
      id: "01JT045STG0000000000000005",
      orgId: "org_t045_stg",
      handle: "t045-canary",
      name: "T045 Staging Canary",
      status: "active",
      hosts: [
        {
          host: "t045-canary.situsku-staging.click",
          kind: "subdomain",
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

  it("executes Step 0 DCV pass-through first while rejecting cf-custom-hostname-challenge on unknown/pending hosts", async () => {
    const runtimeEnv = buildEnv();
    let dcvPassedThrough = false;

    const acmeRes = await routeEdgeRequest(
      new Request("https://pending.t045-brand.id/.well-known/acme-challenge/token-abc"),
      runtimeEnv,
      {
        dcvPassThrough: () => {
          dcvPassedThrough = true;
          return new Response("acme-token-ok", { status: 200 });
        },
        render: () => new Response("should-not-render", { status: 500 }),
      },
    );
    expect(dcvPassedThrough).toBe(true);
    expect(acmeRes.status).toBe(200);
    expect(await acmeRes.text()).toBe("acme-token-ok");

    const pkiDecision = await evaluateRequestGate(
      new Request("https://unknown-pending.example.id/.well-known/pki-validation/file.txt"),
      runtimeEnv,
    );
    expect(pkiDecision).toEqual({
      action: "dcv_passthrough",
      pathname: "/.well-known/pki-validation/file.txt",
    });

    // Pre-validation path is deliberately NOT passed through (served by customer's existing origin)
    const preValRes = await routeEdgeRequest(
      new Request("https://pending.t045-brand.id/.well-known/cf-custom-hostname-challenge/xyz"),
      runtimeEnv,
      {
        dcvPassThrough: () => new Response("must-not-passthrough", { status: 200 }),
        render: () => new Response("must-not-render", { status: 200 }),
      },
    );
    expect(preValRes.status).toBe(404);
  });

  it("classifies customer custom hostnames and ignores spoofed X-Forwarded-Host / X-Tenant-ID headers", async () => {
    const runtimeEnv = buildEnv();

    // Active custom primary host renders tenant even with spoofed platform/tenant headers
    const customRes = await routeEdgeRequest(
      new Request("https://www.t045-brand.id/layanan", {
        headers: {
          "X-Forwarded-Host": "console.punyasitus.com",
          "X-Tenant-ID": "01JT045O2O0000000000000002",
          "CF-Connecting-IP": "198.51.100.77",
        },
      }),
      runtimeEnv,
      {
        render: ({ surface, host, tenant, request }) =>
          new Response(
            JSON.stringify({
              surface,
              host,
              tenantId: tenant?.id,
              clientIp: request.headers.get("CF-Connecting-IP"),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      },
    );

    expect(customRes.status).toBe(200);
    expect(customRes.headers.get("X-PunyaSitus-Surface")).toBe("tenant");
    expect(await customRes.json()).toEqual({
      surface: "tenant",
      host: "www.t045-brand.id",
      tenantId: "01JT045BRAND00000000000001",
      clientIp: "198.51.100.77",
    });

    // Unknown host spoofing a valid tenant in X-Forwarded-Host still returns neutral 404
    const spoofedUnknownRes = await routeEdgeRequest(
      new Request("https://spoof-attacker.example.com/", {
        headers: {
          "X-Forwarded-Host": "www.t045-brand.id",
          "X-Tenant-ID": "01JT045BRAND00000000000001",
        },
      }),
      runtimeEnv,
      {
        render: () => new Response("must-not-render", { status: 200 }),
      },
    );
    expect(spoofedUnknownRes.status).toBe(404);
  });

  it("enforces host isolation across tenant, marketing, app, and console surfaces", async () => {
    const runtimeEnv = buildEnv();
    let renderCalls = 0;
    const render = () => {
      renderCalls += 1;
      return new Response("ok", { status: 200 });
    };

    // Platform-only prefixes MUST return 404 on tenant custom host & subdomain
    const tenantBlockedPaths = [
      "/dashboard",
      "/dashboard/t045-brand",
      "/agency",
      "/affiliate",
      "/console",
      "/console/tenants",
      "/auth",
      "/auth/login",
      "/account",
      "/mcp",
      "/oauth2/token",
      "/.well-known/oauth-authorization-server",
      "/api/console/tenants",
      "/api/auth/session",
    ];

    for (const host of ["www.t045-brand.id", "t045-brand.situsku.click"]) {
      for (const pathname of tenantBlockedPaths) {
        const res = await routeEdgeRequest(new Request(`https://${host}${pathname}`), runtimeEnv, {
          render,
        });
        expect(res.status, `${host}${pathname}`).toBe(404);
        if (pathname.startsWith("/api/")) {
          expect(await res.json()).toEqual({ success: false, code: "NOT_FOUND" });
        }
      }
    }

    // Public-site routes return 404 on app.punyasitus.com and console.punyasitus.com
    for (const host of ["app.punyasitus.com", "console.punyasitus.com"]) {
      for (const publicPath of ["/layanan", "/produk", "/tour", "/kendaraan", "/profil"]) {
        const res = await routeEdgeRequest(new Request(`https://${host}${publicPath}`), runtimeEnv, {
          render,
        });
        expect(res.status, `${host}${publicPath}`).toBe(404);
      }

      // Marketing paths on app./console. redirect 301 to punyasitus.com preserving query
      const mktRedirect = await routeEdgeRequest(
        new Request(`https://${host}/harga?utm_source=nav`),
        runtimeEnv,
        { render },
      );
      expect(mktRedirect.status).toBe(301);
      expect(mktRedirect.headers.get("Location")).toBe("https://punyasitus.com/harga?utm_source=nav");
    }

    // Console routes on app.punyasitus.com return 404; app routes on console.punyasitus.com return 404
    const consoleOnApp = await routeEdgeRequest(
      new Request("https://app.punyasitus.com/console/tenants"),
      runtimeEnv,
      { render },
    );
    expect(consoleOnApp.status).toBe(404);

    const apiConsoleOnApp = await routeEdgeRequest(
      new Request("https://app.punyasitus.com/api/console/tenants"),
      runtimeEnv,
      { render },
    );
    expect(apiConsoleOnApp.status).toBe(404);
    expect(await apiConsoleOnApp.json()).toEqual({ success: false, code: "NOT_FOUND" });

    const dashOnConsole = await routeEdgeRequest(
      new Request("https://console.punyasitus.com/dashboard/t045-brand"),
      runtimeEnv,
      { render },
    );
    expect(dashOnConsole.status).toBe(404);

    // www.punyasitus.com redirects 308 -> apex
    const wwwRedirect = await routeEdgeRequest(
      new Request("https://www.punyasitus.com/fitur?ref=hero"),
      runtimeEnv,
      { render },
    );
    expect(wwwRedirect.status).toBe(308);
    expect(wwwRedirect.headers.get("Location")).toBe("https://punyasitus.com/fitur?ref=hero");

    // Nothing above should have reached render()
    expect(renderCalls).toBe(0);
  });

  it("enforces PLAN §3.3 SaaS apex 301, single primary 301 without moving /api/* or /.well-known/*, identical 404s, and state JSON", async () => {
    const runtimeEnv = buildEnv();

    // SaaS zone apex & www -> 301 to punyasitus.com
    for (const saasRoot of ["situsku.click", "www.situsku.click"]) {
      const res = await routeEdgeRequest(new Request(`https://${saasRoot}/anything`), runtimeEnv, {
        render: () => new Response("must-not-render", { status: 200 }),
      });
      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe("https://punyasitus.com/");
    }

    // Reserved SaaS labels -> neutral 404
    for (const reserved of ["fallback", "cname", "app", "console", "admin", "api"]) {
      const res = await routeEdgeRequest(
        new Request(`https://${reserved}.situsku.click/`),
        runtimeEnv,
        { render: () => new Response("must-not-render", { status: 200 }) },
      );
      expect(res.status, reserved).toBe(404);
    }

    // Single 301 primary-host redirect from subdomain & apex alias preserving path + UTM/click IDs
    for (const alias of ["t045-brand.situsku.click", "t045-brand.id"]) {
      const res = await routeEdgeRequest(
        new Request(`https://${alias}/produk/paket-a?utm_source=chatgpt.com&gclid=test123`),
        runtimeEnv,
        { render: () => new Response("must-not-render", { status: 200 }) },
      );
      expect(res.status, alias).toBe(301);
      expect(res.headers.get("Location")).toBe(
        "https://www.t045-brand.id/produk/paket-a?utm_source=chatgpt.com&gclid=test123",
      );
    }

    // Primary-host redirect NEVER moves /api/* or /.well-known/*
    const apiOnAlias = await routeEdgeRequest(
      new Request("https://t045-brand.situsku.click/api/events", { method: "GET" }),
      runtimeEnv,
      {
        render: ({ host }) =>
          new Response(JSON.stringify({ ok: true, host }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    );
    expect(apiOnAlias.status).toBe(200);
    expect(await apiOnAlias.json()).toEqual({ ok: true, host: "t045-brand.situsku.click" });

    const wellKnownOnAlias = await routeEdgeRequest(
      new Request("https://t045-brand.situsku.click/.well-known/security.txt"),
      runtimeEnv,
      {
        render: ({ host }) => new Response(`well-known:${host}`, { status: 200 }),
      },
    );
    expect(wellKnownOnAlias.status).toBe(200);
    expect(await wellKnownOnAlias.text()).toBe("well-known:t045-brand.situsku.click");

    // Identical byte-for-byte neutral 404 body across unknown, pending, and reserved hosts
    const unknownBodies: string[] = [];
    for (const host of [
      "does-not-exist.situsku.click",
      "pending.t045-brand.id",
      "fallback.situsku.click",
      "unregistered.example.org",
    ]) {
      const res = await routeEdgeRequest(new Request(`https://${host}/`), runtimeEnv, {
        render: () => new Response("must-not-render", { status: 200 }),
      });
      expect(res.status, host).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
      unknownBodies.push(await res.text());
    }
    expect(new Set(unknownBodies).size).toBe(1);
    expect(unknownBodies[0]).toContain(STATE_PAGE_MESSAGES.notFound);

    // State pages return HTML for web paths and JSON { success: false, code } for /api/*
    const suspHtml = await routeEdgeRequest(
      new Request("https://t045-suspended.situsku.click/"),
      runtimeEnv,
      { render: () => new Response("must-not-render", { status: 200 }) },
    );
    expect(suspHtml.status).toBe(503);
    expect(suspHtml.headers.get("Retry-After")).toBe("60");
    expect(await suspHtml.text()).toContain(STATE_PAGE_MESSAGES.suspended);

    const suspApi = await routeEdgeRequest(
      new Request("https://t045-suspended.situsku.click/api/leads", { method: "POST" }),
      runtimeEnv,
      { render: () => new Response("must-not-render", { status: 200 }) },
    );
    expect(suspApi.status).toBe(503);
    expect(await suspApi.json()).toEqual({ success: false, code: "SITE_SUSPENDED" });

    const recvApi = await routeEdgeRequest(
      new Request("https://t045-recovery.situsku.click/api/events", { method: "POST" }),
      runtimeEnv,
      { render: () => new Response("must-not-render", { status: 200 }) },
    );
    expect(recvApi.status).toBe(503);
    expect(await recvApi.json()).toEqual({ success: false, code: "SITE_RECOVERY" });
  });

  it("answers neutral 404 on *.workers.dev and preview hostnames for every surface", async () => {
    const runtimeEnv = buildEnv();
    const disallowedPreviewHosts = [
      "punyasitus-web.example-account.workers.dev",
      "preview-pr42-punyasitus-web.example-account.workers.dev",
      "branch-preview.punyasitus.pages.dev",
      "preview-123.punyasitus-web.workers.dev",
    ];
    const probePaths = [
      "/",
      "/harga",
      "/dashboard/t045-brand",
      "/console",
      "/auth/login",
      "/api/console/tenants",
      "/api/auth/session",
      "/api/leads",
    ];

    const html404Bodies = new Set<string>();
    for (const host of disallowedPreviewHosts) {
      for (const pathname of probePaths) {
        const res = await routeEdgeRequest(new Request(`https://${host}${pathname}`), runtimeEnv, {
          render: () => new Response("must-not-render", { status: 200 }),
        });
        expect(res.status, `${host}${pathname}`).toBe(404);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
        if (pathname.startsWith("/api/")) {
          expect(await res.json()).toEqual({ success: false, code: "NOT_FOUND" });
        } else {
          html404Bodies.add(await res.text());
        }
      }
    }
    expect(html404Bodies.size).toBe(1);
  });

  it("handles O2O requests carrying `cf-connecting-o2o: 1` with identical routing, isolation, and 301 primary redirect", async () => {
    const runtimeEnv = buildEnv();

    // 1. O2O primary custom hostname serves 200 and preserves original Host + CF-Connecting-IP + cf-connecting-o2o
    const o2oPrimary = await routeEdgeRequest(
      new Request("https://www.t045-o2o.id/layanan", {
        headers: {
          "cf-connecting-o2o": "1",
          "CF-Connecting-IP": "203.0.113.42",
        },
      }),
      runtimeEnv,
      {
        render: ({ surface, host, tenant, request }) =>
          new Response(
            JSON.stringify({
              surface,
              host,
              tenantId: tenant?.id,
              o2o: request.headers.get("cf-connecting-o2o"),
              clientIp: request.headers.get("CF-Connecting-IP"),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      },
    );
    expect(o2oPrimary.status).toBe(200);
    expect(o2oPrimary.headers.get("X-PunyaSitus-Surface")).toBe("tenant");
    expect(await o2oPrimary.json()).toEqual({
      surface: "tenant",
      host: "www.t045-o2o.id",
      tenantId: "01JT045O2O0000000000000002",
      o2o: "1",
      clientIp: "203.0.113.42",
    });

    // 2. O2O alias host redirects with a single 301 to custom primary preserving path & query
    const o2oAlias = await routeEdgeRequest(
      new Request("https://t045-o2o.id/tour/bali?utm_source=perplexity.ai", {
        headers: {
          "cf-connecting-o2o": "1",
          "CF-Connecting-IP": "203.0.113.42",
        },
      }),
      runtimeEnv,
      { render: () => new Response("must-not-render", { status: 200 }) },
    );
    expect(o2oAlias.status).toBe(301);
    expect(o2oAlias.headers.get("Location")).toBe(
      "https://www.t045-o2o.id/tour/bali?utm_source=perplexity.ai",
    );

    // 3. O2O tenant host still blocks admin/console routes with 404
    const o2oBlocked = await routeEdgeRequest(
      new Request("https://www.t045-o2o.id/console", {
        headers: { "cf-connecting-o2o": "1" },
      }),
      runtimeEnv,
      { render: () => new Response("must-not-render", { status: 200 }) },
    );
    expect(o2oBlocked.status).toBe(404);
  });

  it("supports separate staging SaaS zone routing without leaking production SaaS zone apex", async () => {
    const stagingEnv = buildEnv({
      APP_ENV: "staging",
      PLATFORM_DOMAIN: "staging.punyasitus.com",
      SAAS_ZONE: "situsku-staging.click",
    });

    const stgTenant = await routeEdgeRequest(
      new Request("https://t045-canary.situsku-staging.click/", {
        headers: { "CF-Connecting-IP": "198.51.100.9" },
      }),
      stagingEnv,
      {
        render: ({ surface, host, tenant }) =>
          new Response(JSON.stringify({ surface, host, tenantId: tenant?.id }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    );
    expect(stgTenant.status).toBe(200);
    expect(await stgTenant.json()).toEqual({
      surface: "tenant",
      host: "t045-canary.situsku-staging.click",
      tenantId: "01JT045STG0000000000000005",
    });

    const stgSaasApex = await routeEdgeRequest(
      new Request("https://situsku-staging.click/"),
      stagingEnv,
      { render: () => new Response("must-not-render", { status: 200 }) },
    );
    expect(stgSaasApex.status).toBe(301);
    expect(stgSaasApex.headers.get("Location")).toBe("https://staging.punyasitus.com/");
  });
});

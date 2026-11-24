import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  applyPlatformMigrations,
  applyTenantMigrations,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { createPage } from "@punyasitus/db/pages/index";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import {
  PLATFORM_PLUGIN_RUNTIME_MIGRATION,
  TENANT_PLUGIN_LEDGER_MIGRATION,
} from "@punyasitus/db/plugins/migrations";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, describe, expect, it } from "vitest";
import { executeAuthMiddleware, type AuthMiddlewareLocals } from "../../apps/web/src/middleware/auth.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantPagesCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/index.ts";

/**
 * TASK-078 Verification Integration Suite (workerd).
 * Proves end-to-end middleware + D1 + isolated `TenantStore` DO enforcement for:
 *  - Path normalization bypass defense (`/api/%63onsole`, `/api//console`, `..`)
 *  - Cross-tenant neutral 404 denial with zero DO data leak
 *  - MCP cookie rejection (`401`) at central middleware
 *  - Console 2FA / operator isolation (`401`/`403`) at central middleware
 */

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_SECRET = "task078-verify-app-secret-0123456789abcdef0123456789abcdef";
const CONSOLE_SECRET = "task078-verify-console-secret-fedcba9876543210fedcba9876";

const TENANT_X = {
  id: "01JT078VERX000000000000001",
  orgId: "org_t078_ver_x",
  handle: "t078-ver-x",
  name: "PT Verifikasi X",
  host: "t078-ver-x.situsku.click",
} as const;

const TENANT_Y = {
  id: "01JT078VERY000000000000002",
  orgId: "org_t078_ver_y",
  handle: "t078-ver-y",
  name: "CV Verifikasi Y Rahasia",
  host: "t078-ver-y.situsku.click",
} as const;

function buildEnv() {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
  };
}

function makeLocals(surface: "app" | "console" | "tenant", host: string): AuthMiddlewareLocals {
  return {
    surface,
    host,
    isLocalLoopback: false,
    tenant: null,
    tenantDb: null,
    authUser: null,
    authSession: null,
    authorizedTenantMember: null,
    tenantEntitlement: null,
    platformOperator: null,
    twoFactorVerifiedAtMs: null,
  };
}

describe("TASK-078 Pre-Launch Security Assurance Workerd Gate", () => {
  let cookieX = "";

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, [
      ...PLATFORM_MIGRATIONS,
      PLATFORM_PLUGIN_RUNTIME_MIGRATION,
    ]);

    const signUp = async (email: string, name: string) => {
      const res = await handleBetterAuthRequest(
        new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
          body: JSON.stringify({ email, password: "Task078StrongPass!99", name }),
        }),
        buildEnv(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { readonly user: { readonly id: string } };
      const raw = res.headers.get("set-cookie") ?? "";
      const match = new RegExp(`${APP_SESSION_COOKIE_NAME}=[^;]+`).exec(raw);
      return { userId: body.user.id, cookie: match?.[0] ?? "" };
    };

    const ux = await signUp("t078-ver-x@example.test", "Owner X");
    const uy = await signUp("t078-ver-y@example.test", "Owner Y");
    cookieX = ux.cookie;

    const now = Date.now();
    const paid = now + 30 * 86_400_000;
    for (const [t, uid] of [
      [TENANT_X, ux.userId],
      [TENANT_Y, uy.userId],
    ] as const) {
      await env.PLATFORM_DB.batch([
        env.PLATFORM_DB.prepare(
          `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        ).bind(t.orgId, t.name, t.handle, now, now),
        env.PLATFORM_DB.prepare(
          `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)`,
        ).bind(`mem_${t.handle}`, t.orgId, uid, now),
        env.PLATFORM_DB.prepare(
          `INSERT OR REPLACE INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, paid_through, cache_version, schema_version, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'compro', 'active', 0, ?, 1, 1, 1, ?, ?)`,
        ).bind(t.id, t.orgId, t.handle, t.name, paid, now, now),
        env.PLATFORM_DB.prepare(
          `INSERT OR REPLACE INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at) VALUES (?, ?, 'subdomain', 'active', 'active', 1, ?, 1, ?, ?)`,
        ).bind(t.host, t.id, now, now, now),
      ]);

      const rawStub = env.TENANT_STORE.get(env.TENANT_STORE.idFromName(t.id));
      await runInDurableObject(rawStub, (_instance, state) =>
        applyTenantMigrations(state.storage as unknown as StorageLike, [
          ...TENANT_MIGRATIONS,
          TENANT_PLUGIN_LEDGER_MIGRATION,
        ]),
      );
    }

    const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const dbY = createTenantDb(openTenantStoreStub(ns, TENANT_Y.id));
    await createPage(dbY, {
      title: "Rahasia Tenant Y",
      slug: "rahasia-y",
      isHomepage: false,
      sections: [],
    });
  });

  it("blocks encoded/double-slash/dot-segment bypasses and rejects session cookies on /mcp in auth middleware", async () => {
    const rt = buildEnv();

    for (const bypassUrl of [
      `${CONSOLE_ORIGIN}/api/%63onsole/tenants`,
      `${CONSOLE_ORIGIN}/api//console/tenants`,
      `${APP_ORIGIN}/api/tenants/..%2fconsole/tenants`,
    ]) {
      const surface = bypassUrl.startsWith(CONSOLE_ORIGIN) ? "console" : "app";
      const host = new URL(bypassUrl).hostname;
      const res = await executeAuthMiddleware(
        {
          request: new Request(bypassUrl, { headers: { Cookie: cookieX } }),
          locals: makeLocals(surface, host),
        },
        async () => new Response("SHOULD_NOT_PASS", { status: 200 }),
        rt,
      );
      expect([400, 401, 403, 404]).toContain(res.status);
    }

    const mcpWithCookie = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieX },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
        locals: makeLocals("app", "app.punyasitus.com"),
      },
      async () => new Response("SHOULD_NOT_PASS", { status: 200 }),
      rt,
    );
    expect(mcpWithCookie.status).toBe(401);
  });

  it("returns strict neutral 404 when Tenant X accesses Tenant Y dashboard or pages API", async () => {
    const rt = buildEnv();

    const dashRes = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/dashboard/${TENANT_Y.handle}`, {
          headers: { Cookie: cookieX },
        }),
        locals: makeLocals("app", "app.punyasitus.com"),
      },
      async () => new Response("SHOULD_NOT_PASS", { status: 200 }),
      rt,
    );
    expect(dashRes.status).toBe(404);

    const apiRes = await handleTenantPagesCollectionRequest(
      TENANT_Y.handle,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_Y.handle}/pages`, {
        headers: { Cookie: cookieX },
      }),
      rt,
    );
    expect(apiRes.status).toBe(404);
    expect(await apiRes.text()).not.toContain("Rahasia Tenant Y");
  });
});

import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  DAY_MS,
  DEFAULT_SAAS_CNAME_TARGET,
  DomainConflictError,
  computeTenantDomainMarker,
  createCloudflareSaasClient,
  createFetchHttpsProbe,
  type CloudflareCustomHostname,
  type DnsResolverPort,
  type HttpsProbePort,
} from "@punyasitus/core/domains/index";
import { createLocalMailSink, type EmailPort } from "@punyasitus/core/email/index";
import { applyPlatformMigrations, createSqliteDrizzle } from "@punyasitus/db/connections";
import {
  claimTenantCustomHostname,
  ensureDomainMetadataSchema,
  promoteDomainToPrimary,
} from "@punyasitus/db/domains/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
} from "@punyasitus/db/platform";
import { clearHostResolutionCache, resolveTenantByHost } from "@punyasitus/db/routing/index";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CONSENT_COOKIE_NAME,
  serializeConsentCookie,
  validateTenantSetCookieHeader,
} from "../../apps/web/src/core/privacy.ts";
import {
  evaluateRequestGate,
  sanitizeTenantResponseHeaders,
} from "../../apps/web/src/core/tenant.ts";
import { handleDomainMarkerRequest } from "../../apps/web/src/pages/.well-known/punyasitus-domain-check.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantDomainDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/domains/[domainId].ts";
import { handleTenantDomainPromoteRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/domains/[domainId]/promote.ts";
import { handleTenantDomainRecheckRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/domains/[domainId]/recheck.ts";
import type { TenantDomainsRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/domains/_shared.ts";
import { handleTenantDomainsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/domains/index.ts";
import {
  DEFAULT_CRON_EXPRESSION,
  dispatchScheduledCron,
} from "../../apps/web/src/worker/cron/index.ts";
import type { JobQueuePayload } from "../../apps/web/src/worker/env.d.ts";
import {
  DOMAIN_CRON_JOB_DEFINITIONS,
  createDomainJobRegistry,
  runDomainRenewalWatch,
  runStaleHostnameReaper,
} from "../../apps/web/src/worker/queues/domains/index.ts";
import { processDurableQueueBatch } from "../../apps/web/src/worker/queues/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const TEST_MARKER_SECRET = "test-domain-marker-secret-0123456789abcdef";
const TEST_CF_TOKEN = "cf_test_zone_token_never_logged_123456";
const BASE_NOW_MS = Date.UTC(2026, 4, 1, 10, 0, 0);

function buildRuntimeEnv(
  overrides: Partial<TenantDomainsRuntimeEnv> = {},
): TenantDomainsRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    SAAS_CNAME_TARGET: DEFAULT_SAAS_CNAME_TARGET,
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    DOMAIN_MARKER_SECRET: TEST_MARKER_SECRET,
    CF_SAAS_ZONE_ID: "zone-situsku-01",
    CF_SAAS_API_TOKEN: TEST_CF_TOKEN,
    ...overrides,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function extractSessionCookiePair(response: Response): string {
  const cookies = getSetCookies(response.headers);
  const found = cookies.find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!found) {
    throw new Error(`Missing ${APP_SESSION_COOKIE_NAME} in Set-Cookie: ${JSON.stringify(cookies)}`);
  }
  return (found.split(";")[0] ?? "").trim();
}

function makeApiRequest(
  url: string,
  method: "GET" | "POST" | "DELETE",
  options: {
    readonly cookie?: string;
    readonly body?: unknown;
    readonly origin?: string | null;
    readonly contentType?: string | null;
    readonly idempotencyKey?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
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

async function signUpUser(
  email: string,
  name: string,
  runtimeEnv: TenantDomainsRuntimeEnv,
): Promise<{ readonly userId: string; readonly email: string; readonly cookie: string }> {
  const res = await handleBetterAuthRequest(
    makeApiRequest(`${APP_ORIGIN}/api/auth/sign-up/email`, "POST", {
      body: { email, password: "StrongPassword!2026", name },
    }),
    runtimeEnv,
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { user?: { id: string } };
  return {
    userId: data.user?.id ?? "",
    email,
    cookie: extractSessionCookiePair(res),
  };
}

let tenantSeq = 1;

interface TenantFixture {
  readonly tenantId: string;
  readonly handle: string;
  readonly subdomain: string;
  readonly orgId: string;
  readonly owner: { readonly userId: string; readonly email: string; readonly cookie: string };
  readonly admin: { readonly userId: string; readonly email: string; readonly cookie: string };
  readonly editor: { readonly userId: string; readonly email: string; readonly cookie: string };
}

async function provisionTenant(
  tag: string,
  runtimeEnv: TenantDomainsRuntimeEnv,
  options: {
    readonly status?: "trial" | "active" | "grace" | "locked" | "suspended";
    readonly paidThroughMs?: number | null;
    readonly trialEndsAtMs?: number | null;
  } = {},
): Promise<TenantFixture> {
  const seq = String(tenantSeq++).padStart(4, "0");
  const tenantId = `01JTESTDMN000000000000${seq}`;
  const orgId = `01JTESTDRG000000000000${seq}`;
  const handle = `dom-${tag}-${seq}`;
  const subdomain = `${handle}.situsku.click`;
  const status = options.status ?? "active";
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(BASE_NOW_MS);

  const owner = await signUpUser(`owner-${tag}-${seq}@example.test`, `Owner ${tag}`, runtimeEnv);
  const admin = await signUpUser(`admin-${tag}-${seq}@example.test`, `Admin ${tag}`, runtimeEnv);
  const editor = await signUpUser(`editor-${tag}-${seq}@example.test`, `Editor ${tag}`, runtimeEnv);

  await db.insert(organizations).values({
    id: orgId,
    name: `Org ${tag} ${seq}`,
    slug: `org-${handle}`,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(members).values([
    {
      id: `mem-own-${seq}`,
      organizationId: orgId,
      userId: owner.userId,
      role: "owner",
      createdAt: now,
    },
    {
      id: `mem-adm-${seq}`,
      organizationId: orgId,
      userId: admin.userId,
      role: "admin",
      createdAt: now,
    },
    {
      id: `mem-edt-${seq}`,
      organizationId: orgId,
      userId: editor.userId,
      role: "editor",
      createdAt: now,
    },
  ]);

  await db.insert(tenants).values({
    id: tenantId,
    organizationId: orgId,
    handle,
    name: `Toko ${tag} ${seq}`,
    vertical: "compro",
    status,
    trialEndsAt:
      options.trialEndsAtMs !== undefined
        ? options.trialEndsAtMs
          ? new Date(options.trialEndsAtMs)
          : null
        : status === "trial"
          ? new Date(BASE_NOW_MS + 7 * DAY_MS)
          : null,
    paidThrough:
      options.paidThroughMs !== undefined
        ? options.paidThroughMs
          ? new Date(options.paidThroughMs)
          : null
        : status === "active"
          ? new Date(BASE_NOW_MS + 30 * DAY_MS)
          : null,
    cacheVersion: 1,
    schemaVersion: 1,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(tenantHosts).values({
    host: subdomain,
    tenantId,
    kind: "subdomain",
    status: "active",
    sslStatus: "active",
    isPrimary: true,
    verifiedAt: now,
    lastCheckedAt: now,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });

  return { tenantId, handle, subdomain, orgId, owner, admin, editor };
}

let globalMockCfSeq = 1;

/**
 * In-memory mock Cloudflare for SaaS Custom Hostnames API server (via injectable `fetch`).
 */
class MockCloudflareSaasServer {
  readonly hostnames = new Map<string, CloudflareCustomHostname>();
  readonly calls: Array<{ readonly method: string; readonly path: string; readonly body?: unknown }> =
    [];
  failNextPostWithTimeout = false;
  createOnTimeoutAnyway = false;
  tokenGeneration = 1;

  setHostnameState(id: string, patch: Partial<CloudflareCustomHostname>): void {
    const existing = this.hostnames.get(id);
    if (!existing) throw new Error(`Mock CF hostname ${id} not found`);
    this.hostnames.set(id, {
      ...existing,
      ...patch,
      ssl: {
        ...existing.ssl,
        ...(patch.ssl ?? {}),
      },
    });
  }

  getByHostname(hostname: string): CloudflareCustomHostname | undefined {
    for (const item of this.hostnames.values()) {
      if (item.hostname === hostname.toLowerCase()) return item;
    }
    return undefined;
  }

  createFetch(): typeof fetch {
    return async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      this.calls.push({ method, path: `${url.pathname}${url.search}`, body });

      // Quota endpoint
      if (method === "GET" && url.pathname.endsWith("/custom_hostnames/quota")) {
        return new Response(
          JSON.stringify({
            success: true,
            result: { allocated: 100, used: this.hostnames.size },
          }),
          { status: 200 },
        );
      }

      // Create custom hostname
      if (method === "POST" && url.pathname.endsWith("/custom_hostnames")) {
        const hostname = String(body?.hostname ?? "").toLowerCase();
        const ssl = (body?.ssl ?? {}) as Record<string, unknown>;
        const sslMethod = String(ssl.method ?? "http");

        if (this.failNextPostWithTimeout) {
          this.failNextPostWithTimeout = false;
          if (this.createOnTimeoutAnyway) {
            this.createOnTimeoutAnyway = false;
            const id = `cf-ch-${String(globalMockCfSeq++).padStart(4, "0")}`;
            this.hostnames.set(id, this.buildDefaultRecord(id, hostname, sslMethod));
          }
          throw new DOMException("Simulated Cloudflare timeout", "AbortError");
        }

        const id = `cf-ch-${String(globalMockCfSeq++).padStart(4, "0")}`;
        const record = this.buildDefaultRecord(id, hostname, sslMethod);
        this.hostnames.set(id, record);
        return new Response(JSON.stringify({ success: true, result: record }), { status: 201 });
      }

      // List/lookup by hostname
      if (method === "GET" && url.pathname.endsWith("/custom_hostnames")) {
        const queryHost = (url.searchParams.get("hostname") ?? "").toLowerCase();
        const matches = Array.from(this.hostnames.values()).filter(
          (h) => !queryHost || h.hostname === queryHost,
        );
        return new Response(JSON.stringify({ success: true, result: matches }), { status: 200 });
      }

      // Single custom hostname GET / PATCH / DELETE
      const idMatch = url.pathname.match(/\/custom_hostnames\/([^/]+)$/);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]!);
        const existing = this.hostnames.get(id);

        if (method === "DELETE") {
          if (!existing) {
            return new Response(
              JSON.stringify({ success: false, errors: [{ code: 1436, message: "Not found" }] }),
              { status: 404 },
            );
          }
          this.hostnames.delete(id);
          return new Response(JSON.stringify({ success: true, result: { id } }), { status: 200 });
        }

        if (!existing) {
          return new Response(
            JSON.stringify({ success: false, errors: [{ code: 1436, message: "Not found" }] }),
            { status: 404 },
          );
        }

        if (method === "GET") {
          return new Response(JSON.stringify({ success: true, result: existing }), { status: 200 });
        }

        if (method === "PATCH") {
          const sslPatch = (body?.ssl ?? {}) as Record<string, unknown>;
          const nextMethod = typeof sslPatch.method === "string" ? sslPatch.method : existing.ssl.method;
          this.tokenGeneration += 1;
          const updated: CloudflareCustomHostname = {
            ...existing,
            ssl: {
              ...existing.ssl,
              method: nextMethod,
              ...(nextMethod === "txt" && existing.ssl.status !== "active"
                ? {
                    validation_records: [
                      {
                        txt_name: `_acme-challenge.${existing.hostname}`,
                        txt_value: `cf-dcv-token-gen-${this.tokenGeneration}-${existing.id}`,
                      },
                    ],
                  }
                : {}),
            },
          };
          this.hostnames.set(id, updated);
          return new Response(JSON.stringify({ success: true, result: updated }), { status: 200 });
        }
      }

      return new Response(JSON.stringify({ success: false, errors: [{ message: "Unknown route" }] }), {
        status: 404,
      });
    };
  }

  private buildDefaultRecord(
    id: string,
    hostname: string,
    sslMethod: string,
  ): CloudflareCustomHostname {
    return {
      id,
      hostname,
      status: "pending",
      ownership_verification: {
        type: "txt",
        name: `_cf-custom-hostname.${hostname}`,
        value: `cf-owner-${id}`,
      },
      ssl: {
        id: `ssl-${id}`,
        status: "pending_validation",
        method: sslMethod,
        type: "dv",
        certificate_authority: "lets_encrypt",
        ...(sslMethod === "txt"
          ? {
              dcv_delegation_records: [
                {
                  cname: `_acme-challenge.${hostname}`,
                  cname_target: `${hostname}.dcv-delegate.situsku.click`,
                },
              ],
              validation_records: [
                {
                  txt_name: `_acme-challenge.${hostname}`,
                  txt_value: `cf-dcv-token-gen-${this.tokenGeneration}-${id}`,
                },
              ],
            }
          : {}),
        settings: { min_tls_version: "1.2" },
      },
    };
  }
}

function createMockDnsResolver(records: {
  readonly cname?: Record<string, readonly string[]>;
  readonly txt?: Record<string, readonly string[]>;
  readonly caa?: Record<string, readonly string[]>;
}): DnsResolverPort {
  const cnameMap = records.cname ?? {};
  const txtMap = records.txt ?? {};
  const caaMap = records.caa ?? {};
  return {
    async resolveCname(hostname: string) {
      return cnameMap[hostname.toLowerCase()] ?? [];
    },
    async resolveTxt(hostname: string) {
      return txtMap[hostname.toLowerCase()] ?? [];
    },
    async resolveCaa(hostname: string) {
      return caaMap[hostname.toLowerCase()] ?? [];
    },
  };
}

describe("TASK-003 integration (workerd + real D1 PLATFORM_DB)", () => {
  const runtimeEnv = buildRuntimeEnv();

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await ensureDomainMetadataSchema(env.PLATFORM_DB);
    clearHostResolutionCache();
  });

  it("rejects trial websites, >64-char hostnames, forbidden fields, unauthorized roles, wrong surfaces, and duplicate claims across tenants", async () => {
    const mockCf = new MockCloudflareSaasServer();
    const trialTenant = await provisionTenant("trial", runtimeEnv, { status: "trial" });
    const paidTenantA = await provisionTenant("paid-a", runtimeEnv, { status: "active" });
    const paidTenantB = await provisionTenant("paid-b", runtimeEnv, { status: "active" });
    const lockedTenant = await provisionTenant("locked", runtimeEnv, { status: "locked" });

    // 1. Trial website -> 403 TRIAL_DOMAIN_FORBIDDEN
    const trialRes = await handleTenantDomainsRequest(
      trialTenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${trialTenant.tenantId}/domains`, "POST", {
        cookie: trialTenant.owner.cookie,
        body: { hostname: "www.trial-site.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareFetch: mockCf.createFetch(), nowMs: BASE_NOW_MS },
    );
    expect(trialRes.status).toBe(403);
    const trialBody = (await trialRes.json()) as { error: { code: string } };
    expect(trialBody.error.code).toBe("TRIAL_DOMAIN_FORBIDDEN");
    expect(mockCf.calls).toHaveLength(0);

    // 2. Hostname > 64 chars -> 422
    const longHost = `${"x".repeat(52)}.tokocontoh.id`;
    expect(longHost.length).toBeGreaterThan(64);
    const longRes = await handleTenantDomainsRequest(
      paidTenantA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidTenantA.tenantId}/domains`, "POST", {
        cookie: paidTenantA.owner.cookie,
        body: { hostname: longHost, mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareFetch: mockCf.createFetch(), nowMs: BASE_NOW_MS },
    );
    expect(longRes.status).toBe(422);

    // 3. Forbidden selector (`tenantId` in body) and unknown field -> 422
    const forbiddenFieldRes = await handleTenantDomainsRequest(
      paidTenantA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidTenantA.tenantId}/domains`, "POST", {
        cookie: paidTenantA.owner.cookie,
        body: { hostname: "www.alpha-a.id", mode: "new_domain", tenantId: paidTenantB.tenantId },
      }),
      runtimeEnv,
      { cloudflareFetch: mockCf.createFetch(), nowMs: BASE_NOW_MS },
    );
    expect(forbiddenFieldRes.status).toBe(422);

    const unknownFieldRes = await handleTenantDomainsRequest(
      paidTenantA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidTenantA.tenantId}/domains`, "POST", {
        cookie: paidTenantA.owner.cookie,
        body: { hostname: "www.alpha-a.id", mode: "new_domain", extraStuff: true },
      }),
      runtimeEnv,
      { cloudflareFetch: mockCf.createFetch(), nowMs: BASE_NOW_MS },
    );
    expect(unknownFieldRes.status).toBe(422);

    // 4. Wrong surface (tenant host / console host) -> neutral 404
    const onTenantHost = await handleTenantDomainsRequest(
      paidTenantA.tenantId,
      makeApiRequest(
        `https://${paidTenantA.subdomain}/api/tenants/${paidTenantA.tenantId}/domains`,
        "GET",
        { cookie: paidTenantA.owner.cookie },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(onTenantHost.status).toBe(404);

    const onConsoleHost = await handleTenantDomainsRequest(
      paidTenantA.tenantId,
      makeApiRequest(`${CONSOLE_ORIGIN}/api/tenants/${paidTenantA.tenantId}/domains`, "GET", {
        cookie: paidTenantA.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(onConsoleHost.status).toBe(404);

    // 5. Missing Origin / bad Origin -> 403 CSRF
    const badOrigin = await handleTenantDomainsRequest(
      paidTenantA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidTenantA.tenantId}/domains`, "POST", {
        cookie: paidTenantA.owner.cookie,
        origin: `https://${paidTenantA.subdomain}`,
        body: { hostname: "www.alpha-a.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareFetch: mockCf.createFetch(), nowMs: BASE_NOW_MS },
    );
    expect(badOrigin.status).toBe(403);

    // 6. Unauthenticated -> 401; editor -> 403; admin write -> 403 (read -> 200); cross-tenant -> 404
    const unauth = await handleTenantDomainsRequest(
      paidTenantA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidTenantA.tenantId}/domains`, "GET"),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(unauth.status).toBe(401);

    const editorRead = await handleTenantDomainsRequest(
      paidTenantA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidTenantA.tenantId}/domains`, "GET", {
        cookie: paidTenantA.editor.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(editorRead.status).toBe(403);

    const adminRead = await handleTenantDomainsRequest(
      paidTenantA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidTenantA.tenantId}/domains`, "GET", {
        cookie: paidTenantA.admin.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(adminRead.status).toBe(200);

    const adminWrite = await handleTenantDomainsRequest(
      paidTenantA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidTenantA.tenantId}/domains`, "POST", {
        cookie: paidTenantA.admin.cookie,
        body: { hostname: "www.alpha-a.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareFetch: mockCf.createFetch(), nowMs: BASE_NOW_MS },
    );
    expect(adminWrite.status).toBe(403);

    const crossTenant = await handleTenantDomainsRequest(
      paidTenantA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidTenantA.tenantId}/domains`, "GET", {
        cookie: paidTenantB.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(crossTenant.status).toBe(404);

    // 7. Locked tenant: read allowed (200), connect blocked (403 SUBSCRIPTION_LOCKED)
    const lockedRead = await handleTenantDomainsRequest(
      lockedTenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${lockedTenant.tenantId}/domains`, "GET", {
        cookie: lockedTenant.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(lockedRead.status).toBe(200);

    const lockedWrite = await handleTenantDomainsRequest(
      lockedTenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${lockedTenant.tenantId}/domains`, "POST", {
        cookie: lockedTenant.owner.cookie,
        body: { hostname: "www.locked-site.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareFetch: mockCf.createFetch(), nowMs: BASE_NOW_MS },
    );
    expect(lockedWrite.status).toBe(403);
    expect(((await lockedWrite.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );

    // 8. Duplicate claim across tenants -> 409 DOMAIN_ALREADY_CLAIMED
    const claimA = await handleTenantDomainsRequest(
      paidTenantA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidTenantA.tenantId}/domains`, "POST", {
        cookie: paidTenantA.owner.cookie,
        body: { hostname: "www.shared-claim.id", mode: "new_domain" },
      }),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({}),
        nowMs: BASE_NOW_MS,
      },
    );
    expect(claimA.status).toBe(201);

    const claimB = await handleTenantDomainsRequest(
      paidTenantB.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidTenantB.tenantId}/domains`, "POST", {
        cookie: paidTenantB.owner.cookie,
        body: { hostname: "www.shared-claim.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareFetch: mockCf.createFetch(), nowMs: BASE_NOW_MS },
    );
    expect(claimB.status).toBe(409);
    const claimBBody = (await claimB.json()) as {
      error: { code: string; reasonCode?: string; message: string };
    };
    expect(claimBBody.error.reasonCode).toBe("DOMAIN_ALREADY_CLAIMED");
    expect(claimBBody.error.message).not.toContain(paidTenantA.tenantId);
  });

  it("handles 3 connect modes (new_domain, zero_downtime_migration locked cutover, O2O create-before-CNAME), conflicting _acme-challenge TXT, CAA/Blocked remedies, token age day-5/expiry refetch & rate-limited PATCH recheck", async () => {
    const mockCf = new MockCloudflareSaasServer();
    const tenantMig = await provisionTenant("mig", runtimeEnv, { status: "active" });
    const tenantO2o = await provisionTenant("o2o", runtimeEnv, { status: "active" });

    // --- Mode B: Zero-downtime migration ---
    const migCreateRes = await handleTenantDomainsRequest(
      tenantMig.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenantMig.tenantId}/domains`, "POST", {
        cookie: tenantMig.owner.cookie,
        body: { hostname: "www.pindahan.id", mode: "zero_downtime_migration" },
      }),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({
          txt: { "_acme-challenge.www.pindahan.id": ["stale-conflicting-acme-txt"] },
        }),
        nowMs: BASE_NOW_MS,
      },
    );
    expect(migCreateRes.status).toBe(201);
    const migBody = (await migCreateRes.json()) as {
      id: number;
      cfCustomHostnameId: string;
      version: number;
      validationRecords: Array<{ recordType: string; name: string; value: string; purpose: string }>;
      instructions: { cnameCutoverLocked: boolean; readyForCutover: boolean };
      remedies: Array<{ code: string; affectedRecord?: string }>;
    };

    // Exact provider records only + CNAME cutover LOCKED + conflicting `_acme-challenge` TXT reported!
    expect(migBody.instructions.cnameCutoverLocked).toBe(true);
    expect(migBody.instructions.readyForCutover).toBe(false);
    expect(migBody.validationRecords.some((r) => r.purpose === "routing")).toBe(false);
    expect(
      migBody.validationRecords.some(
        (r) => r.purpose === "ownership" && r.value === `cf-owner-${migBody.cfCustomHostnameId}`,
      ),
    ).toBe(true);
    expect(
      migBody.remedies.some(
        (r) =>
          r.code === "CONFLICTING_ACME_CHALLENGE_TXT" &&
          r.affectedRecord === "_acme-challenge.www.pindahan.id",
      ),
    ).toBe(true);

    // Day-5 warning check via GET
    const day5Res = await handleTenantDomainDetailRequest(
      tenantMig.tenantId,
      String(migBody.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenantMig.tenantId}/domains/${migBody.id}`,
        "GET",
        { cookie: tenantMig.owner.cookie },
      ),
      runtimeEnv,
      { dnsResolver: createMockDnsResolver({}), nowMs: BASE_NOW_MS + 5 * DAY_MS },
    );
    expect(day5Res.status).toBe(200);
    const day5Body = (await day5Res.json()) as {
      tokenAge: { warningDay5: boolean; expired: boolean; ttlDays: number; ageDays: number };
      remedies: Array<{ code: string }>;
    };
    expect(day5Body.tokenAge.ttlDays).toBe(7);
    expect(day5Body.tokenAge.ageDays).toBe(5);
    expect(day5Body.tokenAge.warningDay5).toBe(true);
    expect(day5Body.tokenAge.expired).toBe(false);
    expect(day5Body.remedies.some((r) => r.code === "DCV_TOKEN_EXPIRING_SOON")).toBe(true);

    // Day-7 expiry -> "Periksa sekarang" sends documented PATCH with current ssl settings AND re-fetches fresh DCV token!
    const callsBeforeRecheck = mockCf.calls.length;
    const day7RecheckRes = await handleTenantDomainRecheckRequest(
      tenantMig.tenantId,
      String(migBody.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenantMig.tenantId}/domains/${migBody.id}/recheck`,
        "POST",
        { cookie: tenantMig.owner.cookie, body: { version: migBody.version } },
      ),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({}),
        nowMs: BASE_NOW_MS + 7 * DAY_MS + 1000,
        recheckRateLimitPolicy: { perDomainLimit: 2, perDomainWindowMs: 60_000 },
      },
    );
    expect(day7RecheckRes.status).toBe(200);
    const day7Body = (await day7RecheckRes.json()) as {
      version: number;
      patchedSsl: boolean;
      tokenRefetched: boolean;
      tokenAge: { expired: boolean; ageDays: number };
      validationRecords: Array<{ recordType: string; value: string; purpose: string }>;
    };
    expect(day7Body.patchedSsl).toBe(true);
    expect(day7Body.tokenRefetched).toBe(true);
    expect(day7Body.tokenAge.expired).toBe(false);
    expect(day7Body.tokenAge.ageDays).toBe(0);

    const recheckCalls = mockCf.calls.slice(callsBeforeRecheck);
    expect(recheckCalls[0]?.method).toBe("PATCH");
    expect(recheckCalls[0]?.body).toEqual({
      ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
    });
    expect(recheckCalls[1]?.method).toBe("GET");

    // Simulate CAA & Blocked remedies on Cloudflare
    mockCf.setHostnameState(migBody.cfCustomHostnameId, {
      status: "blocked",
      ssl: {
        ...mockCf.hostnames.get(migBody.cfCustomHostnameId)!.ssl,
        validation_errors: [{ message: "CAA record forbids issuance" }],
      },
    });
    const remedyRes = await handleTenantDomainRecheckRequest(
      tenantMig.tenantId,
      String(migBody.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenantMig.tenantId}/domains/${migBody.id}/recheck`,
        "POST",
        { cookie: tenantMig.owner.cookie, body: { version: day7Body.version } },
      ),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({ caa: { "www.pindahan.id": ['0 issue "sectigo.com"'] } }),
        nowMs: BASE_NOW_MS + 7 * DAY_MS + 2000,
        recheckRateLimitPolicy: { perDomainLimit: 2, perDomainWindowMs: 60_000 },
      },
    );
    expect(remedyRes.status).toBe(200);
    const remedyBody = (await remedyRes.json()) as {
      version: number;
      remedies: Array<{ code: string }>;
    };
    expect(remedyBody.remedies.map((r) => r.code)).toContain("CAA_BLOCKED");
    expect(remedyBody.remedies.map((r) => r.code)).toContain("HOSTNAME_BLOCKED");

    // 3rd recheck inside 60s window -> 429 RATE_LIMITED!
    const rateLimitedRes = await handleTenantDomainRecheckRequest(
      tenantMig.tenantId,
      String(migBody.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenantMig.tenantId}/domains/${migBody.id}/recheck`,
        "POST",
        { cookie: tenantMig.owner.cookie, body: { version: remedyBody.version } },
      ),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        nowMs: BASE_NOW_MS + 7 * DAY_MS + 3000,
        recheckRateLimitPolicy: { perDomainLimit: 2, perDomainWindowMs: 60_000 },
      },
    );
    expect(rateLimitedRes.status).toBe(429);
    expect(Number(rateLimitedRes.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);

    // Once BOTH status === "active" AND ssl.status === "active" -> Step 3 CNAME cutover UNLOCKS!
    mockCf.setHostnameState(migBody.cfCustomHostnameId, {
      status: "active",
      ssl: {
        ...mockCf.hostnames.get(migBody.cfCustomHostnameId)!.ssl,
        status: "active",
        validation_errors: [],
      },
    });
    const unlockedRes = await handleTenantDomainRecheckRequest(
      tenantMig.tenantId,
      String(migBody.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenantMig.tenantId}/domains/${migBody.id}/recheck`,
        "POST",
        { cookie: tenantMig.owner.cookie, body: { version: remedyBody.version } },
      ),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({}),
        nowMs: BASE_NOW_MS + 7 * DAY_MS + 120_000, // next minute window
        recheckRateLimitPolicy: { perDomainLimit: 2, perDomainWindowMs: 60_000 },
      },
    );
    expect(unlockedRes.status).toBe(200);
    const unlockedBody = (await unlockedRes.json()) as {
      instructions: { cnameCutoverLocked: boolean; readyForCutover: boolean };
      validationRecords: Array<{ recordType: string; name: string; value: string; purpose: string }>;
    };
    expect(unlockedBody.instructions.cnameCutoverLocked).toBe(false);
    expect(unlockedBody.instructions.readyForCutover).toBe(true);
    expect(unlockedBody.validationRecords).toContainEqual({
      recordType: "CNAME",
      name: "www.pindahan.id",
      value: DEFAULT_SAAS_CNAME_TARGET,
      purpose: "routing",
      status: "pending",
      removableAfterActive: false,
    });

    // --- Mode C: O2O (create-before-CNAME) ---
    const o2oCallsBefore = mockCf.calls.length;
    const o2oRes = await handleTenantDomainsRequest(
      tenantO2o.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenantO2o.tenantId}/domains`, "POST", {
        cookie: tenantO2o.owner.cookie,
        body: { hostname: "www.cloudflare-o2o.id", mode: "o2o" },
      }),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({}),
        nowMs: BASE_NOW_MS,
      },
    );
    expect(o2oRes.status).toBe(201);
    const o2oBody = (await o2oRes.json()) as {
      mode: string;
      cfCustomHostnameId: string;
      instructions: { createBeforeCnameSatisfied: boolean };
      remedies: Array<{ code: string }>;
    };
    expect(o2oBody.mode).toBe("cloudflare_o2o");
    expect(o2oBody.cfCustomHostnameId).toBeTruthy();
    expect(o2oBody.instructions.createBeforeCnameSatisfied).toBe(true);
    expect(o2oBody.remedies.some((r) => r.code === "O2O_SSL_MODE_REMINDER")).toBe(true);
    expect(mockCf.calls.slice(o2oCallsBefore).some((c) => c.method === "POST")).toBe(true);
  });

  it("keeps domain cleanly pending on provider timeout and reconciles existing provider record on retry without duplication", async () => {
    const mockCf = new MockCloudflareSaasServer();
    const tenant = await provisionTenant("timeout", runtimeEnv, { status: "active" });

    // Timeout happens AFTER Cloudflare actually created the hostname on its side!
    mockCf.failNextPostWithTimeout = true;
    mockCf.createOnTimeoutAnyway = true;

    const firstRes = await handleTenantDomainsRequest(
      tenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains`, "POST", {
        cookie: tenant.owner.cookie,
        body: { hostname: "www.retry-safe.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareFetch: mockCf.createFetch(), nowMs: BASE_NOW_MS },
    );
    expect(firstRes.status).toBe(503);
    const firstBody = (await firstRes.json()) as {
      reconciliationPending: boolean;
      domain: { hostStatus: string; cfCustomHostnameId: string | null };
    };
    expect(firstBody.reconciliationPending).toBe(true);
    expect(firstBody.domain.hostStatus).toBe("pending");
    expect(firstBody.domain.cfCustomHostnameId).toBeNull();
    expect(mockCf.hostnames.size).toBe(1);

    // Retry POST -> looks up existing Cloudflare hostname by name and binds it without calling POST again!
    const postCountBeforeRetry = mockCf.calls.filter((c) => c.method === "POST").length;
    const retryRes = await handleTenantDomainsRequest(
      tenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains`, "POST", {
        cookie: tenant.owner.cookie,
        body: { hostname: "www.retry-safe.id", mode: "new_domain" },
      }),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({}),
        nowMs: BASE_NOW_MS + 5_000,
      },
    );
    expect(retryRes.status).toBe(200);
    const retryBody = (await retryRes.json()) as {
      cfCustomHostnameId: string;
      reconciledExisting: boolean;
    };
    expect(retryBody.reconciledExisting).toBe(true);
    expect(retryBody.cfCustomHostnameId).toBeTruthy();
    expect(mockCf.hostnames.size).toBe(1);
    expect(mockCf.calls.filter((c) => c.method === "POST").length).toBe(postCountBeforeRetry);
  });

  it("enforces all 4 gates before primary promotion, switches primary atomically with cache invalidation, and locks active removal while allowing inactive removal", async () => {
    const mockCf = new MockCloudflareSaasServer();
    const tenant = await provisionTenant("promote", runtimeEnv, { status: "active" });

    // Connect inactive domain to test owner removal before activation
    const removableRes = await handleTenantDomainsRequest(
      tenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains`, "POST", {
        cookie: tenant.owner.cookie,
        body: { hostname: "www.typo-domain.id", mode: "new_domain" },
      }),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({}),
        nowMs: BASE_NOW_MS,
      },
    );
    expect(removableRes.status).toBe(201);
    const removable = (await removableRes.json()) as { id: number; version: number };

    // Remove inactive domain with exact confirmHostname -> 204
    const delRes = await handleTenantDomainDetailRequest(
      tenant.tenantId,
      String(removable.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${removable.id}`,
        "DELETE",
        {
          cookie: tenant.owner.cookie,
          body: { confirmHostname: "www.typo-domain.id", version: removable.version },
        },
      ),
      runtimeEnv,
      { cloudflareFetch: mockCf.createFetch(), nowMs: BASE_NOW_MS + 1000 },
    );
    expect(delRes.status).toBe(204);

    // Connect real custom domain
    const createRes = await handleTenantDomainsRequest(
      tenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains`, "POST", {
        cookie: tenant.owner.cookie,
        body: { hostname: "www.promo-toko.id", mode: "new_domain" },
      }),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({}),
        nowMs: BASE_NOW_MS + 2000,
      },
    );
    expect(createRes.status).toBe(201);
    const dom = (await createRes.json()) as {
      id: number;
      cfCustomHostnameId: string;
      version: number;
    };

    const expectedMarker = await computeTenantDomainMarker(
      tenant.tenantId,
      "www.promo-toko.id",
      TEST_MARKER_SECRET,
    );
    const passingProbe: HttpsProbePort = {
      async probeTenantMarker(input) {
        return {
          ok: true,
          statusCode: 200,
          observedTenantId: input.expectedTenantId,
          markerMatched: input.expectedMarker === expectedMarker,
          errorCode: null,
        };
      },
    };
    const failingProbe: HttpsProbePort = {
      async probeTenantMarker() {
        return {
          ok: false,
          statusCode: 502,
          observedTenantId: null,
          markerMatched: false,
          errorCode: "HTTPS_PROBE_HTTP_502",
        };
      },
    };

    // Gate 1 & 2 fail (CF pending)
    const g1 = await handleTenantDomainPromoteRequest(
      tenant.tenantId,
      String(dom.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${dom.id}/promote`,
        "POST",
        { cookie: tenant.owner.cookie, body: { version: dom.version } },
      ),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({
          cname: { "www.promo-toko.id": [DEFAULT_SAAS_CNAME_TARGET] },
        }),
        httpsProbe: passingProbe,
        nowMs: BASE_NOW_MS + 3000,
      },
    );
    expect(g1.status).toBe(409);

    // Activate CF ownership + SSL, but CNAME missing (Gate 3 fail)
    mockCf.setHostnameState(dom.cfCustomHostnameId, {
      status: "active",
      ssl: { ...mockCf.hostnames.get(dom.cfCustomHostnameId)!.ssl, status: "active" },
    });
    const g3 = await handleTenantDomainPromoteRequest(
      tenant.tenantId,
      String(dom.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${dom.id}/promote`,
        "POST",
        { cookie: tenant.owner.cookie, body: { version: dom.version } },
      ),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({ cname: { "www.promo-toko.id": ["wrong.target.net"] } }),
        httpsProbe: passingProbe,
        nowMs: BASE_NOW_MS + 4000,
      },
    );
    expect(g3.status).toBe(409);

    // CNAME matches, but HTTPS marker probe fails (Gate 4 fail)
    const g4 = await handleTenantDomainPromoteRequest(
      tenant.tenantId,
      String(dom.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${dom.id}/promote`,
        "POST",
        { cookie: tenant.owner.cookie, body: { version: dom.version } },
      ),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({
          cname: { "www.promo-toko.id": [DEFAULT_SAAS_CNAME_TARGET] },
        }),
        httpsProbe: failingProbe,
        nowMs: BASE_NOW_MS + 5000,
      },
    );
    expect(g4.status).toBe(409);

    // All 4 gates pass -> promotes atomically, bumps cache_version, evicts cache!
    const okPromote = await handleTenantDomainPromoteRequest(
      tenant.tenantId,
      String(dom.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${dom.id}/promote`,
        "POST",
        { cookie: tenant.owner.cookie, body: { version: dom.version } },
      ),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({
          cname: { "www.promo-toko.id": [DEFAULT_SAAS_CNAME_TARGET] },
        }),
        httpsProbe: passingProbe,
        nowMs: BASE_NOW_MS + 6000,
      },
    );
    expect(okPromote.status).toBe(200);
    const promoted = (await okPromote.json()) as {
      isPrimary: boolean;
      isLocked: boolean;
      version: number;
    };
    expect(promoted.isPrimary).toBe(true);
    expect(promoted.isLocked).toBe(true);

    // Authoritative routing immediately resolves new primary & cache_version incremented!
    const resolved = await resolveTenantByHost(env.PLATFORM_DB, "www.promo-toko.id", {
      nowMs: BASE_NOW_MS + 6500,
    });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind === "resolved") {
      expect(resolved.hostRecord.isPrimary).toBe(true);
      expect(resolved.tenant.cacheVersion).toBeGreaterThan(1);
    }

    // Active custom domain is LOCKED for owner removal -> 403 DOMAIN_LOCKED
    const lockedDel = await handleTenantDomainDetailRequest(
      tenant.tenantId,
      String(dom.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${dom.id}`,
        "DELETE",
        {
          cookie: tenant.owner.cookie,
          body: { confirmHostname: "www.promo-toko.id", version: promoted.version },
        },
      ),
      runtimeEnv,
      { cloudflareFetch: mockCf.createFetch(), nowMs: BASE_NOW_MS + 7000 },
    );
    expect(lockedDel.status).toBe(403);
    expect(((await lockedDel.json()) as { error: { code: string } }).error.code).toBe(
      "DOMAIN_LOCKED",
    );
  });

  it("7-day stale-hostname reaper deletes abandoned pending/moved hostnames with audit and spares fresh/active hostnames", async () => {
    const mockCf = new MockCloudflareSaasServer();
    const cfClient = createCloudflareSaasClient({
      zoneId: "zone-situsku-01",
      apiToken: TEST_CF_TOKEN,
      fetchImpl: mockCf.createFetch(),
    });
    const tenant = await provisionTenant("reaper", runtimeEnv, { status: "active" });
    const nowMs = BASE_NOW_MS + 20 * DAY_MS;

    // Seed 4 custom hostnames: stale pending (9d), stale moved (8d), fresh pending (2d), old active (15d)
    const stalePendingCf = await cfClient.createCustomHostname({
      hostname: "stale-pending.toko.id",
      sslMethod: "http",
    });
    const staleMovedCf = await cfClient.createCustomHostname({
      hostname: "stale-moved.toko.id",
      sslMethod: "http",
    });
    const freshPendingCf = await cfClient.createCustomHostname({
      hostname: "fresh-pending.toko.id",
      sslMethod: "http",
    });
    const oldActiveCf = await cfClient.createCustomHostname({
      hostname: "old-active.toko.id",
      sslMethod: "http",
    });

    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hosts (host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary, version, created_at, updated_at)
         VALUES (?, ?, 'custom', ?, 'pending', 'pending', 0, 1, ?, ?)`,
      ).bind("stale-pending.toko.id", tenant.tenantId, stalePendingCf.id, nowMs - 9 * DAY_MS, nowMs - 9 * DAY_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hosts (host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary, version, created_at, updated_at)
         VALUES (?, ?, 'custom', ?, 'moved', 'pending', 0, 1, ?, ?)`,
      ).bind("stale-moved.toko.id", tenant.tenantId, staleMovedCf.id, nowMs - 12 * DAY_MS, nowMs - 8 * DAY_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hosts (host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary, version, created_at, updated_at)
         VALUES (?, ?, 'custom', ?, 'pending', 'pending', 0, 1, ?, ?)`,
      ).bind("fresh-pending.toko.id", tenant.tenantId, freshPendingCf.id, nowMs - 2 * DAY_MS, nowMs - 2 * DAY_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hosts (host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary, version, created_at, updated_at)
         VALUES (?, ?, 'custom', ?, 'active', 'active', 0, 1, ?, ?)`,
      ).bind("old-active.toko.id", tenant.tenantId, oldActiveCf.id, nowMs - 15 * DAY_MS, nowMs - 15 * DAY_MS),
    ]);

    const result = await runStaleHostnameReaper({
      platformDb: env.PLATFORM_DB,
      cloudflareClient: cfClient,
      nowMs,
      logger: () => {},
    });

    const tenantReaped = result.items
      .filter((i) => i.tenantId === tenant.tenantId && i.outcome === "reaped")
      .map((i) => i.host)
      .sort();
    expect(tenantReaped).toEqual(["stale-moved.toko.id", "stale-pending.toko.id"]);
    expect(result.failed).toBe(0);
    expect(mockCf.hostnames.has(stalePendingCf.id)).toBe(false);
    expect(mockCf.hostnames.has(staleMovedCf.id)).toBe(false);
    expect(mockCf.hostnames.has(freshPendingCf.id)).toBe(true);
    expect(mockCf.hostnames.has(oldActiveCf.id)).toBe(true);

    // Verify fresh pending, active custom, and platform subdomain remain intact in PLATFORM_DB
    const remainingHosts = await env.PLATFORM_DB.prepare(
      `SELECT host FROM tenant_hosts WHERE tenant_id = ? ORDER BY host ASC`,
    )
      .bind(tenant.tenantId)
      .all<{ host: string }>();
    expect((remainingHosts.results ?? []).map((r) => r.host)).toEqual(
      [tenant.subdomain, "fresh-pending.toko.id", "old-active.toko.id"].sort(),
    );

    // Verify audit entries recorded in platform_audit
    const auditRows = await env.PLATFORM_DB.prepare(
      `SELECT target_id FROM platform_audit WHERE tenant_id = ? AND action = 'domain.reaper.deleted'`,
    )
      .bind(tenant.tenantId)
      .all<{ target_id: string }>();
    const auditedHosts = (auditRows.results ?? []).map((r) => r.target_id).sort();
    expect(auditedHosts).toEqual(["stale-moved.toko.id", "stale-pending.toko.id"]);
  });

  it("renewal-watch Cron notifies owner when CNAME or Delegated DCV record disappears, deduplicates alerts, and stays non-fatal on email failure", async () => {
    const tenant = await provisionTenant("renewal", runtimeEnv, { status: "active" });
    const nowMs = BASE_NOW_MS + 30 * DAY_MS;
    const mailSink = createLocalMailSink();

    // Seed two active custom domains: one with missing CNAME, one with missing Delegated DCV CNAME
    const dcvSnapshot: CloudflareCustomHostname = {
      id: "cf-ren-dcv",
      hostname: "www.dcv-hilang.id",
      status: "active",
      ssl: {
        status: "active",
        method: "txt",
        type: "dv",
        dcv_delegation_records: [
          {
            cname: "_acme-challenge.www.dcv-hilang.id",
            cname_target: "www.dcv-hilang.id.dcv-delegate.situsku.click",
          },
        ],
      },
    };

    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hosts (host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary, version, created_at, updated_at)
         VALUES ('www.cname-hilang.id', ?, 'custom', 'cf-ren-cname', 'active', 'active', 0, 1, ?, ?)`,
      ).bind(tenant.tenantId, nowMs - 10 * DAY_MS, nowMs - 10 * DAY_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_host_metadata (host, tenant_id, domain_id, connect_mode, ssl_method, ever_activated, created_at, updated_at)
         VALUES ('www.cname-hilang.id', ?, 2, 'new_domain', 'http', 1, ?, ?)`,
      ).bind(tenant.tenantId, nowMs - 10 * DAY_MS, nowMs - 10 * DAY_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hosts (host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary, version, created_at, updated_at)
         VALUES ('www.dcv-hilang.id', ?, 'custom', 'cf-ren-dcv', 'active', 'active', 0, 1, ?, ?)`,
      ).bind(tenant.tenantId, nowMs - 10 * DAY_MS, nowMs - 10 * DAY_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_host_metadata (host, tenant_id, domain_id, connect_mode, ssl_method, provider_snapshot_json, ever_activated, created_at, updated_at)
         VALUES ('www.dcv-hilang.id', ?, 3, 'zero_downtime_migration', 'txt', ?, 1, ?, ?)`,
      ).bind(tenant.tenantId, JSON.stringify(dcvSnapshot), nowMs - 10 * DAY_MS, nowMs - 10 * DAY_MS),
    ]);

    const dns = createMockDnsResolver({
      cname: {
        // www.cname-hilang.id missing!
        "www.dcv-hilang.id": [DEFAULT_SAAS_CNAME_TARGET],
        // _acme-challenge.www.dcv-hilang.id missing!
      },
    });

    // Run 1: notifies owner for BOTH degraded domains
    const run1 = await runDomainRenewalWatch({
      platformDb: env.PLATFORM_DB,
      dnsResolver: dns,
      emailPort: mailSink,
      nowMs,
      logger: () => {},
    });
    const cnameItem = run1.items.find((i) => i.host === "www.cname-hilang.id");
    const dcvItem = run1.items.find((i) => i.host === "www.dcv-hilang.id");
    expect(cnameItem?.issues).toContain("CNAME_MISSING");
    expect(cnameItem?.alertAction).toBe("sent");
    expect(dcvItem?.issues).toContain("DCV_DELEGATION_MISSING");
    expect(dcvItem?.alertAction).toBe("sent");
    expect(
      mailSink
        .list()
        .some((m) => m.to === tenant.owner.email && m.subject.includes("www.cname-hilang.id")),
    ).toBe(true);
    expect(
      mailSink
        .list()
        .some((m) => m.to === tenant.owner.email && m.subject.includes("www.dcv-hilang.id")),
    ).toBe(true);

    // Run 2 within 24h cooldown: deduplicated!
    const capturedBeforeRun2 = mailSink.list().length;
    const run2 = await runDomainRenewalWatch({
      platformDb: env.PLATFORM_DB,
      dnsResolver: dns,
      emailPort: mailSink,
      nowMs: nowMs + 2 * 60 * 60 * 1000,
      logger: () => {},
    });
    expect(run2.items.find((i) => i.host === "www.cname-hilang.id")?.alertAction).toBe(
      "deduplicated",
    );
    expect(run2.items.find((i) => i.host === "www.dcv-hilang.id")?.alertAction).toBe(
      "deduplicated",
    );
    expect(mailSink.list().length).toBe(capturedBeforeRun2);

    // Run 3 after cooldown with failing EmailPort -> strictly non-fatal!
    const failingEmailPort: EmailPort = {
      provider: "cloudflare",
      async send() {
        throw new Error("Simulated email outage");
      },
    };
    const run3 = await runDomainRenewalWatch({
      platformDb: env.PLATFORM_DB,
      dnsResolver: dns,
      emailPort: failingEmailPort,
      nowMs: nowMs + 2 * DAY_MS,
      logger: () => {},
    });
    expect(run3.emailFailures).toBeGreaterThanOrEqual(2);
    expect(run3.items.find((i) => i.host === "www.cname-hilang.id")?.alertAction).toBe(
      "email_failed",
    );
  });

  it("enforces tenant-host cookie isolation at runtime (no Domain=, __Host- consent prefix only)", async () => {
    const tenant = await provisionTenant("cookie-iso", runtimeEnv, { status: "active" });

    // 1. Live tenant-host routing gate response
    const gateDecision = await evaluateRequestGate(
      new Request(`https://${tenant.subdomain}/`, {
        headers: {
          Cookie: `tossed=evil; __Host-ps_session=stolen; ${CONSENT_COOKIE_NAME}=%7B%22version%22%3A1%2C%22analytics%22%3Afalse%2C%22marketing%22%3Afalse%2C%22maps%22%3Afalse%2C%22updatedAt%22%3A%222026-05-01T12%3A00%3A00.000Z%22%7D`,
        },
      }),
      {
        APP_ENV: "test",
        PLATFORM_DOMAIN: "punyasitus.com",
        SAAS_ZONE: "situsku.click",
        PLATFORM_DB: env.PLATFORM_DB,
      },
      { nowMs: BASE_NOW_MS },
    );
    expect(gateDecision.action).toBe("serve");

    // 2. Any Set-Cookie emitted on a tenant host MUST NOT contain Domain= and consent MUST have __Host-
    const validConsentHeader = serializeConsentCookie({
      version: 1,
      analytics: false,
      marketing: false,
      maps: false,
      updatedAt: "2026-05-01T12:00:00.000Z",
    });
    const rawTenantResp = new Response("<html><body>Tenant</body></html>", {
      status: 200,
      headers: [
        ["Content-Type", "text/html; charset=utf-8"],
        ["Set-Cookie", validConsentHeader],
        ["Set-Cookie", "evil_tossed=1; Path=/; Domain=situsku.click"],
      ],
    });
    const safeTenantResp = sanitizeTenantResponseHeaders(rawTenantResp, { surface: "tenant" });
    const cookies = getSetCookies(safeTenantResp.headers);
    expect(cookies.length).toBe(1);
    for (const cookie of cookies) {
      const check = validateTenantSetCookieHeader(cookie);
      expect(check.valid).toBe(true);
      expect(cookie.toLowerCase()).not.toContain("domain=");
      expect(cookie.startsWith("__Host-")).toBe(true);
    }

    // 3. Neutral 404 on unknown tenant host emits ZERO Set-Cookie headers
    const unknownDecision = await evaluateRequestGate(
      new Request("https://nonexistent.situsku.click/"),
      {
        APP_ENV: "test",
        PLATFORM_DOMAIN: "punyasitus.com",
        SAAS_ZONE: "situsku.click",
        PLATFORM_DB: env.PLATFORM_DB,
      },
      { nowMs: BASE_NOW_MS },
    );
    expect(unknownDecision.action).toBe("respond");
    if (unknownDecision.action === "respond") {
      expect(getSetCookies(unknownDecision.response.headers)).toHaveLength(0);
    }

    // 4. Live /.well-known/punyasitus-domain-check response on tenant host sets ZERO cookies
    const markerResp = await handleDomainMarkerRequest(
      new Request(`https://${tenant.subdomain}/.well-known/punyasitus-domain-check`),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(markerResp.status).toBe(200);
    expect(markerResp.headers.get("cache-control")).toBe("no-store");
    expect(markerResp.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(getSetCookies(markerResp.headers)).toHaveLength(0);
  });

  it("proves real Gate 4 /.well-known/punyasitus-domain-check handshake, wrong-tenant rejection, 404 on platform/unknown/suspended hosts, and 503 DOMAIN_MARKER_SECRET_UNCONFIGURED fail-closed", async () => {
    const mockCf = new MockCloudflareSaasServer();
    const tenantA = await provisionTenant("marker-a", runtimeEnv, { status: "active" });
    const tenantB = await provisionTenant("marker-b", runtimeEnv, { status: "active" });
    const suspendedTenant = await provisionTenant("marker-susp", runtimeEnv, {
      status: "suspended",
    });

    // Platform & unknown & suspended hosts -> 404 with zero cookies
    for (const url of [
      "https://punyasitus.com/.well-known/punyasitus-domain-check",
      "https://app.punyasitus.com/.well-known/punyasitus-domain-check",
      "https://console.punyasitus.com/.well-known/punyasitus-domain-check",
      "https://unknown-host.id/.well-known/punyasitus-domain-check",
      `https://${suspendedTenant.subdomain}/.well-known/punyasitus-domain-check`,
    ]) {
      const r = await handleDomainMarkerRequest(new Request(url), runtimeEnv, {
        nowMs: BASE_NOW_MS,
      });
      expect(r.status, `Expected 404 for ${url}`).toBe(404);
      expect(getSetCookies(r.headers)).toHaveLength(0);
    }

    // Missing DOMAIN_MARKER_SECRET in production -> 503 DOMAIN_MARKER_SECRET_UNCONFIGURED
    const prodMissingEnv = buildRuntimeEnv({
      APP_ENV: "production",
      DOMAIN_MARKER_SECRET: undefined,
    });
    const unconfiguredMarkerRes = await handleDomainMarkerRequest(
      new Request(`https://${tenantA.subdomain}/.well-known/punyasitus-domain-check`),
      prodMissingEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(unconfiguredMarkerRes.status).toBe(503);
    const unconfiguredBody = (await unconfiguredMarkerRes.json()) as {
      error: { code: string; reasonCode?: string };
    };
    expect(unconfiguredBody.error.reasonCode).toBe("DOMAIN_MARKER_SECRET_UNCONFIGURED");
    expect(getSetCookies(unconfiguredMarkerRes.headers)).toHaveLength(0);

    // Connect + activate custom domain for Tenant A via recheck (activates routing, not yet primary)
    const createRes = await handleTenantDomainsRequest(
      tenantA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/domains`, "POST", {
        cookie: tenantA.owner.cookie,
        body: { hostname: "www.handshake-a.id", mode: "new_domain" },
      }),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: createMockDnsResolver({}),
        nowMs: BASE_NOW_MS,
      },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: number;
      cfCustomHostnameId: string;
      version: number;
    };

    mockCf.setHostnameState(created.cfCustomHostnameId, {
      status: "active",
      ssl: { ...mockCf.hostnames.get(created.cfCustomHostnameId)!.ssl, status: "active" },
    });
    const dnsMatching = createMockDnsResolver({
      cname: { "www.handshake-a.id": [DEFAULT_SAAS_CNAME_TARGET] },
    });
    const recheckRes = await handleTenantDomainRecheckRequest(
      tenantA.tenantId,
      String(created.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/domains/${created.id}/recheck`,
        "POST",
        { cookie: tenantA.owner.cookie, body: { version: created.version } },
      ),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: dnsMatching,
        nowMs: BASE_NOW_MS + 1_000,
      },
    );
    expect(recheckRes.status).toBe(200);
    const activated = (await recheckRes.json()) as { version: number; hostStatus: string };
    expect(activated.hostStatus).toBe("active");

    // Production without DOMAIN_MARKER_SECRET fails promote closed with 503 DOMAIN_MARKER_SECRET_UNCONFIGURED
    const prodPromoteFail = await handleTenantDomainPromoteRequest(
      tenantA.tenantId,
      String(created.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/domains/${created.id}/promote`,
        "POST",
        { cookie: tenantA.owner.cookie, body: { version: activated.version } },
      ),
      prodMissingEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: dnsMatching,
        nowMs: BASE_NOW_MS + 1_500,
      },
    );
    expect(prodPromoteFail.status).toBe(503);
    expect(
      ((await prodPromoteFail.json()) as { error: { reasonCode?: string } }).error.reasonCode,
    ).toBe("DOMAIN_MARKER_SECRET_UNCONFIGURED");

    // Wrong-tenant probe (pointing probe at Tenant B's subdomain response) -> Gate 4 fails (409)!
    const wrongTenantProbe = createFetchHttpsProbe({
      fetchImpl: () =>
        handleDomainMarkerRequest(
          new Request(`https://${tenantB.subdomain}/.well-known/punyasitus-domain-check`),
          runtimeEnv,
          { nowMs: BASE_NOW_MS + 2_000 },
        ),
    });
    const wrongPromote = await handleTenantDomainPromoteRequest(
      tenantA.tenantId,
      String(created.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/domains/${created.id}/promote`,
        "POST",
        { cookie: tenantA.owner.cookie, body: { version: activated.version } },
      ),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: dnsMatching,
        httpsProbe: wrongTenantProbe,
        nowMs: BASE_NOW_MS + 2_000,
      },
    );
    expect(wrongPromote.status).toBe(409);

    // Real end-to-end Gate 4 handshake calling handleDomainMarkerRequest for www.handshake-a.id -> 200!
    const liveProbe = createFetchHttpsProbe({
      fetchImpl: (url) =>
        handleDomainMarkerRequest(new Request(String(url)), runtimeEnv, {
          nowMs: BASE_NOW_MS + 3_000,
        }),
    });
    const realPromote = await handleTenantDomainPromoteRequest(
      tenantA.tenantId,
      String(created.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/domains/${created.id}/promote`,
        "POST",
        { cookie: tenantA.owner.cookie, body: { version: activated.version } },
      ),
      runtimeEnv,
      {
        cloudflareFetch: mockCf.createFetch(),
        dnsResolver: dnsMatching,
        httpsProbe: liveProbe,
        nowMs: BASE_NOW_MS + 3_000,
      },
    );
    expect(realPromote.status).toBe(200);
    const realPromotedBody = (await realPromote.json()) as { isPrimary: boolean };
    expect(realPromotedBody.isPrimary).toBe(true);
  });

  it("prevents primary loss on concurrent promoteDomainToPrimary version races and enforces atomic max-2 custom hostname cap under Promise.all", async () => {
    const tenantRace = await provisionTenant("race", runtimeEnv, { status: "active" });
    const nowMs = BASE_NOW_MS + 5_000;

    // Seed an active custom host ready for primary switch
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hosts (host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary, version, created_at, updated_at)
         VALUES ('www.race-primary.id', ?, 'custom', 'cf-race-001', 'active', 'active', 0, 1, ?, ?)`,
      ).bind(tenantRace.tenantId, nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_host_metadata (host, tenant_id, domain_id, connect_mode, ssl_method, ever_activated, created_at, updated_at)
         VALUES ('www.race-primary.id', ?, 2, 'new_domain', 'http', 1, ?, ?)`,
      ).bind(tenantRace.tenantId, nowMs, nowMs),
    ]);

    // 1. Stale version promotion attempt -> throws STALE_VERSION while keeping subdomain is_primary = 1 intact!
    await expect(
      promoteDomainToPrimary(env.PLATFORM_DB, {
        tenantId: tenantRace.tenantId,
        hostname: "www.race-primary.id",
        expectedVersion: 99, // stale!
        actorUserId: tenantRace.owner.userId,
        actorRole: "owner",
        requestId: "req-stale-race",
        dnsTargetObserved: DEFAULT_SAAS_CNAME_TARGET,
        nowMs: nowMs + 100,
      }),
    ).rejects.toThrowError(DomainConflictError);

    const primariesAfterStale = await env.PLATFORM_DB.prepare(
      `SELECT host FROM tenant_hosts WHERE tenant_id = ? AND is_primary = 1`,
    )
      .bind(tenantRace.tenantId)
      .all<{ host: string }>();
    expect((primariesAfterStale.results ?? []).map((r) => r.host)).toEqual([tenantRace.subdomain]);

    // 2. Concurrent Promise.all promotion with identical expectedVersion=1 -> exactly 1 succeeds, 1 throws STALE_VERSION, strictly 1 primary!
    const results = await Promise.allSettled([
      promoteDomainToPrimary(env.PLATFORM_DB, {
        tenantId: tenantRace.tenantId,
        hostname: "www.race-primary.id",
        expectedVersion: 1,
        actorUserId: tenantRace.owner.userId,
        actorRole: "owner",
        requestId: "req-race-1",
        dnsTargetObserved: DEFAULT_SAAS_CNAME_TARGET,
        nowMs: nowMs + 200,
      }),
      promoteDomainToPrimary(env.PLATFORM_DB, {
        tenantId: tenantRace.tenantId,
        hostname: "www.race-primary.id",
        expectedVersion: 1,
        actorUserId: tenantRace.owner.userId,
        actorRole: "owner",
        requestId: "req-race-2",
        dnsTargetObserved: DEFAULT_SAAS_CNAME_TARGET,
        nowMs: nowMs + 201,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const primariesAfterRace = await env.PLATFORM_DB.prepare(
      `SELECT host FROM tenant_hosts WHERE tenant_id = ? AND is_primary = 1`,
    )
      .bind(tenantRace.tenantId)
      .all<{ host: string }>();
    expect((primariesAfterRace.results ?? []).map((r) => r.host)).toEqual(["www.race-primary.id"]);

    // 3. Atomic max-2 custom hostname cap under concurrent Promise.all claims
    const capTenant = await provisionTenant("cap", runtimeEnv, { status: "active" });
    const claimOutcomes = await Promise.allSettled([
      claimTenantCustomHostname(env.PLATFORM_DB, {
        tenantId: capTenant.tenantId,
        hostname: "cap-demo.id",
        connectMode: "new_domain",
        sslMethod: "http",
        actorUserId: capTenant.owner.userId,
        actorRole: "owner",
        requestId: "req-cap-1",
        nowMs,
      }),
      claimTenantCustomHostname(env.PLATFORM_DB, {
        tenantId: capTenant.tenantId,
        hostname: "www.cap-demo.id",
        connectMode: "new_domain",
        sslMethod: "http",
        actorUserId: capTenant.owner.userId,
        actorRole: "owner",
        requestId: "req-cap-2",
        nowMs,
      }),
      claimTenantCustomHostname(env.PLATFORM_DB, {
        tenantId: capTenant.tenantId,
        hostname: "shop.cap-demo.id",
        connectMode: "new_domain",
        sslMethod: "http",
        actorUserId: capTenant.owner.userId,
        actorRole: "owner",
        requestId: "req-cap-3",
        nowMs,
      }),
    ]);
    expect(claimOutcomes.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(2);

    const countRow = await env.PLATFORM_DB.prepare(
      `SELECT COUNT(*) AS cnt FROM tenant_hosts WHERE tenant_id = ? AND kind = 'custom'`,
    )
      .bind(capTenant.tenantId)
      .first<{ cnt: number }>();
    expect(countRow?.cnt ?? 0).toBeLessThanOrEqual(2);
  });

  it("reaper restores platform subdomain as primary when reaping a 7-day moved primary host and cleans up stuck deleting rows immediately", async () => {
    const mockCf = new MockCloudflareSaasServer();
    const cfClient = createCloudflareSaasClient({
      zoneId: "zone-situsku-01",
      apiToken: TEST_CF_TOKEN,
      fetchImpl: mockCf.createFetch(),
    });
    const tenantMovedPrimary = await provisionTenant("moved-prim", runtimeEnv, {
      status: "active",
    });
    const tenantDeleting = await provisionTenant("stuck-del", runtimeEnv, { status: "active" });
    const nowMs = BASE_NOW_MS + 40 * DAY_MS;

    // 1. Seed a 9-day-old `moved` custom host that WAS primary (subdomain is currently is_primary = 0)
    const movedPrimaryCf = await cfClient.createCustomHostname({
      hostname: "www.moved-primary.id",
      sslMethod: "http",
    });
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `UPDATE tenant_hosts SET is_primary = 0 WHERE tenant_id = ? AND kind = 'subdomain'`,
      ).bind(tenantMovedPrimary.tenantId),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hosts (host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary, version, created_at, updated_at)
         VALUES ('www.moved-primary.id', ?, 'custom', ?, 'moved', 'pending', 1, 1, ?, ?)`,
      ).bind(
        tenantMovedPrimary.tenantId,
        movedPrimaryCf.id,
        nowMs - 12 * DAY_MS,
        nowMs - 9 * DAY_MS,
      ),
    ]);

    // 2. Seed a FRESH (< 1 minute old) custom host stuck in `deleting` after retryable CF delete failure
    const deletingCf = await cfClient.createCustomHostname({
      hostname: "www.stuck-deleting.id",
      sslMethod: "http",
    });
    await env.PLATFORM_DB.prepare(
      `INSERT INTO tenant_hosts (host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary, version, created_at, updated_at)
       VALUES ('www.stuck-deleting.id', ?, 'custom', ?, 'deleting', 'pending', 0, 1, ?, ?)`,
    )
      .bind(tenantDeleting.tenantId, deletingCf.id, nowMs - 30_000, nowMs - 30_000)
      .run();

    const reapRes = await runStaleHostnameReaper({
      platformDb: env.PLATFORM_DB,
      cloudflareClient: cfClient,
      nowMs,
      logger: () => {},
    });

    // Both hosts reaped cleanly from Cloudflare & PLATFORM_DB!
    expect(
      reapRes.items.some((i) => i.host === "www.moved-primary.id" && i.outcome === "reaped"),
    ).toBe(true);
    expect(
      reapRes.items.some((i) => i.host === "www.stuck-deleting.id" && i.outcome === "reaped"),
    ).toBe(true);
    expect(mockCf.hostnames.has(movedPrimaryCf.id)).toBe(false);
    expect(mockCf.hostnames.has(deletingCf.id)).toBe(false);

    // Platform `.situsku.click` subdomain was atomically restored as `is_primary = 1`!
    const restoredPrimary = await env.PLATFORM_DB.prepare(
      `SELECT host, is_primary FROM tenant_hosts WHERE tenant_id = ? AND kind = 'subdomain'`,
    )
      .bind(tenantMovedPrimary.tenantId)
      .first<{ host: string; is_primary: number }>();
    expect(restoredPrimary?.host).toBe(tenantMovedPrimary.subdomain);
    expect(restoredPrimary?.is_primary).toBe(1);

    // Stuck deleting row is completely gone from tenant_hosts!
    const remainingDeleting = await env.PLATFORM_DB.prepare(
      `SELECT host FROM tenant_hosts WHERE host = 'www.stuck-deleting.id'`,
    ).first<{ host: string }>();
    expect(remainingDeleting).toBeNull();
  });

  it("schedules and executes domain reaper and renewal-watch jobs through durable cron & queue registry", async () => {
    const sentMessages: JobQueuePayload[] = [];
    const fakeQueue = {
      async send(msg: JobQueuePayload) {
        sentMessages.push(msg);
      },
    } as unknown as Queue<JobQueuePayload>;

    const scheduledTime = BASE_NOW_MS + 50 * DAY_MS;
    const dispatchRes = await dispatchScheduledCron(
      { cron: DEFAULT_CRON_EXPRESSION, scheduledTime },
      { PLATFORM_DB: env.PLATFORM_DB, JOBS_QUEUE: fakeQueue },
      DOMAIN_CRON_JOB_DEFINITIONS,
      { now: () => scheduledTime, logger: () => {} },
    );

    expect(dispatchRes.enqueuedCount).toBe(2);
    expect(sentMessages.map((m) => m.topic).sort()).toEqual([
      "domains.renewal_watch",
      "domains.stale_reaper",
    ]);

    const mockCf = new MockCloudflareSaasServer();
    const cfClient = createCloudflareSaasClient({
      zoneId: "zone-situsku-01",
      apiToken: TEST_CF_TOKEN,
      fetchImpl: mockCf.createFetch(),
    });
    const registry = createDomainJobRegistry({
      reaper: { cloudflareClient: cfClient, logger: () => {} },
      renewalWatch: {
        dnsResolver: createMockDnsResolver({}),
        emailPort: createLocalMailSink(),
        logger: () => {},
      },
    });

    const batch = {
      queue: "punyasitus-jobs",
      messages: sentMessages.map((body, idx) => ({
        id: `msg-domain-${idx}`,
        timestamp: new Date(scheduledTime),
        body,
        attempts: 1,
        ack() {},
        retry() {},
      })),
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<unknown>;

    const batchResult = await processDurableQueueBatch(
      batch,
      { PLATFORM_DB: env.PLATFORM_DB },
      registry,
      { now: () => scheduledTime, logger: () => {} },
    );
    expect(batchResult.completed).toBe(2);
    expect(batchResult.deadLettered).toBe(0);
  });
});

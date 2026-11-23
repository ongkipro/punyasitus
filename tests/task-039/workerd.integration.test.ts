import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  DAY_MS,
  DEFAULT_SAAS_CNAME_TARGET,
  DomainProviderError,
  type CloudflareCustomHostname,
  type CloudflareSaasClient,
  type DnsResolverPort,
  type HttpsProbePort,
} from "@punyasitus/core/domains/index";
import { applyPlatformMigrations, createSqliteDrizzle } from "@punyasitus/db/connections";
import { ensureDomainMetadataSchema } from "@punyasitus/db/domains/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
} from "@punyasitus/db/platform";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateRequestGate } from "../../apps/web/src/core/tenant.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantDomainDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/domains/[domainId].ts";
import { handleTenantDomainPromoteRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/domains/[domainId]/promote.ts";
import { handleTenantDomainRecheckRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/domains/[domainId]/recheck.ts";
import type { TenantDomainsRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/domains/_shared.ts";
import { handleTenantDomainsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/domains/index.ts";
import { loadDomainsSettingsPage } from "../../apps/web/src/pages/dashboard/[handle]/settings/domains/_loader.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-t039-0123456789abcdef0123456789ab";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-t039-fedcba9876543210fedcba98";
const TEST_MARKER_SECRET = "test-domain-marker-secret-t039-0123456789abcdef";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 3, 0, 0);

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
    CF_SAAS_ZONE_ID: "zone-t039-01",
    CF_SAAS_API_TOKEN: "cf_t039_token_secret_never_logged",
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
    readonly idempotencyKey?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
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

let seqCounter = 1;

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
  status: "trial" | "active" | "grace" | "locked" | "suspended" | "recovery" | "purging" | "purged" = "active",
): Promise<TenantFixture> {
  const seq = String(seqCounter++).padStart(4, "0");
  const tenantId = `01JT039DMN000000000000${seq}`;
  const orgId = `01JT039ORG000000000000${seq}`;
  const handle = `t039-${tag}-${seq}`;
  const subdomain = `${handle}.situsku.click`;
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(BASE_NOW_MS);

  const owner = await signUpUser(`owner-${tag}-${seq}@t039.test`, `Owner ${tag}`, runtimeEnv);
  const admin = await signUpUser(`admin-${tag}-${seq}@t039.test`, `Admin ${tag}`, runtimeEnv);
  const editor = await signUpUser(`editor-${tag}-${seq}@t039.test`, `Editor ${tag}`, runtimeEnv);

  await db.insert(organizations).values({
    id: orgId,
    name: `Org ${tag} ${seq}`,
    slug: `org-${handle}`,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(members).values([
    { id: `t39-own-${seq}`, organizationId: orgId, userId: owner.userId, role: "owner", createdAt: now },
    { id: `t39-adm-${seq}`, organizationId: orgId, userId: admin.userId, role: "admin", createdAt: now },
    { id: `t39-edt-${seq}`, organizationId: orgId, userId: editor.userId, role: "editor", createdAt: now },
  ]);

  await db.insert(tenants).values({
    id: tenantId,
    organizationId: orgId,
    handle,
    name: `Bisnis ${tag} ${seq}`,
    vertical: "compro",
    status,
    trialEndsAt: status === "trial" ? new Date(BASE_NOW_MS + 7 * DAY_MS) : null,
    paidThrough: status === "active" || status === "grace" ? new Date(BASE_NOW_MS + 30 * DAY_MS) : null,
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
    cfCustomHostnameId: null,
    status: "active",
    sslStatus: "active",
    isPrimary: true,
    verifiedAt: now,
    lastCheckedAt: now,
    quarantinedUntil: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });

  return { tenantId, handle, subdomain, orgId, owner, admin, editor };
}

let cfIdSeq = 1;

class InMemoryCloudflareMock {
  readonly records = new Map<string, CloudflareCustomHostname>();
  readonly calls: Array<{ method: string; target: string }> = [];
  failNextDeleteRetryable = false;
  failNextCreateNonRetryable = false;

  createClient(): CloudflareSaasClient {
    return {
      createCustomHostname: async (input) => {
        this.calls.push({ method: "POST", target: input.hostname });
        if (this.failNextCreateNonRetryable) {
          this.failNextCreateNonRetryable = false;
          throw new DomainProviderError(
            "bad_request",
            "Cloudflare rejected custom hostname quota/validation",
            { statusCode: 400, retryable: false },
          );
        }
        const id = `cf-t039-${cfIdSeq++}`;
        const rec: CloudflareCustomHostname = {
          id,
          hostname: input.hostname,
          status: "pending",
          ownership_verification: {
            type: "txt",
            name: `_cf-custom-hostname.${input.hostname}`,
            value: `cf-owner-${id}`,
          },
          ssl: {
            id: `ssl-${id}`,
            status: "pending_validation",
            method: input.sslMethod,
            type: "dv",
            certificate_authority: "lets_encrypt",
            dcv_delegation_records:
              input.sslMethod === "txt"
                ? [
                    {
                      cname: `_acme-challenge.${input.hostname}`,
                      cname_target: `${input.hostname}.dcv-delegate.situsku.click`,
                    },
                  ]
                : undefined,
            settings: { min_tls_version: input.minTlsVersion ?? "1.2" },
          },
        };
        this.records.set(id, rec);
        return rec;
      },
      getCustomHostname: async (id) => {
        this.calls.push({ method: "GET", target: id });
        const rec = this.records.get(id);
        if (!rec) {
          throw new DomainProviderError("not_found", "Not found", { statusCode: 404 });
        }
        return rec;
      },
      findCustomHostnameByName: async (hostname) => {
        this.calls.push({ method: "FIND", target: hostname });
        for (const rec of this.records.values()) {
          if (rec.hostname === hostname) return rec;
        }
        return null;
      },
      patchCustomHostnameSsl: async (id, ssl) => {
        this.calls.push({ method: "PATCH", target: id });
        const existing = this.records.get(id);
        if (!existing) {
          throw new DomainProviderError("not_found", "Not found", { statusCode: 404 });
        }
        const updated: CloudflareCustomHostname = {
          ...existing,
          ssl: { ...existing.ssl, method: ssl.method },
        };
        this.records.set(id, updated);
        return updated;
      },
      deleteCustomHostname: async (id) => {
        this.calls.push({ method: "DELETE", target: id });
        if (this.failNextDeleteRetryable) {
          this.failNextDeleteRetryable = false;
          throw new DomainProviderError("timeout", "Upstream timeout during delete", {
            retryable: true,
          });
        }
        const existed = this.records.delete(id);
        return { id, deleted: true, alreadyAbsent: !existed };
      },
      getCustomHostnameQuota: async () => ({ allocated: 100, used: this.records.size }),
    };
  }

  setState(
    hostname: string,
    patch: { status?: string; sslStatus?: string; verificationErrors?: string[] },
  ): void {
    for (const [id, rec] of this.records.entries()) {
      if (rec.hostname === hostname) {
        this.records.set(id, {
          ...rec,
          status: patch.status ?? rec.status,
          ...(patch.verificationErrors ? { verification_errors: patch.verificationErrors } : {}),
          ssl: {
            ...rec.ssl,
            status: patch.sslStatus ?? rec.ssl.status,
          },
        });
      }
    }
  }
}

function makeDnsStub(config: {
  cnames?: Record<string, string[]>;
  txts?: Record<string, string[]>;
  ns?: Record<string, string[]>;
} = {}): DnsResolverPort {
  return {
    resolveCname: async (h) => config.cnames?.[h] ?? [],
    resolveTxt: async (h) => config.txts?.[h] ?? [],
    resolveCaa: async () => [],
    resolveNs: async (h) => config.ns?.[h] ?? [],
  };
}

function makePassingHttpsProbe(tenantId: string): HttpsProbePort {
  return {
    probeTenantMarker: async (input) => ({
      ok: true,
      statusCode: 200,
      observedTenantId: tenantId,
      markerMatched: input.expectedTenantId === tenantId,
      errorCode: null,
    }),
  };
}

describe("TASK-039 workerd integration — custom domain connect, 2-hostname counterpart, lock, primary switch & removal", () => {
  const runtimeEnv = buildRuntimeEnv();

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await ensureDomainMetadataSchema(env.PLATFORM_DB);
    clearHostResolutionCache();
  });

  it("enforces RBAC (editor 403, admin read-only, cross-tenant neutral 404), trial block (DEC-035 C4), and locked-tenant block", async () => {
    const cf = new InMemoryCloudflareMock();
    const paidA = await provisionTenant("rbac-a", runtimeEnv, "active");
    const paidB = await provisionTenant("rbac-b", runtimeEnv, "active");
    const trialTenant = await provisionTenant("trial", runtimeEnv, "trial");
    const lockedTenant = await provisionTenant("locked", runtimeEnv, "locked");

    // 1. Editor blocked on GET (403) and POST (403)
    const editorGet = await handleTenantDomainsRequest(
      paidA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidA.tenantId}/domains`, "GET", {
        cookie: paidA.editor.cookie,
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    expect(editorGet.status).toBe(403);

    const editorPost = await handleTenantDomainsRequest(
      paidA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidA.tenantId}/domains`, "POST", {
        cookie: paidA.editor.cookie,
        body: { hostname: "www.editor-blocked.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    expect(editorPost.status).toBe(403);

    // 2. Admin can GET (200) but cannot POST (403)
    const adminGet = await handleTenantDomainsRequest(
      paidA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidA.tenantId}/domains`, "GET", {
        cookie: paidA.admin.cookie,
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    expect(adminGet.status).toBe(200);

    const adminPost = await handleTenantDomainsRequest(
      paidA.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidA.tenantId}/domains`, "POST", {
        cookie: paidA.admin.cookie,
        body: { hostname: "www.admin-blocked.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    expect(adminPost.status).toBe(403);

    // 3. Cross-tenant owner gets neutral 404
    const crossTenantGet = await handleTenantDomainsRequest(
      paidB.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${paidB.tenantId}/domains`, "GET", {
        cookie: paidA.owner.cookie,
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    expect(crossTenantGet.status).toBe(404);

    // 4. Trial tenant blocked on connect (DEC-035 C4 -> 403 TRIAL_DOMAIN_FORBIDDEN)
    const trialPost = await handleTenantDomainsRequest(
      trialTenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${trialTenant.tenantId}/domains`, "POST", {
        cookie: trialTenant.owner.cookie,
        body: { hostname: "www.trial-denied.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    expect(trialPost.status).toBe(403);
    expect(((await trialPost.json()) as { error: { code: string } }).error.code).toBe(
      "TRIAL_DOMAIN_FORBIDDEN",
    );

    // 5. Locked tenant allowed GET (200) but blocked on connect (403 SUBSCRIPTION_LOCKED)
    const lockedGet = await handleTenantDomainsRequest(
      lockedTenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${lockedTenant.tenantId}/domains`, "GET", {
        cookie: lockedTenant.owner.cookie,
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    expect(lockedGet.status).toBe(200);

    const lockedPost = await handleTenantDomainsRequest(
      lockedTenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${lockedTenant.tenantId}/domains`, "POST", {
        cookie: lockedTenant.owner.cookie,
        body: { hostname: "www.locked-denied.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    expect(lockedPost.status).toBe(403);
    expect(((await lockedPost.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );
  });

  it("blocks unsupported apex capability cleanly without claiming locally or calling Cloudflare", async () => {
    const cf = new InMemoryCloudflareMock();
    const tenant = await provisionTenant("apex-cap", runtimeEnv, "active");

    const res = await handleTenantDomainsRequest(
      tenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains`, "POST", {
        cookie: tenant.owner.cookie,
        body: {
          hostname: "kopinusantara.id",
          mode: "new_domain",
          confirmApexFlattening: true,
        },
      }),
      runtimeEnv,
      {
        cloudflareClient: cf.createClient(),
        dnsResolver: makeDnsStub(),
        apexCapabilitySupported: false,
        nowMs: BASE_NOW_MS,
      },
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; reasonCode: string };
      suggestedWwwHostname: string;
    };
    expect(body.error.reasonCode).toBe("APEX_UNSUPPORTED_CAPABILITY");
    expect(body.suggestedWwwHostname).toBe("www.kopinusantara.id");
    expect(cf.calls).toHaveLength(0);
  });

  it("enforces two-tenant concurrent claim race so ONLY one tenant claims the hostname", async () => {
    const cf = new InMemoryCloudflareMock();
    const tenantA = await provisionTenant("race-a", runtimeEnv, "active");
    const tenantB = await provisionTenant("race-b", runtimeEnv, "active");

    const [resA, resB] = await Promise.all([
      handleTenantDomainsRequest(
        tenantA.tenantId,
        makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/domains`, "POST", {
          cookie: tenantA.owner.cookie,
          body: { hostname: "www.rebutan-domain.id", mode: "new_domain" },
        }),
        runtimeEnv,
        { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
      ),
      handleTenantDomainsRequest(
        tenantB.tenantId,
        makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenantB.tenantId}/domains`, "POST", {
          cookie: tenantB.owner.cookie,
          body: { hostname: "www.rebutan-domain.id", mode: "new_domain" },
        }),
        runtimeEnv,
        { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
      ),
    ]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const loserRes = resA.status === 409 ? resA : resB;
    const loserBody = (await loserRes.json()) as {
      error: { reasonCode: string; message: string };
    };
    expect(loserBody.error.reasonCode).toBe("DOMAIN_ALREADY_CLAIMED");
    expect(loserBody.error.message).not.toContain(tenantA.tenantId);
    expect(loserBody.error.message).not.toContain(tenantB.tenantId);
  });

  it("handles two-step migration gating, independent ownership/TLS status, pre-activation idempotent removal, post-activation lock, 2-hostname counterpart add, atomic primary switch & 301 alias redirect", async () => {
    const cf = new InMemoryCloudflareMock();
    const tenant = await provisionTenant("full-flow", runtimeEnv, "active");

    // 1. Connect a typo domain and verify owner removal BEFORE activation with retryable timeout -> idempotent retry -> 204!
    const typoRes = await handleTenantDomainsRequest(
      tenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains`, "POST", {
        cookie: tenant.owner.cookie,
        body: { hostname: "www.typo-sementara.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    expect(typoRes.status).toBe(201);
    const typoDom = (await typoRes.json()) as { id: number; version: number };

    // Simulate Cloudflare timeout on first delete -> 202 cleanupPending (routing disabled, claim retained!)
    cf.failNextDeleteRetryable = true;
    const delTimeout = await handleTenantDomainDetailRequest(
      tenant.tenantId,
      String(typoDom.id),
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${typoDom.id}`, "DELETE", {
        cookie: tenant.owner.cookie,
        body: { confirmHostname: "www.typo-sementara.id", version: typoDom.version },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS + 1000 },
    );
    expect(delTimeout.status).toBe(202);
    const delTimeoutBody = (await delTimeout.json()) as { cleanupPending: boolean };
    expect(delTimeoutBody.cleanupPending).toBe(true);

    // Retry delete with updated version -> idempotent cleanup succeeds with 204!
    const delFinal = await handleTenantDomainDetailRequest(
      tenant.tenantId,
      String(typoDom.id),
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${typoDom.id}`, "DELETE", {
        cookie: tenant.owner.cookie,
        body: { confirmHostname: "www.typo-sementara.id", version: typoDom.version + 1 },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS + 2000 },
    );
    expect(delFinal.status).toBe(204);

    // 2. Connect www.karyaabadi.id in Two-Step Zero-Downtime Migration mode
    const connectWww = await handleTenantDomainsRequest(
      tenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains`, "POST", {
        cookie: tenant.owner.cookie,
        body: { hostname: "www.karyaabadi.id", mode: "zero_downtime_migration" },
      }),
      runtimeEnv,
      {
        cloudflareClient: cf.createClient(),
        dnsResolver: makeDnsStub({ ns: { "karyaabadi.id": ["ara.ns.cloudflare.com"] } }),
        nowMs: BASE_NOW_MS + 3000,
      },
    );
    expect(connectWww.status).toBe(201);
    const wwwInitial = (await connectWww.json()) as {
      id: number;
      version: number;
      ownershipStatus: string;
      tlsStatus: string;
      cloudflareNameserverHint: boolean;
      postActivationCleanup: unknown;
      instructions: { cnameCutoverLocked: boolean };
      validationRecords: Array<{ purpose: string; recordType: string }>;
    };
    expect(wwwInitial.ownershipStatus).toBe("pending");
    expect(wwwInitial.tlsStatus).toBe("pending");
    expect(wwwInitial.cloudflareNameserverHint).toBe(true);
    expect(wwwInitial.instructions.cnameCutoverLocked).toBe(true);
    expect(wwwInitial.validationRecords.some((r) => r.purpose === "routing")).toBe(false);
    // CRITICAL: postActivationCleanup MUST be null before activation so routing CNAME never leaks early!
    expect(wwwInitial.postActivationCleanup).toBeNull();

    // 3. Stale version on recheck -> 409 STALE_VERSION
    const staleRecheck = await handleTenantDomainRecheckRequest(
      tenant.tenantId,
      String(wwwInitial.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${wwwInitial.id}/recheck`,
        "POST",
        { cookie: tenant.owner.cookie, body: { version: 999 } },
      ),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS + 4000 },
    );
    expect(staleRecheck.status).toBe(409);
    expect(((await staleRecheck.json()) as { error: { code: string } }).error.code).toBe(
      "STALE_VERSION",
    );

    // 4. Recheck when ONLY ownership is active (TLS still pending) -> STILL locked (no false success!)
    cf.setState("www.karyaabadi.id", { status: "active", sslStatus: "pending_validation" });
    const partialRecheck = await handleTenantDomainRecheckRequest(
      tenant.tenantId,
      String(wwwInitial.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${wwwInitial.id}/recheck`,
        "POST",
        { cookie: tenant.owner.cookie, body: { version: wwwInitial.version } },
      ),
      runtimeEnv,
      {
        cloudflareClient: cf.createClient(),
        dnsResolver: makeDnsStub(),
        recheckRateLimitPolicy: { perDomainLimit: 10, perTenantLimit: 20 },
        nowMs: BASE_NOW_MS + 5000,
      },
    );
    expect(partialRecheck.status).toBe(200);
    const wwwPartial = (await partialRecheck.json()) as {
      version: number;
      ownershipStatus: string;
      tlsStatus: string;
      instructions: { cnameCutoverLocked: boolean };
      validationRecords: Array<{ purpose: string }>;
    };
    expect(wwwPartial.ownershipStatus).toBe("active");
    expect(wwwPartial.tlsStatus).toBe("pending");
    expect(wwwPartial.instructions.cnameCutoverLocked).toBe(true);
    expect(wwwPartial.validationRecords.some((r) => r.purpose === "routing")).toBe(false);

    // 5. Recheck when BOTH ownership AND TLS are active + CNAME pointed -> activates & locks!
    cf.setState("www.karyaabadi.id", { status: "active", sslStatus: "active" });
    const activeRecheck = await handleTenantDomainRecheckRequest(
      tenant.tenantId,
      String(wwwInitial.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${wwwInitial.id}/recheck`,
        "POST",
        { cookie: tenant.owner.cookie, body: { version: wwwPartial.version } },
      ),
      runtimeEnv,
      {
        cloudflareClient: cf.createClient(),
        dnsResolver: makeDnsStub({
          cnames: { "www.karyaabadi.id": [DEFAULT_SAAS_CNAME_TARGET] },
        }),
        recheckRateLimitPolicy: { perDomainLimit: 10, perTenantLimit: 20 },
        nowMs: BASE_NOW_MS + 6000,
      },
    );
    expect(activeRecheck.status).toBe(200);
    const wwwActive = (await activeRecheck.json()) as {
      id: number;
      version: number;
      status: string;
      isLocked: boolean;
      ownershipStatus: string;
      tlsStatus: string;
      instructions: { cnameCutoverLocked: boolean };
      postActivationCleanup: {
        removable: Array<{ purpose: string }>;
        mustKeep: Array<{ purpose: string }>;
      };
    };
    expect(wwwActive.status).toBe("active");
    expect(wwwActive.ownershipStatus).toBe("active");
    expect(wwwActive.tlsStatus).toBe("active");
    expect(wwwActive.isLocked).toBe(true);
    expect(wwwActive.instructions.cnameCutoverLocked).toBe(false);
    expect(wwwActive.postActivationCleanup.removable.some((r) => r.purpose === "ownership")).toBe(true);
    expect(wwwActive.postActivationCleanup.mustKeep.some((r) => r.purpose === "ssl_dcv")).toBe(true);
    expect(wwwActive.postActivationCleanup.mustKeep.some((r) => r.purpose === "routing")).toBe(true);

    // 6. Owner removal AFTER activation FAILS with 403 DOMAIN_LOCKED!
    const lockedDelete = await handleTenantDomainDetailRequest(
      tenant.tenantId,
      String(wwwActive.id),
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${wwwActive.id}`, "DELETE", {
        cookie: tenant.owner.cookie,
        body: { confirmHostname: "www.karyaabadi.id", version: wwwActive.version },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS + 7000 },
    );
    expect(lockedDelete.status).toBe(403);
    expect(((await lockedDelete.json()) as { error: { code: string } }).error.code).toBe(
      "DOMAIN_LOCKED",
    );

    // 7. Unrelated 2nd custom domain REJECTED (DOMAIN_SET_MISMATCH)
    const unrelatedRes = await handleTenantDomainsRequest(
      tenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains`, "POST", {
        cookie: tenant.owner.cookie,
        body: { hostname: "www.usaha-lain.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS + 8000 },
    );
    expect(unrelatedRes.status).toBe(409);
    expect(((await unrelatedRes.json()) as { error: { reasonCode: string } }).error.reasonCode).toBe(
      "DOMAIN_SET_MISMATCH",
    );

    // 8. Counterpart add (`karyaabadi.id`) STILL SUCCEEDS while locked!
    const apexRes = await handleTenantDomainsRequest(
      tenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains`, "POST", {
        cookie: tenant.owner.cookie,
        body: {
          hostname: "karyaabadi.id",
          mode: "new_domain",
          confirmApexFlattening: true,
        },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS + 9000 },
    );
    expect(apexRes.status).toBe(201);
    const apexDom = (await apexRes.json()) as { id: number; version: number };

    // 9. 3rd custom hostname REJECTED (DOMAIN_LIMIT_REACHED)
    const thirdRes = await handleTenantDomainsRequest(
      tenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains`, "POST", {
        cookie: tenant.owner.cookie,
        body: { hostname: "blog.karyaabadi.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS + 10000 },
    );
    expect(thirdRes.status).toBe(409);
    expect(((await thirdRes.json()) as { error: { reasonCode: string } }).error.reasonCode).toBe(
      "DOMAIN_LIMIT_REACHED",
    );

    // 10. Promote www.karyaabadi.id to primary while locked -> succeeds!
    const promoWww = await handleTenantDomainPromoteRequest(
      tenant.tenantId,
      String(wwwActive.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${wwwActive.id}/make-primary`,
        "POST",
        { cookie: tenant.owner.cookie, body: { version: wwwActive.version } },
      ),
      runtimeEnv,
      {
        cloudflareClient: cf.createClient(),
        dnsResolver: makeDnsStub({
          cnames: { "www.karyaabadi.id": [DEFAULT_SAAS_CNAME_TARGET] },
        }),
        httpsProbe: makePassingHttpsProbe(tenant.tenantId),
        nowMs: BASE_NOW_MS + 11000,
      },
    );
    expect(promoWww.status).toBe(200);

    // Activate apex counterpart and switch primary atomically from www.karyaabadi.id -> karyaabadi.id!
    cf.setState("karyaabadi.id", { status: "active", sslStatus: "active" });
    const apexRecheck = await handleTenantDomainRecheckRequest(
      tenant.tenantId,
      String(apexDom.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${apexDom.id}/recheck`,
        "POST",
        { cookie: tenant.owner.cookie, body: { version: apexDom.version } },
      ),
      runtimeEnv,
      {
        cloudflareClient: cf.createClient(),
        dnsResolver: makeDnsStub({
          cnames: { "karyaabadi.id": [DEFAULT_SAAS_CNAME_TARGET] },
        }),
        recheckRateLimitPolicy: { perDomainLimit: 10, perTenantLimit: 20 },
        nowMs: BASE_NOW_MS + 12000,
      },
    );
    expect(apexRecheck.status).toBe(200);
    const apexActive = (await apexRecheck.json()) as { id: number; version: number };

    const promoApex = await handleTenantDomainPromoteRequest(
      tenant.tenantId,
      String(apexActive.id),
      makeApiRequest(
        `${APP_ORIGIN}/api/tenants/${tenant.tenantId}/domains/${apexActive.id}/make-primary`,
        "POST",
        { cookie: tenant.owner.cookie, body: { version: apexActive.version } },
      ),
      runtimeEnv,
      {
        cloudflareClient: cf.createClient(),
        dnsResolver: makeDnsStub({
          cnames: { "karyaabadi.id": [DEFAULT_SAAS_CNAME_TARGET] },
        }),
        httpsProbe: makePassingHttpsProbe(tenant.tenantId),
        nowMs: BASE_NOW_MS + 13000,
      },
    );
    expect(promoApex.status).toBe(200);
    const promotedApexBody = (await promoApex.json()) as { isPrimary: boolean; hostname: string };
    expect(promotedApexBody.isPrimary).toBe(true);
    expect(promotedApexBody.hostname).toBe("karyaabadi.id");

    // 11. Verify verified alias (`www.karyaabadi.id`) redirects 301 to primary (`karyaabadi.id`) preserving path + query!
    clearHostResolutionCache();
    const aliasGate = await evaluateRequestGate(
      new Request("https://www.karyaabadi.id/produk?utm_source=ig", { method: "GET" }),
      {
        PLATFORM_DOMAIN: "punyasitus.com",
        SAAS_ZONE: "situsku.click",
        PLATFORM_DB: env.PLATFORM_DB,
      },
      { nowMs: BASE_NOW_MS + 14000, bypassHostCache: true },
    );
    expect(aliasGate.action).toBe("respond");
    if (aliasGate.action === "respond") {
      expect(aliasGate.response.status).toBe(301);
      expect(aliasGate.response.headers.get("Location")).toBe(
        "https://karyaabadi.id/produk?utm_source=ig",
      );
    }
  });

  it("gates settings/domains page loader on suspended/recovery/purging/purged BEFORE any domain DB read so zero tokens leak", async () => {
    const cf = new InMemoryCloudflareMock();
    const suspended = await provisionTenant("loader-susp", runtimeEnv, "suspended");
    const recovery = await provisionTenant("loader-rec", runtimeEnv, "recovery");
    const purged = await provisionTenant("loader-purg", runtimeEnv, "purged");
    const active = await provisionTenant("loader-act", runtimeEnv, "active");

    // Seed an active domain with provider tokens on the suspended tenant directly in DB to prove zero leakage
    await env.PLATFORM_DB.prepare(
      `INSERT INTO tenant_hosts (
         host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status,
         is_primary, verified_at, last_checked_at, quarantined_until, version, created_at, updated_at
       ) VALUES (?, ?, 'custom', ?, 'pending', 'pending', 0, NULL, NULL, NULL, 1, ?, ?)`,
    )
      .bind("www.secret-suspended.id", suspended.tenantId, "cf-secret-susp-01", BASE_NOW_MS, BASE_NOW_MS)
      .run();

    const suspRes = await loadDomainsSettingsPage({
      rawHandle: suspended.handle,
      surface: "app",
      isLocalLoopback: false,
      platformDb: env.PLATFORM_DB,
      authUser: { id: suspended.owner.userId, name: "Owner Suspended" },
      nowMs: BASE_NOW_MS,
    });
    expect(suspRes).toEqual({
      kind: "redirect",
      location: `/dashboard/${suspended.handle}/service-status`,
    });

    const recRes = await loadDomainsSettingsPage({
      rawHandle: recovery.handle,
      surface: "app",
      isLocalLoopback: false,
      platformDb: env.PLATFORM_DB,
      authUser: { id: recovery.owner.userId, name: "Owner Recovery" },
      nowMs: BASE_NOW_MS,
    });
    expect(recRes).toEqual({
      kind: "redirect",
      location: `/dashboard/${recovery.handle}/service-status`,
    });

    const purgedRes = await loadDomainsSettingsPage({
      rawHandle: purged.handle,
      surface: "app",
      isLocalLoopback: false,
      platformDb: env.PLATFORM_DB,
      authUser: { id: purged.owner.userId, name: "Owner Purged" },
      nowMs: BASE_NOW_MS,
    });
    expect(purgedRes).toEqual({ kind: "not_found" });

    // Editor on active tenant gets 403 render with ZERO domain records loaded
    const connectRes = await handleTenantDomainsRequest(
      active.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${active.tenantId}/domains`, "POST", {
        cookie: active.owner.cookie,
        body: { hostname: "www.editor-secret.id", mode: "zero_downtime_migration" },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    expect(connectRes.status).toBe(201);

    const editorPage = await loadDomainsSettingsPage({
      rawHandle: active.handle,
      surface: "app",
      isLocalLoopback: false,
      platformDb: env.PLATFORM_DB,
      authUser: { id: active.editor.userId, name: "Editor" },
      nowMs: BASE_NOW_MS,
    });
    expect(editorPage.kind).toBe("render");
    if (editorPage.kind === "render") {
      expect(editorPage.httpStatus).toBe(403);
      expect(editorPage.canReadDomains).toBe(false);
      expect(editorPage.initialItems).toHaveLength(0);
    }
  });

  it("handles Indonesian multi-label apex (.co.id), rolls back non-retryable provider rejections, and prevents same-tenant unrelated domain races atomically", async () => {
    const cf = new InMemoryCloudflareMock();
    const coIdTenant = await provisionTenant("coid", runtimeEnv, "active");

    // 1. bisnis.co.id rejected under unsupported apex capability (suggests www.bisnis.co.id)
    const unsupCoId = await handleTenantDomainsRequest(
      coIdTenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${coIdTenant.tenantId}/domains`, "POST", {
        cookie: coIdTenant.owner.cookie,
        body: { hostname: "bisnis.co.id", mode: "new_domain", confirmApexFlattening: true },
      }),
      runtimeEnv,
      {
        cloudflareClient: cf.createClient(),
        dnsResolver: makeDnsStub(),
        apexCapabilitySupported: false,
        nowMs: BASE_NOW_MS,
      },
    );
    expect(unsupCoId.status).toBe(422);
    const unsupBody = (await unsupCoId.json()) as {
      error: { reasonCode: string };
      suggestedWwwHostname: string;
    };
    expect(unsupBody.error.reasonCode).toBe("APEX_UNSUPPORTED_CAPABILITY");
    expect(unsupBody.suggestedWwwHostname).toBe("www.bisnis.co.id");

    // 2. bisnis.co.id under new_domain WITHOUT confirmApexFlattening rejected cleanly (422 APEX_FLATTENING_UNCONFIRMED)
    const noConfirmCoId = await handleTenantDomainsRequest(
      coIdTenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${coIdTenant.tenantId}/domains`, "POST", {
        cookie: coIdTenant.owner.cookie,
        body: { hostname: "bisnis.co.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    expect(noConfirmCoId.status).toBe(422);
    expect(((await noConfirmCoId.json()) as { error: { reasonCode: string } }).error.reasonCode).toBe(
      "APEX_FLATTENING_UNCONFIRMED",
    );

    // 3. Non-retryable provider rejection rolls back brand-new local pending claim so 2-hostname slot is NOT stranded!
    cf.failNextCreateNonRetryable = true;
    const rejectedByCf = await handleTenantDomainsRequest(
      coIdTenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${coIdTenant.tenantId}/domains`, "POST", {
        cookie: coIdTenant.owner.cookie,
        body: { hostname: "bisnis.co.id", mode: "new_domain", confirmApexFlattening: true },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    expect(rejectedByCf.status).toBe(503);

    const listAfterRollback = await handleTenantDomainsRequest(
      coIdTenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${coIdTenant.tenantId}/domains`, "GET", {
        cookie: coIdTenant.owner.cookie,
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS },
    );
    const listBody = (await listAfterRollback.json()) as { items: Array<{ kind: string }> };
    expect(listBody.items.filter((i) => i.kind === "custom")).toHaveLength(0);

    // 4. Now connect bisnis.co.id + counterpart www.bisnis.co.id -> both succeed!
    const okApex = await handleTenantDomainsRequest(
      coIdTenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${coIdTenant.tenantId}/domains`, "POST", {
        cookie: coIdTenant.owner.cookie,
        body: { hostname: "bisnis.co.id", mode: "new_domain", confirmApexFlattening: true },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS + 1000 },
    );
    expect(okApex.status).toBe(201);

    const okWww = await handleTenantDomainsRequest(
      coIdTenant.tenantId,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${coIdTenant.tenantId}/domains`, "POST", {
        cookie: coIdTenant.owner.cookie,
        body: { hostname: "www.bisnis.co.id", mode: "new_domain" },
      }),
      runtimeEnv,
      { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS + 2000 },
    );
    expect(okWww.status).toBe(201);

    // 5. Same-tenant concurrent race of two UNRELATED custom hostnames -> strictly ONE wins (201), other gets 409 DOMAIN_SET_MISMATCH!
    const raceTenant = await provisionTenant("same-race", runtimeEnv, "active");
    const [r1, r2] = await Promise.all([
      handleTenantDomainsRequest(
        raceTenant.tenantId,
        makeApiRequest(`${APP_ORIGIN}/api/tenants/${raceTenant.tenantId}/domains`, "POST", {
          cookie: raceTenant.owner.cookie,
          body: { hostname: "www.usaha-satu.id", mode: "new_domain" },
        }),
        runtimeEnv,
        { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS + 3000 },
      ),
      handleTenantDomainsRequest(
        raceTenant.tenantId,
        makeApiRequest(`${APP_ORIGIN}/api/tenants/${raceTenant.tenantId}/domains`, "POST", {
          cookie: raceTenant.owner.cookie,
          body: { hostname: "www.usaha-dua.id", mode: "new_domain" },
        }),
        runtimeEnv,
        { cloudflareClient: cf.createClient(), dnsResolver: makeDnsStub(), nowMs: BASE_NOW_MS + 3000 },
      ),
    ]);
    const sorted = [r1.status, r2.status].sort((a, b) => a - b);
    expect(sorted).toEqual([201, 409]);
    const conflictRes = r1.status === 409 ? r1 : r2;
    expect(((await conflictRes.json()) as { error: { reasonCode: string } }).error.reasonCode).toBe(
      "DOMAIN_SET_MISMATCH",
    );
  });
});

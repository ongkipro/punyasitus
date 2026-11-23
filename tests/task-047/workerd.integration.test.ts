import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
  mergeCookieHeaders,
  recordSessionSecondFactorVerification,
} from "@punyasitus/auth";
import {
  DomainProviderError,
  type CloudflareSaasClient,
  type DnsResolverPort,
} from "@punyasitus/core/domains/index";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import { ensureDomainMetadataSchema } from "@punyasitus/db/domains/index";
import {
  commitOperatorDomainRecheck,
  ConsoleRecoveryError,
  ensurePlatformOperatorRolesSchema,
  finalizeOperatorDomainChange,
  listPlatformAuditEntries,
  PLATFORM_MIGRATIONS,
  revokePlatformOperator,
} from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  handleConsoleDomainChangeRequest,
  handleConsoleDomainRecheckRequest,
  handleConsoleDomainsListRequest,
  type ConsoleDomainsRuntimeEnv,
} from "../../apps/web/src/pages/api/console/domains/_shared.ts";
import {
  handleConsoleJobCancelRequest,
  handleConsoleJobRetryRequest,
  handleConsoleJobsListRequest,
  type ConsoleJobsRuntimeEnv,
} from "../../apps/web/src/pages/api/console/jobs/_shared.ts";
import { handleTenantDomainDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/domains/[domainId].ts";
import { authorizeConsoleDomainsPage } from "../../apps/web/src/pages/console/domains/_page-guard.ts";
import { authorizeConsoleJobsPage } from "../../apps/web/src/pages/console/jobs/_page-guard.ts";
import { processDurableQueueBatch } from "../../apps/web/src/worker/queues/consumer.ts";
import {
  createRecoveryJobRegistry,
  RECOVERY_DOMAIN_RECHECK_TOPIC,
} from "../../apps/web/src/worker/queues/recovery/index.ts";

const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_ORIGIN = "https://app.punyasitus.com";
const MARKETING_ORIGIN = "https://punyasitus.com";
const TENANT_ORIGIN = "https://kopi-jaya.situsku.click";
const APP_SECRET = "task047-app-auth-secret-0123456789abcdef0123456789abcdef";
const CONSOLE_SECRET = "task047-console-auth-secret-fedcba9876543210fedcba987654";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 8, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function buildDomainsEnv(extra?: Partial<ConsoleDomainsRuntimeEnv>): ConsoleDomainsRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    SAAS_CNAME_TARGET: "cname.situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
    ...extra,
  };
}

function buildJobsEnv(extra?: Partial<ConsoleJobsRuntimeEnv>): ConsoleJobsRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
    ...extra,
  };
}

function createConsoleAuth() {
  return createAuth(env.PLATFORM_DB, {
    baseURL: CONSOLE_ORIGIN,
    secret: CONSOLE_SECRET,
    surface: "console",
    trustedOrigins: [CONSOLE_ORIGIN],
  });
}

async function resetTables(): Promise<void> {
  await ensureDomainMetadataSchema(env.PLATFORM_DB);
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM domain_recheck_rate_limits"),
    env.PLATFORM_DB.prepare("DELETE FROM tenant_host_metadata"),
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM two_factors"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM invitations"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM tenant_hosts"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    env.PLATFORM_DB.prepare("DELETE FROM organizations"),
    env.PLATFORM_DB.prepare("DELETE FROM job_ledger"),
    env.PLATFORM_DB.prepare("DELETE FROM verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM sessions"),
    env.PLATFORM_DB.prepare("DELETE FROM accounts"),
    env.PLATFORM_DB.prepare("DELETE FROM users"),
  ]);
}

async function setupActive2faOperator(email: string, nowMs = BASE_NOW_MS) {
  const fixture = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
    auth: createConsoleAuth(),
    email,
    password: "ConsoleOp!Pass2026",
    name: "Superadmin T047",
    nowMs,
  });
  return {
    ...fixture,
    userId: fixture.user.id,
    sessionId: fixture.session.id,
  };
}

async function createNonOperatorUser(email: string, name: string) {
  const auth = createConsoleAuth();
  const signUp = await auth.api.signUpEmail({
    body: { email, password: "TenantOwner!Pass2026", name },
    asResponse: true,
  });
  expect(signUp.ok).toBe(true);
  const cookieHeader = mergeCookieHeaders(null, signUp.headers);
  const sess = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader }) });
  expect(sess?.user?.id).toBeTruthy();
  await env.PLATFORM_DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?")
    .bind(sess!.user.id)
    .run();
  return {
    userId: sess!.user.id,
    sessionId: sess!.session.id,
    cookieHeader,
  };
}

async function seedTenantWithDomains(params: {
  readonly tenantId: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: "trial" | "active" | "suspended";
  readonly operatorHold?: boolean;
  readonly ownerUserId?: string;
  readonly customHosts?: readonly {
    readonly host: string;
    readonly cfId: string | null;
    readonly status: "pending" | "active" | "failed" | "moved" | "deleting";
    readonly sslStatus: string;
    readonly isPrimary?: boolean;
    readonly everActivated?: boolean;
    readonly failureCode?: string | null;
    readonly lastCheckedAt?: number | null;
  }[];
}) {
  const paidThrough = params.status === "active" ? BASE_NOW_MS + 30 * DAY_MS : null;
  const trialEndsAt = params.status === "trial" ? BASE_NOW_MS + 7 * DAY_MS : null;
  const hasPrimaryCustom = Boolean(params.customHosts?.some((h) => h.isPrimary));

  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(params.orgId, params.name, params.handle, BASE_NOW_MS, BASE_NOW_MS),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold, operator_hold_reason,
         trial_ends_at, paid_through, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)`,
    ).bind(
      params.tenantId,
      params.orgId,
      params.handle,
      params.name,
      params.status,
      params.operatorHold ? 1 : 0,
      params.operatorHold ? "Ditangguhkan sementara untuk investigasi" : null,
      trialEndsAt,
      paidThrough,
      BASE_NOW_MS,
      BASE_NOW_MS,
    ),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenant_hosts (
         host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary,
         verified_at, last_checked_at, version, created_at, updated_at
       ) VALUES (?, ?, 'subdomain', NULL, 'active', 'active', ?, ?, ?, 1, ?, ?)`,
    ).bind(
      `${params.handle}.situsku.click`,
      params.tenantId,
      hasPrimaryCustom ? 0 : 1,
      BASE_NOW_MS,
      BASE_NOW_MS,
      BASE_NOW_MS,
      BASE_NOW_MS,
    ),
  ]);

  if (params.ownerUserId) {
    await env.PLATFORM_DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
    )
      .bind(`mem-${params.tenantId}`, params.orgId, params.ownerUserId, BASE_NOW_MS)
      .run();
  }

  let domainId = 2;
  for (const h of params.customHosts ?? []) {
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hosts (
           host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary,
           verified_at, last_checked_at, version, created_at, updated_at
         ) VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        h.host,
        params.tenantId,
        h.cfId,
        h.status,
        h.sslStatus,
        h.isPrimary ? 1 : 0,
        h.status === "active" ? BASE_NOW_MS : null,
        h.lastCheckedAt ?? BASE_NOW_MS,
        BASE_NOW_MS - 12 * 3600 * 1000,
        BASE_NOW_MS,
      ),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_host_metadata (
           host, tenant_id, domain_id, connect_mode, ssl_method, provider_status,
           provider_ssl_status, failure_code, ever_activated, created_at, updated_at
         ) VALUES (?, ?, ?, 'new_domain', 'http', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        h.host,
        params.tenantId,
        domainId,
        h.status === "failed" ? "blocked" : h.status,
        h.sslStatus,
        h.failureCode ?? null,
        h.everActivated || h.status === "active" ? 1 : 0,
        BASE_NOW_MS - 12 * 3600 * 1000,
        BASE_NOW_MS,
      ),
    ]);
    domainId += 1;
  }
}

function makeConsolePost(
  pathname: string,
  cookieHeader: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
  origin = CONSOLE_ORIGIN,
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: origin,
    Cookie: cookieHeader,
  };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return new Request(`${CONSOLE_ORIGIN}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function createMockCloudflareClient(overrides: Partial<CloudflareSaasClient> = {}): CloudflareSaasClient {
  return {
    async createCustomHostname(input) {
      return {
        id: `cf-created-${input.hostname}`,
        hostname: input.hostname,
        status: "pending",
        ssl: { status: "pending_validation", method: input.sslMethod, type: "dv" },
      };
    },
    async getCustomHostname(id) {
      return {
        id,
        hostname: "www.example.id",
        status: "pending",
        ssl: { status: "pending_validation", method: "http", type: "dv" },
      };
    },
    async findCustomHostnameByName() {
      return null;
    },
    async patchCustomHostnameSsl(id, ssl) {
      return {
        id,
        hostname: "www.example.id",
        status: "active",
        ssl: { status: "active", method: ssl.method, type: "dv" },
      };
    },
    async deleteCustomHostname(id) {
      return { id, deleted: true, alreadyAbsent: false };
    },
    async getCustomHostnameQuota() {
      return { allocated: 100, used: 2 };
    },
    ...overrides,
  };
}

function createMockDnsResolver(cnameTarget: string | null = "cname.situsku.click"): DnsResolverPort {
  return {
    async resolveCname() {
      return cnameTarget ? [cnameTarget] : [];
    },
    async resolveTxt() {
      return [];
    },
    async resolveCaa() {
      return [];
    },
    async resolveNs() {
      return [];
    },
  };
}

describe("TASK-047 Integration — Superadmin Domain & Job Recovery Queues (workerd D1)", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await ensureDomainMetadataSchema(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetTables();
  });

  it("enforces bare neutral 404 on non-console hosts for BOTH pages and APIs", async () => {
    const op = await setupActive2faOperator("op-host@punyasitus.com");
    const nonConsoleOrigins = [APP_ORIGIN, MARKETING_ORIGIN, TENANT_ORIGIN];

    for (const origin of nonConsoleOrigins) {
      const domApi = await handleConsoleDomainsListRequest(
        new Request(`${origin}/api/console/domains`, { headers: { Cookie: op.cookieHeader } }),
        buildDomainsEnv(),
        { nowMs: BASE_NOW_MS },
      );
      expect(domApi.status).toBe(404);
      expect(await domApi.text()).toBe("Not Found");

      const jobApi = await handleConsoleJobsListRequest(
        new Request(`${origin}/api/console/jobs`, { headers: { Cookie: op.cookieHeader } }),
        buildJobsEnv(),
        { nowMs: BASE_NOW_MS },
      );
      expect(jobApi.status).toBe(404);
      expect(await jobApi.text()).toBe("Not Found");

      const domPage = await authorizeConsoleDomainsPage(
        new Request(`${origin}/console/domains`, { headers: { Cookie: op.cookieHeader } }),
        buildDomainsEnv(),
      );
      expect(domPage.ok).toBe(false);
      if (!domPage.ok) {
        expect(domPage.response.status).toBe(404);
        expect(await domPage.response.text()).toBe("Not Found");
      }

      const jobPage = await authorizeConsoleJobsPage(
        new Request(`${origin}/console/jobs`, { headers: { Cookie: op.cookieHeader } }),
        buildJobsEnv(),
      );
      expect(jobPage.ok).toBe(false);
      if (!jobPage.ok) {
        expect(jobPage.response.status).toBe(404);
        expect(await jobPage.response.text()).toBe("Not Found");
      }
    }
  });

  it("denies tenant owners, revoked operators, stale >10m 2FA, and CSRF Origin mismatch", async () => {
    const owner = await createNonOperatorUser("owner@kopi.id", "Pemilik Kopi");
    const op = await setupActive2faOperator("op-auth@punyasitus.com");
    const op2 = await setupActive2faOperator("op-auth2@punyasitus.com");

    await seedTenantWithDomains({
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F01",
      orgId: "org-01",
      handle: "kopi-jaya",
      name: "Kopi Jaya",
      status: "active",
      ownerUserId: owner.userId,
      customHosts: [
        {
          host: "www.kopijaya.id",
          cfId: "cf-kopi-1",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
          everActivated: true,
        },
      ],
    });

    // Tenant owner gets 403 PLATFORM_OPERATOR_REQUIRED on console domains & jobs
    const ownerDomList = await handleConsoleDomainsListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/domains`, {
        headers: { Cookie: owner.cookieHeader },
      }),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(ownerDomList.status).toBe(403);

    const ownerJobList = await handleConsoleJobsListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/jobs`, {
        headers: { Cookie: owner.cookieHeader },
      }),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(ownerJobList.status).toBe(403);

    // CSRF origin mismatch -> 403
    const badCsrf = await handleConsoleDomainRecheckRequest(
      makeConsolePost(
        "/api/console/domains/recheck",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F01",
          hostname: "www.kopijaya.id",
          expectedVersion: 1,
          reason: "Audit cek CSRF origin mismatch",
        },
        "idemp-csrf-001",
        "https://evil.example.com",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(badCsrf.status).toBe(403);

    // Stale step-up 2FA (> 10 minutes old) -> 403 REAUTH_REQUIRED
    const staleNowMs = BASE_NOW_MS + DEFAULT_SECOND_FACTOR_WINDOW_MS + 5_000;
    const staleRes = await handleConsoleDomainRecheckRequest(
      makeConsolePost(
        "/api/console/domains/recheck",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F01",
          hostname: "www.kopijaya.id",
          expectedVersion: 1,
          reason: "Cek step-up 2FA kedaluwarsa lebih 10m",
        },
        "idemp-stale-2fa-001",
      ),
      buildDomainsEnv(),
      { nowMs: staleNowMs },
    );
    expect(staleRes.status).toBe(403);
    const staleBody = (await staleRes.json()) as { code: string };
    expect(staleBody.code).toBe("REAUTH_REQUIRED");

    // Revoke op -> subsequent requests immediately rejected 403 OPERATOR_REVOKED
    await revokePlatformOperator(env.PLATFORM_DB, {
      actorUserId: op2.userId,
      targetUserId: op.userId,
      reason: "Pencabutan akses operator untuk uji TASK-047",
      nowMs: BASE_NOW_MS + 1000,
    });
    const revokedRes = await handleConsoleDomainsListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/domains`, {
        headers: { Cookie: op.cookieHeader },
      }),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS + 2000 },
    );
    expect(revokedRes.status).toBe(403);
    expect(((await revokedRes.json()) as { code: string }).code).toBe("OPERATOR_REVOKED");
  });

  it("domain recheck enforces rate limits, idempotency, strict fields, forged ID rejection, and safe provider timeout without unsuspending tenant", async () => {
    const op = await setupActive2faOperator("op-dom@punyasitus.com");
    await seedTenantWithDomains({
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F02",
      orgId: "org-02",
      handle: "bintang-tour",
      name: "Bintang Tour",
      status: "suspended",
      operatorHold: true,
      customHosts: [
        {
          host: "www.bintangtour.id",
          cfId: "cf-bintang-1",
          status: "pending",
          sslStatus: "pending_validation",
          lastCheckedAt: BASE_NOW_MS - 8 * 3600 * 1000,
        },
      ],
    });

    // 1. Unknown field `forceActive` rejected 422 UNKNOWN_FIELD
    const forceActiveRes = await handleConsoleDomainRecheckRequest(
      makeConsolePost(
        "/api/console/domains/recheck",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F02",
          hostname: "www.bintangtour.id",
          expectedVersion: 1,
          reason: "Mencoba bypass verifikasi domain",
          forceActive: true,
        },
        "idemp-force-active-01",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS, cloudflareClient: createMockCloudflareClient() },
    );
    expect(forceActiveRes.status).toBe(422);
    expect(((await forceActiveRes.json()) as { code: string }).code).toBe("UNKNOWN_FIELD");

    // 2. Forged tenantId mismatch -> 404 NOT_FOUND
    const forgedRes = await handleConsoleDomainRecheckRequest(
      makeConsolePost(
        "/api/console/domains/recheck",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F99",
          hostname: "www.bintangtour.id",
          expectedVersion: 1,
          reason: "Menguji forged tenant ID lintas tenant",
        },
        "idemp-forged-01",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS, cloudflareClient: createMockCloudflareClient() },
    );
    expect(forgedRes.status).toBe(404);

    // 3. Provider timeout leaves domain PENDING, records PROVIDER_TIMEOUT + audit, and NEVER unsuspends tenant!
    const timeoutCf = createMockCloudflareClient({
      async patchCustomHostnameSsl() {
        throw new DomainProviderError("timeout", "Cloudflare request timed out", {
          retryable: true,
        });
      },
    });
    const timeoutRes = await handleConsoleDomainRecheckRequest(
      makeConsolePost(
        "/api/console/domains/recheck",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F02",
          hostname: "www.bintangtour.id",
          expectedVersion: 1,
          reason: "Pemeriksaan ulang domain saat Cloudflare timeout",
        },
        "idemp-timeout-01",
      ),
      buildDomainsEnv(),
      {
        nowMs: BASE_NOW_MS + 1000,
        cloudflareClient: timeoutCf,
        dnsResolver: createMockDnsResolver("cname.situsku.click"),
        recheckRateLimitPolicy: { perDomainLimit: 10, perTenantLimit: 20 },
      },
    );
    expect(timeoutRes.status).toBe(503);
    const timeoutBody = (await timeoutRes.json()) as {
      reconciliationPending: boolean;
      reasonCode: string;
      domain: { status: string; version: number; failureCode: string | null };
    };
    expect(timeoutBody.reconciliationPending).toBe(true);
    expect(timeoutBody.reasonCode).toBe("PROVIDER_TIMEOUT");
    expect(timeoutBody.domain.status).toBe("pending");
    expect(timeoutBody.domain.failureCode).toBe("PROVIDER_TIMEOUT");

    // Verify tenant stayed suspended with operator_hold = 1!
    const tenantAfterTimeout = await env.PLATFORM_DB.prepare(
      "SELECT status, operator_hold FROM tenants WHERE id = ?",
    )
      .bind("01ARZ3NDEKTSV4RRFFQ69G5F02")
      .first<{ status: string; operator_hold: number }>();
    expect(tenantAfterTimeout).toEqual({ status: "suspended", operator_hold: 1 });

    // 4. Successful provider sync with matching CNAME updates domain & writes audit; idempotent replay works
    // Note: timeout did NOT bump `tenant_hosts.version`, so retrying with expectedVersion = 1 works seamlessly!
    expect(timeoutBody.domain.version).toBe(1);
    const successCf = createMockCloudflareClient({
      async patchCustomHostnameSsl(id, ssl) {
        return {
          id,
          hostname: "www.bintangtour.id",
          status: "active",
          ssl: { status: "active", method: ssl.method, type: "dv" },
        };
      },
    });
    const okRes = await handleConsoleDomainRecheckRequest(
      makeConsolePost(
        "/api/console/domains/recheck",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F02",
          hostname: "www.bintangtour.id",
          expectedVersion: timeoutBody.domain.version,
          sslMethod: "http",
          reason: "Sinkronisasi ulang setelah penyedia pulih",
        },
        "idemp-recheck-ok-01",
      ),
      buildDomainsEnv(),
      {
        nowMs: BASE_NOW_MS + 2000,
        cloudflareClient: successCf,
        dnsResolver: createMockDnsResolver("cname.situsku.click"),
        recheckRateLimitPolicy: { perDomainLimit: 10, perTenantLimit: 20 },
      },
    );
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { replayed: boolean; domain: { status: string } };
    expect(okBody.replayed).toBe(false);
    expect(okBody.domain.status).toBe("active");

    // Tenant STILL suspended — domain recheck NEVER lifts service suspension!
    const tenantAfterSync = await env.PLATFORM_DB.prepare(
      "SELECT status, operator_hold FROM tenants WHERE id = ?",
    )
      .bind("01ARZ3NDEKTSV4RRFFQ69G5F02")
      .first<{ status: string; operator_hold: number }>();
    expect(tenantAfterSync).toEqual({ status: "suspended", operator_hold: 1 });

    // Replay same Idempotency-Key -> 200 replayed: true
    const replayRes = await handleConsoleDomainRecheckRequest(
      makeConsolePost(
        "/api/console/domains/recheck",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F02",
          hostname: "www.bintangtour.id",
          expectedVersion: timeoutBody.domain.version,
          sslMethod: "http",
          reason: "Sinkronisasi ulang setelah penyedia pulih",
        },
        "idemp-recheck-ok-01",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS + 3000, cloudflareClient: successCf },
    );
    expect(replayRes.status).toBe(200);
    expect(((await replayRes.json()) as { replayed: boolean }).replayed).toBe(true);

    // Same Idempotency-Key with different sslMethod -> 409 IDEMPOTENCY_CONFLICT (Finding 6)
    const sslConflictRes = await handleConsoleDomainRecheckRequest(
      makeConsolePost(
        "/api/console/domains/recheck",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F02",
          hostname: "www.bintangtour.id",
          expectedVersion: timeoutBody.domain.version,
          sslMethod: "txt",
          reason: "Sinkronisasi ulang setelah penyedia pulih",
        },
        "idemp-recheck-ok-01",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS + 3500, cloudflareClient: successCf },
    );
    expect(sslConflictRes.status).toBe(409);
    expect(((await sslConflictRes.json()) as { code: string }).code).toBe("IDEMPOTENCY_CONFLICT");

    // Same Idempotency-Key with different payload -> 409 IDEMPOTENCY_CONFLICT
    const conflictRes = await handleConsoleDomainRecheckRequest(
      makeConsolePost(
        "/api/console/domains/recheck",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F02",
          hostname: "www.bintangtour.id",
          expectedVersion: timeoutBody.domain.version,
          sslMethod: "http",
          reason: "Alasan berbeda memakai idempotency key sama",
        },
        "idemp-recheck-ok-01",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS + 4000, cloudflareClient: successCf },
    );
    expect(conflictRes.status).toBe(409);
    expect(((await conflictRes.json()) as { code: string }).code).toBe("IDEMPOTENCY_CONFLICT");

    // 5. Rate limit exceeded -> 429 RATE_LIMITED
    const rlRes = await handleConsoleDomainRecheckRequest(
      makeConsolePost(
        "/api/console/domains/recheck",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F02",
          hostname: "www.bintangtour.id",
          expectedVersion: timeoutBody.domain.version + 1,
          reason: "Cek rate limit recheck operator console",
        },
        "idemp-recheck-rl-01",
      ),
      buildDomainsEnv(),
      {
        nowMs: BASE_NOW_MS + 5000,
        cloudflareClient: successCf,
        recheckRateLimitPolicy: { perDomainLimit: 1, perTenantLimit: 1 },
      },
    );
    expect(rlRes.status).toBe(429);
    expect(((await rlRes.json()) as { code: string }).code).toBe("RATE_LIMITED");
  });

  it("operator domain change removes locked hostnames and connects new domain in pending state with audit, while tenant owner gets 403 DOMAIN_LOCKED", async () => {
    const owner = await createNonOperatorUser("owner-lock@tokolama.id", "Owner Toko Lama");
    const op = await setupActive2faOperator("op-change@punyasitus.com");

    await seedTenantWithDomains({
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F03",
      orgId: "org-03",
      handle: "toko-lama",
      name: "Toko Lama",
      status: "active",
      ownerUserId: owner.userId,
      customHosts: [
        {
          host: "www.tokolama.id",
          cfId: "cf-lama-www",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
          everActivated: true,
        },
        {
          host: "tokolama.id",
          cfId: "cf-lama-apex",
          status: "active",
          sslStatus: "active",
          isPrimary: false,
          everActivated: true,
        },
      ],
    });

    // 1. Tenant owner CANNOT remove locked active domain (`403 DOMAIN_LOCKED`)
    const ownerDeleteRes = await handleTenantDomainDetailRequest(
      "01ARZ3NDEKTSV4RRFFQ69G5F03",
      "www.tokolama.id",
      new Request(`${APP_ORIGIN}/api/tenants/01ARZ3NDEKTSV4RRFFQ69G5F03/domains/www.tokolama.id`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
        },
        body: JSON.stringify({ confirmHostname: "www.tokolama.id", version: 1 }),
      }),
      {
        APP_ENV: "test",
        PLATFORM_DOMAIN: "punyasitus.com",
        SAAS_ZONE: "situsku.click",
        PLATFORM_DB: env.PLATFORM_DB,
        AUTH_SECRET: APP_SECRET,
      },
      {
        authenticatedUser: { id: owner.userId },
        activeOrganizationId: "org-03",
        nowMs: BASE_NOW_MS,
      },
    );
    expect(ownerDeleteRes.status).toBe(403);
    expect(((await ownerDeleteRes.json()) as { error: { code: string } }).error.code).toBe(
      "DOMAIN_LOCKED",
    );

    // 2. Operator domain change without explicit confirmation fails 422
    const unconfirmedRes = await handleConsoleDomainChangeRequest(
      makeConsolePost(
        "/api/console/domains/change",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F03",
          hostname: "www.tokolama.id",
          confirmHostname: "www.tokolama.id",
          confirmRemoveLocked: false,
          newHostname: "www.tokobaru.id",
          expectedVersion: 1,
          reason: "Rebranding resmi atas permintaan pemilik tiket #9001",
        },
        "idemp-change-unconf-01",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS, cloudflareClient: createMockCloudflareClient() },
    );
    expect(unconfirmedRes.status).toBe(422);

    // 3. Operator domain change with confirmation removes BOTH locked hostnames, restores subdomain fallback, and connects new domain in `pending`
    const deletedCfIds: string[] = [];
    const createdHostnames: string[] = [];
    const cfMock = createMockCloudflareClient({
      async deleteCustomHostname(id) {
        deletedCfIds.push(id);
        return { id, deleted: true, alreadyAbsent: false };
      },
      async createCustomHostname(input) {
        createdHostnames.push(input.hostname);
        return {
          id: "cf-baru-www",
          hostname: input.hostname,
          status: "pending",
          ssl: { status: "pending_validation", method: input.sslMethod, type: "dv" },
        };
      },
    });

    const changeRes = await handleConsoleDomainChangeRequest(
      makeConsolePost(
        "/api/console/domains/change",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F03",
          hostname: "www.tokolama.id",
          confirmHostname: "www.tokolama.id",
          confirmRemoveLocked: true,
          removeDomainSet: true,
          newHostname: "www.tokobaru.id",
          connectMode: "new_domain",
          expectedVersion: 1,
          reason: "Rebranding resmi atas permintaan pemilik tiket #9001",
        },
        "idemp-change-ok-01",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS + 1000, cloudflareClient: cfMock },
    );
    expect(changeRes.status).toBe(200);
    const changeBody = (await changeRes.json()) as {
      removedHostnames: string[];
      newDomain: { hostname: string; status: string; lockedAfterActivation: boolean };
      auditId: string;
    };
    expect(changeBody.removedHostnames.sort()).toEqual(["tokolama.id", "www.tokolama.id"]);
    expect(deletedCfIds.sort()).toEqual(["cf-lama-apex", "cf-lama-www"]);
    expect(createdHostnames).toEqual(["www.tokobaru.id"]);
    expect(changeBody.newDomain.hostname).toBe("www.tokobaru.id");
    expect(changeBody.newDomain.status).toBe("pending");
    expect(changeBody.newDomain.lockedAfterActivation).toBe(false);
    expect(changeBody.auditId).toBeTruthy();

    // Platform subdomain is primary fallback while new domain awaits DNS/TLS verification
    const hostsAfter = await env.PLATFORM_DB.prepare(
      "SELECT host, kind, status, is_primary FROM tenant_hosts WHERE tenant_id = ? ORDER BY host ASC",
    )
      .bind("01ARZ3NDEKTSV4RRFFQ69G5F03")
      .all<{ host: string; kind: string; status: string; is_primary: number }>();
    expect(hostsAfter.results).toEqual([
      { host: "toko-lama.situsku.click", kind: "subdomain", status: "active", is_primary: 1 },
      { host: "www.tokobaru.id", kind: "custom", status: "pending", is_primary: 0 },
    ]);

    // Audit entries recorded
    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F03",
    });
    expect(audits.some((a) => a.action === "console.domain.change.completed")).toBe(true);
  });

  it("job queue redacts all secrets/PII, rejects live leases/completed jobs/forged IDs/payload overrides, retries failed jobs atomically, and rolls back on audit failure", async () => {
    const op = await setupActive2faOperator("op-jobs@punyasitus.com");
    await seedTenantWithDomains({
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F04",
      orgId: "org-04",
      handle: "clinic-sehat",
      name: "Klinik Sehat",
      status: "active",
    });

    const secretPayload = JSON.stringify({
      hostname: "www.kliniksehat.id",
      apiToken: "cf_secret_token_do_not_leak_999",
      customerEmail: "pasien@rahasia.id",
      phone: "+6281234567899",
      leadBody: "Keluhan medis rahasia pasien A",
    });

    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO job_ledger (
           idempotency_key, topic, tenant_id, status, attempts, lease_until,
           last_error_code, payload_json, created_at, updated_at
         ) VALUES
           ('job-failed-1', 'email.send', '01ARZ3NDEKTSV4RRFFQ69G5F04', 'failed', 2, NULL, 'SMTP_TIMEOUT', ?, ?, ?),
           ('job-live-lease-1', 'billing.advice', '01ARZ3NDEKTSV4RRFFQ69G5F04', 'running', 1, ?, NULL, '{}', ?, ?),
           ('job-expired-lease-1', 'media.og', '01ARZ3NDEKTSV4RRFFQ69G5F04', 'running', 1, ?, 'WORKER_CRASH', '{}', ?, ?),
           ('job-completed-1', 'seo.indexnow', '01ARZ3NDEKTSV4RRFFQ69G5F04', 'completed', 1, NULL, NULL, '{}', ?, ?)`,
      ).bind(
        secretPayload,
        BASE_NOW_MS - 60_000,
        BASE_NOW_MS - 30_000,
        BASE_NOW_MS + 60_000, // live active lease
        BASE_NOW_MS - 20_000,
        BASE_NOW_MS - 10_000,
        BASE_NOW_MS - 5_000, // expired lease
        BASE_NOW_MS - 120_000,
        BASE_NOW_MS - 60_000,
        BASE_NOW_MS - 180_000,
        BASE_NOW_MS - 90_000,
      ),
    ]);

    // 1. GET /api/console/jobs?status=all redacts secrets/PII/lead bodies completely
    const listRes = await handleConsoleJobsListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/jobs?status=all`, {
        headers: { Cookie: op.cookieHeader },
      }),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).not.toContain("cf_secret_token_do_not_leak_999");
    expect(listText).not.toContain("pasien@rahasia.id");
    expect(listText).not.toContain("6281234567899");
    expect(listText).not.toContain("Keluhan medis rahasia pasien A");
    expect(listText).toContain("[REDACTED]");
    expect(listText).toContain("www.kliniksehat.id");

    // 2. Reject live active lease (`409 JOB_LEASE_ACTIVE`)
    const liveLeaseRes = await handleConsoleJobRetryRequest(
      makeConsolePost(
        "/api/console/jobs/retry",
        op.cookieHeader,
        {
          jobIdempotencyKey: "job-live-lease-1",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F04",
          expectedUpdatedAt: BASE_NOW_MS - 10_000,
          reason: "Mencoba retry job dengan lease aktif",
        },
        "idemp-job-live-01",
      ),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(liveLeaseRes.status).toBe(409);
    expect(((await liveLeaseRes.json()) as { code: string }).code).toBe("JOB_LEASE_ACTIVE");

    // 3. Reject completed job (`409 JOB_ALREADY_COMPLETED`)
    const completedRes = await handleConsoleJobRetryRequest(
      makeConsolePost(
        "/api/console/jobs/retry",
        op.cookieHeader,
        {
          jobIdempotencyKey: "job-completed-1",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F04",
          expectedUpdatedAt: BASE_NOW_MS - 90_000,
          reason: "Mencoba retry job yang sudah selesai",
        },
        "idemp-job-done-01",
      ),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(completedRes.status).toBe(409);
    expect(((await completedRes.json()) as { code: string }).code).toBe("JOB_ALREADY_COMPLETED");

    // 4. Reject forged tenantId (`404 NOT_FOUND`) and payload editor (`422 UNKNOWN_FIELD`)
    const forgedJobRes = await handleConsoleJobRetryRequest(
      makeConsolePost(
        "/api/console/jobs/retry",
        op.cookieHeader,
        {
          jobIdempotencyKey: "job-failed-1",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F99",
          expectedUpdatedAt: BASE_NOW_MS - 30_000,
          reason: "Mencoba retry dengan tenant ID palsu",
        },
        "idemp-job-forged-01",
      ),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(forgedJobRes.status).toBe(404);

    const payloadOverrideRes = await handleConsoleJobRetryRequest(
      makeConsolePost(
        "/api/console/jobs/retry",
        op.cookieHeader,
        {
          jobIdempotencyKey: "job-failed-1",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F04",
          expectedUpdatedAt: BASE_NOW_MS - 30_000,
          reason: "Mencoba menyuntik payload baru pada retry",
          payload: { injected: true },
        },
        "idemp-job-payload-01",
      ),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(payloadOverrideRes.status).toBe(422);
    expect(((await payloadOverrideRes.json()) as { code: string }).code).toBe("UNKNOWN_FIELD");

    // 5. Retry failed job atomically -> dispatches original payload once, replays cleanly on duplicate click
    const sentMessages: unknown[] = [];
    const mockQueue = {
      async send(msg: unknown) {
        sentMessages.push(msg);
      },
    };

    const retryOk = await handleConsoleJobRetryRequest(
      makeConsolePost(
        "/api/console/jobs/retry",
        op.cookieHeader,
        {
          jobIdempotencyKey: "job-failed-1",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F04",
          expectedUpdatedAt: BASE_NOW_MS - 30_000,
          reason: "SMTP provider pulih — jalankan ulang email",
        },
        "idemp-job-retry-ok-01",
      ),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS + 1000, jobsQueue: mockQueue },
    );
    expect(retryOk.status).toBe(200);
    const retryBody = (await retryOk.json()) as {
      replayed: boolean;
      dispatched: boolean;
      job: { status: string; attempts: number };
      auditId: string;
    };
    expect(retryBody.replayed).toBe(false);
    expect(retryBody.dispatched).toBe(true);
    expect(retryBody.job.status).toBe("queued");
    expect(retryBody.job.attempts).toBe(0);
    expect(retryBody.auditId).toBeTruthy();
    expect(sentMessages).toHaveLength(1);

    // Duplicate click with same Idempotency-Key replays WITHOUT double-enqueueing!
    const retryReplay = await handleConsoleJobRetryRequest(
      makeConsolePost(
        "/api/console/jobs/retry",
        op.cookieHeader,
        {
          jobIdempotencyKey: "job-failed-1",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F04",
          expectedUpdatedAt: BASE_NOW_MS - 30_000,
          reason: "SMTP provider pulih — jalankan ulang email",
        },
        "idemp-job-retry-ok-01",
      ),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS + 2000, jobsQueue: mockQueue },
    );
    expect(retryReplay.status).toBe(200);
    expect(((await retryReplay.json()) as { replayed: boolean }).replayed).toBe(true);
    expect(sentMessages).toHaveLength(1);

    // 6. Cancel expired-lease job to dead_letter atomically
    const cancelRes = await handleConsoleJobCancelRequest(
      makeConsolePost(
        "/api/console/jobs/cancel",
        op.cookieHeader,
        {
          jobIdempotencyKey: "job-expired-lease-1",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F04",
          expectedUpdatedAt: BASE_NOW_MS - 60_000,
          reason: "Job OG lama sudah digantikan versi baru",
        },
        "idemp-job-cancel-01",
      ),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS + 3000 },
    );
    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      job: { status: string; lastErrorCode: string };
    };
    expect(cancelBody.job.status).toBe("dead_letter");
    expect(cancelBody.job.lastErrorCode).toBe("OPERATOR_CANCELED");

    // 7. Audit persistence failure rolls back job update atomically!
    await env.PLATFORM_DB.prepare(
      `CREATE TRIGGER IF NOT EXISTS fail_audit_t047
       BEFORE INSERT ON platform_audit
       WHEN NEW.action = 'console.job.retry'
       BEGIN
         SELECT RAISE(ABORT, 'simulated audit failure');
       END`,
    ).run();

    try {
      await env.PLATFORM_DB.prepare(
        `INSERT INTO job_ledger (
           idempotency_key, topic, tenant_id, status, attempts, last_error_code, payload_json, created_at, updated_at
         ) VALUES ('job-rollback-1', 'email.send', '01ARZ3NDEKTSV4RRFFQ69G5F04', 'failed', 1, 'NET_ERR', '{}', ?, ?)`,
      )
        .bind(BASE_NOW_MS - 5000, BASE_NOW_MS - 5000)
        .run();

      const rbRes = await handleConsoleJobRetryRequest(
        makeConsolePost(
          "/api/console/jobs/retry",
          op.cookieHeader,
          {
            jobIdempotencyKey: "job-rollback-1",
            tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F04",
            expectedUpdatedAt: BASE_NOW_MS - 5000,
            reason: "Menguji rollback atomik saat audit gagal",
          },
          "idemp-job-rb-01",
        ),
        buildJobsEnv(),
        { nowMs: BASE_NOW_MS + 4000, jobsQueue: mockQueue },
      );
      expect(rbRes.status).toBe(500);
      expect(((await rbRes.json()) as { code: string }).code).toBe("AUDIT_PERSISTENCE_FAILED");

      // Job row must STILL be `failed` (rolled back!) and queue NOT dispatched!
      const unchanged = await env.PLATFORM_DB.prepare(
        "SELECT status FROM job_ledger WHERE idempotency_key = 'job-rollback-1'",
      ).first<{ status: string }>();
      expect(unchanged?.status).toBe("failed");
      expect(sentMessages).toHaveLength(1);
    } finally {
      await env.PLATFORM_DB.prepare("DROP TRIGGER IF EXISTS fail_audit_t047").run();
    }
  });

  it("domain recovery queue worker handles provider timeout with retry backoff and reconciles without false activation", async () => {
    await seedTenantWithDomains({
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F05",
      orgId: "org-05",
      handle: "bengkel-maju",
      name: "Bengkel Maju",
      status: "active",
      customHosts: [
        {
          host: "www.bengkelmaju.id",
          cfId: "cf-bengkel-1",
          status: "pending",
          sslStatus: "pending_validation",
        },
      ],
    });

    let callCount = 0;
    const cfMock = createMockCloudflareClient({
      async patchCustomHostnameSsl() {
        callCount += 1;
        throw new DomainProviderError("timeout", "Cloudflare timeout", { retryable: true });
      },
      async getCustomHostname(id) {
        return {
          id,
          hostname: "www.bengkelmaju.id",
          status: "pending",
          ssl: { status: "pending_validation", method: "http", type: "dv" },
        };
      },
    });

    const registry = createRecoveryJobRegistry({
      cloudflareClient: cfMock,
      dnsResolver: createMockDnsResolver(null),
      cnameTarget: "cname.situsku.click",
    });

    let retriedDelay: number | undefined;
    const batch = {
      queue: "punyasitus-jobs",
      messages: [
        {
          id: "msg-rec-1",
          timestamp: new Date(BASE_NOW_MS),
          attempts: 1,
          body: {
            idempotencyKey: "recovery-dom-bengkel-1",
            topic: RECOVERY_DOMAIN_RECHECK_TOPIC,
            tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F05",
            payload: { hostname: "www.bengkelmaju.id" },
            correlationId: "req_t047_worker",
            enqueuedAt: BASE_NOW_MS,
          },
          ack() {},
          retry(opts?: { delaySeconds?: number }) {
            retriedDelay = opts?.delaySeconds;
          },
        },
      ],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<unknown>;

    const result = await processDurableQueueBatch(
      batch,
      { PLATFORM_DB: env.PLATFORM_DB },
      registry,
      { now: () => BASE_NOW_MS, logger: () => {} },
    );

    expect(callCount).toBe(1);
    expect(result.retried).toBe(1);
    expect(retriedDelay).toBe(30);

    // Domain remains strictly `pending`, NOT `active`!
    const hostRow = await env.PLATFORM_DB.prepare(
      "SELECT status FROM tenant_hosts WHERE host = 'www.bengkelmaju.id'",
    ).first<{ status: string }>();
    expect(hostRow?.status).toBe("pending");
  });

  it("re-verifies step-up 2FA window helper compatibility", async () => {
    const op = await setupActive2faOperator("op-stepup@punyasitus.com");
    await recordSessionSecondFactorVerification(env.PLATFORM_DB, {
      sessionId: op.sessionId,
      userId: op.userId,
      method: "totp",
      nowMs: BASE_NOW_MS + 60_000,
    });
    const listRes = await handleConsoleJobsListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/jobs`, {
        headers: { Cookie: op.cookieHeader },
      }),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS + 65_000 },
    );
    expect(listRes.status).toBe(200);
  });

  it("Finding 1 & 2: enforces atomic receipt on non-retryable provider failure and REQ-065 domain-set / 2-host cap", async () => {
    const op = await setupActive2faOperator("op-f12@punyasitus.com");
    await seedTenantWithDomains({
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F10",
      orgId: "org-10",
      handle: "mitra-set",
      name: "Mitra Set",
      status: "active",
      customHosts: [
        {
          host: "www.mitraset.id",
          cfId: "cf-ms-www",
          status: "active",
          sslStatus: "active",
          isPrimary: true,
          everActivated: true,
        },
        {
          host: "mitraset.id",
          cfId: "cf-ms-apex",
          status: "active",
          sslStatus: "active",
          isPrimary: false,
          everActivated: true,
        },
      ],
    });

    // Finding 2a: removeDomainSet: false + non-counterpart replacement -> 422 DOMAIN_SET_MISMATCH
    const mismatchRes = await handleConsoleDomainChangeRequest(
      makeConsolePost(
        "/api/console/domains/change",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F10",
          hostname: "www.mitraset.id",
          confirmHostname: "www.mitraset.id",
          confirmRemoveLocked: true,
          removeDomainSet: false,
          newHostname: "www.domainlain.id",
          expectedVersion: 1,
          reason: "Mencoba ganti sebagian domain dengan nama beda",
        },
        "idemp-f2-mismatch-01",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS, cloudflareClient: createMockCloudflareClient() },
    );
    expect(mismatchRes.status).toBe(422);
    expect(((await mismatchRes.json()) as { code: string }).code).toBe("DOMAIN_SET_MISMATCH");

    // Finding 2b: SQL-level 2-custom-hostname cap rejects 3rd host in finalizeOperatorDomainChange
    await seedTenantWithDomains({
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F11",
      orgId: "org-11",
      handle: "mitra-cap",
      name: "Mitra Cap",
      status: "active",
      customHosts: [
        {
          host: "www.mitracap.id",
          cfId: "cf-mc-1",
          status: "deleting",
          sslStatus: "active",
        },
        {
          host: "mitracap.id",
          cfId: "cf-mc-2",
          status: "active",
          sslStatus: "active",
        },
        {
          host: "extra.mitracap.id",
          cfId: "cf-mc-3",
          status: "active",
          sslStatus: "active",
        },
      ],
    });

    await expect(
      finalizeOperatorDomainChange(env.PLATFORM_DB, {
        plan: {
          outcome: "proceed",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F11",
          tenantHandle: "mitra-cap",
          tenantStatus: "active",
          tenantEffectiveStatus: "active",
          tenantOperatorHold: false,
          primaryTarget: {
            id: 2,
            tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F11",
            hostname: "www.mitracap.id",
            kind: "custom",
            cfCustomHostnameId: "cf-mc-1",
            status: "deleting",
            sslStatus: "active",
            isPrimary: false,
            verifiedAt: null,
            lastCheckedAt: BASE_NOW_MS,
            quarantinedUntil: null,
            version: 1,
            createdAt: BASE_NOW_MS,
            updatedAt: BASE_NOW_MS,
            connectMode: "new_domain",
            sslMethod: "http",
            certificateAuthority: null,
            tokenIssuedAt: null,
            tokenExpiresAt: null,
            providerStatus: null,
            providerSslStatus: null,
            providerSnapshot: null,
            dnsTargetObserved: null,
            httpsProbePassed: false,
            httpsProbeCheckedAt: null,
            failureCode: null,
            everActivated: true,
            lastRecheckAt: null,
            lastRenewalAlertAt: null,
            lastRenewalAlertKey: null,
            idempotencyKey: null,
          },
          targetsToRemove: [
            {
              id: 2,
              tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F11",
              hostname: "www.mitracap.id",
              kind: "custom",
              cfCustomHostnameId: "cf-mc-1",
              status: "deleting",
              sslStatus: "active",
              isPrimary: false,
              verifiedAt: null,
              lastCheckedAt: BASE_NOW_MS,
              quarantinedUntil: null,
              version: 1,
              createdAt: BASE_NOW_MS,
              updatedAt: BASE_NOW_MS,
              connectMode: "new_domain",
              sslMethod: "http",
              certificateAuthority: null,
              tokenIssuedAt: null,
              tokenExpiresAt: null,
              providerStatus: null,
              providerSslStatus: null,
              providerSnapshot: null,
              dnsTargetObserved: null,
              httpsProbePassed: false,
              httpsProbeCheckedAt: null,
              failureCode: null,
              everActivated: true,
              lastRecheckAt: null,
              lastRenewalAlertAt: null,
              lastRenewalAlertKey: null,
              idempotencyKey: null,
            },
          ],
          newHostname: "shop.mitracap.id",
          connectMode: "new_domain",
          sslMethod: "http",
          cleanReason: "Uji SQL cap 2 hostname pada finalisasi ganti domain",
          cleanIdempotencyKey: "idemp-sql-cap-01",
          ledgerKey: "console-domain-change:idemp-sql-cap-01",
          requestHash: "hash-sql-cap-01",
        },
        deletingVersion: 1,
        actorUserId: op.userId,
        requestId: "req_sql_cap",
        nowMs: BASE_NOW_MS,
      }),
    ).rejects.toMatchObject({ code: "DOMAIN_LIMIT_REACHED" });

    // Finding 1: non-retryable provider failure during createCustomHostname records error audit + keeps receipt replayable!
    const badRequestCf = createMockCloudflareClient({
      async createCustomHostname() {
        throw new DomainProviderError("bad_request", "Cloudflare rejected hostname", {
          statusCode: 400,
          retryable: false,
        });
      },
    });
    const nonRetryableRes = await handleConsoleDomainChangeRequest(
      makeConsolePost(
        "/api/console/domains/change",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F10",
          hostname: "www.mitraset.id",
          confirmHostname: "www.mitraset.id",
          confirmRemoveLocked: true,
          removeDomainSet: true,
          newHostname: "www.mitrabaru.id",
          connectMode: "new_domain",
          expectedVersion: 1,
          reason: "Ganti domain saat Cloudflare menolak hostname baru",
        },
        "idemp-f1-nonretry-01",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS + 2000, cloudflareClient: badRequestCf },
    );
    expect(nonRetryableRes.status).toBe(502);
    const nonRetryBody = (await nonRetryableRes.json()) as {
      code: string;
      reasonCode: string;
      newDomain: { hostname: string; status: string; failureCode: string | null };
    };
    expect(nonRetryBody.code).toBe("PROVIDER_UNAVAILABLE");
    expect(nonRetryBody.reasonCode).toBe("PROVIDER_BAD_REQUEST");
    expect(nonRetryBody.newDomain.status).toBe("pending");
    expect(nonRetryBody.newDomain.failureCode).toBe("PROVIDER_BAD_REQUEST");

    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F10",
    });
    expect(audits.some((a) => a.action === "console.domain.change.provider_failed")).toBe(true);

    // Replaying same Idempotency-Key replays cleanly (200 replayed: true) instead of 404!
    const replayAfterFail = await handleConsoleDomainChangeRequest(
      makeConsolePost(
        "/api/console/domains/change",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F10",
          hostname: "www.mitraset.id",
          confirmHostname: "www.mitraset.id",
          confirmRemoveLocked: true,
          removeDomainSet: true,
          newHostname: "www.mitrabaru.id",
          connectMode: "new_domain",
          expectedVersion: 1,
          reason: "Ganti domain saat Cloudflare menolak hostname baru",
        },
        "idemp-f1-nonretry-01",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS + 3000, cloudflareClient: badRequestCf },
    );
    expect(replayAfterFail.status).toBe(200);
    expect(((await replayAfterFail.json()) as { replayed: boolean }).replayed).toBe(true);
  });

  it("Finding 3 & 4: losing concurrent writer mutates ZERO metadata/cache rows, and provider timeout preserves moved status", async () => {
    const op = await setupActive2faOperator("op-f34@punyasitus.com");
    await seedTenantWithDomains({
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F12",
      orgId: "org-12",
      handle: "moved-site",
      name: "Moved Site",
      status: "active",
      customHosts: [
        {
          host: "www.movedsite.id",
          cfId: "cf-moved-1",
          status: "moved",
          sslStatus: "pending_validation",
        },
      ],
    });

    // Finding 4: provider timeout preserves `moved` status AND preserves `version = 1`
    const timeoutCf = createMockCloudflareClient({
      async patchCustomHostnameSsl() {
        throw new DomainProviderError("timeout", "Cloudflare timed out", { retryable: true });
      },
    });
    const movedTimeoutRes = await handleConsoleDomainRecheckRequest(
      makeConsolePost(
        "/api/console/domains/recheck",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F12",
          hostname: "www.movedsite.id",
          expectedVersion: 1,
          reason: "Cek ulang hostname status moved saat timeout",
        },
        "idemp-moved-timeout-01",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS, cloudflareClient: timeoutCf },
    );
    expect(movedTimeoutRes.status).toBe(503);
    const movedBody = (await movedTimeoutRes.json()) as {
      expectedVersion: number;
      domain: { status: string; version: number; failureCode: string };
    };
    expect(movedBody.domain.status).toBe("moved");
    expect(movedBody.domain.version).toBe(1);
    expect(movedBody.expectedVersion).toBe(1);
    expect(movedBody.domain.failureCode).toBe("PROVIDER_TIMEOUT");

    // Finding 3: simulate concurrent winner advancing version 1 -> 2, then losing writer with expectedVersion 1 runs
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        "UPDATE tenant_hosts SET version = 2, updated_at = ? WHERE host = 'www.movedsite.id'",
      ).bind(BASE_NOW_MS + 100),
      env.PLATFORM_DB.prepare(
        "UPDATE tenant_host_metadata SET provider_status = 'winner_status', failure_code = NULL WHERE host = 'www.movedsite.id'",
      ),
      env.PLATFORM_DB.prepare(
        "UPDATE tenants SET cache_version = 5 WHERE id = '01ARZ3NDEKTSV4RRFFQ69G5F12'",
      ),
    ]);

    await expect(
      commitOperatorDomainRecheck(env.PLATFORM_DB, {
        actorUserId: op.userId,
        tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F12",
        record: {
          id: 2,
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F12",
          hostname: "www.movedsite.id",
          kind: "custom",
          cfCustomHostnameId: "cf-moved-1",
          status: "moved",
          sslStatus: "pending_validation",
          isPrimary: false,
          verifiedAt: null,
          lastCheckedAt: BASE_NOW_MS,
          quarantinedUntil: null,
          version: 1,
          createdAt: BASE_NOW_MS,
          updatedAt: BASE_NOW_MS,
          connectMode: "new_domain",
          sslMethod: "http",
          certificateAuthority: null,
          tokenIssuedAt: null,
          tokenExpiresAt: null,
          providerStatus: "moved",
          providerSslStatus: "pending_validation",
          providerSnapshot: null,
          dnsTargetObserved: null,
          httpsProbePassed: false,
          httpsProbeCheckedAt: null,
          failureCode: null,
          everActivated: false,
          lastRecheckAt: null,
          lastRenewalAlertAt: null,
          lastRenewalAlertKey: null,
          idempotencyKey: null,
        },
        expectedVersion: 1,
        reason: "Penulis kalah race condition tidak boleh ubah metadata",
        idempotencyKey: "idemp-loser-race-01",
        ledgerKey: "console-domain-recheck:idemp-loser-race-01",
        requestHash: "hash-loser-race-01",
        requestId: "req_loser_race",
        nowMs: BASE_NOW_MS + 200,
        connectMode: "new_domain",
        sslMethod: "http",
        provider: {
          id: "cf-moved-1",
          hostname: "www.movedsite.id",
          status: "active",
          ssl: { status: "active", method: "http", type: "dv" },
        },
        cnameMatchesTarget: true,
        dnsTargetObserved: "cname.situsku.click",
        tokenRefreshed: false,
      }),
    ).rejects.toThrow(ConsoleRecoveryError);

    // Winner's metadata and tenant cache_version are 100% untouched!
    const metaAfter = await env.PLATFORM_DB.prepare(
      "SELECT provider_status FROM tenant_host_metadata WHERE host = 'www.movedsite.id'",
    ).first<{ provider_status: string }>();
    expect(metaAfter?.provider_status).toBe("winner_status");

    const tenantCacheAfter = await env.PLATFORM_DB.prepare(
      "SELECT cache_version FROM tenants WHERE id = '01ARZ3NDEKTSV4RRFFQ69G5F12'",
    ).first<{ cache_version: number }>();
    expect(tenantCacheAfter?.cache_version).toBe(5);
  });

  it("Finding 5, 6 & 7: reverts job on missing/failing queue, allows stale queued retry, rejects path/body mismatch, enforces retry cap, and redacts sensitive job keys", async () => {
    const op = await setupActive2faOperator("op-f567@punyasitus.com");
    await seedTenantWithDomains({
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F13",
      orgId: "org-13",
      handle: "queue-ops",
      name: "Queue Ops",
      status: "active",
      customHosts: [
        {
          host: "www.queueops.id",
          cfId: "cf-qo-1",
          status: "pending",
          sslStatus: "pending_validation",
        },
      ],
    });

    // Finding 6: path-vs-body mismatch returns 422 on both domain recheck and job retry
    const hostMismatch = await handleConsoleDomainRecheckRequest(
      makeConsolePost(
        "/api/console/domains/www.queueops.id/recheck",
        op.cookieHeader,
        {
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F13",
          hostname: "www.different.id",
          expectedVersion: 1,
          reason: "Menguji ketidakcocokan path dan body hostname",
        },
        "idemp-path-host-mismatch-01",
      ),
      buildDomainsEnv(),
      { nowMs: BASE_NOW_MS, pathHostname: "www.queueops.id" },
    );
    expect(hostMismatch.status).toBe(422);

    const jobMismatch = await handleConsoleJobRetryRequest(
      makeConsolePost(
        "/api/console/jobs/job-a/retry",
        op.cookieHeader,
        {
          jobIdempotencyKey: "job-b",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F13",
          expectedUpdatedAt: BASE_NOW_MS,
          reason: "Menguji ketidakcocokan path dan body job key",
        },
        "idemp-path-job-mismatch-01",
      ),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS, pathJobKey: "job-a" },
    );
    expect(jobMismatch.status).toBe(422);

    // Seed jobs: failed (for missing/failing queue & retry cap), stale queued (> 5m), fresh queued (< 5m), and PII key
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO job_ledger (
           idempotency_key, topic, tenant_id, status, attempts, lease_until,
           last_error_code, payload_json, created_at, updated_at
         ) VALUES
           ('job-q-missing', 'email.send', '01ARZ3NDEKTSV4RRFFQ69G5F13', 'failed', 1, NULL, 'ERR_1', '{}', ?, ?),
           ('job-stale-queued', 'media.og', '01ARZ3NDEKTSV4RRFFQ69G5F13', 'queued', 0, NULL, NULL, '{}', ?, ?),
           ('job-fresh-queued', 'media.og', '01ARZ3NDEKTSV4RRFFQ69G5F13', 'queued', 0, NULL, NULL, '{}', ?, ?),
           ('email-key:owner@rahasia.id:001', 'email.send', '01ARZ3NDEKTSV4RRFFQ69G5F13', 'failed', 1, NULL, 'SMTP_ERR', '{}', ?, ?)`,
      ).bind(
        BASE_NOW_MS - 60_000,
        BASE_NOW_MS - 30_000,
        BASE_NOW_MS - 10 * 60_000,
        BASE_NOW_MS - 6 * 60_000, // stale queued (> 5m)
        BASE_NOW_MS - 60_000,
        BASE_NOW_MS - 20_000, // fresh queued (< 5m)
        BASE_NOW_MS - 60_000,
        BASE_NOW_MS - 40_000,
      ),
    ]);

    // Finding 7: email embedded inside idempotencyKey is redacted in GET /api/console/jobs
    const jobsListRes = await handleConsoleJobsListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/jobs?status=all`, {
        headers: { Cookie: op.cookieHeader },
      }),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS },
    );
    const jobsListText = await jobsListRes.text();
    expect(jobsListText).not.toContain("owner@rahasia.id");
    expect(jobsListText).toContain("email-key:[REDACTED]:001");

    // Finding 5a: missing JOBS_QUEUE reverts job to `failed` (`QUEUE_UNAVAILABLE`) and returns 503!
    const noQueueRes = await handleConsoleJobRetryRequest(
      makeConsolePost(
        "/api/console/jobs/retry",
        op.cookieHeader,
        {
          jobIdempotencyKey: "job-q-missing",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F13",
          expectedUpdatedAt: BASE_NOW_MS - 30_000,
          reason: "Retry saat JOBS_QUEUE tidak terpasang",
        },
        "idemp-no-queue-01",
      ),
      buildJobsEnv({ JOBS_QUEUE: null }),
      { nowMs: BASE_NOW_MS, jobsQueue: null },
    );
    expect(noQueueRes.status).toBe(503);
    const noQueueBody = (await noQueueRes.json()) as {
      reasonCode: string;
      job: { status: string; lastErrorCode: string };
    };
    expect(noQueueBody.reasonCode).toBe("QUEUE_UNAVAILABLE");
    expect(noQueueBody.job.status).toBe("failed");
    expect(noQueueBody.job.lastErrorCode).toBe("QUEUE_UNAVAILABLE");

    // Finding 5b: stale queued job (> 5m) IS retry-eligible; fresh queued job (< 5m) is rejected 409!
    const sent: unknown[] = [];
    const okQueue = {
      async send(msg: unknown) {
        sent.push(msg);
      },
    };
    const freshQueuedRes = await handleConsoleJobRetryRequest(
      makeConsolePost(
        "/api/console/jobs/retry",
        op.cookieHeader,
        {
          jobIdempotencyKey: "job-fresh-queued",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F13",
          expectedUpdatedAt: BASE_NOW_MS - 20_000,
          reason: "Mencoba retry job queued yang masih baru",
        },
        "idemp-fresh-q-01",
      ),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS, jobsQueue: okQueue },
    );
    expect(freshQueuedRes.status).toBe(409);
    expect(((await freshQueuedRes.json()) as { code: string }).code).toBe("JOB_NOT_RETRYABLE");

    const staleQueuedRes = await handleConsoleJobRetryRequest(
      makeConsolePost(
        "/api/console/jobs/retry",
        op.cookieHeader,
        {
          jobIdempotencyKey: "job-stale-queued",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F13",
          expectedUpdatedAt: BASE_NOW_MS - 6 * 60_000,
          reason: "Memulihkan job queued yang tertahan lebih 5 menit",
        },
        "idemp-stale-q-01",
      ),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS, jobsQueue: okQueue },
    );
    expect(staleQueuedRes.status).toBe(200);
    expect(sent).toHaveLength(1);

    // Finding 7: bounded operator retry cap (maxOperatorRetries: 1 -> 2nd retry fails 409 JOB_RETRY_LIMIT_REACHED)
    await env.PLATFORM_DB.prepare(
      "UPDATE job_ledger SET status = 'failed', updated_at = ? WHERE idempotency_key = 'job-stale-queued'",
    )
      .bind(BASE_NOW_MS + 1000)
      .run();

    const cappedRes = await handleConsoleJobRetryRequest(
      makeConsolePost(
        "/api/console/jobs/retry",
        op.cookieHeader,
        {
          jobIdempotencyKey: "job-stale-queued",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F13",
          expectedUpdatedAt: BASE_NOW_MS + 1000,
          reason: "Mencoba retry melebihi batas operator retry cap",
        },
        "idemp-capped-01",
      ),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS + 2000, jobsQueue: okQueue, maxOperatorRetries: 1 },
    );
    expect(cappedRes.status).toBe(409);
    expect(((await cappedRes.json()) as { code: string }).code).toBe("JOB_RETRY_LIMIT_REACHED");
  });

  it("Round-2 Blocking #1 & #2: throwing queue outages never burn operator retry budget, and >140-char job keys enforce exact 5-retry cap", async () => {
    const op = await setupActive2faOperator("op-r2block@punyasitus.com");
    await seedTenantWithDomains({
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F14",
      orgId: "org-14",
      handle: "r2-ops",
      name: "R2 Ops",
      status: "active",
    });

    const longJobKey = `long-job-key:${"segment-".repeat(18)}tail-001`;
    expect(longJobKey.length).toBeGreaterThan(140);

    await env.PLATFORM_DB.prepare(
      `INSERT INTO job_ledger (
         idempotency_key, topic, tenant_id, status, attempts, lease_until,
         last_error_code, payload_json, created_at, updated_at
       ) VALUES (?, 'email.send', '01ARZ3NDEKTSV4RRFFQ69G5F14', 'failed', 1, NULL, 'ERR_INIT', '{}', ?, ?)`,
    )
      .bind(longJobKey, BASE_NOW_MS - 60_000, BASE_NOW_MS - 30_000)
      .run();

    // (a) 6 consecutive throwing JOBS_QUEUE.send() outages revert job to failed (503) and NEVER burn retry budget!
    const failingQueue = {
      async send() {
        throw new Error("Simulated Cloudflare Queue outage");
      },
    };
    let currentUpdatedAt = BASE_NOW_MS - 30_000;
    for (let i = 1; i <= 6; i += 1) {
      const outageRes = await handleConsoleJobRetryRequest(
        makeConsolePost(
          "/api/console/jobs/retry",
          op.cookieHeader,
          {
            jobIdempotencyKey: longJobKey,
            tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F14",
            expectedUpdatedAt: currentUpdatedAt,
            reason: `Percobaan retry saat outage queue ke-${i}`,
          },
          `idemp-outage-${i}-0001`,
        ),
        buildJobsEnv(),
        { nowMs: BASE_NOW_MS + i * 1000, jobsQueue: failingQueue },
      );
      expect(outageRes.status).toBe(503);
      const body = (await outageRes.json()) as {
        reasonCode: string;
        job: { status: string; updatedAt: number };
      };
      expect(body.reasonCode).toBe("QUEUE_DISPATCH_FAILED");
      expect(body.job.status).toBe("failed");
      currentUpdatedAt = body.job.updatedAt;
    }

    // (b) Once queue recovers, all 5 bounded retries succeed on the >140-char key, and retry #6 fails 409 JOB_RETRY_LIMIT_REACHED!
    const okSent: unknown[] = [];
    const recoveredQueue = {
      async send(msg: unknown) {
        okSent.push(msg);
      },
    };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const retryRes = await handleConsoleJobRetryRequest(
        makeConsolePost(
          "/api/console/jobs/retry",
          op.cookieHeader,
          {
            jobIdempotencyKey: longJobKey,
            tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F14",
            expectedUpdatedAt: currentUpdatedAt,
            reason: `Retry resmi setelah queue pulih percobaan ke-${attempt}`,
          },
          `idemp-long-ok-${attempt}-0001`,
        ),
        buildJobsEnv(),
        { nowMs: BASE_NOW_MS + 10_000 + attempt * 1000, jobsQueue: recoveredQueue },
      );
      expect(retryRes.status).toBe(200);

      // Simulate worker failing again so next retry is eligible
      const nextFailTs = BASE_NOW_MS + 10_000 + attempt * 1000 + 500;
      await env.PLATFORM_DB.prepare(
        "UPDATE job_ledger SET status = 'failed', updated_at = ? WHERE idempotency_key = ?",
      )
        .bind(nextFailTs, longJobKey)
        .run();
      currentUpdatedAt = nextFailTs;
    }
    expect(okSent).toHaveLength(5);

    // Retry #6 on the >140-char key MUST hit 409 JOB_RETRY_LIMIT_REACHED!
    const sixthRetryRes = await handleConsoleJobRetryRequest(
      makeConsolePost(
        "/api/console/jobs/retry",
        op.cookieHeader,
        {
          jobIdempotencyKey: longJobKey,
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5F14",
          expectedUpdatedAt: currentUpdatedAt,
          reason: "Retry ke-6 harus ditolak oleh batas operator retry cap",
        },
        "idemp-long-ok-6-0001",
      ),
      buildJobsEnv(),
      { nowMs: BASE_NOW_MS + 20_000, jobsQueue: recoveredQueue },
    );
    expect(sixthRetryRes.status).toBe(409);
    expect(((await sixthRetryRes.json()) as { code: string }).code).toBe("JOB_RETRY_LIMIT_REACHED");
    expect(okSent).toHaveLength(5);
  });
});

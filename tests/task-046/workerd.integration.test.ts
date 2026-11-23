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
  applyPlatformMigrations,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  ensurePlatformOperatorRolesSchema,
  listPlatformAuditEntries,
  PLATFORM_MIGRATIONS,
  revokePlatformOperator,
} from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  handleConsoleTenantDetailRequest,
  handleConsoleTenantsCollectionRequest,
  handleConsoleTenantStateActionRequest,
  handleConsoleTenantThemesRequest,
  type ConsoleTenantsRuntimeEnv,
} from "../../apps/web/src/pages/api/console/tenants/_shared.ts";
import { authorizeConsoleTenantsPage } from "../../apps/web/src/pages/console/tenants/_page-guard.ts";

const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_ORIGIN = "https://app.punyasitus.com";
const MARKETING_ORIGIN = "https://punyasitus.com";
const TENANT_ORIGIN = "https://toko-kopi.situsku.click";
const APP_SECRET = "task046-app-auth-secret-0123456789abcdef0123456789abcdef";
const CONSOLE_SECRET = "task046-console-auth-secret-fedcba9876543210fedcba987654";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 6, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function buildEnv(extra?: Partial<ConsoleTenantsRuntimeEnv>): ConsoleTenantsRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
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
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM two_factors"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM tenant_theme_entitlements"),
    env.PLATFORM_DB.prepare("DELETE FROM theme_catalog"),
    env.PLATFORM_DB.prepare("DELETE FROM invitations"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM migration_bookmarks"),
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

async function createVerifiedConsoleUser(email: string, password: string, name: string) {
  const auth = createConsoleAuth();
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name },
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
    email,
  };
}

async function setupActive2faOperator(email: string, nowMs = BASE_NOW_MS) {
  const fixture = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
    auth: createConsoleAuth(),
    email,
    password: "ConsoleOp!Pass2026",
    name: "Superadmin T046",
    nowMs,
  });
  return {
    ...fixture,
    userId: fixture.user.id,
    sessionId: fixture.session.id,
  };
}

function makeConsolePost(
  pathname: string,
  cookieHeader: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: CONSOLE_ORIGIN,
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

async function seedTenantStoreContent(
  tenantId: string,
  activeThemeId: string,
  nowMs = BASE_NOW_MS,
) {
  const stub = openTenantStoreStub(
    env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    tenantId,
  );
  await orchestrateTenantMigration(env.PLATFORM_DB, stub, tenantId, TENANT_MIGRATIONS, {
    now: () => nowMs,
  });
  const tenantDb = createTenantDb(stub);

  await tenantDb.batch([
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO site_settings (
          id, site_title, tagline, timezone, locale, active_theme_id,
          blog_enabled, catalog_enabled, ai_training_policy, version, updated_at
        ) VALUES (1, 'Situs Uji T046', 'Tagline Aman', 'Asia/Jakarta', 'id-ID', ?, 1, 1, 'allow', 2, ?)`,
      )
      .bind(activeThemeId, nowMs),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO pages (
          id, slug, title, is_homepage, status,
          published_sections_json, version, created_at, updated_at
        ) VALUES (101, 'tentang-kami', 'Tentang Kami', 0, 'published', '[{"id":"hero-1","type":"hero"}]', 1, ?, ?)`,
      )
      .bind(nowMs, nowMs),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO posts (
          id, slug, title, excerpt, draft_body_json, published_body_json, status, version, created_at, updated_at
        ) VALUES (201, 'artikel-pertama', 'Artikel Pertama', 'Ringkasan', '{"type":"doc","content":[]}', '{"type":"doc","content":[]}', 'published', 1, ?, ?)`,
      )
      .bind(nowMs, nowMs),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO offerings (
          id, offering_type, slug, title, price_mode, price,
          cta_mode, status, version, created_at, updated_at
        ) VALUES (301, 'service', 'jasa-konsultasi', 'Jasa Konsultasi', 'fixed', 500000, 'whatsapp', 'published', 1, ?, ?)`,
      )
      .bind(nowMs, nowMs),
  ]);

  // Reflect initialized schema version in PLATFORM_DB
  await env.PLATFORM_DB.prepare("UPDATE tenants SET schema_version = ? WHERE id = ?")
    .bind(TENANT_MIGRATIONS[TENANT_MIGRATIONS.length - 1]!.version, tenantId)
    .run();

  return tenantDb;
}

describe("TASK-046 workerd integration — Superadmin Tenant Directory, Scoped State & Theme Operations", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetTables();
  });

  it("1. returns bare neutral 404 (never Console Operasional HTML) on non-console hosts for pages and APIs", async () => {
    const op = await setupActive2faOperator("t046-host@punyasitus.com");
    const runtimeEnv = buildEnv();

    for (const origin of [APP_ORIGIN, MARKETING_ORIGIN, TENANT_ORIGIN]) {
      // SSR Page gate
      const pageGate = await authorizeConsoleTenantsPage(
        new Request(`${origin}/console/tenants`, { headers: { Cookie: op.cookieHeader } }),
        runtimeEnv,
        "console.tenants.directory.view",
        { nowMs: BASE_NOW_MS },
      );
      expect(pageGate.ok).toBe(false);
      if (!pageGate.ok) {
        expect(pageGate.response.status).toBe(404);
        expect(pageGate.response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(pageGate.response.headers.get("cache-control")).toBe("private, no-store");
        expect(pageGate.response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        const body = await pageGate.response.text();
        expect(body).toBe("Not Found");
        expect(body).not.toContain("Console Operasional");
      }

      // API collection, detail, state, themes
      const apiResponses = await Promise.all([
        handleConsoleTenantsCollectionRequest(
          new Request(`${origin}/api/console/tenants`, { headers: { Cookie: op.cookieHeader } }),
          runtimeEnv,
          { nowMs: BASE_NOW_MS },
        ),
        handleConsoleTenantDetailRequest(
          "alpha-demo",
          new Request(`${origin}/api/console/tenants/alpha-demo`, {
            headers: { Cookie: op.cookieHeader },
          }),
          runtimeEnv,
          { nowMs: BASE_NOW_MS },
        ),
        handleConsoleTenantStateActionRequest(
          "alpha-demo",
          new Request(`${origin}/api/console/tenants/alpha-demo/state`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: origin,
              Cookie: op.cookieHeader,
            },
            body: JSON.stringify({}),
          }),
          runtimeEnv,
          { nowMs: BASE_NOW_MS },
        ),
        handleConsoleTenantThemesRequest(
          "alpha-demo",
          new Request(`${origin}/api/console/tenants/alpha-demo/themes`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: origin,
              Cookie: op.cookieHeader,
            },
            body: JSON.stringify({}),
          }),
          runtimeEnv,
          { nowMs: BASE_NOW_MS },
        ),
      ]);

      for (const res of apiResponses) {
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(await res.text()).toBe("Not Found");
      }
    }
  });

  it("2. denies anonymous, tenant owner/editor, unenrolled 2FA, stale step-up 2FA, and revoked operators", async () => {
    const op1 = await setupActive2faOperator("t046-op1@punyasitus.com");
    const op2 = await setupActive2faOperator("t046-op2@punyasitus.com");
    const tenantOwner = await createVerifiedConsoleUser(
      "t046-owner@klien.id",
      "TenantOwner!Pass2026",
      "Pemilik Situs",
    );
    const runtimeEnv = buildEnv();

    // Provision a tenant whose owner IS tenantOwner (verified org owner role MUST NOT grant console access!)
    const provRes = await handleConsoleTenantsCollectionRequest(
      makeConsolePost(
        "/api/console/tenants",
        op1.cookieHeader,
        {
          handle: "klien-owner-test",
          name: "PT Klien Owner Test",
          ownerEmail: tenantOwner.email,
          vertical: "compro",
          initialStatus: "trial",
          reason: "Provisioning tenant uji otorisasi pemilik organisasi",
        },
        "t046-prov-authz-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(provRes.status).toBe(201);
    const provJson = (await provRes.json()) as { tenant: { id: string; handle: string; version: number } };

    // Anonymous -> 401
    const anonRes = await handleConsoleTenantsCollectionRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants`),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(anonRes.status).toBe(401);

    // Tenant owner (even with active org owner membership!) -> 403 PLATFORM_OPERATOR_REQUIRED on all endpoints
    const ownerListRes = await handleConsoleTenantsCollectionRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants`, {
        headers: { Cookie: tenantOwner.cookieHeader },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(ownerListRes.status).toBe(403);
    expect(((await ownerListRes.json()) as { code: string }).code).toBe("PLATFORM_OPERATOR_REQUIRED");

    const ownerStateRes = await handleConsoleTenantStateActionRequest(
      provJson.tenant.id,
      makeConsolePost(
        `/api/console/tenants/${provJson.tenant.id}/state`,
        tenantOwner.cookieHeader,
        {
          action: "suspend_hold",
          reason: "Pemilik tenant mencoba hold dirinya sendiri",
          expectedVersion: provJson.tenant.version,
        },
        "t046-owner-state-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(ownerStateRes.status).toBe(403);

    const ownerThemeRes = await handleConsoleTenantThemesRequest(
      provJson.tenant.id,
      makeConsolePost(
        `/api/console/tenants/${provJson.tenant.id}/themes`,
        tenantOwner.cookieHeader,
        {
          themeId: "custom-sample-agency",
          action: "grant",
          reason: "Pemilik tenant mencoba memberi tema kustom sendiri",
          expectedVersion: provJson.tenant.version,
        },
        "t046-owner-theme-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(ownerThemeRes.status).toBe(403);

    // Bad CSRF Origin on POST -> 403
    const badOriginRes = await handleConsoleTenantStateActionRequest(
      provJson.tenant.id,
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants/${provJson.tenant.id}/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          Cookie: op1.cookieHeader,
          "Idempotency-Key": "t046-bad-origin-001",
        },
        body: JSON.stringify({
          action: "suspend_hold",
          reason: "Permintaan lintas asal berbahaya harus ditolak",
          expectedVersion: provJson.tenant.version,
        }),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(badOriginRes.status).toBe(403);

    // Stale 2FA (> 10 minutes ago): GET succeeds, POST mutation returns 403 REAUTH_REQUIRED
    const staleNowMs = BASE_NOW_MS + DEFAULT_SECOND_FACTOR_WINDOW_MS + 60_000;
    // Keep session idle timestamp fresh so only 2FA step-up is stale
    await env.PLATFORM_DB.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .bind(staleNowMs - 10_000, op1.sessionId)
      .run();

    const staleGetRes = await handleConsoleTenantDetailRequest(
      provJson.tenant.handle,
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants/${provJson.tenant.handle}`, {
        headers: { Cookie: op1.cookieHeader },
      }),
      runtimeEnv,
      { nowMs: staleNowMs },
    );
    expect(staleGetRes.status).toBe(200);

    const staleStateRes = await handleConsoleTenantStateActionRequest(
      provJson.tenant.id,
      makeConsolePost(
        `/api/console/tenants/${provJson.tenant.id}/state`,
        op1.cookieHeader,
        {
          action: "suspend_hold",
          reason: "Mencoba mutasi dengan 2FA step-up yang sudah usang",
          expectedVersion: provJson.tenant.version,
        },
        "t046-stale-2fa-001",
      ),
      runtimeEnv,
      { nowMs: staleNowMs },
    );
    expect(staleStateRes.status).toBe(403);
    expect(((await staleStateRes.json()) as { code: string }).code).toBe("REAUTH_REQUIRED");

    // Revoke op2 -> op2's still-valid session fails IMMEDIATELY with 403 OPERATOR_REVOKED
    await revokePlatformOperator(env.PLATFORM_DB, {
      actorUserId: op1.userId,
      targetUserId: op2.userId,
      reason: "Pencabutan akses operator kedua selesai piket",
      nowMs: BASE_NOW_MS + 5_000,
    });

    const revokedRes = await handleConsoleTenantsCollectionRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants`, {
        headers: { Cookie: op2.cookieHeader },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6_000 },
    );
    expect(revokedRes.status).toBe(403);
    expect(((await revokedRes.json()) as { code: string }).code).toBe("OPERATOR_REVOKED");
  });

  it("3. lists, searches (name/handle/ID/custom host), filters, paginates, and provisions idempotently", async () => {
    const op = await setupActive2faOperator("t046-dir@punyasitus.com");
    const runtimeEnv = buildEnv();

    const specs = [
      {
        handle: "alpha-compro",
        name: "PT Alpha Konsultan",
        ownerEmail: "alpha@example.com",
        vertical: "compro",
        initialStatus: "active",
        key: "t046-dir-prov-001",
      },
      {
        handle: "beta-travel",
        name: "CV Beta Umrah Travel",
        ownerEmail: "beta@example.com",
        vertical: "travel",
        initialStatus: "trial",
        key: "t046-dir-prov-002",
      },
      {
        handle: "gamma-dealer",
        name: "Showroom Gamma Motor",
        ownerEmail: "gamma@example.com",
        vertical: "dealer",
        initialStatus: "active",
        key: "t046-dir-prov-003",
      },
    ] as const;

    const createdIds: Record<string, string> = {};
    for (let i = 0; i < specs.length; i += 1) {
      const s = specs[i]!;
      const res = await handleConsoleTenantsCollectionRequest(
        makeConsolePost(
          "/api/console/tenants",
          op.cookieHeader,
          {
            handle: s.handle,
            name: s.name,
            ownerEmail: s.ownerEmail,
            vertical: s.vertical,
            initialStatus: s.initialStatus,
            reason: `Provisioning tenant direktori uji #${i + 1}`,
          },
          s.key,
        ),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + i * 1_000 },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { tenant: { id: string } };
      createdIds[s.handle] = body.tenant.id;
    }

    // Idempotent replay -> 200 replayed: true, zero duplicate tenant
    const replayRes = await handleConsoleTenantsCollectionRequest(
      makeConsolePost(
        "/api/console/tenants",
        op.cookieHeader,
        {
          handle: "alpha-compro",
          name: "PT Alpha Konsultan",
          ownerEmail: "alpha@example.com",
          vertical: "compro",
          initialStatus: "active",
          reason: "Provisioning tenant direktori uji #1",
        },
        "t046-dir-prov-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5_000 },
    );
    expect(replayRes.status).toBe(200);
    expect(((await replayRes.json()) as { replayed: boolean }).replayed).toBe(true);

    // Add custom domain to beta-travel to prove hostname search works
    await env.PLATFORM_DB.prepare(
      `INSERT INTO tenant_hosts (
        host, tenant_id, kind, status, ssl_status, is_primary, version, created_at, updated_at
      ) VALUES ('www.betaumrah.id', ?, 'custom', 'active', 'active', 0, 1, ?, ?)`,
    )
      .bind(createdIds["beta-travel"], BASE_NOW_MS, BASE_NOW_MS)
      .run();

    // Pagination page=1&limit=2 -> 2 items, totalCount=3, hasMore=true
    const page1Res = await handleConsoleTenantsCollectionRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants?page=1&limit=2`, {
        headers: { Cookie: op.cookieHeader },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10_000 },
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      items: { handle: string }[];
      totalCount: number;
      totalPages: number;
      hasMore: boolean;
    };
    expect(page1.items.length).toBe(2);
    expect(page1.totalCount).toBe(3);
    expect(page1.totalPages).toBe(2);
    expect(page1.hasMore).toBe(true);

    // Search by custom hostname
    const hostSearchRes = await handleConsoleTenantsCollectionRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants?search=betaumrah.id`, {
        headers: { Cookie: op.cookieHeader },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10_000 },
    );
    expect(hostSearchRes.status).toBe(200);
    const hostSearch = (await hostSearchRes.json()) as { items: { handle: string }[] };
    expect(hostSearch.items.map((x) => x.handle)).toEqual(["beta-travel"]);

    // Filter by status=active&vertical=dealer
    const filterRes = await handleConsoleTenantsCollectionRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants?status=active&vertical=dealer`, {
        headers: { Cookie: op.cookieHeader },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10_000 },
    );
    expect(filterRes.status).toBe(200);
    const filtered = (await filterRes.json()) as { items: { handle: string }[] };
    expect(filtered.items.map((x) => x.handle)).toEqual(["gamma-dealer"]);
  });

  it("4. enforces strict state transition matrix, expectedVersion, idempotency, and rolls back atomically on audit failure", async () => {
    const op = await setupActive2faOperator("t046-state@punyasitus.com");
    const runtimeEnv = buildEnv();

    const provRes = await handleConsoleTenantsCollectionRequest(
      makeConsolePost(
        "/api/console/tenants",
        op.cookieHeader,
        {
          handle: "state-matrix-biz",
          name: "PT State Matrix",
          ownerEmail: "owner@statematrix.id",
          vertical: "compro",
          initialStatus: "active",
          paidThroughMs: BASE_NOW_MS + 10 * DAY_MS,
          reason: "Provisioning tenant uji transisi status layanan",
        },
        "t046-state-prov-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(provRes.status).toBe(201);
    const { tenant } = (await provRes.json()) as { tenant: { id: string; version: number } };

    // Unknown field rejected -> 422 UNKNOWN_FIELD
    const unknownRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "suspend_hold",
          reason: "Alasan valid namun ada field asing",
          expectedVersion: tenant.version,
          evilExtra: true,
        },
        "t046-state-unk-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(unknownRes.status).toBe(422);

    // Invalid transition: release_hold when NOT held -> 409 INVALID_STATE_TRANSITION
    const invalidReleaseRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "release_hold",
          reason: "Mencoba melepas hold pada tenant yang tidak sedang ditangguhkan",
          expectedVersion: tenant.version,
        },
        "t046-state-invalid-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_000 },
    );
    expect(invalidReleaseRes.status).toBe(409);
    expect(((await invalidReleaseRes.json()) as { code: string }).code).toBe(
      "INVALID_STATE_TRANSITION",
    );

    // Stale expectedVersion -> 409 STALE_VERSION
    const staleVerRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "suspend_hold",
          reason: "Penangguhan dengan versi usang harus ditolak",
          expectedVersion: 99,
        },
        "t046-state-stale-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_000 },
    );
    expect(staleVerRes.status).toBe(409);
    expect(((await staleVerRes.json()) as { code: string }).code).toBe("STALE_VERSION");

    // Atomic Audit Failure Rollback proof!
    await env.PLATFORM_DB.prepare(
      `CREATE TRIGGER test_t046_abort_audit_insert
       BEFORE INSERT ON platform_audit
       WHEN NEW.action = 'tenant.state.suspend_hold'
       BEGIN
         SELECT RAISE(ABORT, 'simulated audit disk failure');
       END`,
    ).run();

    try {
      const rollbackRes = await handleConsoleTenantStateActionRequest(
        tenant.id,
        makeConsolePost(
          `/api/console/tenants/${tenant.id}/state`,
          op.cookieHeader,
          {
            action: "suspend_hold",
            reason: "Uji rollback atomik jika catatan audit gagal ditulis",
            expectedVersion: tenant.version,
          },
          "t046-state-rollback-001",
        ),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 4_000 },
      );
      expect(rollbackRes.status).toBe(500);
      expect(((await rollbackRes.json()) as { code: string }).code).toBe(
        "AUDIT_PERSISTENCE_FAILED",
      );

      // Verify tenant row is 100% UNCHANGED!
      const afterRollback = await env.PLATFORM_DB.prepare(
        "SELECT status, operator_hold, version FROM tenants WHERE id = ?",
      )
        .bind(tenant.id)
        .first<{ status: string; operator_hold: number; version: number }>();
      expect(afterRollback).toEqual({
        status: "active",
        operator_hold: 0,
        version: tenant.version,
      });
    } finally {
      await env.PLATFORM_DB.prepare("DROP TRIGGER IF EXISTS test_t046_abort_audit_insert").run();
    }

    // Valid suspend_hold -> 200, version + 1, operatorHold true
    const holdRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "suspend_hold",
          reason: "Penangguhan teraudit atas laporan penyalahgunaan valid #AB-77",
          expectedVersion: tenant.version,
        },
        "t046-state-hold-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5_000 },
    );
    expect(holdRes.status).toBe(200);
    const holdJson = (await holdRes.json()) as {
      replayed: boolean;
      tenant: { status: string; operatorHold: boolean; version: number };
      auditId: string;
    };
    expect(holdJson.replayed).toBe(false);
    expect(holdJson.tenant.status).toBe("suspended");
    expect(holdJson.tenant.operatorHold).toBe(true);
    expect(holdJson.tenant.version).toBe(tenant.version + 1);
    expect(holdJson.auditId).toBeTruthy();

    // Idempotent replay of suspend_hold -> 200 replayed: true (does NOT fail transition matrix!)
    const replayHoldRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "suspend_hold",
          reason: "Penangguhan teraudit atas laporan penyalahgunaan valid #AB-77",
          expectedVersion: tenant.version,
        },
        "t046-state-hold-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6_000 },
    );
    expect(replayHoldRes.status).toBe(200);
    expect(((await replayHoldRes.json()) as { replayed: boolean }).replayed).toBe(true);

    // Mismatched idempotency key (different action) -> 409 IDEMPOTENCY_CONFLICT
    const mismatchRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "release_hold",
          reason: "Mencoba pakai ulang idempotency key untuk aksi berbeda",
          expectedVersion: holdJson.tenant.version,
        },
        "t046-state-hold-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7_000 },
    );
    expect(mismatchRes.status).toBe(409);
    expect(((await mismatchRes.json()) as { code: string }).code).toBe("IDEMPOTENCY_CONFLICT");

    // Release hold after paidThrough has expired -> recomputes to suspended (NEVER grants free active time!)
    const expiredNowMs = BASE_NOW_MS + 25 * DAY_MS;
    await env.PLATFORM_DB.prepare("UPDATE sessions SET updated_at = ?, expires_at = ? WHERE id = ?")
      .bind(expiredNowMs - 1_000, expiredNowMs + 60 * 60 * 1000, op.sessionId)
      .run();
    await recordSessionSecondFactorVerification(env.PLATFORM_DB, {
      sessionId: op.sessionId,
      userId: op.userId,
      method: "totp",
      nowMs: expiredNowMs - 1_000,
    });
    // Also shift session created_at so 8h absolute ceiling passes at simulated +25d
    await env.PLATFORM_DB.prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
      .bind(expiredNowMs - 5_000, op.sessionId)
      .run();

    const releaseRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "release_hold",
          reason: "Hold dilepas setelah masa langganan kedaluwarsa, wajib hitung ulang",
          expectedVersion: holdJson.tenant.version,
        },
        "t046-state-release-001",
      ),
      runtimeEnv,
      { nowMs: expiredNowMs },
    );
    expect(releaseRes.status).toBe(200);
    const releaseJson = (await releaseRes.json()) as {
      tenant: { status: string; effectiveStatus: string; operatorHold: boolean; version: number };
    };
    expect(releaseJson.tenant.operatorHold).toBe(false);
    expect(releaseJson.tenant.status).toBe("suspended");
    expect(releaseJson.tenant.effectiveStatus).toBe("suspended");
    expect(releaseJson.tenant.version).toBe(holdJson.tenant.version + 1);

    // Malformed paidThroughMs / trialEndsAtMs / operatorHold types -> 422 VALIDATION_ERROR (never coerced!)
    for (const badPayload of [
      {
        action: "set_status",
        targetStatus: "active",
        paidThroughMs: "2026-12-31",
        reason: "Uji penolakan tipe string pada paidThroughMs",
        expectedVersion: releaseJson.tenant.version,
      },
      {
        action: "set_status",
        targetStatus: "trial",
        trialEndsAtMs: 12345.67,
        reason: "Uji penolakan tipe float pada trialEndsAtMs",
        expectedVersion: releaseJson.tenant.version,
      },
      {
        action: "set_status",
        targetStatus: "suspended",
        operatorHold: "false",
        reason: "Uji penolakan tipe string pada operatorHold",
        expectedVersion: releaseJson.tenant.version,
      },
    ]) {
      const badTypeRes = await handleConsoleTenantStateActionRequest(
        tenant.id,
        makeConsolePost(
          `/api/console/tenants/${tenant.id}/state`,
          op.cookieHeader,
          badPayload,
          `t046-bad-type-${Math.random().toString(16).slice(2, 10)}`,
        ),
        runtimeEnv,
        { nowMs: expiredNowMs + 1_000 },
      );
      expect(badTypeRes.status).toBe(422);
      expect(((await badTypeRes.json()) as { code: string }).code).toBe("VALIDATION_ERROR");
    }

    // Valid set_status -> active with future paidThroughMs + full canonical payload hash idempotency check
    const targetPaidThroughA = expiredNowMs + 30 * DAY_MS;
    const setStatusRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "set_status",
          targetStatus: "active",
          paidThroughMs: targetPaidThroughA,
          reason: "Aktivasi ulang manual pasca rekonsiliasi pembayaran #INV-99",
          expectedVersion: releaseJson.tenant.version,
        },
        "t046-state-setstatus-001",
      ),
      runtimeEnv,
      { nowMs: expiredNowMs + 2_000 },
    );
    expect(setStatusRes.status).toBe(200);
    const setStatusJson = (await setStatusRes.json()) as {
      replayed: boolean;
      tenant: { status: string; version: number };
    };
    expect(setStatusJson.replayed).toBe(false);
    expect(setStatusJson.tenant.status).toBe("active");

    // Identical payload replay -> 200 replayed: true
    const setStatusReplayRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "set_status",
          targetStatus: "active",
          paidThroughMs: targetPaidThroughA,
          reason: "Aktivasi ulang manual pasca rekonsiliasi pembayaran #INV-99",
          expectedVersion: releaseJson.tenant.version,
        },
        "t046-state-setstatus-001",
      ),
      runtimeEnv,
      { nowMs: expiredNowMs + 3_000 },
    );
    expect(setStatusReplayRes.status).toBe(200);
    expect(((await setStatusReplayRes.json()) as { replayed: boolean }).replayed).toBe(true);

    // Same idempotencyKey + SAME action/targetStatus, DIFFERENT paidThroughMs -> 409 IDEMPOTENCY_CONFLICT!
    const diffPaidThroughRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "set_status",
          targetStatus: "active",
          paidThroughMs: expiredNowMs + 60 * DAY_MS,
          reason: "Aktivasi ulang manual pasca rekonsiliasi pembayaran #INV-99",
          expectedVersion: releaseJson.tenant.version,
        },
        "t046-state-setstatus-001",
      ),
      runtimeEnv,
      { nowMs: expiredNowMs + 4_000 },
    );
    expect(diffPaidThroughRes.status).toBe(409);
    expect(((await diffPaidThroughRes.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_CONFLICT",
    );

    // Same idempotencyKey + DIFFERENT reason -> 409 IDEMPOTENCY_CONFLICT!
    const diffReasonRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "set_status",
          targetStatus: "active",
          paidThroughMs: targetPaidThroughA,
          reason: "Alasan audit yang berbeda dengan permintaan awal #INV-100",
          expectedVersion: releaseJson.tenant.version,
        },
        "t046-state-setstatus-001",
      ),
      runtimeEnv,
      { nowMs: expiredNowMs + 5_000 },
    );
    expect(diffReasonRes.status).toBe(409);
    expect(((await diffReasonRes.json()) as { code: string }).code).toBe("IDEMPOTENCY_CONFLICT");

    // Re-apply hold then verify set_status without explicit operatorHold is rejected (409)
    const reHoldRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "suspend_hold",
          reason: "Penangguhan ulang untuk uji proteksi set_status saat hold aktif",
          expectedVersion: setStatusJson.tenant.version,
        },
        "t046-state-rehold-001",
      ),
      runtimeEnv,
      { nowMs: expiredNowMs + 6_000 },
    );
    expect(reHoldRes.status).toBe(200);
    const reHoldJson = (await reHoldRes.json()) as { tenant: { version: number } };

    const dropHoldAttemptRes = await handleConsoleTenantStateActionRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/state`,
        op.cookieHeader,
        {
          action: "set_status",
          targetStatus: "active",
          paidThroughMs: targetPaidThroughA,
          reason: "Mencoba set_status active tanpa melepas hold secara eksplisit",
          expectedVersion: reHoldJson.tenant.version,
        },
        "t046-state-drophold-001",
      ),
      runtimeEnv,
      { nowMs: expiredNowMs + 7_000 },
    );
    expect(dropHoldAttemptRes.status).toBe(409);
    expect(((await dropHoldAttemptRes.json()) as { code: string }).code).toBe(
      "INVALID_STATE_TRANSITION",
    );
  });

  it("5. grants only registered custom themes, blocks active-theme revoke (and fails closed), rolls back on audit error, and leaves tenant content untouched", async () => {
    const op = await setupActive2faOperator("t046-themes@punyasitus.com");
    const runtimeEnv = buildEnv();

    const provRes = await handleConsoleTenantsCollectionRequest(
      makeConsolePost(
        "/api/console/tenants",
        op.cookieHeader,
        {
          handle: "theme-ops-studio",
          name: "Studio Tema Kustom",
          ownerEmail: "owner@themeops.id",
          vertical: "compro",
          initialStatus: "active",
          paidThroughMs: BASE_NOW_MS + 30 * DAY_MS,
          reason: "Provisioning tenant uji izin tema kustom teraudit",
        },
        "t046-theme-prov-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(provRes.status).toBe(201);
    const { tenant } = (await provRes.json()) as { tenant: { id: string; version: number } };

    // Seed real TenantStore content & set active_theme_id = 'compro' initially
    const tenantDb = await seedTenantStoreContent(tenant.id, "compro", BASE_NOW_MS);
    const v0 = tenant.version;
    const snapshotContent = async () => {
      const [pages, posts, offerings] = await Promise.all([
        tenantDb.prepare("SELECT id, slug, title, published_sections_json FROM pages ORDER BY id").all(),
        tenantDb.prepare("SELECT id, slug, title, published_body_json FROM posts ORDER BY id").all(),
        tenantDb.prepare("SELECT id, slug, title, price FROM offerings ORDER BY id").all(),
      ]);
      return JSON.stringify({ pages: pages.results, posts: posts.results, offerings: offerings.results });
    };
    const contentBefore = await snapshotContent();

    // 1. Reject unregistered custom theme ID -> 422 UNREGISTERED_THEME
    const unregRes = await handleConsoleTenantThemesRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/themes`,
        op.cookieHeader,
        {
          themeId: "custom-nonexistent-evil",
          action: "grant",
          reason: "Mencoba memberi tema tidak terdaftar harus ditolak 422",
          expectedVersion: v0,
        },
        "t046-theme-unreg-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(unregRes.status).toBe(422);
    expect(((await unregRes.json()) as { code: string }).code).toBe("UNREGISTERED_THEME");

    // 2. Reject built-in platform theme -> 422 BUILT_IN_THEME_NOT_GRANTABLE
    const builtInRes = await handleConsoleTenantThemesRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/themes`,
        op.cookieHeader,
        {
          themeId: "compro",
          action: "grant",
          reason: "Mencoba grant tema bawaan platform harus ditolak 422",
          expectedVersion: v0,
        },
        "t046-theme-builtin-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_000 },
    );
    expect(builtInRes.status).toBe(422);
    expect(((await builtInRes.json()) as { code: string }).code).toBe(
      "BUILT_IN_THEME_NOT_GRANTABLE",
    );

    // 3. Audit rollback on theme grant -> 500 AUDIT_PERSISTENCE_FAILED, zero grant row, version unchanged
    await env.PLATFORM_DB.prepare(
      `CREATE TRIGGER test_t046_abort_theme_grant_audit
       BEFORE INSERT ON platform_audit
       WHEN NEW.action = 'tenant.theme.grant'
       BEGIN
         SELECT RAISE(ABORT, 'simulated audit failure on theme grant');
       END`,
    ).run();
    try {
      const failGrantRes = await handleConsoleTenantThemesRequest(
        tenant.id,
        makeConsolePost(
          `/api/console/tenants/${tenant.id}/themes`,
          op.cookieHeader,
          {
            themeId: "custom-sample-agency",
            action: "grant",
            reason: "Uji rollback atomik saat audit pemberian tema gagal",
            expectedVersion: v0,
          },
          "t046-theme-grant-rollback-001",
        ),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 3_000 },
      );
      expect(failGrantRes.status).toBe(500);

      const grantCount = await env.PLATFORM_DB.prepare(
        "SELECT COUNT(*) AS cnt FROM tenant_theme_entitlements WHERE tenant_id = ?",
      )
        .bind(tenant.id)
        .first<{ cnt: number }>();
      expect(grantCount?.cnt).toBe(0);
    } finally {
      await env.PLATFORM_DB.prepare("DROP TRIGGER IF EXISTS test_t046_abort_theme_grant_audit").run();
    }

    // 4. Valid grant of registered custom theme -> 200, version + 1, audit recorded
    const grantRes = await handleConsoleTenantThemesRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/themes`,
        op.cookieHeader,
        {
          themeId: "custom-sample-agency",
          action: "grant",
          reason: "Pemberian izin tema kustom agensi terdaftar sesuai tiket #THM-46",
          expectedVersion: v0,
        },
        "t046-theme-grant-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 4_000 },
    );
    expect(grantRes.status).toBe(200);
    const grantJson = (await grantRes.json()) as {
      replayed: boolean;
      tenant: { version: number };
      grantedThemes: { themeId: string }[];
      auditId: string;
    };
    expect(grantJson.replayed).toBe(false);
    expect(grantJson.tenant.version).toBe(v0 + 1);
    expect(grantJson.grantedThemes.map((g) => g.themeId)).toEqual(["custom-sample-agency"]);
    expect(grantJson.auditId).toBeTruthy();

    // Idempotent replay of grant -> 200 replayed: true
    const grantReplayRes = await handleConsoleTenantThemesRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/themes`,
        op.cookieHeader,
        {
          themeId: "custom-sample-agency",
          action: "grant",
          reason: "Pemberian izin tema kustom agensi terdaftar sesuai tiket #THM-46",
          expectedVersion: v0,
        },
        "t046-theme-grant-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5_000 },
    );
    expect(grantReplayRes.status).toBe(200);
    expect(((await grantReplayRes.json()) as { replayed: boolean }).replayed).toBe(true);

    // 5. Activate `custom-sample-agency` in TenantStore -> revoke MUST BE BLOCKED with 409 ACTIVE_THEME_PROTECTED!
    await tenantDb
      .prepare("UPDATE site_settings SET active_theme_id = 'custom-sample-agency' WHERE id = 1")
      .run();

    const activeRevokeRes = await handleConsoleTenantThemesRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/themes`,
        op.cookieHeader,
        {
          themeId: "custom-sample-agency",
          action: "revoke",
          reason: "Mencoba mencabut tema yang sedang aktif dipakai tenant",
          expectedVersion: v0 + 1,
        },
        "t046-theme-revoke-active-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6_000 },
    );
    expect(activeRevokeRes.status).toBe(409);
    expect(((await activeRevokeRes.json()) as { code: string }).code).toBe(
      "ACTIVE_THEME_PROTECTED",
    );

    // 6. Fail-closed check: if TENANT_STORE is unavailable (null), revoke MUST FAIL CLOSED (503) and keep grant intact!
    const failClosedRes = await handleConsoleTenantThemesRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/themes`,
        op.cookieHeader,
        {
          themeId: "custom-sample-agency",
          action: "revoke",
          reason: "Uji fail-closed ketika penyimpanan tenant tidak dapat dihubungi",
          expectedVersion: v0 + 1,
        },
        "t046-theme-revoke-failclosed-001",
      ),
      buildEnv({ TENANT_STORE: null }),
      { nowMs: BASE_NOW_MS + 7_000 },
    );
    expect(failClosedRes.status).toBe(503);
    expect(((await failClosedRes.json()) as { code: string }).code).toBe(
      "ACTIVE_THEME_VERIFICATION_UNAVAILABLE",
    );

    // 7. Switch TenantStore active theme back to 'compro' -> revoke SUCCEEDS (200) and records audit!
    await tenantDb.prepare("UPDATE site_settings SET active_theme_id = 'compro' WHERE id = 1").run();

    const revokeRes = await handleConsoleTenantThemesRequest(
      tenant.id,
      makeConsolePost(
        `/api/console/tenants/${tenant.id}/themes`,
        op.cookieHeader,
        {
          themeId: "custom-sample-agency",
          action: "revoke",
          reason: "Kontrak tema kustom berakhir setelah tenant beralih ke compro",
          expectedVersion: v0 + 1,
        },
        "t046-theme-revoke-ok-001",
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 8_000 },
    );
    expect(revokeRes.status).toBe(200);
    const revokeJson = (await revokeRes.json()) as {
      tenant: { version: number };
      grantedThemes: unknown[];
      auditId: string;
    };
    expect(revokeJson.tenant.version).toBe(v0 + 2);
    expect(revokeJson.grantedThemes).toEqual([]);
    expect(revokeJson.auditId).toBeTruthy();

    // 8. Verify audit trail contains provision, grant, blocked revoke (denied), and successful revoke!
    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      tenantId: tenant.id,
      limit: 20,
    });
    const actions = audits.map((a) => `${a.action}:${a.outcome}`);
    expect(actions).toContain("tenant.provision:success");
    expect(actions).toContain("tenant.theme.grant:success");
    expect(actions).toContain("tenant.theme.revoke:denied");
    expect(actions).toContain("tenant.theme.revoke:success");

    // 9. Verify tenant content (pages, posts, offerings) is 100% UNCHANGED!
    const contentAfter = await snapshotContent();
    expect(contentAfter).toBe(contentBefore);
  });
});

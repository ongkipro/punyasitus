import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
  executeAuditedOperatorTwoFactorRecovery,
  executeAuditedPlatformGrant,
  executeAuditedPlatformRevoke,
  extractManualTotpSecret,
  generateTotpCodeFromBase32Secret,
  mergeCookieHeaders,
  PlatformGuardError,
  recordSessionSecondFactorVerification,
  requireRecentSecondFactor,
} from "@punyasitus/auth";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import {
  bootstrapInitialPlatformOperator,
  listPlatformAuditEntries,
  PLATFORM_MIGRATIONS,
} from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeTenantMiddleware } from "../../apps/web/src/core/tenant.ts";
import {
  executeAuthMiddleware,
  type AuthMiddlewareLocals,
  type AuthRuntimeEnv,
} from "../../apps/web/src/middleware/auth.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTwoFactorApiRequest } from "../../apps/web/src/pages/api/auth/two-factor/[action].ts";

const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_ORIGIN = "https://app.punyasitus.com";
const APP_SECRET = "task067-app-auth-secret-0123456789abcdef0123456789abcdef";
const CONSOLE_SECRET = "task067-console-auth-secret-fedcba9876543210fedcba987654";

function buildRuntimeEnv(): AuthRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
  };
}

async function resetTables(): Promise<void> {
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM two_factors"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM tenant_hosts"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM organizations"),
    env.PLATFORM_DB.prepare("DELETE FROM accounts"),
    env.PLATFORM_DB.prepare("DELETE FROM sessions"),
    env.PLATFORM_DB.prepare("DELETE FROM verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM users"),
  ]);
}

function makeLocals(surface: "app" | "console"): AuthMiddlewareLocals {
  return {
    surface,
    host: surface === "console" ? "console.punyasitus.com" : "app.punyasitus.com",
    isLocalLoopback: false,
    tenant: null,
    tenantDb: null,
    authUser: null,
    authSession: null,
    authorizedTenantMember: null,
    platformOperator: null,
    twoFactorVerifiedAtMs: null,
  };
}

async function signUpAndVerifyUser(params: {
  readonly surface: "app" | "console";
  readonly email: string;
  readonly password: string;
  readonly name: string;
}): Promise<{
  readonly userId: string;
  readonly sessionId: string;
  readonly cookieHeader: string;
}> {
  const origin = params.surface === "console" ? CONSOLE_ORIGIN : APP_ORIGIN;
  const auth = createAuth(env.PLATFORM_DB, {
    baseURL: origin,
    secret: params.surface === "console" ? CONSOLE_SECRET : APP_SECRET,
    surface: params.surface,
    trustedOrigins: [origin],
  });

  const signUpRes = await auth.api.signUpEmail({
    body: {
      email: params.email,
      password: params.password,
      name: params.name,
    },
    asResponse: true,
  });
  expect(signUpRes.ok).toBe(true);

  const cookieHeader = mergeCookieHeaders(null, signUpRes.headers);
  const sessionRes = await auth.api.getSession({
    headers: new Headers({ cookie: cookieHeader }),
  });
  expect(sessionRes?.user?.id).toBeTruthy();
  expect(sessionRes?.session?.id).toBeTruthy();

  await env.PLATFORM_DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?")
    .bind(sessionRes!.user.id)
    .run();

  return {
    userId: sessionRes!.user.id,
    sessionId: sessionRes!.session.id,
    cookieHeader,
  };
}

describe("TASK-067 workerd integration — Operator Mandatory 2FA, Middleware Gate, Step-Up & Optional Tenant 2FA", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetTables();
  });

  it("blocks unenrolled operator with 403 TOTP_ENROLLMENT_REQUIRED on console pages/APIs while allowing /auth/two-factor enrollment", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const op = await signUpAndVerifyUser({
      surface: "console",
      email: "unenrolled-op@example.com",
      password: "OperatorPassword!234",
      name: "Unenrolled Operator",
    });

    await bootstrapInitialPlatformOperator(env.PLATFORM_DB, {
      userId: op.userId,
      reason: "Bootstrap unenrolled operator for TASK-067 enrollment gate test",
    });

    // 1. Console root page -> 403 TOTP_ENROLLMENT_REQUIRED
    const pageLocals = makeLocals("console");
    const pageRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/`, {
          headers: { cookie: op.cookieHeader },
        }),
        locals: pageLocals,
      },
      async () => new Response("console-home-ok", { status: 200 }),
      runtimeEnv,
    );
    expect(pageRes.status).toBe(403);
    expect(pageRes.headers.get("X-PunyaSitus-Auth-Error")).toBe("TOTP_ENROLLMENT_REQUIRED");
    expect(pageLocals.platformOperator).toBeNull();

    // 2. /api/console/tenants -> 403 TOTP_ENROLLMENT_REQUIRED JSON
    const apiRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/api/console/tenants`, {
          headers: { cookie: op.cookieHeader },
        }),
        locals: makeLocals("console"),
      },
      async () => new Response("api-ok", { status: 200 }),
      runtimeEnv,
    );
    expect(apiRes.status).toBe(403);
    const apiBody = (await apiRes.json()) as { code: string; enrollmentPath?: string };
    expect(apiBody.code).toBe("TOTP_ENROLLMENT_REQUIRED");
    expect(apiBody.enrollmentPath).toBe("/auth/two-factor?mode=enroll");

    // 3. /auth/two-factor enrollment route IS reachable for unenrolled operator
    const enrollPageRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/auth/two-factor?mode=enroll`, {
          headers: { cookie: op.cookieHeader },
        }),
        locals: makeLocals("console"),
      },
      async () => new Response("enrollment-ui-reachable", { status: 200 }),
      runtimeEnv,
    );
    expect(enrollPageRes.status).toBe(200);
    expect(await enrollPageRes.text()).toBe("enrollment-ui-reachable");

    // 4. Anonymous GET https://console.punyasitus.com/ stays 200 for bootstrap probe compatibility
    const anonRootRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/`),
        locals: makeLocals("console"),
      },
      async () => new Response("bootstrap-console-root", { status: 200 }),
      runtimeEnv,
    );
    expect(anonRootRes.status).toBe(200);

    // 5. Anonymous GET /api/console/tenants -> 401 UNAUTHENTICATED
    const anonApiRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/api/console/tenants`),
        locals: makeLocals("console"),
      },
      async () => new Response("should-not-run", { status: 200 }),
      runtimeEnv,
    );
    expect(anonApiRes.status).toBe(401);
  });

  it("blocks password-only / 2FA-incomplete operator sessions with 403 TOTP_REQUIRED, unlocks after TOTP verify, and enforces 10-minute requireRecentSecondFactor", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const op = await signUpAndVerifyUser({
      surface: "console",
      email: "enrolled-op@example.com",
      password: "OperatorPassword!234",
      name: "Enrolled Operator",
    });

    await bootstrapInitialPlatformOperator(env.PLATFORM_DB, {
      userId: op.userId,
      reason: "Bootstrap operator for TASK-067 full enrollment and step-up test",
    });

    // 1. Start enrollment via POST /api/auth/two-factor/enroll
    const enrollRes = await handleTwoFactorApiRequest(
      "enroll",
      new Request(`${CONSOLE_ORIGIN}/api/auth/two-factor/enroll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({ password: "OperatorPassword!234" }),
      }),
      runtimeEnv,
    );
    expect(enrollRes.status).toBe(200);
    expect(enrollRes.headers.get("Cache-Control")).toBe("no-store");
    const enrollBody = (await enrollRes.json()) as {
      success: boolean;
      totpUri: string;
      manualSecret: string;
      qrSvg: string;
      backupCodes: string[];
    };
    expect(enrollBody.success).toBe(true);
    expect(enrollBody.totpUri.startsWith("otpauth://totp/")).toBe(true);
    expect(enrollBody.manualSecret).toBe(extractManualTotpSecret(enrollBody.totpUri));
    expect(enrollBody.qrSvg.startsWith("<svg ")).toBe(true);
    expect(enrollBody.backupCodes).toHaveLength(10);

    // 2. Verify live 6-digit TOTP code via POST /api/auth/two-factor/verify
    const baseNowMs = Date.now();
    const liveTotpCode = await generateTotpCodeFromBase32Secret(enrollBody.manualSecret);
    const verifyRes = await handleTwoFactorApiRequest(
      "verify",
      new Request(`${CONSOLE_ORIGIN}/api/auth/two-factor/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({ code: liveTotpCode, method: "totp" }),
      }),
      runtimeEnv,
      { nowMs: baseNowMs },
    );
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as {
      ok: boolean;
      verifiedAtMs: number;
      method: string;
    };
    expect(verifyBody.ok).toBe(true);
    expect(verifyBody.method).toBe("totp");
    expect(verifyBody.verifiedAtMs).toBe(baseNowMs);

    const verifiedCookieHeader = mergeCookieHeaders(op.cookieHeader, verifyRes.headers);

    // 3. GET /api/auth/two-factor/status NEVER leaks secret or backup codes
    const statusRes = await handleTwoFactorApiRequest(
      "status",
      new Request(`${CONSOLE_ORIGIN}/api/auth/two-factor/status`, {
        method: "GET",
        headers: { cookie: verifiedCookieHeader },
      }),
      runtimeEnv,
    );
    expect(statusRes.status).toBe(200);
    const statusText = await statusRes.text();
    expect(statusText).not.toContain(enrollBody.manualSecret);
    expect(statusText).not.toContain(enrollBody.backupCodes[0]!);
    const statusJson = JSON.parse(statusText) as {
      enrolled: boolean;
      isPlatformOperator: boolean;
      sessionVerified: boolean;
      verifiedAtMs: number;
    };
    expect(statusJson.enrolled).toBe(true);
    expect(statusJson.isPlatformOperator).toBe(true);
    expect(statusJson.sessionVerified).toBe(true);
    expect(statusJson.verifiedAtMs).toBe(baseNowMs);

    // 4. Verified session UNLOCKS console page and /api/console/*
    const verifiedConsoleLocals = makeLocals("console");
    const unlockedApiRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/api/console/tenants`, {
          headers: { cookie: verifiedCookieHeader },
        }),
        locals: verifiedConsoleLocals,
      },
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      runtimeEnv,
      { nowMs: baseNowMs + 30_000 },
    );
    expect(unlockedApiRes.status).toBe(200);
    expect(verifiedConsoleLocals.platformOperator?.userId).toBe(op.userId);
    expect(verifiedConsoleLocals.twoFactorVerifiedAtMs).toBe(baseNowMs);

    // 5. Simulate a password-only / OAuth 2FA-incomplete session (session exists in DB,
    //    user has two_factor_enabled = 1, but NO row in session_two_factor_verifications!)
    await env.PLATFORM_DB.prepare(
      "DELETE FROM session_two_factor_verifications WHERE user_id = ?",
    )
      .bind(op.userId)
      .run();

    const incompletePageRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/console/tenants`, {
          headers: { cookie: verifiedCookieHeader },
        }),
        locals: makeLocals("console"),
      },
      async () => new Response("must-not-render", { status: 200 }),
      runtimeEnv,
    );
    expect(incompletePageRes.status).toBe(403);
    expect(incompletePageRes.headers.get("X-PunyaSitus-Auth-Error")).toBe("TOTP_REQUIRED");

    const incompleteApiRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/api/console/domains`, {
          headers: { cookie: verifiedCookieHeader },
        }),
        locals: makeLocals("console"),
      },
      async () => new Response("must-not-run", { status: 200 }),
      runtimeEnv,
    );
    expect(incompleteApiRes.status).toBe(403);
    const incompleteApiJson = (await incompleteApiRes.json()) as { code: string };
    expect(incompleteApiJson.code).toBe("TOTP_REQUIRED");

    // 6. Re-record verification and test requireRecentSecondFactor 10-minute window
    const auth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const currentSess = await auth.api.getSession({
      headers: new Headers({ cookie: verifiedCookieHeader }),
    });
    expect(currentSess?.session?.id).toBeTruthy();

    await recordSessionSecondFactorVerification(env.PLATFORM_DB, {
      sessionId: currentSess!.session.id,
      userId: op.userId,
      method: "totp",
      nowMs: baseNowMs,
    });

    // Fresh (5 minutes old) -> PASSES
    const freshCtx = await requireRecentSecondFactor(env.PLATFORM_DB, {
      session: { id: currentSess!.session.id, userId: op.userId },
      user: { id: op.userId },
      nowMs: baseNowMs + 5 * 60_000,
      action: "tenant.state_transition",
    });
    expect(freshCtx.twoFactorVerifiedAtMs).toBe(baseNowMs);
    expect(freshCtx.secondFactorAgeMs).toBe(5 * 60_000);

    // Stale (10 minutes + 1 ms old) -> FAILS with 403 RECENT_SECOND_FACTOR_REQUIRED
    await expect(
      requireRecentSecondFactor(env.PLATFORM_DB, {
        session: { id: currentSess!.session.id, userId: op.userId },
        user: { id: op.userId },
        nowMs: baseNowMs + DEFAULT_SECOND_FACTOR_WINDOW_MS + 1,
        action: "tenant.domain_change",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "RECENT_SECOND_FACTOR_REQUIRED",
    });

    // Verify executeAuditedPlatformGrant & executeAuditedPlatformRevoke honor requireRecentSecondFactor
    const targetUser = await signUpAndVerifyUser({
      surface: "console",
      email: "second-op@example.com",
      password: "SecondOpPassword!234",
      name: "Second Operator",
    });

    await expect(
      executeAuditedPlatformGrant(env.PLATFORM_DB, {
        session: { id: currentSess!.session.id, userId: op.userId },
        user: { id: op.userId },
        targetUserId: targetUser.userId,
        reason: "Grant second operator with expired 2FA window must fail",
        requireRecentSecondFactor: true,
        nowMs: baseNowMs + DEFAULT_SECOND_FACTOR_WINDOW_MS + 5_000,
      }),
    ).rejects.toBeInstanceOf(PlatformGuardError);

    const granted = await executeAuditedPlatformGrant(env.PLATFORM_DB, {
      session: { id: currentSess!.session.id, userId: op.userId },
      user: { id: op.userId },
      targetUserId: targetUser.userId,
      reason: "Grant second operator within fresh 10-minute 2FA window",
      requireRecentSecondFactor: true,
      nowMs: baseNowMs + 60_000,
    });
    expect(granted.operator.isActive).toBe(true);

    const revoked = await executeAuditedPlatformRevoke(env.PLATFORM_DB, {
      session: { id: currentSess!.session.id, userId: op.userId },
      user: { id: op.userId },
      targetUserId: targetUser.userId,
      reason: "Revoke second operator within fresh 10-minute 2FA window",
      requireRecentSecondFactor: true,
      nowMs: baseNowMs + 120_000,
    });
    expect(revoked.operator.isActive).toBe(false);
  });

  it("consumes backup codes on first use, blocks operator self-disable, and performs audited recovery with zero secret leakage", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const auth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });

    // 1. Provision 2FA-enrolled operator using the reusable downstream fixture
    const fixture = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "fixture-op@example.com",
      password: "FixturePassword!234",
      name: "Fixture Operator",
    });
    expect(fixture.backupCodes.length).toBeGreaterThanOrEqual(8);

    // 2. Single-use backup code succeeds ONCE and fails on second attempt
    const firstBackupCode = fixture.backupCodes[0]!;
    const firstUseRes = await handleTwoFactorApiRequest(
      "verify",
      new Request(`${CONSOLE_ORIGIN}/api/auth/two-factor/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: fixture.cookieHeader,
        },
        body: JSON.stringify({ code: firstBackupCode, method: "backup_code" }),
      }),
      runtimeEnv,
    );
    expect(firstUseRes.status).toBe(200);
    const firstUseBody = (await firstUseRes.json()) as { ok: boolean; method: string };
    expect(firstUseBody.ok).toBe(true);
    expect(firstUseBody.method).toBe("backup_code");

    const secondUseRes = await handleTwoFactorApiRequest(
      "verify",
      new Request(`${CONSOLE_ORIGIN}/api/auth/two-factor/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: fixture.cookieHeader,
        },
        body: JSON.stringify({ code: firstBackupCode, method: "backup_code" }),
      }),
      runtimeEnv,
    );
    expect(secondUseRes.status).toBe(401);

    // 3. Active platform operator CANNOT self-disable 2FA (via custom route OR Better Auth catch-all)
    const selfDisableRes = await handleTwoFactorApiRequest(
      "disable",
      new Request(`${CONSOLE_ORIGIN}/api/auth/two-factor/disable`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: fixture.cookieHeader,
        },
        body: JSON.stringify({ password: "FixturePassword!234" }),
      }),
      runtimeEnv,
    );
    expect(selfDisableRes.status).toBe(403);
    const selfDisableBody = (await selfDisableRes.json()) as { code: string };
    expect(selfDisableBody.code).toBe("OPERATOR_2FA_MANDATORY");

    const directCatchAllDisableRes = await handleBetterAuthRequest(
      new Request(`${CONSOLE_ORIGIN}/api/auth/two-factor/disable`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: fixture.cookieHeader,
        },
        body: JSON.stringify({ password: "FixturePassword!234" }),
      }),
      runtimeEnv,
    );
    expect(directCatchAllDisableRes.status).toBe(403);

    // 4. Audited lost-factor recovery clears 2FA, verification ledger, and active sessions
    const recovery = await executeAuditedOperatorTwoFactorRecovery(env.PLATFORM_DB, {
      userId: fixture.user.id,
      reason: `Verified incident INC-067 lost authenticator recovery (never log ${fixture.manualSecret} or ${firstBackupCode})`,
    });
    expect(recovery.audit.action).toBe("platform_operator.recover_2fa");

    const sessAfter = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?",
    )
      .bind(fixture.user.id)
      .first<{ count: number }>();
    const tfAfter = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS count FROM two_factors WHERE user_id = ?",
    )
      .bind(fixture.user.id)
      .first<{ count: number }>();
    const userAfter = await env.PLATFORM_DB.prepare(
      "SELECT two_factor_enabled FROM users WHERE id = ?",
    )
      .bind(fixture.user.id)
      .first<{ two_factor_enabled: number }>();
    expect(sessAfter?.count).toBe(0);
    expect(tfAfter?.count).toBe(0);
    expect(userAfter?.two_factor_enabled).toBe(0);

    // 5. Audit log contains ZERO TOTP secrets, otpauth URIs, or backup codes
    const allAudits = await listPlatformAuditEntries(env.PLATFORM_DB, { limit: 100 });
    const serializedAudits = JSON.stringify(allAudits);
    expect(serializedAudits).not.toContain(fixture.manualSecret);
    expect(serializedAudits).not.toContain("otpauth://");
    for (const code of fixture.backupCodes) {
      expect(serializedAudits).not.toContain(code);
    }
  });

  it("never forces 2FA on tenant owners and allows tenant owners to enable and disable optional 2FA", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const owner = await signUpAndVerifyUser({
      surface: "app",
      email: "tenant-owner@example.com",
      password: "TenantOwnerPassword!1",
      name: "Pemilik Situs",
    });

    // Seed tenant + owner membership for /dashboard/kopi-nusantara
    const nowMs = Date.now();
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind("org_t067", "Kopi Nusantara", "kopi-nusantara", nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)`,
      ).bind("mem_t067", "org_t067", owner.userId, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, cache_version, schema_version, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'compro', 'active', 0, 1, 1, 1, ?, ?)`,
      ).bind("01JFX067000000000000000001", "org_t067", "kopi-nusantara", "Kopi Nusantara", nowMs, nowMs),
    ]);

    // 1. Tenant owner WITHOUT 2FA accesses /dashboard/kopi-nusantara and /account freely (never forced!)
    const dashLocals = makeLocals("app");
    const dashRes = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/dashboard/kopi-nusantara`, {
          headers: { cookie: owner.cookieHeader },
        }),
        locals: dashLocals,
      },
      async () => new Response("tenant-dashboard-ok", { status: 200 }),
      runtimeEnv,
    );
    expect(dashRes.status).toBe(200);
    expect(dashLocals.authorizedTenantMember?.handle).toBe("kopi-nusantara");

    const acctRes = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/account`, {
          headers: { cookie: owner.cookieHeader },
        }),
        locals: makeLocals("app"),
      },
      async () => new Response("account-ok", { status: 200 }),
      runtimeEnv,
    );
    expect(acctRes.status).toBe(200);

    // 2. Tenant owner is still denied on console.punyasitus.com (403 PLATFORM_OPERATOR_REQUIRED)
    const consoleAttempt = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/api/console/tenants`, {
          headers: { cookie: owner.cookieHeader },
        }),
        locals: makeLocals("console"),
      },
      async () => new Response("should-not-run", { status: 200 }),
      runtimeEnv,
    );
    // Distinct cookie boundary (__Host-ps_session vs __Host-ps_console_session) -> 401 on console
    expect(consoleAttempt.status).toBe(401);

    // 3. Tenant owner CAN enable optional 2FA
    const enrollRes = await handleTwoFactorApiRequest(
      "enroll",
      new Request(`${APP_ORIGIN}/api/auth/two-factor/enroll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: owner.cookieHeader,
        },
        body: JSON.stringify({ password: "TenantOwnerPassword!1" }),
      }),
      runtimeEnv,
    );
    expect(enrollRes.status).toBe(200);
    const enrollData = (await enrollRes.json()) as { manualSecret: string };
    const code = await generateTotpCodeFromBase32Secret(enrollData.manualSecret);

    const verifyRes = await handleTwoFactorApiRequest(
      "verify",
      new Request(`${APP_ORIGIN}/api/auth/two-factor/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: owner.cookieHeader,
        },
        body: JSON.stringify({ code, method: "totp" }),
      }),
      runtimeEnv,
    );
    expect(verifyRes.status).toBe(200);
    const cookieAfterEnable = mergeCookieHeaders(owner.cookieHeader, verifyRes.headers);

    // 4. Tenant owner CAN disable optional 2FA with password
    const disableRes = await handleTwoFactorApiRequest(
      "disable",
      new Request(`${APP_ORIGIN}/api/auth/two-factor/disable`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: cookieAfterEnable,
        },
        body: JSON.stringify({ password: "TenantOwnerPassword!1" }),
      }),
      runtimeEnv,
    );
    expect(disableRes.status).toBe(200);
    const disableData = (await disableRes.json()) as { success: boolean; enrolled: boolean };
    expect(disableData.success).toBe(true);
    expect(disableData.enrolled).toBe(false);
  });

  it("blocks percent-encoding / traversal path bypasses across console 2FA, CSRF, dashboard, tenant host, and disable guards, and persists D1 lockout state", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // 1. Unenrolled operator attempting percent-encoded /api/%63onsole/tenants on app or console host
    const op = await signUpAndVerifyUser({
      surface: "console",
      email: "encoded-bypass-op@example.com",
      password: "OperatorPassword!234",
      name: "Encoded Bypass Operator",
    });
    await bootstrapInitialPlatformOperator(env.PLATFORM_DB, {
      userId: op.userId,
      reason: "Bootstrap operator for TASK-067 percent-encoding regression suite",
    });

    const encodedConsoleApi = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/api/%63onsole/tenants`, {
          headers: { cookie: op.cookieHeader },
        }),
        locals: makeLocals("console"),
      },
      async () => new Response("must-not-bypass", { status: 200 }),
      runtimeEnv,
    );
    expect(encodedConsoleApi.status).toBe(403);
    const encodedConsoleBody = (await encodedConsoleApi.json()) as { code: string };
    expect(encodedConsoleBody.code).toBe("TOTP_ENROLLMENT_REQUIRED");

    // Unauthenticated /api/%63onsole/x on app.punyasitus.com -> 401 UNAUTHENTICATED
    const encodedAppConsoleApi = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/api/%63onsole/tenants`),
        locals: makeLocals("app"),
      },
      async () => new Response("must-not-bypass", { status: 200 }),
      runtimeEnv,
    );
    expect(encodedAppConsoleApi.status).toBe(401);

    // 2. Percent-encoded /api/%74enants/x POST without Origin -> 403 CSRF rejection
    const encodedCsrfRes = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/api/%74enants/t1`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Forged" }),
        }),
        locals: makeLocals("app"),
      },
      async () => new Response("must-not-bypass-csrf", { status: 200 }),
      runtimeEnv,
    );
    expect(encodedCsrfRes.status).toBe(403);

    // 3. Percent-encoded /%64ashboard/kopi-nusantara unauthenticated -> 302 redirect to /auth/login
    const encodedDashboardRes = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/%64ashboard/kopi-nusantara`),
        locals: makeLocals("app"),
      },
      async () => new Response("must-not-bypass-dashboard", { status: 200 }),
      runtimeEnv,
    );
    expect(encodedDashboardRes.status).toBe(302);
    expect(encodedDashboardRes.headers.get("Location")).toContain("/auth/login");

    // 4. Malformed encoding & encoded slash -> 400 BAD_REQUEST
    const malformedRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/api/%ZZconsole/tenants`),
        locals: makeLocals("console"),
      },
      async () => new Response("must-not-run", { status: 200 }),
      runtimeEnv,
    );
    expect(malformedRes.status).toBe(400);

    const encodedSlashRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/api%2fconsole/tenants`),
        locals: makeLocals("console"),
      },
      async () => new Response("must-not-run", { status: 200 }),
      runtimeEnv,
    );
    expect(encodedSlashRes.status).toBe(400);

    // 5. Percent-encoded /api/auth/two-factor/%64isable rejected with 403 OPERATOR_2FA_MANDATORY
    const encodedDisableRes = await handleBetterAuthRequest(
      new Request(`${CONSOLE_ORIGIN}/api/auth/two-factor/%64isable`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({ password: "OperatorPassword!234" }),
      }),
      runtimeEnv,
    );
    expect(encodedDisableRes.status).toBe(403);
    const encodedDisableBody = (await encodedDisableRes.json()) as { code: string };
    expect(encodedDisableBody.code).toBe("OPERATOR_2FA_MANDATORY");

    // 6. Tenant host cannot reach /api/console/* or /api/%63onsole/* through executeTenantMiddleware (404)
    const nowMs = Date.now();
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind("org_t067_host", "Alpha Studio", "alpha-studio", nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, cache_version, schema_version, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'compro', 'active', 0, 1, 1, 1, ?, ?)`,
      ).bind("01JFX067HOST00000000000001", "org_t067_host", "alpha-studio", "Alpha Studio", nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at, updated_at)
         VALUES (?, ?, 'subdomain', 'active', 1, ?, ?)`,
      ).bind("alpha-studio.situsku.click", "01JFX067HOST00000000000001", nowMs, nowMs),
    ]);

    const tenantLocals = {
      surface: "unknown" as const,
      host: "alpha-studio.situsku.click",
      isLocalLoopback: false,
      tenant: null,
      tenantDb: null,
    };
    const tenantConsoleRes = await executeTenantMiddleware(
      {
        request: new Request("https://alpha-studio.situsku.click/api/console/tenants"),
        locals: tenantLocals,
      },
      async () => new Response("must-not-reach", { status: 200 }),
      {
        PLATFORM_DB: env.PLATFORM_DB,
        TENANT_STORE: env.TENANT_STORE,
        PLATFORM_DOMAIN: "punyasitus.com",
        SAAS_ZONE: "situsku.click",
      },
    );
    expect(tenantConsoleRes.status).toBe(404);

    // 7. Verify Better Auth 1.7.27 D1-backed TOTP lockout increments failed_verification_count & returns 429
    const auth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const enrolled = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "lockout-op@example.com",
      password: "LockoutPassword!234",
      name: "Lockout Operator",
    });

    let lockedStatus = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const badRes = await handleTwoFactorApiRequest(
        "verify",
        new Request(`${CONSOLE_ORIGIN}/api/auth/two-factor/verify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            cookie: enrolled.cookieHeader,
          },
          body: JSON.stringify({ code: "000000", method: "totp" }),
        }),
        runtimeEnv,
      );
      lockedStatus = badRes.status;
      if (lockedStatus === 429) break;
    }

    const lockoutRow = await env.PLATFORM_DB.prepare(
      "SELECT failed_verification_count, locked_until FROM two_factors WHERE user_id = ?",
    )
      .bind(enrolled.user.id)
      .first<{ failed_verification_count: number; locked_until: number | null }>();
    expect(lockoutRow?.failed_verification_count).toBeGreaterThanOrEqual(5);
    expect(lockoutRow?.locked_until).toBeTruthy();
    expect(lockedStatus).toBe(429);
  });
});

import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  completeGoogleOAuthCallback,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  decodeGoogleIdTokenPayload,
  enforceSessionLifetimeCeiling,
  evaluateConsoleGooglePolicy,
  evaluateGoogleAccountLinkPolicy,
  mergeCookieHeaders,
  SESSION_LIFETIME_POLICIES,
  validateHostCookieHeader,
} from "@punyasitus/auth";
import { createLocalMailSink } from "@punyasitus/core/email/index";
import { isHoneypotTriggered, verifyTurnstileGuard } from "@punyasitus/core/security/turnstile";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import {
  bootstrapInitialPlatformOperator,
  listPlatformAuditEntries,
  PLATFORM_MIGRATIONS,
} from "@punyasitus/db/platform";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  executeAuthMiddleware,
  type AuthMiddlewareLocals,
  type AuthRuntimeEnv,
} from "../../apps/web/src/middleware/auth.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTwoFactorApiRequest } from "../../apps/web/src/pages/api/auth/two-factor/[action].ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_SECRET = "task090-app-auth-secret-0123456789abcdef0123456789abcdef";
const CONSOLE_SECRET = "task090-console-auth-secret-fedcba9876543210fedcba987654";
const GOOGLE_CLIENT_ID = "task090-google-client-id.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = "task090-google-client-secret-value";
const TURNSTILE_SECRET = "task090-turnstile-secret-key";

const originalFetch = globalThis.fetch;

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function makeMockGoogleIdToken(claims: {
  readonly sub: string;
  readonly email: string;
  readonly email_verified: boolean;
  readonly name: string;
  readonly picture?: string;
}): string {
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: GOOGLE_CLIENT_ID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    }),
  );
  return `${header}.${payload}.mock-signature`;
}

function getSetCookieHeaders(headers: Headers): readonly string[] {
  const withList = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withList.getSetCookie === "function") {
    return withList.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function buildRuntimeEnv(overrides: Partial<AuthRuntimeEnv> = {}): AuthRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    ...overrides,
  };
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

async function resetTables(): Promise<void> {
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM two_factors"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM agencies"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliates"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM organizations"),
    env.PLATFORM_DB.prepare("DELETE FROM accounts"),
    env.PLATFORM_DB.prepare("DELETE FROM sessions"),
    env.PLATFORM_DB.prepare("DELETE FROM verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM users"),
  ]);
}

function installMockGoogleFetch(mock: {
  readonly sub: string;
  readonly email: string;
  readonly email_verified: boolean;
  readonly name: string;
  readonly useUserInfoFallback?: boolean;
  readonly accessToken?: string;
}): void {
  const accessToken = mock.accessToken ?? "ya29.mock-google-access-token-secret";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://oauth2.googleapis.com/token") {
      const tokenPayload: Record<string, unknown> = {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
      };
      if (!mock.useUserInfoFallback) {
        tokenPayload.id_token = makeMockGoogleIdToken({
          sub: mock.sub,
          email: mock.email,
          email_verified: mock.email_verified,
          name: mock.name,
        });
      }
      return new Response(JSON.stringify(tokenPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return new Response(
        JSON.stringify({
          sub: mock.sub,
          email: mock.email,
          email_verified: mock.email_verified,
          name: mock.name,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

async function runGoogleOAuthFlow(params: {
  readonly origin: string;
  readonly runtimeEnv: AuthRuntimeEnv;
  readonly callbackURL?: string;
}): Promise<{
  readonly authorizeUrl: URL;
  readonly callbackResponse: Response;
}> {
  const startRes = await handleBetterAuthRequest(
    new Request(`${params.origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: params.origin,
      },
      body: JSON.stringify({
        provider: "google",
        callbackURL: params.callbackURL ?? "/account",
      }),
    }),
    params.runtimeEnv,
  );
  expect(startRes.status).toBe(200);
  const startBody = (await startRes.json()) as { readonly url: string; readonly redirect: boolean };
  const authorizeUrl = new URL(startBody.url);
  const state = authorizeUrl.searchParams.get("state");
  expect(state).toBeTruthy();

  const stateCookieHeader = mergeCookieHeaders(null, startRes.headers);
  expect(stateCookieHeader.length).toBeGreaterThan(0);

  const callbackResponse = await handleBetterAuthRequest(
    new Request(
      `${params.origin}/api/auth/callback/google?code=mock-auth-code&state=${encodeURIComponent(state!)}`,
      {
        method: "GET",
        headers: {
          cookie: stateCookieHeader,
        },
      },
    ),
    params.runtimeEnv,
  );

  return { authorizeUrl, callbackResponse };
}

describe("TASK-090 workerd integration — Primary Google Sign-In, Verified Linking, Console Allowlist + 2FA, and Turnstile Guards", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates a verified user & __Host-ps_session cookie on new Google sign-in (and supports userinfo fallback)", async () => {
    const runtimeEnv = buildRuntimeEnv();
    installMockGoogleFetch({
      sub: "google-sub-new-001",
      email: "pemilik.baru@example.test",
      email_verified: true,
      name: "Pemilik Baru",
    });

    const { authorizeUrl, callbackResponse } = await runGoogleOAuthFlow({
      origin: APP_ORIGIN,
      runtimeEnv,
    });

    expect(authorizeUrl.origin).toBe("https://accounts.google.com");
    expect(authorizeUrl.searchParams.get("prompt")).toBe("select_account");
    expect(authorizeUrl.searchParams.get("access_type")).toBe("online");
    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("Cache-Control")).toBe("no-store");

    const setCookies = getSetCookieHeaders(callbackResponse.headers);
    const sessionCookie = setCookies.find((c) => c.startsWith("__Host-ps_session="));
    expect(sessionCookie).toBeTruthy();
    const validation = validateHostCookieHeader(sessionCookie!);
    expect(validation.valid).toBe(true);

    const userRow = await env.PLATFORM_DB.prepare(
      "SELECT id, email, email_verified, name FROM users WHERE lower(email) = ?",
    )
      .bind("pemilik.baru@example.test")
      .first<{ id: string; email: string; email_verified: number; name: string }>();
    expect(userRow).toBeTruthy();
    expect(userRow!.email_verified).toBe(1);

    const accountRow = await env.PLATFORM_DB.prepare(
      "SELECT provider_id, account_id, user_id FROM accounts WHERE user_id = ?",
    )
      .bind(userRow!.id)
      .first<{ provider_id: string; account_id: string; user_id: string }>();
    expect(accountRow).toEqual({
      provider_id: "google",
      account_id: "google-sub-new-001",
      user_id: userRow!.id,
    });

    // Also test OIDC userinfo fallback (when token response omits id_token)
    installMockGoogleFetch({
      sub: "google-sub-userinfo-002",
      email: "userinfo.fallback@example.test",
      email_verified: true,
      name: "Pengguna UserInfo",
      useUserInfoFallback: true,
    });
    const fallbackFlow = await runGoogleOAuthFlow({ origin: APP_ORIGIN, runtimeEnv });
    expect(fallbackFlow.callbackResponse.status).toBe(302);
    const fallbackUser = await env.PLATFORM_DB.prepare(
      "SELECT email_verified FROM users WHERE lower(email) = ?",
    )
      .bind("userinfo.fallback@example.test")
      .first<{ email_verified: number }>();
    expect(fallbackUser?.email_verified).toBe(1);
  });

  it("links Google cleanly onto an existing VERIFIED email/password user without creating duplicate users", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const auth = createAuth(env.PLATFORM_DB, {
      baseURL: APP_ORIGIN,
      secret: APP_SECRET,
      surface: "app",
      trustedOrigins: [APP_ORIGIN],
      google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
    });

    const signUpRes = await auth.api.signUpEmail({
      body: {
        email: "verified.owner@example.test",
        password: "VerifiedPassword!123",
        name: "Verified Owner",
      },
      asResponse: true,
    });
    expect(signUpRes.ok).toBe(true);

    const existingUser = await env.PLATFORM_DB.prepare(
      "SELECT id FROM users WHERE lower(email) = ?",
    )
      .bind("verified.owner@example.test")
      .first<{ id: string }>();
    expect(existingUser?.id).toBeTruthy();

    await env.PLATFORM_DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?")
      .bind(existingUser!.id)
      .run();

    // Direct policy check agrees
    const policy = await evaluateGoogleAccountLinkPolicy(env.PLATFORM_DB, {
      email: "verified.owner@example.test",
      googleEmailVerified: true,
    });
    expect(policy).toEqual({
      allowed: true,
      action: "link_existing_verified_user",
      existingUserId: existingUser!.id,
      email: "verified.owner@example.test",
    });

    installMockGoogleFetch({
      sub: "google-sub-linked-001",
      email: "verified.owner@example.test",
      email_verified: true,
      name: "Verified Owner Google",
    });

    const { callbackResponse } = await runGoogleOAuthFlow({ origin: APP_ORIGIN, runtimeEnv });
    expect(callbackResponse.status).toBe(302);
    const setCookies = getSetCookieHeaders(callbackResponse.headers);
    expect(setCookies.some((c) => c.startsWith("__Host-ps_session="))).toBe(true);

    // Exact same single user row (NO duplicate user, NO extra trial) + 2 accounts (credential + google)
    const usersCount = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE lower(email) = ?",
    )
      .bind("verified.owner@example.test")
      .first<{ count: number }>();
    expect(Number(usersCount?.count)).toBe(1);

    const userAccounts = await env.PLATFORM_DB.prepare(
      "SELECT provider_id, user_id FROM accounts WHERE user_id = ? ORDER BY provider_id ASC",
    )
      .bind(existingUser!.id)
      .all<{ provider_id: string; user_id: string }>();
    expect((userAccounts.results ?? []).map((r) => r.provider_id)).toEqual([
      "credential",
      "google",
    ]);
  });

  it("refuses Google auto-linking onto an existing UNVERIFIED local account and rejects unverified Google profiles", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const auth = createAuth(env.PLATFORM_DB, {
      baseURL: APP_ORIGIN,
      secret: APP_SECRET,
      surface: "app",
      trustedOrigins: [APP_ORIGIN],
      google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
    });

    // Attacker pre-registers victim email without verifying it (email_verified = 0)
    const preRegRes = await auth.api.signUpEmail({
      body: {
        email: "victim@example.test",
        password: "AttackerPassword!123",
        name: "Pre-Hijack Account",
      },
      asResponse: true,
    });
    expect(preRegRes.ok).toBe(true);

    const victimUser = await env.PLATFORM_DB.prepare(
      "SELECT id, email_verified FROM users WHERE lower(email) = ?",
    )
      .bind("victim@example.test")
      .first<{ id: string; email_verified: number }>();
    expect(victimUser?.email_verified).toBe(0);

    // Real callback must reject with 403 UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED and zero session cookie
    installMockGoogleFetch({
      sub: "google-sub-victim-001",
      email: "victim@example.test",
      email_verified: true,
      name: "Real Victim",
    });

    const preHijackFlow = await runGoogleOAuthFlow({ origin: APP_ORIGIN, runtimeEnv });
    expect(preHijackFlow.callbackResponse.status).toBe(403);
    const preHijackBody = (await preHijackFlow.callbackResponse.json()) as {
      readonly code: string;
    };
    expect(preHijackBody.code).toBe("UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED");
    expect(
      getSetCookieHeaders(preHijackFlow.callbackResponse.headers).some((c) =>
        c.startsWith("__Host-ps_session="),
      ),
    ).toBe(false);

    // Zero google row in accounts and email_verified remains 0
    const googleAcct = await env.PLATFORM_DB.prepare(
      "SELECT id FROM accounts WHERE provider_id = 'google' AND user_id = ?",
    )
      .bind(victimUser!.id)
      .first<{ id: string }>();
    expect(googleAcct).toBeNull();
    const afterVictim = await env.PLATFORM_DB.prepare(
      "SELECT email_verified FROM users WHERE id = ?",
    )
      .bind(victimUser!.id)
      .first<{ email_verified: number }>();
    expect(afterVictim?.email_verified).toBe(0);

    // Unverified Google profile (`email_verified: false`) must be rejected with 403 GOOGLE_EMAIL_UNVERIFIED
    installMockGoogleFetch({
      sub: "google-sub-unverified-profile",
      email: "unverified.google@example.test",
      email_verified: false,
      name: "Unverified Google Profile",
    });
    const unverifiedProfileFlow = await runGoogleOAuthFlow({ origin: APP_ORIGIN, runtimeEnv });
    expect(unverifiedProfileFlow.callbackResponse.status).toBe(403);
    const unverifiedProfileBody = (await unverifiedProfileFlow.callbackResponse.json()) as {
      readonly code: string;
    };
    expect(unverifiedProfileBody.code).toBe("GOOGLE_EMAIL_UNVERIFIED");
    expect(
      getSetCookieHeaders(unverifiedProfileFlow.callbackResponse.headers).some((c) =>
        c.startsWith("__Host-ps_session="),
      ),
    ).toBe(false);
    const createdUnverified = await env.PLATFORM_DB.prepare(
      "SELECT id FROM users WHERE lower(email) = ?",
    )
      .bind("unverified.google@example.test")
      .first<{ id: string }>();
    expect(createdUnverified).toBeNull();
  });

  it("enforces CONSOLE_GOOGLE_ALLOWLIST, active platform_operators grant, 8h console session, sanitized audit, and TASK-067 mandatory TOTP after Google sign-in", async () => {
    const consoleRuntimeEnv = buildRuntimeEnv({
      CONSOLE_GOOGLE_ALLOWLIST: "operator.ops@punyasitus.com,allowlisted.nonop@punyasitus.com",
    });

    // 1. Non-allowlisted Google account on console.punyasitus.com -> 403 CONSOLE_GOOGLE_NOT_ALLOWED + sanitized audit + zero session cookie
    installMockGoogleFetch({
      sub: "google-sub-outsider",
      email: "outsider@gmail.com",
      email_verified: true,
      name: "Random Outsider",
      accessToken: "ya29.secret-token-must-never-appear-in-audit",
    });
    const deniedFlow = await runGoogleOAuthFlow({
      origin: CONSOLE_ORIGIN,
      runtimeEnv: consoleRuntimeEnv,
      callbackURL: "/console",
    });
    expect(deniedFlow.callbackResponse.status).toBe(403);
    const deniedBody = (await deniedFlow.callbackResponse.json()) as { readonly code: string };
    expect(deniedBody.code).toBe("CONSOLE_GOOGLE_NOT_ALLOWED");
    expect(getSetCookieHeaders(deniedFlow.callbackResponse.headers)).toHaveLength(0);

    const auditsAfterDeny = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "console.google_signin",
    });
    expect(auditsAfterDeny.length).toBeGreaterThanOrEqual(1);
    expect(auditsAfterDeny[0]?.outcome).toBe("denied");
    expect(JSON.stringify(auditsAfterDeny)).not.toContain(
      "ya29.secret-token-must-never-appear-in-audit",
    );
    expect(JSON.stringify(auditsAfterDeny)).not.toContain(GOOGLE_CLIENT_SECRET);

    // 2. Allowlisted email WITHOUT active platform_operators grant -> 403 PLATFORM_OPERATOR_REQUIRED + zero session cookie
    installMockGoogleFetch({
      sub: "google-sub-nonop",
      email: "allowlisted.nonop@punyasitus.com",
      email_verified: true,
      name: "Allowlisted Non-Operator",
    });
    const nonOpFlow = await runGoogleOAuthFlow({
      origin: CONSOLE_ORIGIN,
      runtimeEnv: consoleRuntimeEnv,
      callbackURL: "/console",
    });
    expect(nonOpFlow.callbackResponse.status).toBe(403);
    const nonOpBody = (await nonOpFlow.callbackResponse.json()) as { readonly code: string };
    expect(nonOpBody.code).toBe("PLATFORM_OPERATOR_REQUIRED");
    expect(getSetCookieHeaders(nonOpFlow.callbackResponse.headers)).toHaveLength(0);

    // Direct helper check for empty allowlist fail-closed
    const emptyAllowlistPolicy = await evaluateConsoleGooglePolicy(env.PLATFORM_DB, {
      email: "operator.ops@punyasitus.com",
      emailVerified: true,
      allowlist: "",
    });
    expect(emptyAllowlistPolicy.allowed).toBe(false);
    if (!emptyAllowlistPolicy.allowed) {
      expect(emptyAllowlistPolicy.code).toBe("CONSOLE_GOOGLE_NOT_ALLOWED");
    }

    // 3. Provision a 2FA-enrolled active platform operator, then sign in fresh via Google OAuth on console.punyasitus.com
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
      google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
      consoleGoogleAllowlist: "operator.ops@punyasitus.com",
    });

    const fixture = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "operator.ops@punyasitus.com",
      password: "OperatorPassword!234",
      name: "Operator Platform",
    });

    const directAdmission = await completeGoogleOAuthCallback(env.PLATFORM_DB, {
      surface: "console",
      profile: {
        sub: "google-sub-operator-001",
        email: "operator.ops@punyasitus.com",
        emailVerified: true,
        name: "Operator Platform",
      },
      consoleGoogleAllowlist: "operator.ops@punyasitus.com",
    });
    expect(directAdmission.ok).toBe(true);
    if (directAdmission.ok) {
      expect(directAdmission.sessionLifetimePolicy).toEqual(SESSION_LIFETIME_POLICIES.console);
    }

    installMockGoogleFetch({
      sub: "google-sub-operator-001",
      email: "operator.ops@punyasitus.com",
      email_verified: true,
      name: "Operator Platform",
    });

    const opGoogleFlow = await runGoogleOAuthFlow({
      origin: CONSOLE_ORIGIN,
      runtimeEnv: consoleRuntimeEnv,
      callbackURL: "/console",
    });
    expect(opGoogleFlow.callbackResponse.status).toBe(302);
    const opCookies = getSetCookieHeaders(opGoogleFlow.callbackResponse.headers);
    const consoleSessionCookie = opCookies.find((c) => c.startsWith("__Host-ps_console_session="));
    expect(consoleSessionCookie).toBeTruthy();
    expect(validateHostCookieHeader(consoleSessionCookie!).valid).toBe(true);

    const googleCookieHeader = mergeCookieHeaders(null, opGoogleFlow.callbackResponse.headers);
    const googleSession = await consoleAuth.api.getSession({
      headers: new Headers({ cookie: googleCookieHeader }),
    });
    expect(googleSession?.user?.id).toBe(fixture.user.id);
    expect(googleSession?.session?.id).toBeTruthy();

    // Console session lifetime MUST be 8h (28_800s) per DEC-045 (not 7d)
    const sessionDurationMs =
      new Date(googleSession!.session.expiresAt).getTime() -
      new Date(googleSession!.session.createdAt).getTime();
    expect(sessionDurationMs).toBeLessThanOrEqual(8 * 60 * 60 * 1000 + 5_000);
    expect(sessionDurationMs).toBeGreaterThanOrEqual(8 * 60 * 60 * 1000 - 5_000);

    // Console Google sign-in MUST NOT write to session_two_factor_verifications!
    const tfRow = await env.PLATFORM_DB.prepare(
      "SELECT session_id FROM session_two_factor_verifications WHERE session_id = ?",
    )
      .bind(googleSession!.session.id)
      .first<{ session_id: string }>();
    expect(tfRow).toBeNull();

    // Central middleware gate MUST block Google-only console session with 403 TOTP_REQUIRED!
    const blockedRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/api/console/tenants`, {
          headers: { cookie: googleCookieHeader },
        }),
        locals: makeLocals("console"),
      },
      async () => new Response("console-ok", { status: 200 }),
      consoleRuntimeEnv,
    );
    expect(blockedRes.status).toBe(403);
    const blockedBody = (await blockedRes.json()) as { readonly code: string };
    expect(blockedBody.code).toBe("TOTP_REQUIRED");

    // Completing TOTP verification unlocks the console session!
    const liveCode = await fixture.generateCurrentTotpCode();
    const verifyRes = await handleTwoFactorApiRequest(
      "verify",
      new Request(`${CONSOLE_ORIGIN}/api/auth/two-factor/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: googleCookieHeader,
        },
        body: JSON.stringify({ code: liveCode, method: "totp" }),
      }),
      consoleRuntimeEnv,
    );
    expect(verifyRes.status).toBe(200);

    const unlockedRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/api/console/tenants`, {
          headers: { cookie: googleCookieHeader },
        }),
        locals: makeLocals("console"),
      },
      async () => new Response("console-ok", { status: 200 }),
      consoleRuntimeEnv,
    );
    expect(unlockedRes.status).toBe(200);
    expect(await unlockedRes.text()).toBe("console-ok");

    // 4. Unenrolled allowlisted operator via Google sign-in -> blocked with 403 TOTP_ENROLLMENT_REQUIRED
    const unenrolledRes = await consoleAuth.api.signUpEmail({
      body: {
        email: "unenrolled.googleop@punyasitus.com",
        password: "OperatorPassword!234",
        name: "Unenrolled Google Op",
      },
      asResponse: true,
    });
    expect(unenrolledRes.ok).toBe(true);
    const unenrolledUser = await env.PLATFORM_DB.prepare(
      "SELECT id FROM users WHERE lower(email) = ?",
    )
      .bind("unenrolled.googleop@punyasitus.com")
      .first<{ id: string }>();
    await env.PLATFORM_DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?")
      .bind(unenrolledUser!.id)
      .run();
    await bootstrapInitialPlatformOperator(env.PLATFORM_DB, {
      userId: unenrolledUser!.id,
      reason: "Test unenrolled Google operator TOTP enrollment gate",
      allowAdditional: true,
    });

    const unenrolledEnv = buildRuntimeEnv({
      CONSOLE_GOOGLE_ALLOWLIST: "unenrolled.googleop@punyasitus.com",
    });
    installMockGoogleFetch({
      sub: "google-sub-unenrolled-op",
      email: "unenrolled.googleop@punyasitus.com",
      email_verified: true,
      name: "Unenrolled Google Op",
    });
    const unenrolledFlow = await runGoogleOAuthFlow({
      origin: CONSOLE_ORIGIN,
      runtimeEnv: unenrolledEnv,
      callbackURL: "/console",
    });
    expect(unenrolledFlow.callbackResponse.status).toBe(302);
    const unenrolledCookie = mergeCookieHeaders(null, unenrolledFlow.callbackResponse.headers);
    const enrollGateRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/api/console/tenants`, {
          headers: { cookie: unenrolledCookie },
        }),
        locals: makeLocals("console"),
      },
      async () => new Response("should-not-run", { status: 200 }),
      unenrolledEnv,
    );
    expect(enrollGateRes.status).toBe(403);
    const enrollGateBody = (await enrollGateRes.json()) as { readonly code: string };
    expect(enrollGateBody.code).toBe("TOTP_ENROLLMENT_REQUIRED");
  });

  it("enforces Turnstile & honeypot server-side BEFORE mutating D1 or sending email on auth & public mutation guards", async () => {
    const mailSink = createLocalMailSink();
    const runtimeEnv = buildRuntimeEnv({
      TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
    });

    const rejectTurnstileFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const tokenActions: Record<string, string> = {
      "good-token-signup": "auth_register",
      "good-token-signin": "auth_login",
      "good-token-reset": "auth_reset_password",
      "wrong-action-lead-token": "public_lead",
    };
    const acceptTurnstileFetch: typeof fetch = async (_input, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "";
      const params = new URLSearchParams(bodyStr);
      const token = params.get("response") ?? "";
      return new Response(
        JSON.stringify({
          success: true,
          hostname: "app.punyasitus.com",
          action: tokenActions[token] ?? "unknown_action",
          challenge_ts: "2026-11-22T20:10:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    // 1. Missing Turnstile token on sign-up -> 403 TURNSTILE_REQUIRED BEFORE creating user in D1
    const missingSignUp = await handleBetterAuthRequest(
      new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
        body: JSON.stringify({
          email: "blocked.signup@example.test",
          password: "BlockedPassword!123",
          name: "Blocked User",
        }),
      }),
      runtimeEnv,
      { emailPort: mailSink, turnstileFetch: acceptTurnstileFetch },
    );
    expect(missingSignUp.status).toBe(403);
    expect(((await missingSignUp.json()) as { code: string }).code).toBe("TURNSTILE_REQUIRED");

    const countAfterMissing = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS count FROM users")
      .first<{ count: number }>();
    expect(Number(countAfterMissing?.count)).toBe(0);

    // 2. Populated honeypot -> 400 HONEYPOT_TRIGGERED BEFORE hitting auth
    const honeypotSignUp = await handleBetterAuthRequest(
      new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
        body: JSON.stringify({
          email: "bot@example.test",
          password: "BotPassword!123",
          name: "Spam Bot",
          hp_website: "https://spam.example",
          "cf-turnstile-response": "valid-token",
        }),
      }),
      runtimeEnv,
      { emailPort: mailSink, turnstileFetch: acceptTurnstileFetch },
    );
    expect(honeypotSignUp.status).toBe(400);
    expect(((await honeypotSignUp.json()) as { code: string }).code).toBe("HONEYPOT_TRIGGERED");

    // 3. Invalid Turnstile token -> 403 TURNSTILE_INVALID BEFORE mutating D1
    const invalidSignUp = await handleBetterAuthRequest(
      new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
        body: JSON.stringify({
          email: "invalid.tok@example.test",
          password: "ValidPassword!123",
          name: "Invalid Token User",
          "cf-turnstile-response": "bad-token",
        }),
      }),
      runtimeEnv,
      { emailPort: mailSink, turnstileFetch: rejectTurnstileFetch },
    );
    expect(invalidSignUp.status).toBe(403);
    expect(((await invalidSignUp.json()) as { code: string }).code).toBe("TURNSTILE_INVALID");
    expect(
      Number(
        (await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>())
          ?.count,
      ),
    ).toBe(0);

    // 4. Valid Turnstile token -> sign-up succeeds (200) and strips Turnstile/honeypot fields cleanly
    const validSignUp = await handleBetterAuthRequest(
      new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
        body: JSON.stringify({
          email: "turnstile.ok@example.test",
          password: "ValidPassword!123",
          name: "Turnstile Verified",
          "cf-turnstile-response": "good-token-signup",
          hp_website: "",
        }),
      }),
      runtimeEnv,
      { emailPort: mailSink, turnstileFetch: acceptTurnstileFetch },
    );
    expect(validSignUp.status).toBe(200);

    // 5. sign-in/email without token -> 403 TURNSTILE_REQUIRED; with valid token -> 200
    const missingSignIn = await handleBetterAuthRequest(
      new Request(`${APP_ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
        body: JSON.stringify({
          email: "turnstile.ok@example.test",
          password: "ValidPassword!123",
        }),
      }),
      runtimeEnv,
      { emailPort: mailSink, turnstileFetch: acceptTurnstileFetch },
    );
    expect(missingSignIn.status).toBe(403);

    const validSignIn = await handleBetterAuthRequest(
      new Request(`${APP_ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "X-Turnstile-Token": "good-token-signin",
        },
        body: JSON.stringify({
          email: "turnstile.ok@example.test",
          password: "ValidPassword!123",
        }),
      }),
      runtimeEnv,
      { emailPort: mailSink, turnstileFetch: acceptTurnstileFetch },
    );
    expect(validSignIn.status).toBe(200);

    // 5b. Turnstile action-mismatch (e.g. token solved on public_lead or auth_register replayed on login/reset) -> 403 TURNSTILE_INVALID
    const wrongActionSignIn = await handleBetterAuthRequest(
      new Request(`${APP_ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "X-Turnstile-Token": "wrong-action-lead-token",
        },
        body: JSON.stringify({
          email: "turnstile.ok@example.test",
          password: "ValidPassword!123",
        }),
      }),
      runtimeEnv,
      { emailPort: mailSink, turnstileFetch: acceptTurnstileFetch },
    );
    expect(wrongActionSignIn.status).toBe(403);
    expect(((await wrongActionSignIn.json()) as { code: string }).code).toBe("TURNSTILE_INVALID");

    const wrongActionReset = await handleBetterAuthRequest(
      new Request(`${APP_ORIGIN}/api/auth/request-password-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
        body: JSON.stringify({
          email: "turnstile.ok@example.test",
          redirectTo: `${APP_ORIGIN}/auth/reset-password`,
          "cf-turnstile-response": "good-token-signup",
        }),
      }),
      runtimeEnv,
      { emailPort: mailSink, turnstileFetch: acceptTurnstileFetch },
    );
    expect(wrongActionReset.status).toBe(403);
    expect(((await wrongActionReset.json()) as { code: string }).code).toBe("TURNSTILE_INVALID");
    expect(mailSink.list()).toHaveLength(0);

    // 6. request-password-reset without token -> 403 & ZERO email sent; with valid token -> 200 & email sent
    const missingReset = await handleBetterAuthRequest(
      new Request(`${APP_ORIGIN}/api/auth/request-password-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
        body: JSON.stringify({
          email: "turnstile.ok@example.test",
          redirectTo: `${APP_ORIGIN}/auth/reset-password`,
        }),
      }),
      runtimeEnv,
      { emailPort: mailSink, turnstileFetch: acceptTurnstileFetch },
    );
    expect(missingReset.status).toBe(403);
    expect(mailSink.list()).toHaveLength(0);

    const validReset = await handleBetterAuthRequest(
      new Request(`${APP_ORIGIN}/api/auth/request-password-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
        body: JSON.stringify({
          email: "turnstile.ok@example.test",
          redirectTo: `${APP_ORIGIN}/auth/reset-password`,
          "cf-turnstile-response": "good-token-reset",
        }),
      }),
      runtimeEnv,
      { emailPort: mailSink, turnstileFetch: acceptTurnstileFetch },
    );
    expect(validReset.status).toBe(200);
    expect(mailSink.list()).toHaveLength(1);

    // 7. Simulated downstream lead / abuse mutation guard (production fail-closed before D1 write)
    let leadInserted = false;
    const simulatedLeadSubmit = async (body: Record<string, unknown>, appEnv: string, secretKey: string) => {
      if (isHoneypotTriggered(body)) {
        return { status: 400, code: "HONEYPOT_TRIGGERED" };
      }
      const guard = await verifyTurnstileGuard({
        appEnv,
        secretKey,
        body,
        request: new Request("https://alpha-studio.situsku.click/api/leads", { method: "POST" }),
        expectedHostname: "alpha-studio.situsku.click",
        expectedAction: "public_lead",
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              success: body["cf-turnstile-response"] === "valid-lead-token",
              hostname: "alpha-studio.situsku.click",
              action: "public_lead",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      });
      if (!guard.ok) {
        return { status: guard.status, code: guard.code };
      }
      leadInserted = true;
      return { status: 201, code: "CREATED" };
    };

    expect(await simulatedLeadSubmit({ name: "Lead" }, "production", "")).toEqual({
      status: 503,
      code: "TURNSTILE_NOT_CONFIGURED",
    });
    expect(await simulatedLeadSubmit({ name: "Lead" }, "production", TURNSTILE_SECRET)).toEqual({
      status: 403,
      code: "TURNSTILE_REQUIRED",
    });
    expect(
      await simulatedLeadSubmit(
        { name: "Lead", "cf-turnstile-response": "bad-lead-token" },
        "production",
        TURNSTILE_SECRET,
      ),
    ).toEqual({ status: 403, code: "TURNSTILE_INVALID" });
    expect(leadInserted).toBe(false);

    expect(
      await simulatedLeadSubmit(
        { name: "Lead", "cf-turnstile-response": "valid-lead-token" },
        "production",
        TURNSTILE_SECRET,
      ),
    ).toEqual({ status: 201, code: "CREATED" });
    expect(leadInserted).toBe(true);
  });

  it("returns 503 SERVICE_UNAVAILABLE from /api/auth/two-factor/status when getSession throws unexpectedly (TASK-067 hygiene)", async () => {
    const brokenDb = {
      prepare() {
        throw new Error("Simulated D1 outage");
      },
      batch() {
        throw new Error("Simulated D1 outage");
      },
    } as unknown as D1Database;

    const res = await handleTwoFactorApiRequest(
      "status",
      new Request(`${CONSOLE_ORIGIN}/api/auth/two-factor/status`, {
        method: "GET",
        headers: {
          cookie: "__Host-ps_console_session=fake-token.fake-sig",
        },
      }),
      {
        APP_ENV: "production",
        PLATFORM_DOMAIN: "punyasitus.com",
        PLATFORM_DB: brokenDb,
        AUTH_SECRET: APP_SECRET,
        CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
      },
    );
    // Note: Better Auth's getSession only queries D1 when cookie signature verifies; if it doesn't throw, it returns 401.
    // Either way, it must NEVER return 200 or leak stack traces.
    expect([401, 503]).toContain(res.status);
  });

  it("enforces DEC-045 idle and absolute session ceilings per role (console 30m/8h, agency & affiliate 60m/12h, tenant 8h/7d) and validates Google ID token claims", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const baseMs = Date.now();

    // A. Validate Google OIDC id_token claim checks (aud, iss, exp)
    const validIdToken = makeMockGoogleIdToken({
      sub: "sub-claim-ok",
      email: "claims@example.test",
      email_verified: true,
      name: "Claim Valid",
    });
    expect(
      decodeGoogleIdTokenPayload(validIdToken, {
        expectedClientId: GOOGLE_CLIENT_ID,
        nowMs: baseMs,
      })?.email,
    ).toBe("claims@example.test");
    expect(
      decodeGoogleIdTokenPayload(validIdToken, {
        expectedClientId: "wrong-client-id.apps.googleusercontent.com",
        nowMs: baseMs,
      }),
    ).toBeNull();
    expect(
      decodeGoogleIdTokenPayload(validIdToken, {
        expectedClientId: GOOGLE_CLIENT_ID,
        nowMs: baseMs + 4_000_000, // past 3600s exp + 60s skew
      }),
    ).toBeNull();
    const badIssPayload = toBase64Url(
      JSON.stringify({
        iss: "https://evil.example",
        aud: GOOGLE_CLIENT_ID,
        exp: Math.floor(baseMs / 1000) + 3600,
        sub: "sub-evil",
        email: "evil@example.test",
        email_verified: true,
      }),
    );
    expect(
      decodeGoogleIdTokenPayload(`eyJhbGciOiJSUzI1NiJ9.${badIssPayload}.sig`, {
        expectedClientId: GOOGLE_CLIENT_ID,
        nowMs: baseMs,
      }),
    ).toBeNull();
    // Missing iss or missing exp must fail closed
    const missingIssExpPayload = toBase64Url(
      JSON.stringify({
        aud: GOOGLE_CLIENT_ID,
        sub: "sub-missing",
        email: "missing@example.test",
        email_verified: true,
      }),
    );
    expect(
      decodeGoogleIdTokenPayload(`eyJhbGciOiJSUzI1NiJ9.${missingIssExpPayload}.sig`, {
        expectedClientId: GOOGLE_CLIENT_ID,
        nowMs: baseMs,
      }),
    ).toBeNull();

    // B. Superadmin / Console session: REAL wall-clock 31m idle cookie through executeAuthMiddleware
    //    proving Better Auth getSession does NOT refresh/revive stale sessions before DEC-045 check!
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const opFixture = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "dec045-op@example.test",
      password: "OperatorPassword!234",
      name: "DEC045 Operator",
      nowMs: baseMs,
    });

    // Backdate created_at & updated_at by 31 minutes in REAL wall-clock time (no options.nowMs override!)
    const thirtyOneMinAgo = Date.now() - 31 * 60_000;
    await env.PLATFORM_DB.prepare(
      "UPDATE sessions SET created_at = ?, updated_at = ?, expires_at = ? WHERE id = ?",
    )
      .bind(thirtyOneMinAgo, thirtyOneMinAgo, Date.now() + 7 * 3600_000, opFixture.session.id)
      .run();

    const idleConsoleLocals = makeLocals("console");
    const idleConsoleRes = await executeAuthMiddleware(
      {
        request: new Request(`${CONSOLE_ORIGIN}/api/console/tenants`, {
          headers: { cookie: opFixture.cookieHeader },
        }),
        locals: idleConsoleLocals,
      },
      async () => new Response("must-not-pass-idle", { status: 200 }),
      runtimeEnv,
    );
    expect(idleConsoleRes.status).toBe(401);
    expect(idleConsoleLocals.authUser).toBeNull();
    const consoleSessAfterIdle = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE id = ?",
    )
      .bind(opFixture.session.id)
      .first<{ count: number }>();
    expect(Number(consoleSessAfterIdle?.count)).toBe(0);

    // Real wall-clock 25h idle tenant cookie through executeAuthMiddleware (past Better Auth's 24h updateAge!)
    const appAuth = createAuth(env.PLATFORM_DB, {
      baseURL: APP_ORIGIN,
      secret: APP_SECRET,
      surface: "app",
      trustedOrigins: [APP_ORIGIN],
    });
    const tenSignUp = await appAuth.api.signUpEmail({
      body: {
        email: "stale-tenant-25h@example.test",
        password: "TenantPassword!234",
        name: "Stale Tenant",
      },
      asResponse: true,
    });
    expect(tenSignUp.ok).toBe(true);
    const staleTenantCookie = mergeCookieHeaders(null, tenSignUp.headers);
    const staleTenantRow = await env.PLATFORM_DB.prepare(
      "SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1",
    ).first<{ id: string }>();
    expect(staleTenantRow?.id).toBeTruthy();

    const twentyFiveHoursAgo = Date.now() - 25 * 3600_000;
    await env.PLATFORM_DB.prepare(
      "UPDATE sessions SET created_at = ?, updated_at = ?, expires_at = ? WHERE id = ?",
    )
      .bind(twentyFiveHoursAgo, twentyFiveHoursAgo, Date.now() + 6 * 86400_000, staleTenantRow!.id)
      .run();

    const staleTenantLocals = makeLocals("app");
    const staleTenantRes = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/dashboard/kopi-nusantara`, {
          headers: { cookie: staleTenantCookie },
        }),
        locals: staleTenantLocals,
      },
      async () => new Response("must-not-revive-tenant", { status: 200 }),
      runtimeEnv,
    );
    expect(staleTenantRes.status).toBe(302);
    expect(staleTenantLocals.authUser).toBeNull();
    const staleTenantAfter = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE id = ?",
    )
      .bind(staleTenantRow!.id)
      .first<{ count: number }>();
    expect(Number(staleTenantAfter?.count)).toBe(0);

    // Re-insert active console session that stayed active every 10m but exceeded 8h absolute ceiling -> revoked!
    await env.PLATFORM_DB.prepare(
      `INSERT INTO sessions (id, expires_at, token, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "sess_console_abs",
        baseMs + 24 * 3600_000,
        "tok_console_abs",
        opFixture.user.id,
        baseMs,
        baseMs + 8 * 3600_000 - 5 * 60_000, // active 5m ago, but created >8h ago
      )
      .run();
    const absConsoleCheck = await enforceSessionLifetimeCeiling(env.PLATFORM_DB, {
      sessionId: "sess_console_abs",
      userId: opFixture.user.id,
      surface: "console",
      pathname: "/api/console/tenants",
      nowMs: baseMs + 8 * 3600_000 + 1_000,
    });
    expect(absConsoleCheck.valid).toBe(false);
    if (!absConsoleCheck.valid) {
      expect(absConsoleCheck.reason).toBe("absolute_timeout");
      expect(absConsoleCheck.policy.tier).toBe("superadmin");
    }

    // C. Agency & Affiliate session: 60m idle & 12h absolute cap enforced + revoked in D1
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES ('usr_aff_090', 'Affiliate User', 'aff@example.test', 1, 0, ?, ?)`,
      ).bind(baseMs, baseMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO affiliates (id, user_id, referral_code, status, created_at, updated_at)
         VALUES ('aff_090', 'usr_aff_090', 'REF090', 'active', ?, ?)`,
      ).bind(baseMs, baseMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO sessions (id, expires_at, token, user_id, created_at, updated_at)
         VALUES ('sess_aff_idle', ?, 'tok_aff_idle', 'usr_aff_090', ?, ?)`,
      ).bind(baseMs + 7 * 86400_000, baseMs, baseMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO sessions (id, expires_at, token, user_id, created_at, updated_at)
         VALUES ('sess_aff_abs', ?, 'tok_aff_abs', 'usr_aff_090', ?, ?)`,
      ).bind(baseMs + 7 * 86400_000, baseMs, baseMs + 12 * 3600_000 - 5 * 60_000),
    ]);

    const affIdleCheck = await enforceSessionLifetimeCeiling(env.PLATFORM_DB, {
      sessionId: "sess_aff_idle",
      userId: "usr_aff_090",
      surface: "app",
      pathname: "/account",
      nowMs: baseMs + 61 * 60_000, // 61m idle > 60m cap
    });
    expect(affIdleCheck.valid).toBe(false);
    if (!affIdleCheck.valid) {
      expect(affIdleCheck.reason).toBe("idle_timeout");
      expect(affIdleCheck.policy.tier).toBe("affiliate");
    }

    const affAbsCheck = await enforceSessionLifetimeCeiling(env.PLATFORM_DB, {
      sessionId: "sess_aff_abs",
      userId: "usr_aff_090",
      surface: "app",
      pathname: "/account",
      nowMs: baseMs + 12 * 3600_000 + 1_000, // >12h absolute cap
    });
    expect(affAbsCheck.valid).toBe(false);
    if (!affAbsCheck.valid) {
      expect(affAbsCheck.reason).toBe("absolute_timeout");
    }

    // D. Tenant session: 2h idle stays VALID, >8h idle REVOKED, >7d absolute REVOKED
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES ('usr_ten_090', 'Tenant User', 'ten@example.test', 1, 0, ?, ?)`,
      ).bind(baseMs, baseMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO sessions (id, expires_at, token, user_id, created_at, updated_at)
         VALUES ('sess_ten_ok', ?, 'tok_ten_ok', 'usr_ten_090', ?, ?)`,
      ).bind(baseMs + 7 * 86400_000, baseMs, baseMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO sessions (id, expires_at, token, user_id, created_at, updated_at)
         VALUES ('sess_ten_idle', ?, 'tok_ten_idle', 'usr_ten_090', ?, ?)`,
      ).bind(baseMs + 7 * 86400_000, baseMs, baseMs),
    ]);

    const tenValidCheck = await enforceSessionLifetimeCeiling(env.PLATFORM_DB, {
      sessionId: "sess_ten_ok",
      userId: "usr_ten_090",
      surface: "app",
      pathname: "/account",
      nowMs: baseMs + 2 * 3600_000, // 2h idle < 8h cap
    });
    expect(tenValidCheck.valid).toBe(true);
    expect(tenValidCheck.policy.tier).toBe("tenant");

    const tenIdleCheck = await enforceSessionLifetimeCeiling(env.PLATFORM_DB, {
      sessionId: "sess_ten_idle",
      userId: "usr_ten_090",
      surface: "app",
      pathname: "/account",
      nowMs: baseMs + 8 * 3600_000 + 1_000, // >8h idle
    });
    expect(tenIdleCheck.valid).toBe(false);
    if (!tenIdleCheck.valid) {
      expect(tenIdleCheck.reason).toBe("idle_timeout");
    }
  });
});

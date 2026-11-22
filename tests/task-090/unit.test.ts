import {
  decodeGoogleIdTokenPayload,
  mapGoogleOAuthCallbackError,
  parseConsoleGoogleEmailAllowlist,
  resolveSessionLifetimePolicy,
  SESSION_LIFETIME_POLICIES,
} from "@punyasitus/auth";
import {
  extractTurnstileToken,
  isHoneypotTriggered,
  isTurnstileProtectedAuthPath,
  stripTurnstileAndHoneypotFields,
  TURNSTILE_MAX_TOKEN_LENGTH,
  TURNSTILE_PROTECTED_AUTH_PATHS,
  TURNSTILE_SITEVERIFY_URL,
  verifyTurnstileGuard,
  verifyTurnstileToken,
} from "@punyasitus/core/security/turnstile";
import { describe, expect, it } from "vitest";
import {
  extractDashboardHandle,
  normalizeMiddlewarePathname,
} from "../../apps/web/src/middleware/auth.ts";

function createBase64UrlJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.mock-sig`;
}

describe("TASK-090 unit — Cloudflare Turnstile verifier, honeypot guard, Google policies & middleware hygiene", () => {
  it("verifies a valid Turnstile token against official Siteverify with remoteip, idempotency_key, action, and normalized hostname", async () => {
    let capturedUrl = "";
    let capturedBody = "";

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          success: true,
          hostname: "APP.PUNYASITUS.COM.",
          action: "auth_login",
          challenge_ts: "2026-11-22T20:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await verifyTurnstileToken({
      secretKey: "1x0000000000000000000000000000000AA",
      token: "valid-turnstile-token-xyz",
      remoteIp: "203.0.113.10",
      expectedAction: "auth_login",
      expectedHostname: "app.punyasitus.com:443",
      idempotencyKey: "idem-123",
      fetchFn: mockFetch,
    });

    expect(capturedUrl).toBe(TURNSTILE_SITEVERIFY_URL);
    const params = new URLSearchParams(capturedBody);
    expect(params.get("secret")).toBe("1x0000000000000000000000000000000AA");
    expect(params.get("response")).toBe("valid-turnstile-token-xyz");
    expect(params.get("remoteip")).toBe("203.0.113.10");
    expect(params.get("idempotency_key")).toBe("idem-123");

    expect(result).toEqual({
      ok: true,
      bypassed: false,
      hostname: "app.punyasitus.com",
      action: "auth_login",
      challengeTs: "2026-11-22T20:00:00.000Z",
    });
  });

  it("rejects missing, oversized, invalid, action-mismatched, hostname-mismatched, and timed-out tokens without leaking secrets or tokens", async () => {
    const secretKey = "SUPER_SECRET_TURNSTILE_KEY_999999";
    const sensitiveToken = "SENSITIVE_USER_TURNSTILE_TOKEN_888888";

    // Missing token -> 403 TURNSTILE_REQUIRED
    const missing = await verifyTurnstileToken({
      secretKey,
      token: "   ",
      fetchFn: async () => {
        throw new Error("should not call fetch");
      },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.status).toBe(403);
      expect(missing.code).toBe("TURNSTILE_REQUIRED");
      expect(JSON.stringify(missing)).not.toContain(secretKey);
    }

    // Oversized token (> 2048 chars) -> 403 TURNSTILE_INVALID
    const oversizedToken = "a".repeat(TURNSTILE_MAX_TOKEN_LENGTH + 1);
    const oversized = await verifyTurnstileToken({
      secretKey,
      token: oversizedToken,
      fetchFn: async () => {
        throw new Error("should not call fetch");
      },
    });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.status).toBe(403);
      expect(oversized.code).toBe("TURNSTILE_INVALID");
      expect(JSON.stringify(oversized)).not.toContain(secretKey);
      expect(JSON.stringify(oversized)).not.toContain(oversizedToken);
    }

    // Rejected by Siteverify -> 403 TURNSTILE_INVALID
    const rejected = await verifyTurnstileToken({
      secretKey,
      token: sensitiveToken,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            success: false,
            "error-codes": ["timeout-or-duplicate"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.status).toBe(403);
      expect(rejected.code).toBe("TURNSTILE_INVALID");
      expect(rejected.errorCodes).toContain("timeout-or-duplicate");
      expect(JSON.stringify(rejected)).not.toContain(secretKey);
      expect(JSON.stringify(rejected)).not.toContain(sensitiveToken);
    }

    // Action mismatch -> 403 TURNSTILE_INVALID
    const actionMismatch = await verifyTurnstileToken({
      secretKey,
      token: sensitiveToken,
      expectedAction: "auth_register",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            success: true,
            action: "auth_login",
            hostname: "app.punyasitus.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });
    expect(actionMismatch.ok).toBe(false);
    if (!actionMismatch.ok) {
      expect(actionMismatch.status).toBe(403);
      expect(actionMismatch.code).toBe("TURNSTILE_INVALID");
      expect(actionMismatch.errorCodes).toContain("action-mismatch");
    }

    // Hostname mismatch -> 403 TURNSTILE_INVALID
    const hostnameMismatch = await verifyTurnstileToken({
      secretKey,
      token: sensitiveToken,
      expectedHostname: "app.punyasitus.com",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            success: true,
            action: "auth_login",
            hostname: "evil.example.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });
    expect(hostnameMismatch.ok).toBe(false);
    if (!hostnameMismatch.ok) {
      expect(hostnameMismatch.status).toBe(403);
      expect(hostnameMismatch.code).toBe("TURNSTILE_INVALID");
      expect(hostnameMismatch.errorCodes).toContain("hostname-mismatch");
    }

    // Network/timeout error -> fails closed 503 TURNSTILE_UNAVAILABLE without leaking secret/token
    const networkFailure = await verifyTurnstileToken({
      secretKey,
      token: sensitiveToken,
      fetchFn: async () => {
        throw new Error(`network failure carrying ${secretKey} and ${sensitiveToken}`);
      },
    });
    expect(networkFailure.ok).toBe(false);
    if (!networkFailure.ok) {
      expect(networkFailure.status).toBe(503);
      expect(networkFailure.code).toBe("TURNSTILE_UNAVAILABLE");
      expect(JSON.stringify(networkFailure)).not.toContain(secretKey);
      expect(JSON.stringify(networkFailure)).not.toContain(sensitiveToken);
    }
  });

  it("enforces environment fail-closed contract in staging/production/unset vs clean local/test bypass", async () => {
    // Production / staging / unset with missing secret -> ALWAYS fail closed 503 TURNSTILE_NOT_CONFIGURED
    for (const appEnv of ["production", "staging", undefined, ""]) {
      const res = await verifyTurnstileGuard({
        appEnv,
        secretKey: "",
        token: "any-token",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(503);
        expect(res.code).toBe("TURNSTILE_NOT_CONFIGURED");
      }
    }

    // Local / test with empty secret -> clean bypass
    for (const appEnv of ["local", "test"]) {
      const res = await verifyTurnstileGuard({
        appEnv,
        secretKey: "",
        token: "",
      });
      expect(res).toEqual({
        ok: true,
        bypassed: true,
        hostname: null,
        action: null,
        challengeTs: null,
      });
    }

    // Local / test with enforceWhenUnconfigured: true -> rejects missing token with 403
    const forced = await verifyTurnstileGuard({
      appEnv: "test",
      secretKey: "",
      token: "",
      enforceWhenUnconfigured: true,
    });
    expect(forced.ok).toBe(false);
    if (!forced.ok) {
      expect(forced.status).toBe(403);
      expect(forced.code).toBe("TURNSTILE_REQUIRED");
    }

    // Local / test with secretKey configured -> enforces full Siteverify
    const configured = await verifyTurnstileGuard({
      appEnv: "test",
      secretKey: "test-secret-key",
      token: "",
    });
    expect(configured.ok).toBe(false);
    if (!configured.ok) {
      expect(configured.status).toBe(403);
      expect(configured.code).toBe("TURNSTILE_REQUIRED");
    }
  });

  it("extracts tokens, detects honeypot traps, strips transport fields, and matches protected auth paths", () => {
    const reqWithHeader = new Request("https://app.punyasitus.com/api/auth/sign-in/email", {
      method: "POST",
      headers: { "X-Turnstile-Token": "header-token-123" },
    });
    expect(extractTurnstileToken(reqWithHeader, {})).toBe("header-token-123");
    expect(
      extractTurnstileToken(reqWithHeader, { "cf-turnstile-response": "body-cf-token" }),
    ).toBe("body-cf-token");
    expect(extractTurnstileToken(reqWithHeader, { turnstileToken: "body-camel-token" })).toBe(
      "body-camel-token",
    );

    expect(isHoneypotTriggered({})).toBe(false);
    expect(isHoneypotTriggered({ hp_website: "", _hp_field: "   ", website_url: "" })).toBe(false);
    expect(isHoneypotTriggered({ hp_website: "https://spam.invalid" })).toBe(true);
    expect(isHoneypotTriggered({ _hp_field: "bot" })).toBe(true);
    expect(isHoneypotTriggered({ website_url: "http://bot.test" })).toBe(true);

    expect(
      stripTurnstileAndHoneypotFields({
        email: "user@example.com",
        password: "Password!123",
        "cf-turnstile-response": "tok",
        turnstileToken: "tok2",
        hp_website: "",
        _hp_field: "",
        website_url: "",
      }),
    ).toEqual({
      email: "user@example.com",
      password: "Password!123",
    });

    for (const p of TURNSTILE_PROTECTED_AUTH_PATHS) {
      expect(isTurnstileProtectedAuthPath(p)).toBe(true);
      expect(isTurnstileProtectedAuthPath(`${p}/`)).toBe(true);
      expect(isTurnstileProtectedAuthPath(p.toUpperCase())).toBe(true);
    }
    expect(isTurnstileProtectedAuthPath("/api/auth/get-session")).toBe(false);
    expect(isTurnstileProtectedAuthPath("/api/auth/callback/google")).toBe(false);
  });

  it("parses CONSOLE_GOOGLE_ALLOWLIST, resolves DEC-045 session lifetime policies, and maps callback errors", () => {
    const allowlist = parseConsoleGoogleEmailAllowlist(
      " Admin@PunyaSitus.com, ops@punyasitus.com;\nOPS@PUNYASITUS.COM, invalid-no-at ",
    );
    expect(allowlist.size).toBe(2);
    expect(allowlist.has("admin@punyasitus.com")).toBe(true);
    expect(allowlist.has("ops@punyasitus.com")).toBe(true);
    expect(parseConsoleGoogleEmailAllowlist("").size).toBe(0);

    // DEC-045 ceilings: tenant 8h/7d, agency & affiliate 60m/12h, superadmin/console 30m/8h
    expect(SESSION_LIFETIME_POLICIES.tenant).toEqual({
      tier: "tenant",
      idleTimeoutSeconds: 8 * 3600,
      absoluteTimeoutSeconds: 7 * 24 * 3600,
    });
    expect(SESSION_LIFETIME_POLICIES.agency).toEqual({
      tier: "agency",
      idleTimeoutSeconds: 60 * 60,
      absoluteTimeoutSeconds: 12 * 3600,
    });
    expect(SESSION_LIFETIME_POLICIES.affiliate).toEqual({
      tier: "affiliate",
      idleTimeoutSeconds: 60 * 60,
      absoluteTimeoutSeconds: 12 * 3600,
    });
    expect(SESSION_LIFETIME_POLICIES.superadmin).toEqual({
      tier: "superadmin",
      idleTimeoutSeconds: 30 * 60,
      absoluteTimeoutSeconds: 8 * 3600,
    });
    expect(resolveSessionLifetimePolicy("console")).toEqual(SESSION_LIFETIME_POLICIES.superadmin);
    expect(resolveSessionLifetimePolicy("platform_operator")).toEqual(
      SESSION_LIFETIME_POLICIES.superadmin,
    );
    expect(resolveSessionLifetimePolicy("agency_admin")).toEqual(SESSION_LIFETIME_POLICIES.agency);
    expect(resolveSessionLifetimePolicy("affiliate")).toEqual(SESSION_LIFETIME_POLICIES.affiliate);
    expect(resolveSessionLifetimePolicy("app")).toEqual(SESSION_LIFETIME_POLICIES.tenant);
    expect(resolveSessionLifetimePolicy("owner")).toEqual(SESSION_LIFETIME_POLICIES.tenant);

    expect(mapGoogleOAuthCallbackError("account_not_linked")?.code).toBe(
      "UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED",
    );
    expect(mapGoogleOAuthCallbackError("CONSOLE_GOOGLE_NOT_ALLOWED")?.code).toBe(
      "CONSOLE_GOOGLE_NOT_ALLOWED",
    );
    expect(mapGoogleOAuthCallbackError("unknown_error")).toBeNull();

    const jwt = createBase64UrlJwt({
      iss: "https://accounts.google.com",
      aud: "client-123.apps.googleusercontent.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: "google-sub-1",
      email: "owner@example.test",
      email_verified: true,
      name: "Pemilik Situs",
    });
    expect(
      decodeGoogleIdTokenPayload(jwt, { expectedClientId: "client-123.apps.googleusercontent.com" }),
    ).toMatchObject({
      sub: "google-sub-1",
      email: "owner@example.test",
      email_verified: true,
      name: "Pemilik Situs",
      picture: "",
      hd: undefined,
    });
    expect(
      decodeGoogleIdTokenPayload(
        createBase64UrlJwt({ sub: "google-sub-2", email: "no-iss@example.test", email_verified: true }),
      ),
    ).toBeNull();
    expect(decodeGoogleIdTokenPayload("not-a-jwt")).toBeNull();
  });

  it("does not double-decode percent signs in extractDashboardHandle (/dashboard/100%25 stays fail-closed)", () => {
    const normalized = normalizeMiddlewarePathname("/dashboard/100%25/settings");
    expect(normalized).toBe("/dashboard/100%/settings");
    expect(extractDashboardHandle(normalized!)).toBe("100%");
    expect(extractDashboardHandle("/dashboard/Alpha-Studio/pages")).toBe("alpha-studio");
    expect(extractDashboardHandle("/account")).toBeNull();
  });
});

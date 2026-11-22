import {
  APP_SESSION_COOKIE_NAME,
  assertAdminCsrfAndOrigin,
  assertAuthorized,
  assertDistinctSurfaceSecrets,
  assertMcpBearerOnly,
  AuthorizationError,
  BETTER_AUTH_SCHEMA_MAPPING,
  canPerform,
  CONSOLE_SESSION_COOKIE_NAME,
  getAuthCookieConfig,
  hasHostSessionCookie,
  ORGANIZATION_MEMBERSHIP_LIMIT,
  organizationRoles,
  resolveExpectedAdminOrigin,
  validateHostCookieHeader,
} from "@punyasitus/auth";
import {
  accounts,
  invitations,
  members,
  organizations,
  sessions,
  users,
  verifications,
} from "@punyasitus/db/platform";
import { describe, expect, it } from "vitest";

describe("TASK-025 unit tests: schema mapping, __Host- cookies, CSRF/Origin, MCP, and RBAC", () => {
  it("aligns BETTER_AUTH_SCHEMA_MAPPING and organization roles with PLATFORM_DB schema", () => {
    expect(BETTER_AUTH_SCHEMA_MAPPING.user).toBe(users);
    expect(BETTER_AUTH_SCHEMA_MAPPING.session).toBe(sessions);
    expect(BETTER_AUTH_SCHEMA_MAPPING.account).toBe(accounts);
    expect(BETTER_AUTH_SCHEMA_MAPPING.verification).toBe(verifications);
    expect(BETTER_AUTH_SCHEMA_MAPPING.organization).toBe(organizations);
    expect(BETTER_AUTH_SCHEMA_MAPPING.member).toBe(members);
    expect(BETTER_AUTH_SCHEMA_MAPPING.invitation).toBe(invitations);

    expect(ORGANIZATION_MEMBERSHIP_LIMIT).toBe(5);
    expect(Object.keys(organizationRoles).sort()).toEqual([
      "admin",
      "agency_staff",
      "editor",
      "owner",
      "setup_staff",
    ]);
  });

  it("enforces distinct __Host- cookie configurations and secret isolation for app vs console", () => {
    const appCfg = getAuthCookieConfig("app");
    const consoleCfg = getAuthCookieConfig("console");

    expect(appCfg.sessionCookieName).toBe(APP_SESSION_COOKIE_NAME);
    expect(consoleCfg.sessionCookieName).toBe(CONSOLE_SESSION_COOKIE_NAME);
    expect(appCfg.sessionCookieName).toMatch(/^__Host-/);
    expect(consoleCfg.sessionCookieName).toMatch(/^__Host-/);
    expect(appCfg.sessionCookieName).not.toBe(consoleCfg.sessionCookieName);
    expect(appCfg.cookiePrefix).not.toBe(consoleCfg.cookiePrefix);

    for (const cfg of [appCfg, consoleCfg]) {
      expect(cfg.defaultCookieAttributes).toEqual({
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      });
      expect("domain" in cfg.defaultCookieAttributes).toBe(false);
    }

    const validHeader =
      "__Host-ps_session=abc.sig; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax";
    expect(validateHostCookieHeader(validHeader)).toEqual({
      valid: true,
      cookieName: "__Host-ps_session",
      violations: [],
    });

    // Rejects __Secure-, Domain=, missing Secure/HttpOnly, non-root Path
    const badDomain =
      "__Host-ps_session=abc; Domain=punyasitus.com; Path=/; HttpOnly; Secure; SameSite=Lax";
    expect(validateHostCookieHeader(badDomain).valid).toBe(false);

    const badPrefix = "__Secure-ps_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax";
    expect(validateHostCookieHeader(badPrefix).valid).toBe(false);

    const badPath = "__Host-ps_session=abc; Path=/api; HttpOnly; Secure; SameSite=Lax";
    expect(validateHostCookieHeader(badPath).valid).toBe(false);

    expect(hasHostSessionCookie("__Host-ps_consent=accepted")).toBe(false);
    expect(hasHostSessionCookie("__Host-ps_session=tok123", "app")).toBe(true);
    expect(hasHostSessionCookie("__Host-ps_session=tok123", "console")).toBe(false);
    expect(hasHostSessionCookie("__Host-ps_console_session=tok123", "console")).toBe(true);
    expect(hasHostSessionCookie("__Host-ps_console_session=tok123", "app")).toBe(false);

    expect(() =>
      assertDistinctSurfaceSecrets(
        "0123456789abcdef0123456789abcdef",
        "0123456789abcdef0123456789abcdef",
      ),
    ).toThrow(/distinct signing secrets/i);
    expect(() =>
      assertDistinctSurfaceSecrets(
        "0123456789abcdef0123456789abcdef",
        "fedcba9876543210fedcba9876543210",
      ),
    ).not.toThrow();
  });

  it("enforces admin CSRF & Origin matrix (JSON + exact admin Origin, rejects tenant origins)", () => {
    const expectedOrigin = "https://app.punyasitus.com";

    // Safe GET passes
    const getReq = new Request("https://app.punyasitus.com/api/auth/get-session", {
      method: "GET",
    });
    expect(assertAdminCsrfAndOrigin(getReq, expectedOrigin)).toEqual({ ok: true });

    // Valid JSON + exact admin Origin passes
    const validPost = new Request("https://app.punyasitus.com/api/tenants/t1/pages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Origin: "https://app.punyasitus.com",
        Cookie: "__Host-ps_session=tok",
      },
      body: JSON.stringify({ title: "Beranda" }),
    });
    expect(assertAdminCsrfAndOrigin(validPost, expectedOrigin)).toEqual({ ok: true });

    const rejectedCases: readonly {
      readonly label: string;
      readonly method: string;
      readonly headers: Record<string, string>;
    }[] = [
      {
        label: "tenant subdomain origin",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://alpha-studio.situsku.click",
        },
      },
      {
        label: "custom domain origin",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://kliniksehat.id",
        },
      },
      {
        label: "marketing apex origin",
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://punyasitus.com",
        },
      },
      {
        label: "console origin against app endpoint",
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://console.punyasitus.com",
        },
      },
      {
        label: "missing Origin header",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      },
      {
        label: "literal null Origin",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "null",
        },
      },
      {
        label: "form-urlencoded Content-Type",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://app.punyasitus.com",
        },
      },
      {
        label: "text/plain Content-Type",
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          Origin: "https://app.punyasitus.com",
        },
      },
      {
        label: "missing Content-Type",
        method: "POST",
        headers: {
          Origin: "https://app.punyasitus.com",
        },
      },
    ];

    for (const tc of rejectedCases) {
      const req = new Request("https://app.punyasitus.com/api/tenants/t1/pages", {
        method: tc.method,
        headers: tc.headers,
      });
      const result = assertAdminCsrfAndOrigin(req, expectedOrigin);
      expect(result.ok, `Case "${tc.label}" must be rejected`).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
        expect(result.code).toBe("FORBIDDEN");
      }
    }

    expect(
      resolveExpectedAdminOrigin(new Request("https://app.punyasitus.com/api/auth/get-session"), {
        surface: "app",
      }),
    ).toBe("https://app.punyasitus.com");
    expect(
      resolveExpectedAdminOrigin(new Request("https://alpha-studio.situsku.click/"), {
        surface: "tenant",
      }),
    ).toBeNull();
  });

  it("rejects __Host- session cookie auth on MCP and OAuth protocol routes", () => {
    const mcpPaths = [
      "/mcp",
      "/mcp/messages",
      "/oauth2/token",
      "/oauth2/register",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
    ];

    for (const p of mcpPaths) {
      const withCookie = new Request(`https://app.punyasitus.com${p}`, {
        method: "POST",
        headers: {
          Cookie: "__Host-ps_session=forged-cookie-attempt",
        },
      });
      const denied = assertMcpBearerOnly(withCookie);
      expect(denied.ok, `Cookie auth on ${p} must be rejected`).toBe(false);
      if (!denied.ok) {
        expect(denied.status).toBe(401);
        expect(denied.code).toBe("UNAUTHENTICATED");
      }

      const withBearerOnly = new Request(`https://app.punyasitus.com${p}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer mcp_access_token_xyz",
        },
      });
      expect(assertMcpBearerOnly(withBearerOnly)).toEqual({ ok: true });
    }

    // Non-MCP admin route with session cookie passes MCP guard
    const adminReq = new Request("https://app.punyasitus.com/api/auth/get-session", {
      headers: { Cookie: "__Host-ps_session=valid" },
    });
    expect(assertMcpBearerOnly(adminReq)).toEqual({ ok: true });
  });

  it("enforces RBAC role denial matrix and cross-tenant 404 vs same-tenant 403", () => {
    expect(canPerform("editor", "content:publish")).toBe(true);
    expect(canPerform("editor", "settings:write")).toBe(false);
    expect(canPerform("editor", "lead:read")).toBe(false);
    expect(canPerform("editor", "member:invite")).toBe(false);
    expect(canPerform("admin", "settings:write")).toBe(true);
    expect(canPerform("admin", "lead:update")).toBe(true);
    expect(canPerform("admin", "member:invite")).toBe(false);
    expect(canPerform("admin", "domain:connect")).toBe(false);
    expect(canPerform("owner", "member:invite")).toBe(true);
    expect(canPerform("owner", "domain:connect")).toBe(true);
    expect(canPerform("owner", "domain:remove_active")).toBe(false);

    // Same-tenant forbidden role -> 403
    expect(() =>
      assertAuthorized(
        { actorId: "u1", surface: "app", role: "editor", tenantId: "t1", tenantStatus: "active" },
        "settings:write",
        "t1",
      ),
    ).toThrowError(AuthorizationError);

    try {
      assertAuthorized(
        { actorId: "u1", surface: "app", role: "editor", tenantId: "t1", tenantStatus: "active" },
        "settings:write",
        "t1",
      );
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((err as AuthorizationError).status).toBe(403);
    }

    // Cross-tenant target -> 404
    try {
      assertAuthorized(
        { actorId: "u1", surface: "app", role: "owner", tenantId: "t1", tenantStatus: "active" },
        "content:read",
        "t2",
      );
      expect.unreachable("Cross-tenant access must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((err as AuthorizationError).status).toBe(404);
    }
  });
});

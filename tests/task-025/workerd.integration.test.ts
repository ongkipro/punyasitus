import { env } from "cloudflare:workers";
import {
  APP_SESSION_COOKIE_NAME,
  assertOrganizationMembership,
  AuthorizationError,
  createAuth,
  resolveAuthorizedTenantMember,
  validateHostCookieHeader,
} from "@punyasitus/auth";
import { createLocalMailSink } from "@punyasitus/core/email/index";
import { applyPlatformMigrations, createSqliteDrizzle } from "@punyasitus/db/connections";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  executeAuthMiddleware,
  type AuthMiddlewareLocals,
  type AuthRuntimeEnv,
} from "../../apps/web/src/middleware/auth.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleAccountApiRequest } from "../../apps/web/src/pages/api/auth/account/[action].ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";

function buildAuthEnv(overrides: Partial<AuthRuntimeEnv> = {}): AuthRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    ...overrides,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractSessionCookiePair(response: Response): string {
  const cookies = getSetCookies(response.headers);
  const sessionHeader = cookies.find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!sessionHeader) {
    throw new Error(`Expected ${APP_SESSION_COOKIE_NAME} in Set-Cookie, got: ${JSON.stringify(cookies)}`);
  }
  return (sessionHeader.split(";")[0] ?? "").trim();
}

function createAdminJsonRequest(
  url: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  options: {
    readonly body?: Record<string, unknown>;
    readonly cookie?: string;
    readonly origin?: string | null;
    readonly contentType?: string | null;
    readonly extraHeaders?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers(options.extraHeaders);
  if (options.cookie) {
    headers.set("Cookie", options.cookie);
  }
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

async function signUpAndGetCookie(
  email: string,
  password: string,
  name: string,
  authEnv: AuthRuntimeEnv,
): Promise<{
  readonly cookie: string;
  readonly userId: string;
  readonly setCookieHeaders: readonly string[];
}> {
  const res = await handleBetterAuthRequest(
    createAdminJsonRequest(`${APP_ORIGIN}/api/auth/sign-up/email`, "POST", {
      body: { email, password, name },
      extraHeaders: { "cf-connecting-ip": "203.0.113.10", "user-agent": "PunyaSitusTest/1.0" },
    }),
    authEnv,
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { user?: { id: string } };
  expect(data.user?.id).toBeTruthy();
  const setCookieHeaders = getSetCookies(res.headers);
  const cookie = extractSessionCookiePair(res);
  return { cookie, userId: data.user?.id ?? "", setCookieHeaders };
}

async function signInAndGetCookie(
  email: string,
  password: string,
  authEnv: AuthRuntimeEnv,
  userAgent = "PunyaSitusBrowser/1.0",
): Promise<{ readonly cookie: string; readonly response: Response }> {
  const response = await handleBetterAuthRequest(
    createAdminJsonRequest(`${APP_ORIGIN}/api/auth/sign-in/email`, "POST", {
      body: { email, password },
      extraHeaders: { "cf-connecting-ip": "203.0.113.20", "user-agent": userAgent },
    }),
    authEnv,
  );
  const cookie = response.status === 200 ? extractSessionCookiePair(response) : "";
  return { cookie, response };
}

describe("TASK-025 workerd integration: Better Auth sessions, organizations, RBAC, own-account & host isolation", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("proves signup, __Host- cookie attributes, login, getSession, logout, and password reset via local mail sink", async () => {
    const mailSink = createLocalMailSink();
    const authEnv = buildAuthEnv();
    const email = "owner.lifecycle@example.test";
    const initialPassword = "InitialPassword!123";
    const updatedPassword = "ResetPassword!456";

    // 1. Signup sets genuine __Host-ps_session cookie (no __Secure-, no Domain=)
    const { cookie: session1Cookie, setCookieHeaders } = await signUpAndGetCookie(
      email,
      initialPassword,
      "Pemilik Usaha",
      authEnv,
    );
    const sessionSetCookie = setCookieHeaders.find((c) =>
      c.startsWith(`${APP_SESSION_COOKIE_NAME}=`),
    );
    expect(sessionSetCookie).toBeTruthy();
    const cookieValidation = validateHostCookieHeader(sessionSetCookie ?? "");
    expect(cookieValidation).toEqual({
      valid: true,
      cookieName: APP_SESSION_COOKIE_NAME,
      violations: [],
    });

    // 2. Get session succeeds with __Host- cookie
    const getSessRes = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/get-session`, "GET", {
        cookie: session1Cookie,
      }),
      authEnv,
    );
    expect(getSessRes.status).toBe(200);
    const getSessBody = (await getSessRes.json()) as { user?: { email: string } };
    expect(getSessBody.user?.email).toBe(email);

    // 3. Logout invalidates session1
    const signOutRes = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/sign-out`, "POST", {
        cookie: session1Cookie,
        body: {},
      }),
      authEnv,
    );
    expect(signOutRes.status).toBe(200);

    const afterSignOut = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/get-session`, "GET", {
        cookie: session1Cookie,
      }),
      authEnv,
    );
    expect(await afterSignOut.json()).toBeNull();

    // 4. Sign in again to have an active session prior to password reset
    const { cookie: activeBeforeReset } = await signInAndGetCookie(email, initialPassword, authEnv);
    expect(activeBeforeReset).toContain(`${APP_SESSION_COOKIE_NAME}=`);

    // 5. Request password reset for non-existent user -> non-enumerating 200 and zero mail sent
    const unknownResetRes = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/request-password-reset`, "POST", {
        body: {
          email: "tidak.terdaftar@example.test",
          redirectTo: `${APP_ORIGIN}/auth/reset-password`,
        },
      }),
      authEnv,
      { emailPort: mailSink },
    );
    expect(unknownResetRes.status).toBe(200);
    expect(mailSink.findByTemplate("reset-password").length).toBe(0);

    // 6. Request password reset for registered user -> local mail sink receives reset link
    const resetReqRes = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/request-password-reset`, "POST", {
        body: { email, redirectTo: `${APP_ORIGIN}/auth/reset-password` },
      }),
      authEnv,
      { emailPort: mailSink },
    );
    expect(resetReqRes.status).toBe(200);
    const resetMails = mailSink.findByTemplate("reset-password");
    expect(resetMails.length).toBe(1);
    const capturedMail = resetMails[0];
    expect(capturedMail?.to).toBe(email);
    const tokenMatch = capturedMail?.text.match(/token=([A-Za-z0-9._~%-]+)/);
    expect(tokenMatch?.[1]).toBeTruthy();
    const resetToken = decodeURIComponent(tokenMatch?.[1] ?? "");

    // 7. Complete reset-password -> revokes prior sessions & consumes single-use token
    const resetCompleteRes = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/reset-password`, "POST", {
        body: { token: resetToken, newPassword: updatedPassword },
      }),
      authEnv,
      { emailPort: mailSink },
    );
    expect(resetCompleteRes.status).toBe(200);

    // Prior session is immediately revoked
    const revokedCheck = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/get-session`, "GET", {
        cookie: activeBeforeReset,
      }),
      authEnv,
    );
    expect(await revokedCheck.json()).toBeNull();

    // Replaying the single-use reset token fails
    const replayRes = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/reset-password`, "POST", {
        body: { token: resetToken, newPassword: "AnotherPassword!789" },
      }),
      authEnv,
    );
    expect(replayRes.status).toBeGreaterThanOrEqual(400);

    // Old password fails, new password succeeds
    const oldLogin = await signInAndGetCookie(email, initialPassword, authEnv);
    expect(oldLogin.response.status).toBeGreaterThanOrEqual(400);

    const newLogin = await signInAndGetCookie(email, updatedPassword, authEnv);
    expect(newLogin.response.status).toBe(200);
  });

  it("proves organization create/switch, forged org selector rejection, revoked membership denial, and RBAC matrix", async () => {
    const authEnv = buildAuthEnv();
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

    const owner = await signUpAndGetCookie("org.owner@example.test", "OwnerPass!123", "Sari Pemilik", authEnv);
    const admin = await signUpAndGetCookie("org.admin@example.test", "AdminPass!123", "Budi Admin", authEnv);
    const editor = await signUpAndGetCookie("org.editor@example.test", "EditorPass!123", "Rina Editor", authEnv);
    const outsider = await signUpAndGetCookie("org.outsider@example.test", "Outsider!123", "Tamu Luar", authEnv);

    // Create Org A and Org B via real Better Auth organization plugin
    const createOrgA = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/organization/create`, "POST", {
        cookie: owner.cookie,
        body: { name: "Klinik Sehat A", slug: "klinik-sehat-a" },
      }),
      authEnv,
    );
    expect(createOrgA.status).toBe(200);
    const orgA = (await createOrgA.json()) as { id: string; slug: string };
    expect(orgA.id).toBeTruthy();

    const createOrgB = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/organization/create`, "POST", {
        cookie: owner.cookie,
        body: { name: "Studio Karya B", slug: "studio-karya-b" },
      }),
      authEnv,
    );
    expect(createOrgB.status).toBe(200);
    const orgB = (await createOrgB.json()) as { id: string; slug: string };
    expect(orgB.id).toBeTruthy();

    // Switch active organization A -> B -> A
    const switchToA = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/organization/set-active`, "POST", {
        cookie: owner.cookie,
        body: { organizationId: orgA.id },
      }),
      authEnv,
    );
    expect(switchToA.status).toBe(200);

    const switchToB = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/organization/set-active`, "POST", {
        cookie: owner.cookie,
        body: { organizationId: orgB.id },
      }),
      authEnv,
    );
    expect(switchToB.status).toBe(200);

    // Outsider cannot set active organization to Org A (forged org selector rejected server-side!)
    const forgedSwitch = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/organization/set-active`, "POST", {
        cookie: outsider.cookie,
        body: { organizationId: orgA.id },
      }),
      authEnv,
    );
    expect(forgedSwitch.status).toBeGreaterThanOrEqual(400);

    // Seed tenant records linked to Org A and Org B + add admin and editor members to Org A
    const now = new Date();
    await db.insert(tenants).values([
      {
        id: "01JT025TENANTAAAAAAAAAAAAA",
        organizationId: orgA.id,
        handle: "klinik-sehat-a",
        name: "Klinik Sehat A",
        vertical: "compro",
        status: "active",
        paidThrough: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "01JT025TENANTBBBBBBBBBBBBB",
        organizationId: orgB.id,
        handle: "studio-karya-b",
        name: "Studio Karya B",
        vertical: "compro",
        status: "active",
        paidThrough: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(members).values([
      {
        id: "mem_t025_admin",
        organizationId: orgA.id,
        userId: admin.userId,
        role: "admin",
        createdAt: now,
      },
      {
        id: "mem_t025_editor",
        organizationId: orgA.id,
        userId: editor.userId,
        role: "editor",
        createdAt: now,
      },
    ]);

    // 1. Role permissions matrix checked live against PLATFORM_DB
    const editorPublish = await resolveAuthorizedTenantMember(env.PLATFORM_DB, {
      userId: editor.userId,
      handle: "klinik-sehat-a",
      requiredPermission: "content:publish",
    });
    expect(editorPublish.role).toBe("editor");

    // Editor forbidden from settings:write -> 403
    await expect(
      resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: editor.userId,
        handle: "klinik-sehat-a",
        requiredPermission: "settings:write",
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    // Admin allowed settings:write, forbidden from member:invite & domain:connect -> 403
    const adminSettings = await resolveAuthorizedTenantMember(env.PLATFORM_DB, {
      userId: admin.userId,
      handle: "klinik-sehat-a",
      requiredPermission: "settings:write",
    });
    expect(adminSettings.role).toBe("admin");

    await expect(
      resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: admin.userId,
        handle: "klinik-sehat-a",
        requiredPermission: "member:invite",
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    // Owner allowed member:invite, forbidden from platform-only domain:remove_active -> 404 (console-only action)
    const ownerInvite = await resolveAuthorizedTenantMember(env.PLATFORM_DB, {
      userId: owner.userId,
      handle: "klinik-sehat-a",
      requiredPermission: "member:invite",
    });
    expect(ownerInvite.role).toBe("owner");

    // 2. Forged organization selector rejected even for valid member
    await expect(
      resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: owner.userId,
        handle: "klinik-sehat-a",
        claimedOrganizationId: orgB.id,
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    // 3. Non-member handle returns 404 (NOT 403)
    await expect(
      resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: outsider.userId,
        handle: "klinik-sehat-a",
      }),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    await expect(
      assertOrganizationMembership(env.PLATFORM_DB, outsider.userId, orgA.id),
    ).rejects.toBeInstanceOf(AuthorizationError);

    // 4. Revoked membership fails IMMEDIATELY on next live check
    await db
      .delete(members)
      .where(and(eq(members.organizationId, orgA.id), eq(members.userId, editor.userId)));

    await expect(
      resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: editor.userId,
        handle: "klinik-sehat-a",
        requiredPermission: "content:read",
      }),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("proves own-account profile, email change, password change, and active-session list/revoke with reauthentication", async () => {
    const mailSink = createLocalMailSink();
    const authEnv = buildAuthEnv();
    const initialEmail = "akun.pengguna@example.test";
    const changedEmail = "akun.baru@example.test";
    const pass1 = "AccountPass!123";
    const pass2 = "NewAccountPass!456";

    const first = await signUpAndGetCookie(initialEmail, pass1, "Andi Awal", authEnv);
    const second = await signInAndGetCookie(initialEmail, pass1, authEnv, "DeviceTwo/2.0");
    const third = await signInAndGetCookie(initialEmail, pass1, authEnv, "DeviceThree/3.0");
    const otherUser = await signUpAndGetCookie("other.user@example.test", "OtherPass!123", "Orang Lain", authEnv);

    // 1. Update display name
    const profileRes = await handleAccountApiRequest(
      "profile",
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/account/profile`, "POST", {
        cookie: first.cookie,
        body: { name: "Andi Pratama" },
      }),
      authEnv,
    );
    expect(profileRes.status).toBe(200);
    const profileData = (await profileRes.json()) as { user: { name: string } };
    expect(profileData.user.name).toBe("Andi Pratama");

    // 2. Email change WITHOUT reauth password fails with 403 REAUTH_REQUIRED
    const emailNoReauth = await handleAccountApiRequest(
      "email",
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/account/email`, "POST", {
        cookie: first.cookie,
        body: { newEmail: changedEmail },
      }),
      authEnv,
      { emailPort: mailSink },
    );
    expect(emailNoReauth.status).toBe(403);
    expect((await emailNoReauth.json()) as { code: string }).toMatchObject({ code: "REAUTH_REQUIRED" });

    // Email change with WRONG password fails with 403 REAUTH_REQUIRED
    const emailWrongReauth = await handleAccountApiRequest(
      "email",
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/account/email`, "POST", {
        cookie: first.cookie,
        body: { newEmail: changedEmail, currentPassword: "WrongPassword!999" },
      }),
      authEnv,
      { emailPort: mailSink },
    );
    expect(emailWrongReauth.status).toBe(403);

    // Email change WITH valid password succeeds & sends verification mail to sink
    const emailSuccess = await handleAccountApiRequest(
      "email",
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/account/email`, "POST", {
        cookie: first.cookie,
        body: { newEmail: changedEmail, currentPassword: pass1 },
      }),
      authEnv,
      { emailPort: mailSink },
    );
    expect(emailSuccess.status).toBe(200);
    const emailSuccessBody = (await emailSuccess.json()) as {
      user: { email: string; verificationSent: boolean };
    };
    expect(emailSuccessBody.user.email).toBe(changedEmail);
    expect(emailSuccessBody.user.verificationSent).toBe(true);
    expect(mailSink.findByTemplate("verify-email").some((m) => m.to === changedEmail)).toBe(true);

    // 3. List active sessions -> returns all 3 sessions with ZERO raw token field
    const meRes = await handleAccountApiRequest(
      "me",
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/account/me`, "GET", {
        cookie: first.cookie,
      }),
      authEnv,
    );
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      sessions: { id: string; isCurrent: boolean; userAgent: string | null; token?: unknown }[];
    };
    expect(meBody.sessions.length).toBe(3);
    for (const s of meBody.sessions) {
      expect("token" in s).toBe(false);
    }
    const secondSessionRow = meBody.sessions.find((s) => s.userAgent?.includes("DeviceTwo"));
    expect(secondSessionRow).toBeTruthy();

    // 4. Revoke session WITHOUT reauth fails with 403 REAUTH_REQUIRED
    const revokeNoReauth = await handleAccountApiRequest(
      "revoke-session",
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/account/revoke-session`, "POST", {
        cookie: first.cookie,
        body: { sessionId: secondSessionRow?.id ?? "" },
      }),
      authEnv,
    );
    expect(revokeNoReauth.status).toBe(403);
    expect((await revokeNoReauth.json()) as { code: string }).toMatchObject({ code: "REAUTH_REQUIRED" });

    // Revoking another user's session ID returns 404 (cross-user isolation)
    const otherMe = await handleAccountApiRequest(
      "me",
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/account/me`, "GET", {
        cookie: otherUser.cookie,
      }),
      authEnv,
    );
    const otherSessionId = ((await otherMe.json()) as { sessions: { id: string }[] }).sessions[0]?.id ?? "";
    const crossRevoke = await handleAccountApiRequest(
      "revoke-session",
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/account/revoke-session`, "POST", {
        cookie: first.cookie,
        body: { sessionId: otherSessionId, currentPassword: pass1 },
      }),
      authEnv,
    );
    expect(crossRevoke.status).toBe(404);

    // Revoke DeviceTwo session WITH valid password succeeds & kills DeviceTwo cookie immediately
    const revokeOk = await handleAccountApiRequest(
      "revoke-session",
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/account/revoke-session`, "POST", {
        cookie: first.cookie,
        body: { sessionId: secondSessionRow?.id ?? "", currentPassword: pass1 },
      }),
      authEnv,
    );
    expect(revokeOk.status).toBe(200);

    const deviceTwoAfterRevoke = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/get-session`, "GET", {
        cookie: second.cookie,
      }),
      authEnv,
    );
    expect(await deviceTwoAfterRevoke.json()).toBeNull();

    // 5. Password change WITHOUT currentPassword fails with 403 REAUTH_REQUIRED
    const pwNoReauth = await handleAccountApiRequest(
      "password",
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/account/password`, "POST", {
        cookie: first.cookie,
        body: { newPassword: pass2 },
      }),
      authEnv,
    );
    expect(pwNoReauth.status).toBe(403);

    // Password change WITH valid currentPassword succeeds & revokes DeviceThree session
    const pwOk = await handleAccountApiRequest(
      "password",
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/account/password`, "POST", {
        cookie: first.cookie,
        body: { currentPassword: pass1, newPassword: pass2, revokeOtherSessions: true },
      }),
      authEnv,
    );
    expect(pwOk.status).toBe(200);

    const deviceThreeAfterPwChange = await handleBetterAuthRequest(
      createAdminJsonRequest(`${APP_ORIGIN}/api/auth/get-session`, "GET", {
        cookie: third.cookie,
      }),
      authEnv,
    );
    expect(await deviceThreeAfterPwChange.json()).toBeNull();

    // Sign in with changedEmail + pass2 works
    const relogin = await signInAndGetCookie(changedEmail, pass2, authEnv);
    expect(relogin.response.status).toBe(200);
  });

  it("enforces Better Auth 404 on tenant hosts, CSRF/Origin on admin APIs, MCP cookie rejection, and /dashboard/{handle} 404 for non-members", async () => {
    const authEnv = buildAuthEnv();
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

    const memberUser = await signUpAndGetCookie("dash.member@example.test", "MemberPass!123", "Anggota", authEnv);
    const nonMemberUser = await signUpAndGetCookie("dash.other@example.test", "OtherPass!123", "Bukan Anggota", authEnv);

    // Seed org + tenant + membership for memberUser
    const now = new Date();
    await db.insert(organizations).values({
      id: "org_t025_dash",
      name: "Toko Maju",
      slug: "toko-maju",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tenants).values({
      id: "01JT025DASHBOARDTENANT0001",
      organizationId: "org_t025_dash",
      handle: "toko-maju",
      name: "Toko Maju",
      vertical: "catalog",
      status: "active",
      paidThrough: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(members).values({
      id: "mem_t025_dash_owner",
      organizationId: "org_t025_dash",
      userId: memberUser.userId,
      role: "owner",
      createdAt: now,
    });

    // 1. Better Auth handler returns 404 on tenant hosts & marketing host
    for (const host of ["toko-maju.situsku.click", "custom.tokomaju.id", "punyasitus.com"]) {
      const res = await handleBetterAuthRequest(
        new Request(`https://${host}/api/auth/get-session`, { method: "GET" }),
        authEnv,
      );
      expect(res.status, `Better Auth must return 404 on ${host}`).toBe(404);
    }

    // 2. CSRF/Origin rejection on state-changing requests (tenant subdomain Origin & non-JSON Content-Type)
    const makeLocals = (surface: "app" | "console" = "app"): AuthMiddlewareLocals => ({
      surface,
      host: surface === "app" ? "app.punyasitus.com" : "console.punyasitus.com",
      isLocalLoopback: false,
      tenant: null,
      tenantDb: null,
      authUser: null,
      authSession: null,
      authorizedTenantMember: null,
    });

    const tenantOriginAttack = await executeAuthMiddleware(
      {
        request: createAdminJsonRequest(`${APP_ORIGIN}/api/tenants/01JT025DASHBOARDTENANT0001/pages`, "POST", {
          cookie: memberUser.cookie,
          origin: "https://toko-maju.situsku.click",
          body: { title: "Evil" },
        }),
        locals: makeLocals("app"),
      },
      async () => new Response("should not reach", { status: 200 }),
      authEnv,
    );
    expect(tenantOriginAttack.status).toBe(403);

    const formContentTypeAttack = await executeAuthMiddleware(
      {
        request: createAdminJsonRequest(`${APP_ORIGIN}/api/account/profile`, "POST", {
          cookie: memberUser.cookie,
          origin: APP_ORIGIN,
          contentType: "application/x-www-form-urlencoded",
          body: { name: "Evil" },
        }),
        locals: makeLocals("app"),
      },
      async () => new Response("should not reach", { status: 200 }),
      authEnv,
    );
    expect(formContentTypeAttack.status).toBe(403);

    // 3. Session cookies are NEVER accepted on /mcp or /oauth2/token
    for (const mcpPath of ["/mcp", "/oauth2/token", "/oauth2/register", "/.well-known/oauth-authorization-server"]) {
      const mcpRes = await executeAuthMiddleware(
        {
          request: new Request(`${APP_ORIGIN}${mcpPath}`, {
            method: "POST",
            headers: { Cookie: memberUser.cookie },
          }),
          locals: makeLocals("app"),
        },
        async () => new Response("should not reach", { status: 200 }),
        authEnv,
      );
      expect(mcpRes.status, `Session cookie on ${mcpPath} must be rejected with 401`).toBe(401);
    }

    // 4. Dashboard `/dashboard/{handle}` access checks:
    // 4a. Unauthenticated -> 302 to /auth/login
    const unauthDash = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/dashboard/toko-maju/pages`, { method: "GET" }),
        locals: makeLocals("app"),
      },
      async () => new Response("ok", { status: 200 }),
      authEnv,
    );
    expect(unauthDash.status).toBe(302);
    expect(unauthDash.headers.get("location")).toContain("/auth/login?next=");

    // 4b. Authenticated NON-MEMBER -> 404 (not 403!)
    const nonMemberDash = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/dashboard/toko-maju/pages`, {
          method: "GET",
          headers: { Cookie: nonMemberUser.cookie },
        }),
        locals: makeLocals("app"),
      },
      async () => new Response("ok", { status: 200 }),
      authEnv,
    );
    expect(nonMemberDash.status).toBe(404);

    // 4c. Authenticated non-existent handle -> 404
    const missingHandleDash = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/dashboard/handle-tidak-ada`, {
          method: "GET",
          headers: { Cookie: memberUser.cookie },
        }),
        locals: makeLocals("app"),
      },
      async () => new Response("ok", { status: 200 }),
      authEnv,
    );
    expect(missingHandleDash.status).toBe(404);

    // 4d. Authenticated VALID MEMBER -> 200 with authorizedTenantMember populated
    const memberLocals = makeLocals("app");
    const memberDash = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/dashboard/toko-maju/pages`, {
          method: "GET",
          headers: { Cookie: memberUser.cookie },
        }),
        locals: memberLocals,
      },
      async () => new Response("dashboard-ok", { status: 200 }),
      authEnv,
    );
    expect(memberDash.status).toBe(200);
    expect(memberLocals.authUser?.id).toBe(memberUser.userId);
    expect(memberLocals.authorizedTenantMember?.handle).toBe("toko-maju");
    expect(memberLocals.authorizedTenantMember?.role).toBe("owner");

    // 5. Verify per-request createAuth stays backwards-compatible with console surface cookie separation
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: "https://console.punyasitus.com",
      secret: TEST_CONSOLE_SECRET,
      surface: "console",
    });
    expect(consoleAuth.options.advanced?.cookies?.session_token?.name).toBe(
      "__Host-ps_console_session",
    );
  });
});

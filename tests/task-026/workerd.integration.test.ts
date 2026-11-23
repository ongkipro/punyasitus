import { env } from "cloudflare:workers";
import {
  AuthorizationError,
  createAuth,
  resolveAuthorizedTenantMember,
} from "@punyasitus/auth";
import {
  acceptMemberInvitation,
  assertTenantOwnerBillingAccess,
  createMemberInvitation,
  INVITATION_EXPIRY_HOURS,
  INVITATION_EXPIRY_SECONDS,
  InvitationError,
  listTenantMembersAndInvitations,
  MAX_TENANT_MEMBERS,
  removeTenantMember,
  revokeMemberInvitation,
  transferTenantOwnership,
  updateTenantMemberRole,
} from "@punyasitus/auth/invitations/index";
import {
  applySessionTwoFactorMigration,
  createTwoFactorEnrolledOperatorFixture,
  recordSessionSecondFactorVerification,
} from "@punyasitus/auth/platform/index";
import { createLocalMailSink } from "@punyasitus/core/email/index";
import {
  applyPlatformMigrations,
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  listPlatformAuditEntries,
  PLATFORM_MIGRATIONS,
  revokePlatformOperator,
} from "@punyasitus/db/platform";
import {
  PROVISIONING_RESERVED_HANDLES,
  provisionTenantAtomically,
  transitionTenantServiceState,
} from "@punyasitus/db/provisioning/index";
import { clearHostResolutionCache, resolveTenantByHost } from "@punyasitus/db/routing/index";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  executeAuthMiddleware,
  type AuthMiddlewareLocals,
} from "../../apps/web/src/middleware/auth.ts";
import {
  handleConsoleProvisioningRequest,
  handleConsoleTenantStateRequest,
} from "../../apps/web/src/pages/api/console/provisioning/_shared.ts";
import { handleAcceptInvitationApiRequest } from "../../apps/web/src/pages/dashboard/[handle]/settings/members/accept/api.ts";
import { handleMembersApiRequest } from "../../apps/web/src/pages/dashboard/[handle]/settings/members/api.ts";

const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_SECRET = "test-console-secret-punyasitus-t026-0123456789abcdef";
const APP_SECRET = "test-app-secret-punyasitus-t026-fedcba9876543210";

async function resetMutableTables(): Promise<void> {
  clearHostResolutionCache();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM two_factors"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
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

async function createAppUserSession(params: {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}): Promise<{
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly cookieHeader: string;
}> {
  const auth = createAuth(env.PLATFORM_DB, {
    baseURL: APP_ORIGIN,
    secret: APP_SECRET,
    surface: "app",
    trustedOrigins: [APP_ORIGIN],
  });
  const res = await auth.api.signUpEmail({
    body: {
      email: params.email,
      password: params.password,
      name: params.name,
    },
    asResponse: true,
  });
  expect(res.ok).toBe(true);
  const rawSetCookie = res.headers.get("set-cookie") ?? "";
  const cookiePair = rawSetCookie.split(";")[0]?.trim() ?? "";
  const sess = await auth.api.getSession({
    headers: new Headers({ cookie: cookiePair }),
  });
  expect(sess?.user?.id).toBeTruthy();
  expect(sess?.session?.id).toBeTruthy();

  await env.PLATFORM_DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?")
    .bind(sess!.user.id)
    .run();

  return {
    userId: sess!.user.id,
    sessionId: sess!.session.id,
    email: sess!.user.email.toLowerCase(),
    cookieHeader: cookiePair,
  };
}

describe("TASK-026 workerd integration — Operator Provisioning, Invitations, 5-Member Cap, Owner Transfer & Service State", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetMutableTables();
  });

  it("atomically bootstraps organization + tenant + primary host + owner + TenantStore defaults + audit, and replays idempotently without duplicates", async () => {
    const nowMs = Date.now();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-t026-prov@example.com",
      password: "OperatorPass!234",
      nowMs,
    });
    const owner = await createAppUserSession({
      email: "owner-alpha@example.com",
      password: "OwnerPassword!234",
      name: "Pemilik Alpha",
    });

    const idempotencyKey = "11111111-1111-4111-8111-111111111111";
    const tenantStoreNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;

    // 1. Fresh atomic provision with TenantStore defaults
    const first = await provisionTenantAtomically(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      handle: "Kopi-Nusantara",
      name: "Kopi Nusantara",
      ownerEmail: owner.email,
      vertical: "resto",
      initialStatus: "trial",
      reason: "Onboarding klien Kopi Nusantara sesuai tiket #OPS-201",
      idempotencyKey,
      requestId: "req_prov_001",
      tenantStore: tenantStoreNs,
      nowMs,
    });

    expect(first.replayed).toBe(false);
    expect(first.tenantStoreInitialized).toBe(true);
    expect(first.tenant.handle).toBe("kopi-nusantara");
    expect(first.tenant.primaryHost).toBe("kopi-nusantara.situsku.click");
    expect(first.tenant.status).toBe("trial");
    expect(first.ownerAssignment.kind).toBe("member");
    expect(first.audit?.action).toBe("tenant.provision");

    // Verify TenantStore defaults were created in the tenant's isolated SQLite DO
    const tenantDb = createTenantDb(openTenantStoreStub(tenantStoreNs, first.tenant.id));
    const siteSettings = await tenantDb
      .prepare("SELECT site_title, active_theme_id, locale FROM site_settings WHERE id = 1")
      .first<{ site_title: string; active_theme_id: string; locale: string }>();
    expect(siteSettings).toEqual({
      site_title: "Kopi Nusantara",
      active_theme_id: "resto",
      locale: "id-ID",
    });
    const quota = await tenantDb
      .prepare("SELECT quota_bytes FROM storage_usage WHERE id = 1")
      .first<{ quota_bytes: number }>();
    expect(quota?.quota_bytes).toBe(104_857_600); // 100 MB trial quota
    const seoPlugin = await tenantDb
      .prepare("SELECT plugin_id, enabled FROM installed_plugins WHERE plugin_id = 'seo-ai-autopilot'")
      .first<{ plugin_id: string; enabled: number }>();
    expect(seoPlugin).toEqual({ plugin_id: "seo-ai-autopilot", enabled: 1 });

    // 2. Exact idempotent replay returns existing tenant with ZERO duplicates
    const replay = await provisionTenantAtomically(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      handle: "kopi-nusantara",
      name: "Kopi Nusantara",
      ownerEmail: owner.email,
      vertical: "resto",
      initialStatus: "trial",
      reason: "Onboarding klien Kopi Nusantara sesuai tiket #OPS-201",
      idempotencyKey,
      requestId: "req_prov_002",
      tenantStore: tenantStoreNs,
      nowMs: nowMs + 500,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.tenant.id).toBe(first.tenant.id);
    expect(replay.tenant.organizationId).toBe(first.tenant.organizationId);

    const orgCount = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS c FROM organizations").first<{ c: number }>();
    const tenantCount = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS c FROM tenants").first<{ c: number }>();
    const hostCount = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS c FROM tenant_hosts").first<{ c: number }>();
    expect(orgCount?.c).toBe(1);
    expect(tenantCount?.c).toBe(1);
    expect(hostCount?.c).toBe(1);

    // 3. Reusing the same Idempotency-Key with different payload -> 409 IDEMPOTENCY_CONFLICT
    await expect(
      provisionTenantAtomically(env.PLATFORM_DB, {
        actorUserId: operator.user.id,
        handle: "beda-handle",
        name: "Beda Handle",
        ownerEmail: owner.email,
        vertical: "compro",
        initialStatus: "trial",
        reason: "Mencoba replay idempotency key dengan parameter berbeda",
        idempotencyKey,
        nowMs: nowMs + 600,
      }),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });

    // 4. Duplicate handle with fresh Idempotency-Key -> 409 HANDLE_TAKEN
    await expect(
      provisionTenantAtomically(env.PLATFORM_DB, {
        actorUserId: operator.user.id,
        handle: "kopi-nusantara",
        name: "Duplikat Kopi",
        ownerEmail: owner.email,
        reason: "Mencoba membuat tenant dengan handle duplikat",
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        nowMs: nowMs + 700,
      }),
    ).rejects.toMatchObject({ status: 409, code: "HANDLE_TAKEN" });

    // 5. Reserved handles rejected
    expect(PROVISIONING_RESERVED_HANDLES.has("console")).toBe(true);
    await expect(
      provisionTenantAtomically(env.PLATFORM_DB, {
        actorUserId: operator.user.id,
        handle: "console",
        name: "Reserved Test",
        ownerEmail: owner.email,
        reason: "Mencoba handle yang dicadangkan platform",
        idempotencyKey: "33333333-3333-4333-8333-333333333333",
        nowMs: nowMs + 800,
      }),
    ).rejects.toMatchObject({ status: 422, code: "RESERVED_HANDLE" });

    // 6. Concurrent provisioning with identical Idempotency-Key creates only ONE tenant
    const concurrentKey = "44444444-4444-4444-8444-444444444444";
    const [r1, r2] = await Promise.all([
      provisionTenantAtomically(env.PLATFORM_DB, {
        actorUserId: operator.user.id,
        handle: "concurrent-site",
        name: "Concurrent Site",
        ownerEmail: "new-unregistered-owner@example.com",
        reason: "Uji konkurensi provisioning idempoten secara paralel",
        idempotencyKey: concurrentKey,
        nowMs: nowMs + 1000,
      }),
      provisionTenantAtomically(env.PLATFORM_DB, {
        actorUserId: operator.user.id,
        handle: "concurrent-site",
        name: "Concurrent Site",
        ownerEmail: "new-unregistered-owner@example.com",
        reason: "Uji konkurensi provisioning idempoten secara paralel",
        idempotencyKey: concurrentKey,
        nowMs: nowMs + 1000,
      }),
    ]);
    expect(r1.tenant.id).toBe(r2.tenant.id);
    expect([r1.replayed, r2.replayed].sort()).toEqual([false, true]);
    const concurrentCount = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS c FROM tenants WHERE handle = 'concurrent-site'",
    ).first<{ c: number }>();
    expect(concurrentCount?.c).toBe(1);
  });

  it("rolls back provisioning and service-state mutations completely when audit persistence fails", async () => {
    const nowMs = Date.now();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-audit-rb@example.com",
      password: "OperatorPass!234",
      nowMs,
    });
    const owner = await createAppUserSession({
      email: "owner-audit-rb@example.com",
      password: "OwnerPassword!234",
      name: "Pemilik Rollback",
    });

    // Inject a deterministic SQLite trigger on platform_audit to simulate audit persistence failure
    await env.PLATFORM_DB.prepare(
      `CREATE TRIGGER test_t026_fail_audit
       BEFORE INSERT ON platform_audit
       WHEN NEW.reason LIKE '%INJECT_AUDIT_FAILURE%'
       BEGIN
         SELECT RAISE(ABORT, 'simulated audit failure');
       END`,
    ).run();

    try {
      // 1. Provisioning MUST roll back all tables when audit fails
      await expect(
        provisionTenantAtomically(env.PLATFORM_DB, {
          actorUserId: operator.user.id,
          handle: "rollback-site",
          name: "Rollback Site",
          ownerEmail: owner.email,
          reason: "INJECT_AUDIT_FAILURE uji rollback provisioning",
          idempotencyKey: "55555555-5555-4555-8555-555555555555",
          nowMs,
        }),
      ).rejects.toMatchObject({ status: 500, code: "AUDIT_PERSISTENCE_FAILED" });

      const rolledBackTenant = await env.PLATFORM_DB.prepare(
        "SELECT id FROM tenants WHERE handle = 'rollback-site'",
      ).first();
      const rolledBackOrg = await env.PLATFORM_DB.prepare(
        "SELECT id FROM organizations WHERE slug = 'rollback-site'",
      ).first();
      const rolledBackHost = await env.PLATFORM_DB.prepare(
        "SELECT host FROM tenant_hosts WHERE host = 'rollback-site.situsku.click'",
      ).first();
      expect(rolledBackTenant).toBeNull();
      expect(rolledBackOrg).toBeNull();
      expect(rolledBackHost).toBeNull();

      // 2. Provision a real tenant normally, then fail state transition audit -> tenant MUST remain untouched
      const created = await provisionTenantAtomically(env.PLATFORM_DB, {
        actorUserId: operator.user.id,
        handle: "stable-site",
        name: "Stable Site",
        ownerEmail: owner.email,
        initialStatus: "active",
        reason: "Provisioning normal sebelum uji rollback status",
        idempotencyKey: "66666666-6666-4666-8666-666666666666",
        nowMs: nowMs + 100,
      });

      await expect(
        transitionTenantServiceState(env.PLATFORM_DB, {
          actorUserId: operator.user.id,
          tenantId: created.tenant.id,
          action: "suspend_hold",
          reason: "INJECT_AUDIT_FAILURE uji rollback transisi status",
          expectedVersion: created.tenant.version,
          nowMs: nowMs + 200,
        }),
      ).rejects.toMatchObject({ status: 500, code: "AUDIT_PERSISTENCE_FAILED" });

      const afterFailedTransition = await env.PLATFORM_DB.prepare(
        "SELECT status, operator_hold, version, cache_version FROM tenants WHERE id = ?",
      )
        .bind(created.tenant.id)
        .first<{ status: string; operator_hold: number; version: number; cache_version: number }>();

      expect(afterFailedTransition).toEqual({
        status: "active",
        operator_hold: 0,
        version: created.tenant.version,
        cache_version: created.tenant.cacheVersion,
      });
    } finally {
      await env.PLATFORM_DB.prepare("DROP TRIGGER IF EXISTS test_t026_fail_audit").run();
    }
  });

  it("enforces hard 5-member cap (MEMBER_LIMIT_REACHED) sequentially and under concurrent Promise.all invites", async () => {
    const nowMs = Date.now();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-cap@example.com",
      password: "OperatorPass!234",
      nowMs,
    });
    const owner = await createAppUserSession({
      email: "owner-cap@example.com",
      password: "OwnerPassword!234",
      name: "Pemilik Kuota",
    });

    const provisioned = await provisionTenantAtomically(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      handle: "cap-studio",
      name: "Cap Studio",
      ownerEmail: owner.email,
      reason: "Provisioning tenant untuk uji batas 5 anggota",
      idempotencyKey: "77777777-7777-4777-8777-777777777777",
      nowMs,
    });

    // Fire 8 concurrent invites when 1 owner already occupies seat #1 (only 4 seats remain!)
    const mailSink = createLocalMailSink();
    const raceResults = await Promise.allSettled(
      Array.from({ length: 8 }, (_, idx) =>
        createMemberInvitation(env.PLATFORM_DB, {
          organizationId: provisioned.tenant.organizationId,
          tenantId: provisioned.tenant.id,
          tenantName: provisioned.tenant.name,
          handle: provisioned.tenant.handle,
          inviterUserId: owner.userId,
          inviterName: "Pemilik Kuota",
          email: `staff-${idx + 1}@example.com`,
          role: idx % 2 === 0 ? "editor" : "admin",
          emailPort: mailSink,
          nowMs: nowMs + idx,
        }),
      ),
    );

    const fulfilled = raceResults.filter((r) => r.status === "fulfilled");
    const rejected = raceResults.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(MAX_TENANT_MEMBERS - 1); // exactly 4 invites succeed
    expect(rejected).toHaveLength(4); // remaining 4 rejected with MEMBER_LIMIT_REACHED
    for (const rej of rejected) {
      expect(rej.reason).toBeInstanceOf(InvitationError);
      expect((rej.reason as InvitationError).code).toBe("MEMBER_LIMIT_REACHED");
    }

    const snapshotFull = await listTenantMembersAndInvitations(env.PLATFORM_DB, {
      tenantId: provisioned.tenant.id,
      nowMs: nowMs + 100,
    });
    expect(snapshotFull.seatsUsed).toBe(5);
    expect(snapshotFull.seatsRemaining).toBe(0);
    expect(snapshotFull.invitationExpiryHours).toBe(INVITATION_EXPIRY_HOURS);

    // Explicit 6th invite fails with MEMBER_LIMIT_REACHED
    await expect(
      createMemberInvitation(env.PLATFORM_DB, {
        organizationId: provisioned.tenant.organizationId,
        tenantId: provisioned.tenant.id,
        inviterUserId: owner.userId,
        email: "sixth-member@example.com",
        role: "editor",
        nowMs: nowMs + 200,
      }),
    ).rejects.toMatchObject({ status: 409, code: "MEMBER_LIMIT_REACHED" });

    // Revoking 1 pending invite frees 1 seat immediately
    const firstInviteId = snapshotFull.pendingInvitations[0]!.invitationId;
    await revokeMemberInvitation(env.PLATFORM_DB, {
      organizationId: provisioned.tenant.organizationId,
      tenantId: provisioned.tenant.id,
      invitationId: firstInviteId,
      actorUserId: owner.userId,
      nowMs: nowMs + 300,
    });

    const replacement = await createMemberInvitation(env.PLATFORM_DB, {
      organizationId: provisioned.tenant.organizationId,
      tenantId: provisioned.tenant.id,
      inviterUserId: owner.userId,
      email: "replacement@example.com",
      role: "admin",
      nowMs: nowMs + 400,
    });
    expect(replacement.expiresInSeconds).toBe(INVITATION_EXPIRY_SECONDS);
    expect(replacement.invitation.expiresAtMs - replacement.invitation.createdAtMs).toBe(
      INVITATION_EXPIRY_SECONDS * 1000,
    );
  });

  it("enforces identity-bound, 48h expiring, single-use invitation acceptance and rejects wrong-email, expired, revoked, and replayed tokens", async () => {
    const nowMs = Date.now();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-inv@example.com",
      password: "OperatorPass!234",
      nowMs,
    });
    const owner = await createAppUserSession({
      email: "owner-inv@example.com",
      password: "OwnerPassword!234",
      name: "Pemilik Undangan",
    });
    const invitedUser = await createAppUserSession({
      email: "editor-target@example.com",
      password: "EditorPassword!234",
      name: "Editor Target",
    });
    const wrongUser = await createAppUserSession({
      email: "intruder@example.com",
      password: "IntruderPassword!234",
      name: "Akun Lain",
    });

    const provisioned = await provisionTenantAtomically(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      handle: "invite-site",
      name: "Invite Site",
      ownerEmail: owner.email,
      reason: "Provisioning tenant untuk uji token undangan",
      idempotencyKey: "88888888-8888-4888-8888-888888888888",
      nowMs,
    });

    // Create 48h invitation for editor-target@example.com
    const invite = await createMemberInvitation(env.PLATFORM_DB, {
      organizationId: provisioned.tenant.organizationId,
      tenantId: provisioned.tenant.id,
      inviterUserId: owner.userId,
      email: "Editor-Target@Example.com",
      role: "editor",
      nowMs,
    });

    // Verify plaintext token is NEVER stored in DB
    const storedVerif = await env.PLATFORM_DB.prepare(
      "SELECT identifier, value FROM verifications WHERE id = ?",
    )
      .bind(`invtok_${invite.invitation.invitationId}`)
      .first<{ identifier: string; value: string }>();
    expect(storedVerif?.identifier).toBe(`member-invite:${invite.tokenHash}`);
    expect(storedVerif?.identifier).not.toContain(invite.token);
    expect(storedVerif?.value).not.toContain(invite.token);

    // 1. Wrong email user -> 403 INVITATION_EMAIL_MISMATCH (and does NOT consume token!)
    await expect(
      acceptMemberInvitation(env.PLATFORM_DB, {
        token: invite.token,
        acceptingUserId: wrongUser.userId,
        nowMs: nowMs + 1000,
      }),
    ).rejects.toMatchObject({ status: 403, code: "INVITATION_EMAIL_MISMATCH" });

    // 2. Concurrent double-accept by the invited user -> exactly ONE succeeds, ONE fails with INVITATION_ALREADY_USED
    const [a1, a2] = await Promise.allSettled([
      acceptMemberInvitation(env.PLATFORM_DB, {
        token: invite.token,
        acceptingUserId: invitedUser.userId,
        nowMs: nowMs + 2000,
      }),
      acceptMemberInvitation(env.PLATFORM_DB, {
        token: invite.token,
        acceptingUserId: invitedUser.userId,
        nowMs: nowMs + 2000,
      }),
    ]);
    const acceptedOk = [a1, a2].filter((r) => r.status === "fulfilled");
    const acceptedFail = [a1, a2].filter((r) => r.status === "rejected");
    expect(acceptedOk).toHaveLength(1);
    expect(acceptedFail).toHaveLength(1);

    // 3. Subsequent replay fails cleanly
    await expect(
      acceptMemberInvitation(env.PLATFORM_DB, {
        token: invite.token,
        acceptingUserId: invitedUser.userId,
        nowMs: nowMs + 3000,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // 4. Expired invitation (after 48 hours + 1ms) fails with INVITATION_EXPIRED
    const expiringUser = await createAppUserSession({
      email: "late-user@example.com",
      password: "LatePassword!234",
      name: "Late User",
    });
    const expiringInvite = await createMemberInvitation(env.PLATFORM_DB, {
      organizationId: provisioned.tenant.organizationId,
      tenantId: provisioned.tenant.id,
      inviterUserId: owner.userId,
      email: expiringUser.email,
      role: "admin",
      nowMs,
    });
    await expect(
      acceptMemberInvitation(env.PLATFORM_DB, {
        token: expiringInvite.token,
        acceptingUserId: expiringUser.userId,
        nowMs: nowMs + INVITATION_EXPIRY_SECONDS * 1000 + 1,
      }),
    ).rejects.toMatchObject({ status: 409, code: "INVITATION_EXPIRED" });

    // 5. Revoked invitation cannot be accepted
    const revokedUser = await createAppUserSession({
      email: "revoked-user@example.com",
      password: "RevokedPassword!234",
      name: "Revoked User",
    });
    const toRevoke = await createMemberInvitation(env.PLATFORM_DB, {
      organizationId: provisioned.tenant.organizationId,
      tenantId: provisioned.tenant.id,
      inviterUserId: owner.userId,
      email: revokedUser.email,
      role: "editor",
      nowMs: nowMs + 5000,
    });
    await revokeMemberInvitation(env.PLATFORM_DB, {
      organizationId: provisioned.tenant.organizationId,
      tenantId: provisioned.tenant.id,
      invitationId: toRevoke.invitation.invitationId,
      actorUserId: owner.userId,
      nowMs: nowMs + 6000,
    });
    await expect(
      acceptMemberInvitation(env.PLATFORM_DB, {
        token: toRevoke.token,
        acceptingUserId: revokedUser.userId,
        nowMs: nowMs + 7000,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("protects final owner on single & concurrent removal/demotion and immediately blocks revoked members", async () => {
    const nowMs = Date.now();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-final-owner@example.com",
      password: "OperatorPass!234",
      nowMs,
    });
    const owner1 = await createAppUserSession({
      email: "owner1@example.com",
      password: "OwnerPassword!234",
      name: "Owner Satu",
    });
    const owner2 = await createAppUserSession({
      email: "owner2@example.com",
      password: "OwnerPassword!234",
      name: "Owner Dua",
    });
    const editor = await createAppUserSession({
      email: "editor-revoke@example.com",
      password: "EditorPassword!234",
      name: "Editor Dicabut",
    });

    const provisioned = await provisionTenantAtomically(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      handle: "owner-guard-site",
      name: "Owner Guard Site",
      ownerEmail: owner1.email,
      reason: "Provisioning tenant untuk uji perlindungan pemilik terakhir",
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
      nowMs,
    });
    const owner1MemberId =
      provisioned.ownerAssignment.kind === "member" ? provisioned.ownerAssignment.memberId : "";

    // Single owner cannot be removed or demoted
    await expect(
      removeTenantMember(env.PLATFORM_DB, {
        organizationId: provisioned.tenant.organizationId,
        tenantId: provisioned.tenant.id,
        actorUserId: owner1.userId,
        targetMemberId: owner1MemberId,
        nowMs: nowMs + 100,
      }),
    ).rejects.toMatchObject({ status: 409, code: "LAST_OWNER_PROTECTED" });

    await expect(
      updateTenantMemberRole(env.PLATFORM_DB, {
        organizationId: provisioned.tenant.organizationId,
        tenantId: provisioned.tenant.id,
        actorUserId: owner1.userId,
        targetMemberId: owner1MemberId,
        newRole: "admin",
        nowMs: nowMs + 200,
      }),
    ).rejects.toMatchObject({ status: 409, code: "LAST_OWNER_PROTECTED" });

    // Seed a 2nd owner & an editor to test concurrent owner removal + immediate member revocation
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
      ).bind("mem_owner_2", provisioned.tenant.organizationId, owner2.userId, nowMs + 300),
      env.PLATFORM_DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'editor', ?)",
      ).bind("mem_editor_rev", provisioned.tenant.organizationId, editor.userId, nowMs + 300),
    ]);

    // Concurrent removal of BOTH owners -> exactly 1 succeeds, 1 fails LAST_OWNER_PROTECTED
    const [rem1, rem2] = await Promise.allSettled([
      removeTenantMember(env.PLATFORM_DB, {
        organizationId: provisioned.tenant.organizationId,
        tenantId: provisioned.tenant.id,
        actorUserId: owner1.userId,
        targetMemberId: owner1MemberId,
        nowMs: nowMs + 400,
      }),
      removeTenantMember(env.PLATFORM_DB, {
        organizationId: provisioned.tenant.organizationId,
        tenantId: provisioned.tenant.id,
        actorUserId: owner2.userId,
        targetMemberId: "mem_owner_2",
        nowMs: nowMs + 400,
      }),
    ]);
    expect([rem1, rem2].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failedOwnerRem = [rem1, rem2].find((r) => r.status === "rejected");
    expect(failedOwnerRem?.status).toBe("rejected");
    expect((failedOwnerRem as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      code: "LAST_OWNER_PROTECTED",
    });

    const remainingOwners = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS c FROM members WHERE organization_id = ? AND role = 'owner'",
    )
      .bind(provisioned.tenant.organizationId)
      .first<{ c: number }>();
    expect(remainingOwners?.c).toBe(1);

    // Editor initially authorized -> remove editor -> subsequent request IMMEDIATELY denied!
    const beforeRevoke = await resolveAuthorizedTenantMember(env.PLATFORM_DB, {
      userId: editor.userId,
      handle: provisioned.tenant.handle,
      requiredPermission: "content:write",
    });
    expect(beforeRevoke.role).toBe("editor");

    await removeTenantMember(env.PLATFORM_DB, {
      organizationId: provisioned.tenant.organizationId,
      tenantId: provisioned.tenant.id,
      actorUserId: owner1.userId,
      targetMemberId: "mem_editor_rev",
      nowMs: nowMs + 500,
    });

    await expect(
      resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: editor.userId,
        handle: provisioned.tenant.handle,
        requiredPermission: "content:write",
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("enforces reauthentication, concurrency atomicity, audit logging, and immediate owner-only billing access shift on owner transfer", async () => {
    const nowMs = Date.now();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-transfer@example.com",
      password: "OperatorPass!234",
      nowMs,
    });
    const ownerPassword = "OwnerTransferPass!234";
    const owner = await createAppUserSession({
      email: "owner-xfer@example.com",
      password: ownerPassword,
      name: "Pemilik Lama",
    });
    const adminA = await createAppUserSession({
      email: "admin-a@example.com",
      password: "AdminAPassword!234",
      name: "Calon Pemilik A",
    });
    const adminB = await createAppUserSession({
      email: "admin-b@example.com",
      password: "AdminBPassword!234",
      name: "Calon Pemilik B",
    });

    const provisioned = await provisionTenantAtomically(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      handle: "transfer-site",
      name: "Transfer Site",
      ownerEmail: owner.email,
      initialStatus: "active",
      reason: "Provisioning tenant untuk uji alih kepemilikan atomik",
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      nowMs,
    });

    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      ).bind("mem_admin_a", provisioned.tenant.organizationId, adminA.userId, nowMs + 100),
      env.PLATFORM_DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      ).bind("mem_admin_b", provisioned.tenant.organizationId, adminB.userId, nowMs + 100),
    ]);

    // Before transfer: old owner has billing access; adminA & adminB do NOT
    const billingBefore = await assertTenantOwnerBillingAccess(env.PLATFORM_DB, {
      userId: owner.userId,
      handle: provisioned.tenant.handle,
    });
    expect(billingBefore.role).toBe("owner");
    await expect(
      assertTenantOwnerBillingAccess(env.PLATFORM_DB, {
        userId: adminA.userId,
        handle: provisioned.tenant.handle,
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    // 1. Missing reauth -> 403 REAUTH_REQUIRED
    await expect(
      transferTenantOwnership(env.PLATFORM_DB, {
        organizationId: provisioned.tenant.organizationId,
        tenantId: provisioned.tenant.id,
        tenantHandle: provisioned.tenant.handle,
        confirmTenantHandle: provisioned.tenant.handle,
        actorUserId: owner.userId,
        actorSessionId: owner.sessionId,
        targetMemberId: "mem_admin_a",
        nowMs: nowMs + 200,
      }),
    ).rejects.toMatchObject({ status: 403, code: "REAUTH_REQUIRED" });

    // 2. Stale reauth (> 10 minutes old) -> 403 REAUTH_REQUIRED
    await expect(
      transferTenantOwnership(env.PLATFORM_DB, {
        organizationId: provisioned.tenant.organizationId,
        tenantId: provisioned.tenant.id,
        tenantHandle: provisioned.tenant.handle,
        confirmTenantHandle: provisioned.tenant.handle,
        actorUserId: owner.userId,
        targetMemberId: "mem_admin_a",
        reauthenticatedAtMs: nowMs - 11 * 60 * 1000,
        nowMs: nowMs + 200,
      }),
    ).rejects.toMatchObject({ status: 403, code: "REAUTH_REQUIRED" });

    // 3. Concurrent transfers to Admin A and Admin B with valid password reauth -> EXACTLY ONE wins!
    const [t1, t2] = await Promise.allSettled([
      transferTenantOwnership(env.PLATFORM_DB, {
        organizationId: provisioned.tenant.organizationId,
        tenantId: provisioned.tenant.id,
        tenantHandle: provisioned.tenant.handle,
        confirmTenantHandle: provisioned.tenant.handle,
        actorUserId: owner.userId,
        targetMemberId: "mem_admin_a",
        currentPassword: ownerPassword,
        nowMs: nowMs + 300,
      }),
      transferTenantOwnership(env.PLATFORM_DB, {
        organizationId: provisioned.tenant.organizationId,
        tenantId: provisioned.tenant.id,
        tenantHandle: provisioned.tenant.handle,
        confirmTenantHandle: provisioned.tenant.handle,
        actorUserId: owner.userId,
        targetMemberId: "mem_admin_b",
        currentPassword: ownerPassword,
        nowMs: nowMs + 300,
      }),
    ]);

    const winners = [t1, t2].filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof transferTenantOwnership>>> =>
        r.status === "fulfilled",
    );
    const losers = [t1, t2].filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winner = winners[0]!.value;
    expect(winner.audit.action).toBe("tenant.owner.transfer");

    // Exactly ONE owner exists in DB
    const ownersInDb = await env.PLATFORM_DB.prepare(
      "SELECT user_id, role FROM members WHERE organization_id = ? AND role = 'owner'",
    )
      .bind(provisioned.tenant.organizationId)
      .all<{ user_id: string; role: string }>();
    expect(ownersInDb.results).toHaveLength(1);
    expect(ownersInDb.results[0]?.user_id).toBe(winner.newOwnerUserId);

    // Owner-only billing access IMMEDIATELY shifts from old owner to new owner!
    await expect(
      assertTenantOwnerBillingAccess(env.PLATFORM_DB, {
        userId: owner.userId,
        handle: provisioned.tenant.handle,
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    const newOwnerBilling = await assertTenantOwnerBillingAccess(env.PLATFORM_DB, {
      userId: winner.newOwnerUserId,
      handle: provisioned.tenant.handle,
    });
    expect(newOwnerBilling.role).toBe("owner");

    // Verify HTTP members API reflects immediate billing access shift for old owner vs new owner
    const appEnv = {
      APP_ENV: "production",
      PLATFORM_DOMAIN: "punyasitus.com",
      PLATFORM_DB: env.PLATFORM_DB,
      AUTH_SECRET: APP_SECRET,
    };
    const oldOwnerBillingRes = await handleMembersApiRequest(
      provisioned.tenant.handle,
      new Request(`${APP_ORIGIN}/dashboard/${provisioned.tenant.handle}/settings/members/api`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: owner.cookieHeader,
        },
        body: JSON.stringify({ action: "billing-access-check" }),
      }),
      appEnv,
      { nowMs: nowMs + 400 },
    );
    expect(oldOwnerBillingRes.status).toBe(403);

    const winnerCookie = winner.newOwnerUserId === adminA.userId ? adminA.cookieHeader : adminB.cookieHeader;
    const newOwnerBillingRes = await handleMembersApiRequest(
      provisioned.tenant.handle,
      new Request(`${APP_ORIGIN}/dashboard/${provisioned.tenant.handle}/settings/members/api`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: winnerCookie,
        },
        body: JSON.stringify({ action: "billing-access-check" }),
      }),
      appEnv,
      { nowMs: nowMs + 400 },
    );
    expect(newOwnerBillingRes.status).toBe(200);
  });

  it("enforces console HTTP boundaries, 2FA step-up, operator revocation, and immediate effect of audited service-state transitions", async () => {
    const nowMs = Date.now();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const op1 = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-http-1@example.com",
      password: "OperatorPass!234",
      nowMs,
    });
    const op2 = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-http-2@example.com",
      password: "OperatorPass!234",
      nowMs,
    });

    const consoleEnv = {
      APP_ENV: "production",
      PLATFORM_DOMAIN: "punyasitus.com",
      SAAS_ZONE: "situsku.click",
      PLATFORM_DB: env.PLATFORM_DB,
      TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
      AUTH_SECRET: APP_SECRET,
    };

    // 1. App host rejected with 404
    const wrongHostRes = await handleConsoleProvisioningRequest(
      new Request(`${APP_ORIGIN}/api/console/provisioning`, {
        method: "GET",
        headers: { cookie: op1.cookieHeader },
      }),
      consoleEnv,
      { nowMs },
    );
    expect(wrongHostRes.status).toBe(404);

    // 2. Provision via console HTTP endpoint -> 201, replay -> 200
    const provKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const provBody = JSON.stringify({
      handle: "http-bisnis",
      name: "HTTP Bisnis",
      ownerEmail: "owner-http@example.com",
      vertical: "compro",
      initialStatus: "active",
      reason: "Provisioning via console API untuk klien HTTP Bisnis",
      idempotencyKey: provKey,
    });

    const createRes = await handleConsoleProvisioningRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/provisioning`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          "Idempotency-Key": provKey,
          cookie: op1.cookieHeader,
        },
        body: provBody,
      }),
      consoleEnv,
      { nowMs: nowMs + 100 },
    );
    expect(createRes.status).toBe(201);
    const createdJson = (await createRes.json()) as {
      tenant: { id: string; handle: string; version: number; cacheVersion: number };
      replayed: boolean;
    };
    expect(createdJson.replayed).toBe(false);

    const replayRes = await handleConsoleProvisioningRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/provisioning`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          "Idempotency-Key": provKey,
          cookie: op1.cookieHeader,
        },
        body: provBody,
      }),
      consoleEnv,
      { nowMs: nowMs + 200 },
    );
    expect(replayRes.status).toBe(200);
    const replayJson = (await replayRes.json()) as { replayed: boolean; tenant: { id: string } };
    expect(replayJson.replayed).toBe(true);
    expect(replayJson.tenant.id).toBe(createdJson.tenant.id);

    // 3. Warm host resolution cache while active
    const resolvedActive = await resolveTenantByHost(
      env.PLATFORM_DB,
      "http-bisnis.situsku.click",
      { nowMs: nowMs + 300 },
    );
    expect(resolvedActive.kind).toBe("resolved");
    if (resolvedActive.kind === "resolved") {
      expect(resolvedActive.tenant.effectiveStatus).toBe("active");
    }

    // 4. Stale 2FA (> 10 minutes) rejected with 403 RECENT_SECOND_FACTOR_REQUIRED
    await recordSessionSecondFactorVerification(env.PLATFORM_DB, {
      sessionId: op1.session.id,
      userId: op1.user.id,
      method: "totp",
      nowMs: nowMs - 11 * 60 * 1000,
    });
    const stale2faRes = await handleConsoleTenantStateRequest(
      createdJson.tenant.id,
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants/${createdJson.tenant.id}/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op1.cookieHeader,
        },
        body: JSON.stringify({
          action: "suspend_hold",
          reason: "Menangguhkan situs setelah laporan penyalahgunaan masuk",
          expectedVersion: createdJson.tenant.version,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 400 },
    );
    expect(stale2faRes.status).toBe(403);
    const staleJson = (await stale2faRes.json()) as { code: string };
    expect(staleJson.code).toBe("RECENT_SECOND_FACTOR_REQUIRED");

    // 5. Refresh 2FA -> apply suspend_hold -> IMMEDIATELY takes effect on resolveTenantByHost (evicts cache!)
    await recordSessionSecondFactorVerification(env.PLATFORM_DB, {
      sessionId: op1.session.id,
      userId: op1.user.id,
      method: "totp",
      nowMs: nowMs + 450,
    });
    const holdRes = await handleConsoleTenantStateRequest(
      createdJson.tenant.id,
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants/${createdJson.tenant.id}/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op1.cookieHeader,
        },
        body: JSON.stringify({
          action: "suspend_hold",
          reason: "Menangguhkan situs setelah laporan penyalahgunaan masuk",
          expectedVersion: createdJson.tenant.version,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 500 },
    );
    expect(holdRes.status).toBe(200);

    const resolvedSuspended = await resolveTenantByHost(
      env.PLATFORM_DB,
      "http-bisnis.situsku.click",
      { nowMs: nowMs + 501 },
    );
    expect(resolvedSuspended.kind).toBe("resolved");
    if (resolvedSuspended.kind === "resolved") {
      expect(resolvedSuspended.fromCache).toBe(false);
      expect(resolvedSuspended.tenant.effectiveStatus).toBe("suspended");
      expect(resolvedSuspended.tenant.operatorHold).toBe(true);
      expect(resolvedSuspended.tenant.cacheVersion).toBeGreaterThan(createdJson.tenant.cacheVersion);
    }

    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      tenantId: createdJson.tenant.id,
      action: "tenant.state.suspend_hold",
    });
    expect(audits).toHaveLength(1);

    // 6. Revoking operator op1 immediately blocks subsequent console requests!
    await revokePlatformOperator(env.PLATFORM_DB, {
      actorUserId: op2.user.id,
      targetUserId: op1.user.id,
      reason: "Mencabut akses operator setelah rotasi tugas selesai",
      nowMs: nowMs + 600,
    });

    const revokedOpRes = await handleConsoleProvisioningRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/provisioning`, {
        method: "GET",
        headers: { cookie: op1.cookieHeader },
      }),
      consoleEnv,
      { nowMs: nowMs + 700 },
    );
    expect(revokedOpRes.status).toBe(403);
    const revokedJson = (await revokedOpRes.json()) as { code: string };
    expect(revokedJson.code).toBe("OPERATOR_REVOKED");
  });

  it("prevents cross-tenant token destruction in revokeMemberInvitation while keeping target tenant token acceptable", async () => {
    const nowMs = Date.now();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-xtenant-rev@example.com",
      password: "OperatorPass!234",
      nowMs,
    });
    const ownerA = await createAppUserSession({
      email: "owner-a-xrev@example.com",
      password: "OwnerPassword!234",
      name: "Pemilik A",
    });
    const ownerB = await createAppUserSession({
      email: "owner-b-xrev@example.com",
      password: "OwnerPassword!234",
      name: "Pemilik B",
    });
    const inviteeB = await createAppUserSession({
      email: "invitee-b-xrev@example.com",
      password: "InviteePassword!234",
      name: "Calon Anggota B",
    });

    const tenantA = await provisionTenantAtomically(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      handle: "tenant-a-xrev",
      name: "Tenant A",
      ownerEmail: ownerA.email,
      reason: "Provisioning Tenant A untuk uji isolasi revoke undangan",
      idempotencyKey: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      nowMs,
    });
    const tenantB = await provisionTenantAtomically(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      handle: "tenant-b-xrev",
      name: "Tenant B",
      ownerEmail: ownerB.email,
      reason: "Provisioning Tenant B untuk uji isolasi revoke undangan",
      idempotencyKey: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
      nowMs: nowMs + 10,
    });

    const inviteB = await createMemberInvitation(env.PLATFORM_DB, {
      organizationId: tenantB.tenant.organizationId,
      tenantId: tenantB.tenant.id,
      handle: tenantB.tenant.handle,
      inviterUserId: ownerB.userId,
      email: inviteeB.email,
      role: "editor",
      nowMs: nowMs + 20,
    });

    // Tenant A attempts to revoke Tenant B's invitationId -> MUST return 404 AND NOT delete Tenant B's token!
    await expect(
      revokeMemberInvitation(env.PLATFORM_DB, {
        organizationId: tenantA.tenant.organizationId,
        tenantId: tenantA.tenant.id,
        invitationId: inviteB.invitation.invitationId,
        actorUserId: ownerA.userId,
        nowMs: nowMs + 30,
      }),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    // Verify Tenant B's verification row is untouched and inviteeB can still accept it cleanly!
    const verifStillPresent = await env.PLATFORM_DB.prepare(
      "SELECT id FROM verifications WHERE id = ?",
    )
      .bind(`invtok_${inviteB.invitation.invitationId}`)
      .first<{ id: string }>();
    expect(verifStillPresent?.id).toBe(`invtok_${inviteB.invitation.invitationId}`);

    const acceptedB = await acceptMemberInvitation(env.PLATFORM_DB, {
      token: inviteB.token,
      acceptingUserId: inviteeB.userId,
      expectedHandle: tenantB.tenant.handle,
      nowMs: nowMs + 40,
    });
    expect(acceptedB.organizationId).toBe(tenantB.tenant.organizationId);
    expect(acceptedB.role).toBe("editor");
  });

  it("delivers initial-owner invitation via EmailPort for unverified/new owner emails and allows non-member acceptance via HTTP route", async () => {
    const nowMs = Date.now();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-owner-inv@example.com",
      password: "OperatorPass!234",
      nowMs,
    });

    // Create an existing UNVERIFIED user (email_verified = 0) and a wrong-email user
    const unverifiedOwner = await createAppUserSession({
      email: "unverified-owner@example.com",
      password: "OwnerPassword!234",
      name: "Pemilik Belum Terverifikasi",
    });
    await env.PLATFORM_DB.prepare("UPDATE users SET email_verified = 0 WHERE id = ?")
      .bind(unverifiedOwner.userId)
      .run();

    const wrongUser = await createAppUserSession({
      email: "wrong-person@example.com",
      password: "WrongPassword!234",
      name: "Orang Lain",
    });

    const mailSink = createLocalMailSink();
    const consoleEnv = {
      APP_ENV: "production",
      PLATFORM_DOMAIN: "punyasitus.com",
      SAAS_ZONE: "situsku.click",
      PLATFORM_DB: env.PLATFORM_DB,
      CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
      AUTH_SECRET: APP_SECRET,
    };

    const provKey = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
    const provRes = await handleConsoleProvisioningRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/provisioning`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          "Idempotency-Key": provKey,
          cookie: operator.cookieHeader,
        },
        body: JSON.stringify({
          handle: "toko-undangan-owner",
          name: "Toko Undangan Owner",
          ownerEmail: unverifiedOwner.email,
          vertical: "compro",
          initialStatus: "trial",
          reason: "Provisioning klien baru yang emailnya belum terverifikasi",
          idempotencyKey: provKey,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 100, emailPort: mailSink },
    );

    expect(provRes.status).toBe(201);
    const provJson = (await provRes.json()) as {
      tenant: { id: string; handle: string };
      ownerAssignment: {
        kind: string;
        invitationId?: string;
        invitationDeliveryStatus?: string;
        invitationToken?: string;
      };
    };
    // Unverified existing user MUST receive an owner invitation, NOT direct member assignment!
    expect(provJson.ownerAssignment.kind).toBe("invitation");
    expect(provJson.ownerAssignment.invitationDeliveryStatus).toBe("sent");
    // Raw token MUST NEVER be leaked in HTTP response
    expect(provJson.ownerAssignment.invitationToken).toBeUndefined();

    // Verify email was sent with /dashboard/<handle>/settings/members/accept?inviteToken=...
    const sentEmails = mailSink.list();
    expect(sentEmails).toHaveLength(1);
    const sentMail = sentEmails[0]!;
    expect(sentMail.to).toBe(unverifiedOwner.email);
    const tokenMatch = /\/dashboard\/toko-undangan-owner\/settings\/members\/accept\?inviteToken=([a-f0-9]+)/.exec(
      sentMail.text,
    );
    expect(tokenMatch?.[1]).toBeTruthy();
    const rawInviteToken = tokenMatch![1]!;

    // Raw token MUST NEVER appear in platform_audit
    const provAudits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      tenantId: provJson.tenant.id,
    });
    expect(JSON.stringify(provAudits)).not.toContain(rawInviteToken);

    const appEnv = {
      APP_ENV: "production",
      PLATFORM_DOMAIN: "punyasitus.com",
      PLATFORM_DB: env.PLATFORM_DB,
      AUTH_SECRET: APP_SECRET,
    };

    const makeAppLocals = (): AuthMiddlewareLocals => ({
      surface: "app",
      host: "app.punyasitus.com",
      isLocalLoopback: false,
      tenant: null,
      tenantDb: null,
      authUser: null,
      authSession: null,
      authorizedTenantMember: null,
      platformOperator: null,
      twoFactorVerifiedAtMs: null,
    });

    // 1. Full middleware: Unauthenticated GET /accept?inviteToken=... -> 302 /auth/login?next=...
    const unauthAcceptRes = await executeAuthMiddleware(
      {
        request: new Request(
          `${APP_ORIGIN}/dashboard/toko-undangan-owner/settings/members/accept?inviteToken=${rawInviteToken}`,
          { method: "GET" },
        ),
        locals: makeAppLocals(),
      },
      async () => new Response("should not reach handler", { status: 200 }),
      appEnv,
      { nowMs: nowMs + 150 },
    );
    expect(unauthAcceptRes.status).toBe(302);
    expect(unauthAcceptRes.headers.get("location")).toContain("/auth/login?next=");

    // 2. Full middleware: Authenticated non-member GET /settings/members -> neutral 404 (still blocked!)
    const nonMemberListRes = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/dashboard/toko-undangan-owner/settings/members`, {
          method: "GET",
          headers: { cookie: unverifiedOwner.cookieHeader },
        }),
        locals: makeAppLocals(),
      },
      async () => new Response("should not reach handler", { status: 200 }),
      appEnv,
      { nowMs: nowMs + 160 },
    );
    expect(nonMemberListRes.status).toBe(404);

    // 3. Full middleware: Authenticated non-member GET /settings/members/accept?inviteToken=... -> allowed through!
    const acceptPageLocals = makeAppLocals();
    const nonMemberAcceptPageRes = await executeAuthMiddleware(
      {
        request: new Request(
          `${APP_ORIGIN}/dashboard/toko-undangan-owner/settings/members/accept?inviteToken=${rawInviteToken}`,
          {
            method: "GET",
            headers: { cookie: unverifiedOwner.cookieHeader },
          },
        ),
        locals: acceptPageLocals,
      },
      async () => new Response("accept page rendered", { status: 200 }),
      appEnv,
      { nowMs: nowMs + 170 },
    );
    expect(nonMemberAcceptPageRes.status).toBe(200);
    expect(acceptPageLocals.authUser?.id).toBe(unverifiedOwner.userId);
    expect(acceptPageLocals.authorizedTenantMember).toBeNull();

    // 4. Full middleware: Authenticated non-member POST /accept/api WITHOUT Origin/CSRF -> 403!
    const missingCsrfAcceptRes = await executeAuthMiddleware(
      {
        request: new Request(
          `${APP_ORIGIN}/dashboard/toko-undangan-owner/settings/members/accept/api`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              cookie: unverifiedOwner.cookieHeader,
            },
            body: JSON.stringify({ action: "accept-invitation", token: rawInviteToken }),
          },
        ),
        locals: makeAppLocals(),
      },
      async () => new Response("should not reach handler", { status: 200 }),
      appEnv,
      { nowMs: nowMs + 180 },
    );
    expect(missingCsrfAcceptRes.status).toBe(403);

    // 5. Full middleware + route handler: Wrong-email user with valid CSRF -> 403 INVITATION_EMAIL_MISMATCH without consuming token
    const wrongAcceptReq = new Request(
      `${APP_ORIGIN}/dashboard/toko-undangan-owner/settings/members/accept/api`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: wrongUser.cookieHeader,
        },
        body: JSON.stringify({ action: "accept-invitation", token: rawInviteToken }),
      },
    );
    const wrongAcceptRes = await executeAuthMiddleware(
      { request: wrongAcceptReq, locals: makeAppLocals() },
      () =>
        handleAcceptInvitationApiRequest("toko-undangan-owner", wrongAcceptReq, appEnv, {
          nowMs: nowMs + 200,
        }),
      appEnv,
      { nowMs: nowMs + 200 },
    );
    expect(wrongAcceptRes.status).toBe(403);
    expect(((await wrongAcceptRes.json()) as { code: string }).code).toBe(
      "INVITATION_EMAIL_MISMATCH",
    );

    // 6. Full middleware + route handler: Invited non-member with valid CSRF -> 200 and becomes active owner!
    const okAcceptReq = new Request(
      `${APP_ORIGIN}/dashboard/toko-undangan-owner/settings/members/accept/api`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: unverifiedOwner.cookieHeader,
        },
        body: JSON.stringify({ action: "accept-invitation", token: rawInviteToken }),
      },
    );
    const okAcceptRes = await executeAuthMiddleware(
      { request: okAcceptReq, locals: makeAppLocals() },
      () =>
        handleAcceptInvitationApiRequest("toko-undangan-owner", okAcceptReq, appEnv, {
          nowMs: nowMs + 300,
        }),
      appEnv,
      { nowMs: nowMs + 300 },
    );
    expect(okAcceptRes.status).toBe(200);

    // Immediately passes full middleware on /dashboard/toko-undangan-owner/settings/members as owner!
    const afterAcceptLocals = makeAppLocals();
    const memberNowRes = await executeAuthMiddleware(
      {
        request: new Request(`${APP_ORIGIN}/dashboard/toko-undangan-owner/settings/members`, {
          method: "GET",
          headers: { cookie: unverifiedOwner.cookieHeader },
        }),
        locals: afterAcceptLocals,
      },
      async () => new Response("members page ok", { status: 200 }),
      appEnv,
      { nowMs: nowMs + 350 },
    );
    expect(memberNowRes.status).toBe(200);
    expect(afterAcceptLocals.authorizedTenantMember?.role).toBe("owner");

    const resolvedOwner = await resolveAuthorizedTenantMember(env.PLATFORM_DB, {
      userId: unverifiedOwner.userId,
      handle: "toko-undangan-owner",
      requiredPermission: "billing:read",
    });
    expect(resolvedOwner.role).toBe("owner");

    // 7. Replaying the accepted token returns 409
    const replayAcceptReq = new Request(
      `${APP_ORIGIN}/dashboard/toko-undangan-owner/settings/members/accept/api`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: unverifiedOwner.cookieHeader,
        },
        body: JSON.stringify({ action: "accept-invitation", token: rawInviteToken }),
      },
    );
    const replayAcceptRes = await executeAuthMiddleware(
      { request: replayAcceptReq, locals: makeAppLocals() },
      () =>
        handleAcceptInvitationApiRequest("toko-undangan-owner", replayAcceptReq, appEnv, {
          nowMs: nowMs + 400,
        }),
      appEnv,
      { nowMs: nowMs + 400 },
    );
    expect(replayAcceptRes.status).toBe(409);
  });

  it("strictly requires expectedVersion, enforces set_status deadlines, and scopes state-transition idempotency to tenantId", async () => {
    const nowMs = Date.now();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-version-idemp@example.com",
      password: "OperatorPass!234",
      nowMs,
    });
    const owner = await createAppUserSession({
      email: "owner-ver@example.com",
      password: "OwnerPassword!234",
      name: "Pemilik Versi",
    });

    const t1 = await provisionTenantAtomically(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      handle: "tenant-ver-1",
      name: "Tenant Ver 1",
      ownerEmail: owner.email,
      initialStatus: "trial",
      reason: "Provisioning tenant 1 untuk uji expectedVersion & idempotency",
      idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
      nowMs,
    });
    const t2 = await provisionTenantAtomically(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      handle: "tenant-ver-2",
      name: "Tenant Ver 2",
      ownerEmail: owner.email,
      initialStatus: "trial",
      reason: "Provisioning tenant 2 untuk uji scoping idempotency antar tenant",
      idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
      nowMs: nowMs + 10,
    });

    const consoleEnv = {
      APP_ENV: "production",
      PLATFORM_DOMAIN: "punyasitus.com",
      SAAS_ZONE: "situsku.click",
      PLATFORM_DB: env.PLATFORM_DB,
      CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
      AUTH_SECRET: APP_SECRET,
    };

    // 1. Omitted expectedVersion -> 422 VALIDATION_ERROR (HTTP + service) with zero mutations
    const missingVerRes = await handleConsoleTenantStateRequest(
      t1.tenant.id,
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants/${t1.tenant.id}/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: operator.cookieHeader,
        },
        body: JSON.stringify({
          action: "suspend_hold",
          reason: "Mencoba transisi tanpa expectedVersion harus ditolak",
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 50 },
    );
    expect(missingVerRes.status).toBe(422);
    expect(((await missingVerRes.json()) as { code: string }).code).toBe("VALIDATION_ERROR");

    // Non-integer expectedVersion -> 422 VALIDATION_ERROR
    await expect(
      transitionTenantServiceState(env.PLATFORM_DB, {
        actorUserId: operator.user.id,
        tenantId: t1.tenant.id,
        action: "suspend_hold",
        reason: "Mencoba transisi dengan expectedVersion non-integer",
        expectedVersion: 1.5,
        nowMs: nowMs + 60,
      }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });

    // 2. set_status -> active without paidThroughMs -> 422 VALIDATION_ERROR
    const noDeadlineRes = await handleConsoleTenantStateRequest(
      t1.tenant.id,
      new Request(`${CONSOLE_ORIGIN}/api/console/tenants/${t1.tenant.id}/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: operator.cookieHeader,
        },
        body: JSON.stringify({
          action: "set_status",
          targetStatus: "active",
          expectedVersion: t1.tenant.version,
          reason: "Mencoba aktif tanpa paidThroughMs harus ditolak",
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 70 },
    );
    expect(noDeadlineRes.status).toBe(422);

    // Verify t1 was NOT mutated and no state audit was written
    const t1Unchanged = await env.PLATFORM_DB.prepare(
      "SELECT status, version FROM tenants WHERE id = ?",
    )
      .bind(t1.tenant.id)
      .first<{ status: string; version: number }>();
    expect(t1Unchanged).toEqual({ status: "trial", version: t1.tenant.version });

    // 3. Idempotency-Key used on Tenant 1 MUST NOT replay or succeed on Tenant 2 -> 409 IDEMPOTENCY_CONFLICT!
    const sharedKey = "ffffffff-ffff-4fff-8fff-fffffffffff1";
    const okT1 = await transitionTenantServiceState(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      tenantId: t1.tenant.id,
      action: "suspend_hold",
      reason: "Menangguhkan tenant 1 dengan kunci idempotensi khusus",
      expectedVersion: t1.tenant.version,
      idempotencyKey: sharedKey,
      nowMs: nowMs + 100,
    });
    expect(okT1.replayed).toBe(false);
    expect(okT1.tenant.status).toBe("suspended");

    // Same key on Tenant 1 -> idempotent replay
    const replayT1 = await transitionTenantServiceState(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      tenantId: t1.tenant.id,
      action: "suspend_hold",
      reason: "Menangguhkan tenant 1 dengan kunci idempotensi khusus",
      expectedVersion: t1.tenant.version,
      idempotencyKey: sharedKey,
      nowMs: nowMs + 110,
    });
    expect(replayT1.replayed).toBe(true);
    expect(replayT1.tenant.id).toBe(t1.tenant.id);

    // Same key on Tenant 2 -> 409 IDEMPOTENCY_CONFLICT and Tenant 2 stays untouched!
    await expect(
      transitionTenantServiceState(env.PLATFORM_DB, {
        actorUserId: operator.user.id,
        tenantId: t2.tenant.id,
        action: "suspend_hold",
        reason: "Mencoba menggunakan ulang kunci idempotensi di tenant berbeda",
        expectedVersion: t2.tenant.version,
        idempotencyKey: sharedKey,
        nowMs: nowMs + 120,
      }),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });

    const t2StillTrial = await env.PLATFORM_DB.prepare(
      "SELECT status, operator_hold, version FROM tenants WHERE id = ?",
    )
      .bind(t2.tenant.id)
      .first<{ status: string; operator_hold: number; version: number }>();
    expect(t2StillTrial).toEqual({ status: "trial", operator_hold: 0, version: t2.tenant.version });
  });
});

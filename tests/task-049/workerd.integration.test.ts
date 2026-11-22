import { env } from "cloudflare:workers";
import {
  executeAuditedPlatformGrant,
  executeAuditedPlatformRevoke,
  PlatformGuardError,
  requireActivePlatformOperator,
} from "@punyasitus/auth/platform/index";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import {
  bootstrapInitialPlatformOperator,
  countActivePlatformOperators,
  getActivePlatformOperator,
  getPlatformOperatorGrant,
  grantPlatformOperator,
  listPlatformAuditEntries,
  listPlatformOperators,
  PLATFORM_MIGRATIONS,
  PlatformOperatorError,
  revokePlatformOperator,
} from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const BASE_NOW_MS = 1_763_830_000_000;

async function resetOperatorTables(): Promise<void> {
  // Note: platform_audit is append-only (triggers block DELETE/UPDATE), so we only clean
  // mutable auth/operator fixtures before each test and scope audit queries by unique IDs/actions.
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM organizations"),
    env.PLATFORM_DB.prepare("DELETE FROM sessions"),
    env.PLATFORM_DB.prepare("DELETE FROM users"),
  ]);
}

async function seedUser(params: {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified?: boolean;
  readonly twoFactorEnabled?: boolean;
}): Promise<void> {
  await env.PLATFORM_DB.prepare(
    `
    INSERT INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      params.id,
      params.name,
      params.email,
      params.emailVerified === false ? 0 : 1,
      params.twoFactorEnabled === true ? 1 : 0,
      BASE_NOW_MS,
      BASE_NOW_MS,
    )
    .run();
}

async function seedSession(params: {
  readonly id: string;
  readonly userId: string;
  readonly token?: string;
  readonly expiresAtMs?: number;
}): Promise<{ readonly id: string; readonly userId: string; readonly token: string }> {
  const token = params.token ?? `tok_${params.id}`;
  const expiresAtMs = params.expiresAtMs ?? BASE_NOW_MS + 60 * 60 * 1000;
  await env.PLATFORM_DB.prepare(
    `
    INSERT INTO sessions (id, expires_at, token, user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(params.id, expiresAtMs, token, params.userId, BASE_NOW_MS, BASE_NOW_MS)
    .run();
  return { id: params.id, userId: params.userId, token };
}

async function seedTenantMembership(params: {
  readonly orgId: string;
  readonly memberId: string;
  readonly userId: string;
  readonly role: "owner" | "admin" | "editor";
}): Promise<void> {
  await env.PLATFORM_DB.prepare(
    `
    INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    `,
  )
    .bind(params.orgId, `Org ${params.orgId}`, params.orgId, BASE_NOW_MS, BASE_NOW_MS)
    .run();

  await env.PLATFORM_DB.prepare(
    `
    INSERT INTO members (id, organization_id, user_id, role, created_at)
    VALUES (?, ?, ?, ?, ?)
    `,
  )
    .bind(params.memberId, params.orgId, params.userId, params.role, BASE_NOW_MS)
    .run();
}

describe("TASK-049 workerd integration — Platform Grant, Bootstrap & Atomic Audit", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  beforeEach(async () => {
    await resetOperatorTables();
  });

  it("bootstraps an existing verified user atomically with audit and refuses unverified or duplicate initial bootstrap", async () => {
    await seedUser({
      id: "usr_unverified_1",
      email: "unverified@example.com",
      name: "Unverified Account",
      emailVerified: false,
    });
    await seedUser({
      id: "usr_boot_1",
      email: "founder-op@example.com",
      name: "Founder Operator",
      emailVerified: true,
    });
    await seedUser({
      id: "usr_boot_2",
      email: "second-op@example.com",
      name: "Second Operator",
      emailVerified: true,
    });

    // Unverified user must fail closed
    await expect(
      bootstrapInitialPlatformOperator(env.PLATFORM_DB, {
        userId: "usr_unverified_1",
        reason: "Attempt bootstrap on unverified user account",
        requestId: "req_boot_unverified",
        nowMs: BASE_NOW_MS,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "USER_NOT_VERIFIED",
    });

    expect(await countActivePlatformOperators(env.PLATFORM_DB)).toBe(0);

    // Verified user bootstrap succeeds atomically
    const boot = await bootstrapInitialPlatformOperator(env.PLATFORM_DB, {
      userId: "usr_boot_1",
      reason: "Trusted-environment synthetic bootstrap with password=ShouldRedact123",
      requestId: "req_boot_001",
      nowMs: BASE_NOW_MS + 100,
    });

    expect(boot.operator.userId).toBe("usr_boot_1");
    expect(boot.operator.isActive).toBe(true);
    expect(boot.operator.grantedBy).toBeNull();
    expect(boot.operator.reason).not.toContain("ShouldRedact123");
    expect(boot.operator.reason).toContain("[REDACTED]");

    expect(boot.audit.action).toBe("platform_operator.bootstrap");
    expect(boot.audit.outcome).toBe("success");
    expect(boot.audit.targetId).toBe("usr_boot_1");
    expect(boot.audit.reason).not.toContain("ShouldRedact123");

    const active = await getActivePlatformOperator(env.PLATFORM_DB, "usr_boot_1");
    expect(active?.isActive).toBe(true);
    expect(await countActivePlatformOperators(env.PLATFORM_DB)).toBe(1);

    // Second initial bootstrap is refused once an active operator exists
    await expect(
      bootstrapInitialPlatformOperator(env.PLATFORM_DB, {
        userId: "usr_boot_2",
        reason: "Unauthorized second bootstrap attempt",
        requestId: "req_boot_dup",
        nowMs: BASE_NOW_MS + 200,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "ALREADY_BOOTSTRAPPED",
    });

    const auditRows = await listPlatformAuditEntries(env.PLATFORM_DB, {
      requestId: "req_boot_001",
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.id).toBe(boot.audit.id);
    expect(auditRows[0]?.reason).not.toContain("ShouldRedact123");
  });

  it("denies tenant owner/admin/editor escalation, revoked sessions, expired sessions, and revoked operators with live sessions", async () => {
    await seedUser({ id: "usr_op_alpha", email: "alpha-op@punyasitus.com", name: "Alpha Op" });
    await seedUser({ id: "usr_op_beta", email: "beta-op@punyasitus.com", name: "Beta Op" });
    await seedUser({ id: "usr_tenant_owner", email: "owner@punyasitus.com", name: "Tenant Owner" });
    await seedUser({ id: "usr_tenant_admin", email: "admin@punyasitus.com", name: "Tenant Admin" });
    await seedUser({ id: "usr_tenant_editor", email: "editor@punyasitus.com", name: "Tenant Editor" });

    await seedTenantMembership({
      orgId: "org_t1",
      memberId: "mem_owner",
      userId: "usr_tenant_owner",
      role: "owner",
    });
    await seedTenantMembership({
      orgId: "org_t1",
      memberId: "mem_admin",
      userId: "usr_tenant_admin",
      role: "admin",
    });
    await seedTenantMembership({
      orgId: "org_t1",
      memberId: "mem_editor",
      userId: "usr_tenant_editor",
      role: "editor",
    });

    const opAlphaSess = await seedSession({ id: "sess_op_alpha", userId: "usr_op_alpha" });
    const opBetaSess = await seedSession({ id: "sess_op_beta", userId: "usr_op_beta" });
    const ownerSess = await seedSession({ id: "sess_owner", userId: "usr_tenant_owner" });
    const adminSess = await seedSession({ id: "sess_admin", userId: "usr_tenant_admin" });
    const editorSess = await seedSession({ id: "sess_editor", userId: "usr_tenant_editor" });
    const expiredSess = await seedSession({
      id: "sess_op_expired",
      userId: "usr_op_alpha",
      expiresAtMs: BASE_NOW_MS - 1_000,
    });

    await bootstrapInitialPlatformOperator(env.PLATFORM_DB, {
      userId: "usr_op_alpha",
      reason: "Bootstrap primary operator for guard verification",
      requestId: "req_guard_boot",
      nowMs: BASE_NOW_MS,
    });

    // Active operator passes live guard
    const verified = await requireActivePlatformOperator(env.PLATFORM_DB, {
      session: opAlphaSess,
      user: { id: "usr_op_alpha", email: "alpha-op@punyasitus.com" },
      requestId: "req_guard_ok",
      nowMs: BASE_NOW_MS + 1_000,
    });
    expect(verified.role).toBe("platform_operator");
    expect(verified.userId).toBe("usr_op_alpha");

    // Tenant owner, admin, and editor MUST fail with 403 PLATFORM_OPERATOR_REQUIRED
    // even with @punyasitus.com email suffix or spoofed role field
    for (const [label, sess, uid, role] of [
      ["owner", ownerSess, "usr_tenant_owner", "owner"],
      ["admin", adminSess, "usr_tenant_admin", "admin"],
      ["editor", editorSess, "usr_tenant_editor", "editor"],
    ] as const) {
      await expect(
        requireActivePlatformOperator(env.PLATFORM_DB, {
          session: sess,
          user: { id: uid, email: `${label}@punyasitus.com`, role: "platform_operator" },
          requestId: `req_deny_${role}`,
          nowMs: BASE_NOW_MS + 2_000,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: "PLATFORM_OPERATOR_REQUIRED",
      });

      const deniedRows = await listPlatformAuditEntries(env.PLATFORM_DB, {
        requestId: `req_deny_${role}`,
        outcome: "denied",
      });
      expect(deniedRows).toHaveLength(1);
      expect(deniedRows[0]?.actorUserId).toBe(uid);
    }

    // Expired session fails with 401 SESSION_EXPIRED
    await expect(
      requireActivePlatformOperator(env.PLATFORM_DB, {
        session: expiredSess,
        user: { id: "usr_op_alpha" },
        requestId: "req_expired_sess",
        nowMs: BASE_NOW_MS + 2_000,
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: "SESSION_EXPIRED",
    });

    // Grant requires recent reauthentication (<= 10m)
    await expect(
      executeAuditedPlatformGrant(env.PLATFORM_DB, {
        session: opAlphaSess,
        user: { id: "usr_op_alpha" },
        targetUserId: "usr_op_beta",
        reason: "Grant beta operator without recent reauthentication",
        requestId: "req_grant_no_reauth",
        reauthenticatedAtMs: BASE_NOW_MS - 15 * 60 * 1000, // stale (>10m)
        nowMs: BASE_NOW_MS + 3_000,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "REAUTH_REQUIRED",
    });

    // Grant succeeds with fresh reauthentication
    const granted = await executeAuditedPlatformGrant(env.PLATFORM_DB, {
      session: opAlphaSess,
      user: { id: "usr_op_alpha" },
      targetUserId: "usr_op_beta",
      reason: "Granting secondary platform operator for operations coverage",
      requestId: "req_grant_beta",
      reauthenticatedAtMs: BASE_NOW_MS + 2_500,
      nowMs: BASE_NOW_MS + 3_000,
    });
    expect(granted.operator.userId).toBe("usr_op_beta");
    expect(granted.operator.isActive).toBe(true);
    expect(granted.audit.action).toBe("platform_operator.grant");

    // Revoke beta while beta still holds a valid active session in `sessions`
    await executeAuditedPlatformRevoke(env.PLATFORM_DB, {
      session: opAlphaSess,
      user: { id: "usr_op_alpha" },
      targetUserId: "usr_op_beta",
      reason: "Offboarding beta operator after rotation completed",
      requestId: "req_revoke_beta",
      reauthenticatedAtMs: BASE_NOW_MS + 3_500,
      nowMs: BASE_NOW_MS + 4_000,
    });

    // Beta still has a live row in `sessions`, yet MUST fail immediately with 403 OPERATOR_REVOKED
    expect(await getActivePlatformOperator(env.PLATFORM_DB, "usr_op_beta")).toBeNull();
    await expect(
      requireActivePlatformOperator(env.PLATFORM_DB, {
        session: opBetaSess,
        user: { id: "usr_op_beta" },
        requestId: "req_revoked_op_live_sess",
        nowMs: BASE_NOW_MS + 5_000,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "OPERATOR_REVOKED",
    });

    // Deleting alpha's session immediately causes alpha's calls to fail with 401 SESSION_REVOKED
    await env.PLATFORM_DB.prepare("DELETE FROM sessions WHERE id = ?")
      .bind(opAlphaSess.id)
      .run();

    await expect(
      requireActivePlatformOperator(env.PLATFORM_DB, {
        session: opAlphaSess,
        user: { id: "usr_op_alpha" },
        requestId: "req_revoked_sess",
        nowMs: BASE_NOW_MS + 6_000,
      }),
    ).rejects.toBeInstanceOf(PlatformGuardError);

    await expect(
      requireActivePlatformOperator(env.PLATFORM_DB, {
        session: opAlphaSess,
        user: { id: "usr_op_alpha" },
        requestId: "req_revoked_sess_2",
        nowMs: BASE_NOW_MS + 6_100,
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: "SESSION_REVOKED",
    });
  });

  it("preserves the final active operator atomically under concurrent revocation races", async () => {
    await seedUser({ id: "usr_race_1", email: "race1@example.com", name: "Race Op 1" });
    await seedUser({ id: "usr_race_2", email: "race2@example.com", name: "Race Op 2" });

    await bootstrapInitialPlatformOperator(env.PLATFORM_DB, {
      userId: "usr_race_1",
      reason: "Bootstrap operator 1 for concurrent revoke race test",
      requestId: "req_race_boot",
      nowMs: BASE_NOW_MS,
    });
    await grantPlatformOperator(env.PLATFORM_DB, {
      actorUserId: "usr_race_1",
      targetUserId: "usr_race_2",
      reason: "Grant operator 2 for concurrent revoke race test",
      requestId: "req_race_grant",
      nowMs: BASE_NOW_MS + 100,
    });

    expect(await countActivePlatformOperators(env.PLATFORM_DB)).toBe(2);

    // Concurrent race: op1 attempts to revoke op2 while op2 simultaneously attempts to revoke op1
    const settled = await Promise.allSettled([
      revokePlatformOperator(env.PLATFORM_DB, {
        actorUserId: "usr_race_1",
        targetUserId: "usr_race_2",
        reason: "Concurrent revoke attempt A removing operator 2",
        requestId: "req_race_revoke_a",
        nowMs: BASE_NOW_MS + 500,
      }),
      revokePlatformOperator(env.PLATFORM_DB, {
        actorUserId: "usr_race_2",
        targetUserId: "usr_race_1",
        reason: "Concurrent revoke attempt B removing operator 1",
        requestId: "req_race_revoke_b",
        nowMs: BASE_NOW_MS + 500,
      }),
    ]);

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The losing concurrent revocation fails with FINAL_OPERATOR_PROTECTED (or PLATFORM_OPERATOR_REQUIRED
    // if the winning transaction revoked the losing actor first — either way exactly 1 active operator remains!)
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(PlatformOperatorError);
    expect(["FINAL_OPERATOR_PROTECTED", "PLATFORM_OPERATOR_REQUIRED"]).toContain(
      (err as PlatformOperatorError).code,
    );

    // Invariant: strictly 1 active operator remains!
    expect(await countActivePlatformOperators(env.PLATFORM_DB)).toBe(1);
    const activeOps = await listPlatformOperators(env.PLATFORM_DB, { includeRevoked: false });
    expect(activeOps).toHaveLength(1);
    const survivorId = activeOps[0]!.userId;

    // Also test direct same-actor concurrent race against the final two operators (actor is survivor,
    // wait — first add a 3rd? Even simpler: re-grant the revoked one, then race op1 revoking op2 AND op1 revoking op1!)
    const revokedId = survivorId === "usr_race_1" ? "usr_race_2" : "usr_race_1";

    // Attempting to revoke the sole survivor directly MUST fail with 409 FINAL_OPERATOR_PROTECTED
    await expect(
      revokePlatformOperator(env.PLATFORM_DB, {
        actorUserId: survivorId,
        targetUserId: survivorId,
        reason: "Attempt to self-revoke the final remaining active operator",
        requestId: "req_race_final_block",
        nowMs: BASE_NOW_MS + 600,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "FINAL_OPERATOR_PROTECTED",
    });

    // Reactivate the second operator and run a same-actor concurrent race (`Promise.all([revoke(op2), revoke(op1)])`)
    // so both transactions have an active actor and the second hits COUNT(*) > 1 -> 409 FINAL_OPERATOR_PROTECTED
    await grantPlatformOperator(env.PLATFORM_DB, {
      actorUserId: survivorId,
      targetUserId: revokedId,
      reason: "Reactivate operator for second concurrent final-operator race",
      requestId: "req_race_regrant",
      nowMs: BASE_NOW_MS + 700,
    });
    expect(await countActivePlatformOperators(env.PLATFORM_DB)).toBe(2);

    const sameActorRace = await Promise.allSettled([
      revokePlatformOperator(env.PLATFORM_DB, {
        actorUserId: survivorId,
        targetUserId: revokedId,
        reason: "Concurrent revoke 1 targeting secondary operator",
        requestId: "req_race_same_1",
        nowMs: BASE_NOW_MS + 800,
      }),
      revokePlatformOperator(env.PLATFORM_DB, {
        actorUserId: survivorId,
        targetUserId: survivorId,
        reason: "Concurrent revoke 2 targeting primary operator",
        requestId: "req_race_same_2",
        nowMs: BASE_NOW_MS + 800,
      }),
    ]);

    const okSame = sameActorRace.filter((r) => r.status === "fulfilled");
    const errSame = sameActorRace.filter((r) => r.status === "rejected");
    expect(okSame).toHaveLength(1);
    expect(errSame).toHaveLength(1);
    expect((errSame[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      code: "FINAL_OPERATOR_PROTECTED",
    });
    expect(await countActivePlatformOperators(env.PLATFORM_DB)).toBe(1);

    // Verify no false `success` audit row was recorded for the blocked concurrent revoke
    const successAudits1 = await listPlatformAuditEntries(env.PLATFORM_DB, {
      requestId: "req_race_same_1",
      outcome: "success",
    });
    const successAudits2 = await listPlatformAuditEntries(env.PLATFORM_DB, {
      requestId: "req_race_same_2",
      outcome: "success",
    });
    expect(successAudits1.length + successAudits2.length).toBe(1);
  });

  it("rolls back operator grant and revoke state changes when audit persistence fails", async () => {
    await seedUser({ id: "usr_rb_1", email: "rb1@example.com", name: "Rollback Op 1" });
    await seedUser({ id: "usr_rb_2", email: "rb2@example.com", name: "Rollback Op 2" });
    await seedUser({ id: "usr_rb_3", email: "rb3@example.com", name: "Rollback Op 3" });

    await bootstrapInitialPlatformOperator(env.PLATFORM_DB, {
      userId: "usr_rb_1",
      reason: "Bootstrap op 1 before audit failure rollback test",
      requestId: "req_rb_boot",
      nowMs: BASE_NOW_MS,
    });
    await grantPlatformOperator(env.PLATFORM_DB, {
      actorUserId: "usr_rb_1",
      targetUserId: "usr_rb_2",
      reason: "Grant op 2 before testing audit failure rollback",
      requestId: "req_rb_grant_2",
      nowMs: BASE_NOW_MS + 100,
    });

    // Inject a deterministic SQLite failure on platform_audit INSERT to prove db.batch() atomicity
    await env.PLATFORM_DB.exec(
      "CREATE TRIGGER test_fail_platform_audit_insert BEFORE INSERT ON platform_audit BEGIN SELECT RAISE(ABORT, 'simulated audit persistence failure'); END;",
    );

    try {
      // 1. Grant of usr_rb_3 must fail AND roll back so usr_rb_3 is NOT in platform_operators
      await expect(
        grantPlatformOperator(env.PLATFORM_DB, {
          actorUserId: "usr_rb_1",
          targetUserId: "usr_rb_3",
          reason: "Grant op 3 that must roll back on audit failure",
          requestId: "req_rb_grant_fail",
          nowMs: BASE_NOW_MS + 200,
        }),
      ).rejects.toMatchObject({
        status: 500,
        code: "AUDIT_PERSISTENCE_FAILED",
      });

      expect(await getPlatformOperatorGrant(env.PLATFORM_DB, "usr_rb_3")).toBeNull();
      expect(await countActivePlatformOperators(env.PLATFORM_DB)).toBe(2);

      // 2. Revoke of usr_rb_2 must fail AND roll back so usr_rb_2 remains ACTIVE
      await expect(
        revokePlatformOperator(env.PLATFORM_DB, {
          actorUserId: "usr_rb_1",
          targetUserId: "usr_rb_2",
          reason: "Revoke op 2 that must roll back on audit failure",
          requestId: "req_rb_revoke_fail",
          nowMs: BASE_NOW_MS + 300,
        }),
      ).rejects.toMatchObject({
        status: 500,
        code: "AUDIT_PERSISTENCE_FAILED",
      });

      const op2After = await getActivePlatformOperator(env.PLATFORM_DB, "usr_rb_2");
      expect(op2After?.isActive).toBe(true);
      expect(op2After?.revokedAt).toBeNull();
      expect(await countActivePlatformOperators(env.PLATFORM_DB)).toBe(2);
    } finally {
      await env.PLATFORM_DB.exec("DROP TRIGGER IF EXISTS test_fail_platform_audit_insert;");
    }
  });

  it("enforces append-only immutability on platform_audit via SQLite triggers", async () => {
    await seedUser({ id: "usr_imm_1", email: "imm1@example.com", name: "Immutable Op" });

    const { audit } = await bootstrapInitialPlatformOperator(env.PLATFORM_DB, {
      userId: "usr_imm_1",
      reason: "Bootstrap to test append-only platform_audit triggers",
      requestId: "req_imm_boot",
      nowMs: BASE_NOW_MS,
    });

    await expect(
      env.PLATFORM_DB.prepare("UPDATE platform_audit SET reason = ? WHERE id = ?")
        .bind("tampered reason value", audit.id)
        .run(),
    ).rejects.toThrow(/platform_audit is append-only/);

    await expect(
      env.PLATFORM_DB.prepare("DELETE FROM platform_audit WHERE id = ?")
        .bind(audit.id)
        .run(),
    ).rejects.toThrow(/platform_audit is append-only/);

    const intact = await listPlatformAuditEntries(env.PLATFORM_DB, {
      requestId: "req_imm_boot",
    });
    expect(intact).toHaveLength(1);
    expect(intact[0]?.reason).toBe("Bootstrap to test append-only platform_audit triggers");
  });
});

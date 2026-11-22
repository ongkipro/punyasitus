import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
  mergeCookieHeaders,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import {
  countActivePlatformOperators,
  ensurePlatformOperatorRolesSchema,
  getPlatformSettings,
  HEALTH_SETTINGS_KEYS,
  listPlatformAuditEntries,
  PLATFORM_MIGRATIONS,
  type HealthBackupBucketLike,
} from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleConsoleAuditItemRequest } from "../../apps/web/src/pages/api/console/audit/[auditId].ts";
import { handleConsoleAuditRequest } from "../../apps/web/src/pages/api/console/audit/index.ts";
import { handleConsoleHealthRequest } from "../../apps/web/src/pages/api/console/health/index.ts";
import { handleConsoleOperatorRevokeRequest } from "../../apps/web/src/pages/api/console/operators/[userId]/revoke.ts";
import { handleConsoleOperatorBootstrapGuard } from "../../apps/web/src/pages/api/console/operators/bootstrap.ts";
import { handleConsoleOperatorsRequest } from "../../apps/web/src/pages/api/console/operators/index.ts";
import { handleConsoleSettingsRequest } from "../../apps/web/src/pages/api/console/settings/index.ts";

const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_ORIGIN = "https://app.punyasitus.com";
const TENANT_ORIGIN = "https://toko-kopi.situsku.click";
const APP_SECRET = "task048-app-auth-secret-0123456789abcdef0123456789abcdef";
const CONSOLE_SECRET = "task048-console-auth-secret-fedcba9876543210fedcba987654";

function buildConsoleEnv(extra?: Partial<ConsoleRuntimeEnv>): ConsoleRuntimeEnv {
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
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM two_factors"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_settings"),
    env.PLATFORM_DB.prepare("DELETE FROM job_ledger"),
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

function makeFakeBackupBucket(lastBackupMs: number | null, throwOnRead = false): HealthBackupBucketLike {
  return {
    async get(key: string) {
      if (throwOnRead) throw new Error("Simulated R2 outage");
      if (key !== "platform-db/latest.json" || lastBackupMs === null) return null;
      return {
        key,
        uploaded: new Date(lastBackupMs),
        async text() {
          return JSON.stringify({
            createdAtMs: lastBackupMs,
            createdAt: new Date(lastBackupMs).toISOString(),
          });
        },
      };
    },
    async list() {
      if (throwOnRead) throw new Error("Simulated R2 list outage");
      return { objects: [], truncated: false };
    },
  };
}

describe("TASK-048 workerd integration — Platform Settings, Operators Lifecycle, Immutable Audit & Health", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetTables();
  });

  it("enforces console host isolation, non-operator denial, CSRF, expired sessions, and private no-store headers", async () => {
    const runtimeEnv = buildConsoleEnv();
    const auth = createConsoleAuth();
    const nowMs = Date.now();

    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "boundary-op@example.com",
      password: "OperatorPassword!234",
      name: "Boundary Operator",
      nowMs,
    });

    const nonOp = await createVerifiedConsoleUser(
      "tenant-owner@punyasitus.com",
      "TenantPassword!234",
      "Tenant Owner",
    );

    // 1. Wrong hosts -> 404 NOT_FOUND across all console endpoints
    for (const wrongOrigin of [APP_ORIGIN, TENANT_ORIGIN, "https://punyasitus.com"]) {
      const settingsRes = await handleConsoleSettingsRequest(
        new Request(`${wrongOrigin}/api/console/settings`, {
          headers: { cookie: op.cookieHeader },
        }),
        runtimeEnv,
      );
      expect(settingsRes.status).toBe(404);
      expect(settingsRes.headers.get("Cache-Control")).toBe("private, no-store");
      expect(settingsRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

      const opsRes = await handleConsoleOperatorsRequest(
        new Request(`${wrongOrigin}/api/console/operators`, {
          headers: { cookie: op.cookieHeader },
        }),
        runtimeEnv,
      );
      expect(opsRes.status).toBe(404);

      const auditRes = await handleConsoleAuditRequest(
        new Request(`${wrongOrigin}/api/console/audit`, {
          headers: { cookie: op.cookieHeader },
        }),
        runtimeEnv,
      );
      expect(auditRes.status).toBe(404);

      const healthRes = await handleConsoleHealthRequest(
        new Request(`${wrongOrigin}/api/console/health`, {
          headers: { cookie: op.cookieHeader },
        }),
        runtimeEnv,
      );
      expect(healthRes.status).toBe(404);
    }

    // 2. Anonymous caller -> 401 UNAUTHENTICATED (including bootstrap endpoint!)
    const anonSettings = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`),
      runtimeEnv,
    );
    expect(anonSettings.status).toBe(401);

    const anonBootstrap = await handleConsoleOperatorBootstrapGuard(
      new Request(`${CONSOLE_ORIGIN}/api/console/operators/bootstrap`, {
        method: "POST",
        headers: { Origin: CONSOLE_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "attacker@example.com" }),
      }),
      runtimeEnv,
    );
    expect(anonBootstrap.status).toBe(401);

    // Authenticated operator trying HTTP bootstrap -> 403 BOOTSTRAP_CLI_ONLY
    const authedBootstrap = await handleConsoleOperatorBootstrapGuard(
      new Request(`${CONSOLE_ORIGIN}/api/console/operators/bootstrap`, {
        method: "POST",
        headers: {
          Origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({ email: "boundary-op@example.com" }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 1000 },
    );
    expect(authedBootstrap.status).toBe(403);
    expect(((await authedBootstrap.json()) as { code: string }).code).toBe("BOOTSTRAP_CLI_ONLY");

    // 3. Non-operator tenant owner (even with @punyasitus.com email) -> 403 PLATFORM_OPERATOR_REQUIRED
    for (const handler of [
      () =>
        handleConsoleSettingsRequest(
          new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
            headers: { cookie: nonOp.cookieHeader },
          }),
          runtimeEnv,
        ),
      () =>
        handleConsoleOperatorsRequest(
          new Request(`${CONSOLE_ORIGIN}/api/console/operators`, {
            headers: { cookie: nonOp.cookieHeader },
          }),
          runtimeEnv,
        ),
      () =>
        handleConsoleAuditRequest(
          new Request(`${CONSOLE_ORIGIN}/api/console/audit`, {
            headers: { cookie: nonOp.cookieHeader },
          }),
          runtimeEnv,
        ),
      () =>
        handleConsoleHealthRequest(
          new Request(`${CONSOLE_ORIGIN}/api/console/health`, {
            headers: { cookie: nonOp.cookieHeader },
          }),
          runtimeEnv,
        ),
    ]) {
      const res = await handler();
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("PLATFORM_OPERATOR_REQUIRED");
    }

    // 4. CSRF / missing Origin on mutations -> 403
    const csrfBlocked = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example.com",
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({}),
      }),
      runtimeEnv,
      { nowMs: nowMs + 2000 },
    );
    expect(csrfBlocked.status).toBe(403);

    // 5. Expired superadmin idle session (>30 min idle ceiling) -> 401 SESSION_EXPIRED
    const expiredIdleRes = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        headers: { cookie: op.cookieHeader },
      }),
      runtimeEnv,
      { nowMs: nowMs + 31 * 60 * 1000 },
    );
    expect(expiredIdleRes.status).toBe(401);
    expect(((await expiredIdleRes.json()) as { code: string }).code).toBe("SESSION_EXPIRED");
  });

  it("validates & persists platform_settings with reauth, optimistic versioning, audit logging, and rolls back on audit failure", async () => {
    const runtimeEnv = buildConsoleEnv();
    const auth = createConsoleAuth();
    const nowMs = Date.now();

    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "settings-op@example.com",
      password: "OperatorPassword!234",
      name: "Settings Operator",
      nowMs,
    });

    // 1. Initial GET returns unconfigured version 0
    const initialGet = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        headers: { cookie: op.cookieHeader },
      }),
      runtimeEnv,
      { nowMs: nowMs + 1_000 },
    );
    expect(initialGet.status).toBe(200);
    expect(initialGet.headers.get("Cache-Control")).toBe("private, no-store");
    const initialJson = (await initialGet.json()) as {
      settings: { version: number; configured: boolean };
    };
    expect(initialJson.settings.version).toBe(0);
    expect(initialJson.settings.configured).toBe(false);

    // 2. Rejects unsafe URLs (javascript:, http:, private host) & unknown/forbidden fields
    const badUrlRes = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({
          salesWhatsapp: "081234567890",
          supportEmail: "support@punyasitus.com",
          termsUrl: "javascript:alert(1)",
          privacyUrl: "http://127.0.0.1/privacy",
          expectedVersion: 0,
          reason: "Attempt setting dangerous URLs must be rejected",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 2_000 },
    );
    expect(badUrlRes.status).toBe(422);

    const unknownFieldRes = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({
          salesWhatsapp: "081234567890",
          supportEmail: "support@punyasitus.com",
          termsUrl: "https://punyasitus.com/terms",
          privacyUrl: "https://punyasitus.com/privacy",
          expectedVersion: 0,
          reason: "Attempt setting unknown field must fail closed",
          hackFlag: true,
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 2_500 },
    );
    expect(unknownFieldRes.status).toBe(422);
    expect(((await unknownFieldRes.json()) as { code: string }).code).toBe("UNKNOWN_FIELD");

    // 3. Stale 2FA (>10 minutes) fails with 403 REAUTH_REQUIRED
    const staleReauthRes = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({
          salesWhatsapp: "081234567890",
          supportEmail: "support@punyasitus.com",
          termsUrl: "https://punyasitus.com/terms",
          privacyUrl: "https://punyasitus.com/privacy",
          expectedVersion: 0,
          reason: "Attempt saving settings with expired 10m step-up window",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + DEFAULT_SECOND_FACTOR_WINDOW_MS + 5_000 },
    );
    expect(staleReauthRes.status).toBe(403);
    expect(((await staleReauthRes.json()) as { code: string }).code).toBe("REAUTH_REQUIRED");

    // 4. Valid operator update persists normalized E.164 WA + HTTPS URLs + audit entry
    const saveRes = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({
          salesWhatsapp: "+62 812-3456-7890",
          supportEmail: "Support@PunyaSitus.com",
          termsUrl: "https://punyasitus.com/syarat-ketentuan",
          privacyUrl: "https://punyasitus.com/kebijakan-privasi",
          monthlyPriceIdr: 189_000,
          yearlyPriceIdr: 1_890_000,
          expectedVersion: 0,
          reason: "Initial official platform contact and pricing configuration",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 3_000, requestId: "req_t048_settings_save_1" },
    );
    expect(saveRes.status).toBe(200);
    const saveJson = (await saveRes.json()) as {
      settings: {
        salesWhatsapp: string;
        supportEmail: string;
        termsUrl: string;
        privacyUrl: string;
        monthlyPriceIdr: number;
        version: number;
      };
      auditId: string;
    };
    expect(saveJson.settings.salesWhatsapp).toBe("6281234567890");
    expect(saveJson.settings.supportEmail).toBe("support@punyasitus.com");
    expect(saveJson.settings.termsUrl).toBe("https://punyasitus.com/syarat-ketentuan");
    expect(saveJson.settings.privacyUrl).toBe("https://punyasitus.com/kebijakan-privasi");
    expect(saveJson.settings.monthlyPriceIdr).toBe(189_000);
    expect(saveJson.settings.version).toBe(1);

    const auditRows = await listPlatformAuditEntries(env.PLATFORM_DB, {
      requestId: "req_t048_settings_save_1",
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("platform_settings.update");
    expect(auditRows[0]?.id).toBe(saveJson.auditId);

    // 5. Stale expectedVersion -> 409 VERSION_CONFLICT
    const conflictRes = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({
          salesWhatsapp: "081299998888",
          supportEmail: "support@punyasitus.com",
          termsUrl: "https://punyasitus.com/syarat-ketentuan",
          privacyUrl: "https://punyasitus.com/kebijakan-privasi",
          expectedVersion: 0,
          reason: "Stale version write must return 409 conflict",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 4_000 },
    );
    expect(conflictRes.status).toBe(409);
    expect(((await conflictRes.json()) as { code: string }).code).toBe("VERSION_CONFLICT");

    // 6. Audit failure MUST roll back platform_settings mutation (SQLite trigger injection)
    await env.PLATFORM_DB.exec(
      "CREATE TRIGGER test_t048_fail_audit_insert BEFORE INSERT ON platform_audit BEGIN SELECT RAISE(ABORT, 'simulated audit insert failure'); END;",
    );
    try {
      const rollbackRes = await handleConsoleSettingsRequest(
        new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            cookie: op.cookieHeader,
          },
          body: JSON.stringify({
            salesWhatsapp: "081299990000",
            supportEmail: "changed@punyasitus.com",
            termsUrl: "https://punyasitus.com/terms-v2",
            privacyUrl: "https://punyasitus.com/privacy-v2",
            expectedVersion: 1,
            reason: "Must roll back completely when platform_audit fails",
          }),
        }),
        runtimeEnv,
        { nowMs: nowMs + 5_000 },
      );
      expect(rollbackRes.status).toBe(500);
      expect(((await rollbackRes.json()) as { code: string }).code).toBe("AUDIT_PERSISTENCE_FAILED");

      // Confirm DB still holds version 1 values unchanged
      const afterRollback = await getPlatformSettings(env.PLATFORM_DB);
      expect(afterRollback.version).toBe(1);
      expect(afterRollback.salesWhatsapp).toBe("6281234567890");
      expect(afterRollback.supportEmail).toBe("support@punyasitus.com");
    } finally {
      await env.PLATFORM_DB.exec("DROP TRIGGER IF EXISTS test_t048_fail_audit_insert;");
    }
  });

  it("enforces reauth on operator grant/revoke, concurrent Promise.all final-operator protection, and immediate revocation effect", async () => {
    const runtimeEnv = buildConsoleEnv();
    const auth = createConsoleAuth();
    const nowMs = Date.now();

    const op1 = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "super1@example.com",
      password: "OperatorPassword!234",
      name: "Superadmin One",
      nowMs,
    });
    const op2 = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "super2@example.com",
      password: "OperatorPassword!234",
      name: "Superadmin Two",
      nowMs,
    });
    const candidate = await createVerifiedConsoleUser(
      "support-candidate@example.com",
      "CandidatePass!234",
      "Support Candidate",
    );

    // 1. Grant fails with 403 REAUTH_REQUIRED when 2FA step-up is stale (>10m)
    const staleGrant = await handleConsoleOperatorsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/operators`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op1.cookieHeader,
        },
        body: JSON.stringify({
          targetEmail: candidate.email,
          role: "platform_support",
          reason: "Attempt grant with stale 2FA timestamp must fail",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + DEFAULT_SECOND_FACTOR_WINDOW_MS + 10_000 },
    );
    expect(staleGrant.status).toBe(403);
    expect(((await staleGrant.json()) as { code: string }).code).toBe("REAUTH_REQUIRED");

    // 2. Grant succeeds with fresh 2FA -> 201 + audit
    const grantRes = await handleConsoleOperatorsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/operators`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op1.cookieHeader,
        },
        body: JSON.stringify({
          targetEmail: candidate.email,
          role: "platform_support",
          reason: "Granting platform_support role for verified operations staff",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 2_000 },
    );
    expect(grantRes.status).toBe(201);
    const grantJson = (await grantRes.json()) as {
      operator: { userId: string; role: string; isActive: boolean };
    };
    expect(grantJson.operator.userId).toBe(candidate.userId);
    expect(grantJson.operator.role).toBe("platform_support");
    expect(grantJson.operator.isActive).toBe(true);

    // Revoke the support operator first so exactly 2 active superadmins remain (op1 & op2)
    const revokeSupportRes = await handleConsoleOperatorRevokeRequest(
      candidate.userId,
      new Request(`${CONSOLE_ORIGIN}/api/console/operators/${candidate.userId}/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op1.cookieHeader,
        },
        body: JSON.stringify({
          reason: "Removing temporary support role before superadmin race test",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 3_000 },
    );
    expect(revokeSupportRes.status).toBe(200);
    expect(await countActivePlatformOperators(env.PLATFORM_DB)).toBe(2);

    // 3. Concurrent Promise.all revocations of the final two superadmins -> exactly 1 succeeds, 1 fails with 409 LAST_OPERATOR_PROTECTED!
    const [raceResA, raceResB] = await Promise.all([
      handleConsoleOperatorRevokeRequest(
        op2.user.id,
        new Request(`${CONSOLE_ORIGIN}/api/console/operators/${op2.user.id}/revoke`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            cookie: op1.cookieHeader,
          },
          body: JSON.stringify({
            reason: "Concurrent revocation A removing second superadmin",
          }),
        }),
        runtimeEnv,
        { nowMs: nowMs + 4_000 },
      ),
      handleConsoleOperatorRevokeRequest(
        op1.user.id,
        new Request(`${CONSOLE_ORIGIN}/api/console/operators/${op1.user.id}/revoke`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            cookie: op1.cookieHeader,
          },
          body: JSON.stringify({
            reason: "Concurrent revocation B removing first superadmin",
          }),
        }),
        runtimeEnv,
        { nowMs: nowMs + 4_000 },
      ),
    ]);

    const statuses = [raceResA.status, raceResB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const blockedRes = raceResA.status === 409 ? raceResA : raceResB;
    const blockedBody = (await blockedRes.json()) as { code: string };
    expect(blockedBody.code).toBe("LAST_OPERATOR_PROTECTED");
    expect(await countActivePlatformOperators(env.PLATFORM_DB)).toBe(1);

    // 4. Revoked operator's NEXT request fails IMMEDIATELY with 403 OPERATOR_REVOKED (even though session is still live!)
    const revokedOp = raceResA.status === 200 ? op2 : op1;
    const immediateNextReq = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        headers: { cookie: revokedOp.cookieHeader },
      }),
      runtimeEnv,
      { nowMs: nowMs + 5_000 },
    );
    expect(immediateNextReq.status).toBe(403);
    expect(((await immediateNextReq.json()) as { code: string }).code).toBe("OPERATOR_REVOKED");
  });

  it("enforces immutable read-only /api/console/audit (405 on mutations) and redacts sensitive secrets", async () => {
    const runtimeEnv = buildConsoleEnv();
    const auth = createConsoleAuth();
    const nowMs = Date.now();

    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "audit-op@example.com",
      password: "OperatorPassword!234",
      name: "Audit Operator",
      nowMs,
    });

    // Directly insert a synthetic legacy/dirty row containing secrets to prove read-side redaction
    await env.PLATFORM_DB.prepare(
      `INSERT INTO platform_audit (
        id, actor_user_id, actor_role, action, target_type, target_id,
        tenant_id, reason, outcome, request_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "01JFX048AUDITDIRTY00000001",
        op.user.id,
        "platform_operator",
        "legacy.secret_test",
        "platform_settings",
        "platform.public_settings",
        null,
        "Leaked token Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.secretSig123456 password=MySecretPassword!1",
        "success",
        "req_dirty_test",
        JSON.stringify({
          apiKey: "sk_live_never_show_this_999",
          leadBody: "Pesan pribadi pelanggan 081234567890",
          safeNote: "visible-metadata",
        }),
        nowMs + 1_000,
      )
      .run();

    // 1. GET with action filter returns redacted entry
    const getRes = await handleConsoleAuditRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/audit?action=legacy.secret_test&limit=10`, {
        headers: { cookie: op.cookieHeader },
      }),
      runtimeEnv,
      { nowMs: nowMs + 2_000 },
    );
    expect(getRes.status).toBe(200);
    const bodyText = await getRes.text();
    expect(bodyText).not.toContain("secretSig123456");
    expect(bodyText).not.toContain("MySecretPassword!1");
    expect(bodyText).not.toContain("sk_live_never_show_this_999");
    expect(bodyText).not.toContain("081234567890");
    expect(bodyText).not.toContain("Pesan pribadi pelanggan");
    expect(bodyText).toContain("visible-metadata");
    expect(bodyText).toContain("[REDACTED]");

    // 2. POST / PUT / PATCH / DELETE on /api/console/audit and /api/console/audit/:id -> 405 METHOD_NOT_ALLOWED
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const colRes = await handleConsoleAuditRequest(
        new Request(`${CONSOLE_ORIGIN}/api/console/audit`, {
          method,
          headers: {
            Origin: CONSOLE_ORIGIN,
            "Content-Type": "application/json",
            cookie: op.cookieHeader,
          },
          body: JSON.stringify({ action: "tamper" }),
        }),
        runtimeEnv,
        { nowMs: nowMs + 3_000 },
      );
      expect(colRes.status).toBe(405);
      expect(colRes.headers.get("Allow")).toBe("GET");
      expect(((await colRes.json()) as { code: string }).code).toBe("METHOD_NOT_ALLOWED");

      const itemRes = await handleConsoleAuditItemRequest(
        new Request(`${CONSOLE_ORIGIN}/api/console/audit/01JFX048AUDITDIRTY00000001`, {
          method,
          headers: {
            Origin: CONSOLE_ORIGIN,
            "Content-Type": "application/json",
            cookie: op.cookieHeader,
          },
          body: JSON.stringify({ reason: "overwrite" }),
        }),
        runtimeEnv,
        { nowMs: nowMs + 3_000 },
      );
      expect(itemRes.status).toBe(405);
      expect(((await itemRes.json()) as { code: string }).code).toBe("METHOD_NOT_ALLOWED");
    }
  });

  it("distinguishes unknown, healthy, stale, and degraded states on /api/console/health", async () => {
    const runtimeEnv = buildConsoleEnv();
    const auth = createConsoleAuth();
    const nowMs = Date.now();

    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "health-op@example.com",
      password: "OperatorPassword!234",
      name: "Health Operator",
      nowMs,
    });

    // 1. Fresh DB with no job runs, no backup bucket, no restore drill -> NEVER fabricates "healthy", returns "unknown"!
    const unknownRes = await handleConsoleHealthRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/health`, {
        headers: { cookie: op.cookieHeader },
      }),
      runtimeEnv,
      { nowMs: nowMs + 1_000, backupBucket: null },
    );
    expect(unknownRes.status).toBe(200);
    const unknownJson = (await unknownRes.json()) as {
      status: string;
      components: readonly { id: string; status: string }[];
    };
    expect(unknownJson.status).toBe("unknown");
    expect(unknownJson.components.find((c) => c.id === "database")?.status).toBe("healthy");
    expect(unknownJson.components.find((c) => c.id === "jobs")?.status).toBe("unknown");
    expect(unknownJson.components.find((c) => c.id === "backup")?.status).toBe("unknown");
    expect(unknownJson.components.find((c) => c.id === "restore_drill")?.status).toBe("unknown");

    // 2. Seed fresh completed job + fresh backup + fresh restore drill -> "healthy"!
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO job_ledger (idempotency_key, topic, status, attempts, created_at, updated_at)
         VALUES (?, ?, 'completed', 1, ?, ?)`,
      ).bind("job_fresh_1", "cron.billing_advice_sweep", nowMs - 120_000, nowMs - 60_000),
      env.PLATFORM_DB.prepare(
        `INSERT INTO platform_settings (key, value_json, version, updated_at)
         VALUES (?, ?, 1, ?)`,
      ).bind(
        HEALTH_SETTINGS_KEYS.lastRestoreDrill,
        JSON.stringify({ ok: true, completedAtMs: nowMs - 86_400_000 }),
        nowMs,
      ),
    ]);

    const healthyRes = await handleConsoleHealthRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/health`, {
        headers: { cookie: op.cookieHeader },
      }),
      runtimeEnv,
      {
        nowMs: nowMs + 2_000,
        backupBucket: makeFakeBackupBucket(nowMs - 3600_000), // 1h old (< 26h threshold)
      },
    );
    expect(healthyRes.status).toBe(200);
    const healthyJson = (await healthyRes.json()) as {
      status: string;
      components: readonly { id: string; status: string }[];
    };
    expect(healthyJson.status).toBe("healthy");
    expect(healthyJson.components.find((c) => c.id === "jobs")?.status).toBe("healthy");
    expect(healthyJson.components.find((c) => c.id === "backup")?.status).toBe("healthy");
    expect(healthyJson.components.find((c) => c.id === "restore_drill")?.status).toBe("healthy");

    // 3. Stale backup (30h old > 26h threshold) -> "stale"!
    const staleRes = await handleConsoleHealthRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/health`, {
        headers: { cookie: op.cookieHeader },
      }),
      runtimeEnv,
      {
        nowMs: nowMs + 3_000,
        backupBucket: makeFakeBackupBucket(nowMs - 30 * 3600_000),
      },
    );
    expect(staleRes.status).toBe(200);
    const staleJson = (await staleRes.json()) as {
      status: string;
      components: readonly { id: string; status: string }[];
    };
    expect(staleJson.status).toBe("stale");
    expect(staleJson.components.find((c) => c.id === "backup")?.status).toBe("stale");

    // 4. Dead-letter job -> "degraded"!
    await env.PLATFORM_DB.prepare(
      `INSERT INTO job_ledger (idempotency_key, topic, status, attempts, last_error_code, created_at, updated_at)
       VALUES (?, ?, 'dead_letter', 5, 'PROVIDER_TIMEOUT', ?, ?)`,
    )
      .bind("job_dlq_1", "billing.autolaris_advice", nowMs - 30_000, nowMs - 10_000)
      .run();

    const degradedRes = await handleConsoleHealthRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/health`, {
        headers: { cookie: op.cookieHeader },
      }),
      runtimeEnv,
      {
        nowMs: nowMs + 4_000,
        backupBucket: makeFakeBackupBucket(nowMs - 3600_000),
      },
    );
    expect(degradedRes.status).toBe(200);
    const degradedJson = (await degradedRes.json()) as {
      status: string;
      metrics: { deadLetterJobsCount: number };
      components: readonly { id: string; status: string }[];
    };
    expect(degradedJson.status).toBe("degraded");
    expect(degradedJson.metrics.deadLetterJobsCount).toBe(1);
    expect(degradedJson.components.find((c) => c.id === "jobs")?.status).toBe("degraded");

    // 5. Mutating /api/console/health -> 405 METHOD_NOT_ALLOWED
    const postHealth = await handleConsoleHealthRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/health`, {
        method: "POST",
        headers: { Origin: CONSOLE_ORIGIN, cookie: op.cookieHeader },
      }),
      runtimeEnv,
      { nowMs: nowMs + 5_000 },
    );
    expect(postHealth.status).toBe(405);
  });
});

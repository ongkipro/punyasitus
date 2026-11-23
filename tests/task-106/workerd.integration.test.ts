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
  ensurePlatformIncidentsSchema,
  listActiveBannerIncidents,
} from "@punyasitus/db/incidents/index";
import {
  ensurePlatformOperatorRolesSchema,
  listPlatformAuditEntries,
  PLATFORM_MIGRATIONS,
} from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadActiveDashboardIncidentBanner } from "../../apps/web/src/components/admin/incident/loader.ts";
import { handleConsoleIncidentItemRequest } from "../../apps/web/src/pages/api/console/incidents/[incidentId].ts";
import { handleConsoleIncidentResolveRequest } from "../../apps/web/src/pages/api/console/incidents/[incidentId]/resolve.ts";
import { handleConsoleIncidentsRequest } from "../../apps/web/src/pages/api/console/incidents/index.ts";

const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_ORIGIN = "https://app.punyasitus.com";
const TENANT_ORIGIN = "https://toko-kopi.situsku.click";
const APP_SECRET = "task106-app-auth-secret-0123456789abcdef0123456789abcdef";
const CONSOLE_SECRET = "task106-console-auth-secret-fedcba9876543210fedcba987654";

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
  // Drop append-only delete trigger temporarily only during test cleanup?
  // NEVER alter platform_audit; delete incidents via table drop/recreate for clean slate
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DROP TRIGGER IF EXISTS platform_incident_updates_no_delete"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_incident_updates"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_incidents"),
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM two_factors"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM organizations"),
    env.PLATFORM_DB.prepare("DELETE FROM accounts"),
    env.PLATFORM_DB.prepare("DELETE FROM sessions"),
    env.PLATFORM_DB.prepare("DELETE FROM verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM users"),
  ]);
  await ensurePlatformIncidentsSchema(env.PLATFORM_DB);
}

async function createVerifiedUser(email: string, password: string, name: string) {
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

describe("TASK-106 workerd integration — Platform Incidents, Atomic Audit, Concurrency & AuthZ", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await ensurePlatformIncidentsSchema(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetTables();
  });

  it("executes full declare -> banner active -> update -> stale 409 zero-side-effects -> resolve -> banner disappears lifecycle with atomic platform_audit", async () => {
    const runtimeEnv = buildConsoleEnv();
    const auth = createConsoleAuth();
    const nowMs = Date.now();

    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "incident-op@example.com",
      password: "OperatorPassword!234",
      name: "Incident Operator",
      nowMs,
    });

    // Initially no active banner
    expect(await loadActiveDashboardIncidentBanner(env.PLATFORM_DB)).toHaveLength(0);

    // 1. Declare incident in one audited action
    const declareRes = await handleConsoleIncidentsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/incidents`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "Keterlambatan verifikasi pembayaran QRIS",
          severity: "major",
          affectedComponents: ["billing_payments", "dashboard_cms"],
          summary:
            "Sebagian pembayaran QRIS mengalami keterlambatan konfirmasi otomatis hingga 10 menit. Tim sedang memeriksa jalur rekonsiliasi.",
        }),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(declareRes.status).toBe(201);
    expect(declareRes.headers.get("Cache-Control")).toBe("private, no-store");
    expect(declareRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const declaredBody = (await declareRes.json()) as {
      success: boolean;
      incident: {
        id: string;
        version: number;
        status: string;
        bannerVisible: boolean;
        updates: Array<{ id: string }>;
      };
      auditId: string;
    };
    expect(declaredBody.success).toBe(true);
    expect(declaredBody.incident.version).toBe(1);
    expect(declaredBody.incident.status).toBe("investigating");
    expect(declaredBody.incident.bannerVisible).toBe(true);
    expect(declaredBody.incident.updates).toHaveLength(1);
    expect(declaredBody.auditId).toBeTruthy();

    const incidentId = declaredBody.incident.id;

    // Dashboard banner immediately active & sanitized (no operator ID leaked)
    const activeBanners = await loadActiveDashboardIncidentBanner(env.PLATFORM_DB);
    expect(activeBanners).toHaveLength(1);
    expect(activeBanners[0]?.id).toBe(incidentId);
    expect(activeBanners[0]?.severity).toBe("major");
    expect(activeBanners[0]?.statusPageUrl).toBe("https://status.punyasitus.com");
    expect("declaredByUserId" in (activeBanners[0] ?? {})).toBe(false);

    // Atomic audit row exists
    const declareAudits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "platform_incident.declare",
      targetId: incidentId,
    });
    expect(declareAudits).toHaveLength(1);
    expect(declareAudits[0]?.id).toBe(declaredBody.auditId);

    // 2. Update status with matching version -> v2
    const updateRes = await handleConsoleIncidentItemRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/incidents/${incidentId}`, {
        method: "PATCH",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: 1,
          status: "monitoring",
          updateMessage: "Koneksi gateway pembayaran telah pulih dan antrean sedang dipantau.",
        }),
      }),
      incidentId,
      runtimeEnv,
      { nowMs: nowMs + 60_000 },
    );
    expect(updateRes.status).toBe(200);
    const updatedBody = (await updateRes.json()) as {
      incident: { version: number; status: string; updates: Array<{ id: string }> };
    };
    expect(updatedBody.incident.version).toBe(2);
    expect(updatedBody.incident.status).toBe("monitoring");
    expect(updatedBody.incident.updates).toHaveLength(2);

    // 3. Stale concurrent write (expectedVersion: 1) -> 409 with ZERO side effects!
    const auditsBeforeStale = await listPlatformAuditEntries(env.PLATFORM_DB, {
      targetId: incidentId,
    });
    const staleRes = await handleConsoleIncidentItemRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/incidents/${incidentId}`, {
        method: "PATCH",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: 1,
          status: "identified",
          updateMessage: "Pembaruan usang yang tidak boleh menimbulkan efek samping.",
        }),
      }),
      incidentId,
      runtimeEnv,
      { nowMs: nowMs + 90_000 },
    );
    expect(staleRes.status).toBe(409);
    const staleBody = (await staleRes.json()) as { code: string };
    expect(staleBody.code).toBe("VERSION_CONFLICT");

    const auditsAfterStale = await listPlatformAuditEntries(env.PLATFORM_DB, {
      targetId: incidentId,
    });
    expect(auditsAfterStale).toHaveLength(auditsBeforeStale.length);

    const updatesCountRow = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM platform_incident_updates WHERE incident_id = ?",
    )
      .bind(incidentId)
      .first<{ cnt: number }>();
    expect(updatesCountRow?.cnt).toBe(2);

    // 4. Append-only trigger on platform_incident_updates blocks mutation
    await expect(
      env.PLATFORM_DB.prepare(
        "UPDATE platform_incident_updates SET message = 'tampered' WHERE incident_id = ?",
      )
        .bind(incidentId)
        .run(),
    ).rejects.toThrow(/append-only/i);

    // 5. Resolve incident in one audited action -> banner disappears immediately
    const resolveRes = await handleConsoleIncidentResolveRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/incidents/${incidentId}/resolve`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: 2,
          resolutionNote: "Seluruh pembayaran QRIS tertunda telah terekonsiliasi normal.",
        }),
      }),
      incidentId,
      runtimeEnv,
      { nowMs: nowMs + 120_000 },
    );
    expect(resolveRes.status).toBe(200);
    const resolvedBody = (await resolveRes.json()) as {
      success: boolean;
      incident: { status: string; bannerVisible: boolean; version: number; resolvedAt: number };
      auditId: string;
    };
    expect(resolvedBody.success).toBe(true);
    expect(resolvedBody.incident.status).toBe("resolved");
    expect(resolvedBody.incident.bannerVisible).toBe(false);
    expect(resolvedBody.incident.version).toBe(3);
    expect(resolvedBody.incident.resolvedAt).toBe(nowMs + 120_000);

    // Banner disappears completely
    expect(await listActiveBannerIncidents(env.PLATFORM_DB)).toHaveLength(0);
    expect(await loadActiveDashboardIncidentBanner(env.PLATFORM_DB)).toHaveLength(0);

    // Resolve audit row persisted
    const resolveAudits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "platform_incident.resolve",
      targetId: incidentId,
    });
    expect(resolveAudits).toHaveLength(1);
    expect(resolveAudits[0]?.id).toBe(resolvedBody.auditId);

    // 6. Re-resolving an already resolved incident returns 409 INCIDENT_ALREADY_RESOLVED
    const duplicateResolveRes = await handleConsoleIncidentResolveRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/incidents/${incidentId}/resolve`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: 3 }),
      }),
      incidentId,
      runtimeEnv,
      { nowMs: nowMs + 150_000 },
    );
    expect(duplicateResolveRes.status).toBe(409);
    const dupBody = (await duplicateResolveRes.json()) as { code: string };
    expect(dupBody.code).toBe("INCIDENT_ALREADY_RESOLVED");
  });

  it("denies non-console hosts, unauthenticated requests, tenant users, missing CSRF, and non-2FA/stale step-up sessions", async () => {
    const runtimeEnv = buildConsoleEnv();
    const auth = createConsoleAuth();
    const nowMs = Date.now();

    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "sec-op@example.com",
      password: "OperatorPassword!234",
      name: "Security Operator",
      nowMs,
    });

    const tenantOwner = await createVerifiedUser(
      "tenant-owner@example.com",
      "TenantPassword!234",
      "Pemilik Toko",
    );

    // 1. Non-console hosts -> 404
    for (const wrongOrigin of [APP_ORIGIN, TENANT_ORIGIN, "https://punyasitus.com"]) {
      const res = await handleConsoleIncidentsRequest(
        new Request(`${wrongOrigin}/api/console/incidents`, {
          headers: { cookie: op.cookieHeader },
        }),
        runtimeEnv,
      );
      expect(res.status).toBe(404);
    }

    // 2. Unauthenticated -> 401
    const unauthRes = await handleConsoleIncidentsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/incidents`),
      runtimeEnv,
    );
    expect(unauthRes.status).toBe(401);

    // 3. Tenant owner / non-operator -> 403 on GET & POST
    const tenantGetRes = await handleConsoleIncidentsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/incidents`, {
        headers: { cookie: tenantOwner.cookieHeader },
      }),
      runtimeEnv,
    );
    expect(tenantGetRes.status).toBe(403);

    const tenantPostRes = await handleConsoleIncidentsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/incidents`, {
        method: "POST",
        headers: {
          cookie: tenantOwner.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "Unauthorized incident attempt",
          severity: "critical",
          affectedComponents: ["public_sites"],
          summary: "Tenant users must never declare platform incidents.",
        }),
      }),
      runtimeEnv,
    );
    expect(tenantPostRes.status).toBe(403);

    // 4. Missing CSRF Origin on POST -> 403
    const noOriginRes = await handleConsoleIncidentsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/incidents`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "Missing origin header test",
          severity: "minor",
          affectedComponents: ["public_sites"],
          summary: "Request without Origin header must be blocked by CSRF guard.",
        }),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(noOriginRes.status).toBe(403);

    // 5. Stale 2FA step-up (> 10 minutes) -> 403 REAUTH_REQUIRED on POST
    const staleStepUpRes = await handleConsoleIncidentsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/incidents`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "Stale step-up 2FA test",
          severity: "minor",
          affectedComponents: ["public_sites"],
          summary: "Stale 2FA step-up session must be forced to re-verify TOTP.",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + DEFAULT_SECOND_FACTOR_WINDOW_MS + 30_000 },
    );
    expect(staleStepUpRes.status).toBe(403);
    const staleJson = (await staleStepUpRes.json()) as { code: string };
    expect(staleJson.code).toBe("REAUTH_REQUIRED");
  });
});

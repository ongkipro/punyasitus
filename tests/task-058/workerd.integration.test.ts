import { env } from "cloudflare:workers";
import { createAuth } from "@punyasitus/auth";
import { issueEmailVerificationToken } from "@punyasitus/auth/onboarding/index";
import { createLocalMailSink, type EmailPort } from "@punyasitus/core/email/index";
import { ONBOARDING_TRIAL_DURATION_SECONDS, sha256Hex } from "@punyasitus/core/onboarding/index";
import { applyVerifiedEntitlementGrant } from "@punyasitus/db/billing/entitlements";
import {
  applyPlatformMigrations,
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { getActivePlatformOperator, PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { applyOnboardingTrialClaimsMigration } from "@punyasitus/db/provisioning/onboarding-migrations";
import {
  getOwnerOnboardingStatus,
  ONBOARDING_RETRY_STORE_INIT_TOPIC,
  type OnboardingRetryQueueProducer,
} from "@punyasitus/db/provisioning/self-service";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleCheckHandleRequest } from "../../apps/web/src/pages/api/onboarding/check-handle.ts";
import { handleOnboardingProvisionRequest } from "../../apps/web/src/pages/api/onboarding/provision.ts";
import { handleResendVerificationRequest } from "../../apps/web/src/pages/api/onboarding/resend-verification.ts";
import { handleOnboardingStatusRequest } from "../../apps/web/src/pages/api/onboarding/status.ts";
import { handleVerifyEmailRequest } from "../../apps/web/src/pages/api/onboarding/verify-email.ts";
import { processDurableQueueBatch } from "../../apps/web/src/worker/queues/consumer.ts";
import { createOnboardingRetryJobHandler } from "../../apps/web/src/worker/queues/onboarding/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TENANT_ORIGIN = "https://toko.situsku.click";
const APP_SECRET = "test-app-secret-punyasitus-t058-0123456789abcdef";

function buildRuntimeEnv(overrides?: Partial<{
  readonly TURNSTILE_SECRET_KEY: string;
  readonly JOBS_QUEUE: OnboardingRetryQueueProducer | null;
  readonly TENANT_STORE: TenantStoreNamespaceLike | null;
}>) {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE:
      overrides && "TENANT_STORE" in overrides
        ? overrides.TENANT_STORE
        : (env.TENANT_STORE as unknown as TenantStoreNamespaceLike),
    JOBS_QUEUE: overrides?.JOBS_QUEUE ?? null,
    AUTH_SECRET: APP_SECRET,
    TURNSTILE_SECRET_KEY: overrides?.TURNSTILE_SECRET_KEY,
  };
}

async function resetMutableTables(): Promise<void> {
  clearHostResolutionCache();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM onboarding_attempts"),
    env.PLATFORM_DB.prepare("DELETE FROM owner_trial_claims"),
    env.PLATFORM_DB.prepare("DELETE FROM entitlement_grants"),
    env.PLATFORM_DB.prepare("DELETE FROM settlements"),
    env.PLATFORM_DB.prepare("DELETE FROM payment_attempts"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_obligations"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM invitations"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM migration_bookmarks"),
    env.PLATFORM_DB.prepare("DELETE FROM deletion_tombstones"),
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
  readonly emailVerified?: boolean;
  readonly nowMs?: number;
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

  const signUpRes = await auth.api.signUpEmail({
    body: {
      email: params.email,
      password: params.password,
      name: params.name,
    },
    asResponse: true,
  });

  expect(signUpRes.status).toBe(200);
  const body = (await signUpRes.json()) as {
    readonly user: { readonly id: string; readonly email: string };
  };
  const setCookie = signUpRes.headers.get("set-cookie") ?? "";
  const cookiePair = setCookie.split(";")[0] ?? "";
  expect(cookiePair).toContain("__Host-ps_session=");

  if (params.emailVerified) {
    await env.PLATFORM_DB.prepare(
      "UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?",
    )
      .bind(params.nowMs ?? Date.now(), body.user.id)
      .run();
  }

  const sessionRow = await env.PLATFORM_DB.prepare(
    "SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(body.user.id)
    .first<{ readonly id: string }>();

  return {
    userId: body.user.id,
    sessionId: sessionRow?.id ?? "",
    email: body.user.email,
    cookieHeader: cookiePair,
  };
}

function makePostRequest(
  path: string,
  body: unknown,
  options: {
    readonly origin?: string;
    readonly hostOrigin?: string;
    readonly cookie?: string;
    readonly idempotencyKey?: string;
    readonly contentType?: string;
  } = {},
): Request {
  const targetOrigin = options.hostOrigin ?? APP_ORIGIN;
  const headers = new Headers({
    "Content-Type": options.contentType ?? "application/json",
  });
  if (options.origin !== "") {
    headers.set("Origin", options.origin ?? targetOrigin);
  }
  if (options.cookie) {
    headers.set("Cookie", options.cookie);
  }
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  return new Request(`${targetOrigin}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("TASK-058 workerd integration: verified signup, atomic 604,800s trial & 1-trial-per-owner", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applyOnboardingTrialClaimsMigration(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetMutableTables();
  });

  it("enforces app-host-only mounting (404 on console/tenant hosts), CSRF/Origin, no-store/noindex, and session expiry", async () => {
    // Console host and tenant host MUST receive 404 on every onboarding endpoint
    for (const foreignOrigin of [CONSOLE_ORIGIN, TENANT_ORIGIN, "https://punyasitus.com"]) {
      const checkRes = await handleCheckHandleRequest(
        new Request(`${foreignOrigin}/api/onboarding/check-handle?handle=toko-baru`),
        buildRuntimeEnv(),
      );
      expect(checkRes.status).toBe(404);
      expect(checkRes.headers.get("cache-control")).toBe("private, no-store");
      expect(checkRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");

      const provRes = await handleOnboardingProvisionRequest(
        makePostRequest(
          "/api/onboarding/provision",
          { handle: "toko-baru", name: "Toko Baru" },
          { hostOrigin: foreignOrigin, origin: foreignOrigin, idempotencyKey: "k-foreign-0001" },
        ),
        buildRuntimeEnv(),
      );
      expect(provRes.status).toBe(404);
    }

    // Wrong Origin & missing JSON Content-Type rejected with 403
    const badOriginRes = await handleVerifyEmailRequest(
      makePostRequest(
        "/api/onboarding/verify-email",
        { token: "a".repeat(64) },
        { origin: TENANT_ORIGIN },
      ),
      buildRuntimeEnv(),
    );
    expect(badOriginRes.status).toBe(403);

    const badCtRes = await handleVerifyEmailRequest(
      makePostRequest(
        "/api/onboarding/verify-email",
        "token=abc",
        { contentType: "application/x-www-form-urlencoded" },
      ),
      buildRuntimeEnv(),
    );
    expect(badCtRes.status).toBe(403);

    // Expired session rejected by enforceSessionLifetimeCeiling (401 UNAUTHENTICATED)
    const owner = await createAppUserSession({
      email: "expired.session@example.test",
      password: "Password!1234",
      name: "Expired Session",
      emailVerified: true,
    });
    const farFutureMs = Date.now() + 9 * 60 * 60 * 1000; // > 8h idle ceiling
    const statusRes = await handleOnboardingStatusRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/status`, {
        headers: { Cookie: owner.cookieHeader },
      }),
      buildRuntimeEnv(),
      { nowMs: farFutureMs },
    );
    expect(statusRes.status).toBe(401);
  });

  it("blocks unverified accounts (403 EMAIL_NOT_VERIFIED), verifies hashed tokens idempotently, handles expired links, rate limits & email outages", async () => {
    const baseMs = Date.UTC(2026, 10, 23, 2, 0, 0);
    const owner = await createAppUserSession({
      email: "unverified.owner@example.test",
      password: "Password!1234",
      name: "Siti Rahma",
      emailVerified: false,
      nowMs: baseMs,
    });

    // 1. Unverified owner MUST fail closed on /api/onboarding/provision
    const blockedRes = await handleOnboardingProvisionRequest(
      makePostRequest(
        "/api/onboarding/provision",
        { handle: "toko-siti", name: "Toko Siti", vertical: "catalog" },
        { cookie: owner.cookieHeader, idempotencyKey: "onb-unverified-001" },
      ),
      buildRuntimeEnv(),
      { nowMs: baseMs },
    );
    expect(blockedRes.status).toBe(403);
    const blockedBody = (await blockedRes.json()) as { readonly code: string };
    expect(blockedBody.code).toBe("EMAIL_NOT_VERIFIED");

    const tenantCountAfterBlock = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM tenants",
    ).first<{ readonly cnt: number }>();
    expect(tenantCountAfterBlock?.cnt).toBe(0);

    // 2. Graceful email outage on resend returns 503 EMAIL_DELIVERY_FAILED without crashing
    const failingEmailPort: EmailPort = {
      provider: "cloudflare",
      async send() {
        return {
          outcome: "failed",
          provider: "cloudflare",
          errorCode: "E_PROVIDER_OUTAGE",
          retryable: true,
          suppressed: false,
        };
      },
    };
    const outageRes = await handleResendVerificationRequest(
      makePostRequest(
        "/api/onboarding/resend-verification",
        {},
        { cookie: owner.cookieHeader },
      ),
      buildRuntimeEnv(),
      { emailPort: failingEmailPort, nowMs: baseMs },
    );
    expect(outageRes.status).toBe(503);
    const outageBody = (await outageRes.json()) as {
      readonly code: string;
      readonly emailOutage: boolean;
    };
    expect(outageBody.code).toBe("EMAIL_DELIVERY_FAILED");
    expect(outageBody.emailOutage).toBe(true);

    // 3. Immediate resend within 60s hits 429 RATE_LIMITED with Retry-After
    const mailSink = createLocalMailSink();
    const rateLimitedRes = await handleResendVerificationRequest(
      makePostRequest(
        "/api/onboarding/resend-verification",
        {},
        { cookie: owner.cookieHeader },
      ),
      buildRuntimeEnv(),
      { emailPort: mailSink, nowMs: baseMs + 10_000 },
    );
    expect(rateLimitedRes.status).toBe(429);
    expect(Number(rateLimitedRes.headers.get("retry-after"))).toBeGreaterThanOrEqual(45);

    // 4. Honeypot & Turnstile enforcement on resend
    const hpRes = await handleResendVerificationRequest(
      makePostRequest(
        "/api/onboarding/resend-verification",
        { hp_website: "https://spam.example" },
        { cookie: owner.cookieHeader },
      ),
      buildRuntimeEnv(),
      { emailPort: mailSink, nowMs: baseMs + 120_000 },
    );
    expect(hpRes.status).toBe(400);

    const turnstileRes = await handleResendVerificationRequest(
      makePostRequest(
        "/api/onboarding/resend-verification",
        {},
        { cookie: owner.cookieHeader },
      ),
      buildRuntimeEnv({ TURNSTILE_SECRET_KEY: "test-turnstile-secret" }),
      { emailPort: mailSink, nowMs: baseMs + 120_000 },
    );
    expect(turnstileRes.status).toBe(403);

    // 5. Issue verification token & verify plaintext token is NEVER stored in DB
    const issuedExpired = await issueEmailVerificationToken(env.PLATFORM_DB, {
      userId: owner.userId,
      baseURL: APP_ORIGIN,
      emailPort: mailSink,
      ttlMs: 60_000,
      nowMs: baseMs + 120_000,
    });
    expect(issuedExpired.status).toBe("sent");
    expect(issuedExpired.rawToken).toBeTruthy();

    const storedVerif = await env.PLATFORM_DB.prepare(
      "SELECT identifier, value FROM verifications WHERE identifier LIKE 'onboarding-verify:%'",
    ).all<{ readonly identifier: string; readonly value: string }>();
    for (const row of storedVerif.results ?? []) {
      expect(row.identifier).not.toContain(issuedExpired.rawToken!);
      expect(row.value).not.toContain(issuedExpired.rawToken!);
    }

    // 6. Expired token returns 410 VERIFICATION_TOKEN_EXPIRED with canResend: true
    const expiredRedeemRes = await handleVerifyEmailRequest(
      makePostRequest("/api/onboarding/verify-email", { token: issuedExpired.rawToken }),
      buildRuntimeEnv(),
      { nowMs: baseMs + 120_000 + 61_000 },
    );
    expect(expiredRedeemRes.status).toBe(410);
    const expiredBody = (await expiredRedeemRes.json()) as {
      readonly code: string;
      readonly canResend: boolean;
    };
    expect(expiredBody.code).toBe("VERIFICATION_TOKEN_EXPIRED");
    expect(expiredBody.canResend).toBe(true);

    // 7. Fresh resend via HTTP API -> extract token from local mail sink -> redeem & replay safely
    const resendRes = await handleResendVerificationRequest(
      makePostRequest(
        "/api/onboarding/resend-verification",
        {},
        { cookie: owner.cookieHeader },
      ),
      buildRuntimeEnv(),
      { emailPort: mailSink, nowMs: baseMs + 240_000 },
    );
    expect(resendRes.status).toBe(200);
    const sentMail = mailSink.latest();
    expect(sentMail?.to).toBe(owner.email);
    const match = /verify-email\?token=([a-f0-9]+)/i.exec(sentMail?.text ?? "");
    expect(match?.[1]).toBeTruthy();
    const freshToken = match![1]!;

    const verifyRes = await handleVerifyEmailRequest(
      makePostRequest("/api/onboarding/verify-email", { token: freshToken }),
      buildRuntimeEnv(),
      { nowMs: baseMs + 250_000 },
    );
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as {
      readonly status: string;
      readonly replayed: boolean;
    };
    expect(verifyBody.status).toBe("verified");
    expect(verifyBody.replayed).toBe(false);

    // Replay same verification token -> 200 idempotent replay
    const replayVerifyRes = await handleVerifyEmailRequest(
      makePostRequest("/api/onboarding/verify-email", { token: freshToken }),
      buildRuntimeEnv(),
      { nowMs: baseMs + 260_000 },
    );
    expect(replayVerifyRes.status).toBe(200);
    const replayBody = (await replayVerifyRes.json()) as {
      readonly status: string;
      readonly replayed: boolean;
    };
    expect(replayBody.status).toBe("already_verified");
    expect(replayBody.replayed).toBe(true);
  });

  it("provisions 1st site atomically with exact 604,800s trial, zero platform authority, TenantStore defaults & idempotent replay", async () => {
    const nowMs = Date.UTC(2026, 10, 23, 3, 0, 0);
    const owner = await createAppUserSession({
      email: "budi.verified@example.test",
      password: "Password!1234",
      name: "Budi Santoso",
      emailVerified: true,
      nowMs,
    });

    // Forged deadlines / roles / platform authority MUST be rejected with 422
    for (const forgedPayload of [
      { handle: "toko-budi", name: "Toko Budi", trialEndsAt: nowMs + 999_999_999 },
      { handle: "toko-budi", name: "Toko Budi", status: "active" },
      { handle: "toko-budi", name: "Toko Budi", role: "platform_operator" },
      { handle: "toko-budi", name: "Toko Budi", isPlatformOperator: true },
      { handle: "toko-budi", name: "Toko Budi", isPlatformAdmin: true },
    ]) {
      const forgedRes = await handleOnboardingProvisionRequest(
        makePostRequest("/api/onboarding/provision", forgedPayload, {
          cookie: owner.cookieHeader,
          idempotencyKey: "onb-forged-0001",
        }),
        buildRuntimeEnv(),
        { nowMs },
      );
      expect(forgedRes.status).toBe(422);
    }

    // Inline check-handle confirms availability & rejects reserved
    const reservedCheck = await handleCheckHandleRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/check-handle?handle=console`),
      buildRuntimeEnv(),
      { nowMs },
    );
    expect(reservedCheck.status).toBe(200);
    expect(await reservedCheck.json()).toMatchObject({
      available: false,
      code: "RESERVED_HANDLE",
    });

    const availCheck = await handleCheckHandleRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/check-handle?handle=Kopi-Budi`),
      buildRuntimeEnv(),
      { nowMs },
    );
    expect(await availCheck.json()).toMatchObject({
      available: true,
      normalizedHandle: "kopi-budi",
      primaryHost: "kopi-budi.situsku.click",
      code: "AVAILABLE",
    });

    // Provision 1st website
    const provisionRes = await handleOnboardingProvisionRequest(
      makePostRequest(
        "/api/onboarding/provision",
        { handle: "Kopi-Budi", name: "Kopi Budi Nusantara", vertical: "resto" },
        { cookie: owner.cookieHeader, idempotencyKey: "onb-budi-site-001" },
      ),
      buildRuntimeEnv(),
      { nowMs },
    );
    expect(provisionRes.status).toBe(201);
    expect(provisionRes.headers.get("cache-control")).toBe("private, no-store");
    expect(provisionRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const created = (await provisionRes.json()) as {
      readonly success: true;
      readonly replayed: boolean;
      readonly grantedTrial: boolean;
      readonly trialDurationSeconds: number;
      readonly awaitingFirstPayment: boolean;
      readonly tenantStoreInitialized: boolean;
      readonly tenant: {
        readonly id: string;
        readonly organizationId: string;
        readonly handle: string;
        readonly status: string;
        readonly effectiveStatus: string;
        readonly primaryHost: string;
        readonly trialEndsAt: number;
        readonly paidThrough: number | null;
        readonly schemaVersion: number;
      };
    };

    expect(created.replayed).toBe(false);
    expect(created.grantedTrial).toBe(true);
    expect(created.trialDurationSeconds).toBe(ONBOARDING_TRIAL_DURATION_SECONDS);
    expect(created.awaitingFirstPayment).toBe(false);
    expect(created.tenantStoreInitialized).toBe(true);
    expect(created.tenant.handle).toBe("kopi-budi");
    expect(created.tenant.primaryHost).toBe("kopi-budi.situsku.click");
    expect(created.tenant.status).toBe("trial");
    expect(created.tenant.effectiveStatus).toBe("trial");
    expect(created.tenant.paidThrough).toBeNull();
    // Exact 604,800 seconds server-owned trial!
    expect(created.tenant.trialEndsAt - nowMs).toBe(604_800 * 1000);
    expect(created.tenant.schemaVersion).toBeGreaterThan(0);

    // Zero platform operator authority granted
    const operatorGrant = await getActivePlatformOperator(env.PLATFORM_DB, owner.userId);
    expect(operatorGrant).toBeNull();

    // Verify TenantStore defaults were seeded cleanly
    const stub = openTenantStoreStub(
      env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      created.tenant.id,
    );
    const tenantDb = createTenantDb(stub);
    const settings = await tenantDb
      .prepare("SELECT site_title, active_theme_id FROM site_settings WHERE id = 1")
      .first<{ readonly site_title: string; readonly active_theme_id: string }>();
    expect(settings).toEqual({
      site_title: "Kopi Budi Nusantara",
      active_theme_id: "resto",
    });

    // Replay same Idempotency-Key 2 hours later -> NO duplicate tenant, NO renewed trial time!
    const replayRes = await handleOnboardingProvisionRequest(
      makePostRequest(
        "/api/onboarding/provision",
        { handle: "kopi-budi", name: "Kopi Budi Nusantara", vertical: "resto" },
        { cookie: owner.cookieHeader, idempotencyKey: "onb-budi-site-001" },
      ),
      buildRuntimeEnv(),
      { nowMs: nowMs + 2 * 60 * 60 * 1000 },
    );
    expect(replayRes.status).toBe(200);
    const replayed = (await replayRes.json()) as typeof created;
    expect(replayed.replayed).toBe(true);
    expect(replayed.tenant.id).toBe(created.tenant.id);
    expect(replayed.tenant.trialEndsAt).toBe(created.tenant.trialEndsAt);

    // Same Idempotency-Key with mismatched handle -> 409 IDEMPOTENCY_CONFLICT
    const conflictRes = await handleOnboardingProvisionRequest(
      makePostRequest(
        "/api/onboarding/provision",
        { handle: "kopi-budi-lain", name: "Kopi Budi Lain", vertical: "resto" },
        { cookie: owner.cookieHeader, idempotencyKey: "onb-budi-site-001" },
      ),
      buildRuntimeEnv(),
      { nowMs: nowMs + 3 * 60 * 60 * 1000 },
    );
    expect(conflictRes.status).toBe(409);

    const tenantCount = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS cnt FROM tenants").first<{
      readonly cnt: number;
    }>();
    expect(tenantCount?.cnt).toBe(1);
  });

  it("enforces one-trial-per-verified-owner: 2nd site starts payment-only (suspended), activates after settlement, stays isolated; concurrent double-trial race cannot grant 2 trials", async () => {
    const nowMs = Date.UTC(2026, 10, 23, 4, 0, 0);
    const owner = await createAppUserSession({
      email: "multi.site@example.test",
      password: "Password!1234",
      name: "Rina Wijaya",
      emailVerified: true,
      nowMs,
    });

    // 1. Concurrent double-trial race by the SAME verified owner on two distinct handles
    const [raceA, raceB] = await Promise.all([
      handleOnboardingProvisionRequest(
        makePostRequest(
          "/api/onboarding/provision",
          { handle: "rina-satu", name: "Rina Satu", vertical: "compro" },
          { cookie: owner.cookieHeader, idempotencyKey: "onb-race-owner-01" },
        ),
        buildRuntimeEnv(),
        { nowMs },
      ),
      handleOnboardingProvisionRequest(
        makePostRequest(
          "/api/onboarding/provision",
          { handle: "rina-dua", name: "Rina Dua", vertical: "catalog" },
          { cookie: owner.cookieHeader, idempotencyKey: "onb-race-owner-02" },
        ),
        buildRuntimeEnv(),
        { nowMs },
      ),
    ]);

    const raceStatuses = [raceA.status, raceB.status].sort((a, b) => a - b);
    // Exactly ONE gets the 1st trial (201); the concurrent racer either gets 409 TRIAL_ALREADY_CONSUMED
    // or payment-only (suspended) — NEVER two trials!
    const claimsRow = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM owner_trial_claims WHERE user_id = ?",
    )
      .bind(owner.userId)
      .first<{ readonly cnt: number }>();
    expect(claimsRow?.cnt).toBe(1);

    const trialTenantsRow = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM tenants WHERE status = 'trial' OR trial_ends_at IS NOT NULL",
    ).first<{ readonly cnt: number }>();
    expect(trialTenantsRow?.cnt).toBe(1);
    expect(raceStatuses[0]).toBe(201);

    const firstSiteRow = await env.PLATFORM_DB.prepare(
      "SELECT id, organization_id, handle, trial_ends_at FROM tenants WHERE status = 'trial' LIMIT 1",
    ).first<{
      readonly id: string;
      readonly organization_id: string;
      readonly handle: string;
      readonly trial_ends_at: number;
    }>();
    expect(firstSiteRow).toBeTruthy();

    // 2. Onboarding status now reports trialEligible === false
    const status = await getOwnerOnboardingStatus(env.PLATFORM_DB, owner.userId, { nowMs });
    expect(status?.trialEligible).toBe(false);
    expect(status?.trialConsumedReason).toBe("prior_trial_claim");

    // 3. Verified owner creates a 2nd website under a distinct handle -> NO free trial, starts suspended (payment-only)
    const secondRes = await handleOnboardingProvisionRequest(
      makePostRequest(
        "/api/onboarding/provision",
        { handle: "rina-kedua", name: "Rina Kedua Store", vertical: "dealer" },
        { cookie: owner.cookieHeader, idempotencyKey: "onb-rina-second-001" },
      ),
      buildRuntimeEnv(),
      { nowMs: nowMs + 60_000 },
    );
    expect(secondRes.status).toBe(201);
    const secondBody = (await secondRes.json()) as {
      readonly grantedTrial: boolean;
      readonly trialDurationSeconds: number | null;
      readonly awaitingFirstPayment: boolean;
      readonly billingMode: string;
      readonly nextPath: string;
      readonly tenant: {
        readonly id: string;
        readonly organizationId: string;
        readonly handle: string;
        readonly status: string;
        readonly effectiveStatus: string;
        readonly trialEndsAt: number | null;
        readonly paidThrough: number | null;
      };
    };

    expect(secondBody.grantedTrial).toBe(false);
    expect(secondBody.trialDurationSeconds).toBeNull();
    expect(secondBody.awaitingFirstPayment).toBe(true);
    expect(secondBody.billingMode).toBe("payment_only");
    expect(secondBody.tenant.status).toBe("suspended");
    expect(secondBody.tenant.effectiveStatus).toBe("suspended");
    expect(secondBody.tenant.trialEndsAt).toBeNull();
    expect(secondBody.tenant.paidThrough).toBeNull();
    expect(secondBody.nextPath).toBe("/dashboard/rina-kedua/billing");

    // Strictly isolated from 1st site (distinct tenant_id & organization_id & TenantStore)
    expect(secondBody.tenant.id).not.toBe(firstSiteRow!.id);
    expect(secondBody.tenant.organizationId).not.toBe(firstSiteRow!.organization_id);

    // 4. Verified settlement activates ONLY the 2nd site -> active, while 1st site remains untouched trial
    const settleMs = nowMs + 120_000;
    const obId = "01JTEST058OBLIGATN00000001";
    const paId = "01JTEST058PAYATTMP00000001";
    const stlId = "01JTEST058SETTLMNT00000001";
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO billing_obligations (
          id, tenant_id, payer_type, plan_interval, status,
          gross_amount_idr, discount_amount_idr, net_amount_idr, due_at, created_at, updated_at
        ) VALUES (?, ?, 'tenant', 'monthly', 'paid', 179000, 0, 179000, ?, ?, ?)`,
      ).bind(obId, secondBody.tenant.id, settleMs, settleMs, settleMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO payment_attempts (
          id, obligation_id, tenant_id, channel, provider, amount_idr, state, created_at, updated_at
        ) VALUES (?, ?, ?, 'QRIS', 'autolaris', 179000, 'settled', ?, ?)`,
      ).bind(paId, obId, secondBody.tenant.id, settleMs, settleMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO settlements (
          id, obligation_id, payment_attempt_id, tenant_id, amount_idr, settled_at, reconciled_via, created_at
        ) VALUES (?, ?, ?, ?, 179000, ?, 'advice', ?)`,
      ).bind(stlId, obId, paId, secondBody.tenant.id, settleMs, settleMs),
    ]);

    const grantRes = await applyVerifiedEntitlementGrant(env.PLATFORM_DB, {
      tenantId: secondBody.tenant.id,
      settlementId: stlId,
      plan: "monthly",
      grantedBy: "system:billing-advice",
      nowMs: settleMs,
    });
    expect(grantRes.applied).toBe(true);
    expect(grantRes.nextStatus).toBe("active");
    expect(grantRes.paidThroughMs).toBeGreaterThan(settleMs);

    // Confirm 1st site is completely unaffected (still trial, exact original trial_ends_at, null paid_through)
    const firstAfter = await env.PLATFORM_DB.prepare(
      "SELECT status, trial_ends_at, paid_through FROM tenants WHERE id = ?",
    )
      .bind(firstSiteRow!.id)
      .first<{
        readonly status: string;
        readonly trial_ends_at: number | null;
        readonly paid_through: number | null;
      }>();
    expect(firstAfter).toEqual({
      status: "trial",
      trial_ends_at: firstSiteRow!.trial_ends_at,
      paid_through: null,
    });
  });

  it("handles concurrent two-user handle collision (409 HANDLE_TAKEN) and deleted-trial tombstones", async () => {
    const nowMs = Date.UTC(2026, 10, 23, 5, 0, 0);
    const [userA, userB] = await Promise.all([
      createAppUserSession({
        email: "race.a@example.test",
        password: "Password!1234",
        name: "Owner Alpha",
        emailVerified: true,
        nowMs,
      }),
      createAppUserSession({
        email: "race.b@example.test",
        password: "Password!1234",
        name: "Owner Beta",
        emailVerified: true,
        nowMs,
      }),
    ]);

    const [resA, resB] = await Promise.all([
      handleOnboardingProvisionRequest(
        makePostRequest(
          "/api/onboarding/provision",
          { handle: "warung-rebutan", name: "Warung Rebutan A", vertical: "resto" },
          { cookie: userA.cookieHeader, idempotencyKey: "onb-handle-race-a" },
        ),
        buildRuntimeEnv(),
        { nowMs },
      ),
      handleOnboardingProvisionRequest(
        makePostRequest(
          "/api/onboarding/provision",
          { handle: "warung-rebutan", name: "Warung Rebutan B", vertical: "resto" },
          { cookie: userB.cookieHeader, idempotencyKey: "onb-handle-race-b" },
        ),
        buildRuntimeEnv(),
        { nowMs },
      ),
    ]);

    const sorted = [resA, resB].sort((x, y) => x.status - y.status);
    expect(sorted[0]!.status).toBe(201);
    expect(sorted[1]!.status).toBe(409);
    const loserBody = (await sorted[1]!.json()) as { readonly code: string };
    expect(loserBody.code).toBe("HANDLE_TAKEN");

    // Deleted-trial tombstone blocks repeat free trial even on a fresh user row
    const repeatUser = await createAppUserSession({
      email: "returning.tombstone@example.test",
      password: "Password!1234",
      name: "Returning Owner",
      emailVerified: true,
      nowMs,
    });
    const emailHash = await sha256Hex("returning.tombstone@example.test");
    await env.PLATFORM_DB.prepare(
      `INSERT INTO deletion_tombstones (
        id, tenant_id, handle, quarantine_until, email_hash, reason, deleted_at
      ) VALUES ('tomb-1', 'old-tenant-1', 'old-handle', ?, ?, 'trial_expired', ?)`,
    )
      .bind(nowMs + 30 * 86_400_000, emailHash, nowMs - 1000)
      .run();

    const repeatRes = await handleOnboardingProvisionRequest(
      makePostRequest(
        "/api/onboarding/provision",
        { handle: "situs-kembali", name: "Situs Kembali", vertical: "compro" },
        { cookie: repeatUser.cookieHeader, idempotencyKey: "onb-tombstone-01" },
      ),
      buildRuntimeEnv(),
      { nowMs },
    );
    expect(repeatRes.status).toBe(201);
    const repeatBody = (await repeatRes.json()) as {
      readonly grantedTrial: boolean;
      readonly awaitingFirstPayment: boolean;
      readonly tenant: { readonly status: string; readonly trialEndsAt: number | null };
    };
    expect(repeatBody.grantedTrial).toBe(false);
    expect(repeatBody.awaitingFirstPayment).toBe(true);
    expect(repeatBody.tenant.status).toBe("suspended");
    expect(repeatBody.tenant.trialEndsAt).toBeNull();
  });

  it("recovers cleanly from partial provisioning (TenantStore outage) via queue worker and idempotent resume without duplicating tenant or renewing trial", async () => {
    const nowMs = Date.UTC(2026, 10, 23, 6, 0, 0);
    const owner = await createAppUserSession({
      email: "partial.recovery@example.test",
      password: "Password!1234",
      name: "Dedi Kurniawan",
      emailVerified: true,
      nowMs,
    });

    const failingTenantStore: TenantStoreNamespaceLike = {
      getByName() {
        throw new Error("Simulated TenantStore DO outage");
      },
    };

    const queuedMessages: Array<{
      readonly idempotencyKey: string;
      readonly topic: string;
      readonly tenantId: string | null;
      readonly payload?: Record<string, unknown>;
    }> = [];
    const mockQueue: OnboardingRetryQueueProducer = {
      async send(msg) {
        queuedMessages.push(msg);
      },
    };

    // 1. Provision when TenantStore fails transiently -> 202 needs_recovery + queue job enqueued
    const partialRes = await handleOnboardingProvisionRequest(
      makePostRequest(
        "/api/onboarding/provision",
        { handle: "dedi-konsultan", name: "Dedi Konsultan", vertical: "compro" },
        { cookie: owner.cookieHeader, idempotencyKey: "onb-partial-0001" },
      ),
      buildRuntimeEnv({ TENANT_STORE: failingTenantStore, JOBS_QUEUE: mockQueue }),
      { nowMs },
    );
    expect(partialRes.status).toBe(202);
    const partialBody = (await partialRes.json()) as {
      readonly recoveryRequired: boolean;
      readonly provisioningState: string;
      readonly tenantStoreInitialized: boolean;
      readonly retryEnqueued: boolean;
      readonly tenant: {
        readonly id: string;
        readonly trialEndsAt: number;
        readonly schemaVersion: number;
      };
    };
    expect(partialBody.recoveryRequired).toBe(true);
    expect(partialBody.provisioningState).toBe("needs_recovery");
    expect(partialBody.tenantStoreInitialized).toBe(false);
    expect(partialBody.retryEnqueued).toBe(true);
    expect(partialBody.tenant.schemaVersion).toBe(0);
    expect(partialBody.tenant.trialEndsAt).toBe(nowMs + 604_800 * 1000);
    expect(queuedMessages).toHaveLength(1);
    expect(queuedMessages[0]?.topic).toBe(ONBOARDING_RETRY_STORE_INIT_TOPIC);

    // 2. Onboarding status surfaces pending recovery banner data
    const pendingStatus = await getOwnerOnboardingStatus(env.PLATFORM_DB, owner.userId, {
      nowMs: nowMs + 30_000,
    });
    expect(pendingStatus?.pendingRecoveries).toHaveLength(1);
    expect(pendingStatus?.pendingRecoveries[0]?.tenantId).toBe(partialBody.tenant.id);

    // 3. Process the queued recovery job with healthy TENANT_STORE 1 hour later
    const laterMs = nowMs + 60 * 60 * 1000;
    let acked = 0;
    const batch = {
      queue: "punyasitus-jobs-test",
      messages: [
        {
          id: "msg-onb-recovery-1",
          timestamp: new Date(laterMs),
          body: queuedMessages[0],
          attempts: 1,
          ack() {
            acked += 1;
          },
          retry() {
            throw new Error("Should not retry when TENANT_STORE is healthy");
          },
        },
      ],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<unknown>;

    const batchRes = await processDurableQueueBatch(
      batch,
      {
        PLATFORM_DB: env.PLATFORM_DB,
        TENANT_STORE: env.TENANT_STORE,
      },
      {
        [ONBOARDING_RETRY_STORE_INIT_TOPIC]: createOnboardingRetryJobHandler(),
      },
      { now: () => laterMs, logger: () => {} },
    );
    expect(batchRes.completed).toBe(1);
    expect(acked).toBe(1);

    // 4. Verify ZERO duplicate tenant, trialEndsAt UNCHANGED, schema_version > 0, and API resume is idempotent
    const resumeRes = await handleOnboardingProvisionRequest(
      makePostRequest(
        "/api/onboarding/provision",
        { action: "resume_recovery", resumeTenantId: partialBody.tenant.id },
        { cookie: owner.cookieHeader },
      ),
      buildRuntimeEnv(),
      { nowMs: laterMs + 5_000 },
    );
    expect(resumeRes.status).toBe(200);
    const resumed = (await resumeRes.json()) as {
      readonly alreadyCompleted: boolean;
      readonly tenantStoreInitialized: boolean;
      readonly tenant: {
        readonly id: string;
        readonly trialEndsAt: number;
        readonly schemaVersion: number;
      };
    };
    expect(resumed.alreadyCompleted).toBe(true);
    expect(resumed.tenantStoreInitialized).toBe(true);
    expect(resumed.tenant.id).toBe(partialBody.tenant.id);
    expect(resumed.tenant.trialEndsAt).toBe(partialBody.tenant.trialEndsAt);
    expect(resumed.tenant.schemaVersion).toBeGreaterThan(0);

    const tenantCount = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS cnt FROM tenants").first<{
      readonly cnt: number;
    }>();
    expect(tenantCount?.cnt).toBe(1);
  });
});

import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  mergeCookieHeaders,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth";
import {
  DEMO_READ_ONLY_ERROR_CODE,
  DEMO_THEME_SLUGS,
  formatIdr,
  FUNNEL_STAGES,
  guardDemoReadOnlyMethod,
  resolveMarketingHostRedirect,
} from "@punyasitus/core/marketing/index";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import {
  applyMarketingFunnelMigration,
  getFunnelSummary,
  loadLiveMarketingPricing,
} from "@punyasitus/db/marketing/index";
import {
  ensurePlatformOperatorRolesSchema,
  PLATFORM_MIGRATIONS,
  updatePlatformSettings,
} from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConsoleFunnelViewData } from "../../apps/web/src/pages/console/funnel/_handler.ts";
import {
  handleMarketingFunnelRequest,
  type MarketingFunnelRuntimeEnv,
} from "../../apps/web/src/pages/marketing/api/funnel.ts";

const MARKETING_ORIGIN = "https://punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_ORIGIN = "https://app.punyasitus.com";
const TENANT_ORIGIN = "https://toko-kopi.situsku.click";
const APP_SECRET = "task087-app-auth-secret-0123456789abcdef0123456789abcdef";
const CONSOLE_SECRET = "task087-console-auth-secret-fedcba9876543210fedcba987654";

function buildConsoleEnv(): ConsoleRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
  };
}

function buildMarketingEnv(): MarketingFunnelRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
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
    env.PLATFORM_DB.prepare("DELETE FROM marketing_funnel_daily"),
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM two_factors"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_settings"),
    env.PLATFORM_DB.prepare("DELETE FROM accounts"),
    env.PLATFORM_DB.prepare("DELETE FROM sessions"),
    env.PLATFORM_DB.prepare("DELETE FROM verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM users"),
  ]);
}

async function createNonOperatorConsoleUser(email: string, password: string, name: string) {
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
  };
}

describe("TASK-087 workerd integration — Live Pricing, Demo Guards, Cookieless Funnel & Console View", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await applyMarketingFunnelMigration(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetTables();
  });

  it("reads live monthly & yearly prices from PLATFORM_DB.platform_settings immediately with zero deploy", async () => {
    const auth = createConsoleAuth();
    const nowMs = Date.now();

    // 1. Default pricing before any platform_settings row exists
    const initial = await loadLiveMarketingPricing(env.PLATFORM_DB);
    expect(initial.source).toBe("default");
    expect(initial.monthlyPriceIdr).toBe(179_000);
    expect(initial.yearlyPriceIdr).toBe(1_790_000);
    expect(initial.yearlySavingsIdr).toBe(358_000);
    expect(initial.trialDays).toBe(7);
    expect(initial.nonPkpDisclosure).toContain("belum PKP");

    // 2. Active operator updates prices via platform_settings (console flow)
    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "pricing-op@example.com",
      password: "OperatorPassword!234",
      name: "Pricing Operator",
      nowMs,
    });

    await updatePlatformSettings(env.PLATFORM_DB, {
      actorUserId: op.user.id,
      nowMs: nowMs + 1000,
      payload: {
        salesWhatsapp: "0812-3456-7890",
        supportEmail: "dukungan@punyasitus.com",
        termsUrl: "https://punyasitus.com/marketing/syarat-ketentuan",
        privacyUrl: "https://punyasitus.com/marketing/privasi",
        monthlyPriceIdr: 225_000,
        yearlyPriceIdr: 2_190_000,
        expectedVersion: 0,
        reason: "Penyesuaian harga live untuk uji TASK-087 tanpa deploy ulang",
      },
    });

    const updated = await loadLiveMarketingPricing(env.PLATFORM_DB);
    expect(updated.source).toBe("platform_settings");
    expect(updated.monthlyPriceIdr).toBe(225_000);
    expect(updated.yearlyPriceIdr).toBe(2_190_000);
    expect(updated.yearlySavingsIdr).toBe(225_000 * 12 - 2_190_000);
    expect(updated.salesWhatsapp).toBe("6281234567890");
    expect(updated.supportEmail).toBe("dukungan@punyasitus.com");
    expect(formatIdr(updated.monthlyPriceIdr)).toBe("Rp 225.000");
    expect(formatIdr(updated.yearlyPriceIdr)).toBe("Rp 2.190.000");

    // 3. Direct update to billing.pricing key also reflects immediately
    await env.PLATFORM_DB.prepare(
      `INSERT INTO platform_settings (key, value_json, version, updated_by, updated_at)
       VALUES ('billing.pricing', ?, 2, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         version = platform_settings.version + 1,
         updated_at = excluded.updated_at`,
    )
      .bind(
        JSON.stringify({ monthlyPriceIdr: 249_000, yearlyPriceIdr: 2_490_000 }),
        op.user.id,
        nowMs + 5000,
      )
      .run();

    const directUpdated = await loadLiveMarketingPricing(env.PLATFORM_DB);
    expect(directUpdated.monthlyPriceIdr).toBe(249_000);
    expect(directUpdated.yearlyPriceIdr).toBe(2_490_000);
    expect(directUpdated.yearlySavingsIdr).toBe(498_000);
  });

  it("enforces noindex + 403 DEMO_READ_ONLY across all 6 synthetic demo routes and www -> 308 apex", async () => {
    const redir = resolveMarketingHostRedirect("https://www.punyasitus.com/marketing/demo/dealer?ref=1");
    expect(redir).toEqual({
      redirect: true,
      status: 308,
      location: "https://punyasitus.com/marketing/demo/dealer?ref=1",
    });

    for (const slug of DEMO_THEME_SLUGS) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = guardDemoReadOnlyMethod(
          new Request(`${MARKETING_ORIGIN}/marketing/demo/${slug}`, { method }),
        );
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
        expect(res!.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
        expect(res!.headers.get("set-cookie")).toBeNull();
        const body = (await res!.json()) as { code: string };
        expect(body.code).toBe(DEMO_READ_ONLY_ERROR_CODE);
      }
    }
  });

  it("records cookieless funnel events across all 6 stages with ZERO Set-Cookie headers and zero PII", async () => {
    const mEnv = buildMarketingEnv();
    const nowMs = Date.UTC(2026, 10, 23, 8, 0, 0);

    // Schema check: zero PII columns on marketing_funnel_daily
    const cols = await env.PLATFORM_DB.prepare("PRAGMA table_info(marketing_funnel_daily)").all<{
      readonly name: string;
    }>();
    const colNames = (cols.results ?? []).map((c) => c.name);
    expect(colNames).toEqual([
      "day_utc",
      "stage",
      "source_channel",
      "theme_slug",
      "count",
      "updated_at",
    ]);

    const events = [
      { stage: "visit", sourceChannel: "google" },
      { stage: "visit", sourceChannel: "google" },
      { stage: "visit", sourceChannel: "chatgpt.com" },
      { stage: "visit", sourceChannel: "direct" },
      { stage: "demo_view", sourceChannel: "google", themeSlug: "compro" },
      { stage: "demo_view", sourceChannel: "chatgpt.com", themeSlug: "dealer" },
      { stage: "demo_view", sourceChannel: "direct", themeSlug: "compro" },
      { stage: "signup_start", sourceChannel: "google", themeSlug: "compro" },
      { stage: "signup_start", sourceChannel: "chatgpt.com", themeSlug: "dealer" },
      { stage: "email_verified", sourceChannel: "google", themeSlug: "compro" },
      { stage: "trial_created", sourceChannel: "google", themeSlug: "compro" },
      { stage: "first_payment", sourceChannel: "google", themeSlug: "compro" },
    ];

    for (const payload of events) {
      const res = await handleMarketingFunnelRequest(
        new Request(`${MARKETING_ORIGIN}/marketing/api/funnel`, {
          method: "POST",
          headers: {
            Origin: MARKETING_ORIGIN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
        mEnv,
        { nowMs },
      );
      expect(res.status).toBe(202);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      const json = (await res.json()) as { accepted: boolean; stage: string };
      expect(json.accepted).toBe(true);
      expect(json.stage).toBe(payload.stage);
    }

    // Reject client-supplied dayUtc -> 422 UNKNOWN_FIELD
    const dayUtcRes = await handleMarketingFunnelRequest(
      new Request(`${MARKETING_ORIGIN}/marketing/api/funnel`, {
        method: "POST",
        headers: { Origin: MARKETING_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "visit", dayUtc: "2020-01-01" }),
      }),
      mEnv,
      { nowMs },
    );
    expect(dayUtcRes.status).toBe(422);
    expect(((await dayUtcRes.json()) as { code: string }).code).toBe("UNKNOWN_FIELD");

    // Reject missing BOTH Origin and Sec-Fetch-Site -> 403 ORIGIN_NOT_ALLOWED
    const noOriginRes = await handleMarketingFunnelRequest(
      new Request(`${MARKETING_ORIGIN}/marketing/api/funnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "visit" }),
      }),
      mEnv,
      { nowMs },
    );
    expect(noOriginRes.status).toBe(403);

    // Reject > 2048 byte payload -> 413 PAYLOAD_TOO_LARGE (both via Content-Length and streamed bytes)
    const oversizedPayload = JSON.stringify({
      stage: "visit",
      sourceChannel: "a".repeat(2500),
    });
    const oversizedRes = await handleMarketingFunnelRequest(
      new Request(`${MARKETING_ORIGIN}/marketing/api/funnel`, {
        method: "POST",
        headers: {
          Origin: MARKETING_ORIGIN,
          "Content-Type": "application/json",
          "Content-Length": String(oversizedPayload.length),
        },
        body: oversizedPayload,
      }),
      mEnv,
      { nowMs },
    );
    expect(oversizedRes.status).toBe(413);
    expect(((await oversizedRes.json()) as { code: string }).code).toBe("PAYLOAD_TOO_LARGE");

    // Streamed > 2048 byte body without Content-Length header also aborts with 413
    const streamedOversized = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(1500)));
        controller.enqueue(new TextEncoder().encode("y".repeat(1500)));
        controller.close();
      },
    });
    const streamedRes = await handleMarketingFunnelRequest(
      new Request(`${MARKETING_ORIGIN}/marketing/api/funnel`, {
        method: "POST",
        headers: {
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: streamedOversized,
      }),
      mEnv,
      { nowMs },
    );
    expect(streamedRes.status).toBe(413);

    // Arbitrary unknown sourceChannel collapses into closed `"other"` bucket
    const unknownChannelRes = await handleMarketingFunnelRequest(
      new Request(`${MARKETING_ORIGIN}/marketing/api/funnel`, {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "visit", sourceChannel: "arbitrary-attacker-token-99" }),
      }),
      mEnv,
      { nowMs },
    );
    expect(unknownChannelRes.status).toBe(202);
    expect(((await unknownChannelRes.json()) as { sourceChannel: string }).sourceChannel).toBe("other");

    // Reject PII payload -> 422
    const piiRes = await handleMarketingFunnelRequest(
      new Request(`${MARKETING_ORIGIN}/marketing/api/funnel`, {
        method: "POST",
        headers: { Origin: MARKETING_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "visit", email: "leak@example.com" }),
      }),
      mEnv,
      { nowMs },
    );
    expect(piiRes.status).toBe(422);
    expect(piiRes.headers.get("set-cookie")).toBeNull();

    // Reject cross-origin spoof -> 403
    const crossOriginRes = await handleMarketingFunnelRequest(
      new Request(`${MARKETING_ORIGIN}/marketing/api/funnel`, {
        method: "POST",
        headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "visit" }),
      }),
      mEnv,
      { nowMs },
    );
    expect(crossOriginRes.status).toBe(403);

    // Reject GET -> 405
    const getRes = await handleMarketingFunnelRequest(
      new Request(`${MARKETING_ORIGIN}/marketing/api/funnel`, { method: "GET" }),
      mEnv,
      { nowMs },
    );
    expect(getRes.status).toBe(405);

    const summary = await getFunnelSummary(env.PLATFORM_DB, 30, { nowMs });
    expect(summary.totalEvents).toBe(13);
    expect(summary.stages.map((s) => s.stage)).toEqual([...FUNNEL_STAGES]);
    expect(summary.stages.find((s) => s.stage === "visit")?.count).toBe(5);
    expect(summary.stages.find((s) => s.stage === "demo_view")?.count).toBe(3);
    expect(summary.stages.find((s) => s.stage === "signup_start")?.count).toBe(2);
    expect(summary.stages.find((s) => s.stage === "email_verified")?.count).toBe(1);
    expect(summary.stages.find((s) => s.stage === "trial_created")?.count).toBe(1);
    expect(summary.stages.find((s) => s.stage === "first_payment")?.count).toBe(1);
    expect(summary.visitToFirstPaymentPct).toBe(20);
    expect(summary.sources.find((s) => s.sourceChannel === "other")?.totalEvents).toBe(1);

    // Theme interest breakdown
    const comproTheme = summary.themes.find((t) => t.themeSlug === "compro");
    expect(comproTheme?.demoViews).toBe(2);
    expect(comproTheme?.signupStarts).toBe(1);

    // AI Assistant source channel captured cleanly without PII
    const aiSource = summary.sources.find((s) => s.sourceChannel === "ai_assistant");
    expect(aiSource?.totalEvents).toBe(3);
  });

  it("renders /console/funnel for active 2FA platform operator and denies non-operators & wrong hosts", async () => {
    const cEnv = buildConsoleEnv();
    const mEnv = buildMarketingEnv();
    const auth = createConsoleAuth();
    const nowMs = Date.now();
    const twentyDaysAgoMs = nowMs - 20 * 24 * 60 * 60 * 1000;

    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "funnel-op@example.com",
      password: "OperatorPassword!234",
      name: "Funnel Operator",
      nowMs,
    });
    const nonOp = await createNonOperatorConsoleUser(
      "regular-user@example.com",
      "RegularPass!234",
      "Regular User",
    );

    // Seed one recent event (today) and one older event (20 days ago via server clock `nowMs`)
    await handleMarketingFunnelRequest(
      new Request(`${MARKETING_ORIGIN}/marketing/api/funnel`, {
        method: "POST",
        headers: { Origin: MARKETING_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "visit", sourceChannel: "google" }),
      }),
      mEnv,
      { nowMs },
    );
    await handleMarketingFunnelRequest(
      new Request(`${MARKETING_ORIGIN}/marketing/api/funnel`, {
        method: "POST",
        headers: { Origin: MARKETING_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "visit",
          sourceChannel: "direct",
        }),
      }),
      mEnv,
      { nowMs: twentyDaysAgoMs },
    );

    // 1. Active 2FA operator on console host -> OK
    const loaded7d = await loadConsoleFunnelViewData(
      new Request(`${CONSOLE_ORIGIN}/console/funnel?range=7`, {
        headers: { cookie: op.cookieHeader },
      }),
      cEnv,
      { nowMs: nowMs + 1000 },
    );
    expect(loaded7d.ok).toBe(true);
    if (loaded7d.ok) {
      expect(loaded7d.rangeDays).toBe(7);
      expect(loaded7d.summary.stages.find((s) => s.stage === "visit")?.count).toBe(1);
    }

    const loaded30d = await loadConsoleFunnelViewData(
      new Request(`${CONSOLE_ORIGIN}/console/funnel?range=30`, {
        headers: { cookie: op.cookieHeader },
      }),
      cEnv,
      { nowMs: nowMs + 1000 },
    );
    expect(loaded30d.ok).toBe(true);
    if (loaded30d.ok) {
      expect(loaded30d.rangeDays).toBe(30);
      expect(loaded30d.summary.stages.find((s) => s.stage === "visit")?.count).toBe(2);
    }

    // 2. Unauthenticated -> 401
    const unauth = await loadConsoleFunnelViewData(
      new Request(`${CONSOLE_ORIGIN}/console/funnel`),
      cEnv,
      { nowMs: nowMs + 1000 },
    );
    expect(unauth.ok).toBe(false);
    if (!unauth.ok) {
      expect(unauth.status).toBe(401);
      expect(unauth.deniedResponse.headers.get("Cache-Control")).toBe("private, no-store");
      expect(unauth.deniedResponse.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }

    // 3. Non-operator user -> 403
    const deniedNonOp = await loadConsoleFunnelViewData(
      new Request(`${CONSOLE_ORIGIN}/console/funnel`, {
        headers: { cookie: nonOp.cookieHeader },
      }),
      cEnv,
      { nowMs: nowMs + 1000 },
    );
    expect(deniedNonOp.ok).toBe(false);
    if (!deniedNonOp.ok) {
      expect(deniedNonOp.status).toBe(403);
    }

    // 4. Wrong hosts -> bare neutral 404 without disclosing console existence
    for (const wrongOrigin of [MARKETING_ORIGIN, APP_ORIGIN, TENANT_ORIGIN]) {
      const wrongHost = await loadConsoleFunnelViewData(
        new Request(`${wrongOrigin}/console/funnel`, {
          headers: { cookie: op.cookieHeader },
        }),
        cEnv,
        { nowMs: nowMs + 1000 },
      );
      expect(wrongHost.ok).toBe(false);
      if (!wrongHost.ok) {
        expect(wrongHost.status).toBe(404);
        expect(wrongHost.deniedResponse.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
        expect(wrongHost.deniedResponse.headers.get("Cache-Control")).toBe("private, no-store");
        expect(wrongHost.deniedResponse.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
        const bodyText = await wrongHost.deniedResponse.text();
        expect(bodyText).toBe("Not Found");
        expect(bodyText).not.toContain("Console Operasional");
      }
    }
  });
});

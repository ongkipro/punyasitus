import { env } from "cloudflare:workers";
import {
  getHelpArticleOpenCounts,
  guardMarketingHelpHost,
  HELP_OPEN_EVENT_NAME,
  recordHelpArticleOpen,
} from "@punyasitus/core/help/index";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateRequestGate } from "../../apps/web/src/core/tenant.ts";

const VALID_SLUGS = new Set([
  "memulai-uji-coba-dan-daftar-akun",
  "menghubungkan-domain-kustom-dan-dns",
  "membayar-langganan-qris-dan-virtual-account",
]);

describe("TASK-104 workerd integration — Cookieless Help Article Open Counter & Host Isolation", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  beforeEach(async () => {
    await env.PLATFORM_DB.prepare("DELETE FROM marketing_funnel_events WHERE event_name = ?")
      .bind(HELP_OPEN_EVENT_NAME)
      .run();
  });

  it("atomically increments privacy-preserving article open counts in marketing_funnel_events with zero PII", async () => {
    // 1. Verify table schema has zero PII columns
    const cols = await env.PLATFORM_DB.prepare("PRAGMA table_info(marketing_funnel_events)").all<{
      readonly name: string;
    }>();
    const colNames = (cols.results ?? []).map((c) => c.name);
    expect(colNames).toEqual([
      "id",
      "day",
      "event_name",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "count",
      "updated_at",
    ]);

    const nowMs = Date.UTC(2026, 10, 23, 9, 30, 0);

    // 2. Record opens from dashboard, marketing, and untrusted PII-like source
    const r1 = await recordHelpArticleOpen(env.PLATFORM_DB, {
      slug: "menghubungkan-domain-kustom-dan-dns",
      validSlugs: VALID_SLUGS,
      source: "dashboard",
      nowMs,
    });
    expect(r1).toMatchObject({
      recorded: true,
      dayUtc: "2026-11-23",
      slug: "menghubungkan-domain-kustom-dan-dns",
      source: "dashboard",
    });

    const r2 = await recordHelpArticleOpen(env.PLATFORM_DB, {
      slug: "menghubungkan-domain-kustom-dan-dns",
      validSlugs: VALID_SLUGS,
      source: "dashboard",
      nowMs: nowMs + 1000,
    });
    expect(r2.recorded).toBe(true);

    const r3 = await recordHelpArticleOpen(env.PLATFORM_DB, {
      slug: "menghubungkan-domain-kustom-dan-dns",
      validSlugs: VALID_SLUGS,
      source: "marketing",
      nowMs: nowMs + 2000,
    });
    expect(r3.recorded).toBe(true);

    // Attempted PII in source collapses safely to "direct"
    const r4 = await recordHelpArticleOpen(env.PLATFORM_DB, {
      slug: "membayar-langganan-qris-dan-virtual-account",
      validSlugs: VALID_SLUGS,
      source: "budi@example.com",
      nowMs: nowMs + 3000,
    });
    expect(r4).toMatchObject({
      recorded: true,
      slug: "membayar-langganan-qris-dan-virtual-account",
      source: "direct",
    });

    // 3. Unknown / attacker slug is rejected cleanly and writes ZERO rows
    const rejectedUnknown = await recordHelpArticleOpen(env.PLATFORM_DB, {
      slug: "slug-tidak-valid-injeksi",
      validSlugs: VALID_SLUGS,
      source: "dashboard",
      nowMs,
    });
    expect(rejectedUnknown).toEqual({ recorded: false, reason: "unknown_slug" });

    const rejectedSyntax = await recordHelpArticleOpen(env.PLATFORM_DB, {
      slug: "../etc/passwd",
      validSlugs: VALID_SLUGS,
      source: "dashboard",
      nowMs,
    });
    expect(rejectedSyntax).toEqual({ recorded: false, reason: "invalid_slug" });

    // 4. Verify stored rows contain zero PII strings
    const rawRows = await env.PLATFORM_DB.prepare(
      "SELECT id, day, event_name, utm_source, utm_medium, utm_campaign, count FROM marketing_funnel_events WHERE event_name = ?",
    )
      .bind(HELP_OPEN_EVENT_NAME)
      .all<Record<string, unknown>>();
    const serializedRows = JSON.stringify(rawRows.results ?? []);
    expect(serializedRows).not.toContain("budi@example.com");
    expect(serializedRows).not.toContain("slug-tidak-valid-injeksi");

    // 5. Verify aggregated read helper
    const counts = await getHelpArticleOpenCounts(env.PLATFORM_DB, { days: 30, nowMs });
    expect(counts).toEqual([
      {
        slug: "menghubungkan-domain-kustom-dan-dns",
        totalOpens: 3,
        dashboardOpens: 2,
        marketingOpens: 1,
        directOpens: 0,
      },
      {
        slug: "membayar-langganan-qris-dan-virtual-account",
        totalOpens: 1,
        dashboardOpens: 0,
        marketingOpens: 0,
        directOpens: 1,
      },
    ]);
  });

  it("enforces marketing host isolation and canonical /bantuan routing in workerd runtime", async () => {
    const tenantRes = guardMarketingHelpHost(
      new Request("https://kopi-nusantara.situsku.click/bantuan"),
      { appEnv: "production", platformDomain: "punyasitus.com", localsSurface: "tenant", hasTenantContext: true },
    );
    expect(tenantRes?.status).toBe(404);
    expect(tenantRes?.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(tenantRes?.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(tenantRes?.headers.get("set-cookie")).toBeNull();

    const wwwRes = guardMarketingHelpHost(
      new Request("https://www.punyasitus.com/bantuan?from=dashboard"),
      { appEnv: "production", platformDomain: "punyasitus.com" },
    );
    expect(wwwRes?.status).toBe(308);
    expect(wwwRes?.headers.get("Location")).toBe("https://punyasitus.com/bantuan?from=dashboard");
    expect(wwwRes?.headers.get("set-cookie")).toBeNull();

    const apexRes = guardMarketingHelpHost(
      new Request("https://punyasitus.com/bantuan"),
      { appEnv: "production", platformDomain: "punyasitus.com", localsSurface: "marketing" },
    );
    expect(apexRes).toBeNull();

    // Verify request gate routes `/bantuan` cleanly across platform surfaces
    const gateEnv = {
      APP_ENV: "production",
      PLATFORM_DOMAIN: "punyasitus.com",
      SAAS_ZONE: "situsku.click",
      PLATFORM_DB: env.PLATFORM_DB,
    };

    const apexGate = await evaluateRequestGate(
      new Request("https://punyasitus.com/bantuan/menghubungkan-domain-kustom-dan-dns"),
      gateEnv,
    );
    expect(apexGate).toMatchObject({ action: "serve", surface: "marketing", tenant: null, noindex: false });

    const wwwGate = await evaluateRequestGate(
      new Request("https://www.punyasitus.com/bantuan?q=domain"),
      gateEnv,
    );
    expect(wwwGate.action).toBe("respond");
    if (wwwGate.action === "respond") {
      expect(wwwGate.response.status).toBe(308);
      expect(wwwGate.response.headers.get("Location")).toBe("https://punyasitus.com/bantuan?q=domain");
    }

    const appGate = await evaluateRequestGate(
      new Request("https://app.punyasitus.com/bantuan"),
      gateEnv,
    );
    expect(appGate.action).toBe("respond");
    if (appGate.action === "respond") {
      expect(appGate.response.status).toBe(301);
      expect(appGate.response.headers.get("Location")).toBe("https://punyasitus.com/bantuan");
    }
  });
});

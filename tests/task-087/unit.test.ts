import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  computeConversionRatePct,
  computeStaticCreditSimulation,
  createMarketingHostRedirectResponse,
  DEMO_READ_ONLY_ERROR_CODE,
  DEMO_TENANT_FIXTURES,
  DEMO_THEME_SLUGS,
  formatIdr,
  FUNNEL_SOURCE_CHANNELS,
  FUNNEL_STAGES,
  getDemoTenantBySlug,
  guardDemoReadOnlyMethod,
  listDemoTenants,
  MARKETING_JS_BUDGET_GZIP_BYTES,
  parseFunnelRangeDays,
  parseFunnelStage,
  resolveMarketingHostRedirect,
  safeJsonLdStringify,
  sanitizeSourceChannel,
  sanitizeThemeSlug,
  validateFunnelEventPayload,
  validateMarketingFunnelOrigin,
} from "@punyasitus/core/marketing/index";
import { MARKETING_FUNNEL_MIGRATION_SQL } from "@punyasitus/db/marketing/index";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-087 unit — Canonical www -> 308 apex redirect & open-redirect protection", () => {
  it("redirects www.punyasitus.com to apex preserving path and query with 308", () => {
    const res = resolveMarketingHostRedirect(
      "https://www.punyasitus.com/marketing/harga?utm_source=google&plan=yearly",
    );
    expect(res).toEqual({
      redirect: true,
      status: 308,
      location: "https://punyasitus.com/marketing/harga?utm_source=google&plan=yearly",
    });

    const httpRes = createMarketingHostRedirectResponse(
      new Request("https://www.punyasitus.com/marketing/demo/compro?ref=abc"),
    );
    expect(httpRes).not.toBeNull();
    expect(httpRes!.status).toBe(308);
    expect(httpRes!.headers.get("Location")).toBe(
      "https://punyasitus.com/marketing/demo/compro?ref=abc",
    );
    expect(httpRes!.headers.get("set-cookie")).toBeNull();
  });

  it("does not redirect canonical apex or unrelated hosts", () => {
    expect(resolveMarketingHostRedirect("https://punyasitus.com/marketing")).toEqual({
      redirect: false,
      reason: "apex",
    });
    expect(resolveMarketingHostRedirect("https://app.punyasitus.com/auth/signup")).toEqual({
      redirect: false,
      reason: "other_host",
    });
    expect(resolveMarketingHostRedirect("http://127.0.0.1:4321/marketing")).toEqual({
      redirect: false,
      reason: "invalid_url",
    });
  });

  it("blocks open-redirect and host-header injection payloads", () => {
    // Protocol-relative path `//evil.com` must collapse to single leading slash on apex
    const doubleSlash = resolveMarketingHostRedirect("https://www.punyasitus.com//evil.com/phish");
    expect(doubleSlash.redirect).toBe(true);
    if (doubleSlash.redirect) {
      const parsed = new URL(doubleSlash.location);
      expect(parsed.hostname).toBe("punyasitus.com");
      expect(parsed.pathname).toBe("/evil.com/phish");
    }

    // Credentialed userinfo spoofing rejected
    expect(
      resolveMarketingHostRedirect("https://www.punyasitus.com@evil.com/marketing"),
    ).toEqual({
      redirect: false,
      reason: "invalid_url",
    });

    // Backslash injection neutralized to root on apex
    const backslash = resolveMarketingHostRedirect("https://www.punyasitus.com/%5cevil.com");
    if (backslash.redirect) {
      expect(new URL(backslash.location).hostname).toBe("punyasitus.com");
    }

    // CRLF control char injection rejected
    expect(
      resolveMarketingHostRedirect("https://www.punyasitus.com/marketing\r\nSet-Cookie: x=1"),
    ).toEqual({
      redirect: false,
      reason: "invalid_url",
    });
  });

  it("enforces same-origin validation on cookieless funnel intake", () => {
    expect(
      validateMarketingFunnelOrigin(
        new Request("https://punyasitus.com/marketing/api/funnel", {
          method: "POST",
          headers: { Origin: "https://punyasitus.com" },
        }),
      ),
    ).toBe(true);

    // Sec-Fetch-Site: same-origin without Origin header is allowed
    expect(
      validateMarketingFunnelOrigin(
        new Request("https://punyasitus.com/marketing/api/funnel", {
          method: "POST",
          headers: { "Sec-Fetch-Site": "same-origin" },
        }),
      ),
    ).toBe(true);

    // Missing BOTH Origin and Sec-Fetch-Site (trivial anonymous curl flood) -> blocked!
    expect(
      validateMarketingFunnelOrigin(
        new Request("https://punyasitus.com/marketing/api/funnel", {
          method: "POST",
        }),
      ),
    ).toBe(false);

    // Cross-site Sec-Fetch-Site -> blocked even if Origin matches
    expect(
      validateMarketingFunnelOrigin(
        new Request("https://punyasitus.com/marketing/api/funnel", {
          method: "POST",
          headers: { Origin: "https://punyasitus.com", "Sec-Fetch-Site": "cross-site" },
        }),
      ),
    ).toBe(false);

    // Cross-origin spoof blocked
    expect(
      validateMarketingFunnelOrigin(
        new Request("https://punyasitus.com/marketing/api/funnel", {
          method: "POST",
          headers: { Origin: "https://evil.example" },
        }),
      ),
    ).toBe(false);

    // Wrong host blocked
    expect(
      validateMarketingFunnelOrigin(
        new Request("https://console.punyasitus.com/marketing/api/funnel", {
          method: "POST",
          headers: { Origin: "https://console.punyasitus.com" },
        }),
      ),
    ).toBe(false);

    // Local loopback allowed only when flag enabled
    const localReq = new Request("http://127.0.0.1:4321/marketing/api/funnel", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:4321" },
    });
    expect(validateMarketingFunnelOrigin(localReq, { allowLocalLoopback: false })).toBe(false);
    expect(validateMarketingFunnelOrigin(localReq, { allowLocalLoopback: true })).toBe(true);
  });
});

describe("TASK-087 unit — Six synthetic read-only demo tenants", () => {
  it("covers all 6 platform themes with 100% synthetic Indonesian fixtures", () => {
    const demos = listDemoTenants();
    expect(demos).toHaveLength(6);
    expect(demos.map((d) => d.slug)).toEqual([...DEMO_THEME_SLUGS]);

    for (const slug of DEMO_THEME_SLUGS) {
      const demo = getDemoTenantBySlug(slug);
      expect(demo).not.toBeNull();
      expect(demo!.items.length).toBeGreaterThanOrEqual(3);
      expect(demo!.faq.length).toBeGreaterThanOrEqual(2);
      // Synthetic phone guard: strictly 6281200000001..6281200000006
      expect(demo!.syntheticWhatsapp).toMatch(/^628120000000[1-6]$/);
      // Synthetic email guard: strictly @contoh.punyasitus.test
      expect(demo!.syntheticEmail).toMatch(/^demo-[a-z]+@contoh\.punyasitus\.test$/);
    }

    expect(getDemoTenantBySlug("nonexistent")).toBeNull();
    expect(DEMO_TENANT_FIXTURES.find((d) => d.slug === "dealer")?.creditSimulation).toBeDefined();
    expect(DEMO_TENANT_FIXTURES.find((d) => d.slug === "travel")?.itinerary?.length).toBeGreaterThan(0);
    expect(DEMO_TENANT_FIXTURES.find((d) => d.slug === "resto")?.branches?.length).toBe(3);
  });

  it("computes static vehicle credit estimates with integer Rupiah arithmetic", () => {
    const sim = computeStaticCreditSimulation({
      vehicleTitle: "Unit Uji",
      otrPriceIdr: 200_000_000,
      dpPercents: [20, 30],
      tenorsMonths: [12, 24],
      flatYearlyRateBps: 500, // 5.0%/yr
    });
    expect(sim.rows[0]?.dpAmountIdr).toBe(40_000_000);
    expect(sim.rows[0]?.principalIdr).toBe(160_000_000);
    // 160M * 1.05 = 168M / 12 = 14,000,000 exact!
    expect(sim.rows[0]?.installmentsByTenor[0]?.monthlyInstallmentIdr).toBe(14_000_000);
    // 160M * 1.10 = 176M / 24 = 7,333,333
    expect(sim.rows[0]?.installmentsByTenor[1]?.monthlyInstallmentIdr).toBe(7_333_333);
    expect(formatIdr(179_000)).toBe("Rp 179.000");
    expect(formatIdr(1_790_000)).toBe("Rp 1.790.000");
  });

  it("blocks POST/PUT/PATCH/DELETE on demo routes with 403 DEMO_READ_ONLY and noindex", async () => {
    expect(guardDemoReadOnlyMethod(new Request("https://punyasitus.com/marketing/demo/compro"))).toBeNull();
    expect(
      guardDemoReadOnlyMethod(
        new Request("https://punyasitus.com/marketing/demo/compro", { method: "HEAD" }),
      ),
    ).toBeNull();

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const blocked = guardDemoReadOnlyMethod(
        new Request("https://punyasitus.com/marketing/demo/compro", { method }),
      );
      expect(blocked).not.toBeNull();
      expect(blocked!.status).toBe(403);
      expect(blocked!.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      const json = (await blocked!.json()) as { code: string; success: boolean };
      expect(json.success).toBe(false);
      expect(json.code).toBe(DEMO_READ_ONLY_ERROR_CODE);
    }
  });
});

describe("TASK-087 unit — Cookieless funnel validation, zero PII & migration parity", () => {
  it("validates funnel stages, rejects client dayUtc & PII keys, and enforces closed source_channel buckets", () => {
    for (const stage of FUNNEL_STAGES) {
      expect(parseFunnelStage(stage)).toBe(stage);
    }
    expect(parseFunnelStage("purchase_hack")).toBeNull();

    expect(FUNNEL_SOURCE_CHANNELS).toEqual([
      "direct",
      "organic_search",
      "paid",
      "social",
      "whatsapp",
      "referral",
      "ai_assistant",
      "other",
    ]);

    expect(sanitizeSourceChannel("chatgpt.com")).toBe("ai_assistant");
    expect(sanitizeSourceChannel("perplexity.ai")).toBe("ai_assistant");
    expect(sanitizeSourceChannel("www.google.co.id")).toBe("organic_search");
    expect(sanitizeSourceChannel("google_ads")).toBe("paid");
    expect(sanitizeSourceChannel("cpc")).toBe("paid");
    expect(sanitizeSourceChannel("instagram.com")).toBe("social");
    expect(sanitizeSourceChannel("wa.me")).toBe("whatsapp");
    expect(sanitizeSourceChannel("affiliate")).toBe("referral");
    // Arbitrary unknown strings collapse to closed `"other"` bucket (prevents unbounded PK cardinality)
    expect(sanitizeSourceChannel("random-attacker-utm-1")).toBe("other");
    expect(sanitizeSourceChannel("newsletter-november")).toBe("other");
    // PII-looking values collapse safely to direct
    expect(sanitizeSourceChannel("user@example.com")).toBe("direct");
    expect(sanitizeSourceChannel("6281234567890")).toBe("direct");
    expect(sanitizeSourceChannel("foo?email=a@b.com")).toBe("direct");

    expect(sanitizeThemeSlug("compro")).toBe("compro");
    expect(sanitizeThemeSlug("unknown-theme")).toBe("");

    const valid = validateFunnelEventPayload({
      stage: "demo_view",
      sourceChannel: "google",
      themeSlug: "dealer",
    });
    expect(valid).toEqual({
      ok: true,
      data: { stage: "demo_view", sourceChannel: "organic_search", themeSlug: "dealer" },
    });

    // Client-supplied `dayUtc` must be rejected (server derives `dayUtc` from server clock only)
    const clientDayRejected = validateFunnelEventPayload({
      stage: "visit",
      dayUtc: "2020-01-01",
    });
    expect(clientDayRejected.ok).toBe(false);
    if (!clientDayRejected.ok) {
      expect(clientDayRejected.code).toBe("UNKNOWN_FIELD");
    }

    for (const piiKey of ["ip", "ipAddress", "email", "phone", "cookie", "visitorId", "userAgent"]) {
      const rejected = validateFunnelEventPayload({ stage: "visit", [piiKey]: "secret" });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.code).toBe("PII_FIELD_FORBIDDEN");
      }
    }

    // Safe JSON-LD escaping blocks script-tag breakout
    const escapedJsonLd = safeJsonLdStringify({ description: "</script><script>alert(1)</script>" });
    expect(escapedJsonLd).not.toContain("</script>");
    expect(escapedJsonLd).toContain("\\u003c/script\\u003e");

    expect(parseFunnelRangeDays("7")).toBe(7);
    expect(parseFunnelRangeDays("30")).toBe(30);
    expect(parseFunnelRangeDays("90")).toBe(90);
    expect(parseFunnelRangeDays("365")).toBe(30);
    expect(computeConversionRatePct(15, 60)).toBe(25);
    expect(computeConversionRatePct(5, 0)).toBe(0);
  });

  it("enforces ZERO request-time runtime DDL in marketing repository, marketing pages, and console funnel", () => {
    const runtimeTargets = [
      path.join(REPO_ROOT, "packages/db/src/marketing/repository.ts"),
      path.join(REPO_ROOT, "apps/web/src/pages/marketing"),
      path.join(REPO_ROOT, "apps/web/src/pages/console/funnel"),
    ];

    function checkNoRuntimeDdl(targetPath: string): void {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
          checkNoRuntimeDdl(path.join(targetPath, entry.name));
        }
        return;
      }
      const content = fs.readFileSync(targetPath, "utf8");
      expect(content, `Forbidden ensureMarketingFunnelSchema in ${targetPath}`).not.toMatch(
        /ensureMarketingFunnelSchema/,
      );
      expect(content, `Forbidden runtime CREATE TABLE DDL in ${targetPath}`).not.toMatch(
        /CREATE\s+TABLE/i,
      );
    }

    for (const target of runtimeTargets) {
      checkNoRuntimeDdl(target);
    }
  });

  it("matches 0008_marketing_funnel.sql byte-for-byte with bundled MARKETING_FUNNEL_MIGRATION_SQL", () => {
    const sqlFile = fs.readFileSync(
      path.join(REPO_ROOT, "packages/db/migrations/platform/0008_marketing_funnel.sql"),
      "utf8",
    );
    expect(MARKETING_FUNNEL_MIGRATION_SQL).toBe(sqlFile);
    const sqlWithoutComments = sqlFile.replace(/^--.*$/gm, "");
    expect(sqlWithoutComments).not.toMatch(/\b(ip_address|visitor_id|cookie|email)\b/i);
  });

  it("enforces zero third-party ad trackers, surface isolation, and <= 25 KiB gzipped JS budget", () => {
    const marketingDirs = [
      path.join(REPO_ROOT, "apps/web/src/components/marketing"),
      path.join(REPO_ROOT, "apps/web/src/pages/marketing"),
    ];

    const forbiddenPatterns = [
      /googletagmanager\.com/i,
      /google-analytics\.com/i,
      /connect\.facebook\.net/i,
      /analytics\.tiktok\.com/i,
      /fonts\.googleapis\.com/i,
      /@base-ui\/react/i,
      /styles\/admin\/globals\.css/i,
      /document\.cookie/i,
    ];

    let totalMarketingScriptSource = "";

    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const content = fs.readFileSync(full, "utf8");
        for (const pattern of forbiddenPatterns) {
          expect(content, `Forbidden pattern ${pattern} in ${full}`).not.toMatch(pattern);
        }
        if (entry.name.endsWith(".astro")) {
          const scriptMatches = content.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi);
          for (const match of scriptMatches) {
            if (/application\/ld\+json/i.test(match[0])) continue;
            totalMarketingScriptSource += `\n${match[1] ?? ""}`;
          }
        }
      }
    }

    for (const dir of marketingDirs) {
      walk(dir);
    }

    const gzipBytes = zlib.gzipSync(Buffer.from(totalMarketingScriptSource, "utf8")).byteLength;
    expect(gzipBytes).toBeLessThanOrEqual(MARKETING_JS_BUDGET_GZIP_BYTES);
    // Should be tiny (< 2 KiB, far below the 25 KiB cap)
    expect(gzipBytes).toBeLessThan(2 * 1024);
  });
});

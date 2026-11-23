import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CRON_JOB_DEFINITIONS,
  SEO_INDEXNOW_CRON_JOB_DEFINITION,
} from "../../apps/web/src/worker/cron/index.ts";
import {
  createSeoJobRegistry,
  SEO_CRON_JOB_DEFINITIONS,
  SEO_INDEXNOW_FLUSH_TOPIC,
  SEO_INDEXNOW_PING_TOPIC,
} from "../../apps/web/src/worker/queues/seo/index.ts";
import {
  AI_ASSISTANT_HOSTS,
  buildChannelAttributionSummary,
  classifyAttributionFromUrlAndReferrer,
  classifyTrafficAttribution,
  extractNormalizedReferrerHost,
  matchesHostnameExactOrSubdomain,
} from "../../packages/core/src/analytics/attribution.ts";
import { generateSchemaGraph } from "../../packages/core/src/schema-generator.ts";
import {
  buildIndexNowBatchIdempotencyKey,
  buildIndexNowKeyLocation,
  buildIndexNowSubmissionPayload,
  constantTimeEqualStrings,
  evaluateIndexNowEligibility,
  generateIndexNowKey,
  INDEXNOW_ENDPOINT,
  isValidIndexNowKey,
  normalizeAndDeduplicateIndexNowUrls,
  submitIndexNowBatch,
} from "../../packages/core/src/seo/indexnow.ts";
import {
  AI_TRAINING_ONLY_CRAWLERS,
  ALLOWED_SEARCH_AND_AI_FETCHERS,
  FACETED_FILTER_DISALLOW_PATTERNS,
  filterPublicTourDepartures,
  generateTenantRobotsTxt,
  isPathAllowedByRobotsTxt,
  isSpeculativeLlmsTxtPath,
  LLMS_TXT_GENERATION_ENABLED,
  renderPublicTourDeparturesHtml,
} from "../../packages/core/src/seo/robots.ts";

describe("TASK-095: AI & Search Visibility Engine (Unit)", () => {
  describe("1. Dynamic /robots.txt Bot Split & Crawl Budget Protection", () => {
    const activeCustomTenant = {
      tenantHandle: "berkah-tour",
      tenantStatus: "active" as const,
      primaryHost: "www.berkahtour.id",
      primaryHostKind: "custom" as const,
      primaryHostStatus: "active" as const,
      primaryHostSslStatus: "active" as const,
      primaryHostVerified: true,
      verifiedTenantHosts: ["www.berkahtour.id", "berkah-tour.situsku.click"],
      servingHost: "www.berkahtour.id",
    };

    it("explicitly allows all 9 search/user-triggered AI fetchers and toggles all 4 training crawlers cleanly", () => {
      expect(ALLOWED_SEARCH_AND_AI_FETCHERS).toEqual([
        "Googlebot",
        "Bingbot",
        "OAI-SearchBot",
        "ChatGPT-User",
        "Claude-SearchBot",
        "Claude-User",
        "PerplexityBot",
        "Perplexity-User",
        "Applebot",
      ]);
      expect(AI_TRAINING_ONLY_CRAWLERS).toEqual([
        "GPTBot",
        "ClaudeBot",
        "Google-Extended",
        "Applebot-Extended",
      ]);

      // Policy = "allow"
      const allowedPolicy = generateTenantRobotsTxt({
        tenant: activeCustomTenant,
        aiTrainingPolicy: "allow",
        siteVisibility: "public",
      });
      expect(allowedPolicy.httpStatus).toBe(200);
      expect(allowedPolicy.indexable).toBe(true);
      expect(allowedPolicy.sitemapUrl).toBe("https://www.berkahtour.id/sitemap.xml");
      expect(allowedPolicy.body).toContain("Sitemap: https://www.berkahtour.id/sitemap.xml");
      expect(allowedPolicy.botSplit.searchBotsAllowed).toHaveLength(9);
      expect(allowedPolicy.botSplit.trainingBotsAllowed).toHaveLength(4);
      expect(allowedPolicy.botSplit.trainingBotsDisallowed).toHaveLength(0);
      expect(allowedPolicy.botSplit.llmsTxtSupported).toBe(false);

      for (const bot of ALLOWED_SEARCH_AND_AI_FETCHERS) {
        expect(isPathAllowedByRobotsTxt(allowedPolicy.body, bot, "/")).toBe(true);
        expect(isPathAllowedByRobotsTxt(allowedPolicy.body, bot, "/kendaraan")).toBe(true);
        expect(isPathAllowedByRobotsTxt(allowedPolicy.body, bot, "/kendaraan?page=2")).toBe(true);
        expect(
          isPathAllowedByRobotsTxt(allowedPolicy.body, bot, "/kendaraan?brand=toyota&year=2025"),
        ).toBe(false);
        expect(
          isPathAllowedByRobotsTxt(allowedPolicy.body, bot, "/produk?category=kopi&sort=price"),
        ).toBe(false);
        expect(isPathAllowedByRobotsTxt(allowedPolicy.body, bot, "/dashboard/berkah-tour")).toBe(
          false,
        );
      }

      for (const bot of AI_TRAINING_ONLY_CRAWLERS) {
        expect(isPathAllowedByRobotsTxt(allowedPolicy.body, bot, "/")).toBe(true);
      }

      // Policy = "disallow"
      const disallowedPolicy = generateTenantRobotsTxt({
        tenant: activeCustomTenant,
        aiTrainingPolicy: "disallow",
        siteVisibility: "public",
      });
      expect(disallowedPolicy.httpStatus).toBe(200);
      expect(disallowedPolicy.indexable).toBe(true);
      expect(disallowedPolicy.botSplit.searchBotsAllowed).toHaveLength(9);
      expect(disallowedPolicy.botSplit.trainingBotsAllowed).toHaveLength(0);
      expect(disallowedPolicy.botSplit.trainingBotsDisallowed).toHaveLength(4);

      for (const bot of ALLOWED_SEARCH_AND_AI_FETCHERS) {
        expect(isPathAllowedByRobotsTxt(disallowedPolicy.body, bot, "/")).toBe(true);
      }
      for (const bot of AI_TRAINING_ONLY_CRAWLERS) {
        expect(isPathAllowedByRobotsTxt(disallowedPolicy.body, bot, "/")).toBe(false);
        expect(isPathAllowedByRobotsTxt(disallowedPolicy.body, bot, "/blog/umrah-2027")).toBe(
          false,
        );
      }

      for (const pattern of FACETED_FILTER_DISALLOW_PATTERNS) {
        expect(disallowedPolicy.body).toContain(`Disallow: ${pattern}`);
      }
    });

    it("keeps grace and locked paid sites indexable while emitting Disallow: / + noindex and NO Sitemap on trial/suspended/recovery", () => {
      for (const paidStatus of ["grace", "locked"] as const) {
        const res = generateTenantRobotsTxt({
          tenant: { ...activeCustomTenant, tenantStatus: paidStatus },
          aiTrainingPolicy: "disallow",
        });
        expect(res.httpStatus).toBe(200);
        expect(res.indexable).toBe(true);
        expect(res.sitemapUrl).toBe("https://www.berkahtour.id/sitemap.xml");
        expect(isPathAllowedByRobotsTxt(res.body, "Googlebot", "/")).toBe(true);
        expect(isPathAllowedByRobotsTxt(res.body, "GPTBot", "/")).toBe(false);
      }

      const trialRes = generateTenantRobotsTxt({
        tenant: {
          tenantHandle: "trial-toko",
          tenantStatus: "trial",
          primaryHost: "trial-toko.situsku.click",
          primaryHostKind: "subdomain",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
          verifiedTenantHosts: ["trial-toko.situsku.click"],
        },
        aiTrainingPolicy: "allow",
      });
      expect(trialRes.httpStatus).toBe(200);
      expect(trialRes.indexable).toBe(false);
      expect(trialRes.xRobotsTag).toBe("noindex, nofollow");
      expect(trialRes.sitemapUrl).toBeNull();
      expect(trialRes.body).toBe("User-agent: *\nDisallow: /\n");
      expect(trialRes.body).not.toContain("Sitemap:");

      for (const blockedStatus of ["suspended", "recovery"] as const) {
        const res = generateTenantRobotsTxt({
          tenant: { ...activeCustomTenant, tenantStatus: blockedStatus },
          aiTrainingPolicy: "allow",
        });
        expect(res.httpStatus).toBe(503);
        expect(res.indexable).toBe(false);
        expect(res.xRobotsTag).toBe("noindex, nofollow");
        expect(res.sitemapUrl).toBeNull();
        expect(res.body).toBe("User-agent: *\nDisallow: /\n");
      }
    });

    it("forbids speculative llms.txt generation explicitly", () => {
      expect(LLMS_TXT_GENERATION_ENABLED).toBe(false);
      expect(isSpeculativeLlmsTxtPath("/llms.txt")).toBe(true);
      expect(isSpeculativeLlmsTxtPath("/llms-full.txt")).toBe(true);
      expect(isSpeculativeLlmsTxtPath("/robots.txt")).toBe(false);
    });
  });

  describe("2. Past Tour Departure Date Omission (Public HTML + JSON-LD)", () => {
    it("omits past and closed tour departure dates identically from public HTML and Schema.org TouristTrip JSON-LD", () => {
      const departures = [
        { departureDate: "2026-10-01", status: "open" as const }, // past
        { departureDate: "2026-11-22", status: "open" as const }, // yesterday
        { departureDate: "2026-11-23", status: "limited" as const }, // today (keep)
        { departureDate: "2026-12-15", status: "open" as const }, // future (keep)
        { departureDate: "2027-01-10", status: "closed" as const }, // closed (omit)
      ];
      const now = "2026-11-23";

      const filtered = filterPublicTourDepartures(departures, now, "Asia/Jakarta");
      expect(filtered.map((d) => d.departureDate)).toEqual(["2026-11-23", "2026-12-15"]);

      const html = renderPublicTourDeparturesHtml(departures, now, "Asia/Jakarta");
      expect(html).toContain("2026-11-23");
      expect(html).toContain("2026-12-15");
      expect(html).not.toContain("2026-10-01");
      expect(html).not.toContain("2026-11-22");
      expect(html).not.toContain("2027-01-10");

      const schema = generateSchemaGraph({
        seo: {
          surface: "public_tenant",
          routeKind: "offering",
          pathname: "/tour/umrah-reguler-9-hari",
          tenant: {
            tenantHandle: "berkah-tour",
            tenantStatus: "active",
            primaryHost: "www.berkahtour.id",
            primaryHostKind: "custom",
            primaryHostStatus: "active",
            primaryHostSslStatus: "active",
            primaryHostVerified: true,
            verifiedTenantHosts: ["www.berkahtour.id"],
            servingHost: "www.berkahtour.id",
          },
          siteVisibility: "public",
          resourceState: "published",
        },
        siteName: "Berkah Tour & Travel",
        now,
        timezone: "Asia/Jakarta",
        offering: {
          offeringType: "tour",
          title: "Paket Umrah Reguler 9 Hari",
          summary: "Keberangkatan resmi PPIU dengan hotel dekat Masjidil Haram.",
          attributes: {
            destination: "Makkah & Madinah",
            durationDays: 9,
            departures: departures.map((d) => ({
              departureDate: d.departureDate,
              status: d.status,
            })),
          },
        },
      });

      expect(schema.emitted).toBe(true);
      const tripNode = schema.nodes.find((n) => n["@type"] === "TouristTrip");
      expect(tripNode).toBeDefined();
      expect(tripNode?.departureTime).toEqual(["2026-11-23", "2026-12-15"]);
      expect(schema.jsonLd).not.toContain("2026-10-01");
      expect(schema.jsonLd).not.toContain("2026-11-22");
      expect(schema.jsonLd).not.toContain("2027-01-10");
    });
  });

  describe("3. Verified Custom-Domain IndexNow Key, Dedup & Trial Skip", () => {
    it("generates cryptographic 32-hex keys and validates key format strictly", () => {
      const key1 = generateIndexNowKey();
      const key2 = generateIndexNowKey();
      expect(key1).toMatch(/^[a-f0-9]{32}$/);
      expect(key2).toMatch(/^[a-f0-9]{32}$/);
      expect(key1).not.toBe(key2);

      expect(isValidIndexNowKey(key1)).toBe(true);
      expect(isValidIndexNowKey("a".repeat(32))).toBe(true);
      expect(isValidIndexNowKey("a".repeat(128))).toBe(true);
      expect(isValidIndexNowKey("a".repeat(31))).toBe(false);
      expect(isValidIndexNowKey("a".repeat(129))).toBe(false);
      expect(isValidIndexNowKey("llms")).toBe(false);
      expect(isValidIndexNowKey("robots")).toBe(false);
      expect(isValidIndexNowKey(`${"a".repeat(32)}/../secret`)).toBe(false);

      expect(constantTimeEqualStrings(key1, key1)).toBe(true);
      expect(constantTimeEqualStrings(key1, key2)).toBe(false);
    });

    it("restricts IndexNow strictly to verified paid custom domains and skips .situsku.click trials/subdomains", () => {
      expect(
        evaluateIndexNowEligibility({
          tenantStatus: "active",
          primaryHost: "www.toko-maju.id",
          primaryHostKind: "custom",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
        }),
      ).toEqual({
        eligible: true,
        host: "www.toko-maju.id",
        origin: "https://www.toko-maju.id",
      });

      // Trial subdomain -> skipped
      expect(
        evaluateIndexNowEligibility({
          tenantStatus: "trial",
          primaryHost: "toko-trial.situsku.click",
          primaryHostKind: "subdomain",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
        }),
      ).toEqual({
        eligible: false,
        reason: "non_indexable_tenant_status",
      });

      // Active paid tenant still on .situsku.click subdomain -> skipped
      expect(
        evaluateIndexNowEligibility({
          tenantStatus: "active",
          primaryHost: "toko-maju.situsku.click",
          primaryHostKind: "subdomain",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
        }),
      ).toEqual({
        eligible: false,
        reason: "trial_or_subdomain_host",
      });

      // Spoofed custom kind with .situsku.click host -> still skipped!
      expect(
        evaluateIndexNowEligibility({
          tenantStatus: "active",
          primaryHost: "toko-maju.situsku.click",
          primaryHostKind: "custom",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
        }),
      ).toEqual({
        eligible: false,
        reason: "trial_or_subdomain_host",
      });

      // Unverified custom domain -> skipped
      expect(
        evaluateIndexNowEligibility({
          tenantStatus: "active",
          primaryHost: "www.toko-maju.id",
          primaryHostKind: "custom",
          primaryHostStatus: "pending",
          primaryHostSslStatus: "pending",
          primaryHostVerified: false,
        }),
      ).toEqual({
        eligible: false,
        reason: "custom_domain_not_verified",
      });
    });

    it("normalizes, filters, deduplicates URLs and submits one batch POST via injectable fetch", async () => {
      const key = generateIndexNowKey();
      const urls = normalizeAndDeduplicateIndexNowUrls("www.toko-maju.id", [
        "/blog/promo-b2b?utm_source=chatgpt.com&fbclid=123",
        "https://www.toko-maju.id/blog/promo-b2b",
        "/produk/mesin-kopi/",
        "https://evil.example.com/blog/promo-b2b", // foreign host dropped
        "http://www.toko-maju.id/insecure", // http dropped
        "/dashboard/toko-maju", // private dropped
        "/llms.txt", // speculative llms.txt dropped
        "/kendaraan?brand=toyota&year=2025", // multi-param faceted dropped
        "/produk?category=kopi&sort=price", // multi-param faceted dropped
      ]);

      expect(urls).toEqual([
        "https://www.toko-maju.id/blog/promo-b2b",
        "https://www.toko-maju.id/produk/mesin-kopi",
      ]);

      const keyA = await buildIndexNowBatchIdempotencyKey({
        tenantId: "01JT095A",
        host: "www.toko-maju.id",
        urls: ["/produk/mesin-kopi", "/blog/promo-b2b"],
        dedupBucket: "bucket-1",
      });
      const keyB = await buildIndexNowBatchIdempotencyKey({
        tenantId: "01JT095A",
        host: "www.toko-maju.id",
        urls: [
          "https://www.toko-maju.id/blog/promo-b2b",
          "https://www.toko-maju.id/produk/mesin-kopi",
          "https://www.toko-maju.id/blog/promo-b2b",
        ],
        dedupBucket: "bucket-1",
      });
      expect(keyA).toBe(keyB);

      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const mockFetch: typeof fetch = async (input, init) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response("", { status: 202 });
      };

      const payload = buildIndexNowSubmissionPayload({
        host: "www.toko-maju.id",
        key,
        urls,
      });
      const result = await submitIndexNowBatch(payload, { fetchImpl: mockFetch });
      expect(result).toEqual({
        ok: true,
        status: 202,
        submittedCount: 2,
        host: "www.toko-maju.id",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(INDEXNOW_ENDPOINT);
      expect(calls[0]?.body).toEqual({
        host: "www.toko-maju.id",
        key,
        keyLocation: buildIndexNowKeyLocation("www.toko-maju.id", key),
        urlList: [
          "https://www.toko-maju.id/blog/promo-b2b",
          "https://www.toko-maju.id/produk/mesin-kopi",
        ],
      });
    });
  });

  describe("4. AI Assistant Traffic & Lead Attribution (Strict Hostname Matching)", () => {
    it("classifies all documented AI Assistant referrers and utm_medium=ai-assistant into ai_assistant", () => {
      expect(AI_ASSISTANT_HOSTS).toEqual([
        "chatgpt.com",
        "chat.openai.com",
        "claude.ai",
        "perplexity.ai",
        "gemini.google.com",
        "copilot.microsoft.com",
      ]);

      const aiCases = [
        { referrer: "https://chatgpt.com/c/67890", expectedProvider: "chatgpt" },
        { referrer: "https://chat.openai.com/", expectedProvider: "chatgpt" },
        { referrer: "https://claude.ai/chat/abc", expectedProvider: "claude" },
        { referrer: "https://www.perplexity.ai/search/jasa-kontraktor", expectedProvider: "perplexity" },
        { referrer: "https://gemini.google.com/app", expectedProvider: "gemini" },
        { referrer: "https://copilot.microsoft.com/chats/123", expectedProvider: "copilot" },
      ] as const;

      for (const tc of aiCases) {
        const res = classifyTrafficAttribution({ referrer: tc.referrer });
        expect(res.channel).toBe("ai_assistant");
        expect(res.label).toBe("AI Assistant");
        expect(res.hourlySourceBucket).toBe("ai_assistant");
        expect(res.eventSourceCategory).toBe("ai_assistant");
        expect(res.matchedAssistant).toBe(tc.expectedProvider);
      }

      // Case-insensitive utm_medium=ai-assistant (both param key and value!) without referrer
      const utmCase = classifyAttributionFromUrlAndReferrer({
        landingUrl: "https://www.toko-maju.id/layanan?utm_medium=AI-ASSISTANT&utm_source=custom_bot",
        referrer: "",
      });
      expect(utmCase.channel).toBe("ai_assistant");
      expect(utmCase.matchedAssistant).toBe("utm");

      const mixedCaseKeyAndVal = classifyAttributionFromUrlAndReferrer({
        landingUrl: "https://www.toko-maju.id/layanan?UTM_MEDIUM=AI-Assistant",
        referrer: "",
      });
      expect(mixedCaseKeyAndVal.channel).toBe("ai_assistant");
      expect(mixedCaseKeyAndVal.utmMedium).toBe("ai-assistant");
      expect(mixedCaseKeyAndVal.matchedAssistant).toBe("utm");

      const directMixedMedium = classifyTrafficAttribution({
        utmMedium: "AI-Assistant",
      });
      expect(directMixedMedium.channel).toBe("ai_assistant");
      expect(directMixedMedium.matchedAssistant).toBe("utm");
    });

    it("rejects spoofed lookalike domains (evil-chatgpt.com, chatgpt.com.attacker.test) without false positives", () => {
      const spoofedHosts = [
        "https://evil-chatgpt.com/landing",
        "https://notclaude.ai/chat",
        "https://myperplexity.ai/search",
        "https://chatgpt.com.attacker.test/ref",
        "https://gemini.google.com.evil.org/app",
        "https://copilot.microsoft.com.phishing.net/",
      ];

      for (const ref of spoofedHosts) {
        const res = classifyTrafficAttribution({ referrer: ref });
        expect(res.channel).toBe("referral");
        expect(res.channel).not.toBe("ai_assistant");
        expect(res.matchedAssistant).toBeNull();
      }

      expect(matchesHostnameExactOrSubdomain("evil-chatgpt.com", "chatgpt.com")).toBe(false);
      expect(matchesHostnameExactOrSubdomain("sub.chatgpt.com", "chatgpt.com")).toBe(true);
      expect(extractNormalizedReferrerHost("javascript:alert(1)")).toBeNull();
    });

    it("classifies standard channels cleanly and drops same-site referrers", () => {
      expect(
        classifyTrafficAttribution({ referrer: "https://www.google.co.id/search?q=jasa" }).channel,
      ).toBe("organic_search");
      expect(
        classifyTrafficAttribution({ referrer: "https://www.bing.com/search?q=jasa" }).channel,
      ).toBe("organic_search");
      expect(
        classifyTrafficAttribution({ referrer: "https://l.instagram.com/" }).channel,
      ).toBe("social");
      expect(
        classifyTrafficAttribution({
          referrer: "https://www.google.com/",
          utmMedium: "cpc",
          utmSource: "google",
        }).channel,
      ).toBe("paid");
      expect(
        classifyTrafficAttribution({ referrer: "https://news.detik.com/artikel" }).channel,
      ).toBe("referral");
      expect(
        classifyTrafficAttribution({
          referrer: "https://www.toko-maju.id/produk",
          siteHost: "www.toko-maju.id",
        }).channel,
      ).toBe("direct");

      const summary = buildChannelAttributionSummary([
        { channel: "ai_assistant", visits: 18, waClicks: 5, leads: 2 },
        { channel: "organic_search", visits: 60, waClicks: 10, leads: 5 },
      ]);
      const aiRow = summary.find((r) => r.channel === "ai_assistant");
      expect(aiRow).toEqual({
        channel: "ai_assistant",
        label: "AI Assistant",
        visits: 18,
        waClicks: 5,
        leads: 2,
        totalSignals: 25,
        sharePercent: 25,
      });
    });
  });

  describe("5. Production Worker Queue & Cron Wiring", () => {
    it("registers both seo.indexnow_ping and seo.indexnow_flush in WORKER_JOB_REGISTRY and single authoritative cron definition", () => {
      const seoRegistry = createSeoJobRegistry();
      expect(typeof seoRegistry[SEO_INDEXNOW_PING_TOPIC]?.execute).toBe("function");
      expect(typeof seoRegistry[SEO_INDEXNOW_FLUSH_TOPIC]?.execute).toBe("function");

      // Single authoritative cron definition shared between cron/scheduler.ts and queues/seo/index.ts
      expect(SEO_CRON_JOB_DEFINITIONS).toEqual([SEO_INDEXNOW_CRON_JOB_DEFINITION]);
      expect(DEFAULT_CRON_JOB_DEFINITIONS).toContain(SEO_INDEXNOW_CRON_JOB_DEFINITION);
      expect(SEO_INDEXNOW_CRON_JOB_DEFINITION.topic).toBe(SEO_INDEXNOW_FLUSH_TOPIC);

      // Verify production Worker entrypoint spreads createSeoJobRegistry() into WORKER_JOB_REGISTRY
      const workerEntryPath = path.resolve(
        import.meta.dirname,
        "../../apps/web/src/worker/index.ts",
      );
      const workerSource = fs.readFileSync(workerEntryPath, "utf8");
      expect(workerSource).toContain('import { createSeoJobRegistry } from "./queues/seo/index.ts"');
      expect(workerSource).toMatch(/WORKER_JOB_REGISTRY[\s\S]*\.\.\.createSeoJobRegistry\(\)/);
    });
  });
});

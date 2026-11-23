import fs from "node:fs";
import path from "node:path";
import {
  ARRIVAL_SOURCE_SESSION_KEY,
  classifyInsightSource,
  formatIndonesianTimezoneBadge,
  formatUtcDayAndHour,
  inferInsightContentKind,
  INSIGHTS_ESTIMATE_LABEL_ID,
  isBotUserAgent,
  isLikelyIdentifierOrHashToken,
  normalizeHostForSameSiteComparison,
  projectUtcDayHourToTimezone,
  projectUtcHourlyRowsToTimezone,
  resolveTabArrivalSource,
  sanitizeBareReferrerHost,
  sanitizeInsightUtmToken,
  type ArrivalSessionStorageLike,
  type StoredUtcHourRow,
} from "@punyasitus/core/analytics/insights";
import {
  aggregateInsightsRows,
  INSIGHTS_AGGREGATES_MIGRATION,
  INSIGHTS_AGGREGATES_MIGRATION_SQL,
  validateFirstPartyEventPayload,
} from "@punyasitus/db/analytics/index";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

function createMemorySessionStorage(): ArrivalSessionStorageLike & {
  readonly dump: () => Record<string, string>;
} {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

describe("TASK-072 Unit Tests — First-Party Insights: Sources, Bots, Timezone Projection & Privacy", () => {
  describe("1. Referrer & UTM source classification", () => {
    it("classifies search, social, UTM campaign, AI assistant, referral, and direct arrivals accurately", () => {
      expect(
        classifyInsightSource({
          referrer: "https://www.google.co.id/search?q=jasa+website+umkm",
          siteHost: "alpha-studio.situsku.click",
        }),
      ).toMatchObject({
        sourceBucket: "search",
        hourlySourceBucket: "organic_search",
        label: "Pencarian",
        referrerHost: "www.google.co.id",
        utmSource: "",
      });

      expect(
        classifyInsightSource({
          referrer: "https://l.instagram.com/?u=https%3A%2F%2Falpha-studio.situsku.click",
          siteHost: "alpha-studio.situsku.click",
        }),
      ).toMatchObject({
        sourceBucket: "social",
        hourlySourceBucket: "social",
        label: "Media Sosial",
        referrerHost: "l.instagram.com",
      });

      expect(
        classifyInsightSource({
          referrerHost: "www.google.com",
          utmSource: "Promo_Ramadan-2026",
          utmMedium: "cpc",
          siteHost: "alpha-studio.situsku.click",
        }),
      ).toMatchObject({
        sourceBucket: "campaign",
        hourlySourceBucket: "campaign",
        label: "Kampanye",
        utmSource: "promo_ramadan-2026",
      });

      expect(
        classifyInsightSource({
          referrer: "https://chatgpt.com/c/abc123",
          siteHost: "alpha-studio.situsku.click",
        }),
      ).toMatchObject({
        sourceBucket: "ai_assistant",
        hourlySourceBucket: "ai_assistant",
        label: "AI Assistant",
      });

      expect(
        classifyInsightSource({
          referrer: "https://portal-umkm.id/artikel/daftar-vendor",
          siteHost: "alpha-studio.situsku.click",
        }),
      ).toMatchObject({
        sourceBucket: "referral",
        hourlySourceBucket: "referral",
        label: "Rujukan",
        referrerHost: "portal-umkm.id",
      });

      expect(
        classifyInsightSource({
          referrer: "",
          siteHost: "alpha-studio.situsku.click",
        }),
      ).toMatchObject({
        sourceBucket: "direct",
        hourlySourceBucket: "direct",
        label: "Langsung / Tidak Diketahui",
        referrerHost: null,
        utmSource: "",
      });
    });

    it("strips same-site referrers (including www. & multi-host pairs) and never false-matches lookalike hostnames", () => {
      const sameSite = classifyInsightSource({
        referrer: "https://alpha-studio.situsku.click/layanan/seo",
        siteHost: "alpha-studio.situsku.click",
      });
      expect(sameSite.sourceBucket).toBe("direct");
      expect(sameSite.referrerHost).toBeNull();

      // www. <-> apex same-site normalization
      expect(normalizeHostForSameSiteComparison("www.tokokopi.id")).toBe("tokokopi.id");
      const wwwToApex = classifyInsightSource({
        referrer: "https://www.tokokopi.id/produk/arabika",
        siteHost: "tokokopi.id",
      });
      expect(wwwToApex.sourceBucket).toBe("direct");
      expect(wwwToApex.referrerHost).toBeNull();

      // Multi-host tenant (subdomain + custom domain)
      const subToCustom = classifyInsightSource({
        referrer: "https://alpha-studio.situsku.click/kontak",
        siteHost: "www.tokokopi.id",
        siteHosts: ["alpha-studio.situsku.click", "tokokopi.id"],
      });
      expect(subToCustom.sourceBucket).toBe("direct");
      expect(subToCustom.referrerHost).toBeNull();

      const lookalike = classifyInsightSource({
        referrerHost: "notgoogle.example.test",
        siteHost: "alpha-studio.situsku.click",
      });
      expect(lookalike.sourceBucket).toBe("referral");
    });

    it("strips visitor-ID & hash tokens in utm_source while preserving coarse campaign bucket and legitimate campaign names", () => {
      // Legitimate campaign tokens preserved
      for (const good of ["promo_lebaran", "ig_q4_2026", "google_ads", "promo_ramadan-2026", "newsletter"]) {
        expect(isLikelyIdentifierOrHashToken(good), good).toBe(false);
        expect(sanitizeInsightUtmToken(good), good).toBe(good);
      }

      // Personalized visitor IDs / hashes / UUIDs stripped to "" while preserving `campaign` bucket
      for (const idToken of [
        "u8f3a9c12b4e",
        "sub-48213",
        "550e8400-e29b-41d4-a716-446655440000",
        "deadbeef1234",
        "usr_987654",
      ]) {
        expect(isLikelyIdentifierOrHashToken(idToken), idToken).toBe(true);
        expect(sanitizeInsightUtmToken(idToken), idToken).toBeNull();

        const classified = classifyInsightSource({
          utmSource: idToken,
          siteHost: "alpha-studio.situsku.click",
        });
        expect(classified.sourceBucket, idToken).toBe("campaign");
        expect(classified.utmSource, idToken).toBe("");

        const tabStorage = createMemorySessionStorage();
        const arrival = resolveTabArrivalSource({
          locationHref: `https://alpha-studio.situsku.click/?utm_source=${idToken}`,
          documentReferrer: "",
          siteHost: "alpha-studio.situsku.click",
          storage: tabStorage,
        });
        expect(arrival.sourceCategory, idToken).toBe("campaign");
        expect(arrival.utmSource, idToken).toBeUndefined();
        expect(tabStorage.dump()[ARRIVAL_SOURCE_SESSION_KEY]).not.toContain(idToken);

        const validated = validateFirstPartyEventPayload({
          eventName: "page_view",
          path: "/",
          utmSource: idToken,
        });
        expect(validated.ok, idToken).toBe(true);
        if (validated.ok) {
          expect(validated.data.sourceCategory).toBe("campaign");
          expect(validated.data.utmSource).toBeUndefined();
        }
      }
    });

    it("preserves external arrival source in sessionStorage across same-site navigation and writes zero storage on plain direct visits", () => {
      // Plain direct visit writes ZERO sessionStorage entries
      const directStorage = createMemorySessionStorage();
      const directRes = resolveTabArrivalSource({
        locationHref: "https://alpha-studio.situsku.click/",
        documentReferrer: "",
        siteHost: "alpha-studio.situsku.click",
        storage: directStorage,
      });
      expect(directRes).toEqual({ sourceCategory: "direct" });
      expect(directStorage.dump()).toEqual({});

      // External search arrival -> saved to sessionStorage -> preserved on later same-site navigation
      const searchStorage = createMemorySessionStorage();
      const firstHit = resolveTabArrivalSource({
        locationHref: "https://alpha-studio.situsku.click/",
        documentReferrer: "https://www.google.com/search?q=toko+kopi",
        siteHost: "alpha-studio.situsku.click",
        storage: searchStorage,
      });
      expect(firstHit).toEqual({
        sourceCategory: "search",
        referrerHost: "www.google.com",
      });
      expect(searchStorage.dump()[ARRIVAL_SOURCE_SESSION_KEY]).toBeDefined();

      // Subsequent same-site click to /layanan/seo with same-site document.referrer
      const secondHit = resolveTabArrivalSource({
        locationHref: "https://alpha-studio.situsku.click/layanan/seo",
        documentReferrer: "https://alpha-studio.situsku.click/",
        siteHost: "alpha-studio.situsku.click",
        storage: searchStorage,
      });
      expect(secondHit).toEqual({
        sourceCategory: "search",
        referrerHost: "www.google.com",
      });

      // UTM campaign arrival -> preserved across internal page navigation
      const utmStorage = createMemorySessionStorage();
      const utmLanding = resolveTabArrivalSource({
        locationHref:
          "https://alpha-studio.situsku.click/produk/kopi?utm_source=ig_promo&utm_medium=cpc&fbclid=SHOULD_NOT_BE_STORED",
        documentReferrer: "",
        siteHost: "alpha-studio.situsku.click",
        storage: utmStorage,
      });
      expect(utmLanding).toEqual({
        sourceCategory: "campaign",
        utmSource: "ig_promo",
        utmMedium: "cpc",
      });
      // Confirm raw fbclid / query string is never persisted in sessionStorage
      expect(utmStorage.dump()[ARRIVAL_SOURCE_SESSION_KEY]).not.toContain("fbclid");
      expect(utmStorage.dump()[ARRIVAL_SOURCE_SESSION_KEY]).not.toContain("SHOULD_NOT_BE_STORED");

      const utmSecondPage = resolveTabArrivalSource({
        locationHref: "https://alpha-studio.situsku.click/kontak",
        documentReferrer: "https://alpha-studio.situsku.click/produk/kopi",
        siteHost: "alpha-studio.situsku.click",
        storage: utmStorage,
      });
      expect(utmSecondPage).toEqual({
        sourceCategory: "campaign",
        utmSource: "ig_promo",
        utmMedium: "cpc",
      });
    });
  });

  describe("2. Bot User-Agent filtering", () => {
    it("identifies crawlers, CLI fetchers, and headless scrapers as bots", () => {
      const botAgents = [
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
        "curl/8.5.0",
        "Wget/1.21.4",
        "python-requests/2.31.0",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
        "Mozilla/5.0 Playwright/1.49",
        "GPTBot/1.0",
        "OAI-SearchBot/1.0",
        "ClaudeBot/1.0",
        "PerplexityBot/1.0",
        "AhrefsBot/7.0",
        "SemrushBot/7~bl",
        "facebookexternalhit/1.1",
        "WhatsApp/2.23.20.0",
      ];
      for (const ua of botAgents) {
        expect(isBotUserAgent(ua), ua).toBe(true);
      }
    });

    it("allows ordinary desktop & mobile browsers and empty/missing UAs", () => {
      const humanAgents = [
        null,
        undefined,
        "",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.39 Mobile Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
      ];
      for (const ua of humanAgents) {
        expect(isBotUserAgent(ua), String(ua)).toBe(false);
      }
    });
  });

  describe("3. Dynamic UTC -> WIB / WITA / WIT timezone projection without row mutation", () => {
    it("re-projects stored UTC hour buckets across WIB (+7), WITA (+8), and WIT (+9) including midnight rollover", () => {
      // UTC 2026-11-23T02:00Z => 09:00 WIB, 10:00 WITA, 11:00 WIT
      expect(projectUtcDayHourToTimezone("2026-11-23", 2, "Asia/Jakarta")).toEqual({
        localDay: "2026-11-23",
        localHour: 9,
      });
      expect(projectUtcDayHourToTimezone("2026-11-23", 2, "Asia/Makassar")).toEqual({
        localDay: "2026-11-23",
        localHour: 10,
      });
      expect(projectUtcDayHourToTimezone("2026-11-23", 2, "Asia/Jayapura")).toEqual({
        localDay: "2026-11-23",
        localHour: 11,
      });

      // Midnight rollover: UTC 2026-11-22T17:00Z => 2026-11-23 00:00 WIB, 01:00 WITA, 02:00 WIT
      expect(projectUtcDayHourToTimezone("2026-11-22", 17, "Asia/Jakarta")).toEqual({
        localDay: "2026-11-23",
        localHour: 0,
      });
      expect(projectUtcDayHourToTimezone("2026-11-22", 17, "Asia/Makassar")).toEqual({
        localDay: "2026-11-23",
        localHour: 1,
      });
      expect(projectUtcDayHourToTimezone("2026-11-22", 17, "Asia/Jayapura")).toEqual({
        localDay: "2026-11-23",
        localHour: 2,
      });

      const immutableStoredRows: readonly StoredUtcHourRow[] = Object.freeze([
        Object.freeze({
          day_utc: "2026-11-23",
          utc_hour: 2,
          page_views: 15,
          wa_clicks: 5,
          external_clicks: 2,
          lead_submits: 1,
        }),
        Object.freeze({
          day_utc: "2026-11-22",
          utc_hour: 17,
          page_views: 4,
          wa_clicks: 1,
          external_clicks: 0,
          lead_submits: 0,
        }),
      ]);

      const wib = projectUtcHourlyRowsToTimezone(immutableStoredRows, {
        timeZone: "Asia/Jakarta",
        startLocalDay: "2026-11-17",
        endLocalDay: "2026-11-23",
      });
      const wita = projectUtcHourlyRowsToTimezone(immutableStoredRows, {
        timeZone: "Asia/Makassar",
        startLocalDay: "2026-11-17",
        endLocalDay: "2026-11-23",
      });
      const wit = projectUtcHourlyRowsToTimezone(immutableStoredRows, {
        timeZone: "Asia/Jayapura",
        startLocalDay: "2026-11-17",
        endLocalDay: "2026-11-23",
      });

      expect(wib.peakHour?.hour).toBe(9);
      expect(wib.peakHour?.label).toBe("09:00");
      expect(wib.hours[0]?.totalActivity).toBe(5);
      expect(wib.timeZoneLabel).toBe(formatIndonesianTimezoneBadge("Asia/Jakarta"));

      expect(wita.peakHour?.hour).toBe(10);
      expect(wita.peakHour?.label).toBe("10:00");
      expect(wita.hours[1]?.totalActivity).toBe(5);

      expect(wit.peakHour?.hour).toBe(11);
      expect(wit.peakHour?.label).toBe("11:00");
      expect(wit.hours[2]?.totalActivity).toBe(5);

      // Stored rows remained untouched (frozen & identical)
      expect(immutableStoredRows[0]?.utc_hour).toBe(2);
      expect(immutableStoredRows[1]?.utc_hour).toBe(17);

      const utcParts = formatUtcDayAndHour(Date.UTC(2026, 10, 23, 2, 45, 0));
      expect(utcParts).toEqual({
        dayUtc: "2026-11-23",
        utcHour: 2,
        hourBucketUtc: "2026-11-23T02",
      });
    });

    it("infers content kinds and aggregates popular items, sources, UTM campaigns, and estimate notice", () => {
      expect(inferInsightContentKind({ path: "/" })).toBe("page");
      expect(inferInsightContentKind({ path: "/blog/tips-seo" })).toBe("post");
      expect(inferInsightContentKind({ path: "/layanan/konsultasi" })).toBe("offering");
      expect(inferInsightContentKind({ path: "/produk/kopi-arabika" })).toBe("offering");
      expect(inferInsightContentKind({ path: "/blog" })).toBe("taxonomy");

      const summary = aggregateInsightsRows({
        contentRows: [
          {
            day_utc: "2026-11-23",
            content_kind: "offering",
            content_id: 100,
            path: "/layanan/konsultasi-seo",
            page_views: 30,
            wa_clicks: 8,
            external_clicks: 2,
            lead_submits: 2,
          },
          {
            day_utc: "2026-11-23",
            content_kind: "post",
            content_id: 10,
            path: "/blog/panduan-umkm",
            page_views: 20,
            wa_clicks: 1,
            external_clicks: 0,
            lead_submits: 0,
          },
        ],
        sourceRows: [
          {
            day_utc: "2026-11-23",
            source_bucket: "search",
            utm_source: "",
            page_views: 30,
            wa_clicks: 6,
            external_clicks: 1,
            lead_submits: 1,
          },
          {
            day_utc: "2026-11-23",
            source_bucket: "campaign",
            utm_source: "promo_ramadan",
            page_views: 20,
            wa_clicks: 3,
            external_clicks: 1,
            lead_submits: 1,
          },
        ],
        hourlyRows: [
          {
            day_utc: "2026-11-23",
            utc_hour: 3,
            page_views: 50,
            wa_clicks: 9,
            external_clicks: 2,
            lead_submits: 2,
          },
        ],
        days: 7,
        nowMs: Date.UTC(2026, 10, 23, 5, 0, 0),
        timeZone: "Asia/Jakarta",
      });

      expect(summary.hasAnyData).toBe(true);
      expect(summary.estimateLabel).toBe(INSIGHTS_ESTIMATE_LABEL_ID);
      expect(summary.popularItems[0]?.path).toBe("/layanan/konsultasi-seo");
      expect(summary.popularItems[0]?.totalActivity).toBe(42);
      expect(summary.utmCampaigns).toEqual([
        {
          utmSource: "promo_ramadan",
          pageViews: 20,
          waClicks: 3,
          externalClicks: 1,
          leadSubmits: 1,
          totalActivity: 25,
        },
      ]);
      expect(summary.peakHours.peakHour?.label).toBe("10:00");
    });

    it("enforces exact 7-day UTC window on popular items & sources (excluding startDay-1 and endDay+1) while honoring UTC->local rollover for peak hours", () => {
      // nowMs: 2026-11-23 12:00 WIB -> exact 7-day window is 2026-11-17 .. 2026-11-23
      const nowMs = Date.UTC(2026, 10, 23, 5, 0, 0);
      const summary = aggregateInsightsRows({
        contentRows: [
          // Outside window: startDay - 1 (2026-11-16) -> MUST be excluded!
          {
            day_utc: "2026-11-16",
            content_kind: "page",
            content_id: 1,
            path: "/halaman-terlalu-lama",
            page_views: 99,
            wa_clicks: 10,
            external_clicks: 0,
            lead_submits: 0,
          },
          // Inside window: startDay (2026-11-17)
          {
            day_utc: "2026-11-17",
            content_kind: "offering",
            content_id: 100,
            path: "/layanan/dalam-rentang",
            page_views: 10,
            wa_clicks: 2,
            external_clicks: 0,
            lead_submits: 0,
          },
          // Outside window: endDay + 1 (2026-11-24) -> MUST be excluded!
          {
            day_utc: "2026-11-24",
            content_kind: "page",
            content_id: 2,
            path: "/halaman-masa-depan",
            page_views: 88,
            wa_clicks: 5,
            external_clicks: 0,
            lead_submits: 0,
          },
        ],
        sourceRows: [
          {
            day_utc: "2026-11-16",
            source_bucket: "referral",
            utm_source: "",
            page_views: 99,
            wa_clicks: 0,
            external_clicks: 0,
            lead_submits: 0,
          },
          {
            day_utc: "2026-11-17",
            source_bucket: "search",
            utm_source: "",
            page_views: 10,
            wa_clicks: 2,
            external_clicks: 0,
            lead_submits: 0,
          },
          {
            day_utc: "2026-11-24",
            source_bucket: "social",
            utm_source: "",
            page_views: 88,
            wa_clicks: 0,
            external_clicks: 0,
            lead_submits: 0,
          },
        ],
        hourlyRows: [
          // 2026-11-16T17:00Z rolls over to 2026-11-17 00:00 WIB -> MUST be included in peakHours!
          {
            day_utc: "2026-11-16",
            utc_hour: 17,
            page_views: 7,
            wa_clicks: 1,
            external_clicks: 0,
            lead_submits: 0,
          },
          // 2026-11-16T16:00Z is 2026-11-16 23:00 WIB -> outside [2026-11-17, 2026-11-23], MUST be excluded!
          {
            day_utc: "2026-11-16",
            utc_hour: 16,
            page_views: 50,
            wa_clicks: 0,
            external_clicks: 0,
            lead_submits: 0,
          },
        ],
        days: 7,
        nowMs,
        timeZone: "Asia/Jakarta",
      });

      expect(summary.startDay).toBe("2026-11-17");
      expect(summary.endDay).toBe("2026-11-23");
      expect(summary.popularItems.map((i) => i.path)).toEqual(["/layanan/dalam-rentang"]);
      expect(summary.totals.pageViews).toBe(10);
      const srcMap = Object.fromEntries(summary.sources.map((s) => [s.bucket, s.totalActivity]));
      expect(srcMap.search).toBe(12);
      expect(srcMap.referral).toBe(0);
      expect(srcMap.social).toBe(0);
      // Rollover hour (00:00 WIB on 2026-11-17) included, 23:00 WIB on 2026-11-16 excluded!
      expect(summary.peakHours.hours[0]?.totalActivity).toBe(8);
      expect(summary.peakHours.hours[23]?.totalActivity).toBe(0);
    });
  });

  describe("4. Strict zero-PII validation & migration 0022 parity", () => {
    it("rejects PII, raw query strings, full URLs, and visitor identifiers in event payloads", () => {
      expect(sanitizeBareReferrerHost("https://google.com/search?q=x")).toBeNull();
      expect(sanitizeBareReferrerHost("google.com/path")).toBeNull();
      expect(sanitizeBareReferrerHost("budi@example.com")).toBeNull();
      expect(sanitizeBareReferrerHost("www.google.co.id")).toBe("www.google.co.id");

      expect(sanitizeInsightUtmToken("budi@example.com")).toBeNull();
      expect(sanitizeInsightUtmToken("081234567890")).toBeNull();
      expect(sanitizeInsightUtmToken("a=b&c=d")).toBeNull();
      expect(sanitizeInsightUtmToken("promo_ramadan")).toBe("promo_ramadan");

      const hostilePayloads: Record<string, unknown>[] = [
        { eventName: "page_view", path: "/", referrerHost: "https://google.com/search?q=secret" },
        { eventName: "page_view", path: "/", utmSource: "user@example.test" },
        { eventName: "page_view", path: "/", utmSource: "081234567890" },
        { eventName: "page_view", path: "/", visitorId: "vis-123" },
        { eventName: "page_view", path: "/", sessionId: "sess-123" },
        { eventName: "page_view", path: "/", cookie: "a=1" },
        { eventName: "page_view", path: "/", userAgent: "Mozilla/5.0" },
        { eventName: "page_view", path: "/", ip: "203.0.113.5" },
      ];
      for (const payload of hostilePayloads) {
        const res = validateFirstPartyEventPayload(payload);
        expect(res.ok, JSON.stringify(payload)).toBe(false);
        if (!res.ok) {
          expect(res.status).toBe(422);
        }
      }
    });

    it("keeps 0022_insights_aggregates.sql byte-for-byte identical, PII-free, and dashboard free of Radix/Sparkles", () => {
      const sqlOnDisk = fs.readFileSync(
        path.join(ROOT, "packages/db/migrations/tenant/0022_insights_aggregates.sql"),
        "utf8",
      );
      expect(INSIGHTS_AGGREGATES_MIGRATION.version).toBe(22);
      expect(INSIGHTS_AGGREGATES_MIGRATION.name).toBe("0022_insights_aggregates");
      expect(INSIGHTS_AGGREGATES_MIGRATION_SQL).toBe(sqlOnDisk);

      // Verify zero PII or visitor identifier columns exist in DDL statements of migration 0022
      const ddlOnlyLower = sqlOnDisk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .toLowerCase();
      for (const forbiddenCol of [
        "ip_address",
        "client_ip",
        "user_agent",
        "visitor_id",
        "session_id",
        "cookie",
        "email",
        "phone",
        "referrer_url",
        "query_string",
      ]) {
        expect(ddlOnlyLower, `forbidden column ${forbiddenCol}`).not.toContain(forbiddenCol);
      }

      // Verify base-nova compliance on modified/created dashboard files
      for (const rel of [
        "apps/web/src/pages/dashboard/[handle]/index.astro",
        "apps/web/src/pages/dashboard/[handle]/insights/index.astro",
        "apps/web/src/pages/dashboard/[handle]/insights/_loader.ts",
        "apps/web/src/pages/dashboard/[handle]/insights/api.ts",
      ]) {
        const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
        expect(src, `${rel} must not use @radix-ui`).not.toContain("@radix-ui");
        expect(src, `${rel} must not use asChild`).not.toContain("asChild");
        expect(src, `${rel} must not use Sparkles`).not.toContain("Sparkles");
      }
    });
  });
});

import fs from "node:fs";
import path from "node:path";
import {
  ANALYTICS_EVENT_DEDUP_TTL_MS,
  buildAnalyticsHeadBootstrapPayload,
  createAnalyticsSignalDispatcher,
  createClientEventDedupStore,
  createCtaClickActionGuard,
  deriveDeterministicLeadEventId,
  generateAnalyticsEventId,
  isValidAnalyticsUuid,
  normalizeAnalyticsEventIdToUuid,
  normalizeTenantDedupScope,
  sanitizeAnalyticsSignalPayload,
  sanitizeClientEventId,
  type AnalyticsFirstPartyAdapter,
  type AnalyticsGtmAdapter,
  type AnalyticsProviderAdapter,
  type ClientDedupStorageLike,
  type FirstPartyEventPayload,
  type PsDataLayerEventPayload,
} from "@punyasitus/core/analytics/config";
import {
  ANALYTICS_EVENT_DEDUP_MIGRATION,
  ANALYTICS_EVENT_DEDUP_MIGRATION_SQL,
  buildAnalyticsEventDedupKey,
  DEFAULT_EVENT_DEDUP_TTL_MS,
  validateFirstPartyEventPayload,
} from "@punyasitus/db/analytics/index";
import { describe, expect, it } from "vitest";
import { createBrowserFirstPartyAdapter } from "../../apps/web/src/scripts/analytics.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function createMemoryStorage(): ClientDedupStorageLike & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

describe("TASK-065 Unit Tests — Analytics Event Dedup, UUID Parity, 24h Expiry & PII Protection", () => {
  describe("1. Strict RFC 4122 event_id generation, deterministic lead IDs & PII rejection", () => {
    it("generates valid RFC 4122 UUIDs and deterministic tenant-scoped lead UUIDs", () => {
      const id1 = generateAnalyticsEventId();
      const id2 = generateAnalyticsEventId();
      expect(isValidAnalyticsUuid(id1)).toBe(true);
      expect(isValidAnalyticsUuid(id2)).toBe(true);
      expect(id1).not.toBe(id2);

      const leadA1 = deriveDeterministicLeadEventId("42", "alpha-studio.situsku.click");
      const leadA2 = deriveDeterministicLeadEventId("42", "ALPHA-STUDIO.SITUSKU.CLICK");
      const leadB1 = deriveDeterministicLeadEventId("42", "beta-clinic.situsku.click");
      const leadA43 = deriveDeterministicLeadEventId("43", "alpha-studio.situsku.click");

      expect(isValidAnalyticsUuid(leadA1)).toBe(true);
      expect(leadA1).toBe(leadA2);
      expect(leadA1).not.toBe(leadB1);
      expect(leadA1).not.toBe(leadA43);
    });

    it("rejects PII, query strings, URLs, XSS, and oversized values inside eventId on both server and client", () => {
      const badIds = [
        "",
        "   ",
        "budi@example.com",
        "081234567890",
        "+6281234567890",
        "Budi Santoso",
        "evt_1?utm_source=ig",
        "evt_1&fbclid=abc",
        "evt_1#hash",
        "https://evil.example/track",
        "<script>alert(1)</script>",
        "a".repeat(80),
        "not-a-uuid-at-all",
      ];

      for (const badId of badIds) {
        const serverCheck = validateFirstPartyEventPayload({
          eventId: badId,
          eventName: "wa_click",
          path: "/layanan",
        });
        expect(serverCheck.ok, `server should reject eventId=${badId}`).toBe(false);
        if (!serverCheck.ok) {
          expect(serverCheck.status).toBe(422);
          expect(serverCheck.code).toBe("INVALID_EVENT_ID");
        }
      }

      // Client sanitizer drops PII/query/XSS event_ids while allowing UUIDs (incl. digit-heavy segments) & bounded safe tokens
      expect(sanitizeClientEventId("11111111-1111-4111-8111-111111111111")).toBe(
        "11111111-1111-4111-8111-111111111111",
      );
      expect(sanitizeClientEventId("136eb99f-6914-4500-bc80-bec158e52b88")).toBe(
        "136eb99f-6914-4500-bc80-bec158e52b88",
      );
      expect(sanitizeClientEventId("evt_001")).toBe("evt_001");
      expect(sanitizeClientEventId("budi@example.com")).toBeNull();
      expect(sanitizeClientEventId("081234567890")).toBeNull();
      expect(sanitizeClientEventId("evt_1?foo=bar")).toBeNull();
      expect(sanitizeClientEventId("<script>x</script>")).toBeNull();
      expect(sanitizeClientEventId("Budi Santoso")).toBeNull();
      expect(sanitizeClientEventId("x".repeat(65))).toBeNull();

      // sanitizeAnalyticsSignalPayload strips hostile event_id rather than forwarding it
      const sanitized = sanitizeAnalyticsSignalPayload({
        event_id: "budi@example.com?phone=081234567890",
        page_path: "/kontak",
      });
      expect(sanitized.event_id).toBeUndefined();
      expect(sanitized.page_path).toBe("/kontak");

      // buildAnalyticsEventDedupKey normalizes UUIDs and rejects non-UUIDs
      expect(buildAnalyticsEventDedupKey("11111111-1111-4111-8111-11111111111A")).toBe(
        "evt:11111111-1111-4111-8111-11111111111a",
      );
      expect(() => buildAnalyticsEventDedupKey("budi@example.com")).toThrow(/INVALID_EVENT_ID/);
    });
  });

  describe("2. Tenant-scoped 24h ClientEventDedupStore & CTA double-click guard", () => {
    it("enforces exact 24h TTL expiry, tenant isolation, bounded cardinality, and reload persistence", () => {
      expect(ANALYTICS_EVENT_DEDUP_TTL_MS).toBe(86_400_000);
      expect(DEFAULT_EVENT_DEDUP_TTL_MS).toBe(86_400_000);

      const storage = createMemoryStorage();
      const t0 = 1_763_900_000_000;

      const storeA = createClientEventDedupStore({
        tenantScope: "alpha-studio.situsku.click",
        ttlMs: ANALYTICS_EVENT_DEDUP_TTL_MS,
        maxEntries: 5,
        storage,
      });
      const storeB = createClientEventDedupStore({
        tenantScope: "beta-clinic.situsku.click",
        ttlMs: ANALYTICS_EVENT_DEDUP_TTL_MS,
        maxEntries: 5,
        storage,
      });

      // Claim in Tenant A -> duplicate within 24h, isolated from Tenant B
      expect(storeA.claim("evt:u1", t0)).toBe(true);
      expect(storeA.claim("evt:u1", t0 + 1_000)).toBe(false);
      expect(storeA.has("evt:u1", t0 + ANALYTICS_EVENT_DEDUP_TTL_MS - 1)).toBe(true);
      expect(storeB.has("evt:u1", t0 + 1_000)).toBe(false);
      expect(storeB.claim("evt:u1", t0 + 1_000)).toBe(true);

      // Simulate full page reload with a fresh store instance reading same storage
      const storeAReloaded = createClientEventDedupStore({
        tenantScope: "alpha-studio.situsku.click",
        ttlMs: ANALYTICS_EVENT_DEDUP_TTL_MS,
        maxEntries: 5,
        storage,
      });
      expect(storeAReloaded.has("evt:u1", t0 + 60_000)).toBe(true);
      expect(storeAReloaded.claim("evt:u1", t0 + 60_000)).toBe(false);

      // At exact 24h expiry -> expired entry pruned and key can be claimed again
      expect(storeAReloaded.has("evt:u1", t0 + ANALYTICS_EVENT_DEDUP_TTL_MS)).toBe(false);
      expect(storeAReloaded.claim("evt:u1", t0 + ANALYTICS_EVENT_DEDUP_TTL_MS)).toBe(true);

      // Bounded cardinality: claiming 8 entries with maxEntries=5 evicts oldest 3
      for (let i = 1; i <= 8; i += 1) {
        storeA.claim(`evt:cap-${i}`, t0 + i * 1_000);
      }
      expect(storeA.size(t0 + 9_000)).toBeLessThanOrEqual(5);
      expect(storeA.has("evt:cap-8", t0 + 9_000)).toBe(true);
    });

    it("degrades safely to in-memory dedup when browser storage throws QuotaExceededError", () => {
      const brokenStorage: ClientDedupStorageLike = {
        getItem: () => {
          throw new Error("SecurityError: storage disabled");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {
          throw new Error("SecurityError");
        },
      };

      const store = createClientEventDedupStore({
        tenantScope: "alpha.situsku.click",
        storage: brokenStorage,
      });
      expect(store.claim("evt:safe-1", 1000)).toBe(true);
      expect(store.claim("evt:safe-1", 2000)).toBe(false);
    });

    it("reuses the exact same event_id on rapid CTA double-click within window and allocates fresh ID afterward", () => {
      const guard = createCtaClickActionGuard(1_500);
      const t0 = 1_763_900_000_000;

      const click1 = guard.resolveEventId("wa:hero", { nowMs: t0 });
      const click2 = guard.resolveEventId("wa:hero", { nowMs: t0 + 400 });
      const otherCta = guard.resolveEventId("wa:footer", { nowMs: t0 + 450 });
      const laterClick = guard.resolveEventId("wa:hero", { nowMs: t0 + 1_600 });

      expect(isValidAnalyticsUuid(click1)).toBe(true);
      expect(click2).toBe(click1);
      expect(otherCta).not.toBe(click1);
      expect(laterClick).not.toBe(click1);

      // Explicit valid UUID honored; hostile PII explicit ID ignored
      const explicitUuid = "22222222-2222-4222-8222-222222222222";
      expect(guard.resolveEventId("wa:hero", { explicitEventId: explicitUuid, nowMs: t0 })).toBe(
        explicitUuid,
      );
      const safeFallback = guard.resolveEventId("wa:other", {
        explicitEventId: "budi@example.com?x=1",
        nowMs: t0,
      });
      expect(isValidAnalyticsUuid(safeFallback)).toBe(true);
    });

    it("normalizes tenantScope cleanly without leaking query strings or PII", () => {
      expect(normalizeTenantDedupScope("Alpha-Studio.Situsku.Click")).toBe(
        "alpha-studio.situsku.click",
      );
      expect(normalizeTenantDedupScope("alpha.situsku.click/path?email=a@b.com")).toBe(
        "alpha.situsku.click",
      );
      expect(normalizeTenantDedupScope("budi@example.com")).toBe("default");
    });
  });

  describe("3. Cross-channel event_id parity, zero double-dispatch & fault isolation", () => {
    it("aligns one identical UUID across first-party /api/events, direct Meta, and GTM dataLayer without double-firing GTM-routed vendors", () => {
      let currentNow = 1_763_900_000_000;
      const storage = createMemoryStorage();
      const firstPartyHits: FirstPartyEventPayload[] = [];
      const directHits: Array<{ provider: string; eventName: string; eventId: string }> = [];
      const gtmHits: PsDataLayerEventPayload[] = [];

      const adapter: AnalyticsProviderAdapter = {
        loadProvider: () => {},
        sendEvent: (provider, _id, eventName, _params, meta) => {
          directHits.push({ provider, eventName, eventId: meta.eventId });
        },
      };
      const gtmAdapter: AnalyticsGtmAdapter = {
        initConsentDefault: () => {},
        updateConsentMode: () => {},
        loadGtm: () => {},
        pushDataLayerEvent: (ev) => gtmHits.push(ev),
      };
      const firstPartyAdapter: AnalyticsFirstPartyAdapter = {
        sendEvent: (payload) => firstPartyHits.push(payload),
      };

      const dispatcher = createAnalyticsSignalDispatcher({
        config: {
          ga4MeasurementId: "G-SUPPRESSED1",
          metaPixelId: "123456789012345",
          tiktokPixelId: "C1234567890ABCDEF",
        },
        adapter,
        gtm: {
          enabled: true,
          containerId: "GTM-ABC1234",
          vendorModes: { ga4: "gtm", meta: "direct", tiktok: "gtm" },
          pageType: "service",
          contentId: "srv-10",
        },
        gtmAdapter,
        firstPartyAdapter,
        tenantScope: "alpha-studio.situsku.click",
        dedupStorage: storage,
        now: () => currentNow,
        currentPath: () => "/layanan/konsultasi",
      });

      // Pre-consent: cookieless first-party page_view sent ONCE; ZERO direct/GTM events AND ZERO storage writes (REQ-039)!
      expect(firstPartyHits).toHaveLength(1);
      expect(firstPartyHits[0]?.eventName).toBe("page_view");
      expect(isValidAnalyticsUuid(firstPartyHits[0]?.eventId)).toBe(true);
      expect(directHits).toHaveLength(0);
      expect(gtmHits).toHaveLength(0);
      expect(storage.map.size).toBe(0);

      // Even dispatching an event pre-consent MUST keep browser storage completely untouched!
      dispatcher.dispatch("wa_click", { event_id: "pre_consent_tok" });
      expect(storage.map.size).toBe(0);
      expect(directHits).toHaveLength(0);
      expect(gtmHits).toHaveLength(0);

      const pageViewUuid = firstPartyHits[0]!.eventId;

      // Grant analytics + marketing consent -> GTM & direct Meta receive page_view with EXACT SAME UUID;
      // first-party is NOT duplicated; GA4 & TikTok (routed via GTM) NEVER fire directly!
      dispatcher.updateConsent({
        version: 1,
        analytics: true,
        marketing: true,
        hasDecision: true,
      });
      expect(firstPartyHits).toHaveLength(2);
      expect(storage.map.size).toBeGreaterThan(0);
      expect(directHits).toEqual([
        { provider: "meta", eventName: "PageView", eventId: pageViewUuid },
      ]);
      expect(gtmHits).toHaveLength(1);
      expect(gtmHits[0]?.event).toBe("ps_page_view");
      expect(gtmHits[0]?.event_id).toBe(pageViewUuid);

      // Dispatch wa_click with explicit UUID -> arrives ONCE across first-party, direct Meta, and GTM with IDENTICAL UUID
      const waUuid = "33333333-3333-4333-8333-333333333333";
      const firstWa = dispatcher.dispatch("wa_click", {
        event_id: waUuid,
        item_id: "srv-10",
        item_title: "Audit SEO UMKM",
        placement: "hero",
      });
      expect(firstWa.ok).toBe(true);
      expect(firstWa.deduplicated).toBe(false);
      expect(firstWa.firstPartySent).toBe(true);
      expect(firstWa.eventId).toBe(waUuid);
      expect(firstWa.deliveredTo).toEqual([
        { provider: "meta", providerEventName: "Contact", eventId: waUuid },
      ]);
      expect(firstWa.gtmEventPushed?.event).toBe("ps_wa_click");
      expect(firstWa.gtmEventPushed?.event_id).toBe(waUuid);
      expect(firstPartyHits[2]).toEqual({
        eventId: waUuid,
        eventName: "wa_click",
        path: "/layanan/konsultasi",
      });

      // Duplicate dispatch of the SAME event_id within 24h -> 0 extra calls to ANY channel!
      currentNow += 5_000;
      const dupWa = dispatcher.dispatch("wa_click", {
        event_id: waUuid,
        item_id: "srv-10",
        placement: "hero",
      });
      expect(dupWa.ok).toBe(true);
      expect(dupWa.deduplicated).toBe(true);
      expect(dupWa.deliveredTo).toHaveLength(0);
      expect(dupWa.gtmEventPushed).toBeNull();
      expect(dupWa.firstPartySent).toBe(false);
      expect(firstPartyHits).toHaveLength(3);
      expect(directHits).toHaveLength(2);
      expect(gtmHits).toHaveLength(2);

      // Replay AFTER 24h expiry -> accepted again cleanly
      currentNow += ANALYTICS_EVENT_DEDUP_TTL_MS;
      const afterExpiry = dispatcher.dispatch("wa_click", {
        event_id: waUuid,
        item_id: "srv-10",
        placement: "hero",
      });
      expect(afterExpiry.deduplicated).toBe(false);
      expect(afterExpiry.deliveredTo).toHaveLength(1);
      expect(afterExpiry.gtmEventPushed?.event_id).toBe(waUuid);
      expect(afterExpiry.firstPartySent).toBe(true);

      // Revoking consent clears persisted dedup storage cleanly
      dispatcher.updateConsent({
        version: 1,
        analytics: false,
        marketing: false,
        hasDecision: false,
      });
      expect(storage.map.size).toBe(0);
    });

    it("unconditionally skips first-party /api/events for lead_submitted and normalizes non-UUID tokens like 'abc_1' to one identical UUID across all channels", () => {
      const storage = createMemoryStorage();
      const firstPartyHits: FirstPartyEventPayload[] = [];
      const directHits: Array<{ provider: string; eventName: string; eventId: string }> = [];
      const gtmHits: PsDataLayerEventPayload[] = [];

      const dispatcher = createAnalyticsSignalDispatcher({
        config: {
          ga4MeasurementId: "G-DIRECT1234",
          metaPixelId: "123456789012345",
          tiktokPixelId: "C1234567890ABCDEF",
        },
        adapter: {
          loadProvider: () => {},
          sendEvent: (provider, _id, eventName, _params, meta) => {
            directHits.push({ provider, eventName, eventId: meta.eventId });
          },
        },
        gtm: {
          enabled: true,
          containerId: "GTM-ABC1234",
          vendorModes: { ga4: "direct", meta: "direct", tiktok: "direct" },
          pageType: "page",
          contentId: "p-1",
        },
        gtmAdapter: {
          initConsentDefault: () => {},
          updateConsentMode: () => {},
          loadGtm: () => {},
          pushDataLayerEvent: (ev) => gtmHits.push(ev),
        },
        firstPartyAdapter: {
          sendEvent: (payload) => firstPartyHits.push(payload),
        },
        tenantScope: "alpha-studio.situsku.click",
        dedupStorage: storage,
        initialConsent: { version: 1, analytics: true, marketing: true, hasDecision: true },
        autoPageView: false,
        currentPath: () => "/kontak",
      });

      // 1. Direct `dispatch("lead_submitted")` (e.g. via trackEvent or data-ps-analytics-event)
      //    MUST NEVER call first-party /api/events (POST /api/leads owns lead_submits counting!)
      const directLeadReport = dispatcher.dispatch("lead_submitted", {
        event_id: "lead_direct_tok_1",
        form_id: "contact_default",
      });
      expect(directLeadReport.ok).toBe(true);
      expect(directLeadReport.firstPartySent).toBe(false);
      expect(firstPartyHits).toHaveLength(0);
      expect(isValidAnalyticsUuid(directLeadReport.eventId)).toBe(true);
      expect(directLeadReport.deliveredTo).toHaveLength(3);
      expect(directLeadReport.gtmEventPushed?.event).toBe("ps_lead_submitted");
      expect(directLeadReport.gtmEventPushed?.event_id).toBe(directLeadReport.eventId);

      // 2. Non-UUID sanitized token `"abc_1"` deterministically normalizes to ONE valid RFC 4122 UUID
      //    shared identically across /api/events, GTM dataLayer, and direct GA4/Meta/TikTok!
      const expectedUuid = normalizeAnalyticsEventIdToUuid("abc_1", "alpha-studio.situsku.click");
      expect(isValidAnalyticsUuid(expectedUuid)).toBe(true);

      const tokReport = dispatcher.dispatch("wa_click", {
        event_id: "abc_1",
        placement: "hero",
      });
      expect(tokReport.ok).toBe(true);
      expect(tokReport.deduplicated).toBe(false);
      expect(tokReport.firstPartySent).toBe(true);
      expect(tokReport.eventId).toBe(expectedUuid);
      expect(firstPartyHits).toEqual([
        { eventId: expectedUuid, eventName: "wa_click", path: "/kontak" },
      ]);
      expect(tokReport.gtmEventPushed?.event_id).toBe(expectedUuid);
      expect(tokReport.deliveredTo.map((d) => d.eventId)).toEqual([
        expectedUuid,
        expectedUuid,
        expectedUuid,
      ]);

      // Repeating `"abc_1"` resolves to the same UUID and deduplicates across ALL channels
      const tokDup = dispatcher.dispatch("wa_click", { event_id: "abc_1" });
      expect(tokDup.deduplicated).toBe(true);
      expect(tokDup.eventId).toBe(expectedUuid);
      expect(tokDup.firstPartySent).toBe(false);
      expect(tokDup.deliveredTo).toHaveLength(0);
      expect(tokDup.gtmEventPushed).toBeNull();
      expect(firstPartyHits).toHaveLength(1);
    });

    it("isolates throwing firstPartyAdapter, browser fetch failures, and vendor errors without throwing", () => {
      const brokenFp = createBrowserFirstPartyAdapter("/api/events", () =>
        Promise.reject(new Error("Simulated offline network")),
      );
      expect(() =>
        brokenFp.sendEvent({
          eventId: "44444444-4444-4444-8444-444444444444",
          eventName: "wa_click",
          path: "/",
        }),
      ).not.toThrow();

      const dispatcher = createAnalyticsSignalDispatcher({
        config: { ga4MeasurementId: "G-TEST123456" },
        adapter: {
          loadProvider: () => {
            throw new Error("Blocked by adblocker");
          },
          sendEvent: () => {},
        },
        firstPartyAdapter: {
          sendEvent: () => {
            throw new Error("First-party endpoint down");
          },
        },
        initialConsent: { version: 1, analytics: true, marketing: true, hasDecision: true },
        autoPageView: false,
      });

      const report = dispatcher.dispatch("wa_click", { page_path: "/" });
      expect(report.ok).toBe(false);
      expect(report.errors.map((e) => e.provider)).toEqual(["first_party", "ga4"]);
    });

    it("preserves buildAnalyticsHeadBootstrapPayload null-gate while supporting tenantScope and dedupTtlMs", () => {
      expect(
        buildAnalyticsHeadBootstrapPayload({
          config: null,
          surface: "tenant",
        }),
      ).toBeNull();

      const payload = buildAnalyticsHeadBootstrapPayload({
        config: { ga4MeasurementId: "G-AB12CD34EF" },
        surface: "tenant",
        tenantScope: "alpha-studio.situsku.click",
      });
      expect(payload).not.toBeNull();
      expect(payload?.tenantScope).toBe("alpha-studio.situsku.click");
      expect(payload?.firstPartyEndpoint).toBe("/api/events");
      expect(payload?.dedupTtlMs).toBe(ANALYTICS_EVENT_DEDUP_TTL_MS);
    });
  });

  describe("4. Migration 0018 parity & static security guards", () => {
    it("keeps 0018_analytics_event_dedup.sql byte-for-byte identical to bundled descriptor and forbids runtime DDL in handlers", () => {
      const sqlFile = path.join(
        REPO_ROOT,
        "packages/db/migrations/tenant/0018_analytics_event_dedup.sql",
      );
      expect(fs.existsSync(sqlFile)).toBe(true);
      const diskSql = fs.readFileSync(sqlFile, "utf8");
      expect(diskSql).toBe(ANALYTICS_EVENT_DEDUP_MIGRATION_SQL);
      expect(diskSql).toBe(ANALYTICS_EVENT_DEDUP_MIGRATION.sql);
      expect(diskSql).toContain("analytics_event_dedup_expires_idx");
      expect(diskSql).not.toContain("analytics_event_dedup_created_idx");
      expect(ANALYTICS_EVENT_DEDUP_MIGRATION.version).toBe(18);
      expect(ANALYTICS_EVENT_DEDUP_MIGRATION.name).toBe("0018_analytics_event_dedup");

      const runtimeFiles = [
        "packages/db/src/analytics/counters.ts",
        "apps/web/src/pages/api/events.ts",
        "packages/core/src/analytics/dedup.ts",
        "packages/core/src/analytics/signals.ts",
        "apps/web/src/components/AnalyticsHead.astro",
        "apps/web/src/scripts/analytics.ts",
      ];
      for (const rel of runtimeFiles) {
        const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
        expect(src, `${rel} must not execute runtime CREATE TABLE`).not.toMatch(/CREATE\s+TABLE/i);
        expect(src, `${rel} must not import @radix-ui`).not.toMatch(/@radix-ui\/|["']radix-ui["']/);
        expect(src, `${rel} must not use asChild`).not.toMatch(/\basChild\b/);
      }
    });
  });
});

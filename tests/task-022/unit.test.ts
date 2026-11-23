import fs from "node:fs";
import path from "node:path";
import {
  ANALYTICS_PROVIDER_DESCRIPTORS,
  ANALYTICS_PROVIDER_EVENT_MAPPINGS,
  buildAnalyticsHeadBootstrapPayload,
  buildProviderScriptUrl,
  CANONICAL_SIGNAL_EVENTS,
  createAnalyticsSignalDispatcher,
  isSafeTestScriptOverrideUrl,
  isValidProviderId,
  parseStoredDirectAnalyticsConfig,
  safeSerializeAnalyticsBootstrap,
  sanitizeAnalyticsSignalPayload,
  sanitizeSignalPagePath,
  validateDirectAnalyticsInput,
  type AnalyticsProviderAdapter,
  type DirectAnalyticsProvider,
  type SanitizedSignalParams,
} from "@punyasitus/core/analytics/config";
import { describe, expect, it } from "vitest";
import {
  consumeFreshPrgLeadSubmitMarker,
  createBrowserProviderAdapter,
  ensureOfficialFbqShim,
  ensureOfficialGtagShim,
  ensureOfficialTtqShim,
  TIKTOK_OFFICIAL_METHODS,
  type AnalyticsBrowserWindow,
} from "../../apps/web/src/scripts/analytics.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-022 Unit Tests — Direct Analytics Providers, Consent Dispatcher & PII Protection", () => {
  describe("1. Strict direct provider ID validation (GA4 / Meta / TikTok only; reject GTM & XSS)", () => {
    it("accepts valid GA4, Meta Pixel, and TikTok Pixel IDs and normalizes empty strings to null", () => {
      const valid = validateDirectAnalyticsInput({
        ga4MeasurementId: "G-AB12CD34EF",
        metaPixelId: "123456789012345",
        tiktokPixelId: "C1234567890ABCDEF",
      });
      expect(valid.ok).toBe(true);
      if (valid.ok) {
        expect(valid.config).toEqual({
          ga4MeasurementId: "G-AB12CD34EF",
          metaPixelId: "123456789012345",
          tiktokPixelId: "C1234567890ABCDEF",
        });
      }

      const cleared = validateDirectAnalyticsInput({
        ga4MeasurementId: "",
        metaPixelId: "   ",
        tiktokPixelId: null,
      });
      expect(cleared.ok).toBe(true);
      if (cleared.ok) {
        expect(cleared.config).toEqual({
          ga4MeasurementId: null,
          metaPixelId: null,
          tiktokPixelId: null,
        });
      }
    });

    it("enforces exact regex bounds for GA4, Meta Pixel, and TikTok Pixel", () => {
      expect(isValidProviderId("ga4", "G-123456")).toBe(true);
      expect(isValidProviderId("ga4", "G-1234567890ABCDEF")).toBe(true);
      expect(isValidProviderId("ga4", "G-12345")).toBe(false); // too short (< 6)
      expect(isValidProviderId("ga4", "G-12345678901234567")).toBe(false); // too long (> 16)
      expect(isValidProviderId("ga4", "g-12345678")).toBe(false); // lowercase rejected
      expect(isValidProviderId("ga4", "UA-12345678-1")).toBe(false);

      expect(isValidProviderId("meta", "1234567890")).toBe(true); // 10 digits
      expect(isValidProviderId("meta", "12345678901234567890")).toBe(true); // 20 digits
      expect(isValidProviderId("meta", "123456789")).toBe(false); // 9 digits
      expect(isValidProviderId("meta", "123456789012345678901")).toBe(false); // 21 digits
      expect(isValidProviderId("meta", "12345ABCDE")).toBe(false);

      expect(isValidProviderId("tiktok", "C123456789")).toBe(true); // 10 chars
      expect(isValidProviderId("tiktok", "C1234567890123456789012345678901")).toBe(true); // 32 chars
      expect(isValidProviderId("tiktok", "C12345678")).toBe(false); // 9 chars
      expect(isValidProviderId("tiktok", "C12345678901234567890123456789012")).toBe(false); // 33 chars
      expect(isValidProviderId("tiktok", "c1234567890")).toBe(false); // lowercase rejected
    });

    it("strictly rejects GTM container IDs (both as field key and as field value)", () => {
      const gtmField = validateDirectAnalyticsInput({
        gtmContainerId: "GTM-ABC1234",
      });
      expect(gtmField.ok).toBe(false);
      if (!gtmField.ok) {
        expect(gtmField.code).toBe("VALIDATION_ERROR");
        expect(gtmField.fields[0]?.code).toBe("GTM_NOT_ALLOWED_HERE");
      }

      const gtmInGa4 = validateDirectAnalyticsInput({
        ga4MeasurementId: "GTM-XYZ9876",
      });
      expect(gtmInGa4.ok).toBe(false);
      if (!gtmInGa4.ok) {
        expect(gtmInGa4.fields[0]?.code).toBe("GTM_NOT_ALLOWED_HERE");
      }

      const gtmInTiktok = validateDirectAnalyticsInput({
        tiktokPixelId: "GTM-XYZ9876",
      });
      expect(gtmInTiktok.ok).toBe(false);
      if (!gtmInTiktok.ok) {
        expect(gtmInTiktok.fields[0]?.code).toBe("GTM_NOT_ALLOWED_HERE");
      }
    });

    it("rejects raw <script> tags, HTML attributes, and arbitrary JS snippets", () => {
      const hostilePayloads = [
        { ga4MeasurementId: "<script>alert(1)</script>" },
        { metaPixelId: "123456789012;alert(1)" },
        { tiktokPixelId: "javascript:alert(1)" },
        { ga4MeasurementId: "G-12345678\" onload=\"alert(1)" },
        { metaPixelId: "1234567890\nalert(1)" },
      ];

      for (const payload of hostilePayloads) {
        const res = validateDirectAnalyticsInput(payload);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.code).toBe("VALIDATION_ERROR");
          expect(res.fields[0]?.code).toBe("FORBIDDEN_SCRIPT_SNIPPET");
        }
      }
    });

    it("drops invalid/GTM keys safely when parsing stored JSON and suppresses head output for preview/non-tenant", () => {
      const parsed = parseStoredDirectAnalyticsConfig({
        ga4MeasurementId: "G-VALID1234",
        metaPixelId: "not-a-number",
        tiktokPixelId: "<script>evil()</script>",
        gtmContainerId: "GTM-ABCD123",
      });
      expect(parsed).toEqual({
        ga4MeasurementId: "G-VALID1234",
        metaPixelId: null,
        tiktokPixelId: null,
      });

      expect(
        buildAnalyticsHeadBootstrapPayload({
          config: { ga4MeasurementId: "G-VALID1234" },
          surface: "app",
        }),
      ).toBeNull();
      expect(
        buildAnalyticsHeadBootstrapPayload({
          config: { ga4MeasurementId: "G-VALID1234" },
          surface: "tenant",
          isPreview: true,
        }),
      ).toBeNull();
      expect(
        buildAnalyticsHeadBootstrapPayload({
          config: { ga4MeasurementId: null, metaPixelId: null, tiktokPixelId: null },
          surface: "tenant",
        }),
      ).toBeNull();

      const bootstrap = buildAnalyticsHeadBootstrapPayload({
        config: { ga4MeasurementId: "G-VALID1234", metaPixelId: "123456789012345" },
        surface: "tenant",
        isPreview: false,
      });
      expect(bootstrap).not.toBeNull();
      if (bootstrap) {
        const serialized = safeSerializeAnalyticsBootstrap(bootstrap);
        expect(serialized).not.toContain("</script");
        expect(serialized).not.toContain("<");
      }
    });
  });

  describe("2. Documented provider event mappings & strict PII stripping", () => {
    it("exports complete documented mappings across GA4, Meta Pixel, and TikTok Pixel", () => {
      expect(CANONICAL_SIGNAL_EVENTS).toEqual([
        "page_view",
        "whatsapp_click",
        "external_click",
        "lead_submitted",
        "view_item",
      ]);

      expect(ANALYTICS_PROVIDER_EVENT_MAPPINGS.page_view.providers.ga4.eventName).toBe("page_view");
      expect(ANALYTICS_PROVIDER_EVENT_MAPPINGS.page_view.providers.meta.eventName).toBe("PageView");
      expect(ANALYTICS_PROVIDER_EVENT_MAPPINGS.page_view.providers.tiktok.eventName).toBe(
        "PageView",
      );

      expect(ANALYTICS_PROVIDER_EVENT_MAPPINGS.whatsapp_click.providers.ga4.eventName).toBe(
        "whatsapp_click",
      );
      expect(ANALYTICS_PROVIDER_EVENT_MAPPINGS.whatsapp_click.providers.meta.eventName).toBe(
        "Contact",
      );
      expect(ANALYTICS_PROVIDER_EVENT_MAPPINGS.whatsapp_click.providers.tiktok.eventName).toBe(
        "Contact",
      );

      expect(ANALYTICS_PROVIDER_EVENT_MAPPINGS.lead_submitted.providers.ga4.eventName).toBe(
        "generate_lead",
      );
      expect(ANALYTICS_PROVIDER_EVENT_MAPPINGS.lead_submitted.providers.meta.eventName).toBe(
        "Lead",
      );
      expect(ANALYTICS_PROVIDER_EVENT_MAPPINGS.lead_submitted.providers.tiktok.eventName).toBe(
        "SubmitForm",
      );

      expect(ANALYTICS_PROVIDER_EVENT_MAPPINGS.view_item.providers.ga4.eventName).toBe("view_item");
      expect(ANALYTICS_PROVIDER_EVENT_MAPPINGS.view_item.providers.meta.eventName).toBe(
        "ViewContent",
      );
      expect(ANALYTICS_PROVIDER_EVENT_MAPPINGS.view_item.providers.tiktok.eventName).toBe(
        "ViewContent",
      );

      expect(ANALYTICS_PROVIDER_DESCRIPTORS.ga4.consentCategory).toBe("analytics");
      expect(ANALYTICS_PROVIDER_DESCRIPTORS.meta.consentCategory).toBe("marketing");
      expect(ANALYTICS_PROVIDER_DESCRIPTORS.tiktok.consentCategory).toBe("marketing");
    });

    it("strips ALL PII keys, raw email/phone values, and URL query strings", () => {
      const sanitized = sanitizeAnalyticsSignalPayload({
        event_id: "evt_001",
        page_path: "/layanan/konsultasi?email=budi@example.com&phone=081234567890#top",
        content_type: "service",
        content_category: "konsultasi-bisnis",
        content_name: "Hubungi budi@example.com sekarang",
        cta_mode: "whatsapp",
        currency: "idr",
        value: 250000,
        // Forbidden PII keys:
        name: "Budi Santoso",
        email: "budi@example.com",
        phone: "081234567890",
        phone_e164: "6281234567890",
        message: "Saya ingin konsultasi pajak perusahaan",
        utm_source: "fb",
        gclid: "test-gclid",
        cookie: "session=secret",
      });

      expect(sanitized).toEqual({
        event_id: "evt_001",
        page_path: "/layanan/konsultasi",
        content_type: "service",
        content_category: "konsultasi-bisnis",
        cta_mode: "whatsapp",
        currency: "IDR",
        value: 250000,
      });
      // `content_name` contained an email so it MUST be dropped
      expect(sanitized.content_name).toBeUndefined();
      expect(JSON.stringify(sanitized)).not.toContain("budi@example.com");
      expect(JSON.stringify(sanitized)).not.toContain("081234567890");
      expect(JSON.stringify(sanitized)).not.toContain("Budi Santoso");
      expect(JSON.stringify(sanitized)).not.toContain("konsultasi pajak");

      // Paths containing PII or hostile schemes are rejected cleanly
      expect(sanitizeSignalPagePath("/users/budi@example.com")).toBeNull();
      expect(sanitizeSignalPagePath("javascript:alert(1)")).toBeNull();
      expect(sanitizeSignalPagePath("//evil.example/steal")).toBeNull();
    });

    it("builds official script URLs only for valid IDs, gates test overrides to local/test, and rejects //evil.com", () => {
      expect(buildProviderScriptUrl("ga4", "G-AB12CD34EF")).toBe(
        "https://www.googletagmanager.com/gtag/js?id=G-AB12CD34EF",
      );
      expect(buildProviderScriptUrl("meta", "123456789012345")).toBe(
        "https://connect.facebook.net/en_US/fbevents.js",
      );
      expect(buildProviderScriptUrl("tiktok", "C1234567890ABCDEF")).toBe(
        "https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=C1234567890ABCDEF&lib=ttq",
      );
      expect(buildProviderScriptUrl("ga4", "GTM-123456")).toBeNull();

      // Safe test overrides accepted
      expect(
        buildProviderScriptUrl("ga4", "G-AB12CD34EF", {
          ga4: "https://mock-ga4.test/gtag/js",
        }),
      ).toBe("https://mock-ga4.test/gtag/js?id=G-AB12CD34EF");
      expect(
        buildProviderScriptUrl("ga4", "G-AB12CD34EF", {
          ga4: "http://127.0.0.1:4321/mock-ga4.js",
        }),
      ).toBe("http://127.0.0.1:4321/mock-ga4.js?id=G-AB12CD34EF");
      expect(
        buildProviderScriptUrl("ga4", "G-AB12CD34EF", {
          ga4: "/mock-vendor/ga4.js",
        }),
      ).toBe("/mock-vendor/ga4.js?id=G-AB12CD34EF");

      // Protocol-relative `//evil.com`, non-loopback `http://`, credentials, and JS schemes REJECTED
      expect(isSafeTestScriptOverrideUrl("//evil.com/gtag.js")).toBe(false);
      expect(isSafeTestScriptOverrideUrl("http://evil.com/gtag.js")).toBe(false);
      expect(isSafeTestScriptOverrideUrl("https://user:pass@evil.com/gtag.js")).toBe(false);
      expect(isSafeTestScriptOverrideUrl("javascript:alert(1)")).toBe(false);
      expect(
        buildProviderScriptUrl("ga4", "G-AB12CD34EF", {
          ga4: "//evil.com/gtag.js",
        }),
      ).toBeNull();

      // `buildAnalyticsHeadBootstrapPayload` strips `testScriptOverrides` unless `allowTestOverrides: true`
      const prodPayload = buildAnalyticsHeadBootstrapPayload({
        config: { ga4MeasurementId: "G-AB12CD34EF" },
        surface: "tenant",
        testScriptOverrides: { ga4: "https://mock-ga4.test/gtag/js" },
      });
      expect(prodPayload?.testScriptOverrides).toBeUndefined();

      const testPayload = buildAnalyticsHeadBootstrapPayload({
        config: { ga4MeasurementId: "G-AB12CD34EF" },
        surface: "tenant",
        allowTestOverrides: true,
        testScriptOverrides: {
          ga4: "https://mock-ga4.test/gtag/js",
          meta: "//evil.com/fbevents.js",
        },
      });
      expect(testPayload?.testScriptOverrides).toEqual({
        ga4: "https://mock-ga4.test/gtag/js",
      });
    });
  });

  describe("3. Consent gating state machine, once-per-leadId dedup & fault-isolated CTA dispatch", () => {
    function createSpyAdapter(options?: {
      readonly throwOnSendProviders?: readonly DirectAnalyticsProvider[];
      readonly throwOnLoadProviders?: readonly DirectAnalyticsProvider[];
    }) {
      const loads: Array<{ provider: DirectAnalyticsProvider; id: string; url: string }> = [];
      const events: Array<{
        provider: DirectAnalyticsProvider;
        eventName: string;
        params: SanitizedSignalParams;
        eventId: string;
      }> = [];
      const revokes: Array<{ provider: DirectAnalyticsProvider; id: string }> = [];

      const adapter: AnalyticsProviderAdapter = {
        loadProvider(provider, id, url) {
          if (options?.throwOnLoadProviders?.includes(provider)) {
            throw new Error(`Simulated blocked script load for ${provider}`);
          }
          loads.push({ provider, id, url });
        },
        sendEvent(provider, _id, eventName, params, meta) {
          if (options?.throwOnSendProviders?.includes(provider)) {
            throw new Error(`Simulated vendor throw for ${provider}`);
          }
          events.push({ provider, eventName, params, eventId: meta.eventId });
        },
        revokeProvider(provider, id) {
          revokes.push({ provider, id });
        },
      };

      return { adapter, loads, events, revokes };
    }

    it("fires ZERO loads and ZERO events before consent or when declined; gates GA4 by analytics and Meta/TikTok by marketing; halts on revocation", () => {
      const spy = createSpyAdapter();
      const dispatcher = createAnalyticsSignalDispatcher({
        config: {
          ga4MeasurementId: "G-TEST123456",
          metaPixelId: "123456789012345",
          tiktokPixelId: "C1234567890ABCDEF",
        },
        adapter: spy.adapter,
        currentPath: () => "/layanan",
      });

      // 1. Before consent: ZERO loads, ZERO events
      expect(spy.loads).toHaveLength(0);
      expect(spy.events).toHaveLength(0);
      const preConsentReport = dispatcher.dispatch("whatsapp_click");
      expect(preConsentReport.deliveredTo).toHaveLength(0);
      expect(spy.loads).toHaveLength(0);
      expect(spy.events).toHaveLength(0);

      // 2. Explicit decline: still ZERO loads, ZERO events
      dispatcher.updateConsent({ version: 1, analytics: false, marketing: false, hasDecision: true });
      dispatcher.dispatch("whatsapp_click");
      expect(spy.loads).toHaveLength(0);
      expect(spy.events).toHaveLength(0);

      // 3. Grant ONLY analytics consent -> ONLY GA4 loads & receives page_view
      dispatcher.updateConsent({ version: 1, analytics: true, marketing: false, hasDecision: true });
      expect(spy.loads.map((l) => l.provider)).toEqual(["ga4"]);
      expect(spy.events.map((e) => `${e.provider}:${e.eventName}`)).toEqual(["ga4:page_view"]);

      // 4. Grant BOTH analytics & marketing -> Meta & TikTok now load & receive page_view (GA4 not duplicated!)
      dispatcher.updateConsent({ version: 1, analytics: true, marketing: true, hasDecision: true });
      expect(spy.loads.map((l) => l.provider)).toEqual(["ga4", "meta", "tiktok"]);
      expect(spy.events.map((e) => `${e.provider}:${e.eventName}`)).toEqual([
        "ga4:page_view",
        "meta:PageView",
        "tiktok:PageView",
      ]);

      // 5. WhatsApp click dispatches to all 3 consented providers (`wa_click` alias normalized!)
      const waReport = dispatcher.dispatch("wa_click", {
        cta_mode: "whatsapp",
        phone: "081234567890", // stripped
      });
      expect(waReport.deliveredTo.map((d) => `${d.provider}:${d.providerEventName}`)).toEqual([
        "ga4:whatsapp_click",
        "meta:Contact",
        "tiktok:Contact",
      ]);

      // 6. Revoke consent -> revokes all 3 and immediately halts future dispatches
      dispatcher.updateConsent({ version: 1, analytics: false, marketing: false, hasDecision: false });
      expect(spy.revokes.map((r) => r.provider)).toEqual(["ga4", "meta", "tiktok"]);

      const countBeforePostRevoke = spy.events.length;
      const postRevoke = dispatcher.dispatch("whatsapp_click");
      expect(postRevoke.deliveredTo).toHaveLength(0);
      expect(spy.events.length).toBe(countBeforePostRevoke);
    });

    it("fires lead_submitted AT MOST ONCE per persisted leadId and rejects unpersisted or invalid leadIds", () => {
      const spy = createSpyAdapter();
      const dispatcher = createAnalyticsSignalDispatcher({
        config: {
          ga4MeasurementId: "G-TEST123456",
          metaPixelId: "123456789012345",
          tiktokPixelId: "C1234567890ABCDEF",
        },
        adapter: spy.adapter,
        initialConsent: { version: 1, analytics: true, marketing: true, hasDecision: true },
        autoPageView: false,
      });

      // Unpersisted submit (e.g. button click / 422 / 429 / 503) -> ZERO signals
      const unpersisted = dispatcher.dispatchLeadSubmitted({
        leadId: 42,
        persisted: false,
      });
      expect(unpersisted).toEqual({ ok: false, reason: "NOT_PERSISTED", leadId: null });
      expect(spy.events).toHaveLength(0);

      // Honeypot leadNumber 0 -> rejected
      const honeypot = dispatcher.dispatchLeadSubmitted({
        leadId: 0,
        persisted: true,
      });
      expect(honeypot).toEqual({ ok: false, reason: "INVALID_LEAD_ID", leadId: null });
      expect(spy.events).toHaveLength(0);

      // Persisted lead #42 -> fires ONCE across GA4 / Meta / TikTok with ZERO PII
      const first = dispatcher.dispatchLeadSubmitted({
        leadId: 42,
        persisted: true,
        page_path: "/kontak?email=rahasia@example.com",
        extra: {
          name: "Siti Rahma",
          email: "rahasia@example.com",
          phone: "081234567890",
          message: "Tolong hubungi saya",
        },
      });
      expect(first.ok).toBe(true);
      expect(spy.events.map((e) => `${e.provider}:${e.eventName}`)).toEqual([
        "ga4:generate_lead",
        "meta:Lead",
        "tiktok:SubmitForm",
      ]);
      for (const ev of spy.events) {
        const serialized = JSON.stringify(ev.params);
        expect(serialized).not.toContain("Siti Rahma");
        expect(serialized).not.toContain("rahasia@example.com");
        expect(serialized).not.toContain("081234567890");
        expect(serialized).not.toContain("Tolong hubungi saya");
        expect(ev.params.page_path).toBe("/kontak");
        expect(ev.params.lead_ref).toBe("lead_42");
      }

      // Duplicate trigger for same persisted lead #42 -> strictly deduplicated (0 new events)
      const duplicate = dispatcher.dispatchLeadSubmitted({
        leadId: "42",
        persisted: true,
      });
      expect(duplicate).toEqual({ ok: false, reason: "DUPLICATE_LEAD_ID", leadId: "42" });
      expect(spy.events).toHaveLength(3);
    });

    it("isolates throwing/blocked vendor scripts so CTA dispatch never throws and healthy providers still receive signals", () => {
      const spy = createSpyAdapter({
        throwOnLoadProviders: ["meta"],
        throwOnSendProviders: ["tiktok"],
      });

      const dispatcher = createAnalyticsSignalDispatcher({
        config: {
          ga4MeasurementId: "G-TEST123456",
          metaPixelId: "123456789012345",
          tiktokPixelId: "C1234567890ABCDEF",
        },
        adapter: spy.adapter,
        initialConsent: { version: 1, analytics: true, marketing: true, hasDecision: true },
        autoPageView: false,
      });

      // Must NOT throw even though Meta fails to load and TikTok throws during send
      const report = dispatcher.dispatch("whatsapp_click", { cta_mode: "whatsapp" });
      expect(report.deliveredTo.map((d) => d.provider)).toEqual(["ga4"]);
      expect(report.errors.map((e) => `${e.provider}:${e.phase}`)).toEqual([
        "meta:load",
        "tiktok:send",
      ]);
    });

    it("does NOT retroactively emit lead_submitted if consent is granted after a lead was persisted without consent", () => {
      const spy = createSpyAdapter();
      const dispatcher = createAnalyticsSignalDispatcher({
        config: {
          ga4MeasurementId: "G-TEST123456",
          metaPixelId: "123456789012345",
          tiktokPixelId: "C1234567890ABCDEF",
        },
        adapter: spy.adapter,
        autoPageView: true,
      });

      // Lead #77 persisted while visitor has NOT consented -> 0 vendor loads or events
      const noConsentLead = dispatcher.dispatchLeadSubmitted({
        leadId: 77,
        persisted: true,
        page_path: "/kontak",
      });
      expect(noConsentLead.ok).toBe(true);
      if (noConsentLead.ok) {
        expect(noConsentLead.report.deliveredTo).toHaveLength(0);
      }
      expect(spy.loads).toHaveLength(0);
      expect(spy.events).toHaveLength(0);

      // Visitor later grants consent -> ONLY page_view fires; lead #77 MUST NOT fire retroactively
      dispatcher.updateConsent({ version: 1, analytics: true, marketing: true, hasDecision: true });
      expect(spy.events.map((e) => `${e.provider}:${e.eventName}`)).toEqual([
        "ga4:page_view",
        "meta:PageView",
        "tiktok:PageView",
      ]);
    });
  });

  describe("4. Official GA4 (arguments), Meta (fbq), TikTok (ttq) browser shims & PRG submit marker", () => {
    it("GA4 gtag shim pushes genuine IArguments objects (NOT plain Arrays) to window.dataLayer", () => {
      const fakeWin: AnalyticsBrowserWindow = {};
      ensureOfficialGtagShim(fakeWin);
      expect(Array.isArray(fakeWin.dataLayer)).toBe(true);
      expect(typeof fakeWin.gtag).toBe("function");

      fakeWin.gtag?.("event", "generate_lead", { lead_ref: "lead_9" });
      expect(fakeWin.dataLayer).toHaveLength(1);
      const entry = fakeWin.dataLayer?.[0];
      expect(Object.prototype.toString.call(entry)).toBe("[object Arguments]");
      expect(Array.isArray(entry)).toBe(false);
      const argsObj = entry as IArguments;
      expect(argsObj[0]).toBe("event");
      expect(argsObj[1]).toBe("generate_lead");
      expect(argsObj[2]).toEqual({ lead_ref: "lead_9" });
    });

    it("Meta fbq shim matches official Meta Pixel bootstrap (queue, _fbq, loaded, version, callMethod)", () => {
      const fakeWin: AnalyticsBrowserWindow = {};
      ensureOfficialFbqShim(fakeWin);
      expect(typeof fakeWin.fbq).toBe("function");
      expect(fakeWin._fbq).toBe(fakeWin.fbq);
      expect(fakeWin.fbq?.push).toBe(fakeWin.fbq);
      expect(fakeWin.fbq?.loaded).toBe(true);
      expect(fakeWin.fbq?.version).toBe("2.0");
      expect(Array.isArray(fakeWin.fbq?.queue)).toBe(true);

      // Calls before script loads queue IArguments
      fakeWin.fbq?.("init", "123456789012345");
      expect(fakeWin.fbq?.queue).toHaveLength(1);
      expect(Object.prototype.toString.call(fakeWin.fbq?.queue?.[0])).toBe("[object Arguments]");

      // Once callMethod is attached by fbevents.js, calls delegate directly via apply
      const forwarded: unknown[][] = [];
      if (fakeWin.fbq) {
        fakeWin.fbq.callMethod = (...args: unknown[]) => {
          forwarded.push(args);
        };
      }
      fakeWin.fbq?.("track", "Lead", { page_path: "/kontak" }, { eventID: "lead_9" });
      expect(forwarded).toEqual([
        ["track", "Lead", { page_path: "/kontak" }, { eventID: "lead_9" }],
      ]);
    });

    it("TikTok ttq shim matches official Events SDK bootstrap (TiktokAnalyticsObject, methods, setAndDefer, instance, load)", () => {
      const fakeWin: AnalyticsBrowserWindow = {};
      const injected: string[] = [];
      const adapter = createBrowserProviderAdapter(
        fakeWin,
        (_p, url) => injected.push(url),
        () => {},
      );
      adapter.loadProvider(
        "tiktok",
        "C1234567890ABCDEF",
        "https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=C1234567890ABCDEF&lib=ttq",
      );

      expect(fakeWin.TiktokAnalyticsObject).toBe("ttq");
      expect(Array.isArray(fakeWin.ttq)).toBe(true);
      expect(fakeWin.ttq?.methods).toEqual([...TIKTOK_OFFICIAL_METHODS]);
      expect(typeof fakeWin.ttq?.setAndDefer).toBe("function");
      expect(typeof fakeWin.ttq?.instance).toBe("function");
      expect(typeof fakeWin.ttq?.load).toBe("function");
      expect(fakeWin.ttq?._i?.["C1234567890ABCDEF"]?._u).toBe(
        "https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=C1234567890ABCDEF&lib=ttq",
      );
      expect(typeof fakeWin.ttq?._t?.["C1234567890ABCDEF"]).toBe("number");
      expect(fakeWin.ttq?._o?.["C1234567890ABCDEF"]).toEqual({});
      expect(injected).toHaveLength(1);

      // Calling ttq.instance() returns a deferred instance queue with official methods
      const inst = fakeWin.ttq?.instance?.("C1234567890ABCDEF");
      expect(typeof inst?.track).toBe("function");

      // ensureOfficialTtqShim is idempotent
      ensureOfficialTtqShim(fakeWin);
      expect(fakeWin.ttq?._i?.["C1234567890ABCDEF"]).toBeDefined();
    });

    it("PRG lead submit marker rejects crafted URLs without a fresh same-session form submit", () => {
      const store = new Map<string, string>();
      const storage = {
        getItem: (k: string) => store.get(k) ?? null,
        removeItem: (k: string) => {
          store.delete(k);
        },
      };
      const now = 1_700_000_000_000;

      // Without marker -> rejected
      expect(consumeFreshPrgLeadSubmitMarker(storage, now)).toBe(false);

      // Expired marker (> 5 min old) -> rejected and removed
      store.set("ps_lead_submit_pending", String(now - 6 * 60 * 1000));
      expect(consumeFreshPrgLeadSubmitMarker(storage, now)).toBe(false);
      expect(store.has("ps_lead_submit_pending")).toBe(false);

      // Fresh marker -> accepted ONCE and immediately consumed
      store.set("ps_lead_submit_pending", String(now - 2_000));
      expect(consumeFreshPrgLeadSubmitMarker(storage, now)).toBe(true);
      expect(consumeFreshPrgLeadSubmitMarker(storage, now)).toBe(false);
    });
  });

  describe("5. DEC-036 static guard — zero @radix-ui/* imports or asChild props in TASK-022 files", () => {
    it("confirms all TASK-022 UI & script files use @base-ui/react only and zero Radix/asChild", () => {
      const filesToCheck = [
        "apps/web/src/components/AnalyticsHead.astro",
        "apps/web/src/scripts/analytics.ts",
        "apps/web/src/pages/dashboard/[handle]/settings/analytics/index.astro",
        "apps/web/src/pages/dashboard/[handle]/settings/analytics/_AnalyticsSettingsForm.tsx",
      ];

      for (const rel of filesToCheck) {
        const content = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
        expect(content, `${rel} must not import @radix-ui`).not.toMatch(/@radix-ui\/|["']radix-ui["']/);
        expect(content, `${rel} must not use Radix asChild prop`).not.toMatch(/\basChild\b/);
      }
    });
  });
});

import fs from "node:fs";
import path from "node:path";
import {
  buildAnalyticsHeadBootstrapPayload,
  buildGoogleConsentModeUpdate,
  buildGtmNoscriptUrl,
  buildGtmScriptUrl,
  buildPlatformSurfaceCspHeader,
  buildPsExternalClickEvent,
  buildPsLeadSubmittedEvent,
  buildPsPageViewEvent,
  buildPsWaClickEvent,
  buildRelaxedGtmCspHeader,
  buildStrictPublicCspHeader,
  createAnalyticsSignalDispatcher,
  generateCspNonce,
  GTM_CONSENT_MODE_V2_DEFAULT,
  GTM_DATALAYER_CONTRACT_VERSION,
  GTM_DATALAYER_EVENTS,
  GTM_RISK_ACK_STATEMENTS_ID,
  GTM_RISK_ACK_VERSION,
  injectNonceIntoInlineHtmlScripts,
  isValidCspNonce,
  isValidGtmContainerId,
  parseStoredAnalyticsSettings,
  PUNYASITUS_GTM_CONTAINER_TEMPLATE,
  resolveEffectivePublicAnalyticsConfig,
  rotateCspNonceInHtmlScripts,
  sanitizeDestinationHost,
  selectPublicCspProfile,
  serializeGtmContainerTemplateJson,
  validateGtmContainerTemplateJson,
  validateGtmSettingsInput,
  validateVendorMutualExclusion,
  type AnalyticsGtmAdapter,
  type AnalyticsProviderAdapter,
  type PsDataLayerEventPayload,
} from "@punyasitus/core/analytics/config";
import { renderEmailTemplate } from "@punyasitus/core/email/index";
import { describe, expect, it } from "vitest";
import {
  createBrowserGtmAdapter,
  ensureConsentModeV2DefaultDenied,
  shouldReloadForConsentedGtmCsp,
  updateGoogleConsentModeV2,
  type AnalyticsBrowserWindow,
} from "../../apps/web/src/scripts/analytics.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-076 Unit Tests — Easy GTM Setup, Consent Mode v2, ps_* DataLayer, CSP & Template", () => {
  describe("1. Strict GTM Container ID validation & anti-XSS", () => {
    it("accepts valid GTM container IDs (^GTM-[A-Z0-9]{6,12}$) and rejects invalid / hostile inputs", () => {
      expect(isValidGtmContainerId("GTM-ABC123")).toBe(true); // 6 chars
      expect(isValidGtmContainerId("GTM-WXYZ1234")).toBe(true); // 8 chars
      expect(isValidGtmContainerId("GTM-1234567890AB")).toBe(true); // 12 chars

      expect(isValidGtmContainerId("GTM-12345")).toBe(false); // 5 chars too short
      expect(isValidGtmContainerId("GTM-1234567890ABC")).toBe(false); // 13 chars too long
      expect(isValidGtmContainerId("gtm-abc1234")).toBe(false); // lowercase
      expect(isValidGtmContainerId("GTM-abc1234")).toBe(false); // lowercase suffix
      expect(isValidGtmContainerId("G-AB12CD34EF")).toBe(false); // GA4 ID
      expect(isValidGtmContainerId("GTM-ABC123<script>")).toBe(false);
      expect(isValidGtmContainerId("<script>alert(1)</script>")).toBe(false);
      expect(isValidGtmContainerId('GTM-ABC123" onload="alert(1)')).toBe(false);
      expect(isValidGtmContainerId("javascript:alert(1)")).toBe(false);
    });

    it("rejects hostile script snippets, unknown fields, and invalid vendor modes", () => {
      const xss = validateGtmSettingsInput({ gtmContainerId: "<script>alert(1)</script>" });
      expect(xss.ok).toBe(false);
      if (!xss.ok) {
        expect(xss.fields[0]?.code).toBe("FORBIDDEN_SCRIPT_SNIPPET");
      }

      const invalidId = validateGtmSettingsInput({ gtmContainerId: "GTM-short" });
      expect(invalidId.ok).toBe(false);
      if (!invalidId.ok) {
        expect(invalidId.fields[0]?.code).toBe("INVALID_GTM_CONTAINER_ID");
      }

      const unknownField = validateGtmSettingsInput({
        gtmContainerId: "GTM-ABC1234",
        rawHeaderHtml: "<script>evil()</script>",
      });
      expect(unknownField.ok).toBe(false);
      if (!unknownField.ok) {
        expect(unknownField.fields[0]?.code).toBe("UNKNOWN_FIELD");
      }

      const badMode = validateGtmSettingsInput({
        vendorModes: { ga4: "both" },
      });
      expect(badMode.ok).toBe(false);
      if (!badMode.ok) {
        expect(badMode.fields[0]?.code).toBe("INVALID_VENDOR_MODE");
      }
    });

    it("enforces strict per-vendor mutual exclusion (never both direct and via GTM)", () => {
      const conflicts = validateVendorMutualExclusion(
        {
          ga4MeasurementId: "G-AB12CD34EF",
          metaPixelId: "123456789012345",
          tiktokPixelId: null,
        },
        {
          ga4: "gtm",
          meta: "direct",
          tiktok: "gtm",
        },
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.field).toBe("ga4MeasurementId");
      expect(conflicts[0]?.code).toBe("VENDOR_DUAL_MODE_CONFLICT");

      const effective = resolveEffectivePublicAnalyticsConfig(
        parseStoredAnalyticsSettings({
          ga4MeasurementId: "G-AB12CD34EF",
          metaPixelId: "123456789012345",
          tiktokPixelId: "C1234567890ABCDEF",
          vendorModes: { ga4: "gtm", meta: "direct", tiktok: "gtm" },
          gtmContainerId: "GTM-ABC1234",
          gtmEnabled: true,
          gtmRiskAck: {
            accepted: true,
            version: GTM_RISK_ACK_VERSION,
            acceptedAt: "2026-11-23T12:00:00.000Z",
            acceptedByUserId: "usr_owner",
          },
        }),
        false,
      );
      expect(effective.gtm.enabled).toBe(true);
      expect(effective.gtm.containerId).toBe("GTM-ABC1234");
      // Direct GA4 & TikTok suppressed while routed via active GTM; direct Meta preserved!
      expect(effective.directProviders.ga4MeasurementId).toBeNull();
      expect(effective.directProviders.metaPixelId).toBe("123456789012345");
      expect(effective.directProviders.tiktokPixelId).toBeNull();

      // When operator kill switch is active, GTM is disabled while direct tags keep working!
      const killed = resolveEffectivePublicAnalyticsConfig(
        parseStoredAnalyticsSettings({
          ga4MeasurementId: null,
          metaPixelId: "123456789012345",
          tiktokPixelId: null,
          vendorModes: { ga4: "gtm", meta: "direct", tiktok: "direct" },
          gtmContainerId: "GTM-ABC1234",
          gtmEnabled: true,
          gtmRiskAck: {
            accepted: true,
            version: GTM_RISK_ACK_VERSION,
            acceptedAt: "2026-11-23T12:00:00.000Z",
            acceptedByUserId: "usr_owner",
          },
        }),
        true,
      );
      expect(killed.gtm.enabled).toBe(false);
      expect(killed.gtm.containerId).toBeNull();
      expect(killed.gtm.operatorDisabled).toBe(true);
      expect(killed.directProviders.metaPixelId).toBe("123456789012345");
    });

    it("suppresses GTM bootstrap on non-tenant surfaces, preview mode, or without owner risk ack", () => {
      const validGtm = {
        gtmContainerId: "GTM-ABC1234",
        gtmEnabled: true,
        vendorModes: { ga4: "gtm" as const, meta: "direct" as const, tiktok: "direct" as const },
        gtmRiskAck: {
          accepted: true,
          version: GTM_RISK_ACK_VERSION,
          acceptedAt: "2026-11-23T12:00:00.000Z",
          acceptedByUserId: "usr_1",
        },
      };

      expect(buildAnalyticsHeadBootstrapPayload({ config: null, gtmConfig: validGtm, surface: "app" })).toBeNull();
      expect(buildAnalyticsHeadBootstrapPayload({ config: null, gtmConfig: validGtm, surface: "console" })).toBeNull();
      expect(buildAnalyticsHeadBootstrapPayload({ config: null, gtmConfig: validGtm, surface: "preview" })).toBeNull();
      expect(buildAnalyticsHeadBootstrapPayload({ config: null, gtmConfig: validGtm, surface: "error" })).toBeNull();
      expect(buildAnalyticsHeadBootstrapPayload({ config: null, gtmConfig: validGtm, surface: "tenant", isPreview: true })).toBeNull();
      expect(
        buildAnalyticsHeadBootstrapPayload({
          config: null,
          gtmConfig: { ...validGtm, gtmRiskAck: null },
          surface: "tenant",
        }),
      ).toBeNull();
      expect(
        buildAnalyticsHeadBootstrapPayload({
          config: null,
          gtmConfig: validGtm,
          operatorKillSwitchActive: true,
          surface: "tenant",
        }),
      ).toBeNull();

      const ok = buildAnalyticsHeadBootstrapPayload({
        config: null,
        gtmConfig: validGtm,
        surface: "tenant",
        isPreview: false,
      });
      expect(ok?.gtm?.enabled).toBe(true);
      expect(ok?.gtm?.containerId).toBe("GTM-ABC1234");
      expect(GTM_RISK_ACK_STATEMENTS_ID.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("2. Google Consent Mode v2 & Standard PII-free `ps_*` dataLayer Contract", () => {
    it("defaults all optional Consent Mode v2 storages to denied before load and updates accurately", () => {
      expect(GTM_CONSENT_MODE_V2_DEFAULT).toEqual({
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
        analytics_storage: "denied",
        functionality_storage: "denied",
        personalization_storage: "denied",
        security_storage: "granted",
        wait_for_update: 500,
      });

      const analyticsOnly = buildGoogleConsentModeUpdate({
        analytics: true,
        marketing: false,
        hasDecision: true,
      });
      expect(analyticsOnly.analytics_storage).toBe("granted");
      expect(analyticsOnly.ad_storage).toBe("denied");
      expect(analyticsOnly.ad_user_data).toBe("denied");
      expect(analyticsOnly.ad_personalization).toBe("denied");

      const allGranted = buildGoogleConsentModeUpdate({
        analytics: true,
        marketing: true,
        hasDecision: true,
      });
      expect(allGranted.analytics_storage).toBe("granted");
      expect(allGranted.ad_storage).toBe("granted");
      expect(allGranted.ad_user_data).toBe("granted");
      expect(allGranted.ad_personalization).toBe("granted");

      const revoked = buildGoogleConsentModeUpdate({
        analytics: false,
        marketing: false,
        hasDecision: false,
      });
      expect(revoked.analytics_storage).toBe("denied");
      expect(revoked.ad_storage).toBe("denied");
    });

    it("pushes real IArguments for gtag Consent Mode default/update via browser shim", () => {
      const win: AnalyticsBrowserWindow = {};
      ensureConsentModeV2DefaultDenied(win, GTM_CONSENT_MODE_V2_DEFAULT);
      ensureConsentModeV2DefaultDenied(win, GTM_CONSENT_MODE_V2_DEFAULT); // idempotent
      expect(win.dataLayer).toHaveLength(1);
      const firstArgs = win.dataLayer?.[0] as IArguments;
      expect(Object.prototype.toString.call(firstArgs)).toBe("[object Arguments]");
      expect(firstArgs[0]).toBe("consent");
      expect(firstArgs[1]).toBe("default");
      expect((firstArgs[2] as Record<string, unknown>).analytics_storage).toBe("denied");

      updateGoogleConsentModeV2(
        win,
        buildGoogleConsentModeUpdate({ analytics: true, marketing: true, hasDecision: true }),
      );
      expect(win.dataLayer).toHaveLength(2);
      const secondArgs = win.dataLayer?.[1] as IArguments;
      expect(secondArgs[0]).toBe("consent");
      expect(secondArgs[1]).toBe("update");
      expect((secondArgs[2] as Record<string, unknown>).ad_user_data).toBe("granted");
    });

    it("builds all 4 standard ps_* events with strict PII stripping & host-only destination_host", () => {
      expect(GTM_DATALAYER_EVENTS).toEqual([
        "ps_page_view",
        "ps_wa_click",
        "ps_external_click",
        "ps_lead_submitted",
      ]);

      const pv = buildPsPageViewEvent({
        eventId: "evt_1",
        pageType: "service",
        contentId: "srv-konsultasi",
        pagePath: "/layanan/konsultasi?email=budi@example.com&utm_source=ads",
      });
      expect(pv).toEqual({
        event: "ps_page_view",
        ps_schema_version: GTM_DATALAYER_CONTRACT_VERSION,
        event_id: "evt_1",
        page_type: "service",
        content_id: "srv-konsultasi",
        page_path: "/layanan/konsultasi",
      });

      const wa = buildPsWaClickEvent({
        eventId: "evt_2",
        itemId: "item-42",
        itemTitle: "Paket Audit Pajak UMKM",
        placement: "detail",
        pagePath: "/layanan/audit?phone=081234567890",
      });
      expect(wa).toEqual({
        event: "ps_wa_click",
        ps_schema_version: 1,
        event_id: "evt_2",
        item_id: "item-42",
        item_title: "Paket Audit Pajak UMKM",
        placement: "detail",
        page_path: "/layanan/audit",
      });

      // PII embedded in item_title is stripped completely
      const waWithPii = buildPsWaClickEvent({
        eventId: "evt_2b",
        itemId: "item-42",
        itemTitle: "Hubungi budi@example.com atau 081234567890",
        placement: "hero",
        pagePath: "/",
      });
      expect(waWithPii.item_title).toBeNull();

      // External click exposes ONLY destination_host, never path/query/tokens
      const ext = buildPsExternalClickEvent({
        eventId: "evt_3",
        itemId: "prod-7",
        destinationUrl:
          "https://www.tokopedia.com/toko-saya/produk-rahasia?email=budi@example.com&token=secret#buy",
        pagePath: "/produk/kopi?fbclid=xyz",
      });
      expect(ext).toEqual({
        event: "ps_external_click",
        ps_schema_version: 1,
        event_id: "evt_3",
        item_id: "prod-7",
        destination_host: "www.tokopedia.com",
        page_path: "/produk/kopi",
      });
      expect(sanitizeDestinationHost("javascript:alert(1)")).toBeNull();

      const lead = buildPsLeadSubmittedEvent({
        eventId: "lead_99",
        formId: "contact_default",
        pagePath: "/kontak?name=Budi",
      });
      expect(lead).toEqual({
        event: "ps_lead_submitted",
        ps_schema_version: 1,
        event_id: "lead_99",
        form_id: "contact_default",
        page_path: "/kontak",
      });
    });

    it("gates GTM loading & ps_* pushes strictly on analytics consent, revokes cleanly, and never double-fires GTM-mode direct vendors", () => {
      const timeline: string[] = [];
      const pushedEvents: PsDataLayerEventPayload[] = [];
      const directDispatches: string[] = [];

      const directAdapter: AnalyticsProviderAdapter = {
        loadProvider: (p) => timeline.push(`direct:load:${p}`),
        sendEvent: (p, _id, ev) => directDispatches.push(`${p}:${ev}`),
        revokeProvider: (p) => timeline.push(`direct:revoke:${p}`),
      };

      const gtmAdapter: AnalyticsGtmAdapter = {
        initConsentDefault: (d) => timeline.push(`gtm:default:${d.analytics_storage}:${d.ad_storage}`),
        updateConsentMode: (u) => timeline.push(`gtm:update:${u.analytics_storage}:${u.ad_storage}`),
        loadGtm: (id) => timeline.push(`gtm:load:${id}`),
        pushDataLayerEvent: (ev) => {
          pushedEvents.push(ev);
          timeline.push(`gtm:push:${ev.event}`);
        },
        revokeGtm: (id) => timeline.push(`gtm:revoke:${id}`),
      };

      const dispatcher = createAnalyticsSignalDispatcher({
        config: {
          ga4MeasurementId: "G-SHOULDSUPPRESS",
          metaPixelId: "123456789012345",
          tiktokPixelId: null,
        },
        adapter: directAdapter,
        gtm: {
          enabled: true,
          containerId: "GTM-ABC1234",
          vendorModes: { ga4: "gtm", meta: "direct", tiktok: "gtm" },
          pageType: "home",
          contentId: "home",
        },
        gtmAdapter,
        currentPath: () => "/",
      });

      // Before consent: default denied was pushed, ZERO GTM load and ZERO events!
      expect(timeline).toEqual(["gtm:default:denied:denied"]);
      dispatcher.dispatch("whatsapp_click", { item_id: "i1", placement: "hero" });
      expect(pushedEvents).toHaveLength(0);
      expect(directDispatches).toHaveLength(0);

      // Grant analytics + marketing consent -> updates consent BEFORE load, loads GTM + direct Meta (NEVER direct GA4!)
      dispatcher.updateConsent({
        version: 1,
        analytics: true,
        marketing: true,
        hasDecision: true,
      });

      const updateIdx = timeline.indexOf("gtm:update:granted:granted");
      const loadIdx = timeline.indexOf("gtm:load:GTM-ABC1234");
      expect(updateIdx).toBeGreaterThan(0);
      expect(loadIdx).toBeGreaterThan(updateIdx);
      expect(timeline).not.toContain("direct:load:ga4");
      expect(timeline).toContain("direct:load:meta");
      expect(pushedEvents.map((e) => e.event)).toEqual(["ps_page_view"]);

      // Lead submitted: requires persisted=true and fires once per leadId
      expect(dispatcher.dispatchLeadSubmitted({ leadId: 7, persisted: false }).ok).toBe(false);
      expect(dispatcher.dispatchLeadSubmitted({ leadId: 7, persisted: true, formId: "contact_default" }).ok).toBe(true);
      expect(dispatcher.dispatchLeadSubmitted({ leadId: 7, persisted: true, formId: "contact_default" }).ok).toBe(false);
      expect(pushedEvents.filter((e) => e.event === "ps_lead_submitted")).toHaveLength(1);

      // Revoke consent -> updates to denied, tears down GTM, stops further events
      dispatcher.updateConsent({ version: 1, analytics: false, marketing: false, hasDecision: false });
      expect(timeline).toContain("gtm:revoke:GTM-ABC1234");
      const countAfterRevoke = pushedEvents.length;
      dispatcher.dispatch("whatsapp_click", { item_id: "i2" });
      expect(pushedEvents.length).toBe(countAfterRevoke);
    });

    it("supports browser GTM adapter with nonce propagation and fault-isolated URL builders", () => {
      const win: AnalyticsBrowserWindow = {};
      const injected: { id: string; url: string; nonce?: string }[] = [];
      let removed = false;
      const adapter = createBrowserGtmAdapter(
        win,
        (id, url, nonce) => injected.push({ id, url, nonce }),
        () => {
          removed = true;
        },
      );
      adapter.loadGtm("GTM-ABC1234", "https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234", "", "nonce123456789012");
      expect(injected).toHaveLength(1);
      expect(injected[0]?.nonce).toBe("nonce123456789012");
      adapter.revokeGtm?.("GTM-ABC1234");
      expect(removed).toBe(true);

      expect(buildGtmScriptUrl("GTM-ABC1234")).toBe(
        "https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234",
      );
      expect(buildGtmNoscriptUrl("GTM-ABC1234")).toBe(
        "https://www.googletagmanager.com/ns.html?id=GTM-ABC1234",
      );
      expect(buildGtmScriptUrl("invalid")).toBeNull();
    });
  });

  describe("3. CSP Profiles (strict vs gtm-relaxed with per-response nonce)", () => {
    it("generates cryptographic nonces and selects gtm-relaxed ONLY for consented public GTM pages", () => {
      const n1 = generateCspNonce();
      const n2 = generateCspNonce();
      expect(isValidCspNonce(n1)).toBe(true);
      expect(isValidCspNonce(n2)).toBe(true);
      expect(n1).not.toBe(n2);

      expect(
        selectPublicCspProfile({
          surface: "tenant",
          statusCode: 200,
          gtmActive: true,
          hasAnalyticsConsent: true,
        }),
      ).toBe("gtm-relaxed");

      // Every negative gate stays strict:
      expect(
        selectPublicCspProfile({ surface: "tenant", statusCode: 200, gtmActive: true, hasAnalyticsConsent: false }),
      ).toBe("strict");
      expect(
        selectPublicCspProfile({ surface: "tenant", statusCode: 200, gtmActive: false, hasAnalyticsConsent: true }),
      ).toBe("strict");
      expect(
        selectPublicCspProfile({ surface: "app", statusCode: 200, gtmActive: true, hasAnalyticsConsent: true }),
      ).toBe("strict");
      expect(
        selectPublicCspProfile({ surface: "console", statusCode: 200, gtmActive: true, hasAnalyticsConsent: true }),
      ).toBe("strict");
      expect(
        selectPublicCspProfile({ surface: "tenant", isPreview: true, statusCode: 200, gtmActive: true, hasAnalyticsConsent: true }),
      ).toBe("strict");
      expect(
        selectPublicCspProfile({ surface: "tenant", statusCode: 503, gtmActive: true, hasAnalyticsConsent: true }),
      ).toBe("strict");
    });

    it("strict CSP excludes GTM/GA4/Meta/TikTok and unsafe-inline while strict, platform, & gtm-relaxed preserve Turnstile and nonced scripts", () => {
      const strict = buildStrictPublicCspHeader();
      expect(strict).not.toContain("googletagmanager.com");
      expect(strict).not.toContain("connect.facebook.net");
      expect(strict).not.toContain("analytics.tiktok.com");

      const strictScriptSrc = strict.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
      const strictFrameSrc = strict.split(";").find((d) => d.trim().startsWith("frame-src")) ?? "";
      expect(strictScriptSrc).not.toContain("'unsafe-inline'");
      expect(strictScriptSrc).toContain("https://challenges.cloudflare.com");
      expect(strictFrameSrc).toContain("https://challenges.cloudflare.com");
      expect(strictFrameSrc).toContain("https://www.youtube-nocookie.com");

      const nonce = generateCspNonce();
      const strictNonced = buildStrictPublicCspHeader(nonce);
      const strictNoncedScriptSrc =
        strictNonced.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
      expect(strictNoncedScriptSrc).toContain(`'nonce-${nonce}'`);
      expect(strictNoncedScriptSrc).not.toContain("'unsafe-inline'");
      expect(strictNoncedScriptSrc).toContain("https://challenges.cloudflare.com");
      expect(() => buildStrictPublicCspHeader("bad")).toThrow(/Invalid CSP nonce/);

      const platformCsp = buildPlatformSurfaceCspHeader(nonce);
      const platformScriptSrc =
        platformCsp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
      const platformStyleSrc =
        platformCsp.split(";").find((d) => d.trim().startsWith("style-src")) ?? "";
      expect(platformCsp).toContain("frame-ancestors 'self'");
      expect(platformCsp).toContain("base-uri 'self'");
      expect(platformCsp).toContain("form-action 'self'");
      expect(platformCsp).toContain("object-src 'none'");
      expect(platformCsp).toContain(
        "img-src 'self' data: blob: https://media.punyasitus.com https://i.ytimg.com",
      );
      expect(platformCsp).toContain("media-src 'self' blob: https://media.punyasitus.com");
      expect(platformCsp).toContain("connect-src 'self' https://challenges.cloudflare.com");
      expect(platformCsp).not.toContain("https:;");
      expect(platformStyleSrc.trim()).toBe("style-src 'self'");
      expect(platformScriptSrc).toContain(`'nonce-${nonce}'`);
      expect(platformScriptSrc).not.toContain("'unsafe-inline'");
      expect(platformScriptSrc).toContain("https://challenges.cloudflare.com");
      expect(platformCsp).not.toContain("googletagmanager.com");

      const marketingCsp = buildPlatformSurfaceCspHeader(nonce, {
        allowInlineStyles: true,
        platformDomain: "staging.punyasitus.com",
      });
      expect(marketingCsp).toContain("style-src 'self' 'unsafe-inline'");
      expect(marketingCsp).toContain("https://media.staging.punyasitus.com");

      const relaxed = buildRelaxedGtmCspHeader(nonce);
      expect(relaxed).toContain(`'nonce-${nonce}'`);
      expect(relaxed).toContain("https://www.googletagmanager.com");
      expect(relaxed).toContain("https://www.google-analytics.com");
      expect(relaxed).toContain("https://connect.facebook.net");
      expect(relaxed).toContain("https://analytics.tiktok.com");
      // script-src MUST NOT allow 'unsafe-inline', and BOTH script-src & frame-src preserve Turnstile + YouTube-nocookie
      const scriptSrcPart = relaxed.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
      const frameSrcPart = relaxed.split(";").find((d) => d.trim().startsWith("frame-src")) ?? "";
      expect(scriptSrcPart).not.toContain("'unsafe-inline'");
      expect(scriptSrcPart).toContain("https://challenges.cloudflare.com");
      expect(frameSrcPart).toContain("https://challenges.cloudflare.com");
      expect(frameSrcPart).toContain("https://www.youtube-nocookie.com");

      const sampleHtml = `<head><script type="application/json">{"a":1}</script><script>console.log(1)</script><script data-src="x" data-nonce="y">console.log(2)</script><script src="/app.js"></script><script nonce="keep">x()</script></head>`;
      const patched = injectNonceIntoInlineHtmlScripts(sampleHtml, nonce);
      expect(patched).toContain('<script type="application/json">{"a":1}</script>');
      expect(patched).toContain(`<script nonce="${nonce}">console.log(1)</script>`);
      expect(patched).toContain(`<script nonce="${nonce}" data-src="x" data-nonce="y">console.log(2)</script>`);
      expect(patched).toContain('<script src="/app.js"></script>');
      expect(patched).toContain('<script nonce="keep">x()</script>');

      const freshNonce = generateCspNonce();
      const rotated = rotateCspNonceInHtmlScripts(patched, nonce, freshNonce);
      expect(rotated).toContain(`<script nonce="${freshNonce}">console.log(1)</script>`);
      expect(rotated).toContain(`<script nonce="${freshNonce}" data-src="x" data-nonce="y">console.log(2)</script>`);
      expect(rotated).toContain('<script nonce="keep">x()</script>');
      expect(rotated).not.toContain(`nonce="${nonce}"`);
    });

    it("triggers exactly one loop-guarded reload on first-visit consent for a strict-CSP GTM page", () => {
      const store = new Map<string, string>();
      const fakeStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      };

      // 1. Pre-consent strict page + visitor grants analytics consent -> reload ONCE
      expect(
        shouldReloadForConsentedGtmCsp({
          gtmEnabled: true,
          cspProfile: "strict",
          ssrLoaded: false,
          nextAnalyticsGranted: true,
          pathname: "/layanan",
          storage: fakeStorage,
          nowMs: 1000,
        }),
      ).toBe(true);

      // 2. Immediate repeat within cooldown -> false (prevents reload loops)
      expect(
        shouldReloadForConsentedGtmCsp({
          gtmEnabled: true,
          cspProfile: "strict",
          ssrLoaded: false,
          nextAnalyticsGranted: true,
          pathname: "/layanan",
          storage: fakeStorage,
          nowMs: 2500,
        }),
      ).toBe(false);

      // 3. Already on gtm-relaxed or ssrLoaded -> false (no unnecessary reload)
      expect(
        shouldReloadForConsentedGtmCsp({
          gtmEnabled: true,
          cspProfile: "gtm-relaxed",
          ssrLoaded: true,
          nextAnalyticsGranted: true,
          pathname: "/layanan",
          storage: fakeStorage,
          nowMs: 30_000,
        }),
      ).toBe(false);

      // 4. Analytics denied or GTM disabled -> false
      expect(
        shouldReloadForConsentedGtmCsp({
          gtmEnabled: true,
          cspProfile: "strict",
          ssrLoaded: false,
          nextAnalyticsGranted: false,
          pathname: "/lain",
          storage: fakeStorage,
          nowMs: 30_000,
        }),
      ).toBe(false);
    });
  });

  describe("4. Committed GTM Container JSON Template CI Structure & Parity Check", () => {
    it("validates docs/gtm/punyasitus-container-template-v1.json structure and byte-for-byte parity", () => {
      const templatePath = path.join(REPO_ROOT, "docs/gtm/punyasitus-container-template-v1.json");
      expect(fs.existsSync(templatePath)).toBe(true);

      const rawText = fs.readFileSync(templatePath, "utf8");
      const parsed: unknown = JSON.parse(rawText);
      const check = validateGtmContainerTemplateJson(parsed);
      expect(check.errors).toEqual([]);
      expect(check.valid).toBe(true);

      // Exact parity with bundled Cloudflare Worker template
      expect(rawText).toBe(serializeGtmContainerTemplateJson());
      expect(parsed).toEqual(PUNYASITUS_GTM_CONTAINER_TEMPLATE);
    });
  });

  describe("5. Kill-Switch Owner Notification Email Template & UI Static Guards", () => {
    it("renders escaped Bahasa Indonesia gtm-kill-switch-owner-notice email", () => {
      const rendered = renderEmailTemplate("gtm-kill-switch-owner-notice", {
        recipientName: "Ibu <Sari>",
        tenantName: "Klinik Amanah",
        tenantHandle: "klinik-amanah",
        containerId: "GTM-ABC1234",
        reasonCategory: "malware",
        reason: "Skrip injeksi tidak sah terdeteksi pada kontainer <script>x</script>",
        analyticsSettingsUrl: "https://app.punyasitus.com/dashboard/klinik-amanah/settings/analytics",
      });
      expect(rendered.subject).toContain("Google Tag Manager dinonaktifkan");
      expect(rendered.html).toContain("GTM-ABC1234");
      expect(rendered.html).toContain("Malware / Skrip Berbahaya");
      expect(rendered.html).not.toContain("<script>x</script>");
      expect(rendered.html).toContain("&lt;script&gt;x&lt;/script&gt;");
      expect(rendered.text).toContain("pelacak langsung");
    });

    it("enforces zero @radix-ui, zero asChild, and zero runtime CREATE TABLE in TASK-076 UI/API files", () => {
      const filesToCheck = [
        "apps/web/src/pages/dashboard/[handle]/settings/analytics/_GtmSetupSection.tsx",
        "apps/web/src/pages/dashboard/[handle]/settings/analytics/_AnalyticsSettingsForm.tsx",
        "apps/web/src/pages/console/tenants/_TenantGtmKillSwitchCard.tsx",
        "apps/web/src/pages/console/tenants/_TenantDetailPanel.tsx",
        "apps/web/src/pages/api/tenants/[tenantId]/analytics/gtm.ts",
        "apps/web/src/pages/api/tenants/[tenantId]/analytics/gtm/template.ts",
        "apps/web/src/pages/api/console/tenants/[tenantId]/gtm.ts",
        "packages/db/src/analytics-settings/gtm.ts",
      ];
      for (const rel of filesToCheck) {
        const content = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
        expect(content, `${rel} must not import @radix-ui`).not.toMatch(/@radix-ui|from\s+["']radix-ui["']/);
        expect(content, `${rel} must not use asChild`).not.toMatch(/\basChild\b/);
        expect(content, `${rel} must not execute runtime CREATE TABLE`).not.toMatch(/CREATE\s+TABLE/i);
      }
    });
  });
});

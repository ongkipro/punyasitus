import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canLoadMapEmbed,
  canLoadVendorTracker,
  CONSENT_COOKIE_NAME,
  CONSENT_POLICY_VERSION,
  createDefaultConsentPreferences,
  parseConsentCookie,
  sanitizeVendorEventPayload,
  serializeConsentCookie,
  validateTenantSetCookieHeader,
  withdrawConsent,
} from "../../apps/web/src/core/privacy.ts";
import {
  DEFAULT_RETENTION_POLICY_MS,
  isTenantScopedR2Key,
  RETENTION_POLICY_DAYS,
} from "../../packages/db/src/privacy/index.ts";

const root = path.resolve(import.meta.dirname, "../..");

describe("TASK-031: Consent cookie isolation, vendor/map gating & redaction", () => {
  it("enforces __Host-ps_consent prefix, Path=/, Secure, SameSite=Lax, and forbids Domain=", () => {
    const prefs = {
      version: CONSENT_POLICY_VERSION,
      analytics: true,
      marketing: false,
      maps: true,
      updatedAt: "2026-11-22T12:00:00.000Z",
    };

    const setCookie = serializeConsentCookie(prefs);
    expect(setCookie.startsWith(`${CONSENT_COOKIE_NAME}=`)).toBe(true);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie.toLowerCase()).not.toContain("domain=");

    expect(validateTenantSetCookieHeader(setCookie)).toEqual({
      valid: true,
      violations: [],
    });

    // Rejects any cookie name lacking __Host- prefix
    expect(() =>
      serializeConsentCookie(prefs, { cookieName: "ps_consent" }),
    ).toThrow(/__Host-/);

    // Rejects untyped Domain= injection
    expect(() =>
      serializeConsentCookie(prefs, {
        domain: "situsku.click",
      } as unknown as Parameters<typeof serializeConsentCookie>[1]),
    ).toThrow(/Domain/);

    // Tenant Set-Cookie audit catches Domain= and non-__Host- consent cookies (PLAN §3.2)
    const domainViolation = validateTenantSetCookieHeader(
      "__Host-ps_consent=abc; Path=/; Domain=situsku.click; Secure",
    );
    expect(domainViolation.valid).toBe(false);
    expect(domainViolation.violations).toContain("FORBIDDEN_DOMAIN_ATTRIBUTE");

    const missingPrefixViolation = validateTenantSetCookieHeader(
      "ps_consent=abc; Path=/; Secure; SameSite=Lax",
    );
    expect(missingPrefixViolation.valid).toBe(false);
    expect(missingPrefixViolation.violations).toContain("MISSING_HOST_PREFIX");

    const missingSecureViolation = validateTenantSetCookieHeader(
      "__Host-ps_consent=abc; Path=/; SameSite=Lax",
    );
    expect(missingSecureViolation.valid).toBe(false);
    expect(missingSecureViolation.violations).toContain("MISSING_SECURE_ATTRIBUTE");
  });

  it("defaults strictly to opt-in (all false) when cookie is absent, malformed, or version-mismatched", () => {
    const empty = parseConsentCookie(null);
    expect(empty.hasDecision).toBe(false);
    expect(empty.needsReconsent).toBe(false);
    expect(empty.preferences).toEqual(createDefaultConsentPreferences());
    expect(canLoadVendorTracker(empty.preferences, "analytics")).toBe(false);
    expect(canLoadVendorTracker(empty.preferences, "marketing")).toBe(false);
    expect(canLoadMapEmbed(empty.preferences)).toBe(false);

    const malformed = parseConsentCookie("__Host-ps_consent=%7Bbroken-json");
    expect(malformed.hasDecision).toBe(false);
    expect(malformed.preferences.analytics).toBe(false);
    expect(malformed.preferences.marketing).toBe(false);
    expect(malformed.preferences.maps).toBe(false);

    const wrongTypes = parseConsentCookie(
      `__Host-ps_consent=${encodeURIComponent(
        JSON.stringify({
          version: 1,
          analytics: "yes",
          marketing: 1,
          maps: true,
          updatedAt: "2026-11-22T12:00:00.000Z",
        }),
      )}`,
    );
    expect(wrongTypes.hasDecision).toBe(false);
    expect(wrongTypes.preferences.maps).toBe(false);

    // Outdated policy version must NOT retroactively grant consent (PLAN §11.2)
    const oldVersionCookie = serializeConsentCookie({
      version: 1,
      analytics: true,
      marketing: true,
      maps: true,
      updatedAt: "2026-11-22T12:00:00.000Z",
    });
    const cookiePair = oldVersionCookie.split(";")[0]!;
    const reconsent = parseConsentCookie(cookiePair, { expectedVersion: 2 });
    expect(reconsent.hasDecision).toBe(false);
    expect(reconsent.needsReconsent).toBe(true);
    expect(reconsent.preferences).toEqual(createDefaultConsentPreferences(2));
    expect(canLoadVendorTracker(reconsent.preferences, "analytics", 2)).toBe(false);
    expect(canLoadMapEmbed(reconsent.preferences, 2)).toBe(false);
  });

  it("parses valid __Host-ps_consent from Cookie header and gates vendors/maps accurately", () => {
    const cookieHeader = `unrelated=1; ${
      serializeConsentCookie({
        version: CONSENT_POLICY_VERSION,
        analytics: true,
        marketing: false,
        maps: true,
        updatedAt: "2026-11-22T12:30:00.000Z",
      }).split(";")[0]
    }; other=2`;

    const parsed = parseConsentCookie(cookieHeader);
    expect(parsed.hasDecision).toBe(true);
    expect(parsed.needsReconsent).toBe(false);
    expect(canLoadVendorTracker(parsed.preferences, "analytics")).toBe(true);
    expect(canLoadVendorTracker(parsed.preferences, "marketing")).toBe(false);
    expect(canLoadMapEmbed(parsed.preferences)).toBe(true);

    // Passing stale preferences to gate helpers with newer expectedVersion denies loading
    expect(canLoadVendorTracker(parsed.preferences, "analytics", 2)).toBe(false);
    expect(canLoadMapEmbed(parsed.preferences, 2)).toBe(false);
  });

  it("withdraws consent cleanly by resetting all optional categories and expiring the host-only cookie", () => {
    const withdrawn = withdrawConsent({ now: new Date("2026-11-22T14:00:00.000Z") });
    expect(withdrawn.preferences).toEqual({
      version: CONSENT_POLICY_VERSION,
      analytics: false,
      marketing: false,
      maps: false,
      updatedAt: "2026-11-22T14:00:00.000Z",
    });
    expect(withdrawn.setCookie.startsWith(`${CONSENT_COOKIE_NAME}=`)).toBe(true);
    expect(withdrawn.setCookie).toContain("Max-Age=0");
    expect(withdrawn.setCookie).toContain("Path=/");
    expect(withdrawn.setCookie).toContain("Secure");
    expect(withdrawn.setCookie.toLowerCase()).not.toContain("domain=");
    expect(canLoadVendorTracker(withdrawn.preferences, "analytics")).toBe(false);
    expect(canLoadVendorTracker(withdrawn.preferences, "marketing")).toBe(false);
    expect(canLoadMapEmbed(withdrawn.preferences)).toBe(false);
  });

  it("strips lead fields, message text, PII patterns, and URL query strings from ad-provider event payloads", () => {
    const sanitized = sanitizeVendorEventPayload({
      event_name: "lead_submitted",
      event_id: "evt_01JTEST1234",
      page_url: "https://klinik-beta.situsku.click/layanan/konsultasi?utm_source=meta&email=budi@example.id&phone=081234567890#form",
      page_path: "/layanan/konsultasi?token=secret123&name=Budi",
      offering_type: "service",
      cta_mode: "inquiry",
      source_category: "campaign",
      content_category: "hubungi +6281299998888 atau budi@example.id",
      // Forbidden lead & PII fields
      name: "Budi Santoso",
      phone: "+6281234567890",
      phone_e164: "+6281234567890",
      email: "budi@example.id",
      message: "Halo, saya mau jadwal kontrol gigi besok pagi.",
      internal_notes: "VIP lead",
      lead_fields: { nik: "3201010101010001" },
      query_string: "?utm_campaign=secret",
      utm_source: "meta",
    });

    expect(sanitized).toEqual({
      event_name: "lead_submitted",
      event_id: "evt_01JTEST1234",
      page_url: "https://klinik-beta.situsku.click/layanan/konsultasi",
      page_path: "/layanan/konsultasi",
      offering_type: "service",
      cta_mode: "inquiry",
      source_category: "campaign",
    });

    const serialized = JSON.stringify(sanitized);
    for (const forbidden of [
      "Budi",
      "+6281234567890",
      "081234567890",
      "budi@example.id",
      "kontrol gigi",
      "VIP lead",
      "3201010101010001",
      "utm_source",
      "token=secret123",
      "?",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    // Rejects javascript: URLs
    const xssSanitized = sanitizeVendorEventPayload({
      event_name: "external_click",
      page_url: "javascript:alert(1)",
    });
    expect(xssSanitized).toEqual({ event_name: "external_click" });
  });

  it("matches PLAN §5 retention policy constants and enforces strict tenant R2 key scoping", () => {
    expect(RETENTION_POLICY_DAYS.leads).toBe(180);
    expect(RETENTION_POLICY_DAYS.dedupHours).toBe(24);
    expect(RETENTION_POLICY_DAYS.analyticsDailyAndHourly).toBe(395);
    expect(RETENTION_POLICY_DAYS.tenantActivityLog).toBe(90);
    expect(RETENTION_POLICY_DAYS.quarantineHours).toBe(24);
    expect(RETENTION_POLICY_DAYS.trashedContentAndMedia).toBe(30);
    expect(DEFAULT_RETENTION_POLICY_MS.leadsMs).toBe(180 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_RETENTION_POLICY_MS.dedupMs).toBe(24 * 60 * 60 * 1000);

    expect(isTenantScopedR2Key("tenant_a", "t/tenant_a/quarantine/file.jpg")).toBe(true);
    expect(isTenantScopedR2Key("tenant_a", "t/tenant_b/quarantine/file.jpg")).toBe(false);
    expect(isTenantScopedR2Key("tenant_a", "t/tenant_a/../tenant_b/file.jpg")).toBe(false);
    expect(isTenantScopedR2Key("tenant_a", "global/file.jpg")).toBe(false);
  });

  it("keeps Consent.astro free of forbidden Radix/BaseUI/admin-CSS/Sparkles references", () => {
    const consentSource = fs.readFileSync(
      path.join(root, "apps/web/src/components/Consent.astro"),
      "utf8",
    );
    expect(consentSource).not.toMatch(/@radix-ui\//);
    expect(consentSource).not.toMatch(/\basChild\b/);
    expect(consentSource).not.toMatch(/\bSparkles(?:Icon)?\b/);
    expect(consentSource).not.toContain("@base-ui/react");
    expect(consentSource).not.toContain("styles/admin");
    expect(consentSource).toContain("__Host-ps_consent");
    expect(consentSource).toContain("Terima semua");
    expect(consentSource).toContain("Tolak opsional");
    expect(consentSource).toContain("Atur preferensi");
    expect(consentSource).toContain("Ubah / cabut izin privasi");
  });

  it("documents complete UU 27/2022 DSR, breach, subprocessor, tombstone replay, and DEC-047 gate in docs/operations/privacy.md", () => {
    const docPath = path.join(root, "docs/operations/privacy.md");
    expect(fs.existsSync(docPath)).toBe(true);
    const md = fs.readFileSync(docPath, "utf8");

    // DSR & SLA (Art. 30, 32, 40, 41)
    expect(md).toContain("72 hours");
    expect(md).toContain("3 x 24 hours");
    expect(md).toMatch(/Art\.\s*30,\s*32,\s*40,\s*41/);
    expect(md).toMatch(/DSR Request Log Schema/i);
    expect(md).toMatch(/Tenant Routing/i);

    // Breach notification (Art. 46)
    expect(md).toMatch(/Art\.\s*46/);
    expect(md).toMatch(/without delay/i);
    expect(md).toMatch(/Platform-controlled data/i);
    expect(md).toMatch(/Processor data/i);

    // Subprocessors & Art. 56 cross-border register
    expect(md).toMatch(/Art\.\s*56/);
    for (const subprocessor of [
      "Cloudflare",
      "AutoLaris",
      "Google OAuth",
      "Resend",
      "Telegram Bot API",
      "Workers AI",
    ]) {
      expect(md).toContain(subprocessor);
    }

    // Tombstone replay & DEC-047 pre-launch gate
    expect(md).toContain("deletion_tombstones");
    expect(md).toContain("replayDeletionTombstones");
    expect(md).toContain("DEC-047");
    expect(md).toContain("PP 33/2026");
    expect(md).toMatch(/block production launch/i);
  });
});

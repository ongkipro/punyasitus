import fs from "node:fs";
import path from "node:path";
import {
  buildSafeMailtoUrl,
  buildSupportPrefilledMessage,
  buildSupportWhatsAppUrl,
  DEFAULT_SUPPORT_FALLBACK_HANDLE,
  DEFAULT_SUPPORT_FALLBACK_SCREEN,
  DEFAULT_SUPPORT_HOURS,
  DEFAULT_SUPPORT_RESPONSE_TARGET,
  detectSupportSensitiveDataLeaks,
  formatIndonesianWhatsAppDisplay,
  resolveDashboardSupportModel,
  resolvePlatformSupportSettings,
  sanitizeSupportHandle,
  sanitizeSupportScreenName,
} from "@punyasitus/core/support/index";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-105 unit — WhatsApp support link sanitization, published hours & agency-first routing", () => {
  it("builds a single-encoded wa.me URL containing ONLY sanitized website handle and screen name", () => {
    const result = buildSupportWhatsAppUrl({
      phone: "0812-3456-7890",
      handle: "kopi-nusantara",
      screen: "settings_domains",
    });

    expect(result).not.toBeNull();
    expect(result!.phone).toBe("6281234567890");
    expect(result!.handle).toBe("kopi-nusantara");
    expect(result!.screenName).toBe("Domain Kustom & DNS");
    expect(result!.message).toBe(
      "Halo, saya butuh bantuan untuk situs kopi-nusantara, halaman Domain Kustom & DNS.",
    );

    const parsed = new URL(result!.url);
    expect(parsed.origin).toBe("https://wa.me");
    expect(parsed.pathname).toBe("/6281234567890");
    expect(parsed.searchParams.get("text")).toBe(result!.message);
    // Must never double-encode `%20` into `%2520`
    expect(result!.url).not.toContain("%2520");
    expect(detectSupportSensitiveDataLeaks(result!.message)).toEqual([]);
  });

  it("maps dashboard URL paths cleanly while stripping query params, hashes, and tokens", () => {
    expect(
      sanitizeSupportScreenName(
        "/dashboard/kopi-nusantara/settings/domains?session=abc1234567890&csrf=xyz#token=secret",
      ),
    ).toEqual({
      screenName: "Domain Kustom & DNS",
      screenId: "settings_domains",
    });

    expect(sanitizeSupportScreenName("/dashboard/kopi-nusantara/billing?invoice=1")).toEqual({
      screenName: "Tagihan & Langganan",
      screenId: "billing",
    });

    expect(sanitizeSupportHandle("https://kopi-nusantara.situsku.click/admin?token=123")).toBe(
      "kopi-nusantara",
    );

    // Idempotent on Indonesian labels containing "&"
    expect(sanitizeSupportScreenName("Domain Kustom & DNS")).toEqual({
      screenName: "Domain Kustom & DNS",
      screenId: null,
    });
  });

  it("strictly strips session tokens, CSRF tokens, passwords, API keys, cookies, URLs, emails, and visitor PII from noisy/hostile inputs", () => {
    const hostileScreens = [
      "Pengaturan password=SuperSecret99! csrf_token=tok_1234567890abcdef",
      "Leads visitor=budi@example.com phone=+6281299998888 https://evil.example/steal?k=1",
      "Tagihan Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.sig1234567890",
      "Editor __Host-ps_session=abcdef1234567890abcdef sk_live_secretkey99887766",
      "Halaman <script>alert(1)</script> api_key=ghp_1234567890abcdef123456 081355551234",
      "password=OnlySecret123&token=9f86d081884c7d659a2feaa0c55ad015",
    ];

    const forbiddenFragments = [
      "SuperSecret99",
      "tok_1234567890abcdef",
      "budi@example.com",
      "6281299998888",
      "evil.example",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "__Host-ps_session",
      "abcdef1234567890abcdef",
      "sk_live_secretkey99887766",
      "<script>",
      "ghp_1234567890abcdef123456",
      "081355551234",
      "OnlySecret123",
      "9f86d081884c7d659a2feaa0c55ad015",
    ];

    for (const rawScreen of hostileScreens) {
      const built = buildSupportPrefilledMessage("kopi-nusantara", rawScreen);
      for (const secret of forbiddenFragments) {
        expect(built.message).not.toContain(secret);
      }
      expect(detectSupportSensitiveDataLeaks(built.message)).toEqual([]);
      expect(built.message).toContain("situs kopi-nusantara");
    }

    // Hostile handles carrying credentials or opaque tokens fall back safely
    expect(sanitizeSupportHandle("password=TopSecret123")).toBe(DEFAULT_SUPPORT_FALLBACK_HANDLE);
    expect(sanitizeSupportHandle("eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe(
      DEFAULT_SUPPORT_FALLBACK_HANDLE,
    );
    expect(sanitizeSupportHandle("9f86d081884c7d659a2feaa0c55ad015")).toBe(
      DEFAULT_SUPPORT_FALLBACK_HANDLE,
    );
    expect(sanitizeSupportScreenName("   ")).toEqual({
      screenName: DEFAULT_SUPPORT_FALLBACK_SCREEN,
      screenId: null,
    });
  });

  it("returns null wa.me URL when platform or agency WhatsApp number is empty or invalid", () => {
    expect(
      buildSupportWhatsAppUrl({ phone: "", handle: "kopi-nusantara", screen: "overview" }),
    ).toBeNull();
    expect(
      buildSupportWhatsAppUrl({ phone: "+14155550199", handle: "kopi-nusantara", screen: "overview" }),
    ).toBeNull();
    expect(
      buildSupportWhatsAppUrl({ phone: "not-a-phone", handle: "kopi-nusantara", screen: "overview" }),
    ).toBeNull();
  });

  it("resolves platform support hours, response target, and formatted phone from platform_settings with safe defaults", () => {
    const fallback = resolvePlatformSupportSettings(null);
    expect(fallback.whatsappConfigured).toBe(false);
    expect(fallback.whatsappNumber).toBeNull();
    expect(fallback.supportHours).toBe(DEFAULT_SUPPORT_HOURS);
    expect(fallback.supportResponseTarget).toBe(DEFAULT_SUPPORT_RESPONSE_TARGET);

    const configured = resolvePlatformSupportSettings({
      salesWhatsapp: "+62 812-9876-5432",
      supportEmail: "Support@PunyaSitus.com",
      supportHours: "Senin–Jumat 09:00–17:00 WIB, Sabtu 09:00–13:00 WIB",
      supportResponseTarget: "< 2 jam kerja",
      configured: true,
    });
    expect(configured.whatsappConfigured).toBe(true);
    expect(configured.whatsappNumber).toBe("6281298765432");
    expect(configured.whatsappDisplay).toBe("+62 812-9876-5432");
    expect(configured.supportEmail).toBe("support@punyasitus.com");
    expect(configured.supportHours).toBe("Senin–Jumat 09:00–17:00 WIB, Sabtu 09:00–13:00 WIB");
    expect(configured.supportResponseTarget).toBe("< 2 jam kerja");
    expect(formatIndonesianWhatsAppDisplay("6281298765432")).toBe("+62 812-9876-5432");
  });

  it("routes non-agency websites to platform support and agency-managed websites to agency contact FIRST", () => {
    const platformSettings = {
      salesWhatsapp: "6281298765432",
      supportEmail: "support@punyasitus.com",
      supportHours: "Senin–Jumat 09:00–17:00 WIB, Sabtu 09:00–13:00 WIB",
      supportResponseTarget: "< 2 jam kerja",
      configured: true,
    };

    // 1. Standard website -> platform support primary
    const platformVm = resolveDashboardSupportModel({
      handle: "kopi-nusantara",
      screen: "settings_domains",
      platformSettings,
    });
    expect(platformVm.mode).toBe("platform");
    expect(platformVm.primaryChannel.kind).toBe("platform");
    expect(platformVm.primaryChannel.whatsappNumber).toBe("6281298765432");
    expect(platformVm.primaryChannel.whatsappUrl).toContain("https://wa.me/6281298765432?text=");
    expect(platformVm.platformChannel.supportHours).toBe(
      "Senin–Jumat 09:00–17:00 WIB, Sabtu 09:00–13:00 WIB",
    );
    expect(platformVm.platformChannel.responseTarget).toBe("< 2 jam kerja");

    // 2. Agency-managed website with agency WA + email -> agency contact FIRST
    const agencyVm = resolveDashboardSupportModel({
      handle: "klinik-harapan",
      screen: "offering",
      platformSettings,
      agencyContact: {
        agencyId: "agn_nusantara_01",
        agencyName: "Agensi Digital Nusantara",
        whatsappNumber: "0813-5555-1234",
        email: "cs@agensinusantara.id",
        supportHours: "Senin–Sabtu 08:30–18:00 WIB",
      },
    });
    expect(agencyVm.mode).toBe("agency_first");
    expect(agencyVm.primaryChannel.kind).toBe("agency");
    if (agencyVm.primaryChannel.kind === "agency") {
      expect(agencyVm.primaryChannel.agencyName).toBe("Agensi Digital Nusantara");
      expect(agencyVm.primaryChannel.whatsappNumber).toBe("6281355551234");
      expect(agencyVm.primaryChannel.whatsappUrl).toContain("https://wa.me/6281355551234?text=");
      const decoded = new URL(agencyVm.primaryChannel.whatsappUrl!).searchParams.get("text");
      expect(decoded).toBe(
        "Halo, saya butuh bantuan untuk situs klinik-harapan, halaman Katalog Penawaran.",
      );
      expect(agencyVm.primaryChannel.email).toBe("cs@agensinusantara.id");
      expect(agencyVm.primaryChannel.mailtoUrl).toContain("mailto:cs@agensinusantara.id");
    }
    // Platform support stays available only as secondary fallback
    expect(agencyVm.platformChannel.whatsappNumber).toBe("6281298765432");

    // 3. Agency-managed website without WA (email only) -> still agency_first with clear fallback note
    const agencyEmailOnlyVm = resolveDashboardSupportModel({
      handle: "klinik-harapan",
      screen: "leads",
      platformSettings,
      agencyContact: {
        agencyId: "agn_nusantara_02",
        agencyName: "Studio Web Merdeka",
        email: "bantuan@studiomerdeka.id",
      },
    });
    expect(agencyEmailOnlyVm.mode).toBe("agency_first");
    expect(agencyEmailOnlyVm.primaryChannel.kind).toBe("agency");
    if (agencyEmailOnlyVm.primaryChannel.kind === "agency") {
      expect(agencyEmailOnlyVm.primaryChannel.whatsappUrl).toBeNull();
      expect(agencyEmailOnlyVm.primaryChannel.email).toBe("bantuan@studiomerdeka.id");
      expect(agencyEmailOnlyVm.primaryChannel.fallbackNote).toContain("Studio Web Merdeka");
    }
  });

  it("rejects hostile mailto: header-injection emails and bounds huge 100 KB inputs against ReDoS", () => {
    const hostileEmails = [
      "x?bcc=attacker@evil.com",
      "support@agensi.id?bcc=attacker@evil.com",
      "support@agensi.id&body=phish",
      "support@agensi.id#fragment",
      "support@agensi.id\r\nBcc:evil@evil.com",
      "support%20@agensi.id",
      "support..bad@agensi.id",
      "support@agensi..id",
    ];

    for (const badEmail of hostileEmails) {
      expect(
        buildSafeMailtoUrl(badEmail, "kopi-nusantara", "settings_domains"),
        `Expected null for hostile email ${badEmail}`,
      ).toBeNull();

      const vm = resolveDashboardSupportModel({
        handle: "kopi-nusantara",
        screen: "settings_domains",
        platformSettings: {
          salesWhatsapp: "6281298765432",
          supportEmail: badEmail,
          configured: true,
        },
        agencyContact: {
          agencyId: "agn_bad_email",
          agencyName: "Agensi Uji",
          email: badEmail,
        },
      });
      expect(vm.platformChannel.email).toBeNull();
      expect(vm.platformChannel.mailtoUrl).toBeNull();
      expect(vm.primaryChannel.email).toBeNull();
      expect(vm.primaryChannel.mailtoUrl).toBeNull();
    }

    // Valid email produces clean RFC 6068 mailto URL
    const validMailto = buildSafeMailtoUrl(
      "CS+Help@Agensi-Nusantara.id",
      "kopi-nusantara",
      "settings_domains",
    );
    expect(validMailto).toBe(
      `mailto:cs%2Bhelp@agensi-nusantara.id?subject=${encodeURIComponent(
        "Bantuan situs kopi-nusantara (Domain Kustom & DNS)",
      )}`,
    );

    // 100 KB non-@ inputs must complete instantaneously (< 10ms) with zero quadratic regex blowup
    const hugeDots = "a.".repeat(50_000);
    const hugeChars = "a".repeat(100_000);
    const startMs = performance.now();
    const screenRes1 = sanitizeSupportScreenName(hugeDots);
    const screenRes2 = sanitizeSupportScreenName(hugeChars);
    const handleRes1 = sanitizeSupportHandle(hugeDots);
    const handleRes2 = sanitizeSupportHandle(hugeChars);
    const elapsedMs = performance.now() - startMs;

    expect(elapsedMs).toBeLessThan(10);
    expect(screenRes1.screenName.length).toBeLessThanOrEqual(80);
    expect(screenRes2.screenName.length).toBeLessThanOrEqual(80);
    expect(handleRes1.length).toBeLessThanOrEqual(63);
    expect(handleRes2.length).toBeLessThanOrEqual(63);
  });

  it("enforces DEC-036 UI hygiene (zero @radix-ui, zero asChild, zero Sparkles, zero runtime DDL)", () => {
    const dirsToScan = [
      path.join(REPO_ROOT, "packages/core/src/support"),
      path.join(REPO_ROOT, "apps/web/src/components/admin/help"),
      path.join(REPO_ROOT, "apps/web/src/pages/console/settings"),
    ];

    for (const dir of dirsToScan) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const full = path.join(dir, entry.name);
        const content = fs.readFileSync(full, "utf8");
        expect(content, `Forbidden @radix-ui import in ${full}`).not.toMatch(/@radix-ui\//);
        expect(content, `Forbidden asChild prop in ${full}`).not.toMatch(/\basChild\b/);
        expect(content, `Forbidden Sparkles icon in ${full}`).not.toMatch(/\bSparkles(?:Icon)?\b/);
        expect(content, `Forbidden runtime CREATE TABLE in ${full}`).not.toMatch(/CREATE\s+TABLE/i);
      }
    }
  });
});

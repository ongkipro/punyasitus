import fs from "node:fs";
import path from "node:path";
import {
  AFFILIATE_COOKIE_NAME,
  AFFILIATE_COOKIE_TTL_SECONDS,
  AffiliateValidationError,
  buildAffiliateReferralLink,
  buildAffiliateSetCookieHeader,
  computeNormalizedEmailHash,
  computePayoutAccountNumberHash,
  computePayoutIdentityHash,
  createSignedAffiliateCookieValue,
  extractCookieValueFromHeader,
  isAffiliateApprovedStatus,
  isValidAffiliateReferralCode,
  maskPayoutAccountNumber,
  normalizeAffiliateReferralCode,
  normalizeEmailForAntiAbuse,
  parseAffiliateReferralQueryParam,
  POWERED_BY_BADGE_TEXT,
  readVerifiedAffiliateCookieFromHeader,
  renderTenantPoweredByBadgeHtml,
  resolveTenantPoweredByBadge,
  validateAffiliateApplicationPayload,
  verifySignedAffiliateCookieValue,
} from "@punyasitus/core/affiliates/index";
import {
  AFFILIATES_MIGRATION,
  AFFILIATES_MIGRATION_SQL,
} from "@punyasitus/db/affiliates/migrations";
import { describe, expect, it } from "vitest";
import { resolveAffiliateCookieSecret } from "../../apps/web/src/middleware/affiliate-referral.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATION_SQL_PATH = path.join(ROOT, "packages/db/migrations/platform/0031_affiliates.sql");
const TEST_SECRET = "task084-unit-affiliate-cookie-secret-0123456789abcdef";
const BASE_NOW_MS = Date.UTC(2026, 4, 1, 12, 0, 0);

describe("TASK-084 migration parity (0031_affiliates.sql)", () => {
  it("matches packages/db/migrations/platform/0031_affiliates.sql byte-for-byte", () => {
    expect(fs.existsSync(MIGRATION_SQL_PATH)).toBe(true);
    const diskSql = fs.readFileSync(MIGRATION_SQL_PATH, "utf8");
    expect(AFFILIATES_MIGRATION_SQL).toBe(diskSql);
    expect(AFFILIATES_MIGRATION.version).toBe(31);
    expect(AFFILIATES_MIGRATION.name).toBe("0031_affiliates");
    expect(AFFILIATES_MIGRATION.sql).toBe(diskSql);
  });
});

describe("TASK-084 referral code & application payload validation", () => {
  it("validates and normalizes public referral codes while rejecting pending placeholders & unsafe inputs", () => {
    expect(normalizeAffiliateReferralCode("mitra_01")).toBe("MITRA_01");
    expect(normalizeAffiliateReferralCode("  Partner-2026  ")).toBe("PARTNER-2026");
    expect(isValidAffiliateReferralCode("ABCD")).toBe(true);
    expect(isValidAffiliateReferralCode("a".repeat(32))).toBe(true);

    // Invalid formats
    expect(normalizeAffiliateReferralCode("abc")).toBeNull(); // < 4 chars
    expect(normalizeAffiliateReferralCode("a".repeat(33))).toBeNull(); // > 32 chars
    expect(normalizeAffiliateReferralCode("__pending_01JTEST")).toBeNull();
    expect(normalizeAffiliateReferralCode("__PENDING_01JTEST")).toBeNull();
    expect(normalizeAffiliateReferralCode("evil<script>")).toBeNull();
    expect(normalizeAffiliateReferralCode("https://evil.com")).toBeNull();
    expect(normalizeAffiliateReferralCode("foo bar")).toBeNull();
    expect(normalizeAffiliateReferralCode("")).toBeNull();
    expect(normalizeAffiliateReferralCode(null)).toBeNull();

    expect(buildAffiliateReferralLink("mitra_01")).toBe("https://punyasitus.com/?ref=MITRA_01");
  });

  it("validates affiliate application payloads strictly and masks payout account numbers", () => {
    const valid = validateAffiliateApplicationPayload({
      payoutBankCode: " bca ",
      payoutAccountNumber: "1234-5678-90",
      payoutAccountHolder: "  Budi   Santoso  ",
      termsAccepted: true,
      termsVersion: "2026-11-v1",
    });

    expect(valid).toEqual({
      payoutBankCode: "BCA",
      payoutAccountNumberDigits: "1234567890",
      payoutAccountMasked: "******7890",
      payoutAccountHolder: "Budi Santoso",
      termsAccepted: true,
      termsVersion: "2026-11-v1",
    });

    expect(maskPayoutAccountNumber("123456")).toBe("****3456");
    expect(maskPayoutAccountNumber("1234")).toBe("****");

    // Rejects termsAccepted !== true
    expect(() =>
      validateAffiliateApplicationPayload({
        payoutBankCode: "BCA",
        payoutAccountNumber: "1234567890",
        payoutAccountHolder: "Budi Santoso",
        termsAccepted: false,
        termsVersion: "2026-11-v1",
      }),
    ).toThrowError(AffiliateValidationError);

    // Rejects forged privileged fields
    for (const forbidden of [
      { status: "active" },
      { referralCode: "CUSTOM" },
      { userId: "usr_other" },
      { payoutIdentityHash: "abc" },
      { approvedBy: "op_1" },
    ]) {
      try {
        validateAffiliateApplicationPayload({
          payoutBankCode: "BCA",
          payoutAccountNumber: "1234567890",
          payoutAccountHolder: "Budi Santoso",
          termsAccepted: true,
          termsVersion: "2026-11-v1",
          ...forbidden,
        });
        throw new Error("Expected AffiliateValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(AffiliateValidationError);
        expect((err as AffiliateValidationError).code).toBe("FORBIDDEN_CLIENT_FIELD");
      }
    }

    // Rejects unknown fields
    expect(() =>
      validateAffiliateApplicationPayload({
        payoutBankCode: "BCA",
        payoutAccountNumber: "1234567890",
        payoutAccountHolder: "Budi Santoso",
        termsAccepted: true,
        termsVersion: "2026-11-v1",
        extraUnknown: "nope",
      }),
    ).toThrowError(AffiliateValidationError);
  });

  it("canonicalizes emails and payout identities deterministically for anti-self-referral matching", async () => {
    expect(normalizeEmailForAntiAbuse("Budi.Santoso+promo@Gmail.com")).toBe(
      "budisantoso@gmail.com",
    );
    expect(normalizeEmailForAntiAbuse("b.u.d.i.s.a.n.t.o.s.o+test@googlemail.com")).toBe(
      "budisantoso@gmail.com",
    );
    expect(normalizeEmailForAntiAbuse("Sales+aff@Perusahaan.co.id")).toBe("sales@perusahaan.co.id");

    const hEmail1 = await computeNormalizedEmailHash("Budi.Santoso+aff@gmail.com");
    const hEmail2 = await computeNormalizedEmailHash("budisantoso@googlemail.com");
    expect(hEmail1).toBe(hEmail2);

    const hPayout1 = await computePayoutIdentityHash({
      payoutBankCode: "bca",
      payoutAccountNumber: "1234-5678-90",
    });
    const hPayout2 = await computePayoutIdentityHash({
      payoutBankCode: "BCA",
      payoutAccountNumber: "1234 5678 90",
    });
    const hPayoutOtherBank = await computePayoutIdentityHash({
      payoutBankCode: "MANDIRI",
      payoutAccountNumber: "1234567890",
    });
    expect(hPayout1).toBe(hPayout2);
    expect(hPayout1).not.toBe(hPayoutOtherBank);

    const acctHash = await computePayoutAccountNumberHash("BCA", "1234-5678-90");
    expect(acctHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("TASK-084 first-party HMAC-signed referral cookie & 30-day server-side TTL", () => {
  it("signs, parses, and verifies valid ps_ref cookies within 30 days with zero visitor PII", async () => {
    const signed = await createSignedAffiliateCookieValue({
      referralCode: "mitra_jakarta",
      secret: TEST_SECRET,
      source: "cookie",
      nowMs: BASE_NOW_MS,
    });

    expect(signed.startsWith("v1.MITRA_JAKARTA.")).toBe(true);
    // Contains only version, code, unix sec, source tag, signature (5 dot-separated parts)
    expect(signed.split(".")).toHaveLength(5);

    const setCookie = buildAffiliateSetCookieHeader({
      value: signed,
      domain: "punyasitus.com",
      secure: true,
    });
    expect(setCookie).toContain(`${AFFILIATE_COOKIE_NAME}=${signed}`);
    expect(setCookie).toContain(`Max-Age=${AFFILIATE_COOKIE_TTL_SECONDS}`);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Domain=punyasitus.com");
    expect(setCookie).toContain("Secure");

    const loopbackCookie = buildAffiliateSetCookieHeader({
      value: signed,
      domain: null,
      secure: false,
    });
    expect(loopbackCookie).not.toContain("Domain=");
    expect(loopbackCookie).not.toContain("Secure");

    const rawHeader = `other=1; ${AFFILIATE_COOKIE_NAME}=${signed}; theme=light`;
    expect(extractCookieValueFromHeader(rawHeader)).toBe(signed);

    // Valid at exact 30-day boundary
    const atBoundary = await readVerifiedAffiliateCookieFromHeader({
      cookieHeader: rawHeader,
      secret: TEST_SECRET,
      nowMs: BASE_NOW_MS + AFFILIATE_COOKIE_TTL_SECONDS * 1000,
    });
    expect(atBoundary.valid).toBe(true);
    if (atBoundary.valid) {
      expect(atBoundary.referralCode).toBe("MITRA_JAKARTA");
      expect(atBoundary.source).toBe("cookie");
    }

    // Expired at 30 days + 1 second
    const expired = await readVerifiedAffiliateCookieFromHeader({
      cookieHeader: rawHeader,
      secret: TEST_SECRET,
      nowMs: BASE_NOW_MS + (AFFILIATE_COOKIE_TTL_SECONDS + 1) * 1000,
    });
    expect(expired).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects tampered cookies, wrong secrets, and far-future timestamps", async () => {
    const signed = await createSignedAffiliateCookieValue({
      referralCode: "PARTNER_A",
      secret: TEST_SECRET,
      nowMs: BASE_NOW_MS,
    });

    // Tampered referral code
    const parts = signed.split(".");
    const tamperedCode = [parts[0], "PARTNER_B", parts[2], parts[3], parts[4]].join(".");
    expect(
      await verifySignedAffiliateCookieValue({
        value: tamperedCode,
        secret: TEST_SECRET,
        nowMs: BASE_NOW_MS,
      }),
    ).toEqual({ valid: false, reason: "invalid_signature" });

    // Tampered timestamp
    const tamperedTs = [parts[0], parts[1], String(Number(parts[2]) + 86400), parts[3], parts[4]].join(".");
    expect(
      await verifySignedAffiliateCookieValue({
        value: tamperedTs,
        secret: TEST_SECRET,
        nowMs: BASE_NOW_MS,
      }),
    ).toEqual({ valid: false, reason: "invalid_signature" });

    // Wrong secret
    expect(
      await verifySignedAffiliateCookieValue({
        value: signed,
        secret: "completely-different-secret-0123456789abcdef",
        nowMs: BASE_NOW_MS,
      }),
    ).toEqual({ valid: false, reason: "invalid_signature" });

    // Future timestamp beyond 5m skew
    const futureSigned = await createSignedAffiliateCookieValue({
      referralCode: "PARTNER_A",
      secret: TEST_SECRET,
      nowMs: BASE_NOW_MS + 10 * 60 * 1000,
    });
    expect(
      await verifySignedAffiliateCookieValue({
        value: futureSigned,
        secret: TEST_SECRET,
        nowMs: BASE_NOW_MS,
      }),
    ).toEqual({ valid: false, reason: "future_timestamp" });

    // Query param parsing
    expect(parseAffiliateReferralQueryParam(new URLSearchParams("ref=mitra_01"))).toEqual({
      referralCode: "MITRA_01",
      source: "cookie",
    });
    expect(
      parseAffiliateReferralQueryParam(new URLSearchParams("ref=mitra_01&src=footer_badge")),
    ).toEqual({
      referralCode: "MITRA_01",
      source: "footer_badge",
    });
    expect(parseAffiliateReferralQueryParam(new URLSearchParams("ref=bad!code"))).toBeNull();
  });

  it("resolves affiliate cookie secret preferring AFFILIATE_COOKIE_SECRET, failing closed outside local", () => {
    const dedicated = "dedicated-affiliate-cookie-secret-0123456789abcdef";
    const authSec = "auth-fallback-cookie-secret-0123456789abcdef";

    expect(
      resolveAffiliateCookieSecret({
        APP_ENV: "production",
        AFFILIATE_COOKIE_SECRET: dedicated,
        AUTH_SECRET: authSec,
      }),
    ).toBe(dedicated);

    expect(
      resolveAffiliateCookieSecret({
        APP_ENV: "production",
        AUTH_SECRET: authSec,
      }),
    ).toBe(authSec);

    // Fails closed in test/staging/production when no secret is provided
    expect(resolveAffiliateCookieSecret({ APP_ENV: "test" })).toBeNull();
    expect(resolveAffiliateCookieSecret({ APP_ENV: "staging" })).toBeNull();
    expect(resolveAffiliateCookieSecret({ APP_ENV: "production" })).toBeNull();

    // Local dev fallback only when APP_ENV === "local"
    expect(resolveAffiliateCookieSecret({ APP_ENV: "local" })).toBeTruthy();
  });
});

describe("TASK-084 minimalist 'Dibuat dengan PunyaSitus' tenant footer badge", () => {
  it("ALWAYS renders plain visible badge on trial sites and ignores hide/ref overrides", () => {
    const trialBadge = resolveTenantPoweredByBadge({
      tenantStatus: "trial",
      hidePoweredByBadge: true,
      affiliateReferralCode: "MITRA_PRO",
      affiliateStatus: "active",
    });

    expect(trialBadge).toEqual({
      visible: true,
      canHide: false,
      canAttachAffiliateRef: false,
      text: POWERED_BY_BADGE_TEXT,
      href: "https://punyasitus.com",
      referralCode: null,
      isAffiliateLinked: false,
      rel: "noopener noreferrer",
    });

    const html = renderTenantPoweredByBadgeHtml(trialBadge);
    expect(html).toContain('href="https://punyasitus.com"');
    expect(html).toContain("Dibuat dengan PunyaSitus");
    expect(html).not.toContain("?ref=");
  });

  it("allows paid (active) sites to hide in 1 click or attach their approved affiliate ?ref=<code>", () => {
    expect(isAffiliateApprovedStatus("active")).toBe(true);
    expect(isAffiliateApprovedStatus("approved")).toBe(true);
    expect(isAffiliateApprovedStatus("pending")).toBe(false);
    expect(isAffiliateApprovedStatus("suspended")).toBe(false);
    expect(isAffiliateApprovedStatus("rejected")).toBe(false);

    // 1-click hide on paid site
    const hidden = resolveTenantPoweredByBadge({
      tenantStatus: "active",
      hidePoweredByBadge: true,
      affiliateReferralCode: "MITRA_PRO",
      affiliateStatus: "active",
    });
    expect(hidden.visible).toBe(false);
    expect(hidden.canHide).toBe(true);
    expect(renderTenantPoweredByBadgeHtml(hidden)).toBe("");

    // Paid site with approved affiliate code
    const linked = resolveTenantPoweredByBadge({
      tenantStatus: "active",
      hidePoweredByBadge: false,
      affiliateReferralCode: "mitra_pro",
      affiliateStatus: "approved",
    });
    expect(linked.visible).toBe(true);
    expect(linked.isAffiliateLinked).toBe(true);
    expect(linked.referralCode).toBe("MITRA_PRO");
    expect(linked.href).toBe("https://punyasitus.com/?ref=MITRA_PRO");
    expect(renderTenantPoweredByBadgeHtml(linked)).toContain(
      'href="https://punyasitus.com/?ref=MITRA_PRO"',
    );
  });

  it("falls back safely to plain punyasitus.com for suspended, pending, rejected, or forged referral codes", () => {
    for (const testCase of [
      { affiliateReferralCode: "MITRA_SUSP", affiliateStatus: "suspended" },
      { affiliateReferralCode: "MITRA_PEND", affiliateStatus: "pending" },
      { affiliateReferralCode: "MITRA_REJ", affiliateStatus: "rejected" },
      { affiliateReferralCode: "javascript:alert(1)", affiliateStatus: "active" },
      { affiliateReferralCode: "https://evil.example/phish", affiliateStatus: "active" },
      { affiliateReferralCode: "__pending_1234", affiliateStatus: "active" },
      { affiliateReferralCode: null, affiliateStatus: "active" },
    ]) {
      const badge = resolveTenantPoweredByBadge({
        tenantStatus: "active",
        hidePoweredByBadge: false,
        ...testCase,
      });
      expect(badge.visible).toBe(true);
      expect(badge.href).toBe("https://punyasitus.com");
      expect(badge.referralCode).toBeNull();
      expect(badge.isAffiliateLinked).toBe(false);
    }
  });
});

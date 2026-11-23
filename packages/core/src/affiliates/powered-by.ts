import {
  DEFAULT_AFFILIATE_MARKETING_ORIGIN,
  POWERED_BY_BADGE_TEXT,
  type ResolvedTenantPoweredByBadge,
  type TenantPoweredByBadgeInput,
} from "./types.ts";
import {
  buildAffiliateReferralLink,
  isAffiliateApprovedStatus,
  normalizeAffiliateReferralCode,
} from "./validation.ts";

/**
 * Minimalist "Dibuat dengan PunyaSitus" tenant footer badge contract
 * (`packages/core/src/affiliates/powered-by.ts`; REQ-084, DEC-038, PLAN §19.4, TASK-084).
 *
 * Hard invariants:
 * - `trial` (and non-paid) sites ALWAYS render `visible: true`, text `"Dibuat dengan PunyaSitus"`,
 *   and plain href `"https://punyasitus.com"` — `hidePoweredByBadge` and referral overrides are
 *   strictly ignored during trial.
 * - Paid (`active`, plus paid grace/locked serving states) sites allow:
 *   1. 1-click hide (`hidePoweredByBadge === true` -> `visible: false`), OR
 *   2. Keeping the badge visible linked to the owner's own APPROVED (`active`/`approved`)
 *      affiliate code (`https://punyasitus.com/?ref=<code>`).
 * - Unapproved (`pending`, `rejected`, `suspended`), missing, or malformed/forged referral codes
 *   ALWAYS fall back safely to plain `"https://punyasitus.com"` (never broken or arbitrary URLs).
 */

const PAID_BADGE_ELIGIBLE_STATUSES: ReadonlySet<string> = new Set(["active", "grace", "locked"]);

function normalizeSafeMarketingOrigin(rawOrigin: string | null | undefined): string {
  if (typeof rawOrigin !== "string" || !rawOrigin.trim()) {
    return DEFAULT_AFFILIATE_MARKETING_ORIGIN;
  }
  try {
    const parsed = new URL(rawOrigin.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return DEFAULT_AFFILIATE_MARKETING_ORIGIN;
    }
    return parsed.origin;
  } catch {
    return DEFAULT_AFFILIATE_MARKETING_ORIGIN;
  }
}

export function resolveTenantPoweredByBadge(
  input: TenantPoweredByBadgeInput,
): ResolvedTenantPoweredByBadge {
  const status = typeof input.tenantStatus === "string" ? input.tenantStatus.trim().toLowerCase() : "";
  const marketingOrigin = normalizeSafeMarketingOrigin(input.marketingOrigin);

  // Trial and any non-paid tenant status ALWAYS render the plain minimalist badge and cannot hide or override.
  if (!PAID_BADGE_ELIGIBLE_STATUSES.has(status)) {
    return {
      visible: true,
      canHide: false,
      canAttachAffiliateRef: false,
      text: POWERED_BY_BADGE_TEXT,
      href: marketingOrigin,
      referralCode: null,
      isAffiliateLinked: false,
      rel: "noopener noreferrer",
    };
  }

  // Paid tenant: 1-click hide takes effect cleanly.
  if (input.hidePoweredByBadge === true) {
    return {
      visible: false,
      canHide: true,
      canAttachAffiliateRef: true,
      text: POWERED_BY_BADGE_TEXT,
      href: marketingOrigin,
      referralCode: null,
      isAffiliateLinked: false,
      rel: "noopener noreferrer",
    };
  }

  // Paid tenant keeping badge visible: attach `?ref=<code>` ONLY if affiliate is approved/active AND code is valid.
  const normalizedCode = normalizeAffiliateReferralCode(input.affiliateReferralCode);
  if (normalizedCode && isAffiliateApprovedStatus(input.affiliateStatus)) {
    return {
      visible: true,
      canHide: true,
      canAttachAffiliateRef: true,
      text: POWERED_BY_BADGE_TEXT,
      href: buildAffiliateReferralLink(normalizedCode, marketingOrigin),
      referralCode: normalizedCode,
      isAffiliateLinked: true,
      rel: "noopener noreferrer",
    };
  }

  // Safe fallback for unapproved/suspended/forged/empty referral code.
  return {
    visible: true,
    canHide: true,
    canAttachAffiliateRef: true,
    text: POWERED_BY_BADGE_TEXT,
    href: marketingOrigin,
    referralCode: null,
    isAffiliateLinked: false,
    rel: "noopener noreferrer",
  };
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Renders the zero-JS minimalist HTML anchor for a resolved tenant powered-by badge.
 * Returns empty string `""` when hidden (`visible === false`).
 */
export function renderTenantPoweredByBadgeHtml(badge: ResolvedTenantPoweredByBadge): string {
  if (!badge.visible) return "";
  return `<a href="${escapeHtmlAttr(badge.href)}" rel="${badge.rel}" target="_blank" data-ps-powered-by="true">${badge.text}</a>`;
}

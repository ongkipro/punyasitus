import {
  AFFILIATE_COOKIE_NAME,
  readVerifiedAffiliateCookieFromHeader,
} from "@punyasitus/core/affiliates/index";
import { OnboardingValidationError } from "@punyasitus/core/onboarding/index";
import {
  getTenantAffiliateAttribution,
  lockTenantAffiliateAttribution,
} from "@punyasitus/db/affiliates/index";
import { resolveAffiliateCookieSecret } from "../../../middleware/affiliate-referral.ts";
import type { OnboardingRuntimeEnv } from "./_shared.ts";

/**
 * Referral attribution helper for `POST /api/onboarding/provision`
 * (`apps/web/src/pages/api/onboarding/_referral.ts`; REQ-084, PLAN §19.4, TASK-084).
 *
 * Deterministic precedence:
 *   1. Explicit non-empty `referralCode` in the signup JSON body (`manual_code`).
 *   2. Verified, unexpired (<= 30 days) HMAC-signed `ps_ref` first-party cookie (`cookie` / `footer_badge`).
 *   3. Otherwise, zero attribution (zero extra DB queries).
 *
 * Immutability invariant:
 * - On idempotent replay (`replayed === true`), existing attribution is NEVER modified or overwritten.
 * - Forged server attribution fields (`referredByAffiliateId`, `affiliateId`, etc.) are rejected (`422`).
 */

const FORBIDDEN_REFERRAL_OVERRIDE_KEYS = new Set([
  "referredbyaffiliateid",
  "referred_by_affiliate_id",
  "affiliateid",
  "affiliate_id",
  "attributionsource",
  "attribution_source",
]);

export interface ExtractedOnboardingReferralInput {
  readonly coreBody: Record<string, unknown>;
  readonly manualReferralCode: string | null;
}

/**
 * Extracts optional `referralCode` from the raw onboarding provision body before passing the
 * remaining core keys to `validateOnboardingProvisionPayload`.
 */
export function extractOnboardingReferralInput(
  rawBody: Readonly<Record<string, unknown>>,
): ExtractedOnboardingReferralInput {
  for (const key of Object.keys(rawBody)) {
    if (FORBIDDEN_REFERRAL_OVERRIDE_KEYS.has(key.toLowerCase())) {
      throw new OnboardingValidationError(
        422,
        "FORBIDDEN_CLIENT_FIELD",
        `Kolom "${key}" dikelola sepenuhnya oleh server dan tidak boleh dikirim oleh klien.`,
        key,
      );
    }
  }

  if (!Object.prototype.hasOwnProperty.call(rawBody, "referralCode")) {
    return { coreBody: { ...rawBody }, manualReferralCode: null };
  }

  const rawCode = rawBody.referralCode;
  const coreBody: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawBody)) {
    if (k !== "referralCode") {
      coreBody[k] = v;
    }
  }

  if (rawCode === null || rawCode === undefined) {
    return { coreBody, manualReferralCode: null };
  }

  if (typeof rawCode !== "string") {
    throw new OnboardingValidationError(
      422,
      "VALIDATION_ERROR",
      "Kode referral harus berupa teks.",
      "referralCode",
    );
  }

  const trimmed = rawCode.trim();
  if (trimmed.length === 0) {
    return { coreBody, manualReferralCode: null };
  }

  if (trimmed.length > 64) {
    throw new OnboardingValidationError(
      422,
      "VALIDATION_ERROR",
      "Kode referral melebihi panjang maksimum yang diizinkan.",
      "referralCode",
    );
  }

  return { coreBody, manualReferralCode: trimmed };
}

export interface OnboardingReferralOutcome {
  readonly attributed: boolean;
  readonly affiliateId: string | null;
  readonly referralCode: string | null;
  readonly source: "cookie" | "manual_code" | "footer_badge" | "superadmin_correction" | null;
  readonly locked: boolean;
}

/**
 * Evaluates and immutably locks affiliate attribution on a newly provisioned self-service tenant.
 * Strictly fail-safe: never breaks onboarding when unreferred or when affiliate tables are not loaded.
 */
export async function resolveAndLockOnboardingReferral(params: {
  readonly request: Request;
  readonly runtimeEnv: OnboardingRuntimeEnv;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly manualReferralCode: string | null;
  readonly replayed: boolean;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}): Promise<OnboardingReferralOutcome> {
  const empty: OnboardingReferralOutcome = {
    attributed: false,
    affiliateId: null,
    referralCode: null,
    source: null,
    locked: false,
  };

  if (!params.runtimeEnv.PLATFORM_DB) {
    return empty;
  }

  // On idempotent replay: NEVER re-attribute or overwrite; only read existing lock if present.
  if (params.replayed) {
    try {
      const existing = await getTenantAffiliateAttribution(
        params.runtimeEnv.PLATFORM_DB,
        params.tenantId,
      );
      if (existing && existing.affiliateId) {
        return {
          attributed: true,
          affiliateId: existing.affiliateId,
          referralCode: existing.referralCode,
          source: existing.attributionSource,
          locked: true,
        };
      }
    } catch {
      // Fail-safe when 0031_affiliates migration is absent in isolated tests.
    }
    return empty;
  }

  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  let candidateCode: string | null = null;
  let candidateSource: "cookie" | "manual_code" | "footer_badge" | null = null;
  let cookieIssuedAtMs: number | undefined;

  // Deterministic precedence: explicit manual code > verified unexpired 30-day first-party cookie.
  if (params.manualReferralCode) {
    candidateCode = params.manualReferralCode;
    candidateSource = "manual_code";
  } else {
    const cookieHeader = params.request.headers.get("cookie");
    if (cookieHeader && cookieHeader.includes(`${AFFILIATE_COOKIE_NAME}=`)) {
      const secret = resolveAffiliateCookieSecret(params.runtimeEnv);
      if (secret) {
        const verified = await readVerifiedAffiliateCookieFromHeader({
          cookieHeader,
          secret,
          cookieName: AFFILIATE_COOKIE_NAME,
          nowMs,
        });
        if (verified.valid) {
          candidateCode = verified.referralCode;
          candidateSource = verified.source;
          cookieIssuedAtMs = verified.issuedAtMs;
        }
      }
    }
  }

  if (!candidateCode || !candidateSource) {
    return empty;
  }

  try {
    const lockResult = await lockTenantAffiliateAttribution(params.runtimeEnv.PLATFORM_DB, {
      tenantId: params.tenantId,
      ownerUserId: params.ownerUserId,
      referralCode: candidateCode,
      attributionSource: candidateSource,
      cookieIssuedAtMs,
      requestId: params.requestId ?? null,
      nowMs,
    });

    if (lockResult.attributed) {
      return {
        attributed: true,
        affiliateId: lockResult.attribution.affiliateId,
        referralCode: lockResult.attribution.referralCode,
        source: lockResult.attribution.attributionSource,
        locked: true,
      };
    }

    return empty;
  } catch {
    // Fail-safe: never block self-service tenant provisioning if affiliate schema is absent.
    return empty;
  }
}

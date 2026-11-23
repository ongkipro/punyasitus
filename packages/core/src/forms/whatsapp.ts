import {
  canonicalizePageUrl,
  normalizeIndonesianWhatsAppNumber,
  WA_ME_ORIGIN,
} from "../wa-dispatcher.ts";
import {
  DEFAULT_CONFIRMATION_MESSAGE_ID,
  validateSafeAfterSubmitUrl,
  type AfterSubmitAction,
  type CustomFormLeadSnapshot,
  type PublishedFormDefinition,
} from "./schema.ts";

/**
 * Safe After-Submit Resolver & WhatsApp Prefilled Summary Builder
 * (`packages/core/src/forms/whatsapp.ts`; REQ-080, PLAN §19.2, TASK-080).
 *
 * Security invariants:
 * - Phone numbers are normalized exclusively through `normalizeIndonesianWhatsAppNumber`
 *   from `@punyasitus/core/wa-dispatcher` — NEVER fabricated when absent.
 * - Encodes the rendered WhatsApp summary exactly ONCE with `encodeURIComponent`.
 * - External redirect URLs are re-validated through `validateSafeAfterSubmitUrl`
 *   (strict public HTTPS or clean same-site relative path; zero `javascript:` / open redirects).
 */

export const MAX_WA_SUMMARY_TEXT_LENGTH = 1500 as const;

export interface BuildCustomFormWhatsAppInput {
  readonly formName: string;
  readonly answers: CustomFormLeadSnapshot["answers"];
  readonly tenantPhone?: string | null;
  readonly phoneOverride?: string | null;
  readonly introText?: string | null;
  readonly pageUrl?: string | null;
}

export interface CustomFormWhatsAppSummaryResult {
  readonly url: string;
  readonly phone: string;
  readonly message: string;
}

/**
 * Builds a single-encoded `https://wa.me/<digits>?text=<encoded>` URL summarizing
 * the visitor's submitted custom form labels and values.
 * Returns `null` if no valid Indonesian WhatsApp number is configured (never fabricates a number).
 */
export function buildCustomFormWhatsAppSummaryUrl(
  input: BuildCustomFormWhatsAppInput,
): CustomFormWhatsAppSummaryResult | null {
  const chosenRaw =
    input.phoneOverride && input.phoneOverride.trim().length > 0
      ? input.phoneOverride.trim()
      : input.tenantPhone?.trim() ?? "";

  if (!chosenRaw) {
    return null;
  }

  let phone: string;
  try {
    phone = normalizeIndonesianWhatsAppNumber(chosenRaw);
  } catch {
    return null;
  }

  const intro =
    input.introText && input.introText.trim().length > 0
      ? input.introText.trim()
      : `Halo, saya baru mengirim formulir ${input.formName}:`;

  const lines: string[] = [intro];
  for (const ans of input.answers) {
    if (ans.type === "consent_checkbox") continue;
    const cleanDisplay = ans.displayValue.trim();
    if (!cleanDisplay) continue;
    lines.push(`- ${ans.label}: ${cleanDisplay}`);
  }

  if (input.pageUrl && input.pageUrl.trim().length > 0) {
    try {
      const canonical = canonicalizePageUrl(input.pageUrl);
      lines.push(canonical);
    } catch {
      // Omit invalid/non-HTTPS pageUrl cleanly
    }
  }

  let message = lines.join("\n").trim();
  if (message.length > MAX_WA_SUMMARY_TEXT_LENGTH) {
    message = `${message.slice(0, MAX_WA_SUMMARY_TEXT_LENGTH - 3)}...`;
  }

  const url = `${WA_ME_ORIGIN}/${phone}?text=${encodeURIComponent(message)}`;
  return { url, phone, message };
}

export interface ResolvedCustomFormAfterSubmit {
  readonly action: AfterSubmitAction;
  readonly message: string;
  readonly whatsappUrl: string | null;
  readonly redirectUrl: string | null;
}

/**
 * Resolves the safe post-submission outcome for a published custom form submission.
 * Falls back cleanly to `"text"` if `"whatsapp"` has no valid destination phone or
 * if `"url"` fails strict URL safety checks.
 */
export function resolveCustomFormAfterSubmit(params: {
  readonly publishedDef: PublishedFormDefinition;
  readonly snapshot: CustomFormLeadSnapshot;
  readonly tenantPhone?: string | null;
  readonly pageUrl?: string | null;
}): ResolvedCustomFormAfterSubmit {
  const baseMessage =
    params.publishedDef.afterSubmitConfig.message.trim() || DEFAULT_CONFIRMATION_MESSAGE_ID;

  if (params.publishedDef.afterSubmitAction === "whatsapp") {
    const wa = buildCustomFormWhatsAppSummaryUrl({
      formName: params.publishedDef.name,
      answers: params.snapshot.answers,
      tenantPhone: params.tenantPhone,
      phoneOverride: params.publishedDef.afterSubmitConfig.whatsappPhoneOverride,
      introText: params.publishedDef.afterSubmitConfig.whatsappIntro,
      pageUrl: params.pageUrl,
    });
    if (!wa) {
      return {
        action: "text",
        message: baseMessage,
        whatsappUrl: null,
        redirectUrl: null,
      };
    }
    return {
      action: "whatsapp",
      message: baseMessage,
      whatsappUrl: wa.url,
      redirectUrl: null,
    };
  }

  if (params.publishedDef.afterSubmitAction === "url") {
    const rawUrl = params.publishedDef.afterSubmitConfig.redirectUrl ?? "";
    const check = validateSafeAfterSubmitUrl(rawUrl);
    if (!check.ok) {
      return {
        action: "text",
        message: baseMessage,
        whatsappUrl: null,
        redirectUrl: null,
      };
    }
    return {
      action: "url",
      message: baseMessage,
      whatsappUrl: null,
      redirectUrl: check.url,
    };
  }

  return {
    action: "text",
    message: baseMessage,
    whatsappUrl: null,
    redirectUrl: null,
  };
}

import type { AiWritingQuotaStatus, AiWritingVertical } from "../../ai-writing/index.ts";
import type { OnboardingVertical } from "../index.ts";
import { B2B_BLUEPRINT_IDS, type B2BBlueprintId } from "../../presets/blueprints.ts";
import type { AnyValidatedPageSection } from "../../theme/sections.ts";

/**
 * Shared types & constants for the Optional AI Draft Step in Onboarding
 * (`packages/core/src/onboarding/ai-draft/types.ts`; REQ-109, PLAN §20.5,
 * DEC-028, DEC-043, DEC-046, TASK-109).
 */

export const ONBOARDING_AI_DRAFT_MARKER = "CONTOH" as const;
export const ONBOARDING_AI_DRAFT_PREFIX = "CONTOH — " as const;

export const ONBOARDING_AI_DRAFT_MAX_SHORT_DESCRIPTION_CHARS = 500 as const;
export const ONBOARDING_AI_DRAFT_MAX_BUSINESS_NAME_CHARS = 120 as const;
export const ONBOARDING_AI_DRAFT_MAX_SERVICE_SUMMARIES = 3 as const;

export const ONBOARDING_AI_DRAFT_FACT_NOTICE_ID =
  "Semua teks buatan AI ditandai CONTOH sebagai draf dan tidak pernah diterbitkan otomatis. Harga, nomor izin/lisensi, ulasan pelanggan, nomor telepon/WhatsApp, dan alamat jalan selalu dibiarkan kosong agar Anda isi sendiri dengan fakta resmi." as const;

export const ONBOARDING_AI_DRAFT_FALLBACK_REASONS = [
  "AI_PROVIDER_UNCONFIGURED",
  "AI_QUOTA_EXCEEDED",
  "AI_RATE_LIMITED",
  "AI_PROVIDER_TIMEOUT",
  "AI_PROVIDER_ERROR",
  "AI_INVALID_OUTPUT",
] as const;

export type OnboardingAiDraftFallbackReason =
  (typeof ONBOARDING_AI_DRAFT_FALLBACK_REASONS)[number];

/**
 * Default mapping from the 6 onboarding verticals (`REQ-059`) to the 7 canonical
 * B2B vertical blueprints (`REQ-093`). Owners may also select any of the 7 blueprints.
 */
export const DEFAULT_BLUEPRINT_BY_ONBOARDING_VERTICAL: Readonly<
  Record<OnboardingVertical, B2BBlueprintId>
> = {
  compro: "b2b_corporate",
  sales: "sales_executive",
  travel: "travel_umrah_agency",
  catalog: "wa_catalog_showcase",
  resto: "offline_multibranch",
  dealer: "sales_executive",
};

export function resolveDefaultBlueprintForVertical(vertical: OnboardingVertical): B2BBlueprintId {
  return DEFAULT_BLUEPRINT_BY_ONBOARDING_VERTICAL[vertical] ?? "b2b_corporate";
}

export function isValidB2BBlueprintId(value: unknown): value is B2BBlueprintId {
  return typeof value === "string" && (B2B_BLUEPRINT_IDS as readonly string[]).includes(value);
}

/**
 * Three onboarding answers used to personalize text-only blueprint drafts.
 */
export interface OnboardingAiDraftAnswers {
  readonly businessName: string;
  readonly vertical: OnboardingVertical;
  readonly blueprintId: B2BBlueprintId;
  /** Third onboarding answer: optional short business/service description (PII-checked). */
  readonly shortDescription?: string;
}

export interface OnboardingDraftServiceSummary {
  readonly title: string;
  readonly description: string;
}

/**
 * ONLY text fields of the chosen blueprint that AI is allowed to draft.
 * Strictly excludes prices, licence/permit numbers, reviews, phone/WhatsApp, and street addresses.
 */
export interface OnboardingAiDraftTextFields {
  readonly heroEyebrow: string;
  readonly heroHeadline: string;
  readonly heroSubheadline: string;
  readonly heroCtaLabel: string;
  readonly aboutHeading: string;
  readonly aboutSummary: string;
  readonly serviceSummaries: readonly OnboardingDraftServiceSummary[];
}

/**
 * Authoritative fact slots that MUST remain empty / untouched during AI drafting.
 */
export interface OnboardingBlueprintFactSlots {
  readonly price: "";
  readonly licenceNumber: "";
  readonly reviews: readonly [];
  readonly phone: "";
  readonly whatsapp: "";
  readonly address: "";
}

export const EMPTY_ONBOARDING_BLUEPRINT_FACTS: OnboardingBlueprintFactSlots = Object.freeze({
  price: "",
  licenceNumber: "",
  reviews: Object.freeze([] as const),
  phone: "",
  whatsapp: "",
  address: "",
});

/**
 * Complete draft blueprint state (either plain starter blueprint or AI-drafted `CONTOH` copy).
 * Always unpublished (`status: "draft"`, `published: false`, `autoPublished: false`).
 */
export interface OnboardingBlueprintDraft {
  readonly blueprintId: B2BBlueprintId;
  readonly blueprintName: string;
  readonly vertical: AiWritingVertical;
  readonly recommendedThemeId: string;
  readonly primaryMenuLabel: string;
  readonly source: "plain_blueprint" | "ai_draft";
  readonly status: "draft";
  readonly published: false;
  readonly autoPublished: false;
  readonly draftMarker: typeof ONBOARDING_AI_DRAFT_MARKER;
  readonly textFields: OnboardingAiDraftTextFields;
  readonly facts: OnboardingBlueprintFactSlots;
  readonly sections: readonly AnyValidatedPageSection[];
  readonly sampleSectionIds: readonly string[];
}

export interface OnboardingAiDraftParseSuccess {
  readonly ok: true;
  readonly fields: Partial<OnboardingAiDraftTextFields> & {
    readonly heroHeadline: string;
  };
  readonly strippedFactKeys: readonly string[];
  readonly scrubbedFactMatches: readonly string[];
}

export interface OnboardingAiDraftParseFailure {
  readonly ok: false;
  readonly code: "AI_INVALID_OUTPUT";
  readonly reason: string;
  readonly strippedFactKeys: readonly string[];
  readonly scrubbedFactMatches: readonly string[];
}

export type OnboardingAiDraftParseResult =
  | OnboardingAiDraftParseSuccess
  | OnboardingAiDraftParseFailure;

export interface OnboardingAiDraftApiResponse {
  readonly success: true;
  readonly status: "generated" | "skipped" | "fallback";
  readonly skipped: boolean;
  readonly fallback: boolean;
  readonly fallbackReason: OnboardingAiDraftFallbackReason | null;
  readonly message: string;
  readonly applied: boolean;
  readonly published: false;
  readonly autoPublished: false;
  readonly draftMarker: typeof ONBOARDING_AI_DRAFT_MARKER;
  readonly factCheckReminder: string;
  readonly strippedFactKeys: readonly string[];
  readonly quota: AiWritingQuotaStatus | null;
  readonly blueprint: OnboardingBlueprintDraft;
  readonly draft: OnboardingAiDraftTextFields | null;
  readonly persistedAsDraft: boolean;
  readonly requestId: string;
}

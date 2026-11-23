export {
  DEFAULT_BLUEPRINT_BY_ONBOARDING_VERTICAL,
  EMPTY_ONBOARDING_BLUEPRINT_FACTS,
  ONBOARDING_AI_DRAFT_FACT_NOTICE_ID,
  ONBOARDING_AI_DRAFT_FALLBACK_REASONS,
  ONBOARDING_AI_DRAFT_MARKER,
  ONBOARDING_AI_DRAFT_MAX_BUSINESS_NAME_CHARS,
  ONBOARDING_AI_DRAFT_MAX_SERVICE_SUMMARIES,
  ONBOARDING_AI_DRAFT_MAX_SHORT_DESCRIPTION_CHARS,
  ONBOARDING_AI_DRAFT_PREFIX,
  isValidB2BBlueprintId,
  resolveDefaultBlueprintForVertical,
  type OnboardingAiDraftAnswers,
  type OnboardingAiDraftApiResponse,
  type OnboardingAiDraftFallbackReason,
  type OnboardingAiDraftParseFailure,
  type OnboardingAiDraftParseResult,
  type OnboardingAiDraftParseSuccess,
  type OnboardingAiDraftTextFields,
  type OnboardingBlueprintDraft,
  type OnboardingBlueprintFactSlots,
  type OnboardingDraftServiceSummary,
} from "./types.ts";

export {
  markAsContohDraft,
  parseAndSanitizeOnboardingAiDraftOutput,
  scrubForbiddenFactsFromText,
} from "./fact-scrubber.ts";

export {
  applyOnboardingAiDraftToBlueprint,
  buildOnboardingAiDraftProviderRequest,
  buildPlainOnboardingBlueprint,
  detectPiiInOnboardingAnswers,
  isOnboardingAiProviderConfigured,
  onboardingAiDraftRequestSchema,
  type ValidatedOnboardingAiDraftRequest,
} from "./blueprint.ts";

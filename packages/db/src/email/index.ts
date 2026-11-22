export {
  EMAIL_CLAIMS_MIGRATION,
  EMAIL_CLAIMS_MIGRATION_SQL,
  applyEmailClaimsMigration,
} from "./migrations.ts";

export {
  claimEmailDelivery,
  getEmailDeliveryClaim,
  isRetryableDefiniteRefusalCode,
  recordEmailOutcome,
  type ClaimEmailDeliveryInput,
  type ClaimEmailDeliveryResult,
  type EmailClaimStatus,
  type EmailDeliveryClaimRecord,
  type RecordEmailOutcomeInput,
} from "./claims.ts";

export {
  EMAIL_SUPPRESSION_REASONS,
  addEmailSuppression,
  getEmailSuppression,
  getSuppressionNoticeForOwner,
  hashEmailAddress,
  isEmailSuppressed,
  normalizeEmailAddress,
  recordWebhookBounceAtomically,
  recordWebhookEventOnce,
  type AddEmailSuppressionInput,
  type AddEmailSuppressionResult,
  type EmailHashOptions,
  type EmailSuppressionReason,
  type EmailSuppressionRecord,
  type OwnerSuppressionNotice,
  type RecordWebhookBounceAtomicallyInput,
  type RecordWebhookBounceAtomicallyResult,
} from "./suppressions.ts";

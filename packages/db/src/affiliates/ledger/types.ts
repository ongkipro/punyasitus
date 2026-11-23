import type {
  AffiliateCommissionEntryKind,
  AffiliateCommissionRatesSnapshot,
  AffiliateCommissionStatus,
  AffiliatePayoutBatchStatus,
} from "@punyasitus/core/affiliates/commission";
import type { PlatformAuditRecord } from "../../platform/audit.ts";

export type AffiliateLedgerErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "INVALID_STATE_TRANSITION"
  | "STALE_VERSION"
  | "FORBIDDEN"
  | "LEDGER_WRITE_FAILED"
  | "AUDIT_PERSISTENCE_FAILED";

export class AffiliateLedgerError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 422 | 500;
  readonly code: AffiliateLedgerErrorCode;
  readonly field?: string;

  constructor(
    status: 400 | 403 | 404 | 409 | 422 | 500,
    code: AffiliateLedgerErrorCode,
    message: string,
    options?: { readonly field?: string; readonly cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AffiliateLedgerError";
    this.status = status;
    this.code = code;
    this.field = options?.field;
  }
}

export const AffiliateCommissionLedgerError = AffiliateLedgerError;

export interface AffiliateCommissionEntryRecord {
  readonly id: string;
  readonly affiliateId: string;
  readonly tenantId: string;
  readonly settlementId: string | null;
  readonly paymentAttemptId: string | null;
  readonly obligationId: string | null;
  readonly receiptId: string | null;
  readonly entryKind: AffiliateCommissionEntryKind;
  readonly grossAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly ppnAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly netBaseIdr: number;
  readonly rateBps: number;
  readonly commissionIdr: number;
  readonly status: AffiliateCommissionStatus;
  readonly confirmedAt: number;
  readonly holdUntilAt: number;
  readonly approvedAt: number | null;
  readonly reversedAt: number | null;
  readonly reversalReason: string | null;
  readonly refundReference: string | null;
  readonly payoutBatchId: string | null;
  readonly sourceCommissionId: string | null;
  readonly settingsSnapshotJson: string;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AffiliatePayoutBatchRecord {
  readonly id: string;
  readonly affiliateId: string;
  readonly payoutPeriodKey: string;
  readonly totalAmountIdr: number;
  readonly entryCount: number;
  readonly status: AffiliatePayoutBatchStatus;
  readonly transferReference: string | null;
  readonly paidAt: number | null;
  readonly paidByUserId: string | null;
  readonly canceledAt: number | null;
  readonly canceledByUserId: string | null;
  readonly statusReason: string | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type CommissionIneligibilityReason =
  | "unconfirmed_payment"
  | "trial_payment"
  | "complimentary_payment"
  | "anomaly_payment"
  | "tenant_not_found"
  | "unreferred_tenant"
  | "affiliate_not_found"
  | "affiliate_not_active"
  | "agency_managed_tenant"
  | "ineligible_demo"
  | "ineligible_complimentary"
  | "ineligible_platform"
  | "ineligible_superadmin_created"
  | "ineligible_invalid_metadata"
  | "zero_net_base"
  | "zero_commission_amount";

export interface RecordConfirmedPaymentCommissionInput {
  readonly tenantId: string;
  readonly settlementId?: string | null;
  readonly paymentAttemptId?: string | null;
  readonly obligationId?: string | null;
  readonly receiptId?: string | null;
  /**
   * Optional explicit monetary amounts (integer IDR). When `grossAmountIdr` is omitted,
   * amounts are loaded authoritatively from `settlements`/`billing_obligations`/`payment_attempts`.
   */
  readonly grossAmountIdr?: number;
  readonly discountAmountIdr?: number;
  readonly ppnAmountIdr?: number;
  readonly channelFeeIdr?: number;
  readonly paymentKind?: "subscription" | "addon" | "trial" | "complimentary" | "anomaly";
  readonly isConfirmed?: boolean;
  readonly confirmedAtMs?: number;
  readonly ratesOverride?: AffiliateCommissionRatesSnapshot;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export type RecordConfirmedPaymentCommissionResult =
  | {
      readonly status: "created";
      readonly entry: AffiliateCommissionEntryRecord;
      readonly audit: PlatformAuditRecord;
    }
  | {
      readonly status: "duplicate";
      readonly entry: AffiliateCommissionEntryRecord;
    }
  | {
      readonly status: "ineligible";
      readonly reason: CommissionIneligibilityReason;
    };

export interface PromoteMaturedPendingCommissionsInput {
  readonly nowMs?: number;
  readonly limit?: number;
  readonly requestId?: string | null;
}

export interface PromoteMaturedPendingCommissionsResult {
  readonly evaluatedAtMs: number;
  readonly promotedCount: number;
  readonly skippedSuspendedCount: number;
  readonly promotedIds: readonly string[];
  readonly entries: readonly AffiliateCommissionEntryRecord[];
}

export interface ReverseCommissionForRefundInput {
  readonly commissionEntryId?: string | null;
  readonly paymentAttemptId?: string | null;
  readonly settlementId?: string | null;
  readonly receiptId?: string | null;
  readonly obligationId?: string | null;
  readonly refundReference: string;
  readonly reason: string;
  readonly actorUserId?: string | null;
  readonly actorRole?: "system" | "platform_operator";
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export type ReverseCommissionForRefundResult =
  | {
      readonly status: "reversed";
      readonly mode: "pre_payout_reversed";
      readonly originalEntry: AffiliateCommissionEntryRecord;
      readonly offsetEntry: null;
      readonly audit: PlatformAuditRecord;
    }
  | {
      readonly status: "offset_created";
      readonly mode: "post_payout_offset";
      readonly originalEntry: AffiliateCommissionEntryRecord;
      readonly offsetEntry: AffiliateCommissionEntryRecord;
      readonly audit: PlatformAuditRecord;
    }
  | {
      readonly status: "already_reversed";
      readonly mode: "pre_payout_reversed" | "post_payout_offset";
      readonly originalEntry: AffiliateCommissionEntryRecord;
      readonly offsetEntry: AffiliateCommissionEntryRecord | null;
    }
  | {
      readonly status: "not_found";
    };

export interface BuildBiMonthlyPayoutBatchesInput {
  readonly nowMs?: number;
  readonly forceRun?: boolean;
  readonly overridePayoutPeriodKey?: string;
  readonly minimumPayoutIdr?: number;
  readonly requestId?: string | null;
}

export interface SkippedAffiliatePayoutCandidate {
  readonly affiliateId: string;
  readonly netAvailableIdr: number;
  readonly entryCount: number;
  readonly reason: "below_minimum_threshold" | "already_batched_for_period";
}

export interface BuildBiMonthlyPayoutBatchesResult {
  readonly ran: boolean;
  readonly skipReason: "not_payout_date" | null;
  readonly payoutPeriodKey: string | null;
  readonly evaluatedAtMs: number;
  readonly minimumPayoutIdr: number;
  readonly createdBatchCount: number;
  readonly skippedBelowThresholdCount: number;
  readonly alreadyBatchedCount: number;
  readonly batches: readonly AffiliatePayoutBatchRecord[];
  readonly skippedAffiliates: readonly SkippedAffiliatePayoutCandidate[];
}

export interface MarkAffiliatePayoutBatchPaidInput {
  readonly batchId: string;
  readonly actorUserId: string;
  readonly transferReference: string;
  readonly reason: string;
  readonly expectedVersion?: number;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface MarkAffiliatePayoutBatchPaidResult {
  readonly batch: AffiliatePayoutBatchRecord;
  readonly paidEntryCount: number;
  readonly audit: PlatformAuditRecord;
}

export interface AffiliateCommissionBalanceSummary {
  readonly affiliateId: string;
  readonly pendingIdr: number;
  readonly approvedAvailableIdr: number;
  readonly batchedIdr: number;
  readonly paidIdr: number;
  readonly reversedIdr: number;
}

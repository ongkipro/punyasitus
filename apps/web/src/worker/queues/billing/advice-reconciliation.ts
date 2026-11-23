import {
  BillingNotFoundError,
  BillingProviderError,
  DEFAULT_PRODUCTION_SETTLEMENT_POLICY,
  clampAdviceBatchLimit,
  clampAdviceLeaseMs,
  clampAdviceMaxPolls,
  computeAdviceNextPollDelayMs,
  evaluateAdviceSettlement,
  generateBillingUlid,
  redactBillingLogRecord,
  type AdviceSettlementPolicy,
} from "@punyasitus/core/billing/index";
import {
  acquireAdviceReconciliationBatch,
  ensureBillingReconciliationSchema,
  getLatestReconcilableAttemptForObligation,
  getReconcilableAttemptById,
  markAttemptClosedFromAdvice,
  markAttemptReviewFromAdvice,
  releaseAdviceLeaseAndRecordPoll,
  settleVerifiedPaymentAttempt,
  type ReconcilableAttemptRecord,
} from "@punyasitus/db/billing/index";
import { buildPlatformAuditStatement, PlatformAuditError } from "@punyasitus/db/platform";
import type { AutoLarisBillingClient } from "../../../../../../packages/integrations/src/autolaris/index.ts";
import type {
  DurableJobHandler,
  DurableQueueEnv,
  JobExecutionContext,
  StructuredJobLogger,
} from "../consumer.ts";

/**
 * Scheduled AutoLaris Advice Reconciliation & Exactly-Once Entitlement Grant Worker
 * (REQ-057, PLAN §16.3, §16.4, §16.5; TASK-056).
 *
 * Hard invariants:
 * 1. Default policy is `DEFAULT_PRODUCTION_SETTLEMENT_POLICY` (`realProviderMappingStatus: "UNVERIFIED"`),
 *    failing safely into `review` and NEVER granting access without verified provider mapping evidence.
 * 2. Advice calls use strictly `provider_transaction_id` (NEVER local `reff_id`). Attempts lacking
 *    `provider_transaction_id` (such as provider-ID-less `creation_unknown`) route immediately to
 *    `review` without calling AutoLaris.
 * 3. Bounded leases (`lease_expires_at`), max batch sizes, and poll attempt ceilings prevent
 *    double-processing and unbounded polling.
 * 4. One failing attempt (timeout, network error, malformed JSON) transitions safely to `review`
 *    and NEVER stops other attempts in the batch.
 * 5. All structured logs and audit rows redact API keys, Authorization headers, QRIS payloads,
 *    VA numbers, and customer PII.
 */

export const BILLING_ADVICE_RECONCILE_TOPIC = "billing.advice.reconcile" as const;

export interface ReconcilePaymentAttemptOptions {
  readonly db: D1Database;
  readonly autolarisClient: AutoLarisBillingClient;
  readonly attemptId?: string;
  readonly obligationId?: string;
  readonly tenantId?: string;
  readonly settlementPolicy?: AdviceSettlementPolicy;
  readonly actorUserId?: string | null;
  readonly actorRole?: "system" | "platform_operator";
  readonly reason?: string | null;
  readonly requestId?: string | null;
  readonly nowMs?: number;
  readonly workerId?: string | null;
  readonly maxPolls?: number;
  readonly logger?: StructuredJobLogger;
}

export interface ReconcilePaymentAttemptOutcome {
  readonly attemptId: string;
  readonly obligationId: string;
  readonly tenantId: string;
  readonly outcome:
    | "settled"
    | "already_settled"
    | "pending"
    | "expired"
    | "failed"
    | "review";
  readonly reasonCode: string;
  readonly providerCalled: boolean;
  readonly providerRc: string | null;
  readonly providerStatus: string | null;
  readonly grantApplied: boolean;
  readonly alreadyGranted: boolean;
  readonly settlementId: string | null;
  readonly grantId: string | null;
  readonly operatorHoldPreserved: boolean;
  readonly deferredTerminalState: boolean;
  readonly auditId: string | null;
  readonly policyProfile: string;
  readonly policyVersion: string;
}

function emitSafeBillingLog(
  logger: StructuredJobLogger | undefined,
  entry: Readonly<Record<string, unknown>>,
): void {
  if (!logger) return;
  logger(redactBillingLogRecord(entry));
}

function wrapIfAuditError(err: unknown): never {
  if (err instanceof PlatformAuditError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/platform_audit|audit/i.test(msg)) {
    throw new PlatformAuditError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menyimpan log audit platform; operasi rekonsiliasi dibatalkan.",
      err,
    );
  }
  throw err;
}

async function resolveTargetAttempt(
  db: D1Database,
  options: Pick<ReconcilePaymentAttemptOptions, "attemptId" | "obligationId" | "tenantId">,
): Promise<ReconcilableAttemptRecord> {
  if (options.attemptId?.trim()) {
    const attempt = await getReconcilableAttemptById(db, options.attemptId.trim(), {
      tenantId: options.tenantId,
    });
    if (!attempt) {
      throw new BillingNotFoundError("Percobaan pembayaran tidak ditemukan.");
    }
    if (options.obligationId?.trim() && attempt.obligationId !== options.obligationId.trim()) {
      throw new BillingNotFoundError("Percobaan pembayaran tidak cocok dengan tagihan yang diminta.");
    }
    return attempt;
  }

  if (options.obligationId?.trim()) {
    const attempt = await getLatestReconcilableAttemptForObligation(db, options.obligationId.trim(), {
      tenantId: options.tenantId,
    });
    if (!attempt) {
      throw new BillingNotFoundError("Percobaan pembayaran untuk tagihan tersebut tidak ditemukan.");
    }
    return attempt;
  }

  throw new BillingNotFoundError("attemptId atau obligationId wajib diberikan untuk rekonsiliasi Advice.");
}

async function appendOperatorCheckAudit(
  db: D1Database,
  input: {
    readonly attempt: ReconcilableAttemptRecord;
    readonly actorUserId: string | null;
    readonly reason: string | null;
    readonly requestId: string | null;
    readonly outcome: "success" | "error";
    readonly nowMs: number;
    readonly metadata: Readonly<Record<string, unknown>>;
  },
): Promise<string> {
  const { statement, entry } = buildPlatformAuditStatement(db, {
    actorUserId: input.actorUserId,
    actorRole: "platform_operator",
    action: "console.billing.advice_recheck",
    targetType: "payment_attempt",
    targetId: input.attempt.attemptId,
    tenantId: input.attempt.tenantId,
    reason: input.reason,
    requireReason: true,
    outcome: input.outcome,
    requestId: input.requestId,
    metadata: {
      obligationId: input.attempt.obligationId,
      providerTransactionId: input.attempt.providerTransactionId,
      ...input.metadata,
    },
    createdAtMs: input.nowMs,
  });
  try {
    await statement.run();
  } catch (err) {
    wrapIfAuditError(err);
  }
  return entry.id;
}

/**
 * Reconciles a single payment attempt via `POST /api/h2h/advice`, enforcing the
 * explicit settlement policy, provider-ID-less safety gate, atomic exactly-once
 * entitlement grants, and redacted audit/logging.
 */
export async function reconcilePaymentAttemptViaAdvice(
  options: ReconcilePaymentAttemptOptions,
): Promise<ReconcilePaymentAttemptOutcome> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const policy = options.settlementPolicy ?? DEFAULT_PRODUCTION_SETTLEMENT_POLICY;
  const actorRole = options.actorRole ?? "system";
  const actorUserId = options.actorUserId ?? null;
  const maxPolls = clampAdviceMaxPolls(options.maxPolls);

  await ensureBillingReconciliationSchema(options.db, () => nowMs);
  const attempt = await resolveTargetAttempt(options.db, options);

  // 1. Already paid — strictly idempotent, never downgrades or grants twice!
  if (attempt.lifecycleState === "paid") {
    const existing = await options.db
      .prepare(
        `SELECT s.id AS settlement_id, eg.id AS grant_id
         FROM settlements s
         LEFT JOIN entitlement_grants eg ON eg.settlement_id = s.id
         WHERE s.payment_attempt_id = ?
         LIMIT 1`,
      )
      .bind(attempt.attemptId)
      .first<{ readonly settlement_id: string; readonly grant_id: string | null }>();

    let auditId: string | null = null;
    if (actorRole === "platform_operator") {
      auditId = await appendOperatorCheckAudit(options.db, {
        attempt,
        actorUserId,
        reason: options.reason ?? null,
        requestId: options.requestId ?? null,
        outcome: "success",
        nowMs,
        metadata: {
          result: "already_settled",
          settlementId: existing?.settlement_id ?? null,
          grantId: existing?.grant_id ?? null,
        },
      });
    }

    emitSafeBillingLog(options.logger, {
      event: "billing.advice.already_settled",
      tenantId: attempt.tenantId,
      obligationId: attempt.obligationId,
      attemptId: attempt.attemptId,
      providerTransactionId: attempt.providerTransactionId,
      policyProfile: policy.profile,
      timestamp: nowMs,
    });

    return {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      tenantId: attempt.tenantId,
      outcome: "already_settled",
      reasonCode: "ALREADY_SETTLED",
      providerCalled: false,
      providerRc: null,
      providerStatus: null,
      grantApplied: false,
      alreadyGranted: true,
      settlementId: existing?.settlement_id ?? null,
      grantId: existing?.grant_id ?? null,
      operatorHoldPreserved: attempt.operatorHold,
      deferredTerminalState: false,
      auditId,
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
    };
  }

  // 2. Hard invariant: NEVER call Advice without a provider-issued `transaction_id`!
  //    A `creation_unknown` attempt missing `provider_transaction_id` routes safely to `review`.
  if (!attempt.providerTransactionId) {
    const reviewRes = await markAttemptReviewFromAdvice(options.db, {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      tenantId: attempt.tenantId,
      safeFailureCode: "MISSING_PROVIDER_TRANSACTION_ID",
      actorUserId,
      actorRole,
      reason: options.reason ?? null,
      requireReason: actorRole === "platform_operator",
      requestId: options.requestId ?? null,
      nowMs,
      metadata: {
        previousState: attempt.lifecycleState,
        reffId: attempt.reffId,
        policyProfile: policy.profile,
      },
    });

    emitSafeBillingLog(options.logger, {
      event: "billing.advice.missing_provider_transaction_id",
      tenantId: attempt.tenantId,
      obligationId: attempt.obligationId,
      attemptId: attempt.attemptId,
      reffId: attempt.reffId,
      outcome: "review",
      reasonCode: "MISSING_PROVIDER_TRANSACTION_ID",
      timestamp: nowMs,
    });

    return {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      tenantId: attempt.tenantId,
      outcome: "review",
      reasonCode: "MISSING_PROVIDER_TRANSACTION_ID",
      providerCalled: false,
      providerRc: null,
      providerStatus: null,
      grantApplied: false,
      alreadyGranted: false,
      settlementId: null,
      grantId: null,
      operatorHoldPreserved: attempt.operatorHold,
      deferredTerminalState: false,
      auditId: reviewRes.auditId,
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
    };
  }

  // 3. Call AutoLaris `POST /api/h2h/advice` strictly with `provider_transaction_id`
  let observation;
  try {
    observation = await options.autolarisClient.checkTransactionAdvice({
      providerTransactionId: attempt.providerTransactionId,
    });
  } catch (err) {
    const safeCode =
      err instanceof BillingProviderError ? err.safeFailureCode : "ADVICE_TRANSPORT_ERROR";

    const reviewRes = await markAttemptReviewFromAdvice(options.db, {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      tenantId: attempt.tenantId,
      safeFailureCode: safeCode,
      actorUserId,
      actorRole,
      reason: options.reason ?? null,
      requireReason: actorRole === "platform_operator",
      requestId: options.requestId ?? null,
      nowMs,
      metadata: {
        providerTransactionId: attempt.providerTransactionId,
        providerErrorKind: err instanceof BillingProviderError ? err.kind : "unknown",
        policyProfile: policy.profile,
      },
    });

    emitSafeBillingLog(options.logger, {
      event: "billing.advice.transport_or_payload_review",
      tenantId: attempt.tenantId,
      obligationId: attempt.obligationId,
      attemptId: attempt.attemptId,
      providerTransactionId: attempt.providerTransactionId,
      safeFailureCode: safeCode,
      timestamp: nowMs,
    });

    return {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      tenantId: attempt.tenantId,
      outcome: "review",
      reasonCode: safeCode,
      providerCalled: true,
      providerRc: null,
      providerStatus: null,
      grantApplied: false,
      alreadyGranted: false,
      settlementId: null,
      grantId: null,
      operatorHoldPreserved: attempt.operatorHold,
      deferredTerminalState: false,
      auditId: reviewRes.auditId,
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
    };
  }

  // 4. Evaluate Advice observation strictly against the configured settlement policy
  const decision = evaluateAdviceSettlement({
    expectedProviderTransactionId: attempt.providerTransactionId,
    expectedReffId: attempt.reffId,
    expectedTotalPayableIdr: attempt.totalPayableIdr,
    observation,
    policy,
    nowMs,
  });

  if (decision.kind === "pending") {
    const nextPollCount = attempt.pollCount + 1;
    // Enforce poll attempt ceiling: if exhausted in scheduled sweep, escalate to `review`
    if (actorRole === "system" && nextPollCount >= maxPolls) {
      const reviewRes = await markAttemptReviewFromAdvice(options.db, {
        attemptId: attempt.attemptId,
        obligationId: attempt.obligationId,
        tenantId: attempt.tenantId,
        safeFailureCode: "ADVICE_MAX_POLLS_EXHAUSTED",
        actorUserId: null,
        actorRole: "system",
        requestId: options.requestId ?? null,
        nowMs,
        metadata: {
          providerTransactionId: attempt.providerTransactionId,
          pollCount: nextPollCount,
          maxPolls,
          providerRc: decision.providerRc,
          providerStatus: decision.providerStatus,
        },
      });
      return {
        attemptId: attempt.attemptId,
        obligationId: attempt.obligationId,
        tenantId: attempt.tenantId,
        outcome: "review",
        reasonCode: "ADVICE_MAX_POLLS_EXHAUSTED",
        providerCalled: true,
        providerRc: decision.providerRc,
        providerStatus: decision.providerStatus,
        grantApplied: false,
        alreadyGranted: false,
        settlementId: null,
        grantId: null,
        operatorHoldPreserved: attempt.operatorHold,
        deferredTerminalState: false,
        auditId: reviewRes.auditId,
        policyProfile: policy.profile,
        policyVersion: policy.policyVersion,
      };
    }

    let auditId: string | null = null;
    if (actorRole === "platform_operator") {
      auditId = await appendOperatorCheckAudit(options.db, {
        attempt,
        actorUserId,
        reason: options.reason ?? null,
        requestId: options.requestId ?? null,
        outcome: "success",
        nowMs,
        metadata: {
          result: "pending",
          providerRc: decision.providerRc,
          providerStatus: decision.providerStatus,
          policyProfile: policy.profile,
        },
      });
    }

    emitSafeBillingLog(options.logger, {
      event: "billing.advice.pending",
      tenantId: attempt.tenantId,
      obligationId: attempt.obligationId,
      attemptId: attempt.attemptId,
      providerTransactionId: attempt.providerTransactionId,
      providerRc: decision.providerRc,
      providerStatus: decision.providerStatus,
      timestamp: nowMs,
    });

    return {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      tenantId: attempt.tenantId,
      outcome: "pending",
      reasonCode: decision.safeReasonCode,
      providerCalled: true,
      providerRc: decision.providerRc,
      providerStatus: decision.providerStatus,
      grantApplied: false,
      alreadyGranted: false,
      settlementId: null,
      grantId: null,
      operatorHoldPreserved: attempt.operatorHold,
      deferredTerminalState: false,
      auditId,
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
    };
  }

  if (decision.kind === "expired" || decision.kind === "failed") {
    const closed = await markAttemptClosedFromAdvice(options.db, {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      tenantId: attempt.tenantId,
      targetState: decision.kind,
      safeFailureCode: decision.safeReasonCode,
      actorUserId,
      actorRole,
      reason: options.reason ?? null,
      requireReason: actorRole === "platform_operator",
      requestId: options.requestId ?? null,
      nowMs,
      metadata: {
        providerTransactionId: attempt.providerTransactionId,
        providerRc: decision.providerRc,
        providerStatus: decision.providerStatus,
        policyProfile: policy.profile,
      },
    });

    emitSafeBillingLog(options.logger, {
      event: `billing.advice.${decision.kind}`,
      tenantId: attempt.tenantId,
      obligationId: attempt.obligationId,
      attemptId: attempt.attemptId,
      providerTransactionId: attempt.providerTransactionId,
      providerRc: decision.providerRc,
      providerStatus: decision.providerStatus,
      timestamp: nowMs,
    });

    return {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      tenantId: attempt.tenantId,
      outcome: decision.kind,
      reasonCode: decision.safeReasonCode,
      providerCalled: true,
      providerRc: decision.providerRc,
      providerStatus: decision.providerStatus,
      grantApplied: false,
      alreadyGranted: false,
      settlementId: null,
      grantId: null,
      operatorHoldPreserved: attempt.operatorHold,
      deferredTerminalState: false,
      auditId: closed.auditId,
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
    };
  }

  if (decision.kind === "review") {
    const reviewRes = await markAttemptReviewFromAdvice(options.db, {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      tenantId: attempt.tenantId,
      safeFailureCode: decision.safeReasonCode,
      actorUserId,
      actorRole,
      reason: options.reason ?? null,
      requireReason: actorRole === "platform_operator",
      requestId: options.requestId ?? null,
      nowMs,
      metadata: {
        providerTransactionId: attempt.providerTransactionId,
        providerRc: decision.providerRc,
        providerStatus: decision.providerStatus,
        policyProfile: policy.profile,
        policyVersion: policy.policyVersion,
      },
    });

    emitSafeBillingLog(options.logger, {
      event: "billing.advice.review_required",
      tenantId: attempt.tenantId,
      obligationId: attempt.obligationId,
      attemptId: attempt.attemptId,
      providerTransactionId: attempt.providerTransactionId,
      reasonCode: decision.safeReasonCode,
      providerRc: decision.providerRc,
      providerStatus: decision.providerStatus,
      policyProfile: policy.profile,
      timestamp: nowMs,
    });

    return {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      tenantId: attempt.tenantId,
      outcome: "review",
      reasonCode: decision.safeReasonCode,
      providerCalled: true,
      providerRc: decision.providerRc,
      providerStatus: decision.providerStatus,
      grantApplied: false,
      alreadyGranted: false,
      settlementId: null,
      grantId: null,
      operatorHoldPreserved: attempt.operatorHold,
      deferredTerminalState: false,
      auditId: reviewRes.auditId,
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
    };
  }

  // 5. Confirmed settlement under verified policy -> atomic settlement + exactly-once grant + audit!
  const settled = await settleVerifiedPaymentAttempt(options.db, {
    attemptId: attempt.attemptId,
    obligationId: attempt.obligationId,
    tenantId: attempt.tenantId,
    plan: attempt.plan,
    verifiedAmountIdr: decision.verifiedAmountIdr,
    providerTransactionId: decision.providerTransactionId,
    providerStatus: decision.providerStatus,
    policyProfile: decision.policyProfile,
    policyVersion: decision.policyVersion,
    settledAtMs: decision.settledAtMs,
    reconciledVia: "advice",
    actorUserId,
    actorRole,
    reason: options.reason ?? null,
    requestId: options.requestId ?? null,
    nowMs,
  });

  emitSafeBillingLog(options.logger, {
    event: `billing.advice.${settled.outcome}`,
    tenantId: attempt.tenantId,
    obligationId: attempt.obligationId,
    attemptId: attempt.attemptId,
    providerTransactionId: attempt.providerTransactionId,
    grantApplied: settled.grantApplied,
    alreadyGranted: settled.alreadyGranted,
    policyProfile: decision.policyProfile,
    timestamp: nowMs,
  });

  if (settled.outcome === "settled") {
    return {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      tenantId: attempt.tenantId,
      outcome: "settled",
      reasonCode: "SETTLEMENT_CONFIRMED",
      providerCalled: true,
      providerRc: observation.rc,
      providerStatus: decision.providerStatus,
      grantApplied: true,
      alreadyGranted: false,
      settlementId: settled.settlementId,
      grantId: settled.grantId,
      operatorHoldPreserved: settled.operatorHoldPreserved,
      deferredTerminalState: false,
      auditId: settled.auditId,
      policyProfile: decision.policyProfile,
      policyVersion: decision.policyVersion,
    };
  }

  if (settled.outcome === "already_settled") {
    return {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      tenantId: attempt.tenantId,
      outcome: "already_settled",
      reasonCode: "ALREADY_SETTLED",
      providerCalled: true,
      providerRc: observation.rc,
      providerStatus: decision.providerStatus,
      grantApplied: false,
      alreadyGranted: true,
      settlementId: settled.settlementId,
      grantId: settled.grantId,
      operatorHoldPreserved: attempt.operatorHold,
      deferredTerminalState: false,
      auditId: settled.auditId,
      policyProfile: decision.policyProfile,
      policyVersion: decision.policyVersion,
    };
  }

  return {
    attemptId: attempt.attemptId,
    obligationId: attempt.obligationId,
    tenantId: attempt.tenantId,
    outcome: "review",
    reasonCode: settled.reasonCode,
    providerCalled: true,
    providerRc: observation.rc,
    providerStatus: decision.providerStatus,
    grantApplied: false,
    alreadyGranted: false,
    settlementId: null,
    grantId: null,
    operatorHoldPreserved: attempt.operatorHold,
    deferredTerminalState: Boolean(settled.deferredTerminalState),
    auditId: settled.auditId,
    policyProfile: decision.policyProfile,
    policyVersion: decision.policyVersion,
  };
}

export interface RunBillingAdviceSweepOptions {
  readonly autolarisClient: AutoLarisBillingClient;
  readonly settlementPolicy?: AdviceSettlementPolicy;
  readonly workerId?: string;
  readonly nowMs?: number;
  readonly batchLimit?: number;
  readonly leaseDurationMs?: number;
  readonly maxPolls?: number;
  readonly expiredGraceWindowMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly logger?: StructuredJobLogger;
}

export interface BillingAdviceSweepResult {
  readonly workerId: string;
  readonly evaluatedAtMs: number;
  readonly leasedCount: number;
  readonly settledCount: number;
  readonly alreadySettledCount: number;
  readonly pendingCount: number;
  readonly expiredCount: number;
  readonly failedCount: number;
  readonly reviewCount: number;
  readonly isolatedErrorCount: number;
  readonly outcomes: readonly ReconcilePaymentAttemptOutcome[];
}

/**
 * Executes one bounded AutoLaris Advice reconciliation sweep:
 * - Acquires bounded leases (`lease_expires_at`) on at most `batchLimit` attempts.
 * - Isolates per-attempt failures so one broken attempt never stops the rest of the batch.
 * - Releases every acquired lease cleanly in `finally` with exponential backoff and poll counts.
 */
export async function runBillingAdviceReconciliationSweep(
  env: Pick<DurableQueueEnv, "PLATFORM_DB">,
  options: RunBillingAdviceSweepOptions,
): Promise<BillingAdviceSweepResult> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const workerId = options.workerId?.trim() || `advice_worker_${generateBillingUlid(nowMs)}`;
  const batchLimit = clampAdviceBatchLimit(options.batchLimit);
  const leaseDurationMs = clampAdviceLeaseMs(options.leaseDurationMs);
  const maxPolls = clampAdviceMaxPolls(options.maxPolls);

  const leased = await acquireAdviceReconciliationBatch(env.PLATFORM_DB, {
    workerId,
    nowMs,
    batchLimit,
    leaseDurationMs,
    maxPolls,
    expiredGraceWindowMs: options.expiredGraceWindowMs,
  });

  let settledCount = 0;
  let alreadySettledCount = 0;
  let pendingCount = 0;
  let expiredCount = 0;
  let failedCount = 0;
  let reviewCount = 0;
  let isolatedErrorCount = 0;
  const outcomes: ReconcilePaymentAttemptOutcome[] = [];

  for (const attempt of leased) {
    let providerRc: string | null = null;
    let providerStatus: string | null = null;
    let outcomeLabel = "error";
    let nextPollAfterMs =
      nowMs +
      computeAdviceNextPollDelayMs(attempt.pollCount + 1, {
        baseBackoffMs: options.baseBackoffMs,
        maxBackoffMs: options.maxBackoffMs,
      });

    try {
      const res = await reconcilePaymentAttemptViaAdvice({
        db: env.PLATFORM_DB,
        autolarisClient: options.autolarisClient,
        attemptId: attempt.attemptId,
        settlementPolicy: options.settlementPolicy,
        actorRole: "system",
        nowMs,
        workerId,
        maxPolls,
        logger: options.logger,
      });

      outcomes.push(res);
      providerRc = res.providerRc;
      providerStatus = res.providerStatus;
      outcomeLabel = res.outcome;

      if (res.outcome === "settled") {
        settledCount += 1;
        nextPollAfterMs = nowMs;
      } else if (res.outcome === "already_settled") {
        alreadySettledCount += 1;
        nextPollAfterMs = nowMs;
      } else if (res.outcome === "pending") {
        pendingCount += 1;
      } else if (res.outcome === "expired") {
        expiredCount += 1;
      } else if (res.outcome === "failed") {
        failedCount += 1;
      } else {
        reviewCount += 1;
      }
    } catch (err) {
      isolatedErrorCount += 1;
      outcomeLabel = err instanceof PlatformAuditError ? "audit_error" : "isolated_error";
      emitSafeBillingLog(options.logger, {
        event: "billing.advice.sweep_attempt_isolated_error",
        workerId,
        tenantId: attempt.tenantId,
        obligationId: attempt.obligationId,
        attemptId: attempt.attemptId,
        errorCode: err instanceof PlatformAuditError ? err.code : "SWEEP_ATTEMPT_ERROR",
        timestamp: nowMs,
      });
    } finally {
      try {
        await releaseAdviceLeaseAndRecordPoll(env.PLATFORM_DB, {
          attemptId: attempt.attemptId,
          obligationId: attempt.obligationId,
          tenantId: attempt.tenantId,
          workerId,
          nowMs,
          nextPollAfterMs,
          providerRc,
          providerStatus,
          outcome: outcomeLabel,
          incrementPollCount: true,
          maxPolls,
        });
      } catch {
        // Lease will expire naturally at `lease_expires_at` if release itself fails
      }
    }
  }

  return {
    workerId,
    evaluatedAtMs: nowMs,
    leasedCount: leased.length,
    settledCount,
    alreadySettledCount,
    pendingCount,
    expiredCount,
    failedCount,
    reviewCount,
    isolatedErrorCount,
    outcomes,
  };
}

export function createBillingAdviceReconciliationHandler(
  options: Omit<RunBillingAdviceSweepOptions, "nowMs"> & {
    readonly now?: () => number;
  },
): DurableJobHandler {
  return {
    maxAttempts: 3,
    leaseDurationMs: clampAdviceLeaseMs(options.leaseDurationMs),
    async execute(ctx: JobExecutionContext): Promise<void> {
      const scheduledAt =
        typeof ctx.payload.scheduledAtMs === "number" && Number.isFinite(ctx.payload.scheduledAtMs)
          ? ctx.payload.scheduledAtMs
          : (options.now ? options.now() : ctx.nowMs);
      await runBillingAdviceReconciliationSweep(ctx.env, {
        ...options,
        nowMs: scheduledAt,
      });
    },
  };
}

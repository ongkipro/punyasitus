import { BILLING_CURRENCY, MAX_IDR_AMOUNT } from "./constants.ts";
import { BillingValidationError } from "./errors.ts";
import { assertExactIdrInteger } from "./money.ts";

/**
 * Explicit settlement policy, AutoLaris Advice classification, and bounded
 * reconciliation polling rules (PLAN §16.3, §16.4, §16.5; REQ-057; TASK-056).
 *
 * Hard invariants:
 * - Default / production policy ships with `realProviderMappingStatus: "UNVERIFIED"`
 *   and `allowSettlementGrant: false`. Real provider responses NEVER grant access
 *   until authorized live AutoLaris Advice settlement evidence is verified and gated.
 * - Generic response codes or status strings (`rc === "00"`, `"OK"`, `"SUCCESS"`,
 *   `"SUKSES"`, `"BERHASIL"`) and shipping vocabulary (`"DELIVERED"`, `"SHIPPED"`,
 *   `"IN_TRANSIT"`, `"MANIFEST"`) NEVER prove payment settlement, even under a
 *   mock-only test policy.
 * - Confirmed settlement requires explicit verified payment status + exact
 *   `provider_transaction_id` match + exact integer IDR amount + explicit `"IDR"`
 *   currency + `reff_id` cross-check whenever returned.
 */

export type SettlementPolicyProfile = "production_unverified" | "mock_only_verified_policy";

export type RealProviderMappingStatus = "UNVERIFIED" | "MOCK_ONLY_VERIFIED";

export interface AdviceSettlementPolicy {
  readonly profile: SettlementPolicyProfile;
  readonly realProviderMappingStatus: RealProviderMappingStatus;
  readonly policyVersion: string;
  readonly allowSettlementGrant: boolean;
  readonly confirmedResponseCodes: readonly string[];
  readonly confirmedPaymentStatuses: readonly string[];
  readonly pendingResponseCodes: readonly string[];
  readonly pendingPaymentStatuses: readonly string[];
  readonly expiredPaymentStatuses: readonly string[];
  readonly failedPaymentStatuses: readonly string[];
  readonly requireExactAmountMatch: true;
  readonly requireExplicitCurrency: true;
  readonly requireProviderTransactionIdMatch: true;
}

/**
 * Status tokens that MUST NEVER be accepted as payment settlement proof under ANY policy
 * (PLAN §16.4; REQ-057; autolaris-h2h skill rule #8).
 */
export const FORBIDDEN_GENERIC_SETTLEMENT_STATUSES: ReadonlySet<string> = new Set<string>([
  "",
  "00",
  "OK",
  "SUCCESS",
  "SUKSES",
  "BERHASIL",
  "DELIVERED",
  "COMPLETED",
  "DONE",
  "SHIPPED",
  "IN_TRANSIT",
  "MANIFEST",
  "PROCESSED",
  "PICKUP",
  "ON_PROCESS",
]);

export const SHIPPING_VOCABULARY_STATUSES: ReadonlySet<string> = new Set<string>([
  "DELIVERED",
  "SHIPPED",
  "IN_TRANSIT",
  "MANIFEST",
  "PICKUP",
  "ON_DELIVERY",
  "RETURNED",
  "POD",
]);

/**
 * Default production policy: fails safely into `review` for every non-pending Advice
 * response so unverified real-provider mappings can NEVER grant entitlement.
 */
export const DEFAULT_PRODUCTION_SETTLEMENT_POLICY: AdviceSettlementPolicy = Object.freeze({
  profile: "production_unverified",
  realProviderMappingStatus: "UNVERIFIED",
  policyVersion: "autolaris-real-unverified-v1",
  allowSettlementGrant: false,
  confirmedResponseCodes: Object.freeze([]),
  confirmedPaymentStatuses: Object.freeze([]),
  pendingResponseCodes: Object.freeze(["02"]),
  pendingPaymentStatuses: Object.freeze(["PENDING", "UNPAID", "WAITING_PAYMENT", "MENUNGGU_PEMBAYARAN"]),
  expiredPaymentStatuses: Object.freeze(["EXPIRED", "KEDALUWARSA"]),
  failedPaymentStatuses: Object.freeze(["FAILED", "CANCELLED", "CANCELED", "REJECTED", "GAGAL"]),
  requireExactAmountMatch: true,
  requireExplicitCurrency: true,
  requireProviderTransactionIdMatch: true,
});

/**
 * Constructs an explicit **mock-only** settlement policy for local/CI tests (`TASK-056`).
 * Rejects any attempt to whitelist generic success or shipping tokens as paid proof.
 */
export function createMockOnlyVerifiedSettlementPolicy(options?: {
  readonly confirmedPaymentStatuses?: readonly string[];
  readonly policyVersion?: string;
}): AdviceSettlementPolicy {
  const rawConfirmed = options?.confirmedPaymentStatuses ?? ["PAID_SETTLED", "SETTLEMENT_CONFIRMED"];
  if (rawConfirmed.length === 0) {
    throw new BillingValidationError(
      "EMPTY_CONFIRMED_STATUS_LIST",
      "Kebijakan settlement mock-only harus mencantumkan minimal satu status paid terverifikasi.",
    );
  }

  const normalizedConfirmed: string[] = [];
  for (const raw of rawConfirmed) {
    const token = raw.trim().toUpperCase();
    if (!token || FORBIDDEN_GENERIC_SETTLEMENT_STATUSES.has(token) || SHIPPING_VOCABULARY_STATUSES.has(token)) {
      throw new BillingValidationError(
        "FORBIDDEN_GENERIC_SETTLEMENT_STATUS",
        `Status generik atau status pengiriman "${raw}" tidak boleh dijadikan bukti settlement pembayaran.`,
      );
    }
    if (!normalizedConfirmed.includes(token)) {
      normalizedConfirmed.push(token);
    }
  }

  return Object.freeze({
    profile: "mock_only_verified_policy",
    realProviderMappingStatus: "MOCK_ONLY_VERIFIED",
    policyVersion: options?.policyVersion?.trim() || "mock-only-verified-v1",
    allowSettlementGrant: true,
    confirmedResponseCodes: Object.freeze(["00"]),
    confirmedPaymentStatuses: Object.freeze(normalizedConfirmed),
    pendingResponseCodes: Object.freeze(["02"]),
    pendingPaymentStatuses: Object.freeze(["PENDING", "UNPAID", "WAITING_PAYMENT"]),
    expiredPaymentStatuses: Object.freeze(["EXPIRED"]),
    failedPaymentStatuses: Object.freeze(["FAILED", "CANCELLED", "CANCELED", "REJECTED"]),
    requireExactAmountMatch: true,
    requireExplicitCurrency: true,
    requireProviderTransactionIdMatch: true,
  });
}

export interface RawAutoLarisAdviceObservation {
  readonly rc: string;
  readonly ket: string | null;
  readonly providerTransactionId: string | null;
  readonly reffId: string | null;
  readonly paymentStatus: string | null;
  readonly shippingStatus: string | null;
  readonly paidAmountIdr: number | null;
  readonly currency: string | null;
  readonly settledAtMs: number | null;
}

export interface EvaluateAdviceSettlementInput {
  readonly expectedProviderTransactionId: string;
  readonly expectedReffId: string;
  readonly expectedTotalPayableIdr: number;
  readonly expectedCurrency?: typeof BILLING_CURRENCY;
  readonly observation: RawAutoLarisAdviceObservation;
  readonly policy?: AdviceSettlementPolicy;
  readonly nowMs: number;
}

export type AdviceSettlementDecision =
  | {
      readonly kind: "confirmed_paid";
      readonly safeReasonCode: "SETTLEMENT_CONFIRMED";
      readonly policyProfile: SettlementPolicyProfile;
      readonly policyVersion: string;
      readonly verifiedAmountIdr: number;
      readonly verifiedCurrency: typeof BILLING_CURRENCY;
      readonly providerTransactionId: string;
      readonly providerStatus: string;
      readonly settledAtMs: number;
    }
  | {
      readonly kind: "pending";
      readonly safeReasonCode: "PROVIDER_PENDING";
      readonly policyProfile: SettlementPolicyProfile;
      readonly policyVersion: string;
      readonly providerRc: string;
      readonly providerStatus: string | null;
    }
  | {
      readonly kind: "expired";
      readonly safeReasonCode: "PROVIDER_EXPIRED";
      readonly policyProfile: SettlementPolicyProfile;
      readonly policyVersion: string;
      readonly providerRc: string;
      readonly providerStatus: string;
    }
  | {
      readonly kind: "failed";
      readonly safeReasonCode: "PROVIDER_FAILED";
      readonly policyProfile: SettlementPolicyProfile;
      readonly policyVersion: string;
      readonly providerRc: string;
      readonly providerStatus: string;
    }
  | {
      readonly kind: "review";
      readonly safeReasonCode: string;
      readonly policyProfile: SettlementPolicyProfile;
      readonly policyVersion: string;
      readonly providerRc: string;
      readonly providerStatus: string | null;
      readonly detail: string;
    };

function normalizeUpper(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * Pure, deterministic evaluation of an AutoLaris Advice observation against an
 * explicit settlement policy (PLAN §16.3, §16.4; REQ-057; TASK-056).
 */
export function evaluateAdviceSettlement(
  input: EvaluateAdviceSettlementInput,
): AdviceSettlementDecision {
  const policy = input.policy ?? DEFAULT_PRODUCTION_SETTLEMENT_POLICY;
  const expectedTrxId = input.expectedProviderTransactionId.trim();
  const expectedReffId = input.expectedReffId.trim();
  const expectedCurrency = input.expectedCurrency ?? BILLING_CURRENCY;
  const expectedTotalIdr = assertExactIdrInteger(
    input.expectedTotalPayableIdr,
    "expectedTotalPayableIdr",
    { min: 1, max: MAX_IDR_AMOUNT },
  );
  const nowMs = Math.trunc(input.nowMs);
  const obs = input.observation;
  const rc = obs.rc.trim();
  const paymentStatus = normalizeUpper(obs.paymentStatus);
  const shippingStatus = normalizeUpper(obs.shippingStatus);
  const ketUpper = normalizeUpper(obs.ket);
  const observedTrxId = obs.providerTransactionId?.trim() || null;
  const observedReffId = obs.reffId?.trim() || null;
  const observedCurrency = normalizeUpper(obs.currency) || null;

  if (!expectedTrxId) {
    return {
      kind: "review",
      safeReasonCode: "MISSING_PROVIDER_TRANSACTION_ID",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus || shippingStatus || null,
      detail: "Percobaan pembayaran tidak memiliki provider transaction_id.",
    };
  }

  // Always cross-check provider transaction_id and reff_id whenever returned, even on pending/expired/failed!
  if (observedTrxId !== null && observedTrxId !== expectedTrxId) {
    return {
      kind: "review",
      safeReasonCode: "ADVICE_TRANSACTION_ID_MISMATCH",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus || shippingStatus || null,
      detail: "transaction_id pada respons Advice tidak cocok dengan percobaan lokal.",
    };
  }

  if (observedReffId !== null && observedReffId !== expectedReffId) {
    return {
      kind: "review",
      safeReasonCode: "ADVICE_REFF_ID_MISMATCH",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus || shippingStatus || null,
      detail: "reff_id pada respons Advice tidak cocok dengan percobaan lokal.",
    };
  }

  // 1. Observed AutoLaris pending response (`rc: "02"` / `PENDING`) — safe no-op stay pending
  if (policy.pendingResponseCodes.includes(rc)) {
    return {
      kind: "pending",
      safeReasonCode: "PROVIDER_PENDING",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus || ketUpper || "PENDING",
    };
  }

  // 2. Non-"00" non-pending rc -> unknown / provider not found -> safe review (never paid, never silent close)
  if (rc !== "00") {
    const safeReasonCode =
      rc === "04" || rc === "404" || ketUpper.includes("NOT FOUND")
        ? "PROVIDER_TRANSACTION_NOT_FOUND"
        : "ADVICE_NON_ZERO_RC";
    return {
      kind: "review",
      safeReasonCode,
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus || shippingStatus || null,
      detail: `Respons Advice mengembalikan rc "${rc}" yang tidak dikenali; masuk antrean tinjauan.`,
    };
  }

  // 3. Explicit pending / expired / failed statuses inside rc === "00"
  if (paymentStatus && policy.pendingPaymentStatuses.includes(paymentStatus)) {
    return {
      kind: "pending",
      safeReasonCode: "PROVIDER_PENDING",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus,
    };
  }

  if (paymentStatus && policy.expiredPaymentStatuses.includes(paymentStatus)) {
    return {
      kind: "expired",
      safeReasonCode: "PROVIDER_EXPIRED",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus,
    };
  }

  if (paymentStatus && policy.failedPaymentStatuses.includes(paymentStatus)) {
    return {
      kind: "failed",
      safeReasonCode: "PROVIDER_FAILED",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus,
    };
  }

  // 4. Hard guard: shipping vocabulary (`DELIVERED`, etc.) or generic `rc === "00"` / `SUCCESS` / `BERHASIL`
  //    MUST NEVER grant access under ANY policy!
  if (
    (shippingStatus && SHIPPING_VOCABULARY_STATUSES.has(shippingStatus) && !paymentStatus) ||
    (paymentStatus && SHIPPING_VOCABULARY_STATUSES.has(paymentStatus))
  ) {
    return {
      kind: "review",
      safeReasonCode: "SHIPPING_STATUS_NOT_PAYMENT_PROOF",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus || shippingStatus,
      detail: "Status pengiriman (seperti DELIVERED) bukan bukti pelunasan pembayaran.",
    };
  }

  if (!paymentStatus || FORBIDDEN_GENERIC_SETTLEMENT_STATUSES.has(paymentStatus)) {
    return {
      kind: "review",
      safeReasonCode: "GENERIC_STATUS_NOT_PAYMENT_PROOF",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus || ketUpper || null,
      detail: "Kode rc=00 atau status generik (SUCCESS/BERHASIL) tidak pernah cukup untuk mengaktifkan langganan.",
    };
  }

  // 5. Real-provider safety gate: NEVER grant entitlement unless an explicit verified policy allows it!
  if (
    !policy.allowSettlementGrant ||
    policy.realProviderMappingStatus !== "MOCK_ONLY_VERIFIED" ||
    policy.profile !== "mock_only_verified_policy"
  ) {
    return {
      kind: "review",
      safeReasonCode: "REAL_PROVIDER_SETTLEMENT_MAPPING_UNVERIFIED",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus,
      detail:
        "Mapping settlement AutoLaris live masih UNVERIFIED; pemberian akses ditahan dan masuk antrean tinjauan.",
    };
  }

  // 6. Verify response code and payment status are explicitly whitelisted in the verified policy
  const allowedStatuses = policy.confirmedPaymentStatuses.map((s) => s.trim().toUpperCase());
  if (
    !policy.confirmedResponseCodes.includes(rc) ||
    !allowedStatuses.includes(paymentStatus)
  ) {
    return {
      kind: "review",
      safeReasonCode: "ADVICE_UNMAPPED_PAYMENT_STATUS",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus,
      detail: `Status pembayaran "${paymentStatus}" tidak terdaftar dalam kebijakan settlement terverifikasi.`,
    };
  }

  // 7. Strict evidence verification: provider transaction_id, exact IDR amount, explicit currency
  if (observedTrxId === null || observedTrxId !== expectedTrxId) {
    return {
      kind: "review",
      safeReasonCode: "ADVICE_TRANSACTION_ID_EVIDENCE_MISSING",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus,
      detail: "Bukti transaction_id pada respons Advice tidak tersedia atau tidak cocok.",
    };
  }

  if (obs.paidAmountIdr === null || !Number.isSafeInteger(obs.paidAmountIdr)) {
    return {
      kind: "review",
      safeReasonCode: "ADVICE_AMOUNT_EVIDENCE_MISSING",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus,
      detail: "Bukti nominal pembayaran tidak tersedia pada respons Advice; masuk tinjauan.",
    };
  }

  if (obs.paidAmountIdr !== expectedTotalIdr) {
    return {
      kind: "review",
      safeReasonCode: "ADVICE_AMOUNT_MISMATCH",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus,
      detail: `Nominal Advice (${obs.paidAmountIdr} IDR) tidak cocok dengan total tagihan (${expectedTotalIdr} IDR).`,
    };
  }

  if (observedCurrency === null) {
    return {
      kind: "review",
      safeReasonCode: "ADVICE_CURRENCY_EVIDENCE_MISSING",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus,
      detail: "Bukti mata uang tidak tersedia pada respons Advice; masuk tinjauan.",
    };
  }

  if (observedCurrency !== expectedCurrency) {
    return {
      kind: "review",
      safeReasonCode: "ADVICE_CURRENCY_MISMATCH",
      policyProfile: policy.profile,
      policyVersion: policy.policyVersion,
      providerRc: rc,
      providerStatus: paymentStatus,
      detail: `Mata uang Advice (${observedCurrency}) tidak cocok dengan ${expectedCurrency}.`,
    };
  }

  const settledAtMs =
    typeof obs.settledAtMs === "number" && Number.isFinite(obs.settledAtMs) && obs.settledAtMs > 0
      ? Math.trunc(obs.settledAtMs)
      : nowMs;

  return {
    kind: "confirmed_paid",
    safeReasonCode: "SETTLEMENT_CONFIRMED",
    policyProfile: policy.profile,
    policyVersion: policy.policyVersion,
    verifiedAmountIdr: expectedTotalIdr,
    verifiedCurrency: BILLING_CURRENCY,
    providerTransactionId: expectedTrxId,
    providerStatus: paymentStatus,
    settledAtMs,
  };
}

// ---------------------------------------------------------------------------
// Bounded Reconciliation Leases, Batch Caps, and Poll Backoff (PLAN §16.4)
// ---------------------------------------------------------------------------

export const DEFAULT_ADVICE_LEASE_MS = 60_000 as const; // 60 seconds
export const MIN_ADVICE_LEASE_MS = 5_000 as const;
export const MAX_ADVICE_LEASE_MS = 300_000 as const; // 5 minutes ceiling

export const DEFAULT_ADVICE_BATCH_LIMIT = 20 as const;
export const MAX_ADVICE_BATCH_LIMIT = 50 as const;

export const DEFAULT_ADVICE_MAX_POLLS = 24 as const;
export const MAX_ADVICE_POLLS_CEILING = 100 as const;

/** Bounded window after local expiry during which late settlements are still polled (24h). */
export const DEFAULT_EXPIRED_GRACE_POLL_WINDOW_MS = 24 * 60 * 60 * 1000;

export const ADVICE_BASE_BACKOFF_MS = 30_000 as const; // 30s
export const ADVICE_MAX_BACKOFF_MS = 900_000 as const; // 15m cap

export function clampAdviceLeaseMs(rawMs: number | undefined): number {
  if (typeof rawMs !== "number" || !Number.isFinite(rawMs)) {
    return DEFAULT_ADVICE_LEASE_MS;
  }
  return Math.max(MIN_ADVICE_LEASE_MS, Math.min(MAX_ADVICE_LEASE_MS, Math.trunc(rawMs)));
}

export function clampAdviceBatchLimit(rawLimit: number | undefined): number {
  if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit)) {
    return DEFAULT_ADVICE_BATCH_LIMIT;
  }
  return Math.max(1, Math.min(MAX_ADVICE_BATCH_LIMIT, Math.trunc(rawLimit)));
}

export function clampAdviceMaxPolls(rawMax: number | undefined): number {
  if (typeof rawMax !== "number" || !Number.isFinite(rawMax)) {
    return DEFAULT_ADVICE_MAX_POLLS;
  }
  return Math.max(1, Math.min(MAX_ADVICE_POLLS_CEILING, Math.trunc(rawMax)));
}

/**
 * Deterministic bounded exponential backoff for Advice polling (30s -> 60s -> 120s -> ... capped at 15m).
 */
export function computeAdviceNextPollDelayMs(
  pollCount: number,
  options?: {
    readonly baseBackoffMs?: number;
    readonly maxBackoffMs?: number;
    readonly jitterRatio?: number;
  },
): number {
  const safeCount = Math.max(1, Math.trunc(pollCount));
  const base = Math.max(1_000, Math.trunc(options?.baseBackoffMs ?? ADVICE_BASE_BACKOFF_MS));
  const cap = Math.max(base, Math.trunc(options?.maxBackoffMs ?? ADVICE_MAX_BACKOFF_MS));
  const exponent = Math.min(10, safeCount - 1);
  const raw = Math.min(cap, base * 2 ** exponent);
  const jitter =
    typeof options?.jitterRatio === "number" && Number.isFinite(options.jitterRatio)
      ? Math.max(-0.2, Math.min(0.2, options.jitterRatio))
      : 0;
  return Math.max(1_000, Math.min(cap, Math.round(raw * (1 + jitter))));
}

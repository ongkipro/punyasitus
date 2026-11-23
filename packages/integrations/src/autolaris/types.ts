import type {
  AllowedPaymentChannelKind,
  BillingPlanInterval,
  RawAutoLarisAdviceObservation,
  ValidatedPaymentChannel,
} from "@punyasitus/core/billing/index";

/**
 * AutoLaris H2H static-IP relay client types (PLAN §16.1, §16.2; REQ-056).
 */

export interface AutoLarisDigitalProfileConfig {
  /** Merchant-approved origin area ID for non-physical `/submit` schema parity. */
  readonly originAreaId: number;
  /** Merchant-approved destination area ID for non-physical `/submit` schema parity. */
  readonly destinationAreaId: number;
  readonly shipperName: string;
  readonly shipperPhone: string;
  readonly shipperEmail: string;
  readonly shipperAddress: string;
}

export interface AutoLarisRelayConfig {
  /**
   * Configured static-IP egress relay origin (HTTPS only, e.g. `https://relay.punyasitus.com`)
   * or fixed AutoLaris origin `https://api-h2h.autolaris.com`. Never client-supplied.
   */
  readonly relayBaseUrl: string;
  /** Server-side Bearer API key; never logged or exposed in errors. */
  readonly apiKey: string;
  /** Account scope identifier for unique `reff_id` / `transaction_id` constraints. */
  readonly providerAccountId?: string;
  /** Request timeout in milliseconds (bounded 1,000..30,000; default 10,000). */
  readonly timeoutMs?: number;
  /** Injectable fetch implementation for synthetic/mocked testing. */
  readonly fetchImpl?: typeof fetch;
  /** Optional allowlist of approved HTTPS payment redirect hostnames. */
  readonly allowedRedirectHosts?: readonly string[];
  /** Merchant-approved non-physical digital profile fields (default test-safe merchant defaults). */
  readonly digitalProfile?: Partial<AutoLarisDigitalProfileConfig>;
}

export interface SubmitDigitalOrderInput {
  readonly reffId: string;
  readonly channelKind: AllowedPaymentChannelKind;
  readonly channelCode: string;
  readonly plan: BillingPlanInterval;
  readonly netAmountIdr: number;
  readonly tenantHandle: string;
  readonly payerName: string;
  readonly payerEmail: string;
  readonly payerPhone?: string | null;
}

export interface ValidatedAutoLarisSubmitResult {
  readonly providerAccountId: string;
  readonly providerTransactionId: string;
  readonly reffId: string;
  readonly channelKind: AllowedPaymentChannelKind;
  readonly channelCode: string;
  readonly channelFeeIdr: number;
  readonly grossAdminFeeIdr: number;
  readonly providerDiscountIdr: number;
  readonly totalPayableIdr: number;
  readonly qrisPayload: string | null;
  readonly vaNumber: string | null;
  readonly bankName: string | null;
  readonly paymentRedirectUrl: string | null;
  readonly expiresAtMs: number | null;
  readonly expiresAtIso: string | null;
}

export interface CheckAutoLarisAdviceInput {
  /** Strictly the provider-issued `transaction_id`; NEVER a local `reff_id`. */
  readonly providerTransactionId: string;
}

export interface AutoLarisBillingClient {
  readonly providerAccountId: string;
  readonly relayOrigin: string;
  listPaymentChannels(referenceBaseAmountIdr?: number): Promise<readonly ValidatedPaymentChannel[]>;
  submitDigitalSubscriptionOrder(
    input: SubmitDigitalOrderInput,
  ): Promise<ValidatedAutoLarisSubmitResult>;
  checkTransactionAdvice(
    input: CheckAutoLarisAdviceInput,
  ): Promise<RawAutoLarisAdviceObservation>;
}

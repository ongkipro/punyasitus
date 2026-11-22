import type { ApiErrorCode } from "../schemas/common.ts";

export interface BillingErrorField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class BillingValidationError extends Error {
  readonly status = 422 as const;
  readonly code: ApiErrorCode = "VALIDATION_ERROR";
  readonly reasonCode: string;
  readonly fields: readonly BillingErrorField[];

  constructor(
    reasonCode: string,
    message: string,
    fields: readonly BillingErrorField[] = [],
  ) {
    super(message);
    this.name = "BillingValidationError";
    this.reasonCode = reasonCode;
    this.fields = fields;
  }
}

export class BillingConflictError extends Error {
  readonly status = 409 as const;
  readonly code: "IDEMPOTENCY_CONFLICT" | "CONFLICT";
  readonly reasonCode: string;

  constructor(
    code: "IDEMPOTENCY_CONFLICT" | "CONFLICT",
    reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "BillingConflictError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

export class BillingNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code: ApiErrorCode = "NOT_FOUND";

  constructor(message = "Tagihan atau percobaan pembayaran tidak ditemukan.") {
    super(message);
    this.name = "BillingNotFoundError";
  }
}

export type BillingProviderErrorKind =
  | "definite_refusal"
  | "uncertain_timeout_or_network"
  | "invalid_provider_payload"
  | "relay_config_error";

export class BillingProviderError extends Error {
  readonly status = 503 as const;
  readonly code: ApiErrorCode = "SERVICE_UNAVAILABLE";
  readonly kind: BillingProviderErrorKind;
  readonly safeFailureCode: string;
  readonly providerTransactionId: string | null;

  constructor(
    kind: BillingProviderErrorKind,
    safeFailureCode: string,
    message: string,
    options?: { readonly providerTransactionId?: string | null },
  ) {
    super(message);
    this.name = "BillingProviderError";
    this.kind = kind;
    this.safeFailureCode = safeFailureCode;
    this.providerTransactionId = options?.providerTransactionId ?? null;
  }
}

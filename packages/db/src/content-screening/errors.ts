export interface ContentScreeningFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export type ContentScreeningErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "ALREADY_REVIEWED"
  | "TENANT_NOT_ELIGIBLE"
  | "TENANT_STORE_UNAVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "SNAPSHOT_MISMATCH"
  | "TOO_MANY_PENDING_REVIEWS"
  | "AUDIT_PERSISTENCE_FAILED"
  | "SERVICE_UNAVAILABLE";

export class ContentScreeningError extends Error {
  readonly status: 400 | 404 | 409 | 422 | 429 | 500 | 503;
  readonly code: ContentScreeningErrorCode;
  readonly fields: readonly ContentScreeningFieldError[];

  constructor(
    status: 400 | 404 | 409 | 422 | 429 | 500 | 503,
    code: ContentScreeningErrorCode,
    message: string,
    fields: readonly ContentScreeningFieldError[] = [],
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ContentScreeningError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

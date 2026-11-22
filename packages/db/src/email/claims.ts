import type { EmailDeliveryOutcome, EmailProviderName, EmailTemplateName } from "@punyasitus/core/email/index";
import { sanitizeErrorCode } from "@punyasitus/core/jobs/index";

export type EmailClaimStatus = "claimed" | EmailDeliveryOutcome;

interface EmailDeliveryClaimSqlRow {
  readonly message_key: string;
  readonly template: string;
  readonly one_shot: number;
  readonly status: EmailClaimStatus;
  readonly provider: string | null;
  readonly error_code: string | null;
  readonly attempts: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface EmailDeliveryClaimRecord {
  readonly messageKey: string;
  readonly template: string;
  readonly oneShot: boolean;
  readonly status: EmailClaimStatus;
  readonly provider: string | null;
  readonly errorCode: string | null;
  readonly attempts: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const RETRYABLE_DEFINITE_REFUSAL_CODES = new Set([
  "E_RATE_LIMITED",
  "E_RATE_LIMIT",
  "E_TOO_MANY_REQUESTS",
  "E_QUOTA_EXCEEDED",
  "E_TEMPORARILY_UNAVAILABLE",
]);

export function isRetryableDefiniteRefusalCode(errorCode: string | null | undefined): boolean {
  if (!errorCode) return false;
  return RETRYABLE_DEFINITE_REFUSAL_CODES.has(errorCode.trim().toUpperCase());
}

function mapClaimRow(row: EmailDeliveryClaimSqlRow): EmailDeliveryClaimRecord {
  return {
    messageKey: row.message_key,
    template: row.template,
    oneShot: row.one_shot === 1,
    status: row.status,
    provider: row.provider,
    errorCode: row.error_code ? sanitizeErrorCode(row.error_code) : null,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ClaimEmailDeliveryInput {
  readonly messageKey: string;
  readonly template: EmailTemplateName | string;
  readonly oneShot?: boolean;
  /**
   * Only set `true` by the queue retry path after a definitely-refused transient error
   * (such as `E_RATE_LIMITED`). Ambiguous `unknown`, `submitted`, `claimed`, `skipped`,
   * and permanent `failed` claims are NEVER re-claimed even when this flag is `true`.
   */
  readonly allowRetryOnDefiniteFailure?: boolean;
  readonly nowMs?: number;
}

export type ClaimEmailDeliveryResult =
  | {
      readonly outcome: "claimed";
      readonly record: EmailDeliveryClaimRecord;
    }
  | {
      readonly outcome: "duplicate";
      readonly record: EmailDeliveryClaimRecord;
    };

/**
 * Atomically claims a transactional email `messageKey` before calling `EmailPort.send()`.
 *
 * - Uses `INSERT OR IGNORE` so duplicate `messageKey` deliveries return `"duplicate"` and NEVER replay.
 * - Ambiguous `unknown` outcomes are terminal for one-shot messages and NEVER replayed.
 * - Stores ZERO recipient email addresses and ZERO email body/text.
 */
export async function claimEmailDelivery(
  db: D1Database,
  input: ClaimEmailDeliveryInput,
): Promise<ClaimEmailDeliveryResult> {
  const messageKey = input.messageKey.trim();
  const template = input.template.trim();
  if (!messageKey || messageKey.length > 256 || /[\r\n\0]/.test(messageKey)) {
    throw new RangeError("INVALID_MESSAGE_KEY: messageKey must be a clean non-empty string");
  }
  if (!template || template.length > 128) {
    throw new RangeError("INVALID_TEMPLATE: template must be non-empty");
  }

  const oneShot = input.oneShot ?? true;
  const nowMs = Math.floor(input.nowMs ?? Date.now());

  const insertRes = await db
    .prepare(
      `INSERT OR IGNORE INTO email_delivery_claims (
         message_key,
         template,
         one_shot,
         status,
         provider,
         error_code,
         attempts,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, 'claimed', NULL, NULL, 1, ?, ?)`,
    )
    .bind(messageKey, template, oneShot ? 1 : 0, nowMs, nowMs)
    .run();

  if ((insertRes.meta?.changes ?? 0) === 1) {
    return {
      outcome: "claimed",
      record: {
        messageKey,
        template,
        oneShot,
        status: "claimed",
        provider: null,
        errorCode: null,
        attempts: 1,
        createdAt: nowMs,
        updatedAt: nowMs,
      },
    };
  }

  const existing = await getEmailDeliveryClaim(db, messageKey);
  if (!existing) {
    throw new Error(`EMAIL_CLAIM_MISSING: claim row disappeared for ${messageKey}`);
  }

  // Only a definitely-refused transient failure (e.g. E_RATE_LIMITED) may re-enter `claimed`
  // on an explicit queue retry. `unknown` (ambiguous timeout/network), `submitted`, `claimed`,
  // `skipped`, and non-retryable `failed` rows are strictly terminal and NEVER replayed.
  if (
    input.allowRetryOnDefiniteFailure === true &&
    existing.status === "failed" &&
    isRetryableDefiniteRefusalCode(existing.errorCode)
  ) {
    const reclaimed = await db
      .prepare(
        `UPDATE email_delivery_claims
         SET status = 'claimed',
             attempts = attempts + 1,
             updated_at = ?
         WHERE message_key = ?
           AND status = 'failed'
         RETURNING
           message_key,
           template,
           one_shot,
           status,
           provider,
           error_code,
           attempts,
           created_at,
           updated_at`,
      )
      .bind(nowMs, messageKey)
      .first<EmailDeliveryClaimSqlRow>();

    if (reclaimed) {
      return {
        outcome: "claimed",
        record: mapClaimRow(reclaimed),
      };
    }
  }

  return {
    outcome: "duplicate",
    record: existing,
  };
}

export interface RecordEmailOutcomeInput {
  readonly messageKey: string;
  readonly template?: EmailTemplateName | string;
  readonly oneShot?: boolean;
  readonly status: EmailDeliveryOutcome;
  readonly provider?: EmailProviderName | string | null;
  readonly errorCode?: unknown;
  readonly nowMs?: number;
}

/**
 * Records a delivery outcome (`submitted`, `failed`, `unknown`, `skipped`, `duplicate`)
 * in `PLATFORM_DB.email_delivery_claims` with a sanitized error code only.
 * Never persists recipient email addresses or email body/text.
 */
export async function recordEmailOutcome(
  db: D1Database,
  input: RecordEmailOutcomeInput,
): Promise<EmailDeliveryClaimRecord> {
  const messageKey = input.messageKey.trim();
  if (!messageKey) {
    throw new RangeError("INVALID_MESSAGE_KEY: messageKey must be non-empty");
  }
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const provider = input.provider ? input.provider.trim().slice(0, 32) : null;
  const errorCode =
    input.errorCode === undefined || input.errorCode === null
      ? null
      : sanitizeErrorCode(input.errorCode);

  const updated = await db
    .prepare(
      `UPDATE email_delivery_claims
       SET status = ?,
           provider = COALESCE(?, provider),
           error_code = ?,
           updated_at = ?
       WHERE message_key = ?
       RETURNING
         message_key,
         template,
         one_shot,
         status,
         provider,
         error_code,
         attempts,
         created_at,
         updated_at`,
    )
    .bind(input.status, provider, errorCode, nowMs, messageKey)
    .first<EmailDeliveryClaimSqlRow>();

  if (updated) {
    return mapClaimRow(updated);
  }

  // Insert a row when recording `skipped` before claiming (e.g. suppressed recipient or unbound transport)
  const template = (input.template ?? "unknown").trim();
  const oneShot = input.oneShot ?? true;
  await db
    .prepare(
      `INSERT OR IGNORE INTO email_delivery_claims (
         message_key,
         template,
         one_shot,
         status,
         provider,
         error_code,
         attempts,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(messageKey, template, oneShot ? 1 : 0, input.status, provider, errorCode, nowMs, nowMs)
    .run();

  const created = await getEmailDeliveryClaim(db, messageKey);
  if (!created) {
    throw new Error(`EMAIL_CLAIM_WRITE_FAILED: unable to persist outcome for ${messageKey}`);
  }
  return created;
}

/**
 * Reads a sanitized `email_delivery_claims` record by `messageKey`.
 */
export async function getEmailDeliveryClaim(
  db: D1Database,
  messageKey: string,
): Promise<EmailDeliveryClaimRecord | null> {
  const row = await db
    .prepare(
      `SELECT
         message_key,
         template,
         one_shot,
         status,
         provider,
         error_code,
         attempts,
         created_at,
         updated_at
       FROM email_delivery_claims
       WHERE message_key = ?`,
    )
    .bind(messageKey.trim())
    .first<EmailDeliveryClaimSqlRow>();

  return row ? mapClaimRow(row) : null;
}

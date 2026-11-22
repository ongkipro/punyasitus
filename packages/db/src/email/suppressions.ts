import { maskEmailForNotice } from "@punyasitus/core/email/index";

export const EMAIL_SUPPRESSION_REASONS = [
  "hard_bounce",
  "complaint",
  "manual_opt_out",
] as const;

export type EmailSuppressionReason = (typeof EMAIL_SUPPRESSION_REASONS)[number];

interface EmailSuppressionSqlRow {
  readonly email_hash: string;
  readonly reason: EmailSuppressionReason;
  readonly source: string;
  readonly created_at: number;
}

export interface EmailSuppressionRecord {
  readonly emailHash: string;
  readonly reason: EmailSuppressionReason;
  readonly source: string;
  readonly createdAt: number;
}

export interface EmailHashOptions {
  readonly salt?: string;
}

/**
 * Normalizes an email address (trimmed lowercase) before hashing.
 */
export function normalizeEmailAddress(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@") || /[\r\n\0]/.test(normalized)) {
    throw new RangeError("INVALID_EMAIL_ADDRESS: email must be a valid address");
  }
  return normalized;
}

/**
 * Computes a lowercase SHA-256 hex digest of a normalized email address
 * (with optional platform salt) using Web Crypto so it works identically in Node and `workerd`.
 */
export async function hashEmailAddress(
  email: string,
  options?: EmailHashOptions,
): Promise<string> {
  const normalized = normalizeEmailAddress(email);
  const salt = options?.salt?.trim();
  const preimage = salt ? `${salt}:${normalized}` : normalized;
  const bytes = new TextEncoder().encode(preimage);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Looks up a suppression entry in `PLATFORM_DB.email_suppressions` by SHA-256 email hash.
 */
export async function getEmailSuppression(
  db: D1Database,
  email: string,
  options?: EmailHashOptions,
): Promise<EmailSuppressionRecord | null> {
  const emailHash = await hashEmailAddress(email, options);
  const row = await db
    .prepare(
      `SELECT email_hash, reason, source, created_at
       FROM email_suppressions
       WHERE email_hash = ?`,
    )
    .bind(emailHash)
    .first<EmailSuppressionSqlRow>();

  if (!row) return null;
  return {
    emailHash: row.email_hash,
    reason: row.reason,
    source: row.source,
    createdAt: row.created_at,
  };
}

/**
 * Returns `true` when the recipient address is present in `PLATFORM_DB.email_suppressions`.
 */
export async function isEmailSuppressed(
  db: D1Database,
  email: string,
  options?: EmailHashOptions,
): Promise<boolean> {
  const record = await getEmailSuppression(db, email, options);
  return record !== null;
}

export interface AddEmailSuppressionInput {
  readonly email: string;
  readonly reason: EmailSuppressionReason;
  readonly source: string;
  readonly salt?: string;
  readonly nowMs?: number;
}

export interface AddEmailSuppressionResult {
  readonly added: boolean;
  readonly record: EmailSuppressionRecord;
}

/**
 * Adds or updates a hashed email entry in `PLATFORM_DB.email_suppressions`.
 * Never persists raw recipient email addresses.
 */
export async function addEmailSuppression(
  db: D1Database,
  input: AddEmailSuppressionInput,
): Promise<AddEmailSuppressionResult> {
  const emailHash = await hashEmailAddress(input.email, { salt: input.salt });
  const source = input.source.trim().slice(0, 120) || "system";
  const nowMs = Math.floor(input.nowMs ?? Date.now());

  const insertRes = await db
    .prepare(
      `INSERT OR IGNORE INTO email_suppressions (email_hash, reason, source, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(emailHash, input.reason, source, nowMs)
    .run();

  const added = (insertRes.meta?.changes ?? 0) === 1;
  if (!added) {
    await db
      .prepare(
        `UPDATE email_suppressions
         SET reason = ?, source = ?
         WHERE email_hash = ?`,
      )
      .bind(input.reason, source, emailHash)
      .run();
  }

  const row = await db
    .prepare(
      `SELECT email_hash, reason, source, created_at
       FROM email_suppressions
       WHERE email_hash = ?`,
    )
    .bind(emailHash)
    .first<EmailSuppressionSqlRow>();

  return {
    added,
    record: row
      ? {
          emailHash: row.email_hash,
          reason: row.reason,
          source: row.source,
          createdAt: row.created_at,
        }
      : {
          emailHash,
          reason: input.reason,
          source,
          createdAt: nowMs,
        },
  };
}

export interface OwnerSuppressionNotice {
  readonly suppressed: true;
  readonly emailHash: string;
  readonly maskedEmail: string;
  readonly reason: EmailSuppressionReason;
  readonly source: string;
  readonly suppressedAt: number;
  readonly severity: "warning";
  readonly title: string;
  readonly message: string;
  readonly actionLabel: string;
}

const REASON_EXPLANATION_ID: Readonly<Record<EmailSuppressionReason, string>> = {
  hard_bounce: "alamat email menolak pesan secara permanen (hard bounce)",
  complaint: "pesan sebelumnya ditandai sebagai spam",
  manual_opt_out: "alamat email dinonaktifkan dari pengiriman notifikasi",
};

/**
 * Returns a visible Bahasa Indonesia owner notice banner payload when an owner's email
 * is suppressed (REQ-077). Explicitly states that account access is unaffected.
 */
export async function getSuppressionNoticeForOwner(
  db: D1Database,
  ownerEmail: string,
  options?: EmailHashOptions,
): Promise<OwnerSuppressionNotice | null> {
  const suppression = await getEmailSuppression(db, ownerEmail, options);
  if (!suppression) return null;

  const maskedEmail = maskEmailForNotice(ownerEmail);
  return {
    suppressed: true,
    emailHash: suppression.emailHash,
    maskedEmail,
    reason: suppression.reason,
    source: suppression.source,
    suppressedAt: suppression.createdAt,
    severity: "warning",
    title: "Pengiriman email ke alamat akun Anda sedang dihentikan",
    message: `Pengiriman email ke ${maskedEmail} dihentikan karena ${REASON_EXPLANATION_ID[suppression.reason]}. Akses akun dan website Anda tetap normal, tetapi Anda tidak akan menerima kwitansi atau notifikasi penting sampai alamat email diperbarui.`,
    actionLabel: "Perbarui alamat email",
  };
}

/**
 * Atomically records a bounce/complaint webhook event ID for replay protection.
 * Returns `true` if the event ID is fresh, or `false` if it was already processed.
 */
export async function recordWebhookEventOnce(
  db: D1Database,
  input: {
    readonly eventId: string;
    readonly eventType: string;
    readonly nowMs?: number;
  },
): Promise<boolean> {
  const eventId = input.eventId.trim();
  const eventType = input.eventType.trim().slice(0, 64) || "unknown";
  if (!eventId || eventId.length > 200 || /[\r\n\0]/.test(eventId)) {
    throw new RangeError("INVALID_WEBHOOK_EVENT_ID: eventId must be non-empty");
  }
  const nowMs = Math.floor(input.nowMs ?? Date.now());

  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO email_webhook_events (event_id, event_type, received_at)
       VALUES (?, ?, ?)`,
    )
    .bind(eventId, eventType, nowMs)
    .run();

  return (res.meta?.changes ?? 0) === 1;
}

export interface RecordWebhookBounceAtomicallyInput {
  readonly eventId: string;
  readonly eventType: "hard_bounce" | "complaint";
  readonly email: string;
  readonly reason: EmailSuppressionReason;
  readonly source: string;
  readonly salt?: string;
  readonly nowMs?: number;
}

export type RecordWebhookBounceAtomicallyResult =
  | { readonly kind: "recorded"; readonly emailHash: string }
  | { readonly kind: "replayed" };

/**
 * Atomically records a webhook event ID and upserts the recipient's hashed suppression
 * inside one D1 transaction (`db.batch`). If writing `email_suppressions` fails,
 * `email_webhook_events` rolls back too so provider retries are never lost to false 409s.
 */
export async function recordWebhookBounceAtomically(
  db: D1Database,
  input: RecordWebhookBounceAtomicallyInput,
): Promise<RecordWebhookBounceAtomicallyResult> {
  const eventId = input.eventId.trim();
  const eventType = input.eventType.trim().slice(0, 64);
  if (!eventId || eventId.length > 200 || /[\r\n\0]/.test(eventId)) {
    throw new RangeError("INVALID_WEBHOOK_EVENT_ID: eventId must be non-empty");
  }
  const emailHash = await hashEmailAddress(input.email, { salt: input.salt });
  const source = input.source.trim().slice(0, 120) || "webhook:email";
  const nowMs = Math.floor(input.nowMs ?? Date.now());

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO email_webhook_events (event_id, event_type, received_at)
           VALUES (?, ?, ?)`,
        )
        .bind(eventId, eventType, nowMs),
      db
        .prepare(
          `INSERT INTO email_suppressions (email_hash, reason, source, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(email_hash) DO UPDATE SET
             reason = excluded.reason,
             source = excluded.source`,
        )
        .bind(emailHash, input.reason, source, nowMs),
    ]);
    return { kind: "recorded", emailHash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /UNIQUE constraint failed.*email_webhook_events\.event_id/i.test(msg) ||
      /PRIMARY KEY constraint failed/i.test(msg)
    ) {
      return { kind: "replayed" };
    }
    throw err;
  }
}

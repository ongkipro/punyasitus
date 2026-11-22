import {
  ALLOWED_EMAIL_SENDER,
  sanitizeHeaderValue,
  type EmailTemplateName,
} from "./templates.ts";

export type EmailProviderName = "cloudflare" | "resend" | "local-sink";

export const EMAIL_DELIVERY_OUTCOMES = [
  "submitted",
  "failed",
  "unknown",
  "skipped",
  "duplicate",
] as const;

export type EmailDeliveryOutcome = (typeof EMAIL_DELIVERY_OUTCOMES)[number];

export interface EmailAttachmentInput {
  readonly filename: string;
  readonly contentType: string;
  /** Raw bytes or an already Base64-encoded string. Always transmitted as Base64. */
  readonly content: Uint8Array | string;
  readonly disposition?: "attachment" | "inline";
  readonly contentId?: string;
}

export interface NormalizedEmailAttachment {
  readonly filename: string;
  readonly contentType: string;
  /** Standard Base64-encoded string (avoids binary attachment serialization issues). */
  readonly content: string;
  readonly disposition: "attachment" | "inline";
  readonly contentId?: string;
}

export interface EmailSendRequest {
  readonly messageKey: string;
  readonly template: EmailTemplateName;
  /** Defaults to `noreply@notif.punyasitus.com`; any other address fails with `E_SENDER_NOT_VERIFIED`. */
  readonly from?: string;
  readonly fromName?: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly replyTo?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: readonly EmailAttachmentInput[];
  readonly oneShot?: boolean;
  readonly tenantId?: string | null;
}

export type EmailSendResult =
  | {
      readonly outcome: "submitted";
      readonly provider: EmailProviderName;
      readonly providerMessageId: string | null;
    }
  | {
      readonly outcome: "failed";
      readonly provider: EmailProviderName;
      readonly errorCode: string;
      readonly retryable: boolean;
      readonly suppressed: boolean;
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly outcome: "unknown";
      readonly provider: EmailProviderName;
      readonly errorCode: string;
    };

export interface EmailPort {
  readonly provider: EmailProviderName;
  send(request: EmailSendRequest): Promise<EmailSendResult>;
}

export class EmailSenderNotVerifiedError extends Error {
  readonly code = "E_SENDER_NOT_VERIFIED" as const;
  readonly retryable = false as const;

  constructor(attemptedSender: string) {
    super(
      `E_SENDER_NOT_VERIFIED: sender "${sanitizeHeaderValue(attemptedSender)}" is not allowed; only "${ALLOWED_EMAIL_SENDER}" is permitted`,
    );
    this.name = "EmailSenderNotVerifiedError";
  }
}

export class EmailValidationError extends Error {
  readonly code: string;
  readonly retryable = false as const;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EmailValidationError";
    this.code = code;
  }
}

const SIMPLE_EMAIL_RE = /^[^\s@<>,;"'\\]+@[^\s@<>,;"'\\]+\.[^\s@<>,;"'\\]{2,}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function extractRawAddress(value: string): string {
  const trimmed = value.trim();
  const angleMatch = trimmed.match(/<([^<>]+)>$/);
  if (angleMatch?.[1]) {
    return angleMatch[1].trim().toLowerCase();
  }
  return trimmed.toLowerCase();
}

/**
 * Strictly enforces the single allowed sender address (`noreply@notif.punyasitus.com`).
 * Rejects any other address with `EmailSenderNotVerifiedError` (`E_SENDER_NOT_VERIFIED`).
 */
export function assertAllowedSender(from?: string): typeof ALLOWED_EMAIL_SENDER {
  if (from === undefined || from.trim() === "") {
    return ALLOWED_EMAIL_SENDER;
  }
  if (/[\r\n\0]/.test(from)) {
    throw new EmailSenderNotVerifiedError(from);
  }
  const normalized = extractRawAddress(from);
  if (normalized !== ALLOWED_EMAIL_SENDER) {
    throw new EmailSenderNotVerifiedError(from);
  }
  return ALLOWED_EMAIL_SENDER;
}

/**
 * Validates and normalizes a single recipient email address, rejecting control characters.
 */
export function assertValidRecipient(to: string): string {
  if (typeof to !== "string" || /[\r\n\0]/.test(to)) {
    throw new EmailValidationError("E_INVALID_RECIPIENT", "Recipient address is invalid");
  }
  const trimmed = to.trim().toLowerCase();
  if (!trimmed || trimmed.length > 320 || !SIMPLE_EMAIL_RE.test(trimmed)) {
    throw new EmailValidationError("E_INVALID_RECIPIENT", "Recipient address is invalid");
  }
  return trimmed;
}

/**
 * Encodes raw bytes to a standard Base64 string using Web-standard `btoa`
 * (works identically in Node 22 and Cloudflare `workerd` without Node Buffer).
 */
export function encodeBytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Normalizes an email attachment so binary payloads (including PDF receipts)
 * are always encoded as standard Base64 strings.
 */
export function normalizeEmailAttachment(
  attachment: EmailAttachmentInput,
): NormalizedEmailAttachment {
  const filename = sanitizeHeaderValue(attachment.filename);
  const contentType = sanitizeHeaderValue(attachment.contentType);
  if (!filename) {
    throw new EmailValidationError("E_INVALID_ATTACHMENT", "Attachment filename is required");
  }
  if (!contentType || !contentType.includes("/")) {
    throw new EmailValidationError("E_INVALID_ATTACHMENT", "Attachment contentType is invalid");
  }

  let base64Content: string;
  if (attachment.content instanceof Uint8Array) {
    base64Content = encodeBytesToBase64(attachment.content);
  } else if (typeof attachment.content === "string") {
    const compact = attachment.content.replace(/\s+/g, "");
    if (!compact || compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
      throw new EmailValidationError(
        "E_INVALID_ATTACHMENT",
        "String attachment content must be valid Base64",
      );
    }
    base64Content = compact;
  } else {
    throw new EmailValidationError("E_INVALID_ATTACHMENT", "Unsupported attachment content type");
  }

  const disposition = attachment.disposition ?? "attachment";
  const contentId = attachment.contentId ? sanitizeHeaderValue(attachment.contentId) : undefined;
  return {
    filename,
    contentType,
    content: base64Content,
    disposition,
    ...(contentId ? { contentId } : {}),
  };
}

/**
 * Masks an email address for owner-facing notices without exposing the full address in logs.
 */
export function maskEmailForNotice(email: string): string {
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) {
    return "***";
  }
  const local = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  const visiblePrefix = local.length <= 2 ? local[0] ?? "*" : local.slice(0, 2);
  return `${visiblePrefix}***@${domain}`;
}

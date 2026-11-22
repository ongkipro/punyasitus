import { sanitizeErrorCode } from "../jobs/redact.ts";
import {
  EmailSenderNotVerifiedError,
  EmailValidationError,
  assertAllowedSender,
  assertValidRecipient,
  normalizeEmailAttachment,
  type EmailPort,
  type EmailProviderName,
  type EmailSendRequest,
  type EmailSendResult,
  type NormalizedEmailAttachment,
} from "./port.ts";
import { sanitizeHeaderValue, type EmailTemplateName } from "./templates.ts";

export interface CloudflareEmailAttachmentPayload {
  readonly disposition: "attachment" | "inline";
  readonly filename: string;
  readonly type: string;
  readonly content: string;
  readonly contentId?: string;
}

export interface CloudflareSendEmailPayload {
  readonly from: string | { readonly name: string; readonly email: string };
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly replyTo?: string;
  readonly headers?: Record<string, string>;
  readonly attachments?: readonly CloudflareEmailAttachmentPayload[];
}

export interface CloudflareSendEmailBinding {
  send(message: CloudflareSendEmailPayload): Promise<{ readonly messageId?: string } | void>;
}

const RETRYABLE_REFUSAL_CODES = new Set([
  "E_RATE_LIMITED",
  "E_RATE_LIMIT",
  "E_TOO_MANY_REQUESTS",
  "E_QUOTA_EXCEEDED",
  "E_TEMPORARILY_UNAVAILABLE",
]);

const AMBIGUOUS_ERROR_CODES = new Set([
  "E_TIMEOUT",
  "E_NETWORK",
  "E_UNKNOWN",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNABORTED",
  "EAI_AGAIN",
  "ABORT_ERROR",
  "TIMEOUT_ERROR",
  "NETWORK_ERROR",
]);

const DEFINITE_CF_REFUSAL_RE = /\b(E_[A-Z0-9_]+)\b/;

function sanitizeHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const cleanKey = sanitizeHeaderValue(k);
    if (!cleanKey) continue;
    out[cleanKey] = sanitizeHeaderValue(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractRetryAfterSeconds(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const record = err as { retryAfterSeconds?: unknown; retryAfter?: unknown };
    if (
      typeof record.retryAfterSeconds === "number" &&
      Number.isFinite(record.retryAfterSeconds) &&
      record.retryAfterSeconds > 0
    ) {
      return Math.round(record.retryAfterSeconds);
    }
    if (
      typeof record.retryAfter === "number" &&
      Number.isFinite(record.retryAfter) &&
      record.retryAfter > 0
    ) {
      return Math.round(record.retryAfter);
    }
  }
  return undefined;
}

function extractErrorCodeAndStatus(err: unknown): {
  rawCode: string | null;
  status: number | null;
  message: string;
} {
  if (typeof err === "object" && err !== null) {
    const record = err as {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      message?: unknown;
      name?: unknown;
    };
    const message = typeof record.message === "string" ? record.message : "";
    const status =
      typeof record.status === "number"
        ? record.status
        : typeof record.statusCode === "number"
          ? record.statusCode
          : null;

    if (typeof record.code === "string" && record.code.trim()) {
      return { rawCode: record.code.trim().toUpperCase(), status, message };
    }
    const cfMatch = message.match(DEFINITE_CF_REFUSAL_RE);
    if (cfMatch?.[1]) {
      return { rawCode: cfMatch[1].toUpperCase(), status, message };
    }
    if (typeof record.name === "string" && record.name !== "Error") {
      return { rawCode: sanitizeErrorCode(record.name), status, message };
    }
    return { rawCode: null, status, message };
  }
  const message = typeof err === "string" ? err : "";
  const cfMatch = message.match(DEFINITE_CF_REFUSAL_RE);
  return { rawCode: cfMatch?.[1]?.toUpperCase() ?? null, status: null, message };
}

function classifyCloudflareSendError(err: unknown): EmailSendResult {
  const { rawCode, status, message } = extractErrorCodeAndStatus(err);
  const lowerMessage = message.toLowerCase();

  // 1. Suppressed recipient (permanent, non-retryable, triggers suppression list + owner notice)
  if (
    rawCode === "E_RECIPIENT_SUPPRESSED" ||
    lowerMessage.includes("e_recipient_suppressed") ||
    lowerMessage.includes("recipient suppressed") ||
    lowerMessage.includes("recipient_suppressed")
  ) {
    return {
      outcome: "failed",
      provider: "cloudflare",
      errorCode: "E_RECIPIENT_SUPPRESSED",
      retryable: false,
      suppressed: true,
    };
  }

  // 2. Sender restriction error (permanent, non-retryable)
  if (rawCode === "E_SENDER_NOT_VERIFIED" || lowerMessage.includes("e_sender_not_verified")) {
    return {
      outcome: "failed",
      provider: "cloudflare",
      errorCode: "E_SENDER_NOT_VERIFIED",
      retryable: false,
      suppressed: false,
    };
  }

  // 3. Definite rate limit / transient pre-accept rejection (bounded retryable)
  if (
    status === 429 ||
    (rawCode !== null && RETRYABLE_REFUSAL_CODES.has(rawCode)) ||
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("too many requests")
  ) {
    return {
      outcome: "failed",
      provider: "cloudflare",
      errorCode: rawCode && RETRYABLE_REFUSAL_CODES.has(rawCode) ? rawCode : "E_RATE_LIMITED",
      retryable: true,
      suppressed: false,
      retryAfterSeconds: extractRetryAfterSeconds(err),
    };
  }

  // 4. Ambiguous network / timeout / abort errors -> `unknown` (NEVER replay one-shot!)
  if (
    (rawCode !== null && AMBIGUOUS_ERROR_CODES.has(rawCode)) ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("timed out") ||
    lowerMessage.includes("network") ||
    lowerMessage.includes("aborted") ||
    lowerMessage.includes("connection reset") ||
    (status !== null && status >= 500)
  ) {
    return {
      outcome: "unknown",
      provider: "cloudflare",
      errorCode: sanitizeErrorCode(rawCode ?? "E_PROVIDER_TIMEOUT"),
    };
  }

  // 5. Malformed arguments (`TypeError`) or explicit Cloudflare `E_*` permanent refusal
  if (err instanceof TypeError) {
    return {
      outcome: "failed",
      provider: "cloudflare",
      errorCode: "E_INVALID_MESSAGE",
      retryable: false,
      suppressed: false,
    };
  }

  if (rawCode && rawCode.startsWith("E_")) {
    return {
      outcome: "failed",
      provider: "cloudflare",
      errorCode: sanitizeErrorCode(rawCode),
      retryable: false,
      suppressed: false,
    };
  }

  if (status !== null && status >= 400 && status < 500) {
    return {
      outcome: "failed",
      provider: "cloudflare",
      errorCode: sanitizeErrorCode(rawCode ?? `E_HTTP_${status}`),
      retryable: false,
      suppressed: false,
    };
  }

  // Default for unrecognized runtime throws: treat as ambiguous `unknown` so one-shot mail is never blindly replayed
  return {
    outcome: "unknown",
    provider: "cloudflare",
    errorCode: sanitizeErrorCode(rawCode ?? "E_PROVIDER_UNKNOWN"),
  };
}

/**
 * Primary transactional email adapter backed by Cloudflare Email Service (`env.EMAIL.send()`).
 * Enforces `noreply@notif.punyasitus.com` sender guard and Base64-encodes all attachments.
 */
export function createCloudflareEmailAdapter(binding: CloudflareSendEmailBinding): EmailPort {
  return {
    provider: "cloudflare",
    async send(request: EmailSendRequest): Promise<EmailSendResult> {
      let sender: string;
      let recipient: string;
      let normalizedAttachments: NormalizedEmailAttachment[];
      try {
        sender = assertAllowedSender(request.from);
        recipient = assertValidRecipient(request.to);
        normalizedAttachments = (request.attachments ?? []).map(normalizeEmailAttachment);
      } catch (err) {
        if (err instanceof EmailSenderNotVerifiedError) {
          return {
            outcome: "failed",
            provider: "cloudflare",
            errorCode: err.code,
            retryable: false,
            suppressed: false,
          };
        }
        if (err instanceof EmailValidationError) {
          return {
            outcome: "failed",
            provider: "cloudflare",
            errorCode: err.code,
            retryable: false,
            suppressed: false,
          };
        }
        return {
          outcome: "failed",
          provider: "cloudflare",
          errorCode: sanitizeErrorCode(err),
          retryable: false,
          suppressed: false,
        };
      }

      const headers = sanitizeHeaders(request.headers);
      const cfPayload: CloudflareSendEmailPayload = {
        from: request.fromName
          ? { name: sanitizeHeaderValue(request.fromName), email: sender }
          : sender,
        to: recipient,
        subject: sanitizeHeaderValue(request.subject),
        text: request.text,
        html: request.html,
        ...(request.replyTo ? { replyTo: assertValidRecipient(request.replyTo) } : {}),
        ...(headers ? { headers } : {}),
        ...(normalizedAttachments.length > 0
          ? {
              attachments: normalizedAttachments.map((att) =>
                att.disposition === "inline" && att.contentId
                  ? {
                      disposition: "inline" as const,
                      contentId: att.contentId,
                      filename: att.filename,
                      type: att.contentType,
                      content: att.content,
                    }
                  : {
                      disposition: "attachment" as const,
                      filename: att.filename,
                      type: att.contentType,
                      content: att.content,
                    },
              ),
            }
          : {}),
      };

      try {
        const res = await binding.send(cfPayload);
        const messageId =
          res && typeof res === "object" && typeof res.messageId === "string"
            ? res.messageId
            : null;
        return {
          outcome: "submitted",
          provider: "cloudflare",
          providerMessageId: messageId,
        };
      } catch (err) {
        return classifyCloudflareSendError(err);
      }
    },
  };
}

export interface ResendFallbackAdapterOptions {
  readonly apiKey: string;
  readonly fetchFn?: typeof fetch;
  readonly endpointUrl?: string;
}

const DEFAULT_RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Optional HTTP fallback adapter targeting Resend (`https://api.resend.com/emails`, DEC-038).
 * Enforces the same `noreply@notif.punyasitus.com` sender guard and Base64 attachment encoding.
 */
export function createResendFallbackAdapter(options: ResendFallbackAdapterOptions): EmailPort {
  const apiKey = options.apiKey.trim();
  const fetchFn = options.fetchFn ?? fetch;
  const endpointUrl = options.endpointUrl ?? DEFAULT_RESEND_ENDPOINT;

  return {
    provider: "resend",
    async send(request: EmailSendRequest): Promise<EmailSendResult> {
      if (!apiKey) {
        return {
          outcome: "failed",
          provider: "resend",
          errorCode: "E_PROVIDER_NOT_CONFIGURED",
          retryable: false,
          suppressed: false,
        };
      }

      let sender: string;
      let recipient: string;
      let normalizedAttachments: NormalizedEmailAttachment[];
      try {
        sender = assertAllowedSender(request.from);
        recipient = assertValidRecipient(request.to);
        normalizedAttachments = (request.attachments ?? []).map(normalizeEmailAttachment);
      } catch (err) {
        if (err instanceof EmailSenderNotVerifiedError) {
          return {
            outcome: "failed",
            provider: "resend",
            errorCode: err.code,
            retryable: false,
            suppressed: false,
          };
        }
        if (err instanceof EmailValidationError) {
          return {
            outcome: "failed",
            provider: "resend",
            errorCode: err.code,
            retryable: false,
            suppressed: false,
          };
        }
        return {
          outcome: "failed",
          provider: "resend",
          errorCode: sanitizeErrorCode(err),
          retryable: false,
          suppressed: false,
        };
      }

      const headers = sanitizeHeaders(request.headers);
      const fromField = request.fromName
        ? `${sanitizeHeaderValue(request.fromName)} <${sender}>`
        : sender;

      const body: Record<string, unknown> = {
        from: fromField,
        to: [recipient],
        subject: sanitizeHeaderValue(request.subject),
        html: request.html,
        text: request.text,
      };
      if (request.replyTo) {
        body.reply_to = assertValidRecipient(request.replyTo);
      }
      if (headers) {
        body.headers = headers;
      }
      if (normalizedAttachments.length > 0) {
        body.attachments = normalizedAttachments.map((att) => ({
          filename: att.filename,
          content: att.content,
          content_type: att.contentType,
        }));
      }

      let response: Response;
      try {
        response = await fetchFn(endpointUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": sanitizeHeaderValue(request.messageKey),
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        return {
          outcome: "unknown",
          provider: "resend",
          errorCode: sanitizeErrorCode(err),
        };
      }

      if (response.ok) {
        let providerMessageId: string | null = null;
        try {
          const parsed = (await response.json()) as { id?: unknown };
          if (typeof parsed.id === "string") {
            providerMessageId = parsed.id;
          }
        } catch {
          // Response was 2xx even if body wasn't JSON
        }
        return {
          outcome: "submitted",
          provider: "resend",
          providerMessageId,
        };
      }

      const retryAfterRaw = response.headers.get("retry-after");
      const retryAfterNum = retryAfterRaw ? Number(retryAfterRaw) : Number.NaN;
      const retryAfterSeconds =
        Number.isFinite(retryAfterNum) && retryAfterNum > 0 ? Math.round(retryAfterNum) : undefined;

      if (response.status === 429) {
        return {
          outcome: "failed",
          provider: "resend",
          errorCode: "E_RATE_LIMITED",
          retryable: true,
          suppressed: false,
          retryAfterSeconds,
        };
      }

      if (response.status >= 500) {
        return {
          outcome: "unknown",
          provider: "resend",
          errorCode: `E_RESEND_HTTP_${response.status}`,
        };
      }

      // 4xx definite refusal
      let responseText = "";
      try {
        responseText = await response.text();
      } catch {
        // ignore body read failures
      }
      if (/suppressed|bounced|complained/i.test(responseText)) {
        return {
          outcome: "failed",
          provider: "resend",
          errorCode: "E_RECIPIENT_SUPPRESSED",
          retryable: false,
          suppressed: true,
        };
      }

      return {
        outcome: "failed",
        provider: "resend",
        errorCode: `E_RESEND_HTTP_${response.status}`,
        retryable: false,
        suppressed: false,
      };
    },
  };
}

export interface CapturedEmail {
  readonly id: string;
  readonly messageKey: string;
  readonly template: EmailTemplateName;
  readonly from: string;
  readonly fromName?: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly replyTo?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments: readonly NormalizedEmailAttachment[];
  readonly tenantId: string | null;
  readonly capturedAt: number;
}

export interface LocalMailSink extends EmailPort {
  readonly provider: "local-sink";
  list(): readonly CapturedEmail[];
  findByTemplate(template: EmailTemplateName): readonly CapturedEmail[];
  findByRecipient(email: string): readonly CapturedEmail[];
  findByMessageKey(messageKey: string): CapturedEmail | undefined;
  latest(): CapturedEmail | undefined;
  clear(): void;
}

export interface LocalMailSinkOptions {
  readonly now?: () => number;
  readonly onCapture?: (captured: CapturedEmail) => Promise<void> | void;
}

/**
 * In-memory transactional mail sink for local development and CI tests
 * (used by TASK-025 auth verification/reset and TASK-026 invitation tests).
 */
export function createLocalMailSink(options?: LocalMailSinkOptions): LocalMailSink {
  const captured: CapturedEmail[] = [];
  const now = options?.now ?? (() => Date.now());
  let seq = 0;

  return {
    provider: "local-sink",
    async send(request: EmailSendRequest): Promise<EmailSendResult> {
      let sender: string;
      let recipient: string;
      let normalizedAttachments: NormalizedEmailAttachment[];
      try {
        sender = assertAllowedSender(request.from);
        recipient = assertValidRecipient(request.to);
        normalizedAttachments = (request.attachments ?? []).map(normalizeEmailAttachment);
      } catch (err) {
        if (err instanceof EmailSenderNotVerifiedError) {
          return {
            outcome: "failed",
            provider: "local-sink",
            errorCode: err.code,
            retryable: false,
            suppressed: false,
          };
        }
        if (err instanceof EmailValidationError) {
          return {
            outcome: "failed",
            provider: "local-sink",
            errorCode: err.code,
            retryable: false,
            suppressed: false,
          };
        }
        return {
          outcome: "failed",
          provider: "local-sink",
          errorCode: sanitizeErrorCode(err),
          retryable: false,
          suppressed: false,
        };
      }

      seq += 1;
      const id = `local-mail-${seq}`;
      const record: CapturedEmail = {
        id,
        messageKey: request.messageKey,
        template: request.template,
        from: sender,
        ...(request.fromName ? { fromName: sanitizeHeaderValue(request.fromName) } : {}),
        to: recipient,
        subject: sanitizeHeaderValue(request.subject),
        html: request.html,
        text: request.text,
        ...(request.replyTo ? { replyTo: assertValidRecipient(request.replyTo) } : {}),
        ...(request.headers ? { headers: sanitizeHeaders(request.headers) } : {}),
        attachments: normalizedAttachments,
        tenantId: request.tenantId ?? null,
        capturedAt: now(),
      };
      captured.push(record);
      if (options?.onCapture) {
        await options.onCapture(record);
      }
      return {
        outcome: "submitted",
        provider: "local-sink",
        providerMessageId: id,
      };
    },
    list(): readonly CapturedEmail[] {
      return [...captured];
    },
    findByTemplate(template: EmailTemplateName): readonly CapturedEmail[] {
      return captured.filter((item) => item.template === template);
    },
    findByRecipient(email: string): readonly CapturedEmail[] {
      const normalized = email.trim().toLowerCase();
      return captured.filter((item) => item.to === normalized);
    },
    findByMessageKey(messageKey: string): CapturedEmail | undefined {
      return captured.find((item) => item.messageKey === messageKey);
    },
    latest(): CapturedEmail | undefined {
      return captured.length > 0 ? captured[captured.length - 1] : undefined;
    },
    clear(): void {
      captured.length = 0;
    },
  };
}

export interface ResolveEmailPortConfig {
  readonly preferredProvider?: EmailProviderName;
  readonly cloudflareBinding?: CloudflareSendEmailBinding | null;
  readonly resendApiKey?: string | null;
  readonly resendFetchFn?: typeof fetch;
  readonly localSink?: LocalMailSink | null;
}

/**
 * Selects the active `EmailPort`: explicit preferred provider, otherwise
 * Cloudflare Email Service primary -> Resend HTTP fallback -> local sink -> null.
 */
export function resolveEmailPort(config: ResolveEmailPortConfig): EmailPort | null {
  if (config.preferredProvider === "local-sink") {
    return config.localSink ?? createLocalMailSink();
  }
  if (config.preferredProvider === "resend" && config.resendApiKey?.trim()) {
    return createResendFallbackAdapter({
      apiKey: config.resendApiKey,
      fetchFn: config.resendFetchFn,
    });
  }
  if (config.preferredProvider === "cloudflare" && config.cloudflareBinding) {
    return createCloudflareEmailAdapter(config.cloudflareBinding);
  }

  if (config.cloudflareBinding) {
    return createCloudflareEmailAdapter(config.cloudflareBinding);
  }
  if (config.resendApiKey?.trim()) {
    return createResendFallbackAdapter({
      apiKey: config.resendApiKey,
      fetchFn: config.resendFetchFn,
    });
  }
  if (config.localSink) {
    return config.localSink;
  }
  return null;
}

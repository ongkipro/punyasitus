import {
  EmailSenderNotVerifiedError,
  EmailTemplateError,
  EmailValidationError,
  assertAllowedSender,
  assertValidRecipient,
  createCloudflareEmailAdapter,
  createResendFallbackAdapter,
  normalizeEmailAttachment,
  renderEmailTemplate,
  type EmailAttachmentInput,
  type EmailPort,
  type EmailTemplateDataMap,
  type EmailTemplateName,
  type NormalizedEmailAttachment,
} from "@punyasitus/core/email/index";
import { NonRetryableJobError, sanitizeErrorCode } from "@punyasitus/core/jobs/index";
import {
  addEmailSuppression,
  claimEmailDelivery,
  getEmailSuppression,
  getSuppressionNoticeForOwner,
  recordEmailOutcome,
  type OwnerSuppressionNotice,
} from "@punyasitus/db/email/index";
import type { DurableJobHandler, DurableQueueEnv, JobExecutionContext } from "../consumer.ts";
import {
  EMAIL_DELIVERY_TOPIC,
  isValidEmailTemplateName,
  type EmailQueueJobPayload,
} from "../dispatch/email.ts";

export { EMAIL_DELIVERY_TOPIC };

export class RetryableEmailDeliveryError extends Error {
  readonly code: string;
  readonly retryable = true as const;
  readonly retryAfterSeconds?: number;

  constructor(code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "RetryableEmailDeliveryError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface EmailSuppressionNoticeEvent {
  readonly notice: OwnerSuppressionNotice;
  readonly tenantId: string | null;
  readonly messageKey: string;
  readonly template: EmailTemplateName;
}

export interface CreateEmailQueueHandlerOptions {
  /** Fixed `EmailPort` (e.g. `createLocalMailSink()` or mocked adapter in tests). */
  readonly emailPort?: EmailPort | null;
  /** Optional dynamic resolver from Worker `env` (defaults to `env.EMAIL` Cloudflare adapter). */
  readonly resolvePort?: (env: DurableQueueEnv) => EmailPort | null;
  readonly suppressionSalt?: string;
  readonly maxAttempts?: number;
  readonly leaseDurationMs?: number;
  readonly now?: () => number;
  readonly onOwnerSuppressionNotice?: (
    event: EmailSuppressionNoticeEvent,
  ) => Promise<void> | void;
}

function parseAttachments(raw: unknown): readonly NormalizedEmailAttachment[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new NonRetryableJobError("Attachments must be an array", "E_INVALID_EMAIL_JOB_PAYLOAD");
  }
  return raw.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new NonRetryableJobError("Attachment entry must be an object", "E_INVALID_ATTACHMENT");
    }
    const rec = item as Record<string, unknown>;
    const input: EmailAttachmentInput = {
      filename: typeof rec.filename === "string" ? rec.filename : "",
      contentType: typeof rec.contentType === "string" ? rec.contentType : "",
      content:
        typeof rec.content === "string" || rec.content instanceof Uint8Array ? rec.content : "",
      ...(rec.disposition === "inline" || rec.disposition === "attachment"
        ? { disposition: rec.disposition }
        : {}),
      ...(typeof rec.contentId === "string" ? { contentId: rec.contentId } : {}),
    };
    return normalizeEmailAttachment(input);
  });
}

function parseEmailJobPayload(ctx: JobExecutionContext): EmailQueueJobPayload {
  const raw = ctx.payload;
  const rawMessageKey =
    typeof raw.messageKey === "string" && raw.messageKey.trim()
      ? raw.messageKey.trim()
      : ctx.idempotencyKey;

  if (!isValidEmailTemplateName(raw.template)) {
    throw new NonRetryableJobError("Invalid email template", "E_INVALID_EMAIL_JOB_PAYLOAD");
  }
  if (typeof raw.to !== "string") {
    throw new NonRetryableJobError("Missing email recipient", "E_INVALID_EMAIL_JOB_PAYLOAD");
  }
  if (typeof raw.templateData !== "object" || raw.templateData === null || Array.isArray(raw.templateData)) {
    throw new NonRetryableJobError("Missing templateData object", "E_INVALID_EMAIL_JOB_PAYLOAD");
  }

  let sender: ReturnType<typeof assertAllowedSender>;
  let recipient: string;
  let replyTo: string | undefined;
  let ownerEmail: string | undefined;
  let attachments: readonly NormalizedEmailAttachment[] | undefined;

  try {
    sender = assertAllowedSender(typeof raw.from === "string" ? raw.from : undefined);
    recipient = assertValidRecipient(raw.to);
    replyTo = typeof raw.replyTo === "string" ? assertValidRecipient(raw.replyTo) : undefined;
    ownerEmail =
      typeof raw.ownerEmail === "string" ? assertValidRecipient(raw.ownerEmail) : undefined;
    attachments = parseAttachments(raw.attachments);
  } catch (err) {
    if (err instanceof EmailSenderNotVerifiedError || err instanceof EmailValidationError) {
      throw new NonRetryableJobError(err.message, err.code);
    }
    throw err;
  }

  return {
    messageKey: rawMessageKey,
    template: raw.template,
    to: recipient,
    from: sender,
    ...(typeof raw.fromName === "string" && raw.fromName.trim()
      ? { fromName: raw.fromName.trim() }
      : {}),
    ...(replyTo ? { replyTo } : {}),
    templateData: raw.templateData as Record<string, unknown>,
    ...(attachments ? { attachments } : {}),
    oneShot: typeof raw.oneShot === "boolean" ? raw.oneShot : true,
    ...(ownerEmail ? { ownerEmail } : {}),
  };
}

function resolveTransport(
  env: DurableQueueEnv,
  options?: CreateEmailQueueHandlerOptions,
): EmailPort | null {
  if (options?.emailPort !== undefined) {
    return options.emailPort;
  }
  if (options?.resolvePort) {
    return options.resolvePort(env);
  }
  const envBag = env as unknown as Record<string, unknown>;
  const providerPref =
    typeof envBag.EMAIL_PROVIDER === "string" ? envBag.EMAIL_PROVIDER.trim().toLowerCase() : "";
  const resendApiKey =
    typeof envBag.RESEND_API_KEY === "string" && envBag.RESEND_API_KEY.trim()
      ? envBag.RESEND_API_KEY.trim()
      : "";

  if (providerPref === "resend" && resendApiKey) {
    return createResendFallbackAdapter({ apiKey: resendApiKey });
  }
  if (env.EMAIL) {
    return createCloudflareEmailAdapter(env.EMAIL);
  }
  if (resendApiKey) {
    return createResendFallbackAdapter({ apiKey: resendApiKey });
  }
  return null;
}

function resolveSuppressionSalt(
  env: DurableQueueEnv,
  options?: CreateEmailQueueHandlerOptions,
): string | undefined {
  if (options?.suppressionSalt !== undefined) {
    return options.suppressionSalt;
  }
  const raw = (env as unknown as Record<string, unknown>).EMAIL_SUPPRESSION_SALT;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/**
 * Creates a `DurableJobHandler` for transactional emails (`email.transactional.send`):
 *
 * 1. Checks `PLATFORM_DB.email_suppressions` BEFORE claiming or sending -> records `skipped`
 *    and emits an owner suppression notice when suppressed.
 * 2. Takes an atomic one-shot claim in `PLATFORM_DB.email_delivery_claims` BEFORE calling
 *    `EmailPort.send()` so duplicates and ambiguous `unknown` outcomes are NEVER replayed.
 * 3. Handles `E_RECIPIENT_SUPPRESSED` by adding the email hash to `email_suppressions`,
 *    marking `skipped` (non-retryable), and emitting the visible owner notice.
 * 4. Retries definite transient refusals (e.g. `E_RATE_LIMITED`) with bounded backoff.
 * 5. Never replays one-shot messages after an ambiguous `unknown` provider outcome.
 */
export function createEmailQueueHandler(
  options?: CreateEmailQueueHandlerOptions,
): DurableJobHandler {
  const now = options?.now ?? (() => Date.now());

  return {
    maxAttempts: options?.maxAttempts ?? 3,
    leaseDurationMs: options?.leaseDurationMs,
    async execute(ctx: JobExecutionContext): Promise<void> {
      const payload = parseEmailJobPayload(ctx);
      const db = ctx.env.PLATFORM_DB;
      const nowMs = now();
      const suppressionSalt = resolveSuppressionSalt(ctx.env, options);

      // 1. Check recipient suppression BEFORE claiming or calling provider
      const existingSuppression = await getEmailSuppression(db, payload.to, {
        salt: suppressionSalt,
      });
      if (existingSuppression) {
        await recordEmailOutcome(db, {
          messageKey: payload.messageKey,
          template: payload.template,
          oneShot: payload.oneShot,
          status: "skipped",
          provider: null,
          errorCode: "E_RECIPIENT_SUPPRESSED",
          nowMs,
        });

        if (options?.onOwnerSuppressionNotice) {
          const notice = await getSuppressionNoticeForOwner(db, payload.to, {
            salt: suppressionSalt,
          });
          if (notice) {
            await options.onOwnerSuppressionNotice({
              notice,
              tenantId: ctx.tenantId,
              messageKey: payload.messageKey,
              template: payload.template,
            });
          }
        }
        return;
      }

      // 2. Resolve email transport; if none is bound, record `skipped` without claiming (PLAN §17.4)
      const port = resolveTransport(ctx.env, options);
      if (!port) {
        await recordEmailOutcome(db, {
          messageKey: payload.messageKey,
          template: payload.template,
          oneShot: payload.oneShot,
          status: "skipped",
          provider: null,
          errorCode: "NO_EMAIL_TRANSPORT",
          nowMs,
        });
        return;
      }

      // 3. Take atomic one-shot claim BEFORE invoking EmailPort.send()
      const claim = await claimEmailDelivery(db, {
        messageKey: payload.messageKey,
        template: payload.template,
        oneShot: payload.oneShot,
        allowRetryOnDefiniteFailure: ctx.attempt > 1,
        nowMs,
      });

      if (claim.outcome === "duplicate") {
        // Duplicate delivery or terminal `unknown`/`submitted` one-shot claim -> never replay!
        return;
      }

      // 4. Render Bahasa Indonesia template with strict escaping
      let rendered: ReturnType<typeof renderEmailTemplate>;
      try {
        rendered = renderEmailTemplate(
          payload.template,
          payload.templateData as EmailTemplateDataMap[typeof payload.template],
        );
      } catch (err) {
        const errorCode =
          err instanceof EmailTemplateError ? err.code : sanitizeErrorCode(err);
        await recordEmailOutcome(db, {
          messageKey: payload.messageKey,
          status: "failed",
          provider: port.provider,
          errorCode,
          nowMs: now(),
        });
        throw new NonRetryableJobError("Failed to render email template", errorCode);
      }

      // 5. Invoke EmailPort.send()
      const sendResult = await port.send({
        messageKey: payload.messageKey,
        template: payload.template,
        from: payload.from,
        fromName: payload.fromName,
        to: payload.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        replyTo: payload.replyTo,
        attachments: payload.attachments,
        oneShot: payload.oneShot,
        tenantId: ctx.tenantId,
      });

      const finishedAt = now();

      if (sendResult.outcome === "submitted") {
        await recordEmailOutcome(db, {
          messageKey: payload.messageKey,
          status: "submitted",
          provider: sendResult.provider,
          errorCode: null,
          nowMs: finishedAt,
        });
        return;
      }

      if (sendResult.outcome === "unknown") {
        // PLAN §17.4: ambiguous outcome (timeout/network error) is terminal for one-shot messages
        // and MUST NEVER be replayed. Record `unknown` and acknowledge without retrying.
        await recordEmailOutcome(db, {
          messageKey: payload.messageKey,
          status: "unknown",
          provider: sendResult.provider,
          errorCode: sendResult.errorCode,
          nowMs: finishedAt,
        });
        return;
      }

      // sendResult.outcome === "failed"
      if (sendResult.suppressed) {
        await addEmailSuppression(db, {
          email: payload.to,
          reason: "hard_bounce",
          source: `provider:${sendResult.provider}`,
          salt: suppressionSalt,
          nowMs: finishedAt,
        });
        await recordEmailOutcome(db, {
          messageKey: payload.messageKey,
          status: "skipped",
          provider: sendResult.provider,
          errorCode: "E_RECIPIENT_SUPPRESSED",
          nowMs: finishedAt,
        });
        if (options?.onOwnerSuppressionNotice) {
          const notice = await getSuppressionNoticeForOwner(db, payload.to, {
            salt: suppressionSalt,
          });
          if (notice) {
            await options.onOwnerSuppressionNotice({
              notice,
              tenantId: ctx.tenantId,
              messageKey: payload.messageKey,
              template: payload.template,
            });
          }
        }
        return;
      }

      await recordEmailOutcome(db, {
        messageKey: payload.messageKey,
        status: "failed",
        provider: sendResult.provider,
        errorCode: sendResult.errorCode,
        nowMs: finishedAt,
      });

      if (sendResult.retryable) {
        throw new RetryableEmailDeliveryError(
          sendResult.errorCode,
          `Retryable email provider refusal: ${sendResult.errorCode}`,
          sendResult.retryAfterSeconds,
        );
      }

      throw new NonRetryableJobError(
        `Permanent email provider refusal: ${sendResult.errorCode}`,
        sendResult.errorCode,
      );
    },
  };
}

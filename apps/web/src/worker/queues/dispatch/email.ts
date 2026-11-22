import {
  ALLOWED_EMAIL_SENDER,
  EMAIL_TEMPLATE_NAMES,
  assertAllowedSender,
  assertValidRecipient,
  normalizeEmailAttachment,
  type EmailAttachmentInput,
  type EmailTemplateDataMap,
  type EmailTemplateName,
  type NormalizedEmailAttachment,
} from "@punyasitus/core/email/index";
import type { JobEnvelopeInput } from "@punyasitus/core/jobs/index";
import {
  enqueueDurableJob,
  releaseUnstartedQueuedJob,
} from "@punyasitus/db/jobs/index";
import type { DurableQueueEnv } from "../consumer.ts";

export const EMAIL_DELIVERY_TOPIC = "email.transactional.send" as const;

export interface EmailQueueJobPayload {
  readonly messageKey: string;
  readonly template: EmailTemplateName;
  readonly to: string;
  readonly from: typeof ALLOWED_EMAIL_SENDER;
  readonly fromName?: string;
  readonly replyTo?: string;
  readonly templateData: Record<string, unknown>;
  readonly attachments?: readonly NormalizedEmailAttachment[];
  readonly oneShot: boolean;
  readonly ownerEmail?: string;
}

export interface EnqueueTransactionalEmailInput<T extends EmailTemplateName = EmailTemplateName> {
  readonly messageKey: string;
  readonly template: T;
  readonly to: string;
  readonly from?: string;
  readonly fromName?: string;
  readonly replyTo?: string;
  readonly templateData: EmailTemplateDataMap[T];
  readonly attachments?: readonly EmailAttachmentInput[];
  readonly oneShot?: boolean;
  readonly tenantId?: string | null;
  readonly ownerEmail?: string;
  readonly correlationId?: string | null;
  readonly maxAttempts?: number;
  readonly nowMs?: number;
}

export interface EnqueueTransactionalEmailResult {
  readonly enqueued: boolean;
  readonly messageKey: string;
  readonly topic: typeof EMAIL_DELIVERY_TOPIC;
}

export type EmailDispatchEnv = Pick<DurableQueueEnv, "PLATFORM_DB"> & {
  readonly JOBS_QUEUE?: {
    send(message: unknown): Promise<unknown>;
  };
};

const TEMPLATE_NAME_SET = new Set<string>(EMAIL_TEMPLATE_NAMES);

export function isValidEmailTemplateName(value: unknown): value is EmailTemplateName {
  return typeof value === "string" && TEMPLATE_NAME_SET.has(value);
}

/**
 * Enqueues a transactional email job into `PLATFORM_DB.job_ledger` and `JOBS_QUEUE`,
 * deduplicating strictly by `messageKey`.
 *
 * - Enforces `noreply@notif.punyasitus.com` sender guard before enqueueing.
 * - Normalizes binary PDF attachments to Base64 strings for safe Queue JSON serialization.
 */
export async function enqueueTransactionalEmail<T extends EmailTemplateName>(
  env: EmailDispatchEnv,
  input: EnqueueTransactionalEmailInput<T>,
): Promise<EnqueueTransactionalEmailResult> {
  const messageKey = input.messageKey.trim();
  if (!messageKey || messageKey.length > 256 || /[\r\n\0]/.test(messageKey)) {
    throw new RangeError("INVALID_MESSAGE_KEY: messageKey must be a clean non-empty string");
  }
  if (!isValidEmailTemplateName(input.template)) {
    throw new RangeError(`INVALID_EMAIL_TEMPLATE: unknown template "${String(input.template)}"`);
  }

  const sender = assertAllowedSender(input.from);
  const recipient = assertValidRecipient(input.to);
  const replyTo = input.replyTo ? assertValidRecipient(input.replyTo) : undefined;
  const ownerEmail = input.ownerEmail ? assertValidRecipient(input.ownerEmail) : undefined;
  const normalizedAttachments =
    input.attachments && input.attachments.length > 0
      ? input.attachments.map(normalizeEmailAttachment)
      : undefined;

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const payload: EmailQueueJobPayload = {
    messageKey,
    template: input.template,
    to: recipient,
    from: sender,
    ...(input.fromName ? { fromName: input.fromName } : {}),
    ...(replyTo ? { replyTo } : {}),
    templateData: input.templateData as unknown as Record<string, unknown>,
    ...(normalizedAttachments ? { attachments: normalizedAttachments } : {}),
    oneShot: input.oneShot ?? true,
    ...(ownerEmail ? { ownerEmail } : {}),
  };

  const ledgerResult = await enqueueDurableJob(env.PLATFORM_DB, {
    idempotencyKey: messageKey,
    topic: EMAIL_DELIVERY_TOPIC,
    tenantId: input.tenantId ?? null,
    payload: payload as unknown as Record<string, unknown>,
    nowMs,
  });

  if (!ledgerResult.enqueued) {
    return {
      enqueued: false,
      messageKey,
      topic: EMAIL_DELIVERY_TOPIC,
    };
  }

  if (env.JOBS_QUEUE) {
    const envelope: JobEnvelopeInput = {
      idempotencyKey: messageKey,
      topic: EMAIL_DELIVERY_TOPIC,
      tenantId: input.tenantId ?? null,
      payload: payload as unknown as Record<string, unknown>,
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      correlationId: input.correlationId ?? null,
      enqueuedAt: nowMs,
    };
    try {
      await env.JOBS_QUEUE.send(envelope);
    } catch (err) {
      await releaseUnstartedQueuedJob(env.PLATFORM_DB, messageKey);
      throw err;
    }
  }

  return {
    enqueued: true,
    messageKey,
    topic: EMAIL_DELIVERY_TOPIC,
  };
}

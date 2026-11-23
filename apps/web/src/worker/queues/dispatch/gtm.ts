import {
  ALLOWED_EMAIL_SENDER,
  renderEmailTemplate,
  type EmailPort,
} from "@punyasitus/core/email/index";
import type { GtmKillSwitchReasonCategory } from "@punyasitus/core/analytics/gtm";
import { enqueueTransactionalEmail, type EmailDispatchEnv } from "./email.ts";

/**
 * Dispatches deduplicated owner notification email when a platform operator activates
 * the GTM kill switch on a tenant (`REQ-027`, `PLAN §18.1`, `TASK-076`).
 *
 * Non-blocking invariant: email delivery errors are caught and returned as metadata
 * so the audited kill-switch state transition is never rolled back by mail outage.
 */

export interface DispatchGtmKillSwitchOwnerNoticeResult {
  readonly attempted: boolean;
  readonly enqueued: boolean;
  readonly directSent: boolean;
  readonly messageKey: string | null;
}

export async function dispatchGtmKillSwitchOwnerNotice(
  env: EmailDispatchEnv & { readonly PLATFORM_DOMAIN?: string },
  params: {
    readonly tenantId: string;
    readonly tenantName: string;
    readonly tenantHandle: string;
    readonly ownerEmail: string | null;
    readonly ownerName?: string | null;
    readonly containerId?: string | null;
    readonly reasonCategory: GtmKillSwitchReasonCategory;
    readonly reason: string;
    readonly auditId?: string | null;
    readonly idempotencyKey: string;
    readonly appBaseUrl?: string;
    readonly emailPort?: EmailPort | null;
    readonly nowMs?: number;
  },
): Promise<DispatchGtmKillSwitchOwnerNoticeResult> {
  const recipient = params.ownerEmail?.trim().toLowerCase() ?? "";
  if (!recipient || !recipient.includes("@")) {
    return {
      attempted: false,
      enqueued: false,
      directSent: false,
      messageKey: null,
    };
  }

  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const platformDomain = env.PLATFORM_DOMAIN?.trim() || "punyasitus.com";
  const baseUrl = params.appBaseUrl?.trim() || `https://app.${platformDomain}`;
  const analyticsSettingsUrl = `${baseUrl.replace(/\/$/, "")}/dashboard/${encodeURIComponent(params.tenantHandle)}/settings/analytics`;
  const messageKey = `gtm-kill-switch:${params.tenantId}:${params.idempotencyKey}`;

  const templateData = {
    ...(params.ownerName ? { recipientName: params.ownerName } : {}),
    tenantName: params.tenantName,
    tenantHandle: params.tenantHandle,
    ...(params.containerId ? { containerId: params.containerId } : {}),
    reasonCategory: params.reasonCategory,
    reason: params.reason,
    analyticsSettingsUrl,
  };

  let enqueued = false;
  let directSent = false;

  try {
    const queued = await enqueueTransactionalEmail(env, {
      messageKey,
      template: "gtm-kill-switch-owner-notice",
      to: recipient,
      templateData,
      oneShot: true,
      tenantId: params.tenantId,
      correlationId: params.auditId ?? params.idempotencyKey,
      nowMs,
    });
    enqueued = queued.enqueued;

    // When running in local/test mode without a live Queue worker binding, deliver directly via EmailPort
    if (enqueued && !env.JOBS_QUEUE && params.emailPort) {
      const rendered = renderEmailTemplate("gtm-kill-switch-owner-notice", templateData);
      const sendRes = await params.emailPort.send({
        from: ALLOWED_EMAIL_SENDER,
        to: recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        template: "gtm-kill-switch-owner-notice",
        messageKey,
      });
      directSent = sendRes.outcome === "submitted";
    }
  } catch {
    // Non-blocking: mail delivery errors must never block the kill-switch action
  }

  return {
    attempted: true,
    enqueued,
    directSent,
    messageKey,
  };
}

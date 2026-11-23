import type { CustomThemeRequestRecord } from "@punyasitus/core/custom-themes/index";
import { getPlatformSettings, listPlatformOperators } from "@punyasitus/db/platform";
import { enqueueTransactionalEmail, type EmailDispatchEnv } from "./email.ts";

/**
 * Dispatches deduplicated transactional email notifications to active platform operators
 * (and configured `supportEmail` fallback) when a new custom theme request is created
 * (REQ-063, REQ-077, PLAN §11.4, TASK-061).
 *
 * Non-blocking invariant: email failures are caught and reported without rolling back
 * or breaking the tenant's persisted custom theme request.
 */

export interface DispatchCustomThemeOperatorNoticeResult {
  readonly recipientsAttempted: number;
  readonly enqueuedCount: number;
}

export async function dispatchCustomThemeRequestOperatorNotices(
  env: EmailDispatchEnv & { readonly PLATFORM_DOMAIN?: string },
  params: {
    readonly request: CustomThemeRequestRecord;
    readonly correlationId?: string | null;
    readonly nowMs?: number;
  },
): Promise<DispatchCustomThemeOperatorNoticeResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const platformDomain = env.PLATFORM_DOMAIN?.trim() || "punyasitus.com";
  const consoleUrl = `https://console.${platformDomain}/console/custom-themes?request=${encodeURIComponent(params.request.requestCode)}`;

  const recipients = new Map<string, string | undefined>();

  try {
    const operators = await listPlatformOperators(env.PLATFORM_DB, { includeRevoked: false });
    for (const op of operators) {
      if (op.isActive && op.email && op.email.includes("@")) {
        recipients.set(op.email.trim().toLowerCase(), op.name ?? undefined);
      }
    }
  } catch {
    // fallback to supportEmail below
  }

  try {
    const settings = await getPlatformSettings(env.PLATFORM_DB);
    if (settings.supportEmail && settings.supportEmail.includes("@")) {
      const normalized = settings.supportEmail.trim().toLowerCase();
      if (!recipients.has(normalized)) {
        recipients.set(normalized, "Tim Operasional PunyaSitus");
      }
    }
  } catch {
    // non-fatal
  }

  let enqueuedCount = 0;
  for (const [email, recipientName] of recipients.entries()) {
    try {
      const res = await enqueueTransactionalEmail(env, {
        messageKey: `custom-theme-request:${params.request.id}:${email}`,
        template: "custom-theme-request-operator-notice",
        to: email,
        templateData: {
          ...(recipientName ? { recipientName } : {}),
          requestCode: params.request.requestCode,
          tenantHandle: params.request.tenantHandle,
          brandName: params.request.brandName,
          packageName: params.request.packageName,
          contactPreference: params.request.contactPreference,
          consoleUrl,
        },
        oneShot: true,
        tenantId: params.request.tenantId,
        correlationId: params.correlationId ?? params.request.id,
        nowMs,
      });
      if (res.enqueued) {
        enqueuedCount += 1;
      }
    } catch {
      // Email failure must never block or fail request creation (REQ-077)
    }
  }

  return {
    recipientsAttempted: recipients.size,
    enqueuedCount,
  };
}

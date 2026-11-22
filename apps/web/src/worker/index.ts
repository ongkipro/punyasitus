import { handle } from "@astrojs/cloudflare/handler";
import { isDcvPassThroughPath } from "@punyasitus/core";
import { redactJobLogRecord } from "@punyasitus/core/jobs/index";
import {
  DAILY_PLATFORM_BACKUP_TOPIC,
  createDailyBackupQueueHandler,
} from "../../../../scripts/backup-restore/index.ts";
import { dispatchScheduledCron } from "./cron/index.ts";
import type { JobQueuePayload, PunyasitusEnv } from "./env.d.ts";
import { EMAIL_DELIVERY_TOPIC, createEmailQueueHandler } from "./queues/email/handler.ts";
import { processDurableQueueBatch, type DurableJobRegistry } from "./queues/index.ts";
import {
  createMediaJobRegistry,
  sweepAllTenantsExpiredQuarantine,
} from "./queues/media/index.ts";
import { createRetentionJobRegistry } from "./queues/retention/index.ts";

// Durable Object class export (only handlers + DO classes may be exported by a Worker entrypoint)
export { TenantStore } from "./tenant-store.ts";

type AstroRequest = Parameters<typeof handle>[0];
type AstroEnv = Parameters<typeof handle>[1];
type AstroCtx = Parameters<typeof handle>[2];

const WORKER_JOB_REGISTRY: DurableJobRegistry = {
  ...createRetentionJobRegistry(),
  ...createMediaJobRegistry(),
  [EMAIL_DELIVERY_TOPIC]: createEmailQueueHandler({
    onOwnerSuppressionNotice(event) {
      console.warn(
        JSON.stringify(
          redactJobLogRecord({
            event: "email.owner_suppression_notice",
            tenantId: event.tenantId,
            messageKey: event.messageKey,
            template: event.template,
            reason: event.notice.reason,
            emailHash: event.notice.emailHash,
            suppressedAt: event.notice.suppressedAt,
          }),
        ),
      );
    },
  }),
  [DAILY_PLATFORM_BACKUP_TOPIC]: createDailyBackupQueueHandler(),
};

export default {
  async fetch(
    request: Request,
    env: PunyasitusEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    // Step 0 (PLAN §3.3, ADR-0009): pass HTTP DCV paths through untouched before host/tenant checks.
    if (isDcvPassThroughPath(url.pathname)) {
      return fetch(request);
    }
    return handle(
      request as unknown as AstroRequest,
      env as unknown as AstroEnv,
      ctx as unknown as AstroCtx,
    );
  },

  async queue(batch: MessageBatch<JobQueuePayload>, env: PunyasitusEnv): Promise<void> {
    await processDurableQueueBatch(batch, env, WORKER_JOB_REGISTRY);
  },

  async scheduled(controller: ScheduledController, env: PunyasitusEnv): Promise<void> {
    await dispatchScheduledCron(controller, env);
    await sweepAllTenantsExpiredQuarantine(env, { nowMs: controller.scheduledTime });
  },
};

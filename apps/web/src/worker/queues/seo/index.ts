import {
  SEO_INDEXNOW_CRON_JOB_DEFINITION,
  type ScheduledCronJobDefinition,
} from "../../cron/scheduler.ts";
import type { DurableJobHandler, DurableJobRegistry } from "../consumer.ts";
import {
  createSeoIndexNowCronFlushHandler,
  createSeoIndexNowPingHandler,
  enqueueIndexNowPublishPing,
  ensureTenantIndexNowKey,
  readTenantSeoPluginConfig,
  runSeoIndexNowCronFlush,
  SEO_AUTOPILOT_PLUGIN_ID,
  SEO_INDEXNOW_FLUSH_TOPIC,
  SEO_INDEXNOW_PING_TOPIC,
  type CreateSeoIndexNowHandlerOptions,
  type EnqueueIndexNowPublishPingInput,
  type EnqueueIndexNowPublishPingResult,
  type IndexNowEnqueueEnv,
  type IndexNowPublishSource,
  type SeoIndexNowCronFlushResult,
  type SeoIndexNowPingJobPayload,
  type TenantSeoPluginConfig,
} from "./indexnow.ts";

export {
  createSeoIndexNowCronFlushHandler,
  createSeoIndexNowPingHandler,
  enqueueIndexNowPublishPing,
  ensureTenantIndexNowKey,
  readTenantSeoPluginConfig,
  runSeoIndexNowCronFlush,
  SEO_AUTOPILOT_PLUGIN_ID,
  SEO_INDEXNOW_CRON_JOB_DEFINITION,
  SEO_INDEXNOW_FLUSH_TOPIC,
  SEO_INDEXNOW_PING_TOPIC,
  type CreateSeoIndexNowHandlerOptions,
  type EnqueueIndexNowPublishPingInput,
  type EnqueueIndexNowPublishPingResult,
  type IndexNowEnqueueEnv,
  type IndexNowPublishSource,
  type SeoIndexNowCronFlushResult,
  type SeoIndexNowPingJobPayload,
  type TenantSeoPluginConfig,
};

export const SEO_CRON_JOB_DEFINITIONS: readonly ScheduledCronJobDefinition[] = [
  SEO_INDEXNOW_CRON_JOB_DEFINITION,
];

export function createSeoJobRegistry(
  options: CreateSeoIndexNowHandlerOptions = {},
): DurableJobRegistry {
  return {
    [SEO_INDEXNOW_PING_TOPIC]: createSeoIndexNowPingHandler(options) as DurableJobHandler,
    [SEO_INDEXNOW_FLUSH_TOPIC]: createSeoIndexNowCronFlushHandler(options) as DurableJobHandler,
  };
}

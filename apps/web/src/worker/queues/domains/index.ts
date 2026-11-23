import { DEFAULT_MAX_JOB_ATTEMPTS } from "@punyasitus/core/jobs/index";
import {
  DEFAULT_CRON_EXPRESSION,
  type ScheduledCronJobDefinition,
} from "../../cron/scheduler.ts";
import type { DurableJobHandler, DurableJobRegistry } from "../consumer.ts";
import {
  DOMAIN_STALE_REAPER_TOPIC,
  createDomainReaperQueueHandler,
  runStaleHostnameReaper,
  type CreateDomainReaperQueueHandlerOptions,
  type DomainReaperJobPayload,
  type ReapedHostnameOutcome,
  type RunStaleHostnameReaperOptions,
  type StaleHostnameReaperResult,
} from "./reaper.ts";
import {
  DEFAULT_RENEWAL_ALERT_COOLDOWN_MS,
  DOMAIN_RENEWAL_WATCH_TOPIC,
  createDomainRenewalWatchQueueHandler,
  runDomainRenewalWatch,
  type CreateDomainRenewalWatchQueueHandlerOptions,
  type DomainRenewalWatchJobPayload,
  type DomainRenewalWatchResult,
  type RenewalWatchDomainOutcome,
  type RenewalWatchIssueCode,
  type RunDomainRenewalWatchOptions,
} from "./renewal-watch.ts";

export {
  DEFAULT_RENEWAL_ALERT_COOLDOWN_MS,
  DOMAIN_RENEWAL_WATCH_TOPIC,
  DOMAIN_STALE_REAPER_TOPIC,
  createDomainReaperQueueHandler,
  createDomainRenewalWatchQueueHandler,
  runDomainRenewalWatch,
  runStaleHostnameReaper,
  type CreateDomainReaperQueueHandlerOptions,
  type CreateDomainRenewalWatchQueueHandlerOptions,
  type DomainReaperJobPayload,
  type DomainRenewalWatchJobPayload,
  type DomainRenewalWatchResult,
  type ReapedHostnameOutcome,
  type RenewalWatchDomainOutcome,
  type RenewalWatchIssueCode,
  type RunDomainRenewalWatchOptions,
  type RunStaleHostnameReaperOptions,
  type StaleHostnameReaperResult,
};

export const DOMAIN_CRON_JOB_DEFINITIONS: readonly ScheduledCronJobDefinition[] = [
  {
    name: "daily-domain-stale-reaper",
    cron: DEFAULT_CRON_EXPRESSION,
    topic: DOMAIN_STALE_REAPER_TOPIC,
    cadence: "daily",
    tenantId: null,
    maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
  },
  {
    name: "hourly-domain-renewal-watch",
    cron: DEFAULT_CRON_EXPRESSION,
    topic: DOMAIN_RENEWAL_WATCH_TOPIC,
    cadence: "hourly",
    tenantId: null,
    maxAttempts: 3,
  },
];

export interface CreateDomainJobRegistryOptions {
  readonly reaper?: CreateDomainReaperQueueHandlerOptions;
  readonly renewalWatch?: CreateDomainRenewalWatchQueueHandlerOptions;
}

export function createDomainJobRegistry(
  options: CreateDomainJobRegistryOptions = {},
): DurableJobRegistry {
  return {
    [DOMAIN_STALE_REAPER_TOPIC]: createDomainReaperQueueHandler(
      options.reaper,
    ) as DurableJobHandler,
    [DOMAIN_RENEWAL_WATCH_TOPIC]: createDomainRenewalWatchQueueHandler(
      options.renewalWatch,
    ) as DurableJobHandler,
  };
}

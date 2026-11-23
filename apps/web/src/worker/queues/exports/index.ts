import {
  TENANT_EXPORT_CLEANUP_TOPIC,
  TENANT_SELF_DELETION_SWEEP_TOPIC,
} from "@punyasitus/core/exports/index";
import { DEFAULT_MAX_JOB_ATTEMPTS } from "@punyasitus/core/jobs/index";
import {
  DEFAULT_CRON_EXPRESSION,
  type ScheduledCronJobDefinition,
} from "../../cron/scheduler.ts";

export * from "./dispatch.ts";
export * from "./handler.ts";

export const EXPORT_CRON_JOB_DEFINITIONS: readonly ScheduledCronJobDefinition[] = [
  {
    name: "daily-expired-exports-cleanup",
    cron: DEFAULT_CRON_EXPRESSION,
    topic: TENANT_EXPORT_CLEANUP_TOPIC,
    cadence: "daily",
    tenantId: null,
    maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
    buildPayload: (scheduledTimeMs) => ({ scheduledAtMs: scheduledTimeMs }),
  },
  {
    name: "daily-self-service-deletion-sweep",
    cron: DEFAULT_CRON_EXPRESSION,
    topic: TENANT_SELF_DELETION_SWEEP_TOPIC,
    cadence: "daily",
    tenantId: null,
    maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
    buildPayload: (scheduledTimeMs) => ({ scheduledAtMs: scheduledTimeMs }),
  },
];

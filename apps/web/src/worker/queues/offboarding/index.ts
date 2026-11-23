import { DEFAULT_MAX_JOB_ATTEMPTS } from "@punyasitus/core/jobs/index";
import {
  DEFAULT_CRON_EXPRESSION,
  type ScheduledCronJobDefinition,
} from "../../cron/scheduler.ts";
import { TENANT_OFFBOARDING_SWEEP_TOPIC } from "../dispatch/offboarding.ts";

export * from "./handler.ts";

export const OFFBOARDING_CRON_JOB_DEFINITIONS: readonly ScheduledCronJobDefinition[] = [
  {
    name: "daily-tenant-offboarding-sweep",
    cron: DEFAULT_CRON_EXPRESSION,
    topic: TENANT_OFFBOARDING_SWEEP_TOPIC,
    cadence: "daily",
    tenantId: null,
    maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
    buildPayload: (scheduledTimeMs) => ({ scheduledAtMs: scheduledTimeMs }),
  },
];

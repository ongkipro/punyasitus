import { z } from "zod";

export const JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "dead_letter",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const DEFAULT_MAX_JOB_ATTEMPTS = 3;
export const MAX_JOB_ATTEMPTS_LIMIT = 20;
export const DEFAULT_JOB_LEASE_MS = 60_000;
export const DEFAULT_BASE_BACKOFF_SECONDS = 5;
export const DEFAULT_MAX_BACKOFF_SECONDS = 300;
export const MAX_QUEUE_DELAY_SECONDS = 43_200; // Cloudflare Queues 12h max delay

const SAFE_KEY_PATTERN = /^[^\r\n\0]+$/;
const SAFE_TOPIC_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
const SAFE_CRON_JOB_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

export const JobEnvelopeSchema = z.strictObject({
  idempotencyKey: z
    .string()
    .trim()
    .min(1, "idempotencyKey must be non-empty")
    .max(256, "idempotencyKey exceeds 256 characters")
    .regex(SAFE_KEY_PATTERN, "idempotencyKey contains forbidden control characters"),
  topic: z
    .string()
    .trim()
    .min(1, "topic must be non-empty")
    .max(128, "topic exceeds 128 characters")
    .regex(SAFE_TOPIC_PATTERN, "topic contains invalid characters"),
  tenantId: z
    .string()
    .trim()
    .min(1, "tenantId must be non-empty when provided")
    .max(128, "tenantId exceeds 128 characters")
    .regex(SAFE_KEY_PATTERN, "tenantId contains forbidden control characters")
    .nullable(),
  payload: z.record(z.string(), z.unknown()).default({}),
  maxAttempts: z
    .number()
    .int("maxAttempts must be an integer")
    .min(1, "maxAttempts must be at least 1")
    .max(MAX_JOB_ATTEMPTS_LIMIT, `maxAttempts cannot exceed ${MAX_JOB_ATTEMPTS_LIMIT}`)
    .optional(),
  correlationId: z
    .string()
    .trim()
    .min(1, "correlationId must be non-empty when provided")
    .max(128, "correlationId exceeds 128 characters")
    .regex(SAFE_KEY_PATTERN, "correlationId contains forbidden control characters")
    .nullable()
    .default(null),
  enqueuedAt: z
    .number()
    .int("enqueuedAt must be an integer epoch ms")
    .nonnegative("enqueuedAt must be non-negative")
    .optional(),
});

export type JobEnvelopeInput = z.input<typeof JobEnvelopeSchema>;
export type ParsedJobEnvelope = z.output<typeof JobEnvelopeSchema>;

export interface JobEnvelope {
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly tenantId: string | null;
  readonly payload: Record<string, unknown>;
  readonly maxAttempts: number;
  readonly correlationId: string | null;
  readonly enqueuedAt: number;
}

/**
 * Validates and normalizes a raw job envelope with strict Zod v4 checks.
 */
export function parseJobEnvelope(
  raw: unknown,
  options?: { readonly defaultMaxAttempts?: number; readonly nowMs?: number },
): JobEnvelope {
  const parsed = JobEnvelopeSchema.parse(raw);
  const fallbackMaxAttempts = options?.defaultMaxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS;
  return {
    idempotencyKey: parsed.idempotencyKey,
    topic: parsed.topic,
    tenantId: parsed.tenantId,
    payload: parsed.payload,
    maxAttempts: parsed.maxAttempts ?? fallbackMaxAttempts,
    correlationId: parsed.correlationId,
    enqueuedAt: parsed.enqueuedAt ?? options?.nowMs ?? Date.now(),
  };
}

export type CronCadence = "hourly" | "daily" | "monthly";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Generates a deterministic UTC period idempotency key for Cron-scheduled jobs.
 *
 * Examples:
 * - hourly:  `cron:billing-sweep:2026-11-22T16`
 * - daily:   `cron:platform-backup:2026-11-22`
 * - monthly: `cron:monthly-report:2026-11`
 */
export function buildCronPeriodKey(
  jobName: string,
  scheduledTimeMs: number,
  cadence: CronCadence,
): string {
  const normalizedName = jobName.trim();
  if (!normalizedName || normalizedName.length > 96 || !SAFE_CRON_JOB_NAME_PATTERN.test(normalizedName)) {
    throw new RangeError("INVALID_CRON_JOB_NAME: jobName must match /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/");
  }
  if (!Number.isFinite(scheduledTimeMs) || scheduledTimeMs < 0) {
    throw new RangeError("INVALID_SCHEDULED_TIME: scheduledTimeMs must be a non-negative finite number");
  }

  const d = new Date(scheduledTimeMs);
  const year = String(d.getUTCFullYear()).padStart(4, "0");
  const month = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const hour = pad2(d.getUTCHours());

  let bucket: string;
  switch (cadence) {
    case "hourly":
      bucket = `${year}-${month}-${day}T${hour}`;
      break;
    case "daily":
      bucket = `${year}-${month}-${day}`;
      break;
    case "monthly":
      bucket = `${year}-${month}`;
      break;
  }

  return `cron:${normalizedName}:${bucket}`;
}

export interface RetryBackoffOptions {
  readonly baseSeconds?: number;
  readonly maxSeconds?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
}

/**
 * Computes bounded exponential retry backoff delay in integer seconds.
 * Formula: `min(maxSeconds, baseSeconds * 2^(attempt - 1))` with optional bounded jitter.
 */
export function computeRetryBackoffSeconds(
  attempt: number,
  options?: RetryBackoffOptions,
): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const baseSeconds = Math.max(
    1,
    Math.floor(options?.baseSeconds ?? DEFAULT_BASE_BACKOFF_SECONDS),
  );
  const maxSeconds = Math.min(
    MAX_QUEUE_DELAY_SECONDS,
    Math.max(baseSeconds, Math.floor(options?.maxSeconds ?? DEFAULT_MAX_BACKOFF_SECONDS)),
  );

  // Guard against exponent overflow for very high attempt numbers
  const exponent = Math.min(safeAttempt - 1, 20);
  const raw = Math.min(maxSeconds, baseSeconds * 2 ** exponent);

  const jitterRatio = options?.jitterRatio ?? 0;
  if (jitterRatio > 0) {
    const clampedRatio = Math.min(0.5, Math.max(0, jitterRatio));
    const rand = Math.min(1, Math.max(0, (options?.random ?? Math.random)()));
    const factor = 1 - clampedRatio + rand * clampedRatio * 2;
    return Math.min(maxSeconds, Math.max(1, Math.round(raw * factor)));
  }

  return Math.min(maxSeconds, Math.max(1, Math.round(raw)));
}

/**
 * Error indicating a permanent failure that must transition straight to `dead_letter`
 * without consuming additional retry attempts.
 */
export class NonRetryableJobError extends Error {
  readonly code: string;
  readonly retryable = false as const;

  constructor(message: string, code = "NON_RETRYABLE_JOB_ERROR") {
    super(message);
    this.name = "NonRetryableJobError";
    this.code = code;
  }
}

export interface UncertainProviderEffectErrorOptions {
  readonly code?: string;
  readonly provider?: string;
  readonly externalReference?: string;
  readonly retryAfterSeconds?: number;
  readonly reconcileImmediately?: boolean;
}

/**
 * Error indicating an external provider call returned an ambiguous/timed-out outcome.
 * The queue consumer will invoke `handler.reconcile(ctx)` before re-executing side effects.
 */
export class UncertainProviderEffectError extends Error {
  readonly code: string;
  readonly provider: string | undefined;
  readonly externalReference: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly reconcileImmediately: boolean;
  readonly retryable = true as const;

  constructor(message: string, options?: UncertainProviderEffectErrorOptions) {
    super(message);
    this.name = "UncertainProviderEffectError";
    this.code = options?.code ?? "UNCERTAIN_PROVIDER_EFFECT";
    this.provider = options?.provider;
    this.externalReference = options?.externalReference;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.reconcileImmediately = options?.reconcileImmediately ?? false;
  }
}

/**
 * Atomic SQLite rate limiter for anonymous public endpoints (PLAN §6, REQ-038).
 *
 * Operates against `rate_limit_buckets` in per-tenant `TenantStore` Durable Objects
 * (and any `PLATFORM_DB` D1 database carrying the same table schema).
 *
 * Security invariants:
 * - Single atomic SQLite `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` so parallel
 *   concurrent requests never exceed configured window caps.
 * - Raw visitor IPs are NEVER persisted; network keys are derived via HMAC-SHA256
 *   with a server-side secret salt over `CF-Connecting-IP`.
 * - Fail-closed on datastore outage (`503 SERVICE_UNAVAILABLE`); never falls back to allow.
 */

export const RATE_LIMIT_WINDOW_MS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

export interface RateLimitRuleSpec {
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
}

export interface LeadRateLimitPolicy {
  readonly perNetworkMinute: RateLimitRuleSpec;
  readonly perTenantHour: RateLimitRuleSpec;
}

export interface EventRateLimitPolicy {
  readonly perNetworkMinute: RateLimitRuleSpec;
  readonly perTenantDay: RateLimitRuleSpec;
}

export interface AbuseReportRateLimitPolicy {
  readonly perNetworkMinute: RateLimitRuleSpec;
  readonly perTenantHour: RateLimitRuleSpec;
}

/**
 * PLAN §6 default lead submission policy:
 * - 5 lead attempts/minute per tenant + privacy-preserving network bucket
 * - 100 lead attempts/hour per tenant
 */
export const DEFAULT_LEAD_RATE_LIMIT_POLICY: LeadRateLimitPolicy = {
  perNetworkMinute: {
    name: "lead_network_minute",
    limit: 5,
    windowMs: RATE_LIMIT_WINDOW_MS.minute,
  },
  perTenantHour: {
    name: "lead_tenant_hour",
    limit: 100,
    windowMs: RATE_LIMIT_WINDOW_MS.hour,
  },
};

/**
 * PLAN §6 default event ingestion policy:
 * - 60 events/minute per network bucket
 * - 10,000 events/day per tenant
 * Over-limit events are dropped cleanly with HTTP 204.
 */
export const DEFAULT_EVENT_RATE_LIMIT_POLICY: EventRateLimitPolicy = {
  perNetworkMinute: {
    name: "event_network_minute",
    limit: 60,
    windowMs: RATE_LIMIT_WINDOW_MS.minute,
  },
  perTenantDay: {
    name: "event_tenant_day",
    limit: 10_000,
    windowMs: RATE_LIMIT_WINDOW_MS.day,
  },
};

export const DEFAULT_ABUSE_REPORT_RATE_LIMIT_POLICY: AbuseReportRateLimitPolicy = {
  perNetworkMinute: {
    name: "abuse_network_minute",
    limit: 5,
    windowMs: RATE_LIMIT_WINDOW_MS.minute,
  },
  perTenantHour: {
    name: "abuse_tenant_hour",
    limit: 50,
    windowMs: RATE_LIMIT_WINDOW_MS.hour,
  },
};

export interface RateLimitDatastoreUnavailable {
  readonly ok: false;
  readonly kind: "datastore_unavailable";
  readonly status: 503;
  readonly code: "SERVICE_UNAVAILABLE";
  readonly message: string;
}

export interface RateLimitBucketOutcome {
  readonly ok: true;
  readonly allowed: boolean;
  readonly bucketKey: string;
  readonly count: number;
  readonly limit: number;
  readonly remaining: number;
  readonly windowStart: number;
  readonly resetAt: number;
  readonly retryAfterSeconds: number;
}

export type ConsumeRateLimitResult = RateLimitBucketOutcome | RateLimitDatastoreUnavailable;

export interface RateLimitPolicyAllowed {
  readonly ok: true;
  readonly allowed: true;
  readonly drop: false;
  readonly remaining: number;
  readonly resetAt: number;
  readonly buckets: readonly RateLimitBucketOutcome[];
}

export interface RateLimitPolicyRejected {
  readonly ok: true;
  readonly allowed: false;
  readonly drop: false;
  readonly status: 429;
  readonly code: "RATE_LIMITED";
  readonly retryAfterSeconds: number;
  readonly resetAt: number;
  readonly violatedRule: string;
  readonly message: string;
  readonly buckets: readonly RateLimitBucketOutcome[];
}

export interface RateLimitPolicyDropped {
  readonly ok: true;
  readonly allowed: false;
  readonly drop: true;
  readonly status: 204;
  readonly retryAfterSeconds: number;
  readonly resetAt: number;
  readonly violatedRule: string;
  readonly buckets: readonly RateLimitBucketOutcome[];
}

export type LeadRateLimitResult =
  | RateLimitPolicyAllowed
  | RateLimitPolicyRejected
  | RateLimitDatastoreUnavailable;

export type EventRateLimitResult =
  | RateLimitPolicyAllowed
  | RateLimitPolicyDropped
  | RateLimitDatastoreUnavailable;

export type GenericRateLimitResult =
  | RateLimitPolicyAllowed
  | RateLimitPolicyRejected
  | RateLimitPolicyDropped
  | RateLimitDatastoreUnavailable;

interface RateLimitSqlRow {
  readonly count: number;
  readonly window_start: number;
  readonly expires_at: number;
}

const DATASTORE_UNAVAILABLE_RESULT: RateLimitDatastoreUnavailable = {
  ok: false,
  kind: "datastore_unavailable",
  status: 503,
  code: "SERVICE_UNAVAILABLE",
  message: "Layanan sementara tidak tersedia. Silakan coba lagi beberapa saat lagi.",
};

const RATE_LIMITED_LEAD_MESSAGE =
  "Terlalu banyak percobaan pengiriman. Silakan tunggu sebentar sebelum mencoba lagi.";

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Extracts visitor IP strictly from Cloudflare's trusted `CF-Connecting-IP` header.
 * Never falls back to spoofable `X-Forwarded-For` headers (PLAN §6).
 */
export function extractClientIp(request: Pick<Request, "headers">): string | null {
  const raw = request.headers.get("cf-connecting-ip");
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Computes a privacy-preserving HMAC-SHA256 digest of a visitor IP using a secret salt.
 * Never embeds or echoes raw IP addresses in the output.
 */
export async function hashNetworkIdentifier(
  clientIp: string | null | undefined,
  salt: string,
): Promise<string> {
  const trimmedSalt = salt.trim();
  if (!trimmedSalt) {
    throw new RangeError("INVALID_RATE_LIMIT_SALT: rate limit salt must be non-empty");
  }
  const normalizedIp = (clientIp ?? "").trim().toLowerCase() || "anonymous";
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(trimmedSalt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(normalizedIp));
  return bytesToHex(new Uint8Array(signature));
}

export interface NetworkBucketKeyInput {
  readonly scope: string;
  readonly tenantId: string;
  readonly clientIp: string | null | undefined;
  readonly salt: string;
}

/**
 * Builds a deterministic, privacy-preserving bucket key for `(scope, tenantId, saltedIpHash)`.
 */
export async function buildNetworkBucketKey(input: NetworkBucketKeyInput): Promise<string> {
  const scope = input.scope.trim();
  const tenantId = input.tenantId.trim();
  if (!scope) {
    throw new RangeError("INVALID_RATE_LIMIT_SCOPE: scope must be non-empty");
  }
  if (!tenantId) {
    throw new RangeError("INVALID_TENANT_ID: tenantId must be non-empty");
  }
  const ipHash = await hashNetworkIdentifier(input.clientIp, input.salt);
  return `${scope}:t:${tenantId}:net:${ipHash}`;
}

export function buildTenantBucketKey(input: {
  readonly scope: string;
  readonly tenantId: string;
  readonly windowLabel: string;
}): string {
  const scope = input.scope.trim();
  const tenantId = input.tenantId.trim();
  const windowLabel = input.windowLabel.trim();
  if (!scope || !tenantId || !windowLabel) {
    throw new RangeError("INVALID_BUCKET_KEY_PARTS: scope, tenantId, and windowLabel are required");
  }
  return `${scope}:t:${tenantId}:${windowLabel}`;
}

export interface ConsumeRateLimitInput {
  readonly bucketKey: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly nowMs?: number;
}

/**
 * Atomically increments a rate-limit bucket in SQLite (`rate_limit_buckets`), resetting
 * the counter when `expires_at <= nowMs`.
 *
 * Uses a single SQLite UPSERT with `RETURNING` so concurrent requests cannot race or
 * exceed `limit`. Fails closed with `503` on any datastore outage.
 */
export async function consumeRateLimitBucket(
  db: D1Database | null | undefined,
  input: ConsumeRateLimitInput,
): Promise<ConsumeRateLimitResult> {
  const bucketKey = input.bucketKey.trim();
  if (!bucketKey || bucketKey.length > 256) {
    throw new RangeError("INVALID_BUCKET_KEY: bucketKey must be 1..256 characters");
  }
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new RangeError("INVALID_RATE_LIMIT: limit must be a positive integer");
  }
  if (!Number.isInteger(input.windowMs) || input.windowMs < 1_000) {
    throw new RangeError("INVALID_RATE_LIMIT_WINDOW: windowMs must be an integer >= 1000");
  }

  if (!db) {
    return DATASTORE_UNAVAILABLE_RESULT;
  }

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const nextExpiresAt = nowMs + input.windowMs;

  try {
    const row = await db
      .prepare(
        `INSERT INTO rate_limit_buckets (bucket_key, window_start, count, expires_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(bucket_key) DO UPDATE SET
           window_start = CASE
             WHEN rate_limit_buckets.expires_at <= excluded.window_start THEN excluded.window_start
             ELSE rate_limit_buckets.window_start
           END,
           count = CASE
             WHEN rate_limit_buckets.expires_at <= excluded.window_start THEN 1
             ELSE rate_limit_buckets.count + 1
           END,
           expires_at = CASE
             WHEN rate_limit_buckets.expires_at <= excluded.window_start THEN excluded.expires_at
             ELSE rate_limit_buckets.expires_at
           END
         RETURNING count, window_start, expires_at`,
      )
      .bind(bucketKey, nowMs, nextExpiresAt)
      .first<RateLimitSqlRow>();

    if (!row) {
      return DATASTORE_UNAVAILABLE_RESULT;
    }

    const count = Number(row.count);
    const windowStart = Number(row.window_start);
    const expiresAt = Number(row.expires_at);
    if (!Number.isFinite(count) || !Number.isFinite(windowStart) || !Number.isFinite(expiresAt)) {
      return DATASTORE_UNAVAILABLE_RESULT;
    }

    const allowed = count <= input.limit;
    const remaining = Math.max(0, input.limit - count);
    const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((expiresAt - nowMs) / 1000));

    return {
      ok: true,
      allowed,
      bucketKey,
      count,
      limit: input.limit,
      remaining,
      windowStart,
      resetAt: expiresAt,
      retryAfterSeconds,
    };
  } catch {
    return DATASTORE_UNAVAILABLE_RESULT;
  }
}

export interface RateLimitRuleCheck {
  readonly name: string;
  readonly bucketKey: string;
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * Evaluates ordered rate-limit rules sequentially so fine-grained per-IP limits short-circuit
 * before consuming shared tenant-wide budgets (preventing single-IP DoS of tenant quotas).
 */
export async function enforceRateLimitRules(
  db: D1Database | null | undefined,
  rules: readonly RateLimitRuleCheck[],
  options?: {
    readonly nowMs?: number;
    readonly mode?: "reject_429" | "drop_204";
    readonly rejectMessage?: string;
  },
): Promise<GenericRateLimitResult> {
  if (rules.length === 0) {
    throw new RangeError("INVALID_RATE_LIMIT_RULES: at least one rule is required");
  }
  const nowMs = Math.floor(options?.nowMs ?? Date.now());
  const mode = options?.mode ?? "reject_429";
  const outcomes: RateLimitBucketOutcome[] = [];

  for (const rule of rules) {
    const res = await consumeRateLimitBucket(db, {
      bucketKey: rule.bucketKey,
      limit: rule.limit,
      windowMs: rule.windowMs,
      nowMs,
    });
    if (!res.ok) {
      return res;
    }
    outcomes.push(res);
    if (!res.allowed) {
      if (mode === "drop_204") {
        return {
          ok: true,
          allowed: false,
          drop: true,
          status: 204,
          retryAfterSeconds: res.retryAfterSeconds,
          resetAt: res.resetAt,
          violatedRule: rule.name,
          buckets: outcomes,
        };
      }
      return {
        ok: true,
        allowed: false,
        drop: false,
        status: 429,
        code: "RATE_LIMITED",
        retryAfterSeconds: res.retryAfterSeconds,
        resetAt: res.resetAt,
        violatedRule: rule.name,
        message: options?.rejectMessage ?? RATE_LIMITED_LEAD_MESSAGE,
        buckets: outcomes,
      };
    }
  }

  let minRemaining = Number.POSITIVE_INFINITY;
  let earliestReset = Number.POSITIVE_INFINITY;
  for (const outcome of outcomes) {
    if (outcome.remaining < minRemaining) minRemaining = outcome.remaining;
    if (outcome.resetAt < earliestReset) earliestReset = outcome.resetAt;
  }

  return {
    ok: true,
    allowed: true,
    drop: false,
    remaining: Number.isFinite(minRemaining) ? minRemaining : 0,
    resetAt: Number.isFinite(earliestReset) ? earliestReset : nowMs,
    buckets: outcomes,
  };
}

export interface EnforceLeadRateLimitInput {
  readonly tenantId: string;
  readonly clientIp: string | null | undefined;
  readonly salt: string;
  readonly nowMs?: number;
  readonly policy?: LeadRateLimitPolicy;
}

/**
 * Enforces PLAN §6 lead submission rate limits (`5/min` per tenant+network AND `100/hr` per tenant).
 * Returns `429` + `Retry-After` on exhaustion and fails closed (`503`) on datastore outage.
 */
export async function enforceLeadRateLimit(
  db: D1Database | null | undefined,
  input: EnforceLeadRateLimitInput,
): Promise<LeadRateLimitResult> {
  const policy = input.policy ?? DEFAULT_LEAD_RATE_LIMIT_POLICY;
  const networkKey = await buildNetworkBucketKey({
    scope: "lead",
    tenantId: input.tenantId,
    clientIp: input.clientIp,
    salt: input.salt,
  });
  const tenantKey = buildTenantBucketKey({
    scope: "lead",
    tenantId: input.tenantId,
    windowLabel: "hour",
  });

  const result = await enforceRateLimitRules(
    db,
    [
      {
        name: policy.perNetworkMinute.name,
        bucketKey: networkKey,
        limit: policy.perNetworkMinute.limit,
        windowMs: policy.perNetworkMinute.windowMs,
      },
      {
        name: policy.perTenantHour.name,
        bucketKey: tenantKey,
        limit: policy.perTenantHour.limit,
        windowMs: policy.perTenantHour.windowMs,
      },
    ],
    {
      nowMs: input.nowMs,
      mode: "reject_429",
      rejectMessage: RATE_LIMITED_LEAD_MESSAGE,
    },
  );

  if (!result.ok) return result;
  if (result.allowed) return result;
  if (!result.drop) return result;
  return DATASTORE_UNAVAILABLE_RESULT;
}

export interface EnforceEventRateLimitInput {
  readonly tenantId: string;
  readonly clientIp: string | null | undefined;
  readonly salt: string;
  readonly nowMs?: number;
  readonly policy?: EventRateLimitPolicy;
}

/**
 * Enforces PLAN §6 event ingestion rate limits (`60/min` per network AND `10,000/day` per tenant).
 * Over-limit events signal `{ allowed: false, drop: true, status: 204 }`; datastore outage fails closed (`503`).
 */
export async function enforceEventRateLimit(
  db: D1Database | null | undefined,
  input: EnforceEventRateLimitInput,
): Promise<EventRateLimitResult> {
  const policy = input.policy ?? DEFAULT_EVENT_RATE_LIMIT_POLICY;
  const networkKey = await buildNetworkBucketKey({
    scope: "event",
    tenantId: input.tenantId,
    clientIp: input.clientIp,
    salt: input.salt,
  });
  const tenantKey = buildTenantBucketKey({
    scope: "event",
    tenantId: input.tenantId,
    windowLabel: "day",
  });

  const result = await enforceRateLimitRules(
    db,
    [
      {
        name: policy.perNetworkMinute.name,
        bucketKey: networkKey,
        limit: policy.perNetworkMinute.limit,
        windowMs: policy.perNetworkMinute.windowMs,
      },
      {
        name: policy.perTenantDay.name,
        bucketKey: tenantKey,
        limit: policy.perTenantDay.limit,
        windowMs: policy.perTenantDay.windowMs,
      },
    ],
    {
      nowMs: input.nowMs,
      mode: "drop_204",
    },
  );

  if (!result.ok) return result;
  if (result.allowed) return result;
  if (result.drop) return result;
  return DATASTORE_UNAVAILABLE_RESULT;
}

/**
 * Prunes expired buckets (`expires_at <= nowMs`) from `rate_limit_buckets`.
 */
export async function pruneExpiredRateLimitBuckets(
  db: D1Database | null | undefined,
  nowMs: number = Date.now(),
): Promise<{ readonly ok: true; readonly deleted: number } | RateLimitDatastoreUnavailable> {
  if (!db) {
    return DATASTORE_UNAVAILABLE_RESULT;
  }
  try {
    const res = await db
      .prepare("DELETE FROM rate_limit_buckets WHERE expires_at <= ?")
      .bind(Math.floor(nowMs))
      .run();
    return { ok: true, deleted: res.meta?.changes ?? 0 };
  } catch {
    return DATASTORE_UNAVAILABLE_RESULT;
  }
}

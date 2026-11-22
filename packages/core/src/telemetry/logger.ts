import {
  REDACTED_VALUE,
  isSensitiveFieldName,
  sanitizeErrorCode,
} from "../jobs/redact.ts";

export type TelemetryLevel = "info" | "warn" | "error";

export type TelemetryStatus = "ok" | "degraded" | "error" | number;

export type TelemetryMetricValue = number | boolean | string | null;

export interface StructuredTelemetryEvent {
  readonly timestamp: string;
  readonly level: TelemetryLevel;
  readonly requestId: string;
  readonly tenantId: string | null;
  readonly operation: string;
  readonly status: TelemetryStatus;
  readonly durationMs: number;
  readonly errorCode: string | null;
  readonly metrics?: Readonly<Record<string, TelemetryMetricValue>>;
}

export interface CreateStructuredEventInput {
  readonly requestId?: string | null;
  readonly tenantId?: string | null;
  readonly operation: string;
  readonly status: TelemetryStatus;
  readonly durationMs?: number | null;
  readonly errorCode?: unknown;
  readonly timestamp?: number | Date | string;
  readonly level?: TelemetryLevel;
  readonly metrics?: Readonly<Record<string, unknown>>;
  /**
   * Extra unknown/sensitive fields (e.g. body, headers, query, email, phone) are accepted
   * on the input type strictly so callers cannot accidentally bypass the allowlist;
   * they are ALWAYS stripped and never emitted.
   */
  readonly [extra: string]: unknown;
}

export type TelemetrySink = (event: StructuredTelemetryEvent) => void;

const SAFE_TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const SAFE_METRIC_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,47}$/;
const QUERY_FRAGMENT_RE = /[?#][^\s]*/g;
const CONTROL_CHARS_RE = /[\r\n\t\0]/g;

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const TELEMETRY_PROVIDER_KEY_RE =
  /\b(?:(?:sk_live|sk_test|pk_live|pk_test|rk_live|rk_test|whsec|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|xoxa|AIza|AKIA)[_-]?[A-Za-z0-9_-]{8,}|(?:re|cf)_[A-Za-z0-9_-]{8,})\b/g;
const KV_SECRET_RE =
  /\b(password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|cookie|set-cookie|client_secret)\s*([:=])\s*([^\s,;'"}\]]+)/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const ID_PHONE_RE = /(?<!\w)(?:\+?62|0)8[1-9](?:[\s.-]?\d){6,11}(?!\w)/g;
const INTL_PHONE_RE = /(?<!\w)\+[1-9]\d{0,2}(?:[\s.-]?\d){7,13}(?!\w)/g;
const FORMATTED_PHONE_RE =
  /(?<!\w)(?:\(\d{3}\)\s?\d{3}[\s.-]\d{4}|\d{3}[\s.-]\d{3}[\s.-]\d{4})(?!\w)/g;
const COOKIE_PAIR_RE = /\b(__Host-[A-Za-z0-9_.-]+|__Secure-[A-Za-z0-9_.-]+|connect\.sid)=([^\s;,]+)/gi;

const MAX_OPERATION_LENGTH = 128;
const MAX_METRIC_STRING_LENGTH = 96;

/**
 * Strips URL query strings (`?...`) and fragments (`#...`) from arbitrary strings
 * so query parameters (tokens, emails, UTM PII) never enter structured logs.
 */
export function stripQueryString(input: string): string {
  return input.replace(QUERY_FRAGMENT_RE, "");
}

function redactTelemetryText(input: string): string {
  return input
    .replace(JWT_RE, REDACTED_VALUE)
    .replace(AUTH_SCHEME_RE, (_m, scheme: string) => `${scheme} ${REDACTED_VALUE}`)
    .replace(TELEMETRY_PROVIDER_KEY_RE, REDACTED_VALUE)
    .replace(COOKIE_PAIR_RE, (_m, name: string) => `${name}=${REDACTED_VALUE}`)
    .replace(KV_SECRET_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED_VALUE}`)
    .replace(EMAIL_RE, REDACTED_VALUE)
    .replace(ID_PHONE_RE, REDACTED_VALUE)
    .replace(INTL_PHONE_RE, REDACTED_VALUE)
    .replace(FORMATTED_PHONE_RE, REDACTED_VALUE);
}

function sanitizeControlChars(input: string): string {
  return input.replace(CONTROL_CHARS_RE, " ").trim();
}

function sanitizeRequestId(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "unknown";
  const cleaned = sanitizeControlChars(stripQueryString(raw));
  if (!cleaned) return "unknown";
  if (redactTelemetryText(cleaned) !== cleaned || !SAFE_REQUEST_ID_RE.test(cleaned)) {
    return "redacted";
  }
  return cleaned;
}

function sanitizeTenantId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = sanitizeControlChars(stripQueryString(raw));
  if (!cleaned) return null;
  if (redactTelemetryText(cleaned) !== cleaned) return null;
  if (!SAFE_TENANT_ID_RE.test(cleaned)) return null;
  return cleaned;
}

function sanitizeOperation(raw: string): string {
  const cleaned = sanitizeControlChars(stripQueryString(String(raw ?? "")));
  if (!cleaned) return "unknown";
  const redacted = redactTelemetryText(cleaned);
  return redacted.slice(0, MAX_OPERATION_LENGTH);
}

function sanitizeStatus(raw: TelemetryStatus): TelemetryStatus {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return "error";
    const rounded = Math.trunc(raw);
    if (rounded >= 100 && rounded <= 599) return rounded;
    return "error";
  }
  if (raw === "ok" || raw === "degraded" || raw === "error") {
    return raw;
  }
  return "error";
}

function sanitizeDurationMs(raw: number | null | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.round(raw));
}

function resolveTimestampIso(raw: number | Date | string | undefined): string {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? new Date().toISOString() : raw.toISOString();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw).toISOString();
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function deriveLevel(
  explicit: TelemetryLevel | undefined,
  status: TelemetryStatus,
  errorCode: string | null,
): TelemetryLevel {
  if (explicit === "info" || explicit === "warn" || explicit === "error") {
    return explicit;
  }
  if (errorCode !== null || status === "error" || (typeof status === "number" && status >= 500)) {
    return "error";
  }
  if (status === "degraded" || (typeof status === "number" && status >= 400)) {
    return "warn";
  }
  return "info";
}

function isDisallowedMetricKey(key: string): boolean {
  if (!SAFE_METRIC_KEY_RE.test(key)) return true;
  if (isSensitiveFieldName(key)) return true;
  return /^(?:url|uri|href|search|query|header|headers|body|raw|user|name|address|ip|ip_address|ipAddress|userAgent|user_agent|message|details|stack|env|config|bucket|binding)$/i.test(
    key,
  );
}

function sanitizeMetrics(
  raw: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, TelemetryMetricValue>> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const safe: Record<string, TelemetryMetricValue> = {};
  let count = 0;

  for (const [key, value] of Object.entries(raw)) {
    if (isDisallowedMetricKey(key)) {
      continue;
    }
    if (value === null) {
      safe[key] = null;
      count += 1;
      continue;
    }
    if (typeof value === "boolean") {
      safe[key] = value;
      count += 1;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      safe[key] = value;
      count += 1;
      continue;
    }
    if (typeof value === "string") {
      const stripped = sanitizeControlChars(stripQueryString(value));
      const redacted = redactTelemetryText(stripped);
      safe[key] =
        redacted === REDACTED_VALUE
          ? REDACTED_VALUE
          : redacted.slice(0, MAX_METRIC_STRING_LENGTH);
      count += 1;
    }
    // Nested objects, arrays, Errors, Headers, Request/Response bodies are intentionally dropped.
  }

  return count > 0 ? safe : undefined;
}

/**
 * Builds a strictly allowlisted structured telemetry event per PLAN §9:
 * emits only `timestamp`, `level`, `requestId`, `tenantId` (when safe), `operation`,
 * `status`, `durationMs`, `errorCode`, and optional scalar `metrics`.
 *
 * All request/response bodies, `Authorization`/`Cookie` headers, query strings,
 * emails, phone numbers, tokens, and arbitrary extra fields are stripped or redacted.
 */
export function createStructuredEvent(
  input: CreateStructuredEventInput,
): StructuredTelemetryEvent {
  const status = sanitizeStatus(input.status);
  const errorCode =
    input.errorCode === undefined || input.errorCode === null
      ? null
      : sanitizeErrorCode(input.errorCode);
  const level = deriveLevel(input.level, status, errorCode);
  const metrics = sanitizeMetrics(input.metrics);

  const event: StructuredTelemetryEvent = {
    timestamp: resolveTimestampIso(input.timestamp),
    level,
    requestId: sanitizeRequestId(input.requestId),
    tenantId: sanitizeTenantId(input.tenantId),
    operation: sanitizeOperation(input.operation),
    status,
    durationMs: sanitizeDurationMs(input.durationMs),
    errorCode,
    ...(metrics ? { metrics } : {}),
  };

  return event;
}

export function defaultTelemetrySink(event: StructuredTelemetryEvent): void {
  const serialized = JSON.stringify(event);
  if (event.level === "error") {
    console.error(serialized);
  } else if (event.level === "warn") {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}

/**
 * Constructs a strictly redacted structured telemetry event and emits it to `sink`.
 */
export function emitTelemetryEvent(
  input: CreateStructuredEventInput,
  sink: TelemetrySink = defaultTelemetrySink,
): StructuredTelemetryEvent {
  const event = createStructuredEvent(input);
  sink(event);
  return event;
}

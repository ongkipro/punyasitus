export const REDACTED_VALUE = "[REDACTED]" as const;

const MAX_ERROR_CODE_LENGTH = 64;
const MAX_REDACTION_DEPTH = 6;

const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /pass(?:word|wd|phrase)?/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /auth(?:orization)?/i,
  /cookie/i,
  /session/i,
  /credential/i,
  /private[_-]?key/i,
  /signature/i,
  /totp|otp|backup[_-]?code/i,
  /e[-_]?mail/i,
  /phone|mobile|tel(?:ephone)?|whatsapp|wa[_-]?num/i,
  /payload|raw[_-]?body|request[_-]?body|response[_-]?body|^body$|headers|query[_-]?string|form[_-]?data/i,
  /card|cvv|iban|account[_-]?number|nik|ktp|npwp/i,
];

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const PROVIDER_KEY_RE =
  /\b(?:sk_live|sk_test|pk_live|pk_test|rk_live|rk_test|whsec|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|xoxa|re|cf|AIza|AKIA)[_-]?[A-Za-z0-9_-]{8,}\b/g;
const KV_SECRET_RE =
  /\b(password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|cookie|set-cookie|client_secret)\s*([:=])\s*([^\s,;'"}\]]+)/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const ID_PHONE_RE = /(?<!\w)(?:\+?62|0)8[1-9](?:[\s.-]?\d){6,11}(?!\w)/g;
const INTL_PHONE_RE = /(?<!\w)\+[1-9]\d{0,2}(?:[\s.-]?\d){7,13}(?!\w)/g;
const FORMATTED_PHONE_RE =
  /(?<!\w)(?:\(\d{3}\)\s?\d{3}[\s.-]\d{4}|\d{3}[\s.-]\d{3}[\s.-]\d{4})(?!\w)/g;
const COOKIE_PAIR_RE = /\b(__Host-[A-Za-z0-9_.-]+|__Secure-[A-Za-z0-9_.-]+|connect\.sid)=([^\s;,]+)/gi;

const SAFE_ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/;
const LONG_SECRET_LIKE_TOKEN_RE = /^(?:[a-f0-9]{24,}|[A-Za-z0-9_-]{32,})$/;

export function isSensitiveFieldName(key: string): boolean {
  const normalized = key.trim();
  if (!normalized) return false;
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(normalized));
}

/**
 * Strips credentials, tokens, Authorization headers, cookies, emails, and phone numbers
 * from arbitrary text so no secret or PII can be emitted into logs or error summaries.
 */
export function redactSensitiveString(input: string): string {
  return input
    .replace(JWT_RE, REDACTED_VALUE)
    .replace(AUTH_SCHEME_RE, (_m, scheme: string) => `${scheme} ${REDACTED_VALUE}`)
    .replace(PROVIDER_KEY_RE, REDACTED_VALUE)
    .replace(COOKIE_PAIR_RE, (_m, name: string) => `${name}=${REDACTED_VALUE}`)
    .replace(KV_SECRET_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED_VALUE}`)
    .replace(EMAIL_RE, REDACTED_VALUE)
    .replace(ID_PHONE_RE, REDACTED_VALUE)
    .replace(INTL_PHONE_RE, REDACTED_VALUE)
    .replace(FORMATTED_PHONE_RE, REDACTED_VALUE);
}

function normalizeCandidateErrorCode(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Reject anything that changes under redaction (means it contained a token, email, phone, etc.)
  if (redactSensitiveString(trimmed) !== trimmed) {
    return null;
  }

  // Reject long opaque hex/base64-like blobs that resemble raw tokens or secrets
  if (LONG_SECRET_LIKE_TOKEN_RE.test(trimmed) && !/[._-]/.test(trimmed)) {
    return null;
  }

  if (!SAFE_ERROR_CODE_RE.test(trimmed)) {
    return null;
  }

  // Convert camelCase error class names (e.g. UncertainProviderEffectError) to UPPER_SNAKE_CASE
  const snake = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .toUpperCase();

  return snake.slice(0, MAX_ERROR_CODE_LENGTH);
}

/**
 * Produces a bounded, non-sensitive machine-readable error code for `job_ledger.last_error_code`
 * and structured logs. Never copies raw `Error.message` or sensitive payloads.
 */
export function sanitizeErrorCode(input: unknown): string {
  if (input === null || input === undefined) {
    return "UNKNOWN_ERROR";
  }

  if (typeof input === "string") {
    return normalizeCandidateErrorCode(input) ?? "JOB_EXECUTION_ERROR";
  }

  if (typeof input === "object") {
    const record = input as { code?: unknown; name?: unknown };
    if (typeof record.code === "string") {
      const fromCode = normalizeCandidateErrorCode(record.code);
      if (fromCode) return fromCode;
    }
    if (typeof record.name === "string" && record.name !== "Error") {
      const fromName = normalizeCandidateErrorCode(record.name);
      if (fromName) return fromName;
    }
    return "JOB_EXECUTION_ERROR";
  }

  return "JOB_EXECUTION_ERROR";
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return redactSensitiveString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      errorCode: sanitizeErrorCode(value),
    };
  }
  if (depth >= MAX_REDACTION_DEPTH) {
    return REDACTED_VALUE;
  }
  if (typeof value !== "object") {
    return REDACTED_VALUE;
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveFieldName(k)) {
      out[k] = REDACTED_VALUE;
    } else {
      out[k] = redactValue(v, depth + 1, seen);
    }
  }
  return out;
}

/**
 * Recursively redacts a structured job log record, stripping raw payloads, secrets,
 * Authorization headers, cookies, passwords, tokens, emails, and phone numbers.
 */
export function redactJobLogRecord<T extends Record<string, unknown>>(
  record: T,
): Record<string, unknown> {
  const seen = new WeakSet<object>();
  seen.add(record);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (isSensitiveFieldName(key)) {
      out[key] = REDACTED_VALUE;
      continue;
    }
    out[key] = redactValue(value, 1, seen);
  }

  return out;
}

import {
  REDACTED_VALUE,
  isSensitiveFieldName,
  sanitizeErrorCode,
} from "@punyasitus/core/jobs/redact";

/**
 * Append-only `PLATFORM_DB.platform_audit` writer, query helper, and redaction guards
 * (PLAN §13; REQ-051, REQ-039).
 *
 * Core invariants:
 * - Every privileged platform state change persists its `platform_audit` row inside the
 *   SAME atomic `D1Database.batch([...])` transaction as the state change; if audit
 *   persistence fails, the state mutation rolls back.
 * - `reason` for privileged mutations MUST be 10-500 characters (trimmed) and is scrubbed
 *   so secrets, tokens, passwords, raw cookies, emails, phones, and lead bodies are never stored.
 * - `platform_audit` is append-only at the database layer via `platform_audit_no_update`
 *   and `platform_audit_no_delete` triggers in `0001_initial_platform.sql`.
 */

export const MIN_OPERATOR_REASON_LENGTH = 10 as const;
export const MAX_OPERATOR_REASON_LENGTH = 500 as const;
export const DEFAULT_AUDIT_LIST_LIMIT = 20 as const;
export const MAX_AUDIT_LIST_LIMIT = 100 as const;

const MAX_AUDIT_METADATA_DEPTH = 5;
const MAX_AUDIT_METADATA_JSON_BYTES = 4096;
const MAX_AUDIT_STRING_VALUE_LENGTH = 300;

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const AUDIT_EXTRA_SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /lead[_-]?body/i,
  /customer[_-]?message/i,
  /inquiry(?:[_-]?body)?/i,
  /message(?:[_-]?body)?/i,
  /form[_-]?body/i,
  /notes[_-]?body/i,
  /raw[_-]?cookie/i,
  /set[_-]?cookie/i,
  /session[_-]?token/i,
  /recovery[_-]?code/i,
  /totp[_-]?seed/i,
  /plaintext/i,
  /content[_-]?body/i,
];

const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const AUDIT_PROVIDER_KEY_RE =
  /\b(?:(?:sk_live|sk_test|pk_live|pk_test|rk_live|rk_test|whsec|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|xoxa|AIza|AKIA)[_-]?[A-Za-z0-9_-]{8,}|(?:re|cf)_[A-Za-z0-9_-]{8,})\b/g;
const COOKIE_PAIR_RE = /\b(__Host-[A-Za-z0-9_.-]+|__Secure-[A-Za-z0-9_.-]+|connect\.sid)=([^\s;,]+)/gi;
const KV_SECRET_RE =
  /\b(password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|cookie|set-cookie|client_secret|session[_-]?token|totp[_-]?(?:secret|seed)|backup[_-]?codes?|lead[_-]?body|customer[_-]?message|raw[_-]?cookie)\s*([:=])\s*([^\s,;'"}\]]+)/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const ID_PHONE_RE = /(?<!\w)(?:\+?62|0)8[1-9](?:[\s.-]?\d){6,11}(?!\w)/g;
const INTL_PHONE_RE = /(?<!\w)\+[1-9]\d{0,2}(?:[\s.-]?\d){7,13}(?!\w)/g;
const FORMATTED_PHONE_RE =
  /(?<!\w)(?:\(\d{3}\)\s?\d{3}[\s.-]\d{4}|\d{3}[\s.-]\d{3}[\s.-]\d{4})(?!\w)/g;
const CONTROL_CHARS_RE = /[\r\n\t\p{Cc}]+/gu;
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;

export const PLATFORM_AUDIT_OUTCOMES = ["success", "denied", "error"] as const;
export type PlatformAuditOutcome = (typeof PLATFORM_AUDIT_OUTCOMES)[number];

export type PlatformAuditErrorCode = "VALIDATION_ERROR" | "AUDIT_PERSISTENCE_FAILED";

export class PlatformAuditError extends Error {
  readonly status: 422 | 500;
  readonly code: PlatformAuditErrorCode;

  constructor(status: 422 | 500, code: PlatformAuditErrorCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "PlatformAuditError";
    this.status = status;
    this.code = code;
  }
}

export interface AppendPlatformAuditInput {
  readonly id?: string;
  readonly actorUserId?: string | null;
  readonly actorRole: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly tenantId?: string | null;
  readonly reason?: string | null;
  /**
   * When true, strictly enforces PLAN §13 reason length (10-500 chars).
   * Defaults to false for passive/denied audit rows; privileged mutation helpers pass `true`.
   */
  readonly requireReason?: boolean;
  readonly outcome: PlatformAuditOutcome;
  readonly requestId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly createdAtMs?: number;
}

export interface PlatformAuditRecord {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly actorRole: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly tenantId: string | null;
  readonly reason: string | null;
  readonly outcome: PlatformAuditOutcome;
  readonly requestId: string | null;
  readonly metadataJson: string | null;
  readonly createdAt: number;
}

export interface ListPlatformAuditFilter {
  readonly action?: string;
  readonly actorUserId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly tenantId?: string;
  readonly outcome?: PlatformAuditOutcome;
  readonly requestId?: string;
  readonly beforeCreatedAtMs?: number;
  readonly limit?: number;
}

interface PlatformAuditDbRow {
  readonly id: string;
  readonly actor_user_id: string | null;
  readonly actor_role: string;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly tenant_id: string | null;
  readonly reason: string | null;
  readonly outcome: PlatformAuditOutcome;
  readonly request_id: string | null;
  readonly metadata_json: string | null;
  readonly created_at: number;
}

/**
 * Generates a 26-character Crockford Base32 ULID compatible with `UlidSchema`
 * using Web Crypto randomness (works in both Cloudflare `workerd` and Node).
 */
export function generatePlatformAuditId(nowMs: number = Date.now()): string {
  const timestamp = Math.max(0, Math.trunc(nowMs));
  let timeRemaining = timestamp;
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = CROCKFORD_BASE32[timeRemaining % 32] ?? "0";
    timeRemaining = Math.floor(timeRemaining / 32);
  }

  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const randChars = new Array<string>(16);
  for (let i = 0; i < 16; i += 1) {
    randChars[i] = CROCKFORD_BASE32[(randomBytes[i] ?? 0) & 31] ?? "0";
  }

  return `${timeChars.join("")}${randChars.join("")}`;
}

export function isAuditSensitiveKey(key: string): boolean {
  if (isSensitiveFieldName(key)) return true;
  const trimmed = key.trim();
  if (!trimmed) return false;
  return AUDIT_EXTRA_SENSITIVE_KEY_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Scrubs control characters, PEM keys, JWTs, auth headers, provider keys, raw cookies,
 * key-value secrets, emails, and phone numbers from audit text.
 */
export function redactAuditText(input: string): string {
  return input
    .replace(PEM_BLOCK_RE, REDACTED_VALUE)
    .replace(CONTROL_CHARS_RE, " ")
    .trim()
    .replace(JWT_RE, REDACTED_VALUE)
    .replace(AUTH_SCHEME_RE, (_m, scheme: string) => `${scheme} ${REDACTED_VALUE}`)
    .replace(AUDIT_PROVIDER_KEY_RE, REDACTED_VALUE)
    .replace(COOKIE_PAIR_RE, (_m, name: string) => `${name}=${REDACTED_VALUE}`)
    .replace(KV_SECRET_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED_VALUE}`)
    .replace(EMAIL_RE, REDACTED_VALUE)
    .replace(ID_PHONE_RE, REDACTED_VALUE)
    .replace(INTL_PHONE_RE, REDACTED_VALUE)
    .replace(FORMATTED_PHONE_RE, REDACTED_VALUE);
}

/**
 * Validates and redacts a mandatory operator mutation reason per PLAN §13 (10-500 chars).
 */
export function validateOperatorReason(rawReason: unknown): string {
  if (typeof rawReason !== "string") {
    throw new PlatformAuditError(
      422,
      "VALIDATION_ERROR",
      `Operator reason is required (${MIN_OPERATOR_REASON_LENGTH}-${MAX_OPERATOR_REASON_LENGTH} characters).`,
    );
  }

  const trimmed = rawReason.replace(CONTROL_CHARS_RE, " ").trim();
  if (trimmed.length < MIN_OPERATOR_REASON_LENGTH) {
    throw new PlatformAuditError(
      422,
      "VALIDATION_ERROR",
      `Operator reason must be at least ${MIN_OPERATOR_REASON_LENGTH} characters.`,
    );
  }
  if (trimmed.length > MAX_OPERATOR_REASON_LENGTH) {
    throw new PlatformAuditError(
      422,
      "VALIDATION_ERROR",
      `Operator reason must be at most ${MAX_OPERATOR_REASON_LENGTH} characters.`,
    );
  }

  const redacted = redactAuditText(trimmed);
  if (redacted.length < MIN_OPERATOR_REASON_LENGTH) {
    throw new PlatformAuditError(
      422,
      "VALIDATION_ERROR",
      `Operator reason must contain at least ${MIN_OPERATOR_REASON_LENGTH} non-sensitive characters.`,
    );
  }

  return redacted.slice(0, MAX_OPERATOR_REASON_LENGTH);
}

export function sanitizeOptionalAuditReason(rawReason: string | null | undefined): string | null {
  if (rawReason === null || rawReason === undefined) return null;
  const redacted = redactAuditText(rawReason);
  if (!redacted) return null;
  return redacted.slice(0, MAX_OPERATOR_REASON_LENGTH);
}

function redactAuditMetadataValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return redactAuditText(value).slice(0, MAX_AUDIT_STRING_VALUE_LENGTH);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Error) {
    return { errorCode: sanitizeErrorCode(value) };
  }
  if (typeof value !== "object") {
    return REDACTED_VALUE;
  }
  if (depth >= MAX_AUDIT_METADATA_DEPTH) {
    return REDACTED_VALUE;
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => redactAuditMetadataValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const cleanKey = k.replace(CONTROL_CHARS_RE, " ").trim().slice(0, 64);
    if (!cleanKey) continue;
    if (isAuditSensitiveKey(cleanKey)) {
      out[cleanKey] = REDACTED_VALUE;
    } else {
      out[cleanKey] = redactAuditMetadataValue(v, depth + 1, seen);
    }
  }
  return out;
}

/**
 * Deeply redacts audit metadata so secrets, tokens, passwords, cookies, PII,
 * and tenant lead/message bodies are never persisted to `platform_audit.metadata_json`.
 */
export function redactAuditMetadata(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): Readonly<Record<string, unknown>> | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const seen = new WeakSet<object>();
  seen.add(metadata);

  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [rawKey, value] of Object.entries(metadata)) {
    const key = rawKey.replace(CONTROL_CHARS_RE, " ").trim().slice(0, 64);
    if (!key) continue;
    if (isAuditSensitiveKey(key)) {
      out[key] = REDACTED_VALUE;
    } else {
      out[key] = redactAuditMetadataValue(value, 1, seen);
    }
    keys += 1;
    if (keys >= 32) break;
  }

  return keys > 0 ? out : null;
}

export function serializeAuditMetadata(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  const redacted = redactAuditMetadata(metadata);
  if (!redacted) return null;
  const json = JSON.stringify(redacted);
  if (json.length <= MAX_AUDIT_METADATA_JSON_BYTES) {
    return json;
  }
  return JSON.stringify({
    truncated: true,
    keys: Object.keys(redacted).slice(0, 16),
  });
}

function sanitizeIdentifierField(
  raw: string,
  fieldName: string,
  maxLength: number,
): string {
  const cleaned = raw.replace(CONTROL_CHARS_RE, " ").trim();
  if (!cleaned) {
    throw new PlatformAuditError(
      422,
      "VALIDATION_ERROR",
      `Audit field "${fieldName}" must be a non-empty string.`,
    );
  }
  return redactAuditText(cleaned).slice(0, maxLength);
}

function sanitizeNullableId(raw: string | null | undefined, maxLength = 128): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw.replace(CONTROL_CHARS_RE, " ").trim();
  if (!cleaned) return null;
  return redactAuditText(cleaned).slice(0, maxLength);
}

function sanitizeAuditRequestId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw.replace(CONTROL_CHARS_RE, " ").trim();
  if (!cleaned) return null;
  if (redactAuditText(cleaned) !== cleaned || !SAFE_REQUEST_ID_RE.test(cleaned)) {
    return "redacted";
  }
  return cleaned;
}

export function preparePlatformAuditRecord(input: AppendPlatformAuditInput): PlatformAuditRecord {
  const createdAt = Math.trunc(input.createdAtMs ?? Date.now());
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    throw new PlatformAuditError(422, "VALIDATION_ERROR", "Audit timestamp must be a valid epoch ms.");
  }

  if (!PLATFORM_AUDIT_OUTCOMES.includes(input.outcome)) {
    throw new PlatformAuditError(
      422,
      "VALIDATION_ERROR",
      `Invalid audit outcome "${String(input.outcome)}".`,
    );
  }

  const id = input.id?.trim() ? sanitizeIdentifierField(input.id, "id", 64) : generatePlatformAuditId(createdAt);
  const actorRole = sanitizeIdentifierField(input.actorRole, "actorRole", 64);
  const action = sanitizeIdentifierField(input.action, "action", 120);
  const targetType = sanitizeIdentifierField(input.targetType, "targetType", 64);
  const targetId = sanitizeIdentifierField(input.targetId, "targetId", 128);
  const reason = input.requireReason
    ? validateOperatorReason(input.reason)
    : sanitizeOptionalAuditReason(input.reason);

  return {
    id,
    actorUserId: sanitizeNullableId(input.actorUserId, 128),
    actorRole,
    action,
    targetType,
    targetId,
    tenantId: sanitizeNullableId(input.tenantId, 128),
    reason,
    outcome: input.outcome,
    requestId: sanitizeAuditRequestId(input.requestId),
    metadataJson: serializeAuditMetadata(input.metadata),
    createdAt,
  };
}

const INSERT_PLATFORM_AUDIT_SQL = `
INSERT INTO platform_audit (
  id,
  actor_user_id,
  actor_role,
  action,
  target_type,
  target_id,
  tenant_id,
  reason,
  outcome,
  request_id,
  metadata_json,
  created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

const CONDITIONAL_INSERT_PLATFORM_AUDIT_SQL = `
INSERT INTO platform_audit (
  id,
  actor_user_id,
  actor_role,
  action,
  target_type,
  target_id,
  tenant_id,
  reason,
  outcome,
  request_id,
  metadata_json,
  created_at
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE changes() = 1
`.trim();

function bindAuditParams(entry: PlatformAuditRecord): readonly (string | number | null)[] {
  return [
    entry.id,
    entry.actorUserId,
    entry.actorRole,
    entry.action,
    entry.targetType,
    entry.targetId,
    entry.tenantId,
    entry.reason,
    entry.outcome,
    entry.requestId,
    entry.metadataJson,
    entry.createdAt,
  ];
}

/**
 * Builds a prepared `INSERT INTO platform_audit` statement for composition inside an
 * atomic `D1Database.batch([...])` transaction.
 *
 * When `options.onlyIfPreviousChanged` is true, appends `SELECT ... WHERE changes() = 1`
 * so a no-op conditional UPDATE/INSERT in the preceding statement does not emit a
 * false `success` audit entry, while any audit insert failure still rolls back the batch.
 */
export function buildPlatformAuditStatement(
  platformDb: D1Database,
  input: AppendPlatformAuditInput,
  options?: { readonly onlyIfPreviousChanged?: boolean },
): { readonly statement: D1PreparedStatement; readonly entry: PlatformAuditRecord } {
  const entry = preparePlatformAuditRecord(input);
  const sql = options?.onlyIfPreviousChanged
    ? CONDITIONAL_INSERT_PLATFORM_AUDIT_SQL
    : INSERT_PLATFORM_AUDIT_SQL;
  const statement = platformDb.prepare(sql).bind(...bindAuditParams(entry));
  return { statement, entry };
}

/**
 * Appends a single immutable audit row to `PLATFORM_DB.platform_audit`.
 */
export async function appendPlatformAudit(
  platformDb: D1Database,
  input: AppendPlatformAuditInput,
): Promise<PlatformAuditRecord> {
  const { statement, entry } = buildPlatformAuditStatement(platformDb, input);
  try {
    const result = await statement.run();
    if (!result.success) {
      throw new PlatformAuditError(
        500,
        "AUDIT_PERSISTENCE_FAILED",
        "Failed to persist platform audit entry.",
      );
    }
    return entry;
  } catch (err) {
    if (err instanceof PlatformAuditError) throw err;
    throw new PlatformAuditError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Failed to persist platform audit entry.",
      err,
    );
  }
}

function mapAuditRow(row: PlatformAuditDbRow): PlatformAuditRecord {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    tenantId: row.tenant_id,
    reason: row.reason,
    outcome: row.outcome,
    requestId: row.request_id,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
  };
}

/**
 * Lists append-only `platform_audit` entries in reverse chronological order
 * (`created_at DESC, id DESC`) with bounded pagination (default 20, max 100).
 */
export async function listPlatformAuditEntries(
  platformDb: D1Database,
  filter: ListPlatformAuditFilter = {},
): Promise<readonly PlatformAuditRecord[]> {
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];

  if (filter.action) {
    clauses.push("action = ?");
    bindings.push(filter.action);
  }
  if (filter.actorUserId) {
    clauses.push("actor_user_id = ?");
    bindings.push(filter.actorUserId);
  }
  if (filter.targetType) {
    clauses.push("target_type = ?");
    bindings.push(filter.targetType);
  }
  if (filter.targetId) {
    clauses.push("target_id = ?");
    bindings.push(filter.targetId);
  }
  if (filter.tenantId) {
    clauses.push("tenant_id = ?");
    bindings.push(filter.tenantId);
  }
  if (filter.outcome) {
    clauses.push("outcome = ?");
    bindings.push(filter.outcome);
  }
  if (filter.requestId) {
    clauses.push("request_id = ?");
    bindings.push(filter.requestId);
  }
  if (typeof filter.beforeCreatedAtMs === "number" && Number.isFinite(filter.beforeCreatedAtMs)) {
    clauses.push("created_at < ?");
    bindings.push(Math.trunc(filter.beforeCreatedAtMs));
  }

  const rawLimit = filter.limit ?? DEFAULT_AUDIT_LIST_LIMIT;
  const boundedLimit = Math.max(1, Math.min(MAX_AUDIT_LIST_LIMIT, Math.trunc(rawLimit)));

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `
    SELECT
      id,
      actor_user_id,
      actor_role,
      action,
      target_type,
      target_id,
      tenant_id,
      reason,
      outcome,
      request_id,
      metadata_json,
      created_at
    FROM platform_audit
    ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `;

  const result = await platformDb
    .prepare(sql)
    .bind(...bindings, boundedLimit)
    .all<PlatformAuditDbRow>();

  return (result.results ?? []).map(mapAuditRow);
}

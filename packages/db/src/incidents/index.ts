import { REDACTED_VALUE } from "@punyasitus/core/jobs/redact";
import {
  buildPlatformAuditStatement,
  generatePlatformAuditId,
  MIN_OPERATOR_REASON_LENGTH,
  MAX_OPERATOR_REASON_LENGTH,
  validateOperatorReason,
  type PlatformAuditRecord,
} from "../platform/audit.ts";
import { getActivePlatformOperator } from "../platform/operators.ts";

export {
  ensurePlatformIncidentsSchema,
  PLATFORM_0007_INCIDENTS_SQL,
} from "./migrations.ts";

/**
 * Authoritative `PLATFORM_DB.platform_incidents` & `platform_incident_updates`
 * repository with atomic `platform_audit` coupling and optimistic concurrency
 * (REQ-106, REQ-042; PLAN §20.3; TASK-106).
 */

export const INCIDENT_SEVERITIES = ["minor", "major", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const ACTIVE_INCIDENT_STATUSES = [
  "investigating",
  "identified",
  "monitoring",
] as const;
export type ActiveIncidentStatus = (typeof ACTIVE_INCIDENT_STATUSES)[number];

export const PLATFORM_INCIDENT_COMPONENTS = [
  {
    id: "public_sites",
    label: "Situs Publik",
  },
  {
    id: "dashboard_cms",
    label: "Dashboard & CMS",
  },
  {
    id: "domains_ssl",
    label: "Domain & SSL",
  },
  {
    id: "billing_payments",
    label: "Pembayaran & Perpanjangan",
  },
  {
    id: "email_notifications",
    label: "Notifikasi Email",
  },
] as const;

export type PlatformComponentId = (typeof PLATFORM_INCIDENT_COMPONENTS)[number]["id"];

const VALID_COMPONENT_IDS = new Set<string>(
  PLATFORM_INCIDENT_COMPONENTS.map((c) => c.id),
);

export const DEFAULT_STATUS_PAGE_URL = "https://status.punyasitus.com" as const;
export const MIN_INCIDENT_TITLE_LENGTH = 5 as const;
export const MAX_INCIDENT_TITLE_LENGTH = 140 as const;
export const MIN_INCIDENT_SUMMARY_LENGTH = 10 as const;
export const MAX_INCIDENT_SUMMARY_LENGTH = 1000 as const;
export const MAX_INCIDENT_LIST_LIMIT = 50 as const;

const CONTROL_CHARS_RE = /[\r\n\t\p{Cc}]+/gu;
const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AUTH_SCHEME_SECRET_RE = /\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const PROVIDER_KEY_SECRET_RE =
  /\b(?:(?:sk_live|sk_test|pk_live|pk_test|rk_live|rk_test|whsec|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|xoxa|AIza|AKIA)[_-]?[A-Za-z0-9_-]{8,}|(?:re|cf)_[A-Za-z0-9_-]{8,})\b/g;
const COOKIE_PAIR_RE = /\b(__Host-[A-Za-z0-9_.-]+|__Secure-[A-Za-z0-9_.-]+|connect\.sid)=([^\s;,]+)/gi;
const KV_SECRET_RE =
  /\b(password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|cookie|set-cookie|client_secret)\s*([:=])\s*([^\s,;'"}\]]+)/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const ID_PHONE_RE = /(?<!\w)(?:\+?62|0)8[1-9](?:[\s.-]?\d){6,11}(?!\w)/g;
const INTL_PHONE_RE = /(?<!\w)\+[1-9]\d{0,2}(?:[\s.-]?\d){7,13}(?!\w)/g;
const FORMATTED_PHONE_RE =
  /(?<!\w)(?:\(\d{3}\)\s?\d{3}[\s.-]\d{4}|\d{3}[\s.-]\d{3}[\s.-]\d{4})(?!\w)/g;
const INCIDENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type PlatformIncidentErrorCode =
  | "VALIDATION_ERROR"
  | "UNKNOWN_FIELD"
  | "PLATFORM_OPERATOR_REQUIRED"
  | "INCIDENT_NOT_FOUND"
  | "INCIDENT_ALREADY_RESOLVED"
  | "VERSION_CONFLICT"
  | "AUDIT_PERSISTENCE_FAILED";

export interface PlatformIncidentFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class PlatformIncidentError extends Error {
  readonly status: 403 | 404 | 409 | 422 | 500;
  readonly code: PlatformIncidentErrorCode;
  readonly fields: readonly PlatformIncidentFieldError[];

  constructor(
    status: 403 | 404 | 409 | 422 | 500,
    code: PlatformIncidentErrorCode,
    message: string,
    fields: readonly PlatformIncidentFieldError[] = [],
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "PlatformIncidentError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export interface PlatformIncidentUpdateRecord {
  readonly id: string;
  readonly incidentId: string;
  readonly status: IncidentStatus;
  readonly severity: IncidentSeverity;
  readonly message: string;
  readonly actorUserId: string;
  readonly createdAt: number;
}

export interface PlatformIncidentRecord {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly affectedComponents: readonly PlatformComponentId[];
  readonly bannerVisible: boolean;
  readonly declaredByUserId: string;
  readonly resolvedByUserId: string | null;
  readonly version: number;
  readonly declaredAt: number;
  readonly resolvedAt: number | null;
  readonly updatedAt: number;
  readonly updates: readonly PlatformIncidentUpdateRecord[];
}

/**
 * Sanitized public/dashboard banner DTO — exposes zero operator user IDs,
 * internal audit IDs, stack traces, secrets, or tenant PII.
 */
export interface PublicIncidentBannerItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly severity: IncidentSeverity;
  readonly status: ActiveIncidentStatus;
  readonly affectedComponents: readonly PlatformComponentId[];
  readonly declaredAt: number;
  readonly updatedAt: number;
  readonly statusPageUrl: string;
}

export interface ValidatedDeclareIncidentPayload {
  readonly title: string;
  readonly summary: string;
  readonly severity: IncidentSeverity;
  readonly status: ActiveIncidentStatus;
  readonly affectedComponents: readonly PlatformComponentId[];
  readonly bannerVisible: boolean;
  readonly reason: string;
}

export interface ValidatedUpdateIncidentPayload {
  readonly expectedVersion: number;
  readonly title?: string;
  readonly summary?: string;
  readonly severity?: IncidentSeverity;
  readonly status?: IncidentStatus;
  readonly affectedComponents?: readonly PlatformComponentId[];
  readonly bannerVisible?: boolean;
  readonly updateMessage?: string;
  readonly reason: string;
}

export interface ValidatedResolveIncidentPayload {
  readonly expectedVersion: number;
  readonly resolutionNote: string;
  readonly reason: string;
}

export interface DeclareIncidentInput {
  readonly actorUserId: string;
  readonly payload: unknown;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface UpdateIncidentInput {
  readonly actorUserId: string;
  readonly incidentId: string;
  readonly payload: unknown;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface ResolveIncidentInput {
  readonly actorUserId: string;
  readonly incidentId: string;
  readonly payload: unknown;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface PlatformIncidentMutationResult {
  readonly incident: PlatformIncidentRecord;
  readonly audit: PlatformAuditRecord;
}

interface IncidentDbRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly affected_components_json: string;
  readonly banner_visible: number;
  readonly declared_by_user_id: string;
  readonly resolved_by_user_id: string | null;
  readonly version: number;
  readonly declared_at: number;
  readonly resolved_at: number | null;
  readonly updated_at: number;
}

interface IncidentUpdateDbRow {
  readonly id: string;
  readonly incident_id: string;
  readonly status: IncidentStatus;
  readonly severity: IncidentSeverity;
  readonly message: string;
  readonly actor_user_id: string;
  readonly created_at: number;
}

const DECLARE_ALLOWED_KEYS = new Set([
  "title",
  "summary",
  "severity",
  "status",
  "affectedComponents",
  "bannerVisible",
  "reason",
]);

const UPDATE_ALLOWED_KEYS = new Set([
  "expectedVersion",
  "title",
  "summary",
  "severity",
  "status",
  "affectedComponents",
  "bannerVisible",
  "updateMessage",
  "reason",
]);

const RESOLVE_ALLOWED_KEYS = new Set([
  "expectedVersion",
  "resolutionNote",
  "summary",
  "reason",
]);

export function isValidIncidentSeverity(value: unknown): value is IncidentSeverity {
  return (
    typeof value === "string" &&
    (INCIDENT_SEVERITIES as readonly string[]).includes(value)
  );
}

export function isValidIncidentStatus(value: unknown): value is IncidentStatus {
  return (
    typeof value === "string" &&
    (INCIDENT_STATUSES as readonly string[]).includes(value)
  );
}

export function isActiveIncidentStatus(value: unknown): value is ActiveIncidentStatus {
  return (
    typeof value === "string" &&
    (ACTIVE_INCIDENT_STATUSES as readonly string[]).includes(value)
  );
}

export function isValidIncidentId(value: string): boolean {
  return INCIDENT_ID_RE.test(value.trim());
}

/**
 * Strips control characters, collapses whitespace, and scrubs embedded secrets,
 * tokens, emails, or phone numbers before storing or emitting incident copy.
 */
export function sanitizeIncidentText(raw: string, maxLength: number): string {
  const collapsed = raw.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  const redacted = collapsed
    .replace(PEM_BLOCK_RE, REDACTED_VALUE)
    .replace(JWT_RE, REDACTED_VALUE)
    .replace(AUTH_SCHEME_SECRET_RE, (_m, scheme: string) => `${scheme} ${REDACTED_VALUE}`)
    .replace(PROVIDER_KEY_SECRET_RE, REDACTED_VALUE)
    .replace(COOKIE_PAIR_RE, (_m, name: string) => `${name}=${REDACTED_VALUE}`)
    .replace(KV_SECRET_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED_VALUE}`)
    .replace(EMAIL_RE, REDACTED_VALUE)
    .replace(ID_PHONE_RE, REDACTED_VALUE)
    .replace(INTL_PHONE_RE, REDACTED_VALUE)
    .replace(FORMATTED_PHONE_RE, REDACTED_VALUE);
  return redacted.length > maxLength ? redacted.slice(0, maxLength).trim() : redacted;
}

function assertObjectWithAllowedKeys(
  rawBody: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new PlatformIncidentError(
      422,
      "VALIDATION_ERROR",
      "Body permintaan harus berupa objek JSON.",
      [{ field: "body", code: "INVALID_PAYLOAD", message: "Expected a JSON object." }],
    );
  }
  const record = rawBody as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new PlatformIncidentError(
        422,
        "UNKNOWN_FIELD",
        `Field tidak dikenal "${key}".`,
        [
          {
            field: key,
            code: "UNKNOWN_FIELD",
            message: `Unknown field "${key}" is not allowed.`,
          },
        ],
      );
    }
  }
  return record;
}

function parseAffectedComponents(
  raw: unknown,
  errors: PlatformIncidentFieldError[],
): readonly PlatformComponentId[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push({
      field: "affectedComponents",
      code: "COMPONENTS_REQUIRED",
      message: "Pilih minimal satu komponen layanan yang terdampak.",
    });
    return [];
  }
  const unique = new Set<PlatformComponentId>();
  for (const item of raw) {
    if (typeof item !== "string" || !VALID_COMPONENT_IDS.has(item)) {
      errors.push({
        field: "affectedComponents",
        code: "INVALID_COMPONENT",
        message: `Komponen tidak dikenal: ${String(item)}.`,
      });
      return [];
    }
    unique.add(item as PlatformComponentId);
  }
  return Array.from(unique);
}

function parseStoredComponents(rawJson: string): readonly PlatformComponentId[] {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PlatformComponentId =>
        typeof item === "string" && VALID_COMPONENT_IDS.has(item),
    );
  } catch {
    return [];
  }
}

function resolveAuditReason(
  rawReason: unknown,
  fallbackText: string,
  errors: PlatformIncidentFieldError[],
): string {
  const candidate =
    typeof rawReason === "string" && rawReason.trim().length > 0
      ? rawReason
      : fallbackText;
  const sanitized = sanitizeIncidentText(candidate, MAX_OPERATOR_REASON_LENGTH);
  if (sanitized.length < MIN_OPERATOR_REASON_LENGTH) {
    errors.push({
      field: "reason",
      code: "REASON_TOO_SHORT",
      message: `Alasan audit wajib minimal ${MIN_OPERATOR_REASON_LENGTH} karakter.`,
    });
    return "";
  }
  try {
    return validateOperatorReason(sanitized);
  } catch (err) {
    errors.push({
      field: "reason",
      code: "INVALID_REASON",
      message:
        err instanceof Error ? err.message : "Alasan audit tidak valid.",
    });
    return "";
  }
}

/**
 * Pure validator for declaring a new platform incident.
 */
export function validateDeclareIncidentPayload(
  rawBody: unknown,
): ValidatedDeclareIncidentPayload {
  const record = assertObjectWithAllowedKeys(rawBody, DECLARE_ALLOWED_KEYS);
  const errors: PlatformIncidentFieldError[] = [];

  const title =
    typeof record.title === "string"
      ? sanitizeIncidentText(record.title, MAX_INCIDENT_TITLE_LENGTH)
      : "";
  if (title.length < MIN_INCIDENT_TITLE_LENGTH) {
    errors.push({
      field: "title",
      code: "TITLE_TOO_SHORT",
      message: `Judul insiden wajib diisi minimal ${MIN_INCIDENT_TITLE_LENGTH} karakter.`,
    });
  }

  const summary =
    typeof record.summary === "string"
      ? sanitizeIncidentText(record.summary, MAX_INCIDENT_SUMMARY_LENGTH)
      : "";
  if (summary.length < MIN_INCIDENT_SUMMARY_LENGTH) {
    errors.push({
      field: "summary",
      code: "SUMMARY_TOO_SHORT",
      message: `Ringkasan publik wajib diisi minimal ${MIN_INCIDENT_SUMMARY_LENGTH} karakter.`,
    });
  }

  let severity: IncidentSeverity = "major";
  if (!isValidIncidentSeverity(record.severity)) {
    errors.push({
      field: "severity",
      code: "INVALID_SEVERITY",
      message: "Tingkat dampak harus minor, major, atau critical.",
    });
  } else {
    severity = record.severity;
  }

  let status: ActiveIncidentStatus = "investigating";
  if (record.status !== undefined) {
    if (!isActiveIncidentStatus(record.status)) {
      errors.push({
        field: "status",
        code: "INVALID_STATUS",
        message: "Status awal insiden harus investigating, identified, atau monitoring.",
      });
    } else {
      status = record.status;
    }
  }

  const affectedComponents = parseAffectedComponents(record.affectedComponents, errors);

  let bannerVisible = true;
  if (record.bannerVisible !== undefined) {
    if (typeof record.bannerVisible !== "boolean") {
      errors.push({
        field: "bannerVisible",
        code: "INVALID_BOOLEAN",
        message: "bannerVisible harus berupa nilai boolean.",
      });
    } else {
      bannerVisible = record.bannerVisible;
    }
  }

  const reason = resolveAuditReason(
    record.reason,
    `Deklarasi insiden (${severity}): ${title} — ${summary}`,
    errors,
  );

  if (errors.length > 0) {
    throw new PlatformIncidentError(
      422,
      "VALIDATION_ERROR",
      "Data deklarasi insiden tidak valid.",
      errors,
    );
  }

  return {
    title,
    summary,
    severity,
    status,
    affectedComponents,
    bannerVisible,
    reason,
  };
}

/**
 * Pure validator for updating an active platform incident with optimistic concurrency.
 */
export function validateUpdateIncidentPayload(
  rawBody: unknown,
): ValidatedUpdateIncidentPayload {
  const record = assertObjectWithAllowedKeys(rawBody, UPDATE_ALLOWED_KEYS);
  const errors: PlatformIncidentFieldError[] = [];

  let expectedVersion = 0;
  if (
    typeof record.expectedVersion !== "number" ||
    !Number.isSafeInteger(record.expectedVersion) ||
    record.expectedVersion < 1
  ) {
    errors.push({
      field: "expectedVersion",
      code: "INVALID_VERSION",
      message: "expectedVersion wajib berupa bilangan bulat >= 1.",
    });
  } else {
    expectedVersion = record.expectedVersion;
  }

  let title: string | undefined;
  if (record.title !== undefined) {
    if (typeof record.title !== "string") {
      errors.push({
        field: "title",
        code: "INVALID_TITLE",
        message: "Judul insiden harus berupa teks.",
      });
    } else {
      title = sanitizeIncidentText(record.title, MAX_INCIDENT_TITLE_LENGTH);
      if (title.length < MIN_INCIDENT_TITLE_LENGTH) {
        errors.push({
          field: "title",
          code: "TITLE_TOO_SHORT",
          message: `Judul insiden minimal ${MIN_INCIDENT_TITLE_LENGTH} karakter.`,
        });
      }
    }
  }

  let summary: string | undefined;
  if (record.summary !== undefined) {
    if (typeof record.summary !== "string") {
      errors.push({
        field: "summary",
        code: "INVALID_SUMMARY",
        message: "Ringkasan harus berupa teks.",
      });
    } else {
      summary = sanitizeIncidentText(record.summary, MAX_INCIDENT_SUMMARY_LENGTH);
      if (summary.length < MIN_INCIDENT_SUMMARY_LENGTH) {
        errors.push({
          field: "summary",
          code: "SUMMARY_TOO_SHORT",
          message: `Ringkasan minimal ${MIN_INCIDENT_SUMMARY_LENGTH} karakter.`,
        });
      }
    }
  }

  let severity: IncidentSeverity | undefined;
  if (record.severity !== undefined) {
    if (!isValidIncidentSeverity(record.severity)) {
      errors.push({
        field: "severity",
        code: "INVALID_SEVERITY",
        message: "Tingkat dampak harus minor, major, atau critical.",
      });
    } else {
      severity = record.severity;
    }
  }

  let status: IncidentStatus | undefined;
  if (record.status !== undefined) {
    if (!isValidIncidentStatus(record.status)) {
      errors.push({
        field: "status",
        code: "INVALID_STATUS",
        message: "Status insiden harus investigating, identified, monitoring, atau resolved.",
      });
    } else {
      status = record.status;
    }
  }

  let affectedComponents: readonly PlatformComponentId[] | undefined;
  if (record.affectedComponents !== undefined) {
    affectedComponents = parseAffectedComponents(record.affectedComponents, errors);
  }

  let bannerVisible: boolean | undefined;
  if (record.bannerVisible !== undefined) {
    if (typeof record.bannerVisible !== "boolean") {
      errors.push({
        field: "bannerVisible",
        code: "INVALID_BOOLEAN",
        message: "bannerVisible harus berupa nilai boolean.",
      });
    } else {
      bannerVisible = record.bannerVisible;
    }
  }

  let updateMessage: string | undefined;
  if (record.updateMessage !== undefined) {
    if (typeof record.updateMessage !== "string") {
      errors.push({
        field: "updateMessage",
        code: "INVALID_MESSAGE",
        message: "Catatan pembaruan harus berupa teks.",
      });
    } else {
      updateMessage = sanitizeIncidentText(
        record.updateMessage,
        MAX_INCIDENT_SUMMARY_LENGTH,
      );
      if (updateMessage.length < MIN_INCIDENT_SUMMARY_LENGTH) {
        errors.push({
          field: "updateMessage",
          code: "MESSAGE_TOO_SHORT",
          message: `Catatan pembaruan minimal ${MIN_INCIDENT_SUMMARY_LENGTH} karakter.`,
        });
      }
    }
  }

  const hasMutationField =
    title !== undefined ||
    summary !== undefined ||
    severity !== undefined ||
    status !== undefined ||
    affectedComponents !== undefined ||
    bannerVisible !== undefined ||
    updateMessage !== undefined;

  if (!hasMutationField) {
    errors.push({
      field: "body",
      code: "NO_CHANGES",
      message: "Sertakan minimal satu perubahan insiden untuk disimpan.",
    });
  }

  const fallbackReason =
    updateMessage ??
    summary ??
    `Pembaruan status insiden platform ke ${status ?? "status terkini"}`;
  const reason = resolveAuditReason(record.reason, fallbackReason, errors);

  if (errors.length > 0) {
    throw new PlatformIncidentError(
      422,
      "VALIDATION_ERROR",
      "Data pembaruan insiden tidak valid.",
      errors,
    );
  }

  return {
    expectedVersion,
    ...(title !== undefined ? { title } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(affectedComponents !== undefined ? { affectedComponents } : {}),
    ...(bannerVisible !== undefined ? { bannerVisible } : {}),
    ...(updateMessage !== undefined ? { updateMessage } : {}),
    reason,
  };
}

/**
 * Pure validator for resolving an active platform incident in one audited operator action.
 */
export function validateResolveIncidentPayload(
  rawBody: unknown,
): ValidatedResolveIncidentPayload {
  const record = assertObjectWithAllowedKeys(rawBody, RESOLVE_ALLOWED_KEYS);
  const errors: PlatformIncidentFieldError[] = [];

  let expectedVersion = 0;
  if (
    typeof record.expectedVersion !== "number" ||
    !Number.isSafeInteger(record.expectedVersion) ||
    record.expectedVersion < 1
  ) {
    errors.push({
      field: "expectedVersion",
      code: "INVALID_VERSION",
      message: "expectedVersion wajib berupa bilangan bulat >= 1.",
    });
  } else {
    expectedVersion = record.expectedVersion;
  }

  const rawNote =
    typeof record.resolutionNote === "string" && record.resolutionNote.trim().length > 0
      ? record.resolutionNote
      : typeof record.summary === "string" && record.summary.trim().length > 0
        ? record.summary
        : "Insiden telah ditangani dan seluruh layanan kembali normal.";
  const resolutionNote = sanitizeIncidentText(rawNote, MAX_INCIDENT_SUMMARY_LENGTH);
  if (resolutionNote.length < MIN_INCIDENT_SUMMARY_LENGTH) {
    errors.push({
      field: "resolutionNote",
      code: "RESOLUTION_NOTE_TOO_SHORT",
      message: `Catatan penyelesaian minimal ${MIN_INCIDENT_SUMMARY_LENGTH} karakter.`,
    });
  }

  const reason = resolveAuditReason(
    record.reason,
    `Penyelesaian insiden platform: ${resolutionNote}`,
    errors,
  );

  if (errors.length > 0) {
    throw new PlatformIncidentError(
      422,
      "VALIDATION_ERROR",
      "Data penyelesaian insiden tidak valid.",
      errors,
    );
  }

  return {
    expectedVersion,
    resolutionNote,
    reason,
  };
}

function mapIncidentUpdateRow(row: IncidentUpdateDbRow): PlatformIncidentUpdateRecord {
  return {
    id: row.id,
    incidentId: row.incident_id,
    status: row.status,
    severity: row.severity,
    message: sanitizeIncidentText(row.message, MAX_INCIDENT_SUMMARY_LENGTH),
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
  };
}

function mapIncidentRow(
  row: IncidentDbRow,
  updates: readonly PlatformIncidentUpdateRecord[] = [],
): PlatformIncidentRecord {
  return {
    id: row.id,
    title: sanitizeIncidentText(row.title, MAX_INCIDENT_TITLE_LENGTH),
    summary: sanitizeIncidentText(row.summary, MAX_INCIDENT_SUMMARY_LENGTH),
    severity: row.severity,
    status: row.status,
    affectedComponents: parseStoredComponents(row.affected_components_json),
    bannerVisible: row.banner_visible === 1 && row.status !== "resolved",
    declaredByUserId: row.declared_by_user_id,
    resolvedByUserId: row.resolved_by_user_id,
    version: row.version,
    declaredAt: row.declared_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at,
    updates,
  };
}

/**
 * Projects an internal incident row to a sanitized dashboard banner DTO.
 */
export function toPublicIncidentBannerItem(
  incident: Pick<
    PlatformIncidentRecord,
    | "id"
    | "title"
    | "summary"
    | "severity"
    | "status"
    | "affectedComponents"
    | "bannerVisible"
    | "declaredAt"
    | "updatedAt"
  >,
  statusPageUrl: string = DEFAULT_STATUS_PAGE_URL,
): PublicIncidentBannerItem | null {
  if (!incident.bannerVisible || !isActiveIncidentStatus(incident.status)) {
    return null;
  }
  return {
    id: incident.id,
    title: sanitizeIncidentText(incident.title, MAX_INCIDENT_TITLE_LENGTH),
    summary: sanitizeIncidentText(incident.summary, MAX_INCIDENT_SUMMARY_LENGTH),
    severity: incident.severity,
    status: incident.status,
    affectedComponents: incident.affectedComponents,
    declaredAt: incident.declaredAt,
    updatedAt: incident.updatedAt,
    statusPageUrl,
  };
}

export async function getIncidentById(
  platformDb: D1Database,
  incidentId: string,
): Promise<PlatformIncidentRecord | null> {
  const cleanId = incidentId.trim();
  if (!isValidIncidentId(cleanId)) return null;

  const row = await platformDb
    .prepare(
      `SELECT
        id, title, summary, severity, status, affected_components_json,
        banner_visible, declared_by_user_id, resolved_by_user_id,
        version, declared_at, resolved_at, updated_at
       FROM platform_incidents
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(cleanId)
    .first<IncidentDbRow>();

  if (!row) return null;

  const updatesRes = await platformDb
    .prepare(
      `SELECT id, incident_id, status, severity, message, actor_user_id, created_at
       FROM platform_incident_updates
       WHERE incident_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .bind(cleanId)
    .all<IncidentUpdateDbRow>();

  const updates = (updatesRes.results ?? []).map(mapIncidentUpdateRow);
  return mapIncidentRow(row, updates);
}

/**
 * Lists incidents for `console.punyasitus.com/incidents` (active first, then recent resolved).
 */
export async function listIncidents(
  platformDb: D1Database,
  options: { readonly includeResolved?: boolean; readonly limit?: number } = {},
): Promise<readonly PlatformIncidentRecord[]> {
  const includeResolved = options.includeResolved ?? true;
  const boundedLimit = Math.max(
    1,
    Math.min(MAX_INCIDENT_LIST_LIMIT, Math.trunc(options.limit ?? 25)),
  );

  const whereSql = includeResolved ? "" : "WHERE status != 'resolved'";
  const rowsRes = await platformDb
    .prepare(
      `SELECT
        id, title, summary, severity, status, affected_components_json,
        banner_visible, declared_by_user_id, resolved_by_user_id,
        version, declared_at, resolved_at, updated_at
       FROM platform_incidents
       ${whereSql}
       ORDER BY
         CASE WHEN status = 'resolved' THEN 1 ELSE 0 END ASC,
         CASE severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END ASC,
         declared_at DESC,
         id DESC
       LIMIT ?`,
    )
    .bind(boundedLimit)
    .all<IncidentDbRow>();

  const rows = rowsRes.results ?? [];
  if (rows.length === 0) return [];

  const placeholders = rows.map(() => "?").join(", ");
  const ids = rows.map((r) => r.id);
  const updatesRes = await platformDb
    .prepare(
      `SELECT id, incident_id, status, severity, message, actor_user_id, created_at
       FROM platform_incident_updates
       WHERE incident_id IN (${placeholders})
       ORDER BY created_at ASC, id ASC`,
    )
    .bind(...ids)
    .all<IncidentUpdateDbRow>();

  const updatesByIncident = new Map<string, PlatformIncidentUpdateRecord[]>();
  for (const u of updatesRes.results ?? []) {
    const mapped = mapIncidentUpdateRow(u);
    const list = updatesByIncident.get(mapped.incidentId);
    if (list) {
      list.push(mapped);
    } else {
      updatesByIncident.set(mapped.incidentId, [mapped]);
    }
  }

  return rows.map((row) => mapIncidentRow(row, updatesByIncident.get(row.id) ?? []));
}

/**
 * Returns sanitized active incidents that should render in the tenant dashboard banner.
 * Safely returns `[]` if the table has not been migrated yet.
 */
export async function listActiveBannerIncidents(
  platformDb: D1Database,
  options: { readonly statusPageUrl?: string; readonly limit?: number } = {},
): Promise<readonly PublicIncidentBannerItem[]> {
  const statusPageUrl = options.statusPageUrl ?? DEFAULT_STATUS_PAGE_URL;
  const boundedLimit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 5)));

  try {
    const rowsRes = await platformDb
      .prepare(
        `SELECT
          id, title, summary, severity, status, affected_components_json,
          banner_visible, declared_by_user_id, resolved_by_user_id,
          version, declared_at, resolved_at, updated_at
         FROM platform_incidents
         WHERE status != 'resolved' AND banner_visible = 1
         ORDER BY
           CASE severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END ASC,
           declared_at DESC,
           id DESC
         LIMIT ?`,
      )
      .bind(boundedLimit)
      .all<IncidentDbRow>();

    const out: PublicIncidentBannerItem[] = [];
    for (const row of rowsRes.results ?? []) {
      const dto = toPublicIncidentBannerItem(mapIncidentRow(row), statusPageUrl);
      if (dto) out.push(dto);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Declares a new platform incident, appends the initial timeline update, and
 * records an immutable `platform_audit` entry inside ONE atomic `D1Database.batch()`.
 */
export async function declareIncident(
  platformDb: D1Database,
  input: DeclareIncidentInput,
): Promise<PlatformIncidentMutationResult> {
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId) {
    throw new PlatformIncidentError(
      403,
      "PLATFORM_OPERATOR_REQUIRED",
      "Operator platform aktif diperlukan untuk mendeklarasikan insiden.",
    );
  }

  const actorGrant = await getActivePlatformOperator(platformDb, actorUserId);
  if (!actorGrant) {
    throw new PlatformIncidentError(
      403,
      "PLATFORM_OPERATOR_REQUIRED",
      "Akses operator platform aktif diperlukan untuk mendeklarasikan insiden.",
    );
  }

  const validated = validateDeclareIncidentPayload(input.payload);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const incidentId = `inc_${generatePlatformAuditId(nowMs)}`;
  const updateId = `incu_${generatePlatformAuditId(nowMs)}`;
  const componentsJson = JSON.stringify(validated.affectedComponents);

  const insertIncidentStmt = platformDb
    .prepare(
      `INSERT INTO platform_incidents (
        id, title, summary, severity, status, affected_components_json,
        banner_visible, declared_by_user_id, resolved_by_user_id,
        version, declared_at, resolved_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, NULL, ?
      WHERE EXISTS (
        SELECT 1 FROM platform_operators WHERE user_id = ? AND revoked_at IS NULL
      )`,
    )
    .bind(
      incidentId,
      validated.title,
      validated.summary,
      validated.severity,
      validated.status,
      componentsJson,
      validated.bannerVisible ? 1 : 0,
      actorUserId,
      nowMs,
      nowMs,
      actorUserId,
    );

  const insertUpdateStmt = platformDb
    .prepare(
      `INSERT INTO platform_incident_updates (
        id, incident_id, status, severity, message, actor_user_id, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE changes() = 1
        AND EXISTS (
          SELECT 1 FROM platform_incidents WHERE id = ? AND version = 1
        )`,
    )
    .bind(
      updateId,
      incidentId,
      validated.status,
      validated.severity,
      validated.summary,
      actorUserId,
      nowMs,
      incidentId,
    );

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: actorGrant.role,
      action: "platform_incident.declare",
      targetType: "platform_incident",
      targetId: incidentId,
      reason: validated.reason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        severity: validated.severity,
        status: validated.status,
        bannerVisible: validated.bannerVisible,
        affectedComponents: validated.affectedComponents,
        version: 1,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch([insertIncidentStmt, insertUpdateStmt, auditStmt]);
  } catch (err) {
    throw new PlatformIncidentError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Transaksi deklarasi insiden gagal dan dibatalkan sepenuhnya (audit wajib tersimpan).",
      [],
      err,
    );
  }

  const incidentChanges = results[0]?.meta?.changes ?? 0;
  const updateChanges = results[1]?.meta?.changes ?? 0;
  const auditChanges = results[2]?.meta?.changes ?? 0;

  if (incidentChanges !== 1) {
    throw new PlatformIncidentError(
      403,
      "PLATFORM_OPERATOR_REQUIRED",
      "Akses operator platform sudah dicabut.",
    );
  }

  if (updateChanges !== 1 || auditChanges !== 1) {
    throw new PlatformIncidentError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Catatan timeline atau audit insiden gagal tersimpan.",
    );
  }

  const created = await getIncidentById(platformDb, incidentId);
  if (!created) {
    throw new PlatformIncidentError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Insiden yang baru dideklarasikan tidak ditemukan setelah penyimpanan.",
    );
  }

  return { incident: created, audit: auditEntry };
}

/**
 * Updates an active platform incident atomically with optimistic concurrency
 * (`WHERE id = ? AND version = ?`) + `platform_incident_updates` + `platform_audit`.
 * A losing concurrent write leaves ZERO timeline or audit side effects and throws 409.
 */
export async function updateIncident(
  platformDb: D1Database,
  input: UpdateIncidentInput,
): Promise<PlatformIncidentMutationResult> {
  const actorUserId = input.actorUserId.trim();
  const cleanId = input.incidentId.trim();

  if (!actorUserId) {
    throw new PlatformIncidentError(
      403,
      "PLATFORM_OPERATOR_REQUIRED",
      "Operator platform aktif diperlukan untuk memperbarui insiden.",
    );
  }

  if (!isValidIncidentId(cleanId)) {
    throw new PlatformIncidentError(
      404,
      "INCIDENT_NOT_FOUND",
      "Insiden platform tidak ditemukan.",
    );
  }

  const actorGrant = await getActivePlatformOperator(platformDb, actorUserId);
  if (!actorGrant) {
    throw new PlatformIncidentError(
      403,
      "PLATFORM_OPERATOR_REQUIRED",
      "Akses operator platform aktif diperlukan untuk memperbarui insiden.",
    );
  }

  const validated = validateUpdateIncidentPayload(input.payload);
  const current = await getIncidentById(platformDb, cleanId);
  if (!current) {
    throw new PlatformIncidentError(
      404,
      "INCIDENT_NOT_FOUND",
      "Insiden platform tidak ditemukan.",
    );
  }

  if (current.status === "resolved") {
    throw new PlatformIncidentError(
      409,
      "INCIDENT_ALREADY_RESOLVED",
      "Insiden sudah diselesaikan dan tidak dapat diubah lagi.",
    );
  }

  if (current.version !== validated.expectedVersion) {
    throw new PlatformIncidentError(
      409,
      "VERSION_CONFLICT",
      `Versi insiden tidak cocok (diharapkan v${validated.expectedVersion}, saat ini v${current.version}). Muat ulang sebelum menyimpan.`,
    );
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const nextTitle = validated.title ?? current.title;
  const nextSummary = validated.summary ?? current.summary;
  const nextSeverity = validated.severity ?? current.severity;
  const nextStatus = validated.status ?? current.status;
  const nextComponents = validated.affectedComponents ?? current.affectedComponents;
  const resolving = nextStatus === "resolved";
  const nextBannerVisible = resolving
    ? false
    : (validated.bannerVisible ?? current.bannerVisible);
  const nextVersion = current.version + 1;
  const updateMessage =
    validated.updateMessage ??
    validated.summary ??
    (resolving
      ? "Insiden ditandai selesai dan layanan kembali normal."
      : `Status insiden diperbarui ke ${nextStatus}.`);
  const updateId = `incu_${generatePlatformAuditId(nowMs)}`;

  const updateIncidentStmt = platformDb
    .prepare(
      `UPDATE platform_incidents
       SET title = ?,
           summary = ?,
           severity = ?,
           status = ?,
           affected_components_json = ?,
           banner_visible = ?,
           resolved_by_user_id = CASE WHEN ? = 1 THEN ? ELSE resolved_by_user_id END,
           resolved_at = CASE WHEN ? = 1 THEN ? ELSE resolved_at END,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND version = ?
         AND status != 'resolved'
         AND EXISTS (
           SELECT 1 FROM platform_operators WHERE user_id = ? AND revoked_at IS NULL
         )`,
    )
    .bind(
      nextTitle,
      nextSummary,
      nextSeverity,
      nextStatus,
      JSON.stringify(nextComponents),
      nextBannerVisible ? 1 : 0,
      resolving ? 1 : 0,
      actorUserId,
      resolving ? 1 : 0,
      nowMs,
      nowMs,
      cleanId,
      validated.expectedVersion,
      actorUserId,
    );

  const insertUpdateStmt = platformDb
    .prepare(
      `INSERT INTO platform_incident_updates (
        id, incident_id, status, severity, message, actor_user_id, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE changes() = 1
        AND EXISTS (
          SELECT 1 FROM platform_incidents WHERE id = ? AND version = ?
        )`,
    )
    .bind(
      updateId,
      cleanId,
      nextStatus,
      nextSeverity,
      updateMessage,
      actorUserId,
      nowMs,
      cleanId,
      nextVersion,
    );

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: actorGrant.role,
      action: resolving ? "platform_incident.resolve" : "platform_incident.update",
      targetType: "platform_incident",
      targetId: cleanId,
      reason: validated.reason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        fromStatus: current.status,
        toStatus: nextStatus,
        fromSeverity: current.severity,
        toSeverity: nextSeverity,
        bannerVisible: nextBannerVisible,
        fromVersion: current.version,
        toVersion: nextVersion,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch([updateIncidentStmt, insertUpdateStmt, auditStmt]);
  } catch (err) {
    throw new PlatformIncidentError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Transaksi pembaruan insiden gagal dan dibatalkan sepenuhnya (audit wajib tersimpan).",
      [],
      err,
    );
  }

  const incidentChanges = results[0]?.meta?.changes ?? 0;
  const updateChanges = results[1]?.meta?.changes ?? 0;
  const auditChanges = results[2]?.meta?.changes ?? 0;

  if (incidentChanges !== 1) {
    const stillActive = await getActivePlatformOperator(platformDb, actorUserId);
    if (!stillActive) {
      throw new PlatformIncidentError(
        403,
        "PLATFORM_OPERATOR_REQUIRED",
        "Akses operator platform sudah dicabut.",
      );
    }
    const latest = await getIncidentById(platformDb, cleanId);
    if (!latest) {
      throw new PlatformIncidentError(
        404,
        "INCIDENT_NOT_FOUND",
        "Insiden platform tidak ditemukan.",
      );
    }
    if (latest.status === "resolved") {
      throw new PlatformIncidentError(
        409,
        "INCIDENT_ALREADY_RESOLVED",
        "Insiden sudah diselesaikan oleh operator lain.",
      );
    }
    throw new PlatformIncidentError(
      409,
      "VERSION_CONFLICT",
      "Insiden telah diperbarui oleh operator lain. Muat ulang sebelum menyimpan.",
    );
  }

  if (updateChanges !== 1 || auditChanges !== 1) {
    throw new PlatformIncidentError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Catatan timeline atau audit pembaruan insiden gagal tersimpan.",
    );
  }

  const updated = await getIncidentById(platformDb, cleanId);
  if (!updated) {
    throw new PlatformIncidentError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Insiden gagal dibaca ulang setelah pembaruan.",
    );
  }

  return { incident: updated, audit: auditEntry };
}

/**
 * Resolves an active platform incident in one audited operator action, immediately
 * hiding the dashboard banner (`banner_visible = 0`, `status = 'resolved'`) atomically
 * with `platform_incident_updates` and `platform_audit`.
 */
export async function resolveIncident(
  platformDb: D1Database,
  input: ResolveIncidentInput,
): Promise<PlatformIncidentMutationResult> {
  const validated = validateResolveIncidentPayload(input.payload);
  return updateIncident(platformDb, {
    actorUserId: input.actorUserId,
    incidentId: input.incidentId,
    payload: {
      expectedVersion: validated.expectedVersion,
      status: "resolved",
      bannerVisible: false,
      updateMessage: validated.resolutionNote,
      reason: validated.reason,
    },
    requestId: input.requestId,
    nowMs: input.nowMs,
  });
}

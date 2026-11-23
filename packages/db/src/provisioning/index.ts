import { RESERVED_HANDLES } from "@punyasitus/core";
import {
  ALLOWED_EMAIL_SENDER,
  DEFAULT_EMAIL_SENDER_NAME,
  renderEmailTemplate,
  type EmailPort,
} from "@punyasitus/core/email/index";
import { RESERVED_TENANT_HANDLES, TenantHandleSchema } from "@punyasitus/core/schemas";
import {
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "../connections/index.ts";
import {
  buildPlatformAuditStatement,
  generatePlatformAuditId,
  PlatformAuditError,
  validateOperatorReason,
  type PlatformAuditRecord,
} from "../platform/audit.ts";
import { TENANT_VERTICALS, type TenantStatus, type TenantVertical } from "../platform/schema.ts";
import { computeEffectiveTenantStatus, evictTenantFromCache } from "../routing/resolver.ts";
import { TENANT_MIGRATIONS } from "../tenant/migrations.ts";

/**
 * Atomic operator tenant provisioning and audited service-state transitions
 * (`packages/db/src/provisioning/index.ts`; TASK-026, REQ-035, REQ-005, REQ-034, REQ-065;
 * PLAN §4, §5, §13, §17).
 *
 * Hard invariants:
 * - Handle normalization, format validation (3-40 lowercase ASCII, alphanumeric ends),
 *   reserved-label rejection, quarantine check, and duplicate conflict (`409 HANDLE_TAKEN`).
 * - Atomic `PLATFORM_DB` bootstrap creates ONE `organizations` row + ONE `tenants` row +
 *   ONE primary `<handle>.situsku.click` `tenant_hosts` row + initial owner `members` row
 *   (or pending owner `invitations` row + hashed token in `verifications`) + `job_ledger`
 *   idempotency marker + mandatory `platform_audit` entry in ONE `D1Database.batch([...])`.
 * - Idempotent replay (same `idempotencyKey` with identical parameters) returns the existing
 *   provisioned tenant without creating duplicate records; mismatched replay throws `409 IDEMPOTENCY_CONFLICT`.
 * - If audit persistence fails, the entire batch rolls back with zero partial state.
 * - Service-state transitions commit atomically with `platform_audit`, enforce optimistic
 *   concurrency (`expectedVersion`), bump `cache_version`, evict isolate host cache immediately,
 *   and never grant free active time when releasing an operator hold (PLAN §13).
 */

export const TRIAL_DURATION_SECONDS = 7 * 24 * 60 * 60; // 604,800s (7 days; PLAN §17.1)
export const TRIAL_DURATION_MS = TRIAL_DURATION_SECONDS * 1000;
export const DEFAULT_INITIAL_OWNER_INVITE_TTL_MS = 48 * 60 * 60 * 1000; // 48h (PLAN §10)
export const TRIAL_STORAGE_QUOTA_BYTES = 104_857_600; // 100 MB (REQ-064)
export const PAID_STORAGE_QUOTA_BYTES = 1_073_741_824; // 1 GB (REQ-064)
export const DEFAULT_SAAS_ZONE = "situsku.click" as const;

const EXTRA_RESERVED_HANDLES = [
  "status",
  "support",
  "help",
  "billing",
  "docs",
  "cdn",
  "static",
  "media",
  "login",
  "logout",
  "signup",
  "register",
  "oauth",
  "oauth2",
  "root",
  "system",
  "punyasitus",
  "situsku",
] as const;

export const PROVISIONING_RESERVED_HANDLES: ReadonlySet<string> = new Set([
  ...RESERVED_HANDLES,
  ...RESERVED_TENANT_HANDLES,
  ...EXTRA_RESERVED_HANDLES,
]);

const SIMPLE_EMAIL_RE = /^[^\s@<>,;"'\\]+@[^\s@<>,;"'\\]+\.[^\s@<>,;"'\\]{2,}$/;
const SAFE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export type ProvisioningErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_HANDLE"
  | "RESERVED_HANDLE"
  | "HANDLE_TAKEN"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "INVALID_STATE_TRANSITION"
  | "AUDIT_PERSISTENCE_FAILED"
  | "TENANT_STORE_INIT_FAILED";

export class ProvisioningError extends Error {
  readonly status: 400 | 404 | 409 | 422 | 500 | 503;
  readonly code: ProvisioningErrorCode;

  constructor(
    status: 400 | 404 | 409 | 422 | 500 | 503,
    code: ProvisioningErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ProvisioningError";
    this.status = status;
    this.code = code;
  }
}

export interface ProvisionTenantInput {
  readonly actorUserId: string;
  readonly handle: string;
  readonly name: string;
  readonly ownerEmail: string;
  readonly vertical?: TenantVertical;
  readonly initialStatus?: "trial" | "active";
  readonly paidThroughMs?: number | null;
  readonly trialEndsAtMs?: number | null;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly requestId?: string | null;
  readonly saasZone?: string;
  readonly appBaseUrl?: string;
  readonly emailPort?: EmailPort | null;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly nowMs?: number;
}

export interface ProvisionedTenantSummary {
  readonly id: string;
  readonly organizationId: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: TenantVertical;
  readonly status: TenantStatus;
  readonly effectiveStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly operatorHoldReason: string | null;
  readonly primaryHost: string;
  readonly ownerEmail: string | null;
  readonly ownerMemberId: string | null;
  readonly ownerInvitationId: string | null;
  readonly trialEndsAt: number | null;
  readonly paidThrough: number | null;
  readonly deletionDueAt: number | null;
  readonly cacheVersion: number;
  readonly schemaVersion: number;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InitialInvitationDeliveryStatus = "sent" | "failed" | "skipped";

export interface ProvisionTenantResult {
  readonly tenant: ProvisionedTenantSummary;
  readonly replayed: boolean;
  readonly tenantStoreInitialized: boolean;
  readonly ownerAssignment:
    | { readonly kind: "member"; readonly memberId: string; readonly userId: string }
    | {
        readonly kind: "invitation";
        readonly invitationId: string;
        readonly email: string;
        readonly expiresAtMs: number;
        readonly invitationDeliveryStatus: InitialInvitationDeliveryStatus;
        /** Returned ONLY on initial creation (never stored in plaintext or returned on replay). */
        readonly invitationToken: string | null;
      };
  readonly audit: PlatformAuditRecord | null;
}

export type ServiceStateTransitionAction =
  | "suspend_hold"
  | "release_hold"
  | "enter_recovery"
  | "exit_recovery"
  | "set_status";

export interface TransitionTenantServiceStateInput {
  readonly actorUserId: string;
  readonly tenantId?: string;
  readonly handle?: string;
  readonly action: ServiceStateTransitionAction;
  /** Required only when `action === "set_status"`. */
  readonly targetStatus?: "trial" | "active" | "grace" | "locked" | "suspended" | "recovery";
  readonly operatorHold?: boolean;
  /** Explicit deadline required when `action === "set_status"` targets `"active"`. */
  readonly paidThroughMs?: number | null;
  /** Explicit deadline required when `action === "set_status"` targets `"trial"`. */
  readonly trialEndsAtMs?: number | null;
  readonly reason: string;
  /** Strictly required positive integer for optimistic concurrency (PLAN §13). */
  readonly expectedVersion: number;
  readonly idempotencyKey?: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface TransitionTenantServiceStateResult {
  readonly tenant: ProvisionedTenantSummary;
  readonly previousStatus: TenantStatus;
  readonly previousOperatorHold: boolean;
  readonly replayed: boolean;
  readonly audit: PlatformAuditRecord | null;
}

interface ExistingTenantJoinRow {
  readonly id: string;
  readonly organization_id: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: TenantVertical;
  readonly status: TenantStatus;
  readonly operator_hold: number;
  readonly operator_hold_reason: string | null;
  readonly trial_ends_at: number | null;
  readonly paid_through: number | null;
  readonly deletion_due_at: number | null;
  readonly cache_version: number;
  readonly schema_version: number;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly primary_host: string | null;
  readonly owner_member_id: string | null;
  readonly owner_user_id: string | null;
  readonly owner_user_email: string | null;
  readonly owner_invitation_id: string | null;
  readonly owner_invitation_email: string | null;
  readonly owner_invitation_expires_at: number | null;
}

interface JobLedgerRow {
  readonly idempotency_key: string;
  readonly tenant_id: string | null;
  readonly status: string;
  readonly payload_json: string | null;
}

function generateSecureHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < buf.length; i += 1) {
    out += (buf[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

function normalizeEmail(raw: string): string {
  const clean = raw.trim().toLowerCase();
  if (!clean || clean.length > 254 || /[\r\n\0]/.test(clean) || !SIMPLE_EMAIL_RE.test(clean)) {
    throw new ProvisioningError(422, "VALIDATION_ERROR", "Format alamat email pemilik tidak valid.");
  }
  return clean;
}

function normalizeIdempotencyKey(raw: string): string {
  const clean = raw.trim();
  if (!SAFE_IDEMPOTENCY_KEY_RE.test(clean)) {
    throw new ProvisioningError(
      422,
      "VALIDATION_ERROR",
      "Idempotency-Key wajib berupa 8-128 karakter alfanumerik aman (UUID atau token operasi).",
    );
  }
  return clean;
}

function normalizeTenantName(raw: string): string {
  const clean = raw.replace(/[\r\n\t\0]+/g, " ").trim();
  if (clean.length < 2 || clean.length > 160) {
    throw new ProvisioningError(
      422,
      "VALIDATION_ERROR",
      "Nama bisnis/situs harus terdiri dari 2 hingga 160 karakter.",
    );
  }
  return clean;
}

function normalizeVertical(raw?: TenantVertical): TenantVertical {
  if (!raw) return "compro";
  if (!TENANT_VERTICALS.includes(raw)) {
    throw new ProvisioningError(
      422,
      "VALIDATION_ERROR",
      `Vertikal "${String(raw)}" tidak didukung.`,
    );
  }
  return raw;
}

function normalizeValidatedReason(rawReason: string): string {
  try {
    return validateOperatorReason(rawReason);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new ProvisioningError(422, "VALIDATION_ERROR", err.message, err);
    }
    throw err;
  }
}

/**
 * Normalizes and strictly validates a tenant handle against format and platform reservation rules
 * (PLAN §17.2; REQ-035).
 */
export function normalizeAndValidateTenantHandle(rawHandle: string): string {
  if (typeof rawHandle !== "string") {
    throw new ProvisioningError(422, "INVALID_HANDLE", "Handle tenant wajib diisi.");
  }
  const normalized = rawHandle.trim().toLowerCase();
  if (!normalized || normalized.length < 3 || normalized.length > 40) {
    throw new ProvisioningError(
      422,
      "INVALID_HANDLE",
      "Handle tenant harus terdiri dari 3 hingga 40 karakter huruf kecil, angka, atau tanda hubung.",
    );
  }
  if (PROVISIONING_RESERVED_HANDLES.has(normalized)) {
    throw new ProvisioningError(
      422,
      "RESERVED_HANDLE",
      `Handle "${normalized}" dicadangkan oleh platform dan tidak dapat digunakan.`,
    );
  }
  const parsed = TenantHandleSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new ProvisioningError(
      422,
      "INVALID_HANDLE",
      "Handle tenant hanya boleh berisi huruf kecil a-z, angka 0-9, dan tanda hubung di tengah (3-40 karakter).",
    );
  }
  return parsed.data;
}

function mapTenantRow(
  row: ExistingTenantJoinRow,
  nowMs: number,
  saasZone: string = DEFAULT_SAAS_ZONE,
): ProvisionedTenantSummary {
  const operatorHold = row.operator_hold === 1;
  const effectiveStatus = computeEffectiveTenantStatus(
    {
      storedStatus: row.status,
      operatorHold,
      trialEndsAt: row.trial_ends_at,
      paidThrough: row.paid_through,
    },
    nowMs,
  );
  return {
    id: row.id,
    organizationId: row.organization_id,
    handle: row.handle,
    name: row.name,
    vertical: row.vertical,
    status: row.status,
    effectiveStatus,
    operatorHold,
    operatorHoldReason: row.operator_hold_reason,
    primaryHost: row.primary_host ?? `${row.handle}.${saasZone}`,
    ownerEmail: row.owner_user_email ?? row.owner_invitation_email ?? null,
    ownerMemberId: row.owner_member_id,
    ownerInvitationId: row.owner_invitation_id,
    trialEndsAt: row.trial_ends_at,
    paidThrough: row.paid_through,
    deletionDueAt: row.deletion_due_at,
    cacheVersion: row.cache_version,
    schemaVersion: row.schema_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TENANT_DETAIL_SELECT_SQL = `
SELECT
  t.id,
  t.organization_id,
  t.handle,
  t.name,
  t.vertical,
  t.status,
  t.operator_hold,
  t.operator_hold_reason,
  t.trial_ends_at,
  t.paid_through,
  t.deletion_due_at,
  t.cache_version,
  t.schema_version,
  t.version,
  t.created_at,
  t.updated_at,
  (
    SELECT th.host FROM tenant_hosts th
    WHERE th.tenant_id = t.id AND th.is_primary = 1
    LIMIT 1
  ) AS primary_host,
  (
    SELECT m.id FROM members m
    WHERE m.organization_id = t.organization_id AND m.role = 'owner'
    ORDER BY m.created_at ASC
    LIMIT 1
  ) AS owner_member_id,
  (
    SELECT m.user_id FROM members m
    WHERE m.organization_id = t.organization_id AND m.role = 'owner'
    ORDER BY m.created_at ASC
    LIMIT 1
  ) AS owner_user_id,
  (
    SELECT u.email FROM members m
    INNER JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = t.organization_id AND m.role = 'owner'
    ORDER BY m.created_at ASC
    LIMIT 1
  ) AS owner_user_email,
  (
    SELECT i.id FROM invitations i
    WHERE i.organization_id = t.organization_id AND i.role = 'owner' AND i.status = 'pending'
    ORDER BY i.created_at DESC
    LIMIT 1
  ) AS owner_invitation_id,
  (
    SELECT i.email FROM invitations i
    WHERE i.organization_id = t.organization_id AND i.role = 'owner' AND i.status = 'pending'
    ORDER BY i.created_at DESC
    LIMIT 1
  ) AS owner_invitation_email,
  (
    SELECT i.expires_at FROM invitations i
    WHERE i.organization_id = t.organization_id AND i.role = 'owner' AND i.status = 'pending'
    ORDER BY i.created_at DESC
    LIMIT 1
  ) AS owner_invitation_expires_at
FROM tenants t
`.trim();

async function loadTenantJoinRow(
  platformDb: D1Database,
  selector: { readonly tenantId?: string; readonly handle?: string },
): Promise<ExistingTenantJoinRow | null> {
  const tenantId = selector.tenantId?.trim();
  const handle = selector.handle?.trim().toLowerCase();
  if (tenantId) {
    const row = await platformDb
      .prepare(`${TENANT_DETAIL_SELECT_SQL} WHERE t.id = ? LIMIT 1`)
      .bind(tenantId)
      .first<ExistingTenantJoinRow>();
    return row ?? null;
  }
  if (handle) {
    const row = await platformDb
      .prepare(`${TENANT_DETAIL_SELECT_SQL} WHERE t.handle = ? LIMIT 1`)
      .bind(handle)
      .first<ExistingTenantJoinRow>();
    return row ?? null;
  }
  return null;
}

/**
 * Fetches a narrow control-plane tenant detail summary from `PLATFORM_DB`
 * (never opens `TenantStore` content or leads).
 */
export async function getProvisionedTenantDetail(
  platformDb: D1Database,
  selector: { readonly tenantId?: string; readonly handle?: string },
  options: { readonly nowMs?: number; readonly saasZone?: string } = {},
): Promise<ProvisionedTenantSummary | null> {
  const row = await loadTenantJoinRow(platformDb, selector);
  if (!row) return null;
  return mapTenantRow(row, options.nowMs ?? Date.now(), options.saasZone ?? DEFAULT_SAAS_ZONE);
}

/**
 * Lists control-plane tenants from `PLATFORM_DB` for Console Operational views.
 */
export async function listProvisionedTenants(
  platformDb: D1Database,
  options: {
    readonly search?: string;
    readonly status?: TenantStatus;
    readonly limit?: number;
    readonly nowMs?: number;
    readonly saasZone?: string;
  } = {},
): Promise<readonly ProvisionedTenantSummary[]> {
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];

  const search = options.search?.trim().toLowerCase();
  if (search) {
    clauses.push("(lower(t.handle) LIKE ? OR lower(t.name) LIKE ? OR t.id = ?)");
    const like = `%${search}%`;
    bindings.push(like, like, options.search?.trim() ?? "");
  }
  if (options.status) {
    clauses.push("t.status = ?");
    bindings.push(options.status);
  }

  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `
    ${TENANT_DETAIL_SELECT_SQL}
    ${whereSql}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ?
  `;

  const result = await platformDb
    .prepare(sql)
    .bind(...bindings, limit)
    .all<ExistingTenantJoinRow>();

  const nowMs = options.nowMs ?? Date.now();
  const saasZone = options.saasZone ?? DEFAULT_SAAS_ZONE;
  return (result.results ?? []).map((row) => mapTenantRow(row, nowMs, saasZone));
}

/**
 * Initializes `TenantStore` schema (`0001_initial_tenant`) and idempotent default singleton rows
 * (`site_settings`, `business_profile`, `storage_usage`, `menus`, `installed_plugins`) for a
 * newly provisioned tenant. Safe to call on retries (`INSERT OR IGNORE`).
 */
export async function initializeTenantStoreDefaults(
  platformDb: D1Database,
  tenantStore: TenantStoreNamespaceLike,
  params: {
    readonly tenantId: string;
    readonly name: string;
    readonly vertical: TenantVertical;
    readonly initialStatus: "trial" | "active";
    readonly nowMs: number;
  },
): Promise<{ readonly schemaVersion: number }> {
  const stub = openTenantStoreStub(tenantStore, params.tenantId);
  const migration = await orchestrateTenantMigration(
    platformDb,
    stub,
    params.tenantId,
    TENANT_MIGRATIONS,
    { now: () => params.nowMs },
  );
  if (migration.outcome === "recovery") {
    throw new ProvisioningError(
      503,
      "TENANT_STORE_INIT_FAILED",
      `Gagal menginisialisasi penyimpanan tenant: ${migration.error ?? "masuk mode pemulihan"}`,
    );
  }

  const tenantDb = createTenantDb(stub);
  const quotaBytes =
    params.initialStatus === "active" ? PAID_STORAGE_QUOTA_BYTES : TRIAL_STORAGE_QUOTA_BYTES;

  await tenantDb.batch([
    tenantDb
      .prepare(
        `INSERT OR IGNORE INTO site_settings (
          id, site_title, timezone, locale, active_theme_id,
          blog_enabled, catalog_enabled, ai_training_policy, version, updated_at
        ) VALUES (1, ?, 'Asia/Jakarta', 'id-ID', ?, 1, 1, 'allow', 1, ?)`,
      )
      .bind(params.name, params.vertical, params.nowMs),
    tenantDb
      .prepare(
        `INSERT OR IGNORE INTO business_profile (
          id, business_name, business_category, version, updated_at
        ) VALUES (1, ?, 'LocalBusiness', 1, ?)`,
      )
      .bind(params.name, params.nowMs),
    tenantDb
      .prepare(
        `INSERT OR IGNORE INTO storage_usage (
          id, used_bytes, quota_bytes, hourly_uploads, hourly_window_start,
          daily_uploads, daily_window_start, updated_at
        ) VALUES (1, 0, ?, 0, ?, 0, ?, ?)`,
      )
      .bind(quotaBytes, params.nowMs, params.nowMs, params.nowMs),
    tenantDb
      .prepare(
        `INSERT OR IGNORE INTO menus (id, location, items_json, version, created_at, updated_at)
         VALUES (1, 'header', '[]', 1, ?, ?)`,
      )
      .bind(params.nowMs, params.nowMs),
    tenantDb
      .prepare(
        `INSERT OR IGNORE INTO menus (id, location, items_json, version, created_at, updated_at)
         VALUES (2, 'footer', '[]', 1, ?, ?)`,
      )
      .bind(params.nowMs, params.nowMs),
    tenantDb
      .prepare(
        `INSERT OR IGNORE INTO installed_plugins (
          plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at
        ) VALUES ('seo-ai-autopilot', '1.0.0', 1, '{}', 1, ?, ?)`,
      )
      .bind(params.nowMs, params.nowMs),
  ]);

  return { schemaVersion: migration.schemaVersion };
}

function buildReplayResult(
  row: ExistingTenantJoinRow,
  nowMs: number,
  saasZone: string,
): ProvisionTenantResult {
  const tenant = mapTenantRow(row, nowMs, saasZone);
  const ownerAssignment: ProvisionTenantResult["ownerAssignment"] =
    row.owner_member_id && row.owner_user_id
      ? {
          kind: "member",
          memberId: row.owner_member_id,
          userId: row.owner_user_id,
        }
      : {
          kind: "invitation",
          invitationId: row.owner_invitation_id ?? "",
          email: row.owner_invitation_email ?? "",
          expiresAtMs: row.owner_invitation_expires_at ?? nowMs,
          invitationDeliveryStatus: "skipped",
          invitationToken: null,
        };

  return {
    tenant,
    replayed: true,
    tenantStoreInitialized: row.schema_version > 0,
    ownerAssignment,
    audit: null,
  };
}

/**
 * Atomically provisions ONE organization, ONE tenant, ONE primary `<handle>.situsku.click`
 * `tenant_hosts` row, initial owner membership (or 48h pending owner invitation), idempotency
 * ledger record, and mandatory `platform_audit` entry in a single D1 transaction batch.
 *
 * Replaying the same `idempotencyKey` with matching parameters returns the existing tenant
 * (`replayed: true`) without duplicating any rows.
 */
export async function provisionTenantAtomically(
  platformDb: D1Database,
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId) {
    throw new ProvisioningError(422, "VALIDATION_ERROR", "actorUserId wajib diisi.");
  }

  const handle = normalizeAndValidateTenantHandle(input.handle);
  const name = normalizeTenantName(input.name);
  const ownerEmail = normalizeEmail(input.ownerEmail);
  const vertical = normalizeVertical(input.vertical);
  const initialStatus = input.initialStatus ?? "trial";
  if (initialStatus !== "trial" && initialStatus !== "active") {
    throw new ProvisioningError(
      422,
      "VALIDATION_ERROR",
      'Status awal provisioning hanya boleh "trial" atau "active".',
    );
  }

  const cleanReason = normalizeValidatedReason(input.reason);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const saasZone = (input.saasZone ?? DEFAULT_SAAS_ZONE).trim().toLowerCase();
  const primaryHost = `${handle}.${saasZone}`;
  const ledgerKey = `provision:${idempotencyKey}`;

  const expectedPayload = {
    handle,
    ownerEmail,
    vertical,
    initialStatus,
  };

  // 1. Check idempotent replay before touching any tables
  const existingLedger = await platformDb
    .prepare(
      "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
    )
    .bind(ledgerKey)
    .first<JobLedgerRow>();

  if (existingLedger && existingLedger.tenant_id) {
    const storedPayload = existingLedger.payload_json
      ? (JSON.parse(existingLedger.payload_json) as Partial<typeof expectedPayload>)
      : null;
    if (
      storedPayload &&
      (storedPayload.handle !== handle ||
        storedPayload.ownerEmail !== ownerEmail ||
        storedPayload.vertical !== vertical ||
        storedPayload.initialStatus !== initialStatus)
    ) {
      throw new ProvisioningError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk parameter tenant yang berbeda.",
      );
    }

    const existingRow = await loadTenantJoinRow(platformDb, { tenantId: existingLedger.tenant_id });
    if (existingRow) {
      let tenantStoreInitialized = existingRow.schema_version > 0;
      if (input.tenantStore && !tenantStoreInitialized) {
        await initializeTenantStoreDefaults(platformDb, input.tenantStore, {
          tenantId: existingRow.id,
          name: existingRow.name,
          vertical: existingRow.vertical,
          initialStatus,
          nowMs,
        });
        tenantStoreInitialized = true;
      }
      const refreshed =
        (await loadTenantJoinRow(platformDb, { tenantId: existingRow.id })) ?? existingRow;
      return {
        ...buildReplayResult(refreshed, nowMs, saasZone),
        tenantStoreInitialized,
      };
    }
  }

  // 2. Check handle availability & quarantine tombstone
  const existingByHandle = await platformDb
    .prepare("SELECT id FROM tenants WHERE handle = ? LIMIT 1")
    .bind(handle)
    .first<{ readonly id: string }>();
  if (existingByHandle) {
    throw new ProvisioningError(
      409,
      "HANDLE_TAKEN",
      `Handle "${handle}" sudah digunakan oleh tenant lain.`,
    );
  }

  const quarantined = await platformDb
    .prepare(
      "SELECT id FROM deletion_tombstones WHERE handle = ? AND quarantine_until > ? LIMIT 1",
    )
    .bind(handle, nowMs)
    .first<{ readonly id: string }>();
  if (quarantined) {
    throw new ProvisioningError(
      409,
      "HANDLE_TAKEN",
      `Handle "${handle}" sedang dalam masa karantina 30 hari pasca-penghapusan.`,
    );
  }

  // 3. Determine whether owner email already belongs to a VERIFIED registered user
  //    (unverified existing accounts MUST receive a 48h owner invitation instead of silent assignment).
  const existingOwnerUser = await platformDb
    .prepare("SELECT id, email, email_verified FROM users WHERE lower(email) = ? LIMIT 1")
    .bind(ownerEmail)
    .first<{ readonly id: string; readonly email: string; readonly email_verified: number }>();
  const verifiedExistingOwner =
    existingOwnerUser && existingOwnerUser.email_verified === 1 ? existingOwnerUser : null;

  const tenantId = generatePlatformAuditId(nowMs);
  const organizationId = generatePlatformAuditId(nowMs + 1);
  const trialEndsAtMs =
    initialStatus === "trial" ? Math.trunc(input.trialEndsAtMs ?? nowMs + TRIAL_DURATION_MS) : null;
  const paidThroughMs =
    initialStatus === "active"
      ? Math.trunc(input.paidThroughMs ?? nowMs + 30 * 24 * 60 * 60 * 1000)
      : null;

  const statements: D1PreparedStatement[] = [
    platformDb
      .prepare(
        `INSERT INTO job_ledger (
          idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
        ) VALUES (?, 'tenant.provision', ?, 'completed', 1, ?, ?, ?)`,
      )
      .bind(ledgerKey, tenantId, JSON.stringify(expectedPayload), nowMs, nowMs),
    platformDb
      .prepare(
        `INSERT INTO organizations (id, name, slug, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        organizationId,
        name,
        handle,
        JSON.stringify({ tenantId, provisionedBy: actorUserId }),
        nowMs,
        nowMs,
      ),
    platformDb
      .prepare(
        `INSERT INTO tenants (
          id, organization_id, handle, name, vertical, status,
          operator_hold, operator_hold_reason, trial_ends_at, paid_through,
          cache_version, schema_version, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, 1, 0, 1, ?, ?)`,
      )
      .bind(
        tenantId,
        organizationId,
        handle,
        name,
        vertical,
        initialStatus,
        trialEndsAtMs,
        paidThroughMs,
        nowMs,
        nowMs,
      ),
    platformDb
      .prepare(
        `INSERT INTO tenant_hosts (
          host, tenant_id, kind, status, ssl_status, is_primary,
          verified_at, version, created_at, updated_at
        ) VALUES (?, ?, 'subdomain', 'active', 'active', 1, ?, 1, ?, ?)`,
      )
      .bind(primaryHost, tenantId, nowMs, nowMs, nowMs),
  ];

  let ownerAssignment: ProvisionTenantResult["ownerAssignment"];

  if (verifiedExistingOwner) {
    const memberId = generatePlatformAuditId(nowMs + 2);
    statements.push(
      platformDb
        .prepare(
          `INSERT INTO members (id, organization_id, user_id, role, created_at)
           VALUES (?, ?, ?, 'owner', ?)`,
        )
        .bind(memberId, organizationId, verifiedExistingOwner.id, nowMs),
    );
    ownerAssignment = {
      kind: "member",
      memberId,
      userId: verifiedExistingOwner.id,
    };
  } else {
    const invitationId = generatePlatformAuditId(nowMs + 2);
    const expiresAtMs = nowMs + DEFAULT_INITIAL_OWNER_INVITE_TTL_MS;
    const rawToken = generateSecureHex(32);
    const tokenHash = await sha256Hex(rawToken);
    statements.push(
      platformDb
        .prepare(
          `INSERT INTO invitations (
            id, organization_id, email, role, status, expires_at, inviter_id, created_at
          ) VALUES (?, ?, ?, 'owner', 'pending', ?, ?, ?)`,
        )
        .bind(invitationId, organizationId, ownerEmail, expiresAtMs, actorUserId, nowMs),
      platformDb
        .prepare(
          `INSERT INTO verifications (
            id, identifier, value, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `invtok_${invitationId}`,
          `member-invite:${tokenHash}`,
          JSON.stringify({
            invitationId,
            organizationId,
            tenantId,
            email: ownerEmail,
            role: "owner",
          }),
          expiresAtMs,
          nowMs,
          nowMs,
        ),
    );
    ownerAssignment = {
      kind: "invitation",
      invitationId,
      email: ownerEmail,
      expiresAtMs,
      invitationDeliveryStatus: "skipped",
      invitationToken: rawToken,
    };
  }

  // Mandatory atomic audit entry — if this fails, D1 rolls back the entire batch!
  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(platformDb, {
    actorUserId,
    actorRole: "platform_operator",
    action: "tenant.provision",
    targetType: "tenant",
    targetId: tenantId,
    tenantId,
    reason: cleanReason,
    requireReason: true,
    outcome: "success",
    requestId: input.requestId ?? null,
    metadata: {
      handle,
      vertical,
      initialStatus,
      primaryHost,
      ownerAssignmentKind: ownerAssignment.kind,
      idempotencyKey,
    },
    createdAtMs: nowMs,
  });
  statements.push(auditStmt);

  try {
    await platformDb.batch(statements);
  } catch (err) {
    // Re-check for concurrent idempotency race first
    const raceLedger = await platformDb
      .prepare(
        "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
      )
      .bind(ledgerKey)
      .first<JobLedgerRow>();
    if (raceLedger && raceLedger.tenant_id) {
      const storedPayload = raceLedger.payload_json
        ? (JSON.parse(raceLedger.payload_json) as Partial<typeof expectedPayload>)
        : null;
      if (
        storedPayload &&
        (storedPayload.handle !== handle ||
          storedPayload.ownerEmail !== ownerEmail ||
          storedPayload.vertical !== vertical ||
          storedPayload.initialStatus !== initialStatus)
      ) {
        throw new ProvisioningError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key ini sudah digunakan untuk parameter tenant yang berbeda.",
          err,
        );
      }
      const existingRow = await loadTenantJoinRow(platformDb, { tenantId: raceLedger.tenant_id });
      if (existingRow) {
        return buildReplayResult(existingRow, nowMs, saasZone);
      }
    }

    // Re-check for concurrent duplicate handle race
    const raceHandle = await platformDb
      .prepare("SELECT id FROM tenants WHERE handle = ? LIMIT 1")
      .bind(handle)
      .first<{ readonly id: string }>();
    if (raceHandle) {
      throw new ProvisioningError(
        409,
        "HANDLE_TAKEN",
        `Handle "${handle}" sudah digunakan oleh tenant lain.`,
        err,
      );
    }

    throw new ProvisioningError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Transaksi provisioning tenant dibatalkan karena gagal menyimpan catatan atomik atau audit.",
      err,
    );
  }

  let tenantStoreInitialized = false;
  if (input.tenantStore) {
    await initializeTenantStoreDefaults(platformDb, input.tenantStore, {
      tenantId,
      name,
      vertical,
      initialStatus,
      nowMs,
    });
    tenantStoreInitialized = true;
  }

  // Dispatch initial-owner invitation email via EmailPort (non-fatal if mail fails; raw token is never audited)
  if (ownerAssignment.kind === "invitation" && ownerAssignment.invitationToken) {
    let deliveryStatus: InitialInvitationDeliveryStatus = "skipped";
    if (input.emailPort) {
      try {
        const appBase = (input.appBaseUrl ?? "https://app.punyasitus.com").replace(/\/+$/, "");
        const acceptUrl = `${appBase}/dashboard/${encodeURIComponent(handle)}/settings/members/accept?inviteToken=${encodeURIComponent(ownerAssignment.invitationToken)}`;
        const rendered = renderEmailTemplate("member-invitation", {
          inviterName: "Tim Operasional PunyaSitus",
          organizationName: name,
          roleLabel: "Pemilik Situs (Owner)",
          acceptUrl,
          expiresInHours: Math.round(DEFAULT_INITIAL_OWNER_INVITE_TTL_MS / 3_600_000),
        });
        const sendRes = await input.emailPort.send({
          messageKey: `owner-invite:${ownerAssignment.invitationId}`,
          template: "member-invitation",
          from: ALLOWED_EMAIL_SENDER,
          fromName: DEFAULT_EMAIL_SENDER_NAME,
          to: ownerAssignment.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          oneShot: true,
        });
        deliveryStatus = sendRes.outcome === "submitted" ? "sent" : "failed";
      } catch {
        deliveryStatus = "failed";
      }
    }
    ownerAssignment = {
      ...ownerAssignment,
      invitationDeliveryStatus: deliveryStatus,
    };
  }

  const createdRow = await loadTenantJoinRow(platformDb, { tenantId });
  if (!createdRow) {
    throw new ProvisioningError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Tenant tidak dapat diverifikasi setelah transaksi provisioning selesai.",
    );
  }

  return {
    tenant: mapTenantRow(createdRow, nowMs, saasZone),
    replayed: false,
    tenantStoreInitialized,
    ownerAssignment,
    audit: auditEntry,
  };
}

/**
 * Computes the next persisted `status`, `operator_hold`, `operator_hold_reason`, and
 * `retention_paused_at` for an operator service-state transition per PLAN §13 & §17.
 */
export function resolveNextServiceState(
  current: {
    readonly status: TenantStatus;
    readonly operatorHold: boolean;
    readonly operatorHoldReason: string | null;
    readonly trialEndsAt: number | null;
    readonly paidThrough: number | null;
  },
  input: {
    readonly action: ServiceStateTransitionAction;
    readonly targetStatus?: "trial" | "active" | "grace" | "locked" | "suspended" | "recovery";
    readonly operatorHold?: boolean;
    readonly paidThroughMs?: number | null;
    readonly trialEndsAtMs?: number | null;
    readonly cleanReason: string;
    readonly nowMs: number;
  },
): {
  readonly nextStatus: TenantStatus;
  readonly nextOperatorHold: boolean;
  readonly nextOperatorHoldReason: string | null;
  readonly nextPaidThrough: number | null;
  readonly nextTrialEndsAt: number | null;
  readonly pauseRetention: boolean;
  readonly clearRetentionPause: boolean;
} {
  if (current.status === "purging" || current.status === "purged") {
    throw new ProvisioningError(
      409,
      "INVALID_STATE_TRANSITION",
      `Tenant dengan status "${current.status}" tidak dapat diubah lagi.`,
    );
  }

  switch (input.action) {
    case "suspend_hold":
      return {
        nextStatus: "suspended",
        nextOperatorHold: true,
        nextOperatorHoldReason: input.cleanReason,
        nextPaidThrough: current.paidThrough,
        nextTrialEndsAt: current.trialEndsAt,
        pauseRetention: true,
        clearRetentionPause: false,
      };

    case "release_hold": {
      // PLAN §13: Releasing a hold recomputes entitlement state; NEVER grants free active time.
      const recomputed = computeEffectiveTenantStatus(
        {
          storedStatus:
            current.paidThrough !== null
              ? "active"
              : current.trialEndsAt !== null
                ? "trial"
                : "suspended",
          operatorHold: false,
          trialEndsAt: current.trialEndsAt,
          paidThrough: current.paidThrough,
        },
        input.nowMs,
      );
      return {
        nextStatus: recomputed,
        nextOperatorHold: false,
        nextOperatorHoldReason: null,
        nextPaidThrough: current.paidThrough,
        nextTrialEndsAt: current.trialEndsAt,
        pauseRetention: false,
        clearRetentionPause: true,
      };
    }

    case "enter_recovery":
      return {
        nextStatus: "recovery",
        nextOperatorHold: current.operatorHold,
        nextOperatorHoldReason: current.operatorHoldReason,
        nextPaidThrough: current.paidThrough,
        nextTrialEndsAt: current.trialEndsAt,
        pauseRetention: false,
        clearRetentionPause: false,
      };

    case "exit_recovery": {
      const recomputed = computeEffectiveTenantStatus(
        {
          storedStatus:
            current.paidThrough !== null
              ? "active"
              : current.trialEndsAt !== null
                ? "trial"
                : "suspended",
          operatorHold: current.operatorHold,
          trialEndsAt: current.trialEndsAt,
          paidThrough: current.paidThrough,
        },
        input.nowMs,
      );
      return {
        nextStatus: recomputed,
        nextOperatorHold: current.operatorHold,
        nextOperatorHoldReason: current.operatorHoldReason,
        nextPaidThrough: current.paidThrough,
        nextTrialEndsAt: current.trialEndsAt,
        pauseRetention: false,
        clearRetentionPause: false,
      };
    }

    case "set_status": {
      if (!input.targetStatus) {
        throw new ProvisioningError(
          422,
          "VALIDATION_ERROR",
          'targetStatus wajib diisi ketika action bernilai "set_status".',
        );
      }

      const candidatePaidThrough =
        input.paidThroughMs !== undefined ? input.paidThroughMs : current.paidThrough;
      const candidateTrialEndsAt =
        input.trialEndsAtMs !== undefined ? input.trialEndsAtMs : current.trialEndsAt;

      if (input.targetStatus === "active") {
        if (
          typeof candidatePaidThrough !== "number" ||
          !Number.isSafeInteger(candidatePaidThrough) ||
          candidatePaidThrough <= input.nowMs
        ) {
          throw new ProvisioningError(
            422,
            "VALIDATION_ERROR",
            'Transisi set_status ke "active" wajib menyertakan paidThroughMs masa depan yang valid (tanpa akses gratis tak terbatas).',
          );
        }
      }

      if (input.targetStatus === "trial") {
        if (
          typeof candidateTrialEndsAt !== "number" ||
          !Number.isSafeInteger(candidateTrialEndsAt) ||
          candidateTrialEndsAt <= input.nowMs
        ) {
          throw new ProvisioningError(
            422,
            "VALIDATION_ERROR",
            'Transisi set_status ke "trial" wajib menyertakan trialEndsAtMs masa depan yang valid.',
          );
        }
      }

      const nextHold =
        input.operatorHold !== undefined
          ? input.operatorHold
          : input.targetStatus === "suspended"
            ? current.operatorHold
            : false;
      return {
        nextStatus: input.targetStatus,
        nextOperatorHold: nextHold,
        nextOperatorHoldReason: nextHold ? input.cleanReason : null,
        nextPaidThrough: candidatePaidThrough,
        nextTrialEndsAt: candidateTrialEndsAt,
        pauseRetention: nextHold,
        clearRetentionPause: !nextHold && current.operatorHold,
      };
    }
  }
}

/**
 * Executes an audited operator tenant service-state transition inside a SINGLE atomic
 * `D1Database.batch([...])`. Fails safely (rolling back the tenant update) if audit persistence
 * fails, bumps `cache_version`, and immediately evicts the isolate host resolution cache.
 */
export async function transitionTenantServiceState(
  platformDb: D1Database,
  input: TransitionTenantServiceStateInput,
): Promise<TransitionTenantServiceStateResult> {
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId) {
    throw new ProvisioningError(422, "VALIDATION_ERROR", "actorUserId wajib diisi.");
  }

  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    throw new ProvisioningError(
      422,
      "VALIDATION_ERROR",
      "expectedVersion wajib diisi berupa bilangan bulat positif.",
    );
  }
  const expectedVersion = input.expectedVersion;

  const cleanReason = normalizeValidatedReason(input.reason);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const normalizedIdemp = input.idempotencyKey
    ? normalizeIdempotencyKey(input.idempotencyKey)
    : null;
  const ledgerKey = normalizedIdemp ? `state-transition:${normalizedIdemp}` : null;

  const currentRow = await loadTenantJoinRow(platformDb, {
    tenantId: input.tenantId,
    handle: input.handle,
  });
  if (!currentRow) {
    throw new ProvisioningError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }

  if (ledgerKey) {
    const existingLedger = await platformDb
      .prepare(
        "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
      )
      .bind(ledgerKey)
      .first<JobLedgerRow>();
    if (existingLedger && existingLedger.tenant_id) {
      if (existingLedger.tenant_id !== currentRow.id) {
        throw new ProvisioningError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key ini sudah digunakan untuk tenant yang berbeda.",
        );
      }
      const stored = existingLedger.payload_json
        ? (JSON.parse(existingLedger.payload_json) as {
            readonly tenantId?: string;
            readonly action?: string;
            readonly targetStatus?: string | null;
            readonly previousStatus?: TenantStatus;
            readonly previousOperatorHold?: boolean;
          })
        : null;
      if (
        stored &&
        ((stored.tenantId && stored.tenantId !== currentRow.id) ||
          stored.action !== input.action ||
          (stored.targetStatus ?? null) !== (input.targetStatus ?? null))
      ) {
        throw new ProvisioningError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key ini sudah digunakan untuk transisi status yang berbeda.",
        );
      }
      return {
        tenant: mapTenantRow(currentRow, nowMs),
        previousStatus: stored?.previousStatus ?? currentRow.status,
        previousOperatorHold: stored?.previousOperatorHold ?? currentRow.operator_hold === 1,
        replayed: true,
        audit: null,
      };
    }
  }

  if (expectedVersion !== currentRow.version) {
    throw new ProvisioningError(
      409,
      "STALE_VERSION",
      `Versi tenant berubah (diharapkan v${expectedVersion}, saat ini v${currentRow.version}). Muat ulang data lalu coba lagi.`,
    );
  }

  const resolved = resolveNextServiceState(
    {
      status: currentRow.status,
      operatorHold: currentRow.operator_hold === 1,
      operatorHoldReason: currentRow.operator_hold_reason,
      trialEndsAt: currentRow.trial_ends_at,
      paidThrough: currentRow.paid_through,
    },
    {
      action: input.action,
      targetStatus: input.targetStatus,
      operatorHold: input.operatorHold,
      paidThroughMs: input.paidThroughMs,
      trialEndsAtMs: input.trialEndsAtMs,
      cleanReason,
      nowMs,
    },
  );

  const retentionClause = resolved.pauseRetention
    ? "retention_paused_at = COALESCE(retention_paused_at, ?)"
    : resolved.clearRetentionPause
      ? "retention_paused_at = NULL"
      : "retention_paused_at = retention_paused_at";

  const updateBindings: (string | number | null)[] = [
    resolved.nextStatus,
    resolved.nextOperatorHold ? 1 : 0,
    resolved.nextOperatorHoldReason,
    resolved.nextPaidThrough,
    resolved.nextTrialEndsAt,
  ];
  if (resolved.pauseRetention) {
    updateBindings.push(nowMs);
  }
  updateBindings.push(nowMs, currentRow.id, expectedVersion);

  const updateStmt = platformDb
    .prepare(
      `UPDATE tenants
       SET status = ?,
           operator_hold = ?,
           operator_hold_reason = ?,
           paid_through = ?,
           trial_ends_at = ?,
           ${retentionClause},
           cache_version = cache_version + 1,
           version = version + 1,
           updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .bind(...updateBindings);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: "platform_operator",
      action: `tenant.state.${input.action}`,
      targetType: "tenant",
      targetId: currentRow.id,
      tenantId: currentRow.id,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        handle: currentRow.handle,
        fromStatus: currentRow.status,
        toStatus: resolved.nextStatus,
        fromOperatorHold: currentRow.operator_hold === 1,
        toOperatorHold: resolved.nextOperatorHold,
        expectedVersion,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const batchStatements: D1PreparedStatement[] = [updateStmt, auditStmt];
  if (ledgerKey) {
    batchStatements.push(
      platformDb
        .prepare(
          `INSERT INTO job_ledger (
            idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
          )
          SELECT ?, 'tenant.state_transition', ?, 'completed', 1, ?, ?, ?
          WHERE changes() = 1`,
        )
        .bind(
          ledgerKey,
          currentRow.id,
          JSON.stringify({
            tenantId: currentRow.id,
            action: input.action,
            targetStatus: input.targetStatus ?? null,
            previousStatus: currentRow.status,
            previousOperatorHold: currentRow.operator_hold === 1,
          }),
          nowMs,
          nowMs,
        ),
    );
  }

  let results: D1Result[];
  try {
    results = await platformDb.batch(batchStatements);
  } catch (err) {
    if (ledgerKey) {
      const raceLedger = await platformDb
        .prepare(
          "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
        )
        .bind(ledgerKey)
        .first<JobLedgerRow>();
      if (raceLedger && raceLedger.tenant_id) {
        if (raceLedger.tenant_id !== currentRow.id) {
          throw new ProvisioningError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key ini sudah digunakan untuk tenant yang berbeda.",
            err,
          );
        }
        const stored = raceLedger.payload_json
          ? (JSON.parse(raceLedger.payload_json) as {
              readonly tenantId?: string;
              readonly action?: string;
              readonly targetStatus?: string | null;
              readonly previousStatus?: TenantStatus;
              readonly previousOperatorHold?: boolean;
            })
          : null;
        if (
          stored &&
          ((stored.tenantId && stored.tenantId !== currentRow.id) ||
            stored.action !== input.action ||
            (stored.targetStatus ?? null) !== (input.targetStatus ?? null))
        ) {
          throw new ProvisioningError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key ini sudah digunakan untuk transisi status yang berbeda.",
            err,
          );
        }
        const existingRow = await loadTenantJoinRow(platformDb, {
          tenantId: raceLedger.tenant_id,
        });
        if (existingRow) {
          return {
            tenant: mapTenantRow(existingRow, nowMs),
            previousStatus: stored?.previousStatus ?? existingRow.status,
            previousOperatorHold: stored?.previousOperatorHold ?? existingRow.operator_hold === 1,
            replayed: true,
            audit: null,
          };
        }
      }
    }
    throw new ProvisioningError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Transisi status layanan dibatalkan karena gagal menyimpan catatan audit secara atomik.",
      err,
    );
  }

  const updateChanges = results[0]?.meta?.changes ?? 0;
  const auditChanges = results[1]?.meta?.changes ?? 0;

  if (updateChanges !== 1) {
    throw new ProvisioningError(
      409,
      "STALE_VERSION",
      "Status tenant berubah secara bersamaan oleh operasi lain. Muat ulang data lalu coba lagi.",
    );
  }

  if (auditChanges !== 1) {
    throw new ProvisioningError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Catatan audit transisi status layanan tidak berhasil tersimpan.",
    );
  }

  // Immediate isolate host-resolution cache eviction so next request sees the new state!
  evictTenantFromCache(currentRow.id);

  const updatedRow = await loadTenantJoinRow(platformDb, { tenantId: currentRow.id });
  if (!updatedRow) {
    throw new ProvisioningError(404, "NOT_FOUND", "Tenant tidak ditemukan setelah pembaruan.");
  }

  return {
    tenant: mapTenantRow(updatedRow, nowMs),
    previousStatus: currentRow.status,
    previousOperatorHold: currentRow.operator_hold === 1,
    replayed: false,
    audit: auditEntry,
  };
}

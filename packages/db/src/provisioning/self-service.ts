import {
  computeServerTrialWindow,
  normalizeBusinessNameForTrialKey,
  ONBOARDING_TRIAL_DURATION_SECONDS,
  sha256Hex,
  validateOnboardingHandleFormat,
} from "@punyasitus/core/onboarding/index";
import type { TenantStoreNamespaceLike } from "../connections/index.ts";
import {
  buildPlatformAuditStatement,
  generatePlatformAuditId,
  type PlatformAuditRecord,
} from "../platform/audit.ts";
import { TENANT_VERTICALS, type TenantStatus, type TenantVertical } from "../platform/schema.ts";
import {
  DEFAULT_SAAS_ZONE,
  getProvisionedTenantDetail,
  initializeTenantStoreDefaults,
  ProvisioningError,
  type ProvisionedTenantSummary,
} from "./index.ts";
import { ensureOnboardingSchema } from "./onboarding-migrations.ts";

/**
 * Self-service verified-owner website provisioning, durable one-trial-per-verified-owner
 * enforcement, handle availability checks, and partial-provisioning recovery
 * (`packages/db/src/provisioning/self-service.ts`; REQ-059, PLAN §17.1-§17.4, TASK-058).
 *
 * Hard invariants:
 * - Strictly REQUIRES a verified user identity (`users.email_verified === 1`). Unverified
 *   accounts ALWAYS fail closed (`403 EMAIL_NOT_VERIFIED`).
 * - Server-owned 7-day trial is EXACTLY `604,800` seconds (`nowMs + 604_800 * 1000`).
 * - One-trial-per-verified-owner (PLAN §17.3 / REQ-059) is enforced atomically inside the
 *   SAME `D1Database.batch` via `owner_trial_claims` (`UNIQUE(user_id)`, `UNIQUE(email_hash)`,
 *   `UNIQUE(google_sub_hash)`), plus checks against `deletion_tombstones` and prior owned sites.
 * - First site -> `status = 'trial'`, `trial_ends_at = nowMs + 604_800_000`.
 * - Second+ site for an already-verified owner -> NO new free trial; starts strictly
 *   `status = 'suspended'` (payment-only / `awaiting_first_payment`, `trial_ends_at = NULL`,
 *   `paid_through = NULL`, `operator_hold = 0`), isolated in its own organization & `TenantStore`.
 * - Self-service provisioning NEVER creates or modifies `platform_operators` rows.
 * - If `TenantStore` default seeding fails after `PLATFORM_DB` commits, `onboarding_attempts`
 *   records `provisioning_state = 'needs_recovery'` and optionally enqueues an async retry job;
 *   resuming recovery completes `TenantStore` init cleanly without duplicating the tenant or
 *   renewing trial time.
 */

const SAFE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export type SelfServiceOnboardingErrorCode =
  | "UNAUTHENTICATED"
  | "EMAIL_NOT_VERIFIED"
  | "VALIDATION_ERROR"
  | "INVALID_HANDLE"
  | "RESERVED_HANDLE"
  | "HANDLE_TAKEN"
  | "IDEMPOTENCY_CONFLICT"
  | "TRIAL_ALREADY_CONSUMED"
  | "NOT_FOUND"
  | "AUDIT_PERSISTENCE_FAILED"
  | "TENANT_STORE_INIT_FAILED";

export class SelfServiceOnboardingError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503;
  readonly code: SelfServiceOnboardingErrorCode;

  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503,
    code: SelfServiceOnboardingErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "SelfServiceOnboardingError";
    this.status = status;
    this.code = code;
  }
}

export type OnboardingProvisioningState = "pending_store" | "completed" | "needs_recovery";

export interface OnboardingRetryQueueProducer {
  send(message: {
    readonly idempotencyKey: string;
    readonly topic: string;
    readonly tenantId: string | null;
    readonly payload?: Record<string, unknown>;
  }): Promise<void>;
}

export interface HandleAvailabilityResult {
  readonly available: boolean;
  readonly normalizedHandle: string;
  readonly primaryHost: string | null;
  readonly saasZone: string;
  readonly code: "AVAILABLE" | "INVALID_HANDLE" | "RESERVED_HANDLE" | "HANDLE_TAKEN";
  readonly message: string;
}

export interface OwnedSiteOnboardingSummary {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: TenantVertical;
  readonly status: TenantStatus;
  readonly primaryHost: string;
  readonly trialEndsAt: number | null;
  readonly paidThrough: number | null;
  readonly schemaVersion: number;
  readonly awaitingFirstPayment: boolean;
}

export interface PendingOnboardingRecovery {
  readonly idempotencyKey: string;
  readonly tenantId: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: TenantVertical;
  readonly grantedTrial: boolean;
  readonly provisioningState: OnboardingProvisioningState;
  readonly lastErrorCode: string | null;
  readonly updatedAt: number;
}

export interface OwnerOnboardingStatus {
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly emailVerified: boolean;
  };
  readonly emailVerified: boolean;
  readonly trialEligible: boolean;
  readonly trialConsumedReason:
    | "none"
    | "prior_trial_claim"
    | "existing_owned_site"
    | "deleted_trial_tombstone";
  readonly trialDurationSeconds: typeof ONBOARDING_TRIAL_DURATION_SECONDS;
  readonly saasZone: string;
  readonly ownedSites: readonly OwnedSiteOnboardingSummary[];
  readonly pendingRecoveries: readonly PendingOnboardingRecovery[];
}

export interface SelfServiceProvisionInput {
  readonly userId: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical?: TenantVertical;
  readonly idempotencyKey: string;
  readonly requestId?: string | null;
  readonly saasZone?: string;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly jobsQueue?: OnboardingRetryQueueProducer | null;
  readonly nowMs?: number;
}

export interface SelfServiceProvisionResult {
  readonly tenant: ProvisionedTenantSummary;
  readonly replayed: boolean;
  readonly grantedTrial: boolean;
  readonly trialDurationSeconds: number | null;
  readonly awaitingFirstPayment: boolean;
  readonly billingMode: "trial" | "payment_only";
  readonly tenantStoreInitialized: boolean;
  readonly provisioningState: OnboardingProvisioningState;
  readonly recoveryRequired: boolean;
  readonly retryEnqueued: boolean;
  readonly idempotencyKey: string;
  readonly nextPath: string;
  readonly audit: PlatformAuditRecord | null;
}

interface UserIdentityRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly email_verified: number;
}

interface OnboardingAttemptRow {
  readonly idempotency_key: string;
  readonly user_id: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: TenantVertical;
  readonly request_hash: string;
  readonly tenant_id: string | null;
  readonly granted_trial: number;
  readonly provisioning_state: OnboardingProvisioningState;
  readonly last_error_code: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export const ONBOARDING_RETRY_STORE_INIT_TOPIC = "onboarding.retry_store_init" as const;

async function computeIdentityHashes(
  platformDb: D1Database,
  user: UserIdentityRow,
  businessName?: string,
): Promise<{
  readonly emailHash: string;
  readonly googleSubHash: string | null;
  readonly businessNameHash: string | null;
}> {
  const emailHash = await sha256Hex(user.email.trim().toLowerCase());
  const googleAccount = await platformDb
    .prepare(
      `SELECT account_id FROM accounts
       WHERE user_id = ? AND provider_id = 'google'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .bind(user.id)
    .first<{ readonly account_id: string }>();

  const googleSubHash =
    googleAccount && googleAccount.account_id.trim().length > 0
      ? await sha256Hex(googleAccount.account_id.trim())
      : null;

  let businessNameHash: string | null = null;
  if (businessName) {
    const normalizedBiz = normalizeBusinessNameForTrialKey(businessName);
    if (normalizedBiz.length >= 3) {
      businessNameHash = await sha256Hex(normalizedBiz);
    }
  }

  return { emailHash, googleSubHash, businessNameHash };
}

async function evaluateTrialConsumptionStatus(
  platformDb: D1Database,
  params: {
    readonly userId: string;
    readonly emailHash: string;
    readonly googleSubHash: string | null;
    readonly businessNameHash: string | null;
  },
): Promise<{
  readonly trialEligible: boolean;
  readonly reason:
    | "none"
    | "prior_trial_claim"
    | "existing_owned_site"
    | "deleted_trial_tombstone";
}> {
  // 1. Check durable owner_trial_claims by user_id, email_hash, or google_sub_hash
  const claimQuery = params.googleSubHash
    ? platformDb
        .prepare(
          `SELECT id FROM owner_trial_claims
           WHERE user_id = ? OR email_hash = ? OR google_sub_hash = ?
           LIMIT 1`,
        )
        .bind(params.userId, params.emailHash, params.googleSubHash)
    : platformDb
        .prepare(
          `SELECT id FROM owner_trial_claims
           WHERE user_id = ? OR email_hash = ?
           LIMIT 1`,
        )
        .bind(params.userId, params.emailHash);

  const existingClaim = await claimQuery.first<{ readonly id: string }>();
  if (existingClaim) {
    return { trialEligible: false, reason: "prior_trial_claim" };
  }

  // 2. Check deletion_tombstones for previously purged trial identities (REQ-059 / PLAN §17.1)
  const tombstoneClauses = ["email_hash = ?"];
  const tombstoneBindings: string[] = [params.emailHash];
  if (params.googleSubHash) {
    tombstoneClauses.push("google_sub_hash = ?");
    tombstoneBindings.push(params.googleSubHash);
  }
  if (params.businessNameHash) {
    tombstoneClauses.push("company_name_hash = ?");
    tombstoneBindings.push(params.businessNameHash);
  }
  const existingTombstone = await platformDb
    .prepare(
      `SELECT id FROM deletion_tombstones
       WHERE ${tombstoneClauses.join(" OR ")}
       LIMIT 1`,
    )
    .bind(...tombstoneBindings)
    .first<{ readonly id: string }>();

  if (existingTombstone) {
    return { trialEligible: false, reason: "deleted_trial_tombstone" };
  }

  // 3. Check if user already owns an existing website (e.g., provisioned by an operator)
  const existingOwned = await platformDb
    .prepare(
      `SELECT t.id
       FROM members m
       INNER JOIN tenants t ON t.organization_id = m.organization_id
       WHERE m.user_id = ? AND m.role = 'owner'
       LIMIT 1`,
    )
    .bind(params.userId)
    .first<{ readonly id: string }>();

  if (existingOwned) {
    return { trialEligible: false, reason: "existing_owned_site" };
  }

  return { trialEligible: true, reason: "none" };
}

/**
 * Checks handle syntax, reserved platform labels, active `tenants` collision,
 * and 30-day post-deletion `deletion_tombstones` quarantine (REQ-059, PLAN §17.2).
 */
export async function checkHandleAvailability(
  platformDb: D1Database,
  rawHandle: string,
  options: { readonly saasZone?: string; readonly nowMs?: number } = {},
): Promise<HandleAvailabilityResult> {
  const saasZone = (options.saasZone ?? DEFAULT_SAAS_ZONE).trim().toLowerCase() || DEFAULT_SAAS_ZONE;
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const format = validateOnboardingHandleFormat(rawHandle, saasZone);

  if (!format.ok) {
    return {
      available: false,
      normalizedHandle: format.normalizedHandle,
      primaryHost: null,
      saasZone,
      code: format.code,
      message: format.message,
    };
  }

  const existingTenant = await platformDb
    .prepare("SELECT id FROM tenants WHERE handle = ? LIMIT 1")
    .bind(format.normalizedHandle)
    .first<{ readonly id: string }>();

  if (existingTenant) {
    return {
      available: false,
      normalizedHandle: format.normalizedHandle,
      primaryHost: format.primaryHost,
      saasZone,
      code: "HANDLE_TAKEN",
      message: `Alamat "${format.primaryHost}" sudah digunakan oleh situs lain. Pilih nama lain.`,
    };
  }

  const quarantined = await platformDb
    .prepare(
      "SELECT id FROM deletion_tombstones WHERE handle = ? AND quarantine_until > ? LIMIT 1",
    )
    .bind(format.normalizedHandle, nowMs)
    .first<{ readonly id: string }>();

  if (quarantined) {
    return {
      available: false,
      normalizedHandle: format.normalizedHandle,
      primaryHost: format.primaryHost,
      saasZone,
      code: "HANDLE_TAKEN",
      message: `Alamat "${format.primaryHost}" sedang dalam masa karantina pasca-penghapusan. Pilih nama lain.`,
    };
  }

  return {
    available: true,
    normalizedHandle: format.normalizedHandle,
    primaryHost: format.primaryHost,
    saasZone,
    code: "AVAILABLE",
    message: `Alamat "${format.primaryHost}" tersedia dan siap digunakan.`,
  };
}

/**
 * Loads live onboarding readiness, verified-email state, one-trial eligibility,
 * existing owned sites, and recoverable partial-provisioning attempts for a user.
 */
export async function getOwnerOnboardingStatus(
  platformDb: D1Database,
  userId: string,
  options: { readonly nowMs?: number; readonly saasZone?: string } = {},
): Promise<OwnerOnboardingStatus | null> {
  const cleanUserId = userId.trim();
  if (!cleanUserId) return null;

  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const saasZone = (options.saasZone ?? DEFAULT_SAAS_ZONE).trim().toLowerCase() || DEFAULT_SAAS_ZONE;
  await ensureOnboardingSchema(platformDb, () => nowMs);

  const user = await platformDb
    .prepare("SELECT id, name, email, email_verified FROM users WHERE id = ? LIMIT 1")
    .bind(cleanUserId)
    .first<UserIdentityRow>();

  if (!user) return null;

  const hashes = await computeIdentityHashes(platformDb, user);
  const trialEval = await evaluateTrialConsumptionStatus(platformDb, {
    userId: user.id,
    emailHash: hashes.emailHash,
    googleSubHash: hashes.googleSubHash,
    businessNameHash: null,
  });

  const ownedRows = await platformDb
    .prepare(
      `SELECT
         t.id, t.handle, t.name, t.vertical, t.status,
         t.trial_ends_at, t.paid_through, t.schema_version,
         (
           SELECT th.host FROM tenant_hosts th
           WHERE th.tenant_id = t.id AND th.is_primary = 1
           LIMIT 1
         ) AS primary_host
       FROM members m
       INNER JOIN tenants t ON t.organization_id = m.organization_id
       WHERE m.user_id = ? AND m.role = 'owner' AND t.status != 'purged'
       ORDER BY t.created_at DESC`,
    )
    .bind(user.id)
    .all<{
      readonly id: string;
      readonly handle: string;
      readonly name: string;
      readonly vertical: TenantVertical;
      readonly status: TenantStatus;
      readonly trial_ends_at: number | null;
      readonly paid_through: number | null;
      readonly schema_version: number;
      readonly primary_host: string | null;
    }>();

  const ownedSites: OwnedSiteOnboardingSummary[] = (ownedRows.results ?? []).map((row) => ({
    id: row.id,
    handle: row.handle,
    name: row.name,
    vertical: row.vertical,
    status: row.status,
    primaryHost: row.primary_host ?? `${row.handle}.${saasZone}`,
    trialEndsAt: row.trial_ends_at,
    paidThrough: row.paid_through,
    schemaVersion: row.schema_version,
    awaitingFirstPayment:
      row.status === "suspended" && row.trial_ends_at === null && row.paid_through === null,
  }));

  const recoveryRows = await platformDb
    .prepare(
      `SELECT oa.idempotency_key, oa.tenant_id, oa.handle, oa.name, oa.vertical,
              oa.granted_trial, oa.provisioning_state, oa.last_error_code, oa.updated_at
       FROM onboarding_attempts oa
       INNER JOIN tenants t ON t.id = oa.tenant_id
       WHERE oa.user_id = ?
         AND oa.tenant_id IS NOT NULL
         AND (oa.provisioning_state IN ('pending_store', 'needs_recovery') OR t.schema_version = 0)
       ORDER BY oa.updated_at DESC
       LIMIT 10`,
    )
    .bind(user.id)
    .all<{
      readonly idempotency_key: string;
      readonly tenant_id: string;
      readonly handle: string;
      readonly name: string;
      readonly vertical: TenantVertical;
      readonly granted_trial: number;
      readonly provisioning_state: OnboardingProvisioningState;
      readonly last_error_code: string | null;
      readonly updated_at: number;
    }>();

  const pendingRecoveries: PendingOnboardingRecovery[] = (recoveryRows.results ?? []).map((row) => ({
    idempotencyKey: row.idempotency_key,
    tenantId: row.tenant_id,
    handle: row.handle,
    name: row.name,
    vertical: row.vertical,
    grantedTrial: row.granted_trial === 1,
    provisioningState: row.provisioning_state,
    lastErrorCode: row.last_error_code,
    updatedAt: row.updated_at,
  }));

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.email_verified === 1,
    },
    emailVerified: user.email_verified === 1,
    trialEligible: trialEval.trialEligible,
    trialConsumedReason: trialEval.reason,
    trialDurationSeconds: ONBOARDING_TRIAL_DURATION_SECONDS,
    saasZone,
    ownedSites,
    pendingRecoveries,
  };
}

function buildNextDashboardPath(tenant: ProvisionedTenantSummary, grantedTrial: boolean): string {
  if (!grantedTrial && tenant.effectiveStatus === "suspended" && tenant.paidThrough === null) {
    return `/dashboard/${encodeURIComponent(tenant.handle)}/billing`;
  }
  return `/dashboard/${encodeURIComponent(tenant.handle)}`;
}

async function finalizeTenantStoreWithRecovery(
  platformDb: D1Database,
  params: {
    readonly tenantId: string;
    readonly handle: string;
    readonly name: string;
    readonly vertical: TenantVertical;
    readonly idempotencyKey: string;
    readonly nowMs: number;
    readonly tenantStore?: TenantStoreNamespaceLike | null;
    readonly jobsQueue?: OnboardingRetryQueueProducer | null;
  },
): Promise<{
  readonly tenantStoreInitialized: boolean;
  readonly provisioningState: OnboardingProvisioningState;
  readonly recoveryRequired: boolean;
  readonly retryEnqueued: boolean;
}> {
  if (!params.tenantStore) {
    return {
      tenantStoreInitialized: false,
      provisioningState: "pending_store",
      recoveryRequired: true,
      retryEnqueued: false,
    };
  }

  try {
    // Always initialize self-service sites with the initial 100MB trial/pre-payment quota;
    // confirmed payment upgrades storage quota & activates service.
    await initializeTenantStoreDefaults(platformDb, params.tenantStore, {
      tenantId: params.tenantId,
      name: params.name,
      vertical: params.vertical,
      initialStatus: "trial",
      nowMs: params.nowMs,
    });

    await platformDb
      .prepare(
        `UPDATE onboarding_attempts
         SET provisioning_state = 'completed',
             last_error_code = NULL,
             updated_at = ?
         WHERE idempotency_key = ?`,
      )
      .bind(params.nowMs, params.idempotencyKey)
      .run();

    return {
      tenantStoreInitialized: true,
      provisioningState: "completed",
      recoveryRequired: false,
      retryEnqueued: false,
    };
  } catch (err) {
    const errorCode =
      err instanceof ProvisioningError ? err.code : "TENANT_STORE_INIT_FAILED";

    await platformDb
      .prepare(
        `UPDATE onboarding_attempts
         SET provisioning_state = 'needs_recovery',
             last_error_code = ?,
             updated_at = ?
         WHERE idempotency_key = ?`,
      )
      .bind(errorCode, params.nowMs, params.idempotencyKey)
      .run();

    let retryEnqueued = false;
    if (params.jobsQueue) {
      try {
        await params.jobsQueue.send({
          idempotencyKey: `onboarding-retry:${params.tenantId}`,
          topic: ONBOARDING_RETRY_STORE_INIT_TOPIC,
          tenantId: params.tenantId,
          payload: {
            tenantId: params.tenantId,
            handle: params.handle,
            name: params.name,
            vertical: params.vertical,
            onboardingIdempotencyKey: params.idempotencyKey,
          },
        });
        retryEnqueued = true;
      } catch {
        retryEnqueued = false;
      }
    }

    return {
      tenantStoreInitialized: false,
      provisioningState: "needs_recovery",
      recoveryRequired: true,
      retryEnqueued,
    };
  }
}

async function resolveIdempotentReplay(
  platformDb: D1Database,
  attempt: OnboardingAttemptRow,
  params: {
    readonly userId: string;
    readonly requestHash: string;
    readonly saasZone: string;
    readonly nowMs: number;
    readonly tenantStore?: TenantStoreNamespaceLike | null;
    readonly jobsQueue?: OnboardingRetryQueueProducer | null;
  },
): Promise<SelfServiceProvisionResult> {
  if (attempt.user_id !== params.userId || attempt.request_hash !== params.requestHash) {
    throw new SelfServiceOnboardingError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key ini sudah digunakan untuk permintaan pembuatan situs yang berbeda.",
    );
  }

  if (!attempt.tenant_id) {
    throw new SelfServiceOnboardingError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Catatan onboarding tidak memiliki referensi tenant yang valid.",
    );
  }

  let tenant = await getProvisionedTenantDetail(
    platformDb,
    { tenantId: attempt.tenant_id },
    { nowMs: params.nowMs, saasZone: params.saasZone },
  );
  if (!tenant) {
    throw new SelfServiceOnboardingError(404, "NOT_FOUND", "Situs tidak ditemukan.");
  }

  let tenantStoreInitialized = tenant.schemaVersion > 0;
  let provisioningState: OnboardingProvisioningState = tenantStoreInitialized
    ? "completed"
    : attempt.provisioning_state;
  let recoveryRequired = !tenantStoreInitialized;
  let retryEnqueued = false;

  if (!tenantStoreInitialized && params.tenantStore) {
    const storeResult = await finalizeTenantStoreWithRecovery(platformDb, {
      tenantId: tenant.id,
      handle: tenant.handle,
      name: tenant.name,
      vertical: tenant.vertical,
      idempotencyKey: attempt.idempotency_key,
      nowMs: params.nowMs,
      tenantStore: params.tenantStore,
      jobsQueue: params.jobsQueue,
    });
    tenantStoreInitialized = storeResult.tenantStoreInitialized;
    provisioningState = storeResult.provisioningState;
    recoveryRequired = storeResult.recoveryRequired;
    retryEnqueued = storeResult.retryEnqueued;

    tenant =
      (await getProvisionedTenantDetail(
        platformDb,
        { tenantId: tenant.id },
        { nowMs: params.nowMs, saasZone: params.saasZone },
      )) ?? tenant;
  } else if (tenantStoreInitialized && attempt.provisioning_state !== "completed") {
    await platformDb
      .prepare(
        `UPDATE onboarding_attempts
         SET provisioning_state = 'completed', last_error_code = NULL, updated_at = ?
         WHERE idempotency_key = ?`,
      )
      .bind(params.nowMs, attempt.idempotency_key)
      .run();
    provisioningState = "completed";
    recoveryRequired = false;
  }

  const grantedTrial = attempt.granted_trial === 1;
  const awaitingFirstPayment =
    !grantedTrial && tenant.effectiveStatus === "suspended" && tenant.paidThrough === null;

  return {
    tenant,
    replayed: true,
    grantedTrial,
    trialDurationSeconds: grantedTrial ? ONBOARDING_TRIAL_DURATION_SECONDS : null,
    awaitingFirstPayment,
    billingMode: grantedTrial ? "trial" : "payment_only",
    tenantStoreInitialized,
    provisioningState,
    recoveryRequired,
    retryEnqueued,
    idempotencyKey: attempt.idempotency_key,
    nextPath: buildNextDashboardPath(tenant, grantedTrial),
    audit: null,
  };
}

/**
 * Atomically provisions a self-service website for a verified owner.
 *
 * - First website for the verified owner: 1x server-owned 7-day trial (`604,800`s exact)
 *   recorded atomically in `owner_trial_claims` + `tenants` + `organizations` + `members(owner)`
 *   + `tenant_hosts` + `onboarding_attempts` + `platform_audit`.
 * - Second+ website for the same verified owner: starts strictly `suspended` (payment-only /
 *   `awaiting_first_payment`, `trial_ends_at = NULL`, NO free trial) in a separate organization
 *   and `TenantStore` instance.
 */
export async function provisionSelfServiceTenant(
  platformDb: D1Database,
  input: SelfServiceProvisionInput,
): Promise<SelfServiceProvisionResult> {
  const userId = input.userId.trim();
  if (!userId) {
    throw new SelfServiceOnboardingError(
      401,
      "UNAUTHENTICATED",
      "Sesi pengguna terautentikasi wajib digunakan.",
    );
  }

  const idempotencyKey = input.idempotencyKey.trim();
  if (!SAFE_IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new SelfServiceOnboardingError(
      422,
      "VALIDATION_ERROR",
      "Idempotency-Key wajib berupa 8-128 karakter alfanumerik aman.",
    );
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const saasZone = (input.saasZone ?? DEFAULT_SAAS_ZONE).trim().toLowerCase() || DEFAULT_SAAS_ZONE;
  await ensureOnboardingSchema(platformDb, () => nowMs);

  // 1. Verify live user identity & mandatory verified-email gate
  const user = await platformDb
    .prepare("SELECT id, name, email, email_verified FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<UserIdentityRow>();

  if (!user) {
    throw new SelfServiceOnboardingError(
      401,
      "UNAUTHENTICATED",
      "Akun pengguna tidak ditemukan. Silakan masuk kembali.",
    );
  }

  if (user.email_verified !== 1) {
    throw new SelfServiceOnboardingError(
      403,
      "EMAIL_NOT_VERIFIED",
      "Verifikasi alamat email Anda terlebih dahulu sebelum membuat website.",
    );
  }

  // 2. Validate handle, name, and vertical
  const handleCheck = validateOnboardingHandleFormat(input.handle, saasZone);
  if (!handleCheck.ok) {
    throw new SelfServiceOnboardingError(422, handleCheck.code, handleCheck.message);
  }
  const handle = handleCheck.normalizedHandle;
  const primaryHost = handleCheck.primaryHost;

  const name = input.name.replace(/[\r\n\t\0]+/g, " ").trim();
  if (name.length < 2 || name.length > 160) {
    throw new SelfServiceOnboardingError(
      422,
      "VALIDATION_ERROR",
      "Nama bisnis/situs harus terdiri dari 2 hingga 160 karakter.",
    );
  }

  const vertical: TenantVertical = input.vertical ?? "compro";
  if (!TENANT_VERTICALS.includes(vertical)) {
    throw new SelfServiceOnboardingError(
      422,
      "VALIDATION_ERROR",
      `Vertikal "${String(vertical)}" tidak didukung.`,
    );
  }

  const requestHash = await sha256Hex(
    JSON.stringify({ userId: user.id, handle, name, vertical }),
  );

  // 3. Check idempotent replay BEFORE touching trial/handle checks
  const existingAttempt = await platformDb
    .prepare("SELECT * FROM onboarding_attempts WHERE idempotency_key = ? LIMIT 1")
    .bind(idempotencyKey)
    .first<OnboardingAttemptRow>();

  if (existingAttempt) {
    return resolveIdempotentReplay(platformDb, existingAttempt, {
      userId: user.id,
      requestHash,
      saasZone,
      nowMs,
      tenantStore: input.tenantStore,
      jobsQueue: input.jobsQueue,
    });
  }

  // 4. Pre-check handle availability & quarantine tombstone
  const availability = await checkHandleAvailability(platformDb, handle, { saasZone, nowMs });
  if (!availability.available && availability.code !== "AVAILABLE") {
    const status = availability.code === "HANDLE_TAKEN" ? 409 : 422;
    throw new SelfServiceOnboardingError(status, availability.code, availability.message);
  }

  // 5. Evaluate one-trial-per-verified-owner rule (PLAN §17.3 / REQ-059)
  const hashes = await computeIdentityHashes(platformDb, user, name);
  const trialEval = await evaluateTrialConsumptionStatus(platformDb, {
    userId: user.id,
    emailHash: hashes.emailHash,
    googleSubHash: hashes.googleSubHash,
    businessNameHash: hashes.businessNameHash,
  });

  const grantedTrial = trialEval.trialEligible;
  const serverTrial = grantedTrial ? computeServerTrialWindow(nowMs) : null;
  const initialStatus: TenantStatus = grantedTrial ? "trial" : "suspended";
  const trialEndsAtMs = serverTrial ? serverTrial.trialEndsAtMs : null;

  const tenantId = generatePlatformAuditId(nowMs);
  const organizationId = generatePlatformAuditId(nowMs + 1);
  const memberId = generatePlatformAuditId(nowMs + 2);
  const trialClaimId = generatePlatformAuditId(nowMs + 3);

  const statements: D1PreparedStatement[] = [
    platformDb
      .prepare(
        `INSERT INTO organizations (id, name, slug, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        organizationId,
        name,
        handle,
        JSON.stringify({
          tenantId,
          selfServiceOnboarding: true,
          billingMode: grantedTrial ? "trial" : "payment_only",
        }),
        nowMs,
        nowMs,
      ),
    platformDb
      .prepare(
        `INSERT INTO tenants (
          id, organization_id, handle, name, vertical, status,
          operator_hold, operator_hold_reason, trial_ends_at, paid_through,
          cache_version, schema_version, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, 1, 0, 1, ?, ?)`,
      )
      .bind(
        tenantId,
        organizationId,
        handle,
        name,
        vertical,
        initialStatus,
        trialEndsAtMs,
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
    platformDb
      .prepare(
        `INSERT INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'owner', ?)`,
      )
      .bind(memberId, organizationId, user.id, nowMs),
  ];

  if (grantedTrial && serverTrial) {
    statements.push(
      platformDb
        .prepare(
          `INSERT INTO owner_trial_claims (
            id, user_id, email_hash, google_sub_hash, normalized_business_hash,
            tenant_id, trial_starts_at, trial_ends_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          trialClaimId,
          user.id,
          hashes.emailHash,
          hashes.googleSubHash,
          hashes.businessNameHash,
          tenantId,
          serverTrial.trialStartsAtMs,
          serverTrial.trialEndsAtMs,
          nowMs,
        ),
    );
  }

  statements.push(
    platformDb
      .prepare(
        `INSERT INTO onboarding_attempts (
          idempotency_key, user_id, handle, name, vertical, request_hash,
          tenant_id, granted_trial, provisioning_state, last_error_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_store', NULL, ?, ?)`,
      )
      .bind(
        idempotencyKey,
        user.id,
        handle,
        name,
        vertical,
        requestHash,
        tenantId,
        grantedTrial ? 1 : 0,
        nowMs,
        nowMs,
      ),
  );

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(platformDb, {
    actorUserId: user.id,
    actorRole: "owner",
    action: grantedTrial
      ? "onboarding.tenant.provision_trial"
      : "onboarding.tenant.provision_payment_only",
    targetType: "tenant",
    targetId: tenantId,
    tenantId,
    outcome: "success",
    requestId: input.requestId ?? null,
    metadata: {
      handle,
      vertical,
      initialStatus,
      grantedTrial,
      trialDurationSeconds: grantedTrial ? ONBOARDING_TRIAL_DURATION_SECONDS : null,
      awaitingFirstPayment: !grantedTrial,
      primaryHost,
      idempotencyKey,
    },
    createdAtMs: nowMs,
  });
  statements.push(auditStmt);

  // 6. Execute atomic D1 batch & handle concurrent races cleanly
  try {
    await platformDb.batch(statements);
  } catch (err) {
    // 6a. Concurrent idempotency replay race
    const raceAttempt = await platformDb
      .prepare("SELECT * FROM onboarding_attempts WHERE idempotency_key = ? LIMIT 1")
      .bind(idempotencyKey)
      .first<OnboardingAttemptRow>();
    if (raceAttempt) {
      return resolveIdempotentReplay(platformDb, raceAttempt, {
        userId: user.id,
        requestHash,
        saasZone,
        nowMs,
        tenantStore: input.tenantStore,
        jobsQueue: input.jobsQueue,
      });
    }

    // 6b. Concurrent handle collision race
    const raceHandle = await platformDb
      .prepare("SELECT id FROM tenants WHERE handle = ? LIMIT 1")
      .bind(handle)
      .first<{ readonly id: string }>();
    if (raceHandle) {
      throw new SelfServiceOnboardingError(
        409,
        "HANDLE_TAKEN",
        `Alamat "${primaryHost}" baru saja diambil oleh pengguna lain. Pilih nama lain.`,
        err,
      );
    }

    // 6c. Concurrent double-trial race by the same verified owner
    if (grantedTrial) {
      const raceClaim = await platformDb
        .prepare(
          "SELECT id FROM owner_trial_claims WHERE user_id = ? OR email_hash = ? LIMIT 1",
        )
        .bind(user.id, hashes.emailHash)
        .first<{ readonly id: string }>();
      if (raceClaim) {
        throw new SelfServiceOnboardingError(
          409,
          "TRIAL_ALREADY_CONSUMED",
          "Uji coba gratis 7 hari untuk akun ini sudah digunakan oleh permintaan lain. Muat ulang halaman untuk membuat situs tambahan berbayar.",
          err,
        );
      }
    }

    throw new SelfServiceOnboardingError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Pembuatan situs dibatalkan karena gagal menyimpan transaksi atomik di basis data.",
      err,
    );
  }

  // 7. Initialize TenantStore defaults (recoverable if DO fails after D1 commit!)
  const storeResult = await finalizeTenantStoreWithRecovery(platformDb, {
    tenantId,
    handle,
    name,
    vertical,
    idempotencyKey,
    nowMs,
    tenantStore: input.tenantStore,
    jobsQueue: input.jobsQueue,
  });

  const createdTenant = await getProvisionedTenantDetail(
    platformDb,
    { tenantId },
    { nowMs, saasZone },
  );
  if (!createdTenant) {
    throw new SelfServiceOnboardingError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Situs tidak dapat diverifikasi setelah transaksi pembuatan selesai.",
    );
  }

  const awaitingFirstPayment = !grantedTrial;
  return {
    tenant: createdTenant,
    replayed: false,
    grantedTrial,
    trialDurationSeconds: grantedTrial ? ONBOARDING_TRIAL_DURATION_SECONDS : null,
    awaitingFirstPayment,
    billingMode: grantedTrial ? "trial" : "payment_only",
    tenantStoreInitialized: storeResult.tenantStoreInitialized,
    provisioningState: storeResult.provisioningState,
    recoveryRequired: storeResult.recoveryRequired,
    retryEnqueued: storeResult.retryEnqueued,
    idempotencyKey,
    nextPath: buildNextDashboardPath(createdTenant, grantedTrial),
    audit: auditEntry,
  };
}

/**
 * Idempotently resumes `TenantStore` default initialization for a partially provisioned
 * self-service site (used by both the recovery API and `onboarding.retry_store_init` queue worker).
 * NEVER creates a duplicate tenant and NEVER resets or extends `trial_ends_at`.
 */
export async function resumeOnboardingTenantStoreInit(
  platformDb: D1Database,
  tenantStore: TenantStoreNamespaceLike,
  input: {
    readonly tenantId: string;
    readonly userId?: string;
    readonly saasZone?: string;
    readonly nowMs?: number;
  },
): Promise<{
  readonly tenant: ProvisionedTenantSummary;
  readonly alreadyCompleted: boolean;
  readonly tenantStoreInitialized: boolean;
  readonly provisioningState: OnboardingProvisioningState;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const saasZone = (input.saasZone ?? DEFAULT_SAAS_ZONE).trim().toLowerCase() || DEFAULT_SAAS_ZONE;
  await ensureOnboardingSchema(platformDb, () => nowMs);

  const attempt = await platformDb
    .prepare("SELECT * FROM onboarding_attempts WHERE tenant_id = ? ORDER BY created_at ASC LIMIT 1")
    .bind(input.tenantId)
    .first<OnboardingAttemptRow>();

  if (input.userId) {
    const membership = await platformDb
      .prepare(
        `SELECT m.id
         FROM tenants t
         INNER JOIN members m ON m.organization_id = t.organization_id
         WHERE t.id = ? AND m.user_id = ? AND m.role = 'owner'
         LIMIT 1`,
      )
      .bind(input.tenantId, input.userId)
      .first<{ readonly id: string }>();

    if (!membership) {
      throw new SelfServiceOnboardingError(404, "NOT_FOUND", "Situs tidak ditemukan.");
    }
  }

  const tenant = await getProvisionedTenantDetail(
    platformDb,
    { tenantId: input.tenantId },
    { nowMs, saasZone },
  );
  if (!tenant) {
    throw new SelfServiceOnboardingError(404, "NOT_FOUND", "Situs tidak ditemukan.");
  }

  if (tenant.schemaVersion > 0) {
    if (attempt && attempt.provisioning_state !== "completed") {
      await platformDb
        .prepare(
          `UPDATE onboarding_attempts
           SET provisioning_state = 'completed', last_error_code = NULL, updated_at = ?
           WHERE idempotency_key = ?`,
        )
        .bind(nowMs, attempt.idempotency_key)
        .run();
    }
    return {
      tenant,
      alreadyCompleted: true,
      tenantStoreInitialized: true,
      provisioningState: "completed",
    };
  }

  await initializeTenantStoreDefaults(platformDb, tenantStore, {
    tenantId: tenant.id,
    name: tenant.name,
    vertical: tenant.vertical,
    initialStatus: "trial",
    nowMs,
  });

  const updates: D1PreparedStatement[] = [];
  if (attempt) {
    updates.push(
      platformDb
        .prepare(
          `UPDATE onboarding_attempts
           SET provisioning_state = 'completed', last_error_code = NULL, updated_at = ?
           WHERE idempotency_key = ?`,
        )
        .bind(nowMs, attempt.idempotency_key),
    );
  }
  const { statement: auditStmt } = buildPlatformAuditStatement(platformDb, {
    actorUserId: input.userId ?? attempt?.user_id ?? null,
    actorRole: input.userId ? "owner" : "system",
    action: "onboarding.tenant.recovery_completed",
    targetType: "tenant",
    targetId: tenant.id,
    tenantId: tenant.id,
    outcome: "success",
    metadata: {
      handle: tenant.handle,
      idempotencyKey: attempt?.idempotency_key ?? null,
    },
    createdAtMs: nowMs,
  });
  updates.push(auditStmt);
  await platformDb.batch(updates);

  const refreshed =
    (await getProvisionedTenantDetail(platformDb, { tenantId: tenant.id }, { nowMs, saasZone })) ??
    tenant;

  return {
    tenant: refreshed,
    alreadyCompleted: false,
    tenantStoreInitialized: true,
    provisioningState: "completed",
  };
}

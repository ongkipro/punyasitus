import {
  DAY_MS,
  DomainConflictError,
  DomainEligibilityError,
  DomainNotFoundError,
  DomainRateLimitError,
  MAX_CUSTOM_HOSTNAMES_PER_TENANT,
  assertTenantDomainSetCompatibility,
  evaluateDcvTokenAge,
  type CloudflareCustomHostname,
  type DomainConnectMode,
  type DomainSslMethod,
} from "@punyasitus/core/domains/index";
import {
  buildPlatformAuditStatement,
  preparePlatformAuditRecord,
} from "../platform/audit.ts";
import {
  evictHostFromCache,
  evictTenantFromCache,
  type TenantHostKind,
  type TenantHostStatus,
} from "../routing/resolver.ts";
import { ensureDomainMetadataSchema } from "./schema.ts";

/**
 * `PLATFORM_DB` custom-domain repository (REQ-004, REQ-043, REQ-065; PLAN §3.1-3.2).
 *
 * Security & correctness invariants:
 * - Every query is strictly scoped by `tenant_id` (cross-tenant lookups return `null` -> 404).
 * - Global hostname uniqueness via `tenant_hosts.host` PK prevents duplicate claims across tenants
 *   (`409 DOMAIN_ALREADY_CLAIMED`).
 * - Primary switches, activations, removals, and reaps atomically increment `tenants.cache_version`,
 *   write append-only `platform_audit` rows, and call `evictTenantFromCache` / `evictHostFromCache`.
 */

export interface TenantDomainRecord {
  readonly id: number;
  readonly tenantId: string;
  readonly hostname: string;
  readonly kind: TenantHostKind;
  readonly cfCustomHostnameId: string | null;
  readonly status: TenantHostStatus;
  readonly sslStatus: string;
  readonly isPrimary: boolean;
  readonly verifiedAt: number | null;
  readonly lastCheckedAt: number | null;
  readonly quarantinedUntil: number | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly connectMode: DomainConnectMode | null;
  readonly sslMethod: DomainSslMethod | null;
  readonly certificateAuthority: string | null;
  readonly tokenIssuedAt: number | null;
  readonly tokenExpiresAt: number | null;
  readonly providerStatus: string | null;
  readonly providerSslStatus: string | null;
  readonly providerSnapshot: CloudflareCustomHostname | null;
  readonly dnsTargetObserved: string | null;
  readonly httpsProbePassed: boolean;
  readonly httpsProbeCheckedAt: number | null;
  readonly failureCode: string | null;
  readonly everActivated: boolean;
  readonly lastRecheckAt: number | null;
  readonly lastRenewalAlertAt: number | null;
  readonly lastRenewalAlertKey: string | null;
  readonly idempotencyKey: string | null;
}

export interface TenantDomainListResult {
  readonly items: readonly TenantDomainRecord[];
  readonly customDomainLocked: boolean;
  readonly maxCustomHostnames: typeof MAX_CUSTOM_HOSTNAMES_PER_TENANT;
}

export interface DomainRecheckRateLimitPolicy {
  readonly perDomainLimit: number;
  readonly perDomainWindowMs: number;
  readonly perTenantLimit: number;
  readonly perTenantWindowMs: number;
}

export const DEFAULT_DOMAIN_RECHECK_RATE_LIMIT: DomainRecheckRateLimitPolicy = {
  perDomainLimit: 2,
  perDomainWindowMs: 60_000, // max 2 manual rechecks per minute per domain
  perTenantLimit: 10,
  perTenantWindowMs: 10 * 60_000, // max 10 manual rechecks per 10 minutes per tenant
};

export const STALE_HOSTNAME_REAPER_THRESHOLD_MS = 7 * DAY_MS;

export interface StaleHostnameReaperCandidate {
  readonly host: string;
  readonly tenantId: string;
  readonly cfCustomHostnameId: string | null;
  readonly status: TenantHostStatus;
  readonly sslStatus: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly ageMs: number;
  readonly ageDays: number;
}

export interface ActiveCustomDomainWatchCandidate {
  readonly host: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantHandle: string;
  readonly cfCustomHostnameId: string | null;
  readonly status: TenantHostStatus;
  readonly sslStatus: string;
  readonly isPrimary: boolean;
  readonly connectMode: DomainConnectMode | null;
  readonly sslMethod: DomainSslMethod | null;
  readonly providerSnapshot: CloudflareCustomHostname | null;
  readonly lastRenewalAlertAt: number | null;
  readonly lastRenewalAlertKey: string | null;
  readonly ownerEmails: readonly { readonly email: string; readonly name: string }[];
}

interface RawJoinedDomainRow {
  readonly host: string;
  readonly tenant_id: string;
  readonly kind: TenantHostKind;
  readonly cf_custom_hostname_id: string | null;
  readonly status: TenantHostStatus;
  readonly ssl_status: string;
  readonly is_primary: number;
  readonly verified_at: number | null;
  readonly last_checked_at: number | null;
  readonly quarantined_until: number | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly domain_id: number | null;
  readonly connect_mode: DomainConnectMode | null;
  readonly ssl_method: DomainSslMethod | null;
  readonly certificate_authority: string | null;
  readonly token_issued_at: number | null;
  readonly token_expires_at: number | null;
  readonly provider_status: string | null;
  readonly provider_ssl_status: string | null;
  readonly provider_snapshot_json: string | null;
  readonly dns_target_observed: string | null;
  readonly https_probe_passed: number | null;
  readonly https_probe_checked_at: number | null;
  readonly failure_code: string | null;
  readonly ever_activated: number | null;
  readonly last_recheck_at: number | null;
  readonly last_renewal_alert_at: number | null;
  readonly last_renewal_alert_key: string | null;
  readonly idempotency_key: string | null;
}

const SELECT_JOINED_DOMAIN_FIELDS = `
  th.host,
  th.tenant_id,
  th.kind,
  th.cf_custom_hostname_id,
  th.status,
  th.ssl_status,
  th.is_primary,
  th.verified_at,
  th.last_checked_at,
  th.quarantined_until,
  th.version,
  th.created_at,
  th.updated_at,
  m.domain_id,
  m.connect_mode,
  m.ssl_method,
  m.certificate_authority,
  m.token_issued_at,
  m.token_expires_at,
  m.provider_status,
  m.provider_ssl_status,
  m.provider_snapshot_json,
  m.dns_target_observed,
  m.https_probe_passed,
  m.https_probe_checked_at,
  m.failure_code,
  m.ever_activated,
  m.last_recheck_at,
  m.last_renewal_alert_at,
  m.last_renewal_alert_key,
  m.idempotency_key
`;

function parseProviderSnapshot(raw: string | null): CloudflareCustomHostname | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CloudflareCustomHostname;
    if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strips any unexpected/sensitive fields before storing provider snapshot JSON in D1.
 */
export function serializeSanitizedProviderSnapshot(
  provider: CloudflareCustomHostname | null,
): string | null {
  if (!provider) return null;
  const safe: CloudflareCustomHostname = {
    id: provider.id,
    hostname: provider.hostname,
    status: provider.status,
    ...(provider.verification_errors ? { verification_errors: [...provider.verification_errors] } : {}),
    ...(provider.ownership_verification
      ? {
          ownership_verification: {
            type: "txt",
            name: provider.ownership_verification.name,
            value: provider.ownership_verification.value,
          },
        }
      : {}),
    ...(provider.ownership_verification_http
      ? {
          ownership_verification_http: {
            http_url: provider.ownership_verification_http.http_url,
            http_body: provider.ownership_verification_http.http_body,
          },
        }
      : {}),
    ssl: {
      ...(provider.ssl.id ? { id: provider.ssl.id } : {}),
      status: provider.ssl.status,
      method: provider.ssl.method,
      type: provider.ssl.type,
      ...(provider.ssl.certificate_authority
        ? { certificate_authority: provider.ssl.certificate_authority }
        : {}),
      ...(provider.ssl.validation_records
        ? { validation_records: [...provider.ssl.validation_records] }
        : {}),
      ...(provider.ssl.dcv_delegation_records
        ? { dcv_delegation_records: [...provider.ssl.dcv_delegation_records] }
        : {}),
      ...(provider.ssl.validation_errors
        ? { validation_errors: [...provider.ssl.validation_errors] }
        : {}),
      ...(provider.ssl.settings ? { settings: { ...provider.ssl.settings } } : {}),
    },
    ...(provider.created_at ? { created_at: provider.created_at } : {}),
  };
  return JSON.stringify(safe);
}

function mapJoinedRow(row: RawJoinedDomainRow, fallbackId: number): TenantDomainRecord {
  const everActivated =
    row.ever_activated === 1 || (row.kind === "custom" && row.status === "active");
  return {
    id: typeof row.domain_id === "number" && row.domain_id >= 1 ? row.domain_id : fallbackId,
    tenantId: row.tenant_id,
    hostname: row.host,
    kind: row.kind,
    cfCustomHostnameId: row.cf_custom_hostname_id,
    status: row.status,
    sslStatus: row.ssl_status,
    isPrimary: row.is_primary === 1,
    verifiedAt: row.verified_at,
    lastCheckedAt: row.last_checked_at,
    quarantinedUntil: row.quarantined_until,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    connectMode: row.connect_mode,
    sslMethod: row.ssl_method,
    certificateAuthority: row.certificate_authority,
    tokenIssuedAt: row.token_issued_at,
    tokenExpiresAt: row.token_expires_at,
    providerStatus: row.provider_status,
    providerSslStatus: row.provider_ssl_status,
    providerSnapshot: parseProviderSnapshot(row.provider_snapshot_json),
    dnsTargetObserved: row.dns_target_observed,
    httpsProbePassed: row.https_probe_passed === 1,
    httpsProbeCheckedAt: row.https_probe_checked_at,
    failureCode: row.failure_code,
    everActivated,
    lastRecheckAt: row.last_recheck_at,
    lastRenewalAlertAt: row.last_renewal_alert_at,
    lastRenewalAlertKey: row.last_renewal_alert_key,
    idempotencyKey: row.idempotency_key,
  };
}

export async function listTenantDomains(
  platformDb: D1Database,
  tenantId: string,
): Promise<TenantDomainListResult> {
  await ensureDomainMetadataSchema(platformDb);

  const res = await platformDb
    .prepare(
      `SELECT ${SELECT_JOINED_DOMAIN_FIELDS}
       FROM tenant_hosts th
       LEFT JOIN tenant_host_metadata m ON m.host = th.host
       WHERE th.tenant_id = ?
       ORDER BY CASE WHEN th.kind = 'subdomain' THEN 0 ELSE 1 END ASC,
                COALESCE(m.domain_id, 999999) ASC,
                th.created_at ASC`,
    )
    .bind(tenantId)
    .all<RawJoinedDomainRow>();

  const rows = res.results ?? [];
  const items = rows.map((row, idx) => mapJoinedRow(row, idx + 1));
  const customDomainLocked = items.some(
    (item) => item.kind === "custom" && (item.everActivated || item.status === "active"),
  );

  return {
    items,
    customDomainLocked,
    maxCustomHostnames: MAX_CUSTOM_HOSTNAMES_PER_TENANT,
  };
}

/**
 * Resolves a single domain belonging strictly to `tenantId` by numeric `domainId`
 * OR normalized hostname. Returns `null` if not found or owned by another tenant.
 */
export async function getTenantDomainBySelector(
  platformDb: D1Database,
  tenantId: string,
  selector: string | number,
): Promise<TenantDomainRecord | null> {
  await ensureDomainMetadataSchema(platformDb);

  const raw = String(selector).trim();
  if (!raw) return null;

  const isNumericId = /^\d+$/.test(raw);
  if (isNumericId) {
    const numericId = Number(raw);
    if (!Number.isSafeInteger(numericId) || numericId < 1) return null;

    const byMetaId = await platformDb
      .prepare(
        `SELECT ${SELECT_JOINED_DOMAIN_FIELDS}
         FROM tenant_hosts th
         INNER JOIN tenant_host_metadata m ON m.host = th.host
         WHERE th.tenant_id = ? AND m.domain_id = ?
         LIMIT 1`,
      )
      .bind(tenantId, numericId)
      .first<RawJoinedDomainRow>();

    if (byMetaId) {
      return mapJoinedRow(byMetaId, numericId);
    }

    // Fallback for platform subdomain rows (id = 1) that predate `tenant_host_metadata`
    const listed = await listTenantDomains(platformDb, tenantId);
    return listed.items.find((item) => item.id === numericId) ?? null;
  }

  const normalizedHost = raw.toLowerCase().replace(/\.$/, "");
  const byHost = await platformDb
    .prepare(
      `SELECT ${SELECT_JOINED_DOMAIN_FIELDS}
       FROM tenant_hosts th
       LEFT JOIN tenant_host_metadata m ON m.host = th.host
       WHERE th.tenant_id = ? AND th.host = ?
       LIMIT 1`,
    )
    .bind(tenantId, normalizedHost)
    .first<RawJoinedDomainRow>();

  if (!byHost) return null;
  return mapJoinedRow(byHost, byHost.domain_id ?? 1);
}

export interface ClaimTenantCustomHostnameInput {
  readonly tenantId: string;
  readonly hostname: string;
  readonly connectMode: DomainConnectMode;
  readonly sslMethod: DomainSslMethod;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly requestId: string;
  readonly idempotencyKey?: string | null;
  readonly nowMs?: number;
}

export interface ClaimTenantCustomHostnameResult {
  readonly record: TenantDomainRecord;
  readonly alreadyExisted: boolean;
}

/**
 * Claims a custom hostname locally in `pending` state BEFORE calling Cloudflare,
 * enforcing:
 * - Cross-tenant uniqueness (`409 DOMAIN_ALREADY_CLAIMED`)
 * - Same-tenant retry reconciliation (returns `alreadyExisted: true` so caller reconciles
 *   existing Cloudflare record instead of duplicating)
 * - REQ-065 max-2 / one-domain-set compatibility
 */
export async function claimTenantCustomHostname(
  platformDb: D1Database,
  input: ClaimTenantCustomHostnameInput,
): Promise<ClaimTenantCustomHostnameResult> {
  await ensureDomainMetadataSchema(platformDb);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const hostname = input.hostname.trim().toLowerCase().replace(/\.$/, "");

  // 1. Check global ownership in `tenant_hosts` (neutral error without leaking other tenant)
  const existingGlobal = await platformDb
    .prepare("SELECT host, tenant_id, status FROM tenant_hosts WHERE host = ? LIMIT 1")
    .bind(hostname)
    .first<{ readonly host: string; readonly tenant_id: string; readonly status: TenantHostStatus }>();

  if (existingGlobal) {
    if (existingGlobal.tenant_id !== input.tenantId) {
      throw new DomainConflictError(
        "DOMAIN_ALREADY_CLAIMED",
        `Domain ${hostname} sudah digunakan oleh website lain.`,
      );
    }

    if (existingGlobal.status === "deleting") {
      throw new DomainConflictError(
        "DOMAIN_CLEANUP_PENDING",
        `Domain ${hostname} sedang dalam proses penghapusan. Tunggu hingga pembersihan selesai.`,
      );
    }

    const existing = await getTenantDomainBySelector(platformDb, input.tenantId, hostname);
    if (existing) {
      return { record: existing, alreadyExisted: true };
    }
  }

  // 2. Enforce REQ-065 per-tenant domain set cap (max 2 custom hostnames, same domain pair)
  // Exclude `deleting` rows consistently with the atomic INSERT guard below.
  const listed = await listTenantDomains(platformDb, input.tenantId);
  const existingCustomHosts = listed.items
    .filter((item) => item.kind === "custom" && item.status !== "deleting")
    .map((item) => item.hostname);
  assertTenantDomainSetCompatibility(existingCustomHosts, hostname);
  const counterpartHost = hostname.startsWith("www.") ? hostname.slice(4) : `www.${hostname}`;

  // 3. Allocate next sequential positive `domain_id` for this tenant (>= 2 when subdomain exists)
  const maxIdRow = await platformDb
    .prepare(
      `SELECT COALESCE(MAX(domain_id), 0) AS max_id
       FROM tenant_host_metadata
       WHERE tenant_id = ?`,
    )
    .bind(input.tenantId)
    .first<{ readonly max_id: number }>();
  const baselineMin = listed.items.some((item) => item.kind === "subdomain") ? 1 : 0;
  const nextDomainId = Math.max(baselineMin, maxIdRow?.max_id ?? 0) + 1;

  const preparedAudit = preparePlatformAuditRecord({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "domain.connect.requested",
    targetType: "tenant_host",
    targetId: hostname,
    tenantId: input.tenantId,
    outcome: "success",
    requestId: input.requestId,
    metadata: {
      hostname,
      connectMode: input.connectMode,
      sslMethod: input.sslMethod,
      domainId: nextDomainId,
    },
    createdAtMs: nowMs,
  });

  try {
    // Atomic max-2 custom hostname cap + same-tenant counterpart compatibility + race-safe sequential domain_id allocation inside ONE D1 batch
    const [insertHostRes] = await platformDb.batch([
      platformDb
        .prepare(
          `INSERT INTO tenant_hosts (
             host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status,
             is_primary, verified_at, last_checked_at, quarantined_until,
             version, created_at, updated_at
           )
           SELECT ?, ?, 'custom', NULL, 'pending', 'pending', 0, NULL, NULL, NULL, 1, ?, ?
           WHERE (
             SELECT COUNT(*) FROM tenant_hosts
             WHERE tenant_id = ? AND kind = 'custom' AND status != 'deleting'
           ) < ?
             AND NOT EXISTS (
               SELECT 1 FROM tenant_hosts
               WHERE tenant_id = ?
                 AND kind = 'custom'
                 AND status != 'deleting'
                 AND host != ?
                 AND host != ?
             )`,
        )
        .bind(
          hostname,
          input.tenantId,
          nowMs,
          nowMs,
          input.tenantId,
          MAX_CUSTOM_HOSTNAMES_PER_TENANT,
          input.tenantId,
          hostname,
          counterpartHost,
        ),
      platformDb
        .prepare(
          `INSERT INTO tenant_host_metadata (
             host, tenant_id, domain_id, connect_mode, ssl_method,
             provider_status, provider_ssl_status, https_probe_passed,
             ever_activated, idempotency_key, created_at, updated_at
           )
           SELECT
             ?, ?,
             COALESCE((SELECT MAX(domain_id) FROM tenant_host_metadata WHERE tenant_id = ?), ?) + 1,
             ?, ?, 'pending', 'pending_validation', 0, 0, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM tenant_hosts WHERE host = ? AND tenant_id = ?
           )`,
        )
        .bind(
          hostname,
          input.tenantId,
          input.tenantId,
          baselineMin,
          input.connectMode,
          input.sslMethod,
          input.idempotencyKey ?? null,
          nowMs,
          nowMs,
          hostname,
          input.tenantId,
        ),
      platformDb
        .prepare(
          `INSERT INTO platform_audit (
             id, actor_user_id, actor_role, action, target_type, target_id,
             tenant_id, reason, outcome, request_id, metadata_json, created_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM tenant_hosts WHERE host = ? AND tenant_id = ?
           )`,
        )
        .bind(
          preparedAudit.id,
          preparedAudit.actorUserId,
          preparedAudit.actorRole,
          preparedAudit.action,
          preparedAudit.targetType,
          preparedAudit.targetId,
          preparedAudit.tenantId,
          preparedAudit.reason,
          preparedAudit.outcome,
          preparedAudit.requestId,
          preparedAudit.metadataJson,
          preparedAudit.createdAt,
          hostname,
          input.tenantId,
        ),
    ]);

    if ((insertHostRes?.meta?.changes ?? 0) === 0) {
      const raced = await platformDb
        .prepare("SELECT tenant_id FROM tenant_hosts WHERE host = ? LIMIT 1")
        .bind(hostname)
        .first<{ readonly tenant_id: string }>();
      if (raced && raced.tenant_id !== input.tenantId) {
        throw new DomainConflictError(
          "DOMAIN_ALREADY_CLAIMED",
          `Domain ${hostname} sudah digunakan oleh website lain.`,
        );
      }
      if (raced && raced.tenant_id === input.tenantId) {
        const sameTenant = await getTenantDomainBySelector(platformDb, input.tenantId, hostname);
        if (sameTenant) {
          return { record: sameTenant, alreadyExisted: true };
        }
      }
      const freshList = await listTenantDomains(platformDb, input.tenantId);
      const activeCustomHosts = freshList.items
        .filter((item) => item.kind === "custom" && item.status !== "deleting")
        .map((item) => item.hostname);
      assertTenantDomainSetCompatibility(activeCustomHosts, hostname);
      throw new DomainConflictError(
        "DOMAIN_LIMIT_REACHED",
        `Maksimal ${MAX_CUSTOM_HOSTNAMES_PER_TENANT} custom hostname per website (misalnya domain utama dan versi www).`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
      const raced = await platformDb
        .prepare("SELECT tenant_id FROM tenant_hosts WHERE host = ? LIMIT 1")
        .bind(hostname)
        .first<{ readonly tenant_id: string }>();
      if (raced && raced.tenant_id !== input.tenantId) {
        throw new DomainConflictError(
          "DOMAIN_ALREADY_CLAIMED",
          `Domain ${hostname} sudah digunakan oleh website lain.`,
        );
      }
      const sameTenant = await getTenantDomainBySelector(platformDb, input.tenantId, hostname);
      if (sameTenant) {
        return { record: sameTenant, alreadyExisted: true };
      }
    }
    throw err;
  }

  const created = await getTenantDomainBySelector(platformDb, input.tenantId, hostname);
  if (!created) {
    throw new DomainNotFoundError("Gagal memuat record domain yang baru didaftarkan.");
  }
  return { record: created, alreadyExisted: false };
}

function mapProviderToLocalHostStatus(params: {
  readonly providerStatus: string;
  readonly providerSslStatus: string;
  readonly cnameMatchesTarget: boolean;
  readonly connectMode: DomainConnectMode;
}): { readonly status: TenantHostStatus; readonly sslStatus: string } {
  const pStatus = params.providerStatus.trim().toLowerCase();
  const pSsl = params.providerSslStatus.trim().toLowerCase();

  if (pStatus === "moved") {
    return { status: "moved", sslStatus: pSsl };
  }
  if (pStatus === "blocked") {
    return { status: "failed", sslStatus: pSsl };
  }
  if (pStatus === "deleted" || pStatus === "pending_deletion") {
    return { status: "deleting", sslStatus: pSsl };
  }

  // Activate local application routing ONLY when BOTH status & ssl.status are active
  // AND DNS points to the SaaS CNAME target (PLAN §3.2 & §12.2).
  if (pStatus === "active" && pSsl === "active" && params.cnameMatchesTarget) {
    return { status: "active", sslStatus: "active" };
  }

  // In migration mode before CNAME cutover, keep local host status `pending` (so edge routing
  // is not prematurely activated) while preserving raw `providerStatus` & `providerSslStatus`
  // in `tenant_host_metadata` so Step 3 CNAME cutover unlocks!
  return { status: "pending", sslStatus: pSsl };
}

export interface SyncDomainProviderStateInput {
  readonly tenantId: string;
  readonly hostname: string;
  readonly connectMode: DomainConnectMode;
  readonly sslMethod: DomainSslMethod;
  readonly provider: CloudflareCustomHostname;
  readonly cnameMatchesTarget: boolean;
  readonly dnsTargetObserved: string | null;
  readonly httpsProbePassed?: boolean;
  readonly failureCode?: string | null;
  readonly tokenRefreshed?: boolean;
  readonly previousTokenIssuedAt?: number | null;
  readonly expectedVersion?: number;
  readonly isManualRecheck?: boolean;
  readonly nowMs?: number;
}

/**
 * Persists Cloudflare provider state + DNS observation + token age metadata atomically.
 * Bumps `tenants.cache_version` and evicts isolate cache when routing status changes.
 */
export async function syncDomainProviderState(
  platformDb: D1Database,
  input: SyncDomainProviderStateInput,
): Promise<TenantDomainRecord> {
  await ensureDomainMetadataSchema(platformDb);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const hostname = input.hostname.trim().toLowerCase().replace(/\.$/, "");

  const current = await getTenantDomainBySelector(platformDb, input.tenantId, hostname);
  if (!current) {
    throw new DomainNotFoundError("Domain tidak ditemukan untuk tenant ini.");
  }
  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
    throw new DomainConflictError(
      "STALE_VERSION",
      "Versi data domain sudah berubah. Muat ulang halaman sebelum mencoba lagi.",
    );
  }

  const mapped = mapProviderToLocalHostStatus({
    providerStatus: input.provider.status,
    providerSslStatus: input.provider.ssl.status,
    cnameMatchesTarget: input.cnameMatchesTarget,
    connectMode: input.connectMode,
  });

  const hasDcvRecords =
    Boolean(input.provider.ssl.validation_records?.length) ||
    Boolean(input.provider.ssl.dcv_delegation_records?.length) ||
    Boolean(input.provider.ownership_verification);

  const tokenIssuedAt = input.tokenRefreshed
    ? nowMs
    : input.previousTokenIssuedAt ?? current.tokenIssuedAt ?? (hasDcvRecords ? nowMs : null);

  const tokenAssessment =
    tokenIssuedAt !== null
      ? evaluateDcvTokenAge({
          certificateAuthority: input.provider.ssl.certificate_authority,
          issuedAtMs: tokenIssuedAt,
          nowMs,
        })
      : null;

  const isNowActive = mapped.status === "active" && mapped.sslStatus === "active";
  const nextEverActivated = current.everActivated || isNowActive ? 1 : 0;
  const nextVerifiedAt = isNowActive ? current.verifiedAt ?? nowMs : current.verifiedAt;
  const nextHttpsProbePassed =
    input.httpsProbePassed !== undefined
      ? input.httpsProbePassed
        ? 1
        : 0
      : current.httpsProbePassed
        ? 1
        : 0;
  const nextHttpsProbeCheckedAt =
    input.httpsProbePassed !== undefined ? nowMs : current.httpsProbeCheckedAt;
  const routingChanged =
    current.status !== mapped.status || current.sslStatus !== mapped.sslStatus;

  const snapshotJson = serializeSanitizedProviderSnapshot(input.provider);

  const statements: D1PreparedStatement[] = [
    platformDb
      .prepare(
        `UPDATE tenant_hosts
         SET cf_custom_hostname_id = ?,
             status = ?,
             ssl_status = ?,
             verified_at = ?,
             last_checked_at = ?,
             version = version + 1,
             updated_at = ?
         WHERE host = ? AND tenant_id = ? AND version = ?`,
      )
      .bind(
        input.provider.id,
        mapped.status,
        mapped.sslStatus,
        nextVerifiedAt,
        nowMs,
        nowMs,
        hostname,
        input.tenantId,
        current.version,
      ),
    platformDb
      .prepare(
        `UPDATE tenant_host_metadata
         SET ssl_method = ?,
             certificate_authority = ?,
             token_issued_at = ?,
             token_expires_at = ?,
             provider_status = ?,
             provider_ssl_status = ?,
             provider_snapshot_json = ?,
             dns_target_observed = ?,
             https_probe_passed = ?,
             https_probe_checked_at = ?,
             failure_code = ?,
             ever_activated = ?,
             last_recheck_at = CASE WHEN ? = 1 THEN ? ELSE last_recheck_at END,
             updated_at = ?
         WHERE host = ? AND tenant_id = ?`,
      )
      .bind(
        input.sslMethod,
        input.provider.ssl.certificate_authority ?? null,
        tokenIssuedAt,
        tokenAssessment?.expiresAtMs ?? null,
        input.provider.status,
        input.provider.ssl.status,
        snapshotJson,
        input.dnsTargetObserved,
        nextHttpsProbePassed,
        nextHttpsProbeCheckedAt,
        input.failureCode ?? null,
        nextEverActivated,
        input.isManualRecheck ? 1 : 0,
        nowMs,
        nowMs,
        hostname,
        input.tenantId,
      ),
  ];

  if (routingChanged) {
    statements.push(
      platformDb
        .prepare(
          `UPDATE tenants
           SET cache_version = cache_version + 1,
               version = version + 1,
               updated_at = ?
           WHERE id = ?`,
        )
        .bind(nowMs, input.tenantId),
    );
  }

  const results = await platformDb.batch(statements);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    throw new DomainConflictError(
      "STALE_VERSION",
      "Versi data domain sudah berubah secara bersamaan. Muat ulang dan coba lagi.",
    );
  }

  if (routingChanged) {
    evictHostFromCache(hostname);
    evictTenantFromCache(input.tenantId);
  }

  const updated = await getTenantDomainBySelector(platformDb, input.tenantId, hostname);
  if (!updated) {
    throw new DomainNotFoundError("Domain tidak ditemukan setelah pembaruan.");
  }
  return updated;
}

export interface PromoteDomainToPrimaryInput {
  readonly tenantId: string;
  readonly hostname: string;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly requestId: string;
  readonly dnsTargetObserved: string | null;
  readonly provider?: CloudflareCustomHostname | null;
  readonly nowMs?: number;
}

/**
 * Transactionally promotes an active, verified hostname to tenant primary (PLAN §3.1):
 * - Demotes the previous primary to alias (`is_primary = 0`)
 * - Promotes the target hostname (`is_primary = 1`, `status = 'active'`, `ssl_status = 'active'`)
 * - Increments `tenants.cache_version` (invalidating edge cache atomically)
 * - Writes `platform_audit` in the SAME `D1Database.batch`
 * - Evicts in-isolate host resolution cache (`evictTenantFromCache` + `evictHostFromCache`)
 */
export async function promoteDomainToPrimary(
  platformDb: D1Database,
  input: PromoteDomainToPrimaryInput,
): Promise<TenantDomainRecord> {
  await ensureDomainMetadataSchema(platformDb);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const hostname = input.hostname.trim().toLowerCase().replace(/\.$/, "");

  const current = await getTenantDomainBySelector(platformDb, input.tenantId, hostname);
  if (!current) {
    throw new DomainNotFoundError("Domain tidak ditemukan untuk tenant ini.");
  }
  if (current.version !== input.expectedVersion) {
    throw new DomainConflictError(
      "STALE_VERSION",
      "Versi domain sudah berubah. Muat ulang sebelum mengubah domain utama.",
    );
  }

  const nextVersion = input.expectedVersion + 1;

  const preparedAudit = preparePlatformAuditRecord({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "domain.promoted_primary",
    targetType: "tenant_host",
    targetId: hostname,
    tenantId: input.tenantId,
    outcome: "success",
    requestId: input.requestId,
    metadata: {
      hostname,
      kind: current.kind,
      cfCustomHostnameId: current.cfCustomHostnameId,
    },
    createdAtMs: nowMs,
  });

  // Single atomic D1 batch respecting `tenant_hosts_one_primary_per_tenant_idx`:
  // - Statement 0 demotes any other primary ONLY IF target still has `version = expectedVersion`.
  // - Statement 1 promotes target (`version` -> `expectedVersion + 1`).
  // - Statements 2..4 (cache_version, audit, metadata) are ALL gated on
  //   `EXISTS (SELECT 1 FROM tenant_hosts WHERE host = ? AND tenant_id = ? AND version = nextVersion AND is_primary = 1)`.
  // On a stale version race, EVERY statement affects 0 rows and existing primary stays untouched!
  const statements: D1PreparedStatement[] = [
    // 0. Demote previous primary ONLY when target version still matches expectedVersion
    platformDb
      .prepare(
        `UPDATE tenant_hosts
         SET is_primary = 0,
             version = version + 1,
             updated_at = ?
         WHERE tenant_id = ?
           AND is_primary = 1
           AND host != ?
           AND EXISTS (
             SELECT 1 FROM tenant_hosts
             WHERE host = ? AND tenant_id = ? AND version = ?
           )`,
      )
      .bind(nowMs, input.tenantId, hostname, hostname, input.tenantId, input.expectedVersion),
    // 1. Promote target hostname atomically with optimistic version check
    platformDb
      .prepare(
        `UPDATE tenant_hosts
         SET is_primary = 1,
             status = 'active',
             ssl_status = 'active',
             verified_at = COALESCE(verified_at, ?),
             last_checked_at = ?,
             version = version + 1,
             updated_at = ?
         WHERE host = ? AND tenant_id = ? AND version = ?`,
      )
      .bind(nowMs, nowMs, nowMs, hostname, input.tenantId, input.expectedVersion),
    // 2. Bump tenant cache_version ONLY if promotion succeeded (`version = expectedVersion + 1`)
    platformDb
      .prepare(
        `UPDATE tenants
         SET cache_version = cache_version + 1,
             version = version + 1,
             updated_at = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM tenant_hosts
             WHERE host = ? AND tenant_id = ? AND version = ? AND is_primary = 1
           )`,
      )
      .bind(nowMs, input.tenantId, hostname, input.tenantId, nextVersion),
    // 3. Append-only audit row ONLY if promotion succeeded (`version = expectedVersion + 1`)
    platformDb
      .prepare(
        `INSERT INTO platform_audit (
           id, actor_user_id, actor_role, action, target_type, target_id,
           tenant_id, reason, outcome, request_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM tenant_hosts
           WHERE host = ? AND tenant_id = ? AND version = ? AND is_primary = 1
         )`,
      )
      .bind(
        preparedAudit.id,
        preparedAudit.actorUserId,
        preparedAudit.actorRole,
        preparedAudit.action,
        preparedAudit.targetType,
        preparedAudit.targetId,
        preparedAudit.tenantId,
        preparedAudit.reason,
        preparedAudit.outcome,
        preparedAudit.requestId,
        preparedAudit.metadataJson,
        preparedAudit.createdAt,
        hostname,
        input.tenantId,
        nextVersion,
      ),
  ];

  if (current.kind === "custom") {
    const snapshotJson = input.provider
      ? serializeSanitizedProviderSnapshot(input.provider)
      : null;
    statements.push(
      platformDb
        .prepare(
          `UPDATE tenant_host_metadata
           SET provider_status = COALESCE(?, provider_status),
               provider_ssl_status = COALESCE(?, provider_ssl_status),
               provider_snapshot_json = COALESCE(?, provider_snapshot_json),
               dns_target_observed = COALESCE(?, dns_target_observed),
               https_probe_passed = 1,
               https_probe_checked_at = ?,
               ever_activated = 1,
               failure_code = NULL,
               updated_at = ?
           WHERE host = ? AND tenant_id = ?
             AND EXISTS (
               SELECT 1 FROM tenant_hosts
               WHERE host = ? AND tenant_id = ? AND version = ? AND is_primary = 1
             )`,
        )
        .bind(
          input.provider?.status ?? "active",
          input.provider?.ssl.status ?? "active",
          snapshotJson,
          input.dnsTargetObserved,
          nowMs,
          nowMs,
          hostname,
          input.tenantId,
          hostname,
          input.tenantId,
          nextVersion,
        ),
    );
  }

  const batchRes = await platformDb.batch(statements);
  if ((batchRes[1]?.meta?.changes ?? 0) === 0) {
    throw new DomainConflictError(
      "STALE_VERSION",
      "Gagal mempromosikan domain karena versi data sudah berubah.",
    );
  }

  evictHostFromCache(hostname);
  evictTenantFromCache(input.tenantId);

  const promoted = await getTenantDomainBySelector(platformDb, input.tenantId, hostname);
  if (!promoted) {
    throw new DomainNotFoundError("Domain utama tidak ditemukan setelah promosi.");
  }
  return promoted;
}

export interface BeginDomainRemovalInput {
  readonly tenantId: string;
  readonly hostname: string;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly requestId: string;
  /** True for tenant owner self-service (enforces REQ-065 active lock); false for operator removal. */
  readonly enforceOwnerActiveLock: boolean;
  readonly nowMs?: number;
}

/**
 * Step 1 of safe domain removal (PLAN §3.1):
 * - Rejects removal of platform fallback subdomain.
 * - Enforces REQ-065 lock when `enforceOwnerActiveLock === true` (`403 DOMAIN_LOCKED`).
 * - In ONE local transaction, restores platform subdomain as primary if removing primary,
 *   disables custom host routing (`status = 'deleting'`, `is_primary = 0`), bumps `tenants.cache_version`,
 *   writes `platform_audit`, and evicts isolate caches.
 */
export async function beginDomainRemoval(
  platformDb: D1Database,
  input: BeginDomainRemovalInput,
): Promise<{ readonly record: TenantDomainRecord; readonly cfCustomHostnameId: string | null }> {
  await ensureDomainMetadataSchema(platformDb);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const hostname = input.hostname.trim().toLowerCase().replace(/\.$/, "");

  const current = await getTenantDomainBySelector(platformDb, input.tenantId, hostname);
  if (!current) {
    throw new DomainNotFoundError("Domain tidak ditemukan untuk tenant ini.");
  }

  if (current.kind !== "custom") {
    throw new DomainEligibilityError(
      "FORBIDDEN",
      "Subdomain fallback platform tidak dapat dihapus.",
    );
  }

  if (input.enforceOwnerActiveLock && (current.everActivated || current.status === "active")) {
    throw new DomainEligibilityError(
      "DOMAIN_LOCKED",
      "Domain terkunci. Untuk ganti domain, hubungi admin.",
    );
  }

  if (current.version !== input.expectedVersion) {
    throw new DomainConflictError(
      "STALE_VERSION",
      "Versi domain sudah berubah. Muat ulang sebelum menghapus domain.",
    );
  }

  const { statement: auditStmt } = buildPlatformAuditStatement(platformDb, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "domain.removal.started",
    targetType: "tenant_host",
    targetId: hostname,
    tenantId: input.tenantId,
    outcome: "success",
    requestId: input.requestId,
    metadata: {
      hostname,
      wasPrimary: current.isPrimary,
      cfCustomHostnameId: current.cfCustomHostnameId,
    },
    createdAtMs: nowMs,
  });

  const statements: D1PreparedStatement[] = [
    // Disable custom host routing immediately
    platformDb
      .prepare(
        `UPDATE tenant_hosts
         SET status = 'deleting',
             is_primary = 0,
             version = version + 1,
             updated_at = ?
         WHERE host = ? AND tenant_id = ? AND version = ?`,
      )
      .bind(nowMs, hostname, input.tenantId, input.expectedVersion),
  ];

  // If removed host was primary, restore verified platform fallback subdomain as primary atomically!
  if (current.isPrimary) {
    statements.push(
      platformDb
        .prepare(
          `UPDATE tenant_hosts
           SET is_primary = 1,
               version = version + 1,
               updated_at = ?
           WHERE tenant_id = ? AND kind = 'subdomain' AND status = 'active'`,
        )
        .bind(nowMs, input.tenantId),
    );
  }

  statements.push(
    platformDb
      .prepare(
        `UPDATE tenants
         SET cache_version = cache_version + 1,
             version = version + 1,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(nowMs, input.tenantId),
    auditStmt,
  );

  const res = await platformDb.batch(statements);
  if ((res[0]?.meta?.changes ?? 0) === 0) {
    throw new DomainConflictError(
      "STALE_VERSION",
      "Gagal memulai penghapusan domain karena versi data sudah berubah.",
    );
  }

  evictHostFromCache(hostname);
  evictTenantFromCache(input.tenantId);

  return {
    record: { ...current, status: "deleting", isPrimary: false, version: current.version + 1 },
    cfCustomHostnameId: current.cfCustomHostnameId,
  };
}

/**
 * Step 2 of safe domain removal: once Cloudflare provider deletion succeeds,
 * removes the local `tenant_hosts` row (releasing the claim cleanly) and logs audit.
 */
export async function finalizeDomainRemoval(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly hostname: string;
    readonly cfCustomHostnameId: string | null;
    readonly actorUserId: string | null;
    readonly actorRole: string;
    readonly requestId: string;
    readonly action?: string;
    readonly reason?: string | null;
    readonly extraMetadata?: Readonly<Record<string, unknown>>;
    readonly nowMs?: number;
  },
): Promise<{ readonly deleted: boolean; readonly restoredSubdomainPrimary: boolean }> {
  await ensureDomainMetadataSchema(platformDb);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const hostname = input.hostname.trim().toLowerCase().replace(/\.$/, "");

  const { statement: auditStmt } = buildPlatformAuditStatement(platformDb, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: input.action ?? "domain.removal.completed",
    targetType: "tenant_host",
    targetId: hostname,
    tenantId: input.tenantId,
    reason: input.reason ?? null,
    outcome: "success",
    requestId: input.requestId,
    metadata: {
      hostname,
      cfCustomHostnameId: input.cfCustomHostnameId,
      ...(input.extraMetadata ?? {}),
    },
    createdAtMs: nowMs,
  });

  const [delMeta, delHost, restoredFallback] = await platformDb.batch([
    platformDb
      .prepare("DELETE FROM tenant_host_metadata WHERE host = ? AND tenant_id = ?")
      .bind(hostname, input.tenantId),
    platformDb
      .prepare("DELETE FROM tenant_hosts WHERE host = ? AND tenant_id = ? AND kind = 'custom'")
      .bind(hostname, input.tenantId),
    // Restore active platform subdomain fallback (`*.situsku.click`) as primary whenever
    // the deleted host was primary (or no active primary remains for this tenant).
    platformDb
      .prepare(
        `UPDATE tenant_hosts
         SET is_primary = 1,
             version = version + 1,
             updated_at = ?
         WHERE tenant_id = ?
           AND kind = 'subdomain'
           AND status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM tenant_hosts
             WHERE tenant_id = ? AND is_primary = 1
           )`,
      )
      .bind(nowMs, input.tenantId, input.tenantId),
    platformDb
      .prepare(
        `UPDATE tenants
         SET cache_version = cache_version + 1,
             version = version + 1,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(nowMs, input.tenantId),
    auditStmt,
  ]);
  void delMeta;

  evictHostFromCache(hostname);
  evictTenantFromCache(input.tenantId);

  return {
    deleted: (delHost?.meta?.changes ?? 0) > 0,
    restoredSubdomainPrimary: (restoredFallback?.meta?.changes ?? 0) > 0,
  };
}

async function consumeSingleDomainBucket(
  platformDb: D1Database,
  bucketKey: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): Promise<{ readonly allowed: boolean; readonly retryAfterSeconds: number; readonly count: number }> {
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;

  const row = await platformDb
    .prepare(
      `INSERT INTO domain_recheck_rate_limits (bucket_key, window_start, count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         count = CASE
           WHEN domain_recheck_rate_limits.window_start = excluded.window_start
             THEN domain_recheck_rate_limits.count + 1
           ELSE 1
         END,
         window_start = excluded.window_start,
         updated_at = excluded.updated_at
       RETURNING count, window_start`,
    )
    .bind(bucketKey, windowStart, nowMs)
    .first<{ readonly count: number; readonly window_start: number }>();

  const count = row?.count ?? 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - nowMs) / 1000));
  return {
    allowed: count <= limit,
    retryAfterSeconds,
    count,
  };
}

/**
 * Atomic per-domain + per-tenant rate limiter for manual "Periksa sekarang" rechecks (PLAN §3.2).
 * Throws `DomainRateLimitError` (`429 RATE_LIMITED`) when exceeded.
 */
export async function consumeDomainRecheckRateLimit(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly hostname: string;
    readonly nowMs?: number;
    readonly policy?: Partial<DomainRecheckRateLimitPolicy>;
  },
): Promise<{ readonly allowed: true }> {
  await ensureDomainMetadataSchema(platformDb);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const policy: DomainRecheckRateLimitPolicy = {
    ...DEFAULT_DOMAIN_RECHECK_RATE_LIMIT,
    ...(input.policy ?? {}),
  };

  const normalizedHost = input.hostname.trim().toLowerCase();
  const domainBucket = await consumeSingleDomainBucket(
    platformDb,
    `domain-recheck:host:${input.tenantId}:${normalizedHost}`,
    policy.perDomainLimit,
    policy.perDomainWindowMs,
    nowMs,
  );
  if (!domainBucket.allowed) {
    throw new DomainRateLimitError(domainBucket.retryAfterSeconds);
  }

  const tenantBucket = await consumeSingleDomainBucket(
    platformDb,
    `domain-recheck:tenant:${input.tenantId}`,
    policy.perTenantLimit,
    policy.perTenantWindowMs,
    nowMs,
  );
  if (!tenantBucket.allowed) {
    throw new DomainRateLimitError(tenantBucket.retryAfterSeconds);
  }

  return { allowed: true };
}

/**
 * Lists abandoned custom hostnames stuck in `pending`, `moved`, or `failed`
 * older than `staleAfterMs` (default 7 days; PLAN §3.1 & §12.2).
 * NEVER selects `active` hostnames or `subdomain` rows.
 */
export async function listStaleCustomHostnamesForReaper(
  platformDb: D1Database,
  options?: {
    readonly nowMs?: number;
    readonly staleAfterMs?: number;
    readonly limit?: number;
  },
): Promise<readonly StaleHostnameReaperCandidate[]> {
  await ensureDomainMetadataSchema(platformDb);
  const nowMs = Math.trunc(options?.nowMs ?? Date.now());
  const staleAfterMs = Math.max(60_000, options?.staleAfterMs ?? STALE_HOSTNAME_REAPER_THRESHOLD_MS);
  const cutoffMs = nowMs - staleAfterMs;
  const limit = Math.min(200, Math.max(1, options?.limit ?? 100));

  const res = await platformDb
    .prepare(
      `SELECT host, tenant_id, cf_custom_hostname_id, status, ssl_status, created_at, updated_at
       FROM tenant_hosts
       WHERE kind = 'custom'
         AND (
           status = 'deleting'
           OR (status IN ('pending', 'failed') AND created_at <= ?)
           OR (status = 'moved' AND updated_at <= ?)
         )
       ORDER BY CASE WHEN status = 'deleting' THEN 0 ELSE 1 END ASC, created_at ASC
       LIMIT ?`,
    )
    .bind(cutoffMs, cutoffMs, limit)
    .all<{
      readonly host: string;
      readonly tenant_id: string;
      readonly cf_custom_hostname_id: string | null;
      readonly status: TenantHostStatus;
      readonly ssl_status: string;
      readonly created_at: number;
      readonly updated_at: number;
    }>();

  return (res.results ?? []).map((row) => {
    const anchorMs = row.status === "moved" ? row.updated_at : row.created_at;
    const ageMs = Math.max(0, nowMs - anchorMs);
    return {
      host: row.host,
      tenantId: row.tenant_id,
      cfCustomHostnameId: row.cf_custom_hostname_id,
      status: row.status,
      sslStatus: row.ssl_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ageMs,
      ageDays: Math.floor(ageMs / DAY_MS),
    };
  });
}

/**
 * Lists all active custom hostnames along with owner (and agency owner, if applicable)
 * email recipients for the renewal-watch Cron (PLAN §3.2).
 */
export async function listActiveCustomHostnamesForRenewalWatch(
  platformDb: D1Database,
  options?: { readonly limit?: number },
): Promise<readonly ActiveCustomDomainWatchCandidate[]> {
  await ensureDomainMetadataSchema(platformDb);
  const limit = Math.min(200, Math.max(1, options?.limit ?? 100));

  const res = await platformDb
    .prepare(
      `SELECT
         th.host,
         th.tenant_id,
         th.cf_custom_hostname_id,
         th.status,
         th.ssl_status,
         th.is_primary,
         t.name AS tenant_name,
         t.handle AS tenant_handle,
         t.organization_id AS organization_id,
         t.agency_id AS agency_id,
         m.connect_mode,
         m.ssl_method,
         m.provider_snapshot_json,
         m.last_renewal_alert_at,
         m.last_renewal_alert_key
       FROM tenant_hosts th
       INNER JOIN tenants t ON t.id = th.tenant_id
       LEFT JOIN tenant_host_metadata m ON m.host = th.host
       WHERE th.kind = 'custom'
         AND th.status = 'active'
         AND t.status NOT IN ('provisioning', 'purging', 'purged')
       ORDER BY th.host ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{
      readonly host: string;
      readonly tenant_id: string;
      readonly cf_custom_hostname_id: string | null;
      readonly status: TenantHostStatus;
      readonly ssl_status: string;
      readonly is_primary: number;
      readonly tenant_name: string;
      readonly tenant_handle: string;
      readonly organization_id: string;
      readonly agency_id: string | null;
      readonly connect_mode: DomainConnectMode | null;
      readonly ssl_method: DomainSslMethod | null;
      readonly provider_snapshot_json: string | null;
      readonly last_renewal_alert_at: number | null;
      readonly last_renewal_alert_key: string | null;
    }>();

  const rows = res.results ?? [];
  const results: ActiveCustomDomainWatchCandidate[] = [];

  for (const row of rows) {
    const ownersRes = await platformDb
      .prepare(
        `SELECT DISTINCT u.email, u.name
         FROM members mem
         INNER JOIN users u ON u.id = mem.user_id
         WHERE mem.organization_id = ? AND mem.role = 'owner'
         ORDER BY u.email ASC`,
      )
      .bind(row.organization_id)
      .all<{ readonly email: string; readonly name: string }>();

    const recipientsMap = new Map<string, { readonly email: string; readonly name: string }>();
    for (const owner of ownersRes.results ?? []) {
      recipientsMap.set(owner.email.trim().toLowerCase(), {
        email: owner.email.trim().toLowerCase(),
        name: owner.name,
      });
    }

    // Also include agency payer owner if agency-managed (PLAN §3.2)
    if (row.agency_id) {
      const agencyOwner = await platformDb
        .prepare(
          `SELECT u.email, u.name
           FROM agencies a
           INNER JOIN users u ON u.id = a.owner_user_id
           WHERE a.id = ?
           LIMIT 1`,
        )
        .bind(row.agency_id)
        .first<{ readonly email: string; readonly name: string }>();
      if (agencyOwner?.email) {
        const key = agencyOwner.email.trim().toLowerCase();
        if (!recipientsMap.has(key)) {
          recipientsMap.set(key, { email: key, name: agencyOwner.name });
        }
      }
    }

    results.push({
      host: row.host,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      tenantHandle: row.tenant_handle,
      cfCustomHostnameId: row.cf_custom_hostname_id,
      status: row.status,
      sslStatus: row.ssl_status,
      isPrimary: row.is_primary === 1,
      connectMode: row.connect_mode,
      sslMethod: row.ssl_method,
      providerSnapshot: parseProviderSnapshot(row.provider_snapshot_json),
      lastRenewalAlertAt: row.last_renewal_alert_at,
      lastRenewalAlertKey: row.last_renewal_alert_key,
      ownerEmails: Array.from(recipientsMap.values()),
    });
  }

  return results;
}

export async function recordRenewalWatchAlert(
  platformDb: D1Database,
  input: {
    readonly host: string;
    readonly tenantId: string;
    readonly alertKey: string;
    readonly issueCode: string;
    readonly emailOutcome: "submitted" | "failed" | "skipped";
    readonly requestId: string;
    readonly nowMs?: number;
  },
): Promise<void> {
  await ensureDomainMetadataSchema(platformDb);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const normalizedHost = input.host.trim().toLowerCase();

  const { statement: auditStmt } = buildPlatformAuditStatement(platformDb, {
    actorUserId: null,
    actorRole: "system_cron",
    action: "domain.renewal_watch.alert",
    targetType: "tenant_host",
    targetId: normalizedHost,
    tenantId: input.tenantId,
    outcome: input.emailOutcome === "failed" ? "error" : "success",
    requestId: input.requestId,
    metadata: {
      hostname: normalizedHost,
      issueCode: input.issueCode,
      emailOutcome: input.emailOutcome,
    },
    createdAtMs: nowMs,
  });

  // Upsert metadata alert tracking so deduplication works even for pre-existing `tenant_hosts` rows
  const statements: D1PreparedStatement[] = [auditStmt];
  if (input.emailOutcome === "submitted") {
    const existingMeta = await platformDb
      .prepare("SELECT host FROM tenant_host_metadata WHERE host = ? AND tenant_id = ? LIMIT 1")
      .bind(normalizedHost, input.tenantId)
      .first<{ readonly host: string }>();

    if (existingMeta) {
      statements.unshift(
        platformDb
          .prepare(
            `UPDATE tenant_host_metadata
             SET last_renewal_alert_at = ?,
                 last_renewal_alert_key = ?,
                 updated_at = ?
             WHERE host = ? AND tenant_id = ?`,
          )
          .bind(nowMs, input.alertKey, nowMs, normalizedHost, input.tenantId),
      );
    } else {
      const maxIdRow = await platformDb
        .prepare(
          `SELECT COALESCE(MAX(domain_id), 1) AS max_id
           FROM tenant_host_metadata
           WHERE tenant_id = ?`,
        )
        .bind(input.tenantId)
        .first<{ readonly max_id: number }>();
      const nextDomainId = (maxIdRow?.max_id ?? 1) + 1;
      statements.unshift(
        platformDb
          .prepare(
            `INSERT INTO tenant_host_metadata (
               host, tenant_id, domain_id, connect_mode, ssl_method,
               ever_activated, last_renewal_alert_at, last_renewal_alert_key,
               created_at, updated_at
             ) VALUES (?, ?, ?, 'new_domain', 'http', 1, ?, ?, ?, ?)`,
          )
          .bind(
            normalizedHost,
            input.tenantId,
            nextDomainId,
            nowMs,
            input.alertKey,
            nowMs,
            nowMs,
          ),
      );
    }
  }

  await platformDb.batch(statements);
}

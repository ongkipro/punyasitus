import { normalizeHost } from "@punyasitus/core";
import type { TenantStatus, TenantVertical } from "../platform/schema.ts";

/**
 * Maximum in-isolate memory cache TTL for active host resolutions (PLAN §3, ADR-0009).
 * Non-active / non-serving hosts are NEVER cached.
 */
export const MAX_HOST_CACHE_TTL_MS = 5_000;
export const DEFAULT_HOST_CACHE_TTL_MS = 5_000;

/**
 * Quarantine window applied when a custom or moved hostname is detached/reassigned (PLAN §3).
 */
export const MOVED_HOST_QUARANTINE_MS = 60_000;

const GRACE_WINDOW_MS = 72 * 60 * 60 * 1000; // H+1..H+3 (72h)
const LOCKED_WINDOW_MS = 168 * 60 * 60 * 1000; // H+4..H+7 (168h)

export type TenantHostStatus = "pending" | "active" | "failed" | "moved" | "deleting";
export type TenantHostKind = "subdomain" | "custom";

export interface ResolvedHostRecord {
  readonly host: string;
  readonly kind: TenantHostKind;
  readonly status: TenantHostStatus;
  readonly sslStatus: string;
  readonly isPrimary: boolean;
  readonly quarantinedUntil: number | null;
}

export interface ResolvedTenantRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: TenantVertical;
  readonly storedStatus: TenantStatus;
  readonly effectiveStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly cacheVersion: number;
  readonly schemaVersion: number;
  readonly trialEndsAt: number | null;
  readonly paidThrough: number | null;
}

export type HostResolutionNotFoundReason =
  | "unknown"
  | "pending"
  | "failed"
  | "moved"
  | "deleting"
  | "unverified_ssl"
  | "trial_custom_domain_disabled";

export type HostResolutionResult =
  | {
      readonly kind: "invalid_host";
      readonly host: string;
    }
  | {
      readonly kind: "not_found";
      readonly host: string;
      readonly reason: HostResolutionNotFoundReason;
    }
  | {
      readonly kind: "quarantined";
      readonly host: string;
      readonly quarantinedUntil: number;
    }
  | {
      readonly kind: "db_unavailable";
      readonly host: string;
      readonly errorCode: string;
    }
  | {
      readonly kind: "resolved";
      readonly host: string;
      readonly fromCache: boolean;
      readonly hostRecord: ResolvedHostRecord;
      readonly tenant: ResolvedTenantRecord;
      readonly primaryHost: string | null;
      readonly primaryHostKind: TenantHostKind | null;
    };

export interface ResolveTenantByHostOptions {
  readonly nowMs?: number;
  readonly cacheTtlMs?: number;
  readonly bypassCache?: boolean;
}

export interface QuarantineMovedHostInput {
  readonly host: string;
  readonly tenantId: string;
  readonly nowMs?: number;
}

export interface QuarantineMovedHostResult {
  readonly host: string;
  readonly tenantId: string;
  readonly quarantinedUntil: number;
  readonly updated: boolean;
}

interface RawHostJoinRow {
  readonly host: string;
  readonly host_kind: TenantHostKind;
  readonly host_status: TenantHostStatus;
  readonly ssl_status: string;
  readonly is_primary: number;
  readonly quarantined_until: number | null;
  readonly tenant_id: string;
  readonly organization_id: string;
  readonly handle: string;
  readonly tenant_name: string;
  readonly vertical: TenantVertical;
  readonly tenant_status: TenantStatus;
  readonly operator_hold: number;
  readonly trial_ends_at: number | null;
  readonly paid_through: number | null;
  readonly cache_version: number;
  readonly schema_version: number;
  readonly primary_host: string | null;
  readonly primary_host_kind: TenantHostKind | null;
  readonly primary_host_quarantined_until: number | null;
}

interface ActiveHostCacheEntry {
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly tenantId: string;
  readonly value: Extract<HostResolutionResult, { readonly kind: "resolved" }>;
}

const activeHostCache = new Map<string, ActiveHostCacheEntry>();

export function isTenantServingStatus(status: TenantStatus): boolean {
  return status === "trial" || status === "active" || status === "grace" || status === "locked";
}

/**
 * Computes authoritative effective tenant lifecycle status per PLAN §17.1 precedence:
 * 1. Terminal/provisioning states (`provisioning`, `purging`, `purged`) never resurrect.
 * 2. Operator hold overrides to `suspended`.
 * 3. `recovery` stays `recovery`.
 * 4. Stored `suspended` stays `suspended`.
 * 5. Deadline-bound `trial` / `active` / `grace` / `locked` evaluate against `nowMs`
 *    when `trialEndsAt` / `paidThrough` are present (no scheduler reliance).
 */
export function computeEffectiveTenantStatus(
  input: {
    readonly storedStatus: TenantStatus;
    readonly operatorHold: boolean;
    readonly trialEndsAt: number | null;
    readonly paidThrough: number | null;
  },
  nowMs: number,
): TenantStatus {
  const { storedStatus, operatorHold, trialEndsAt, paidThrough } = input;

  if (
    storedStatus === "provisioning" ||
    storedStatus === "purging" ||
    storedStatus === "purged"
  ) {
    return storedStatus;
  }

  if (operatorHold) {
    return "suspended";
  }

  if (storedStatus === "recovery" || storedStatus === "suspended") {
    return storedStatus;
  }

  if (storedStatus === "trial") {
    if (trialEndsAt !== null && nowMs >= trialEndsAt) {
      return "suspended";
    }
    return "trial";
  }

  // storedStatus is "active" | "grace" | "locked"
  if (paidThrough !== null) {
    if (nowMs < paidThrough) {
      return "active";
    }
    if (nowMs < paidThrough + GRACE_WINDOW_MS) {
      return "grace";
    }
    if (nowMs < paidThrough + LOCKED_WINDOW_MS) {
      return "locked";
    }
    return "suspended";
  }

  return storedStatus;
}

function nextSuspensionDeadlineMs(
  storedStatus: TenantStatus,
  trialEndsAt: number | null,
  paidThrough: number | null,
): number | null {
  if (storedStatus === "trial" && trialEndsAt !== null) {
    return trialEndsAt;
  }
  if (
    (storedStatus === "active" || storedStatus === "grace" || storedStatus === "locked") &&
    paidThrough !== null
  ) {
    return paidThrough + LOCKED_WINDOW_MS;
  }
  return null;
}

function clampCacheTtlMs(cacheTtlMs: number | undefined): number {
  if (cacheTtlMs === undefined || Number.isNaN(cacheTtlMs)) {
    return DEFAULT_HOST_CACHE_TTL_MS;
  }
  if (cacheTtlMs <= 0) return 0;
  return Math.min(cacheTtlMs, MAX_HOST_CACHE_TTL_MS);
}

export function clearHostResolutionCache(): void {
  activeHostCache.clear();
}

export function evictHostFromCache(rawHost: string): boolean {
  const normalized = normalizeHost(rawHost);
  if (!normalized) return false;
  return activeHostCache.delete(normalized);
}

export function evictTenantFromCache(tenantId: string): number {
  let removed = 0;
  for (const [host, entry] of activeHostCache.entries()) {
    if (entry.tenantId === tenantId) {
      activeHostCache.delete(host);
      removed += 1;
    }
  }
  return removed;
}

export function getHostResolutionCacheSize(): number {
  return activeHostCache.size;
}

const HOST_LOOKUP_SQL = `
SELECT
  th.host AS host,
  th.kind AS host_kind,
  th.status AS host_status,
  th.ssl_status AS ssl_status,
  th.is_primary AS is_primary,
  th.quarantined_until AS quarantined_until,
  t.id AS tenant_id,
  t.organization_id AS organization_id,
  t.handle AS handle,
  t.name AS tenant_name,
  t.vertical AS vertical,
  t.status AS tenant_status,
  t.operator_hold AS operator_hold,
  t.trial_ends_at AS trial_ends_at,
  t.paid_through AS paid_through,
  t.cache_version AS cache_version,
  t.schema_version AS schema_version,
  ph.host AS primary_host,
  ph.kind AS primary_host_kind,
  ph.quarantined_until AS primary_host_quarantined_until
FROM tenant_hosts th
INNER JOIN tenants t ON th.tenant_id = t.id
LEFT JOIN tenant_hosts ph
  ON ph.tenant_id = t.id
  AND ph.is_primary = 1
  AND ph.status = 'active'
  AND ph.ssl_status = 'active'
WHERE th.host = ?
LIMIT 1
`;

/**
 * Authoritative `PLATFORM_DB` host resolution (`tenant_hosts JOIN tenants`) with
 * an active-only in-isolate memory cache (TTL <= 5s) and 60s moved-host quarantine.
 *
 * Non-active hosts (unknown, pending, failed, moved, deleting, quarantined, unverified SSL)
 * and non-serving tenants (provisioning, suspended, recovery, purging, purged, operatorHold)
 * are NEVER cached.
 */
export async function resolveTenantByHost(
  platformDb: D1Database | null | undefined,
  rawHost: string,
  options: ResolveTenantByHostOptions = {},
): Promise<HostResolutionResult> {
  const normalized = normalizeHost(rawHost);
  if (!normalized) {
    return { kind: "invalid_host", host: "" };
  }

  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = clampCacheTtlMs(options.cacheTtlMs);

  if (!options.bypassCache && ttlMs > 0) {
    const cached = activeHostCache.get(normalized);
    if (cached) {
      if (nowMs >= cached.createdAt && nowMs < cached.expiresAt) {
        return { ...cached.value, fromCache: true };
      }
      activeHostCache.delete(normalized);
    }
  }

  if (!platformDb) {
    return {
      kind: "db_unavailable",
      host: normalized,
      errorCode: "PLATFORM_DB_MISSING",
    };
  }

  let row: RawHostJoinRow | null;
  try {
    row = await platformDb.prepare(HOST_LOOKUP_SQL).bind(normalized).first<RawHostJoinRow>();
  } catch {
    return {
      kind: "db_unavailable",
      host: normalized,
      errorCode: "PLATFORM_DB_UNAVAILABLE",
    };
  }

  if (!row) {
    activeHostCache.delete(normalized);
    return { kind: "not_found", host: normalized, reason: "unknown" };
  }

  const quarantinedUntil =
    typeof row.quarantined_until === "number" ? row.quarantined_until : null;
  if (quarantinedUntil !== null && quarantinedUntil > nowMs) {
    activeHostCache.delete(normalized);
    return { kind: "quarantined", host: normalized, quarantinedUntil };
  }

  if (row.host_status !== "active") {
    activeHostCache.delete(normalized);
    return {
      kind: "not_found",
      host: normalized,
      reason: row.host_status,
    };
  }

  if (row.ssl_status !== "active") {
    activeHostCache.delete(normalized);
    return { kind: "not_found", host: normalized, reason: "unverified_ssl" };
  }

  const operatorHold = row.operator_hold === 1;
  const trialEndsAt = typeof row.trial_ends_at === "number" ? row.trial_ends_at : null;
  const paidThrough = typeof row.paid_through === "number" ? row.paid_through : null;
  const effectiveStatus = computeEffectiveTenantStatus(
    {
      storedStatus: row.tenant_status,
      operatorHold,
      trialEndsAt,
      paidThrough,
    },
    nowMs,
  );

  // PLAN §17.1: Trial websites are served on platform subdomains only.
  if (effectiveStatus === "trial" && row.host_kind === "custom") {
    activeHostCache.delete(normalized);
    return { kind: "not_found", host: normalized, reason: "trial_custom_domain_disabled" };
  }

  const isPrimary = row.is_primary === 1;
  const primaryQuarantined =
    typeof row.primary_host_quarantined_until === "number" &&
    row.primary_host_quarantined_until > nowMs;

  const primaryHost = isPrimary
    ? row.host
    : !primaryQuarantined && row.primary_host
      ? row.primary_host
      : null;
  const primaryHostKind = isPrimary
    ? row.host_kind
    : !primaryQuarantined && row.primary_host
      ? row.primary_host_kind
      : null;

  const resolved: Extract<HostResolutionResult, { readonly kind: "resolved" }> = {
    kind: "resolved",
    host: row.host,
    fromCache: false,
    hostRecord: {
      host: row.host,
      kind: row.host_kind,
      status: row.host_status,
      sslStatus: row.ssl_status,
      isPrimary,
      quarantinedUntil,
    },
    tenant: {
      id: row.tenant_id,
      organizationId: row.organization_id,
      handle: row.handle,
      name: row.tenant_name,
      vertical: row.vertical,
      storedStatus: row.tenant_status,
      effectiveStatus,
      operatorHold,
      cacheVersion: row.cache_version,
      schemaVersion: row.schema_version,
      trialEndsAt,
      paidThrough,
    },
    primaryHost,
    primaryHostKind,
  };

  // Active-only isolate cache: cache ONLY serving tenants without operator hold.
  if (ttlMs > 0 && !operatorHold && isTenantServingStatus(effectiveStatus)) {
    const deadlineMs = nextSuspensionDeadlineMs(row.tenant_status, trialEndsAt, paidThrough);
    const expiresAt =
      deadlineMs !== null ? Math.min(nowMs + ttlMs, deadlineMs) : nowMs + ttlMs;
    if (expiresAt > nowMs) {
      activeHostCache.set(normalized, {
        createdAt: nowMs,
        expiresAt,
        tenantId: row.tenant_id,
        value: resolved,
      });
    } else {
      activeHostCache.delete(normalized);
    }
  } else {
    activeHostCache.delete(normalized);
  }

  return resolved;
}

/**
 * Marks a moved hostname as `moved`, detaches primary status, applies the 60s quarantine
 * (`quarantined_until = now + 60_000`), atomically bumps `tenants.cache_version = cache_version + 1`,
 * and evicts isolate cache entries immediately (PLAN §3).
 */
export async function quarantineMovedHost(
  platformDb: D1Database,
  input: QuarantineMovedHostInput,
): Promise<QuarantineMovedHostResult> {
  const normalized = normalizeHost(input.host);
  if (!normalized) {
    throw new Error("INVALID_HOST: cannot quarantine malformed hostname");
  }
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new Error("TENANT_ID_REQUIRED: tenantId is required to quarantine host");
  }

  const nowMs = input.nowMs ?? Date.now();
  const quarantinedUntil = nowMs + MOVED_HOST_QUARANTINE_MS;

  const [hostUpdate] = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE tenant_hosts
         SET status = 'moved',
             is_primary = 0,
             quarantined_until = ?,
             version = version + 1,
             updated_at = ?
         WHERE host = ? AND tenant_id = ?`,
      )
      .bind(quarantinedUntil, nowMs, normalized, tenantId),
    platformDb
      .prepare(
        `UPDATE tenants
         SET cache_version = cache_version + 1,
             version = version + 1,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(nowMs, tenantId),
  ]);

  evictHostFromCache(normalized);
  evictTenantFromCache(tenantId);

  return {
    host: normalized,
    tenantId,
    quarantinedUntil,
    updated: (hostUpdate?.meta?.changes ?? 0) > 0,
  };
}

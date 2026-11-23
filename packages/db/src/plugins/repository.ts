import {
  BUILTIN_PLUGIN_PREFIX,
  isBuiltinPluginId,
  isValidPluginId,
  type PluginBillingCycle,
  type PluginManifest,
  type PluginVisibility,
} from "@punyasitus/core/plugins/index";

/**
 * Platform & Per-Tenant Plugin Entitlement and Installation Repositories
 * (REQ-097, ADR-0010, PLAN §19.7, TASK-097).
 *
 * Hard Invariants:
 * 1. EVERY read/write on `TenantStore.installed_plugins` strictly excludes `builtin:*`
 *    identifiers (e.g. `builtin:lead-email-notifications` owned by TASK-021).
 * 2. Disabling a plugin sets `enabled = 0` and NEVER deletes the `installed_plugins` row
 *    or drops `plg_*` tables.
 * 3. Entitlement reads & revocations strictly enforce `0011_plugin_runtime_entitlements`
 *    `status` and `expires_at` columns with ZERO fail-open catch-all fallbacks!
 *    (All transient/DB errors propagate cleanly so revoked/expired grants never fail open.)
 */

export class PluginRepositoryError extends Error {
  readonly code: "BUILTIN_PLUGIN_FORBIDDEN" | "INVALID_PLUGIN_ID" | "NOT_FOUND";

  constructor(code: PluginRepositoryError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "PluginRepositoryError";
    this.code = code;
  }
}

export interface PlatformPluginCatalogRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly distribution: PluginVisibility;
  readonly billingCycle: PluginBillingCycle;
  readonly priceIdr: number;
  readonly latestVersion: string;
  readonly permissions: readonly string[];
  readonly active: boolean;
}

export interface TenantPluginEntitlementRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly pluginId: string;
  readonly status: "active" | "expired" | "revoked";
  readonly grantedBy: string | null;
  readonly settlementId: string | null;
  readonly grantedAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

export interface TenantInstalledPluginRecord {
  readonly pluginId: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
  readonly schemaVersion: number;
  readonly installedAt: number;
  readonly updatedAt: number;
}

function assertManageablePluginId(pluginId: string): void {
  if (isBuiltinPluginId(pluginId)) {
    throw new PluginRepositoryError(
      "BUILTIN_PLUGIN_FORBIDDEN",
      `Builtin feature "${pluginId}" cannot be accessed or mutated via the plugin runtime`,
    );
  }
  if (!isValidPluginId(pluginId)) {
    throw new PluginRepositoryError("INVALID_PLUGIN_ID", `Invalid plugin ID "${pluginId}"`);
  }
}

function createRecordId(prefix: string): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 10)}`;
  return `${prefix}_${randomPart}`;
}

function parseJsonObjectSafe(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function parseStringArraySafe(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
    return [];
  } catch {
    return [];
  }
}

function isMissingCatalogMetadataColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such column:\s*(?:description|billing_cycle|latest_version|permissions_json)/i.test(
    msg,
  );
}

// ---------------------------------------------------------------------------
// PLATFORM_DB: `plugin_catalog` & `tenant_plugin_entitlements`
// ---------------------------------------------------------------------------

/**
 * Ensures a registered first-party plugin manifest has an up-to-date catalog row
 * in `PLATFORM_DB.plugin_catalog` (idempotent upsert).
 */
export async function upsertPluginCatalogEntry(
  platformDb: D1Database,
  manifest: Pick<
    PluginManifest,
    "id" | "name" | "description" | "visibility" | "billingCycle" | "priceIdr" | "version" | "permissions"
  >,
  nowMs: number = Date.now(),
): Promise<void> {
  assertManageablePluginId(manifest.id);

  try {
    await platformDb
      .prepare(
        `INSERT INTO plugin_catalog (
           id, slug, name, description, distribution, billing_cycle, price_idr,
           latest_version, permissions_json, active, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           distribution = excluded.distribution,
           billing_cycle = excluded.billing_cycle,
           price_idr = excluded.price_idr,
           latest_version = excluded.latest_version,
           permissions_json = excluded.permissions_json,
           active = 1,
           version = plugin_catalog.version + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(
        manifest.id,
        manifest.id,
        manifest.name,
        manifest.description,
        manifest.visibility,
        manifest.billingCycle,
        manifest.priceIdr,
        manifest.version,
        JSON.stringify(manifest.permissions),
        nowMs,
        nowMs,
      )
      .run();
  } catch (err) {
    if (!isMissingCatalogMetadataColumnError(err)) {
      throw err;
    }
    await platformDb
      .prepare(
        `INSERT INTO plugin_catalog (
           id, slug, name, distribution, price_idr, active, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           distribution = excluded.distribution,
           price_idr = excluded.price_idr,
           active = 1,
           version = plugin_catalog.version + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(
        manifest.id,
        manifest.id,
        manifest.name,
        manifest.visibility,
        manifest.priceIdr,
        nowMs,
        nowMs,
      )
      .run();
  }
}

export async function listPlatformPluginCatalog(
  platformDb: D1Database,
): Promise<PlatformPluginCatalogRow[]> {
  try {
    const res = await platformDb
      .prepare(
        `SELECT id, slug, name, description, distribution, billing_cycle, price_idr,
                latest_version, permissions_json, active
         FROM plugin_catalog
         WHERE active = 1 AND id NOT LIKE ?
         ORDER BY name ASC`,
      )
      .bind(`${BUILTIN_PLUGIN_PREFIX}%`)
      .all<{
        readonly id: string;
        readonly slug: string;
        readonly name: string;
        readonly description: string | null;
        readonly distribution: PluginVisibility;
        readonly billing_cycle: PluginBillingCycle | null;
        readonly price_idr: number;
        readonly latest_version: string | null;
        readonly permissions_json: string | null;
        readonly active: number;
      }>();

    return (res.results ?? [])
      .filter((row) => !isBuiltinPluginId(row.id))
      .map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description ?? "",
        distribution: row.distribution,
        billingCycle: row.billing_cycle ?? "free",
        priceIdr: Number(row.price_idr ?? 0),
        latestVersion: row.latest_version ?? "1.0.0",
        permissions: parseStringArraySafe(row.permissions_json),
        active: row.active === 1,
      }));
  } catch (err) {
    if (!isMissingCatalogMetadataColumnError(err)) {
      throw err;
    }
    const res = await platformDb
      .prepare(
        `SELECT id, slug, name, distribution, price_idr, active
         FROM plugin_catalog
         WHERE active = 1 AND id NOT LIKE ?
         ORDER BY name ASC`,
      )
      .bind(`${BUILTIN_PLUGIN_PREFIX}%`)
      .all<{
        readonly id: string;
        readonly slug: string;
        readonly name: string;
        readonly distribution: PluginVisibility;
        readonly price_idr: number;
        readonly active: number;
      }>();

    return (res.results ?? [])
      .filter((row) => !isBuiltinPluginId(row.id))
      .map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: "",
        distribution: row.distribution,
        billingCycle: row.distribution === "public_free" ? "free" : "paid_once",
        priceIdr: Number(row.price_idr ?? 0),
        latestVersion: "1.0.0",
        permissions: [],
        active: row.active === 1,
      }));
  }
}

/**
 * Grants or reactivates a tenant plugin entitlement in `PLATFORM_DB.tenant_plugin_entitlements`.
 * Requires `0011_plugin_runtime_entitlements` (fail-closed: never ignores status/expiry columns).
 */
export async function grantTenantPluginEntitlement(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly pluginId: string;
    readonly grantedBy?: string | null;
    readonly settlementId?: string | null;
    readonly expiresAtMs?: number | null;
    readonly nowMs?: number;
  },
): Promise<TenantPluginEntitlementRecord> {
  assertManageablePluginId(input.pluginId);
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const id = createRecordId("tpe");

  await platformDb
    .prepare(
      `INSERT INTO tenant_plugin_entitlements (
         id, tenant_id, plugin_id, granted_by, settlement_id, granted_at,
         status, expires_at, revoked_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?)
       ON CONFLICT(tenant_id, plugin_id) DO UPDATE SET
         granted_by = COALESCE(excluded.granted_by, tenant_plugin_entitlements.granted_by),
         settlement_id = COALESCE(excluded.settlement_id, tenant_plugin_entitlements.settlement_id),
         status = 'active',
         expires_at = excluded.expires_at,
         revoked_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      input.tenantId,
      input.pluginId,
      input.grantedBy ?? null,
      input.settlementId ?? null,
      nowMs,
      input.expiresAtMs ?? null,
      nowMs,
    )
    .run();

  return {
    id,
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    status: "active",
    grantedBy: input.grantedBy ?? null,
    settlementId: input.settlementId ?? null,
    grantedAt: nowMs,
    expiresAt: input.expiresAtMs ?? null,
    revokedAt: null,
  };
}

/**
 * Revokes a tenant plugin entitlement strictly via `status = 'revoked'` (preserves audit trail;
 * never falls back to destructive `DELETE` on arbitrary errors).
 */
export async function revokeTenantPluginEntitlement(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly pluginId: string;
    readonly nowMs?: number;
  },
): Promise<void> {
  assertManageablePluginId(input.pluginId);
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  await platformDb
    .prepare(
      `UPDATE tenant_plugin_entitlements
       SET status = 'revoked', revoked_at = ?, updated_at = ?
       WHERE tenant_id = ? AND plugin_id = ?`,
    )
    .bind(nowMs, nowMs, input.tenantId, input.pluginId)
    .run();
}

/**
 * Checks active non-expired tenant entitlement strictly from `PLATFORM_DB.tenant_plugin_entitlements`.
 * Fail-closed: NEVER catches errors to ignore `status` or `expires_at`!
 */
export async function getActiveTenantPluginEntitlement(
  platformDb: D1Database,
  tenantId: string,
  pluginId: string,
  nowMs: number = Date.now(),
): Promise<TenantPluginEntitlementRecord | null> {
  if (isBuiltinPluginId(pluginId) || !isValidPluginId(pluginId)) {
    return null;
  }

  const row = await platformDb
    .prepare(
      `SELECT id, tenant_id, plugin_id, granted_by, settlement_id, granted_at,
              status, expires_at, revoked_at
       FROM tenant_plugin_entitlements
       WHERE tenant_id = ? AND plugin_id = ?
       LIMIT 1`,
    )
    .bind(tenantId, pluginId)
    .first<{
      readonly id: string;
      readonly tenant_id: string;
      readonly plugin_id: string;
      readonly granted_by: string | null;
      readonly settlement_id: string | null;
      readonly granted_at: number;
      readonly status: "active" | "expired" | "revoked";
      readonly expires_at: number | null;
      readonly revoked_at: number | null;
    }>();

  if (!row) return null;
  if (row.status !== "active") return null;
  if (typeof row.expires_at === "number" && row.expires_at <= nowMs) {
    return null;
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    pluginId: row.plugin_id,
    status: "active",
    grantedBy: row.granted_by,
    settlementId: row.settlement_id,
    grantedAt: Number(row.granted_at),
    expiresAt: typeof row.expires_at === "number" ? row.expires_at : null,
    revokedAt: typeof row.revoked_at === "number" ? row.revoked_at : null,
  };
}

/**
 * Lists all active non-expired entitlements for a tenant strictly enforcing `status = 'active'`
 * and `expires_at` (fail-closed; never falls back to status-ignoring queries).
 */
export async function listActiveTenantPluginEntitlements(
  platformDb: D1Database,
  tenantId: string,
  nowMs: number = Date.now(),
): Promise<TenantPluginEntitlementRecord[]> {
  const res = await platformDb
    .prepare(
      `SELECT id, tenant_id, plugin_id, granted_by, settlement_id, granted_at,
              status, expires_at, revoked_at
       FROM tenant_plugin_entitlements
       WHERE tenant_id = ?
         AND plugin_id NOT LIKE ?
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY granted_at ASC`,
    )
    .bind(tenantId, `${BUILTIN_PLUGIN_PREFIX}%`, nowMs)
    .all<{
      readonly id: string;
      readonly tenant_id: string;
      readonly plugin_id: string;
      readonly granted_by: string | null;
      readonly settlement_id: string | null;
      readonly granted_at: number;
      readonly status: "active" | "expired" | "revoked";
      readonly expires_at: number | null;
      readonly revoked_at: number | null;
    }>();

  return (res.results ?? [])
    .filter((row) => !isBuiltinPluginId(row.plugin_id))
    .map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      pluginId: row.plugin_id,
      status: "active" as const,
      grantedBy: row.granted_by,
      settlementId: row.settlement_id,
      grantedAt: Number(row.granted_at),
      expiresAt: typeof row.expires_at === "number" ? row.expires_at : null,
      revokedAt: typeof row.revoked_at === "number" ? row.revoked_at : null,
    }));
}

// ---------------------------------------------------------------------------
// TenantStore: `installed_plugins` (STRICT `builtin:*` EXCLUSION!)
// ---------------------------------------------------------------------------

interface InstalledPluginSqlRow {
  readonly plugin_id: string;
  readonly version: string;
  readonly enabled: number;
  readonly config_json: string;
  readonly schema_version: number;
  readonly installed_at: number;
  readonly updated_at: number;
}

function mapInstalledPluginRow(row: InstalledPluginSqlRow): TenantInstalledPluginRecord {
  return {
    pluginId: row.plugin_id,
    version: row.version,
    enabled: row.enabled === 1,
    config: parseJsonObjectSafe(row.config_json),
    schemaVersion: Number(row.schema_version ?? 0),
    installedAt: Number(row.installed_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function listInstalledPlugins(
  tenantDb: D1Database,
): Promise<TenantInstalledPluginRecord[]> {
  const res = await tenantDb
    .prepare(
      `SELECT plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at
       FROM installed_plugins
       WHERE plugin_id NOT LIKE ?
       ORDER BY installed_at ASC, plugin_id ASC`,
    )
    .bind(`${BUILTIN_PLUGIN_PREFIX}%`)
    .all<InstalledPluginSqlRow>();

  return (res.results ?? [])
    .filter((row) => !isBuiltinPluginId(row.plugin_id))
    .map(mapInstalledPluginRow);
}

export async function getInstalledPlugin(
  tenantDb: D1Database,
  pluginId: string,
): Promise<TenantInstalledPluginRecord | null> {
  if (isBuiltinPluginId(pluginId) || !isValidPluginId(pluginId)) {
    return null;
  }

  const row = await tenantDb
    .prepare(
      `SELECT plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at
       FROM installed_plugins
       WHERE plugin_id = ? AND plugin_id NOT LIKE ?
       LIMIT 1`,
    )
    .bind(pluginId, `${BUILTIN_PLUGIN_PREFIX}%`)
    .first<InstalledPluginSqlRow>();

  if (!row || isBuiltinPluginId(row.plugin_id)) {
    return null;
  }
  return mapInstalledPluginRow(row);
}

export async function upsertInstalledPlugin(
  tenantDb: D1Database,
  input: {
    readonly pluginId: string;
    readonly version: string;
    readonly enabled: boolean;
    readonly config?: Record<string, unknown>;
    readonly schemaVersion: number;
    readonly nowMs?: number;
  },
): Promise<TenantInstalledPluginRecord> {
  assertManageablePluginId(input.pluginId);
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const existing = await getInstalledPlugin(tenantDb, input.pluginId);
  const effectiveConfig = input.config ?? existing?.config ?? {};
  const configJson = JSON.stringify(effectiveConfig);
  const installedAt = existing?.installedAt ?? nowMs;
  const schemaVersion = Math.max(existing?.schemaVersion ?? 0, input.schemaVersion);

  await tenantDb
    .prepare(
      `INSERT INTO installed_plugins (
         plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plugin_id) DO UPDATE SET
         version = excluded.version,
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         schema_version = excluded.schema_version,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.pluginId,
      input.version,
      input.enabled ? 1 : 0,
      configJson,
      schemaVersion,
      installedAt,
      nowMs,
    )
    .run();

  return {
    pluginId: input.pluginId,
    version: input.version,
    enabled: input.enabled,
    config: effectiveConfig,
    schemaVersion,
    installedAt,
    updatedAt: nowMs,
  };
}

export async function setInstalledPluginEnabled(
  tenantDb: D1Database,
  input: {
    readonly pluginId: string;
    readonly enabled: boolean;
    readonly nowMs?: number;
  },
): Promise<TenantInstalledPluginRecord> {
  assertManageablePluginId(input.pluginId);
  const existing = await getInstalledPlugin(tenantDb, input.pluginId);
  if (!existing) {
    throw new PluginRepositoryError("NOT_FOUND", `Plugin "${input.pluginId}" is not installed`);
  }
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  await tenantDb
    .prepare(
      `UPDATE installed_plugins
       SET enabled = ?, updated_at = ?
       WHERE plugin_id = ? AND plugin_id NOT LIKE ?`,
    )
    .bind(input.enabled ? 1 : 0, nowMs, input.pluginId, `${BUILTIN_PLUGIN_PREFIX}%`)
    .run();

  return {
    ...existing,
    enabled: input.enabled,
    updatedAt: nowMs,
  };
}

export async function updateInstalledPluginConfig(
  tenantDb: D1Database,
  input: {
    readonly pluginId: string;
    readonly config: Record<string, unknown>;
    readonly nowMs?: number;
  },
): Promise<TenantInstalledPluginRecord> {
  assertManageablePluginId(input.pluginId);
  const existing = await getInstalledPlugin(tenantDb, input.pluginId);
  if (!existing) {
    throw new PluginRepositoryError("NOT_FOUND", `Plugin "${input.pluginId}" is not installed`);
  }
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  await tenantDb
    .prepare(
      `UPDATE installed_plugins
       SET config_json = ?, updated_at = ?
       WHERE plugin_id = ? AND plugin_id NOT LIKE ?`,
    )
    .bind(JSON.stringify(input.config), nowMs, input.pluginId, `${BUILTIN_PLUGIN_PREFIX}%`)
    .run();

  return {
    ...existing,
    config: input.config,
    updatedAt: nowMs,
  };
}

export async function recordPluginActivityLog(
  tenantDb: D1Database,
  input: {
    readonly actorUserId: string | null;
    readonly actorRole: string;
    readonly action: string;
    readonly pluginId: string;
    readonly summary: string;
    readonly metadata?: Record<string, unknown>;
    readonly nowMs?: number;
  },
): Promise<void> {
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  await tenantDb
    .prepare(
      `INSERT INTO tenant_activity_log (
         actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
       ) VALUES (?, ?, ?, 'plugin', ?, ?, ?, ?)`,
    )
    .bind(
      input.actorUserId,
      input.actorRole,
      input.action,
      input.pluginId,
      input.summary,
      input.metadata ? JSON.stringify(input.metadata) : null,
      nowMs,
    )
    .run();
}

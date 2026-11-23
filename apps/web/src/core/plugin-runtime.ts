import {
  isBuiltinPluginId,
  measureEmittedPublicJsBytes,
  PUBLIC_PLUGIN_JS_BUDGET_BYTES,
  validatePluginConfigLimits,
  type PluginDefinition,
  type PluginManifest,
  type PluginMcpToolDecl,
  type PluginTenantDb,
  type PluginTenantSnapshot,
} from "@punyasitus/core/plugins/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
  type TenantStoreRpcStub,
} from "@punyasitus/db/connections";
import {
  createScopedPluginTenantDb,
  getActiveTenantPluginEntitlement,
  getInstalledPlugin,
  grantTenantPluginEntitlement,
  listActiveTenantPluginEntitlements,
  listInstalledPlugins,
  recordPluginActivityLog,
  runPluginMigrations,
  setInstalledPluginEnabled,
  updateInstalledPluginConfig,
  upsertInstalledPlugin,
  upsertPluginCatalogEntry,
  type RunPluginMigrationsResult,
  type ScopedPluginTenantDbOptions,
  type TenantInstalledPluginRecord,
  type TenantPluginEntitlementRecord,
} from "@punyasitus/db/plugins/index";
import { DEFAULT_PLUGIN_REGISTRY, type PluginRegistry } from "./plugin-registry.ts";

/**
 * Frozen-Core Modular Plugin Runtime & 5-Slot Dispatcher
 * (REQ-097, REQ-040, REQ-060, ADR-0010, PLAN §19.7, TASK-097).
 *
 * Core Invariants:
 * 1. Inactive / unentitled tenants short-circuit at `PLATFORM_DB.tenant_plugin_entitlements`
 *    and execute ZERO `TenantStore` queries and emit ZERO bytes of public JS/CSS.
 * 2. `builtin:*` identifiers (e.g. `builtin:lead-email-notifications`) are strictly excluded.
 * 3. Every plugin database call uses `createScopedPluginTenantDb` (`plg_<id>__*` only).
 * 4. Public slots enforce the `<= 25 KiB` JS budget (`REQ-040`) and CSP/SEO headers.
 * 5. Lifecycle gates: `locked` permits read-only inspection & live public widgets while
 *    blocking all plugin mutations (`403 SUBSCRIPTION_LOCKED`); `suspended`/`recovery`/`purging`/`purged`
 *    block all plugin access while preserving `plg_*` rows until `H+45` purge.
 */

const PUBLIC_SERVING_TENANT_STATUSES = new Set(["trial", "active", "grace", "locked"]);
const MUTABLE_TENANT_STATUSES = new Set(["trial", "active", "grace"]);
const READABLE_ADMIN_TENANT_STATUSES = new Set(["trial", "active", "grace", "locked"]);

export class PluginRuntimeError extends Error {
  readonly status: 400 | 403 | 404 | 422 | 500 | 503;
  readonly code: string;

  constructor(status: 400 | 403 | 404 | 422 | 500 | 503, code: string, message: string) {
    super(message);
    this.name = "PluginRuntimeError";
    this.status = status;
    this.code = code;
  }
}

export interface PluginRuntimeDeps {
  readonly platformDb: D1Database;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly resolveTenantStub?: (tenantId: string) => TenantStoreRpcStub;
  readonly resolveTenantDb?: (tenantId: string) => D1Database;
  readonly registry?: PluginRegistry;
  readonly nowMs?: number;
  readonly getBookmark?: () => Promise<string>;
  readonly scopedDbOptions?: ScopedPluginTenantDbOptions;
}

function getTenantStub(deps: PluginRuntimeDeps, tenantId: string): TenantStoreRpcStub {
  if (deps.resolveTenantStub) {
    return deps.resolveTenantStub(tenantId);
  }
  if (!deps.tenantStore) {
    throw new PluginRuntimeError(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan data tenant sementara tidak tersedia.",
    );
  }
  return openTenantStoreStub(deps.tenantStore, tenantId);
}

function getTenantDb(deps: PluginRuntimeDeps, tenantId: string): D1Database {
  if (deps.resolveTenantDb) {
    return deps.resolveTenantDb(tenantId);
  }
  return createTenantDb(getTenantStub(deps, tenantId));
}

function getRegistry(deps: PluginRuntimeDeps): PluginRegistry {
  return deps.registry ?? DEFAULT_PLUGIN_REGISTRY;
}

const ALLOWED_PLUGIN_PUBLIC_RESPONSE_HEADERS = new Set([
  "vary",
  "etag",
  "last-modified",
  "x-plugin-version",
]);

function escapeHtmlBasic(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function assertValidPluginConfig(
  plugin: PluginDefinition,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const limitsCheck = validatePluginConfigLimits(config);
  if (!limitsCheck.ok) {
    throw new PluginRuntimeError(
      422,
      "VALIDATION_ERROR",
      limitsCheck.reason ?? "Konfigurasi plugin melebihi batas ukuran atau struktur yang diizinkan.",
    );
  }
  if (plugin.adminSlots?.configSchema) {
    const parsed = plugin.adminSlots.configSchema.safeParse(config);
    if (!parsed.success) {
      throw new PluginRuntimeError(422, "VALIDATION_ERROR", "Konfigurasi plugin tidak valid.");
    }
    return parsed.data;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Active Entitlement Resolution (Zero-Query Short-Circuit for Unentitled Tenants)
// ---------------------------------------------------------------------------

export type ActivePluginResolution =
  | {
      readonly active: true;
      readonly plugin: PluginDefinition;
      readonly entitlement: TenantPluginEntitlementRecord;
      readonly installed: TenantInstalledPluginRecord;
      readonly scopedDb: PluginTenantDb;
    }
  | {
      readonly active: false;
      readonly reason:
        | "not_found"
        | "tenant_unavailable"
        | "unentitled"
        | "not_installed"
        | "disabled";
      readonly plugin: PluginDefinition | null;
    };

/**
 * Resolves whether a plugin is BOTH entitled in `PLATFORM_DB` AND enabled in `TenantStore`.
 *
 * CRITICAL ZERO-OVERHEAD GUARANTEE:
 * If `PLATFORM_DB.tenant_plugin_entitlements` has no active non-expired row for `(tenantId, pluginId)`,
 * this returns `{ active: false, reason: "unentitled" }` IMMEDIATELY without opening `TenantStore`
 * or running a single tenant SQL query.
 */
export async function resolveActivePluginForTenant(
  deps: PluginRuntimeDeps,
  tenant: PluginTenantSnapshot,
  pluginId: string,
): Promise<ActivePluginResolution> {
  if (!pluginId || isBuiltinPluginId(pluginId)) {
    return { active: false, reason: "not_found", plugin: null };
  }

  const registry = getRegistry(deps);
  const plugin = registry.get(pluginId);
  if (!plugin) {
    return { active: false, reason: "not_found", plugin: null };
  }

  if (!PUBLIC_SERVING_TENANT_STATUSES.has(tenant.status)) {
    return { active: false, reason: "tenant_unavailable", plugin };
  }

  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  const entitlement = await getActiveTenantPluginEntitlement(
    deps.platformDb,
    tenant.id,
    plugin.manifest.id,
    nowMs,
  );
  if (!entitlement) {
    // ZERO TenantStore queries executed!
    return { active: false, reason: "unentitled", plugin };
  }

  const tenantDb = getTenantDb(deps, tenant.id);
  const installed = await getInstalledPlugin(tenantDb, plugin.manifest.id);
  if (!installed) {
    return { active: false, reason: "not_installed", plugin };
  }
  if (!installed.enabled) {
    return { active: false, reason: "disabled", plugin };
  }

  const scopedDb = createScopedPluginTenantDb(
    plugin.manifest.id,
    tenantDb,
    deps.scopedDbOptions,
  );

  return {
    active: true,
    plugin,
    entitlement,
    installed,
    scopedDb,
  };
}

// ---------------------------------------------------------------------------
// Admin Catalog View & Lifecycle Mutations (Install / Enable / Disable / Config)
// ---------------------------------------------------------------------------

export interface TenantPluginCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly visibility: PluginManifest["visibility"];
  readonly billingCycle: PluginManifest["billingCycle"];
  readonly priceIdr: number;
  readonly tablePrefix: PluginManifest["tablePrefix"];
  readonly permissions: readonly string[];
  readonly maxPublicJsBytes: number;
  readonly entitled: boolean;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly schemaVersion: number;
  readonly config: Record<string, unknown>;
  readonly updatedAt: number | null;
  readonly slots: PluginManifest["slots"];
}

export async function listTenantPluginsForAdmin(
  deps: PluginRuntimeDeps,
  tenant: PluginTenantSnapshot,
): Promise<TenantPluginCatalogItem[]> {
  if (!READABLE_ADMIN_TENANT_STATUSES.has(tenant.status)) {
    throw new PluginRuntimeError(
      tenant.status === "purged" ? 404 : 403,
      tenant.status === "purged" ? "NOT_FOUND" : "SUBSCRIPTION_LOCKED",
      "Akses plugin tidak tersedia pada status situs saat ini.",
    );
  }

  const registry = getRegistry(deps);
  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  const entitlements = await listActiveTenantPluginEntitlements(
    deps.platformDb,
    tenant.id,
    nowMs,
  );
  const entitlementSet = new Set(entitlements.map((e) => e.pluginId));

  // Installed plugins read strictly filters `builtin:*`
  const tenantDb = getTenantDb(deps, tenant.id);
  const installedRows = await listInstalledPlugins(tenantDb);
  const installedById = new Map(installedRows.map((row) => [row.pluginId, row]));

  const items: TenantPluginCatalogItem[] = [];
  for (const def of registry.list()) {
    const m = def.manifest;
    const isEntitled = entitlementSet.has(m.id);

    // `private_client` plugins are ONLY surfaced to tenants granted entitlement!
    if (m.visibility === "private_client" && !isEntitled) {
      continue;
    }

    const installed = installedById.get(m.id) ?? null;
    items.push({
      id: m.id,
      name: m.name,
      description: m.description,
      version: installed?.version ?? m.version,
      visibility: m.visibility,
      billingCycle: m.billingCycle,
      priceIdr: m.priceIdr,
      tablePrefix: m.tablePrefix,
      permissions: m.permissions,
      maxPublicJsBytes: m.maxPublicJsBytes,
      entitled: isEntitled,
      installed: installed !== null,
      enabled: Boolean(installed?.enabled && isEntitled),
      schemaVersion: installed?.schemaVersion ?? 0,
      config: installed?.config ?? { ...m.defaultConfig },
      updatedAt: installed?.updatedAt ?? null,
      slots: m.slots,
    });
  }

  return items;
}

export interface InstallPluginResult {
  readonly plugin: TenantPluginCatalogItem;
  readonly migrationResult: RunPluginMigrationsResult | null;
}

export async function installOrEnablePluginForTenant(
  deps: PluginRuntimeDeps,
  input: {
    readonly tenant: PluginTenantSnapshot;
    readonly pluginId: string;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly initialConfig?: Record<string, unknown>;
  },
): Promise<InstallPluginResult> {
  if (isBuiltinPluginId(input.pluginId)) {
    throw new PluginRuntimeError(
      404,
      "NOT_FOUND",
      "Plugin tidak ditemukan.",
    );
  }

  if (!MUTABLE_TENANT_STATUSES.has(input.tenant.status)) {
    throw new PluginRuntimeError(
      input.tenant.status === "purged" ? 404 : 403,
      input.tenant.status === "purged" ? "NOT_FOUND" : "SUBSCRIPTION_LOCKED",
      "Langganan sedang terkunci. Perpanjang langganan untuk memasang atau mengaktifkan plugin.",
    );
  }

  const registry = getRegistry(deps);
  const plugin = registry.get(input.pluginId);
  if (!plugin) {
    throw new PluginRuntimeError(404, "NOT_FOUND", `Plugin "${input.pluginId}" tidak ditemukan.`);
  }

  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  const manifest = plugin.manifest;

  const entitlement = await getActiveTenantPluginEntitlement(
    deps.platformDb,
    input.tenant.id,
    manifest.id,
    nowMs,
  );

  if (!entitlement) {
    if (manifest.visibility === "public_free") {
      // 1-click free plugin install ensures catalog + entitlement row in PLATFORM_DB
      await upsertPluginCatalogEntry(deps.platformDb, manifest, nowMs);
      await grantTenantPluginEntitlement(deps.platformDb, {
        tenantId: input.tenant.id,
        pluginId: manifest.id,
        grantedBy: input.actorUserId,
        nowMs,
      });
    } else if (manifest.visibility === "private_client") {
      // Never leak existence of ungranted private client plugins
      throw new PluginRuntimeError(404, "NOT_FOUND", `Plugin "${input.pluginId}" tidak ditemukan.`);
    } else {
      throw new PluginRuntimeError(
        403,
        "FORBIDDEN",
        `Plugin berbayar "${manifest.name}" memerlukan lisensi aktif sebelum dipasang.`,
      );
    }
  }

  // Validate optional initial config against platform caps AND plugin configSchema BEFORE any DB write
  let validatedConfig: Record<string, unknown> | undefined = input.initialConfig;
  if (validatedConfig !== undefined) {
    validatedConfig = assertValidPluginConfig(plugin, validatedConfig);
  }

  // Slot 1: Run namespace-locked `plg_<id>__*` migrations with pre-migration PITR bookmark
  let migrationResult: RunPluginMigrationsResult | null = null;
  if (plugin.migrations && plugin.migrations.length > 0) {
    const stub = getTenantStub(deps, input.tenant.id);
    migrationResult = await runPluginMigrations(
      deps.platformDb,
      stub,
      input.tenant.id,
      manifest.id,
      plugin.migrations,
      {
        getBookmark: deps.getBookmark,
        now: () => nowMs,
      },
    );
  }

  const tenantDb = getTenantDb(deps, input.tenant.id);
  const existing = await getInstalledPlugin(tenantDb, manifest.id);
  const mergedConfig =
    validatedConfig ?? existing?.config ?? { ...manifest.defaultConfig };

  const installed = await upsertInstalledPlugin(tenantDb, {
    pluginId: manifest.id,
    version: manifest.version,
    enabled: true,
    config: mergedConfig,
    schemaVersion: migrationResult?.schemaVersion ?? existing?.schemaVersion ?? 0,
    nowMs,
  });

  await recordPluginActivityLog(tenantDb, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: existing ? "plugin.enabled" : "plugin.installed",
    pluginId: manifest.id,
    summary: existing
      ? `Mengaktifkan kembali plugin ${manifest.name}`
      : `Memasang plugin ${manifest.name} v${manifest.version}`,
    metadata: {
      schemaVersion: installed.schemaVersion,
      bookmarkId: migrationResult?.bookmarkId ?? null,
    },
    nowMs,
  });

  return {
    migrationResult,
    plugin: {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: installed.version,
      visibility: manifest.visibility,
      billingCycle: manifest.billingCycle,
      priceIdr: manifest.priceIdr,
      tablePrefix: manifest.tablePrefix,
      permissions: manifest.permissions,
      maxPublicJsBytes: manifest.maxPublicJsBytes,
      entitled: true,
      installed: true,
      enabled: true,
      schemaVersion: installed.schemaVersion,
      config: installed.config,
      updatedAt: installed.updatedAt,
      slots: manifest.slots,
    },
  };
}

/**
 * Disables a plugin on a tenant WITHOUT dropping any `plg_<id>__*` tables or deleting config.
 */
export async function disablePluginForTenant(
  deps: PluginRuntimeDeps,
  input: {
    readonly tenant: PluginTenantSnapshot;
    readonly pluginId: string;
    readonly actorUserId: string;
    readonly actorRole: string;
  },
): Promise<TenantPluginCatalogItem> {
  if (isBuiltinPluginId(input.pluginId)) {
    throw new PluginRuntimeError(404, "NOT_FOUND", "Plugin tidak ditemukan.");
  }

  if (!MUTABLE_TENANT_STATUSES.has(input.tenant.status)) {
    throw new PluginRuntimeError(
      input.tenant.status === "purged" ? 404 : 403,
      input.tenant.status === "purged" ? "NOT_FOUND" : "SUBSCRIPTION_LOCKED",
      "Langganan sedang terkunci. Perpanjang langganan untuk mengubah status plugin.",
    );
  }

  const registry = getRegistry(deps);
  const plugin = registry.get(input.pluginId);
  if (!plugin) {
    throw new PluginRuntimeError(404, "NOT_FOUND", `Plugin "${input.pluginId}" tidak ditemukan.`);
  }

  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  const entitlement = await getActiveTenantPluginEntitlement(
    deps.platformDb,
    input.tenant.id,
    plugin.manifest.id,
    nowMs,
  );
  if (!entitlement) {
    throw new PluginRuntimeError(
      plugin.manifest.visibility === "private_client" ? 404 : 403,
      plugin.manifest.visibility === "private_client" ? "NOT_FOUND" : "FORBIDDEN",
      "Plugin tidak memiliki lisensi aktif pada situs ini.",
    );
  }

  const tenantDb = getTenantDb(deps, input.tenant.id);
  const existing = await getInstalledPlugin(tenantDb, plugin.manifest.id);
  if (!existing) {
    throw new PluginRuntimeError(404, "NOT_FOUND", `Plugin "${plugin.manifest.id}" belum terpasang.`);
  }

  const updated = await setInstalledPluginEnabled(tenantDb, {
    pluginId: plugin.manifest.id,
    enabled: false,
    nowMs,
  });

  await recordPluginActivityLog(tenantDb, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "plugin.disabled",
    pluginId: plugin.manifest.id,
    summary: `Menonaktifkan plugin ${plugin.manifest.name} (data plg_* tetap tersimpan aman)`,
    nowMs,
  });

  const m = plugin.manifest;
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    version: updated.version,
    visibility: m.visibility,
    billingCycle: m.billingCycle,
    priceIdr: m.priceIdr,
    tablePrefix: m.tablePrefix,
    permissions: m.permissions,
    maxPublicJsBytes: m.maxPublicJsBytes,
    entitled: true,
    installed: true,
    enabled: false,
    schemaVersion: updated.schemaVersion,
    config: updated.config,
    updatedAt: updated.updatedAt,
    slots: m.slots,
  };
}

export async function updatePluginConfigForTenant(
  deps: PluginRuntimeDeps,
  input: {
    readonly tenant: PluginTenantSnapshot;
    readonly pluginId: string;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly config: Record<string, unknown>;
  },
): Promise<TenantPluginCatalogItem> {
  if (isBuiltinPluginId(input.pluginId)) {
    throw new PluginRuntimeError(404, "NOT_FOUND", "Plugin tidak ditemukan.");
  }

  if (!MUTABLE_TENANT_STATUSES.has(input.tenant.status)) {
    throw new PluginRuntimeError(
      input.tenant.status === "purged" ? 404 : 403,
      input.tenant.status === "purged" ? "NOT_FOUND" : "SUBSCRIPTION_LOCKED",
      "Langganan sedang terkunci. Perpanjang langganan untuk menyimpan konfigurasi plugin.",
    );
  }

  const registry = getRegistry(deps);
  const plugin = registry.get(input.pluginId);
  if (!plugin) {
    throw new PluginRuntimeError(404, "NOT_FOUND", `Plugin "${input.pluginId}" tidak ditemukan.`);
  }

  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  const entitlement = await getActiveTenantPluginEntitlement(
    deps.platformDb,
    input.tenant.id,
    plugin.manifest.id,
    nowMs,
  );
  if (!entitlement) {
    throw new PluginRuntimeError(
      plugin.manifest.visibility === "private_client" ? 404 : 403,
      plugin.manifest.visibility === "private_client" ? "NOT_FOUND" : "FORBIDDEN",
      "Plugin tidak memiliki lisensi aktif pada situs ini.",
    );
  }

  const validatedConfig = assertValidPluginConfig(plugin, input.config);

  const tenantDb = getTenantDb(deps, input.tenant.id);
  const existing = await getInstalledPlugin(tenantDb, plugin.manifest.id);
  if (!existing) {
    throw new PluginRuntimeError(404, "NOT_FOUND", `Plugin "${plugin.manifest.id}" belum terpasang.`);
  }

  const updated = await updateInstalledPluginConfig(tenantDb, {
    pluginId: plugin.manifest.id,
    config: validatedConfig,
    nowMs,
  });

  await recordPluginActivityLog(tenantDb, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "plugin.config_updated",
    pluginId: plugin.manifest.id,
    summary: `Memperbarui pengaturan plugin ${plugin.manifest.name}`,
    nowMs,
  });

  const m = plugin.manifest;
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    version: updated.version,
    visibility: m.visibility,
    billingCycle: m.billingCycle,
    priceIdr: m.priceIdr,
    tablePrefix: m.tablePrefix,
    permissions: m.permissions,
    maxPublicJsBytes: m.maxPublicJsBytes,
    entitled: true,
    installed: true,
    enabled: updated.enabled,
    schemaVersion: updated.schemaVersion,
    config: updated.config,
    updatedAt: updated.updatedAt,
    slots: m.slots,
  };
}

// ---------------------------------------------------------------------------
// Slot 2: Public Section & Declared Sub-Route Dispatcher (<= 25 KiB JS cap)
// ---------------------------------------------------------------------------

export interface RenderedPluginSection {
  readonly pluginId: string;
  readonly sectionId: string;
  readonly html: string;
  readonly cssBytes: number;
  readonly jsBytes: number;
}

export async function renderPluginPublicSection(
  deps: PluginRuntimeDeps,
  input: {
    readonly tenant: PluginTenantSnapshot;
    readonly sectionId: string;
    readonly props?: Record<string, unknown>;
  },
): Promise<RenderedPluginSection | null> {
  const registry = getRegistry(deps);
  const plugin = registry.findByPublicSection(input.sectionId);
  if (!plugin) return null;

  const resolved = await resolveActivePluginForTenant(deps, input.tenant, plugin.manifest.id);
  if (!resolved.active) {
    // Zero bytes of JS/CSS and zero plugin queries when inactive/unentitled
    return null;
  }

  const renderer = plugin.publicSlots?.sections?.[input.sectionId];
  if (!renderer) return null;

  let rendered: Awaited<ReturnType<typeof renderer>>;
  try {
    rendered = await renderer({
      tenant: input.tenant,
      config: resolved.installed.config,
      db: resolved.scopedDb,
      props: input.props ?? {},
    });
  } catch {
    // Fault isolation: a buggy public plugin section never crashes the tenant's page
    return null;
  }

  const jsBytes = measureEmittedPublicJsBytes({
    html: rendered.html,
    inlineJs: rendered.inlineJs,
    declaredJsBytes: rendered.jsBytes,
  });
  const cssBytes = rendered.cssBytes ?? 0;

  if (jsBytes > PUBLIC_PLUGIN_JS_BUDGET_BYTES) {
    throw new PluginRuntimeError(
      500,
      "PUBLIC_JS_BUDGET_EXCEEDED",
      `Plugin "${plugin.manifest.id}" section "${input.sectionId}" exceeded 25 KiB public JS budget (${jsBytes} bytes)`,
    );
  }

  return {
    pluginId: plugin.manifest.id,
    sectionId: input.sectionId,
    html: rendered.html,
    cssBytes,
    jsBytes,
  };
}

export async function dispatchPluginPublicRoute(
  deps: PluginRuntimeDeps,
  input: {
    readonly tenant: PluginTenantSnapshot;
    readonly request: Request;
    readonly pathname: string;
  },
): Promise<Response | null> {
  const registry = getRegistry(deps);
  const plugin = registry.findByPublicRoute(input.pathname);
  if (!plugin) return null;

  const resolved = await resolveActivePluginForTenant(deps, input.tenant, plugin.manifest.id);
  if (!resolved.active) {
    // Unentitled or disabled -> caller returns 404, 0 bytes JS/CSS, 0 TenantStore queries when unentitled
    return null;
  }

  const normalizedPath =
    input.pathname.length > 1 && input.pathname.endsWith("/")
      ? input.pathname.slice(0, -1).toLowerCase()
      : input.pathname.toLowerCase();

  const routeHandler = plugin.publicSlots?.routes?.[normalizedPath];
  if (!routeHandler) return null;

  let result: Awaited<ReturnType<typeof routeHandler>>;
  try {
    result = await routeHandler({
      tenant: input.tenant,
      request: input.request,
      pathname: normalizedPath,
      config: resolved.installed.config,
      db: resolved.scopedDb,
    });
  } catch {
    // Fault isolation: a throwing plugin public route degrades cleanly without crashing the Worker
    return null;
  }

  const jsBytes = measureEmittedPublicJsBytes({
    html: result.html,
    declaredJsBytes: result.jsBytes,
  });
  if (jsBytes > PUBLIC_PLUGIN_JS_BUDGET_BYTES) {
    throw new PluginRuntimeError(
      500,
      "PUBLIC_JS_BUDGET_EXCEEDED",
      `Plugin "${plugin.manifest.id}" route "${normalizedPath}" exceeded 25 KiB public JS budget (${jsBytes} bytes)`,
    );
  }

  const noindex = input.tenant.status === "trial";
  const safeTitle = escapeHtmlBasic(`${result.title} — ${input.tenant.name}`);
  const metaDesc = result.description
    ? `<meta name="description" content="${escapeHtmlBasic(result.description)}"/>`
    : "";
  const robotsTag = noindex ? `<meta name="robots" content="noindex, nofollow"/>` : "";

  const documentHtml = `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${robotsTag}<title>${safeTitle}</title>${metaDesc}</head><body><main data-plugin-id="${escapeHtmlBasic(plugin.manifest.id)}">${result.html}</main></body></html>`;

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; base-uri 'self'; frame-ancestors 'none'",
    "Cache-Control": noindex ? "private, no-store" : "public, max-age=60",
    "X-PunyaSitus-Plugin": plugin.manifest.id,
    "X-PunyaSitus-Plugin-JS-Bytes": String(jsBytes),
    ...(noindex ? { "X-Robots-Tag": "noindex, nofollow" } : {}),
  });

  // Strict response-header allowlist: plugins may NEVER set Location, Refresh, Content-Type,
  // Link, Set-Cookie, CSP, X-Robots-Tag, or CORS headers.
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) {
      const lower = k.toLowerCase();
      if (!ALLOWED_PLUGIN_PUBLIC_RESPONSE_HEADERS.has(lower)) {
        continue;
      }
      headers.set(k, v);
    }
  }

  return new Response(documentHtml, {
    status: result.status ?? 200,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Slot 3: Plugin-Scoped Admin JSON API Dispatcher
// ---------------------------------------------------------------------------

export async function dispatchPluginAdminApi(
  deps: PluginRuntimeDeps,
  input: {
    readonly tenant: PluginTenantSnapshot;
    readonly pluginId: string;
    readonly subPath: string;
    readonly request: Request;
    readonly actorUserId: string;
    readonly actorRole: string;
  },
): Promise<Response> {
  if (isBuiltinPluginId(input.pluginId)) {
    throw new PluginRuntimeError(404, "NOT_FOUND", "Plugin tidak ditemukan.");
  }

  const method = input.request.method.toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  if (isMutation && !MUTABLE_TENANT_STATUSES.has(input.tenant.status)) {
    throw new PluginRuntimeError(
      input.tenant.status === "purged" ? 404 : 403,
      input.tenant.status === "purged" ? "NOT_FOUND" : "SUBSCRIPTION_LOCKED",
      "Langganan sedang terkunci. Operasi tulis plugin diblokir.",
    );
  }

  const resolved = await resolveActivePluginForTenant(deps, input.tenant, input.pluginId);
  if (!resolved.active) {
    if (resolved.reason === "tenant_unavailable") {
      throw new PluginRuntimeError(
        input.tenant.status === "purged" ? 404 : 403,
        input.tenant.status === "purged" ? "NOT_FOUND" : "SUBSCRIPTION_LOCKED",
        "Akses plugin tidak tersedia pada status situs saat ini.",
      );
    }
    if (resolved.reason === "unentitled") {
      const isPrivate = resolved.plugin?.manifest.visibility === "private_client";
      throw new PluginRuntimeError(
        isPrivate ? 404 : 403,
        isPrivate ? "NOT_FOUND" : "FORBIDDEN",
        isPrivate ? "Plugin tidak ditemukan." : "Situs belum memiliki hak akses plugin ini.",
      );
    }
    throw new PluginRuntimeError(404, "NOT_FOUND", "Plugin tidak aktif atau tidak ditemukan.");
  }

  const apiHandler = resolved.plugin.adminSlots?.apiHandler;
  if (!apiHandler) {
    throw new PluginRuntimeError(404, "NOT_FOUND", "Plugin tidak menyediakan endpoint API kustom.");
  }

  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  return apiHandler({
    tenant: input.tenant,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    request: input.request,
    subPath: input.subPath,
    config: resolved.installed.config,
    db: resolved.scopedDb,
    nowMs,
  });
}

// ---------------------------------------------------------------------------
// Slot 5: Conditional OAuth-Scoped MCP Tools Dispatcher
// ---------------------------------------------------------------------------

export interface ActivePluginMcpToolDescriptor extends PluginMcpToolDecl {
  readonly pluginId: string;
}

/**
 * Lists MCP tools exposed to an OAuth-authenticated MCP client for a tenant.
 *
 * ZERO-OVERHEAD INVARIANT:
 * Checks `PLATFORM_DB.tenant_plugin_entitlements` FIRST; unentitled tenants return `[]`
 * with ZERO `TenantStore` queries.
 */
export async function listPluginMcpToolsForTenant(
  deps: PluginRuntimeDeps,
  input: {
    readonly tenant: PluginTenantSnapshot;
    readonly grantedScopes: readonly string[];
  },
): Promise<ActivePluginMcpToolDescriptor[]> {
  if (!PUBLIC_SERVING_TENANT_STATUSES.has(input.tenant.status)) {
    return [];
  }

  const registry = getRegistry(deps);
  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  const entitlements = await listActiveTenantPluginEntitlements(
    deps.platformDb,
    input.tenant.id,
    nowMs,
  );
  if (entitlements.length === 0) {
    // ZERO TenantStore queries executed!
    return [];
  }

  const scopeSet = new Set(input.grantedScopes);
  const candidatePlugins: PluginDefinition[] = [];
  for (const ent of entitlements) {
    const def = registry.get(ent.pluginId);
    if (def && def.manifest.slots.mcpTools.length > 0) {
      candidatePlugins.push(def);
    }
  }
  if (candidatePlugins.length === 0) {
    return [];
  }

  const tenantDb = getTenantDb(deps, input.tenant.id);
  const installedRows = await listInstalledPlugins(tenantDb);
  const enabledIds = new Set(installedRows.filter((r) => r.enabled).map((r) => r.pluginId));

  const tools: ActivePluginMcpToolDescriptor[] = [];
  for (const def of candidatePlugins) {
    if (!enabledIds.has(def.manifest.id)) continue;
    for (const tool of def.manifest.slots.mcpTools) {
      if (input.tenant.status === "locked" && tool.mode !== "read") {
        continue;
      }
      const hasAllScopes = tool.requiredScopes.every((s) => scopeSet.has(s));
      if (!hasAllScopes) continue;
      tools.push({
        pluginId: def.manifest.id,
        ...tool,
      });
    }
  }

  return tools;
}

export async function invokePluginMcpTool(
  deps: PluginRuntimeDeps,
  input: {
    readonly tenant: PluginTenantSnapshot;
    readonly toolName: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly grantedScopes: readonly string[];
    readonly actorUserId: string;
  },
): Promise<Record<string, unknown>> {
  const registry = getRegistry(deps);
  const plugin = registry.findByMcpTool(input.toolName);
  if (!plugin) {
    throw new PluginRuntimeError(404, "NOT_FOUND", `MCP tool "${input.toolName}" tidak ditemukan.`);
  }

  const toolHandler = plugin.mcpTools?.find((t) => t.name === input.toolName);
  if (!toolHandler) {
    throw new PluginRuntimeError(404, "NOT_FOUND", `MCP tool "${input.toolName}" tidak ditemukan.`);
  }

  const resolved = await resolveActivePluginForTenant(deps, input.tenant, plugin.manifest.id);
  if (!resolved.active) {
    if (resolved.reason === "tenant_unavailable") {
      throw new PluginRuntimeError(
        input.tenant.status === "purged" ? 404 : 403,
        input.tenant.status === "purged" ? "NOT_FOUND" : "SUBSCRIPTION_LOCKED",
        "Status situs tidak mengizinkan eksekusi MCP.",
      );
    }
    throw new PluginRuntimeError(
      404,
      "NOT_FOUND",
      `MCP tool "${input.toolName}" tidak tersedia untuk situs ini.`,
    );
  }

  if (input.tenant.status === "locked" && toolHandler.mode !== "read") {
    throw new PluginRuntimeError(
      403,
      "SUBSCRIPTION_LOCKED",
      "Langganan sedang terkunci. Alat MCP tulis dinonaktifkan.",
    );
  }

  const scopeSet = new Set(input.grantedScopes);
  const missingScopes = toolHandler.requiredScopes.filter((s) => !scopeSet.has(s));
  if (missingScopes.length > 0) {
    throw new PluginRuntimeError(
      403,
      "FORBIDDEN",
      `OAuth scope tidak mencukupi untuk alat MCP "${input.toolName}".`,
    );
  }

  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  return toolHandler.execute({
    tenant: input.tenant,
    actorUserId: input.actorUserId,
    grantedScopes: input.grantedScopes,
    args: input.args,
    config: resolved.installed.config,
    db: resolved.scopedDb,
    nowMs,
  });
}

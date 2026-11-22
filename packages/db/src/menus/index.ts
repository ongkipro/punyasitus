import {
  assertMenuLocation,
  buildMenuTree,
  collectMenuTreeItemIds,
  flattenMenuTree,
  isInternalResourceTargetType,
  MENU_LOCATIONS,
  MenuValidationError,
  toPublicMenuItems,
  type MenuItemInput,
  type MenuLocation,
  type MenuTreeNode,
  type NormalizedMenuItem,
  type PublicMenuItemLevel1,
} from "@punyasitus/core/menu-builder";

/**
 * Per-Tenant Navigation Menu Repository (`packages/db/src/menus/index.ts`; TASK-004).
 *
 * Operates exclusively against a tenant's physically isolated `TenantStore`
 * (`D1Database`-compatible adapter) `menus` table:
 * - Validates and normalizes trees via `@punyasitus/core/menu-builder`.
 * - Detects cross-menu parent references against other saved menu locations in the tenant.
 * - Verifies internal `page` / `post` / `offering` `targetResourceId` references exist
 *   inside THIS tenant's `TenantStore` (and are not trashed).
 * - Enforces optimistic concurrency (`expectedVersion`) without mutating on conflict.
 * - Preserves exact serialized tree order in `items_json` / `draft_items_json`
 *   (and `published_items_json` when `publish: true`).
 */

const LOCATION_PRIMARY_IDS: Readonly<Record<MenuLocation, number>> = {
  header: 1,
  footer: 2,
  mobile: 3,
};

const LOCATION_ORDER: Readonly<Record<MenuLocation, number>> = {
  header: 0,
  footer: 1,
  mobile: 2,
};

const OFFERING_TYPE_PREFIX: Readonly<Record<string, string>> = {
  service: "/layanan",
  product: "/produk",
  tour: "/tour",
  vehicle: "/kendaraan",
};

interface RawMenuRow {
  readonly id: number;
  readonly location: MenuLocation;
  readonly items_json: string;
  readonly draft_items_json: string | null;
  readonly published_items_json: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export class MenuConflictError extends Error {
  readonly status = 409 as const;
  readonly code = "CONFLICT" as const;
  readonly currentVersion: number;
  readonly expectedVersion: number;

  constructor(location: MenuLocation, expectedVersion: number, currentVersion: number) {
    super(
      `Version conflict while updating "${location}" menu (expected version ${expectedVersion}, current version ${currentVersion}).`,
    );
    this.name = "MenuConflictError";
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

export interface StoredTenantMenu {
  readonly id: number | null;
  readonly location: MenuLocation;
  readonly items: readonly MenuTreeNode[];
  readonly tree: readonly MenuTreeNode[];
  readonly flatItems: readonly NormalizedMenuItem[];
  readonly publicItems: readonly PublicMenuItemLevel1[];
  readonly publishedItems: readonly MenuTreeNode[] | null;
  readonly version: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface SaveTenantMenuInput {
  readonly location: MenuLocation;
  readonly items: readonly MenuItemInput[] | unknown;
  readonly tenantId?: string;
  readonly expectedVersion?: number;
  readonly publish?: boolean;
  readonly nowMs?: number;
}

export interface DeleteTenantMenuOptions {
  readonly expectedVersion?: number;
}

export interface DeleteTenantMenuResult {
  readonly location: MenuLocation;
  readonly deleted: boolean;
  readonly version: number;
}

function parseStoredTreeJson(rawJson: string | null): MenuTreeNode[] {
  if (!rawJson) return [];
  try {
    const parsed: unknown = JSON.parse(rawJson);
    return Array.isArray(parsed) ? (parsed as MenuTreeNode[]) : [];
  } catch {
    return [];
  }
}

function mapRowToStoredMenu(row: RawMenuRow): StoredTenantMenu {
  const tree = parseStoredTreeJson(row.draft_items_json ?? row.items_json);
  const publishedItems =
    row.published_items_json !== null ? parseStoredTreeJson(row.published_items_json) : null;
  return {
    id: Number(row.id),
    location: row.location,
    items: tree,
    tree,
    flatItems: flattenMenuTree(tree),
    publicItems: toPublicMenuItems(tree),
    publishedItems,
    version: Number(row.version),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

export function createEmptyTenantMenu(location: MenuLocation): StoredTenantMenu {
  return {
    id: null,
    location,
    items: [],
    tree: [],
    flatItems: [],
    publicItems: [],
    publishedItems: null,
    version: 0,
    createdAt: null,
    updatedAt: null,
  };
}

async function collectOtherMenuItemIds(
  tenantDb: D1Database,
  targetLocation: MenuLocation,
): Promise<Map<string, MenuLocation>> {
  const res = await tenantDb
    .prepare(
      `SELECT location, items_json, draft_items_json FROM menus WHERE location != ?`,
    )
    .bind(targetLocation)
    .all<{ location: MenuLocation; items_json: string; draft_items_json: string | null }>();

  const otherIds = new Map<string, MenuLocation>();
  for (const row of res.results) {
    const tree = parseStoredTreeJson(row.draft_items_json ?? row.items_json);
    for (const itemId of collectMenuTreeItemIds(tree)) {
      otherIds.set(itemId, row.location);
    }
  }
  return otherIds;
}

async function verifyAndResolveInternalTargets(
  tenantDb: D1Database,
  flatItems: readonly NormalizedMenuItem[],
): Promise<Map<string, string>> {
  const pageIds = new Set<number>();
  const postIds = new Set<number>();
  const offeringIds = new Set<number>();

  for (const item of flatItems) {
    if (!isInternalResourceTargetType(item.targetType) || item.targetResourceId === null) {
      continue;
    }
    if (item.targetType === "page") pageIds.add(item.targetResourceId);
    else if (item.targetType === "post") postIds.add(item.targetResourceId);
    else if (item.targetType === "offering") offeringIds.add(item.targetResourceId);
  }

  const resolvedHrefs = new Map<string, string>();

  if (pageIds.size > 0) {
    const ids = [...pageIds];
    const placeholders = ids.map(() => "?").join(", ");
    const res = await tenantDb
      .prepare(
        `SELECT id, slug, is_homepage FROM pages WHERE id IN (${placeholders}) AND status != 'trashed' AND deleted_at IS NULL`,
      )
      .bind(...ids)
      .all<{ id: number; slug: string; is_homepage: number }>();

    const foundPages = new Map<number, { slug: string; isHomepage: boolean }>();
    for (const row of res.results) {
      foundPages.set(Number(row.id), {
        slug: String(row.slug),
        isHomepage: Number(row.is_homepage) === 1,
      });
    }

    for (const item of flatItems) {
      if (item.targetType !== "page" || item.targetResourceId === null) continue;
      const page = foundPages.get(item.targetResourceId);
      if (!page) {
        throw new MenuValidationError(
          "MENU_TARGET_RESOURCE_NOT_FOUND",
          `Referenced page #${item.targetResourceId} does not exist in this tenant.`,
          `items.${item.id}.targetResourceId`,
        );
      }
      if (!item.href) {
        resolvedHrefs.set(item.id, page.isHomepage ? "/" : `/${page.slug}`);
      }
    }
  }

  if (postIds.size > 0) {
    const ids = [...postIds];
    const placeholders = ids.map(() => "?").join(", ");
    const res = await tenantDb
      .prepare(
        `SELECT id, slug FROM posts WHERE id IN (${placeholders}) AND status != 'trashed' AND deleted_at IS NULL`,
      )
      .bind(...ids)
      .all<{ id: number; slug: string }>();

    const foundPosts = new Map<number, string>();
    for (const row of res.results) {
      foundPosts.set(Number(row.id), String(row.slug));
    }

    for (const item of flatItems) {
      if (item.targetType !== "post" || item.targetResourceId === null) continue;
      const slug = foundPosts.get(item.targetResourceId);
      if (!slug) {
        throw new MenuValidationError(
          "MENU_TARGET_RESOURCE_NOT_FOUND",
          `Referenced post #${item.targetResourceId} does not exist in this tenant.`,
          `items.${item.id}.targetResourceId`,
        );
      }
      if (!item.href) {
        resolvedHrefs.set(item.id, `/blog/${slug}`);
      }
    }
  }

  if (offeringIds.size > 0) {
    const ids = [...offeringIds];
    const placeholders = ids.map(() => "?").join(", ");
    const res = await tenantDb
      .prepare(
        `SELECT id, offering_type, slug FROM offerings WHERE id IN (${placeholders}) AND status != 'trashed' AND deleted_at IS NULL`,
      )
      .bind(...ids)
      .all<{ id: number; offering_type: string; slug: string }>();

    const foundOfferings = new Map<number, { offeringType: string; slug: string }>();
    for (const row of res.results) {
      foundOfferings.set(Number(row.id), {
        offeringType: String(row.offering_type),
        slug: String(row.slug),
      });
    }

    for (const item of flatItems) {
      if (item.targetType !== "offering" || item.targetResourceId === null) continue;
      const offering = foundOfferings.get(item.targetResourceId);
      if (!offering) {
        throw new MenuValidationError(
          "MENU_TARGET_RESOURCE_NOT_FOUND",
          `Referenced offering #${item.targetResourceId} does not exist in this tenant.`,
          `items.${item.id}.targetResourceId`,
        );
      }
      if (!item.href) {
        const prefix = OFFERING_TYPE_PREFIX[offering.offeringType] ?? "/katalog";
        resolvedHrefs.set(item.id, `${prefix}/${offering.slug}`);
      }
    }
  }

  return resolvedHrefs;
}

function hydrateResolvedHrefs(
  nodes: readonly MenuTreeNode[],
  resolvedHrefs: ReadonlyMap<string, string>,
): MenuTreeNode[] {
  if (resolvedHrefs.size === 0) {
    return [...nodes];
  }
  return nodes.map((node) => ({
    ...node,
    href: resolvedHrefs.get(node.id) ?? node.href,
    children: hydrateResolvedHrefs(node.children, resolvedHrefs),
  }));
}

/**
 * Lists all persisted menus for the scoped tenant, ordered deterministically
 * (`header`, `footer`, `mobile`).
 */
export async function listTenantMenus(
  tenantDb: D1Database,
  options: { readonly includeEmpty?: boolean } = {},
): Promise<StoredTenantMenu[]> {
  const res = await tenantDb
    .prepare(
      `SELECT id, location, items_json, draft_items_json, published_items_json, version, created_at, updated_at
       FROM menus`,
    )
    .all<RawMenuRow>();

  const byLocation = new Map<MenuLocation, StoredTenantMenu>();
  for (const row of res.results) {
    byLocation.set(row.location, mapRowToStoredMenu(row));
  }

  if (options.includeEmpty) {
    return MENU_LOCATIONS.map((loc) => byLocation.get(loc) ?? createEmptyTenantMenu(loc));
  }

  return [...byLocation.values()].sort(
    (a, b) => LOCATION_ORDER[a.location] - LOCATION_ORDER[b.location],
  );
}

/**
 * Loads a single tenant menu by location (`header` | `footer` | `mobile`).
 * Returns `null` when that location has not been saved yet.
 */
export async function getTenantMenuByLocation(
  tenantDb: D1Database,
  rawLocation: MenuLocation,
): Promise<StoredTenantMenu | null> {
  const location = assertMenuLocation(rawLocation);
  const row = await tenantDb
    .prepare(
      `SELECT id, location, items_json, draft_items_json, published_items_json, version, created_at, updated_at
       FROM menus
       WHERE location = ?
       LIMIT 1`,
    )
    .bind(location)
    .first<RawMenuRow>();

  return row ? mapRowToStoredMenu(row) : null;
}

/**
 * Validates and persists a tenant navigation menu with:
 * - Tree/cycle/depth/URL validation (`@punyasitus/core/menu-builder`)
 * - Cross-menu parent detection across the tenant's other menu locations
 * - Internal resource existence verification inside THIS tenant's `TenantStore`
 * - Atomic optimistic concurrency (`expectedVersion` mismatch -> `MenuConflictError` 409)
 */
export async function saveTenantMenu(
  tenantDb: D1Database,
  input: SaveTenantMenuInput,
): Promise<StoredTenantMenu> {
  const location = assertMenuLocation(input.location);
  const nowMs = input.nowMs ?? Date.now();

  // 1. Collect item IDs from other menu locations in THIS tenant for cross-menu parent checks.
  const otherMenuItemIds = await collectOtherMenuItemIds(tenantDb, location);

  // 2. Validate structure, cycles, depth <= 3, URLs, labels, and cross-tenant/cross-menu guards.
  const built = buildMenuTree(location, input.items, {
    tenantId: input.tenantId,
    otherMenuItemIds,
    allowDeferredInternalHref: true,
  });

  // 3. Verify any referenced internal `page` / `post` / `offering` IDs exist in THIS tenant's store.
  const resolvedHrefs = await verifyAndResolveInternalTargets(tenantDb, built.flatItems);
  const finalTree = hydrateResolvedHrefs(built.tree, resolvedHrefs);
  const serializedTree = JSON.stringify(finalTree);

  // 4. Read current version and enforce optimistic concurrency atomically.
  const existing = await tenantDb
    .prepare(
      `SELECT id, location, items_json, draft_items_json, published_items_json, version, created_at, updated_at
       FROM menus
       WHERE location = ?
       LIMIT 1`,
    )
    .bind(location)
    .first<RawMenuRow>();

  const currentVersion = existing ? Number(existing.version) : 0;

  if (input.expectedVersion !== undefined) {
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    ) {
      throw new MenuValidationError(
        "INVALID_MENU_PAYLOAD",
        "expectedVersion must be a non-negative integer.",
        "version",
      );
    }
    if (input.expectedVersion !== currentVersion) {
      throw new MenuConflictError(location, input.expectedVersion, currentVersion);
    }
  }

  if (!existing) {
    const rowId = LOCATION_PRIMARY_IDS[location];
    const publishedJson = input.publish ? serializedTree : null;
    try {
      await tenantDb
        .prepare(
          `INSERT INTO menus (id, location, items_json, draft_items_json, published_items_json, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(rowId, location, serializedTree, serializedTree, publishedJson, nowMs, nowMs)
        .run();
    } catch (err) {
      // Handle concurrent first insert cleanly as 409 when expectedVersion was specified.
      if (input.expectedVersion !== undefined) {
        const latest = await getTenantMenuByLocation(tenantDb, location);
        throw new MenuConflictError(location, input.expectedVersion, latest?.version ?? 1);
      }
      throw err;
    }

    const created = await getTenantMenuByLocation(tenantDb, location);
    if (!created) {
      throw new Error(`Failed to reload newly created "${location}" menu.`);
    }
    return created;
  }

  const nextPublishedJson = input.publish ? serializedTree : existing.published_items_json;
  const updateResult = await tenantDb
    .prepare(
      `UPDATE menus
       SET items_json = ?,
           draft_items_json = ?,
           published_items_json = ?,
           version = version + 1,
           updated_at = ?
       WHERE location = ? AND version = ?`,
    )
    .bind(serializedTree, serializedTree, nextPublishedJson, nowMs, location, currentVersion)
    .run();

  if ((updateResult.meta?.changes ?? 0) === 0) {
    const latest = await getTenantMenuByLocation(tenantDb, location);
    throw new MenuConflictError(
      location,
      input.expectedVersion ?? currentVersion,
      latest?.version ?? currentVersion,
    );
  }

  const updated = await getTenantMenuByLocation(tenantDb, location);
  if (!updated) {
    throw new Error(`Failed to reload updated "${location}" menu.`);
  }
  return updated;
}

/**
 * Deletes a tenant menu location (resetting it to empty) with optional optimistic concurrency check.
 */
export async function deleteTenantMenu(
  tenantDb: D1Database,
  rawLocation: MenuLocation,
  options: DeleteTenantMenuOptions = {},
): Promise<DeleteTenantMenuResult> {
  const location = assertMenuLocation(rawLocation);

  const existing = await tenantDb
    .prepare(`SELECT version FROM menus WHERE location = ? LIMIT 1`)
    .bind(location)
    .first<{ version: number }>();

  const currentVersion = existing ? Number(existing.version) : 0;

  if (options.expectedVersion !== undefined) {
    if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion < 0) {
      throw new MenuValidationError(
        "INVALID_MENU_PAYLOAD",
        "expectedVersion must be a non-negative integer.",
        "version",
      );
    }
    if (options.expectedVersion !== currentVersion) {
      throw new MenuConflictError(location, options.expectedVersion, currentVersion);
    }
  }

  if (!existing) {
    return { location, deleted: false, version: 0 };
  }

  const deleteResult = await tenantDb
    .prepare(`DELETE FROM menus WHERE location = ? AND version = ?`)
    .bind(location, currentVersion)
    .run();

  if ((deleteResult.meta?.changes ?? 0) === 0) {
    const latest = await getTenantMenuByLocation(tenantDb, location);
    throw new MenuConflictError(
      location,
      options.expectedVersion ?? currentVersion,
      latest?.version ?? currentVersion,
    );
  }

  return { location, deleted: true, version: 0 };
}

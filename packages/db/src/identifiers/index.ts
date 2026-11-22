import {
  assertSlugNamespace,
  buildSuffixedSlug,
  isReservedSlug,
  normalizeTitleToSlug,
  SlugValidationError,
  suggestAlternativeSlug,
  validateManualSlug,
  type SlugNamespace,
} from "@punyasitus/core/slug/index";

/**
 * Atomic Per-Tenant Sequential ID Allocator & Former-Slug Registry (REQ-061, PLAN §5.2 & §7.1).
 *
 * Reusable across `TASK-005` (pages), `TASK-006` (posts/taxonomies), `TASK-009` (offerings),
 * and future tenant-scoped sequential resources.
 *
 * Guarantees inside `TenantStore` single-threaded SQLite Durable Object:
 * - Monotonic per-kind sequential IDs allocated via atomic `INSERT ... ON CONFLICT(kind) DO UPDATE SET next = next + 1 RETURNING next`.
 * - Deleted IDs are NEVER reused.
 * - Tenant-local slug uniqueness enforced across BOTH current (`is_current = 1`) and former (`is_current = 0`) slugs.
 * - Single-hop 308 redirect targets (`redirect_target_slug`) updated atomically on slug change.
 */

export const SEQUENCE_KINDS = [
  "page",
  "post",
  "offering",
  "category",
  "tag",
  "media",
  "form",
  "lead",
  "branch",
  "author",
  "menu",
] as const;

export type SequenceKind = (typeof SEQUENCE_KINDS)[number];

const SEQUENCE_KIND_SET: ReadonlySet<string> = new Set(SEQUENCE_KINDS);

const DEFAULT_FALLBACK_PREFIX_BY_NAMESPACE: Readonly<Record<SlugNamespace, string>> = {
  pages: "halaman",
  blog: "post",
  layanan: "layanan",
  produk: "produk",
  tour: "tour",
  kendaraan: "kendaraan",
  blog_category: "kategori",
  blog_tag: "tag",
  offering_category: "kategori",
};

interface RawResourceSlugRow {
  readonly namespace: SlugNamespace;
  readonly slug: string;
  readonly resource_id: number;
  readonly is_current: number;
  readonly redirect_target_slug: string | null;
  readonly updated_at: number;
}

export interface ResourceSlugRecord {
  readonly namespace: SlugNamespace;
  readonly slug: string;
  readonly resourceId: number;
  readonly isCurrent: boolean;
  readonly redirectTargetSlug: string | null;
  readonly updatedAt: number;
}

function mapSlugRow(row: RawResourceSlugRow): ResourceSlugRecord {
  return {
    namespace: row.namespace,
    slug: String(row.slug),
    resourceId: Number(row.resource_id),
    isCurrent: Number(row.is_current) === 1,
    redirectTargetSlug: row.redirect_target_slug ? String(row.redirect_target_slug) : null,
    updatedAt: Number(row.updated_at),
  };
}

export function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed|SQLITE_CONSTRAINT/i.test(message);
}

/**
 * Atomically allocates the next per-tenant sequential positive integer ID for `kind`.
 * Safe under concurrent creates; never collides and never reuses deleted numbers.
 */
export async function allocateNextSequenceId(
  tenantDb: D1Database,
  kind: SequenceKind,
): Promise<number> {
  if (typeof kind !== "string" || !SEQUENCE_KIND_SET.has(kind)) {
    throw new RangeError(`Unsupported sequence kind "${String(kind)}".`);
  }

  const row = await tenantDb
    .prepare(
      `INSERT INTO sequences (kind, next)
       VALUES (?, 1)
       ON CONFLICT(kind) DO UPDATE SET next = next + 1
       RETURNING next`,
    )
    .bind(kind)
    .first<{ readonly next: number }>();

  const allocated = row ? Number(row.next) : Number.NaN;
  if (!Number.isSafeInteger(allocated) || allocated < 1) {
    throw new Error(`Failed to allocate sequential ID for kind "${kind}".`);
  }
  return allocated;
}

/**
 * Reads the current sequence high-water mark for `kind` (`0` if never allocated).
 */
export async function readCurrentSequenceValue(
  tenantDb: D1Database,
  kind: SequenceKind,
): Promise<number> {
  if (typeof kind !== "string" || !SEQUENCE_KIND_SET.has(kind)) {
    throw new RangeError(`Unsupported sequence kind "${String(kind)}".`);
  }
  const row = await tenantDb
    .prepare(`SELECT next FROM sequences WHERE kind = ? LIMIT 1`)
    .bind(kind)
    .first<{ readonly next: number }>();
  return row ? Number(row.next) : 0;
}

/**
 * Looks up a single slug row (current or former) inside `resource_slugs`.
 */
export async function findResourceSlug(
  tenantDb: D1Database,
  namespace: SlugNamespace,
  slug: string,
): Promise<ResourceSlugRecord | null> {
  assertSlugNamespace(namespace);
  const row = await tenantDb
    .prepare(
      `SELECT namespace, slug, resource_id, is_current, redirect_target_slug, updated_at
       FROM resource_slugs
       WHERE namespace = ? AND slug = ?
       LIMIT 1`,
    )
    .bind(namespace, slug)
    .first<RawResourceSlugRow>();
  return row ? mapSlugRow(row) : null;
}

/**
 * Lists all slugs (current + former) associated with a single tenant resource.
 */
export async function listResourceSlugsForResource(
  tenantDb: D1Database,
  namespace: SlugNamespace,
  resourceId: number,
): Promise<ResourceSlugRecord[]> {
  assertSlugNamespace(namespace);
  const res = await tenantDb
    .prepare(
      `SELECT namespace, slug, resource_id, is_current, redirect_target_slug, updated_at
       FROM resource_slugs
       WHERE namespace = ? AND resource_id = ?
       ORDER BY is_current DESC, updated_at DESC, slug ASC`,
    )
    .bind(namespace, resourceId)
    .all<RawResourceSlugRow>();
  return res.results.map(mapSlugRow);
}

/**
 * Checks whether `slug` is already occupied in `namespace` across BOTH current and former slugs.
 */
export async function isSlugTakenInNamespace(
  tenantDb: D1Database,
  namespace: SlugNamespace,
  slug: string,
  options: {
    readonly excludeResourceId?: number;
    readonly allowOwnFormerSlug?: boolean;
  } = {},
): Promise<boolean> {
  const existing = await findResourceSlug(tenantDb, namespace, slug);
  if (!existing) return false;
  if (
    options.excludeResourceId !== undefined &&
    existing.resourceId === options.excludeResourceId
  ) {
    if (existing.isCurrent) return false;
    return !options.allowOwnFormerSlug;
  }
  return true;
}

export interface ReserveSlugAtomicallyParams {
  readonly namespace: SlugNamespace;
  readonly resourceId: number;
  readonly title: string;
  readonly manualSlug?: string | null;
  readonly fallbackPrefix?: string;
  readonly nowMs?: number;
}

export interface ReserveSlugAtomicallyResult {
  readonly slug: string;
  readonly generatedFromTitle: boolean;
}

/**
 * Atomically reserves a slug in `resource_slugs` for a new resource:
 * - Manual slug: strictly validated; conflicts with existing OR former slugs throw `422 SLUG_CONFLICT`
 *   with a `suggestedSlug` (NEVER silently renamed).
 * - Auto-generated slug: derived from `title` (NFKD diacritics, 80-char cap, fallback), automatically
 *   appending `-2`, `-3`, ... on collision with reserved, current, or former slugs.
 */
export async function reserveSlugAtomically(
  tenantDb: D1Database,
  params: ReserveSlugAtomicallyParams,
): Promise<ReserveSlugAtomicallyResult> {
  const namespace = assertSlugNamespace(params.namespace);
  const nowMs = params.nowMs ?? Date.now();

  if (params.manualSlug !== undefined && params.manualSlug !== null) {
    const validated = validateManualSlug(params.manualSlug, { namespace });
    const insertRes = await tenantDb
      .prepare(
        `INSERT OR IGNORE INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
         VALUES (?, ?, ?, 1, NULL, ?)`,
      )
      .bind(namespace, validated, params.resourceId, nowMs)
      .run();

    if ((insertRes.meta?.changes ?? 0) === 1) {
      return { slug: validated, generatedFromTitle: false };
    }

    const suggested = await suggestAlternativeSlug(
      validated,
      (candidate) => isSlugTakenInNamespace(tenantDb, namespace, candidate),
      { namespace },
    );
    throw new SlugValidationError(
      "SLUG_CONFLICT",
      `Slug "${validated}" sudah digunakan di tenant ini. Saran alternatif: "${suggested}".`,
      { field: "slug", suggestedSlug: suggested },
    );
  }

  const fallbackPrefix =
    params.fallbackPrefix ?? DEFAULT_FALLBACK_PREFIX_BY_NAMESPACE[namespace] ?? "item";
  const baseSlug = normalizeTitleToSlug(params.title, {
    fallbackPrefix,
    fallbackId: params.resourceId,
  });

  const maxAttempts = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = attempt === 1 ? baseSlug : buildSuffixedSlug(baseSlug, attempt);
    if (isReservedSlug(candidate, namespace)) {
      continue;
    }

    const insertRes = await tenantDb
      .prepare(
        `INSERT OR IGNORE INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
         VALUES (?, ?, ?, 1, NULL, ?)`,
      )
      .bind(namespace, candidate, params.resourceId, nowMs)
      .run();

    if ((insertRes.meta?.changes ?? 0) === 1) {
      return { slug: candidate, generatedFromTitle: true };
    }
  }

  throw new SlugValidationError(
    "SLUG_CONFLICT",
    `Unable to reserve a unique slug derived from "${baseSlug}".`,
    { field: "slug" },
  );
}

export interface RecordFormerSlugOnChangeParams {
  readonly namespace: SlugNamespace;
  readonly resourceId: number;
  readonly oldSlug: string;
  readonly newSlug: string;
  readonly wasEverPublished: boolean;
  readonly confirmSlugChange?: boolean;
  /**
   * When `true` (default for same-resource revert per PLAN §7.1), a resource may
   * revert to one of its own former slugs with `confirmSlugChange: true`.
   * Set `false` to disallow reusing even its own former slug.
   */
  readonly allowSelfRevert?: boolean;
  readonly nowMs?: number;
}

export interface RecordFormerSlugOnChangeResult {
  readonly slug: string;
  readonly changed: boolean;
  readonly formerSlugRecorded: boolean;
}

export interface AtomicSlugGuard {
  /** SQL boolean predicate (e.g. `EXISTS (SELECT 1 FROM pages WHERE id = ? AND slug = ? AND version = ?)`). */
  readonly sql: string;
  readonly binds: readonly unknown[];
}

export interface BuildFormerSlugTransitionStatementsParams extends RecordFormerSlugOnChangeParams {
  /**
   * Optional SQL guard appended to every `resource_slugs` mutation so all slug
   * writes become guaranteed 0-row no-ops if the preceding version-guarded parent
   * `UPDATE` in the same `tenantDb.batch([...])` matched 0 rows.
   */
  readonly guard?: AtomicSlugGuard;
}

export interface BuiltFormerSlugTransition {
  readonly slug: string;
  readonly changed: boolean;
  readonly formerSlugRecorded: boolean;
  readonly statements: readonly D1PreparedStatement[];
}

/**
 * Pre-validates a slug transition and builds the exact `resource_slugs` SQL statements
 * so callers (e.g. `updatePage`, `restorePage`, `publishPage`) can bundle the parent
 * version-guarded `UPDATE` and all `resource_slugs` writes into ONE atomic `tenantDb.batch([...])`.
 */
export async function buildFormerSlugTransitionStatements(
  tenantDb: D1Database,
  params: BuildFormerSlugTransitionStatementsParams,
): Promise<BuiltFormerSlugTransition> {
  const namespace = assertSlugNamespace(params.namespace);
  const nowMs = params.nowMs ?? Date.now();
  const validatedNew = validateManualSlug(params.newSlug, { namespace });

  if (validatedNew === params.oldSlug) {
    return { slug: validatedNew, changed: false, formerSlugRecorded: false, statements: [] };
  }

  if (params.wasEverPublished && !params.confirmSlugChange) {
    throw new SlugValidationError(
      "SLUG_CHANGE_CONFIRMATION_REQUIRED",
      "Mengubah slug halaman yang sudah pernah dipublikasikan memerlukan konfirmasi eksplisit (confirmSlugChange: true).",
      { field: "confirmSlugChange" },
    );
  }

  const allowSelfRevert = params.allowSelfRevert ?? false;
  const existingTarget = await findResourceSlug(tenantDb, namespace, validatedNew);

  const guardWhere = params.guard ? `WHERE ${params.guard.sql}` : "";
  const guardAnd = params.guard ? `AND ${params.guard.sql}` : "";
  const guardBinds = params.guard ? params.guard.binds : [];

  if (existingTarget) {
    const canFlipOwnFormer =
      allowSelfRevert &&
      existingTarget.resourceId === params.resourceId &&
      !existingTarget.isCurrent;

    if (!canFlipOwnFormer) {
      const suggested = await suggestAlternativeSlug(
        validatedNew,
        (candidate) => isSlugTakenInNamespace(tenantDb, namespace, candidate),
        { namespace },
      );
      throw new SlugValidationError(
        "SLUG_CONFLICT",
        `Slug "${validatedNew}" sudah digunakan di tenant ini (termasuk slug lama). Saran alternatif: "${suggested}".`,
        { field: "slug", suggestedSlug: suggested },
      );
    }

    if (params.wasEverPublished) {
      return {
        slug: validatedNew,
        changed: true,
        formerSlugRecorded: true,
        statements: [
          tenantDb
            .prepare(
              `UPDATE resource_slugs
               SET is_current = 0, redirect_target_slug = ?, updated_at = ?
               WHERE namespace = ? AND slug = ? AND resource_id = ? ${guardAnd}`,
            )
            .bind(validatedNew, nowMs, namespace, params.oldSlug, params.resourceId, ...guardBinds),
          tenantDb
            .prepare(
              `UPDATE resource_slugs
               SET is_current = 1, redirect_target_slug = NULL, updated_at = ?
               WHERE namespace = ? AND slug = ? AND resource_id = ? ${guardAnd}`,
            )
            .bind(nowMs, namespace, validatedNew, params.resourceId, ...guardBinds),
          tenantDb
            .prepare(
              `UPDATE resource_slugs
               SET redirect_target_slug = ?, updated_at = ?
               WHERE namespace = ? AND resource_id = ? AND is_current = 0 ${guardAnd}`,
            )
            .bind(validatedNew, nowMs, namespace, params.resourceId, ...guardBinds),
        ],
      };
    }

    return {
      slug: validatedNew,
      changed: true,
      formerSlugRecorded: false,
      statements: [
        tenantDb
          .prepare(
            `DELETE FROM resource_slugs
             WHERE namespace = ? AND slug = ? AND resource_id = ? AND is_current = 1 ${guardAnd}`,
          )
          .bind(namespace, params.oldSlug, params.resourceId, ...guardBinds),
        tenantDb
          .prepare(
            `UPDATE resource_slugs
             SET is_current = 1, redirect_target_slug = NULL, updated_at = ?
             WHERE namespace = ? AND slug = ? AND resource_id = ? ${guardAnd}`,
          )
          .bind(nowMs, namespace, validatedNew, params.resourceId, ...guardBinds),
      ],
    };
  }

  // Brand-new slug in this namespace
  if (params.wasEverPublished) {
    return {
      slug: validatedNew,
      changed: true,
      formerSlugRecorded: true,
      statements: [
        // Ensure old slug exists as a row (handles legacy SQL-seeded rows) and demote to former
        tenantDb
          .prepare(
            `INSERT OR IGNORE INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
             SELECT ?, ?, ?, 0, ?, ?
             ${guardWhere}`,
          )
          .bind(namespace, params.oldSlug, params.resourceId, validatedNew, nowMs, ...guardBinds),
        tenantDb
          .prepare(
            `UPDATE resource_slugs
             SET is_current = 0, redirect_target_slug = ?, updated_at = ?
             WHERE namespace = ? AND slug = ? AND resource_id = ? ${guardAnd}`,
          )
          .bind(validatedNew, nowMs, namespace, params.oldSlug, params.resourceId, ...guardBinds),
        // Non-ignoring INSERT so a concurrent race on the same slug aborts & rolls back the entire batch
        tenantDb
          .prepare(
            `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
             SELECT ?, ?, ?, 1, NULL, ?
             ${guardWhere}`,
          )
          .bind(namespace, validatedNew, params.resourceId, nowMs, ...guardBinds),
        // Flatten all earlier former slugs to point directly to `validatedNew` (single-hop 308)
        tenantDb
          .prepare(
            `UPDATE resource_slugs
             SET redirect_target_slug = ?, updated_at = ?
             WHERE namespace = ? AND resource_id = ? AND is_current = 0 ${guardAnd}`,
          )
          .bind(validatedNew, nowMs, namespace, params.resourceId, ...guardBinds),
      ],
    };
  }

  // Never published: free draft slug rename (old draft slug is deleted so it does not pollute redirects)
  return {
    slug: validatedNew,
    changed: true,
    formerSlugRecorded: false,
    statements: [
      tenantDb
        .prepare(
          `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
           SELECT ?, ?, ?, 1, NULL, ?
           ${guardWhere}`,
        )
        .bind(namespace, validatedNew, params.resourceId, nowMs, ...guardBinds),
      tenantDb
        .prepare(
          `DELETE FROM resource_slugs
           WHERE namespace = ? AND slug = ? AND resource_id = ? AND is_current = 1 ${guardAnd}`,
        )
        .bind(namespace, params.oldSlug, params.resourceId, ...guardBinds),
    ],
  };
}

/**
 * Transitions a resource's slug atomically inside `resource_slugs`:
 * - Draft (never published): edits freely (replaces old draft slug row without creating a former-slug redirect).
 * - Published (or ever published): requires `confirmSlugChange: true`, demotes old slug row to
 *   `is_current = 0` with `redirect_target_slug = newSlug`, flattens all prior former slugs to point
 *   directly to `newSlug` (preventing redirect chains), and inserts/activates `newSlug` as `is_current = 1`.
 * - Manual conflicts against ANY current or former slug of another resource (or disallowed former slug)
 *   throw `422 SLUG_CONFLICT` with a `suggestedSlug`.
 */
export async function recordFormerSlugOnChange(
  tenantDb: D1Database,
  params: RecordFormerSlugOnChangeParams,
): Promise<RecordFormerSlugOnChangeResult> {
  const namespace = assertSlugNamespace(params.namespace);
  const built = await buildFormerSlugTransitionStatements(tenantDb, params);
  if (!built.changed || built.statements.length === 0) {
    return { slug: built.slug, changed: false, formerSlugRecorded: false };
  }

  try {
    await tenantDb.batch([...built.statements]);
    return {
      slug: built.slug,
      changed: true,
      formerSlugRecorded: built.formerSlugRecorded,
    };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const suggested = await suggestAlternativeSlug(
        built.slug,
        (candidate) => isSlugTakenInNamespace(tenantDb, namespace, candidate),
        { namespace },
      );
      throw new SlugValidationError(
        "SLUG_CONFLICT",
        `Slug "${built.slug}" sudah digunakan di tenant ini. Saran alternatif: "${suggested}".`,
        { field: "slug", suggestedSlug: suggested },
      );
    }
    throw err;
  }
}

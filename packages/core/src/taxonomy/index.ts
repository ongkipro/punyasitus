import {
  isCatalogOfferingType,
  type CatalogOfferingType,
} from "../catalog/index.ts";
import {
  assertNoForbiddenTenantSelectors,
  PublicationValidationError,
  type PublicationValidationField,
} from "../content/index.ts";
import {
  normalizeTitleToSlug,
  validateManualSlug,
  type SlugNamespace,
} from "../slug/index.ts";

/**
 * Shared Taxonomy Domain Rules, Hierarchy Validator & Tree Builder
 * (`packages/core/src/taxonomy/index.ts`; TASK-041, REQ-045, PLAN §11.3 & §15.2).
 *
 * Runtime-neutral pure module (zero DB/Cloudflare imports):
 * - Enforces 3 scoped taxonomy kinds: `post_category`, `post_tag`, `offering_category`.
 * - Enforces max depth 3, cycle rejection, and same-`offeringType` parent matching.
 * - Enforces flat tags (`parentId` MUST be `null`).
 * - Provides deterministic tree construction, valid-parent filtering, useful-intro check,
 *   public archive path resolution, and safe-deletion guard checks.
 */

export const TAXONOMY_KINDS = [
  "post_category",
  "post_tag",
  "offering_category",
] as const;

export type TaxonomyKind = (typeof TAXONOMY_KINDS)[number];

export const OFFERING_TYPES: readonly CatalogOfferingType[] = [
  "service",
  "product",
  "tour",
  "vehicle",
] as const;

export const MAX_TAXONOMY_DEPTH = 3 as const;
export const MIN_USEFUL_TAXONOMY_INTRO_CHARS = 20 as const;
export const MAX_TAXONOMY_NAME_LENGTH = 100 as const;
export const MAX_TAXONOMY_DESCRIPTION_LENGTH = 500 as const;
export const MAX_TAXONOMY_SORT_ORDER = 10_000 as const;

export const OFFERING_TYPE_LABELS: Readonly<Record<CatalogOfferingType, string>> = Object.freeze({
  service: "Layanan",
  product: "Produk",
  tour: "Paket Tur",
  vehicle: "Kendaraan",
});

export const OFFERING_TYPE_ROUTE_PREFIXES: Readonly<Record<CatalogOfferingType, string>> =
  Object.freeze({
    service: "/layanan",
    product: "/produk",
    tour: "/tour",
    vehicle: "/kendaraan",
  });

export type TaxonomyErrorCode =
  | "TAXONOMY_CYCLE_OR_DEPTH"
  | "CATEGORY_HAS_CHILDREN"
  | "TAXONOMY_IN_USE"
  | "INVALID_PARENT"
  | "INVALID_KIND"
  | "INVALID_OFFERING_TYPE"
  | "INVALID_REASSIGN_TARGET"
  | "SLUG_CONFLICT"
  | "STALE_VERSION"
  | "NOT_FOUND"
  | "VALIDATION_ERROR";

export class TaxonomyDomainError extends Error {
  readonly httpStatus: 404 | 409 | 422;
  readonly code: TaxonomyErrorCode;
  readonly fields: readonly PublicationValidationField[];
  readonly meta?: Readonly<Record<string, unknown>>;

  constructor(
    httpStatus: 404 | 409 | 422,
    code: TaxonomyErrorCode,
    message: string,
    fields: readonly PublicationValidationField[] = [],
    meta?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "TaxonomyDomainError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.fields = fields;
    this.meta = meta;
  }
}

export interface TaxonomyHierarchyNode {
  readonly id: number;
  readonly kind: TaxonomyKind;
  readonly offeringType: CatalogOfferingType | null;
  readonly parentId: number | null;
  readonly depth: number;
  readonly sortOrder?: number;
  readonly name?: string;
}

export interface TaxonomyTreeNode<T extends TaxonomyHierarchyNode> {
  readonly item: T;
  readonly depth: number;
  readonly childCount: number;
  readonly descendantIds: readonly number[];
  readonly ancestorIds: readonly number[];
  readonly children: readonly TaxonomyTreeNode<T>[];
}

export interface ValidatedTaxonomyWriteFields {
  readonly kind: TaxonomyKind;
  readonly offeringType: CatalogOfferingType | null;
  readonly name: string;
  readonly manualSlug: string | null;
  readonly description: string | null;
  readonly parentId: number | null;
  readonly sortOrder: number;
  readonly indexOptIn: boolean;
}

export interface SafeDeleteCheckInput {
  readonly childCount: number;
  readonly totalUsageCount: number;
  readonly publishedCount: number;
  readonly draftCount: number;
  readonly detach: boolean;
  readonly reassignToId: number | null;
}

export function isTaxonomyKind(value: unknown): value is TaxonomyKind {
  return value === "post_category" || value === "post_tag" || value === "offering_category";
}

export function getTaxonomySlugNamespace(kind: TaxonomyKind): SlugNamespace {
  switch (kind) {
    case "post_category":
      return "blog_category";
    case "post_tag":
      return "blog_tag";
    case "offering_category":
      return "offering_category";
  }
}

export function getTaxonomyFallbackPrefix(kind: TaxonomyKind): string {
  switch (kind) {
    case "post_category":
      return "kategori";
    case "post_tag":
      return "tag";
    case "offering_category":
      return "kategori-katalog";
  }
}

export function getTaxonomyPublicBasePath(
  kind: TaxonomyKind,
  slug: string,
  offeringType?: CatalogOfferingType | null,
): string {
  if (kind === "post_category") {
    return `/blog/category/${slug}`;
  }
  if (kind === "post_tag") {
    return `/blog/tag/${slug}`;
  }
  const prefix = offeringType ? OFFERING_TYPE_ROUTE_PREFIXES[offeringType] : "/layanan";
  return `${prefix}/category/${slug}`;
}

export function hasUsefulTaxonomyIntro(description: string | null | undefined): boolean {
  if (typeof description !== "string") return false;
  const normalized = description.replace(/\s+/g, " ").trim();
  return normalized.length >= MIN_USEFUL_TAXONOMY_INTRO_CHARS;
}

export function computeTaxonomyIndexable(params: {
  readonly indexOptIn: boolean;
  readonly description: string | null | undefined;
  readonly publishedCount: number;
}): boolean {
  return (
    params.indexOptIn === true &&
    hasUsefulTaxonomyIntro(params.description) &&
    params.publishedCount > 0
  );
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const DISALLOWED_HTML_RE = /<\s*\/?\s*(?:script|iframe|style|object|embed|svg)\b/i;

export function validateTaxonomyName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new TaxonomyDomainError(422, "VALIDATION_ERROR", "Nama taksonomi harus berupa teks.", [
      { field: "name", code: "INVALID_TYPE", message: "Nama harus berupa string." },
    ]);
  }
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_TAXONOMY_NAME_LENGTH) {
    throw new TaxonomyDomainError(
      422,
      "VALIDATION_ERROR",
      `Nama taksonomi harus 1 hingga ${MAX_TAXONOMY_NAME_LENGTH} karakter.`,
      [
        {
          field: "name",
          code: "INVALID_LENGTH",
          message: `Nama harus 1 hingga ${MAX_TAXONOMY_NAME_LENGTH} karakter.`,
        },
      ],
    );
  }
  if (hasControlChars(trimmed) || DISALLOWED_HTML_RE.test(trimmed)) {
    throw new TaxonomyDomainError(
      422,
      "VALIDATION_ERROR",
      "Nama taksonomi mengandung karakter atau tag tidak diizinkan.",
      [
        {
          field: "name",
          code: "INVALID_CHARACTERS",
          message: "Nama mengandung karakter tidak diizinkan.",
        },
      ],
    );
  }
  return trimmed;
}

export function validateTaxonomyDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new TaxonomyDomainError(
      422,
      "VALIDATION_ERROR",
      "Deskripsi taksonomi harus berupa teks atau kosong.",
      [
        {
          field: "description",
          code: "INVALID_TYPE",
          message: "Deskripsi harus berupa string atau null.",
        },
      ],
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_TAXONOMY_DESCRIPTION_LENGTH) {
    throw new TaxonomyDomainError(
      422,
      "VALIDATION_ERROR",
      `Deskripsi taksonomi maksimal ${MAX_TAXONOMY_DESCRIPTION_LENGTH} karakter.`,
      [
        {
          field: "description",
          code: "INVALID_LENGTH",
          message: `Deskripsi maksimal ${MAX_TAXONOMY_DESCRIPTION_LENGTH} karakter.`,
        },
      ],
    );
  }
  if (hasControlChars(trimmed) || DISALLOWED_HTML_RE.test(trimmed)) {
    throw new TaxonomyDomainError(
      422,
      "VALIDATION_ERROR",
      "Deskripsi taksonomi mengandung karakter atau tag tidak diizinkan.",
      [
        {
          field: "description",
          code: "INVALID_CHARACTERS",
          message: "Deskripsi mengandung karakter tidak diizinkan.",
        },
      ],
    );
  }
  return trimmed.length > 0 ? trimmed : null;
}

export function validateTaxonomySortOrder(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw < 0 ||
    raw > MAX_TAXONOMY_SORT_ORDER
  ) {
    throw new TaxonomyDomainError(
      422,
      "VALIDATION_ERROR",
      `Urutan tampilan harus bilangan bulat 0..${MAX_TAXONOMY_SORT_ORDER}.`,
      [
        {
          field: "sortOrder",
          code: "INVALID_SORT_ORDER",
          message: `sortOrder harus bilangan bulat 0..${MAX_TAXONOMY_SORT_ORDER}.`,
        },
      ],
    );
  }
  return raw;
}

export function validatePositiveTaxonomyId(raw: unknown, field: string): number {
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw < 1 ||
    raw > 2_147_483_647
  ) {
    throw new TaxonomyDomainError(
      422,
      "VALIDATION_ERROR",
      `${field} harus berupa bilangan bulat positif.`,
      [{ field, code: "INVALID_ID", message: `${field} must be a positive integer.` }],
    );
  }
  return raw;
}

export function validateTaxonomyOfferingType(
  kind: TaxonomyKind,
  rawOfferingType: unknown,
): CatalogOfferingType | null {
  if (kind !== "offering_category") {
    if (rawOfferingType !== undefined && rawOfferingType !== null) {
      throw new TaxonomyDomainError(
        422,
        "INVALID_OFFERING_TYPE",
        `offeringType hanya diizinkan untuk kategori katalog (offering_category).`,
        [
          {
            field: "offeringType",
            code: "INVALID_OFFERING_TYPE",
            message: "offeringType is only allowed for offering_category.",
          },
        ],
      );
    }
    return null;
  }

  if (rawOfferingType === undefined || rawOfferingType === null || rawOfferingType === "") {
    return null;
  }
  if (!isCatalogOfferingType(rawOfferingType)) {
    throw new TaxonomyDomainError(
      422,
      "INVALID_OFFERING_TYPE",
      'Tipe penawaran harus salah satu dari: "service", "product", "tour", atau "vehicle".',
      [
        {
          field: "offeringType",
          code: "INVALID_OFFERING_TYPE",
          message: "offeringType must be service, product, tour, or vehicle.",
        },
      ],
    );
  }
  return rawOfferingType;
}

export function normalizeTaxonomySlug(
  kind: TaxonomyKind,
  rawName: string,
  fallbackId: number,
  manualSlug?: string | null,
): string {
  const namespace = getTaxonomySlugNamespace(kind);
  if (manualSlug !== undefined && manualSlug !== null && manualSlug.trim() !== "") {
    return validateManualSlug(manualSlug, { namespace });
  }
  return normalizeTitleToSlug(rawName, {
    fallbackPrefix: getTaxonomyFallbackPrefix(kind),
    fallbackId,
  });
}

export function normalizeDepthValue(rawDepth: number): number {
  const d = Number(rawDepth);
  if (!Number.isFinite(d) || d < 1) return 1;
  return Math.min(MAX_TAXONOMY_DEPTH, Math.floor(d));
}

export interface HierarchyValidationResult {
  readonly depth: number;
  readonly descendantIds: readonly number[];
  readonly maxSubtreeHeight: number;
}

/**
 * Pure hierarchy validator for `post_category`, `post_tag`, and `offering_category`:
 * - Rejects any non-null `parentId` on `post_tag` (`422 INVALID_PARENT`).
 * - Rejects missing/foreign `parentId` (`422 INVALID_PARENT`).
 * - Rejects `offeringType` mismatch between parent & child (`422 INVALID_PARENT`).
 * - Rejects self-parenting (`A -> A`) and cycles (`A -> B -> A`) with `422 TAXONOMY_CYCLE_OR_DEPTH`.
 * - Rejects depth > 3 (including when moving a subtree with children/grandchildren) with `422 TAXONOMY_CYCLE_OR_DEPTH`.
 */
export function validateTaxonomyHierarchy(params: {
  readonly kind: TaxonomyKind;
  readonly offeringType: CatalogOfferingType | null;
  readonly parentId: number | null;
  readonly selfId?: number;
  readonly allSameKindNodes: readonly TaxonomyHierarchyNode[];
}): HierarchyValidationResult {
  const { kind, offeringType, parentId, selfId, allSameKindNodes } = params;

  if (kind === "post_tag") {
    if (parentId !== null) {
      throw new TaxonomyDomainError(
        422,
        "INVALID_PARENT",
        "Tag bersifat datar (flat) dan tidak boleh memiliki induk.",
        [
          {
            field: "parentId",
            code: "INVALID_PARENT",
            message: "Tags are flat and cannot declare a parent.",
          },
        ],
      );
    }
    return { depth: 1, descendantIds: [], maxSubtreeHeight: 0 };
  }

  const byId = new Map<number, TaxonomyHierarchyNode>();
  const childrenByParent = new Map<number, number[]>();

  for (const node of allSameKindNodes) {
    const id = Number(node.id);
    const pid = node.parentId !== null ? Number(node.parentId) : null;
    byId.set(id, {
      ...node,
      id,
      parentId: pid,
      depth: normalizeDepthValue(node.depth),
    });
    if (pid !== null) {
      const list = childrenByParent.get(pid) ?? [];
      list.push(id);
      childrenByParent.set(pid, list);
    }
  }

  // Compute descendants of selfId if updating an existing node
  const descendantIds: number[] = [];
  let maxSubtreeHeight = 0;
  if (selfId !== undefined) {
    const queue: Array<{ readonly id: number; readonly height: number }> = [
      { id: selfId, height: 0 },
    ];
    const seenSubtree = new Set<number>([selfId]);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const kids = childrenByParent.get(curr.id) ?? [];
      for (const kid of kids) {
        if (seenSubtree.has(kid)) continue;
        seenSubtree.add(kid);
        descendantIds.push(kid);
        const nextH = curr.height + 1;
        if (nextH > maxSubtreeHeight) maxSubtreeHeight = nextH;
        queue.push({ id: kid, height: nextH });
      }
    }
  }

  if (parentId === null) {
    return { depth: 1, descendantIds, maxSubtreeHeight };
  }

  if (selfId !== undefined && parentId === selfId) {
    throw new TaxonomyDomainError(
      422,
      "TAXONOMY_CYCLE_OR_DEPTH",
      "Kategori tidak boleh menjadi induk dirinya sendiri.",
      [
        {
          field: "parentId",
          code: "TAXONOMY_CYCLE_OR_DEPTH",
          message: "Category cannot reference itself as parent.",
        },
      ],
    );
  }

  const parent = byId.get(parentId);
  if (!parent || parent.kind !== kind) {
    throw new TaxonomyDomainError(
      422,
      "INVALID_PARENT",
      `Kategori induk #${parentId} tidak ditemukan di tenant ini.`,
      [
        {
          field: "parentId",
          code: "INVALID_PARENT",
          message: `Parent category #${parentId} does not exist in this tenant.`,
        },
      ],
    );
  }

  if (
    kind === "offering_category" &&
    parent.offeringType !== null &&
    offeringType !== null &&
    parent.offeringType !== offeringType
  ) {
    throw new TaxonomyDomainError(
      422,
      "INVALID_PARENT",
      `Kategori induk #${parentId} termasuk tipe "${parent.offeringType}", bukan "${offeringType}".`,
      [
        {
          field: "parentId",
          code: "INVALID_PARENT",
          message: `Parent category #${parentId} belongs to offeringType "${parent.offeringType}".`,
        },
      ],
    );
  }

  // Walk ancestors of parentId to detect cycles and compute exact depth from root
  let computedDepth = 2;
  let cursor: number | null = parent.parentId;
  const visited = new Set<number>([parentId]);

  while (cursor !== null) {
    if (cursor === selfId || visited.has(cursor)) {
      throw new TaxonomyDomainError(
        422,
        "TAXONOMY_CYCLE_OR_DEPTH",
        "Hierarki kategori melingkar (cyclic) tidak diizinkan.",
        [
          {
            field: "parentId",
            code: "TAXONOMY_CYCLE_OR_DEPTH",
            message: "Circular category parent reference detected.",
          },
        ],
      );
    }
    visited.add(cursor);
    const anc = byId.get(cursor);
    if (!anc) break;
    computedDepth += 1;
    cursor = anc.parentId;
  }

  if (computedDepth > MAX_TAXONOMY_DEPTH) {
    throw new TaxonomyDomainError(
      422,
      "TAXONOMY_CYCLE_OR_DEPTH",
      `Kedalaman hierarki kategori maksimal ${MAX_TAXONOMY_DEPTH} tingkat.`,
      [
        {
          field: "parentId",
          code: "TAXONOMY_CYCLE_OR_DEPTH",
          message: `Category hierarchy cannot exceed depth ${MAX_TAXONOMY_DEPTH}.`,
        },
      ],
    );
  }

  if (computedDepth + maxSubtreeHeight > MAX_TAXONOMY_DEPTH) {
    throw new TaxonomyDomainError(
      422,
      "TAXONOMY_CYCLE_OR_DEPTH",
      `Memindahkan kategori ini akan membuat sub-kategori melebihi batas kedalaman ${MAX_TAXONOMY_DEPTH} tingkat.`,
      [
        {
          field: "parentId",
          code: "TAXONOMY_CYCLE_OR_DEPTH",
          message: `Moving category would exceed maximum depth ${MAX_TAXONOMY_DEPTH} for descendants.`,
        },
      ],
    );
  }

  return {
    depth: computedDepth,
    descendantIds,
    maxSubtreeHeight,
  };
}

/**
 * Enforces PLAN §11.3 safe deletion rules:
 * - Any category with `childCount > 0` MUST fail with `409 CATEGORY_HAS_CHILDREN`.
 * - Any referenced taxonomy (`totalUsageCount > 0`) MUST fail with `409 TAXONOMY_IN_USE`
 *   unless caller explicitly supplies `detach: true` OR `reassignToId !== null`.
 */
export function assertSafeTaxonomyDelete(
  taxonomyId: number,
  input: SafeDeleteCheckInput,
): void {
  if (input.childCount > 0) {
    throw new TaxonomyDomainError(
      409,
      "CATEGORY_HAS_CHILDREN",
      `Kategori #${taxonomyId} masih memiliki ${input.childCount} sub-kategori. Pindahkan sub-kategori terlebih dahulu sebelum menghapus.`,
      [
        {
          field: "taxonomyId",
          code: "CATEGORY_HAS_CHILDREN",
          message: `Category #${taxonomyId} still has ${input.childCount} child categories.`,
        },
      ],
      {
        childCount: input.childCount,
        publishedCount: input.publishedCount,
        draftCount: input.draftCount,
        totalUsageCount: input.totalUsageCount,
      },
    );
  }

  if (input.totalUsageCount > 0 && !input.detach && input.reassignToId === null) {
    throw new TaxonomyDomainError(
      409,
      "TAXONOMY_IN_USE",
      `Taksonomi #${taxonomyId} masih digunakan oleh ${input.totalUsageCount} konten (${input.publishedCount} terbit, ${input.draftCount} draf). Pilih kategori pengganti (reassignToId) atau lepaskan (detach: true) agar konten tidak hilang.`,
      [
        {
          field: "taxonomyId",
          code: "TAXONOMY_IN_USE",
          message: `Taxonomy #${taxonomyId} is referenced by ${input.totalUsageCount} items.`,
        },
      ],
      {
        childCount: input.childCount,
        publishedCount: input.publishedCount,
        draftCount: input.draftCount,
        totalUsageCount: input.totalUsageCount,
      },
    );
  }
}

/**
 * Builds a deterministic sorted forest and flattened display order for admin tree UIs,
 * plus exact `descendantIds` and `ancestorIds` for cycle-safe parent selectors.
 */
export function buildTaxonomyTree<T extends TaxonomyHierarchyNode>(
  items: readonly T[],
): {
  readonly roots: readonly TaxonomyTreeNode<T>[];
  readonly flattened: readonly TaxonomyTreeNode<T>[];
} {
  const byId = new Map<number, T>();
  const childrenMap = new Map<number | null, T[]>();

  for (const item of items) {
    byId.set(item.id, item);
  }

  for (const item of items) {
    const validParent =
      item.parentId !== null && byId.has(item.parentId) && item.parentId !== item.id
        ? item.parentId
        : null;
    const list = childrenMap.get(validParent) ?? [];
    list.push(item);
    childrenMap.set(validParent, list);
  }

  const sortSiblings = (list: T[]): T[] =>
    list.slice().sort((a, b) => {
      const sa = a.sortOrder ?? 0;
      const sb = b.sortOrder ?? 0;
      if (sa !== sb) return sa - sb;
      const na = (a.name ?? "").toLowerCase();
      const nb = (b.name ?? "").toLowerCase();
      if (na !== nb) return na.localeCompare(nb, "id");
      return a.id - b.id;
    });

  const visited = new Set<number>();
  const flattened: TaxonomyTreeNode<T>[] = [];

  const buildNode = (item: T, depth: number, ancestors: readonly number[]): TaxonomyTreeNode<T> => {
    visited.add(item.id);
    const rawChildren = sortSiblings(childrenMap.get(item.id) ?? []).filter(
      (child) => !visited.has(child.id),
    );
    const nextAncestors = [...ancestors, item.id];
    const childNodes: TaxonomyTreeNode<T>[] = [];
    const descendantIds: number[] = [];

    const placeholderIndex = flattened.length;
    // Reserve position in pre-order traversal
    flattened.push(null as unknown as TaxonomyTreeNode<T>);

    for (const child of rawChildren) {
      const builtChild = buildNode(child, Math.min(MAX_TAXONOMY_DEPTH, depth + 1), nextAncestors);
      childNodes.push(builtChild);
      descendantIds.push(child.id, ...builtChild.descendantIds);
    }

    const node: TaxonomyTreeNode<T> = {
      item,
      depth,
      childCount: childNodes.length,
      descendantIds,
      ancestorIds: ancestors,
      children: childNodes,
    };
    flattened[placeholderIndex] = node;
    return node;
  };

  const roots: TaxonomyTreeNode<T>[] = [];
  for (const rootItem of sortSiblings(childrenMap.get(null) ?? [])) {
    if (!visited.has(rootItem.id)) {
      roots.push(buildNode(rootItem, 1, []));
    }
  }

  // Fallback for any disconnected items (e.g., corrupted cycle in legacy fixture)
  for (const item of items) {
    if (!visited.has(item.id)) {
      roots.push(buildNode(item, normalizeDepthValue(item.depth), []));
    }
  }

  return { roots, flattened };
}

/**
 * Returns valid parent candidate IDs for creating or editing a category so the admin UI
 * only offers parents that preserve `depth <= 3`, zero cycles, and same `offeringType`.
 */
export function getEligibleParentIds<T extends TaxonomyHierarchyNode>(
  items: readonly T[],
  options: {
    readonly kind: TaxonomyKind;
    readonly offeringType: CatalogOfferingType | null;
    readonly selfId?: number | null;
  },
): ReadonlySet<number> {
  if (options.kind === "post_tag") {
    return new Set();
  }

  const sameKind = items.filter(
    (it) =>
      it.kind === options.kind &&
      (options.kind !== "offering_category" ||
        options.offeringType === null ||
        it.offeringType === null ||
        it.offeringType === options.offeringType),
  );

  const eligible = new Set<number>();
  for (const candidate of sameKind) {
    if (options.selfId !== undefined && options.selfId !== null && candidate.id === options.selfId) {
      continue;
    }
    try {
      validateTaxonomyHierarchy({
        kind: options.kind,
        offeringType: options.offeringType,
        parentId: candidate.id,
        selfId: options.selfId ?? undefined,
        allSameKindNodes: sameKind,
      });
      eligible.add(candidate.id);
    } catch {
      // Not eligible due to cycle or depth limit
    }
  }
  return eligible;
}

export function validateCreateTaxonomyFields(raw: Record<string, unknown>): ValidatedTaxonomyWriteFields {
  assertNoForbiddenTenantSelectors(raw);
  const kind = raw.kind;
  if (!isTaxonomyKind(kind)) {
    throw new TaxonomyDomainError(
      422,
      "INVALID_KIND",
      'kind harus salah satu dari "post_category", "post_tag", atau "offering_category".',
      [
        {
          field: "kind",
          code: "INVALID_KIND",
          message: "kind must be post_category, post_tag, or offering_category.",
        },
      ],
    );
  }
  const offeringType = validateTaxonomyOfferingType(kind, raw.offeringType);
  const name = validateTaxonomyName(raw.name);
  const description = validateTaxonomyDescription(raw.description);
  const sortOrder = validateTaxonomySortOrder(raw.sortOrder);

  let parentId: number | null = null;
  if (raw.parentId !== undefined && raw.parentId !== null) {
    if (kind === "post_tag") {
      throw new TaxonomyDomainError(
        422,
        "INVALID_PARENT",
        "Tag bersifat datar (flat) dan tidak boleh memiliki induk.",
        [
          {
            field: "parentId",
            code: "INVALID_PARENT",
            message: "Tags are flat and cannot have a parent.",
          },
        ],
      );
    }
    parentId = validatePositiveTaxonomyId(raw.parentId, "parentId");
  }

  const namespace = getTaxonomySlugNamespace(kind);
  const manualSlug =
    raw.slug !== undefined && raw.slug !== null && String(raw.slug).trim() !== ""
      ? validateManualSlug(raw.slug, { namespace })
      : null;

  let indexOptIn = false;
  if (raw.indexOptIn !== undefined) {
    if (typeof raw.indexOptIn !== "boolean") {
      throw new TaxonomyDomainError(422, "VALIDATION_ERROR", "indexOptIn harus berupa boolean.", [
        { field: "indexOptIn", code: "INVALID_TYPE", message: "indexOptIn must be a boolean." },
      ]);
    }
    indexOptIn = raw.indexOptIn;
  } else if (raw.indexable !== undefined) {
    if (typeof raw.indexable !== "boolean") {
      throw new TaxonomyDomainError(422, "VALIDATION_ERROR", "indexable harus berupa boolean.", [
        { field: "indexable", code: "INVALID_TYPE", message: "indexable must be a boolean." },
      ]);
    }
    indexOptIn = raw.indexable;
  }

  return {
    kind,
    offeringType,
    name,
    manualSlug,
    description,
    parentId,
    sortOrder,
    indexOptIn,
  };
}

export { PublicationValidationError };

import {
  buildExternalLinkRel,
  MAX_EXTERNAL_URL_LENGTH,
  validateExternalLink,
} from "./link-sanitizer.ts";
import { FORBIDDEN_TENANT_SELECTOR_KEYS } from "./schemas/common.ts";

/**
 * Hierarchical Navigation Menu Builder & Strict Validator (TASK-004; REQ-006, REQ-007, REQ-034).
 *
 * Supports both flat `parentId`-linked item lists and nested tree inputs across the
 * three canonical locations (`header`, `footer`, `mobile`), enforcing:
 * - Deterministic sibling order preservation (`sortOrder` + input order).
 * - Unique item IDs within each menu.
 * - Cycle-free parent chains (self, 2-node, multi-hop).
 * - No cross-menu or missing parent references.
 * - No cross-tenant selectors or foreign tenant references.
 * - Strict maximum depth = 3 (root = 1, child = 2, grandchild = 3).
 * - Safe URL validation via `@punyasitus/core/link-sanitizer` (safe relative paths,
 *   safe `#anchor` fragments, validated `https://` URLs, and validated `https://wa.me/<digits>`).
 * - Bounded item count (<= 100 items) and label length (1-80 chars, no control characters).
 */

export const MENU_LOCATIONS = ["header", "footer", "mobile"] as const;
export type MenuLocation = (typeof MENU_LOCATIONS)[number];

export const MENU_TARGET_TYPES = [
  "custom",
  "page",
  "post",
  "offering",
  "external",
  "whatsapp",
] as const;
export type MenuTargetType = (typeof MENU_TARGET_TYPES)[number];

export const INTERNAL_RESOURCE_TARGET_TYPES = ["page", "post", "offering"] as const;
export type InternalResourceTargetType = (typeof INTERNAL_RESOURCE_TARGET_TYPES)[number];

export const MAX_MENU_DEPTH = 3 as const;
export const MAX_MENU_ITEMS = 100 as const;
export const MIN_MENU_LABEL_LENGTH = 1 as const;
export const MAX_MENU_LABEL_LENGTH = 80 as const;
export const MAX_MENU_ITEM_ID_LENGTH = 64 as const;
export const MAX_MENU_HREF_LENGTH = MAX_EXTERNAL_URL_LENGTH;

const MENU_LOCATION_SET: ReadonlySet<string> = new Set(MENU_LOCATIONS);
const MENU_TARGET_TYPE_SET: ReadonlySet<string> = new Set(MENU_TARGET_TYPES);
const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TENANT_SELECTOR_KEYS);

const ALLOWED_MENU_ITEM_KEYS: ReadonlySet<string> = new Set([
  "id",
  "parentId",
  "label",
  "href",
  "openInNewTab",
  "sortOrder",
  "targetType",
  "targetResourceId",
  "menuLocation",
  "targetTenantId",
  "rel",
  "children",
]);

const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_FRAGMENT_PATTERN = /^#[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;
const WA_ME_PATH_PATTERN = /^\/[0-9]{10,15}$/;
const UNSAFE_SCHEME_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export type MenuValidationErrorCode =
  | "INVALID_MENU_LOCATION"
  | "INVALID_MENU_PAYLOAD"
  | "UNKNOWN_FIELD"
  | "MENU_MAX_ITEMS_EXCEEDED"
  | "MENU_INVALID_ITEM_ID"
  | "MENU_DUPLICATE_ITEM_ID"
  | "MENU_INVALID_LABEL"
  | "MENU_UNSAFE_URL"
  | "MENU_INVALID_TARGET"
  | "MENU_INVALID_SORT_ORDER"
  | "MENU_PARENT_NOT_FOUND"
  | "MENU_CROSS_MENU_PARENT"
  | "MENU_CROSS_TENANT_REFERENCE"
  | "MENU_CYCLE_DETECTED"
  | "MENU_MAX_DEPTH_EXCEEDED"
  | "MENU_TARGET_RESOURCE_NOT_FOUND";

export interface MenuValidationIssue {
  readonly field: string;
  readonly code: MenuValidationErrorCode;
  readonly message: string;
}

export class MenuValidationError extends Error {
  readonly code: MenuValidationErrorCode;
  readonly field: string;
  readonly fields: readonly MenuValidationIssue[];

  constructor(
    code: MenuValidationErrorCode,
    message: string,
    field = "items",
    fields?: readonly MenuValidationIssue[],
  ) {
    super(message);
    this.name = "MenuValidationError";
    this.code = code;
    this.field = field;
    this.fields = fields && fields.length > 0 ? fields : [{ field, code, message }];
  }
}

export interface MenuItemInput {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly label: string;
  readonly href?: string;
  readonly openInNewTab?: boolean;
  readonly sortOrder?: number;
  readonly targetType?: MenuTargetType;
  readonly targetResourceId?: number | null;
  readonly menuLocation?: MenuLocation;
  readonly targetTenantId?: string;
  readonly rel?: string | null;
  readonly children?: readonly MenuItemInput[];
}

export interface NormalizedMenuItem {
  readonly id: string;
  readonly parentId: string | null;
  readonly depth: 1 | 2 | 3;
  readonly sortOrder: number;
  readonly label: string;
  readonly href: string;
  readonly openInNewTab: boolean;
  readonly isExternal: boolean;
  readonly rel: string | null;
  readonly targetType: MenuTargetType;
  readonly targetResourceId: number | null;
}

export interface MenuTreeNode extends NormalizedMenuItem {
  readonly children: readonly MenuTreeNode[];
}

export interface PublicMenuItemLevel3 {
  readonly label: string;
  readonly href: string;
  readonly openInNewTab: boolean;
}

export interface PublicMenuItemLevel2 {
  readonly label: string;
  readonly href: string;
  readonly openInNewTab: boolean;
  readonly children: readonly PublicMenuItemLevel3[];
}

export interface PublicMenuItemLevel1 {
  readonly label: string;
  readonly href: string;
  readonly openInNewTab: boolean;
  readonly children: readonly PublicMenuItemLevel2[];
}

export interface BuiltMenuTree {
  readonly location: MenuLocation;
  readonly tree: readonly MenuTreeNode[];
  readonly flatItems: readonly NormalizedMenuItem[];
  readonly publicItems: readonly PublicMenuItemLevel1[];
  readonly totalItems: number;
  readonly maxDepth: number;
}

export interface BuildMenuTreeOptions {
  /** Authoritative tenant ID for rejecting mismatched `targetTenantId` references. */
  readonly tenantId?: string;
  /**
   * Optional set/map of item IDs owned by OTHER menu locations in the same tenant,
   * used to emit `MENU_CROSS_MENU_PARENT` when an item references a parent from another menu.
   */
  readonly otherMenuItemIds?: ReadonlySet<string> | ReadonlyMap<string, MenuLocation>;
  /**
   * When true, internal resource items (`page` | `post` | `offering`) may omit `href`
   * so the DB repository can resolve the canonical slug path before finalizing.
   */
  readonly allowDeferredInternalHref?: boolean;
}

export interface ValidatedMenuHref {
  readonly href: string;
  readonly isExternal: boolean;
  readonly isWhatsApp: boolean;
  readonly rel: string | null;
  readonly openInNewTab: boolean;
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMenuLocation(value: unknown): value is MenuLocation {
  return typeof value === "string" && MENU_LOCATION_SET.has(value);
}

export function assertMenuLocation(value: unknown, field = "location"): MenuLocation {
  if (!isMenuLocation(value)) {
    throw new MenuValidationError(
      "INVALID_MENU_LOCATION",
      `Menu location must be one of: ${MENU_LOCATIONS.join(", ")}.`,
      field,
    );
  }
  return value;
}

export function isInternalResourceTargetType(
  value: MenuTargetType,
): value is InternalResourceTargetType {
  return value === "page" || value === "post" || value === "offering";
}

/**
 * Validates and normalizes a menu item label (1-80 trimmed chars, no ASCII control characters).
 */
export function validateMenuLabel(rawLabel: unknown, field = "label"): string {
  if (typeof rawLabel !== "string") {
    throw new MenuValidationError("MENU_INVALID_LABEL", "Menu label must be a string.", field);
  }
  if (hasControlCharacters(rawLabel)) {
    throw new MenuValidationError(
      "MENU_INVALID_LABEL",
      "Menu label must not contain ASCII control characters.",
      field,
    );
  }
  const trimmed = rawLabel.trim();
  if (trimmed.length < MIN_MENU_LABEL_LENGTH || trimmed.length > MAX_MENU_LABEL_LENGTH) {
    throw new MenuValidationError(
      "MENU_INVALID_LABEL",
      `Menu label must be between ${MIN_MENU_LABEL_LENGTH} and ${MAX_MENU_LABEL_LENGTH} characters.`,
      field,
    );
  }
  return trimmed;
}

/**
 * Validates and normalizes a menu item URL:
 * - Blocks ASCII control characters (including CRLF, NUL, tabs), protocol-relative `//`,
 *   backslashes, `javascript:`, `data:`, `vbscript:`, `file:`, `http:`, private/loopback IPs,
 *   and embedded credentials.
 * - Allows safe relative paths (`/tentang`, `/layanan/seo#detail`), safe `#anchor` fragments
 *   (`#kontak`), validated external `https://` URLs via `@punyasitus/core/link-sanitizer`,
 *   and validated `https://wa.me/<digits>` click-to-chat links.
 * - External links always carry `rel="noopener noreferrer"`.
 */
export function validateMenuHref(
  rawHref: unknown,
  options: { readonly openInNewTab?: boolean; readonly field?: string } = {},
): ValidatedMenuHref {
  const field = options.field ?? "href";

  if (typeof rawHref !== "string") {
    throw new MenuValidationError("MENU_UNSAFE_URL", "Menu URL must be a string.", field);
  }
  if (hasControlCharacters(rawHref)) {
    throw new MenuValidationError(
      "MENU_UNSAFE_URL",
      "Menu URL must not contain control characters or line breaks.",
      field,
    );
  }

  const trimmed = rawHref.trim();
  if (trimmed.length === 0) {
    throw new MenuValidationError("MENU_UNSAFE_URL", "Menu URL is required.", field);
  }
  if (trimmed.length > MAX_MENU_HREF_LENGTH) {
    throw new MenuValidationError(
      "MENU_UNSAFE_URL",
      `Menu URL exceeds maximum length of ${MAX_MENU_HREF_LENGTH} characters.`,
      field,
    );
  }

  // Reject protocol-relative URLs (`//evil.com`) and backslashes (`/\evil.com`, `\/evil.com`).
  if (trimmed.startsWith("//") || trimmed.includes("\\")) {
    throw new MenuValidationError(
      "MENU_UNSAFE_URL",
      "Protocol-relative URLs and backslashes are not allowed in menu links.",
      field,
    );
  }

  // 1. Safe in-page anchor (`#kontak`)
  if (trimmed.startsWith("#")) {
    if (!SAFE_FRAGMENT_PATTERN.test(trimmed)) {
      throw new MenuValidationError(
        "MENU_UNSAFE_URL",
        "Anchor link must be a valid fragment identifier such as '#kontak'.",
        field,
      );
    }
    const openInNewTab = options.openInNewTab ?? false;
    return {
      href: trimmed,
      isExternal: false,
      isWhatsApp: false,
      rel: openInNewTab ? buildExternalLinkRel() : null,
      openInNewTab,
    };
  }

  // 2. Safe root-relative internal path (`/`, `/tentang`, `/layanan/seo#harga`)
  if (trimmed.startsWith("/")) {
    if (/\s/.test(trimmed)) {
      throw new MenuValidationError(
        "MENU_UNSAFE_URL",
        "Internal menu path must not contain whitespace.",
        field,
      );
    }
    let resolved: URL;
    try {
      resolved = new URL(trimmed, "https://tenant.invalid");
    } catch {
      throw new MenuValidationError("MENU_UNSAFE_URL", "Internal menu path is malformed.", field);
    }
    if (resolved.origin !== "https://tenant.invalid") {
      throw new MenuValidationError(
        "MENU_UNSAFE_URL",
        "Internal menu path must resolve within the current site origin.",
        field,
      );
    }
    const openInNewTab = options.openInNewTab ?? false;
    return {
      href: trimmed,
      isExternal: false,
      isWhatsApp: false,
      rel: openInNewTab ? buildExternalLinkRel() : null,
      openInNewTab,
    };
  }

  // 3. Explicit external URL — must pass `@punyasitus/core/link-sanitizer` (HTTPS only, public host)
  if (!UNSAFE_SCHEME_PREFIX_RE.test(trimmed)) {
    throw new MenuValidationError(
      "MENU_UNSAFE_URL",
      "Menu URL must start with '/', '#', or 'https://'.",
      field,
    );
  }

  const externalCheck = validateExternalLink(trimmed);
  if (!externalCheck.ok) {
    throw new MenuValidationError("MENU_UNSAFE_URL", externalCheck.message, field);
  }

  const parsed = new URL(externalCheck.link.href);
  const isWhatsApp = parsed.hostname === "wa.me";
  if (isWhatsApp && !WA_ME_PATH_PATTERN.test(parsed.pathname)) {
    throw new MenuValidationError(
      "MENU_UNSAFE_URL",
      "WhatsApp menu link must target a valid 'https://wa.me/<digits>' number.",
      field,
    );
  }

  return {
    href: externalCheck.link.href,
    isExternal: true,
    isWhatsApp,
    rel: externalCheck.link.rel,
    openInNewTab: options.openInNewTab ?? true,
  };
}

interface FlattenedCandidate {
  readonly id: string;
  readonly parentId: string | null;
  readonly explicitSortOrder: number | null;
  readonly inputIndex: number;
  readonly fieldPath: string;
  readonly label: string;
  readonly href: string;
  readonly openInNewTab: boolean;
  readonly isExternal: boolean;
  readonly rel: string | null;
  readonly targetType: MenuTargetType;
  readonly targetResourceId: number | null;
}

function validateItemId(rawId: unknown, fieldPath: string): string {
  if (typeof rawId !== "string") {
    throw new MenuValidationError(
      "MENU_INVALID_ITEM_ID",
      "Menu item id must be a non-empty string.",
      `${fieldPath}.id`,
    );
  }
  if (hasControlCharacters(rawId)) {
    throw new MenuValidationError(
      "MENU_INVALID_ITEM_ID",
      "Menu item id must not contain control characters.",
      `${fieldPath}.id`,
    );
  }
  const trimmed = rawId.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_MENU_ITEM_ID_LENGTH ||
    !ITEM_ID_PATTERN.test(trimmed)
  ) {
    throw new MenuValidationError(
      "MENU_INVALID_ITEM_ID",
      `Menu item id must be 1-${MAX_MENU_ITEM_ID_LENGTH} alphanumeric/._:- characters.`,
      `${fieldPath}.id`,
    );
  }
  return trimmed;
}

function lookupOtherMenuLocation(
  otherMenuItemIds: ReadonlySet<string> | ReadonlyMap<string, MenuLocation> | undefined,
  parentId: string,
): MenuLocation | boolean {
  if (!otherMenuItemIds) return false;
  if (otherMenuItemIds instanceof Map) {
    return otherMenuItemIds.get(parentId) ?? false;
  }
  return otherMenuItemIds.has(parentId);
}

/**
 * Validates, normalizes, and builds a deterministic cycle-free navigation menu tree
 * (max depth 3) from either flat `parentId` items or nested `children` items.
 */
export function buildMenuTree(
  rawLocation: unknown,
  rawItems: unknown,
  options: BuildMenuTreeOptions = {},
): BuiltMenuTree {
  const location = assertMenuLocation(rawLocation);

  if (!Array.isArray(rawItems)) {
    throw new MenuValidationError(
      "INVALID_MENU_PAYLOAD",
      "Menu items must be provided as an array.",
      "items",
    );
  }

  const candidates: FlattenedCandidate[] = [];
  const seenIds = new Set<string>();
  const generatedCounter = { value: 0 };

  function nextGeneratedId(): string {
    let candidate: string;
    do {
      generatedCounter.value += 1;
      candidate = `item-${generatedCounter.value}`;
    } while (seenIds.has(candidate));
    return candidate;
  }

  function collectNodes(
    items: readonly unknown[],
    lexicalParentId: string | null,
    lexicalDepth: number,
    pathPrefix: string,
  ): void {
    if (lexicalDepth > MAX_MENU_DEPTH) {
      throw new MenuValidationError(
        "MENU_MAX_DEPTH_EXCEEDED",
        `Navigation menus support at most ${MAX_MENU_DEPTH} nesting levels.`,
        pathPrefix,
      );
    }

    for (let idx = 0; idx < items.length; idx += 1) {
      const raw = items[idx];
      const fieldPath = `${pathPrefix}[${idx}]`;

      if (candidates.length >= MAX_MENU_ITEMS) {
        throw new MenuValidationError(
          "MENU_MAX_ITEMS_EXCEEDED",
          `A menu cannot contain more than ${MAX_MENU_ITEMS} items.`,
          fieldPath,
        );
      }

      if (!isPlainObject(raw)) {
        throw new MenuValidationError(
          "INVALID_MENU_PAYLOAD",
          "Each menu item must be a JSON object.",
          fieldPath,
        );
      }

      // Check unknown & forbidden tenant-selector keys first.
      for (const key of Object.keys(raw)) {
        if (FORBIDDEN_TENANT_KEY_SET.has(key)) {
          throw new MenuValidationError(
            "MENU_CROSS_TENANT_REFERENCE",
            `Tenant selector field "${key}" is forbidden inside menu items.`,
            `${fieldPath}.${key}`,
          );
        }
        if (!ALLOWED_MENU_ITEM_KEYS.has(key)) {
          throw new MenuValidationError(
            "UNKNOWN_FIELD",
            `Unknown field "${key}" is not allowed on a menu item.`,
            `${fieldPath}.${key}`,
          );
        }
      }

      // Cross-tenant reference guard (`targetTenantId`).
      if (raw.targetTenantId !== undefined) {
        if (typeof raw.targetTenantId !== "string" || raw.targetTenantId.trim().length === 0) {
          throw new MenuValidationError(
            "MENU_CROSS_TENANT_REFERENCE",
            "targetTenantId must be a non-empty string matching the current tenant.",
            `${fieldPath}.targetTenantId`,
          );
        }
        if (!options.tenantId || raw.targetTenantId.trim() !== options.tenantId) {
          throw new MenuValidationError(
            "MENU_CROSS_TENANT_REFERENCE",
            "Menu item cannot reference a target owned by another tenant.",
            `${fieldPath}.targetTenantId`,
          );
        }
      }

      // Cross-menu guard (`menuLocation`).
      if (raw.menuLocation !== undefined) {
        if (!isMenuLocation(raw.menuLocation) || raw.menuLocation !== location) {
          throw new MenuValidationError(
            "MENU_CROSS_MENU_PARENT",
            `Menu item belongs to location "${String(raw.menuLocation)}" instead of "${location}".`,
            `${fieldPath}.menuLocation`,
          );
        }
      }

      // Item ID validation & uniqueness.
      const id = raw.id !== undefined ? validateItemId(raw.id, fieldPath) : nextGeneratedId();
      if (seenIds.has(id)) {
        throw new MenuValidationError(
          "MENU_DUPLICATE_ITEM_ID",
          `Duplicate menu item id "${id}" in "${location}" menu.`,
          `${fieldPath}.id`,
        );
      }
      seenIds.add(id);

      // Parent ID resolution.
      let explicitParentId: string | null | undefined;
      if (raw.parentId === undefined) {
        explicitParentId = undefined;
      } else if (raw.parentId === null) {
        explicitParentId = null;
      } else {
        explicitParentId = validateItemId(raw.parentId, `${fieldPath}.parentId`);
      }

      let effectiveParentId: string | null;
      if (lexicalParentId !== null) {
        if (explicitParentId !== undefined && explicitParentId !== lexicalParentId) {
          if (explicitParentId === id) {
            throw new MenuValidationError(
              "MENU_CYCLE_DETECTED",
              `Menu item "${id}" cannot be its own parent.`,
              `${fieldPath}.parentId`,
            );
          }
          throw new MenuValidationError(
            "MENU_CROSS_MENU_PARENT",
            `Nested menu item "${id}" declares parentId "${String(explicitParentId)}" that does not match its enclosing parent "${lexicalParentId}".`,
            `${fieldPath}.parentId`,
          );
        }
        effectiveParentId = lexicalParentId;
      } else {
        effectiveParentId = explicitParentId ?? null;
      }

      // Explicit self-parent check right away.
      if (effectiveParentId === id) {
        throw new MenuValidationError(
          "MENU_CYCLE_DETECTED",
          `Menu item "${id}" cannot reference itself as parent.`,
          `${fieldPath}.parentId`,
        );
      }

      // Sort order validation.
      let explicitSortOrder: number | null = null;
      if (raw.sortOrder !== undefined) {
        if (
          typeof raw.sortOrder !== "number" ||
          !Number.isSafeInteger(raw.sortOrder) ||
          raw.sortOrder < 0 ||
          raw.sortOrder > 10_000
        ) {
          throw new MenuValidationError(
            "MENU_INVALID_SORT_ORDER",
            "Menu item sortOrder must be an integer between 0 and 10000.",
            `${fieldPath}.sortOrder`,
          );
        }
        explicitSortOrder = raw.sortOrder;
      }

      // Label validation.
      const label = validateMenuLabel(raw.label, `${fieldPath}.label`);

      // openInNewTab validation.
      let explicitOpenInNewTab: boolean | undefined;
      if (raw.openInNewTab !== undefined) {
        if (typeof raw.openInNewTab !== "boolean") {
          throw new MenuValidationError(
            "INVALID_MENU_PAYLOAD",
            "Menu item openInNewTab must be a boolean.",
            `${fieldPath}.openInNewTab`,
          );
        }
        explicitOpenInNewTab = raw.openInNewTab;
      }

      // Target type & targetResourceId validation.
      let explicitTargetType: MenuTargetType | undefined;
      if (raw.targetType !== undefined) {
        if (typeof raw.targetType !== "string" || !MENU_TARGET_TYPE_SET.has(raw.targetType)) {
          throw new MenuValidationError(
            "MENU_INVALID_TARGET",
            `Menu item targetType must be one of: ${MENU_TARGET_TYPES.join(", ")}.`,
            `${fieldPath}.targetType`,
          );
        }
        explicitTargetType = raw.targetType as MenuTargetType;
      }

      let targetResourceId: number | null = null;
      if (raw.targetResourceId !== undefined && raw.targetResourceId !== null) {
        if (
          typeof raw.targetResourceId !== "number" ||
          !Number.isSafeInteger(raw.targetResourceId) ||
          raw.targetResourceId < 1 ||
          raw.targetResourceId > 2_147_483_647
        ) {
          throw new MenuValidationError(
            "MENU_INVALID_TARGET",
            "Menu item targetResourceId must be a positive integer.",
            `${fieldPath}.targetResourceId`,
          );
        }
        targetResourceId = raw.targetResourceId;
      }

      if (explicitTargetType && isInternalResourceTargetType(explicitTargetType)) {
        if (targetResourceId === null) {
          throw new MenuValidationError(
            "MENU_INVALID_TARGET",
            `Menu item with targetType "${explicitTargetType}" requires a positive integer targetResourceId.`,
            `${fieldPath}.targetResourceId`,
          );
        }
      } else if (targetResourceId !== null) {
        throw new MenuValidationError(
          "MENU_INVALID_TARGET",
          "targetResourceId is only permitted when targetType is 'page', 'post', or 'offering'.",
          `${fieldPath}.targetResourceId`,
        );
      }

      // Optional `rel` type validation (normalized by sanitizer below).
      if (raw.rel !== undefined && raw.rel !== null && typeof raw.rel !== "string") {
        throw new MenuValidationError(
          "INVALID_MENU_PAYLOAD",
          "Menu item rel must be a string or null.",
          `${fieldPath}.rel`,
        );
      }

      // Href validation (may be deferred only for internal resource items when requested by DB repo).
      let validatedHref: ValidatedMenuHref;
      if (
        raw.href === undefined &&
        options.allowDeferredInternalHref &&
        explicitTargetType &&
        isInternalResourceTargetType(explicitTargetType)
      ) {
        const openInNewTab = explicitOpenInNewTab ?? false;
        validatedHref = {
          href: "",
          isExternal: false,
          isWhatsApp: false,
          rel: openInNewTab ? buildExternalLinkRel() : null,
          openInNewTab,
        };
      } else {
        validatedHref = validateMenuHref(raw.href, {
          openInNewTab: explicitOpenInNewTab,
          field: `${fieldPath}.href`,
        });
      }

      // Cross-check targetType vs URL class.
      if (
        explicitTargetType &&
        isInternalResourceTargetType(explicitTargetType) &&
        validatedHref.isExternal
      ) {
        throw new MenuValidationError(
          "MENU_UNSAFE_URL",
          `Internal "${explicitTargetType}" menu items cannot use an external URL.`,
          `${fieldPath}.href`,
        );
      }
      if (explicitTargetType === "external" && !validatedHref.isExternal) {
        throw new MenuValidationError(
          "MENU_UNSAFE_URL",
          "External menu items must use a valid 'https://' URL.",
          `${fieldPath}.href`,
        );
      }
      if (explicitTargetType === "whatsapp" && !validatedHref.isWhatsApp) {
        throw new MenuValidationError(
          "MENU_UNSAFE_URL",
          "WhatsApp menu items must use a valid 'https://wa.me/<digits>' URL.",
          `${fieldPath}.href`,
        );
      }

      const resolvedTargetType: MenuTargetType =
        explicitTargetType ??
        (validatedHref.isWhatsApp
          ? "whatsapp"
          : validatedHref.isExternal
            ? "external"
            : "custom");

      candidates.push({
        id,
        parentId: effectiveParentId,
        explicitSortOrder,
        inputIndex: candidates.length,
        fieldPath,
        label,
        href: validatedHref.href,
        openInNewTab: validatedHref.openInNewTab,
        isExternal: validatedHref.isExternal,
        rel: validatedHref.rel,
        targetType: resolvedTargetType,
        targetResourceId,
      });

      if (raw.children !== undefined) {
        if (!Array.isArray(raw.children)) {
          throw new MenuValidationError(
            "INVALID_MENU_PAYLOAD",
            "Menu item children must be an array.",
            `${fieldPath}.children`,
          );
        }
        if (raw.children.length > 0) {
          collectNodes(raw.children, id, lexicalDepth + 1, `${fieldPath}.children`);
        }
      }
    }
  }

  collectNodes(rawItems, null, 1, "items");

  const byId = new Map<string, FlattenedCandidate>();
  for (const node of candidates) {
    byId.set(node.id, node);
  }

  // Validate every parentId exists in THIS menu (not missing, not in another menu location).
  for (const node of candidates) {
    if (node.parentId === null) continue;
    if (!byId.has(node.parentId)) {
      const otherLoc = lookupOtherMenuLocation(options.otherMenuItemIds, node.parentId);
      if (otherLoc) {
        const otherDesc = typeof otherLoc === "string" ? ` ("${otherLoc}")` : "";
        throw new MenuValidationError(
          "MENU_CROSS_MENU_PARENT",
          `Parent item "${node.parentId}" belongs to a different menu location${otherDesc} and cannot be referenced from "${location}".`,
          `${node.fieldPath}.parentId`,
        );
      }
      throw new MenuValidationError(
        "MENU_PARENT_NOT_FOUND",
        `Parent menu item "${node.parentId}" does not exist in the "${location}" menu.`,
        `${node.fieldPath}.parentId`,
      );
    }
  }

  // Cycle detection & exact depth calculation for every node.
  // Check cycles BEFORE enforcing depth so cycles always report `MENU_CYCLE_DETECTED`.
  const resolvedDepth = new Map<string, 1 | 2 | 3>();
  let maxDepth = 0;

  for (const node of candidates) {
    const visitedInChain = new Set<string>();
    let current: FlattenedCandidate | undefined = node;
    let depth = 0;

    while (current) {
      if (visitedInChain.has(current.id)) {
        throw new MenuValidationError(
          "MENU_CYCLE_DETECTED",
          `Circular parent-child reference detected involving menu item "${current.id}".`,
          `${node.fieldPath}.parentId`,
        );
      }
      visitedInChain.add(current.id);
      depth += 1;

      if (current.parentId === null) {
        break;
      }
      current = byId.get(current.parentId);
    }

    if (depth > MAX_MENU_DEPTH) {
      throw new MenuValidationError(
        "MENU_MAX_DEPTH_EXCEEDED",
        `Menu item "${node.id}" has nesting depth ${depth}, exceeding maximum depth of ${MAX_MENU_DEPTH}.`,
        `${node.fieldPath}.parentId`,
      );
    }

    const clampedDepth = depth as 1 | 2 | 3;
    resolvedDepth.set(node.id, clampedDepth);
    if (clampedDepth > maxDepth) {
      maxDepth = clampedDepth;
    }
  }

  // Group siblings by parentId and sort deterministically.
  const childrenByParent = new Map<string | null, FlattenedCandidate[]>();
  for (const node of candidates) {
    const bucket = childrenByParent.get(node.parentId);
    if (bucket) {
      bucket.push(node);
    } else {
      childrenByParent.set(node.parentId, [node]);
    }
  }

  function sortSiblings(list: FlattenedCandidate[]): FlattenedCandidate[] {
    return [...list].sort((a, b) => {
      const aHasOrder = a.explicitSortOrder !== null;
      const bHasOrder = b.explicitSortOrder !== null;
      if (aHasOrder && bHasOrder && a.explicitSortOrder !== b.explicitSortOrder) {
        return (a.explicitSortOrder ?? 0) - (b.explicitSortOrder ?? 0);
      }
      if (aHasOrder !== bHasOrder) {
        return aHasOrder ? -1 : 1;
      }
      return a.inputIndex - b.inputIndex;
    });
  }

  const flatItems: NormalizedMenuItem[] = [];

  function buildSubtree(parentId: string | null): MenuTreeNode[] {
    const rawSiblings = childrenByParent.get(parentId);
    if (!rawSiblings || rawSiblings.length === 0) {
      return [];
    }
    const ordered = sortSiblings(rawSiblings);
    return ordered.map((candidate, siblingIndex) => {
      const depth = resolvedDepth.get(candidate.id) ?? 1;
      const normalizedItem: NormalizedMenuItem = {
        id: candidate.id,
        parentId: candidate.parentId,
        depth,
        sortOrder: siblingIndex,
        label: candidate.label,
        href: candidate.href,
        openInNewTab: candidate.openInNewTab,
        isExternal: candidate.isExternal,
        rel: candidate.rel,
        targetType: candidate.targetType,
        targetResourceId: candidate.targetResourceId,
      };
      flatItems.push(normalizedItem);
      const children = buildSubtree(candidate.id);
      return {
        ...normalizedItem,
        children,
      };
    });
  }

  const tree = buildSubtree(null);

  return {
    location,
    tree,
    flatItems,
    publicItems: toPublicMenuItems(tree),
    totalItems: flatItems.length,
    maxDepth,
  };
}

/**
 * Projects an internal `MenuTreeNode[]` hierarchy onto the headless-ready
 * 3-level `PublicMenuItemLevel1[]` DTO shape (PLAN §5.2 & §6).
 */
export function toPublicMenuItems(tree: readonly MenuTreeNode[]): PublicMenuItemLevel1[] {
  return tree.map((level1) => ({
    label: level1.label,
    href: level1.href,
    openInNewTab: level1.openInNewTab,
    children: level1.children.map((level2) => ({
      label: level2.label,
      href: level2.href,
      openInNewTab: level2.openInNewTab,
      children: level2.children.map((level3) => ({
        label: level3.label,
        href: level3.href,
        openInNewTab: level3.openInNewTab,
      })),
    })),
  }));
}

/**
 * Collects all item IDs present in a serialized menu tree (for cross-menu parent checks).
 */
export function collectMenuTreeItemIds(tree: readonly MenuTreeNode[]): string[] {
  const ids: string[] = [];
  function walk(nodes: readonly MenuTreeNode[]): void {
    for (const node of nodes) {
      ids.push(node.id);
      if (node.children.length > 0) {
        walk(node.children);
      }
    }
  }
  walk(tree);
  return ids;
}

/**
 * Flattens a persisted `MenuTreeNode[]` in deterministic pre-order while preserving
 * each node's `parentId`, `depth`, and `sortOrder`.
 */
export function flattenMenuTree(tree: readonly MenuTreeNode[]): NormalizedMenuItem[] {
  const result: NormalizedMenuItem[] = [];
  function walk(nodes: readonly MenuTreeNode[]): void {
    for (const node of nodes) {
      result.push({
        id: node.id,
        parentId: node.parentId,
        depth: node.depth,
        sortOrder: node.sortOrder,
        label: node.label,
        href: node.href,
        openInNewTab: node.openInNewTab,
        isExternal: node.isExternal,
        rel: node.rel,
        targetType: node.targetType,
        targetResourceId: node.targetResourceId,
      });
      if (node.children.length > 0) {
        walk(node.children);
      }
    }
  }
  walk(tree);
  return result;
}

/**
 * Shared SEO-Friendly Slug Engine & Reserved-Route Validator (REQ-061, PLAN §6 & §7.1, §7.3).
 *
 * Reusable across CMS resources (`TASK-005` pages, `TASK-006` posts/taxonomies, `TASK-009` offerings):
 * - Deterministic Unicode NFKD diacritic stripping & lowercase ASCII `[a-z0-9-]` normalization
 * - 80-character cap with clean word-boundary trimming (never trailing/double hyphens)
 * - Safe fallback slug when title yields no ASCII letters/digits (`halaman` / `item` / `<prefix>-<id>`)
 * - Strict manual slug validation rejecting uppercase, invalid chars, >80 chars, and reserved slugs
 * - Automatic `-2`, `-3`, ... suffixing preserving the 80-character ceiling
 */

export const MAX_SLUG_LENGTH = 80 as const;

export const SLUG_NAMESPACES = [
  "pages",
  "blog",
  "layanan",
  "produk",
  "tour",
  "kendaraan",
  "blog_category",
  "blog_tag",
  "offering_category",
] as const;

export type SlugNamespace = (typeof SLUG_NAMESPACES)[number];

const SLUG_NAMESPACE_SET: ReadonlySet<string> = new Set(SLUG_NAMESPACES);

/**
 * Reserved root-level public route segments (PLAN §6, §7.1, §7.3).
 * Pages live at `/{pageSlug}`, so none of these prefixes or system files may be claimed.
 */
export const RESERVED_ROOT_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "dashboard",
  "console",
  "auth",
  "account",
  "admin",
  "agency",
  "affiliate",
  "platform",
  "blog",
  "produk",
  "layanan",
  "tour",
  "kendaraan",
  "katalog",
  "sitemap",
  "sitemap.xml",
  "sitemaps",
  "robots.txt",
  "feed.xml",
  "_astro",
  ".well-known",
  "preview",
  "assets",
  "static",
  "cdn-cgi",
  "health",
  "status",
  "login",
  "logout",
  "register",
  "signin",
  "signup",
  "mcp",
  "oauth2",
  "category",
  "tag",
  "categories",
  "tags",
]);

/**
 * Reserved detail slugs within prefixed namespaces (`/blog/{slug}`, `/produk/{slug}`, etc.).
 * Prevents collisions with `/blog/category/{slug}`, `/blog/tag/{slug}`, `/blog/feed.xml`, etc.
 */
export const RESERVED_DETAIL_SLUGS: ReadonlySet<string> = new Set([
  "category",
  "tag",
  "categories",
  "tags",
  "feed.xml",
  "sitemap.xml",
  "sitemaps",
  "robots.txt",
  "api",
  "admin",
  "dashboard",
  "console",
  "auth",
  "account",
  "preview",
  "_astro",
  ".well-known",
  "cdn-cgi",
]);

const RESERVED_PREFIX_PATTERNS = [".well-known", "_astro", "cdn-cgi"] as const;

/**
 * Latin characters that Unicode NFKD does not decompose into ASCII base letters.
 */
const EXTRA_LATIN_TRANSLITERATIONS: Readonly<Record<string, string>> = {
  ß: "ss",
  ẞ: "ss",
  ø: "o",
  Ø: "o",
  đ: "d",
  Đ: "d",
  ð: "d",
  Ð: "d",
  ł: "l",
  Ł: "l",
  æ: "ae",
  Æ: "ae",
  œ: "oe",
  Œ: "oe",
  þ: "th",
  Þ: "th",
};

const STRICT_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type SlugErrorCode =
  | "INVALID_SLUG"
  | "RESERVED_SLUG"
  | "SLUG_CONFLICT"
  | "SLUG_CHANGE_CONFIRMATION_REQUIRED";

export interface SlugValidationIssue {
  readonly field: string;
  readonly code: SlugErrorCode;
  readonly message: string;
}

export class SlugValidationError extends Error {
  readonly httpStatus = 422 as const;
  readonly code: SlugErrorCode;
  readonly field: string;
  readonly suggestedSlug?: string;
  readonly fields: readonly SlugValidationIssue[];

  constructor(
    code: SlugErrorCode,
    message: string,
    options: {
      readonly field?: string;
      readonly suggestedSlug?: string;
    } = {},
  ) {
    super(message);
    this.name = "SlugValidationError";
    this.code = code;
    this.field = options.field ?? "slug";
    this.suggestedSlug = options.suggestedSlug;
    this.fields = [
      {
        field: this.field,
        code,
        message,
      },
    ];
  }
}

export function assertSlugNamespace(value: unknown, field = "namespace"): SlugNamespace {
  if (typeof value !== "string" || !SLUG_NAMESPACE_SET.has(value)) {
    throw new SlugValidationError("INVALID_SLUG", `Invalid slug namespace "${String(value)}".`, {
      field,
    });
  }
  return value as SlugNamespace;
}

export function isReservedSlug(slug: string, namespace: SlugNamespace = "pages"): boolean {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return false;
  for (const prefix of RESERVED_PREFIX_PATTERNS) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  if (namespace === "pages") {
    return RESERVED_ROOT_SLUGS.has(normalized);
  }
  return RESERVED_DETAIL_SLUGS.has(normalized);
}

function transliterateSpecialLatin(input: string): string {
  let out = "";
  for (const ch of input) {
    out += EXTRA_LATIN_TRANSLITERATIONS[ch] ?? ch;
  }
  return out;
}

function trimSlugToMaxLength(rawSlug: string, maxLength: number): string {
  const clean = rawSlug.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (clean.length <= maxLength) {
    return clean;
  }
  // Already ends cleanly on a word boundary right at `maxLength`
  if (clean[maxLength] === "-") {
    return clean.slice(0, maxLength).replace(/-+$/g, "");
  }
  const sliced = clean.slice(0, maxLength);
  const lastHyphen = sliced.lastIndexOf("-");
  // Cut on a word boundary when it preserves a meaningful portion of the slug
  const minBoundary = Math.min(16, Math.floor(maxLength * 0.3));
  if (lastHyphen >= minBoundary) {
    return sliced.slice(0, lastHyphen).replace(/-+$/g, "");
  }
  return sliced.replace(/-+$/g, "");
}

function buildFallbackSlug(
  fallbackPrefix: string | undefined,
  fallbackId: number | string | null | undefined,
  maxLength: number,
): string {
  const cleanPrefix =
    transliterateSpecialLatin(fallbackPrefix ?? "halaman")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "halaman";

  if (fallbackId !== undefined && fallbackId !== null) {
    const cleanId = String(fallbackId)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (cleanId) {
      const suffix = `-${cleanId}`;
      if (suffix.length >= maxLength) {
        return cleanId.slice(0, maxLength).replace(/^-+|-+$/g, "") || "item";
      }
      const prefixRoom = maxLength - suffix.length;
      const trimmedPrefix = cleanPrefix.slice(0, prefixRoom).replace(/-+$/g, "") || "h";
      return `${trimmedPrefix}${suffix}`;
    }
  }

  return trimSlugToMaxLength(cleanPrefix, maxLength) || "halaman";
}

export interface NormalizeSlugOptions {
  readonly maxLength?: number;
  readonly fallbackPrefix?: string;
  readonly fallbackId?: number | string | null;
}

/**
 * Deterministically normalizes a human title into a lowercase ASCII hyphenated slug:
 * - Unicode NFKD diacritic stripping (`Kafe Caffè Sêrū` -> `kafe-caffe-seru`)
 * - Lowercase ASCII `[a-z0-9-]`, collapsed hyphens, trimmed ends
 * - Word-boundary 80-character ceiling
 * - Safe fallback (`halaman` / `item` / `<prefix>-<id>`) when no ASCII alphanumerics remain
 */
export function normalizeTitleToSlug(title: string, options: NormalizeSlugOptions = {}): string {
  const maxLength = Math.max(1, Math.min(MAX_SLUG_LENGTH, options.maxLength ?? MAX_SLUG_LENGTH));

  const ascii = transliterateSpecialLatin(title)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!ascii) {
    return buildFallbackSlug(options.fallbackPrefix, options.fallbackId, maxLength);
  }

  const capped = trimSlugToMaxLength(ascii, maxLength);
  if (!capped) {
    return buildFallbackSlug(options.fallbackPrefix, options.fallbackId, maxLength);
  }
  return capped;
}

/** Ergonomic alias for `normalizeTitleToSlug`. */
export const slugifyTitle = normalizeTitleToSlug;

export interface ValidateManualSlugOptions {
  readonly namespace?: SlugNamespace;
  readonly maxLength?: number;
  readonly field?: string;
}

/**
 * Strictly validates a manually supplied slug without silently mutating or renaming it.
 * Throws `SlugValidationError` (422) on:
 * - Reserved platform/public route names (`RESERVED_SLUG`)
 * - Uppercase letters, whitespace, invalid chars, leading/trailing/double hyphens, or >80 chars (`INVALID_SLUG`)
 */
export function validateManualSlug(
  rawSlug: unknown,
  options: ValidateManualSlugOptions = {},
): string {
  const namespace = options.namespace ?? "pages";
  const maxLength = Math.max(1, Math.min(MAX_SLUG_LENGTH, options.maxLength ?? MAX_SLUG_LENGTH));
  const field = options.field ?? "slug";

  if (typeof rawSlug !== "string") {
    throw new SlugValidationError("INVALID_SLUG", "Slug harus berupa string.", { field });
  }

  const trimmed = rawSlug.trim();
  if (trimmed.length === 0) {
    throw new SlugValidationError("INVALID_SLUG", "Slug tidak boleh kosong.", { field });
  }

  // Check reserved slugs before character validation so `.well-known`, `_astro`,
  // `sitemap.xml`, `robots.txt`, `feed.xml`, `api`, `blog`, etc. yield `RESERVED_SLUG`.
  if (isReservedSlug(trimmed, namespace)) {
    throw new SlugValidationError(
      "RESERVED_SLUG",
      `Slug "${trimmed}" dicadangkan oleh sistem dan tidak dapat digunakan.`,
      { field },
    );
  }

  if (rawSlug !== trimmed) {
    throw new SlugValidationError(
      "INVALID_SLUG",
      "Slug tidak boleh diawali atau diakhiri spasi.",
      { field },
    );
  }

  if (rawSlug.length > maxLength) {
    throw new SlugValidationError(
      "INVALID_SLUG",
      `Slug maksimal ${maxLength} karakter (diterima ${rawSlug.length}).`,
      { field },
    );
  }

  if (/[A-Z]/.test(rawSlug)) {
    throw new SlugValidationError(
      "INVALID_SLUG",
      "Slug harus menggunakan huruf kecil ASCII (a-z), angka (0-9), dan tanda hubung (-).",
      { field },
    );
  }

  if (rawSlug.startsWith("-") || rawSlug.endsWith("-") || rawSlug.includes("--")) {
    throw new SlugValidationError(
      "INVALID_SLUG",
      "Slug tidak boleh diawali/diakhiri tanda hubung atau mengandung tanda hubung ganda (--).",
      { field },
    );
  }

  if (!STRICT_SLUG_REGEX.test(rawSlug)) {
    throw new SlugValidationError(
      "INVALID_SLUG",
      "Slug hanya boleh berisi huruf kecil ASCII (a-z), angka (0-9), dan tanda hubung tunggal (-).",
      { field },
    );
  }

  return rawSlug;
}

/**
 * Appends `-${suffixNumber}` to `baseSlug` while strictly enforcing `<= maxLength` (default 80)
 * and avoiding trailing or double hyphens.
 */
export function buildSuffixedSlug(
  baseSlug: string,
  suffixNumber: number,
  maxLength: number = MAX_SLUG_LENGTH,
): string {
  if (!Number.isInteger(suffixNumber) || suffixNumber < 2) {
    throw new RangeError(`suffixNumber must be an integer >= 2, received ${suffixNumber}`);
  }
  const suffix = `-${suffixNumber}`;
  const cleanBase = baseSlug.replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "item";
  const maxBaseLength = maxLength - suffix.length;
  if (maxBaseLength <= 0) {
    return String(suffixNumber).slice(0, maxLength);
  }

  let truncatedBase = cleanBase;
  if (truncatedBase.length > maxBaseLength) {
    truncatedBase = trimSlugToMaxLength(truncatedBase, maxBaseLength);
  }
  truncatedBase = truncatedBase.replace(/-+$/g, "") || "item".slice(0, maxBaseLength);
  return `${truncatedBase}${suffix}`;
}

export interface ResolveUniqueSlugOptions {
  readonly namespace?: SlugNamespace;
  readonly maxLength?: number;
  readonly maxAttempts?: number;
}

/**
 * Resolves a unique auto-generated slug given an existence predicate `isTaken`,
 * appending `-2`, `-3`, ... on reserved or existing/former-slug collisions while
 * keeping the resulting slug strictly `<= maxLength` (80 chars).
 */
export async function resolveUniqueAutoSlug(
  baseSlug: string,
  isTaken: (candidate: string) => boolean | Promise<boolean>,
  options: ResolveUniqueSlugOptions = {},
): Promise<string> {
  const namespace = options.namespace ?? "pages";
  const maxLength = Math.max(1, Math.min(MAX_SLUG_LENGTH, options.maxLength ?? MAX_SLUG_LENGTH));
  const maxAttempts = Math.max(2, options.maxAttempts ?? 1000);

  const normalizedBase = trimSlugToMaxLength(baseSlug, maxLength) || "halaman";

  if (!isReservedSlug(normalizedBase, namespace) && !(await isTaken(normalizedBase))) {
    return normalizedBase;
  }

  for (let n = 2; n <= maxAttempts + 1; n += 1) {
    const candidate = buildSuffixedSlug(normalizedBase, n, maxLength);
    if (!isReservedSlug(candidate, namespace) && !(await isTaken(candidate))) {
      return candidate;
    }
  }

  throw new SlugValidationError(
    "SLUG_CONFLICT",
    `Unable to allocate a unique slug derived from "${normalizedBase}" after ${maxAttempts} attempts.`,
  );
}

/**
 * Computes a suggested available alternative slug (`-2`, `-3`, ...) for 422 `SLUG_CONFLICT` responses.
 */
export async function suggestAlternativeSlug(
  conflictingSlug: string,
  isTaken: (candidate: string) => boolean | Promise<boolean>,
  options: ResolveUniqueSlugOptions = {},
): Promise<string> {
  const namespace = options.namespace ?? "pages";
  const maxLength = Math.max(1, Math.min(MAX_SLUG_LENGTH, options.maxLength ?? MAX_SLUG_LENGTH));
  const maxAttempts = Math.max(2, options.maxAttempts ?? 1000);

  const normalizedBase = trimSlugToMaxLength(conflictingSlug, maxLength) || "halaman";
  for (let n = 2; n <= maxAttempts + 1; n += 1) {
    const candidate = buildSuffixedSlug(normalizedBase, n, maxLength);
    if (!isReservedSlug(candidate, namespace) && !(await isTaken(candidate))) {
      return candidate;
    }
  }
  return buildSuffixedSlug(normalizedBase, maxAttempts + 2, maxLength);
}

import { PLATFORM_HOSTS } from "../index.ts";
import {
  getOfferingPublicPath,
  isCatalogOfferingType,
  type CatalogOfferingType,
} from "../catalog/index.ts";

/**
 * Canonical Primary URL Builder & Draft Enforcement for Tenant QR Codes
 * (`REQ-108`, `REQ-017`, `REQ-073`, `PLAN §20.5`).
 *
 * Security & Integrity Invariants:
 * - Encodes ONLY the tenant's verified active primary domain origin (`https://<primaryHost>`),
 *   never raw `Host` headers, `X-Forwarded-Host`, or arbitrary client-supplied URLs.
 * - Switching the tenant's primary domain immediately updates the generated QR URL.
 * - Refuses drafts, unpublished items, and trashed items with `QrDraftNotAllowedError`
 *   (`409 DRAFT_QR_NOT_ALLOWED`). Drafts NEVER get a QR code.
 * - Appends strictly `?utm_source=qr` when `includeUtmQr === true`, or clean canonical URL
 *   without query parameters when `includeUtmQr === false`.
 */

export const QR_TARGET_KINDS = ["website", "page", "offering"] as const;
export type QrTargetKind = (typeof QR_TARGET_KINDS)[number];

export const QR_FORMATS = ["svg", "png", "json"] as const;
export type QrFormat = (typeof QR_FORMATS)[number];

export type QrResourceStatus = "published" | "draft" | "unpublished" | "trashed";

export const QR_UTM_QUERY_KEY = "utm_source" as const;
export const QR_UTM_QUERY_VALUE = "qr" as const;

const SLUG_SEGMENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NUMERIC_ONLY_RE = /^\d+$/;
const STRICT_HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_LITERAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const RESERVED_PLATFORM_ORIGINS = new Set<string>([
  PLATFORM_HOSTS.marketing,
  PLATFORM_HOSTS.app,
  PLATFORM_HOSTS.console,
  PLATFORM_HOSTS.saasZone,
  `cname.${PLATFORM_HOSTS.saasZone}`,
  `fallback.${PLATFORM_HOSTS.saasZone}`,
]);

export class QrDraftNotAllowedError extends Error {
  readonly status = 409 as const;
  readonly code = "DRAFT_QR_NOT_ALLOWED" as const;

  constructor(
    message = "Kode QR tidak tersedia untuk draf atau konten yang belum diterbitkan. Terbitkan terlebih dahulu untuk membuat kode QR.",
  ) {
    super(message);
    this.name = "QrDraftNotAllowedError";
  }
}

export class QrValidationError extends Error {
  readonly status = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "QrValidationError";
    this.field = field;
  }
}

export interface CanonicalQrTargetInput {
  /** Verified active primary origin (`https://<primaryHost>`) resolved from PLATFORM_DB. */
  readonly primaryOrigin: string;
  readonly targetKind: QrTargetKind;
  readonly offeringType?: CatalogOfferingType | string | null;
  readonly slug?: string | null;
  readonly isHomepage?: boolean;
  /** Publication status. Required to be `"published"` for pages and offerings. */
  readonly status?: QrResourceStatus | string | null;
  /** Soft-delete timestamp if trashed; any non-null value is rejected. */
  readonly deletedAt?: number | null;
  /** When `true`, appends `?utm_source=qr`; when `false`, emits clean canonical URL. */
  readonly includeUtmQr?: boolean;
}

export interface QrFilenameInput {
  readonly targetKind: QrTargetKind;
  readonly tenantHandle?: string | null;
  readonly offeringType?: CatalogOfferingType | null;
  readonly slug?: string | null;
  readonly isHomepage?: boolean;
  readonly format: "svg" | "png";
}

/**
 * Strictly validates that `primaryOrigin` is a clean `https://<hostname>` origin
 * belonging to a public tenant host (no path, query, fragment, port, credentials, IP, or platform host).
 */
export function normalizeVerifiedPrimaryOrigin(rawOrigin: string): string {
  if (typeof rawOrigin !== "string") {
    throw new QrValidationError("Domain utama situs tidak valid.", "primaryOrigin");
  }
  const trimmed = rawOrigin.trim();
  if (!trimmed || trimmed.length > 265) {
    throw new QrValidationError("Domain utama situs tidak valid.", "primaryOrigin");
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      throw new QrValidationError("Domain utama situs mengandung karakter tidak valid.", "primaryOrigin");
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new QrValidationError("Domain utama situs harus berupa URL https:// yang valid.", "primaryOrigin");
  }

  if (parsed.protocol !== "https:") {
    throw new QrValidationError("Kode QR hanya mendukung domain utama HTTPS.", "primaryOrigin");
  }
  if (parsed.username || parsed.password || parsed.port) {
    throw new QrValidationError("Domain utama situs tidak boleh memuat kredensial atau port.", "primaryOrigin");
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new QrValidationError("Origin domain utama tidak boleh memuat path, query, atau fragment.", "primaryOrigin");
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !host ||
    host.length > 253 ||
    IPV4_LITERAL_RE.test(host) ||
    !STRICT_HOSTNAME_RE.test(host) ||
    RESERVED_PLATFORM_ORIGINS.has(host) ||
    host.endsWith(`.${PLATFORM_HOSTS.marketing}`)
  ) {
    throw new QrValidationError("Hostname domain utama tidak valid untuk kode QR tenant.", "primaryOrigin");
  }

  return `https://${host}`;
}

function assertPublishedResourceStatus(
  status: string | null | undefined,
  deletedAt: number | null | undefined,
  targetLabel: string,
): void {
  if (deletedAt !== null && deletedAt !== undefined) {
    throw new QrDraftNotAllowedError(
      `Kode QR tidak tersedia karena ${targetLabel} telah dihapus atau dipindahkan ke sampah.`,
    );
  }
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (normalized !== "published") {
    throw new QrDraftNotAllowedError(
      `Kode QR tidak tersedia untuk ${targetLabel} berstatus draf atau belum diterbitkan. Terbitkan terlebih dahulu.`,
    );
  }
}

function normalizeCanonicalSlug(rawSlug: string | null | undefined, field: string): string {
  if (typeof rawSlug !== "string") {
    throw new QrValidationError("Slug konten wajib diisi untuk membuat kode QR.", field);
  }
  const slug = rawSlug.trim().toLowerCase();
  if (!slug || slug.length > 80 || !SLUG_SEGMENT_RE.test(slug) || NUMERIC_ONLY_RE.test(slug)) {
    throw new QrValidationError("Slug konten tidak valid untuk URL kanonik kode QR.", field);
  }
  return slug;
}

/**
 * Builds the canonical primary URL to be encoded into a free tenant QR code.
 */
export function buildCanonicalQrTargetUrl(input: CanonicalQrTargetInput): string {
  const origin = normalizeVerifiedPrimaryOrigin(input.primaryOrigin);

  if (
    input.targetKind !== "website" &&
    input.targetKind !== "page" &&
    input.targetKind !== "offering"
  ) {
    throw new QrValidationError("Jenis target QR harus salah satu dari website, page, atau offering.", "target");
  }

  let canonicalPath: string;

  if (input.targetKind === "website") {
    if (input.deletedAt !== null && input.deletedAt !== undefined) {
      throw new QrDraftNotAllowedError("Kode QR tidak tersedia untuk situs yang telah dihapus.");
    }
    if (input.status !== undefined && input.status !== null) {
      const st = String(input.status).trim().toLowerCase();
      if (st === "draft" || st === "unpublished" || st === "trashed") {
        throw new QrDraftNotAllowedError("Kode QR tidak tersedia untuk situs berstatus draf.");
      }
    }
    canonicalPath = "/";
  } else if (input.targetKind === "page") {
    assertPublishedResourceStatus(input.status, input.deletedAt, "halaman");
    if (input.isHomepage === true) {
      canonicalPath = "/";
    } else {
      const slug = normalizeCanonicalSlug(input.slug, "slug");
      canonicalPath = `/${slug}`;
    }
  } else {
    assertPublishedResourceStatus(input.status, input.deletedAt, "penawaran");
    if (!isCatalogOfferingType(input.offeringType)) {
      throw new QrValidationError(
        "Jenis penawaran tidak valid (harus service, product, tour, atau vehicle).",
        "offeringType",
      );
    }
    const slug = normalizeCanonicalSlug(input.slug, "slug");
    canonicalPath = getOfferingPublicPath(input.offeringType, slug);
  }

  const baseUrl = `${origin}${canonicalPath}`;
  if (input.includeUtmQr === true) {
    return `${baseUrl}?${QR_UTM_QUERY_KEY}=${QR_UTM_QUERY_VALUE}`;
  }
  return baseUrl;
}

function sanitizeFilenameSlug(raw: string | null | undefined, fallback: string): string {
  const clean = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return clean || fallback;
}

/**
 * Generates a strictly ASCII-safe download filename for Content-Disposition (`qr-<slug>.<ext>`).
 */
export function buildQrDownloadFilename(input: QrFilenameInput): string {
  const ext = input.format === "png" ? "png" : "svg";
  let part: string;
  if (input.targetKind === "website") {
    part = sanitizeFilenameSlug(input.tenantHandle, "situs");
  } else if (input.targetKind === "page") {
    part = input.isHomepage
      ? sanitizeFilenameSlug(input.tenantHandle ?? "beranda", "beranda")
      : sanitizeFilenameSlug(input.slug, "halaman");
  } else {
    const slugPart = sanitizeFilenameSlug(input.slug, "penawaran");
    part = input.offeringType ? `${input.offeringType}-${slugPart}` : slugPart;
  }
  return `qr-${part}.${ext}`;
}

/**
 * Builds the scoped tenant QR API download/metadata URL for client buttons.
 */
export function buildTenantQrApiUrl(params: {
  readonly tenantId: string;
  readonly targetKind: QrTargetKind;
  readonly targetId?: number | null;
  readonly format: QrFormat;
  readonly includeUtmQr: boolean;
  readonly apiBasePath?: string;
}): string {
  const base =
    params.apiBasePath ?? `/api/tenants/${encodeURIComponent(params.tenantId)}/qr`;
  const query = new URLSearchParams();
  query.set("target", params.targetKind);
  if (params.targetKind !== "website" && typeof params.targetId === "number") {
    query.set("id", String(params.targetId));
  }
  query.set("format", params.format);
  query.set("utm", params.includeUtmQr ? "1" : "0");
  return `${base}?${query.toString()}`;
}

import {
  DELETION_UNDO_WINDOW_MS,
  EXPORT_ARCHIVE_FORMAT_VERSION,
  JAKARTA_UTC_OFFSET_MS,
  MAX_DELETION_REASON_LENGTH,
  MAX_EXPORT_ARCHIVE_BYTES,
  MAX_EXPORT_MEDIA_FILES,
  MAX_EXPORT_SINGLE_MEDIA_BYTES,
} from "./constants.ts";
import { sha256HexBytes } from "./signing.ts";
import { buildZipArchive, type ZipEntryInput } from "./zip.ts";

/**
 * Pure archive assembly, secret scrubbing, R2 key validation, Jakarta day-key calculation,
 * formula-safe CSV serialization, and self-service deletion validation (REQ-107, TASK-107).
 */

const FORBIDDEN_EXPORT_KEY_PATTERN =
  /(password|secret|token|backup_?codes|api_?key|private_?key|cookie|credential|session_?id|auth_?hash)/i;

const CSV_FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;
const SAFE_BASENAME_RE = /[^A-Za-z0-9._-]+/g;

export interface ExportLeadRowInput {
  readonly id: number;
  readonly name: string;
  readonly phone: string;
  readonly email: string | null;
  readonly message: string;
  readonly status: string;
  readonly preferredDate: string | null;
  readonly preferredTime: string | null;
  readonly branchId: number | null;
  readonly sourceCategory: string;
  readonly pagePath: string | null;
  readonly utm: Record<string, string> | null;
  readonly internalNotes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExportMediaFileInput {
  readonly id: number;
  readonly r2Key: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly altText: string;
  readonly data: Uint8Array;
}

export interface ExportSkippedMediaRecord {
  readonly id: number;
  readonly r2Key: string;
  readonly reason: "outside_tenant_prefix" | "single_file_too_large" | "max_files_reached" | "archive_budget_exceeded" | "missing_r2_object";
}

export interface ExportTruncationFlags {
  readonly pages: boolean;
  readonly posts: boolean;
  readonly offerings: boolean;
  readonly leads: boolean;
  readonly media: boolean;
  readonly any: boolean;
}

export interface ExportManifest {
  readonly formatVersion: typeof EXPORT_ARCHIVE_FORMAT_VERSION;
  readonly exportId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly generatedAtIso: string;
  readonly counts: {
    readonly pages: number;
    readonly posts: number;
    readonly offerings: number;
    readonly leads: number;
    readonly mediaIncluded: number;
    readonly mediaSkipped: number;
  };
  readonly truncated: ExportTruncationFlags;
  readonly files: readonly string[];
  readonly skippedMedia: readonly ExportSkippedMediaRecord[];
}

export interface BuildSiteExportArchiveInput {
  readonly exportId: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly vertical: string;
  readonly siteSettings: Record<string, unknown> | null;
  readonly businessProfile: Record<string, unknown> | null;
  readonly pages: readonly Record<string, unknown>[];
  readonly posts: readonly Record<string, unknown>[];
  readonly offerings: readonly Record<string, unknown>[];
  readonly leads: readonly ExportLeadRowInput[];
  readonly mediaFiles: readonly ExportMediaFileInput[];
  readonly preSkippedMedia?: readonly ExportSkippedMediaRecord[];
  readonly truncatedCollections?: {
    readonly pages?: boolean;
    readonly posts?: boolean;
    readonly offerings?: boolean;
    readonly leads?: boolean;
    readonly media?: boolean;
  };
  readonly generatedAtMs?: number;
  readonly maxArchiveBytes?: number;
  readonly maxMediaFiles?: number;
  readonly maxSingleMediaBytes?: number;
}

export interface BuiltSiteExportArchive {
  readonly zipBytes: Uint8Array;
  readonly sha256Hex: string;
  readonly manifest: ExportManifest;
}

/**
 * Computes the `YYYY-MM-DD` calendar day string in Asia/Jakarta (`UTC+7`, no DST).
 * Used to enforce the strict 1-export-per-website-per-day rule deterministically.
 */
export function getJakartaDayKey(epochMs: number): string {
  const shifted = new Date(Math.trunc(epochMs) + JAKARTA_UTC_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Computes seconds remaining until the next midnight in Asia/Jakarta (`UTC+7`)
 * for accurate `Retry-After` headers on 1/day export rate limiting.
 */
export function secondsUntilNextJakartaDay(epochMs: number): number {
  const safeMs = Math.trunc(epochMs);
  const shifted = safeMs + JAKARTA_UTC_OFFSET_MS;
  const dayMs = 24 * 60 * 60 * 1000;
  const elapsedInDay = ((shifted % dayMs) + dayMs) % dayMs;
  const remainingMs = dayMs - elapsedInDay;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/**
 * Builds the canonical tenant-scoped R2 key for an export archive:
 * `t/<tenantId>/exports/<exportId>.zip`.
 */
export function buildTenantExportR2Key(tenantId: string, exportId: string): string {
  const cleanTenant = tenantId.trim();
  const cleanExport = exportId.trim();
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(cleanTenant)) {
    throw new Error("INVALID_EXPORT_TENANT_ID");
  }
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(cleanExport)) {
    throw new Error("INVALID_EXPORT_ID");
  }
  return `t/${cleanTenant}/exports/${cleanExport}.zip`;
}

/**
 * Validates that an R2 object key belongs strictly to `t/<tenantId>/` (no traversal,
 * no cross-tenant prefix) and is an eligible tenant media asset (never `exports/` or `trash/`).
 */
export function isEligibleTenantMediaR2Key(tenantId: string, r2Key: string): boolean {
  const cleanTenant = tenantId.trim();
  if (!cleanTenant || !r2Key) return false;
  if (r2Key.includes("\\") || r2Key.includes("\0") || r2Key.includes("..")) return false;
  const prefix = `t/${cleanTenant}/`;
  if (!r2Key.startsWith(prefix)) return false;
  const rest = r2Key.slice(prefix.length);
  if (!rest || rest.startsWith("/") || rest.startsWith("exports/") || rest.startsWith("trash/")) {
    return false;
  }
  return true;
}

/**
 * Recursively strips any key whose name indicates secrets, credentials, passwords, or tokens
 * as defense-in-depth before serializing tenant data into an export archive.
 */
export function scrubSensitiveExportFields<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubSensitiveExportFields(item)) as unknown as T;
  }
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    if (FORBIDDEN_EXPORT_KEY_PATTERN.test(key)) {
      continue;
    }
    out[key] = scrubSensitiveExportFields(val);
  }
  return out as T;
}

function quoteCsvCell(str: string): string {
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Free-text CSV cell escaping with spreadsheet formula-injection neutralization
 * (`=`, `+`, `-`, `@`, `\t`, `\r` prefixed with `'`).
 */
function escapeCsvTextCell(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  let str = String(raw);
  if (CSV_FORMULA_PREFIX_RE.test(str)) {
    str = `'${str}`;
  }
  return quoteCsvCell(str);
}

/**
 * Structured CSV cell escaping (RFC 4180 quoting only, preserving exact E.164 `+62...` phones,
 * ISO timestamps, numeric IDs, and closed enum tokens without adding a leading `'`).
 */
function escapeCsvStructuredCell(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  return quoteCsvCell(String(raw));
}

/**
 * Serializes tenant leads to formula-injection-safe UTF-8 CSV while preserving
 * faithful structured E.164 `+62...` phone numbers, ISO dates, and IDs.
 */
export function serializeExportLeadsCsv(leads: readonly ExportLeadRowInput[]): string {
  const header = [
    "id",
    "created_at",
    "status",
    "name",
    "phone_e164",
    "email",
    "message",
    "preferred_date",
    "preferred_time",
    "branch_id",
    "source_category",
    "page_path",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "internal_notes",
    "updated_at",
  ].join(",");

  const lines: string[] = [header];
  for (const lead of leads) {
    const utm = lead.utm ?? {};
    lines.push(
      [
        escapeCsvStructuredCell(lead.id),
        escapeCsvStructuredCell(lead.createdAt),
        escapeCsvStructuredCell(lead.status),
        escapeCsvTextCell(lead.name),
        escapeCsvStructuredCell(lead.phone),
        escapeCsvTextCell(lead.email),
        escapeCsvTextCell(lead.message),
        escapeCsvStructuredCell(lead.preferredDate),
        escapeCsvStructuredCell(lead.preferredTime),
        escapeCsvStructuredCell(lead.branchId),
        escapeCsvStructuredCell(lead.sourceCategory),
        escapeCsvTextCell(lead.pagePath),
        escapeCsvTextCell(utm.utm_source ?? utm.source ?? null),
        escapeCsvTextCell(utm.utm_medium ?? utm.medium ?? null),
        escapeCsvTextCell(utm.utm_campaign ?? utm.campaign ?? null),
        escapeCsvTextCell(utm.utm_term ?? utm.term ?? null),
        escapeCsvTextCell(utm.utm_content ?? utm.content ?? null),
        escapeCsvTextCell(lead.internalNotes),
        escapeCsvStructuredCell(lead.updatedAt),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Derives a safe, collision-free archive path under `media/` for a tenant media file.
 */
export function buildSafeMediaArchivePath(
  mediaId: number,
  r2Key: string,
  mimeType: string,
): string {
  const rawBase = r2Key.split("/").pop() ?? "";
  const cleaned = rawBase.replace(SAFE_BASENAME_RE, "_").replace(/^\.+/, "").slice(0, 80);
  if (cleaned.length > 0 && cleaned !== "." && cleaned !== "..") {
    return `media/${mediaId}-${cleaned}`;
  }
  const extFromMime =
    mimeType === "image/webp"
      ? "webp"
      : mimeType === "image/png"
        ? "png"
        : mimeType === "image/jpeg"
          ? "jpg"
          : mimeType === "image/svg+xml"
            ? "svg"
            : mimeType === "video/mp4"
              ? "mp4"
              : "bin";
  return `media/${mediaId}-asset.${extFromMime}`;
}

/**
 * Assembles the complete owner full-website export ZIP archive containing:
 * - `manifest.json`
 * - `site.json`
 * - `pages.json`
 * - `posts.json`
 * - `offerings.json`
 * - `leads.csv`
 * - `media/<id>-<safe-filename>`
 */
export async function buildSiteExportArchive(
  input: BuildSiteExportArchiveInput,
): Promise<BuiltSiteExportArchive> {
  const generatedAtMs = Math.trunc(input.generatedAtMs ?? Date.now());
  const generatedAtIso = new Date(generatedAtMs).toISOString();
  const maxArchiveBytes = Math.max(
    16_384,
    Math.trunc(input.maxArchiveBytes ?? MAX_EXPORT_ARCHIVE_BYTES),
  );
  const maxMediaFiles = Math.max(0, Math.trunc(input.maxMediaFiles ?? MAX_EXPORT_MEDIA_FILES));
  const maxSingleMediaBytes = Math.max(
    1024,
    Math.trunc(input.maxSingleMediaBytes ?? MAX_EXPORT_SINGLE_MEDIA_BYTES),
  );

  const sanitizedPages = input.pages.map((p) => scrubSensitiveExportFields(p));
  const sanitizedPosts = input.posts.map((p) => scrubSensitiveExportFields(p));
  const sanitizedOfferings = input.offerings.map((o) => scrubSensitiveExportFields(o));

  const siteJson = JSON.stringify(
    scrubSensitiveExportFields({
      tenant: {
        handle: input.tenantHandle,
        name: input.tenantName,
        vertical: input.vertical,
      },
      siteSettings: input.siteSettings,
      businessProfile: input.businessProfile,
      exportedAt: generatedAtIso,
    }),
    null,
    2,
  );
  const pagesJson = JSON.stringify({ count: sanitizedPages.length, items: sanitizedPages }, null, 2);
  const postsJson = JSON.stringify({ count: sanitizedPosts.length, items: sanitizedPosts }, null, 2);
  const offeringsJson = JSON.stringify(
    { count: sanitizedOfferings.length, items: sanitizedOfferings },
    null,
    2,
  );
  const leadsCsv = serializeExportLeadsCsv(input.leads);

  const encoder = new TextEncoder();
  const baseEntries: ZipEntryInput[] = [
    { path: "site.json", data: encoder.encode(siteJson), modifiedAtMs: generatedAtMs },
    { path: "pages.json", data: encoder.encode(pagesJson), modifiedAtMs: generatedAtMs },
    { path: "posts.json", data: encoder.encode(postsJson), modifiedAtMs: generatedAtMs },
    { path: "offerings.json", data: encoder.encode(offeringsJson), modifiedAtMs: generatedAtMs },
    { path: "leads.csv", data: encoder.encode(leadsCsv), modifiedAtMs: generatedAtMs },
  ];

  // Reserve generous headroom for manifest.json + ZIP central directory/headers
  let estimatedZipBytes = 16_384;
  for (const e of baseEntries) {
    const len = typeof e.data === "string" ? encoder.encode(e.data).byteLength : e.data.byteLength;
    estimatedZipBytes += len + 128 + e.path.length * 2;
  }

  const skippedMedia: ExportSkippedMediaRecord[] = [...(input.preSkippedMedia ?? [])];
  const mediaEntries: ZipEntryInput[] = [];
  const usedPaths = new Set<string>(baseEntries.map((e) => e.path));

  for (const media of input.mediaFiles) {
    if (!isEligibleTenantMediaR2Key(input.tenantId, media.r2Key)) {
      skippedMedia.push({
        id: media.id,
        r2Key: media.r2Key,
        reason: "outside_tenant_prefix",
      });
      continue;
    }
    if (mediaEntries.length >= maxMediaFiles) {
      skippedMedia.push({
        id: media.id,
        r2Key: media.r2Key,
        reason: "max_files_reached",
      });
      continue;
    }
    if (media.data.byteLength > maxSingleMediaBytes) {
      skippedMedia.push({
        id: media.id,
        r2Key: media.r2Key,
        reason: "single_file_too_large",
      });
      continue;
    }

    let archivePath = buildSafeMediaArchivePath(media.id, media.r2Key, media.mimeType);
    if (usedPaths.has(archivePath)) {
      archivePath = `media/${media.id}-${mediaEntries.length + 1}.bin`;
    }

    const entryOverhead = media.data.byteLength + 128 + archivePath.length * 2;
    if (estimatedZipBytes + entryOverhead > maxArchiveBytes) {
      skippedMedia.push({
        id: media.id,
        r2Key: media.r2Key,
        reason: "archive_budget_exceeded",
      });
      continue;
    }

    usedPaths.add(archivePath);
    estimatedZipBytes += entryOverhead;
    mediaEntries.push({
      path: archivePath,
      data: media.data,
      modifiedAtMs: generatedAtMs,
    });
  }

  const allFilePaths = [
    "manifest.json",
    ...baseEntries.map((e) => e.path),
    ...mediaEntries.map((e) => e.path),
  ];

  const truncatedPages = Boolean(input.truncatedCollections?.pages);
  const truncatedPosts = Boolean(input.truncatedCollections?.posts);
  const truncatedOfferings = Boolean(input.truncatedCollections?.offerings);
  const truncatedLeads = Boolean(input.truncatedCollections?.leads);
  const truncatedMedia =
    Boolean(input.truncatedCollections?.media) ||
    skippedMedia.some(
      (s) =>
        s.reason === "max_files_reached" ||
        s.reason === "single_file_too_large" ||
        s.reason === "archive_budget_exceeded",
    );

  const manifest: ExportManifest = {
    formatVersion: EXPORT_ARCHIVE_FORMAT_VERSION,
    exportId: input.exportId,
    tenantHandle: input.tenantHandle,
    tenantName: input.tenantName,
    generatedAtIso,
    counts: {
      pages: sanitizedPages.length,
      posts: sanitizedPosts.length,
      offerings: sanitizedOfferings.length,
      leads: input.leads.length,
      mediaIncluded: mediaEntries.length,
      mediaSkipped: skippedMedia.length,
    },
    truncated: {
      pages: truncatedPages,
      posts: truncatedPosts,
      offerings: truncatedOfferings,
      leads: truncatedLeads,
      media: truncatedMedia,
      any:
        truncatedPages ||
        truncatedPosts ||
        truncatedOfferings ||
        truncatedLeads ||
        truncatedMedia,
    },
    files: allFilePaths,
    skippedMedia,
  };

  const manifestEntry: ZipEntryInput = {
    path: "manifest.json",
    data: encoder.encode(JSON.stringify(manifest, null, 2)),
    modifiedAtMs: generatedAtMs,
  };

  const zipBytes = buildZipArchive([manifestEntry, ...baseEntries, ...mediaEntries], {
    maxTotalBytes: maxArchiveBytes,
    defaultModifiedAtMs: generatedAtMs,
  });
  const sha256Hex = await sha256HexBytes(zipBytes);

  return { zipBytes, sha256Hex, manifest };
}

/**
 * Validates typed confirmation for self-service website deletion.
 * Accepts exact tenant handle (case-insensitive trimmed).
 */
export function validateDeletionConfirmationInput(input: {
  readonly expectedHandle: string;
  readonly confirmHandle: unknown;
  readonly reason?: unknown;
}):
  | { readonly ok: true; readonly reason: string | null }
  | { readonly ok: false; readonly field: "confirmHandle" | "reason"; readonly message: string } {
  const expected = input.expectedHandle.trim().toLowerCase();
  const provided = typeof input.confirmHandle === "string" ? input.confirmHandle.trim().toLowerCase() : "";

  if (!provided || provided !== expected) {
    return {
      ok: false,
      field: "confirmHandle",
      message: `Konfirmasi tidak sesuai. Ketik persis handle situs "${expected}" untuk melanjutkan penghapusan.`,
    };
  }

  if (input.reason !== undefined && input.reason !== null) {
    if (typeof input.reason !== "string") {
      return {
        ok: false,
        field: "reason",
        message: "Alasan penghapusan harus berupa teks.",
      };
    }
    const cleanReason = input.reason.trim();
    if (cleanReason.length > MAX_DELETION_REASON_LENGTH) {
      return {
        ok: false,
        field: "reason",
        message: `Alasan penghapusan maksimal ${MAX_DELETION_REASON_LENGTH} karakter.`,
      };
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(cleanReason)) {
      return {
        ok: false,
        field: "reason",
        message: "Alasan penghapusan mengandung karakter tidak valid.",
      };
    }
    return { ok: true, reason: cleanReason.length > 0 ? cleanReason : null };
  }

  return { ok: true, reason: null };
}

/**
 * Computes exact 7-day self-service deletion schedule timestamps.
 */
export function computeSelfServiceDeletionSchedule(nowMs: number): {
  readonly deletionRequestedAtMs: number;
  readonly deletionDueAtMs: number;
} {
  const requestedAt = Math.trunc(nowMs);
  return {
    deletionRequestedAtMs: requestedAt,
    deletionDueAtMs: requestedAt + DELETION_UNDO_WINDOW_MS,
  };
}

/**
 * Returns true strictly while `nowMs < deletionDueAtMs` (before the 7-day undo window closes).
 */
export function isWithinDeletionUndoWindow(deletionDueAtMs: number, nowMs: number): boolean {
  return Math.trunc(nowMs) < Math.trunc(deletionDueAtMs);
}

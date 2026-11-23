import type { CatalogOfferingType } from "@punyasitus/core/catalog/index";
import type { ApiErrorCode } from "@punyasitus/core/schemas";
import type { SlugNamespace } from "@punyasitus/core/slug/index";

/**
 * Shared types and typed error hierarchy for Content Trash, Recovery & 30-Day Purge
 * (`packages/db/src/trash/**`; TASK-044, REQ-048, PLAN §11.5).
 */

export const TRASH_RETENTION_DAYS = 30 as const;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type ContentResourceType = "page" | "post" | "offering";

export type ProtectedReferenceKind = "homepage" | "policy_setting" | "navigation_menu";

export interface ProtectedContentReference {
  readonly kind: ProtectedReferenceKind;
  readonly sourceTable: "pages" | "site_settings" | "menus";
  readonly location?: string;
  readonly itemId?: string;
  readonly label?: string;
  readonly field?: string;
  readonly reason: string;
}

export interface MediaReferenceWarning {
  readonly mediaId: number;
  readonly status: "missing" | "trashed" | "unavailable";
  readonly message: string;
}

export interface ContentMediaReferenceReport {
  readonly referencedMediaIds: readonly number[];
  readonly validMediaIds: readonly number[];
  readonly missingMediaIds: readonly number[];
  readonly trashedMediaIds: readonly number[];
  readonly unavailableMediaIds: readonly number[];
  readonly warnings: readonly MediaReferenceWarning[];
}

export interface TrashActorContext {
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
}

export interface TrashRetentionMeta {
  readonly deletedAt: string;
  readonly purgeEligibleAt: string;
  readonly daysRemaining: number;
  readonly isExpired: boolean;
}

export interface TrashContentInput extends TrashActorContext {
  readonly tenantId: string;
  readonly resourceType: ContentResourceType;
  readonly resourceId: number;
  readonly expectedVersion?: number;
  readonly nowMs?: number;
}

export interface TrashContentResult {
  readonly resourceType: ContentResourceType;
  readonly resourceId: number;
  readonly slug: string;
  readonly title: string;
  readonly offeringType: CatalogOfferingType | null;
  readonly status: "trashed";
  readonly wasPublished: boolean;
  readonly version: number;
  readonly deletedAt: string;
  readonly purgeEligibleAt: string;
  readonly daysRemaining: number;
  readonly cacheVersion: number | null;
  readonly auditRecorded: boolean;
}

export interface RestoreContentInput extends TrashActorContext {
  readonly resourceType: ContentResourceType;
  readonly resourceId: number;
  readonly expectedVersion: number;
  readonly resolvedSlug?: string;
  readonly nowMs?: number;
}

export interface RestoreContentResult {
  readonly resourceType: ContentResourceType;
  readonly resourceId: number;
  readonly slug: string;
  readonly previousSlug: string;
  readonly slugChanged: boolean;
  readonly title: string;
  readonly offeringType: CatalogOfferingType | null;
  readonly status: "draft";
  readonly isHomepage: boolean;
  readonly homepageDemoted: boolean;
  readonly version: number;
  readonly restoredAt: string;
  readonly mediaReferences: ContentMediaReferenceReport;
  readonly auditRecorded: boolean;
}

export interface PurgeContentInput extends TrashActorContext {
  readonly resourceType: ContentResourceType;
  readonly resourceId: number;
  readonly expectedVersion?: number;
  readonly source?: "manual_purge" | "scheduled_purge";
  readonly nowMs?: number;
}

export interface PurgeClearedCounts {
  readonly taxonomies: number;
  readonly resourceSlugs: number;
  readonly revisions: number;
}

export interface PurgeContentResult {
  readonly purged: true;
  readonly resourceType: ContentResourceType;
  readonly resourceId: number;
  readonly slug: string;
  readonly title: string;
  readonly offeringType: CatalogOfferingType | null;
  readonly clearedCounts: PurgeClearedCounts;
  readonly preservedMediaIds: readonly number[];
  readonly purgedAt: string;
  readonly auditRecorded: boolean;
}

export interface TrashedContentSummary {
  readonly resourceType: ContentResourceType;
  readonly resourceId: number;
  readonly offeringType: CatalogOfferingType | null;
  readonly slug: string;
  readonly publicPath: string;
  readonly title: string;
  readonly isHomepage: boolean;
  readonly version: number;
  readonly deletedAt: string;
  readonly purgeEligibleAt: string;
  readonly daysRemaining: number;
  readonly isExpired: boolean;
  readonly updatedAt: string;
  readonly protectedReferences: readonly ProtectedContentReference[];
  readonly mediaReferences: ContentMediaReferenceReport;
}

export interface ProtectedReferencePurgeFailure {
  readonly tenantId: string;
  readonly resourceType: ContentResourceType;
  readonly resourceId: number;
  readonly slug: string;
  readonly deletedAt: string;
  readonly errorCode: "PROTECTED_REFERENCE";
  readonly protectedReferences: readonly ProtectedContentReference[];
}

export interface TenantContentPurgeSweepInput {
  readonly tenantId: string;
  readonly nowMs?: number;
  readonly retentionMs?: number;
}

export interface TenantContentPurgeSweepResult {
  readonly tenantId: string;
  readonly cutoffMs: number;
  readonly scannedCount: number;
  readonly purgedCount: number;
  readonly skippedConcurrentCount: number;
  readonly blockedCount: number;
  readonly purgedItems: readonly PurgeContentResult[];
  readonly blockedItems: readonly ProtectedReferencePurgeFailure[];
}

export interface TrashErrorField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class TrashNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code: ApiErrorCode = "NOT_FOUND";
  readonly resourceType: ContentResourceType;
  readonly resourceId: number;

  constructor(resourceType: ContentResourceType, resourceId: number, message?: string) {
    super(message ?? `${resourceType} #${resourceId} tidak ditemukan di sampah tenant.`);
    this.name = "TrashNotFoundError";
    this.resourceType = resourceType;
    this.resourceId = resourceId;
  }
}

export class TrashValidationError extends Error {
  readonly status = 422 as const;
  readonly code: ApiErrorCode = "VALIDATION_ERROR";
  readonly fields: readonly TrashErrorField[];

  constructor(message: string, fields: readonly TrashErrorField[] = []) {
    super(message);
    this.name = "TrashValidationError";
    this.fields = fields;
  }
}

export class TrashConflictError extends Error {
  readonly status = 409 as const;
  readonly code: ApiErrorCode;
  readonly field: string;
  readonly fieldCode: string;
  readonly suggestedSlug?: string;
  readonly conflictKind?: "active_resource" | "former_slug_redirect" | "custom_redirect" | "not_trashed";
  readonly fields: readonly TrashErrorField[];

  constructor(
    message: string,
    options: {
      readonly code?: ApiErrorCode;
      readonly field: string;
      readonly fieldCode: string;
      readonly suggestedSlug?: string;
      readonly conflictKind?: "active_resource" | "former_slug_redirect" | "custom_redirect" | "not_trashed";
    },
  ) {
    super(message);
    this.name = "TrashConflictError";
    this.code = options.code ?? "CONFLICT";
    this.field = options.field;
    this.fieldCode = options.fieldCode;
    this.suggestedSlug = options.suggestedSlug;
    this.conflictKind = options.conflictKind;
    this.fields = [
      {
        field: options.field,
        code: options.fieldCode,
        message,
      },
    ];
  }
}

export class TrashProtectedReferenceError extends Error {
  readonly status = 409 as const;
  readonly code: ApiErrorCode = "CONFLICT";
  readonly field = "references" as const;
  readonly fieldCode = "PROTECTED_REFERENCE" as const;
  readonly resourceType: ContentResourceType;
  readonly resourceId: number;
  readonly references: readonly ProtectedContentReference[];
  readonly fields: readonly TrashErrorField[];

  constructor(
    resourceType: ContentResourceType,
    resourceId: number,
    references: readonly ProtectedContentReference[],
    message?: string,
  ) {
    const summary = references.map((r) => r.reason).join("; ");
    const resolvedMessage =
      message ??
      `Konten tidak dapat dihapus permanen karena masih digunakan oleh referensi terlindungi: ${summary}`;
    super(resolvedMessage);
    this.name = "TrashProtectedReferenceError";
    this.resourceType = resourceType;
    this.resourceId = resourceId;
    this.references = references;
    this.fields = [
      {
        field: "references",
        code: "PROTECTED_REFERENCE",
        message: resolvedMessage,
      },
    ];
  }
}

export function resolveContentSlugNamespace(
  resourceType: ContentResourceType,
  offeringType: CatalogOfferingType | null,
): SlugNamespace {
  if (resourceType === "page") return "pages";
  if (resourceType === "post") return "blog";
  switch (offeringType) {
    case "product":
      return "produk";
    case "tour":
      return "tour";
    case "vehicle":
      return "kendaraan";
    case "service":
    default:
      return "layanan";
  }
}

export function resolveContentPublicPath(
  resourceType: ContentResourceType,
  slug: string,
  offeringType: CatalogOfferingType | null,
  isHomepage = false,
): string {
  if (resourceType === "page") {
    return isHomepage ? "/" : `/${slug}`;
  }
  if (resourceType === "post") {
    return `/blog/${slug}`;
  }
  const ns = resolveContentSlugNamespace("offering", offeringType);
  return `/${ns}/${slug}`;
}

export function computeTrashRetentionMeta(
  deletedAtMs: number,
  nowMs: number,
  retentionMs: number = TRASH_RETENTION_MS,
): TrashRetentionMeta {
  const purgeEligibleAtMs = deletedAtMs + retentionMs;
  const remainingMs = purgeEligibleAtMs - nowMs;
  const daysRemaining = remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 86_400_000);
  return {
    deletedAt: new Date(deletedAtMs).toISOString(),
    purgeEligibleAt: new Date(purgeEligibleAtMs).toISOString(),
    daysRemaining,
    isExpired: remainingMs <= 0,
  };
}

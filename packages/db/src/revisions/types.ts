import type { ResourceLifecycleStatus } from "@punyasitus/core/content/index";

/**
 * Shared types, deterministic ID codec, constants, and domain errors for
 * Content Revision History (`packages/db/src/revisions/types.ts`; TASK-064, REQ-048, PLAN §5 & §11.5).
 */

export const MAX_CONTENT_REVISIONS_PER_RESOURCE = 20 as const;
export const CURRENT_REVISION_SCHEMA_VERSION = 1 as const;

export const REVISION_RESOURCE_TYPES = ["page", "post", "offering"] as const;
export type RevisionResourceType = (typeof REVISION_RESOURCE_TYPES)[number];

export const REVISION_TRIGGER_KINDS = ["save", "publish", "restore"] as const;
export type RevisionTriggerKind = (typeof REVISION_TRIGGER_KINDS)[number];

export interface ParsedRevisionId {
  readonly resourceType: RevisionResourceType;
  readonly resourceId: number;
  readonly revisionNumber: number;
  readonly canonicalId: string;
}

const REVISION_ID_PATTERN = /^(page|post|offering)[-:]([1-9]\d{0,9})[-:]([1-9]\d{0,9})$/;

export function formatRevisionId(
  resourceType: RevisionResourceType,
  resourceId: number,
  revisionNumber: number,
): string {
  return `${resourceType}-${resourceId}-${revisionNumber}`;
}

export function parseRevisionId(raw: string): ParsedRevisionId | null {
  const trimmed = raw.trim();
  const match = REVISION_ID_PATTERN.exec(trimmed);
  if (!match) return null;

  const resourceType = match[1] as RevisionResourceType;
  const resourceId = Number(match[2]);
  const revisionNumber = Number(match[3]);

  if (
    !Number.isSafeInteger(resourceId) ||
    resourceId < 1 ||
    resourceId > 2_147_483_647 ||
    !Number.isSafeInteger(revisionNumber) ||
    revisionNumber < 1 ||
    revisionNumber > 2_147_483_647
  ) {
    return null;
  }

  return {
    resourceType,
    resourceId,
    revisionNumber,
    canonicalId: formatRevisionId(resourceType, resourceId, revisionNumber),
  };
}

export function isRevisionResourceType(value: unknown): value is RevisionResourceType {
  return value === "page" || value === "post" || value === "offering";
}

export function isRevisionTriggerKind(value: unknown): value is RevisionTriggerKind {
  return value === "save" || value === "publish" || value === "restore";
}

export interface RevisionValidationField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class RevisionValidationError extends Error {
  readonly httpStatus = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly fields: readonly RevisionValidationField[];

  constructor(message: string, fields: readonly RevisionValidationField[] = []) {
    super(message);
    this.name = "RevisionValidationError";
    this.fields = fields;
  }
}

export class RevisionSchemaUnsupportedError extends Error {
  readonly httpStatus = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly schemaVersion: unknown;
  readonly fields: readonly RevisionValidationField[];

  constructor(message: string, schemaVersion: unknown, fields: readonly RevisionValidationField[] = []) {
    super(message);
    this.name = "RevisionSchemaUnsupportedError";
    this.schemaVersion = schemaVersion;
    this.fields =
      fields.length > 0
        ? fields
        : [
            {
              field: "schemaVersion",
              code: "UNSUPPORTED_REVISION_SCHEMA",
              message,
            },
          ];
  }
}

export class RevisionNotFoundError extends Error {
  readonly httpStatus = 404 as const;
  readonly code = "NOT_FOUND" as const;
  readonly resourceType?: RevisionResourceType;
  readonly resourceId?: number;
  readonly revisionNumber?: number;

  constructor(
    message = "Revisi konten tidak ditemukan.",
    meta?: {
      readonly resourceType?: RevisionResourceType;
      readonly resourceId?: number;
      readonly revisionNumber?: number;
    },
  ) {
    super(message);
    this.name = "RevisionNotFoundError";
    this.resourceType = meta?.resourceType;
    this.resourceId = meta?.resourceId;
    this.revisionNumber = meta?.revisionNumber;
  }
}

export class RevisionConflictError extends Error {
  readonly httpStatus = 409 as const;
  readonly code: "STALE_VERSION" | "CONFLICT";
  readonly expectedVersion?: number;
  readonly currentVersion?: number | null;
  readonly fields: readonly RevisionValidationField[];

  constructor(
    message: string,
    options: {
      readonly code?: "STALE_VERSION" | "CONFLICT";
      readonly expectedVersion?: number;
      readonly currentVersion?: number | null;
      readonly fields?: readonly RevisionValidationField[];
    } = {},
  ) {
    super(message);
    this.name = "RevisionConflictError";
    this.code = options.code ?? "CONFLICT";
    this.expectedVersion = options.expectedVersion;
    this.currentVersion = options.currentVersion;
    this.fields = options.fields ?? [];
  }
}

export interface RevisionReferenceWarning {
  readonly kind: "media" | "taxonomy" | "author";
  readonly id: number;
  readonly status: "missing" | "trashed" | "unavailable" | "detached";
  readonly field: string;
  readonly message: string;
}

export interface RevisionReferenceReport {
  readonly referencedMediaIds: readonly number[];
  readonly validMediaIds: readonly number[];
  readonly missingMediaIds: readonly number[];
  readonly trashedMediaIds: readonly number[];
  readonly unavailableMediaIds: readonly number[];
  readonly detachedMediaIds: readonly number[];
  readonly missingTaxonomyIds: readonly number[];
  readonly missingAuthorId: number | null;
  readonly warnings: readonly RevisionReferenceWarning[];
}

export interface ContentRevisionSummary {
  readonly id: string;
  readonly revisionId: string;
  readonly resourceType: RevisionResourceType;
  readonly resourceId: number;
  readonly revisionNumber: number;
  readonly schemaVersion: number;
  readonly triggerKind: RevisionTriggerKind;
  readonly actorUserId: string | null;
  readonly summary: string;
  readonly title: string | null;
  readonly slug: string | null;
  readonly createdAt: string;
}

export interface ContentRevisionDetail extends ContentRevisionSummary {
  readonly snapshot: Record<string, unknown>;
  readonly referenceReport: RevisionReferenceReport;
  readonly currentVersion: number;
  readonly resourceStatus: ResourceLifecycleStatus;
}

export interface ListContentRevisionsResult {
  readonly items: readonly ContentRevisionSummary[];
  readonly resourceType: RevisionResourceType;
  readonly resourceId: number;
  readonly currentVersion: number;
  readonly resourceStatus: ResourceLifecycleStatus;
  readonly maxRetained: typeof MAX_CONTENT_REVISIONS_PER_RESOURCE;
}

export interface RestoreContentRevisionInput {
  readonly resourceType: RevisionResourceType;
  readonly resourceId: number;
  readonly revisionNumber: number;
  readonly expectedVersion: number;
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
  /**
   * When `true` (default), deleted/missing media, taxonomy, or author references are safely
   * detached with explicit warnings returned to the editor so restore never fails on stale
   * foreign keys or links cross-tenant IDs. When `false`, missing references reject with 422.
   */
  readonly detachMissingReferences?: boolean;
  readonly nowMs?: number;
}

export interface RestoreContentRevisionResult {
  readonly restored: true;
  readonly revisionId: string;
  readonly resourceType: RevisionResourceType;
  readonly resourceId: number;
  readonly restoredFromRevisionNumber: number;
  readonly newRevisionNumber: number;
  readonly version: number;
  readonly status: ResourceLifecycleStatus;
  readonly draftOnly: true;
  readonly hasUnpublishedChanges: boolean;
  readonly referenceReport: RevisionReferenceReport;
  readonly warnings: readonly RevisionReferenceWarning[];
  readonly restoredAt: string;
  readonly resource: Record<string, unknown>;
}

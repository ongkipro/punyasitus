/**
 * Constants and queue topic identifiers for owner full-website export archives
 * and self-service website deletion with 7-day undo window (REQ-107, PLAN §20.4, TASK-107).
 */

export const EXPORT_LINK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DELETION_UNDO_WINDOW_DAYS = 7 as const;
export const DELETION_UNDO_WINDOW_MS = DELETION_UNDO_WINDOW_DAYS * 24 * 60 * 60 * 1000; // 7 days
export const DELETION_REAUTH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export const EXPORT_TIMEZONE = "Asia/Jakarta" as const;
export const JAKARTA_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

// lazy: 32 MiB in-memory ZIP ceiling for 128 MB Workers; upgrade to R2 multipart streaming for larger sites
export const MAX_EXPORT_ARCHIVE_BYTES = 32 * 1024 * 1024; // 32 MiB bounded total ZIP size
export const MAX_EXPORT_MEDIA_FILES = 500 as const;
export const MAX_EXPORT_SINGLE_MEDIA_BYTES = 16 * 1024 * 1024; // 16 MiB per single media file
export const MAX_EXPORT_ROWS_PER_COLLECTION = 10_000 as const;
export const STALE_EXPORT_PROCESSING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_DELETION_REASON_LENGTH = 500 as const;

export const EXPORT_ARCHIVE_FORMAT_VERSION = 1 as const;

export const TENANT_EXPORT_GENERATE_TOPIC = "exports.generate_archive" as const;
export const TENANT_EXPORT_CLEANUP_TOPIC = "exports.cleanup_expired" as const;
export const TENANT_SELF_DELETION_SWEEP_TOPIC = "exports.deletion_sweep" as const;

export const EXPORT_JOB_STATUSES = [
  "queued",
  "processing",
  "ready",
  "failed",
  "expired",
  "deleted",
] as const;
export type TenantExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

export const DELETION_REQUEST_STATUSES = [
  "scheduled",
  "canceled",
  "purging",
  "purged",
] as const;
export type TenantDeletionRequestStatus = (typeof DELETION_REQUEST_STATUSES)[number];

export const DELETION_CONFIRMATION_METHODS = [
  "totp",
  "backup_code",
  "password",
  "fresh_reauth",
] as const;
export type DeletionConfirmationMethod = (typeof DELETION_CONFIRMATION_METHODS)[number];

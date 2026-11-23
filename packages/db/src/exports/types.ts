import type {
  DeletionConfirmationMethod,
  ExportManifest,
  TenantDeletionRequestStatus,
  TenantExportJobStatus,
} from "@punyasitus/core/exports/index";
import type { TenantStatus } from "@punyasitus/core/schemas";
import type {
  ExecuteTenantOffboardingPurgeResult,
  OffboardingCloudflareClientLike,
  OffboardingR2BucketLike,
  OffboardingTenantStoreNamespaceLike,
} from "../offboarding/types.ts";

/**
 * Domain records, port interfaces, and typed errors for owner full-website export
 * archives and self-service website deletion with 7-day undo window (REQ-107, TASK-107).
 */

export interface ExportR2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly size?: number;
  readonly body?: ReadableStream | null;
}

export interface ExportR2BucketLike extends OffboardingR2BucketLike {
  get(key: string): Promise<ExportR2ObjectLike | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null | void>;
}

export interface TenantExportJobRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly requestedByUserId: string;
  readonly requestDay: string;
  readonly status: TenantExportJobStatus;
  readonly r2Key: string | null;
  readonly archiveBytes: number | null;
  readonly archiveSha256: string | null;
  readonly manifest: ExportManifest | null;
  readonly downloadTokenHash: string | null;
  readonly downloadExpiresAtMs: number | null;
  readonly downloadCount: number;
  readonly errorCode: string | null;
  readonly jobIdempotencyKey: string | null;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface TenantDeletionRequestRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly requestedByUserId: string;
  readonly status: TenantDeletionRequestStatus;
  readonly confirmationMethod: DeletionConfirmationMethod;
  readonly reason: string | null;
  readonly deletionRequestedAtMs: number;
  readonly deletionDueAtMs: number;
  readonly previousStatus: "trial" | "active" | "grace" | "locked" | "suspended";
  readonly previousDeletionDueAtMs: number | null;
  readonly previousCacheVersion: number;
  readonly canceledAtMs: number | null;
  readonly canceledByUserId: string | null;
  readonly cancelReason: string | null;
  readonly purgeClaimedAtMs: number | null;
  readonly purgedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface TenantDeletionStatusView {
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly operatorHoldReason: string | null;
  readonly activeRequest: TenantDeletionRequestRecord | null;
  readonly latestRequest: TenantDeletionRequestRecord | null;
  readonly canRequestDeletion: boolean;
  readonly canCancelDeletion: boolean;
  readonly remainingUndoMs: number;
}

export interface DueSelfServiceDeletionSweepResult {
  readonly evaluatedAtMs: number;
  readonly scannedRequests: number;
  readonly claimedCount: number;
  readonly purgedCount: number;
  readonly blockedCount: number;
  readonly failedCount: number;
  readonly outcomes: readonly {
    readonly requestId: string;
    readonly tenantId: string;
    readonly outcome: "purged" | "already_purged" | "blocked" | "failed";
    readonly blockReason: string | null;
    readonly errorCode: string | null;
    readonly purgeResult: ExecuteTenantOffboardingPurgeResult | null;
  }[];
}

export interface ExecuteDueSelfServiceDeletionsInput {
  readonly platformDb: D1Database;
  readonly mediaBucket?: OffboardingR2BucketLike | null;
  readonly tenantStoreNamespace?: OffboardingTenantStoreNamespaceLike | null;
  readonly cloudflareClient?: OffboardingCloudflareClientLike | null;
  readonly nowMs?: number;
  readonly tenantId?: string;
  readonly limit?: number;
  readonly requestId?: string | null;
}

export class ExportDailyLimitError extends Error {
  readonly status = 429 as const;
  readonly code = "RATE_LIMITED" as const;
  readonly requestDay: string;
  readonly retryAfterSeconds: number;

  constructor(requestDay: string, retryAfterSeconds: number) {
    super(
      `Batas ekspor harian tercapai (${requestDay}). Maksimal 1 ekspor arsip situs per hari.`,
    );
    this.name = "ExportDailyLimitError";
    this.requestDay = requestDay;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ExportNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "NOT_FOUND" as const;

  constructor(message = "Arsip ekspor situs tidak ditemukan.") {
    super(message);
    this.name = "ExportNotFoundError";
  }
}

export class ExportExpiredError extends Error {
  readonly status = 410 as const;
  readonly code = "EXPORT_EXPIRED" as const;

  constructor(message = "Tautan unduhan arsip ekspor telah kedaluwarsa setelah 24 jam.") {
    super(message);
    this.name = "ExportExpiredError";
  }
}

export class ExportConflictError extends Error {
  readonly status = 409 as const;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExportConflictError";
    this.code = code;
  }
}

export class DeletionConflictError extends Error {
  readonly status = 409 as const;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeletionConflictError";
    this.code = code;
  }
}

export class DeletionNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "NOT_FOUND" as const;

  constructor(message = "Tidak ada jadwal penghapusan situs yang aktif.") {
    super(message);
    this.name = "DeletionNotFoundError";
  }
}

export class DeletionWindowExpiredError extends Error {
  readonly status = 409 as const;
  readonly code = "DELETION_WINDOW_EXPIRED" as const;

  constructor(
    message = "Masa pembatalan 7 hari telah berakhir; proses penghapusan permanen tidak dapat dibatalkan.",
  ) {
    super(message);
    this.name = "DeletionWindowExpiredError";
  }
}

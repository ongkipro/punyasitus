import {
  computeScreeningContentHash,
  OWNER_HELD_FOR_REVIEW_NOTICE,
  type ScreeningCategory,
  type ScreeningFieldKind,
  type ScreeningFinding,
} from "@punyasitus/core/content-screening/index";
import type { PublishableResourceType } from "@punyasitus/core/content/index";
import type { EmailPort } from "@punyasitus/core/email/index";
import type { ModerationQueueSenderLike } from "../abuse/index.ts";
import { getTenantFormById, publishTenantForm } from "../forms/index.ts";
import {
  buildPlatformAuditStatement,
  PlatformAuditError,
  validateOperatorReason,
} from "../platform/audit.ts";
import {
  getPublishedResource,
  publishResourceAtomically,
  unpublishResourceAtomically,
} from "../publication/index.ts";
import { ContentScreeningError } from "./errors.ts";
import {
  loadScreenableResourceDraft,
  type PublishSource,
  type ScreenableResourceType,
} from "./publish-gate.ts";
import { takedownTenantSite } from "./takedown.ts";

/**
 * Operator Content Screening Review Queue Repository (`PLATFORM_DB.content_screening_reviews`;
 * REQ-103, PLAN §20.1, DEC-043, TASK-103).
 */

export const SCREENING_REVIEW_STATUSES = [
  "held_for_review",
  "released",
  "rejected",
  "takedown",
] as const;
export type ScreeningReviewStatus = (typeof SCREENING_REVIEW_STATUSES)[number];

export const SCREENING_REVIEW_DECISIONS = ["release", "reject", "takedown"] as const;
export type ScreeningReviewDecision = (typeof SCREENING_REVIEW_DECISIONS)[number];

export interface ScreeningReviewItemDto {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly tenantStatus: string;
  readonly tenantVersion: number;
  readonly resourceType: ScreenableResourceType;
  readonly resourceId: string;
  readonly resourceSlug: string | null;
  readonly resourceTitle: string;
  readonly publishSource: PublishSource;
  readonly expectedVersion: number;
  readonly status: ScreeningReviewStatus;
  readonly matchCount: number;
  readonly matchedCategories: readonly ScreeningCategory[];
  readonly matchedFields: readonly ScreeningFieldKind[];
  readonly findings: readonly ScreeningFinding[];
  readonly contentSha256: string;
  readonly rulesetVersion: number;
  readonly submittedByUserId: string | null;
  readonly reviewedByUserId: string | null;
  readonly reviewedAt: string | null;
  readonly resolutionReason: string | null;
  readonly auditId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScreeningReviewCountsDto {
  readonly all: number;
  readonly held_for_review: number;
  readonly released: number;
  readonly rejected: number;
  readonly takedown: number;
}

interface ScreeningReviewJoinRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly tenant_handle: string;
  readonly tenant_name: string;
  readonly tenant_status: string;
  readonly tenant_operator_hold: number;
  readonly tenant_version: number;
  readonly resource_type: ScreenableResourceType;
  readonly resource_id: string;
  readonly resource_slug: string | null;
  readonly resource_title: string;
  readonly publish_source: PublishSource;
  readonly expected_version: number;
  readonly status: ScreeningReviewStatus;
  readonly match_count: number;
  readonly matched_categories_json: string;
  readonly matched_fields_json: string;
  readonly findings_json: string;
  readonly content_sha256: string;
  readonly held_snapshot_json: string | null;
  readonly ruleset_version: number;
  readonly submitted_by_user_id: string | null;
  readonly reviewed_by_user_id: string | null;
  readonly reviewed_at: number | null;
  readonly resolution_reason: string | null;
  readonly audit_id: string | null;
  readonly idempotency_key: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

function safeParseJsonArray<T>(raw: string): readonly T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function mapReviewRow(row: ScreeningReviewJoinRow): ScreeningReviewItemDto {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantHandle: row.tenant_handle,
    tenantName: row.tenant_name,
    tenantStatus: row.tenant_status,
    tenantVersion: Number(row.tenant_version),
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    resourceSlug: row.resource_slug,
    resourceTitle: row.resource_title,
    publishSource: row.publish_source,
    expectedVersion: Number(row.expected_version),
    status: row.status,
    matchCount: Number(row.match_count),
    matchedCategories: safeParseJsonArray<ScreeningCategory>(row.matched_categories_json),
    matchedFields: safeParseJsonArray<ScreeningFieldKind>(row.matched_fields_json),
    findings: safeParseJsonArray<ScreeningFinding>(row.findings_json),
    contentSha256: row.content_sha256,
    rulesetVersion: Number(row.ruleset_version),
    submittedByUserId: row.submitted_by_user_id,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at !== null ? new Date(row.reviewed_at).toISOString() : null,
    resolutionReason: row.resolution_reason,
    auditId: row.audit_id,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const REVIEW_SELECT_SQL = `
  SELECT r.id, r.tenant_id,
         t.handle AS tenant_handle, t.name AS tenant_name,
         t.status AS tenant_status, t.operator_hold AS tenant_operator_hold,
         t.version AS tenant_version,
         r.resource_type, r.resource_id, r.resource_slug, r.resource_title,
         r.publish_source, r.expected_version, r.status, r.match_count,
         r.matched_categories_json, r.matched_fields_json, r.findings_json,
         r.content_sha256, r.held_snapshot_json, r.ruleset_version, r.submitted_by_user_id,
         r.reviewed_by_user_id, r.reviewed_at, r.resolution_reason,
         r.audit_id, r.idempotency_key, r.version, r.created_at, r.updated_at
  FROM content_screening_reviews r
  INNER JOIN tenants t ON t.id = r.tenant_id
`;

const REVIEW_STATUS_SET: ReadonlySet<string> = new Set(SCREENING_REVIEW_STATUSES);

export interface ListScreeningReviewsFilter {
  readonly status?: ScreeningReviewStatus | "all";
  readonly publishSource?: PublishSource | "all";
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListScreeningReviewsResult {
  readonly items: readonly ScreeningReviewItemDto[];
  readonly counts: ScreeningReviewCountsDto;
  readonly page: {
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

export async function listScreeningReviews(
  platformDb: D1Database,
  filter: ListScreeningReviewsFilter = {},
): Promise<ListScreeningReviewsResult> {
  const status = filter.status ?? "all";
  if (status !== "all" && !REVIEW_STATUS_SET.has(status)) {
    throw new ContentScreeningError(422, "VALIDATION_ERROR", "Filter status tinjauan tidak valid.");
  }

  const limit = Math.min(100, Math.max(1, Math.trunc(filter.limit ?? 20)));
  const where: string[] = [];
  const binds: unknown[] = [];

  if (status !== "all") {
    where.push("r.status = ?");
    binds.push(status);
  }
  if (filter.publishSource && filter.publishSource !== "all") {
    where.push("r.publish_source = ?");
    binds.push(filter.publishSource);
  }
  const cleanSearch = filter.search?.trim().toLowerCase() ?? "";
  if (cleanSearch) {
    const pattern = `%${cleanSearch}%`;
    where.push("(lower(t.handle) LIKE ? OR lower(t.name) LIKE ? OR lower(r.resource_title) LIKE ?)");
    binds.push(pattern, pattern, pattern);
  }
  if (filter.cursor) {
    const parts = filter.cursor.split(":");
    const ts = Number(parts[0]);
    const id = parts[1] ?? "";
    if (Number.isSafeInteger(ts) && id) {
      where.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
      binds.push(ts, ts, id);
    }
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const [listRes, countRes] = await Promise.all([
    platformDb
      .prepare(`${REVIEW_SELECT_SQL} ${whereClause} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
      .bind(...binds, limit + 1)
      .all<ScreeningReviewJoinRow>(),
    platformDb
      .prepare(`SELECT status, COUNT(*) AS cnt FROM content_screening_reviews GROUP BY status`)
      .all<{ readonly status: ScreeningReviewStatus; readonly cnt: number }>(),
  ]);

  const rawRows = listRes.results ?? [];
  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
  const items = pageRows.map(mapReviewRow);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && lastRow ? `${lastRow.created_at}:${lastRow.id}` : null;

  const counts = {
    all: 0,
    held_for_review: 0,
    released: 0,
    rejected: 0,
    takedown: 0,
  };
  for (const row of countRes.results ?? []) {
    const c = Number(row.cnt ?? 0);
    counts.all += c;
    if (row.status in counts) {
      counts[row.status] = c;
    }
  }

  return {
    items,
    counts,
    page: { limit, hasMore, nextCursor },
  };
}

export async function getScreeningReviewById(
  platformDb: D1Database,
  reviewId: string,
): Promise<ScreeningReviewItemDto | null> {
  const cleanId = reviewId.trim();
  if (!cleanId) return null;
  const row = await platformDb
    .prepare(`${REVIEW_SELECT_SQL} WHERE r.id = ? LIMIT 1`)
    .bind(cleanId)
    .first<ScreeningReviewJoinRow>();
  return row ? mapReviewRow(row) : null;
}

export interface DecideScreeningReviewInput {
  readonly reviewId: string;
  readonly decision: ScreeningReviewDecision;
  readonly reason: unknown;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly idempotencyKey?: string | null;
  readonly requestId?: string | null;
  readonly tenantDb?: D1Database | null;
  readonly jobsQueue?: ModerationQueueSenderLike | null;
  readonly emailPort?: EmailPort | null;
  readonly appOrigin?: string;
  readonly nowMs?: number;
}

export interface DecideScreeningReviewResult {
  readonly review: ScreeningReviewItemDto;
  readonly decision: ScreeningReviewDecision;
  readonly auditId: string;
  readonly publishedVersion: number | null;
  readonly cacheVersion: number | null;
  readonly tenantSuspended: boolean;
  readonly replayed: boolean;
}

const DECISION_SET: ReadonlySet<string> = new Set(SCREENING_REVIEW_DECISIONS);

/**
 * Executes an audited operator decision on a held content review (`release`, `reject`, or `takedown`).
 * - `release`: verifies draft snapshot integrity & publishes the held resource in `TenantStore`,
 *   then atomically updates `content_screening_reviews` + `platform_audit` (`WHERE changes() = 1`).
 *   Compensates/unpublishes `TenantStore` if the `PLATFORM_DB` transaction fails.
 * - `reject`: keeps resource as draft and marks review `rejected` with `platform_audit`.
 * - `takedown`: immediately suspends the tenant site (`Turunkan situs`) using the existing
 *   `suspended` state + `operator_hold = 1` + `cache_version + 1` + `platform_audit`.
 */
export async function decideScreeningReview(
  platformDb: D1Database,
  input: DecideScreeningReviewInput,
): Promise<DecideScreeningReviewResult> {
  const reviewId = input.reviewId.trim();
  if (!reviewId) {
    throw new ContentScreeningError(404, "NOT_FOUND", "Antrean tinjauan tidak ditemukan.");
  }
  if (!DECISION_SET.has(input.decision)) {
    throw new ContentScreeningError(422, "VALIDATION_ERROR", "Keputusan harus release, reject, atau takedown.", [
      { field: "decision", code: "INVALID_DECISION", message: "Expected release, reject, or takedown." },
    ]);
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new ContentScreeningError(422, "VALIDATION_ERROR", "expectedVersion wajib bilangan bulat positif.", [
      { field: "expectedVersion", code: "INVALID_VERSION", message: "Expected positive integer." },
    ]);
  }

  let cleanReason: string;
  try {
    cleanReason = validateOperatorReason(input.reason);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new ContentScreeningError(422, "VALIDATION_ERROR", err.message, [
        { field: "reason", code: "INVALID_REASON", message: err.message },
      ]);
    }
    throw err;
  }

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const rawIdemp = input.idempotencyKey?.trim() || null;

  const existingRow = await platformDb
    .prepare(`${REVIEW_SELECT_SQL} WHERE r.id = ? LIMIT 1`)
    .bind(reviewId)
    .first<ScreeningReviewJoinRow>();

  if (!existingRow) {
    throw new ContentScreeningError(404, "NOT_FOUND", "Item tinjauan konten tidak ditemukan.");
  }

  // Idempotency replay/conflict check
  if (rawIdemp && existingRow.idempotency_key === rawIdemp) {
    const expectedStatus: ScreeningReviewStatus =
      input.decision === "release"
        ? "released"
        : input.decision === "reject"
          ? "rejected"
          : "takedown";
    if (existingRow.status !== expectedStatus) {
      throw new ContentScreeningError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key sudah digunakan untuk keputusan tinjauan yang berbeda.",
      );
    }
    return {
      review: mapReviewRow(existingRow),
      decision: input.decision,
      auditId: existingRow.audit_id ?? "",
      publishedVersion: null,
      cacheVersion: null,
      tenantSuspended: existingRow.status === "takedown",
      replayed: true,
    };
  }

  // Cross-review idempotency key conflict check BEFORE touching TenantStore
  if (rawIdemp && existingRow.idempotency_key !== rawIdemp) {
    const conflictingReview = await platformDb
      .prepare(
        `SELECT id
         FROM content_screening_reviews
         WHERE tenant_id = ? AND idempotency_key = ? AND id != ?
         LIMIT 1`,
      )
      .bind(existingRow.tenant_id, rawIdemp, reviewId)
      .first<{ readonly id: string }>();
    if (conflictingReview) {
      throw new ContentScreeningError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key sudah digunakan pada item tinjauan lain untuk situs ini.",
      );
    }
  }

  if (existingRow.status !== "held_for_review") {
    throw new ContentScreeningError(
      409,
      "ALREADY_REVIEWED",
      `Item tinjauan sudah diproses dengan status "${existingRow.status}".`,
    );
  }

  if (Number(existingRow.version) !== input.expectedVersion) {
    throw new ContentScreeningError(
      409,
      "STALE_VERSION",
      "Versi item tinjauan sudah berubah. Muat ulang antrean sebelum memproses.",
    );
  }

  // Branch A: Takedown ("Turunkan situs") -> delegates to atomic suspended takedown
  if (input.decision === "takedown") {
    const takedownRes = await takedownTenantSite(platformDb, {
      tenantId: existingRow.tenant_id,
      reviewId: existingRow.id,
      reviewExpectedVersion: input.expectedVersion,
      expectedTenantVersion: Number(existingRow.tenant_version),
      reason: cleanReason,
      actorUserId: input.actorUserId,
      idempotencyKey: rawIdemp,
      requestId: input.requestId ?? null,
      tenantDb: input.tenantDb ?? null,
      jobsQueue: input.jobsQueue ?? null,
      emailPort: input.emailPort ?? null,
      appOrigin: input.appOrigin,
      nowMs,
    });

    const refreshed = await getScreeningReviewById(platformDb, reviewId);
    if (!refreshed) {
      throw new ContentScreeningError(500, "SERVICE_UNAVAILABLE", "Gagal membaca status tinjauan.");
    }
    return {
      review: refreshed,
      decision: "takedown",
      auditId: takedownRes.auditId,
      publishedVersion: null,
      cacheVersion: takedownRes.cacheVersion,
      tenantSuspended: true,
      replayed: takedownRes.replayed,
    };
  }

  // Branch B: Release false positive -> verify tenant lifecycle & publish in TenantStore FIRST,
  // preserving prior published state for non-destructive compensation if PLATFORM_DB commit fails!
  let publishedVersion: number | null = null;
  let cacheVersion: number | null = null;
  let publishedInTenantStore = false;
  let numericResourceId: number | null = null;
  let priorPublishedData: unknown = null;
  let formWasPreviouslyPublished = false;

  const NON_RELEASABLE_TENANT_STATUSES = new Set(["purging", "purged", "suspended", "recovery"]);

  const compensateTenantStoreRelease = async () => {
    if (!publishedInTenantStore || !input.tenantDb || publishedVersion === null) return;
    try {
      if (existingRow.resource_type === "form" && numericResourceId !== null) {
        if (!formWasPreviouslyPublished) {
          await publishTenantForm(input.tenantDb, {
            formId: numericResourceId,
            expectedVersion: publishedVersion,
            action: "unpublish",
            actorUserId: null,
            nowMs,
          });
        }
      } else {
        const resType = existingRow.resource_type as PublishableResourceType;
        const resId =
          resType === "theme_config" ? existingRow.resource_id : Number(existingRow.resource_id);
        if (priorPublishedData !== null) {
          // Restore prior published snapshot instead of taking live content offline!
          await publishResourceAtomically(platformDb, input.tenantDb, {
            tenantId: existingRow.tenant_id,
            resourceType: resType,
            resourceId: resId as never,
            expectedVersion: publishedVersion,
            draftOverride: priorPublishedData,
            actorUserId: null,
            nowMs,
          });
        } else {
          await unpublishResourceAtomically(platformDb, input.tenantDb, {
            tenantId: existingRow.tenant_id,
            resourceType: resType,
            resourceId: resId as never,
            expectedVersion: publishedVersion,
            nowMs,
          });
        }
      }
    } catch {
      // Best-effort compensation
    }
  };

  if (input.decision === "release") {
    // Lifecycle guard: NEVER release/publish content onto suspended, held, purging, purged, or recovery tenants!
    if (
      NON_RELEASABLE_TENANT_STATUSES.has(existingRow.tenant_status) ||
      Number(existingRow.tenant_operator_hold) === 1
    ) {
      throw new ContentScreeningError(
        409,
        "TENANT_NOT_ELIGIBLE",
        `Situs dengan status "${existingRow.tenant_status}" atau dalam penangguhan operator tidak dapat merilis publikasi.`,
      );
    }

    const tenantDb = input.tenantDb;
    if (!tenantDb) {
      throw new ContentScreeningError(
        503,
        "TENANT_STORE_UNAVAILABLE",
        "Penyimpanan data tenant (TenantStore) tidak tersedia untuk merilis dan mempublikasikan konten.",
      );
    }

    if (existingRow.resource_type === "form") {
      const formId = Number(existingRow.resource_id);
      if (!Number.isSafeInteger(formId) || formId < 1) {
        throw new ContentScreeningError(422, "VALIDATION_ERROR", "ID formulir tidak valid.");
      }
      numericResourceId = formId;
      const { form } = await getTenantFormById(tenantDb, formId);
      formWasPreviouslyPublished = form.isPublished;
      const currentHash = await computeScreeningContentHash(form);
      if (currentHash !== existingRow.content_sha256) {
        throw new ContentScreeningError(
          409,
          "SNAPSHOT_MISMATCH",
          "Draf formulir telah diubah sejak ditahan. Minta pemilik mengirim ulang publikasi untuk penyaringan baru.",
        );
      }
      const pubForm = await publishTenantForm(tenantDb, {
        formId,
        expectedVersion: form.version,
        action: "publish",
        actorUserId: null,
        nowMs,
      });
      publishedVersion = pubForm.form.version;
      publishedInTenantStore = true;
    } else {
      const resType = existingRow.resource_type as PublishableResourceType;
      const resId =
        resType === "theme_config" ? existingRow.resource_id : Number(existingRow.resource_id);
      if (resType !== "theme_config") {
        if (!Number.isSafeInteger(resId) || (resId as number) < 1) {
          throw new ContentScreeningError(422, "VALIDATION_ERROR", "ID resource tidak valid.");
        }
        numericResourceId = resId as number;
      }

      // Capture any existing published snapshot for non-destructive compensation on D1 failure
      try {
        const existingPublished = await getPublishedResource(tenantDb, {
          resourceType: resType,
          resourceId: resId as never,
        });
        priorPublishedData = existingPublished?.data ?? null;
      } catch {
        priorPublishedData = null;
      }

      const loadedDraft = await loadScreenableResourceDraft(
        tenantDb,
        resType,
        resId as never,
      );

      let draftOverrideToPublish: unknown = undefined;
      if (existingRow.held_snapshot_json !== null) {
        // draftOverride hold: verify version hasn't moved AND persisted held snapshot matches content_sha256
        if (loadedDraft.version !== Number(existingRow.expected_version)) {
          throw new ContentScreeningError(
            409,
            "SNAPSHOT_MISMATCH",
            "Draf konten telah diubah sejak ditahan. Minta pemilik mengirim ulang publikasi untuk penyaringan baru.",
          );
        }
        try {
          draftOverrideToPublish = JSON.parse(existingRow.held_snapshot_json);
        } catch {
          throw new ContentScreeningError(
            409,
            "SNAPSHOT_MISMATCH",
            "Snapshot draf yang ditahan tidak valid dan tidak dapat dirilis.",
          );
        }
        const heldHash = await computeScreeningContentHash(draftOverrideToPublish);
        if (heldHash !== existingRow.content_sha256) {
          throw new ContentScreeningError(
            409,
            "SNAPSHOT_MISMATCH",
            "Integritas snapshot yang ditahan tidak cocok.",
          );
        }
      } else {
        const currentHash = await computeScreeningContentHash(loadedDraft.snapshot);
        if (currentHash !== existingRow.content_sha256) {
          throw new ContentScreeningError(
            409,
            "SNAPSHOT_MISMATCH",
            "Draf konten telah diubah sejak ditahan. Minta pemilik mengirim ulang publikasi untuk penyaringan baru.",
          );
        }
      }

      const pubRes = await publishResourceAtomically(platformDb, tenantDb, {
        tenantId: existingRow.tenant_id,
        resourceType: resType,
        resourceId: resId as never,
        expectedVersion: loadedDraft.version,
        draftOverride: draftOverrideToPublish,
        actorUserId: null,
        nowMs,
      });
      publishedVersion = pubRes.version;
      cacheVersion = pubRes.cacheVersion;
      publishedInTenantStore = true;
    }
  }

  const nextStatus: ScreeningReviewStatus = input.decision === "release" ? "released" : "rejected";
  const auditAction =
    input.decision === "release"
      ? "console.content_screening.release"
      : "console.content_screening.reject";

  const { statement: auditStmt, entry: auditRecord } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "platform_operator",
      action: auditAction,
      targetType: "content_screening_review",
      targetId: reviewId,
      tenantId: existingRow.tenant_id,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        decision: input.decision,
        resourceType: existingRow.resource_type,
        resourceId: existingRow.resource_id,
        publishSource: existingRow.publish_source,
        publishedVersion,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const updateReviewStmt = platformDb
    .prepare(
      `UPDATE content_screening_reviews
       SET status = ?,
           reviewed_by_user_id = ?,
           reviewed_at = ?,
           resolution_reason = ?,
           audit_id = ?,
           idempotency_key = COALESCE(idempotency_key, ?),
           version = version + 1,
           updated_at = ?
       WHERE id = ? AND version = ? AND status = 'held_for_review'`,
    )
    .bind(
      nextStatus,
      input.actorUserId,
      nowMs,
      cleanReason,
      auditRecord.id,
      rawIdemp,
      nowMs,
      reviewId,
      input.expectedVersion,
    );

  let batchRes: D1Result[];
  try {
    batchRes = await platformDb.batch([updateReviewStmt, auditStmt]);
  } catch (err) {
    await compensateTenantStoreRelease();
    const msg = err instanceof Error ? err.message : String(err);
    if (rawIdemp && msg.toLowerCase().includes("unique")) {
      throw new ContentScreeningError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key sudah digunakan pada item tinjauan lain untuk situs ini.",
      );
    }
    throw err;
  }

  const reviewUpdated = Number(batchRes[0]?.meta?.changes ?? 0);
  const auditInserted = Number(batchRes[1]?.meta?.changes ?? 0);

  if (reviewUpdated !== 1) {
    await compensateTenantStoreRelease();
    throw new ContentScreeningError(
      409,
      "STALE_VERSION",
      "Status item tinjauan berubah secara bersamaan. Muat ulang antrean.",
    );
  }

  if (auditInserted !== 1) {
    throw new ContentScreeningError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menyimpan catatan audit tinjauan konten.",
    );
  }

  // Update tenant-side hold marker & append operator activity entry (actor_user_id = NULL)
  if (input.tenantDb) {
    try {
      await input.tenantDb
        .prepare(
          `UPDATE content_screening_holds
           SET status = ?, resolved_at = ?, updated_at = ?
           WHERE resource_type = ? AND resource_id = ?`,
        )
        .bind(nextStatus, nowMs, nowMs, existingRow.resource_type, existingRow.resource_id)
        .run();
    } catch {
      // Ignore if table not migrated
    }
    try {
      await input.tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           ) VALUES (NULL, 'platform_operator', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.decision === "release"
            ? "content.screening_released"
            : "content.screening_rejected",
          existingRow.resource_type,
          existingRow.resource_id,
          input.decision === "release"
            ? "Konten dirilis dan dipublikasikan setelah tinjauan keamanan platform"
            : "Konten tetap ditahan sebagai draf setelah tinjauan keamanan platform",
          JSON.stringify({ reviewId }),
          nowMs,
        )
        .run();
    } catch {
      // Non-blocking activity log mirror
    }
  }

  const refreshed = await getScreeningReviewById(platformDb, reviewId);
  if (!refreshed) {
    throw new ContentScreeningError(500, "SERVICE_UNAVAILABLE", "Gagal membaca hasil tinjauan.");
  }

  return {
    review: refreshed,
    decision: input.decision,
    auditId: auditRecord.id,
    publishedVersion,
    cacheVersion,
    tenantSuspended: false,
    replayed: false,
  };
}

export interface TenantHeldNoticeDto {
  readonly resourceType: ScreenableResourceType;
  readonly resourceId: string;
  readonly reviewId: string;
  readonly status: "held_for_review";
  readonly message: typeof OWNER_HELD_FOR_REVIEW_NOTICE;
  readonly heldAt: string;
}

/**
 * Lists currently held items for a tenant owner using ONLY generic owner-safe notices
 * (never exposes matched keywords, denylisted domains, or operator notes).
 */
export async function listTenantOwnerHeldNotices(
  tenantDb: D1Database,
): Promise<readonly TenantHeldNoticeDto[]> {
  try {
    const res = await tenantDb
      .prepare(
        `SELECT resource_type, resource_id, review_id, held_at
         FROM content_screening_holds
         WHERE status = 'held_for_review'
         ORDER BY held_at DESC
         LIMIT 50`,
      )
      .all<{
        readonly resource_type: ScreenableResourceType;
        readonly resource_id: string;
        readonly review_id: string;
        readonly held_at: number;
      }>();

    return (res.results ?? []).map((row) => ({
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      reviewId: row.review_id,
      status: "held_for_review",
      message: OWNER_HELD_FOR_REVIEW_NOTICE,
      heldAt: new Date(row.held_at).toISOString(),
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such table")) return [];
    throw err;
  }
}

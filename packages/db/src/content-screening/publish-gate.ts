import {
  buildOwnerSafeHeldPublishNotice,
  computeScreeningContentHash,
  HELD_FOR_REVIEW_REASON_CODE,
  OWNER_HELD_FOR_REVIEW_NOTICE,
  screenPublishContent,
  type ContentScreeningResult,
  type OwnerSafeHeldPublishNotice,
  type PublishScreeningInputPayload,
  type ScreeningFinding,
} from "@punyasitus/core/content-screening/index";
import type { PublishableResourceType } from "@punyasitus/core/content/index";
import { getTenantFormById, publishTenantForm } from "../forms/index.ts";
import { generatePlatformAuditId } from "../platform/audit.ts";
import {
  getDraftResourceForAdmin,
  publishResourceAtomically,
  type PublishResourceAtomicallyResult,
} from "../publication/index.ts";
import { ContentScreeningError } from "./errors.ts";
import { loadActiveScreeningRuleset } from "./rules.ts";

/**
 * Canonical Publish-Time Content Screening Gate (REQ-103, PLAN §20.1, DEC-043, TASK-103).
 *
 * Security invariants:
 * - Every publish path (dashboard AND MCP) calls this single screening gate.
 * - Any match, truncation, or media ALT scan failure NEVER publishes: the resource remains
 *   `draft` in `TenantStore`, a deduplicated review queue row is created in
 *   `PLATFORM_DB.content_screening_reviews` (`held_for_review`), and the caller receives ONLY
 *   the generic Indonesian owner notice ("Konten ditahan untuk ditinjau") with ZERO disclosure
 *   of the matched keyword, denylisted domain, or operator findings.
 * - Enforces a per-tenant open review cap (`MAX_OPEN_REVIEWS_PER_TENANT = 50`) so a hostile
 *   tenant cannot flood the console queue.
 */

export const PUBLISH_SOURCES = ["dashboard", "mcp", "api"] as const;
export type PublishSource = (typeof PUBLISH_SOURCES)[number];

export type ScreenableResourceType = PublishableResourceType | "form";

export const MAX_OPEN_REVIEWS_PER_TENANT = 50 as const;
const MEDIA_ALT_CHUNK_SIZE = 50;
const MAX_MEDIA_ITEMS_TO_SCAN = 500;

export interface PublishGateResourceParams<K extends PublishableResourceType> {
  readonly tenantId: string;
  readonly resourceType: K;
  readonly resourceId: K extends "theme_config" ? string : number;
  readonly expectedVersion: number;
  readonly publishSource: PublishSource;
  readonly actorUserId?: string | null;
  readonly draftOverride?: unknown;
  /** Additional media IDs whose ALT texts in `TenantStore.media_items` should also be screened. */
  readonly extraMediaIds?: readonly number[];
  /** Additional explicit hidden/image ALT texts or form labels to screen alongside the draft. */
  readonly extraImageAlts?: readonly string[];
  readonly extraFormLabels?: readonly string[];
  readonly nowMs?: number;
}

export type PublishGateResourceOutcome<K extends PublishableResourceType> =
  | {
      readonly outcome: "published";
      readonly held: false;
      readonly screening: {
        readonly verdict: "allow";
        readonly rulesetVersion: number;
        readonly scannedFieldsCount: number;
        readonly scannedLinksCount: number;
      };
      readonly published: PublishResourceAtomicallyResult<K>;
    }
  | {
      readonly outcome: "held_for_review";
      readonly held: true;
      readonly ownerNotice: OwnerSafeHeldPublishNotice;
      readonly reviewId: string;
      readonly deduplicated: boolean;
    };

export interface PublishGateFormParams {
  readonly tenantId: string;
  readonly formId: number;
  readonly expectedVersion: number;
  readonly publishSource: PublishSource;
  readonly actorUserId?: string | null;
  readonly nowMs?: number;
}

export type PublishGateFormOutcome =
  | {
      readonly outcome: "published";
      readonly held: false;
      readonly screening: {
        readonly verdict: "allow";
        readonly rulesetVersion: number;
        readonly scannedFieldsCount: number;
        readonly scannedLinksCount: number;
      };
      readonly published: Awaited<ReturnType<typeof publishTenantForm>>;
    }
  | {
      readonly outcome: "held_for_review";
      readonly held: true;
      readonly ownerNotice: OwnerSafeHeldPublishNotice;
      readonly reviewId: string;
      readonly deduplicated: boolean;
    };

function collectReferencedMediaIds(value: unknown, out: Set<number>, depth = 0): void {
  if (depth > 10 || value === null || value === undefined || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferencedMediaIds(item, out, depth + 1);
    }
    return;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      (lower.endsWith("mediaid") || lower.endsWith("media_id")) &&
      typeof v === "number" &&
      Number.isInteger(v) &&
      v > 0
    ) {
      out.add(v);
    } else if (
      (lower.endsWith("mediaids") || lower.endsWith("media_ids")) &&
      Array.isArray(v)
    ) {
      for (const id of v) {
        if (typeof id === "number" && Number.isInteger(id) && id > 0) {
          out.add(id);
        }
      }
    } else if (lower === "media" && Array.isArray(v)) {
      for (const asset of v) {
        if (asset && typeof asset === "object" && "id" in asset) {
          const id = (asset as { readonly id?: unknown }).id;
          if (typeof id === "number" && Number.isInteger(id) && id > 0) {
            out.add(id);
          }
        }
      }
      collectReferencedMediaIds(v, out, depth + 1);
    } else if (typeof v === "object" && v !== null) {
      collectReferencedMediaIds(v, out, depth + 1);
    }
  }
}

type FetchMediaAltTextsResult =
  | { readonly ok: true; readonly alts: readonly string[] }
  | {
      readonly ok: false;
      readonly alts: readonly string[];
      readonly failureRuleId: "MEDIA_ALT_SCAN_FAILED" | "MEDIA_ALT_SCAN_TRUNCATED";
      readonly excerpt: string;
    };

/**
 * Fetches media ALT texts in bounded chunks (`50` per SQL `IN` clause, up to `500` items).
 * Fails CLOSED on DB errors (`MEDIA_ALT_SCAN_FAILED`) or excessive referenced media counts
 * (`MEDIA_ALT_SCAN_TRUNCATED`) so attackers cannot bypass ALT screening by attaching >50 items
 * or inducing DB read errors.
 */
async function fetchMediaAltTextsFailClosed(
  tenantDb: D1Database,
  mediaIds: readonly number[],
): Promise<FetchMediaAltTextsResult> {
  const uniqueIds = Array.from(new Set(mediaIds.filter((n) => Number.isInteger(n) && n > 0)));
  if (uniqueIds.length === 0) return { ok: true, alts: [] };

  const truncated = uniqueIds.length > MAX_MEDIA_ITEMS_TO_SCAN;
  const idsToScan = truncated ? uniqueIds.slice(0, MAX_MEDIA_ITEMS_TO_SCAN) : uniqueIds;
  const alts: string[] = [];

  for (let i = 0; i < idsToScan.length; i += MEDIA_ALT_CHUNK_SIZE) {
    const chunk = idsToScan.slice(i, i + MEDIA_ALT_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    try {
      const res = await tenantDb
        .prepare(
          `SELECT alt_text FROM media_items WHERE id IN (${placeholders}) AND status != 'quarantined'`,
        )
        .bind(...chunk)
        .all<{ readonly alt_text: string | null }>();
      for (const row of res.results ?? []) {
        if (typeof row.alt_text === "string" && row.alt_text.trim()) {
          alts.push(row.alt_text.trim());
        }
      }
    } catch {
      return {
        ok: false,
        alts,
        failureRuleId: "MEDIA_ALT_SCAN_FAILED",
        excerpt: "Gagal membaca ALT teks media dari TenantStore; konten ditahan untuk tinjauan.",
      };
    }
  }

  if (truncated) {
    return {
      ok: false,
      alts,
      failureRuleId: "MEDIA_ALT_SCAN_TRUNCATED",
      excerpt: `Jumlah referensi media (${uniqueIds.length}) melebihi batas pemindaian otomatis.`,
    };
  }

  return { ok: true, alts };
}

async function recordTenantHoldAndActivityBestEffort(
  tenantDb: D1Database,
  params: {
    readonly resourceType: ScreenableResourceType;
    readonly resourceId: string;
    readonly reviewId: string;
    readonly actorUserId: string | null;
    readonly nowMs: number;
  },
): Promise<void> {
  try {
    await tenantDb
      .prepare(
        `INSERT INTO content_screening_holds (
           resource_type, resource_id, review_id, status, owner_notice, held_at, resolved_at, updated_at
         ) VALUES (?, ?, ?, 'held_for_review', ?, ?, NULL, ?)
         ON CONFLICT(resource_type, resource_id) DO UPDATE SET
           review_id = excluded.review_id,
           status = 'held_for_review',
           owner_notice = excluded.owner_notice,
           held_at = excluded.held_at,
           resolved_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(
        params.resourceType,
        params.resourceId,
        params.reviewId,
        OWNER_HELD_FOR_REVIEW_NOTICE,
        params.nowMs,
        params.nowMs,
      )
      .run();
  } catch {
    // Migration 0019 may not yet be applied on older tenant fixtures; PLATFORM_DB queue is canonical.
  }

  try {
    await tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         ) VALUES (?, 'system', 'content.held_for_review', ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.actorUserId,
        params.resourceType,
        params.resourceId,
        OWNER_HELD_FOR_REVIEW_NOTICE,
        JSON.stringify({
          reviewId: params.reviewId,
          reason: HELD_FOR_REVIEW_REASON_CODE,
        }),
        params.nowMs,
      )
      .run();
  } catch {
    // Non-blocking audit mirror; PLATFORM_DB review row is authoritative.
  }
}

async function clearTenantHoldBestEffort(
  tenantDb: D1Database,
  resourceType: ScreenableResourceType,
  resourceId: string,
  nowMs: number,
): Promise<void> {
  try {
    await tenantDb
      .prepare(
        `UPDATE content_screening_holds
         SET status = 'released', resolved_at = ?, updated_at = ?
         WHERE resource_type = ? AND resource_id = ? AND status = 'held_for_review'`,
      )
      .bind(nowMs, nowMs, resourceType, resourceId)
      .run();
  } catch {
    // Ignore if table not migrated on tenant DB.
  }
}

function extractTitleAndSlug(
  resourceType: ScreenableResourceType,
  draftPayload: unknown,
  fallbackId: string,
): { readonly title: string; readonly slug: string | null } {
  if (draftPayload && typeof draftPayload === "object") {
    const rec = draftPayload as Record<string, unknown>;
    const rawTitle =
      (typeof rec.title === "string" && rec.title.trim()) ||
      (typeof rec.businessName === "string" && rec.businessName.trim()) ||
      (typeof rec.siteTitle === "string" && rec.siteTitle.trim()) ||
      (typeof rec.name === "string" && rec.name.trim()) ||
      `${resourceType} #${fallbackId}`;
    const rawSlug = typeof rec.slug === "string" && rec.slug.trim() ? rec.slug.trim() : null;
    return { title: rawTitle.slice(0, 200), slug: rawSlug ? rawSlug.slice(0, 120) : null };
  }
  return { title: `${resourceType} #${fallbackId}`, slug: null };
}

/**
 * Deduplicates open held reviews by `(tenant_id, resource_type, resource_id, content_sha256)`
 * and enforces the per-tenant open review cap (`MAX_OPEN_REVIEWS_PER_TENANT`).
 */
async function persistHeldReviewRow(
  platformDb: D1Database,
  params: {
    readonly tenantId: string;
    readonly resourceType: ScreenableResourceType;
    readonly resourceId: string;
    readonly resourceSlug: string | null;
    readonly resourceTitle: string;
    readonly publishSource: PublishSource;
    readonly expectedVersion: number;
    readonly screening: ContentScreeningResult;
    readonly contentSha256: string;
    readonly heldSnapshotJson: string | null;
    readonly actorUserId: string | null;
    readonly nowMs: number;
  },
): Promise<{ readonly reviewId: string; readonly deduplicated: boolean }> {
  // 1. Deduplicate identical open held review for the same resource & snapshot hash
  const existingOpen = await platformDb
    .prepare(
      `SELECT id
       FROM content_screening_reviews
       WHERE tenant_id = ?
         AND resource_type = ?
         AND resource_id = ?
         AND content_sha256 = ?
         AND status = 'held_for_review'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(params.tenantId, params.resourceType, params.resourceId, params.contentSha256)
    .first<{ readonly id: string }>();

  if (existingOpen?.id) {
    return { reviewId: existingOpen.id, deduplicated: true };
  }

  // 2. Enforce per-tenant pending review queue flood cap
  const openCountRow = await platformDb
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM content_screening_reviews
       WHERE tenant_id = ? AND status = 'held_for_review'`,
    )
    .bind(params.tenantId)
    .first<{ readonly cnt: number }>();

  if (Number(openCountRow?.cnt ?? 0) >= MAX_OPEN_REVIEWS_PER_TENANT) {
    throw new ContentScreeningError(
      429,
      "TOO_MANY_PENDING_REVIEWS",
      "Terlalu banyak konten yang sedang menunggu peninjauan keamanan pada situs ini. Tunggu proses peninjauan selesai sebelum mengirim publikasi baru.",
    );
  }

  const reviewId = generatePlatformAuditId(params.nowMs);
  try {
    const insertRes = await platformDb
      .prepare(
        `INSERT INTO content_screening_reviews (
           id, tenant_id, resource_type, resource_id, resource_slug, resource_title,
           publish_source, expected_version, status, match_count,
           matched_categories_json, matched_fields_json, findings_json,
           content_sha256, held_snapshot_json, ruleset_version, submitted_by_user_id,
           version, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'held_for_review', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
         WHERE (
           SELECT COUNT(*)
           FROM content_screening_reviews
           WHERE tenant_id = ? AND status = 'held_for_review'
         ) < ?`,
      )
      .bind(
        reviewId,
        params.tenantId,
        params.resourceType,
        params.resourceId,
        params.resourceSlug,
        params.resourceTitle,
        params.publishSource,
        params.expectedVersion,
        Math.max(1, params.screening.findings.length),
        JSON.stringify(params.screening.matchedCategories),
        JSON.stringify(params.screening.matchedFields),
        JSON.stringify(params.screening.findings),
        params.contentSha256,
        params.heldSnapshotJson,
        params.screening.rulesetVersion,
        params.actorUserId,
        params.nowMs,
        params.nowMs,
        params.tenantId,
        MAX_OPEN_REVIEWS_PER_TENANT,
      )
      .run();

    if (Number(insertRes.meta?.changes ?? 0) === 0) {
      // Re-check whether a concurrent request created an identical open hold first
      const racedOpen = await platformDb
        .prepare(
          `SELECT id
           FROM content_screening_reviews
           WHERE tenant_id = ?
             AND resource_type = ?
             AND resource_id = ?
             AND content_sha256 = ?
             AND status = 'held_for_review'
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .bind(params.tenantId, params.resourceType, params.resourceId, params.contentSha256)
        .first<{ readonly id: string }>();
      if (racedOpen?.id) {
        return { reviewId: racedOpen.id, deduplicated: true };
      }
      throw new ContentScreeningError(
        429,
        "TOO_MANY_PENDING_REVIEWS",
        "Terlalu banyak konten yang sedang menunggu peninjauan keamanan pada situs ini. Tunggu proses peninjauan selesai sebelum mengirim publikasi baru.",
      );
    }
  } catch (err) {
    if (err instanceof ContentScreeningError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    // Atomic partial unique index (`content_screening_reviews_open_dedup_idx`) race -> return existing open hold
    if (msg.toLowerCase().includes("unique")) {
      const racedOpen = await platformDb
        .prepare(
          `SELECT id
           FROM content_screening_reviews
           WHERE tenant_id = ?
             AND resource_type = ?
             AND resource_id = ?
             AND content_sha256 = ?
             AND status = 'held_for_review'
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .bind(params.tenantId, params.resourceType, params.resourceId, params.contentSha256)
        .first<{ readonly id: string }>();
      if (racedOpen?.id) {
        return { reviewId: racedOpen.id, deduplicated: true };
      }
    }
    throw err;
  }

  return { reviewId, deduplicated: false };
}

function safeJsonParse(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const RAW_RESOURCE_TABLES: Readonly<
  Record<PublishableResourceType, { readonly table: string; readonly pk: string }>
> = {
  page: { table: "pages", pk: "id" },
  post: { table: "posts", pk: "id" },
  offering: { table: "offerings", pk: "id" },
  site_settings: { table: "site_settings", pk: "id" },
  business_profile: { table: "business_profile", pk: "id" },
  menu: { table: "menus", pk: "id" },
  theme_config: { table: "theme_config", pk: "key" },
};

/**
 * Loads the authoritative screenable draft snapshot for any `PublishableResourceType`.
 * Combines `getDraftResourceForAdmin` with a fallback raw SQLite row read so rows seeded
 * without a `snapshotVersion: 1` envelope can NEVER bypass publish-time screening.
 */
export async function loadScreenableResourceDraft<K extends PublishableResourceType>(
  tenantDb: D1Database,
  resourceType: K,
  resourceId: K extends "theme_config" ? string : number,
  draftOverride?: unknown,
): Promise<{
  readonly version: number;
  readonly snapshot: unknown;
}> {
  const adminDraft = await getDraftResourceForAdmin(tenantDb, {
    resourceType,
    resourceId,
  });

  if (!adminDraft) {
    throw new ContentScreeningError(
      404,
      "NOT_FOUND",
      `Konten ${resourceType} #${String(resourceId)} tidak ditemukan.`,
    );
  }

  if (draftOverride !== undefined) {
    return { version: adminDraft.version, snapshot: draftOverride };
  }

  if (adminDraft.draft !== null) {
    return { version: adminDraft.version, snapshot: adminDraft.draft };
  }

  const cfg = RAW_RESOURCE_TABLES[resourceType];
  const rawRow = await tenantDb
    .prepare(`SELECT * FROM ${cfg.table} WHERE ${cfg.pk} = ? LIMIT 1`)
    .bind(resourceId)
    .first<Record<string, unknown>>();

  if (!rawRow) {
    throw new ContentScreeningError(
      404,
      "NOT_FOUND",
      `Konten ${resourceType} #${String(resourceId)} tidak ditemukan.`,
    );
  }

  const parsedRow: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawRow)) {
    if (k.endsWith("_json") && typeof v === "string") {
      parsedRow[k] = safeJsonParse(v);
    } else {
      parsedRow[k] = v;
    }
  }

  return { version: adminDraft.version, snapshot: parsedRow };
}

/**
 * Screens any publishable CMS resource (`page`, `post`, `offering`, `site_settings`,
 * `business_profile`, `menu`, `theme_config`) across BOTH dashboard and MCP publish paths.
 */
export async function publishResourceWithScreening<K extends PublishableResourceType>(
  platformDb: D1Database,
  tenantDb: D1Database,
  params: PublishGateResourceParams<K>,
): Promise<PublishGateResourceOutcome<K>> {
  const nowMs = Math.floor(params.nowMs ?? Date.now());
  const resourceIdStr = String(params.resourceId);

  // 1. Read authoritative draft snapshot before publishing
  const loadedDraft = await loadScreenableResourceDraft(
    tenantDb,
    params.resourceType,
    params.resourceId,
    params.draftOverride,
  );

  if (loadedDraft.version !== params.expectedVersion) {
    throw new ContentScreeningError(
      409,
      "STALE_VERSION",
      `Versi konten tidak cocok (diharapkan ${params.expectedVersion}, aktual ${loadedDraft.version}).`,
    );
  }

  const candidateSnapshot = loadedDraft.snapshot;

  // 2. Gather media ALT texts fail-closed (never silently skip >50 items or DB errors!)
  const referencedMediaIds = new Set<number>(params.extraMediaIds ?? []);
  collectReferencedMediaIds(candidateSnapshot, referencedMediaIds);
  const mediaScan = await fetchMediaAltTextsFailClosed(tenantDb, Array.from(referencedMediaIds));
  const combinedAlts = [...mediaScan.alts, ...(params.extraImageAlts ?? [])];

  const { title, slug } = extractTitleAndSlug(params.resourceType, candidateSnapshot, resourceIdStr);

  // 3. Load active ruleset & run deterministic ReDoS-safe screening
  const { rules, rulesetVersion } = await loadActiveScreeningRuleset(platformDb);
  const payload: PublishScreeningInputPayload = {
    title,
    slug,
    imageAlts: combinedAlts,
    formLabels: params.extraFormLabels,
    snapshot: candidateSnapshot,
  };

  let screening = screenPublishContent(payload, { rules, rulesetVersion });

  // Fail closed if media ALT scan errored or truncated
  if (!mediaScan.ok) {
    const mediaFinding: ScreeningFinding = {
      ruleId: mediaScan.failureRuleId,
      ruleType: "keyword",
      category: "illegal_content",
      severity: "hold",
      fieldKind: "image_alt",
      fieldPath: "media_items.alt_text",
      matchedHost: null,
      redactedExcerpt: mediaScan.excerpt,
    };
    screening = {
      ...screening,
      verdict: "hold_for_review",
      reasonCode: HELD_FOR_REVIEW_REASON_CODE,
      ownerNotice: OWNER_HELD_FOR_REVIEW_NOTICE,
      matchedCategories: Array.from(new Set([...screening.matchedCategories, "illegal_content"])),
      matchedFields: Array.from(new Set([...screening.matchedFields, "image_alt"])),
      findings: [...screening.findings, mediaFinding],
    };
  }

  if (screening.verdict === "hold_for_review") {
    const contentSha256 = await computeScreeningContentHash(candidateSnapshot);
    const heldSnapshotJson =
      params.draftOverride !== undefined ? JSON.stringify(params.draftOverride) : null;

    const { reviewId, deduplicated } = await persistHeldReviewRow(platformDb, {
      tenantId: params.tenantId,
      resourceType: params.resourceType,
      resourceId: resourceIdStr,
      resourceSlug: slug,
      resourceTitle: title,
      publishSource: params.publishSource,
      expectedVersion: params.expectedVersion,
      screening,
      contentSha256,
      heldSnapshotJson,
      actorUserId: params.actorUserId ?? null,
      nowMs,
    });

    await recordTenantHoldAndActivityBestEffort(tenantDb, {
      resourceType: params.resourceType,
      resourceId: resourceIdStr,
      reviewId,
      actorUserId: params.actorUserId ?? null,
      nowMs,
    });

    return {
      outcome: "held_for_review",
      held: true,
      reviewId,
      deduplicated,
      ownerNotice: buildOwnerSafeHeldPublishNotice(reviewId),
    };
  }

  // 4. Clean content -> proceed with atomic publish
  const published = await publishResourceAtomically(platformDb, tenantDb, {
    tenantId: params.tenantId,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    expectedVersion: params.expectedVersion,
    actorUserId: params.actorUserId ?? null,
    draftOverride: params.draftOverride,
    nowMs,
  });

  await clearTenantHoldBestEffort(tenantDb, params.resourceType, resourceIdStr, nowMs);

  return {
    outcome: "published",
    held: false,
    screening: {
      verdict: "allow",
      rulesetVersion: screening.rulesetVersion,
      scannedFieldsCount: screening.scannedFieldsCount,
      scannedLinksCount: screening.scannedLinksCount,
    },
    published,
  };
}

/**
 * Screens a custom form (`tenant_forms`) including all custom-form labels, placeholders,
 * options, submit label, and confirmation message before publishing via `publishTenantForm`.
 */
export async function publishFormWithScreening(
  platformDb: D1Database,
  tenantDb: D1Database,
  params: PublishGateFormParams,
): Promise<PublishGateFormOutcome> {
  const nowMs = Math.floor(params.nowMs ?? Date.now());
  const { form } = await getTenantFormById(tenantDb, params.formId);

  if (form.version !== params.expectedVersion) {
    throw new ContentScreeningError(
      409,
      "STALE_VERSION",
      `Versi formulir tidak cocok (diharapkan ${params.expectedVersion}, aktual ${form.version}).`,
    );
  }

  const formLabels: string[] = [form.name];
  if (form.description) formLabels.push(form.description);
  if (form.submitLabel) formLabels.push(form.submitLabel);
  if (form.afterSubmitConfig.message) formLabels.push(form.afterSubmitConfig.message);
  for (const field of form.fields) {
    if (field.label) formLabels.push(field.label);
    if (field.placeholder) formLabels.push(field.placeholder);
    if (field.helpText) formLabels.push(field.helpText);
    if (Array.isArray(field.options)) {
      for (const opt of field.options) {
        if (typeof opt === "string") {
          formLabels.push(opt);
        }
      }
    }
  }

  const { rules, rulesetVersion } = await loadActiveScreeningRuleset(platformDb);
  const screening = screenPublishContent(
    {
      title: form.name,
      slug: form.slug,
      formLabels,
      snapshot: form,
      isFormResource: true,
    },
    { rules, rulesetVersion },
  );

  const resourceIdStr = String(form.id);
  if (screening.verdict === "hold_for_review") {
    const contentSha256 = await computeScreeningContentHash(form);
    const { reviewId, deduplicated } = await persistHeldReviewRow(platformDb, {
      tenantId: params.tenantId,
      resourceType: "form",
      resourceId: resourceIdStr,
      resourceSlug: form.slug,
      resourceTitle: form.name,
      publishSource: params.publishSource,
      expectedVersion: params.expectedVersion,
      screening,
      contentSha256,
      heldSnapshotJson: null,
      actorUserId: params.actorUserId ?? null,
      nowMs,
    });

    await recordTenantHoldAndActivityBestEffort(tenantDb, {
      resourceType: "form",
      resourceId: resourceIdStr,
      reviewId,
      actorUserId: params.actorUserId ?? null,
      nowMs,
    });

    return {
      outcome: "held_for_review",
      held: true,
      reviewId,
      deduplicated,
      ownerNotice: buildOwnerSafeHeldPublishNotice(reviewId),
    };
  }

  const published = await publishTenantForm(tenantDb, {
    formId: params.formId,
    expectedVersion: params.expectedVersion,
    action: "publish",
    actorUserId: params.actorUserId ?? null,
    nowMs,
  });

  await clearTenantHoldBestEffort(tenantDb, "form", resourceIdStr, nowMs);

  return {
    outcome: "published",
    held: false,
    screening: {
      verdict: "allow",
      rulesetVersion: screening.rulesetVersion,
      scannedFieldsCount: screening.scannedFieldsCount,
      scannedLinksCount: screening.scannedLinksCount,
    },
    published,
  };
}

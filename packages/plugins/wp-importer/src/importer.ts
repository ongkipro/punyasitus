import { generateUlid } from "@punyasitus/core/media/index";
import type { PluginTenantDb } from "@punyasitus/core/plugins/index";
import { normalizeTitleToSlug } from "@punyasitus/core/slug/index";
import { processWpImageReference } from "./media.ts";
import { convertWpHtmlToSanitizedTipTapDoc, sanitizeWpSeoMeta } from "./tiptap.ts";
import {
  WP_IMPORTER_LIMITS,
  WpImporterError,
  type WpFormerUrlEntry,
  type WpImportedMediaReportItem,
  type WpImportedPostSummary,
  type WpImporterExecutionDeps,
  type WpImportJobStatus,
  type WpImportJobSummary,
  type WpImportReport,
  type WpImportRequestInput,
  type WpImportWarning,
  type WpParsedImageRef,
  type WpParsedPost,
  type WpSourceParseResult,
} from "./types.ts";
import { fetchWpJsonSite } from "./wp-json.ts";
import { parseWxrExport } from "./wxr.ts";

/**
 * WordPress `/wp-json` & WXR Safe Draft Import Orchestrator (`TASK-100`, `REQ-100`).
 *
 * Hard Invariants:
 * 1. **Strictly DRAFT-ONLY:** Every imported post is ALWAYS created with `status = "draft"`,
 *    `publishedAt = null`, `published = null` — NEVER auto-published regardless of source WP status.
 * 2. **Durable Job Lifecycle:** Persists `plg_wp_importer__jobs` with `status = 'running'`
 *    BEFORE any remote fetch, R2 upload, or CMS write, and always finalizes it to
 *    `completed`, `completed_with_warnings`, or `failed` (with `error_code` / `error_message`).
 * 3. **Fail-Closed CMS Persistence:** Never silently fakes CMS import success when `cmsWriter`
 *    is unavailable — fails closed with `503 CMS_WRITER_UNAVAILABLE` unless `allowStagedFallback`
 *    is explicitly enabled.
 * 4. **Compact Persisted Reports:** Drops bulky `sanitizedBody` TipTap trees from
 *    `plg_wp_importer__jobs.report_json` so 100-post jobs never approach SQLite row limits.
 */

function allocateUniqueSlug(baseSlug: string, usedSlugs: Set<string>): string {
  const clean = normalizeTitleToSlug(baseSlug, { fallbackPrefix: "artikel" });
  if (!usedSlugs.has(clean)) {
    usedSlugs.add(clean);
    return clean;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${clean.slice(0, 74)}-${suffix}`;
    if (!usedSlugs.has(candidate)) {
      usedSlugs.add(candidate);
      return candidate;
    }
  }
  const fallback = `${clean.slice(0, 64)}-${Date.now()}`;
  usedSlugs.add(fallback);
  return fallback;
}

interface StagedDraftPersistencePayload {
  readonly summary: WpImportedPostSummary;
  readonly parsedPost: WpParsedPost;
  readonly coverMediaId: number | null;
  readonly importedMediaIds: readonly number[];
}

function buildCompactPersistedReportJson(report: WpImportReport): string {
  const compactPosts = report.posts.map((post) => ({
    sourceId: post.sourceId,
    title: post.title,
    sourceStatus: post.sourceStatus,
    importedStatus: post.importedStatus,
    publishedAt: post.publishedAt,
    sourceSlug: post.sourceSlug,
    targetSlug: post.targetSlug,
    targetPostId: post.targetPostId,
    categories: post.categories,
    tags: post.tags,
    imageCount: post.imageCount,
    importedImageCount: post.importedImageCount,
    hasSeoMeta: post.hasSeoMeta,
    blockCount: post.sanitizedBody.blocks.length,
    sanitizedSeo: post.sanitizedSeo,
  }));

  return JSON.stringify({
    jobId: report.jobId,
    mode: report.mode,
    sourceKind: report.sourceKind,
    sourceLabel: report.sourceLabel,
    status: report.status,
    draftOnlyEnforced: report.draftOnlyEnforced,
    counts: report.counts,
    quota: report.quota,
    posts: compactPosts,
    media: report.media,
    formerUrls: report.formerUrls,
    warnings: report.warnings,
    createdAt: report.createdAt,
    completedAt: report.completedAt,
  });
}

async function insertRunningJobRow(
  db: PluginTenantDb,
  params: {
    readonly jobId: string;
    readonly mode: "dry_run" | "import";
    readonly sourceKind: "wp_json" | "wxr";
    readonly sourceLabel: string;
    readonly actorUserId: string;
    readonly nowMs: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO plg_wp_importer__jobs (
         id, mode, source_kind, source_label, status, actor_user_id,
         posts_found, posts_imported, posts_skipped,
         categories_imported, tags_imported,
         images_imported, images_skipped, bytes_imported,
         report_json, error_code, error_message, created_at, completed_at
       ) VALUES (?, ?, ?, ?, 'running', ?, 0, 0, 0, 0, 0, 0, 0, 0, '{}', NULL, NULL, ?, NULL)`,
    )
    .bind(
      params.jobId,
      params.mode,
      params.sourceKind,
      params.sourceLabel.slice(0, 300),
      params.actorUserId,
      params.nowMs,
    )
    .run();
}

async function markJobRowFailed(
  db: PluginTenantDb,
  params: {
    readonly jobId: string;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly completedMs: number;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE plg_wp_importer__jobs
         SET status = 'failed',
             error_code = ?,
             error_message = ?,
             report_json = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .bind(
        params.errorCode.slice(0, 64),
        params.errorMessage.slice(0, 500),
        JSON.stringify({
          jobId: params.jobId,
          status: "failed",
          errorCode: params.errorCode,
          errorMessage: params.errorMessage,
        }),
        params.completedMs,
        params.jobId,
      )
      .run();
  } catch {
    // Never mask the original import error if recording failure status fails
  }
}

export async function executeWpImport(
  input: WpImportRequestInput,
  deps: WpImporterExecutionDeps,
): Promise<WpImportReport> {
  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  const jobId = `wpimp_${generateUlid(nowMs)}`;
  const importImages = input.importImages !== false;
  const maxPosts = Math.min(
    Math.max(1, input.maxPosts ?? WP_IMPORTER_LIMITS.maxImportPosts),
    WP_IMPORTER_LIMITS.maxImportPosts,
  );

  // Basic input validation BEFORE inserting a running job row
  if (input.sourceKind !== "wp_json" && input.sourceKind !== "wxr") {
    throw new WpImporterError(
      422,
      "VALIDATION_ERROR",
      "Sumber impor harus berupa 'wp_json' atau 'wxr'.",
    );
  }
  if (input.sourceKind === "wp_json" && (!input.siteUrl || !input.siteUrl.trim())) {
    throw new WpImporterError(
      422,
      "VALIDATION_ERROR",
      "URL situs WordPress wajib diisi untuk mode impor /wp-json.",
    );
  }
  if (input.sourceKind === "wxr" && (!input.wxrXml || !input.wxrXml.trim())) {
    throw new WpImporterError(
      422,
      "VALIDATION_ERROR",
      "Isi berkas WXR XML wajib disertakan untuk mode impor WXR.",
    );
  }

  const initialSourceLabel =
    input.sourceKind === "wp_json" ? input.siteUrl!.trim() : "WXR XML Upload";

  // 0. Persist durable `running` job record BEFORE any remote fetch, R2 upload, or CMS write
  if (deps.db) {
    await insertRunningJobRow(deps.db, {
      jobId,
      mode: input.mode,
      sourceKind: input.sourceKind,
      sourceLabel: initialSourceLabel,
      actorUserId: deps.actorUserId,
      nowMs,
    });
  }

  try {
    // 1. Fail closed BEFORE writing anything if `mode === "import"` has no real CMS writer
    if (input.mode === "import" && !deps.cmsWriter && deps.allowStagedFallback !== true) {
      throw new WpImporterError(
        503,
        "CMS_WRITER_UNAVAILABLE",
        "Koneksi penyimpanan artikel CMS tidak tersedia pada runtime ini; impor dibatalkan agar tidak mencatat keberhasilan palsu.",
      );
    }

    // 2. Parse source (SSRF-guarded `/wp-json` OR XXE/bomb-guarded WXR XML)
    let parsed: WpSourceParseResult;
    if (input.sourceKind === "wp_json") {
      parsed = await fetchWpJsonSite(input.siteUrl!, {
        fetchImpl: deps.fetchImpl,
        maxPosts,
        allowHttp: input.allowHttp,
      });
    } else {
      parsed = parseWxrExport(input.wxrXml!, { maxPosts });
    }

    const warnings: WpImportWarning[] = [...parsed.warnings];

    // 3. Inspect tenant storage quota snapshot BEFORE touching any media
    const quotaBefore = deps.mediaPort ? await deps.mediaPort.getQuotaSnapshot() : null;
    let remainingQuotaBytes: number | null = quotaBefore ? quotaBefore.availableBytes : null;
    let totalBytesImported = 0;
    let quotaExceededAny = false;

    // 4. Collect & deduplicate image references across all parsed posts (bounded per job)
    const uniqueImages: WpParsedImageRef[] = [];
    const seenImageUrls = new Set<string>();
    if (importImages) {
      for (const post of parsed.posts) {
        const candidates: WpParsedImageRef[] = [];
        if (post.featuredImage) candidates.push(post.featuredImage);
        for (const img of post.inlineImages) candidates.push(img);

        for (const ref of candidates) {
          if (seenImageUrls.has(ref.sourceUrl)) continue;
          if (uniqueImages.length >= WP_IMPORTER_LIMITS.maxImagesPerJob) {
            warnings.push({
              code: "MAX_IMAGES_LIMIT_REACHED",
              message: `Batas maksimal ${WP_IMPORTER_LIMITS.maxImagesPerJob} gambar per impor tercapai; gambar berikutnya dilewati.`,
              sourceUrl: ref.sourceUrl,
            });
            break;
          }
          seenImageUrls.add(ref.sourceUrl);
          uniqueImages.push(ref);
        }
      }
    }

    // 5. Process images (SSRF guard -> magic-byte sniff -> WebP normalize -> quota-checked R2 store)
    const mediaReport: WpImportedMediaReportItem[] = [];
    const mediaIdBySourceUrl = new Map<string, number>();
    let imagesImported = 0;
    let imagesSkipped = 0;
    let imagesBlocked = 0;

    for (const imgRef of uniqueImages) {
      const outcome = await processWpImageReference({
        tenantId: deps.tenant.id,
        sourceUrl: imgRef.sourceUrl,
        altText: imgRef.altText,
        mode: input.mode,
        fetchImpl: deps.fetchImpl,
        allowHttp: input.allowHttp,
        webpEncoder: deps.webpEncoder,
        imagesBinding: deps.imagesBinding,
        mediaPort: deps.mediaPort,
        remainingQuotaBytes,
        nowMs,
      });

      mediaReport.push(outcome.reportItem);

      if (outcome.reportItem.status === "imported") {
        imagesImported += 1;
        totalBytesImported += outcome.bytesConsumed;
        if (remainingQuotaBytes !== null) {
          remainingQuotaBytes = Math.max(0, remainingQuotaBytes - outcome.bytesConsumed);
        }
        if (outcome.mediaId !== null) {
          mediaIdBySourceUrl.set(imgRef.sourceUrl, outcome.mediaId);
        }
      } else if (outcome.reportItem.status === "dry_run_valid") {
        if (remainingQuotaBytes !== null) {
          remainingQuotaBytes = Math.max(0, remainingQuotaBytes - outcome.bytesConsumed);
        }
      } else if (outcome.reportItem.status === "quota_exceeded") {
        imagesSkipped += 1;
        quotaExceededAny = true;
        warnings.push({
          code: "STORAGE_QUOTA_EXCEEDED",
          message: outcome.reportItem.message ?? "Kuota penyimpanan situs penuh; gambar dilewati.",
          sourceUrl: imgRef.sourceUrl,
        });
      } else if (outcome.reportItem.status === "rejected") {
        imagesBlocked += 1;
        warnings.push({
          code: outcome.reportItem.reasonCode ?? "MEDIA_REJECTED",
          message: outcome.reportItem.message ?? "Gambar diblokir demi keamanan.",
          sourceUrl: imgRef.sourceUrl,
        });
      } else {
        imagesSkipped += 1;
        if (outcome.reportItem.message) {
          warnings.push({
            code: outcome.reportItem.reasonCode ?? "MEDIA_SKIPPED",
            message: outcome.reportItem.message,
            sourceUrl: imgRef.sourceUrl,
          });
        }
      }
    }

    // 6. Ensure categories & tags (only persist in `import` mode when `cmsWriter` is provided)
    const categoryIdBySlug = new Map<string, number>();
    const tagIdBySlug = new Map<string, number>();
    let categoriesImported = 0;
    let tagsImported = 0;

    if (input.mode === "import" && deps.cmsWriter) {
      const sortedCats = [...parsed.categories].sort((a, b) => {
        const aHasParent = a.parentSlug ? 1 : 0;
        const bHasParent = b.parentSlug ? 1 : 0;
        return aHasParent - bHasParent;
      });

      for (const cat of sortedCats) {
        const parentId = cat.parentSlug ? (categoryIdBySlug.get(cat.parentSlug) ?? null) : null;
        const ensured = await deps.cmsWriter.ensureCategory({
          name: cat.name,
          slug: cat.slug,
          description: cat.description ?? null,
          parentId,
          nowMs,
        });
        categoryIdBySlug.set(cat.slug, ensured.id);
        if (ensured.created) categoriesImported += 1;
      }

      for (const tag of parsed.tags) {
        const ensured = await deps.cmsWriter.ensureTag({
          name: tag.name,
          slug: tag.slug,
          description: tag.description ?? null,
          nowMs,
        });
        tagIdBySlug.set(tag.slug, ensured.id);
        if (ensured.created) tagsImported += 1;
      }
    }

    // 7. Convert each post HTML -> sanitized TipTap JSON & create strictly DRAFT posts
    const usedSlugs = new Set<string>();
    const postSummaries: WpImportedPostSummary[] = [];
    const stagedPayloads: StagedDraftPersistencePayload[] = [];
    const formerUrls: WpFormerUrlEntry[] = [];
    let postsImported = 0;
    let postsSkipped = parsed.skippedItems;

    for (const post of parsed.posts) {
      const { doc: sanitizedBody } = convertWpHtmlToSanitizedTipTapDoc(post.rawHtml, {
        baseSiteUrl: parsed.siteUrl,
        mediaIdBySourceUrl,
      });
      const sanitizedSeo = sanitizeWpSeoMeta(post.seo);
      const desiredSlug = allocateUniqueSlug(post.sourceSlug, usedSlugs);

      const coverMediaId =
        post.featuredImage ? (mediaIdBySourceUrl.get(post.featuredImage.sourceUrl) ?? null) : null;

      const categoryIds = post.categories
        .map((c) => categoryIdBySlug.get(c.slug))
        .filter((id): id is number => typeof id === "number");
      const primaryCategoryId = categoryIds[0] ?? null;
      const tagIds = post.tags
        .map((t) => tagIdBySlug.get(t.slug))
        .filter((id): id is number => typeof id === "number");

      const postImageRefs = [
        ...(post.featuredImage ? [post.featuredImage] : []),
        ...post.inlineImages,
      ];
      const importedMediaIds = postImageRefs
        .map((r) => mediaIdBySourceUrl.get(r.sourceUrl))
        .filter((id): id is number => typeof id === "number");
      const importedForPost = importedMediaIds.length;

      let targetPostId: number | null = null;
      let finalSlug = desiredSlug;

      if (input.mode === "import") {
        if (deps.cmsWriter) {
          try {
            const created = await deps.cmsWriter.createDraftPost({
              title: post.title,
              slug: desiredSlug,
              excerpt: post.excerpt,
              body: sanitizedBody,
              coverMediaId,
              primaryCategoryId,
              categoryIds,
              tagIds,
              seo: sanitizedSeo,
              status: "draft", // HARD INVARIANT: NEVER auto-publish!
              nowMs,
            });
            if (created.status !== "draft" || created.publishedAt !== null) {
              throw new WpImporterError(
                422,
                "IMPORT_FAILED",
                "Pelanggaran invarian: artikel impor harus berstatus draf dan belum terbit.",
              );
            }
            targetPostId = created.id;
            finalSlug = created.slug;
            postsImported += 1;
          } catch (err) {
            postsSkipped += 1;
            warnings.push({
              code: "POST_IMPORT_SKIPPED",
              message: `Artikel "${post.title}" gagal disimpan sebagai draf: ${err instanceof Error ? err.message : "unknown error"}`,
              sourcePostId: post.sourceId,
            });
            continue;
          }
        } else {
          // Explicit staged fallback only (`deps.allowStagedFallback === true`)
          postsImported += 1;
        }
      }

      const formerEntry: WpFormerUrlEntry = {
        sourceUrl: post.sourceUrl,
        sourcePath: post.sourcePath,
        sourceSlug: post.sourceSlug,
        targetSlug: finalSlug,
        targetPath: `/blog/${finalSlug}`,
        targetPostId,
        sourceStatus: post.sourceStatus,
        importedStatus: "draft",
      };
      formerUrls.push(formerEntry);

      const summary: WpImportedPostSummary = {
        sourceId: post.sourceId,
        title: post.title,
        sourceStatus: post.sourceStatus,
        importedStatus: "draft",
        publishedAt: null,
        sourceSlug: post.sourceSlug,
        targetSlug: finalSlug,
        targetPostId,
        categories: post.categories.map((c) => c.name),
        tags: post.tags.map((t) => t.name),
        imageCount: postImageRefs.length,
        importedImageCount: importedForPost,
        hasSeoMeta: sanitizedSeo !== null,
        sanitizedBody,
        sanitizedSeo,
      };
      postSummaries.push(summary);

      if (input.mode === "import" && !deps.cmsWriter && deps.allowStagedFallback === true) {
        stagedPayloads.push({
          summary,
          parsedPost: post,
          coverMediaId,
          importedMediaIds,
        });
      }
    }

    const quotaAfter = deps.mediaPort ? await deps.mediaPort.getQuotaSnapshot() : null;
    const completedMs = Math.floor(deps.nowMs ? nowMs + 1 : Date.now());
    const status: WpImportJobStatus =
      warnings.length > 0 || imagesBlocked > 0 || quotaExceededAny
        ? "completed_with_warnings"
        : "completed";

    const report: WpImportReport = {
      jobId,
      mode: input.mode,
      sourceKind: input.sourceKind,
      sourceLabel: parsed.sourceLabel,
      status,
      draftOnlyEnforced: true,
      counts: {
        postsFound: parsed.posts.length,
        postsImported,
        postsSkipped,
        categoriesFound: parsed.categories.length,
        categoriesImported: input.mode === "import" ? categoriesImported : 0,
        tagsFound: parsed.tags.length,
        tagsImported: input.mode === "import" ? tagsImported : 0,
        imagesFound: uniqueImages.length,
        imagesImported,
        imagesSkipped,
        imagesBlocked,
        bytesImported: totalBytesImported,
      },
      quota: {
        quotaBytes: quotaAfter?.quotaBytes ?? quotaBefore?.quotaBytes ?? null,
        usedBytesBefore: quotaBefore?.usedBytes ?? null,
        usedBytesAfter:
          quotaAfter?.usedBytes ?? (quotaBefore ? quotaBefore.usedBytes + totalBytesImported : null),
        remainingBytesAfter: quotaAfter?.availableBytes ?? remainingQuotaBytes,
        exceeded: quotaExceededAny,
      },
      posts: postSummaries,
      media: mediaReport,
      formerUrls,
      warnings,
      createdAt: new Date(nowMs).toISOString(),
      completedAt: new Date(completedMs).toISOString(),
    };

    // 8. Finalize `plg_wp_importer__jobs` (compact `report_json`!) + insert `url_map` / staged drafts
    if (deps.db) {
      await finalizeImportJobRecords(deps.db, {
        report,
        nowMs,
        completedMs,
        stagedPayloads,
      });
    }

    return report;
  } catch (err) {
    if (deps.db) {
      const errorCode = err instanceof WpImporterError ? err.code : "IMPORT_FAILED";
      const errorMessage = err instanceof Error ? err.message : "Impor WordPress gagal.";
      const failedMs = Math.floor(deps.nowMs ? nowMs + 1 : Date.now());
      await markJobRowFailed(deps.db, {
        jobId,
        errorCode,
        errorMessage,
        completedMs: failedMs,
      });
    }
    throw err;
  }
}

async function finalizeImportJobRecords(
  db: PluginTenantDb,
  params: {
    readonly report: WpImportReport;
    readonly nowMs: number;
    readonly completedMs: number;
    readonly stagedPayloads: readonly StagedDraftPersistencePayload[];
  },
): Promise<void> {
  const { report, nowMs, completedMs, stagedPayloads } = params;
  // Compact report_json drops bulky `sanitizedBody` TipTap trees to keep SQLite rows bounded
  const compactReportJson = buildCompactPersistedReportJson(report);

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE plg_wp_importer__jobs
         SET source_label = ?,
             status = ?,
             posts_found = ?,
             posts_imported = ?,
             posts_skipped = ?,
             categories_imported = ?,
             tags_imported = ?,
             images_imported = ?,
             images_skipped = ?,
             bytes_imported = ?,
             report_json = ?,
             error_code = NULL,
             error_message = NULL,
             completed_at = ?
         WHERE id = ?`,
      )
      .bind(
        report.sourceLabel.slice(0, 300),
        report.status,
        report.counts.postsFound,
        report.counts.postsImported,
        report.counts.postsSkipped,
        report.counts.categoriesImported,
        report.counts.tagsImported,
        report.counts.imagesImported,
        report.counts.imagesSkipped + report.counts.imagesBlocked,
        report.counts.bytesImported,
        compactReportJson,
        completedMs,
        report.jobId,
      ),
  ];

  for (let i = 0; i < report.formerUrls.length; i += 1) {
    const entry = report.formerUrls[i]!;
    stmts.push(
      db
        .prepare(
          `INSERT INTO plg_wp_importer__url_map (
             id, job_id, source_url, source_path, source_slug,
             target_slug, target_path, target_post_id,
             source_status, imported_status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
        )
        .bind(
          `wpmap_${generateUlid(nowMs)}_${i}`,
          report.jobId,
          entry.sourceUrl.slice(0, 1000),
          entry.sourcePath.slice(0, 500),
          entry.sourceSlug.slice(0, 120),
          entry.targetSlug.slice(0, 120),
          entry.targetPath.slice(0, 160),
          entry.targetPostId,
          entry.sourceStatus.slice(0, 32),
          nowMs,
        ),
    );
  }

  for (let i = 0; i < stagedPayloads.length; i += 1) {
    const staged = stagedPayloads[i]!;
    const { summary, parsedPost, coverMediaId, importedMediaIds } = staged;
    stmts.push(
      db
        .prepare(
          `INSERT INTO plg_wp_importer__staged_drafts (
             id, job_id, source_id, slug, title, excerpt,
             body_json, seo_json, categories_json, tags_json,
             media_json, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
        )
        .bind(
          `wpdraft_${generateUlid(nowMs)}_${i}`,
          report.jobId,
          summary.sourceId.slice(0, 120),
          summary.targetSlug.slice(0, 120),
          summary.title.slice(0, 200),
          parsedPost.excerpt,
          JSON.stringify(summary.sanitizedBody),
          summary.sanitizedSeo ? JSON.stringify(summary.sanitizedSeo) : null,
          JSON.stringify(parsedPost.categories.map((c) => ({ slug: c.slug, name: c.name }))),
          JSON.stringify(parsedPost.tags.map((t) => ({ slug: t.slug, name: t.name }))),
          JSON.stringify({ coverMediaId, mediaIds: importedMediaIds }),
          nowMs,
        ),
    );
  }

  await db.batch(stmts);
}

interface RawJobRow {
  readonly id: string;
  readonly mode: string;
  readonly source_kind: string;
  readonly source_label: string;
  readonly status: string;
  readonly actor_user_id: string;
  readonly posts_found: number;
  readonly posts_imported: number;
  readonly posts_skipped: number;
  readonly categories_imported: number;
  readonly tags_imported: number;
  readonly images_imported: number;
  readonly images_skipped: number;
  readonly bytes_imported: number;
  readonly report_json: string;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly created_at: number;
  readonly completed_at: number | null;
}

interface RawUrlMapRow {
  readonly id: string;
  readonly job_id: string;
  readonly source_url: string;
  readonly source_path: string;
  readonly source_slug: string;
  readonly target_slug: string;
  readonly target_path: string;
  readonly target_post_id: number | null;
  readonly source_status: string;
  readonly imported_status: string;
  readonly created_at: number;
}

function mapJobSummary(row: RawJobRow): WpImportJobSummary {
  const status: WpImportJobStatus =
    row.status === "failed"
      ? "failed"
      : row.status === "running"
        ? "running"
        : row.status === "completed_with_warnings"
          ? "completed_with_warnings"
          : "completed";
  return {
    id: row.id,
    mode: row.mode === "import" ? "import" : "dry_run",
    sourceKind: row.source_kind === "wxr" ? "wxr" : "wp_json",
    sourceLabel: row.source_label,
    status,
    actorUserId: row.actor_user_id,
    postsFound: Number(row.posts_found),
    postsImported: Number(row.posts_imported),
    postsSkipped: Number(row.posts_skipped),
    categoriesImported: Number(row.categories_imported),
    tagsImported: Number(row.tags_imported),
    imagesImported: Number(row.images_imported),
    imagesSkipped: Number(row.images_skipped),
    bytesImported: Number(row.bytes_imported),
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    completedAt: row.completed_at ? new Date(Number(row.completed_at)).toISOString() : null,
  };
}

export async function listWpImportJobs(
  db: PluginTenantDb,
  limit = 20,
): Promise<readonly WpImportJobSummary[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
  const res = await db
    .prepare(
      `SELECT id, mode, source_kind, source_label, status, actor_user_id,
              posts_found, posts_imported, posts_skipped,
              categories_imported, tags_imported,
              images_imported, images_skipped, bytes_imported,
              report_json, error_code, error_message, created_at, completed_at
       FROM plg_wp_importer__jobs
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(safeLimit)
    .all<RawJobRow>();

  return (res.results ?? []).map(mapJobSummary);
}

export async function getWpImportJobDetail(
  db: PluginTenantDb,
  jobId: string,
): Promise<{
  readonly job: WpImportJobSummary;
  readonly report: WpImportReport | null;
  readonly formerUrls: readonly WpFormerUrlEntry[];
} | null> {
  const row = await db
    .prepare(
      `SELECT id, mode, source_kind, source_label, status, actor_user_id,
              posts_found, posts_imported, posts_skipped,
              categories_imported, tags_imported,
              images_imported, images_skipped, bytes_imported,
              report_json, error_code, error_message, created_at, completed_at
       FROM plg_wp_importer__jobs
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(jobId)
    .first<RawJobRow>();

  if (!row) return null;

  let report: WpImportReport | null;
  try {
    report = JSON.parse(row.report_json) as WpImportReport;
  } catch {
    report = null;
  }

  const urls = await listWpFormerUrls(db, { jobId, limit: 200 });
  return {
    job: mapJobSummary(row),
    report,
    formerUrls: urls,
  };
}

export async function listWpFormerUrls(
  db: PluginTenantDb,
  options: { readonly jobId?: string; readonly limit?: number } = {},
): Promise<readonly WpFormerUrlEntry[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 500);
  const res = options.jobId
    ? await db
        .prepare(
          `SELECT id, job_id, source_url, source_path, source_slug,
                  target_slug, target_path, target_post_id,
                  source_status, imported_status, created_at
           FROM plg_wp_importer__url_map
           WHERE job_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .bind(options.jobId, safeLimit)
        .all<RawUrlMapRow>()
    : await db
        .prepare(
          `SELECT id, job_id, source_url, source_path, source_slug,
                  target_slug, target_path, target_post_id,
                  source_status, imported_status, created_at
           FROM plg_wp_importer__url_map
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .bind(safeLimit)
        .all<RawUrlMapRow>();

  return (res.results ?? []).map((row) => ({
    sourceUrl: row.source_url,
    sourcePath: row.source_path,
    sourceSlug: row.source_slug,
    targetSlug: row.target_slug,
    targetPath: row.target_path,
    targetPostId: row.target_post_id === null ? null : Number(row.target_post_id),
    sourceStatus: row.source_status,
    importedStatus: "draft" as const,
  }));
}

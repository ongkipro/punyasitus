import type { PageSeoOverrides, RestrictedRichTextDoc } from "@punyasitus/core/content/index";
import type { CloudflareImagesBinding, MediaVariantsManifest } from "@punyasitus/core/media/index";
import type { PluginTenantDb, PluginTenantSnapshot } from "@punyasitus/core/plugins/index";

/**
 * Shared types, hard safety limits, and dependency ports for the official free
 * `wp-importer` plugin (`TASK-100`, `REQ-100`, `ADR-0010`, `PLAN §19.7`).
 */

export const WP_IMPORTER_PLUGIN_ID = "wp-importer" as const;
export const WP_IMPORTER_TABLE_PREFIX = "plg_wp_importer__" as const;

export const WP_IMPORTER_LIMITS = {
  maxWxrBytes: 5 * 1024 * 1024, // 5 MiB max WXR XML upload
  maxWxrElements: 50_000, // hard XML tag/element ceiling
  maxWxrItems: 2_000, // hard total <item> scan ceiling (posts + pages + attachments)
  maxWxrAttachments: 500, // hard attachment indexing ceiling
  maxImportPosts: 100, // hard post count ceiling per job
  maxWpJsonPages: 10, // hard pagination ceiling
  wpJsonPerPage: 25,
  maxWpJsonResponseBytes: 4 * 1024 * 1024, // 4 MiB per JSON page
  maxImagesPerPost: 10,
  maxImagesPerJob: 50,
  maxImageSourceBytes: 5_000_000, // 5 MB (matches core media pipeline)
  maxImageWebpBytes: 2_000_000, // 2 MB normalized master cap
  maxRedirects: 3,
  fetchTimeoutMs: 12_000,
  maxTitleLength: 200,
  maxExcerptLength: 500,
  maxTaxonomyNameLength: 100,
  maxCategoriesPerPost: 10,
  maxTagsPerPost: 20,
} as const;

export type WpImportSourceKind = "wp_json" | "wxr";
export type WpImportMode = "dry_run" | "import";
export type WpImportJobStatus = "running" | "completed" | "completed_with_warnings" | "failed";

export type WpImporterErrorCode =
  | "VALIDATION_ERROR"
  | "SSRF_BLOCKED"
  | "SSRF_REDIRECT_BLOCKED"
  | "TOO_MANY_REDIRECTS"
  | "FETCH_TIMEOUT"
  | "FETCH_FAILED"
  | "RESPONSE_TOO_LARGE"
  | "WP_JSON_INVALID"
  | "WXR_TOO_LARGE"
  | "WXR_XXE_FORBIDDEN"
  | "WXR_ENTITY_EXPANSION_FORBIDDEN"
  | "WXR_TOO_MANY_ITEMS"
  | "WXR_MALFORMED"
  | "MEDIA_REJECTED"
  | "STORAGE_QUOTA_EXCEEDED"
  | "CMS_WRITER_UNAVAILABLE"
  | "IMPORT_FAILED";

export class WpImporterError extends Error {
  readonly status: 400 | 413 | 415 | 422 | 502 | 503 | 504;
  readonly code: WpImporterErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    status: 400 | 413 | 415 | 422 | 502 | 503 | 504,
    code: WpImporterErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "WpImporterError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface WpParsedTaxonomy {
  readonly kind: "category" | "tag";
  readonly sourceId?: number | string;
  readonly name: string;
  readonly slug: string;
  readonly parentSlug?: string | null;
  readonly description?: string | null;
}

export interface WpParsedSeoMeta {
  readonly titleOverride?: string | null;
  readonly descriptionOverride?: string | null;
  readonly focusKeyphrase?: string | null;
  readonly ogTitleOverride?: string | null;
  readonly ogDescriptionOverride?: string | null;
}

export interface WpParsedImageRef {
  readonly sourceUrl: string;
  readonly altText: string;
  readonly role: "featured" | "inline";
}

export interface WpParsedPost {
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly sourcePath: string;
  readonly sourceSlug: string;
  readonly sourceStatus: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly rawHtml: string;
  readonly categories: readonly WpParsedTaxonomy[];
  readonly tags: readonly WpParsedTaxonomy[];
  readonly featuredImage: WpParsedImageRef | null;
  readonly inlineImages: readonly WpParsedImageRef[];
  readonly seo: WpParsedSeoMeta | null;
}

export interface WpSourceParseResult {
  readonly sourceKind: WpImportSourceKind;
  readonly sourceLabel: string;
  readonly siteUrl: string | null;
  readonly posts: readonly WpParsedPost[];
  readonly categories: readonly WpParsedTaxonomy[];
  readonly tags: readonly WpParsedTaxonomy[];
  readonly skippedItems: number;
  readonly warnings: readonly WpImportWarning[];
}

export interface WpImportWarning {
  readonly code: string;
  readonly message: string;
  readonly sourceUrl?: string;
  readonly sourcePostId?: string;
}

export interface WpFormerUrlEntry {
  readonly sourceUrl: string;
  readonly sourcePath: string;
  readonly sourceSlug: string;
  readonly targetSlug: string;
  readonly targetPath: string;
  readonly targetPostId: number | null;
  readonly sourceStatus: string;
  readonly importedStatus: "draft";
}

export interface WpImportedMediaReportItem {
  readonly sourceUrl: string;
  readonly status: "imported" | "dry_run_valid" | "skipped" | "rejected" | "quota_exceeded";
  readonly mediaId?: number | null;
  readonly r2Key?: string | null;
  readonly mimeType?: "image/webp" | null;
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly reasonCode?: string;
  readonly message?: string;
}

export interface WpImportedPostSummary {
  readonly sourceId: string;
  readonly title: string;
  readonly sourceStatus: string;
  readonly importedStatus: "draft";
  readonly publishedAt: null;
  readonly sourceSlug: string;
  readonly targetSlug: string;
  readonly targetPostId: number | null;
  readonly categories: readonly string[];
  readonly tags: readonly string[];
  readonly imageCount: number;
  readonly importedImageCount: number;
  readonly hasSeoMeta: boolean;
  readonly sanitizedBody: RestrictedRichTextDoc;
  readonly sanitizedSeo: PageSeoOverrides | null;
}

export interface WpImportReport {
  readonly jobId: string;
  readonly mode: WpImportMode;
  readonly sourceKind: WpImportSourceKind;
  readonly sourceLabel: string;
  readonly status: WpImportJobStatus;
  readonly draftOnlyEnforced: true;
  readonly counts: {
    readonly postsFound: number;
    readonly postsImported: number;
    readonly postsSkipped: number;
    readonly categoriesFound: number;
    readonly categoriesImported: number;
    readonly tagsFound: number;
    readonly tagsImported: number;
    readonly imagesFound: number;
    readonly imagesImported: number;
    readonly imagesSkipped: number;
    readonly imagesBlocked: number;
    readonly bytesImported: number;
  };
  readonly quota: {
    readonly quotaBytes: number | null;
    readonly usedBytesBefore: number | null;
    readonly usedBytesAfter: number | null;
    readonly remainingBytesAfter: number | null;
    readonly exceeded: boolean;
  };
  readonly posts: readonly WpImportedPostSummary[];
  readonly media: readonly WpImportedMediaReportItem[];
  readonly formerUrls: readonly WpFormerUrlEntry[];
  readonly warnings: readonly WpImportWarning[];
  readonly createdAt: string;
  readonly completedAt: string;
}

export interface WpImportJobSummary {
  readonly id: string;
  readonly mode: WpImportMode;
  readonly sourceKind: WpImportSourceKind;
  readonly sourceLabel: string;
  readonly status: WpImportJobStatus;
  readonly actorUserId: string;
  readonly postsFound: number;
  readonly postsImported: number;
  readonly postsSkipped: number;
  readonly categoriesImported: number;
  readonly tagsImported: number;
  readonly imagesImported: number;
  readonly imagesSkipped: number;
  readonly bytesImported: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Injectable Runtime & Storage Ports (Zero Frozen-Core Coupling)
// ---------------------------------------------------------------------------

export type WpImporterFetchPort = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WpEncodedWebpResult {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/webp";
}

export type WpImporterWebpEncoderPort = (input: {
  readonly sourceBytes: Uint8Array;
  readonly sourceMime: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly maxEdgePx: number;
  readonly maxBytes: number;
}) => Promise<WpEncodedWebpResult>;

export interface WpQuotaSnapshot {
  readonly usedBytes: number;
  readonly reservedBytes: number;
  readonly quotaBytes: number;
  readonly availableBytes: number;
}

export interface WpImporterR2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string,
    options?: {
      readonly httpMetadata?: {
        readonly contentType?: string;
        readonly cacheControl?: string;
      };
      readonly customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

export interface WpStoreWebpAssetInput {
  readonly tenantId: string;
  readonly filename: string;
  readonly altText: string;
  readonly webpBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly nowMs: number;
  /** Optional extra encoded WebP variant payloads; ALL written bytes count against quota. */
  readonly extraVariants?: Readonly<
    Partial<
      Record<
        "w640" | "w1280" | "thumb" | "og",
        { readonly bytes: Uint8Array; readonly width: number; readonly height: number }
      >
    >
  >;
}

export type WpStoreWebpAssetResult =
  | {
      readonly ok: true;
      readonly mediaId: number;
      readonly r2Key: string;
      readonly bytes: number;
      readonly variants?: MediaVariantsManifest;
    }
  | {
      readonly ok: false;
      readonly code: "STORAGE_QUOTA_EXCEEDED" | "INVALID_R2_KEY" | "STORAGE_ERROR";
      readonly message: string;
    };

export interface WpImporterMediaStoragePort {
  readonly getQuotaSnapshot: () => Promise<WpQuotaSnapshot>;
  readonly storeWebpAsset: (input: WpStoreWebpAssetInput) => Promise<WpStoreWebpAssetResult>;
}

export interface WpCreateDraftPostInput {
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string | null;
  readonly body: RestrictedRichTextDoc;
  readonly coverMediaId: number | null;
  readonly primaryCategoryId: number | null;
  readonly categoryIds: readonly number[];
  readonly tagIds: readonly number[];
  readonly seo: PageSeoOverrides | null;
  readonly status: "draft";
  readonly nowMs: number;
}

export interface WpCreatedDraftPostResult {
  readonly id: number;
  readonly slug: string;
  readonly status: "draft";
  readonly publishedAt: null;
}

export interface WpImporterCmsWriterPort {
  readonly ensureCategory: (input: {
    readonly name: string;
    readonly slug: string;
    readonly description: string | null;
    readonly parentId: number | null;
    readonly nowMs: number;
  }) => Promise<{ readonly id: number; readonly slug: string; readonly created: boolean }>;
  readonly ensureTag: (input: {
    readonly name: string;
    readonly slug: string;
    readonly description: string | null;
    readonly nowMs: number;
  }) => Promise<{ readonly id: number; readonly slug: string; readonly created: boolean }>;
  readonly createDraftPost: (input: WpCreateDraftPostInput) => Promise<WpCreatedDraftPostResult>;
}

export interface WpImportRequestInput {
  readonly mode: WpImportMode;
  readonly sourceKind: WpImportSourceKind;
  readonly siteUrl?: string;
  readonly wxrXml?: string;
  readonly importImages?: boolean;
  readonly maxPosts?: number;
  readonly allowHttp?: boolean;
}

export interface WpImporterExecutionDeps {
  readonly tenant: PluginTenantSnapshot;
  readonly actorUserId: string;
  readonly db?: PluginTenantDb;
  readonly fetchImpl?: WpImporterFetchPort;
  readonly imagesBinding?: CloudflareImagesBinding | null;
  readonly webpEncoder?: WpImporterWebpEncoderPort;
  readonly mediaPort?: WpImporterMediaStoragePort;
  readonly cmsWriter?: WpImporterCmsWriterPort;
  /**
   * Explicit opt-in for staged-only fallback (`plg_wp_importer__staged_drafts`) when no
   * real CMS writer is attached. Defaults to `false` (fail closed with `CMS_WRITER_UNAVAILABLE`
   * instead of silently claiming posts were imported into the CMS!).
   */
  readonly allowStagedFallback?: boolean;
  readonly nowMs?: number;
}

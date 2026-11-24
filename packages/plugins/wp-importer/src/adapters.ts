import {
  assertTenantR2Key,
  buildMediaDerivativeKeys,
  type CloudflareImagesBinding,
} from "@punyasitus/core/media/index";
import type { TenantStatus } from "@punyasitus/core/schemas";
import { SlugValidationError } from "@punyasitus/core/slug/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  createMediaUploadIntent,
  failMediaUploadIntent,
  finalizeProcessedMediaAtomically,
  markUploadIntentQuarantinedAndCreateMedia,
} from "@punyasitus/db/media/index";
import {
  createBlogTaxonomy,
  createPost,
  listBlogTaxonomies,
} from "@punyasitus/db/posts/index";
import { getStorageUsageSnapshot } from "@punyasitus/db/storage-usage/index";
import type {
  WpImporterCmsWriterPort,
  WpImporterMediaStoragePort,
  WpImporterR2BucketLike,
} from "./types.ts";

/**
 * Default Production & Workerd Runtime Adapters for `wp-importer`
 * (`TASK-100`, `REQ-100`, `ADR-0010`).
 *
 * Strictly reuses Frozen Core's public `@punyasitus/db` & `@punyasitus/core` exports
 * WITHOUT modifying any Frozen Core file:
 * - `createDefaultCmsWriter`: writes real unpublished `draft` rows (`status = 'draft'`,
 *   `published_at = NULL`, `published_body_json = NULL`) into `posts`, `taxonomies`,
 *   `post_taxonomies`, and `resource_slugs` inside the tenant's isolated `TenantStore`.
 * - `createDefaultMediaPort`: enforces real `storage_usage` quota accounting across ALL
 *   written R2 bytes (master + any variants), writes WebP objects under tenant-scoped keys
 *   `t/<tenantId>/media/...`, finalizes `media_items` atomically, and deletes any uploaded
 *   R2 objects + releases `reserved_bytes` via `failMediaUploadIntent` on failure!
 */

export interface WorkersRuntimeEnvLike {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
  readonly MEDIA_BUCKET?: WpImporterR2BucketLike | null;
  readonly IMAGES?: unknown;
}

const VALID_TENANT_STATUSES = new Set<TenantStatus>([
  "trial",
  "active",
  "grace",
  "locked",
  "suspended",
  "recovery",
  "purging",
  "purged",
]);

function normalizeTenantStatus(raw: string): TenantStatus {
  return VALID_TENANT_STATUSES.has(raw as TenantStatus) ? (raw as TenantStatus) : "trial";
}

function isCloudflareImagesBinding(candidate: unknown): candidate is CloudflareImagesBinding {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as { readonly input?: unknown }).input === "function"
  );
}

/**
 * Safely resolves Cloudflare Workers runtime `env` (`TENANT_STORE`, `MEDIA_BUCKET`, `IMAGES`)
 * when running inside Cloudflare `workerd` / production Workers, returning `null` cleanly
 * inside plain Node unit-test environments where `cloudflare:workers` is unavailable.
 */
export async function tryLoadWorkersRuntimeEnv(): Promise<WorkersRuntimeEnvLike | null> {
  try {
    const mod = (await import("cloudflare:workers")) as {
      readonly env?: WorkersRuntimeEnvLike;
    };
    return mod?.env ?? null;
  } catch {
    return null;
  }
}

export interface DefaultCmsWriterOptions {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly tenantDb?: D1Database | null;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
}

/**
 * Builds the default CMS writer backed by the tenant's isolated `TenantStore`
 * (`@punyasitus/db/posts/index`). Guarantees strictly `draft` creation (`publishedAt: null`).
 */
export function createDefaultCmsWriter(
  options: DefaultCmsWriterOptions,
): WpImporterCmsWriterPort | null {
  const tenantDb =
    options.tenantDb ??
    (options.tenantStore
      ? createTenantDb(openTenantStoreStub(options.tenantStore, options.tenantId))
      : null);

  if (!tenantDb) {
    return null;
  }

  return {
    async ensureCategory({ name, slug, description, parentId, nowMs }) {
      const existing = await listBlogTaxonomies(tenantDb, { kind: "post_category", limit: 100 });
      const found = existing.items.find((c) => c.slug === slug);
      if (found) {
        return { id: found.id, slug: found.slug, created: false };
      }
      const created = await createBlogTaxonomy(tenantDb, {
        kind: "post_category",
        name,
        slug,
        description,
        parentId,
        nowMs,
      });
      return { id: created.id, slug: created.slug, created: true };
    },
    async ensureTag({ name, slug, description, nowMs }) {
      const existing = await listBlogTaxonomies(tenantDb, { kind: "post_tag", limit: 100 });
      const found = existing.items.find((t) => t.slug === slug);
      if (found) {
        return { id: found.id, slug: found.slug, created: false };
      }
      const created = await createBlogTaxonomy(tenantDb, {
        kind: "post_tag",
        name,
        slug,
        description,
        nowMs,
      });
      return { id: created.id, slug: created.slug, created: true };
    },
    async createDraftPost(input) {
      const attemptCreate = async (slugToUse: string) =>
        createPost(
          tenantDb,
          {
            title: input.title,
            slug: slugToUse,
            excerpt: input.excerpt,
            body: input.body,
            coverMediaId: input.coverMediaId,
            primaryCategoryId: input.primaryCategoryId,
            categoryIds: input.categoryIds,
            tagIds: input.tagIds,
            seo: input.seo ?? undefined,
            nowMs: input.nowMs,
          },
          { actorUserId: options.actorUserId },
        );

      let created;
      try {
        created = await attemptCreate(input.slug);
      } catch (err) {
        if (err instanceof SlugValidationError && err.code === "SLUG_CONFLICT" && err.suggestedSlug) {
          created = await attemptCreate(err.suggestedSlug);
        } else {
          throw err;
        }
      }

      return {
        id: created.id,
        slug: created.slug,
        status: "draft",
        publishedAt: null,
      };
    },
  };
}

export interface DefaultMediaPortOptions {
  readonly tenantId: string;
  readonly tenantStatus: string;
  readonly tenantDb?: D1Database | null;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly mediaBucket?: WpImporterR2BucketLike | null;
  readonly nowMs?: number;
}

/**
 * Builds the default R2 + TenantStore Media & Quota storage port.
 *
 * Guarantees:
 * - Accounts for 100% of bytes written to R2 (master + every optional variant) against
 *   `storage_usage.quota_bytes` BEFORE writing any R2 object.
 * - Cleans up ALL uploaded R2 keys AND calls `failMediaUploadIntent` (releasing `reserved_bytes`)
 *   if any upload or DB finalization step fails — zero orphan R2 objects and zero quota leaks!
 */
export function createDefaultMediaPort(
  options: DefaultMediaPortOptions,
): WpImporterMediaStoragePort | null {
  const tenantDb =
    options.tenantDb ??
    (options.tenantStore
      ? createTenantDb(openTenantStoreStub(options.tenantStore, options.tenantId))
      : null);
  const mediaBucket = options.mediaBucket ?? null;

  if (!tenantDb || !mediaBucket) {
    return null;
  }

  const tenantStatus = normalizeTenantStatus(options.tenantStatus);

  return {
    async getQuotaSnapshot() {
      const snap = await getStorageUsageSnapshot(tenantDb, {
        tenantStatus,
        nowMs: options.nowMs ?? Date.now(),
      });
      return {
        usedBytes: snap.usedBytes,
        reservedBytes: snap.reservedBytes,
        quotaBytes: snap.quotaBytes,
        availableBytes: snap.availableBytes,
      };
    },

    async storeWebpAsset(asset) {
      // Calculate exact total R2 bytes across master + any distinct extra variant payloads
      const extra = asset.extraVariants ?? {};
      let totalBytesToStore = asset.webpBytes.byteLength;
      if (extra.w640) totalBytesToStore += extra.w640.bytes.byteLength;
      if (extra.w1280) totalBytesToStore += extra.w1280.bytes.byteLength;
      if (extra.thumb) totalBytesToStore += extra.thumb.bytes.byteLength;
      if (extra.og) totalBytesToStore += extra.og.bytes.byteLength;

      // 1. Atomically reserve FULL totalBytesToStore in `storage_usage` BEFORE writing R2
      const intentRes = await createMediaUploadIntent(tenantDb, {
        tenantId: options.tenantId,
        tenantStatus,
        filename: asset.filename,
        declaredMime: "image/webp",
        declaredBytes: totalBytesToStore,
        declaredSha256: asset.sha256,
        altText: asset.altText,
        nowMs: asset.nowMs,
      });

      if (!intentRes.ok) {
        return {
          ok: false,
          code:
            intentRes.code === "STORAGE_QUOTA_EXCEEDED"
              ? "STORAGE_QUOTA_EXCEEDED"
              : "STORAGE_ERROR",
          message: intentRes.message,
        };
      }

      const intentId = intentRes.intent.id;
      const uploadedKeys: string[] = [];

      const compensate = async (errorCode: string) => {
        for (const key of uploadedKeys) {
          try {
            await mediaBucket.delete(key);
          } catch {
            // Best-effort orphan cleanup
          }
        }
        try {
          await failMediaUploadIntent(tenantDb, intentId, errorCode, asset.nowMs);
        } catch {
          // Best-effort reservation release
        }
      };

      try {
        const quarantined = await markUploadIntentQuarantinedAndCreateMedia(tenantDb, {
          tenantId: options.tenantId,
          intentId,
          quarantineR2Key: intentRes.intent.quarantineR2Key,
          detectedMime: "image/webp",
          sha256: asset.sha256,
          width: asset.width,
          height: asset.height,
          nowMs: asset.nowMs,
        });

        if (!quarantined.ok) {
          await compensate(quarantined.code);
          return { ok: false, code: "STORAGE_ERROR", message: quarantined.message };
        }

        const keys = buildMediaDerivativeKeys(
          options.tenantId,
          quarantined.mediaId,
          asset.filename,
        );
        assertTenantR2Key(options.tenantId, keys.master, ["media"]);

        const r2HttpMeta = {
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000, immutable",
        };

        // Upload master WebP object
        await mediaBucket.put(keys.master, new Uint8Array(asset.webpBytes), {
          httpMetadata: r2HttpMeta,
        });
        uploadedKeys.push(keys.master);

        // Upload optional distinct variants (if supplied) & point non-distinct slots to `keys.master`
        // so `storage_usage.used_bytes` equals 100% of actual R2 bytes written!
        const resolveVariant = async (
          slotKey: string,
          payload:
            | { readonly bytes: Uint8Array; readonly width: number; readonly height: number }
            | undefined,
          fallbackW: number,
          fallbackH: number,
        ) => {
          if (payload) {
            assertTenantR2Key(options.tenantId, slotKey, ["media"]);
            await mediaBucket.put(slotKey, new Uint8Array(payload.bytes), {
              httpMetadata: r2HttpMeta,
            });
            uploadedKeys.push(slotKey);
            return {
              key: slotKey,
              width: payload.width,
              height: payload.height,
              bytes: payload.bytes.byteLength,
              mimeType: "image/webp" as const,
            };
          }
          return {
            key: keys.master,
            width: Math.min(fallbackW, asset.width),
            height: Math.min(fallbackH, asset.height),
            bytes: asset.webpBytes.byteLength,
            mimeType: "image/webp" as const,
          };
        };

        const variants = {
          slug: intentRes.intent.slug,
          master: {
            key: keys.master,
            width: asset.width,
            height: asset.height,
            bytes: asset.webpBytes.byteLength,
            mimeType: "image/webp" as const,
          },
          w640: await resolveVariant(keys.w640, extra.w640, 640, 640),
          w1280: await resolveVariant(keys.w1280, extra.w1280, 1280, 1280),
          thumb: await resolveVariant(keys.thumb, extra.thumb, 320, 320),
          og: await resolveVariant(keys.og, extra.og, 1200, 630),
        };

        const finalized = await finalizeProcessedMediaAtomically(tenantDb, {
          tenantId: options.tenantId,
          mediaId: quarantined.mediaId,
          intentId,
          masterR2Key: keys.master,
          normalizedMasterBytes: totalBytesToStore,
          masterSha256: asset.sha256,
          masterWidth: asset.width,
          masterHeight: asset.height,
          variants,
          nowMs: asset.nowMs,
        });

        if (!finalized.ok) {
          await compensate(finalized.code);
          return {
            ok: false,
            code:
              finalized.code === "STORAGE_QUOTA_EXCEEDED"
                ? "STORAGE_QUOTA_EXCEEDED"
                : finalized.code === "INVALID_R2_KEY"
                  ? "INVALID_R2_KEY"
                  : "STORAGE_ERROR",
            message: finalized.message,
          };
        }

        return {
          ok: true,
          mediaId: quarantined.mediaId,
          r2Key: keys.master,
          bytes: totalBytesToStore,
          variants,
        };
      } catch (err) {
        await compensate("MEDIA_UPLOAD_FAILED");
        return {
          ok: false,
          code: "STORAGE_ERROR",
          message:
            err instanceof Error
              ? err.message
              : "Gagal menyimpan aset WebP ke R2; reservasi kuota telah dilepaskan.",
        };
      }
    },
  };
}

export async function resolveDefaultRuntimeBindings(input: {
  readonly tenantId: string;
  readonly tenantStatus: string;
  readonly actorUserId: string;
  readonly nowMs: number;
  readonly runtimeEnv?: WorkersRuntimeEnvLike | null;
}): Promise<{
  readonly cmsWriter: WpImporterCmsWriterPort | undefined;
  readonly mediaPort: WpImporterMediaStoragePort | undefined;
  readonly imagesBinding: CloudflareImagesBinding | null;
}> {
  const envObj = input.runtimeEnv !== undefined ? input.runtimeEnv : await tryLoadWorkersRuntimeEnv();
  if (!envObj) {
    return { cmsWriter: undefined, mediaPort: undefined, imagesBinding: null };
  }

  const tenantDb = envObj.TENANT_STORE
    ? createTenantDb(openTenantStoreStub(envObj.TENANT_STORE, input.tenantId))
    : null;

  const cmsWriter =
    createDefaultCmsWriter({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      tenantDb,
    }) ?? undefined;

  const mediaPort =
    createDefaultMediaPort({
      tenantId: input.tenantId,
      tenantStatus: input.tenantStatus,
      tenantDb,
      mediaBucket: envObj.MEDIA_BUCKET ?? null,
      nowMs: input.nowMs,
    }) ?? undefined;

  const imagesBinding = isCloudflareImagesBinding(envObj.IMAGES) ? envObj.IMAGES : null;

  return { cmsWriter, mediaPort, imagesBinding };
}

import {
  BRAND_ASSET_DERIVATION_SPECS,
  buildBrandAssetDerivativeKeys,
  shouldAutoDeriveBrandAssetSlot,
  type DerivedBrandAssetEntry,
} from "@punyasitus/core/business-profile/index";
import { NonRetryableJobError } from "@punyasitus/core/jobs/index";
import {
  assertTenantR2Key,
  inspectImageBinary,
  MAX_NORMALIZED_MASTER_BYTES,
  readBoundedStream,
  type CloudflareImagesBinding,
} from "@punyasitus/core/media/index";
import {
  applyAutoDerivedBrandAssets,
  getBrandAssetDerivationState,
  type BrandAssetsAdminDto,
} from "@punyasitus/db/business-profile/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { getMediaItemById } from "@punyasitus/db/media/index";
import type { DurableJobHandler, DurableQueueEnv, JobExecutionContext } from "../consumer.ts";
import type { MediaWorkerR2BucketLike } from "./index.ts";
import { generateOgDerivative } from "./og.ts";

/**
 * Logo Auto-Derived Brand Assets Pipeline
 * (`apps/web/src/worker/queues/media/brand-assets.ts`; REQ-091, REQ-010, PLAN §7.3, §19.5; TASK-091).
 *
 * When a tenant uploads or selects a site logo, automatically derives:
 * - `32x32` WebP favicon
 * - `180x180` WebP apple-touch-icon
 * - `1200x630` WebP default OG image (`<= 300 KiB` / `307_200` bytes)
 *
 * CRITICAL INVARIANTS:
 * - ONLY fills UNSET default brand asset slots — NEVER overwrites explicit tenant overrides!
 * - Race-safe: stale logo jobs finishing after switching to a newer logo are safe 0-row no-ops!
 * - Strictly tenant-scoped R2 keys (`assertTenantR2Key`) with EXIF stripped (`metadata: "none"`, `anim: false`).
 */

export const MEDIA_DERIVE_BRAND_ASSETS_TOPIC = "media.derive_brand_assets" as const;

export interface DeriveBrandAssetsJobPayload {
  readonly logoMediaId: number;
  readonly originalFilename?: string;
}

export interface DeriveBrandAssetsFromLogoInput {
  readonly tenantId: string;
  readonly tenantDb: D1Database;
  readonly logoMediaId: number;
  readonly originalFilename?: string;
  /** Optional already-loaded source bytes (e.g. from `processImageMediaJob`). If omitted, reads normalized master from R2. */
  readonly sourceBytes?: Uint8Array;
  readonly images: CloudflareImagesBinding;
  readonly mediaBucket: MediaWorkerR2BucketLike;
  readonly nowMs?: number;
}

export interface DeriveBrandAssetsFromLogoResult {
  readonly status:
    | "derived"
    | "partial_override_preserved"
    | "skipped_all_overridden"
    | "skipped_stale_logo";
  readonly logoMediaId: number;
  readonly derivedFavicon32: DerivedBrandAssetEntry | null;
  readonly derivedAppleTouch180: DerivedBrandAssetEntry | null;
  readonly derivedOg1200x630: DerivedBrandAssetEntry | null;
  readonly preservedFaviconOverride: boolean;
  readonly preservedOgOverride: boolean;
  readonly brandAssets: BrandAssetsAdminDto;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

async function renderExactSquareIconWebp(
  images: CloudflareImagesBinding,
  sourceBytes: Uint8Array,
  size: 32 | 180,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number }> {
  const qualities = [86, 74, 60] as const;
  for (const quality of qualities) {
    const output = await images
      .input(bytesToStream(sourceBytes))
      .transform({
        width: size,
        height: size,
        fit: "contain",
        metadata: "none",
        anim: false,
      })
      .output({
        format: "image/webp",
        quality,
      });

    const read = await readBoundedStream(output.image(), maxBytes);
    if (!read.ok) {
      if (read.code === "PAYLOAD_TOO_LARGE") {
        continue;
      }
      throw new NonRetryableJobError(
        `Cloudflare Images returned an empty stream for ${size}x${size} favicon derivative.`,
        "E_BRAND_ICON_EMPTY",
      );
    }

    const inspected = inspectImageBinary(read.bytes, "image/webp");
    if (!inspected.ok || inspected.mimeType !== "image/webp") {
      throw new NonRetryableJobError(
        `Cloudflare Images returned non-WebP output for ${size}x${size} favicon derivative.`,
        "E_BRAND_ICON_INVALID_WEBP",
      );
    }
    if (inspected.width !== size || inspected.height !== size) {
      throw new NonRetryableJobError(
        `Favicon derivative dimensions (${inspected.width}x${inspected.height}) did not match required ${size}x${size}.`,
        "E_BRAND_ICON_DIMENSIONS",
      );
    }

    return {
      bytes: read.bytes,
      width: inspected.width,
      height: inspected.height,
    };
  }

  throw new NonRetryableJobError(
    `${size}x${size} favicon derivative could not fit within ${maxBytes} bytes.`,
    "E_BRAND_ICON_TOO_LARGE",
  );
}

/**
 * Generates and stores missing auto-derived brand assets (`32x32` favicon, `180x180`
 * apple-touch-icon, `1200x630 <= 300 KiB` default OG image) from a ready tenant logo image.
 * Strictly preserves explicit tenant favicon/OG overrides and safely no-ops stale logo jobs.
 */
export async function deriveBrandAssetsFromLogo(
  input: DeriveBrandAssetsFromLogoInput,
): Promise<DeriveBrandAssetsFromLogoResult> {
  const nowMs = input.nowMs ?? Date.now();
  const derivedAt = new Date(nowMs).toISOString();

  // 1. Check current active logo & explicit override state BEFORE running transforms or R2 writes!
  const currentState = await getBrandAssetDerivationState(input.tenantDb);

  if (
    currentState.sourceLogoMediaId !== null &&
    currentState.sourceLogoMediaId !== input.logoMediaId
  ) {
    return {
      status: "skipped_stale_logo",
      logoMediaId: input.logoMediaId,
      derivedFavicon32: null,
      derivedAppleTouch180: null,
      derivedOg1200x630: null,
      preservedFaviconOverride: currentState.faviconOverrideMediaId !== null,
      preservedOgOverride: currentState.ogImageOverrideMediaId !== null,
      brandAssets: currentState,
    };
  }

  const needsFavicon = shouldAutoDeriveBrandAssetSlot(currentState.faviconOverrideMediaId);
  const needsOgImage = shouldAutoDeriveBrandAssetSlot(currentState.ogImageOverrideMediaId);

  if (!needsFavicon && !needsOgImage) {
    return {
      status: "skipped_all_overridden",
      logoMediaId: input.logoMediaId,
      derivedFavicon32: null,
      derivedAppleTouch180: null,
      derivedOg1200x630: null,
      preservedFaviconOverride: true,
      preservedOgOverride: true,
      brandAssets: currentState,
    };
  }

  // 2. Verify logo media record belongs to this tenant and is a ready image
  const media = await getMediaItemById(input.tenantDb, input.logoMediaId);
  if (!media || media.kind !== "image" || media.dbStatus !== "ready" || media.deletedAt !== null) {
    throw new NonRetryableJobError(
      `Logo media #${input.logoMediaId} is not a ready image in this tenant.`,
      "E_LOGO_MEDIA_NOT_READY",
    );
  }

  // 3. Obtain source image bytes (either provided directly or loaded from tenant-scoped R2 master)
  let sourceBytes: Uint8Array;
  if (input.sourceBytes && input.sourceBytes.byteLength > 0) {
    sourceBytes = input.sourceBytes;
  } else {
    const masterKey = assertTenantR2Key(input.tenantId, media.r2Key, ["media"]);
    const obj = await input.mediaBucket.get(masterKey);
    if (!obj) {
      throw new NonRetryableJobError(
        `Logo master object "${masterKey}" not found in R2.`,
        "E_LOGO_R2_MISSING",
      );
    }
    const read = await readBoundedStream(obj.body, MAX_NORMALIZED_MASTER_BYTES);
    if (!read.ok) {
      throw new NonRetryableJobError(read.message, `E_${read.code}`);
    }
    sourceBytes = read.bytes;
  }

  const filename = input.originalFilename || media.originalFilename || media.slug || "logo";
  const keys = buildBrandAssetDerivativeKeys(input.tenantId, input.logoMediaId, filename);

  let derivedFavicon32: DerivedBrandAssetEntry | null = null;
  let derivedAppleTouch180: DerivedBrandAssetEntry | null = null;
  let derivedOg1200x630: DerivedBrandAssetEntry | null = null;

  const putOpts = (variant: string): R2PutOptions => ({
    httpMetadata: {
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      tenantId: input.tenantId,
      logoMediaId: String(input.logoMediaId),
      variant,
      exifStripped: "true",
      autoDerivedFromLogo: "true",
    },
  });

  // 4. Derive 32x32 favicon & 180x180 apple-touch-icon ONLY if favicon override is unset
  if (needsFavicon) {
    const icon32 = await renderExactSquareIconWebp(
      input.images,
      sourceBytes,
      BRAND_ASSET_DERIVATION_SPECS.favicon32.width,
      BRAND_ASSET_DERIVATION_SPECS.favicon32.maxBytes,
    );
    const icon180 = await renderExactSquareIconWebp(
      input.images,
      sourceBytes,
      BRAND_ASSET_DERIVATION_SPECS.appleTouch180.width,
      BRAND_ASSET_DERIVATION_SPECS.appleTouch180.maxBytes,
    );

    await input.mediaBucket.put(keys.favicon32, icon32.bytes, putOpts("brand_favicon_32"));
    await input.mediaBucket.put(keys.appleTouch180, icon180.bytes, putOpts("brand_apple_touch_180"));

    derivedFavicon32 = {
      key: keys.favicon32,
      width: icon32.width,
      height: icon32.height,
      bytes: icon32.bytes.byteLength,
      mimeType: "image/webp",
      sourceLogoMediaId: input.logoMediaId,
      derivedAt,
    };
    derivedAppleTouch180 = {
      key: keys.appleTouch180,
      width: icon180.width,
      height: icon180.height,
      bytes: icon180.bytes.byteLength,
      mimeType: "image/webp",
      sourceLogoMediaId: input.logoMediaId,
      derivedAt,
    };
  }

  // 5. Derive 1200x630 (<= 300 KiB) default OG image ONLY if OG override is unset
  if (needsOgImage) {
    const ogRes = await generateOgDerivative(input.images, sourceBytes, {
      maxBytes: BRAND_ASSET_DERIVATION_SPECS.og1200x630.maxBytes,
    });
    if (!ogRes.ok) {
      throw new NonRetryableJobError(ogRes.message, `E_${ogRes.code}`);
    }

    await input.mediaBucket.put(keys.og1200x630, ogRes.bytes, putOpts("brand_og_1200x630"));
    derivedOg1200x630 = {
      key: keys.og1200x630,
      width: ogRes.width,
      height: ogRes.height,
      bytes: ogRes.byteLength,
      mimeType: "image/webp",
      sourceLogoMediaId: input.logoMediaId,
      derivedAt,
    };
  }

  // 6. Atomically persist derived assets guarded in SQL on active logo match + IS NULL overrides
  const persisted = await applyAutoDerivedBrandAssets(input.tenantDb, {
    sourceLogoMediaId: input.logoMediaId,
    favicon32: derivedFavicon32,
    appleTouch180: derivedAppleTouch180,
    og1200x630: derivedOg1200x630,
    nowMs,
  });

  if (persisted.staleLogoSkipped && !persisted.appliedFavicon && !persisted.appliedOgImage) {
    return {
      status: "skipped_stale_logo",
      logoMediaId: input.logoMediaId,
      derivedFavicon32: null,
      derivedAppleTouch180: null,
      derivedOg1200x630: null,
      preservedFaviconOverride: persisted.preservedFaviconOverride,
      preservedOgOverride: persisted.preservedOgOverride,
      brandAssets: persisted.brandAssets,
    };
  }

  const status =
    !persisted.appliedFavicon && !persisted.appliedOgImage
      ? "skipped_all_overridden"
      : persisted.preservedFaviconOverride || persisted.preservedOgOverride
        ? "partial_override_preserved"
        : "derived";

  return {
    status,
    logoMediaId: input.logoMediaId,
    derivedFavicon32: persisted.appliedFavicon ? derivedFavicon32 : null,
    derivedAppleTouch180: persisted.appliedFavicon ? derivedAppleTouch180 : null,
    derivedOg1200x630: persisted.appliedOgImage ? derivedOg1200x630 : null,
    preservedFaviconOverride: persisted.preservedFaviconOverride,
    preservedOgOverride: persisted.preservedOgOverride,
    brandAssets: persisted.brandAssets,
  };
}

export interface CreateBrandAssetsQueueHandlerOptions {
  readonly images?: CloudflareImagesBinding;
  readonly mediaBucket?: MediaWorkerR2BucketLike;
  readonly resolveTenantDb?: (tenantId: string, env: DurableQueueEnv) => D1Database;
  readonly maxAttempts?: number;
  readonly leaseDurationMs?: number;
}

/**
 * Creates a `DurableJobHandler` for `media.derive_brand_assets` compatible with
 * `processDurableQueueBatch`.
 */
export function createBrandAssetsQueueHandler(
  options: CreateBrandAssetsQueueHandlerOptions = {},
): DurableJobHandler {
  return {
    maxAttempts: options.maxAttempts ?? 3,
    leaseDurationMs: options.leaseDurationMs ?? 60_000,
    async execute(ctx: JobExecutionContext): Promise<void> {
      const tenantId = ctx.tenantId?.trim();
      if (!tenantId) {
        throw new NonRetryableJobError(
          "media.derive_brand_assets requires a non-empty tenantId.",
          "E_MISSING_TENANT_ID",
        );
      }

      const logoMediaId =
        typeof ctx.payload.logoMediaId === "number"
          ? ctx.payload.logoMediaId
          : Number(ctx.payload.logoMediaId);
      if (!Number.isInteger(logoMediaId) || logoMediaId < 1) {
        throw new NonRetryableJobError(
          "media.derive_brand_assets requires a positive integer logoMediaId.",
          "E_INVALID_LOGO_MEDIA_ID",
        );
      }

      const originalFilename =
        typeof ctx.payload.originalFilename === "string"
          ? ctx.payload.originalFilename.trim()
          : undefined;

      const mediaBucket =
        options.mediaBucket ?? (ctx.env.MEDIA_BUCKET as MediaWorkerR2BucketLike | undefined);
      if (!mediaBucket) {
        throw new Error("MEDIA_BUCKET binding is unavailable");
      }

      const images =
        options.images ?? (ctx.env.IMAGES as CloudflareImagesBinding | undefined);
      if (!images || typeof images.input !== "function") {
        throw new Error("IMAGES binding is unavailable");
      }

      let tenantDb: D1Database;
      if (options.resolveTenantDb) {
        tenantDb = options.resolveTenantDb(tenantId, ctx.env);
      } else {
        const ns = ctx.env.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined;
        if (!ns) {
          throw new Error("TENANT_STORE binding is unavailable");
        }
        tenantDb = createTenantDb(openTenantStoreStub(ns, tenantId));
      }

      await deriveBrandAssetsFromLogo({
        tenantId,
        tenantDb,
        logoMediaId,
        originalFilename,
        images,
        mediaBucket,
        nowMs: ctx.nowMs,
      });
    },
  };
}

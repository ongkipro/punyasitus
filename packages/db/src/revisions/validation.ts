import {
  projectToPublicOfferingAttributes,
  validateOfferingInput,
  type CatalogDescription,
  type CatalogOfferingAttributes,
  type CatalogOfferingType,
  type ValidatedOfferingDraftInput,
} from "@punyasitus/core/catalog/index";
import {
  assertNoForbiddenTenantSelectors,
  PublicationValidationError,
  renderRichTextDocToSanitizedHtml,
  serializeDraftStoragePayload,
  type OfferingSnapshot,
  type PageSnapshot,
  type PostSnapshot,
  type RestrictedRichTextDoc,
} from "@punyasitus/core/content/index";
import { calculateLinearReadingTimeMinutes } from "@punyasitus/core/posts/index";
import { extractMediaIdsFromJsonValue } from "../trash/references.ts";
import {
  CURRENT_REVISION_SCHEMA_VERSION,
  isRevisionTriggerKind,
  MAX_CONTENT_REVISIONS_PER_RESOURCE,
  RevisionSchemaUnsupportedError,
  RevisionValidationError,
  type RevisionReferenceReport,
  type RevisionReferenceWarning,
  type RevisionResourceType,
  type RevisionTriggerKind,
  type RevisionValidationField,
} from "./types.ts";

/**
 * Pure revision retention math, snapshot envelope serialization/validation,
 * and missing-reference sanitization helpers (`packages/db/src/revisions/validation.ts`;
 * TASK-064, REQ-048, PLAN §5 & §11.5).
 */

/**
 * Sensitive/forbidden keys stripped defensively before persisting revision snapshots
 * so revisions never store lead data, secrets, or full user records (PLAN §11.5).
 */
const STRIPPED_SENSITIVE_KEYS = new Set<string>([
  "password",
  "passwordHash",
  "password_hash",
  "secret",
  "apiKey",
  "api_key",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "sessionToken",
  "session_token",
  "twoFactorSecret",
  "two_factor_secret",
  "leadId",
  "lead_id",
  "leads",
  "phone_e164",
  "phoneE164",
  "writeToken",
]);

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function deepStripSensitiveKeys(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepStripSensitiveKeys(item));
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (STRIPPED_SENSITIVE_KEYS.has(key)) continue;
    out[key] = deepStripSensitiveKeys(nested);
  }
  return out;
}

/**
 * Pure retention calculation proving exact latest-N (default 20) revision retention.
 */
export function computeRetainedRevisionNumbers(
  revisionNumbers: readonly number[],
  maxRetained: number = MAX_CONTENT_REVISIONS_PER_RESOURCE,
): {
  readonly keep: readonly number[];
  readonly prune: readonly number[];
} {
  const cap = Math.max(1, Math.floor(maxRetained));
  const sortedDesc = [...new Set(revisionNumbers.filter((n) => Number.isSafeInteger(n) && n >= 1))].sort(
    (a, b) => b - a,
  );
  return {
    keep: sortedDesc.slice(0, cap),
    prune: sortedDesc.slice(cap),
  };
}

export function buildRevisionSummaryText(params: {
  readonly resourceType: RevisionResourceType;
  readonly triggerKind: RevisionTriggerKind;
  readonly title?: string | null;
  readonly slug?: string | null;
  readonly restoredFromRevisionNumber?: number | null;
}): string {
  const titleLabel = params.title?.trim() ? `"${params.title.trim().slice(0, 80)}"` : "tanpa judul";
  const pathHint = params.slug?.trim()
    ? params.resourceType === "post"
      ? ` (/blog/${params.slug.trim()})`
      : ` (/${params.slug.trim()})`
    : "";

  if (params.triggerKind === "publish") {
    return `Terbitkan ${titleLabel}${pathHint}`;
  }
  if (params.triggerKind === "restore") {
    const fromLabel =
      params.restoredFromRevisionNumber !== undefined && params.restoredFromRevisionNumber !== null
        ? ` dari revisi #${params.restoredFromRevisionNumber}`
        : "";
    return `Pulihkan${fromLabel} sebagai draf (${titleLabel})`;
  }
  return `Simpan draf ${titleLabel}${pathHint}`;
}

export interface RevisionSnapshotEnvelope {
  readonly snapshotVersion: typeof CURRENT_REVISION_SCHEMA_VERSION;
  readonly schemaVersion: typeof CURRENT_REVISION_SCHEMA_VERSION;
  readonly resourceType: RevisionResourceType;
  readonly triggerKind: RevisionTriggerKind;
  readonly summary: string;
  readonly data: Record<string, unknown>;
}

export function buildRevisionSnapshotEnvelope(params: {
  readonly resourceType: RevisionResourceType;
  readonly triggerKind: RevisionTriggerKind;
  readonly data: Record<string, unknown>;
  readonly summary?: string;
}): { readonly json: string; readonly summary: string; readonly schemaVersion: number } {
  const title = typeof params.data.title === "string" ? params.data.title : null;
  const slug = typeof params.data.slug === "string" ? params.data.slug : null;
  const summary =
    params.summary?.trim() ||
    buildRevisionSummaryText({
      resourceType: params.resourceType,
      triggerKind: params.triggerKind,
      title,
      slug,
    });

  const cleanData = deepStripSensitiveKeys(params.data) as Record<string, unknown>;

  const envelope: RevisionSnapshotEnvelope = {
    snapshotVersion: CURRENT_REVISION_SCHEMA_VERSION,
    schemaVersion: CURRENT_REVISION_SCHEMA_VERSION,
    resourceType: params.resourceType,
    triggerKind: params.triggerKind,
    summary,
    data: cleanData,
  };

  return {
    json: JSON.stringify(envelope),
    summary,
    schemaVersion: CURRENT_REVISION_SCHEMA_VERSION,
  };
}

export interface ExtractedRevisionMetadata {
  readonly schemaVersion: number;
  readonly triggerKind: RevisionTriggerKind;
  readonly summary: string | null;
  readonly title: string | null;
  readonly slug: string | null;
}

export function extractRevisionMetadataFromJson(
  rawSnapshotJson: string,
  fallback: {
    readonly resourceType: RevisionResourceType;
    readonly rowTriggerKind?: string | null;
    readonly rowSchemaVersion?: number | null;
    readonly rowSummary?: string | null;
    readonly fallbackTitle?: string | null;
    readonly fallbackSlug?: string | null;
  },
): ExtractedRevisionMetadata {
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate: unknown = JSON.parse(rawSnapshotJson);
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }

  const data =
    parsed?.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
      ? (parsed.data as Record<string, unknown>)
      : parsed;

  const schemaVersion =
    typeof fallback.rowSchemaVersion === "number" && Number.isSafeInteger(fallback.rowSchemaVersion)
      ? fallback.rowSchemaVersion
      : typeof parsed?.schemaVersion === "number" && Number.isSafeInteger(parsed.schemaVersion)
        ? parsed.schemaVersion
        : typeof parsed?.snapshotVersion === "number" && Number.isSafeInteger(parsed.snapshotVersion)
          ? parsed.snapshotVersion
          : CURRENT_REVISION_SCHEMA_VERSION;

  const triggerKind: RevisionTriggerKind = isRevisionTriggerKind(fallback.rowTriggerKind)
    ? fallback.rowTriggerKind
    : isRevisionTriggerKind(parsed?.triggerKind)
      ? parsed.triggerKind
      : "publish";

  const title =
    typeof data?.title === "string" && data.title.trim()
      ? data.title.trim()
      : (fallback.fallbackTitle ?? null);
  const slug =
    typeof data?.slug === "string" && data.slug.trim()
      ? data.slug.trim()
      : (fallback.fallbackSlug ?? null);

  const summary =
    (typeof fallback.rowSummary === "string" && fallback.rowSummary.trim()
      ? fallback.rowSummary.trim()
      : null) ??
    (typeof parsed?.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : null) ??
    buildRevisionSummaryText({
      resourceType: fallback.resourceType,
      triggerKind,
      title,
      slug,
    });

  return {
    schemaVersion,
    triggerKind,
    summary,
    title,
    slug,
  };
}

export type ParsedValidatedRevisionSnapshot =
  | {
      readonly resourceType: "page";
      readonly schemaVersion: typeof CURRENT_REVISION_SCHEMA_VERSION;
      readonly triggerKind: RevisionTriggerKind;
      readonly data: PageSnapshot;
    }
  | {
      readonly resourceType: "post";
      readonly schemaVersion: typeof CURRENT_REVISION_SCHEMA_VERSION;
      readonly triggerKind: RevisionTriggerKind;
      readonly data: PostSnapshot;
    }
  | {
      readonly resourceType: "offering";
      readonly schemaVersion: typeof CURRENT_REVISION_SCHEMA_VERSION;
      readonly triggerKind: RevisionTriggerKind;
      readonly data: OfferingSnapshot;
      readonly validatedOffering: ValidatedOfferingDraftInput;
    };

/**
 * Strictly parses and validates a stored revision snapshot JSON payload against the
 * current schema version (`1`) and resource schema. Rejects corrupted JSON, unsupported
 * `schemaVersion`, mismatched `resourceType`, forbidden tenant selectors, or invalid fields
 * with HTTP 422 errors.
 */
export function validateAndParseRevisionSnapshot(
  resourceType: RevisionResourceType,
  rawSnapshotJson: string,
  options: {
    readonly rowSchemaVersion?: number | null;
    readonly rowTriggerKind?: string | null;
    readonly expectedOfferingType?: CatalogOfferingType | null;
    readonly tenantWhatsAppE164?: string | null;
  } = {},
): ParsedValidatedRevisionSnapshot {
  if (
    options.rowSchemaVersion !== undefined &&
    options.rowSchemaVersion !== null &&
    options.rowSchemaVersion !== CURRENT_REVISION_SCHEMA_VERSION
  ) {
    throw new RevisionSchemaUnsupportedError(
      `Versi skema revisi (${String(options.rowSchemaVersion)}) tidak didukung oleh sistem saat ini.`,
      options.rowSchemaVersion,
    );
  }

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(rawSnapshotJson);
  } catch {
    throw new RevisionValidationError("Snapshot revisi rusak dan tidak dapat diproses (JSON tidak valid).", [
      {
        field: "snapshot",
        code: "CORRUPTED_SNAPSHOT",
        message: "Revision snapshot_json is not valid JSON.",
      },
    ]);
  }

  if (!parsedUnknown || typeof parsedUnknown !== "object" || Array.isArray(parsedUnknown)) {
    throw new RevisionValidationError("Struktur snapshot revisi tidak valid.", [
      {
        field: "snapshot",
        code: "CORRUPTED_SNAPSHOT",
        message: "Revision snapshot must be a JSON object.",
      },
    ]);
  }

  const envelope = parsedUnknown as Record<string, unknown>;

  // Validate schemaVersion / snapshotVersion strictly
  const declaredSchemaVersion =
    envelope.schemaVersion !== undefined ? envelope.schemaVersion : envelope.snapshotVersion;
  if (declaredSchemaVersion === undefined) {
    throw new RevisionSchemaUnsupportedError(
      "Snapshot revisi tidak memiliki informasi versi skema yang valid.",
      undefined,
    );
  }
  if (declaredSchemaVersion !== CURRENT_REVISION_SCHEMA_VERSION) {
    throw new RevisionSchemaUnsupportedError(
      `Versi skema revisi (${String(declaredSchemaVersion)}) tidak didukung.`,
      declaredSchemaVersion,
    );
  }
  if (
    envelope.snapshotVersion !== undefined &&
    envelope.snapshotVersion !== CURRENT_REVISION_SCHEMA_VERSION
  ) {
    throw new RevisionSchemaUnsupportedError(
      `Versi snapshot revisi (${String(envelope.snapshotVersion)}) tidak didukung.`,
      envelope.snapshotVersion,
    );
  }

  if (envelope.resourceType !== undefined && envelope.resourceType !== resourceType) {
    throw new RevisionValidationError(
      `Tipe konten pada snapshot revisi ("${String(envelope.resourceType)}") tidak cocok dengan "${resourceType}".`,
      [
        {
          field: "resourceType",
          code: "RESOURCE_TYPE_MISMATCH",
          message: `Expected snapshot resourceType "${resourceType}".`,
        },
      ],
    );
  }

  const rawData = envelope.data;
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    throw new RevisionValidationError("Payload data pada snapshot revisi rusak atau kosong.", [
      {
        field: "snapshot.data",
        code: "CORRUPTED_SNAPSHOT",
        message: "Revision snapshot envelope is missing a valid data object.",
      },
    ]);
  }

  const dataRecord = rawData as Record<string, unknown>;
  try {
    assertNoForbiddenTenantSelectors(dataRecord);
  } catch (err) {
    if (err instanceof PublicationValidationError) {
      throw new RevisionValidationError(err.message, err.fields);
    }
    throw err;
  }

  const triggerKind: RevisionTriggerKind = isRevisionTriggerKind(options.rowTriggerKind)
    ? options.rowTriggerKind
    : isRevisionTriggerKind(envelope.triggerKind)
      ? envelope.triggerKind
      : "publish";

  if (resourceType === "page") {
    try {
      const serialized = serializeDraftStoragePayload("page", dataRecord);
      return {
        resourceType: "page",
        schemaVersion: CURRENT_REVISION_SCHEMA_VERSION,
        triggerKind,
        data: serialized.data,
      };
    } catch (err) {
      if (err instanceof PublicationValidationError) {
        throw new RevisionValidationError(
          `Snapshot revisi halaman tidak lolos validasi skema: ${err.message}`,
          err.fields,
        );
      }
      throw new RevisionValidationError("Snapshot revisi halaman tidak valid.", [
        { field: "snapshot", code: "INVALID_PAGE_SNAPSHOT", message: String(err) },
      ]);
    }
  }

  if (resourceType === "post") {
    try {
      const serialized = serializeDraftStoragePayload("post", dataRecord);
      return {
        resourceType: "post",
        schemaVersion: CURRENT_REVISION_SCHEMA_VERSION,
        triggerKind,
        data: serialized.data,
      };
    } catch (err) {
      if (err instanceof PublicationValidationError) {
        throw new RevisionValidationError(
          `Snapshot revisi artikel tidak lolos validasi skema: ${err.message}`,
          err.fields,
        );
      }
      throw new RevisionValidationError("Snapshot revisi artikel tidak valid.", [
        { field: "snapshot", code: "INVALID_POST_SNAPSHOT", message: String(err) },
      ]);
    }
  }

  // Offering validation (preserving rich verticalAttributes when present)
  const offeringType = dataRecord.offeringType;
  if (
    options.expectedOfferingType &&
    offeringType !== undefined &&
    offeringType !== options.expectedOfferingType
  ) {
    throw new RevisionValidationError(
      `Tipe penawaran pada revisi ("${String(offeringType)}") tidak cocok dengan tipe penawaran saat ini ("${options.expectedOfferingType}").`,
      [
        {
          field: "offeringType",
          code: "OFFERING_TYPE_MISMATCH",
          message: `Revision offeringType does not match target offeringType "${options.expectedOfferingType}".`,
        },
      ],
    );
  }

  const richAttributes =
    dataRecord.verticalAttributes &&
    typeof dataRecord.verticalAttributes === "object" &&
    !Array.isArray(dataRecord.verticalAttributes)
      ? (dataRecord.verticalAttributes as Record<string, unknown>)
      : dataRecord.attributes &&
          typeof dataRecord.attributes === "object" &&
          !Array.isArray(dataRecord.attributes)
        ? (dataRecord.attributes as Record<string, unknown>)
        : {};

  const candidateOfferingInput: Record<string, unknown> = {
    offeringType: dataRecord.offeringType,
    title: dataRecord.title,
    slug: dataRecord.slug,
    summary: dataRecord.summary ?? null,
    description: dataRecord.description ?? null,
    coverMediaId: dataRecord.coverMediaId ?? null,
    galleryMediaIds: Array.isArray(dataRecord.galleryMediaIds) ? dataRecord.galleryMediaIds : [],
    videoMediaId: dataRecord.videoMediaId ?? null,
    youtubeVideoId: dataRecord.youtubeVideoId ?? null,
    priceMode: dataRecord.priceMode ?? "on_request",
    price: dataRecord.price ?? null,
    priceMax: dataRecord.priceMax ?? null,
    negotiable: Boolean(dataRecord.negotiable),
    originalAmount: dataRecord.originalAmount ?? null,
    ...(Array.isArray(dataRecord.badges) && dataRecord.badges.length > 0
      ? { badges: dataRecord.badges }
      : { badge: dataRecord.badge ?? null }),
    ctaMode: dataRecord.ctaMode ?? "whatsapp",
    ctaLabel: dataRecord.ctaLabel ?? null,
    externalUrl: dataRecord.externalUrl ?? null,
    whatsappOverride: dataRecord.whatsappOverride ?? null,
    whatsappTemplate: dataRecord.whatsappTemplate ?? null,
    unitStatus: dataRecord.unitStatus ?? null,
    categoryIds: Array.isArray(dataRecord.categoryIds) ? dataRecord.categoryIds : [],
    attributesVersion:
      typeof dataRecord.attributesVersion === "number" ? dataRecord.attributesVersion : 1,
    attributes: richAttributes,
    seo: dataRecord.seo ?? null,
  };

  try {
    const validatedOffering = validateOfferingInput(candidateOfferingInput, {
      tenantWhatsAppE164: options.tenantWhatsAppE164 ?? null,
    });
    const slug =
      typeof dataRecord.slug === "string" && dataRecord.slug.trim()
        ? dataRecord.slug.trim()
        : (validatedOffering.manualSlug ?? "penawaran");

    const normalizedSnapshot: OfferingSnapshot = {
      offeringType: validatedOffering.offeringType,
      slug,
      title: validatedOffering.title,
      summary: validatedOffering.summary,
      description: validatedOffering.description,
      coverMediaId: validatedOffering.coverMediaId,
      galleryMediaIds: [...validatedOffering.galleryMediaIds],
      videoMediaId: validatedOffering.videoMediaId,
      youtubeVideoId: validatedOffering.youtubeVideoId,
      priceMode: validatedOffering.pricing.priceMode,
      price: validatedOffering.pricing.price,
      priceMax: validatedOffering.pricing.priceMax,
      negotiable: validatedOffering.pricing.negotiable,
      originalAmount: validatedOffering.pricing.originalAmount,
      badge: validatedOffering.badge,
      badges: [...validatedOffering.badges],
      ctaMode: validatedOffering.cta.ctaMode,
      ctaLabel: validatedOffering.cta.ctaLabel,
      externalUrl: validatedOffering.cta.externalUrl,
      whatsappOverride: validatedOffering.cta.whatsappOverride,
      whatsappTemplate: validatedOffering.cta.whatsappTemplate,
      unitStatus: validatedOffering.unitStatus,
      categoryIds: [...validatedOffering.categoryIds],
      attributesVersion: validatedOffering.attributesVersion,
      attributes: projectToPublicOfferingAttributes(
        validatedOffering.offeringType,
        validatedOffering.attributes,
      ),
      verticalAttributes: { ...(validatedOffering.attributes as Record<string, unknown>) },
      seo: validatedOffering.seo,
    };

    return {
      resourceType: "offering",
      schemaVersion: CURRENT_REVISION_SCHEMA_VERSION,
      triggerKind,
      data: normalizedSnapshot,
      validatedOffering,
    };
  } catch (err) {
    const fields: RevisionValidationField[] =
      err && typeof err === "object" && "fields" in err && Array.isArray((err as { fields: unknown }).fields)
        ? ((err as { fields: RevisionValidationField[] }).fields)
        : [{ field: "snapshot", code: "INVALID_OFFERING_SNAPSHOT", message: String(err) }];
    const msg = err instanceof Error ? err.message : "Snapshot revisi penawaran tidak valid.";
    throw new RevisionValidationError(`Snapshot revisi penawaran tidak lolos validasi skema: ${msg}`, fields);
  }
}

export interface ExtractedSnapshotReferences {
  readonly mediaIds: readonly number[];
  readonly taxonomyIds: readonly number[];
  readonly authorId: number | null;
}

function collectRichTextBlockMediaIds(doc: RestrictedRichTextDoc | null | undefined, out: Set<number>): void {
  if (!doc || !Array.isArray(doc.blocks)) return;
  for (const block of doc.blocks) {
    if (block && typeof block === "object" && "mediaId" in block) {
      const mId = (block as { mediaId?: unknown }).mediaId;
      if (isPositiveInt(mId)) {
        out.add(mId);
      }
    }
  }
}

const REVISION_MEDIA_SINGLE_KEYS = new Set<string>([
  "mediaId",
  "media_id",
  "imageMediaId",
  "image_media_id",
  "imageId",
  "image_id",
  "coverMediaId",
  "cover_media_id",
  "featuredMediaId",
  "featured_media_id",
  "videoMediaId",
  "video_media_id",
  "posterMediaId",
  "poster_media_id",
  "ogImageMediaId",
  "og_image_media_id",
  "logoMediaId",
  "logo_media_id",
  "avatarMediaId",
  "avatar_media_id",
  "faviconMediaId",
  "favicon_media_id",
]);

const REVISION_MEDIA_ARRAY_KEYS = new Set<string>([
  "galleryMediaIds",
  "gallery_media_ids",
  "mediaIds",
  "media_ids",
  "imageMediaIds",
  "image_media_ids",
]);

function isMediaSingleKey(key: string): boolean {
  return REVISION_MEDIA_SINGLE_KEYS.has(key) || /MediaId$|_media_id$/.test(key);
}

function isMediaArrayKey(key: string): boolean {
  return REVISION_MEDIA_ARRAY_KEYS.has(key) || /MediaIds$|_media_ids$/.test(key);
}

const BODY_HTML_MEDIA_SRC_RE = /\/media\/([1-9]\d{0,9})(?=[^0-9]|$)/g;

function extractMediaIdsFromBodyHtml(html: string, out: Set<number>): void {
  BODY_HTML_MEDIA_SRC_RE.lastIndex = 0;
  let match: RegExpExecArray | null = BODY_HTML_MEDIA_SRC_RE.exec(html);
  while (match) {
    const id = Number(match[1]);
    if (isPositiveInt(id)) out.add(id);
    match = BODY_HTML_MEDIA_SRC_RE.exec(html);
  }
}

function stripInvalidMediaFromBodyHtml(
  html: string,
  invalidMediaIds: ReadonlySet<number>,
  detachedSet: Set<number>,
): string {
  if (invalidMediaIds.size === 0) return html;
  // Strip `<figure><img ... src="/media/<id>" ...></figure>` or standalone `<img ... src="/media/<id>" ...>`
  return html
    .replace(
      /<figure>\s*<img\b[^>]*\bsrc=["']\/media\/([1-9]\d{0,9})["'][^>]*>\s*<\/figure>/gi,
      (full, rawId: string) => {
        const id = Number(rawId);
        if (isPositiveInt(id) && invalidMediaIds.has(id)) {
          detachedSet.add(id);
          return "";
        }
        return full;
      },
    )
    .replace(
      /<img\b[^>]*\bsrc=["']\/media\/([1-9]\d{0,9})["'][^>]*>/gi,
      (full, rawId: string) => {
        const id = Number(rawId);
        if (isPositiveInt(id) && invalidMediaIds.has(id)) {
          detachedSet.add(id);
          return "";
        }
        return full;
      },
    );
}

function extractExtraRevisionMediaIds(value: unknown, out: Set<number>): void {
  if (value === null || value === undefined || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) extractExtraRevisionMediaIds(item, out);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "bodyHtml" && typeof nested === "string") {
      extractMediaIdsFromBodyHtml(nested, out);
    } else if (isMediaSingleKey(key) && isPositiveInt(nested)) {
      out.add(nested);
    } else if (isMediaArrayKey(key) && Array.isArray(nested)) {
      for (const entry of nested) {
        if (isPositiveInt(entry)) out.add(entry);
      }
    } else if (key === "media" && Array.isArray(nested)) {
      for (const entry of nested) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const maybeId = (entry as Record<string, unknown>).id;
          if (isPositiveInt(maybeId)) out.add(maybeId);
        }
        extractExtraRevisionMediaIds(entry, out);
      }
    } else if (nested !== null && typeof nested === "object") {
      extractExtraRevisionMediaIds(nested, out);
    }
  }
}

/**
 * Recursively strips any invalid (`missing`, `trashed`, `failed`, `quarantined`) media IDs
 * from arbitrary nested page sections (including `bodyHtml` `/media/<id>` embeds), SEO overrides,
 * post trees, or offering attributes/verticalAttributes.
 */
function stripInvalidMediaIdsFromTree<V>(
  value: V,
  invalidMediaIds: ReadonlySet<number>,
  detachedSet: Set<number>,
  options: { readonly singleKeyAction: "nullify" | "omit" } = { singleKeyAction: "omit" },
): V {
  if (invalidMediaIds.size === 0 || value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      stripInvalidMediaIdsFromTree(item, invalidMediaIds, detachedSet, options),
    ) as unknown as V;
  }

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "bodyHtml" && typeof nested === "string") {
      out[key] = stripInvalidMediaFromBodyHtml(nested, invalidMediaIds, detachedSet);
      continue;
    }

    if (isMediaSingleKey(key) && isPositiveInt(nested) && invalidMediaIds.has(nested)) {
      detachedSet.add(nested);
      if (options.singleKeyAction === "nullify") {
        out[key] = null;
      }
      continue;
    }

    if (isMediaArrayKey(key) && Array.isArray(nested)) {
      const filtered: unknown[] = [];
      for (const entry of nested) {
        if (isPositiveInt(entry) && invalidMediaIds.has(entry)) {
          detachedSet.add(entry);
        } else {
          filtered.push(entry);
        }
      }
      out[key] = filtered;
      continue;
    }

    if (key === "media" && Array.isArray(nested)) {
      const filteredMedia: unknown[] = [];
      for (const entry of nested) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const maybeId = (entry as Record<string, unknown>).id;
          if (isPositiveInt(maybeId) && invalidMediaIds.has(maybeId)) {
            detachedSet.add(maybeId);
            continue;
          }
        }
        filteredMedia.push(
          stripInvalidMediaIdsFromTree(entry, invalidMediaIds, detachedSet, options),
        );
      }
      out[key] = filteredMedia;
      continue;
    }

    out[key] = stripInvalidMediaIdsFromTree(nested, invalidMediaIds, detachedSet, options);
  }
  return out as V;
}

export function extractSnapshotReferences(
  parsed: ParsedValidatedRevisionSnapshot,
): ExtractedSnapshotReferences {
  const mediaSet = new Set<number>();
  const taxSet = new Set<number>();
  let authorId: number | null = null;

  if (parsed.resourceType === "page") {
    extractMediaIdsFromJsonValue(parsed.data, mediaSet);
    extractExtraRevisionMediaIds(parsed.data, mediaSet);
  } else if (parsed.resourceType === "post") {
    const d = parsed.data;
    if (isPositiveInt(d.coverMediaId)) mediaSet.add(d.coverMediaId);
    if (isPositiveInt(d.seo?.ogImageMediaId)) mediaSet.add(d.seo.ogImageMediaId);
    collectRichTextBlockMediaIds(d.body, mediaSet);
    extractMediaIdsFromJsonValue(d, mediaSet);
    extractExtraRevisionMediaIds(d, mediaSet);

    if (isPositiveInt(d.primaryCategoryId)) taxSet.add(d.primaryCategoryId);
    for (const cid of d.categoryIds ?? []) {
      if (isPositiveInt(cid)) taxSet.add(cid);
    }
    for (const tid of d.tagIds ?? []) {
      if (isPositiveInt(tid)) taxSet.add(tid);
    }
    if (isPositiveInt(d.authorId)) {
      authorId = d.authorId;
    }
  } else {
    const d = parsed.data;
    if (isPositiveInt(d.coverMediaId)) mediaSet.add(d.coverMediaId);
    if (isPositiveInt(d.videoMediaId)) mediaSet.add(d.videoMediaId);
    for (const gid of d.galleryMediaIds ?? []) {
      if (isPositiveInt(gid)) mediaSet.add(gid);
    }
    if (isPositiveInt(d.seo?.ogImageMediaId)) mediaSet.add(d.seo.ogImageMediaId);
    if (d.description && typeof d.description === "object") {
      collectRichTextBlockMediaIds(d.description as RestrictedRichTextDoc, mediaSet);
    }
    extractMediaIdsFromJsonValue(d, mediaSet);
    extractExtraRevisionMediaIds(d, mediaSet);
    extractMediaIdsFromJsonValue(parsed.validatedOffering.attributes, mediaSet);
    extractExtraRevisionMediaIds(parsed.validatedOffering.attributes, mediaSet);
    for (const cid of d.categoryIds ?? []) {
      if (isPositiveInt(cid)) taxSet.add(cid);
    }
  }

  return {
    mediaIds: [...mediaSet].sort((a, b) => a - b),
    taxonomyIds: [...taxSet].sort((a, b) => a - b),
    authorId,
  };
}

export interface RevisionReferenceLookup {
  readonly mediaById: ReadonlyMap<
    number,
    { readonly status: string; readonly deletedAt: number | null }
  >;
  readonly taxonomyById: ReadonlyMap<
    number,
    { readonly taxonomyType: string; readonly offeringType: string | null }
  >;
  readonly existingAuthorIds: ReadonlySet<number>;
}

function sanitizeRichTextMediaBlocks(
  doc: RestrictedRichTextDoc,
  missingMediaIds: ReadonlySet<number>,
  warnings: RevisionReferenceWarning[],
  detachedMediaSet: Set<number>,
  fieldPrefix: string,
): RestrictedRichTextDoc {
  if (missingMediaIds.size === 0) return doc;
  const filteredBlocks = doc.blocks.filter((block) => {
    const maybeMediaId =
      block && typeof block === "object" && "mediaId" in block
        ? (block as { readonly mediaId?: unknown }).mediaId
        : undefined;
    if (isPositiveInt(maybeMediaId) && missingMediaIds.has(maybeMediaId)) {
      detachedMediaSet.add(maybeMediaId);
      warnings.push({
        kind: "media",
        id: maybeMediaId,
        status: "detached",
        field: fieldPrefix,
        message: `Blok media #${maybeMediaId} pada konten dilepaskan karena media tidak lagi tersedia di situs ini.`,
      });
      return false;
    }
    return true;
  });

  if (filteredBlocks.length === 0 && doc.blocks.length > 0) {
    return {
      schemaVersion: 1,
      blocks: [
        {
          type: "paragraph",
          text: "[Media pada revisi sebelumnya telah dihapus — silakan unggah atau pilih media pengganti]",
        },
      ],
    };
  }

  return {
    schemaVersion: 1,
    blocks: filteredBlocks,
  };
}

/**
 * Inspects and sanitizes all media, taxonomy, and author references inside a validated
 * revision snapshot against the current tenant's live records (single-tenant scoped).
 *
 * - Missing/deleted/foreign-tenant media IDs are detached cleanly so FK constraints never fail
 *   and cross-tenant assets can NEVER be linked.
 * - Trashed or unavailable media still in this tenant's `media_items` emit explicit warnings.
 * - Missing taxonomies or authors are detached cleanly with warnings.
 * - When `detachMissingReferences` is `false`, missing references throw `RevisionValidationError` (422).
 */
export function sanitizeRevisionSnapshotReferences<T extends ParsedValidatedRevisionSnapshot>(
  parsed: T,
  lookup: RevisionReferenceLookup,
  options: { readonly detachMissingReferences?: boolean } = {},
): {
  readonly sanitized: T;
  readonly report: RevisionReferenceReport;
} {
  const detachMissing = options.detachMissingReferences ?? true;
  const refs = extractSnapshotReferences(parsed);

  const validMediaIds: number[] = [];
  const missingMediaIds: number[] = [];
  const trashedMediaIds: number[] = [];
  const unavailableMediaIds: number[] = [];
  const detachedMediaSet = new Set<number>();
  const missingTaxonomyIds: number[] = [];
  const warnings: RevisionReferenceWarning[] = [];
  let missingAuthorId: number | null = null;

  for (const mediaId of refs.mediaIds) {
    const found = lookup.mediaById.get(mediaId);
    if (!found) {
      missingMediaIds.push(mediaId);
      warnings.push({
        kind: "media",
        id: mediaId,
        status: "missing",
        field: "media",
        message: `Media #${mediaId} tidak ditemukan di pustaka media situs ini dan telah dilepaskan dari draf.`,
      });
    } else if (found.deletedAt !== null) {
      trashedMediaIds.push(mediaId);
      warnings.push({
        kind: "media",
        id: mediaId,
        status: "trashed",
        field: "media",
        message: `Media #${mediaId} berada di Sampah media dan telah dilepaskan dari draf. Pulihkan atau pilih media pengganti sebelum menerbitkan.`,
      });
    } else if (found.status !== "ready" && found.status !== "processing") {
      unavailableMediaIds.push(mediaId);
      warnings.push({
        kind: "media",
        id: mediaId,
        status: "unavailable",
        field: "media",
        message: `Media #${mediaId} tidak tersedia (${found.status}) dan telah dilepaskan dari draf.`,
      });
    } else {
      validMediaIds.push(mediaId);
    }
  }

  // Consistently detach missing, trashed, failed, and quarantined media IDs across ALL nested trees
  const invalidMediaSet = new Set<number>([
    ...missingMediaIds,
    ...trashedMediaIds,
    ...unavailableMediaIds,
  ]);
  const invalidMediaList = [...invalidMediaSet].sort((a, b) => a - b);

  if (parsed.resourceType === "page") {
    const d = parsed.data;
    const nextSections = stripInvalidMediaIdsFromTree(
      d.sections,
      invalidMediaSet,
      detachedMediaSet,
      { singleKeyAction: "omit" },
    );
    const nextSeo = d.seo
      ? stripInvalidMediaIdsFromTree(d.seo, invalidMediaSet, detachedMediaSet, {
          singleKeyAction: "nullify",
        })
      : null;

    const report: RevisionReferenceReport = {
      referencedMediaIds: refs.mediaIds,
      validMediaIds,
      missingMediaIds,
      trashedMediaIds,
      unavailableMediaIds,
      detachedMediaIds: [...detachedMediaSet].sort((a, b) => a - b),
      missingTaxonomyIds,
      missingAuthorId,
      warnings,
    };

    if (!detachMissing && invalidMediaList.length > 0) {
      throw new RevisionValidationError(
        `Revisi merujuk media yang tidak tersedia atau sudah dihapus (${invalidMediaList.map((id) => `#${id}`).join(", ")}).`,
        invalidMediaList.map((id) => ({
          field: "media",
          code: missingMediaIds.includes(id)
            ? "MISSING_MEDIA_REFERENCE"
            : trashedMediaIds.includes(id)
              ? "TRASHED_MEDIA_REFERENCE"
              : "UNAVAILABLE_MEDIA_REFERENCE",
          message: `Media #${id} is missing, trashed, or unavailable in this tenant.`,
        })),
      );
    }

    return {
      sanitized: {
        ...parsed,
        data: {
          ...d,
          sections: nextSections,
          seo: nextSeo,
        },
      } as T,
      report,
    };
  }

  if (parsed.resourceType === "post") {
    const d = parsed.data;
    const nextBody = sanitizeRichTextMediaBlocks(
      d.body,
      invalidMediaSet,
      warnings,
      detachedMediaSet,
      "body",
    );
    const cleanedPostTree = stripInvalidMediaIdsFromTree(
      {
        ...d,
        body: nextBody,
      },
      invalidMediaSet,
      detachedMediaSet,
      { singleKeyAction: "nullify" },
    );
    const nextCoverMediaId = cleanedPostTree.coverMediaId ?? null;
    const nextSeo = cleanedPostTree.seo ?? null;
    const nextSanitizedHtml = renderRichTextDocToSanitizedHtml(cleanedPostTree.body);
    const nextReadingTime = calculateLinearReadingTimeMinutes(
      nextSanitizedHtml || cleanedPostTree.body,
    );

    // Filter categories & tags against live tenant taxonomies
    const validCatIds: number[] = [];
    for (const cid of d.categoryIds ?? []) {
      const found = lookup.taxonomyById.get(cid);
      if (found && found.taxonomyType === "post_category") {
        validCatIds.push(cid);
      } else if (isPositiveInt(cid)) {
        missingTaxonomyIds.push(cid);
        warnings.push({
          kind: "taxonomy",
          id: cid,
          status: "detached",
          field: "categoryIds",
          message: `Kategori artikel #${cid} sudah dihapus dan dilepaskan dari draf.`,
        });
      }
    }

    let nextPrimaryCatId = d.primaryCategoryId ?? null;
    if (isPositiveInt(nextPrimaryCatId)) {
      const found = lookup.taxonomyById.get(nextPrimaryCatId);
      if (!found || found.taxonomyType !== "post_category") {
        if (!missingTaxonomyIds.includes(nextPrimaryCatId)) {
          missingTaxonomyIds.push(nextPrimaryCatId);
        }
        warnings.push({
          kind: "taxonomy",
          id: nextPrimaryCatId,
          status: "detached",
          field: "primaryCategoryId",
          message: `Kategori utama #${nextPrimaryCatId} sudah dihapus dan dilepaskan dari draf.`,
        });
        nextPrimaryCatId = validCatIds[0] ?? null;
      } else if (!validCatIds.includes(nextPrimaryCatId)) {
        validCatIds.unshift(nextPrimaryCatId);
      }
    }

    const validTagIds: number[] = [];
    for (const tid of d.tagIds ?? []) {
      const found = lookup.taxonomyById.get(tid);
      if (found && found.taxonomyType === "post_tag") {
        validTagIds.push(tid);
      } else if (isPositiveInt(tid)) {
        missingTaxonomyIds.push(tid);
        warnings.push({
          kind: "taxonomy",
          id: tid,
          status: "detached",
          field: "tagIds",
          message: `Tag artikel #${tid} sudah dihapus dan dilepaskan dari draf.`,
        });
      }
    }

    let nextAuthorId = d.authorId ?? null;
    if (isPositiveInt(nextAuthorId) && !lookup.existingAuthorIds.has(nextAuthorId)) {
      missingAuthorId = nextAuthorId;
      warnings.push({
        kind: "author",
        id: nextAuthorId,
        status: "detached",
        field: "authorId",
        message: `Profil penulis #${nextAuthorId} sudah dihapus dan dilepaskan dari draf.`,
      });
      nextAuthorId = null;
    }

    const report: RevisionReferenceReport = {
      referencedMediaIds: refs.mediaIds,
      validMediaIds,
      missingMediaIds,
      trashedMediaIds,
      unavailableMediaIds,
      detachedMediaIds: [...detachedMediaSet].sort((a, b) => a - b),
      missingTaxonomyIds: [...new Set(missingTaxonomyIds)].sort((a, b) => a - b),
      missingAuthorId,
      warnings,
    };

    if (
      !detachMissing &&
      (invalidMediaList.length > 0 || missingTaxonomyIds.length > 0 || missingAuthorId !== null)
    ) {
      const fields: RevisionValidationField[] = [
        ...invalidMediaList.map((id) => ({
          field: "media",
          code: missingMediaIds.includes(id)
            ? "MISSING_MEDIA_REFERENCE"
            : trashedMediaIds.includes(id)
              ? "TRASHED_MEDIA_REFERENCE"
              : "UNAVAILABLE_MEDIA_REFERENCE",
          message: `Media #${id} is missing, trashed, or unavailable in this tenant.`,
        })),
        ...missingTaxonomyIds.map((id) => ({
          field: "taxonomies",
          code: "MISSING_TAXONOMY_REFERENCE",
          message: `Taxonomy #${id} does not exist in this tenant.`,
        })),
        ...(missingAuthorId !== null
          ? [
              {
                field: "authorId",
                code: "MISSING_AUTHOR_REFERENCE",
                message: `Author #${missingAuthorId} does not exist in this tenant.`,
              },
            ]
          : []),
      ];
      throw new RevisionValidationError(
        "Revisi merujuk media, taksonomi, atau penulis yang tidak tersedia atau sudah dihapus.",
        fields,
      );
    }

    return {
      sanitized: {
        ...parsed,
        data: {
          ...cleanedPostTree,
          coverMediaId: nextCoverMediaId,
          seo: nextSeo,
          sanitizedHtml: nextSanitizedHtml,
          readingTimeMinutes: nextReadingTime,
          primaryCategoryId: nextPrimaryCatId,
          categoryIds: validCatIds,
          tagIds: validTagIds,
          authorId: nextAuthorId,
        },
      } as T,
      report,
    };
  }

  // Offering
  const d = parsed.data;
  const v = parsed.validatedOffering;

  let nextCoverMediaId = d.coverMediaId ?? null;
  if (isPositiveInt(nextCoverMediaId) && invalidMediaSet.has(nextCoverMediaId)) {
    detachedMediaSet.add(nextCoverMediaId);
    nextCoverMediaId = null;
  }

  let nextVideoMediaId = d.videoMediaId ?? null;
  if (isPositiveInt(nextVideoMediaId) && invalidMediaSet.has(nextVideoMediaId)) {
    detachedMediaSet.add(nextVideoMediaId);
    nextVideoMediaId = null;
  }

  const nextGalleryIds: number[] = [];
  for (const gid of d.galleryMediaIds ?? []) {
    if (invalidMediaSet.has(gid)) {
      detachedMediaSet.add(gid);
    } else {
      nextGalleryIds.push(gid);
    }
  }

  const nextSeo = d.seo
    ? stripInvalidMediaIdsFromTree(d.seo, invalidMediaSet, detachedMediaSet, {
        singleKeyAction: "nullify",
      })
    : null;

  let nextDescription: CatalogDescription | null = d.description ?? null;
  if (nextDescription && typeof nextDescription === "object" && "blocks" in nextDescription) {
    nextDescription = sanitizeRichTextMediaBlocks(
      nextDescription as RestrictedRichTextDoc,
      invalidMediaSet,
      warnings,
      detachedMediaSet,
      "description",
    );
  }

  // Recursively sanitize offering vertical attributes + projected public attributes
  const nextRichAttributes = stripInvalidMediaIdsFromTree(
    v.attributes as Record<string, unknown>,
    invalidMediaSet,
    detachedMediaSet,
    { singleKeyAction: "omit" },
  ) as CatalogOfferingAttributes;

  const nextProjectedAttributes = stripInvalidMediaIdsFromTree(
    projectToPublicOfferingAttributes(v.offeringType, nextRichAttributes),
    invalidMediaSet,
    detachedMediaSet,
    { singleKeyAction: "omit" },
  );

  const validCategoryIds: number[] = [];
  for (const cid of d.categoryIds ?? []) {
    const found = lookup.taxonomyById.get(cid);
    if (
      found &&
      found.taxonomyType === "offering_category" &&
      (found.offeringType === null || found.offeringType === d.offeringType)
    ) {
      validCategoryIds.push(cid);
    } else if (isPositiveInt(cid)) {
      missingTaxonomyIds.push(cid);
      warnings.push({
        kind: "taxonomy",
        id: cid,
        status: "detached",
        field: "categoryIds",
        message: `Kategori katalog #${cid} sudah dihapus dan dilepaskan dari draf.`,
      });
    }
  }

  const report: RevisionReferenceReport = {
    referencedMediaIds: refs.mediaIds,
    validMediaIds,
    missingMediaIds,
    trashedMediaIds,
    unavailableMediaIds,
    detachedMediaIds: [...detachedMediaSet].sort((a, b) => a - b),
    missingTaxonomyIds: [...new Set(missingTaxonomyIds)].sort((a, b) => a - b),
    missingAuthorId: null,
    warnings,
  };

  if (!detachMissing && (invalidMediaList.length > 0 || missingTaxonomyIds.length > 0)) {
    throw new RevisionValidationError(
      "Revisi penawaran merujuk media atau kategori yang tidak tersedia atau sudah dihapus.",
      [
        ...invalidMediaList.map((id) => ({
          field: "media",
          code: missingMediaIds.includes(id)
            ? "MISSING_MEDIA_REFERENCE"
            : trashedMediaIds.includes(id)
              ? "TRASHED_MEDIA_REFERENCE"
              : "UNAVAILABLE_MEDIA_REFERENCE",
          message: `Media #${id} is missing, trashed, or unavailable in this tenant.`,
        })),
        ...missingTaxonomyIds.map((id) => ({
          field: "categoryIds",
          code: "MISSING_TAXONOMY_REFERENCE",
          message: `Offering category #${id} does not exist in this tenant.`,
        })),
      ],
    );
  }

  const nextValidatedOffering: ValidatedOfferingDraftInput = {
    ...v,
    description: nextDescription,
    coverMediaId: nextCoverMediaId,
    galleryMediaIds: nextGalleryIds,
    videoMediaId: nextVideoMediaId,
    categoryIds: validCategoryIds,
    attributes: nextRichAttributes,
    seo: nextSeo,
  };

  const nextData: OfferingSnapshot = {
    ...d,
    description: nextDescription,
    coverMediaId: nextCoverMediaId,
    galleryMediaIds: nextGalleryIds,
    videoMediaId: nextVideoMediaId,
    categoryIds: validCategoryIds,
    seo: nextSeo,
    attributes: nextProjectedAttributes,
    verticalAttributes: { ...(nextRichAttributes as Record<string, unknown>) },
  };

  return {
    sanitized: {
      ...parsed,
      data: nextData,
      validatedOffering: nextValidatedOffering,
    } as T,
    report,
  };
}

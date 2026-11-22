import { z } from "zod";
import {
  BusinessProfileSnapshotSchema,
  MenuSnapshotSchema,
  OfferingSnapshotSchema,
  PageLayoutModeSchema,
  PageSnapshotSchema,
  PostSnapshotSchema,
  sanitizeNavigationHref,
  SiteSettingsSnapshotSchema,
  stripDraftOnlyFields,
  type BusinessProfileSnapshot,
  type MenuSnapshot,
  type OfferingSnapshot,
  type PageLayoutMode,
  type PageSnapshot,
  type PostSnapshot,
  type PublicationValidationField,
  type SiteSettingsSnapshot,
} from "../content/index.ts";
import { MenuLocationSchema } from "../schemas/cms.ts";
import {
  FORBIDDEN_TENANT_SELECTOR_KEYS,
  SequentialIdSchema,
  ThemeIdSchema,
  VersionSchema,
} from "../schemas/common.ts";
import { validateThemeConfigSnapshot, type ThemeConfigSnapshot } from "../theme/index.ts";

/**
 * Bounded Validated In-Process Draft Preview DTO, Media Reference Extractor,
 * Header Policy, and Inert HTML Neutralizer (REQ-036, REQ-001, REQ-034, REQ-039;
 * PLAN §14; TASK-050).
 */

export const MAX_PREVIEW_REQUEST_BYTES = 131_072 as const; // 128 KiB hard ceiling
export const MAX_PREVIEW_HTML_BYTES = 500_000 as const; // Matches DraftPreviewResponseSchema

export const PREVIEW_HEADER_NAME = "X-PunyaSitus-Preview" as const;
export const PREVIEW_CACHE_STATUS_HEADER_NAME = "X-PunyaSitus-Cache" as const;
export const PREVIEW_CACHE_CONTROL_HEADER = "private, no-store, no-cache, must-revalidate" as const;
export const PREVIEW_PRAGMA_HEADER = "no-cache" as const;
export const PREVIEW_ROBOTS_HEADER = "noindex, nofollow" as const;

/**
 * Empty iframe `sandbox` attribute: disables scripts, forms, same-origin access,
 * popups, and top-level navigation at the browser engine boundary (PLAN §14).
 */
export const PREVIEW_IFRAME_SANDBOX = "" as const;

/**
 * Restrictive CSP for rendered preview HTML documents (PLAN §14):
 * - `script-src 'none'` prevents any inline/external script execution.
 * - `form-action 'none'` prevents any form submission.
 * - `frame-ancestors 'self'` restricts framing strictly to the admin origin.
 * - `object-src 'none'; base-uri 'none'` blocks plugin/base-URL hijacking.
 */
export const PREVIEW_HTML_CSP_HEADER =
  "default-src 'none'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'" as const;

/**
 * Meta-tag equivalent CSP (omits `frame-ancestors`, which W3C CSP3 restricts to HTTP headers only).
 */
export const PREVIEW_META_CSP_CONTENT =
  "default-src 'none'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'" as const;

export const PREVIEW_API_CSP_HEADER = "default-src 'none'; frame-ancestors 'none'" as const;

export const PREVIEW_RESOURCE_KINDS = [
  "page",
  "post",
  "offering",
  "theme",
  "identity",
  "menu",
  "home",
] as const;
export type PreviewResourceKind = (typeof PREVIEW_RESOURCE_KINDS)[number];

export const PREVIEW_VIEWPORT_IDS = ["mobile", "tablet", "desktop"] as const;
export type PreviewViewportId = (typeof PREVIEW_VIEWPORT_IDS)[number];

export interface PreviewViewportPreset {
  readonly id: PreviewViewportId;
  readonly label: string;
  readonly shortLabel: string;
  readonly widthPx: number;
}

export const PREVIEW_VIEWPORTS: Readonly<Record<PreviewViewportId, PreviewViewportPreset>> = {
  mobile: {
    id: "mobile",
    label: "Mobile 360px",
    shortLabel: "Mobile",
    widthPx: 360,
  },
  tablet: {
    id: "tablet",
    label: "Tablet 768px",
    shortLabel: "Tablet",
    widthPx: 768,
  },
  desktop: {
    id: "desktop",
    label: "Desktop 1440px",
    shortLabel: "Desktop",
    widthPx: 1440,
  },
};

/**
 * Forbidden selector / privilege keys rejected anywhere in a preview request DTO.
 * Scope ALWAYS comes from the server-verified route + live membership, NEVER the body.
 */
export const PREVIEW_FORBIDDEN_SELECTOR_KEYS = [
  ...FORBIDDEN_TENANT_SELECTOR_KEYS,
  "userId",
  "user_id",
  "ownerId",
  "owner_id",
  "role",
  "roles",
  "actorId",
  "actor_id",
  "platformOperator",
  "isSuperadmin",
] as const;

const PREVIEW_FORBIDDEN_KEY_SET: ReadonlySet<string> = new Set(PREVIEW_FORBIDDEN_SELECTOR_KEYS);

export const PreviewResourceKindSchema = z.enum(PREVIEW_RESOURCE_KINDS);
export const PreviewViewportSchema = z.enum(PREVIEW_VIEWPORT_IDS);

export class PreviewPayloadTooLargeError extends Error {
  readonly httpStatus = 413 as const;
  readonly code = "PAYLOAD_TOO_LARGE" as const;
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number = MAX_PREVIEW_REQUEST_BYTES) {
    super(`Ukuran payload pratinjau (${actualBytes} byte) melebihi batas maksimum ${maxBytes} byte.`);
    this.name = "PreviewPayloadTooLargeError";
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

export class PreviewValidationError extends Error {
  readonly httpStatus = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly fields: readonly PublicationValidationField[];

  constructor(message: string, fields: readonly PublicationValidationField[] = []) {
    super(message);
    this.name = "PreviewValidationError";
    this.fields = fields;
  }
}

export class PreviewThemeError extends PreviewValidationError {
  readonly themeId: string;

  constructor(themeId: string, message?: string) {
    super(
      message ?? `Tema "${themeId}" tidak terdaftar atau tidak tersedia untuk situs ini.`,
      [
        {
          field: "themeId",
          code: "UNREGISTERED_THEME",
          message: `Theme "${themeId}" is not registered or granted for this tenant.`,
        },
      ],
    );
    this.name = "PreviewThemeError";
    this.themeId = themeId;
  }
}

/**
 * Computes UTF-8 byte length for strings or JSON-serializable values.
 */
export function measureUtf8ByteLength(value: string | Uint8Array): number {
  if (value instanceof Uint8Array) return value.byteLength;
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Enforces the hard byte cap on raw request bytes or serialized preview DTOs.
 */
export function assertWithinPreviewByteCap(
  input: string | Uint8Array | unknown,
  maxBytes: number = MAX_PREVIEW_REQUEST_BYTES,
): number {
  let byteLength: number;
  if (input instanceof Uint8Array) {
    byteLength = input.byteLength;
  } else if (typeof input === "string") {
    byteLength = measureUtf8ByteLength(input);
  } else {
    try {
      byteLength = measureUtf8ByteLength(JSON.stringify(input) ?? "");
    } catch {
      throw new PreviewValidationError("Payload pratinjau tidak dapat diserialisasi sebagai JSON.", [
        {
          field: "body",
          code: "INVALID_JSON",
          message: "Preview payload must be JSON-serializable.",
        },
      ]);
    }
  }
  if (byteLength > maxBytes) {
    throw new PreviewPayloadTooLargeError(byteLength, maxBytes);
  }
  return byteLength;
}

/**
 * Recursively rejects forbidden selector / privilege keys anywhere in the input object graph.
 */
export function findForbiddenPreviewSelectorKey(value: unknown, pathPrefix = ""): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbiddenPreviewSelectorKey(value[i], `${pathPrefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (PREVIEW_FORBIDDEN_KEY_SET.has(key)) {
      return nextPath;
    }
    const hit = findForbiddenPreviewSelectorKey(nested, nextPath);
    if (hit) return hit;
  }
  return null;
}

export function assertNoForbiddenPreviewSelectors(value: unknown): void {
  const hit = findForbiddenPreviewSelectorKey(value);
  if (hit) {
    throw new PreviewValidationError(
      `Field terlarang "${hit}" tidak diizinkan pada permintaan pratinjau.`,
      [
        {
          field: hit,
          code: "FORBIDDEN_SELECTOR",
          message: `Selector or privilege field "${hit}" is forbidden in preview input.`,
        },
      ],
    );
  }
}

const PreviewMenusOverrideSchema = z
  .object({
    header: MenuSnapshotSchema.optional(),
    footer: MenuSnapshotSchema.optional(),
    mobile: MenuSnapshotSchema.optional(),
  })
  .strict();

const RawThemeOverrideSchema = z
  .object({
    themeId: ThemeIdSchema.optional(),
    tokens: z.record(z.string(), z.unknown()),
    variants: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const PreviewDraftOverrideSchema = z
  .object({
    page: PageSnapshotSchema.optional(),
    post: PostSnapshotSchema.optional(),
    offering: OfferingSnapshotSchema.optional(),
    siteSettings: SiteSettingsSnapshotSchema.optional(),
    businessProfile: BusinessProfileSnapshotSchema.optional(),
    themeConfig: RawThemeOverrideSchema.optional(),
    menu: MenuSnapshotSchema.optional(),
    menus: PreviewMenusOverrideSchema.optional(),
    layoutMode: PageLayoutModeSchema.optional(),
    mediaIds: z.array(SequentialIdSchema).max(32).optional(),
  })
  .strict();

export const DraftPreviewInputSchema = z
  .object({
    resourceKind: PreviewResourceKindSchema,
    resourceId: SequentialIdSchema.optional(),
    menuLocation: MenuLocationSchema.optional(),
    version: VersionSchema.optional(),
    expectedVersion: VersionSchema.optional(),
    themeId: ThemeIdSchema.optional(),
    layoutMode: PageLayoutModeSchema.optional(),
    draftOverride: PreviewDraftOverrideSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (
      val.version !== undefined &&
      val.expectedVersion !== undefined &&
      val.version !== val.expectedVersion
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedVersion"],
        message: "version and expectedVersion must match when both are provided",
      });
    }

    if (
      (val.resourceKind === "page" ||
        val.resourceKind === "post" ||
        val.resourceKind === "offering") &&
      val.resourceId === undefined &&
      !val.draftOverride?.[val.resourceKind]
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["resourceId"],
        message: `resourceId is required when previewing a saved ${val.resourceKind}`,
      });
    }
  });

export interface ValidatedPreviewDraftOverride {
  readonly page?: PageSnapshot;
  readonly post?: PostSnapshot;
  readonly offering?: OfferingSnapshot;
  readonly siteSettings?: SiteSettingsSnapshot;
  readonly businessProfile?: BusinessProfileSnapshot;
  readonly themeConfig?: ThemeConfigSnapshot;
  readonly menu?: MenuSnapshot;
  readonly menus?: {
    readonly header?: MenuSnapshot;
    readonly footer?: MenuSnapshot;
    readonly mobile?: MenuSnapshot;
  };
  readonly layoutMode?: PageLayoutMode;
  readonly mediaIds?: readonly number[];
}

export interface ValidatedDraftPreviewInput {
  readonly resourceKind: PreviewResourceKind;
  readonly resourceId?: number;
  readonly menuLocation?: MenuSnapshot["location"];
  readonly expectedVersion?: number;
  readonly themeId?: string;
  readonly layoutMode?: PageLayoutMode;
  readonly draftOverride?: ValidatedPreviewDraftOverride;
}

export const DraftPreviewApiResponseSchema = z
  .object({
    html: z.string().max(MAX_PREVIEW_HTML_BYTES),
    themeId: ThemeIdSchema,
    version: VersionSchema,
    resourceKind: PreviewResourceKindSchema,
    resourceId: z.union([SequentialIdSchema, z.string().min(1).max(64)]).nullable(),
    layoutMode: PageLayoutModeSchema,
    isPreview: z.literal(true),
    hasUnpublishedChanges: z.boolean(),
    sandbox: z.literal(PREVIEW_IFRAME_SANDBOX),
  })
  .strict();

export type DraftPreviewApiResponse = z.infer<typeof DraftPreviewApiResponseSchema>;

function sanitizeMenuSnapshotForPreview(menu: MenuSnapshot, fieldPrefix: string): MenuSnapshot {
  return {
    ...menu,
    items: menu.items.map((l1, i1) => ({
      ...l1,
      href: sanitizeNavigationHref(l1.href, `${fieldPrefix}.items[${i1}].href`),
      children: l1.children.map((l2, i2) => ({
        ...l2,
        href: sanitizeNavigationHref(l2.href, `${fieldPrefix}.items[${i1}].children[${i2}].href`),
        children: l2.children.map((l3, i3) => ({
          ...l3,
          href: sanitizeNavigationHref(
            l3.href,
            `${fieldPrefix}.items[${i1}].children[${i2}].children[${i3}].href`,
          ),
        })),
      })),
    })),
  };
}

function sanitizePageSnapshotForPreview(page: PageSnapshot): PageSnapshot {
  return {
    ...page,
    sections: page.sections.map((section, idx) => ({
      ...section,
      ctaHref:
        section.ctaHref !== undefined && section.ctaHref !== null && section.ctaHref !== ""
          ? sanitizeNavigationHref(section.ctaHref, `draftOverride.page.sections[${idx}].ctaHref`)
          : section.ctaHref,
    })),
  };
}

/**
 * Strictly parses and validates an in-process draft preview DTO:
 * 1. Enforces hard byte cap (`MAX_PREVIEW_REQUEST_BYTES` = 128 KiB -> 413).
 * 2. Rejects forbidden tenant/user/role selectors anywhere in the payload (422).
 * 3. Validates strict Zod schemas (`.strict()`), safe URLs, and theme token constraints (422).
 */
export function validateDraftPreviewInput(
  rawInput: unknown,
  options: { readonly maxBytes?: number } = {},
): ValidatedDraftPreviewInput {
  assertWithinPreviewByteCap(rawInput, options.maxBytes ?? MAX_PREVIEW_REQUEST_BYTES);
  assertNoForbiddenPreviewSelectors(rawInput);

  const parsed = DraftPreviewInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const fields: PublicationValidationField[] = parsed.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join(".") : "body",
      code: issue.code.toUpperCase(),
      message: issue.message,
    }));
    throw new PreviewValidationError("Input pratinjau draf tidak valid.", fields);
  }

  const data = parsed.data;
  const expectedVersion = data.expectedVersion ?? data.version;

  let validatedOverride: ValidatedPreviewDraftOverride | undefined;
  if (data.draftOverride) {
    const cleanOverride = stripDraftOnlyFields(data.draftOverride);
    let validatedThemeConfig: ThemeConfigSnapshot | undefined;
    if (cleanOverride.themeConfig) {
      try {
        validatedThemeConfig = validateThemeConfigSnapshot({
          themeId: cleanOverride.themeConfig.themeId ?? data.themeId ?? "compro",
          tokens: cleanOverride.themeConfig.tokens,
          variants: cleanOverride.themeConfig.variants ?? {},
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Konfigurasi token tema pratinjau tidak valid.";
        throw new PreviewValidationError(message, [
          {
            field: "draftOverride.themeConfig",
            code: "INVALID_THEME_CONFIG",
            message,
          },
        ]);
      }
    }

    try {
      validatedOverride = {
        ...(cleanOverride.page
          ? { page: sanitizePageSnapshotForPreview(cleanOverride.page) }
          : {}),
        ...(cleanOverride.post ? { post: cleanOverride.post } : {}),
        ...(cleanOverride.offering ? { offering: cleanOverride.offering } : {}),
        ...(cleanOverride.siteSettings ? { siteSettings: cleanOverride.siteSettings } : {}),
        ...(cleanOverride.businessProfile
          ? { businessProfile: cleanOverride.businessProfile }
          : {}),
        ...(validatedThemeConfig ? { themeConfig: validatedThemeConfig } : {}),
        ...(cleanOverride.menu
          ? { menu: sanitizeMenuSnapshotForPreview(cleanOverride.menu, "draftOverride.menu") }
          : {}),
        ...(cleanOverride.menus
          ? {
              menus: {
                ...(cleanOverride.menus.header
                  ? {
                      header: sanitizeMenuSnapshotForPreview(
                        cleanOverride.menus.header,
                        "draftOverride.menus.header",
                      ),
                    }
                  : {}),
                ...(cleanOverride.menus.footer
                  ? {
                      footer: sanitizeMenuSnapshotForPreview(
                        cleanOverride.menus.footer,
                        "draftOverride.menus.footer",
                      ),
                    }
                  : {}),
                ...(cleanOverride.menus.mobile
                  ? {
                      mobile: sanitizeMenuSnapshotForPreview(
                        cleanOverride.menus.mobile,
                        "draftOverride.menus.mobile",
                      ),
                    }
                  : {}),
              },
            }
          : {}),
        ...(cleanOverride.layoutMode ? { layoutMode: cleanOverride.layoutMode } : {}),
        ...(cleanOverride.mediaIds ? { mediaIds: cleanOverride.mediaIds } : {}),
      };
    } catch (err) {
      if (err instanceof PreviewValidationError) throw err;
      const fields =
        err && typeof err === "object" && "fields" in err && Array.isArray(err.fields)
          ? (err.fields as PublicationValidationField[])
          : [
              {
                field: "draftOverride",
                code: "UNSAFE_URL",
                message: err instanceof Error ? err.message : "Unsafe URL in preview draft",
              },
            ];
      throw new PreviewValidationError(
        err instanceof Error ? err.message : "URL pada draf pratinjau tidak aman.",
        fields,
      );
    }
  }

  return {
    resourceKind: data.resourceKind,
    ...(data.resourceId !== undefined ? { resourceId: data.resourceId } : {}),
    ...(data.menuLocation !== undefined ? { menuLocation: data.menuLocation } : {}),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    ...(data.themeId !== undefined ? { themeId: data.themeId } : {}),
    ...(data.layoutMode !== undefined ? { layoutMode: data.layoutMode } : {}),
    ...(validatedOverride !== undefined ? { draftOverride: validatedOverride } : {}),
  };
}

export interface PreviewMediaReference {
  readonly field: string;
  readonly mediaId: number;
  readonly expectedKind?: "image" | "video";
}

/**
 * Extracts every referenced `mediaId` across draft snapshots and overrides so the
 * server verifies 100% tenant ownership in the authenticated tenant's own `TenantStore`.
 */
export function extractReferencedMediaIds(sources: {
  readonly page?: PageSnapshot | null;
  readonly post?: PostSnapshot | null;
  readonly offering?: OfferingSnapshot | null;
  readonly siteSettings?: SiteSettingsSnapshot | null;
  readonly extraMediaIds?: readonly number[] | null;
}): PreviewMediaReference[] {
  const refs: PreviewMediaReference[] = [];
  const seen = new Set<string>();

  const pushRef = (
    field: string,
    mediaId: number | null | undefined,
    expectedKind?: "image" | "video",
  ) => {
    if (typeof mediaId !== "number" || !Number.isInteger(mediaId) || mediaId < 1) return;
    const dedupKey = `${mediaId}:${expectedKind ?? "any"}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    refs.push({ field, mediaId, expectedKind });
  };

  if (sources.siteSettings) {
    pushRef("siteSettings.faviconMediaId", sources.siteSettings.faviconMediaId, "image");
    pushRef("siteSettings.ogImageMediaId", sources.siteSettings.ogImageMediaId, "image");
  }

  if (sources.page?.seo) {
    pushRef("page.seo.ogImageMediaId", sources.page.seo.ogImageMediaId, "image");
  }

  if (sources.post) {
    pushRef("post.coverMediaId", sources.post.coverMediaId, "image");
    pushRef("post.seo.ogImageMediaId", sources.post.seo?.ogImageMediaId, "image");
    sources.post.body.blocks.forEach((block, idx) => {
      if (block.mediaId !== undefined) {
        pushRef(`post.body.blocks[${idx}].mediaId`, block.mediaId, "image");
      }
    });
  }

  if (sources.offering) {
    pushRef("offering.coverMediaId", sources.offering.coverMediaId, "image");
    sources.offering.galleryMediaIds.forEach((id, idx) => {
      pushRef(`offering.galleryMediaIds[${idx}]`, id, "image");
    });
    pushRef("offering.videoMediaId", sources.offering.videoMediaId, "video");
    pushRef("offering.seo.ogImageMediaId", sources.offering.seo?.ogImageMediaId, "image");
  }

  if (sources.extraMediaIds) {
    sources.extraMediaIds.forEach((id, idx) => {
      pushRef(`draftOverride.mediaIds[${idx}]`, id);
    });
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Mandatory Preview Response Headers (PLAN §14 & TASK-050)
// ---------------------------------------------------------------------------

export function buildPreviewResponseHeaders(
  options: {
    readonly contentType?: string;
    readonly csp?: string;
    readonly extraHeaders?: HeadersInit;
  } = {},
): Headers {
  const headers = new Headers(options.extraHeaders);
  if (options.contentType) {
    headers.set("Content-Type", options.contentType);
  }
  headers.set("Cache-Control", PREVIEW_CACHE_CONTROL_HEADER);
  headers.set("Pragma", PREVIEW_PRAGMA_HEADER);
  headers.set("X-Robots-Tag", PREVIEW_ROBOTS_HEADER);
  headers.set(PREVIEW_HEADER_NAME, "1");
  headers.set(PREVIEW_CACHE_STATUS_HEADER_NAME, "BYPASS");
  headers.set("Vary", "Cookie, Authorization, Accept-Encoding");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Content-Security-Policy", options.csp ?? PREVIEW_HTML_CSP_HEADER);
  return headers;
}

export function applyStrictPreviewHeaders(
  response: Response,
  options: { readonly csp?: string } = {},
): Response {
  const headers = buildPreviewResponseHeaders({
    csp: options.csp,
    extraHeaders: response.headers,
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Inert Preview HTML Neutralizer (PLAN §14 & TASK-050)
// ---------------------------------------------------------------------------

const INERT_PREVIEW_HEAD_STYLE = `<style data-preview-inert-style="1">
a[data-preview-inert="link"] { cursor: not-allowed; }
form[data-preview-inert="form"] { pointer-events: none; opacity: 0.92; }
</style>`;

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function neutralizeAnchorTag(fullTag: string): string {
  const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(fullTag);
  if (!hrefMatch) {
    return fullTag;
  }
  const rawHref = (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "").trim();

  // Preserve safe in-page fragment anchors (#main-content, #layanan) for keyboard skip-link
  if (/^#[A-Za-z0-9_-]{1,80}$/.test(rawHref)) {
    return fullTag.replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  }

  // Neutralize every navigational / external / protocol link so clicks NEVER navigate
  let updated = fullTag
    .replace(/\s+href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+ping\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  const inertAttrs = ` data-preview-inert="link" data-preview-href="${escapeHtmlAttr(rawHref)}" aria-disabled="true" role="link" tabindex="-1"`;
  if (updated.endsWith("/>")) {
    updated = `${updated.slice(0, -2)}${inertAttrs} />`;
  } else if (updated.endsWith(">")) {
    updated = `${updated.slice(0, -1)}${inertAttrs}>`;
  }
  return updated;
}

function neutralizeFormTag(fullTag: string): string {
  let updated = fullTag
    .replace(/\s+action\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+method\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  const inertAttrs = ' data-preview-inert="form" aria-disabled="true"';
  if (updated.endsWith("/>")) {
    updated = `${updated.slice(0, -2)}${inertAttrs} />`;
  } else if (updated.endsWith(">")) {
    updated = `${updated.slice(0, -1)}${inertAttrs}>`;
  }
  return updated;
}

function neutralizeSubmitControl(fullTag: string): string {
  let updated = fullTag
    .replace(/\s+formaction\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+formtarget\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+formmethod\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  const isSubmit =
    /\btype\s*=\s*(?:"submit"|'submit'|submit\b)/i.test(updated) ||
    (/^<\s*button\b/i.test(updated) && !/\btype\s*=/i.test(updated));

  if (isSubmit && !/\bdisabled\b/i.test(updated)) {
    const attrs = ' disabled data-preview-inert="submit"';
    if (updated.endsWith("/>")) {
      updated = `${updated.slice(0, -2)}${attrs} />`;
    } else if (updated.endsWith(">")) {
      updated = `${updated.slice(0, -1)}${attrs}>`;
    }
  }
  return updated;
}

/**
 * Post-processes rendered Astro theme HTML for strict in-process preview isolation (PLAN §14):
 * - Strips ALL `<script>`, `<iframe|object|embed|base>`, tracking `<noscript>` blocks,
 *   `<meta http-equiv="refresh">`, `<link rel="canonical">`, and inline `on*=` event handlers.
 * - Neutralizes ALL `<form>` actions & submit buttons so no form can submit.
 * - Neutralizes ALL external/path `<a href=...>` links so clicks never navigate out of preview.
 * - Ensures `<meta name="robots" content="noindex, nofollow">` and `<meta http-equiv="Content-Security-Policy">`
 *   exist in `<head>` for defense-in-depth inside `srcdoc` iframes.
 */
export function neutralizePreviewHtml(rawHtml: string): string {
  let html = rawHtml;

  // 1. Strip all <script>, <iframe>, <object>, <embed>, <applet>, and <noscript> blocks
  //    (eliminates Astro inline scripts, GTM/GA4/Meta/TikTok tracking snippets, and noscript pixels).
  html = html.replace(
    /<\s*(script|iframe|object|embed|applet|noscript)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    "",
  );
  html = html.replace(
    /<\s*\/?\s*(script|iframe|object|embed|applet|base|noscript)\b[^>]*>/gi,
    "",
  );

  // 2. Strip <meta http-equiv="refresh"> and <link rel="canonical"> (PLAN §15.2: preview has no public canonical)
  html = html.replace(/<\s*meta\b[^>]*http-equiv\s*=\s*(?:"refresh"|'refresh'|refresh\b)[^>]*>/gi, "");
  html = html.replace(/<\s*link\b[^>]*rel\s*=\s*(?:"canonical"|'canonical'|canonical\b)[^>]*>/gi, "");

  // 3. Strip inline event handlers (onclick=, onload=, onerror=, onsubmit=, etc.)
  html = html.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // 4. Neutralize javascript:/vbscript:/data: URIs in href/src/action/formaction attributes
  html = html.replace(
    /\b(href|src|action|formaction)\s*=\s*(?:"\s*(?:javascript|vbscript):[^"]*"|'\s*(?:javascript|vbscript):[^']*')/gi,
    '$1=""',
  );

  // 5. Neutralize <form> tags and submit buttons
  html = html.replace(/<\s*form\b[^>]*>/gi, neutralizeFormTag);
  html = html.replace(/<\s*(?:button|input)\b[^>]*>/gi, neutralizeSubmitControl);

  // 6. Neutralize external and path <a href="..."> links (preserve #in-page anchors)
  html = html.replace(/<\s*a\b[^>]*>/gi, neutralizeAnchorTag);

  // 7. Ensure robots noindex + preview CSP meta tags + inert styling exist in <head>
  const headInjections: string[] = [];
  if (!/<\s*meta\b[^>]*name\s*=\s*(?:"robots"|'robots')/i.test(html)) {
    headInjections.push('<meta name="robots" content="noindex, nofollow" />');
  }
  if (!/<\s*meta\b[^>]*http-equiv\s*=\s*(?:"Content-Security-Policy"|'Content-Security-Policy')/i.test(html)) {
    headInjections.push(
      `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(PREVIEW_META_CSP_CONTENT)}" />`,
    );
  }
  if (!html.includes('data-preview-inert-style="1"')) {
    headInjections.push(INERT_PREVIEW_HEAD_STYLE);
  }

  if (headInjections.length > 0) {
    const snippet = `\n${headInjections.join("\n")}\n`;
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${snippet}</head>`);
    } else {
      html = `${snippet}${html}`;
    }
  }

  return html;
}

import { stripHtmlToPlainText } from "@punyasitus/core/content/index";
import { normalizeTitleToSlug } from "@punyasitus/core/slug/index";
import { guardedFetch, validateSsrfUrl } from "./ssrf.ts";
import { extractInlineImagesFromWpHtml } from "./tiptap.ts";
import {
  WP_IMPORTER_LIMITS,
  WpImporterError,
  type WpImporterFetchPort,
  type WpImportWarning,
  type WpParsedImageRef,
  type WpParsedPost,
  type WpParsedSeoMeta,
  type WpParsedTaxonomy,
  type WpSourceParseResult,
} from "./types.ts";

/**
 * SSRF-Guarded WordPress REST API (`/wp-json/wp/v2`) Fetcher (`TASK-100`, `REQ-100`).
 *
 * - Normalizes either a bare WP site URL (`https://blog.example.co.id`) or a `/wp-json/wp/v2`
 *   endpoint URL.
 * - Validates base URL and every redirect hop with `validateSsrfUrl` / `guardedFetch`.
 * - Fetches public posts (`_embed=1`), categories, tags, featured images, and public
 *   Yoast/RankMath SEO metadata when exposed in REST responses.
 */

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

interface RawWpRenderedField {
  readonly rendered?: unknown;
}

interface RawWpTerm {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly slug?: unknown;
  readonly description?: unknown;
  readonly taxonomy?: unknown;
  readonly parent?: unknown;
}

interface RawWpMedia {
  readonly source_url?: unknown;
  readonly alt_text?: unknown;
  readonly title?: RawWpRenderedField;
}

interface RawWpYoastHeadJson {
  readonly title?: unknown;
  readonly description?: unknown;
  readonly og_title?: unknown;
  readonly og_description?: unknown;
}

interface RawWpPost {
  readonly id?: unknown;
  readonly slug?: unknown;
  readonly status?: unknown;
  readonly link?: unknown;
  readonly title?: RawWpRenderedField;
  readonly content?: RawWpRenderedField;
  readonly excerpt?: RawWpRenderedField;
  readonly categories?: unknown;
  readonly tags?: unknown;
  readonly yoast_head_json?: RawWpYoastHeadJson;
  readonly rank_math?: Readonly<Record<string, unknown>>;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly _embedded?: {
    readonly "wp:featuredmedia"?: readonly RawWpMedia[];
    readonly "wp:term"?: readonly (readonly RawWpTerm[])[];
  };
}

export function normalizeWpJsonBaseApiUrl(
  rawSiteUrl: string,
  options: { readonly allowHttp?: boolean } = {},
): { readonly siteOriginUrl: string; readonly apiBaseUrl: string } {
  const validated = validateSsrfUrl(
    rawSiteUrl,
    { allowHttp: options.allowHttp },
    "URL situs WordPress",
  );
  const url = new URL(validated.normalizedHref);
  url.search = "";
  url.hash = "";

  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/wp-json/wp/v2")) {
    const apiBaseUrl = `${url.origin}${path}`;
    const sitePath = path.slice(0, -"/wp-json/wp/v2".length);
    return {
      siteOriginUrl: `${url.origin}${sitePath}`,
      apiBaseUrl,
    };
  }
  if (path.endsWith("/wp-json")) {
    const apiBaseUrl = `${url.origin}${path}/wp/v2`;
    const sitePath = path.slice(0, -"/wp-json".length);
    return {
      siteOriginUrl: `${url.origin}${sitePath}`,
      apiBaseUrl,
    };
  }
  if (path === "/") path = "";
  return {
    siteOriginUrl: `${url.origin}${path}`,
    apiBaseUrl: `${url.origin}${path}/wp-json/wp/v2`,
  };
}

function asString(val: unknown): string {
  return typeof val === "string" ? val : "";
}

function extractRestSeoMeta(post: RawWpPost): WpParsedSeoMeta | null {
  const yoast = post.yoast_head_json;
  const rm = post.rank_math;
  const meta = post.meta;

  const titleOverride =
    asString(yoast?.title) ||
    asString(rm?.title) ||
    asString(meta?._yoast_wpseo_title) ||
    asString(meta?.rank_math_title) ||
    null;

  const descriptionOverride =
    asString(yoast?.description) ||
    asString(rm?.description) ||
    asString(meta?._yoast_wpseo_metadesc) ||
    asString(meta?.rank_math_description) ||
    null;

  const focusKeyphrase =
    asString(rm?.focus_keyword) ||
    asString(meta?._yoast_wpseo_focuskw) ||
    asString(meta?.rank_math_focus_keyword) ||
    null;

  const ogTitleOverride =
    asString(yoast?.og_title) ||
    asString(rm?.facebook_title) ||
    asString(meta?._yoast_wpseo_opengraph_title) ||
    null;

  const ogDescriptionOverride =
    asString(yoast?.og_description) ||
    asString(rm?.facebook_description) ||
    asString(meta?._yoast_wpseo_opengraph_description) ||
    null;

  if (
    !titleOverride &&
    !descriptionOverride &&
    !focusKeyphrase &&
    !ogTitleOverride &&
    !ogDescriptionOverride
  ) {
    return null;
  }

  return {
    titleOverride,
    descriptionOverride,
    focusKeyphrase,
    ogTitleOverride,
    ogDescriptionOverride,
  };
}

async function fetchJsonArray(
  url: string,
  options: {
    readonly fetchImpl?: WpImporterFetchPort;
    readonly allowHttp?: boolean;
    readonly contextLabel: string;
    readonly optional?: boolean;
  },
): Promise<{ readonly items: readonly unknown[]; readonly totalPages: number } | null> {
  const res = await guardedFetch(url, {
    fetchImpl: options.fetchImpl,
    allowHttp: options.allowHttp,
    maxBytes: WP_IMPORTER_LIMITS.maxWpJsonResponseBytes,
    accept: "application/json",
    contextLabel: options.contextLabel,
  });

  if (res.status === 400 || res.status === 404) {
    if (options.optional) return null;
    throw new WpImporterError(
      422,
      "WP_JSON_INVALID",
      `Endpoint WordPress ${options.contextLabel} mengembalikan status HTTP ${res.status}. Pastikan REST API WordPress aktif dan publik.`,
      { status: res.status, url: res.finalUrl },
    );
  }

  if (res.status < 200 || res.status >= 300) {
    if (options.optional) return null;
    throw new WpImporterError(
      502,
      "FETCH_FAILED",
      `Server WordPress mengembalikan status HTTP ${res.status} untuk ${options.contextLabel}.`,
      { status: res.status, url: res.finalUrl },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(TEXT_DECODER.decode(res.bytes));
  } catch {
    if (options.optional) return null;
    throw new WpImporterError(
      422,
      "WP_JSON_INVALID",
      `Respons ${options.contextLabel} bukan JSON WordPress yang valid.`,
    );
  }

  if (!Array.isArray(parsed)) {
    if (options.optional) return null;
    throw new WpImporterError(
      422,
      "WP_JSON_INVALID",
      `Respons ${options.contextLabel} tidak berupa daftar array JSON.`,
    );
  }

  const totalPagesHeader = Number(res.headers.get("x-wp-totalpages") ?? "1");
  const totalPages =
    Number.isFinite(totalPagesHeader) && totalPagesHeader >= 1
      ? Math.min(Math.floor(totalPagesHeader), WP_IMPORTER_LIMITS.maxWpJsonPages)
      : 1;

  return { items: parsed, totalPages };
}

export interface FetchWpJsonOptions {
  readonly fetchImpl?: WpImporterFetchPort;
  readonly maxPosts?: number;
  readonly allowHttp?: boolean;
}

export async function fetchWpJsonSite(
  rawSiteUrl: string,
  options: FetchWpJsonOptions = {},
): Promise<WpSourceParseResult> {
  const { siteOriginUrl, apiBaseUrl } = normalizeWpJsonBaseApiUrl(rawSiteUrl, {
    allowHttp: options.allowHttp,
  });

  const maxPosts = Math.min(
    Math.max(1, options.maxPosts ?? WP_IMPORTER_LIMITS.maxImportPosts),
    WP_IMPORTER_LIMITS.maxImportPosts,
  );
  const perPage = Math.min(WP_IMPORTER_LIMITS.wpJsonPerPage, maxPosts);
  const warnings: WpImportWarning[] = [];

  // 1. Best-effort fetch of public categories & tags (optional if disabled on site)
  const categoryById = new Map<number, WpParsedTaxonomy>();
  const categoryBySlug = new Map<string, WpParsedTaxonomy>();
  const rawParentIdBySlug = new Map<string, number>();

  try {
    const catResp = await fetchJsonArray(`${apiBaseUrl}/categories?per_page=100`, {
      fetchImpl: options.fetchImpl,
      allowHttp: options.allowHttp,
      contextLabel: "kategori WordPress",
      optional: true,
    });
    if (catResp) {
      for (const entry of catResp.items) {
        const raw = entry as RawWpTerm;
        const id = Number(raw.id);
        const name = stripHtmlToPlainText(asString(raw.name)).slice(
          0,
          WP_IMPORTER_LIMITS.maxTaxonomyNameLength,
        );
        if (!name) continue;
        const slug = normalizeTitleToSlug(asString(raw.slug) || name, { fallbackPrefix: "kategori" });
        const description =
          stripHtmlToPlainText(asString(raw.description)).slice(0, 500) || null;
        const tax: WpParsedTaxonomy = {
          kind: "category",
          sourceId: Number.isFinite(id) ? id : undefined,
          name,
          slug,
          description,
        };
        if (Number.isFinite(id) && id > 0) categoryById.set(id, tax);
        if (!categoryBySlug.has(slug)) categoryBySlug.set(slug, tax);
        const parentId = Number(raw.parent ?? 0);
        if (Number.isFinite(parentId) && parentId > 0) {
          rawParentIdBySlug.set(slug, parentId);
        }
      }
      // Resolve parentSlug for nested categories
      for (const [slug, parentId] of rawParentIdBySlug.entries()) {
        const parent = categoryById.get(parentId);
        const current = categoryBySlug.get(slug);
        if (parent && current) {
          const updated: WpParsedTaxonomy = { ...current, parentSlug: parent.slug };
          categoryBySlug.set(slug, updated);
          if (typeof current.sourceId === "number") {
            categoryById.set(current.sourceId, updated);
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof WpImporterError && (err.code === "SSRF_BLOCKED" || err.code === "SSRF_REDIRECT_BLOCKED")) {
      throw err;
    }
    warnings.push({
      code: "WP_CATEGORIES_UNAVAILABLE",
      message: "Daftar kategori WordPress tidak dapat dimuat; menggunakan kategori tertanam dari artikel.",
    });
  }

  const tagById = new Map<number, WpParsedTaxonomy>();
  const tagBySlug = new Map<string, WpParsedTaxonomy>();
  try {
    const tagResp = await fetchJsonArray(`${apiBaseUrl}/tags?per_page=100`, {
      fetchImpl: options.fetchImpl,
      allowHttp: options.allowHttp,
      contextLabel: "tag WordPress",
      optional: true,
    });
    if (tagResp) {
      for (const entry of tagResp.items) {
        const raw = entry as RawWpTerm;
        const id = Number(raw.id);
        const name = stripHtmlToPlainText(asString(raw.name)).slice(
          0,
          WP_IMPORTER_LIMITS.maxTaxonomyNameLength,
        );
        if (!name) continue;
        const slug = normalizeTitleToSlug(asString(raw.slug) || name, { fallbackPrefix: "tag" });
        const tax: WpParsedTaxonomy = {
          kind: "tag",
          sourceId: Number.isFinite(id) ? id : undefined,
          name,
          slug,
        };
        if (Number.isFinite(id) && id > 0) tagById.set(id, tax);
        if (!tagBySlug.has(slug)) tagBySlug.set(slug, tax);
      }
    }
  } catch (err) {
    if (err instanceof WpImporterError && (err.code === "SSRF_BLOCKED" || err.code === "SSRF_REDIRECT_BLOCKED")) {
      throw err;
    }
    warnings.push({
      code: "WP_TAGS_UNAVAILABLE",
      message: "Daftar tag WordPress tidak dapat dimuat; menggunakan tag tertanam dari artikel.",
    });
  }

  // 2. Paginated fetch of `/wp-json/wp/v2/posts?_embed=1`
  const posts: WpParsedPost[] = [];
  let skippedItems = 0;

  for (let page = 1; page <= WP_IMPORTER_LIMITS.maxWpJsonPages; page += 1) {
    if (posts.length >= maxPosts) break;
    const postsUrl = `${apiBaseUrl}/posts?per_page=${perPage}&page=${page}&_embed=1`;
    const pageResp = await fetchJsonArray(postsUrl, {
      fetchImpl: options.fetchImpl,
      allowHttp: options.allowHttp,
      contextLabel: `artikel WordPress halaman ${page}`,
      optional: page > 1,
    });
    if (!pageResp || pageResp.items.length === 0) break;

    for (const rawEntry of pageResp.items) {
      if (posts.length >= maxPosts) {
        skippedItems += 1;
        continue;
      }
      const raw = rawEntry as RawWpPost;
      const sourceId = raw.id !== undefined ? String(raw.id) : `wp-${posts.length + 1}`;
      const rawTitle = stripHtmlToPlainText(asString(raw.title?.rendered)).slice(
        0,
        WP_IMPORTER_LIMITS.maxTitleLength,
      );
      const title = rawTitle || `Artikel WordPress ${sourceId}`;
      const rawSlug = asString(raw.slug);
      const sourceSlug = normalizeTitleToSlug(rawSlug || title, { fallbackPrefix: "artikel" });
      const sourceStatus = asString(raw.status).toLowerCase() || "publish";
      const sourceUrl = asString(raw.link) || `${siteOriginUrl}/${sourceSlug}/`;
      let sourcePath = `/${sourceSlug}`;
      try {
        sourcePath = new URL(sourceUrl).pathname || `/${sourceSlug}`;
      } catch {
        // fallback kept
      }

      const rawHtml = asString(raw.content?.rendered);
      const excerpt =
        stripHtmlToPlainText(asString(raw.excerpt?.rendered)).slice(
          0,
          WP_IMPORTER_LIMITS.maxExcerptLength,
        ) || null;

      // Resolve post categories & tags from _embedded['wp:term'] + top-level ID maps
      const postCats: WpParsedTaxonomy[] = [];
      const postTags: WpParsedTaxonomy[] = [];

      const embeddedTerms = raw._embedded?.["wp:term"];
      if (Array.isArray(embeddedTerms)) {
        for (const group of embeddedTerms) {
          if (!Array.isArray(group)) continue;
          for (const term of group) {
            const taxName = asString(term.taxonomy).toLowerCase();
            const label = stripHtmlToPlainText(asString(term.name)).slice(
              0,
              WP_IMPORTER_LIMITS.maxTaxonomyNameLength,
            );
            if (!label) continue;
            if (taxName === "category") {
              const slug = normalizeTitleToSlug(asString(term.slug) || label, { fallbackPrefix: "kategori" });
              const tax: WpParsedTaxonomy = categoryBySlug.get(slug) ?? {
                kind: "category",
                sourceId: typeof term.id === "number" ? term.id : undefined,
                name: label,
                slug,
              };
              if (!categoryBySlug.has(slug)) categoryBySlug.set(slug, tax);
              if (!postCats.some((c) => c.slug === slug)) postCats.push(tax);
            } else if (taxName === "post_tag") {
              const slug = normalizeTitleToSlug(asString(term.slug) || label, { fallbackPrefix: "tag" });
              const tax: WpParsedTaxonomy = tagBySlug.get(slug) ?? {
                kind: "tag",
                sourceId: typeof term.id === "number" ? term.id : undefined,
                name: label,
                slug,
              };
              if (!tagBySlug.has(slug)) tagBySlug.set(slug, tax);
              if (!postTags.some((t) => t.slug === slug)) postTags.push(tax);
            }
          }
        }
      }

      if (Array.isArray(raw.categories)) {
        for (const idVal of raw.categories) {
          const cat = categoryById.get(Number(idVal));
          if (cat && !postCats.some((c) => c.slug === cat.slug)) {
            postCats.push(cat);
          }
        }
      }
      if (Array.isArray(raw.tags)) {
        for (const idVal of raw.tags) {
          const tag = tagById.get(Number(idVal));
          if (tag && !postTags.some((t) => t.slug === tag.slug)) {
            postTags.push(tag);
          }
        }
      }

      // Featured image from `_embedded['wp:featuredmedia'][0]`
      let featuredImage: WpParsedImageRef | null = null;
      const embeddedMedia = raw._embedded?.["wp:featuredmedia"];
      if (Array.isArray(embeddedMedia) && embeddedMedia.length > 0) {
        const firstMedia = embeddedMedia[0];
        const mediaUrl = asString(firstMedia?.source_url).trim();
        if (mediaUrl) {
          const alt =
            stripHtmlToPlainText(
              asString(firstMedia?.alt_text) || asString(firstMedia?.title?.rendered),
            ).slice(0, 250) || title;
          featuredImage = {
            sourceUrl: mediaUrl,
            altText: alt,
            role: "featured",
          };
        }
      }

      const inlineImages = extractInlineImagesFromWpHtml(
        rawHtml,
        siteOriginUrl,
        WP_IMPORTER_LIMITS.maxImagesPerPost,
      );

      const seo = extractRestSeoMeta(raw);

      posts.push({
        sourceId,
        sourceUrl,
        sourcePath,
        sourceSlug,
        sourceStatus,
        title,
        excerpt,
        rawHtml,
        categories: postCats.slice(0, WP_IMPORTER_LIMITS.maxCategoriesPerPost),
        tags: postTags.slice(0, WP_IMPORTER_LIMITS.maxTagsPerPost),
        featuredImage,
        inlineImages,
        seo,
      });
    }

    if (page >= pageResp.totalPages) break;
  }

  return {
    sourceKind: "wp_json",
    sourceLabel: siteOriginUrl,
    siteUrl: siteOriginUrl,
    posts,
    categories: [...categoryBySlug.values()],
    tags: [...tagBySlug.values()],
    skippedItems,
    warnings,
  };
}

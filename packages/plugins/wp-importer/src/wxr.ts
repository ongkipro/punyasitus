import { stripHtmlToPlainText } from "@punyasitus/core/content/index";
import { normalizeTitleToSlug } from "@punyasitus/core/slug/index";
import { extractInlineImagesFromWpHtml } from "./tiptap.ts";
import {
  WP_IMPORTER_LIMITS,
  WpImporterError,
  type WpImportWarning,
  type WpParsedImageRef,
  type WpParsedPost,
  type WpParsedSeoMeta,
  type WpParsedTaxonomy,
  type WpSourceParseResult,
} from "./types.ts";

/**
 * XXE & XML-Bomb-Guarded WordPress WXR (eXtended RSS) Parser (`TASK-100`, `REQ-100`).
 *
 * Security invariants:
 * - Strictly rejects `<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, `<!ATTLIST`, `<!NOTATION`
 *   (blocks XXE, external DTDs, and Billion Laughs entity expansion bombs).
 * - Strictly rejects non-predefined XML entity references (`&lol;`, `&xxe;`, etc.) outside
 *   CDATA blocks.
 * - Enforces hard byte ceiling (`maxWxrBytes`), element count ceiling (`maxWxrElements`),
 *   and post item count ceiling (`maxPosts`).
 * - Linear O(n) scanning with explicit CDATA handling; zero catastrophic backtracking regexes.
 */

const TEXT_ENCODER = new TextEncoder();

const PREDEFINED_XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeSafeXmlText(text: string): string {
  if (!text || !text.includes("&")) return text;
  return text.replace(
    /&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z][a-zA-Z0-9._-]{0,31}));/g,
    (full, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (hex !== undefined) {
        const cp = Number.parseInt(hex, 16);
        if (cp >= 0x09 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
          return String.fromCodePoint(cp);
        }
        return "";
      }
      if (dec !== undefined) {
        const cp = Number.parseInt(dec, 10);
        if (cp >= 0x09 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
          return String.fromCodePoint(cp);
        }
        return "";
      }
      if (named !== undefined) {
        const mapped = PREDEFINED_XML_ENTITIES[named];
        if (mapped !== undefined) return mapped;
      }
      return full;
    },
  );
}

/**
 * Strips `<![CDATA[...]]>` spans (recording any unclosed CDATA as malformed) so we can
 * inspect XML structure outside CDATA for DTD/ENTITY declarations and custom entities.
 */
function stripCdataBlocksChecked(xml: string): string {
  const parts: string[] = [];
  let i = 0;
  const len = xml.length;
  while (i < len) {
    const cdataStart = xml.indexOf("<![CDATA[", i);
    if (cdataStart === -1) {
      parts.push(xml.slice(i));
      break;
    }
    parts.push(xml.slice(i, cdataStart));
    const cdataEnd = xml.indexOf("]]>", cdataStart + 9);
    if (cdataEnd === -1) {
      throw new WpImporterError(
        422,
        "WXR_MALFORMED",
        "File WXR XML tidak valid: blok CDATA tidak ditutup.",
      );
    }
    i = cdataEnd + 3;
  }
  return parts.join("");
}

/**
 * Validates raw WXR XML payload for size, XXE/DTD declarations, custom entity expansion,
 * NUL bytes, element count bounds, and basic WXR RSS structure.
 */
export function guardWxrXmlPayload(
  rawXml: string,
  options: { readonly maxBytes?: number; readonly maxElements?: number } = {},
): void {
  if (typeof rawXml !== "string" || rawXml.trim().length === 0) {
    throw new WpImporterError(422, "WXR_MALFORMED", "Isi file WXR XML kosong.");
  }

  const maxBytes = options.maxBytes ?? WP_IMPORTER_LIMITS.maxWxrBytes;
  const byteLength = TEXT_ENCODER.encode(rawXml).byteLength;
  if (byteLength > maxBytes) {
    throw new WpImporterError(
      413,
      "WXR_TOO_LARGE",
      `Ukuran file WXR (${byteLength} byte) melebihi batas maksimal ${maxBytes} byte.`,
      { byteLength, maxBytes },
    );
  }

  if (rawXml.includes("\0")) {
    throw new WpImporterError(422, "WXR_MALFORMED", "File WXR mengandung karakter NUL ilegal.");
  }

  // Strip valid CDATA payloads before checking XML declarations & entity references
  const outsideCdata = stripCdataBlocksChecked(rawXml);

  // Hard XXE & XML Bomb guard: reject ANY DTD/ENTITY declaration
  if (/<!\s*(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)\b/i.test(outsideCdata)) {
    throw new WpImporterError(
      422,
      "WXR_XXE_FORBIDDEN",
      "Deklarasi XML DOCTYPE/ENTITY (XXE/XML bomb) diblokir demi keamanan.",
    );
  }

  // Reject custom entity references outside the 5 XML predefined entities & numeric char refs
  const entityRefRe = /&([a-zA-Z_][a-zA-Z0-9._-]*);/g;
  let entMatch: RegExpExecArray | null;
  while ((entMatch = entityRefRe.exec(outsideCdata)) !== null) {
    const name = entMatch[1]!;
    if (!(name in PREDEFINED_XML_ENTITIES)) {
      throw new WpImporterError(
        422,
        "WXR_ENTITY_EXPANSION_FORBIDDEN",
        `Referensi entitas XML kustom "&${name};" diblokir untuk mencegah ekspansi entitas.`,
        { entity: name },
      );
    }
  }

  // Count opening tags linearly to block node-explosion DoS
  const maxElements = options.maxElements ?? WP_IMPORTER_LIMITS.maxWxrElements;
  let tagCount = 0;
  for (let i = 0; i < outsideCdata.length; i += 1) {
    if (outsideCdata.charCodeAt(i) === 0x3c /* < */) {
      const next = outsideCdata.charCodeAt(i + 1);
      if (next !== 0x2f /* / */ && next !== 0x3f /* ? */ && next !== 0x21 /* ! */) {
        tagCount += 1;
        if (tagCount > maxElements) {
          throw new WpImporterError(
            422,
            "WXR_TOO_MANY_ITEMS",
            `Jumlah elemen XML melebihi batas maksimal ${maxElements}.`,
          );
        }
      }
    }
  }

  // Require basic RSS/channel structure
  if (!/<rss\b/i.test(outsideCdata) || !/<channel\b/i.test(outsideCdata)) {
    throw new WpImporterError(
      422,
      "WXR_MALFORMED",
      "Format bukan ekspor WordPress WXR yang valid (elemen <rss>/<channel> tidak ditemukan).",
    );
  }

  const openItems = (outsideCdata.match(/<item(?:\s[^>]*)?>/gi) ?? []).length;
  const closeItems = (outsideCdata.match(/<\/item\s*>/gi) ?? []).length;
  if (openItems !== closeItems) {
    throw new WpImporterError(
      422,
      "WXR_MALFORMED",
      "File WXR XML tidak valid: tag <item> tidak seimbang.",
    );
  }
}

/**
 * Extracts all occurrences of `<tagName ...>inner</tagName>` in strict linear O(n) time
 * while skipping `<![CDATA[...]]>` spans using a single monotonic CDATA cursor (never
 * rescanning the document when CDATA blocks are absent).
 */
function extractTagBlocks(
  xml: string,
  tagName: string,
  maxBlocks: number = WP_IMPORTER_LIMITS.maxWxrElements,
): { readonly attrsRaw: string; readonly inner: string }[] {
  const results: { readonly attrsRaw: string; readonly inner: string }[] = [];
  const lowerXml = xml.toLowerCase();
  const openPrefix = `<${tagName.toLowerCase()}`;
  const closeTag = `</${tagName.toLowerCase()}>`;

  let pos = 0;
  const len = xml.length;
  // Single monotonic cursor for CDATA start positions: O(n) total even on 5 MiB XML with 0 CDATA!
  let nextCdataPos = xml.indexOf("<![CDATA[", 0);

  const advanceCdataCursor = (from: number): number => {
    if (nextCdataPos !== -1 && nextCdataPos < from) {
      nextCdataPos = xml.indexOf("<![CDATA[", from);
    }
    return nextCdataPos;
  };

  while (pos < len && results.length < maxBlocks) {
    const nextOpen = lowerXml.indexOf(openPrefix, pos);
    if (nextOpen === -1) break;

    const cdataIdx = advanceCdataCursor(pos);
    if (cdataIdx !== -1 && cdataIdx < nextOpen) {
      const cdataEnd = xml.indexOf("]]>", cdataIdx + 9);
      if (cdataEnd === -1) break;
      pos = cdataEnd + 3;
      continue;
    }

    const afterNameIdx = nextOpen + openPrefix.length;
    const afterChar = xml[afterNameIdx];
    if (afterChar !== ">" && afterChar !== "/" && !/\s/.test(afterChar ?? "")) {
      pos = afterNameIdx;
      continue;
    }

    const openEnd = xml.indexOf(">", afterNameIdx);
    if (openEnd === -1) break;

    const attrsRaw = xml.slice(afterNameIdx, openEnd);
    if (attrsRaw.trim().endsWith("/")) {
      results.push({ attrsRaw: attrsRaw.replace(/\/\s*$/, ""), inner: "" });
      pos = openEnd + 1;
      continue;
    }

    // Find matching closing tag while skipping CDATA using the same monotonic cursor
    let searchPos = openEnd + 1;
    let closeStart = -1;
    while (searchPos < len) {
      const candidateClose = lowerXml.indexOf(closeTag, searchPos);
      if (candidateClose === -1) break;
      const innerCdata = advanceCdataCursor(searchPos);
      if (innerCdata !== -1 && innerCdata < candidateClose) {
        const innerCdataEnd = xml.indexOf("]]>", innerCdata + 9);
        if (innerCdataEnd === -1) break;
        searchPos = innerCdataEnd + 3;
        continue;
      }
      closeStart = candidateClose;
      break;
    }

    if (closeStart === -1) break;
    results.push({ attrsRaw, inner: xml.slice(openEnd + 1, closeStart) });
    pos = closeStart + closeTag.length;
  }

  return results;
}

/**
 * Unwraps CDATA or XML text from a leaf element inner string.
 */
function readXmlLeafValue(inner: string): string {
  if (!inner) return "";
  const parts: string[] = [];
  let i = 0;
  const len = inner.length;
  while (i < len) {
    const cdataStart = inner.indexOf("<![CDATA[", i);
    if (cdataStart === -1) {
      parts.push(decodeSafeXmlText(inner.slice(i)));
      break;
    }
    if (cdataStart > i) {
      parts.push(decodeSafeXmlText(inner.slice(i, cdataStart)));
    }
    const cdataEnd = inner.indexOf("]]>", cdataStart + 9);
    if (cdataEnd === -1) break;
    parts.push(inner.slice(cdataStart + 9, cdataEnd));
    i = cdataEnd + 3;
  }
  return parts.join("").trim();
}

function readFirstLeaf(xml: string, tagName: string): string {
  const blocks = extractTagBlocks(xml, tagName);
  if (blocks.length === 0) return "";
  return readXmlLeafValue(blocks[0]!.inner);
}

function parseXmlAttr(attrsRaw: string, attrName: string): string {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const match = re.exec(attrsRaw);
  return decodeSafeXmlText((match?.[1] ?? match?.[2] ?? "").trim());
}

function extractPathFromUrl(rawUrl: string, fallbackSlug: string): string {
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      return parsed.pathname || `/${fallbackSlug}`;
    } catch {
      if (rawUrl.startsWith("/")) return rawUrl;
    }
  }
  return `/${fallbackSlug}`;
}

/**
 * Parses a WordPress WXR XML export into normalized posts, taxonomies, attachment URLs,
 * and public SEO metadata after running hard XXE / XML-bomb validation.
 */
export function parseWxrExport(
  rawXml: string,
  options: {
    readonly maxPosts?: number;
    readonly maxBytes?: number;
    readonly sourceLabel?: string;
  } = {},
): WpSourceParseResult {
  guardWxrXmlPayload(rawXml, { maxBytes: options.maxBytes });

  const maxPosts = Math.min(
    Math.max(1, options.maxPosts ?? WP_IMPORTER_LIMITS.maxImportPosts),
    WP_IMPORTER_LIMITS.maxImportPosts,
  );

  const channelBlocks = extractTagBlocks(rawXml, "channel");
  if (channelBlocks.length === 0) {
    throw new WpImporterError(422, "WXR_MALFORMED", "Elemen <channel> tidak ditemukan di WXR.");
  }
  const channelXml = channelBlocks[0]!.inner;
  const siteUrl =
    readFirstLeaf(channelXml, "wp:base_blog_url") ||
    readFirstLeaf(channelXml, "wp:base_site_url") ||
    readFirstLeaf(channelXml, "link") ||
    null;

  const warnings: WpImportWarning[] = [];

  // 1. Parse channel-level categories & tags
  const categoryMap = new Map<string, WpParsedTaxonomy>();
  for (const catBlock of extractTagBlocks(channelXml, "wp:category")) {
    const name = stripHtmlToPlainText(readFirstLeaf(catBlock.inner, "wp:cat_name")).slice(
      0,
      WP_IMPORTER_LIMITS.maxTaxonomyNameLength,
    );
    const rawSlug = readFirstLeaf(catBlock.inner, "wp:category_nicename");
    const slug = normalizeTitleToSlug(rawSlug || name, { fallbackPrefix: "kategori" });
    const parentSlug = readFirstLeaf(catBlock.inner, "wp:category_parent") || null;
    const description =
      stripHtmlToPlainText(readFirstLeaf(catBlock.inner, "wp:category_description")).slice(0, 500) ||
      null;
    if (name && !categoryMap.has(slug)) {
      categoryMap.set(slug, {
        kind: "category",
        name,
        slug,
        parentSlug: parentSlug ? normalizeTitleToSlug(parentSlug, { fallbackPrefix: "kategori" }) : null,
        description,
      });
    }
  }

  const tagMap = new Map<string, WpParsedTaxonomy>();
  for (const tagBlock of extractTagBlocks(channelXml, "wp:tag")) {
    const name = stripHtmlToPlainText(readFirstLeaf(tagBlock.inner, "wp:tag_name")).slice(
      0,
      WP_IMPORTER_LIMITS.maxTaxonomyNameLength,
    );
    const rawSlug = readFirstLeaf(tagBlock.inner, "wp:tag_slug");
    const slug = normalizeTitleToSlug(rawSlug || name, { fallbackPrefix: "tag" });
    if (name && !tagMap.has(slug)) {
      tagMap.set(slug, {
        kind: "tag",
        name,
        slug,
      });
    }
  }

  // 2. First pass over <item>s: bounded scan & attachment indexing (`post_id` -> URL + alt text)
  const itemBlocks = extractTagBlocks(channelXml, "item", WP_IMPORTER_LIMITS.maxWxrItems + 1);
  if (itemBlocks.length > WP_IMPORTER_LIMITS.maxWxrItems) {
    throw new WpImporterError(
      422,
      "WXR_TOO_MANY_ITEMS",
      `Jumlah total <item> WXR melebihi batas maksimal ${WP_IMPORTER_LIMITS.maxWxrItems}.`,
    );
  }
  const attachmentById = new Map<string, { readonly url: string; readonly alt: string }>();
  for (const item of itemBlocks) {
    const postType = readFirstLeaf(item.inner, "wp:post_type").toLowerCase();
    if (postType !== "attachment") continue;
    if (attachmentById.size >= WP_IMPORTER_LIMITS.maxWxrAttachments) {
      warnings.push({
        code: "MAX_ATTACHMENTS_LIMIT_REACHED",
        message: `Batas maksimal ${WP_IMPORTER_LIMITS.maxWxrAttachments} lampiran WXR tercapai; lampiran berikutnya tidak diindeks.`,
      });
      break;
    }
    const postId = readFirstLeaf(item.inner, "wp:post_id");
    const attachmentUrl = readFirstLeaf(item.inner, "wp:attachment_url");
    if (!postId || !attachmentUrl) continue;

    let alt = stripHtmlToPlainText(readFirstLeaf(item.inner, "title")).slice(0, 250);
    for (const meta of extractTagBlocks(item.inner, "wp:postmeta")) {
      const k = readFirstLeaf(meta.inner, "wp:meta_key");
      if (k === "_wp_attachment_image_alt") {
        const v = stripHtmlToPlainText(readFirstLeaf(meta.inner, "wp:meta_value")).slice(0, 250);
        if (v) alt = v;
      }
    }
    attachmentById.set(postId, { url: attachmentUrl, alt });
  }

  // 3. Second pass over <item>s: extract blog posts
  const posts: WpParsedPost[] = [];
  let skippedItems = 0;

  for (const item of itemBlocks) {
    const postType = readFirstLeaf(item.inner, "wp:post_type").toLowerCase() || "post";
    if (postType === "attachment") {
      continue;
    }
    if (postType !== "post") {
      skippedItems += 1;
      warnings.push({
        code: "UNSUPPORTED_POST_TYPE_SKIPPED",
        message: `Item dengan tipe WordPress "${postType}" dilewati (hanya artikel blog yang diimpor).`,
      });
      continue;
    }

    const sourceStatus = readFirstLeaf(item.inner, "wp:status").toLowerCase() || "draft";
    if (sourceStatus === "trash" || sourceStatus === "auto-draft") {
      skippedItems += 1;
      continue;
    }

    if (posts.length >= maxPosts) {
      skippedItems += 1;
      warnings.push({
        code: "MAX_POSTS_LIMIT_REACHED",
        message: `Batas maksimal ${maxPosts} artikel per impor tercapai; artikel berikutnya dilewati.`,
      });
      continue;
    }

    const sourceId = readFirstLeaf(item.inner, "wp:post_id") || `wxr-${posts.length + 1}`;
    const rawTitle = stripHtmlToPlainText(readFirstLeaf(item.inner, "title")).slice(
      0,
      WP_IMPORTER_LIMITS.maxTitleLength,
    );
    const title = rawTitle || `Artikel Impor ${sourceId}`;
    const rawSlug = readFirstLeaf(item.inner, "wp:post_name");
    const sourceSlug = normalizeTitleToSlug(rawSlug || title, { fallbackPrefix: "artikel" });
    const sourceUrl = readFirstLeaf(item.inner, "link") || (siteUrl ? `${siteUrl.replace(/\/+$/, "")}/${sourceSlug}/` : `/${sourceSlug}/`);
    const sourcePath = extractPathFromUrl(sourceUrl, sourceSlug);
    const rawHtml = readFirstLeaf(item.inner, "content:encoded");
    const rawExcerpt = stripHtmlToPlainText(readFirstLeaf(item.inner, "excerpt:encoded")).slice(
      0,
      WP_IMPORTER_LIMITS.maxExcerptLength,
    );

    const postCategories: WpParsedTaxonomy[] = [];
    const postTags: WpParsedTaxonomy[] = [];
    for (const catEl of extractTagBlocks(item.inner, "category")) {
      const domain = parseXmlAttr(catEl.attrsRaw, "domain").toLowerCase();
      const nicename = parseXmlAttr(catEl.attrsRaw, "nicename");
      const label = stripHtmlToPlainText(readXmlLeafValue(catEl.inner)).slice(
        0,
        WP_IMPORTER_LIMITS.maxTaxonomyNameLength,
      );
      if (!label) continue;
      if (domain === "category") {
        const slug = normalizeTitleToSlug(nicename || label, { fallbackPrefix: "kategori" });
        const tax: WpParsedTaxonomy = categoryMap.get(slug) ?? {
          kind: "category",
          name: label,
          slug,
        };
        if (!categoryMap.has(slug)) categoryMap.set(slug, tax);
        if (!postCategories.some((c) => c.slug === slug)) postCategories.push(tax);
      } else if (domain === "post_tag") {
        const slug = normalizeTitleToSlug(nicename || label, { fallbackPrefix: "tag" });
        const tax: WpParsedTaxonomy = tagMap.get(slug) ?? {
          kind: "tag",
          name: label,
          slug,
        };
        if (!tagMap.has(slug)) tagMap.set(slug, tax);
        if (!postTags.some((t) => t.slug === slug)) postTags.push(tax);
      }
    }

    // Parse postmeta for Yoast/RankMath SEO and `_thumbnail_id` featured image
    let thumbnailId: string | null = null;
    let seoTitle: string | null = null;
    let seoDesc: string | null = null;
    let seoFocus: string | null = null;
    let ogTitle: string | null = null;
    let ogDesc: string | null = null;

    for (const meta of extractTagBlocks(item.inner, "wp:postmeta")) {
      const key = readFirstLeaf(meta.inner, "wp:meta_key");
      const val = readFirstLeaf(meta.inner, "wp:meta_value");
      if (!val) continue;
      if (key === "_thumbnail_id") thumbnailId = val;
      else if (key === "_yoast_wpseo_title" || key === "rank_math_title") seoTitle = seoTitle ?? val;
      else if (key === "_yoast_wpseo_metadesc" || key === "rank_math_description") seoDesc = seoDesc ?? val;
      else if (key === "_yoast_wpseo_focuskw" || key === "rank_math_focus_keyword") seoFocus = seoFocus ?? val;
      else if (key === "_yoast_wpseo_opengraph-title" || key === "rank_math_facebook_title") ogTitle = ogTitle ?? val;
      else if (key === "_yoast_wpseo_opengraph-description" || key === "rank_math_facebook_description") ogDesc = ogDesc ?? val;
    }

    const attachment = thumbnailId ? attachmentById.get(thumbnailId) : undefined;
    const featuredImage: WpParsedImageRef | null = attachment
      ? { sourceUrl: attachment.url, altText: attachment.alt, role: "featured" }
      : null;

    const inlineImages = extractInlineImagesFromWpHtml(
      rawHtml,
      siteUrl,
      WP_IMPORTER_LIMITS.maxImagesPerPost,
    );

    const seo: WpParsedSeoMeta | null =
      seoTitle || seoDesc || seoFocus || ogTitle || ogDesc
        ? {
            titleOverride: seoTitle,
            descriptionOverride: seoDesc,
            focusKeyphrase: seoFocus,
            ogTitleOverride: ogTitle,
            ogDescriptionOverride: ogDesc,
          }
        : null;

    posts.push({
      sourceId,
      sourceUrl,
      sourcePath,
      sourceSlug,
      sourceStatus,
      title,
      excerpt: rawExcerpt || null,
      rawHtml,
      categories: postCategories.slice(0, WP_IMPORTER_LIMITS.maxCategoriesPerPost),
      tags: postTags.slice(0, WP_IMPORTER_LIMITS.maxTagsPerPost),
      featuredImage,
      inlineImages,
      seo,
    });
  }

  return {
    sourceKind: "wxr",
    sourceLabel: options.sourceLabel ?? (siteUrl ? `WXR (${siteUrl})` : "WXR XML Upload"),
    siteUrl,
    posts,
    categories: [...categoryMap.values()],
    tags: [...tagMap.values()],
    skippedItems,
    warnings,
  };
}

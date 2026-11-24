import {
  decodeHtmlEntities,
  htmlToRestrictedRichTextDoc,
  sanitizeRichTextDoc,
  sanitizeRichTextHtml,
  sanitizeRichTextLinkHref,
  stripHtmlToPlainText,
  type PageSeoOverrides,
  type RestrictedRichTextDoc,
  type RestrictedRichTextNode,
} from "@punyasitus/core/content/index";
import { sanitizeSeoText } from "@punyasitus/core/seo/index";
import type { WpParsedImageRef, WpParsedSeoMeta } from "./types.ts";

/**
 * WordPress HTML -> Sanitized TipTap JSON (`RestrictedRichTextDoc`) Converter
 * (`TASK-100`, `REQ-100`).
 *
 * Security invariants:
 * - Strips Gutenberg comments (`<!-- wp:... -->`), WordPress shortcodes, `<script>`,
 *   `<iframe>`, `<object>`, `<embed>`, `<svg>`, `<style>`, `<form>`, `on*` handlers,
 *   and `javascript:` / `vbscript:` / `data:` URLs completely.
 * - Preserves headings (`h1`->`h2`, `h2..h4`, `h5..h6`->`h4`), paragraphs, lists
 *   (`ul`/`ol`/`li`), blockquotes, safe links (`https:`/`http:`/`/`/`#`), and
 *   imported tenant media images (`/media/<mediaId>` -> `image` block).
 * - Output ALWAYS conforms to `RestrictedRichTextDoc` (`schemaVersion: 1, blocks: [...]`).
 */

const DANGEROUS_TAG_SUBTREE_RE =
  /<(script|style|iframe|object|embed|svg|math|form|template|noscript|applet)\b[^>]*>[\s\S]*?<\/\1>/gi;
const DANGEROUS_SELF_CLOSING_RE =
  /<(?:script|style|iframe|object|embed|svg|math|form|input|button|meta|link|base)\b[^>]*\/?>/gi;
const GUTENBERG_COMMENT_RE = /<!--[\s\S]*?-->/g;
// Unwrap [caption ...]...[/caption] keeping inner img/text; strip other [shortcode ...] tags
const WP_CAPTION_OPEN_RE = /\[caption\b[^\]]*\]/gi;
const WP_CAPTION_CLOSE_RE = /\[\/caption\]/gi;
const WP_SHORTCODE_RE = /\[\/?[a-zA-Z0-9_-]+(?:\s+[^\]]*)?\]/g;

function parseHtmlAttrsSimple(attrText: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const len = attrText.length;
  let i = 0;
  while (i < len) {
    while (i < len && /[\s/]/.test(attrText[i]!)) i += 1;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && /[a-zA-Z0-9:_-]/.test(attrText[i]!)) i += 1;
    const name = attrText.slice(nameStart, i).toLowerCase();
    if (!name) {
      i += 1;
      continue;
    }
    while (i < len && /\s/.test(attrText[i]!)) i += 1;
    if (attrText[i] !== "=") {
      attrs.set(name, "");
      continue;
    }
    i += 1;
    while (i < len && /\s/.test(attrText[i]!)) i += 1;
    let value: string;
    const q = attrText[i];
    if (q === '"' || q === "'") {
      i += 1;
      const valStart = i;
      while (i < len && attrText[i] !== q) i += 1;
      value = attrText.slice(valStart, i);
      if (i < len && attrText[i] === q) i += 1;
    } else {
      const valStart = i;
      while (i < len && !/[\s>]/.test(attrText[i]!)) i += 1;
      value = attrText.slice(valStart, i);
    }
    attrs.set(name, decodeHtmlEntities(value).trim());
  }
  return attrs;
}

/**
 * Strips Gutenberg comments, WordPress shortcodes, and normalizes `h1`/`h5`/`h6`
 * to core-supported `h2`/`h4` heading levels before passing through the core sanitizer.
 */
export function preprocessWordPressHtml(rawHtml: string): string {
  if (!rawHtml || typeof rawHtml !== "string") return "";

  let cleaned = rawHtml
    .replace(GUTENBERG_COMMENT_RE, "\n")
    .replace(WP_CAPTION_OPEN_RE, "")
    .replace(WP_CAPTION_CLOSE_RE, "");

  // Loop dangerous tag stripping until fixed point (defense-in-depth against `<scr<script>ipt>`)
  for (let pass = 0; pass < 10; pass += 1) {
    const next = cleaned
      .replace(DANGEROUS_TAG_SUBTREE_RE, "")
      .replace(DANGEROUS_SELF_CLOSING_RE, "");
    if (next === cleaned) break;
    cleaned = next;
  }

  cleaned = cleaned.replace(WP_SHORTCODE_RE, "");

  // Normalize WordPress heading levels (h1 -> h2, h5/h6 -> h4) so semantic headings survive sanitization
  cleaned = cleaned
    .replace(/<h1\b[^>]*>/gi, "<h2>")
    .replace(/<\/h1>/gi, "</h2>")
    .replace(/<h[56]\b[^>]*>/gi, "<h4>")
    .replace(/<\/h[56]>/gi, "</h4>");

  return cleaned;
}

/**
 * Extracts all candidate `<img>` references from WordPress HTML (after dropping dangerous
 * subtrees like `<script>`/`<noscript>`/`<iframe>`) resolving relative image paths against
 * `baseSiteUrl` when present.
 */
export function extractInlineImagesFromWpHtml(
  rawHtml: string,
  baseSiteUrl: string | null,
  maxImages = 20,
): readonly WpParsedImageRef[] {
  if (!rawHtml || typeof rawHtml !== "string") return [];
  const safePrep = preprocessWordPressHtml(rawHtml);
  const refs: WpParsedImageRef[] = [];
  const seen = new Set<string>();
  const imgRe = /<img\b([^>]*)>/gi;

  let match: RegExpExecArray | null;
  while ((match = imgRe.exec(safePrep)) !== null && refs.length < maxImages) {
    const attrs = parseHtmlAttrsSimple(match[1] ?? "");
    const rawSrc = attrs.get("src") || attrs.get("data-src") || attrs.get("data-lazy-src") || "";
    if (!rawSrc) continue;

    let resolvedUrl = rawSrc.trim();
    if (resolvedUrl.startsWith("//")) {
      resolvedUrl = `https:${resolvedUrl}`;
    } else if (resolvedUrl.startsWith("/") && baseSiteUrl) {
      try {
        resolvedUrl = new URL(resolvedUrl, baseSiteUrl).toString();
      } catch {
        continue;
      }
    }

    if (seen.has(resolvedUrl)) continue;
    seen.add(resolvedUrl);

    const alt = stripHtmlToPlainText(attrs.get("alt") ?? "").slice(0, 250);
    refs.push({
      sourceUrl: resolvedUrl,
      altText: alt,
      role: "inline",
    });
  }

  return refs;
}

/**
 * Rewrites `<img>` tags in WordPress HTML using the map of `sourceUrl -> mediaId`
 * (imported R2 WebP assets) to canonical tenant `/media/<mediaId>` URLs, and drops
 * any unimported/rejected external `<img>` tags so no hotlinked/unverified images leak.
 */
function rewriteWpImagesToTenantMedia(
  preprocessedHtml: string,
  mediaIdBySourceUrl: ReadonlyMap<string, number>,
  baseSiteUrl: string | null,
): string {
  return preprocessedHtml.replace(/<img\b([^>]*)>/gi, (_full, attrPart: string) => {
    const attrs = parseHtmlAttrsSimple(attrPart);
    const rawSrc = attrs.get("src") || attrs.get("data-src") || attrs.get("data-lazy-src") || "";
    if (!rawSrc) return "";

    let resolvedUrl = rawSrc.trim();
    if (resolvedUrl.startsWith("//")) {
      resolvedUrl = `https:${resolvedUrl}`;
    } else if (resolvedUrl.startsWith("/") && baseSiteUrl) {
      try {
        resolvedUrl = new URL(resolvedUrl, baseSiteUrl).toString();
      } catch {
        return "";
      }
    }

    const mediaId = mediaIdBySourceUrl.get(resolvedUrl) ?? mediaIdBySourceUrl.get(rawSrc.trim());
    if (!mediaId) {
      return "";
    }
    const safeAlt = stripHtmlToPlainText(attrs.get("alt") ?? "")
      .replace(/"/g, "&quot;")
      .slice(0, 250);
    return `<img src="/media/${mediaId}" alt="${safeAlt}">`;
  });
}

function extractFirstSafeHttpsHref(innerHtml: string): string | undefined {
  const anchorRe = /<a\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(innerHtml)) !== null) {
    const attrs = parseHtmlAttrsSimple(match[1] ?? "");
    const rawHref = attrs.get("href");
    if (!rawHref) continue;
    const safeHref = sanitizeRichTextLinkHref(rawHref);
    // RestrictedRichTextNodeSchema requires HttpsUrlSchema on `href`
    if (safeHref && safeHref.startsWith("https://")) {
      return safeHref;
    }
  }
  return undefined;
}

/**
 * Converts WordPress HTML into a strictly sanitized PunyaSitus TipTap JSON document
 * (`RestrictedRichTextDoc`, `schemaVersion: 1`) preserving headings, paragraphs,
 * ordered/unordered lists, blockquotes, safe HTTPS links, and imported tenant media images.
 */
export function convertWpHtmlToSanitizedTipTapDoc(
  rawHtml: string,
  options: {
    readonly baseSiteUrl?: string | null;
    readonly mediaIdBySourceUrl?: ReadonlyMap<string, number>;
  } = {},
): {
  readonly doc: RestrictedRichTextDoc;
  readonly sanitizedHtml: string;
} {
  const preprocessed = preprocessWordPressHtml(rawHtml);
  const rewritten = rewriteWpImagesToTenantMedia(
    preprocessed,
    options.mediaIdBySourceUrl ?? new Map(),
    options.baseSiteUrl ?? null,
  );
  const sanitizedHtml = sanitizeRichTextHtml(rewritten);
  if (!sanitizedHtml) {
    return {
      doc: { schemaVersion: 1, blocks: [] },
      sanitizedHtml: "",
    };
  }

  // Parse semantic blocks preserving orderedList vs bulletList and inline HTTPS links
  const blocks: RestrictedRichTextNode[] = [];
  const tokenRe =
    /<(h[2-4]|p|blockquote|pre|ul|ol|tr)\b[^>]*>([\s\S]*?)<\/\1>|<img\b([^>]*)>/gi;

  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = tokenRe.exec(sanitizedHtml)) !== null && blocks.length < 500) {
    if (match.index > lastIndex) {
      const stray = stripHtmlToPlainText(sanitizedHtml.slice(lastIndex, match.index));
      if (stray) {
        blocks.push({ type: "paragraph", text: stray.slice(0, 10_000) });
      }
    }
    lastIndex = tokenRe.lastIndex;

    const tag = match[1]?.toLowerCase();
    const inner = match[2] ?? "";

    if (!tag && match[3] !== undefined) {
      const attrs = parseHtmlAttrsSimple(match[3]);
      const src = attrs.get("src") ?? "";
      const alt = attrs.get("alt") ?? "";
      const mediaMatch = /^\/media\/([1-9]\d{0,9})$/.exec(src);
      if (mediaMatch) {
        blocks.push({
          type: "image",
          mediaId: Number(mediaMatch[1]),
          ...(alt ? { text: alt.slice(0, 250) } : {}),
        });
      }
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      const listType = tag === "ol" ? "orderedList" : "bulletList";
      const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch: RegExpExecArray | null;
      while ((liMatch = liRe.exec(inner)) !== null && blocks.length < 500) {
        const liInner = liMatch[1] ?? "";
        const text = stripHtmlToPlainText(liInner).slice(0, 10_000);
        if (!text) continue;
        const href = extractFirstSafeHttpsHref(liInner);
        blocks.push({
          type: listType,
          text,
          ...(href ? { href, marks: ["link" as const] } : {}),
        });
      }
      continue;
    }

    // Check if paragraph contains an imported <img> alongside or without text
    if (tag === "p" && /<img\b/i.test(inner)) {
      const imgRe = /<img\b([^>]*)>/gi;
      let imgMatch: RegExpExecArray | null;
      while ((imgMatch = imgRe.exec(inner)) !== null && blocks.length < 500) {
        const attrs = parseHtmlAttrsSimple(imgMatch[1] ?? "");
        const src = attrs.get("src") ?? "";
        const alt = attrs.get("alt") ?? "";
        const mediaMatch = /^\/media\/([1-9]\d{0,9})$/.exec(src);
        if (mediaMatch) {
          blocks.push({
            type: "image",
            mediaId: Number(mediaMatch[1]),
            ...(alt ? { text: alt.slice(0, 250) } : {}),
          });
        }
      }
    }

    const plain = stripHtmlToPlainText(inner).slice(0, 10_000);
    if (!plain) continue;

    if (tag === "h2" || tag === "h3" || tag === "h4") {
      blocks.push({
        type: "heading",
        level: Number(tag[1]) as 2 | 3 | 4,
        text: plain,
      });
    } else if (tag === "blockquote") {
      blocks.push({ type: "blockquote", text: plain });
    } else if (tag === "tr") {
      blocks.push({ type: "tableRow", text: plain });
    } else {
      const href = extractFirstSafeHttpsHref(inner);
      const hasStrong = /<(?:strong|b)\b/i.test(inner);
      const hasEm = /<(?:em|i)\b/i.test(inner);
      const marks: ("bold" | "italic" | "link")[] = [];
      if (hasStrong && !hasEm && !href && /^<(?:strong|b)\b[^>]*>[\s\S]*<\/(?:strong|b)>$/i.test(inner.trim())) {
        marks.push("bold");
      }
      if (href) {
        marks.push("link");
      }
      blocks.push({
        type: "paragraph",
        text: plain,
        ...(href ? { href } : {}),
        ...(marks.length > 0 ? { marks } : {}),
      });
    }
  }

  if (lastIndex < sanitizedHtml.length && blocks.length < 500) {
    const tail = stripHtmlToPlainText(sanitizedHtml.slice(lastIndex));
    if (tail) {
      blocks.push({ type: "paragraph", text: tail.slice(0, 10_000) });
    }
  }

  // Fallback to core converter if custom parser yielded no blocks despite text
  const rawDoc: RestrictedRichTextDoc =
    blocks.length > 0 ? { schemaVersion: 1, blocks } : htmlToRestrictedRichTextDoc(sanitizedHtml);

  const sanitizedDoc = sanitizeRichTextDoc(rawDoc);
  return {
    doc: sanitizedDoc,
    sanitizedHtml,
  };
}

/**
 * Sanitizes & bounds public WordPress SEO metadata (Yoast/RankMath) into PunyaSitus
 * `PageSeoOverrides` format without accepting scripts, HTML tags, or arbitrary canonicals.
 */
export function sanitizeWpSeoMeta(raw: WpParsedSeoMeta | null | undefined): PageSeoOverrides | null {
  if (!raw) return null;

  const clean = (val: string | null | undefined, maxLen: number): string | null => {
    if (!val || typeof val !== "string") return null;
    const stripped = stripHtmlToPlainText(val);
    const normalized = sanitizeSeoText(stripped, { maxLength: maxLen });
    return normalized.length > 0 ? normalized : null;
  };

  const titleOverride = clean(raw.titleOverride, 200);
  const descriptionOverride = clean(raw.descriptionOverride, 500);
  const focusKeyphrase = clean(raw.focusKeyphrase, 100);
  const ogTitleOverride = clean(raw.ogTitleOverride, 200);
  const ogDescriptionOverride = clean(raw.ogDescriptionOverride, 500);

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
    ...(titleOverride ? { titleOverride } : {}),
    ...(descriptionOverride ? { descriptionOverride } : {}),
    ...(focusKeyphrase ? { focusKeyphrase } : {}),
    ...(ogTitleOverride ? { ogTitleOverride } : {}),
    ...(ogDescriptionOverride ? { ogDescriptionOverride } : {}),
    schemaType: "BlogPosting",
  };
}

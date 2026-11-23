import type { PageSeoOverrides, PostSnapshot, RestrictedRichTextDoc } from "../content/index.ts";
import { escapeHtmlAttribute, sanitizeSeoText } from "../seo/index.ts";
import {
  MAX_AUTHOR_BIO_LENGTH,
  MAX_AUTHOR_SAME_AS_LINKS,
  normalizeAuthorBio,
  normalizeAuthorSameAsUrls,
  validatePublicAuthorSameAsUrl,
  type PublicAuthorAvatarDto,
  type PublicAuthorProfileDto,
} from "../seo/local-entity.ts";

/**
 * Blog Author Profiles, Strict `content_modified_at` Discipline, Linear O(n) Reading-Time,
 * Server-Rendered Zero-JS Heading TOC, and Category Hierarchy Helpers
 * (`packages/core/src/posts/index.ts`; REQ-092, PLAN §5.2 & §19.5, TASK-092).
 *
 * Security & Performance Guarantees:
 * - Zero backtracking regexes in HTML stripping and TOC extraction (strict linear O(n) scanning, zero ReDoS).
 * - Deterministic, URL-safe, collision-free heading anchor IDs (`[a-z0-9-]+`) with XSS/event-handler stripping.
 * - Deterministic SHA-256 substantive content fingerprinting so draft autosaves, analytics ticks,
 *   non-substantive metadata, and unrelated site settings NEVER advance `content_modified_at`.
 * - Single-source author byline <-> `Article.author` JSON-LD parity model.
 */

export const DEFAULT_READING_WORDS_PER_MINUTE = 200 as const;
export const MIN_READING_TIME_MINUTES = 1 as const;
export const MAX_READING_TIME_MINUTES = 180 as const;
export const MAX_TOC_HEADINGS = 100 as const;
export const MAX_TOC_HEADING_TEXT_LENGTH = 200 as const;
export const MAX_TOC_ANCHOR_ID_LENGTH = 72 as const;

export const MAX_POST_AUTHOR_NAME_LENGTH = 120 as const;
export const MAX_POST_AUTHOR_ROLE_TITLE_LENGTH = 100 as const;
export const MAX_POST_AUTHOR_BIO_LENGTH = MAX_AUTHOR_BIO_LENGTH;
export const MAX_POST_AUTHOR_SAME_AS_LINKS = MAX_AUTHOR_SAME_AS_LINKS;
export const MAX_BLOG_CATEGORY_DEPTH = 3 as const;

// ---------------------------------------------------------------------------
// 1. Linear O(n) HTML Text Stripping & Reading-Time Estimation (Zero ReDoS)
// ---------------------------------------------------------------------------

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isTagNameChar(code: number): boolean {
  return (
    isAsciiLetter(code) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d ||
    code === 0x3a ||
    code === 0x5f
  );
}

/**
 * Decodes standard HTML character references in a single linear O(n) pass.
 */
export function decodeHtmlEntitiesLinear(input: string): string {
  if (!input || !input.includes("&")) return input;
  const out: string[] = [];
  const len = input.length;
  let i = 0;

  while (i < len) {
    if (input.charCodeAt(i) !== 0x26 /* & */) {
      const nextAmp = input.indexOf("&", i);
      if (nextAmp === -1) {
        out.push(input.slice(i));
        break;
      }
      out.push(input.slice(i, nextAmp));
      i = nextAmp;
      continue;
    }

    // Bounded forward scan (at most 13 chars) to guarantee strict O(n) even on "&".repeat(N)
    let semi = -1;
    const scanLimit = Math.min(len - 1, i + 13);
    for (let j = i + 1; j <= scanLimit; j += 1) {
      if (input.charCodeAt(j) === 0x3b /* ; */) {
        semi = j;
        break;
      }
    }
    if (semi === -1) {
      out.push("&");
      i += 1;
      continue;
    }

    const entity = input.slice(i + 1, semi);
    const lower = entity.toLowerCase();
    let decoded: string | null = null;

    if (lower === "nbsp") decoded = " ";
    else if (lower === "amp") decoded = "&";
    else if (lower === "lt") decoded = "<";
    else if (lower === "gt") decoded = ">";
    else if (lower === "quot") decoded = '"';
    else if (lower === "apos") decoded = "'";
    else if (lower === "mdash") decoded = "—";
    else if (lower === "ndash") decoded = "–";
    else if (lower === "hellip") decoded = "...";
    else if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const hex = entity.slice(2);
      if (hex.length >= 1 && hex.length <= 6 && /^[0-9a-fA-F]+$/.test(hex)) {
        const cp = Number.parseInt(hex, 16);
        if (cp >= 0x20 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
          decoded = String.fromCodePoint(cp);
        }
      }
    } else if (entity.startsWith("#")) {
      const dec = entity.slice(1);
      if (dec.length >= 1 && dec.length <= 7 && /^\d+$/.test(dec)) {
        const cp = Number.parseInt(dec, 10);
        if (cp >= 0x20 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
          decoded = String.fromCodePoint(cp);
        }
      }
    }

    if (decoded !== null) {
      out.push(decoded);
      i = semi + 1;
    } else {
      out.push("&");
      i += 1;
    }
  }

  return out.join("");
}

/**
 * Finds the closing `>` of an HTML tag starting at `openLtIndex` while respecting
 * single/double-quoted attribute values in strict O(n) forward scan.
 * Returns `-1` if the tag is unclosed.
 */
function findTagCloseLinear(html: string, openLtIndex: number): number {
  const len = html.length;
  let quote = 0;
  for (let i = openLtIndex + 1; i < len; i += 1) {
    const c = html.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
      continue;
    }
    if (c === 0x22 /* " */ || c === 0x27 /* ' */) {
      quote = c;
    } else if (c === 0x3e /* > */) {
      return i;
    }
  }
  return -1;
}

/**
 * Strips HTML tags and comments in a single linear O(n) pass (zero ReDoS even on
 * adversarial unclosed `<a <a <a ...` inputs), defensively skipping `<script>` and
 * `<style>` blocks and collapsing whitespace cleanly.
 */
export function stripHtmlToPlainTextLinear(html: string): string {
  if (!html || typeof html !== "string") return "";

  const len = html.length;
  const chunks: string[] = [];
  let i = 0;
  let skipRawTag: "script" | "style" | null = null;

  while (i < len) {
    const c = html.charCodeAt(i);

    if (skipRawTag !== null) {
      const nextLt = html.indexOf("<", i);
      if (nextLt === -1) break;
      const closeTagPrefix = `</${skipRawTag}`;
      if (html.slice(nextLt, nextLt + closeTagPrefix.length).toLowerCase() === closeTagPrefix) {
        const afterName = nextLt + closeTagPrefix.length;
        const nextChar = afterName < len ? html.charCodeAt(afterName) : 0;
        if (nextChar === 0x3e || isAsciiWhitespace(nextChar)) {
          const closeGt = html.indexOf(">", afterName);
          if (closeGt === -1) break;
          skipRawTag = null;
          chunks.push(" ");
          i = closeGt + 1;
          continue;
        }
      }
      i = nextLt + 1;
      continue;
    }

    if (c !== 0x3c /* < */) {
      const nextLt = html.indexOf("<", i);
      if (nextLt === -1) {
        chunks.push(html.slice(i));
        break;
      }
      chunks.push(html.slice(i, nextLt));
      i = nextLt;
      continue;
    }

    // HTML comment `<!-- ... -->`
    if (html.startsWith("<!--", i)) {
      const endComment = html.indexOf("-->", i + 4);
      if (endComment === -1) break;
      chunks.push(" ");
      i = endComment + 3;
      continue;
    }

    const nextCode = i + 1 < len ? html.charCodeAt(i + 1) : 0;
    const isClosing = nextCode === 0x2f; // '/'
    const isDeclaration = nextCode === 0x21 || nextCode === 0x3f; // '!' or '?'
    const nameStart = isClosing ? i + 2 : i + 1;

    if (!isDeclaration && (nameStart >= len || !isAsciiLetter(html.charCodeAt(nameStart)))) {
      // Literal '<' not starting a tag (e.g. `a < b` or `<<<`)
      chunks.push("<");
      i += 1;
      continue;
    }

    let nameEnd = nameStart;
    while (nameEnd < len && isTagNameChar(html.charCodeAt(nameEnd))) {
      nameEnd += 1;
    }
    const tagName = html.slice(nameStart, nameEnd).toLowerCase();

    const closeGt = findTagCloseLinear(html, i);
    if (closeGt === -1) {
      // Unclosed tag at tail: drop tag remainder in O(1) without backtracking
      break;
    }

    if (!isClosing && (tagName === "script" || tagName === "style")) {
      skipRawTag = tagName;
    }

    chunks.push(" ");
    i = closeGt + 1;
  }

  const decoded = decodeHtmlEntitiesLinear(chunks.join(""));
  // Collapse whitespace in a single linear pass
  const out: string[] = [];
  let inSpace = true;
  for (let idx = 0; idx < decoded.length; idx += 1) {
    const ch = decoded.charCodeAt(idx);
    if (isAsciiWhitespace(ch) || ch === 0xa0) {
      if (!inSpace) {
        out.push(" ");
        inSpace = true;
      }
    } else {
      out.push(decoded[idx]!);
      inSpace = false;
    }
  }
  const joined = out.join("");
  return joined.endsWith(" ") ? joined.slice(0, -1) : joined;
}

function extractPlainTextFromRichTextDoc(doc: RestrictedRichTextDoc): string {
  const parts: string[] = [];
  for (const block of doc.blocks) {
    if (typeof block.text === "string" && block.text.length > 0) {
      parts.push(stripHtmlToPlainTextLinear(block.text));
    }
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * Counts human-readable words in a single linear pass (Unicode letters & digits).
 */
export function countWordsLinear(input: string | RestrictedRichTextDoc): number {
  const plainText =
    typeof input === "string"
      ? stripHtmlToPlainTextLinear(input)
      : extractPlainTextFromRichTextDoc(input);
  if (!plainText) return 0;

  let count = 0;
  let inWord = false;
  // Linear scan over code points (no regex backtracking)
  for (const ch of plainText) {
    const isWordChar = /[\p{L}\p{N}]/u.test(ch);
    const isInnerConnector = ch === "'" || ch === "’" || ch === "-" || ch === "_";
    if (isWordChar) {
      if (!inWord) {
        count += 1;
        inWord = true;
      }
    } else if (!isInnerConnector) {
      inWord = false;
    }
  }
  return count;
}

export interface ReadingTimeEstimate {
  readonly wordCount: number;
  readonly readingTimeMinutes: number;
  readonly wordsPerMinute: number;
}

/**
 * Deterministically estimates reading time (default 200 wpm, min 1 min, max 180 min)
 * using linear O(n) HTML stripping and word counting.
 */
export function estimatePostReadingTime(
  input: string | RestrictedRichTextDoc,
  wordsPerMinute: number = DEFAULT_READING_WORDS_PER_MINUTE,
): ReadingTimeEstimate {
  const wpm =
    Number.isFinite(wordsPerMinute) && wordsPerMinute > 0
      ? wordsPerMinute
      : DEFAULT_READING_WORDS_PER_MINUTE;
  const wordCount = countWordsLinear(input);
  const readingTimeMinutes = Math.min(
    MAX_READING_TIME_MINUTES,
    Math.max(MIN_READING_TIME_MINUTES, Math.ceil(wordCount / wpm)),
  );
  return {
    wordCount,
    readingTimeMinutes,
    wordsPerMinute: wpm,
  };
}

export function calculateLinearReadingTimeMinutes(
  input: string | RestrictedRichTextDoc,
  wordsPerMinute: number = DEFAULT_READING_WORDS_PER_MINUTE,
): number {
  return estimatePostReadingTime(input, wordsPerMinute).readingTimeMinutes;
}

// ---------------------------------------------------------------------------
// 2. Linear O(n) Server-Rendered Heading TOC Extractor & Anchor Injector
// ---------------------------------------------------------------------------

export interface PostTocItem {
  readonly id: string;
  readonly text: string;
  readonly level: 2 | 3;
}

export interface ServerRenderedPostToc {
  readonly html: string;
  readonly toc: readonly PostTocItem[];
  readonly headingCount: number;
}

/**
 * Slugifies Indonesian/Unicode heading text into a deterministic URL-safe ASCII anchor ID.
 */
export function slugifyTocHeadingText(text: string, fallbackIndex: number): string {
  const normalized = text.normalize("NFKD");
  const chars: string[] = [];
  let prevHyphen = true;

  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    // Skip combining diacritical marks (U+0300..U+036F)
    if (code >= 0x0300 && code <= 0x036f) continue;

    if (code >= 0x41 && code <= 0x5a) {
      chars.push(String.fromCharCode(code + 32));
      prevHyphen = false;
    } else if ((code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)) {
      chars.push(normalized[i]!);
      prevHyphen = false;
    } else if (!prevHyphen) {
      chars.push("-");
      prevHyphen = true;
    }
  }

  let slug = chars.join("");
  if (slug.endsWith("-")) slug = slug.slice(0, -1);
  if (slug.length > MAX_TOC_ANCHOR_ID_LENGTH) {
    slug = slug.slice(0, MAX_TOC_ANCHOR_ID_LENGTH);
    while (slug.endsWith("-")) slug = slug.slice(0, -1);
  }
  return slug || `section-${fallbackIndex}`;
}

/**
 * Allocates a guaranteed-unique anchor ID across all headings in a document,
 * handling duplicates (`foo`, `foo-2`, `foo-3`) and pre-existing collisions (`foo-2` literal).
 */
function allocateUniqueAnchorId(
  baseId: string,
  usedIds: Set<string>,
  baseCounts: Map<string, number>,
): string {
  const prevCount = baseCounts.get(baseId) ?? 0;
  let suffix = prevCount + 1;
  let candidate = suffix === 1 ? baseId : `${baseId}-${suffix}`;

  while (usedIds.has(candidate)) {
    suffix += 1;
    candidate = `${baseId}-${suffix}`;
  }

  baseCounts.set(baseId, suffix);
  usedIds.add(candidate);
  return candidate;
}

/**
 * Strips any existing `id`, `on*` event handler, or `style` attribute from a heading's
 * raw opening-tag attribute string in a single linear O(n) pass, preserving safe attributes
 * such as `class` or `dir`.
 */
function sanitizeHeadingOpenTagAttributesLinear(rawAttrs: string): string {
  if (!rawAttrs || !rawAttrs.trim()) return "";

  const safeAttrs: string[] = [];
  const len = rawAttrs.length;
  let i = 0;

  while (i < len) {
    while (i < len && isAsciiWhitespace(rawAttrs.charCodeAt(i))) i += 1;
    if (i >= len) break;

    const nameStart = i;
    while (
      i < len &&
      !isAsciiWhitespace(rawAttrs.charCodeAt(i)) &&
      rawAttrs.charCodeAt(i) !== 0x3d /* = */ &&
      rawAttrs.charCodeAt(i) !== 0x2f /* / */ &&
      rawAttrs.charCodeAt(i) !== 0x3e /* > */
    ) {
      i += 1;
    }
    const name = rawAttrs.slice(nameStart, i).toLowerCase();
    if (!name) {
      i += 1;
      continue;
    }

    while (i < len && isAsciiWhitespace(rawAttrs.charCodeAt(i))) i += 1;
    let value: string | null = null;
    if (i < len && rawAttrs.charCodeAt(i) === 0x3d /* = */) {
      i += 1;
      while (i < len && isAsciiWhitespace(rawAttrs.charCodeAt(i))) i += 1;
      if (i < len) {
        const q = rawAttrs.charCodeAt(i);
        if (q === 0x22 /* " */ || q === 0x27 /* ' */) {
          i += 1;
          const valStart = i;
          while (i < len && rawAttrs.charCodeAt(i) !== q) i += 1;
          value = rawAttrs.slice(valStart, i);
          if (i < len && rawAttrs.charCodeAt(i) === q) i += 1;
        } else {
          const valStart = i;
          while (
            i < len &&
            !isAsciiWhitespace(rawAttrs.charCodeAt(i)) &&
            rawAttrs.charCodeAt(i) !== 0x3e
          ) {
            i += 1;
          }
          value = rawAttrs.slice(valStart, i);
        }
      }
    }

    // Strip `id` (replaced deterministically), inline event handlers (`on*`), and `style`
    if (name === "id" || name.startsWith("on") || name === "style") {
      continue;
    }
    // Allowlist safe presentation/a11y attributes on headings only
    if (name === "class" || name === "dir" || name === "lang" || name.startsWith("data-")) {
      if (/^[a-z][a-z0-9-]*$/.test(name)) {
        if (value === null) {
          safeAttrs.push(` ${name}`);
        } else {
          safeAttrs.push(` ${name}="${escapeHtmlAttribute(value)}"`);
        }
      }
    }
  }

  return safeAttrs.join("");
}

/**
 * Finds the matching closing `</h2>` or `</h3>` tag starting at `fromIndex` in linear O(n),
 * skipping tag attributes safely.
 */
function findMatchingHeadingCloseLinear(
  html: string,
  fromIndex: number,
  tagName: "h2" | "h3",
): { readonly closeStart: number; readonly closeEnd: number } | null {
  const len = html.length;
  let pos = fromIndex;

  while (pos < len) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) return null;

    if (html.startsWith("<!--", lt)) {
      const endComment = html.indexOf("-->", lt + 4);
      if (endComment === -1) return null;
      pos = endComment + 3;
      continue;
    }

    const closeGt = findTagCloseLinear(html, lt);
    if (closeGt === -1) return null;

    if (lt + 3 < len && html.charCodeAt(lt + 1) === 0x2f /* / */) {
      const candidate = html.slice(lt + 2, lt + 4).toLowerCase();
      if (candidate === tagName) {
        const afterIdx = lt + 4;
        const afterCode = afterIdx < len ? html.charCodeAt(afterIdx) : 0;
        if (afterCode === 0x3e || isAsciiWhitespace(afterCode)) {
          return { closeStart: lt, closeEnd: closeGt + 1 };
        }
      }
    }

    pos = closeGt + 1;
  }

  return null;
}

/**
 * Linear O(n) server-side H2/H3 Table-of-Contents extractor & deterministic anchor injector:
 * - Zero backtracking regexes (immune to ReDoS on pathological HTML).
 * - Injects unique, URL-safe `id="..."` attributes directly into `<h2>` and `<h3>` tags.
 * - Strips pre-existing `id` / `on*` / unsafe attributes from heading tags.
 * - Returns `{ html, toc, headingCount }` so `<nav aria-label="Daftar Isi">` renders 100%
 *   server-side with zero client JavaScript.
 */
export function extractAndInjectServerToc(sanitizedHtml: string): ServerRenderedPostToc {
  if (!sanitizedHtml || typeof sanitizedHtml !== "string") {
    return { html: "", toc: [], headingCount: 0 };
  }

  const toc: PostTocItem[] = [];
  const usedIds = new Set<string>();
  const baseCounts = new Map<string, number>();
  const output: string[] = [];

  const len = sanitizedHtml.length;
  let cursor = 0;
  let noMoreCloseH2 = false;
  let noMoreCloseH3 = false;

  while (cursor < len) {
    const lt = sanitizedHtml.indexOf("<", cursor);
    if (lt === -1) {
      output.push(sanitizedHtml.slice(cursor));
      break;
    }

    if (lt > cursor) {
      output.push(sanitizedHtml.slice(cursor, lt));
    }

    if (sanitizedHtml.startsWith("<!--", lt)) {
      const endComment = sanitizedHtml.indexOf("-->", lt + 4);
      if (endComment === -1) {
        output.push(sanitizedHtml.slice(lt));
        break;
      }
      output.push(sanitizedHtml.slice(lt, endComment + 3));
      cursor = endComment + 3;
      continue;
    }

    const maybeTag = sanitizedHtml.slice(lt + 1, lt + 3).toLowerCase();
    const afterTagIdx = lt + 3;
    const afterTagCode = afterTagIdx < len ? sanitizedHtml.charCodeAt(afterTagIdx) : 0;
    const isH2OrH3 =
      (maybeTag === "h2" || maybeTag === "h3") &&
      (afterTagCode === 0x3e /* > */ ||
        isAsciiWhitespace(afterTagCode) ||
        afterTagCode === 0x2f /* / */);

    if (!isH2OrH3 || toc.length >= MAX_TOC_HEADINGS) {
      output.push("<");
      cursor = lt + 1;
      continue;
    }

    const openGt = findTagCloseLinear(sanitizedHtml, lt);
    if (openGt === -1) {
      output.push(sanitizedHtml.slice(lt));
      break;
    }

    const tagName = maybeTag as "h2" | "h3";
    const alreadyNoClose = tagName === "h2" ? noMoreCloseH2 : noMoreCloseH3;
    const closeMatch = alreadyNoClose
      ? null
      : findMatchingHeadingCloseLinear(sanitizedHtml, openGt + 1, tagName);
    if (!closeMatch) {
      if (tagName === "h2") noMoreCloseH2 = true;
      else noMoreCloseH3 = true;
      // Unclosed heading tag: emit verbatim and advance strictly past openGt in O(1) (no rescan to EOF)
      output.push(sanitizedHtml.slice(lt, openGt + 1));
      cursor = openGt + 1;
      continue;
    }

    const rawAttrs = sanitizedHtml.slice(afterTagIdx, openGt);
    const innerHtml = sanitizedHtml.slice(openGt + 1, closeMatch.closeStart);
    const text = stripHtmlToPlainTextLinear(innerHtml).slice(0, MAX_TOC_HEADING_TEXT_LENGTH).trim();

    if (!text) {
      output.push(sanitizedHtml.slice(lt, closeMatch.closeEnd));
      cursor = closeMatch.closeEnd;
      continue;
    }

    const level: 2 | 3 = tagName === "h2" ? 2 : 3;
    const baseId = slugifyTocHeadingText(text, toc.length + 1);
    const id = allocateUniqueAnchorId(baseId, usedIds, baseCounts);
    toc.push({ id, text, level });

    const safeAttrs = sanitizeHeadingOpenTagAttributesLinear(rawAttrs);
    output.push(`<${tagName}${safeAttrs} id="${escapeHtmlAttribute(id)}">${innerHtml}</${tagName}>`);
    cursor = closeMatch.closeEnd;
  }

  return {
    html: output.join(""),
    toc,
    headingCount: toc.length,
  };
}

/**
 * Extracts deterministic H2/H3 TOC entries directly from a `RestrictedRichTextDoc`
 * (matching `extractAndInjectServerToc` IDs 1:1 for editor outline preview).
 */
export function extractTocFromRichTextDoc(doc: RestrictedRichTextDoc): readonly PostTocItem[] {
  const toc: PostTocItem[] = [];
  const usedIds = new Set<string>();
  const baseCounts = new Map<string, number>();

  for (const block of doc.blocks) {
    if (toc.length >= MAX_TOC_HEADINGS) break;
    if (block.type !== "heading") continue;
    const level = block.level;
    if (level !== 2 && level !== 3) continue;
    const text = stripHtmlToPlainTextLinear(block.text ?? "")
      .slice(0, MAX_TOC_HEADING_TEXT_LENGTH)
      .trim();
    if (!text) continue;

    const baseId = slugifyTocHeadingText(text, toc.length + 1);
    const id = allocateUniqueAnchorId(baseId, usedIds, baseCounts);
    toc.push({ id, text, level });
  }

  return toc;
}

export function shouldRenderServerToc(tocEnabled: boolean, toc: readonly PostTocItem[]): boolean {
  return Boolean(tocEnabled) && toc.length > 0;
}

// ---------------------------------------------------------------------------
// 3. Strict `content_modified_at` Substantive Fingerprinting (REQ-092, PLAN §5.2)
// ---------------------------------------------------------------------------

/**
 * Pure synchronous SHA-256 hex digest (FIPS 180-4) — runtime-neutral across Node,
 * Cloudflare Workers (`workerd`), and browsers with zero external dependencies.
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256HexSync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        ((w[i - 15]! >>> 7) | (w[i - 15]! << 25)) ^
        ((w[i - 15]! >>> 18) | (w[i - 15]! << 14)) ^
        (w[i - 15]! >>> 3);
      const s1 =
        ((w[i - 2]! >>> 17) | (w[i - 2]! << 15)) ^
        ((w[i - 2]! >>> 19) | (w[i - 2]! << 13)) ^
        (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, "0")).join("");
}

export interface SubstantivePostContentInput {
  readonly slug?: string | null;
  readonly title: string;
  readonly excerpt?: string | null;
  readonly body?: RestrictedRichTextDoc | null;
  readonly sanitizedHtml?: string | null;
  readonly coverMediaId?: number | null;
  readonly featuredMediaId?: number | null;
  readonly authorId?: number | null;
  readonly authorName?: string | null;
  readonly primaryCategoryId?: number | null;
  readonly categoryIds?: readonly number[] | null;
  readonly tagIds?: readonly number[] | null;
  readonly showToc?: boolean;
  readonly tocEnabled?: boolean;
  readonly seo?: PageSeoOverrides | Record<string, unknown> | null;
}

function normalizeUniqueSortedIds(ids: readonly number[] | null | undefined): readonly number[] {
  if (!ids || ids.length === 0) return [];
  return Array.from(new Set(ids.filter((id) => Number.isSafeInteger(id) && id >= 1))).sort(
    (a, b) => a - b,
  );
}

function canonicalizeSeoForFingerprint(
  seo: PageSeoOverrides | Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!seo || typeof seo !== "object") return null;
  const rec = seo as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(rec).sort();
  for (const key of keys) {
    const val = rec[key];
    if (val === undefined || val === null || val === "") continue;
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed) out[key] = trimmed;
    } else if (typeof val === "number" || typeof val === "boolean") {
      out[key] = val;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function canonicalizeRichTextDocForFingerprint(
  doc: RestrictedRichTextDoc | null | undefined,
): readonly Record<string, unknown>[] {
  if (!doc || !Array.isArray(doc.blocks)) return [];
  return doc.blocks.map((block) => {
    const clean: Record<string, unknown> = { type: block.type };
    if (block.level !== undefined) clean.level = block.level;
    if (typeof block.text === "string") clean.text = block.text.trim();
    if (block.mediaId !== undefined) clean.mediaId = block.mediaId;
    if (typeof block.href === "string" && block.href.trim()) clean.href = block.href.trim();
    if (Array.isArray(block.marks) && block.marks.length > 0) {
      clean.marks = [...block.marks].sort();
    }
    return clean;
  });
}

/**
 * Builds the canonical substantive payload object for a published blog post.
 * Intentionally EXCLUDES non-substantive/volatile metadata (`version`, `updatedAt`,
 * `publishedAt`, `contentModifiedAt`, analytics counters, draft autosave timestamps,
 * and unrelated site settings).
 */
export function buildSubstantivePostCanonicalPayload(
  input: SubstantivePostContentInput,
): Record<string, unknown> {
  const coverMediaId =
    input.coverMediaId !== undefined ? input.coverMediaId : (input.featuredMediaId ?? null);
  const tocEnabled =
    input.tocEnabled !== undefined ? Boolean(input.tocEnabled) : Boolean(input.showToc);
  const categoryIds = normalizeUniqueSortedIds(
    input.primaryCategoryId
      ? [...(input.categoryIds ?? []), input.primaryCategoryId]
      : input.categoryIds,
  );
  const tagIds = normalizeUniqueSortedIds(input.tagIds);

  const rawHtml = typeof input.sanitizedHtml === "string" ? input.sanitizedHtml.trim() : "";
  // Normalize HTML identically through the idempotent linear TOC anchor injector so legacy
  // rows without heading `id` attributes produce the exact same fingerprint on no-op republish.
  const canonicalHtml = rawHtml ? extractAndInjectServerToc(rawHtml).html : "";

  return {
    v: 1,
    title: input.title.trim(),
    excerpt: typeof input.excerpt === "string" && input.excerpt.trim() ? input.excerpt.trim() : null,
    body: canonicalizeRichTextDocForFingerprint(input.body),
    sanitizedHtml: canonicalHtml,
    coverMediaId: coverMediaId ?? null,
    authorId: input.authorId ?? null,
    authorName:
      typeof input.authorName === "string" && input.authorName.trim()
        ? input.authorName.trim()
        : null,
    primaryCategoryId: input.primaryCategoryId ?? null,
    categoryIds,
    tagIds,
    tocEnabled,
    seo: canonicalizeSeoForFingerprint(input.seo),
  };
}

/**
 * Computes a deterministic 64-character SHA-256 hex fingerprint over a post's
 * substantive published content.
 */
export function computeSubstantivePostFingerprint(input: SubstantivePostContentInput): string {
  const canonical = buildSubstantivePostCanonicalPayload(input);
  return sha256HexSync(JSON.stringify(canonical));
}

/**
 * Returns `true` iff two published post snapshots differ in substantive public content.
 */
export function hasSubstantivePublishedPostChange(
  prior: SubstantivePostContentInput | PostSnapshot | null | undefined,
  next: SubstantivePostContentInput | PostSnapshot,
): boolean {
  if (!prior) return true;
  return computeSubstantivePostFingerprint(prior) !== computeSubstantivePostFingerprint(next);
}

export interface ResolveContentModifiedAtInput {
  readonly priorPublished: SubstantivePostContentInput | PostSnapshot | null;
  readonly nextPublished: SubstantivePostContentInput | PostSnapshot;
  readonly priorContentModifiedAt: number | null;
  readonly priorPublishedAt?: number | null;
  readonly priorFingerprint?: string | null;
  readonly nowMs: number;
}

export interface ResolveContentModifiedAtResult {
  readonly contentModifiedAt: number;
  readonly substantiveChanged: boolean;
  readonly fingerprint: string;
}

/**
 * Enforces strict `content_modified_at` discipline on publication:
 * - First publish (`priorPublished === null` or `priorContentModifiedAt === null`):
 *   sets `contentModifiedAt = nowMs`, `substantiveChanged = true`.
 * - Subsequent republish: compares deterministic substantive content fingerprints.
 *   Advances `contentModifiedAt` to `nowMs` ONLY when substantive content actually changed;
 *   otherwise preserves `priorContentModifiedAt` unchanged so sitemap `<lastmod>` and
 *   `Article.dateModified` never churn on no-op republishes.
 */
export function resolvePublishedContentModifiedAt(
  input: ResolveContentModifiedAtInput,
): ResolveContentModifiedAtResult {
  const nextFingerprint = computeSubstantivePostFingerprint(input.nextPublished);
  const existingTimestamp = input.priorContentModifiedAt ?? input.priorPublishedAt ?? null;

  if (existingTimestamp === null || (!input.priorPublished && !input.priorFingerprint)) {
    return {
      contentModifiedAt: input.nowMs,
      substantiveChanged: true,
      fingerprint: nextFingerprint,
    };
  }

  const priorFingerprint =
    input.priorFingerprint && input.priorFingerprint.trim().length > 0
      ? input.priorFingerprint.trim()
      : input.priorPublished
        ? computeSubstantivePostFingerprint(input.priorPublished)
        : null;

  const substantiveChanged = priorFingerprint !== nextFingerprint;
  return {
    contentModifiedAt: substantiveChanged ? input.nowMs : existingTimestamp,
    substantiveChanged,
    fingerprint: nextFingerprint,
  };
}

// ---------------------------------------------------------------------------
// 4. Author Profile Normalization & Visible-Byline <-> JSON-LD Parity
// ---------------------------------------------------------------------------

export interface AuthorProfileValidationIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface AuthorProfilePayloadInput {
  readonly name?: unknown;
  readonly slug?: unknown;
  readonly roleTitle?: unknown;
  readonly role_title?: unknown;
  readonly bio?: unknown;
  readonly avatarMediaId?: unknown;
  readonly avatar_media_id?: unknown;
  readonly sameAs?: unknown;
}

export interface NormalizedAuthorProfilePayload {
  readonly name: string;
  readonly slug: string | null;
  readonly roleTitle: string | null;
  readonly bio: string | null;
  readonly avatarMediaId: number | null;
  readonly sameAs: readonly string[];
}

export function normalizeAuthorRoleTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = sanitizeSeoText(raw, { maxLength: MAX_POST_AUTHOR_ROLE_TITLE_LENGTH });
  return cleaned.length > 0 ? cleaned : null;
}

export function validateAuthorProfilePayload(
  input: AuthorProfilePayloadInput,
):
  | { readonly ok: true; readonly data: NormalizedAuthorProfilePayload }
  | { readonly ok: false; readonly errors: readonly AuthorProfileValidationIssue[] } {
  const errors: AuthorProfileValidationIssue[] = [];

  // Name
  let cleanName = "";
  if (typeof input.name !== "string") {
    errors.push({
      field: "name",
      code: "REQUIRED",
      message: "Nama penulis wajib diisi.",
    });
  } else {
    const rawName = input.name.trim();
    if (hasControlChars(rawName) || /<\s*\/?\s*(?:script|iframe|style|svg|object|embed)\b/i.test(rawName)) {
      errors.push({
        field: "name",
        code: "INVALID_CHARACTERS",
        message: "Nama penulis mengandung karakter atau tag yang tidak diizinkan.",
      });
    } else if (rawName.length > MAX_POST_AUTHOR_NAME_LENGTH) {
      errors.push({
        field: "name",
        code: "INVALID_LENGTH",
        message: `Nama penulis maksimal ${MAX_POST_AUTHOR_NAME_LENGTH} karakter.`,
      });
    } else {
      cleanName = sanitizeSeoText(rawName, { maxLength: MAX_POST_AUTHOR_NAME_LENGTH });
      if (!cleanName) {
        errors.push({
          field: "name",
          code: "REQUIRED",
          message: "Nama penulis wajib diisi.",
        });
      }
    }
  }

  // Role title (`roleTitle` or `role_title`)
  const rawRole = input.roleTitle !== undefined ? input.roleTitle : input.role_title;
  if (
    input.roleTitle !== undefined &&
    input.role_title !== undefined &&
    input.roleTitle !== input.role_title
  ) {
    errors.push({
      field: "roleTitle",
      code: "CONFLICTING_FIELDS",
      message: "roleTitle dan role_title harus bernilai sama jika keduanya dikirim.",
    });
  }
  let cleanRoleTitle: string | null = null;
  if (rawRole !== undefined && rawRole !== null) {
    if (typeof rawRole !== "string") {
      errors.push({
        field: "roleTitle",
        code: "INVALID_TYPE",
        message: "Peran/jabatan penulis harus berupa teks.",
      });
    } else {
      const trimmedRole = rawRole.trim();
      if (trimmedRole.length > MAX_POST_AUTHOR_ROLE_TITLE_LENGTH) {
        errors.push({
          field: "roleTitle",
          code: "INVALID_LENGTH",
          message: `Peran/jabatan penulis maksimal ${MAX_POST_AUTHOR_ROLE_TITLE_LENGTH} karakter.`,
        });
      } else if (
        hasControlChars(trimmedRole) ||
        /<\s*\/?\s*(?:script|iframe|style|svg|object|embed)\b/i.test(trimmedRole)
      ) {
        errors.push({
          field: "roleTitle",
          code: "INVALID_CHARACTERS",
          message: "Peran/jabatan penulis mengandung karakter atau tag yang tidak diizinkan.",
        });
      } else {
        cleanRoleTitle = normalizeAuthorRoleTitle(trimmedRole);
      }
    }
  }

  // Bio
  let cleanBio: string | null = null;
  if (input.bio !== undefined && input.bio !== null) {
    if (typeof input.bio !== "string") {
      errors.push({
        field: "bio",
        code: "INVALID_TYPE",
        message: "Bio penulis harus berupa teks.",
      });
    } else {
      const trimmedBio = input.bio.trim();
      if (trimmedBio.length > MAX_POST_AUTHOR_BIO_LENGTH) {
        errors.push({
          field: "bio",
          code: "INVALID_LENGTH",
          message: `Bio penulis maksimal ${MAX_POST_AUTHOR_BIO_LENGTH} karakter.`,
        });
      } else if (
        hasControlChars(trimmedBio) ||
        /<\s*\/?\s*(?:script|iframe|style|svg|object|embed)\b/i.test(trimmedBio)
      ) {
        errors.push({
          field: "bio",
          code: "INVALID_CHARACTERS",
          message: "Bio penulis mengandung karakter atau tag yang tidak diizinkan.",
        });
      } else {
        cleanBio = normalizeAuthorBio(trimmedBio);
      }
    }
  }

  // Slug (optional)
  let cleanSlug: string | null = null;
  if (input.slug !== undefined && input.slug !== null && input.slug !== "") {
    if (typeof input.slug !== "string") {
      errors.push({
        field: "slug",
        code: "INVALID_TYPE",
        message: "Slug penulis harus berupa teks.",
      });
    } else {
      const candidate = input.slug.trim().toLowerCase();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) || candidate.length > 80) {
        errors.push({
          field: "slug",
          code: "INVALID_SLUG",
          message: "Slug penulis hanya boleh berisi huruf kecil, angka, dan tanda hubung (maks. 80 karakter).",
        });
      } else {
        cleanSlug = candidate;
      }
    }
  }

  // Avatar media ID (`avatarMediaId` or `avatar_media_id`)
  const rawAvatarId =
    input.avatarMediaId !== undefined ? input.avatarMediaId : input.avatar_media_id;
  if (
    input.avatarMediaId !== undefined &&
    input.avatar_media_id !== undefined &&
    input.avatarMediaId !== input.avatar_media_id
  ) {
    errors.push({
      field: "avatarMediaId",
      code: "CONFLICTING_FIELDS",
      message: "avatarMediaId dan avatar_media_id harus sama jika keduanya dikirim.",
    });
  }
  let cleanAvatarId: number | null = null;
  if (rawAvatarId !== undefined && rawAvatarId !== null) {
    if (
      typeof rawAvatarId !== "number" ||
      !Number.isSafeInteger(rawAvatarId) ||
      rawAvatarId < 1 ||
      rawAvatarId > 2_147_483_647
    ) {
      errors.push({
        field: "avatarMediaId",
        code: "INVALID_ID",
        message: "ID media avatar penulis harus berupa bilangan bulat positif.",
      });
    } else {
      cleanAvatarId = rawAvatarId;
    }
  }

  // sameAs links
  let cleanSameAs: readonly string[] = [];
  if (input.sameAs !== undefined && input.sameAs !== null) {
    let rawList: readonly unknown[] | null = null;
    if (Array.isArray(input.sameAs)) {
      rawList = input.sameAs;
    } else if (typeof input.sameAs === "string") {
      const trimmed = input.sameAs.trim();
      if (!trimmed) {
        rawList = [];
      } else if (trimmed.startsWith("[")) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          rawList = Array.isArray(parsed) ? parsed : null;
        } catch {
          rawList = null;
        }
      } else {
        rawList = [trimmed];
      }
    }

    if (rawList === null) {
      errors.push({
        field: "sameAs",
        code: "INVALID_TYPE",
        message: "sameAs harus berupa array URL HTTPS publik.",
      });
    } else if (rawList.length > MAX_POST_AUTHOR_SAME_AS_LINKS) {
      errors.push({
        field: "sameAs",
        code: "TOO_MANY_ITEMS",
        message: `Maksimal ${MAX_POST_AUTHOR_SAME_AS_LINKS} tautan profil (sameAs) per penulis.`,
      });
    } else {
      const allValid = rawList.every((item) => validatePublicAuthorSameAsUrl(item) !== null);
      if (!allValid) {
        errors.push({
          field: "sameAs",
          code: "INVALID_URL",
          message: "Setiap tautan profil (sameAs) wajib berupa URL HTTPS publik yang valid.",
        });
      } else {
        cleanSameAs = normalizeAuthorSameAsUrls(rawList as readonly string[]);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      name: cleanName,
      slug: cleanSlug,
      roleTitle: cleanRoleTitle,
      bio: cleanBio,
      avatarMediaId: cleanAvatarId,
      sameAs: cleanSameAs,
    },
  };
}

export interface PublicAuthorBylineModel {
  readonly id?: number;
  readonly name: string;
  readonly roleTitle: string | null;
  readonly bio: string | null;
  readonly avatar: PublicAuthorAvatarDto | null;
  readonly sameAs: readonly string[];
}

export interface ArticleAuthorJsonLdPerson {
  readonly "@type": "Person";
  readonly name: string;
  readonly jobTitle?: string;
  readonly description?: string;
  readonly image?: {
    readonly "@type": "ImageObject";
    readonly url: string;
    readonly width: number;
    readonly height: number;
    readonly caption?: string;
  };
  readonly sameAs?: readonly string[];
}

/**
 * Produces BOTH the visible author byline model and its 1:1 matching Schema.org
 * `Article.author` (`Person`) node from a single source of truth so visible byline
 * facts (`name`, `roleTitle`, `bio`, `avatar`, `sameAs`) never diverge from JSON-LD.
 */
export function buildAuthorBylineAndSchemaParity(
  profile: PublicAuthorProfileDto | PublicAuthorBylineModel | null | undefined,
): {
  readonly byline: PublicAuthorBylineModel | null;
  readonly articleAuthorSchema: ArticleAuthorJsonLdPerson | null;
} {
  if (!profile) {
    return { byline: null, articleAuthorSchema: null };
  }
  const name = sanitizeSeoText(profile.name ?? "", { maxLength: MAX_POST_AUTHOR_NAME_LENGTH });
  if (!name) {
    return { byline: null, articleAuthorSchema: null };
  }

  const roleTitle = normalizeAuthorRoleTitle(profile.roleTitle);
  const bio = normalizeAuthorBio(profile.bio);
  const sameAs = normalizeAuthorSameAsUrls(profile.sameAs);
  const avatar = profile.avatar ?? null;

  const byline: PublicAuthorBylineModel = {
    ...(profile.id !== undefined ? { id: profile.id } : {}),
    name,
    roleTitle,
    bio,
    avatar,
    sameAs,
  };

  const articleAuthorSchema: ArticleAuthorJsonLdPerson = {
    "@type": "Person",
    name,
    ...(roleTitle ? { jobTitle: roleTitle } : {}),
    ...(bio ? { description: bio } : {}),
    ...(avatar
      ? {
          image: {
            "@type": "ImageObject",
            url: avatar.url,
            width: Math.max(1, Number(avatar.width) || 256),
            height: Math.max(1, Number(avatar.height) || 256),
            ...(avatar.alt ? { caption: avatar.alt } : {}),
          },
        }
      : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
  };

  return { byline, articleAuthorSchema };
}

// ---------------------------------------------------------------------------
// 5. Category Hierarchy Depth `<= 3` Validation (`REQ-092`)
// ---------------------------------------------------------------------------

export interface CategoryHierarchyNode {
  readonly id: number;
  readonly parentId: number | null;
  readonly depth?: number;
}

export type CategoryDepthValidationResult =
  | {
      readonly ok: true;
      readonly depth: number;
      readonly maxSubtreeDepth: number;
    }
  | {
      readonly ok: false;
      readonly code: "INVALID_PARENT" | "CYCLIC_PARENT" | "MAX_DEPTH_EXCEEDED";
      readonly message: string;
    };

/**
 * Pure validator enforcing blog category nesting `<= 3` levels (1 = root, 2 = child,
 * 3 = grandchild; 4+ rejected) and cycle prevention across both creates and reparenting.
 */
export function validateBlogCategoryDepth(params: {
  readonly categoryId?: number | null;
  readonly proposedParentId: number | null;
  readonly existingCategories: readonly CategoryHierarchyNode[];
  readonly maxDepth?: number;
}): CategoryDepthValidationResult {
  const maxDepth = params.maxDepth ?? MAX_BLOG_CATEGORY_DEPTH;
  const byId = new Map<number, CategoryHierarchyNode>();
  const childrenByParent = new Map<number, number[]>();

  for (const cat of params.existingCategories) {
    byId.set(cat.id, cat);
    if (cat.parentId !== null) {
      const list = childrenByParent.get(cat.parentId) ?? [];
      list.push(cat.id);
      childrenByParent.set(cat.parentId, list);
    }
  }

  let newDepth = 1;
  if (params.proposedParentId !== null) {
    if (params.categoryId !== undefined && params.categoryId !== null && params.proposedParentId === params.categoryId) {
      return {
        ok: false,
        code: "CYCLIC_PARENT",
        message: "Kategori tidak boleh menjadi induk dirinya sendiri.",
      };
    }

    if (!byId.has(params.proposedParentId)) {
      return {
        ok: false,
        code: "INVALID_PARENT",
        message: `Kategori induk #${params.proposedParentId} tidak ditemukan.`,
      };
    }

    // Walk up ancestor chain to compute exact depth and detect cycles
    const visited = new Set<number>();
    if (params.categoryId !== undefined && params.categoryId !== null) {
      visited.add(params.categoryId);
    }

    let cursor: number | null = params.proposedParentId;
    let ancestorCount = 0;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        return {
          ok: false,
          code: "CYCLIC_PARENT",
          message: "Hirarki kategori tidak boleh membentuk siklus (loop).",
        };
      }
      visited.add(cursor);
      ancestorCount += 1;
      const node = byId.get(cursor);
      if (!node) break;
      cursor = node.parentId;
    }

    newDepth = ancestorCount + 1;
    if (newDepth > maxDepth) {
      return {
        ok: false,
        code: "MAX_DEPTH_EXCEEDED",
        message: `Kedalaman kategori maksimal ${maxDepth} tingkat.`,
      };
    }
  }

  // If reparenting an existing category, compute its deepest descendant height
  let maxDescendantOffset = 0;
  if (params.categoryId !== undefined && params.categoryId !== null && byId.has(params.categoryId)) {
    const seen = new Set<number>([params.categoryId]);
    const queue: Array<{ readonly id: number; readonly offset: number }> = [
      { id: params.categoryId, offset: 0 },
    ];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.offset > maxDescendantOffset) {
        maxDescendantOffset = current.offset;
      }
      for (const childId of childrenByParent.get(current.id) ?? []) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        queue.push({ id: childId, offset: current.offset + 1 });
      }
    }
  }

  const maxSubtreeDepth = newDepth + maxDescendantOffset;
  if (maxSubtreeDepth > maxDepth) {
    return {
      ok: false,
      code: "MAX_DEPTH_EXCEEDED",
      message: `Memindahkan kategori ini akan melebihi batas kedalaman ${maxDepth} tingkat.`,
    };
  }

  return {
    ok: true,
    depth: newDepth,
    maxSubtreeDepth,
  };
}

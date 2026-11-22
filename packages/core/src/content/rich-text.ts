import { HttpsUrlSchema } from "../schemas/common.ts";
import type { RestrictedRichTextDocSchema } from "../schemas/cms.ts";
import type { z } from "zod";

/**
 * Strict Rich-Text HTML Sanitizer, TipTap Restricted-JSON Renderer,
 * Deterministic Reading-Time Estimator & Heading TOC Extractor
 * (REQ-009, REQ-036, PLAN §5.2 & §7.3; TASK-006).
 *
 * Security invariants:
 * - Zero regex-only tag stripping: uses a real state-machine HTML tokenizer + tag stack.
 * - Drops dangerous subtrees completely (`<script>`, `<iframe>`, `<object>`, `<embed>`,
 *   `<svg>`, `<math>`, `<style>`, `<form>`, `<template>`, `<noscript>`, etc.).
 * - Drops all HTML comments, DOCTYPE, CDATA, and processing instructions.
 * - Strict tag & attribute allowlist; drops all `on*` handlers, `style`, `srcdoc`, `data-*`, etc.
 * - Decodes HTML entities + strips control characters BEFORE URL protocol checks, blocking
 *   `javascript:`, `vbscript:`, `data:`, protocol-relative `//`, and entity-encoded bypasses.
 * - Enforces `rel="noopener noreferrer"` on every `<a>` with a valid `href`.
 * - Only allows `https://` public URLs or safe tenant media root-relative paths on `<img>`.
 * - Idempotent: `sanitizeRichTextHtml(sanitizeRichTextHtml(x)) === sanitizeRichTextHtml(x)`.
 */

export type RestrictedRichTextDoc = z.infer<typeof RestrictedRichTextDocSchema>;
export type RestrictedRichTextNode = RestrictedRichTextDoc["blocks"][number];

export const WORDS_PER_MINUTE = 200 as const;
export const MAX_READING_TIME_MINUTES = 180 as const;
export const MAX_RICH_TEXT_HTML_LENGTH = 250_000 as const;

export const ALLOWED_RICH_TEXT_VOID_TAGS: ReadonlySet<string> = new Set(["br", "hr", "img"]);

export const ALLOWED_RICH_TEXT_CONTAINER_TAGS: ReadonlySet<string> = new Set([
  "p",
  "h2",
  "h3",
  "h4",
  "ul",
  "ol",
  "li",
  "blockquote",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "code",
  "pre",
  "a",
  "figure",
  "figcaption",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);

export const ALLOWED_RICH_TEXT_TAGS: ReadonlySet<string> = new Set([
  ...ALLOWED_RICH_TEXT_VOID_TAGS,
  ...ALLOWED_RICH_TEXT_CONTAINER_TAGS,
]);

/**
 * Dangerous elements whose entire subtree (opening tag, inner content, and closing tag)
 * MUST be discarded completely.
 */
const DANGEROUS_SUBTREE_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "applet",
  "svg",
  "math",
  "template",
  "noscript",
  "textarea",
  "title",
  "xmp",
  "form",
  "input",
  "button",
  "select",
  "option",
  "meta",
  "link",
  "base",
  "head",
  "frameset",
  "frame",
  "audio",
  "video",
  "source",
  "canvas",
  "portal",
  "dialog",
  "marquee",
  "keygen",
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  colon: ":",
  tab: "\t",
  newline: "\n",
  sol: "/",
  bsol: "\\",
  lpar: "(",
  rpar: ")",
  semi: ";",
  num: "#",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  copy: "©",
  reg: "®",
};

const SAFE_TENANT_MEDIA_SEGMENT = "[A-Za-z0-9._~@!$&'()*+,;=-]+";
const SAFE_TENANT_MEDIA_PATH_REGEX = new RegExp(
  `^/(?:(?:media|t)/${SAFE_TENANT_MEDIA_SEGMENT}(?:/${SAFE_TENANT_MEDIA_SEGMENT})*|cdn-cgi/image/[A-Za-z0-9_,=-]+/(?:media|t)/${SAFE_TENANT_MEDIA_SEGMENT}(?:/${SAFE_TENANT_MEDIA_SEGMENT})*)$`,
);
const SAFE_RELATIVE_HREF_REGEX =
  /^\/(?:[A-Za-z0-9._~:@!$&'()*+,;=%/?#-]*)$/;
const SAFE_FRAGMENT_HREF_REGEX = /^#[A-Za-z0-9._~:@!$&'()*+,;=%-]+$/;
const SAFE_MAILTO_REGEX = /^mailto:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/i;
const POSITIVE_DIMENSION_REGEX = /^[1-9]\d{0,4}$/;
const SMALL_SPAN_REGEX = /^(?:[1-9]|1\d|20)$/;

export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value);
}

/**
 * Decodes HTML named, decimal (`&#106;`), and hexadecimal (`&#x6a;`) entities.
 * Also handles malformed semicolon-less numeric entities used in XSS bypasses
 * (e.g. `&#106avascript:`).
 */
export function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(?:#x([0-9a-fA-F]{1,6});?|#([0-9]{1,7});?|([a-zA-Z]{2,12});?)/g,
    (match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (hex !== undefined) {
        const cp = Number.parseInt(hex, 16);
        if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
          if (cp === 0) return "";
          try {
            return String.fromCodePoint(cp);
          } catch {
            return "";
          }
        }
        return "";
      }
      if (dec !== undefined) {
        const cp = Number.parseInt(dec, 10);
        if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
          if (cp === 0) return "";
          try {
            return String.fromCodePoint(cp);
          } catch {
            return "";
          }
        }
        return "";
      }
      if (named !== undefined) {
        const lower = named.toLowerCase();
        if (lower in NAMED_ENTITIES) {
          return NAMED_ENTITIES[lower]!;
        }
      }
      return match;
    },
  );
}

function stripAsciiControlChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    out += value[i];
  }
  return out;
}

function isDisallowedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!lower) return true;
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower === "0.0.0.0" ||
    lower === "::1" ||
    lower === "::"
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return true;
    }
  }
  if (/^(?:fc|fd|fe80)/i.test(lower)) {
    return true;
  }
  return false;
}

/**
 * Validates an `<a href="...">` URL for rich text prose.
 * Allows ONLY:
 * - `https://` and `http://` public URLs (no embedded credentials, no private/loopback hosts)
 * - `mailto:` valid email addresses
 * - Root-relative paths (`/foo/bar`, never `//`) and fragment anchors (`#section`)
 * Returns the normalized safe URL or `null` when unsafe.
 */
export function sanitizeRichTextLinkHref(rawHref: string): string | null {
  const decoded = decodeHtmlEntities(rawHref);
  // Decode a second time to defeat double-encoded entity bypasses
  const doubleDecoded = decodeHtmlEntities(decoded);
  const cleaned = stripAsciiControlChars(doubleDecoded).trim();
  if (!cleaned || cleaned.length > 2048) {
    return null;
  }
  // Reject any whitespace/zero-width obfuscated scheme like `java\tscript:` or `javascript :`
  const schemeProbe = cleaned.replace(/[\s\u200B-\u200D\uFEFF]+/g, "").toLowerCase();
  if (
    schemeProbe.startsWith("javascript:") ||
    schemeProbe.startsWith("vbscript:") ||
    schemeProbe.startsWith("data:") ||
    schemeProbe.startsWith("file:") ||
    schemeProbe.startsWith("blob:")
  ) {
    return null;
  }
  if (cleaned.startsWith("//")) {
    return null;
  }
  if (cleaned.startsWith("/")) {
    if (cleaned.includes("..") || /[<>'"`\\]/.test(cleaned) || !SAFE_RELATIVE_HREF_REGEX.test(cleaned)) {
      return null;
    }
    return cleaned;
  }
  if (cleaned.startsWith("#")) {
    return SAFE_FRAGMENT_HREF_REGEX.test(cleaned) ? cleaned : null;
  }
  if (SAFE_MAILTO_REGEX.test(cleaned)) {
    return cleaned;
  }
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    if (isDisallowedHostname(parsed.hostname)) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Validates an `<img src="...">` URL for rich text prose.
 * Allows ONLY:
 * - Safe public `https://` URLs (validated by `HttpsUrlSchema`)
 * - Safe tenant media root-relative paths (`/media/...`, `/cdn-cgi/image/...`, `/t/...`)
 * Rejects `http://`, `data:`, `javascript:`, `vbscript:`, `//`, private hosts, and path traversal.
 */
export function sanitizeRichTextImageSrc(rawSrc: string): string | null {
  const decoded = decodeHtmlEntities(decodeHtmlEntities(rawSrc));
  const cleaned = stripAsciiControlChars(decoded).trim();
  if (!cleaned || cleaned.length > 2048) {
    return null;
  }
  const schemeProbe = cleaned.replace(/[\s\u200B-\u200D\uFEFF]+/g, "").toLowerCase();
  if (
    schemeProbe.startsWith("javascript:") ||
    schemeProbe.startsWith("vbscript:") ||
    schemeProbe.startsWith("data:") ||
    schemeProbe.startsWith("file:") ||
    schemeProbe.startsWith("blob:") ||
    cleaned.startsWith("//")
  ) {
    return null;
  }
  if (cleaned.startsWith("/")) {
    if (
      cleaned.includes("..") ||
      cleaned.includes("//") ||
      cleaned.includes(":") ||
      cleaned.includes("%") ||
      /[<>'"`\\]/.test(cleaned)
    ) {
      return null;
    }
    return SAFE_TENANT_MEDIA_PATH_REGEX.test(cleaned) ? cleaned : null;
  }
  const parsedHttps = HttpsUrlSchema.safeParse(cleaned);
  if (!parsedHttps.success) {
    return null;
  }
  return parsedHttps.data;
}

interface ParsedAttribute {
  readonly name: string;
  readonly value: string;
}

function parseTagAttributes(rawAttrs: string): ParsedAttribute[] {
  const attrs: ParsedAttribute[] = [];
  const len = rawAttrs.length;
  let i = 0;

  while (i < len) {
    // Skip whitespace and stray slashes
    while (i < len && /[\s/]/.test(rawAttrs[i]!)) {
      i += 1;
    }
    if (i >= len) break;

    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(rawAttrs[i]!)) {
      i += 1;
    }
    const name = rawAttrs.slice(nameStart, i).toLowerCase();
    if (!name) {
      i += 1;
      continue;
    }

    while (i < len && /\s/.test(rawAttrs[i]!)) {
      i += 1;
    }

    let value = "";
    if (i < len && rawAttrs[i] === "=") {
      i += 1;
      while (i < len && /\s/.test(rawAttrs[i]!)) {
        i += 1;
      }
      if (i < len && (rawAttrs[i] === '"' || rawAttrs[i] === "'")) {
        const quote = rawAttrs[i]!;
        i += 1;
        const valStart = i;
        while (i < len && rawAttrs[i] !== quote) {
          i += 1;
        }
        value = rawAttrs.slice(valStart, i);
        if (i < len && rawAttrs[i] === quote) {
          i += 1;
        }
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(rawAttrs[i]!)) {
          i += 1;
        }
        value = rawAttrs.slice(valStart, i);
      }
    }

    attrs.push({ name, value });
  }

  return attrs;
}

function buildSanitizedAttributes(
  tagName: string,
  rawAttrs: readonly ParsedAttribute[],
): { readonly dropElement: boolean; readonly attrString: string } {
  if (tagName === "a") {
    let href: string | null = null;
    let title: string | null = null;
    let target: string | null = null;

    for (const attr of rawAttrs) {
      if (attr.name === "href") {
        href = sanitizeRichTextLinkHref(attr.value);
      } else if (attr.name === "title") {
        const cleanTitle = stripAsciiControlChars(decodeHtmlEntities(attr.value)).trim().slice(0, 200);
        if (cleanTitle) title = cleanTitle;
      } else if (attr.name === "target" && attr.value.trim().toLowerCase() === "_blank") {
        target = "_blank";
      }
    }

    const parts: string[] = [];
    if (href !== null) {
      parts.push(`href="${escapeHtmlAttr(href)}"`);
      parts.push('rel="noopener noreferrer"');
    }
    if (target !== null && href !== null) {
      parts.push('target="_blank"');
    }
    if (title !== null) {
      parts.push(`title="${escapeHtmlAttr(title)}"`);
    }
    return { dropElement: false, attrString: parts.length > 0 ? ` ${parts.join(" ")}` : "" };
  }

  if (tagName === "img") {
    let src: string | null = null;
    let alt = "";
    let width: string | null = null;
    let height: string | null = null;
    let loading: string | null = null;
    let decoding: string | null = null;

    for (const attr of rawAttrs) {
      if (attr.name === "src") {
        src = sanitizeRichTextImageSrc(attr.value);
      } else if (attr.name === "alt") {
        alt = stripAsciiControlChars(decodeHtmlEntities(attr.value)).trim().slice(0, 250);
      } else if (attr.name === "width" && POSITIVE_DIMENSION_REGEX.test(attr.value.trim())) {
        const n = Number(attr.value.trim());
        if (n >= 1 && n <= 10_000) width = String(n);
      } else if (attr.name === "height" && POSITIVE_DIMENSION_REGEX.test(attr.value.trim())) {
        const n = Number(attr.value.trim());
        if (n >= 1 && n <= 10_000) height = String(n);
      } else if (attr.name === "loading") {
        const v = attr.value.trim().toLowerCase();
        if (v === "lazy" || v === "eager") loading = v;
      } else if (attr.name === "decoding") {
        const v = attr.value.trim().toLowerCase();
        if (v === "async" || v === "auto") decoding = v;
      }
    }

    if (src === null) {
      return { dropElement: true, attrString: "" };
    }

    const parts: string[] = [`src="${escapeHtmlAttr(src)}"`, `alt="${escapeHtmlAttr(alt)}"`];
    if (width !== null) parts.push(`width="${width}"`);
    if (height !== null) parts.push(`height="${height}"`);
    if (loading !== null) parts.push(`loading="${loading}"`);
    if (decoding !== null) parts.push(`decoding="${decoding}"`);
    return { dropElement: false, attrString: ` ${parts.join(" ")}` };
  }

  if (tagName === "th" || tagName === "td") {
    const parts: string[] = [];
    for (const attr of rawAttrs) {
      if (attr.name === "colspan" && SMALL_SPAN_REGEX.test(attr.value.trim())) {
        parts.push(`colspan="${attr.value.trim()}"`);
      } else if (attr.name === "rowspan" && SMALL_SPAN_REGEX.test(attr.value.trim())) {
        parts.push(`rowspan="${attr.value.trim()}"`);
      } else if (tagName === "th" && attr.name === "scope") {
        const v = attr.value.trim().toLowerCase();
        if (v === "col" || v === "row") {
          parts.push(`scope="${v}"`);
        }
      }
    }
    return { dropElement: false, attrString: parts.length > 0 ? ` ${parts.join(" ")}` : "" };
  }

  return { dropElement: false, attrString: "" };
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function sanitizeRichTextHtmlSinglePass(
  rawHtml: string,
  maxLength: number = MAX_RICH_TEXT_HTML_LENGTH,
): string {
  if (!rawHtml || maxLength <= 0) return "";

  const input = rawHtml.replace(/\0/g, "");
  const out: string[] = [];
  const openStack: string[] = [];
  const skipStack: string[] = [];
  const len = input.length;
  let outputLen = 0;
  let openCloseLen = 0;
  let i = 0;

  const remainingBudget = (): number => maxLength - outputLen - openCloseLen;

  const emitAtomic = (chunk: string): boolean => {
    if (chunk.length > remainingBudget()) {
      return false;
    }
    out.push(chunk);
    outputLen += chunk.length;
    return true;
  };

  const emitOpenTag = (tagName: string, attrString: string, selfClosing: boolean): boolean => {
    const openTag = `<${tagName}${attrString}>`;
    const closeLen = tagName.length + 3; // `</${tagName}>`
    if (openTag.length + closeLen > remainingBudget()) {
      return false;
    }
    if (selfClosing) {
      const closeTag = `</${tagName}>`;
      out.push(openTag, closeTag);
      outputLen += openTag.length + closeLen;
      return true;
    }
    out.push(openTag);
    outputLen += openTag.length;
    openStack.push(tagName);
    openCloseLen += closeLen;
    return true;
  };

  const emitCloseTop = (): void => {
    const closing = openStack.pop()!;
    const closeTag = `</${closing}>`;
    openCloseLen -= closeTag.length;
    out.push(closeTag);
    outputLen += closeTag.length;
  };

  const emitText = (rawText: string): boolean => {
    const decoded = decodeHtmlEntities(rawText);
    const escaped = escapeHtmlText(decoded);
    const budget = remainingBudget();
    if (escaped.length <= budget) {
      if (escaped.length > 0) {
        out.push(escaped);
        outputLen += escaped.length;
      }
      return true;
    }
    // Budget would be exceeded: emit only complete Unicode code points & complete HTML entities
    let chunk = "";
    let used = 0;
    for (const ch of decoded) {
      const escCh = escapeHtmlText(ch);
      if (used + escCh.length > budget) {
        break;
      }
      chunk += escCh;
      used += escCh.length;
    }
    if (chunk.length > 0) {
      out.push(chunk);
      outputLen += chunk.length;
    }
    return false;
  };

  while (i < len) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      if (skipStack.length === 0) {
        emitText(input.slice(i));
      }
      break;
    }

    if (lt > i && skipStack.length === 0) {
      if (!emitText(input.slice(i, lt))) {
        break;
      }
    }

    // HTML comment: <!-- ... -->
    if (input.startsWith("<!--", lt)) {
      const commentEnd = input.indexOf("-->", lt + 4);
      i = commentEnd === -1 ? len : commentEnd + 3;
      continue;
    }

    // CDATA: <![CDATA[ ... ]]>
    if (input.slice(lt, lt + 9).toUpperCase() === "<![CDATA[") {
      const cdataEnd = input.indexOf("]]>", lt + 9);
      i = cdataEnd === -1 ? len : cdataEnd + 3;
      continue;
    }

    // Processing instruction or declaration: <? ... ?> or <! ... >
    const nextChar = input[lt + 1];
    if (nextChar === "?" || nextChar === "!") {
      const end = input.indexOf(">", lt + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }

    // Stray '<' that does not start a tag name or closing tag
    if (!nextChar || !/[a-zA-Z/]/.test(nextChar)) {
      if (skipStack.length === 0) {
        if (!emitAtomic("&lt;")) {
          break;
        }
      }
      i = lt + 1;
      continue;
    }

    const gt = findTagEnd(input, lt + 1);
    if (gt === -1) {
      // Unclosed tag at EOF: drop completely so malformed tags cannot become executable HTML
      break;
    }

    const inner = input.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (!inner) {
      continue;
    }

    const isClosing = inner.startsWith("/");
    const tagBody = isClosing ? inner.slice(1).trim() : inner;
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(tagBody);
    if (!nameMatch) {
      continue;
    }

    const tagName = nameMatch[1]!.toLowerCase();
    const rest = tagBody.slice(nameMatch[1]!.length);
    const selfClosing = !isClosing && /\/\s*$/.test(rest);

    // Handle dangerous subtree skipping
    if (skipStack.length > 0) {
      if (isClosing) {
        const idx = skipStack.lastIndexOf(tagName);
        if (idx !== -1) {
          skipStack.length = idx;
        }
      } else if (!selfClosing && DANGEROUS_SUBTREE_TAGS.has(tagName)) {
        skipStack.push(tagName);
      }
      continue;
    }

    if (DANGEROUS_SUBTREE_TAGS.has(tagName)) {
      if (
        !isClosing &&
        !selfClosing &&
        tagName !== "input" &&
        tagName !== "embed" &&
        tagName !== "meta" &&
        tagName !== "link" &&
        tagName !== "base" &&
        tagName !== "source"
      ) {
        skipStack.push(tagName);
      }
      continue;
    }

    if (!ALLOWED_RICH_TEXT_TAGS.has(tagName)) {
      // Unlisted non-dangerous tag (e.g., <div>, <span>, <h1>, <font>): strip tag, keep children
      continue;
    }

    if (isClosing) {
      if (ALLOWED_RICH_TEXT_VOID_TAGS.has(tagName)) {
        continue;
      }
      const matchIdx = openStack.lastIndexOf(tagName);
      if (matchIdx !== -1) {
        while (openStack.length > matchIdx) {
          emitCloseTop();
        }
      }
      continue;
    }

    const parsedAttrs = parseTagAttributes(rest);
    const { dropElement, attrString } = buildSanitizedAttributes(tagName, parsedAttrs);
    if (dropElement) {
      continue;
    }

    if (ALLOWED_RICH_TEXT_VOID_TAGS.has(tagName)) {
      if (!emitAtomic(`<${tagName}${attrString}>`)) {
        break;
      }
    } else if (!emitOpenTag(tagName, attrString, selfClosing)) {
      break;
    }
  }

  while (openStack.length > 0) {
    emitCloseTop();
  }

  return out.join("").trim();
}

/**
 * Sanitizes untrusted rich-text HTML down to a strict semantic prose allowlist.
 * Enforces `MAX_RICH_TEXT_HTML_LENGTH` inside the serializer while reserving closing-tag
 * space so output is always well-formed (never cut mid-tag/mid-attribute/mid-entity) and
 * executes a second convergence pass to guarantee strict idempotency.
 */
export function sanitizeRichTextHtml(rawHtml: string): string {
  if (typeof rawHtml !== "string") return "";
  const pass1 = sanitizeRichTextHtmlSinglePass(rawHtml, MAX_RICH_TEXT_HTML_LENGTH);
  return sanitizeRichTextHtmlSinglePass(pass1, MAX_RICH_TEXT_HTML_LENGTH);
}

/**
 * Strips all HTML tags from sanitized HTML and returns clean plain text.
 */
export function stripHtmlToPlainText(rawHtml: string): string {
  if (typeof rawHtml !== "string" || !rawHtml) return "";
  const sanitized = sanitizeRichTextHtml(rawHtml);
  const withSpaces = sanitized
    .replace(/<(?:br|hr)\b[^>]*>/gi, " ")
    .replace(/<\/?(?:p|h[2-4]|ul|ol|li|blockquote|pre|figure|figcaption|table|thead|tbody|tr|th|td)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(withSpaces).replace(/\s+/g, " ").trim();
}

/**
 * Sanitizes every node of a `RestrictedRichTextDoc`, stripping hostile HTML/script
 * payloads from block text while preserving ordinary plain prose characters (`&`, etc.).
 */
export function sanitizeRichTextDoc(doc: RestrictedRichTextDoc): RestrictedRichTextDoc {
  const cleanBlocks: RestrictedRichTextNode[] = [];
  for (const block of doc.blocks) {
    let cleanText = block.text;
    if (typeof cleanText === "string" && cleanText.includes("<")) {
      // Strip dangerous tags/handlers completely while preserving safe plain text
      cleanText = stripHtmlToPlainText(cleanText);
    }
    const cleanHref =
      block.href !== undefined ? sanitizeRichTextLinkHref(block.href) ?? undefined : undefined;

    cleanBlocks.push({
      ...block,
      ...(cleanText !== undefined ? { text: cleanText } : {}),
      ...(cleanHref !== undefined ? { href: cleanHref } : {}),
    });
  }
  return {
    schemaVersion: 1,
    blocks: cleanBlocks,
  };
}

function applyMarksToHtml(text: string, node: RestrictedRichTextNode): string {
  let rendered = escapeHtmlText(text);
  const marks = node.marks ?? [];
  for (const mark of marks) {
    if (mark === "bold") rendered = `<strong>${rendered}</strong>`;
    else if (mark === "italic") rendered = `<em>${rendered}</em>`;
    else if (mark === "underline") rendered = `<u>${rendered}</u>`;
    else if (mark === "code") rendered = `<code>${rendered}</code>`;
    else if (mark === "link" && node.href) {
      const safeHref = sanitizeRichTextLinkHref(node.href);
      if (safeHref) {
        rendered = `<a href="${escapeHtmlAttr(safeHref)}" rel="noopener noreferrer">${rendered}</a>`;
      }
    }
  }
  if (!marks.includes("link") && node.href) {
    const safeHref = sanitizeRichTextLinkHref(node.href);
    if (safeHref) {
      rendered = `<a href="${escapeHtmlAttr(safeHref)}" rel="noopener noreferrer">${rendered}</a>`;
    }
  }
  return rendered;
}

/**
 * Deterministically renders a validated `RestrictedRichTextDoc` to strict sanitized HTML.
 */
export function renderRichTextDocToSanitizedHtml(doc: RestrictedRichTextDoc): string {
  const sanitizedDoc = sanitizeRichTextDoc(doc);
  const parts: string[] = [];

  for (const block of sanitizedDoc.blocks) {
    const content = applyMarksToHtml(block.text ?? "", block);
    switch (block.type) {
      case "heading": {
        const level = block.level ?? 2;
        parts.push(`<h${level}>${content}</h${level}>`);
        break;
      }
      case "paragraph":
      case "text":
      case "doc": {
        if (content) parts.push(`<p>${content}</p>`);
        break;
      }
      case "blockquote": {
        parts.push(`<blockquote><p>${content}</p></blockquote>`);
        break;
      }
      case "bulletList": {
        parts.push(`<ul><li>${content}</li></ul>`);
        break;
      }
      case "orderedList": {
        parts.push(`<ol><li>${content}</li></ol>`);
        break;
      }
      case "listItem": {
        parts.push(`<ul><li>${content}</li></ul>`);
        break;
      }
      case "table":
      case "tableRow":
      case "tableCell": {
        parts.push(`<table><tbody><tr><td>${content}</td></tr></tbody></table>`);
        break;
      }
      case "hardBreak": {
        parts.push("<br>");
        break;
      }
      case "image": {
        if (block.mediaId !== undefined) {
          const alt = escapeHtmlAttr((block.text ?? "").slice(0, 250));
          parts.push(`<figure><img src="/media/${block.mediaId}" alt="${alt}"></figure>`);
        }
        break;
      }
    }
  }

  return sanitizeRichTextHtml(parts.join(""));
}

/**
 * Converts sanitized HTML into a schema-valid `RestrictedRichTextDoc` so raw-HTML
 * editors and TipTap JSON consumers share one canonical storage format.
 */
export function htmlToRestrictedRichTextDoc(rawHtml: string): RestrictedRichTextDoc {
  const sanitized = sanitizeRichTextHtml(rawHtml);
  if (!sanitized) {
    return { schemaVersion: 1, blocks: [] };
  }

  const blocks: RestrictedRichTextNode[] = [];
  const blockRegex =
    /<(h[2-4]|p|blockquote|li|pre|figcaption|tr)\b[^>]*>([\s\S]*?)<\/\1>|<img\b([^>]*)>/gi;

  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = blockRegex.exec(sanitized)) !== null && blocks.length < 500) {
    if (match.index > lastIndex) {
      const stray = stripHtmlToPlainText(sanitized.slice(lastIndex, match.index));
      if (stray) {
        blocks.push({ type: "paragraph", text: stray.slice(0, 10_000) });
      }
    }
    lastIndex = blockRegex.lastIndex;

    const tag = match[1]?.toLowerCase();
    const inner = match[2] ?? "";

    if (!tag && match[3] !== undefined) {
      // Standalone <img>
      const attrs = parseTagAttributes(match[3]);
      const alt = attrs.find((a) => a.name === "alt")?.value ?? "";
      const src = attrs.find((a) => a.name === "src")?.value ?? "";
      const mediaMatch = /^\/media\/([1-9]\d{0,9})$/.exec(src);
      if (mediaMatch) {
        blocks.push({
          type: "image",
          mediaId: Number(mediaMatch[1]),
          ...(alt ? { text: decodeHtmlEntities(alt).slice(0, 250) } : {}),
        });
      } else if (alt) {
        blocks.push({ type: "paragraph", text: decodeHtmlEntities(alt).slice(0, 10_000) });
      }
      continue;
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
    } else if (tag === "li") {
      blocks.push({ type: "listItem", text: plain });
    } else if (tag === "tr") {
      blocks.push({ type: "tableRow", text: plain });
    } else {
      blocks.push({ type: "paragraph", text: plain });
    }
  }

  if (lastIndex < sanitized.length && blocks.length < 500) {
    const tail = stripHtmlToPlainText(sanitized.slice(lastIndex));
    if (tail) {
      blocks.push({ type: "paragraph", text: tail.slice(0, 10_000) });
    }
  }

  if (blocks.length === 0) {
    const fallbackText = stripHtmlToPlainText(sanitized);
    if (fallbackText) {
      blocks.push({ type: "paragraph", text: fallbackText.slice(0, 10_000) });
    }
  }

  return { schemaVersion: 1, blocks };
}

/**
 * Counts human-readable words after stripping HTML tags and decoding entities.
 */
export function countWordsFromRichText(input: string | RestrictedRichTextDoc): number {
  const plainText =
    typeof input === "string"
      ? stripHtmlToPlainText(input)
      : input.blocks
          .map((block) => (typeof block.text === "string" ? stripHtmlToPlainText(block.text) : ""))
          .filter(Boolean)
          .join(" ");

  if (!plainText) return 0;
  const matches = plainText.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

/**
 * Deterministically computes reading time in minutes (`Math.max(1, Math.ceil(words / 200))`,
 * capped at `180` minutes to match `PostSnapshotSchema`).
 */
export function calculateReadingTimeMinutes(
  input: string | RestrictedRichTextDoc,
  wordsPerMinute: number = WORDS_PER_MINUTE,
): number {
  const wpm = Number.isFinite(wordsPerMinute) && wordsPerMinute > 0 ? wordsPerMinute : WORDS_PER_MINUTE;
  const wordCount = countWordsFromRichText(input);
  return Math.min(MAX_READING_TIME_MINUTES, Math.max(1, Math.ceil(wordCount / wpm)));
}

export interface TocHeadingEntry {
  readonly id: string;
  readonly text: string;
  readonly level: 2 | 3;
}

/**
 * Extracts `h2` and `h3` Table-of-Contents entries from sanitized HTML with unique anchor IDs.
 */
export function extractTocFromSanitizedHtml(sanitizedHtml: string): readonly TocHeadingEntry[] {
  const entries: TocHeadingEntry[] = [];
  const usedIds = new Map<string, number>();
  const headingRegex = /<(h[23])\b[^>]*>([\s\S]*?)<\/\1>/gi;

  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(sanitizedHtml)) !== null && entries.length < 100) {
    const level = match[1]!.toLowerCase() === "h2" ? 2 : 3;
    const text = stripHtmlToPlainText(match[2] ?? "").slice(0, 200);
    if (!text) continue;

    const baseId =
      text
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 72) || `section-${entries.length + 1}`;

    const seen = usedIds.get(baseId) ?? 0;
    usedIds.set(baseId, seen + 1);
    const id = seen === 0 ? baseId : `${baseId}-${seen + 1}`;
    entries.push({ id, text, level });
  }

  return entries;
}

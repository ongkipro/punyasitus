import { MAX_FIELD_TEXT_CHARS, normalizeScreeningHost } from "./normalize.ts";

/**
 * Structured content extractor for publish-time screening (REQ-103, PLAN §20.1, TASK-103).
 *
 * Extracts every publishable text, title, link (resolved hostname), image ALT (including hidden
 * or HTML/Markdown-embedded ALT attributes), and custom-form label in a bounded, cycle-safe walk.
 */

export const SCREENING_FIELD_KINDS = [
  "title",
  "text",
  "link_host",
  "image_alt",
  "form_label",
] as const;
export type ScreeningFieldKind = (typeof SCREENING_FIELD_KINDS)[number];

export interface ExtractedTextField {
  readonly kind: Exclude<ScreeningFieldKind, "link_host">;
  readonly path: string;
  readonly value: string;
}

export interface ExtractedLinkField {
  readonly path: string;
  readonly rawUrl: string;
  readonly host: string;
}

export interface ExtractedPublishContent {
  readonly texts: readonly ExtractedTextField[];
  readonly links: readonly ExtractedLinkField[];
  readonly truncated: boolean;
}

export const MAX_EXTRACTED_TEXT_FIELDS = 500 as const;
export const MAX_EXTRACTED_LINKS = 300 as const;
const MAX_WALK_DEPTH = 14;

const TITLE_KEY_SET: ReadonlySet<string> = new Set([
  "title",
  "name",
  "headline",
  "heading",
  "sitetitle",
  "businessname",
  "metatitle",
  "ogtitle",
]);

const ALT_KEY_SET: ReadonlySet<string> = new Set([
  "alt",
  "alttext",
  "imagealt",
  "coveralt",
  "logoalt",
  "caption",
  "arialabel",
]);

const FORM_LABEL_KEY_SET: ReadonlySet<string> = new Set([
  "label",
  "fieldlabel",
  "submitlabel",
  "placeholder",
  "helptext",
  "successmessage",
  "formtitle",
  "formdescription",
]);

const LINK_KEY_SET: ReadonlySet<string> = new Set([
  "url",
  "href",
  "link",
  "linkurl",
  "ctaurl",
  "externalurl",
  "redirecturl",
  "actionurl",
  "whatsappurl",
  "websiteurl",
  "targeturl",
  "buttonurl",
  "src",
]);

// Flat, linear regexes without nested quantifiers (guaranteed ReDoS-safe)
const INLINE_URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;
const WWW_URL_RE = /\bwww\.[a-z0-9-]+\.[a-z]{2,}[^\s<>"'`)\]}]*/gi;
const HTML_IMG_ALT_DOUBLE_RE = /<img\b[^>]{0,2000}\balt="([^"]{1,500})"/gi;
const HTML_IMG_ALT_SINGLE_RE = /<img\b[^>]{0,2000}\balt='([^']{1,500})'/gi;
const MD_IMG_ALT_RE = /!\[([^\]]{1,500})\]\(([^)]{1,1000})\)/g;
const HTML_HREF_DOUBLE_RE = /\bhref="([^"]{1,1000})"/gi;
const HTML_HREF_SINGLE_RE = /\bhref='([^']{1,1000})'/gi;

function isDomainTokenChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2d || // -
    code === 0x2e // .
  );
}

/**
 * Strictly O(N) single-pass scanner extracting bare domain tokens and protocol-relative
 * hostnames (`//evil.com`, `x//evil.com`, `evil.com`) with ZERO regex backtracking.
 */
function scanBareAndProtocolRelativeDomains(
  text: string,
  visitor: (candidate: string, isProtocolRelative: boolean) => void,
): void {
  const len = text.length;
  let i = 0;
  while (i < len) {
    if (!isDomainTokenChar(text.charCodeAt(i))) {
      i += 1;
      continue;
    }

    const start = i;
    let hasDot = false;
    while (i < len && isDomainTokenChar(text.charCodeAt(i))) {
      if (text.charCodeAt(i) === 0x2e) hasDot = true;
      i += 1;
    }

    if (!hasDot) continue;

    // Trim leading/trailing dots/hyphens in O(k)
    let left = start;
    let right = i;
    while (left < right && (text.charCodeAt(left) === 0x2e || text.charCodeAt(left) === 0x2d)) {
      left += 1;
    }
    while (
      right > left &&
      (text.charCodeAt(right - 1) === 0x2e || text.charCodeAt(right - 1) === 0x2d)
    ) {
      right -= 1;
    }
    if (right - left < 4 || right - left > 253) continue;

    const prevChar = start > 0 ? text.charCodeAt(start - 1) : 0;
    const nextChar = i < len ? text.charCodeAt(i) : 0;
    // Skip email addresses (`local@domain.tld`) so normal contact emails aren't treated as bare links
    if (prevChar === 0x40 || nextChar === 0x40) continue;

    const candidate = text.slice(left, right);
    if (!candidate.includes(".")) continue;

    const isProtocolRelative =
      start >= 2 && text.charCodeAt(start - 1) === 0x2f && text.charCodeAt(start - 2) === 0x2f;
    visitor(candidate, isProtocolRelative);
  }
}

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

function classifyFieldKind(
  key: string,
  insideFormContext: boolean,
): Exclude<ScreeningFieldKind, "link_host"> {
  const norm = normalizeKey(key);
  if (ALT_KEY_SET.has(norm) || norm.endsWith("alt") || norm.endsWith("alttext")) {
    return "image_alt";
  }
  if (insideFormContext && (FORM_LABEL_KEY_SET.has(norm) || norm === "options" || norm === "option")) {
    return "form_label";
  }
  if (FORM_LABEL_KEY_SET.has(norm)) {
    return "form_label";
  }
  if (TITLE_KEY_SET.has(norm)) {
    return "title";
  }
  return "text";
}

function isLinkKey(key: string): boolean {
  const norm = normalizeKey(key);
  return LINK_KEY_SET.has(norm) || norm.endsWith("url") || norm.endsWith("href");
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

export interface PublishScreeningInputPayload {
  readonly title?: string | null;
  readonly slug?: string | null;
  readonly text?: string | null;
  readonly links?: readonly string[];
  readonly imageAlts?: readonly string[];
  readonly formLabels?: readonly string[];
  /** Arbitrary structured draft snapshot (page sections, post blocks, offering fields, custom form schema, etc.). */
  readonly snapshot?: unknown;
  /** Whether the root snapshot itself represents a custom form definition. */
  readonly isFormResource?: boolean;
}

/**
 * Extracts all screenable titles, text values, resolved link hostnames, image ALT attributes
 * (including hidden HTML/Markdown ALTs), and custom-form labels from a publish payload.
 */
export function extractPublishContent(
  input: PublishScreeningInputPayload,
): ExtractedPublishContent {
  const texts: ExtractedTextField[] = [];
  const links: ExtractedLinkField[] = [];
  const seenLinks = new Set<string>();
  let truncated = false;

  const pushText = (kind: Exclude<ScreeningFieldKind, "link_host">, path: string, raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (texts.length >= MAX_EXTRACTED_TEXT_FIELDS) {
      truncated = true;
      return;
    }
    texts.push({ kind, path, value: trimmed });
  };

  const pushLink = (path: string, rawUrl: string) => {
    const cleaned = decodeBasicHtmlEntities(rawUrl.trim()).replace(/[.,;:!?]+$/g, "");
    if (!cleaned) return;
    let withScheme = cleaned;
    if (cleaned.startsWith("//")) {
      withScheme = `https:${cleaned}`;
    } else if (cleaned.toLowerCase().startsWith("www.")) {
      withScheme = `https://${cleaned}`;
    }
    const host = normalizeScreeningHost(withScheme);
    if (!host) return;
    const dedupKey = `${path}|${host}`;
    if (seenLinks.has(dedupKey)) return;
    if (links.length >= MAX_EXTRACTED_LINKS) {
      truncated = true;
      return;
    }
    seenLinks.add(dedupKey);
    links.push({ path, rawUrl: cleaned.slice(0, 300), host });
  };

  const extractInlineArtifacts = (path: string, rawTextValue: string) => {
    let textValue = rawTextValue;
    if (textValue.length > MAX_FIELD_TEXT_CHARS) {
      truncated = true;
      textValue = textValue.slice(0, MAX_FIELD_TEXT_CHARS);
    }

    // 1. Inline URLs, www.* hosts, and strictly O(N) bare / protocol-relative (`//host`, `x//host`) domains
    INLINE_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INLINE_URL_RE.exec(textValue)) !== null) {
      pushLink(`${path}.inline_url`, m[0]);
    }

    WWW_URL_RE.lastIndex = 0;
    while ((m = WWW_URL_RE.exec(textValue)) !== null) {
      pushLink(`${path}.inline_www`, m[0]);
    }

    if (textValue.includes(".")) {
      scanBareAndProtocolRelativeDomains(textValue, (candidate, isProtocolRelative) => {
        pushLink(
          isProtocolRelative ? `${path}.protocol_rel_url` : `${path}.bare_domain`,
          isProtocolRelative ? `//${candidate}` : candidate,
        );
      });
    }

    // 2. HTML <a href="...">
    if (textValue.includes("href=")) {
      HTML_HREF_DOUBLE_RE.lastIndex = 0;
      while ((m = HTML_HREF_DOUBLE_RE.exec(textValue)) !== null) {
        if (m[1]) pushLink(`${path}.html_href`, m[1]);
      }
      HTML_HREF_SINGLE_RE.lastIndex = 0;
      while ((m = HTML_HREF_SINGLE_RE.exec(textValue)) !== null) {
        if (m[1]) pushLink(`${path}.html_href`, m[1]);
      }
    }

    // 3. HTML <img alt="..."> (including visually hidden or sr-only images)
    if (textValue.includes("<img") || textValue.includes("<IMG")) {
      HTML_IMG_ALT_DOUBLE_RE.lastIndex = 0;
      while ((m = HTML_IMG_ALT_DOUBLE_RE.exec(textValue)) !== null) {
        if (m[1]) pushText("image_alt", `${path}.html_img_alt`, decodeBasicHtmlEntities(m[1]));
      }
      HTML_IMG_ALT_SINGLE_RE.lastIndex = 0;
      while ((m = HTML_IMG_ALT_SINGLE_RE.exec(textValue)) !== null) {
        if (m[1]) pushText("image_alt", `${path}.html_img_alt`, decodeBasicHtmlEntities(m[1]));
      }
    }

    // 4. Markdown ![alt](url)
    if (textValue.includes("![")) {
      MD_IMG_ALT_RE.lastIndex = 0;
      while ((m = MD_IMG_ALT_RE.exec(textValue)) !== null) {
        if (m[1]) pushText("image_alt", `${path}.md_img_alt`, m[1]);
        if (m[2]) pushLink(`${path}.md_img_url`, m[2]);
      }
    }
  };

  if (input.title) {
    pushText("title", "title", input.title);
    extractInlineArtifacts("title", input.title);
  }
  if (input.slug) {
    pushText("title", "slug", input.slug);
  }
  if (input.text) {
    pushText("text", "text", input.text);
    extractInlineArtifacts("text", input.text);
  }
  if (Array.isArray(input.links)) {
    input.links.forEach((rawUrl, idx) => {
      if (typeof rawUrl === "string") {
        pushLink(`links[${idx}]`, rawUrl);
      }
    });
  }
  if (Array.isArray(input.imageAlts)) {
    input.imageAlts.forEach((alt, idx) => {
      if (typeof alt === "string") {
        pushText("image_alt", `imageAlts[${idx}]`, alt);
        extractInlineArtifacts(`imageAlts[${idx}]`, alt);
      }
    });
  }
  if (Array.isArray(input.formLabels)) {
    input.formLabels.forEach((label, idx) => {
      if (typeof label === "string") {
        pushText("form_label", `formLabels[${idx}]`, label);
        extractInlineArtifacts(`formLabels[${idx}]`, label);
      }
    });
  }

  const visited = new WeakSet<object>();

  const walk = (value: unknown, path: string, keyName: string, depth: number, inForm: boolean) => {
    if (value === null || value === undefined) return;
    if (depth > MAX_WALK_DEPTH) {
      truncated = true;
      return;
    }

    if (typeof value === "string") {
      if (isLinkKey(keyName)) {
        pushLink(path, value);
      }
      const kind = classifyFieldKind(keyName, inForm);
      pushText(kind, path, value);
      extractInlineArtifacts(path, value);
      return;
    }

    if (typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        if (texts.length >= MAX_EXTRACTED_TEXT_FIELDS && links.length >= MAX_EXTRACTED_LINKS) {
          truncated = true;
          break;
        }
        walk(value[i], `${path}[${i}]`, keyName, depth + 1, inForm);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    const nextInForm =
      inForm ||
      normalizeKey(keyName).includes("form") ||
      record.type === "form" ||
      record.sectionType === "form" ||
      Array.isArray(record.fields);

    for (const [k, v] of Object.entries(record)) {
      if (texts.length >= MAX_EXTRACTED_TEXT_FIELDS && links.length >= MAX_EXTRACTED_LINKS) {
        truncated = true;
        break;
      }
      const nextPath = path ? `${path}.${k}` : k;
      walk(v, nextPath, k, depth + 1, nextInForm);
    }
  };

  if (input.snapshot !== undefined) {
    walk(input.snapshot, "snapshot", "snapshot", 0, Boolean(input.isFormResource));
  }

  return { texts, links, truncated };
}

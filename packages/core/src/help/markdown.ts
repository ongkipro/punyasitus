import { z } from "zod";
import {
  HELP_CATEGORY_IDS,
  REQUIRED_HELP_LAUNCH_TOPICS,
  type HelpCategoryId,
  type HelpLaunchTopic,
} from "./categories.ts";

/**
 * Safe frontmatter parser & XSS-hardened Markdown renderer for Help Center articles
 * (`apps/web/src/content/bantuan/*.md`).
 *
 * Security invariants:
 * - Zero raw HTML passthrough: all text is HTML-escaped before inline formatting.
 * - Links allow only `https://`, `http://`, or site-relative `/` paths (rejects `javascript:`, `data:`).
 * - Deterministic heading IDs for server-rendered zero-JS Table of Contents.
 */

export const HELP_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const HelpArticleFrontmatterSchema = z.object({
  slug: z.string().regex(HELP_SLUG_RE, "Slug artikel harus huruf kecil kebab-case"),
  title: z.string().min(10).max(120),
  summary: z.string().min(20).max(240),
  category: z.enum(HELP_CATEGORY_IDS),
  order: z.number().int().min(1).max(999),
  updatedAt: z.string().regex(ISO_DATE_RE, "updatedAt harus format YYYY-MM-DD"),
  readingMinutes: z.number().int().min(1).max(15),
  keywords: z.array(z.string().min(2).max(48)).min(1).max(12),
  launchTopics: z.array(z.enum(REQUIRED_HELP_LAUNCH_TOPICS)).default([]),
  relatedSlugs: z.array(z.string().regex(HELP_SLUG_RE)).max(6).default([]),
  featured: z.boolean().default(false),
});

export type HelpArticleFrontmatter = z.infer<typeof HelpArticleFrontmatterSchema>;

export interface HelpArticleHeading {
  readonly level: 2 | 3;
  readonly id: string;
  readonly text: string;
}

export interface HelpArticleRecord {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly category: HelpCategoryId;
  readonly order: number;
  readonly updatedAt: string;
  readonly readingMinutes: number;
  readonly keywords: readonly string[];
  readonly launchTopics: readonly HelpLaunchTopic[];
  readonly relatedSlugs: readonly string[];
  readonly featured: boolean;
  readonly headings: readonly HelpArticleHeading[];
  readonly bodyMarkdown: string;
  readonly bodyHtml: string;
  readonly plainText: string;
}

export function escapeHelpHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\'", "'");
  }
  return trimmed;
}

function parseYamlInlineArray(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let current = "";
  let quoteChar: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] ?? "";
    if (quoteChar) {
      if (ch === quoteChar && inner[i - 1] !== "\\") {
        quoteChar = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      continue;
    }
    if (ch === ",") {
      const cleaned = unquoteYamlScalar(current);
      if (cleaned) items.push(cleaned);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = unquoteYamlScalar(current);
  if (tail) items.push(tail);
  return items;
}

function parseScalarValue(raw: string): string | number | boolean | string[] {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return parseYamlInlineArray(trimmed);
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return unquoteYamlScalar(trimmed);
}

/**
 * Splits `--- ... ---` YAML frontmatter from Markdown body.
 */
export function splitFrontmatter(rawMarkdown: string): {
  readonly data: Record<string, unknown>;
  readonly body: string;
} {
  const normalized = rawMarkdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("Help article missing valid YAML frontmatter delimited by ---");
  }

  const frontmatterBlock = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const data: Record<string, unknown> = {};
  const lines = frontmatterBlock.split("\n");
  let activeListKey: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (activeListKey && /^\s*-\s+/.test(line)) {
      const itemVal = unquoteYamlScalar(line.replace(/^\s*-\s+/, ""));
      const arr = data[activeListKey];
      if (Array.isArray(arr) && itemVal) {
        arr.push(itemVal);
      }
      continue;
    }

    activeListKey = null;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    if (rawValue === "") {
      data[key] = [];
      activeListKey = key;
    } else {
      data[key] = parseScalarValue(rawValue);
    }
  }

  return { data, body };
}

export function slugifyHeading(text: string): string {
  const base = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return base || "bagian";
}

function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) {
    return !trimmed.startsWith("//") && !trimmed.startsWith("/\\") && !trimmed.includes("\\");
  }
  if (trimmed.startsWith("#")) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Formats inline Markdown (`**bold**`, `` `code` ``, `[label](href)`) after escaping raw HTML.
 */
export function renderSafeInlineMarkdown(rawText: string): string {
  // First tokenize inline code spans so formatting inside code is untouched.
  const codePlaceholders: string[] = [];
  const withCodeTokens = rawText.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = codePlaceholders.push(`<code>${escapeHelpHtml(code)}</code>`) - 1;
    return `\uE000CODE_${idx}\uE001`;
  });

  // Tokenize safe Markdown links before escaping remaining text.
  const linkPlaceholders: string[] = [];
  const withLinkTokens = withCodeTokens.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (_m, label: string, href: string) => {
      const safeLabel = escapeHelpHtml(label);
      if (!isSafeLinkHref(href)) {
        const idx = linkPlaceholders.push(safeLabel) - 1;
        return `\uE000LINK_${idx}\uE001`;
      }
      const isExternal = href.startsWith("https://") || href.startsWith("http://");
      const relAttr = isExternal ? ' target="_blank" rel="noopener noreferrer"' : "";
      const idx =
        linkPlaceholders.push(
          `<a href="${escapeHelpHtml(href)}"${relAttr}>${safeLabel}</a>`,
        ) - 1;
      return `\uE000LINK_${idx}\uE001`;
    },
  );

  // Escape all remaining HTML special characters (blocks raw <script>, <img>, etc.)
  let escaped = escapeHelpHtml(withLinkTokens);

  // Bold `**text**`
  escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

  // Restore tokenized links & inline code
  escaped = escaped.replace(/\uE000LINK_(\d+)\uE001/g, (_m, idxStr: string) => {
    return linkPlaceholders[Number(idxStr)] ?? "";
  });
  escaped = escaped.replace(/\uE000CODE_(\d+)\uE001/g, (_m, idxStr: string) => {
    return codePlaceholders[Number(idxStr)] ?? "";
  });

  return escaped;
}

function parseTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = parseTableCells(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/**
 * Renders structured Markdown into sanitized HTML and extracts `h2`/`h3` headings for TOC.
 */
export function renderSafeHelpMarkdown(bodyMarkdown: string): {
  readonly html: string;
  readonly headings: readonly HelpArticleHeading[];
  readonly plainText: string;
} {
  const lines = bodyMarkdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  const headings: HelpArticleHeading[] = [];
  const usedHeadingIds = new Map<string, number>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Headings (`##` and `###`)
    const headingMatch = trimmed.match(/^(#{2,3})\s+(.+)$/);
    if (headingMatch) {
      const level = (headingMatch[1]?.length === 3 ? 3 : 2) as 2 | 3;
      const rawTitle = (headingMatch[2] ?? "").trim();
      const baseId = slugifyHeading(rawTitle);
      const seenCount = usedHeadingIds.get(baseId) ?? 0;
      usedHeadingIds.set(baseId, seenCount + 1);
      const id = seenCount === 0 ? baseId : `${baseId}-${seenCount + 1}`;
      headings.push({ level, id, text: rawTitle });
      blocks.push(`<h${level} id="${escapeHelpHtml(id)}">${renderSafeInlineMarkdown(rawTitle)}</h${level}>`);
      i += 1;
      continue;
    }

    // Callout / blockquote (`> ...`)
    if (trimmed.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("> ")) {
        quoteLines.push((lines[i] ?? "").trim().slice(2));
        i += 1;
      }
      blocks.push(
        `<blockquote class="bh-callout"><p>${renderSafeInlineMarkdown(quoteLines.join(" "))}</p></blockquote>`,
      );
      continue;
    }

    // Pipe table (`| A | B |` followed by `| --- | --- |`)
    if (
      trimmed.startsWith("|") &&
      i + 1 < lines.length &&
      isTableSeparatorLine(lines[i + 1] ?? "")
    ) {
      const headerCells = parseTableCells(trimmed);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        bodyRows.push(parseTableCells(lines[i] ?? ""));
        i += 1;
      }
      const headHtml = headerCells
        .map((cell) => `<th scope="col">${renderSafeInlineMarkdown(cell)}</th>`)
        .join("");
      const rowsHtml = bodyRows
        .map(
          (row) =>
            `<tr>${headerCells
              .map((_h, colIdx) => `<td>${renderSafeInlineMarkdown(row[colIdx] ?? "")}</td>`)
              .join("")}</tr>`,
        )
        .join("");
      blocks.push(
        `<div class="mk-table-wrap"><table class="mk-table"><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`,
      );
      continue;
    }

    // Ordered list (`1. ...`)
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test((lines[i] ?? "").trim())) {
        const content = (lines[i] ?? "").trim().replace(/^\d+\.\s+/, "");
        items.push(`<li>${renderSafeInlineMarkdown(content)}</li>`);
        i += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Unordered list (`- ...` or `* ...`)
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test((lines[i] ?? "").trim())) {
        const content = (lines[i] ?? "").trim().replace(/^[-*]\s+/, "");
        items.push(`<li>${renderSafeInlineMarkdown(content)}</li>`);
        i += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Paragraph (join consecutive plain lines until blank or block start)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = (lines[i] ?? "").trim();
      if (
        !cur ||
        /^#{2,3}\s+/.test(cur) ||
        cur.startsWith("> ") ||
        cur.startsWith("|") ||
        /^\d+\.\s+/.test(cur) ||
        /^[-*]\s+/.test(cur)
      ) {
        break;
      }
      paraLines.push(cur);
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push(`<p>${renderSafeInlineMarkdown(paraLines.join(" "))}</p>`);
    }
  }

  const html = blocks.join("\n");
  const plainText = bodyMarkdown
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
    .replace(/[#>*`|_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { html, headings, plainText };
}

export function parseHelpArticleMarkdown(
  rawMarkdown: string,
  expectedSlug?: string,
): HelpArticleRecord {
  const { data, body } = splitFrontmatter(rawMarkdown);
  const parsed = HelpArticleFrontmatterSchema.parse(data);

  if (expectedSlug && parsed.slug !== expectedSlug) {
    throw new Error(
      `Help article slug mismatch: frontmatter "${parsed.slug}" !== filename "${expectedSlug}"`,
    );
  }

  if (body.length < 80) {
    throw new Error(`Help article "${parsed.slug}" body is too short (${body.length} chars)`);
  }

  const rendered = renderSafeHelpMarkdown(body);
  return {
    slug: parsed.slug,
    title: parsed.title,
    summary: parsed.summary,
    category: parsed.category,
    order: parsed.order,
    updatedAt: parsed.updatedAt,
    readingMinutes: parsed.readingMinutes,
    keywords: parsed.keywords,
    launchTopics: parsed.launchTopics,
    relatedSlugs: parsed.relatedSlugs,
    featured: parsed.featured,
    headings: rendered.headings,
    bodyMarkdown: body,
    bodyHtml: rendered.html,
    plainText: rendered.plainText,
  };
}

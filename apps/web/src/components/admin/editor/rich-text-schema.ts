import {
  sanitizeRichTextDoc,
  sanitizeRichTextLinkHref,
  type RestrictedRichTextDoc,
  type RestrictedRichTextNode,
} from "@punyasitus/core/content/index";
import {
  HttpsUrlSchema,
  RestrictedRichTextDocSchema,
  RestrictedRichTextNodeSchema,
} from "@punyasitus/core/schemas";

/**
 * Restricted TipTap MIT Core Rich-Text Schema & Deterministic Bidirectional Converter
 * (TASK-033, DEC-035 C13, REQ-009, REQ-036, REQ-037, PLAN §7.3).
 *
 * Strictly MIT-licensed TipTap core packages only — zero Pro/commercial packages.
 * Locks editor state to `RestrictedRichTextDocSchema` (`schemaVersion: 1`).
 *
 * Schema-level formatting note (`packages/core/src/schemas/cms.ts`):
 * `RestrictedRichTextNodeSchema` stores one `marks` array and optional `href` per flat block.
 * Accordingly, inline marks (`bold`, `italic`, `underline`, `code`) are emitted on a block only
 * when every non-whitespace text run in that block shares the mark (preventing a single bolded
 * word from accidentally bolding the entire paragraph on reload). Line breaks (`hardBreak`) and
 * multi-paragraph `blockquote` / `listItem` content are preserved via `\n` and reconstructed as
 * TipTap `hardBreak` nodes. Literal `|` characters in table cells are escaped (`\|`) so table
 * column boundaries survive round-trip cleanly.
 */

export const MAX_SEQUENTIAL_MEDIA_ID = 2_147_483_647 as const;

export const RICH_TEXT_EDITOR_METADATA = {
  library: "@tiptap/react",
  coreLibrary: "@tiptap/core",
  packages: [
    "@tiptap/core",
    "@tiptap/react",
    "@tiptap/pm",
    "@tiptap/starter-kit",
    "@tiptap/extension-link",
    "@tiptap/extension-image",
    "@tiptap/extension-table",
  ] as const,
  license: "MIT",
  proPackagesUsed: false,
  schemaVersion: 1 as const,
  blockMarkSemantics: "uniform-block-marks" as const,
  allowedNodes: [
    "doc",
    "paragraph",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "blockquote",
    "table",
    "tableRow",
    "tableCell",
    "image",
    "text",
    "hardBreak",
  ] as const,
  allowedHeadingLevels: [2, 3, 4] as const,
  allowedMarks: ["bold", "italic", "underline", "code", "link"] as const,
} as const;

export type AllowedRichTextMark = (typeof RICH_TEXT_EDITOR_METADATA.allowedMarks)[number];

export interface TipTapMarkJson {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TipTapNodeJson {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  marks?: TipTapMarkJson[];
  content?: TipTapNodeJson[];
}

export const EMPTY_RESTRICTED_RICH_TEXT_DOC: RestrictedRichTextDoc = {
  schemaVersion: 1,
  blocks: [],
};

const MAX_BLOCKS = 500;
const MAX_BLOCK_TEXT = 10_000;
const ALLOWED_MARK_SET: ReadonlySet<string> = new Set(RICH_TEXT_EDITOR_METADATA.allowedMarks);
const DISALLOWED_NODE_TYPES: ReadonlySet<string> = new Set([
  "script",
  "iframe",
  "style",
  "form",
  "input",
  "button",
  "object",
  "embed",
  "svg",
  "math",
  "rawHtml",
  "html",
  "video",
  "audio",
  "codeBlock",
]);

/**
 * Validates a rich-text link URL strictly to public `https://` URLs
 * matching `RestrictedRichTextNodeSchema.href` (`HttpsUrlSchema`).
 * Rejects `javascript:`, `data:`, `vbscript:`, `http://`, localhost/private IPs, etc.
 */
export function sanitizeEditorLinkUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string") return null;
  const cleaned = sanitizeRichTextLinkHref(rawUrl);
  if (!cleaned) return null;
  const parsed = HttpsUrlSchema.safeParse(cleaned);
  return parsed.success ? parsed.data : null;
}

/**
 * Extracts a positive sequential tenant media ID (`1..2_147_483_647`) from an image node's attrs
 * (`mediaId`, `data-media-id`, or `/media/<id>` src). Rejects external/data/javascript URLs
 * and out-of-range integers.
 */
export function extractTenantMediaIdFromAttrs(
  attrs: Readonly<Record<string, unknown>> | undefined,
): number | null {
  if (!attrs) return null;
  const parseValidId = (val: unknown): number | null => {
    if (typeof val === "number") {
      return Number.isSafeInteger(val) && val >= 1 && val <= MAX_SEQUENTIAL_MEDIA_ID ? val : null;
    }
    if (typeof val === "string" && /^[1-9]\d{0,9}$/.test(val.trim())) {
      const num = Number(val.trim());
      return Number.isSafeInteger(num) && num >= 1 && num <= MAX_SEQUENTIAL_MEDIA_ID ? num : null;
    }
    return null;
  };

  const direct = parseValidId(attrs.mediaId ?? attrs["data-media-id"]);
  if (direct !== null) return direct;

  if (typeof attrs.src === "string") {
    const m = /^\/media\/([1-9]\d{0,9})$/.exec(attrs.src.trim());
    if (m) {
      return parseValidId(m[1]);
    }
  }
  return null;
}

/**
 * Escapes literal `\` and `|` inside a single table cell so ` | ` remains an unambiguous
 * column separator in flat `tableRow` text storage.
 */
export function escapeTableCellText(cell: string): string {
  return cell.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * Splits serialized `tableRow` text back into unescaped cells, preserving literal `|` inside cells.
 */
export function splitEscapedTableRowText(rowText: string): string[] {
  const cells: string[] = [];
  let current = "";
  let i = 0;
  while (i < rowText.length) {
    const ch = rowText[i]!;
    if (ch === "\\" && i + 1 < rowText.length) {
      const next = rowText[i + 1]!;
      if (next === "|" || next === "\\") {
        current += next;
        i += 2;
        continue;
      }
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  cells.push(current.trim());
  return cells;
}

interface ExtractedInline {
  readonly text: string;
  readonly marks: AllowedRichTextMark[];
  readonly href?: string;
}

function collectInlineContent(nodes: readonly TipTapNodeJson[] | undefined): ExtractedInline {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { text: "", marks: [] };
  }

  const textParts: string[] = [];
  const uniformMarksState: { current: Set<AllowedRichTextMark> | null } = { current: null };
  let firstSafeHref: string | undefined;

  const visit = (list: readonly TipTapNodeJson[]) => {
    for (let idx = 0; idx < list.length; idx += 1) {
      const child = list[idx];
      if (!child || typeof child !== "object") continue;
      if (DISALLOWED_NODE_TYPES.has(child.type)) continue;

      if (child.type === "hardBreak") {
        textParts.push("\n");
        continue;
      }

      if (child.type === "text" && typeof child.text === "string") {
        textParts.push(child.text);
        // Only intersect marks across non-whitespace runs so spaces don't strip whole-block formatting
        if (child.text.trim().length > 0) {
          const runMarks = new Set<AllowedRichTextMark>();
          if (Array.isArray(child.marks)) {
            for (const mark of child.marks) {
              if (!mark || typeof mark.type !== "string") continue;
              if (!ALLOWED_MARK_SET.has(mark.type)) continue;
              if (mark.type === "link") {
                const safeHref = sanitizeEditorLinkUrl(mark.attrs?.href);
                if (safeHref) {
                  runMarks.add("link");
                  if (!firstSafeHref) firstSafeHref = safeHref;
                }
              } else {
                runMarks.add(mark.type as AllowedRichTextMark);
              }
            }
          }
          if (uniformMarksState.current === null) {
            uniformMarksState.current = runMarks;
          } else {
            for (const m of Array.from(uniformMarksState.current)) {
              if (!runMarks.has(m)) {
                uniformMarksState.current.delete(m);
              }
            }
          }
        }
        continue;
      }

      // Join sibling block children inside blockquote/listItem with "\n" instead of gluing them together
      if (
        (child.type === "paragraph" || child.type === "heading" || child.type === "blockquote") &&
        textParts.length > 0 &&
        !textParts[textParts.length - 1]!.endsWith("\n")
      ) {
        textParts.push("\n");
      }

      if (Array.isArray(child.content)) {
        visit(child.content);
      }
    }
  };

  visit(nodes);

  const rawText = textParts.join("").slice(0, MAX_BLOCK_TEXT);
  const marks: AllowedRichTextMark[] = uniformMarksState.current
    ? Array.from(uniformMarksState.current).slice(0, 5)
    : [];
  const keepHref = marks.includes("link") ? firstSafeHref : undefined;
  return {
    text: rawText,
    marks,
    ...(keepHref ? { href: keepHref } : {}),
  };
}

function makeBlockNode(
  type: RestrictedRichTextNode["type"],
  inline: ExtractedInline,
  extra?: Partial<RestrictedRichTextNode>,
): RestrictedRichTextNode {
  return {
    type,
    ...(inline.text ? { text: inline.text } : {}),
    ...(inline.marks.length > 0 ? { marks: inline.marks } : {}),
    ...(inline.href ? { href: inline.href } : {}),
    ...extra,
  };
}

/**
 * Deterministically converts TipTap editor JSON into a schema-validated
 * `RestrictedRichTextDoc` (`schemaVersion: 1`). Never throws inside editor `onUpdate`.
 *
 * Strips disallowed nodes (`script`, `iframe`, `style`, `form`, `codeBlock`, etc.),
 * clamps disallowed heading levels (only h2-h4 allowed), drops unsafe link URLs
 * (`javascript:`, `data:`, `http://`), and drops images without a valid tenant `mediaId`.
 */
export function tiptapJsonToRestrictedDoc(input: unknown): RestrictedRichTextDoc {
  if (!input || typeof input !== "object") {
    return { schemaVersion: 1, blocks: [] };
  }

  const root = input as TipTapNodeJson;
  const topNodes = Array.isArray(root.content) ? root.content : [];
  const blocks: RestrictedRichTextNode[] = [];

  const pushBlock = (node: RestrictedRichTextNode) => {
    if (blocks.length >= MAX_BLOCKS) return;
    const valid = RestrictedRichTextNodeSchema.safeParse(node);
    if (valid.success) {
      blocks.push(valid.data);
    }
  };

  const walkBlock = (node: TipTapNodeJson) => {
    if (!node || typeof node !== "object" || blocks.length >= MAX_BLOCKS) return;
    if (DISALLOWED_NODE_TYPES.has(node.type)) return;

    switch (node.type) {
      case "heading": {
        const rawLevel = Number(node.attrs?.level);
        const level: 2 | 3 | 4 =
          rawLevel === 2 || rawLevel === 3 || rawLevel === 4
            ? rawLevel
            : rawLevel < 2
              ? 2
              : 4;
        const inline = collectInlineContent(node.content);
        if (inline.text.trim().length > 0) {
          pushBlock(makeBlockNode("heading", inline, { level }));
        }
        break;
      }

      case "paragraph": {
        const children = Array.isArray(node.content) ? node.content : [];
        const hasOnlyImages =
          children.length > 0 && children.every((c) => c && c.type === "image");
        if (hasOnlyImages) {
          for (const img of children) walkBlock(img);
          break;
        }
        const inline = collectInlineContent(children);
        if (inline.text.trim().length > 0) {
          pushBlock(makeBlockNode("paragraph", inline));
        }
        for (const child of children) {
          if (child?.type === "image") walkBlock(child);
        }
        break;
      }

      case "blockquote": {
        const inline = collectInlineContent(node.content);
        if (inline.text.trim().length > 0) {
          pushBlock(makeBlockNode("blockquote", inline));
        }
        break;
      }

      case "bulletList": {
        const items = Array.isArray(node.content) ? node.content : [];
        for (const item of items) {
          if (!item || item.type !== "listItem") continue;
          const inline = collectInlineContent(item.content);
          if (inline.text.trim().length > 0) {
            pushBlock(makeBlockNode("bulletList", inline));
          }
        }
        break;
      }

      case "orderedList": {
        const items = Array.isArray(node.content) ? node.content : [];
        for (const item of items) {
          if (!item || item.type !== "listItem") continue;
          const inline = collectInlineContent(item.content);
          if (inline.text.trim().length > 0) {
            pushBlock(makeBlockNode("orderedList", inline));
          }
        }
        break;
      }

      case "listItem": {
        const inline = collectInlineContent(node.content);
        if (inline.text.trim().length > 0) {
          pushBlock(makeBlockNode("listItem", inline));
        }
        break;
      }

      case "table": {
        const rows = Array.isArray(node.content) ? node.content : [];
        for (const row of rows) {
          if (!row || row.type !== "tableRow") continue;
          const cells: readonly TipTapNodeJson[] = Array.isArray(row.content) ? row.content : [];
          const cellTexts = cells
            .filter(
              (c: TipTapNodeJson) =>
                Boolean(c) && (c.type === "tableCell" || c.type === "tableHeader"),
            )
            .map((c: TipTapNodeJson) => escapeTableCellText(collectInlineContent(c.content).text.trim()));
          if (cellTexts.some((t: string) => t.length > 0)) {
            pushBlock({
              type: "tableRow",
              text: cellTexts.join(" | ").slice(0, MAX_BLOCK_TEXT),
            });
          }
        }
        break;
      }

      case "image": {
        const mediaId = extractTenantMediaIdFromAttrs(node.attrs);
        if (mediaId !== null) {
          const alt =
            typeof node.attrs?.alt === "string"
              ? node.attrs.alt.trim().slice(0, 250)
              : "";
          pushBlock({
            type: "image",
            mediaId,
            ...(alt ? { text: alt } : {}),
          });
        }
        break;
      }

      case "hardBreak": {
        pushBlock({ type: "hardBreak" });
        break;
      }

      default:
        break;
    }
  };

  for (const child of topNodes) {
    walkBlock(child);
  }

  const sanitized = sanitizeRichTextDoc({ schemaVersion: 1, blocks });
  const parsed = RestrictedRichTextDocSchema.safeParse(sanitized);
  if (parsed.success) {
    return parsed.data;
  }
  const safeBlocks: RestrictedRichTextNode[] = [];
  for (const b of sanitized.blocks) {
    const check = RestrictedRichTextNodeSchema.safeParse(b);
    if (check.success && safeBlocks.length < MAX_BLOCKS) {
      safeBlocks.push(check.data);
    }
  }
  return { schemaVersion: 1, blocks: safeBlocks };
}

function buildTipTapMarks(block: RestrictedRichTextNode): TipTapMarkJson[] {
  const marks: TipTapMarkJson[] = [];
  const rawMarks = block.marks ?? [];
  for (const m of rawMarks) {
    if (m === "link") {
      const safeHref = sanitizeEditorLinkUrl(block.href);
      if (safeHref) {
        marks.push({ type: "link", attrs: { href: safeHref, rel: "noopener noreferrer" } });
      }
    } else if (ALLOWED_MARK_SET.has(m)) {
      marks.push({ type: m });
    }
  }
  if (!rawMarks.includes("link") && block.href) {
    const safeHref = sanitizeEditorLinkUrl(block.href);
    if (safeHref) {
      marks.push({ type: "link", attrs: { href: safeHref, rel: "noopener noreferrer" } });
    }
  }
  return marks;
}

function buildInlineTextNodes(block: RestrictedRichTextNode): TipTapNodeJson[] {
  const text = block.text ?? "";
  if (!text) return [];
  const marks = buildTipTapMarks(block);
  const lines = text.split("\n");
  const nodes: TipTapNodeJson[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.length > 0) {
      nodes.push({
        type: "text",
        text: line,
        ...(marks.length > 0 ? { marks: marks.map((m) => ({ ...m })) } : {}),
      });
    }
    if (i < lines.length - 1) {
      nodes.push({ type: "hardBreak" });
    }
  }
  return nodes;
}

/**
 * Deterministically converts a `RestrictedRichTextDoc` (`schemaVersion: 1`)
 * into TipTap ProseMirror JSON suitable for hydrating the editor.
 */
export function restrictedDocToTiptapJson(
  doc: RestrictedRichTextDoc | null | undefined,
): TipTapNodeJson {
  if (!doc || !Array.isArray(doc.blocks) || doc.blocks.length === 0) {
    return {
      type: "doc",
      content: [{ type: "paragraph" }],
    };
  }

  const content: TipTapNodeJson[] = [];
  let i = 0;

  while (i < doc.blocks.length) {
    const block = doc.blocks[i]!;

    if (block.type === "bulletList" || block.type === "listItem") {
      const items: TipTapNodeJson[] = [];
      while (
        i < doc.blocks.length &&
        (doc.blocks[i]!.type === "bulletList" || doc.blocks[i]!.type === "listItem")
      ) {
        const cur = doc.blocks[i]!;
        const inline = buildInlineTextNodes(cur);
        items.push({
          type: "listItem",
          content: [{ type: "paragraph", ...(inline.length > 0 ? { content: inline } : {}) }],
        });
        i += 1;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }

    if (block.type === "orderedList") {
      const items: TipTapNodeJson[] = [];
      while (i < doc.blocks.length && doc.blocks[i]!.type === "orderedList") {
        const cur = doc.blocks[i]!;
        const inline = buildInlineTextNodes(cur);
        items.push({
          type: "listItem",
          content: [{ type: "paragraph", ...(inline.length > 0 ? { content: inline } : {}) }],
        });
        i += 1;
      }
      content.push({ type: "orderedList", content: items });
      continue;
    }

    if (
      block.type === "table" ||
      block.type === "tableRow" ||
      block.type === "tableCell"
    ) {
      const rows: TipTapNodeJson[] = [];
      while (
        i < doc.blocks.length &&
        (doc.blocks[i]!.type === "table" ||
          doc.blocks[i]!.type === "tableRow" ||
          doc.blocks[i]!.type === "tableCell")
      ) {
        const cur = doc.blocks[i]!;
        const rawCells = splitEscapedTableRowText(cur.text ?? "");
        const cellNodes: TipTapNodeJson[] = (rawCells.length > 0 ? rawCells : [""]).map(
          (cellText) => ({
            type: "tableCell",
            content: [
              {
                type: "paragraph",
                ...(cellText ? { content: [{ type: "text", text: cellText }] } : {}),
              },
            ],
          }),
        );
        rows.push({ type: "tableRow", content: cellNodes });
        i += 1;
      }
      content.push({ type: "table", content: rows });
      continue;
    }

    switch (block.type) {
      case "heading": {
        const level = block.level === 2 || block.level === 3 || block.level === 4 ? block.level : 2;
        content.push({
          type: "heading",
          attrs: { level },
          content: buildInlineTextNodes(block),
        });
        break;
      }
      case "blockquote": {
        const inline = buildInlineTextNodes(block);
        content.push({
          type: "blockquote",
          content: [{ type: "paragraph", ...(inline.length > 0 ? { content: inline } : {}) }],
        });
        break;
      }
      case "image": {
        if (
          typeof block.mediaId === "number" &&
          block.mediaId >= 1 &&
          block.mediaId <= MAX_SEQUENTIAL_MEDIA_ID
        ) {
          content.push({
            type: "image",
            attrs: {
              src: `/media/${block.mediaId}`,
              alt: block.text ?? "",
              mediaId: block.mediaId,
            },
          });
        }
        break;
      }
      case "hardBreak": {
        content.push({ type: "paragraph", content: [{ type: "hardBreak" }] });
        break;
      }
      case "paragraph":
      case "text":
      case "doc":
      default: {
        const inline = buildInlineTextNodes(block);
        content.push({
          type: "paragraph",
          ...(inline.length > 0 ? { content: inline } : {}),
        });
        break;
      }
    }

    i += 1;
  }

  return {
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  };
}

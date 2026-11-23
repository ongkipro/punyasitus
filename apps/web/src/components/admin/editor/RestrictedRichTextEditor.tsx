import { useCallback, useEffect, useRef, useState } from "react";
import {
  calculateReadingTimeMinutes,
  countWordsFromRichText,
  type RestrictedRichTextDoc,
} from "@punyasitus/core/content/index";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BoldIcon,
  CodeIcon,
  Heading2Icon,
  Heading3Icon,
  Heading4Icon,
  ImageIcon,
  ItalicIcon,
  Link2Icon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  Redo2Icon,
  TableIcon,
  UnderlineIcon,
  Undo2Icon,
  UnlinkIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MAX_SEQUENTIAL_MEDIA_ID,
  RICH_TEXT_EDITOR_METADATA,
  restrictedDocToTiptapJson,
  sanitizeEditorLinkUrl,
  tiptapJsonToRestrictedDoc,
} from "./rich-text-schema";

const SAFE_TENANT_EDITOR_IMG_SRC_RE =
  /^\/(?:media\/[1-9]\d{0,9}|t\/[A-Za-z0-9_-]+\/media\/[A-Za-z0-9._/-]+)$/;

function parseSafeSequentialMediaId(raw: string | null): number | null {
  if (!raw || !/^[1-9]\d{0,9}$/.test(raw.trim())) return null;
  const num = Number(raw.trim());
  return Number.isSafeInteger(num) && num >= 1 && num <= MAX_SEQUENTIAL_MEDIA_ID ? num : null;
}

const TenantMediaImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const rawSrc = (element.getAttribute("src") ?? "").trim();
          if (SAFE_TENANT_EDITOR_IMG_SRC_RE.test(rawSrc)) {
            return rawSrc;
          }
          const mediaId = parseSafeSequentialMediaId(element.getAttribute("data-media-id"));
          return mediaId !== null ? `/media/${mediaId}` : null;
        },
      },
      mediaId: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const direct = parseSafeSequentialMediaId(element.getAttribute("data-media-id"));
          if (direct !== null) return direct;
          const src = (element.getAttribute("src") ?? "").trim();
          const m = /^\/media\/([1-9]\d{0,9})$/.exec(src);
          return m ? parseSafeSequentialMediaId(m[1] ?? null) : null;
        },
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes.mediaId) return {};
          return { "data-media-id": String(attributes.mediaId) };
        },
      },
    };
  },
});

export interface RestrictedRichTextEditorProps {
  readonly id?: string;
  readonly label?: string;
  readonly value: RestrictedRichTextDoc;
  readonly onChange: (next: RestrictedRichTextDoc) => void;
  readonly readOnly?: boolean;
  readonly placeholder?: string;
  readonly onRequestMediaPicker?: (
    onPick: (media: { readonly id: number; readonly alt: string; readonly publicUrl?: string | null }) => void,
  ) => void;
  readonly testId?: string;
}

export function RestrictedRichTextEditor({
  id = "rich-text-editor",
  label = "Konten artikel",
  value,
  onChange,
  readOnly = false,
  placeholder = "Mulai menulis konten di sini...",
  onRequestMediaPicker,
  testId = "restricted-richtext-editor",
}: RestrictedRichTextEditorProps) {
  const [linkPanelOpen, setLinkPanelOpen] = useState(false);
  const [linkUrlInput, setLinkUrlInput] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const lastEmittedRef = useRef<string>(JSON.stringify(value));

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        link: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: false,
        defaultProtocol: "https",
        HTMLAttributes: {
          rel: "noopener noreferrer",
          target: "_blank",
        },
        isAllowedUri: (url) => sanitizeEditorLinkUrl(url) !== null,
      }),
      TenantMediaImage.configure({
        allowBase64: false,
        HTMLAttributes: {
          class: "my-3 max-h-80 rounded-md border border-border object-contain",
        },
      }),
      Table.configure({
        resizable: false,
        HTMLAttributes: {
          class: "my-3 w-full border-collapse border border-border text-sm",
        },
      }),
      TableRow,
      TableHeader.configure({
        HTMLAttributes: {
          class: "border border-border bg-muted px-2.5 py-1.5 text-left font-semibold",
        },
      }),
      TableCell.configure({
        HTMLAttributes: {
          class: "border border-border px-2.5 py-1.5 align-top",
        },
      }),
    ],
    content: restrictedDocToTiptapJson(value),
    editorProps: {
      attributes: {
        id,
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        "data-testid": `${testId}-content`,
        class:
          "min-h-[220px] px-3.5 py-3 text-base md:text-sm leading-relaxed text-foreground focus:outline-none [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:mt-2.5 [&_h4]:mb-1 [&_h4]:text-sm [&_h4]:font-semibold [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-primary [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs",
      },
    },
    onUpdate: ({ editor: activeEditor }) => {
      const nextDoc = tiptapJsonToRestrictedDoc(activeEditor.getJSON());
      const serialized = JSON.stringify(nextDoc);
      lastEmittedRef.current = serialized;
      onChange(nextDoc);
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  // Sync external reloads (e.g. 409 stale-write recovery reload) into TipTap cleanly
  useEffect(() => {
    if (!editor) return;
    const incoming = JSON.stringify(value);
    if (incoming !== lastEmittedRef.current) {
      lastEmittedRef.current = incoming;
      editor.commands.setContent(restrictedDocToTiptapJson(value), { emitUpdate: false });
    }
  }, [editor, value]);

  const handleOpenLinkPanel = useCallback(() => {
    if (!editor || readOnly) return;
    const existingHref = (editor.getAttributes("link").href as string | undefined) ?? "";
    setLinkUrlInput(existingHref);
    setLinkError(null);
    setLinkPanelOpen((prev) => !prev);
  }, [editor, readOnly]);

  const handleApplyLink = useCallback(() => {
    if (!editor || readOnly) return;
    const trimmed = linkUrlInput.trim();
    if (!trimmed) {
      editor.chain().focus().unsetLink().run();
      setLinkPanelOpen(false);
      setLinkError(null);
      return;
    }
    const safeUrl = sanitizeEditorLinkUrl(trimmed);
    if (!safeUrl) {
      setLinkError(
        "Tautan harus menggunakan URL publik https:// yang valid (tautan javascript:, data:, atau http:// ditolak).",
      );
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: safeUrl }).run();
    setLinkPanelOpen(false);
    setLinkError(null);
  }, [editor, linkUrlInput, readOnly]);

  const handlePickImage = useCallback(() => {
    if (!editor || readOnly || !onRequestMediaPicker) return;
    onRequestMediaPicker((media) => {
      const src = media.publicUrl || `/media/${media.id}`;
      editor
        .chain()
        .focus()
        .insertContent({
          type: "image",
          attrs: {
            src,
            alt: media.alt || "",
            mediaId: media.id,
          },
        })
        .run();
    });
  }, [editor, onRequestMediaPicker, readOnly]);

  const wordCount = countWordsFromRichText(value);
  const readingMinutes = wordCount > 0 ? calculateReadingTimeMinutes(value) : 0;

  return (
    <div
      data-testid={testId}
      data-editor-library={RICH_TEXT_EDITOR_METADATA.library}
      data-editor-license={RICH_TEXT_EDITOR_METADATA.license}
      data-editor-schema-version={String(RICH_TEXT_EDITOR_METADATA.schemaVersion)}
      className="overflow-hidden rounded-md border border-border bg-card"
    >
      <div
        role="toolbar"
        aria-label={`Toolbar ${label}`}
        className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/40 p-1.5"
      >
        <ToolbarBtn
          label="Judul H2"
          active={Boolean(editor?.isActive("heading", { level: 2 }))}
          disabled={readOnly || !editor}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          testId={`${testId}-btn-h2`}
        >
          <Heading2Icon className="size-4" aria-hidden="true" />
        </ToolbarBtn>
        <ToolbarBtn
          label="Judul H3"
          active={Boolean(editor?.isActive("heading", { level: 3 }))}
          disabled={readOnly || !editor}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
          testId={`${testId}-btn-h3`}
        >
          <Heading3Icon className="size-4" aria-hidden="true" />
        </ToolbarBtn>
        <ToolbarBtn
          label="Judul H4"
          active={Boolean(editor?.isActive("heading", { level: 4 }))}
          disabled={readOnly || !editor}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 4 }).run()}
          testId={`${testId}-btn-h4`}
        >
          <Heading4Icon className="size-4" aria-hidden="true" />
        </ToolbarBtn>

        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />

        <ToolbarBtn
          label="Tebal"
          active={Boolean(editor?.isActive("bold"))}
          disabled={readOnly || !editor}
          onClick={() => editor?.chain().focus().toggleBold().run()}
          testId={`${testId}-btn-bold`}
        >
          <BoldIcon className="size-4" aria-hidden="true" />
        </ToolbarBtn>
        <ToolbarBtn
          label="Miring"
          active={Boolean(editor?.isActive("italic"))}
          disabled={readOnly || !editor}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          testId={`${testId}-btn-italic`}
        >
          <ItalicIcon className="size-4" aria-hidden="true" />
        </ToolbarBtn>
        <ToolbarBtn
          label="Garis bawah"
          active={Boolean(editor?.isActive("underline"))}
          disabled={readOnly || !editor}
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
          testId={`${testId}-btn-underline`}
        >
          <UnderlineIcon className="size-4" aria-hidden="true" />
        </ToolbarBtn>
        <ToolbarBtn
          label="Kode inline"
          active={Boolean(editor?.isActive("code"))}
          disabled={readOnly || !editor}
          onClick={() => editor?.chain().focus().toggleCode().run()}
          testId={`${testId}-btn-code`}
        >
          <CodeIcon className="size-4" aria-hidden="true" />
        </ToolbarBtn>

        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />

        <ToolbarBtn
          label="Daftar poin"
          active={Boolean(editor?.isActive("bulletList"))}
          disabled={readOnly || !editor}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          testId={`${testId}-btn-ul`}
        >
          <ListIcon className="size-4" aria-hidden="true" />
        </ToolbarBtn>
        <ToolbarBtn
          label="Daftar bernomor"
          active={Boolean(editor?.isActive("orderedList"))}
          disabled={readOnly || !editor}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          testId={`${testId}-btn-ol`}
        >
          <ListOrderedIcon className="size-4" aria-hidden="true" />
        </ToolbarBtn>
        <ToolbarBtn
          label="Kutipan"
          active={Boolean(editor?.isActive("blockquote"))}
          disabled={readOnly || !editor}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          testId={`${testId}-btn-quote`}
        >
          <QuoteIcon className="size-4" aria-hidden="true" />
        </ToolbarBtn>
        <ToolbarBtn
          label="Sisipkan tabel 2x2"
          active={Boolean(editor?.isActive("table"))}
          disabled={readOnly || !editor}
          onClick={() =>
            editor
              ?.chain()
              .focus()
              .insertTable({ rows: 2, cols: 2, withHeaderRow: false })
              .run()
          }
          testId={`${testId}-btn-table`}
        >
          <TableIcon className="size-4" aria-hidden="true" />
        </ToolbarBtn>

        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />

        <ToolbarBtn
          label="Tautan HTTPS"
          active={Boolean(editor?.isActive("link")) || linkPanelOpen}
          disabled={readOnly || !editor}
          onClick={handleOpenLinkPanel}
          testId={`${testId}-btn-link`}
        >
          <Link2Icon className="size-4" aria-hidden="true" />
        </ToolbarBtn>
        {editor?.isActive("link") && !readOnly && (
          <ToolbarBtn
            label="Hapus tautan"
            active={false}
            disabled={readOnly}
            onClick={() => editor.chain().focus().unsetLink().run()}
            testId={`${testId}-btn-unlink`}
          >
            <UnlinkIcon className="size-4" aria-hidden="true" />
          </ToolbarBtn>
        )}
        {onRequestMediaPicker && (
          <ToolbarBtn
            label="Sisipkan gambar dari Media"
            active={false}
            disabled={readOnly || !editor}
            onClick={handlePickImage}
            testId={`${testId}-btn-image`}
          >
            <ImageIcon className="size-4" aria-hidden="true" />
          </ToolbarBtn>
        )}

        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />

        <ToolbarBtn
          label="Urungkan"
          active={false}
          disabled={readOnly || !editor?.can().undo()}
          onClick={() => editor?.chain().focus().undo().run()}
          testId={`${testId}-btn-undo`}
        >
          <Undo2Icon className="size-4" aria-hidden="true" />
        </ToolbarBtn>
        <ToolbarBtn
          label="Ulangi"
          active={false}
          disabled={readOnly || !editor?.can().redo()}
          onClick={() => editor?.chain().focus().redo().run()}
          testId={`${testId}-btn-redo`}
        >
          <Redo2Icon className="size-4" aria-hidden="true" />
        </ToolbarBtn>
      </div>

      {linkPanelOpen && !readOnly && (
        <div
          data-testid={`${testId}-link-panel`}
          className="flex flex-col gap-2 border-b border-border bg-muted/20 p-2.5 sm:flex-row sm:items-end"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <label
              htmlFor={`${id}-link-url`}
              className="block text-xs font-medium text-foreground"
            >
              URL Tautan (hanya https://)
            </label>
            <Input
              id={`${id}-link-url`}
              type="url"
              value={linkUrlInput}
              onChange={(e) => {
                setLinkUrlInput(e.target.value);
                if (linkError) setLinkError(null);
              }}
              placeholder="https://contoh.co.id/informasi"
              className="min-h-11 text-base md:min-h-9 md:text-sm"
              data-testid={`${testId}-link-input`}
            />
            {linkError && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {linkError}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleApplyLink}
              className="min-h-11 md:min-h-9"
              data-testid={`${testId}-link-apply`}
            >
              Terapkan
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setLinkPanelOpen(false);
                setLinkError(null);
              }}
              className="min-h-11 md:min-h-9"
            >
              Batal
            </Button>
          </div>
        </div>
      )}

      <div className="relative bg-card">
        {wordCount === 0 && value.blocks.length === 0 && (
          <p
            aria-hidden="true"
            className="pointer-events-none absolute top-3 left-3.5 text-sm text-muted-foreground/70"
          >
            {placeholder}
          </p>
        )}
        <EditorContent editor={editor} />
      </div>

      <div
        data-testid={`${testId}-footer`}
        className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
      >
        <span className="tabular-nums">
          {wordCount} kata{readingMinutes > 0 ? ` · ~${readingMinutes} menit baca` : ""}
        </span>
        <span className="font-mono text-[11px]">
          Editor: TipTap ({RICH_TEXT_EDITOR_METADATA.license}) · Skema JSON v
          {RICH_TEXT_EDITOR_METADATA.schemaVersion}
        </span>
      </div>
    </div>
  );
}

function ToolbarBtn({
  label,
  active,
  disabled,
  onClick,
  children,
  testId,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
  readonly testId?: string;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={active ? "secondary" : "ghost"}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={
        active
          ? "min-h-11 min-w-11 border border-primary/40 bg-primary/10 text-primary md:min-h-8 md:min-w-8"
          : "min-h-11 min-w-11 md:min-h-8 md:min-w-8"
      }
    >
      {children}
    </Button>
  );
}

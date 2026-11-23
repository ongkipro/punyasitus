import fs from "node:fs";
import path from "node:path";
import { RestrictedRichTextDocSchema } from "@punyasitus/core/schemas";
import { describe, expect, it } from "vitest";
import {
  escapeTableCellText,
  extractTenantMediaIdFromAttrs,
  MAX_SEQUENTIAL_MEDIA_ID,
  RICH_TEXT_EDITOR_METADATA,
  restrictedDocToTiptapJson,
  sanitizeEditorLinkUrl,
  splitEscapedTableRowText,
  tiptapJsonToRestrictedDoc,
  type TipTapNodeJson,
} from "../../apps/web/src/components/admin/editor/rich-text-schema.ts";
import { createUniqueSectionId } from "../../apps/web/src/components/admin/editor/section-id.ts";
import {
  computeTargetDimensions,
  hasAvifHeaderBytes,
  isAvifInput,
  MAX_CLIENT_IMAGE_LONGEST_EDGE,
  processImageFileForUpload,
  replaceFilenameExtension,
  type CanvasRasterizerAdapter,
} from "../../apps/web/src/components/admin/media/client-image-processor.ts";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");

describe("TASK-033: TipTap MIT core metadata & DEC-035 C13 license/island boundary", () => {
  it("records TipTap MIT core library, license, and JSON schemaVersion 1", () => {
    expect(RICH_TEXT_EDITOR_METADATA.library).toBe("@tiptap/react");
    expect(RICH_TEXT_EDITOR_METADATA.license).toBe("MIT");
    expect(RICH_TEXT_EDITOR_METADATA.proPackagesUsed).toBe(false);
    expect(RICH_TEXT_EDITOR_METADATA.schemaVersion).toBe(1);
    expect(RICH_TEXT_EDITOR_METADATA.allowedHeadingLevels).toEqual([2, 3, 4]);
  });

  it("installs strictly MIT TipTap packages and zero TipTap Pro packages in apps/web/package.json", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(webDir, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    const deps = Object.keys(pkg.dependencies ?? {});
    const tiptapDeps = deps.filter((d) => d.includes("tiptap"));
    expect(tiptapDeps.length).toBeGreaterThanOrEqual(5);
    expect(tiptapDeps).toContain("@tiptap/core");
    expect(tiptapDeps).toContain("@tiptap/react");
    expect(tiptapDeps).toContain("@tiptap/starter-kit");
    // Forbid commercial/pro TipTap scopes
    expect(deps.filter((d) => d.startsWith("@tiptap-pro/"))).toEqual([]);

    for (const pkgName of tiptapDeps) {
      const pkgJsonPath = path.join(webDir, "node_modules", pkgName, "package.json");
      const meta = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as { license?: string };
      expect(meta.license, `${pkgName} must be MIT licensed`).toBe("MIT");
    }
  });

  it("loads TipTap editor ONLY on editor routes (client:only='react'), never on list or public routes", () => {
    const listRoutes = [
      "src/pages/dashboard/[handle]/pages/index.astro",
      "src/pages/dashboard/[handle]/pages/_PagesListClient.tsx",
      "src/pages/dashboard/[handle]/posts/index.astro",
      "src/pages/dashboard/[handle]/posts/_PostsListClient.tsx",
      "src/pages/dashboard/[handle]/catalog/index.astro",
      "src/pages/dashboard/[handle]/catalog/_CatalogListClient.tsx",
      "src/pages/index.astro",
    ];
    for (const rel of listRoutes) {
      const src = fs.readFileSync(path.join(webDir, rel), "utf8");
      expect(src, `${rel} must not import TipTap`).not.toMatch(/@tiptap\/|RestrictedRichTextEditor/);
    }

    const editorRoutes = [
      "src/pages/dashboard/[handle]/pages/new.astro",
      "src/pages/dashboard/[handle]/pages/[pageId].astro",
      "src/pages/dashboard/[handle]/posts/new.astro",
      "src/pages/dashboard/[handle]/posts/[postId].astro",
      "src/pages/dashboard/[handle]/catalog/new.astro",
      "src/pages/dashboard/[handle]/catalog/[offeringId].astro",
    ];
    for (const rel of editorRoutes) {
      const src = fs.readFileSync(path.join(webDir, rel), "utf8");
      expect(src, `${rel} must mount editor as client:only="react"`).toContain('client:only="react"');
    }
  });
});

describe("TASK-033: TipTap <-> RestrictedRichTextDocSchema bidirectional conversion & sanitization", () => {
  it("converts allowed TipTap nodes/marks cleanly and round-trips deterministically", () => {
    const tiptapInput: TipTapNodeJson = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Panduan Renovasi Kantor" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Konsultasi bersama tim kami.",
              marks: [
                { type: "bold" },
                { type: "link", attrs: { href: "https://punyasitus.com/panduan" } },
              ],
            },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Survei lokasi" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "RAB transparan" }] }],
            },
          ],
        },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Kualitas tepat waktu." }] }],
        },
        {
          type: "image",
          attrs: { src: "/media/42", alt: "Foto proyek kantor", mediaId: 42 },
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Paket" }] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Estimasi" }] }] },
              ],
            },
          ],
        },
      ],
    };

    const restricted = tiptapJsonToRestrictedDoc(tiptapInput);
    expect(RestrictedRichTextDocSchema.safeParse(restricted).success).toBe(true);
    expect(restricted.schemaVersion).toBe(1);
    expect(restricted.blocks).toEqual([
      { type: "heading", level: 2, text: "Panduan Renovasi Kantor" },
      {
        type: "paragraph",
        text: "Konsultasi bersama tim kami.",
        marks: ["bold", "link"],
        href: "https://punyasitus.com/panduan",
      },
      { type: "bulletList", text: "Survei lokasi" },
      { type: "bulletList", text: "RAB transparan" },
      { type: "blockquote", text: "Kualitas tepat waktu." },
      { type: "image", mediaId: 42, text: "Foto proyek kantor" },
      { type: "tableRow", text: "Paket | Estimasi" },
    ]);

    // Round-trip back to TipTap JSON and back to RestrictedRichTextDoc deterministically
    const roundTrippedTiptap = restrictedDocToTiptapJson(restricted);
    const roundTrippedDoc = tiptapJsonToRestrictedDoc(roundTrippedTiptap);
    expect(roundTrippedDoc).toEqual(restricted);
  });

  it("strips disallowed nodes (script/iframe/form/rawHtml), unsafe links, and non-tenant images", () => {
    const hostileInput: TipTapNodeJson = {
      type: "doc",
      content: [
        { type: "script", content: [{ type: "text", text: "alert(1)" }] },
        { type: "iframe", attrs: { src: "https://evil.example/embed" } },
        { type: "form", content: [{ type: "text", text: "steal" }] },
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Judul H1 diturunkan" }] },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Klik bahaya",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Teks <script>evil()</script> aman",
              marks: [{ type: "italic" }],
            },
          ],
        },
        {
          type: "image",
          attrs: { src: "https://evil.example/tracker.png", alt: "tracker" },
        },
      ],
    };

    const sanitized = tiptapJsonToRestrictedDoc(hostileInput);
    expect(RestrictedRichTextDocSchema.safeParse(sanitized).success).toBe(true);
    expect(sanitized.blocks).toEqual([
      { type: "heading", level: 2, text: "Judul H1 diturunkan" },
      { type: "paragraph", text: "Klik bahaya" },
      { type: "paragraph", text: "Teks aman", marks: ["italic"] },
    ]);

    // Direct URL sanitizer checks
    expect(sanitizeEditorLinkUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeEditorLinkUrl("data:text/html,<h1>x</h1>")).toBeNull();
    expect(sanitizeEditorLinkUrl("http://example.com")).toBeNull();
    expect(sanitizeEditorLinkUrl("https://127.0.0.1/admin")).toBeNull();
    expect(sanitizeEditorLinkUrl("https://punyasitus.com/harga")).toBe(
      "https://punyasitus.com/harga",
    );
  });

  it("preserves hardBreak, multi-paragraph blockquote/list joins, escaped '|' table cells, mixed inline marks, and safely handles out-of-range mediaId", () => {
    const complexInput: TipTapNodeJson = {
      type: "doc",
      content: [
        // Paragraph with hardBreak
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Baris pertama" },
            { type: "hardBreak" },
            { type: "text", text: "Baris kedua" },
          ],
        },
        // Mixed inline bold (only 1 word bolded) must NOT bold the entire paragraph
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Kata biasa dan " },
            { type: "text", text: "tebal", marks: [{ type: "bold" }] },
          ],
        },
        // Multi-paragraph blockquote joined with newline (never glued as "ab")
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Kutipan satu" }] },
            { type: "paragraph", content: [{ type: "text", text: "Kutipan dua" }] },
          ],
        },
        // Table cell containing literal '|'
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "A | B" }] }],
                },
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Kolom 2" }] }],
                },
              ],
            },
          ],
        },
        // Out-of-range mediaId > 2_147_483_647 must be safely dropped (never throw ZodError!)
        {
          type: "image",
          attrs: { src: "/media/9999999999", mediaId: MAX_SEQUENTIAL_MEDIA_ID + 1, alt: "overflow" },
        },
      ],
    };

    const restricted = tiptapJsonToRestrictedDoc(complexInput);
    expect(RestrictedRichTextDocSchema.safeParse(restricted).success).toBe(true);
    expect(restricted.blocks).toEqual([
      { type: "paragraph", text: "Baris pertama\nBaris kedua" },
      { type: "paragraph", text: "Kata biasa dan tebal" },
      { type: "blockquote", text: "Kutipan satu\nKutipan dua" },
      { type: "tableRow", text: "A \\| B | Kolom 2" },
    ]);

    // Round-trip reconstructs hardBreak and preserves literal '|' inside the first cell
    const roundTrippedTiptap = restrictedDocToTiptapJson(restricted);
    const firstPara = roundTrippedTiptap.content?.[0];
    expect(firstPara?.content?.some((n) => n.type === "hardBreak")).toBe(true);
    expect(escapeTableCellText("A | B")).toBe("A \\| B");
    expect(splitEscapedTableRowText("A \\| B | Kolom 2")).toEqual(["A | B", "Kolom 2"]);

    const roundTrippedDoc = tiptapJsonToRestrictedDoc(roundTrippedTiptap);
    expect(roundTrippedDoc).toEqual(restricted);

    // mediaId bounds check
    expect(extractTenantMediaIdFromAttrs({ mediaId: MAX_SEQUENTIAL_MEDIA_ID })).toBe(
      MAX_SEQUENTIAL_MEDIA_ID,
    );
    expect(extractTenantMediaIdFromAttrs({ mediaId: MAX_SEQUENTIAL_MEDIA_ID + 1 })).toBeNull();
    expect(extractTenantMediaIdFromAttrs({ src: "/media/9999999999" })).toBeNull();
  });

  it("generates unique monotonic page section IDs that never collide after delete + add", () => {
    const id1 = createUniqueSectionId("hero", 1);
    const id2 = createUniqueSectionId("about", 2, new Set([id1]));
    const id3 = createUniqueSectionId("cta_band", 3, new Set([id1, id2]));
    // Simulate deleting #2 and adding a new section with seq 4 while #1 and #3 remain
    const id4 = createUniqueSectionId("cta_band", 4, new Set([id1, id3]));
    expect(new Set([id1, id2, id3, id4]).size).toBe(4);
    expect(id4).not.toBe(id3);
  });
});

describe("TASK-033: Client-side image processor (AVIF conversion & >2560px downscale)", () => {
  it("computes aspect-preserving target dimensions with longest edge <= 2560px", () => {
    expect(computeTargetDimensions(1200, 800)).toEqual({
      width: 1200,
      height: 800,
      resized: false,
    });
    expect(computeTargetDimensions(2560, 1440)).toEqual({
      width: 2560,
      height: 1440,
      resized: false,
    });

    const landscape = computeTargetDimensions(4032, 3024, MAX_CLIENT_IMAGE_LONGEST_EDGE);
    expect(landscape.resized).toBe(true);
    expect(landscape.width).toBe(2560);
    expect(landscape.height).toBe(1920);
    expect(Math.max(landscape.width, landscape.height)).toBeLessThanOrEqual(2560);

    const portrait = computeTargetDimensions(3000, 4000, MAX_CLIENT_IMAGE_LONGEST_EDGE);
    expect(portrait.resized).toBe(true);
    expect(portrait.height).toBe(2560);
    expect(portrait.width).toBe(1920);
  });

  it("detects AVIF by MIME, extension, and ISO BMFF ftypavif header bytes", () => {
    expect(isAvifInput({ name: "photo.jpg", type: "image/avif" })).toBe(true);
    expect(isAvifInput({ name: "photo.AVIF", type: "" })).toBe(true);
    expect(isAvifInput({ name: "photo.webp", type: "image/webp" })).toBe(false);

    const avifHeader = new Uint8Array([
      0x00, 0x00, 0x00, 0x1c, // box size
      0x66, 0x74, 0x79, 0x70, // "ftyp"
      0x61, 0x76, 0x69, 0x66, // "avif"
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(hasAvifHeaderBytes(avifHeader)).toBe(true);
    expect(isAvifInput({ name: "unnamed.bin", type: "application/octet-stream" }, avifHeader)).toBe(
      true,
    );
    expect(replaceFilenameExtension("foto-produk.avif", "image/webp")).toBe("foto-produk.webp");
  });

  it("converts AVIF to WebP (or PNG fallback) and downscales >2560px photos via canvas adapter", async () => {
    const encodedCalls: Array<{ width: number; height: number; preferredMime: string }> = [];
    const fakeWebpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

    const mockAdapter: CanvasRasterizerAdapter = {
      async decodeImage() {
        return {
          source: {} as CanvasImageSource,
          width: 4000,
          height: 2000,
        };
      },
      async encodeCanvas(_src, width, height, preferredMime) {
        encodedCalls.push({ width, height, preferredMime });
        return {
          blob: new Blob([fakeWebpBytes], { type: "image/webp" }),
          mimeType: "image/webp",
        };
      },
    };

    const avifFile = new File([new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])], "kamera.avif", {
      type: "image/avif",
    });

    const result = await processImageFileForUpload(avifFile, { rasterizer: mockAdapter });
    expect(result.wasAvifConverted).toBe(true);
    expect(result.wasResized).toBe(true);
    expect(result.mimeType).toBe("image/webp");
    expect(result.filename).toBe("kamera.webp");
    expect(result.width).toBe(2560);
    expect(result.height).toBe(1280);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(encodedCalls).toEqual([{ width: 2560, height: 1280, preferredMime: "image/webp" }]);

    // Passes SVG straight through untouched so server validation remains authoritative
    const svgFile = new File(["<svg></svg>"], "malicious.svg", { type: "image/svg+xml" });
    const svgResult = await processImageFileForUpload(svgFile, { rasterizer: mockAdapter });
    expect(svgResult.wasAvifConverted).toBe(false);
    expect(svgResult.wasResized).toBe(false);
    expect(svgResult.mimeType).toBe("image/svg+xml");
  });
});

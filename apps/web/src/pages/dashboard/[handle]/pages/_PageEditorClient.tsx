import { useCallback, useRef, useState } from "react";
import {
  htmlToRestrictedRichTextDoc,
  renderRichTextDocToSanitizedHtml,
  type PageSnapshot,
  type RestrictedRichTextDoc,
} from "@punyasitus/core/content/index";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  EyeIcon,
  GlobeIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  ConfirmDestructiveDialog,
  ContentStatusBadge,
  fieldErrorsToMap,
  InlineFieldError,
  LockedTenantBanner,
  RestrictedRichTextEditor,
  slugifyClient,
  StaleWriteRecoveryBanner,
  useDirtyNavigationGuard,
} from "@/components/admin/editor";
import { createUniqueSectionId } from "@/components/admin/editor/section-id";
import type { CmsAdminPermissions } from "@/components/admin/editor/cms-server-context";
import { MediaPickerSheet, type MediaLibraryItemDto } from "@/components/admin/media";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export type PageSectionItem = PageSnapshot["sections"][number];

export interface PageEditorInitialData {
  readonly id: number | null;
  readonly title: string;
  readonly slug: string;
  readonly status: "draft" | "published" | "trashed";
  readonly isHomepage: boolean;
  readonly layoutMode: "standard" | "focused";
  readonly sections: readonly PageSectionItem[];
  readonly hasUnpublishedChanges: boolean;
  readonly version: number;
}

export interface PageEditorClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly initialPage: PageEditorInitialData;
}

const SECTION_KIND_OPTIONS: ReadonlyArray<{
  readonly kind: PageSectionItem["kind"];
  readonly label: string;
}> = [
  { kind: "hero", label: "Hero / Tajuk Utama" },
  { kind: "rich_text", label: "Konten Teks Kaya (Rich Text)" },
  { kind: "about", label: "Tentang Bisnis" },
  { kind: "services_grid", label: "Daftar Layanan" },
  { kind: "products_grid", label: "Daftar Produk" },
  { kind: "tours_grid", label: "Daftar Paket Tur" },
  { kind: "vehicles_grid", label: "Daftar Kendaraan" },
  { kind: "gallery", label: "Galeri Foto" },
  { kind: "testimonials", label: "Testimoni" },
  { kind: "faq", label: "Tanya Jawab (FAQ)" },
  { kind: "branches", label: "Cabang / Lokasi" },
  { kind: "cta_band", label: "Pita Ajakan (CTA)" },
  { kind: "latest_posts", label: "Artikel Terbaru" },
  { kind: "contact", label: "Kontak & WhatsApp" },
  { kind: "custom_form", label: "Formulir Kustom" },
];

function createEmptySection(
  kind: PageSectionItem["kind"],
  seq: number,
  existingIds: ReadonlySet<string>,
): PageSectionItem {
  return {
    id: createUniqueSectionId(kind, seq, existingIds),
    kind,
    heading: kind === "hero" ? "Judul Utama Halaman" : "",
    subheading: null,
    bodyHtml: null,
    ctaLabel: kind === "hero" || kind === "cta_band" ? "Hubungi Kami" : null,
    ctaHref: kind === "hero" || kind === "cta_band" ? "/kontak" : null,
  };
}

export function PageEditorClient({
  handle,
  basePath,
  permissions,
  initialPage,
}: PageEditorClientProps) {
  const [pageId, setPageId] = useState<number | null>(initialPage.id);
  const [version, setVersion] = useState<number>(initialPage.version);
  const [status, setStatus] = useState<"draft" | "published" | "trashed">(initialPage.status);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(
    initialPage.hasUnpublishedChanges,
  );

  const [title, setTitle] = useState(initialPage.title);
  const [slug, setSlug] = useState(initialPage.slug);
  const [originalPublishedSlug, setOriginalPublishedSlug] = useState(
    initialPage.status === "published" ? initialPage.slug : "",
  );
  const [slugTouched, setSlugTouched] = useState(Boolean(initialPage.slug));
  const [confirmSlugChange, setConfirmSlugChange] = useState(false);
  const [isHomepage, setIsHomepage] = useState(initialPage.isHomepage);
  const [layoutMode, setLayoutMode] = useState<"standard" | "focused">(initialPage.layoutMode);
  const [sections, setSections] = useState<readonly PageSectionItem[]>(initialPage.sections);
  const [newSectionKind, setNewSectionKind] = useState<PageSectionItem["kind"]>("hero");

  const [isDirty, setIsDirty] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{
    readonly tone: "success" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);

  // Media picker for rich-text section images
  const [mediaPickerCallback, setMediaPickerCallback] = useState<
    ((media: MediaLibraryItemDto) => void) | null
  >(null);

  const bypassDirtyGuardRef = useRef(false);
  const sectionSeqRef = useRef(initialPage.sections.length + 1);

  useDirtyNavigationGuard(isDirty, bypassDirtyGuardRef);

  const readOnly = !permissions.canWriteContent || status === "trashed";
  const slugChangedWhilePublished =
    status === "published" && originalPublishedSlug !== "" && slug.trim() !== originalPublishedSlug;

  const markDirty = useCallback(() => {
    setIsDirty(true);
    setBanner(null);
  }, []);

  function updateSection(index: number, patch: Partial<PageSectionItem>) {
    if (readOnly) return;
    setSections((prev) => prev.map((sec, idx) => (idx === index ? { ...sec, ...patch } : sec)));
    markDirty();
  }

  function moveSection(index: number, delta: -1 | 1) {
    if (readOnly) return;
    const target = index + delta;
    if (target < 0 || target >= sections.length) return;
    setSections((prev) => {
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(target, 0, moved);
      return next;
    });
    markDirty();
  }

  function removeSection(index: number) {
    if (readOnly) return;
    setSections((prev) => prev.filter((_, idx) => idx !== index));
    markDirty();
  }

  function addSection() {
    if (readOnly || sections.length >= 30) return;
    const seq = sectionSeqRef.current;
    sectionSeqRef.current += 1;
    setSections((prev) => {
      const existingIds = new Set(prev.map((s) => s.id));
      return [...prev, createEmptySection(newSectionKind, seq, existingIds)];
    });
    markDirty();
  }

  function validateLocally(): boolean {
    const errs: Record<string, string> = {};
    if (!title.trim()) {
      errs.title = "Judul halaman wajib diisi.";
    }
    if (slug.trim() && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim())) {
      errs.slug = "Slug hanya boleh berisi huruf kecil, angka, dan tanda hubung (-).";
    }
    if (slugChangedWhilePublished && !confirmSlugChange) {
      errs.slug =
        "Centang konfirmasi perubahan slug karena halaman ini sudah terbit (redirect 308 akan dibuat).";
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function saveDraft(options?: {
    readonly keepSubmitting?: boolean;
  }): Promise<PageEditorInitialData | null> {
    if (readOnly || (!options?.keepSubmitting && submitting)) return null;
    if (!validateLocally()) return null;

    setSubmitting(true);
    setConflictMessage(null);
    setBanner(null);
    setFieldErrors({});

    try {
      const cleanedSections = sections.map((sec) => ({
        id: sec.id,
        kind: sec.kind,
        heading: sec.heading?.trim() ? sec.heading.trim() : null,
        subheading: sec.subheading?.trim() ? sec.subheading.trim() : null,
        bodyHtml: sec.bodyHtml?.trim() ? sec.bodyHtml : null,
        ...(sec.ctaLabel?.trim() ? { ctaLabel: sec.ctaLabel.trim() } : { ctaLabel: null }),
        ...(sec.ctaHref?.trim() ? { ctaHref: sec.ctaHref.trim() } : { ctaHref: null }),
      }));

      let saved: PageEditorInitialData;
      if (pageId === null) {
        saved = await cmsFetchJson<PageEditorInitialData>(
          `/api/tenants/${encodeURIComponent(handle)}/pages`,
          {
            method: "POST",
            body: JSON.stringify({
              title: title.trim(),
              ...(slug.trim() ? { slug: slug.trim() } : {}),
              isHomepage,
              layoutMode,
              sections: cleanedSections,
            }),
          },
        );
        setPageId(saved.id);
        if (saved.id && typeof window !== "undefined") {
          window.history.replaceState(null, "", `${basePath}/pages/${saved.id}`);
        }
      } else {
        saved = await cmsFetchJson<PageEditorInitialData>(
          `/api/tenants/${encodeURIComponent(handle)}/pages/${pageId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              title: title.trim(),
              ...(slug.trim() ? { slug: slug.trim() } : {}),
              ...(slugChangedWhilePublished ? { confirmSlugChange } : {}),
              isHomepage,
              layoutMode,
              sections: cleanedSections,
              version,
            }),
          },
        );
      }

      setVersion(saved.version);
      setStatus(saved.status);
      setSlug(saved.slug);
      setHasUnpublishedChanges(saved.hasUnpublishedChanges);
      setIsDirty(false);
      setConfirmSlugChange(false);
      if (saved.status === "published") {
        setOriginalPublishedSlug(saved.slug);
      }
      setBanner({
        tone: "success",
        title: "Draf halaman tersimpan",
        message: `Perubahan disimpan pada versi v${saved.version}.`,
      });
      return saved;
    } catch (err) {
      if (err instanceof CmsApiError) {
        if (err.isStaleVersion) {
          setConflictMessage(err.message);
        } else {
          setFieldErrors(fieldErrorsToMap(err.fields));
          setBanner({
            tone: "destructive",
            title: "Gagal menyimpan halaman",
            message: err.message,
          });
        }
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal menyimpan halaman",
          message: "Koneksi terganggu. Isian Anda tetap tersimpan di formulir.",
        });
      }
      return null;
    } finally {
      if (!options?.keepSubmitting) {
        setSubmitting(false);
      }
    }
  }

  async function handlePublishOrUnpublish(action: "publish" | "unpublish") {
    if (!permissions.canPublishContent || submitting || status === "trashed") return;
    setSubmitting(true);
    setConflictMessage(null);
    setBanner(null);

    try {
      let activeId = pageId;
      let activeVersion = version;

      if (activeId === null || isDirty) {
        const saved = await saveDraft({ keepSubmitting: true });
        if (!saved || !saved.id) return;
        activeId = saved.id;
        activeVersion = saved.version;
      }

      const result = await cmsFetchJson<PageEditorInitialData>(
        `/api/tenants/${encodeURIComponent(handle)}/pages/${activeId}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({
            version: activeVersion,
            ...(action === "publish" && slugChangedWhilePublished ? { confirmSlugChange: true } : {}),
          }),
        },
      );
      setVersion(result.version);
      setStatus(result.status);
      setSlug(result.slug);
      setHasUnpublishedChanges(result.hasUnpublishedChanges);
      setOriginalPublishedSlug(result.status === "published" ? result.slug : "");
      setConfirmSlugChange(false);
      setBanner({
        tone: "success",
        title: action === "publish" ? "Halaman berhasil diterbitkan" : "Publikasi halaman dibatalkan",
        message:
          action === "publish"
            ? `Versi v${result.version} kini aktif di situs publik.`
            : "Halaman dikembalikan ke status draf dan tidak tampil untuk pengunjung.",
      });
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        setConflictMessage(err.message);
      } else {
        setBanner({
          tone: "destructive",
          title: action === "publish" ? "Gagal menerbitkan halaman" : "Gagal membatalkan publikasi",
          message: err instanceof Error ? err.message : "Terjadi kesalahan saat memproses.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReloadLatest() {
    if (pageId === null) return;
    setReloading(true);
    try {
      const fresh = await cmsFetchJson<PageEditorInitialData>(
        `/api/tenants/${encodeURIComponent(handle)}/pages/${pageId}?includeTrashed=true`,
      );
      setTitle(fresh.title);
      setSlug(fresh.slug);
      setOriginalPublishedSlug(fresh.status === "published" ? fresh.slug : "");
      setConfirmSlugChange(false);
      setStatus(fresh.status);
      setIsHomepage(fresh.isHomepage);
      setLayoutMode(fresh.layoutMode);
      setSections(fresh.sections);
      setVersion(fresh.version);
      setHasUnpublishedChanges(fresh.hasUnpublishedChanges);
      setFieldErrors({});
      setConflictMessage(null);
      setIsDirty(false);
      setBanner({
        tone: "success",
        title: "Versi terbaru berhasil dimuat",
        message: `Formulir kini menampilkan versi terbaru v${fresh.version} dari server.`,
      });
    } catch (err) {
      setBanner({
        tone: "destructive",
        title: "Gagal memuat ulang halaman",
        message: err instanceof Error ? err.message : "Silakan muat ulang peramban.",
      });
    } finally {
      setReloading(false);
    }
  }

  async function handleConfirmTrash() {
    if (pageId === null || !permissions.canWriteContent) return;
    setSubmitting(true);
    try {
      await cmsFetchJson(`/api/tenants/${encodeURIComponent(handle)}/pages/${pageId}`, {
        method: "DELETE",
        body: JSON.stringify({ version }),
      });
      bypassDirtyGuardRef.current = true;
      setIsDirty(false);
      setTrashOpen(false);
      window.location.assign(`${basePath}/pages`);
    } catch (err) {
      setTrashOpen(false);
      if (err instanceof CmsApiError && err.isStaleVersion) {
        setConflictMessage(err.message);
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal memindahkan halaman ke Sampah",
          message: err instanceof Error ? err.message : "Terjadi kesalahan.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const previewHref =
    pageId !== null
      ? `${basePath}/preview?kind=page&id=${pageId}&version=${version}&layout=${layoutMode}`
      : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void saveDraft();
      }}
      className="space-y-6 pb-16"
      data-testid="page-editor-screen"
      data-dirty={isDirty ? "true" : "false"}
      data-version={String(version)}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 -ml-2 md:min-h-8"
              render={<a href={`${basePath}/pages`} />}
            >
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              Daftar Halaman
            </Button>
            <ContentStatusBadge status={status} hasUnpublishedChanges={hasUnpublishedChanges} />
            <Badge variant="outline" className="tabular-nums" data-testid="page-version-badge">
              v{version}
            </Badge>
            {isDirty && (
              <Badge variant="warning" data-testid="dirty-indicator">
                Belum disimpan
              </Badge>
            )}
          </div>
          <h1 className="truncate text-2xl font-bold tracking-[-0.02em] text-foreground">
            {pageId === null ? "Buat Halaman Baru" : title || `Halaman #${pageId}`}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {previewHref && (
            <Button
              variant="outline"
              className="min-h-11 md:min-h-9"
              render={<a href={previewHref} />}
              data-testid="page-preview-link"
            >
              <EyeIcon className="size-4" aria-hidden="true" />
              Pratinjau
            </Button>
          )}
          <Button
            type="submit"
            disabled={readOnly || submitting}
            className="min-h-11 md:min-h-9"
            data-testid="page-save-btn"
          >
            <SaveIcon className="size-4" aria-hidden="true" />
            {submitting ? "Menyimpan..." : "Simpan Draf"}
          </Button>
          {status === "published" ? (
            <Button
              type="button"
              variant="secondary"
              disabled={!permissions.canPublishContent || submitting}
              onClick={() => void handlePublishOrUnpublish("unpublish")}
              className="min-h-11 md:min-h-9"
              data-testid="page-unpublish-btn"
            >
              Batalkan Terbit
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              disabled={!permissions.canPublishContent || submitting || status === "trashed"}
              onClick={() => void handlePublishOrUnpublish("publish")}
              className="min-h-11 md:min-h-9"
              data-testid="page-publish-btn"
            >
              <GlobeIcon className="size-4" aria-hidden="true" />
              Terbitkan
            </Button>
          )}
        </div>
      </div>

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/service-status`} />}

      {conflictMessage && (
        <StaleWriteRecoveryBanner
          message={conflictMessage}
          reloading={reloading}
          onReloadLatest={handleReloadLatest}
        />
      )}

      {banner && (
        <Alert variant={banner.tone} data-testid="page-editor-feedback">
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      {/* Main Details Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Detail Halaman</CardTitle>
          <CardDescription>
            Tentukan judul, alamat URL (slug), serta mode tata letak halaman.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="page-title" className="block text-sm font-medium text-foreground">
              Judul Halaman <span className="text-destructive">*</span>
            </label>
            <Input
              id="page-title"
              value={title}
              disabled={readOnly}
              aria-invalid={Boolean(fieldErrors.title)}
              onChange={(e) => {
                const nextTitle = e.target.value;
                setTitle(nextTitle);
                if (!slugTouched && pageId === null) {
                  setSlug(slugifyClient(nextTitle));
                }
                markDirty();
              }}
              placeholder="Contoh: Tentang Perusahaan Kami"
              className="min-h-11 text-base md:min-h-9 md:text-sm"
              data-testid="page-title-input"
            />
            <InlineFieldError message={fieldErrors.title} />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="page-slug" className="block text-sm font-medium text-foreground">
              Slug URL
            </label>
            <Input
              id="page-slug"
              value={slug}
              disabled={readOnly}
              aria-invalid={Boolean(fieldErrors.slug)}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
                markDirty();
              }}
              placeholder="tentang-kami"
              className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
              data-testid="page-slug-input"
            />
            <InlineFieldError message={fieldErrors.slug} />
            {slugChangedWhilePublished && (
              <label className="mt-1 flex items-center gap-2 text-xs text-warning">
                <input
                  type="checkbox"
                  checked={confirmSlugChange}
                  onChange={(e) => setConfirmSlugChange(e.target.checked)}
                />
                <span>
                  Konfirmasi ubah slug terbit (pengalihan otomatis 308 akan dibuat dari /
                  {originalPublishedSlug})
                </span>
              </label>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="page-layout-mode" className="block text-sm font-medium text-foreground">
              Mode Tata Letak
            </label>
            <select
              id="page-layout-mode"
              value={layoutMode}
              disabled={readOnly}
              onChange={(e) => {
                setLayoutMode(e.target.value === "focused" ? "focused" : "standard");
                markDirty();
              }}
              className="flex min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground md:min-h-9 md:text-sm"
              data-testid="page-layout-select"
            >
              <option value="standard">Standar (Header &amp; Footer aktif)</option>
              <option value="focused">Mode Fokus Landing Page (Tanpa navigasi header/footer)</option>
            </select>
          </div>

          <div className="flex items-center gap-2.5 pt-2 md:pt-7">
            <input
              id="page-is-homepage"
              type="checkbox"
              checked={isHomepage}
              disabled={readOnly}
              onChange={(e) => {
                setIsHomepage(e.target.checked);
                markDirty();
              }}
              className="size-4 rounded border-input accent-primary"
            />
            <label htmlFor="page-is-homepage" className="text-sm font-medium text-foreground">
              Jadikan halaman utama (Beranda /)
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Modular 1D Section Composer */}
      <Card data-testid="page-sections-card">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base">Susunan Bagian Halaman ({sections.length}/30)</CardTitle>
              <CardDescription>
                Tambahkan bagian dari daftar tertutup dan atur urutan dengan tombol Naik/Turun.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Pilih jenis bagian baru"
                value={newSectionKind}
                disabled={readOnly}
                onChange={(e) => setNewSectionKind(e.target.value as PageSectionItem["kind"])}
                className="min-h-11 rounded-md border border-input bg-card px-3 py-2 text-base text-foreground md:min-h-9 md:text-sm"
                data-testid="page-new-section-kind"
              >
                {SECTION_KIND_OPTIONS.map((opt) => (
                  <option key={opt.kind} value={opt.kind}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                disabled={readOnly || sections.length >= 30}
                onClick={addSection}
                className="min-h-11 md:min-h-9"
                data-testid="page-add-section-btn"
              >
                <PlusIcon className="size-4" aria-hidden="true" />
                Tambah Bagian
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {sections.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Belum ada bagian pada halaman ini. Pilih jenis bagian lalu klik Tambah Bagian.
            </p>
          ) : (
            sections.map((sec, idx) => {
              const kindLabel =
                SECTION_KIND_OPTIONS.find((k) => k.kind === sec.kind)?.label ?? sec.kind;
              const richDoc: RestrictedRichTextDoc = sec.bodyHtml
                ? htmlToRestrictedRichTextDoc(sec.bodyHtml)
                : { schemaVersion: 1, blocks: [] };

              return (
                <div
                  key={`${sec.id}-${idx}`}
                  data-testid={`page-section-item-${idx}`}
                  className="space-y-3 rounded-md border border-border bg-muted/20 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="tabular-nums">
                        #{idx + 1}
                      </Badge>
                      <span className="text-sm font-semibold text-foreground">{kindLabel}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        disabled={readOnly || idx === 0}
                        onClick={() => moveSection(idx, -1)}
                        aria-label={`Pindahkan bagian ${idx + 1} naik`}
                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                        data-testid={`page-section-up-${idx}`}
                      >
                        <ArrowUpIcon className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        disabled={readOnly || idx === sections.length - 1}
                        onClick={() => moveSection(idx, 1)}
                        aria-label={`Pindahkan bagian ${idx + 1} turun`}
                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                        data-testid={`page-section-down-${idx}`}
                      >
                        <ArrowDownIcon className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="destructive"
                        disabled={readOnly}
                        onClick={() => removeSection(idx)}
                        aria-label={`Hapus bagian ${idx + 1}`}
                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                      >
                        <Trash2Icon className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <label
                        htmlFor={`sec-heading-${idx}`}
                        className="block text-xs font-medium text-foreground"
                      >
                        Judul Bagian
                      </label>
                      <Input
                        id={`sec-heading-${idx}`}
                        value={sec.heading ?? ""}
                        disabled={readOnly}
                        onChange={(e) => updateSection(idx, { heading: e.target.value })}
                        placeholder="Judul bagian"
                        className="min-h-11 text-base md:min-h-9 md:text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label
                        htmlFor={`sec-subheading-${idx}`}
                        className="block text-xs font-medium text-foreground"
                      >
                        Subjudul (opsional)
                      </label>
                      <Input
                        id={`sec-subheading-${idx}`}
                        value={sec.subheading ?? ""}
                        disabled={readOnly}
                        onChange={(e) => updateSection(idx, { subheading: e.target.value })}
                        placeholder="Penjelasan singkat bagian"
                        className="min-h-11 text-base md:min-h-9 md:text-sm"
                      />
                    </div>
                  </div>

                  {(sec.kind === "rich_text" || sec.kind === "about") && (
                    <div className="space-y-1">
                      <span className="block text-xs font-medium text-foreground">
                        Isi Konten Bagian
                      </span>
                      <RestrictedRichTextEditor
                        id={`sec-richtext-${idx}`}
                        label={`Konten bagian ${idx + 1}`}
                        value={richDoc}
                        readOnly={readOnly}
                        onChange={(nextDoc) =>
                          updateSection(idx, {
                            bodyHtml: renderRichTextDocToSanitizedHtml(nextDoc),
                          })
                        }
                        onRequestMediaPicker={(onPick) =>
                          setMediaPickerCallback(() => (item: MediaLibraryItemDto) => onPick(item))
                        }
                        testId={`page-section-editor-${idx}`}
                      />
                    </div>
                  )}

                  {(sec.kind === "hero" || sec.kind === "cta_band") && (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="space-y-1">
                        <label
                          htmlFor={`sec-cta-label-${idx}`}
                          className="block text-xs font-medium text-foreground"
                        >
                          Label Tombol CTA
                        </label>
                        <Input
                          id={`sec-cta-label-${idx}`}
                          value={sec.ctaLabel ?? ""}
                          disabled={readOnly}
                          onChange={(e) => updateSection(idx, { ctaLabel: e.target.value })}
                          placeholder="Konsultasi Gratis"
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label
                          htmlFor={`sec-cta-href-${idx}`}
                          className="block text-xs font-medium text-foreground"
                        >
                          Tautan Tombol CTA
                        </label>
                        <Input
                          id={`sec-cta-href-${idx}`}
                          value={sec.ctaHref ?? ""}
                          disabled={readOnly}
                          onChange={(e) => updateSection(idx, { ctaHref: e.target.value })}
                          placeholder="/kontak atau https://wa.me/6281234567890"
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {pageId !== null && status !== "trashed" && permissions.canWriteContent && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="destructive"
            disabled={submitting}
            onClick={() => setTrashOpen(true)}
            className="min-h-11 md:min-h-9"
            data-testid="page-editor-trash-btn"
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
            Pindahkan Halaman ke Sampah
          </Button>
        </div>
      )}

      <MediaPickerSheet
        open={mediaPickerCallback !== null}
        onOpenChange={(o) => !o && setMediaPickerCallback(null)}
        handle={handle}
        canUpload={permissions.canUploadMedia}
        onSelect={(item) => {
          mediaPickerCallback?.(item);
          setMediaPickerCallback(null);
        }}
      />

      <ConfirmDestructiveDialog
        open={trashOpen}
        onOpenChange={setTrashOpen}
        title={`Pindahkan "${title || "halaman ini"}" ke Sampah?`}
        description="Halaman akan ditarik dari situs publik jika sedang terbit dan dipindahkan ke tab Sampah."
        confirmLabel="Pindahkan ke Sampah"
        busy={submitting}
        onConfirm={handleConfirmTrash}
      />
    </form>
  );
}

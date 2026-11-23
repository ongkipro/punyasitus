import { useCallback, useMemo, useRef, useState } from "react";
import type { RestrictedRichTextDoc } from "@punyasitus/core/content/index";
import {
  calculateLinearReadingTimeMinutes,
  extractTocFromRichTextDoc,
} from "@punyasitus/core/posts/index";
import {
  extractChecklistSignalsFromRichTextDoc,
  validateSearchAppearanceTemplateString,
  type PeerPublishedSeoSummary,
  type SeoEditorOverrideInput,
} from "@punyasitus/core/seo/editor";
import type { SiteVisibility } from "@punyasitus/core/seo/index";
import {
  ArrowLeftIcon,
  ClockIcon,
  EyeIcon,
  GlobeIcon,
  ImageIcon,
  ListIcon,
  SaveIcon,
  Trash2Icon,
  UserIcon,
  XIcon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  ConfirmDestructiveDialog,
  ContentStatusBadge,
  fieldErrorsToMap,
  formatDateTimeId,
  InlineFieldError,
  LockedTenantBanner,
  RestrictedRichTextEditor,
  slugifyClient,
  StaleWriteRecoveryBanner,
  useDirtyNavigationGuard,
} from "@/components/admin/editor";
import type { CmsAdminPermissions } from "@/components/admin/editor/cms-server-context";
import { MediaPickerSheet, type MediaLibraryItemDto } from "@/components/admin/media";
import { SeoOverrideDrawer } from "@/components/admin/seo";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { PostTaxonomyOptionDto } from "./_PostsListClient";

export interface PostAuthorOptionDto {
  readonly id: number;
  readonly name: string;
  readonly roleTitle: string | null;
  readonly bio: string | null;
}

export interface PostEditorInitialData {
  readonly id: number | null;
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string;
  readonly body: RestrictedRichTextDoc;
  readonly status: "draft" | "published" | "trashed";
  readonly featuredMediaId: number | null;
  readonly authorId?: number | null;
  readonly primaryCategoryId: number | null;
  readonly categoryIds: readonly number[];
  readonly tagIds: readonly number[];
  readonly enableToc: boolean;
  readonly seo?: SeoEditorOverrideInput | null;
  readonly hasUnpublishedChanges: boolean;
  readonly publishedAt?: string | null;
  readonly contentModifiedAt?: string | null;
  readonly version: number;
}

export interface PostEditorClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly initialPost: PostEditorInitialData;
  readonly categories: readonly PostTaxonomyOptionDto[];
  readonly tags: readonly PostTaxonomyOptionDto[];
  readonly authors?: readonly PostAuthorOptionDto[];
  readonly siteName?: string;
  readonly primaryHost?: string;
  readonly siteVisibility?: SiteVisibility;
  readonly seoAutopilotEnabled?: boolean;
  readonly publishedPeers?: readonly PeerPublishedSeoSummary[];
}

export function PostEditorClient({
  handle,
  basePath,
  permissions,
  initialPost,
  categories,
  tags,
  authors = [],
  siteName = handle,
  primaryHost = `${handle}.situsku.click`,
  siteVisibility = "public",
  seoAutopilotEnabled = true,
  publishedPeers = [],
}: PostEditorClientProps) {
  const [postId, setPostId] = useState<number | null>(initialPost.id);
  const [version, setVersion] = useState(initialPost.version);
  const [status, setStatus] = useState<"draft" | "published" | "trashed">(initialPost.status);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(
    initialPost.hasUnpublishedChanges,
  );
  const [publishedAt, setPublishedAt] = useState<string | null>(initialPost.publishedAt ?? null);
  const [contentModifiedAt, setContentModifiedAt] = useState<string | null>(
    initialPost.contentModifiedAt ?? null,
  );

  const [title, setTitle] = useState(initialPost.title);
  const [slug, setSlug] = useState(initialPost.slug);
  const [originalPublishedSlug, setOriginalPublishedSlug] = useState(
    initialPost.status === "published" ? initialPost.slug : "",
  );
  const [slugTouched, setSlugTouched] = useState(Boolean(initialPost.slug));
  const [confirmSlugChange, setConfirmSlugChange] = useState(false);
  const [excerpt, setExcerpt] = useState(initialPost.excerpt);
  const [body, setBody] = useState<RestrictedRichTextDoc>(initialPost.body);
  const [featuredMediaId, setFeaturedMediaId] = useState<number | null>(
    initialPost.featuredMediaId,
  );
  const [authorId, setAuthorId] = useState<number | null>(initialPost.authorId ?? null);
  const [primaryCategoryId, setPrimaryCategoryId] = useState<number | null>(
    initialPost.primaryCategoryId,
  );
  const [categoryIds, setCategoryIds] = useState<readonly number[]>(initialPost.categoryIds);
  const [tagIds, setTagIds] = useState<readonly number[]>(initialPost.tagIds);
  const [enableToc, setEnableToc] = useState(initialPost.enableToc);
  const [seo, setSeo] = useState<SeoEditorOverrideInput>(initialPost.seo ?? {});
  const [seoDirty, setSeoDirty] = useState(false);

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
  const [mediaPickerMode, setMediaPickerMode] = useState<
    | null
    | { readonly kind: "featured" }
    | { readonly kind: "seo_og" }
    | {
        readonly kind: "inline";
        readonly onPick: (media: MediaLibraryItemDto) => void;
      }
  >(null);

  const bypassDirtyGuardRef = useRef(false);

  useDirtyNavigationGuard(isDirty, bypassDirtyGuardRef);

  const readOnly = !permissions.canWriteContent || status === "trashed";
  const slugChangedWhilePublished =
    status === "published" && originalPublishedSlug !== "" && slug.trim() !== originalPublishedSlug;

  const markDirty = useCallback(() => {
    setIsDirty(true);
    setBanner(null);
  }, []);

  function toggleCategory(catId: number) {
    if (readOnly) return;
    setCategoryIds((prev) => {
      const exists = prev.includes(catId);
      const next = exists ? prev.filter((id) => id !== catId) : [...prev, catId].slice(0, 10);
      if (exists && primaryCategoryId === catId) {
        setPrimaryCategoryId(next[0] ?? null);
      } else if (!exists && primaryCategoryId === null) {
        setPrimaryCategoryId(catId);
      }
      return next;
    });
    markDirty();
  }

  function toggleTag(tagId: number) {
    if (readOnly) return;
    setTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId].slice(0, 20),
    );
    markDirty();
  }

  const postChecklistSignals = useMemo(
    () => extractChecklistSignalsFromRichTextDoc(body, primaryHost),
    [body, primaryHost],
  );
  const estimatedReadingMinutes = useMemo(() => calculateLinearReadingTimeMinutes(body), [body]);
  const liveTocOutline = useMemo(() => extractTocFromRichTextDoc(body), [body]);
  const selectedAuthor = useMemo(
    () => (authorId !== null ? (authors.find((a) => a.id === authorId) ?? null) : null),
    [authors, authorId],
  );

  function validateLocally(): boolean {
    const errs: Record<string, string> = {};
    if (!title.trim()) {
      errs.title = "Judul artikel wajib diisi.";
    }
    if (slug.trim() && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim())) {
      errs.slug = "Slug hanya boleh berisi huruf kecil, angka, dan tanda hubung (-).";
    }
    if (slugChangedWhilePublished && !confirmSlugChange) {
      errs.slug = "Centang konfirmasi perubahan slug artikel yang sudah terbit.";
    }
    if (seoAutopilotEnabled && seo.titleOverride?.trim()) {
      const check = validateSearchAppearanceTemplateString(seo.titleOverride.trim());
      if (!check.ok) errs["seo.titleOverride"] = check.issue.message;
    }
    if (seoAutopilotEnabled && seo.descriptionOverride?.trim()) {
      const check = validateSearchAppearanceTemplateString(seo.descriptionOverride.trim());
      if (!check.ok) errs["seo.descriptionOverride"] = check.issue.message;
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function saveDraft(options?: {
    readonly keepSubmitting?: boolean;
  }): Promise<PostEditorInitialData | null> {
    if (readOnly || (!options?.keepSubmitting && submitting)) return null;
    if (!validateLocally()) return null;

    setSubmitting(true);
    setConflictMessage(null);
    setBanner(null);
    setFieldErrors({});

    try {
      const payload = {
        title: title.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        excerpt: excerpt.trim() ? excerpt.trim() : null,
        body,
        featuredMediaId,
        authorId,
        primaryCategoryId,
        categoryIds,
        tagIds,
        enableToc,
      };

      let saved: PostEditorInitialData & { readonly excerpt: string | null };
      if (postId === null) {
        saved = await cmsFetchJson<PostEditorInitialData & { readonly excerpt: string | null }>(
          `/api/tenants/${encodeURIComponent(handle)}/posts`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );
        setPostId(saved.id);
        if (saved.id && typeof window !== "undefined") {
          window.history.replaceState(null, "", `${basePath}/posts/${saved.id}`);
        }
      } else {
        saved = await cmsFetchJson<PostEditorInitialData & { readonly excerpt: string | null }>(
          `/api/tenants/${encodeURIComponent(handle)}/posts/${postId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              ...payload,
              ...(slugChangedWhilePublished ? { confirmSlugChange } : {}),
              version,
            }),
          },
        );
      }

      let nextVersion = saved.version;
      if (seoAutopilotEnabled && seoDirty && saved.id !== null) {
        const seoRes = await cmsFetchJson<{ readonly seo: { readonly version: number } }>(
          `/api/tenants/${encodeURIComponent(handle)}/seo/resources/post/${saved.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ seo, version: nextVersion }),
          },
        );
        nextVersion = seoRes.seo.version;
        setSeoDirty(false);
      }

      setVersion(nextVersion);
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
        title: "Draf artikel tersimpan",
        message: `Artikel tersimpan pada versi v${nextVersion}.`,
      });
      return { ...saved, version: nextVersion, excerpt: saved.excerpt ?? "" };
    } catch (err) {
      if (err instanceof CmsApiError) {
        if (err.isStaleVersion) {
          setConflictMessage(err.message);
        } else {
          setFieldErrors(fieldErrorsToMap(err.fields));
          setBanner({
            tone: "destructive",
            title: "Gagal menyimpan artikel",
            message: err.message,
          });
        }
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal menyimpan artikel",
          message: "Gangguan koneksi terjadi. Isian artikel Anda tetap dipertahankan.",
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
      let activeId = postId;
      let activeVersion = version;

      if (activeId === null || isDirty) {
        const saved = await saveDraft({ keepSubmitting: true });
        if (!saved || !saved.id) return;
        activeId = saved.id;
        activeVersion = saved.version;
      }

      const result = await cmsFetchJson<PostEditorInitialData>(
        `/api/tenants/${encodeURIComponent(handle)}/posts/${activeId}/${action}`,
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
      setPublishedAt(result.publishedAt ?? publishedAt);
      setContentModifiedAt(result.contentModifiedAt ?? contentModifiedAt);
      setOriginalPublishedSlug(result.status === "published" ? result.slug : "");
      setConfirmSlugChange(false);
      setBanner({
        tone: "success",
        title: action === "publish" ? "Artikel berhasil diterbitkan" : "Publikasi artikel dibatalkan",
        message:
          action === "publish"
            ? `Artikel versi v${result.version} kini tayang di blog publik.`
            : "Artikel dikembalikan menjadi draf.",
      });
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        setConflictMessage(err.message);
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal mengubah status publikasi",
          message: err instanceof Error ? err.message : "Terjadi kesalahan.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReloadLatest() {
    if (postId === null) return;
    setReloading(true);
    try {
      const fresh = await cmsFetchJson<
        PostEditorInitialData & { readonly excerpt: string | null }
      >(`/api/tenants/${encodeURIComponent(handle)}/posts/${postId}?includeTrashed=true`);
      setTitle(fresh.title);
      setSlug(fresh.slug);
      setOriginalPublishedSlug(fresh.status === "published" ? fresh.slug : "");
      setConfirmSlugChange(false);
      setExcerpt(fresh.excerpt ?? "");
      setBody(fresh.body);
      setStatus(fresh.status);
      setFeaturedMediaId(fresh.featuredMediaId);
      setAuthorId(fresh.authorId ?? null);
      setPrimaryCategoryId(fresh.primaryCategoryId);
      setCategoryIds(fresh.categoryIds);
      setTagIds(fresh.tagIds);
      setEnableToc(fresh.enableToc);
      setPublishedAt(fresh.publishedAt ?? null);
      setContentModifiedAt(fresh.contentModifiedAt ?? null);
      setVersion(fresh.version);
      setHasUnpublishedChanges(fresh.hasUnpublishedChanges);
      setFieldErrors({});
      setConflictMessage(null);
      setIsDirty(false);
      setBanner({
        tone: "success",
        title: "Versi terbaru artikel dimuat",
        message: `Editor kini disinkronkan ke versi terbaru v${fresh.version}.`,
      });
    } catch (err) {
      setBanner({
        tone: "destructive",
        title: "Gagal memuat ulang artikel",
        message: err instanceof Error ? err.message : "Silakan muat ulang halaman.",
      });
    } finally {
      setReloading(false);
    }
  }

  async function handleConfirmTrash() {
    if (postId === null || !permissions.canWriteContent) return;
    setSubmitting(true);
    try {
      await cmsFetchJson(`/api/tenants/${encodeURIComponent(handle)}/posts/${postId}`, {
        method: "DELETE",
        body: JSON.stringify({ version }),
      });
      bypassDirtyGuardRef.current = true;
      setIsDirty(false);
      setTrashOpen(false);
      window.location.assign(`${basePath}/posts`);
    } catch (err) {
      setTrashOpen(false);
      if (err instanceof CmsApiError && err.isStaleVersion) {
        setConflictMessage(err.message);
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal menghapus artikel",
          message: err instanceof Error ? err.message : "Terjadi kesalahan.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const previewHref =
    postId !== null ? `${basePath}/preview?kind=post&id=${postId}&version=${version}` : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void saveDraft();
      }}
      className="space-y-6 pb-16"
      data-testid="post-editor-screen"
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
              render={<a href={`${basePath}/posts`} />}
            >
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              Daftar Artikel
            </Button>
            <ContentStatusBadge status={status} hasUnpublishedChanges={hasUnpublishedChanges} />
            <Badge variant="outline" className="tabular-nums" data-testid="post-version-badge">
              v{version}
            </Badge>
            {isDirty && (
              <Badge variant="warning" data-testid="dirty-indicator">
                Belum disimpan
              </Badge>
            )}
          </div>
          <h1 className="truncate text-2xl font-bold tracking-[-0.02em] text-foreground">
            {postId === null ? "Tulis Artikel Baru" : title || `Artikel #${postId}`}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {previewHref && (
            <Button
              variant="outline"
              className="min-h-11 md:min-h-9"
              render={<a href={previewHref} />}
              data-testid="post-preview-link"
            >
              <EyeIcon className="size-4" aria-hidden="true" />
              Pratinjau
            </Button>
          )}
          <Button
            type="submit"
            disabled={readOnly || submitting}
            className="min-h-11 md:min-h-9"
            data-testid="post-save-btn"
          >
            <SaveIcon className="size-4" aria-hidden="true" />
            {submitting ? "Menyimpan..." : "Simpan Draf"}
          </Button>
          {status === "published" ? (
            <>
              {(hasUnpublishedChanges || isDirty) && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!permissions.canPublishContent || submitting}
                  onClick={() => void handlePublishOrUnpublish("publish")}
                  className="min-h-11 md:min-h-9"
                  data-testid="post-republish-btn"
                >
                  <GlobeIcon className="size-4" aria-hidden="true" />
                  Terbitkan Perubahan
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={!permissions.canPublishContent || submitting}
                onClick={() => void handlePublishOrUnpublish("unpublish")}
                className="min-h-11 md:min-h-9"
                data-testid="post-unpublish-btn"
              >
                Batalkan Terbit
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="secondary"
              disabled={!permissions.canPublishContent || submitting || status === "trashed"}
              onClick={() => void handlePublishOrUnpublish("publish")}
              className="min-h-11 md:min-h-9"
              data-testid="post-publish-btn"
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
        <Alert variant={banner.tone} data-testid="post-editor-feedback">
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Main Editorial Column */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="space-y-1.5">
                <label htmlFor="post-title" className="block text-sm font-medium text-foreground">
                  Judul Artikel <span className="text-destructive">*</span>
                </label>
                <Input
                  id="post-title"
                  value={title}
                  disabled={readOnly}
                  aria-invalid={Boolean(fieldErrors.title)}
                  onChange={(e) => {
                    const next = e.target.value;
                    setTitle(next);
                    if (!slugTouched && postId === null) {
                      setSlug(slugifyClient(next));
                    }
                    markDirty();
                  }}
                  placeholder="Contoh: Panduan Memilih Jasa Renovasi Kantor di Jakarta"
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                  data-testid="post-title-input"
                />
                <InlineFieldError message={fieldErrors.title} />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="post-slug" className="block text-sm font-medium text-foreground">
                  Slug URL (/blog/...)
                </label>
                <Input
                  id="post-slug"
                  value={slug}
                  disabled={readOnly}
                  aria-invalid={Boolean(fieldErrors.slug)}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value);
                    markDirty();
                  }}
                  placeholder="panduan-renovasi-kantor"
                  className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                  data-testid="post-slug-input"
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
                      Konfirmasi ubah slug artikel terbit (redirect 308 otomatis dari /blog/
                      {originalPublishedSlug})
                    </span>
                  </label>
                )}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="post-excerpt" className="block text-sm font-medium text-foreground">
                  Ringkasan (Excerpt)
                </label>
                <textarea
                  id="post-excerpt"
                  rows={3}
                  maxLength={500}
                  value={excerpt}
                  disabled={readOnly}
                  onChange={(e) => {
                    setExcerpt(e.target.value);
                    markDirty();
                  }}
                  placeholder="Ringkasan singkat 1–2 kalimat yang tampil pada kartu daftar artikel."
                  className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:text-sm"
                  data-testid="post-excerpt-input"
                />
              </div>

              <div className="space-y-1.5">
                <span className="block text-sm font-medium text-foreground">Isi Artikel</span>
                <RestrictedRichTextEditor
                  id="post-body-editor"
                  label="Isi artikel blog"
                  value={body}
                  readOnly={readOnly}
                  onChange={(nextDoc) => {
                    setBody(nextDoc);
                    markDirty();
                  }}
                  onRequestMediaPicker={(onPick) =>
                    setMediaPickerMode({
                      kind: "inline",
                      onPick: (item) => onPick(item),
                    })
                  }
                  testId="post-richtext-editor"
                />
                <InlineFieldError message={fieldErrors.body} />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Inspector Sidebar */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Gambar Utama</CardTitle>
              <CardDescription>
                Ditampilkan sebagai sampul artikel dan pratinjau tautan.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {featuredMediaId !== null ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                  <div className="flex items-center gap-2 text-sm">
                    <ImageIcon className="size-4 text-primary" aria-hidden="true" />
                    <span className="font-medium tabular-nums">Media #{featuredMediaId}</span>
                  </div>
                  {!readOnly && (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Hapus gambar utama"
                      onClick={() => {
                        setFeaturedMediaId(null);
                        markDirty();
                      }}
                      className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                    >
                      <XIcon className="size-4" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Belum ada gambar utama dipilih.</p>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={readOnly}
                onClick={() => setMediaPickerMode({ kind: "featured" })}
                className="min-h-11 w-full md:min-h-9"
                data-testid="post-pick-featured-media"
              >
                <ImageIcon className="size-4" aria-hidden="true" />
                {featuredMediaId !== null ? "Ganti Gambar Utama" : "Pilih dari Media"}
              </Button>
            </CardContent>
          </Card>

          <Card data-testid="post-author-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserIcon className="size-4 text-primary" aria-hidden="true" />
                Profil Penulis (Byline)
              </CardTitle>
              <CardDescription>
                Ditampilkan sebagai byline artikel dan <code>Article.author</code> JSON-LD.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="post-author-select"
                  className="block text-xs font-medium text-muted-foreground"
                >
                  Pilih Penulis
                </label>
                <select
                  id="post-author-select"
                  value={authorId !== null ? String(authorId) : ""}
                  disabled={readOnly}
                  onChange={(e) => {
                    setAuthorId(e.target.value ? Number(e.target.value) : null);
                    markDirty();
                  }}
                  className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                  data-testid="post-author-select"
                >
                  <option value="">Tanpa profil penulis (default)</option>
                  {authors.map((author) => (
                    <option key={author.id} value={String(author.id)}>
                      {author.name}
                      {author.roleTitle ? ` — ${author.roleTitle}` : ""}
                    </option>
                  ))}
                </select>
                <InlineFieldError message={fieldErrors.authorId} />
              </div>

              {selectedAuthor && (
                <div
                  className="rounded-md border border-border bg-muted/30 p-3 text-xs space-y-1"
                  data-testid="post-selected-author-preview"
                >
                  <p className="font-semibold text-foreground">{selectedAuthor.name}</p>
                  {selectedAuthor.roleTitle && (
                    <p className="font-medium text-primary">{selectedAuthor.roleTitle}</p>
                  )}
                  {selectedAuthor.bio && (
                    <p className="text-muted-foreground">{selectedAuthor.bio}</p>
                  )}
                </div>
              )}

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 w-full md:min-h-8"
                render={<a href={`${basePath}/posts/authors`} />}
                data-testid="post-manage-authors-link"
              >
                Kelola Profil Penulis
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Kategori, Tag &amp; Daftar Isi</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
                data-testid="post-reading-time-summary"
              >
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <ClockIcon className="size-3.5 text-primary" aria-hidden="true" />
                  Estimasi waktu baca
                </span>
                <Badge variant="outline" className="tabular-nums">
                  {estimatedReadingMinutes} menit baca
                </Badge>
              </div>

              {(publishedAt || contentModifiedAt) && (
                <div
                  className="space-y-1 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
                  data-testid="post-modified-discipline-info"
                >
                  {publishedAt && (
                    <p>
                      Diterbitkan:{" "}
                      <span className="font-medium text-foreground">
                        {formatDateTimeId(publishedAt)}
                      </span>
                    </p>
                  )}
                  {contentModifiedAt && (
                    <p>
                      Diperbarui (publik):{" "}
                      <span className="font-medium text-foreground">
                        {formatDateTimeId(contentModifiedAt)}
                      </span>
                    </p>
                  )}
                  <p className="text-[11px]">
                    Simpan draf tidak mengubah tanggal pembaruan publik atau sitemap sampai
                    perubahan substansial diterbitkan ulang.
                  </p>
                </div>
              )}

              <label className="flex min-h-11 items-center gap-2.5 text-sm font-medium text-foreground md:min-h-8">
                <input
                  type="checkbox"
                  checked={enableToc}
                  disabled={readOnly}
                  onChange={(e) => {
                    setEnableToc(e.target.checked);
                    markDirty();
                  }}
                  className="size-4 rounded border-input accent-primary"
                  data-testid="post-enable-toc"
                />
                <span>Tampilkan Daftar Isi (TOC) otomatis dari H2/H3</span>
              </label>

              {enableToc && (
                <div
                  className="space-y-1.5 rounded-md border border-border/80 bg-muted/20 p-3 text-xs"
                  data-testid="post-toc-preview"
                >
                  <div className="flex items-center justify-between font-medium text-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <ListIcon className="size-3.5 text-primary" aria-hidden="true" />
                      Pratinjau Daftar Isi (Zero-JS)
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {liveTocOutline.length} judul
                    </span>
                  </div>
                  {liveTocOutline.length > 0 ? (
                    <ol className="space-y-1 pt-1 text-muted-foreground">
                      {liveTocOutline.map((entry) => (
                        <li
                          key={entry.id}
                          className={entry.level === 3 ? "pl-3 text-[11px]" : "font-medium text-foreground"}
                        >
                          #{entry.id} — {entry.text}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Tambahkan subjudul H2 atau H3 pada isi artikel agar Daftar Isi muncul.
                    </p>
                  )}
                </div>
              )}

              {categories.length > 0 && (
                <div className="space-y-2">
                  <span className="block text-xs font-semibold text-foreground uppercase">
                    Kategori (maks. 3 tingkat)
                  </span>
                  <div className="space-y-1.5">
                    {categories.map((cat) => {
                      const indentPx = Math.max(0, Math.min(2, (cat.depth ?? 1) - 1)) * 14;
                      return (
                        <label
                          key={cat.id}
                          style={{ paddingLeft: `${indentPx}px` }}
                          className="flex min-h-11 items-center gap-2 text-sm text-foreground md:min-h-8"
                        >
                          <input
                            type="checkbox"
                            checked={categoryIds.includes(cat.id)}
                            disabled={readOnly}
                            onChange={() => toggleCategory(cat.id)}
                            className="size-4 rounded border-input accent-primary"
                          />
                          <span>
                            {(cat.depth ?? 1) > 1 ? "↳ " : ""}
                            {cat.name}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {categoryIds.length > 0 && (
                    <div className="space-y-1 pt-1">
                      <label
                        htmlFor="post-primary-category"
                        className="block text-xs font-medium text-muted-foreground"
                      >
                        Kategori Utama
                      </label>
                      <select
                        id="post-primary-category"
                        value={primaryCategoryId !== null ? String(primaryCategoryId) : ""}
                        disabled={readOnly}
                        onChange={(e) => {
                          setPrimaryCategoryId(e.target.value ? Number(e.target.value) : null);
                          markDirty();
                        }}
                        className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                        data-testid="post-primary-category-select"
                      >
                        <option value="">Otomatis</option>
                        {categories
                          .filter((c) => categoryIds.includes(c.id))
                          .map((c) => (
                            <option key={c.id} value={String(c.id)}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              {tags.length > 0 && (
                <div className="space-y-2">
                  <span className="block text-xs font-semibold text-foreground uppercase">Tag</span>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag) => {
                      const active = tagIds.includes(tag.id);
                      return (
                        <Button
                          key={tag.id}
                          type="button"
                          size="sm"
                          variant={active ? "default" : "outline"}
                          disabled={readOnly}
                          onClick={() => toggleTag(tag.id)}
                          className="min-h-9"
                        >
                          #{tag.name}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {postId !== null && status !== "trashed" && permissions.canWriteContent && (
            <Button
              type="button"
              variant="destructive"
              disabled={submitting}
              onClick={() => setTrashOpen(true)}
              className="min-h-11 w-full md:min-h-9"
              data-testid="post-editor-trash-btn"
            >
              <Trash2Icon className="size-4" aria-hidden="true" />
              Pindahkan Artikel ke Sampah
            </Button>
          )}
        </div>
      </div>

      <SeoOverrideDrawer
        seoAutopilotEnabled={seoAutopilotEnabled}
        resourceKind="post"
        siteName={siteName}
        primaryHost={primaryHost}
        tenantHandle={handle}
        tenantStatus={permissions.tenantStatus}
        siteVisibility={siteVisibility}
        pathname={`/blog/${slug || "artikel-baru"}`}
        resourceTitle={title}
        slug={slug}
        resourceExcerpt={excerpt || postChecklistSignals.firstParagraphText || null}
        resourceFeaturedMediaId={featuredMediaId}
        publicationState={status}
        firstParagraphText={postChecklistSignals.firstParagraphText}
        headings={postChecklistSignals.headings}
        plainTextBody={postChecklistSignals.plainTextBody}
        internalLinkCount={postChecklistSignals.internalLinkCount}
        images={postChecklistSignals.images}
        publishedPeers={publishedPeers}
        slugChangedWhilePublished={slugChangedWhilePublished}
        oldPublishedSlug={originalPublishedSlug || null}
        value={seo}
        onChange={(nextSeo) => {
          setSeo(nextSeo);
          setSeoDirty(true);
          markDirty();
        }}
        onPickOgMedia={() => setMediaPickerMode({ kind: "seo_og" })}
        readOnly={readOnly}
        fieldErrors={fieldErrors}
      />

      <MediaPickerSheet
        open={mediaPickerMode !== null}
        onOpenChange={(o) => !o && setMediaPickerMode(null)}
        handle={handle}
        selectedMediaId={
          mediaPickerMode?.kind === "featured"
            ? featuredMediaId
            : mediaPickerMode?.kind === "seo_og"
              ? (seo.ogImageMediaId ?? null)
              : null
        }
        canUpload={permissions.canUploadMedia}
        onSelect={(item) => {
          if (mediaPickerMode?.kind === "featured") {
            setFeaturedMediaId(item.id);
            markDirty();
          } else if (mediaPickerMode?.kind === "seo_og") {
            setSeo((prev) => ({ ...prev, ogImageMediaId: item.id }));
            setSeoDirty(true);
            markDirty();
          } else if (mediaPickerMode?.kind === "inline") {
            mediaPickerMode.onPick(item);
          }
          setMediaPickerMode(null);
        }}
      />

      <ConfirmDestructiveDialog
        open={trashOpen}
        onOpenChange={setTrashOpen}
        title={`Pindahkan "${title || "artikel ini"}" ke Sampah?`}
        description="Artikel akan ditarik dari blog publik jika sedang terbit dan dipindahkan ke tab Sampah."
        confirmLabel="Pindahkan ke Sampah"
        busy={submitting}
        onConfirm={handleConfirmTrash}
      />
    </form>
  );
}

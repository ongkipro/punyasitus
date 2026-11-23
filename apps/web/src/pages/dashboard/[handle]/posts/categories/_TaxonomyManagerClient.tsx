import { useCallback, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { CatalogOfferingType } from "@punyasitus/core/catalog/index";
import {
  buildTaxonomyTree,
  getEligibleParentIds,
  getTaxonomyPublicBasePath,
  hasUsefulTaxonomyIntro,
  MAX_TAXONOMY_DEPTH,
  MIN_USEFUL_TAXONOMY_INTRO_CHARS,
  OFFERING_TYPE_LABELS,
  OFFERING_TYPES,
  type TaxonomyKind,
} from "@punyasitus/core/taxonomy/index";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FolderTreeIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  TagIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  fieldErrorsToMap,
  InlineFieldError,
  LockedTenantBanner,
  slugifyClient,
  StaleWriteRecoveryBanner,
} from "@/components/admin/editor/cms-client-helpers";
import type { CmsAdminPermissions } from "@/components/admin/editor/cms-server-context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface TaxonomyItemDto {
  readonly id: number;
  readonly kind: TaxonomyKind;
  readonly offeringType: CatalogOfferingType | null;
  readonly name: string;
  readonly slug: string;
  readonly publicPath: string;
  readonly description: string | null;
  readonly parentId: number | null;
  readonly depth: number;
  readonly sortOrder: number;
  readonly publishedCount: number;
  readonly draftCount: number;
  readonly totalUsageCount: number;
  readonly childCount: number;
  readonly indexOptIn: boolean;
  readonly hasUsefulIntro: boolean;
  readonly indexable: boolean;
  readonly version: number;
  readonly updatedAt: string;
}

interface TaxonomyListApiResponse {
  readonly items: readonly TaxonomyItemDto[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

export interface TaxonomyManagerClientProps {
  readonly mode: TaxonomyKind;
  readonly handle: string;
  readonly basePath: string;
  readonly publicSiteHref: string;
  readonly permissions: CmsAdminPermissions;
  readonly canManageTaxonomy: boolean;
  readonly initialItems: readonly TaxonomyItemDto[];
  readonly initialOfferingType?: CatalogOfferingType;
}

function getEndpointBase(handle: string, mode: TaxonomyKind): string {
  const encoded = encodeURIComponent(handle);
  return mode === "post_tag"
    ? `/api/tenants/${encoded}/tags`
    : `/api/tenants/${encoded}/categories`;
}

function getContentUnitLabel(mode: TaxonomyKind): string {
  return mode === "offering_category" ? "penawaran" : "artikel";
}

function getKindTitle(mode: TaxonomyKind): string {
  switch (mode) {
    case "post_category":
      return "Kategori Blog";
    case "post_tag":
      return "Tag Blog";
    case "offering_category":
      return "Kategori Katalog";
  }
}

export function TaxonomyManagerClient({
  mode,
  handle,
  basePath,
  publicSiteHref,
  permissions,
  canManageTaxonomy,
  initialItems,
  initialOfferingType = "service",
}: TaxonomyManagerClientProps) {
  const isHierarchical = mode !== "post_tag";
  const isCatalog = mode === "offering_category";
  const contentUnit = getContentUnitLabel(mode);
  const canEdit = canManageTaxonomy && !permissions.isLocked;

  const [items, setItems] = useState<readonly TaxonomyItemDto[]>(initialItems);
  const [activeOfferingType, setActiveOfferingType] =
    useState<CatalogOfferingType>(initialOfferingType);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  // Form state (create or edit)
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingVersion, setEditingVersion] = useState<number>(1);
  const [editingOriginalSlug, setEditingOriginalSlug] = useState<string>("");
  const [editingPublishedCount, setEditingPublishedCount] = useState<number>(0);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [parentId, setParentId] = useState<string>("");
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState<string>("0");
  const [indexOptIn, setIndexOptIn] = useState(false);

  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [staleConflict, setStaleConflict] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    readonly tone: "success" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);

  // Safe delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<TaxonomyItemDto | null>(null);
  const [deleteStrategy, setDeleteStrategy] = useState<"reassign" | "detach">("reassign");
  const [reassignTargetId, setReassignTargetId] = useState<string>("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Scope items to active offeringType tab when managing catalog categories
  const scopedItems = useMemo(() => {
    if (!isCatalog) return items;
    return items.filter(
      (it) => it.offeringType === activeOfferingType || it.offeringType === null,
    );
  }, [items, isCatalog, activeOfferingType]);

  const countByOfferingType = useMemo(() => {
    const counts: Record<CatalogOfferingType, number> = {
      service: 0,
      product: 0,
      tour: 0,
      vehicle: 0,
    };
    if (!isCatalog) return counts;
    for (const it of items) {
      if (it.offeringType && it.offeringType in counts) {
        counts[it.offeringType] += 1;
      } else {
        for (const t of OFFERING_TYPES) counts[t] += 1;
      }
    }
    return counts;
  }, [items, isCatalog]);

  const treeData = useMemo(() => buildTaxonomyTree(scopedItems), [scopedItems]);

  const visibleNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return treeData.flattened;
    return treeData.flattened.filter(
      (node) =>
        node.item.name.toLowerCase().includes(q) ||
        node.item.slug.toLowerCase().includes(q) ||
        (node.item.description ?? "").toLowerCase().includes(q),
    );
  }, [treeData.flattened, search]);

  const eligibleParentIds = useMemo(
    () =>
      getEligibleParentIds(scopedItems, {
        kind: mode,
        offeringType: isCatalog ? activeOfferingType : null,
        selfId: editingId,
      }),
    [scopedItems, mode, isCatalog, activeOfferingType, editingId],
  );

  const parentOptions = useMemo(
    () => treeData.flattened.filter((node) => eligibleParentIds.has(node.item.id)),
    [treeData.flattened, eligibleParentIds],
  );

  const reassignOptions = useMemo(() => {
    if (!deleteTarget) return [];
    return scopedItems.filter(
      (it) =>
        it.id !== deleteTarget.id &&
        it.kind === deleteTarget.kind &&
        (!isCatalog ||
          deleteTarget.offeringType === null ||
          it.offeringType === null ||
          it.offeringType === deleteTarget.offeringType),
    );
  }, [deleteTarget, scopedItems, isCatalog]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setEditingVersion(1);
    setEditingOriginalSlug("");
    setEditingPublishedCount(0);
    setName("");
    setSlug("");
    setSlugTouched(false);
    setParentId("");
    setDescription("");
    setSortOrder("0");
    setIndexOptIn(false);
    setFieldErrors({});
  }, []);

  const reloadItems = useCallback(async () => {
    setLoading(true);
    try {
      const base = getEndpointBase(handle, mode);
      const params = new URLSearchParams({ limit: "100", sortOrder: "asc" });
      if (mode === "offering_category") {
        params.set("kind", "offering_category");
      } else if (mode === "post_category") {
        params.set("kind", "post_category");
      }
      const res = await cmsFetchJson<TaxonomyListApiResponse>(`${base}?${params.toString()}`);
      setItems(res.items);
      setStaleConflict(null);
      if (editingId !== null) {
        const refreshed = res.items.find((it) => it.id === editingId);
        if (refreshed) {
          setEditingVersion(refreshed.version);
          setEditingOriginalSlug(refreshed.slug);
          setEditingPublishedCount(refreshed.publishedCount);
          setName(refreshed.name);
          setSlug(refreshed.slug);
          setSlugTouched(true);
          setParentId(refreshed.parentId !== null ? String(refreshed.parentId) : "");
          setDescription(refreshed.description ?? "");
          setSortOrder(String(refreshed.sortOrder));
          setIndexOptIn(refreshed.indexOptIn);
        } else {
          resetForm();
        }
      }
    } catch (err) {
      setFeedback({
        tone: "destructive",
        title: "Gagal memuat daftar taksonomi",
        message: err instanceof Error ? err.message : "Terjadi kesalahan saat menyegarkan data.",
      });
    } finally {
      setLoading(false);
    }
  }, [handle, mode, editingId, resetForm]);

  function startEdit(item: TaxonomyItemDto) {
    setEditingId(item.id);
    setEditingVersion(item.version);
    setEditingOriginalSlug(item.slug);
    setEditingPublishedCount(item.publishedCount);
    setName(item.name);
    setSlug(item.slug);
    setSlugTouched(true);
    setParentId(item.parentId !== null ? String(item.parentId) : "");
    setDescription(item.description ?? "");
    setSortOrder(String(item.sortOrder));
    setIndexOptIn(item.indexOptIn);
    setFieldErrors({});
    setStaleConflict(null);
    setFeedback(null);
    nameInputRef.current?.focus();
  }

  function openDeleteDialog(item: TaxonomyItemDto) {
    setDeleteTarget(item);
    setDeleteError(null);
    const candidates = scopedItems.filter(
      (it) =>
        it.id !== item.id &&
        it.kind === item.kind &&
        (!isCatalog ||
          item.offeringType === null ||
          it.offeringType === null ||
          it.offeringType === item.offeringType),
    );
    if (item.totalUsageCount > 0 && candidates.length > 0) {
      setDeleteStrategy("reassign");
      setReassignTargetId(String(candidates[0]!.id));
    } else {
      setDeleteStrategy("detach");
      setReassignTargetId("");
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || saving) return;

    setSaving(true);
    setFieldErrors({});
    setStaleConflict(null);
    setFeedback(null);

    const parsedSort = Number.parseInt(sortOrder, 10);
    const cleanSort = Number.isFinite(parsedSort) && parsedSort >= 0 ? parsedSort : 0;
    const trimmedSlug = slug.trim();
    const base = getEndpointBase(handle, mode);

    try {
      if (editingId === null) {
        const payload: Record<string, unknown> = {
          kind: mode,
          name: name.trim(),
          description: description.trim() || null,
          sortOrder: cleanSort,
          indexOptIn,
        };
        if (trimmedSlug) payload.slug = trimmedSlug;
        if (isHierarchical) {
          payload.parentId = parentId ? Number(parentId) : null;
        }
        if (isCatalog) {
          payload.offeringType = activeOfferingType;
        }

        const created = await cmsFetchJson<TaxonomyItemDto>(base, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setItems((prev) => [...prev, created]);
        resetForm();
        setFeedback({
          tone: "success",
          title: `${getKindTitle(mode)} ditambahkan`,
          message: `"${created.name}" berhasil disimpan dengan slug /${created.slug}.`,
        });
      } else {
        const payload: Record<string, unknown> = {
          version: editingVersion,
          name: name.trim(),
          description: description.trim() || null,
          sortOrder: cleanSort,
          indexOptIn,
        };
        if (trimmedSlug) {
          payload.slug = trimmedSlug;
          if (trimmedSlug !== editingOriginalSlug) {
            payload.confirmSlugChange = true;
          }
        }
        if (isHierarchical) {
          payload.parentId = parentId ? Number(parentId) : null;
        }

        const updated = await cmsFetchJson<TaxonomyItemDto>(`${base}/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });

        await reloadItems();
        resetForm();
        setFeedback({
          tone: "success",
          title: `${getKindTitle(mode)} diperbarui`,
          message: `Perubahan pada "${updated.name}" telah diterapkan.`,
        });
      }
    } catch (err) {
      if (err instanceof CmsApiError) {
        if (err.isStaleVersion) {
          setStaleConflict(err.message);
        } else {
          setFieldErrors(fieldErrorsToMap(err.fields));
          setFeedback({
            tone: "destructive",
            title: err.code === "TAXONOMY_CYCLE_OR_DEPTH" ? "Batas hierarki ditolak" : "Gagal menyimpan",
            message: err.message,
          });
        }
      } else {
        setFeedback({
          tone: "destructive",
          title: "Gagal menyimpan",
          message: err instanceof Error ? err.message : "Terjadi kesalahan tak terduga.",
        });
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget || !canEdit || deleting) return;
    if (deleteTarget.childCount > 0) return;

    setDeleting(true);
    setDeleteError(null);
    const base = getEndpointBase(handle, mode);

    const payload: Record<string, unknown> = {
      version: deleteTarget.version,
    };

    if (deleteTarget.totalUsageCount > 0) {
      if (deleteStrategy === "reassign") {
        if (!reassignTargetId) {
          setDeleteError("Pilih taksonomi pengganti terlebih dahulu.");
          setDeleting(false);
          return;
        }
        payload.reassignToId = Number(reassignTargetId);
      } else {
        payload.detach = true;
      }
    }

    try {
      await cmsFetchJson<void>(`${base}/${deleteTarget.id}`, {
        method: "DELETE",
        body: JSON.stringify(payload),
      });
      const deletedName = deleteTarget.name;
      const wasReassigned = deleteTarget.totalUsageCount > 0 && deleteStrategy === "reassign";
      const wasDetached = deleteTarget.totalUsageCount > 0 && deleteStrategy === "detach";
      if (editingId === deleteTarget.id) {
        resetForm();
      }
      setDeleteTarget(null);
      await reloadItems();
      setFeedback({
        tone: "success",
        title: `${getKindTitle(mode)} dihapus`,
        message: wasReassigned
          ? `"${deletedName}" dihapus dan seluruh ${contentUnit} dipindahkan tanpa kehilangan konten.`
          : wasDetached
            ? `"${deletedName}" dihapus dan dilepaskan dari ${contentUnit} terkait tanpa menghapus konten.`
            : `"${deletedName}" berhasil dihapus.`,
      });
    } catch (err) {
      if (err instanceof CmsApiError) {
        if (err.isStaleVersion) {
          setDeleteTarget(null);
          setStaleConflict(err.message);
        } else {
          setDeleteError(err.message);
        }
      } else {
        setDeleteError(err instanceof Error ? err.message : "Gagal menghapus taksonomi.");
      }
    } finally {
      setDeleting(false);
    }
  }

  const slugPreview = slug.trim() || (name.trim() ? slugifyClient(name) : "slug-otomatis");
  const previewPath = getTaxonomyPublicBasePath(
    mode,
    slugPreview,
    isCatalog ? activeOfferingType : null,
  );
  const introReady = hasUsefulTaxonomyIntro(description);
  const showSlugRedirectWarning =
    editingId !== null &&
    editingPublishedCount > 0 &&
    slug.trim() !== "" &&
    slug.trim() !== editingOriginalSlug;

  return (
    <div className="space-y-5" data-testid={`taxonomy-manager-${mode}`}>
      {/* Header & sub-navigation */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              {getKindTitle(mode)}
            </h1>
            <Badge variant="outline" data-testid="taxonomy-role-badge">
              {permissions.roleLabel}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "post_category"
              ? `Kelola struktur kategori artikel hingga ${MAX_TAXONOMY_DEPTH} tingkat kedalaman beserta arsip publiknya.`
              : mode === "post_tag"
                ? "Kelola tag datar (flat) untuk mengelompokkan topik lintas artikel blog."
                : `Kelola kategori katalog terpisah per tipe penawaran hingga ${MAX_TAXONOMY_DEPTH} tingkat kedalaman.`}
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void reloadItems()}
          className="min-h-11 shrink-0 self-start"
          data-testid="taxonomy-refresh-btn"
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          {loading ? "Menyegarkan..." : "Segarkan"}
        </Button>
      </div>

      {/* Sub-navigation bar */}
      <nav
        aria-label={isCatalog ? "Navigasi Katalog" : "Navigasi Blog"}
        className="flex flex-wrap items-center gap-2 border-b border-border pb-3"
      >
        {isCatalog ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11"
              render={<a href={`${basePath}/catalog`} />}
            >
              Daftar Katalog
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="min-h-11"
              aria-current="page"
              render={<a href={`${basePath}/catalog/categories`} />}
            >
              <FolderTreeIcon className="size-4" aria-hidden="true" />
              Kategori Katalog
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11"
              render={<a href={`${basePath}/posts`} />}
            >
              Semua Artikel
            </Button>
            <Button
              variant={mode === "post_category" ? "secondary" : "ghost"}
              size="sm"
              className="min-h-11"
              aria-current={mode === "post_category" ? "page" : undefined}
              render={<a href={`${basePath}/posts/categories`} />}
            >
              <FolderTreeIcon className="size-4" aria-hidden="true" />
              Kategori
            </Button>
            <Button
              variant={mode === "post_tag" ? "secondary" : "ghost"}
              size="sm"
              className="min-h-11"
              aria-current={mode === "post_tag" ? "page" : undefined}
              render={<a href={`${basePath}/posts/tags`} />}
            >
              <TagIcon className="size-4" aria-hidden="true" />
              Tag
            </Button>
          </>
        )}
      </nav>

      {/* Offering-type tabs for Catalog Categories */}
      {isCatalog && (
        <div
          role="tablist"
          aria-label="Filter tipe katalog"
          className="flex flex-wrap gap-2"
          data-testid="catalog-offering-type-tabs"
        >
          {OFFERING_TYPES.map((type) => {
            const selected = activeOfferingType === type;
            return (
              <button
                key={type}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`offering-tab-${type}`}
                onClick={() => {
                  setActiveOfferingType(type);
                  resetForm();
                }}
                className={`inline-flex min-h-11 items-center gap-2 rounded-md border px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-foreground hover:bg-muted"
                }`}
              >
                <span>{OFFERING_TYPE_LABELS[type]}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    selected
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {countByOfferingType[type]}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/billing`} />}

      {!permissions.isLocked && !canManageTaxonomy && (
        <Alert variant="warning" data-testid="taxonomy-readonly-alert">
          <AlertTriangleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode baca saja</AlertTitle>
          <AlertDescription>
            Peran akun Anda tidak memiliki izin untuk mengubah kategori atau tag.
          </AlertDescription>
        </Alert>
      )}

      {/* Live metadata impact notice (PLAN §11.3) */}
      <Alert data-testid="taxonomy-live-impact-notice">
        <InfoIcon className="size-4" aria-hidden="true" />
        <AlertTitle>Perubahan metadata berlaku langsung</AlertTitle>
        <AlertDescription>
          Perubahan nama, deskripsi, atau slug berlaku langsung pada arsip publik tanpa menerbitkan
          isi draf {contentUnit}. Arsip kategori &amp; tag berstatus <strong>noindex</strong> secara
          bawaan sampai Anda mengaktifkan indeks disertai deskripsi pengantar dan konten terbit.
        </AlertDescription>
      </Alert>

      {staleConflict && (
        <StaleWriteRecoveryBanner
          message={staleConflict}
          reloading={loading}
          onReloadLatest={reloadItems}
          onDismiss={() => setStaleConflict(null)}
        />
      )}

      {feedback && (
        <Alert
          variant={feedback.tone === "destructive" ? "destructive" : "success"}
          data-testid="taxonomy-feedback-alert"
        >
          {feedback.tone === "success" ? (
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
          ) : (
            <AlertTriangleIcon className="size-4" aria-hidden="true" />
          )}
          <AlertTitle>{feedback.title}</AlertTitle>
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      )}

      {/* Main Responsive Grid: Form (left) + List/Tree (right) */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,370px)_minmax(0,1fr)]">
        {/* Create / Edit Form */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">
              {editingId === null
                ? `Tambah ${getKindTitle(mode)}${isCatalog ? ` (${OFFERING_TYPE_LABELS[activeOfferingType]})` : ""}`
                : `Edit ${getKindTitle(mode)} #${editingId}`}
            </CardTitle>
            <CardDescription>
              {editingId === null
                ? "Slug dibuat otomatis dari nama dan dapat disesuaikan."
                : `Versi saat ini: v${editingVersion}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <label htmlFor="taxonomy-name" className="text-sm font-medium text-foreground">
                  Nama <span className="text-destructive">*</span>
                </label>
                <Input
                  ref={nameInputRef}
                  id="taxonomy-name"
                  name="name"
                  value={name}
                  disabled={!canEdit || saving}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setName(nextVal);
                    if (!slugTouched && editingId === null) {
                      setSlug(slugifyClient(nextVal));
                    }
                  }}
                  placeholder={
                    mode === "post_tag"
                      ? "Contoh: Promo UMKM"
                      : isCatalog
                        ? `Contoh: ${OFFERING_TYPE_LABELS[activeOfferingType]} Unggulan`
                        : "Contoh: Panduan Bisnis"
                  }
                  maxLength={100}
                  required
                  className="min-h-11"
                  aria-invalid={Boolean(fieldErrors.name)}
                  data-testid="taxonomy-name-input"
                />
                <InlineFieldError message={fieldErrors.name} />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="taxonomy-slug" className="text-sm font-medium text-foreground">
                  Slug URL
                </label>
                <Input
                  id="taxonomy-slug"
                  name="slug"
                  value={slug}
                  disabled={!canEdit || saving}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value);
                  }}
                  placeholder="slug-otomatis-dari-nama"
                  maxLength={80}
                  className="min-h-11 font-mono text-sm"
                  aria-invalid={Boolean(fieldErrors.slug)}
                  data-testid="taxonomy-slug-input"
                />
                <p className="break-all text-xs text-muted-foreground">
                  Arsip publik: <code className="font-mono text-foreground">{previewPath}</code>
                </p>
                {showSlugRedirectWarning && (
                  <p
                    role="status"
                    className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                    data-testid="taxonomy-slug-308-warning"
                  >
                    Mengubah slug akan mengarahkan URL lama secara permanen (HTTP 308) ke URL baru.
                  </p>
                )}
                <InlineFieldError message={fieldErrors.slug} />
              </div>

              {isHierarchical && (
                <div className="space-y-1.5">
                  <label htmlFor="taxonomy-parent" className="text-sm font-medium text-foreground">
                    Kategori Induk (maksimal {MAX_TAXONOMY_DEPTH} tingkat)
                  </label>
                  <select
                    id="taxonomy-parent"
                    name="parentId"
                    value={parentId}
                    disabled={!canEdit || saving}
                    onChange={(e) => setParentId(e.target.value)}
                    className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="taxonomy-parent-select"
                  >
                    <option value="">Tanpa induk (Tingkat 1)</option>
                    {parentOptions.map((node) => (
                      <option key={node.item.id} value={String(node.item.id)}>
                        {"— ".repeat(Math.max(0, node.depth - 1))}
                        {node.item.name} (Tingkat {node.depth})
                      </option>
                    ))}
                  </select>
                  <InlineFieldError message={fieldErrors.parentId} />
                </div>
              )}

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="taxonomy-description"
                    className="text-sm font-medium text-foreground"
                  >
                    Deskripsi Pengantar
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {description.trim().length}/500
                  </span>
                </div>
                <textarea
                  id="taxonomy-description"
                  name="description"
                  rows={3}
                  value={description}
                  disabled={!canEdit || saving}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                  placeholder={`Ringkasan singkat isi arsip ${getKindTitle(mode).toLowerCase()} (minimal ${MIN_USEFUL_TAXONOMY_INTRO_CHARS} karakter agar layak indeks).`}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="taxonomy-description-input"
                />
                <InlineFieldError message={fieldErrors.description} />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor="taxonomy-sort-order"
                    className="text-sm font-medium text-foreground"
                  >
                    Urutan Tampilan
                  </label>
                  <Input
                    id="taxonomy-sort-order"
                    name="sortOrder"
                    type="number"
                    min={0}
                    max={10000}
                    value={sortOrder}
                    disabled={!canEdit || saving}
                    onChange={(e) => setSortOrder(e.target.value)}
                    className="min-h-11"
                    data-testid="taxonomy-sort-input"
                  />
                  <InlineFieldError message={fieldErrors.sortOrder} />
                </div>

                <div className="flex items-end">
                  <label
                    htmlFor="taxonomy-index-opt-in"
                    className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground"
                  >
                    <input
                      id="taxonomy-index-opt-in"
                      type="checkbox"
                      checked={indexOptIn}
                      disabled={!canEdit || saving}
                      onChange={(e) => setIndexOptIn(e.target.checked)}
                      className="size-4 rounded border-input accent-primary"
                      data-testid="taxonomy-index-opt-in-checkbox"
                    />
                    <span className="leading-tight">Izinkan indeks SEO</span>
                  </label>
                </div>
              </div>

              {indexOptIn && !introReady && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Deskripsi pengantar minimal {MIN_USEFUL_TAXONOMY_INTRO_CHARS} karakter diperlukan
                  agar arsip tidak otomatis <code>noindex</code>.
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="submit"
                  disabled={!canEdit || saving || !name.trim()}
                  className="min-h-11 flex-1"
                  data-testid="taxonomy-submit-btn"
                >
                  {editingId === null ? (
                    <PlusIcon className="size-4" aria-hidden="true" />
                  ) : (
                    <CheckCircle2Icon className="size-4" aria-hidden="true" />
                  )}
                  {saving
                    ? "Menyimpan..."
                    : editingId === null
                      ? `Simpan ${getKindTitle(mode)}`
                      : "Simpan Perubahan"}
                </Button>
                {editingId !== null && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saving}
                    onClick={resetForm}
                    className="min-h-11"
                    data-testid="taxonomy-cancel-edit-btn"
                  >
                    Batal
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Search + Tree/Flat List */}
        <Card className="min-w-0">
          <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <CardTitle className="text-base">
                Daftar {getKindTitle(mode)} ({visibleNodes.length})
              </CardTitle>
              <CardDescription>
                Menampilkan jumlah konten terbit dan draf (hanya terlihat oleh tim editor).
              </CardDescription>
            </div>
            <div className="relative w-full sm:w-64">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari nama atau slug..."
                aria-label={`Cari ${getKindTitle(mode).toLowerCase()}`}
                className="min-h-11 pl-9"
                data-testid="taxonomy-search-input"
              />
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {visibleNodes.length === 0 ? (
              <div
                className="px-6 py-10 text-center text-sm text-muted-foreground"
                data-testid="taxonomy-list-empty"
              >
                {search.trim()
                  ? `Tidak ada ${getKindTitle(mode).toLowerCase()} yang cocok dengan "${search.trim()}".`
                  : `Belum ada ${getKindTitle(mode).toLowerCase()}. Tambahkan melalui formulir di samping.`}
              </div>
            ) : (
              <ul
                className="divide-y divide-border"
                data-testid="taxonomy-list"
                aria-label={`Daftar ${getKindTitle(mode)}`}
              >
                {visibleNodes.map((node) => {
                  const item = node.item;
                  const indentClass =
                    !isHierarchical || node.depth <= 1
                      ? ""
                      : node.depth === 2
                        ? "pl-5 sm:pl-7 border-l-2 border-primary/25 ml-2"
                        : "pl-8 sm:pl-12 border-l-2 border-primary/40 ml-4";
                  const publicHref = `${publicSiteHref.replace(/\/+$/, "")}${item.publicPath}`;

                  return (
                    <li
                      key={item.id}
                      data-testid={`taxonomy-row-${item.id}`}
                      data-taxonomy-slug={item.slug}
                      data-taxonomy-depth={node.depth}
                      className={`px-4 py-3.5 transition-colors hover:bg-muted/30 sm:px-5 ${
                        editingId === item.id ? "bg-primary/5" : ""
                      }`}
                    >
                      <div className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${indentClass}`}>
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-foreground break-words">
                              {item.name}
                            </span>
                            {isHierarchical && (
                              <Badge variant="outline" data-testid={`depth-badge-${item.id}`}>
                                Tingkat {node.depth}
                              </Badge>
                            )}
                            {item.indexable ? (
                              <Badge variant="success">Terindeks</Badge>
                            ) : (
                              <Badge variant="secondary">Noindex</Badge>
                            )}
                          </div>

                          <p className="break-all font-mono text-xs text-muted-foreground">
                            {item.publicPath}
                          </p>

                          {item.description && (
                            <p className="line-clamp-2 text-xs text-muted-foreground">
                              {item.description}
                            </p>
                          )}

                          <div
                            className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs"
                            data-testid={`usage-counts-${item.id}`}
                          >
                            <Badge variant="secondary">
                              {item.publishedCount} terbit
                            </Badge>
                            {item.draftCount > 0 && (
                              <Badge variant="warning">{item.draftCount} draf</Badge>
                            )}
                            {isHierarchical && item.childCount > 0 && (
                              <Badge variant="outline">{item.childCount} sub-kategori</Badge>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="min-h-11 min-w-11"
                            aria-label={`Buka arsip publik ${item.name}`}
                            render={
                              <a
                                href={publicHref}
                                target="_blank"
                                rel="noopener noreferrer"
                              />
                            }
                          >
                            <ExternalLinkIcon className="size-4" aria-hidden="true" />
                            <span className="sr-only sm:not-sr-only">Arsip</span>
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!canEdit}
                            onClick={() => startEdit(item)}
                            className="min-h-11 min-w-11"
                            data-testid={`edit-taxonomy-${item.id}`}
                          >
                            <PencilIcon className="size-4" aria-hidden="true" />
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={!canEdit}
                            onClick={() => openDeleteDialog(item)}
                            className="min-h-11 min-w-11"
                            data-testid={`delete-taxonomy-${item.id}`}
                          >
                            <Trash2Icon className="size-4" aria-hidden="true" />
                            Hapus
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Safe Deletion & Reassign/Detach Dialog (Base UI, zero Radix) */}
      <DialogPrimitive.Root
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-[70] bg-foreground/40 transition-opacity duration-150" />
          <DialogPrimitive.Popup
            data-testid="taxonomy-delete-dialog"
            className="fixed top-1/2 left-1/2 z-[75] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-foreground shadow-lg"
          >
            {deleteTarget && (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 text-destructive">
                    <Trash2Icon className="size-5 shrink-0" aria-hidden="true" />
                    <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                      Hapus &ldquo;{deleteTarget.name}&rdquo;?
                    </DialogPrimitive.Title>
                  </div>
                  <DialogPrimitive.Close
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Tutup dialog hapus"
                        className="min-h-11 min-w-11"
                      />
                    }
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </DialogPrimitive.Close>
                </div>

                {deleteTarget.childCount > 0 ? (
                  <div className="mt-3 space-y-3" data-testid="delete-blocked-children">
                    <DialogPrimitive.Description className="text-sm leading-relaxed text-muted-foreground">
                      Kategori ini masih memiliki{" "}
                      <strong>{deleteTarget.childCount} sub-kategori</strong>. Pindahkan seluruh
                      sub-kategori ke induk lain terlebih dahulu. Menghapus kategori induk tidak
                      pernah menghapus sub-kategori atau konten secara otomatis.
                    </DialogPrimitive.Description>
                    <div className="flex justify-end pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setDeleteTarget(null)}
                        className="min-h-11"
                      >
                        Mengerti
                      </Button>
                    </div>
                  </div>
                ) : deleteTarget.totalUsageCount > 0 ? (
                  <div className="mt-3 space-y-4" data-testid="delete-in-use-options">
                    <DialogPrimitive.Description className="text-sm leading-relaxed text-muted-foreground">
                      Taksonomi ini masih digunakan oleh{" "}
                      <strong>
                        {deleteTarget.totalUsageCount} {contentUnit}
                      </strong>{" "}
                      ({deleteTarget.publishedCount} terbit, {deleteTarget.draftCount} draf). Pilih
                      tindakan agar seluruh {contentUnit} tetap aman dan tidak hilang:
                    </DialogPrimitive.Description>

                    <div className="space-y-2.5" role="radiogroup" aria-label="Pilihan pengalihan konten">
                      {reassignOptions.length > 0 && (
                        <div className="rounded-md border border-border p-3">
                          <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-sm font-medium text-foreground">
                            <input
                              type="radio"
                              name="deleteStrategy"
                              value="reassign"
                              checked={deleteStrategy === "reassign"}
                              onChange={() => setDeleteStrategy("reassign")}
                              className="mt-1 size-4 accent-primary"
                              data-testid="delete-strategy-reassign"
                            />
                            <span>
                              Pindahkan semua {contentUnit} ke {getKindTitle(mode).toLowerCase()} lain
                            </span>
                          </label>

                          {deleteStrategy === "reassign" && (
                            <div className="mt-2 pl-6">
                              <label
                                htmlFor="reassign-target-select"
                                className="mb-1 block text-xs text-muted-foreground"
                              >
                                Pilih pengganti:
                              </label>
                              <select
                                id="reassign-target-select"
                                value={reassignTargetId}
                                onChange={(e) => setReassignTargetId(e.target.value)}
                                className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                                data-testid="delete-reassign-select"
                              >
                                {reassignOptions.map((opt) => (
                                  <option key={opt.id} value={String(opt.id)}>
                                    {opt.name} (/{opt.slug})
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="rounded-md border border-border p-3">
                        <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-sm font-medium text-foreground">
                          <input
                            type="radio"
                            name="deleteStrategy"
                            value="detach"
                            checked={deleteStrategy === "detach"}
                            onChange={() => setDeleteStrategy("detach")}
                            className="mt-1 size-4 accent-primary"
                            data-testid="delete-strategy-detach"
                          />
                          <span>
                            Lepaskan dari semua {contentUnit} (konten tetap aman tanpa terhapus)
                          </span>
                        </label>
                      </div>
                    </div>

                    {deleteError && <InlineFieldError message={deleteError} />}

                    <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={deleting}
                        onClick={() => setDeleteTarget(null)}
                        className="min-h-11"
                        data-testid="taxonomy-delete-cancel"
                      >
                        Batal
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={
                          deleting ||
                          (deleteStrategy === "reassign" && !reassignTargetId)
                        }
                        onClick={() => void handleConfirmDelete()}
                        className="min-h-11"
                        data-testid="taxonomy-delete-confirm"
                      >
                        {deleting
                          ? "Memproses..."
                          : deleteStrategy === "reassign"
                            ? "Pindahkan & Hapus"
                            : "Lepaskan & Hapus"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 space-y-4" data-testid="delete-unused-confirm">
                    <DialogPrimitive.Description className="text-sm leading-relaxed text-muted-foreground">
                      Taksonomi ini belum digunakan oleh {contentUnit} mana pun. Tindakan penghapusan
                      tidak dapat dibatalkan.
                    </DialogPrimitive.Description>

                    {deleteError && <InlineFieldError message={deleteError} />}

                    <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={deleting}
                        onClick={() => setDeleteTarget(null)}
                        className="min-h-11"
                        data-testid="taxonomy-delete-cancel"
                      >
                        Batal
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={deleting}
                        onClick={() => void handleConfirmDelete()}
                        className="min-h-11"
                        data-testid="taxonomy-delete-confirm"
                      >
                        {deleting ? "Menghapus..." : "Hapus Permanen"}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}

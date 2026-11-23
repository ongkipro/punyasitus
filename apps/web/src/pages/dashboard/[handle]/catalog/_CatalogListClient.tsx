import { useCallback, useState } from "react";
import type { CatalogOfferingType, CatalogPriceMode } from "@punyasitus/core/catalog/index";
import {
  BriefcaseIcon,
  EyeIcon,
  GlobeIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  ConfirmDestructiveDialog,
  ContentStatusBadge,
  formatDateTimeId,
  formatIdr,
  LockedTenantBanner,
} from "@/components/admin/editor/cms-client-helpers";
import type { CmsAdminPermissions } from "@/components/admin/editor/cms-server-context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface CatalogListItemDto {
  readonly id: number;
  readonly offeringType: CatalogOfferingType;
  readonly slug: string;
  readonly publicPath: string;
  readonly title: string;
  readonly status: "draft" | "published" | "trashed";
  readonly priceMode: CatalogPriceMode;
  readonly price: number | null;
  readonly priceMax: number | null;
  readonly negotiable: boolean;
  readonly ctaMode: string;
  readonly unitStatus: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

interface CatalogListApiResponse {
  readonly items: readonly CatalogListItemDto[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

export interface CatalogListClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly offeringLabel: string;
  readonly permissions: CmsAdminPermissions;
  readonly initialItems: readonly CatalogListItemDto[];
  readonly initialNextCursor: string | null;
  readonly initialHasMore: boolean;
}

const OFFERING_TYPE_TABS = [
  { id: "all", label: "Semua Tipe" },
  { id: "service", label: "Layanan" },
  { id: "product", label: "Produk" },
  { id: "tour", label: "Paket Tur" },
  { id: "vehicle", label: "Kendaraan" },
] as const;

const OFFERING_TYPE_LABEL: Record<CatalogOfferingType, string> = {
  service: "Layanan",
  product: "Produk",
  tour: "Paket Tur",
  vehicle: "Kendaraan",
};

function formatPriceCell(item: CatalogListItemDto): string {
  if (item.priceMode === "on_request") return "Hubungi kami";
  if (item.priceMode === "range") {
    return `${formatIdr(item.price)} – ${formatIdr(item.priceMax)}`;
  }
  if (item.priceMode === "from") {
    return `Mulai ${formatIdr(item.price)}`;
  }
  return `${formatIdr(item.price)}${item.negotiable ? " (Nego)" : ""}`;
}

export function CatalogListClient({
  handle,
  basePath,
  offeringLabel,
  permissions,
  initialItems,
  initialNextCursor,
  initialHasMore,
}: CatalogListClientProps) {
  const [items, setItems] = useState<readonly CatalogListItemDto[]>(initialItems);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);

  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [trashTarget, setTrashTarget] = useState<CatalogListItemDto | null>(null);
  const [feedback, setFeedback] = useState<{
    readonly tone: "success" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);

  const loadCatalog = useCallback(
    async (opts?: {
      readonly offeringType?: string;
      readonly status?: string;
      readonly cursor?: string | null;
      readonly append?: boolean;
    }) => {
      setLoading(true);
      try {
        const activeType = opts?.offeringType ?? typeFilter;
        const activeStatus = opts?.status ?? statusFilter;
        const params = new URLSearchParams({ limit: "20" });
        if (activeType !== "all") params.set("offeringType", activeType);
        if (activeStatus) params.set("status", activeStatus);
        if (opts?.cursor) params.set("cursor", opts.cursor);

        const res = await cmsFetchJson<CatalogListApiResponse>(
          `/api/tenants/${encodeURIComponent(handle)}/catalog?${params.toString()}`,
        );
        setItems((prev) => (opts?.append ? [...prev, ...res.items] : res.items));
        setNextCursor(res.page.nextCursor);
        setHasMore(res.page.hasMore);
      } catch (err) {
        setFeedback({
          tone: "destructive",
          title: "Gagal memuat daftar katalog",
          message: err instanceof Error ? err.message : "Terjadi gangguan jaringan.",
        });
      } finally {
        setLoading(false);
      }
    },
    [handle, typeFilter, statusFilter],
  );

  async function handlePublishToggle(item: CatalogListItemDto) {
    if (!permissions.canPublishContent || busyId !== null) return;
    setBusyId(item.id);
    setFeedback(null);
    try {
      const action = item.status === "published" ? "unpublish" : "publish";
      const updated = await cmsFetchJson<CatalogListItemDto>(
        `/api/tenants/${encodeURIComponent(handle)}/catalog/${item.id}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({ version: item.version }),
        },
      );
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, ...updated } : it)));
      setFeedback({
        tone: "success",
        title: action === "publish" ? "Penawaran diterbitkan" : "Publikasi dibatalkan",
        message: `"${item.title}" berhasil diperbarui.`,
      });
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        await loadCatalog();
        setFeedback({
          tone: "destructive",
          title: "Data telah berubah, daftar dimuat ulang (409)",
          message:
            "Versi penawaran sudah diperbarui di sesi lain. Daftar telah disegarkan, silakan ulangi tindakan Anda.",
        });
      } else {
        setFeedback({
          tone: "destructive",
          title: "Gagal mengubah status penawaran",
          message: err instanceof CmsApiError ? err.message : "Silakan coba lagi.",
        });
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handleConfirmTrash() {
    if (!trashTarget || !permissions.canWriteContent) return;
    setBusyId(trashTarget.id);
    setFeedback(null);
    try {
      await cmsFetchJson(
        `/api/tenants/${encodeURIComponent(handle)}/catalog/${trashTarget.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({ version: trashTarget.version }),
        },
      );
      const removedTitle = trashTarget.title;
      setTrashTarget(null);
      setFeedback({
        tone: "success",
        title: "Penawaran dipindahkan ke Sampah",
        message: `"${removedTitle}" telah dipindahkan ke Sampah.`,
      });
      await loadCatalog();
    } catch (err) {
      setTrashTarget(null);
      if (err instanceof CmsApiError && err.isStaleVersion) {
        await loadCatalog();
        setFeedback({
          tone: "destructive",
          title: "Data telah berubah, daftar dimuat ulang (409)",
          message:
            "Versi penawaran telah berubah di sesi lain. Daftar kini menampilkan versi terbaru.",
        });
      } else {
        setFeedback({
          tone: "destructive",
          title: "Gagal menghapus penawaran",
          message: err instanceof Error ? err.message : "Terjadi kesalahan.",
        });
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handleRestore(item: CatalogListItemDto) {
    if (!permissions.canWriteContent || busyId !== null) return;
    setBusyId(item.id);
    setFeedback(null);
    try {
      await cmsFetchJson(
        `/api/tenants/${encodeURIComponent(handle)}/catalog/${item.id}/restore`,
        {
          method: "POST",
          body: JSON.stringify({ expectedVersion: item.version }),
        },
      );
      setFeedback({
        tone: "success",
        title: "Penawaran dipulihkan sebagai draf",
        message: `"${item.title}" berhasil dipulihkan dari Sampah ke daftar draf.`,
      });
      await loadCatalog();
    } catch (err) {
      if (err instanceof CmsApiError && err.code === "STALE_VERSION") {
        await loadCatalog();
        setFeedback({
          tone: "destructive",
          title: "Data telah berubah, daftar dimuat ulang (409)",
          message:
            "Versi penawaran telah berubah di sesi lain. Daftar telah disegarkan.",
        });
      } else {
        setFeedback({
          tone: "destructive",
          title: "Gagal memulihkan penawaran",
          message:
            err instanceof Error
              ? err.message
              : "Terjadi kesalahan. Buka halaman Sampah & Pemulihan untuk menyelesaikan konflik slug.",
        });
      }
    } finally {
      setBusyId(null);
    }
  }

  const filtered = items.filter((item) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return item.title.toLowerCase().includes(q) || item.slug.toLowerCase().includes(q);
  });

  const hasFilters = Boolean(search.trim() || typeFilter !== "all" || statusFilter);

  return (
    <div className="space-y-6" data-testid="catalog-list-screen">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
            Katalog {offeringLabel}
          </h1>
          <p className="text-sm text-muted-foreground">
            Kelola penawaran layanan, produk, paket tur, atau unit kendaraan dengan harga Rupiah
            transparan dan tombol WhatsApp/inquiry.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          <Button
            variant="outline"
            className="min-h-11 md:min-h-9"
            render={<a href={`${basePath}/catalog/trash`} />}
            data-testid="catalog-trash-link"
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
            Sampah &amp; Pemulihan
          </Button>
          <Button
            disabled={!permissions.canWriteContent}
            className="min-h-11 md:min-h-9"
            render={permissions.canWriteContent ? <a href={`${basePath}/catalog/new`} /> : undefined}
            data-testid="new-offering-btn"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            Tambah Penawaran
          </Button>
        </div>
      </div>

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/service-status`} />}

      {feedback && (
        <Alert variant={feedback.tone} data-testid="catalog-list-feedback">
          <AlertTitle>{feedback.title}</AlertTitle>
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="tablist"
          aria-label="Filter tipe penawaran"
          className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card p-1"
        >
          {OFFERING_TYPE_TABS.map((tab) => (
            <Button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={typeFilter === tab.id}
              size="sm"
              variant={typeFilter === tab.id ? "default" : "ghost"}
              onClick={() => {
                setTypeFilter(tab.id);
                void loadCatalog({ offeringType: tab.id });
              }}
              className="min-h-11 md:min-h-8"
              data-testid={`catalog-type-filter-${tab.id}`}
            >
              {tab.label}
            </Button>
          ))}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <select
            aria-label="Filter status katalog"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              void loadCatalog({ status: e.target.value });
            }}
            className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground sm:w-auto md:min-h-9 md:text-sm"
          >
            <option value="">Semua status aktif</option>
            <option value="draft">Draf</option>
            <option value="published">Terbit</option>
            <option value="trashed">Sampah</option>
          </select>

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
              aria-label="Cari penawaran"
              className="min-h-11 pl-9 text-base md:min-h-9 md:text-sm"
              data-testid="catalog-search-input"
            />
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card data-state-panel={hasFilters ? "empty-filtered" : "empty-first-run"}>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <div className="flex items-center gap-2 text-muted-foreground">
              <BriefcaseIcon className="size-5" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                {hasFilters
                  ? "Tidak ada penawaran yang cocok dengan filter"
                  : "Belum ada penawaran di katalog"}
              </h2>
            </div>
            <p className="max-w-xl text-sm text-muted-foreground">
              {hasFilters
                ? "Ubah kata kunci pencarian atau reset filter tipe/status untuk menampilkan seluruh katalog."
                : "Tambahkan layanan, produk, paket tur, atau unit kendaraan pertama Anda agar pengunjung dapat menghubungi lewat WhatsApp."}
            </p>
            {hasFilters ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setTypeFilter("all");
                  setStatusFilter("");
                  void loadCatalog({ offeringType: "all", status: "" });
                }}
                className="min-h-11 md:min-h-9"
              >
                Reset filter
              </Button>
            ) : (
              permissions.canWriteContent && (
                <Button
                  render={<a href={`${basePath}/catalog/new`} />}
                  className="min-h-11 md:min-h-9"
                >
                  Tambah Penawaran Pertama
                </Button>
              )
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Penawaran</TableHead>
                    <TableHead>Tipe</TableHead>
                    <TableHead>Harga</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((item) => (
                    <TableRow key={item.id} data-testid={`offering-row-${item.id}`}>
                      <TableCell>
                        <div className="space-y-0.5">
                          <a
                            href={`${basePath}/catalog/${item.id}`}
                            className="font-medium text-foreground hover:text-primary hover:underline"
                          >
                            {item.title}
                          </a>
                          <p className="font-mono text-xs text-muted-foreground">
                            {item.publicPath}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{OFFERING_TYPE_LABEL[item.offeringType]}</Badge>
                      </TableCell>
                      <TableCell className="font-medium tabular-nums">
                        {formatPriceCell(item)}
                      </TableCell>
                      <TableCell>
                        <ContentStatusBadge status={item.status} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {item.status !== "trashed" ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                render={<a href={`${basePath}/catalog/${item.id}`} />}
                              >
                                <PencilIcon className="size-3.5" aria-hidden="true" />
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                render={
                                  <a
                                    href={`${basePath}/preview?kind=offering&id=${item.id}&version=${item.version}`}
                                  />
                                }
                              >
                                <EyeIcon className="size-3.5" aria-hidden="true" />
                                Pratinjau
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                disabled={!permissions.canPublishContent || busyId === item.id}
                                onClick={() => void handlePublishToggle(item)}
                              >
                                <GlobeIcon className="size-3.5" aria-hidden="true" />
                                {item.status === "published" ? "Batalkan" : "Terbitkan"}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                disabled={!permissions.canWriteContent || busyId === item.id}
                                onClick={() => setTrashTarget(item)}
                                data-testid={`offering-trash-${item.id}`}
                              >
                                <Trash2Icon className="size-3.5" aria-hidden="true" />
                                Sampah
                              </Button>
                            </>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!permissions.canWriteContent || busyId === item.id}
                              onClick={() => void handleRestore(item)}
                              data-testid={`offering-restore-${item.id}`}
                            >
                              <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                              Pulihkan
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <ul className="divide-y divide-border md:hidden">
              {filtered.map((item) => (
                <li key={item.id} className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <a
                        href={`${basePath}/catalog/${item.id}`}
                        className="block truncate text-sm font-semibold text-foreground"
                      >
                        {item.title}
                      </a>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {item.publicPath}
                      </p>
                    </div>
                    <ContentStatusBadge status={item.status} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <Badge variant="outline">{OFFERING_TYPE_LABEL[item.offeringType]}</Badge>
                    <span className="font-semibold text-foreground tabular-nums">
                      {formatPriceCell(item)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    Diperbarui {formatDateTimeId(item.updatedAt)}
                  </p>
                  {item.status !== "trashed" ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-11 flex-1"
                        render={<a href={`${basePath}/catalog/${item.id}`} />}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="min-h-11 flex-1"
                        disabled={!permissions.canPublishContent || busyId === item.id}
                        onClick={() => void handlePublishToggle(item)}
                      >
                        {item.status === "published" ? "Batalkan" : "Terbitkan"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className="min-h-11"
                        disabled={!permissions.canWriteContent || busyId === item.id}
                        onClick={() => setTrashTarget(item)}
                        aria-label={`Pindahkan ${item.title} ke Sampah`}
                      >
                        <Trash2Icon className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 w-full"
                      disabled={!permissions.canWriteContent || busyId === item.id}
                      onClick={() => void handleRestore(item)}
                    >
                      Pulihkan ke Draf
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {hasMore && nextCursor && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void loadCatalog({ cursor: nextCursor, append: true })}
            className="min-h-11 md:min-h-9"
          >
            {loading ? "Memuat..." : "Muat penawaran berikutnya"}
          </Button>
        </div>
      )}

      <ConfirmDestructiveDialog
        open={trashTarget !== null}
        onOpenChange={(o) => !o && setTrashTarget(null)}
        title={`Pindahkan "${trashTarget?.title ?? ""}" ke Sampah?`}
        description="Penawaran ini akan ditarik dari katalog publik jika sudah terbit dan dipindahkan ke status Sampah."
        confirmLabel="Pindahkan ke Sampah"
        busy={busyId !== null}
        onConfirm={handleConfirmTrash}
      />
    </div>
  );
}

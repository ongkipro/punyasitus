import { useCallback, useState } from "react";
import {
  EyeIcon,
  FilePlus2Icon,
  FileTextIcon,
  GlobeIcon,
  PencilIcon,
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

export interface PageListItemDto {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly status: "draft" | "published" | "trashed";
  readonly isHomepage: boolean;
  readonly layoutMode: "standard" | "focused";
  readonly hasUnpublishedChanges: boolean;
  readonly version: number;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

interface PageListApiResponse {
  readonly items: readonly PageListItemDto[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

export interface PagesListClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly initialItems: readonly PageListItemDto[];
  readonly initialNextCursor: string | null;
  readonly initialHasMore: boolean;
}

const STATUS_TABS = [
  { id: "all", label: "Semua" },
  { id: "draft", label: "Draf" },
  { id: "published", label: "Terbit" },
  { id: "trashed", label: "Sampah" },
] as const;

export function PagesListClient({
  handle,
  basePath,
  permissions,
  initialItems,
  initialNextCursor,
  initialHasMore,
}: PagesListClientProps) {
  const [items, setItems] = useState<readonly PageListItemDto[]>(initialItems);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{
    readonly tone: "success" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);
  const [trashTarget, setTrashTarget] = useState<PageListItemDto | null>(null);

  const loadPages = useCallback(
    async (opts?: { readonly status?: string; readonly cursor?: string | null; readonly append?: boolean }) => {
      setLoading(true);
      try {
        const activeStatus = opts?.status ?? statusFilter;
        const params = new URLSearchParams({ limit: "20", status: activeStatus });
        if (activeStatus === "trashed") {
          params.set("includeTrashed", "true");
        }
        if (opts?.cursor) {
          params.set("cursor", opts.cursor);
        }
        const res = await cmsFetchJson<PageListApiResponse>(
          `/api/tenants/${encodeURIComponent(handle)}/pages?${params.toString()}`,
        );
        setItems((prev) => (opts?.append ? [...prev, ...res.items] : res.items));
        setNextCursor(res.page.nextCursor);
        setHasMore(res.page.hasMore);
      } catch (err) {
        setFeedback({
          tone: "destructive",
          title: "Gagal memuat daftar halaman",
          message: err instanceof Error ? err.message : "Terjadi gangguan jaringan.",
        });
      } finally {
        setLoading(false);
      }
    },
    [handle, statusFilter],
  );

  async function handlePublishToggle(page: PageListItemDto) {
    if (!permissions.canPublishContent || busyId !== null) return;
    setBusyId(page.id);
    setFeedback(null);
    try {
      const action = page.status === "published" ? "unpublish" : "publish";
      const updated = await cmsFetchJson<PageListItemDto>(
        `/api/tenants/${encodeURIComponent(handle)}/pages/${page.id}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({ version: page.version }),
        },
      );
      setItems((prev) => prev.map((it) => (it.id === page.id ? { ...it, ...updated } : it)));
      setFeedback({
        tone: "success",
        title: action === "publish" ? "Halaman diterbitkan" : "Publikasi dibatalkan",
        message:
          action === "publish"
            ? `"${page.title}" kini aktif di situs publik.`
            : `"${page.title}" dikembalikan ke status draf.`,
      });
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        await loadPages({ status: statusFilter });
        setFeedback({
          tone: "destructive",
          title: "Data telah berubah, daftar dimuat ulang (409)",
          message:
            "Versi halaman sudah diperbarui oleh sesi lain. Daftar telah disegarkan, silakan ulangi tindakan Anda.",
        });
      } else {
        setFeedback({
          tone: "destructive",
          title: "Gagal mengubah status publikasi",
          message: err instanceof CmsApiError ? err.message : "Silakan muat ulang dan coba lagi.",
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
        `/api/tenants/${encodeURIComponent(handle)}/pages/${trashTarget.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({ version: trashTarget.version }),
        },
      );
      const removedTitle = trashTarget.title;
      setTrashTarget(null);
      setFeedback({
        tone: "success",
        title: "Halaman dipindahkan ke Sampah",
        message: `"${removedTitle}" telah dipindahkan ke Sampah dan dapat dipulihkan kapan saja.`,
      });
      await loadPages({ status: statusFilter });
    } catch (err) {
      setTrashTarget(null);
      if (err instanceof CmsApiError && err.isStaleVersion) {
        await loadPages({ status: statusFilter });
        setFeedback({
          tone: "destructive",
          title: "Data telah berubah, daftar dimuat ulang (409)",
          message:
            "Halaman telah diperbarui di sesi lain. Daftar kini menampilkan versi terbaru.",
        });
      } else {
        setFeedback({
          tone: "destructive",
          title: "Gagal memindahkan ke Sampah",
          message: err instanceof CmsApiError ? err.message : "Terjadi kesalahan saat menghapus.",
        });
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handleRestore(page: PageListItemDto) {
    if (!permissions.canWriteContent || busyId !== null) return;
    setBusyId(page.id);
    setFeedback(null);
    try {
      await cmsFetchJson(
        `/api/tenants/${encodeURIComponent(handle)}/pages/${page.id}/restore`,
        {
          method: "POST",
          body: JSON.stringify({ version: page.version }),
        },
      );
      setFeedback({
        tone: "success",
        title: "Halaman dipulihkan sebagai draf",
        message: `"${page.title}" telah dipulihkan dari Sampah.`,
      });
      await loadPages({ status: statusFilter });
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        await loadPages({ status: statusFilter });
        setFeedback({
          tone: "destructive",
          title: "Data telah berubah, daftar dimuat ulang (409)",
          message:
            "Versi halaman telah berubah di sesi lain. Daftar telah disegarkan.",
        });
      } else {
        setFeedback({
          tone: "destructive",
          title: "Gagal memulihkan halaman",
          message: err instanceof CmsApiError ? err.message : "Terjadi kesalahan saat memulihkan.",
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

  return (
    <div className="space-y-6" data-testid="pages-list-screen">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">Halaman</h1>
          <p className="text-sm text-muted-foreground">
            Kelola halaman statis, beranda, dan halaman fokus kampanye (landing page) situs Anda.
          </p>
        </div>
        <Button
          disabled={!permissions.canWriteContent}
          className="min-h-11 self-start sm:self-auto md:min-h-9"
          render={permissions.canWriteContent ? <a href={`${basePath}/pages/new`} /> : undefined}
          data-testid="new-page-btn"
        >
          <FilePlus2Icon className="size-4" aria-hidden="true" />
          Buat Halaman Baru
        </Button>
      </div>

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/service-status`} />}

      {feedback && (
        <Alert variant={feedback.tone} data-testid="pages-list-feedback">
          <AlertTitle>{feedback.title}</AlertTitle>
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div
          role="tablist"
          aria-label="Filter status halaman"
          className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card p-1"
        >
          {STATUS_TABS.map((tab) => (
            <Button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={statusFilter === tab.id}
              size="sm"
              variant={statusFilter === tab.id ? "default" : "ghost"}
              onClick={() => {
                setStatusFilter(tab.id);
                void loadPages({ status: tab.id });
              }}
              className="min-h-11 md:min-h-8"
              data-testid={`pages-filter-${tab.id}`}
            >
              {tab.label}
            </Button>
          ))}
        </div>

        <div className="relative w-full md:w-72">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari judul atau slug halaman..."
            aria-label="Cari halaman"
            className="min-h-11 pl-9 text-base md:min-h-9 md:text-sm"
            data-testid="pages-search-input"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card data-state-panel={search || statusFilter !== "all" ? "empty-filtered" : "empty-first-run"}>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <div className="flex items-center gap-2 text-muted-foreground">
              <FileTextIcon className="size-5" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                {search || statusFilter !== "all"
                  ? "Tidak ada halaman yang cocok dengan filter"
                  : "Belum ada halaman yang dibuat"}
              </h2>
            </div>
            <p className="max-w-xl text-sm text-muted-foreground">
              {search || statusFilter !== "all"
                ? "Coba ubah kata kunci pencarian atau tampilkan semua status halaman."
                : "Mulai dengan membuat halaman Beranda, Tentang Kami, atau halaman penawaran khusus."}
            </p>
            {search || statusFilter !== "all" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setStatusFilter("all");
                  void loadPages({ status: "all" });
                }}
                className="min-h-11 md:min-h-9"
              >
                Reset filter
              </Button>
            ) : (
              permissions.canWriteContent && (
                <Button
                  render={<a href={`${basePath}/pages/new`} />}
                  className="min-h-11 md:min-h-9"
                >
                  Buat Halaman Pertama
                </Button>
              )
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {/* Desktop table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Halaman</TableHead>
                    <TableHead>Mode Tata Letak</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Diperbarui</TableHead>
                    <TableHead className="text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((page) => (
                    <TableRow key={page.id} data-testid={`page-row-${page.id}`}>
                      <TableCell>
                        <div className="space-y-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <a
                              href={`${basePath}/pages/${page.id}`}
                              className="font-medium text-foreground hover:text-primary hover:underline"
                            >
                              {page.title}
                            </a>
                            {page.isHomepage && <Badge variant="info">Beranda</Badge>}
                          </div>
                          <p className="font-mono text-xs text-muted-foreground">/{page.slug}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {page.layoutMode === "focused" ? "Mode Fokus" : "Standar"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <ContentStatusBadge
                          status={page.status}
                          hasUnpublishedChanges={page.hasUnpublishedChanges}
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {formatDateTimeId(page.updatedAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {page.status !== "trashed" ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                render={<a href={`${basePath}/pages/${page.id}`} />}
                                data-testid={`page-edit-${page.id}`}
                              >
                                <PencilIcon className="size-3.5" aria-hidden="true" />
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                render={
                                  <a
                                    href={`${basePath}/preview?kind=page&id=${page.id}&version=${page.version}`}
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
                                disabled={!permissions.canPublishContent || busyId === page.id}
                                onClick={() => void handlePublishToggle(page)}
                                data-testid={`page-toggle-publish-${page.id}`}
                              >
                                <GlobeIcon className="size-3.5" aria-hidden="true" />
                                {page.status === "published" ? "Batalkan" : "Terbitkan"}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                disabled={!permissions.canWriteContent || busyId === page.id}
                                onClick={() => setTrashTarget(page)}
                                data-testid={`page-trash-${page.id}`}
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
                              disabled={!permissions.canWriteContent || busyId === page.id}
                              onClick={() => void handleRestore(page)}
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

            {/* Mobile stacked cards (360px zero overflow, >=44px targets) */}
            <ul className="divide-y divide-border md:hidden">
              {filtered.map((page) => (
                <li
                  key={page.id}
                  className="space-y-3 p-4"
                  data-testid={`page-mobile-card-${page.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <a
                        href={`${basePath}/pages/${page.id}`}
                        className="block truncate text-sm font-semibold text-foreground hover:text-primary"
                      >
                        {page.title}
                      </a>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        /{page.slug}
                      </p>
                    </div>
                    <ContentStatusBadge
                      status={page.status}
                      hasUnpublishedChanges={page.hasUnpublishedChanges}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {page.isHomepage && <Badge variant="info">Beranda</Badge>}
                    <Badge variant="outline">
                      {page.layoutMode === "focused" ? "Mode Fokus" : "Standar"}
                    </Badge>
                    <span className="tabular-nums">{formatDateTimeId(page.updatedAt)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {page.status !== "trashed" ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-11 flex-1"
                          render={<a href={`${basePath}/pages/${page.id}`} />}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="min-h-11 flex-1"
                          disabled={!permissions.canPublishContent || busyId === page.id}
                          onClick={() => void handlePublishToggle(page)}
                        >
                          {page.status === "published" ? "Batalkan" : "Terbitkan"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          className="min-h-11"
                          disabled={!permissions.canWriteContent || busyId === page.id}
                          onClick={() => setTrashTarget(page)}
                          aria-label={`Pindahkan ${page.title} ke Sampah`}
                        >
                          <Trash2Icon className="size-4" aria-hidden="true" />
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="min-h-11 w-full"
                        disabled={!permissions.canWriteContent || busyId === page.id}
                        onClick={() => void handleRestore(page)}
                      >
                        Pulihkan ke Draf
                      </Button>
                    )}
                  </div>
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
            onClick={() => void loadPages({ cursor: nextCursor, append: true })}
            className="min-h-11 md:min-h-9"
          >
            {loading ? "Memuat..." : "Muat halaman berikutnya"}
          </Button>
        </div>
      )}

      <ConfirmDestructiveDialog
        open={trashTarget !== null}
        onOpenChange={(o) => !o && setTrashTarget(null)}
        title={`Pindahkan "${trashTarget?.title ?? ""}" ke Sampah?`}
        description="Halaman akan segera ditarik dari situs publik jika sudah terbit dan dipindahkan ke tab Sampah. Anda dapat memulihkannya kembali sebagai draf."
        confirmLabel="Pindahkan ke Sampah"
        busy={busyId !== null}
        onConfirm={handleConfirmTrash}
      />
    </div>
  );
}

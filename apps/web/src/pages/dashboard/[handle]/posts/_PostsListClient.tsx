import { useCallback, useState } from "react";
import {
  EyeIcon,
  GlobeIcon,
  NewspaperIcon,
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

export interface PostTaxonomyOptionDto {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
}

export interface PostListItemDto {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly status: "draft" | "published" | "trashed";
  readonly readingTimeMinutes: number;
  readonly hasUnpublishedChanges: boolean;
  readonly version: number;
  readonly updatedAt: string;
}

interface PostListApiResponse {
  readonly items: readonly PostListItemDto[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

export interface PostsListClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly initialItems: readonly PostListItemDto[];
  readonly initialNextCursor: string | null;
  readonly initialHasMore: boolean;
  readonly categories: readonly PostTaxonomyOptionDto[];
  readonly tags: readonly PostTaxonomyOptionDto[];
}

const STATUS_TABS = [
  { id: "all", label: "Semua" },
  { id: "draft", label: "Draf" },
  { id: "published", label: "Terbit" },
  { id: "trashed", label: "Sampah" },
] as const;

export function PostsListClient({
  handle,
  basePath,
  permissions,
  initialItems,
  initialNextCursor,
  initialHasMore,
  categories,
  tags,
}: PostsListClientProps) {
  const [items, setItems] = useState<readonly PostListItemDto[]>(initialItems);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);

  const [statusFilter, setStatusFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [trashTarget, setTrashTarget] = useState<PostListItemDto | null>(null);
  const [feedback, setFeedback] = useState<{
    readonly tone: "success" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);

  const loadPosts = useCallback(
    async (opts?: {
      readonly status?: string;
      readonly categoryId?: string;
      readonly tagId?: string;
      readonly searchQuery?: string;
      readonly cursor?: string | null;
      readonly append?: boolean;
    }) => {
      setLoading(true);
      try {
        const activeStatus = opts?.status ?? statusFilter;
        const activeCat = opts?.categoryId ?? categoryFilter;
        const activeTag = opts?.tagId ?? tagFilter;
        const activeSearch = opts?.searchQuery ?? search;

        const params = new URLSearchParams({ limit: "20", status: activeStatus });
        if (activeStatus === "trashed") params.set("includeTrashed", "true");
        if (activeCat) params.set("categoryId", activeCat);
        if (activeTag) params.set("tagId", activeTag);
        if (activeSearch.trim()) params.set("search", activeSearch.trim());
        if (opts?.cursor) params.set("cursor", opts.cursor);

        const res = await cmsFetchJson<PostListApiResponse>(
          `/api/tenants/${encodeURIComponent(handle)}/posts?${params.toString()}`,
        );
        setItems((prev) => (opts?.append ? [...prev, ...res.items] : res.items));
        setNextCursor(res.page.nextCursor);
        setHasMore(res.page.hasMore);
      } catch (err) {
        setFeedback({
          tone: "destructive",
          title: "Gagal memuat daftar artikel",
          message: err instanceof Error ? err.message : "Terjadi kesalahan saat memuat artikel.",
        });
      } finally {
        setLoading(false);
      }
    },
    [handle, statusFilter, categoryFilter, tagFilter, search],
  );

  async function handlePublishToggle(post: PostListItemDto) {
    if (!permissions.canPublishContent || busyId !== null) return;
    setBusyId(post.id);
    setFeedback(null);
    try {
      const action = post.status === "published" ? "unpublish" : "publish";
      const updated = await cmsFetchJson<PostListItemDto>(
        `/api/tenants/${encodeURIComponent(handle)}/posts/${post.id}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({ version: post.version }),
        },
      );
      setItems((prev) => prev.map((it) => (it.id === post.id ? { ...it, ...updated } : it)));
      setFeedback({
        tone: "success",
        title: action === "publish" ? "Artikel diterbitkan" : "Publikasi dibatalkan",
        message: `"${post.title}" berhasil diperbarui.`,
      });
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        await loadPosts();
        setFeedback({
          tone: "destructive",
          title: "Data telah berubah, daftar dimuat ulang (409)",
          message:
            "Versi artikel sudah diperbarui oleh sesi lain. Daftar telah disegarkan, silakan ulangi tindakan Anda.",
        });
      } else {
        setFeedback({
          tone: "destructive",
          title: "Gagal mengubah status artikel",
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
        `/api/tenants/${encodeURIComponent(handle)}/posts/${trashTarget.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({ version: trashTarget.version }),
        },
      );
      const removedTitle = trashTarget.title;
      setTrashTarget(null);
      setFeedback({
        tone: "success",
        title: "Artikel dipindahkan ke Sampah",
        message: `"${removedTitle}" berhasil dipindahkan ke Sampah.`,
      });
      await loadPosts();
    } catch (err) {
      setTrashTarget(null);
      if (err instanceof CmsApiError && err.isStaleVersion) {
        await loadPosts();
        setFeedback({
          tone: "destructive",
          title: "Data telah berubah, daftar dimuat ulang (409)",
          message:
            "Versi artikel telah berubah di sesi lain. Daftar telah disegarkan.",
        });
      } else {
        setFeedback({
          tone: "destructive",
          title: "Gagal menghapus artikel",
          message: err instanceof Error ? err.message : "Terjadi kesalahan.",
        });
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handleRestore(post: PostListItemDto) {
    if (!permissions.canWriteContent || busyId !== null) return;
    setBusyId(post.id);
    try {
      await cmsFetchJson(
        `/api/tenants/${encodeURIComponent(handle)}/posts/${post.id}/restore`,
        {
          method: "POST",
          body: JSON.stringify({ version: post.version }),
        },
      );
      setFeedback({
        tone: "success",
        title: "Artikel dipulihkan sebagai draf",
        message: `"${post.title}" kembali ke daftar draf.`,
      });
      await loadPosts();
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        await loadPosts();
        setFeedback({
          tone: "destructive",
          title: "Data telah berubah, daftar dimuat ulang (409)",
          message:
            "Versi artikel telah berubah di sesi lain. Daftar telah disegarkan.",
        });
      } else {
        setFeedback({
          tone: "destructive",
          title: "Gagal memulihkan artikel",
          message: err instanceof Error ? err.message : "Terjadi kesalahan.",
        });
      }
    } finally {
      setBusyId(null);
    }
  }

  const hasFilters = Boolean(search.trim() || statusFilter !== "all" || categoryFilter || tagFilter);

  return (
    <div className="space-y-6" data-testid="posts-list-screen">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">Artikel Blog</h1>
          <p className="text-sm text-muted-foreground">
            Tulis dan terbitkan artikel informatif untuk membangun otoritas dan trafik organik.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          <Button
            variant="outline"
            className="min-h-11 md:min-h-9"
            render={<a href={`${basePath}/posts/trash`} />}
            data-testid="posts-trash-link"
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
            Sampah &amp; Pemulihan
          </Button>
          <Button
            disabled={!permissions.canWriteContent}
            className="min-h-11 md:min-h-9"
            render={permissions.canWriteContent ? <a href={`${basePath}/posts/new`} /> : undefined}
            data-testid="new-post-btn"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            Tulis Artikel Baru
          </Button>
        </div>
      </div>

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/service-status`} />}

      {feedback && (
        <Alert variant={feedback.tone} data-testid="posts-list-feedback">
          <AlertTitle>{feedback.title}</AlertTitle>
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="tablist"
          aria-label="Filter status artikel"
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
                void loadPosts({ status: tab.id });
              }}
              className="min-h-11 md:min-h-8"
            >
              {tab.label}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {categories.length > 0 && (
            <select
              aria-label="Filter kategori"
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value);
                void loadPosts({ categoryId: e.target.value });
              }}
              className="min-h-11 rounded-md border border-input bg-card px-3 py-2 text-base text-foreground md:min-h-9 md:text-sm"
            >
              <option value="">Semua kategori</option>
              {categories.map((cat) => (
                <option key={cat.id} value={String(cat.id)}>
                  {cat.name}
                </option>
              ))}
            </select>
          )}
          {tags.length > 0 && (
            <select
              aria-label="Filter tag"
              value={tagFilter}
              onChange={(e) => {
                setTagFilter(e.target.value);
                void loadPosts({ tagId: e.target.value });
              }}
              className="min-h-11 rounded-md border border-input bg-card px-3 py-2 text-base text-foreground md:min-h-9 md:text-sm"
            >
              <option value="">Semua tag</option>
              {tags.map((tag) => (
                <option key={tag.id} value={String(tag.id)}>
                  #{tag.name}
                </option>
              ))}
            </select>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loadPosts({ searchQuery: search });
            }}
            className="relative flex-1 sm:w-64 sm:flex-none"
          >
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari judul artikel..."
              aria-label="Cari artikel"
              className="min-h-11 pl-9 text-base md:min-h-9 md:text-sm"
              data-testid="posts-search-input"
            />
          </form>
        </div>
      </div>

      {items.length === 0 ? (
        <Card data-state-panel={hasFilters ? "empty-filtered" : "empty-first-run"}>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <div className="flex items-center gap-2 text-muted-foreground">
              <NewspaperIcon className="size-5" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                {hasFilters
                  ? "Tidak ada artikel yang cocok dengan filter"
                  : "Belum ada artikel blog"}
              </h2>
            </div>
            <p className="max-w-xl text-sm text-muted-foreground">
              {hasFilters
                ? "Ubah kata kunci pencarian atau reset filter kategori/status untuk melihat semua artikel."
                : "Mulai menulis panduan, studi kasus, atau tips seputar layanan Anda untuk menarik calon pelanggan dari pencarian."}
            </p>
            {hasFilters ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setStatusFilter("all");
                  setCategoryFilter("");
                  setTagFilter("");
                  void loadPosts({ status: "all", categoryId: "", tagId: "", searchQuery: "" });
                }}
                className="min-h-11 md:min-h-9"
              >
                Reset filter
              </Button>
            ) : (
              permissions.canWriteContent && (
                <Button
                  render={<a href={`${basePath}/posts/new`} />}
                  className="min-h-11 md:min-h-9"
                >
                  Tulis Artikel Pertama
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
                    <TableHead>Artikel</TableHead>
                    <TableHead>Waktu Baca</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Diperbarui</TableHead>
                    <TableHead className="text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((post) => (
                    <TableRow key={post.id} data-testid={`post-row-${post.id}`}>
                      <TableCell>
                        <div className="space-y-0.5">
                          <a
                            href={`${basePath}/posts/${post.id}`}
                            className="font-medium text-foreground hover:text-primary hover:underline"
                          >
                            {post.title}
                          </a>
                          <p className="font-mono text-xs text-muted-foreground">
                            /blog/{post.slug}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        <Badge variant="outline">{post.readingTimeMinutes} menit</Badge>
                      </TableCell>
                      <TableCell>
                        <ContentStatusBadge
                          status={post.status}
                          hasUnpublishedChanges={post.hasUnpublishedChanges}
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {formatDateTimeId(post.updatedAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {post.status !== "trashed" ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                render={<a href={`${basePath}/posts/${post.id}`} />}
                              >
                                <PencilIcon className="size-3.5" aria-hidden="true" />
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                render={
                                  <a
                                    href={`${basePath}/preview?kind=post&id=${post.id}&version=${post.version}`}
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
                                disabled={!permissions.canPublishContent || busyId === post.id}
                                onClick={() => void handlePublishToggle(post)}
                              >
                                <GlobeIcon className="size-3.5" aria-hidden="true" />
                                {post.status === "published" ? "Batalkan" : "Terbitkan"}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                disabled={!permissions.canWriteContent || busyId === post.id}
                                onClick={() => setTrashTarget(post)}
                                data-testid={`post-trash-${post.id}`}
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
                              disabled={!permissions.canWriteContent || busyId === post.id}
                              onClick={() => void handleRestore(post)}
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
              {items.map((post) => (
                <li key={post.id} className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <a
                        href={`${basePath}/posts/${post.id}`}
                        className="block truncate text-sm font-semibold text-foreground"
                      >
                        {post.title}
                      </a>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        /blog/{post.slug}
                      </p>
                    </div>
                    <ContentStatusBadge
                      status={post.status}
                      hasUnpublishedChanges={post.hasUnpublishedChanges}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline" className="tabular-nums">
                      {post.readingTimeMinutes} menit baca
                    </Badge>
                    <span className="tabular-nums">{formatDateTimeId(post.updatedAt)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {post.status !== "trashed" ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-11 flex-1"
                          render={<a href={`${basePath}/posts/${post.id}`} />}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="min-h-11 flex-1"
                          disabled={!permissions.canPublishContent || busyId === post.id}
                          onClick={() => void handlePublishToggle(post)}
                        >
                          {post.status === "published" ? "Batalkan" : "Terbitkan"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          className="min-h-11"
                          disabled={!permissions.canWriteContent || busyId === post.id}
                          onClick={() => setTrashTarget(post)}
                          aria-label={`Pindahkan ${post.title} ke Sampah`}
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
                        disabled={!permissions.canWriteContent || busyId === post.id}
                        onClick={() => void handleRestore(post)}
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
            onClick={() => void loadPosts({ cursor: nextCursor, append: true })}
            className="min-h-11 md:min-h-9"
          >
            {loading ? "Memuat..." : "Muat artikel berikutnya"}
          </Button>
        </div>
      )}

      <ConfirmDestructiveDialog
        open={trashTarget !== null}
        onOpenChange={(o) => !o && setTrashTarget(null)}
        title={`Pindahkan "${trashTarget?.title ?? ""}" ke Sampah?`}
        description="Artikel akan ditarik dari blog publik jika sedang terbit dan dipindahkan ke tab Sampah."
        confirmLabel="Pindahkan ke Sampah"
        busy={busyId !== null}
        onConfirm={handleConfirmTrash}
      />
    </div>
  );
}

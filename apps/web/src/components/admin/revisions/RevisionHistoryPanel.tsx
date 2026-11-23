import { useCallback, useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  HistoryIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  formatDateTimeId,
} from "@/components/admin/editor";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Content Revision History & Draft-Only Restore Confirmation Panel
 * (`apps/web/src/components/admin/revisions/RevisionHistoryPanel.tsx`; TASK-064, REQ-048, DESIGN.md).
 *
 * Built strictly with `shadcn/ui` `base-nova` (`@base-ui/react/dialog` + Tailwind CSS v4).
 * Non-scope: diff viewer, autosave, scheduled publishing.
 */

export type RevisionResourceKind = "page" | "post" | "offering";
export type RevisionTriggerKind = "save" | "publish" | "restore";

export interface RevisionReferenceWarningDto {
  readonly kind: "media" | "taxonomy" | "author";
  readonly id: number;
  readonly status: "missing" | "trashed" | "unavailable" | "detached";
  readonly field: string;
  readonly message: string;
}

export interface RevisionSummaryDto {
  readonly id: string;
  readonly revisionId: string;
  readonly resourceType: RevisionResourceKind;
  readonly resourceId: number;
  readonly revisionNumber: number;
  readonly schemaVersion: number;
  readonly triggerKind: RevisionTriggerKind;
  readonly actorUserId: string | null;
  readonly summary: string;
  readonly title: string | null;
  readonly slug: string | null;
  readonly createdAt: string;
}

export interface RevisionListResponseDto {
  readonly items: readonly RevisionSummaryDto[];
  readonly resourceType: RevisionResourceKind;
  readonly resourceId: number;
  readonly currentVersion: number;
  readonly resourceStatus: "draft" | "published" | "trashed";
  readonly maxRetained: number;
}

export interface RevisionDetailDto extends RevisionSummaryDto {
  readonly snapshot: Record<string, unknown>;
  readonly referenceReport: {
    readonly referencedMediaIds: readonly number[];
    readonly validMediaIds: readonly number[];
    readonly missingMediaIds: readonly number[];
    readonly trashedMediaIds: readonly number[];
    readonly unavailableMediaIds: readonly number[];
    readonly detachedMediaIds: readonly number[];
    readonly missingTaxonomyIds: readonly number[];
    readonly missingAuthorId: number | null;
    readonly warnings: readonly RevisionReferenceWarningDto[];
  };
  readonly currentVersion: number;
  readonly resourceStatus: "draft" | "published" | "trashed";
}

export interface RevisionRestoreResponseDto {
  readonly restored: true;
  readonly revisionId: string;
  readonly resourceType: RevisionResourceKind;
  readonly resourceId: number;
  readonly restoredFromRevisionNumber: number;
  readonly newRevisionNumber: number;
  readonly version: number;
  readonly status: "draft" | "published" | "trashed";
  readonly draftOnly: true;
  readonly hasUnpublishedChanges: boolean;
  readonly warnings: readonly RevisionReferenceWarningDto[];
  readonly restoredAt: string;
  readonly resource: Record<string, unknown>;
}

export interface RevisionHistoryPanelProps {
  readonly handle: string;
  readonly resourceType: RevisionResourceKind;
  readonly resourceId: number;
  readonly currentVersion: number;
  readonly readOnly: boolean;
  readonly defaultExpanded?: boolean;
  readonly onRestored: (result: RevisionRestoreResponseDto) => void | Promise<void>;
  readonly onStaleConflict: (message: string) => void;
  readonly onReloadLatest?: () => void | Promise<void>;
}

function getTriggerLabel(kind: RevisionTriggerKind): string {
  if (kind === "publish") return "Terbit";
  if (kind === "restore") return "Pemulihan";
  return "Simpan draf";
}

function getTriggerBadgeVariant(
  kind: RevisionTriggerKind,
): "success" | "secondary" | "outline" {
  if (kind === "publish") return "success";
  if (kind === "restore") return "outline";
  return "secondary";
}

function getResourceLabel(kind: RevisionResourceKind): string {
  if (kind === "post") return "artikel";
  if (kind === "offering") return "penawaran";
  return "halaman";
}

export function RevisionHistoryPanel({
  handle,
  resourceType,
  resourceId,
  currentVersion,
  readOnly,
  defaultExpanded = false,
  onRestored,
  onStaleConflict,
  onReloadLatest,
}: RevisionHistoryPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<readonly RevisionSummaryDto[]>([]);
  const [maxRetained, setMaxRetained] = useState<number>(20);

  // Restore confirmation dialog state
  const [selectedRevision, setSelectedRevision] = useState<RevisionSummaryDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailData, setDetailData] = useState<RevisionDetailDto | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<{
    readonly isConflict: boolean;
    readonly message: string;
  } | null>(null);

  const resourceLabel = getResourceLabel(resourceType);

  const fetchRevisions = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const url = `/api/tenants/${encodeURIComponent(handle)}/revisions?resourceType=${encodeURIComponent(resourceType)}&resourceId=${resourceId}`;
      const res = await cmsFetchJson<RevisionListResponseDto>(url);
      setRevisions(res.items);
      setMaxRetained(res.maxRetained ?? 20);
      setLoadedOnce(true);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Gagal memuat daftar riwayat revisi.",
      );
    } finally {
      setLoading(false);
    }
  }, [handle, resourceType, resourceId]);

  useEffect(() => {
    if (expanded) {
      void fetchRevisions();
    }
  }, [expanded, currentVersion, fetchRevisions]);

  async function openRestoreConfirm(rev: RevisionSummaryDto) {
    setSelectedRevision(rev);
    setDetailData(null);
    setDetailError(null);
    setRestoreError(null);
    setDetailLoading(true);
    try {
      const detail = await cmsFetchJson<RevisionDetailDto>(
        `/api/tenants/${encodeURIComponent(handle)}/revisions/${encodeURIComponent(rev.revisionId)}`,
      );
      setDetailData(detail);
    } catch (err) {
      setDetailError(
        err instanceof Error
          ? err.message
          : "Tidak dapat memeriksa detail referensi revisi ini.",
      );
    } finally {
      setDetailLoading(false);
    }
  }

  function closeRestoreDialog() {
    if (restoring) return;
    setSelectedRevision(null);
    setDetailData(null);
    setDetailError(null);
    setRestoreError(null);
  }

  async function handleConfirmRestore() {
    if (!selectedRevision || readOnly || restoring) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const result = await cmsFetchJson<RevisionRestoreResponseDto>(
        `/api/tenants/${encodeURIComponent(handle)}/revisions/${encodeURIComponent(selectedRevision.revisionId)}/restore`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: currentVersion,
            detachMissingReferences: true,
          }),
        },
      );
      setSelectedRevision(null);
      setDetailData(null);
      await onRestored(result);
      await fetchRevisions();
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        const msg =
          err.message ||
          "Versi konten di server lebih baru (409). Muat ulang versi terbaru sebelum memulihkan revisi.";
        setRestoreError({ isConflict: true, message: msg });
        onStaleConflict(msg);
      } else {
        setRestoreError({
          isConflict: false,
          message:
            err instanceof Error
              ? err.message
              : "Gagal memulihkan revisi. Coba beberapa saat lagi.",
        });
      }
    } finally {
      setRestoring(false);
    }
  }

  return (
    <Card data-testid="revision-history-panel">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <HistoryIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
            <CardTitle className="text-base">Riwayat Revisi</CardTitle>
            <Badge variant="secondary" className="tabular-nums" data-testid="revision-count-badge">
              {loadedOnce ? `${revisions.length} / ${maxRetained}` : `Maks. ${maxRetained}`}
            </Badge>
          </div>
          <CardDescription>
            Menyimpan hingga {maxRetained} revisi terbaru untuk {resourceLabel} ini. Pemulihan
            hanya membuat draf dan tidak mengubah situs publik sebelum Anda klik Terbitkan.
          </CardDescription>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {expanded && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void fetchRevisions()}
              className="min-h-11 md:min-h-9"
              data-testid="revision-refresh-btn"
            >
              <RefreshCwIcon className="size-4" aria-hidden="true" />
              {loading ? "Memuat..." : "Muat ulang"}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="min-h-11 md:min-h-9"
            data-testid="revision-toggle-btn"
          >
            {expanded ? (
              <>
                <ChevronUpIcon className="size-4" aria-hidden="true" />
                Tutup Riwayat
              </>
            ) : (
              <>
                <ChevronDownIcon className="size-4" aria-hidden="true" />
                Lihat Riwayat
              </>
            )}
          </Button>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-3" data-testid="revision-history-list-container">
          {readOnly && (
            <Alert variant="warning" data-testid="revision-readonly-notice">
              <AlertTriangleIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Mode baca saja</AlertTitle>
              <AlertDescription>
                Anda dapat melihat riwayat revisi, namun pemulihan dinonaktifkan saat situs
                terkunci, konten di Sampah, atau peran Anda tidak memiliki izin tulis.
              </AlertDescription>
            </Alert>
          )}

          {loadError && (
            <Alert variant="destructive" data-testid="revision-load-error">
              <AlertTriangleIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Gagal memuat riwayat revisi</AlertTitle>
              <AlertDescription>{loadError}</AlertDescription>
              <AlertAction>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void fetchRevisions()}
                  className="min-h-11 md:min-h-9"
                >
                  Coba lagi
                </Button>
              </AlertAction>
            </Alert>
          )}

          {loading && !loadedOnce ? (
            <div className="space-y-2" data-testid="revision-loading-skeleton">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : !loadError && revisions.length === 0 ? (
            <div
              className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-center text-sm text-muted-foreground"
              data-testid="revision-empty-state"
            >
              Belum ada riwayat revisi tersimpan untuk {resourceLabel} ini. Simpan draf atau
              terbitkan untuk mulai mencatat revisi.
            </div>
          ) : (
            <ul
              className="divide-y divide-border rounded-md border border-border bg-card"
              data-testid="revision-list"
            >
              {revisions.map((rev, index) => (
                <li
                  key={rev.revisionId}
                  className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between"
                  data-testid={`revision-row-${rev.revisionNumber}`}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground tabular-nums">
                        Revisi #{rev.revisionNumber}
                      </span>
                      <Badge variant={getTriggerBadgeVariant(rev.triggerKind)}>
                        {getTriggerLabel(rev.triggerKind)}
                      </Badge>
                      {index === 0 && <Badge variant="outline">Terbaru</Badge>}
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatDateTimeId(rev.createdAt)}
                      </span>
                    </div>
                    <p className="break-words text-sm text-foreground">{rev.summary}</p>
                  </div>

                  <div className="flex shrink-0 items-center justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={readOnly || restoring}
                      onClick={() => void openRestoreConfirm(rev)}
                      aria-label={`Pulihkan revisi #${rev.revisionNumber} sebagai draf`}
                      className="min-h-11 w-full sm:w-auto md:min-h-9"
                      data-testid={`revision-restore-btn-${rev.revisionNumber}`}
                    >
                      <RotateCcwIcon className="size-4" aria-hidden="true" />
                      Pulihkan
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      )}

      <DialogPrimitive.Root
        open={selectedRevision !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeRestoreDialog();
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-[70] bg-foreground/40 transition-opacity duration-150" />
          <DialogPrimitive.Popup
            data-testid="revision-restore-dialog"
            className="fixed top-1/2 left-1/2 z-[75] max-h-[90vh] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 text-foreground shadow-lg"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <RotateCcwIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
                <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                  {selectedRevision
                    ? `Pulihkan Revisi #${selectedRevision.revisionNumber} sebagai Draf?`
                    : "Pulihkan Revisi sebagai Draf?"}
                </DialogPrimitive.Title>
              </div>
              <DialogPrimitive.Close
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={restoring}
                    aria-label="Tutup dialog pemulihan revisi"
                    className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                  />
                }
              >
                <XIcon className="size-4" aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>

            <DialogPrimitive.Description className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
              Pulihkan sebagai Draf — tidak mengubah halaman publik sebelum Anda klik Terbitkan.
            </DialogPrimitive.Description>

            {selectedRevision && (
              <div className="mt-4 space-y-3">
                <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-foreground tabular-nums">
                      Revisi #{selectedRevision.revisionNumber} (
                      {getTriggerLabel(selectedRevision.triggerKind)})
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatDateTimeId(selectedRevision.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    {detailData?.title ?? selectedRevision.title ?? "Tanpa judul"}
                  </p>
                  <p className="text-muted-foreground">{selectedRevision.summary}</p>
                </div>

                {detailLoading && (
                  <div className="space-y-2" data-testid="revision-detail-loading">
                    <Skeleton className="h-10 w-full" />
                  </div>
                )}

                {detailError && (
                  <Alert variant="destructive" data-testid="revision-detail-error">
                    <AlertTriangleIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>Peringatan pemeriksaan revisi</AlertTitle>
                    <AlertDescription>{detailError}</AlertDescription>
                  </Alert>
                )}

                {detailData && detailData.referenceReport.warnings.length > 0 && (
                  <Alert variant="warning" data-testid="revision-reference-warnings">
                    <AlertTriangleIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>Beberapa referensi media atau taksonomi sudah berubah</AlertTitle>
                    <AlertDescription>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                        {detailData.referenceReport.warnings.map((w, idx) => (
                          <li key={`${w.kind}-${w.id}-${idx}`}>{w.message}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                {restoreError && (
                  <Alert
                    variant={restoreError.isConflict ? "warning" : "destructive"}
                    data-testid={
                      restoreError.isConflict
                        ? "revision-restore-conflict-409"
                        : "revision-restore-error"
                    }
                  >
                    <AlertTriangleIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>
                      {restoreError.isConflict
                        ? "Konflik versi (409) — data terbaru tersedia"
                        : "Gagal memulihkan revisi"}
                    </AlertTitle>
                    <AlertDescription>{restoreError.message}</AlertDescription>
                    {restoreError.isConflict && onReloadLatest && (
                      <AlertAction>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            closeRestoreDialog();
                            void onReloadLatest();
                          }}
                          className="min-h-11 md:min-h-9"
                          data-testid="revision-conflict-reload-btn"
                        >
                          <RefreshCwIcon className="size-4" aria-hidden="true" />
                          Muat ulang versi terbaru
                        </Button>
                      </AlertAction>
                    )}
                  </Alert>
                )}
              </div>
            )}

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={restoring}
                onClick={closeRestoreDialog}
                className="min-h-11 md:min-h-9"
                data-testid="revision-restore-cancel"
              >
                Batal
              </Button>
              <Button
                type="button"
                disabled={readOnly || restoring || detailLoading || Boolean(detailError)}
                onClick={() => void handleConfirmRestore()}
                className="min-h-11 md:min-h-9"
                data-testid="revision-restore-confirm"
              >
                <RotateCcwIcon className="size-4" aria-hidden="true" />
                {restoring ? "Memulihkan draf..." : "Pulihkan sebagai Draf"}
              </Button>
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </Card>
  );
}

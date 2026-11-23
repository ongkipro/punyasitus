import { useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { AlertCircleIcon, AlertTriangleIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Shared CMS Admin UI helpers (TASK-033):
 * - Typed API error parsing (`409 STALE_VERSION`, `403 SUBSCRIPTION_LOCKED`, `422 VALIDATION_ERROR`)
 * - Dirty-state navigation guard (`beforeunload`)
 * - Accessible Base UI destructive confirmation dialog (`ConfirmDestructiveDialog`)
 * - Interactive `409` stale-write recovery banner (`StaleWriteRecoveryBanner`)
 * - Indonesian formatting utilities (IDR, dates, slugify, status badges)
 */

export interface CmsApiErrorField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class CmsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly fields: readonly CmsApiErrorField[];
  readonly extra: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: {
      readonly requestId?: string | null;
      readonly fields?: readonly CmsApiErrorField[];
      readonly extra?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "CmsApiError";
    this.status = status;
    this.code = code;
    this.requestId = options?.requestId ?? null;
    this.fields = options?.fields ?? [];
    this.extra = options?.extra ?? {};
  }

  get isStaleVersion(): boolean {
    return this.status === 409 && (this.code === "STALE_VERSION" || this.code === "CONFLICT");
  }

  get isSubscriptionLocked(): boolean {
    return this.status === 403 && this.code === "SUBSCRIPTION_LOCKED";
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

export function fieldErrorsToMap(
  fields: readonly CmsApiErrorField[] | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};
  if (!fields) return map;
  for (const f of fields) {
    if (f.field && !map[f.field]) {
      map[f.field] = f.message;
    }
  }
  return map;
}

export async function cmsFetchJson<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  let parsed: unknown = null;
  const text = await res.text();
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const errObj =
      obj?.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : null;
    const code =
      typeof errObj?.code === "string"
        ? errObj.code
        : res.status === 409
          ? "STALE_VERSION"
          : res.status === 403
            ? "FORBIDDEN"
            : res.status === 422
              ? "VALIDATION_ERROR"
              : "REQUEST_FAILED";
    const message =
      typeof errObj?.message === "string"
        ? errObj.message
        : `Permintaan gagal dengan status HTTP ${res.status}.`;
    const fields = Array.isArray(errObj?.fields) ? (errObj.fields as CmsApiErrorField[]) : [];
    const requestId = typeof obj?.requestId === "string" ? obj.requestId : null;
    throw new CmsApiError(res.status, code, message, {
      requestId,
      fields,
      extra: errObj ?? {},
    });
  }

  return parsed as T;
}

/**
 * Registers a browser `beforeunload` warning whenever `isDirty` is true,
 * unless `bypassRef.current` is set (e.g. intentional redirect right after confirmed trash).
 */
export function useDirtyNavigationGuard(
  isDirty: boolean,
  bypassRef?: { readonly current: boolean },
): void {
  useEffect(() => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      if (bypassRef?.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty, bypassRef]);
}

export function slugifyClient(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function formatIdr(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—";
  return `Rp ${new Intl.NumberFormat("id-ID").format(Math.round(amount))}`;
}

export function formatBytesHuman(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDateTimeId(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function ContentStatusBadge({
  status,
  hasUnpublishedChanges,
}: {
  status: string;
  hasUnpublishedChanges?: boolean;
}) {
  if (status === "published") {
    return (
      <div className="inline-flex flex-wrap items-center gap-1.5">
        <Badge variant="success">Terbit</Badge>
        {hasUnpublishedChanges && <Badge variant="warning">Perubahan draf</Badge>}
      </div>
    );
  }
  if (status === "trashed") {
    return <Badge variant="destructive">Sampah</Badge>;
  }
  return <Badge variant="secondary">Draf</Badge>;
}

export function InlineFieldError({
  id,
  message,
}: {
  id?: string;
  message?: string | null;
}) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs font-medium text-destructive">
      {message}
    </p>
  );
}

export function StaleWriteRecoveryBanner({
  message,
  onReloadLatest,
  reloading = false,
  onDismiss,
}: {
  message?: string;
  onReloadLatest: () => void | Promise<void>;
  reloading?: boolean;
  onDismiss?: () => void;
}) {
  return (
    <Alert variant="warning" data-state-panel="conflict-409" data-testid="stale-conflict-banner">
      <AlertTriangleIcon className="size-4" aria-hidden="true" />
      <AlertTitle>Perubahan bentrok dengan versi terbaru (409)</AlertTitle>
      <AlertDescription>
        {message ??
          "Data ini baru saja diperbarui di tab lain atau oleh anggota tim lain. Muat ulang versi terbaru agar perubahan sebelumnya tidak tertimpa."}
      </AlertDescription>
      <AlertAction>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={reloading}
          onClick={() => void onReloadLatest()}
          className="min-h-11 md:min-h-9"
          data-testid="stale-conflict-reload-btn"
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          {reloading ? "Memuat versi terbaru..." : "Muat ulang versi terbaru"}
        </Button>
        {onDismiss && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onDismiss}
            className="min-h-11 md:min-h-9"
          >
            Tutup pesan
          </Button>
        )}
      </AlertAction>
    </Alert>
  );
}

export function LockedTenantBanner({
  billingHref,
}: {
  billingHref: string;
}) {
  return (
    <Alert variant="warning" data-testid="cms-locked-banner">
      <AlertCircleIcon className="size-4" aria-hidden="true" />
      <AlertTitle>Situs dalam mode baca saja (Terkunci)</AlertTitle>
      <AlertDescription>
        Masa tenggang langganan telah berakhir. Anda tetap dapat melihat seluruh konten, namun
        perubahan, unggahan media, dan publikasi dinonaktifkan sampai perpanjangan selesai.
      </AlertDescription>
      <AlertAction>
        <Button
          size="sm"
          className="min-h-11 md:min-h-9"
          render={<a href={billingHref} />}
        >
          Perpanjang langganan
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function ConfirmDestructiveDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Hapus",
  cancelLabel = "Batal",
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [internalBusy, setInternalBusy] = useState(false);
  const isSubmitting = busy || internalBusy;

  async function handleConfirm() {
    if (isSubmitting) return;
    setInternalBusy(true);
    try {
      await onConfirm();
    } finally {
      setInternalBusy(false);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[70] bg-foreground/40 transition-opacity duration-150" />
        <DialogPrimitive.Popup
          data-testid="confirm-destructive-dialog"
          className="fixed top-1/2 left-1/2 z-[75] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-foreground shadow-lg"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 text-destructive">
              <Trash2Icon className="size-5 shrink-0" aria-hidden="true" />
              <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                {title}
              </DialogPrimitive.Title>
            </div>
            <DialogPrimitive.Close
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Tutup dialog konfirmasi"
                  className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                />
              }
            >
              <XIcon className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
            {description}
          </DialogPrimitive.Description>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => onOpenChange(false)}
              className="min-h-11 md:min-h-9"
              data-testid="confirm-destructive-cancel"
            >
              {cancelLabel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isSubmitting}
              onClick={() => void handleConfirm()}
              className="min-h-11 md:min-h-9"
              data-testid="confirm-destructive-confirm"
            >
              {isSubmitting ? "Memproses..." : confirmLabel}
            </Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

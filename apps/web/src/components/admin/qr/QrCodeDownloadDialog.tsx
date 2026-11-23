import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Switch } from "@base-ui/react/switch";
import type { CatalogOfferingType } from "@punyasitus/core/catalog/index";
import {
  DEFAULT_QR_BACKGROUND,
  DEFAULT_QR_FOREGROUND,
  DEFAULT_QR_QUIET_ZONE,
  buildCanonicalQrTargetUrl,
  buildQrDownloadFilename,
  buildQrSvgPathData,
  buildTenantQrApiUrl,
  generateQrMatrix,
  type QrResourceStatus,
  type QrTargetKind,
} from "@punyasitus/core/qr/index";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  GlobeIcon,
  InfoIcon,
  QrCodeIcon,
  XIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Reusable Free QR Code Download Dialog (`TASK-108`, `REQ-108`, `DEC-036`, `DESIGN.md §2.1 & §4.2`).
 *
 * - Built strictly on `@base-ui/react` (`Dialog`, `Switch`) + `base-nova` tokens.
 * - Usable across Website Overview, Page list/editor, and Offering list/editor screens.
 * - Draft/unpublished/trashed items offer NO QR code, showing clear notice:
 *   `"Kode QR tersedia setelah diterbitkan"`.
 * - Encodes ONLY the verified canonical primary domain URL with optional `?utm_source=qr` toggle.
 * - Renders crisp live inline SVG directly from the pure-TS QR matrix (zero external QR services).
 * - Responsive at `360px` and `1440px` with `>= 44px` tap targets and Escape focus return.
 */

export interface QrCodeDownloadDialogProps {
  readonly tenantId: string;
  readonly tenantHandle?: string | null;
  readonly primaryOrigin: string;
  readonly targetKind: QrTargetKind;
  readonly targetId?: number | null;
  readonly targetTitle: string;
  readonly offeringType?: CatalogOfferingType | null;
  readonly slug?: string | null;
  readonly isHomepage?: boolean;
  readonly status: QrResourceStatus;
  readonly deletedAt?: number | null;
  readonly defaultIncludeUtmQr?: boolean;
  readonly triggerLabel?: string;
  readonly triggerVariant?: "default" | "outline" | "secondary" | "ghost";
  readonly triggerSize?: "default" | "sm" | "lg";
  readonly apiBasePath?: string;
  readonly className?: string;
  readonly testIdPrefix?: string;
}

const TARGET_KIND_LABEL_ID: Readonly<Record<QrTargetKind, string>> = {
  website: "Website Utama",
  page: "Halaman Terbit",
  offering: "Penawaran Terbit",
};

export function QrCodeDownloadDialog({
  tenantId,
  tenantHandle,
  primaryOrigin,
  targetKind,
  targetId = null,
  targetTitle,
  offeringType = null,
  slug = null,
  isHomepage = false,
  status,
  deletedAt = null,
  defaultIncludeUtmQr = true,
  triggerLabel = "Kode QR",
  triggerVariant = "outline",
  triggerSize = "default",
  apiBasePath,
  className,
  testIdPrefix = "qr",
}: QrCodeDownloadDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [includeUtmQr, setIncludeUtmQr] = React.useState(defaultIncludeUtmQr);
  const [copiedUrl, setCopiedUrl] = React.useState(false);
  const [feedbackMessage, setFeedbackMessage] = React.useState<string | null>(null);

  const isEligible =
    deletedAt === null &&
    (targetKind === "website"
      ? status !== "draft" && status !== "unpublished" && status !== "trashed"
      : status === "published");

  const canonicalUrl = React.useMemo(() => {
    if (!isEligible) return null;
    try {
      return buildCanonicalQrTargetUrl({
        primaryOrigin,
        targetKind,
        offeringType,
        slug,
        isHomepage,
        status: "published",
        deletedAt: null,
        includeUtmQr,
      });
    } catch {
      return null;
    }
  }, [isEligible, primaryOrigin, targetKind, offeringType, slug, isHomepage, includeUtmQr]);

  const qrRenderModel = React.useMemo(() => {
    if (!canonicalUrl) return null;
    try {
      const matrix = generateQrMatrix(canonicalUrl);
      const quietZone = DEFAULT_QR_QUIET_ZONE;
      const totalModules = matrix.size + quietZone * 2;
      const pathData = buildQrSvgPathData(matrix, quietZone);
      return { totalModules, pathData };
    } catch {
      return null;
    }
  }, [canonicalUrl]);

  const svgDownloadUrl = React.useMemo(() => {
    if (!canonicalUrl) return null;
    return buildTenantQrApiUrl({
      tenantId,
      targetKind,
      targetId,
      format: "svg",
      includeUtmQr,
      apiBasePath,
    });
  }, [canonicalUrl, tenantId, targetKind, targetId, includeUtmQr, apiBasePath]);

  const pngDownloadUrl = React.useMemo(() => {
    if (!canonicalUrl) return null;
    return buildTenantQrApiUrl({
      tenantId,
      targetKind,
      targetId,
      format: "png",
      includeUtmQr,
      apiBasePath,
    });
  }, [canonicalUrl, tenantId, targetKind, targetId, includeUtmQr, apiBasePath]);

  const svgFilename = buildQrDownloadFilename({
    targetKind,
    tenantHandle,
    offeringType,
    slug,
    isHomepage,
    format: "svg",
  });

  const pngFilename = buildQrDownloadFilename({
    targetKind,
    tenantHandle,
    offeringType,
    slug,
    isHomepage,
    format: "png",
  });

  async function handleCopyUrl() {
    if (!canonicalUrl) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(canonicalUrl);
      }
      setCopiedUrl(true);
      setFeedbackMessage("URL kode QR berhasil disalin ke papan klip.");
      window.setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      setFeedbackMessage("Gagal menyalin otomatis. Salin URL langsung dari kolom di atas.");
    }
  }

  // Draft, unpublished, or trashed items NEVER offer a QR code (REQ-108)
  if (!isEligible || !canonicalUrl || !qrRenderModel || !svgDownloadUrl || !pngDownloadUrl) {
    return (
      <div
        className={cn(
          "inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-xs font-medium text-muted-foreground",
          className,
        )}
        data-testid={`${testIdPrefix}-draft-notice`}
        data-qr-available="false"
      >
        <QrCodeIcon className="size-4 shrink-0 opacity-60" aria-hidden="true" />
        <span>Kode QR tersedia setelah diterbitkan</span>
      </div>
    );
  }

  const switchId = `${testIdPrefix}-utm-switch-${targetKind}-${targetId ?? "site"}`;
  const switchDescId = `${switchId}-desc`;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setFeedbackMessage(null);
          setCopiedUrl(false);
        }
      }}
    >
      <Dialog.Trigger
        data-testid={`${testIdPrefix}-trigger`}
        data-qr-available="true"
        data-qr-target={targetKind}
        render={
          <Button
            type="button"
            variant={triggerVariant}
            size={triggerSize}
            className={cn("min-h-11 gap-2", className)}
          />
        }
      >
        <QrCodeIcon className="size-4 shrink-0" aria-hidden="true" />
        <span>{triggerLabel}</span>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Backdrop
          data-slot="qr-dialog-backdrop"
          className="fixed inset-0 z-[55] bg-foreground/35 transition-opacity duration-150 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0"
        />
        <Dialog.Popup
          data-testid={`${testIdPrefix}-dialog`}
          data-qr-target={targetKind}
          className="fixed top-1/2 left-1/2 z-[60] flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-lg transition-[opacity,transform] duration-150 ease-out data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Dialog.Title className="text-base font-semibold text-foreground">
                  Kode QR — {targetTitle}
                </Dialog.Title>
                <Badge variant="secondary">{TARGET_KIND_LABEL_ID[targetKind]}</Badge>
              </div>
              <Dialog.Description className="text-xs leading-relaxed text-muted-foreground">
                Unduh kode QR gratis siap cetak (SVG &amp; PNG) untuk domain utama situs Anda.
              </Dialog.Description>
            </div>
            <Dialog.Close
              data-testid={`${testIdPrefix}-close-button`}
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="min-h-11 min-w-11 shrink-0"
                  aria-label="Tutup dialog kode QR"
                />
              }
            >
              <XIcon className="size-4" aria-hidden="true" />
              <span className="sr-only">Tutup dialog kode QR</span>
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3.5 sm:space-y-4 sm:px-5 sm:py-4">
            {/* Live crisp SVG QR preview */}
            <div className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-border bg-background p-3 sm:gap-2 sm:p-4">
              <div className="rounded-md border border-border bg-white p-2 sm:p-2.5">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox={`0 0 ${qrRenderModel.totalModules} ${qrRenderModel.totalModules}`}
                  width="208"
                  height="208"
                  role="img"
                  aria-label={`Pratinjau kode QR untuk ${canonicalUrl}`}
                  shapeRendering="crispEdges"
                  data-testid={`${testIdPrefix}-preview-svg`}
                  data-canonical-url={canonicalUrl}
                  className="block h-36 w-36 max-w-full sm:h-48 sm:w-48"
                >
                  <title>{`Kode QR untuk ${targetTitle}`}</title>
                  <rect
                    width={qrRenderModel.totalModules}
                    height={qrRenderModel.totalModules}
                    fill={DEFAULT_QR_BACKGROUND}
                  />
                  <path d={qrRenderModel.pathData} fill={DEFAULT_QR_FOREGROUND} />
                </svg>
              </div>
              <p className="inline-flex items-center gap-1.5 text-center text-xs text-muted-foreground">
                <GlobeIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span>Menggunakan domain utama terverifikasi secara otomatis</span>
              </p>
            </div>

            {/* Canonical Primary URL Display + Copy */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">URL Tujuan Kode QR</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <code
                  data-testid={`${testIdPrefix}-canonical-url`}
                  className="block min-w-0 flex-1 rounded-md border border-border bg-muted/50 px-3 py-2.5 font-mono text-xs break-all text-foreground"
                >
                  {canonicalUrl}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void handleCopyUrl();
                  }}
                  data-testid={`${testIdPrefix}-copy-url`}
                  className="min-h-11 w-full shrink-0 gap-1.5 sm:w-auto"
                >
                  {copiedUrl ? (
                    <>
                      <CheckIcon className="size-4 text-primary" aria-hidden="true" />
                      <span>Tersalin</span>
                    </>
                  ) : (
                    <>
                      <CopyIcon className="size-4" aria-hidden="true" />
                      <span>Salin URL</span>
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* Base UI Switch for utm_source=qr */}
            <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3.5">
              <div className="min-w-0 space-y-1">
                <label
                  htmlFor={switchId}
                  className="block cursor-pointer text-sm font-medium text-foreground"
                >
                  Sertakan tag pelacakan kunjungan QR (utm_source=qr)
                </label>
                <p id={switchDescId} className="text-xs leading-relaxed text-muted-foreground">
                  Kunjungan melalui kode QR akan otomatis terhitung sebagai pindaian QR di statistik
                  situs tanpa cookie pihak ketiga.
                </p>
              </div>

              <Switch.Root
                id={switchId}
                data-testid={`${testIdPrefix}-utm-toggle`}
                aria-describedby={switchDescId}
                checked={includeUtmQr}
                onCheckedChange={(checked) => {
                  setIncludeUtmQr(checked);
                  setFeedbackMessage(null);
                }}
                className="group relative inline-flex min-h-11 min-w-14 shrink-0 cursor-pointer items-center justify-center rounded-md p-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex h-7 w-12 items-center rounded-full border border-border bg-border p-0.5 transition-colors group-data-[checked]:border-primary group-data-[checked]:bg-primary"
                >
                  <Switch.Thumb className="block size-5.5 rounded-full bg-card shadow-xs transition-transform group-data-[checked]:translate-x-5" />
                </span>
              </Switch.Root>
            </div>

            {feedbackMessage && (
              <Alert variant="info" role="status" aria-live="polite" data-testid={`${testIdPrefix}-feedback`}>
                <InfoIcon className="size-4" aria-hidden="true" />
                <AlertDescription>{feedbackMessage}</AlertDescription>
              </Alert>
            )}
          </div>

          {/* Download Action Footer */}
          <div className="grid grid-cols-1 gap-2 border-t border-border bg-muted/20 px-4 py-3.5 sm:grid-cols-2 sm:px-5">
            <Button
              variant="default"
              data-testid={`${testIdPrefix}-download-svg`}
              className="min-h-11 w-full gap-2"
              render={
                <a href={svgDownloadUrl} download={svgFilename} rel="noopener noreferrer" />
              }
            >
              <DownloadIcon className="size-4 shrink-0" aria-hidden="true" />
              <span>Unduh SVG</span>
            </Button>

            <Button
              variant="outline"
              data-testid={`${testIdPrefix}-download-png`}
              className="min-h-11 w-full gap-2"
              render={
                <a href={pngDownloadUrl} download={pngFilename} rel="noopener noreferrer" />
              }
            >
              <DownloadIcon className="size-4 shrink-0" aria-hidden="true" />
              <span>Unduh PNG</span>
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

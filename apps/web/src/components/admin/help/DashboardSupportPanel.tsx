import * as React from "react";
import {
  resolveDashboardHelpLink,
  type DashboardHelpScreenId,
} from "@punyasitus/core/help/index";
import {
  buildSafeMailtoUrl,
  type DashboardSupportViewModel,
} from "@punyasitus/core/support/index";
import {
  BookOpen,
  Building2,
  Clock,
  ExternalLink,
  HelpCircle,
  Mail,
  MessageCircle,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export interface DashboardSupportCardProps {
  /** Resolved support view model from `resolveDashboardSupportModel` or `loadDashboardSupportContext`. */
  readonly support: DashboardSupportViewModel;
  /** Optional Help Center article base URL for linking the current screen's guide alongside support. */
  readonly helpBaseUrl?: string;
  /** Optional explicit Help Center screen ID (defaults to `support.screenId` when available). */
  readonly helpScreen?: DashboardHelpScreenId;
  /** Whether external links open in a new tab (default `true`). */
  readonly openInNewTab?: boolean;
  /** Compact density when rendered inside a popover dialog. */
  readonly compact?: boolean;
  /** Reserves top-right header space for an overlaid close button when used inside a dialog. */
  readonly hasCloseButton?: boolean;
  readonly className?: string;
}

export function DashboardSupportCard({
  support,
  helpBaseUrl,
  helpScreen,
  openInNewTab = true,
  compact = false,
  hasCloseButton = false,
  className,
}: DashboardSupportCardProps) {
  const effectiveHelpScreen = helpScreen ?? support.screenId ?? undefined;
  const resolvedHelp = React.useMemo(
    () =>
      effectiveHelpScreen
        ? resolveDashboardHelpLink(effectiveHelpScreen, {
            baseUrl: helpBaseUrl,
            from: "dashboard",
          })
        : null,
    [effectiveHelpScreen, helpBaseUrl],
  );

  const linkTargetProps = openInNewTab
    ? { target: "_blank", rel: "noopener noreferrer" }
    : {};

  const { primaryChannel, platformChannel } = support;
  const isAgencyFirst = primaryChannel.kind === "agency";

  return (
    <Card
      size={compact ? "sm" : "default"}
      data-testid="dashboard-support-card"
      data-support-mode={support.mode}
      className={cn("min-w-0", className)}
    >
      <CardHeader className={cn("border-b border-border", hasCloseButton && "pr-12")}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {isAgencyFirst ? (
                <Badge variant="info" data-testid="support-agency-badge">
                  <Building2 className="size-3" aria-hidden="true" />
                  Dikelola Agensi
                </Badge>
              ) : (
                <Badge variant="secondary" data-testid="support-platform-badge">
                  <HelpCircle className="size-3" aria-hidden="true" />
                  Dukungan Resmi
                </Badge>
              )}
              <Badge variant="outline" className="max-w-full truncate">
                {support.screenName}
              </Badge>
            </div>
            <CardTitle className="text-base">
              {isAgencyFirst
                ? `Bantuan melalui ${primaryChannel.agencyName}`
                : "Bantuan & Dukungan WhatsApp"}
            </CardTitle>
            <CardDescription className="text-xs leading-relaxed sm:text-sm">
              {isAgencyFirst
                ? primaryChannel.fallbackNote
                : "Butuh bantuan mengelola situs Anda? Hubungi tim dukungan PunyaSitus pada jam layanan berikut."}
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3.5">
        {isAgencyFirst ? (
          <div
            className="space-y-3"
            data-testid="support-agency-primary-section"
          >
            <div className="rounded-md border border-info-border bg-info-soft/50 p-3">
              <div className="flex items-start gap-2.5">
                <Building2
                  className="mt-0.5 size-4 shrink-0 text-info"
                  aria-hidden="true"
                />
                <div className="min-w-0 space-y-1 text-xs leading-relaxed">
                  <p className="font-semibold text-foreground" data-testid="support-agency-name">
                    {primaryChannel.agencyName}
                  </p>
                  {primaryChannel.whatsappDisplay && (
                    <p
                      className="text-muted-foreground tabular-nums"
                      data-testid="support-agency-whatsapp-number"
                    >
                      WhatsApp Agensi: {primaryChannel.whatsappDisplay}
                    </p>
                  )}
                  {primaryChannel.email && (
                    <p
                      className="break-all text-muted-foreground"
                      data-testid="support-agency-email"
                    >
                      Email Agensi: {primaryChannel.email}
                    </p>
                  )}
                  {primaryChannel.supportHours && (
                    <p className="text-muted-foreground">
                      Jam layanan agensi: {primaryChannel.supportHours}
                    </p>
                  )}
                  {primaryChannel.responseTarget && (
                    <p className="text-muted-foreground">
                      Target respons agensi: {primaryChannel.responseTarget}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {primaryChannel.whatsappUrl ? (
                <Button
                  size="default"
                  className="min-h-11 w-full justify-between md:min-h-9"
                  data-testid="support-agency-whatsapp-cta"
                  render={<a href={primaryChannel.whatsappUrl} {...linkTargetProps} />}
                >
                  <span className="inline-flex min-w-0 items-center gap-2 truncate">
                    <MessageCircle className="size-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">Chat Agensi via WhatsApp</span>
                  </span>
                  <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                </Button>
              ) : null}

              {primaryChannel.mailtoUrl ? (
                <Button
                  variant={primaryChannel.whatsappUrl ? "outline" : "default"}
                  size="default"
                  className="min-h-11 w-full justify-between md:min-h-9"
                  data-testid="support-agency-email-cta"
                  render={<a href={primaryChannel.mailtoUrl} />}
                >
                  <span className="inline-flex min-w-0 items-center gap-2 truncate">
                    <Mail className="size-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">Kirim Email ke Agensi</span>
                  </span>
                  <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                </Button>
              ) : null}

              {!primaryChannel.whatsappUrl && !primaryChannel.mailtoUrl ? (
                <p
                  className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
                  data-testid="support-agency-contact-missing-note"
                >
                  Kontak langsung agensi belum dicantumkan di portal. Silakan hubungi tim{" "}
                  <strong className="font-medium text-foreground">
                    {primaryChannel.agencyName}
                  </strong>{" "}
                  melalui kanal komunikasi yang biasa Anda gunakan.
                </p>
              ) : null}
            </div>

            <div
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
              data-testid="support-context-preview"
            >
              <span className="font-medium text-foreground">Konteks yang dikirim:</span> situs{" "}
              <code className="font-mono text-foreground">{support.handle}</code>, halaman{" "}
              <span className="font-medium text-foreground">{support.screenName}</span>. Tanpa kata
              sandi, token sesi, atau data pengunjung.
            </div>

            <Separator />

            <div
              className="space-y-2.5"
              data-testid="support-platform-fallback-section"
            >
              <div className="space-y-0.5">
                <p className="text-xs font-semibold text-foreground">
                  Dukungan Teknis Platform (Cadangan)
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Jika agensi tidak dapat dihubungi atau terjadi kendala teknis platform PunyaSitus:
                </p>
              </div>

              <div className="rounded-md border border-border bg-muted/30 p-2.5 text-xs">
                <div className="flex items-start gap-2">
                  <Clock
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-foreground" data-testid="support-hours-value">
                      <span className="text-muted-foreground">Jam layanan: </span>
                      {platformChannel.supportHours}
                    </p>
                    <p className="text-foreground" data-testid="support-response-target-value">
                      <span className="text-muted-foreground">Target respons: </span>
                      {platformChannel.responseTarget}
                    </p>
                  </div>
                </div>
              </div>

              {platformChannel.whatsappUrl ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 w-full justify-between md:min-h-9"
                  data-testid="support-platform-fallback-whatsapp-cta"
                  render={<a href={platformChannel.whatsappUrl} {...linkTargetProps} />}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <MessageCircle className="size-3.5 shrink-0" aria-hidden="true" />
                    Hubungi PunyaSitus (Cadangan)
                  </span>
                  <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                </Button>
              ) : platformChannel.mailtoUrl ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 w-full justify-between md:min-h-9"
                  data-testid="support-platform-fallback-email-cta"
                  render={<a href={platformChannel.mailtoUrl} />}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Mail className="size-3.5 shrink-0" aria-hidden="true" />
                    Email PunyaSitus ({platformChannel.email})
                  </span>
                  <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="space-y-3" data-testid="support-platform-primary-section">
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <div className="flex items-start gap-2.5">
                <Clock
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <div className="min-w-0 space-y-1 text-xs leading-relaxed">
                  <p className="font-semibold text-foreground">Jam Layanan &amp; Target Respons</p>
                  <p className="text-foreground" data-testid="support-hours-value">
                    <span className="text-muted-foreground">Jam layanan: </span>
                    {platformChannel.supportHours}
                  </p>
                  <p className="text-foreground" data-testid="support-response-target-value">
                    <span className="text-muted-foreground">Target respons: </span>
                    {platformChannel.responseTarget}
                  </p>
                  {platformChannel.whatsappDisplay && (
                    <p
                      className="text-muted-foreground tabular-nums"
                      data-testid="support-platform-whatsapp-number"
                    >
                      WhatsApp: {platformChannel.whatsappDisplay}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {platformChannel.whatsappUrl ? (
              <Button
                size="default"
                className="min-h-11 w-full justify-between md:min-h-9"
                data-testid="support-whatsapp-cta"
                render={<a href={platformChannel.whatsappUrl} {...linkTargetProps} />}
              >
                <span className="inline-flex items-center gap-2">
                  <MessageCircle className="size-4 shrink-0" aria-hidden="true" />
                  <span>Hubungi Dukungan via WhatsApp</span>
                </span>
                <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
              </Button>
            ) : (
              <div
                className="rounded-md border border-warning-border bg-warning-soft/60 px-3 py-2.5 text-xs leading-relaxed text-foreground"
                data-testid="support-whatsapp-unconfigured"
              >
                <p className="font-medium">Nomor WhatsApp dukungan belum dikonfigurasi.</p>
                {(() => {
                  const safeMailto =
                    platformChannel.mailtoUrl ??
                    buildSafeMailtoUrl(platformChannel.email, support.handle, support.screenName);
                  return safeMailto && platformChannel.email ? (
                    <p className="mt-1 text-muted-foreground">
                      Sementara itu Anda dapat mengirim email ke{" "}
                      <a
                        href={safeMailto}
                        className="font-medium text-primary underline underline-offset-4"
                      >
                        {platformChannel.email}
                      </a>
                      .
                    </p>
                  ) : (
                    <p className="mt-1 text-muted-foreground">
                      Operator platform dapat mengaturnya melalui Pengaturan Platform di Console.
                    </p>
                  );
                })()}
              </div>
            )}

            <div
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
              data-testid="support-context-preview"
            >
              <span className="font-medium text-foreground">Konteks otomatis:</span> situs{" "}
              <code className="font-mono text-foreground">{support.handle}</code>, halaman{" "}
              <span className="font-medium text-foreground">{support.screenName}</span>. Tanpa kata
              sandi, token sesi, atau data pengunjung.
            </div>
          </div>
        )}

        {resolvedHelp && (
          <>
            <Separator />
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 w-full justify-between md:min-h-9"
              data-testid="support-related-guide-link"
              render={<a href={resolvedHelp.href} {...linkTargetProps} />}
            >
              <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                <BookOpen className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span className="truncate">Baca panduan: {resolvedHelp.screenLabel}</span>
              </span>
              <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export interface DashboardSupportButtonProps {
  /** Resolved support view model from `resolveDashboardSupportModel` or `loadDashboardSupportContext`. */
  readonly support: DashboardSupportViewModel;
  /** Optional custom button label (default `"Bantuan"`). */
  readonly label?: string;
  /** Optional custom Help Center base URL to also link the screen guide inside the panel. */
  readonly helpBaseUrl?: string;
  /** Optional explicit Help Center screen ID. */
  readonly helpScreen?: DashboardHelpScreenId;
  /** Popover horizontal alignment on wider screens (default `"end"`). */
  readonly align?: "start" | "end";
  /** Whether links open in a new tab (default `true`). */
  readonly openInNewTab?: boolean;
  /** Optional initial open state (useful for visual/SSR verification). */
  readonly defaultOpen?: boolean;
  readonly className?: string;
}

/**
 * Accessible dashboard support trigger button that opens a floating support panel
 * with WhatsApp click-to-chat context, published support hours, response target,
 * and agency-first contact routing (REQ-105, REQ-083, TASK-105).
 */
export function DashboardSupportButton({
  support,
  label = "Bantuan",
  helpBaseUrl,
  helpScreen,
  align = "end",
  openInNewTab = true,
  defaultOpen = false,
  className,
}: DashboardSupportButtonProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const panelId = React.useId();

  React.useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    function handlePointerDown(event: MouseEvent) {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className={cn("relative inline-flex items-center", className)}
      data-support-mode={support.mode}
    >
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
        data-testid="dashboard-support-trigger"
        className="min-h-11 md:min-h-9"
        onClick={() => setOpen((prev) => !prev)}
      >
        {support.mode === "agency_first" ? (
          <Building2 className="size-4 text-primary" aria-hidden="true" />
        ) : (
          <MessageCircle className="size-4 text-primary" aria-hidden="true" />
        )}
        <span>{label}</span>
      </Button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={
            support.primaryChannel.kind === "agency"
              ? `Panel bantuan agensi ${support.primaryChannel.agencyName}`
              : "Panel bantuan & dukungan WhatsApp"
          }
          data-testid="dashboard-support-panel"
          className={cn(
            "fixed inset-x-3 top-16 z-50 max-h-[calc(100vh-9.5rem)] overflow-y-auto rounded-lg bg-card shadow-lg sm:absolute sm:inset-x-auto sm:top-full sm:mt-2 sm:w-96 sm:max-h-none sm:overflow-visible",
            align === "end" ? "sm:right-0" : "sm:left-0",
          )}
        >
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              aria-label="Tutup panel bantuan"
              data-testid="dashboard-support-close"
              className="absolute top-2.5 right-2.5 z-10 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-8 md:min-w-8"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
            <DashboardSupportCard
              support={support}
              helpBaseUrl={helpBaseUrl}
              helpScreen={helpScreen}
              openInNewTab={openInNewTab}
              compact
              hasCloseButton
              className="shadow-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}

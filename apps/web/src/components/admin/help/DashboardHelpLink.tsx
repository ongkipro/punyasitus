import * as React from "react";
import {
  resolveDashboardHelpLink,
  type DashboardHelpScreenId,
} from "@punyasitus/core/help/index";
import type { DashboardSupportViewModel } from "@punyasitus/core/support/index";
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
import { cn } from "@/lib/utils";

export interface DashboardHelpLinkProps {
  /** Typed dashboard screen ID mapped in `DASHBOARD_HELP_LINKS` (`packages/core/src/help/registry.ts`). */
  readonly screen: DashboardHelpScreenId;
  /**
   * Presentation variant:
   * - `"popover"` (default): keyboard-accessible help icon opening a concise summary card with link to `/bantuan/<slug>`.
   * - `"icon"`: direct accessible icon link to `/bantuan/<slug>`.
   * - `"inline"`: compact labelled help button/link.
   */
  readonly variant?: "popover" | "icon" | "inline";
  /** Optional custom Help Center base URL (defaults to `https://punyasitus.com/bantuan`). */
  readonly helpBaseUrl?: string;
  /** Whether clicking the article link opens a new tab (default `true`). */
  readonly openInNewTab?: boolean;
  /** Popover horizontal alignment relative to the trigger (default `"end"`). */
  readonly align?: "start" | "end";
  /** Optional visible label for `"inline"` or `"popover"` variants. */
  readonly label?: string;
  /** Optional WhatsApp support view model (REQ-105) rendered inside the popover beneath the guide link. */
  readonly support?: DashboardSupportViewModel | null;
  readonly className?: string;
}

export function DashboardHelpLink({
  screen,
  variant = "popover",
  helpBaseUrl,
  openInNewTab = true,
  align = "end",
  label,
  support = null,
  className,
}: DashboardHelpLinkProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const popoverId = React.useId();

  const resolved = React.useMemo(
    () =>
      resolveDashboardHelpLink(screen, {
        baseUrl: helpBaseUrl,
        from: "dashboard",
      }),
    [screen, helpBaseUrl],
  );

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

  const linkTargetProps = openInNewTab
    ? { target: "_blank", rel: "noopener noreferrer" }
    : {};

  if (variant === "icon") {
    return (
      <Button
        variant="outline"
        size="icon-sm"
        className={cn("min-h-11 min-w-11 md:min-h-8 md:min-w-8", className)}
        aria-label={`Bantuan untuk ${resolved.screenLabel}`}
        title={`${resolved.title} (${resolved.readingMinutes} menit baca)`}
        data-help-screen={screen}
        data-help-slug={resolved.helpSlug}
        data-testid={`dashboard-help-link-${screen}`}
        render={<a href={resolved.href} {...linkTargetProps} />}
      >
        <HelpCircle className="size-4 shrink-0 text-primary" aria-hidden="true" />
      </Button>
    );
  }

  if (variant === "inline") {
    return (
      <Button
        variant="outline"
        size="sm"
        className={cn("min-h-11 md:min-h-8", className)}
        data-help-screen={screen}
        data-help-slug={resolved.helpSlug}
        data-testid={`dashboard-help-link-${screen}`}
        render={<a href={resolved.href} {...linkTargetProps} />}
      >
        <HelpCircle className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span>{label ?? "Panduan"}</span>
        <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </Button>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn("relative inline-flex items-center", className)}
      data-help-screen={screen}
      data-help-slug={resolved.helpSlug}
    >
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size={label ? "sm" : "icon-sm"}
        aria-label={label ? undefined : `Bantuan untuk ${resolved.screenLabel}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        title={`Bantuan: ${resolved.title}`}
        data-testid={`dashboard-help-trigger-${screen}`}
        className={cn(
          label ? "min-h-11 md:min-h-8" : "min-h-11 min-w-11 md:min-h-8 md:min-w-8",
        )}
        onClick={() => setOpen((prev) => !prev)}
      >
        <HelpCircle className="size-4 shrink-0 text-primary" aria-hidden="true" />
        {label && <span>{label}</span>}
      </Button>

      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label={`Panduan ${resolved.screenLabel}`}
          data-testid={`dashboard-help-popover-${screen}`}
          className={cn(
            "fixed inset-x-4 top-16 z-50 rounded-lg border border-border bg-card p-4 text-left shadow-sm sm:absolute sm:inset-x-auto sm:top-full sm:mt-2 sm:w-80",
            align === "end" ? "sm:right-0" : "sm:left-0",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{resolved.categoryLabel}</Badge>
              <span className="text-xs text-muted-foreground tabular-nums">
                {resolved.readingMinutes} menit baca
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              aria-label="Tutup panel bantuan"
              data-testid={`dashboard-help-close-${screen}`}
              className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>

          <div className="mt-2.5 space-y-1.5">
            <p className="text-sm font-semibold leading-snug text-foreground">
              {resolved.title}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {resolved.summary}
            </p>
          </div>

          <div className="mt-3.5 flex flex-col gap-2 border-t border-border pt-3">
            <Button
              size="sm"
              className="min-h-11 w-full justify-between md:min-h-9"
              data-testid={`dashboard-help-article-cta-${screen}`}
              render={<a href={resolved.href} {...linkTargetProps} />}
            >
              <span className="inline-flex items-center gap-1.5">
                <BookOpen className="size-3.5" aria-hidden="true" />
                Baca panduan lengkap
              </span>
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </Button>

            <a
              href={resolved.indexHref}
              {...linkTargetProps}
              data-testid={`dashboard-help-index-link-${screen}`}
              className="inline-flex min-h-9 items-center justify-center rounded-md px-2 text-xs font-medium text-muted-foreground underline-offset-4 transition-colors hover:bg-muted hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Lihat semua panduan di Pusat Bantuan
            </a>
          </div>

          {support && (
            <div
              className="mt-3 space-y-2 border-t border-border pt-3"
              data-testid={`dashboard-help-support-section-${screen}`}
              data-support-mode={support.mode}
            >
              {support.primaryChannel.kind === "agency" ? (
                <>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <Building2 className="size-3.5 shrink-0 text-info" aria-hidden="true" />
                    <span className="truncate">
                      Dukungan Agensi: {support.primaryChannel.agencyName}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {support.primaryChannel.fallbackNote}
                  </p>
                  {support.primaryChannel.whatsappUrl ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 w-full justify-between md:min-h-9"
                      data-testid={`dashboard-help-agency-wa-${screen}`}
                      render={
                        <a
                          href={support.primaryChannel.whatsappUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        />
                      }
                    >
                      <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                        <MessageCircle className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                        <span className="truncate">
                          Chat {support.primaryChannel.agencyName}
                        </span>
                      </span>
                      <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                    </Button>
                  ) : support.primaryChannel.mailtoUrl ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 w-full justify-between md:min-h-9"
                      data-testid={`dashboard-help-agency-email-${screen}`}
                      render={<a href={support.primaryChannel.mailtoUrl} />}
                    >
                      <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                        <Mail className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                        <span className="truncate">
                          Email {support.primaryChannel.agencyName}
                        </span>
                      </span>
                      <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                    </Button>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Clock className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                    <div className="min-w-0 space-y-0.5">
                      <p className="font-medium text-foreground">
                        {support.platformChannel.supportHours}
                      </p>
                      <p>Target respons: {support.platformChannel.responseTarget}</p>
                    </div>
                  </div>
                  {support.platformChannel.whatsappUrl && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 w-full justify-between md:min-h-9"
                      data-testid={`dashboard-help-whatsapp-cta-${screen}`}
                      render={
                        <a
                          href={support.platformChannel.whatsappUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        />
                      }
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <MessageCircle className="size-3.5 text-primary" aria-hidden="true" />
                        Hubungi Dukungan via WhatsApp
                      </span>
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

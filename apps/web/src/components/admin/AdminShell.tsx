import * as React from "react";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BriefcaseIcon,
  Building2Icon,
  ExternalLinkIcon,
  FileTextIcon,
  GlobeIcon,
  HomeIcon,
  ImageIcon,
  InboxIcon,
  LayersIcon,
  LayoutGridIcon,
  Link2Icon,
  MegaphoneIcon,
  MenuIcon,
  NewspaperIcon,
  PaletteIcon,
  PlugIcon,
  ReceiptTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { LifecycleBanner } from "./LifecycleBanner";
import {
  getMobileBottomTabs,
  getSecondaryDrawerLinks,
  getSidebarNavItems,
  type AdminSurface,
  type AgencyClientContext,
  type LifecycleStatus,
  type NavIconId,
} from "./navigation";

const ICON_MAP: Record<NavIconId, React.ComponentType<{ className?: string }>> = {
  home: HomeIcon,
  inbox: InboxIcon,
  briefcase: BriefcaseIcon,
  "file-text": FileTextIcon,
  newspaper: NewspaperIcon,
  image: ImageIcon,
  palette: PaletteIcon,
  plug: PlugIcon,
  settings: SettingsIcon,
  building: Building2Icon,
  receipt: ReceiptTextIcon,
  users: UsersIcon,
  link: Link2Icon,
  wallet: WalletIcon,
  megaphone: MegaphoneIcon,
  globe: GlobeIcon,
  layers: LayersIcon,
  "shield-check": ShieldCheckIcon,
  activity: ActivityIcon,
  more: MenuIcon,
  "layout-grid": LayoutGridIcon,
};

function NavIcon({ id, className }: { id: NavIconId; className?: string }) {
  const Icon = ICON_MAP[id];
  return <Icon className={cn("size-4 shrink-0", className)} aria-hidden="true" />;
}

export interface AdminShellProps {
  surface: AdminSurface;
  workspaceName: string;
  workspaceSubtitle?: string;
  activeNavId?: string;
  basePath?: string;
  offeringLabel?: string;
  unreadLeadsCount?: number;
  lifecycleStatus?: LifecycleStatus;
  lifecycleDaysRemaining?: number;
  lifecycleReason?: string;
  agencyClientContext?: AgencyClientContext;
  publicSiteHref?: string;
  userDisplayName?: string;
  userRoleLabel?: string;
  children?: React.ReactNode;
}

export function AdminShell({
  surface,
  workspaceName,
  workspaceSubtitle,
  activeNavId = "home",
  basePath = "",
  offeringLabel = "Layanan",
  unreadLeadsCount = 0,
  lifecycleStatus = "active",
  lifecycleDaysRemaining = 7,
  lifecycleReason,
  agencyClientContext,
  publicSiteHref,
  userDisplayName = "Budi Santoso",
  userRoleLabel,
  children,
}: AdminShellProps) {
  const [moreOpen, setMoreOpen] = React.useState(false);

  const navItems = React.useMemo(
    () =>
      getSidebarNavItems(surface, {
        basePath,
        offeringLabel,
        unreadLeadsCount,
      }),
    [surface, basePath, offeringLabel, unreadLeadsCount],
  );

  const mobileTabs = React.useMemo(
    () =>
      getMobileBottomTabs(surface, {
        basePath,
        unreadLeadsCount,
      }),
    [surface, basePath, unreadLeadsCount],
  );

  const secondaryLinks = React.useMemo(
    () => getSecondaryDrawerLinks(surface, basePath),
    [surface, basePath],
  );

  const isConsole = surface === "console";
  const resolvedRoleLabel =
    userRoleLabel ??
    (surface === "console"
      ? "Operator Platform"
      : surface === "agency"
        ? "Admin Agensi"
        : surface === "affiliate"
          ? "Mitra Afiliasi"
          : "Pemilik Situs");

  return (
    <div
      data-admin-surface={surface}
      className="min-h-dvh bg-background text-foreground"
    >
      <a
        href="#konten-utama"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Lewati ke konten utama
      </a>

      <div className="flex min-h-dvh w-full">
        {/* Desktop (256px) and Tablet icon-rail (48px) sidebar */}
        <aside
          data-slot="sidebar-container"
          aria-label="Navigasi utama"
          className="hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:sticky md:top-0 md:flex md:h-dvh md:w-12 lg:w-64"
        >
          <div className="flex h-14 items-center justify-center border-b border-sidebar-border px-2 lg:justify-between lg:px-4">
            <div className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
              >
                PS
              </span>
              <div className="hidden min-w-0 lg:block">
                <p className="truncate text-sm font-semibold leading-tight text-sidebar-foreground">
                  {isConsole ? "PunyaSitus Ops" : workspaceName}
                </p>
                {workspaceSubtitle && (
                  <p className="truncate text-xs text-muted-foreground">
                    {workspaceSubtitle}
                  </p>
                )}
              </div>
            </div>
          </div>

          <nav className="flex-1 overflow-y-auto px-1.5 py-3 lg:px-3" aria-label="Menu navigasi">
            <ul className="space-y-1">
              {navItems.map((item) => {
                const isActive = item.id === activeNavId;
                return (
                  <li key={item.id}>
                    <a
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      title={item.label}
                      aria-label={item.label}
                      className={cn(
                        "relative flex h-9 items-center justify-center rounded-md text-sm font-medium transition-colors lg:justify-between lg:px-2.5",
                        isActive
                          ? "bg-sidebar-accent text-sidebar-primary"
                          : "text-sidebar-foreground hover:bg-muted",
                      )}
                    >
                      {isActive && (
                        <span
                          aria-hidden="true"
                          className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-sm bg-sidebar-primary"
                        />
                      )}
                      <span className="flex min-w-0 items-center gap-2.5">
                        <NavIcon
                          id={item.icon}
                          className={
                            isActive ? "text-sidebar-primary" : "text-muted-foreground"
                          }
                        />
                        <span className="hidden truncate lg:inline">{item.label}</span>
                      </span>
                      {typeof item.badgeCount === "number" && item.badgeCount > 0 && (
                        <span className="hidden rounded-md bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground tabular-nums lg:inline-flex">
                          {item.badgeCount}
                        </span>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="border-t border-sidebar-border p-2 lg:px-4 lg:py-3">
            <div className="hidden lg:block">
              <p className="truncate text-sm font-medium text-sidebar-foreground">
                {userDisplayName}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {resolvedRoleLabel}
              </p>
            </div>
            <div className="flex justify-center lg:hidden" title={`${userDisplayName} (${resolvedRoleLabel})`}>
              <span className="flex size-7 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-foreground">
                {userDisplayName.slice(0, 1).toUpperCase()}
              </span>
            </div>
          </div>
        </aside>

        {/* Right column: top bar + optional agency client context + main canvas */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header
            data-slot="admin-topbar"
            className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 md:px-6"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              {isConsole ? (
                <>
                  <Badge variant="outline" data-testid="console-identity-badge">
                    Console Operasional Platform
                  </Badge>
                  <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                    Akses istimewa — bukan penyamaran akun tenant
                  </span>
                </>
              ) : (
                <>
                  <span className="truncate text-sm font-semibold text-foreground md:text-base">
                    {workspaceName}
                  </span>
                  {surface === "agency" && (
                    <Badge variant="secondary">Portal Agensi</Badge>
                  )}
                  {surface === "affiliate" && (
                    <Badge variant="secondary">Portal Afiliasi</Badge>
                  )}
                </>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {publicSiteHref && !isConsole && (
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 md:min-h-8"
                  render={
                    <a
                      href={publicSiteHref}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                >
                  <span>Lihat situs</span>
                  <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                </Button>
              )}
            </div>
          </header>

          {agencyClientContext && !isConsole && (
            <div
              data-testid="agency-client-context-bar"
              role="region"
              aria-label="Konteks pengelolaan situs klien"
              className="flex flex-wrap items-center justify-between gap-2 border-b border-info-border bg-info-soft px-4 py-2 text-xs text-info md:px-6 md:text-sm"
            >
              <p className="min-w-0">
                Anda sedang mengelola situs klien:{" "}
                <strong className="font-semibold">
                  {agencyClientContext.clientName}
                </strong>{" "}
                <span className="font-mono text-xs">
                  ({agencyClientContext.clientHandle})
                </span>
              </p>
              <a
                href={agencyClientContext.returnHref}
                className="inline-flex min-h-11 items-center gap-1.5 font-medium underline underline-offset-4 hover:opacity-80 md:min-h-8"
              >
                <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
                Kembali ke Portal Agensi
              </a>
            </div>
          )}

          <main
            id="konten-utama"
            tabIndex={-1}
            className="mx-auto w-full max-w-[80rem] flex-1 space-y-5 px-4 py-4 pb-24 focus:outline-none md:px-6 md:py-6 md:pb-8"
          >
            {!isConsole && (
              <LifecycleBanner
                status={lifecycleStatus}
                daysRemaining={lifecycleDaysRemaining}
                reason={lifecycleReason}
              />
            )}
            {children}
          </main>
        </div>
      </div>

      {/* Mobile (<768px) 5-slot bottom navigation bar + accessible "Lainnya" Sheet */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <nav
          data-slot="mobile-bottom-nav"
          aria-label="Navigasi seluler"
          className="fixed inset-x-0 bottom-0 z-40 grid h-16 grid-cols-5 border-t border-border bg-card md:hidden"
        >
          {mobileTabs.map((tab) => {
            const isActive = tab.id === activeNavId;
            if (tab.opensMoreDrawer) {
              return (
                <SheetTrigger
                  key={tab.id}
                  data-testid="mobile-more-trigger"
                  aria-label="Menu lainnya"
                  className={cn(
                    "flex min-h-11 flex-col items-center justify-center gap-0.5 px-1 text-xs font-medium transition-colors",
                    moreOpen
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <NavIcon id={tab.icon} className="size-4" />
                  <span className="truncate max-w-full">{tab.label}</span>
                </SheetTrigger>
              );
            }

            return (
              <a
                key={tab.id}
                href={tab.href}
                aria-label={tab.ariaLabel ?? tab.label}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex min-h-11 flex-col items-center justify-center gap-0.5 px-1 text-xs font-medium transition-colors",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="relative inline-flex items-center justify-center">
                  <NavIcon id={tab.icon} className="size-4" />
                  {typeof tab.badgeCount === "number" && tab.badgeCount > 0 && (
                    <span className="sr-only"> ({tab.badgeCount} belum dibaca)</span>
                  )}
                </span>
                <span className="truncate max-w-full">{tab.label}</span>
              </a>
            );
          })}
        </nav>

        <SheetContent side="bottom" data-testid="mobile-more-drawer">
          <SheetHeader>
            <SheetTitle>Menu Lainnya</SheetTitle>
            <SheetDescription>
              {isConsole
                ? "Navigasi lengkap Console Operasional Platform"
                : `Semua modul untuk ${workspaceName}`}
            </SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-4 pb-6">
            <ul className="space-y-1">
              {navItems.map((item) => {
                const isActive = item.id === activeNavId;
                return (
                  <li key={item.id}>
                    <a
                      href={item.href}
                      onClick={() => setMoreOpen(false)}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex min-h-11 items-center justify-between rounded-md px-3 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-muted text-primary"
                          : "text-foreground hover:bg-muted",
                      )}
                    >
                      <span className="flex items-center gap-2.5">
                        <NavIcon
                          id={item.icon}
                          className={isActive ? "text-primary" : "text-muted-foreground"}
                        />
                        <span>{item.label}</span>
                      </span>
                      {typeof item.badgeCount === "number" && item.badgeCount > 0 && (
                        <Badge variant="default" className="tabular-nums">
                          {item.badgeCount}
                        </Badge>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>

            {secondaryLinks.length > 0 && (
              <>
                <Separator className="my-3" />
                <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">
                  Lanjutan
                </p>
                <ul className="space-y-1">
                  {secondaryLinks.map((item) => (
                    <li key={item.id}>
                      <a
                        href={item.href}
                        onClick={() => setMoreOpen(false)}
                        className="flex min-h-11 items-center gap-2.5 rounded-md px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                      >
                        <NavIcon id={item.icon} className="text-muted-foreground" />
                        <span>{item.label}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

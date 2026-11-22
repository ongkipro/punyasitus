export type AdminSurface = "dashboard" | "agency" | "affiliate" | "console";

export type LifecycleStatus =
  | "active"
  | "trial"
  | "grace"
  | "locked"
  | "suspended";

export type NavIconId =
  | "home"
  | "inbox"
  | "briefcase"
  | "file-text"
  | "newspaper"
  | "image"
  | "palette"
  | "plug"
  | "settings"
  | "building"
  | "receipt"
  | "users"
  | "link"
  | "wallet"
  | "megaphone"
  | "globe"
  | "layers"
  | "shield-check"
  | "activity"
  | "more"
  | "layout-grid";

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: NavIconId;
  badgeCount?: number;
}

export interface MobileTabItem {
  id: string;
  label: string;
  ariaLabel?: string;
  href?: string;
  icon: NavIconId;
  badgeCount?: number;
  opensMoreDrawer?: boolean;
}

export interface AgencyClientContext {
  agencyName: string;
  clientName: string;
  clientHandle: string;
  returnHref: string;
}

export function getSidebarNavItems(
  surface: AdminSurface,
  opts?: {
    basePath?: string;
    offeringLabel?: string;
    unreadLeadsCount?: number;
  },
): NavItem[] {
  const base = opts?.basePath ?? "";
  const offeringLabel = opts?.offeringLabel?.trim() || "Layanan";
  const unread = opts?.unreadLeadsCount ?? 0;

  switch (surface) {
    case "dashboard":
      // Strict 9-item WordPress-familiar cap (DESIGN.md §3.1)
      return [
        { id: "home", label: "Beranda", href: `${base}`, icon: "home" },
        {
          id: "leads",
          label: "Pesan Masuk",
          href: `${base}#pesan-masuk`,
          icon: "inbox",
          badgeCount: unread > 0 ? unread : undefined,
        },
        {
          id: "offering",
          label: offeringLabel,
          href: `${base}#penawaran`,
          icon: "briefcase",
        },
        {
          id: "pages",
          label: "Halaman",
          href: `${base}#halaman`,
          icon: "file-text",
        },
        {
          id: "articles",
          label: "Artikel",
          href: `${base}#artikel`,
          icon: "newspaper",
        },
        {
          id: "media",
          label: "Media",
          href: `${base}#media`,
          icon: "image",
        },
        {
          id: "theme",
          label: "Tema",
          href: `${base}#tema`,
          icon: "palette",
        },
        {
          id: "plugins",
          label: "Plugin",
          href: `${base}#plugin`,
          icon: "plug",
        },
        {
          id: "settings",
          label: "Pengaturan",
          href: `${base}#pengaturan`,
          icon: "settings",
        },
      ];

    case "agency":
      return [
        { id: "home", label: "Beranda", href: `${base}`, icon: "home" },
        {
          id: "clients",
          label: "Daftar Klien",
          href: `${base}#klien`,
          icon: "building",
        },
        {
          id: "billing",
          label: "Tagihan & Kuota",
          href: `${base}#tagihan`,
          icon: "receipt",
        },
        {
          id: "themes",
          label: "Template & Tema",
          href: `${base}#tema`,
          icon: "palette",
        },
        {
          id: "team",
          label: "Tim Agensi",
          href: `${base}#tim`,
          icon: "users",
        },
        {
          id: "settings",
          label: "Pengaturan",
          href: `${base}#pengaturan`,
          icon: "settings",
        },
      ];

    case "affiliate":
      return [
        { id: "home", label: "Beranda", href: `${base}`, icon: "home" },
        {
          id: "links",
          label: "Tautan Referral",
          href: `${base}#tautan`,
          icon: "link",
        },
        {
          id: "commissions",
          label: "Komisi",
          href: `${base}#komisi`,
          icon: "receipt",
        },
        {
          id: "payouts",
          label: "Pencairan",
          href: `${base}#pencairan`,
          icon: "wallet",
        },
        {
          id: "materials",
          label: "Materi Promosi",
          href: `${base}#materi`,
          icon: "megaphone",
        },
        {
          id: "settings",
          label: "Pengaturan",
          href: `${base}#pengaturan`,
          icon: "settings",
        },
      ];

    case "console":
      return [
        { id: "home", label: "Ringkasan", href: `${base}`, icon: "home" },
        {
          id: "tenants",
          label: "Tenant",
          href: `${base}#tenant`,
          icon: "building",
        },
        {
          id: "agencies",
          label: "Agensi",
          href: `${base}#agensi`,
          icon: "users",
        },
        {
          id: "affiliates",
          label: "Afiliasi",
          href: `${base}#afiliasi`,
          icon: "link",
        },
        {
          id: "domains",
          label: "Domain & SSL",
          href: `${base}#domain`,
          icon: "globe",
        },
        {
          id: "queues",
          label: "Antrean & Jobs",
          href: `${base}#antrean`,
          icon: "layers",
        },
        {
          id: "audit",
          label: "Audit Log",
          href: `${base}#audit`,
          icon: "shield-check",
        },
        {
          id: "status",
          label: "Status Layanan",
          href: `${base}#status`,
          icon: "activity",
        },
        {
          id: "settings",
          label: "Pengaturan",
          href: `${base}#pengaturan`,
          icon: "settings",
        },
      ];
  }
}

export function getMobileBottomTabs(
  surface: AdminSurface,
  opts?: {
    basePath?: string;
    unreadLeadsCount?: number;
  },
): MobileTabItem[] {
  const base = opts?.basePath ?? "";
  const unread = opts?.unreadLeadsCount ?? 0;

  switch (surface) {
    case "dashboard":
      // Exact 5-slot mobile bottom bar (DESIGN.md §3.1) sized to never truncate at 360px
      return [
        { id: "home", label: "Beranda", href: `${base}`, icon: "home" },
        {
          id: "offering",
          label: "Konten",
          href: `${base}#penawaran`,
          icon: "layout-grid",
        },
        {
          id: "leads",
          label: "Pesan",
          ariaLabel: "Pesan masuk",
          href: `${base}#pesan-masuk`,
          icon: "inbox",
          badgeCount: unread > 0 ? unread : undefined,
        },
        {
          id: "theme",
          label: "Tema",
          ariaLabel: "Tema dan Plugin",
          href: `${base}#tema`,
          icon: "palette",
        },
        {
          id: "more",
          label: "Lainnya",
          icon: "more",
          opensMoreDrawer: true,
        },
      ];

    case "agency":
      return [
        { id: "home", label: "Ringkasan", href: `${base}`, icon: "home" },
        {
          id: "clients",
          label: "Klien",
          href: `${base}#klien`,
          icon: "building",
        },
        {
          id: "billing",
          label: "Tagihan",
          href: `${base}#tagihan`,
          icon: "receipt",
        },
        {
          id: "themes",
          label: "Tema",
          href: `${base}#tema`,
          icon: "palette",
        },
        {
          id: "more",
          label: "Lainnya",
          icon: "more",
          opensMoreDrawer: true,
        },
      ];

    case "affiliate":
      return [
        { id: "home", label: "Ringkasan", href: `${base}`, icon: "home" },
        {
          id: "links",
          label: "Tautan",
          href: `${base}#tautan`,
          icon: "link",
        },
        {
          id: "commissions",
          label: "Komisi",
          href: `${base}#komisi`,
          icon: "receipt",
        },
        {
          id: "payouts",
          label: "Pencairan",
          href: `${base}#pencairan`,
          icon: "wallet",
        },
        {
          id: "more",
          label: "Lainnya",
          icon: "more",
          opensMoreDrawer: true,
        },
      ];

    case "console":
      return [
        { id: "home", label: "Ringkasan", href: `${base}`, icon: "home" },
        {
          id: "tenants",
          label: "Tenant",
          href: `${base}#tenant`,
          icon: "building",
        },
        {
          id: "domains",
          label: "Domain",
          href: `${base}#domain`,
          icon: "globe",
        },
        {
          id: "queues",
          label: "Antrean",
          href: `${base}#antrean`,
          icon: "layers",
        },
        {
          id: "more",
          label: "Lainnya",
          icon: "more",
          opensMoreDrawer: true,
        },
      ];
  }
}

export function getSecondaryDrawerLinks(
  surface: AdminSurface,
  basePath = "",
): NavItem[] {
  if (surface === "dashboard") {
    return [
      { id: "seo", label: "SEO & Redirect", href: `${basePath}#seo`, icon: "globe" },
      { id: "insights", label: "Statistik", href: `${basePath}#statistik`, icon: "activity" },
      { id: "billing", label: "Langganan", href: `${basePath}#langganan`, icon: "receipt" },
      { id: "security", label: "Akun & Keamanan", href: `${basePath}#keamanan`, icon: "shield-check" },
    ];
  }
  return [];
}

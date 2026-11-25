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
  const base = (opts?.basePath ?? "").replace(/\/+$/, "");
  const offeringLabel = opts?.offeringLabel?.trim() || "Layanan";
  const unread = opts?.unreadLeadsCount ?? 0;

  switch (surface) {
    case "dashboard":
      // Strict 9-item WordPress-familiar cap (DESIGN.md §3.1)
      return [
        { id: "home", label: "Beranda", href: base || "/", icon: "home" },
        {
          id: "leads",
          label: "Pesan Masuk",
          href: `${base}/leads`,
          icon: "inbox",
          badgeCount: unread > 0 ? unread : undefined,
        },
        {
          id: "offering",
          label: offeringLabel,
          href: `${base}/catalog`,
          icon: "briefcase",
        },
        {
          id: "pages",
          label: "Halaman",
          href: `${base}/pages`,
          icon: "file-text",
        },
        {
          id: "articles",
          label: "Artikel",
          href: `${base}/posts`,
          icon: "newspaper",
        },
        {
          id: "media",
          label: "Media",
          href: `${base}/media`,
          icon: "image",
        },
        {
          id: "theme",
          label: "Tema",
          href: `${base}/appearance`,
          icon: "palette",
        },
        {
          id: "plugins",
          label: "Plugin",
          href: `${base}/plugins`,
          icon: "plug",
        },
        {
          id: "settings",
          label: "Pengaturan",
          href: `${base}/settings`,
          icon: "settings",
        },
      ];

    case "agency":
      return [
        { id: "home", label: "Beranda", href: base || "/agency", icon: "home" },
        {
          id: "clients",
          label: "Daftar Klien",
          href: `${base}/clients`,
          icon: "building",
        },
        {
          id: "billing",
          label: "Tagihan & Kuota",
          href: `${base}/billing`,
          icon: "receipt",
        },
        {
          id: "plugins",
          label: "Add-on Plugin",
          href: `${base}/plugins`,
          icon: "plug",
        },
        {
          id: "settings",
          label: "Akun & Keamanan",
          href: "/account",
          icon: "settings",
        },
      ];

    case "affiliate":
      return [
        { id: "home", label: "Beranda", href: base || "/affiliate", icon: "home" },
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
          id: "settings",
          label: "Akun & Keamanan",
          href: "/account",
          icon: "settings",
        },
      ];

    case "console":
      return [
        { id: "home", label: "Ringkasan", href: base || "/console", icon: "home" },
        {
          id: "tenants",
          label: "Tenant",
          href: `${base}/tenants`,
          icon: "building",
        },
        {
          id: "agencies",
          label: "Agensi",
          href: `${base}/agencies`,
          icon: "users",
        },
        {
          id: "affiliates",
          label: "Afiliasi",
          href: `${base}/affiliates`,
          icon: "link",
        },
        {
          id: "domains",
          label: "Domain & SSL",
          href: `${base}/domains`,
          icon: "globe",
        },
        {
          id: "queues",
          label: "Antrean & Jobs",
          href: `${base}/jobs`,
          icon: "layers",
        },
        {
          id: "audit",
          label: "Audit Log",
          href: `${base}/audit`,
          icon: "shield-check",
        },
        {
          id: "status",
          label: "Status Layanan",
          href: `${base}/health`,
          icon: "activity",
        },
        {
          id: "settings",
          label: "Pengaturan",
          href: `${base}/settings`,
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
  const base = (opts?.basePath ?? "").replace(/\/+$/, "");
  const unread = opts?.unreadLeadsCount ?? 0;

  switch (surface) {
    case "dashboard":
      // Exact 5-slot mobile bottom bar (DESIGN.md §3.1) sized to never truncate at 360px
      return [
        { id: "home", label: "Beranda", href: base || "/", icon: "home" },
        {
          id: "offering",
          label: "Konten",
          href: `${base}/catalog`,
          icon: "layout-grid",
        },
        {
          id: "leads",
          label: "Pesan",
          ariaLabel: "Pesan masuk",
          href: `${base}/leads`,
          icon: "inbox",
          badgeCount: unread > 0 ? unread : undefined,
        },
        {
          id: "theme",
          label: "Tema",
          ariaLabel: "Tema dan Plugin",
          href: `${base}/appearance`,
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
        { id: "home", label: "Ringkasan", href: base || "/agency", icon: "home" },
        {
          id: "clients",
          label: "Klien",
          href: `${base}/clients`,
          icon: "building",
        },
        {
          id: "billing",
          label: "Tagihan",
          href: `${base}/billing`,
          icon: "receipt",
        },
        {
          id: "plugins",
          label: "Plugin",
          href: `${base}/plugins`,
          icon: "plug",
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
        { id: "home", label: "Ringkasan", href: base || "/affiliate", icon: "home" },
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
        { id: "home", label: "Ringkasan", href: base || "/console", icon: "home" },
        {
          id: "tenants",
          label: "Tenant",
          href: `${base}/tenants`,
          icon: "building",
        },
        {
          id: "domains",
          label: "Domain",
          href: `${base}/domains`,
          icon: "globe",
        },
        {
          id: "queues",
          label: "Antrean",
          href: `${base}/jobs`,
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
  const base = basePath.replace(/\/+$/, "");
  if (surface === "dashboard") {
    return [
      { id: "seo", label: "SEO & Redirect", href: `${base}/seo`, icon: "globe" },
      { id: "insights", label: "Statistik", href: `${base}/insights`, icon: "activity" },
      { id: "menus", label: "Menu Navigasi", href: `${base}/menus`, icon: "layout-grid" },
      { id: "forms", label: "Formulir", href: `${base}/forms`, icon: "file-text" },
      { id: "billing", label: "Langganan", href: `${base}/billing`, icon: "receipt" },
      { id: "security", label: "Akun & Keamanan", href: "/account/security", icon: "shield-check" },
    ];
  }
  return [];
}

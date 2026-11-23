import { useMemo, useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  LockIcon,
  PackageIcon,
  PlugIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  WrenchIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export type PluginStorefrontTabId = "terpasang-gratis" | "berbayar" | "custom-dev";

export interface PluginStorefrontItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly visibility: "public_free" | "public_paid" | "private_client";
  readonly billingCycle: "free" | "paid_once" | "paid_monthly" | "paid_yearly" | "custom";
  readonly priceIdr: number;
  readonly tablePrefix: string;
  readonly permissions: readonly string[];
  readonly maxPublicJsBytes: number;
  readonly entitled: boolean;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly schemaVersion: number;
}

export interface PluginStorefrontClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly apiBaseUrl: string;
  readonly initialItems: readonly PluginStorefrontItem[];
  readonly permissions: {
    readonly role: string;
    readonly roleLabel: string;
    readonly isLocked: boolean;
    readonly canManagePlugins: boolean;
  };
  readonly initialTab?: PluginStorefrontTabId;
}

const PERMISSION_LABELS_ID: Readonly<Record<string, string>> = {
  "tenant_db:plg_tables": "Tabel terisolasi plg_*",
  "public:section": "Blok halaman publik",
  "public:route": "Rute publik khusus",
  "public:head": "Metadata SEO & discovery",
  "admin:page": "Halaman pengaturan admin",
  "admin:api": "API admin terbatas",
  "queue:lead.created": "Notifikasi prospek asinkron",
  "queue:offering.published": "Event publikasi penawaran",
  "queue:post.published": "Event publikasi artikel",
  "queue:cron.daily": "Tugas harian terjadwal",
  "webhook:inbound": "Callback webhook terverifikasi",
  "mcp:read": "Baca data lewat MCP",
  "mcp:write": "Tulis data lewat MCP",
};

function formatPriceBadge(item: PluginStorefrontItem): string {
  if (item.visibility === "private_client") {
    return "Custom Dev";
  }
  if (item.visibility === "public_free" || item.priceIdr <= 0) {
    return "Gratis";
  }
  const formatted = new Intl.NumberFormat("id-ID").format(item.priceIdr);
  if (item.billingCycle === "paid_monthly") return `+Rp ${formatted}/bulan`;
  if (item.billingCycle === "paid_yearly") return `+Rp ${formatted}/tahun`;
  return `Sekali Bayar Rp ${formatted}`;
}

function formatPermission(perm: string): string {
  return PERMISSION_LABELS_ID[perm] ?? perm;
}

export function PluginStorefrontClient({
  basePath,
  apiBaseUrl,
  initialItems,
  permissions,
  initialTab = "terpasang-gratis",
}: PluginStorefrontClientProps) {
  const [items, setItems] = useState<PluginStorefrontItem[]>([...initialItems]);
  const [activeTab, setActiveTab] = useState<PluginStorefrontTabId>(initialTab);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<{
    readonly variant: "success" | "destructive" | "info";
    readonly title: string;
    readonly description: string;
  } | null>(null);

  const installedCount = useMemo(
    () => items.filter((item) => item.installed && item.enabled).length,
    [items],
  );

  const freeAndInstalled = useMemo(
    () => items.filter((item) => item.visibility === "public_free" || item.installed),
    [items],
  );
  const paidItems = useMemo(
    () => items.filter((item) => item.visibility === "public_paid"),
    [items],
  );
  const customItems = useMemo(
    () => items.filter((item) => item.visibility === "private_client"),
    [items],
  );

  async function handleInstallOrEnable(item: PluginStorefrontItem) {
    if (!permissions.canManagePlugins || busyPluginId) return;
    setBusyPluginId(item.id);
    setStatusNotice(null);
    try {
      const response = await fetch(
        item.installed ? `${apiBaseUrl}/${encodeURIComponent(item.id)}` : apiBaseUrl,
        {
          method: item.installed ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            item.installed ? { enabled: true } : { pluginId: item.id },
          ),
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        readonly plugin?: PluginStorefrontItem;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !data.plugin) {
        setStatusNotice({
          variant: "destructive",
          title: `Gagal mengaktifkan ${item.name}`,
          description:
            data.error?.message ?? "Permintaan tidak dapat diproses. Coba beberapa saat lagi.",
        });
        return;
      }
      setItems((prev) =>
        prev.map((entry) => (entry.id === item.id ? { ...entry, ...data.plugin } : entry)),
      );
      setStatusNotice({
        variant: "success",
        title: `${item.name} aktif`,
        description:
          "Plugin telah aktif dan siap dikonfigurasi tanpa mengubah inti CMS situs Anda.",
      });
    } catch {
      setStatusNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Tidak dapat menghubungi server. Status plugin belum berubah.",
      });
    } finally {
      setBusyPluginId(null);
    }
  }

  async function handleDisable(item: PluginStorefrontItem) {
    if (!permissions.canManagePlugins || busyPluginId) return;
    setBusyPluginId(item.id);
    setStatusNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        readonly plugin?: PluginStorefrontItem;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !data.plugin) {
        setStatusNotice({
          variant: "destructive",
          title: `Gagal menonaktifkan ${item.name}`,
          description:
            data.error?.message ?? "Permintaan tidak dapat diproses. Coba beberapa saat lagi.",
        });
        return;
      }
      setItems((prev) =>
        prev.map((entry) => (entry.id === item.id ? { ...entry, ...data.plugin } : entry)),
      );
      setStatusNotice({
        variant: "info",
        title: `${item.name} dinonaktifkan`,
        description:
          "Data pengaturan plugin tetap tersimpan aman jika diaktifkan kembali.",
      });
    } catch {
      setStatusNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Tidak dapat menghubungi server. Status plugin belum berubah.",
      });
    } finally {
      setBusyPluginId(null);
    }
  }

  const tabs: readonly {
    readonly id: PluginStorefrontTabId;
    readonly label: string;
    readonly count: number;
  }[] = [
    { id: "terpasang-gratis", label: "Terpasang & Gratis", count: freeAndInstalled.length },
    { id: "berbayar", label: "Berbayar / Pro", count: paidItems.length },
    { id: "custom-dev", label: "Custom Dev", count: customItems.length },
  ];

  function renderPluginCard(item: PluginStorefrontItem) {
    const isBusy = busyPluginId === item.id;
    const isActive = item.installed && item.enabled;
    const detailHref = `${basePath}/plugins/${encodeURIComponent(item.id)}`;

    return (
      <Card
        key={item.id}
        data-testid={`plugin-card-${item.id}`}
        className="flex flex-col justify-between"
      >
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{item.name}</CardTitle>
                <Badge variant="outline" className="font-mono text-[11px]">
                  v{item.version}
                </Badge>
              </div>
              <CardDescription>{item.description}</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={item.visibility === "public_free" ? "secondary" : "info"}>
                {formatPriceBadge(item)}
              </Badge>
              {isActive ? (
                <Badge variant="success">
                  <CheckCircle2Icon className="size-3" aria-hidden="true" />
                  Aktif
                </Badge>
              ) : item.installed ? (
                <Badge variant="outline">Nonaktif</Badge>
              ) : null}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {item.permissions.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Hak akses & isolasi</p>
              <div className="flex flex-wrap gap-1.5">
                {item.permissions.slice(0, 4).map((perm) => (
                  <Badge key={perm} variant="outline" className="text-[11px] font-normal">
                    {formatPermission(perm)}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Namespace: <code className="font-mono text-foreground">{item.tablePrefix}*</code>
            </span>
            <span>
              JS Publik:{" "}
              <strong className="font-medium text-foreground">
                {item.maxPublicJsBytes === 0
                  ? "0 KiB"
                  : `${(item.maxPublicJsBytes / 1024).toFixed(1)} KiB`}
              </strong>
            </span>
          </div>

          {item.installed ? (
            <p className="text-xs text-muted-foreground">
              Data pengaturan plugin tetap tersimpan aman jika diaktifkan kembali.
            </p>
          ) : null}
        </CardContent>

        <CardFooter className="flex flex-wrap items-center justify-between gap-2">
          {isActive ? (
            <>
              <Button
                variant="default"
                size="sm"
                className="min-h-11 md:min-h-8"
                render={<a href={detailHref} />}
              >
                <SlidersHorizontalIcon className="size-3.5" aria-hidden="true" />
                Atur
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                disabled={!permissions.canManagePlugins || isBusy}
                onClick={() => void handleDisable(item)}
              >
                {isBusy ? "Memproses..." : "Nonaktifkan"}
              </Button>
            </>
          ) : item.installed ? (
            <>
              <Button
                variant="default"
                size="sm"
                className="min-h-11 md:min-h-8"
                disabled={!permissions.canManagePlugins || isBusy}
                onClick={() => void handleInstallOrEnable(item)}
              >
                {isBusy ? "Mengaktifkan..." : "Aktifkan kembali"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                render={<a href={detailHref} />}
              >
                Lihat pengaturan
              </Button>
            </>
          ) : item.entitled || item.visibility === "public_free" ? (
            <Button
              variant="default"
              size="sm"
              className="min-h-11 md:min-h-8"
              disabled={!permissions.canManagePlugins || isBusy}
              onClick={() => void handleInstallOrEnable(item)}
            >
              {isBusy
                ? "Memasang..."
                : item.visibility === "public_free"
                  ? "Pasang (Gratis)"
                  : "Pasang Plugin"}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8"
              disabled={permissions.isLocked}
              render={<a href={`${basePath}/billing`} />}
            >
              <PackageIcon className="size-3.5" aria-hidden="true" />
              Beli Lisensi
            </Button>
          )}
        </CardFooter>
      </Card>
    );
  }

  return (
    <section
      className="space-y-6"
      data-testid="plugin-admin-shell"
      aria-labelledby="plugin-storefront-heading"
    >
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1
              id="plugin-storefront-heading"
              className="text-xl font-semibold tracking-tight text-foreground"
            >
              Plugin
            </h1>
            <Badge variant={installedCount > 0 ? "success" : "secondary"}>
              {installedCount} aktif
            </Badge>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Tambahkan fitur bisnis tanpa mengubah inti CMS. Setiap plugin berjalan terisolasi per
            situs dan data pengaturan tetap tersimpan aman saat dinonaktifkan.
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-4 text-primary shrink-0" aria-hidden="true" />
          <span>Runtime Terkurasi · Maks 25 KiB JS Publik</span>
        </div>
      </div>

      {/* Lifecycle / RBAC Guardrails */}
      {permissions.isLocked ? (
        <Alert variant="warning" data-testid="plugin-locked-alert">
          <LockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode hanya-baca (Langganan terkunci)</AlertTitle>
          <AlertDescription>
            Anda tetap dapat melihat status plugin yang terpasang, namun pemasangan, penonaktifan,
            dan perubahan konfigurasi dikunci sementara hingga langganan diperpanjang.
          </AlertDescription>
        </Alert>
      ) : !permissions.canManagePlugins ? (
        <Alert variant="info" data-testid="plugin-readonly-role-alert">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Akses lihat saja ({permissions.roleLabel})</AlertTitle>
          <AlertDescription>
            Hanya Pemilik Situs atau Admin yang dapat memasang, menonaktifkan, atau mengubah
            pengaturan plugin.
          </AlertDescription>
        </Alert>
      ) : null}

      {statusNotice ? (
        <Alert variant={statusNotice.variant} data-testid="plugin-status-notice">
          <AlertTitle>{statusNotice.title}</AlertTitle>
          <AlertDescription>{statusNotice.description}</AlertDescription>
        </Alert>
      ) : null}

      {/* 3-Tier Commercial Tabs (DESIGN.md §7) */}
      <div className="space-y-4">
        <div
          role="tablist"
          aria-label="Kategori Plugin"
          className="flex flex-wrap gap-1.5 border-b border-border pb-3"
        >
          {tabs.map((tab) => {
            const isSelected = activeTab === tab.id;
            return (
              <Button
                key={tab.id}
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={isSelected}
                aria-controls={`panel-${tab.id}`}
                variant={isSelected ? "default" : "outline"}
                size="sm"
                className="min-h-11 md:min-h-9"
                onClick={() => setActiveTab(tab.id)}
              >
                <span>{tab.label}</span>
                <span
                  className={
                    isSelected
                      ? "ml-1 rounded bg-primary-foreground/20 px-1.5 py-0.5 text-[11px]"
                      : "ml-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  }
                >
                  {tab.count}
                </span>
              </Button>
            );
          })}
        </div>

        {/* Tab 1: Terpasang & Gratis */}
        {activeTab === "terpasang-gratis" ? (
          <div
            role="tabpanel"
            id="panel-terpasang-gratis"
            aria-labelledby="tab-terpasang-gratis"
            className="space-y-4"
          >
            {freeAndInstalled.length === 0 ? (
              <Card data-testid="plugin-empty-state">
                <CardContent className="flex flex-col items-start gap-3 py-8 sm:py-10">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <PlugIcon className="size-5 shrink-0" aria-hidden="true" />
                    <h2 className="text-base font-semibold text-foreground">
                      Belum ada plugin terpasang
                    </h2>
                  </div>
                  <p className="max-w-xl text-sm text-muted-foreground">
                    Situs Anda berjalan dengan inti CMS murni tanpa beban skrip tambahan. Ketika
                    plugin resmi tersedia atau diberikan untuk situs ini, Anda dapat memasangnya
                    dalam 1 klik di sini.
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 md:min-h-9"
                      onClick={() => setActiveTab("custom-dev")}
                    >
                      Lihat opsi Custom Dev
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {freeAndInstalled.map((item) => renderPluginCard(item))}
              </div>
            )}
          </div>
        ) : null}

        {/* Tab 2: Berbayar / Pro */}
        {activeTab === "berbayar" ? (
          <div
            role="tabpanel"
            id="panel-berbayar"
            aria-labelledby="tab-berbayar"
            className="space-y-4"
          >
            {paidItems.length === 0 ? (
              <Card data-testid="plugin-paid-empty">
                <CardContent className="flex flex-col items-start gap-3 py-8 sm:py-10">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <PackageIcon className="size-5 shrink-0" aria-hidden="true" />
                    <h2 className="text-base font-semibold text-foreground">
                      Katalog Plugin Pro segera hadir
                    </h2>
                  </div>
                  <p className="max-w-xl text-sm text-muted-foreground">
                    Plugin berbayar seperti rotator CS WhatsApp multi-agen dan integrasi webhook CRM
                    akan tampil di sini dengan pembayaran QRIS / Virtual Account transparan.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {paidItems.map((item) => renderPluginCard(item))}
              </div>
            )}
          </div>
        ) : null}

        {/* Tab 3: Custom Dev */}
        {activeTab === "custom-dev" ? (
          <div
            role="tabpanel"
            id="panel-custom-dev"
            aria-labelledby="tab-custom-dev"
            className="space-y-4"
          >
            {customItems.length > 0 ? (
              <div className="space-y-3">
                <h2 className="text-sm font-semibold text-foreground">
                  Plugin Kustom Khusus Situs Anda
                </h2>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {customItems.map((item) => renderPluginCard(item))}
                </div>
                <Separator />
              </div>
            ) : null}

            <Card data-testid="plugin-custom-dev-card">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <WrenchIcon className="size-4 text-primary shrink-0" aria-hidden="true" />
                  <CardTitle>Pesan Fitur / Plugin Custom</CardTitle>
                </div>
                <CardDescription>
                  Butuh fitur bisnis khusus seperti kalkulator kredit kustom, integrasi ERP, atau
                  alur formulir spesifik? Tim PunyaSitus membangunnya sebagai plugin terisolasi
                  khusus untuk situs Anda tanpa mengubah inti CMS.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <ul className="list-disc space-y-1 pl-5">
                  <li>Tabel database terisolasi khusus di penyimpanan situs Anda.</li>
                  <li>Keamanan teraudit & tetap memenuhi batas kecepatan publik &le; 25 KiB JS.</li>
                  <li>Terkelola rapi langsung di menu Plugin situs Anda.</li>
                </ul>
              </CardContent>
              <CardFooter>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 md:min-h-9"
                  disabled={permissions.isLocked}
                  render={<a href={`${basePath}/billing`} />}
                >
                  Konsultasi Fitur Custom
                </Button>
              </CardFooter>
            </Card>
          </div>
        ) : null}
      </div>
    </section>
  );
}

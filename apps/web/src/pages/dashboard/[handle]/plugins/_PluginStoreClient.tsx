import { useMemo, useState } from "react";
import {
  AlertCircleIcon,
  Building2Icon,
  CheckCircle2Icon,
  CreditCardIcon,
  FileTextIcon,
  LockIcon,
  PackageIcon,
  PlugIcon,
  SendIcon,
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
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type PluginStoreTabId = "terpasang" | "gratis" | "berbayar" | "khusus-klien";

export interface PluginStoreItemDto {
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly visibilityTier: "public_free" | "public_paid" | "private_client";
  readonly billingModel: "free" | "paid_once" | "paid_monthly" | "paid_yearly";
  readonly priceIdr: number;
  readonly entitled: boolean;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly entitlementStatus: "active" | "expired" | "disabled" | "revoked" | null;
  readonly sourceKind:
    | "public_free"
    | "paid_once"
    | "paid_monthly"
    | "paid_yearly"
    | "private_grant"
    | null;
  readonly expiresAtIso: string | null;
  readonly canInstall: boolean;
  readonly canTenantCheckout: boolean;
  readonly agencyManagedBilling: boolean;
  readonly checkoutBlockCode: "AGENCY_PAYER_ONLY" | null;
  readonly activeGrantId: string | null;
  readonly activeGrantScope: "tenant" | "agency" | null;
}

export interface PluginStoreOrderDto {
  readonly id: string;
  readonly pluginSlug: string;
  readonly billingModel: "paid_once" | "paid_monthly" | "paid_yearly";
  readonly channelCode: string;
  readonly grossAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalPayableIdr: number;
  readonly status: "pending" | "settled" | "expired" | "refunded";
  readonly paymentInstructions: Record<string, unknown> | null;
  readonly createdAtIso: string;
}

export interface PluginStoreReceiptDto {
  readonly id: string;
  readonly receiptNumber: string;
  readonly pluginSlug: string;
  readonly pluginNameSnapshot: string;
  readonly totalAmountIdr: number;
  readonly paymentChannel: string;
  readonly issuedAtIso: string;
}

export interface CustomPluginDevRequestDto {
  readonly id: string;
  readonly requestCode: string;
  readonly serviceKind: "custom_plugin";
  readonly title: string;
  readonly requirementsSummary: string;
  readonly contactWhatsapp: string;
  readonly budgetRange: string | null;
  readonly status: "submitted" | "quoted" | "in_progress" | "fulfilled" | "declined";
  readonly quoteAmountIdr: number | null;
  readonly linkedPluginSlug: string | null;
  readonly createdAtIso: string;
}

export interface PluginStoreClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly apiBaseUrl: string;
  readonly billingPayer: "tenant" | "agency";
  readonly initialItems: readonly PluginStoreItemDto[];
  readonly initialOrders: readonly PluginStoreOrderDto[];
  readonly initialReceipts: readonly PluginStoreReceiptDto[];
  readonly initialCustomDevRequests: readonly CustomPluginDevRequestDto[];
  readonly initialQuota: {
    readonly used: number;
    readonly limit: number;
    readonly remaining: number;
    readonly dayBucket: string;
  };
  readonly permissions: {
    readonly role: string;
    readonly roleLabel: string;
    readonly isLocked: boolean;
    readonly canManagePlugins: boolean;
  };
  readonly initialTab?: PluginStoreTabId;
}

const CHANNEL_OPTIONS = [
  { code: "QRIS", label: "QRIS (Instan)" },
  { code: "VA_BCA", label: "Virtual Account BCA" },
  { code: "VA_MANDIRI", label: "Virtual Account Mandiri" },
  { code: "VA_BRI", label: "Virtual Account BRI" },
  { code: "VA_BNI", label: "Virtual Account BNI" },
] as const;

const REQUEST_STATUS_LABELS: Readonly<Record<CustomPluginDevRequestDto["status"], string>> = {
  submitted: "Terkirim",
  quoted: "Penawaran Dikirim",
  in_progress: "Sedang Dibangun",
  fulfilled: "Selesai & Aktif",
  declined: "Ditolak",
};

function formatIdr(amount: number): string {
  return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
}

function formatPriceBadge(item: PluginStoreItemDto): string {
  if (item.visibilityTier === "private_client") {
    return "Khusus Klien";
  }
  if (item.visibilityTier === "public_free" || item.priceIdr <= 0) {
    return "Gratis";
  }
  const formatted = formatIdr(item.priceIdr);
  if (item.billingModel === "paid_monthly") return `${formatted}/bln`;
  if (item.billingModel === "paid_yearly") return `${formatted}/thn`;
  return `Sekali Bayar ${formatted}`;
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "Permanen";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function PluginStoreClient({
  basePath,
  apiBaseUrl,
  billingPayer,
  initialItems,
  initialOrders,
  initialReceipts,
  initialCustomDevRequests,
  initialQuota,
  permissions,
  initialTab = "terpasang",
}: PluginStoreClientProps) {
  const [items, setItems] = useState<PluginStoreItemDto[]>([...initialItems]);
  const [orders, setOrders] = useState<PluginStoreOrderDto[]>([...initialOrders]);
  const [receipts] = useState<PluginStoreReceiptDto[]>([...initialReceipts]);
  const [requests, setRequests] = useState<CustomPluginDevRequestDto[]>([
    ...initialCustomDevRequests,
  ]);
  const [quota, setQuota] = useState(initialQuota);
  const [activeTab, setActiveTab] = useState<PluginStoreTabId>(initialTab);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [checkoutSlug, setCheckoutSlug] = useState<string | null>(null);
  const [channelCode, setChannelCode] = useState<string>("QRIS");
  const [couponCode, setCouponCode] = useState<string>("");
  const [notice, setNotice] = useState<{
    readonly variant: "success" | "destructive" | "info";
    readonly title: string;
    readonly description: string;
  } | null>(null);

  // Custom Dev Request form state (`service_kind = "custom_plugin"`)
  const [reqTitle, setReqTitle] = useState("");
  const [reqSummary, setReqSummary] = useState("");
  const [reqWhatsapp, setReqWhatsapp] = useState("");
  const [reqBudget, setReqBudget] = useState("");
  const [submittingReq, setSubmittingReq] = useState(false);

  const installedItems = useMemo(() => items.filter((item) => item.installed), [items]);
  const activeCount = useMemo(
    () => items.filter((item) => item.installed && item.enabled).length,
    [items],
  );
  const freeItems = useMemo(
    () => items.filter((item) => item.visibilityTier === "public_free"),
    [items],
  );
  const paidItems = useMemo(
    () => items.filter((item) => item.visibilityTier === "public_paid"),
    [items],
  );
  const privateClientItems = useMemo(
    () => items.filter((item) => item.visibilityTier === "private_client"),
    [items],
  );

  const tabs: readonly { readonly id: PluginStoreTabId; readonly label: string; readonly count: number }[] = [
    { id: "terpasang", label: "Terpasang", count: installedItems.length },
    { id: "gratis", label: "Gratis", count: freeItems.length },
    { id: "berbayar", label: "Berbayar", count: paidItems.length },
    { id: "khusus-klien", label: "Khusus Klien", count: privateClientItems.length },
  ];

  async function handleInstallOrToggle(item: PluginStoreItemDto, nextEnabled: boolean) {
    if (!permissions.canManagePlugins || busySlug) return;
    setBusySlug(item.slug);
    setNotice(null);
    try {
      const url = `${apiBaseUrl}/store/${encodeURIComponent(item.slug)}`;
      const res = await fetch(url, {
        method: item.installed ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: item.installed ? JSON.stringify({ enabled: nextEnabled }) : JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly plugin?: PluginStoreItemDto;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.plugin) {
        setNotice({
          variant: "destructive",
          title: `Gagal memperbarui ${item.name}`,
          description: data.error?.message ?? "Permintaan tidak dapat diproses saat ini.",
        });
        return;
      }
      setItems((prev) =>
        prev.map((entry) => (entry.slug === item.slug ? data.plugin! : entry)),
      );
      setNotice({
        variant: nextEnabled ? "success" : "info",
        title: nextEnabled ? `${item.name} aktif` : `${item.name} dinonaktifkan`,
        description: nextEnabled
          ? "Plugin terisolasi kini aktif tanpa memodifikasi inti CMS situs Anda."
          : "Data pengaturan & tabel plg_* tetap tersimpan aman jika diaktifkan kembali.",
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Tidak dapat menghubungi server. Status plugin belum berubah.",
      });
    } finally {
      setBusySlug(null);
    }
  }

  async function handleCreateCheckout(item: PluginStoreItemDto) {
    if (!permissions.canManagePlugins || billingPayer === "agency" || busySlug) return;
    setBusySlug(item.slug);
    setNotice(null);
    try {
      const res = await fetch(`${apiBaseUrl}/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          pluginSlug: item.slug,
          channelCode,
          ...(couponCode.trim() ? { couponCode: couponCode.trim().toUpperCase() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly order?: PluginStoreOrderDto;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.order) {
        setNotice({
          variant: "destructive",
          title: "Gagal membuat instruksi pembayaran",
          description: data.error?.message ?? "Periksa kode kupon atau coba beberapa saat lagi.",
        });
        return;
      }
      setOrders((prev) => [data.order!, ...prev.filter((o) => o.id !== data.order!.id)]);
      setCheckoutSlug(null);
      setCouponCode("");
      setNotice({
        variant: "success",
        title: `Instruksi pembayaran ${item.name} dibuat`,
        description: `Total dibayar ${formatIdr(data.order.totalPayableIdr)} via ${data.order.channelCode}. Plugin aktif otomatis setelah AutoLaris Advice terkonfirmasi.`,
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Gagal menghubungi layanan checkout add-on plugin.",
      });
    } finally {
      setBusySlug(null);
    }
  }

  async function handleSubmitCustomDev(event: React.FormEvent) {
    event.preventDefault();
    if (!permissions.canManagePlugins || submittingReq || quota.remaining <= 0) return;
    setSubmittingReq(true);
    setNotice(null);
    try {
      const res = await fetch(`${apiBaseUrl}/custom-dev`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          serviceKind: "custom_plugin",
          title: reqTitle.trim(),
          requirementsSummary: reqSummary.trim(),
          contactWhatsapp: reqWhatsapp.trim(),
          ...(reqBudget.trim() ? { budgetRange: reqBudget.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly request?: CustomPluginDevRequestDto;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.request) {
        setNotice({
          variant: "destructive",
          title: "Gagal mengirim permintaan Custom Dev",
          description: data.error?.message ?? "Periksa kembali judul, detail kebutuhan, dan nomor WhatsApp.",
        });
        return;
      }
      setRequests((prev) => [data.request!, ...prev]);
      setQuota((prev) => ({
        ...prev,
        used: prev.used + 1,
        remaining: Math.max(0, prev.remaining - 1),
      }));
      setReqTitle("");
      setReqSummary("");
      setReqWhatsapp("");
      setReqBudget("");
      setNotice({
        variant: "success",
        title: `Permintaan ${data.request.requestCode} terkirim`,
        description:
          "Tim PunyaSitus akan menghubungi nomor WhatsApp Anda dengan estimasi biaya & waktu pengerjaan.",
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Gagal mengirim permintaan plugin kustom.",
      });
    } finally {
      setSubmittingReq(false);
    }
  }

  function renderPluginCard(item: PluginStoreItemDto) {
    const isBusy = busySlug === item.slug;
    const isActive = item.installed && item.enabled;
    const isExpired = item.entitlementStatus === "expired";
    const isCheckoutOpen = checkoutSlug === item.slug;
    const detailHref = `${basePath}/plugins/${encodeURIComponent(item.slug)}`;

    return (
      <Card
        key={item.slug}
        data-testid={`plugin-store-card-${item.slug}`}
        className="flex flex-col justify-between"
      >
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <CardTitle className="text-base">{item.name}</CardTitle>
              {item.tagline ? (
                <p className="text-xs font-medium text-foreground/80">{item.tagline}</p>
              ) : null}
              <CardDescription>{item.description}</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge
                variant={
                  item.visibilityTier === "public_free"
                    ? "secondary"
                    : item.visibilityTier === "private_client"
                      ? "outline"
                      : "info"
                }
                className="tabular-nums"
              >
                {formatPriceBadge(item)}
              </Badge>
              {isActive ? (
                <Badge variant="success">
                  <CheckCircle2Icon className="size-3" aria-hidden="true" />
                  Aktif
                </Badge>
              ) : isExpired ? (
                <Badge variant="warning">Kedaluwarsa</Badge>
              ) : item.installed ? (
                <Badge variant="outline">Nonaktif</Badge>
              ) : null}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-2.5 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              Slug: <code className="font-mono text-foreground">{item.slug}</code>
            </span>
            {item.expiresAtIso ? (
              <span>
                Berlaku s/d:{" "}
                <strong className="font-medium text-foreground">
                  {formatShortDate(item.expiresAtIso)}
                </strong>
              </span>
            ) : item.entitled && item.sourceKind === "paid_once" ? (
              <span>
                Lisensi: <strong className="font-medium text-foreground">Permanen</strong>
              </span>
            ) : null}
            {item.activeGrantScope ? (
              <Badge variant="outline" className="text-[11px]">
                {item.activeGrantScope === "agency" ? "Izin Agensi" : "Izin Khusus Klien"}
              </Badge>
            ) : null}
          </div>

          {item.installed || isExpired ? (
            <p className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
              Data pengaturan &amp; tabel <code className="font-mono">plg_*</code> tetap tersimpan aman
              meskipun plugin dinonaktifkan atau masa berlaku berakhir.
            </p>
          ) : null}

          {isCheckoutOpen && item.canTenantCheckout && billingPayer === "tenant" ? (
            <div
              data-testid={`checkout-panel-${item.slug}`}
              className="space-y-3 rounded-md border border-border bg-muted/30 p-3 text-foreground"
            >
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor={`channel-${item.slug}`}>
                  Metode Pembayaran (AutoLaris)
                </label>
                <select
                  id={`channel-${item.slug}`}
                  value={channelCode}
                  onChange={(e) => setChannelCode(e.target.value)}
                  className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm md:min-h-9"
                >
                  {CHANNEL_OPTIONS.map((opt) => (
                    <option key={opt.code} value={opt.code}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor={`coupon-${item.slug}`}>
                  Kode Kupon (Opsional)
                </label>
                <Input
                  id={`coupon-${item.slug}`}
                  value={couponCode}
                  onChange={(e) => setCouponCode(e.target.value)}
                  placeholder="Contoh: HEMAT20"
                  className="min-h-11 md:min-h-9"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Belum termasuk PPN (non-PKP). Biaya channel AutoLaris ditampilkan terpisah dan kuitansi
                PDF bernomor terbit otomatis setelah lunas.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  className="min-h-11 md:min-h-9"
                  disabled={isBusy}
                  onClick={() => void handleCreateCheckout(item)}
                >
                  {isBusy ? "Membuat Tagihan..." : "Buat Instruksi Bayar"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 md:min-h-9"
                  onClick={() => setCheckoutSlug(null)}
                >
                  Batal
                </Button>
              </div>
            </div>
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
                onClick={() => void handleInstallOrToggle(item, false)}
              >
                {isBusy ? "Memproses..." : "Nonaktifkan"}
              </Button>
            </>
          ) : item.entitled ? (
            <Button
              variant="default"
              size="sm"
              className="min-h-11 md:min-h-8"
              disabled={!permissions.canManagePlugins || isBusy}
              onClick={() => void handleInstallOrToggle(item, true)}
            >
              {isBusy
                ? "Memasang..."
                : item.installed
                  ? "Aktifkan kembali"
                  : item.visibilityTier === "public_free"
                    ? "Pasang (Gratis)"
                    : "Pasang Plugin"}
            </Button>
          ) : billingPayer === "agency" || item.checkoutBlockCode === "AGENCY_PAYER_ONLY" ? (
            <span
              data-testid={`agency-payer-note-${item.slug}`}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
            >
              <Building2Icon className="size-3.5 shrink-0" aria-hidden="true" />
              Hubungi agensi Anda untuk aktivasi add-on ini
            </span>
          ) : (
            <Button
              variant="default"
              size="sm"
              className="min-h-11 md:min-h-8"
              disabled={!permissions.canManagePlugins || isBusy}
              onClick={() => setCheckoutSlug(isCheckoutOpen ? null : item.slug)}
            >
              <CreditCardIcon className="size-3.5" aria-hidden="true" />
              {isExpired ? "Perpanjang Lisensi" : "Beli via QRIS / VA"}
            </Button>
          )}
        </CardFooter>
      </Card>
    );
  }

  return (
    <section
      className="space-y-6"
      data-testid="plugin-store-shell"
      aria-labelledby="toko-plugin-heading"
    >
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1
              id="toko-plugin-heading"
              className="text-xl font-semibold tracking-tight text-foreground"
            >
              Toko Plugin
            </h1>
            <Badge variant={activeCount > 0 ? "success" : "secondary"}>{activeCount} aktif</Badge>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Tambahkan fitur bisnis terkurasi tanpa mengubah inti CMS. Semua pengaturan plugin dikelola
            rapi di sini tanpa memenuhi sidebar utama.
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span>Frozen-Core Terisolasi · Maks 25 KiB JS Publik</span>
        </div>
      </div>

      {/* Agency Billing Boundary Notice */}
      {billingPayer === "agency" ? (
        <Alert variant="info" data-testid="plugin-agency-billing-notice">
          <Building2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Penagihan dikelola oleh agensi Anda</AlertTitle>
          <AlertDescription>
            Situs ini dikelola agensi. Anda dapat memasang plugin gratis dan plugin khusus yang telah
            diberikan, sedangkan pembelian add-on berbayar dilakukan langsung melalui Portal Agensi.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Lifecycle / RBAC Guardrails */}
      {permissions.isLocked ? (
        <Alert variant="warning" data-testid="plugin-locked-alert">
          <LockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode hanya-baca (Langganan terkunci)</AlertTitle>
          <AlertDescription>
            Perpanjang langganan situs untuk memasang, membeli, atau mengubah pengaturan plugin.
          </AlertDescription>
        </Alert>
      ) : !permissions.canManagePlugins ? (
        <Alert variant="info" data-testid="plugin-readonly-role-alert">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Akses lihat saja ({permissions.roleLabel})</AlertTitle>
          <AlertDescription>
            Hanya Pemilik Situs atau Admin yang dapat memasang, membeli add-on, atau mengajukan
            permintaan plugin kustom.
          </AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert variant={notice.variant} data-testid="plugin-store-notice">
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.description}</AlertDescription>
        </Alert>
      ) : null}

      {/* Crisp 4-Tab Navigation (`Terpasang` / `Gratis` / `Berbayar` / `Khusus Klien`) */}
      <div className="space-y-4">
        <div
          role="tablist"
          aria-label="Kategori Toko Plugin"
          className="flex flex-wrap gap-1.5 border-b border-border pb-3"
        >
          {tabs.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <Button
                key={tab.id}
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`panel-${tab.id}`}
                variant={selected ? "default" : "outline"}
                size="sm"
                className="min-h-11 md:min-h-9"
                onClick={() => setActiveTab(tab.id)}
              >
                <span>{tab.label}</span>
                <span
                  className={
                    selected
                      ? "ml-1 rounded bg-primary-foreground/20 px-1.5 py-0.5 text-[11px] tabular-nums"
                      : "ml-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums"
                  }
                >
                  {tab.count}
                </span>
              </Button>
            );
          })}
        </div>

        {/* Tab 1: Terpasang */}
        {activeTab === "terpasang" ? (
          <div role="tabpanel" id="panel-terpasang" aria-labelledby="tab-terpasang" className="space-y-4">
            {installedItems.length === 0 ? (
              <Card data-testid="plugin-installed-empty">
                <CardContent className="flex flex-col items-start gap-3 py-8">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <PlugIcon className="size-5 shrink-0" aria-hidden="true" />
                    <h2 className="text-base font-semibold text-foreground">
                      Belum ada plugin terpasang
                    </h2>
                  </div>
                  <p className="max-w-xl text-sm text-muted-foreground">
                    Pasang plugin resmi gratis dalam 1 klik atau pilih add-on berbayar sesuai
                    kebutuhan bisnis Anda.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="min-h-11 md:min-h-9"
                      onClick={() => setActiveTab("gratis")}
                    >
                      Lihat Plugin Gratis
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 md:min-h-9"
                      onClick={() => setActiveTab("berbayar")}
                    >
                      Lihat Add-on Berbayar
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {installedItems.map(renderPluginCard)}
              </div>
            )}
          </div>
        ) : null}

        {/* Tab 2: Gratis */}
        {activeTab === "gratis" ? (
          <div role="tabpanel" id="panel-gratis" aria-labelledby="tab-gratis" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {freeItems.map(renderPluginCard)}
            </div>
          </div>
        ) : null}

        {/* Tab 3: Berbayar */}
        {activeTab === "berbayar" ? (
          <div role="tabpanel" id="panel-berbayar" aria-labelledby="tab-berbayar" className="space-y-6">
            {paidItems.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-start gap-2 py-8">
                  <PackageIcon className="size-5 text-muted-foreground" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground">
                    Belum ada plugin berbayar yang dipublikasikan saat ini.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {paidItems.map(renderPluginCard)}
              </div>
            )}

            {billingPayer === "tenant" && (orders.length > 0 || receipts.length > 0) ? (
              <div className="space-y-4">
                <Separator />
                {orders.length > 0 ? (
                  <Card data-testid="plugin-orders-card">
                    <CardHeader>
                      <CardTitle className="text-base">Riwayat Pesanan Add-on</CardTitle>
                      <CardDescription>
                        Status transaksi QRIS / Virtual Account add-on plugin situs Anda.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Plugin</TableHead>
                            <TableHead>Channel</TableHead>
                            <TableHead className="text-right">Total</TableHead>
                            <TableHead>Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {orders.map((order) => (
                            <TableRow key={order.id}>
                              <TableCell className="font-mono text-xs">{order.pluginSlug}</TableCell>
                              <TableCell className="text-xs">{order.channelCode}</TableCell>
                              <TableCell className="text-right text-xs tabular-nums">
                                {formatIdr(order.totalPayableIdr)}
                              </TableCell>
                              <TableCell>
                                <Badge variant={order.status === "settled" ? "success" : "outline"}>
                                  {order.status === "settled" ? "Lunas" : order.status}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                ) : null}

                {receipts.length > 0 ? (
                  <Card data-testid="plugin-receipts-card">
                    <CardHeader>
                      <CardTitle className="text-base">Kuitansi PDF Add-on Plugin</CardTitle>
                      <CardDescription>
                        Kuitansi layanan bernomor resmi yang tidak dapat diubah (non-PKP).
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Nomor</TableHead>
                            <TableHead>Plugin</TableHead>
                            <TableHead className="text-right">Nominal</TableHead>
                            <TableHead className="text-right">Unduh</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {receipts.map((rec) => (
                            <TableRow key={rec.id}>
                              <TableCell className="font-mono text-xs">{rec.receiptNumber}</TableCell>
                              <TableCell className="text-xs">{rec.pluginNameSnapshot}</TableCell>
                              <TableCell className="text-right text-xs tabular-nums">
                                {formatIdr(rec.totalAmountIdr)}
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="min-h-9"
                                  render={
                                    <a
                                      href={`${apiBaseUrl}/receipts/${encodeURIComponent(rec.id)}/pdf`}
                                    />
                                  }
                                >
                                  <FileTextIcon className="size-3.5" aria-hidden="true" />
                                  PDF
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Tab 4: Khusus Klien (`private_client` grants + `custom_plugin` dev request form) */}
        {activeTab === "khusus-klien" ? (
          <div
            role="tabpanel"
            id="panel-khusus-klien"
            aria-labelledby="tab-khusus-klien"
            className="space-y-6"
          >
            {privateClientItems.length > 0 ? (
              <div className="space-y-3">
                <h2 className="text-sm font-semibold text-foreground">
                  Plugin Khusus yang Diberikan untuk Situs Anda
                </h2>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {privateClientItems.map(renderPluginCard)}
                </div>
                <Separator />
              </div>
            ) : null}

            {/* Structured Custom Plugin Dev Request Form (`service_kind = "custom_plugin"`) */}
            <Card data-testid="custom-plugin-dev-form-card">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <WrenchIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                    <CardTitle className="text-base">Pesan Fitur / Plugin Custom (Custom Dev)</CardTitle>
                  </div>
                  <Badge variant="outline" className="tabular-nums">
                    Kuota hari ini: {quota.used}/{quota.limit}
                  </Badge>
                </div>
                <CardDescription>
                  Butuh kalkulator khusus, integrasi ERP/CRM internal, atau alur bisnis spesifik? Tim
                  PunyaSitus membangunnya sebagai plugin privat terisolasi khusus situs Anda.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={(e) => void handleSubmitCustomDev(e)}>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label htmlFor="custom-plugin-title" className="text-xs font-medium text-foreground">
                        Judul Fitur / Plugin
                      </label>
                      <Input
                        id="custom-plugin-title"
                        required
                        minLength={4}
                        maxLength={120}
                        value={reqTitle}
                        onChange={(e) => setReqTitle(e.target.value)}
                        placeholder="Contoh: Kalkulator Cicilan KPR Kustom"
                        disabled={!permissions.canManagePlugins || quota.remaining <= 0}
                        className="min-h-11 md:min-h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="custom-plugin-wa" className="text-xs font-medium text-foreground">
                        Nomor WhatsApp Aktif
                      </label>
                      <Input
                        id="custom-plugin-wa"
                        required
                        value={reqWhatsapp}
                        onChange={(e) => setReqWhatsapp(e.target.value)}
                        placeholder="081234567890"
                        disabled={!permissions.canManagePlugins || quota.remaining <= 0}
                        className="min-h-11 md:min-h-9"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="custom-plugin-summary" className="text-xs font-medium text-foreground">
                      Ringkasan Kebutuhan Bisnis (min. 20 karakter)
                    </label>
                    <textarea
                      id="custom-plugin-summary"
                      required
                      minLength={20}
                      maxLength={3000}
                      rows={4}
                      value={reqSummary}
                      onChange={(e) => setReqSummary(e.target.value)}
                      placeholder="Jelaskan alur kerja, input/output yang dibutuhkan, serta integrasi yang diinginkan..."
                      disabled={!permissions.canManagePlugins || quota.remaining <= 0}
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    />
                  </div>

                  <div className="space-y-1.5 sm:max-w-xs">
                    <label htmlFor="custom-plugin-budget" className="text-xs font-medium text-foreground">
                      Estimasi Anggaran (Opsional)
                    </label>
                    <Input
                      id="custom-plugin-budget"
                      maxLength={80}
                      value={reqBudget}
                      onChange={(e) => setReqBudget(e.target.value)}
                      placeholder="Contoh: Rp 3.000.000 - Rp 5.000.000"
                      disabled={!permissions.canManagePlugins || quota.remaining <= 0}
                      className="min-h-11 md:min-h-9"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <p className="text-xs text-muted-foreground">
                      Status penyelesaian permintaan akan ditautkan ke izin plugin khusus aktif oleh tim
                      operator PunyaSitus.
                    </p>
                    <Button
                      type="submit"
                      size="sm"
                      className="min-h-11 md:min-h-9"
                      disabled={!permissions.canManagePlugins || submittingReq || quota.remaining <= 0}
                    >
                      <SendIcon className="size-3.5" aria-hidden="true" />
                      {submittingReq ? "Mengirim..." : "Kirim Permintaan Custom Dev"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            {/* Request Status Tracker */}
            <Card data-testid="custom-plugin-requests-tracker">
              <CardHeader>
                <CardTitle className="text-base">Status Permintaan Custom Plugin</CardTitle>
                <CardDescription>
                  Pantau progres penawaran, pengerjaan, hingga aktivasi plugin khusus Anda.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {requests.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Belum ada permintaan plugin kustom yang dikirim untuk situs ini.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Kode</TableHead>
                        <TableHead>Judul</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Penawaran</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {requests.map((req) => (
                        <TableRow key={req.id}>
                          <TableCell className="font-mono text-xs">{req.requestCode}</TableCell>
                          <TableCell className="text-xs font-medium">
                            <div>{req.title}</div>
                            {req.linkedPluginSlug ? (
                              <span className="font-mono text-[11px] text-muted-foreground">
                                Plugin: {req.linkedPluginSlug}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Badge variant={req.status === "fulfilled" ? "success" : "outline"}>
                              {REQUEST_STATUS_LABELS[req.status] ?? req.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {req.quoteAmountIdr !== null ? formatIdr(req.quoteAmountIdr) : "Menunggu"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </section>
  );
}

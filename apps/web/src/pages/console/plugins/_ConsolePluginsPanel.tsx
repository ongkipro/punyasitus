import { useState } from "react";
import { ArrowUpRightIcon, KeyRoundIcon, LayersIcon, WrenchIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface ConsolePluginCatalogDto {
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly visibilityTier: "public_free" | "public_paid" | "private_client";
  readonly billingModel: "free" | "paid_once" | "paid_monthly" | "paid_yearly";
  readonly priceIdr: number;
  readonly active: boolean;
  readonly version: number;
}

export interface ConsolePluginGrantDto {
  readonly id: string;
  readonly pluginSlug: string;
  readonly tenantId: string | null;
  readonly agencyId: string | null;
  readonly status: "active" | "revoked";
  readonly grantReason: string;
  readonly createdAtIso: string;
}

export interface ConsoleCustomPluginRequestDto {
  readonly id: string;
  readonly requestCode: string;
  readonly tenantId: string;
  readonly tenantHandle: string | null;
  readonly title: string;
  readonly requirementsSummary: string;
  readonly contactWhatsapp: string;
  readonly status: "submitted" | "quoted" | "in_progress" | "fulfilled" | "declined";
  readonly quoteAmountIdr: number | null;
  readonly linkedGrantId: string | null;
  readonly linkedPluginSlug: string | null;
  readonly version: number;
  readonly createdAtIso: string;
}

export interface ConsolePluginsPanelProps {
  readonly initialCatalog: readonly ConsolePluginCatalogDto[];
  readonly initialGrants: readonly ConsolePluginGrantDto[];
  readonly initialRequests: readonly ConsoleCustomPluginRequestDto[];
  readonly stepUpFresh: boolean;
}

type ConsoleTab = "catalog" | "grants" | "requests";

function formatIdr(amount: number): string {
  return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
}

export function ConsolePluginsPanel({
  initialCatalog,
  initialGrants,
  initialRequests,
  stepUpFresh,
}: ConsolePluginsPanelProps) {
  const [activeTab, setActiveTab] = useState<ConsoleTab>("catalog");
  const [catalog, setCatalog] = useState<ConsolePluginCatalogDto[]>([...initialCatalog]);
  const [grants, setGrants] = useState<ConsolePluginGrantDto[]>([...initialGrants]);
  const [requests, setRequests] = useState<ConsoleCustomPluginRequestDto[]>([...initialRequests]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    readonly variant: "success" | "destructive";
    readonly title: string;
    readonly description: string;
  } | null>(null);

  // Catalog promote / edit form
  const [catSlug, setCatSlug] = useState(initialCatalog[0]?.slug ?? "");
  const [catName, setCatName] = useState(initialCatalog[0]?.name ?? "");
  const [catTier, setCatTier] = useState<"public_free" | "public_paid" | "private_client">(
    initialCatalog[0]?.visibilityTier ?? "private_client",
  );
  const [catModel, setCatModel] = useState<"free" | "paid_once" | "paid_monthly" | "paid_yearly">(
    initialCatalog[0]?.billingModel ?? "free",
  );
  const [catPrice, setCatPrice] = useState(String(initialCatalog[0]?.priceIdr ?? 0));
  const [catVersion, setCatVersion] = useState<number | undefined>(initialCatalog[0]?.version);
  const [catReason, setCatReason] = useState("");

  // Grant form
  const [grantSlug, setGrantSlug] = useState(
    initialCatalog.find((c) => c.visibilityTier === "private_client")?.slug ??
      initialCatalog[0]?.slug ??
      "",
  );
  const [grantTenantId, setGrantTenantId] = useState("");
  const [grantAgencyId, setGrantAgencyId] = useState("");
  const [grantReason, setGrantReason] = useState("");

  // Request transition state
  const [selectedReqId, setSelectedReqId] = useState(initialRequests[0]?.id ?? "");
  const [reqNextStatus, setReqNextStatus] = useState<
    "quoted" | "in_progress" | "fulfilled" | "declined"
  >("quoted");
  const [reqQuote, setReqQuote] = useState("");
  const [reqGrantId, setReqGrantId] = useState(
    initialGrants.find((g) => g.status === "active")?.id ?? "",
  );
  const [reqReason, setReqReason] = useState("");

  function selectCatalogRow(item: ConsolePluginCatalogDto) {
    setCatSlug(item.slug);
    setCatName(item.name);
    setCatTier(item.visibilityTier);
    setCatModel(item.billingModel);
    setCatPrice(String(item.priceIdr));
    setCatVersion(item.version);
  }

  async function handleSaveCatalog(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/console/plugins/catalog", {
        method: catVersion ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: catSlug.trim(),
          name: catName.trim(),
          visibilityTier: catTier,
          billingModel: catModel,
          priceIdr: Number.parseInt(catPrice || "0", 10) || 0,
          active: true,
          ...(catVersion ? { expectedVersion: catVersion } : {}),
          reason: catReason.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly item?: ConsolePluginCatalogDto;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.item) {
        setNotice({
          variant: "destructive",
          title: "Gagal memperbarui katalog plugin",
          description: data.error?.message ?? "Pastikan 2FA step-up aktif dan alasan audit >= 10 karakter.",
        });
        return;
      }
      setCatalog((prev) => {
        const idx = prev.findIndex((i) => i.slug === data.item!.slug);
        if (idx >= 0) {
          return prev.map((i) => (i.slug === data.item!.slug ? data.item! : i));
        }
        return [data.item!, ...prev];
      });
      setCatVersion(data.item.version);
      setCatReason("");
      setNotice({
        variant: "success",
        title: `Katalog ${data.item.slug} diperbarui (v${data.item.version})`,
        description: `Tier: ${data.item.visibilityTier}, Model: ${data.item.billingModel}, Harga: ${formatIdr(data.item.priceIdr)}.`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleIssueGrant(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/console/plugins/grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pluginSlug: grantSlug.trim(),
          ...(grantTenantId.trim() ? { tenantId: grantTenantId.trim() } : {}),
          ...(grantAgencyId.trim() ? { agencyId: grantAgencyId.trim() } : {}),
          reason: grantReason.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly grant?: ConsolePluginGrantDto;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.grant) {
        setNotice({
          variant: "destructive",
          title: "Gagal menerbitkan izin private_client",
          description: data.error?.message ?? "Periksa target tenant/agensi, 2FA step-up, dan alasan audit.",
        });
        return;
      }
      setGrants((prev) => [data.grant!, ...prev]);
      setGrantReason("");
      setNotice({
        variant: "success",
        title: `Izin ${data.grant.id} aktif`,
        description: `Plugin ${data.grant.pluginSlug} kini dapat diakses oleh target yang ditunjuk.`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleTransitionRequest(event: React.FormEvent) {
    event.preventDefault();
    const target = requests.find((r) => r.id === selectedReqId);
    if (!target || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/console/plugins/requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: target.id,
          status: reqNextStatus,
          expectedVersion: target.version,
          ...(reqQuote.trim() ? { quoteAmountIdr: Number.parseInt(reqQuote, 10) } : {}),
          ...(reqNextStatus === "fulfilled" && reqGrantId.trim()
            ? { linkedGrantId: reqGrantId.trim() }
            : {}),
          reason: reqReason.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly request?: ConsoleCustomPluginRequestDto;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.request) {
        setNotice({
          variant: "destructive",
          title: "Transisi permintaan Custom Dev ditolak",
          description: data.error?.message ?? "Status fulfilled wajib menautkan izin private_client aktif.",
        });
        return;
      }
      setRequests((prev) => prev.map((r) => (r.id === data.request!.id ? data.request! : r)));
      setReqReason("");
      setNotice({
        variant: "success",
        title: `Permintaan ${data.request.requestCode} diperbarui`,
        description: `Status kini ${data.request.status} (v${data.request.version}).`,
      });
    } finally {
      setBusy(false);
    }
  }

  const activeGrants = grants.filter((g) => g.status === "active");

  return (
    <div className="space-y-5" data-testid="console-plugins-panel">
      {notice ? (
        <Alert variant={notice.variant} data-testid="console-plugins-notice">
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.description}</AlertDescription>
        </Alert>
      ) : null}

      {/* Console Sub-tabs */}
      <div
        role="tablist"
        aria-label="Manajemen Toko Plugin Console"
        className="flex flex-wrap gap-2 border-b border-border pb-3"
      >
        <Button
          role="tab"
          id="console-tab-catalog"
          aria-selected={activeTab === "catalog"}
          variant={activeTab === "catalog" ? "default" : "outline"}
          size="sm"
          className="min-h-11 md:min-h-9"
          onClick={() => setActiveTab("catalog")}
        >
          <LayersIcon className="size-3.5" aria-hidden="true" />
          Katalog &amp; Promosi Tier ({catalog.length})
        </Button>
        <Button
          role="tab"
          id="console-tab-grants"
          aria-selected={activeTab === "grants"}
          variant={activeTab === "grants" ? "default" : "outline"}
          size="sm"
          className="min-h-11 md:min-h-9"
          onClick={() => setActiveTab("grants")}
        >
          <KeyRoundIcon className="size-3.5" aria-hidden="true" />
          Izin Khusus Klien ({activeGrants.length})
        </Button>
        <Button
          role="tab"
          id="console-tab-requests"
          aria-selected={activeTab === "requests"}
          variant={activeTab === "requests" ? "default" : "outline"}
          size="sm"
          className="min-h-11 md:min-h-9"
          onClick={() => setActiveTab("requests")}
        >
          <WrenchIcon className="size-3.5" aria-hidden="true" />
          Permintaan Custom Dev ({requests.length})
        </Button>
      </div>

      {/* Tab 1: Catalog & Tier Promotion */}
      {activeTab === "catalog" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5" data-testid="console-catalog-tab">
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="text-base">Katalog Plugin Platform</CardTitle>
              <CardDescription>
                Promosikan plugin <code>private_client</code> menjadi <code>public_free</code> atau{" "}
                <code>public_paid</code> langsung via metadata teraudit tanpa ubah kode.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plugin</TableHead>
                    <TableHead>Tier</TableHead>
                    <TableHead>Skema</TableHead>
                    <TableHead className="text-right">Harga</TableHead>
                    <TableHead className="text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {catalog.map((item) => (
                    <TableRow key={item.slug}>
                      <TableCell>
                        <div className="text-xs font-medium text-foreground">{item.name}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {item.slug} · v{item.version}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            item.visibilityTier === "private_client"
                              ? "warning"
                              : item.visibilityTier === "public_paid"
                                ? "info"
                                : "secondary"
                          }
                        >
                          {item.visibilityTier}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{item.billingModel}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {formatIdr(item.priceIdr)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          className="min-h-9"
                          onClick={() => selectCatalogRow(item)}
                        >
                          Ubah / Promosi
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Ubah / Promosikan Tier Plugin</CardTitle>
              <CardDescription>
                Wajib 2FA step-up (&lt;10m), OCC version, dan alasan audit (10–500 karakter).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={(e) => void handleSaveCatalog(e)}>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="cat-slug">Slug Plugin</label>
                  <Input
                    id="cat-slug"
                    value={catSlug}
                    onChange={(e) => setCatSlug(e.target.value)}
                    placeholder="rab-calculator"
                    className="min-h-11 md:min-h-9 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="cat-name">Nama Tampilan</label>
                  <Input
                    id="cat-name"
                    value={catName}
                    onChange={(e) => setCatName(e.target.value)}
                    className="min-h-11 md:min-h-9"
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium" htmlFor="cat-tier">Visibility Tier</label>
                    <select
                      id="cat-tier"
                      value={catTier}
                      onChange={(e) =>
                        setCatTier(
                          e.target.value as "public_free" | "public_paid" | "private_client",
                        )
                      }
                      className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm md:min-h-9"
                    >
                      <option value="private_client">private_client</option>
                      <option value="public_free">public_free</option>
                      <option value="public_paid">public_paid</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium" htmlFor="cat-model">Billing Model</label>
                    <select
                      id="cat-model"
                      value={catModel}
                      onChange={(e) =>
                        setCatModel(
                          e.target.value as "free" | "paid_once" | "paid_monthly" | "paid_yearly",
                        )
                      }
                      className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm md:min-h-9"
                    >
                      <option value="free">free</option>
                      <option value="paid_once">paid_once</option>
                      <option value="paid_monthly">paid_monthly</option>
                      <option value="paid_yearly">paid_yearly</option>
                    </select>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="cat-price">Harga (IDR)</label>
                  <Input
                    id="cat-price"
                    type="number"
                    min={0}
                    value={catPrice}
                    onChange={(e) => setCatPrice(e.target.value)}
                    className="min-h-11 md:min-h-9 tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="cat-reason">
                    Alasan Audit (min. 10 karakter)
                  </label>
                  <Input
                    id="cat-reason"
                    required
                    minLength={10}
                    value={catReason}
                    onChange={(e) => setCatReason(e.target.value)}
                    placeholder="Promosi plugin bespoke ke katalog public_paid..."
                    className="min-h-11 md:min-h-9"
                  />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-11 w-full md:min-h-9"
                  disabled={busy || !stepUpFresh}
                >
                  <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
                  Simpan &amp; Audit Perubahan
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Tab 2: Private Client Grants */}
      {activeTab === "grants" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5" data-testid="console-grants-tab">
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="text-base">Daftar Izin Khusus Klien &amp; Agensi</CardTitle>
              <CardDescription>
                Plugin <code>private_client</code> tersembunyi 100% dari tenant tanpa izin aktif.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID Izin</TableHead>
                    <TableHead>Plugin</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grants.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="font-mono text-xs">{g.id}</TableCell>
                      <TableCell className="font-mono text-xs">{g.pluginSlug}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {g.tenantId ? `Tenant: ${g.tenantId}` : `Agensi: ${g.agencyId}`}
                      </TableCell>
                      <TableCell>
                        <Badge variant={g.status === "active" ? "success" : "outline"}>
                          {g.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Terbitkan Izin private_client</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={(e) => void handleIssueGrant(e)}>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="grant-slug">Plugin Slug</label>
                  <Input
                    id="grant-slug"
                    required
                    value={grantSlug}
                    onChange={(e) => setGrantSlug(e.target.value)}
                    className="min-h-11 md:min-h-9 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="grant-tenant">Tenant ID (Opsional jika Agensi)</label>
                  <Input
                    id="grant-tenant"
                    value={grantTenantId}
                    onChange={(e) => setGrantTenantId(e.target.value)}
                    className="min-h-11 md:min-h-9 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="grant-agency">Agency ID (Opsional jika Tenant)</label>
                  <Input
                    id="grant-agency"
                    value={grantAgencyId}
                    onChange={(e) => setGrantAgencyId(e.target.value)}
                    className="min-h-11 md:min-h-9 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="grant-reason">Alasan Audit (min. 10 karakter)</label>
                  <Input
                    id="grant-reason"
                    required
                    minLength={10}
                    value={grantReason}
                    onChange={(e) => setGrantReason(e.target.value)}
                    placeholder="Penyerahan plugin khusus kontrak klien #..."
                    className="min-h-11 md:min-h-9"
                  />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-11 w-full md:min-h-9"
                  disabled={busy || !stepUpFresh}
                >
                  Terbitkan Izin Aktif
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Tab 3: Custom Dev Requests Fulfillment */}
      {activeTab === "requests" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5" data-testid="console-requests-tab">
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="text-base">Antrean Permintaan Custom Plugin (custom_plugin)</CardTitle>
              <CardDescription>
                Status <code>fulfilled</code> diblokir otomatis (<code>422 GRANT_REQUIRED</code>)
                hingga izin <code>private_client</code> aktif ditautkan.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kode</TableHead>
                    <TableHead>Tenant / Judul</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Penawaran</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.map((r) => (
                    <TableRow
                      key={r.id}
                      onClick={() => setSelectedReqId(r.id)}
                      className="cursor-pointer"
                    >
                      <TableCell className="font-mono text-xs">{r.requestCode}</TableCell>
                      <TableCell className="text-xs">
                        <div className="font-medium text-foreground">{r.title}</div>
                        <div className="text-muted-foreground">
                          {r.tenantHandle ?? r.tenantId} · WA {r.contactWhatsapp}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.status === "fulfilled" ? "success" : "outline"}>
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {r.quoteAmountIdr !== null ? formatIdr(r.quoteAmountIdr) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Proses / Penuhi Permintaan</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={(e) => void handleTransitionRequest(e)}>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="req-select">Permintaan</label>
                  <select
                    id="req-select"
                    value={selectedReqId}
                    onChange={(e) => setSelectedReqId(e.target.value)}
                    className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm md:min-h-9"
                  >
                    {requests.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.requestCode} — {r.title} ({r.status})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="req-status">Status Berikutnya</label>
                  <select
                    id="req-status"
                    value={reqNextStatus}
                    onChange={(e) =>
                      setReqNextStatus(
                        e.target.value as "quoted" | "in_progress" | "fulfilled" | "declined",
                      )
                    }
                    className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm md:min-h-9"
                  >
                    <option value="quoted">quoted (Kirim Penawaran)</option>
                    <option value="in_progress">in_progress (Sedang Dibangun)</option>
                    <option value="fulfilled">fulfilled (Selesai — Wajib Izin Aktif)</option>
                    <option value="declined">declined (Tolak)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="req-quote">Nominal Penawaran IDR (Opsional)</label>
                  <Input
                    id="req-quote"
                    type="number"
                    min={0}
                    value={reqQuote}
                    onChange={(e) => setReqQuote(e.target.value)}
                    placeholder="3500000"
                    className="min-h-11 md:min-h-9 tabular-nums"
                  />
                </div>
                {reqNextStatus === "fulfilled" ? (
                  <div className="space-y-1">
                    <label className="text-xs font-medium" htmlFor="req-grant-select">
                      Tautkan Izin private_client Aktif (Wajib)
                    </label>
                    <select
                      id="req-grant-select"
                      value={reqGrantId}
                      onChange={(e) => setReqGrantId(e.target.value)}
                      className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm md:min-h-9"
                    >
                      <option value="">-- Pilih Izin Aktif --</option>
                      {activeGrants.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.id} ({g.pluginSlug})
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="req-reason">
                    Alasan Audit (min. 10 karakter)
                  </label>
                  <Input
                    id="req-reason"
                    required
                    minLength={10}
                    value={reqReason}
                    onChange={(e) => setReqReason(e.target.value)}
                    placeholder="Penawaran disetujui klien & izin plugin khusus ditautkan..."
                    className="min-h-11 md:min-h-9"
                  />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-11 w-full md:min-h-9"
                  disabled={busy || !stepUpFresh || !selectedReqId}
                >
                  Simpan Transisi Status
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

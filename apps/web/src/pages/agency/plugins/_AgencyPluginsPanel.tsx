import { useState } from "react";
import { CreditCardIcon, FileTextIcon, ShieldCheckIcon } from "lucide-react";
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

export interface AgencyPluginsClientSummary {
  readonly tenantId: string;
  readonly handle: string;
  readonly name: string;
  readonly effectiveStatus: string;
}

export interface AgencyPaidPluginCatalogDto {
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly billingModel: "paid_once" | "paid_monthly" | "paid_yearly";
  readonly priceIdr: number;
}

export interface AgencyPluginEntitlementDto {
  readonly id: string;
  readonly tenantId: string;
  readonly pluginSlug: string;
  readonly sourceKind: string;
  readonly status: string;
  readonly expiresAtIso: string | null;
}

export interface AgencyPluginReceiptDto {
  readonly id: string;
  readonly receiptNumber: string;
  readonly tenantId: string;
  readonly pluginNameSnapshot: string;
  readonly totalAmountIdr: number;
  readonly paymentChannel: string;
  readonly issuedAtIso: string;
}

export interface AgencyPluginsPanelProps {
  readonly agencyId: string;
  readonly agencyName: string;
  readonly effectiveDiscountPercent: number;
  readonly clients: readonly AgencyPluginsClientSummary[];
  readonly paidPlugins: readonly AgencyPaidPluginCatalogDto[];
  readonly privateGrants: readonly { readonly id: string; readonly pluginSlug: string; readonly grantReason: string }[];
  readonly entitlements: readonly AgencyPluginEntitlementDto[];
  readonly receipts: readonly AgencyPluginReceiptDto[];
}

function formatIdr(amount: number): string {
  return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
}

export function AgencyPluginsPanel({
  agencyId,
  effectiveDiscountPercent,
  clients,
  paidPlugins,
  privateGrants,
  entitlements,
  receipts,
}: AgencyPluginsPanelProps) {
  const [selectedTenantId, setSelectedTenantId] = useState(clients[0]?.tenantId ?? "");
  const [selectedPluginSlug, setSelectedPluginSlug] = useState(paidPlugins[0]?.slug ?? "");
  const [channelCode, setChannelCode] = useState("QRIS");
  const [couponCode, setCouponCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{
    readonly variant: "success" | "destructive";
    readonly title: string;
    readonly description: string;
  } | null>(null);

  async function handleCheckout(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedTenantId || !selectedPluginSlug || submitting) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const res = await fetch("/api/agency/plugins/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          agencyId,
          tenantId: selectedTenantId,
          pluginSlug: selectedPluginSlug,
          channelCode,
          ...(couponCode.trim() ? { couponCode: couponCode.trim().toUpperCase() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly order?: { readonly id: string; readonly totalPayableIdr: number; readonly channelCode: string };
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.order) {
        setNotice({
          variant: "destructive",
          title: "Gagal membuat tagihan add-on agensi",
          description: data.error?.message ?? "Periksa pilihan klien, plugin, atau kupon.",
        });
        return;
      }
      setNotice({
        variant: "success",
        title: "Instruksi pembayaran add-on agensi dibuat",
        description: `Total dibayar ${formatIdr(data.order.totalPayableIdr)} via ${data.order.channelCode} (ID: ${data.order.id}).`,
      });
      setCouponCode("");
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Tidak dapat menghubungi server penagihan agensi.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="agency-plugins-panel">
      {notice ? (
        <Alert variant={notice.variant}>
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.description}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Agency Add-on Checkout Card */}
        <Card data-testid="agency-plugin-checkout-card">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Beli Add-on Plugin untuk Klien</CardTitle>
              <Badge variant="success" className="tabular-nums">
                Diskon Agensi {effectiveDiscountPercent}%
              </Badge>
            </div>
            <CardDescription>
              Penagihan add-on klien dilakukan terpusat melalui agensi (QRIS / Bank VA) dengan
              kuitansi PDF resmi non-PKP.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={(e) => void handleCheckout(e)}>
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="agency-client-select">
                  Pilih Situs Klien
                </label>
                <select
                  id="agency-client-select"
                  value={selectedTenantId}
                  onChange={(e) => setSelectedTenantId(e.target.value)}
                  className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm md:min-h-9"
                >
                  {clients.map((c) => (
                    <option key={c.tenantId} value={c.tenantId}>
                      {c.name} ({c.handle})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="agency-plugin-select">
                  Pilih Add-on Plugin Berbayar
                </label>
                <select
                  id="agency-plugin-select"
                  value={selectedPluginSlug}
                  onChange={(e) => setSelectedPluginSlug(e.target.value)}
                  className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm md:min-h-9"
                >
                  {paidPlugins.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.name} — {formatIdr(p.priceIdr)} ({p.billingModel})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="agency-channel-select">
                    Channel Pembayaran
                  </label>
                  <select
                    id="agency-channel-select"
                    value={channelCode}
                    onChange={(e) => setChannelCode(e.target.value)}
                    className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm md:min-h-9"
                  >
                    <option value="QRIS">QRIS</option>
                    <option value="VA_BCA">VA BCA</option>
                    <option value="VA_MANDIRI">VA Mandiri</option>
                    <option value="VA_BRI">VA BRI</option>
                    <option value="VA_BNI">VA BNI</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="agency-coupon-input">
                    Kode Kupon (Opsional)
                  </label>
                  <Input
                    id="agency-coupon-input"
                    value={couponCode}
                    onChange={(e) => setCouponCode(e.target.value)}
                    placeholder="Opsional"
                    className="min-h-11 md:min-h-9"
                  />
                </div>
              </div>

              <Button
                type="submit"
                size="sm"
                className="min-h-11 md:min-h-9"
                disabled={submitting || !selectedTenantId || !selectedPluginSlug}
              >
                <CreditCardIcon className="size-3.5" aria-hidden="true" />
                {submitting ? "Memproses..." : "Buat Tagihan Add-on Agensi"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Agency Private Client Grants */}
        <Card data-testid="agency-private-grants-card">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheckIcon className="size-4 text-primary" aria-hidden="true" />
              <CardTitle className="text-base">Izin Plugin Khusus Agensi (private_client)</CardTitle>
            </div>
            <CardDescription>
              Plugin khusus yang diberikan ke agensi ini otomatis tersedia bagi seluruh situs klien
              yang Anda kelola.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {privateGrants.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Belum ada izin plugin khusus (private_client) yang aktif untuk agensi ini.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {privateGrants.map((g) => (
                  <li
                    key={g.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                  >
                    <span className="font-mono text-xs font-medium">{g.pluginSlug}</span>
                    <Badge variant="success">Aktif</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Active Entitlements & Receipts */}
      <Card data-testid="agency-entitlements-table">
        <CardHeader>
          <CardTitle className="text-base">Lisensi Add-on Klien &amp; Kuitansi PDF</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 overflow-x-auto">
          {entitlements.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Plugin</TableHead>
                  <TableHead>Sumber</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entitlements.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono text-xs">{e.tenantId}</TableCell>
                    <TableCell className="font-mono text-xs">{e.pluginSlug}</TableCell>
                    <TableCell className="text-xs">{e.sourceKind}</TableCell>
                    <TableCell>
                      <Badge variant={e.status === "active" ? "success" : "outline"}>{e.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">Belum ada lisensi add-on aktif untuk klien.</p>
          )}

          {receipts.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nomor Kuitansi</TableHead>
                  <TableHead>Plugin</TableHead>
                  <TableHead className="text-right">Nominal</TableHead>
                  <TableHead className="text-right">PDF</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receipts.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.receiptNumber}</TableCell>
                    <TableCell className="text-xs">{r.pluginNameSnapshot}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {formatIdr(r.totalAmountIdr)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-9"
                        render={
                          <a href={`/api/agency/plugins/receipts/${encodeURIComponent(r.id)}/pdf`} />
                        }
                      >
                        <FileTextIcon className="size-3.5" aria-hidden="true" />
                        Unduh
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

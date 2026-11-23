import * as React from "react";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  Building2Icon,
  CheckCircle2Icon,
  PlusIcon,
} from "lucide-react";
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
import type { AgencyClientDto } from "../../api/agency/_shared";
import type { AgencyTrialQuotaSummary } from "@punyasitus/db/agencies/index";

export interface AgencyClientsPanelProps {
  readonly agencyId: string;
  readonly agencyName: string;
  readonly initialClients: readonly AgencyClientDto[];
  readonly initialTrialQuota: AgencyTrialQuotaSummary;
}

const VERTICAL_OPTIONS = [
  { value: "compro", label: "Company Profile / B2B" },
  { value: "sales", label: "Personal Brand / Jasa" },
  { value: "catalog", label: "Katalog Produk WA" },
  { value: "travel", label: "Travel & Umrah" },
  { value: "resto", label: "Outlet / F&B" },
  { value: "dealer", label: "Showroom Kendaraan" },
] as const;

function statusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Aktif";
    case "trial":
      return "Uji Coba";
    case "grace":
      return "Masa Tenggang";
    case "locked":
      return "Terkunci";
    case "suspended":
      return "Ditangguhkan";
    default:
      return status;
  }
}

export function AgencyClientsPanel({
  agencyId,
  agencyName,
  initialClients,
  initialTrialQuota,
}: AgencyClientsPanelProps) {
  const [clients, setClients] = React.useState<readonly AgencyClientDto[]>(initialClients);
  const [quota, setQuota] = React.useState<AgencyTrialQuotaSummary>(initialTrialQuota);
  const [name, setName] = React.useState("");
  const [handle, setHandle] = React.useState("");
  const [vertical, setVertical] = React.useState("compro");
  const [clientOwnerEmail, setClientOwnerEmail] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [switchingTenantId, setSwitchingTenantId] = React.useState<string | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [successMsg, setSuccessMsg] = React.useState<string | null>(null);

  async function handleCreateClient(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    setCreating(true);
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await fetch("/api/agency/clients", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        credentials: "same-origin",
        body: JSON.stringify({
          agencyId,
          name: name.trim(),
          handle: handle.trim().toLowerCase(),
          vertical,
          ...(clientOwnerEmail.trim() ? { clientOwnerEmail: clientOwnerEmail.trim() } : {}),
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly client?: AgencyClientDto;
        readonly trialQuota?: AgencyTrialQuotaSummary;
        readonly error?: { readonly code?: string; readonly message?: string };
      };

      if (!res.ok || !data.success || !data.client) {
        setErrorMsg(data.error?.message ?? "Gagal membuat situs klien baru.");
        return;
      }

      setClients((prev) => [data.client!, ...prev]);
      if (data.trialQuota) {
        setQuota(data.trialQuota);
      }
      setName("");
      setHandle("");
      setClientOwnerEmail("");
      setSuccessMsg(`Situs klien "${data.client.name}" (${data.client.primaryHost}) berhasil dibuat.`);
    } catch {
      setErrorMsg("Terjadi gangguan jaringan saat membuat situs klien.");
    } finally {
      setCreating(false);
    }
  }

  async function handleSwitchToClient(client: AgencyClientDto) {
    setErrorMsg(null);
    setSwitchingTenantId(client.tenantId);
    try {
      const res = await fetch(
        `/api/agency/clients/${encodeURIComponent(client.tenantId)}/switch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({}),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.success) {
        setErrorMsg(data.error?.message ?? "Gagal membuka konteks situs klien.");
        return;
      }
      window.location.href = client.manageUrl;
    } catch {
      setErrorMsg("Gagal menghubungi server saat beralih konteks klien.");
    } finally {
      setSwitchingTenantId(null);
    }
  }

  return (
    <div className="space-y-5" data-testid="agency-clients-panel">
      <Card data-testid="agency-clients-quota-card">
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">
              Kuota Uji Coba Belum Berbayar ({agencyName})
            </p>
            <p className="text-xs text-muted-foreground">
              {quota.unlockedByPaidClient
                ? `Terbuka penuh — ${quota.paidClientCount} situs klien sudah berlangganan aktif.`
                : `Terpakai ${quota.unpaidTrialCount} dari ${quota.unpaidTrialCap} situs uji coba. Selesaikan pembayaran minimal 1 klien untuk membuka kuota tanpa batas.`}
            </p>
          </div>
          <Badge
            variant={quota.canCreateTrial ? "secondary" : "destructive"}
            className="w-fit tabular-nums"
            data-testid="agency-trial-quota-badge"
          >
            {quota.unlockedByPaidClient
              ? "Kuota Terbuka"
              : `${quota.unpaidTrialCount} / ${quota.unpaidTrialCap} Uji Coba`}
          </Badge>
        </CardContent>
      </Card>

      {errorMsg && (
        <Alert variant="destructive" data-testid="agency-clients-error">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Operasi tidak dapat diproses</AlertTitle>
          <AlertDescription>{errorMsg}</AlertDescription>
        </Alert>
      )}

      {successMsg && (
        <Alert variant="info" data-testid="agency-clients-success">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Situs klien siap dikelola</AlertTitle>
          <AlertDescription>{successMsg}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PlusIcon className="size-4 text-primary" aria-hidden="true" />
            Buat Situs Klien Baru
          </CardTitle>
          <CardDescription>
            Situs baru langsung terhubung ke agensi dengan pembayar 100% agensi dan masa uji coba 7 hari.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreateClient} className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="client-name" className="block text-sm font-medium text-foreground">
                Nama Bisnis Klien
              </label>
              <Input
                id="client-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Contoh: Klinik Gigi Sehat"
                required
                className="min-h-11 text-base md:min-h-9 md:text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="client-handle" className="block text-sm font-medium text-foreground">
                Subdomain Handle (.situsku.click)
              </label>
              <Input
                id="client-handle"
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value.toLowerCase())}
                placeholder="klinik-gigi-sehat"
                required
                className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="client-vertical" className="block text-sm font-medium text-foreground">
                Kategori Bisnis
              </label>
              <select
                id="client-vertical"
                value={vertical}
                onChange={(e) => setVertical(e.target.value)}
                className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 md:text-sm"
              >
                {VERTICAL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="client-owner-email" className="block text-sm font-medium text-foreground">
                Email Pemilik Klien (Opsional, tanpa akses tagihan)
              </label>
              <Input
                id="client-owner-email"
                type="email"
                value={clientOwnerEmail}
                onChange={(e) => setClientOwnerEmail(e.target.value)}
                placeholder="klien@perusahaan.co.id"
                className="min-h-11 text-base md:min-h-9 md:text-sm"
              />
            </div>

            <div className="flex items-center md:col-span-2">
              <Button
                type="submit"
                disabled={creating || !quota.canCreateTrial}
                data-testid="agency-create-client-submit"
                className="min-h-11 w-full sm:w-auto md:min-h-9"
              >
                <Building2Icon className="size-4" aria-hidden="true" />
                {creating
                  ? "Membuat situs klien..."
                  : !quota.canCreateTrial
                    ? "Kuota Uji Coba Penuh — Bayar 1 Klien Dahulu"
                    : "Buat Situs Klien"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle>Daftar Situs Klien ({clients.length})</CardTitle>
          <CardDescription>
            Hanya situs klien milik agensi ini yang ditampilkan. Klik &ldquo;Kelola Situs&rdquo;
            untuk beralih konteks dengan catatan audit pengguna agensi.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {clients.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              Belum ada situs klien yang dibuat.
            </div>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Klien</TableHead>
                      <TableHead>Subdomain</TableHead>
                      <TableHead>Kategori</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Tindakan</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {clients.map((c) => (
                      <TableRow key={c.tenantId} data-testid={`agency-client-row-${c.handle}`}>
                        <TableCell className="font-medium text-foreground">{c.name}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {c.primaryHost}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{c.vertical}</TableCell>
                        <TableCell>
                          <Badge variant={c.effectiveStatus === "active" ? "default" : "secondary"}>
                            {statusLabel(c.effectiveStatus)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={switchingTenantId === c.tenantId}
                              data-testid={`agency-switch-btn-${c.handle}`}
                              onClick={() => handleSwitchToClient(c)}
                              className="min-h-9"
                            >
                              {switchingTenantId === c.tenantId ? "Membuka..." : "Kelola Situs"}
                              <ArrowRightIcon className="size-3.5" aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <ul className="divide-y divide-border md:hidden">
                {clients.map((c) => (
                  <li key={c.tenantId} className="space-y-2.5 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-foreground">{c.name}</p>
                      <Badge variant={c.effectiveStatus === "active" ? "default" : "secondary"}>
                        {statusLabel(c.effectiveStatus)}
                      </Badge>
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">{c.primaryHost}</p>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={switchingTenantId === c.tenantId}
                      onClick={() => handleSwitchToClient(c)}
                      className="min-h-11 w-full"
                    >
                      {switchingTenantId === c.tenantId ? "Membuka..." : "Kelola Situs"}
                      <ArrowRightIcon className="size-3.5" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

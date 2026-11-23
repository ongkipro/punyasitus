import * as React from "react";
import {
  AlertCircleIcon,
  BanIcon,
  Building2Icon,
  CheckCircle2Icon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  WrenchIcon,
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

export interface ConsoleProvisionedTenantDto {
  readonly id: string;
  readonly organizationId: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: "compro" | "sales" | "travel" | "catalog" | "resto" | "dealer";
  readonly status: string;
  readonly effectiveStatus: string;
  readonly operatorHold: boolean;
  readonly operatorHoldReason: string | null;
  readonly primaryHost: string;
  readonly ownerEmail: string | null;
  readonly version: number;
  readonly cacheVersion: number;
  readonly createdAt: number;
}

export interface ConsoleProvisioningPanelProps {
  readonly initialTenants: readonly ConsoleProvisionedTenantDto[];
  readonly saasZone: string;
  readonly operatorEmail: string;
}

const VERTICAL_OPTIONS = [
  { value: "compro", label: "Company Profile (compro)" },
  { value: "sales", label: "Jasa & Personal Brand (sales)" },
  { value: "travel", label: "Travel & Umrah (travel)" },
  { value: "catalog", label: "Katalog Produk (catalog)" },
  { value: "resto", label: "Resto & Gerai Offline (resto)" },
  { value: "dealer", label: "Showroom Kendaraan (dealer)" },
] as const;

function createUuidKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `prov-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function statusBadgeProps(status: string, operatorHold: boolean): {
  readonly label: string;
  readonly variant: "default" | "secondary" | "outline" | "destructive";
} {
  if (operatorHold) {
    return { label: "Ditangguhkan (Hold)", variant: "destructive" };
  }
  switch (status) {
    case "active":
      return { label: "Aktif", variant: "default" };
    case "trial":
      return { label: "Uji Coba", variant: "secondary" };
    case "grace":
      return { label: "Masa Tenggang", variant: "outline" };
    case "locked":
      return { label: "Terkunci", variant: "destructive" };
    case "suspended":
      return { label: "Ditangguhkan", variant: "destructive" };
    case "recovery":
      return { label: "Pemulihan", variant: "destructive" };
    default:
      return { label: status, variant: "outline" };
  }
}

export function ConsoleProvisioningPanel({
  initialTenants,
  saasZone,
  operatorEmail,
}: ConsoleProvisioningPanelProps) {
  const [tenants, setTenants] = React.useState<readonly ConsoleProvisionedTenantDto[]>(initialTenants);
  const [handle, setHandle] = React.useState("");
  const [name, setName] = React.useState("");
  const [ownerEmail, setOwnerEmail] = React.useState("");
  const [vertical, setVertical] = React.useState<ConsoleProvisionedTenantDto["vertical"]>("compro");
  const [initialStatus, setInitialStatus] = React.useState<"trial" | "active">("trial");
  const [reason, setReason] = React.useState("");
  const [idempotencyKey, setIdempotencyKey] = React.useState(() => createUuidKey());

  const [formError, setFormError] = React.useState<string | null>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [provisionSuccess, setProvisionSuccess] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // State-transition form state
  const [selectedTenantId, setSelectedTenantId] = React.useState<string>(
    initialTenants[0]?.id ?? "",
  );
  const [stateAction, setStateAction] = React.useState<
    "suspend_hold" | "release_hold" | "enter_recovery" | "exit_recovery"
  >("suspend_hold");
  const [stateReason, setStateReason] = React.useState("");
  const [stateError, setStateError] = React.useState<string | null>(null);
  const [stateSuccess, setStateSuccess] = React.useState<string | null>(null);
  const [stateSubmitting, setStateSubmitting] = React.useState(false);

  const selectedTenant = React.useMemo(
    () => tenants.find((t) => t.id === selectedTenantId) ?? null,
    [tenants, selectedTenantId],
  );

  const normalizedHandlePreview = handle.trim().toLowerCase() || "contoh-bisnis";

  async function refreshTenants() {
    try {
      const res = await fetch("/api/console/provisioning", {
        method: "GET",
        credentials: "same-origin",
      });
      const data = (await res.json()) as {
        success?: boolean;
        items?: readonly ConsoleProvisionedTenantDto[];
      };
      if (res.ok && data.success && Array.isArray(data.items)) {
        setTenants(data.items);
        if (!selectedTenantId && data.items[0]) {
          setSelectedTenantId(data.items[0].id);
        }
      }
    } catch {
      // Keep existing state; operator can retry
    }
  }

  async function handleProvisionSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldError(null);
    setProvisionSuccess(null);

    const trimmedHandle = handle.trim().toLowerCase();
    const trimmedName = name.trim();
    const trimmedEmail = ownerEmail.trim().toLowerCase();
    const trimmedReason = reason.trim();

    if (trimmedHandle.length < 3 || trimmedHandle.length > 40) {
      setFieldError("Handle situs wajib diisi 3 hingga 40 karakter (huruf kecil, angka, tanda hubung).");
      return;
    }
    if (trimmedName.length < 2) {
      setFieldError("Nama bisnis wajib diisi minimal 2 karakter.");
      return;
    }
    if (!trimmedEmail.includes("@")) {
      setFieldError("Alamat email pemilik wajib berformat valid.");
      return;
    }
    if (trimmedReason.length < 10) {
      setFieldError("Alasan operasional audit wajib diisi minimal 10 karakter.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/console/provisioning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        credentials: "same-origin",
        body: JSON.stringify({
          handle: trimmedHandle,
          name: trimmedName,
          ownerEmail: trimmedEmail,
          vertical,
          initialStatus,
          reason: trimmedReason,
          idempotencyKey,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        replayed?: boolean;
        code?: string;
        message?: string;
        tenant?: ConsoleProvisionedTenantDto;
      };

      if (!res.ok || !data.success || !data.tenant) {
        setFormError(data.message ?? "Provisioning tenant gagal diproses.");
        return;
      }

      const provisioned = data.tenant;
      setTenants((prev) => {
        const filtered = prev.filter((item) => item.id !== provisioned.id);
        return [provisioned, ...filtered];
      });
      setSelectedTenantId(provisioned.id);
      setProvisionSuccess(
        data.replayed
          ? `Replay idempoten terdeteksi: tenant "${provisioned.handle}" dikembalikan tanpa duplikasi.`
          : `Tenant "${provisioned.name}" (${provisioned.primaryHost}) berhasil dibuat dan dicatat ke audit log.`,
      );
      if (!data.replayed) {
        setHandle("");
        setName("");
        setOwnerEmail("");
        setReason("");
        setIdempotencyKey(createUuidKey());
      }
    } catch {
      setFormError("Gagal menghubungi endpoint provisioning console. Coba lagi.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStateTransitionSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setStateError(null);
    setStateSuccess(null);

    if (!selectedTenant) {
      setStateError("Pilih tenant terlebih dahulu sebelum menjalankan transisi status.");
      return;
    }
    const trimmedReason = stateReason.trim();
    if (trimmedReason.length < 10) {
      setStateError("Alasan operasional audit wajib diisi minimal 10 karakter (maksimal 500 karakter).");
      return;
    }

    setStateSubmitting(true);
    try {
      const transitionKey = createUuidKey();
      const res = await fetch(
        `/api/console/tenants/${encodeURIComponent(selectedTenant.id)}/state`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": transitionKey,
          },
          credentials: "same-origin",
          body: JSON.stringify({
            action: stateAction,
            reason: trimmedReason,
            expectedVersion: selectedTenant.version,
            idempotencyKey: transitionKey,
          }),
        },
      );
      const data = (await res.json()) as {
        success?: boolean;
        code?: string;
        message?: string;
        tenant?: ConsoleProvisionedTenantDto;
      };
      if (!res.ok || !data.success || !data.tenant) {
        setStateError(data.message ?? "Gagal mengubah status layanan tenant.");
        return;
      }

      const updated = data.tenant;
      setTenants((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      setStateReason("");
      setStateSuccess(
        `Status layanan "${updated.handle}" diperbarui menjadi "${updated.effectiveStatus}" (v${updated.version}, cache v${updated.cacheVersion}) dan dicatat di audit log.`,
      );
    } catch {
      setStateError("Gagal menghubungi endpoint transisi status. Silakan coba lagi.");
    } finally {
      setStateSubmitting(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="console-provisioning-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" data-testid="console-context-badge">
              <ShieldCheckIcon className="mr-1 size-3.5 text-primary" aria-hidden="true" />
              Console Operasional Platform
            </Badge>
            <span className="text-xs text-muted-foreground">Operator: {operatorEmail}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Provisioning Tenant & Status Layanan
          </h1>
          <p className="text-sm text-muted-foreground">
            Buat organisasi dan tenant baru secara atomik atau ubah status layanan dengan catatan audit
            wajib. Tanpa impersonasi konten pelanggan.
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full sm:w-auto md:min-h-9"
          onClick={refreshTenants}
          data-testid="console-refresh-tenants"
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          Muat ulang daftar
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-6" data-testid="console-provision-card">
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Building2Icon className="size-4 text-primary" aria-hidden="true" />
              Provisioning Tenant Baru
            </CardTitle>
            <CardDescription>
              Membuat 1 organisasi, 1 tenant, subdomain primer{" "}
              <code className="font-mono text-xs">.{saasZone}</code>, pemilik awal, dan log audit
              dalam satu transaksi atomik.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-5">
            <form
              onSubmit={handleProvisionSubmit}
              className="space-y-4"
              noValidate
              data-testid="console-provision-form"
            >
              {fieldError && (
                <Alert variant="destructive" data-testid="provision-validation-error">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Periksa data provisioning</AlertTitle>
                  <AlertDescription>{fieldError}</AlertDescription>
                </Alert>
              )}

              {formError && (
                <Alert variant="destructive" data-testid="provision-server-error">
                  <ShieldAlertIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Provisioning ditolak</AlertTitle>
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}

              {provisionSuccess && (
                <Alert variant="success" role="status" data-testid="provision-success-alert">
                  <CheckCircle2Icon className="size-4" aria-hidden="true" />
                  <AlertTitle>Provisioning berhasil</AlertTitle>
                  <AlertDescription>{provisionSuccess}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-1.5">
                <label htmlFor="provision-name" className="block text-sm font-medium text-foreground">
                  Nama bisnis / situs
                </label>
                <Input
                  id="provision-name"
                  name="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Contoh: PT Nusantara Jaya"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="provision-handle"
                  className="block text-sm font-medium text-foreground"
                >
                  Handle situs (permanen)
                </label>
                <Input
                  id="provision-handle"
                  name="handle"
                  type="text"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  placeholder="contoh-bisnis"
                  autoCapitalize="none"
                  autoCorrect="off"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Alamat awal:{" "}
                  <span className="font-mono text-foreground">
                    https://{normalizedHandlePreview}.{saasZone}
                  </span>
                </p>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="provision-owner-email"
                  className="block text-sm font-medium text-foreground"
                >
                  Email pemilik situs
                </label>
                <Input
                  id="provision-owner-email"
                  name="ownerEmail"
                  type="email"
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                  placeholder="pemilik@perusahaan.id"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Jika akun sudah terdaftar, langsung ditetapkan sebagai Owner; jika belum, dibuatkan
                  undangan Owner berlaku 48 jam.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor="provision-vertical"
                    className="block text-sm font-medium text-foreground"
                  >
                    Vertikal / tema awal
                  </label>
                  <select
                    id="provision-vertical"
                    name="vertical"
                    value={vertical}
                    onChange={(e) =>
                      setVertical(e.target.value as ConsoleProvisionedTenantDto["vertical"])
                    }
                    className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                  >
                    {VERTICAL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="provision-status"
                    className="block text-sm font-medium text-foreground"
                  >
                    Status awal layanan
                  </label>
                  <select
                    id="provision-status"
                    name="initialStatus"
                    value={initialStatus}
                    onChange={(e) =>
                      setInitialStatus(e.target.value === "active" ? "active" : "trial")
                    }
                    className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                  >
                    <option value="trial">Uji Coba 7 Hari (trial)</option>
                    <option value="active">Aktif Terverifikasi (active)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="provision-reason"
                  className="block text-sm font-medium text-foreground"
                >
                  Alasan operasional (audit, 10-500 karakter)
                </label>
                <Input
                  id="provision-reason"
                  name="reason"
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Contoh: Onboarding klien korporasi sesuai tiket #OPS-104"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="provision-idempotency"
                    className="block text-xs font-medium text-muted-foreground"
                  >
                    Kunci Idempotensi (Idempotency-Key)
                  </label>
                  <button
                    type="button"
                    onClick={() => setIdempotencyKey(createUuidKey())}
                    className="inline-flex min-h-11 items-center text-xs font-medium text-primary underline-offset-4 hover:underline md:min-h-0"
                  >
                    Buat kunci baru
                  </button>
                </div>
                <Input
                  id="provision-idempotency"
                  name="idempotencyKey"
                  type="text"
                  value={idempotencyKey}
                  onChange={(e) => setIdempotencyKey(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>

              <Button
                type="submit"
                disabled={submitting}
                className="min-h-11 w-full md:min-h-9"
                data-testid="provision-submit-button"
              >
                {submitting ? "Memproses provisioning..." : "Buat tenant secara atomik"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="lg:col-span-6" data-testid="console-state-transition-card">
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center gap-2 text-lg">
              <WrenchIcon className="size-4 text-primary" aria-hidden="true" />
              Transisi Status Layanan Tenant
            </CardTitle>
            <CardDescription>
              Terapkan atau lepas penangguhan operator (hold) maupun mode pemulihan. Melepas hold
              menghitung ulang hak langganan tanpa memberi waktu aktif gratis.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-5">
            {tenants.length === 0 ? (
              <Alert variant="info" data-testid="console-empty-tenants">
                <AlertTitle>Belum ada tenant terdaftar</AlertTitle>
                <AlertDescription>
                  Gunakan formulir di samping untuk membuat tenant pertama melalui provisioning atomik.
                </AlertDescription>
              </Alert>
            ) : (
              <form
                onSubmit={handleStateTransitionSubmit}
                className="space-y-4"
                noValidate
                data-testid="console-state-form"
              >
                {stateError && (
                  <Alert variant="destructive" data-testid="state-transition-error">
                    <AlertCircleIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>Transisi status gagal</AlertTitle>
                    <AlertDescription>{stateError}</AlertDescription>
                  </Alert>
                )}

                {stateSuccess && (
                  <Alert variant="success" role="status" data-testid="state-transition-success">
                    <CheckCircle2Icon className="size-4" aria-hidden="true" />
                    <AlertTitle>Status layanan diperbarui</AlertTitle>
                    <AlertDescription>{stateSuccess}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-1.5">
                  <label
                    htmlFor="state-tenant-select"
                    className="block text-sm font-medium text-foreground"
                  >
                    Pilih tenant
                  </label>
                  <select
                    id="state-tenant-select"
                    value={selectedTenantId}
                    onChange={(e) => setSelectedTenantId(e.target.value)}
                    className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                  >
                    {tenants.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.handle}) — {t.effectiveStatus} (v{t.version})
                      </option>
                    ))}
                  </select>
                </div>

                {selectedTenant && (
                  <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{selectedTenant.primaryHost}</span>
                      <Badge
                        variant={
                          statusBadgeProps(
                            selectedTenant.effectiveStatus,
                            selectedTenant.operatorHold,
                          ).variant
                        }
                        data-testid="selected-tenant-status-badge"
                      >
                        {
                          statusBadgeProps(
                            selectedTenant.effectiveStatus,
                            selectedTenant.operatorHold,
                          ).label
                        }
                      </Badge>
                    </div>
                    <p className="tabular-nums">
                      Versi: v{selectedTenant.version} · Cache: v{selectedTenant.cacheVersion} ·
                      Pemilik: {selectedTenant.ownerEmail ?? "Belum ditentukan"}
                    </p>
                    {selectedTenant.operatorHoldReason && (
                      <p className="text-destructive">
                        Alasan hold saat ini: {selectedTenant.operatorHoldReason}
                      </p>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  <label
                    htmlFor="state-action-select"
                    className="block text-sm font-medium text-foreground"
                  >
                    Tindakan status layanan
                  </label>
                  <select
                    id="state-action-select"
                    value={stateAction}
                    onChange={(e) =>
                      setStateAction(
                        e.target.value as
                          | "suspend_hold"
                          | "release_hold"
                          | "enter_recovery"
                          | "exit_recovery",
                      )
                    }
                    className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                  >
                    <option value="suspend_hold">
                      Tangguhkan situs (Operator Hold — HTTP 503 publik)
                    </option>
                    <option value="release_hold">
                      Lepas penangguhan (Hitung ulang hak layanan)
                    </option>
                    <option value="enter_recovery">Masuk mode pemulihan (recovery)</option>
                    <option value="exit_recovery">Keluar mode pemulihan</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="state-reason-input"
                    className="block text-sm font-medium text-foreground"
                  >
                    Alasan audit wajib (10-500 karakter)
                  </label>
                  <Input
                    id="state-reason-input"
                    type="text"
                    value={stateReason}
                    onChange={(e) => setStateReason(e.target.value)}
                    placeholder="Contoh: Penangguhan sementara menunggu verifikasi laporan penyalahgunaan"
                    required
                  />
                </div>

                <Button
                  type="submit"
                  variant={stateAction === "suspend_hold" ? "destructive" : "default"}
                  disabled={stateSubmitting}
                  className="min-h-11 w-full md:min-h-9"
                  data-testid="state-transition-submit"
                >
                  {stateAction === "suspend_hold" && (
                    <BanIcon className="size-4" aria-hidden="true" />
                  )}
                  {stateSubmitting ? "Menerapkan transisi..." : "Terapkan perubahan status"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      <Card data-testid="console-tenants-directory">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Direktori Tenant Control Plane</CardTitle>
              <CardDescription>
                Metadata ringkas dari PLATFORM_DB tanpa membuka data konten atau pesan pengunjung.
              </CardDescription>
            </div>
            <Badge variant="outline" className="tabular-nums">
              {tenants.length} tenant
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {tenants.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">Belum ada data tenant.</p>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bisnis & Handle</TableHead>
                      <TableHead>Host Primer</TableHead>
                      <TableHead>Pemilik</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Versi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tenants.map((t) => {
                      const badge = statusBadgeProps(t.effectiveStatus, t.operatorHold);
                      return (
                        <TableRow key={t.id} data-tenant-handle={t.handle}>
                          <TableCell>
                            <div className="font-medium text-foreground">{t.name}</div>
                            <div className="font-mono text-xs text-muted-foreground">{t.handle}</div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-foreground">
                            {t.primaryHost}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {t.ownerEmail ?? "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            v{t.version}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <ul className="divide-y divide-border md:hidden">
                {tenants.map((t) => {
                  const badge = statusBadgeProps(t.effectiveStatus, t.operatorHold);
                  return (
                    <li key={t.id} className="space-y-1.5 px-4 py-3" data-tenant-handle={t.handle}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">{t.name}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {t.primaryHost}
                          </p>
                        </div>
                        <Badge variant={badge.variant} className="shrink-0">
                          {badge.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        Pemilik: {t.ownerEmail ?? "—"} · v{t.version}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

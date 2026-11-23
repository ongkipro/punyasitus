import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  RefreshCwIcon,
  ShieldAlertIcon,
  SirenIcon,
} from "lucide-react";
import {
  PLATFORM_INCIDENT_COMPONENTS,
  type ActiveIncidentStatus,
  type IncidentSeverity,
  type IncidentStatus,
  type PlatformComponentId,
  type PlatformIncidentRecord,
  type PublicIncidentBannerItem,
} from "@punyasitus/db/incidents/index";
import { DashboardIncidentBanner } from "@/components/admin/incident/DashboardIncidentBanner";
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

export interface IncidentsPanelProps {
  readonly initialIncidents: readonly PlatformIncidentRecord[];
  readonly initialBannerIncidents: readonly PublicIncidentBannerItem[];
  readonly stepUpFresh: boolean;
}

const SEVERITY_OPTIONS: readonly {
  readonly value: IncidentSeverity;
  readonly label: string;
  readonly badgeVariant: "info" | "warning" | "destructive";
}[] = [
  { value: "minor", label: "Minor — Gangguan ringan", badgeVariant: "info" },
  { value: "major", label: "Major — Gangguan sebagian layanan", badgeVariant: "warning" },
  { value: "critical", label: "Critical — Gangguan menyeluruh", badgeVariant: "destructive" },
];

const STATUS_LABELS: Readonly<Record<IncidentStatus, string>> = {
  investigating: "Sedang Diinvestigasi",
  identified: "Penyebab Teridentifikasi",
  monitoring: "Pemantauan Pemulihan",
  resolved: "Selesai",
};

const COMPONENT_LABEL_MAP: Readonly<Record<PlatformComponentId, string>> = {
  public_sites: "Situs Publik",
  dashboard_cms: "Dashboard & CMS",
  domains_ssl: "Domain & SSL",
  billing_payments: "Pembayaran & Perpanjangan",
  email_notifications: "Notifikasi Email",
};

function severityBadgeVariant(
  severity: IncidentSeverity,
): "info" | "warning" | "destructive" {
  switch (severity) {
    case "critical":
      return "destructive";
    case "major":
      return "warning";
    case "minor":
      return "info";
  }
}

function severityLabel(severity: IncidentSeverity): string {
  switch (severity) {
    case "critical":
      return "Kritis";
    case "major":
      return "Mayor";
    case "minor":
      return "Minor";
  }
}

function formatWib(ms: number | null): string {
  if (!ms) return "—";
  try {
    return `${new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta",
    }).format(new Date(ms))} WIB`;
  } catch {
    return new Date(ms).toISOString();
  }
}

export function IncidentsPanel({
  initialIncidents,
  initialBannerIncidents,
  stepUpFresh,
}: IncidentsPanelProps) {
  const [incidents, setIncidents] =
    React.useState<readonly PlatformIncidentRecord[]>(initialIncidents);
  const [bannerIncidents, setBannerIncidents] =
    React.useState<readonly PublicIncidentBannerItem[]>(initialBannerIncidents);

  // Declare form state
  const [title, setTitle] = React.useState("");
  const [severity, setSeverity] = React.useState<IncidentSeverity>("major");
  const [selectedComponents, setSelectedComponents] = React.useState<
    readonly PlatformComponentId[]
  >(["dashboard_cms"]);
  const [summary, setSummary] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  // Action states
  const [submitting, setSubmitting] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);
  const [confirmResolveId, setConfirmResolveId] = React.useState<string | null>(null);
  const [resolveNote, setResolveNote] = React.useState("");
  const [resolvingId, setResolvingId] = React.useState<string | null>(null);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editStatus, setEditStatus] = React.useState<ActiveIncidentStatus>("identified");
  const [editMessage, setEditMessage] = React.useState("");
  const [updatingId, setUpdatingId] = React.useState<string | null>(null);

  const [errorBanner, setErrorBanner] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  const activeIncidents = React.useMemo(
    () => incidents.filter((item) => item.status !== "resolved"),
    [incidents],
  );
  const resolvedIncidents = React.useMemo(
    () => incidents.filter((item) => item.status === "resolved"),
    [incidents],
  );

  function toggleComponent(id: PlatformComponentId) {
    setSelectedComponents((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  async function reloadIncidents() {
    setReloading(true);
    setErrorBanner(null);
    try {
      const res = await fetch("/api/console/incidents", {
        method: "GET",
        credentials: "same-origin",
      });
      const data = (await res.json()) as {
        success?: boolean;
        incidents?: PlatformIncidentRecord[];
        activeBannerIncidents?: PublicIncidentBannerItem[];
        message?: string;
      };
      if (!res.ok || !data.success || !data.incidents) {
        setErrorBanner({
          code: "LOAD_FAILED",
          message: data.message ?? "Gagal memuat daftar insiden terbaru.",
        });
        return;
      }
      setIncidents(data.incidents);
      setBannerIncidents(data.activeBannerIncidents ?? []);
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat memuat ulang daftar insiden.",
      });
    } finally {
      setReloading(false);
    }
  }

  async function handleDeclare(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorBanner(null);
    setSuccessMessage(null);
    setFieldErrors({});

    const localErrors: Record<string, string> = {};
    if (title.trim().length < 5) {
      localErrors.title = "Judul insiden wajib diisi minimal 5 karakter.";
    }
    if (summary.trim().length < 10) {
      localErrors.summary = "Ringkasan publik wajib diisi minimal 10 karakter.";
    }
    if (selectedComponents.length === 0) {
      localErrors.affectedComponents = "Pilih minimal satu komponen terdampak.";
    }
    if (reason.trim().length > 0 && reason.trim().length < 10) {
      localErrors.reason = "Alasan audit minimal 10 karakter atau biarkan kosong untuk otomatis.";
    }

    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        title: title.trim(),
        severity,
        affectedComponents: selectedComponents,
        summary: summary.trim(),
        bannerVisible: true,
      };
      if (reason.trim().length > 0) {
        payload.reason = reason.trim();
      }

      const res = await fetch("/api/console/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as {
        success?: boolean;
        incident?: PlatformIncidentRecord;
        auditId?: string;
        code?: string;
        message?: string;
        verifyPath?: string;
        fields?: Array<{ field: string; message: string }>;
      };

      if (!res.ok || !data.success || !data.incident) {
        if (Array.isArray(data.fields) && data.fields.length > 0) {
          const nextErrors: Record<string, string> = {};
          for (const f of data.fields) {
            nextErrors[f.field] = f.message;
          }
          setFieldErrors(nextErrors);
        }
        setErrorBanner({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Gagal mendeklarasikan insiden platform.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      setTitle("");
      setSummary("");
      setReason("");
      setSeverity("major");
      setSelectedComponents(["dashboard_cms"]);
      setSuccessMessage(
        `Insiden "${data.incident.title}" berhasil dideklarasikan dan banner dashboard langsung aktif (audit: ${data.auditId ?? "tersimpan"}).`,
      );
      await reloadIncidents();
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat mendeklarasikan insiden. Isian formulir Anda tetap dipertahankan.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdateStatus(incident: PlatformIncidentRecord) {
    setErrorBanner(null);
    setSuccessMessage(null);
    if (editMessage.trim().length < 10) {
      setErrorBanner({
        code: "VALIDATION_ERROR",
        message: "Catatan pembaruan minimal 10 karakter.",
      });
      return;
    }

    setUpdatingId(incident.id);
    try {
      const res = await fetch(`/api/console/incidents/${encodeURIComponent(incident.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          expectedVersion: incident.version,
          status: editStatus,
          updateMessage: editMessage.trim(),
        }),
      });

      const data = (await res.json()) as {
        success?: boolean;
        auditId?: string;
        code?: string;
        message?: string;
        verifyPath?: string;
      };

      if (!res.ok || !data.success) {
        setErrorBanner({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Gagal memperbarui status insiden.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      setEditingId(null);
      setEditMessage("");
      setSuccessMessage(
        `Status insiden diperbarui ke "${STATUS_LABELS[editStatus]}" (audit: ${data.auditId ?? "tersimpan"}).`,
      );
      await reloadIncidents();
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat memperbarui status insiden.",
      });
    } finally {
      setUpdatingId(null);
    }
  }

  async function handleResolve(incident: PlatformIncidentRecord) {
    setErrorBanner(null);
    setSuccessMessage(null);
    setResolvingId(incident.id);
    try {
      const payload: Record<string, unknown> = {
        expectedVersion: incident.version,
      };
      if (resolveNote.trim().length > 0) {
        payload.resolutionNote = resolveNote.trim();
      }

      const res = await fetch(
        `/api/console/incidents/${encodeURIComponent(incident.id)}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload),
        },
      );

      const data = (await res.json()) as {
        success?: boolean;
        incident?: PlatformIncidentRecord;
        auditId?: string;
        code?: string;
        message?: string;
        verifyPath?: string;
      };

      if (!res.ok || !data.success || !data.incident) {
        setErrorBanner({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Gagal menyelesaikan insiden platform.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      setConfirmResolveId(null);
      setResolveNote("");
      setSuccessMessage(
        `Insiden "${data.incident.title}" ditandai selesai dan banner dashboard telah dihapus (audit: ${data.auditId ?? "tersimpan"}).`,
      );
      await reloadIncidents();
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat menyelesaikan insiden.",
      });
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div className="space-y-6" data-testid="console-incidents-panel">
      {!stepUpFresh ? (
        <Alert variant="warning" role="status" data-testid="stepup-warning-alert">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Verifikasi ulang 2FA diperlukan untuk aksi deklarasi/penyelesaian</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Tindakan deklarasi, pembaruan, dan penyelesaian insiden memerlukan verifikasi TOTP dalam 10 menit terakhir.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 bg-card text-foreground md:min-h-8"
              render={<a href="/auth/two-factor?mode=verify" />}
            >
              Verifikasi 2FA Sekarang
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {errorBanner ? (
        <Alert variant="destructive" role="alert" data-testid="incidents-error-banner">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>{errorBanner.code}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{errorBanner.message}</p>
            <div className="flex flex-wrap gap-2">
              {errorBanner.code === "VERSION_CONFLICT" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 bg-card text-foreground md:min-h-8"
                  onClick={reloadIncidents}
                  disabled={reloading}
                >
                  Muat ulang daftar insiden
                </Button>
              ) : null}
              {errorBanner.verifyPath ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-11 bg-card text-foreground md:min-h-8"
                  render={<a href={errorBanner.verifyPath} />}
                >
                  Verifikasi Ulang 2FA
                </Button>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {successMessage ? (
        <Alert variant="success" role="status" data-testid="incidents-success-banner">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Berhasil disimpan &amp; tercatat di audit log</AlertTitle>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      ) : null}

      {/* Live Dashboard Banner Preview Section */}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Status Banner Dashboard Tenant</CardTitle>
            <CardDescription>
              Pratinjau langsung banner yang sedang tampil di seluruh dashboard tenant saat ini.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant={bannerIncidents.length > 0 ? "warning" : "success"}
              data-testid="active-banner-count-badge"
            >
              {bannerIncidents.length > 0
                ? `${bannerIncidents.length} Banner Aktif`
                : "Tidak Ada Banner Aktif"}
            </Badge>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 md:min-h-8"
              onClick={reloadIncidents}
              disabled={reloading}
            >
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
              {reloading ? "Memuat..." : "Muat ulang"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {bannerIncidents.length > 0 ? (
            <DashboardIncidentBanner incidents={bannerIncidents} />
          ) : (
            <div
              data-testid="no-active-banner-state"
              className="rounded-md border border-dashed border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
            >
              Semua sistem beroperasi normal. Tidak ada banner insiden yang tampil di dashboard tenant.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Declare New Incident Form (One-Action Audited Flow) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SirenIcon className="size-4 text-destructive" aria-hidden="true" />
            Deklarasikan Insiden Platform
          </CardTitle>
          <CardDescription>
            Satu tindakan ini langsung mencatat insiden di <code className="font-mono">PLATFORM_DB</code>, mengaktifkan banner di dashboard tenant, dan menulis catatan <code className="font-mono">platform_audit</code> secara atomik.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleDeclare} noValidate data-testid="declare-incident-form">
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="space-y-1.5 md:col-span-2">
                <label
                  htmlFor="incident-title"
                  className="block text-sm font-medium text-foreground"
                >
                  Judul Insiden
                </label>
                <Input
                  id="incident-title"
                  name="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Contoh: Keterlambatan verifikasi pembayaran QRIS"
                  maxLength={140}
                  required
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                  aria-invalid={Boolean(fieldErrors.title)}
                />
                {fieldErrors.title ? (
                  <p className="text-xs text-destructive">{fieldErrors.title}</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="incident-severity"
                  className="block text-sm font-medium text-foreground"
                >
                  Tingkat Dampak
                </label>
                <select
                  id="incident-severity"
                  name="severity"
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as IncidentSeverity)}
                  className="min-h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 md:text-sm"
                >
                  {SEVERITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">
                Komponen Layanan Terdampak
              </legend>
              <div className="flex flex-wrap gap-2">
                {PLATFORM_INCIDENT_COMPONENTS.map((comp) => {
                  const checked = selectedComponents.includes(comp.id);
                  return (
                    <button
                      key={comp.id}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      data-testid={`component-toggle-${comp.id}`}
                      onClick={() => toggleComponent(comp.id)}
                      className={`inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors md:min-h-9 ${
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-card text-foreground hover:bg-muted"
                      }`}
                    >
                      <span>{checked ? "✓" : "+"}</span>
                      <span>{comp.label}</span>
                    </button>
                  );
                })}
              </div>
              {fieldErrors.affectedComponents ? (
                <p className="text-xs text-destructive">
                  {fieldErrors.affectedComponents}
                </p>
              ) : null}
            </fieldset>

            <div className="space-y-1.5">
              <label
                htmlFor="incident-summary"
                className="block text-sm font-medium text-foreground"
              >
                Ringkasan Publik untuk Banner Dashboard
              </label>
              <textarea
                id="incident-summary"
                name="summary"
                rows={3}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Jelaskan dampak layanan yang dialami pelanggan serta langkah pemulihan yang sedang dilakukan tanpa menyertakan detail internal atau data sensitif."
                maxLength={1000}
                required
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:text-sm"
                aria-invalid={Boolean(fieldErrors.summary)}
              />
              {fieldErrors.summary ? (
                <p className="text-xs text-destructive">{fieldErrors.summary}</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="incident-reason"
                className="block text-sm font-medium text-foreground"
              >
                Alasan Audit Operator <span className="font-normal text-muted-foreground">(opsional — otomatis dari ringkasan bila kosong)</span>
              </label>
              <Input
                id="incident-reason"
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Contoh: Tiket NOC #2026-1123 lonjakan latensi gateway pembayaran"
                maxLength={500}
                className="min-h-11 text-base md:min-h-9 md:text-sm"
                aria-invalid={Boolean(fieldErrors.reason)}
              />
              {fieldErrors.reason ? (
                <p className="text-xs text-destructive">{fieldErrors.reason}</p>
              ) : null}
            </div>
          </CardContent>
          <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Setelah dideklarasikan, perbarui juga <code className="font-mono">apps/status/public/status.json</code> untuk halaman status statis independen.
            </p>
            <Button
              type="submit"
              variant="destructive"
              disabled={submitting}
              data-testid="declare-incident-submit"
              className="min-h-11 md:min-h-9"
            >
              {submitting
                ? "Mendeklarasikan..."
                : "Deklarasikan Insiden & Aktifkan Banner"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      {/* Active Incidents Section */}
      <section aria-label="Daftar insiden aktif" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">
            Insiden Aktif ({activeIncidents.length})
          </h2>
        </div>

        {activeIncidents.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground" data-testid="active-incidents-empty">
              Tidak ada insiden aktif saat ini.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3" data-testid="active-incidents-list">
            {activeIncidents.map((incident) => {
              const isConfirming = confirmResolveId === incident.id;
              const isEditing = editingId === incident.id;
              return (
                <Card key={incident.id} data-testid={`incident-card-${incident.id}`}>
                  <CardHeader className="space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="space-y-1">
                        <CardTitle className="text-base">{incident.title}</CardTitle>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          ID: <code className="font-mono">{incident.id}</code> • v{incident.version} • Dideklarasikan: {formatWib(incident.declaredAt)}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={severityBadgeVariant(incident.severity)}>
                          {severityLabel(incident.severity)}
                        </Badge>
                        <Badge variant="outline">{STATUS_LABELS[incident.status]}</Badge>
                        {incident.bannerVisible ? (
                          <Badge variant="warning">Banner Aktif</Badge>
                        ) : null}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-foreground">{incident.summary}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {incident.affectedComponents.map((comp) => (
                        <Badge key={comp} variant="secondary">
                          {COMPONENT_LABEL_MAP[comp] ?? comp}
                        </Badge>
                      ))}
                    </div>

                    {incident.updates.length > 0 ? (
                      <div className="rounded-md border border-border bg-muted/30 p-3">
                        <p className="mb-2 text-xs font-semibold text-foreground">
                          Linimasa Pembaruan ({incident.updates.length})
                        </p>
                        <ul className="space-y-1.5 text-xs">
                          {incident.updates.map((u) => (
                            <li key={u.id} className="flex flex-wrap justify-between gap-2">
                              <span className="text-foreground">
                                <strong className="font-medium">[{STATUS_LABELS[u.status]}]</strong>{" "}
                                {u.message}
                              </span>
                              <span className="shrink-0 text-muted-foreground tabular-nums">
                                {formatWib(u.createdAt)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {isEditing ? (
                      <div className="space-y-3 rounded-md border border-border bg-card p-3">
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                          <div className="space-y-1">
                            <label
                              htmlFor={`edit-status-${incident.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Tahap Penanganan
                            </label>
                            <select
                              id={`edit-status-${incident.id}`}
                              value={editStatus}
                              onChange={(e) =>
                                setEditStatus(e.target.value as ActiveIncidentStatus)
                              }
                              className="min-h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground md:min-h-9 md:text-sm"
                            >
                              <option value="investigating">Sedang Diinvestigasi</option>
                              <option value="identified">Penyebab Teridentifikasi</option>
                              <option value="monitoring">Pemantauan Pemulihan</option>
                            </select>
                          </div>
                          <div className="space-y-1 md:col-span-2">
                            <label
                              htmlFor={`edit-msg-${incident.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Catatan Pembaruan
                            </label>
                            <Input
                              id={`edit-msg-${incident.id}`}
                              value={editMessage}
                              onChange={(e) => setEditMessage(e.target.value)}
                              placeholder="Akar masalah ditemukan dan perbaikan sedang diterapkan..."
                              className="min-h-11 text-base md:min-h-9 md:text-sm"
                            />
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            className="min-h-11 md:min-h-9"
                            disabled={updatingId === incident.id}
                            onClick={() => handleUpdateStatus(incident)}
                          >
                            {updatingId === incident.id ? "Menyimpan..." : "Simpan Pembaruan"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="min-h-11 md:min-h-9"
                            onClick={() => {
                              setEditingId(null);
                              setEditMessage("");
                            }}
                          >
                            Batal
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {isConfirming ? (
                      <div
                        data-testid={`resolve-confirm-box-${incident.id}`}
                        className="space-y-3 rounded-md border border-success-border bg-success-soft p-3"
                      >
                        <p className="text-sm font-medium text-success">
                          Konfirmasi penyelesaian insiden — banner akan segera dihapus dari seluruh dashboard tenant.
                        </p>
                        <div className="space-y-1">
                          <label
                            htmlFor={`resolve-note-${incident.id}`}
                            className="block text-xs font-medium text-foreground"
                          >
                            Catatan Penyelesaian (opsional)
                          </label>
                          <Input
                            id={`resolve-note-${incident.id}`}
                            value={resolveNote}
                            onChange={(e) => setResolveNote(e.target.value)}
                            placeholder="Insiden telah ditangani dan seluruh layanan kembali normal."
                            className="min-h-11 bg-card text-base md:min-h-9 md:text-sm"
                          />
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            data-testid={`confirm-resolve-btn-${incident.id}`}
                            className="min-h-11 md:min-h-9"
                            disabled={resolvingId === incident.id}
                            onClick={() => handleResolve(incident)}
                          >
                            {resolvingId === incident.id
                              ? "Menyelesaikan..."
                              : "Konfirmasi Selesaikan & Hapus Banner"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="min-h-11 bg-card md:min-h-9"
                            onClick={() => {
                              setConfirmResolveId(null);
                              setResolveNote("");
                            }}
                          >
                            Batal
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                  <CardFooter className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
                    {!isEditing && !isConfirming ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11 md:min-h-9"
                          onClick={() => {
                            setEditingId(incident.id);
                            setEditStatus(
                              incident.status === "investigating"
                                ? "identified"
                                : "monitoring",
                            );
                            setEditMessage("");
                          }}
                        >
                          Perbarui Status
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          data-testid={`resolve-incident-btn-${incident.id}`}
                          className="min-h-11 md:min-h-9"
                          onClick={() => {
                            setConfirmResolveId(incident.id);
                            setResolveNote("");
                          }}
                        >
                          Selesaikan Insiden
                        </Button>
                      </>
                    ) : null}
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Resolved Incidents History */}
      <section aria-label="Riwayat insiden selesai" className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">
          Riwayat Insiden Selesai ({resolvedIncidents.length})
        </h2>
        {resolvedIncidents.length === 0 ? (
          <Card>
            <CardContent className="py-5 text-sm text-muted-foreground" data-testid="resolved-incidents-empty">
              Belum ada riwayat insiden yang diselesaikan.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2.5" data-testid="resolved-incidents-list">
            {resolvedIncidents.map((incident) => (
              <Card key={incident.id}>
                <CardContent className="flex flex-wrap items-start justify-between gap-3 py-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-foreground">{incident.title}</p>
                      <Badge variant="success">Selesai</Badge>
                      <Badge variant={severityBadgeVariant(incident.severity)}>
                        {severityLabel(incident.severity)}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{incident.summary}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      Mulai: {formatWib(incident.declaredAt)} • Selesai: {formatWib(incident.resolvedAt)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

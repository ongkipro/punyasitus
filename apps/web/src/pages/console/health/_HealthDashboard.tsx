import * as React from "react";
import {
  ActivityIcon,
  AlertCircleIcon,
  CheckCircle2Icon,
  ClockIcon,
  HelpCircleIcon,
  RefreshCwIcon,
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

export type HealthStatusValue = "healthy" | "degraded" | "stale" | "unknown";

export interface HealthComponentItem {
  readonly id: string;
  readonly label: string;
  readonly status: HealthStatusValue;
  readonly summary: string;
  readonly lastReportedAt: string | null;
  readonly ageSeconds: number | null;
  readonly thresholdSeconds: number | null;
}

export interface HealthSnapshotData {
  readonly status: HealthStatusValue;
  readonly checkedAt: string;
  readonly components: readonly HealthComponentItem[];
  readonly metrics: {
    readonly failedJobsCount: number | null;
    readonly deadLetterJobsCount: number | null;
    readonly staleRunningJobsCount: number | null;
    readonly stuckDomainsCount: number | null;
    readonly failedDomainsCount: number | null;
    readonly lastBackupAt: string | null;
    readonly lastRestoreDrillAt: string | null;
  };
}

export interface HealthDashboardProps {
  readonly initialSnapshot: HealthSnapshotData;
}

function getStatusMeta(status: HealthStatusValue): {
  readonly label: string;
  readonly variant: "success" | "destructive" | "warning" | "secondary";
} {
  switch (status) {
    case "healthy":
      return { label: "Sehat (healthy)", variant: "success" };
    case "degraded":
      return { label: "Menurun (degraded)", variant: "destructive" };
    case "stale":
      return { label: "Usang (stale)", variant: "warning" };
    case "unknown":
      return { label: "Belum Terukur (unknown)", variant: "secondary" };
  }
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "Belum ada laporan";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: "Asia/Jakarta",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatAgeSeconds(age: number | null): string {
  if (age === null) return "Tidak diketahui";
  if (age < 60) return `${age} detik lalu`;
  if (age < 3600) return `${Math.floor(age / 60)} menit lalu`;
  if (age < 86_400) return `${Math.floor(age / 3600)} jam lalu`;
  return `${Math.floor(age / 86_400)} hari lalu`;
}

function formatMetricValue(val: number | null): string {
  return val === null ? "Belum terukur" : String(val);
}

export function HealthDashboard({ initialSnapshot }: HealthDashboardProps) {
  const [snapshot, setSnapshot] = React.useState<HealthSnapshotData>(initialSnapshot);
  const [refreshing, setRefreshing] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  async function handleRefresh() {
    setRefreshing(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/console/health", {
        method: "GET",
        credentials: "same-origin",
      });
      const data = (await res.json()) as HealthSnapshotData & {
        success?: boolean;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setErrorMessage(data.message ?? "Gagal memeriksa status kesehatan platform.");
        return;
      }
      setSnapshot({
        status: data.status,
        checkedAt: data.checkedAt,
        components: data.components,
        metrics: data.metrics,
      });
    } catch {
      setErrorMessage("Koneksi terputus saat memeriksa status kesehatan. Silakan coba lagi.");
    } finally {
      setRefreshing(false);
    }
  }

  const overallMeta = getStatusMeta(snapshot.status);
  const hasUnknownOrStale = snapshot.components.some(
    (c) => c.status === "unknown" || c.status === "stale",
  );

  return (
    <div className="space-y-5" data-testid="console-health-dashboard">
      {errorMessage && (
        <Alert variant="destructive" data-testid="health-error-alert" aria-live="assertive">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal memperbarui status kesehatan</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {/* Overall Status Card */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <ActivityIcon className="size-4 text-primary" aria-hidden="true" />
                <span>Ringkasan Kesiapan Operasional</span>
              </CardTitle>
              <CardDescription className="tabular-nums">
                Terakhir diperiksa: {formatTimestamp(snapshot.checkedAt)}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={overallMeta.variant}
                data-testid="health-overall-status-badge"
                data-health-status={snapshot.status}
              >
                {overallMeta.label}
              </Badge>
              <Button
                type="button"
                variant="outline"
                disabled={refreshing}
                onClick={handleRefresh}
                className="min-h-11 sm:w-auto md:min-h-9"
                data-testid="health-refresh-button"
              >
                <RefreshCwIcon className="size-4" aria-hidden="true" />
                {refreshing ? "Memeriksa..." : "Periksa Ulang Status"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {hasUnknownOrStale && (
            <Alert variant="warning" data-testid="health-honesty-notice">
              <HelpCircleIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Status Belum Terukur atau Usang tidak pernah dianggap Sehat</AlertTitle>
              <AlertDescription>
                Komponen tanpa heartbeat/bukti terbaru ditampilkan secara jujur sebagai{" "}
                <strong>Belum Terukur (unknown)</strong> atau <strong>Usang (stale)</strong> agar
                operator tidak menerima sinyal sehat palsu. Halaman ini murni hanya baca tanpa
                konsol SQL atau tombol restart/deploy.
              </AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Dead-Letter Jobs</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                {formatMetricValue(snapshot.metrics.deadLetterJobsCount)}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Jobs Gagal / Lease Usang</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                {snapshot.metrics.failedJobsCount === null ||
                snapshot.metrics.staleRunningJobsCount === null
                  ? "Belum terukur"
                  : `${snapshot.metrics.failedJobsCount} / ${snapshot.metrics.staleRunningJobsCount}`}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Domain Gagal / Tertahan</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                {snapshot.metrics.failedDomainsCount === null ||
                snapshot.metrics.stuckDomainsCount === null
                  ? "Belum terukur"
                  : `${snapshot.metrics.failedDomainsCount} / ${snapshot.metrics.stuckDomainsCount}`}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Cadangan Harian Terakhir</p>
              <p className="mt-1 text-sm font-medium tabular-nums text-foreground">
                {formatTimestamp(snapshot.metrics.lastBackupAt)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Component Cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="health-components-grid">
        {snapshot.components.map((comp) => {
          const meta = getStatusMeta(comp.status);
          return (
            <Card key={comp.id} data-testid={`health-component-${comp.id}`} data-status={comp.status}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <CardTitle className="text-sm font-semibold">{comp.label}</CardTitle>
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <p className="text-sm text-foreground">{comp.summary}</p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-2 text-muted-foreground tabular-nums">
                  <span className="inline-flex items-center gap-1">
                    {comp.status === "healthy" ? (
                      <CheckCircle2Icon className="size-3.5 text-success" aria-hidden="true" />
                    ) : (
                      <ClockIcon className="size-3.5" aria-hidden="true" />
                    )}
                    Laporan: {formatTimestamp(comp.lastReportedAt)}
                  </span>
                  <span>Usia: {formatAgeSeconds(comp.ageSeconds)}</span>
                  {comp.thresholdSeconds !== null && (
                    <span>Batas: {Math.round(comp.thresholdSeconds / 60)} menit</span>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

import {
  AlertOctagonIcon,
  AlertTriangleIcon,
  ExternalLinkIcon,
  InfoIcon,
} from "lucide-react";
import type {
  ActiveIncidentStatus,
  IncidentSeverity,
  PlatformComponentId,
  PublicIncidentBannerItem,
} from "@punyasitus/db/incidents/index";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface DashboardIncidentBannerProps {
  readonly incidents: readonly PublicIncidentBannerItem[];
}

const COMPONENT_LABELS: Readonly<Record<PlatformComponentId, string>> = {
  public_sites: "Situs Publik",
  dashboard_cms: "Dashboard & CMS",
  domains_ssl: "Domain & SSL",
  billing_payments: "Pembayaran & Perpanjangan",
  email_notifications: "Notifikasi Email",
};

const SEVERITY_META: Readonly<
  Record<
    IncidentSeverity,
    {
      readonly alertVariant: "info" | "warning" | "destructive";
      readonly badgeVariant: "info" | "warning" | "destructive";
      readonly label: string;
    }
  >
> = {
  minor: {
    alertVariant: "info",
    badgeVariant: "info",
    label: "Gangguan Minor",
  },
  major: {
    alertVariant: "warning",
    badgeVariant: "warning",
    label: "Gangguan Sebagian",
  },
  critical: {
    alertVariant: "destructive",
    badgeVariant: "destructive",
    label: "Gangguan Kritis",
  },
};

const STATUS_LABELS: Readonly<Record<ActiveIncidentStatus, string>> = {
  investigating: "Sedang Diinvestigasi",
  identified: "Penyebab Teridentifikasi",
  monitoring: "Pemantauan Pemulihan",
};

function formatWibTimestamp(ms: number): string {
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

function SeverityIcon({ severity }: { readonly severity: IncidentSeverity }) {
  if (severity === "critical") {
    return <AlertOctagonIcon className="size-4" aria-hidden="true" />;
  }
  if (severity === "major") {
    return <AlertTriangleIcon className="size-4" aria-hidden="true" />;
  }
  return <InfoIcon className="size-4" aria-hidden="true" />;
}

/**
 * Tenant dashboard platform incident banner (`REQ-106`, `DESIGN.md` §2.1 & §4.2).
 * Renders cleanly in Indonesian when at least one active incident is declared and
 * returns `null` (disappears completely) once all incidents are resolved.
 */
export function DashboardIncidentBanner({
  incidents,
}: DashboardIncidentBannerProps) {
  if (incidents.length === 0) return null;

  const primary = incidents[0]!;
  const additional = incidents.slice(1);
  const sev = SEVERITY_META[primary.severity];
  const statusLabel = STATUS_LABELS[primary.status];

  return (
    <section
      aria-label="Pengumuman gangguan layanan platform"
      data-testid="dashboard-incident-banner"
      data-incident-id={primary.id}
      data-incident-severity={primary.severity}
      className="mb-4"
    >
      <Alert
        variant={sev.alertVariant}
        role={primary.severity === "critical" ? "alert" : "status"}
      >
        <SeverityIcon severity={primary.severity} />
        <AlertTitle className="flex flex-wrap items-center gap-2">
          <span>{primary.title}</span>
          <Badge variant={sev.badgeVariant}>{sev.label}</Badge>
          <Badge variant="outline" className="bg-card text-foreground">
            {statusLabel}
          </Badge>
        </AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{primary.summary}</p>
          {primary.affectedComponents.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium">Komponen terdampak:</span>
              {primary.affectedComponents.map((comp) => (
                <span
                  key={comp}
                  className="inline-flex items-center rounded border border-current/25 bg-card/80 px-1.5 py-0.5 text-xs font-medium text-foreground"
                >
                  {COMPONENT_LABELS[comp] ?? comp}
                </span>
              ))}
            </div>
          ) : null}
          {additional.length > 0 ? (
            <p className="text-xs font-medium">
              +{additional.length} insiden aktif lainnya:{" "}
              {additional.map((item) => item.title).join(" • ")}
            </p>
          ) : null}
          <p className="text-xs opacity-85 tabular-nums">
            Diperbarui: {formatWibTimestamp(primary.updatedAt)}
          </p>
        </AlertDescription>
        <AlertAction>
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 bg-card text-foreground hover:bg-muted md:min-h-8"
            render={
              <a
                href={primary.statusPageUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="dashboard-incident-status-link"
              />
            }
          >
            Lihat Halaman Status
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </AlertAction>
      </Alert>
    </section>
  );
}

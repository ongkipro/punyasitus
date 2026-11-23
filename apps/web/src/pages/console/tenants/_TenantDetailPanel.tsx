import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  BanIcon,
  CheckCircle2Icon,
  GlobeIcon,
  PaletteIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserIcon,
  WrenchIcon,
  XIcon,
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
import type { ConsoleTenantGtmStatusDto } from "@punyasitus/db/analytics-settings/index";
import type {
  ConsoleAllowedStateAction,
  ConsoleTenantDetailDto,
} from "@punyasitus/db/platform";
import { TenantGtmKillSwitchCard } from "./_TenantGtmKillSwitchCard";

export interface RegisteredCustomThemeSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly basePlatformThemeId: string;
  readonly distribution: string;
}

export interface TenantDetailPanelProps {
  readonly initialDetail: ConsoleTenantDetailDto;
  readonly initialGtmStatus?: ConsoleTenantGtmStatusDto | null;
  readonly registeredCustomThemes: readonly RegisteredCustomThemeSummary[];
  readonly stepUpFresh: boolean;
}

const STATE_ACTION_LABELS: Readonly<
  Record<
    ConsoleAllowedStateAction,
    { readonly label: string; readonly consequence: string; readonly destructive: boolean }
  >
> = {
  suspend_hold: {
    label: "Tangguhkan Situs (Operator Hold)",
    consequence:
      "Situs publik akan langsung menampilkan HTTP 503 (no-store, noindex) dan dashboard menjadi terbatas hingga hold dilepas.",
    destructive: true,
  },
  release_hold: {
    label: "Lepas Penangguhan (Hitung Ulang Hak Layanan)",
    consequence:
      "Status layanan dihitung ulang berdasarkan masa langganan/uji coba saat ini tanpa memberikan waktu aktif gratis.",
    destructive: false,
  },
  enter_recovery: {
    label: "Masuk Mode Pemulihan (Recovery)",
    consequence:
      "Situs masuk status recovery untuk investigasi teknis terbatas; konten tenant tetap utuh dan tidak dapat diakses operator.",
    destructive: true,
  },
  exit_recovery: {
    label: "Keluar Mode Pemulihan",
    consequence:
      "Status layanan dihitung ulang dari hak langganan aktif sambil mempertahankan status hold jika sebelumnya aktif.",
    destructive: false,
  },
};

function createUuidKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `op-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function formatEpochId(ms: number | null): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Jakarta",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function statusBadgeProps(
  effectiveStatus: string,
  operatorHold: boolean,
): {
  readonly label: string;
  readonly variant: "default" | "secondary" | "outline" | "destructive" | "success" | "warning";
} {
  if (operatorHold) {
    return { label: "Ditangguhkan (Hold)", variant: "destructive" };
  }
  switch (effectiveStatus) {
    case "active":
      return { label: "Aktif", variant: "success" };
    case "trial":
      return { label: "Uji Coba", variant: "secondary" };
    case "grace":
      return { label: "Masa Tenggang", variant: "warning" };
    case "locked":
      return { label: "Terkunci", variant: "destructive" };
    case "suspended":
      return { label: "Ditangguhkan", variant: "destructive" };
    case "recovery":
      return { label: "Pemulihan", variant: "warning" };
    default:
      return { label: effectiveStatus, variant: "outline" };
  }
}

export function TenantDetailPanel({
  initialDetail,
  initialGtmStatus = null,
  registeredCustomThemes,
  stepUpFresh,
}: TenantDetailPanelProps) {
  const [detail, setDetail] = React.useState<ConsoleTenantDetailDto>(initialDetail);
  const [refreshing, setRefreshing] = React.useState(false);
  const [globalError, setGlobalError] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const [globalSuccess, setGlobalSuccess] = React.useState<string | null>(null);

  // State Transition Modal
  const [stateModalOpen, setStateModalOpen] = React.useState(false);
  const [selectedStateAction, setSelectedStateAction] =
    React.useState<ConsoleAllowedStateAction>(
      initialDetail.allowedStateActions[0] ?? "suspend_hold",
    );
  const [stateReason, setStateReason] = React.useState("");
  const [stateIdempKey, setStateIdempKey] = React.useState(() => createUuidKey());
  const [stateError, setStateError] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const [stateSubmitting, setStateSubmitting] = React.useState(false);

  // Theme Grant Modal
  const [grantModalOpen, setGrantModalOpen] = React.useState(false);
  const [grantThemeId, setGrantThemeId] = React.useState<string>(
    registeredCustomThemes[0]?.id ?? "",
  );
  const [grantReason, setGrantReason] = React.useState("");
  const [grantIdempKey, setGrantIdempKey] = React.useState(() => createUuidKey());
  const [grantError, setGrantError] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const [grantSubmitting, setGrantSubmitting] = React.useState(false);

  // Theme Revoke Modal
  const [revokeTargetTheme, setRevokeTargetTheme] = React.useState<{
    readonly themeId: string;
    readonly name: string;
  } | null>(null);
  const [revokeReason, setRevokeReason] = React.useState("");
  const [revokeIdempKey, setRevokeIdempKey] = React.useState(() => createUuidKey());
  const [revokeError, setRevokeError] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const [revokeSubmitting, setRevokeSubmitting] = React.useState(false);

  const { tenant, owner, domains, grantedThemes, activeThemeId, activeThemeVerificationStatus } =
    detail;
  const statusBadge = statusBadgeProps(tenant.effectiveStatus, tenant.operatorHold);
  const detailPath = `/console/tenants/${encodeURIComponent(tenant.handle)}`;

  const grantedThemeIdSet = React.useMemo(
    () => new Set(grantedThemes.map((g) => g.themeId)),
    [grantedThemes],
  );
  const grantableCustomThemes = React.useMemo(
    () => registeredCustomThemes.filter((t) => !grantedThemeIdSet.has(t.id)),
    [registeredCustomThemes, grantedThemeIdSet],
  );

  React.useEffect(() => {
    if (
      detail.allowedStateActions.length > 0 &&
      !detail.allowedStateActions.includes(selectedStateAction)
    ) {
      setSelectedStateAction(detail.allowedStateActions[0]!);
    }
  }, [detail.allowedStateActions, selectedStateAction]);

  React.useEffect(() => {
    if (
      grantableCustomThemes.length > 0 &&
      !grantableCustomThemes.some((t) => t.id === grantThemeId)
    ) {
      setGrantThemeId(grantableCustomThemes[0]!.id);
    }
  }, [grantableCustomThemes, grantThemeId]);

  async function refreshDetail(): Promise<boolean> {
    setRefreshing(true);
    setGlobalError(null);
    try {
      const res = await fetch(`/api/console/tenants/${encodeURIComponent(tenant.id)}`, {
        method: "GET",
        credentials: "same-origin",
      });
      const data = (await res.json()) as Partial<ConsoleTenantDetailDto> & {
        success?: boolean;
        code?: string;
        message?: string;
        verifyPath?: string;
      };
      if (!res.ok || !data.success || !data.tenant) {
        setGlobalError({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Gagal memuat ulang detail tenant.",
          verifyPath: data.verifyPath,
        });
        return false;
      }
      setDetail({
        tenant: data.tenant,
        owner: data.owner ?? detail.owner,
        domains: data.domains ?? detail.domains,
        grantedThemes: data.grantedThemes ?? detail.grantedThemes,
        activeThemeId: data.activeThemeId ?? null,
        activeThemeVerificationStatus: data.activeThemeVerificationStatus ?? "unavailable",
        allowedStateActions: data.allowedStateActions ?? [],
        recentAudit: data.recentAudit ?? [],
      });
      return true;
    } catch {
      setGlobalError({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat memuat ulang detail tenant. Coba lagi.",
      });
      return false;
    } finally {
      setRefreshing(false);
    }
  }

  async function handleStateSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setStateError(null);
    setGlobalSuccess(null);

    const trimmedReason = stateReason.trim();
    if (trimmedReason.length < 10) {
      setStateError({
        code: "VALIDATION_ERROR",
        message: "Alasan operasional audit wajib diisi minimal 10 karakter (maksimal 500 karakter).",
      });
      return;
    }

    setStateSubmitting(true);
    try {
      const res = await fetch(`/api/console/tenants/${encodeURIComponent(tenant.id)}/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": stateIdempKey,
        },
        credentials: "same-origin",
        body: JSON.stringify({
          action: selectedStateAction,
          reason: trimmedReason,
          expectedVersion: tenant.version,
          idempotencyKey: stateIdempKey,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        code?: string;
        message?: string;
        verifyPath?: string;
        replayed?: boolean;
        tenant?: { readonly effectiveStatus: string; readonly version: number };
      };

      if (!res.ok || !data.success || !data.tenant) {
        setStateError({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Transisi status layanan gagal diproses.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      setStateModalOpen(false);
      setStateReason("");
      setStateIdempKey(createUuidKey());
      setGlobalSuccess(
        `Status layanan "${tenant.handle}" berhasil diperbarui menjadi "${data.tenant.effectiveStatus}" (v${data.tenant.version}) dan dicatat pada audit log.`,
      );
      await refreshDetail();
    } catch {
      setStateError({
        code: "NETWORK_ERROR",
        message: "Gagal menghubungi server saat mengubah status layanan. Coba lagi.",
      });
    } finally {
      setStateSubmitting(false);
    }
  }

  async function handleGrantThemeSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setGrantError(null);
    setGlobalSuccess(null);

    const trimmedTheme = grantThemeId.trim();
    const trimmedReason = grantReason.trim();
    if (!trimmedTheme) {
      setGrantError({
        code: "VALIDATION_ERROR",
        message: "Pilih tema kustom terdaftar terlebih dahulu.",
      });
      return;
    }
    if (trimmedReason.length < 10) {
      setGrantError({
        code: "VALIDATION_ERROR",
        message: "Alasan pemberian izin tema wajib diisi minimal 10 karakter.",
      });
      return;
    }

    setGrantSubmitting(true);
    try {
      const res = await fetch(`/api/console/tenants/${encodeURIComponent(tenant.id)}/themes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": grantIdempKey,
        },
        credentials: "same-origin",
        body: JSON.stringify({
          themeId: trimmedTheme,
          action: "grant",
          reason: trimmedReason,
          expectedVersion: tenant.version,
          idempotencyKey: grantIdempKey,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        code?: string;
        message?: string;
        verifyPath?: string;
      };

      if (!res.ok || !data.success) {
        setGrantError({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Pemberian izin tema kustom gagal diproses.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      setGrantModalOpen(false);
      setGrantReason("");
      setGrantIdempKey(createUuidKey());
      setGlobalSuccess(
        `Izin tema kustom "${trimmedTheme}" berhasil diberikan kepada "${tenant.handle}" tanpa mengubah konten situs.`,
      );
      await refreshDetail();
    } catch {
      setGrantError({
        code: "NETWORK_ERROR",
        message: "Gagal menghubungi server saat memberikan izin tema. Coba lagi.",
      });
    } finally {
      setGrantSubmitting(false);
    }
  }

  async function handleRevokeThemeSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!revokeTargetTheme) return;

    setRevokeError(null);
    setGlobalSuccess(null);

    const trimmedReason = revokeReason.trim();
    if (trimmedReason.length < 10) {
      setRevokeError({
        code: "VALIDATION_ERROR",
        message: "Alasan pencabutan izin tema wajib diisi minimal 10 karakter.",
      });
      return;
    }

    setRevokeSubmitting(true);
    try {
      const res = await fetch(`/api/console/tenants/${encodeURIComponent(tenant.id)}/themes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": revokeIdempKey,
        },
        credentials: "same-origin",
        body: JSON.stringify({
          themeId: revokeTargetTheme.themeId,
          action: "revoke",
          reason: trimmedReason,
          expectedVersion: tenant.version,
          idempotencyKey: revokeIdempKey,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        code?: string;
        message?: string;
        verifyPath?: string;
      };

      if (!res.ok || !data.success) {
        setRevokeError({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Pencabutan izin tema kustom gagal diproses.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      const revokedId = revokeTargetTheme.themeId;
      setRevokeTargetTheme(null);
      setRevokeReason("");
      setRevokeIdempKey(createUuidKey());
      setGlobalSuccess(
        `Izin tema kustom "${revokedId}" berhasil dicabut dari "${tenant.handle}" dan dicatat pada audit log.`,
      );
      await refreshDetail();
    } catch {
      setRevokeError({
        code: "NETWORK_ERROR",
        message: "Gagal menghubungi server saat mencabut izin tema. Coba lagi.",
      });
    } finally {
      setRevokeSubmitting(false);
    }
  }

  const currentActionMeta = STATE_ACTION_LABELS[selectedStateAction];

  return (
    <div className="space-y-5" data-testid="console-tenant-detail-panel">
      {/* Breadcrumb & Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <a
            href="/console/tenants"
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-0"
            data-testid="back-to-tenants-link"
          >
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            Kembali ke Direktori Tenant
          </a>

          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {tenant.name}
            </h1>
            <Badge variant={statusBadge.variant} data-testid="detail-status-badge">
              {statusBadge.label}
            </Badge>
            <Badge variant="outline" className="font-mono tabular-nums" data-testid="detail-version-badge">
              v{tenant.version}
            </Badge>
          </div>

          <p className="text-sm text-muted-foreground">
            Handle <code className="font-mono text-foreground">@{tenant.handle}</code> · Host{" "}
            <code className="font-mono text-foreground">{tenant.primaryHost}</code> · Tanpa
            impersonasi &amp; tanpa akses konten/PII pelanggan.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            type="button"
            variant="outline"
            disabled={refreshing}
            onClick={() => void refreshDetail()}
            className="min-h-11 w-full sm:w-auto md:min-h-9"
            data-testid="detail-refresh-btn"
          >
            <RefreshCwIcon className="size-4" aria-hidden="true" />
            {refreshing ? "Memuat..." : "Muat Ulang"}
          </Button>
          <Button
            type="button"
            variant={tenant.operatorHold ? "default" : "destructive"}
            disabled={detail.allowedStateActions.length === 0}
            onClick={() => {
              setStateError(null);
              setStateIdempKey(createUuidKey());
              setStateModalOpen(true);
            }}
            className="min-h-11 w-full sm:w-auto md:min-h-9"
            data-testid="open-state-modal-btn"
          >
            <WrenchIcon className="size-4" aria-hidden="true" />
            Ubah Status Layanan
          </Button>
        </div>
      </div>

      {!stepUpFresh && (
        <Alert variant="warning" data-testid="detail-reauth-warning">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Verifikasi ulang 2FA diperlukan untuk tindakan perubahan</AlertTitle>
          <AlertDescription>
            Transisi status layanan dan pengelolaan izin tema memerlukan verifikasi 2FA dalam 10
            menit terakhir.{" "}
            <a
              href={`/auth/two-factor?mode=verify&next=${encodeURIComponent(detailPath)}`}
              className="inline-flex min-h-11 items-center font-medium underline underline-offset-4 md:min-h-0"
            >
              Verifikasi ulang 2FA sekarang
            </a>
            .
          </AlertDescription>
        </Alert>
      )}

      {globalError && (
        <Alert variant="destructive" data-testid="detail-error-alert" aria-live="assertive">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Permintaan gagal ({globalError.code})</AlertTitle>
          <AlertDescription>
            <span>{globalError.message}</span>
            {globalError.verifyPath && (
              <>
                {" "}
                <a
                  href={`${globalError.verifyPath}&next=${encodeURIComponent(detailPath)}`}
                  className="font-medium underline underline-offset-4"
                >
                  Buka verifikasi 2FA
                </a>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {globalSuccess && (
        <Alert variant="success" role="status" data-testid="detail-success-alert">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Operasi tenant tersimpan</AlertTitle>
          <AlertDescription>{globalSuccess}</AlertDescription>
        </Alert>
      )}

      {/* Row 1: Identity & Service State + Owner Summary */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <Card className="lg:col-span-7" data-testid="detail-identity-card">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheckIcon className="size-4 text-primary" aria-hidden="true" />
              Identitas &amp; Status Layanan Control Plane
            </CardTitle>
            <CardDescription>
              Ringkasan status dari <code className="font-mono">PLATFORM_DB.tenants</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Tenant ID</dt>
                <dd className="break-all font-mono text-xs text-foreground">{tenant.id}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Organization ID</dt>
                <dd className="break-all font-mono text-xs text-foreground">
                  {tenant.organizationId}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Status Tersimpan / Efektif</dt>
                <dd className="font-mono text-xs text-foreground">
                  {tenant.status} / {tenant.effectiveStatus}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Vertikal</dt>
                <dd className="font-mono text-xs text-foreground">{tenant.vertical}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Batas Uji Coba / Berbayar Hingga</dt>
                <dd className="text-xs text-foreground tabular-nums">
                  {tenant.paidThrough
                    ? `Aktif s.d. ${formatEpochId(tenant.paidThrough)}`
                    : tenant.trialEndsAt
                      ? `Uji coba s.d. ${formatEpochId(tenant.trialEndsAt)}`
                      : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Versi / Cache / Skema</dt>
                <dd className="font-mono text-xs text-foreground tabular-nums">
                  v{tenant.version} · cache v{tenant.cacheVersion} · skema v{tenant.schemaVersion}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Dibuat</dt>
                <dd className="text-xs text-foreground tabular-nums">
                  {formatEpochId(tenant.createdAt)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Terakhir Diperbarui</dt>
                <dd className="text-xs text-foreground tabular-nums">
                  {formatEpochId(tenant.updatedAt)}
                </dd>
              </div>
            </dl>

            {tenant.operatorHold && (
              <Alert variant="destructive" className="mt-4" data-testid="detail-hold-reason-alert">
                <BanIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Penangguhan Operator (Operator Hold) Aktif</AlertTitle>
                <AlertDescription>
                  Alasan hold: {tenant.operatorHoldReason ?? "Dicatat pada audit log platform."}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-5" data-testid="detail-owner-card">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <UserIcon className="size-4 text-primary" aria-hidden="true" />
              Ringkasan Pemilik &amp; Keanggotaan
            </CardTitle>
            <CardDescription>
              Akses operator terpisah dari peran anggota tenant. Penyamaran akun dinonaktifkan.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-4 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Status Pemilik</span>
              <Badge
                variant={
                  owner.status === "active_member"
                    ? "success"
                    : owner.status === "pending_invitation"
                      ? "warning"
                      : "outline"
                }
              >
                {owner.status === "active_member"
                  ? "Pemilik Aktif"
                  : owner.status === "pending_invitation"
                    ? "Undangan Tertunda"
                    : "Belum Ditentukan"}
              </Badge>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Email Pemilik</p>
              <p className="break-all font-mono text-xs text-foreground">
                {owner.email ?? "Belum ada"}
              </p>
            </div>
            {owner.displayName && (
              <div>
                <p className="text-xs text-muted-foreground">Nama Akun</p>
                <p className="text-xs font-medium text-foreground">{owner.displayName}</p>
              </div>
            )}
            {owner.pendingInvitationExpiresAt && (
              <div>
                <p className="text-xs text-muted-foreground">Kedaluwarsa Undangan Pemilik</p>
                <p className="text-xs text-foreground tabular-nums">
                  {formatEpochId(owner.pendingInvitationExpiresAt)}
                </p>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-border pt-3 text-xs">
              <span className="text-muted-foreground">Total Anggota Organisasi</span>
              <span className="font-semibold tabular-nums text-foreground">
                {owner.totalMembersCount} / 5
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Domains & Theme Grants */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <Card className="lg:col-span-5" data-testid="detail-domains-card">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <GlobeIcon className="size-4 text-primary" aria-hidden="true" />
              Domain &amp; Hostname Terdaftar
            </CardTitle>
            <CardDescription>
              Daftar host dari <code className="font-mono">tenant_hosts</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            {domains.length === 0 ? (
              <p className="text-sm text-muted-foreground">Belum ada host terdaftar.</p>
            ) : (
              <ul className="divide-y divide-border">
                {domains.map((dom) => (
                  <li key={dom.host} className="space-y-1 py-2.5 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="break-all font-mono text-xs font-semibold text-foreground">
                        {dom.host}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {dom.isPrimary && <Badge variant="default">Primer</Badge>}
                        <Badge variant={dom.status === "active" ? "success" : "outline"}>
                          {dom.status}
                        </Badge>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Jenis: {dom.kind === "subdomain" ? "Subdomain platform" : "Domain kustom"} ·
                      SSL: {dom.sslStatus}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-7" data-testid="detail-themes-card">
          <CardHeader className="border-b border-border pb-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <PaletteIcon className="size-4 text-primary" aria-hidden="true" />
                  Izin Tema Kustom (Theme Grants)
                </CardTitle>
                <CardDescription>
                  Hanya tema kustom terdaftar pada build-time registry. Tema yang sedang aktif tidak
                  dapat dicabut.
                </CardDescription>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setGrantError(null);
                  setGrantIdempKey(createUuidKey());
                  setGrantModalOpen(true);
                }}
                disabled={grantableCustomThemes.length === 0}
                className="min-h-11 w-full sm:w-auto md:min-h-8"
                data-testid="open-theme-grant-modal-btn"
              >
                <PlusIcon className="size-3.5" aria-hidden="true" />
                Berikan Izin Tema
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
              data-testid="detail-active-theme-bar"
            >
              <span className="text-muted-foreground">Tema Aktif Saat Ini (TenantStore):</span>
              <span className="font-mono font-semibold text-foreground">
                {activeThemeVerificationStatus === "verified" && activeThemeId
                  ? activeThemeId
                  : activeThemeVerificationStatus === "uninitialized"
                    ? `${tenant.vertical} (belum diinisialisasi)`
                    : "Tidak dapat diverifikasi (pencabutan diblokir fail-closed)"}
              </span>
            </div>

            {grantedThemes.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="detail-themes-empty">
                Belum ada izin tema kustom untuk tenant ini. 6 tema bawaan platform selalu tersedia
                otomatis.
              </p>
            ) : (
              <ul className="divide-y divide-border" data-testid="detail-granted-themes-list">
                {grantedThemes.map((grant) => {
                  const isCurrentlyActive =
                    activeThemeVerificationStatus === "verified" &&
                    activeThemeId === grant.themeId;
                  return (
                    <li
                      key={grant.id}
                      className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                      data-testid={`granted-theme-item-${grant.themeId}`}
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-foreground">{grant.name}</span>
                          <Badge variant="outline" className="font-mono text-xs">
                            {grant.themeId}
                          </Badge>
                          {isCurrentlyActive && (
                            <Badge variant="warning" data-testid={`active-theme-badge-${grant.themeId}`}>
                              Sedang Aktif
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          Diberikan: {formatEpochId(grant.grantedAt)}
                        </p>
                      </div>

                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          setRevokeError(null);
                          setRevokeReason("");
                          setRevokeIdempKey(createUuidKey());
                          setRevokeTargetTheme({
                            themeId: grant.themeId,
                            name: grant.name,
                          });
                        }}
                        className="min-h-11 w-full sm:w-auto md:min-h-8"
                        data-testid={`open-theme-revoke-btn-${grant.themeId}`}
                      >
                        <Trash2Icon className="size-3.5" aria-hidden="true" />
                        Cabut Izin
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 2b: Operator Google Tag Manager Kill Switch (REQ-027, TASK-076) */}
      <TenantGtmKillSwitchCard
        tenantId={tenant.id}
        tenantHandle={tenant.handle}
        tenantName={tenant.name}
        tenantVersion={tenant.version}
        detailPath={detailPath}
        initialGtmStatus={initialGtmStatus}
        onMutated={async (message) => {
          setGlobalSuccess(message);
          await refreshDetail();
        }}
      />

      {/* Row 3: Recent Scoped Redacted Audit History */}
      <Card data-testid="detail-audit-history-card">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base">
            Riwayat Operasi Tenant (Audit Log Tersensor — Hanya Baca)
          </CardTitle>
          <CardDescription>
            Catatan append-only dari <code className="font-mono">platform_audit</code> khusus untuk{" "}
            <code className="font-mono">{tenant.id}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {detail.recentAudit.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">
              Belum ada catatan audit untuk tenant ini.
            </p>
          ) : (
            <>
              <div className="hidden md:block">
                <Table data-testid="detail-audit-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Waktu</TableHead>
                      <TableHead>Aksi</TableHead>
                      <TableHead>Alasan Tersensor</TableHead>
                      <TableHead>Hasil</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.recentAudit.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                          {formatEpochId(entry.createdAt)}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-foreground">
                          {entry.action}
                        </TableCell>
                        <TableCell className="max-w-md break-words text-xs text-muted-foreground">
                          {entry.reason ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              entry.outcome === "success"
                                ? "success"
                                : entry.outcome === "denied"
                                  ? "warning"
                                  : "destructive"
                            }
                          >
                            {entry.outcome}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <ul className="divide-y divide-border md:hidden">
                {detail.recentAudit.map((entry) => (
                  <li key={entry.id} className="space-y-1 px-4 py-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-foreground">{entry.action}</span>
                      <Badge
                        variant={
                          entry.outcome === "success"
                            ? "success"
                            : entry.outcome === "denied"
                              ? "warning"
                              : "destructive"
                        }
                      >
                        {entry.outcome}
                      </Badge>
                    </div>
                    <p className="break-words text-muted-foreground">{entry.reason ?? "—"}</p>
                    <p className="text-muted-foreground tabular-nums">
                      {formatEpochId(entry.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {/* Modal 1: Service-State Transition */}
      <Dialog.Root open={stateModalOpen} onOpenChange={setStateModalOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[55] bg-foreground/40 transition-opacity duration-150" />
          <Dialog.Popup
            data-testid="state-transition-modal"
            className="fixed top-1/2 left-1/2 z-[60] max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 text-foreground shadow-lg outline-none"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
              <div className="space-y-1">
                <Dialog.Title className="text-lg font-semibold">
                  Transisi Status Layanan Tenant
                </Dialog.Title>
                <Dialog.Description className="text-xs text-muted-foreground">
                  Tenant: <strong className="text-foreground">{tenant.name}</strong> (@
                  {tenant.handle}) · Versi saat ini: <span className="font-mono">v{tenant.version}</span>
                </Dialog.Description>
              </div>
              <Dialog.Close
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="min-h-11 min-w-11 shrink-0 md:min-h-8 md:min-w-8"
                    aria-label="Tutup modal transisi status"
                    data-testid="state-modal-close-btn"
                  />
                }
              >
                <XIcon className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>

            <form
              onSubmit={handleStateSubmit}
              noValidate
              className="mt-4 space-y-4"
              data-testid="state-transition-form"
            >
              {stateError && (
                <Alert variant="destructive" data-testid="state-modal-error" aria-live="assertive">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Transisi ditolak ({stateError.code})</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p>{stateError.message}</p>
                    {stateError.code === "STALE_VERSION" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          await refreshDetail();
                          setStateError(null);
                          setStateIdempKey(createUuidKey());
                        }}
                        className="min-h-11 md:min-h-8"
                        data-testid="state-stale-reload-btn"
                      >
                        <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                        Muat Ulang Data Terbaru
                      </Button>
                    )}
                    {stateError.verifyPath && (
                      <a
                        href={`${stateError.verifyPath}&next=${encodeURIComponent(detailPath)}`}
                        className="inline-block font-medium underline underline-offset-4"
                      >
                        Verifikasi ulang 2FA sekarang
                      </a>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-1.5">
                <label htmlFor="state-modal-action" className="block text-sm font-medium">
                  Tindakan Status yang Diizinkan
                </label>
                <select
                  id="state-modal-action"
                  value={selectedStateAction}
                  onChange={(e) =>
                    setSelectedStateAction(e.target.value as ConsoleAllowedStateAction)
                  }
                  disabled={stateSubmitting}
                  className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                  data-testid="state-modal-action-select"
                >
                  {detail.allowedStateActions.map((act) => (
                    <option key={act} value={act}>
                      {STATE_ACTION_LABELS[act].label}
                    </option>
                  ))}
                </select>
                {currentActionMeta && (
                  <p className="text-xs text-muted-foreground">{currentActionMeta.consequence}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="state-modal-reason" className="block text-sm font-medium">
                  Alasan Operasional Audit (10–500 karakter)
                </label>
                <Input
                  id="state-modal-reason"
                  type="text"
                  value={stateReason}
                  onChange={(e) => setStateReason(e.target.value)}
                  placeholder="Contoh: Penangguhan sementara menunggu verifikasi laporan penyalahgunaan"
                  disabled={stateSubmitting}
                  required
                  data-testid="state-modal-reason-input"
                />
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-border pt-3 sm:flex-row sm:justify-end">
                <Dialog.Close
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      disabled={stateSubmitting}
                      className="min-h-11 w-full sm:w-auto md:min-h-9"
                    />
                  }
                >
                  Batal
                </Dialog.Close>
                <Button
                  type="submit"
                  variant={currentActionMeta?.destructive ? "destructive" : "default"}
                  disabled={stateSubmitting}
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                  data-testid="state-modal-submit-btn"
                >
                  {stateSubmitting ? "Menyimpan perubahan..." : "Konfirmasi Perubahan Status"}
                </Button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Modal 2: Grant Registered Custom Theme */}
      <Dialog.Root open={grantModalOpen} onOpenChange={setGrantModalOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[55] bg-foreground/40 transition-opacity duration-150" />
          <Dialog.Popup
            data-testid="theme-grant-modal"
            className="fixed top-1/2 left-1/2 z-[60] max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 text-foreground shadow-lg outline-none"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
              <div className="space-y-1">
                <Dialog.Title className="text-lg font-semibold">
                  Berikan Izin Tema Kustom
                </Dialog.Title>
                <Dialog.Description className="text-xs text-muted-foreground">
                  Hanya tema kustom terdaftar pada registry build-time yang diizinkan. Konten tenant
                  tetap utuh.
                </Dialog.Description>
              </div>
              <Dialog.Close
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="min-h-11 min-w-11 shrink-0 md:min-h-8 md:min-w-8"
                    aria-label="Tutup modal izin tema"
                  />
                }
              >
                <XIcon className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>

            <form
              onSubmit={handleGrantThemeSubmit}
              noValidate
              className="mt-4 space-y-4"
              data-testid="theme-grant-form"
            >
              {grantError && (
                <Alert variant="destructive" data-testid="theme-grant-modal-error" aria-live="assertive">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Pemberian izin ditolak ({grantError.code})</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p>{grantError.message}</p>
                    {grantError.code === "STALE_VERSION" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          await refreshDetail();
                          setGrantError(null);
                          setGrantIdempKey(createUuidKey());
                        }}
                        className="min-h-11 md:min-h-8"
                      >
                        Muat Ulang Data Terbaru
                      </Button>
                    )}
                    {grantError.verifyPath && (
                      <a
                        href={`${grantError.verifyPath}&next=${encodeURIComponent(detailPath)}`}
                        className="inline-block font-medium underline underline-offset-4"
                      >
                        Verifikasi ulang 2FA sekarang
                      </a>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-1.5">
                <label htmlFor="theme-grant-select" className="block text-sm font-medium">
                  Tema Kustom Terdaftar
                </label>
                <select
                  id="theme-grant-select"
                  value={grantThemeId}
                  onChange={(e) => setGrantThemeId(e.target.value)}
                  disabled={grantSubmitting}
                  className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                  data-testid="theme-grant-select"
                >
                  {grantableCustomThemes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.id})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="theme-grant-reason" className="block text-sm font-medium">
                  Alasan Operasional Audit (10–500 karakter)
                </label>
                <Input
                  id="theme-grant-reason"
                  type="text"
                  value={grantReason}
                  onChange={(e) => setGrantReason(e.target.value)}
                  placeholder="Contoh: Aktivasi hak tema kustom klien sesuai paket selesai #THM-09"
                  disabled={grantSubmitting}
                  required
                  data-testid="theme-grant-reason-input"
                />
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-border pt-3 sm:flex-row sm:justify-end">
                <Dialog.Close
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      disabled={grantSubmitting}
                      className="min-h-11 w-full sm:w-auto md:min-h-9"
                    />
                  }
                >
                  Batal
                </Dialog.Close>
                <Button
                  type="submit"
                  disabled={grantSubmitting}
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                  data-testid="theme-grant-submit-btn"
                >
                  {grantSubmitting ? "Memberikan izin..." : "Berikan Izin Tema"}
                </Button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Modal 3: Revoke Custom Theme Grant */}
      <Dialog.Root
        open={revokeTargetTheme !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTargetTheme(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[55] bg-foreground/40 transition-opacity duration-150" />
          <Dialog.Popup
            data-testid="theme-revoke-modal"
            className="fixed top-1/2 left-1/2 z-[60] max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 text-foreground shadow-lg outline-none"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
              <div className="space-y-1">
                <Dialog.Title className="text-lg font-semibold">
                  Cabut Izin Tema Kustom
                </Dialog.Title>
                <Dialog.Description className="text-xs text-muted-foreground">
                  Tema: <strong className="text-foreground">{revokeTargetTheme?.name}</strong> (
                  <code className="font-mono">{revokeTargetTheme?.themeId}</code>). Konten tenant
                  tidak dihapus.
                </Dialog.Description>
              </div>
              <Dialog.Close
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="min-h-11 min-w-11 shrink-0 md:min-h-8 md:min-w-8"
                    aria-label="Tutup modal pencabutan tema"
                  />
                }
              >
                <XIcon className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>

            <form
              onSubmit={handleRevokeThemeSubmit}
              noValidate
              className="mt-4 space-y-4"
              data-testid="theme-revoke-form"
            >
              {revokeTargetTheme &&
                activeThemeVerificationStatus === "verified" &&
                activeThemeId === revokeTargetTheme.themeId && (
                  <Alert variant="warning" data-testid="theme-revoke-active-warning">
                    <ShieldAlertIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>Tema sedang aktif di situs tenant</AlertTitle>
                    <AlertDescription>
                      Tema ini sedang aktif digunakan. Pencabutan akan ditolak oleh server (HTTP 409)
                      sampai tema bawaan yang kompatibel diaktifkan terlebih dahulu.
                    </AlertDescription>
                  </Alert>
                )}

              {revokeError && (
                <Alert variant="destructive" data-testid="theme-revoke-modal-error" aria-live="assertive">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Pencabutan ditolak ({revokeError.code})</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p>{revokeError.message}</p>
                    {revokeError.code === "STALE_VERSION" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          await refreshDetail();
                          setRevokeError(null);
                          setRevokeIdempKey(createUuidKey());
                        }}
                        className="min-h-11 md:min-h-8"
                      >
                        Muat Ulang Data Terbaru
                      </Button>
                    )}
                    {revokeError.verifyPath && (
                      <a
                        href={`${revokeError.verifyPath}&next=${encodeURIComponent(detailPath)}`}
                        className="inline-block font-medium underline underline-offset-4"
                      >
                        Verifikasi ulang 2FA sekarang
                      </a>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-1.5">
                <label htmlFor="theme-revoke-reason" className="block text-sm font-medium">
                  Alasan Pencabutan Izin (10–500 karakter)
                </label>
                <Input
                  id="theme-revoke-reason"
                  type="text"
                  value={revokeReason}
                  onChange={(e) => setRevokeReason(e.target.value)}
                  placeholder="Contoh: Kontrak penggunaan tema kustom agensi telah berakhir"
                  disabled={revokeSubmitting}
                  required
                  data-testid="theme-revoke-reason-input"
                />
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-border pt-3 sm:flex-row sm:justify-end">
                <Dialog.Close
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      disabled={revokeSubmitting}
                      className="min-h-11 w-full sm:w-auto md:min-h-9"
                    />
                  }
                >
                  Batal
                </Dialog.Close>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={revokeSubmitting}
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                  data-testid="theme-revoke-submit-btn"
                >
                  {revokeSubmitting ? "Mencabut izin..." : "Konfirmasi Cabut Izin"}
                </Button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

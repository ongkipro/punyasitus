import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  ArrowRightLeftIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  CheckIcon,
  ClockIcon,
  CloudIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  InfoIcon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  areDomainCounterparts,
  evaluateTenantDomainSetCapabilities,
  validateCustomHostname,
  type DomainConnectMode,
  type DomainRemedy,
  type DomainValidationInstructionRecord,
} from "@punyasitus/core/domains/index";
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
import type {
  DomainsManagerProps,
  IndependentDomainCheckStatus,
  TenantDomainItemDto,
} from "./_types";

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly reasonCode?: string;
    readonly message?: string;
  };
  readonly suggestedWwwHostname?: string | null;
  readonly failedGates?: ReadonlyArray<{
    readonly gate: string;
    readonly code: string;
    readonly messageId: string;
  }>;
  readonly reconciliationPending?: boolean;
  readonly domain?: TenantDomainItemDto;
}

interface ActionBanner {
  readonly kind: "success" | "error" | "warning" | "info";
  readonly title: string;
  readonly message: string;
  readonly staleConflict?: boolean;
  readonly suggestedWwwHostname?: string | null;
}

const MODE_CARDS: ReadonlyArray<{
  readonly id: DomainConnectMode;
  readonly badge: string;
  readonly title: string;
  readonly subtitle: string;
  readonly summary: string;
  readonly downtimeNote: string;
}> = [
  {
    id: "new_domain",
    badge: "Standar CNAME / Subdomain",
    title: "Domain Baru (belum ada situs live)",
    subtitle: "Cocok untuk www.bisnisanda.id, toko.bisnisanda.id, atau domain baru.",
    summary:
      "Arahkan 1 record CNAME langsung ke target PunyaSitus. Untuk domain root/apex tanpa www, pastikan penyedia DNS mendukung CNAME flattening/ALIAS/ANAME.",
    downtimeNote:
      "Jeda singkat penerbitan sertifikat SSL otomatis setelah CNAME tersimpan adalah wajar karena belum ada situs live.",
  },
  {
    id: "zero_downtime_migration",
    badge: "2 Langkah Nol Downtime",
    title: "Pindahan Tanpa Downtime (situs lama sedang live)",
    subtitle: "Situs lama (mis. WordPress) tetap berjalan sampai kepemilikan & SSL aktif.",
    summary:
      "Langkah 1: Tambahkan TXT kepemilikan & record DCV SSL dulu (tanpa ubah CNAME trafik). Langkah 2: CNAME routing baru dibuka otomatis setelah kepemilikan DAN sertifikat SSL keduanya aktif.",
    downtimeNote:
      "Nol downtime. Jika perlu rollback, cukup kembalikan record CNAME ke server lama tanpa menyentuh origin lama.",
  },
  {
    id: "cloudflare_o2o",
    badge: "Cloudflare O2O",
    title: "Domain Sudah di Cloudflare",
    subtitle: "Nameserver domain sudah menggunakan Cloudflare (ns.cloudflare.com).",
    summary:
      "PunyaSitus mendaftarkan custom hostname terlebih dahulu (mencegah Error 1014), lalu Anda menambahkan CNAME proxied (awan oranye) dengan mode SSL/TLS Full atau Full (strict).",
    downtimeNote:
      "Pre-validasi TXT tidak didukung Cloudflare pada mode O2O; aktivasi langsung mengarahkan trafik dengan jeda singkat.",
  },
];

function formatWib(iso: string | null): string {
  if (!iso) return "Belum diperiksa";
  try {
    return `${new Date(iso).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      dateStyle: "medium",
      timeStyle: "short",
    })} WIB`;
  } catch {
    return iso;
  }
}

function modeLabel(mode: DomainConnectMode | null): string {
  switch (mode) {
    case "zero_downtime_migration":
      return "Pindahan Nol Downtime";
    case "cloudflare_o2o":
      return "Cloudflare O2O";
    case "new_domain":
      return "Domain Baru";
    default:
      return "Subdomain Platform";
  }
}

function purposeLabel(purpose: DomainValidationInstructionRecord["purpose"]): string {
  switch (purpose) {
    case "ownership":
      return "Verifikasi Kepemilikan";
    case "ssl_dcv":
      return "Validasi Sertifikat SSL (DCV)";
    case "routing":
      return "Routing Trafik Website";
  }
}

function recordStatusBadge(status: DomainValidationInstructionRecord["status"]): {
  readonly label: string;
  readonly variant: "success" | "warning" | "destructive" | "secondary";
} {
  switch (status) {
    case "verified":
      return { label: "Terverifikasi", variant: "success" };
    case "conflict":
      return { label: "Bentrok", variant: "destructive" };
    case "expired":
      return { label: "Kedaluwarsa", variant: "destructive" };
    default:
      return { label: "Menunggu", variant: "warning" };
  }
}

function independentStatusUi(
  status: IndependentDomainCheckStatus,
  kind: "ownership" | "tls",
): {
  readonly label: string;
  readonly variant: "success" | "warning" | "destructive";
} {
  if (status === "active") {
    return {
      label: kind === "ownership" ? "Aktif" : "Aktif (HTTPS)",
      variant: "success",
    };
  }
  if (status === "error") {
    return {
      label: kind === "ownership" ? "Gagal / Perlu Tindakan" : "Gagal / Kedaluwarsa",
      variant: "destructive",
    };
  }
  return {
    label: kind === "ownership" ? "Menunggu Verifikasi" : "Menunggu Sertifikat",
    variant: "warning",
  };
}

function remedyAlertVariant(severity: DomainRemedy["severity"]): "info" | "warning" | "destructive" {
  if (severity === "error") return "destructive";
  if (severity === "warning") return "warning";
  return "info";
}

export function DomainsManager({
  handle,
  tenantName,
  tenantStatus,
  currentRole,
  canReadDomains,
  canManageDomains,
  cnameTarget,
  saasZone,
  apiBaseUrl,
  billingHref,
  guideHref,
  supportContact,
  initialItems,
  initialCustomDomainLocked,
  maxCustomHostnames,
}: DomainsManagerProps) {
  const [items, setItems] = React.useState<readonly TenantDomainItemDto[]>(initialItems);
  const [customDomainLocked, setCustomDomainLocked] = React.useState(initialCustomDomainLocked);

  // Connect wizard state
  const [selectedMode, setSelectedMode] = React.useState<DomainConnectMode>("new_domain");
  const [hostnameInput, setHostnameInput] = React.useState("");
  const [confirmApexFlattening, setConfirmApexFlattening] = React.useState(false);
  const [connectPending, setConnectPending] = React.useState(false);
  const [connectError, setConnectError] = React.useState<string | null>(null);
  const [suggestedWwwFromError, setSuggestedWwwFromError] = React.useState<string | null>(null);

  // Action feedback & clipboard state
  const [banner, setBanner] = React.useState<ActionBanner | null>(null);
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const [copyAnnouncement, setCopyAnnouncement] = React.useState("");

  // Safe removal confirmation dialog state (Base UI Dialog)
  const [removeTarget, setRemoveTarget] = React.useState<TenantDomainItemDto | null>(null);
  const [confirmRemoveInput, setConfirmRemoveInput] = React.useState("");
  const [removeError, setRemoveError] = React.useState<string | null>(null);
  const [removePending, setRemovePending] = React.useState(false);

  const isTrial = tenantStatus === "trial";
  const isSubscriptionLocked =
    tenantStatus === "locked" ||
    tenantStatus === "suspended" ||
    tenantStatus === "recovery" ||
    tenantStatus === "purging" ||
    tenantStatus === "purged";
  const canMutate = canManageDomains && !isTrial && !isSubscriptionLocked;

  const capabilities = React.useMemo(
    () =>
      evaluateTenantDomainSetCapabilities(
        items.map((item) => ({
          id: item.id,
          hostname: item.hostname,
          kind: item.kind,
          status: item.status,
          sslStatus: item.sslStatus,
          isPrimary: item.isPrimary,
          isLocked: item.isLocked,
        })),
      ),
    [items],
  );

  const eligibilityById = React.useMemo(() => {
    const map = new Map<number, (typeof capabilities.domains)[number]>();
    for (const entry of capabilities.domains) {
      map.set(entry.id, entry);
    }
    return map;
  }, [capabilities.domains]);

  const effectiveLocked = customDomainLocked || capabilities.customDomainLocked;
  const customDomains = React.useMemo(
    () => items.filter((item) => item.kind === "custom"),
    [items],
  );
  const subdomainItem = React.useMemo(
    () => items.find((item) => item.kind === "subdomain") ?? null,
    [items],
  );
  const currentPrimary = React.useMemo(
    () => items.find((item) => item.isPrimary) ?? subdomainItem,
    [items, subdomainItem],
  );

  // Live hostname preview & counterpart / apex checks
  const liveValidation = React.useMemo(() => {
    const trimmed = hostnameInput.trim();
    if (!trimmed) return null;
    return validateCustomHostname(trimmed, { saasZone });
  }, [hostnameInput, saasZone]);

  const isEnteringLikelyApex = Boolean(liveValidation?.ok && liveValidation.isLikelyApex);
  const counterpartMismatchWarning = React.useMemo(() => {
    if (!liveValidation?.ok || customDomains.length !== 1) return null;
    const existing = customDomains[0]!.hostname;
    if (liveValidation.hostname === existing) return null;
    if (!areDomainCounterparts(existing, liveValidation.hostname)) {
      return `Satu situs hanya mendukung 1 nama domain dan pasangan www/apex-nya. Domain yang sudah terhubung adalah ${existing}${capabilities.suggestedCounterpartHostname ? ` — pasangan yang diizinkan: ${capabilities.suggestedCounterpartHostname}` : ""}.`;
    }
    return null;
  }, [liveValidation, customDomains, capabilities.suggestedCounterpartHostname]);

  async function refreshDomains(): Promise<readonly TenantDomainItemDto[] | null> {
    try {
      const res = await fetch(apiBaseUrl, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        readonly items?: readonly TenantDomainItemDto[];
        readonly customDomainLocked?: boolean;
      };
      if (Array.isArray(data.items)) {
        setItems(data.items);
      }
      if (typeof data.customDomainLocked === "boolean") {
        setCustomDomainLocked(data.customDomainLocked);
      }
      return Array.isArray(data.items) ? data.items : null;
    } catch {
      return null;
    }
  }

  async function copyValue(key: string, label: string, value: string) {
    try {
      let copied = false;
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (!copied && typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.setAttribute("readonly", "true");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const execCopy = Reflect.get(document, "execCommand") as
          | ((cmd: string) => boolean)
          | undefined;
        copied = typeof execCopy === "function" ? Boolean(execCopy.call(document, "copy")) : false;
        document.body.removeChild(ta);
      }
      if (!copied) {
        throw new Error("Clipboard copy failed");
      }
      setCopiedId(key);
      setCopyAnnouncement(`${label} berhasil disalin ke papan klip.`);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === key ? null : prev));
      }, 2200);
    } catch {
      setCopyAnnouncement(`Gagal menyalin ${label}. Salin nilai secara manual.`);
    }
  }

  async function handleConnectSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canMutate || connectPending) return;

    setConnectError(null);
    setSuggestedWwwFromError(null);
    setBanner(null);

    const validated = validateCustomHostname(hostnameInput, { saasZone });
    if (!validated.ok) {
      setConnectError(validated.message);
      return;
    }

    if (counterpartMismatchWarning) {
      setConnectError(counterpartMismatchWarning);
      return;
    }

    if (validated.isLikelyApex && !confirmApexFlattening) {
      setConnectError(
        `Domain root/apex (${validated.hostname}) memerlukan dukungan CNAME flattening/ALIAS/ANAME pada penyedia DNS Anda. Centang konfirmasi di bawah atau gunakan ${validated.suggestedWwwCounterpart ?? `www.${validated.hostname}`}.`,
      );
      setSuggestedWwwFromError(validated.suggestedWwwCounterpart);
      return;
    }

    setConnectPending(true);
    try {
      const payload: Record<string, unknown> = {
        hostname: validated.hostname,
        mode: selectedMode,
      };
      if (validated.isLikelyApex) {
        payload.confirmApexFlattening = confirmApexFlattening;
      }

      const res = await fetch(apiBaseUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      const body = (await res.json().catch(() => ({}))) as ApiErrorBody & TenantDomainItemDto;

      if (!res.ok) {
        const msg =
          body.error?.message ?? "Gagal mendaftarkan domain kustom. Periksa input Anda dan coba lagi.";
        setConnectError(msg);
        if (body.suggestedWwwHostname) {
          setSuggestedWwwFromError(body.suggestedWwwHostname);
        }
        if (body.reconciliationPending) {
          await refreshDomains();
        }
        return;
      }

      await refreshDomains();
      setHostnameInput("");
      setConfirmApexFlattening(false);
      setBanner({
        kind: "success",
        title: `Domain ${validated.hostname} didaftarkan`,
        message:
          selectedMode === "zero_downtime_migration"
            ? "Ikuti Langkah 1 di bawah untuk menambahkan record TXT kepemilikan dan validasi SSL terlebih dahulu. CNAME routing akan terbuka otomatis setelah keduanya aktif."
            : "Ikuti instruksi DNS di bawah, lalu klik Periksa Ulang DNS setelah record tersimpan.",
      });
    } catch {
      setConnectError("Gagal menghubungi server PunyaSitus. Periksa koneksi internet Anda dan coba lagi.");
    } finally {
      setConnectPending(false);
    }
  }

  async function handleRecheck(
    domain: TenantDomainItemDto,
    overrideSslMethod?: "http" | "txt",
  ) {
    if (!canMutate || busyKey) return;
    const key = `recheck:${domain.id}`;
    setBusyKey(key);
    setBanner(null);

    try {
      const payload: Record<string, unknown> = { version: domain.version };
      if (overrideSslMethod) {
        payload.sslMethod = overrideSslMethod;
      }

      const res = await fetch(`${apiBaseUrl}/${encodeURIComponent(String(domain.id))}/recheck`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      const body = (await res.json().catch(() => ({}))) as ApiErrorBody & TenantDomainItemDto;

      if (!res.ok) {
        const isStale = res.status === 409 && body.error?.code === "STALE_VERSION";
        setBanner({
          kind: isStale ? "warning" : "error",
          title: isStale
            ? "Data domain telah berubah"
            : res.status === 429
              ? "Batas pemeriksaan tercapai"
              : "Pemeriksaan DNS belum berhasil",
          message:
            body.error?.message ?? "Gagal memeriksa ulang DNS domain. Silakan coba beberapa saat lagi.",
          staleConflict: isStale,
        });
        return;
      }

      await refreshDomains();
      const ownActive = body.ownershipStatus === "active";
      const tlsActive = body.tlsStatus === "active";
      setBanner({
        kind: ownActive && tlsActive ? "success" : "info",
        title: `Hasil pemeriksaan ${domain.hostname}`,
        message:
          ownActive && tlsActive
            ? domain.mode === "zero_downtime_migration" && body.instructions?.readyForCutover
              ? "Kepemilikan dan sertifikat SSL/TLS keduanya sudah aktif! Langkah 3 (CNAME routing) kini terbuka untuk pemindahan tanpa downtime."
              : "Kepemilikan dan sertifikat SSL/TLS keduanya sudah aktif."
            : `Status terbaru diperbarui — Kepemilikan: ${ownActive ? "Aktif" : "Menunggu/Perlu perbaikan"}, SSL/TLS: ${tlsActive ? "Aktif" : "Menunggu/Perlu perbaikan"}.`,
      });
    } catch {
      setBanner({
        kind: "error",
        title: "Koneksi terganggu",
        message: "Tidak dapat menjangkau server untuk memeriksa DNS. Coba lagi sesaat lagi.",
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function handleMakePrimary(domain: TenantDomainItemDto) {
    if (!canMutate || busyKey) return;
    const key = `primary:${domain.id}`;
    setBusyKey(key);
    setBanner(null);

    try {
      const res = await fetch(
        `${apiBaseUrl}/${encodeURIComponent(String(domain.id))}/make-primary`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ version: domain.version }),
        },
      );

      const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
      if (!res.ok) {
        const isStale = res.status === 409 && body.error?.code === "STALE_VERSION";
        const gateText =
          body.failedGates && body.failedGates.length > 0
            ? ` Syarat belum terpenuhi: ${body.failedGates.map((g) => g.messageId).join(" ")}`
            : "";
        setBanner({
          kind: isStale ? "warning" : "error",
          title: isStale ? "Data domain telah berubah" : "Belum dapat dijadikan domain utama",
          message: `${body.error?.message ?? "Gagal mengubah domain utama."}${gateText}`,
          staleConflict: isStale,
        });
        return;
      }

      await refreshDomains();
      setBanner({
        kind: "success",
        title: `${domain.hostname} kini menjadi domain utama`,
        message:
          "Domain utama diperbarui secara atomik. Domain terverifikasi lainnya otomatis mengalihkan pengunjung dengan status 301 ke domain utama.",
      });
    } catch {
      setBanner({
        kind: "error",
        title: "Gagal mengubah domain utama",
        message: "Terjadi gangguan jaringan. Domain utama sebelumnya tetap dipertahankan aman.",
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function handleConfirmRemove(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!removeTarget || !canMutate || removePending) return;

    const typed = confirmRemoveInput.trim().toLowerCase().replace(/\.$/, "");
    if (typed !== removeTarget.hostname) {
      setRemoveError(`Ketik persis "${removeTarget.hostname}" untuk mengonfirmasi penghapusan.`);
      return;
    }

    setRemovePending(true);
    setRemoveError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/${encodeURIComponent(String(removeTarget.id))}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          confirmHostname: typed,
          version: removeTarget.version,
        }),
      });

      if (res.status === 204) {
        const removedHost = removeTarget.hostname;
        setRemoveTarget(null);
        setConfirmRemoveInput("");
        await refreshDomains();
        setBanner({
          kind: "success",
          title: `Domain ${removedHost} berhasil dihapus`,
          message:
            `Routing telah dinonaktifkan dan situs tetap aman menggunakan ${handle}.${saasZone}. Hapus record DNS secara manual di penyedia DNS Anda jika tidak lagi diperlukan.`,
        });
        return;
      }

      const body = (await res.json().catch(() => ({}))) as ApiErrorBody & {
        readonly cleanupPending?: boolean;
        readonly message?: string;
      };

      if (res.status === 202 && body.cleanupPending) {
        const removedHost = removeTarget.hostname;
        setRemoveTarget(null);
        setConfirmRemoveInput("");
        await refreshDomains();
        setBanner({
          kind: "warning",
          title: `Routing ${removedHost} dinonaktifkan (pembersihan tertunda)`,
          message:
            body.message ??
            "Routing domain sudah dimatikan dan klaim ditahan sementara hingga pembersihan di Cloudflare selesai.",
        });
        return;
      }

      const isStale = res.status === 409 && body.error?.code === "STALE_VERSION";
      if (isStale) {
        const freshItems = await refreshDomains();
        const freshTarget = freshItems?.find((d) => d.hostname === removeTarget.hostname) ?? null;
        if (!freshTarget) {
          setRemoveTarget(null);
          setConfirmRemoveInput("");
          setRemoveError(null);
          setBanner({
            kind: "info",
            title: `Domain ${removeTarget.hostname} sudah tidak terdaftar`,
            message: "Domain ini telah dihapus sebelumnya. Daftar domain telah disegarkan.",
          });
          return;
        }
        const stillRemovable =
          freshTarget.kind === "custom" &&
          !freshTarget.isLocked &&
          freshTarget.status !== "active" &&
          freshTarget.status !== "disabled";
        if (!stillRemovable) {
          setRemoveTarget(null);
          setConfirmRemoveInput("");
          setRemoveError(null);
          setBanner({
            kind: "warning",
            title: `Domain ${freshTarget.hostname} tidak lagi dapat dihapus`,
            message:
              "Status domain sudah berubah menjadi aktif/terkunci atau sedang diproses. Hubungi admin platform untuk penggantian/penghapusan domain aktif.",
          });
          return;
        }
        setRemoveTarget(freshTarget);
        setRemoveError(
          `Versi domain telah diperbarui (v${freshTarget.version}). Klik "Ya, Hapus Domain" sekali lagi untuk melanjutkan penghapusan.`,
        );
        return;
      }

      setRemoveError(
        body.error?.message ?? "Gagal menghapus domain. Muat ulang halaman dan coba lagi.",
      );
    } catch {
      setRemoveError("Gangguan jaringan saat menghapus domain. Silakan coba lagi.");
    } finally {
      setRemovePending(false);
    }
  }

  // Editor permission denial screen (REQ-034, PLAN §4)
  if (!canReadDomains) {
    return (
      <section className="space-y-6" aria-labelledby="domains-denied-heading">
        <div className="space-y-1">
          <h1 id="domains-denied-heading" className="text-2xl font-semibold tracking-tight text-foreground">
            Domain Kustom
          </h1>
          <p className="text-sm text-muted-foreground">
            Pengaturan domain untuk situs <span className="font-medium text-foreground">{tenantName}</span>.
          </p>
        </div>

        <Alert variant="destructive" data-testid="domains-permission-denied">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Akses Pengaturan Domain Ditolak (403)</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Peran Anda saat ini (<strong className="font-semibold">{currentRole}</strong>) tidak memiliki
              izin untuk melihat atau mengubah pengaturan domain kustom. Hanya Pemilik Situs yang dapat
              mengelola domain.
            </p>
            <div>
              <Button
                variant="outline"
                className="min-h-11"
                render={<a href={`/dashboard/${encodeURIComponent(handle)}`} />}
              >
                Kembali ke Beranda
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  return (
    <section className="space-y-6" aria-labelledby="domains-page-heading">
      {/* Screen-reader live region for clipboard copy announcements */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {copyAnnouncement}
      </div>

      {/* Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 id="domains-page-heading" className="text-2xl font-semibold tracking-tight text-foreground">
              Domain Kustom
            </h1>
            <Badge variant="outline" className="tabular-nums" data-testid="domain-quota-badge">
              {capabilities.customCount} / {maxCustomHostnames} domain kustom
            </Badge>
            {effectiveLocked ? (
              <Badge variant="warning" data-testid="domain-locked-pill">
                <LockIcon className="size-3" aria-hidden="true" />
                Terkunci (Aktif)
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Hubungkan domain bisnis Anda ke <span className="font-medium text-foreground">{tenantName}</span>.
            Maksimal {maxCustomHostnames} hostname kustom per situs (domain utama dan pasangan{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">www</code>).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button
            variant="outline"
            className="min-h-11"
            data-testid="open-domain-guide-link"
            render={
              <a
                href={
                  guideHref ??
                  `/dashboard/${encodeURIComponent(handle)}/settings/domains/guide`
                }
              />
            }
          >
            <BookOpenIcon className="size-4" aria-hidden="true" />
            Panduan Domain &amp; Email
          </Button>
          {currentPrimary ? (
            <div className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
              <GlobeIcon className="size-3.5 text-primary shrink-0" aria-hidden="true" />
              <span className="shrink-0">Utama:</span>
              <span className="font-mono font-semibold text-foreground break-all sm:break-normal sm:whitespace-nowrap">
                {currentPrimary.hostname}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {/* Trial Gate Banner (DEC-035 C4) */}
      {isTrial ? (
        <Alert variant="warning" data-testid="trial-domain-gate">
          <AlertTriangleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Domain kustom aktif setelah berlangganan berbayar</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Website Anda sedang dalam masa percobaan 7 hari (trial) menggunakan subdomain{" "}
              <code className="rounded bg-card/70 px-1 py-0.5 text-xs font-mono">
                {handle}.{saasZone}
              </code>
              . Aktifkan paket berbayar terlebih dahulu untuk menghubungkan domain kustom.
            </p>
            <div>
              <Button className="min-h-11" render={<a href={billingHref} />}>
                Upgrade ke Paket Berbayar
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Subscription Locked Banner */}
      {isSubscriptionLocked ? (
        <Alert variant="destructive" data-testid="subscription-locked-banner">
          <LockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Langganan terkunci — pengaturan domain hanya dapat dibaca</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Situs publik Anda tetap aktif, tetapi penambahan, pemeriksaan ulang, pergantian domain utama,
              dan penghapusan domain dinonaktifkan hingga perpanjangan langganan diselesaikan.
            </p>
            <div>
              <Button variant="outline" className="min-h-11" render={<a href={billingHref} />}>
                Buka Tagihan &amp; Perpanjangan
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Admin Read-Only Notice */}
      {!canManageDomains ? (
        <Alert variant="info" data-testid="admin-readonly-banner">
          <InfoIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode Baca Saja (Peran Admin)</AlertTitle>
          <AlertDescription>
            Anda dapat memantau status kepemilikan DNS dan sertifikat SSL/TLS. Untuk menghubungkan,
            mengubah domain utama, atau menghapus domain, hubungi Pemilik Situs.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Post-Activation Lock Banner (REQ-065) */}
      {effectiveLocked ? (
        <Alert variant="warning" data-testid="post-activation-locked-banner">
          <LockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>
            Domain aktif terkunci — hubungi admin platform untuk penggantian/penghapusan
          </AlertTitle>
          <AlertDescription className="space-y-2.5">
            <p>
              Domain terkunci. Untuk ganti domain, hubungi admin. Setelah domain kustom mencapai status
              aktif, penghapusan atau penggantian nama domain hanya dilakukan oleh operator platform demi
              keamanan SEO dan integritas routing.
            </p>
            <p className="text-xs">
              Anda <strong>masih dapat</strong> menambahkan pasangan{" "}
              <code className="rounded bg-card/70 px-1 py-0.5 font-mono">www</code>/apex (bila kuota{" "}
              &lt; {maxCustomHostnames} hostname) dan memindahkan <strong>Domain Utama</strong> antar
              domain yang sudah aktif terverifikasi.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {supportContact.salesWhatsappHref ? (
                <Button
                  variant="outline"
                  className="min-h-11 bg-card"
                  render={
                    <a
                      href={supportContact.salesWhatsappHref}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                >
                  Hubungi Admin via WhatsApp
                  <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                variant="outline"
                className="min-h-11 max-w-full bg-card whitespace-normal text-left"
                render={<a href={`mailto:${supportContact.supportEmail}?subject=Permintaan%20Ganti%20Domain%20${encodeURIComponent(handle)}`} />}
              >
                <span className="break-all">Email Admin ({supportContact.supportEmail})</span>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Transient Action Feedback Banner */}
      {banner ? (
        <Alert
          variant={banner.kind === "error" ? "destructive" : banner.kind}
          data-testid="domains-action-banner"
        >
          {banner.kind === "success" ? (
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
          ) : banner.kind === "error" ? (
            <AlertCircleIcon className="size-4" aria-hidden="true" />
          ) : (
            <AlertTriangleIcon className="size-4" aria-hidden="true" />
          )}
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{banner.message}</p>
            {banner.staleConflict ? (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 bg-card"
                  onClick={() => void refreshDomains()}
                >
                  <RefreshCwIcon className="size-4" aria-hidden="true" />
                  Muat Ulang Data Domain
                </Button>
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 3-Mode Connect Wizard (available whenever < 2 custom hostnames & owner active/grace — INCLUDING when 1st domain is active/locked so counterpart add works!) */}
      {canManageDomains && capabilities.canAddMoreCustomHostnames ? (
        <Card data-testid="domain-connect-wizard">
          <CardHeader className="border-b border-border">
            <CardTitle>
              {customDomains.length === 1
                ? "Tambah Hostname Pasangan (www / Apex)"
                : "Hubungkan Domain Kustom"}
            </CardTitle>
            <CardDescription>
              Apakah situs di domain ini sudah live di tempat lain? Pilih mode koneksi yang sesuai dengan
              kondisi domain Anda saat ini agar transisi tetap aman.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Counterpart Helper when 1 custom domain already exists */}
            {customDomains.length === 1 ? (
              <Alert variant="info" data-testid="counterpart-rule-hint">
                <InfoIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Aturan 2 Hostname Pasangan (1 Domain per Situs)</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>
                    Domain terhubung saat ini:{" "}
                    <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs font-semibold">
                      {customDomains[0]!.hostname}
                    </code>
                    . Hostname kedua harus merupakan pasangan{" "}
                    <code className="rounded bg-card px-1 py-0.5 font-mono text-xs">www</code>/apex dari
                    domain yang sama.
                  </p>
                  {capabilities.suggestedCounterpartHostname ? (
                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 bg-card"
                        disabled={!canMutate}
                        data-testid="prefill-counterpart-btn"
                        onClick={() => {
                          setHostnameInput(capabilities.suggestedCounterpartHostname ?? "");
                          setConnectError(null);
                          setSuggestedWwwFromError(null);
                        }}
                      >
                        <PlusIcon className="size-4" aria-hidden="true" />
                        Isi Pasangan: {capabilities.suggestedCounterpartHostname}
                      </Button>
                    </div>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}

            {/* Step 1: 3-Mode Picker */}
            <fieldset className="space-y-2.5" disabled={!canMutate}>
              <legend className="text-sm font-semibold text-foreground">
                1. Apakah situs di domain ini sudah live di tempat lain?
              </legend>
              <div
                className="grid grid-cols-1 gap-3 lg:grid-cols-3"
                role="radiogroup"
                aria-label="Pilih mode koneksi domain"
                data-testid="connect-mode-picker"
              >
                {MODE_CARDS.map((card) => {
                  const selected = selectedMode === card.id;
                  return (
                    <button
                      key={card.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={!canMutate}
                      data-mode-option={card.id}
                      onClick={() => {
                        setSelectedMode(card.id);
                        setConnectError(null);
                      }}
                      className={`flex min-h-11 flex-col items-start gap-2 rounded-lg border p-3.5 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 ${
                        selected
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border bg-card hover:bg-muted/50"
                      }`}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <Badge variant={selected ? "default" : "secondary"}>{card.badge}</Badge>
                        <span
                          aria-hidden="true"
                          className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
                            selected ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card"
                          }`}
                        >
                          {selected ? <CheckIcon className="size-3" /> : null}
                        </span>
                      </div>
                      <span className="text-sm font-semibold text-foreground">{card.title}</span>
                      <span className="text-xs leading-relaxed text-muted-foreground">
                        {card.subtitle}
                      </span>
                      <span className="text-xs leading-relaxed text-foreground/85">{card.summary}</span>
                      <span className="mt-auto border-t border-border/70 pt-2 text-[11px] leading-relaxed text-muted-foreground">
                        {card.downtimeNote}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* Cloudflare Nameserver & O2O Hint Callout */}
            <Alert
              variant={selectedMode === "cloudflare_o2o" ? "warning" : "info"}
              data-testid="cloudflare-nameserver-hint"
            >
              <CloudIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Petunjuk Nameserver Cloudflare (DNS-Only vs O2O)</AlertTitle>
              <AlertDescription className="space-y-1.5 text-xs leading-relaxed">
                <p>
                  Jika domain Anda menggunakan <strong>nameserver Cloudflare</strong> (
                  <code className="font-mono">*.ns.cloudflare.com</code>): pilih mode{" "}
                  <strong>Domain Sudah di Cloudflare (O2O)</strong> agar PunyaSitus mendaftarkan custom
                  hostname terlebih dahulu sebelum Anda menyimpan CNAME (mencegah Error 1014), atur{" "}
                  <strong>SSL/TLS ke Full atau Full (strict)</strong> (jangan Flexible), dan hindari
                  aturan redirect ganda pada zona Cloudflare Anda.
                </p>
                <p>
                  Jika Anda memakai mode non-O2O pada panel DNS yang mendukung proxy, gunakan{" "}
                  <strong>DNS-only (awan abu-abu)</strong> saat verifikasi awal agar pengecekan CNAME{" "}
                  <code className="font-mono">{cnameTarget}</code> dan validasi sertifikat berjalan lancar.
                </p>
              </AlertDescription>
            </Alert>

            {/* Step 2: Hostname Entry Form */}
            <form onSubmit={handleConnectSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <label
                  htmlFor="custom-hostname-input"
                  className="block text-sm font-semibold text-foreground"
                >
                  2. Masukkan Nama Domain (hostname saja)
                </label>
                <div className="flex flex-col gap-2.5 sm:flex-row">
                  <div className="flex-1 min-w-0">
                    <Input
                      id="custom-hostname-input"
                      name="hostname"
                      type="text"
                      inputMode="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      disabled={!canMutate || connectPending}
                      placeholder={
                        capabilities.suggestedCounterpartHostname ?? "Contoh: www.bisnisanda.id"
                      }
                      value={hostnameInput}
                      onChange={(e) => {
                        setHostnameInput(e.target.value);
                        setConnectError(null);
                        setSuggestedWwwFromError(null);
                      }}
                      aria-invalid={Boolean(connectError || counterpartMismatchWarning)}
                      className="min-h-11 font-mono"
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={!canMutate || connectPending || !hostnameInput.trim()}
                    className="min-h-11 px-5"
                    data-testid="connect-domain-submit"
                  >
                    <PlusIcon className="size-4" aria-hidden="true" />
                    {connectPending ? "Mendaftarkan..." : "Hubungkan Domain"}
                  </Button>
                </div>

                {/* Live Normalized Hostname Preview */}
                {liveValidation?.ok ? (
                  <p className="text-xs text-muted-foreground" data-testid="normalized-hostname-preview">
                    Hostname ternormalisasi:{" "}
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono font-semibold text-foreground">
                      {liveValidation.hostname}
                    </code>
                    {liveValidation.isLikelyApex ? " (Root / Apex Domain)" : " (Subdomain / www)"}
                  </p>
                ) : liveValidation && !liveValidation.ok ? (
                  <p className="text-xs text-destructive" role="alert">
                    {liveValidation.message}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Disarankan menggunakan <code className="font-mono">www.bisnisanda.id</code> sebagai
                    domain utama. Tanpa <code className="font-mono">https://</code>, path, atau wildcard.
                  </p>
                )}
              </div>

              {/* Apex / Root Domain Capability & Flattening Confirmation */}
              {isEnteringLikelyApex ? (
                <div
                  className="space-y-2.5 rounded-lg border border-warning-border bg-warning-soft/70 p-3.5 text-xs text-warning"
                  data-testid="apex-flattening-notice"
                >
                  <p className="font-semibold">
                    Perhatian Domain Root / Apex ({liveValidation?.ok ? liveValidation.hostname : ""})
                  </p>
                  <p className="leading-relaxed">
                    Tidak semua penyedia DNS/registrar di Indonesia mendukung CNAME flattening, ALIAS, atau
                    ANAME pada root domain. Jangan membuat CNAME standar yang tidak valid atau menebak
                    alamat IP. Jika penyedia DNS Anda tidak mendukung flattening, gunakan{" "}
                    <code className="font-mono font-semibold">
                      {liveValidation?.ok ? liveValidation.suggestedWwwCounterpart : ""}
                    </code>{" "}
                    sebagai domain utama lalu atur redirect apex-ke-www di registrar.
                  </p>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-foreground">
                    <input
                      type="checkbox"
                      checked={confirmApexFlattening}
                      onChange={(e) => setConfirmApexFlattening(e.target.checked)}
                      className="size-4 rounded border-input accent-primary"
                      data-testid="confirm-apex-checkbox"
                    />
                    <span>
                      Saya mengonfirmasi penyedia DNS saya mendukung CNAME flattening / ALIAS / ANAME untuk
                      domain root ini.
                    </span>
                  </label>
                </div>
              ) : null}

              {counterpartMismatchWarning ? (
                <Alert variant="destructive" data-testid="counterpart-mismatch-error">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Domain Tidak Cocok dengan Pasangan</AlertTitle>
                  <AlertDescription>{counterpartMismatchWarning}</AlertDescription>
                </Alert>
              ) : null}

              {connectError ? (
                <Alert variant="destructive" data-testid="connect-domain-error">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Tidak Dapat Menghubungkan Domain</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p>{connectError}</p>
                    {suggestedWwwFromError ? (
                      <div>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11 bg-card"
                          onClick={() => {
                            setHostnameInput(suggestedWwwFromError);
                            setConnectError(null);
                            setSuggestedWwwFromError(null);
                          }}
                        >
                          Gunakan {suggestedWwwFromError} sebagai gantinya
                        </Button>
                      </div>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
            </form>
          </CardContent>
        </Card>
      ) : null}

      {/* Connected Custom Domains Section */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-foreground">Domain Terhubung</h2>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => void refreshDomains()}
            data-testid="refresh-domains-btn"
          >
            <RefreshCwIcon className="size-4" aria-hidden="true" />
            Segarkan Status
          </Button>
        </div>

        {customDomains.length === 0 ? (
          <Card data-testid="domains-empty-state">
            <CardContent className="flex flex-col items-start gap-2 py-6">
              <div className="flex items-center gap-2 text-foreground font-semibold">
                <GlobeIcon className="size-4 text-primary" aria-hidden="true" />
                Belum ada domain kustom terhubung
              </div>
              <p className="text-sm text-muted-foreground">
                Saat ini website Anda berjalan aktif di subdomain bawaan{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  {handle}.{saasZone}
                </code>
                . Gunakan formulir di atas untuk menghubungkan domain bisnis Anda.
              </p>
            </CardContent>
          </Card>
        ) : (
          customDomains.map((domain) => {
            const elig = eligibilityById.get(domain.id);
            const ownBadge = independentStatusUi(domain.ownershipStatus, "ownership");
            const tlsBadge = independentStatusUi(domain.tlsStatus, "tls");
            const bothActive =
              domain.ownershipStatus === "active" && domain.tlsStatus === "active";
            const isMigration = domain.mode === "zero_downtime_migration";
            const cutoverLocked = Boolean(domain.instructions?.cnameCutoverLocked);
            const cnameVerified =
              Boolean(domain.dnsTargetObserved) &&
              domain.dnsTargetObserved?.trim().toLowerCase().replace(/\.$/, "") ===
                cnameTarget.trim().toLowerCase().replace(/\.$/, "");
            const isRechecking = busyKey === `recheck:${domain.id}`;
            const isPromoting = busyKey === `primary:${domain.id}`;
            const hasHttpDcvBlocked = domain.remedies.some((r) => r.code === "HTTP_DCV_BLOCKED");

            return (
              <Card
                key={domain.hostname}
                data-testid={`domain-card-${domain.hostname}`}
                data-domain-status={domain.status}
                data-ownership-status={domain.ownershipStatus}
                data-tls-status={domain.tlsStatus}
              >
                <CardHeader className="border-b border-border gap-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="font-mono text-base break-all">
                          {domain.hostname}
                        </CardTitle>
                        <Badge variant="outline">{modeLabel(domain.mode)}</Badge>
                        {domain.isPrimary ? (
                          <Badge variant="default" data-testid={`primary-badge-${domain.hostname}`}>
                            Domain Utama
                          </Badge>
                        ) : bothActive && domain.status === "active" ? (
                          <Badge variant="secondary" data-testid={`alias-badge-${domain.hostname}`}>
                            Alias (301 ke Utama)
                          </Badge>
                        ) : null}
                        {domain.isLocked ? (
                          <Badge variant="warning" data-testid={`locked-badge-${domain.hostname}`}>
                            <LockIcon className="size-3" aria-hidden="true" />
                            Terkunci
                          </Badge>
                        ) : null}
                      </div>
                      <CardDescription className="tabular-nums text-xs">
                        Terakhir diperiksa: {formatWib(domain.lastCheckedAt)} · Versi v{domain.version}
                        {domain.certificateAuthority ? ` · CA: ${domain.certificateAuthority}` : ""}
                      </CardDescription>
                    </div>

                    {/* Domain Action Buttons (>= 44px tap targets) */}
                    <div className="flex flex-wrap items-center gap-2">
                      {canMutate && elig?.canRecheck ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={Boolean(busyKey)}
                          data-testid={`recheck-btn-${domain.hostname}`}
                          onClick={() => void handleRecheck(domain)}
                        >
                          <RefreshCwIcon
                            className={`size-4 ${isRechecking ? "animate-spin" : ""}`}
                            aria-hidden="true"
                          />
                          {isRechecking ? "Memeriksa..." : "Periksa Ulang DNS"}
                        </Button>
                      ) : null}

                      {canMutate && elig?.canMakePrimary ? (
                        <Button
                          type="button"
                          className="min-h-11"
                          disabled={Boolean(busyKey)}
                          data-testid={`make-primary-btn-${domain.hostname}`}
                          onClick={() => void handleMakePrimary(domain)}
                        >
                          <ArrowRightLeftIcon className="size-4" aria-hidden="true" />
                          {isPromoting ? "Mengalihkan..." : "Jadikan Domain Utama"}
                        </Button>
                      ) : null}

                      {canMutate && elig?.canOwnerRemove ? (
                        <Button
                          type="button"
                          variant="destructive"
                          className="min-h-11"
                          disabled={Boolean(busyKey)}
                          data-testid={`remove-domain-btn-${domain.hostname}`}
                          onClick={() => {
                            setRemoveTarget(domain);
                            setConfirmRemoveInput("");
                            setRemoveError(null);
                          }}
                        >
                          <Trash2Icon className="size-4" aria-hidden="true" />
                          Hapus Domain
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {/* Independent Ownership & TLS Status Strip (NEVER false success!) */}
                  <div
                    className="grid grid-cols-1 gap-2.5 sm:grid-cols-3"
                    data-testid={`independent-status-grid-${domain.hostname}`}
                  >
                    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium text-muted-foreground">
                          1. Status Kepemilikan
                        </div>
                        <div className="text-xs font-semibold text-foreground">
                          {domain.providerStatus ?? domain.hostStatus}
                        </div>
                      </div>
                      <Badge
                        variant={ownBadge.variant}
                        data-testid={`ownership-badge-${domain.hostname}`}
                      >
                        {ownBadge.label}
                      </Badge>
                    </div>

                    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium text-muted-foreground">
                          2. Status Sertifikat SSL/TLS
                        </div>
                        <div className="text-xs font-semibold text-foreground">
                          {domain.providerSslStatus ?? domain.sslStatus}
                        </div>
                      </div>
                      <Badge
                        variant={tlsBadge.variant}
                        data-testid={`tls-badge-${domain.hostname}`}
                      >
                        {tlsBadge.label}
                      </Badge>
                    </div>

                    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium text-muted-foreground">
                          3. Target CNAME Routing
                        </div>
                        <div className="truncate font-mono text-xs font-semibold text-foreground">
                          {domain.dnsTargetObserved ?? "Belum terdeteksi"}
                        </div>
                      </div>
                      <Badge variant={cnameVerified ? "success" : "secondary"}>
                        {cnameVerified ? "Sesuai" : "Belum"}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  {/* Anti-False-Success Warning when one check is active but the other is still pending */}
                  {!bothActive ? (
                    <Alert variant="warning" data-testid={`pending-warning-${domain.hostname}`}>
                      <ClockIcon className="size-4" aria-hidden="true" />
                      <AlertTitle>Belum Aktif Penuh — Menunggu Verifikasi Lengkap</AlertTitle>
                      <AlertDescription>
                        Domain baru dapat melayani trafik HTTPS dengan aman setelah{" "}
                        <strong>Status Kepemilikan</strong> dan <strong>Status Sertifikat SSL/TLS</strong>{" "}
                        keduanya berstatus <strong>Aktif</strong>.
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {/* DCV Token Age Warning (Day 5 / Expired) */}
                  {domain.tokenAge &&
                  domain.tlsStatus !== "active" &&
                  (domain.tokenAge.warningDay5 || domain.tokenAge.expired) ? (
                    <Alert
                      variant={domain.tokenAge.expired ? "destructive" : "warning"}
                      data-testid={`token-age-warning-${domain.hostname}`}
                    >
                      <ClockIcon className="size-4" aria-hidden="true" />
                      <AlertTitle className="tabular-nums">
                        {domain.tokenAge.expired
                          ? "Token Validasi SSL Kedaluwarsa"
                          : `Umur Token Validasi SSL: ${domain.tokenAge.ageDays} dari ${domain.tokenAge.ttlDays} hari`}
                      </AlertTitle>
                      <AlertDescription>{domain.tokenAge.warningMessageId}</AlertDescription>
                    </Alert>
                  ) : null}

                  {/* Two-Step Zero-Downtime Migration Stepper */}
                  {isMigration && domain.instructions ? (
                    <div
                      className="space-y-3 rounded-lg border border-border bg-muted/25 p-4"
                      data-testid={`migration-stepper-${domain.hostname}`}
                      data-cutover-locked={String(cutoverLocked)}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-foreground">
                          Panduan Pindahan Tanpa Downtime (2 Tahap)
                        </h3>
                        <Badge variant={cutoverLocked ? "warning" : "success"}>
                          {cutoverLocked
                            ? "Tahap 2 CNAME Terkunci"
                            : "Siap Pindah CNAME (Nol Downtime)"}
                        </Badge>
                      </div>

                      <ol className="space-y-2.5">
                        {domain.instructions.steps.map((step) => (
                          <li
                            key={step.key}
                            data-step-key={step.key}
                            data-step-locked={String(step.locked)}
                            className={`rounded-md border p-3 text-xs ${
                              step.locked
                                ? "border-warning-border bg-warning-soft/50 text-foreground"
                                : step.completed
                                  ? "border-success-border bg-success-soft/60 text-foreground"
                                  : "border-border bg-card text-foreground"
                            }`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-semibold">
                                Langkah {step.stepNumber}: {step.titleId}
                              </span>
                              <Badge
                                variant={
                                  step.completed
                                    ? "success"
                                    : step.locked
                                      ? "warning"
                                      : "secondary"
                                }
                              >
                                {step.completed
                                  ? "Selesai"
                                  : step.locked
                                    ? "Terkunci"
                                    : "Berlangsung"}
                              </Badge>
                            </div>
                            <p className="mt-1 leading-relaxed text-muted-foreground">
                              {step.descriptionId}
                            </p>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}

                  {/* Exact Copyable DNS Records Table (Desktop) + Stacked Cards (Mobile 360px) */}
                  {domain.validationRecords.length > 0 ? (
                    <div className="space-y-2.5" data-testid={`dns-records-${domain.hostname}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-foreground">
                          Instruksi Record DNS (Salin Persis)
                        </h3>
                        <span className="text-xs text-muted-foreground">
                          PunyaSitus tidak pernah mengubah DNS Anda secara otomatis.
                        </span>
                      </div>

                      {/* Mobile stacked cards (< md) — zero horizontal overflow at 360px */}
                      <div className="space-y-3 md:hidden">
                        {domain.validationRecords.map((rec, idx) => {
                          const st = recordStatusBadge(rec.status);
                          const nameKey = `m-name-${domain.id}-${idx}`;
                          const valKey = `m-val-${domain.id}-${idx}`;
                          return (
                            <div
                              key={`${rec.recordType}-${rec.name}-${idx}`}
                              data-record-purpose={rec.purpose}
                              className="space-y-2.5 rounded-lg border border-border bg-card p-3 text-xs"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5">
                                  <Badge variant="outline" className="font-mono">
                                    {rec.recordType}
                                  </Badge>
                                  <span className="font-semibold text-foreground">
                                    {purposeLabel(rec.purpose)}
                                  </span>
                                </div>
                                <Badge variant={st.variant}>{st.label}</Badge>
                              </div>

                              <div className="space-y-1">
                                <div className="text-[11px] font-medium text-muted-foreground">
                                  Nama / Host
                                </div>
                                <div className="flex items-center justify-between gap-2 rounded border border-border bg-muted/40 px-2.5 py-2">
                                  <code className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">
                                    {rec.name}
                                  </code>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="min-h-11 min-w-11 shrink-0 px-3"
                                    aria-label={`Salin nama record ${rec.name}`}
                                    data-copy-record-name={rec.name}
                                    onClick={() =>
                                      void copyValue(nameKey, `Nama record ${rec.name}`, rec.name)
                                    }
                                  >
                                    {copiedId === nameKey ? (
                                      <CheckIcon className="size-4 text-primary" aria-hidden="true" />
                                    ) : (
                                      <CopyIcon className="size-4" aria-hidden="true" />
                                    )}
                                    <span>{copiedId === nameKey ? "Tersalin" : "Salin"}</span>
                                  </Button>
                                </div>
                              </div>

                              <div className="space-y-1">
                                <div className="text-[11px] font-medium text-muted-foreground">
                                  Nilai / Target
                                </div>
                                <div className="flex items-center justify-between gap-2 rounded border border-border bg-muted/40 px-2.5 py-2">
                                  <code className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">
                                    {rec.value}
                                  </code>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="min-h-11 min-w-11 shrink-0 px-3"
                                    aria-label={`Salin nilai record ${rec.name}`}
                                    data-copy-record-value={rec.value}
                                    onClick={() =>
                                      void copyValue(valKey, `Nilai record ${rec.name}`, rec.value)
                                    }
                                  >
                                    {copiedId === valKey ? (
                                      <CheckIcon className="size-4 text-primary" aria-hidden="true" />
                                    ) : (
                                      <CopyIcon className="size-4" aria-hidden="true" />
                                    )}
                                    <span>{copiedId === valKey ? "Tersalin" : "Salin"}</span>
                                  </Button>
                                </div>
                              </div>

                              <div className="pt-1 text-[11px] text-muted-foreground">
                                Retensi:{" "}
                                <strong className="text-foreground">
                                  {rec.removableAfterActive
                                    ? "Boleh dihapus setelah aktif"
                                    : "Wajib dipertahankan"}
                                </strong>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Desktop / Tablet compact table (>= md) */}
                      <div className="hidden md:block">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-20">Tipe</TableHead>
                              <TableHead>Nama / Host</TableHead>
                              <TableHead>Nilai / Target</TableHead>
                              <TableHead>Tujuan &amp; Retensi</TableHead>
                              <TableHead className="w-28">Status</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {domain.validationRecords.map((rec, idx) => {
                              const st = recordStatusBadge(rec.status);
                              const nameKey = `d-name-${domain.id}-${idx}`;
                              const valKey = `d-val-${domain.id}-${idx}`;
                              return (
                                <TableRow
                                  key={`${rec.recordType}-${rec.name}-${idx}`}
                                  data-record-purpose={rec.purpose}
                                >
                                  <TableCell className="align-top">
                                    <Badge variant="outline" className="font-mono">
                                      {rec.recordType}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="align-top whitespace-normal">
                                    <div className="flex items-start justify-between gap-2">
                                      <code className="break-all font-mono text-xs text-foreground">
                                        {rec.name}
                                      </code>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        className="min-h-11 shrink-0 px-2.5 text-xs"
                                        aria-label={`Salin nama record ${rec.name}`}
                                        data-copy-record-name={rec.name}
                                        onClick={() =>
                                          void copyValue(nameKey, `Nama record ${rec.name}`, rec.name)
                                        }
                                      >
                                        {copiedId === nameKey ? (
                                          <CheckIcon className="size-3.5 text-primary" aria-hidden="true" />
                                        ) : (
                                          <CopyIcon className="size-3.5" aria-hidden="true" />
                                        )}
                                        <span>{copiedId === nameKey ? "Tersalin" : "Salin"}</span>
                                      </Button>
                                    </div>
                                  </TableCell>
                                  <TableCell className="align-top whitespace-normal">
                                    <div className="flex items-start justify-between gap-2">
                                      <code className="break-all font-mono text-xs text-foreground">
                                        {rec.value}
                                      </code>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        className="min-h-11 shrink-0 px-2.5 text-xs"
                                        aria-label={`Salin nilai record ${rec.name}`}
                                        data-copy-record-value={rec.value}
                                        onClick={() =>
                                          void copyValue(valKey, `Nilai record ${rec.name}`, rec.value)
                                        }
                                      >
                                        {copiedId === valKey ? (
                                          <CheckIcon className="size-3.5 text-primary" aria-hidden="true" />
                                        ) : (
                                          <CopyIcon className="size-3.5" aria-hidden="true" />
                                        )}
                                        <span>{copiedId === valKey ? "Tersalin" : "Salin"}</span>
                                      </Button>
                                    </div>
                                  </TableCell>
                                  <TableCell className="align-top whitespace-normal">
                                    <div className="text-xs font-medium text-foreground">
                                      {purposeLabel(rec.purpose)}
                                    </div>
                                    <div className="mt-1">
                                      <Badge variant={rec.removableAfterActive ? "secondary" : "info"}>
                                        {rec.removableAfterActive
                                          ? "Boleh dihapus setelah aktif"
                                          : "Wajib dipertahankan"}
                                      </Badge>
                                    </div>
                                  </TableCell>
                                  <TableCell className="align-top">
                                    <Badge variant={st.variant}>{st.label}</Badge>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  ) : null}

                  {/* Remedies & Diagnostic Alerts */}
                  {domain.remedies.length > 0 ? (
                    <div className="space-y-2" data-testid={`remedies-${domain.hostname}`}>
                      {domain.remedies.map((remedy) => (
                        <Alert key={remedy.code} variant={remedyAlertVariant(remedy.severity)}>
                          <AlertCircleIcon className="size-4" aria-hidden="true" />
                          <AlertTitle>{remedy.titleId}</AlertTitle>
                          <AlertDescription className="space-y-1.5 text-xs">
                            <p>{remedy.messageId}</p>
                            <p className="font-medium text-foreground">{remedy.actionHintId}</p>
                            {remedy.code === "HTTP_DCV_BLOCKED" && hasHttpDcvBlocked && canMutate ? (
                              <div className="pt-1">
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="min-h-11 bg-card"
                                  disabled={Boolean(busyKey)}
                                  onClick={() => void handleRecheck(domain, "txt")}
                                >
                                  Ubah Validasi SSL ke TXT &amp; Periksa Ulang
                                </Button>
                              </div>
                            ) : null}
                          </AlertDescription>
                        </Alert>
                      ))}
                    </div>
                  ) : null}

                  {/* Cloudflare Nameserver Hint on specific domain card */}
                  {domain.cloudflareNameserverHint ? (
                    <Alert variant="info" data-testid={`domain-cf-hint-${domain.hostname}`}>
                      <CloudIcon className="size-4" aria-hidden="true" />
                      <AlertTitle>Petunjuk Zona Cloudflare</AlertTitle>
                      <AlertDescription className="text-xs leading-relaxed">
                        Pastikan mode SSL/TLS pada akun Cloudflare Anda diatur ke{" "}
                        <strong>Full</strong> atau <strong>Full (strict)</strong> (bukan Flexible), dan
                        jangan pasang aturan redirect domain yang bentrok dengan pengalihan 301 PunyaSitus.
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {/* Post-Activation Cleanup Guidance (shown once domain is fully active) */}
                  {bothActive && domain.status === "active" && domain.postActivationCleanup ? (
                    <div
                      className="space-y-2.5 rounded-lg border border-success-border bg-success-soft/50 p-3.5 text-xs"
                      data-testid={`post-activation-cleanup-${domain.hostname}`}
                    >
                      <div className="flex items-center gap-2 font-semibold text-success">
                        <ShieldCheckIcon className="size-4 shrink-0" aria-hidden="true" />
                        Panduan Pembersihan DNS Setelah Aktif
                      </div>
                      <p className="leading-relaxed text-foreground">
                        {domain.postActivationCleanup.summaryId}
                      </p>
                      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                        {domain.postActivationCleanup.removable.length > 0 ? (
                          <div className="space-y-1.5 rounded-md border border-border bg-card p-3">
                            <div className="font-semibold text-foreground">
                              Boleh dihapus dengan aman
                            </div>
                            <ul className="space-y-1.5">
                              {domain.postActivationCleanup.removable.map((item, idx) => (
                                <li key={`rem-${idx}`} className="leading-relaxed text-muted-foreground">
                                  <code className="font-mono font-semibold text-foreground">
                                    {item.recordType} {item.name}
                                  </code>{" "}
                                  — {item.guidanceId}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        <div className="space-y-1.5 rounded-md border border-border bg-card p-3">
                          <div className="font-semibold text-foreground">
                            WAJIB tetap dipertahankan (jangan dihapus)
                          </div>
                          <ul className="space-y-1.5">
                            {domain.postActivationCleanup.mustKeep.map((item, idx) => (
                              <li key={`keep-${idx}`} className="leading-relaxed text-muted-foreground">
                                <code className="font-mono font-semibold text-foreground">
                                  {item.recordType} {item.name}
                                </code>{" "}
                                — {item.guidanceId}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {/* Per-Domain Post-Activation Locked Notice */}
                  {domain.isLocked ? (
                    <div
                      className="flex flex-col gap-2 rounded-md border border-warning-border bg-warning-soft/50 px-3.5 py-2.5 text-xs text-warning sm:flex-row sm:items-center sm:justify-between"
                      data-testid={`domain-locked-notice-${domain.hostname}`}
                    >
                      <div className="flex items-center gap-2">
                        <LockIcon className="size-3.5 shrink-0" aria-hidden="true" />
                        <span>
                          <strong>Domain aktif terkunci</strong> — hubungi admin platform untuk
                          penggantian/penghapusan.
                        </span>
                      </div>
                      {supportContact.salesWhatsappHref ? (
                        <a
                          href={supportContact.salesWhatsappHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-11 items-center gap-1 font-semibold underline underline-offset-2 sm:min-h-8"
                        >
                          Hubungi Admin
                          <ExternalLinkIcon className="size-3" aria-hidden="true" />
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })
        )}

        {/* Platform Fallback Subdomain Card */}
        {subdomainItem ? (
          <Card data-testid="platform-fallback-card">
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="font-mono text-base break-all">
                      {subdomainItem.hostname}
                    </CardTitle>
                    <Badge variant="success">Fallback Terverifikasi</Badge>
                    {subdomainItem.isPrimary ? (
                      <Badge variant="default" data-testid="fallback-primary-badge">
                        Domain Utama
                      </Badge>
                    ) : (
                      <Badge variant="secondary" data-testid="fallback-alias-badge">
                        Pengalihan 301 ke Domain Utama
                      </Badge>
                    )}
                  </div>
                  <CardDescription className="text-xs">
                    Subdomain bawaan platform tetap aktif sebagai cadangan terverifikasi dan tidak dapat
                    dihapus. Jika domain kustom belum aktif atau dihapus, pengunjung otomatis dilayani di
                    sini.
                  </CardDescription>
                </div>

                {canMutate && !subdomainItem.isPrimary ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 shrink-0"
                    disabled={Boolean(busyKey)}
                    data-testid="make-primary-fallback-btn"
                    onClick={() => void handleMakePrimary(subdomainItem)}
                  >
                    <ArrowRightLeftIcon className="size-4" aria-hidden="true" />
                    {busyKey === `primary:${subdomainItem.id}`
                      ? "Mengalihkan..."
                      : "Jadikan Domain Utama"}
                  </Button>
                ) : null}
              </div>
            </CardHeader>
          </Card>
        ) : null}
      </div>

      {/* Safe Pre-Activation Removal Confirmation Dialog (@base-ui/react/dialog) */}
      <Dialog.Root
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !removePending) {
            setRemoveTarget(null);
            setConfirmRemoveInput("");
            setRemoveError(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[55] bg-foreground/40 transition-opacity duration-150" />
          <Dialog.Popup
            data-testid="remove-domain-dialog"
            className="fixed top-1/2 left-1/2 z-[60] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-sm text-card-foreground shadow-lg outline-none"
          >
            <div className="flex items-start justify-between gap-3">
              <Dialog.Title className="text-base font-semibold text-foreground">
                Hapus Domain Belum Aktif?
              </Dialog.Title>
              <Dialog.Close
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="min-h-11 min-w-11"
                    aria-label="Tutup dialog"
                  />
                }
              >
                <XIcon className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>

            <Dialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Menghapus{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground">
                {removeTarget?.hostname}
              </code>{" "}
              akan segera menonaktifkan routing dan membersihkan pendaftaran di Cloudflare. Subdomain{" "}
              <code className="font-mono text-xs">
                {handle}.{saasZone}
              </code>{" "}
              tetap aman. Record DNS di penyedia DNS Anda harus dihapus secara manual.
            </Dialog.Description>

            <form onSubmit={handleConfirmRemove} className="mt-4 space-y-3" noValidate>
              <div className="space-y-1.5">
                <label
                  htmlFor="confirm-remove-hostname"
                  className="block text-xs font-semibold text-foreground"
                >
                  Ketik ulang{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono">
                    {removeTarget?.hostname}
                  </code>{" "}
                  untuk konfirmasi:
                </label>
                <Input
                  id="confirm-remove-hostname"
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={confirmRemoveInput}
                  onChange={(e) => {
                    setConfirmRemoveInput(e.target.value);
                    setRemoveError(null);
                  }}
                  placeholder={removeTarget?.hostname ?? ""}
                  className="min-h-11 font-mono"
                  data-testid="confirm-remove-input"
                />
              </div>

              {removeError ? (
                <p className="text-xs text-destructive" role="alert" data-testid="remove-error-text">
                  {removeError}
                </p>
              ) : null}

              <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
                <Dialog.Close
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={removePending}
                    />
                  }
                >
                  Batal
                </Dialog.Close>
                <Button
                  type="submit"
                  variant="destructive"
                  className="min-h-11"
                  disabled={removePending}
                  data-testid="confirm-remove-submit"
                >
                  {removePending ? "Menghapus..." : "Ya, Hapus Domain"}
                </Button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

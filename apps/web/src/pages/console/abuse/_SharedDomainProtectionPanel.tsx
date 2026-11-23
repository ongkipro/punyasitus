import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  GlobeIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  XCircleIcon,
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OwnerHeldNoticeCard } from "./_OwnerHeldNoticeCard";

export type ScreeningReviewStatus = "held_for_review" | "released" | "rejected" | "takedown";
export type ScreeningFilterStatus = "all" | ScreeningReviewStatus;
export type ScreeningReviewDecision = "release" | "reject" | "takedown";
export type ScreeningCategory = "gambling" | "phishing" | "malware" | "scam" | "illegal_content";

export interface ScreeningFindingDto {
  readonly ruleId: string;
  readonly ruleType: "keyword" | "domain";
  readonly category: ScreeningCategory;
  readonly severity: "hold" | "high";
  readonly fieldKind: "title" | "text" | "link_host" | "image_alt" | "form_label";
  readonly fieldPath: string;
  readonly matchedHost: string | null;
  readonly redactedExcerpt: string;
}

export interface ScreeningReviewItemDto {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly tenantStatus: string;
  readonly tenantVersion: number;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly resourceSlug: string | null;
  readonly resourceTitle: string;
  readonly publishSource: "dashboard" | "mcp" | "api";
  readonly expectedVersion: number;
  readonly status: ScreeningReviewStatus;
  readonly matchCount: number;
  readonly matchedCategories: readonly ScreeningCategory[];
  readonly matchedFields: readonly string[];
  readonly findings: readonly ScreeningFindingDto[];
  readonly contentSha256: string;
  readonly rulesetVersion: number;
  readonly resolutionReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScreeningReviewCountsDto {
  readonly all: number;
  readonly held_for_review: number;
  readonly released: number;
  readonly rejected: number;
  readonly takedown: number;
}

export interface TrustWatchRunSummaryDto {
  readonly id: string;
  readonly runDay: string;
  readonly status: "clean" | "hit" | "unknown";
  readonly checkedHostsCount: number;
  readonly resolvedHostsCount: number;
  readonly failedHostsCount: number;
  readonly hitCount: number;
  readonly hits: readonly { readonly host: string; readonly ip: string; readonly source: string }[];
  readonly errorCode: string | null;
  readonly alertSent: boolean;
  readonly createdAt: string;
}

export interface ScreeningRuleItemDto {
  readonly id: string;
  readonly ruleType: "keyword" | "domain";
  readonly pattern: string;
  readonly category: ScreeningCategory;
  readonly severity: "hold" | "high";
  readonly active: boolean;
  readonly ruleVersion: number;
}

export interface SharedDomainProtectionPanelProps {
  readonly initialReviews: readonly ScreeningReviewItemDto[];
  readonly initialCounts: ScreeningReviewCountsDto;
  readonly initialLatestTrustRun: TrustWatchRunSummaryDto | null;
  readonly initialOperatorRules: readonly ScreeningRuleItemDto[];
  readonly builtinRulesCount: number;
  readonly primarySaasZone: string;
  readonly fallbackSaasZone: string;
  readonly stepUpFresh: boolean;
}

const REVIEW_STATUS_LABELS: Readonly<Record<ScreeningReviewStatus, string>> = {
  held_for_review: "Ditahan",
  released: "Dirilis",
  rejected: "Tetap Draf",
  takedown: "Diturunkan",
};

const REVIEW_STATUS_VARIANTS: Readonly<
  Record<ScreeningReviewStatus, "warning" | "success" | "outline" | "destructive">
> = {
  held_for_review: "warning",
  released: "success",
  rejected: "outline",
  takedown: "destructive",
};

const CATEGORY_LABELS: Readonly<Record<ScreeningCategory, string>> = {
  gambling: "Judi Online",
  phishing: "Phishing",
  malware: "Malware",
  scam: "Penipuan",
  illegal_content: "Konten Ilegal",
};

const FIELD_KIND_LABELS: Readonly<Record<string, string>> = {
  title: "Judul",
  text: "Teks Konten",
  link_host: "Host Tautan",
  image_alt: "ALT Gambar",
  form_label: "Label Formulir",
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  dashboard: "Dashboard",
  mcp: "MCP",
  api: "API",
};

const RESOURCE_TYPE_LABELS: Readonly<Record<string, string>> = {
  page: "Halaman",
  post: "Artikel",
  offering: "Penawaran",
  form: "Formulir",
  site_settings: "Pengaturan Situs",
  business_profile: "Profil Bisnis",
  menu: "Menu",
  theme_config: "Konfigurasi Tema",
};

const DECISION_LABELS: Readonly<Record<ScreeningReviewDecision, string>> = {
  release: "Rilis & Publikasikan",
  reject: "Tetap Tahan sebagai Draf",
  takedown: "Turunkan situs",
};

const FILTER_TABS: readonly { readonly id: ScreeningFilterStatus; readonly label: string }[] = [
  { id: "all", label: "Semua" },
  { id: "held_for_review", label: "Ditahan" },
  { id: "released", label: "Dirilis" },
  { id: "rejected", label: "Tetap Draf" },
  { id: "takedown", label: "Diturunkan" },
];

function formatDateTimeWib(isoString: string): string {
  try {
    const dt = new Date(isoString);
    if (Number.isNaN(dt.getTime())) return isoString;
    return `${dt.toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })} WIB`;
  } catch {
    return isoString;
  }
}

export function SharedDomainProtectionPanel({
  initialReviews,
  initialCounts,
  initialLatestTrustRun,
  initialOperatorRules,
  builtinRulesCount,
  primarySaasZone,
  fallbackSaasZone,
  stepUpFresh,
}: SharedDomainProtectionPanelProps) {
  const [reviews, setReviews] = React.useState<readonly ScreeningReviewItemDto[]>(initialReviews);
  const [counts, setCounts] = React.useState<ScreeningReviewCountsDto>(initialCounts);
  const [statusFilter, setStatusFilter] = React.useState<ScreeningFilterStatus>("all");
  const [searchInput, setSearchInput] = React.useState("");
  const [activeSearch, setActiveSearch] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = React.useState<string | null>(null);

  const [selected, setSelected] = React.useState<ScreeningReviewItemDto | null>(null);
  const [decision, setDecision] = React.useState<ScreeningReviewDecision>("release");
  const [reasonInput, setReasonInput] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [drawerError, setDrawerError] = React.useState<string | null>(null);

  const [operatorRules, setOperatorRules] =
    React.useState<readonly ScreeningRuleItemDto[]>(initialOperatorRules);
  const [ruleType, setRuleType] = React.useState<"keyword" | "domain">("keyword");
  const [rulePattern, setRulePattern] = React.useState("");
  const [ruleCategory, setRuleCategory] = React.useState<ScreeningCategory>("gambling");
  const [ruleReason, setRuleReason] = React.useState("");
  const [ruleSaving, setRuleSaving] = React.useState(false);
  const [ruleFeedback, setRuleFeedback] = React.useState<{
    readonly ok: boolean;
    readonly message: string;
  } | null>(null);

  const fetchReviews = React.useCallback(
    async (opts: { readonly status: ScreeningFilterStatus; readonly search: string }) => {
      setLoading(true);
      setLoadError(null);
      try {
        const params = new URLSearchParams();
        if (opts.status !== "all") params.set("status", opts.status);
        if (opts.search.trim()) params.set("search", opts.search.trim());
        params.set("limit", "20");

        const res = await fetch(`/api/console/abuse/screening?${params.toString()}`, {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const data = (await res.json().catch(() => null)) as {
          items?: ScreeningReviewItemDto[];
          counts?: ScreeningReviewCountsDto;
          error?: { message?: string };
        } | null;

        if (!res.ok || !data) {
          setLoadError(data?.error?.message ?? "Gagal memuat antrean tinjauan konten.");
          return;
        }
        setReviews(Array.isArray(data.items) ? data.items : []);
        if (data.counts) setCounts(data.counts);
      } catch {
        setLoadError("Tidak dapat terhubung ke server console.");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  function openReviewDrawer(item: ScreeningReviewItemDto) {
    setSelected(item);
    setDecision("release");
    setReasonInput("");
    setDrawerError(null);
  }

  async function handleFilterChange(next: ScreeningFilterStatus) {
    setStatusFilter(next);
    await fetchReviews({ status: next, search: activeSearch });
  }

  async function handleSearchSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = searchInput.trim();
    setActiveSearch(trimmed);
    await fetchReviews({ status: statusFilter, search: trimmed });
  }

  async function handleDecisionSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || submitting) return;

    const trimmedReason = reasonInput.trim();
    if (trimmedReason.length < 10) {
      setDrawerError("Alasan audit wajib diisi minimal 10 karakter.");
      return;
    }

    setSubmitting(true);
    setDrawerError(null);
    try {
      const idempotencyKey = `scr-${selected.id}-${selected.version}-${decision}`;
      const res = await fetch(
        `/api/console/abuse/screening/${encodeURIComponent(selected.id)}/decision`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            decision,
            reason: trimmedReason,
            expectedVersion: selected.version,
          }),
        },
      );
      const data = (await res.json().catch(() => null)) as {
        review?: ScreeningReviewItemDto;
        error?: { message?: string };
      } | null;

      if (!res.ok || !data?.review) {
        setDrawerError(data?.error?.message ?? "Gagal menyimpan keputusan tinjauan.");
        return;
      }

      setSelected(data.review);
      setBannerMessage(
        `Tinjauan ${data.review.id} selesai diproses (${DECISION_LABELS[decision]}).`,
      );
      await fetchReviews({ status: statusFilter, search: activeSearch });
    } catch {
      setDrawerError("Koneksi terputus saat memproses keputusan tinjauan.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddRuleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (ruleSaving) return;

    const cleanPattern = rulePattern.trim();
    const cleanReason = ruleReason.trim();
    if (!cleanPattern) {
      setRuleFeedback({ ok: false, message: "Pola kata kunci atau domain wajib diisi." });
      return;
    }
    if (cleanReason.length < 10) {
      setRuleFeedback({ ok: false, message: "Alasan audit aturan minimal 10 karakter." });
      return;
    }

    setRuleSaving(true);
    setRuleFeedback(null);
    try {
      const res = await fetch("/api/console/abuse/rules", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          ruleType,
          pattern: cleanPattern,
          category: ruleCategory,
          severity: "high",
          active: true,
          reason: cleanReason,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        rule?: ScreeningRuleItemDto;
        error?: { message?: string };
      } | null;

      if (!res.ok || !data?.rule) {
        setRuleFeedback({
          ok: false,
          message: data?.error?.message ?? "Gagal menyimpan aturan penyaringan.",
        });
        return;
      }

      setOperatorRules((prev) => [data.rule!, ...prev.filter((r) => r.id !== data.rule!.id)]);
      setRulePattern("");
      setRuleReason("");
      setRuleFeedback({
        ok: true,
        message: `Aturan ${data.rule.ruleType} "${data.rule.pattern}" aktif (v${data.rule.ruleVersion}).`,
      });
    } catch {
      setRuleFeedback({ ok: false, message: "Koneksi terputus saat menyimpan aturan." });
    } finally {
      setRuleSaving(false);
    }
  }

  const trustStatusBadge = !initialLatestTrustRun
    ? { label: "Belum Ada Data", variant: "outline" as const }
    : initialLatestTrustRun.status === "clean"
      ? { label: "Bersih", variant: "success" as const }
      : initialLatestTrustRun.status === "hit"
        ? { label: "Terdeteksi di Trust+", variant: "destructive" as const }
        : { label: "Tidak Diketahui (Cek Gagal)", variant: "warning" as const };

  const isSelectedHeld = selected !== null && selected.status === "held_for_review";
  const featuredHeldItem =
    reviews.find((r) => r.status === "held_for_review") ?? reviews[0] ?? null;

  return (
    <section
      className="space-y-5 border-t border-border pt-6"
      data-testid="shared-domain-protection-panel"
    >
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Perlindungan Domain Bersama &amp; Antrean Penyaringan Publikasi
        </h2>
        <p className="text-sm text-muted-foreground">
          Tinjau konten yang ditahan otomatis saat publikasi (Dashboard &amp; MCP), pantau status
          IP harian Trust+ Komdigi, dan eksekusi tindakan cepat Turunkan situs dalam satu langkah
          teraudit.
        </p>
      </div>

      {/* Trust+ Watch & Standby Fallback Zone Strip */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card data-testid="trust-watch-status-card">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <GlobeIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                <span>Pantauan Harian Trust+ Komdigi</span>
              </CardTitle>
              <Badge variant={trustStatusBadge.variant} data-testid="trust-watch-status-badge">
                {trustStatusBadge.label}
              </Badge>
            </div>
            <CardDescription>
              Pemeriksaan harian record A (IPv4) host platform &amp; tenant terhadap daftar IP
              Trust+ Komdigi.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {initialLatestTrustRun ? (
              <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div className="rounded-md border border-border bg-muted/30 p-2">
                  <dt className="text-muted-foreground">Hari Cek</dt>
                  <dd className="font-mono font-semibold text-foreground">
                    {initialLatestTrustRun.runDay}
                  </dd>
                </div>
                <div className="rounded-md border border-border bg-muted/30 p-2">
                  <dt className="text-muted-foreground">Host Dicek</dt>
                  <dd className="font-semibold tabular-nums text-foreground">
                    {initialLatestTrustRun.checkedHostsCount}
                  </dd>
                </div>
                <div className="rounded-md border border-border bg-muted/30 p-2">
                  <dt className="text-muted-foreground">Temuan IP</dt>
                  <dd className="font-semibold tabular-nums text-foreground">
                    {initialLatestTrustRun.hitCount}
                  </dd>
                </div>
                <div className="rounded-md border border-border bg-muted/30 p-2">
                  <dt className="text-muted-foreground">Gagal DNS</dt>
                  <dd className="font-semibold tabular-nums text-foreground">
                    {initialLatestTrustRun.failedHostsCount}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-xs text-muted-foreground">
                Belum ada riwayat pemeriksaan harian tersimpan. Ketiadaan data selalu dilaporkan
                sebagai tidak diketahui, bukan bersih.
              </p>
            )}
            {initialLatestTrustRun && (
              <p className="text-xs text-muted-foreground tabular-nums">
                Terakhir dijalankan: {formatDateTimeWib(initialLatestTrustRun.createdAt)}
                {initialLatestTrustRun.errorCode ? ` · Kode: ${initialLatestTrustRun.errorCode}` : ""}
              </p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="fallback-zone-readiness-card">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                <span>Zona Cadangan Siaga (Manual Runbook)</span>
              </CardTitle>
              <Badge variant="outline">Siaga · Non-Otomatis</Badge>
            </div>
            <CardDescription>
              Domain khusus klien berbayar tidak terdampak jika zona bersama mengalami blokir.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
              <span className="text-muted-foreground">Zona Utama Tenant</span>
              <span className="font-mono font-semibold text-foreground">{primarySaasZone}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
              <span className="text-muted-foreground">Zona Cadangan (Fallback)</span>
              <span className="font-mono font-semibold text-foreground">{fallbackSaasZone}</span>
            </div>
            <p className="text-muted-foreground">
              Prosedur rotasi manual &amp; pengajuan normalisasi Komdigi:{" "}
              <span className="font-mono text-foreground">docs/operations/trust-positif.md</span>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* KPI Row for Screening Queue */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Konten Ditahan</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="screening-count-held">
              {counts.held_for_review}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Dirilis (False Positive)</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="screening-count-released">
              {counts.released}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Tetap Draf</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="screening-count-rejected">
              {counts.rejected}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Situs Diturunkan</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="screening-count-takedown">
              {counts.takedown}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {bannerMessage && (
        <Alert variant="success" data-testid="screening-decision-success">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Keputusan tinjauan tersimpan</AlertTitle>
          <AlertDescription>{bannerMessage}</AlertDescription>
        </Alert>
      )}

      {loadError && (
        <Alert variant="destructive" data-testid="screening-queue-error">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal memuat antrean penyaringan</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {/* Owner-facing "Konten ditahan" preview banner (guarantees zero matched term disclosure) */}
      <div className="space-y-1.5" data-testid="owner-held-notice-preview-section">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Pratinjau Pemberitahuan Pemilik Situs (Tanpa Kata Kunci Tercocok)
        </p>
        <OwnerHeldNoticeCard
          resourceTitle={featuredHeldItem?.resourceTitle}
          resourceTypeLabel={
            featuredHeldItem
              ? (RESOURCE_TYPE_LABELS[featuredHeldItem.resourceType] ?? "Konten")
              : "Halaman"
          }
          reviewId={featuredHeldItem?.id}
          heldAtLabel={featuredHeldItem ? formatDateTimeWib(featuredHeldItem.createdAt) : undefined}
        />
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="tablist"
          aria-label="Filter status antrean penyaringan"
          className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card p-1"
        >
          {FILTER_TABS.map((tab) => {
            const active = statusFilter === tab.id;
            const count = counts[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`screening-filter-${tab.id}`}
                onClick={() => handleFilterChange(tab.id)}
                className={`inline-flex min-h-11 items-center gap-1.5 rounded-sm px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-8 ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-muted"
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`rounded-sm px-1.5 py-0.5 text-xs tabular-nums ${
                    active
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:w-72">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Cari situs atau judul konten..."
              aria-label="Cari antrean penyaringan konten"
              className="pl-9"
              data-testid="screening-search-input"
            />
          </div>
          <Button type="submit" variant="outline" className="min-h-11 shrink-0 md:min-h-9">
            Cari
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 shrink-0 md:min-h-9 md:min-w-9"
            aria-label="Muat ulang antrean penyaringan"
            disabled={loading}
            onClick={() => fetchReviews({ status: statusFilter, search: activeSearch })}
          >
            <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          </Button>
        </form>
      </div>

      {/* Review Queue List */}
      {reviews.length === 0 ? (
        <Card data-testid="screening-queue-empty">
          <CardContent className="flex flex-col items-start gap-2 py-8">
            <div className="flex items-center gap-2 text-muted-foreground">
              <ShieldCheckIcon className="size-5 shrink-0" aria-hidden="true" />
              <h3 className="text-base font-semibold text-foreground">
                Tidak ada konten ditahan pada filter ini
              </h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Setiap publikasi dari Dashboard atau MCP yang cocok dengan daftar larangan akan
              ditahan sebagai draf dan muncul di antrean ini.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card data-testid="screening-queue-table-card">
          <CardContent className="p-0">
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Situs &amp; Konten</TableHead>
                    <TableHead>Sumber</TableHead>
                    <TableHead>Temuan Kategori</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Ditahan Pada</TableHead>
                    <TableHead className="text-right">Tindakan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reviews.map((item) => (
                    <TableRow key={item.id} data-testid={`screening-row-${item.id}`}>
                      <TableCell className="align-top">
                        <div className="space-y-0.5">
                          <p className="font-medium text-foreground">{item.resourceTitle}</p>
                          <p className="text-xs text-muted-foreground">
                            {item.tenantName}{" "}
                            <span className="font-mono">({item.tenantHandle})</span> ·{" "}
                            {RESOURCE_TYPE_LABELS[item.resourceType] ?? item.resourceType} #
                            {item.resourceId}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge variant="outline">
                          {SOURCE_LABELS[item.publishSource] ?? item.publishSource}
                        </Badge>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex flex-wrap gap-1">
                          {item.matchedCategories.map((cat) => (
                            <Badge key={cat} variant="destructive">
                              {CATEGORY_LABELS[cat] ?? cat}
                            </Badge>
                          ))}
                          {item.matchedFields.map((fk) => (
                            <Badge key={fk} variant="outline">
                              {FIELD_KIND_LABELS[fk] ?? fk}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge
                          variant={REVIEW_STATUS_VARIANTS[item.status]}
                          data-testid={`screening-status-badge-${item.id}`}
                        >
                          {REVIEW_STATUS_LABELS[item.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
                        {formatDateTimeWib(item.createdAt)}
                      </TableCell>
                      <TableCell className="align-top text-right">
                        <Button
                          variant="default"
                          size="sm"
                          data-testid={`screening-open-btn-${item.id}`}
                          onClick={() => openReviewDrawer(item)}
                        >
                          Tinjau
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile 360px Stacked Cards */}
            <ul className="divide-y divide-border md:hidden">
              {reviews.map((item) => (
                <li
                  key={item.id}
                  data-testid={`screening-card-${item.id}`}
                  className="space-y-2.5 px-4 py-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">{item.resourceTitle}</p>
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        {item.tenantHandle} ·{" "}
                        {RESOURCE_TYPE_LABELS[item.resourceType] ?? item.resourceType} #
                        {item.resourceId}
                      </p>
                    </div>
                    <Badge variant={REVIEW_STATUS_VARIANTS[item.status]}>
                      {REVIEW_STATUS_LABELS[item.status]}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <Badge variant="outline">
                      {SOURCE_LABELS[item.publishSource] ?? item.publishSource}
                    </Badge>
                    {item.matchedCategories.map((cat) => (
                      <Badge key={cat} variant="destructive">
                        {CATEGORY_LABELS[cat] ?? cat}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {formatDateTimeWib(item.createdAt)}
                  </p>
                  <Button
                    variant="default"
                    className="min-h-11 w-full"
                    data-testid={`screening-mobile-open-${item.id}`}
                    onClick={() => openReviewDrawer(item)}
                  >
                    Tinjau &amp; Putuskan
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Denylist Rules Management Card */}
      <Card data-testid="screening-rules-card">
        <CardHeader>
          <CardTitle className="text-base">
            Daftar Larangan Kata Kunci &amp; Domain ({builtinRulesCount} bawaan ·{" "}
            {operatorRules.length} kustom operator)
          </CardTitle>
          <CardDescription>
            Tambahkan kata kunci atau host domain baru ke daftar penyaringan di{" "}
            <span className="font-mono">PLATFORM_DB</span>. Setiap perubahan dicatat pada audit log.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {ruleFeedback && (
            <Alert variant={ruleFeedback.ok ? "success" : "destructive"}>
              <AlertTitle>{ruleFeedback.ok ? "Aturan tersimpan" : "Gagal menyimpan aturan"}</AlertTitle>
              <AlertDescription>{ruleFeedback.message}</AlertDescription>
            </Alert>
          )}
          <form onSubmit={handleAddRuleSubmit} className="grid grid-cols-1 gap-3 md:grid-cols-12">
            <div className="space-y-1 md:col-span-2">
              <label htmlFor="screening-rule-type" className="block text-xs font-medium text-foreground">
                Tipe
              </label>
              <select
                id="screening-rule-type"
                value={ruleType}
                onChange={(e) => setRuleType(e.target.value as "keyword" | "domain")}
                className="h-11 w-full rounded-md border border-input bg-card px-2.5 text-sm text-foreground md:h-9"
              >
                <option value="keyword">Kata Kunci</option>
                <option value="domain">Domain</option>
              </select>
            </div>
            <div className="space-y-1 md:col-span-3">
              <label htmlFor="screening-rule-pattern" className="block text-xs font-medium text-foreground">
                Pola / Host
              </label>
              <Input
                id="screening-rule-pattern"
                value={rulePattern}
                onChange={(e) => setRulePattern(e.target.value)}
                placeholder={ruleType === "domain" ? "contoh-judol.example" : "frasa terlarang"}
                data-testid="screening-rule-pattern-input"
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <label htmlFor="screening-rule-category" className="block text-xs font-medium text-foreground">
                Kategori
              </label>
              <select
                id="screening-rule-category"
                value={ruleCategory}
                onChange={(e) => setRuleCategory(e.target.value as ScreeningCategory)}
                className="h-11 w-full rounded-md border border-input bg-card px-2.5 text-sm text-foreground md:h-9"
              >
                <option value="gambling">Judi Online</option>
                <option value="phishing">Phishing</option>
                <option value="malware">Malware</option>
                <option value="scam">Penipuan</option>
                <option value="illegal_content">Konten Ilegal</option>
              </select>
            </div>
            <div className="space-y-1 md:col-span-3">
              <label htmlFor="screening-rule-reason" className="block text-xs font-medium text-foreground">
                Alasan Audit (min. 10 karakter)
              </label>
              <Input
                id="screening-rule-reason"
                value={ruleReason}
                onChange={(e) => setRuleReason(e.target.value)}
                placeholder="Dasar penambahan aturan..."
                data-testid="screening-rule-reason-input"
              />
            </div>
            <div className="flex items-end md:col-span-2">
              <Button
                type="submit"
                className="min-h-11 w-full md:min-h-9"
                disabled={ruleSaving}
                data-testid="screening-rule-submit-btn"
              >
                <PlusIcon className="mr-1.5 size-4" aria-hidden="true" />
                {ruleSaving ? "Menyimpan..." : "Tambah"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Operator Review Detail & Decision Sheet */}
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-[min(32rem,95vw)] overflow-y-auto"
          data-testid="screening-review-sheet"
        >
          {selected && (
            <>
              <SheetHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <SheetTitle>Tinjauan Konten Ditahan</SheetTitle>
                  <Badge variant={REVIEW_STATUS_VARIANTS[selected.status]}>
                    {REVIEW_STATUS_LABELS[selected.status]}
                  </Badge>
                </div>
                <SheetDescription className="break-all font-mono text-xs">
                  {selected.id} · v{selected.version} · Ruleset v{selected.rulesetVersion}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 px-4 py-2">
                <dl className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-muted/30 p-3.5 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Situs &amp; Konten</dt>
                    <dd className="font-semibold text-foreground">{selected.resourceTitle}</dd>
                    <dd className="font-mono text-xs text-muted-foreground">
                      {selected.tenantName} ({selected.tenantHandle}) · {selected.resourceType} #
                      {selected.resourceId}
                    </dd>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">Jalur Publikasi</dt>
                      <dd className="font-medium text-foreground">
                        {SOURCE_LABELS[selected.publishSource] ?? selected.publishSource}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Status Situs</dt>
                      <dd className="font-mono text-xs text-foreground">{selected.tenantStatus}</dd>
                    </div>
                  </div>
                </dl>

                {/* Operator-only Redacted Findings */}
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Temuan Penyaringan (Khusus Operator — Tersamarkan)
                  </h3>
                  <ul className="space-y-2">
                    {selected.findings.map((finding, idx) => (
                      <li
                        key={`${finding.ruleId}-${idx}`}
                        className="space-y-1 rounded-lg border border-border bg-card p-3 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="destructive">
                            {CATEGORY_LABELS[finding.category] ?? finding.category}
                          </Badge>
                          <Badge variant="outline">
                            {FIELD_KIND_LABELS[finding.fieldKind] ?? finding.fieldKind}
                          </Badge>
                          <span className="font-mono text-muted-foreground">{finding.ruleId}</span>
                        </div>
                        <p className="break-words text-foreground">{finding.redactedExcerpt}</p>
                        {finding.matchedHost && (
                          <p className="font-mono text-destructive">
                            Host tautan: {finding.matchedHost}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                {selected.resolutionReason && (
                  <Alert variant="success">
                    <ShieldCheckIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>Catatan Keputusan Operator</AlertTitle>
                    <AlertDescription>{selected.resolutionReason}</AlertDescription>
                  </Alert>
                )}

                {drawerError && (
                  <Alert variant="destructive" data-testid="screening-drawer-error">
                    <AlertCircleIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>Gagal memproses keputusan</AlertTitle>
                    <AlertDescription>{drawerError}</AlertDescription>
                  </Alert>
                )}

                {isSelectedHeld && (
                  <form
                    id="screening-decision-form"
                    onSubmit={handleDecisionSubmit}
                    className="space-y-4 border-t border-border pt-4"
                  >
                    {!stepUpFresh && (
                      <Alert variant="warning">
                        <ShieldAlertIcon className="size-4" aria-hidden="true" />
                        <AlertTitle>Verifikasi ulang 2FA diperlukan</AlertTitle>
                        <AlertDescription>
                          Sesi 2FA step-up Anda melebihi 10 menit. Verifikasi ulang 2FA sebelum
                          mengeksekusi keputusan.
                        </AlertDescription>
                      </Alert>
                    )}

                    <div className="space-y-2">
                      <span className="block text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        Pilih Keputusan Operator
                      </span>
                      <div className="grid grid-cols-1 gap-2">
                        {(
                          [
                            {
                              id: "release",
                              label: "Rilis & Publikasikan",
                              desc: "False positive: publikasikan draf ke situs dengan catatan audit.",
                              icon: CheckCircle2Icon,
                            },
                            {
                              id: "reject",
                              label: "Tetap Tahan sebagai Draf",
                              desc: "Tolak publikasi; item tetap berstatus draf dan tidak tampil publik.",
                              icon: XCircleIcon,
                            },
                            {
                              id: "takedown",
                              label: "Turunkan situs",
                              desc: "Satu klik: tangguhkan situs (HTTP 503 suspended), aktifkan operator hold & audit.",
                              icon: ShieldAlertIcon,
                            },
                          ] as const
                        ).map((opt) => {
                          const Icon = opt.icon;
                          const active = decision === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              data-testid={`screening-decision-${opt.id}`}
                              onClick={() => setDecision(opt.id)}
                              className={`flex min-h-11 items-start gap-2.5 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                                active
                                  ? "border-primary bg-primary/5"
                                  : "border-border bg-card hover:bg-muted/50"
                              }`}
                            >
                              <Icon
                                className={`mt-0.5 size-4 shrink-0 ${
                                  opt.id === "takedown"
                                    ? "text-destructive"
                                    : active
                                      ? "text-primary"
                                      : "text-muted-foreground"
                                }`}
                                aria-hidden="true"
                              />
                              <span className="min-w-0 space-y-0.5">
                                <span className="block text-sm font-semibold text-foreground">
                                  {opt.label}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                  {opt.desc}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label
                        htmlFor="screening-reason-input"
                        className="block text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                      >
                        Alasan Audit Wajib (10–500 karakter)
                      </label>
                      <textarea
                        id="screening-reason-input"
                        rows={3}
                        required
                        minLength={10}
                        maxLength={500}
                        value={reasonInput}
                        onChange={(e) => setReasonInput(e.target.value)}
                        placeholder="Tuliskan dasar keputusan peninjauan tanpa PII atau rahasia..."
                        className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        data-testid="screening-reason-input"
                      />
                    </div>
                  </form>
                )}
              </div>

              {isSelectedHeld && (
                <SheetFooter>
                  <Button
                    type="submit"
                    form="screening-decision-form"
                    variant={decision === "takedown" ? "destructive" : "default"}
                    className="min-h-11 w-full md:min-h-9"
                    disabled={submitting}
                    data-testid="screening-decision-submit"
                  >
                    {submitting ? "Memproses..." : `Konfirmasi: ${DECISION_LABELS[decision]}`}
                  </Button>
                </SheetFooter>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

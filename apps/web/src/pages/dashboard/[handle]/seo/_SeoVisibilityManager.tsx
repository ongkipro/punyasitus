import * as React from "react";
import { Switch } from "@base-ui/react/switch";
import type { ChannelMetricRow } from "@punyasitus/core/analytics/attribution";
import {
  AI_TRAINING_CRAWLER_DESCRIPTORS,
  FACETED_FILTER_DISALLOW_PATTERNS,
  SEARCH_AND_AI_FETCHER_DESCRIPTORS,
  type AiTrainingPolicy,
} from "@punyasitus/core/seo/robots";
import {
  ActivityIcon,
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  InfoIcon,
  ShieldCheckIcon,
  ZapIcon,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SeoVisibilitySnapshot } from "./_data";

export interface SeoVisibilityManagerProps {
  readonly initialSnapshot: SeoVisibilitySnapshot;
  readonly canEditPolicy: boolean;
}

function formatNumberId(value: number): string {
  return new Intl.NumberFormat("id-ID").format(value);
}

function formatPercentId(value: number): string {
  return `${value.toFixed(1).replace(".", ",")}%`;
}

function formatDateTimeWib(ms: number): string {
  try {
    return `${new Date(ms).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      dateStyle: "medium",
      timeStyle: "short",
    })} WIB`;
  } catch {
    return new Date(ms).toISOString();
  }
}

export function SeoVisibilityManager({
  initialSnapshot,
  canEditPolicy,
}: SeoVisibilityManagerProps) {
  const [snapshot, setSnapshot] = React.useState<SeoVisibilitySnapshot>(initialSnapshot);
  const [savingPolicy, setSavingPolicy] = React.useState(false);
  const [activatingKey, setActivatingKey] = React.useState(false);
  const [copiedRobots, setCopiedRobots] = React.useState(false);
  const [copiedKeyUrl, setCopiedKeyUrl] = React.useState(false);
  const [statusFeedback, setStatusFeedback] = React.useState<{
    readonly kind: "success" | "error";
    readonly message: string;
  } | null>(null);

  const apiUrl = `/dashboard/${encodeURIComponent(snapshot.handle)}/seo/api`;
  const isLockedOrSuspended =
    snapshot.tenantStatus === "locked" || snapshot.tenantStatus === "suspended";
  const toggleDisabled = !canEditPolicy || isLockedOrSuspended || savingPolicy;
  const trainingAllowed = snapshot.aiTrainingPolicy === "allow";

  async function handleToggleAiTraining(nextChecked: boolean) {
    if (toggleDisabled) return;
    const nextPolicy: AiTrainingPolicy = nextChecked ? "allow" : "disallow";
    const previousSnapshot = snapshot;

    setSavingPolicy(true);
    setStatusFeedback(null);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "update-ai-training-policy",
          aiTrainingPolicy: nextPolicy,
        }),
      });

      const data = (await response.json()) as {
        readonly success?: boolean;
        readonly message?: string;
        readonly snapshot?: SeoVisibilitySnapshot;
      };

      if (!response.ok || !data.success || !data.snapshot) {
        setSnapshot(previousSnapshot);
        setStatusFeedback({
          kind: "error",
          message:
            data.message ??
            "Gagal menyimpan kebijakan crawler pelatihan AI. Silakan coba lagi.",
        });
        return;
      }

      setSnapshot(data.snapshot);
      setStatusFeedback({
        kind: "success",
        message:
          data.message ??
          (nextPolicy === "disallow"
            ? "Crawler pelatihan AI berhasil diblokir."
            : "Crawler pelatihan AI berhasil diizinkan."),
      });
    } catch {
      setSnapshot(previousSnapshot);
      setStatusFeedback({
        kind: "error",
        message: "Koneksi terputus saat menyimpan kebijakan crawler AI.",
      });
    } finally {
      setSavingPolicy(false);
    }
  }

  async function handleEnsureIndexNowKey() {
    if (toggleDisabled || !snapshot.indexnowEligible || activatingKey) return;
    setActivatingKey(true);
    setStatusFeedback(null);
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({ action: "ensure-indexnow-key" }),
      });
      const data = (await response.json()) as {
        readonly success?: boolean;
        readonly message?: string;
        readonly snapshot?: SeoVisibilitySnapshot;
      };
      if (!response.ok || !data.success || !data.snapshot) {
        setStatusFeedback({
          kind: "error",
          message: data.message ?? "Gagal menyiapkan kunci verifikasi IndexNow.",
        });
        return;
      }
      setSnapshot(data.snapshot);
      setStatusFeedback({
        kind: "success",
        message: "Kunci verifikasi IndexNow siap digunakan pada domain khusus Anda.",
      });
    } catch {
      setStatusFeedback({
        kind: "error",
        message: "Koneksi terputus saat menyiapkan kunci IndexNow.",
      });
    } finally {
      setActivatingKey(false);
    }
  }

  async function copyText(value: string, target: "robots" | "keyUrl") {
    try {
      await navigator.clipboard.writeText(value);
      if (target === "robots") {
        setCopiedRobots(true);
        window.setTimeout(() => setCopiedRobots(false), 2000);
      } else {
        setCopiedKeyUrl(true);
        window.setTimeout(() => setCopiedKeyUrl(false), 2000);
      }
    } catch {
      // Clipboard may be restricted in non-HTTPS contexts
    }
  }

  const aiAssistantRow: ChannelMetricRow | undefined = snapshot.channels.find(
    (row) => row.channel === "ai_assistant",
  );

  return (
    <div
      className="space-y-6"
      data-testid="seo-visibility-page"
      data-handle={snapshot.handle}
      data-ai-training-policy={snapshot.aiTrainingPolicy}
    >
      {/* Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
              Visibilitas AI &amp; Pencarian
            </h1>
            <Badge
              variant={snapshot.indexnowEligible ? "success" : "secondary"}
              data-testid="indexnow-status-badge"
            >
              <ZapIcon className="size-3" aria-hidden="true" />
              <span>{snapshot.indexnowStatusBadge}</span>
            </Badge>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Kelola izin crawler pencarian &amp; asisten AI melalui{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              /robots.txt
            </code>
            , pantau status pengiriman otomatis IndexNow, dan lihat atribusi kunjungan dari{" "}
            <strong className="font-medium text-foreground">AI Assistant</strong>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={snapshot.robotsIndexable ? "success" : "warning"}>
            {snapshot.robotsIndexable
              ? `Terindeks · ${snapshot.primaryHost}`
              : snapshot.tenantStatus === "trial"
                ? "Masa Uji Coba (noindex)"
                : "Tidak Terindeks (noindex)"}
          </Badge>
        </div>
      </div>

      {/* Live status feedback */}
      {statusFeedback && (
        <Alert
          variant={statusFeedback.kind === "error" ? "destructive" : "success"}
          role="status"
          aria-live="polite"
          data-testid="seo-status-feedback"
        >
          {statusFeedback.kind === "error" ? (
            <AlertCircleIcon className="size-4" aria-hidden="true" />
          ) : (
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
          )}
          <AlertTitle>
            {statusFeedback.kind === "error"
              ? "Perubahan belum tersimpan"
              : "Pengaturan diperbarui"}
          </AlertTitle>
          <AlertDescription>{statusFeedback.message}</AlertDescription>
        </Alert>
      )}

      {/* Card 1: AI Crawler Controls Toggle Card (DESIGN §9) */}
      <Card data-testid="ai-crawler-controls-card">
        <CardHeader className="border-b border-border">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <BotIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                <span>Kontrol Crawler AI &amp; Mesin Pencari</span>
              </CardTitle>
              <CardDescription>
                PunyaSitus memisahkan bot pencarian &amp; kutipan pengguna (tetap diizinkan agar
                bisnis Anda mudah ditemukan) dari bot pelatihan model AI yang dapat Anda atur
                kapan saja.
              </CardDescription>
            </div>
            <Badge
              variant={trainingAllowed ? "success" : "warning"}
              data-testid="ai-training-policy-badge"
            >
              {trainingAllowed ? "Pelatihan AI: Diizinkan" : "Pelatihan AI: Diblokir"}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Interactive Owner Toggle Row (>= 44px touch target, Base UI Switch) */}
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <label
                htmlFor="ai-training-crawler-switch"
                className="block cursor-pointer text-sm font-semibold text-foreground"
              >
                Izinkan crawler pelatihan model AI
              </label>
              <p id="ai-training-crawler-desc" className="text-xs leading-relaxed text-muted-foreground">
                Mengatur akses bagi 4 crawler pelatihan:{" "}
                <span className="font-mono text-foreground">GPTBot</span>,{" "}
                <span className="font-mono text-foreground">ClaudeBot</span>,{" "}
                <span className="font-mono text-foreground">Google-Extended</span>, dan{" "}
                <span className="font-mono text-foreground">Applebot-Extended</span>. Mematikan
                opsi ini tidak memblokir pencarian Google, Bing, ChatGPT Search, Claude, atau
                Perplexity.
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3 self-start sm:self-center">
              <span
                className="text-xs font-medium text-foreground"
                data-testid="ai-training-toggle-label"
              >
                {savingPolicy
                  ? "Menyimpan..."
                  : trainingAllowed
                    ? "Diizinkan"
                    : "Diblokir"}
              </span>
              <Switch.Root
                id="ai-training-crawler-switch"
                data-testid="ai-training-toggle"
                aria-describedby="ai-training-crawler-desc"
                checked={trainingAllowed}
                disabled={toggleDisabled}
                onCheckedChange={(checked) => {
                  void handleToggleAiTraining(checked);
                }}
                className="group relative inline-flex min-h-11 min-w-14 shrink-0 cursor-pointer items-center justify-center rounded-md p-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex h-7 w-12 items-center rounded-full border border-border bg-border p-0.5 transition-colors group-data-[checked]:border-primary group-data-[checked]:bg-primary"
                >
                  <Switch.Thumb className="block size-5.5 rounded-full bg-card shadow-xs transition-transform group-data-[checked]:translate-x-5" />
                </span>
              </Switch.Root>
            </div>
          </div>

          {!canEditPolicy && (
            <p className="text-xs text-muted-foreground">
              Hanya Pemilik Situs atau Admin yang dapat mengubah kebijakan crawler AI.
            </p>
          )}

          {/* Split Bot Groups */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* 9 Search & Citation Fetchers */}
            <section
              aria-label="Bot pencarian dan kutipan AI"
              className="space-y-3 rounded-lg border border-border bg-card p-4"
              data-testid="search-bots-panel"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">
                  Bot Pencarian &amp; Kutipan AI (9)
                </h2>
                <Badge variant={snapshot.robotsIndexable ? "success" : "warning"}>
                  {snapshot.robotsIndexable ? "Selalu Diizinkan" : "Noindex"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Diizinkan otomatis pada situs berbayar aktif agar katalog dan artikel Anda dapat
                dikutip mesin pencari serta asisten AI saat pengguna bertanya.
              </p>
              <ul className="divide-y divide-border rounded-md border border-border">
                {SEARCH_AND_AI_FETCHER_DESCRIPTORS.map((bot) => (
                  <li
                    key={bot.userAgent}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono font-medium text-foreground">
                        {bot.userAgent}
                      </p>
                      <p className="truncate text-muted-foreground">{bot.descriptionId}</p>
                    </div>
                    <Badge
                      variant={snapshot.robotsIndexable ? "success" : "secondary"}
                      className="shrink-0"
                    >
                      {snapshot.robotsIndexable ? "Allow" : "Noindex"}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>

            {/* 4 Training-Only Crawlers + Crawl Budget Protection */}
            <div className="space-y-4">
              <section
                aria-label="Bot pelatihan model AI"
                className="space-y-3 rounded-lg border border-border bg-card p-4"
                data-testid="training-bots-panel"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-foreground">
                    Bot Pelatihan Model AI (4)
                  </h2>
                  <Badge variant={trainingAllowed && snapshot.robotsIndexable ? "success" : "warning"}>
                    {!snapshot.robotsIndexable
                      ? "Disallow (Noindex)"
                      : trainingAllowed
                        ? "Diizinkan"
                        : "Diblokir"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Mengikuti sakelar di atas. Tidak memengaruhi indeks pencarian utama maupun
                  kutipan langsung pengguna.
                </p>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {AI_TRAINING_CRAWLER_DESCRIPTORS.map((bot) => {
                    const isAllowed = snapshot.robotsIndexable && trainingAllowed;
                    return (
                      <li
                        key={bot.userAgent}
                        className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                        data-training-bot={bot.userAgent}
                      >
                        <div className="min-w-0">
                          <p className="truncate font-mono font-medium text-foreground">
                            {bot.userAgent}
                          </p>
                          <p className="truncate text-muted-foreground">{bot.descriptionId}</p>
                        </div>
                        <Badge
                          variant={isAllowed ? "success" : "destructive"}
                          className="shrink-0"
                        >
                          {isAllowed ? "Allow" : "Disallow"}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* Crawl Budget & Scope Protection */}
              <section
                aria-label="Perlindungan crawl budget"
                className="space-y-2 rounded-lg border border-border bg-muted/30 p-4"
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <ShieldCheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span>Perlindungan Crawl Budget &amp; Kebersihan Indeks</span>
                </div>
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  <li>
                    Filter multi-parameter diblokir otomatis:{" "}
                    {FACETED_FILTER_DISALLOW_PATTERNS.map((p, idx) => (
                      <React.Fragment key={p}>
                        {idx > 0 ? ", " : ""}
                        <code className="rounded bg-card px-1 py-0.5 font-mono text-foreground">
                          {p}
                        </code>
                      </React.Fragment>
                    ))}
                    .
                  </li>
                  <li>
                    Tanggal keberangkatan tur yang sudah lewat disembunyikan otomatis dari HTML
                    publik dan Schema.org JSON-LD.
                  </li>
                  <li>
                    Berkas spekulatif <code className="font-mono">llms.txt</code> sengaja tidak
                    dibuat; mesin pencari &amp; AI membaca HTML semantik dan Schema.org secara
                    langsung.
                  </li>
                </ul>
              </section>
            </div>
          </div>

          {/* Live /robots.txt Preview */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-0.5">
                <h2 className="text-sm font-semibold text-foreground">
                  Pratinjau Langsung <code className="font-mono">/robots.txt</code>
                </h2>
                <p className="text-xs text-muted-foreground">
                  Output persis yang disajikan ke mesin pencari dan crawler AI untuk{" "}
                  <span className="font-mono text-foreground">{snapshot.primaryHost}</span>.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => void copyText(snapshot.robotsTxt, "robots")}
                data-testid="copy-robots-btn"
              >
                {copiedRobots ? (
                  <>
                    <CheckIcon className="size-4" aria-hidden="true" />
                    <span>Tersalin</span>
                  </>
                ) : (
                  <>
                    <CopyIcon className="size-4" aria-hidden="true" />
                    <span>Salin robots.txt</span>
                  </>
                )}
              </Button>
            </div>

            <pre
              data-testid="robots-txt-preview"
              className="max-h-72 overflow-x-auto rounded-lg border border-border bg-foreground/5 p-3.5 font-mono text-xs leading-relaxed text-foreground"
            >
              {snapshot.robotsTxt}
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* Card 2: IndexNow Custom-Domain Ping Status */}
      <Card data-testid="indexnow-status-card">
        <CardHeader className="border-b border-border">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <GlobeIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                <span>Pengindeksan Cepat IndexNow</span>
              </CardTitle>
              <CardDescription>
                Setiap publikasi konten (termasuk melalui asisten AI / MCP yang telah Anda setujui)
                mengirim satu notifikasi terdeduplikasi ke IndexNow untuk domain khusus terverifikasi.
              </CardDescription>
            </div>
            <Badge variant={snapshot.indexnowEligible ? "success" : "secondary"}>
              {snapshot.indexnowStatusBadge}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {snapshot.indexnowEligible ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-md border border-border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">Domain Aktif</p>
                  <p className="mt-1 truncate font-mono text-sm font-semibold text-foreground">
                    {snapshot.primaryHost}
                  </p>
                </div>
                <div className="rounded-md border border-border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">Pengiriman Terakhir</p>
                  <p className="mt-1 text-sm font-semibold text-foreground tabular-nums">
                    {snapshot.indexnowLastPingAtMs
                      ? formatDateTimeWib(snapshot.indexnowLastPingAtMs)
                      : "Menunggu publikasi pertama"}
                  </p>
                </div>
                <div className="rounded-md border border-border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">URL Terkirim Terakhir</p>
                  <p className="mt-1 text-sm font-semibold text-foreground tabular-nums">
                    {formatNumberId(snapshot.indexnowLastUrlCount)} URL
                  </p>
                </div>
              </div>

              {snapshot.indexnowKeyLocation ? (
                <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">URL Berkas Kunci Verifikasi</p>
                    <p
                      className="truncate font-mono text-xs font-medium text-foreground"
                      data-testid="indexnow-key-location"
                    >
                      {snapshot.indexnowKeyLocation}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 shrink-0"
                    onClick={() => void copyText(snapshot.indexnowKeyLocation ?? "", "keyUrl")}
                  >
                    {copiedKeyUrl ? (
                      <>
                        <CheckIcon className="size-4" aria-hidden="true" />
                        <span>Tersalin</span>
                      </>
                    ) : (
                      <>
                        <CopyIcon className="size-4" aria-hidden="true" />
                        <span>Salin URL Kunci</span>
                      </>
                    )}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    Kunci verifikasi IndexNow akan dibuat otomatis pada publikasi berikutnya, atau
                    siapkan sekarang agar berkas <code className="font-mono">/&lt;kunci&gt;.txt</code>{" "}
                    langsung aktif.
                  </p>
                  <Button
                    type="button"
                    className="min-h-11 shrink-0"
                    disabled={toggleDisabled || activatingKey}
                    onClick={() => void handleEnsureIndexNowKey()}
                    data-testid="ensure-indexnow-key-btn"
                  >
                    {activatingKey ? "Menyiapkan..." : "Siapkan Kunci IndexNow"}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <Alert variant="info" data-testid="indexnow-subdomain-notice">
              <InfoIcon className="size-4" aria-hidden="true" />
              <AlertTitle>IndexNow belum aktif di subdomain .{snapshot.saasZone}</AlertTitle>
              <AlertDescription>
                Notifikasi IndexNow otomatis dilewati untuk situs uji coba dan subdomain{" "}
                <code className="font-mono">.{snapshot.saasZone}</code>. Begitu situs berbayar Anda
                menggunakan domain khusus terverifikasi, PunyaSitus otomatis menyajikan berkas kunci
                dan mengirim pembaruan URL terdeduplikasi.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Card 3: Insights — Sumber Kunjungan & Atribusi `AI Assistant` (DESIGN §9) */}
      <Card data-testid="insights-channels-card">
        <CardHeader className="border-b border-border">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <ActivityIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                <span>Insights: Sumber Kunjungan &amp; Saluran AI Assistant</span>
              </CardTitle>
              <CardDescription>
                Memantau kunjungan, klik WhatsApp, dan pesan masuk dari rujukan asisten AI (
                <span className="font-mono">chatgpt.com</span>,{" "}
                <span className="font-mono">claude.ai</span>,{" "}
                <span className="font-mono">perplexity.ai</span>,{" "}
                <span className="font-mono">gemini.google.com</span>,{" "}
                <span className="font-mono">copilot.microsoft.com</span>,{" "}
                <span className="font-mono">utm_medium=ai-assistant</span>).
              </CardDescription>
            </div>
            <Badge variant="info" className="tabular-nums">
              AI Assistant: {formatNumberId(aiAssistantRow?.totalSignals ?? 0)} sinyal
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <Alert variant="info" data-testid="attribution-honest-disclaimer">
            <InfoIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Estimasi sinyal minat pihak pertama</AlertTitle>
            <AlertDescription>
              Angka kunjungan, klik WhatsApp, dan pesan masuk di bawah ini adalah{" "}
              <strong>estimasi sinyal minat pengunjung tanpa cookie</strong>, bukan jaminan
              penjualan, peringkat pencarian, atau sitasi AI.
            </AlertDescription>
          </Alert>

          {/* Desktop Table */}
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Saluran</TableHead>
                  <TableHead className="text-right">Kunjungan</TableHead>
                  <TableHead className="text-right">Klik WhatsApp</TableHead>
                  <TableHead className="text-right">Pesan Masuk</TableHead>
                  <TableHead className="text-right">Porsi</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.channels.map((row) => {
                  const isAi = row.channel === "ai_assistant";
                  return (
                    <TableRow
                      key={row.channel}
                      data-channel={row.channel}
                      data-testid={isAi ? "channel-row-ai-assistant" : `channel-row-${row.channel}`}
                      className={isAi ? "bg-success-soft/40" : undefined}
                    >
                      <TableCell className="font-medium text-foreground">
                        <div className="flex items-center gap-2">
                          <span>{row.label}</span>
                          {isAi && (
                            <Badge variant="success" className="text-[11px]">
                              AI Referral
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumberId(row.visits)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumberId(row.waClicks)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumberId(row.leads)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {formatPercentId(row.sharePercent)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Mobile Card List (Zero Horizontal Overflow at 360px) */}
          <ul className="divide-y divide-border rounded-md border border-border md:hidden">
            {snapshot.channels.map((row) => {
              const isAi = row.channel === "ai_assistant";
              return (
                <li
                  key={row.channel}
                  data-channel-mobile={row.channel}
                  className={isAi ? "space-y-2 bg-success-soft/40 px-3.5 py-3" : "space-y-2 px-3.5 py-3"}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {row.label}
                      </span>
                      {isAi && <Badge variant="success">AI</Badge>}
                    </div>
                    <span className="shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
                      {formatPercentId(row.sharePercent)}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                    <div className="rounded bg-card px-2 py-1.5">
                      <p>Kunjungan</p>
                      <p className="font-semibold text-foreground tabular-nums">
                        {formatNumberId(row.visits)}
                      </p>
                    </div>
                    <div className="rounded bg-card px-2 py-1.5">
                      <p>Klik WA</p>
                      <p className="font-semibold text-foreground tabular-nums">
                        {formatNumberId(row.waClicks)}
                      </p>
                    </div>
                    <div className="rounded bg-card px-2 py-1.5">
                      <p>Pesan</p>
                      <p className="font-semibold text-foreground tabular-nums">
                        {formatNumberId(row.leads)}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

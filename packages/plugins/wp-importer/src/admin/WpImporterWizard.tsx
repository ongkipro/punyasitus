import { useState, type ChangeEvent, type FormEvent } from "react";
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
import {
  WP_IMPORTER_LIMITS,
  type WpImportJobSummary,
  type WpImportReport,
  type WpImportSourceKind,
} from "../types.ts";

/**
 * Official `wp-importer` Admin Wizard & Dry-Run Report UI (`base-nova` style, Bahasa Indonesia)
 * (`TASK-100`, `REQ-100`, `DESIGN.md` §1 & §7).
 *
 * UI invariants:
 * - Built on standard `base-nova` `@/components/ui/*` (`@base-ui/react`) components.
 * - Zero `@radix-ui/*`, zero `asChild`, zero `Sparkles`.
 * - Explicit `htmlFor` + `id` pairing on every form field.
 * - Client-side 5 MB WXR file-size guard before reading file text.
 * - Dynamic status badge derived from real `pluginStatus` prop (never hardcoded).
 * - Mandatory draft-only safety notice ("Semua konten diimpor sebagai Draf — tidak pernah tayang otomatis").
 * - Responsive at 360 px mobile and 1440 px desktop with zero horizontal overflow.
 */

export interface WpImporterWizardProps {
  readonly basePath: string;
  readonly apiBaseUrl: string;
  readonly pluginStatus?: {
    readonly enabled: boolean;
    readonly visibility?: "public_free" | "public_paid" | "private_client";
  };
  readonly initialJobs?: readonly WpImportJobSummary[];
  readonly initialReport?: WpImportReport | null;
  readonly defaultMaxPosts?: number;
  readonly defaultImportImages?: boolean;
  readonly storageQuota?: {
    readonly usedBytes: number;
    readonly quotaBytes: number;
  } | null;
  readonly permissions: {
    readonly roleLabel: string;
    readonly isLocked: boolean;
    readonly canManagePlugins: boolean;
  };
}

function formatBytesId(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateId(iso: string | null): string {
  if (!iso) return "-";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function WpImporterWizard({
  basePath,
  apiBaseUrl,
  pluginStatus = { enabled: true, visibility: "public_free" },
  initialJobs = [],
  initialReport = null,
  defaultMaxPosts = 50,
  defaultImportImages = true,
  storageQuota = null,
  permissions,
}: WpImporterWizardProps) {
  const [sourceKind, setSourceKind] = useState<WpImportSourceKind>("wp_json");
  const [siteUrl, setSiteUrl] = useState("");
  const [wxrXml, setWxrXml] = useState("");
  const [wxrFileName, setWxrFileName] = useState<string | null>(null);
  const [maxPosts, setMaxPosts] = useState(defaultMaxPosts);
  const [importImages, setImportImages] = useState(defaultImportImages);
  const [runningMode, setRunningMode] = useState<"dry_run" | "import" | null>(null);
  const [report, setReport] = useState<WpImportReport | null>(initialReport);
  const [jobs, setJobs] = useState<readonly WpImportJobSummary[]>(initialJobs);
  const [notice, setNotice] = useState<{
    readonly variant: "info" | "success" | "warning" | "destructive";
    readonly title: string;
    readonly description: string;
  } | null>(null);

  const isPluginActive = pluginStatus.enabled;
  const tierLabel =
    pluginStatus.visibility === "public_paid"
      ? "Berbayar"
      : pluginStatus.visibility === "private_client"
        ? "Khusus Klien"
        : "Gratis";
  const canMutate = permissions.canManagePlugins && !permissions.isLocked && isPluginActive;
  const isBusy = runningMode !== null;

  async function handleWxrFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      setWxrFileName(null);
      return;
    }

    // Client-side 5 MB hard guard BEFORE reading file into browser memory
    if (file.size > WP_IMPORTER_LIMITS.maxWxrBytes) {
      event.target.value = "";
      setWxrFileName(null);
      setWxrXml("");
      setNotice({
        variant: "destructive",
        title: "Ukuran berkas WXR melebihi batas 5 MB",
        description: `Berkas "${file.name}" berukuran ${formatBytesId(file.size)}, melebihi batas maksimal ${formatBytesId(WP_IMPORTER_LIMITS.maxWxrBytes)}. Bagi ekspor WordPress berdasarkan tanggal atau kategori.`,
      });
      return;
    }

    setWxrFileName(file.name);
    try {
      const text = await file.text();
      setWxrXml(text);
      setNotice(null);
    } catch {
      setNotice({
        variant: "destructive",
        title: "Gagal membaca berkas WXR",
        description: "Pastikan berkas XML dapat dibaca dan berformat ekspor WordPress WXR.",
      });
    }
  }

  async function runAction(mode: "dry_run" | "import") {
    if (!canMutate || isBusy) return;

    if (sourceKind === "wp_json" && !siteUrl.trim()) {
      setNotice({
        variant: "destructive",
        title: "URL situs WordPress wajib diisi",
        description: "Masukkan alamat situs WordPress publik berawalan https:// terlebih dahulu.",
      });
      return;
    }

    if (sourceKind === "wxr") {
      if (!wxrXml.trim()) {
        setNotice({
          variant: "destructive",
          title: "Berkas WXR XML belum dipilih",
          description: "Unggah berkas ekspor .xml dari WordPress (Alat → Ekspor) atau tempel isi XML.",
        });
        return;
      }
      const xmlBytes = new TextEncoder().encode(wxrXml).byteLength;
      if (xmlBytes > WP_IMPORTER_LIMITS.maxWxrBytes) {
        setNotice({
          variant: "destructive",
          title: "Isi WXR XML melebihi batas 5 MB",
          description: `Payload XML berukuran ${formatBytesId(xmlBytes)}, melebihi batas maksimal ${formatBytesId(WP_IMPORTER_LIMITS.maxWxrBytes)}.`,
        });
        return;
      }
    }

    setRunningMode(mode);
    setNotice(null);

    try {
      const endpoint = mode === "import" ? `${apiBaseUrl}/import` : `${apiBaseUrl}/dry-run`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceKind,
          ...(sourceKind === "wp_json" ? { siteUrl: siteUrl.trim() } : { wxrXml }),
          importImages,
          maxPosts,
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        readonly report?: WpImportReport;
        readonly error?: { readonly code?: string; readonly message?: string };
      };

      if (!response.ok || !data.report) {
        setNotice({
          variant: "destructive",
          title: mode === "import" ? "Impor WordPress ditolak" : "Pratinjau (Dry-Run) gagal",
          description:
            data.error?.message ??
            "Sumber tidak dapat diproses. Periksa kembali URL atau format berkas WXR Anda.",
        });
        return;
      }

      const nextReport = data.report;
      setReport(nextReport);
      setJobs((prev) => [
        {
          id: nextReport.jobId,
          mode: nextReport.mode,
          sourceKind: nextReport.sourceKind,
          sourceLabel: nextReport.sourceLabel,
          status: nextReport.status,
          actorUserId: "current",
          postsFound: nextReport.counts.postsFound,
          postsImported: nextReport.counts.postsImported,
          postsSkipped: nextReport.counts.postsSkipped,
          categoriesImported: nextReport.counts.categoriesImported,
          tagsImported: nextReport.counts.tagsImported,
          imagesImported: nextReport.counts.imagesImported,
          imagesSkipped: nextReport.counts.imagesSkipped + nextReport.counts.imagesBlocked,
          bytesImported: nextReport.counts.bytesImported,
          errorCode: null,
          errorMessage: null,
          createdAt: nextReport.createdAt,
          completedAt: nextReport.completedAt,
        },
        ...prev.filter((j) => j.id !== nextReport.jobId),
      ]);

      if (mode === "dry_run") {
        setNotice({
          variant: nextReport.warnings.length > 0 ? "warning" : "info",
          title: "Pratinjau (Dry-Run) selesai",
          description: `Ditemukan ${nextReport.counts.postsFound} artikel, ${nextReport.counts.categoriesFound} kategori, dan ${nextReport.counts.imagesFound} gambar. Belum ada artikel yang disimpan — tinjau laporan di bawah lalu klik Konfirmasi Impor sebagai Draf.`,
        });
      } else {
        setNotice({
          variant: nextReport.warnings.length > 0 ? "warning" : "success",
          title: `${nextReport.counts.postsImported} artikel berhasil diimpor sebagai Draf`,
          description:
            "Semua konten disimpan sebagai Draf (belum tayang). Periksa hasil sanitasi, gambar WebP, dan inventaris URL lama sebelum menerbitkan artikel.",
        });
      }
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description:
          "Permintaan impor belum selesai. Masukan formulir Anda tetap dipertahankan; silakan coba lagi.",
      });
    } finally {
      setRunningMode(null);
    }
  }

  function handleDryRunSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runAction("dry_run");
  }

  const usedPercent =
    storageQuota && storageQuota.quotaBytes > 0
      ? Math.min(100, Math.round((storageQuota.usedBytes / storageQuota.quotaBytes) * 100))
      : null;

  return (
    <section
      className="min-w-0 max-w-full space-y-6"
      data-testid="wp-importer-wizard"
      aria-labelledby="wp-importer-heading"
    >
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 px-2 md:min-h-8"
          render={<a href={`${basePath}/plugins`} />}
        >
          <span aria-hidden="true">←</span>
          Kembali ke daftar Plugin
        </Button>

        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={isPluginActive ? "success" : "outline"}
            data-testid="wp-importer-status-badge"
          >
            {tierLabel} · {isPluginActive ? "Aktif" : "Nonaktif"}
          </Badge>
          <Badge variant="outline" className="font-mono text-xs text-muted-foreground">
            plg_wp_importer__*
          </Badge>
        </div>
      </div>

      {/* Header */}
      <div className="space-y-1">
        <h1
          id="wp-importer-heading"
          className="text-xl font-semibold tracking-tight text-foreground"
        >
          Impor Konten WordPress
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Pindahkan artikel blog, kategori, tag, metadata SEO, dan gambar dari situs WordPress lama
          Anda melalui REST API <code className="font-mono text-xs">/wp-json</code> atau berkas
          ekspor WXR XML.
        </p>
      </div>

      {/* Mandatory Draft-Only Safety Banner */}
      <Alert variant="info" data-testid="wp-importer-draft-only-banner">
        <AlertTitle>Semua konten diimpor sebagai Draf — tidak pernah tayang otomatis</AlertTitle>
        <AlertDescription className="text-xs">
          Artikel yang sudah berstatus <em>Published</em> di WordPress tetap disimpan sebagai{" "}
          <strong>Draf</strong> di PunyaSitus agar Anda dapat meninjau tata letak, sanitasi HTML,
          gambar WebP, dan daftar pengalihan URL lama sebelum menayangkannya.
        </AlertDescription>
      </Alert>

      {/* Lifecycle / RBAC / Disabled Guardrails */}
      {!isPluginActive ? (
        <Alert variant="warning">
          <AlertTitle>Plugin sedang nonaktif</AlertTitle>
          <AlertDescription className="text-xs">
            Aktifkan kembali plugin WordPress Importer di halaman Plugin untuk menjalankan pratinjau
            atau impor baru. Riwayat impor lama tetap tersimpan aman.
          </AlertDescription>
        </Alert>
      ) : permissions.isLocked ? (
        <Alert variant="warning">
          <AlertTitle>Langganan terkunci (Mode hanya-baca)</AlertTitle>
          <AlertDescription className="text-xs">
            Perpanjang langganan terlebih dahulu untuk menjalankan pratinjau atau impor WordPress.
          </AlertDescription>
        </Alert>
      ) : !permissions.canManagePlugins ? (
        <Alert variant="info">
          <AlertTitle>Mode lihat saja ({permissions.roleLabel})</AlertTitle>
          <AlertDescription className="text-xs">
            Hubungi Pemilik Situs atau Admin untuk menjalankan impor artikel WordPress.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Dynamic Notice */}
      {notice ? (
        <Alert variant={notice.variant} data-testid="wp-importer-notice">
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription className="text-xs">{notice.description}</AlertDescription>
        </Alert>
      ) : null}

      {/* Step 1: Source Selection & Configuration */}
      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader className="border-b border-border">
            <CardTitle>Langkah 1 — Pilih Sumber WordPress</CardTitle>
            <CardDescription className="text-xs">
              Jalankan Pratinjau (Dry-Run) terlebih dahulu untuk memeriksa jumlah artikel, media,
              dan URL lama sebelum menulis ke situs Anda.
            </CardDescription>
          </CardHeader>

          <form onSubmit={handleDryRunSubmit}>
            <CardContent className="space-y-5">
              {/* Source Mode Switcher */}
              <div
                role="tablist"
                aria-label="Sumber impor WordPress"
                className="grid grid-cols-1 gap-2 sm:grid-cols-2"
              >
                <button
                  type="button"
                  role="tab"
                  id="wp-tab-json"
                  aria-selected={sourceKind === "wp_json"}
                  onClick={() => setSourceKind("wp_json")}
                  className={
                    sourceKind === "wp_json"
                      ? "min-h-11 rounded-md border border-primary bg-primary/10 px-3.5 py-2.5 text-left text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      : "min-h-11 rounded-md border border-border bg-card px-3.5 py-2.5 text-left text-sm font-medium text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  }
                >
                  <span className="block font-semibold text-foreground">URL WordPress (/wp-json)</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Tarik langsung dari situs WordPress publik via HTTPS
                  </span>
                </button>

                <button
                  type="button"
                  role="tab"
                  id="wp-tab-wxr"
                  aria-selected={sourceKind === "wxr"}
                  onClick={() => setSourceKind("wxr")}
                  className={
                    sourceKind === "wxr"
                      ? "min-h-11 rounded-md border border-primary bg-primary/10 px-3.5 py-2.5 text-left text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      : "min-h-11 rounded-md border border-border bg-card px-3.5 py-2.5 text-left text-sm font-medium text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  }
                >
                  <span className="block font-semibold text-foreground">Unggah File WXR XML</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Gunakan file ekspor XML dari WP Admin → Alat → Ekspor
                  </span>
                </button>
              </div>

              {sourceKind === "wp_json" ? (
                <div className="space-y-1.5">
                  <label htmlFor="wp-site-url" className="block text-sm font-medium text-foreground">
                    Alamat Situs WordPress Publik (HTTPS)
                  </label>
                  <Input
                    id="wp-site-url"
                    name="siteUrl"
                    type="url"
                    inputMode="url"
                    placeholder="https://blog.bisnisanda.co.id"
                    value={siteUrl}
                    disabled={!canMutate || isBusy}
                    onChange={(e) => setSiteUrl(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Otomatis membaca <code className="font-mono">/wp-json/wp/v2/posts</code>. Alamat
                    IP privat, localhost, dan metadata internal otomatis diblokir (SSRF Guard).
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="wp-wxr-file"
                      className="block text-sm font-medium text-foreground"
                    >
                      Unggah Berkas WXR (.xml, maks. 5 MB)
                    </label>
                    <input
                      id="wp-wxr-file"
                      name="wxrFile"
                      type="file"
                      accept=".xml,application/xml,text/xml"
                      disabled={!canMutate || isBusy}
                      onChange={(e) => void handleWxrFileChange(e)}
                      className="block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-secondary-foreground disabled:opacity-50"
                    />
                    {wxrFileName ? (
                      <p className="text-xs text-muted-foreground">
                        Berkas dipilih:{" "}
                        <span className="font-mono text-foreground">{wxrFileName}</span>
                      </p>
                    ) : null}
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="wp-wxr-paste"
                      className="block text-sm font-medium text-foreground"
                    >
                      Atau Tempel Isi WXR XML
                    </label>
                    <textarea
                      id="wp-wxr-paste"
                      name="wxrXml"
                      rows={5}
                      placeholder='<?xml version="1.0" encoding="UTF-8"?><rss version="2.0">...</rss>'
                      value={wxrXml}
                      disabled={!canMutate || isBusy}
                      onChange={(e) => setWxrXml(e.target.value)}
                      className="w-full rounded-md border border-input bg-card p-3 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
                    />
                    <p className="text-xs text-muted-foreground">
                      Deklarasi <code className="font-mono">DOCTYPE</code> /{" "}
                      <code className="font-mono">ENTITY</code> (XXE &amp; XML bomb) otomatis
                      ditolak.
                    </p>
                  </div>
                </div>
              )}

              {/* Shared Options */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="wp-max-posts" className="block text-sm font-medium text-foreground">
                    Batas Artikel per Sesi (1–100)
                  </label>
                  <Input
                    id="wp-max-posts"
                    name="maxPosts"
                    type="number"
                    min={1}
                    max={100}
                    value={maxPosts}
                    disabled={!canMutate || isBusy}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setMaxPosts(
                        Number.isFinite(n) ? Math.min(100, Math.max(1, Math.trunc(n))) : 50,
                      );
                    }}
                  />
                </div>

                <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
                  <div className="space-y-0.5">
                    <label
                      htmlFor="wp-import-images"
                      className="block text-sm font-medium text-foreground"
                    >
                      Impor &amp; Konversi Gambar ke WebP
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Hanya JPEG/PNG/WebP/GIF valid. SVG &amp; file berbahaya ditolak.
                    </p>
                  </div>
                  <input
                    id="wp-import-images"
                    name="importImages"
                    type="checkbox"
                    checked={importImages}
                    disabled={!canMutate || isBusy}
                    onChange={(e) => setImportImages(e.target.checked)}
                    className="mt-1 size-4 shrink-0 accent-primary"
                  />
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
                <Button
                  type="submit"
                  variant="outline"
                  data-testid="wp-importer-dry-run-btn"
                  disabled={!canMutate || isBusy}
                  className="min-h-11 md:min-h-9"
                >
                  {runningMode === "dry_run" ? "Menganalisis..." : "Pratinjau (Dry-Run)"}
                </Button>

                <Button
                  type="button"
                  variant="default"
                  data-testid="wp-importer-execute-btn"
                  disabled={!canMutate || isBusy}
                  onClick={() => void runAction("import")}
                  className="min-h-11 md:min-h-9"
                >
                  {runningMode === "import"
                    ? "Mengimpor ke Draf..."
                    : "Konfirmasi Impor sebagai Draf"}
                </Button>
              </div>
            </CardContent>
          </form>
        </Card>

        {/* Security & Quota Guardrails Card */}
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-sm">Keamanan &amp; Kuota Media</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-2.5 text-xs text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="mt-0.5 font-semibold text-success" aria-hidden="true">
                  ✓
                </span>
                <span>
                  <strong className="text-foreground">Wajib Draf:</strong> Tidak ada artikel yang
                  ditayangkan otomatis tanpa tinjauan manusia.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 font-semibold text-success" aria-hidden="true">
                  ✓
                </span>
                <span>
                  <strong className="text-foreground">SSRF &amp; Redirect Guard:</strong> IP privat,
                  loopback, domain wildcard lokal, dan metadata cloud diblokir pada setiap lompatan
                  redirect.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 font-semibold text-success" aria-hidden="true">
                  ✓
                </span>
                <span>
                  <strong className="text-foreground">Sanitasi TipTap JSON:</strong> Tag{" "}
                  <code className="font-mono">&lt;script&gt;</code>,{" "}
                  <code className="font-mono">&lt;iframe&gt;</code>, event handler{" "}
                  <code className="font-mono">on*</code>, dan tautan{" "}
                  <code className="font-mono">javascript:</code> dibersihkan total.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 font-semibold text-success" aria-hidden="true">
                  ✓
                </span>
                <span>
                  <strong className="text-foreground">Verifikasi Magic-Byte WebP:</strong> Menolak
                  SVG, HTML, PHP, executable, dan trailing polyglot/EXIF.
                </span>
              </li>
            </ul>

            {storageQuota ? (
              <div className="space-y-1.5 border-t border-border pt-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Kuota Penyimpanan Situs</span>
                  <span className="font-mono font-medium text-foreground">
                    {formatBytesId(storageQuota.usedBytes)} /{" "}
                    {formatBytesId(storageQuota.quotaBytes)}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${usedPercent ?? 0}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Impor gambar akan berhenti aman jika sisa kuota penyimpanan tidak mencukupi.
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* Step 2: Dry-Run / Import Summary Report */}
      {report ? (
        <Card data-testid="wp-importer-report" className="min-w-0 max-w-full">
          <CardHeader className="border-b border-border">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 max-w-full space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>
                    {report.mode === "dry_run"
                      ? "Laporan Pratinjau (Dry-Run)"
                      : "Laporan Hasil Impor Draf"}
                  </CardTitle>
                  <Badge variant="info">Status: Draf Saja</Badge>
                </div>
                <p className="break-all text-xs text-muted-foreground">
                  Sumber: <span className="font-mono text-foreground">{report.sourceLabel}</span> ·
                  ID Sesi: <span className="font-mono">{report.jobId}</span>
                </p>
              </div>

              {report.mode === "import" ? (
                <Button
                  size="sm"
                  className="min-h-11 md:min-h-8"
                  render={<a href={`${basePath}/posts`} />}
                >
                  Buka Daftar Artikel Draf
                </Button>
              ) : null}
            </div>
          </CardHeader>

          <CardContent className="space-y-5">
            {/* KPI Summary Grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">
                  {report.mode === "dry_run" ? "Artikel Ditemukan" : "Draf Diimpor"}
                </p>
                <p className="mt-1 text-xl font-semibold text-foreground">
                  {report.mode === "dry_run"
                    ? report.counts.postsFound
                    : report.counts.postsImported}
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">Kategori &amp; Tag</p>
                <p className="mt-1 text-xl font-semibold text-foreground">
                  {report.counts.categoriesFound + report.counts.tagsFound}
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">
                  {report.mode === "dry_run" ? "Gambar Siap WebP" : "Gambar WebP Disimpan"}
                </p>
                <p className="mt-1 text-xl font-semibold text-foreground">
                  {report.mode === "dry_run"
                    ? report.media.filter((m) => m.status === "dry_run_valid").length
                    : report.counts.imagesImported}
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">Dilewati / Diblokir</p>
                <p className="mt-1 text-xl font-semibold text-foreground">
                  {report.counts.postsSkipped +
                    report.counts.imagesSkipped +
                    report.counts.imagesBlocked}
                </p>
              </div>
            </div>

            {/* Warnings / Blocked Items */}
            {report.warnings.length > 0 ? (
              <Alert variant="warning" data-testid="wp-importer-warnings">
                <AlertTitle>
                  Peringatan &amp; Item yang Diblokir ({report.warnings.length})
                </AlertTitle>
                <AlertDescription className="text-xs">
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {report.warnings.map((w, idx) => (
                      <li key={`${w.code}-${idx}`} className="break-words">
                        <span className="font-mono font-semibold">[{w.code}]</span> {w.message}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {/* Posts Preview Table */}
            {report.posts.length > 0 ? (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">
                  Daftar Artikel ({report.posts.length})
                </h3>
                <div className="rounded-md border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Judul Artikel</TableHead>
                        <TableHead>Status Asal → Tujuan</TableHead>
                        <TableHead>Kategori / SEO</TableHead>
                        <TableHead>Gambar</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.posts.map((post) => (
                        <TableRow key={post.sourceId}>
                          <TableCell>
                            <p className="font-medium text-foreground">{post.title}</p>
                            <p className="font-mono text-xs text-muted-foreground">
                              /blog/{post.targetSlug}
                            </p>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs">
                            <span className="font-mono text-muted-foreground">
                              {post.sourceStatus}
                            </span>
                            <span className="mx-1.5 text-muted-foreground" aria-hidden="true">
                              →
                            </span>
                            <Badge variant="info">Draf (Belum Tayang)</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            <div>
                              {post.categories.length > 0
                                ? post.categories.join(", ")
                                : "Tanpa kategori"}
                            </div>
                            {post.hasSeoMeta ? (
                              <span className="mt-0.5 inline-block text-success">
                                SEO Meta tersalin
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-xs">
                            {report.mode === "import"
                              ? `${post.importedImageCount}/${post.imageCount}`
                              : `${post.imageCount} gambar`}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : null}

            {/* Former-URL Inventory Table */}
            {report.formerUrls.length > 0 ? (
              <div className="space-y-2" data-testid="wp-importer-url-map">
                <h3 className="text-sm font-semibold text-foreground">
                  Inventaris URL Lama (Untuk Review Pengalihan 301/308)
                </h3>
                <div className="rounded-md border border-border">
                  <Table className="text-xs">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Path WordPress Lama</TableHead>
                        <TableHead>Path Draf PunyaSitus</TableHead>
                        <TableHead>Status Impor</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="font-mono">
                      {report.formerUrls.map((row, idx) => (
                        <TableRow key={`${row.sourcePath}-${idx}`}>
                          <TableCell className="break-all text-xs text-muted-foreground">
                            {row.sourcePath}
                          </TableCell>
                          <TableCell className="break-all text-xs">{row.targetPath}</TableCell>
                          <TableCell className="whitespace-nowrap font-sans">
                            <Badge variant="secondary">Draf</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Step 3: Job History (`plg_wp_importer__jobs`) */}
      <Card data-testid="wp-importer-job-history" className="min-w-0 max-w-full">
        <CardHeader className="border-b border-border">
          <CardTitle>Riwayat Impor WordPress</CardTitle>
          <CardDescription className="break-words text-xs">
            Tersimpan terisolasi pada tabel <code className="font-mono">plg_wp_importer__jobs</code>{" "}
            situs ini.
          </CardDescription>
        </CardHeader>

        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Belum ada riwayat impor. Mulai dengan menjalankan Pratinjau (Dry-Run) di atas.
            </p>
          ) : (
            <div className="rounded-md border border-border">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Waktu</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Sumber</TableHead>
                    <TableHead>Artikel (Draf)</TableHead>
                    <TableHead>Gambar WebP</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateId(job.createdAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs font-medium">
                        {job.mode === "dry_run" ? "Dry-Run" : "Impor Draf"}
                      </TableCell>
                      <TableCell className="break-all font-mono text-xs text-muted-foreground">
                        {job.sourceLabel}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {job.mode === "dry_run"
                          ? `${job.postsFound} ditemukan`
                          : `${job.postsImported}/${job.postsFound}`}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {job.imagesImported} ({formatBytesId(job.bytesImported)})
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Badge
                          variant={
                            job.status === "completed"
                              ? "success"
                              : job.status === "completed_with_warnings"
                                ? "warning"
                                : job.status === "running"
                                  ? "info"
                                  : "destructive"
                          }
                        >
                          {job.status === "completed"
                            ? "Selesai"
                            : job.status === "completed_with_warnings"
                              ? "Selesai (Ada Peringatan)"
                              : job.status === "running"
                                ? "Berjalan"
                                : "Gagal"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

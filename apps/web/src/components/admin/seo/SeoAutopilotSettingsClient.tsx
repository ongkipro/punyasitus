import { useMemo, useState, type KeyboardEvent } from "react";
import {
  renderSearchAppearanceTemplate,
  SEARCH_APPEARANCE_KINDS,
  SEARCH_APPEARANCE_SEPARATORS,
  SEARCH_APPEARANCE_TOKEN_PLACEHOLDERS,
  validateSearchAppearanceTemplateString,
  validateVerificationToken,
  VERIFICATION_PROVIDERS,
  type ProviderVerificationStatusView,
  type SearchAppearanceKind,
  type SearchAppearanceSeparator,
  type SearchAppearanceSettings,
  type VerificationProvider,
  type VerificationTokensConfig,
} from "@punyasitus/core/seo/editor";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  ArrowLeftIcon,
  Building2Icon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  InfoIcon,
  LockIcon,
  SaveIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react";
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

/**
 * Dedicated Settings Workspace for `/dashboard/[handle]/plugins/seo-ai-autopilot`
 * (`TASK-052`, `REQ-053`, `REQ-055`, `PLAN §15.5 & §15.7`, `DESIGN.md §8`).
 *
 * Tabs:
 * 1. Tampilan Pencarian (Search Appearance Templates + fixed 7-token grammar + live preview)
 * 2. Verifikasi Webmaster (Google / Bing / Yandex tokens + configured-vs-externally-verified + domain change recheck)
 * 3. Direktori Bisnis (1-click Google Business Profile & Bing Places factual copy card)
 */

export interface SeoAutopilotSettingsInitialData {
  readonly tenantId: string;
  readonly handle: string;
  readonly siteName: string;
  readonly tagline: string | null;
  readonly primaryHost: string;
  readonly primaryOrigin: string;
  readonly tenantStatus: string;
  readonly siteVisibility: "public" | "noindex";
  readonly aiTrainingPolicy: "allow" | "disallow";
  readonly seoAutopilotEnabled: boolean;
  readonly draft: {
    readonly searchAppearance: SearchAppearanceSettings;
    readonly verificationTokens: VerificationTokensConfig;
  };
  readonly hasUnpublishedChanges: boolean;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly verificationStatuses: readonly ProviderVerificationStatusView[];
  readonly sitemapUrl: string;
  readonly directoryListingCopyText: string;
}

export interface SeoAutopilotSettingsClientProps {
  readonly basePath: string;
  readonly apiBaseUrl: string;
  readonly initialSettings: SeoAutopilotSettingsInitialData;
  readonly permissions: {
    readonly roleLabel: string;
    readonly isLocked: boolean;
    readonly canManageSettings: boolean;
  };
}

type SettingsTabId = "appearance" | "verification" | "directory";

const SETTINGS_TABS: ReadonlyArray<{ readonly id: SettingsTabId; readonly label: string }> = [
  { id: "appearance", label: "Tampilan Pencarian" },
  { id: "verification", label: "Verifikasi Webmaster" },
  { id: "directory", label: "Profil Direktori (GBP & Bing)" },
];

const KIND_LABELS: Readonly<
  Record<SearchAppearanceKind, { readonly label: string; readonly sampleTitle: string }>
> = {
  homepage: { label: "Beranda (Homepage)", sampleTitle: "Beranda" },
  page: { label: "Halaman Statis", sampleTitle: "Tentang Kami" },
  post: { label: "Artikel Blog", sampleTitle: "Panduan Perawatan Berkala" },
  catalog_item: { label: "Detail Katalog (Layanan/Produk/Tur/Kendaraan)", sampleTitle: "Paket Layanan Utama" },
  post_category: { label: "Arsip Kategori Artikel", sampleTitle: "Tips & Panduan" },
  post_tag: { label: "Arsip Tag Artikel", sampleTitle: "perawatan" },
  catalog_category: { label: "Arsip Kategori Katalog", sampleTitle: "Layanan Unggulan" },
  blog_index: { label: "Indeks Blog (/blog)", sampleTitle: "Blog" },
  catalog_index: { label: "Indeks Katalog", sampleTitle: "Katalog" },
};

function verificationStatusBadgeVariant(
  status: ProviderVerificationStatusView["status"],
): "secondary" | "warning" | "success" | "outline" {
  switch (status) {
    case "externally_verified":
      return "success";
    case "recheck_required":
      return "warning";
    case "configured":
      return "secondary";
    default:
      return "outline";
  }
}

export function SeoAutopilotSettingsClient({
  basePath,
  apiBaseUrl,
  initialSettings,
  permissions,
}: SeoAutopilotSettingsClientProps) {
  const [settings, setSettings] = useState<SeoAutopilotSettingsInitialData>(initialSettings);
  const [activeTab, setActiveTab] = useState<SettingsTabId>("appearance");
  const [enabled, setEnabled] = useState(initialSettings.seoAutopilotEnabled);
  const [separator, setSeparator] = useState<SearchAppearanceSeparator>(
    initialSettings.draft.searchAppearance.separator,
  );
  const [templates, setTemplates] = useState(initialSettings.draft.searchAppearance.templates);
  const [tokens, setTokens] = useState<VerificationTokensConfig>(
    initialSettings.draft.verificationTokens,
  );
  const [checkNotes, setCheckNotes] = useState<Record<VerificationProvider, string>>({
    google: "",
    bing: "",
    yandex: "",
  });

  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [copiedDirectory, setCopiedDirectory] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    readonly variant: "success" | "destructive" | "info";
    readonly title: string;
    readonly description: string;
  } | null>(null);

  const readOnly = permissions.isLocked || !permissions.canManageSettings;

  // Live validation across templates & verification tokens
  const localValidationErrors = useMemo(() => {
    const errs: Record<string, string> = {};
    for (const kind of SEARCH_APPEARANCE_KINDS) {
      const pair = templates[kind];
      const tCheck = validateSearchAppearanceTemplateString(pair.titleTemplate);
      if (!tCheck.ok) {
        errs[`templates.${kind}.titleTemplate`] = tCheck.issue.message;
      } else if (!pair.titleTemplate.trim()) {
        errs[`templates.${kind}.titleTemplate`] = "Template judul tidak boleh kosong.";
      }
      const dCheck = validateSearchAppearanceTemplateString(pair.descriptionTemplate);
      if (!dCheck.ok) {
        errs[`templates.${kind}.descriptionTemplate`] = dCheck.issue.message;
      } else if (!pair.descriptionTemplate.trim()) {
        errs[`templates.${kind}.descriptionTemplate`] = "Template deskripsi tidak boleh kosong.";
      }
    }
    for (const provider of VERIFICATION_PROVIDERS) {
      const vCheck = validateVerificationToken(provider, tokens[provider]);
      if (!vCheck.ok) {
        errs[`verification.${provider}`] = vCheck.message;
      }
    }
    return errs;
  }, [templates, tokens]);

  const combinedErrors = { ...fieldErrors, ...localValidationErrors };
  const hasLocalErrors = Object.keys(localValidationErrors).length > 0;

  function applySettingsPayload(next: SeoAutopilotSettingsInitialData) {
    setSettings(next);
    setEnabled(next.seoAutopilotEnabled);
    setSeparator(next.draft.searchAppearance.separator);
    setTemplates(next.draft.searchAppearance.templates);
    setTokens(next.draft.verificationTokens);
  }

  async function handleTogglePlugin() {
    if (readOnly || toggling) return;
    setToggling(true);
    setNotice(null);
    try {
      const res = await fetch(`${apiBaseUrl}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ enabled: !enabled }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly enabled?: boolean;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || typeof data.enabled !== "boolean") {
        setNotice({
          variant: "destructive",
          title: "Gagal mengubah status plugin",
          description: data.error?.message ?? "Terjadi kendala saat memperbarui status plugin.",
        });
        return;
      }
      setEnabled(data.enabled);
      setNotice({
        variant: data.enabled ? "success" : "info",
        title: data.enabled ? "SEO & AI Autopilot diaktifkan" : "SEO & AI Autopilot dinonaktifkan",
        description: data.enabled
          ? "Drawer SEO opsional pada editor dan metadata otomatis kembali aktif."
          : "Editor konten kini tampil tanpa field SEO. Seluruh template & token tetap tersimpan aman jika diaktifkan kembali.",
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Perubahan status belum tersimpan. Silakan coba kembali.",
      });
    } finally {
      setToggling(false);
    }
  }

  async function handleSaveDraft(): Promise<SeoAutopilotSettingsInitialData | null> {
    if (readOnly || busy) return null;
    if (hasLocalErrors) {
      setNotice({
        variant: "destructive",
        title: "Periksa masukan Anda",
        description: "Masih ada template atau token verifikasi yang tidak valid.",
      });
      return null;
    }

    setBusy(true);
    setConflictMessage(null);
    setFieldErrors({});
    setNotice(null);

    try {
      const res = await fetch(`${apiBaseUrl}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          separator,
          templates,
          verification: tokens,
          version: settings.version,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly settings?: SeoAutopilotSettingsInitialData;
        readonly error?: {
          readonly code?: string;
          readonly message?: string;
          readonly fields?: ReadonlyArray<{ readonly field: string; readonly message: string }>;
        };
      };
      if (!res.ok || !data.settings) {
        if (res.status === 409) {
          setConflictMessage(
            data.error?.message ??
              "Pengaturan SEO telah diperbarui oleh sesi lain. Muat ulang halaman sebelum menyimpan.",
          );
          return null;
        }
        const nextFieldErrors: Record<string, string> = {};
        for (const f of data.error?.fields ?? []) {
          nextFieldErrors[f.field] = f.message;
        }
        setFieldErrors(nextFieldErrors);
        setNotice({
          variant: "destructive",
          title: "Gagal menyimpan draf SEO",
          description: data.error?.message ?? "Periksa kembali isian Anda.",
        });
        return null;
      }

      applySettingsPayload(data.settings);
      setNotice({
        variant: "success",
        title: "Draf pengaturan SEO tersimpan",
        description: `Tersimpan pada versi v${data.settings.version}. Terbitkan agar aktif di situs publik.`,
      });
      return data.settings;
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Masukan formulir Anda tetap dipertahankan. Silakan coba simpan kembali.",
      });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handlePublish() {
    if (readOnly || busy) return;
    if (hasLocalErrors) {
      setNotice({
        variant: "destructive",
        title: "Tidak dapat menerbitkan",
        description: "Perbaiki kesalahan validasi pada template atau token terlebih dahulu.",
      });
      return;
    }

    const saved = await handleSaveDraft();
    if (!saved) return;
    const versionToPublish = saved.version;

    setBusy(true);
    setConflictMessage(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiBaseUrl}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ version: versionToPublish }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly settings?: SeoAutopilotSettingsInitialData;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.settings) {
        if (res.status === 409) {
          setConflictMessage(
            data.error?.message ?? "Konflik versi saat menerbitkan pengaturan SEO.",
          );
          return;
        }
        setNotice({
          variant: "destructive",
          title: "Gagal menerbitkan pengaturan SEO",
          description: data.error?.message ?? "Silakan coba lagi.",
        });
        return;
      }
      applySettingsPayload(data.settings);
      setNotice({
        variant: "success",
        title: "Pengaturan SEO berhasil diterbitkan",
        description: `Template dan tag verifikasi kini aktif untuk ${data.settings.primaryHost} (v${data.settings.version}).`,
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Publikasi tertunda. Silakan coba lagi.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleRecordExternalVerification(provider: VerificationProvider) {
    if (readOnly || busy) return;
    setBusy(true);
    setConflictMessage(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiBaseUrl}/verification-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          provider,
          verifiedHost: settings.primaryHost,
          note: checkNotes[provider].trim() || null,
          version: settings.version,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly settings?: SeoAutopilotSettingsInitialData;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.settings) {
        if (res.status === 409) {
          setConflictMessage(data.error?.message ?? "Konflik versi. Muat ulang halaman.");
          return;
        }
        setNotice({
          variant: "destructive",
          title: "Gagal mencatat verifikasi eksternal",
          description: data.error?.message ?? "Pastikan token sudah diterbitkan terlebih dahulu.",
        });
        return;
      }
      applySettingsPayload(data.settings);
      setCheckNotes((prev) => ({ ...prev, [provider]: "" }));
      setNotice({
        variant: "success",
        title: "Verifikasi eksternal tercatat",
        description: `Verifikasi manual untuk ${settings.primaryHost} telah dicatat pada log aktivitas.`,
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Catatan verifikasi belum tersimpan. Coba lagi.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyDirectory() {
    try {
      await navigator.clipboard.writeText(settings.directoryListingCopyText);
      setCopiedDirectory(true);
      window.setTimeout(() => setCopiedDirectory(false), 2000);
    } catch {
      // ignore restricted clipboard
    }
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const next = SETTINGS_TABS[(currentIndex + 1) % SETTINGS_TABS.length];
      if (next) {
        setActiveTab(next.id);
        document.getElementById(`seo-settings-tab-btn-${next.id}`)?.focus();
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      const prev =
        SETTINGS_TABS[(currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length];
      if (prev) {
        setActiveTab(prev.id);
        document.getElementById(`seo-settings-tab-btn-${prev.id}`)?.focus();
      }
    }
  }

  return (
    <section
      className="space-y-6"
      data-testid="seo-autopilot-settings-page"
      data-plugin-enabled={enabled ? "true" : "false"}
      aria-labelledby="seo-autopilot-heading"
    >
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 px-2 md:min-h-8"
          render={<a href={`${basePath}/plugins`} />}
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          Kembali ke daftar Plugin
        </Button>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={enabled ? "success" : "outline"} data-testid="seo-plugin-status-badge">
            {enabled ? "Aktif" : "Nonaktif"}
          </Badge>
          <Button
            type="button"
            variant={enabled ? "outline" : "default"}
            size="sm"
            className="min-h-11 md:min-h-8"
            disabled={readOnly || toggling}
            onClick={() => void handleTogglePlugin()}
            data-testid="seo-plugin-toggle-btn"
          >
            {toggling
              ? "Memproses..."
              : enabled
                ? "Nonaktifkan Plugin"
                : "Aktifkan Kembali"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-8"
            render={<a href={`${basePath}/seo`} />}
          >
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            Crawler AI &amp; IndexNow
          </Button>
        </div>
      </div>

      {/* Heading */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <SearchIcon className="size-5 text-primary" aria-hidden="true" />
          <h1
            id="seo-autopilot-heading"
            className="text-xl font-semibold tracking-tight text-foreground"
          >
            SEO &amp; AI Autopilot
          </h1>
          <Badge variant="outline" className="font-mono text-xs">
            Gratis · v1.0.0
          </Badge>
          {settings.hasUnpublishedChanges && (
            <Badge variant="warning" data-testid="seo-unpublished-badge">
              Ada perubahan draf belum terbit
            </Badge>
          )}
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Berjalan otomatis tanpa konfigurasi wajib untuk domain utama{" "}
          <span className="font-mono text-foreground">{settings.primaryHost}</span>. Gunakan
          pengaturan di bawah jika ingin menyesuaikan template judul, verifikasi webmaster, atau
          menyalin data direktori bisnis.
        </p>
      </div>

      {/* Guardrail alerts */}
      {permissions.isLocked ? (
        <Alert variant="warning" data-testid="seo-settings-locked-banner">
          <LockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Langganan terkunci (Mode hanya-baca)</AlertTitle>
          <AlertDescription>
            Perpanjang langganan untuk menyimpan atau menerbitkan perubahan pengaturan SEO.
          </AlertDescription>
        </Alert>
      ) : !permissions.canManageSettings ? (
        <Alert variant="info" data-testid="seo-settings-readonly-banner">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode lihat saja ({permissions.roleLabel})</AlertTitle>
          <AlertDescription>
            Hanya Pemilik Situs atau Admin yang dapat mengubah template tampilan pencarian dan token
            verifikasi webmaster. Editor tetap dapat mengatur SEO per halaman/artikel.
          </AlertDescription>
        </Alert>
      ) : null}

      {conflictMessage && (
        <Alert variant="destructive" role="alert" data-testid="seo-settings-conflict-banner">
          <AlertTriangleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Konflik versi terdeteksi</AlertTitle>
          <AlertDescription>{conflictMessage}</AlertDescription>
        </Alert>
      )}

      {notice && (
        <Alert
          variant={notice.variant}
          role="status"
          aria-live="polite"
          data-testid="seo-settings-notice"
        >
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.description}</AlertDescription>
        </Alert>
      )}

      {/* Navigation Tabs */}
      <div
        role="tablist"
        aria-label="Bagian pengaturan SEO & AI Autopilot"
        className="flex flex-wrap gap-2 border-b border-border pb-3"
      >
        {SETTINGS_TABS.map((tab, idx) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`seo-settings-tab-btn-${tab.id}`}
              aria-selected={selected}
              aria-controls={`seo-settings-panel-${tab.id}`}
              data-testid={`seo-settings-tab-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
              className={
                selected
                  ? "min-h-11 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9"
                  : "min-h-11 rounded-md border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9"
              }
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: SEARCH APPEARANCE TEMPLATES */}
      {activeTab === "appearance" && (
        <div
          role="tabpanel"
          id="seo-settings-panel-appearance"
          aria-labelledby="seo-settings-tab-btn-appearance"
          className="space-y-6"
        >
          <Card>
            <CardHeader>
              <CardTitle>Pemisah &amp; Token Template</CardTitle>
              <CardDescription>
                Hanya 7 token tetap berikut yang diizinkan pada template judul dan deskripsi. Token
                yang tidak dikenali akan ditolak saat menyimpan.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <span className="block text-sm font-medium text-foreground">
                  Pemisah Judul (<code>{"{{sep}}"}</code>)
                </span>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Pilih pemisah judul">
                  {SEARCH_APPEARANCE_SEPARATORS.map((sep) => (
                    <Button
                      key={sep}
                      type="button"
                      size="sm"
                      variant={separator === sep ? "default" : "outline"}
                      disabled={readOnly}
                      data-testid={`sep-option-${sep}`}
                      onClick={() => setSeparator(sep)}
                      className="min-h-11 min-w-11 font-mono md:min-h-9 md:min-w-9"
                    >
                      {sep}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
                <p className="font-medium text-foreground">Token yang diizinkan:</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {SEARCH_APPEARANCE_TOKEN_PLACEHOLDERS.map((tok) => (
                    <code
                      key={tok}
                      className="rounded border border-border bg-card px-2 py-0.5 font-mono text-foreground"
                    >
                      {tok}
                    </code>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Template Per Jenis Halaman</CardTitle>
              <CardDescription>
                Bawaan: <code>{"{{title}} {{sep}} {{site_name}}"}</code>. Setiap output di-escape
                aman sesuai konteks HTML.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {SEARCH_APPEARANCE_KINDS.map((kind) => {
                const pair = templates[kind];
                const meta = KIND_LABELS[kind];
                const titleErr = combinedErrors[`templates.${kind}.titleTemplate`];
                const descErr = combinedErrors[`templates.${kind}.descriptionTemplate`];
                const liveTitlePreview = renderSearchAppearanceTemplate(pair.titleTemplate, {
                  title: meta.sampleTitle,
                  site_name: settings.siteName,
                  tagline: settings.tagline ?? "Solusi Bisnis Terpercaya",
                  sep: separator,
                  category: "Kategori Utama",
                  excerpt: "Ringkasan konten yang informatif dan jelas untuk pengunjung.",
                  page: 1,
                });

                return (
                  <div
                    key={kind}
                    data-template-kind={kind}
                    className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold text-foreground">{meta.label}</h2>
                      <span className="truncate text-xs text-muted-foreground">
                        Pratinjau: <strong className="text-foreground">{liveTitlePreview}</strong>
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="space-y-1">
                        <label
                          htmlFor={`tpl-title-${kind}`}
                          className="block text-xs font-medium text-foreground"
                        >
                          Template Judul
                        </label>
                        <Input
                          id={`tpl-title-${kind}`}
                          data-testid={`tpl-title-${kind}`}
                          value={pair.titleTemplate}
                          maxLength={200}
                          disabled={readOnly}
                          aria-invalid={Boolean(titleErr)}
                          onChange={(e) =>
                            setTemplates((prev) => ({
                              ...prev,
                              [kind]: { ...prev[kind], titleTemplate: e.target.value },
                            }))
                          }
                          className="min-h-11 font-mono text-sm md:min-h-9"
                        />
                        {titleErr && (
                          <p
                            role="alert"
                            data-testid={`tpl-title-error-${kind}`}
                            className="text-xs font-medium text-destructive"
                          >
                            {titleErr}
                          </p>
                        )}
                      </div>

                      <div className="space-y-1">
                        <label
                          htmlFor={`tpl-desc-${kind}`}
                          className="block text-xs font-medium text-foreground"
                        >
                          Template Deskripsi
                        </label>
                        <Input
                          id={`tpl-desc-${kind}`}
                          data-testid={`tpl-desc-${kind}`}
                          value={pair.descriptionTemplate}
                          maxLength={500}
                          disabled={readOnly}
                          aria-invalid={Boolean(descErr)}
                          onChange={(e) =>
                            setTemplates((prev) => ({
                              ...prev,
                              [kind]: { ...prev[kind], descriptionTemplate: e.target.value },
                            }))
                          }
                          className="min-h-11 font-mono text-sm md:min-h-9"
                        />
                        {descErr && (
                          <p
                            role="alert"
                            data-testid={`tpl-desc-error-${kind}`}
                            className="text-xs font-medium text-destructive"
                          >
                            {descErr}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </CardContent>
            <CardFooter className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={readOnly || busy}
                onClick={() => void handleSaveDraft()}
                data-testid="seo-settings-save-draft-btn"
                className="min-h-11 md:min-h-9"
              >
                <SaveIcon className="size-4" aria-hidden="true" />
                {busy ? "Menyimpan..." : "Simpan Draf"}
              </Button>
              <Button
                type="button"
                disabled={readOnly || busy}
                onClick={() => void handlePublish()}
                data-testid="seo-settings-publish-btn"
                className="min-h-11 md:min-h-9"
              >
                <GlobeIcon className="size-4" aria-hidden="true" />
                Terbitkan Pengaturan SEO
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}

      {/* TAB 2: WEBMASTER VERIFICATION SETTINGS */}
      {activeTab === "verification" && (
        <div
          role="tabpanel"
          id="seo-settings-panel-verification"
          aria-labelledby="seo-settings-tab-btn-verification"
          className="space-y-6"
        >
          <Alert variant="info">
            <ShieldCheckIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Terkonfigurasi berbeda dari Terverifikasi Eksternal</AlertTitle>
            <AlertDescription>
              Menyimpan token di sini hanya memancarkan tag <code>&lt;meta&gt;</code> tetap pada{" "}
              <strong className="font-medium text-foreground">{settings.primaryHost}</strong> dan
              menampilkan status <strong>Terkonfigurasi</strong>. Tidak ada perubahan DNS atau
              pengiriman otomatis ke Google/Bing. Jika domain utama berubah, verifikasi eksternal
              wajib diulang pada domain baru.
            </AlertDescription>
          </Alert>

          <div className="space-y-4">
            {settings.verificationStatuses.map((item) => {
              const tokenValue = tokens[item.provider] ?? "";
              const errMsg = combinedErrors[`verification.${item.provider}`];
              const canRecordExternal =
                !readOnly &&
                !busy &&
                Boolean(item.publishedToken) &&
                item.token === item.publishedToken &&
                (item.status === "configured" || item.status === "recheck_required");

              return (
                <Card key={item.provider} data-testid={`verification-card-${item.provider}`}>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="space-y-1">
                        <CardTitle className="text-base">{item.label}</CardTitle>
                        <CardDescription>
                          Tag tetap: <code>&lt;meta name=&quot;{item.metaName}&quot; ... /&gt;</code>
                        </CardDescription>
                      </div>
                      <Badge
                        variant={verificationStatusBadgeVariant(item.status)}
                        data-testid={`verification-status-${item.provider}`}
                      >
                        {item.statusLabel}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-1.5">
                      <label
                        htmlFor={`verify-token-${item.provider}`}
                        className="block text-sm font-medium text-foreground"
                      >
                        Nilai Token Verifikasi (atribut <code>content</code> polos)
                      </label>
                      <Input
                        id={`verify-token-${item.provider}`}
                        data-testid={`verify-token-input-${item.provider}`}
                        value={tokenValue}
                        disabled={readOnly}
                        maxLength={item.provider === "google" ? 128 : 64}
                        aria-invalid={Boolean(errMsg)}
                        onChange={(e) =>
                          setTokens((prev) => ({
                            ...prev,
                            [item.provider]: e.target.value ? e.target.value : null,
                          }))
                        }
                        placeholder="Masukkan token polos tanpa tag <meta>"
                        className="min-h-11 font-mono text-sm md:min-h-9"
                      />
                      {errMsg && (
                        <p
                          role="alert"
                          data-testid={`verify-token-error-${item.provider}`}
                          className="text-xs font-medium text-destructive"
                        >
                          {errMsg}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">{item.helperText}</p>
                    </div>

                    {item.metaTagPreview && (
                      <div className="space-y-1">
                        <span className="block text-xs font-medium text-muted-foreground">
                          Pratinjau Tag Meta yang Dipancarkan:
                        </span>
                        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2.5 font-mono text-xs text-foreground">
                          {item.metaTagPreview}
                        </pre>
                      </div>
                    )}

                    {item.domainChangedSinceVerification && (
                      <Alert variant="warning" data-testid={`verify-domain-changed-${item.provider}`}>
                        <AlertTriangleIcon className="size-4" aria-hidden="true" />
                        <AlertTitle>Verifikasi ulang diperlukan</AlertTitle>
                        <AlertDescription>
                          Domain utama berubah dari{" "}
                          <code className="font-mono">{item.externalVerification?.verifiedHost}</code>{" "}
                          ke <code className="font-mono">{settings.primaryHost}</code>. Ulangi
                          verifikasi properti di {item.label} lalu catat kembali di sini.
                        </AlertDescription>
                      </Alert>
                    )}

                    {item.externalVerification && !item.domainChangedSinceVerification && (
                      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs">
                        <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                        <div className="space-y-0.5">
                          <p className="font-medium text-foreground">
                            Tercatat terverifikasi pada{" "}
                            <span className="font-mono">{item.externalVerification.verifiedHost}</span>
                          </p>
                          <p className="text-muted-foreground">
                            Waktu catat: {item.externalVerification.verifiedAt}
                            {item.externalVerification.note ? ` · ${item.externalVerification.note}` : ""}
                          </p>
                        </div>
                      </div>
                    )}

                    {canRecordExternal && (
                      <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3 sm:flex-row sm:items-end">
                        <div className="min-w-0 flex-1 space-y-1">
                          <label
                            htmlFor={`verify-note-${item.provider}`}
                            className="block text-xs font-medium text-foreground"
                          >
                            Catatan verifikasi manual (opsional)
                          </label>
                          <Input
                            id={`verify-note-${item.provider}`}
                            value={checkNotes[item.provider]}
                            maxLength={240}
                            onChange={(e) =>
                              setCheckNotes((prev) => ({ ...prev, [item.provider]: e.target.value }))
                            }
                            placeholder={`Contoh: Selesai verifikasi properti ${settings.primaryHost}`}
                            className="min-h-11 text-sm md:min-h-9"
                          />
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void handleRecordExternalVerification(item.provider)}
                          data-testid={`record-external-verify-${item.provider}`}
                          className="min-h-11 shrink-0 md:min-h-9"
                        >
                          <CheckCircle2Icon className="size-4" aria-hidden="true" />
                          Catat Verifikasi Eksternal Selesai
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">URL Sitemap untuk Pendaftaran Webmaster</CardTitle>
              <CardDescription>
                Setelah memverifikasi properti pada domain utama, kirimkan URL sitemap berikut di
                Google Search Console atau Bing Webmaster Tools.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <code
                data-testid="seo-sitemap-url"
                className="block overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground"
              >
                {settings.sitemapUrl}
              </code>
            </CardContent>
            <CardFooter className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={readOnly || busy}
                onClick={() => void handleSaveDraft()}
                className="min-h-11 md:min-h-9"
              >
                <SaveIcon className="size-4" aria-hidden="true" />
                Simpan Draf Token
              </Button>
              <Button
                type="button"
                disabled={readOnly || busy}
                onClick={() => void handlePublish()}
                data-testid="seo-verification-publish-btn"
                className="min-h-11 md:min-h-9"
              >
                <GlobeIcon className="size-4" aria-hidden="true" />
                Terbitkan Token Verifikasi
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}

      {/* TAB 3: GOOGLE BUSINESS PROFILE & BING PLACES 1-CLICK COPY */}
      {activeTab === "directory" && (
        <div
          role="tabpanel"
          id="seo-settings-panel-directory"
          aria-labelledby="seo-settings-tab-btn-directory"
          className="space-y-4"
        >
          <Card data-testid="seo-gbp-copy-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2Icon className="size-4 text-primary" aria-hidden="true" />
                <span>Salin Data untuk Google Business Profile &amp; Bing Places</span>
              </CardTitle>
              <CardDescription>
                Ringkasan fakta bisnis resmi dari Profil Bisnis situs Anda untuk menyelaraskan
                daftar direktori secara manual. Tidak ada alamat atau jam operasional yang dikarang.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <pre
                data-testid="seo-gbp-copy-preview"
                className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground"
              >
                {settings.directoryListingCopyText}
              </pre>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <InfoIcon className="size-3.5 shrink-0" aria-hidden="true" />
                  Ubah detail usaha pada Pengaturan &gt; Profil Bisnis agar data ini ikut mutakhir.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleCopyDirectory()}
                  data-testid="seo-gbp-copy-btn"
                  className="min-h-11 md:min-h-9"
                >
                  {copiedDirectory ? (
                    <>
                      <CheckIcon className="size-4" aria-hidden="true" />
                      <span>Tersalin</span>
                    </>
                  ) : (
                    <>
                      <CopyIcon className="size-4" aria-hidden="true" />
                      <span>Salin Data untuk Google Business Profile &amp; Bing Places</span>
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
}

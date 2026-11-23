import { useState } from "react";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  DatabaseIcon,
  LockIcon,
  SaveIcon,
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
import { Separator } from "@/components/ui/separator";
import type { PluginConfigFieldHint } from "@punyasitus/core/plugins/index";

export interface PluginDetailClientProps {
  readonly basePath: string;
  readonly apiUrl: string;
  readonly plugin: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly version: string;
    readonly visibility: "public_free" | "public_paid" | "private_client";
    readonly tablePrefix: string;
    readonly permissions: readonly string[];
    readonly enabled: boolean;
    readonly schemaVersion: number;
    readonly config: Record<string, unknown>;
  };
  readonly configFields: readonly PluginConfigFieldHint[];
  readonly adminState?: Record<string, unknown> | null;
  readonly permissions: {
    readonly roleLabel: string;
    readonly isLocked: boolean;
    readonly canManagePlugins: boolean;
  };
}

export function PluginDetailClient({
  basePath,
  apiUrl,
  plugin: initialPlugin,
  configFields,
  adminState,
  permissions,
}: PluginDetailClientProps) {
  const [enabled, setEnabled] = useState(initialPlugin.enabled);
  const [config, setConfig] = useState<Record<string, unknown>>({ ...initialPlugin.config });
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [notice, setNotice] = useState<{
    readonly variant: "success" | "destructive" | "info";
    readonly title: string;
    readonly description: string;
  } | null>(null);

  async function handleToggleEnabled() {
    if (!permissions.canManagePlugins || toggling) return;
    setToggling(true);
    setNotice(null);
    const nextEnabled = !enabled;
    try {
      const response = await fetch(apiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        readonly plugin?: { readonly enabled: boolean };
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !data.plugin) {
        setNotice({
          variant: "destructive",
          title: "Gagal mengubah status plugin",
          description: data.error?.message ?? "Terjadi kendala saat memperbarui status plugin.",
        });
        return;
      }
      setEnabled(data.plugin.enabled);
      setNotice({
        variant: data.plugin.enabled ? "success" : "info",
        title: data.plugin.enabled ? "Plugin diaktifkan kembali" : "Plugin dinonaktifkan",
        description: data.plugin.enabled
          ? "Semua fitur plugin telah aktif kembali bersama data pengaturan sebelumnya."
          : "Data pengaturan plugin tetap tersimpan aman jika diaktifkan kembali.",
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Perubahan status belum tersimpan. Periksa koneksi Anda dan coba lagi.",
      });
    } finally {
      setToggling(false);
    }
  }

  async function handleSaveConfig(event: { readonly preventDefault: () => void }) {
    event.preventDefault();
    if (!permissions.canManagePlugins || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch(apiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        readonly plugin?: { readonly config: Record<string, unknown> };
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !data.plugin) {
        setNotice({
          variant: "destructive",
          title: "Gagal menyimpan pengaturan",
          description:
            data.error?.message ?? "Pengaturan belum tersimpan. Masukan Anda tetap dipertahankan.",
        });
        return;
      }
      setConfig(data.plugin.config);
      setNotice({
        variant: "success",
        title: "Pengaturan plugin tersimpan",
        description: "Perubahan konfigurasi telah diterapkan pada situs Anda.",
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Masukan formulir Anda tetap dipertahankan. Silakan coba simpan kembali.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="space-y-6"
      data-testid="plugin-detail-shell"
      aria-labelledby="plugin-detail-heading"
    >
      {/* Breadcrumb & Back */}
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

        <div className="flex items-center gap-2">
          <Badge variant={enabled ? "success" : "outline"}>
            {enabled ? (
              <>
                <CheckCircle2Icon className="size-3" aria-hidden="true" />
                Aktif
              </>
            ) : (
              "Nonaktif"
            )}
          </Badge>
          <Button
            variant={enabled ? "outline" : "default"}
            size="sm"
            className="min-h-11 md:min-h-8"
            disabled={!permissions.canManagePlugins || toggling}
            onClick={() => void handleToggleEnabled()}
          >
            {toggling
              ? "Memproses..."
              : enabled
                ? "Nonaktifkan Plugin"
                : "Aktifkan Kembali"}
          </Button>
        </div>
      </div>

      {/* Heading */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1
            id="plugin-detail-heading"
            className="text-xl font-semibold tracking-tight text-foreground"
          >
            {initialPlugin.name}
          </h1>
          <Badge variant="outline" className="font-mono text-xs">
            v{initialPlugin.version}
          </Badge>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{initialPlugin.description}</p>
      </div>

      {/* Guardrail alerts */}
      {permissions.isLocked ? (
        <Alert variant="warning">
          <LockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Langganan terkunci (Mode hanya-baca)</AlertTitle>
          <AlertDescription>
            Perpanjang langganan untuk mengubah pengaturan atau mengaktifkan/menonaktifkan plugin.
          </AlertDescription>
        </Alert>
      ) : !permissions.canManagePlugins ? (
        <Alert variant="info">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode lihat saja ({permissions.roleLabel})</AlertTitle>
          <AlertDescription>
            Hubungi Pemilik Situs atau Admin untuk mengubah konfigurasi plugin ini.
          </AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert variant={notice.variant} data-testid="plugin-detail-notice">
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.description}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Settings Form */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Pengaturan Plugin</CardTitle>
            <CardDescription>
              Konfigurasi disimpan terisolasi di penyimpanan situs Anda. Data pengaturan plugin
              tetap tersimpan aman jika diaktifkan kembali.
            </CardDescription>
          </CardHeader>

          <form onSubmit={(e) => void handleSaveConfig(e)}>
            <CardContent className="space-y-4">
              {configFields.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Plugin ini bekerja otomatis tanpa konfigurasi tambahan yang wajib diisi.
                </p>
              ) : (
                configFields.map((field) => {
                  const fieldId = `plugin-cfg-${field.key}`;
                  const currentVal = config[field.key];
                  if (field.kind === "boolean") {
                    return (
                      <div
                        key={field.key}
                        className="flex items-start justify-between gap-4 rounded-md border border-border p-3"
                      >
                        <div className="space-y-0.5">
                          <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
                            {field.label}
                          </label>
                          {field.description ? (
                            <p className="text-xs text-muted-foreground">{field.description}</p>
                          ) : null}
                        </div>
                        <input
                          id={fieldId}
                          type="checkbox"
                          className="mt-1 size-4 accent-primary"
                          checked={Boolean(currentVal)}
                          disabled={!permissions.canManagePlugins || saving}
                          onChange={(e) =>
                            setConfig((prev) => ({ ...prev, [field.key]: e.target.checked }))
                          }
                        />
                      </div>
                    );
                  }

                  return (
                    <div key={field.key} className="space-y-1.5">
                      <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
                        {field.label}
                      </label>
                      <Input
                        id={fieldId}
                        type={field.kind === "number" ? "number" : "text"}
                        placeholder={field.placeholder}
                        value={currentVal === undefined || currentVal === null ? "" : String(currentVal)}
                        disabled={!permissions.canManagePlugins || saving}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            [field.key]:
                              field.kind === "number" ? Number(e.target.value) : e.target.value,
                          }))
                        }
                      />
                      {field.description ? (
                        <p className="text-xs text-muted-foreground">{field.description}</p>
                      ) : null}
                    </div>
                  );
                })
              )}
            </CardContent>

            {configFields.length > 0 ? (
              <CardFooter className="justify-end">
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-11 md:min-h-9"
                  disabled={!permissions.canManagePlugins || saving}
                >
                  <SaveIcon className="size-4" aria-hidden="true" />
                  {saving ? "Menyimpan..." : "Simpan Pengaturan"}
                </Button>
              </CardFooter>
            ) : null}
          </form>
        </Card>

        {/* Isolation & Runtime Metadata */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheckIcon className="size-4 text-primary" aria-hidden="true" />
              Isolasi & Skema Data
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="space-y-1">
              <p className="text-muted-foreground">Namespace Tabel TenantStore</p>
              <div className="flex items-center gap-1.5 font-mono text-foreground">
                <DatabaseIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <span>{initialPlugin.tablePrefix}*</span>
              </div>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Versi Skema Plugin</span>
              <span className="font-mono font-medium text-foreground">
                v{initialPlugin.schemaVersion}
              </span>
            </div>
            {adminState && Object.keys(adminState).length > 0 ? (
              <>
                <Separator />
                <div className="space-y-1.5">
                  <p className="text-muted-foreground">Ringkasan Data Plugin</p>
                  {Object.entries(adminState).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="font-mono text-foreground">{String(v)}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

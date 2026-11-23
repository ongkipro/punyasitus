import { useState } from "react";
import {
  AFTER_SUBMIT_ACTION_LABELS_ID,
  MAX_FORMS_PER_TENANT,
  type FormVerticalTemplate,
} from "@punyasitus/core/forms/index";
import type { TenantFormComplianceContext, TenantFormRecord } from "@punyasitus/db/forms/index";
import {
  AlertTriangleIcon,
  FilePlus2Icon,
  FileTextIcon,
  GlobeIcon,
  PencilIcon,
  PlusIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface FormsListClientProps {
  readonly tenantId: string;
  readonly handle: string;
  readonly basePath: string;
  readonly canWrite: boolean;
  readonly canPublish: boolean;
  readonly isLocked: boolean;
  readonly initialItems: readonly TenantFormRecord[];
  readonly compliance: TenantFormComplianceContext;
  readonly templates: readonly FormVerticalTemplate[];
}

function formatDateId(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function FormsListClient({
  handle,
  basePath,
  canWrite,
  isLocked,
  initialItems,
  compliance,
  templates,
}: FormsListClientProps) {
  const [items, setItems] = useState<readonly TenantFormRecord[]>(initialItems);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const count = items.length;
  const limitReached = count >= MAX_FORMS_PER_TENANT;

  async function handleDelete(form: TenantFormRecord) {
    if (!canWrite || busyKey) return;
    setErrorBanner(null);
    setSuccessBanner(null);
    setBusyKey(`delete-${form.id}`);
    try {
      const res = await fetch(
        `/api/tenants/${encodeURIComponent(handle)}/forms/${form.id}?expectedVersion=${form.version}`,
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          credentials: "same-origin",
          body: JSON.stringify({ expectedVersion: form.version }),
        },
      );
      const data = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        setErrorBanner(data?.error?.message ?? "Gagal menghapus formulir.");
        return;
      }
      setItems((prev) => prev.filter((item) => item.id !== form.id));
      setSuccessBanner(`Formulir "${form.name}" berhasil dihapus.`);
    } catch {
      setErrorBanner("Koneksi terganggu saat menghapus formulir.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-6" data-testid="forms-list-root">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
              Formulir Kustom
            </h1>
            <Badge variant="outline" className="tabular-nums" data-testid="forms-count-badge">
              {count} / {MAX_FORMS_PER_TENANT} formulir
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Buat hingga {MAX_FORMS_PER_TENANT} formulir penangkap prospek dengan maksimal 12 field,
            aturan tampilan 1 tingkat, dan lanjut WhatsApp otomatis.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canWrite && !limitReached ? (
            <Button
              render={<a href={`${basePath}/forms/new`} />}
              className="min-h-11 sm:min-h-9"
              data-testid="create-form-button"
            >
              <PlusIcon className="size-4" aria-hidden="true" />
              Buat Formulir Baru
            </Button>
          ) : (
            <Button
              type="button"
              disabled
              className="min-h-11 sm:min-h-9"
              data-testid="create-form-button-disabled"
            >
              <PlusIcon className="size-4" aria-hidden="true" />
              {limitReached ? "Batas 10 Formulir Tercapai" : "Mode Baca Saja"}
            </Button>
          )}
        </div>
      </div>

      {/* Lifecycle lock notice */}
      {isLocked && (
        <Alert variant="destructive" data-testid="forms-locked-banner">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Situs Dalam Mode Baca Saja (Terkunci)</AlertTitle>
          <AlertDescription>
            Anda masih dapat melihat daftar formulir, namun pembuatan, pengubahan, dan penerbitan
            formulir dinonaktifkan hingga langganan diperpanjang.
          </AlertDescription>
        </Alert>
      )}

      {/* Missing privacy_contact compliance warning */}
      {!compliance.privacyContactConfigured && (
        <Alert
          className="border-amber-300 bg-amber-50 text-amber-950"
          data-testid="privacy-contact-missing-warning"
        >
          <AlertTriangleIcon className="size-4 text-amber-700" aria-hidden="true" />
          <AlertTitle>Kontak Privasi Belum Diisi (Syarat Terbit UU PDP)</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              Anda tetap dapat menyusun draf formulir, namun formulir belum dapat diterbitkan
              sebelum <strong>Kontak Privasi</strong> diisi pada Profil Bisnis.
            </p>
            <Button
              variant="outline"
              size="sm"
              render={<a href={`${basePath}/settings/profil`} />}
              className="min-h-10 sm:min-h-8"
            >
              Lengkapi di Pengaturan Profil Bisnis
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Regulated Health Category UU PDP Sensitive Data Warning */}
      {compliance.isHealthCategory && compliance.healthWarningMessage && (
        <Alert
          className="border-amber-400 bg-amber-50 text-amber-950"
          data-testid="uupdp-health-warning"
        >
          <ShieldAlertIcon className="size-4 text-amber-700" aria-hidden="true" />
          <AlertTitle>Peringatan Data Pribadi Spesifik (Kategori Kesehatan — UU PDP)</AlertTitle>
          <AlertDescription>{compliance.healthWarningMessage}</AlertDescription>
        </Alert>
      )}

      {errorBanner && (
        <Alert variant="destructive" role="alert" data-testid="forms-list-error">
          <AlertTitle>Terjadi Kesalahan</AlertTitle>
          <AlertDescription>{errorBanner}</AlertDescription>
        </Alert>
      )}

      {successBanner && (
        <Alert className="border-emerald-300 bg-emerald-50 text-emerald-950" role="status">
          <AlertTitle>Berhasil</AlertTitle>
          <AlertDescription>{successBanner}</AlertDescription>
        </Alert>
      )}

      {/* Existing forms list */}
      <section aria-label="Daftar Formulir Situs" className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">Formulir Tersimpan</h2>

        {items.length === 0 ? (
          <Card data-testid="forms-empty-state">
            <CardContent className="flex flex-col items-start gap-3 py-8">
              <div className="space-y-1">
                <p className="text-base font-semibold text-foreground">
                  Belum ada formulir kustom
                </p>
                <p className="text-sm text-muted-foreground">
                  Mulai dari salah satu 6 template vertikal di bawah atau buat formulir dari awal.
                </p>
              </div>
              {canWrite && (
                <Button
                  render={<a href={`${basePath}/forms/new`} />}
                  className="min-h-11 sm:min-h-9"
                >
                  <FilePlus2Icon className="size-4" aria-hidden="true" />
                  Buat Formulir Pertama
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {items.map((form) => (
              <Card key={form.id} data-testid={`form-card-${form.slug}`}>
                <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={`${basePath}/forms/${form.id}`}
                        className="text-base font-semibold text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {form.name}
                      </a>
                      {form.isPublished ? (
                        <Badge className="bg-emerald-700 text-white">
                          Terbit v{form.publishedVersion}
                        </Badge>
                      ) : (
                        <Badge variant="outline">Draf</Badge>
                      )}
                      {form.isPublished && form.hasUnpublishedChanges && (
                        <Badge variant="outline" className="border-amber-400 text-amber-800">
                          Ada perubahan belum terbit
                        </Badge>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono">slug: {form.slug}</span>
                      <span className="tabular-nums">{form.fields.length} / 12 field</span>
                      <span>Aksi: {AFTER_SUBMIT_ACTION_LABELS_ID[form.afterSubmitAction]}</span>
                      <span className="tabular-nums">{form.leadsCount} pesan masuk</span>
                      <span>Diperbarui {formatDateId(form.updatedAt)}</span>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      render={<a href={`${basePath}/forms/${form.id}`} />}
                      className="min-h-11 sm:min-h-8"
                      data-testid={`edit-form-${form.slug}`}
                    >
                      <PencilIcon className="size-3.5" aria-hidden="true" />
                      {canWrite ? "Ubah" : "Lihat"}
                    </Button>

                    {canWrite && form.leadsCount === 0 && (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={busyKey !== null}
                        onClick={() => handleDelete(form)}
                        className="min-h-11 sm:min-h-8"
                        data-testid={`delete-form-${form.slug}`}
                      >
                        <Trash2Icon className="size-3.5" aria-hidden="true" />
                        Hapus
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* 6 Vertical Starter Templates */}
      <section aria-label="Template Vertikal Siap Pakai" className="space-y-3">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
            <FileTextIcon className="size-4 text-primary" aria-hidden="true" />
            6 Template Vertikal Siap Pakai
          </h2>
          <p className="text-sm text-muted-foreground">
            Pilih template sesuai jenis usaha Anda. Semua field dapat diubah atau diurutkan ulang.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {templates.map((tpl) => (
            <Card key={tpl.key} data-testid={`template-card-${tpl.key}`}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="outline">{tpl.verticalBadge}</Badge>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {tpl.fields.length} field
                  </span>
                </div>
                <CardTitle className="text-base">{tpl.label}</CardTitle>
                <CardDescription className="text-xs leading-relaxed">{tpl.summary}</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                {canWrite && !limitReached ? (
                  <Button
                    variant="outline"
                    size="sm"
                    render={<a href={`${basePath}/forms/new?template=${encodeURIComponent(tpl.key)}`} />}
                    className="w-full min-h-11 sm:min-h-9"
                    data-testid={`use-template-${tpl.key}`}
                  >
                    <GlobeIcon className="size-3.5" aria-hidden="true" />
                    Gunakan Template
                  </Button>
                ) : (
                  <Button type="button" variant="outline" size="sm" disabled className="w-full min-h-11 sm:min-h-9">
                    {limitReached ? "Batas Formulir Penuh" : "Mode Baca Saja"}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}

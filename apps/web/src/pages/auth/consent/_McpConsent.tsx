import * as React from "react";
import {
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  GlobeIcon,
  LockIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
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

export interface ConsentTenantOption {
  readonly tenantId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: string;
  readonly dbRole: string;
  readonly eligible: boolean;
}

export interface ConsentScopeOption {
  readonly scope: string;
  readonly label: string;
  readonly description: string;
  readonly requiresPiiConsent: boolean;
  readonly piiWarning?: string;
}

export interface McpConsentInitialProps {
  readonly authenticated: boolean;
  readonly userName: string | null;
  readonly userEmail: string | null;
  readonly validationError: string | null;
  readonly clientName: string;
  readonly clientId: string;
  readonly clientUri: string | null;
  readonly redirectUri: string;
  readonly resource: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly state: string;
  readonly requestedScopes: readonly string[];
  readonly availableScopes: readonly ConsentScopeOption[];
  readonly tenants: readonly ConsentTenantOption[];
  readonly loginHref: string;
}

function roleLabelId(role: string): string {
  if (role === "owner") return "Pemilik (Owner)";
  if (role === "admin") return "Admin";
  if (role === "editor") return "Editor";
  return role;
}

export function McpConsentScreen(props: McpConsentInitialProps) {
  const eligibleTenants = React.useMemo(
    () => props.tenants.filter((t) => t.eligible),
    [props.tenants],
  );
  const [selectedTenantId, setSelectedTenantId] = React.useState<string>(
    eligibleTenants[0]?.tenantId ?? "",
  );
  const [selectedScopes, setSelectedScopes] = React.useState<readonly string[]>(
    props.requestedScopes.length > 0 ? props.requestedScopes : ["content:read"],
  );
  const [piiConsentAcked, setPiiConsentAcked] = React.useState(false);
  const [submitting, setSubmitting] = React.useState<"approve" | "deny" | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [completedRedirect, setCompletedRedirect] = React.useState<{
    readonly decision: "approve" | "deny";
    readonly url: string;
  } | null>(null);

  const hasLeadsRead = selectedScopes.includes("leads:read");

  function toggleScope(scope: string) {
    setErrorMessage(null);
    setSelectedScopes((prev) => {
      if (prev.includes(scope)) {
        return prev.filter((s) => s !== scope);
      }
      return [...prev, scope];
    });
  }

  async function handleSubmit(decision: "approve" | "deny") {
    setErrorMessage(null);
    if (decision === "approve") {
      if (!selectedTenantId) {
        setErrorMessage("Pilih satu situs web yang akan dihubungkan ke aplikasi AI.");
        return;
      }
      if (selectedScopes.length === 0) {
        setErrorMessage("Pilih minimal satu izin akses sebelum menyetujui.");
        return;
      }
      if (hasLeadsRead && !piiConsentAcked) {
        setErrorMessage(
          "Centang persetujuan pengiriman data pribadi prospek terlebih dahulu untuk izin leads:read.",
        );
        return;
      }
    }

    setSubmitting(decision);
    try {
      const res = await fetch("/api/auth/mcp/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          decision,
          clientId: props.clientId,
          redirectUri: props.redirectUri,
          resource: props.resource,
          codeChallenge: props.codeChallenge,
          codeChallengeMethod: "S256",
          state: props.state,
          ...(decision === "approve"
            ? {
                tenantId: selectedTenantId,
                scopes: selectedScopes,
                piiConsentAcked: hasLeadsRead && piiConsentAcked,
              }
            : {}),
        }),
      });
      const data = (await res.json()) as {
        readonly success?: boolean;
        readonly redirectTo?: string;
        readonly message?: string;
      };
      if (!res.ok || !data.success || !data.redirectTo) {
        setErrorMessage(data.message ?? "Gagal memproses persetujuan otorisasi.");
        setSubmitting(null);
        return;
      }

      setCompletedRedirect({ decision, url: data.redirectTo });
      // Redirect back to the validated OAuth client callback
      window.location.assign(data.redirectTo);
    } catch {
      setErrorMessage("Terjadi kesalahan jaringan. Periksa koneksi Anda lalu coba lagi.");
      setSubmitting(null);
    }
  }

  if (props.validationError) {
    return (
      <div className="w-full max-w-lg space-y-4" data-testid="mcp-consent-invalid">
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Permintaan otorisasi tidak valid</AlertTitle>
          <AlertDescription>{props.validationError}</AlertDescription>
        </Alert>
        <Button
          variant="outline"
          className="min-h-11 w-full"
          render={<a href="/account/connected-apps" />}
        >
          Buka Aplikasi AI Terhubung
        </Button>
      </div>
    );
  }

  if (!props.authenticated) {
    return (
      <Card className="w-full max-w-lg" data-testid="mcp-consent-unauthenticated">
        <CardHeader>
          <div className="flex items-center gap-2">
            <BotIcon className="size-5 text-primary" aria-hidden="true" />
            <CardTitle className="text-xl">Masuk untuk menghubungkan agen AI</CardTitle>
          </div>
          <CardDescription>
            <strong>{props.clientName}</strong> meminta izin untuk terhubung ke satu situs
            PunyaSitus Anda. Masuk terlebih dahulu sebagai Pemilik atau Admin situs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button className="min-h-11 w-full" render={<a href={props.loginHref} />}>
            Masuk ke Akun PunyaSitus
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (completedRedirect) {
    return (
      <Card className="w-full max-w-lg" data-testid="mcp-consent-completed">
        <CardHeader>
          <div className="flex items-center gap-2 text-primary">
            <CheckCircle2Icon className="size-5" aria-hidden="true" />
            <CardTitle className="text-lg">
              {completedRedirect.decision === "approve"
                ? "Akses disetujui — mengalihkan kembali..."
                : "Permintaan ditolak — mengalihkan kembali..."}
            </CardTitle>
          </div>
          <CardDescription>
            Jika browser tidak mengalihkan secara otomatis, klik tombol di bawah ini.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="min-h-11 w-full" render={<a href={completedRedirect.url} />}>
            Kembali ke {props.clientName}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const noEligibleTenant = eligibleTenants.length === 0;

  return (
    <Card className="w-full max-w-xl" data-testid="mcp-consent-card">
      <CardHeader className="space-y-2 border-b border-border pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge variant="outline" className="gap-1.5">
            <LockIcon className="size-3.5" aria-hidden="true" />
            OAuth 2.1 · PKCE S256
          </Badge>
          <span className="text-xs text-muted-foreground">
            Masuk sebagai {props.userEmail ?? props.userName}
          </span>
        </div>
        <CardTitle className="text-xl font-semibold tracking-tight text-foreground">
          Hubungkan {props.clientName} ke PunyaSitus
        </CardTitle>
        <CardDescription className="text-sm text-muted-foreground">
          Pilih <strong>tepat satu situs web</strong> dan batas izin yang diizinkan untuk agen AI
          ini. Anda dapat mencabut akses kapan saja di menu Akun &gt; Aplikasi AI Terhubung.
        </CardDescription>
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground break-all">
          <span className="font-medium text-foreground">ID Klien Terverifikasi:</span>{" "}
          {props.clientId}
        </div>
      </CardHeader>

      <CardContent className="space-y-6 pt-5">
        {errorMessage && (
          <Alert variant="destructive" role="alert" data-testid="mcp-consent-error">
            <AlertCircleIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Persetujuan belum dapat diproses</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        {/* Section 1: Select exactly ONE website */}
        <section aria-labelledby="consent-website-heading" className="space-y-3">
          <div>
            <h2 id="consent-website-heading" className="text-sm font-semibold text-foreground">
              1. Pilih satu situs web
            </h2>
            <p className="text-xs text-muted-foreground">
              Satu koneksi hanya berlaku untuk satu situs dan hanya dapat dibuat oleh Pemilik
              (Owner) atau Admin situs.
            </p>
          </div>

          {noEligibleTenant ? (
            <Alert variant="warning" role="alert" data-testid="mcp-consent-role-denied">
              <ShieldAlertIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Peran Anda tidak memiliki izin menghubungkan agen AI</AlertTitle>
              <AlertDescription>
                Hanya Pemilik (Owner) atau Admin situs yang dapat menghubungkan agen AI. Akun Anda
                saat ini tidak memiliki peran Owner/Admin pada situs aktif mana pun.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-2" role="radiogroup" aria-label="Pilih situs web">
              {props.tenants.map((tenant) => {
                const isSelected = selectedTenantId === tenant.tenantId;
                const isDisabled = !tenant.eligible;
                return (
                  <label
                    key={tenant.tenantId}
                    htmlFor={`tenant-opt-${tenant.tenantId}`}
                    className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                      isDisabled
                        ? "cursor-not-allowed border-border/60 bg-muted/30 opacity-65"
                        : isSelected
                          ? "border-primary bg-primary/5"
                          : "border-border bg-card hover:bg-muted/30"
                    }`}
                  >
                    <input
                      id={`tenant-opt-${tenant.tenantId}`}
                      type="radio"
                      name="mcp-tenant"
                      value={tenant.tenantId}
                      checked={isSelected}
                      disabled={isDisabled}
                      onChange={() => {
                        setErrorMessage(null);
                        setSelectedTenantId(tenant.tenantId);
                      }}
                      className="mt-1 size-4 accent-primary"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <GlobeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="text-sm font-medium text-foreground">{tenant.name}</span>
                        <Badge variant="outline" className="text-[11px]">
                          {roleLabelId(tenant.dbRole)}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground break-all">
                        {tenant.handle}.situsku.click
                        {!tenant.eligible ? " — Peran Editor tidak diizinkan menghubungkan agen AI" : ""}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </section>

        {/* Section 2: Explicit Scopes */}
        <section aria-labelledby="consent-scopes-heading" className="space-y-3">
          <div>
            <h2 id="consent-scopes-heading" className="text-sm font-semibold text-foreground">
              2. Pilih izin akses agen AI
            </h2>
            <p className="text-xs text-muted-foreground">
              Akses hapus data, penagihan, domain, manajemen anggota, dan unggah media dari URL
              tidak pernah tersedia melalui MCP.
            </p>
          </div>

          <div className="space-y-2">
            {props.availableScopes.map((item) => {
              const checked = selectedScopes.includes(item.scope);
              return (
                <label
                  key={item.scope}
                  htmlFor={`scope-${item.scope}`}
                  className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                    checked ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/30"
                  }`}
                >
                  <input
                    id={`scope-${item.scope}`}
                    type="checkbox"
                    checked={checked}
                    disabled={noEligibleTenant}
                    onChange={() => toggleScope(item.scope)}
                    className="mt-1 size-4 accent-primary"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{item.label}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {item.scope}
                      </code>
                    </div>
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  </div>
                </label>
              );
            })}
          </div>

          {hasLeadsRead && (
            <Alert variant="warning" data-testid="mcp-consent-pii-warning">
              <ShieldAlertIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Persetujuan Pengiriman Data Pribadi Prospek (UU PDP)</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  Dengan mengaktifkan izin <code>leads:read</code>, nama, nomor telepon/WhatsApp,
                  email, dan isi pesan prospek dari situs terpilih akan dikirimkan ke{" "}
                  <strong>{props.clientName}</strong>.
                </p>
                <label
                  htmlFor="mcp-pii-ack"
                  className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground"
                >
                  <input
                    id="mcp-pii-ack"
                    type="checkbox"
                    checked={piiConsentAcked}
                    onChange={(e) => {
                      setErrorMessage(null);
                      setPiiConsentAcked(e.target.checked);
                    }}
                    className="size-4 accent-primary"
                  />
                  <span>Saya memahami dan menyetujui pengiriman data prospek ke aplikasi AI ini</span>
                </label>
              </AlertDescription>
            </Alert>
          )}
        </section>

        {/* Guardrail reminder */}
        <div className="flex items-start gap-2.5 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <p>
            Agen AI hanya dapat membuat dan memperbarui draf. Publikasi ke situs publik selalu
            memerlukan konfirmasi langsung dari Anda melalui tautan persetujuan browser.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
            disabled={submitting !== null}
            onClick={() => handleSubmit("deny")}
            data-testid="mcp-consent-deny"
          >
            {submitting === "deny" ? "Menolak..." : "Tolak"}
          </Button>
          <Button
            type="button"
            className="min-h-11 w-full sm:w-auto"
            disabled={noEligibleTenant || submitting !== null}
            onClick={() => handleSubmit("approve")}
            data-testid="mcp-consent-approve"
          >
            {submitting === "approve" ? "Menghubungkan..." : "Izinkan Akses"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

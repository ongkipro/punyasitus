import * as React from "react";
import {
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  GlobeIcon,
  ShieldAlertIcon,
  ShieldOffIcon,
  Unlink2Icon,
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

export interface ConnectedAppGrantView {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly clientUri: string | null;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly scopes: readonly string[];
  readonly piiConsentAcked: boolean;
  readonly status: "active" | "revoked";
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

export interface ConnectedAppsProps {
  readonly authenticated: boolean;
  readonly mcpEndpointUrl: string;
  readonly initialGrants: readonly ConnectedAppGrantView[];
}

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  "content:read": "Baca konten",
  "content:write_draft": "Ubah draf",
  "content:publish_request": "Minta publikasi",
  "leads:read": "Baca prospek (PII)",
};

function formatWib(iso: string | null): string {
  if (!iso) return "Belum pernah digunakan";
  try {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return iso;
    return `${dt.toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      dateStyle: "medium",
      timeStyle: "short",
    })} WIB`;
  } catch {
    return iso;
  }
}

export function ConnectedAppsManager({
  authenticated,
  mcpEndpointUrl,
  initialGrants,
}: ConnectedAppsProps) {
  const [grants, setGrants] = React.useState<readonly ConnectedAppGrantView[]>(initialGrants);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [statusBanner, setStatusBanner] = React.useState<{
    readonly kind: "success" | "error";
    readonly title: string;
    readonly text: string;
  } | null>(null);

  const activeGrants = React.useMemo(
    () => grants.filter((g) => g.status === "active"),
    [grants],
  );
  const revokedGrants = React.useMemo(
    () => grants.filter((g) => g.status === "revoked"),
    [grants],
  );

  async function handleRevoke(grant: ConnectedAppGrantView) {
    setStatusBanner(null);
    setRevokingId(grant.id);
    try {
      const res = await fetch("/api/auth/mcp/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          grantId: grant.id,
          reason: "user_revoked_from_connected_apps",
        }),
      });
      const data = (await res.json()) as {
        readonly success?: boolean;
        readonly message?: string;
      };
      if (!res.ok || !data.success) {
        setStatusBanner({
          kind: "error",
          title: "Gagal mencabut akses",
          text: data.message ?? "Permintaan pencabutan akses gagal diproses.",
        });
        return;
      }

      const nowIso = new Date().toISOString();
      setGrants((prev) =>
        prev.map((item) =>
          item.id === grant.id
            ? {
                ...item,
                status: "revoked",
                revokedAt: nowIso,
                revokedReason: "user_revoked_from_connected_apps",
              }
            : item,
        ),
      );
      setStatusBanner({
        kind: "success",
        title: "Akses berhasil dicabut seketika",
        text: `Token akses untuk ${grant.clientName} pada situs ${grant.tenantName} telah dinonaktifkan segera.`,
      });
    } catch {
      setStatusBanner({
        kind: "error",
        title: "Kesalahan jaringan",
        text: "Tidak dapat menghubungi server. Coba lagi.",
      });
    } finally {
      setRevokingId(null);
    }
  }

  if (!authenticated) {
    return (
      <div className="mx-auto max-w-3xl space-y-6" data-testid="connected-apps-unauthenticated">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Aplikasi AI Terhubung
          </h1>
          <p className="text-sm text-muted-foreground">
            Kelola koneksi agen AI (MCP) untuk situs PunyaSitus Anda.
          </p>
        </div>

        <Alert variant="warning" data-testid="connected-apps-session-expired-alert">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Sesi belum aktif atau telah berakhir</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>Masuk terlebih dahulu untuk melihat atau mencabut akses aplikasi AI Anda.</p>
            <Button
              size="sm"
              className="min-h-11"
              render={<a href="/auth/login?next=/account/connected-apps&expired=1" />}
            >
              Masuk ke Akun
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-20 md:pb-0" data-testid="connected-apps-ready">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Aplikasi AI Terhubung
          </h1>
          <p className="text-sm text-muted-foreground">
            Kelola agen AI (ChatGPT, Claude, atau klien MCP lain) yang diizinkan mengelola draf
            situs Anda.
          </p>
        </div>

        <nav aria-label="Menu akun" className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="min-h-11" render={<a href="/account" />}>
            Profil &amp; Sesi
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11"
            render={<a href="/account/security" />}
          >
            Keamanan &amp; 2FA
          </Button>
        </nav>
      </div>

      {statusBanner && (
        <Alert
          variant={statusBanner.kind === "error" ? "destructive" : "default"}
          role="alert"
          data-testid="connected-apps-status-alert"
        >
          {statusBanner.kind === "error" ? (
            <AlertCircleIcon className="size-4" aria-hidden="true" />
          ) : (
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
          )}
          <AlertTitle>{statusBanner.title}</AlertTitle>
          <AlertDescription>{statusBanner.text}</AlertDescription>
        </Alert>
      )}

      {/* MCP Endpoint Reference */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BotIcon className="size-4 text-primary" aria-hidden="true" />
            Alamat Server MCP PunyaSitus
          </CardTitle>
          <CardDescription>
            Masukkan URL ini pada pengaturan Custom MCP Connector di aplikasi AI Anda. Hanya
            Pemilik (Owner) atau Admin situs yang dapat menyetujui koneksi.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 font-mono text-xs text-foreground break-all">
            {mcpEndpointUrl}
          </div>
        </CardContent>
      </Card>

      {/* Active Grants */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-lg">Koneksi Aktif</CardTitle>
              <CardDescription>
                Setiap koneksi terikat pada tepat satu situs dan dapat dicabut kapan saja dengan
                efek langsung pada panggilan berikutnya.
              </CardDescription>
            </div>
            <Badge variant="outline" className="tabular-nums" data-testid="active-grants-count">
              {activeGrants.length} aktif
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {activeGrants.length === 0 ? (
            <div
              className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
              data-testid="connected-apps-empty"
            >
              Belum ada aplikasi AI yang terhubung ke akun Anda.
            </div>
          ) : (
            <ul className="divide-y divide-border" data-testid="active-grants-list">
              {activeGrants.map((grant) => (
                <li
                  key={grant.id}
                  className="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
                  data-testid={`grant-row-${grant.id}`}
                >
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-semibold text-foreground">
                        {grant.clientName}
                      </span>
                      <Badge variant="secondary" className="gap-1">
                        <GlobeIcon className="size-3" aria-hidden="true" />
                        {grant.tenantName} ({grant.tenantHandle})
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground break-all">{grant.clientId}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {grant.scopes.map((scope) => (
                        <Badge key={scope} variant="outline" className="text-[11px]">
                          {SCOPE_LABELS[scope] ?? scope}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                      <span>Terhubung: {formatWib(grant.createdAt)}</span>
                      <span>Terakhir dipakai: {formatWib(grant.lastUsedAt)}</span>
                    </div>
                  </div>

                  <div className="shrink-0">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      className="min-h-11 w-full sm:w-auto"
                      disabled={revokingId === grant.id}
                      onClick={() => handleRevoke(grant)}
                      data-testid={`revoke-grant-${grant.id}`}
                    >
                      <Unlink2Icon className="size-4" aria-hidden="true" />
                      {revokingId === grant.id ? "Mencabut..." : "Cabut Akses"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Recently Revoked Grants */}
      {revokedGrants.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-muted-foreground">
              <ShieldOffIcon className="size-4" aria-hidden="true" />
              Riwayat Akses Dicabut
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border text-sm" data-testid="revoked-grants-list">
              {revokedGrants.map((grant) => (
                <li
                  key={grant.id}
                  className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <span className="font-medium text-foreground">{grant.clientName}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      — {grant.tenantName} ({grant.tenantHandle})
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                    <Badge variant="outline">Dicabut</Badge>
                    <span>{formatWib(grant.revokedAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

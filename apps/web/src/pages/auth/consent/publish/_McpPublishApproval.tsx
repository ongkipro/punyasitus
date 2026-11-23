import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  FileCheck2Icon,
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

export interface McpPublishApprovalProps {
  readonly authenticated: boolean;
  readonly token: string;
  readonly loginHref: string;
  readonly notFound: boolean;
  readonly expired: boolean;
  readonly canApprove: boolean;
  readonly roleError: string | null;
  readonly approval: {
    readonly id: string;
    readonly tenantHandle: string;
    readonly tenantName: string;
    readonly clientName: string;
    readonly resourceType: "page" | "post" | "offering";
    readonly resourceId: number;
    readonly expectedVersion: number;
    readonly resourceTitle: string;
    readonly resourceSlug: string | null;
    readonly status: string;
    readonly expiresAtIso: string;
  } | null;
}

function resourceTypeLabel(kind: "page" | "post" | "offering"): string {
  if (kind === "page") return "Halaman";
  if (kind === "post") return "Artikel Blog";
  return "Penawaran Katalog";
}

function formatWib(iso: string): string {
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

export function McpPublishApprovalScreen(props: McpPublishApprovalProps) {
  const [pending, setPending] = React.useState<"approve" | "reject" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<{
    readonly kind: "published" | "held_for_review" | "rejected";
    readonly message: string;
  } | null>(null);

  async function submitDecision(decision: "approve" | "reject") {
    setError(null);
    setPending(decision);
    try {
      const res = await fetch("/api/auth/mcp/publish-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token: props.token, decision }),
      });
      const data = (await res.json()) as {
        readonly success?: boolean;
        readonly decision?: string;
        readonly outcome?: string;
        readonly ownerNotice?: string;
        readonly message?: string;
      };
      if (!res.ok || !data.success) {
        setError(data.message ?? "Gagal memproses konfirmasi publikasi.");
        setPending(null);
        return;
      }

      if (data.decision === "rejected") {
        setOutcome({
          kind: "rejected",
          message: "Permintaan publikasi ditolak. Konten tetap tersimpan sebagai draf pribadi.",
        });
      } else if (data.outcome === "held_for_review") {
        setOutcome({
          kind: "held_for_review",
          message:
            data.ownerNotice ??
            "Konten ditahan untuk ditinjau keamanan dan tetap berstatus draf.",
        });
      } else {
        setOutcome({
          kind: "published",
          message: "Draf berhasil diterbitkan ke situs publik setelah konfirmasi Anda.",
        });
      }
    } catch {
      setError("Gagal menghubungi server. Coba lagi.");
    } finally {
      setPending(null);
    }
  }

  if (props.notFound || !props.approval) {
    return (
      <div className="w-full max-w-lg space-y-4" data-testid="publish-approval-not-found">
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Tautan persetujuan tidak ditemukan</AlertTitle>
          <AlertDescription>
            Tautan publikasi tidak valid atau sudah tidak berlaku.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!props.authenticated) {
    return (
      <Card className="w-full max-w-lg" data-testid="publish-approval-unauth">
        <CardHeader>
          <CardTitle className="text-xl">Masuk untuk meninjau publikasi</CardTitle>
          <CardDescription>
            Masuk sebagai Pemilik atau Admin situs <strong>{props.approval.tenantName}</strong>{" "}
            untuk menyetujui atau menolak permintaan publikasi ini.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="min-h-11 w-full" render={<a href={props.loginHref} />}>
            Masuk ke Akun PunyaSitus
          </Button>
        </CardContent>
      </Card>
    );
  }

  const a = props.approval;

  return (
    <Card className="w-full max-w-xl" data-testid="publish-approval-card">
      <CardHeader className="space-y-2 border-b border-border pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{resourceTypeLabel(a.resourceType)}</Badge>
          <Badge variant="secondary">Revisi v{a.expectedVersion}</Badge>
        </div>
        <CardTitle className="flex items-center gap-2 text-xl">
          <FileCheck2Icon className="size-5 text-primary" aria-hidden="true" />
          Konfirmasi Publikasi Draf
        </CardTitle>
        <CardDescription>
          <strong>{a.clientName}</strong> meminta Anda menerbitkan draf berikut pada situs{" "}
          <strong>{a.tenantName}</strong> ({a.tenantHandle}.situsku.click).
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 pt-5">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertCircleIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Tidak dapat memproses</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {outcome ? (
          <Alert
            variant={outcome.kind === "published" ? "default" : "warning"}
            data-testid="publish-approval-outcome"
          >
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
            <AlertTitle>
              {outcome.kind === "published"
                ? "Konten Berhasil Diterbitkan"
                : outcome.kind === "held_for_review"
                  ? "Konten Ditahan untuk Ditinjau"
                  : "Publikasi Dibatalkan"}
            </AlertTitle>
            <AlertDescription>{outcome.message}</AlertDescription>
          </Alert>
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-3 rounded-md border border-border bg-muted/30 p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Judul Draf</dt>
                <dd className="font-medium text-foreground">{a.resourceTitle}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Slug / ID</dt>
                <dd className="font-mono text-xs text-foreground">
                  {a.resourceSlug ?? `#${a.resourceId}`} (#{a.resourceId})
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Aplikasi AI Peminta</dt>
                <dd className="text-foreground">{a.clientName}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Berlaku Hingga</dt>
                <dd className="tabular-nums text-foreground">{formatWib(a.expiresAtIso)}</dd>
              </div>
            </dl>

            {props.expired || a.status !== "pending" ? (
              <Alert variant="warning">
                <ShieldAlertIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Permintaan tidak lagi aktif</AlertTitle>
                <AlertDescription>
                  Status saat ini: <strong>{props.expired ? "kedaluwarsa" : a.status}</strong>.
                  Tautan ini hanya berlaku satu kali.
                </AlertDescription>
              </Alert>
            ) : !props.canApprove ? (
              <Alert variant="destructive" role="alert">
                <ShieldAlertIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Akses ditolak</AlertTitle>
                <AlertDescription>
                  {props.roleError ??
                    "Hanya Pemilik (Owner) atau Admin situs yang dapat mengonfirmasi publikasi."}
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="flex items-start gap-2.5 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                  <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <p>
                    Pastikan Anda telah memeriksa isi draf sebelum menerbitkan. Agen AI tidak dapat
                    menekan tombol konfirmasi ini tanpa tindakan Anda di browser.
                  </p>
                </div>

                <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full sm:w-auto"
                    disabled={pending !== null}
                    onClick={() => submitDecision("reject")}
                    data-testid="publish-approval-reject"
                  >
                    {pending === "reject" ? "Membatalkan..." : "Tolak & Simpan sebagai Draf"}
                  </Button>
                  <Button
                    type="button"
                    className="min-h-11 w-full sm:w-auto"
                    disabled={pending !== null}
                    onClick={() => submitDecision("approve")}
                    data-testid="publish-approval-confirm"
                  >
                    {pending === "approve" ? "Menerbitkan..." : "Terbitkan Sekarang"}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

import * as React from "react";
import { AlertCircleIcon, Building2Icon, CheckCircle2Icon, KeyRoundIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface AgencyEnrollmentPanelProps {
  readonly userEmail: string;
  readonly userName: string;
  readonly initialInviteToken?: string;
}

export function AgencyEnrollmentPanel({
  userEmail,
  userName,
  initialInviteToken = "",
}: AgencyEnrollmentPanelProps) {
  const [mode, setMode] = React.useState<"self" | "invite">(
    initialInviteToken ? "invite" : "self",
  );
  const [agencyName, setAgencyName] = React.useState("");
  const [billingEmail, setBillingEmail] = React.useState(userEmail);
  const [inviteToken, setInviteToken] = React.useState(initialInviteToken);
  const [acceptTerms, setAcceptTerms] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [successMsg, setSuccessMsg] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!acceptTerms) {
      setErrorMsg("Centang persetujuan syarat dan ketentuan program agensi terlebih dahulu.");
      return;
    }

    setSubmitting(true);
    try {
      const endpoint = mode === "invite" ? "/api/agency/invitations/accept" : "/api/agency/enroll";
      const payload =
        mode === "invite"
          ? {
              token: inviteToken.trim(),
              ...(agencyName.trim() ? { agencyName: agencyName.trim() } : {}),
              billingEmail: billingEmail.trim(),
              acceptTerms: true,
            }
          : {
              agencyName: agencyName.trim(),
              billingEmail: billingEmail.trim(),
              billingName: agencyName.trim(),
              acceptTerms: true,
            };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly error?: { readonly message?: string };
      };

      if (!res.ok || !data.success) {
        setErrorMsg(data.error?.message ?? "Gagal menyelesaikan pendaftaran agensi.");
        return;
      }

      setSuccessMsg("Akun agensi berhasil diaktifkan. Memuat Portal Agensi...");
      window.location.href = "/agency";
    } catch {
      setErrorMsg("Koneksi gagal. Silakan coba lagi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="agency-enrollment-panel">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={mode === "self" ? "default" : "outline"}
          className="min-h-11 md:min-h-9"
          onClick={() => {
            setMode("self");
            setErrorMsg(null);
          }}
        >
          <Building2Icon className="size-4" aria-hidden="true" />
          Daftar Mandiri
        </Button>
        <Button
          type="button"
          variant={mode === "invite" ? "default" : "outline"}
          className="min-h-11 md:min-h-9"
          onClick={() => {
            setMode("invite");
            setErrorMsg(null);
          }}
        >
          <KeyRoundIcon className="size-4" aria-hidden="true" />
          Terima Undangan Operator
        </Button>
      </div>

      {errorMsg && (
        <Alert variant="destructive" data-testid="agency-enroll-error">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Pendaftaran belum berhasil</AlertTitle>
          <AlertDescription>{errorMsg}</AlertDescription>
        </Alert>
      )}

      {successMsg && (
        <Alert variant="info" data-testid="agency-enroll-success">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Berhasil</AlertTitle>
          <AlertDescription>{successMsg}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {mode === "invite" ? "Aktivasi Undangan Agensi" : "Daftar sebagai Mitra Agensi"}
          </CardTitle>
          <CardDescription>
            Akun terverifikasi ({userName} — {userEmail}) dengan 2FA aktif. Agensi baru dimulai
            pada diskon 0% dengan kuota maksimal 3 situs uji coba sebelum klien berbayar pertama.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "invite" && (
              <div className="space-y-1.5">
                <label htmlFor="agency-invite-token" className="block text-sm font-medium text-foreground">
                  Token Undangan Operator
                </label>
                <Input
                  id="agency-invite-token"
                  type="text"
                  value={inviteToken}
                  onChange={(e) => setInviteToken(e.target.value)}
                  placeholder="Tempel token undangan dari operator"
                  required
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="agency-name-input" className="block text-sm font-medium text-foreground">
                Nama Agensi / Studio
              </label>
              <Input
                id="agency-name-input"
                type="text"
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
                placeholder="Contoh: Nusantara Digital Studio"
                required={mode === "self"}
                className="min-h-11 text-base md:min-h-9 md:text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="agency-billing-email" className="block text-sm font-medium text-foreground">
                Email Tagihan &amp; Kuitansi Agensi
              </label>
              <Input
                id="agency-billing-email"
                type="email"
                value={billingEmail}
                onChange={(e) => setBillingEmail(e.target.value)}
                required
                className="min-h-11 text-base md:min-h-9 md:text-sm"
              />
            </div>

            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground">
              <input
                type="checkbox"
                checked={acceptTerms}
                onChange={(e) => setAcceptTerms(e.target.checked)}
                data-testid="agency-accept-terms"
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <span>
                Saya menyetujui syarat program agensi PunyaSitus: seluruh tagihan, pengingat
                perpanjangan, dan kuitansi situs klien ditanggung 100% oleh agensi, dan seluruh
                staf agensi wajib menggunakan autentikasi dua faktor (TOTP 2FA).
              </span>
            </label>

            <Button
              type="submit"
              disabled={submitting}
              data-testid="agency-enroll-submit"
              className="min-h-11 w-full sm:w-auto md:min-h-9"
            >
              {submitting
                ? "Memproses..."
                : mode === "invite"
                  ? "Terima Undangan & Aktifkan Agensi"
                  : "Aktifkan Portal Agensi"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

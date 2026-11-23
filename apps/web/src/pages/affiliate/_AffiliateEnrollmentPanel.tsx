import * as React from "react";
import { CheckCircle2, ShieldCheck, Wallet } from "lucide-react";
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

export interface AffiliateEnrollmentPanelProps {
  readonly userName: string;
  readonly userEmail: string;
  readonly emailVerified: boolean;
}

const DEFAULT_TERMS_VERSION = "2026-11-v1";

export function AffiliateEnrollmentPanel({
  userName,
  userEmail,
  emailVerified,
}: AffiliateEnrollmentPanelProps) {
  const [payoutBankCode, setPayoutBankCode] = React.useState("BCA");
  const [payoutAccountNumber, setPayoutAccountNumber] = React.useState("");
  const [payoutAccountHolder, setPayoutAccountHolder] = React.useState(userName);
  const [termsAccepted, setTermsAccepted] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [successMsg, setSuccessMsg] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!emailVerified) {
      setErrorMsg("Verifikasi alamat email Anda terlebih dahulu sebelum mendaftar sebagai afiliasi.");
      return;
    }

    if (!termsAccepted) {
      setErrorMsg("Centang persetujuan syarat dan ketentuan program afiliasi terlebih dahulu.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/affiliates/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          payoutBankCode: payoutBankCode.trim(),
          payoutAccountNumber: payoutAccountNumber.trim(),
          payoutAccountHolder: payoutAccountHolder.trim(),
          termsAccepted: true,
          termsVersion: DEFAULT_TERMS_VERSION,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly message?: string;
        readonly error?: { readonly message?: string };
      };

      if (!res.ok || !data.success) {
        setErrorMsg(
          data.message ?? data.error?.message ?? "Gagal mengirim pendaftaran program afiliasi.",
        );
        return;
      }

      setSuccessMsg("Pendaftaran afiliasi berhasil dikirim. Memuat Portal Afiliasi...");
      window.location.href = "/affiliate";
    } catch {
      setErrorMsg("Koneksi gagal saat mengirim pendaftaran afiliasi. Silakan coba lagi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="affiliate-enrollment-panel">
      {!emailVerified && (
        <Alert variant="warning" data-testid="affiliate-unverified-email-alert">
          <ShieldCheck className="size-4" aria-hidden="true" />
          <AlertTitle>Verifikasi email diperlukan</AlertTitle>
          <AlertDescription>
            Akun Anda ({userEmail}) belum terverifikasi. Selesaikan verifikasi email sebelum
            mengajukan pendaftaran mitra afiliasi.
          </AlertDescription>
        </Alert>
      )}

      {errorMsg && (
        <Alert variant="destructive" data-testid="affiliate-enroll-error">
          <AlertTitle>Pendaftaran belum berhasil</AlertTitle>
          <AlertDescription>{errorMsg}</AlertDescription>
        </Alert>
      )}

      {successMsg && (
        <Alert variant="info" data-testid="affiliate-enroll-success">
          <CheckCircle2 className="size-4" aria-hidden="true" />
          <AlertTitle>Pendaftaran diterima</AlertTitle>
          <AlertDescription>{successMsg}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="size-4 text-primary" aria-hidden="true" />
            Daftar Program Afiliasi PunyaSitus
          </CardTitle>
          <CardDescription>
            Komisi 60% pada pembayaran pertama tenant rujukan dan 20% untuk setiap perpanjangan
            berikutnya (masa tunggu 14 hari, pencairan setiap tanggal 15 &amp; 30 WIB, minimal Rp
            100.000). Akun afiliasi terpisah dari situs tenant Anda.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="affiliate-bank-code"
                  className="block text-sm font-medium text-foreground"
                >
                  Bank atau E-Wallet Pencairan
                </label>
                <Input
                  id="affiliate-bank-code"
                  type="text"
                  value={payoutBankCode}
                  onChange={(e) => setPayoutBankCode(e.target.value)}
                  placeholder="Contoh: BCA, MANDIRI, BRI, GOPAY"
                  required
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="affiliate-account-number"
                  className="block text-sm font-medium text-foreground"
                >
                  Nomor Rekening / E-Wallet
                </label>
                <Input
                  id="affiliate-account-number"
                  type="text"
                  inputMode="numeric"
                  value={payoutAccountNumber}
                  onChange={(e) => setPayoutAccountNumber(e.target.value)}
                  placeholder="Masukkan 6–32 digit angka"
                  required
                  className="min-h-11 text-base tabular-nums md:min-h-9 md:text-sm"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="affiliate-account-holder"
                className="block text-sm font-medium text-foreground"
              >
                Nama Pemilik Rekening
              </label>
              <Input
                id="affiliate-account-holder"
                type="text"
                value={payoutAccountHolder}
                onChange={(e) => setPayoutAccountHolder(e.target.value)}
                placeholder="Nama sesuai buku tabungan atau akun e-wallet"
                required
                className="min-h-11 text-base md:min-h-9 md:text-sm"
              />
            </div>

            <label
              htmlFor="affiliate-accept-terms"
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground"
            >
              <input
                id="affiliate-accept-terms"
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                data-testid="affiliate-accept-terms"
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <span>
                Saya menyetujui Syarat &amp; Ketentuan Program Afiliasi PunyaSitus (versi{" "}
                {DEFAULT_TERMS_VERSION}), termasuk larangan rujukan ke akun sendiri, masa tunggu
                komisi 14 hari, serta penyesuaian pajak dan pengembalian dana sesuai kebijakan
                platform.
              </span>
            </label>

            <Button
              type="submit"
              disabled={submitting || !emailVerified}
              data-testid="affiliate-enroll-submit"
              className="min-h-11 w-full sm:w-auto md:min-h-9"
            >
              {submitting ? "Mengirim pendaftaran..." : "Ajukan Pendaftaran Afiliasi"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  MailCheckIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface AcceptInvitationProps {
  readonly handle: string;
  readonly inviteToken: string;
  readonly userEmail: string | null;
}

export function AcceptInvitation({
  handle,
  inviteToken,
  userEmail,
}: AcceptInvitationProps) {
  const [pending, setPending] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [acceptedRole, setAcceptedRole] = React.useState<string | null>(null);

  const apiUrl = `/dashboard/${encodeURIComponent(handle)}/settings/members/accept/api`;
  const dashboardUrl = `/dashboard/${encodeURIComponent(handle)}`;
  const loginUrl = `/auth/login?next=${encodeURIComponent(
    `/dashboard/${handle}/settings/members/accept?inviteToken=${inviteToken}`,
  )}`;

  async function handleAccept() {
    setErrorMsg(null);
    if (!inviteToken || inviteToken.trim().length < 16) {
      setErrorMsg("Tautan undangan tidak memuat token yang valid.");
      return;
    }

    setPending(true);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "accept-invitation",
          token: inviteToken.trim(),
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        membership?: { readonly role?: string };
      };
      if (!res.ok || !data.success) {
        setErrorMsg(data.message ?? "Undangan tidak dapat diterima.");
        return;
      }
      setAcceptedRole(data.membership?.role ?? "member");
    } catch {
      setErrorMsg("Koneksi terputus saat memproses undangan. Silakan coba lagi.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="mx-auto max-w-lg space-y-6 py-10 px-4"
      data-testid="accept-invitation-page"
      data-handle={handle}
    >
      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center gap-2 text-lg">
            <MailCheckIcon className="size-5 text-primary" aria-hidden="true" />
            Terima Undangan Tim Situs
          </CardTitle>
          <CardDescription>
            Undangan bersifat sekali pakai, berlaku 48 jam, dan terikat pada alamat email yang
            diundang untuk situs <code className="font-mono text-xs">{handle}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          {!userEmail ? (
            <div className="space-y-4" data-testid="accept-invite-unauthenticated">
              <Alert variant="info">
                <ShieldAlertIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Masuk terlebih dahulu</AlertTitle>
                <AlertDescription>
                  Masuk menggunakan akun dengan alamat email yang menerima undangan ini untuk
                  melanjutkan.
                </AlertDescription>
              </Alert>
              <Button
                render={<a href={loginUrl} />}
                className="min-h-11 w-full md:min-h-9"
                data-testid="accept-invite-login-link"
              >
                Masuk untuk menerima undangan
              </Button>
            </div>
          ) : acceptedRole ? (
            <div className="space-y-4" data-testid="accept-invite-success">
              <Alert variant="success" role="status">
                <CheckCircle2Icon className="size-4" aria-hidden="true" />
                <AlertTitle>Undangan diterima</AlertTitle>
                <AlertDescription>
                  Akun <strong>{userEmail}</strong> kini terdaftar sebagai{" "}
                  <strong>{acceptedRole}</strong> pada situs <code>{handle}</code>.
                </AlertDescription>
              </Alert>
              <Button
                render={<a href={dashboardUrl} />}
                className="min-h-11 w-full md:min-h-9"
                data-testid="accept-invite-dashboard-link"
              >
                Buka Dashboard Situs
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {errorMsg && (
                <Alert variant="destructive" data-testid="accept-invite-error">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Undangan tidak dapat diproses</AlertTitle>
                  <AlertDescription>{errorMsg}</AlertDescription>
                </Alert>
              )}

              <p className="text-sm text-muted-foreground">
                Anda masuk sebagai <strong className="text-foreground">{userEmail}</strong>.
                Pastikan alamat email ini sama persis dengan alamat email penerima undangan.
              </p>

              <Button
                type="button"
                disabled={pending || !inviteToken}
                onClick={handleAccept}
                className="min-h-11 w-full md:min-h-9"
                data-testid="accept-invite-submit"
              >
                {pending ? "Memverifikasi undangan..." : "Terima undangan sekarang"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

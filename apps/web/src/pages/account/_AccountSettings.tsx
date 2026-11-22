import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  KeyRoundIcon,
  LogOutIcon,
  MailIcon,
  MonitorSmartphoneIcon,
  ShieldAlertIcon,
  UserIcon,
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
import { Input } from "@/components/ui/input";

export interface AccountUserView {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface AccountSessionView {
  readonly id: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly isCurrent: boolean;
}

export interface AccountSettingsProps {
  readonly initialUser: AccountUserView | null;
  readonly initialSessions: readonly AccountSessionView[];
}

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function formatIsoTimestamp(iso: string): string {
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

export function AccountSettings({ initialUser, initialSessions }: AccountSettingsProps) {
  const [user, setUser] = React.useState<AccountUserView | null>(initialUser);
  const [sessions, setSessions] = React.useState<readonly AccountSessionView[]>(initialSessions);

  // 1. Profile display name form
  const [displayName, setDisplayName] = React.useState(initialUser?.name ?? "");
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [profileStatus, setProfileStatus] = React.useState<{
    readonly kind: "success" | "error";
    readonly text: string;
  } | null>(null);
  const [profilePending, setProfilePending] = React.useState(false);

  // 2. Email change form (requires reauthentication)
  const [newEmail, setNewEmail] = React.useState("");
  const [emailReauthPassword, setEmailReauthPassword] = React.useState("");
  const [newEmailError, setNewEmailError] = React.useState<string | null>(null);
  const [emailReauthError, setEmailReauthError] = React.useState<string | null>(null);
  const [emailStatus, setEmailStatus] = React.useState<{
    readonly kind: "success" | "error";
    readonly text: string;
  } | null>(null);
  const [emailPending, setEmailPending] = React.useState(false);

  // 3. Password change form (requires current password reauthentication)
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [currentPassError, setCurrentPassError] = React.useState<string | null>(null);
  const [newPassError, setNewPassError] = React.useState<string | null>(null);
  const [confirmPassError, setConfirmPassError] = React.useState<string | null>(null);
  const [passwordStatus, setPasswordStatus] = React.useState<{
    readonly kind: "success" | "error";
    readonly text: string;
  } | null>(null);
  const [passwordPending, setPasswordPending] = React.useState(false);

  // 4. Active session revocation (requires reauthentication)
  const [revokeReauthPassword, setRevokeReauthPassword] = React.useState("");
  const [revokeReauthError, setRevokeReauthError] = React.useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = React.useState<{
    readonly kind: "success" | "error";
    readonly text: string;
  } | null>(null);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);

  if (!user) {
    return (
      <div className="mx-auto max-w-2xl space-y-6" data-testid="account-unauthenticated">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Akun Saya</h1>
          <p className="text-sm text-muted-foreground">
            Kelola profil pribadi, alamat email, kata sandi, dan sesi aktif akun Anda.
          </p>
        </div>

        <Alert variant="warning" data-testid="account-session-expired-alert">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Sesi belum aktif atau telah berakhir</AlertTitle>
          <AlertDescription>
            Anda perlu masuk terlebih dahulu untuk mengakses atau mengubah pengaturan akun pribadi.
          </AlertDescription>
        </Alert>

        <Button
          render={<a href="/auth/login?next=/account&expired=1" />}
          className="min-h-11 md:min-h-10"
          data-testid="account-login-cta"
        >
          Masuk ke akun Anda
        </Button>
      </div>
    );
  }

  async function handleProfileSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileStatus(null);
    const trimmed = displayName.trim();
    if (trimmed.length < 2 || trimmed.length > 120) {
      setNameError("Nama tampilan harus terdiri dari 2 hingga 120 karakter.");
      return;
    }
    setNameError(null);
    setProfilePending(true);
    try {
      const res = await fetch("/api/auth/account/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name: trimmed }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        user?: AccountUserView;
        message?: string;
      };
      if (!res.ok || !data.success || !data.user) {
        setProfileStatus({
          kind: "error",
          text: data.message ?? "Gagal menyimpan nama tampilan. Coba lagi.",
        });
        return;
      }
      setUser(data.user);
      setDisplayName(data.user.name);
      setProfileStatus({ kind: "success", text: "Nama tampilan berhasil diperbarui." });
    } catch {
      setProfileStatus({
        kind: "error",
        text: "Koneksi terputus. Perubahan Anda belum tersimpan, silakan coba lagi.",
      });
    } finally {
      setProfilePending(false);
    }
  }

  async function handleEmailSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailStatus(null);

    const trimmedEmail = newEmail.trim().toLowerCase();
    let emailErr: string | null = null;
    let passErr: string | null = null;

    if (!trimmedEmail) {
      emailErr = "Alamat email baru wajib diisi.";
    } else if (!SIMPLE_EMAIL_RE.test(trimmedEmail)) {
      emailErr = "Format alamat email baru tidak valid.";
    } else if (user && trimmedEmail === user.email.toLowerCase()) {
      emailErr = "Email baru harus berbeda dari email saat ini.";
    }

    if (!emailReauthPassword) {
      passErr = "Kata sandi saat ini wajib diisi untuk autentikasi ulang.";
    }

    setNewEmailError(emailErr);
    setEmailReauthError(passErr);
    if (emailErr || passErr) return;

    setEmailPending(true);
    try {
      const res = await fetch("/api/auth/account/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          newEmail: trimmedEmail,
          currentPassword: emailReauthPassword,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        user?: AccountUserView;
        message?: string;
      };
      if (!res.ok || !data.success || !data.user) {
        setEmailStatus({
          kind: "error",
          text: data.message ?? "Gagal mengubah alamat email.",
        });
        return;
      }
      setUser(data.user);
      setNewEmail("");
      setEmailReauthPassword("");
      setEmailStatus({
        kind: "success",
        text: "Alamat email berhasil diperbarui. Periksa kotak masuk baru Anda untuk verifikasi.",
      });
    } catch {
      setEmailStatus({
        kind: "error",
        text: "Koneksi terputus. Silakan coba lagi.",
      });
    } finally {
      setEmailPending(false);
    }
  }

  async function handlePasswordSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordStatus(null);

    let currErr: string | null = null;
    let nextErr: string | null = null;
    let confErr: string | null = null;

    if (!currentPassword) {
      currErr = "Kata sandi saat ini wajib diisi untuk autentikasi ulang.";
    }
    if (newPassword.length < 8) {
      nextErr = "Kata sandi baru minimal 8 karakter.";
    } else if (newPassword === currentPassword) {
      nextErr = "Kata sandi baru harus berbeda dari kata sandi saat ini.";
    }
    if (!confirmPassword) {
      confErr = "Konfirmasi kata sandi baru wajib diisi.";
    } else if (confirmPassword !== newPassword) {
      confErr = "Konfirmasi kata sandi tidak cocok.";
    }

    setCurrentPassError(currErr);
    setNewPassError(nextErr);
    setConfirmPassError(confErr);
    if (currErr || nextErr || confErr) return;

    setPasswordPending(true);
    try {
      const res = await fetch("/api/auth/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          currentPassword,
          newPassword,
          revokeOtherSessions: true,
        }),
      });
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setPasswordStatus({
          kind: "error",
          text: data.message ?? "Gagal mengubah kata sandi.",
        });
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordStatus({
        kind: "success",
        text: "Kata sandi berhasil diperbarui dan sesi di perangkat lain telah dicabut.",
      });
    } catch {
      setPasswordStatus({
        kind: "error",
        text: "Koneksi terputus saat memperbarui kata sandi. Silakan coba lagi.",
      });
    } finally {
      setPasswordPending(false);
    }
  }

  async function handleRevokeSession(sessionId: string) {
    setSessionStatus(null);
    if (!revokeReauthPassword) {
      setRevokeReauthError(
        "Masukkan kata sandi saat ini terlebih dahulu untuk mencabut sesi aktif.",
      );
      return;
    }
    setRevokeReauthError(null);
    setRevokingId(sessionId);

    try {
      const res = await fetch("/api/auth/account/revoke-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          sessionId,
          currentPassword: revokeReauthPassword,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        revokedCurrent?: boolean;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setSessionStatus({
          kind: "error",
          text: data.message ?? "Gagal mencabut sesi.",
        });
        return;
      }

      if (data.revokedCurrent) {
        window.location.assign("/auth/login?expired=1");
        return;
      }

      setSessions((prev) => prev.filter((item) => item.id !== sessionId));
      setSessionStatus({
        kind: "success",
        text: "Sesi perangkat yang dipilih telah dicabut.",
      });
    } catch {
      setSessionStatus({
        kind: "error",
        text: "Koneksi terputus saat mencabut sesi. Silakan coba lagi.",
      });
    } finally {
      setRevokingId(null);
    }
  }

  async function handleSignOut() {
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({}),
      });
    } finally {
      window.location.assign("/auth/login");
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="account-settings-ready">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Akun Saya</h1>
          <p className="text-sm text-muted-foreground">
            Pengaturan akun pribadi terpisah dari profil penulis blog publik dan pengaturan situs.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={handleSignOut}
          className="min-h-11 md:min-h-9"
          data-testid="account-signout-button"
        >
          <LogOutIcon className="size-4" aria-hidden="true" />
          Keluar
        </Button>
      </div>

      {/* 1. Profile display name */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex items-center gap-2 text-primary">
            <UserIcon className="size-4 shrink-0" aria-hidden="true" />
            <CardTitle>Profil Pribadi</CardTitle>
          </div>
          <CardDescription>
            Nama ini digunakan pada dasbor dan notifikasi akun PunyaSitus Anda.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {profileStatus && (
            <Alert
              variant={profileStatus.kind === "success" ? "success" : "destructive"}
              data-testid="profile-status-alert"
            >
              {profileStatus.kind === "success" ? (
                <CheckCircle2Icon className="size-4" aria-hidden="true" />
              ) : (
                <AlertCircleIcon className="size-4" aria-hidden="true" />
              )}
              <AlertDescription>{profileStatus.text}</AlertDescription>
            </Alert>
          )}

          <form
            onSubmit={handleProfileSubmit}
            noValidate
            className="space-y-4"
            data-testid="profile-form"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="account-display-name"
                className="block text-sm font-medium text-foreground"
              >
                Nama tampilan
              </label>
              <Input
                id="account-display-name"
                name="name"
                type="text"
                autoComplete="name"
                required
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  if (nameError) setNameError(null);
                }}
                aria-invalid={nameError ? "true" : undefined}
                aria-describedby={nameError ? "account-display-name-error" : undefined}
                disabled={profilePending}
              />
              {nameError && (
                <p
                  id="account-display-name-error"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                >
                  {nameError}
                </p>
              )}
            </div>

            <Button
              type="submit"
              disabled={profilePending}
              className="min-h-11 md:min-h-9"
              data-testid="profile-save-button"
            >
              {profilePending ? "Menyimpan..." : "Simpan nama tampilan"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* 2. Email change (reauthentication required) */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-primary">
              <MailIcon className="size-4 shrink-0" aria-hidden="true" />
              <CardTitle>Alamat Email Akun</CardTitle>
            </div>
            <Badge variant={user.emailVerified ? "success" : "warning"}>
              {user.emailVerified ? "Terverifikasi" : "Menunggu verifikasi"}
            </Badge>
          </div>
          <CardDescription>
            Email aktif saat ini: <strong className="text-foreground">{user.email}</strong>.
            Autentikasi ulang dengan kata sandi wajib dilakukan untuk mengubah email.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {emailStatus && (
            <Alert
              variant={emailStatus.kind === "success" ? "success" : "destructive"}
              data-testid="email-status-alert"
            >
              {emailStatus.kind === "success" ? (
                <CheckCircle2Icon className="size-4" aria-hidden="true" />
              ) : (
                <AlertCircleIcon className="size-4" aria-hidden="true" />
              )}
              <AlertDescription>{emailStatus.text}</AlertDescription>
            </Alert>
          )}

          <form
            onSubmit={handleEmailSubmit}
            noValidate
            className="space-y-4"
            data-testid="email-change-form"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="account-new-email"
                className="block text-sm font-medium text-foreground"
              >
                Alamat email baru
              </label>
              <Input
                id="account-new-email"
                name="newEmail"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                value={newEmail}
                onChange={(e) => {
                  setNewEmail(e.target.value);
                  if (newEmailError) setNewEmailError(null);
                }}
                aria-invalid={newEmailError ? "true" : undefined}
                aria-describedby={newEmailError ? "account-new-email-error" : undefined}
                placeholder="emailbaru@bisnisanda.id"
                disabled={emailPending}
              />
              {newEmailError && (
                <p
                  id="account-new-email-error"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                >
                  {newEmailError}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="account-email-reauth-password"
                className="block text-sm font-medium text-foreground"
              >
                Kata sandi saat ini (autentikasi ulang)
              </label>
              <Input
                id="account-email-reauth-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                value={emailReauthPassword}
                onChange={(e) => {
                  setEmailReauthPassword(e.target.value);
                  if (emailReauthError) setEmailReauthError(null);
                }}
                aria-invalid={emailReauthError ? "true" : undefined}
                aria-describedby={emailReauthError ? "account-email-reauth-error" : undefined}
                disabled={emailPending}
              />
              {emailReauthError && (
                <p
                  id="account-email-reauth-error"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                >
                  {emailReauthError}
                </p>
              )}
            </div>

            <Button
              type="submit"
              disabled={emailPending}
              className="min-h-11 md:min-h-9"
              data-testid="email-save-button"
            >
              {emailPending ? "Memproses..." : "Ubah email"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* 3. Password change (reauthentication required) */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex items-center gap-2 text-primary">
            <KeyRoundIcon className="size-4 shrink-0" aria-hidden="true" />
            <CardTitle>Ubah Kata Sandi</CardTitle>
          </div>
          <CardDescription>
            Setelah kata sandi diubah, seluruh sesi di perangkat lain akan otomatis diakhiri.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {passwordStatus && (
            <Alert
              variant={passwordStatus.kind === "success" ? "success" : "destructive"}
              data-testid="password-status-alert"
            >
              {passwordStatus.kind === "success" ? (
                <CheckCircle2Icon className="size-4" aria-hidden="true" />
              ) : (
                <AlertCircleIcon className="size-4" aria-hidden="true" />
              )}
              <AlertDescription>{passwordStatus.text}</AlertDescription>
            </Alert>
          )}

          <form
            onSubmit={handlePasswordSubmit}
            noValidate
            className="space-y-4"
            data-testid="password-change-form"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="account-current-password"
                className="block text-sm font-medium text-foreground"
              >
                Kata sandi saat ini
              </label>
              <Input
                id="account-current-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                  if (currentPassError) setCurrentPassError(null);
                }}
                aria-invalid={currentPassError ? "true" : undefined}
                aria-describedby={currentPassError ? "account-current-password-error" : undefined}
                disabled={passwordPending}
              />
              {currentPassError && (
                <p
                  id="account-current-password-error"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                >
                  {currentPassError}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="account-new-password"
                className="block text-sm font-medium text-foreground"
              >
                Kata sandi baru
              </label>
              <Input
                id="account-new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  if (newPassError) setNewPassError(null);
                }}
                aria-invalid={newPassError ? "true" : undefined}
                aria-describedby={newPassError ? "account-new-password-error" : undefined}
                disabled={passwordPending}
              />
              {newPassError && (
                <p
                  id="account-new-password-error"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                >
                  {newPassError}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="account-confirm-password"
                className="block text-sm font-medium text-foreground"
              >
                Konfirmasi kata sandi baru
              </label>
              <Input
                id="account-confirm-password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (confirmPassError) setConfirmPassError(null);
                }}
                aria-invalid={confirmPassError ? "true" : undefined}
                aria-describedby={confirmPassError ? "account-confirm-password-error" : undefined}
                disabled={passwordPending}
              />
              {confirmPassError && (
                <p
                  id="account-confirm-password-error"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                >
                  {confirmPassError}
                </p>
              )}
            </div>

            <Button
              type="submit"
              disabled={passwordPending}
              className="min-h-11 md:min-h-9"
              data-testid="password-save-button"
            >
              {passwordPending ? "Menyimpan..." : "Ubah kata sandi"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* 4. Active sessions list & revoke (reauthentication required) */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex items-center gap-2 text-primary">
            <MonitorSmartphoneIcon className="size-4 shrink-0" aria-hidden="true" />
            <CardTitle>Sesi Aktif</CardTitle>
          </div>
          <CardDescription>
            Perangkat yang sedang masuk ke akun Anda. Masukkan kata sandi saat ini untuk mencabut
            akses perangkat.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sessionStatus && (
            <Alert
              variant={sessionStatus.kind === "success" ? "success" : "destructive"}
              data-testid="session-status-alert"
            >
              {sessionStatus.kind === "success" ? (
                <CheckCircle2Icon className="size-4" aria-hidden="true" />
              ) : (
                <AlertCircleIcon className="size-4" aria-hidden="true" />
              )}
              <AlertDescription>{sessionStatus.text}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="account-revoke-reauth-password"
              className="block text-sm font-medium text-foreground"
            >
              Kata sandi saat ini untuk mencabut sesi
            </label>
            <Input
              id="account-revoke-reauth-password"
              name="revokeCurrentPassword"
              type="password"
              autoComplete="current-password"
              value={revokeReauthPassword}
              onChange={(e) => {
                setRevokeReauthPassword(e.target.value);
                if (revokeReauthError) setRevokeReauthError(null);
              }}
              aria-invalid={revokeReauthError ? "true" : undefined}
              aria-describedby={revokeReauthError ? "account-revoke-reauth-error" : undefined}
            />
            {revokeReauthError && (
              <p
                id="account-revoke-reauth-error"
                role="alert"
                className="text-xs font-medium text-destructive"
              >
                {revokeReauthError}
              </p>
            )}
          </div>

          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada sesi aktif lainnya.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border" data-testid="active-sessions-list">
              {sessions.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {item.userAgent ? item.userAgent.slice(0, 72) : "Peramban Web"}
                      </span>
                      {item.isCurrent && <Badge variant="success">Sesi ini</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      IP: {item.ipAddress ?? "Tidak tercatat"} · Masuk:{" "}
                      {formatIsoTimestamp(item.createdAt)}
                    </p>
                  </div>

                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={revokingId === item.id}
                    onClick={() => handleRevokeSession(item.id)}
                    className="min-h-11 shrink-0 md:min-h-8"
                    data-testid={`revoke-session-${item.id}`}
                  >
                    {revokingId === item.id ? "Mencabut..." : "Cabut sesi"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

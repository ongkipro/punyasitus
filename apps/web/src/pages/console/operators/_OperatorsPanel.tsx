import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  UserMinusIcon,
  UserPlusIcon,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface ConsoleOperatorItem {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly emailVerified: boolean;
  readonly twoFactorEnabled: boolean;
  readonly role: "platform_superadmin" | "platform_support";
  readonly version: number;
  readonly grantedBy: string | null;
  readonly reason: string;
  readonly grantedAt: number;
  readonly revokedAt: number | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
  readonly isActive: boolean;
}

export interface OperatorsPanelProps {
  readonly initialOperators: readonly ConsoleOperatorItem[];
  readonly currentUserId: string;
  readonly stepUpFresh: boolean;
}

function formatRoleLabel(role: ConsoleOperatorItem["role"]): string {
  return role === "platform_support" ? "Dukungan Platform" : "Superadmin Platform";
}

function formatEpochId(ms: number | null): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Jakarta",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

export function OperatorsPanel({
  initialOperators,
  currentUserId,
  stepUpFresh,
}: OperatorsPanelProps) {
  const [operators, setOperators] = React.useState<readonly ConsoleOperatorItem[]>(initialOperators);
  const [loadingList, setLoadingList] = React.useState(false);

  // Grant form state
  const [targetEmail, setTargetEmail] = React.useState("");
  const [grantRole, setGrantRole] = React.useState<"platform_superadmin" | "platform_support">(
    "platform_superadmin",
  );
  const [grantReason, setGrantReason] = React.useState("");
  const [grantPending, setGrantPending] = React.useState(false);
  const [grantFieldError, setGrantFieldError] = React.useState<string | null>(null);

  // Revoke confirmation state
  const [revokingUserId, setRevokingUserId] = React.useState<string | null>(null);
  const [revokeReason, setRevokeReason] = React.useState("");
  const [revokePending, setRevokePending] = React.useState(false);
  const [revokeError, setRevokeError] = React.useState<string | null>(null);

  // Global status banners
  const [errorBanner, setErrorBanner] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  const activeOperators = React.useMemo(
    () => operators.filter((op) => op.isActive),
    [operators],
  );
  const activeSuperadmins = React.useMemo(
    () => activeOperators.filter((op) => op.role === "platform_superadmin"),
    [activeOperators],
  );

  async function refreshOperators() {
    setLoadingList(true);
    setErrorBanner(null);
    try {
      const res = await fetch("/api/console/operators", {
        method: "GET",
        credentials: "same-origin",
      });
      const data = (await res.json()) as {
        success?: boolean;
        items?: readonly ConsoleOperatorItem[];
        code?: string;
        message?: string;
      };
      if (!res.ok || !data.success || !Array.isArray(data.items)) {
        setErrorBanner({
          code: data.code ?? "FETCH_FAILED",
          message: data.message ?? "Gagal memuat ulang daftar operator platform.",
        });
        return;
      }
      setOperators(data.items);
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat memuat daftar operator. Coba lagi.",
      });
    } finally {
      setLoadingList(false);
    }
  }

  async function handleGrantSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorBanner(null);
    setSuccessMessage(null);
    setGrantFieldError(null);

    const trimmedTarget = targetEmail.trim();
    const trimmedReason = grantReason.trim();
    if (!trimmedTarget) {
      setGrantFieldError("Email atau ID akun terverifikasi wajib diisi.");
      return;
    }
    if (trimmedReason.length < 10) {
      setGrantFieldError("Alasan pemberian akses minimal 10 karakter (tanpa data rahasia).");
      return;
    }

    const isEmail = trimmedTarget.includes("@");
    setGrantPending(true);
    try {
      const res = await fetch("/api/console/operators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          ...(isEmail ? { targetEmail: trimmedTarget } : { targetUserId: trimmedTarget }),
          role: grantRole,
          reason: trimmedReason,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        code?: string;
        message?: string;
        verifyPath?: string;
        operator?: ConsoleOperatorItem;
      };

      if (!res.ok || !data.success) {
        setErrorBanner({
          code: data.code ?? "GRANT_FAILED",
          message: data.message ?? "Gagal memberikan akses operator platform.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      setTargetEmail("");
      setGrantReason("");
      await refreshOperators();
      setSuccessMessage(
        `Akses ${formatRoleLabel(grantRole)} berhasil diberikan kepada ${data.operator?.email ?? trimmedTarget}.`,
      );
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat memberikan akses operator. Isian Anda tetap dipertahankan.",
      });
    } finally {
      setGrantPending(false);
    }
  }

  async function handleRevokeSubmit(targetId: string) {
    setErrorBanner(null);
    setSuccessMessage(null);
    setRevokeError(null);

    const trimmedReason = revokeReason.trim();
    if (trimmedReason.length < 10) {
      setRevokeError("Alasan pencabutan akses wajib diisi minimal 10 karakter.");
      return;
    }

    setRevokePending(true);
    try {
      const res = await fetch(`/api/console/operators/${encodeURIComponent(targetId)}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ reason: trimmedReason }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        code?: string;
        message?: string;
        verifyPath?: string;
      };

      if (!res.ok || !data.success) {
        setErrorBanner({
          code: data.code ?? "REVOKE_FAILED",
          message: data.message ?? "Gagal mencabut akses operator.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      setRevokingUserId(null);
      setRevokeReason("");
      await refreshOperators();
      setSuccessMessage(
        "Akses operator telah dicabut secara atomik dan langsung berlaku pada permintaan berikutnya.",
      );
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat mencabut akses operator. Coba lagi.",
      });
    } finally {
      setRevokePending(false);
    }
  }

  function isFinalProtected(op: ConsoleOperatorItem): boolean {
    if (!op.isActive) return false;
    if (activeOperators.length <= 1) return true;
    if (op.role === "platform_superadmin" && activeSuperadmins.length <= 1) return true;
    return false;
  }

  return (
    <div className="space-y-5" data-testid="console-operators-panel">
      {!stepUpFresh && (
        <Alert variant="warning" data-testid="operators-reauth-warning">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Verifikasi ulang 2FA diperlukan untuk perubahan operator</AlertTitle>
          <AlertDescription>
            Pemberian atau pencabutan peran operator memerlukan verifikasi 2FA dalam 10 menit
            terakhir.{" "}
            <a
              href="/auth/two-factor?mode=verify&next=%2Fconsole%2Foperators"
              className="font-medium underline underline-offset-4"
            >
              Verifikasi ulang 2FA sekarang
            </a>
            .
          </AlertDescription>
        </Alert>
      )}

      {errorBanner && (
        <Alert variant="destructive" data-testid="operators-error-alert" aria-live="assertive">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Tindakan tidak dapat diproses ({errorBanner.code})</AlertTitle>
          <AlertDescription>
            <span>{errorBanner.message}</span>
            {errorBanner.verifyPath && (
              <>
                {" "}
                <a
                  href={`${errorBanner.verifyPath}&next=${encodeURIComponent("/console/operators")}`}
                  className="font-medium underline underline-offset-4"
                >
                  Buka verifikasi 2FA
                </a>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {successMessage && (
        <Alert variant="success" data-testid="operators-success-alert" aria-live="polite">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Perubahan operator tersimpan</AlertTitle>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      {/* Summary KPI strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <CardDescription>Operator Aktif</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="operators-active-count">
              {activeOperators.length}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Superadmin aktif: <span className="font-semibold tabular-nums">{activeSuperadmins.length}</span> (operator terakhir dilindungi atomik)
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>Operator Dicabut</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {operators.length - activeOperators.length}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Pencabutan langsung menolak permintaan sesi berikutnya
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>Bootstrap Awal</CardDescription>
            <CardTitle className="text-base">CLI Teraudit Saja</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            <code className="font-mono">scripts/platform-operator.mjs</code> — tidak dapat dipanggil secara anonim
          </CardContent>
        </Card>
      </div>

      {/* Grant Operator Form */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlusIcon className="size-4 text-primary" aria-hidden="true" />
            <span>Berikan Akses Operator Platform</span>
          </CardTitle>
          <CardDescription>
            Hanya untuk akun yang sudah terdaftar dan terverifikasi email. Memerlukan verifikasi
            2FA terbaru (10 menit) dan alasan audit wajib (10–500 karakter).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleGrantSubmit}
            noValidate
            className="grid grid-cols-1 gap-4 md:grid-cols-2"
            data-testid="operator-grant-form"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="operator-target-input"
                className="block text-sm font-medium text-foreground"
              >
                Email atau ID Akun Terverifikasi
              </label>
              <Input
                id="operator-target-input"
                name="targetEmail"
                type="text"
                placeholder="contoh: ops-baru@punyasitus.com"
                value={targetEmail}
                onChange={(e) => {
                  setTargetEmail(e.target.value);
                  if (grantFieldError) setGrantFieldError(null);
                }}
                disabled={grantPending}
                aria-invalid={grantFieldError ? "true" : undefined}
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="operator-role-select"
                className="block text-sm font-medium text-foreground"
              >
                Peran Operator Platform
              </label>
              <select
                id="operator-role-select"
                name="role"
                value={grantRole}
                onChange={(e) =>
                  setGrantRole(
                    e.target.value === "platform_support"
                      ? "platform_support"
                      : "platform_superadmin",
                  )
                }
                disabled={grantPending}
                className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
              >
                <option value="platform_superadmin">Superadmin Platform (platform_superadmin)</option>
                <option value="platform_support">Dukungan Platform (platform_support)</option>
              </select>
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <label
                htmlFor="operator-grant-reason"
                className="block text-sm font-medium text-foreground"
              >
                Alasan Audit (10–500 karakter, tanpa rahasia/PII)
              </label>
              <Input
                id="operator-grant-reason"
                name="reason"
                type="text"
                placeholder="Contoh: Menambahkan operator piket operasional untuk rotasi Q4"
                value={grantReason}
                onChange={(e) => {
                  setGrantReason(e.target.value);
                  if (grantFieldError) setGrantFieldError(null);
                }}
                disabled={grantPending}
                aria-invalid={grantFieldError ? "true" : undefined}
                aria-describedby={grantFieldError ? "operator-grant-error" : undefined}
              />
              {grantFieldError && (
                <p
                  id="operator-grant-error"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                >
                  {grantFieldError}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 md:col-span-2">
              <Button
                type="submit"
                disabled={grantPending}
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                data-testid="operator-grant-submit"
              >
                <ShieldCheckIcon className="size-4" aria-hidden="true" />
                {grantPending ? "Menyimpan & mencatat audit..." : "Berikan Akses Operator"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={loadingList}
                onClick={refreshOperators}
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                data-testid="operators-refresh-button"
              >
                <RefreshCwIcon className="size-4" aria-hidden="true" />
                {loadingList ? "Memuat..." : "Muat Ulang Daftar"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Operators List */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base">Daftar Hak Akses Operator Platform</CardTitle>
          <CardDescription>
            Status diambil langsung dari tabel <code className="font-mono">platform_operators</code>{" "}
            tanpa cache. Peran anggota organisasi tenant tidak pernah memberikan akses console.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {operators.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground" data-testid="operators-empty">
              Belum ada operator terdaftar.
            </p>
          ) : (
            <>
              {/* Mobile card stack (< md) — guarantees zero horizontal overflow at 360px */}
              <div className="space-y-3 md:hidden" data-testid="operators-mobile-list">
                {operators.map((op) => {
                  const protectedFinal = isFinalProtected(op);
                  const isSelf = op.userId === currentUserId;
                  return (
                    <div
                      key={op.userId}
                      className="space-y-2.5 rounded-lg border border-border bg-card p-3.5"
                      data-testid={`operator-card-${op.userId}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="break-all text-sm font-semibold text-foreground">
                            {op.name ?? op.email ?? op.userId}
                            {isSelf && " (Anda)"}
                          </p>
                          <p className="break-all font-mono text-xs text-muted-foreground">
                            {op.email ?? op.userId}
                          </p>
                        </div>
                        <Badge variant={op.isActive ? "success" : "secondary"}>
                          {op.isActive ? "Aktif" : "Dicabut"}
                        </Badge>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant="outline">{formatRoleLabel(op.role)}</Badge>
                        <Badge variant={op.twoFactorEnabled ? "info" : "warning"}>
                          {op.twoFactorEnabled ? "2FA Aktif" : "2FA Belum Aktif"}
                        </Badge>
                      </div>

                      <p className="text-xs text-muted-foreground">
                        Diberikan: <span className="tabular-nums">{formatEpochId(op.grantedAt)}</span>
                      </p>

                      {op.isActive && (
                        <div className="pt-1">
                          {protectedFinal ? (
                            <p className="text-xs font-medium text-warning">
                              Dilindungi: operator superadmin aktif terakhir tidak dapat dicabut.
                            </p>
                          ) : revokingUserId === op.userId ? (
                            <div className="space-y-2 rounded-md border border-destructive-border bg-destructive-soft/40 p-2.5">
                              <label
                                htmlFor={`revoke-reason-mobile-${op.userId}`}
                                className="block text-xs font-medium text-foreground"
                              >
                                Alasan pencabutan (min. 10 karakter)
                              </label>
                              <Input
                                id={`revoke-reason-mobile-${op.userId}`}
                                value={revokeReason}
                                onChange={(e) => {
                                  setRevokeReason(e.target.value);
                                  if (revokeError) setRevokeError(null);
                                }}
                                placeholder="Contoh: Rotasi tim operasional selesai"
                                disabled={revokePending}
                              />
                              {revokeError && (
                                <p role="alert" className="text-xs font-medium text-destructive">
                                  {revokeError}
                                </p>
                              )}
                              <div className="flex flex-col gap-2">
                                <Button
                                  type="button"
                                  variant="destructive"
                                  disabled={revokePending}
                                  onClick={() => handleRevokeSubmit(op.userId)}
                                  className="min-h-11 w-full"
                                >
                                  {revokePending ? "Mencabut..." : "Konfirmasi Cabut Akses"}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={revokePending}
                                  onClick={() => {
                                    setRevokingUserId(null);
                                    setRevokeReason("");
                                    setRevokeError(null);
                                  }}
                                  className="min-h-11 w-full"
                                >
                                  Batal
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button
                              type="button"
                              variant="destructive"
                              onClick={() => {
                                setRevokingUserId(op.userId);
                                setRevokeReason("");
                                setRevokeError(null);
                              }}
                              className="min-h-11 w-full"
                            >
                              <UserMinusIcon className="size-4" aria-hidden="true" />
                              Cabut Akses
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Desktop table (>= md) */}
              <div className="hidden md:block">
                <Table data-testid="operators-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Operator</TableHead>
                      <TableHead>Peran</TableHead>
                      <TableHead>Status & 2FA</TableHead>
                      <TableHead>Diberikan</TableHead>
                      <TableHead className="text-right">Tindakan</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {operators.map((op) => {
                      const protectedFinal = isFinalProtected(op);
                      const isSelf = op.userId === currentUserId;
                      return (
                        <TableRow key={op.userId} data-testid={`operator-row-${op.userId}`}>
                          <TableCell>
                            <div className="space-y-0.5">
                              <p className="font-medium text-foreground">
                                {op.name ?? "Tanpa Nama"}
                                {isSelf && (
                                  <span className="ml-1.5 text-xs text-muted-foreground">
                                    (Anda)
                                  </span>
                                )}
                              </p>
                              <p className="font-mono text-xs text-muted-foreground">
                                {op.email ?? op.userId}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{formatRoleLabel(op.role)}</Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant={op.isActive ? "success" : "secondary"}>
                                {op.isActive ? "Aktif" : "Dicabut"}
                              </Badge>
                              <Badge variant={op.twoFactorEnabled ? "info" : "warning"}>
                                {op.twoFactorEnabled ? "2FA Aktif" : "2FA Belum Aktif"}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell className="tabular-nums text-xs text-muted-foreground">
                            {formatEpochId(op.grantedAt)}
                          </TableCell>
                          <TableCell className="text-right">
                            {!op.isActive ? (
                              <span className="text-xs text-muted-foreground">
                                Dicabut {formatEpochId(op.revokedAt)}
                              </span>
                            ) : protectedFinal ? (
                              <Badge
                                variant="warning"
                                data-testid={`operator-final-protected-${op.userId}`}
                              >
                                Operator terakhir dilindungi
                              </Badge>
                            ) : revokingUserId === op.userId ? (
                              <div className="ml-auto flex max-w-sm flex-col gap-2 text-left">
                                <Input
                                  aria-label={`Alasan pencabutan untuk ${op.email ?? op.userId}`}
                                  placeholder="Alasan pencabutan (min. 10 karakter)"
                                  value={revokeReason}
                                  onChange={(e) => {
                                    setRevokeReason(e.target.value);
                                    if (revokeError) setRevokeError(null);
                                  }}
                                  disabled={revokePending}
                                  data-testid={`revoke-reason-input-${op.userId}`}
                                />
                                {revokeError && (
                                  <p role="alert" className="text-xs font-medium text-destructive">
                                    {revokeError}
                                  </p>
                                )}
                                <div className="flex justify-end gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={revokePending}
                                    onClick={() => {
                                      setRevokingUserId(null);
                                      setRevokeReason("");
                                      setRevokeError(null);
                                    }}
                                  >
                                    Batal
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="destructive"
                                    disabled={revokePending}
                                    onClick={() => handleRevokeSubmit(op.userId)}
                                    data-testid={`revoke-confirm-btn-${op.userId}`}
                                  >
                                    {revokePending ? "Mencabut..." : "Konfirmasi Cabut"}
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                onClick={() => {
                                  setRevokingUserId(op.userId);
                                  setRevokeReason("");
                                  setRevokeError(null);
                                }}
                                data-testid={`revoke-trigger-btn-${op.userId}`}
                              >
                                <UserMinusIcon className="size-3.5" aria-hidden="true" />
                                Cabut Akses
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

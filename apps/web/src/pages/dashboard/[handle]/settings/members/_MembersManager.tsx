import * as React from "react";
import {
  AlertCircleIcon,
  ArrowRightLeftIcon,
  CheckCircle2Icon,
  ClockIcon,
  CreditCardIcon,
  MailPlusIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserMinusIcon,
  UsersIcon,
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

export interface MemberItemDto {
  readonly memberId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly role: "owner" | "admin" | "editor" | "agency_staff" | "setup_staff";
  readonly createdAtMs: number;
}

export interface PendingInvitationDto {
  readonly invitationId: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly expiresAtMs: number;
  readonly createdAtMs: number;
}

export interface MembersManagerProps {
  readonly handle: string;
  readonly tenantName: string;
  readonly tenantStatus: string;
  readonly currentUserId: string;
  readonly currentRole: string;
  readonly canManageMembers: boolean;
  readonly canAccessBilling: boolean;
  readonly agencyManaged: boolean;
  readonly seatsLimit: number;
  readonly invitationExpiryHours: number;
  readonly initialMembers: readonly MemberItemDto[];
  readonly initialInvitations: readonly PendingInvitationDto[];
}

function roleLabel(role: string): string {
  switch (role) {
    case "owner":
      return "Pemilik (Owner)";
    case "admin":
      return "Admin";
    case "editor":
      return "Editor";
    case "agency_staff":
      return "Tim Agensi";
    case "setup_staff":
      return "Tim Setup";
    default:
      return role;
  }
}

function formatDateTimeWib(ms: number): string {
  try {
    return `${new Date(ms).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      dateStyle: "medium",
      timeStyle: "short",
    })} WIB`;
  } catch {
    return new Date(ms).toISOString();
  }
}

export function MembersManager({
  handle,
  tenantName,
  tenantStatus,
  currentUserId,
  currentRole: initialCurrentRole,
  canManageMembers: initialCanManage,
  canAccessBilling: initialCanBilling,
  agencyManaged,
  seatsLimit,
  invitationExpiryHours,
  initialMembers,
  initialInvitations,
}: MembersManagerProps) {
  const apiUrl = `/dashboard/${encodeURIComponent(handle)}/settings/members/api`;

  const [members, setMembers] = React.useState<readonly MemberItemDto[]>(initialMembers);
  const [invitations, setInvitations] =
    React.useState<readonly PendingInvitationDto[]>(initialInvitations);
  const [currentRole, setCurrentRole] = React.useState(initialCurrentRole);
  const [canManageMembers, setCanManageMembers] = React.useState(initialCanManage);
  const [canAccessBilling, setCanAccessBilling] = React.useState(initialCanBilling);

  // Invite form state
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<"admin" | "editor">("editor");
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = React.useState<string | null>(null);
  const [invitePending, setInvitePending] = React.useState(false);

  // Member actions state
  const [actionMessage, setActionMessage] = React.useState<{
    readonly kind: "success" | "error";
    readonly title: string;
    readonly text: string;
  } | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // Owner transfer form state
  const transferCandidates = React.useMemo(
    () =>
      members.filter(
        (m) =>
          m.userId !== currentUserId &&
          m.role !== "owner" &&
          (m.role === "admin" || m.role === "editor"),
      ),
    [members, currentUserId],
  );
  const [transferTargetId, setTransferTargetId] = React.useState<string>(
    transferCandidates[0]?.memberId ?? "",
  );
  const [transferConfirmHandle, setTransferConfirmHandle] = React.useState("");
  const [transferPassword, setTransferPassword] = React.useState("");
  const [transferError, setTransferError] = React.useState<string | null>(null);
  const [transferSuccess, setTransferSuccess] = React.useState<string | null>(null);
  const [transferPending, setTransferPending] = React.useState(false);

  React.useEffect(() => {
    if (!transferCandidates.some((c) => c.memberId === transferTargetId)) {
      setTransferTargetId(transferCandidates[0]?.memberId ?? "");
    }
  }, [transferCandidates, transferTargetId]);

  const seatsUsed = members.length + invitations.length;
  const seatsRemaining = Math.max(0, seatsLimit - seatsUsed);
  const ownerCount = members.filter((m) => m.role === "owner").length;
  const isOwner = currentRole === "owner";

  async function refreshSnapshot() {
    const res = await fetch(apiUrl, { method: "GET", credentials: "same-origin" });
    const data = (await res.json()) as {
      success?: boolean;
      currentRole?: string;
      canManageMembers?: boolean;
      canAccessBilling?: boolean;
      members?: readonly MemberItemDto[];
      pendingInvitations?: readonly PendingInvitationDto[];
    };
    if (res.ok && data.success) {
      if (Array.isArray(data.members)) setMembers(data.members);
      if (Array.isArray(data.pendingInvitations)) setInvitations(data.pendingInvitations);
      if (typeof data.currentRole === "string") setCurrentRole(data.currentRole);
      if (typeof data.canManageMembers === "boolean") setCanManageMembers(data.canManageMembers);
      if (typeof data.canAccessBilling === "boolean") setCanAccessBilling(data.canAccessBilling);
    }
  }

  async function handleInviteSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setInviteError(null);
    setInviteSuccess(null);

    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setInviteError("Masukkan alamat email anggota yang valid.");
      return;
    }

    setInvitePending(true);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "invite",
          email,
          role: inviteRole,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        code?: string;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setInviteError(data.message ?? "Gagal mengirim undangan anggota.");
        return;
      }
      await refreshSnapshot();
      setInviteEmail("");
      setInviteSuccess(
        `Undangan untuk ${email} sebagai ${roleLabel(inviteRole)} berhasil dibuat (berlaku ${invitationExpiryHours} jam, sekali pakai).`,
      );
    } catch {
      setInviteError("Koneksi terputus saat mengirim undangan. Silakan coba lagi.");
    } finally {
      setInvitePending(false);
    }
  }

  async function handleRevokeInvitation(invitationId: string, email: string) {
    setActionMessage(null);
    setBusyId(invitationId);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "revoke-invitation", invitationId }),
      });
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setActionMessage({
          kind: "error",
          title: "Gagal mencabut undangan",
          text: data.message ?? "Undangan tidak dapat dibatalkan.",
        });
        return;
      }
      await refreshSnapshot();
      setActionMessage({
        kind: "success",
        title: "Undangan dicabut",
        text: `Undangan untuk ${email} telah dibatalkan dan 1 kursi tim tersedia kembali.`,
      });
    } catch {
      setActionMessage({
        kind: "error",
        title: "Koneksi terputus",
        text: "Gagal mencabut undangan. Silakan coba lagi.",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function handleRoleChange(memberId: string, nextRole: "admin" | "editor") {
    setActionMessage(null);
    setBusyId(memberId);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "update-role", memberId, role: nextRole }),
      });
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setActionMessage({
          kind: "error",
          title: "Gagal mengubah peran",
          text: data.message ?? "Perubahan peran anggota ditolak.",
        });
        return;
      }
      setActionMessage({
        kind: "success",
        title: "Peran anggota diperbarui",
        text: `Peran anggota berhasil diperbarui menjadi ${roleLabel(nextRole)}.`,
      });
      await refreshSnapshot();
    } catch {
      setActionMessage({
        kind: "error",
        title: "Koneksi terputus",
        text: "Gagal mengubah peran anggota.",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemoveMember(member: MemberItemDto) {
    setActionMessage(null);
    setBusyId(member.memberId);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "remove-member", memberId: member.memberId }),
      });
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setActionMessage({
          kind: "error",
          title: "Penghapusan anggota ditolak",
          text: data.message ?? "Anggota tidak dapat dihapus.",
        });
        return;
      }
      setActionMessage({
        kind: "success",
        title: "Anggota dihapus",
        text: `Akses ${member.name} (${member.email}) ke ${tenantName} telah dicabut segera.`,
      });
      await refreshSnapshot();
    } catch {
      setActionMessage({
        kind: "error",
        title: "Koneksi terputus",
        text: "Gagal menghapus anggota.",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function handleTransferOwner(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setTransferError(null);
    setTransferSuccess(null);

    if (!transferTargetId) {
      setTransferError("Pilih anggota tujuan terlebih dahulu.");
      return;
    }
    if (transferConfirmHandle.trim().toLowerCase() !== handle.toLowerCase()) {
      setTransferError(`Ketik handle situs "${handle}" dengan tepat untuk mengonfirmasi.`);
      return;
    }

    setTransferPending(true);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "transfer-owner",
          targetMemberId: transferTargetId,
          confirmTenantHandle: transferConfirmHandle.trim().toLowerCase(),
          currentPassword: transferPassword || undefined,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        code?: string;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setTransferError(data.message ?? "Alih kepemilikan gagal diproses.");
        return;
      }

      await refreshSnapshot();
      setTransferConfirmHandle("");
      setTransferPassword("");
      setTransferSuccess(
        "Kepemilikan situs berhasil dialihkan secara atomik. Peran Anda kini menjadi Admin dan akses tagihan berpindah ke Pemilik baru.",
      );
    } catch {
      setTransferError("Koneksi terputus saat mengalihkan kepemilikan.");
    } finally {
      setTransferPending(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="members-settings-page" data-handle={handle}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Anggota & Hak Akses Tim
          </h1>
          <p className="text-sm text-muted-foreground">
            Kelola tim pengelola untuk <strong className="text-foreground">{tenantName}</strong>.
            Maksimal <span className="tabular-nums font-medium">{seatsLimit}</span> kursi (termasuk
            pemilik dan undangan tertunda).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="tabular-nums" data-testid="seat-quota-badge">
            <UsersIcon className="mr-1 size-3.5" aria-hidden="true" />
            {seatsUsed} dari {seatsLimit} kursi terpakai
          </Badge>
          <Badge variant={canAccessBilling ? "default" : "secondary"} data-testid="billing-access-badge">
            <CreditCardIcon className="mr-1 size-3.5" aria-hidden="true" />
            {canAccessBilling ? "Akses Tagihan: Owner" : "Tanpa Akses Tagihan"}
          </Badge>
        </div>
      </div>

      {!canManageMembers && (
        <Alert variant="info" data-testid="members-readonly-notice">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Akses baca saja untuk peran {roleLabel(currentRole)}</AlertTitle>
          <AlertDescription>
            Hanya Pemilik Situs (Owner) yang dapat mengundang anggota baru, mencabut undangan,
            menghapus anggota, atau mengalihkan kepemilikan situs.
          </AlertDescription>
        </Alert>
      )}

      {tenantStatus === "locked" || tenantStatus === "suspended" ? (
        <Alert variant="warning" data-testid="members-service-locked-notice">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Status layanan: {tenantStatus}</AlertTitle>
          <AlertDescription>
            Perubahan keanggotaan dibatasi selama situs berstatus terkunci atau ditangguhkan.{" "}
            <a
              href={`/dashboard/${encodeURIComponent(handle)}/service-status`}
              className="inline-flex min-h-11 items-center font-medium underline underline-offset-4 md:min-h-0"
            >
              Lihat status layanan
            </a>
          </AlertDescription>
        </Alert>
      ) : null}

      {actionMessage && (
        <Alert
          variant={actionMessage.kind === "success" ? "success" : "destructive"}
          role={actionMessage.kind === "success" ? "status" : "alert"}
          data-testid="members-action-alert"
        >
          {actionMessage.kind === "success" ? (
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
          ) : (
            <AlertCircleIcon className="size-4" aria-hidden="true" />
          )}
          <AlertTitle>{actionMessage.title}</AlertTitle>
          <AlertDescription>{actionMessage.text}</AlertDescription>
        </Alert>
      )}

      {canManageMembers && (
        <Card data-testid="invite-member-card">
          <CardHeader className="border-b border-border">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <MailPlusIcon className="size-4 text-primary" aria-hidden="true" />
                  Undang Anggota Baru
                </CardTitle>
                <CardDescription>
                  Tautan undangan terikat ke alamat email penerima, bersifat sekali pakai, dan
                  otomatis kedaluwarsa setelah{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {invitationExpiryHours} jam
                  </span>
                  .
                </CardDescription>
              </div>
              <Badge variant={seatsRemaining === 0 ? "destructive" : "secondary"} className="tabular-nums">
                {seatsRemaining === 0 ? "Kuota penuh (5/5)" : `Sisa ${seatsRemaining} kursi`}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-5">
            <form
              onSubmit={handleInviteSubmit}
              className="space-y-4"
              noValidate
              data-testid="invite-member-form"
            >
              {inviteError && (
                <Alert variant="destructive" data-testid="invite-error-alert">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Undangan tidak dapat dikirim</AlertTitle>
                  <AlertDescription>{inviteError}</AlertDescription>
                </Alert>
              )}

              {inviteSuccess && (
                <Alert variant="success" role="status" data-testid="invite-success-alert">
                  <CheckCircle2Icon className="size-4" aria-hidden="true" />
                  <AlertTitle>Undangan terkirim</AlertTitle>
                  <AlertDescription>{inviteSuccess}</AlertDescription>
                </Alert>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-12">
                <div className="space-y-1.5 sm:col-span-6">
                  <label
                    htmlFor="invite-email-input"
                    className="block text-sm font-medium text-foreground"
                  >
                    Alamat email anggota
                  </label>
                  <Input
                    id="invite-email-input"
                    name="email"
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="staf@perusahaan.id"
                    required
                  />
                </div>

                <div className="space-y-1.5 sm:col-span-3">
                  <label
                    htmlFor="invite-role-select"
                    className="block text-sm font-medium text-foreground"
                  >
                    Peran tim
                  </label>
                  <select
                    id="invite-role-select"
                    name="role"
                    value={inviteRole}
                    onChange={(e) =>
                      setInviteRole(e.target.value === "admin" ? "admin" : "editor")
                    }
                    className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                  >
                    <option value="editor">Editor (Konten & Media)</option>
                    <option value="admin">Admin (Pengaturan & Lead)</option>
                  </select>
                </div>

                <div className="flex items-end sm:col-span-3">
                  <Button
                    type="submit"
                    disabled={invitePending}
                    className="min-h-11 w-full md:min-h-9"
                    data-testid="invite-submit-button"
                  >
                    {invitePending ? "Mengirim..." : "Kirim undangan"}
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card data-testid="active-members-card">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Daftar Anggota Aktif</CardTitle>
              <CardDescription>
                Situs wajib selalu memiliki minimal satu Pemilik (Owner) aktif.
              </CardDescription>
            </div>
            <Badge variant="outline" className="tabular-nums">
              {members.length} anggota
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Anggota</TableHead>
                  <TableHead>Peran</TableHead>
                  <TableHead>Bergabung</TableHead>
                  {canManageMembers && <TableHead className="text-right">Tindakan</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => {
                  const isFinalOwner = member.role === "owner" && ownerCount <= 1;
                  const isSelf = member.userId === currentUserId;
                  return (
                    <TableRow key={member.memberId} data-member-email={member.email}>
                      <TableCell>
                        <div className="font-medium text-foreground">
                          {member.name} {isSelf && <span className="text-xs text-muted-foreground">(Anda)</span>}
                        </div>
                        <div className="text-xs text-muted-foreground">{member.email}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={member.role === "owner" ? "default" : "secondary"}>
                          {roleLabel(member.role)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {formatDateTimeWib(member.createdAtMs)}
                      </TableCell>
                      {canManageMembers && (
                        <TableCell className="text-right">
                          {isFinalOwner ? (
                            <span
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                              data-testid="final-owner-protected-badge"
                            >
                              <ShieldCheckIcon className="size-3.5 text-primary" aria-hidden="true" />
                              Pemilik terakhir dilindungi
                            </span>
                          ) : (
                            <div className="inline-flex items-center gap-2">
                              {member.role !== "owner" && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={busyId === member.memberId}
                                  onClick={() =>
                                    handleRoleChange(
                                      member.memberId,
                                      member.role === "admin" ? "editor" : "admin",
                                    )
                                  }
                                >
                                  Ubah ke {member.role === "admin" ? "Editor" : "Admin"}
                                </Button>
                              )}
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                disabled={busyId === member.memberId}
                                onClick={() => handleRemoveMember(member)}
                                data-testid={`remove-member-${member.memberId}`}
                              >
                                <UserMinusIcon className="size-3.5" aria-hidden="true" />
                                Hapus
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <ul className="divide-y divide-border md:hidden">
            {members.map((member) => {
              const isFinalOwner = member.role === "owner" && ownerCount <= 1;
              return (
                <li key={member.memberId} className="space-y-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{member.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                    </div>
                    <Badge variant={member.role === "owner" ? "default" : "secondary"}>
                      {roleLabel(member.role)}
                    </Badge>
                  </div>
                  {canManageMembers && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {isFinalOwner ? (
                        <span className="text-xs text-muted-foreground">
                          Pemilik terakhir dilindungi (gunakan alih kepemilikan)
                        </span>
                      ) : (
                        <>
                          {member.role !== "owner" && (
                            <Button
                              type="button"
                              variant="outline"
                              className="min-h-11 flex-1"
                              disabled={busyId === member.memberId}
                              onClick={() =>
                                handleRoleChange(
                                  member.memberId,
                                  member.role === "admin" ? "editor" : "admin",
                                )
                              }
                            >
                              Ubah ke {member.role === "admin" ? "Editor" : "Admin"}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="destructive"
                            className="min-h-11"
                            disabled={busyId === member.memberId}
                            onClick={() => handleRemoveMember(member)}
                          >
                            Hapus
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card data-testid="pending-invitations-card">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Undangan Menunggu Konfirmasi</CardTitle>
              <CardDescription>
                Undangan aktif turut dihitung ke dalam batas maksimal {seatsLimit} anggota.
              </CardDescription>
            </div>
            <Badge variant="outline" className="tabular-nums" data-testid="pending-invites-count">
              {invitations.length} tertunda
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {invitations.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground" data-testid="no-pending-invitations">
              Tidak ada undangan tertunda saat ini.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {invitations.map((inv) => (
                <li
                  key={inv.invitationId}
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  data-invitation-email={inv.email}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-foreground">{inv.email}</span>
                      <Badge variant="secondary">{roleLabel(inv.role)}</Badge>
                    </div>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                      <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      Berlaku hingga {formatDateTimeWib(inv.expiresAtMs)}
                    </p>
                  </div>
                  {canManageMembers && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 w-full sm:w-auto md:min-h-8"
                      disabled={busyId === inv.invitationId}
                      onClick={() => handleRevokeInvitation(inv.invitationId, inv.email)}
                      data-testid={`revoke-invite-${inv.invitationId}`}
                    >
                      <Trash2Icon className="size-3.5" aria-hidden="true" />
                      Cabut undangan
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {isOwner && (
        <Card data-testid="owner-transfer-card">
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ArrowRightLeftIcon className="size-4 text-destructive" aria-hidden="true" />
              Alih Kepemilikan Situs (Transfer Owner)
            </CardTitle>
            <CardDescription>
              Memindahkan peran Pemilik (Owner) serta akses tagihan ke anggota aktif lain secara
              atomik. Peran Anda akan langsung berubah menjadi Admin. Memerlukan autentikasi ulang.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-5">
            {transferSuccess && (
              <Alert variant="success" role="status" className="mb-4" data-testid="transfer-success-alert">
                <CheckCircle2Icon className="size-4" aria-hidden="true" />
                <AlertTitle>Alih kepemilikan selesai</AlertTitle>
                <AlertDescription>{transferSuccess}</AlertDescription>
              </Alert>
            )}

            {transferCandidates.length === 0 ? (
              <Alert variant="info" data-testid="transfer-no-candidates">
                <AlertTitle>Belum ada anggota aktif tujuan</AlertTitle>
                <AlertDescription>
                  Undang minimal satu anggota (Admin atau Editor) dan pastikan undangannya sudah
                  diterima sebelum mengalihkan kepemilikan situs.
                </AlertDescription>
              </Alert>
            ) : (
              <form
                onSubmit={handleTransferOwner}
                className="space-y-4"
                noValidate
                data-testid="owner-transfer-form"
              >
                {transferError && (
                  <Alert variant="destructive" data-testid="transfer-error-alert">
                    <AlertCircleIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>Alih kepemilikan ditolak</AlertTitle>
                    <AlertDescription>{transferError}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-1.5">
                  <label
                    htmlFor="transfer-target-select"
                    className="block text-sm font-medium text-foreground"
                  >
                    Anggota penerima kepemilikan baru
                  </label>
                  <select
                    id="transfer-target-select"
                    value={transferTargetId}
                    onChange={(e) => setTransferTargetId(e.target.value)}
                    className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                  >
                    {transferCandidates.map((candidate) => (
                      <option key={candidate.memberId} value={candidate.memberId}>
                        {candidate.name} ({candidate.email}) — {roleLabel(candidate.role)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="transfer-confirm-handle"
                      className="block text-sm font-medium text-foreground"
                    >
                      Konfirmasi handle situs (<code className="font-mono text-xs">{handle}</code>)
                    </label>
                    <Input
                      id="transfer-confirm-handle"
                      type="text"
                      value={transferConfirmHandle}
                      onChange={(e) => setTransferConfirmHandle(e.target.value)}
                      placeholder={handle}
                      required
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="transfer-reauth-password"
                      className="block text-sm font-medium text-foreground"
                    >
                      Kata sandi saat ini (autentikasi ulang)
                    </label>
                    <Input
                      id="transfer-reauth-password"
                      type="password"
                      value={transferPassword}
                      onChange={(e) => setTransferPassword(e.target.value)}
                      placeholder="Masukkan kata sandi akun Anda"
                      autoComplete="current-password"
                    />
                  </div>
                </div>

                {agencyManaged && (
                  <p className="text-xs text-muted-foreground">
                    Catatan: Situs ini dikelola agensi sehingga pembayaran langganan tetap berada di
                    portal agensi.
                  </p>
                )}

                <Button
                  type="submit"
                  variant="destructive"
                  disabled={transferPending}
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                  data-testid="transfer-owner-submit"
                >
                  <ArrowRightLeftIcon className="size-4" aria-hidden="true" />
                  {transferPending ? "Mengalihkan kepemilikan..." : "Alihkan kepemilikan sekarang"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

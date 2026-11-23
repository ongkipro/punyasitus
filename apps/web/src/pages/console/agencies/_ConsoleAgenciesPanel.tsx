import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  PercentIcon,
  PlusIcon,
  SendIcon,
  SlidersHorizontalIcon,
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
import type {
  ConsoleAgencyDto,
  ConsoleAgencyInvitationDto,
} from "../../api/console/agencies/_shared";

export interface ConsoleAgenciesPanelProps {
  readonly initialAgencies: readonly ConsoleAgencyDto[];
  readonly initialInvitations: readonly ConsoleAgencyInvitationDto[];
  readonly stepUpFresh: boolean;
}

interface EditableTier {
  minPaidClients: string;
  discountPercent: string;
}

export function ConsoleAgenciesPanel({
  initialAgencies,
  initialInvitations,
  stepUpFresh,
}: ConsoleAgenciesPanelProps) {
  const [agencies, setAgencies] = React.useState<readonly ConsoleAgencyDto[]>(initialAgencies);
  const [invitations, setInvitations] =
    React.useState<readonly ConsoleAgencyInvitationDto[]>(initialInvitations);

  // Invite form state
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteAgencyName, setInviteAgencyName] = React.useState("");
  const [inviteReason, setInviteReason] = React.useState("");
  const [inviting, setInviting] = React.useState(false);
  const [issuedAcceptPath, setIssuedAcceptPath] = React.useState<string | null>(null);

  // Selected agency configuration state
  const [editingAgencyId, setEditingAgencyId] = React.useState<string>(
    initialAgencies[0]?.id ?? "",
  );
  const selectedAgency = agencies.find((a) => a.id === editingAgencyId) ?? null;

  const [discountPercent, setDiscountPercent] = React.useState(
    String(selectedAgency?.baseDiscountPercent ?? 0),
  );
  const [unpaidTrialCap, setUnpaidTrialCap] = React.useState(
    String(selectedAgency?.unpaidTrialCap ?? 3),
  );
  const [status, setStatus] = React.useState<"active" | "suspended" | "pending">(
    selectedAgency?.status ?? "active",
  );
  const [tiers, setTiers] = React.useState<EditableTier[]>(
    (selectedAgency?.discountTiers ?? []).map((t) => ({
      minPaidClients: String(t.minPaidClients),
      discountPercent: String(t.discountPercent),
    })),
  );
  const [updateReason, setUpdateReason] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [successMsg, setSuccessMsg] = React.useState<string | null>(null);

  function selectAgencyForEdit(agency: ConsoleAgencyDto) {
    setEditingAgencyId(agency.id);
    setDiscountPercent(String(agency.baseDiscountPercent));
    setUnpaidTrialCap(String(agency.unpaidTrialCap));
    setStatus(agency.status);
    setTiers(
      agency.discountTiers.map((t) => ({
        minPaidClients: String(t.minPaidClients),
        discountPercent: String(t.discountPercent),
      })),
    );
    setUpdateReason("");
    setErrorMsg(null);
    setSuccessMsg(null);
  }

  async function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    setIssuedAcceptPath(null);
    setInviting(true);
    try {
      const res = await fetch("/api/console/agencies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          email: inviteEmail.trim(),
          agencyName: inviteAgencyName.trim(),
          reason: inviteReason.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly invitation?: ConsoleAgencyInvitationDto;
        readonly acceptPath?: string;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.success || !data.invitation) {
        setErrorMsg(data.error?.message ?? "Gagal menerbitkan undangan agensi.");
        return;
      }
      setInvitations((prev) => [data.invitation!, ...prev]);
      setIssuedAcceptPath(data.acceptPath ?? null);
      setInviteEmail("");
      setInviteAgencyName("");
      setInviteReason("");
      setSuccessMsg(`Undangan agensi untuk ${data.invitation.email} berhasil diterbitkan.`);
    } catch {
      setErrorMsg("Koneksi gagal saat menerbitkan undangan agensi.");
    } finally {
      setInviting(false);
    }
  }

  async function handleUpdateAgency(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedAgency) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setSaving(true);
    try {
      const parsedTiers = tiers
        .filter((t) => t.minPaidClients.trim() !== "" || t.discountPercent.trim() !== "")
        .map((t) => ({
          minPaidClients: Number.parseInt(t.minPaidClients, 10),
          discountPercent: Number.parseInt(t.discountPercent, 10),
        }));

      const res = await fetch(`/api/console/agencies/${encodeURIComponent(selectedAgency.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          expectedVersion: selectedAgency.version,
          discountPercent: Number.parseInt(discountPercent, 10),
          unpaidTrialCap: Number.parseInt(unpaidTrialCap, 10),
          discountTiers: parsedTiers,
          status,
          reason: updateReason.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly agency?: ConsoleAgencyDto;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.success || !data.agency) {
        setErrorMsg(data.error?.message ?? "Gagal memperbarui konfigurasi agensi.");
        return;
      }
      setAgencies((prev) => prev.map((a) => (a.id === data.agency!.id ? data.agency! : a)));
      setUpdateReason("");
      setSuccessMsg(
        `Konfigurasi agensi "${data.agency.name}" berhasil diperbarui (diskon efektif ${data.agency.effectiveDiscountPercent}%).`,
      );
    } catch {
      setErrorMsg("Koneksi gagal saat menyimpan konfigurasi agensi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="console-agencies-panel">
      {!stepUpFresh && (
        <Alert variant="warning" data-testid="console-agencies-stepup-warning">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Verifikasi ulang 2FA diperlukan untuk mutasi</AlertTitle>
          <AlertDescription>
            Membaca daftar agensi tetap tersedia, tetapi mengundang agensi baru atau mengubah
            diskon/tier volume mewajibkan verifikasi ulang 2FA dalam 10 menit terakhir.
          </AlertDescription>
        </Alert>
      )}

      {errorMsg && (
        <Alert variant="destructive" data-testid="console-agencies-error">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Permintaan ditolak</AlertTitle>
          <AlertDescription>{errorMsg}</AlertDescription>
        </Alert>
      )}

      {successMsg && (
        <Alert variant="info" data-testid="console-agencies-success">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Tercatat di log audit platform</AlertTitle>
          <AlertDescription>
            <span>{successMsg}</span>
            {issuedAcceptPath && (
              <span className="mt-1 block font-mono text-xs break-all">
                Tautan aktivasi: {issuedAcceptPath}
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card data-testid="console-invite-agency-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SendIcon className="size-4 text-primary" aria-hidden="true" />
              Undang Agensi Baru
            </CardTitle>
            <CardDescription>
              Agensi undangan dimulai pada diskon 0% dan wajib mengaktifkan TOTP 2FA saat aktivasi.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleInviteSubmit} className="space-y-3.5">
              <div className="space-y-1.5">
                <label htmlFor="console-invite-email" className="block text-sm font-medium text-foreground">
                  Email Pemilik Agensi
                </label>
                <Input
                  id="console-invite-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="partner@agensi.co.id"
                  required
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="console-invite-name" className="block text-sm font-medium text-foreground">
                  Nama Agensi
                </label>
                <Input
                  id="console-invite-name"
                  type="text"
                  value={inviteAgencyName}
                  onChange={(e) => setInviteAgencyName(e.target.value)}
                  placeholder="Studio Web Nusantara"
                  required
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="console-invite-reason" className="block text-sm font-medium text-foreground">
                  Alasan Audit Operator (min. 10 karakter)
                </label>
                <Input
                  id="console-invite-reason"
                  type="text"
                  value={inviteReason}
                  onChange={(e) => setInviteReason(e.target.value)}
                  placeholder="Onboarding mitra agensi terverifikasi batch Q4"
                  required
                  minLength={10}
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
              </div>

              <Button
                type="submit"
                disabled={inviting}
                data-testid="console-invite-agency-submit"
                className="min-h-11 w-full sm:w-auto md:min-h-9"
              >
                {inviting ? "Mengirim undangan..." : "Terbitkan Undangan Agensi"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card data-testid="console-agency-config-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SlidersHorizontalIcon className="size-4 text-primary" aria-hidden="true" />
              Konfigurasi Diskon &amp; Tier Volume
            </CardTitle>
            <CardDescription>
              Atur diskon dasar (0–50%), tier diskon volume berdasarkan jumlah klien berbayar,
              batas uji coba awal, dan status agensi.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!selectedAgency ? (
              <p className="text-sm text-muted-foreground">
                Pilih agensi dari daftar di bawah untuk mengatur diskon dan tier volume.
              </p>
            ) : (
              <form onSubmit={handleUpdateAgency} className="space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                  <span className="font-semibold text-foreground">{selectedAgency.name}</span>
                  <Badge variant="secondary" className="tabular-nums">
                    v{selectedAgency.version} · Efektif {selectedAgency.effectiveDiscountPercent}%
                  </Badge>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <label htmlFor="cfg-discount" className="block text-xs font-medium text-foreground">
                      Diskon Dasar (%)
                    </label>
                    <Input
                      id="cfg-discount"
                      type="number"
                      min={0}
                      max={50}
                      value={discountPercent}
                      onChange={(e) => setDiscountPercent(e.target.value)}
                      required
                      className="min-h-11 text-base tabular-nums md:min-h-9 md:text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="cfg-trial-cap" className="block text-xs font-medium text-foreground">
                      Batas Uji Coba Awal
                    </label>
                    <Input
                      id="cfg-trial-cap"
                      type="number"
                      min={0}
                      max={50}
                      value={unpaidTrialCap}
                      onChange={(e) => setUnpaidTrialCap(e.target.value)}
                      required
                      className="min-h-11 text-base tabular-nums md:min-h-9 md:text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="cfg-status" className="block text-xs font-medium text-foreground">
                      Status Agensi
                    </label>
                    <select
                      id="cfg-status"
                      value={status}
                      onChange={(e) =>
                        setStatus(e.target.value as "active" | "suspended" | "pending")
                      }
                      className="min-h-11 w-full rounded-md border border-input bg-background px-2.5 text-base text-foreground md:min-h-9 md:text-sm"
                    >
                      <option value="active">Aktif</option>
                      <option value="suspended">Ditangguhkan</option>
                      <option value="pending">Menunggu</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      Tier Diskon Volume (Opsional)
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setTiers((prev) => [
                          ...prev,
                          { minPaidClients: "5", discountPercent: "10" },
                        ])
                      }
                      className="min-h-11 md:min-h-8"
                    >
                      <PlusIcon className="size-3.5" aria-hidden="true" />
                      Tambah Tier
                    </Button>
                  </div>
                  {tiers.map((tier, idx) => (
                    <div key={idx} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <Input
                        type="number"
                        min={1}
                        placeholder="Min klien berbayar"
                        aria-label={`Minimal klien berbayar tier ${idx + 1}`}
                        value={tier.minPaidClients}
                        onChange={(e) =>
                          setTiers((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, minPaidClients: e.target.value } : item,
                            ),
                          )
                        }
                        className="min-h-11 text-base tabular-nums md:min-h-9 md:text-sm"
                      />
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        placeholder="Diskon (%)"
                        aria-label={`Persentase diskon tier ${idx + 1}`}
                        value={tier.discountPercent}
                        onChange={(e) =>
                          setTiers((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, discountPercent: e.target.value } : item,
                            ),
                          )
                        }
                        className="min-h-11 text-base tabular-nums md:min-h-9 md:text-sm"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setTiers((prev) => prev.filter((_, i) => i !== idx))}
                        className="min-h-11 md:min-h-9"
                      >
                        Hapus
                      </Button>
                    </div>
                  ))}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="cfg-reason" className="block text-sm font-medium text-foreground">
                    Alasan Audit Operator (min. 10 karakter)
                  </label>
                  <Input
                    id="cfg-reason"
                    type="text"
                    value={updateReason}
                    onChange={(e) => setUpdateReason(e.target.value)}
                    placeholder="Penyesuaian tier diskon volume agensi mitra"
                    required
                    minLength={10}
                    className="min-h-11 text-base md:min-h-9 md:text-sm"
                  />
                </div>

                <Button
                  type="submit"
                  disabled={saving}
                  data-testid="console-agency-config-submit"
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                >
                  <PercentIcon className="size-4" aria-hidden="true" />
                  {saving ? "Menyimpan..." : "Simpan Konfigurasi Agensi"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      <Card data-testid="console-agencies-table-card">
        <CardHeader className="border-b border-border">
          <CardTitle>Daftar Agensi Terdaftar ({agencies.length})</CardTitle>
          <CardDescription>
            Pantau sumber pendaftaran, pemakaian kuota uji coba, jumlah klien berbayar, dan diskon aktif.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {agencies.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              Belum ada agensi yang terdaftar di platform.
            </div>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agensi</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Klien (Berbayar / Uji Coba)</TableHead>
                      <TableHead className="text-right">Diskon Efektif</TableHead>
                      <TableHead className="text-right">Aksi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agencies.map((a) => (
                      <TableRow key={a.id} data-testid={`console-agency-row-${a.id}`}>
                        <TableCell>
                          <p className="font-medium text-foreground">{a.name}</p>
                          <p className="text-xs text-muted-foreground">{a.ownerEmail ?? a.billingEmail}</p>
                        </TableCell>
                        <TableCell>
                          <Badge variant={a.status === "active" ? "default" : "destructive"}>
                            {a.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {a.totalClientCount} total ({a.paidClientCount} berbayar ·{" "}
                          {a.unpaidTrialCount}/{a.unpaidTrialCap} uji coba)
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {a.effectiveDiscountPercent}%
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant={editingAgencyId === a.id ? "default" : "outline"}
                            size="sm"
                            onClick={() => selectAgencyForEdit(a)}
                            className="min-h-9"
                          >
                            Atur
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <ul className="divide-y divide-border md:hidden">
                {agencies.map((a) => (
                  <li key={a.id} className="space-y-2 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{a.name}</span>
                      <Badge variant={a.status === "active" ? "default" : "destructive"}>
                        {a.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      Diskon {a.effectiveDiscountPercent}% · {a.paidClientCount} berbayar ·{" "}
                      {a.unpaidTrialCount}/{a.unpaidTrialCap} uji coba
                    </p>
                    <Button
                      type="button"
                      variant={editingAgencyId === a.id ? "default" : "outline"}
                      onClick={() => selectAgencyForEdit(a)}
                      className="min-h-11 w-full"
                    >
                      Atur Konfigurasi Agensi
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {invitations.length > 0 && (
        <Card data-testid="console-agency-invitations-card">
          <CardHeader className="border-b border-border">
            <CardTitle>Riwayat Undangan Agensi ({invitations.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {invitations.slice(0, 10).map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                  <div>
                    <p className="font-medium text-foreground">{inv.agencyName ?? inv.email}</p>
                    <p className="text-xs text-muted-foreground">{inv.email}</p>
                  </div>
                  <Badge variant="outline">{inv.status}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

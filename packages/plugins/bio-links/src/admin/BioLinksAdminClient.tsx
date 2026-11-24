import { useState } from "react";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  BarChart3Icon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  Link2Icon,
  LockIcon,
  MessageCircleIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface BioLinksAdminProfile {
  readonly displayName: string;
  readonly headline: string;
  readonly bioText: string;
  readonly avatarUrl?: string;
  readonly themeAccent: string;
  readonly whatsappPhone: string;
  readonly whatsappLabel: string;
  readonly whatsappMessage?: string;
  readonly showWhatsappButton: boolean;
}

export interface BioLinksAdminItem {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly subtitle: string;
  readonly badge: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly clickCount: number;
}

export interface BioLinksAdminClientProps {
  readonly basePath: string;
  readonly apiBaseUrl: string;
  readonly publicLinkHref: string;
  readonly enabled: boolean;
  readonly initialProfile: BioLinksAdminProfile;
  readonly initialLinks: readonly BioLinksAdminItem[];
  readonly permissions: {
    readonly roleLabel: string;
    readonly isLocked: boolean;
    readonly canManagePlugins: boolean;
  };
}

export function BioLinksAdminClient({
  basePath,
  apiBaseUrl,
  publicLinkHref,
  enabled: initialEnabled,
  initialProfile,
  initialLinks,
  permissions,
}: BioLinksAdminClientProps) {
  const [enabled] = useState(initialEnabled);
  const [profile, setProfile] = useState<BioLinksAdminProfile>(initialProfile);
  const [links, setLinks] = useState<BioLinksAdminItem[]>([...initialLinks]);
  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newSubtitle, setNewSubtitle] = useState("");
  const [newBadge, setNewBadge] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [addingLink, setAddingLink] = useState(false);
  const [notice, setNotice] = useState<{
    readonly variant: "success" | "destructive" | "info";
    readonly title: string;
    readonly description: string;
  } | null>(null);

  const activeCount = links.filter((item) => item.isActive).length;
  const totalClicks = links.reduce((sum, item) => sum + item.clickCount, 0);

  async function handleSaveProfile(event: { readonly preventDefault: () => void }) {
    event.preventDefault();
    if (!permissions.canManagePlugins || savingProfile) return;
    setSavingProfile(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      const data = (await response.json().catch(() => ({}))) as {
        readonly profile?: BioLinksAdminProfile;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok) {
        setNotice({
          variant: "destructive",
          title: "Gagal menyimpan profil bio",
          description: data.error?.message ?? "Periksa kembali format input Anda.",
        });
        return;
      }
      if (data.profile) setProfile(data.profile);
      setNotice({
        variant: "success",
        title: "Profil halaman /link tersimpan",
        description: "Perubahan profil langsung diterapkan pada halaman tautan bio Anda.",
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Perubahan belum tersimpan. Silakan coba lagi.",
      });
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleAddLink(event: { readonly preventDefault: () => void }) {
    event.preventDefault();
    if (!permissions.canManagePlugins || addingLink) return;
    setAddingLink(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: newLabel,
          url: newUrl,
          subtitle: newSubtitle,
          badge: newBadge,
          isActive: true,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        readonly link?: BioLinksAdminItem;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !data.link) {
        setNotice({
          variant: "destructive",
          title: "Gagal menambahkan tautan",
          description:
            data.error?.message ?? "Pastikan URL menggunakan https://, http://, tel:, mailto:, atau wa.me/.",
        });
        return;
      }
      setLinks((prev) => [...prev, data.link!]);
      setNewLabel("");
      setNewUrl("");
      setNewSubtitle("");
      setNewBadge("");
      setNotice({
        variant: "success",
        title: "Tautan bio ditambahkan",
        description: `Tautan "${data.link.label}" kini tampil di halaman /link.`,
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Tautan belum tersimpan. Coba kirim ulang.",
      });
    } finally {
      setAddingLink(false);
    }
  }

  async function handleToggleLink(item: BioLinksAdminItem) {
    if (!permissions.canManagePlugins) return;
    setNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/links/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !item.isActive }),
      });
      if (!response.ok) return;
      setLinks((prev) =>
        prev.map((row) => (row.id === item.id ? { ...row, isActive: !row.isActive } : row)),
      );
    } catch {
      // Keep UI responsive without unhandled rejection
    }
  }

  async function handleDeleteLink(item: BioLinksAdminItem) {
    if (!permissions.canManagePlugins) return;
    setNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/links/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) return;
      setLinks((prev) => prev.filter((row) => row.id !== item.id));
      setNotice({
        variant: "info",
        title: "Tautan dihapus",
        description: `Tautan "${item.label}" telah dihapus dari halaman /link.`,
      });
    } catch {
      // Ignore network drop gracefully
    }
  }

  async function handleMoveLink(index: number, direction: -1 | 1) {
    if (!permissions.canManagePlugins) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= links.length) return;
    const reordered = [...links];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(nextIndex, 0, moved!);
    setLinks(reordered.map((item, idx) => ({ ...item, sortOrder: idx })));

    try {
      await fetch(`${apiBaseUrl}/links/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: reordered.map((i) => i.id) }),
      });
    } catch {
      // Optimistic order retained
    }
  }

  return (
    <section
      className="space-y-6"
      data-testid="bio-links-admin-shell"
      aria-labelledby="bio-links-admin-heading"
    >
      {/* Top action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 px-2 md:min-h-8"
          render={<a href={`${basePath}/plugins`} />}
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          Kembali ke daftar Plugin
        </Button>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={enabled ? "success" : "outline"}>
            {enabled ? (
              <>
                <CheckCircle2Icon className="size-3" aria-hidden="true" />
                Aktif
              </>
            ) : (
              "Nonaktif"
            )}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-8"
            render={<a href={publicLinkHref} target="_blank" rel="noopener noreferrer" />}
          >
            <ExternalLinkIcon className="size-4" aria-hidden="true" />
            Buka /link
          </Button>
        </div>
      </div>

      {/* Heading */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1
            id="bio-links-admin-heading"
            className="text-xl font-semibold tracking-tight text-foreground"
          >
            Bio Links (/link)
          </h1>
          <Badge variant="secondary">Gratis Bawaan</Badge>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Kelola halaman tautan bio 0-JS pada domain situs Anda sendiri lengkap dengan penghitung
          klik pihak pertama tanpa cookie dan tanpa pelacak pihak ketiga.
        </p>
      </div>

      {/* Guardrails */}
      {permissions.isLocked ? (
        <Alert variant="warning" data-testid="bio-links-locked-alert">
          <LockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Langganan terkunci (Mode hanya-baca)</AlertTitle>
          <AlertDescription>
            Perpanjang langganan untuk menambah atau mengubah daftar tautan bio Anda.
          </AlertDescription>
        </Alert>
      ) : !permissions.canManagePlugins ? (
        <Alert variant="info">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode lihat saja ({permissions.roleLabel})</AlertTitle>
          <AlertDescription>
            Hubungi Pemilik Situs atau Admin untuk memperbarui konfigurasi Bio Links.
          </AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert variant={notice.variant} data-testid="bio-links-admin-notice">
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.description}</AlertDescription>
        </Alert>
      ) : null}

      {/* KPI summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Tautan Aktif</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="bio-kpi-active">
              {activeCount} / {links.length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Klik Pihak Pertama</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="bio-kpi-clicks">
              {totalClicks}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Beban JavaScript Publik</CardDescription>
            <CardTitle className="text-2xl tabular-nums">0 byte</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Profile Form */}
        <Card className="min-w-0 lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageCircleIcon className="size-4 text-primary" aria-hidden="true" />
              Profil Halaman /link
            </CardTitle>
            <CardDescription>
              Identitas singkat dan tombol WhatsApp yang tampil di kartu bio.
            </CardDescription>
          </CardHeader>
          <form onSubmit={(e) => void handleSaveProfile(e)}>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="bio-display-name" className="text-sm font-medium text-foreground">
                  Nama Tampilan
                </label>
                <Input
                  id="bio-display-name"
                  value={profile.displayName}
                  disabled={!permissions.canManagePlugins || savingProfile}
                  onChange={(e) => setProfile((p) => ({ ...p, displayName: e.target.value }))}
                  placeholder="Nama bisnis atau nama Anda"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="bio-headline" className="text-sm font-medium text-foreground">
                  Tagline / Profesi
                </label>
                <Input
                  id="bio-headline"
                  value={profile.headline}
                  disabled={!permissions.canManagePlugins || savingProfile}
                  onChange={(e) => setProfile((p) => ({ ...p, headline: e.target.value }))}
                  placeholder="Contoh: Sales Executive Resmi Jakarta"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="bio-text" className="text-sm font-medium text-foreground">
                  Deskripsi Singkat
                </label>
                <textarea
                  id="bio-text"
                  rows={3}
                  className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
                  value={profile.bioText}
                  disabled={!permissions.canManagePlugins || savingProfile}
                  onChange={(e) => setProfile((p) => ({ ...p, bioText: e.target.value }))}
                  placeholder="Ringkasan layanan atau promo utama"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="bio-avatar-url" className="text-sm font-medium text-foreground">
                  URL Foto Profil (Opsional)
                </label>
                <Input
                  id="bio-avatar-url"
                  value={profile.avatarUrl ?? ""}
                  disabled={!permissions.canManagePlugins || savingProfile}
                  onChange={(e) => setProfile((p) => ({ ...p, avatarUrl: e.target.value }))}
                  placeholder="https://contoh.id/avatar.webp atau /media/avatar.webp"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="bio-accent" className="text-sm font-medium text-foreground">
                  Warna Aksen (Hex)
                </label>
                <Input
                  id="bio-accent"
                  value={profile.themeAccent}
                  disabled={!permissions.canManagePlugins || savingProfile}
                  onChange={(e) => setProfile((p) => ({ ...p, themeAccent: e.target.value }))}
                  placeholder="#0F766E"
                />
              </div>

              <Separator />

              <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
                <div className="space-y-0.5">
                  <label htmlFor="bio-show-wa" className="text-sm font-medium text-foreground">
                    Tombol WhatsApp di /link
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Tampilkan tombol CTA WhatsApp di bawah daftar tautan.
                  </p>
                </div>
                <input
                  id="bio-show-wa"
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={profile.showWhatsappButton}
                  disabled={!permissions.canManagePlugins || savingProfile}
                  onChange={(e) =>
                    setProfile((p) => ({ ...p, showWhatsappButton: e.target.checked }))
                  }
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="bio-wa-phone" className="text-sm font-medium text-foreground">
                  Nomor WhatsApp
                </label>
                <Input
                  id="bio-wa-phone"
                  value={profile.whatsappPhone}
                  disabled={!permissions.canManagePlugins || savingProfile}
                  onChange={(e) => setProfile((p) => ({ ...p, whatsappPhone: e.target.value }))}
                  placeholder="081234567890"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="bio-wa-label" className="text-sm font-medium text-foreground">
                  Label Tombol WhatsApp
                </label>
                <Input
                  id="bio-wa-label"
                  value={profile.whatsappLabel}
                  disabled={!permissions.canManagePlugins || savingProfile}
                  onChange={(e) => setProfile((p) => ({ ...p, whatsappLabel: e.target.value }))}
                  placeholder="Hubungi via WhatsApp"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="bio-wa-message" className="text-sm font-medium text-foreground">
                  Pesan Bawaan WhatsApp (Opsional)
                </label>
                <Input
                  id="bio-wa-message"
                  value={profile.whatsappMessage ?? ""}
                  disabled={!permissions.canManagePlugins || savingProfile}
                  onChange={(e) => setProfile((p) => ({ ...p, whatsappMessage: e.target.value }))}
                  placeholder="Halo, saya menemukan tautan bio Anda."
                />
              </div>
            </CardContent>
            <CardFooter className="justify-end">
              <Button
                type="submit"
                size="sm"
                className="min-h-11 md:min-h-9"
                disabled={!permissions.canManagePlugins || savingProfile}
              >
                <SaveIcon className="size-4" aria-hidden="true" />
                {savingProfile ? "Menyimpan..." : "Simpan Profil"}
              </Button>
            </CardFooter>
          </form>
        </Card>

        {/* Link Builder & Click Stats */}
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Link2Icon className="size-4 text-primary" aria-hidden="true" />
                Tambah Tautan Baru
              </CardTitle>
              <CardDescription>
                Hanya menerima skema aman: https://, http://, tel:, mailto:, dan wa.me/.
              </CardDescription>
            </CardHeader>
            <form onSubmit={(e) => void handleAddLink(e)}>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="bio-new-label" className="text-sm font-medium text-foreground">
                    Judul Tautan
                  </label>
                  <Input
                    id="bio-new-label"
                    value={newLabel}
                    disabled={!permissions.canManagePlugins || addingLink}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="Contoh: Katalog Produk 2026"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="bio-new-url" className="text-sm font-medium text-foreground">
                    URL Tujuan
                  </label>
                  <Input
                    id="bio-new-url"
                    value={newUrl}
                    disabled={!permissions.canManagePlugins || addingLink}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="https://contoh.id/katalog"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="bio-new-subtitle" className="text-sm font-medium text-foreground">
                    Subjudul (Opsional)
                  </label>
                  <Input
                    id="bio-new-subtitle"
                    value={newSubtitle}
                    disabled={!permissions.canManagePlugins || addingLink}
                    onChange={(e) => setNewSubtitle(e.target.value)}
                    placeholder="Unduh brosur & daftar harga terbaru"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="bio-new-badge" className="text-sm font-medium text-foreground">
                    Lencana (Opsional)
                  </label>
                  <Input
                    id="bio-new-badge"
                    value={newBadge}
                    disabled={!permissions.canManagePlugins || addingLink}
                    onChange={(e) => setNewBadge(e.target.value)}
                    placeholder="Baru / Promo"
                  />
                </div>
              </CardContent>
              <CardFooter className="justify-end">
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-11 md:min-h-9"
                  disabled={!permissions.canManagePlugins || addingLink}
                >
                  <PlusIcon className="size-4" aria-hidden="true" />
                  {addingLink ? "Menambahkan..." : "Tambah Tautan"}
                </Button>
              </CardFooter>
            </form>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3Icon className="size-4 text-primary" aria-hidden="true" />
                Daftar Tautan & Statistik Klik Pihak Pertama
              </CardTitle>
              <CardDescription>
                Dihitung langsung di penyimpanan situs Anda tanpa cookie atau data pribadi pengunjung.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {links.length === 0 ? (
                <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  Belum ada tautan. Tambahkan tautan pertama Anda di atas.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tautan</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Klik</TableHead>
                      <TableHead className="text-right">Aksi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {links.map((item, idx) => (
                      <TableRow key={item.id} data-testid={`bio-admin-link-${item.id}`}>
                        <TableCell className="max-w-[220px]">
                          <div className="space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5 font-medium text-foreground">
                              <span className="break-words">{item.label}</span>
                              {item.badge ? (
                                <Badge variant="secondary">{item.badge}</Badge>
                              ) : null}
                            </div>
                            <p className="truncate font-mono text-xs text-muted-foreground">
                              {item.url}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={item.isActive ? "success" : "outline"}>
                            {item.isActive ? "Aktif" : "Dijeda"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {item.clickCount}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Naikkan urutan ${item.label}`}
                              disabled={!permissions.canManagePlugins || idx === 0}
                              onClick={() => void handleMoveLink(idx, -1)}
                            >
                              <ArrowUpIcon className="size-3.5" aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Turunkan urutan ${item.label}`}
                              disabled={!permissions.canManagePlugins || idx === links.length - 1}
                              onClick={() => void handleMoveLink(idx, 1)}
                            >
                              <ArrowDownIcon className="size-3.5" aria-hidden="true" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!permissions.canManagePlugins}
                              onClick={() => void handleToggleLink(item)}
                            >
                              {item.isActive ? "Jeda" : "Aktifkan"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Hapus tautan ${item.label}`}
                              disabled={!permissions.canManagePlugins}
                              onClick={() => void handleDeleteLink(item)}
                            >
                              <Trash2Icon className="size-3.5 text-destructive" aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}

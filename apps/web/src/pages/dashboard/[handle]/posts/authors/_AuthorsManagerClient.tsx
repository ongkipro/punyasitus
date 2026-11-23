import { useState } from "react";
import {
  ArrowLeftIcon,
  ImageIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  UserIcon,
  XIcon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  ConfirmDestructiveDialog,
  fieldErrorsToMap,
  InlineFieldError,
  LockedTenantBanner,
  StaleWriteRecoveryBanner,
} from "@/components/admin/editor";
import type { CmsAdminPermissions } from "@/components/admin/editor/cms-server-context";
import { MediaPickerSheet, type MediaLibraryItemDto } from "@/components/admin/media";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface AuthorProfileItemDto {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly roleTitle: string | null;
  readonly bio: string | null;
  readonly avatarMediaId: number | null;
  readonly avatar: {
    readonly id?: number;
    readonly url: string;
    readonly alt: string;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly sameAs: readonly string[];
  readonly postCount: number;
  readonly publishedPostCount: number;
  readonly version: number;
  readonly updatedAt: string;
}

export interface AuthorsManagerClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly initialAuthors: readonly AuthorProfileItemDto[];
}

export function AuthorsManagerClient({
  handle,
  basePath,
  permissions,
  initialAuthors,
}: AuthorsManagerClientProps) {
  const [authors, setAuthors] = useState<readonly AuthorProfileItemDto[]>(initialAuthors);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingVersion, setEditingVersion] = useState<number>(1);
  const [name, setName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [bio, setBio] = useState("");
  const [avatarMediaId, setAvatarMediaId] = useState<number | null>(null);
  const [sameAsText, setSameAsText] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<AuthorProfileItemDto | null>(null);
  const [detachOnDelete, setDetachOnDelete] = useState(false);
  const [feedback, setFeedback] = useState<{
    readonly tone: "success" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);

  const readOnly = !permissions.canWriteContent;

  function resetForm() {
    setEditingId(null);
    setEditingVersion(1);
    setName("");
    setRoleTitle("");
    setBio("");
    setAvatarMediaId(null);
    setSameAsText("");
    setFieldErrors({});
    setConflictMessage(null);
  }

  function startEdit(author: AuthorProfileItemDto) {
    setEditingId(author.id);
    setEditingVersion(author.version);
    setName(author.name);
    setRoleTitle(author.roleTitle ?? "");
    setBio(author.bio ?? "");
    setAvatarMediaId(author.avatarMediaId);
    setSameAsText(author.sameAs.join("\n"));
    setFieldErrors({});
    setConflictMessage(null);
    setFeedback(null);
  }

  async function reloadAuthors() {
    setReloading(true);
    try {
      const res = await cmsFetchJson<{ readonly items: readonly AuthorProfileItemDto[] }>(
        `/api/tenants/${encodeURIComponent(handle)}/posts/authors`,
      );
      setAuthors(res.items);
      if (editingId !== null) {
        const refreshed = res.items.find((a) => a.id === editingId);
        if (refreshed) {
          startEdit(refreshed);
        } else {
          resetForm();
        }
      }
      setConflictMessage(null);
    } catch (err) {
      setFeedback({
        tone: "destructive",
        title: "Gagal memuat daftar penulis",
        message: err instanceof Error ? err.message : "Terjadi kesalahan.",
      });
    } finally {
      setReloading(false);
    }
  }

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (readOnly || submitting) return;

    const cleanName = name.trim();
    const errs: Record<string, string> = {};
    if (!cleanName) errs.name = "Nama penulis wajib diisi.";
    if (roleTitle.trim().length > 100) errs.roleTitle = "Peran/jabatan maksimal 100 karakter.";
    if (bio.trim().length > 300) errs.bio = "Bio maksimal 300 karakter.";

    const sameAsList = sameAsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (sameAsList.length > 5) {
      errs.sameAs = "Maksimal 5 tautan profil (HTTPS).";
    }

    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }

    setSubmitting(true);
    setFieldErrors({});
    setConflictMessage(null);
    setFeedback(null);

    try {
      const payload = {
        name: cleanName,
        roleTitle: roleTitle.trim() ? roleTitle.trim() : null,
        bio: bio.trim() ? bio.trim() : null,
        avatarMediaId,
        sameAs: sameAsList,
      };

      let saved: AuthorProfileItemDto;
      if (editingId === null) {
        saved = await cmsFetchJson<AuthorProfileItemDto>(
          `/api/tenants/${encodeURIComponent(handle)}/posts/authors`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );
        setAuthors((prev) => [...prev, saved]);
        resetForm();
        setFeedback({
          tone: "success",
          title: "Profil penulis ditambahkan",
          message: `"${saved.name}" kini dapat dipilih sebagai penulis artikel blog.`,
        });
      } else {
        saved = await cmsFetchJson<AuthorProfileItemDto>(
          `/api/tenants/${encodeURIComponent(handle)}/posts/authors/${editingId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              ...payload,
              version: editingVersion,
            }),
          },
        );
        setAuthors((prev) => prev.map((a) => (a.id === saved.id ? saved : a)));
        resetForm();
        setFeedback({
          tone: "success",
          title: "Profil penulis diperbarui",
          message: `Perubahan profil "${saved.name}" telah disimpan (v${saved.version}).`,
        });
      }
    } catch (err) {
      if (err instanceof CmsApiError) {
        if (err.isStaleVersion) {
          setConflictMessage(err.message);
        } else {
          setFieldErrors(fieldErrorsToMap(err.fields));
          setFeedback({
            tone: "destructive",
            title: "Gagal menyimpan profil penulis",
            message: err.message,
          });
        }
      } else {
        setFeedback({
          tone: "destructive",
          title: "Gagal menyimpan profil penulis",
          message: "Gangguan koneksi terjadi. Silakan coba lagi.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget || readOnly || submitting) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      await cmsFetchJson(
        `/api/tenants/${encodeURIComponent(handle)}/posts/authors/${deleteTarget.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            version: deleteTarget.version,
            ...(detachOnDelete ? { detach: true } : {}),
          }),
        },
      );
      const removedName = deleteTarget.name;
      setAuthors((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      if (editingId === deleteTarget.id) resetForm();
      setDeleteTarget(null);
      setDetachOnDelete(false);
      setFeedback({
        tone: "success",
        title: "Profil penulis dihapus",
        message: `"${removedName}" telah dihapus dari daftar penulis.`,
      });
    } catch (err) {
      setDeleteTarget(null);
      setDetachOnDelete(false);
      if (err instanceof CmsApiError && err.isStaleVersion) {
        await reloadAuthors();
        setFeedback({
          tone: "destructive",
          title: "Data telah berubah (409)",
          message: "Daftar penulis telah dimuat ulang. Silakan ulangi tindakan Anda.",
        });
      } else {
        setFeedback({
          tone: "destructive",
          title: "Gagal menghapus profil penulis",
          message: err instanceof Error ? err.message : "Terjadi kesalahan.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 pb-16" data-testid="authors-manager-screen">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 -ml-2 md:min-h-8"
            render={<a href={`${basePath}/posts`} />}
          >
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            Daftar Artikel
          </Button>
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
            Profil Penulis Blog
          </h1>
          <p className="text-sm text-muted-foreground">
            Kelola byline penulis (nama, peran, bio, dan avatar) yang tampil di artikel publik serta
            JSON-LD <code>Article.author</code>.
          </p>
        </div>
      </div>

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/service-status`} />}

      {conflictMessage && (
        <StaleWriteRecoveryBanner
          message={conflictMessage}
          reloading={reloading}
          onReloadLatest={reloadAuthors}
        />
      )}

      {feedback && (
        <Alert variant={feedback.tone} data-testid="authors-feedback">
          <AlertTitle>{feedback.title}</AlertTitle>
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              {editingId === null ? "Tambah Profil Penulis" : "Edit Profil Penulis"}
            </CardTitle>
            <CardDescription>
              Informasi ini tampil pada byline dan kotak penulis di artikel blog publik.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4" data-testid="author-profile-form">
              <div className="space-y-1.5">
                <label htmlFor="author-name" className="block text-sm font-medium text-foreground">
                  Nama Penulis <span className="text-destructive">*</span>
                </label>
                <Input
                  id="author-name"
                  value={name}
                  disabled={readOnly}
                  maxLength={120}
                  aria-invalid={Boolean(fieldErrors.name)}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Contoh: Rina Kartika, S.Ars"
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                  data-testid="author-name-input"
                />
                <InlineFieldError message={fieldErrors.name} />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="author-role-title"
                  className="block text-sm font-medium text-foreground"
                >
                  Peran / Jabatan
                </label>
                <Input
                  id="author-role-title"
                  value={roleTitle}
                  disabled={readOnly}
                  maxLength={100}
                  aria-invalid={Boolean(fieldErrors.roleTitle)}
                  onChange={(e) => setRoleTitle(e.target.value)}
                  placeholder="Contoh: Principal Architect & Lead Auditor"
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                  data-testid="author-role-input"
                />
                <InlineFieldError message={fieldErrors.roleTitle} />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="author-bio" className="block text-sm font-medium text-foreground">
                    Bio Singkat
                  </label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {bio.trim().length}/300
                  </span>
                </div>
                <textarea
                  id="author-bio"
                  rows={3}
                  maxLength={300}
                  value={bio}
                  disabled={readOnly}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="Pengalaman singkat dan keahlian penulis (maks. 300 karakter)."
                  className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:text-sm"
                  data-testid="author-bio-input"
                />
                <InlineFieldError message={fieldErrors.bio} />
              </div>

              <div className="space-y-2">
                <span className="block text-sm font-medium text-foreground">Foto Avatar</span>
                {avatarMediaId !== null ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                    <div className="flex items-center gap-2 text-sm">
                      <ImageIcon className="size-4 text-primary" aria-hidden="true" />
                      <span className="font-medium tabular-nums">Media #{avatarMediaId}</span>
                    </div>
                    {!readOnly && (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Hapus avatar penulis"
                        onClick={() => setAvatarMediaId(null)}
                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                      >
                        <XIcon className="size-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Opsional. Jika kosong, inisial nama penulis ditampilkan.
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={readOnly}
                  onClick={() => setMediaPickerOpen(true)}
                  className="min-h-11 w-full md:min-h-9"
                  data-testid="author-pick-avatar-btn"
                >
                  <ImageIcon className="size-4" aria-hidden="true" />
                  {avatarMediaId !== null ? "Ganti Avatar dari Media" : "Pilih Avatar dari Media"}
                </Button>
                <InlineFieldError message={fieldErrors.avatarMediaId} />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="author-sameas"
                  className="block text-sm font-medium text-foreground"
                >
                  Tautan Profil (sameAs, maks. 5 URL HTTPS)
                </label>
                <textarea
                  id="author-sameas"
                  rows={2}
                  value={sameAsText}
                  disabled={readOnly}
                  onChange={(e) => setSameAsText(e.target.value)}
                  placeholder={"https://linkedin.com/in/rinakartika\nhttps://instagram.com/rinakartika"}
                  className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  data-testid="author-sameas-input"
                />
                <InlineFieldError message={fieldErrors.sameAs} />
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="submit"
                  disabled={readOnly || submitting}
                  className="min-h-11 md:min-h-9"
                  data-testid="author-save-btn"
                >
                  {editingId === null ? (
                    <PlusIcon className="size-4" aria-hidden="true" />
                  ) : (
                    <SaveIcon className="size-4" aria-hidden="true" />
                  )}
                  {submitting
                    ? "Menyimpan..."
                    : editingId === null
                      ? "Simpan Penulis"
                      : "Simpan Perubahan"}
                </Button>
                {editingId !== null && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={resetForm}
                    className="min-h-11 md:min-h-9"
                    data-testid="author-cancel-edit-btn"
                  >
                    Batal
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-3 lg:col-span-3" data-testid="authors-list">
          {authors.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <UserIcon className="size-8 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">Belum ada profil penulis</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  Tambahkan profil penulis agar artikel blog menampilkan byline kredibel dan data
                  terstruktur <code>Article.author</code>.
                </p>
              </CardContent>
            </Card>
          ) : (
            authors.map((author) => (
              <Card key={author.id} data-testid="author-card" data-author-id={String(author.id)}>
                <CardContent className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    {author.avatar ? (
                      <img
                        src={author.avatar.url}
                        alt={author.avatar.alt}
                        width={48}
                        height={48}
                        className="size-12 shrink-0 rounded-full border border-border object-cover"
                      />
                    ) : (
                      <span
                        className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary"
                        aria-hidden="true"
                      >
                        {author.name
                          .split(/\s+/)
                          .filter(Boolean)
                          .slice(0, 2)
                          .map((p) => p.charAt(0).toUpperCase())
                          .join("") || "P"}
                      </span>
                    )}
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-base font-semibold text-foreground">
                          {author.name}
                        </h2>
                        <Badge variant="outline" className="tabular-nums">
                          {author.postCount} artikel
                        </Badge>
                      </div>
                      {author.roleTitle && (
                        <p className="text-xs font-medium text-primary">{author.roleTitle}</p>
                      )}
                      {author.bio && (
                        <p className="text-sm text-muted-foreground">{author.bio}</p>
                      )}
                      {author.sameAs.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {author.sameAs.length} tautan profil terverifikasi
                        </p>
                      )}
                    </div>
                  </div>

                  {!readOnly && (
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => startEdit(author)}
                        className="min-h-11 md:min-h-8"
                        data-testid={`author-edit-btn-${author.id}`}
                      >
                        <PencilIcon className="size-3.5" aria-hidden="true" />
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setDeleteTarget(author);
                          setDetachOnDelete(author.postCount > 0);
                        }}
                        className="min-h-11 md:min-h-8"
                        data-testid={`author-delete-btn-${author.id}`}
                      >
                        <Trash2Icon className="size-3.5" aria-hidden="true" />
                        Hapus
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>

      <MediaPickerSheet
        open={mediaPickerOpen}
        onOpenChange={setMediaPickerOpen}
        handle={handle}
        selectedMediaId={avatarMediaId}
        canUpload={permissions.canUploadMedia}
        title="Pilih Foto Avatar Penulis"
        onSelect={(item: MediaLibraryItemDto) => {
          setAvatarMediaId(item.id);
          setMediaPickerOpen(false);
        }}
      />

      <ConfirmDestructiveDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDetachOnDelete(false);
          }
        }}
        title="Hapus profil penulis?"
        description={
          deleteTarget
            ? deleteTarget.postCount > 0
              ? `Profil "${deleteTarget.name}" saat ini terpasang pada ${deleteTarget.postCount} artikel. Menghapus akan melepaskan tautan penulis pada artikel tersebut.`
              : `Profil "${deleteTarget.name}" akan dihapus permanen dari daftar penulis situs ini.`
            : ""
        }
        confirmLabel="Hapus Penulis"
        busy={submitting}
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  );
}

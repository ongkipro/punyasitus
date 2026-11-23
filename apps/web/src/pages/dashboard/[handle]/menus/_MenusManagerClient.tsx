import { useCallback, useState } from "react";
import {
  MAX_MENU_DEPTH,
  MAX_MENU_ITEMS,
  validateMenuHref,
  type MenuLocation,
  type MenuTargetType,
} from "@punyasitus/core/menu-builder";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  MenuIcon,
  PlusIcon,
  SaveIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  ConfirmDestructiveDialog,
  InlineFieldError,
  LockedTenantBanner,
  StaleWriteRecoveryBanner,
  useDirtyNavigationGuard,
} from "@/components/admin/editor/cms-client-helpers";
import type { CmsAdminPermissions } from "@/components/admin/editor/cms-server-context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface EditableMenuItem {
  readonly id: string;
  readonly parentId: string | null;
  readonly label: string;
  readonly href: string;
  readonly openInNewTab: boolean;
  readonly targetType: MenuTargetType;
  readonly targetResourceId: number | null;
}

export interface MenuLocationStateDto {
  readonly location: MenuLocation;
  readonly flatItems: readonly EditableMenuItem[];
  readonly version: number;
}

export interface MenuResourceOption {
  readonly id: number;
  readonly title: string;
  readonly href: string;
}

export interface MenusManagerClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly initialMenus: Readonly<Record<MenuLocation, MenuLocationStateDto>>;
  readonly pageOptions: readonly MenuResourceOption[];
}

const LOCATION_TABS: ReadonlyArray<{ readonly id: MenuLocation; readonly label: string; readonly desc: string }> = [
  { id: "header", label: "Menu Header", desc: "Tampil pada bilah navigasi atas situs publik (maks 3 tingkat)." },
  { id: "footer", label: "Menu Footer", desc: "Tautan informasi di bagian bawah situs publik." },
  { id: "mobile", label: "Menu Mobile", desc: "Navigasi khusus layar ponsel (opsional; fallback ke Header jika kosong)." },
];

function computeDepth(items: readonly EditableMenuItem[], itemId: string): number {
  const byId = new Map(items.map((it) => [it.id, it]));
  let depth = 1;
  let cur = byId.get(itemId);
  const visited = new Set<string>([itemId]);
  while (cur?.parentId) {
    if (visited.has(cur.parentId)) break;
    visited.add(cur.parentId);
    depth += 1;
    cur = byId.get(cur.parentId);
  }
  return depth;
}

function getSubtreeMaxAdditionalDepth(
  items: readonly EditableMenuItem[],
  rootId: string,
): number {
  let maxExtra = 0;
  const children = items.filter((it) => it.parentId === rootId);
  for (const child of children) {
    maxExtra = Math.max(maxExtra, 1 + getSubtreeMaxAdditionalDepth(items, child.id));
  }
  return maxExtra;
}

export function MenusManagerClient({
  handle,
  basePath,
  permissions,
  initialMenus,
  pageOptions,
}: MenusManagerClientProps) {
  const [activeLocation, setActiveLocation] = useState<MenuLocation>("header");
  const [menusByLoc, setMenusByLoc] = useState<Record<MenuLocation, MenuLocationStateDto>>({
    header: initialMenus.header,
    footer: initialMenus.footer,
    mobile: initialMenus.mobile,
  });

  // Add-item form state
  const [newLabel, setNewLabel] = useState("");
  const [newTargetType, setNewTargetType] = useState<MenuTargetType>("custom");
  const [newHref, setNewHref] = useState("/");
  const [newPageId, setNewPageId] = useState<string>("");
  const [newOpenInNewTab, setNewOpenInNewTab] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [dirtyByLocation, setDirtyByLocation] = useState<Record<MenuLocation, boolean>>({
    header: false,
    footer: false,
    mobile: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [banner, setBanner] = useState<{
    readonly tone: "success" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  const isCurrentDirty = dirtyByLocation[activeLocation];
  const isAnyDirty = dirtyByLocation.header || dirtyByLocation.footer || dirtyByLocation.mobile;

  useDirtyNavigationGuard(isAnyDirty);

  const readOnly = !permissions.canManageMenus;
  const currentMenu = menusByLoc[activeLocation];
  const items = currentMenu.flatItems;

  const updateCurrentItems = useCallback(
    (updater: (prev: readonly EditableMenuItem[]) => readonly EditableMenuItem[]) => {
      setMenusByLoc((prev) => ({
        ...prev,
        [activeLocation]: {
          ...prev[activeLocation],
          flatItems: updater(prev[activeLocation].flatItems),
        },
      }));
      setDirtyByLocation((prev) => ({ ...prev, [activeLocation]: true }));
      setBanner(null);
    },
    [activeLocation],
  );

  function handleAddItem(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (readOnly) return;
    setAddError(null);

    if (items.length >= MAX_MENU_ITEMS) {
      setAddError(`Maksimal ${MAX_MENU_ITEMS} item menu per lokasi.`);
      return;
    }

    const label = newLabel.trim();
    if (!label || label.length > 80) {
      setAddError("Label menu wajib diisi (1–80 karakter).");
      return;
    }

    let resolvedHref = newHref.trim();
    let targetResourceId: number | null = null;
    if (newTargetType === "page") {
      const picked = pageOptions.find((p) => String(p.id) === newPageId);
      if (!picked) {
        setAddError("Pilih halaman tujuan dari daftar.");
        return;
      }
      resolvedHref = picked.href;
      targetResourceId = picked.id;
    } else {
      try {
        const validated = validateMenuHref(resolvedHref, { openInNewTab: newOpenInNewTab });
        resolvedHref = validated.href;
      } catch (err) {
        setAddError(
          err instanceof Error
            ? err.message
            : "URL menu tidak valid (gunakan path '/', '#anchor', atau 'https://').",
        );
        return;
      }
    }

    const uniqueId = `menu-${Date.now().toString(36)}-${items.length + 1}`;
    updateCurrentItems((prev) => [
      ...prev,
      {
        id: uniqueId,
        parentId: null,
        label,
        href: resolvedHref,
        openInNewTab: newOpenInNewTab,
        targetType: newTargetType,
        targetResourceId,
      },
    ]);
    setNewLabel("");
    setNewHref(newTargetType === "external" ? "https://" : "/");
    setNewOpenInNewTab(false);
  }

  function moveItem(index: number, delta: -1 | 1) {
    if (readOnly) return;
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    updateCurrentItems((prev) => {
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(target, 0, moved);
      return next;
    });
  }

  function indentItem(index: number) {
    if (readOnly || index <= 0) return;
    const item = items[index]!;
    const prevItem = items[index - 1]!;
    const prevDepth = computeDepth(items, prevItem.id);
    const subtreeExtra = getSubtreeMaxAdditionalDepth(items, item.id);
    if (prevDepth + 1 + subtreeExtra > MAX_MENU_DEPTH) {
      setBanner({
        tone: "destructive",
        title: "Batas kedalaman menu tercapai",
        message: `Menu navigasi mendukung maksimal ${MAX_MENU_DEPTH} tingkat.`,
      });
      return;
    }
    updateCurrentItems((prev) =>
      prev.map((it, idx) => (idx === index ? { ...it, parentId: prevItem.id } : it)),
    );
  }

  function outdentItem(index: number) {
    if (readOnly) return;
    const item = items[index]!;
    if (!item.parentId) return;
    const parent = items.find((it) => it.id === item.parentId);
    const nextParentId = parent?.parentId ?? null;
    updateCurrentItems((prev) =>
      prev.map((it, idx) => (idx === index ? { ...it, parentId: nextParentId } : it)),
    );
  }

  function removeItem(index: number) {
    if (readOnly) return;
    const target = items[index]!;
    updateCurrentItems((prev) =>
      prev
        .filter((_, idx) => idx !== index)
        .map((it) => (it.parentId === target.id ? { ...it, parentId: target.parentId } : it)),
    );
  }

  function editItemField(index: number, patch: Partial<EditableMenuItem>) {
    if (readOnly) return;
    updateCurrentItems((prev) =>
      prev.map((it, idx) => (idx === index ? { ...it, ...patch } : it)),
    );
  }

  async function handleSaveMenu(publish: boolean) {
    if (readOnly || submitting) return;
    setSubmitting(true);
    setConflictMessage(null);
    setBanner(null);

    try {
      const payloadItems = items.map((it, idx) => ({
        id: it.id,
        parentId: it.parentId,
        label: it.label.trim(),
        href: it.href.trim(),
        openInNewTab: it.openInNewTab,
        sortOrder: idx,
        targetType: it.targetType,
        ...(it.targetResourceId !== null ? { targetResourceId: it.targetResourceId } : {}),
      }));

      const saved = await cmsFetchJson<{
        readonly location: MenuLocation;
        readonly flatItems: readonly EditableMenuItem[];
        readonly version: number;
      }>(`/api/tenants/${encodeURIComponent(handle)}/menus/${activeLocation}`, {
        method: "PUT",
        body: JSON.stringify({
          items: payloadItems,
          version: currentMenu.version,
          publish,
        }),
      });

      setMenusByLoc((prev) => ({
        ...prev,
        [activeLocation]: {
          location: activeLocation,
          flatItems: saved.flatItems,
          version: saved.version,
        },
      }));
      setDirtyByLocation((prev) => ({ ...prev, [activeLocation]: false }));
      setBanner({
        tone: "success",
        title: publish ? "Menu disimpan & diterbitkan" : "Draf menu tersimpan",
        message: `Menu ${activeLocation} kini pada versi v${saved.version}.`,
      });
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        setConflictMessage(err.message);
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal menyimpan menu",
          message: err instanceof Error ? err.message : "Periksa kembali tautan menu Anda.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReloadLatest() {
    setReloading(true);
    try {
      const fresh = await cmsFetchJson<{
        readonly location: MenuLocation;
        readonly flatItems: readonly EditableMenuItem[];
        readonly version: number;
      }>(`/api/tenants/${encodeURIComponent(handle)}/menus/${activeLocation}`);
      setMenusByLoc((prev) => ({
        ...prev,
        [activeLocation]: {
          location: activeLocation,
          flatItems: fresh.flatItems,
          version: fresh.version,
        },
      }));
      setConflictMessage(null);
      setDirtyByLocation((prev) => ({ ...prev, [activeLocation]: false }));
      setBanner({
        tone: "success",
        title: "Versi terbaru menu dimuat",
        message: `Menu ${activeLocation} disinkronkan ke versi v${fresh.version}.`,
      });
    } catch (err) {
      setBanner({
        tone: "destructive",
        title: "Gagal memuat ulang menu",
        message: err instanceof Error ? err.message : "Silakan muat ulang halaman.",
      });
    } finally {
      setReloading(false);
    }
  }

  async function handleConfirmResetMenu() {
    if (readOnly || submitting) return;
    setSubmitting(true);
    try {
      const res = await cmsFetchJson<{ readonly version: number }>(
        `/api/tenants/${encodeURIComponent(handle)}/menus/${activeLocation}`,
        {
          method: "DELETE",
          body: JSON.stringify({ version: currentMenu.version }),
        },
      );
      setMenusByLoc((prev) => ({
        ...prev,
        [activeLocation]: {
          location: activeLocation,
          flatItems: [],
          version: res.version,
        },
      }));
      setResetDialogOpen(false);
      setDirtyByLocation((prev) => ({ ...prev, [activeLocation]: false }));
      setBanner({
        tone: "success",
        title: "Menu dikosongkan",
        message: `Seluruh item pada menu ${activeLocation} telah dihapus.`,
      });
    } catch (err) {
      setResetDialogOpen(false);
      if (err instanceof CmsApiError && err.isStaleVersion) {
        setConflictMessage(err.message);
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal mengosongkan menu",
          message: err instanceof Error ? err.message : "Terjadi kesalahan.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const activeTabInfo = LOCATION_TABS.find((t) => t.id === activeLocation)!;

  return (
    <div
      className="space-y-6 pb-16"
      data-testid="menus-manager-screen"
      data-dirty={isAnyDirty ? "true" : "false"}
      data-version={String(currentMenu.version)}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
              Menu Navigasi
            </h1>
            <Badge variant="outline" className="tabular-nums" data-testid="menu-version-badge">
              v{currentMenu.version}
            </Badge>
            {isCurrentDirty && (
              <Badge variant="warning" data-testid="dirty-indicator">
                Belum disimpan
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Atur struktur tautan Header, Footer, dan Mobile hingga 3 tingkat menggunakan kontrol
            keyboard Naik/Turun.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={readOnly || submitting}
            onClick={() => void handleSaveMenu(false)}
            className="min-h-11 md:min-h-9"
            data-testid="menu-save-draft-btn"
          >
            <SaveIcon className="size-4" aria-hidden="true" />
            Simpan Draf
          </Button>
          <Button
            type="button"
            disabled={readOnly || submitting}
            onClick={() => void handleSaveMenu(true)}
            className="min-h-11 md:min-h-9"
            data-testid="menu-save-publish-btn"
          >
            {submitting ? "Menyimpan..." : "Simpan & Terbitkan"}
          </Button>
        </div>
      </div>

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/service-status`} />}

      {!permissions.canManageMenus && !permissions.isLocked && (
        <Alert variant="warning" data-testid="menus-rbac-notice" data-state-panel="permission-denied">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode baca saja untuk peran {permissions.roleLabel}</AlertTitle>
          <AlertDescription>
            Peran akun Anda saat ini tidak memiliki izin untuk mengubah menu navigasi situs.
          </AlertDescription>
        </Alert>
      )}

      {conflictMessage && (
        <StaleWriteRecoveryBanner
          message={conflictMessage}
          reloading={reloading}
          onReloadLatest={handleReloadLatest}
        />
      )}

      {banner && (
        <Alert variant={banner.tone} data-testid="menus-feedback">
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      <div
        role="tablist"
        aria-label="Pilih lokasi menu"
        className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card p-1"
      >
        {LOCATION_TABS.map((tab) => (
          <Button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeLocation === tab.id}
            size="sm"
            variant={activeLocation === tab.id ? "default" : "ghost"}
            onClick={() => {
              setActiveLocation(tab.id);
              setConflictMessage(null);
            }}
            className="min-h-11 md:min-h-8"
            data-testid={`menu-tab-${tab.id}`}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {/* Add Menu Item Form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tambah Item ke {activeTabInfo.label}</CardTitle>
          <CardDescription>{activeTabInfo.desc}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleAddItem}
            className="grid grid-cols-1 gap-3 md:grid-cols-12 md:items-end"
          >
            <div className="space-y-1.5 md:col-span-3">
              <label htmlFor="menu-new-label" className="block text-sm font-medium text-foreground">
                Label Menu
              </label>
              <Input
                id="menu-new-label"
                maxLength={80}
                value={newLabel}
                disabled={readOnly}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Contoh: Layanan Kami"
                className="min-h-11 text-base md:min-h-9 md:text-sm"
                data-testid="menu-new-label"
              />
            </div>

            <div className="space-y-1.5 md:col-span-3">
              <label htmlFor="menu-new-type" className="block text-sm font-medium text-foreground">
                Jenis Tujuan
              </label>
              <select
                id="menu-new-type"
                value={newTargetType}
                disabled={readOnly}
                onChange={(e) => {
                  const t = e.target.value as MenuTargetType;
                  setNewTargetType(t);
                  if (t === "external") setNewHref("https://");
                  else if (t === "whatsapp") setNewHref("https://wa.me/6281234567890");
                  else setNewHref("/");
                }}
                className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                data-testid="menu-new-type"
              >
                <option value="custom">Rute Internal (/... atau #anchor)</option>
                <option value="page">Halaman Situs</option>
                <option value="external">Tautan Eksternal (https://)</option>
                <option value="whatsapp">WhatsApp (https://wa.me/...)</option>
              </select>
            </div>

            <div className="space-y-1.5 md:col-span-4">
              {newTargetType === "page" ? (
                <>
                  <label htmlFor="menu-new-page" className="block text-sm font-medium text-foreground">
                    Pilih Halaman
                  </label>
                  <select
                    id="menu-new-page"
                    value={newPageId}
                    disabled={readOnly}
                    onChange={(e) => {
                      setNewPageId(e.target.value);
                      const found = pageOptions.find((p) => String(p.id) === e.target.value);
                      if (found && !newLabel.trim()) {
                        setNewLabel(found.title);
                      }
                    }}
                    className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                  >
                    <option value="">-- Pilih halaman --</option>
                    {pageOptions.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {p.title} ({p.href})
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <label htmlFor="menu-new-href" className="block text-sm font-medium text-foreground">
                    Alamat URL / Path
                  </label>
                  <Input
                    id="menu-new-href"
                    value={newHref}
                    disabled={readOnly}
                    onChange={(e) => setNewHref(e.target.value)}
                    placeholder="/layanan atau https://contoh.co.id"
                    className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                    data-testid="menu-new-href"
                  />
                </>
              )}
            </div>

            <div className="md:col-span-2">
              <Button
                type="submit"
                disabled={readOnly}
                className="min-h-11 w-full md:min-h-9"
                data-testid="menu-add-item-btn"
              >
                <PlusIcon className="size-4" aria-hidden="true" />
                Tambah
              </Button>
            </div>

            <div className="md:col-span-12">
              <label className="inline-flex min-h-9 items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={newOpenInNewTab}
                  disabled={readOnly}
                  onChange={(e) => setNewOpenInNewTab(e.target.checked)}
                  className="size-4 rounded border-input accent-primary"
                  data-testid="menu-new-tab-checkbox"
                />
                <span>Buka tautan di tab baru</span>
              </label>
            </div>

            {addError && (
              <div className="md:col-span-12">
                <InlineFieldError message={addError} />
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      {/* Menu Items List with Keyboard Reorder Controls */}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">
              Struktur {activeTabInfo.label} ({items.length}/{MAX_MENU_ITEMS})
            </CardTitle>
            <CardDescription>
              Gunakan tombol Naik, Turun, dan Submenu untuk menata urutan secara aksesibel tanpa
              drag-and-drop.
            </CardDescription>
          </div>
          {items.length > 0 && !readOnly && (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => setResetDialogOpen(true)}
              className="min-h-11 md:min-h-8"
              data-testid="menu-reset-btn"
            >
              <Trash2Icon className="size-3.5" aria-hidden="true" />
              Kosongkan Menu
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <MenuIcon className="size-4" aria-hidden="true" />
                <span>Belum ada item pada {activeTabInfo.label}</span>
              </div>
              <p>Tambahkan tautan pertama menggunakan formulir di atas.</p>
            </div>
          ) : (
            <ul className="space-y-2.5" data-testid="menu-items-list">
              {items.map((item, idx) => {
                const depth = computeDepth(items, item.id);
                return (
                  <li
                    key={item.id}
                    data-testid={`menu-item-row-${idx}`}
                    data-menu-item-id={item.id}
                    style={{ marginLeft: `${(depth - 1) * 16}px` }}
                    className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                      <Input
                        aria-label={`Label item menu ${idx + 1}`}
                        value={item.label}
                        disabled={readOnly}
                        onChange={(e) => editItemField(idx, { label: e.target.value })}
                        className="min-h-11 text-base md:min-h-9 md:text-sm"
                      />
                      <Input
                        aria-label={`URL item menu ${idx + 1}`}
                        value={item.href}
                        disabled={readOnly}
                        onChange={(e) => editItemField(idx, { href: e.target.value })}
                        className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant="outline" className="tabular-nums">
                        Lv {depth}
                      </Badge>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        disabled={readOnly || idx === 0}
                        onClick={() => moveItem(idx, -1)}
                        aria-label={`Pindahkan ${item.label} naik`}
                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                        data-testid={`menu-move-up-${idx}`}
                      >
                        <ArrowUpIcon className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        disabled={readOnly || idx === items.length - 1}
                        onClick={() => moveItem(idx, 1)}
                        aria-label={`Pindahkan ${item.label} turun`}
                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                        data-testid={`menu-move-down-${idx}`}
                      >
                        <ArrowDownIcon className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        disabled={readOnly || idx === 0 || depth >= MAX_MENU_DEPTH}
                        onClick={() => indentItem(idx)}
                        aria-label={`Jadikan ${item.label} submenu`}
                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                      >
                        <ArrowRightIcon className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        disabled={readOnly || !item.parentId}
                        onClick={() => outdentItem(idx)}
                        aria-label={`Naikkan level ${item.label}`}
                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                      >
                        <ArrowLeftIcon className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="destructive"
                        disabled={readOnly}
                        onClick={() => removeItem(idx)}
                        aria-label={`Hapus ${item.label}`}
                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                        data-testid={`menu-remove-${idx}`}
                      >
                        <Trash2Icon className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmDestructiveDialog
        open={resetDialogOpen}
        onOpenChange={setResetDialogOpen}
        title={`Kosongkan seluruh item ${activeTabInfo.label}?`}
        description="Seluruh tautan pada lokasi menu ini akan dihapus dari konfigurasi navigasi."
        confirmLabel="Kosongkan Menu"
        busy={submitting}
        onConfirm={handleConfirmResetMenu}
      />
    </div>
  );
}

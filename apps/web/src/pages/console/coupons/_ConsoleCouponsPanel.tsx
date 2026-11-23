import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  TagIcon,
} from "lucide-react";
import {
  buildSafeConsoleAuthHref,
  formatIdr,
  formatWibDateTime,
  validateConsoleAuditReason,
} from "@/components/admin/billing/helpers";
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
import type { ConsolePromoCouponDto } from "../../api/console/coupons/_shared";

export interface ConsoleCouponsPanelProps {
  readonly initialCoupons: readonly ConsolePromoCouponDto[];
  readonly stepUpFresh: boolean;
  readonly initialNowMs: number;
}

interface ConsoleCouponApiResponse {
  readonly success?: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly verifyPath?: string;
  readonly coupon?: ConsolePromoCouponDto;
  readonly coupons?: readonly ConsolePromoCouponDto[];
  readonly fields?: readonly { readonly field: string; readonly message: string }[];
}

function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDiscountSummary(coupon: ConsolePromoCouponDto): string {
  if (coupon.discountKind === "percent") {
    return `${coupon.discountValue}%`;
  }
  return formatIdr(coupon.discountValue);
}

function getCouponLifecycleBadge(
  coupon: ConsolePromoCouponDto,
  nowMs: number,
): { readonly label: string; readonly variant: "success" | "outline" | "warning" | "destructive" } {
  if (!coupon.active) {
    return { label: "Nonaktif", variant: "outline" };
  }
  if (nowMs > coupon.endsAtMs) {
    return { label: "Kedaluwarsa", variant: "destructive" };
  }
  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
    return { label: "Kuota Habis", variant: "warning" };
  }
  if (nowMs < coupon.startsAtMs) {
    return { label: "Terjadwal", variant: "warning" };
  }
  return { label: "Aktif", variant: "success" };
}

/**
 * Superadmin Console Coupon Management Island (`base-nova` / `@base-ui/react` only).
 */
export function ConsoleCouponsPanel({
  initialCoupons,
  stepUpFresh,
  initialNowMs,
}: ConsoleCouponsPanelProps) {
  const [coupons, setCoupons] = React.useState<readonly ConsolePromoCouponDto[]>(initialCoupons);
  const [nowMs, setNowMs] = React.useState<number>(initialNowMs);

  // Create form state
  const [code, setCode] = React.useState("");
  const [discountKind, setDiscountKind] = React.useState<"percent" | "fixed_idr">("percent");
  const [discountValue, setDiscountValue] = React.useState("20");
  const [planMonthly, setPlanMonthly] = React.useState(true);
  const [planYearly, setPlanYearly] = React.useState(true);
  const [maxRedemptions, setMaxRedemptions] = React.useState("100");
  const [startsAtLocal, setStartsAtLocal] = React.useState(() =>
    toDatetimeLocalValue(initialNowMs - 60_000),
  );
  const [endsAtLocal, setEndsAtLocal] = React.useState(() =>
    toDatetimeLocalValue(initialNowMs + 30 * 24 * 60 * 60 * 1000),
  );
  const [notes, setNotes] = React.useState("");
  const [createReason, setCreateReason] = React.useState("");

  // Toggle/edit audit reason
  const [toggleReason, setToggleReason] = React.useState(
    "Penyesuaian status aktivasi kupon promo berdasarkan keputusan operasional",
  );

  const [creating, setCreating] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [mutatingId, setMutatingId] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [errorBanner, setErrorBanner] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyHref?: string | null;
  } | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  async function reloadCoupons() {
    setRefreshing(true);
    setErrorBanner(null);
    try {
      const res = await fetch("/api/console/coupons", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as ConsoleCouponApiResponse;
      if (!res.ok || !data.success || !Array.isArray(data.coupons)) {
        setErrorBanner({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Gagal memuat daftar kupon promo terbaru.",
          verifyHref: buildSafeConsoleAuthHref(data.verifyPath, "/console/coupons"),
        });
        return;
      }
      setCoupons(data.coupons);
      setNowMs(Date.now());
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat memuat daftar kupon.",
      });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleCreateCoupon(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorBanner(null);
    setSuccessMessage(null);
    setFieldErrors({});

    const localErrors: Record<string, string> = {};
    const trimmedCode = code.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(trimmedCode)) {
      localErrors.code = "Gunakan 2–40 karakter huruf kapital, angka, '-' atau '_' tanpa spasi.";
    }

    const parsedValue = Number(discountValue.trim());
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 1) {
      localErrors.discountValue = "Nilai diskon harus berupa bilangan bulat positif.";
    } else if (discountKind === "percent" && parsedValue > 100) {
      localErrors.discountValue = "Diskon persentase harus antara 1% hingga 100%.";
    }

    const eligiblePlans: ("monthly" | "yearly")[] = [];
    if (planMonthly) eligiblePlans.push("monthly");
    if (planYearly) eligiblePlans.push("yearly");
    if (eligiblePlans.length === 0) {
      localErrors.eligiblePlans = "Pilih minimal satu paket (Bulanan atau Tahunan).";
    }

    let parsedCap: number | null = null;
    if (maxRedemptions.trim().length > 0) {
      const cap = Number(maxRedemptions.trim());
      if (!Number.isSafeInteger(cap) || cap < 1) {
        localErrors.maxRedemptions = "Batas penukaran harus bilangan bulat positif atau kosong.";
      } else {
        parsedCap = cap;
      }
    }

    const parsedStart = Date.parse(startsAtLocal);
    const parsedEnd = Date.parse(endsAtLocal);
    if (!Number.isFinite(parsedStart)) {
      localErrors.startsAt = "Tanggal mulai tidak valid.";
    }
    if (!Number.isFinite(parsedEnd) || parsedEnd <= parsedStart) {
      localErrors.endsAt = "Tanggal berakhir harus lebih besar dari tanggal mulai.";
    }

    const reasonCheck = validateConsoleAuditReason(createReason);
    if (!reasonCheck.ok) {
      localErrors.reason = reasonCheck.error ?? "Alasan audit wajib 10–500 karakter.";
    }

    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }

    setCreating(true);
    try {
      const res = await fetch("/api/console/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          code: trimmedCode,
          discountKind,
          discountValue: parsedValue,
          eligiblePlans,
          maxRedemptions: parsedCap,
          startsAt: parsedStart,
          endsAt: parsedEnd,
          active: true,
          notes: notes.trim() || null,
          reason: reasonCheck.trimmed,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ConsoleCouponApiResponse;
      if (!res.ok || !data.success || !data.coupon) {
        if (Array.isArray(data.fields) && data.fields.length > 0) {
          const mapped: Record<string, string> = {};
          for (const f of data.fields) mapped[f.field] = f.message;
          setFieldErrors(mapped);
        }
        setErrorBanner({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Gagal membuat kupon promo.",
          verifyHref: buildSafeConsoleAuthHref(data.verifyPath, "/console/coupons"),
        });
        return;
      }

      const created = data.coupon;
      setCoupons((prev) => [created, ...prev]);
      setCode("");
      setNotes("");
      setCreateReason("");
      setNowMs(Date.now());
      setSuccessMessage(
        `Kupon ${created.code} (${formatDiscountSummary(created)}) berhasil dibuat dan dicatat ke log audit.`,
      );
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat membuat kupon promo. Isian formulir tetap dipertahankan.",
      });
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(coupon: ConsolePromoCouponDto) {
    setErrorBanner(null);
    setSuccessMessage(null);

    const reasonCheck = validateConsoleAuditReason(toggleReason);
    if (!reasonCheck.ok) {
      setErrorBanner({
        code: "INVALID_AUDIT_REASON",
        message: reasonCheck.error ?? "Alasan audit wajib diisi minimal 10 karakter.",
      });
      return;
    }

    setMutatingId(coupon.id);
    try {
      const nextActive = !coupon.active;
      const res = await fetch(`/api/console/coupons/${encodeURIComponent(coupon.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          expectedVersion: coupon.version,
          active: nextActive,
          reason: reasonCheck.trimmed,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ConsoleCouponApiResponse;
      if (!res.ok || !data.success || !data.coupon) {
        setErrorBanner({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Gagal mengubah status kupon promo.",
          verifyHref: buildSafeConsoleAuthHref(data.verifyPath, "/console/coupons"),
        });
        return;
      }

      const updated = data.coupon;
      setCoupons((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setNowMs(Date.now());
      setSuccessMessage(
        `Status kupon ${updated.code} diubah menjadi ${updated.active ? "Aktif" : "Nonaktif"} (versi ${updated.version}).`,
      );
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat mengubah status kupon.",
      });
    } finally {
      setMutatingId(null);
    }
  }

  return (
    <div className="space-y-6" data-testid="console-coupons-panel">
      {!stepUpFresh && (
        <Alert variant="warning" data-testid="coupons-reauth-warning">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Verifikasi ulang 2FA diperlukan untuk membuat atau mengubah kupon</AlertTitle>
          <AlertDescription>
            Mutasi kupon promo memerlukan verifikasi 2FA dalam 10 menit terakhir.{" "}
            <a
              href="/auth/two-factor?mode=verify&next=%2Fconsole%2Fcoupons"
              className="font-medium underline underline-offset-4"
            >
              Verifikasi ulang 2FA sekarang
            </a>
            .
          </AlertDescription>
        </Alert>
      )}

      {errorBanner && (
        <Alert variant="destructive" role="alert" data-testid="coupons-error-alert">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Operasi kupon gagal ({errorBanner.code})</AlertTitle>
          <AlertDescription>
            <span>{errorBanner.message}</span>
            {errorBanner.verifyHref && (
              <>
                {" "}
                <a
                  href={errorBanner.verifyHref}
                  className="font-medium underline underline-offset-4"
                >
                  Verifikasi ulang 2FA
                </a>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {successMessage && (
        <Alert variant="success" role="status" aria-live="polite" data-testid="coupons-success-alert">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Perubahan kupon tersimpan</AlertTitle>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      {/* Create Promotional Coupon Form */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <TagIcon className="size-4 text-primary" aria-hidden="true" />
            <span>Buat Kupon Promo Baru</span>
          </CardTitle>
          <CardDescription>
            Server memvalidasi potongan diskon terhadap batas minimum pembayaran AutoLaris (Rp
            10.000) dan menegakkan aturan maksimal 1 penukaran per situs.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <form
            onSubmit={handleCreateCoupon}
            noValidate
            className="grid grid-cols-1 gap-4 md:grid-cols-2"
            data-testid="console-coupon-create-form"
          >
            <div className="space-y-1.5">
              <label htmlFor="coupon-code" className="block text-sm font-medium text-foreground">
                Kode Kupon (Unik, Kapital)
              </label>
              <Input
                id="coupon-code"
                name="code"
                type="text"
                placeholder="HEMAT20"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                aria-invalid={fieldErrors.code ? "true" : undefined}
                disabled={creating}
                className="font-mono uppercase"
                data-testid="coupon-code-input"
              />
              {fieldErrors.code && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.code}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="coupon-discount-kind"
                  className="block text-sm font-medium text-foreground"
                >
                  Jenis Diskon
                </label>
                <select
                  id="coupon-discount-kind"
                  name="discountKind"
                  value={discountKind}
                  onChange={(e) =>
                    setDiscountKind(e.target.value === "fixed_idr" ? "fixed_idr" : "percent")
                  }
                  disabled={creating}
                  data-testid="coupon-discount-kind-select"
                  className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                >
                  <option value="percent">Persentase (%)</option>
                  <option value="fixed_idr">Nominal Tetap (IDR)</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="coupon-discount-value"
                  className="block text-sm font-medium text-foreground"
                >
                  {discountKind === "percent" ? "Persen (1–100)" : "Potongan (IDR)"}
                </label>
                <Input
                  id="coupon-discount-value"
                  name="discountValue"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={discountKind === "percent" ? 100 : 999999999999}
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  aria-invalid={fieldErrors.discountValue ? "true" : undefined}
                  disabled={creating}
                  className="tabular-nums"
                  data-testid="coupon-discount-value-input"
                />
                {fieldErrors.discountValue && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {fieldErrors.discountValue}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="block text-sm font-medium text-foreground">Paket yang Berlaku</span>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  type="button"
                  variant={planMonthly ? "default" : "outline"}
                  size="sm"
                  aria-pressed={planMonthly}
                  disabled={creating}
                  onClick={() => setPlanMonthly((v) => !v)}
                  className="min-h-11 md:min-h-9"
                  data-testid="coupon-plan-monthly-toggle"
                >
                  Bulanan
                </Button>
                <Button
                  type="button"
                  variant={planYearly ? "default" : "outline"}
                  size="sm"
                  aria-pressed={planYearly}
                  disabled={creating}
                  onClick={() => setPlanYearly((v) => !v)}
                  className="min-h-11 md:min-h-9"
                  data-testid="coupon-plan-yearly-toggle"
                >
                  Tahunan
                </Button>
              </div>
              {fieldErrors.eligiblePlans && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.eligiblePlans}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="coupon-max-redemptions"
                className="block text-sm font-medium text-foreground"
              >
                Batas Total Penukaran (Kosongkan = Tanpa Batas)
              </label>
              <Input
                id="coupon-max-redemptions"
                name="maxRedemptions"
                type="number"
                inputMode="numeric"
                min={1}
                placeholder="100"
                value={maxRedemptions}
                onChange={(e) => setMaxRedemptions(e.target.value)}
                aria-invalid={fieldErrors.maxRedemptions ? "true" : undefined}
                disabled={creating}
                className="tabular-nums"
                data-testid="coupon-max-redemptions-input"
              />
              {fieldErrors.maxRedemptions && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.maxRedemptions}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="coupon-starts-at" className="block text-sm font-medium text-foreground">
                Mulai Berlaku
              </label>
              <Input
                id="coupon-starts-at"
                name="startsAt"
                type="datetime-local"
                value={startsAtLocal}
                onChange={(e) => setStartsAtLocal(e.target.value)}
                aria-invalid={fieldErrors.startsAt ? "true" : undefined}
                disabled={creating}
                className="tabular-nums"
                data-testid="coupon-starts-at-input"
              />
              {fieldErrors.startsAt && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.startsAt}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="coupon-ends-at" className="block text-sm font-medium text-foreground">
                Berakhir Pada
              </label>
              <Input
                id="coupon-ends-at"
                name="endsAt"
                type="datetime-local"
                value={endsAtLocal}
                onChange={(e) => setEndsAtLocal(e.target.value)}
                aria-invalid={fieldErrors.endsAt ? "true" : undefined}
                disabled={creating}
                className="tabular-nums"
                data-testid="coupon-ends-at-input"
              />
              {fieldErrors.endsAt && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.endsAt}
                </p>
              )}
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <label htmlFor="coupon-notes" className="block text-sm font-medium text-foreground">
                Catatan Internal (Opsional)
              </label>
              <Input
                id="coupon-notes"
                name="notes"
                type="text"
                placeholder="Promo peluncuran kuartal ini untuk paket tahunan"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={creating}
                data-testid="coupon-notes-input"
              />
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <label htmlFor="coupon-reason" className="block text-sm font-medium text-foreground">
                Alasan Audit Operator (Wajib, 10–500 karakter)
              </label>
              <Input
                id="coupon-reason"
                name="reason"
                type="text"
                placeholder="Contoh: Aktivasi kampanye promo diskon tahunan resmi bulan ini"
                value={createReason}
                onChange={(e) => setCreateReason(e.target.value)}
                aria-invalid={fieldErrors.reason ? "true" : undefined}
                disabled={creating}
                data-testid="coupon-reason-input"
              />
              {fieldErrors.reason && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.reason}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 md:col-span-2">
              <Button
                type="submit"
                disabled={creating}
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                data-testid="coupon-create-submit-btn"
              >
                <PlusIcon className="size-4" aria-hidden="true" />
                <span>{creating ? "Menyimpan kupon..." : "Buat Kupon Promo"}</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={refreshing}
                onClick={reloadCoupons}
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                data-testid="coupon-reload-btn"
              >
                <RefreshCwIcon
                  className={`size-4 ${refreshing ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                <span>{refreshing ? "Memuat..." : "Muat Ulang Daftar"}</span>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Active & Historical Coupons Table */}
      <Card data-testid="console-coupons-list-card">
        <CardHeader className="border-b border-border pb-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <CardTitle className="text-base">Daftar Kupon Promo ({coupons.length})</CardTitle>
              <CardDescription>
                Aktifkan atau nonaktifkan kupon secara atomik dengan kontrol versi optimistik.
              </CardDescription>
            </div>
            <div className="w-full space-y-1 md:w-80">
              <label
                htmlFor="coupon-toggle-reason"
                className="block text-xs font-medium text-muted-foreground"
              >
                Alasan Audit untuk Ubah Status (10–500 karakter)
              </label>
              <Input
                id="coupon-toggle-reason"
                type="text"
                value={toggleReason}
                onChange={(e) => setToggleReason(e.target.value)}
                data-testid="coupon-toggle-reason-input"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {coupons.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground" data-testid="console-coupons-empty">
              Belum ada kupon promo terdaftar. Buat kupon pertama melalui formulir di atas.
            </p>
          ) : (
            <>
              {/* Mobile card stack (< md) for zero horizontal overflow at 360px */}
              <div className="space-y-3 md:hidden" data-testid="console-coupons-mobile-list">
                {coupons.map((coupon) => {
                  const statusMeta = getCouponLifecycleBadge(coupon, nowMs);
                  return (
                    <div
                      key={coupon.id}
                      className="space-y-2.5 rounded-lg border border-border bg-card p-4 text-sm"
                      data-testid={`console-coupon-card-${coupon.code}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-mono text-base font-semibold text-foreground">
                            {coupon.code}
                          </p>
                          <p className="text-xs font-medium text-primary tabular-nums">
                            Diskon {formatDiscountSummary(coupon)}
                          </p>
                        </div>
                        <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
                      </div>
                      <dl className="space-y-1 text-xs">
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Paket</dt>
                          <dd className="font-medium text-foreground">
                            {coupon.eligiblePlans
                              .map((p) => (p === "yearly" ? "Tahunan" : "Bulanan"))
                              .join(", ")}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Pemakaian</dt>
                          <dd className="font-medium text-foreground tabular-nums">
                            {coupon.redeemedCount} /{" "}
                            {coupon.maxRedemptions !== null ? coupon.maxRedemptions : "∞"}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Berakhir</dt>
                          <dd className="text-foreground tabular-nums">
                            {formatWibDateTime(coupon.endsAt)}
                          </dd>
                        </div>
                      </dl>
                      <Button
                        type="button"
                        variant={coupon.active ? "outline" : "default"}
                        disabled={mutatingId === coupon.id}
                        onClick={() => handleToggleActive(coupon)}
                        className="min-h-11 w-full"
                        data-testid={`console-coupon-toggle-mobile-${coupon.code}`}
                      >
                        <PowerIcon className="size-4" aria-hidden="true" />
                        <span>
                          {mutatingId === coupon.id
                            ? "Memperbarui..."
                            : coupon.active
                              ? "Nonaktifkan Kupon"
                              : "Aktifkan Kupon"}
                        </span>
                      </Button>
                    </div>
                  );
                })}
              </div>

              {/* Desktop table (>= md) */}
              <div className="hidden md:block">
                <Table data-testid="console-coupons-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Kode</TableHead>
                      <TableHead>Potongan</TableHead>
                      <TableHead>Paket</TableHead>
                      <TableHead className="text-right">Penukaran</TableHead>
                      <TableHead>Masa Berlaku (WIB)</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Aksi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {coupons.map((coupon) => {
                      const statusMeta = getCouponLifecycleBadge(coupon, nowMs);
                      return (
                        <TableRow key={coupon.id} data-testid={`console-coupon-row-${coupon.code}`}>
                          <TableCell className="font-mono font-semibold text-foreground">
                            <div>{coupon.code}</div>
                            <div className="font-sans text-xs font-normal text-muted-foreground">
                              v{coupon.version}
                            </div>
                          </TableCell>
                          <TableCell className="font-medium tabular-nums">
                            {formatDiscountSummary(coupon)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {coupon.eligiblePlans
                              .map((p) => (p === "yearly" ? "Tahunan" : "Bulanan"))
                              .join(", ")}
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {coupon.redeemedCount} /{" "}
                            {coupon.maxRedemptions !== null ? coupon.maxRedemptions : "∞"}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground tabular-nums">
                            <div>{formatWibDateTime(coupon.startsAt)}</div>
                            <div>s.d. {formatWibDateTime(coupon.endsAt)}</div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={statusMeta.variant}
                              data-testid={`console-coupon-status-${coupon.code}`}
                            >
                              {statusMeta.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              size="sm"
                              variant={coupon.active ? "outline" : "default"}
                              disabled={mutatingId === coupon.id}
                              onClick={() => handleToggleActive(coupon)}
                              className="min-h-9"
                              data-testid={`console-coupon-toggle-${coupon.code}`}
                            >
                              <PowerIcon className="size-3.5" aria-hidden="true" />
                              <span>
                                {mutatingId === coupon.id
                                  ? "Menyimpan..."
                                  : coupon.active
                                    ? "Nonaktifkan"
                                    : "Aktifkan"}
                              </span>
                            </Button>
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

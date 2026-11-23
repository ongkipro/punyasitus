import { useEffect, useId, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Clock,
  FileEdit,
  Lock,
  PenLine,
  RefreshCw,
  ShieldAlert,
  Wand2,
  X,
} from "lucide-react";
import {
  AI_WRITING_FACT_CHECK_REMINDER,
  AI_WRITING_OUTPUT_BOUNDS,
  AI_WRITING_QUOTA_LIMIT,
  AI_WRITING_TONES,
  AI_WRITING_VERTICAL_LABELS,
  detectPiiInSelectedFields,
  formatPiiBlockedMessageId,
  type AiWritingFieldKind,
  type AiWritingQuotaStatus,
  type AiWritingSelectableFieldKey,
  type AiWritingSelectedFields,
  type AiWritingTone,
  type AiWritingVertical,
} from "@punyasitus/core/ai-writing/index";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CmsApiError, cmsFetchJson, formatDateTimeId } from "./cms-client-helpers";

/**
 * Human-in-the-loop AI Writing Inspector for CMS content editors
 * (REQ-075, DESIGN.md §10, PLAN §18.4, DEC-028, DEC-046, TASK-074).
 *
 * Guarantees:
 * - Never auto-saves or auto-publishes suggestions. Inserting updates ONLY local
 *   unsaved draft editor state via `onInsertSuggestion`.
 * - Sends ONLY explicitly selected fields; leads, accounts, and unselected fields
 *   are never transmitted.
 * - Preserves editor input across PII blocks, quota exhaustion, lock denials,
 *   and provider errors.
 */

export interface AiWritingSuggestApiPayload {
  readonly suggestion: string;
  readonly fieldKind: AiWritingFieldKind;
  readonly vertical: AiWritingVertical;
  readonly tone: AiWritingTone;
  readonly model: string;
  readonly factCheckReminder: string;
  readonly quota: AiWritingQuotaStatus;
  readonly requestId: string;
}

export interface AiWritingQuotaApiPayload {
  readonly quota: AiWritingQuotaStatus;
  readonly vertical: AiWritingVertical;
  readonly canGenerate: boolean;
  readonly providerLabel: string;
  readonly requestId: string;
}

export interface AiWritingInspectorProps {
  /** Tenant selector (handle or ULID) used for `/api/tenants/:tenantId/ai-writing/*` */
  readonly tenantSelector: string;
  /** Target editorial field currently being assisted */
  readonly fieldKind: AiWritingFieldKind;
  /** Business vertical shown for transparency (authoritative value is always enforced server-side) */
  readonly vertical: AiWritingVertical;
  /** Current unsaved editorial field values available for explicit opt-in selection */
  readonly availableFields: AiWritingSelectedFields;
  /** Whether the tenant subscription is locked / suspended (read-only) */
  readonly isLocked?: boolean;
  /** Whether the current user has `content:write` permission */
  readonly canWriteContent?: boolean;
  /** Initial 30-day quota status if preloaded by SSR */
  readonly initialQuota?: AiWritingQuotaStatus | null;
  /** Start expanded or collapsed behind the inline "Bantu tulis" trigger */
  readonly defaultOpen?: boolean;
  /** Optional custom API base URL override (defaults to `/api/tenants/${tenantSelector}/ai-writing`) */
  readonly apiBaseUrl?: string;
  /** Callback invoked ONLY when the editor explicitly clicks "Sisipkan" (never auto-saves) */
  readonly onInsertSuggestion: (fieldKind: AiWritingFieldKind, text: string) => void;
  /** Optional callback when the editor clicks "Buang" */
  readonly onDiscardSuggestion?: (fieldKind: AiWritingFieldKind) => void;
}

interface InspectorErrorState {
  readonly kind: "pii" | "quota" | "locked" | "rate_limit" | "provider" | "validation";
  readonly code: string;
  readonly title: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly nextResetAt?: string | null;
}

const SELECTABLE_FIELD_LABELS: Readonly<Record<AiWritingSelectableFieldKey, string>> = {
  currentText: "Teks field saat ini",
  title: "Judul referensi",
  summary: "Ringkasan / catatan",
  category: "Kategori",
  keyPoints: "Poin utama",
};

const TONE_LABELS: Readonly<Record<AiWritingTone, string>> = {
  profesional: "Profesional",
  ramah: "Ramah",
  ringkas: "Ringkas",
  persuasif: "Persuasif",
};

function hasFieldContent(
  fields: AiWritingSelectedFields,
  key: AiWritingSelectableFieldKey,
): boolean {
  if (key === "keyPoints") {
    return Array.isArray(fields.keyPoints) && fields.keyPoints.some((p) => p.trim().length > 0);
  }
  const value = fields[key];
  return typeof value === "string" && value.trim().length > 0;
}

function getDefaultSelectedKeys(
  fields: AiWritingSelectedFields,
): readonly AiWritingSelectableFieldKey[] {
  const ordered: readonly AiWritingSelectableFieldKey[] = [
    "currentText",
    "title",
    "summary",
    "category",
    "keyPoints",
  ];
  const populated = ordered.filter((k) => hasFieldContent(fields, k));
  return populated.length > 0 ? populated : ["currentText"];
}

function buildSelectedFieldsPayload(
  selectedKeys: readonly AiWritingSelectableFieldKey[],
  availableFields: AiWritingSelectedFields,
): AiWritingSelectedFields {
  const out: {
    currentText?: string;
    title?: string;
    summary?: string;
    category?: string;
    keyPoints?: readonly string[];
  } = {};

  for (const key of selectedKeys) {
    if (key === "keyPoints") {
      const pts = (availableFields.keyPoints ?? [])
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (pts.length > 0) out.keyPoints = pts;
      continue;
    }
    const raw = availableFields[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      out[key] = raw.trim();
    }
  }
  return out;
}

export function AiWritingInspector({
  tenantSelector,
  fieldKind,
  vertical,
  availableFields,
  isLocked = false,
  canWriteContent = true,
  initialQuota = null,
  defaultOpen = true,
  apiBaseUrl,
  onInsertSuggestion,
  onDiscardSuggestion,
}: AiWritingInspectorProps) {
  const baseEndpoint =
    apiBaseUrl ?? `/api/tenants/${encodeURIComponent(tenantSelector)}/ai-writing`;
  const panelId = useId();
  const toneSelectId = useId();
  const editTextareaId = useId();

  const [open, setOpen] = useState<boolean>(defaultOpen);
  const [selectedKeys, setSelectedKeys] = useState<readonly AiWritingSelectableFieldKey[]>(() =>
    getDefaultSelectedKeys(availableFields),
  );
  const [tone, setTone] = useState<AiWritingTone>("profesional");
  const [quota, setQuota] = useState<AiWritingQuotaStatus>(
    initialQuota ?? {
      used: 0,
      limit: AI_WRITING_QUOTA_LIMIT,
      remaining: AI_WRITING_QUOTA_LIMIT,
      windowDays: 30,
      nextResetAt: null,
    },
  );
  const [quotaLoaded, setQuotaLoaded] = useState<boolean>(initialQuota !== null);
  const [busy, setBusy] = useState<boolean>(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [editableDraft, setEditableDraft] = useState<string>("");
  const [isEditingSuggestion, setIsEditingSuggestion] = useState<boolean>(false);
  const [factCheckReminder, setFactCheckReminder] = useState<string>(
    AI_WRITING_FACT_CHECK_REMINDER,
  );
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<InspectorErrorState | null>(null);

  useEffect(() => {
    if (initialQuota) {
      setQuota(initialQuota);
      setQuotaLoaded(true);
    }
  }, [initialQuota]);

  useEffect(() => {
    if (!open || quotaLoaded) return;
    let cancelled = false;
    void cmsFetchJson<AiWritingQuotaApiPayload>(`${baseEndpoint}/quota`)
      .then((res) => {
        if (!cancelled && res?.quota) {
          setQuota(res.quota);
          setQuotaLoaded(true);
        }
      })
      .catch(() => {
        // Non-blocking initial quota fetch; submit still validates authoritatively server-side.
      });
    return () => {
      cancelled = true;
    };
  }, [open, quotaLoaded, baseEndpoint]);

  const fieldBounds = AI_WRITING_OUTPUT_BOUNDS[fieldKind];
  const verticalLabel = AI_WRITING_VERTICAL_LABELS[vertical];
  const isQuotaExhausted = quota.remaining <= 0 || quota.used >= quota.limit;
  const effectiveDisabled = isLocked || !canWriteContent || busy || isQuotaExhausted;

  const selectableFieldOrder: readonly AiWritingSelectableFieldKey[] = [
    "currentText",
    "title",
    "summary",
    "category",
    "keyPoints",
  ];

  function toggleFieldSelection(key: AiWritingSelectableFieldKey): void {
    setSelectedKeys((prev) => {
      if (prev.includes(key)) {
        return prev.filter((item) => item !== key);
      }
      return [...prev, key];
    });
    setErrorState(null);
  }

  async function handleGenerate(): Promise<void> {
    if (isLocked) {
      setErrorState({
        kind: "locked",
        code: "SUBSCRIPTION_LOCKED",
        title: "Situs sedang terkunci",
        message:
          "Langganan situs ini sedang terkunci atau ditangguhkan. Perpanjang langganan untuk menggunakan bantuan tulis AI.",
        retryable: false,
      });
      return;
    }

    if (!canWriteContent) {
      setErrorState({
        kind: "locked",
        code: "FORBIDDEN",
        title: "Akses menulis diperlukan",
        message: "Peran akun Anda tidak memiliki izin untuk membuat saran konten.",
        retryable: false,
      });
      return;
    }

    const activeSelectedKeys = selectedKeys.filter((k) => hasFieldContent(availableFields, k));
    if (activeSelectedKeys.length === 0) {
      setErrorState({
        kind: "validation",
        code: "VALIDATION_ERROR",
        title: "Pilih minimal satu teks referensi",
        message:
          "Centang dan isi minimal satu field teks di editor sebelum meminta bantuan tulis AI.",
        retryable: false,
      });
      return;
    }

    const minimizedFields = buildSelectedFieldsPayload(activeSelectedKeys, availableFields);

    // Instant client-side pre-send PII check (server also enforces authoritatively before provider call)
    const piiCheck = detectPiiInSelectedFields(minimizedFields);
    if (piiCheck.blocked) {
      setStatusNotice(null);
      setErrorState({
        kind: "pii",
        code: "AI_PII_DETECTED",
        title: "Data pribadi terdeteksi — pengiriman diblokir",
        message: formatPiiBlockedMessageId(piiCheck.detectedKinds),
        retryable: false,
      });
      return;
    }

    setBusy(true);
    setErrorState(null);
    setStatusNotice(null);

    try {
      const response = await cmsFetchJson<AiWritingSuggestApiPayload>(`${baseEndpoint}/suggest`, {
        method: "POST",
        body: JSON.stringify({
          fieldKind,
          selectedFields: activeSelectedKeys,
          fields: minimizedFields,
          tone,
        }),
      });

      setSuggestion(response.suggestion);
      setEditableDraft(response.suggestion);
      setIsEditingSuggestion(false);
      setFactCheckReminder(response.factCheckReminder || AI_WRITING_FACT_CHECK_REMINDER);
      setQuota(response.quota);
      setQuotaLoaded(true);
    } catch (err) {
      if (err instanceof CmsApiError) {
        const extraQuota =
          err.extra?.quota && typeof err.extra.quota === "object"
            ? (err.extra.quota as Partial<AiWritingQuotaStatus>)
            : null;
        if (
          extraQuota &&
          typeof extraQuota.used === "number" &&
          typeof extraQuota.limit === "number" &&
          typeof extraQuota.remaining === "number"
        ) {
          setQuota({
            used: extraQuota.used,
            limit: extraQuota.limit,
            remaining: extraQuota.remaining,
            windowDays: extraQuota.windowDays ?? 30,
            nextResetAt: extraQuota.nextResetAt ?? null,
          });
          setQuotaLoaded(true);
        }

        if (err.code === "AI_PII_DETECTED") {
          setErrorState({
            kind: "pii",
            code: err.code,
            title: "Data pribadi terdeteksi — pengiriman diblokir",
            message: err.message,
            retryable: false,
          });
        } else if (err.code === "AI_QUOTA_EXCEEDED") {
          setErrorState({
            kind: "quota",
            code: err.code,
            title: `Kuota bantuan tulis habis (${quota.limit}/${quota.limit})`,
            message: err.message,
            retryable: false,
            nextResetAt: extraQuota?.nextResetAt ?? quota.nextResetAt,
          });
        } else if (err.code === "AI_RATE_LIMITED") {
          setErrorState({
            kind: "rate_limit",
            code: err.code,
            title: "Permintaan terlalu cepat",
            message: err.message,
            retryable: true,
          });
        } else if (err.isSubscriptionLocked || err.status === 403) {
          setErrorState({
            kind: "locked",
            code: err.code,
            title: "Bantuan tulis tidak tersedia",
            message: err.message,
            retryable: false,
          });
        } else if (
          err.code === "AI_PROVIDER_ERROR" ||
          err.code === "AI_PROVIDER_TIMEOUT" ||
          err.status >= 500
        ) {
          setErrorState({
            kind: "provider",
            code: err.code,
            title: "Layanan AI sementara tidak tersedia",
            message: err.message,
            retryable: true,
          });
        } else {
          setErrorState({
            kind: "validation",
            code: err.code,
            title: "Permintaan tidak dapat diproses",
            message: err.message,
            retryable: false,
          });
        }
      } else {
        setErrorState({
          kind: "provider",
          code: "AI_PROVIDER_ERROR",
          title: "Gagal menghubungi layanan bantuan tulis",
          message:
            "Koneksi ke layanan AI terputus. Teks Anda di editor tetap aman dan kuota tidak terpotong.",
          retryable: true,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  function handleInsert(): void {
    const finalText = (isEditingSuggestion ? editableDraft : suggestion ?? "").trim();
    if (!finalText) return;
    onInsertSuggestion(fieldKind, finalText);
    setSuggestion(null);
    setEditableDraft("");
    setIsEditingSuggestion(false);
    setStatusNotice(
      "Draf disisipkan ke editor lokal. Klik Simpan draf atau Terbitkan jika Anda ingin menyimpan perubahan ke server.",
    );
  }

  function handleDiscard(): void {
    setSuggestion(null);
    setEditableDraft("");
    setIsEditingSuggestion(false);
    setStatusNotice("Saran dibuang. Konten editor Anda tetap tidak berubah.");
    onDiscardSuggestion?.(fieldKind);
  }

  const quotaBadgeVariant =
    isQuotaExhausted ? "destructive" : quota.remaining <= 10 ? "warning" : "secondary";

  return (
    <div className="w-full min-w-0" data-testid="ai-writing-inspector">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant={open ? "secondary" : "outline"}
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((prev) => !prev)}
          className="min-h-11 md:min-h-9"
          data-testid="ai-writing-toggle-btn"
        >
          <Wand2 className="size-4" aria-hidden="true" />
          <span>Bantu tulis</span>
        </Button>

        <Badge
          variant={quotaBadgeVariant}
          className="tabular-nums"
          data-testid="ai-writing-quota-badge"
        >
          {quota.remaining} dari {quota.limit} saran tersisa
        </Badge>
      </div>

      {open && (
        <Card
          id={panelId}
          size="sm"
          className="mt-3 w-full min-w-0"
          data-testid="ai-writing-panel"
        >
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileEdit className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span>Asisten Tulis — {fieldBounds.labelId}</span>
            </CardTitle>
            <CardDescription className="text-xs leading-relaxed">
              Hanya field yang Anda centang dan jenis usaha ({verticalLabel}) yang dikirim ke
              Cloudflare Workers AI. Data pesan masuk/lead dan kontak pribadi tidak pernah dikirim.
            </CardDescription>
            <CardAction>
              <Badge variant="outline" className="tabular-nums">
                {quota.used}/{quota.limit} (30 hari)
              </Badge>
            </CardAction>
          </CardHeader>

          <CardContent className="space-y-4">
            {isLocked && (
              <Alert variant="warning" data-testid="ai-writing-locked-alert">
                <Lock className="size-4" aria-hidden="true" />
                <AlertTitle>Situs dalam mode baca saja</AlertTitle>
                <AlertDescription>
                  Bantuan tulis AI dinonaktifkan saat langganan situs terkunci atau ditangguhkan.
                </AlertDescription>
              </Alert>
            )}

            {isQuotaExhausted && !isLocked && (
              <Alert variant="destructive" data-testid="ai-writing-quota-exhausted-alert">
                <Clock className="size-4" aria-hidden="true" />
                <AlertTitle>
                  Kuota bantuan tulis habis ({quota.limit}/{quota.limit})
                </AlertTitle>
                <AlertDescription>
                  Batas {quota.limit} saran dalam 30 hari terakhir telah tercapai.
                  {quota.nextResetAt
                    ? ` Slot berikutnya tersedia pada ${formatDateTimeId(quota.nextResetAt)}.`
                    : ""}
                </AlertDescription>
              </Alert>
            )}

            <fieldset className="space-y-2 min-w-0">
              <legend className="text-xs font-semibold text-foreground">
                Field yang dikirim ke AI
              </legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {selectableFieldOrder.map((key) => {
                  const populated = hasFieldContent(availableFields, key);
                  const checked = selectedKeys.includes(key) && populated;
                  return (
                    <label
                      key={key}
                      className={`flex min-h-11 md:min-h-9 items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors ${
                        populated
                          ? "cursor-pointer border-border bg-background/60 hover:bg-muted/60"
                          : "cursor-not-allowed border-border/60 bg-muted/40 text-muted-foreground opacity-70"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!populated || busy || isLocked}
                        onChange={() => toggleFieldSelection(key)}
                        className="size-4 shrink-0 accent-primary"
                        data-testid={`ai-field-checkbox-${key}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {SELECTABLE_FIELD_LABELS[key]}
                      </span>
                      {!populated && (
                        <span className="shrink-0 text-[11px] text-muted-foreground">Kosong</span>
                      )}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0 flex-1 space-y-1.5">
                <label htmlFor={toneSelectId} className="block text-xs font-semibold text-foreground">
                  Gaya bahasa
                </label>
                <select
                  id={toneSelectId}
                  value={tone}
                  disabled={busy || isLocked}
                  onChange={(e) => setTone(e.target.value as AiWritingTone)}
                  className="h-11 md:h-9 w-full rounded-md border border-input bg-card px-3 text-base md:text-sm text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
                  data-testid="ai-writing-tone-select"
                >
                  {AI_WRITING_TONES.map((toneKey) => (
                    <option key={toneKey} value={toneKey}>
                      {TONE_LABELS[toneKey]}
                    </option>
                  ))}
                </select>
              </div>

              <Button
                type="button"
                disabled={effectiveDisabled}
                onClick={() => void handleGenerate()}
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                data-testid="ai-writing-generate-btn"
              >
                {busy ? (
                  <>
                    <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
                    <span>Menyusun draf...</span>
                  </>
                ) : (
                  <>
                    <Wand2 className="size-4" aria-hidden="true" />
                    <span>Buat saran draf</span>
                  </>
                )}
              </Button>
            </div>

            {errorState && (
              <Alert
                variant={
                  errorState.kind === "pii" || errorState.kind === "locked"
                    ? "warning"
                    : "destructive"
                }
                data-testid={`ai-writing-error-${errorState.kind}`}
              >
                {errorState.kind === "pii" ? (
                  <ShieldAlert className="size-4" aria-hidden="true" />
                ) : errorState.kind === "locked" ? (
                  <Lock className="size-4" aria-hidden="true" />
                ) : (
                  <AlertCircle className="size-4" aria-hidden="true" />
                )}
                <AlertTitle>{errorState.title}</AlertTitle>
                <AlertDescription>{errorState.message}</AlertDescription>
                {errorState.retryable && !effectiveDisabled && (
                  <AlertAction>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void handleGenerate()}
                      className="min-h-11 md:min-h-9"
                      data-testid="ai-writing-retry-btn"
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                      <span>Coba lagi</span>
                    </Button>
                  </AlertAction>
                )}
              </Alert>
            )}

            {statusNotice && !suggestion && (
              <Alert variant="info" data-testid="ai-writing-status-notice">
                <Check className="size-4" aria-hidden="true" />
                <AlertDescription>{statusNotice}</AlertDescription>
              </Alert>
            )}

            {suggestion !== null && (
              <div
                className="space-y-3 rounded-lg border border-border bg-muted/40 p-3"
                data-testid="ai-writing-suggestion-box"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-foreground">
                    Pratinjau saran draf (belum disimpan)
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {(isEditingSuggestion ? editableDraft : suggestion).length} /{" "}
                    {fieldBounds.maxChars} karakter
                  </span>
                </div>

                {isEditingSuggestion ? (
                  <div className="space-y-1.5">
                    <label htmlFor={editTextareaId} className="sr-only">
                      Ubah teks saran sebelum disisipkan
                    </label>
                    <textarea
                      id={editTextareaId}
                      rows={fieldKind === "offering_description" ? 5 : 3}
                      maxLength={fieldBounds.maxChars}
                      value={editableDraft}
                      onChange={(e) => setEditableDraft(e.target.value)}
                      className="w-full rounded-md border border-input bg-card p-2.5 text-base md:text-sm leading-relaxed text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      data-testid="ai-writing-edit-textarea"
                    />
                  </div>
                ) : (
                  <p
                    className="whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 text-sm leading-relaxed text-foreground"
                    data-testid="ai-writing-suggestion-preview"
                  >
                    {suggestion}
                  </p>
                )}

                <Alert variant="warning" data-testid="ai-writing-fact-check-reminder">
                  <AlertTriangle className="size-4" aria-hidden="true" />
                  <AlertDescription className="text-xs">{factCheckReminder}</AlertDescription>
                </Alert>

                <Separator />

                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleInsert}
                    disabled={(isEditingSuggestion ? editableDraft : suggestion).trim().length === 0}
                    className="min-h-11 w-full sm:w-auto md:min-h-9"
                    data-testid="ai-writing-insert-btn"
                  >
                    <Check className="size-4" aria-hidden="true" />
                    <span>{isEditingSuggestion ? "Sisipkan hasil edit" : "Sisipkan"}</span>
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (!isEditingSuggestion) {
                        setEditableDraft(suggestion);
                      }
                      setIsEditingSuggestion((prev) => !prev);
                    }}
                    className="min-h-11 w-full sm:w-auto md:min-h-9"
                    data-testid="ai-writing-edit-btn"
                  >
                    <PenLine className="size-4" aria-hidden="true" />
                    <span>{isEditingSuggestion ? "Selesai ubah" : "Ubah"}</span>
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={handleDiscard}
                    className="min-h-11 w-full sm:w-auto md:min-h-9"
                    data-testid="ai-writing-discard-btn"
                  >
                    <X className="size-4" aria-hidden="true" />
                    <span>Buang</span>
                  </Button>
                </div>
              </div>
            )}
          </CardContent>

          <CardFooter className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Penyedia: Cloudflare Workers AI</span>
            <span className="tabular-nums">
              {quota.nextResetAt
                ? `Reset berikutnya: ${formatDateTimeId(quota.nextResetAt)}`
                : "Kuota bergulir 30 hari"}
            </span>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}

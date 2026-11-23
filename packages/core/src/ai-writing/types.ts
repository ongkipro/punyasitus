/**
 * Shared types, bounds, and port contracts for AI Writing Suggestions in the Editor
 * (REQ-075, PLAN §18.4, DEC-026, DEC-028, DEC-046, TASK-074).
 */

export const AI_WRITING_FIELD_KINDS = [
  "title",
  "excerpt",
  "offering_description",
  "meta_description",
] as const;

export type AiWritingFieldKind = (typeof AI_WRITING_FIELD_KINDS)[number];

export const AI_WRITING_VERTICALS = [
  "compro",
  "sales",
  "travel",
  "catalog",
  "resto",
  "dealer",
] as const;

export type AiWritingVertical = (typeof AI_WRITING_VERTICALS)[number];

export const AI_WRITING_TONES = [
  "profesional",
  "ramah",
  "ringkas",
  "persuasif",
] as const;

export type AiWritingTone = (typeof AI_WRITING_TONES)[number];

export const AI_WRITING_SELECTABLE_FIELD_KEYS = [
  "currentText",
  "title",
  "summary",
  "category",
  "keyPoints",
] as const;

export type AiWritingSelectableFieldKey = (typeof AI_WRITING_SELECTABLE_FIELD_KEYS)[number];

export const AI_WRITING_PII_KINDS = ["email", "phone", "nik"] as const;

export type AiWritingPiiKind = (typeof AI_WRITING_PII_KINDS)[number];

/**
 * DEC-028: 100 successful suggestions per website per trailing 30-day window (720 hours),
 * shared across all members of the tenant (trial and paid share the same cap).
 */
export const AI_WRITING_QUOTA_LIMIT = 100 as const;
export const AI_WRITING_QUOTA_WINDOW_DAYS = 30 as const;
export const AI_WRITING_QUOTA_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Per-user and per-tenant burst limits (1-minute rolling/fixed bucket) to prevent rapid spam.
 */
export const AI_WRITING_BURST_WINDOW_MS = 60_000 as const;
export const AI_WRITING_BURST_PER_USER_MINUTE = 6 as const;
export const AI_WRITING_BURST_PER_TENANT_MINUTE = 15 as const;

/**
 * Maximum request body size and combined character ceiling for selected editorial inputs.
 */
export const AI_WRITING_MAX_BODY_BYTES = 16_384 as const;
export const AI_WRITING_MAX_TOTAL_INPUT_CHARS = 4_000 as const;

/**
 * DEC-046: Cloudflare Workers AI default model & AI Gateway identifier.
 */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast" as const;
export const DEFAULT_WORKERS_AI_GATEWAY_ID = "punyasitus-ai-writing" as const;
export const DEFAULT_WORKERS_AI_TIMEOUT_MS = 15_000 as const;

export const AI_WRITING_FACT_CHECK_REMINDER =
  "Periksa kembali fakta, harga, dan izin usaha sebelum menyimpan atau menerbitkan. Saran AI tidak pernah disimpan atau diterbitkan secara otomatis." as const;

export const AI_WRITING_OUTPUT_BOUNDS: Readonly<
  Record<
    AiWritingFieldKind,
    {
      readonly labelId: string;
      readonly maxChars: number;
      readonly maxTokens: number;
      readonly singleLine: boolean;
    }
  >
> = {
  title: {
    labelId: "Judul",
    maxChars: 120,
    maxTokens: 96,
    singleLine: true,
  },
  excerpt: {
    labelId: "Ringkasan",
    maxChars: 300,
    maxTokens: 180,
    singleLine: false,
  },
  offering_description: {
    labelId: "Deskripsi produk / layanan",
    maxChars: 1_500,
    maxTokens: 480,
    singleLine: false,
  },
  meta_description: {
    labelId: "Deskripsi meta SEO",
    maxChars: 160,
    maxTokens: 110,
    singleLine: true,
  },
};

export const AI_WRITING_VERTICAL_LABELS: Readonly<Record<AiWritingVertical, string>> = {
  compro: "Profil Perusahaan / B2B",
  sales: "Jasa Profesional & Konsultasi",
  travel: "Travel & Biro Perjalanan",
  catalog: "Katalog Produk",
  resto: "Kuliner & Gerai Offline",
  dealer: "Showroom Kendaraan",
};

export interface AiWritingSelectedFields {
  readonly currentText?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly category?: string;
  readonly keyPoints?: readonly string[];
}

export interface AiWritingSuggestRequestInput {
  readonly fieldKind: AiWritingFieldKind;
  readonly selectedFields: readonly AiWritingSelectableFieldKey[];
  readonly fields: AiWritingSelectedFields;
  readonly tone?: AiWritingTone;
}

/**
 * Strictly minimized editorial context passed to the AI provider.
 * Never carries tenant IDs, user emails, leads, cookies, or unselected fields.
 */
export interface AiWritingMinimizedInput {
  readonly fieldKind: AiWritingFieldKind;
  readonly vertical: AiWritingVertical;
  readonly tone: AiWritingTone;
  readonly selectedFieldKeys: readonly AiWritingSelectableFieldKey[];
  readonly selectedFields: AiWritingSelectedFields;
}

export interface AiWritingProviderRequest {
  readonly fieldKind: AiWritingFieldKind;
  readonly vertical: AiWritingVertical;
  readonly tone: AiWritingTone;
  readonly selectedFieldKeys: readonly AiWritingSelectableFieldKey[];
  readonly selectedFields: AiWritingSelectedFields;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxOutputChars: number;
  readonly maxTokens: number;
  readonly gatewayId: string;
}

export interface AiWritingProviderResult {
  readonly suggestion: string;
  readonly model: string;
  readonly tokenCount: number | null;
  readonly latencyMs: number;
  readonly gatewayCached?: boolean;
}

export interface AiWritingProviderPort {
  generateSuggestion(
    request: AiWritingProviderRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AiWritingProviderResult>;
}

/**
 * Alias matching DEC-046 & PLAN §18.4 naming (`AiWritingPort`).
 */
export type AiWritingPort = AiWritingProviderPort;

export interface AiWritingPiiFinding {
  readonly field: AiWritingSelectableFieldKey;
  readonly kind: AiWritingPiiKind;
  readonly count: number;
}

export interface AiWritingPiiCheckResult {
  readonly blocked: boolean;
  readonly findings: readonly AiWritingPiiFinding[];
  readonly detectedKinds: readonly AiWritingPiiKind[];
}

export interface AiWritingQuotaStatus {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly windowDays: number;
  readonly nextResetAt: string | null;
}

export type AiWritingErrorCode =
  | "AI_PII_DETECTED"
  | "AI_QUOTA_EXCEEDED"
  | "AI_RATE_LIMITED"
  | "AI_PROVIDER_ERROR"
  | "AI_PROVIDER_TIMEOUT"
  | "SUBSCRIPTION_LOCKED"
  | "VALIDATION_ERROR"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "UNAUTHENTICATED"
  | "SERVICE_UNAVAILABLE";

export class AiWritingProviderError extends Error {
  readonly code: "AI_PROVIDER_ERROR" | "AI_PROVIDER_TIMEOUT";
  readonly status: 502 | 503 | 504;
  readonly retryable: boolean;

  constructor(
    code: "AI_PROVIDER_ERROR" | "AI_PROVIDER_TIMEOUT",
    message: string,
    status: 502 | 503 | 504 = code === "AI_PROVIDER_TIMEOUT" ? 504 : 502,
    retryable = true,
  ) {
    super(message);
    this.name = "AiWritingProviderError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

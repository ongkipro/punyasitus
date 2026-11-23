import type {
  AiWritingFieldKind,
  AiWritingPiiKind,
  AiWritingSelectableFieldKey,
  AiWritingTone,
  AiWritingVertical,
} from "./types.ts";

/**
 * Metadata-only audit & telemetry payload builder for AI Writing Suggestions
 * (REQ-075, REQ-039, PLAN §18.4, TASK-074).
 *
 * Privacy invariant:
 * Strictly allowlists operational metadata only (fieldKind, vertical, selected field key names,
 * status/outcome, errorCode, model, tokenCount, latencyMs, quota counts, PII category names).
 * NEVER accepts or emits prompt text, selected input text, suggestion text, or raw PII values.
 */

export interface AiWritingAuditMetadataInput {
  readonly fieldKind?: AiWritingFieldKind | null;
  readonly vertical?: AiWritingVertical | null;
  readonly tone?: AiWritingTone | null;
  readonly selectedFieldKeys?: readonly AiWritingSelectableFieldKey[];
  readonly status: "succeeded" | "blocked_pii" | "quota_exceeded" | "rate_limited" | "provider_error" | "denied";
  readonly errorCode?: string | null;
  readonly model?: string | null;
  readonly tokenCount?: number | null;
  readonly latencyMs?: number | null;
  readonly quotaUsed?: number | null;
  readonly quotaLimit?: number | null;
  readonly quotaRemaining?: number | null;
  readonly piiKindsDetected?: readonly AiWritingPiiKind[];
  /**
   * Extra properties are typed as unknown strictly so callers cannot sneak prompt/suggestion text
   * past the allowlist — they are unconditionally discarded.
   */
  readonly [extra: string]: unknown;
}

export interface AiWritingSafeAuditMetadata {
  readonly fieldKind: AiWritingFieldKind | null;
  readonly vertical: AiWritingVertical | null;
  readonly tone: AiWritingTone | null;
  readonly selectedFieldKeys: readonly AiWritingSelectableFieldKey[];
  readonly status: AiWritingAuditMetadataInput["status"];
  readonly errorCode: string | null;
  readonly model: string | null;
  readonly tokenCount: number | null;
  readonly latencyMs: number | null;
  readonly quotaUsed: number | null;
  readonly quotaLimit: number | null;
  readonly quotaRemaining: number | null;
  readonly piiKindsDetected: readonly AiWritingPiiKind[];
}

const SAFE_ERROR_CODE_RE = /^[A-Z0-9_]{1,48}$/;
const SAFE_MODEL_ID_RE = /^@?[A-Za-z0-9._/-]{1,96}$/;

function sanitizeCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toUpperCase();
  return SAFE_ERROR_CODE_RE.test(trimmed) ? trimmed : "UNKNOWN_ERROR";
}

function sanitizeModel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return SAFE_MODEL_ID_RE.test(trimmed) ? trimmed : null;
}

function sanitizeNonNegInt(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.round(raw);
}

export function buildAiWritingAuditMetadata(
  input: AiWritingAuditMetadataInput,
): AiWritingSafeAuditMetadata {
  return {
    fieldKind: input.fieldKind ?? null,
    vertical: input.vertical ?? null,
    tone: input.tone ?? null,
    selectedFieldKeys: input.selectedFieldKeys ? [...input.selectedFieldKeys] : [],
    status: input.status,
    errorCode: sanitizeCode(input.errorCode),
    model: sanitizeModel(input.model),
    tokenCount: sanitizeNonNegInt(input.tokenCount),
    latencyMs: sanitizeNonNegInt(input.latencyMs),
    quotaUsed: sanitizeNonNegInt(input.quotaUsed),
    quotaLimit: sanitizeNonNegInt(input.quotaLimit),
    quotaRemaining: sanitizeNonNegInt(input.quotaRemaining),
    piiKindsDetected: input.piiKindsDetected ? [...input.piiKindsDetected] : [],
  };
}

export function buildAiWritingTelemetryMetrics(
  metadata: AiWritingSafeAuditMetadata,
): Readonly<Record<string, number | boolean | string | null>> {
  return {
    fieldKind: metadata.fieldKind,
    vertical: metadata.vertical,
    status: metadata.status,
    selectedFieldCount: metadata.selectedFieldKeys.length,
    model: metadata.model,
    tokenCount: metadata.tokenCount,
    latencyMs: metadata.latencyMs,
    quotaUsed: metadata.quotaUsed,
    quotaRemaining: metadata.quotaRemaining,
    piiBlocked: metadata.piiKindsDetected.length > 0,
  };
}

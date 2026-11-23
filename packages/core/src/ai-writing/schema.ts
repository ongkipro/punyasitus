import { z } from "zod";
import {
  AI_WRITING_FIELD_KINDS,
  AI_WRITING_MAX_TOTAL_INPUT_CHARS,
  AI_WRITING_OUTPUT_BOUNDS,
  AI_WRITING_SELECTABLE_FIELD_KEYS,
  AI_WRITING_TONES,
  AI_WRITING_VERTICALS,
  type AiWritingFieldKind,
  type AiWritingMinimizedInput,
  type AiWritingSelectableFieldKey,
  type AiWritingSelectedFields,
  type AiWritingSuggestRequestInput,
  type AiWritingVertical,
} from "./types.ts";

/**
 * Strict Zod v4 validation, field minimization, and output sanitization for
 * AI Writing Suggestions (REQ-075, PLAN §18.4, TASK-074).
 */

export const FORBIDDEN_AI_WRITING_KEYS: ReadonlySet<string> = new Set([
  "tenantId",
  "tenant_id",
  "organizationId",
  "organization_id",
  "handle",
  "userId",
  "user_id",
  "ownerId",
  "owner_id",
  "actorId",
  "actor_id",
  "role",
  "roles",
  "leads",
  "lead",
  "leadId",
  "lead_id",
  "visitor",
  "visitors",
  "customer",
  "customers",
  "email",
  "emails",
  "phone",
  "phones",
  "whatsapp",
  "address",
  "nik",
  "ktp",
  "account",
  "accounts",
  "users",
  "members",
  "billing",
  "prompt",
  "systemPrompt",
  "rawPrompt",
  "model",
  "apiKey",
  "api_key",
  "isSuperadmin",
  "platformOperator",
]);

export const aiWritingFieldKindSchema = z.enum(AI_WRITING_FIELD_KINDS);
export const aiWritingVerticalSchema = z.enum(AI_WRITING_VERTICALS);
export const aiWritingToneSchema = z.enum(AI_WRITING_TONES);
export const aiWritingSelectableFieldKeySchema = z.enum(AI_WRITING_SELECTABLE_FIELD_KEYS);

export const aiWritingSelectedFieldsSchema = z
  .object({
    currentText: z.string().max(2_000).optional(),
    title: z.string().max(200).optional(),
    summary: z.string().max(1_200).optional(),
    category: z.string().max(100).optional(),
    keyPoints: z.array(z.string().max(200)).max(6).optional(),
  })
  .strict();

export const aiWritingSuggestRequestSchema = z
  .object({
    fieldKind: aiWritingFieldKindSchema,
    selectedFields: z
      .array(aiWritingSelectableFieldKeySchema)
      .min(1, "Pilih minimal satu field teks untuk dikirim ke asisten tulis.")
      .max(AI_WRITING_SELECTABLE_FIELD_KEYS.length),
    fields: aiWritingSelectedFieldsSchema,
    tone: aiWritingToneSchema.optional().default("profesional"),
  })
  .strict()
  .superRefine((data, ctx) => {
    const selectedSet = new Set(data.selectedFields);
    // Reject any field key supplied in `fields` that was NOT explicitly selected!
    for (const key of AI_WRITING_SELECTABLE_FIELD_KEYS) {
      const val = data.fields[key];
      const hasValue =
        key === "keyPoints"
          ? Array.isArray(val) && val.some((item) => item.trim().length > 0)
          : typeof val === "string" && val.trim().length > 0;
      if (hasValue && !selectedSet.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", key],
          message: `Field "${key}" tidak termasuk dalam selectedFields dan tidak boleh dikirim.`,
        });
      }
    }

    // Ensure at least one selected field has non-empty normalized text (after stripping control chars)
    let totalChars = 0;
    for (const key of selectedSet) {
      if (key === "keyPoints") {
        const pts = data.fields.keyPoints ?? [];
        for (const p of pts) {
          totalChars += normalizePlainText(p).length;
        }
      } else {
        const str = data.fields[key];
        if (typeof str === "string") {
          totalChars += normalizePlainText(str).length;
        }
      }
    }

    if (totalChars === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["fields"],
        message: "Isi minimal satu field yang dipilih sebelum meminta saran tulis.",
      });
    } else if (totalChars > AI_WRITING_MAX_TOTAL_INPUT_CHARS) {
      ctx.addIssue({
        code: "custom",
        path: ["fields"],
        message: `Total teks terpilih melebihi batas ${AI_WRITING_MAX_TOTAL_INPUT_CHARS} karakter.`,
      });
    }
  });

export const aiWritingQuotaStatusSchema = z
  .object({
    used: z.number().int().min(0),
    limit: z.number().int().min(1),
    remaining: z.number().int().min(0),
    windowDays: z.number().int().min(1),
    nextResetAt: z.string().datetime().nullable(),
  })
  .strict();

export const aiWritingSuggestionResponseSchema = z
  .object({
    suggestion: z.string().min(1),
    fieldKind: aiWritingFieldKindSchema,
    vertical: aiWritingVerticalSchema,
    tone: aiWritingToneSchema,
    model: z.string().min(1),
    factCheckReminder: z.string().min(1),
    quota: aiWritingQuotaStatusSchema,
    requestId: z.string().min(1),
  })
  .strict();

function stripControlChars(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code === 10 || code === 9 || (code >= 32 && code !== 127)) {
      out += raw[i] ?? "";
    }
  }
  return out;
}

function normalizePlainText(raw: string): string {
  // Collapse control characters except newlines/tabs, normalize CRLF -> LF, trim.
  return stripControlChars(raw.replace(/\r\n?/g, "\n")).trim();
}

/**
 * Strictly minimizes the validated request so ONLY explicitly selected fields
 * and the authoritative tenant business vertical ever leave the server boundary.
 * Any unselected key is guaranteed absent from the returned object.
 */
export function minimizeAiWritingFields(
  input: AiWritingSuggestRequestInput,
  authoritativeVertical: AiWritingVertical,
): AiWritingMinimizedInput {
  const uniqueKeys: AiWritingSelectableFieldKey[] = [];
  const seen = new Set<AiWritingSelectableFieldKey>();
  for (const key of input.selectedFields) {
    if (!seen.has(key)) {
      seen.add(key);
      uniqueKeys.push(key);
    }
  }

  const minimized: {
    currentText?: string;
    title?: string;
    summary?: string;
    category?: string;
    keyPoints?: readonly string[];
  } = {};

  const activeKeys: AiWritingSelectableFieldKey[] = [];

  for (const key of uniqueKeys) {
    if (key === "keyPoints") {
      const pts = (input.fields.keyPoints ?? [])
        .map((p) => normalizePlainText(p))
        .filter((p) => p.length > 0)
        .slice(0, 6);
      if (pts.length > 0) {
        minimized.keyPoints = pts;
        activeKeys.push("keyPoints");
      }
      continue;
    }

    const raw = input.fields[key];
    if (typeof raw === "string") {
      const clean = normalizePlainText(raw);
      if (clean.length > 0) {
        minimized[key] = clean;
        activeKeys.push(key);
      }
    }
  }

  return {
    fieldKind: input.fieldKind,
    vertical: authoritativeVertical,
    tone: input.tone ?? "profesional",
    selectedFieldKeys: activeKeys,
    selectedFields: minimized as AiWritingSelectedFields,
  };
}

/**
 * Strips any HTML tags, markdown code fences, or surrounding quotes from model output
 * and enforces the field-kind character limit and plain-text paragraph rules (PLAN §18.4).
 */
export function sanitizeAiOutputText(rawOutput: string, fieldKind: AiWritingFieldKind): string {
  const bounds = AI_WRITING_OUTPUT_BOUNDS[fieldKind];
  let cleaned = stripControlChars(rawOutput.replace(/\r\n?/g, "\n"))
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/<[^>]{1,200}>/g, " ")
    .trim();

  // Strip wrapping straight or smart quotes if the model quoted the entire suggestion
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("“") && cleaned.endsWith("”"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  if (bounds.singleLine) {
    cleaned = cleaned.replace(/\s+/g, " ").trim();
  } else {
    cleaned = cleaned
      .split(/\n{2,}/)
      .map((para) => para.replace(/[ \t\n]+/g, " ").trim())
      .filter((para) => para.length > 0)
      .join("\n\n");
  }

  if (cleaned.length > bounds.maxChars) {
    const sliced = cleaned.slice(0, bounds.maxChars);
    const lastSpace = sliced.lastIndexOf(" ");
    cleaned =
      lastSpace > Math.floor(bounds.maxChars * 0.7)
        ? sliced.slice(0, lastSpace).trim()
        : sliced.trim();
  }

  return cleaned;
}

/**
 * Scans a parsed JSON object recursively (bounded depth) for any forbidden
 * selector/lead/account keys before schema parsing.
 */
export function findForbiddenAiWritingKey(
  obj: Record<string, unknown>,
  depth = 0,
): string | null {
  if (depth > 3) return null;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_AI_WRITING_KEYS.has(key)) {
      return key;
    }
    const val = obj[key];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = findForbiddenAiWritingKey(val as Record<string, unknown>, depth + 1);
      if (nested) return `${key}.${nested}`;
    }
  }
  return null;
}

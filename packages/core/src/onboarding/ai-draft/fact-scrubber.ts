import { scanTextForPii } from "../../ai-writing/index.ts";
import {
  ONBOARDING_AI_DRAFT_MAX_SERVICE_SUMMARIES,
  ONBOARDING_AI_DRAFT_PREFIX,
  type OnboardingAiDraftParseResult,
  type OnboardingDraftServiceSummary,
} from "./types.ts";

/**
 * Deterministic fact scrubber, structural allowlist parser, and `CONTOH` draft enforcer
 * for Onboarding AI Drafts (`packages/core/src/onboarding/ai-draft/fact-scrubber.ts`;
 * REQ-109, PLAN §20.5, TASK-109).
 *
 * Hard invariants:
 * - Strictly allowlists ONLY narrative text keys (`heroEyebrow`, `heroHeadline`,
 *   `heroSubheadline`, `heroCtaLabel`, `aboutHeading`, `aboutSummary`, `serviceSummaries`).
 * - Deterministically drops any factual JSON keys (`price`, `licence`, `reviews`,
 *   `phone`, `whatsapp`, `address`, etc.) even if a mocked or real LLM emits them.
 * - Deterministically strips hallucinated prices/currency, licence/permit numbers,
 *   reviews/ratings/testimonials, phone/WhatsApp/email/NIK (via TASK-074 linear O(n)
 *   `scanTextForPii`), and street addresses from inside narrative text fields.
 * - Guarantees EVERY generated text field carries the explicit `CONTOH — ` draft marker
 *   so `detectSampleClaimsInSection` always recognizes it as an unpublished sample draft.
 */

const ALLOWED_DRAFT_KEYS: ReadonlySet<string> = new Set([
  "heroEyebrow",
  "heroHeadline",
  "heroSubheadline",
  "heroCtaLabel",
  "aboutHeading",
  "aboutSummary",
  "serviceSummaries",
]);

const FIELD_LIMITS = {
  heroEyebrow: 70,
  heroHeadline: 120,
  heroSubheadline: 240,
  heroCtaLabel: 56,
  aboutHeading: 100,
  aboutSummary: 420,
  serviceTitle: 80,
  serviceDescription: 180,
} as const;

/**
 * Bounded, non-backtracking regex patterns targeting fabricated factual claims
 * (prices, licence/permit IDs, ratings/reviews, street addresses, URLs/handles).
 * Email, phone/WA, and NIK are additionally verified via TASK-074's O(n) `scanTextForPii`.
 */
const MAX_STRIPPED_FACT_KEYS = 10 as const;
const MAX_STRIPPED_FACT_KEY_CHARS = 40 as const;

const FACT_SCRUB_RULES: readonly {
  readonly category: "price" | "licence" | "review" | "phone" | "address";
  readonly re: RegExp;
}[] = [
  // 1. Prices & currency amounts (IDR / Rp / USD / $ / Indonesian price shorthand)
  {
    category: "price",
    re: /\b(?:rp\.?|idr|usd)\s?\d[\d.,]*(?:\s?(?:rb|ribu|jt|juta|miliar|k))?(?:\s*[-–]\s*(?:rp\.?\s?)?\d[\d.,]*(?:\s?(?:rb|ribu|jt|juta|k))?)?\b/gi,
  },
  {
    category: "price",
    re: /\$\s?\d[\d.,]*(?:\s?(?:k|m))?\b/gi,
  },
  {
    category: "price",
    re: /\b(?:harga|tarif|biaya|dp|angsuran|otr|mulai|hanya|cuma|sekitar)\s+(?:mulai\s+|hanya\s+|cuma\s+|sekitar\s+|rp\.?\s*)?\d[\d.,]{0,12}(?:\s?(?:%|rb|ribu|jt|juta|miliar|milyar|k))?\b/gi,
  },
  {
    category: "price",
    re: /\b\d[\d.,]{0,12}\s?(?:rb|ribu|jt|juta|miliar|milyar)\b/gi,
  },
  {
    category: "price",
    re: /\b(?:diskon|potongan|promo|hemat|cashback)\s+\d{1,3}\s?%/gi,
  },
  // 2. Indonesian & international licences, permits, certifications with IDs/numbers
  {
    category: "licence",
    re: /\b(?:sk\s+kemenag(?:\s+(?:ppiu|pihk))?|ppiu|pihk|nib|siup|tdp|npwp|sip|str|bpom|p-?irt|halal\s*(?:bpjph|mui|id)?|sbujk|kbli|iso|sni|tkdn|asita|iata|ikpi|peradi)\s*(?:no\.?|nomor|:|#)?\s*[a-z0-9./-]*\d[a-z0-9./-]{1,30}\b/gi,
  },
  // 3. Reviews, star ratings (Unicode ★/☆/⭐ without \b), testimonials & customer-count claims
  {
    category: "review",
    re: /[★☆⭐]{1,5}\s*(?:\d(?:[.,]\d)?(?:\s*\/\s*5)?)?/g,
  },
  {
    category: "review",
    re: /\b(?:rating|nilai|ulasan|review|testimoni)\s*(?::|-)?\s*\d(?:[.,]\d)?\s*(?:\/\s*5|bintang)?\b/gi,
  },
  {
    category: "review",
    re: /\b\d(?:[.,]\d)?\s*\/\s*5\b/gi,
  },
  {
    category: "review",
    re: /\b(?:bintang\s*[1-5]|[1-5]\s*bintang)\b/gi,
  },
  {
    category: "review",
    re: /\b\d[\d.,]{0,12}\+?\s*(?:ulasan|review|testimoni|pelanggan|klien|pasien|pembeli|jamaah|peserta)\b/gi,
  },
  // 4. Explicit WhatsApp / contact links & phone spans (supplemented by TASK-074 `scanTextForPii`)
  {
    category: "phone",
    re: /(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com)\/[^\s,;)]+/gi,
  },
  {
    category: "phone",
    re: /(?:\+62|62|0)\s*8\d{1,3}[\s.-]?\d{3,4}[\s.-]?\d{3,5}\b/g,
  },
  {
    category: "phone",
    re: /\(0\d{2,3}\)\s*\d{3,4}[\s.-]?\d{3,5}/g,
  },
  {
    category: "phone",
    re: /\b[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,120}\.[a-z]{2,12}\b/gi,
  },
  // 5. Street addresses, RT/RW, house/ruko numbers, postal codes
  {
    category: "address",
    re: /\b(?:jl\.?|jalan|gg\.?|gang|komplek|kompleks|ruko|kav\.?|kavling)\s+[a-z0-9\s.'-]{2,60}?(?:no\.?\s*\d+[a-z0-9/-]*|blok\s+[a-z0-9-]+(?:\s*no\.?\s*\d+)?)/gi,
  },
  {
    category: "address",
    re: /\b(?:jl\.?|jalan|gg\.?|gang)\s+[a-z0-9][a-z0-9.'-]{1,30}(?:\s+[a-z0-9][a-z0-9.'-]{1,30}){0,5}/gi,
  },
  {
    category: "address",
    re: /\brt\.?\s*\d{1,3}\s*\/\s*rw\.?\s*\d{1,3}\b/gi,
  },
  {
    category: "address",
    re: /\bkode\s+pos\s*:?\s*\d{5}\b/gi,
  },
];

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

function stripTagsAndMarkdown(raw: string): string {
  return stripControlChars(raw.normalize("NFKC").replace(/\r\n?/g, "\n"))
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/<[^>]{1,200}>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripExistingContohPrefix(text: string): string {
  return text
    .replace(/^(?:\[contoh(?:\s+draf)?\]|contoh(?:\s+draf)?)\s*[—:–-]*\s*/i, "")
    .trim();
}

/**
 * Deterministically ensures every generated field carries the visible `CONTOH — ` prefix
 * (matching REQ-109 AND `detectSampleClaimsInSection` in `packages/core/src/presets/index.ts`).
 */
export function markAsContohDraft(rawText: string, maxChars: number): string {
  const body = stripExistingContohPrefix(rawText);
  if (!body) return "";
  const full = `${ONBOARDING_AI_DRAFT_PREFIX}${body}`;
  if (full.length <= maxChars) return full;

  const sliced = full.slice(0, maxChars);
  const lastSpace = sliced.lastIndexOf(" ");
  const minCut = Math.max(ONBOARDING_AI_DRAFT_PREFIX.length + 8, Math.floor(maxChars * 0.7));
  const bounded = lastSpace >= minCut ? sliced.slice(0, lastSpace).trim() : sliced.trim();
  return bounded.replace(/[,;:\-–—]+$/, "").trim();
}

/**
 * Scrubs any fabricated facts (prices, licence numbers, reviews/ratings, phone/WA/email/NIK,
 * and street addresses) from an LLM-generated text field.
 */
export function scrubForbiddenFactsFromText(raw: string): {
  readonly text: string;
  readonly matchedCategories: readonly string[];
} {
  let cleaned = stripTagsAndMarkdown(raw);
  const matched = new Set<string>();

  for (const rule of FACT_SCRUB_RULES) {
    const next = cleaned.replace(rule.re, " ");
    if (next !== cleaned) {
      matched.add(rule.category);
      cleaned = next;
    }
  }

  // Collapse leftover punctuation artifacts after scrubbing
  cleaned = cleaned
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:]){2,}/g, "$1")
    .replace(/(?:^|\s)[,;:—–-]+\s*$/g, "")
    .replace(/^\s*[,;:—–-]+\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Final defense-in-depth gate via TASK-074 linear O(n) PII scanner:
  // If any email, phone number, or NIK/NPWP still survives, reject this field text completely!
  const pii = scanTextForPii(cleaned);
  if (pii.email > 0 || pii.phone > 0 || pii.nik > 0) {
    if (pii.phone > 0) matched.add("phone");
    if (pii.email > 0) matched.add("email");
    if (pii.nik > 0) matched.add("licence");
    return {
      text: "",
      matchedCategories: [...matched],
    };
  }

  return {
    text: cleaned,
    matchedCategories: [...matched],
  };
}

/**
 * Extracts a top-level JSON object string from an LLM output (handles plain JSON or
 * markdown-fenced JSON without throwing unhandled errors).
 */
function extractJsonObjectString(rawOutput: string): string | null {
  const cleaned = stripControlChars(rawOutput)
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  if (!cleaned) return null;
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return cleaned.slice(firstBrace, lastBrace + 1);
}

/**
 * Strictly parses, allowlists, fact-scrubs, and `CONTOH`-marks an LLM draft response.
 * Any factual keys (`price`, `licence`, `reviews`, `phone`, `whatsapp`, `address`, etc.)
 * are deterministically dropped and recorded in `strippedFactKeys`.
 */
export function parseAndSanitizeOnboardingAiDraftOutput(
  rawOutput: string,
): OnboardingAiDraftParseResult {
  const jsonSlice = extractJsonObjectString(rawOutput);
  if (!jsonSlice) {
    return {
      ok: false,
      code: "AI_INVALID_OUTPUT",
      reason: "Respons AI tidak berisi objek JSON yang valid.",
      strippedFactKeys: [],
      scrubbedFactMatches: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return {
      ok: false,
      code: "AI_INVALID_OUTPUT",
      reason: "JSON draf dari layanan AI tidak dapat diurai.",
      strippedFactKeys: [],
      scrubbedFactMatches: [],
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "AI_INVALID_OUTPUT",
      reason: "Struktur draf AI harus berupa objek JSON.",
      strippedFactKeys: [],
      scrubbedFactMatches: [],
    };
  }

  const record = parsed as Record<string, unknown>;
  const strippedFactKeys: string[] = [];
  const strippedFactKeySet = new Set<string>();
  const scrubbedFactSet = new Set<string>();

  const recordStrippedKey = (rawKey: string): void => {
    if (strippedFactKeys.length >= MAX_STRIPPED_FACT_KEYS) return;
    const boundedKey = stripControlChars(rawKey).trim().slice(0, MAX_STRIPPED_FACT_KEY_CHARS);
    if (!boundedKey || strippedFactKeySet.has(boundedKey)) return;
    strippedFactKeySet.add(boundedKey);
    strippedFactKeys.push(boundedKey);
  };

  for (const key of Object.keys(record)) {
    if (!ALLOWED_DRAFT_KEYS.has(key)) {
      recordStrippedKey(key);
    }
  }

  const processStringField = (key: keyof typeof FIELD_LIMITS, rawVal: unknown): string => {
    if (typeof rawVal !== "string") return "";
    const scrubbed = scrubForbiddenFactsFromText(rawVal);
    for (const cat of scrubbed.matchedCategories) scrubbedFactSet.add(cat);
    if (scrubbed.text.length < 3) return "";
    return markAsContohDraft(scrubbed.text, FIELD_LIMITS[key]);
  };

  const heroEyebrow = processStringField("heroEyebrow", record.heroEyebrow);
  const heroHeadline = processStringField("heroHeadline", record.heroHeadline);
  const heroSubheadline = processStringField("heroSubheadline", record.heroSubheadline);
  const heroCtaLabel = processStringField("heroCtaLabel", record.heroCtaLabel);
  const aboutHeading = processStringField("aboutHeading", record.aboutHeading);
  const aboutSummary = processStringField("aboutSummary", record.aboutSummary);

  const serviceSummaries: OnboardingDraftServiceSummary[] = [];
  if (Array.isArray(record.serviceSummaries)) {
    for (const item of record.serviceSummaries.slice(0, ONBOARDING_AI_DRAFT_MAX_SERVICE_SUMMARIES)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const itemRec = item as Record<string, unknown>;
      for (const subKey of Object.keys(itemRec)) {
        if (subKey !== "title" && subKey !== "description") {
          recordStrippedKey(`serviceSummaries.${subKey}`);
        }
      }
      const title = processStringField("serviceTitle", itemRec.title);
      const description = processStringField("serviceDescription", itemRec.description);
      if (title && description) {
        serviceSummaries.push({ title, description });
      }
    }
  }

  // Must produce at least heroHeadline and one supporting body field (heroSubheadline or aboutSummary)
  if (!heroHeadline || (!heroSubheadline && !aboutSummary)) {
    return {
      ok: false,
      code: "AI_INVALID_OUTPUT",
      reason: "Draf teks AI kosong atau hanya berisi klaim fakta terlarang setelah penyaringan.",
      strippedFactKeys,
      scrubbedFactMatches: [...scrubbedFactSet],
    };
  }

  return {
    ok: true,
    fields: {
      heroHeadline,
      ...(heroEyebrow ? { heroEyebrow } : {}),
      ...(heroSubheadline ? { heroSubheadline } : {}),
      ...(heroCtaLabel ? { heroCtaLabel } : {}),
      ...(aboutHeading ? { aboutHeading } : {}),
      ...(aboutSummary ? { aboutSummary } : {}),
      ...(serviceSummaries.length > 0 ? { serviceSummaries } : {}),
    },
    strippedFactKeys,
    scrubbedFactMatches: [...scrubbedFactSet],
  };
}

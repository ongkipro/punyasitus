import { normalizeForScreening, normalizeScreeningHost } from "./normalize.ts";

/**
 * Versioned publish-time content screening rules & validation helpers
 * (REQ-103, PLAN §20.1, DEC-043, TASK-103).
 */

export const SCREENING_RULE_TYPES = ["keyword", "domain"] as const;
export type ScreeningRuleType = (typeof SCREENING_RULE_TYPES)[number];

export const SCREENING_CATEGORIES = [
  "gambling",
  "phishing",
  "malware",
  "scam",
  "illegal_content",
] as const;
export type ScreeningCategory = (typeof SCREENING_CATEGORIES)[number];

export const SCREENING_SEVERITIES = ["hold", "high"] as const;
export type ScreeningSeverity = (typeof SCREENING_SEVERITIES)[number];

export const SCREENING_CATEGORY_LABELS_ID: Readonly<Record<ScreeningCategory, string>> =
  Object.freeze({
    gambling: "Judi Online / Slot",
    phishing: "Phishing / Pencurian Kredensial",
    malware: "Malware / APK Berbahaya",
    scam: "Penipuan / Investasi Ilegal",
    illegal_content: "Konten Terlarang",
  });

export interface ContentScreeningRule {
  readonly id: string;
  readonly ruleType: ScreeningRuleType;
  readonly pattern: string;
  readonly category: ScreeningCategory;
  readonly severity: ScreeningSeverity;
  readonly active: boolean;
  readonly ruleVersion: number;
  readonly source: "builtin" | "operator";
  readonly notes?: string | null;
}

export const BUILTIN_SCREENING_RULESET_VERSION = 1 as const;
export const MAX_SCREENING_RULES = 2000 as const;

function makeBuiltinRule(
  id: string,
  ruleType: ScreeningRuleType,
  pattern: string,
  category: ScreeningCategory,
  severity: ScreeningSeverity = "high",
): ContentScreeningRule {
  return Object.freeze({
    id,
    ruleType,
    pattern,
    category,
    severity,
    active: true,
    ruleVersion: BUILTIN_SCREENING_RULESET_VERSION,
    source: "builtin",
    notes: null,
  });
}

/**
 * Seeded shared-domain protection ruleset covering Indonesian online gambling (`judol`),
 * credential phishing, malicious APK drops, and high-risk financial scams.
 * Operator rows in `PLATFORM_DB.content_screening_rules` override or extend this set.
 */
export const DEFAULT_CONTENT_SCREENING_RULES: readonly ContentScreeningRule[] = Object.freeze([
  // --- Gambling (Indonesian judol keywords) ---
  makeBuiltinRule("builtin-kw-slot-gacor", "keyword", "slot gacor", "gambling", "high"),
  makeBuiltinRule("builtin-kw-judi-online", "keyword", "judi online", "gambling", "high"),
  makeBuiltinRule("builtin-kw-judol", "keyword", "judol", "gambling", "high"),
  makeBuiltinRule("builtin-kw-situs-slot", "keyword", "situs slot", "gambling", "high"),
  makeBuiltinRule("builtin-kw-daftar-slot", "keyword", "daftar slot", "gambling", "high"),
  makeBuiltinRule("builtin-kw-link-slot", "keyword", "link slot", "gambling", "high"),
  makeBuiltinRule("builtin-kw-bandar-togel", "keyword", "bandar togel", "gambling", "high"),
  makeBuiltinRule("builtin-kw-togel-online", "keyword", "togel online", "gambling", "high"),
  makeBuiltinRule("builtin-kw-toto-gelap", "keyword", "toto gelap", "gambling", "high"),
  makeBuiltinRule("builtin-kw-toto-macau", "keyword", "toto macau", "gambling", "high"),
  makeBuiltinRule("builtin-kw-maxwin", "keyword", "maxwin", "gambling", "high"),
  makeBuiltinRule("builtin-kw-zeus-slot", "keyword", "zeus slot", "gambling", "high"),
  makeBuiltinRule("builtin-kw-pragmatic-play", "keyword", "pragmatic play", "gambling", "high"),
  makeBuiltinRule("builtin-kw-sbobet", "keyword", "sbobet", "gambling", "high"),
  makeBuiltinRule("builtin-kw-scatter-hitam", "keyword", "scatter hitam", "gambling", "high"),
  makeBuiltinRule("builtin-kw-rtp-live-slot", "keyword", "rtp live slot", "gambling", "high"),
  makeBuiltinRule("builtin-kw-bocoran-rtp", "keyword", "bocoran rtp", "gambling", "high"),
  makeBuiltinRule("builtin-kw-depo-slot", "keyword", "depo slot", "gambling", "high"),
  makeBuiltinRule("builtin-kw-slot88", "keyword", "slot88", "gambling", "high"),
  makeBuiltinRule("builtin-kw-slot777", "keyword", "slot777", "gambling", "high"),
  makeBuiltinRule("builtin-kw-gacor777", "keyword", "gacor777", "gambling", "high"),
  makeBuiltinRule("builtin-kw-situs-gacor", "keyword", "situs gacor", "gambling", "high"),
  makeBuiltinRule("builtin-kw-poker-online", "keyword", "poker online", "gambling", "high"),
  makeBuiltinRule("builtin-kw-dominoqq", "keyword", "dominoqq", "gambling", "high"),
  makeBuiltinRule("builtin-kw-sabung-ayam-online", "keyword", "sabung ayam online", "gambling", "high"),
  makeBuiltinRule("builtin-kw-taruhan-bola", "keyword", "taruhan bola", "gambling", "high"),
  makeBuiltinRule("builtin-kw-agen-judi", "keyword", "agen judi", "gambling", "high"),
  makeBuiltinRule("builtin-kw-kasino-online", "keyword", "kasino online", "gambling", "high"),
  makeBuiltinRule("builtin-kw-live-casino", "keyword", "live casino", "gambling", "high"),

  // --- Phishing keywords ---
  makeBuiltinRule("builtin-kw-phish-pin-atm", "keyword", "masukkan pin atm", "phishing", "high"),
  makeBuiltinRule("builtin-kw-phish-otp-bank", "keyword", "kirim kode otp bank", "phishing", "high"),
  makeBuiltinRule("builtin-kw-phish-tarif-bank", "keyword", "update tarif transfer bank", "phishing", "high"),
  makeBuiltinRule("builtin-kw-phish-verif-rek", "keyword", "verifikasi rekening sekarang", "phishing", "high"),

  // --- Malware keywords ---
  makeBuiltinRule("builtin-kw-mal-apk-nikah", "keyword", "unduh apk undangan nikah", "malware", "high"),
  makeBuiltinRule("builtin-kw-mal-apk-tilang", "keyword", "download apk surat tilang", "malware", "high"),
  makeBuiltinRule("builtin-kw-mal-apk-resi", "keyword", "unduh apk resi paket", "malware", "high"),

  // --- Scam keywords ---
  makeBuiltinRule("builtin-kw-scam-titip-dana", "keyword", "titip dana profit pasti", "scam", "high"),
  makeBuiltinRule("builtin-kw-scam-pinjol-ilegal", "keyword", "pinjol ilegal cair cepat", "scam", "high"),
  makeBuiltinRule("builtin-kw-scam-jual-rekening", "keyword", "jual beli rekening bank", "scam", "high"),

  // --- Seeded denylisted link domains (gambling / phishing / malware fixtures & known hosts) ---
  makeBuiltinRule("builtin-dom-slotgacor-example", "domain", "slotgacor.example", "gambling", "high"),
  makeBuiltinRule("builtin-dom-judol-demo-invalid", "domain", "judol-demo.invalid", "gambling", "high"),
  makeBuiltinRule("builtin-dom-slot88-example", "domain", "slot88.example", "gambling", "high"),
  makeBuiltinRule("builtin-dom-togel-online-example", "domain", "togel-online.example", "gambling", "high"),
  makeBuiltinRule("builtin-dom-sbobet-com", "domain", "sbobet.com", "gambling", "high"),
  makeBuiltinRule("builtin-dom-phish-login-example", "domain", "phish-login.example", "phishing", "high"),
  makeBuiltinRule("builtin-dom-malware-drop-example", "domain", "malware-drop.example", "malware", "high"),
]);

export interface ScreeningRuleValidationFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface ValidatedScreeningRuleInput {
  readonly ruleType: ScreeningRuleType;
  readonly pattern: string;
  readonly category: ScreeningCategory;
  readonly severity: ScreeningSeverity;
  readonly active: boolean;
  readonly notes: string | null;
}

export type ValidateScreeningRuleResult =
  | { readonly ok: true; readonly data: ValidatedScreeningRuleInput }
  | {
      readonly ok: false;
      readonly message: string;
      readonly fields: readonly ScreeningRuleValidationFieldError[];
    };

const RULE_TYPE_SET: ReadonlySet<string> = new Set(SCREENING_RULE_TYPES);
const CATEGORY_SET: ReadonlySet<string> = new Set(SCREENING_CATEGORIES);
const SEVERITY_SET: ReadonlySet<string> = new Set(SCREENING_SEVERITIES);

/**
 * Validates and normalizes an operator-submitted screening rule before writing to `PLATFORM_DB`.
 */
export function validateScreeningRuleInput(
  raw: Readonly<Record<string, unknown>>,
): ValidateScreeningRuleResult {
  const fields: ScreeningRuleValidationFieldError[] = [];

  const ruleTypeRaw = typeof raw.ruleType === "string" ? raw.ruleType.trim().toLowerCase() : "";
  if (!RULE_TYPE_SET.has(ruleTypeRaw)) {
    fields.push({
      field: "ruleType",
      code: "INVALID_RULE_TYPE",
      message: "Tipe aturan harus 'keyword' atau 'domain'.",
    });
  }

  const categoryRaw = typeof raw.category === "string" ? raw.category.trim().toLowerCase() : "";
  if (!CATEGORY_SET.has(categoryRaw)) {
    fields.push({
      field: "category",
      code: "INVALID_CATEGORY",
      message: "Kategori aturan tidak valid.",
    });
  }

  const severityRaw =
    raw.severity === undefined
      ? "hold"
      : typeof raw.severity === "string"
        ? raw.severity.trim().toLowerCase()
        : "";
  if (!SEVERITY_SET.has(severityRaw)) {
    fields.push({
      field: "severity",
      code: "INVALID_SEVERITY",
      message: "Tingkat keparahan harus 'hold' atau 'high'.",
    });
  }

  const active = raw.active === undefined ? true : Boolean(raw.active);
  const patternRaw = typeof raw.pattern === "string" ? raw.pattern.trim() : "";
  let normalizedPattern = "";

  if (ruleTypeRaw === "domain") {
    const host = normalizeScreeningHost(patternRaw);
    if (!host) {
      fields.push({
        field: "pattern",
        code: "INVALID_DOMAIN",
        message: "Masukkan nama host domain yang valid (contoh: contoh-judi.example).",
      });
    } else {
      normalizedPattern = host;
    }
  } else if (ruleTypeRaw === "keyword") {
    const norm = normalizeForScreening(patternRaw, 200);
    if (norm.canonical.length < 3 || norm.canonical.length > 120) {
      fields.push({
        field: "pattern",
        code: "INVALID_KEYWORD",
        message: "Kata kunci harus 3–120 karakter alfanumerik setelah normalisasi.",
      });
    } else {
      normalizedPattern = norm.canonical;
    }
  } else if (!patternRaw) {
    fields.push({
      field: "pattern",
      code: "REQUIRED",
      message: "Pola aturan wajib diisi.",
    });
  }

  let notes: string | null = null;
  if (raw.notes !== undefined && raw.notes !== null) {
    if (typeof raw.notes !== "string") {
      fields.push({
        field: "notes",
        code: "INVALID_TYPE",
        message: "Catatan aturan harus berupa teks.",
      });
    } else {
      const trimmedNotes = raw.notes.replace(/[\r\n\t]+/g, " ").trim();
      if (trimmedNotes.length > 300) {
        fields.push({
          field: "notes",
          code: "TOO_LONG",
          message: "Catatan aturan maksimal 300 karakter.",
        });
      } else {
        notes = trimmedNotes || null;
      }
    }
  }

  if (fields.length > 0) {
    return {
      ok: false,
      message: "Data aturan penyaringan tidak valid.",
      fields,
    };
  }

  return {
    ok: true,
    data: {
      ruleType: ruleTypeRaw as ScreeningRuleType,
      pattern: normalizedPattern,
      category: categoryRaw as ScreeningCategory,
      severity: severityRaw as ScreeningSeverity,
      active,
      notes,
    },
  };
}

/**
 * Merges built-in rules with operator-managed `PLATFORM_DB` rules.
 * Operator rules matching the same `(ruleType, pattern)` take precedence (so operators can
 * disable a noisy built-in rule or escalate its severity), and the returned `rulesetVersion`
 * reflects the highest rule version in the effective ruleset.
 */
export function mergeScreeningRules(
  operatorRules: readonly ContentScreeningRule[],
  builtinRules: readonly ContentScreeningRule[] = DEFAULT_CONTENT_SCREENING_RULES,
): {
  readonly rules: readonly ContentScreeningRule[];
  readonly rulesetVersion: number;
} {
  const byKey = new Map<string, ContentScreeningRule>();
  let maxVersion: number = BUILTIN_SCREENING_RULESET_VERSION;

  for (const rule of builtinRules) {
    byKey.set(`${rule.ruleType}:${rule.pattern}`, rule);
    if (rule.ruleVersion > maxVersion) maxVersion = rule.ruleVersion;
  }

  for (const rule of operatorRules) {
    byKey.set(`${rule.ruleType}:${rule.pattern}`, rule);
    if (rule.ruleVersion > maxVersion) maxVersion = rule.ruleVersion;
  }

  const activeRules: ContentScreeningRule[] = [];
  for (const rule of byKey.values()) {
    if (rule.active && activeRules.length < MAX_SCREENING_RULES) {
      activeRules.push(rule);
    }
  }

  return { rules: activeRules, rulesetVersion: maxVersion };
}

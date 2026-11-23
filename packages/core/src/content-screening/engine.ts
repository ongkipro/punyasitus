import {
  extractPublishContent,
  type PublishScreeningInputPayload,
  type ScreeningFieldKind,
} from "./extract.ts";
import {
  hostMatchesDenylistedDomain,
  MAX_FIELD_TEXT_CHARS,
  MAX_TOTAL_SCREENED_CHARS,
  normalizeForScreening,
  sanitizeFindingExcerpt,
} from "./normalize.ts";
import {
  BUILTIN_SCREENING_RULESET_VERSION,
  DEFAULT_CONTENT_SCREENING_RULES,
  type ContentScreeningRule,
  type ScreeningCategory,
  type ScreeningRuleType,
  type ScreeningSeverity,
} from "./rules.ts";

/**
 * Deterministic, ReDoS-safe publish-time content screening engine
 * (REQ-103, PLAN §20.1, DEC-043, TASK-103).
 *
 * Security invariants:
 * - Every publish path (dashboard and MCP) passes through `screenPublishContent`.
 * - Any match OR budget truncation yields `verdict: "hold_for_review"` (fail closed against
 *   padding-bypass attacks!) and `ownerNotice: "Konten ditahan untuk ditinjau"`.
 * - Owner-facing responses NEVER disclose matched keywords, denylisted domains, or operator notes.
 * - Operator-facing findings scrub all secrets and PII before storage.
 */

export const OWNER_HELD_FOR_REVIEW_NOTICE = "Konten ditahan untuk ditinjau" as const;
export const HELD_FOR_REVIEW_REASON_CODE = "held_for_review" as const;
export const CONTENT_TRUNCATION_HOLD_RULE_ID = "CONTENT_TRUNCATION_HOLD" as const;

export const MAX_RECORDED_FINDINGS = 25 as const;

export interface ScreeningFinding {
  readonly ruleId: string;
  readonly ruleType: ScreeningRuleType;
  readonly category: ScreeningCategory;
  readonly severity: ScreeningSeverity;
  readonly fieldKind: ScreeningFieldKind;
  readonly fieldPath: string;
  /** Present for `domain` rule matches (resolved normalized hostname). */
  readonly matchedHost: string | null;
  /** Strictly PII/secret-redacted excerpt for operator review ONLY (never shown to tenant). */
  readonly redactedExcerpt: string;
}

export interface ContentScreeningResult {
  readonly verdict: "allow" | "hold_for_review";
  readonly reasonCode: typeof HELD_FOR_REVIEW_REASON_CODE | null;
  readonly ownerNotice: typeof OWNER_HELD_FOR_REVIEW_NOTICE | null;
  readonly rulesetVersion: number;
  readonly scannedFieldsCount: number;
  readonly scannedLinksCount: number;
  readonly truncated: boolean;
  readonly matchedCategories: readonly ScreeningCategory[];
  readonly matchedFields: readonly ScreeningFieldKind[];
  readonly findings: readonly ScreeningFinding[];
}

export interface OwnerSafeHeldPublishNotice {
  readonly held: true;
  readonly status: "draft";
  readonly reason: typeof HELD_FOR_REVIEW_REASON_CODE;
  readonly reviewId: string;
  readonly message: typeof OWNER_HELD_FOR_REVIEW_NOTICE;
}

interface CompiledKeywordRule {
  readonly rule: ContentScreeningRule;
  readonly paddedCanonical: string;
  readonly paddedCompact: string;
  readonly paddedLeetI: string;
  readonly paddedCompactLeetI: string;
  readonly paddedLeetL: string;
  readonly paddedCompactLeetL: string;
  readonly compactPattern: string;
  readonly compactLeetPatternI: string;
  readonly compactLeetPatternL: string;
  readonly allowCompactSubstringMatch: boolean;
}

interface PaddedScreeningForms {
  readonly canonical: string;
  readonly joinedPunctTokens: string;
  readonly leetFolded: string;
  readonly leetFoldedL: string;
  readonly joinedLeetI: string;
  readonly joinedLeetL: string;
  readonly compact: string;
  readonly compactLeet: string;
  readonly compactLeetL: string;
}

interface CompiledRuleset {
  readonly keywords: readonly CompiledKeywordRule[];
  readonly domains: readonly ContentScreeningRule[];
  readonly rulesetVersion: number;
}

function compileRuleset(rules: readonly ContentScreeningRule[]): CompiledRuleset {
  const keywords: CompiledKeywordRule[] = [];
  const domains: ContentScreeningRule[] = [];
  let maxVersion: number = BUILTIN_SCREENING_RULESET_VERSION;

  for (const rule of rules) {
    if (!rule.active) continue;
    if (rule.ruleVersion > maxVersion) maxVersion = rule.ruleVersion;

    if (rule.ruleType === "domain") {
      domains.push(rule);
    } else if (rule.ruleType === "keyword") {
      const norm = normalizeForScreening(rule.pattern, 200);
      if (!norm.canonical) continue;
      // Enable full compact substring match for >= 6 char terms; shorter >= 4 char terms
      // still match boundary-aware punctuation-rejoined tokens (`j.u.d.o.l` -> `judol`, `j u d o l` -> `judol`)!
      const allowCompactSubstringMatch = norm.compact.length >= 6;
      keywords.push({
        rule,
        paddedCanonical: ` ${norm.canonical} `,
        paddedCompact: ` ${norm.compact} `,
        paddedLeetI: norm.leetFolded ? ` ${norm.leetFolded} ` : "",
        paddedCompactLeetI: norm.compactLeet ? ` ${norm.compactLeet} ` : "",
        paddedLeetL: norm.leetFoldedL ? ` ${norm.leetFoldedL} ` : "",
        paddedCompactLeetL: norm.compactLeetL ? ` ${norm.compactLeetL} ` : "",
        compactPattern: norm.compact,
        compactLeetPatternI: norm.compactLeet,
        compactLeetPatternL: norm.compactLeetL,
        allowCompactSubstringMatch,
      });
    }
  }

  return { keywords, domains, rulesetVersion: maxVersion };
}

function padFormsOnce(forms: ReturnType<typeof normalizeForScreening>): PaddedScreeningForms {
  return {
    canonical: forms.canonical ? ` ${forms.canonical} ` : "",
    joinedPunctTokens: forms.joinedPunctTokens ? ` ${forms.joinedPunctTokens} ` : "",
    leetFolded: forms.leetFolded ? ` ${forms.leetFolded} ` : "",
    leetFoldedL: forms.leetFoldedL ? ` ${forms.leetFoldedL} ` : "",
    joinedLeetI: forms.joinedLeetI ? ` ${forms.joinedLeetI} ` : "",
    joinedLeetL: forms.joinedLeetL ? ` ${forms.joinedLeetL} ` : "",
    compact: forms.compact,
    compactLeet: forms.compactLeet,
    compactLeetL: forms.compactLeetL,
  };
}

/**
 * Checks whether a keyword rule matches pre-padded normalized forms of a field value.
 * Zero per-rule string allocations: runs in linear O(N) well within Worker 50ms CPU budgets.
 */
function matchesKeywordRule(
  padded: PaddedScreeningForms,
  compiled: CompiledKeywordRule,
): boolean {
  if (padded.canonical && padded.canonical.includes(compiled.paddedCanonical)) return true;
  if (padded.joinedPunctTokens) {
    if (padded.joinedPunctTokens.includes(compiled.paddedCanonical)) return true;
    if (padded.joinedPunctTokens.includes(compiled.paddedCompact)) return true;
  }

  if (compiled.paddedLeetI) {
    if (padded.leetFolded && padded.leetFolded.includes(compiled.paddedLeetI)) return true;
    if (padded.joinedLeetI) {
      if (padded.joinedLeetI.includes(compiled.paddedLeetI)) return true;
      if (padded.joinedLeetI.includes(compiled.paddedCompactLeetI)) return true;
    }
  }
  if (compiled.paddedLeetL) {
    if (padded.leetFoldedL && padded.leetFoldedL.includes(compiled.paddedLeetL)) return true;
    if (padded.joinedLeetL) {
      if (padded.joinedLeetL.includes(compiled.paddedLeetL)) return true;
      if (padded.joinedLeetL.includes(compiled.paddedCompactLeetL)) return true;
    }
  }

  if (compiled.allowCompactSubstringMatch) {
    if (compiled.compactPattern && padded.compact.includes(compiled.compactPattern)) return true;
    if (compiled.compactLeetPatternI && padded.compactLeet.includes(compiled.compactLeetPatternI)) {
      return true;
    }
    if (compiled.compactLeetPatternL && padded.compactLeetL.includes(compiled.compactLeetPatternL)) {
      return true;
    }
  }

  return false;
}

export interface ScreenPublishContentOptions {
  readonly rules?: readonly ContentScreeningRule[];
  readonly rulesetVersion?: number;
  readonly maxTotalChars?: number;
}

/**
 * Screens any publishable content payload deterministically against the active ruleset.
 * Fails CLOSED (`verdict: "hold_for_review"`) if input exceeds bounded screening budgets.
 */
export function screenPublishContent(
  input: PublishScreeningInputPayload,
  options: ScreenPublishContentOptions = {},
): ContentScreeningResult {
  const rules = options.rules ?? DEFAULT_CONTENT_SCREENING_RULES;
  const compiled = compileRuleset(rules);
  const rulesetVersion = options.rulesetVersion ?? compiled.rulesetVersion;
  const maxTotalChars = options.maxTotalChars ?? MAX_TOTAL_SCREENED_CHARS;

  const extracted = extractPublishContent(input);
  const findings: ScreeningFinding[] = [];
  const dedupFindingKeys = new Set<string>();
  const matchedCategoriesSet = new Set<ScreeningCategory>();
  const matchedFieldsSet = new Set<ScreeningFieldKind>();

  let totalCharsScanned = 0;
  let truncated = extracted.truncated;

  const pushFinding = (finding: ScreeningFinding) => {
    const key = `${finding.ruleId}|${finding.fieldKind}|${finding.fieldPath}`;
    if (dedupFindingKeys.has(key)) return;
    dedupFindingKeys.add(key);
    matchedCategoriesSet.add(finding.category);
    matchedFieldsSet.add(finding.fieldKind);
    if (findings.length < MAX_RECORDED_FINDINGS) {
      findings.push(finding);
    }
  };

  // 1. Screen extracted text fields (title, rich text, image ALT, custom form labels)
  for (const field of extracted.texts) {
    const remainingBudget = maxTotalChars - totalCharsScanned;
    if (remainingBudget <= 0) {
      truncated = true;
      break;
    }

    const fieldCap = Math.min(MAX_FIELD_TEXT_CHARS, remainingBudget);
    const forms = normalizeForScreening(field.value, fieldCap);
    totalCharsScanned += Math.min(field.value.length, fieldCap);
    if (forms.truncated) truncated = true;
    const paddedForms = padFormsOnce(forms);

    for (const kw of compiled.keywords) {
      if (matchesKeywordRule(paddedForms, kw)) {
        pushFinding({
          ruleId: kw.rule.id,
          ruleType: "keyword",
          category: kw.rule.category,
          severity: kw.rule.severity,
          fieldKind: field.kind,
          fieldPath: field.path,
          matchedHost: null,
          redactedExcerpt: sanitizeFindingExcerpt(field.value),
        });
      }
    }
  }

  // 2. Screen resolved link hostnames against domain denylist
  for (const link of extracted.links) {
    for (const domRule of compiled.domains) {
      if (hostMatchesDenylistedDomain(link.host, domRule.pattern)) {
        pushFinding({
          ruleId: domRule.id,
          ruleType: "domain",
          category: domRule.category,
          severity: domRule.severity,
          fieldKind: "link_host",
          fieldPath: link.path,
          matchedHost: link.host,
          redactedExcerpt: sanitizeFindingExcerpt(link.host),
        });
      }
    }
  }

  // 3. Fail-closed on truncation: padding past scan limits MUST hold for operator review!
  if (truncated) {
    pushFinding({
      ruleId: CONTENT_TRUNCATION_HOLD_RULE_ID,
      ruleType: "keyword",
      category: "illegal_content",
      severity: "hold",
      fieldKind: "text",
      fieldPath: "payload.budget",
      matchedHost: null,
      redactedExcerpt:
        "Konten melebihi batas ukuran pemindaian otomatis sehingga ditahan untuk peninjauan operator.",
    });
  }

  const matched = findings.length > 0;

  return {
    verdict: matched ? "hold_for_review" : "allow",
    reasonCode: matched ? HELD_FOR_REVIEW_REASON_CODE : null,
    ownerNotice: matched ? OWNER_HELD_FOR_REVIEW_NOTICE : null,
    rulesetVersion,
    scannedFieldsCount: extracted.texts.length,
    scannedLinksCount: extracted.links.length,
    truncated,
    matchedCategories: Array.from(matchedCategoriesSet),
    matchedFields: Array.from(matchedFieldsSet),
    findings,
  };
}

/**
 * Computes a deterministic SHA-256 hex digest of a publishable content payload using Web Crypto
 * (works identically in Cloudflare `workerd` and Node 22).
 */
export async function computeScreeningContentHash(payload: unknown): Promise<string> {
  const serialized = JSON.stringify(payload ?? null) ?? "null";
  const bytes = new TextEncoder().encode(serialized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i += 1) {
    hex += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Produces the strict tenant-facing payload when a publish attempt is held for review.
 * Guarantees zero leakage of matched keywords, denylisted domains, or operator notes.
 */
export function buildOwnerSafeHeldPublishNotice(reviewId: string): OwnerSafeHeldPublishNotice {
  return {
    held: true,
    status: "draft",
    reason: HELD_FOR_REVIEW_REASON_CODE,
    reviewId,
    message: OWNER_HELD_FOR_REVIEW_NOTICE,
  };
}

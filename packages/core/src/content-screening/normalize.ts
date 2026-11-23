/**
 * Deterministic, ReDoS-safe text & hostname normalization for publish-time content screening
 * (REQ-103, PLAN §20.1, TASK-103).
 *
 * Security & performance invariants:
 * - Zero nested-quantifier regexes: every pass is linear O(N) with hard input size caps
 *   to stay well within Cloudflare Worker 50ms CPU limits.
 * - Normalizes Unicode NFKC, strips zero-width/filler/variation-selector/tag evasion characters
 *   and diacritics, folds Cyrillic/Greek confusable homoglyphs, and produces canonical,
 *   dual leetspeak (`1`/`|` -> BOTH `i` and `l`), punctuation-rejoined token, and compact forms.
 * - Scrubs secrets and PII (emails, phones, JWTs, API keys, passwords, cookies) before any
 *   operator finding excerpt is stored.
 */

export const MAX_FIELD_TEXT_CHARS = 50_000 as const;
export const MAX_TOTAL_SCREENED_CHARS = 250_000 as const;
export const MAX_EXCERPT_CHARS = 140 as const;

const HOMOGLYPH_MAP: Readonly<Record<string, string>> = {
  // Cyrillic lowercase & uppercase confusables
  а: "a",
  А: "a",
  в: "b",
  В: "b",
  с: "c",
  С: "c",
  е: "e",
  Е: "e",
  ё: "e",
  Ё: "e",
  н: "h",
  Н: "h",
  і: "i",
  І: "i",
  ї: "i",
  Ї: "i",
  ј: "j",
  Ј: "j",
  к: "k",
  К: "k",
  м: "m",
  М: "m",
  о: "o",
  О: "o",
  р: "p",
  Р: "p",
  ѕ: "s",
  Ѕ: "s",
  т: "t",
  Т: "t",
  у: "y",
  У: "y",
  х: "x",
  Х: "x",
  // Greek confusables
  α: "a",
  Α: "a",
  β: "b",
  Β: "b",
  ε: "e",
  Ε: "e",
  ι: "i",
  Ι: "i",
  κ: "k",
  Κ: "k",
  μ: "m",
  Μ: "m",
  ν: "v",
  ο: "o",
  Ο: "o",
  ρ: "p",
  Ρ: "p",
  τ: "t",
  Τ: "t",
  χ: "x",
  Χ: "x",
  // Latin lookalikes
  ı: "i",
  ł: "l",
  ø: "o",
  ß: "ss",
};

const LEETSPEAK_I_MAP: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "i",
};

const LEETSPEAK_L_MAP: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l",
};

/**
 * Detects invisible, zero-width, filler, bidi, variation-selector, and Unicode tag code points
 * commonly injected to evade keyword matching (e.g., `s\u3164lot`, `j\u200budol`, `\u{E0001}`).
 */
function isInvisibleCodePoint(code: number): boolean {
  return (
    code === 0x00ad || // soft hyphen
    code === 0x034f || // combining grapheme joiner
    code === 0x061c || // arabic letter mark
    code === 0x115f || // hangul choseong filler
    code === 0x1160 || // hangul jungseong filler
    code === 0x17b4 || // khmer vowel inherent aq
    code === 0x17b5 || // khmer vowel inherent aa
    code === 0x180e || // mongolian vowel separator
    (code >= 0x200b && code <= 0x200f) || // ZWSP, ZWNJ, ZWJ, LRM, RLM
    (code >= 0x202a && code <= 0x202e) || // bidi overrides
    (code >= 0x2060 && code <= 0x206f) || // word joiner & invisible operators
    code === 0x2800 || // braille pattern blank
    code === 0x3164 || // hangul filler
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    code === 0xfeff || // BOM / ZWNBSP
    code === 0xffa0 || // halfwidth hangul filler
    (code >= 0xe0000 && code <= 0xe007f) // Unicode tag characters
  );
}

function isAsciiAlphaNum(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x61 && code <= 0x7a) // a-z
  );
}

function isInlineWordSeparator(code: number): boolean {
  return (
    code === 0x2e || // .
    code === 0x2d || // -
    code === 0x5f || // _
    code === 0x2a || // *
    code === 0x2f || // /
    code === 0x2c || // ,
    code === 0xb7 || // middle dot ·
    code === 0x2022 || // bullet •
    code === 0x2027 // hyphenation point ‧
  );
}

/**
 * Truncates text deterministically to a hard upper bound before normalization.
 */
export function boundScreeningText(
  input: string,
  maxChars: number = MAX_FIELD_TEXT_CHARS,
): { readonly text: string; readonly truncated: boolean } {
  if (input.length <= maxChars) {
    return { text: input, truncated: false };
  }
  return { text: input.slice(0, maxChars), truncated: true };
}

export interface NormalizedScreeningForms {
  /** Space-delimited lowercase alphanumeric tokens after NFKC + invisible + diacritic + homoglyph folding. */
  readonly canonical: string;
  /** Space-delimited tokens with intra-word punctuation separators (`.`, `·`, `-`, `_`) rejoined (`j.u.d.o.l` -> `judol`). */
  readonly joinedPunctTokens: string;
  /** Space-delimited lowercase tokens with leetspeak folded (`1`/`|` -> `i`). */
  readonly leetFolded: string;
  /** Space-delimited lowercase tokens with leetspeak folded (`1`/`|` -> `l`, catching `s1ot`/`s|ot`). */
  readonly leetFoldedL: string;
  /** Punctuation-rejoined tokens with leetspeak folded (`1`/`|` -> `i`). */
  readonly joinedLeetI: string;
  /** Punctuation-rejoined tokens with leetspeak folded (`1`/`|` -> `l`). */
  readonly joinedLeetL: string;
  /** Compact alphanumeric string (all separators removed) for multi-char phrase evasion. */
  readonly compact: string;
  /** Compact leetspeak-folded string (`1`/`|` -> `i`). */
  readonly compactLeet: string;
  /** Compact leetspeak-folded string (`1`/`|` -> `l`). */
  readonly compactLeetL: string;
  readonly truncated: boolean;
}

/**
 * Collapses single-character spaced runs (e.g. `j u d o l` -> `judol`) while keeping multi-char words
 * space-delimited so short boundary-matched terms (`judol`, `slot`) catch spaced evasion too.
 */
function collapseSingleCharSpacedRuns(spaceDelimited: string): string {
  if (!spaceDelimited) return "";
  const tokens = spaceDelimited.split(" ");
  const out: string[] = [];
  let singleBuf = "";

  for (const tok of tokens) {
    if (tok.length === 1) {
      singleBuf += tok;
    } else {
      if (singleBuf) {
        out.push(singleBuf);
        singleBuf = "";
      }
      if (tok) out.push(tok);
    }
  }
  if (singleBuf) out.push(singleBuf);
  return out.join(" ");
}

/**
 * Produces deterministic normalized representations for linear substring/token matching.
 */
export function normalizeForScreening(
  rawInput: string,
  maxChars: number = MAX_FIELD_TEXT_CHARS,
): NormalizedScreeningForms {
  const { text: bounded, truncated } = boundScreeningText(rawInput, maxChars);

  // Fast check: pure printable ASCII without invisible chars skips NFKC/NFD & homoglyph passes (20x faster in workerd)
  let needsUnicodePass = false;
  for (let i = 0; i < bounded.length; i += 1) {
    if (bounded.charCodeAt(i) >= 0x80) {
      needsUnicodePass = true;
      break;
    }
  }

  let foldedRaw = "";
  if (!needsUnicodePass) {
    foldedRaw = bounded.toLowerCase();
  } else {
    // Strip invisible/filler/tag characters BEFORE NFKC/NFD so astral tag chars and fillers
    // can never split ligatures or survive compatibility decomposition.
    let stripped = "";
    for (const ch of bounded) {
      const cp = ch.codePointAt(0) ?? 0;
      if (isInvisibleCodePoint(cp)) continue;
      stripped += ch;
    }

    // 1. NFKC folds fullwidth characters, ligatures, superscripts, and compatibility forms.
    // 2. NFD separates combining marks so we strip diacritics cleanly in a linear pass.
    const decomposed = stripped.normalize("NFKC").normalize("NFD");

    for (const ch of decomposed) {
      const cp = ch.codePointAt(0) ?? 0;
      if (isInvisibleCodePoint(cp)) continue;
      // Strip Unicode combining diacritical marks (U+0300..U+036F)
      if (cp >= 0x0300 && cp <= 0x036f) continue;
      const mapped = HOMOGLYPH_MAP[ch];
      foldedRaw += mapped !== undefined ? mapped : ch.toLowerCase();
    }
  }

  let canonical = "";
  let joinedPunctTokens = "";
  let leetFolded = "";
  let leetFoldedL = "";
  let joinedLeetI = "";
  let joinedLeetL = "";
  let compact = "";
  let compactLeet = "";
  let compactLeetL = "";

  let prevCanonicalSpace = true;
  let prevJoinedSpace = true;
  let prevLeetSpace = true;
  let prevLeetLSpace = true;
  let prevJoinedLeetISpace = true;
  let prevJoinedLeetLSpace = true;

  for (let i = 0; i < foldedRaw.length; i += 1) {
    const ch = foldedRaw[i]!;
    const code = ch.charCodeAt(0);
    const inlineSep = isInlineWordSeparator(code);

    // 1. Canonical stream
    if (isAsciiAlphaNum(code)) {
      canonical += ch;
      joinedPunctTokens += ch;
      compact += ch;
      prevCanonicalSpace = false;
      prevJoinedSpace = false;
    } else {
      if (!prevCanonicalSpace) {
        canonical += " ";
        prevCanonicalSpace = true;
      }
      // Only break `joinedPunctTokens` on whitespace/non-inline separators so `j.u.d.o.l` and `j·udol` join into `judol`!
      if (!inlineSep && !prevJoinedSpace) {
        joinedPunctTokens += " ";
        prevJoinedSpace = true;
      }
    }

    // 2. Leetspeak-I stream (`1`/`|` -> `i`)
    const leetI = LEETSPEAK_I_MAP[ch] ?? ch;
    const leetICode = leetI.charCodeAt(0);
    if (isAsciiAlphaNum(leetICode)) {
      leetFolded += leetI;
      joinedLeetI += leetI;
      compactLeet += leetI;
      prevLeetSpace = false;
      prevJoinedLeetISpace = false;
    } else {
      if (!prevLeetSpace) {
        leetFolded += " ";
        prevLeetSpace = true;
      }
      if (!inlineSep && !prevJoinedLeetISpace) {
        joinedLeetI += " ";
        prevJoinedLeetISpace = true;
      }
    }

    // 3. Leetspeak-L stream (`1`/`|` -> `l`)
    const leetL = LEETSPEAK_L_MAP[ch] ?? ch;
    const leetLCode = leetL.charCodeAt(0);
    if (isAsciiAlphaNum(leetLCode)) {
      leetFoldedL += leetL;
      joinedLeetL += leetL;
      compactLeetL += leetL;
      prevLeetLSpace = false;
      prevJoinedLeetLSpace = false;
    } else {
      if (!prevLeetLSpace) {
        leetFoldedL += " ";
        prevLeetLSpace = true;
      }
      if (!inlineSep && !prevJoinedLeetLSpace) {
        joinedLeetL += " ";
        prevJoinedLeetLSpace = true;
      }
    }
  }

  const cleanCanonical = canonical.trim();
  const cleanJoined = collapseSingleCharSpacedRuns(joinedPunctTokens.trim());
  const cleanLeetI = leetFolded.trim();
  const cleanLeetL = leetFoldedL.trim();
  const cleanJoinedLeetI = collapseSingleCharSpacedRuns(joinedLeetI.trim());
  const cleanJoinedLeetL = collapseSingleCharSpacedRuns(joinedLeetL.trim());

  return {
    canonical: cleanCanonical,
    joinedPunctTokens: cleanJoined,
    leetFolded: cleanLeetI,
    leetFoldedL: cleanLeetL,
    joinedLeetI: cleanJoinedLeetI,
    joinedLeetL: cleanJoinedLeetL,
    compact,
    compactLeet,
    compactLeetL,
    truncated,
  };
}

/**
 * Normalizes a hostname (from a URL, protocol-relative URL `//host/path`, or domain rule)
 * into lowercase ASCII/punycode without port, scheme, path, or trailing dot. Returns `null` if invalid.
 */
export function normalizeScreeningHost(rawHostOrUrl: string): string | null {
  const trimmed = rawHostOrUrl.trim();
  if (!trimmed || trimmed.length > 512) return null;

  let candidate = trimmed;
  if (candidate.startsWith("//")) {
    candidate = `https:${candidate}`;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      candidate = parsed.hostname;
    } catch {
      return null;
    }
  } else {
    // Strip path/query/fragment/port if caller passed host/path
    const slashIdx = candidate.indexOf("/");
    if (slashIdx !== -1) candidate = candidate.slice(0, slashIdx);
    const qIdx = candidate.indexOf("?");
    if (qIdx !== -1) candidate = candidate.slice(0, qIdx);
    const hIdx = candidate.indexOf("#");
    if (hIdx !== -1) candidate = candidate.slice(0, hIdx);
    const colonIdx = candidate.indexOf(":");
    if (colonIdx !== -1) candidate = candidate.slice(0, colonIdx);

    // Use URL parser to normalize punycode/IDNA safely
    try {
      const parsed = new URL(`https://${candidate}`);
      candidate = parsed.hostname;
    } catch {
      return null;
    }
  }

  const normalized = candidate.toLowerCase().replace(/\.+$/g, "");
  if (!normalized || normalized.length > 253 || !normalized.includes(".")) {
    return null;
  }
  // Linear label validation (no nested quantifiers)
  const labels = normalized.split(".");
  if (labels.length < 2) return null;
  // Require a valid alphabetic or punycode TLD (`xn--...`) of at least 2 chars
  const tld = labels[labels.length - 1] ?? "";
  if (tld.length < 2) return null;
  const tldAllAlpha = /^[a-z]+$/.test(tld) || tld.startsWith("xn--");
  if (!tldAllAlpha) return null;

  for (const label of labels) {
    if (!label || label.length > 63) return null;
    if (label.startsWith("-") || label.endsWith("-")) return null;
    for (let i = 0; i < label.length; i += 1) {
      const c = label.charCodeAt(i);
      const valid =
        (c >= 0x61 && c <= 0x7a) || // a-z
        (c >= 0x30 && c <= 0x39) || // 0-9
        c === 0x2d; // -
      if (!valid) return null;
    }
  }
  return normalized;
}

/**
 * Checks whether `host` equals `denylistedDomain` or is a subdomain of it.
 */
export function hostMatchesDenylistedDomain(host: string, denylistedDomain: string): boolean {
  if (host === denylistedDomain) return true;
  return host.endsWith(`.${denylistedDomain}`);
}

const REDACT_PEM_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const REDACT_JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const REDACT_BEARER_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const REDACT_PROVIDER_KEY_RE =
  /\b(?:(?:sk_live|sk_test|pk_live|pk_test|rk_live|rk_test|whsec|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|AIza|AKIA)[_-]?[A-Za-z0-9_-]{8,}|(?:re|cf)_[A-Za-z0-9_-]{8,}|0x4[A-Za-z0-9_-]{16,})\b/g;
const REDACT_KV_SECRET_RE =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie)\s*([:=])\s*([^\s,;'"}\]]+)/gi;
const REDACT_EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const REDACT_ID_PHONE_RE = /(?<!\w)(?:\+?62|0)8[1-9][0-9\s.-]{6,13}(?!\w)/g;

/**
 * Scrubs secrets, credentials, emails, and phone numbers from any text excerpt stored
 * in operator-facing screening findings so zero PII/secrets ever leak into `PLATFORM_DB`.
 */
export function sanitizeFindingExcerpt(
  rawText: string,
  maxChars: number = MAX_EXCERPT_CHARS,
): string {
  const bounded = rawText.length > 600 ? rawText.slice(0, 600) : rawText;
  const cleaned = bounded
    .replace(REDACT_PEM_RE, "[REDACTED]")
    .replace(REDACT_JWT_RE, "[REDACTED]")
    .replace(REDACT_BEARER_RE, (_m, scheme: string) => `${scheme} [REDACTED]`)
    .replace(REDACT_PROVIDER_KEY_RE, "[REDACTED]")
    .replace(REDACT_KV_SECRET_RE, (_m, k: string, sep: string) => `${k}${sep}[REDACTED]`)
    .replace(REDACT_EMAIL_RE, "[REDACTED_EMAIL]")
    .replace(REDACT_ID_PHONE_RE, "[REDACTED_PHONE]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

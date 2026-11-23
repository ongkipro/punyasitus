export const WA_ME_ORIGIN = "https://wa.me" as const;
export const MIN_INDONESIAN_E164_DIGITS = 10 as const;
export const MAX_E164_DIGITS = 15 as const;
export const MAX_WA_TEMPLATE_LENGTH = 1000 as const;
export const ON_REQUEST_PRICE_TEXT_ID = "Hubungi untuk harga" as const;

export const CANONICAL_WA_TOKENS = ["item_title", "item_price", "page_url"] as const;
export type CanonicalWaToken = (typeof CANONICAL_WA_TOKENS)[number];

export const SCHEDULE_WA_TOKENS = ["preferred_date", "preferred_time", "branch"] as const;
export type ScheduleWaToken = (typeof SCHEDULE_WA_TOKENS)[number];

export const ALL_WA_TOKENS = [...CANONICAL_WA_TOKENS, ...SCHEDULE_WA_TOKENS] as const;
export type AllowedWaToken = (typeof ALL_WA_TOKENS)[number];

export const DEFAULT_WA_TEMPLATE =
  "Halo, saya tertarik dengan {{item_title}} ({{item_price}}).\n{{page_url}}" as const;

export const DEFAULT_WA_SCHEDULE_TEMPLATE =
  "Halo, saya ingin mengajukan permintaan jadwal untuk {{item_title}}.\nTanggal yang diharapkan: {{preferred_date}}.\nWaktu yang diharapkan: {{preferred_time}}.\nCabang tujuan: {{branch}}.\n{{page_url}}" as const;

const ALLOWED_WA_TOKEN_SET: ReadonlySet<string> = new Set<string>(ALL_WA_TOKENS);
const SCHEDULE_WA_TOKEN_SET: ReadonlySet<string> = new Set<string>(SCHEDULE_WA_TOKENS);

export type WhatsAppErrorCode =
  | "INVALID_PHONE"
  | "INVALID_TEMPLATE"
  | "TEMPLATE_TOO_LONG"
  | "UNKNOWN_TOKEN"
  | "MISSING_TOKEN_VALUE"
  | "INVALID_PAGE_URL"
  | "INVALID_PRICE";

export class WhatsAppValidationError extends Error {
  readonly code: WhatsAppErrorCode;

  constructor(code: WhatsAppErrorCode, message: string) {
    super(message);
    this.name = "WhatsAppValidationError";
    this.code = code;
  }
}

export type PhoneValidationResult =
  | { readonly ok: true; readonly phone: string }
  | { readonly ok: false; readonly code: "INVALID_PHONE"; readonly message: string };

export type OfferingPriceInput =
  | { readonly model: "fixed"; readonly amountIdr: number; readonly negotiable?: boolean }
  | { readonly model: "from"; readonly amountIdr: number; readonly negotiable?: boolean }
  | {
      readonly model: "range";
      readonly minAmountIdr: number;
      readonly maxAmountIdr: number;
      readonly negotiable?: boolean;
    }
  | { readonly model: "on_request" };

export interface WhatsAppTemplateValues {
  readonly item_title?: string;
  readonly item_price?: string;
  readonly page_url?: string;
  readonly preferred_date?: string | null;
  readonly preferred_time?: string | null;
  readonly branch?: string | null;
}

export interface BuildWhatsAppUrlInput {
  readonly tenantPhone: string;
  readonly itemPhoneOverride?: string | null;
  readonly template?: string;
  readonly itemTitle: string;
  readonly itemPrice?: string | OfferingPriceInput;
  readonly primaryOrigin?: string;
  readonly canonicalPath?: string;
  readonly pageUrl?: string;
  readonly preferredDate?: string | null;
  readonly preferredTime?: string | null;
  readonly branch?: string | null;
}

export interface WhatsAppDispatchResult {
  readonly url: string;
  readonly phone: string;
  readonly message: string;
  readonly pageUrl: string;
}

function hasDisallowedControlChars(value: string, allowLineBreaks: boolean): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code <= 0x1f) {
      if (allowLineBreaks && (code === 0x0a || code === 0x0d || code === 0x09)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function hasBalancedParentheses(value: string): boolean {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * Normalizes an Indonesian mobile phone number (`08...`, `+628...`, or `628...`
 * with ordinary separators) into canonical E.164 digits (`628...`, 10-15 digits).
 * Does not claim that the number is registered on WhatsApp.
 */
export function normalizeIndonesianWhatsAppNumber(rawPhone: string): string {
  if (typeof rawPhone !== "string") {
    throw new WhatsAppValidationError("INVALID_PHONE", "Phone number must be a string.");
  }
  if (hasDisallowedControlChars(rawPhone, false)) {
    throw new WhatsAppValidationError(
      "INVALID_PHONE",
      "Phone number must not contain control characters or line breaks.",
    );
  }

  const trimmed = rawPhone.trim();
  if (trimmed.length === 0) {
    throw new WhatsAppValidationError("INVALID_PHONE", "Phone number is required.");
  }
  if (!/^[0-9+ ().-]+$/.test(trimmed)) {
    throw new WhatsAppValidationError(
      "INVALID_PHONE",
      "Phone number contains unsupported characters; only digits, leading +, and ordinary separators are allowed.",
    );
  }
  if (!hasBalancedParentheses(trimmed)) {
    throw new WhatsAppValidationError("INVALID_PHONE", "Phone number has unbalanced parentheses.");
  }

  const plusCount = (trimmed.match(/\+/g) ?? []).length;
  if (plusCount > 1) {
    throw new WhatsAppValidationError(
      "INVALID_PHONE",
      "Phone number must contain at most one leading '+' sign.",
    );
  }
  if (plusCount === 1 && !/^\(?\+/.test(trimmed)) {
    throw new WhatsAppValidationError(
      "INVALID_PHONE",
      "The '+' sign may only appear at the start of the phone number.",
    );
  }

  const compact = trimmed.replace(/[ ().-]/g, "");
  const hasLeadingPlus = compact.startsWith("+");
  const digits = hasLeadingPlus ? compact.slice(1) : compact;

  let normalized: string;
  if (hasLeadingPlus) {
    if (!digits.startsWith("628")) {
      throw new WhatsAppValidationError(
        "INVALID_PHONE",
        "International WhatsApp numbers must use the Indonesian mobile prefix +628.",
      );
    }
    normalized = digits;
  } else if (digits.startsWith("08")) {
    normalized = `62${digits.slice(1)}`;
  } else if (digits.startsWith("628")) {
    normalized = digits;
  } else {
    throw new WhatsAppValidationError(
      "INVALID_PHONE",
      "Phone number must start with 08, 628, or +628.",
    );
  }

  if (normalized.length < MIN_INDONESIAN_E164_DIGITS) {
    throw new WhatsAppValidationError(
      "INVALID_PHONE",
      `Indonesian mobile number is too short (minimum ${MIN_INDONESIAN_E164_DIGITS} E.164 digits).`,
    );
  }
  if (normalized.length > MAX_E164_DIGITS) {
    throw new WhatsAppValidationError(
      "INVALID_PHONE",
      `Indonesian mobile number exceeds the E.164 maximum of ${MAX_E164_DIGITS} digits.`,
    );
  }
  if (!/^628[1-9]\d{6,11}$/.test(normalized)) {
    throw new WhatsAppValidationError(
      "INVALID_PHONE",
      "Phone number is not a valid Indonesian mobile prefix (expected 6281-6289).",
    );
  }

  return normalized;
}

export function validateIndonesianWhatsAppNumber(rawPhone: string): PhoneValidationResult {
  try {
    return { ok: true, phone: normalizeIndonesianWhatsAppNumber(rawPhone) };
  } catch (error) {
    if (error instanceof WhatsAppValidationError && error.code === "INVALID_PHONE") {
      return { ok: false, code: "INVALID_PHONE", message: error.message };
    }
    throw error;
  }
}

function formatIdrAmount(amountIdr: number): string {
  if (!Number.isSafeInteger(amountIdr) || amountIdr < 0) {
    throw new WhatsAppValidationError(
      "INVALID_PRICE",
      "IDR price amount must be a non-negative safe integer.",
    );
  }
  const grouped = String(amountIdr).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `Rp ${grouped}`;
}

/**
 * Formats an offering price in localized Indonesian Rupiah per REQ-016 and PLAN section 7.3.
 * Inquiry / on-request prices never read as free.
 */
export function formatOfferingPrice(price: OfferingPriceInput): string {
  if (price.model === "on_request") {
    return ON_REQUEST_PRICE_TEXT_ID;
  }

  const negoSuffix = price.negotiable ? " (Nego)" : "";

  switch (price.model) {
    case "fixed":
      return `${formatIdrAmount(price.amountIdr)}${negoSuffix}`;
    case "from":
      return `Mulai ${formatIdrAmount(price.amountIdr)}${negoSuffix}`;
    case "range": {
      const minText = formatIdrAmount(price.minAmountIdr);
      const maxText = formatIdrAmount(price.maxAmountIdr);
      if (price.maxAmountIdr < price.minAmountIdr) {
        throw new WhatsAppValidationError(
          "INVALID_PRICE",
          "Range price maximum must not be below the minimum amount.",
        );
      }
      return `${minText} - ${maxText}${negoSuffix}`;
    }
  }
}

function assertValidHttpsOrigin(rawOrigin: string): URL {
  if (typeof rawOrigin !== "string" || hasDisallowedControlChars(rawOrigin, false)) {
    throw new WhatsAppValidationError(
      "INVALID_PAGE_URL",
      "Primary origin must be a valid HTTPS origin without control characters.",
    );
  }
  const trimmed = rawOrigin.trim();
  if (!/^https:\/\//i.test(trimmed)) {
    throw new WhatsAppValidationError("INVALID_PAGE_URL", "Primary origin must use HTTPS.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WhatsAppValidationError("INVALID_PAGE_URL", "Primary origin is malformed.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new WhatsAppValidationError(
      "INVALID_PAGE_URL",
      "Primary origin must be an HTTPS origin without credentials, path, query, or hash.",
    );
  }
  return parsed;
}

/**
 * Builds canonical `page_url` from a verified HTTPS primary origin and canonical path,
 * stripping any visitor query strings or hash fragments.
 */
export function buildCanonicalPageUrl(primaryOrigin: string, canonicalPath: string): string {
  const originUrl = assertValidHttpsOrigin(primaryOrigin);

  if (typeof canonicalPath !== "string" || hasDisallowedControlChars(canonicalPath, false)) {
    throw new WhatsAppValidationError(
      "INVALID_PAGE_URL",
      "Canonical path must be a string without control characters.",
    );
  }
  const trimmedPath = canonicalPath.trim();
  if (
    !trimmedPath.startsWith("/") ||
    trimmedPath.startsWith("//") ||
    trimmedPath.includes("\\")
  ) {
    throw new WhatsAppValidationError(
      "INVALID_PAGE_URL",
      "Canonical path must be a relative root path starting with a single '/'.",
    );
  }

  let resolved: URL;
  try {
    resolved = new URL(trimmedPath, originUrl.origin);
  } catch {
    throw new WhatsAppValidationError("INVALID_PAGE_URL", "Canonical path is malformed.");
  }
  if (resolved.origin !== originUrl.origin) {
    throw new WhatsAppValidationError(
      "INVALID_PAGE_URL",
      "Canonical path must stay within the verified primary origin.",
    );
  }
  return `${resolved.origin}${resolved.pathname}`;
}

/**
 * Canonicalizes an HTTPS page URL by stripping visitor query strings and hash fragments.
 */
export function canonicalizePageUrl(rawPageUrl: string): string {
  if (typeof rawPageUrl !== "string" || hasDisallowedControlChars(rawPageUrl, false)) {
    throw new WhatsAppValidationError(
      "INVALID_PAGE_URL",
      "Page URL must be an HTTPS URL without control characters.",
    );
  }
  const trimmed = rawPageUrl.trim();
  if (!/^https:\/\//i.test(trimmed)) {
    throw new WhatsAppValidationError("INVALID_PAGE_URL", "Page URL must use HTTPS.");
  }
  const authorityEnd = trimmed.slice(8).search(/[/?#]/);
  const authority = authorityEnd === -1 ? trimmed.slice(8) : trimmed.slice(8, 8 + authorityEnd);
  if (authority.includes("@") || authority.includes("\\")) {
    throw new WhatsAppValidationError(
      "INVALID_PAGE_URL",
      "Page URL must not contain credentials or backslashes in authority.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WhatsAppValidationError("INVALID_PAGE_URL", "Page URL is malformed.");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new WhatsAppValidationError(
      "INVALID_PAGE_URL",
      "Page URL must be an HTTPS URL without embedded credentials.",
    );
  }
  return `${parsed.origin}${parsed.pathname}`;
}

interface ScannedTemplateToken {
  readonly name: AllowedWaToken;
  readonly start: number;
  readonly end: number;
}

function scanAndValidateTemplateTokens(template: string): readonly ScannedTemplateToken[] {
  if (typeof template !== "string") {
    throw new WhatsAppValidationError("INVALID_TEMPLATE", "Template must be a string.");
  }
  if (hasDisallowedControlChars(template, true)) {
    throw new WhatsAppValidationError(
      "INVALID_TEMPLATE",
      "Template contains disallowed control characters.",
    );
  }
  if (template.trim().length === 0) {
    throw new WhatsAppValidationError("INVALID_TEMPLATE", "Template must not be empty.");
  }
  if (template.length > MAX_WA_TEMPLATE_LENGTH) {
    throw new WhatsAppValidationError(
      "TEMPLATE_TOO_LONG",
      `Template exceeds the maximum length of ${MAX_WA_TEMPLATE_LENGTH} characters.`,
    );
  }

  const tokens: ScannedTemplateToken[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const openIdx = template.indexOf("{{", cursor);
    const strayCloseIdx = template.indexOf("}}", cursor);

    if (strayCloseIdx !== -1 && (openIdx === -1 || strayCloseIdx < openIdx)) {
      throw new WhatsAppValidationError(
        "INVALID_TEMPLATE",
        "Template contains an unmatched closing '}}'.",
      );
    }

    if (openIdx === -1) {
      break;
    }

    const closeIdx = template.indexOf("}}", openIdx + 2);
    if (closeIdx === -1) {
      throw new WhatsAppValidationError(
        "INVALID_TEMPLATE",
        "Template contains an unclosed '{{' token.",
      );
    }

    const tokenName = template.slice(openIdx + 2, closeIdx);
    if (tokenName.includes("{{") || tokenName.includes("{") || tokenName.includes("}")) {
      throw new WhatsAppValidationError(
        "INVALID_TEMPLATE",
        `Template contains malformed token delimiters near '{{${tokenName}}}'.`,
      );
    }
    if (!ALLOWED_WA_TOKEN_SET.has(tokenName)) {
      throw new WhatsAppValidationError(
        "UNKNOWN_TOKEN",
        `Unknown WhatsApp template token '{{${tokenName}}}'. Allowed tokens: ${ALL_WA_TOKENS.map((t) => `{{${t}}}`).join(", ")}.`,
      );
    }

    tokens.push({
      name: tokenName as AllowedWaToken,
      start: openIdx,
      end: closeIdx + 2,
    });
    cursor = closeIdx + 2;
  }

  return tokens;
}

/**
 * Validates a WhatsApp message template without expanding it (length, delimiters,
 * control characters, and strict known-token allowlist).
 */
export function validateWhatsAppTemplate(template: string): readonly AllowedWaToken[] {
  return scanAndValidateTemplateTokens(template).map((t) => t.name);
}

function splitLineIntoSentences(line: string): readonly string[] {
  const sentences: string[] = [];
  let start = 0;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (ch === "." || ch === "!" || ch === "?") {
      let end = i + 1;
      while (end < line.length && (line[end] === "." || line[end] === "!" || line[end] === "?")) {
        end += 1;
      }
      // Split ONLY when sentence punctuation ends the line or is followed by whitespace
      // (so URLs like `https://example.com/a.html` and IDR numbers like `Rp 1.500.000` stay intact).
      if (end === line.length || line[end] === " " || line[end] === "\t") {
        const segment = line.slice(start, end).trim();
        if (segment.length > 0) {
          sentences.push(segment);
        }
        let next = end;
        while (next < line.length && (line[next] === " " || line[next] === "\t")) {
          next += 1;
        }
        start = next;
        i = next;
        continue;
      }
    }
    i += 1;
  }

  const tail = line.slice(start).trim();
  if (tail.length > 0) {
    sentences.push(tail);
  }
  return sentences;
}

function expandSegmentSinglePass(
  segment: string,
  resolvedValues: Readonly<Partial<Record<AllowedWaToken, string>>>,
): string {
  const outputParts: string[] = [];
  let cursor = 0;

  while (cursor < segment.length) {
    const openIdx = segment.indexOf("{{", cursor);
    if (openIdx === -1) {
      outputParts.push(segment.slice(cursor));
      break;
    }

    outputParts.push(segment.slice(cursor, openIdx));
    const closeIdx = segment.indexOf("}}", openIdx + 2);
    const tokenName = segment.slice(openIdx + 2, closeIdx) as AllowedWaToken;
    const replacement = resolvedValues[tokenName] ?? "";

    // Literal push: never interprets `$` sequences and never re-scans replacement text.
    outputParts.push(replacement);
    cursor = closeIdx + 2;
  }

  return outputParts.join("");
}

/**
 * Performs single-pass expansion of canonical (`{{item_title}}`, `{{item_price}}`, `{{page_url}}`)
 * and optional schedule (`{{preferred_date}}`, `{{preferred_time}}`, `{{branch}}`) tokens.
 * - Rejects templates exceeding 1000 characters.
 * - Rejects unknown `{{...}}` tokens and malformed/unclosed `{{` or `}}`.
 * - Never recursively re-expands replacement values.
 * - When an optional schedule token (`preferred_date`, `preferred_time`, `branch`) is empty/absent,
 *   drops the entire sentence containing that token cleanly (never emits dangling punctuation
 *   or literal placeholders).
 * - Preserves literal `$` sequences (`$&`, `$1`, `$$`), Unicode/emoji, and line breaks (`\n`).
 */
export function renderWhatsAppTemplate(
  template: string,
  values: WhatsAppTemplateValues,
): string {
  const tokens = scanAndValidateTemplateTokens(template);
  const resolvedValues: Partial<Record<AllowedWaToken, string>> = {};
  const emptyScheduleTokens = new Set<ScheduleWaToken>();

  for (const token of tokens) {
    const rawVal = values[token.name];

    if (SCHEDULE_WA_TOKEN_SET.has(token.name)) {
      if (rawVal === undefined || rawVal === null) {
        emptyScheduleTokens.add(token.name as ScheduleWaToken);
        continue;
      }
      if (typeof rawVal !== "string") {
        throw new WhatsAppValidationError(
          "INVALID_TEMPLATE",
          `Value for '{{${token.name}}}' must be a string.`,
        );
      }
      if (hasDisallowedControlChars(rawVal, true)) {
        throw new WhatsAppValidationError(
          "INVALID_TEMPLATE",
          `Value for '{{${token.name}}}' contains disallowed control characters.`,
        );
      }
      const trimmedVal = rawVal.trim();
      if (trimmedVal.length === 0) {
        emptyScheduleTokens.add(token.name as ScheduleWaToken);
      } else {
        resolvedValues[token.name] = trimmedVal;
      }
      continue;
    }

    if (typeof rawVal !== "string") {
      throw new WhatsAppValidationError(
        "MISSING_TOKEN_VALUE",
        `Missing value for WhatsApp template token '{{${token.name}}}'.`,
      );
    }
    if (hasDisallowedControlChars(rawVal, true)) {
      throw new WhatsAppValidationError(
        "INVALID_TEMPLATE",
        `Value for '{{${token.name}}}' contains disallowed control characters.`,
      );
    }
    resolvedValues[token.name] = rawVal;
  }

  // Fast path when no optional schedule token is empty: preserve exact template formatting verbatim.
  if (emptyScheduleTokens.size === 0) {
    return expandSegmentSinglePass(template, resolvedValues);
  }

  const lines = template.split("\n");
  const renderedLines: string[] = [];

  for (const rawLine of lines) {
    const hadContent = rawLine.trim().length > 0;
    if (!hadContent) {
      renderedLines.push("");
      continue;
    }

    const sentences = splitLineIntoSentences(rawLine);
    const keptSentences: string[] = [];

    for (const sentence of sentences) {
      const sentenceTokens = scanAndValidateTemplateTokens(sentence);
      const hasEmptyScheduleToken = sentenceTokens.some(
        (t) => SCHEDULE_WA_TOKEN_SET.has(t.name) && emptyScheduleTokens.has(t.name as ScheduleWaToken),
      );
      if (hasEmptyScheduleToken) {
        continue;
      }
      keptSentences.push(expandSegmentSinglePass(sentence, resolvedValues));
    }

    if (keptSentences.length > 0) {
      renderedLines.push(keptSentences.join(" "));
    }
  }

  // Collapse leading/trailing blank lines introduced when surrounding schedule lines were dropped.
  while (renderedLines.length > 0 && renderedLines[0] === "") {
    renderedLines.shift();
  }
  while (renderedLines.length > 0 && renderedLines[renderedLines.length - 1] === "") {
    renderedLines.pop();
  }

  return renderedLines.join("\n");
}

/**
 * Compiles a validated `https://wa.me/<digits>?text=<encoded>` click-to-chat URL.
 * Encodes the rendered message exactly once.
 */
export function buildWhatsAppUrl(input: BuildWhatsAppUrlInput): WhatsAppDispatchResult {
  const chosenPhone =
    input.itemPhoneOverride != null && input.itemPhoneOverride.trim() !== ""
      ? input.itemPhoneOverride
      : input.tenantPhone;
  const phone = normalizeIndonesianWhatsAppNumber(chosenPhone);

  let pageUrl: string;
  if (input.primaryOrigin !== undefined || input.canonicalPath !== undefined) {
    if (input.primaryOrigin === undefined || input.canonicalPath === undefined) {
      throw new WhatsAppValidationError(
        "INVALID_PAGE_URL",
        "Both primaryOrigin and canonicalPath are required when building canonical page_url.",
      );
    }
    pageUrl = buildCanonicalPageUrl(input.primaryOrigin, input.canonicalPath);
  } else if (input.pageUrl !== undefined) {
    pageUrl = canonicalizePageUrl(input.pageUrl);
  } else {
    throw new WhatsAppValidationError(
      "INVALID_PAGE_URL",
      "Provide either primaryOrigin + canonicalPath or pageUrl.",
    );
  }

  let formattedPrice: string | undefined;
  if (typeof input.itemPrice === "string") {
    formattedPrice = input.itemPrice;
  } else if (input.itemPrice !== undefined) {
    formattedPrice = formatOfferingPrice(input.itemPrice);
  }

  const template = input.template ?? DEFAULT_WA_TEMPLATE;
  const message = renderWhatsAppTemplate(template, {
    item_title: input.itemTitle,
    item_price: formattedPrice,
    page_url: pageUrl,
    preferred_date: input.preferredDate ?? null,
    preferred_time: input.preferredTime ?? null,
    branch: input.branch ?? null,
  });

  const url =
    message.length > 0
      ? `${WA_ME_ORIGIN}/${phone}?text=${encodeURIComponent(message)}`
      : `${WA_ME_ORIGIN}/${phone}`;
  return { url, phone, message, pageUrl };
}

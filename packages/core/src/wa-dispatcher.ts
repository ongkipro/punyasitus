export const WA_ME_ORIGIN = "https://wa.me" as const;
export const MIN_INDONESIAN_E164_DIGITS = 10 as const;
export const MAX_E164_DIGITS = 15 as const;
export const MAX_WA_TEMPLATE_LENGTH = 1000 as const;
export const ON_REQUEST_PRICE_TEXT_ID = "Hubungi untuk harga" as const;

export const CANONICAL_WA_TOKENS = ["item_title", "item_price", "page_url"] as const;
export type CanonicalWaToken = (typeof CANONICAL_WA_TOKENS)[number];

export const DEFAULT_WA_TEMPLATE =
  "Halo, saya tertarik dengan {{item_title}} ({{item_price}}).\n{{page_url}}" as const;

const CANONICAL_WA_TOKEN_SET: ReadonlySet<string> = new Set<string>(CANONICAL_WA_TOKENS);

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

/**
 * Performs single-pass expansion of canonical `{{item_title}}`, `{{item_price}}`, and `{{page_url}}` tokens.
 * - Rejects templates exceeding 1000 characters.
 * - Rejects unknown `{{...}}` tokens and malformed/unclosed `{{` or `}}`.
 * - Never recursively re-expands replacement values.
 * - Preserves literal `$` sequences (`$&`, `$1`, `$$`), Unicode/emoji, and line breaks (`\n`).
 */
export function renderWhatsAppTemplate(
  template: string,
  values: WhatsAppTemplateValues,
): string {
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

  const outputParts: string[] = [];
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
      outputParts.push(template.slice(cursor));
      break;
    }

    outputParts.push(template.slice(cursor, openIdx));

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
    if (!CANONICAL_WA_TOKEN_SET.has(tokenName)) {
      throw new WhatsAppValidationError(
        "UNKNOWN_TOKEN",
        `Unknown WhatsApp template token '{{${tokenName}}}'. Allowed tokens: ${CANONICAL_WA_TOKENS.map((t) => `{{${t}}}`).join(", ")}.`,
      );
    }

    const canonicalToken = tokenName as CanonicalWaToken;
    const replacement = values[canonicalToken];
    if (typeof replacement !== "string") {
      throw new WhatsAppValidationError(
        "MISSING_TOKEN_VALUE",
        `Missing value for WhatsApp template token '{{${canonicalToken}}}'.`,
      );
    }
    if (hasDisallowedControlChars(replacement, true)) {
      throw new WhatsAppValidationError(
        "INVALID_TEMPLATE",
        `Value for '{{${canonicalToken}}}' contains disallowed control characters.`,
      );
    }

    // Literal push: never interprets `$` sequences and never re-scans replacement text.
    outputParts.push(replacement);
    cursor = closeIdx + 2;
  }

  return outputParts.join("");
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
  });

  const url = `${WA_ME_ORIGIN}/${phone}?text=${encodeURIComponent(message)}`;
  return { url, phone, message, pageUrl };
}

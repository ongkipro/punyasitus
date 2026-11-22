import { validateExternalLink } from "@punyasitus/core/link-sanitizer";
import {
  buildWhatsAppUrl,
  formatOfferingPrice,
  renderWhatsAppTemplate,
  validateIndonesianWhatsAppNumber,
  WA_ME_ORIGIN,
  type OfferingPriceInput,
} from "@punyasitus/core/wa-dispatcher";

/**
 * Floating WhatsApp Widget Pure Resolution & Safety Logic
 * (REQ-014, REQ-019, REQ-040, PLAN §7.3 & §8, DESIGN.md §2.2, TASK-014).
 *
 * Invariants:
 * - Reuses TASK-010 (`@punyasitus/core/wa-dispatcher`) for Indonesian E.164
 *   validation and single-pass `wa.me` encoding (zero duplicate phone parsers).
 * - Fails closed (`null`) when phone is missing or invalid — never emits broken
 *   or unsafe `javascript:`/`#` links.
 * - Treats configured business hours strictly as static reference text and
 *   rejects fabricated live-presence claims ("Online sekarang", "Balas dalam 1 menit").
 */

export const FLOATING_WA_DEFAULTS = {
  businessName: "Tim Kami",
  buttonLabel: "WhatsApp",
  ctaLabel: "Mulai Chat di WhatsApp",
  hoursHeading: "Jam operasional",
  holidayHeading: "Hari libur",
  externalNote: "Membuka WhatsApp di tab baru",
} as const;

export const DEFAULT_FLOATING_WA_PAGE_TEMPLATE =
  "Halo {{item_title}}, saya ingin bertanya melalui halaman ini.\n{{page_url}}" as const;

export const DEFAULT_FLOATING_WA_SIMPLE_TEMPLATE =
  "Halo {{item_title}}, saya ingin bertanya mengenai layanan Anda." as const;

/**
 * Patterns representing fabricated live-presence or instant-reply claims that
 * violate REQ-019 and PLAN §8 ("never an inferred live-presence badge").
 */
const LIVE_PRESENCE_CLAIM_RE =
  /\b(?:online\s+sekarang|sedang\s+(?:online|aktif)|aktif\s+sekarang|siap\s+balas\s+sekarang|active\s+now|online\s+now|live\s+now|live\s+chat\s+online|balas\s+dalam\s+\d+\s*(?:detik|menit)|membalas\s+dalam\s+\d+\s*(?:detik|menit)|replies?\s+(?:in\s+\d+\s*(?:sec|second|min|minute)s?|instantly))\b/i;

export interface FloatingWhatsAppShellHint {
  readonly site?: {
    readonly title?: string | null;
  } | null;
  readonly business?: {
    readonly name?: string | null;
    readonly whatsappE164?: string | null;
    readonly weekdayHours?: string | null;
    readonly holidayHours?: string | null;
  } | null;
}

export interface FloatingWhatsAppProps {
  readonly enabled?: boolean;
  readonly shell?: FloatingWhatsAppShellHint | null;
  readonly phone?: string | null;
  readonly businessName?: string | null;
  readonly agentSubtitle?: string | null;
  readonly avatarUrl?: string | null;
  readonly avatarAlt?: string | null;
  readonly greetingMessage?: string | null;
  readonly showGreeting?: boolean;
  readonly operatingHours?: string | null;
  readonly holidayHours?: string | null;
  readonly messageTemplate?: string | null;
  readonly itemTitle?: string | null;
  readonly itemPrice?: string | OfferingPriceInput;
  readonly primaryOrigin?: string | null;
  readonly canonicalPath?: string | null;
  readonly pageUrl?: string | null;
  readonly buttonLabel?: string | null;
  readonly ctaLabel?: string | null;
  readonly ariaLabel?: string | null;
}

export interface ResolvedFloatingWhatsApp {
  readonly phone: string;
  readonly waUrl: string;
  readonly prefillMessage: string;
  readonly businessName: string;
  readonly initials: string;
  readonly agentSubtitle: string | null;
  readonly avatarUrl: string | null;
  readonly avatarAlt: string;
  readonly hasGreeting: boolean;
  readonly greetingMessage: string | null;
  readonly operatingHours: string | null;
  readonly holidayHours: string | null;
  readonly buttonLabel: string;
  readonly ctaLabel: string;
  readonly triggerAriaLabel: string;
}

function stripControlChars(value: string, allowNewlines = false): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x7f) continue;
    if (code <= 0x1f) {
      if (allowNewlines && code === 0x0a) {
        out += "\n";
      } else if (code === 0x09 || code === 0x0d) {
        out += " ";
      }
      continue;
    }
    out += value[i] ?? "";
  }
  return out;
}

export function sanitizePlainText(
  raw: string | null | undefined,
  maxLength: number,
  options?: { readonly allowNewlines?: boolean },
): string | null {
  if (typeof raw !== "string") return null;
  const allowNewlines = options?.allowNewlines ?? false;
  const cleaned = stripControlChars(raw, allowNewlines)
    .replace(allowNewlines ? /[^\S\n]+/g : /\s+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trimEnd();
}

export function containsLivePresenceClaim(text: string): boolean {
  return LIVE_PRESENCE_CLAIM_RE.test(text);
}

/**
 * Sanitizes configured operating hours / availability reference text and drops
 * any string implying live online presence or guaranteed reply speed.
 */
export function sanitizeOperatingHoursText(
  raw: string | null | undefined,
  maxLength = 120,
): string | null {
  const cleaned = sanitizePlainText(raw, maxLength);
  if (!cleaned) return null;
  if (containsLivePresenceClaim(cleaned)) return null;
  return cleaned;
}

/**
 * Validates an optional widget avatar URL: allows only safe site-relative
 * paths (`/assets/...`) or public HTTPS URLs validated by `validateExternalLink`.
 */
export function sanitizeAvatarUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) return null;

  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return null;
  }

  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//") || trimmed.includes("\\")) return null;
    return trimmed;
  }

  const external = validateExternalLink(trimmed);
  return external.ok ? external.link.href : null;
}

export function deriveInitials(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((part) => part.replace(/^[^A-Za-z0-9]+/, ""))
    .filter(Boolean)
    .slice(0, 2);
  const letters = parts.map((part) => part.charAt(0).toUpperCase()).join("");
  return letters || "WA";
}

function buildSafeWhatsAppHref(
  validPhone: string,
  businessName: string,
  props: FloatingWhatsAppProps,
): { readonly waUrl: string; readonly prefillMessage: string } {
  const itemTitle = sanitizePlainText(props.itemTitle, 120) ?? businessName;
  const hasOriginPair =
    typeof props.primaryOrigin === "string" &&
    props.primaryOrigin.trim() !== "" &&
    typeof props.canonicalPath === "string" &&
    props.canonicalPath.trim() !== "";
  const hasPageUrl = typeof props.pageUrl === "string" && props.pageUrl.trim() !== "";

  if (props.messageTemplate === "") {
    return { waUrl: `${WA_ME_ORIGIN}/${validPhone}`, prefillMessage: "" };
  }

  if (hasOriginPair || hasPageUrl) {
    try {
      const dispatch = buildWhatsAppUrl({
        tenantPhone: validPhone,
        template: props.messageTemplate ?? DEFAULT_FLOATING_WA_PAGE_TEMPLATE,
        itemTitle,
        itemPrice: props.itemPrice,
        primaryOrigin: hasOriginPair ? (props.primaryOrigin ?? undefined) : undefined,
        canonicalPath: hasOriginPair ? (props.canonicalPath ?? undefined) : undefined,
        pageUrl: !hasOriginPair && hasPageUrl ? (props.pageUrl ?? undefined) : undefined,
      });
      return { waUrl: dispatch.url, prefillMessage: dispatch.message };
    } catch {
      // Fall back cleanly without untrusted pageUrl or invalid custom tokens
    }
  }

  let formattedPrice: string | undefined;
  if (typeof props.itemPrice === "string") {
    formattedPrice = props.itemPrice;
  } else if (props.itemPrice !== undefined) {
    try {
      formattedPrice = formatOfferingPrice(props.itemPrice);
    } catch {
      formattedPrice = undefined;
    }
  }

  const candidateTemplate =
    typeof props.messageTemplate === "string" && props.messageTemplate.trim() !== ""
      ? props.messageTemplate
      : DEFAULT_FLOATING_WA_SIMPLE_TEMPLATE;

  let message: string;
  try {
    message = renderWhatsAppTemplate(candidateTemplate, {
      item_title: itemTitle,
      item_price: formattedPrice,
    });
  } catch {
    message = renderWhatsAppTemplate(DEFAULT_FLOATING_WA_SIMPLE_TEMPLATE, {
      item_title: businessName,
    });
  }

  return {
    waUrl: `${WA_ME_ORIGIN}/${validPhone}?text=${encodeURIComponent(message)}`,
    prefillMessage: message,
  };
}

/**
 * Resolves and validates all props for `FloatingWhatsApp.astro`.
 * Returns `null` when disabled or when the WhatsApp number is missing/invalid
 * so the component renders nothing (fail-closed).
 */
export function resolveFloatingWhatsAppConfig(
  props: FloatingWhatsAppProps,
): ResolvedFloatingWhatsApp | null {
  if (props.enabled === false) {
    return null;
  }

  const rawPhone =
    props.phone !== undefined ? props.phone : props.shell?.business?.whatsappE164;
  if (typeof rawPhone !== "string") {
    return null;
  }

  const validation = validateIndonesianWhatsAppNumber(rawPhone);
  if (!validation.ok) {
    return null;
  }

  const businessName =
    sanitizePlainText(
      props.businessName ?? props.shell?.business?.name ?? props.shell?.site?.title,
      80,
    ) ?? FLOATING_WA_DEFAULTS.businessName;

  const { waUrl, prefillMessage } = buildSafeWhatsAppHref(validation.phone, businessName, props);
  if (!waUrl.startsWith(`${WA_ME_ORIGIN}/${validation.phone}`)) {
    return null;
  }

  const greetingMessage = sanitizePlainText(props.greetingMessage, 280, { allowNewlines: true });
  const hasGreeting = props.showGreeting !== false && Boolean(greetingMessage);

  const rawOperatingHours =
    props.operatingHours !== undefined
      ? props.operatingHours
      : props.shell?.business?.weekdayHours;
  const rawHolidayHours =
    props.holidayHours !== undefined ? props.holidayHours : props.shell?.business?.holidayHours;

  const operatingHours = sanitizeOperatingHoursText(rawOperatingHours, 120);
  const holidayHours = sanitizeOperatingHoursText(rawHolidayHours, 120);
  const agentSubtitle = sanitizeOperatingHoursText(props.agentSubtitle, 60);

  const avatarUrl = sanitizeAvatarUrl(props.avatarUrl);
  const avatarAlt = sanitizePlainText(props.avatarAlt, 80) ?? businessName;
  const buttonLabel = sanitizePlainText(props.buttonLabel, 28) ?? FLOATING_WA_DEFAULTS.buttonLabel;
  const ctaLabel = sanitizePlainText(props.ctaLabel, 40) ?? FLOATING_WA_DEFAULTS.ctaLabel;
  const customAria = sanitizePlainText(props.ariaLabel, 120);
  const triggerAriaLabel =
    customAria ??
    (hasGreeting
      ? `Buka sapaan WhatsApp ${businessName}`
      : `Chat WhatsApp ${businessName}`);

  return {
    phone: validation.phone,
    waUrl,
    prefillMessage,
    businessName,
    initials: deriveInitials(businessName),
    agentSubtitle,
    avatarUrl,
    avatarAlt,
    hasGreeting,
    greetingMessage,
    operatingHours,
    holidayHours,
    buttonLabel,
    ctaLabel,
    triggerAriaLabel,
  };
}

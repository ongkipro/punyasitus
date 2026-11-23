import {
  formatPreferredDateIndonesian,
  formatPreferredTimeLabelId,
  sanitizeBranchLabelForDisplay,
} from "@punyasitus/core/leads/index";
import {
  buildWhatsAppUrl,
  DEFAULT_WA_SCHEDULE_TEMPLATE,
  renderWhatsAppTemplate,
  validateIndonesianWhatsAppNumber,
  validateWhatsAppTemplate,
  WA_ME_ORIGIN,
} from "@punyasitus/core/wa-dispatcher";

/**
 * Pure resolution helper for the public Contact Form WhatsApp Schedule Inquiry CTA
 * (`apps/web/src/themes/default/components/ScheduleInquiryCta.ts`; REQ-072, TASK-071).
 *
 * Guarantees:
 * - Server-rendered `waUrl` ALWAYS works with JavaScript disabled (empty schedule tokens
 *   drop their entire sentence cleanly; zero literal placeholders or dangling punctuation).
 * - Fails closed (`null`) when phone is missing or invalid.
 * - Rejects unknown tokens in custom templates and falls back safely to the canonical
 *   `DEFAULT_WA_SCHEDULE_TEMPLATE`.
 */

export interface PublicContactBranchOption {
  readonly id: number;
  readonly name: string;
}

export interface ScheduleInquiryCtaInput {
  readonly whatsappPhone?: string | null;
  readonly businessName?: string | null;
  readonly itemTitle?: string | null;
  readonly template?: string | null;
  readonly primaryOrigin?: string | null;
  readonly canonicalPath?: string | null;
  readonly pageUrl?: string | null;
  readonly ctaLabel?: string | null;
  readonly preferredDate?: string | null;
  readonly preferredTime?: string | null;
  readonly branchLabel?: string | null;
}

export interface ResolvedScheduleInquiryCta {
  readonly phone: string;
  readonly waUrl: string;
  readonly message: string;
  readonly template: string;
  readonly itemTitle: string;
  readonly pageUrl: string;
  readonly ctaLabel: string;
}

const DEFAULT_CTA_LABEL = "Kirim Permintaan Jadwal via WhatsApp" as const;
const DEFAULT_WA_SCHEDULE_SIMPLE_TEMPLATE =
  "Halo, saya ingin mengajukan permintaan jadwal untuk {{item_title}}.\nTanggal yang diharapkan: {{preferred_date}}.\nWaktu yang diharapkan: {{preferred_time}}.\nCabang tujuan: {{branch}}." as const;

export function sanitizeContactBranchOptions(
  rawBranches: readonly PublicContactBranchOption[] | null | undefined,
): readonly PublicContactBranchOption[] {
  if (!Array.isArray(rawBranches) || rawBranches.length === 0) return [];
  const seen = new Set<number>();
  const out: PublicContactBranchOption[] = [];
  for (const item of rawBranches) {
    if (!item || typeof item !== "object") continue;
    const id = Number(item.id);
    if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647 || seen.has(id)) {
      continue;
    }
    const cleanName = sanitizeBranchLabelForDisplay(item.name);
    if (!cleanName) continue;
    seen.add(id);
    out.push({ id, name: cleanName });
    if (out.length >= 10) break;
  }
  return out;
}

function resolveSafeTemplate(rawTemplate: string | null | undefined): string {
  if (typeof rawTemplate !== "string" || rawTemplate.trim().length === 0) {
    return DEFAULT_WA_SCHEDULE_TEMPLATE;
  }
  try {
    validateWhatsAppTemplate(rawTemplate);
    return rawTemplate;
  } catch {
    return DEFAULT_WA_SCHEDULE_TEMPLATE;
  }
}

export function resolveScheduleInquiryCtaConfig(
  input: ScheduleInquiryCtaInput,
): ResolvedScheduleInquiryCta | null {
  if (typeof input.whatsappPhone !== "string" || input.whatsappPhone.trim().length === 0) {
    return null;
  }

  const phoneCheck = validateIndonesianWhatsAppNumber(input.whatsappPhone);
  if (!phoneCheck.ok) {
    return null;
  }

  const itemTitle =
    sanitizeBranchLabelForDisplay(input.itemTitle) ??
    sanitizeBranchLabelForDisplay(input.businessName) ??
    "Konsultasi";
  const ctaLabel = sanitizeBranchLabelForDisplay(input.ctaLabel) ?? DEFAULT_CTA_LABEL;
  const template = resolveSafeTemplate(input.template);

  const formattedDate = input.preferredDate
    ? formatPreferredDateIndonesian(input.preferredDate)
    : null;
  const formattedTime = formatPreferredTimeLabelId(input.preferredTime);
  const cleanBranch = sanitizeBranchLabelForDisplay(input.branchLabel);

  const hasOriginPair =
    typeof input.primaryOrigin === "string" &&
    input.primaryOrigin.trim().length > 0 &&
    typeof input.canonicalPath === "string" &&
    input.canonicalPath.trim().length > 0;
  const hasPageUrl =
    typeof input.pageUrl === "string" && input.pageUrl.trim().length > 0;

  if (hasOriginPair || hasPageUrl) {
    try {
      const dispatch = buildWhatsAppUrl({
        tenantPhone: phoneCheck.phone,
        template,
        itemTitle,
        primaryOrigin: hasOriginPair ? (input.primaryOrigin ?? undefined) : undefined,
        canonicalPath: hasOriginPair ? (input.canonicalPath ?? undefined) : undefined,
        pageUrl: !hasOriginPair && hasPageUrl ? (input.pageUrl ?? undefined) : undefined,
        preferredDate: formattedDate,
        preferredTime: formattedTime,
        branch: cleanBranch,
      });

      return {
        phone: dispatch.phone,
        waUrl: dispatch.url,
        message: dispatch.message,
        template,
        itemTitle,
        pageUrl: dispatch.pageUrl,
        ctaLabel,
      };
    } catch {
      // Fall back to simple template without page_url when origin/pageUrl is malformed
    }
  }

  const simpleTemplate =
    typeof input.template === "string" &&
    input.template.trim().length > 0 &&
    !input.template.includes("{{page_url}}")
      ? resolveSafeTemplate(input.template)
      : DEFAULT_WA_SCHEDULE_SIMPLE_TEMPLATE;

  try {
    const message = renderWhatsAppTemplate(simpleTemplate, {
      item_title: itemTitle,
      preferred_date: formattedDate,
      preferred_time: formattedTime,
      branch: cleanBranch,
    });
    const waUrl =
      message.length > 0
        ? `${WA_ME_ORIGIN}/${phoneCheck.phone}?text=${encodeURIComponent(message)}`
        : `${WA_ME_ORIGIN}/${phoneCheck.phone}`;

    return {
      phone: phoneCheck.phone,
      waUrl,
      message,
      template: simpleTemplate,
      itemTitle,
      pageUrl: "",
      ctaLabel,
    };
  } catch {
    return null;
  }
}

import { validateIndonesianWhatsAppNumber, WA_ME_ORIGIN } from "@punyasitus/core/wa-dispatcher";

/**
 * Lead Event Normalizer, Tap-to-WhatsApp CTA Builder, and Telegram / Webhook Formatters
 * (`REQ-101`, `TASK-101`).
 */

export interface NormalizedLeadEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantHandle: string | null;
  readonly leadId: number | null;
  readonly name: string;
  readonly phoneRaw: string | null;
  readonly email: string | null;
  readonly message: string;
  readonly pagePath: string | null;
  readonly sourceCategory: string | null;
  readonly preferredDate: string | null;
  readonly preferredTime: string | null;
  readonly preferredBranch: string | null;
  readonly createdAtIso: string;
}

export interface LeadWhatsAppFollowUp {
  readonly url: string;
  readonly normalizedPhone: string;
  readonly prefilledText: string;
}

export interface TelegramInlineKeyboardButton {
  readonly text: string;
  readonly url: string;
}

export interface TelegramSendMessagePayload {
  readonly chat_id: string;
  readonly text: string;
  readonly parse_mode: "HTML";
  readonly disable_web_page_preview: true;
  readonly reply_markup?: {
    readonly inline_keyboard: readonly (readonly TelegramInlineKeyboardButton[])[];
  };
}

function readCleanString(
  obj: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  maxLen = 500,
): string | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length > 0) {
        return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed;
      }
    }
  }
  return null;
}

function readOptionalInt(
  obj: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "number" && Number.isSafeInteger(val) && val > 0) {
      return val;
    }
    if (typeof val === "string" && /^\d+$/.test(val.trim())) {
      const parsed = Number(val.trim());
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

export function escapeTelegramHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function normalizeLeadPayload(
  raw: Readonly<Record<string, unknown>>,
  meta: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly nowMs: number;
    readonly fallbackTenantName?: string;
    readonly fallbackTenantHandle?: string | null;
  },
): NormalizedLeadEvent {
  const leadId = readOptionalInt(raw, ["leadId", "lead_id", "leadNumber", "id"]);
  const name = readCleanString(raw, ["name", "visitorName", "fullName"], 120) ?? "Calon Pelanggan";
  const phoneRaw = readCleanString(raw, ["phoneE164", "phone_e164", "phone", "whatsapp"], 32);
  const email = readCleanString(raw, ["email"], 160);
  const message =
    readCleanString(raw, ["message", "inquiry", "notes"], 600) ?? "(Tidak ada pesan tambahan)";
  const pagePath = readCleanString(raw, ["pagePath", "page_path", "sourcePath", "source_path"], 200);
  const sourceCategory = readCleanString(raw, ["sourceCategory", "source_category"], 64);
  const preferredDate = readCleanString(raw, ["preferredDate", "preferred_date"], 32);
  const preferredTime = readCleanString(raw, ["preferredTime", "preferred_time"], 32);
  const preferredBranch = readCleanString(
    raw,
    ["preferredBranchLabel", "preferred_branch_label", "branchName", "branch"],
    100,
  );
  const tenantName =
    readCleanString(raw, ["tenantName", "tenant_name", "siteName"], 120) ??
    meta.fallbackTenantName ??
    "Situs Anda";
  const tenantHandle =
    readCleanString(raw, ["tenantHandle", "tenant_handle", "handle"], 80) ??
    meta.fallbackTenantHandle ??
    null;

  const rawCreatedAt = raw.createdAt ?? raw.created_at;
  let createdAtIso: string;
  if (typeof rawCreatedAt === "number" && Number.isFinite(rawCreatedAt) && rawCreatedAt > 0) {
    createdAtIso = new Date(rawCreatedAt).toISOString();
  } else if (typeof rawCreatedAt === "string" && !Number.isNaN(Date.parse(rawCreatedAt))) {
    createdAtIso = new Date(Date.parse(rawCreatedAt)).toISOString();
  } else {
    createdAtIso = new Date(meta.nowMs).toISOString();
  }

  return {
    eventId: meta.eventId,
    tenantId: meta.tenantId,
    tenantName,
    tenantHandle,
    leadId,
    name,
    phoneRaw,
    email,
    message,
    pagePath,
    sourceCategory,
    preferredDate,
    preferredTime,
    preferredBranch,
    createdAtIso,
  };
}

/**
 * Normalizes a lead phone number for a `https://wa.me/<digits>?text=...` tap-to-WhatsApp button.
 * Prefers the platform's Indonesian WhatsApp validator (`packages/core/src/wa-dispatcher.ts`),
 * with a clean E.164 international fallback (`8-15` digits), returning `null` if missing/invalid.
 */
export function normalizeLeadPhoneForWhatsApp(rawPhone: string | null | undefined): string | null {
  if (!rawPhone || typeof rawPhone !== "string") return null;
  const trimmed = rawPhone.trim();
  if (!trimmed) return null;

  const idCheck = validateIndonesianWhatsAppNumber(trimmed);
  if (idCheck.ok) {
    return idCheck.phone;
  }

  // Fallback for valid non-Indonesian international E.164 numbers (e.g. +65..., +60...)
  const compact = trimmed.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(compact)) {
    return compact.slice(1);
  }
  if (/^[1-9]\d{8,14}$/.test(compact) && !compact.startsWith("0")) {
    return compact;
  }
  return null;
}

export function buildLeadWhatsAppFollowUpUrl(
  lead: Pick<NormalizedLeadEvent, "name" | "phoneRaw" | "tenantName">,
): LeadWhatsAppFollowUp | null {
  const normalizedPhone = normalizeLeadPhoneForWhatsApp(lead.phoneRaw);
  if (!normalizedPhone) {
    return null;
  }

  const safeName = lead.name.replace(/[\r\n]+/g, " ").trim() || "Bapak/Ibu";
  const safeSite = lead.tenantName.replace(/[\r\n]+/g, " ").trim() || "kami";
  const prefilledText = `Halo ${safeName}, terima kasih telah menghubungi ${safeSite}. Pesan Anda sudah kami terima, ada yang bisa kami bantu lebih lanjut?`;
  const url = `${WA_ME_ORIGIN}/${normalizedPhone}?text=${encodeURIComponent(prefilledText)}`;

  return {
    url,
    normalizedPhone,
    prefilledText,
  };
}

/**
 * Truncates raw text safely BEFORE HTML escaping so entities like `&amp;` or `&lt;`
 * can never be sliced in half and break Telegram `parse_mode: "HTML"`.
 */
function truncateRaw(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return "…";
  return `${value.slice(0, maxChars - 1)}…`;
}

/**
 * Formats a Telegram HTML message + optional inline tap-to-WhatsApp follow-up button.
 * Safely omits `reply_markup` and displays a clean fallback line when the lead has no valid phone.
 * Truncates raw inputs BEFORE HTML escaping so Telegram HTML entities are never split.
 */
export function formatTelegramLeadMessage(
  chatId: string,
  lead: NormalizedLeadEvent,
): {
  readonly payload: TelegramSendMessagePayload;
  readonly whatsappFollowUp: LeadWhatsAppFollowUp | null;
} {
  const whatsappFollowUp = buildLeadWhatsAppFollowUpUrl(lead);
  const leadBadge = lead.leadId !== null ? ` #${lead.leadId}` : "";

  const safeTenantName = truncateRaw(lead.tenantName, 80);
  const safeName = truncateRaw(lead.name, 100);
  const safePhone = lead.phoneRaw ? truncateRaw(lead.phoneRaw, 32) : null;
  const safeEmail = lead.email ? truncateRaw(lead.email, 120) : null;
  const safeSchedule = lead.preferredDate
    ? truncateRaw(
        lead.preferredTime ? `${lead.preferredDate} (${lead.preferredTime})` : lead.preferredDate,
        64,
      )
    : null;
  const safeBranch = lead.preferredBranch ? truncateRaw(lead.preferredBranch, 80) : null;
  const safePagePath = lead.pagePath ? truncateRaw(lead.pagePath, 160) : null;

  const headerLines: string[] = [
    `<b>Prospek Baru Masuk${escapeTelegramHtml(leadBadge)}</b>`,
    `Situs: <b>${escapeTelegramHtml(safeTenantName)}</b>`,
    "",
    `Nama: ${escapeTelegramHtml(safeName)}`,
  ];

  if (whatsappFollowUp) {
    headerLines.push(`WhatsApp: +${escapeTelegramHtml(whatsappFollowUp.normalizedPhone)}`);
  } else if (safePhone) {
    headerLines.push(`Telepon: ${escapeTelegramHtml(safePhone)}`);
  } else {
    headerLines.push("WhatsApp: Tidak tersedia (hubungi lewat email atau dashboard)");
  }

  if (safeEmail) {
    headerLines.push(`Email: ${escapeTelegramHtml(safeEmail)}`);
  }
  if (safeSchedule) {
    headerLines.push(`Jadwal: ${escapeTelegramHtml(safeSchedule)}`);
  }
  if (safeBranch) {
    headerLines.push(`Cabang: ${escapeTelegramHtml(safeBranch)}`);
  }
  if (safePagePath) {
    headerLines.push(`Halaman: ${escapeTelegramHtml(safePagePath)}`);
  }

  // Reserve generous room so even worst-case 6x HTML expansion (`"` -> `&quot;`) stays <= 3900 chars
  const headerText = `${headerLines.join("\n")}\n\nPesan:\n`;
  const remainingHtmlChars = Math.max(64, 3900 - headerText.length);
  // Compute max raw prefix whose escaped representation fits cleanly within `remainingHtmlChars`
  let rawMessage = truncateRaw(lead.message, 600);
  let escapedMessage = escapeTelegramHtml(rawMessage);
  while (escapedMessage.length > remainingHtmlChars && rawMessage.length > 8) {
    const nextLen = Math.max(8, Math.floor((rawMessage.length * remainingHtmlChars) / escapedMessage.length) - 2);
    rawMessage = truncateRaw(lead.message, nextLen);
    escapedMessage = escapeTelegramHtml(rawMessage);
  }

  const payload: TelegramSendMessagePayload = {
    chat_id: chatId,
    text: `${headerText}${escapedMessage}`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(whatsappFollowUp
      ? {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Balas via WhatsApp",
                  url: whatsappFollowUp.url,
                },
              ],
            ],
          },
        }
      : {}),
  };

  return { payload, whatsappFollowUp };
}

export function buildWebhookLeadPayload(
  lead: NormalizedLeadEvent,
  deliveryId: string,
  eventName: "lead.created" | "lead.test" = "lead.created",
): Record<string, unknown> {
  const whatsappFollowUp = buildLeadWhatsAppFollowUpUrl(lead);
  return {
    event: eventName,
    deliveryId,
    eventId: lead.eventId,
    occurredAt: lead.createdAtIso,
    tenant: {
      id: lead.tenantId,
      handle: lead.tenantHandle,
      name: lead.tenantName,
    },
    lead: {
      id: lead.leadId,
      name: lead.name,
      phoneE164: whatsappFollowUp ? `+${whatsappFollowUp.normalizedPhone}` : lead.phoneRaw,
      email: lead.email,
      message: lead.message,
      pagePath: lead.pagePath,
      sourceCategory: lead.sourceCategory,
      preferredDate: lead.preferredDate,
      preferredTime: lead.preferredTime,
      preferredBranch: lead.preferredBranch,
      whatsappFollowUpUrl: whatsappFollowUp?.url ?? null,
    },
  };
}

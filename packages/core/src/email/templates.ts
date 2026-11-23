import { z } from "zod";

export const ALLOWED_EMAIL_SENDER = "noreply@notif.punyasitus.com" as const;
export const DEFAULT_EMAIL_SENDER_NAME = "PunyaSitus" as const;

export const EMAIL_TEMPLATE_NAMES = [
  "verify-email",
  "reset-password",
  "member-invitation",
  "billing-receipt",
  "domain-notice",
  "suppression-owner-notice",
  "renewal-reminder",
  "lifecycle-notice",
  "deletion-warning",
  "custom-theme-request-operator-notice",
  "gtm-kill-switch-owner-notice",
  "abuse-moderation-notice",
  "monthly-owner-performance-report",
] as const;

export type EmailTemplateName = (typeof EMAIL_TEMPLATE_NAMES)[number];

export class EmailTemplateError extends Error {
  readonly code: string;
  readonly retryable = false as const;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EmailTemplateError";
    this.code = code;
  }
}

const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes `&`, `<`, `>`, `"`, and `'` for safe interpolation into HTML text nodes and attributes.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

/**
 * Strips CR, LF, and NUL control characters from header values (Subject, sender names)
 * to prevent email header injection.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Removes NUL and unsafe non-printable control characters while preserving readable line breaks.
 */
export function sanitizePlainText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)) {
      out += value[i];
    }
  }
  return out.trim();
}

/**
 * Validates action URLs embedded in transactional emails.
 * Only `https:` URLs (or `http://localhost` / `http://127.0.0.1` for local dev/tests) are allowed.
 */
export function sanitizeActionUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new EmailTemplateError("E_INVALID_TEMPLATE_URL", "URL tindakan email tidak valid");
  }

  const isHttps = parsed.protocol === "https:";
  const isLocalHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");

  if (!isHttps && !isLocalHttp) {
    throw new EmailTemplateError(
      "E_INVALID_TEMPLATE_URL",
      `Skema URL tidak diizinkan dalam email: ${parsed.protocol}`,
    );
  }

  return parsed.toString();
}

function formatIdr(amountIdr: number): string {
  const safe = Math.max(0, Math.round(amountIdr));
  const digits = String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `Rp ${digits}`;
}

function greeting(recipientName?: string): { html: string; text: string } {
  const cleaned = recipientName ? sanitizePlainText(recipientName) : "";
  if (!cleaned) {
    return { html: "Halo,", text: "Halo," };
  }
  return {
    html: `Halo ${escapeHtml(cleaned)},`,
    text: `Halo ${cleaned},`,
  };
}

function formatCountId(value: number): string {
  const safe = Math.max(0, Math.round(value));
  return String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function wrapIndonesianHtmlEmail(params: {
  readonly title: string;
  readonly preheader: string;
  readonly bodyHtml: string;
  readonly headerBgColor?: string;
  readonly footerExtraHtml?: string;
}): string {
  const safeTitle = escapeHtml(sanitizeHeaderValue(params.title));
  const safePreheader = escapeHtml(sanitizeHeaderValue(params.preheader));
  const headerBg = params.headerBgColor ?? "#0f172a";

  return [
    "<!doctype html>",
    '<html lang="id">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${safeTitle}</title>`,
    "</head>",
    '<body style="margin:0;padding:0;background-color:#f8faf9;color:#182522;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">',
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${safePreheader}</div>`,
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f8faf9;padding:20px 10px;">',
    "<tr>",
    '<td align="center">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background-color:#ffffff;border:1px solid #d9e2dd;border-radius:12px;overflow:hidden;">',
    `<tr><td style="padding:18px 22px;border-bottom:1px solid #d9e2dd;background-color:${headerBg};color:#ffffff;font-size:16px;font-weight:700;letter-spacing:-0.01em;">PunyaSitus</td></tr>`,
    `<tr><td style="padding:22px;font-size:15px;line-height:1.6;color:#182522;">${params.bodyHtml}</td></tr>`,
    '<tr><td style="padding:16px 22px;border-top:1px solid #d9e2dd;background-color:#f8faf9;font-size:12px;line-height:1.55;color:#52635c;">',
    "Email ini dikirim secara otomatis oleh sistem notifikasi PunyaSitus (noreply@notif.punyasitus.com). Mohon jangan membalas email ini.",
    ...(params.footerExtraHtml ? [`<div style="margin-top:8px;">${params.footerExtraHtml}</div>`] : []),
    "</td></tr>",
    "</table>",
    "</td>",
    "</tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("");
}

function renderPrimaryButtonHtml(label: string, safeUrl: string): string {
  return `<p style="margin:20px 0;"><a href="${escapeHtml(safeUrl)}" style="display:inline-block;padding:12px 20px;background-color:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(label)}</a></p>`;
}

// ---------------------------------------------------------------------------
// Zod input schemas for all 6 Indonesian transactional email templates
// ---------------------------------------------------------------------------

export const VerifyEmailTemplateDataSchema = z
  .strictObject({
    recipientName: z.string().trim().max(120).optional(),
    code: z.string().trim().min(4).max(32).optional(),
    verifyUrl: z.string().trim().min(1).max(2048).optional(),
    expiresInMinutes: z.number().int().min(1).max(1440).default(10),
  })
  .refine((v) => Boolean(v.code || v.verifyUrl), {
    message: "verify-email requires at least `code` or `verifyUrl`",
  });

export const ResetPasswordTemplateDataSchema = z.strictObject({
  recipientName: z.string().trim().max(120).optional(),
  resetUrl: z.string().trim().min(1).max(2048),
  expiresInMinutes: z.number().int().min(1).max(1440).default(30),
});

export const MemberInvitationTemplateDataSchema = z.strictObject({
  recipientName: z.string().trim().max(120).optional(),
  inviterName: z.string().trim().min(1).max(120),
  organizationName: z.string().trim().min(1).max(160),
  roleLabel: z.string().trim().min(1).max(80),
  acceptUrl: z.string().trim().min(1).max(2048),
  expiresInHours: z.number().int().min(1).max(336).default(48),
});

export const BillingReceiptTemplateDataSchema = z.strictObject({
  recipientName: z.string().trim().max(120).optional(),
  tenantName: z.string().trim().min(1).max(160),
  receiptNumber: z.string().trim().min(1).max(64),
  amountIdr: z.number().int().nonnegative(),
  paidAtLabel: z.string().trim().min(1).max(80),
  periodLabel: z.string().trim().max(120).optional(),
  paymentChannel: z.string().trim().max(64).optional(),
  billingHistoryUrl: z.string().trim().min(1).max(2048).optional(),
});

export const DomainNoticeStatusSchema = z.enum([
  "verified",
  "pending_dns",
  "failed",
  "ssl_active",
  "moved",
]);

export const DomainNoticeTemplateDataSchema = z.strictObject({
  recipientName: z.string().trim().max(120).optional(),
  tenantName: z.string().trim().min(1).max(160),
  domain: z.string().trim().min(1).max(253),
  status: DomainNoticeStatusSchema,
  details: z.string().trim().max(500).optional(),
  dashboardUrl: z.string().trim().min(1).max(2048).optional(),
});

export const SuppressionNoticeReasonSchema = z.enum([
  "hard_bounce",
  "complaint",
  "manual_opt_out",
]);

export const SuppressionOwnerNoticeTemplateDataSchema = z.strictObject({
  recipientName: z.string().trim().max(120).optional(),
  tenantName: z.string().trim().min(1).max(160),
  suppressedAddressHint: z.string().trim().min(1).max(160),
  reason: SuppressionNoticeReasonSchema,
  settingsUrl: z.string().trim().min(1).max(2048).optional(),
});

export const RenewalReminderStageSchema = z.enum([
  "paid_h_minus_3",
  "paid_h_minus_1",
  "paid_h0",
  "trial_h_minus_3",
  "trial_h_minus_1",
]);

export const RenewalReminderTemplateDataSchema = z.strictObject({
  recipientName: z.string().trim().max(120).optional(),
  tenantName: z.string().trim().min(1).max(160),
  stage: RenewalReminderStageSchema,
  dueAtLabel: z.string().trim().min(1).max(100),
  graceEndsAtLabel: z.string().trim().max(100).optional(),
  amountIdr: z.number().int().nonnegative().optional(),
  oneClickPayUrl: z.string().trim().min(1).max(2048),
});

export const LifecycleNoticeStateSchema = z.enum(["grace", "locked", "suspended"]);

export const LifecycleNoticeTemplateDataSchema = z.strictObject({
  recipientName: z.string().trim().max(120).optional(),
  tenantName: z.string().trim().min(1).max(160),
  state: LifecycleNoticeStateSchema,
  deadlineLabel: z.string().trim().max(100).optional(),
  deletionDueLabel: z.string().trim().max(100).optional(),
  billingUrl: z.string().trim().min(1).max(2048),
  operatorHold: z.boolean().optional(),
});

export const DeletionWarningStageSchema = z.enum([
  "unpaid_minus_7d",
  "unpaid_minus_3d",
  "unpaid_minus_1d",
  "paid_h38",
  "paid_h42",
  "paid_h44",
]);

export const DeletionWarningTemplateDataSchema = z.strictObject({
  recipientName: z.string().trim().max(120).optional(),
  tenantName: z.string().trim().min(1).max(160),
  stage: DeletionWarningStageSchema,
  daysRemaining: z.number().int().min(1).max(7),
  deletionDueAtLabel: z.string().trim().min(1).max(100),
  billingUrl: z.string().trim().min(1).max(2048),
  leadsExportUrl: z.string().trim().min(1).max(2048).optional(),
});

export const CustomThemeRequestOperatorNoticeTemplateDataSchema = z.strictObject({
  recipientName: z.string().trim().max(120).optional(),
  requestCode: z.string().trim().min(1).max(64),
  tenantHandle: z.string().trim().min(1).max(64),
  brandName: z.string().trim().min(1).max(100),
  packageName: z.string().trim().min(1).max(120),
  contactPreference: z.enum(["whatsapp", "email", "both"]),
  consoleUrl: z.string().trim().min(1).max(2048),
});

export const GtmKillSwitchReasonCategorySchema = z.enum(["abuse", "malware", "performance"]);

export const GtmKillSwitchOwnerNoticeTemplateDataSchema = z.strictObject({
  recipientName: z.string().trim().max(120).optional(),
  tenantName: z.string().trim().min(1).max(160),
  tenantHandle: z.string().trim().min(1).max(64),
  containerId: z.string().trim().max(32).optional(),
  reasonCategory: GtmKillSwitchReasonCategorySchema,
  reason: z.string().trim().min(10).max(500),
  analyticsSettingsUrl: z.string().trim().min(1).max(2048),
});

export const AbuseModerationActionNoticeSchema = z.enum(["dismiss", "unpublish", "suspend"]);

export const AbuseModerationNoticeTemplateDataSchema = z.strictObject({
  recipientName: z.string().trim().max(120).optional(),
  tenantName: z.string().trim().min(1).max(160),
  action: AbuseModerationActionNoticeSchema,
  reportId: z.string().trim().min(1).max(64),
  reportedPath: z.string().trim().max(200).optional(),
  reason: z.string().trim().min(1).max(500),
  dashboardUrl: z.string().trim().min(1).max(2048),
});

export const MonthlyMetricDeltaTemplateSchema = z.strictObject({
  direction: z.enum(["up", "down", "flat", "new"]),
  labelId: z.string().trim().min(1).max(120),
});

export const MonthlyTopOfferingTemplateSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(200),
  visits: z.number().int().nonnegative(),
  whatsappClicks: z.number().int().nonnegative(),
  leads: z.number().int().nonnegative(),
});

export const MonthlyOwnerPerformanceReportTemplateDataSchema = z.strictObject({
  recipientName: z.string().trim().max(120).optional(),
  tenantName: z.string().trim().min(1).max(160),
  tenantHandle: z.string().trim().min(1).max(64),
  reportMonth: z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  reportMonthLabel: z.string().trim().min(1).max(64),
  comparisonMonthLabel: z.string().trim().min(1).max(64),
  visits: z.number().int().nonnegative(),
  leads: z.number().int().nonnegative(),
  whatsappClicks: z.number().int().nonnegative(),
  aiAssistantReferrals: z.number().int().nonnegative(),
  momVisits: MonthlyMetricDeltaTemplateSchema,
  momLeads: MonthlyMetricDeltaTemplateSchema,
  momWhatsappClicks: MonthlyMetricDeltaTemplateSchema,
  momAiAssistantReferrals: MonthlyMetricDeltaTemplateSchema,
  topOffering: MonthlyTopOfferingTemplateSchema.nullable().optional(),
  actionableTip: z.string().trim().min(1).max(600),
  dashboardInsightsUrl: z.string().trim().min(1).max(2048),
  notificationSettingsUrl: z.string().trim().min(1).max(2048),
});

export interface EmailTemplateDataMap {
  readonly "verify-email": z.input<typeof VerifyEmailTemplateDataSchema>;
  readonly "reset-password": z.input<typeof ResetPasswordTemplateDataSchema>;
  readonly "member-invitation": z.input<typeof MemberInvitationTemplateDataSchema>;
  readonly "billing-receipt": z.input<typeof BillingReceiptTemplateDataSchema>;
  readonly "domain-notice": z.input<typeof DomainNoticeTemplateDataSchema>;
  readonly "suppression-owner-notice": z.input<typeof SuppressionOwnerNoticeTemplateDataSchema>;
  readonly "renewal-reminder": z.input<typeof RenewalReminderTemplateDataSchema>;
  readonly "lifecycle-notice": z.input<typeof LifecycleNoticeTemplateDataSchema>;
  readonly "deletion-warning": z.input<typeof DeletionWarningTemplateDataSchema>;
  readonly "custom-theme-request-operator-notice": z.input<
    typeof CustomThemeRequestOperatorNoticeTemplateDataSchema
  >;
  readonly "gtm-kill-switch-owner-notice": z.input<
    typeof GtmKillSwitchOwnerNoticeTemplateDataSchema
  >;
  readonly "abuse-moderation-notice": z.input<typeof AbuseModerationNoticeTemplateDataSchema>;
  readonly "monthly-owner-performance-report": z.input<
    typeof MonthlyOwnerPerformanceReportTemplateDataSchema
  >;
}

export interface RenderedEmailTemplate {
  readonly template: EmailTemplateName;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const DOMAIN_STATUS_LABELS_ID: Readonly<Record<z.output<typeof DomainNoticeStatusSchema>, string>> =
  {
    verified: "Terverifikasi",
    pending_dns: "Menunggu Pengaturan DNS",
    failed: "Verifikasi Gagal",
    ssl_active: "SSL Aktif",
    moved: "Dipindahkan",
  };

const SUPPRESSION_REASON_LABELS_ID: Readonly<
  Record<z.output<typeof SuppressionNoticeReasonSchema>, string>
> = {
  hard_bounce: "alamat email menolak pesan secara permanen (hard bounce)",
  complaint: "pesan ditandai sebagai spam oleh penerima",
  manual_opt_out: "alamat email dinonaktifkan secara manual dari pengiriman notifikasi",
};

/**
 * Renders a Bahasa Indonesia transactional email template into both HTML-escaped HTML
 * and a clean plain-text alternative. Zero unescaped user input is permitted.
 */
export function renderEmailTemplate<T extends EmailTemplateName>(
  template: T,
  rawData: EmailTemplateDataMap[T],
): RenderedEmailTemplate {
  switch (template) {
    case "verify-email": {
      const data = VerifyEmailTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const safeCode = data.code ? sanitizePlainText(data.code) : null;
      const safeUrl = data.verifyUrl ? sanitizeActionUrl(data.verifyUrl) : null;
      // PLAN §17.4: verification code MUST NOT appear in the subject line.
      const subject = "Verifikasi alamat email akun PunyaSitus Anda";

      const htmlParts: string[] = [
        `<p style="margin:0 0 12px;">${greet.html}</p>`,
        `<p style="margin:0 0 16px;">Gunakan detail berikut untuk memverifikasi alamat email akun PunyaSitus Anda. Verifikasi ini berlaku selama <strong>${data.expiresInMinutes} menit</strong> dan hanya dapat digunakan satu kali.</p>`,
      ];
      const textParts: string[] = [
        greet.text,
        "",
        `Gunakan detail berikut untuk memverifikasi alamat email akun PunyaSitus Anda. Verifikasi ini berlaku selama ${data.expiresInMinutes} menit dan hanya dapat digunakan satu kali.`,
      ];

      if (safeCode) {
        htmlParts.push(
          `<div style="margin:16px 0;padding:14px 18px;background-color:#f1f5f9;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:22px;font-weight:700;letter-spacing:4px;text-align:center;color:#0f172a;">${escapeHtml(safeCode)}</div>`,
        );
        textParts.push("", `Kode verifikasi: ${safeCode}`);
      }
      if (safeUrl) {
        htmlParts.push(renderPrimaryButtonHtml("Verifikasi Email", safeUrl));
        htmlParts.push(
          `<p style="margin:0 0 12px;font-size:13px;color:#475569;word-break:break-all;">Atau salin tautan ini ke browser Anda: ${escapeHtml(safeUrl)}</p>`,
        );
        textParts.push("", `Tautan verifikasi: ${safeUrl}`);
      }

      htmlParts.push(
        '<p style="margin:16px 0 0;font-size:13px;color:#64748b;">Jika Anda tidak meminta verifikasi ini, abaikan email ini dengan aman.</p>',
      );
      textParts.push("", "Jika Anda tidak meminta verifikasi ini, abaikan email ini dengan aman.");

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader: "Selesaikan verifikasi email akun PunyaSitus Anda.",
          bodyHtml: htmlParts.join(""),
        }),
        text: textParts.join("\n"),
      };
    }

    case "reset-password": {
      const data = ResetPasswordTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const safeUrl = sanitizeActionUrl(data.resetUrl);
      const subject = "Atur ulang kata sandi akun PunyaSitus Anda";

      const bodyHtml = [
        `<p style="margin:0 0 12px;">${greet.html}</p>`,
        `<p style="margin:0 0 16px;">Kami menerima permintaan untuk mengatur ulang kata sandi akun PunyaSitus Anda. Tautan ini bersifat sekali pakai dan berlaku selama <strong>${data.expiresInMinutes} menit</strong>.</p>`,
        renderPrimaryButtonHtml("Atur Ulang Kata Sandi", safeUrl),
        `<p style="margin:0 0 12px;font-size:13px;color:#475569;word-break:break-all;">Atau salin tautan ini ke browser Anda: ${escapeHtml(safeUrl)}</p>`,
        '<p style="margin:16px 0 0;font-size:13px;color:#64748b;">Jika Anda tidak meminta pengaturan ulang kata sandi, abaikan email ini. Kata sandi Anda tidak berubah.</p>',
      ].join("");

      const text = [
        greet.text,
        "",
        `Kami menerima permintaan untuk mengatur ulang kata sandi akun PunyaSitus Anda. Tautan ini bersifat sekali pakai dan berlaku selama ${data.expiresInMinutes} menit.`,
        "",
        `Atur ulang kata sandi: ${safeUrl}`,
        "",
        "Jika Anda tidak meminta pengaturan ulang kata sandi, abaikan email ini. Kata sandi Anda tidak berubah.",
      ].join("\n");

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader: "Tautan sekali pakai untuk mengatur ulang kata sandi PunyaSitus Anda.",
          bodyHtml,
        }),
        text,
      };
    }

    case "member-invitation": {
      const data = MemberInvitationTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const inviter = sanitizePlainText(data.inviterName);
      const org = sanitizePlainText(data.organizationName);
      const role = sanitizePlainText(data.roleLabel);
      const safeUrl = sanitizeActionUrl(data.acceptUrl);
      const subject = sanitizeHeaderValue(`Undangan bergabung ke ${org} di PunyaSitus`);

      const bodyHtml = [
        `<p style="margin:0 0 12px;">${greet.html}</p>`,
        `<p style="margin:0 0 16px;"><strong>${escapeHtml(inviter)}</strong> mengundang Anda untuk bergabung ke <strong>${escapeHtml(org)}</strong> di PunyaSitus sebagai <strong>${escapeHtml(role)}</strong>.</p>`,
        renderPrimaryButtonHtml("Terima Undangan", safeUrl),
        `<p style="margin:0 0 12px;font-size:13px;color:#475569;">Undangan ini berlaku selama ${data.expiresInHours} jam.</p>`,
        `<p style="margin:0 0 12px;font-size:13px;color:#475569;word-break:break-all;">Atau salin tautan ini ke browser Anda: ${escapeHtml(safeUrl)}</p>`,
        '<p style="margin:16px 0 0;font-size:13px;color:#64748b;">Jika Anda tidak mengenal pengirim undangan ini, Anda dapat mengabaikan email ini.</p>',
      ].join("");

      const text = [
        greet.text,
        "",
        `${inviter} mengundang Anda untuk bergabung ke ${org} di PunyaSitus sebagai ${role}.`,
        "",
        `Terima undangan: ${safeUrl}`,
        `Undangan ini berlaku selama ${data.expiresInHours} jam.`,
        "",
        "Jika Anda tidak mengenal pengirim undangan ini, Anda dapat mengabaikan email ini.",
      ].join("\n");

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader: `${inviter} mengundang Anda ke ${org} di PunyaSitus.`,
          bodyHtml,
        }),
        text,
      };
    }

    case "billing-receipt": {
      const data = BillingReceiptTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const tenant = sanitizePlainText(data.tenantName);
      const receiptNo = sanitizeHeaderValue(data.receiptNumber);
      const paidAt = sanitizePlainText(data.paidAtLabel);
      const amountLabel = formatIdr(data.amountIdr);
      const period = data.periodLabel ? sanitizePlainText(data.periodLabel) : null;
      const channel = data.paymentChannel ? sanitizePlainText(data.paymentChannel) : null;
      const historyUrl = data.billingHistoryUrl ? sanitizeActionUrl(data.billingHistoryUrl) : null;
      const subject = sanitizeHeaderValue(`Kwitansi Pembayaran PunyaSitus #${receiptNo}`);

      const rowsHtml: string[] = [
        `<tr><td style="padding:6px 0;color:#64748b;">Nomor Kwitansi</td><td style="padding:6px 0;text-align:right;font-weight:600;">${escapeHtml(receiptNo)}</td></tr>`,
        `<tr><td style="padding:6px 0;color:#64748b;">Website</td><td style="padding:6px 0;text-align:right;font-weight:600;">${escapeHtml(tenant)}</td></tr>`,
        `<tr><td style="padding:6px 0;color:#64748b;">Total Dibayar</td><td style="padding:6px 0;text-align:right;font-weight:700;">${escapeHtml(amountLabel)}</td></tr>`,
        `<tr><td style="padding:6px 0;color:#64748b;">Tanggal Bayar</td><td style="padding:6px 0;text-align:right;">${escapeHtml(paidAt)}</td></tr>`,
      ];
      const textRows: string[] = [
        `Nomor Kwitansi : ${receiptNo}`,
        `Website        : ${tenant}`,
        `Total Dibayar  : ${amountLabel}`,
        `Tanggal Bayar  : ${paidAt}`,
      ];

      if (period) {
        rowsHtml.push(
          `<tr><td style="padding:6px 0;color:#64748b;">Periode</td><td style="padding:6px 0;text-align:right;">${escapeHtml(period)}</td></tr>`,
        );
        textRows.push(`Periode        : ${period}`);
      }
      if (channel) {
        rowsHtml.push(
          `<tr><td style="padding:6px 0;color:#64748b;">Metode</td><td style="padding:6px 0;text-align:right;">${escapeHtml(channel)}</td></tr>`,
        );
        textRows.push(`Metode         : ${channel}`);
      }

      const htmlParts: string[] = [
        `<p style="margin:0 0 12px;">${greet.html}</p>`,
        `<p style="margin:0 0 16px;">Terima kasih. Pembayaran untuk <strong>${escapeHtml(tenant)}</strong> telah kami terima. Kwitansi resmi dalam format PDF terlampir pada email ini.</p>`,
        `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:16px 0;padding:12px 16px;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;">${rowsHtml.join("")}</table>`,
      ];
      const textParts: string[] = [
        greet.text,
        "",
        `Terima kasih. Pembayaran untuk ${tenant} telah kami terima. Kwitansi resmi dalam format PDF terlampir pada email ini.`,
        "",
        ...textRows,
      ];

      if (historyUrl) {
        htmlParts.push(renderPrimaryButtonHtml("Lihat Riwayat Tagihan", historyUrl));
        textParts.push("", `Lihat riwayat tagihan: ${historyUrl}`);
      }

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader: `Pembayaran ${amountLabel} untuk ${tenant} berhasil dikonfirmasi.`,
          bodyHtml: htmlParts.join(""),
        }),
        text: textParts.join("\n"),
      };
    }

    case "domain-notice": {
      const data = DomainNoticeTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const tenant = sanitizePlainText(data.tenantName);
      const domain = sanitizeHeaderValue(data.domain);
      const statusLabel = DOMAIN_STATUS_LABELS_ID[data.status];
      const details = data.details ? sanitizePlainText(data.details) : null;
      const dashboardUrl = data.dashboardUrl ? sanitizeActionUrl(data.dashboardUrl) : null;
      const subject = sanitizeHeaderValue(`Pemberitahuan status domain ${domain} — PunyaSitus`);

      const htmlParts: string[] = [
        `<p style="margin:0 0 12px;">${greet.html}</p>`,
        `<p style="margin:0 0 16px;">Status domain <strong>${escapeHtml(domain)}</strong> untuk website <strong>${escapeHtml(tenant)}</strong> saat ini adalah: <strong>${escapeHtml(statusLabel)}</strong>.</p>`,
      ];
      const textParts: string[] = [
        greet.text,
        "",
        `Status domain ${domain} untuk website ${tenant} saat ini adalah: ${statusLabel}.`,
      ];

      if (details) {
        htmlParts.push(
          `<p style="margin:0 0 16px;padding:12px 16px;background-color:#f8fafc;border-left:3px solid #0f172a;font-size:14px;color:#334155;">${escapeHtml(details)}</p>`,
        );
        textParts.push("", `Detail: ${details}`);
      }
      if (dashboardUrl) {
        htmlParts.push(renderPrimaryButtonHtml("Kelola Domain", dashboardUrl));
        textParts.push("", `Kelola domain: ${dashboardUrl}`);
      }

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader: `Status domain ${domain}: ${statusLabel}.`,
          bodyHtml: htmlParts.join(""),
        }),
        text: textParts.join("\n"),
      };
    }

    case "suppression-owner-notice": {
      const data = SuppressionOwnerNoticeTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const tenant = sanitizePlainText(data.tenantName);
      const hint = sanitizePlainText(data.suppressedAddressHint);
      const reasonText = SUPPRESSION_REASON_LABELS_ID[data.reason];
      const settingsUrl = data.settingsUrl ? sanitizeActionUrl(data.settingsUrl) : null;
      const subject = "Pemberitahuan: Pengiriman email akun Anda terhenti — PunyaSitus";

      const htmlParts: string[] = [
        `<p style="margin:0 0 12px;">${greet.html}</p>`,
        `<p style="margin:0 0 16px;">Pengiriman notifikasi email untuk website <strong>${escapeHtml(tenant)}</strong> ke alamat <strong>${escapeHtml(hint)}</strong> dihentikan sementara karena ${escapeHtml(reasonText)}.</p>`,
        '<p style="margin:0 0 16px;">Akses Anda ke dashboard dan website PunyaSitus tetap berjalan normal. Namun, Anda tidak akan menerima email tagihan, kwitansi, atau peringatan keamanan sampai alamat email diperbarui.</p>',
      ];
      const textParts: string[] = [
        greet.text,
        "",
        `Pengiriman notifikasi email untuk website ${tenant} ke alamat ${hint} dihentikan sementara karena ${reasonText}.`,
        "",
        "Akses Anda ke dashboard dan website PunyaSitus tetap berjalan normal. Namun, Anda tidak akan menerima email tagihan, kwitansi, atau peringatan keamanan sampai alamat email diperbarui.",
      ];

      if (settingsUrl) {
        htmlParts.push(renderPrimaryButtonHtml("Perbarui Alamat Email", settingsUrl));
        textParts.push("", `Perbarui alamat email: ${settingsUrl}`);
      }

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader: "Alamat email notifikasi Anda masuk daftar supresi.",
          bodyHtml: htmlParts.join(""),
        }),
        text: textParts.join("\n"),
      };
    }

    case "renewal-reminder": {
      const data = RenewalReminderTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const tenant = sanitizePlainText(data.tenantName);
      const dueAt = sanitizePlainText(data.dueAtLabel);
      const graceEnds = data.graceEndsAtLabel ? sanitizePlainText(data.graceEndsAtLabel) : null;
      const amountLabel =
        typeof data.amountIdr === "number" ? formatIdr(data.amountIdr) : null;
      const safeUrl = sanitizeActionUrl(data.oneClickPayUrl);

      const stageCopy: Record<
        z.output<typeof RenewalReminderStageSchema>,
        { readonly subjectPrefix: string; readonly lead: string; readonly preheader: string }
      > = {
        paid_h_minus_3: {
          subjectPrefix: "Pengingat H-3 perpanjangan langganan",
          lead: `Langganan website <strong>${escapeHtml(tenant)}</strong> akan berakhir dalam 3 hari pada <strong>${escapeHtml(dueAt)}</strong>.`,
          preheader: `Perpanjang langganan ${tenant} sebelum ${dueAt}.`,
        },
        paid_h_minus_1: {
          subjectPrefix: "Pengingat H-1 perpanjangan langganan",
          lead: `Langganan website <strong>${escapeHtml(tenant)}</strong> akan berakhir besok pada <strong>${escapeHtml(dueAt)}</strong>.`,
          preheader: `Langganan ${tenant} berakhir besok (${dueAt}).`,
        },
        paid_h0: {
          subjectPrefix: "Jatuh tempo hari ini (H0) — perpanjangan langganan",
          lead: `Periode langganan website <strong>${escapeHtml(tenant)}</strong> jatuh tempo hari ini (<strong>${escapeHtml(dueAt)}</strong>). Anda memasuki masa tenggang 3 hari (H+1 hingga H+3).`,
          preheader: `Langganan ${tenant} jatuh tempo hari ini.`,
        },
        trial_h_minus_3: {
          subjectPrefix: "Pengingat H-3 masa uji coba gratis",
          lead: `Masa uji coba 7 hari website <strong>${escapeHtml(tenant)}</strong> akan berakhir dalam 3 hari pada <strong>${escapeHtml(dueAt)}</strong>.`,
          preheader: `Masa uji coba ${tenant} tersisa 3 hari.`,
        },
        trial_h_minus_1: {
          subjectPrefix: "Pengingat H-1 masa uji coba gratis",
          lead: `Masa uji coba 7 hari website <strong>${escapeHtml(tenant)}</strong> akan berakhir besok pada <strong>${escapeHtml(dueAt)}</strong>. Situs akan ditangguhkan otomatis jika belum diaktifkan.`,
          preheader: `Masa uji coba ${tenant} berakhir besok.`,
        },
      };

      const copy = stageCopy[data.stage];
      const subject = sanitizeHeaderValue(`${copy.subjectPrefix} ${tenant} — PunyaSitus`);
      const expiryNote = graceEnds
        ? `Tautan bayar sekali klik ini hanya berlaku satu kali hingga akhir masa tenggang (${graceEnds}) dan tidak membuka sesi admin maupun data situs lainnya.`
        : `Tautan bayar sekali klik ini hanya berlaku satu kali hingga ${dueAt} dan tidak membuka sesi admin maupun data situs lainnya.`;

      const htmlParts: string[] = [
        `<p style="margin:0 0 12px;">${greet.html}</p>`,
        `<p style="margin:0 0 16px;">${copy.lead}</p>`,
      ];
      const textParts: string[] = [
        greet.text,
        "",
        `${copy.subjectPrefix} untuk website ${tenant} (jatuh tempo: ${dueAt}).`,
      ];

      if (amountLabel) {
        htmlParts.push(
          `<p style="margin:0 0 16px;">Biaya paket dasar: <strong>${escapeHtml(amountLabel)}</strong> (belum termasuk PPN/non-PKP dan biaya kanal pembayaran).</p>`,
        );
        textParts.push(`Biaya paket dasar: ${amountLabel} (belum termasuk PPN/non-PKP).`);
      }

      htmlParts.push(renderPrimaryButtonHtml("Bayar Perpanjangan Sekarang", safeUrl));
      htmlParts.push(
        `<p style="margin:0 0 12px;font-size:13px;color:#475569;">${escapeHtml(expiryNote)}</p>`,
      );
      htmlParts.push(
        `<p style="margin:0 0 12px;font-size:13px;color:#475569;word-break:break-all;">Atau salin tautan ini ke browser Anda: ${escapeHtml(safeUrl)}</p>`,
      );
      textParts.push("", `Tautan bayar sekali klik: ${safeUrl}`, "", expiryNote);

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader: copy.preheader,
          bodyHtml: htmlParts.join(""),
        }),
        text: textParts.join("\n"),
      };
    }

    case "lifecycle-notice": {
      const data = LifecycleNoticeTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const tenant = sanitizePlainText(data.tenantName);
      const deadline = data.deadlineLabel ? sanitizePlainText(data.deadlineLabel) : null;
      const deletionDue = data.deletionDueLabel ? sanitizePlainText(data.deletionDueLabel) : null;
      const safeUrl = sanitizeActionUrl(data.billingUrl);

      let subject: string;
      let summaryHtml: string;
      let summaryText: string;
      let ctaLabel = "Buka Halaman Langganan";

      if (data.state === "grace") {
        subject = sanitizeHeaderValue(`Masa tenggang langganan ${tenant} — PunyaSitus`);
        summaryHtml = `Website <strong>${escapeHtml(tenant)}</strong> saat ini berada dalam <strong>masa tenggang (H+1 hingga H+3)</strong>. Situs publik tetap aktif dan CMS masih dapat disunting${deadline ? ` hingga <strong>${escapeHtml(deadline)}</strong>` : ""}.`;
        summaryText = `Website ${tenant} berada dalam masa tenggang (H+1..H+3). Situs publik tetap aktif dan CMS masih dapat disunting${deadline ? ` hingga ${deadline}` : ""}.`;
        ctaLabel = "Bayar Perpanjangan Sekarang";
      } else if (data.state === "locked") {
        subject = sanitizeHeaderValue(`Mode baca saja (terkunci) untuk ${tenant} — PunyaSitus`);
        summaryHtml = `Website <strong>${escapeHtml(tenant)}</strong> memasuki <strong>mode terkunci (H+4 hingga H+7)</strong>. Situs publik <strong>masih aktif dan terindeks</strong>, namun penyuntingan & publikasi CMS dinonaktifkan sementara${deadline ? ` hingga batas penangguhan pada <strong>${escapeHtml(deadline)}</strong>` : ""}. Anda tetap dapat membaca konten, mengekspor prospek CSV, dan menyelesaikan pembayaran.`;
        summaryText = `Website ${tenant} memasuki mode terkunci (H+4..H+7). Situs publik masih aktif dan terindeks, namun perubahan CMS dinonaktifkan${deadline ? ` hingga batas penangguhan pada ${deadline}` : ""}.`;
        ctaLabel = "Aktifkan Kembali Langganan";
      } else if (data.operatorHold) {
        subject = sanitizeHeaderValue(`Penahanan sementara akses ${tenant} — PunyaSitus`);
        summaryHtml = `Akses website <strong>${escapeHtml(tenant)}</strong> ditangguhkan sementara oleh operator platform. Situs publik menampilkan halaman pemeliharaan (HTTP 503). Pembayaran saja tidak mencabut penahanan operator hingga peninjauan selesai.`;
        summaryText = `Akses website ${tenant} ditangguhkan sementara oleh operator platform (HTTP 503). Pembayaran tidak mencabut penahanan operator secara otomatis.`;
      } else {
        subject = sanitizeHeaderValue(`Website ${tenant} ditangguhkan (Situs dalam perbaikan) — PunyaSitus`);
        summaryHtml = `Website <strong>${escapeHtml(tenant)}</strong> saat ini <strong>ditangguhkan</strong> dan menampilkan halaman pemeliharaan (HTTP 503). Data Anda tidak dihapus${deletionDue ? ` dan disimpan hingga <strong>${escapeHtml(deletionDue)}</strong>` : ""}. Anda tetap dapat mengekspor prospek CSV dan menyelesaikan pembayaran untuk mengaktifkan kembali situs.`;
        summaryText = `Website ${tenant} ditangguhkan (HTTP 503). Data tetap aman${deletionDue ? ` hingga ${deletionDue}` : ""}. Selesaikan pembayaran untuk mengaktifkan kembali situs.`;
        ctaLabel = "Bayar & Aktifkan Kembali";
      }

      const bodyHtml = [
        `<p style="margin:0 0 12px;">${greet.html}</p>`,
        `<p style="margin:0 0 16px;">${summaryHtml}</p>`,
        renderPrimaryButtonHtml(ctaLabel, safeUrl),
        `<p style="margin:0 0 12px;font-size:13px;color:#475569;word-break:break-all;">Tautan: ${escapeHtml(safeUrl)}</p>`,
      ].join("");

      const text = [greet.text, "", summaryText, "", `${ctaLabel}: ${safeUrl}`].join("\n");

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader: summaryText.slice(0, 140),
          bodyHtml,
        }),
        text,
      };
    }

    case "deletion-warning": {
      const data = DeletionWarningTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const tenant = sanitizePlainText(data.tenantName);
      const deletionDue = sanitizePlainText(data.deletionDueAtLabel);
      const billingUrl = sanitizeActionUrl(data.billingUrl);
      const leadsExportUrl = data.leadsExportUrl ? sanitizeActionUrl(data.leadsExportUrl) : null;
      const isPaidTrack = data.stage.startsWith("paid_");
      const milestoneTag =
        data.stage === "paid_h38"
          ? "H+38"
          : data.stage === "paid_h42"
            ? "H+42"
            : data.stage === "paid_h44"
              ? "H+44"
              : `H-${data.daysRemaining}`;

      const subject = sanitizeHeaderValue(
        `Peringatan penghapusan data (${milestoneTag}, ${data.daysRemaining} hari lagi) untuk ${tenant} — PunyaSitus`,
      );

      const trackCopy = isPaidTrack
        ? `Website <strong>${escapeHtml(tenant)}</strong> mendekati batas retensi H+45 pasca berakhirnya masa langganan.`
        : `Website <strong>${escapeHtml(tenant)}</strong> mendekati batas retensi 30 hari tanpa pembayaran aktif.`;

      const htmlParts: string[] = [
        `<p style="margin:0 0 12px;">${greet.html}</p>`,
        `<p style="margin:0 0 16px;">${trackCopy} Seluruh konten, media, pesan masuk, dan pengaturan domain kustom akan dihapus permanen dalam <strong>${data.daysRemaining} hari</strong> pada <strong>${escapeHtml(deletionDue)}</strong> apabila pembayaran belum terverifikasi.</p>`,
        '<p style="margin:0 0 16px;">Anda masih dapat mengaktifkan kembali situs sekarang tanpa kehilangan data yang tersimpan, atau mengekspor data pesan masuk (CSV) sebelum batas waktu penghapusan. Catatan tagihan dan kwitansi tetap disimpan sesuai kewajiban administrasi.</p>',
        renderPrimaryButtonHtml("Perpanjang & Simpan Data Situs", billingUrl),
      ];

      const textParts: string[] = [
        greet.text,
        "",
        `Peringatan penghapusan data (${milestoneTag}) untuk website ${tenant}.`,
        `Seluruh konten, media, pesan masuk, dan domain kustom akan dihapus permanen dalam ${data.daysRemaining} hari pada ${deletionDue} apabila pembayaran belum terverifikasi.`,
        "",
        `Perpanjang langganan sekarang: ${billingUrl}`,
      ];

      if (leadsExportUrl) {
        htmlParts.push(
          `<p style="margin:0 0 12px;font-size:13px;color:#475569;">Ekspor pesan masuk (CSV, khusus pemilik): <a href="${escapeHtml(leadsExportUrl)}" style="color:#0f172a;">${escapeHtml(leadsExportUrl)}</a></p>`,
        );
        textParts.push(`Ekspor pesan masuk (CSV, khusus pemilik): ${leadsExportUrl}`);
      }

      htmlParts.push(
        `<p style="margin:0 0 12px;font-size:13px;color:#475569;word-break:break-all;">Tautan tagihan: ${escapeHtml(billingUrl)}</p>`,
      );

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader: `Batas penghapusan data ${tenant}: ${deletionDue} (${data.daysRemaining} hari lagi).`,
          bodyHtml: htmlParts.join(""),
        }),
        text: textParts.join("\n"),
      };
    }

    case "custom-theme-request-operator-notice": {
      const data = CustomThemeRequestOperatorNoticeTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const requestCode = sanitizePlainText(data.requestCode);
      const tenantHandle = sanitizePlainText(data.tenantHandle);
      const brandName = sanitizePlainText(data.brandName);
      const packageName = sanitizePlainText(data.packageName);
      const safeConsoleUrl = sanitizeActionUrl(data.consoleUrl);

      const prefLabel =
        data.contactPreference === "whatsapp"
          ? "WhatsApp"
          : data.contactPreference === "email"
            ? "Email"
            : "WhatsApp & Email";

      const subject = sanitizeHeaderValue(
        `Permintaan tema kustom baru ${requestCode} (${tenantHandle}) — PunyaSitus`,
      );
      const preheader = `Permintaan tema kustom baru dari ${brandName} (${tenantHandle}) untuk paket ${packageName}.`;

      const bodyHtml = [
        `<p style="margin:0 0 12px;">${greet.html}</p>`,
        `<p style="margin:0 0 16px;">Terdapat permintaan <strong>Desain Tema Kustom</strong> baru yang perlu ditinjau di Console Operasional Platform.</p>`,
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="6" style="margin:0 0 16px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;">',
        `<tr><td style="color:#64748b;width:40%;">Kode Permintaan</td><td style="font-weight:600;">${escapeHtml(requestCode)}</td></tr>`,
        `<tr><td style="color:#64748b;">Handle Situs</td><td>${escapeHtml(tenantHandle)}</td></tr>`,
        `<tr><td style="color:#64748b;">Nama Brand</td><td>${escapeHtml(brandName)}</td></tr>`,
        `<tr><td style="color:#64748b;">Paket Dipilih</td><td>${escapeHtml(packageName)}</td></tr>`,
        `<tr><td style="color:#64748b;">Preferensi Kontak</td><td>${escapeHtml(prefLabel)}</td></tr>`,
        "</table>",
        renderPrimaryButtonHtml("Tinjau di Console Operasional", safeConsoleUrl),
        `<p style="margin:0 0 12px;font-size:13px;color:#475569;word-break:break-all;">Tautan console: ${escapeHtml(safeConsoleUrl)}</p>`,
      ].join("");

      const text = [
        greet.text,
        "",
        "Terdapat permintaan Desain Tema Kustom baru untuk ditinjau di Console Operasional Platform.",
        `Kode Permintaan: ${requestCode}`,
        `Handle Situs: ${tenantHandle}`,
        `Nama Brand: ${brandName}`,
        `Paket Dipilih: ${packageName}`,
        `Preferensi Kontak: ${prefLabel}`,
        "",
        `Tinjau di Console Operasional: ${safeConsoleUrl}`,
      ].join("\n");

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader,
          bodyHtml,
        }),
        text,
      };
    }

    case "gtm-kill-switch-owner-notice": {
      const data = GtmKillSwitchOwnerNoticeTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const tenantName = sanitizePlainText(data.tenantName);
      const tenantHandle = sanitizePlainText(data.tenantHandle);
      const containerId = data.containerId ? sanitizePlainText(data.containerId) : null;
      const reason = sanitizePlainText(data.reason);
      const safeSettingsUrl = sanitizeActionUrl(data.analyticsSettingsUrl);

      const categoryLabel =
        data.reasonCategory === "abuse"
          ? "Penyalahgunaan (Abuse)"
          : data.reasonCategory === "malware"
            ? "Malware / Skrip Berbahaya"
            : "Gangguan Performa Situs";

      const subject = sanitizeHeaderValue(
        `Google Tag Manager dinonaktifkan untuk ${tenantName} — PunyaSitus`,
      );
      const preheader = `Kontainer GTM pada ${tenantName} dinonaktifkan oleh operator (${categoryLabel}). Pelacak langsung tetap berjalan.`;

      const bodyHtml = [
        `<p style="margin:0 0 12px;">${greet.html}</p>`,
        `<p style="margin:0 0 16px;">Kontainer <strong>Google Tag Manager (GTM)</strong>${containerId ? ` (<code>${escapeHtml(containerId)}</code>)` : ""} pada website <strong>${escapeHtml(tenantName)}</strong> (<code>@${escapeHtml(tenantHandle)}</code>) telah dinonaktifkan sementara oleh tim operasional PunyaSitus.</p>`,
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="6" style="margin:0 0 16px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;">',
        `<tr><td style="color:#64748b;width:38%;">Kategori Alasan</td><td style="font-weight:600;">${escapeHtml(categoryLabel)}</td></tr>`,
        `<tr><td style="color:#64748b;">Catatan Operasional</td><td>${escapeHtml(reason)}</td></tr>`,
        "</table>",
        '<p style="margin:0 0 16px;">Website publik Anda tetap aktif dan <strong>pelacak langsung (GA4, Meta Pixel, TikTok Pixel)</strong> yang diatur dalam mode <em>Langsung</em> tetap berjalan normal. Periksa isi kontainer GTM Anda dan hubungi dukungan PunyaSitus jika perbaikan telah selesai.</p>',
        renderPrimaryButtonHtml("Buka Pengaturan Analitik & GTM", safeSettingsUrl),
        `<p style="margin:0 0 12px;font-size:13px;color:#475569;word-break:break-all;">Tautan pengaturan: ${escapeHtml(safeSettingsUrl)}</p>`,
      ].join("");

      const text = [
        greet.text,
        "",
        `Kontainer Google Tag Manager (GTM)${containerId ? ` (${containerId})` : ""} pada website ${tenantName} (@${tenantHandle}) telah dinonaktifkan sementara oleh tim operasional PunyaSitus.`,
        `Kategori Alasan: ${categoryLabel}`,
        `Catatan Operasional: ${reason}`,
        "",
        "Website publik Anda tetap aktif dan pelacak langsung (GA4, Meta Pixel, TikTok Pixel) yang diatur dalam mode Langsung tetap berjalan normal.",
        "",
        `Buka Pengaturan Analitik & GTM: ${safeSettingsUrl}`,
      ].join("\n");

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader,
          bodyHtml,
        }),
        text,
      };
    }

    case "abuse-moderation-notice": {
      const data = AbuseModerationNoticeTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const tenant = sanitizePlainText(data.tenantName);
      const reportId = sanitizePlainText(data.reportId);
      const reportedPath = data.reportedPath ? sanitizePlainText(data.reportedPath) : null;
      const reason = sanitizePlainText(data.reason);
      const safeDashboardUrl = sanitizeActionUrl(data.dashboardUrl);

      const actionLabel =
        data.action === "suspend"
          ? "Situs Ditangguhkan (Suspended)"
          : data.action === "unpublish"
            ? "Konten Dinonaktifkan (Unpublish)"
            : "Laporan Ditolak (Tidak Melanggar)";

      const subject = sanitizeHeaderValue(
        data.action === "suspend"
          ? `[PunyaSitus] Situs ${tenant} ditangguhkan oleh moderasi`
          : data.action === "unpublish"
            ? `[PunyaSitus] Konten situs ${tenant} dinonaktifkan oleh moderasi`
            : `[PunyaSitus] Pemberitahuan tinjauan laporan untuk ${tenant}`,
      );

      const guidance =
        data.action === "suspend"
          ? "Akses publik situs sementara dialihkan ke halaman penangguhan. Silakan tinjau alasan di bawah ini dan hubungi dukungan PunyaSitus apabila Anda memerlukan peninjauan ulang."
          : data.action === "unpublish"
            ? "Konten terkait telah dikembalikan ke status draf agar tidak tampil ke publik. Anda dapat meninjau atau memperbaikinya melalui dashboard."
            : "Laporan penyalahgunaan yang masuk untuk situs Anda telah ditinjau dan dinyatakan tidak memerlukan tindakan penghentian.";

      const bodyHtml = [
        `<p style="margin:0 0 12px;">${greet.html}</p>`,
        `<p style="margin:0 0 16px;">Tim moderasi PunyaSitus telah memproses laporan penyalahgunaan untuk situs <strong>${escapeHtml(tenant)}</strong> dengan nomor referensi <code>${escapeHtml(reportId)}</code>.</p>`,
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="6" style="margin:0 0 16px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;">',
        `<tr><td style="color:#64748b;width:36%;">Tindakan</td><td style="font-weight:600;">${escapeHtml(actionLabel)}</td></tr>`,
        ...(reportedPath
          ? [
              `<tr><td style="color:#64748b;">Halaman</td><td><code>${escapeHtml(reportedPath)}</code></td></tr>`,
            ]
          : []),
        `<tr><td style="color:#64748b;">Alasan</td><td>${escapeHtml(reason)}</td></tr>`,
        "</table>",
        `<p style="margin:0 0 16px;">${escapeHtml(guidance)}</p>`,
        renderPrimaryButtonHtml("Buka Dashboard Situs", safeDashboardUrl),
        `<p style="margin:0 0 12px;font-size:13px;color:#475569;word-break:break-all;">Tautan dashboard: ${escapeHtml(safeDashboardUrl)}</p>`,
      ].join("");

      const text = [
        greet.text,
        "",
        `Tim moderasi PunyaSitus telah memproses laporan penyalahgunaan untuk situs ${tenant} dengan nomor referensi ${reportId}.`,
        `Tindakan: ${actionLabel}`,
        ...(reportedPath ? [`Halaman terkait: ${reportedPath}`] : []),
        `Alasan: ${reason}`,
        "",
        guidance,
        `Dashboard: ${safeDashboardUrl}`,
      ].join("\n");

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader: `${actionLabel} — ${tenant} (${reportId})`,
          bodyHtml,
        }),
        text,
      };
    }

    case "monthly-owner-performance-report": {
      const data = MonthlyOwnerPerformanceReportTemplateDataSchema.parse(rawData);
      const greet = greeting(data.recipientName);
      const tenantName = sanitizePlainText(data.tenantName);
      const tenantHandle = sanitizePlainText(data.tenantHandle);
      const reportMonthLabel = sanitizePlainText(data.reportMonthLabel);
      const comparisonMonthLabel = sanitizePlainText(data.comparisonMonthLabel);
      const actionableTip = sanitizePlainText(data.actionableTip);
      const safeInsightsUrl = sanitizeActionUrl(data.dashboardInsightsUrl);
      const safeNotifSettingsUrl = sanitizeActionUrl(data.notificationSettingsUrl);

      const topOffering = data.topOffering
        ? {
            title: sanitizePlainText(data.topOffering.title),
            path: sanitizePlainText(data.topOffering.path),
            visits: data.topOffering.visits,
            whatsappClicks: data.topOffering.whatsappClicks,
            leads: data.topOffering.leads,
          }
        : null;

      const subject = sanitizeHeaderValue(
        `Laporan Performa ${reportMonthLabel} — ${tenantName} — PunyaSitus`,
      );
      const preheader = `${formatCountId(data.visits)} kunjungan, ${formatCountId(data.leads)} pesan masuk, ${formatCountId(data.whatsappClicks)} klik WhatsApp pada ${reportMonthLabel}.`;

      const deltaBadgeStyle = (dir: "up" | "down" | "flat" | "new"): string => {
        if (dir === "up" || dir === "new") {
          return "color:#176b51;background-color:#ecfdf5;border:1px solid #a7f3d0;";
        }
        if (dir === "down") {
          return "color:#b42318;background-color:#fef3f2;border:1px solid #fecdca;";
        }
        return "color:#52635c;background-color:#eef3f0;border:1px solid #d9e2dd;";
      };

      const renderMetricCell = (
        label: string,
        value: number,
        delta: { readonly direction: "up" | "down" | "flat" | "new"; readonly labelId: string },
      ): string =>
        [
          '<td width="50%" valign="top" style="padding:5px;">',
          '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #d9e2dd;border-radius:8px;background-color:#ffffff;">',
          '<tr><td style="padding:12px;">',
          `<div style="font-size:12px;color:#52635c;font-weight:600;margin-bottom:4px;">${escapeHtml(label)}</div>`,
          `<div style="font-size:24px;line-height:1.2;font-weight:700;color:#182522;margin-bottom:6px;">${escapeHtml(formatCountId(value))}</div>`,
          `<div style="display:inline-block;font-size:11px;line-height:1.35;font-weight:600;padding:2px 7px;border-radius:999px;${deltaBadgeStyle(delta.direction)}">${escapeHtml(sanitizePlainText(delta.labelId))}</div>`,
          "</td></tr>",
          "</table>",
          "</td>",
        ].join("");

      const topOfferingHtml = topOffering
        ? [
            '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:14px 0 16px;border:1px solid #d9e2dd;border-radius:8px;background-color:#f8faf9;">',
            '<tr><td style="padding:14px 16px;">',
            '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#52635c;margin-bottom:4px;">Penawaran Terpopuler</div>',
            `<div style="font-size:16px;font-weight:700;color:#182522;margin-bottom:4px;">${escapeHtml(topOffering.title)}</div>`,
            `<div style="font-size:12px;color:#52635c;margin-bottom:8px;word-break:break-word;"><code>${escapeHtml(topOffering.path)}</code></div>`,
            `<div style="font-size:13px;color:#182522;"><strong>${escapeHtml(formatCountId(topOffering.visits))}</strong> kunjungan &middot; <strong>${escapeHtml(formatCountId(topOffering.whatsappClicks))}</strong> klik WhatsApp &middot; <strong>${escapeHtml(formatCountId(topOffering.leads))}</strong> pesan masuk</div>`,
            "</td></tr>",
            "</table>",
          ].join("")
        : [
            '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:14px 0 16px;border:1px solid #d9e2dd;border-radius:8px;background-color:#f8faf9;">',
            '<tr><td style="padding:14px 16px;">',
            '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#52635c;margin-bottom:4px;">Penawaran Terpopuler</div>',
            '<div style="font-size:14px;color:#52635c;">Belum ada halaman penawaran yang mencatat kunjungan pada bulan ini.</div>',
            "</td></tr>",
            "</table>",
          ].join("");

      const tipHtml = [
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px;border:1px solid #a7f3d0;border-left:4px solid #176b51;border-radius:8px;background-color:#ecfdf5;">',
        '<tr><td style="padding:14px 16px;">',
        '<div style="font-size:12px;font-weight:700;color:#176b51;margin-bottom:4px;">1 Saran Peningkatan Bulan Depan</div>',
        `<div style="font-size:14px;line-height:1.55;color:#182522;">${escapeHtml(actionableTip)}</div>`,
        "</td></tr>",
        "</table>",
      ].join("");

      const bodyHtml = [
        `<div style="font-size:12px;font-weight:700;color:#176b51;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">Laporan Performa Bulanan</div>`,
        `<h1 style="margin:0 0 6px;font-size:20px;line-height:1.3;color:#182522;">${escapeHtml(tenantName)}</h1>`,
        `<p style="margin:0 0 16px;font-size:13px;color:#52635c;">Periode <strong>${escapeHtml(reportMonthLabel)}</strong> dibanding ${escapeHtml(comparisonMonthLabel)} &middot; <code>@${escapeHtml(tenantHandle)}</code></p>`,
        `<p style="margin:0 0 14px;">${greet.html} Berikut ringkasan performa agregat website Anda bulan lalu (tanpa data pribadi pengunjung):</p>`,
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 -5px 8px;border-collapse:separate;">',
        `<tr>${renderMetricCell("Kunjungan", data.visits, data.momVisits)}${renderMetricCell("Pesan Masuk", data.leads, data.momLeads)}</tr>`,
        `<tr>${renderMetricCell("Klik WhatsApp", data.whatsappClicks, data.momWhatsappClicks)}${renderMetricCell("Rujukan Asisten AI", data.aiAssistantReferrals, data.momAiAssistantReferrals)}</tr>`,
        "</table>",
        topOfferingHtml,
        tipHtml,
        `<p style="margin:18px 0 14px;"><a href="${escapeHtml(safeInsightsUrl)}" style="display:inline-block;padding:12px 20px;background-color:#176b51;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Buka Ringkasan Insights</a></p>`,
        '<p style="margin:0;font-size:12px;line-height:1.5;color:#52635c;">Angka di atas merupakan estimasi agregat harian tanpa pelacakan individu dan tidak memuat data pribadi pengunjung.</p>',
      ].join("");

      const footerExtraHtml = `Ingin mematikan email laporan bulanan ini? <a href="${escapeHtml(safeNotifSettingsUrl)}" style="color:#176b51;font-weight:600;text-decoration:underline;">Kelola preferensi notifikasi</a>.`;

      const text = [
        greet.text,
        "",
        `Laporan Performa Bulanan — ${tenantName} (@${tenantHandle})`,
        `Periode: ${reportMonthLabel} (dibanding ${comparisonMonthLabel})`,
        "",
        "Ringkasan Performa (estimasi agregat tanpa data pribadi pengunjung):",
        `- Kunjungan: ${formatCountId(data.visits)} (${sanitizePlainText(data.momVisits.labelId)})`,
        `- Pesan Masuk: ${formatCountId(data.leads)} (${sanitizePlainText(data.momLeads.labelId)})`,
        `- Klik WhatsApp: ${formatCountId(data.whatsappClicks)} (${sanitizePlainText(data.momWhatsappClicks.labelId)})`,
        `- Rujukan Asisten AI: ${formatCountId(data.aiAssistantReferrals)} (${sanitizePlainText(data.momAiAssistantReferrals.labelId)})`,
        "",
        topOffering
          ? `Penawaran Terpopuler: ${topOffering.title} (${topOffering.path}) — ${formatCountId(topOffering.visits)} kunjungan, ${formatCountId(topOffering.whatsappClicks)} klik WhatsApp, ${formatCountId(topOffering.leads)} pesan masuk`
          : "Penawaran Terpopuler: Belum ada halaman penawaran yang mencatat kunjungan bulan ini.",
        "",
        `1 Saran Peningkatan Bulan Depan:`,
        actionableTip,
        "",
        `Buka Ringkasan Insights: ${safeInsightsUrl}`,
        `Kelola atau matikan laporan bulanan: ${safeNotifSettingsUrl}`,
      ].join("\n");

      return {
        template,
        subject,
        html: wrapIndonesianHtmlEmail({
          title: subject,
          preheader,
          bodyHtml,
          headerBgColor: "#176b51",
          footerExtraHtml,
        }),
        text,
      };
    }
  }
}

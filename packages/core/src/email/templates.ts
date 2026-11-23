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

function wrapIndonesianHtmlEmail(params: {
  readonly title: string;
  readonly preheader: string;
  readonly bodyHtml: string;
}): string {
  const safeTitle = escapeHtml(sanitizeHeaderValue(params.title));
  const safePreheader = escapeHtml(sanitizeHeaderValue(params.preheader));

  return [
    "<!doctype html>",
    '<html lang="id">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${safeTitle}</title>`,
    "</head>",
    '<body style="margin:0;padding:0;background-color:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">',
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${safePreheader}</div>`,
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f8fafc;padding:24px 12px;">',
    "<tr>",
    '<td align="center">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">',
    '<tr><td style="padding:20px 24px;border-bottom:1px solid #e2e8f0;background-color:#0f172a;color:#ffffff;font-size:16px;font-weight:700;">PunyaSitus</td></tr>',
    `<tr><td style="padding:24px;font-size:15px;line-height:1.6;color:#0f172a;">${params.bodyHtml}</td></tr>`,
    '<tr><td style="padding:16px 24px;border-top:1px solid #e2e8f0;background-color:#f8fafc;font-size:12px;line-height:1.5;color:#64748b;">',
    "Email ini dikirim secara otomatis oleh sistem notifikasi PunyaSitus (noreply@notif.punyasitus.com). Mohon jangan membalas email ini.",
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

export interface EmailTemplateDataMap {
  readonly "verify-email": z.input<typeof VerifyEmailTemplateDataSchema>;
  readonly "reset-password": z.input<typeof ResetPasswordTemplateDataSchema>;
  readonly "member-invitation": z.input<typeof MemberInvitationTemplateDataSchema>;
  readonly "billing-receipt": z.input<typeof BillingReceiptTemplateDataSchema>;
  readonly "domain-notice": z.input<typeof DomainNoticeTemplateDataSchema>;
  readonly "suppression-owner-notice": z.input<typeof SuppressionOwnerNoticeTemplateDataSchema>;
  readonly "renewal-reminder": z.input<typeof RenewalReminderTemplateDataSchema>;
  readonly "lifecycle-notice": z.input<typeof LifecycleNoticeTemplateDataSchema>;
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
  }
}

import fs from "node:fs";
import path from "node:path";
import { createReceiptPdfBytes } from "@punyasitus/core";
import {
  ALLOWED_EMAIL_SENDER,
  EmailSenderNotVerifiedError,
  EmailTemplateError,
  assertAllowedSender,
  createCloudflareEmailAdapter,
  createLocalMailSink,
  createResendFallbackAdapter,
  encodeBytesToBase64,
  escapeHtml,
  normalizeEmailAttachment,
  renderEmailTemplate,
  resolveEmailPort,
  type CloudflareSendEmailPayload,
} from "@punyasitus/core/email/index";
import { EMAIL_CLAIMS_MIGRATION_SQL } from "@punyasitus/db/email/index";
import { describe, expect, it } from "vitest";
import { signEmailWebhookPayload } from "../../apps/web/src/pages/api/webhooks/email/bounce-handler.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-077 Transactional Email Templates, Sender Guard & Adapters (unit)", () => {
  it("renders all 6 Bahasa Indonesia templates with escaped HTML and clean plain-text parts", () => {
    const xssPayload = `<script>alert("xss")</script> & 'quoted'`;

    const verify = renderEmailTemplate("verify-email", {
      recipientName: xssPayload,
      code: "48291037",
      verifyUrl: "https://app.punyasitus.com/auth/verify?token=abc&next=/dashboard",
      expiresInMinutes: 10,
    });
    // PLAN §17.4: verification code MUST NOT appear in the subject line
    expect(verify.subject).not.toContain("48291037");
    expect(verify.subject).toContain("Verifikasi");
    expect(verify.html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;");
    expect(verify.html).not.toContain("<script>");
    expect(verify.html).toContain("48291037");
    expect(verify.text).toContain("48291037");
    expect(verify.text).toContain("10 menit");
    expect(verify.text).not.toContain("<!doctype html>");

    const reset = renderEmailTemplate("reset-password", {
      recipientName: "Budi <Admin>",
      resetUrl: "https://app.punyasitus.com/auth/reset?token=tok_123",
      expiresInMinutes: 30,
    });
    expect(reset.subject).toContain("kata sandi");
    expect(reset.html).toContain("Budi &lt;Admin&gt;");
    expect(reset.html).toContain("Atur Ulang Kata Sandi");
    expect(reset.text).toContain("https://app.punyasitus.com/auth/reset?token=tok_123");

    const invite = renderEmailTemplate("member-invitation", {
      recipientName: "Sari",
      inviterName: `Andi "Boss" <img src=x onerror=alert(1)>`,
      organizationName: "CV Maju & Sukses\r\nBcc: attacker@evil.test",
      roleLabel: "Editor",
      acceptUrl: "https://app.punyasitus.com/invite/inv_001",
      expiresInHours: 48,
    });
    expect(invite.subject).not.toMatch(/[\r\n]/);
    expect(invite.html).not.toContain("<img");
    expect(invite.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(invite.text).toContain("Editor");
    expect(invite.text).toContain("48 jam");

    const receipt = renderEmailTemplate("billing-receipt", {
      recipientName: "Owner & Co",
      tenantName: "Studio <Alpha>",
      receiptNumber: "PS-2026-000042",
      amountIdr: 150000,
      paidAtLabel: "22 November 2026",
      periodLabel: "22 Nov 2026 - 22 Des 2026",
      paymentChannel: "QRIS",
      billingHistoryUrl: "https://app.punyasitus.com/dashboard/alpha/billing",
    });
    expect(receipt.subject).toBe("Kwitansi Pembayaran PunyaSitus #PS-2026-000042");
    expect(receipt.html).toContain("Rp 150.000");
    expect(receipt.html).toContain("Studio &lt;Alpha&gt;");
    expect(receipt.text).toContain("Rp 150.000");
    expect(receipt.text).toContain("PS-2026-000042");

    const domain = renderEmailTemplate("domain-notice", {
      tenantName: "Alpha Studio",
      domain: "alpha-studio.id",
      status: "ssl_active",
      details: "Sertifikat SSL aktif & siap digunakan <ok>.",
      dashboardUrl: "https://app.punyasitus.com/dashboard/alpha/domains",
    });
    expect(domain.subject).toContain("alpha-studio.id");
    expect(domain.html).toContain("SSL Aktif");
    expect(domain.html).toContain("&lt;ok&gt;");
    expect(domain.text).toContain("SSL Aktif");

    const suppression = renderEmailTemplate("suppression-owner-notice", {
      tenantName: "Beta Klinik",
      suppressedAddressHint: "ow***@example.com",
      reason: "hard_bounce",
      settingsUrl: "https://app.punyasitus.com/account",
    });
    expect(suppression.subject).toContain("Pengiriman email akun Anda terhenti");
    expect(suppression.html).toContain("hard bounce");
    expect(suppression.html).toContain("tetap berjalan normal");
    expect(suppression.text).toContain("ow***@example.com");
  });

  it("rejects unsafe action URLs (javascript:, data:) and escapes all 5 HTML metacharacters", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");

    expect(() =>
      renderEmailTemplate("reset-password", {
        resetUrl: "javascript:alert(1)",
      }),
    ).toThrow(EmailTemplateError);

    expect(() =>
      renderEmailTemplate("verify-email", {
        verifyUrl: "data:text/html,<script>alert(1)</script>",
      }),
    ).toThrow(EmailTemplateError);
  });

  it("strictly enforces allowed sender noreply@notif.punyasitus.com with E_SENDER_NOT_VERIFIED", async () => {
    expect(assertAllowedSender()).toBe(ALLOWED_EMAIL_SENDER);
    expect(assertAllowedSender("noreply@notif.punyasitus.com")).toBe(ALLOWED_EMAIL_SENDER);
    expect(assertAllowedSender("PunyaSitus <NOREPLY@NOTIF.PUNYASITUS.COM>")).toBe(
      ALLOWED_EMAIL_SENDER,
    );

    for (const badSender of [
      "admin@punyasitus.com",
      "noreply@punyasitus.com",
      "spoof@evil.example",
      "noreply@notif.punyasitus.com\r\nBcc: leak@evil.example",
    ]) {
      expect(() => assertAllowedSender(badSender)).toThrow(EmailSenderNotVerifiedError);
    }

    let bindingCalled = false;
    const cfAdapter = createCloudflareEmailAdapter({
      async send() {
        bindingCalled = true;
      },
    });
    const cfRes = await cfAdapter.send({
      messageKey: "msg-bad-sender-1",
      template: "verify-email",
      from: "spoof@evil.example",
      to: "user@example.com",
      subject: "Test",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    expect(bindingCalled).toBe(false);
    expect(cfRes).toEqual({
      outcome: "failed",
      provider: "cloudflare",
      errorCode: "E_SENDER_NOT_VERIFIED",
      retryable: false,
      suppressed: false,
    });
  });

  it("encodes PDF receipt attachments as Base64 strings for Cloudflare Email Service and Resend", async () => {
    const pdfBytes = await createReceiptPdfBytes({
      receiptNumber: "PS-2026-000099",
      tenantName: "Alpha Studio Fixture",
      amountIdr: 250000,
    });
    const expectedBase64 = encodeBytesToBase64(pdfBytes);
    expect(Buffer.from(expectedBase64, "base64").subarray(0, 5).toString("ascii")).toBe("%PDF-");

    const normalized = normalizeEmailAttachment({
      filename: "kwitansi-PS-2026-000099.pdf",
      contentType: "application/pdf",
      content: pdfBytes,
    });
    expect(normalized.contentType).toBe("application/pdf");
    expect(normalized.content).toBe(expectedBase64);
    expect(normalized.disposition).toBe("attachment");

    const sentPayloads: CloudflareSendEmailPayload[] = [];
    const cfAdapter = createCloudflareEmailAdapter({
      async send(msg) {
        sentPayloads.push(msg);
        return { messageId: "cf-msg-001" };
      },
    });

    const rendered = renderEmailTemplate("billing-receipt", {
      tenantName: "Alpha Studio Fixture",
      receiptNumber: "PS-2026-000099",
      amountIdr: 250000,
      paidAtLabel: "22 November 2026",
    });

    const sendRes = await cfAdapter.send({
      messageKey: "receipt:PS-2026-000099",
      template: "billing-receipt",
      to: "owner@example.com",
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments: [
        {
          filename: "kwitansi-PS-2026-000099.pdf",
          contentType: "application/pdf",
          content: pdfBytes,
        },
      ],
    });

    expect(sendRes).toEqual({
      outcome: "submitted",
      provider: "cloudflare",
      providerMessageId: "cf-msg-001",
    });
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]?.from).toBe(ALLOWED_EMAIL_SENDER);
    expect(sentPayloads[0]?.attachments).toEqual([
      {
        disposition: "attachment",
        filename: "kwitansi-PS-2026-000099.pdf",
        type: "application/pdf",
        content: expectedBase64,
      },
    ]);
  });

  it("classifies Cloudflare Email Service errors accurately (suppressed vs rate-limit vs unknown timeout)", async () => {
    const suppressedAdapter = createCloudflareEmailAdapter({
      async send() {
        const err = Object.assign(new Error("E_RECIPIENT_SUPPRESSED: mailbox suppressed"), {
          code: "E_RECIPIENT_SUPPRESSED",
        });
        throw err;
      },
    });
    expect(
      await suppressedAdapter.send({
        messageKey: "k1",
        template: "verify-email",
        to: "bounced@example.com",
        subject: "S",
        html: "<p>a</p>",
        text: "a",
      }),
    ).toEqual({
      outcome: "failed",
      provider: "cloudflare",
      errorCode: "E_RECIPIENT_SUPPRESSED",
      retryable: false,
      suppressed: true,
    });

    const rateLimitAdapter = createCloudflareEmailAdapter({
      async send() {
        const err = Object.assign(new Error("E_RATE_LIMITED: retry later"), {
          code: "E_RATE_LIMITED",
          retryAfterSeconds: 15,
        });
        throw err;
      },
    });
    expect(
      await rateLimitAdapter.send({
        messageKey: "k2",
        template: "verify-email",
        to: "ok@example.com",
        subject: "S",
        html: "<p>a</p>",
        text: "a",
      }),
    ).toEqual({
      outcome: "failed",
      provider: "cloudflare",
      errorCode: "E_RATE_LIMITED",
      retryable: true,
      suppressed: false,
      retryAfterSeconds: 15,
    });

    const timeoutAdapter = createCloudflareEmailAdapter({
      async send() {
        const err = new Error("Upstream connection timed out after 10000ms");
        err.name = "TimeoutError";
        throw err;
      },
    });
    expect(
      await timeoutAdapter.send({
        messageKey: "k3",
        template: "verify-email",
        to: "ok@example.com",
        subject: "S",
        html: "<p>a</p>",
        text: "a",
      }),
    ).toEqual({
      outcome: "unknown",
      provider: "cloudflare",
      errorCode: "TIMEOUT_ERROR",
    });
  });

  it("supports Resend HTTP fallback adapter and local mail sink", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const resend = createResendFallbackAdapter({
      apiKey: "re_test_synthetic_key_123456",
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json({ id: "re_msg_001" }, { status: 200 });
      },
    });

    const resendResult = await resend.send({
      messageKey: "fallback-001",
      template: "reset-password",
      to: "user@example.com",
      subject: "Atur ulang kata sandi",
      html: "<p>Reset</p>",
      text: "Reset",
      attachments: [
        {
          filename: "doc.pdf",
          contentType: "application/pdf",
          content: new Uint8Array([37, 80, 68, 70]),
        },
      ],
    });
    expect(resendResult).toEqual({
      outcome: "submitted",
      provider: "resend",
      providerMessageId: "re_msg_001",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    const parsedBody = JSON.parse(String(calls[0]?.init?.body)) as {
      from: string;
      to: string[];
      attachments: Array<{ filename: string; content: string; content_type: string }>;
    };
    expect(parsedBody.from).toBe(ALLOWED_EMAIL_SENDER);
    expect(parsedBody.to).toEqual(["user@example.com"]);
    expect(parsedBody.attachments[0]?.content_type).toBe("application/pdf");
    expect(parsedBody.attachments[0]?.content).toBe(encodeBytesToBase64(new Uint8Array([37, 80, 68, 70])));

    const sink = createLocalMailSink({ now: () => 1_763_820_000_000 });
    const port = resolveEmailPort({ preferredProvider: "local-sink", localSink: sink });
    expect(port?.provider).toBe("local-sink");

    await port?.send({
      messageKey: "sink-verify-1",
      template: "verify-email",
      to: "User@Example.com",
      subject: "Verifikasi",
      html: "<p>Kode 12345678</p>",
      text: "Kode 12345678",
    });
    expect(sink.list()).toHaveLength(1);
    expect(sink.findByTemplate("verify-email")).toHaveLength(1);
    expect(sink.findByRecipient("user@example.com")).toHaveLength(1);
    expect(sink.findByMessageKey("sink-verify-1")?.from).toBe(ALLOWED_EMAIL_SENDER);
  });

  it("keeps 0002_email_delivery_claims.sql, wrangler.jsonc, webhook signing, and docs/operations/email.md aligned", async () => {
    const sqlDisk = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/platform/0002_email_delivery_claims.sql"),
      "utf8",
    );
    expect(sqlDisk).toBe(EMAIL_CLAIMS_MIGRATION_SQL);

    const wranglerText = fs.readFileSync(path.join(ROOT, "apps/web/wrangler.jsonc"), "utf8");
    expect(wranglerText).toContain('"name": "EMAIL"');
    expect(wranglerText).toContain('"allowed_sender_addresses": ["noreply@notif.punyasitus.com"]');

    const runbook = fs.readFileSync(path.join(ROOT, "docs/operations/email.md"), "utf8");
    expect(runbook).toContain("notif.punyasitus.com");
    expect(runbook).toContain("SPF");
    expect(runbook).toContain("DKIM");
    expect(runbook).toContain("DMARC");
    expect(runbook).toContain("noreply@notif.punyasitus.com");
    expect(runbook).toContain("Resend");
    expect(runbook).toContain("Staging Send Evidence");

    const sig = await signEmailWebhookPayload({
      secret: "whsec_test_secret",
      timestampSeconds: 1763820000,
      rawBody: '{"eventId":"evt_1"}',
    });
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});

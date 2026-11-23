import {
  BillingConflictError,
  redactBillingLogRecord,
} from "@punyasitus/core/billing/index";
import {
  computeSha256Hex,
  formatReceiptIdr,
  formatWibDate,
  formatWibDateTime,
  generateReceiptPdf,
  type ReceiptPdfInput,
} from "@punyasitus/core/billing/receipt-pdf";
import {
  ALLOWED_EMAIL_SENDER,
  DEFAULT_EMAIL_SENDER_NAME,
  createCloudflareEmailAdapter,
  encodeBytesToBase64,
  escapeHtml,
  renderEmailTemplate,
  sanitizeHeaderValue,
  sanitizePlainText,
  type CloudflareSendEmailBinding,
  type EmailPort,
} from "@punyasitus/core/email/index";
import { NonRetryableJobError, type JobEnvelopeInput } from "@punyasitus/core/jobs/index";
import {
  allocateAndInsertPaymentReceipt,
  loadRefundCreditNoteSourceContext,
  loadSettlementReceiptSourceContext,
  markPaymentReceiptEmailed,
  type PaymentReceiptRecord,
} from "@punyasitus/db/billing/receipts/index";
import { getEmailSuppression } from "@punyasitus/db/email/index";
import { enqueueDurableJob, releaseUnstartedQueuedJob } from "@punyasitus/db/jobs/index";
import type { DurableJobHandler, JobExecutionContext, StructuredJobLogger } from "../consumer.ts";

/**
 * Immutable R2 PDF persistence and `EmailPort` delivery worker for numbered payment
 * receipts and linked credit notes (REQ-081, REQ-077; PLAN §16.1, §19.3; TASK-081).
 *
 * Hard invariants:
 * - `storeReceiptPdfImmutably` verifies `sha256(pdfBytes) === expectedSha256Hex` BEFORE
 *   any R2 write and uses atomic conditional `put(..., { onlyIf: { etagDoesNotMatch: "*" } })`
 *   so concurrent workers can NEVER overwrite an issued PDF.
 * - Transactional emails use `EmailPort` (Cloudflare Email Service `env.EMAIL.send()` primary
 *   per DEC-038), Base64-encoded PDF attachment, zero secrets/raw payment payloads, and an
 *   idempotent `messageKey`.
 * - Inside `createBillingReceiptDeliveryHandler`, transient `failed` / `unknown` email
 *   outcomes throw `ReceiptDeliveryRetryableError` so the durable queue retries cleanly
 *   while leaving `emailed_at IS NULL` and the issued receipt + R2 PDF intact; permanent
 *   suppression or `already_emailed` completes cleanly without retrying.
 */

export const BILLING_RECEIPT_DELIVER_TOPIC = "billing.receipt.deliver" as const;
export const BILLING_RECEIPT_DELIVERY_TOPIC = BILLING_RECEIPT_DELIVER_TOPIC;

export class ReceiptDeliveryRetryableError extends Error {
  readonly code: string;
  readonly retryable = true as const;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReceiptDeliveryRetryableError";
    this.code = code;
  }
}

export type ReceiptEmailDeliveryOutcome =
  | "submitted"
  | "already_emailed"
  | "skipped"
  | "failed"
  | "unknown";

export interface StoreReceiptPdfImmutablyResult {
  readonly stored: boolean;
  readonly alreadyExists: boolean;
  readonly sha256Hex: string;
  readonly byteLength: number;
}

/**
 * Verifies `sha256(pdfBytes) === expectedSha256Hex` BEFORE writing, then persists
 * receipt/credit-note PDF bytes immutably in R2 using an atomic conditional put
 * (`onlyIf: { etagDoesNotMatch: "*" }`) so concurrent workers NEVER overwrite an issued PDF.
 */
export async function storeReceiptPdfImmutably(
  bucket: R2Bucket,
  params: {
    readonly objectKey: string;
    readonly receiptNumber: string;
    readonly documentKind: "receipt" | "credit_note";
    readonly pdfBytes: Uint8Array;
    readonly expectedSha256Hex: string;
  },
): Promise<StoreReceiptPdfImmutablyResult> {
  // 1. Verify caller-supplied bytes BEFORE attempting any R2 write
  const actualSha256 = await computeSha256Hex(params.pdfBytes);
  if (actualSha256 !== params.expectedSha256Hex) {
    throw new BillingConflictError(
      "CONFLICT",
      "RECEIPT_R2_INTEGRITY_MISMATCH",
      `Hash integritas SHA-256 berkas PDF kuitansi "${params.receiptNumber}" tidak cocok sebelum disimpan ke R2.`,
    );
  }

  // 2. Atomic conditional put — succeeds ONLY when object key does not exist yet
  const putResult = await bucket.put(params.objectKey, params.pdfBytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/pdf",
      contentDisposition: `attachment; filename="${params.receiptNumber}.pdf"`,
      cacheControl: "private, no-store",
    },
    customMetadata: {
      sha256: params.expectedSha256Hex,
      receiptNumber: params.receiptNumber,
      documentKind: params.documentKind,
    },
  });

  if (putResult !== null) {
    return {
      stored: true,
      alreadyExists: false,
      sha256Hex: actualSha256,
      byteLength: params.pdfBytes.byteLength,
    };
  }

  // 3. Conditional put declined because object already exists — read & verify SHA-256 matches
  const existing = await bucket.get(params.objectKey);
  if (!existing) {
    throw new BillingConflictError(
      "CONFLICT",
      "RECEIPT_R2_INTEGRITY_MISMATCH",
      `Objek PDF kuitansi "${params.receiptNumber}" tidak ditemukan setelah conditional put ditolak.`,
    );
  }

  const existingBytes = new Uint8Array(await existing.arrayBuffer());
  const existingSha = await computeSha256Hex(existingBytes);
  if (existingSha !== params.expectedSha256Hex) {
    throw new BillingConflictError(
      "CONFLICT",
      "RECEIPT_R2_INTEGRITY_MISMATCH",
      `Objek PDF kuitansi "${params.receiptNumber}" di R2 tidak cocok dengan hash integritas yang tercatat.`,
    );
  }

  return {
    stored: false,
    alreadyExists: true,
    sha256Hex: existingSha,
    byteLength: existingBytes.byteLength,
  };
}

/**
 * Loads and SHA-256-verifies an immutable receipt PDF from R2 for authorized downloads.
 */
export async function loadVerifiedReceiptPdfFromR2(
  bucket: R2Bucket,
  receipt: Pick<PaymentReceiptRecord, "r2ObjectKey" | "pdfSha256" | "receiptNumber">,
): Promise<Uint8Array | null> {
  const obj = await bucket.get(receipt.r2ObjectKey);
  if (!obj) {
    return null;
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const actualSha = await computeSha256Hex(bytes);
  if (actualSha !== receipt.pdfSha256) {
    throw new BillingConflictError(
      "CONFLICT",
      "RECEIPT_R2_INTEGRITY_MISMATCH",
      `Hash integritas PDF kuitansi "${receipt.receiptNumber}" tidak cocok.`,
    );
  }
  return bytes;
}

export interface ReceiptDeliveryQueueBinding {
  send(message: unknown): Promise<unknown>;
}

/**
 * Enqueues a deduplicated durable `billing.receipt.deliver` job into `job_ledger`
 * and optionally `JOBS_QUEUE` (for deferred/retried receipt or credit-note delivery).
 */
export async function enqueueBillingReceiptDelivery(
  env: {
    readonly PLATFORM_DB: D1Database;
    readonly JOBS_QUEUE?: ReceiptDeliveryQueueBinding | null;
  },
  input: {
    readonly settlementId?: string | null;
    readonly refundId?: string | null;
    readonly tenantId: string;
    readonly correlationId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{
  readonly enqueued: boolean;
  readonly idempotencyKey: string;
  readonly topic: typeof BILLING_RECEIPT_DELIVER_TOPIC;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const settlementId = input.settlementId?.trim() || null;
  const refundId = input.refundId?.trim() || null;
  if (!settlementId && !refundId) {
    throw new RangeError("INVALID_RECEIPT_DELIVERY_TARGET: settlementId or refundId is required");
  }

  const key = settlementId
    ? `billing-receipt-deliver:settlement:${settlementId}`
    : `billing-receipt-deliver:refund:${refundId}`;

  const payload: Record<string, unknown> = settlementId
    ? { settlementId }
    : { refundId };

  const ledgerRes = await enqueueDurableJob(env.PLATFORM_DB, {
    idempotencyKey: key,
    topic: BILLING_RECEIPT_DELIVER_TOPIC,
    tenantId: input.tenantId,
    payload,
    nowMs,
  });

  if (!ledgerRes.enqueued) {
    return {
      enqueued: false,
      idempotencyKey: key,
      topic: BILLING_RECEIPT_DELIVER_TOPIC,
    };
  }

  if (env.JOBS_QUEUE) {
    const envelope: JobEnvelopeInput = {
      idempotencyKey: key,
      topic: BILLING_RECEIPT_DELIVER_TOPIC,
      tenantId: input.tenantId,
      payload,
      correlationId: input.correlationId ?? key,
      enqueuedAt: nowMs,
    };
    try {
      await env.JOBS_QUEUE.send(envelope);
    } catch (err) {
      await releaseUnstartedQueuedJob(env.PLATFORM_DB, key);
      throw err;
    }
  }

  return {
    enqueued: true,
    idempotencyKey: key,
    topic: BILLING_RECEIPT_DELIVER_TOPIC,
  };
}

function resolveReceiptEmailPort(options: {
  readonly emailPort?: EmailPort | null;
  readonly cloudflareEmailBinding?: CloudflareSendEmailBinding | null;
}): EmailPort | null {
  if (options.emailPort !== undefined) {
    return options.emailPort;
  }
  if (options.cloudflareEmailBinding) {
    return createCloudflareEmailAdapter(options.cloudflareEmailBinding);
  }
  return null;
}

function renderCreditNoteEmailContent(params: {
  readonly recipientName?: string;
  readonly tenantName: string;
  readonly creditNoteNumber: string;
  readonly linkedReceiptNumber: string | null;
  readonly amountIdr: number;
  readonly issuedAtLabel: string;
  readonly nonPkpNotice: string;
  readonly billingHistoryUrl?: string;
}): { readonly subject: string; readonly html: string; readonly text: string } {
  const safeTenant = sanitizePlainText(params.tenantName);
  const safeNumber = sanitizeHeaderValue(params.creditNoteNumber);
  const safeLinked = params.linkedReceiptNumber
    ? sanitizeHeaderValue(params.linkedReceiptNumber)
    : null;
  const safeIssued = sanitizePlainText(params.issuedAtLabel);
  const safeNotice = sanitizePlainText(params.nonPkpNotice);
  const amountLabel = formatReceiptIdr(params.amountIdr);
  const greetingName = params.recipientName ? sanitizePlainText(params.recipientName) : "";
  const greetText = greetingName ? `Halo ${greetingName},` : "Halo,";
  const greetHtml = greetingName ? `Halo ${escapeHtml(greetingName)},` : "Halo,";

  const subject = sanitizeHeaderValue(`Nota Kredit Pengembalian Dana PunyaSitus #${safeNumber}`);

  const rowsHtml = [
    `<tr><td style="padding:6px 0;color:#64748b;">Nomor Nota Kredit</td><td style="padding:6px 0;text-align:right;font-weight:600;">${escapeHtml(safeNumber)}</td></tr>`,
    ...(safeLinked
      ? [
          `<tr><td style="padding:6px 0;color:#64748b;">Referensi Kuitansi Asli</td><td style="padding:6px 0;text-align:right;font-weight:600;">${escapeHtml(safeLinked)}</td></tr>`,
        ]
      : []),
    `<tr><td style="padding:6px 0;color:#64748b;">Website</td><td style="padding:6px 0;text-align:right;font-weight:600;">${escapeHtml(safeTenant)}</td></tr>`,
    `<tr><td style="padding:6px 0;color:#64748b;">Total Dikreditkan</td><td style="padding:6px 0;text-align:right;font-weight:700;">${escapeHtml(amountLabel)}</td></tr>`,
    `<tr><td style="padding:6px 0;color:#64748b;">Tanggal Terbit</td><td style="padding:6px 0;text-align:right;">${escapeHtml(safeIssued)}</td></tr>`,
  ].join("");

  const historyLinkHtml = params.billingHistoryUrl
    ? `<p style="margin:20px 0;"><a href="${escapeHtml(params.billingHistoryUrl)}" style="display:inline-block;padding:12px 20px;background-color:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Lihat Riwayat Tagihan</a></p>`
    : "";

  const html = [
    "<!doctype html>",
    '<html lang="id"><head><meta charset="utf-8"><title>',
    escapeHtml(subject),
    '</title></head><body style="margin:0;padding:24px;background-color:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">',
    '<div style="padding:18px 24px;background:#991b1b;color:#ffffff;font-weight:700;font-size:16px;">PunyaSitus — Nota Kredit</div>',
    `<div style="padding:24px;font-size:15px;line-height:1.6;">`,
    `<p style="margin:0 0 12px;">${greetHtml}</p>`,
    `<p style="margin:0 0 16px;">Nota kredit pengembalian dana untuk <strong>${escapeHtml(safeTenant)}</strong> telah diterbitkan tanpa mengubah kuitansi pembayaran asli. Dokumen PDF terlampir pada email ini.</p>`,
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:16px 0;padding:12px 16px;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;">${rowsHtml}</table>`,
    `<p style="margin:12px 0;font-size:12px;color:#475569;">${escapeHtml(safeNotice)}</p>`,
    historyLinkHtml,
    "</div></div></body></html>",
  ].join("");

  const textLines = [
    greetText,
    "",
    `Nota kredit pengembalian dana untuk ${safeTenant} telah diterbitkan tanpa mengubah kuitansi pembayaran asli. Dokumen PDF terlampir pada email ini.`,
    "",
    `Nomor Nota Kredit       : ${safeNumber}`,
    ...(safeLinked ? [`Referensi Kuitansi Asli : ${safeLinked}`] : []),
    `Website                 : ${safeTenant}`,
    `Total Dikreditkan       : ${amountLabel}`,
    `Tanggal Terbit          : ${safeIssued}`,
    "",
    safeNotice,
    ...(params.billingHistoryUrl ? ["", `Lihat riwayat tagihan: ${params.billingHistoryUrl}`] : []),
  ];

  return {
    subject,
    html,
    text: textLines.join("\n"),
  };
}

interface InternalEmailDeliveryResult {
  readonly emailOutcome: ReceiptEmailDeliveryOutcome;
  readonly emailedAtMs: number | null;
  readonly emailErrorCode: string | null;
  readonly emailRetryable: boolean;
}

async function deliverReceiptEmailIfNeeded(params: {
  readonly db: D1Database;
  readonly receipt: PaymentReceiptRecord;
  readonly pdfBytes: Uint8Array;
  readonly payerEmail: string | null;
  readonly payerName: string;
  readonly tenantName: string;
  readonly tenantHandle: string;
  readonly linkedReceiptNumber: string | null;
  readonly emailPort: EmailPort | null;
  readonly platformDomain: string;
  readonly nowMs: number;
  readonly suppressionSalt?: string;
  readonly logger?: StructuredJobLogger;
}): Promise<InternalEmailDeliveryResult> {
  if (params.receipt.emailedAtMs !== null) {
    return {
      emailOutcome: "already_emailed",
      emailedAtMs: params.receipt.emailedAtMs,
      emailErrorCode: null,
      emailRetryable: false,
    };
  }
  if (!params.emailPort || !params.payerEmail) {
    return {
      emailOutcome: "skipped",
      emailedAtMs: null,
      emailErrorCode: null,
      emailRetryable: false,
    };
  }

  // Respect email suppression list before sending (REQ-077)
  try {
    const suppressed = await getEmailSuppression(params.db, params.payerEmail, {
      salt: params.suppressionSalt,
    });
    if (suppressed) {
      params.logger?.(
        redactBillingLogRecord({
          event: "billing.receipt.email_suppressed",
          receiptId: params.receipt.id,
          receiptNumber: params.receipt.receiptNumber,
          tenantId: params.receipt.tenantId,
          timestamp: params.nowMs,
        }),
      );
      return {
        emailOutcome: "skipped",
        emailedAtMs: null,
        emailErrorCode: "E_RECIPIENT_SUPPRESSED",
        emailRetryable: false,
      };
    }
  } catch {
    // Suppression lookup failure must not abort receipt issuance
  }

  const appOrigin = `https://app.${params.platformDomain}`;
  const billingHistoryUrl = params.receipt.agencyId
    ? `${appOrigin}/agency`
    : `${appOrigin}/dashboard/${encodeURIComponent(params.tenantHandle)}/billing`;

  const periodLabel =
    params.receipt.periodStartMs !== null && params.receipt.periodEndMs !== null
      ? `${formatWibDate(params.receipt.periodStartMs)} - ${formatWibDate(params.receipt.periodEndMs)} (WIB)`
      : undefined;

  const rendered =
    params.receipt.documentKind === "credit_note"
      ? renderCreditNoteEmailContent({
          recipientName: params.payerName,
          tenantName: params.tenantName,
          creditNoteNumber: params.receipt.receiptNumber,
          linkedReceiptNumber: params.linkedReceiptNumber,
          amountIdr: params.receipt.totalAmountIdr,
          issuedAtLabel: formatWibDateTime(params.receipt.issuedAtMs),
          nonPkpNotice: params.receipt.nonPkpNotice,
          billingHistoryUrl,
        })
      : renderEmailTemplate("billing-receipt", {
          recipientName: params.payerName,
          tenantName: params.tenantName,
          receiptNumber: params.receipt.receiptNumber,
          amountIdr: params.receipt.totalAmountIdr,
          paidAtLabel: formatWibDateTime(params.receipt.issuedAtMs),
          ...(periodLabel ? { periodLabel } : {}),
          paymentChannel: params.receipt.paymentChannel,
          billingHistoryUrl,
        });

  const messageKey =
    params.receipt.documentKind === "credit_note"
      ? `billing-credit-note:${params.receipt.id}`
      : `billing-receipt:${params.receipt.id}`;

  const sendResult = await params.emailPort.send({
    messageKey,
    template: "billing-receipt",
    from: ALLOWED_EMAIL_SENDER,
    fromName: DEFAULT_EMAIL_SENDER_NAME,
    to: params.payerEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    attachments: [
      {
        filename: `${params.receipt.receiptNumber}.pdf`,
        contentType: "application/pdf",
        content: encodeBytesToBase64(params.pdfBytes),
        disposition: "attachment",
      },
    ],
    oneShot: true,
    tenantId: params.receipt.tenantId,
  });

  if (sendResult.outcome === "submitted") {
    await markPaymentReceiptEmailed(params.db, params.receipt.id, params.nowMs);
    params.logger?.(
      redactBillingLogRecord({
        event: "billing.receipt.emailed",
        receiptId: params.receipt.id,
        receiptNumber: params.receipt.receiptNumber,
        documentKind: params.receipt.documentKind,
        tenantId: params.receipt.tenantId,
        provider: sendResult.provider,
        timestamp: params.nowMs,
      }),
    );
    return {
      emailOutcome: "submitted",
      emailedAtMs: params.nowMs,
      emailErrorCode: null,
      emailRetryable: false,
    };
  }

  if (sendResult.outcome === "failed" && sendResult.suppressed) {
    params.logger?.(
      redactBillingLogRecord({
        event: "billing.receipt.email_suppressed",
        receiptId: params.receipt.id,
        receiptNumber: params.receipt.receiptNumber,
        documentKind: params.receipt.documentKind,
        tenantId: params.receipt.tenantId,
        errorCode: sendResult.errorCode,
        timestamp: params.nowMs,
      }),
    );
    return {
      emailOutcome: "skipped",
      emailedAtMs: null,
      emailErrorCode: sendResult.errorCode,
      emailRetryable: false,
    };
  }

  params.logger?.(
    redactBillingLogRecord({
      event: "billing.receipt.email_not_submitted",
      receiptId: params.receipt.id,
      receiptNumber: params.receipt.receiptNumber,
      documentKind: params.receipt.documentKind,
      tenantId: params.receipt.tenantId,
      outcome: sendResult.outcome,
      errorCode: sendResult.errorCode,
      timestamp: params.nowMs,
    }),
  );

  if (sendResult.outcome === "unknown") {
    return {
      emailOutcome: "unknown",
      emailedAtMs: null,
      emailErrorCode: sendResult.errorCode,
      emailRetryable: true,
    };
  }

  return {
    emailOutcome: "failed",
    emailedAtMs: null,
    emailErrorCode: sendResult.errorCode,
    emailRetryable: sendResult.retryable,
  };
}

export interface IssueSettlementReceiptParams {
  readonly db: D1Database;
  readonly mediaBucket: R2Bucket;
  readonly settlementId: string;
  readonly emailPort?: EmailPort | null;
  readonly cloudflareEmailBinding?: CloudflareSendEmailBinding | null;
  readonly platformDomain?: string;
  readonly suppressionSalt?: string;
  readonly nowMs?: number;
  readonly logger?: StructuredJobLogger;
}

export interface IssueReceiptDeliveryResult {
  readonly created: boolean;
  readonly receipt: PaymentReceiptRecord;
  readonly r2Stored: boolean;
  readonly emailOutcome: ReceiptEmailDeliveryOutcome;
  readonly emailErrorCode?: string | null;
  readonly emailRetryable?: boolean;
  readonly pdfBytes: Uint8Array;
}

/**
 * Issues a gap-free numbered PDF receipt for a confirmed settlement, stores it immutably
 * in R2 under `platform/receipts/{year}/{receiptNumber}.pdf`, and emails it via `EmailPort`.
 *
 * Fully idempotent on `settlementId`: re-running returns the exact same receipt without
 * incrementing `receipt_yearly_counters`, without overwriting R2, and without double-emailing.
 */
export async function issueAndDeliverSettlementReceipt(
  params: IssueSettlementReceiptParams,
): Promise<IssueReceiptDeliveryResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const platformDomain = params.platformDomain?.trim() || "punyasitus.com";
  const ctx = await loadSettlementReceiptSourceContext(params.db, params.settlementId);

  const buildPdfInput = (receiptNumber: string): ReceiptPdfInput => ({
    documentKind: "receipt",
    receiptNumber,
    issuedAtMs: ctx.settledAtMs,
    payerKind: ctx.payerKind,
    payerName: ctx.payerName,
    payerEmail: ctx.payerEmail,
    tenantName: ctx.tenantName,
    tenantHandle: ctx.tenantHandle,
    obligationId: ctx.obligationId,
    settlementId: ctx.settlementId,
    planCode: ctx.planCode,
    periodStartMs: ctx.periodStartMs,
    periodEndMs: ctx.periodEndMs,
    baseAmountIdr: ctx.baseAmountIdr,
    discountAmountIdr: ctx.discountAmountIdr,
    channelFeeIdr: ctx.channelFeeIdr,
    totalAmountIdr: ctx.totalAmountIdr,
    couponCode: ctx.couponCode,
    paymentChannel: ctx.paymentChannel,
    providerReference: ctx.providerReference,
  });

  const allocated = await allocateAndInsertPaymentReceipt(params.db, {
    documentKind: "receipt",
    tenantId: ctx.tenantId,
    agencyId: ctx.agencyId,
    obligationId: ctx.obligationId,
    settlementId: ctx.settlementId,
    refundId: null,
    linkedReceiptId: null,
    payerUserId: ctx.payerUserId,
    baseAmountIdr: ctx.baseAmountIdr,
    discountAmountIdr: ctx.discountAmountIdr,
    channelFeeIdr: ctx.channelFeeIdr,
    totalAmountIdr: ctx.totalAmountIdr,
    planCode: ctx.planCode,
    periodStartMs: ctx.periodStartMs,
    periodEndMs: ctx.periodEndMs,
    paymentChannel: ctx.paymentChannel,
    providerReference: ctx.providerReference,
    issuedAtMs: ctx.settledAtMs,
    nowMs,
    buildPdf: async (receiptNumber) => generateReceiptPdf(buildPdfInput(receiptNumber)),
  });

  let pdfBytes = allocated.pdfBytes;
  if (!pdfBytes) {
    const existingR2 = await loadVerifiedReceiptPdfFromR2(params.mediaBucket, allocated.receipt);
    if (existingR2) {
      pdfBytes = existingR2;
    } else {
      const regenerated = await generateReceiptPdf(buildPdfInput(allocated.receipt.receiptNumber));
      pdfBytes = regenerated.bytes;
    }
  }

  const r2Result = await storeReceiptPdfImmutably(params.mediaBucket, {
    objectKey: allocated.receipt.r2ObjectKey,
    receiptNumber: allocated.receipt.receiptNumber,
    documentKind: "receipt",
    pdfBytes,
    expectedSha256Hex: allocated.receipt.pdfSha256,
  });

  const emailPort = resolveReceiptEmailPort({
    emailPort: params.emailPort,
    cloudflareEmailBinding: params.cloudflareEmailBinding,
  });

  const emailRes = await deliverReceiptEmailIfNeeded({
    db: params.db,
    receipt: allocated.receipt,
    pdfBytes,
    payerEmail: ctx.payerEmail,
    payerName: ctx.payerName,
    tenantName: ctx.tenantName,
    tenantHandle: ctx.tenantHandle,
    linkedReceiptNumber: null,
    emailPort,
    platformDomain,
    nowMs,
    suppressionSalt: params.suppressionSalt,
    logger: params.logger,
  });

  const updatedReceipt: PaymentReceiptRecord =
    emailRes.emailedAtMs !== null
      ? {
          ...allocated.receipt,
          emailedAtMs: emailRes.emailedAtMs,
          emailedAtIso: new Date(emailRes.emailedAtMs).toISOString(),
        }
      : allocated.receipt;

  return {
    created: allocated.created,
    receipt: updatedReceipt,
    r2Stored: r2Result.stored,
    emailOutcome: emailRes.emailOutcome,
    emailErrorCode: emailRes.emailErrorCode,
    emailRetryable: emailRes.emailRetryable,
    pdfBytes,
  };
}

export interface IssueRefundCreditNoteParams {
  readonly db: D1Database;
  readonly mediaBucket: R2Bucket;
  readonly refundId: string;
  readonly emailPort?: EmailPort | null;
  readonly cloudflareEmailBinding?: CloudflareSendEmailBinding | null;
  readonly platformDomain?: string;
  readonly suppressionSalt?: string;
  readonly nowMs?: number;
  readonly logger?: StructuredJobLogger;
}

export interface IssueCreditNoteDeliveryResult extends IssueReceiptDeliveryResult {
  readonly linkedReceiptId: string | null;
  readonly linkedReceiptNumber: string | null;
}

/**
 * Issues a separate linked credit note (`document_kind = 'credit_note'`) for an audited
 * manual refund without EVER altering the original receipt row or R2 PDF bytes.
 */
export async function issueAndDeliverRefundCreditNote(
  params: IssueRefundCreditNoteParams,
): Promise<IssueCreditNoteDeliveryResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const platformDomain = params.platformDomain?.trim() || "punyasitus.com";
  const ctx = await loadRefundCreditNoteSourceContext(params.db, params.refundId);

  const buildPdfInput = (receiptNumber: string): ReceiptPdfInput => ({
    documentKind: "credit_note",
    receiptNumber,
    issuedAtMs: ctx.refundedAtMs,
    payerKind: ctx.payerKind,
    payerName: ctx.payerName,
    payerEmail: ctx.payerEmail,
    tenantName: ctx.tenantName,
    tenantHandle: ctx.tenantHandle,
    obligationId: ctx.obligationId,
    refundId: ctx.refundId,
    linkedReceiptNumber: ctx.linkedReceiptNumber,
    creditNoteReason: ctx.reason,
    planCode: ctx.planCode,
    periodStartMs: ctx.periodStartMs,
    periodEndMs: ctx.periodEndMs,
    baseAmountIdr: ctx.baseAmountIdr,
    discountAmountIdr: ctx.discountAmountIdr,
    channelFeeIdr: ctx.channelFeeIdr,
    totalAmountIdr: ctx.totalAmountIdr,
    paymentChannel: ctx.paymentChannel,
    providerReference: ctx.providerReference,
  });

  const allocated = await allocateAndInsertPaymentReceipt(params.db, {
    documentKind: "credit_note",
    tenantId: ctx.tenantId,
    agencyId: ctx.agencyId,
    obligationId: ctx.obligationId,
    settlementId: null,
    refundId: ctx.refundId,
    linkedReceiptId: ctx.linkedReceiptId,
    payerUserId: ctx.payerUserId,
    baseAmountIdr: ctx.baseAmountIdr,
    discountAmountIdr: ctx.discountAmountIdr,
    channelFeeIdr: ctx.channelFeeIdr,
    totalAmountIdr: ctx.totalAmountIdr,
    planCode: ctx.planCode,
    periodStartMs: ctx.periodStartMs,
    periodEndMs: ctx.periodEndMs,
    paymentChannel: ctx.paymentChannel,
    providerReference: ctx.providerReference,
    issuedAtMs: ctx.refundedAtMs,
    nowMs,
    buildPdf: async (receiptNumber) => generateReceiptPdf(buildPdfInput(receiptNumber)),
  });

  let pdfBytes = allocated.pdfBytes;
  if (!pdfBytes) {
    const existingR2 = await loadVerifiedReceiptPdfFromR2(params.mediaBucket, allocated.receipt);
    if (existingR2) {
      pdfBytes = existingR2;
    } else {
      const regenerated = await generateReceiptPdf(buildPdfInput(allocated.receipt.receiptNumber));
      pdfBytes = regenerated.bytes;
    }
  }

  const r2Result = await storeReceiptPdfImmutably(params.mediaBucket, {
    objectKey: allocated.receipt.r2ObjectKey,
    receiptNumber: allocated.receipt.receiptNumber,
    documentKind: "credit_note",
    pdfBytes,
    expectedSha256Hex: allocated.receipt.pdfSha256,
  });

  const emailPort = resolveReceiptEmailPort({
    emailPort: params.emailPort,
    cloudflareEmailBinding: params.cloudflareEmailBinding,
  });

  const emailRes = await deliverReceiptEmailIfNeeded({
    db: params.db,
    receipt: allocated.receipt,
    pdfBytes,
    payerEmail: ctx.payerEmail,
    payerName: ctx.payerName,
    tenantName: ctx.tenantName,
    tenantHandle: ctx.tenantHandle,
    linkedReceiptNumber: ctx.linkedReceiptNumber,
    emailPort,
    platformDomain,
    nowMs,
    suppressionSalt: params.suppressionSalt,
    logger: params.logger,
  });

  const updatedReceipt: PaymentReceiptRecord =
    emailRes.emailedAtMs !== null
      ? {
          ...allocated.receipt,
          emailedAtMs: emailRes.emailedAtMs,
          emailedAtIso: new Date(emailRes.emailedAtMs).toISOString(),
        }
      : allocated.receipt;

  return {
    created: allocated.created,
    receipt: updatedReceipt,
    linkedReceiptId: ctx.linkedReceiptId,
    linkedReceiptNumber: ctx.linkedReceiptNumber,
    r2Stored: r2Result.stored,
    emailOutcome: emailRes.emailOutcome,
    emailErrorCode: emailRes.emailErrorCode,
    emailRetryable: emailRes.emailRetryable,
    pdfBytes,
  };
}

export interface CreateBillingReceiptDeliveryHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly suppressionSalt?: string;
  readonly now?: () => number;
  readonly logger?: StructuredJobLogger;
}

function assertQueueEmailDeliveredOrThrow(result: IssueReceiptDeliveryResult): void {
  if (
    result.emailOutcome === "submitted" ||
    result.emailOutcome === "already_emailed" ||
    result.emailOutcome === "skipped"
  ) {
    return;
  }

  const code = result.emailErrorCode || "RECEIPT_EMAIL_DELIVERY_FAILED";
  if (result.emailOutcome === "unknown" || result.emailRetryable !== false) {
    throw new ReceiptDeliveryRetryableError(
      code,
      `Transient receipt email delivery outcome (${result.emailOutcome}: ${code}) for ${result.receipt.receiptNumber}`,
    );
  }

  throw new NonRetryableJobError(
    `Permanent receipt email delivery refusal (${code}) for ${result.receipt.receiptNumber}`,
    code,
  );
}

/**
 * Durable Queue job handler for `billing.receipt.deliver`.
 * Accepts `{ settlementId }` for settlement receipts or `{ refundId }` for linked credit notes.
 * Throws `ReceiptDeliveryRetryableError` on transient `failed` or `unknown` email outcomes
 * so the durable queue retries delivery while leaving `emailed_at IS NULL` and the receipt intact.
 */
export function createBillingReceiptDeliveryHandler(
  options: CreateBillingReceiptDeliveryHandlerOptions = {},
): DurableJobHandler {
  return {
    maxAttempts: 3,
    async execute(ctx: JobExecutionContext): Promise<void> {
      const mediaBucket = ctx.env.MEDIA_BUCKET;
      if (!mediaBucket) {
        throw new Error("MEDIA_BUCKET_NOT_BOUND");
      }

      const nowMs = options.now ? options.now() : ctx.nowMs;
      const platformDomain = ctx.env.PLATFORM_DOMAIN || "punyasitus.com";
      const cloudflareEmailBinding = ctx.env.EMAIL as CloudflareSendEmailBinding | undefined;

      const settlementId =
        typeof ctx.payload.settlementId === "string" ? ctx.payload.settlementId.trim() : "";
      const refundId =
        typeof ctx.payload.refundId === "string" ? ctx.payload.refundId.trim() : "";

      if (settlementId) {
        const res = await issueAndDeliverSettlementReceipt({
          db: ctx.env.PLATFORM_DB,
          mediaBucket,
          settlementId,
          emailPort: options.emailPort,
          cloudflareEmailBinding,
          platformDomain,
          suppressionSalt: options.suppressionSalt,
          nowMs,
          logger: options.logger,
        });
        assertQueueEmailDeliveredOrThrow(res);
        return;
      }

      if (refundId) {
        const res = await issueAndDeliverRefundCreditNote({
          db: ctx.env.PLATFORM_DB,
          mediaBucket,
          refundId,
          emailPort: options.emailPort,
          cloudflareEmailBinding,
          platformDomain,
          suppressionSalt: options.suppressionSalt,
          nowMs,
          logger: options.logger,
        });
        assertQueueEmailDeliveredOrThrow(res);
        return;
      }

      throw new NonRetryableJobError(
        "Missing settlementId or refundId in billing.receipt.deliver payload",
        "MISSING_RECEIPT_DELIVERY_TARGET",
      );
    },
  };
}

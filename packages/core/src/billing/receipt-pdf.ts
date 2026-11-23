import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { BILLING_CURRENCY } from "./constants.ts";
import { BillingValidationError } from "./errors.ts";
import { assertExactIdrInteger, formatIdrDisplay } from "./money.ts";

/**
 * Pure-JS immutable PDF receipt & credit-note generator backed by `pdf-lib`
 * (REQ-081, PLAN §16.1 & §19.3; TASK-081).
 *
 * Designed for 100% compatibility with Cloudflare `workerd` and Node 22:
 * - Zero Node `fs`, `Buffer`, or external font downloads.
 * - Deterministic bytes & SHA-256 digest for identical input (pins PDF metadata timestamps).
 * - Exact integer IDR arithmetic and formatting (no floating-point currency drift).
 * - Mandatory explicit non-PKP disclosure (no PPN / Faktur Pajak line).
 */

export const RECEIPT_NON_PKP_NOTICE =
  "Harga belum termasuk PPN — penyelenggara belum PKP; dokumen ini adalah kuitansi layanan, bukan Faktur Pajak." as const;

export const RECEIPT_NUMBER_PATTERN = /^PS-(\d{4})-(\d{6,})$/;

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

const INDONESIAN_MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

export type ReceiptDocumentKind = "receipt" | "credit_note";

export interface ReceiptPdfInput {
  readonly documentKind: ReceiptDocumentKind;
  readonly receiptNumber: string;
  readonly issuedAtMs: number;
  readonly payerKind: "tenant" | "agency";
  readonly payerName: string;
  readonly payerEmail?: string | null;
  readonly tenantName: string;
  readonly tenantHandle: string;
  readonly obligationId: string;
  readonly settlementId?: string | null;
  readonly refundId?: string | null;
  readonly linkedReceiptNumber?: string | null;
  readonly creditNoteReason?: string | null;
  readonly planCode: string;
  readonly periodStartMs?: number | null;
  readonly periodEndMs?: number | null;
  readonly currency?: typeof BILLING_CURRENCY;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalAmountIdr: number;
  readonly couponCode?: string | null;
  readonly paymentChannel: string;
  readonly providerReference?: string | null;
  readonly nonPkpNotice?: string;
  readonly sellerName?: string;
  readonly sellerSubtitle?: string;
  readonly sellerSupportEmail?: string;
}

export interface GeneratedReceiptPdf {
  readonly bytes: Uint8Array;
  readonly sha256Hex: string;
  readonly byteLength: number;
  readonly receiptNumber: string;
  readonly r2ObjectKey: string;
  readonly nonPkpNotice: string;
  readonly renderedLines: readonly string[];
}

export function getWibYearFromEpochMs(epochMs: number): number {
  const safe = Math.trunc(epochMs);
  if (!Number.isFinite(safe) || safe <= 0) {
    throw new BillingValidationError(
      "INVALID_ISSUED_AT",
      "Timestamp penerbitan kuitansi tidak valid.",
    );
  }
  return new Date(safe + WIB_OFFSET_MS).getUTCFullYear();
}

export function formatReceiptNumber(year: number, sequence: number): string {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 9999) {
    throw new BillingValidationError("INVALID_RECEIPT_YEAR", "Tahun nomor kuitansi tidak valid.");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new BillingValidationError(
      "INVALID_RECEIPT_SEQUENCE",
      "Nomor urut kuitansi harus bilangan bulat positif.",
    );
  }
  return `PS-${year}-${String(sequence).padStart(6, "0")}`;
}

export function buildReceiptR2ObjectKey(year: number, receiptNumber: string): string {
  const trimmed = receiptNumber.trim();
  if (!RECEIPT_NUMBER_PATTERN.test(trimmed)) {
    throw new BillingValidationError(
      "INVALID_RECEIPT_NUMBER",
      `Format nomor kuitansi "${trimmed}" tidak valid.`,
    );
  }
  if (!Number.isSafeInteger(year) || year < 2000 || year > 9999) {
    throw new BillingValidationError("INVALID_RECEIPT_YEAR", "Tahun objek R2 tidak valid.");
  }
  return `platform/receipts/${year}/${trimmed}.pdf`;
}

export function formatWibDate(epochMs: number): string {
  const d = new Date(Math.trunc(epochMs) + WIB_OFFSET_MS);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = INDONESIAN_MONTHS[d.getUTCMonth()] ?? "Januari";
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

export function formatWibDateTime(epochMs: number): string {
  const d = new Date(Math.trunc(epochMs) + WIB_OFFSET_MS);
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatWibDate(epochMs)}, ${hours}:${minutes} WIB`;
}

export function formatReceiptIdr(amountIdr: number): string {
  return formatIdrDisplay(amountIdr);
}

/**
 * Computes lowercase hex SHA-256 digest via Web Crypto (Cloudflare `workerd` & Node 22 compatible).
 */
export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i += 1) {
    hex += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Standard Helvetica/HelveticaBold in `pdf-lib` uses WinAnsi encoding.
 * Replace non-WinAnsi characters cleanly (e.g. em-dash -> `-`, curly quotes -> ASCII,
 * control chars removed) so `drawText()` never throws on arbitrary business names.
 */
function toWinAnsiSafe(raw: string): string {
  let normalized = raw
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[\r\n\t]+/g, " ");

  let out = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += normalized[i];
    } else {
      out += " ";
    }
  }
  normalized = out.replace(/\s+/g, " ").trim();
  return normalized || "-";
}

function wrapTextToWidth(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string[] {
  const safe = toWinAnsiSafe(text);
  const words = safe.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!word) continue;
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
    }
    if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
      current = word;
    } else {
      // Break an exceptionally long token safely
      let chunk = "";
      for (const ch of word) {
        const nextChunk = chunk + ch;
        if (font.widthOfTextAtSize(nextChunk, fontSize) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk = nextChunk;
        }
      }
      current = chunk;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : ["-"];
}

function resolvePlanLabel(planCode: string): string {
  const normalized = planCode.trim().toLowerCase();
  if (normalized === "yearly") return "Langganan PunyaSitus - Paket Tahunan (12 Bulan)";
  if (normalized === "monthly") return "Langganan PunyaSitus - Paket Bulanan (1 Bulan)";
  return `Layanan PunyaSitus (${toWinAnsiSafe(planCode)})`;
}

function drawRightAlignedText(
  page: PDFPage,
  text: string,
  rightX: number,
  y: number,
  font: PDFFont,
  size: number,
  color: ReturnType<typeof rgb>,
): void {
  const safe = toWinAnsiSafe(text);
  const width = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, { x: rightX - width, y, size, font, color });
}

export interface InspectedReceiptPdf {
  readonly pageCount: number;
  readonly title: string | undefined;
  readonly subject: string | undefined;
  readonly author: string | undefined;
  readonly producer: string | undefined;
  readonly keywords: string | undefined;
}

/**
 * Parses raw PDF bytes with `pdf-lib` (`PDFDocument.load`) to verify structural validity
 * and read embedded document metadata.
 */
export async function inspectReceiptPdf(bytes: Uint8Array): Promise<InspectedReceiptPdf> {
  const doc = await PDFDocument.load(bytes);
  return {
    pageCount: doc.getPageCount(),
    title: doc.getTitle(),
    subject: doc.getSubject(),
    author: doc.getAuthor(),
    producer: doc.getProducer(),
    keywords: doc.getKeywords(),
  };
}

/**
 * Generates an immutable, deterministic A4 Indonesian payment receipt or credit note PDF
 * using `pdf-lib` (`StandardFonts.Helvetica` / `HelveticaBold`).
 */
export async function generateReceiptPdf(input: ReceiptPdfInput): Promise<GeneratedReceiptPdf> {
  const receiptNumber = input.receiptNumber.trim();
  if (!RECEIPT_NUMBER_PATTERN.test(receiptNumber)) {
    throw new BillingValidationError(
      "INVALID_RECEIPT_NUMBER",
      `Format nomor kuitansi "${receiptNumber}" tidak valid (harus PS-YYYY-NNNNNN).`,
    );
  }

  const issuedAtMs = Math.trunc(input.issuedAtMs);
  const year = getWibYearFromEpochMs(issuedAtMs);
  const r2ObjectKey = buildReceiptR2ObjectKey(year, receiptNumber);

  const baseAmountIdr = assertExactIdrInteger(input.baseAmountIdr, "baseAmountIdr");
  const discountAmountIdr = assertExactIdrInteger(input.discountAmountIdr, "discountAmountIdr");
  const channelFeeIdr = assertExactIdrInteger(input.channelFeeIdr, "channelFeeIdr");
  const totalAmountIdr = assertExactIdrInteger(input.totalAmountIdr, "totalAmountIdr");

  const nonPkpNotice =
    input.nonPkpNotice && input.nonPkpNotice.trim().length > 0
      ? input.nonPkpNotice.trim()
      : RECEIPT_NON_PKP_NOTICE;

  const isCreditNote = input.documentKind === "credit_note";
  const docTitle = isCreditNote ? "NOTA KREDIT PENGEMBALIAN DANA" : "KUITANSI PEMBAYARAN";
  const sellerName = input.sellerName?.trim() || "PunyaSitus";
  const sellerSubtitle =
    input.sellerSubtitle?.trim() || "Platform Website Bisnis Indonesia (punyasitus.com)";
  const sellerSupportEmail = input.sellerSupportEmail?.trim() || "noreply@notif.punyasitus.com";
  const issuedAtLabel = formatWibDateTime(issuedAtMs);

  const periodLabel =
    typeof input.periodStartMs === "number" &&
    typeof input.periodEndMs === "number" &&
    Number.isFinite(input.periodStartMs) &&
    Number.isFinite(input.periodEndMs)
      ? `${formatWibDate(input.periodStartMs)} - ${formatWibDate(input.periodEndMs)} (WIB)`
      : "-";

  const payerRoleLabel = input.payerKind === "agency" ? "Agensi Pengelola" : "Pemilik Situs";
  const planLabel = resolvePlanLabel(input.planCode);
  const channelLabel = toWinAnsiSafe(input.paymentChannel || "-");
  const providerRefLabel = input.providerReference ? toWinAnsiSafe(input.providerReference) : "-";

  const renderedLines: string[] = [];
  const track = (line: string): string => {
    renderedLines.push(line);
    return line;
  };

  const pdfDoc = await PDFDocument.create();
  const issuedDate = new Date(issuedAtMs);
  pdfDoc.setTitle(`${docTitle} ${receiptNumber}`);
  pdfDoc.setSubject(
    isCreditNote && input.linkedReceiptNumber
      ? `Nota Kredit ${receiptNumber} (Referensi Kuitansi ${input.linkedReceiptNumber})`
      : `Kuitansi Pembayaran PunyaSitus ${receiptNumber}`,
  );
  pdfDoc.setAuthor(sellerName);
  pdfDoc.setProducer("PunyaSitus Billing Engine (pdf-lib)");
  pdfDoc.setCreator("PunyaSitus");
  pdfDoc.setKeywords([
    receiptNumber,
    input.documentKind,
    input.tenantHandle,
    ...(input.linkedReceiptNumber ? [input.linkedReceiptNumber] : []),
    "non-PKP",
  ]);
  pdfDoc.setCreationDate(issuedDate);
  pdfDoc.setModificationDate(issuedDate);

  const pageWidth = 595.28; // A4 portrait
  const pageHeight = 841.89;
  const marginX = 48;
  const contentWidth = pageWidth - marginX * 2;
  const rightEdgeX = pageWidth - marginX;

  const page = pdfDoc.addPage([pageWidth, pageHeight]);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const inkDark = rgb(0.06, 0.09, 0.16); // #0f172a
  const inkMuted = rgb(0.39, 0.45, 0.55); // #64748b
  const borderLight = rgb(0.89, 0.91, 0.94); // #e2e8f0
  const surfaceBg = rgb(0.97, 0.98, 0.99); // #f8fafc
  const accentDark = rgb(0.06, 0.09, 0.16);
  const creditAccent = rgb(0.6, 0.11, 0.11); // #991b1b
  const white = rgb(1, 1, 1);

  // 1. Top dark header band
  const headerBandHeight = 86;
  page.drawRectangle({
    x: 0,
    y: pageHeight - headerBandHeight,
    width: pageWidth,
    height: headerBandHeight,
    color: isCreditNote ? creditAccent : accentDark,
  });

  page.drawText(toWinAnsiSafe(track(sellerName)), {
    x: marginX,
    y: pageHeight - 38,
    size: 20,
    font: fontBold,
    color: white,
  });
  page.drawText(toWinAnsiSafe(track(sellerSubtitle)), {
    x: marginX,
    y: pageHeight - 56,
    size: 9,
    font: fontRegular,
    color: rgb(0.85, 0.89, 0.94),
  });
  page.drawText(toWinAnsiSafe(sellerSupportEmail), {
    x: marginX,
    y: pageHeight - 70,
    size: 8.5,
    font: fontRegular,
    color: rgb(0.78, 0.84, 0.9),
  });

  drawRightAlignedText(page, track(docTitle), rightEdgeX, pageHeight - 36, fontBold, 13, white);
  drawRightAlignedText(
    page,
    track(`No. ${receiptNumber}`),
    rightEdgeX,
    pageHeight - 54,
    fontBold,
    11,
    rgb(0.94, 0.96, 1),
  );
  drawRightAlignedText(
    page,
    track(`Terbit: ${issuedAtLabel}`),
    rightEdgeX,
    pageHeight - 69,
    fontRegular,
    8.5,
    rgb(0.85, 0.89, 0.94),
  );

  let y = pageHeight - headerBandHeight - 28;

  // 2. Credit-note reference banner (if credit_note)
  if (isCreditNote) {
    const refText = input.linkedReceiptNumber
      ? `Referensi Kuitansi Asli: ${input.linkedReceiptNumber}`
      : "Dokumen Penyesuaian / Pengembalian Dana";
    const reasonText = input.creditNoteReason
      ? `Alasan: ${toWinAnsiSafe(input.creditNoteReason)}`
      : "Pengembalian dana manual terverifikasi oleh operator platform.";
    const reasonLines = wrapTextToWidth(reasonText, fontRegular, 9, contentWidth - 24);
    const boxHeight = 32 + reasonLines.length * 13;

    page.drawRectangle({
      x: marginX,
      y: y - boxHeight,
      width: contentWidth,
      height: boxHeight,
      color: rgb(1, 0.95, 0.95),
      borderColor: rgb(0.94, 0.72, 0.72),
      borderWidth: 1,
    });
    page.drawText(toWinAnsiSafe(track(refText)), {
      x: marginX + 12,
      y: y - 18,
      size: 10,
      font: fontBold,
      color: creditAccent,
    });
    let ry = y - 34;
    for (const line of reasonLines) {
      page.drawText(toWinAnsiSafe(track(line)), {
        x: marginX + 12,
        y: ry,
        size: 9,
        font: fontRegular,
        color: inkDark,
      });
      ry -= 13;
    }
    y -= boxHeight + 18;
  }

  // 3. Payer & Transaction Metadata Grid (two columns)
  const colGap = 20;
  const colWidth = (contentWidth - colGap) / 2;
  const leftX = marginX;
  const rightColX = marginX + colWidth + colGap;

  const metaBoxTop = y;
  const metaBoxHeight = 128;
  page.drawRectangle({
    x: marginX,
    y: metaBoxTop - metaBoxHeight,
    width: contentWidth,
    height: metaBoxHeight,
    color: surfaceBg,
    borderColor: borderLight,
    borderWidth: 1,
  });

  // Left column: Payer & Website
  let ly = metaBoxTop - 20;
  page.drawText(toWinAnsiSafe(track(`DITAGIHKAN KEPADA (${payerRoleLabel.toUpperCase()})`)), {
    x: leftX + 14,
    y: ly,
    size: 8,
    font: fontBold,
    color: inkMuted,
  });
  ly -= 16;
  page.drawText(toWinAnsiSafe(track(input.payerName)), {
    x: leftX + 14,
    y: ly,
    size: 11,
    font: fontBold,
    color: inkDark,
  });
  ly -= 15;
  if (input.payerEmail) {
    page.drawText(toWinAnsiSafe(track(input.payerEmail)), {
      x: leftX + 14,
      y: ly,
      size: 9,
      font: fontRegular,
      color: inkMuted,
    });
    ly -= 18;
  } else {
    ly -= 8;
  }
  page.drawText("WEBSITE", {
    x: leftX + 14,
    y: ly,
    size: 8,
    font: fontBold,
    color: inkMuted,
  });
  ly -= 14;
  page.drawText(toWinAnsiSafe(track(`${input.tenantName} (${input.tenantHandle})`)), {
    x: leftX + 14,
    y: ly,
    size: 9.5,
    font: fontBold,
    color: inkDark,
  });
  ly -= 14;
  page.drawText(toWinAnsiSafe(track(`Periode Layanan: ${periodLabel}`)), {
    x: leftX + 14,
    y: ly,
    size: 8.5,
    font: fontRegular,
    color: inkMuted,
  });

  // Right column: Payment Details
  let rColY = metaBoxTop - 20;
  page.drawText("RINCIAN TRANSAKSI", {
    x: rightColX,
    y: rColY,
    size: 8,
    font: fontBold,
    color: inkMuted,
  });
  rColY -= 16;

  const metaPairs: readonly [string, string][] = [
    ["ID Tagihan", toWinAnsiSafe(input.obligationId)],
    ["Kanal Pembayaran", channelLabel],
    ["Referensi Provider", providerRefLabel],
    [
      isCreditNote ? "ID Pengembalian" : "ID Pelunasan",
      toWinAnsiSafe(isCreditNote ? (input.refundId ?? "-") : (input.settlementId ?? "-")),
    ],
    ["Mata Uang", input.currency ?? BILLING_CURRENCY],
  ];

  for (const [label, value] of metaPairs) {
    page.drawText(toWinAnsiSafe(`${label}:`), {
      x: rightColX,
      y: rColY,
      size: 8.5,
      font: fontRegular,
      color: inkMuted,
    });
    drawRightAlignedText(
      page,
      track(`${label}: ${value}`),
      rightEdgeX - 14,
      rColY,
      fontBold,
      8.5,
      inkDark,
    );
    rColY -= 17;
  }

  y = metaBoxTop - metaBoxHeight - 26;

  // 4. Itemized Integer IDR Breakdown Table
  page.drawText(track("RINCIAN BIAYA (IDR)"), {
    x: marginX,
    y,
    size: 9.5,
    font: fontBold,
    color: inkDark,
  });
  y -= 10;

  // Table header row
  const rowHeaderH = 26;
  page.drawRectangle({
    x: marginX,
    y: y - rowHeaderH,
    width: contentWidth,
    height: rowHeaderH,
    color: rgb(0.94, 0.96, 0.98),
    borderColor: borderLight,
    borderWidth: 1,
  });
  page.drawText("Deskripsi", {
    x: marginX + 12,
    y: y - 17,
    size: 9,
    font: fontBold,
    color: inkDark,
  });
  drawRightAlignedText(page, "Jumlah (IDR)", rightEdgeX - 12, y - 17, fontBold, 9, inkDark);
  y -= rowHeaderH;

  interface LineItemRow {
    readonly label: string;
    readonly sublabel?: string;
    readonly formattedAmount: string;
  }

  const lineItems: LineItemRow[] = [
    {
      label: planLabel,
      sublabel: periodLabel !== "-" ? `Periode layanan: ${periodLabel}` : undefined,
      formattedAmount: formatReceiptIdr(baseAmountIdr),
    },
  ];

  if (discountAmountIdr > 0) {
    lineItems.push({
      label: input.couponCode
        ? `Diskon Promo (${toWinAnsiSafe(input.couponCode)})`
        : "Diskon Promo / Agensi",
      formattedAmount: `-${formatReceiptIdr(discountAmountIdr)}`,
    });
  } else {
    lineItems.push({
      label: "Diskon Promo",
      formattedAmount: formatReceiptIdr(0),
    });
  }

  lineItems.push({
    label: `Biaya Kanal Pembayaran (${channelLabel})`,
    sublabel: "Biaya admin kanal pembayaran ditanggung pembayar (terpisah dari harga paket)",
    formattedAmount: formatReceiptIdr(channelFeeIdr),
  });

  for (const item of lineItems) {
    const rowH = item.sublabel ? 38 : 28;
    page.drawRectangle({
      x: marginX,
      y: y - rowH,
      width: contentWidth,
      height: rowH,
      borderColor: borderLight,
      borderWidth: 0.75,
    });
    page.drawText(toWinAnsiSafe(track(`${item.label} | ${item.formattedAmount}`)), {
      x: marginX + 12,
      y: y - 16,
      size: 9.5,
      font: fontRegular,
      color: inkDark,
    });
    if (item.sublabel) {
      page.drawText(toWinAnsiSafe(item.sublabel), {
        x: marginX + 12,
        y: y - 29,
        size: 8,
        font: fontRegular,
        color: inkMuted,
      });
    }
    drawRightAlignedText(
      page,
      item.formattedAmount,
      rightEdgeX - 12,
      y - 16,
      fontBold,
      9.5,
      inkDark,
    );
    y -= rowH;
  }

  // Total row
  const totalLabel = isCreditNote ? "TOTAL DIKREDITKAN / DIKEMBALIKAN" : "TOTAL DIBAYAR";
  const formattedTotal = formatReceiptIdr(totalAmountIdr);
  const totalRowH = 34;
  page.drawRectangle({
    x: marginX,
    y: y - totalRowH,
    width: contentWidth,
    height: totalRowH,
    color: isCreditNote ? creditAccent : accentDark,
  });
  page.drawText(toWinAnsiSafe(track(`${totalLabel}: ${formattedTotal}`)), {
    x: marginX + 12,
    y: y - 21,
    size: 10.5,
    font: fontBold,
    color: white,
  });
  drawRightAlignedText(page, formattedTotal, rightEdgeX - 12, y - 21, fontBold, 11.5, white);
  y -= totalRowH + 24;

  // 5. Mandatory Non-PKP Notice Callout Box
  const noticeLines = wrapTextToWidth(nonPkpNotice, fontRegular, 9, contentWidth - 28);
  const noticeBoxH = 26 + noticeLines.length * 14;
  page.drawRectangle({
    x: marginX,
    y: y - noticeBoxH,
    width: contentWidth,
    height: noticeBoxH,
    color: rgb(1, 0.99, 0.93),
    borderColor: rgb(0.92, 0.8, 0.45),
    borderWidth: 1,
  });
  page.drawText("KETERANGAN PAJAK (NON-PKP)", {
    x: marginX + 14,
    y: y - 16,
    size: 8.5,
    font: fontBold,
    color: rgb(0.57, 0.34, 0.04),
  });
  track(nonPkpNotice);
  let ny = y - 31;
  for (const line of noticeLines) {
    page.drawText(line, {
      x: marginX + 14,
      y: ny,
      size: 9,
      font: fontRegular,
      color: inkDark,
    });
    ny -= 14;
  }

  // 6. Bottom footer (immutability notice)
  const footerY = 54;
  page.drawLine({
    start: { x: marginX, y: footerY + 18 },
    end: { x: rightEdgeX, y: footerY + 18 },
    thickness: 0.75,
    color: borderLight,
  });
  page.drawText(
    toWinAnsiSafe(
      `Dokumen ini diterbitkan secara elektronik oleh ${sellerName} dan bersifat tetap (tidak dapat diubah).`,
    ),
    {
      x: marginX,
      y: footerY + 4,
      size: 8,
      font: fontRegular,
      color: inkMuted,
    },
  );
  page.drawText(
    toWinAnsiSafe(
      "Penyesuaian atau pengembalian dana yang disetujui diterbitkan sebagai dokumen nota kredit terpisah.",
    ),
    {
      x: marginX,
      y: footerY - 8,
      size: 8,
      font: fontRegular,
      color: inkMuted,
    },
  );

  // Deterministic uncompressed-object-stream save so PDF bytes & SHA-256 are 100% reproducible
  const bytes = await pdfDoc.save({ useObjectStreams: false });
  const sha256Hex = await computeSha256Hex(bytes);

  return {
    bytes,
    sha256Hex,
    byteLength: bytes.byteLength,
    receiptNumber,
    r2ObjectKey,
    nonPkpNotice,
    renderedLines,
  };
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RECEIPT_NON_PKP_NOTICE,
  RECEIPT_NUMBER_PATTERN,
  buildReceiptR2ObjectKey,
  computeSha256Hex,
  formatReceiptIdr,
  formatReceiptNumber,
  formatWibDate,
  formatWibDateTime,
  generateReceiptPdf,
  getWibYearFromEpochMs,
  inspectReceiptPdf,
  type ReceiptPdfInput,
} from "@punyasitus/core/billing/receipt-pdf";
import {
  BILLING_RECEIPTS_MIGRATION_SQL,
  assertReceiptAccountingSum,
} from "@punyasitus/db/billing/receipts/index";
import { describe, expect, it } from "vitest";

const BASE_ISSUED_MS = Date.UTC(2026, 0, 31, 10, 0, 0); // 2026-01-31 17:00 WIB
const PERIOD_START_MS = Date.UTC(2026, 0, 31, 10, 0, 0);
const PERIOD_END_MS = Date.UTC(2026, 1, 28, 10, 0, 0);

describe("TASK-081 unit: numbered receipt formatting, IDR math, PDF generation & SHA-256 determinism", () => {
  it("formats sequential PS-YYYY-NNNNNN numbers, R2 keys, and WIB year/dates accurately", () => {
    expect(formatReceiptNumber(2026, 1)).toBe("PS-2026-000001");
    expect(formatReceiptNumber(2026, 42)).toBe("PS-2026-000042");
    expect(formatReceiptNumber(2026, 1_234_567)).toBe("PS-2026-1234567");
    expect(RECEIPT_NUMBER_PATTERN.test("PS-2026-000001")).toBe(true);
    expect(RECEIPT_NUMBER_PATTERN.test("INV-2026-000001")).toBe(false);

    expect(buildReceiptR2ObjectKey(2026, "PS-2026-000001")).toBe(
      "platform/receipts/2026/PS-2026-000001.pdf",
    );

    // 2025-12-31T17:00:00Z is 2026-01-01 00:00 WIB -> year 2026!
    expect(getWibYearFromEpochMs(Date.UTC(2025, 11, 31, 17, 0, 0))).toBe(2026);
    expect(getWibYearFromEpochMs(Date.UTC(2025, 11, 31, 16, 59, 59))).toBe(2025);
    expect(formatWibDate(BASE_ISSUED_MS)).toBe("31 Januari 2026");
    expect(formatWibDateTime(BASE_ISSUED_MS)).toBe("31 Januari 2026, 17:00 WIB");

    expect(formatReceiptIdr(179_000)).toBe("Rp 179.000");
    expect(formatReceiptIdr(1_790_000)).toBe("Rp 1.790.000");
    expect(formatReceiptIdr(3_000)).toBe("Rp 3.000");
    expect(formatReceiptIdr(0)).toBe("Rp 0");

    expect(() => formatReceiptNumber(2026, 0)).toThrow();
    expect(() => formatReceiptNumber(1999, 1)).toThrow();
    expect(() => formatReceiptIdr(-1)).toThrow();
    expect(() => formatReceiptIdr(179_000.5)).toThrow();
  });

  it("generates a valid, parseable, deterministic PDF receipt with itemized IDR lines & mandatory non-PKP notice", async () => {
    const input: ReceiptPdfInput = {
      documentKind: "receipt",
      receiptNumber: "PS-2026-000001",
      issuedAtMs: BASE_ISSUED_MS,
      payerKind: "tenant",
      payerName: "Budi Santoso — Bengkel Maju 🚀",
      payerEmail: "budi@bengkelmaju.id",
      tenantName: "Bengkel Maju Jaya",
      tenantHandle: "bengkel-maju",
      obligationId: "obl_01JTESTRECEIPT0000000001",
      settlementId: "stl_01JTESTRECEIPT0000000001",
      planCode: "monthly",
      periodStartMs: PERIOD_START_MS,
      periodEndMs: PERIOD_END_MS,
      baseAmountIdr: 179_000,
      discountAmountIdr: 20_000,
      channelFeeIdr: 3_000,
      totalAmountIdr: 162_000,
      couponCode: "PROMO20K",
      paymentChannel: "VA (VAMANDIRI)",
      providerReference: "AL-TRX-20260131-001",
    };

    const first = await generateReceiptPdf(input);
    const second = await generateReceiptPdf(input);

    // Non-empty valid %PDF-1. header
    expect(first.byteLength).toBeGreaterThan(1_000);
    expect(first.bytes.byteLength).toBe(first.byteLength);
    const headerAscii = new TextDecoder("ascii").decode(first.bytes.slice(0, 7));
    expect(headerAscii).toMatch(/^%PDF-1\./);

    // Deterministic bytes & SHA-256 stability
    expect(first.sha256Hex).toMatch(/^[a-f0-9]{64}$/);
    expect(first.sha256Hex).toBe(second.sha256Hex);
    expect(await computeSha256Hex(first.bytes)).toBe(first.sha256Hex);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.r2ObjectKey).toBe("platform/receipts/2026/PS-2026-000001.pdf");

    // Parseable via pdf-lib PDFDocument.load(...)
    const parsed = await inspectReceiptPdf(first.bytes);
    expect(parsed.pageCount).toBe(1);
    expect(parsed.title).toContain("KUITANSI PEMBAYARAN");
    expect(parsed.title).toContain("PS-2026-000001");
    expect(parsed.keywords).toContain("non-PKP");

    // Itemized plan, discount, separate channel fee, total, and non-PKP notice
    const joined = first.renderedLines.join("\n");
    expect(joined).toContain("KUITANSI PEMBAYARAN");
    expect(joined).toContain("PS-2026-000001");
    expect(joined).toContain("Rp 179.000");
    expect(joined).toContain("PROMO20K");
    expect(joined).toContain("-Rp 20.000");
    expect(joined).toContain("Biaya Kanal Pembayaran (VA (VAMANDIRI))");
    expect(joined).toContain("Rp 3.000");
    expect(joined).toContain("TOTAL DIBAYAR: Rp 162.000");
    expect(joined).toContain(RECEIPT_NON_PKP_NOTICE);
    expect(joined).toContain("31 Januari 2026 - 28 Februari 2026 (WIB)");
  });

  it("generates a valid linked credit note PDF referencing the original receipt number", async () => {
    const creditNote = await generateReceiptPdf({
      documentKind: "credit_note",
      receiptNumber: "PS-2026-000002",
      issuedAtMs: BASE_ISSUED_MS + 3_600_000,
      payerKind: "agency",
      payerName: "PT Agensi Digital Nusantara",
      payerEmail: "billing@agensi.id",
      tenantName: "Klinik Sehat Sentosa",
      tenantHandle: "klinik-sehat",
      obligationId: "obl_01JTESTRECEIPT0000000001",
      refundId: "rfd_01JTESTREFUND00000000001",
      linkedReceiptNumber: "PS-2026-000001",
      creditNoteReason: "Pembayaran ganda terverifikasi melalui rekonsiliasi manual operator",
      planCode: "yearly",
      periodStartMs: PERIOD_START_MS,
      periodEndMs: Date.UTC(2027, 0, 31, 10, 0, 0),
      baseAmountIdr: 1_790_000,
      discountAmountIdr: 0,
      channelFeeIdr: 4_000,
      totalAmountIdr: 1_794_000,
      paymentChannel: "QRIS",
      providerReference: "REFUND-BCA-20260131",
    });

    const headerAscii = new TextDecoder("ascii").decode(creditNote.bytes.slice(0, 7));
    expect(headerAscii).toMatch(/^%PDF-1\./);
    expect(creditNote.r2ObjectKey).toBe("platform/receipts/2026/PS-2026-000002.pdf");

    const parsed = await inspectReceiptPdf(creditNote.bytes);
    expect(parsed.pageCount).toBe(1);
    expect(parsed.title).toContain("NOTA KREDIT PENGEMBALIAN DANA");
    expect(parsed.subject).toContain("PS-2026-000001");

    const joined = creditNote.renderedLines.join("\n");
    expect(joined).toContain("NOTA KREDIT PENGEMBALIAN DANA");
    expect(joined).toContain("Referensi Kuitansi Asli: PS-2026-000001");
    expect(joined).toContain("AGENSI PENGELOLA");
    expect(joined).toContain("TOTAL DIKREDITKAN / DIKEMBALIKAN: Rp 1.794.000");
    expect(joined).toContain(RECEIPT_NON_PKP_NOTICE);
  });

  it("keeps bundled BILLING_RECEIPTS_MIGRATION_SQL byte-for-byte identical to 0009_billing_receipts.sql", () => {
    const diskPath = resolve(
      process.cwd(),
      "packages/db/migrations/platform/0009_billing_receipts.sql",
    );
    const diskSql = readFileSync(diskPath, "utf8");
    expect(BILLING_RECEIPTS_MIGRATION_SQL).toBe(diskSql);
    expect(diskSql).toContain("base_amount_idr - discount_amount_idr + channel_fee_idr = total_amount_idr");
  });

  it("enforces strict integer accounting sum invariant (base - discount + fee === total)", () => {
    expect(() =>
      assertReceiptAccountingSum({
        baseAmountIdr: 179_000,
        discountAmountIdr: 20_000,
        channelFeeIdr: 3_000,
        totalAmountIdr: 162_000,
      }),
    ).not.toThrow();

    expect(() =>
      assertReceiptAccountingSum({
        baseAmountIdr: 179_000,
        discountAmountIdr: 20_000,
        channelFeeIdr: 3_000,
        totalAmountIdr: 180_000,
      }),
    ).toThrow(/Total kuitansi tidak cocok/i);

    expect(() =>
      assertReceiptAccountingSum({
        baseAmountIdr: 100_000,
        discountAmountIdr: 120_000,
        channelFeeIdr: 3_000,
        totalAmountIdr: 0,
      }),
    ).toThrow(/melebihi harga dasar/i);
  });

  it("contains zero request-time runtime DDL calls in receipts repository and receipt API routes", () => {
    const runtimeFiles = [
      "packages/db/src/billing/receipts/repository.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/billing/receipts/_shared.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/billing/receipts/index.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/billing/receipts/[receiptId]/pdf.ts",
      "apps/web/src/pages/api/agency/receipts/_shared.ts",
      "apps/web/src/pages/api/agency/receipts/index.ts",
      "apps/web/src/pages/api/agency/receipts/[receiptId]/pdf.ts",
      "apps/web/src/pages/api/console/billing/receipts/[receiptId]/pdf.ts",
      "apps/web/src/pages/api/console/billing/refund.ts",
    ];
    for (const rel of runtimeFiles) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(src, `${rel} must not execute ensureBillingReceiptsSchema at request time`).not.toContain(
        "ensureBillingReceiptsSchema",
      );
      expect(
        src,
        `${rel} must not execute ensureBillingReconciliationSchema at request time`,
      ).not.toContain("ensureBillingReconciliationSchema");
    }
  });
});

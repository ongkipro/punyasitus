import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeNextWibPayoutDate,
  computePayoutThresholdProgress,
  maskReferredTenantHandle,
} from "../../apps/web/src/pages/api/affiliate/_shared.ts";
import {
  CONSOLE_AFFILIATE_CSV_MAX_ROWS,
  finalizeBoundedExportPage,
  parseConsoleCsvExportOffset,
  resolveConsoleCsvMaxRows,
  sanitizeCsvCell,
  serializeConsoleAffiliatesCsv,
  serializeConsolePayoutBatchesCsv,
  type ConsoleAffiliateDto,
  type ConsoleAffiliatePayoutBatchDto,
} from "../../apps/web/src/pages/api/console/affiliates/_shared.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-086: Deterministic tenant handle masking (zero tenant PII)", () => {
  it("masks middle characters across all handle lengths including short 3-char handles", () => {
    expect(maskReferredTenantHandle("kopinusantara")).toBe("ko***ra");
    expect(maskReferredTenantHandle("toko-01")).toBe("to***01");
    expect(maskReferredTenantHandle("toko")).toBe("t***o");
    expect(maskReferredTenantHandle("abc")).toBe("a***c");
    expect(maskReferredTenantHandle("ab")).toBe("a***");
    expect(maskReferredTenantHandle("a")).toBe("a***");
    expect(maskReferredTenantHandle("")).toBe("***");
    expect(maskReferredTenantHandle("  Kopi-Nusantara  ")).toBe("ko***ra");
  });

  it("never returns the raw handle and always contains ***", () => {
    const samples = [
      "abc",
      "xyz",
      "toko",
      "klinik-sehat",
      "bengkel-jaya-88",
      "travel-umrah-berkah",
      "dealer-motor-jakarta",
    ];
    for (const handle of samples) {
      const masked = maskReferredTenantHandle(handle);
      expect(masked).toContain("***");
      expect(masked).not.toBe(handle);
      expect(masked).not.toContain(handle);
      // deterministic across repeated calls
      expect(maskReferredTenantHandle(handle)).toBe(masked);
    }
  });
});

describe("TASK-086: Asia/Jakarta (WIB) bi-monthly payout schedule & threshold progress", () => {
  it("computes 15th and 30th WIB payout dates accurately across months and boundaries", () => {
    // 2026-12-10 10:00 WIB (03:00 UTC) -> next payout 2026-12-15
    const dec10 = computeNextWibPayoutDate(Date.UTC(2026, 11, 10, 3, 0, 0));
    expect(dec10.dateKey).toBe("2026-12-15");
    expect(dec10.daysUntil).toBe(5);
    expect(dec10.isToday).toBe(false);
    expect(dec10.timezone).toBe("Asia/Jakarta");

    // 2026-12-14 17:30 UTC == 2026-12-15 00:30 WIB -> today is payout day!
    const dec15Wib = computeNextWibPayoutDate(Date.UTC(2026, 11, 14, 17, 30, 0));
    expect(dec15Wib.dateKey).toBe("2026-12-15");
    expect(dec15Wib.daysUntil).toBe(0);
    expect(dec15Wib.isToday).toBe(true);

    // 2026-12-16 05:00 WIB -> next payout 2026-12-30
    const dec16 = computeNextWibPayoutDate(Date.UTC(2026, 11, 15, 22, 0, 0));
    expect(dec16.dateKey).toBe("2026-12-30");
    expect(dec16.daysUntil).toBe(14);
    expect(dec16.isToday).toBe(false);

    // 2026-12-31 10:00 WIB -> rolls over to 2027-01-15
    const dec31 = computeNextWibPayoutDate(Date.UTC(2026, 11, 31, 3, 0, 0));
    expect(dec31.dateKey).toBe("2027-01-15");
    expect(dec31.daysUntil).toBe(15);

    // Non-leap February: 2026-02-20 WIB -> 2026-02-28
    const feb2026 = computeNextWibPayoutDate(Date.UTC(2026, 1, 20, 2, 0, 0));
    expect(feb2026.dateKey).toBe("2026-02-28");
    expect(feb2026.daysUntil).toBe(8);

    // Leap February: 2028-02-20 WIB -> 2028-02-29
    const feb2028 = computeNextWibPayoutDate(Date.UTC(2028, 1, 20, 2, 0, 0));
    expect(feb2028.dateKey).toBe("2028-02-29");
    expect(feb2028.daysUntil).toBe(9);
  });

  it("computes integer IDR minimum threshold progress cleanly including negative clawback offsets", () => {
    expect(computePayoutThresholdProgress(0, 100_000)).toEqual({
      minimumPayoutIdr: 100_000,
      netAvailableIdr: 0,
      progressPercent: 0,
      remainingToMinimumIdr: 100_000,
      eligibleForNextBatch: false,
    });

    expect(computePayoutThresholdProgress(75_000, 100_000)).toEqual({
      minimumPayoutIdr: 100_000,
      netAvailableIdr: 75_000,
      progressPercent: 75,
      remainingToMinimumIdr: 25_000,
      eligibleForNextBatch: false,
    });

    expect(computePayoutThresholdProgress(100_000, 100_000)).toEqual({
      minimumPayoutIdr: 100_000,
      netAvailableIdr: 100_000,
      progressPercent: 100,
      remainingToMinimumIdr: 0,
      eligibleForNextBatch: true,
    });

    expect(computePayoutThresholdProgress(260_000, 100_000)).toEqual({
      minimumPayoutIdr: 100_000,
      netAvailableIdr: 260_000,
      progressPercent: 100,
      remainingToMinimumIdr: 0,
      eligibleForNextBatch: true,
    });

    // Negative balance after post-payout clawback offset
    expect(computePayoutThresholdProgress(-40_000, 100_000)).toEqual({
      minimumPayoutIdr: 100_000,
      netAvailableIdr: -40_000,
      progressPercent: 0,
      remainingToMinimumIdr: 140_000,
      eligibleForNextBatch: false,
    });
  });
});

describe("TASK-086: Spreadsheet formula-injection-safe CSV export", () => {
  it("neutralizes leading =, +, -, @, tab, and CR characters and quotes RFC 4180 cells", () => {
    expect(sanitizeCsvCell("=SUM(A1:A5)")).toBe("'=SUM(A1:A5)");
    expect(sanitizeCsvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(sanitizeCsvCell("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
    expect(sanitizeCsvCell("@SUM(1+1)*cmd")).toBe("'@SUM(1+1)*cmd");
    expect(sanitizeCsvCell("\t=1+1")).toBe("'\t=1+1");
    expect(sanitizeCsvCell("\r=1+1")).toBe("\"'\\r=1+1\"".replace("\\r", "\r"));
    expect(sanitizeCsvCell("  =HYPERLINK(\"http://evil\")")).toBe(
      "\"'  =HYPERLINK(\"\"http://evil\"\")\"",
    );
    expect(sanitizeCsvCell('Budi, "Santoso"')).toBe('"Budi, ""Santoso"""');
    expect(sanitizeCsvCell("BCA")).toBe("BCA");
  });

  it("serializes affiliate & batch CSV rows with formula-injection protection", () => {
    const affiliateRow: ConsoleAffiliateDto = {
      id: "aff_01",
      userId: "usr_01",
      email: "mitra@example.com",
      status: "active",
      referralCode: "MITRA01",
      referralLink: "https://punyasitus.com/?ref=MITRA01",
      payoutBankCode: "BCA",
      payoutAccountHolder: "=CMD|' /C calc'!A0",
      payoutAccountMasked: "******7890",
      termsVersion: "2026-11-v1",
      termsAcceptedAt: "2026-11-20T00:00:00.000Z",
      hasTermsAccepted: true,
      visitsCount: 42,
      referralsCount: 5,
      payingTenantsCount: 2,
      balances: {
        pendingIdr: 35_800,
        approvedAvailableIdr: 107_400,
        batchedIdr: 0,
        paidIdr: 200_000,
        reversedIdr: 0,
      },
      approvedAt: "2026-11-20T01:00:00.000Z",
      suspendedAt: null,
      rejectedAt: null,
      statusReason: "+verified",
      version: 2,
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T01:00:00.000Z",
    };

    const affCsv = serializeConsoleAffiliatesCsv([affiliateRow]);
    expect(affCsv).toContain("'=CMD|' /C calc'!A0");
    expect(affCsv).not.toContain(",=CMD|");

    const batchRow: ConsoleAffiliatePayoutBatchDto = {
      id: "bat_01",
      affiliateId: "aff_01",
      affiliateEmail: "mitra@example.com",
      affiliateReferralCode: "MITRA01",
      affiliateStatus: "active",
      affiliateHasTermsAccepted: true,
      payoutBankCode: "BCA",
      payoutAccountHolder: "@SUM(A1)",
      payoutAccountMasked: "******7890",
      payoutPeriodKey: "2026-12-15",
      totalAmountIdr: 143_200,
      entryCount: 2,
      status: "paid",
      transferReference: "-TRF-2026-01",
      paidAt: "2026-12-15T10:00:00.000Z",
      paidByUserId: "usr_op",
      statusReason: "+Transfer selesai",
      version: 2,
      createdAt: "2026-12-15T01:00:00.000Z",
      updatedAt: "2026-12-15T10:00:00.000Z",
    };

    const batchCsv = serializeConsolePayoutBatchesCsv([batchRow]);
    expect(batchCsv).toContain("'@SUM(A1)");
    expect(batchCsv).toContain("'-TRF-2026-01");
    expect(batchCsv).toContain("'+Transfer selesai");
  });

  it("SEC-004: computes authoritative CSV truncation, row counts, maxRows bounds, and offset pagination", () => {
    expect(CONSOLE_AFFILIATE_CSV_MAX_ROWS).toBe(5_000);

    // Offset parsing bounds and invalid input handling
    expect(parseConsoleCsvExportOffset(null)).toBe(0);
    expect(parseConsoleCsvExportOffset("")).toBe(0);
    expect(parseConsoleCsvExportOffset("-10")).toBe(0);
    expect(parseConsoleCsvExportOffset("abc")).toBe(0);
    expect(parseConsoleCsvExportOffset("5000")).toBe(5_000);
    expect(parseConsoleCsvExportOffset("999999999")).toBe(1_000_000);

    // Max rows resolution (bounded to configured ceiling and 5,000 hard cap)
    expect(resolveConsoleCsvMaxRows(null)).toBe(5_000);
    expect(resolveConsoleCsvMaxRows("10000")).toBe(5_000);
    expect(resolveConsoleCsvMaxRows("250")).toBe(250);
    expect(resolveConsoleCsvMaxRows("0")).toBe(5_000);
    expect(resolveConsoleCsvMaxRows("-5")).toBe(5_000);
    expect(resolveConsoleCsvMaxRows("10", 3)).toBe(3);
    expect(resolveConsoleCsvMaxRows("2", 3)).toBe(2);

    // Under cap -> truncated: false
    expect(finalizeBoundedExportPage(["a", "b"], 5, 0)).toEqual({
      rows: ["a", "b"],
      rowCount: 2,
      maxRows: 5,
      offset: 0,
      truncated: false,
      nextOffset: null,
    });

    // Exact cap (limit+1 query returned exact maxRows) -> truncated: false
    expect(finalizeBoundedExportPage(["a", "b", "c"], 3, 0)).toEqual({
      rows: ["a", "b", "c"],
      rowCount: 3,
      maxRows: 3,
      offset: 0,
      truncated: false,
      nextOffset: null,
    });

    // Exceeds cap (limit+1 query returned maxRows+1) -> truncated: true + nextOffset
    expect(finalizeBoundedExportPage(["a", "b", "c", "d"], 3, 10)).toEqual({
      rows: ["a", "b", "c"],
      rowCount: 3,
      maxRows: 3,
      offset: 10,
      truncated: true,
      nextOffset: 13,
    });
  });
});

describe("TASK-086: DESIGN.md §4.3 base-nova UI hygiene checks", () => {
  const uiFiles = [
    "apps/web/src/layouts/AffiliateLayout.astro",
    "apps/web/src/pages/affiliate/index.astro",
    "apps/web/src/pages/affiliate/_AffiliateDashboardPanel.tsx",
    "apps/web/src/pages/affiliate/_AffiliateEnrollmentPanel.tsx",
    "apps/web/src/pages/console/affiliates/index.astro",
    "apps/web/src/pages/console/affiliates/_ConsoleAffiliatesPanel.tsx",
  ];

  it("enforces zero @radix-ui/*, zero asChild, zero Sparkles, and tabular-nums in TASK-086 UI", () => {
    for (const rel of uiFiles) {
      const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(content, `${rel} must not reference @radix-ui`).not.toMatch(/@radix-ui\//);
      expect(content, `${rel} must not use Radix asChild`).not.toMatch(/\basChild\b/);
      expect(content, `${rel} must not use banned Sparkles icon`).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }

    const affPanel = fs.readFileSync(
      path.join(ROOT, "apps/web/src/pages/affiliate/_AffiliateDashboardPanel.tsx"),
      "utf8",
    );
    expect(affPanel).toContain("tabular-nums");

    const consolePanel = fs.readFileSync(
      path.join(ROOT, "apps/web/src/pages/console/affiliates/_ConsoleAffiliatesPanel.tsx"),
      "utf8",
    );
    expect(consolePanel).toContain("tabular-nums");
  });
});

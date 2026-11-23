import fs from "node:fs";
import path from "node:path";
import {
  PLUGIN_CUSTOM_DEV_DAILY_LIMIT,
  PLUGIN_MONTHLY_DURATION_MS,
  PLUGIN_YEARLY_DURATION_MS,
  PluginBillingValidationError,
  assertValidPluginStoreSlug,
  calculatePluginAddonQuote,
  computePluginEntitlementExpiryMs,
  evaluatePluginStoreAccess,
  formatPluginAddonReceiptNumber,
  generatePluginAddonReceiptPdf,
  normalizeWhatsappNumber,
  validateCustomPluginRequestInput,
} from "@punyasitus/core/plugins/billing";
import { serializeOpenApiDocument } from "@punyasitus/core/schemas";
import { PLUGIN_STORE_BILLING_MIGRATION_SQL } from "@punyasitus/db/plugins/store/migrations";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-098 Plugin Store, Bespoke Grants & Add-on Billing — Pure Unit & Invariant Tests", () => {
  it("matches 0033_plugin_store_billing.sql and migrations.ts byte-for-byte", () => {
    const sqlPath = path.join(
      REPO_ROOT,
      "packages/db/migrations/platform/0033_plugin_store_billing.sql",
    );
    expect(fs.existsSync(sqlPath)).toBe(true);
    const diskSql = fs.readFileSync(sqlPath, "utf8");
    expect(PLUGIN_STORE_BILLING_MIGRATION_SQL).toBe(diskSql);
  });

  it("keeps docs/api/plugin-store.md present and docs/api/openapi.json drift-free", () => {
    const docPath = path.join(REPO_ROOT, "docs/api/plugin-store.md");
    expect(fs.existsSync(docPath)).toBe(true);
    const openApiPath = path.join(REPO_ROOT, "docs/api/openapi.json");
    expect(fs.readFileSync(openApiPath, "utf8")).toBe(serializeOpenApiDocument());
  });

  it("enforces zero SparklesIcon, zero @radix-ui/*, and zero asChild in all TASK-098 UI files", () => {
    const uiFiles = [
      "apps/web/src/pages/dashboard/[handle]/plugins/_PluginStoreClient.tsx",
      "apps/web/src/pages/dashboard/[handle]/plugins/index.astro",
      "apps/web/src/pages/agency/plugins/_AgencyPluginsPanel.tsx",
      "apps/web/src/pages/agency/plugins/index.astro",
      "apps/web/src/pages/console/plugins/_ConsolePluginsPanel.tsx",
      "apps/web/src/pages/console/plugins/index.astro",
    ];
    for (const rel of uiFiles) {
      const content = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(content, `${rel} must not use Sparkles`).not.toMatch(/\bSparkles(?:Icon)?\b/);
      expect(content, `${rel} must not import @radix-ui`).not.toContain("@radix-ui/");
      expect(content, `${rel} must not use asChild`).not.toMatch(/\basChild\b/);
    }
  });

  it("calculates exact integer IDR add-on pricing with coupon, agency discount, and Rp 10.000 floor", () => {
    // 1. Standard tenant QRIS purchase with 20% coupon
    const tenantQuote = calculatePluginAddonQuote({
      grossAmountIdr: 299_000,
      billingModel: "paid_once",
      payerKind: "tenant",
      coupon: { code: "HEMAT20", discountKind: "percent", discountValue: 20 },
      channelCode: "QRIS",
    });
    expect(tenantQuote.grossAmountIdr).toBe(299_000);
    expect(tenantQuote.agencyDiscountIdr).toBe(0);
    expect(tenantQuote.couponDiscountIdr).toBe(59_800); // floor(299000 * 20 / 100)
    expect(tenantQuote.netAmountIdr).toBe(239_200);
    expect(tenantQuote.channelFeeIdr).toBe(Math.ceil((239_200 * 7) / 1000)); // 1675
    expect(tenantQuote.totalPayableIdr).toBe(tenantQuote.netAmountIdr + tenantQuote.channelFeeIdr);

    // 2. Agency purchase with 20% agency discount + fixed coupon on VA_BCA
    const agencyQuote = calculatePluginAddonQuote({
      grossAmountIdr: 100_000,
      billingModel: "paid_monthly",
      payerKind: "agency",
      agencyDiscountPercent: 20,
      coupon: { code: "POTONG15K", discountKind: "fixed_idr", discountValue: 15_000 },
      channelCode: "VA_BCA",
    });
    expect(agencyQuote.agencyDiscountIdr).toBe(20_000);
    expect(agencyQuote.couponDiscountIdr).toBe(15_000);
    expect(agencyQuote.discountAmountIdr).toBe(35_000);
    expect(agencyQuote.netAmountIdr).toBe(65_000);
    expect(agencyQuote.channelFeeIdr).toBe(4_000);
    expect(agencyQuote.totalPayableIdr).toBe(69_000);

    // 3. Clamping guard: extreme coupon NEVER yields negative net or drops below Rp 10.000
    const clamped = calculatePluginAddonQuote({
      grossAmountIdr: 49_000,
      billingModel: "paid_monthly",
      payerKind: "tenant",
      coupon: { code: "MEGA999K", discountKind: "fixed_idr", discountValue: 999_000 },
      channelCode: "QRIS",
    });
    expect(clamped.netAmountIdr).toBe(10_000);
    expect(clamped.discountAmountIdr).toBe(39_000);
    expect(clamped.totalPayableIdr).toBeGreaterThanOrEqual(10_000);
  });

  it("computes entitlement expiry correctly for free, paid_once, paid_monthly (+30d), paid_yearly (+365d)", () => {
    const now = Date.UTC(2026, 10, 1, 0, 0, 0);
    expect(computePluginEntitlementExpiryMs({ billingModel: "free", nowMs: now })).toBeNull();
    expect(computePluginEntitlementExpiryMs({ billingModel: "paid_once", nowMs: now })).toBeNull();

    const firstMonth = computePluginEntitlementExpiryMs({
      billingModel: "paid_monthly",
      nowMs: now,
    });
    expect(firstMonth).toBe(now + PLUGIN_MONTHLY_DURATION_MS);

    // Early renewal extends from existing unexpired expiry timestamp
    const renewedMonth = computePluginEntitlementExpiryMs({
      billingModel: "paid_monthly",
      nowMs: now + 5 * 86_400_000,
      existingExpiresAtMs: firstMonth,
    });
    expect(renewedMonth).toBe(firstMonth! + PLUGIN_MONTHLY_DURATION_MS);

    const firstYear = computePluginEntitlementExpiryMs({
      billingModel: "paid_yearly",
      nowMs: now,
    });
    expect(firstYear).toBe(now + PLUGIN_YEARLY_DURATION_MS);
  });

  it("enforces private_client invisibility, agency grant inheritance, and AGENCY_PAYER_ONLY rules", () => {
    const now = Date.UTC(2026, 10, 10, 0, 0, 0);

    // Ungranted private_client -> 100% invisible
    const hidden = evaluatePluginStoreAccess({
      visibilityTier: "private_client",
      billingModel: "free",
      active: true,
      owningAgencyId: null,
      directGrantActive: false,
      agencyGrantActive: false,
      entitlement: null,
      nowMs: now,
    });
    expect(hidden.visible).toBe(false);
    expect(hidden.reasonCode).toBe("NOT_FOUND");

    // Granted private_client via owning agency -> visible & installable
    const agencyGranted = evaluatePluginStoreAccess({
      visibilityTier: "private_client",
      billingModel: "free",
      active: true,
      owningAgencyId: "ag_1",
      directGrantActive: false,
      agencyGrantActive: true,
      entitlement: null,
      nowMs: now,
    });
    expect(agencyGranted.visible).toBe(true);
    expect(agencyGranted.entitled).toBe(true);
    expect(agencyGranted.activeGrantScope).toBe("agency");

    // Agency-managed client viewing unpaid public_paid -> blocked from tenant checkout (`AGENCY_PAYER_ONLY`)
    const agencyClientPaid = evaluatePluginStoreAccess({
      visibilityTier: "public_paid",
      billingModel: "paid_monthly",
      active: true,
      owningAgencyId: "ag_1",
      directGrantActive: false,
      agencyGrantActive: false,
      entitlement: null,
      nowMs: now,
    });
    expect(agencyClientPaid.visible).toBe(true);
    expect(agencyClientPaid.entitled).toBe(false);
    expect(agencyClientPaid.canTenantCheckout).toBe(false);
    expect(agencyClientPaid.agencyCanCheckout).toBe(true);
    expect(agencyClientPaid.checkoutBlockCode).toBe("AGENCY_PAYER_ONLY");

    // Expired paid_monthly entitlement -> no longer entitled, requires renewal
    const lapsed = evaluatePluginStoreAccess({
      visibilityTier: "public_paid",
      billingModel: "paid_monthly",
      active: true,
      owningAgencyId: null,
      directGrantActive: false,
      agencyGrantActive: false,
      entitlement: {
        status: "active",
        enabled: true,
        sourceKind: "paid_monthly",
        expiresAtMs: now - 1000,
      },
      nowMs: now,
    });
    expect(lapsed.entitled).toBe(false);
    expect(lapsed.reasonCode).toBe("ENTITLEMENT_EXPIRED");
    expect(lapsed.canTenantCheckout).toBe(true);
  });

  it("validates custom_plugin dev requests, normalizes WhatsApp, and rejects invalid slugs", () => {
    expect(PLUGIN_CUSTOM_DEV_DAILY_LIMIT).toBe(3);
    expect(normalizeWhatsappNumber("0812-3456-7890")).toBe("6281234567890");
    expect(normalizeWhatsappNumber("+62 813 9876 5432")).toBe("6281398765432");

    const valid = validateCustomPluginRequestInput({
      serviceKind: "custom_plugin",
      title: "Kalkulator RAB Kontraktor",
      requirementsSummary:
        "Butuh kalkulator estimasi biaya bangunan per meter persegi dengan ekspor PDF otomatis ke WhatsApp sales.",
      contactWhatsapp: "081234567890",
      budgetRange: "Rp 3.000.000 - Rp 5.000.000",
    });
    expect(valid.serviceKind).toBe("custom_plugin");
    expect(valid.contactWhatsapp).toBe("6281234567890");

    expect(() =>
      validateCustomPluginRequestInput({
        serviceKind: "custom_theme",
        title: "Wrong Kind",
        requirementsSummary: "Ini seharusnya ditolak karena bukan custom_plugin.",
        contactWhatsapp: "081234567890",
      }),
    ).toThrow(PluginBillingValidationError);

    expect(() => assertValidPluginStoreSlug("builtin:lead-email")).toThrow(
      PluginBillingValidationError,
    );
  });

  it("generates deterministic numbered PDF receipts (INV-PLG-YYYY-NNNNNN) with non-PKP disclosure", async () => {
    const num = formatPluginAddonReceiptNumber(2026, 7);
    expect(num).toBe("INV-PLG-2026-000007");

    const input = {
      receiptNumber: num,
      issuedAtMs: Date.UTC(2026, 10, 23, 5, 0, 0),
      tenantName: "PT Nusantara Arsitek",
      tenantHandle: "nusantara-arsitek",
      payerKind: "tenant" as const,
      payerName: "Budi Santoso",
      pluginSlug: "wa-cs-rotator",
      pluginName: "WhatsApp CS Rotator",
      billingModel: "paid_monthly" as const,
      orderId: "plgord_test001",
      grossAmountIdr: 49_000,
      discountAmountIdr: 9_800,
      channelFeeIdr: 275,
      totalAmountIdr: 39_475,
      couponCode: "HEMAT20",
      paymentChannel: "QRIS",
      providerReference: "AL_TX_001",
      expiresAtMs: Date.UTC(2026, 11, 23, 5, 0, 0),
    };

    const pdf1 = await generatePluginAddonReceiptPdf(input);
    const pdf2 = await generatePluginAddonReceiptPdf(input);
    expect(pdf1.sha256Hex).toBe(pdf2.sha256Hex);
    expect(pdf1.byteLength).toBeGreaterThan(500);
    expect(new TextDecoder().decode(pdf1.bytes.slice(0, 5))).toBe("%PDF-");
    expect(pdf1.r2ObjectKey).toBe("platform/plugin-receipts/2026/INV-PLG-2026-000007.pdf");
    expect(pdf1.nonPkpNotice).toContain("belum PKP");
  });
});

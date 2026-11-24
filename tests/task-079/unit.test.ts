import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateOfferingAttributes } from "../../packages/core/src/catalog/index.ts";
import {
  attachVehicleShowroomToDraftSnapshotJson,
  attachVehicleShowroomToPublishedSnapshotJson,
  buildGatedVehicleCreditEstimateTable,
  buildVehicleInquiryWhatsAppHref,
  computeStaticVehicleCreditEstimateTable,
  extractVehicleShowroomFromSnapshotJson,
  filterVehicleGridItems,
  formatFlatAnnualRateBpsLabel,
  formatVehicleDateOnlyIndonesian,
  formatVehiclePriceLabel,
  normalizeVehicleDisplayModel,
  normalizeVehicleShowroomModel,
  roundHalfUpDiv,
  shouldRenderVehicleCreditTable,
  toCatalogVehicleAttributes,
  toCatalogVehiclePricing,
  validateVehicleShowroomAttributes,
  VEHICLE_CREDIT_DISCLAIMER,
  VehicleValidationError,
  type VehicleShowroomAttributes,
} from "../../packages/core/src/catalog/vehicle.ts";
import { generateSchemaGraph } from "../../packages/core/src/schema-generator.ts";
import { handleDashboardVehiclesApiRequest } from "../../apps/web/src/pages/dashboard/[handle]/catalog/vehicles/_api-handler.ts";
import { evaluateVehiclesSsrGate } from "../../apps/web/src/pages/dashboard/[handle]/catalog/vehicles/_ssr-gate.ts";

const root = path.resolve(import.meta.dirname, "../..");

const ACTIVE_TENANT = {
  tenantHandle: "bintang-motor",
  tenantStatus: "active" as const,
  primaryHost: "www.bintangmotor.id",
  primaryHostKind: "custom" as const,
  primaryHostStatus: "active" as const,
  primaryHostSslStatus: "active" as const,
  primaryHostVerified: true,
  verifiedTenantHosts: ["www.bintangmotor.id", "bintang-motor.situsku.click"],
};

function buildUsedCarFixture(
  overrides: Partial<VehicleShowroomAttributes> = {},
): VehicleShowroomAttributes {
  return {
    vehicleCategory: "car",
    brand: "Toyota",
    model: "Kijang Innova Zenix",
    variant: "Q Hybrid Modellista",
    year: 2024,
    condition: "used",
    mileageKm: 18500,
    transmission: "cvt",
    fuel: "hybrid",
    bodyType: "mpv",
    color: "Putih Mutiara",
    seats: 7,
    engineCc: 1987,
    location: "Jakarta Selatan",
    plateRegion: "B (Jakarta)",
    stnkTaxExpiryDate: "2027-08-15",
    ownershipCount: 1,
    priceModel: "fixed",
    priceIdr: 485_000_000,
    negotiable: true,
    unitStatus: "available",
    hideSoldInGrids: false,
    otrPriceNote: "Harga OTR Jakarta, servis rutin bengkel resmi.",
    salesWhatsappOverride: "+62 812-3456-7890",
    creditEstimate: {
      enabled: true,
      flatAnnualRateBps: 650,
      dpPercents: [30, 20, 40],
      tenorMonths: [48, 12, 36, 24],
    },
    ...overrides,
  };
}

function buildNewMotorcycleFixture(
  overrides: Partial<VehicleShowroomAttributes> = {},
): VehicleShowroomAttributes {
  return {
    vehicleCategory: "motorcycle",
    brand: "Yamaha",
    model: "NMAX Turbo",
    variant: "Tech MAX Ultimate",
    year: 2026,
    condition: "new",
    transmission: "cvt",
    fuel: "bensin",
    bodyType: "matic",
    color: "Magma Black",
    engineCc: 155,
    location: "Bandung",
    priceModel: "fixed",
    priceIdr: 45_250_000,
    negotiable: false,
    unitStatus: "available",
    hideSoldInGrids: false,
    creditEstimate: {
      enabled: true,
      flatAnnualRateBps: 800,
      dpPercents: [20, 30],
      tenorMonths: [12, 24, 36],
    },
    ...overrides,
  };
}

describe("TASK-079: Strict Car & Motorcycle Domain Validation", () => {
  it("validates used cars & new motorcycles across Indonesian body classes and normalizes deterministically", () => {
    const car = validateVehicleShowroomAttributes(buildUsedCarFixture(), { referenceYear: 2026 });
    expect(car.vehicleCategory).toBe("car");
    expect(car.mileageKm).toBe(18500);
    expect(car.ownershipCount).toBe(1);
    expect(car.salesWhatsappOverride).toBe("6281234567890");
    // Sorted deterministically for idempotent persistence
    expect(car.creditEstimate?.dpPercents).toEqual([20, 30, 40]);
    expect(car.creditEstimate?.tenorMonths).toEqual([12, 24, 36, 48]);

    // Idempotent round-trip
    expect(validateVehicleShowroomAttributes(car, { referenceYear: 2026 })).toEqual(car);

    // Indonesian car body types
    for (const bt of [
      "mpv",
      "suv",
      "sedan",
      "hatchback",
      "crossover",
      "double_cabin",
      "pickup",
      "city_car",
      "niaga",
    ] as const) {
      const v = validateVehicleShowroomAttributes(buildUsedCarFixture({ bodyType: bt }), {
        referenceYear: 2026,
      });
      expect(v.bodyType).toBe(bt);
    }

    // Indonesian motorcycle body types
    for (const bt of ["matic", "bebek", "sport", "naked", "trail", "electric"] as const) {
      const m = validateVehicleShowroomAttributes(buildNewMotorcycleFixture({ bodyType: bt }), {
        referenceYear: 2026,
      });
      expect(m.vehicleCategory).toBe("motorcycle");
      expect(m.bodyType).toBe(bt);
      expect(m.mileageKm).toBeUndefined();
    }
  });

  it("STRICTLY rejects mileageKm (even 0) and ownershipCount on condition === 'new' with 422", () => {
    for (const badMileage of [0, 15, 12000]) {
      let caught: unknown;
      try {
        validateVehicleShowroomAttributes(
          { ...buildNewMotorcycleFixture(), mileageKm: badMileage },
          { referenceYear: 2026 },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(VehicleValidationError);
      const err = caught as VehicleValidationError;
      expect(err.status).toBe(422);
      expect(err.fields.some((f) => f.field === "mileageKm")).toBe(true);
    }

    // ownershipCount on new must also fail 422
    expect(() =>
      validateVehicleShowroomAttributes(
        { ...buildNewMotorcycleFixture(), ownershipCount: 1 },
        { referenceYear: 2026 },
      ),
    ).toThrow(VehicleValidationError);

    // used without mileageKm must fail 422
    const usedMissingMileage = { ...buildUsedCarFixture() };
    delete (usedMissingMileage as Record<string, unknown>).mileageKm;
    expect(() =>
      validateVehicleShowroomAttributes(usedMissingMileage, { referenceYear: 2026 }),
    ).toThrow(VehicleValidationError);
  });

  it("validates price models (fixed, from, range min < max, on_request without numeric price) & rejects unknown fields", () => {
    // range valid
    const ranged = validateVehicleShowroomAttributes(
      {
        ...buildUsedCarFixture(),
        priceModel: "range",
        priceIdr: undefined,
        minPriceIdr: 250_000_000,
        maxPriceIdr: 295_000_000,
      },
      { referenceYear: 2026 },
    );
    expect(ranged.minPriceIdr).toBe(250_000_000);
    expect(ranged.maxPriceIdr).toBe(295_000_000);
    expect(formatVehiclePriceLabel(ranged)).toBe("Rp 250.000.000 – Rp 295.000.000 (Nego)");

    // range min >= max rejected
    expect(() =>
      validateVehicleShowroomAttributes(
        {
          ...buildUsedCarFixture(),
          priceModel: "range",
          priceIdr: undefined,
          minPriceIdr: 300_000_000,
          maxPriceIdr: 300_000_000,
        },
        { referenceYear: 2026 },
      ),
    ).toThrow(VehicleValidationError);

    // on_request with numeric price rejected
    expect(() =>
      validateVehicleShowroomAttributes(
        {
          ...buildUsedCarFixture(),
          priceModel: "on_request",
          priceIdr: 250_000_000,
        },
        { referenceYear: 2026 },
      ),
    ).toThrow(VehicleValidationError);

    // on_request valid without numeric price
    const onReq = validateVehicleShowroomAttributes(
      {
        ...buildUsedCarFixture(),
        priceModel: "on_request",
        priceIdr: undefined,
      },
      { referenceYear: 2026 },
    );
    expect(formatVehiclePriceLabel(onReq)).toBe("Hubungi untuk harga");

    // unknown keys rejected (.strict())
    expect(() =>
      validateVehicleShowroomAttributes(
        {
          ...buildUsedCarFixture(),
          leasingApplicationUrl: "https://evil.example/apply",
        },
        { referenceYear: 2026 },
      ),
    ).toThrow(VehicleValidationError);

    // category/bodyType mismatch rejected
    expect(() =>
      validateVehicleShowroomAttributes(
        { ...buildUsedCarFixture(), vehicleCategory: "car", bodyType: "matic" },
        { referenceYear: 2026 },
      ),
    ).toThrow(VehicleValidationError);

    // LOW-1: bodyType "electric" is motorcycle-only and rejected on car
    expect(() =>
      validateVehicleShowroomAttributes(
        { ...buildUsedCarFixture(), vehicleCategory: "car", bodyType: "electric" },
        { referenceYear: 2026 },
      ),
    ).toThrow(VehicleValidationError);

    expect(() =>
      validateVehicleShowroomAttributes(
        { ...buildNewMotorcycleFixture(), vehicleCategory: "motorcycle", bodyType: "mpv" },
        { referenceYear: 2026 },
      ),
    ).toThrow(VehicleValidationError);
  });

  it("enforces year bounds (1950..currentYear+2) and timezone-invariant date-only STNK expiry formatting", () => {
    // Classic 1950 allowed, 1949 rejected, 2028 allowed (for 2026), 2029 rejected
    expect(
      validateVehicleShowroomAttributes(buildUsedCarFixture({ year: 1950 }), {
        referenceYear: 2026,
      }).year,
    ).toBe(1950);
    expect(() =>
      validateVehicleShowroomAttributes(buildUsedCarFixture({ year: 1949 }), {
        referenceYear: 2026,
      }),
    ).toThrow(VehicleValidationError);
    expect(
      validateVehicleShowroomAttributes(buildNewMotorcycleFixture({ year: 2028 }), {
        referenceYear: 2026,
      }).year,
    ).toBe(2028);
    expect(() =>
      validateVehicleShowroomAttributes(buildNewMotorcycleFixture({ year: 2029 }), {
        referenceYear: 2026,
      }),
    ).toThrow(VehicleValidationError);

    // Impossible calendar date rejected
    expect(() =>
      validateVehicleShowroomAttributes(buildUsedCarFixture({ stnkTaxExpiryDate: "2026-02-29" }), {
        referenceYear: 2026,
      }),
    ).toThrow(VehicleValidationError);

    // Pure integer calendar date formatting (zero TZ shift)
    expect(formatVehicleDateOnlyIndonesian("2027-08-15")).toBe("15 Agustus 2027");
    expect(formatVehicleDateOnlyIndonesian("2028-02-29")).toBe("29 Februari 2028");
  });
});

describe("TASK-079: Exact BigInt round_half_up Static Credit-Estimate Math & Visibility Gate", () => {
  it("computes exact round_half_up division for even/odd denominators and exact .5 ties", () => {
    expect(roundHalfUpDiv(1n, 2n)).toBe(1n); // 0.5 -> 1
    expect(roundHalfUpDiv(5n, 2n)).toBe(3n); // 2.5 -> 3
    expect(roundHalfUpDiv(7n, 2n)).toBe(4n); // 3.5 -> 4
    expect(roundHalfUpDiv(7n, 3n)).toBe(2n); // 2.333... -> 2
    expect(roundHalfUpDiv(8n, 3n)).toBe(3n); // 2.666... -> 3
    expect(roundHalfUpDiv(0n, 100n)).toBe(0n);
    expect(roundHalfUpDiv(100_000_005n * 10n, 100n)).toBe(10_000_001n); // 10,000,000.5 -> 10,000,001
  });

  it("matches exact BigInt round_half_up credit fixtures including exact .5 rounding cases", () => {
    // Fixture 1: Standard Rp 250.000.000, 6.5% flat (650 bps), DP [20, 30, 40], Tenor [12, 24, 36, 48]
    const std = computeStaticVehicleCreditEstimateTable({
      priceIdr: 250_000_000,
      flatAnnualRateBps: 650,
      dpPercents: [30, 20, 40],
      tenorMonths: [48, 12, 36, 24],
    });
    expect(std).not.toBeNull();
    expect(std!.flatAnnualRateLabel).toBe("6,5% / tahun (flat)");
    expect(std!.tenorMonths).toEqual([12, 24, 36, 48]);
    expect(std!.rows.map((r) => r.dpPercent)).toEqual([20, 30, 40]);

    // DP 20% = 50,000,000; principal = 200,000,000
    const row20 = std!.rows[0]!;
    expect(row20.dpIdr).toBe(50_000_000);
    expect(row20.principalIdr).toBe(200_000_000);
    // 12m: interest = 200M * 650 * 12 / 120000 = 13,000,000; total = 213,000,000 / 12 = 17,750,000 exact
    expect(row20.installments[0]!.totalInterestIdr).toBe(13_000_000);
    expect(row20.installments[0]!.monthlyInstallmentIdr).toBe(17_750_000);
    expect(row20.installments[0]!.monthlyLabel).toBe("Rp 17.750.000 / bln");
    // 36m: interest = 200M * 650 * 36 / 120000 = 39,000,000; total = 239,000,000 / 36 = 6,638,888.888... -> 6,638,889
    expect(row20.installments[2]!.totalInterestIdr).toBe(39_000_000);
    expect(row20.installments[2]!.monthlyInstallmentIdr).toBe(6_638_889);
    expect(row20.installments[2]!.monthlyLabel).toBe("Rp 6.638.889 / bln");
    // 48m: interest = 52,000,000; total = 252,000,000 / 48 = 5,250,000 exact
    expect(row20.installments[3]!.monthlyInstallmentIdr).toBe(5_250_000);

    // Fixture 2: Exact .5 DP & .5 monthly installment half-up verification
    // price = 10_000_005, dpPct = 10 -> 10_000_005 * 10 / 100 = 1_000_000.5 -> round_half_up = 1_000_001
    // principal = 10_000_005 - 1_000_001 = 9_000_004
    // rate = 0 bps, tenor = 8 -> 9_000_004 / 8 = 1_125_000.5 -> round_half_up = 1_125_001!
    const halfUp = computeStaticVehicleCreditEstimateTable({
      priceIdr: 10_000_005,
      flatAnnualRateBps: 0,
      dpPercents: [10],
      tenorMonths: [8],
    });
    expect(halfUp).not.toBeNull();
    expect(halfUp!.rows[0]!.dpIdr).toBe(1_000_001);
    expect(halfUp!.rows[0]!.principalIdr).toBe(9_000_004);
    expect(halfUp!.rows[0]!.installments[0]!.totalInterestIdr).toBe(0);
    expect(halfUp!.rows[0]!.installments[0]!.monthlyInstallmentIdr).toBe(1_125_001);

    // Fixture 3: Exact .5 totalInterest half-up verification
    // price = 1_250_500, dpPct = 20 -> dp = 250_100, principal = 1_000_400
    // rate = 15 bps, tenor = 10 -> 1_000_400 * 15 * 10 / 120_000 = 150_060_000 / 120_000 = 1250.5 -> 1251!
    const halfInterest = computeStaticVehicleCreditEstimateTable({
      priceIdr: 1_250_500,
      flatAnnualRateBps: 15,
      dpPercents: [20],
      tenorMonths: [10],
    });
    expect(halfInterest!.rows[0]!.installments[0]!.totalInterestIdr).toBe(1251);
    // totalPayable = 1_000_400 + 1251 = 1_001_651 / 10 = 100_165.1 -> 100_165
    expect(halfInterest!.rows[0]!.installments[0]!.monthlyInstallmentIdr).toBe(100_165);

    expect(std!.disclaimer).toBe(VEHICLE_CREDIT_DISCLAIMER);
    expect(formatFlatAnnualRateBpsLabel(650)).toBe("6,5%");
    expect(formatFlatAnnualRateBpsLabel(600)).toBe("6%");
    expect(formatFlatAnnualRateBpsLabel(625)).toBe("6,25%");
  });

  it("rejects >3 DP percents, >4 tenors, duplicate DP/tenors, or out-of-range bps", () => {
    expect(
      computeStaticVehicleCreditEstimateTable({
        priceIdr: 200_000_000,
        flatAnnualRateBps: 650,
        dpPercents: [15, 20, 30, 40], // 4 > max 3
        tenorMonths: [12, 24],
      }),
    ).toBeNull();

    expect(
      computeStaticVehicleCreditEstimateTable({
        priceIdr: 200_000_000,
        flatAnnualRateBps: 650,
        dpPercents: [20, 30],
        tenorMonths: [12, 24, 36, 48, 60], // 5 > max 4
      }),
    ).toBeNull();

    expect(
      computeStaticVehicleCreditEstimateTable({
        priceIdr: 200_000_000,
        flatAnnualRateBps: 650,
        dpPercents: [20, 20], // duplicate
        tenorMonths: [12, 24],
      }),
    ).toBeNull();

    expect(
      computeStaticVehicleCreditEstimateTable({
        priceIdr: 200_000_000,
        flatAnnualRateBps: 3001, // > max 3000
        dpPercents: [20],
        tenorMonths: [24],
      }),
    ).toBeNull();
  });

  it("STRICTLY gates credit-estimate table visibility to published + available + fixed + enabled ONLY", () => {
    const validCredit = {
      enabled: true,
      flatAnnualRateBps: 650,
      dpPercents: [20, 30],
      tenorMonths: [24, 36],
    };

    // Allowed ONLY on published + available + fixed + enabled
    expect(
      shouldRenderVehicleCreditTable({
        publicationStatus: "published",
        unitStatus: "available",
        priceModel: "fixed",
        priceIdr: 250_000_000,
        creditEstimate: validCredit,
      }),
    ).toBe(true);
    expect(
      buildGatedVehicleCreditEstimateTable({
        publicationStatus: "published",
        unitStatus: "available",
        priceModel: "fixed",
        priceIdr: 250_000_000,
        creditEstimate: validCredit,
      }),
    ).not.toBeNull();

    // HIDDEN on draft, booked, sold, from, range, on_request, or disabled
    const blockedCases = [
      { publicationStatus: "draft", unitStatus: "available", priceModel: "fixed", priceIdr: 250_000_000, creditEstimate: validCredit },
      { publicationStatus: "published", unitStatus: "booked", priceModel: "fixed", priceIdr: 250_000_000, creditEstimate: validCredit },
      { publicationStatus: "published", unitStatus: "sold", priceModel: "fixed", priceIdr: 250_000_000, creditEstimate: validCredit },
      { publicationStatus: "published", unitStatus: "available", priceModel: "from", priceIdr: 250_000_000, creditEstimate: validCredit },
      { publicationStatus: "published", unitStatus: "available", priceModel: "range", priceIdr: 250_000_000, creditEstimate: validCredit },
      { publicationStatus: "published", unitStatus: "available", priceModel: "on_request", priceIdr: null, creditEstimate: validCredit },
      { publicationStatus: "published", unitStatus: "available", priceModel: "fixed", priceIdr: 250_000_000, creditEstimate: { ...validCredit, enabled: false } },
    ] as const;

    for (const c of blockedCases) {
      expect(shouldRenderVehicleCreditTable(c)).toBe(false);
      expect(buildGatedVehicleCreditEstimateTable(c)).toBeNull();
    }
  });
});

describe("TASK-079: Grid Filtering, Lossless Snapshots & Legacy Projection", () => {
  it("filters sold units only when hideSoldInGrids is enabled while keeping available & booked", () => {
    const items = [
      { slug: "a", unitStatus: "available" as const, hideSoldInGrids: false },
      { slug: "b", unitStatus: "booked" as const, hideSoldInGrids: false },
      { slug: "c", unitStatus: "sold" as const, hideSoldInGrids: false },
    ];
    expect(filterVehicleGridItems(items, { hideSoldInGrids: false }).map((x) => x.slug)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(filterVehicleGridItems(items, { hideSoldInGrids: true }).map((x) => x.slug)).toEqual([
      "a",
      "b",
    ]);
  });

  it("preserves lossless vehicleShowroomV1 in draft & published snapshot envelopes and projects safely to legacy VehicleAttributes", () => {
    const moto = validateVehicleShowroomAttributes(
      buildNewMotorcycleFixture({ bodyType: "naked", year: 2026 }),
      { referenceYear: 2026 },
    );

    const draftJson = attachVehicleShowroomToDraftSnapshotJson(
      JSON.stringify({ writeToken: "wt_1", data: { title: "Demo" } }),
      moto,
    );
    const extractedDraft = extractVehicleShowroomFromSnapshotJson(draftJson);
    expect(extractedDraft).toEqual(moto);

    const pubJson = attachVehicleShowroomToPublishedSnapshotJson(
      JSON.stringify({ schemaVersion: 1, data: { title: "Demo" } }),
      moto,
    );
    expect(pubJson).not.toBeNull();
    expect(extractVehicleShowroomFromSnapshotJson(pubJson)).toEqual(moto);

    // Projected legacy attributes pass strict catalog/index VehicleAttributesSchema
    const legacy = toCatalogVehicleAttributes(moto);
    expect(() => validateOfferingAttributes("vehicle", legacy)).not.toThrow();
    expect(legacy.bodyType).toBe("other"); // naked preserved in vehicleShowroomV1, mapped safely in legacy
    expect(legacy.mileageKm).toBeUndefined();

    const pricing = toCatalogVehiclePricing(moto);
    expect(pricing).toEqual({
      priceMode: "fixed",
      price: 45_250_000,
      priceMax: null,
      negotiable: false,
    });

    // Normalizer handles legacy VehicleAttributes fallback truthfully WITHOUT fabricating missing specs
    const normalizedFromLegacy = normalizeVehicleDisplayModel(legacy, {
      priceMode: "fixed",
      price: 45_250_000,
      unitStatus: "available",
    });
    expect(normalizedFromLegacy.brand).toBe("Yamaha");
    expect(normalizedFromLegacy.condition).toBe("new");
    expect(normalizedFromLegacy.mileageKm).toBeNull();

    // MEDIUM-1: Partial/empty legacy row MUST NOT invent mileageKm: 0, current year, "Standar", "Indonesia", or brand
    const emptyPartial = normalizeVehicleDisplayModel(
      { brand: "Toyota", condition: "used" },
      { priceMode: "on_request", unitStatus: "available" },
    );
    expect(emptyPartial.brand).toBe("Toyota");
    expect(emptyPartial.model).toBeNull();
    expect(emptyPartial.year).toBeNull();
    expect(emptyPartial.mileageKm).toBeNull();
    expect(emptyPartial.color).toBeNull();
    expect(emptyPartial.location).toBeNull();
    expect(emptyPartial.transmission).toBeNull();
    expect(emptyPartial.fuel).toBeNull();
    expect(normalizeVehicleShowroomModel({ brand: "Toyota", condition: "used" })).toBeNull();

    // Direct WhatsApp inquiry builder
    const waHref = buildVehicleInquiryWhatsAppHref({
      salesWhatsappOverride: "0812-3456-7890",
      vehicleTitle: "Yamaha NMAX Turbo",
      unitStatus: "sold",
      canonicalUrl: "https://www.bintangmotor.id/kendaraan/yamaha-nmax-turbo",
    });
    expect(waHref).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/);
    expect(decodeURIComponent(waHref!)).toContain("TERJUAL");
  });
});

describe("TASK-079: Visible-Fact Vehicle / Car / Motorcycle JSON-LD", () => {
  it("emits Car (InStock/SoldOut/omitted-on-booked), Motorcycle (no mileage on new), omits Offer on on_request, and emits zero financing schema", () => {
    // 1. Available used car -> Car + InStock + mileage + zero financing schema
    const availCar = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/kendaraan/toyota-innova-zenix-2024",
        tenant: ACTIVE_TENANT,
      },
      siteName: "Bintang Motor",
      offering: {
        offeringType: "vehicle",
        title: "Toyota Kijang Innova Zenix Q Hybrid 2024",
        priceMode: "fixed",
        price: 485_000_000,
        ctaMode: "whatsapp",
        unitStatus: "available",
        attributes: buildUsedCarFixture(),
      },
    });
    const availNode = availCar.nodes.find((n) => n["@type"] === "Car");
    expect(availNode).toMatchObject({
      "@type": "Car",
      brand: { "@type": "Brand", name: "Toyota" },
      model: "Kijang Innova Zenix",
      vehicleModelDate: "2024",
      itemCondition: "https://schema.org/UsedCondition",
      mileageFromOdometer: { "@type": "QuantitativeValue", value: 18500, unitCode: "KMT" },
      vehicleTransmission: "CVT",
      fuelType: "Hybrid",
      bodyType: "MPV",
      color: "Putih Mutiara",
      vehicleSeatingCapacity: 7,
      offers: {
        "@type": "Offer",
        priceCurrency: "IDR",
        price: 485_000_000,
        availability: "https://schema.org/InStock",
      },
    });
    expect(availCar.jsonLd).not.toContain("LoanOrCredit");
    expect(availCar.jsonLd).not.toContain("flatAnnualRateBps");
    expect(availCar.jsonLd).not.toContain("aggregateRating");
    expect(availCar.jsonLd).not.toContain('"review"');

    // 2. Sold car -> SoldOut
    const soldCar = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/kendaraan/toyota-innova-zenix-sold",
        tenant: ACTIVE_TENANT,
      },
      siteName: "Bintang Motor",
      offering: {
        offeringType: "vehicle",
        title: "Toyota Kijang Innova Zenix 2024",
        priceMode: "fixed",
        price: 485_000_000,
        ctaMode: "whatsapp",
        unitStatus: "sold",
        attributes: buildUsedCarFixture({ unitStatus: "sold" }),
      },
    });
    const soldNode = soldCar.nodes.find((n) => n["@type"] === "Car") as Record<string, unknown>;
    expect((soldNode.offers as Record<string, unknown>).availability).toBe(
      "https://schema.org/SoldOut",
    );

    // 3. Booked motorcycle -> Motorcycle + OMIT availability completely (NEVER Reserved, NEVER InStock!)
    const bookedMoto = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/kendaraan/yamaha-nmax-turbo-2026",
        tenant: ACTIVE_TENANT,
      },
      siteName: "Bintang Motor",
      offering: {
        offeringType: "vehicle",
        title: "Yamaha NMAX Turbo 2026",
        priceMode: "fixed",
        price: 45_250_000,
        ctaMode: "whatsapp",
        unitStatus: "booked",
        attributes: buildNewMotorcycleFixture({ unitStatus: "booked" }),
      },
    });
    const motoNode = bookedMoto.nodes.find((n) => n["@type"] === "Motorcycle") as Record<
      string,
      unknown
    >;
    expect(motoNode).toBeDefined();
    expect(motoNode.itemCondition).toBe("https://schema.org/NewCondition");
    expect(motoNode.mileageFromOdometer).toBeUndefined();
    expect((motoNode.offers as Record<string, unknown>).price).toBe(45_250_000);
    expect((motoNode.offers as Record<string, unknown>).availability).toBeUndefined();
    expect(bookedMoto.jsonLd).not.toContain("Reserved");
    expect(bookedMoto.jsonLd).not.toContain("InStock");

    // 4. on_request -> OMIT offers completely
    const onReqRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/kendaraan/toyota-alphard-on-request",
        tenant: ACTIVE_TENANT,
      },
      siteName: "Bintang Motor",
      offering: {
        offeringType: "vehicle",
        title: "Toyota Alphard HEV 2026",
        priceMode: "on_request",
        price: null,
        ctaMode: "whatsapp",
        unitStatus: "available",
        attributes: {
          ...buildUsedCarFixture(),
          priceModel: "on_request",
          priceIdr: undefined,
        },
      },
    });
    const onReqNode = onReqRes.nodes.find((n) => n["@type"] === "Car") as Record<string, unknown>;
    expect(onReqNode.offers).toBeUndefined();
  });
});

describe("TASK-079: SSR Gate, API Security Order & Theme/Base-Nova Guardrails", () => {
  it("enforces fail-closed SSR gate rules for vehicles dashboard", () => {
    const nonApp = evaluateVehiclesSsrGate({
      rawHandle: "bintang-motor",
      surface: "tenant",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u1" },
      authorized: { tenantId: "t1", handle: "bintang-motor", role: "owner", tenantStatus: "active" },
    });
    expect(nonApp.ok).toBe(false);
    if (!nonApp.ok) expect(nonApp.status).toBe(404);

    const suspended = evaluateVehiclesSsrGate({
      rawHandle: "bintang-motor",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u1" },
      authorized: {
        tenantId: "t1",
        handle: "bintang-motor",
        role: "owner",
        tenantStatus: "suspended",
      },
    });
    expect(suspended.ok).toBe(false);
    if (!suspended.ok) expect(suspended.status).toBe(302);

    const locked = evaluateVehiclesSsrGate({
      rawHandle: "bintang-motor",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u1" },
      authorized: { tenantId: "t1", handle: "bintang-motor", role: "owner", tenantStatus: "locked" },
    });
    expect(locked.ok).toBe(true);
    if (locked.ok) {
      expect(locked.readOnly).toBe(true);
      expect(locked.canWriteVehicles).toBe(false);
      expect(locked.canPublishVehicles).toBe(false);
    }
  });

  it("enforces host 404, POST-only 405, CSRF 403, and 401 auth BEFORE body parsing", async () => {
    const runtimeEnv = {
      APP_ENV: "production" as const,
      PLATFORM_DOMAIN: "punyasitus.com",
      AUTH_SECRET: "test-secret-at-least-32-chars-long-000",
      PLATFORM_DB: {
        prepare: () => ({
          bind: () => ({ first: async () => null, all: async () => ({ results: [] }), raw: async () => [] }),
        }),
      } as unknown as D1Database,
    };

    // Tenant host -> neutral 404
    const wrongHost = await handleDashboardVehiclesApiRequest(
      "bintang-motor",
      new Request("https://bintang-motor.situsku.click/dashboard/bintang-motor/catalog/vehicles/api", {
        method: "POST",
      }),
      runtimeEnv,
    );
    expect(wrongHost.status).toBe(404);

    // GET -> 405 with Allow: POST
    const wrongMethod = await handleDashboardVehiclesApiRequest(
      "bintang-motor",
      new Request("https://app.punyasitus.com/dashboard/bintang-motor/catalog/vehicles/api", {
        method: "GET",
      }),
      runtimeEnv,
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("POST");

    // Bad origin -> 403 CSRF
    const badCsrf = await handleDashboardVehiclesApiRequest(
      "bintang-motor",
      new Request("https://app.punyasitus.com/dashboard/bintang-motor/catalog/vehicles/api", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
      runtimeEnv,
    );
    expect(badCsrf.status).toBe(403);

    // Unauthenticated with intentionally invalid JSON body -> MUST return 401 BEFORE parsing body!
    const unauth = await handleDashboardVehiclesApiRequest(
      "bintang-motor",
      new Request("https://app.punyasitus.com/dashboard/bintang-motor/catalog/vehicles/api", {
        method: "POST",
        headers: {
          Origin: "https://app.punyasitus.com",
          "X-PunyaSitus-CSRF": "1",
          "Content-Type": "application/json",
        },
        body: "{not-valid-json",
      }),
      runtimeEnv,
      { authenticatedUser: null },
    );
    expect(unauth.status).toBe(401);

    // MEDIUM-3: authenticatedUser WITHOUT authenticatedSessionId (and no live session cookie) MUST fail closed with 401!
    const missingSessionId = await handleDashboardVehiclesApiRequest(
      "bintang-motor",
      new Request("https://app.punyasitus.com/dashboard/bintang-motor/catalog/vehicles/api", {
        method: "POST",
        headers: {
          Origin: "https://app.punyasitus.com",
          "X-PunyaSitus-CSRF": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "save_draft" }),
      }),
      runtimeEnv,
      { authenticatedUser: { id: "user_1" }, authenticatedSessionId: null },
    );
    expect(missingSessionId.status).toBe(401);

    // LOW-3: Human-readable bodyType in Vehicle JSON-LD for double_cabin
    const doubleCabinRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/kendaraan/toyota-hilux-double-cabin-2025",
        tenant: ACTIVE_TENANT,
      },
      siteName: "Bintang Motor",
      offering: {
        offeringType: "vehicle",
        title: "Toyota Hilux 4x4 Double Cabin 2025",
        priceMode: "fixed",
        price: 530_000_000,
        ctaMode: "whatsapp",
        unitStatus: "available",
        attributes: buildUsedCarFixture({ bodyType: "double_cabin", model: "Hilux" }),
      },
    });
    const dcNode = doubleCabinRes.nodes.find((n) => n["@type"] === "Car") as Record<string, unknown>;
    expect(dcNode.bodyType).toBe("Double Cabin");
  });

  it("contains ZERO forbidden task-013 / task-032 substrings in SectionVehiclesGrid.astro and dashboard vehicles files", () => {
    const sectionFile = path.join(
      root,
      "apps/web/src/themes/default/sections/SectionVehiclesGrid.astro",
    );
    const sectionContent = fs.readFileSync(sectionFile, "utf8");
    const forbiddenPublicPatterns = [
      /@radix-ui\//,
      /@base-ui\/react/,
      /from\s+["']react["']/,
      /@punyasitus\/db/,
      /@punyasitus\/auth/,
      /client:(?:load|idle|visible|only|media)/,
      /components\/ui/,
      /\bSparkles(?:Icon)?\b/,
      /\basChild\b/,
      /<script\b/i,
    ];
    for (const pattern of forbiddenPublicPatterns) {
      expect(sectionContent, `SectionVehiclesGrid.astro matched ${pattern}`).not.toMatch(pattern);
    }

    const vehiclesDashDir = path.join(
      root,
      "apps/web/src/pages/dashboard/[handle]/catalog/vehicles",
    );
    for (const file of fs.readdirSync(vehiclesDashDir)) {
      const content = fs.readFileSync(path.join(vehiclesDashDir, file), "utf8");
      expect(content).not.toMatch(/@radix-ui\//);
      expect(content).not.toMatch(/\basChild\b/);
      expect(content).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }
  });
});

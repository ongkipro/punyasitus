import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCanPublishTravelPackage,
  attachTravelPackageToDraftSnapshotJson,
  attachTravelPackageToPublishedSnapshotJson,
  buildTravelInquiryWhatsAppHref,
  canPublishTravelPackage,
  compareDateOnly,
  extractTravelPackageFromSnapshotJson,
  formatTravelDateOnlyIndonesian,
  formatTravelDateRangeIndonesian,
  formatTravelDurationLabel,
  isValidReligiousTravelLicenseNumber,
  isValidTravelDateOnly,
  MAX_TRAVEL_DEPARTURES,
  MAX_TRAVEL_ITINERARY_DAYS,
  normalizeTravelDisplayModel,
  parseCalendarDateOnly,
  stripUntrustedTravelGateFields,
  toCatalogTourAttributes,
  TravelPublishGateError,
  TravelValidationError,
  UMRAH_COUNSEL_GATE_REQUIRED,
  UMRAH_LICENSE_REQUIRED,
  UMRAH_OPERATOR_VERIFICATION_REQUIRED,
  validateTravelPackageAttributes,
  type TravelPackageAttributes,
} from "../../packages/core/src/catalog/travel.ts";
import { validateOfferingAttributes } from "../../packages/core/src/catalog/index.ts";
import { generateSchemaGraph } from "../../packages/core/src/schema-generator.ts";
import { evaluateTravelSsrGate } from "../../apps/web/src/pages/dashboard/[handle]/catalog/travel/_ssr-gate.ts";
import { handleDashboardTravelApiRequest } from "../../apps/web/src/pages/dashboard/[handle]/catalog/travel/_api-handler.ts";

const root = path.resolve(import.meta.dirname, "../..");

function buildValidGeneralTour(): TravelPackageAttributes {
  return {
    packageKind: "general_tour",
    destination: "Bali & Nusa Penida",
    durationDays: 4,
    durationNights: 3,
    departureCity: "Jakarta (CGK)",
    airline: "Garuda Indonesia",
    transport: "Bus Pariwisata AC Eksekutif",
    hotels: [
      {
        name: "Grand Kuta Heritage",
        city: "Badung, Bali",
        starClass: 4,
        distanceNote: "5 menit dari Pantai Kuta",
      },
    ],
    inclusions: [
      "Tiket pesawat pulang pergi kelas ekonomi",
      "Hotel bintang 4 sekamar berdua",
      "Transportasi darat ber-AC dan pemandu resmi",
    ],
    exclusions: [
      "Pengeluaran pribadi di luar program",
      "Tipping pemandu & pengemudi",
    ],
    travelInsurance: "Asuransi perjalanan domestik standar Permenpar 6/2025",
    itinerary: [
      {
        dayNumber: 1,
        title: "Kedatangan Denpasar & Sunset Uluwatu",
        summary: "Penjemputan di Bandara Ngurah Rai, check-in hotel, dan kunjungan sore ke Pura Uluwatu.",
        city: "Badung",
        meals: "Makan Malam",
      },
      {
        dayNumber: 2,
        title: "Eksplorasi Nusa Penida Barat",
        summary: "Menyeberang dengan fast boat menuju Kelingking Beach, Broken Beach, dan Crystal Bay.",
        city: "Nusa Penida",
        meals: "Sarapan, Makan Siang, Makan Malam",
      },
      {
        dayNumber: 3,
        title: "Budaya Ubud & Danau Bedugul",
        summary: "Kunjungan ke Desa Penglipuran, Pura Ulun Danu Beratan, dan pusat oleh-oleh Bali.",
        city: "Ubud",
        meals: "Sarapan, Makan Siang",
      },
      {
        dayNumber: 4,
        title: "Waktu Bebas & Kepulangan",
        summary: "Sarapan di hotel, check-out, dan pengantaran menuju Bandara Ngurah Rai.",
        city: "Denpasar",
        meals: "Sarapan",
      },
    ],
    departures: [
      {
        departureDate: "2026-12-15",
        returnDate: "2026-12-18",
        departureCity: "Jakarta (CGK)",
        label: "Keberangkatan Libur Akhir Tahun",
      },
      {
        departureDate: "2027-01-22",
        returnDate: "2027-01-25",
        departureCity: "Surabaya (SUB)",
        label: "Keberangkatan Grup Reguler",
      },
    ],
  };
}

function buildValidUmrahPackage(overrides: Partial<TravelPackageAttributes> = {}): TravelPackageAttributes {
  return {
    packageKind: "umrah",
    destination: "Makkah & Madinah",
    durationDays: 9,
    durationNights: 8,
    departureCity: "Jakarta (CGK)",
    airline: "Saudia Airlines (Direct CGK–JED)",
    transport: "Bus AC Haramain + Kereta Cepat Haramain",
    hotels: [
      {
        name: "Pullman Zamzam Makkah",
        city: "Makkah",
        starClass: 5,
        distanceNote: "±100 m dari pelataran Masjidil Haram",
      },
      {
        name: "Anwar Al Madinah Movenpick",
        city: "Madinah",
        starClass: 5,
        distanceNote: "±50 m dari Masjid Nabawi",
      },
    ],
    inclusions: [
      "Tiket pesawat internasional PP direct",
      "Akomodasi hotel bintang 5 Makkah & Madinah",
      "Makan 3x sehari menu Nusantara",
      "Pembimbing ibadah (Muthawif) bersertifikat",
    ],
    exclusions: [
      "Pembuatan paspor dan vaksin meningitis",
      "Kelebihan bagasi sesuai ketentuan maskapai",
    ],
    travelInsurance: "Asuransi perjalanan & kesehatan jamaah sesuai ketentuan PPIU",
    officialVisa: "Visa Umrah resmi Kemenag & Siskopatuh",
    skPpiuNumber: "U.128 Tahun 2024",
    itinerary: [
      {
        dayNumber: 1,
        title: "Keberangkatan Jakarta – Madinah",
        summary: "Berkumpul di Terminal 3 Soekarno-Hatta, penerbangan langsung menuju Madinah, check-in hotel.",
        city: "Madinah",
        meals: "Makan di Pesawat, Makan Malam",
      },
      {
        dayNumber: 2,
        title: "Ziarah Masjid Nabawi & Raudhah",
        summary: "Ibadah di Masjid Nabawi dan pendampingan ziarah Raudhah sesuai jadwal Tasreh resmi.",
        city: "Madinah",
        meals: "Sarapan, Makan Siang, Makan Malam",
      },
      {
        dayNumber: 3,
        title: "City Tour Madinah & Miqat Bir Ali",
        summary: "Ziarah Masjid Quba, Jabal Uhud, lalu perjalanan menuju Makkah via Kereta Cepat untuk Umrah pertama.",
        city: "Makkah",
        meals: "Sarapan, Makan Siang, Makan Malam",
      },
    ],
    departures: [
      {
        departureDate: "2026-12-15",
        returnDate: "2026-12-23",
        departureCity: "Jakarta (CGK)",
        label: "Program 9 Hari Akhir Tahun",
      },
    ],
    ...overrides,
  };
}

/**
 * Minimal D1Database double for testing server-side HTTP handler (`handleDashboardTravelApiRequest`)
 * auth/tenant resolution + DEC-042 fail-closed enforcement without touching real DBs.
 */
function createMockPlatformDbForOwner(params: {
  readonly userId: string;
  readonly tenantId: string;
  readonly handle: string;
  readonly organizationId: string;
  readonly tenantStatus?: string;
  readonly operatorVerifiedPpiu?: number;
}): D1Database {
  const tenantStatus = params.tenantStatus ?? "active";
  const makeStmt = (sql: string, _binds: unknown[] = []) => ({
    bind: (...next: unknown[]) => makeStmt(sql, next),
    first: async <T,>() => {
      if (sql.includes("operator_verified_ppiu")) {
        return { operator_verified_ppiu: params.operatorVerifiedPpiu ?? 0 } as unknown as T;
      }
      return null;
    },
    raw: async () => {
      if (sql.includes("tenants") && sql.includes("members")) {
        return [
          [
            params.tenantId,
            params.organizationId,
            params.handle,
            "Wisata Nusantara Tour",
            tenantStatus,
            0,
            null,
            Date.now() + 30 * 86_400_000,
            "mem_owner_1",
            "owner",
          ],
        ];
      }
      return [];
    },
    all: async <T,>() => ({ results: [] as T[], success: true, meta: {} }),
    run: async () => ({ success: true, meta: { changes: 0 } }),
  });

  return {
    prepare: (sql: string) => makeStmt(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("TASK-020: Travel & Umrah Schema Validation & Bounds", () => {
  it("validates structured general tour and Umrah packages and sorts itinerary/departures", () => {
    const raw = buildValidGeneralTour();
    const reversed: TravelPackageAttributes = {
      ...raw,
      itinerary: [...raw.itinerary].reverse(),
      departures: [...(raw.departures ?? [])].reverse(),
    };
    const validated = validateTravelPackageAttributes(reversed);
    expect(validated.itinerary.map((d) => d.dayNumber)).toEqual([1, 2, 3, 4]);
    expect(validated.departures?.map((d) => d.departureDate)).toEqual([
      "2026-12-15",
      "2027-01-22",
    ]);
    expect(formatTravelDurationLabel(validated.durationDays, validated.durationNights)).toBe(
      "4 Hari / 3 Malam",
    );

    // Projects cleanly into existing strict `TourAttributes` schema (zero DB migration, zero suffix corruption)
    const legacy = toCatalogTourAttributes(validated);
    const parsedLegacy = validateOfferingAttributes("tour", legacy);
    expect(parsedLegacy.durationDays).toBe(4);
    expect(parsedLegacy.itinerary).toHaveLength(4);
    expect(parsedLegacy.itinerary?.[0]?.description).toBe(validated.itinerary[0]?.summary);
    expect(parsedLegacy.departures).toHaveLength(2);
    expect(parsedLegacy.departures?.[0]?.note).toBe(validated.departures?.[0]?.label);
    expect("seatsAvailable" in (parsedLegacy.departures?.[0] ?? {})).toBe(false);
  });

  it("preserves ALL structured Travel/Umrah fields 100% losslessly and idempotently across save -> reload -> save -> reload (B2/B3)", () => {
    const initialUmrah = validateTravelPackageAttributes(buildValidUmrahPackage());

    // Save 1 into draft snapshot envelope
    const baseDraftSnapshot = JSON.stringify({
      snapshotVersion: 1,
      resourceType: "offering",
      data: { offeringType: "tour", slug: "paket-umrah-9-hari", title: "Umrah 9 Hari" },
      _draftMetadata: { writeToken: "tok_1" },
    });
    const saved1Json = attachTravelPackageToDraftSnapshotJson(baseDraftSnapshot, initialUmrah);

    // Reload 1
    const reloaded1 = extractTravelPackageFromSnapshotJson(saved1Json);
    expect(reloaded1).toEqual(initialUmrah);

    // Save 2 (re-validate + re-attach)
    const validated2 = validateTravelPackageAttributes(reloaded1);
    const saved2Json = attachTravelPackageToDraftSnapshotJson(saved1Json, validated2);

    // Reload 2 -> byte-for-byte identical; ZERO duplicated city/meals suffixes, ZERO lost fields!
    const reloaded2 = extractTravelPackageFromSnapshotJson(saved2Json);
    expect(reloaded2).toEqual(initialUmrah);
    expect(reloaded2?.packageKind).toBe("umrah");
    expect(reloaded2?.skPpiuNumber).toBe("U.128 Tahun 2024");
    expect(reloaded2?.hotels).toEqual(initialUmrah.hotels);
    expect(reloaded2?.travelInsurance).toBe(initialUmrah.travelInsurance);
    expect(reloaded2?.officialVisa).toBe(initialUmrah.officialVisa);
    expect(reloaded2?.transport).toBe(initialUmrah.transport);
    expect(reloaded2?.itinerary[0]?.summary).toBe(initialUmrah.itinerary[0]?.summary);
    expect(reloaded2?.itinerary[0]?.city).toBe("Madinah");
    expect(reloaded2?.itinerary[0]?.meals).toBe("Makan di Pesawat, Makan Malam");
    expect(reloaded2?.departures?.[0]?.returnDate).toBe("2026-12-23");
    expect(reloaded2?.departures?.[0]?.departureCity).toBe("Jakarta (CGK)");
    expect(reloaded2?.departures?.[0]?.label).toBe("Program 9 Hari Akhir Tahun");

    // Published snapshot outer envelope also preserves exact lossless payload without altering `data`
    const basePublishedJson = JSON.stringify({
      snapshotVersion: 1,
      resourceType: "offering",
      data: { offeringType: "tour", slug: "paket-umrah-9-hari", title: "Umrah 9 Hari" },
      publishedAt: 1700000000000,
      contentModifiedAt: 1700000000000,
    });
    const publishedWithTravel = attachTravelPackageToPublishedSnapshotJson(
      basePublishedJson,
      initialUmrah,
    );
    expect(publishedWithTravel).not.toBeNull();
    expect(extractTravelPackageFromSnapshotJson(publishedWithTravel)).toEqual(initialUmrah);

    // Legacy projection + display normalization is also idempotent (never appends repeated suffixes)
    const legacyOnce = toCatalogTourAttributes(initialUmrah);
    const displayOnce = normalizeTravelDisplayModel(legacyOnce);
    expect(displayOnce.itinerary[0]?.summary).toBe(initialUmrah.itinerary[0]?.summary);
    expect(displayOnce.departures[0]?.label).toBe(initialUmrah.departures?.[0]?.label);
  });

  it("rejects malformed calendar dates, impossible leap days, and timestamps", () => {
    for (const badDate of [
      "2026-02-30",
      "2026-02-29",
      "2026-04-31",
      "2026-13-01",
      "2026-00-15",
      "2026-12-15T00:00:00Z",
      "15-12-2026",
      "2026/12/15",
      "",
    ]) {
      expect(isValidTravelDateOnly(badDate), `Expected "${badDate}" to be rejected`).toBe(false);
      expect(parseCalendarDateOnly(badDate)).toBeNull();
    }

    expect(isValidTravelDateOnly("2028-02-29")).toBe(true);
    expect(parseCalendarDateOnly("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });

    const badPkg = {
      ...buildValidGeneralTour(),
      departures: [{ departureDate: "2026-02-30" }],
    };
    expect(() => validateTravelPackageAttributes(badPkg)).toThrowError(TravelValidationError);
  });

  it("rejects returnDate earlier than departureDate", () => {
    const badPkg = {
      ...buildValidGeneralTour(),
      departures: [{ departureDate: "2026-12-15", returnDate: "2026-12-14" }],
    };
    expect(() => validateTravelPackageAttributes(badPkg)).toThrowError(TravelValidationError);
    expect(compareDateOnly("2026-12-14", "2026-12-15")).toBe(-1);
  });

  it("enforces bounded itinerary (1..30 days), departures (<=24), duration (1..60), and rejects unknown/OTA/forged gate fields", () => {
    expect(() =>
      validateTravelPackageAttributes({ ...buildValidGeneralTour(), itinerary: [] }),
    ).toThrowError(TravelValidationError);

    const thirtyOneDays = Array.from({ length: MAX_TRAVEL_ITINERARY_DAYS + 1 }, (_, i) => ({
      dayNumber: i + 1,
      title: `Hari ${i + 1}`,
      summary: "Aktivitas harian.",
    }));
    expect(() =>
      validateTravelPackageAttributes({
        ...buildValidGeneralTour(),
        durationDays: 35,
        durationNights: 34,
        itinerary: thirtyOneDays,
      }),
    ).toThrowError(TravelValidationError);

    const twentyFiveDeps = Array.from({ length: MAX_TRAVEL_DEPARTURES + 1 }, (_, i) => ({
      departureDate: `2026-12-${String((i % 28) + 1).padStart(2, "0")}`,
    }));
    expect(() =>
      validateTravelPackageAttributes({
        ...buildValidGeneralTour(),
        departures: twentyFiveDeps,
      }),
    ).toThrowError(TravelValidationError);

    expect(() =>
      validateTravelPackageAttributes({
        ...buildValidGeneralTour(),
        durationDays: 61,
        durationNights: 60,
      }),
    ).toThrowError(TravelValidationError);

    expect(() =>
      validateTravelPackageAttributes({
        ...buildValidGeneralTour(),
        durationDays: 3,
        durationNights: 4,
      }),
    ).toThrowError(TravelValidationError);

    expect(() =>
      validateTravelPackageAttributes({
        ...buildValidGeneralTour(),
        departures: [{ departureDate: "2026-12-15", seatsAvailable: 12 }],
      }),
    ).toThrowError(TravelValidationError);

    expect(() =>
      validateTravelPackageAttributes({
        ...buildValidGeneralTour(),
        otaCheckoutUrl: "https://ota.example/book",
      }),
    ).toThrowError(TravelValidationError);

    // Client-forged verification flags are rejected by strict authorable schema & stripped by helper
    const forgedPayload = {
      ...buildValidUmrahPackage(),
      operatorVerified: true,
      umrahCounselApproved: true,
    };
    expect(() => validateTravelPackageAttributes(forgedPayload)).toThrowError(TravelValidationError);
    const stripped = stripUntrustedTravelGateFields(forgedPayload);
    expect("operatorVerified" in stripped).toBe(false);
    expect("umrahCounselApproved" in stripped).toBe(false);
    expect(() => validateTravelPackageAttributes(stripped)).not.toThrow();
  });
});

describe("TASK-020: Timezone-Invariant Date-Only Formatting", () => {
  it("formats 2026-12-15 identically across UTC, Asia/Jakarta, America/Los_Angeles, America/New_York, and Pacific/Auckland", () => {
    const originalTz = process.env.TZ;
    const timezones = [
      "UTC",
      "Asia/Jakarta",
      "America/Los_Angeles",
      "America/New_York",
      "Pacific/Auckland",
    ];
    try {
      for (const tz of timezones) {
        process.env.TZ = tz;
        expect(formatTravelDateOnlyIndonesian("2026-12-15"), `Failed in TZ=${tz}`).toBe(
          "15 Desember 2026",
        );
        expect(formatTravelDateOnlyIndonesian("2027-01-01"), `Failed in TZ=${tz}`).toBe(
          "1 Januari 2027",
        );
        expect(
          formatTravelDateRangeIndonesian("2026-12-15", "2026-12-23"),
          `Failed in TZ=${tz}`,
        ).toBe("15–23 Desember 2026");
        expect(
          formatTravelDateRangeIndonesian("2026-12-28", "2027-01-05"),
          `Failed in TZ=${tz}`,
        ).toBe("28 Desember 2026 – 5 Januari 2027");
      }
    } finally {
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });
});

describe("TASK-020: DEC-042 Umrah & Hajj Server-Trusted Publish Gate (Fail-Closed, B1)", () => {
  it("allows general_tour to publish freely without SK PPIU or operator verification", () => {
    const res = canPublishTravelPackage(buildValidGeneralTour());
    expect(res.allowed).toBe(true);
    expect(res.requiresReligiousTravelGate).toBe(false);
    expect(res.reasons).toEqual([]);
    expect(res.showVerifiedBadge).toBe(false);
    expect(() => assertCanPublishTravelPackage(buildValidGeneralTour())).not.toThrow();
  });

  it("ignores forged client flags on pkg and fails closed unless trustedGateState explicitly confirms both flags", () => {
    // Even if a malicious caller passes forged flags on `pkg`, default trustedGateState is FAIL-CLOSED!
    const forgedPkg = {
      ...buildValidUmrahPackage(),
      operatorVerified: true,
      umrahCounselApproved: true,
    } as unknown as TravelPackageAttributes;

    const deniedByDefault = canPublishTravelPackage(forgedPkg);
    expect(deniedByDefault.allowed).toBe(false);
    expect(deniedByDefault.showVerifiedBadge).toBe(false);
    expect(deniedByDefault.reasons.map((r) => r.code)).toEqual([
      UMRAH_OPERATOR_VERIFICATION_REQUIRED,
      UMRAH_COUNSEL_GATE_REQUIRED,
    ]);

    // Display model NEVER trusts raw forged flags either
    const unverifiedDisplay = normalizeTravelDisplayModel(
      forgedPkg as unknown as Record<string, unknown>,
    );
    expect(unverifiedDisplay.showVerifiedBadge).toBe(false);
    expect(unverifiedDisplay.verifiedLicenseNumber).toBeNull();

    // Missing all 3
    const rAllMissing = canPublishTravelPackage({ packageKind: "umrah" });
    expect(rAllMissing.allowed).toBe(false);
    expect(rAllMissing.reasons.map((r) => r.code)).toEqual([
      UMRAH_LICENSE_REQUIRED,
      UMRAH_OPERATOR_VERIFICATION_REQUIRED,
      UMRAH_COUNSEL_GATE_REQUIRED,
    ]);

    // Operator verified only (counsel not yet approved) -> blocked
    const rNoCounsel = canPublishTravelPackage(buildValidUmrahPackage(), {
      operatorVerified: true,
      umrahCounselApproved: false,
    });
    expect(rNoCounsel.allowed).toBe(false);
    expect(rNoCounsel.reasons.map((r) => r.code)).toEqual([UMRAH_COUNSEL_GATE_REQUIRED]);

    // Placeholder license rejected
    expect(isValidReligiousTravelLicenseNumber("N/A")).toBe(false);
    expect(isValidReligiousTravelLicenseNumber("TBD")).toBe(false);
    expect(isValidReligiousTravelLicenseNumber("---")).toBe(false);
    expect(isValidReligiousTravelLicenseNumber("U.128 Tahun 2024")).toBe(true);

    expect(() => assertCanPublishTravelPackage({ packageKind: "umrah" })).toThrowError(
      TravelPublishGateError,
    );
  });

  it("allows Umrah and Hajj publish ONLY when valid license + server-trusted operatorVerified + umrahCounselApproved all pass", () => {
    const trustedOk = { operatorVerified: true, umrahCounselApproved: true };
    const umrahOk = canPublishTravelPackage(buildValidUmrahPackage(), trustedOk);
    expect(umrahOk.allowed).toBe(true);
    expect(umrahOk.showVerifiedBadge).toBe(true);
    expect(umrahOk.verifiedLicenseKind).toBe("SK PPIU");
    expect(umrahOk.verifiedLicenseNumber).toBe("U.128 Tahun 2024");

    const verifiedDisplay = normalizeTravelDisplayModel(buildValidUmrahPackage(), trustedOk);
    expect(verifiedDisplay.showVerifiedBadge).toBe(true);
    expect(verifiedDisplay.verifiedLicenseNumber).toBe("U.128 Tahun 2024");

    const hajjMissing = canPublishTravelPackage(
      {
        packageKind: "hajj",
        skPpiuNumber: "U.128 Tahun 2024", // PPIU is NOT PIHK!
      },
      trustedOk,
    );
    expect(hajjMissing.allowed).toBe(false);
    expect(hajjMissing.reasons.map((r) => r.code)).toEqual([UMRAH_LICENSE_REQUIRED]);

    const hajjOk = canPublishTravelPackage(
      {
        packageKind: "hajj",
        skPihkNumber: "HK.45 Tahun 2025",
      },
      trustedOk,
    );
    expect(hajjOk.allowed).toBe(true);
    expect(hajjOk.verifiedLicenseKind).toBe("SK PIHK");
    expect(hajjOk.verifiedLicenseNumber).toBe("HK.45 Tahun 2025");
    expect(hajjOk.showVerifiedBadge).toBe(true);
  });

  it("rejects direct HTTP POST publish with forged client operatorVerified/umrahCounselApproved with 422 UMRAH_PUBLISH_BLOCKED (B1)", async () => {
    const platformDb = createMockPlatformDbForOwner({
      userId: "user_owner_1",
      tenantId: "01JTESTTRAVELTENANT0000001",
      handle: "wisata-nusantara",
      organizationId: "org_1",
      operatorVerifiedPpiu: 0,
    });

    let tenantWriteCount = 0;
    const mockTenantDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [], success: true, meta: {} }),
          run: async () => {
            tenantWriteCount += 1;
            return { success: true, meta: { changes: 0 } };
          },
        }),
      }),
      batch: async () => {
        tenantWriteCount += 1;
        return [];
      },
    } as unknown as D1Database;

    const req = new Request(
      "https://app.punyasitus.com/dashboard/wisata-nusantara/catalog/travel/api",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.punyasitus.com",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          action: "publish",
          title: "Paket Umrah Reguler 9 Hari",
          summary: "Program Umrah",
          priceMode: "from",
          price: 29_500_000,
          travel: {
            ...buildValidUmrahPackage(),
            // Malicious client-forged flags MUST be stripped & ignored!
            operatorVerified: true,
            umrahCounselApproved: true,
          },
        }),
      },
    );

    const res = await handleDashboardTravelApiRequest(
      "wisata-nusantara",
      req,
      {
        APP_ENV: "production",
        PLATFORM_DOMAIN: "punyasitus.com",
        PLATFORM_DB: platformDb,
        UMRAH_COUNSEL_APPROVED: "false",
      },
      {
        authenticatedUser: { id: "user_owner_1" },
        activeOrganizationId: "org_1",
        resolveTenantDb: () => mockTenantDb,
      },
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; reasons: Array<{ code: string }> };
    };
    expect(body.error.code).toBe("UMRAH_PUBLISH_BLOCKED");
    expect(body.error.reasons.map((r) => r.code)).toEqual([
      UMRAH_OPERATOR_VERIFICATION_REQUIRED,
      UMRAH_COUNSEL_GATE_REQUIRED,
    ]);
    // Fail-closed: ZERO writes occurred on TenantStore
    expect(tenantWriteCount).toBe(0);
  });

  it("builds valid no-JS WhatsApp inquiry hrefs without OTA checkout links", () => {
    const waHref = buildTravelInquiryWhatsAppHref({
      phone: "0812-3456-7890",
      packageTitle: "Paket Wisata Bali 4H3M",
      departureDate: "2026-12-15",
      canonicalUrl: "https://wisata-nusantara.situsku.click/tour/paket-wisata-bali-4h3m",
    });
    expect(waHref).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/);
    expect(decodeURIComponent(waHref ?? "")).toContain("15 Desember 2026");
  });
});

describe("TASK-020: Visible-Fact TouristTrip JSON-LD (ZERO invented Offer/availability/AggregateRating, M3)", () => {
  it("emits TouristTrip with visible itinerary ItemList, duration, and upcoming date-only departures only", () => {
    const pkg = buildValidGeneralTour();
    const res = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/tour/wisata-bali-4h3m",
        tenant: {
          tenantHandle: "wisata-nusantara",
          tenantStatus: "active",
          primaryHost: "wisatanusantara.id",
          primaryHostKind: "custom",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
          verifiedTenantHosts: ["wisatanusantara.id", "wisata-nusantara.situsku.click"],
        },
        siteVisibility: "public",
        resourceState: "published",
      },
      siteName: "Wisata Nusantara Tour",
      business: {
        businessName: "Wisata Nusantara Tour",
        businessCategory: "TravelAgency",
      },
      pageTitle: "Paket Wisata Bali & Nusa Penida 4H3M",
      offering: {
        offeringType: "tour",
        title: "Paket Wisata Bali & Nusa Penida 4H3M",
        summary: "Perjalanan 4 hari 3 malam termasuk hotel bintang 4 dan asuransi perjalanan.",
        priceMode: "from",
        price: 4_850_000,
        ctaMode: "whatsapp",
        attributes: {
          ...pkg,
          departures: [
            { departureDate: "2026-01-10", label: "Jadwal lampau" },
            ...(pkg.departures ?? []),
          ],
        },
      },
      now: "2026-11-24",
      timezone: "Asia/Jakarta",
    });

    expect(res.emitted).toBe(true);
    const tripNode = res.nodes.find((n) => n["@type"] === "TouristTrip");
    expect(tripNode).toBeDefined();
    expect(tripNode?.duration).toBe("P4D");
    expect(tripNode?.departureTime).toEqual(["2026-12-15", "2027-01-22"]);

    const itinerary = tripNode?.itinerary as {
      "@type": string;
      numberOfItems: number;
      itemListElement: Array<{
        "@type": string;
        position: number;
        name: string;
        description?: string;
      }>;
    };
    expect(itinerary["@type"]).toBe("ItemList");
    expect(itinerary.numberOfItems).toBe(4);
    expect(itinerary.itemListElement[0]).toEqual({
      "@type": "ListItem",
      position: 1,
      name: "Kedatangan Denpasar & Sunset Uluwatu",
      description:
        "Penjemputan di Bandara Ngurah Rai, check-in hotel, dan kunjungan sore ke Pura Uluwatu.",
    });

    expect(tripNode).not.toHaveProperty("offers");
    expect(tripNode).not.toHaveProperty("price");
    expect(tripNode).not.toHaveProperty("availability");
    expect(tripNode).not.toHaveProperty("aggregateRating");
    expect(tripNode).not.toHaveProperty("review");
    expect(res.jsonLd).not.toContain('"Offer"');
    expect(res.jsonLd).not.toContain('"AggregateRating"');
    expect(res.jsonLd).not.toContain('"Review"');
    expect(res.jsonLd).not.toContain("2026-01-10");
  });

  it("caps JSON-LD itinerary at 30 days and strips control-char titles identically to visible HTML (M3)", () => {
    const oversizedItinerary = Array.from({ length: 35 }, (_, i) => ({
      dayNumber: i + 1,
      title: i === 1 ? "Hari\u0007Rusak" : `Agenda Hari ${i + 1}`,
      summary: `Ringkasan hari ${i + 1}`,
    }));

    const displayModel = normalizeTravelDisplayModel({
      durationDays: 35,
      itinerary: oversizedItinerary,
    });

    const schemaRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/tour/ekspedisi-panjang",
        tenant: {
          tenantHandle: "wisata-nusantara",
          tenantStatus: "active",
          primaryHost: "wisatanusantara.id",
          primaryHostKind: "custom",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
          verifiedTenantHosts: ["wisatanusantara.id"],
        },
        siteVisibility: "public",
        resourceState: "published",
      },
      siteName: "Wisata Nusantara Tour",
      offering: {
        offeringType: "tour",
        title: "Ekspedisi Nusantara",
        attributes: {
          durationDays: 35,
          itinerary: oversizedItinerary,
        },
      },
    });

    const tripNode = schemaRes.nodes.find((n) => n["@type"] === "TouristTrip");
    const ldItinerary = tripNode?.itinerary as {
      numberOfItems: number;
      itemListElement: Array<{ position: number; name: string }>;
    };

    // Both visible HTML model and JSON-LD drop the control-char title & cap at 30 days (29 valid items)
    expect(displayModel.itinerary).toHaveLength(29);
    expect(ldItinerary.numberOfItems).toBe(29);
    expect(ldItinerary.itemListElement.map((e) => e.position)).toEqual(
      displayModel.itinerary.map((d) => d.dayNumber),
    );
    expect(ldItinerary.itemListElement.some((e) => e.position > 30)).toBe(false);
  });
});

describe("TASK-020: SSR Auth/Tenant Gate & Public Section Boundary Guardrails", () => {
  it("returns neutral 404 for foreign tenants/unauthenticated and read-only for locked tenants", () => {
    const foreign = evaluateTravelSsrGate({
      rawHandle: "tenant-b",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u1" },
      authorized: {
        tenantId: "t1",
        handle: "tenant-a",
        role: "owner",
        tenantStatus: "active",
      },
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.status).toBe(404);

    const locked = evaluateTravelSsrGate({
      rawHandle: "tenant-a",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u1" },
      authorized: {
        tenantId: "t1",
        handle: "tenant-a",
        role: "owner",
        tenantStatus: "locked",
      },
    });
    expect(locked.ok).toBe(true);
    if (locked.ok) {
      expect(locked.isLocked).toBe(true);
      expect(locked.readOnly).toBe(true);
      expect(locked.canWriteTravel).toBe(false);
      expect(locked.canPublishTravel).toBe(false);
    }

    const activeOwner = evaluateTravelSsrGate({
      rawHandle: "tenant-a",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u1" },
      authorized: {
        tenantId: "t1",
        handle: "tenant-a",
        role: "owner",
        tenantStatus: "active",
      },
    });
    expect(activeOwner.ok).toBe(true);
    if (activeOwner.ok) {
      expect(activeOwner.canWriteTravel).toBe(true);
      expect(activeOwner.canPublishTravel).toBe(true);
    }
  });

  it("enforces zero forbidden substrings in SectionTravelItinerary.astro and base-nova hygiene in dashboard", () => {
    const sectionFile = path.join(
      root,
      "apps/web/src/themes/default/sections/SectionTravelItinerary.astro",
    );
    const sectionContent = fs.readFileSync(sectionFile, "utf8");

    const sectionForbidden = [
      /@radix-ui\//,
      /@base-ui\/react/,
      /react/i,
      /@punyasitus\/db/,
      /@punyasitus\/auth/,
      /client:/,
      /components\/ui/,
      /\bSparkles(?:Icon)?\b/,
      /\basChild\b/,
    ];
    for (const pattern of sectionForbidden) {
      expect(sectionContent, `SectionTravelItinerary.astro matched ${pattern}`).not.toMatch(pattern);
    }

    const travelDashDir = path.join(
      root,
      "apps/web/src/pages/dashboard/[handle]/catalog/travel",
    );
    for (const entry of fs.readdirSync(travelDashDir)) {
      const content = fs.readFileSync(path.join(travelDashDir, entry), "utf8");
      expect(content).not.toMatch(/@radix-ui\//);
      expect(content).not.toMatch(/\basChild\b/);
      expect(content).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }
  });
});

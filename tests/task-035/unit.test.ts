import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  attachServiceConsultationToDraftSnapshotJson,
  attachServiceConsultationToPublishedSnapshotJson,
  buildSpecialistWhatsAppHref,
  extractServiceConsultationFromSnapshotJson,
  formatIdrCurrency,
  formatServicePriceLabel,
  MAX_SERVICE_PRICING_TIERS,
  MAX_SERVICE_PROCESS_STEPS,
  MAX_SERVICE_TIER_DELIVERABLES,
  normalizeServiceDisplayModel,
  resolveServiceHeadlinePricing,
  sanitizeSpecialistPrefilledMessage,
  SERVICE_INQUIRY_PRICE_LABEL,
  ServiceValidationError,
  toCatalogServiceAttributes,
  validateServiceConsultationAttributes,
  type ServiceConsultationAttributes,
} from "../../packages/core/src/catalog/service.ts";
import { validateOfferingAttributes } from "../../packages/core/src/catalog/index.ts";
import { getCatalogOfferingById } from "../../packages/db/src/catalog/index.ts";
import { generateSchemaGraph } from "../../packages/core/src/schema-generator.ts";
import { evaluateServicesSsrGate } from "../../apps/web/src/pages/dashboard/[handle]/catalog/services/_ssr-gate.ts";
import {
  handleDashboardServicesApiRequest,
  loadFrozenPublishedServiceBySlug,
  loadLosslessDraftServiceMap,
  persistLosslessDraftServiceEnvelope,
  persistLosslessPublishedServiceEnvelope,
} from "../../apps/web/src/pages/dashboard/[handle]/catalog/services/_api-handler.ts";

const root = path.resolve(import.meta.dirname, "../..");

function buildValidFromService(
  overrides: Partial<ServiceConsultationAttributes> = {},
): ServiceConsultationAttributes {
  return {
    pricingMode: "from",
    basePriceIdr: 2_500_000,
    serviceArea: "Jabodetabek & Seluruh Indonesia",
    turnaround: "7–14 hari kerja",
    serviceMode: "hybrid",
    warranty: "Revisi minor 14 hari setelah serah terima",
    pricingTiers: [
      {
        name: "Paket Pendampingan UMKM",
        pricingMode: "from",
        priceIdr: 2_500_000,
        billingUnit: "per proyek",
        turnaroundLabel: "7 hari kerja",
        summary: "Audit kepatuhan pajak dasar dan penyusunan SPT tahunan badan.",
        deliverables: [
          "Review laporan keuangan 12 bulan",
          "Penyusunan rekonsiliasi fiskal",
          "Pendampingan pelaporan SPT Tahunan",
        ],
      },
      {
        name: "Paket Audit Menengah",
        pricingMode: "fixed",
        priceIdr: 5_000_000,
        billingUnit: "per proyek",
        turnaroundLabel: "14 hari kerja",
        summary: "Audit menyeluruh beserta rekomendasi efisiensi pajak legal.",
        highlighted: true,
        deliverables: [
          "Audit kepatuhan PPh & PPN menyeluruh",
          "Laporan manajemen & mitigasi risiko",
          "Sesi presentasi bersama direksi",
        ],
      },
      {
        name: "Paket Korporasi Kustom",
        pricingMode: "inquiry",
        billingUnit: "sesuai ruang lingkup",
        summary: "Pendampingan multi-entitas dan restrukturisasi perpajakan.",
        deliverables: ["Tim konsultan dedikasi", "Pendampingan pemeriksaan pajak"],
      },
    ],
    processSteps: [
      {
        stepNumber: 1,
        title: "Konsultasi Awal & Pemetaan",
        summary: "Diskusi profil usaha, kendala perpajakan, dan ruang lingkup dokumen.",
        estimatedDuration: "1 hari kerja",
      },
      {
        stepNumber: 2,
        title: "Proposal & Transparansi Biaya",
        summary: "Pengiriman rincian biaya tertulis, daftar deliverables, dan jadwal kerja.",
        estimatedDuration: "1–2 hari kerja",
      },
      {
        stepNumber: 3,
        title: "Eksekusi & Review Berkala",
        summary: "Pemeriksaan data keuangan dan koordinasi temuan secara rutin.",
        estimatedDuration: "5–10 hari kerja",
      },
      {
        stepNumber: 4,
        title: "Serah Terima & Presentasi Hasil",
        summary: "Penyerahan laporan final lengkap serta rekomendasi tindak lanjut.",
        estimatedDuration: "1 hari kerja",
      },
    ],
    specialistCta: {
      specialistName: "Rina Kartika, BKP",
      specialistRole: "Konsultan Pajak Senior",
      whatsappNumber: "+62 812-9876-5432",
      ctaLabel: "Konsultasi dengan Bu Rina",
      prefilledMessage: "Halo Bu Rina, saya ingin konsultasi layanan audit pajak perusahaan.",
    },
    ...overrides,
  };
}

function buildValidInquiryService(): ServiceConsultationAttributes {
  return {
    pricingMode: "inquiry",
    serviceArea: "Nasional",
    serviceMode: "remote",
    pricingTiers: [
      {
        name: "Retainer Hukum Korporasi",
        pricingMode: "inquiry",
        summary: "Pendampingan hukum strategis bulanan sesuai kompleksitas entitas.",
        deliverables: ["Review kontrak bisnis", "Opini hukum tertulis"],
      },
    ],
    processSteps: [
      {
        stepNumber: 1,
        title: "Penjajakan Kasus & NDA",
        summary: "Penandatanganan perjanjian kerahasiaan dan diskusi awal kebutuhan hukum.",
        estimatedDuration: "1 hari kerja",
      },
      {
        stepNumber: 2,
        title: "Penawaran Khusus Tertulis",
        summary: "Penyusunan ruang lingkup pendampingan dan skema fee yang disepakati.",
        estimatedDuration: "2 hari kerja",
      },
    ],
  };
}

function createMockPlatformDb(params: {
  readonly userId: string;
  readonly tenantId: string;
  readonly handle: string;
  readonly organizationId: string;
  readonly role?: "owner" | "admin" | "editor" | "viewer";
  readonly tenantStatus?: string;
}): D1Database {
  const role = params.role ?? "owner";
  const tenantStatus = params.tenantStatus ?? "active";
  const makeStmt = (sql: string, _binds: unknown[] = []) => ({
    bind: (...next: unknown[]) => makeStmt(sql, next),
    first: async <T,>() => null as T | null,
    raw: async () => {
      if (sql.includes("tenants") && sql.includes("members")) {
        return [
          [
            params.tenantId,
            params.organizationId,
            params.handle,
            "Kantor Konsultan Sejahtera",
            tenantStatus,
            0,
            null,
            tenantStatus === "locked" ? null : Date.now() + 30 * 86_400_000,
            "mem_owner_1",
            role,
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

describe("TASK-035: Pricing Tiers, Consultation Process & Specialist WA Validation", () => {
  it("validates from/fixed/inquiry tiers, sorts processSteps, normalizes WA number, and sanitizes control chars", () => {
    const raw = buildValidFromService({
      processSteps: [...buildValidFromService().processSteps].reverse(),
      specialistCta: {
        specialistName: "Rina Kartika, BKP",
        specialistRole: "Konsultan Pajak Senior",
        whatsappNumber: "0812-9876-5432",
        ctaLabel: "Konsultasi dengan Bu Rina",
        prefilledMessage: "Halo\u0000\u0007 Bu Rina,\n\tsaya butuh audit pajak.",
      },
    });

    const validated = validateServiceConsultationAttributes(raw);
    expect(validated.processSteps.map((s) => s.stepNumber)).toEqual([1, 2, 3, 4]);
    expect(validated.specialistCta?.whatsappNumber).toBe("6281298765432");
    expect(validated.specialistCta?.prefilledMessage).toBe(
      "Halo Bu Rina, saya butuh audit pajak.",
    );

    // Legacy projection validates cleanly under strict `ServiceAttributesSchema`
    const legacy = toCatalogServiceAttributes(validated);
    const parsedLegacy = validateOfferingAttributes("service", legacy);
    expect(parsedLegacy.tiers).toHaveLength(3);
    expect(parsedLegacy.tiers?.[0]?.price).toBe(2_500_000);
    expect(parsedLegacy.tiers?.[2]?.price).toBeNull();
    expect(parsedLegacy.serviceSteps).toHaveLength(4);
  });

  it("formats Indonesian Rupiah labels accurately for from, fixed, and inquiry modes", () => {
    expect(formatIdrCurrency(2_500_000)).toBe("Rp 2.500.000");
    expect(formatServicePriceLabel("from", 2_500_000)).toBe("Mulai dari Rp 2.500.000");
    expect(formatServicePriceLabel("fixed", 5_000_000)).toBe("Rp 5.000.000");
    expect(formatServicePriceLabel("inquiry", null)).toBe(SERVICE_INQUIRY_PRICE_LABEL);
    expect(formatServicePriceLabel("inquiry", undefined)).toBe("Hubungi untuk Penawaran");
    expect(formatServicePriceLabel("inquiry", 9_999_999)).toBe("Hubungi untuk Penawaran");

    const headlineFrom = resolveServiceHeadlinePricing(buildValidFromService());
    expect(headlineFrom).toEqual({
      pricingMode: "from",
      catalogPriceMode: "from",
      priceIdr: 2_500_000,
      formattedLabel: "Mulai dari Rp 2.500.000",
    });

    const headlineInquiry = resolveServiceHeadlinePricing(buildValidInquiryService());
    expect(headlineInquiry).toEqual({
      pricingMode: "inquiry",
      catalogPriceMode: "on_request",
      priceIdr: null,
      formattedLabel: "Hubungi untuk Penawaran",
    });
  });

  it("rejects numeric prices on inquiry, requires positive integer IDR on from/fixed, and enforces bounds & strict keys", () => {
    // Numeric price on inquiry tier -> rejected
    expect(() =>
      validateServiceConsultationAttributes({
        ...buildValidInquiryService(),
        pricingTiers: [{ name: "Bad Inquiry", pricingMode: "inquiry", priceIdr: 1_000_000 }],
      }),
    ).toThrowError(ServiceValidationError);

    // Base price on inquiry service -> rejected
    expect(() =>
      validateServiceConsultationAttributes({
        ...buildValidInquiryService(),
        basePriceIdr: 1_000_000,
      }),
    ).toThrowError(ServiceValidationError);

    // Non-inquiry tier inside inquiry service -> rejected
    expect(() =>
      validateServiceConsultationAttributes({
        ...buildValidInquiryService(),
        pricingTiers: [{ name: "Fixed Inside Inquiry", pricingMode: "fixed", priceIdr: 500_000 }],
      }),
    ).toThrowError(ServiceValidationError);

    // Missing / zero / negative / float priceIdr on from & fixed -> rejected
    for (const badPrice of [undefined, null, 0, -500_000, 2500.5]) {
      expect(() =>
        validateServiceConsultationAttributes({
          ...buildValidFromService(),
          pricingTiers: [{ name: "Starter", pricingMode: "from", priceIdr: badPrice as never }],
        }),
      ).toThrowError(ServiceValidationError);

      expect(() =>
        validateServiceConsultationAttributes({
          ...buildValidFromService(),
          pricingTiers: [{ name: "Fixed", pricingMode: "fixed", priceIdr: badPrice as never }],
        }),
      ).toThrowError(ServiceValidationError);
    }

    // > 6 pricing tiers -> rejected
    const sevenTiers = Array.from({ length: MAX_SERVICE_PRICING_TIERS + 1 }, (_, i) => ({
      name: `Paket ${i + 1}`,
      pricingMode: "fixed" as const,
      priceIdr: (i + 1) * 1_000_000,
    }));
    expect(() =>
      validateServiceConsultationAttributes({
        ...buildValidFromService(),
        pricingTiers: sevenTiers,
      }),
    ).toThrowError(ServiceValidationError);

    // > 8 deliverables on a tier -> rejected
    const nineDeliverables = Array.from(
      { length: MAX_SERVICE_TIER_DELIVERABLES + 1 },
      (_, i) => `Deliverable ${i + 1}`,
    );
    expect(() =>
      validateServiceConsultationAttributes({
        ...buildValidFromService(),
        pricingTiers: [
          {
            name: "Too Many Deliverables",
            pricingMode: "fixed",
            priceIdr: 2_000_000,
            deliverables: nineDeliverables,
          },
        ],
      }),
    ).toThrowError(ServiceValidationError);

    // 0 process steps and > 10 process steps and duplicate stepNumber -> rejected
    expect(() =>
      validateServiceConsultationAttributes({ ...buildValidFromService(), processSteps: [] }),
    ).toThrowError(ServiceValidationError);

    const elevenSteps = Array.from({ length: MAX_SERVICE_PROCESS_STEPS + 1 }, (_, i) => ({
      stepNumber: i + 1,
      title: `Langkah ${i + 1}`,
      summary: "Ringkasan langkah.",
    }));
    expect(() =>
      validateServiceConsultationAttributes({
        ...buildValidFromService(),
        processSteps: elevenSteps,
      }),
    ).toThrowError(ServiceValidationError);

    expect(() =>
      validateServiceConsultationAttributes({
        ...buildValidFromService(),
        processSteps: [
          { stepNumber: 1, title: "A", summary: "B" },
          { stepNumber: 1, title: "C", summary: "D" },
        ],
      }),
    ).toThrowError(ServiceValidationError);

    // Invalid specialist WA numbers (non-WA schemes/hosts, foreign prefix, control chars) -> rejected
    for (const badWa of [
      "javascript:alert(1)",
      "https://evil.example/6281234567890",
      "https://wa.me/6281234567890",
      "+14155550199",
      "0217198888",
      "0812345",
      "628123456789\n",
    ]) {
      expect(
        () =>
          validateServiceConsultationAttributes({
            ...buildValidFromService(),
            specialistCta: {
              specialistName: "Rina",
              specialistRole: "Konsultan",
              whatsappNumber: badWa,
            },
          }),
        `Expected bad WA "${badWa}" to be rejected`,
      ).toThrowError(ServiceValidationError);
    }

    // Cart / checkout / unknown keys -> strictly rejected
    for (const extra of [
      { cartEnabled: true },
      { addToCartUrl: "https://shop.example/cart" },
      { checkoutUrl: "https://shop.example/checkout" },
      { unknownField: "nope" },
    ]) {
      expect(() =>
        validateServiceConsultationAttributes({
          ...buildValidFromService(),
          ...extra,
        }),
      ).toThrowError(ServiceValidationError);
    }
  });

  it("builds safe specialist WA href and falls back cleanly when specialist override is absent", () => {
    const withSpecialist = buildSpecialistWhatsAppHref({
      specialistCta: {
        specialistName: "Rina Kartika",
        specialistRole: "Konsultan Pajak",
        whatsappNumber: "0812-9876-5432",
        prefilledMessage: "Halo\u0000\u001f Bu Rina, saya butuh audit.",
      },
      fallbackPhone: "+6281111111111",
      serviceTitle: "Audit Pajak",
      canonicalUrl: "https://konsultansejahtera.id/layanan/audit-pajak",
    });
    expect(withSpecialist).toMatch(/^https:\/\/wa\.me\/6281298765432\?text=/);
    const decodedWa = decodeURIComponent(withSpecialist ?? "");
    expect(decodedWa).toContain("Halo Bu Rina, saya butuh audit.");
    expect(
      [...decodedWa].some((ch) => {
        const code = ch.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      }),
    ).toBe(false);

    const fallbackOnly = buildSpecialistWhatsAppHref({
      specialistCta: null,
      fallbackPhone: "+6281122334455",
      serviceTitle: "Audit Pajak",
    });
    expect(fallbackOnly).toMatch(/^https:\/\/wa\.me\/6281122334455\?text=/);

    expect(
      buildSpecialistWhatsAppHref({
        specialistCta: null,
        fallbackPhone: "https://evil.example/phish",
        serviceTitle: "Audit Pajak",
      }),
    ).toBeNull();

    expect(sanitizeSpecialistPrefilledMessage("\u0000\u0007\n  Halo \t dunia  \r")).toBe(
      "Halo dunia",
    );
  });

  it("preserves ALL serviceConsultationV1 fields 100% losslessly and idempotently across save -> reload -> save -> reload", () => {
    const initial = validateServiceConsultationAttributes(buildValidFromService());

    const baseDraft = JSON.stringify({
      snapshotVersion: 1,
      resourceType: "offering",
      data: { offeringType: "service", slug: "audit-pajak", title: "Audit Pajak" },
      _draftMetadata: { writeToken: "tok_abc" },
    });

    const saved1 = attachServiceConsultationToDraftSnapshotJson(baseDraft, initial);
    const reloaded1 = extractServiceConsultationFromSnapshotJson(saved1);
    expect(reloaded1).toEqual(initial);

    const validated2 = validateServiceConsultationAttributes(reloaded1);
    const saved2 = attachServiceConsultationToDraftSnapshotJson(saved1, validated2);
    const reloaded2 = extractServiceConsultationFromSnapshotJson(saved2);

    expect(reloaded2).toEqual(initial);
    expect(JSON.parse(saved2)._draftMetadata.writeToken).toBe("tok_abc");
    expect(JSON.parse(saved2).data.slug).toBe("audit-pajak");

    // Published snapshot outer envelope also round-trips losslessly without mutating `data`
    const basePublished = JSON.stringify({
      snapshotVersion: 1,
      resourceType: "offering",
      data: { offeringType: "service", slug: "audit-pajak", title: "Audit Pajak" },
      publishedAt: 1_700_000_000_000,
    });
    const pubWithService = attachServiceConsultationToPublishedSnapshotJson(basePublished, initial);
    expect(pubWithService).not.toBeNull();
    expect(extractServiceConsultationFromSnapshotJson(pubWithService)).toEqual(initial);
    expect(JSON.parse(pubWithService!).data.slug).toBe("audit-pajak");

    // Display normalizer round-trips cleanly
    const display = normalizeServiceDisplayModel(reloaded2);
    expect(display.headlinePriceLabel).toBe("Mulai dari Rp 2.500.000");
    expect(display.pricingTiers).toHaveLength(3);
    expect(display.processSteps).toHaveLength(4);
    expect(display.specialistCta?.whatsappNumber).toBe("6281298765432");
  });
});

describe("TASK-035: Visible-Fact Service JSON-LD Parity", () => {
  const TENANT_CTX = {
    tenantHandle: "konsultan-sejahtera",
    tenantStatus: "active" as const,
    primaryHost: "konsultansejahtera.id",
    primaryHostKind: "custom" as const,
    primaryHostStatus: "active" as const,
    primaryHostSslStatus: "active" as const,
    primaryHostVerified: true,
    verifiedTenantHosts: ["konsultansejahtera.id", "konsultan-sejahtera.situsku.click"],
  };

  it("emits ZERO offers / Offer / price / availability for inquiry-only service", () => {
    const res = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/layanan/retainer-hukum",
        tenant: TENANT_CTX,
        siteVisibility: "public",
        resourceState: "published",
      },
      siteName: "Kantor Hukum Sejahtera",
      offering: {
        offeringType: "service",
        title: "Retainer Hukum Korporasi",
        summary: "Pendampingan hukum strategis bulanan.",
        priceMode: "on_request",
        price: null,
        ctaMode: "whatsapp",
        attributes: buildValidInquiryService(),
      },
    });

    expect(res.emitted).toBe(true);
    const parsed = JSON.parse(res.jsonLd!);
    const serviceNode = parsed["@graph"].find((n: Record<string, unknown>) => n["@type"] === "Service");
    expect(serviceNode).toBeDefined();
    expect("offers" in serviceNode).toBe(false);
    expect("price" in serviceNode).toBe(false);
    expect("availability" in serviceNode).toBe(false);
    expect("aggregateRating" in serviceNode).toBe(false);
    expect("review" in serviceNode).toBe(false);
    expect(res.jsonLd).not.toContain('"Offer"');
    expect(res.jsonLd).not.toContain('"AggregateOffer"');
    expect(res.jsonLd).not.toContain('"availability"');
  });

  it("emits truthful AggregateOffer for visible 'from' pricing and Offer for visible 'fixed' pricing with ZERO invented availability/rating/review", () => {
    const fromRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/layanan/audit-pajak",
        tenant: TENANT_CTX,
        siteVisibility: "public",
        resourceState: "published",
      },
      siteName: "Kantor Konsultan Sejahtera",
      offering: {
        offeringType: "service",
        title: "Jasa Audit & Pendampingan Pajak",
        summary: "Audit kepatuhan pajak transparan untuk perusahaan.",
        priceMode: "from",
        price: 2_500_000,
        ctaMode: "whatsapp",
        attributes: buildValidFromService(),
      },
    });
    const fromGraph = JSON.parse(fromRes.jsonLd!);
    const fromService = fromGraph["@graph"].find(
      (n: Record<string, unknown>) => n["@type"] === "Service",
    );
    expect(fromService?.offers).toEqual({
      "@type": "AggregateOffer",
      priceCurrency: "IDR",
      lowPrice: 2_500_000,
      url: "https://konsultansejahtera.id/layanan/audit-pajak",
    });
    expect("availability" in fromService.offers).toBe(false);
    expect("aggregateRating" in fromService).toBe(false);
    expect("review" in fromService).toBe(false);

    const fixedRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/layanan/pendirian-pt",
        tenant: TENANT_CTX,
        siteVisibility: "public",
        resourceState: "published",
      },
      siteName: "Kantor Konsultan Sejahtera",
      offering: {
        offeringType: "service",
        title: "Jasa Pendirian PT Lengkap",
        summary: "Pendirian badan usaha PT resmi termasuk NIB.",
        priceMode: "fixed",
        price: 5_000_000,
        ctaMode: "whatsapp",
        attributes: {
          pricingMode: "fixed",
          basePriceIdr: 5_000_000,
          pricingTiers: [
            { name: "PT Lengkap", pricingMode: "fixed", priceIdr: 5_000_000 },
          ],
          processSteps: [
            { stepNumber: 1, title: "Cek Nama PT", summary: "Verifikasi nama di AHU." },
          ],
        },
      },
    });
    const fixedGraph = JSON.parse(fixedRes.jsonLd!);
    const fixedService = fixedGraph["@graph"].find(
      (n: Record<string, unknown>) => n["@type"] === "Service",
    );
    expect(fixedService?.offers).toEqual({
      "@type": "Offer",
      priceCurrency: "IDR",
      price: 5_000_000,
      url: "https://konsultansejahtera.id/layanan/pendirian-pt",
    });
    expect("availability" in fixedService.offers).toBe(false);
  });
});

describe("TASK-035: Server API Security (Auth, CSRF, Cross-Tenant, Locked, 422, OCC) & SSR Gate", () => {
  const baseEnv = {
    APP_ENV: "production",
    PLATFORM_DOMAIN: "punyasitus.com",
    AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
  };

  function makeApiReq(
    body: unknown,
    opts: {
      readonly host?: string;
      readonly origin?: string | null;
      readonly method?: string;
      readonly handle?: string;
    } = {},
  ): Request {
    const host = opts.host ?? "app.punyasitus.com";
    const handle = opts.handle ?? "konsultan-sejahtera";
    const headers = new Headers({
      Host: host,
      "Content-Type": "application/json",
    });
    if (opts.origin !== null) {
      headers.set("Origin", opts.origin ?? `https://${host}`);
    }
    return new Request(`https://${host}/dashboard/${handle}/catalog/services/api`, {
      method: opts.method ?? "POST",
      headers,
      body: opts.method === "GET" ? undefined : JSON.stringify(body),
    });
  }

  it("enforces host isolation (404), CSRF/Origin (403), unauthenticated (401), cross-tenant (404), locked tenant (403), and 422 validation", async () => {
    const platformDb = createMockPlatformDb({
      userId: "usr_owner_1",
      tenantId: "01JTENANTSVC000000000001",
      handle: "konsultan-sejahtera",
      organizationId: "org_svc_1",
    });
    const env = { ...baseEnv, PLATFORM_DB: platformDb };

    // 1. Non-app host -> 404
    const nonApp = await handleDashboardServicesApiRequest(
      "konsultan-sejahtera",
      makeApiReq({ action: "save_draft" }, { host: "konsultansejahtera.id" }),
      env,
      { authenticatedUser: { id: "usr_owner_1" } },
    );
    expect(nonApp.status).toBe(404);

    // 2. Bad Origin (CSRF) -> 403
    const badCsrf = await handleDashboardServicesApiRequest(
      "konsultan-sejahtera",
      makeApiReq({ action: "save_draft" }, { origin: "https://evil.example" }),
      env,
      { authenticatedUser: { id: "usr_owner_1" } },
    );
    expect(badCsrf.status).toBe(403);

    // 3. Unauthenticated (even with invalid action) -> 401 BEFORE body validation!
    const unauth = await handleDashboardServicesApiRequest(
      "konsultan-sejahtera",
      makeApiReq({ action: "bogus_action_should_not_return_422" }),
      env,
      { authenticatedUser: null },
    );
    expect(unauth.status).toBe(401);

    // 4. Cross-tenant foreign handle -> 404
    const crossTenant = await handleDashboardServicesApiRequest(
      "other-tenant-handle",
      makeApiReq(
        { action: "save_draft", title: "Audit", service: buildValidInquiryService() },
        { handle: "other-tenant-handle" },
      ),
      env,
      { authenticatedUser: { id: "usr_owner_1" } },
    );
    expect(crossTenant.status).toBe(404);

    // 5. Locked tenant -> 403 TENANT_LOCKED
    const lockedPlatformDb = createMockPlatformDb({
      userId: "usr_owner_1",
      tenantId: "01JTENANTSVC000000000001",
      handle: "konsultan-sejahtera",
      organizationId: "org_svc_1",
      tenantStatus: "locked",
    });
    const lockedRes = await handleDashboardServicesApiRequest(
      "konsultan-sejahtera",
      makeApiReq({ action: "save_draft", title: "Audit", service: buildValidInquiryService() }),
      { ...baseEnv, PLATFORM_DB: lockedPlatformDb },
      { authenticatedUser: { id: "usr_owner_1" } },
    );
    expect(lockedRes.status).toBe(403);
    const lockedJson = (await lockedRes.json()) as { error: { code: string } };
    expect(["SUBSCRIPTION_LOCKED", "TENANT_LOCKED"]).toContain(lockedJson.error.code);

    // 6. Strict 422 validation (inquiry tier with numeric price)
    const dummyTenantDb = createMockPlatformDb({
      userId: "usr_owner_1",
      tenantId: "01JTENANTSVC000000000001",
      handle: "konsultan-sejahtera",
      organizationId: "org_svc_1",
    });
    const invalidRes = await handleDashboardServicesApiRequest(
      "konsultan-sejahtera",
      makeApiReq({
        action: "save_draft",
        title: "Audit Pajak",
        service: {
          ...buildValidInquiryService(),
          pricingTiers: [{ name: "Invalid", pricingMode: "inquiry", priceIdr: 500_000 }],
        },
      }),
      env,
      {
        authenticatedUser: { id: "usr_owner_1" },
        resolveTenantDb: () => dummyTenantDb,
      },
    );
    expect(invalidRes.status).toBe(422);

    // 7. OCC conflict when snapshot UPDATE returns changes === 0 -> throws CatalogConflictError (409 STALE_VERSION)
    const occTenantDb = (() => {
      const makeStmt = (sql: string) => ({
        bind: () => makeStmt(sql),
        first: async () => {
          if (sql.includes("draft_snapshot_json") || sql.includes("published_snapshot_json")) {
            return {
              draft_snapshot_json: JSON.stringify({
                snapshotVersion: 1,
                resourceType: "offering",
                data: { offeringType: "service", slug: "audit-occ", title: "Audit OCC" },
              }),
              published_snapshot_json: JSON.stringify({
                snapshotVersion: 1,
                resourceType: "offering",
                data: { offeringType: "service", slug: "audit-occ", title: "Audit OCC" },
              }),
            };
          }
          return null;
        },
        all: async () => ({ results: [], success: true, meta: {} }),
        raw: async () => [],
        run: async () => ({ success: true, meta: { changes: 0 } }),
      });
      return {
        prepare: (sql: string) => makeStmt(sql),
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
        dump: async () => new ArrayBuffer(0),
      } as unknown as D1Database;
    })();

    await expect(
      persistLosslessDraftServiceEnvelope(occTenantDb, 55, 1, buildValidInquiryService()),
    ).rejects.toMatchObject({ status: 409, code: "STALE_VERSION" });

    await expect(
      persistLosslessPublishedServiceEnvelope(occTenantDb, 55, 2, buildValidInquiryService()),
    ).rejects.toMatchObject({ status: 409, code: "STALE_VERSION" });
  });

  it("persists real SQLite create (201) -> update (200) -> stale OCC (409) -> publish (200) -> loadFrozenPublishedServiceBySlug with whatsappOverride intact", async () => {
    function createRealSqliteD1(migrationDir: string): {
      readonly sqlite: DatabaseSync;
      readonly d1: D1Database;
    } {
      const sqlite = new DatabaseSync(":memory:");
      sqlite.exec("PRAGMA foreign_keys = ON;");
      const sqlFiles = fs
        .readdirSync(migrationDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const file of sqlFiles) {
        sqlite.exec(fs.readFileSync(path.join(migrationDir, file), "utf8"));
      }

      const normalizeArg = (val: unknown): SQLInputValue => {
        if (val === undefined || val === null) return null;
        if (typeof val === "boolean") return val ? 1 : 0;
        if (val instanceof Date) return val.getTime();
        return val as SQLInputValue;
      };

      const makeStmt = (sql: string, binds: readonly unknown[] = []) => {
        const execAll = (): Record<string, unknown>[] => {
          const stmt = sqlite.prepare(sql);
          return stmt.all(...binds.map(normalizeArg)) as Record<string, unknown>[];
        };
        const execRun = () => {
          const stmt = sqlite.prepare(sql);
          const info = stmt.run(...binds.map(normalizeArg));
          return {
            success: true,
            results: [],
            meta: {
              changes: Number(info.changes ?? 0),
              last_row_id: Number(info.lastInsertRowid ?? 0),
            },
          };
        };
        return {
          bind: (...next: unknown[]) => makeStmt(sql, next),
          first: async <T,>(col?: string): Promise<T | null> => {
            const rows = execAll();
            const firstRow = rows[0];
            if (!firstRow) return null;
            if (col !== undefined) return (firstRow[col] as T) ?? null;
            return firstRow as unknown as T;
          },
          all: async <T,>() => {
            const rows = execAll();
            return { results: rows as unknown as T[], success: true, meta: { changes: 0 } };
          },
          raw: async <T = unknown[],>() => {
            const stmt = sqlite.prepare(sql);
            stmt.setReturnArrays(true);
            return stmt.all(...binds.map(normalizeArg)) as unknown as T[];
          },
          run: async () => execRun(),
          _execForBatch: () => {
            const trimmed = sql.trim().toUpperCase();
            if (trimmed.startsWith("SELECT") || trimmed.includes("RETURNING")) {
              const rows = execAll();
              return { results: rows, success: true, meta: { changes: rows.length } };
            }
            return execRun();
          },
        };
      };

      const d1 = {
        prepare: (sql: string) => makeStmt(sql),
        batch: async (stmts: Array<{ _execForBatch: () => unknown }>) => {
          sqlite.exec("BEGIN IMMEDIATE");
          try {
            const results = stmts.map((s) => s._execForBatch());
            sqlite.exec("COMMIT");
            return results;
          } catch (err) {
            sqlite.exec("ROLLBACK");
            throw err;
          }
        },
        exec: async (sql: string) => {
          sqlite.exec(sql);
          return { count: 1, duration: 0 };
        },
        dump: async () => new ArrayBuffer(0),
      } as unknown as D1Database;

      return { sqlite, d1 };
    }

    const { sqlite: platformSqlite, d1: platformDb } = createRealSqliteD1(
      path.join(root, "packages/db/migrations/platform"),
    );
    const { sqlite: tenantSqlite, d1: tenantDb } = createRealSqliteD1(
      path.join(root, "packages/db/migrations/tenant"),
    );

    try {
      const nowMs = 1_760_000_000_000;
      const tenantId = "01JREALSVCTENANT00000001";
      const orgId = "org_real_svc_1";
      const userId = "usr_real_owner_1";

      platformSqlite
        .prepare(
          `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .run(userId, "Pemilik Konsultan", "owner@konsultansejahtera.id", nowMs, nowMs);
      platformSqlite
        .prepare(
          `INSERT INTO organizations (id, name, slug, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(orgId, "Kantor Konsultan Sejahtera", "konsultan-sejahtera", nowMs, nowMs);
      platformSqlite
        .prepare(
          `INSERT INTO members (id, organization_id, user_id, role, created_at)
           VALUES (?, ?, ?, 'owner', ?)`,
        )
        .run("mem_real_1", orgId, userId, nowMs);
      platformSqlite
        .prepare(
          `INSERT INTO tenants (id, organization_id, handle, name, status, operator_hold, paid_through, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
        )
        .run(
          tenantId,
          orgId,
          "konsultan-sejahtera",
          "Kantor Konsultan Sejahtera",
          nowMs + 30 * 86_400_000,
          nowMs,
          nowMs,
        );

      const realEnv = { ...baseEnv, PLATFORM_DB: platformDb };
      const initialService = buildValidFromService();

      // 1. CREATE (201) — works with specialist `whatsappOverride` even with no business_profile WA!
      const createRes = await handleDashboardServicesApiRequest(
        "konsultan-sejahtera",
        makeApiReq({
          action: "save_draft",
          title: "Jasa Audit Pajak Tahunan",
          summary: "Audit pajak menyeluruh untuk perusahaan menengah.",
          service: initialService,
        }),
        realEnv,
        {
          nowMs,
          authenticatedUser: { id: userId },
          resolveTenantDb: () => tenantDb,
        },
      );
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        id: number;
        slug: string;
        version: number;
        status: string;
        priceMode: string;
        price: number | null;
        attributes: ServiceConsultationAttributes;
      };
      expect(created.id).toBeGreaterThanOrEqual(1);
      expect(created.version).toBe(1);
      expect(created.status).toBe("draft");
      expect(created.priceMode).toBe("from");
      expect(created.price).toBe(2_500_000);
      expect(created.attributes.specialistCta?.whatsappNumber).toBe("6281298765432");

      // Confirm `whatsappOverride` persisted on real DB offering row AND draft does NOT leak to public loader
      const storedAfterCreate = await getCatalogOfferingById(tenantDb, created.id);
      expect(storedAfterCreate?.whatsappOverride).toBe("6281298765432");
      expect(storedAfterCreate?.status).toBe("draft");
      expect(await loadFrozenPublishedServiceBySlug(tenantDb, created.slug)).toBeNull();

      const draftMap1 = await loadLosslessDraftServiceMap(tenantDb, [created.id]);
      expect(draftMap1.get(created.id)).toEqual(created.attributes);

      // 2. UPDATE (200) — change tier price & specialist WA, check lossless reload
      const updatedService = buildValidFromService({
        basePriceIdr: 3_000_000,
        pricingTiers: [
          {
            name: "Paket Audit Premium",
            pricingMode: "fixed",
            priceIdr: 6_500_000,
            billingUnit: "per proyek",
            deliverables: ["Audit penuh PPh/PPN", "Presentasi direksi"],
          },
        ],
        specialistCta: {
          specialistName: "Hendra Wijaya, BKP",
          specialistRole: "Partner Pajak",
          whatsappNumber: "+6281355556666",
          ctaLabel: "Hubungi Pak Hendra",
          prefilledMessage: "Halo Pak Hendra, saya butuh audit pajak.",
        },
      });
      const updateRes = await handleDashboardServicesApiRequest(
        "konsultan-sejahtera",
        makeApiReq({
          action: "save_draft",
          id: created.id,
          expectedVersion: created.version,
          title: "Jasa Audit Pajak Tahunan (Revisi)",
          summary: "Audit pajak menyeluruh dengan laporan direksi.",
          service: updatedService,
        }),
        realEnv,
        {
          nowMs: nowMs + 1000,
          authenticatedUser: { id: userId },
          resolveTenantDb: () => tenantDb,
        },
      );
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as typeof created;
      expect(updated.version).toBe(2);
      expect(updated.attributes.specialistCta?.whatsappNumber).toBe("6281355556666");

      // Stale OCC version (1 instead of 2) -> 409
      const staleRes = await handleDashboardServicesApiRequest(
        "konsultan-sejahtera",
        makeApiReq({
          action: "save_draft",
          id: created.id,
          expectedVersion: 1,
          title: "Stale Write",
          service: updatedService,
        }),
        realEnv,
        {
          nowMs: nowMs + 1500,
          authenticatedUser: { id: userId },
          resolveTenantDb: () => tenantDb,
        },
      );
      expect(staleRes.status).toBe(409);

      // 3. PUBLISH (200) -> frozen published snapshot round-trips via `loadFrozenPublishedServiceBySlug`
      const publishRes = await handleDashboardServicesApiRequest(
        "konsultan-sejahtera",
        makeApiReq({
          action: "publish",
          id: created.id,
          expectedVersion: updated.version,
          title: "Jasa Audit Pajak Tahunan (Final)",
          summary: "Audit pajak menyeluruh resmi.",
          service: updatedService,
        }),
        realEnv,
        {
          nowMs: nowMs + 2000,
          authenticatedUser: { id: userId },
          resolveTenantDb: () => tenantDb,
        },
      );
      expect(publishRes.status).toBe(200);
      const published = (await publishRes.json()) as typeof created;
      expect(published.status).toBe("published");
      expect(published.attributes.specialistCta?.whatsappNumber).toBe("6281355556666");

      const frozenPublic = await loadFrozenPublishedServiceBySlug(tenantDb, published.slug);
      expect(frozenPublic).toEqual(published.attributes);

      // Subsequent unpublished draft save MUST NOT alter frozen public snapshot!
      const laterDraft = buildValidFromService({
        specialistCta: {
          specialistName: "Draf Baru",
          specialistRole: "Konsultan",
          whatsappNumber: "081900001111",
        },
      });
      const draftAfterPubRes = await handleDashboardServicesApiRequest(
        "konsultan-sejahtera",
        makeApiReq({
          action: "save_draft",
          id: created.id,
          expectedVersion: published.version,
          title: "Draf Belum Tayang",
          service: laterDraft,
        }),
        realEnv,
        {
          nowMs: nowMs + 3000,
          authenticatedUser: { id: userId },
          resolveTenantDb: () => tenantDb,
        },
      );
      expect(draftAfterPubRes.status).toBe(200);
      expect(await loadFrozenPublishedServiceBySlug(tenantDb, published.slug)).toEqual(
        published.attributes,
      );
    } finally {
      tenantSqlite.close();
      platformSqlite.close();
    }
  });

  it("enforces SSR gate lifecycle and RBAC cleanly", () => {
    const active = evaluateServicesSsrGate({
      rawHandle: "konsultan-sejahtera",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u1" },
      authorized: {
        tenantId: "t1",
        handle: "konsultan-sejahtera",
        role: "owner",
        tenantStatus: "active",
      },
    });
    expect(active.ok).toBe(true);
    if (active.ok) {
      expect(active.canWriteServices).toBe(true);
      expect(active.canPublishServices).toBe(true);
    }

    const locked = evaluateServicesSsrGate({
      rawHandle: "konsultan-sejahtera",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u1" },
      authorized: {
        tenantId: "t1",
        handle: "konsultan-sejahtera",
        role: "owner",
        tenantStatus: "locked",
      },
    });
    expect(locked.ok).toBe(true);
    if (locked.ok) {
      expect(locked.readOnly).toBe(true);
      expect(locked.canWriteServices).toBe(false);
    }

    const suspended = evaluateServicesSsrGate({
      rawHandle: "konsultan-sejahtera",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u1" },
      authorized: {
        tenantId: "t1",
        handle: "konsultan-sejahtera",
        role: "owner",
        tenantStatus: "suspended",
      },
    });
    expect(suspended.ok).toBe(false);
    if (!suspended.ok) expect(suspended.status).toBe(302);

    const foreign = evaluateServicesSsrGate({
      rawHandle: "other-site",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u1" },
      authorized: {
        tenantId: "t1",
        handle: "konsultan-sejahtera",
        role: "owner",
        tenantStatus: "active",
      },
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.status).toBe(404);
  });
});

describe("TASK-035: Public Theme & Admin UI Guardrails (TASK-013 & TASK-032)", () => {
  it("contains ZERO forbidden substrings in SectionServiceProcess.astro and admin Services editor", () => {
    const sectionSrc = fs.readFileSync(
      path.join(root, "apps/web/src/themes/default/sections/SectionServiceProcess.astro"),
      "utf8",
    );
    const publicForbidden = [
      "@radix-ui/",
      "@base-ui/react",
      "react",
      "@punyasitus/db",
      "@punyasitus/auth",
      "client:",
      "components/ui",
      "Sparkles",
      "SparklesIcon",
    ];
    for (const token of publicForbidden) {
      expect(
        sectionSrc.toLowerCase().includes(token.toLowerCase()),
        `SectionServiceProcess.astro must NOT contain forbidden substring "${token}"`,
      ).toBe(false);
    }

    const clientSrc = fs.readFileSync(
      path.join(
        root,
        "apps/web/src/pages/dashboard/[handle]/catalog/services/_ServiceCatalogManagerClient.tsx",
      ),
      "utf8",
    );
    for (const token of ["@radix-ui/", "asChild", "Sparkles", "SparklesIcon"]) {
      expect(
        clientSrc.includes(token),
        `_ServiceCatalogManagerClient.tsx must NOT contain forbidden token "${token}"`,
      ).toBe(false);
    }
  });
});

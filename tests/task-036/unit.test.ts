import { describe, expect, it } from "vitest";
import {
  buildPreservedRedirectQuery,
  computeVehicleCreditEstimateRows,
  containsNumericIdPathSegment,
  extractFaqItemsFromSections,
  formatDateOnlyIndonesian,
  formatPublicOfferingPrice,
  inspectSingleSlugParam,
  normalizeSingleSlugParam,
  OFFERING_ROUTE_META,
  parsePublicPaginationQuery,
  resolveBlogDetailRoute,
  resolveBlogListingRoute,
  resolveOfferingDetailRoute,
  resolveOfferingListingRoute,
  resolvePublicOfferingCta,
  resolvePublicPageRoute,
  sanitizeSafeMailtoAddress,
} from "../../apps/web/src/core/public-routes.ts";
import type { TenantContext } from "../../apps/web/src/core/tenant.ts";

const ACTIVE_TENANT: TenantContext = {
  id: "01JT036UNIT000000000000001",
  organizationId: "org_t036_unit",
  handle: "mitra-unit",
  name: "PT Mitra Unit",
  vertical: "compro",
  status: "active",
  storedStatus: "active",
  operatorHold: false,
  cacheVersion: 3,
  schemaVersion: 1,
  host: "mitra-unit.situsku.click",
  hostKind: "subdomain",
  isPrimary: true,
  primaryHost: "mitra-unit.situsku.click",
  primaryHostKind: "subdomain",
};

describe("TASK-036 unit tests — pagination, clean URLs, pricing, credit math, CTAs & host gates", () => {
  describe("parsePublicPaginationQuery", () => {
    const origin = "https://mitra-unit.situsku.click";

    it("returns 301 redirect to clean base path for ?page=1", () => {
      const res = parsePublicPaginationQuery({
        searchParams: new URLSearchParams("page=1"),
        basePath: "/blog",
        origin,
        totalItems: 20,
        pageSize: 9,
      });
      expect(res).toEqual({
        kind: "redirect_page_one",
        status: 301,
        location: "https://mitra-unit.situsku.click/blog",
      });
    });

    it("returns bounded page 2 with clean prev/next links and page links", () => {
      const res = parsePublicPaginationQuery({
        searchParams: new URLSearchParams("page=2"),
        basePath: "/blog",
        origin,
        totalItems: 25,
        pageSize: 9,
      });
      expect(res.kind).toBe("ok");
      if (res.kind !== "ok") return;
      expect(res.pagination.page).toBe(2);
      expect(res.pagination.totalPages).toBe(3);
      expect(res.pagination.offset).toBe(9);
      expect(res.pagination.prevHref).toBe("/blog");
      expect(res.pagination.nextHref).toBe("/blog?page=3");
      expect(res.pagination.pageLinks.map((l) => l.href)).toEqual([
        "/blog",
        "/blog?page=2",
        "/blog?page=3",
      ]);
      expect(res.pagination.pageLinks[1]?.current).toBe(true);
    });

    it("returns 404 for out-of-range or malformed page queries", () => {
      const invalidCases = [
        "page=0",
        "page=-2",
        "page=abc",
        "page=01",
        "page=1.5",
        "page=2&page=3",
      ];
      for (const qs of invalidCases) {
        const res = parsePublicPaginationQuery({
          searchParams: new URLSearchParams(qs),
          basePath: "/layanan",
          origin,
          totalItems: 30,
          pageSize: 9,
        });
        expect(res, `query ${qs}`).toEqual({ kind: "not_found", reason: "invalid_pagination" });
      }

      const outOfRange = parsePublicPaginationQuery({
        searchParams: new URLSearchParams("page=4"),
        basePath: "/layanan",
        origin,
        totalItems: 18,
        pageSize: 9,
      });
      expect(outOfRange).toEqual({ kind: "not_found", reason: "out_of_range_pagination" });

      const emptyPageTwo = parsePublicPaginationQuery({
        searchParams: new URLSearchParams("page=2"),
        basePath: "/produk",
        origin,
        totalItems: 0,
        pageSize: 9,
      });
      expect(emptyPageTwo).toEqual({ kind: "not_found", reason: "out_of_range_pagination" });
    });

    it("returns valid page 1 on an empty archive (totalItems = 0)", () => {
      const res = parsePublicPaginationQuery({
        searchParams: new URLSearchParams(),
        basePath: "/tour",
        origin,
        totalItems: 0,
        pageSize: 9,
      });
      expect(res.kind).toBe("ok");
      if (res.kind !== "ok") return;
      expect(res.pagination.page).toBe(1);
      expect(res.pagination.totalPages).toBe(1);
      expect(res.pagination.prevHref).toBeNull();
      expect(res.pagination.nextHref).toBeNull();
      expect(res.pagination.pageLinks).toEqual([]);
    });
  });

  describe("clean public URL & slug invariants (zero numeric IDs)", () => {
    it("detects numeric ID path segments while allowing clean slugs", () => {
      expect(containsNumericIdPathSegment("/blog/panduan-bisnis")).toBe(false);
      expect(containsNumericIdPathSegment("/layanan/audit-operasional")).toBe(false);
      expect(containsNumericIdPathSegment("/produk/paket-kantor-2026")).toBe(false);
      expect(containsNumericIdPathSegment("/tour/jogja-3h2m")).toBe(false);
      expect(containsNumericIdPathSegment("/kendaraan/suv-2023")).toBe(false);
      expect(containsNumericIdPathSegment("https://acme.id/blog/tips-2")).toBe(false);

      expect(containsNumericIdPathSegment("/blog/42")).toBe(true);
      expect(containsNumericIdPathSegment("/layanan/123")).toBe(true);
      expect(containsNumericIdPathSegment("https://acme.id/produk/7/detail")).toBe(true);
    });

    it("normalizes single slug parameters and rejects multi-segment or unsafe values", () => {
      expect(normalizeSingleSlugParam("Tentang-Kami")).toBe("tentang-kami");
      expect(normalizeSingleSlugParam("/jogja-3h2m/")).toBe("jogja-3h2m");
      expect(normalizeSingleSlugParam("")).toBeNull();
      expect(normalizeSingleSlugParam("a/b")).toBeNull();
      expect(normalizeSingleSlugParam("feed.xml")).toBeNull();
      expect(normalizeSingleSlugParam("../etc")).toBeNull();
    });

    it("distinguishes canonical vs mixed-case slugs and preserves only safe redirect query params", () => {
      expect(inspectSingleSlugParam("tentang-kami")).toEqual({
        kind: "canonical",
        slug: "tentang-kami",
      });
      expect(inspectSingleSlugParam("Konsultasi-Proyek")).toEqual({
        kind: "mixed_case",
        rawSlug: "Konsultasi-Proyek",
        canonicalSlug: "konsultasi-proyek",
      });
      expect(inspectSingleSlugParam("a/b")).toEqual({ kind: "invalid" });

      const preserved = buildPreservedRedirectQuery(
        new URLSearchParams([
          ["utm_source", "instagram"],
          ["ref", "nav-header"],
          ["bad\r\nkey", "1"],
          ["evil", "ok\r\nSet-Cookie: a=1"],
          ["with space", "ignored"],
        ]),
      );
      expect(preserved).toBe("?utm_source=instagram&ref=nav-header");
      expect(buildPreservedRedirectQuery(new URLSearchParams())).toBe("");
    });

    it("defines clean Indonesian prefixes for all 4 typed offerings", () => {
      expect(OFFERING_ROUTE_META.service.prefix).toBe("/layanan");
      expect(OFFERING_ROUTE_META.product.prefix).toBe("/produk");
      expect(OFFERING_ROUTE_META.tour.prefix).toBe("/tour");
      expect(OFFERING_ROUTE_META.vehicle.prefix).toBe("/kendaraan");
    });
  });

  describe("honest IDR pricing, vehicle credit estimates & zero-JS CTAs", () => {
    it("formats all 4 price models honestly and never treats on_request as free", () => {
      expect(formatPublicOfferingPrice({ priceMode: "fixed", price: 1_500_000 })).toBe(
        "Rp 1.500.000",
      );
      expect(
        formatPublicOfferingPrice({ priceMode: "from", price: 750_000, negotiable: true }),
      ).toBe("Mulai Rp 750.000 (Nego)");
      expect(
        formatPublicOfferingPrice({ priceMode: "range", price: 2_000_000, priceMax: 4_500_000 }),
      ).toBe("Rp 2.000.000 - Rp 4.500.000");
      const onReq = formatPublicOfferingPrice({ priceMode: "on_request" });
      expect(onReq).toBe("Hubungi untuk harga");
      expect(onReq.toLowerCase()).not.toContain("gratis");
      expect(onReq).not.toContain("Rp 0");
    });

    it("computes deterministic static integer Rupiah credit rows for vehicles", () => {
      const rows = computeVehicleCreditEstimateRows(250_000_000, {
        annualFlatRateBps: 600,
        dpPercents: [20, 30],
        tenorMonths: [36, 48],
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.dpPercent).toBe(20);
      expect(rows[0]?.dpAmountIdr).toBe(50_000_000);
      expect(rows[0]?.principalAmountIdr).toBe(200_000_000);
      expect(rows[0]?.installments).toHaveLength(2);
      // 200M principal + 6% flat * 3 years (36M interest) = 236M / 36 = 6,555,556 -> ceil to 6,556,000
      expect(rows[0]?.installments[0]?.monthlyAmountIdr).toBe(6_556_000);
      expect(rows[0]?.installments[0]?.monthlyLabel).toBe("Rp 6.556.000 / bln");

      expect(computeVehicleCreditEstimateRows(null, undefined)).toEqual([]);
      expect(computeVehicleCreditEstimateRows(0, { annualFlatRateBps: 500, dpPercents: [20], tenorMonths: [24] })).toEqual([]);
    });

    it("builds zero-JS WhatsApp, external HTTPS, inquiry, and book CTAs safely", () => {
      const origin = "https://mitra-unit.situsku.click";
      const waCta = resolvePublicOfferingCta(
        {
          offeringType: "service",
          slug: "audit-operasional",
          title: "Audit Operasional B2B",
          priceMode: "from",
          price: 5_000_000,
          priceMax: null,
          negotiable: false,
          ctaMode: "whatsapp",
          externalUrl: null,
        },
        { primaryOrigin: origin, tenantWhatsappE164: "0812-3456-7890", isDetailPage: true },
      );
      expect(waCta.isWhatsApp).toBe(true);
      expect(waCta.isExternal).toBe(true);
      expect(waCta.href).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/);
      expect(decodeURIComponent(waCta.href)).toContain(
        "https://mitra-unit.situsku.click/layanan/audit-operasional",
      );

      const extCta = resolvePublicOfferingCta(
        {
          offeringType: "product",
          slug: "paket-kantor",
          title: "Paket Kantor",
          priceMode: "fixed",
          price: 1_200_000,
          priceMax: null,
          negotiable: false,
          ctaMode: "external_link",
          externalUrl: "https://tokopedia.com/mitra-unit/paket-kantor",
        },
        { primaryOrigin: origin, isDetailPage: true },
      );
      expect(extCta.isExternal).toBe(true);
      expect(extCta.isWhatsApp).toBe(false);
      expect(extCta.href).toBe("https://tokopedia.com/mitra-unit/paket-kantor");

      const bookCta = resolvePublicOfferingCta(
        {
          offeringType: "tour",
          slug: "jogja-3h2m",
          title: "Tur Jogja 3H2M",
          priceMode: "fixed",
          price: 2_850_000,
          priceMax: null,
          negotiable: false,
          ctaMode: "book",
          externalUrl: null,
        },
        { primaryOrigin: origin, tenantEmail: "halo@mitra-unit.id", isDetailPage: true },
      );
      expect(bookCta.href).toContain("mailto:halo@mitra-unit.id");
      expect(bookCta.helperNote).toContain("konfirmasi");

      // Hostile email values MUST be rejected by sanitizeSafeMailtoAddress and never emit mailto:
      expect(sanitizeSafeMailtoAddress("halo@mitra-unit.id")).toBe("halo@mitra-unit.id");
      expect(sanitizeSafeMailtoAddress("bad\r\n@evil.com")).toBeNull();
      expect(sanitizeSafeMailtoAddress("a<script>@b.com")).toBeNull();
      expect(sanitizeSafeMailtoAddress("x@y.com?bcc=evil@z.com")).toBeNull();
      expect(sanitizeSafeMailtoAddress("not an email")).toBeNull();

      const hostileBookCta = resolvePublicOfferingCta(
        {
          offeringType: "tour",
          slug: "jogja-3h2m",
          title: "Tur Jogja 3H2M",
          priceMode: "fixed",
          price: 2_850_000,
          priceMax: null,
          negotiable: false,
          ctaMode: "book",
          externalUrl: null,
        },
        {
          primaryOrigin: origin,
          tenantEmail: "bad\r\n@evil.com?bcc=attacker@evil.com",
          isDetailPage: true,
        },
      );
      expect(hostileBookCta.href).not.toContain("mailto:");
      expect(hostileBookCta.href).toBe("/#kontak");
    });

    it("extracts FAQ items only from enabled FAQ sections and formats date-only values", () => {
      const faqs = extractFaqItemsFromSections([
        {
          type: "faq",
          enabled: true,
          config: {
            items: [
              { question: "Berapa lama prosesnya?", answer: "Sekitar 5 hari kerja." },
              { question: "   ", answer: "Diabaikan" },
            ],
          },
        },
        {
          type: "faq",
          enabled: false,
          config: {
            items: [{ question: "Tersembunyi?", answer: "Tidak boleh ikut schema." }],
          },
        },
      ]);
      expect(faqs).toEqual([
        { question: "Berapa lama prosesnya?", answer: "Sekitar 5 hari kerja." },
      ]);
      expect(formatDateOnlyIndonesian("2026-12-15")).toContain("2026");
    });
  });

  describe("strict host, surface & lifecycle gates", () => {
    it("returns neutral 404 on unknown and platform hosts across all public route resolvers", async () => {
      const unknownReq = new Request("https://unknown-host.example/tentang");
      const r1 = await resolvePublicPageRoute(unknownReq, {}, "tentang");
      expect(r1.kind).toBe("response");
      if (r1.kind === "response") {
        expect(r1.response.status).toBe(404);
        expect(r1.response.headers.get("Cache-Control")).toBe("no-store");
        expect(r1.response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      }

      const appReq = new Request("https://app.punyasitus.com/blog");
      const r2 = await resolveBlogListingRoute(appReq, { surface: "app" });
      expect(r2.kind).toBe("response");
      if (r2.kind === "response") {
        expect(r2.response.status).toBe(404);
      }

      const consoleReq = new Request("https://console.punyasitus.com/layanan/audit");
      const r3 = await resolveOfferingDetailRoute(consoleReq, { surface: "console" }, "service", "audit");
      expect(r3.kind).toBe("response");
      if (r3.kind === "response") {
        expect(r3.response.status).toBe(404);
      }
    });

    it("returns 503 maintenance on suspended/recovery tenants and 301 on verified alias hosts", async () => {
      const suspendedTenant: TenantContext = {
        ...ACTIVE_TENANT,
        status: "suspended",
        storedStatus: "suspended",
      };
      const rSusp = await resolveBlogDetailRoute(
        new Request("https://mitra-unit.situsku.click/blog/halo"),
        { surface: "tenant", tenant: suspendedTenant },
        "halo",
      );
      expect(rSusp.kind).toBe("response");
      if (rSusp.kind === "response") {
        expect(rSusp.response.status).toBe(503);
        expect(rSusp.response.headers.get("Cache-Control")).toBe("no-store");
        expect(rSusp.response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
        expect(await rSusp.response.text()).toContain("Situs dalam perbaikan");
      }

      const aliasTenant: TenantContext = {
        ...ACTIVE_TENANT,
        host: "mitra-unit.situsku.click",
        isPrimary: false,
        primaryHost: "www.mitra-unit.id",
        primaryHostKind: "custom",
      };
      const rAlias = await resolveOfferingListingRoute(
        new Request("https://mitra-unit.situsku.click/produk?page=2"),
        { surface: "tenant", tenant: aliasTenant },
        "product",
      );
      expect(rAlias.kind).toBe("response");
      if (rAlias.kind === "response") {
        expect(rAlias.response.status).toBe(301);
        expect(rAlias.response.headers.get("Location")).toBe(
          "https://www.mitra-unit.id/produk?page=2",
        );
      }
    });
  });
});

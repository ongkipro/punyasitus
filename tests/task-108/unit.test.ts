import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PNG_SIGNATURE,
  QrDraftNotAllowedError,
  QrValidationError,
  buildCanonicalQrTargetUrl,
  buildQrDownloadFilename,
  buildTenantQrApiUrl,
  classifyQrScanVisit,
  countQrScanVisits,
  generateQrMatrix,
  renderQrPngBytes,
  renderQrSvg,
} from "@punyasitus/core/qr/index";
import { decodeQrPngToText, decodeQrSvgToText } from "./qr-decoder-helper.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-108: Free QR Codes for Website, Pages and Offerings (Unit)", () => {
  describe("Canonical Primary URL Builder & Draft Enforcement", () => {
    it("encodes canonical primary URLs for website, published pages, and all 4 offering types with and without utm_source=qr", () => {
      const origin = "https://www.berkahwisata.id";

      expect(
        buildCanonicalQrTargetUrl({
          primaryOrigin: origin,
          targetKind: "website",
          includeUtmQr: false,
        }),
      ).toBe("https://www.berkahwisata.id/");

      expect(
        buildCanonicalQrTargetUrl({
          primaryOrigin: origin,
          targetKind: "website",
          includeUtmQr: true,
        }),
      ).toBe("https://www.berkahwisata.id/?utm_source=qr");

      expect(
        buildCanonicalQrTargetUrl({
          primaryOrigin: origin,
          targetKind: "page",
          slug: "tentang-kami",
          status: "published",
          includeUtmQr: false,
        }),
      ).toBe("https://www.berkahwisata.id/tentang-kami");

      expect(
        buildCanonicalQrTargetUrl({
          primaryOrigin: origin,
          targetKind: "page",
          slug: "beranda",
          isHomepage: true,
          status: "published",
          includeUtmQr: true,
        }),
      ).toBe("https://www.berkahwisata.id/?utm_source=qr");

      expect(
        buildCanonicalQrTargetUrl({
          primaryOrigin: origin,
          targetKind: "offering",
          offeringType: "service",
          slug: "konsultasi-pajak",
          status: "published",
          includeUtmQr: true,
        }),
      ).toBe("https://www.berkahwisata.id/layanan/konsultasi-pajak?utm_source=qr");

      expect(
        buildCanonicalQrTargetUrl({
          primaryOrigin: origin,
          targetKind: "offering",
          offeringType: "product",
          slug: "kopi-arabika-gayo",
          status: "published",
          includeUtmQr: false,
        }),
      ).toBe("https://www.berkahwisata.id/produk/kopi-arabika-gayo");

      expect(
        buildCanonicalQrTargetUrl({
          primaryOrigin: origin,
          targetKind: "offering",
          offeringType: "tour",
          slug: "umrah-reguler-9-hari",
          status: "published",
          includeUtmQr: true,
        }),
      ).toBe("https://www.berkahwisata.id/tour/umrah-reguler-9-hari?utm_source=qr");

      expect(
        buildCanonicalQrTargetUrl({
          primaryOrigin: origin,
          targetKind: "offering",
          offeringType: "vehicle",
          slug: "innova-zenix-hybrid-2026",
          status: "published",
          includeUtmQr: false,
        }),
      ).toBe("https://www.berkahwisata.id/kendaraan/innova-zenix-hybrid-2026");
    });

    it("immediately reflects primary domain switches in the encoded canonical URL", () => {
      const beforeSwitch = buildCanonicalQrTargetUrl({
        primaryOrigin: "https://kopi-nusantara.situsku.click",
        targetKind: "offering",
        offeringType: "product",
        slug: "espresso-house-blend",
        status: "published",
        includeUtmQr: true,
      });
      const afterCustomDomain = buildCanonicalQrTargetUrl({
        primaryOrigin: "https://www.kopinusantara.id",
        targetKind: "offering",
        offeringType: "product",
        slug: "espresso-house-blend",
        status: "published",
        includeUtmQr: true,
      });
      const afterApexSwitch = buildCanonicalQrTargetUrl({
        primaryOrigin: "https://kopinusantara.id",
        targetKind: "offering",
        offeringType: "product",
        slug: "espresso-house-blend",
        status: "published",
        includeUtmQr: true,
      });

      expect(beforeSwitch).toBe(
        "https://kopi-nusantara.situsku.click/produk/espresso-house-blend?utm_source=qr",
      );
      expect(afterCustomDomain).toBe(
        "https://www.kopinusantara.id/produk/espresso-house-blend?utm_source=qr",
      );
      expect(afterApexSwitch).toBe(
        "https://kopinusantara.id/produk/espresso-house-blend?utm_source=qr",
      );
    });

    it("rejects draft, unpublished, and trashed pages or offerings with QrDraftNotAllowedError (409 DRAFT_QR_NOT_ALLOWED)", () => {
      const invalidCases = [
        { targetKind: "page" as const, slug: "draf-promo", status: "draft" as const },
        { targetKind: "page" as const, slug: "belum-terbit", status: "unpublished" as const },
        { targetKind: "page" as const, slug: "terhapus", status: "trashed" as const },
        {
          targetKind: "page" as const,
          slug: "terhapus-ts",
          status: "published" as const,
          deletedAt: 1_800_000_000_000,
        },
        {
          targetKind: "offering" as const,
          offeringType: "product" as const,
          slug: "produk-draf",
          status: "draft" as const,
        },
        {
          targetKind: "offering" as const,
          offeringType: "tour" as const,
          slug: "tur-unpub",
          status: "unpublished" as const,
        },
        {
          targetKind: "offering" as const,
          offeringType: "vehicle" as const,
          slug: "unit-hapus",
          status: "published" as const,
          deletedAt: 1_800_000_000_000,
        },
      ];

      for (const tc of invalidCases) {
        let caught: unknown = null;
        try {
          buildCanonicalQrTargetUrl({
            primaryOrigin: "https://www.contohbisnis.id",
            ...tc,
            includeUtmQr: true,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(QrDraftNotAllowedError);
        expect((caught as QrDraftNotAllowedError).status).toBe(409);
        expect((caught as QrDraftNotAllowedError).code).toBe("DRAFT_QR_NOT_ALLOWED");
      }
    });

    it("rejects insecure, platform, or spoofed origins and numeric/malformed slugs", () => {
      const badOrigins = [
        "http://www.contohbisnis.id",
        "https://app.punyasitus.com",
        "https://console.punyasitus.com",
        "https://punyasitus.com",
        "https://127.0.0.1",
        "https://user:pass@contohbisnis.id",
        "https://contohbisnis.id:8443",
        "https://contohbisnis.id/extra-path",
        "https://contohbisnis.id?evil=1",
        "javascript:alert(1)",
      ];
      for (const bad of badOrigins) {
        expect(() =>
          buildCanonicalQrTargetUrl({
            primaryOrigin: bad,
            targetKind: "website",
          }),
        ).toThrow(QrValidationError);
      }

      expect(() =>
        buildCanonicalQrTargetUrl({
          primaryOrigin: "https://contohbisnis.id",
          targetKind: "page",
          slug: "42",
          status: "published",
        }),
      ).toThrow(QrValidationError);

      expect(() =>
        buildCanonicalQrTargetUrl({
          primaryOrigin: "https://contohbisnis.id",
          targetKind: "page",
          slug: "../admin",
          status: "published",
        }),
      ).toThrow(QrValidationError);
    });
  });

  describe("Pure-JS SVG & PNG Generation and Exact ISO/IEC 18004 Round-Trip Decoding", () => {
    const testUrls = [
      "https://alpha-studio.situsku.click/",
      "https://alpha-studio.situsku.click/?utm_source=qr",
      "https://www.berkahwisata.id/tentang-kami",
      "https://www.berkahwisata.id/tentang-kami?utm_source=qr",
      "https://www.berkahwisata.id/tour/umrah-eksekutif-plus-turki-12-hari?utm_source=qr",
      "https://dealer-jawa.id/kendaraan/toyota-innova-zenix-hybrid-q-modellista-2026",
    ];

    it("generates crisp accessible SVG and valid binary PNG that BOTH decode bit-for-bit back to the exact canonical URL", () => {
      for (const url of testUrls) {
        const matrix = generateQrMatrix(url);
        expect(matrix.version).toBeGreaterThanOrEqual(1);
        expect(matrix.version).toBeLessThanOrEqual(12);
        expect(matrix.modules.length).toBe(matrix.size * matrix.size);

        // 1. SVG round-trip verification
        const svg = renderQrSvg(url, { label: `QR ${url}`, quietZone: 4 });
        expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
        expect(svg).toContain('role="img"');
        expect(svg).toContain('shape-rendering="crispEdges"');
        const decodedSvg = decodeQrSvgToText(svg);
        expect(decodedSvg.quietZone).toBe(4);
        expect(decodedSvg.qrSize).toBe(matrix.size);
        expect(decodedSvg.text).toBe(url);

        // 2. PNG binary header + CRC32 + Adler32 + pixel fidelity + QR payload round-trip verification
        const pngBytes = renderQrPngBytes(url, { quietZone: 4, moduleSize: 8 });
        expect(pngBytes).toBeInstanceOf(Uint8Array);
        expect(Array.from(pngBytes.subarray(0, 8))).toEqual(Array.from(PNG_SIGNATURE));
        const decodedPng = decodeQrPngToText(pngBytes);
        expect(decodedPng.quietZone).toBe(4);
        expect(decodedPng.moduleSize).toBe(8);
        expect(decodedPng.qrSize).toBe(matrix.size);
        expect(decodedPng.width).toBe((matrix.size + 8) * 8);
        expect(decodedPng.height).toBe(decodedPng.width);
        expect(decodedPng.text).toBe(url);
      }
    });

    it("handles large PNG scales exceeding a single 65535-byte stored DEFLATE block cleanly", () => {
      const url = "https://www.berkahwisata.id/tour/paket-spesial-ramadhan-2026?utm_source=qr";
      // moduleSize=24 on a ~41+8=49 module QR -> 1176x1176 px -> >170 KiB raw scanlines (multiple stored DEFLATE blocks)
      const largePng = renderQrPngBytes(url, { quietZone: 4, moduleSize: 24 });
      const decoded = decodeQrPngToText(largePng);
      expect(decoded.text).toBe(url);
      expect(decoded.moduleSize).toBe(24);
    });

    it("produces safe ASCII download filenames and scoped tenant API URLs", () => {
      expect(
        buildQrDownloadFilename({
          targetKind: "website",
          tenantHandle: "alpha-studio",
          format: "svg",
        }),
      ).toBe("qr-alpha-studio.svg");

      expect(
        buildQrDownloadFilename({
          targetKind: "offering",
          offeringType: "tour",
          slug: "paket-bali-3d2n",
          format: "png",
        }),
      ).toBe("qr-tour-paket-bali-3d2n.png");

      expect(
        buildTenantQrApiUrl({
          tenantId: "01JT108TENANT0000000000001",
          targetKind: "offering",
          targetId: 12,
          format: "png",
          includeUtmQr: true,
        }),
      ).toBe("/api/tenants/01JT108TENANT0000000000001/qr?target=offering&id=12&format=png&utm=1");
    });
  });

  describe("Insights QR Scan Visit Classification & Aggregation", () => {
    it("matches utm_source=qr case-insensitively and rejects non-QR lookalikes", () => {
      expect(classifyQrScanVisit("https://www.berkahwisata.id/?utm_source=qr")).toMatchObject({
        isQrScan: true,
        utmSource: "qr",
        channel: "qr_scan",
        label: "Pindaian QR",
        path: "/",
      });

      expect(
        classifyQrScanVisit("https://www.berkahwisata.id/produk/kopi-gayo?foo=1&UTM_SOURCE=QR"),
      ).toMatchObject({
        isQrScan: true,
        utmSource: "qr",
        channel: "qr_scan",
        path: "/produk/kopi-gayo",
      });

      expect(classifyQrScanVisit(new URLSearchParams("utm_source=Qr")).isQrScan).toBe(true);
      expect(classifyQrScanVisit("https://www.berkahwisata.id/?utm_source=qrcode").isQrScan).toBe(
        false,
      );
      expect(classifyQrScanVisit("https://www.berkahwisata.id/?utm_source=qr-fake").isQrScan).toBe(
        false,
      );
      expect(classifyQrScanVisit("https://www.berkahwisata.id/?utm_source=google").isQrScan).toBe(
        false,
      );
      expect(classifyQrScanVisit("https://www.berkahwisata.id/").isQrScan).toBe(false);
    });

    it("counts QR scan visits and per-path breakdown accurately for Insights", () => {
      const summary = countQrScanVisits([
        "https://www.berkahwisata.id/?utm_source=qr",
        "https://www.berkahwisata.id/tour/umrah-9-hari?utm_source=QR",
        { landingUrl: "https://www.berkahwisata.id/tour/umrah-9-hari?utm_source=qr", count: 3 },
        "https://www.berkahwisata.id/tentang-kami",
        { landingUrl: "https://www.berkahwisata.id/?utm_source=google", count: 4 },
      ]);

      expect(summary.totalVisits).toBe(10);
      expect(summary.qrScans).toBe(5);
      expect(summary.nonQrVisits).toBe(5);
      expect(summary.sharePercent).toBe(50);
      expect(summary.byPath).toEqual([
        { path: "/tour/umrah-9-hari", qrScans: 4 },
        { path: "/", qrScans: 1 },
      ]);
    });
  });

  describe("Static Security & Design Contract Guards (DEC-036, PLAN §20.5)", () => {
    const ownedFiles = [
      "packages/core/src/qr/encoder.ts",
      "packages/core/src/qr/png.ts",
      "packages/core/src/qr/canonical.ts",
      "packages/core/src/qr/insights.ts",
      "packages/core/src/qr/index.ts",
      "apps/web/src/components/admin/qr/QrCodeDownloadDialog.tsx",
      "apps/web/src/components/admin/qr/index.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/qr/index.ts",
    ];

    it("contains zero @radix-ui/* imports, zero asChild props, and zero external QR API service URLs", () => {
      const externalQrApiRe =
        /api\.qrserver\.com|chart\.googleapis\.com|quickchart\.io|goqr\.me|qrcode-monkey|qr-code-generator\.com/i;
      const radixRe = /@radix-ui\/|from\s+["']radix-ui["']/;
      const asChildRe = /\basChild(?:\s*=|\s*\?|\s*:|\s*,|\s*\}|\s*\)|\s*\/?>)/;

      for (const relPath of ownedFiles) {
        const content = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
        expect(content, `${relPath} must not reference external QR services`).not.toMatch(
          externalQrApiRe,
        );
        expect(content, `${relPath} must not import Radix UI`).not.toMatch(radixRe);
        expect(content, `${relPath} must not use Radix asChild`).not.toMatch(asChildRe);
      }
    });
  });
});

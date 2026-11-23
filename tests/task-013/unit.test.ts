import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLOSED_SECTION_TYPES,
  isHealthBusinessCategory,
  PERMENKES_TESTIMONIALS_WARNING_CODE,
  PLATFORM_THEME_IDS,
  PLATFORM_THEME_SECTION_PROFILES,
  SectionRegistryValidationError,
  switchPageThemeLosslessly,
  validatePageSections,
  verifyPreviewPublishedSectionParity,
} from "../../packages/core/src/theme/index.ts";
import {
  assemblePageSections,
  formatSectionOfferingPriceText,
  resolveSectionComponentEntry,
  resolveSectionOfferingCta,
  safeAssemblePageSections,
  SECTION_REGISTRY_MAP,
} from "../../apps/web/src/core/section-registry.ts";

function buildFullUnifiedSectionsFixture() {
  return [
    {
      id: "hero-utama",
      type: "hero",
      enabled: true,
      config: {
        eyebrow: "Mitra Profesional Indonesia",
        heading: "Solusi Terpadu untuk Pertumbuhan Bisnis Anda",
        subheading: "Layanan transparan, dokumentasi lengkap, dan konsultasi langsung via WhatsApp.",
        primaryCta: {
          label: "Konsultasi WhatsApp",
          href: "https://wa.me/6281234567890",
          variant: "whatsapp",
          openInNewTab: true,
        },
        secondaryCta: {
          label: "Lihat Penawaran",
          href: "#penawaran",
          variant: "secondary",
        },
        highlights: ["Garansi Layanan Resmi", "Respon Cepat Jam Kerja", "Harga Transparan"],
      },
    },
    {
      id: "keunggulan",
      type: "features",
      enabled: true,
      config: {
        eyebrow: "Mengapa Memilih Kami",
        heading: "Standar Kerja Terukur",
        columns: 3,
        items: [
          {
            title: "Tim Berpengalaman",
            description: "Ditangani langsung oleh praktisi tersertifikasi.",
            badge: "Tersertifikasi",
          },
          {
            title: "Estimasi Jelas",
            description: "Rincian biaya disepakati di awal tanpa biaya tersembunyi.",
          },
          {
            title: "Dukungan Penuh",
            description: "Pendampingan menyeluruh sebelum dan sesudah pengerjaan.",
          },
        ],
      },
    },
    {
      id: "penawaran",
      type: "offerings_grid",
      enabled: true,
      config: {
        eyebrow: "Katalog Unggulan",
        heading: "Penawaran Pilihan",
        limit: 6,
        items: [
          {
            slug: "audit-arsitektur-bisnis",
            offeringType: "service",
            title: "Audit & Konsultasi Bisnis",
            summary: "Evaluasi menyeluruh alur operasional dan rekomendasi praktis.",
            priceMode: "from",
            price: 2_500_000,
            negotiable: true,
            badge: "Populer",
            ctaKind: "whatsapp",
            whatsappPhone: "0812-3456-7890",
          },
          {
            slug: "paket-wisata-yogyakarta-3h2m",
            offeringType: "tour",
            title: "Paket Wisata Yogyakarta 3H2M",
            summary: "Termasuk hotel bintang 4, transportasi AC, dan pemandu resmi.",
            priceMode: "range",
            price: 1_850_000,
            priceMax: 2_650_000,
            ctaKind: "whatsapp",
            whatsappPhone: "+6281234567890",
            metaLine: "3 Hari 2 Malam · Berangkat Setiap Jumat",
          },
          {
            slug: "suv-keluarga-2023-at",
            offeringType: "vehicle",
            title: "SUV Keluarga 2023 AT",
            summary: "Unit inspeksi 160 titik, servis berkala bengkel resmi.",
            priceMode: "fixed",
            price: 345_000_000,
            originalAmount: 360_000_000,
            unitStatus: "available",
            ctaKind: "inquiry",
            metaLine: "2023 · Automatic · Bensin · 18.000 km",
          },
          {
            slug: "paket-korporat-kustom",
            offeringType: "product",
            title: "Paket Pengadaan Korporat",
            summary: "Konfigurasi khusus sesuai spesifikasi proyek.",
            priceMode: "on_request",
            ctaKind: "external_link",
            ctaLabel: "Lihat Katalog Resmi",
            ctaHref: "https://example.com/katalog-korporat",
          },
        ],
      },
    },
    {
      id: "tentang-kami",
      type: "about",
      enabled: true,
      config: {
        eyebrow: "Profil Usaha",
        heading: "Berdiri Sejak 2016 Melayani Klien Nasional",
        bodyHtml:
          "<p>Kami mengutamakan ketepatan waktu dan kualitas hasil.</p><script>alert(1)</script><p><a href='javascript:alert(2)'>tautan</a></p>",
        milestones: [
          { value: "10+", label: "Tahun Pengalaman" },
          { value: "450+", label: "Proyek Selesai" },
        ],
      },
    },
    {
      id: "galeri-dokumentasi",
      type: "gallery",
      enabled: true,
      config: {
        eyebrow: "Dokumentasi",
        heading: "Galeri Proyek & Video",
        columns: 3,
        items: [
          {
            kind: "image",
            src: "/media/t/demo/proyek-1.webp",
            alt: "Dokumentasi penyelesaian proyek kantor",
            width: 1200,
            height: 800,
            caption: "Penyelesaian ruang kerja Jakarta Selatan",
          },
          {
            kind: "youtube",
            videoId: "dQw4w9WgXcQ",
            title: "Tur Singkat Fasilitas Kerja Kami",
            caption: "Video profil berdurasi 2 menit",
          },
        ],
      },
    },
    {
      id: "testimoni-klien",
      type: "testimonials",
      config: {
        eyebrow: "Ulasan",
        heading: "Kata Klien Kami",
        items: [
          {
            quote: "Pengerjaan rapi, komunikasi responsif, dan sesuai jadwal.",
            authorName: "Rina Kartika",
            authorRole: "Manajer Operasional",
            contextLabel: "Jakarta",
          },
        ],
      },
    },
    {
      id: "faq-umum",
      type: "faq",
      enabled: true,
      config: {
        eyebrow: "Bantuan",
        heading: "Pertanyaan yang Sering Diajukan",
        items: [
          {
            question: "Bagaimana cara memulai konsultasi?",
            answer: "Klik tombol WhatsApp di halaman ini untuk menjadwalkan diskusi awal.",
            defaultOpen: true,
          },
          {
            question: "Apakah tersedia faktur resmi?",
            answer: "Ya, setiap kerja sama dilengkapi dokumen penawaran dan bukti transaksi.",
          },
        ],
      },
    },
    {
      id: "artikel-terbaru",
      type: "blog_latest",
      enabled: true,
      config: {
        eyebrow: "Wawasan",
        heading: "Artikel Terbaru",
        limit: 3,
        posts: [
          {
            slug: "panduan-memilih-mitra-proyek",
            title: "Panduan Memilih Mitra Proyek yang Andal",
            excerpt: "Lima indikator utama sebelum menandatangani kontrak kerja sama.",
            categoryName: "Panduan",
            authorName: "Tim Redaksi",
            publishedAt: "2026-11-10T08:00:00Z",
            readingTimeMinutes: 4,
          },
        ],
      },
    },
    {
      id: "ajakan-aksi",
      type: "cta_banner",
      enabled: true,
      config: {
        eyebrow: "Siap Memulai?",
        heading: "Diskusikan Kebutuhan Anda Hari Ini",
        subheading: "Tim kami siap membantu menyusun rekomendasi yang sesuai anggaran.",
        primaryCta: {
          label: "Chat WhatsApp Sekarang",
          href: "https://wa.me/6281234567890",
          variant: "whatsapp",
          openInNewTab: true,
        },
        secondaryCta: {
          label: "Lihat Lokasi Kantor",
          href: "#kontak",
          variant: "secondary",
        },
      },
    },
    {
      id: "kontak",
      type: "contact_location",
      enabled: true,
      config: {
        eyebrow: "Kunjungi Kami",
        heading: "Kontak & Lokasi",
        address: "Jl. Jenderal Sudirman No. 45, Jakarta Selatan",
        weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
        holidayHours: "Sabtu–Minggu Tutup",
        phone: "+6281234567890",
        email: "halo@contohbisnis.id",
        whatsappPhone: "081234567890",
        mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
      },
    },
  ];
}

describe("TASK-013: Closed Unified Section Registry & Validation", () => {
  it("registers every closed section type to a static Astro component entry", () => {
    for (const sectionType of CLOSED_SECTION_TYPES) {
      const entry = resolveSectionComponentEntry(sectionType);
      expect(entry.type).toBe(sectionType);
      expect(SECTION_REGISTRY_MAP[sectionType]).toEqual(entry);
    }
    expect(SECTION_REGISTRY_MAP.hero.singleton).toBe(true);
    expect(SECTION_REGISTRY_MAP.gallery.componentKey).toBe("SectionGallery");
  });

  it("validates a complete 10-section page and sanitizes rich-text HTML via TASK-006", () => {
    const sections = buildFullUnifiedSectionsFixture();
    const res = validatePageSections(sections, { businessCategory: "LocalBusiness" });

    expect(res.sections).toHaveLength(10);
    expect(res.enabledSections).toHaveLength(10);
    expect(res.warnings).toHaveLength(0);
    expect(res.isHealthCategory).toBe(false);

    const aboutSection = res.sections.find((s) => s.id === "tentang-kami");
    expect(aboutSection?.type).toBe("about");
    if (aboutSection && aboutSection.type === "about") {
      expect(aboutSection.config.bodyHtml).not.toContain("<script>");
      expect(aboutSection.config.bodyHtml).not.toContain("javascript:");
      expect(aboutSection.config.bodyHtml).toContain("ketepatan waktu");
    }
  });

  it("rejects unknown section types with UNKNOWN_SECTION_TYPE", () => {
    expect(() =>
      validatePageSections([
        {
          id: "bad-widget",
          type: "arbitrary_html_inject",
          config: { html: "<script>alert(1)</script>" },
        },
      ]),
    ).toThrowError(SectionRegistryValidationError);

    try {
      validatePageSections([{ id: "bad-widget", type: "custom_script_block", config: {} }]);
    } catch (err) {
      expect(err).toBeInstanceOf(SectionRegistryValidationError);
      expect((err as SectionRegistryValidationError).code).toBe("UNKNOWN_SECTION_TYPE");
      expect((err as SectionRegistryValidationError).httpStatus).toBe(422);
    }

    expect(() => resolveSectionComponentEntry("nonexistent_type")).toThrowError(
      SectionRegistryValidationError,
    );
  });

  it("rejects duplicate singleton hero sections with DUPLICATE_SINGLETON_SECTION", () => {
    const duplicateHeroes = [
      {
        id: "hero-1",
        type: "hero",
        enabled: true,
        config: { heading: "Hero Pertama" },
      },
      {
        id: "hero-2",
        type: "hero",
        enabled: false,
        config: { heading: "Hero Kedua" },
      },
    ];

    try {
      validatePageSections(duplicateHeroes);
      expect.unreachable("Duplicate singleton hero must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SectionRegistryValidationError);
      expect((err as SectionRegistryValidationError).code).toBe("DUPLICATE_SINGLETON_SECTION");
    }
  });

  it("rejects unsafe URLs (javascript:, data:, vbscript:, protocol-relative //)", () => {
    const unsafePayloads = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "//evil.example/phish",
    ];

    for (const badHref of unsafePayloads) {
      try {
        validatePageSections([
          {
            id: "cta-unsafe",
            type: "cta_banner",
            config: {
              heading: "Promo",
              primaryCta: { label: "Klik", href: badHref, variant: "primary" },
            },
          },
        ]);
        expect.unreachable(`Expected unsafe href "${badHref}" to fail`);
      } catch (err) {
        expect(err).toBeInstanceOf(SectionRegistryValidationError);
        expect((err as SectionRegistryValidationError).code).toBe("UNSAFE_URL");
      }
    }

    // Unsafe image src in gallery
    expect(() =>
      validatePageSections([
        {
          id: "gal-bad",
          type: "gallery",
          config: {
            heading: "Galeri",
            items: [{ kind: "image", src: "data:image/svg+xml,<svg onload=alert(1)>", alt: "x" }],
          },
        },
      ]),
    ).toThrowError(SectionRegistryValidationError);
  });

  it("rejects oversized configs and too many sections cleanly", () => {
    const tooMany = Array.from({ length: 31 }, (_, i) => ({
      id: `faq-${i}`,
      type: "faq",
      config: { heading: `FAQ ${i}`, items: [] },
    }));
    try {
      validatePageSections(tooMany);
      expect.unreachable("Expected TOO_MANY_SECTIONS");
    } catch (err) {
      expect((err as SectionRegistryValidationError).code).toBe("TOO_MANY_SECTIONS");
    }

    const hugeText = "A".repeat(140_000);
    try {
      validatePageSections([
        {
          id: "huge-rt",
          type: "rich_text",
          config: { bodyHtml: hugeText },
        },
      ]);
      expect.unreachable("Expected OVERSIZED_SECTION_CONFIG");
    } catch (err) {
      expect((err as SectionRegistryValidationError).code).toBe("OVERSIZED_SECTION_CONFIG");
    }
  });
});

describe("TASK-013: Permenkes Health-Category Testimonials Compliance Rule", () => {
  it("recognizes Indonesian & Schema.org health/medical categories accurately", () => {
    for (const cat of [
      "health",
      "kesehatan",
      "klinik",
      "Klinik Gigi",
      "medis",
      "MedicalClinic",
      "Dokter Umum",
      "Rumah Sakit",
      "Apotek",
    ]) {
      expect(isHealthBusinessCategory(cat)).toBe(true);
    }
    for (const nonHealth of ["LocalBusiness", "Restaurant", "TravelAgency", "AutoDealer", ""]) {
      expect(isHealthBusinessCategory(nonHealth)).toBe(false);
    }
  });

  it("defaults testimonials OFF (enabled: false) and emits Permenkes warning for health categories", () => {
    const sections = buildFullUnifiedSectionsFixture();
    for (const cat of ["health", "kesehatan", "klinik", "medis"]) {
      const res = validatePageSections(sections, { businessCategory: cat });
      expect(res.isHealthCategory).toBe(true);

      const testimonial = res.sections.find((s) => s.id === "testimoni-klien");
      expect(testimonial?.enabled).toBe(false);
      expect(res.enabledSections.some((s) => s.id === "testimoni-klien")).toBe(false);
      expect(res.disabledSectionIds).toContain("testimoni-klien");

      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]?.code).toBe(PERMENKES_TESTIMONIALS_WARNING_CODE);
      expect(res.warnings[0]?.defaultedOff).toBe(true);
      expect(res.warnings[0]?.message).toContain("Permenkes");
    }
  });

  it("still emits Permenkes warning even if a health tenant explicitly toggles testimonials enabled: true", () => {
    const res = validatePageSections(
      [
        {
          id: "testimoni-klinik",
          type: "testimonials",
          enabled: true,
          config: {
            heading: "Ulasan Pasien",
            items: [{ quote: "Pelayanan ramah.", authorName: "Budi" }],
          },
        },
      ],
      { businessCategory: "klinik" },
    );

    expect(res.sections[0]?.enabled).toBe(true);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]?.code).toBe(PERMENKES_TESTIMONIALS_WARNING_CODE);
    expect(res.warnings[0]?.defaultedOff).toBe(false);
  });
});

describe("TASK-013: Lossless Theme Switching Across All 6 Platform Themes", () => {
  it("preserves 100% of section data, order, and enabled flags when switching across compro/sales/travel/catalog/resto/dealer", () => {
    const originalSections = buildFullUnifiedSectionsFixture();
    const initialValidated = validatePageSections(originalSections, {
      businessCategory: "LocalBusiness",
    });

    let currentSections: unknown = originalSections;
    let currentTheme: string = "compro";

    for (const nextTheme of PLATFORM_THEME_IDS) {
      expect(PLATFORM_THEME_SECTION_PROFILES[nextTheme].supportedSectionTypes).toEqual(
        CLOSED_SECTION_TYPES,
      );

      const switched = switchPageThemeLosslessly({
        fromThemeId: currentTheme,
        toThemeId: nextTheme,
        sections: currentSections,
        businessCategory: "LocalBusiness",
      });

      expect(switched.lossless).toBe(true);
      expect(switched.droppedCount).toBe(0);
      expect(switched.preservedCount).toBe(initialValidated.sections.length);
      expect(switched.sections).toEqual(initialValidated.sections);
      expect(switched.targetProfile.themeId).toBe(nextTheme);

      currentTheme = nextTheme;
      currentSections = switched.sections;
    }

    // Round-trip back to compro stays byte-identical
    const roundTrip = switchPageThemeLosslessly({
      fromThemeId: currentTheme,
      toThemeId: "compro",
      sections: currentSections,
      businessCategory: "LocalBusiness",
    });
    expect(roundTrip.sections).toEqual(initialValidated.sections);
  });
});

describe("TASK-013: Preview vs Published Order/Toggle Parity & Route Assembly (/ and /{pageSlug})", () => {
  it("agrees on exact section order and enabled toggles across preview and published on / and /{pageSlug}", () => {
    const base = buildFullUnifiedSectionsFixture();
    // Reorder: move FAQ before Gallery, disable Testimonials & Blog Latest
    const customOrdered = [
      base[0]!, // hero-utama (enabled)
      base[2]!, // penawaran (enabled)
      base[6]!, // faq-umum (enabled)
      { ...base[5]!, enabled: false }, // testimoni-klien (disabled)
      base[4]!, // galeri-dokumentasi (enabled)
      { ...base[7]!, enabled: false }, // artikel-terbaru (disabled)
      base[9]!, // kontak (enabled)
    ];

    const parity = verifyPreviewPublishedSectionParity(customOrdered, customOrdered);
    expect(parity.equal).toBe(true);
    expect(parity.previewEnabledIds).toEqual([
      "hero-utama",
      "penawaran",
      "faq-umum",
      "galeri-dokumentasi",
      "kontak",
    ]);
    expect(parity.publishedEnabledIds).toEqual(parity.previewEnabledIds);

    // Home route `/`
    const previewHome = assemblePageSections({
      routePath: "/",
      isHomepage: true,
      themeId: "compro",
      mode: "preview",
      sections: customOrdered,
    });
    const publishedHome = assemblePageSections({
      routePath: "/",
      isHomepage: true,
      themeId: "compro",
      mode: "published",
      sections: customOrdered,
    });
    expect(previewHome.renderableSections.map((r) => r.section.id)).toEqual(
      publishedHome.renderableSections.map((r) => r.section.id),
    );
    expect(previewHome.disabledSectionIds).toEqual(["testimoni-klien", "artikel-terbaru"]);
    expect(publishedHome.disabledSectionIds).toEqual(previewHome.disabledSectionIds);

    // Static page route `/{pageSlug}`
    const staticPage = assemblePageSections({
      pageSlug: "tentang-kami",
      isHomepage: false,
      themeId: "resto",
      mode: "published",
      sections: customOrdered,
    });
    expect(staticPage.routeKind).toBe("page");
    expect(staticPage.routePath).toBe("/tentang-kami");
    expect(staticPage.renderableSections.map((r) => r.section.id)).toEqual(
      publishedHome.renderableSections.map((r) => r.section.id),
    );
  });

  it("detects preview vs published order or toggle drift", () => {
    const a = [
      { id: "s1", type: "features", enabled: true, config: { heading: "A", items: [] } },
      { id: "s2", type: "faq", enabled: true, config: { heading: "B", items: [] } },
    ];
    const b = [
      { id: "s2", type: "faq", enabled: true, config: { heading: "B", items: [] } },
      { id: "s1", type: "features", enabled: true, config: { heading: "A", items: [] } },
    ];
    const drift = verifyPreviewPublishedSectionParity(a, b);
    expect(drift.equal).toBe(false);
    expect(drift.mismatchReason).toContain("Section mismatch");
  });

  it("formats honest IDR offering prices and safe WhatsApp CTAs (on_request never reads as free)", () => {
    const validated = validatePageSections(buildFullUnifiedSectionsFixture());
    const grid = validated.sections.find((s) => s.id === "penawaran");
    expect(grid?.type).toBe("offerings_grid");
    if (grid && grid.type === "offerings_grid") {
      const [service, tour, vehicle, onReq] = grid.config.items;
      expect(formatSectionOfferingPriceText(service!)).toBe("Mulai Rp 2.500.000 (Nego)");
      expect(formatSectionOfferingPriceText(tour!)).toBe("Rp 1.850.000 - Rp 2.650.000");
      expect(formatSectionOfferingPriceText(vehicle!)).toBe("Rp 345.000.000");
      expect(formatSectionOfferingPriceText(onReq!)).toBe("Hubungi untuk harga");
      expect(formatSectionOfferingPriceText(onReq!).toLowerCase()).not.toContain("gratis");

      const waCta = resolveSectionOfferingCta(service!, {
        primaryOrigin: "https://contoh.situsku.click",
      });
      expect(waCta.isWhatsApp).toBe(true);
      expect(waCta.href).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/);
    }
  });

  it("fails safely in safeAssemblePageSections without throwing on malformed input", () => {
    const res = safeAssemblePageSections({
      themeId: "compro",
      sections: [{ id: "x", type: "illegal_section", config: {} }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("UNKNOWN_SECTION_TYPE");
    }
  });

  it("enforces strict public theme boundary (zero React/Radix/BaseUI/DB imports in sections & registry)", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const filesToCheck = [
      path.join(root, "apps/web/src/core/section-registry.ts"),
      ...fs
        .readdirSync(path.join(root, "apps/web/src/themes/default/sections"))
        .map((f) => path.join(root, "apps/web/src/themes/default/sections", f)),
    ];

    const forbiddenPatterns = [
      /@radix-ui\//,
      /@base-ui\/react/,
      /from\s+["']react["']/,
      /@punyasitus\/db/,
      /@punyasitus\/auth/,
      /client:(?:load|idle|visible|only|media)/,
      /components\/ui/,
    ];

    for (const file of filesToCheck) {
      const content = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        expect(content, `${path.basename(file)} matched forbidden pattern ${pattern}`).not.toMatch(
          pattern,
        );
      }
    }
  });
});

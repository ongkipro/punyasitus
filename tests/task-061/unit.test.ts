import fs from "node:fs";
import path from "node:path";
import {
  buildCustomThemeWhatsAppUrl,
  CUSTOM_THEME_QUOTE_ONLY_PRICE_LABEL,
  CustomThemeValidationError,
  formatCustomThemeStartingPriceLabel,
  isAllowedCustomThemeStatusTransition,
  validateCreateCustomThemePackageInput,
  validateCreateCustomThemeRequestInput,
  validateCustomThemeReferenceUrls,
  validateTransitionCustomThemeRequestInput,
  validateUpdateCustomThemePackageInput,
} from "@punyasitus/core/custom-themes/index";
import { renderEmailTemplate } from "@punyasitus/core/email/index";
import { CUSTOM_THEME_SERVICE_MIGRATION_SQL } from "@punyasitus/db/custom-themes/migrations";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateCustomThemeServicePageGate,
  loadCustomThemeServicePageOrGateResponse,
} from "../../apps/web/src/pages/dashboard/[handle]/appearance/themes/custom/_page-gate.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-061 unit — migration parity, static R3 guards, validation, WA encoding & page gate", () => {
  it("matches 0016_custom_theme_service.sql byte-for-byte with bundled migration constant", () => {
    const diskSql = fs.readFileSync(
      path.join(REPO_ROOT, "packages/db/migrations/platform/0016_custom_theme_service.sql"),
      "utf8",
    );
    expect(CUSTOM_THEME_SERVICE_MIGRATION_SQL).toBe(diskSql);
  });

  it("contains ZERO request-time runtime DDL and ZERO Radix/asChild imports across TASK-061 files", () => {
    const runtimeFiles = [
      "packages/db/src/custom-themes/repository.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/custom-theme-requests/_shared.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/custom-theme-requests/index.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/custom-theme-requests/[requestId].ts",
      "apps/web/src/pages/api/tenants/[tenantId]/custom-theme-packages/index.ts",
      "apps/web/src/pages/api/console/custom-themes/_shared.ts",
      "apps/web/src/pages/api/console/custom-themes/packages/index.ts",
      "apps/web/src/pages/api/console/custom-themes/packages/[packageId].ts",
      "apps/web/src/pages/api/console/custom-themes/requests/index.ts",
      "apps/web/src/pages/api/console/custom-themes/requests/[requestId].ts",
      "apps/web/src/pages/dashboard/[handle]/appearance/themes/custom/_page-gate.ts",
      "apps/web/src/pages/dashboard/[handle]/appearance/themes/custom/index.astro",
      "apps/web/src/pages/console/custom-themes/index.astro",
    ];

    for (const relPath of runtimeFiles) {
      const content = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      expect(content, `Runtime DDL found in ${relPath}`).not.toMatch(/CREATE\s+TABLE/i);
      expect(content, `Migration helper called in ${relPath}`).not.toMatch(
        /applyCustomThemeServiceMigration|ensure[A-Za-z0-9]*Schema/,
      );
    }

    const uiFiles = [
      "apps/web/src/components/admin/custom-theme/CustomThemeServicePage.tsx",
      "apps/web/src/components/admin/custom-theme/ConsoleCustomThemesPanel.tsx",
    ];
    for (const relPath of uiFiles) {
      const content = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      expect(content, `Forbidden Radix import in ${relPath}`).not.toMatch(/@radix-ui|radix-ui/);
      expect(content, `Forbidden asChild prop in ${relPath}`).not.toMatch(/\basChild\b/);
    }
  });

  it("validates up to 5 public HTTPS reference URLs, rejects unsafe schemes/hosts, and NEVER calls fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const valid = validateCustomThemeReferenceUrls([
        "https://brand-a.example.com/home",
        "https://brand-b.example.com/work?ref=1",
        "https://brand-a.example.com/home", // deduplicated
        "https://brand-c.example.com",
        "https://brand-d.example.com",
      ]);
      expect(valid).toHaveLength(4);
      expect(fetchSpy).not.toHaveBeenCalled();

      // 6th URL rejected
      expect(() =>
        validateCustomThemeReferenceUrls([
          "https://a.example.com",
          "https://b.example.com",
          "https://c.example.com",
          "https://d.example.com",
          "https://e.example.com",
          "https://f.example.com",
        ]),
      ).toThrowError(CustomThemeValidationError);

      // Unsafe protocols & private/loopback hosts rejected
      const badUrls = [
        "http://insecure.example.com",
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "https://user:secret@example.com",
        "https://localhost/admin",
        "https://127.0.0.1/internal",
        "https://10.0.0.5/corp",
        "https://169.254.169.254/latest/meta-data/",
        "https://192.168.1.1/router",
        "https://[::1]/loopback",
        "https://svc.internal/api",
      ];
      for (const bad of badUrls) {
        expect(() => validateCustomThemeReferenceUrls([bad]), `Should reject ${bad}`).toThrowError(
          CustomThemeValidationError,
        );
      }

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("formats starting IDR price and quote-only label accurately", () => {
    expect(formatCustomThemeStartingPriceLabel(3_500_000)).toBe("Mulai dari Rp 3.500.000");
    expect(formatCustomThemeStartingPriceLabel(12_750_000)).toBe("Mulai dari Rp 12.750.000");
    expect(formatCustomThemeStartingPriceLabel(null)).toBe(CUSTOM_THEME_QUOTE_ONLY_PRICE_LABEL);
    expect(formatCustomThemeStartingPriceLabel(null)).toBe("Harga berdasarkan penawaran");
  });

  it("encodes WhatsApp link strictly once with handle, request code and package name (no double encoding)", () => {
    const result = buildCustomThemeWhatsAppUrl({
      salesWhatsapp: "0812-3456-7890",
      tenantHandle: "kopi-nusantara",
      requestCode: "CTR-20261123-ABC123",
      packageName: "Brand & Korporat (100% Custom)",
    });

    expect(result).not.toBeNull();
    expect(result!.phone).toBe("6281234567890");
    expect(result!.url.startsWith("https://wa.me/6281234567890?text=")).toBe(true);
    // Must not double-encode %20 or %26 into %2520 / %2526
    expect(result!.url).not.toContain("%2520");
    expect(result!.url).not.toContain("%2526");
    expect(result!.url).not.toContain("%250A");

    const parsed = new URL(result!.url);
    const decodedOnce = parsed.searchParams.get("text");
    expect(decodedOnce).toBe(result!.message);
    expect(decodedOnce).toContain("kopi-nusantara");
    expect(decodedOnce).toContain("CTR-20261123-ABC123");
    expect(decodedOnce).toContain("Brand & Korporat (100% Custom)");

    // Unconfigured sales number yields null (never invents a number)
    expect(
      buildCustomThemeWhatsAppUrl({
        salesWhatsapp: "",
        tenantHandle: "kopi-nusantara",
      }),
    ).toBeNull();
  });

  it("validates tenant request, package CRUD, and status transition contracts", () => {
    const validReq = validateCreateCustomThemeRequestInput(
      {
        packageId: "undecided",
        brandName: "Kopi Nusantara",
        brief: "Ingin desain editorial minimalis dengan fokus galeri produk.",
        referenceUrls: ["https://referensi.example.com"],
        budgetRange: "Rp 5 jt - Rp 8 jt",
        contactPreference: "whatsapp",
      },
      { headerIdempotencyKey: "idem-key-12345678" },
    );
    expect(validReq.packageId).toBeNull();
    expect(validReq.idempotencyKey).toBe("idem-key-12345678");

    expect(() =>
      validateCreateCustomThemeRequestInput(
        { brandName: "", brief: "", referenceUrls: [] },
        { headerIdempotencyKey: "short" },
      ),
    ).toThrowError(CustomThemeValidationError);

    const validPkg = validateCreateCustomThemePackageInput({
      slug: "corporate-bespoke",
      name: "Tema Korporat Eksklusif",
      description: "Desain menyeluruh untuk profil perusahaan B2B.",
      inclusions: ["Desain khusus 6 halaman", "2x revisi"],
      startingPriceIdr: null,
      estimatedDuration: "14 hari kerja",
      sortOrder: 10,
      active: true,
      reason: "Menambahkan paket penawaran khusus korporat",
    });
    expect(validPkg.startingPriceIdr).toBeNull();

    // Update requires expectedVersion + reason >= 10 chars
    expect(() =>
      validateUpdateCustomThemePackageInput({
        expectedVersion: 1,
        name: "Baru",
        reason: "terlalu",
      }),
    ).toThrowError(CustomThemeValidationError);

    // Delivered requires deliveredThemeId
    expect(() =>
      validateTransitionCustomThemeRequestInput({
        expectedVersion: 2,
        status: "delivered",
        reason: "Menandai permintaan sebagai selesai diserahkan",
      }),
    ).toThrowError(CustomThemeValidationError);

    const validDelivered = validateTransitionCustomThemeRequestInput({
      expectedVersion: 2,
      status: "delivered",
      deliveredThemeId: "custom-sample-agency",
      reason: "Tema kustom telah diberikan izin aktif kepada tenant",
    });
    expect(validDelivered.deliveredThemeId).toBe("custom-sample-agency");

    expect(isAllowedCustomThemeStatusTransition("new", "contacted")).toBe(true);
    expect(isAllowedCustomThemeStatusTransition("in_progress", "delivered")).toBe(true);
    expect(isAllowedCustomThemeStatusTransition("delivered", "cancelled")).toBe(false);
    expect(isAllowedCustomThemeStatusTransition("declined", "in_progress")).toBe(false);
  });

  it("enforces strict SSR page lifecycle & RBAC gate BEFORE any DB read", async () => {
    // Allowed: owner/admin on active/trial/grace
    for (const status of ["trial", "active", "grace"] as const) {
      expect(
        evaluateCustomThemeServicePageGate({ handle: "alpha", tenantStatus: status, role: "owner" })
          .allowed,
      ).toBe(true);
      expect(
        evaluateCustomThemeServicePageGate({ handle: "alpha", tenantStatus: status, role: "admin" })
          .allowed,
      ).toBe(true);
    }

    // Locked tenant CANNOT open the page -> 302 to /service-status with private/no-store + noindex
    const lockedRes = evaluateCustomThemeServicePageGate({
      handle: "alpha",
      tenantStatus: "locked",
      role: "owner",
    });
    expect(lockedRes.allowed).toBe(false);
    if (!lockedRes.allowed) {
      expect(lockedRes.response.status).toBe(302);
      expect(lockedRes.response.headers.get("Location")).toBe("/dashboard/alpha/service-status");
      expect(lockedRes.response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(lockedRes.response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }

    // Suspended / recovery / operatorHold -> 302 to /service-status
    for (const status of ["suspended", "recovery"] as const) {
      const res = evaluateCustomThemeServicePageGate({
        handle: "alpha",
        tenantStatus: status,
        role: "owner",
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) expect(res.response.status).toBe(302);
    }
    const heldRes = evaluateCustomThemeServicePageGate({
      handle: "alpha",
      tenantStatus: "active",
      role: "owner",
      operatorHold: true,
    });
    expect(heldRes.allowed).toBe(false);
    if (!heldRes.allowed) expect(heldRes.response.status).toBe(302);

    // Purging / purged -> neutral 404
    for (const status of ["purging", "purged"] as const) {
      const res = evaluateCustomThemeServicePageGate({
        handle: "alpha",
        tenantStatus: status,
        role: "owner",
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) expect(res.response.status).toBe(404);
    }

    // Editor -> 403
    const editorRes = evaluateCustomThemeServicePageGate({
      handle: "alpha",
      tenantStatus: "active",
      role: "editor",
    });
    expect(editorRes.allowed).toBe(false);
    if (!editorRes.allowed) expect(editorRes.response.status).toBe(403);

    // Loader makes ZERO platformDb calls when gated (locked / editor)
    const prepareSpy = vi.fn(() => {
      throw new Error("DB MUST NOT BE TOUCHED WHEN GATED");
    });
    const fakeDb = { prepare: prepareSpy } as unknown as D1Database;

    const lockedLoad = await loadCustomThemeServicePageOrGateResponse({
      platformDb: fakeDb,
      member: {
        tenantId: "01JT061LOCKED0000000000001",
        handle: "alpha",
        tenantName: "Alpha",
        userId: "u1",
        role: "owner",
        tenantStatus: "locked",
      },
    });
    expect(lockedLoad.ok).toBe(false);
    expect(prepareSpy).not.toHaveBeenCalled();

    const editorLoad = await loadCustomThemeServicePageOrGateResponse({
      platformDb: fakeDb,
      member: {
        tenantId: "01JT061ACTIVE0000000000001",
        handle: "alpha",
        tenantName: "Alpha",
        userId: "u2",
        role: "editor",
        tenantStatus: "active",
      },
    });
    expect(editorLoad.ok).toBe(false);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it("renders Indonesian operator email notification template with strict HTML escaping", () => {
    const rendered = renderEmailTemplate("custom-theme-request-operator-notice", {
      recipientName: "Admin <Platform>",
      requestCode: "CTR-20261123-XYZ999",
      tenantHandle: "kopi-nusantara",
      brandName: "Kopi <script>alert(1)</script>",
      packageName: "Paket Brand & Korporat",
      contactPreference: "whatsapp",
      consoleUrl: "https://console.punyasitus.com/console/custom-themes?request=CTR-20261123-XYZ999",
    });

    expect(rendered.subject).toContain("CTR-20261123-XYZ999");
    expect(rendered.subject).toContain("kopi-nusantara");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.text).toContain("CTR-20261123-XYZ999");
    expect(rendered.text).toContain("https://console.punyasitus.com/console/custom-themes");
  });
});

import fs from "node:fs";
import path from "node:path";
import {
  buildSetupServiceWhatsAppUrl,
  CustomThemeValidationError,
  formatCustomThemeStartingPriceLabel,
  SETUP_SERVICE_SEAT_FULL_EXPLANATION,
  validateCreateSetupServiceRequestInput,
  validateSetupStaffAccessActionInput,
  validateTransitionCustomThemeRequestInput,
} from "@punyasitus/core/custom-themes/index";
import {
  CUSTOM_THEME_SERVICE_MIGRATION_SQL,
  SETUP_SERVICE_STAFF_DELIVERY_MIGRATION_SQL,
} from "@punyasitus/db/custom-themes/migrations";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateSetupServicePageGate,
  loadSetupServicePageOrGateResponse,
} from "../../apps/web/src/pages/dashboard/[handle]/setup-service/_page-gate.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-069 unit — Terima Beres Setup Service validation, migration parity, WA CTA, UI & page gate", () => {
  it("1. Keeps 0026_setup_service_staff_delivery.sql & 0016_custom_theme_service.sql byte-for-byte in sync with bundled migrations and enforces zero runtime DDL", () => {
    const disk0016 = fs.readFileSync(
      path.join(REPO_ROOT, "packages/db/migrations/platform/0016_custom_theme_service.sql"),
      "utf8",
    );
    const disk0026 = fs.readFileSync(
      path.join(REPO_ROOT, "packages/db/migrations/platform/0026_setup_service_staff_delivery.sql"),
      "utf8",
    );

    expect(CUSTOM_THEME_SERVICE_MIGRATION_SQL).toBe(disk0016);
    expect(SETUP_SERVICE_STAFF_DELIVERY_MIGRATION_SQL).toBe(disk0026);
    expect(disk0026).toContain("staff_access_state");
    expect(disk0026).toContain("waiting_seat");

    const runtimeFiles = [
      "packages/db/src/custom-themes/repository.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/service-requests/_shared.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/service-requests/index.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/service-requests/[requestId].ts",
      "apps/web/src/pages/api/tenants/[tenantId]/service-requests/[requestId]/staff-access.ts",
      "apps/web/src/pages/dashboard/[handle]/setup-service/_page-gate.ts",
      "apps/web/src/pages/dashboard/[handle]/setup-service/index.astro",
    ];
    for (const relPath of runtimeFiles) {
      const src = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      expect(src, `Runtime DDL found in ${relPath}`).not.toMatch(
        /applyCustomThemeServiceMigration|applySetupServiceStaffDeliveryMigration|ensure[A-Za-z0-9]*Schema/,
      );
      expect(src, `CREATE TABLE DDL found in ${relPath}`).not.toMatch(/CREATE\s+TABLE/i);
    }
  });

  it("2. Enforces base-nova UI hygiene (zero @radix-ui, zero asChild, zero Sparkles/SparklesIcon)", () => {
    const uiFiles = [
      "apps/web/src/components/admin/custom-theme/SetupServicePage.tsx",
      "apps/web/src/components/admin/custom-theme/ConsoleCustomThemesPanel.tsx",
    ];
    for (const relPath of uiFiles) {
      const src = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      expect(src, `Forbidden @radix-ui import in ${relPath}`).not.toContain("@radix-ui/");
      expect(src, `Forbidden asChild prop in ${relPath}`).not.toMatch(/\basChild\b/);
      expect(src, `Forbidden Sparkles icon in ${relPath}`).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }
  });

  it("3. Validates setup service creation with strict Zod v4 schema, HTTPS-only URLs, never calls fetch()", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const valid = validateCreateSetupServiceRequestInput(
        {
          packageId: "01JT069PKG0000000000000001",
          brandName: "Klinik Gigi Senyum Sehat",
          brief: "Isi halaman beranda, daftar layanan perawatan gigi, serta profil dokter.",
          referenceUrls: ["https://contoh-klinik.example.com/layanan"],
          budgetRange: "Rp 1.500.000",
          contactPreference: "whatsapp",
        },
        { headerIdempotencyKey: "tbr-idem-20261123-001" },
      );

      expect(valid.serviceKind).toBe("setup");
      expect(valid.brandName).toBe("Klinik Gigi Senyum Sehat");
      expect(valid.referenceUrls).toEqual(["https://contoh-klinik.example.com/layanan"]);
      expect(valid.idempotencyKey).toBe("tbr-idem-20261123-001");
      expect(fetchSpy).not.toHaveBeenCalled();

      // Rejects unknown fields strictly
      expect(() =>
        validateCreateSetupServiceRequestInput(
          {
            brandName: "Klinik",
            brief: "Brief valid",
            extraUnexpectedField: "boom",
          },
          { headerIdempotencyKey: "tbr-idem-unknown-01" },
        ),
      ).toThrowError(CustomThemeValidationError);

      // Rejects non-HTTPS URLs & >5 URLs
      expect(() =>
        validateCreateSetupServiceRequestInput(
          {
            brandName: "Klinik",
            brief: "Brief valid",
            referenceUrls: ["http://insecure.example.com"],
          },
          { headerIdempotencyKey: "tbr-idem-http-01" },
        ),
      ).toThrowError(CustomThemeValidationError);

      expect(() =>
        validateCreateSetupServiceRequestInput(
          {
            brandName: "Klinik",
            brief: "Brief valid",
            referenceUrls: [
              "https://a.example.com",
              "https://b.example.com",
              "https://c.example.com",
              "https://d.example.com",
              "https://e.example.com",
              "https://f.example.com",
            ],
          },
          { headerIdempotencyKey: "tbr-idem-six-01" },
        ),
      ).toThrowError(CustomThemeValidationError);

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("4. Validates owner staff-access approve/revoke action strictly with Zod v4", () => {
    const approve = validateSetupStaffAccessActionInput({
      action: "approve",
      expectedVersion: 2,
      reason: "Menyetujui akses Editor sementara Tim Setup",
    });
    expect(approve).toEqual({
      action: "approve",
      expectedVersion: 2,
      reason: "Menyetujui akses Editor sementara Tim Setup",
    });

    const revoke = validateSetupStaffAccessActionInput({
      action: "revoke",
      expectedVersion: 3,
    });
    expect(revoke).toEqual({ action: "revoke", expectedVersion: 3, reason: null });

    // Unknown field rejected
    expect(() =>
      validateSetupStaffAccessActionInput({
        action: "approve",
        expectedVersion: 2,
        role: "owner",
      }),
    ).toThrowError(CustomThemeValidationError);

    // Invalid action or version rejected
    expect(() =>
      validateSetupStaffAccessActionInput({ action: "impersonate", expectedVersion: 1 }),
    ).toThrowError(CustomThemeValidationError);
    expect(() =>
      validateSetupStaffAccessActionInput({ action: "approve", expectedVersion: 0 }),
    ).toThrowError(CustomThemeValidationError);
  });

  it("5. Allows setup `delivered` without theme grant while preserving custom_theme theme-grant requirement", () => {
    // Setup delivered succeeds WITHOUT deliveredThemeId
    const setupDelivered = validateTransitionCustomThemeRequestInput(
      {
        expectedVersion: 3,
        status: "delivered",
        reason: "Seluruh halaman profil dan layanan selesai disiapkan untuk tenant",
      },
      { serviceKind: "setup" },
    );
    expect(setupDelivered.status).toBe("delivered");
    expect(setupDelivered.deliveredThemeId).toBeUndefined();

    // Setup rejects deliveredThemeId (never links theme grants)
    expect(() =>
      validateTransitionCustomThemeRequestInput(
        {
          expectedVersion: 3,
          status: "delivered",
          deliveredThemeId: "custom-sample-agency",
          reason: "Tidak boleh menautkan tema kustom pada setup",
        },
        { serviceKind: "setup" },
      ),
    ).toThrowError(CustomThemeValidationError);

    // Setup allows nominating staff email on in_progress
    const withStaff = validateTransitionCustomThemeRequestInput(
      {
        expectedVersion: 1,
        status: "in_progress",
        staffUserEmail: "Setup.Staff@PunyaSitus.com",
        reason: "Menugaskan spesialis setup untuk pengerjaan konten situs",
      },
      { serviceKind: "setup" },
    );
    expect(withStaff.staffUserEmail).toBe("setup.staff@punyasitus.com");

    // Rejects invalid staff email
    expect(() =>
      validateTransitionCustomThemeRequestInput(
        {
          expectedVersion: 1,
          status: "in_progress",
          staffUserEmail: "bukan-email-valid",
          reason: "Menugaskan spesialis setup untuk pengerjaan konten situs",
        },
        { serviceKind: "setup" },
      ),
    ).toThrowError(CustomThemeValidationError);

    // Custom theme delivered STILL requires deliveredThemeId (TASK-061 preserved!)
    expect(() =>
      validateTransitionCustomThemeRequestInput(
        {
          expectedVersion: 2,
          status: "delivered",
          reason: "Menandai permintaan tema kustom selesai tanpa grant",
        },
        { serviceKind: "custom_theme" },
      ),
    ).toThrowError(CustomThemeValidationError);
  });

  it("6. Builds single-encoded setup WhatsApp CTA & pricing labels safely", () => {
    expect(formatCustomThemeStartingPriceLabel(1_500_000)).toBe("Mulai dari Rp 1.500.000");
    expect(formatCustomThemeStartingPriceLabel(null)).toBe("Harga berdasarkan penawaran");
    expect(SETUP_SERVICE_SEAT_FULL_EXPLANATION).toContain("5 kursi");

    const wa = buildSetupServiceWhatsAppUrl({
      salesWhatsapp: "0812-9000-6969",
      tenantHandle: "klinik-senyum",
      requestCode: "TBR-20261123-ABC123",
      packageName: "Paket Terima Beres Lengkap",
    });

    expect(wa).not.toBeNull();
    expect(wa?.url.startsWith("https://wa.me/6281290006969?text=")).toBe(true);
    expect(wa?.url).not.toContain("%2520");
    const decoded = new URL(wa!.url).searchParams.get("text") ?? "";
    expect(decoded).toContain("Layanan Terima Beres");
    expect(decoded).toContain("klinik-senyum");
    expect(decoded).toContain("TBR-20261123-ABC123");
    expect(decoded).toContain("Paket Terima Beres Lengkap");

    expect(
      buildSetupServiceWhatsAppUrl({ salesWhatsapp: "", tenantHandle: "klinik-senyum" }),
    ).toBeNull();
  });

  it("7. Enforces setup page gate BEFORE any DB read for locked, suspended, purged, and editor states", async () => {
    const prepareSpy = vi.fn();
    const fakeDb = { prepare: prepareSpy } as unknown as D1Database;

    const locked = await loadSetupServicePageOrGateResponse({
      platformDb: fakeDb,
      member: {
        tenantId: "01JT069TENANT0000000000001",
        handle: "toko-terkunci",
        tenantName: "Toko Terkunci",
        userId: "user_owner",
        role: "owner",
        tenantStatus: "locked",
      },
    });
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.response.status).toBe(302);
      expect(locked.response.headers.get("Location")).toBe("/dashboard/toko-terkunci/service-status");
    }

    const editor = await loadSetupServicePageOrGateResponse({
      platformDb: fakeDb,
      member: {
        tenantId: "01JT069TENANT0000000000001",
        handle: "toko-aktif",
        tenantName: "Toko Aktif",
        userId: "user_editor",
        role: "editor",
        tenantStatus: "active",
      },
    });
    expect(editor.ok).toBe(false);
    if (!editor.ok) {
      expect(editor.response.status).toBe(403);
    }

    const purged = evaluateSetupServicePageGate({
      handle: "toko-hilang",
      tenantStatus: "purged",
      role: "owner",
    });
    expect(purged.allowed).toBe(false);
    if (!purged.allowed) {
      expect(purged.response.status).toBe(404);
    }

    const hold = evaluateSetupServicePageGate({
      handle: "toko-hold",
      tenantStatus: "active",
      role: "owner",
      operatorHold: true,
    });
    expect(hold.allowed).toBe(false);
    if (!hold.allowed) {
      expect(hold.response.status).toBe(302);
    }

    expect(prepareSpy).not.toHaveBeenCalled();
  });
});

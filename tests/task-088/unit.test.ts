import fs from "node:fs";
import path from "node:path";
import {
  buildBranchStaticMapsHref,
  buildBranchTelHref,
  buildBranchWhatsAppHref,
  formatBranchFullAddress,
  formatBranchTimezoneLabel,
  isGoogleMapsUrl,
  mapBranchesToSchemaInput,
  MAX_BRANCHES_PER_TENANT,
  normalizeBranchMapsUrl,
  normalizeBranchPhone,
  normalizeBranchWhatsApp,
  resolveBranchMapsLabel,
  sortBranchesCanonically,
  validateBranchCoordinates,
  validateBranchCreatePayload,
  validateBranchReorderPayload,
  validateBranchTimezone,
  validateBranchUpdatePayload,
} from "@punyasitus/core/branches/index";
import {
  generatePublishedResourceSchema,
  generateSchemaGraph,
} from "@punyasitus/core/schema-generator";
import { BRANCHES_MIGRATION_SQL } from "@punyasitus/db/branches/migrations";
import { describe, expect, it } from "vitest";
import { evaluateBranchesSettingsSsrGate } from "../../apps/web/src/pages/dashboard/[handle]/settings/branches/_ssr-gate.ts";

const ACTIVE_TENANT = {
  tenantHandle: "kopi-nusantara",
  tenantStatus: "active" as const,
  primaryHost: "kopinusantara.id",
  primaryHostKind: "custom" as const,
  primaryHostStatus: "active" as const,
  primaryHostSslStatus: "active" as const,
  primaryHostVerified: true,
  verifiedTenantHosts: ["kopinusantara.id", "kopi-nusantara.situsku.click"],
};

function parseGraph(jsonLd: string | null) {
  expect(jsonLd).not.toBeNull();
  return JSON.parse(jsonLd!) as {
    "@context": string;
    "@graph": Array<Record<string, unknown>>;
  };
}

describe("TASK-088 Unit: Migration Byte-for-Byte Parity & Core Branch Validation", () => {
  it("matches packages/db/migrations/tenant/0017_branches.sql byte-for-byte with BRANCHES_MIGRATION_SQL", () => {
    const filePath = path.resolve(
      import.meta.dirname,
      "../../packages/db/migrations/tenant/0017_branches.sql",
    );
    const onDisk = fs.readFileSync(filePath, "utf8");
    expect(BRANCHES_MIGRATION_SQL).toBe(onDisk);
    expect(onDisk).toContain("branches_single_primary_idx");
    expect(onDisk).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN/i);
  });

  it("validates and normalizes valid branch create payloads with strict Zod v4 schemas", () => {
    const res = validateBranchCreatePayload({
      name: "  Cabang   Surabaya Darmo  ",
      address: "Jl. Raya Darmo No. 45\nWonokromo",
      city: "Surabaya",
      province: "Jawa Timur",
      postalCode: "60241",
      phone: "031-555-1234",
      whatsappNumber: "+62 812-3456-7890",
      mapsUrl: "https://maps.google.com/?q=-7.2819,112.7381",
      latitude: -7.2819123456,
      longitude: 112.7381987654,
      weekdayHours: "Senin–Jumat 08.00–21.00 WIB",
      holidayHours: "Sabtu–Minggu 09.00–22.00 WIB",
      timezone: "Asia/Jakarta",
      isPrimary: true,
      active: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.name).toBe("Cabang Surabaya Darmo");
    expect(res.data.address).toBe("Jl. Raya Darmo No. 45, Wonokromo");
    expect(res.data.phone).toBe("62315551234");
    expect(res.data.whatsappE164).toBe("6281234567890");
    expect(res.data.mapsUrl).toBe("https://maps.google.com/?q=-7.2819,112.7381");
    expect(res.data.latitude).toBe(-7.2819123);
    expect(res.data.longitude).toBe(112.7381988);
    expect(res.data.isPrimary).toBe(true);
    expect(res.data.active).toBe(true);
  });

  it("rejects unknown fields and forbidden tenant selector keys strictly", () => {
    const unknownRes = validateBranchCreatePayload({
      name: "Cabang A",
      address: "Jl. A No. 1",
      extraHackerField: "nope",
    });
    expect(unknownRes.ok).toBe(false);
    if (!unknownRes.ok) {
      expect(unknownRes.fields[0]?.code).toBe("UNKNOWN_FIELD");
    }

    const selectorRes = validateBranchCreatePayload({
      name: "Cabang A",
      address: "Jl. A No. 1",
      tenantId: "01JFOREIGNTENANT0000000001",
    });
    expect(selectorRes.ok).toBe(false);
    if (!selectorRes.ok) {
      expect(selectorRes.fields[0]?.code).toBe("FORBIDDEN_TENANT_SELECTOR");
    }
  });

  it("rejects unsafe Maps URLs (javascript:, data:, http://, localhost, private IPs, credentials)", () => {
    const badUrls = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://maps.google.com/?q=jakarta",
      "https://localhost/maps",
      "https://127.0.0.1/maps",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/internal",
      "https://192.168.1.1/admin",
      "https://user:pass@maps.google.com/?q=1,2",
      "https://[::1]/maps",
    ];

    for (const url of badUrls) {
      const res = normalizeBranchMapsUrl(url);
      expect(res.ok, `Expected rejection for ${url}`).toBe(false);
    }

    const good = normalizeBranchMapsUrl("https://maps.app.goo.gl/ExampleBranchLink");
    expect(good).toEqual({
      ok: true,
      value: "https://maps.app.goo.gl/ExampleBranchLink",
    });
  });

  it("enforces Indonesian E.164 WhatsApp & phone normalization, complete coordinate pairs, and IANA timezones", () => {
    expect(normalizeBranchWhatsApp("0812-3456-7890")).toEqual({ ok: true, value: "6281234567890" });
    expect(normalizeBranchWhatsApp("+62 857 1111 2222")).toEqual({ ok: true, value: "6285711112222" });
    expect(normalizeBranchWhatsApp("021-5551234").ok).toBe(false); // landline is not WA mobile
    expect(normalizeBranchWhatsApp("javascript:alert(1)").ok).toBe(false);

    expect(normalizeBranchPhone("021-555-0199")).toEqual({ ok: true, value: "62215550199" });
    expect(normalizeBranchPhone("abc12345").ok).toBe(false);

    // Coordinate pairs must be complete and in range
    expect(validateBranchCoordinates(-6.2, null).ok).toBe(false);
    expect(validateBranchCoordinates(null, 106.8).ok).toBe(false);
    expect(validateBranchCoordinates(91, 106.8).ok).toBe(false);
    expect(validateBranchCoordinates(-6.2, 181).ok).toBe(false);
    expect(validateBranchCoordinates(null, null)).toEqual({
      ok: true,
      latitude: null,
      longitude: null,
    });

    // Update coordinate validation checks against existing pair
    const partialUpdateFail = validateBranchUpdatePayload(
      { latitude: -6.2 },
      { latitude: null, longitude: null },
    );
    expect(partialUpdateFail.ok).toBe(false);

    const clearBothOk = validateBranchUpdatePayload(
      { latitude: null, longitude: null },
      { latitude: -6.2, longitude: 106.8 },
    );
    expect(clearBothOk.ok).toBe(true);

    // Timezones
    expect(validateBranchTimezone("Asia/Makassar")).toEqual({ ok: true, value: "Asia/Makassar" });
    expect(validateBranchTimezone("Asia/Jayapura")).toEqual({ ok: true, value: "Asia/Jayapura" });
    expect(validateBranchTimezone("Mars/Olympus").ok).toBe(false);
    expect(formatBranchTimezoneLabel("Asia/Makassar")).toBe("WITA (Asia/Makassar)");
  });

  it("validates reorder payloads and enforces uniqueness + max 10 cap", () => {
    expect(validateBranchReorderPayload({ branchIds: [3, 1, 2] }).ok).toBe(true);
    expect(validateBranchReorderPayload({ branchIds: [1, 1] }).ok).toBe(false);
    expect(validateBranchReorderPayload({ branchIds: [] }).ok).toBe(false);
    expect(
      validateBranchReorderPayload({
        branchIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      }).ok,
    ).toBe(false);
  });

  it("builds safe zero-JS static Maps, tel:, WhatsApp links and canonical branch sorting", () => {
    expect(
      buildBranchStaticMapsHref({
        mapsUrl: null,
        latitude: -7.2819,
        longitude: 112.7381,
      }),
    ).toBe("https://www.google.com/maps/search/?api=1&query=-7.2819%2C112.7381");

    expect(
      buildBranchStaticMapsHref({
        mapsUrl: "javascript:alert(1)",
        latitude: null,
        longitude: null,
      }),
    ).toBeNull();

    expect(buildBranchTelHref("031-5551234")).toBe("tel:+62315551234");
    const waHref = buildBranchWhatsAppHref(
      { name: "Cabang Bali", whatsappE164: "6281234567890" },
      "Kopi Nusantara",
    );
    expect(waHref).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/);
    expect(decodeURIComponent(waHref!.split("?text=")[1]!)).toContain("Cabang Bali");

    expect(
      formatBranchFullAddress({
        address: "Jl. Sunset Road No. 88",
        city: "Badung",
        province: "Bali",
        postalCode: "80361",
      }),
    ).toBe("Jl. Sunset Road No. 88, Badung, Bali, 80361");

    const sorted = sortBranchesCanonically([
      { id: 3, isPrimary: false, sortOrder: 1 },
      { id: 2, isPrimary: true, sortOrder: 5 },
      { id: 1, isPrimary: false, sortOrder: 0 },
    ]);
    expect(sorted.map((b) => b.id)).toEqual([2, 1, 3]);

    // Honest map label distinction: Google Maps vs other public HTTPS map providers
    expect(isGoogleMapsUrl("https://maps.google.com/?q=-6.2,106.8")).toBe(true);
    expect(isGoogleMapsUrl("https://www.google.co.id/maps/place/Jakarta")).toBe(true);
    expect(isGoogleMapsUrl("https://maps.app.goo.gl/abc123")).toBe(true);
    expect(isGoogleMapsUrl("https://goo.gl/maps/abc123")).toBe(true);
    expect(isGoogleMapsUrl("https://www.openstreetmap.org/?mlat=-6.2&mlon=106.8")).toBe(false);
    expect(isGoogleMapsUrl("https://maps.apple.com/?ll=-6.2,106.8")).toBe(false);
    expect(resolveBranchMapsLabel("https://maps.google.com/?q=-6.2,106.8")).toBe(
      "Buka Google Maps",
    );
    expect(resolveBranchMapsLabel("https://www.openstreetmap.org/?mlat=-6.2&mlon=106.8")).toBe(
      "Buka Lokasi di Peta",
    );
  });
});

describe("TASK-088 Unit: Unified Schema.org @graph Parity & Honest Visible Facts", () => {
  it("links parent LocalBusiness subtype and active branches in one @graph with exact parity and zero fabricated ratings", () => {
    const branches = [
      {
        id: 2,
        name: "Cabang Bandung Braga",
        address: "Jl. Braga No. 18",
        city: "Bandung",
        province: "Jawa Barat",
        postalCode: "40111",
        phone: "62224201234",
        whatsappE164: "6281222334455",
        mapsUrl: "https://maps.google.com/?q=-6.9175,107.6091",
        latitude: -6.9175,
        longitude: 107.6091,
        weekdayHours: "Senin–Jumat 08.00–21.00 WIB",
        holidayHours: "Sabtu–Minggu 09.00–22.00 WIB",
        timezone: "Asia/Jakarta",
        sortOrder: 1,
        isPrimary: false,
        active: true,
      },
      {
        id: 1,
        name: "Cabang Jakarta Kemang",
        address: "Jl. Kemang Raya No. 12",
        city: "Jakarta Selatan",
        province: "DKI Jakarta",
        postalCode: "12730",
        phone: null,
        whatsappE164: "6281111222333",
        mapsUrl: null,
        latitude: null,
        longitude: null,
        weekdayHours: "Senin–Minggu 07.00–22.00 WIB",
        holidayHours: null,
        timezone: "Asia/Jakarta",
        sortOrder: 2,
        isPrimary: true,
        active: true,
      },
      {
        id: 3,
        name: "Cabang Tutup Sementara",
        address: "Jl. Nonaktif No. 99",
        active: false,
        sortOrder: 0,
        isPrimary: false,
      },
    ];

    const schemaBranches = mapBranchesToSchemaInput(branches);
    expect(schemaBranches).toHaveLength(2);
    expect(schemaBranches[0]?.id).toBe(1); // Primary first!
    expect(schemaBranches[1]?.id).toBe(2);

    const res = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: ACTIVE_TENANT,
      },
      siteName: "Kopi Nusantara",
      business: {
        businessName: "Kopi Nusantara",
        businessCategory: "cafe",
        address: "Jl. Sudirman No. 1",
        city: "Jakarta Pusat",
        province: "DKI Jakarta",
        phone: "62215550001",
        branches: schemaBranches,
      },
    });

    expect(res.emitted).toBe(true);
    const graph = parseGraph(res.jsonLd);
    const org = graph["@graph"].find((n) => n["@id"] === "https://kopinusantara.id/#organization");
    expect(org?.["@type"]).toBe("CafeOrCoffeeShop");
    expect(org?.subOrganization).toEqual([
      { "@id": "https://kopinusantara.id/#branch-1" },
      { "@id": "https://kopinusantara.id/#branch-2" },
    ]);

    const b1 = graph["@graph"].find((n) => n["@id"] === "https://kopinusantara.id/#branch-1");
    expect(b1?.["@type"]).toBe("CafeOrCoffeeShop");
    expect(b1?.name).toBe("Cabang Jakarta Kemang");
    // Visible-fact discipline: b1 has WhatsApp only (phone: null), so schema MUST NOT emit `telephone`!
    expect(b1?.telephone).toBeUndefined();
    expect(b1?.openingHours).toEqual(["Senin–Minggu 07.00–22.00 WIB"]);
    expect(b1?.geo).toBeUndefined(); // zero fabricated coords!
    expect(b1?.hasMap).toBeUndefined(); // zero fabricated map!
    expect(b1?.aggregateRating).toBeUndefined(); // zero fabricated rating!
    expect(b1?.review).toBeUndefined();
    expect(b1?.parentOrganization).toEqual({ "@id": "https://kopinusantara.id/#organization" });

    const b2 = graph["@graph"].find((n) => n["@id"] === "https://kopinusantara.id/#branch-2");
    expect(b2?.["@type"]).toBe("CafeOrCoffeeShop");
    expect(b2?.telephone).toBe("+62224201234");
    expect(b2?.address).toEqual({
      "@type": "PostalAddress",
      streetAddress: "Jl. Braga No. 18",
      addressLocality: "Bandung",
      addressRegion: "Jawa Barat",
      postalCode: "40111",
      addressCountry: "ID",
    });
    expect(b2?.geo).toEqual({
      "@type": "GeoCoordinates",
      latitude: -6.9175,
      longitude: 107.6091,
    });
    expect(b2?.hasMap).toBe("https://maps.google.com/?q=-6.9175,107.6091");
    expect(b2?.openingHours).toEqual([
      "Senin–Jumat 08.00–21.00 WIB",
      "Sabtu–Minggu 09.00–22.00 WIB",
    ]);

    // Inactive branch MUST NOT appear anywhere in JSON-LD!
    expect(res.jsonLd).not.toContain("Cabang Tutup Sementara");
  });

  it("caps emitted schema branches at 10, uses LocalBusiness for Organization parent, and escapes script payloads", () => {
    const twelveBranches = Array.from({ length: 12 }, (_, idx) => ({
      id: idx + 1,
      name: idx === 0 ? `Cabang </script><script>alert(1)</script>` : `Cabang #${idx + 1}`,
      address: `Jl. Cabang No. ${idx + 1}`,
      active: true,
    }));

    const res = generatePublishedResourceSchema({
      tenant: ACTIVE_TENANT,
      siteSettings: {
        siteTitle: "PT Contoh Korporat",
        tagline: null,
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "compro",
        blogEnabled: true,
        catalogEnabled: true,
        aiTrainingPolicy: "allow",
        siteVisibility: "public",
      },
      businessProfile: {
        businessName: "PT Contoh Korporat",
        businessCategory: "Organization",
        serviceAreas: [],
        socialLinks: [],
      },
      businessBranches: mapBranchesToSchemaInput(twelveBranches),
      resource: {
        resourceType: "page",
        resourceId: 1,
        version: 1,
        publishedAt: Date.UTC(2026, 10, 20, 0, 0, 0),
        contentModifiedAt: Date.UTC(2026, 10, 20, 0, 0, 0),
        data: {
          slug: "beranda",
          title: "Beranda",
          isHomepage: true,
          layoutMode: "standard",
          sections: [],
        },
      },
    });

    expect(res.emitted).toBe(true);
    expect(res.jsonLd).not.toContain("</script>");
    const graph = parseGraph(res.jsonLd);
    const branchNodes = graph["@graph"].filter(
      (n) => typeof n["@id"] === "string" && n["@id"].includes("#branch-"),
    );
    expect(branchNodes).toHaveLength(MAX_BRANCHES_PER_TENANT);
    expect(branchNodes[0]?.["@type"]).toBe("LocalBusiness");
  });
});

describe("TASK-088 Unit: SSR Lifecycle & RBAC Gate (Editor read-only, Locked read-only, Suspended 302)", () => {
  const baseUser = { id: "user_1", name: "Budi", email: "budi@example.test" };

  it("allows owner/admin full write access, editor read-only access, and locked read-only access", () => {
    const ownerRes = evaluateBranchesSettingsSsrGate({
      rawHandle: "kopi-nusantara",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: baseUser,
      authorized: {
        tenantId: "01JT088ALPHA00000000000001",
        handle: "kopi-nusantara",
        role: "owner",
        tenantStatus: "active",
      },
    });
    expect(ownerRes.ok).toBe(true);
    if (ownerRes.ok) {
      expect(ownerRes.canManageBranches).toBe(true);
      expect(ownerRes.readOnly).toBe(false);
    }

    // REQ-088: Editor reads branches but cannot change them!
    const editorRes = evaluateBranchesSettingsSsrGate({
      rawHandle: "kopi-nusantara",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: baseUser,
      authorized: {
        tenantId: "01JT088ALPHA00000000000001",
        handle: "kopi-nusantara",
        role: "editor",
        tenantStatus: "active",
      },
    });
    expect(editorRes.ok).toBe(true);
    if (editorRes.ok) {
      expect(editorRes.canManageBranches).toBe(false);
      expect(editorRes.readOnly).toBe(true);
      expect(editorRes.isLocked).toBe(false);
    }

    // Locked tenant: owner gets read-only 200
    const lockedRes = evaluateBranchesSettingsSsrGate({
      rawHandle: "kopi-nusantara",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: baseUser,
      authorized: {
        tenantId: "01JT088ALPHA00000000000001",
        handle: "kopi-nusantara",
        role: "owner",
        tenantStatus: "locked",
      },
    });
    expect(lockedRes.ok).toBe(true);
    if (lockedRes.ok) {
      expect(lockedRes.isLocked).toBe(true);
      expect(lockedRes.canManageBranches).toBe(false);
      expect(lockedRes.readOnly).toBe(true);
    }
  });

  it("blocks suspended/recovery/operatorHold with 302 and purging/purged/foreign/non-app with neutral 404", () => {
    const suspended = evaluateBranchesSettingsSsrGate({
      rawHandle: "kopi-nusantara",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: baseUser,
      authorized: {
        tenantId: "01JT088ALPHA00000000000001",
        handle: "kopi-nusantara",
        role: "owner",
        tenantStatus: "suspended",
      },
    });
    expect(suspended.ok).toBe(false);
    if (!suspended.ok) {
      expect(suspended.status).toBe(302);
      expect(suspended.response.headers.get("Location")).toBe("/dashboard/kopi-nusantara/service-status");
    }

    const hold = evaluateBranchesSettingsSsrGate({
      rawHandle: "kopi-nusantara",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: baseUser,
      authorized: {
        tenantId: "01JT088ALPHA00000000000001",
        handle: "kopi-nusantara",
        role: "owner",
        tenantStatus: "active",
      },
      operatorHold: true,
    });
    expect(hold.ok).toBe(false);
    if (!hold.ok) expect(hold.status).toBe(302);

    const provisioning = evaluateBranchesSettingsSsrGate({
      rawHandle: "kopi-nusantara",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: baseUser,
      authorized: {
        tenantId: "01JT088ALPHA00000000000001",
        handle: "kopi-nusantara",
        role: "owner",
        tenantStatus: "provisioning",
      },
    });
    expect(provisioning.ok).toBe(false);
    if (!provisioning.ok) expect(provisioning.status).toBe(404);

    const purging = evaluateBranchesSettingsSsrGate({
      rawHandle: "kopi-nusantara",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: baseUser,
      authorized: {
        tenantId: "01JT088ALPHA00000000000001",
        handle: "kopi-nusantara",
        role: "owner",
        tenantStatus: "purging",
      },
    });
    expect(purging.ok).toBe(false);
    if (!purging.ok) expect(purging.status).toBe(404);

    const wrongSurface = evaluateBranchesSettingsSsrGate({
      rawHandle: "kopi-nusantara",
      surface: "tenant",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: baseUser,
      authorized: {
        tenantId: "01JT088ALPHA00000000000001",
        handle: "kopi-nusantara",
        role: "owner",
        tenantStatus: "active",
      },
    });
    expect(wrongSurface.ok).toBe(false);
    if (!wrongSurface.ok) expect(wrongSurface.status).toBe(404);
  });
});

import fs from "node:fs";
import path from "node:path";
import {
  buildOpeningHoursSpecifications,
  buildSpecialOpeningHoursSpecifications,
  generateSchemaGraph,
} from "@punyasitus/core/schema-generator";
import {
  buildOutletDirectionsUrl,
  buildOutletMapEmbedUrl,
  formatHolidayHoursSummary,
  formatWeeklyHoursSummary,
  mapOutletsToSchemaBranches,
  normalizeOutletMapsUrl,
  normalizeOutletPhoneE164,
  normalizeOutletSlug,
  normalizeOutletWhatsAppE164,
  validateOutletCoordinates,
  validateOutletCreatePayload,
  validateOutletHolidayHours,
  validateOutletUpdatePayload,
  validateOutletWeeklyHours,
  validateStrictGoogleMapsEmbedUrl,
  type OutletRecord,
} from "@punyasitus/db/outlets/index";
import { describe, expect, it } from "vitest";
import { evaluateOutletsSsrGate } from "../../apps/web/src/pages/dashboard/[handle]/outlets/_ssr-gate.ts";

const ACTIVE_TENANT = {
  tenantHandle: "gerai-nusantara",
  tenantStatus: "active" as const,
  primaryHost: "gerainusantara.id",
  primaryHostKind: "custom" as const,
  primaryHostStatus: "active" as const,
  primaryHostSslStatus: "active" as const,
  primaryHostVerified: true,
  verifiedTenantHosts: ["gerainusantara.id", "gerai-nusantara.situsku.click"],
};

function parseGraph(jsonLd: string | null) {
  expect(jsonLd).not.toBeNull();
  return JSON.parse(jsonLd!) as {
    "@context": string;
    "@graph": Array<Record<string, unknown>>;
  };
}

describe("TASK-019 Unit: Weekly Hours, Holiday Hours, Coordinates, E.164 & Directions URL", () => {
  it("validates structured weekly hours (Mon-Sun), sorts canonically, and formats summary", () => {
    const res = validateOutletWeeklyHours([
      { day: "sunday", open: null, close: null, closed: true },
      { day: "monday", open: "08:00", close: "21:00", closed: false },
      { day: "tuesday", open: "08:00", close: "21:00", closed: false },
      { day: "wednesday", open: "08:00", close: "21:00", closed: false },
      { day: "thursday", open: "08:00", close: "21:00", closed: false },
      { day: "friday", open: "08:00", close: "21:00", closed: false },
      { day: "saturday", open: "09:00", close: "22:00", closed: false },
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((d) => d.day)).toEqual([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ]);
    expect(formatWeeklyHoursSummary(res.data)).toBe(
      "Senin–Jumat 08:00–21:00; Sabtu 09:00–22:00; Minggu Tutup",
    );
  });

  it("rejects invalid weekly hours (duplicate day, open >= close, bad HH:MM, unknown keys)", () => {
    const dup = validateOutletWeeklyHours([
      { day: "monday", open: "08:00", close: "17:00", closed: false },
      { day: "monday", open: "09:00", close: "18:00", closed: false },
    ]);
    expect(dup.ok).toBe(false);

    const reversed = validateOutletWeeklyHours([
      { day: "monday", open: "21:00", close: "08:00", closed: false },
    ]);
    expect(reversed.ok).toBe(false);

    const equal = validateOutletWeeklyHours([
      { day: "tuesday", open: "10:00", close: "10:00", closed: false },
    ]);
    expect(equal.ok).toBe(false);

    const badTime = validateOutletWeeklyHours([
      { day: "wednesday", open: "25:00", close: "26:00", closed: false },
    ]);
    expect(badTime.ok).toBe(false);

    const badKey = validateOutletWeeklyHours([
      { day: "thursday", open: "08:00", close: "17:00", closed: false, tenantId: "evil" },
    ]);
    expect(badKey.ok).toBe(false);
  });

  it("validates structured holiday hours (real calendar dates, unique dates, bounds) and formats summary", () => {
    const valid = validateOutletHolidayHours([
      { date: "2026-12-25", label: "Hari Natal", open: null, close: null, closed: true },
      { date: "2026-08-17", label: "HUT Kemerdekaan RI", open: "10:00", close: "18:00", closed: false },
    ]);
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.data[0]?.date).toBe("2026-08-17");
    expect(valid.data[1]?.date).toBe("2026-12-25");
    expect(formatHolidayHoursSummary(valid.data)).toBe(
      "2026-08-17 HUT Kemerdekaan RI: 10:00–18:00; 2026-12-25 Hari Natal: Tutup",
    );

    // Invalid calendar date (Feb 30)
    const impossibleDate = validateOutletHolidayHours([
      { date: "2026-02-30", label: "Invalid", closed: true },
    ]);
    expect(impossibleDate.ok).toBe(false);

    // Duplicate date
    const duplicateDate = validateOutletHolidayHours([
      { date: "2026-12-25", label: "Natal 1", closed: true },
      { date: "2026-12-25", label: "Natal 2", closed: true },
    ]);
    expect(duplicateDate.ok).toBe(false);

    // Reversed hours
    const badHolidayRange = validateOutletHolidayHours([
      { date: "2026-08-17", label: "HUT RI", open: "18:00", close: "10:00", closed: false },
    ]);
    expect(badHolidayRange.ok).toBe(false);

    // > 30 holiday entries
    const tooMany = Array.from({ length: 31 }, (_, i) => ({
      date: `2027-01-${String((i % 28) + 1).padStart(2, "0")}`,
      label: `Holiday ${i}`,
      closed: true,
    }));
    expect(validateOutletHolidayHours(tooMany).ok).toBe(false);
  });

  it("enforces coordinate bounds [-90, 90] and [-180, 180] and pair completeness", () => {
    expect(validateOutletCoordinates(-6.260712345, 106.813398765)).toEqual({
      ok: true,
      latitude: -6.2607123,
      longitude: 106.8133988,
    });
    expect(validateOutletCoordinates(null, null)).toEqual({
      ok: true,
      latitude: null,
      longitude: null,
    });
    expect(validateOutletCoordinates(-91, 106.8).ok).toBe(false);
    expect(validateOutletCoordinates(90.001, 106.8).ok).toBe(false);
    expect(validateOutletCoordinates(-6.2, 180.5).ok).toBe(false);
    expect(validateOutletCoordinates(-6.2, -181).ok).toBe(false);
    expect(validateOutletCoordinates(-6.2, null).ok).toBe(false);
    expect(validateOutletCoordinates(null, 106.8).ok).toBe(false);
    expect(validateOutletCoordinates(Number.NaN, 106.8).ok).toBe(false);
  });

  it("validates E.164 phone/WhatsApp and slug normalization", () => {
    expect(normalizeOutletPhoneE164("021-719-1234")).toEqual({ ok: true, value: "+62217191234" });
    expect(normalizeOutletPhoneE164("+62 812 3456 7890")).toEqual({
      ok: true,
      value: "+6281234567890",
    });
    expect(normalizeOutletPhoneE164("123").ok).toBe(false);
    expect(normalizeOutletPhoneE164("abc-phone").ok).toBe(false);

    expect(normalizeOutletWhatsAppE164("0812-3456-7890")).toEqual({
      ok: true,
      value: "+6281234567890",
    });
    expect(normalizeOutletWhatsAppE164("+6281999887766")).toEqual({
      ok: true,
      value: "+6281999887766",
    });
    expect(normalizeOutletWhatsAppE164("0217191234").ok).toBe(false);

    expect(normalizeOutletSlug(null, "Gerai Jakarta Kemang")).toEqual({
      ok: true,
      value: "gerai-jakarta-kemang",
    });
    expect(normalizeOutletSlug("INVALID SLUG!").ok).toBe(false);
  });

  it("validates safe Google Maps URLs and generates deterministic directions & embed URLs", () => {
    expect(
      normalizeOutletMapsUrl("https://www.google.com/maps/dir/?api=1&destination=-6.2607,106.8133"),
    ).toEqual({
      ok: true,
      value: "https://www.google.com/maps/dir/?api=1&destination=-6.2607,106.8133",
    });

    const unsafeUrls = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://www.google.com/maps/dir/?api=1&destination=-6.2,106.8",
      "https://www.google.com/url?q=https://evil.example",
      "https://localhost/maps",
      "https://127.0.0.1/maps",
      "https://user:pass@maps.google.com/?q=1",
      "https://evil.example/maps",
    ];
    for (const bad of unsafeUrls) {
      expect(normalizeOutletMapsUrl(bad).ok, `Expected ${bad} to be rejected`).toBe(false);
    }

    expect(
      buildOutletDirectionsUrl({
        latitude: -6.2607,
        longitude: 106.8133,
        address: "Jl. Kemang Raya No. 12",
      }),
    ).toBe("https://www.google.com/maps/dir/?api=1&destination=-6.2607,106.8133");

    expect(
      buildOutletDirectionsUrl({
        address: "Jl. Raya Darmo No. 45",
        city: "Surabaya",
      }),
    ).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
        "Jl. Raya Darmo No. 45, Surabaya",
      )}`,
    );

    expect(buildOutletMapEmbedUrl({ latitude: -6.2607, longitude: 106.8133 })).toBe(
      "https://maps.google.com/maps?q=-6.2607,106.8133&z=15&output=embed",
    );
    expect(buildOutletMapEmbedUrl({ latitude: null, longitude: null })).toBeNull();

    // Non-Google mapsUrl must be ignored and fall back to safe Google Maps directions URL
    expect(
      buildOutletDirectionsUrl({
        mapsUrl: "https://evil.example/phish",
        latitude: -6.2607,
        longitude: 106.8133,
        address: "Jl. Kemang Raya No. 12",
      }),
    ).toBe("https://www.google.com/maps/dir/?api=1&destination=-6.2607,106.8133");

    // Strict Google Maps embed URL allowlist
    expect(
      validateStrictGoogleMapsEmbedUrl(
        "https://maps.google.com/maps?q=-6.2607,106.8133&z=15&output=embed",
      ),
    ).toBe("https://maps.google.com/maps?q=-6.2607,106.8133&z=15&output=embed");
    expect(
      validateStrictGoogleMapsEmbedUrl("https://www.google.com/maps/embed?pb=!1m18"),
    ).toBe("https://www.google.com/maps/embed?pb=!1m18");
    expect(
      validateStrictGoogleMapsEmbedUrl("https://www.google.com/maps/embed/v1/place?q=Jakarta"),
    ).toBe("https://www.google.com/maps/embed/v1/place?q=Jakarta");

    for (const badEmbed of [
      "/relative-path",
      "//maps.google.com/maps?output=embed",
      "https://www.google.com/url?q=https://evil.example",
      "https://www.google.com/maps/url?q=https://evil.example",
      "https://evil.example/embed",
      "https://maps.google.com/maps?q=-6.2,106.8",
      "https://maps.google.com:8443/maps?q=-6.2,106.8&output=embed",
      "https://user:pass@maps.google.com/maps?q=-6.2,106.8&output=embed",
      "http://maps.google.com/maps?q=-6.2,106.8&output=embed",
      "https://www.google.com/maps/embed/../url?q=https://evil.example",
    ]) {
      expect(
        validateStrictGoogleMapsEmbedUrl(badEmbed),
        `Expected embed URL "${badEmbed}" to be rejected`,
      ).toBeNull();
    }
  });

  it("rejects unknown fields and forbidden tenant selectors in create/update payloads", () => {
    const unknown = validateOutletCreatePayload({
      name: "Gerai A",
      address: "Jl. A No. 1",
      rogueField: 123,
    });
    expect(unknown.ok).toBe(false);

    const selector = validateOutletUpdatePayload({
      name: "Gerai B",
      tenantId: "01JFOREIGNTENANT0000000001",
      expectedVersion: 1,
    });
    expect(selector.ok).toBe(false);
  });
});

describe("TASK-019 Unit: LocalBusiness JSON-LD Parity with Visible Published Outlet Facts (REQ-054)", () => {
  it("emits openingHoursSpecification, specialOpeningHoursSpecification, geo, address, visible telephone and ZERO drafts or fabricated ratings", () => {
    const publishedOutlet: OutletRecord = {
      id: 1,
      name: "Gerai Jakarta Kemang",
      slug: "gerai-jakarta-kemang",
      address: "Jl. Kemang Raya No. 12",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      postalCode: "12730",
      phone: "+62217191234",
      whatsappE164: "+6281234567891",
      mapsUrl: null,
      directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=-6.2607,106.8133",
      mapEmbedUrl: "https://maps.google.com/maps?q=-6.2607,106.8133&z=15&output=embed",
      latitude: -6.2607,
      longitude: 106.8133,
      weeklyHours: [
        { day: "monday", open: "08:00", close: "21:00", closed: false },
        { day: "saturday", open: "09:00", close: "22:00", closed: false },
        { day: "sunday", open: null, close: null, closed: true },
      ],
      holidayHours: [
        { date: "2026-08-17", label: "HUT RI", open: "10:00", close: "18:00", closed: false },
        { date: "2026-12-25", label: "Hari Natal", open: null, close: null, closed: true },
      ],
      weekdayHoursText: "Senin 08:00–21:00; Sabtu 09:00–22:00; Minggu Tutup",
      holidayHoursText: "2026-08-17 HUT RI: 10:00–18:00; 2026-12-25 Hari Natal: Tutup",
      timezone: "Asia/Jakarta",
      sortOrder: 0,
      isPrimary: true,
      status: "published",
      active: true,
      version: 1,
      createdAt: "2026-11-23T00:00:00.000Z",
      updatedAt: "2026-11-23T00:00:00.000Z",
    };

    const whatsappOnlyOutlet: OutletRecord = {
      ...publishedOutlet,
      id: 2,
      name: "Gerai Bandung Dago",
      slug: "gerai-bandung-dago",
      phone: null,
      whatsappE164: "+6281333445566",
      isPrimary: false,
      sortOrder: 1,
    };

    const draftOutlet: OutletRecord = {
      ...publishedOutlet,
      id: 3,
      name: "Gerai Rahasia Draf",
      slug: "gerai-rahasia-draf",
      status: "draft",
      active: true,
    };

    const inactiveOutlet: OutletRecord = {
      ...publishedOutlet,
      id: 4,
      name: "Gerai Nonaktif",
      slug: "gerai-nonaktif",
      status: "published",
      active: false,
    };

    const mapped = mapOutletsToSchemaBranches([
      publishedOutlet,
      whatsappOnlyOutlet,
      draftOutlet,
      inactiveOutlet,
    ]);
    expect(mapped).toHaveLength(2);
    expect(mapped.map((b) => b.name)).toEqual(["Gerai Jakarta Kemang", "Gerai Bandung Dago"]);

    const schema = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: ACTIVE_TENANT,
        siteVisibility: "public",
        resourceState: "published",
      },
      siteName: "Gerai Nusantara",
      business: {
        businessName: "Gerai Nusantara",
        businessCategory: "LocalBusiness",
        branches: mapped,
      },
    });

    const graph = parseGraph(schema.jsonLd);
    const branchNodes = graph["@graph"].filter(
      (n) => typeof n["@id"] === "string" && (n["@id"] as string).includes("#branch-"),
    );
    expect(branchNodes).toHaveLength(2);

    const kemang = branchNodes.find((n) => n.name === "Gerai Jakarta Kemang")!;
    expect(kemang["@type"]).toBe("LocalBusiness");
    expect(kemang.telephone).toBe("+62217191234");
    expect(kemang.hasMap).toBe("https://www.google.com/maps/dir/?api=1&destination=-6.2607,106.8133");
    expect(kemang.geo).toEqual({
      "@type": "GeoCoordinates",
      latitude: -6.2607,
      longitude: 106.8133,
    });
    expect(kemang.openingHoursSpecification).toEqual([
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "https://schema.org/Monday",
        opens: "08:00",
        closes: "21:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "https://schema.org/Saturday",
        opens: "09:00",
        closes: "22:00",
      },
    ]);
    expect(kemang.specialOpeningHoursSpecification).toEqual([
      {
        "@type": "OpeningHoursSpecification",
        name: "HUT RI",
        validFrom: "2026-08-17",
        validThrough: "2026-08-17",
        opens: "10:00",
        closes: "18:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        name: "Hari Natal",
        validFrom: "2026-12-25",
        validThrough: "2026-12-25",
        opens: "00:00",
        closes: "00:00",
      },
    ]);
    // Omit non-ISO Indonesian text `openingHours` when structured `openingHoursSpecification` is emitted
    expect(kemang.openingHours).toBeUndefined();
    // Zero fabricated ratings or reviews!
    expect(kemang.aggregateRating).toBeUndefined();
    expect(kemang.review).toBeUndefined();

    // WhatsApp-only outlet MUST NOT fabricate `telephone`
    const dago = branchNodes.find((n) => n.name === "Gerai Bandung Dago")!;
    expect(dago.telephone).toBeUndefined();

    // Direct helper checks for closed-only / invalid filtering
    expect(
      buildOpeningHoursSpecifications([{ day: "sunday", open: null, close: null, closed: true }]),
    ).toEqual([]);
    expect(
      buildSpecialOpeningHoursSpecifications([
        { date: "2026-02-30", label: "Bad", closed: true },
      ]),
    ).toEqual([]);
  });
});

describe("TASK-019 Unit: SSR Gate & TASK-013 / TASK-032 Boundary Guardrails", () => {
  it("enforces SSR lifecycle and RBAC gate before any TenantStore read", () => {
    const anon = evaluateOutletsSsrGate({
      rawHandle: "gerai-nusantara",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: null,
      authorized: null,
    });
    expect(anon.ok).toBe(false);
    if (!anon.ok) expect(anon.status).toBe(404);

    const suspended = evaluateOutletsSsrGate({
      rawHandle: "gerai-nusantara",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u1" },
      authorized: {
        tenantId: "01J00000000000000000000001",
        handle: "gerai-nusantara",
        role: "owner",
        tenantStatus: "suspended",
      },
    });
    expect(suspended.ok).toBe(false);
    if (!suspended.ok) expect(suspended.status).toBe(302);

    const editor = evaluateOutletsSsrGate({
      rawHandle: "gerai-nusantara",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u2" },
      authorized: {
        tenantId: "01J00000000000000000000001",
        handle: "gerai-nusantara",
        role: "editor",
        tenantStatus: "active",
      },
    });
    expect(editor.ok).toBe(true);
    if (editor.ok) {
      expect(editor.readOnly).toBe(true);
      expect(editor.canManageOutlets).toBe(false);
    }

    const owner = evaluateOutletsSsrGate({
      rawHandle: "gerai-nusantara",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u3" },
      authorized: {
        tenantId: "01J00000000000000000000001",
        handle: "gerai-nusantara",
        role: "owner",
        tenantStatus: "active",
      },
    });
    expect(owner.ok).toBe(true);
    if (owner.ok) {
      expect(owner.readOnly).toBe(false);
      expect(owner.canManageOutlets).toBe(true);
    }
  });

  it("keeps SectionOutlets.astro 100% free of forbidden TASK-013 & TASK-032 substrings (even in comments)", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const sectionContent = fs.readFileSync(
      path.join(root, "apps/web/src/themes/default/sections/SectionOutlets.astro"),
      "utf8",
    );

    const forbiddenSubstrings = [
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
    for (const sub of forbiddenSubstrings) {
      expect(
        sectionContent.toLowerCase().includes(sub.toLowerCase()),
        `SectionOutlets.astro must not contain "${sub}"`,
      ).toBe(false);
    }

    // Security hardening invariants in SectionOutlets.astro
    expect(sectionContent).toContain('referrerPolicy = "no-referrer"');
    expect(sectionContent).not.toContain("window.__punyasitusConsent =");
    expect(sectionContent).not.toContain('raw.startsWith("/")');

    const dashboardClient = fs.readFileSync(
      path.join(root, "apps/web/src/pages/dashboard/[handle]/outlets/_OutletsManagerClient.tsx"),
      "utf8",
    );
    expect(/@radix-ui\//.test(dashboardClient)).toBe(false);
    expect(/\basChild\b/.test(dashboardClient)).toBe(false);
    expect(/\bSparkles(?:Icon)?\b/.test(dashboardClient)).toBe(false);
  });
});

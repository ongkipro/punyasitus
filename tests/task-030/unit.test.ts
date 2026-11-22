import {
  aggregateAnalyticsDailyRows,
  createEmptyDashboardMetrics,
  formatAnalyticsDay,
  normalizeEventPath,
  recordFirstPartyEvent,
  validateFirstPartyEventPayload,
  type AnalyticsDailyRow,
} from "@punyasitus/db/analytics/index";
import { describe, expect, it } from "vitest";

describe("TASK-030 unit — Strict first-party event schema & PII rejection", () => {
  it("accepts all allowlisted event types with clean paths and optional references", () => {
    for (const eventType of [
      "wa_click",
      "external_click",
      "lead_submitted",
      "page_view",
    ] as const) {
      const res = validateFirstPartyEventPayload({
        eventType,
        path: "/layanan/konsultasi-bisnis/",
        resourceType: "offering",
        resourceId: 42,
      });
      expect(res.ok, eventType).toBe(true);
      if (res.ok) {
        expect(res.data.eventType).toBe(eventType);
        expect(res.data.path).toBe("/layanan/konsultasi-bisnis");
        expect(res.data.resourceType).toBe("offering");
        expect(res.data.resourceId).toBe(42);
      }
    }

    // Also supports canonical OpenAPI `eventName` + `eventId` + `targetKind`/`targetSlug` shape.
    const openApiShape = validateFirstPartyEventPayload({
      eventId: "11111111-1111-4111-8111-111111111111",
      eventName: "wa_click",
      path: "/",
      targetKind: "floating_wa",
      sourceCategory: "search",
      consentVersion: "v1.0",
    });
    expect(openApiShape.ok).toBe(true);
    if (openApiShape.ok) {
      expect(openApiShape.data.eventType).toBe("wa_click");
      expect(openApiShape.data.path).toBe("/");
      expect(openApiShape.data.eventId).toBe("11111111-1111-4111-8111-111111111111");
    }
  });

  it("rejects unknown or commercial-claim event types with 422", () => {
    for (const badType of [
      "purchase",
      "confirmed_sale",
      "checkout_complete",
      "add_to_cart",
      "click",
      "",
    ]) {
      const res = validateFirstPartyEventPayload({
        eventType: badType,
        path: "/produk/kursi-kayu",
      });
      expect(res.ok, `badType=${badType}`).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(422);
        expect(res.code).toBe("INVALID_EVENT_TYPE");
      }
    }

    // Conflicting eventType and eventName must also fail.
    const conflict = validateFirstPartyEventPayload({
      eventType: "wa_click",
      eventName: "external_click",
      path: "/",
    });
    expect(conflict).toMatchObject({
      ok: false,
      status: 422,
      code: "INVALID_EVENT_TYPE",
    });
  });

  it("rejects any PII fields (email, phone, name, message, address, ip, query strings) with 422", () => {
    const piiPayloads: Record<string, unknown>[] = [
      { eventType: "wa_click", path: "/", email: "budi@example.test" },
      { eventType: "wa_click", path: "/", phone: "6281234567890" },
      { eventType: "wa_click", path: "/", name: "Budi Santoso" },
      { eventType: "wa_click", path: "/", message: "Saya mau beli 2 unit" },
      { eventType: "wa_click", path: "/", address: "Jl. Sudirman No. 10" },
      { eventType: "wa_click", path: "/", ip: "203.0.113.10" },
      { eventType: "wa_click", path: "/", ipAddress: "203.0.113.10" },
      { eventType: "wa_click", path: "/", query: "utm_source=ads" },
      { eventType: "wa_click", path: "/", queryString: "?fbclid=123" },
      { eventType: "wa_click", path: "/", search: "?email=a@b.com" },
      { eventType: "wa_click", path: "/", nested: { email: "hidden@example.test" } },
    ];

    for (const payload of piiPayloads) {
      const res = validateFirstPartyEventPayload(payload);
      expect(res.ok, JSON.stringify(payload)).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(422);
        expect(res.code).toBe("PII_FIELD_FORBIDDEN");
      }
    }
  });

  it("rejects query strings, fragments, emails, phone numbers, and traversal inside path", () => {
    const badPaths = [
      "/layanan?utm_source=ig",
      "/layanan&ref=1",
      "/layanan#kontak",
      "/kontak/budi@example.com",
      "/kontak/081234567890",
      "/kontak/+6281234567890",
      "/../admin",
      "//evil.example/path",
      "layanan/tanpa-slash",
      "",
    ];

    for (const badPath of badPaths) {
      const normalized = normalizeEventPath(badPath);
      expect(normalized.ok, `path=${badPath}`).toBe(false);

      const res = validateFirstPartyEventPayload({
        eventType: "wa_click",
        path: badPath,
      });
      expect(res.ok, `payload path=${badPath}`).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(422);
      }
    }
  });

  it("rejects unknown fields and incomplete or malformed resource references", () => {
    const unknownField = validateFirstPartyEventPayload({
      eventType: "wa_click",
      path: "/",
      extraDebugFlag: true,
    });
    expect(unknownField).toMatchObject({
      ok: false,
      status: 422,
      code: "UNKNOWN_FIELD",
    });

    const badRefs: Record<string, unknown>[] = [
      { eventType: "wa_click", path: "/", resourceType: "offering" },
      { eventType: "wa_click", path: "/", resourceId: 10 },
      { eventType: "wa_click", path: "/", resourceType: "user", resourceId: 1 },
      { eventType: "wa_click", path: "/", resourceType: "page", resourceId: 0 },
      { eventType: "wa_click", path: "/", resourceType: "page", resourceId: -5 },
      { eventType: "wa_click", path: "/", resourceType: "page", resourceId: 1.5 },
      { eventType: "wa_click", path: "/", resourceType: "page", resourceId: "1" },
      { eventType: "wa_click", path: "/", targetSlug: "paket-umrah" },
    ];

    for (const payload of badRefs) {
      const res = validateFirstPartyEventPayload(payload);
      expect(res.ok, JSON.stringify(payload)).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(422);
      }
    }
  });

  it("fails closed with 503 when tenant datastore is null or unavailable", async () => {
    const nullDb = await recordFirstPartyEvent(null, {
      eventType: "wa_click",
      path: "/layanan",
    });
    expect(nullDb).toMatchObject({
      ok: false,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
    });
  });
});

describe("TASK-030 unit — Analytics day formatting & dashboard metric aggregation math", () => {
  it("formats calendar days in Asia/Jakarta (UTC+7) accurately across midnight boundary", () => {
    // 2026-11-22T17:30:00Z is 2026-11-23 00:30:00 WIB (Asia/Jakarta).
    const epochMs = Date.UTC(2026, 10, 22, 17, 30, 0);
    expect(formatAnalyticsDay(epochMs, "Asia/Jakarta")).toBe("2026-11-23");
    expect(formatAnalyticsDay(epochMs, "UTC")).toBe("2026-11-22");
  });

  it("aggregates totals, fills contiguous 7-day and 30-day series, excludes stale rows, and ranks top paths", () => {
    // End day in Asia/Jakarta: 2026-11-23 (window for 7d: 2026-11-17 .. 2026-11-23)
    const nowMs = Date.UTC(2026, 10, 23, 5, 0, 0);
    const rows: AnalyticsDailyRow[] = [
      // Outside 7d window (2026-11-10) -> excluded in 7d, included in 30d
      {
        day: "2026-11-10",
        path: "/layanan/lama",
        pageviews: 50,
        unique_visitors: 20,
        wa_clicks: 9,
        external_clicks: 4,
        lead_submits: 2,
      },
      // Inside 7d window
      {
        day: "2026-11-21",
        path: "/layanan/audit-seo",
        pageviews: 40,
        unique_visitors: 30,
        wa_clicks: 6,
        external_clicks: 2,
        lead_submits: 1,
      },
      {
        day: "2026-11-22",
        path: "/layanan/audit-seo",
        pageviews: 35,
        unique_visitors: 25,
        wa_clicks: 5,
        external_clicks: 1,
        lead_submits: 2,
      },
      {
        day: "2026-11-23",
        path: "/produk/template-web",
        pageviews: 100,
        unique_visitors: 80,
        wa_clicks: 3,
        external_clicks: 7,
        lead_submits: 0,
      },
      {
        day: "2026-11-23",
        path: "/blog/tips-umkm",
        pageviews: 120,
        unique_visitors: 90,
        wa_clicks: 1,
        external_clicks: 0,
        lead_submits: 0,
      },
    ];

    const summary7d = aggregateAnalyticsDailyRows(rows, {
      days: 7,
      nowMs,
      timeZone: "Asia/Jakarta",
    });

    expect(summary7d.days).toBe(7);
    expect(summary7d.startDay).toBe("2026-11-17");
    expect(summary7d.endDay).toBe("2026-11-23");
    expect(summary7d.daily).toHaveLength(7);
    expect(summary7d.hasAnyData).toBe(true);

    // Totals exclude 2026-11-10 row
    expect(summary7d.totals).toEqual({
      waClicks: 15,
      externalClicks: 10,
      leadSubmits: 3,
      pageviews: 295,
      uniqueVisitors: 225,
      totalInterestSignals: 28,
    });

    // Quiet days are zero-filled
    const quietDay = summary7d.daily.find((d) => d.day === "2026-11-18");
    expect(quietDay).toEqual({
      day: "2026-11-18",
      pageviews: 0,
      uniqueVisitors: 0,
      waClicks: 0,
      externalClicks: 0,
      leadSubmits: 0,
      totalInterestSignals: 0,
    });

    // Top paths ranked by totalInterestSignals DESC (/layanan/audit-seo = 17, /produk/template-web = 10, /blog/tips-umkm = 1)
    expect(summary7d.topPaths.map((p) => p.path)).toEqual([
      "/layanan/audit-seo",
      "/produk/template-web",
      "/blog/tips-umkm",
    ]);
    expect(summary7d.topPaths[0]).toEqual({
      path: "/layanan/audit-seo",
      pageviews: 75,
      waClicks: 11,
      externalClicks: 3,
      leadSubmits: 3,
      totalInterestSignals: 17,
    });

    // 30-day window includes the 2026-11-10 row
    const summary30d = aggregateAnalyticsDailyRows(rows, {
      days: 30,
      nowMs,
      timeZone: "Asia/Jakarta",
      topPathsLimit: 2,
    });
    expect(summary30d.daily).toHaveLength(30);
    expect(summary30d.totals.waClicks).toBe(24);
    expect(summary30d.totals.externalClicks).toBe(14);
    expect(summary30d.totals.leadSubmits).toBe(5);
    expect(summary30d.topPaths).toHaveLength(2);
    expect(summary30d.topPaths.map((p) => p.path)).toEqual([
      "/layanan/audit-seo",
      "/layanan/lama",
    ]);

    const empty = createEmptyDashboardMetrics({ days: 7, nowMs });
    expect(empty.hasAnyData).toBe(false);
    expect(empty.totals.totalInterestSignals).toBe(0);
    expect(empty.daily).toHaveLength(7);
    expect(empty.topPaths).toEqual([]);
  });
});

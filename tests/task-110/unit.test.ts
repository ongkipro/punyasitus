import { describe, expect, it } from "vitest";
import { renderEmailTemplate } from "@punyasitus/core/email/index";
import {
  DEFAULT_MONTHLY_REPORT_MIN_ACTIVITY_THRESHOLD,
  MonthlyReportPiiLeakError,
  assertZeroVisitorPiiInMonthlyReport,
  buildMonthlyPerformanceReportSummary,
  buildMonthlyReportCronKey,
  buildMonthlyReportMessageKey,
  computeMonthlyDelta,
  detectVisitorPiiInReportContent,
  isEligibleForMonthlyReport,
  isFirstDayOfMonth,
  parseReportMonthPeriod,
  resolvePreviousCalendarMonthPeriod,
  sanitizeReportDisplayText,
  selectConcreteMonthlyTip,
} from "@punyasitus/core/reports/index";
import { evaluateNotificationSettingsSsrGate } from "../../apps/web/src/pages/dashboard/[handle]/settings/notifications/_ssr-gate.ts";

describe("TASK-110 unit — Monthly period calculation, aggregation, PII guard, template escaping & SSR gate", () => {
  describe("deterministic UTC / WIB period calculation", () => {
    it("resolves previous calendar month & comparison month when running on 2026-12-01", () => {
      const dec1WibMs = Date.UTC(2026, 11, 1, 1, 0, 0); // 2026-12-01 08:00 WIB
      expect(isFirstDayOfMonth(dec1WibMs, "Asia/Jakarta")).toBe(true);
      expect(isFirstDayOfMonth(dec1WibMs, "UTC")).toBe(true);

      const period = resolvePreviousCalendarMonthPeriod(dec1WibMs, "Asia/Jakarta");
      expect(period).toEqual({
        reportMonth: "2026-11",
        reportYear: 2026,
        reportMonthNumber: 11,
        reportMonthLabelId: "November 2026",
        startDay: "2026-11-01",
        endDay: "2026-11-30",
        comparisonMonth: "2026-10",
        comparisonYear: 2026,
        comparisonMonthNumber: 10,
        comparisonMonthLabelId: "Oktober 2026",
        comparisonStartDay: "2026-10-01",
        comparisonEndDay: "2026-10-31",
        timeZone: "Asia/Jakarta",
      });
    });

    it("distinguishes WIB midnight rollover (2026-11-30 17:30 UTC = 2026-12-01 00:30 WIB)", () => {
      const wibMidnightRollover = Date.UTC(2026, 10, 30, 17, 30, 0);
      expect(isFirstDayOfMonth(wibMidnightRollover, "Asia/Jakarta")).toBe(true);
      expect(isFirstDayOfMonth(wibMidnightRollover, "UTC")).toBe(false);

      const wibPeriod = resolvePreviousCalendarMonthPeriod(wibMidnightRollover, "Asia/Jakarta");
      expect(wibPeriod.reportMonth).toBe("2026-11");
      expect(wibPeriod.comparisonMonth).toBe("2026-10");
    });

    it("handles year rollover (2027-01-01 -> 2026-12 vs 2026-11) and leap year February (2028-02)", () => {
      const jan1 = Date.UTC(2027, 0, 1, 2, 0, 0);
      const janPeriod = resolvePreviousCalendarMonthPeriod(jan1, "Asia/Jakarta");
      expect(janPeriod.reportMonth).toBe("2026-12");
      expect(janPeriod.reportMonthLabelId).toBe("Desember 2026");
      expect(janPeriod.endDay).toBe("2026-12-31");
      expect(janPeriod.comparisonMonth).toBe("2026-11");
      expect(janPeriod.comparisonMonthLabelId).toBe("November 2026");

      const leapFeb = parseReportMonthPeriod("2028-02");
      expect(leapFeb.startDay).toBe("2028-02-01");
      expect(leapFeb.endDay).toBe("2028-02-29");
      expect(leapFeb.comparisonMonth).toBe("2028-01");

      const nonLeapFeb = parseReportMonthPeriod("2026-02");
      expect(nonLeapFeb.endDay).toBe("2026-02-28");
    });

    it("builds deterministic idempotency keys per (tenantId, reportMonth)", () => {
      expect(buildMonthlyReportMessageKey("ten_alpha", "2026-11")).toBe(
        "monthly-report:ten_alpha:2026-11",
      );
      expect(buildMonthlyReportCronKey("2026-11")).toBe("cron:monthly-owner-report:2026-11");
      expect(() => buildMonthlyReportMessageKey("ten_alpha", "2026-13")).toThrow();
    });
  });

  describe("activity threshold, aggregation, MoM delta & deterministic Bahasa Indonesia tips", () => {
    it("enforces minimum activity threshold (< 5 visits AND 0 leads AND 0 WA clicks -> ineligible)", () => {
      expect(DEFAULT_MONTHLY_REPORT_MIN_ACTIVITY_THRESHOLD).toEqual({
        minVisits: 5,
        minLeads: 1,
        minWhatsappClicks: 1,
      });

      expect(isEligibleForMonthlyReport({ visits: 0, leads: 0, whatsappClicks: 0 })).toBe(false);
      expect(isEligibleForMonthlyReport({ visits: 4, leads: 0, whatsappClicks: 0 })).toBe(false);
      expect(isEligibleForMonthlyReport({ visits: 5, leads: 0, whatsappClicks: 0 })).toBe(true);
      expect(isEligibleForMonthlyReport({ visits: 1, leads: 1, whatsappClicks: 0 })).toBe(true);
      expect(isEligibleForMonthlyReport({ visits: 0, leads: 0, whatsappClicks: 1 })).toBe(true);
    });

    it("computes accurate MoM deltas for up, down, flat, and new cases", () => {
      expect(computeMonthlyDelta(125, 100)).toMatchObject({
        diff: 25,
        percentChange: 25,
        direction: "up",
      });
      expect(computeMonthlyDelta(80, 100)).toMatchObject({
        diff: -20,
        percentChange: -20,
        direction: "down",
      });
      expect(computeMonthlyDelta(50, 50)).toMatchObject({
        diff: 0,
        percentChange: 0,
        direction: "flat",
      });
      expect(computeMonthlyDelta(12, 0)).toMatchObject({
        diff: 12,
        percentChange: null,
        direction: "new",
      });
    });

    it("aggregates fixture month metrics, MoM comparison, top offering, AI referrals, and 1 concrete tip", () => {
      const summary = buildMonthlyPerformanceReportSummary({
        reportMonth: "2026-11",
        contentRows: [
          // Previous month (2026-10)
          {
            day_utc: "2026-10-10",
            content_kind: "page",
            content_id: 1,
            path: "/",
            page_views: 60,
            wa_clicks: 4,
            external_clicks: 0,
            lead_submits: 2,
          },
          {
            day_utc: "2026-10-15",
            content_kind: "offering",
            content_id: 100,
            path: "/layanan/konsultasi-pajak",
            page_views: 40,
            wa_clicks: 6,
            external_clicks: 0,
            lead_submits: 3,
          },
          // Report month (2026-11)
          {
            day_utc: "2026-11-05",
            content_kind: "page",
            content_id: 1,
            path: "/",
            page_views: 90,
            wa_clicks: 5,
            external_clicks: 1,
            lead_submits: 2,
          },
          {
            day_utc: "2026-11-12",
            content_kind: "offering",
            content_id: 100,
            path: "/layanan/konsultasi-pajak",
            page_views: 55,
            wa_clicks: 11,
            external_clicks: 0,
            lead_submits: 6,
          },
          {
            day_utc: "2026-11-18",
            content_kind: "offering",
            content_id: 101,
            path: "/layanan/audit-laporan",
            page_views: 25,
            wa_clicks: 2,
            external_clicks: 0,
            lead_submits: 1,
          },
          // Out-of-range row (2026-12) must be ignored
          {
            day_utc: "2026-12-01",
            content_kind: "page",
            content_id: 1,
            path: "/",
            page_views: 999,
            wa_clicks: 99,
            external_clicks: 0,
            lead_submits: 99,
          },
        ],
        sourceRows: [
          {
            day_utc: "2026-10-20",
            source_bucket: "ai_assistant",
            utm_source: "chatgpt.com",
            page_views: 4,
            wa_clicks: 1,
            external_clicks: 0,
            lead_submits: 0,
          },
          {
            day_utc: "2026-11-12",
            source_bucket: "ai_assistant",
            utm_source: "chatgpt.com",
            page_views: 9,
            wa_clicks: 2,
            external_clicks: 0,
            lead_submits: 1,
          },
          {
            day_utc: "2026-11-15",
            source_bucket: "search",
            utm_source: "",
            page_views: 80,
            wa_clicks: 10,
            external_clicks: 0,
            lead_submits: 5,
          },
        ],
        offeringTitles: {
          byId: new Map([
            [100, "Konsultasi Pajak UMKM"],
            [101, "Audit Laporan Tahunan"],
          ]),
        },
      });

      expect(summary.meetsActivityThreshold).toBe(true);
      expect(summary.current).toEqual({
        visits: 170,
        leads: 9,
        whatsappClicks: 18,
        aiAssistantReferrals: 9, // counts page_views ONLY (not wa_clicks + lead_submits)
      });
      expect(summary.previous).toEqual({
        visits: 100,
        leads: 5,
        whatsappClicks: 10,
        aiAssistantReferrals: 4, // counts page_views ONLY
      });
      expect(summary.mom.visits).toMatchObject({ diff: 70, percentChange: 70, direction: "up" });
      expect(summary.mom.leads).toMatchObject({ diff: 4, percentChange: 80, direction: "up" });
      expect(summary.mom.whatsappClicks).toMatchObject({ diff: 8, percentChange: 80, direction: "up" });
      expect(summary.mom.aiAssistantReferrals).toMatchObject({
        diff: 5,
        percentChange: 125,
        direction: "up",
      });
      expect(summary.topOffering).toEqual({
        title: "Konsultasi Pajak UMKM",
        path: "/layanan/konsultasi-pajak",
        visits: 55,
        whatsappClicks: 11,
        leads: 6,
        totalActivity: 72,
      });
      expect(summary.actionableTip).toContain("Konsultasi Pajak UMKM");
    });

    it("selects distinct deterministic Bahasa Indonesia tips per performance scenario", () => {
      const highVisitsNoConv = selectConcreteMonthlyTip({
        current: { visits: 40, leads: 0, whatsappClicks: 0, aiAssistantReferrals: 2 },
        mom: {
          visits: computeMonthlyDelta(40, 35),
          leads: computeMonthlyDelta(0, 0),
          whatsappClicks: computeMonthlyDelta(0, 0),
          aiAssistantReferrals: computeMonthlyDelta(2, 1),
        },
        topOffering: null,
      });
      expect(highVisitsNoConv).toContain("tombol WhatsApp");

      const dropTip = selectConcreteMonthlyTip({
        current: { visits: 20, leads: 1, whatsappClicks: 2, aiAssistantReferrals: 1 },
        mom: {
          visits: computeMonthlyDelta(20, 50),
          leads: computeMonthlyDelta(1, 2),
          whatsappClicks: computeMonthlyDelta(2, 4),
          aiAssistantReferrals: computeMonthlyDelta(1, 1),
        },
        topOffering: null,
      });
      expect(dropTip).toContain("Kunjungan turun");

      const zeroAiTip = selectConcreteMonthlyTip({
        current: { visits: 15, leads: 1, whatsappClicks: 2, aiAssistantReferrals: 0 },
        mom: {
          visits: computeMonthlyDelta(15, 15),
          leads: computeMonthlyDelta(1, 1),
          whatsappClicks: computeMonthlyDelta(2, 2),
          aiAssistantReferrals: computeMonthlyDelta(0, 0),
        },
        topOffering: null,
      });
      expect(zeroAiTip).toContain("asisten AI");
    });
  });

  describe("HTML escaping & Zero Visitor PII guard", () => {
    it("escapes XSS payloads in business name and top offering title and passes PII guard", () => {
      const rendered = renderEmailTemplate("monthly-owner-performance-report", {
        recipientName: 'Sari <b>"Admin"</b>',
        tenantName: 'Bengkel <script>alert("xss")</script> & Jaya',
        tenantHandle: "bengkel-jaya",
        reportMonth: "2026-11",
        reportMonthLabel: "November 2026",
        comparisonMonthLabel: "Oktober 2026",
        visits: 142,
        leads: 7,
        whatsappClicks: 19,
        aiAssistantReferrals: 8,
        momVisits: { direction: "up", labelId: "+20% (+24 vs bulan lalu)" },
        momLeads: { direction: "up", labelId: "+40% (+2 vs bulan lalu)" },
        momWhatsappClicks: { direction: "down", labelId: "-5% (-1 vs bulan lalu)" },
        momAiAssistantReferrals: { direction: "new", labelId: "+8 baru (bulan lalu 0)" },
        topOffering: {
          title: 'Servis <img src=x onerror=alert(1)> AC Mobil',
          path: "/layanan/servis-ac",
          visits: 68,
          whatsappClicks: 12,
          leads: 5,
        },
        actionableTip: 'Tambahkan kisaran harga pada "Servis AC" & tombol WhatsApp.',
        dashboardInsightsUrl: "https://app.punyasitus.com/dashboard/bengkel-jaya/insights",
        notificationSettingsUrl:
          "https://app.punyasitus.com/dashboard/bengkel-jaya/settings/notifications",
      });

      expect(rendered.html).not.toContain("<script>");
      expect(rendered.html).not.toContain("<img src=x");
      expect(rendered.html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; Jaya");
      expect(rendered.html).toContain("Servis &lt;img src=x onerror=alert(1)&gt; AC Mobil");
      expect(rendered.html).toContain(
        "https://app.punyasitus.com/dashboard/bengkel-jaya/settings/notifications",
      );
      expect(rendered.text).toContain(
        "https://app.punyasitus.com/dashboard/bengkel-jaya/settings/notifications",
      );

      // Must pass Zero Visitor PII guard cleanly (allowing boilerplate noreply@notif.punyasitus.com)
      expect(() => assertZeroVisitorPiiInMonthlyReport(rendered)).not.toThrow();
    });

    it("blocks visitor emails, IPv4 addresses, phone numbers, and User-Agents in PII guard", () => {
      const emailCheck = detectVisitorPiiInReportContent({
        subject: "Laporan Bulanan",
        html: "<p>Lead dari budi.visitor@example.com</p>",
        text: "Lead dari budi.visitor@example.com",
      });
      expect(emailCheck.clean).toBe(false);
      expect(emailCheck.detectedCategories).toContain("email");

      expect(() =>
        assertZeroVisitorPiiInMonthlyReport({
          subject: "Laporan",
          html: "<p>IP pengunjung 203.0.113.42 dan HP +6281234567890 Mozilla/5.0 Chrome/131</p>",
          text: "IP pengunjung 203.0.113.42 dan HP +6281234567890 Mozilla/5.0 Chrome/131",
        }),
      ).toThrow(MonthlyReportPiiLeakError);

      expect(sanitizeReportDisplayText("Promo 081234567890 hubungi cs@toko.id 10.0.0.1")).not.toContain(
        "081234567890",
      );
      expect(sanitizeReportDisplayText("Promo 081234567890 hubungi cs@toko.id 10.0.0.1")).not.toContain(
        "cs@toko.id",
      );
    });

    it("rejects non-https action URLs in monthly report template", () => {
      expect(() =>
        renderEmailTemplate("monthly-owner-performance-report", {
          tenantName: "Alpha Studio",
          tenantHandle: "alpha-studio",
          reportMonth: "2026-11",
          reportMonthLabel: "November 2026",
          comparisonMonthLabel: "Oktober 2026",
          visits: 10,
          leads: 1,
          whatsappClicks: 2,
          aiAssistantReferrals: 1,
          momVisits: { direction: "up", labelId: "+10%" },
          momLeads: { direction: "flat", labelId: "0%" },
          momWhatsappClicks: { direction: "up", labelId: "+100%" },
          momAiAssistantReferrals: { direction: "new", labelId: "+1 baru" },
          actionableTip: "Tambahkan foto penawaran terbaru.",
          dashboardInsightsUrl: "javascript:alert(1)",
          notificationSettingsUrl:
            "https://app.punyasitus.com/dashboard/alpha-studio/settings/notifications",
        }),
      ).toThrow();
    });
  });

  describe("owner-only notification settings SSR gate", () => {
    it("allows owner and denies admin, editor, agency_staff, foreign, and purging states", () => {
      const ok = evaluateNotificationSettingsSsrGate({
        rawHandle: "alpha-studio",
        surface: "app",
        isLocalLoopback: false,
        isLocalEnv: false,
        authUser: { id: "usr_owner", name: "Owner", email: "owner@example.test" },
        authorized: {
          tenantId: "ten_alpha",
          handle: "alpha-studio",
          role: "owner",
          dbRole: "owner",
          tenantStatus: "active",
        },
      });
      expect(ok.ok).toBe(true);

      for (const nonOwner of [
        { role: "admin" as const, dbRole: "admin" as const },
        { role: "editor" as const, dbRole: "editor" as const },
        { role: "agency_admin" as const, dbRole: "agency_staff" as const },
        { role: "owner" as const, dbRole: undefined },
      ]) {
        const res = evaluateNotificationSettingsSsrGate({
          rawHandle: "alpha-studio",
          surface: "app",
          isLocalLoopback: false,
          isLocalEnv: false,
          authUser: { id: "usr_other", name: "Other" },
          authorized: {
            tenantId: "ten_alpha",
            handle: "alpha-studio",
            role: nonOwner.role,
            dbRole: nonOwner.dbRole,
            tenantStatus: "active",
          },
        });
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.status).toBe(403);
          expect(res.response.headers.get("cache-control")).toBe("private, no-store");
          expect(res.response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        }
      }

      const foreign = evaluateNotificationSettingsSsrGate({
        rawHandle: "beta-klinik",
        surface: "app",
        isLocalLoopback: false,
        isLocalEnv: false,
        authUser: { id: "usr_owner", name: "Owner" },
        authorized: {
          tenantId: "ten_alpha",
          handle: "alpha-studio",
          role: "owner",
          dbRole: "owner",
          tenantStatus: "active",
        },
      });
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(foreign.status).toBe(404);

      const purging = evaluateNotificationSettingsSsrGate({
        rawHandle: "alpha-studio",
        surface: "app",
        isLocalLoopback: false,
        isLocalEnv: false,
        authUser: { id: "usr_owner", name: "Owner" },
        authorized: {
          tenantId: "ten_alpha",
          handle: "alpha-studio",
          role: "owner",
          dbRole: "owner",
          tenantStatus: "purging",
        },
      });
      expect(purging.ok).toBe(false);
      if (!purging.ok) expect(purging.status).toBe(404);
    });
  });
});

import fs from "node:fs";
import path from "node:path";
import {
  addCalendarDaysToIsoDate,
  containsScheduleFieldKey,
  DEFAULT_TENANT_TIMEZONE,
  formatPreferredDateIndonesian,
  formatPreferredTimeLabelId,
  getPreferredDateBounds,
  getTodayIsoDateInTimeZone,
  isValidCalendarIsoDate,
  parseOptionalBranchId,
  stripScheduleFieldsForTelemetry,
  validatePreferredDate,
  validatePreferredTime,
} from "@punyasitus/core/leads/index";
import {
  ALL_WA_TOKENS,
  buildWhatsAppUrl,
  CANONICAL_WA_TOKENS,
  DEFAULT_WA_SCHEDULE_TEMPLATE,
  renderWhatsAppTemplate,
  SCHEDULE_WA_TOKENS,
  validateWhatsAppTemplate,
  WhatsAppValidationError,
} from "@punyasitus/core/wa-dispatcher";
import {
  buildLeadWhatsAppFollowUpUrl,
  buildNewLeadOwnerNotificationEmail,
  LEAD_PREFERRED_SCHEDULE_MIGRATION,
  TENANT_0024_LEAD_PREFERRED_SCHEDULE_SQL,
  validatePublicLeadSubmission,
} from "@punyasitus/db/leads/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { describe, expect, it } from "vitest";
import {
  resolveScheduleInquiryCtaConfig,
  sanitizeContactBranchOptions,
} from "../../apps/web/src/themes/default/components/ScheduleInquiryCta.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

function expectWaError(fn: () => unknown, code: WhatsAppValidationError["code"]): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(WhatsAppValidationError);
  expect((caught as WhatsAppValidationError).code).toBe(code);
}

describe("TASK-071 unit tests — Preferred Schedule Fields, Single-Pass WA Tokens, Timezone Math & Guards", () => {
  describe("WhatsApp single-pass token expansion & empty sentence dropping (REQ-072)", () => {
    it("preserves TASK-010 CANONICAL_WA_TOKENS while exposing schedule tokens", () => {
      expect(CANONICAL_WA_TOKENS).toEqual(["item_title", "item_price", "page_url"]);
      expect(SCHEDULE_WA_TOKENS).toEqual(["preferred_date", "preferred_time", "branch"]);
      expect(ALL_WA_TOKENS).toEqual([
        "item_title",
        "item_price",
        "page_url",
        "preferred_date",
        "preferred_time",
        "branch",
      ]);
    });

    it("expands {{preferred_date}}, {{preferred_time}}, and {{branch}} in a single pass without recursive re-expansion", () => {
      const rendered = renderWhatsAppTemplate(DEFAULT_WA_SCHEDULE_TEMPLATE, {
        item_title: "Konsultasi {{branch}} & {{preferred_date}} $& $$",
        page_url: "https://alpha-klinik.situsku.click/kontak",
        preferred_date: "15 Desember 2026 {{preferred_time}}",
        preferred_time: "Pagi {{item_title}}",
        branch: "Cabang {{page_url}} Selatan",
      });

      expect(rendered).toBe(
        [
          "Halo, saya ingin mengajukan permintaan jadwal untuk Konsultasi {{branch}} & {{preferred_date}} $& $$.",
          "Tanggal yang diharapkan: 15 Desember 2026 {{preferred_time}}.",
          "Waktu yang diharapkan: Pagi {{item_title}}.",
          "Cabang tujuan: Cabang {{page_url}} Selatan.",
          "https://alpha-klinik.situsku.click/kontak",
        ].join("\n"),
      );
    });

    it("rejects unknown tokens deterministically even when optional schedule tokens are empty", () => {
      expectWaError(
        () =>
          renderWhatsAppTemplate(
            "Halo {{item_title}}. Tanggal: {{preferred_date}}. Slot: {{slot_id}}.",
            {
              item_title: "Konsultasi",
              preferred_date: null,
            },
          ),
        "UNKNOWN_TOKEN",
      );
      expectWaError(
        () =>
          renderWhatsAppTemplate("Halo {{ preferred_date }}", {
            preferred_date: "2026-12-15",
          }),
        "UNKNOWN_TOKEN",
      );
      expectWaError(
        () => validateWhatsAppTemplate("Halo {{booking_confirmation}}"),
        "UNKNOWN_TOKEN",
      );
      expectWaError(
        () => validateWhatsAppTemplate("Halo {{preferred_date"),
        "INVALID_TEMPLATE",
      );
    });

    it("drops the entire sentence cleanly when optional schedule fields are empty (multi-line & single-line)", () => {
      const noSchedule = renderWhatsAppTemplate(DEFAULT_WA_SCHEDULE_TEMPLATE, {
        item_title: "Klinik Gigi Nusantara",
        page_url: "https://klinik.situsku.click/kontak",
        preferred_date: "",
        preferred_time: null,
        branch: undefined,
      });

      expect(noSchedule).toBe(
        "Halo, saya ingin mengajukan permintaan jadwal untuk Klinik Gigi Nusantara.\nhttps://klinik.situsku.click/kontak",
      );
      expect(noSchedule).not.toContain("{{");
      expect(noSchedule).not.toContain("Tanggal yang diharapkan");
      expect(noSchedule).not.toContain("Waktu yang diharapkan");
      expect(noSchedule).not.toContain("Cabang tujuan");

      const singleLineTemplate =
        "Halo, saya tertarik {{item_title}}. Permintaan jadwal pada tanggal {{preferred_date}}. Waktu yang diharapkan {{preferred_time}}. Lokasi di cabang {{branch}}. Detail: {{page_url}}";
      const partial = renderWhatsAppTemplate(singleLineTemplate, {
        item_title: "Audit Pajak",
        page_url: "https://konsultan.situsku.click/layanan/audit",
        preferred_date: "10 Desember 2026",
        preferred_time: "",
        branch: null,
      });

      expect(partial).toBe(
        "Halo, saya tertarik Audit Pajak. Permintaan jadwal pada tanggal 10 Desember 2026. Detail: https://konsultan.situsku.click/layanan/audit",
      );
      expect(partial).not.toContain("di cabang .");
      expect(partial).not.toContain("Waktu yang diharapkan");
      expect(partial).not.toContain("  ");
    });

    it("builds a clean no-JS wa.me URL without schedule token sentences via buildWhatsAppUrl & ScheduleInquiryCta", () => {
      const dispatch = buildWhatsAppUrl({
        tenantPhone: "0812-3456-7890",
        template: DEFAULT_WA_SCHEDULE_TEMPLATE,
        itemTitle: "Klinik Sehat",
        primaryOrigin: "https://klinik.situsku.click",
        canonicalPath: "/kontak",
      });
      expect(dispatch.url.startsWith("https://wa.me/6281234567890?text=")).toBe(true);
      expect(dispatch.message).toContain("permintaan jadwal");
      expect(dispatch.message).not.toContain("{{preferred_date}}");
      expect(dispatch.message).not.toContain("{{preferred_time}}");
      expect(dispatch.message).not.toContain("{{branch}}");

      const cta = resolveScheduleInquiryCtaConfig({
        whatsappPhone: "+62 813-9988-7766",
        businessName: "Klinik Sehat",
        primaryOrigin: "https://klinik.situsku.click",
        canonicalPath: "/kontak",
        template: "Halo {{unknown_token}}", // must fail closed back to canonical default template
      });
      expect(cta).not.toBeNull();
      expect(cta?.waUrl.startsWith("https://wa.me/6281399887766?text=")).toBe(true);
      expect(cta?.message).toContain("permintaan jadwal");
      expect(cta?.message).not.toContain("{{");

      // Invalid phone fails closed
      expect(resolveScheduleInquiryCtaConfig({ whatsappPhone: "021-123456" })).toBeNull();
    });

    it("sanitizes branch options cleanly and caps at 10 unique active entries", () => {
      const sanitized = sanitizeContactBranchOptions([
        { id: 1, name: "  Cabang\nSelatan  " },
        { id: 1, name: "Duplicate" },
        { id: 0, name: "Invalid ID" },
        { id: 2, name: "Cabang Utara" },
      ]);
      expect(sanitized).toEqual([
        { id: 1, name: "Cabang Selatan" },
        { id: 2, name: "Cabang Utara" },
      ]);
    });
  });

  describe("Date-only tenant-timezone validation (today..+180d, zero TZ date shift)", () => {
    it("enforces exact today and +180d bounds across Asia/Jakarta, UTC, and America/New_York without shifting dates", () => {
      // 2026-11-23T18:30:00Z is:
      // - 2026-11-24 01:30 in Asia/Jakarta (UTC+7)
      // - 2026-11-23 18:30 in UTC
      // - 2026-11-23 13:30 in America/New_York (UTC-5)
      const instantMs = Date.UTC(2026, 10, 23, 18, 30, 0);

      expect(getTodayIsoDateInTimeZone(instantMs, "Asia/Jakarta")).toBe("2026-11-24");
      expect(getTodayIsoDateInTimeZone(instantMs, "UTC")).toBe("2026-11-23");
      expect(getTodayIsoDateInTimeZone(instantMs, "America/New_York")).toBe("2026-11-23");
      expect(getTodayIsoDateInTimeZone(instantMs, "Asia/Jayapura")).toBe("2026-11-24");

      // In Asia/Jakarta, 2026-11-23 is YESTERDAY -> rejected!
      const pastInJakarta = validatePreferredDate("2026-11-23", {
        nowMs: instantMs,
        timeZone: "Asia/Jakarta",
      });
      expect(pastInJakarta.ok).toBe(false);
      if (!pastInJakarta.ok) expect(pastInJakarta.code).toBe("DATE_IN_PAST");

      // In UTC & America/New_York, 2026-11-23 is TODAY -> accepted!
      expect(
        validatePreferredDate("2026-11-23", { nowMs: instantMs, timeZone: "UTC" }),
      ).toEqual({ ok: true, value: "2026-11-23" });
      expect(
        validatePreferredDate("2026-11-23", { nowMs: instantMs, timeZone: "America/New_York" }),
      ).toEqual({ ok: true, value: "2026-11-23" });

      // +180 days boundary in Asia/Jakarta
      const jakartaBounds = getPreferredDateBounds({
        nowMs: instantMs,
        timeZone: DEFAULT_TENANT_TIMEZONE,
      });
      expect(jakartaBounds.minDate).toBe("2026-11-24");
      expect(jakartaBounds.maxDate).toBe(addCalendarDaysToIsoDate("2026-11-24", 180));

      expect(
        validatePreferredDate(jakartaBounds.maxDate, {
          nowMs: instantMs,
          timeZone: "Asia/Jakarta",
        }),
      ).toEqual({ ok: true, value: jakartaBounds.maxDate });

      const tooFar = validatePreferredDate(addCalendarDaysToIsoDate(jakartaBounds.maxDate, 1), {
        nowMs: instantMs,
        timeZone: "Asia/Jakarta",
      });
      expect(tooFar.ok).toBe(false);
      if (!tooFar.ok) expect(tooFar.code).toBe("DATE_TOO_FAR");

      // Date-only formatting never shifts across timezones
      expect(formatPreferredDateIndonesian("2026-12-05")).toBe("5 Desember 2026");
      expect(formatPreferredDateIndonesian("2028-02-29")).toBe("29 Februari 2028");
    });

    it("rejects impossible calendar dates and non-date strings", () => {
      for (const bad of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-12-01T00:00:00Z", "besok"]) {
        expect(isValidCalendarIsoDate(bad)).toBe(false);
        const res = validatePreferredDate(bad, {
          nowMs: Date.UTC(2026, 10, 24, 5, 0, 0),
          timeZone: "Asia/Jakarta",
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.code).toBe("INVALID_DATE");
      }
    });

    it("accepts ONLY pagi|siang|sore|malam for preferred_time", () => {
      expect(validatePreferredTime("pagi")).toEqual({ ok: true, value: "pagi" });
      expect(validatePreferredTime("  SIANG ")).toEqual({ ok: true, value: "siang" });
      expect(validatePreferredTime("Sore")).toEqual({ ok: true, value: "sore" });
      expect(validatePreferredTime("malam")).toEqual({ ok: true, value: "malam" });
      expect(validatePreferredTime("")).toEqual({ ok: true, value: null });
      expect(validatePreferredTime(null)).toEqual({ ok: true, value: null });

      for (const invalid of ["subuh", "morning", "09:00", "dini_hari", "siang-sore", 123]) {
        const res = validatePreferredTime(invalid);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.code).toBe("INVALID_PREFERRED_TIME");
      }

      expect(formatPreferredTimeLabelId("pagi")).toBe("Pagi");
      expect(formatPreferredTimeLabelId("malam")).toBe("Malam");
      expect(formatPreferredTimeLabelId("invalid")).toBeNull();
    });

    it("validates public lead submissions with branch_id, rejects conflicting aliases & unknown fields", () => {
      const nowMs = Date.UTC(2026, 10, 24, 3, 0, 0); // 2026-11-24 10:00 WIB
      const valid = validatePublicLeadSubmission(
        {
          name: "Rina Wulandari",
          phone: "0812-3456-7890",
          message: "Ingin konsultasi layanan",
          privacyConsent: true,
          preferred_date: "2026-12-10",
          preferred_time: "sore",
          branch_id: "3",
        },
        { nowMs, timeZone: "Asia/Jakarta" },
      );
      expect(valid.ok).toBe(true);
      if (valid.ok) {
        expect(valid.data.lead.preferredDate).toBe("2026-12-10");
        expect(valid.data.lead.preferredTime).toBe("sore");
        expect(valid.data.lead.branchId).toBe(3);
      }

      const conflicting = validatePublicLeadSubmission(
        {
          name: "Rina",
          phone: "0812-3456-7890",
          message: "Halo",
          privacyConsent: true,
          branch_id: "1",
          branch: "2",
          slot_id: "slot-10",
        },
        { nowMs, timeZone: "Asia/Jakarta" },
      );
      expect(conflicting.ok).toBe(false);
      if (!conflicting.ok) {
        const codes = conflicting.fields.map((f) => `${f.field}:${f.code}`);
        expect(codes).toContain("branch_id:INVALID_BRANCH");
        expect(codes).toContain("slot_id:UNKNOWN_FIELD");
      }

      expect(parseOptionalBranchId("0").ok).toBe(false);
      expect(parseOptionalBranchId("-1").ok).toBe(false);
      expect(parseOptionalBranchId("abc").ok).toBe(false);
    });
  });

  describe("Privacy & telemetry guarantees", () => {
    it("strips all schedule fields from telemetry/analytics payloads and keeps owner emails schedule-free", () => {
      const rawTelemetry = {
        event: "lead_submitted",
        page_path: "/kontak",
        preferred_date: "2026-12-10",
        preferred_time: "pagi",
        branch_id: 2,
        nested: {
          preferredBranchLabel: "Cabang Jakarta",
          preferredDate: "2026-12-10",
          ok: true,
        },
      };
      expect(containsScheduleFieldKey(rawTelemetry)).toBe(true);
      const cleaned = stripScheduleFieldsForTelemetry(rawTelemetry);
      expect(containsScheduleFieldKey(cleaned)).toBe(false);
      expect(cleaned).toEqual({
        event: "lead_submitted",
        page_path: "/kontak",
        nested: { ok: true },
      });

      const mail = buildNewLeadOwnerNotificationEmail({
        tenantId: "01JT071TENANT000000000001",
        tenantName: "Klinik Sehat",
        tenantHandle: "klinik-sehat",
        leadId: 12,
        ownerEmail: "owner@klinik.example",
        appOrigin: "https://app.punyasitus.com",
      });
      const combined = `${mail.subject}\n${mail.html}\n${mail.text}`;
      expect(combined).not.toContain("preferred_date");
      expect(combined).not.toContain("2026-12-10");
      expect(combined).not.toContain("Cabang Jakarta");

      const waFollowUp = buildLeadWhatsAppFollowUpUrl({
        phone: "0812-3456-7890",
        leadName: "Siti {{branch}}",
        primaryOrigin: "https://klinik.situsku.click",
        pagePath: "/kontak",
        preferredDate: "2026-12-10",
        preferredTime: "pagi",
        branchLabel: "Cabang Kemang",
      });
      expect(waFollowUp).not.toBeNull();
      const decodedFollowUp = decodeURIComponent(waFollowUp!.split("?text=")[1] ?? "");
      expect(decodedFollowUp).toContain("Siti {{branch}}");
      expect(decodedFollowUp).toContain("10 Desember 2026");
      expect(decodedFollowUp).toContain("Pagi");
      expect(decodedFollowUp).toContain("Cabang Kemang");
    });
  });

  describe("Migration parity & strict boundary guards", () => {
    it("matches 0024_lead_preferred_schedule.sql byte-for-byte without touching 0001 TENANT_MIGRATIONS", () => {
      const sqlOnDisk = fs.readFileSync(
        path.join(ROOT, "packages/db/migrations/tenant/0024_lead_preferred_schedule.sql"),
        "utf8",
      );
      expect(TENANT_0024_LEAD_PREFERRED_SCHEDULE_SQL).toBe(sqlOnDisk);
      expect(LEAD_PREFERRED_SCHEDULE_MIGRATION.version).toBe(24);
      expect(LEAD_PREFERRED_SCHEDULE_MIGRATION.name).toBe("0024_lead_preferred_schedule");
      expect(TENANT_MIGRATIONS).toHaveLength(1);
      expect(TENANT_MIGRATIONS[0]!.name).toBe("0001_initial_tenant");
    });

    it("enforces zero forbidden imports/substrings in public contact form & components, preserves TASK-073 review link, and uses request-only copy", () => {
      const publicFiles = [
        "apps/web/src/themes/default/sections/SectionContactForm.astro",
        "apps/web/src/themes/default/components/ScheduleInquiryCta.astro",
        "apps/web/src/themes/default/components/ScheduleInquiryCta.ts",
      ];
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

      for (const rel of publicFiles) {
        const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
        for (const sub of forbiddenSubstrings) {
          expect(src.includes(sub), `${rel} must not contain forbidden substring "${sub}"`).toBe(
            false,
          );
        }
      }

      const contactSrc = fs.readFileSync(
        path.join(ROOT, "apps/web/src/themes/default/sections/SectionContactForm.astro"),
        "utf8",
      );
      expect(contactSrc.toLowerCase()).toContain("permintaan jadwal");
      expect(contactSrc).toContain("googleMapsReviewUrl");
      expect(contactSrc).toContain('data-testid="contact-google-maps-review-link"');
      expect(contactSrc).toContain('name="idempotencyKey" value=""');

      const inboxSrc = fs.readFileSync(
        path.join(ROOT, "apps/web/src/pages/dashboard/[handle]/leads/_LeadsInbox.tsx"),
        "utf8",
      );
      expect(inboxSrc).toContain("Permintaan Jadwal");
      expect(inboxSrc).not.toMatch(/@radix-ui\//);
      expect(inboxSrc).not.toMatch(/\basChild\b/);
      expect(inboxSrc).not.toMatch(/\bSparkles(?:Icon)?\b/);

      const leadsDbSrc = fs.readFileSync(
        path.join(ROOT, "packages/db/src/leads/index.ts"),
        "utf8",
      );
      expect(leadsDbSrc).not.toMatch(/CREATE\s+TABLE/i);
      expect(leadsDbSrc).not.toContain("sqlite_master");
    });
  });
});

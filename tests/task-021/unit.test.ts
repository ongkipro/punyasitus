import fs from "node:fs";
import path from "node:path";
import {
  buildLeadWhatsAppFollowUpUrl,
  buildNewLeadOwnerNotificationEmail,
  escapeCsvCell,
  isValidLeadStatusTransition,
  sanitizeSafeRelativePath,
  serializeLeadsToCsv,
  validatePublicLeadSubmission,
  type LeadRecord,
} from "@punyasitus/db/leads/index";
import { describe, expect, it } from "vitest";

describe("TASK-021 unit tests — Lead validation, PII-free owner email, CSV escaping, status transitions & WA follow-up", () => {
  describe("validatePublicLeadSubmission", () => {
    it("accepts and normalizes valid Indonesian phone, email, message, privacy consent, sourcePath & UTM", () => {
      const res = validatePublicLeadSubmission({
        name: "  Siti Rahmawati  ",
        phone: "0812-3456-7890",
        email: "  Siti.Rahma@Example.ID ",
        message: "Halo, saya ingin konsultasi paket company profile.",
        privacyConsent: true,
        sourcePath: "/kontak",
        utm_source: "instagram",
        utm_campaign: "promo_november",
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        returnTo: "/kontak",
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.lead.name).toBe("Siti Rahmawati");
      expect(res.data.lead.phoneE164).toBe("6281234567890");
      expect(res.data.lead.email).toBe("siti.rahma@example.id");
      expect(res.data.lead.sourceCategory).toBe("campaign");
      expect(res.data.lead.pagePath).toBe("/kontak");
      expect(res.data.lead.utmJson).toBe(
        JSON.stringify({ utm_source: "instagram", utm_campaign: "promo_november" }),
      );
      expect(res.data.idempotencyKey).toBe("11111111-1111-4111-8111-111111111111");
      expect(res.data.returnTo).toBe("/kontak");
    });

    it("accepts HTML form-urlencoded privacyConsent strings ('on' / 'true') and optional empty email", () => {
      const res = validatePublicLeadSubmission({
        name: "Budi Santoso",
        phone: "+62 813 9988 7766",
        email: "",
        message: "Mohon jadwal survei lokasi minggu depan.",
        privacyConsent: "on",
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.lead.phoneE164).toBe("6281399887766");
      expect(res.data.lead.email).toBeNull();
      expect(res.data.lead.sourceCategory).toBe("direct");
    });

    it("rejects missing privacy consent, invalid phone/email, overlong message, control chars, PII in UTM & unknown fields", () => {
      const missingConsent = validatePublicLeadSubmission({
        name: "Budi",
        phone: "081234567890",
        message: "Halo",
      });
      expect(missingConsent.ok).toBe(false);
      if (!missingConsent.ok) {
        expect(missingConsent.fields.some((f) => f.code === "PRIVACY_CONSENT_REQUIRED")).toBe(true);
      }

      const badFields = validatePublicLeadSubmission({
        name: "A".repeat(101),
        phone: "12345",
        email: "bukan-email",
        message: "M".repeat(2001),
        privacyConsent: true,
        sourcePath: "/kontak?email=leak@test.id",
        utm_source: "user@secret.id",
        extraField: "unexpected",
      });
      expect(badFields.ok).toBe(false);
      if (!badFields.ok) {
        const codes = badFields.fields.map((f) => `${f.field}:${f.code}`);
        expect(codes).toContain("name:TOO_LONG");
        expect(codes).toContain("phone:INVALID_PHONE");
        expect(codes).toContain("email:INVALID_EMAIL");
        expect(codes).toContain("message:TOO_LONG");
        expect(codes).toContain("sourcePath:INVALID_PATH");
        expect(codes).toContain("utm_source:PII_NOT_ALLOWED");
        expect(codes).toContain("extraField:UNKNOWN_FIELD");
      }
    });
  });

  describe("buildNewLeadOwnerNotificationEmail (STRICT PII-FREE)", () => {
    it("renders a PII-free Bahasa Indonesia notice pointing to /dashboard/<handle>/leads with zero visitor data", () => {
      const visitorName = "Dewi Lestari Rahasia";
      const visitorPhone = "6281299887766";
      const visitorEmail = "dewi.rahasia@example.test";
      const visitorMessage = "Tolong hubungi saya terkait proyek gedung 5 lantai.";

      const mail = buildNewLeadOwnerNotificationEmail({
        tenantId: "01JTESTTENANTALPHA00000001",
        tenantName: "Alpha Studio",
        tenantHandle: "alpha-studio",
        leadId: 42,
        ownerEmail: "owner@alpha.example",
        appOrigin: "https://app.punyasitus.com",
      });

      expect(mail.from).toBe("noreply@notif.punyasitus.com");
      expect(mail.to).toBe("owner@alpha.example");
      expect(mail.messageKey).toBe("new-lead:01JTESTTENANTALPHA00000001:42");
      expect(mail.subject).toContain("Ada pesan masuk baru");
      expect(mail.subject).toContain("Alpha Studio");
      expect(mail.html).toContain("https://app.punyasitus.com/dashboard/alpha-studio/leads");
      expect(mail.text).toContain("https://app.punyasitus.com/dashboard/alpha-studio/leads");

      // Zero visitor PII anywhere in subject, HTML, or plain text
      const combined = `${mail.subject}\n${mail.html}\n${mail.text}`;
      for (const secret of [visitorName, visitorPhone, visitorEmail, visitorMessage, "081299887766"]) {
        expect(combined).not.toContain(secret);
      }
    });

    it("sanitizes header CRLF injection and escapes HTML in tenantName", () => {
      const mail = buildNewLeadOwnerNotificationEmail({
        tenantId: "01JTESTTENANTALPHA00000001",
        tenantName: "Alpha <script>alert(1)</script>\r\nBcc: attacker@evil.test",
        tenantHandle: "alpha-studio",
        leadId: 7,
        ownerEmail: "owner@alpha.example",
        appOrigin: "https://app.punyasitus.com",
      });

      expect(mail.subject).not.toContain("\r");
      expect(mail.subject).not.toContain("\n");
      expect(mail.html).not.toContain("<script>");
      expect(mail.html).toContain("&lt;script&gt;");
    });
  });

  describe("CSV formula-injection escaping", () => {
    it("neutralizes =, +, -, @, tab, and leading-space formulas while preserving RFC 4180 quoting", () => {
      expect(escapeCsvCell("=CMD|' /C calc'!A0")).toBe("'=CMD|' /C calc'!A0");
      expect(escapeCsvCell("+1+1")).toBe("'+1+1");
      expect(escapeCsvCell("-2+3")).toBe("'-2+3");
      expect(escapeCsvCell("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
      expect(escapeCsvCell("\t=1+1")).toBe("'\t=1+1");
      expect(escapeCsvCell("  =HYPERLINK(\"https://evil.test\",\"klik\")")).toBe(
        "\"'  =HYPERLINK(\"\"https://evil.test\"\",\"\"klik\"\")\"",
      );
      expect(escapeCsvCell('Budi, "PT Maju"\nBaris 2')).toBe('"Budi, ""PT Maju""\nBaris 2"');
      expect(escapeCsvCell("Nama Normal")).toBe("Nama Normal");
    });

    it("serializes leads into a formula-safe CSV table", () => {
      const sample: LeadRecord = {
        id: 1,
        name: '=HYPERLINK("https://evil.test","Klik")',
        phone: "6281234567890",
        email: "user@example.test",
        message: "+1+2, butuh penawaran",
        status: "new",
        preferredDate: null,
        preferredTime: null,
        branchId: null,
        sourceCategory: "direct",
        utm: null,
        pagePath: "/kontak",
        internalNotes: "@admin cek segera",
        version: 1,
        createdAt: "2026-11-23T01:00:00.000Z",
        updatedAt: "2026-11-23T01:00:00.000Z",
        createdAtMs: 1_763_859_600_000,
        updatedAtMs: 1_763_859_600_000,
      };

      const csv = serializeLeadsToCsv([sample]);
      const lines = csv.trim().split("\r\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(
        "id,created_at,status,name,phone,email,message,preferred_date,preferred_time,branch_id,source_category,page_path,internal_notes,updated_at",
      );
      expect(lines[1]).toContain("\"'=HYPERLINK(\"\"https://evil.test\"\",\"\"Klik\"\")\"");
      expect(lines[1]).toContain("\"'+" + '1+2, butuh penawaran"');
      expect(lines[1]).toContain("'@admin cek segera");
    });
  });

  describe("Lead status transitions", () => {
    it("enforces forward-only transitions while permitting same-status notes saves", () => {
      expect(isValidLeadStatusTransition("new", "new")).toBe(true);
      expect(isValidLeadStatusTransition("new", "contacted")).toBe(true);
      expect(isValidLeadStatusTransition("new", "closed")).toBe(true);
      expect(isValidLeadStatusTransition("contacted", "contacted")).toBe(true);
      expect(isValidLeadStatusTransition("contacted", "closed")).toBe(true);
      expect(isValidLeadStatusTransition("closed", "closed")).toBe(true);

      // Backward transitions rejected
      expect(isValidLeadStatusTransition("contacted", "new")).toBe(false);
      expect(isValidLeadStatusTransition("closed", "new")).toBe(false);
      expect(isValidLeadStatusTransition("closed", "contacted")).toBe(false);
    });
  });

  describe("WhatsApp follow-up link & safe relative path", () => {
    it("generates validated wa.me follow-up URLs via TASK-010 and resists template token injection", () => {
      const url = buildLeadWhatsAppFollowUpUrl({
        phone: "0812-3456-7890",
        leadName: "Andi {{page_url}} $&",
        primaryOrigin: "https://alpha-studio.situsku.click",
        pagePath: "/kontak",
      });

      expect(url).not.toBeNull();
      expect(url?.startsWith("https://wa.me/6281234567890?text=")).toBe(true);
      const decoded = decodeURIComponent(url!.split("?text=")[1] ?? "");
      expect(decoded).toContain("Andi {{page_url}} $&");
      expect(decoded).toContain("https://alpha-studio.situsku.click/kontak");
    });

    it("returns null for non-Indonesian/invalid phone numbers", () => {
      expect(
        buildLeadWhatsAppFollowUpUrl({
          phone: "not-a-phone",
          leadName: "Test",
          primaryOrigin: "https://alpha-studio.situsku.click",
        }),
      ).toBeNull();
    });

    it("blocks open-redirect, HTML/XSS attribute breakouts, traversal, and PII return paths", () => {
      expect(sanitizeSafeRelativePath("/kontak")).toBe("/kontak");
      expect(sanitizeSafeRelativePath("/kontak?leadStatus=accepted#top")).toBe("/kontak");
      expect(sanitizeSafeRelativePath("//evil.test/phish")).toBeNull();
      expect(sanitizeSafeRelativePath("https://evil.test")).toBeNull();
      expect(sanitizeSafeRelativePath("/kontak/user@leak.id")).toBeNull();
      expect(sanitizeSafeRelativePath('/x"onmouseover="alert(1)')).toBeNull();
      expect(sanitizeSafeRelativePath("/x'onclick='alert(1)")).toBeNull();
      expect(sanitizeSafeRelativePath("/x<script>alert(1)</script>")).toBeNull();
      expect(sanitizeSafeRelativePath("/%22onmouseover=%22alert(1)")).toBeNull();
      expect(sanitizeSafeRelativePath("/kontak/../admin")).toBeNull();

      const xssSourcePath = validatePublicLeadSubmission({
        name: "Budi",
        phone: "081234567890",
        message: "Halo",
        privacyConsent: true,
        sourcePath: '/x"onmouseover="alert(1)',
      });
      expect(xssSourcePath.ok).toBe(false);
    });

    it("guarantees zero SSR idempotencyKey baking in SectionContactForm.astro and zero runtime DDL in packages/db/src/leads", () => {
      const root = path.resolve(import.meta.dirname, "../..");
      const formSrc = fs.readFileSync(
        path.join(root, "apps/web/src/themes/default/sections/SectionContactForm.astro"),
        "utf8",
      );
      expect(formSrc).toContain('name="idempotencyKey" value=""');
      expect(formSrc).not.toContain("const formIdempotencyKey");

      const leadsDbSrc = fs.readFileSync(
        path.join(root, "packages/db/src/leads/index.ts"),
        "utf8",
      );
      expect(leadsDbSrc).not.toMatch(/CREATE\s+TABLE/i);
      expect(leadsDbSrc).not.toContain("sqlite_master");
    });
  });
});

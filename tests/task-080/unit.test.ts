import fs from "node:fs";
import path from "node:path";
import {
  buildCustomFormWhatsAppSummaryUrl,
  CLOSED_FORM_FIELD_TYPES,
  FORM_VERTICAL_TEMPLATES,
  getFormVerticalTemplate,
  isHealthSensitiveBusinessCategory,
  MAX_FIELDS_PER_FORM,
  resolveCustomFormAfterSubmit,
  validateCustomFormSubmission,
  validateFormDefinition,
  validateSafeAfterSubmitUrl,
  type CustomFormField,
  type PublishedFormDefinition,
} from "@punyasitus/core/forms/index";
import { CUSTOM_FORMS_MIGRATION, CUSTOM_FORMS_MIGRATION_SQL } from "@punyasitus/db/forms/migrations";
import { describe, expect, it } from "vitest";

function makeValidPublishedForm(
  overrides: Partial<PublishedFormDefinition> = {},
): PublishedFormDefinition {
  const tpl = getFormVerticalTemplate("permintaan_penawaran")!;
  return {
    schemaVersion: 1,
    formId: 1,
    slug: tpl.defaultSlug,
    name: tpl.defaultName,
    description: tpl.defaultDescription,
    submitLabel: tpl.submitLabel,
    templateKey: tpl.key,
    fields: [...tpl.fields],
    afterSubmitAction: tpl.afterSubmitAction,
    afterSubmitConfig: { ...tpl.afterSubmitConfig },
    publishedVersion: 1,
    publishedAt: "2026-11-23T12:00:00.000Z",
    ...overrides,
  };
}

describe("TASK-080 Unit: Custom Forms Schema, Templates, Validation & WhatsApp Summary", () => {
  it("provides exactly 6 valid Indonesian vertical starter templates", () => {
    expect(FORM_VERTICAL_TEMPLATES).toHaveLength(6);
    const keys = FORM_VERTICAL_TEMPLATES.map((t) => t.key);
    expect(keys).toEqual([
      "booking_layanan",
      "permintaan_penawaran",
      "pendaftaran_tur",
      "test_drive",
      "reservasi_meja",
      "kontak_umum",
    ]);

    for (const tpl of FORM_VERTICAL_TEMPLATES) {
      const res = validateFormDefinition({
        slug: tpl.defaultSlug,
        name: tpl.defaultName,
        description: tpl.defaultDescription,
        submitLabel: tpl.submitLabel,
        templateKey: tpl.key,
        fields: tpl.fields,
        afterSubmitAction: tpl.afterSubmitAction,
        afterSubmitConfig: tpl.afterSubmitConfig,
      });
      expect(res.ok, `Template ${tpl.key} failed validation`).toBe(true);
      expect(tpl.fields.length).toBeLessThanOrEqual(MAX_FIELDS_PER_FORM);
    }
  });

  it("enforces closed 10 field types and rejects file upload, hidden, payment, quiz, and 13th field", () => {
    expect(CLOSED_FORM_FIELD_TYPES).toHaveLength(10);

    for (const forbiddenType of ["file", "file_upload", "hidden", "payment", "quiz"]) {
      const res = validateFormDefinition({
        slug: "bad-type",
        name: "Bad Type",
        fields: [
          {
            key: "lampiran",
            type: forbiddenType,
            label: "Lampiran",
            required: false,
          },
        ],
        afterSubmitAction: "text",
        afterSubmitConfig: { message: "Terima kasih." },
      });
      expect(res.ok).toBe(false);
    }

    // 13 fields MUST fail
    const thirteenFields: CustomFormField[] = Array.from({ length: 13 }, (_, idx) => ({
      key: `field_${idx + 1}`,
      type: "short_text",
      label: `Pertanyaan ${idx + 1}`,
      required: false,
      placeholder: null,
      helpText: null,
      condition: null,
    }));
    const overLimit = validateFormDefinition({
      slug: "too-many-fields",
      name: "Terlalu Banyak Field",
      fields: thirteenFields,
      afterSubmitAction: "text",
      afterSubmitConfig: { message: "OK" },
    });
    expect(overLimit.ok).toBe(false);

    // 12 fields MUST pass
    const atLimit = validateFormDefinition({
      slug: "twelve-fields",
      name: "Pas Dua Belas Field",
      fields: thirteenFields.slice(0, 12),
      afterSubmitAction: "text",
      afterSubmitConfig: { message: "OK" },
    });
    expect(atLimit.ok).toBe(true);
  });

  it("rejects reserved keys, unknown strict-schema properties, and nested 2-level conditions", () => {
    const reserved = validateFormDefinition({
      slug: "reserved-key",
      name: "Reserved Key",
      fields: [
        {
          key: "tenant_id",
          type: "short_text",
          label: "Tenant",
          required: true,
        },
      ],
      afterSubmitAction: "text",
      afterSubmitConfig: { message: "OK" },
    });
    expect(reserved.ok).toBe(false);

    const extraProp = validateFormDefinition({
      slug: "extra-prop",
      name: "Extra Prop",
      unknownFlag: true,
      fields: [
        {
          key: "nama",
          type: "short_text",
          label: "Nama",
          required: true,
        },
      ],
      afterSubmitAction: "text",
      afterSubmitConfig: { message: "OK" },
    });
    expect(extraProp.ok).toBe(false);

    // 2-level chained condition (C depends on B, B depends on A) MUST fail!
    const chained = validateFormDefinition({
      slug: "chained-cond",
      name: "Chained Condition",
      fields: [
        {
          key: "opsi_a",
          type: "radio",
          label: "Opsi A",
          required: true,
          options: ["Ya", "Tidak"],
        },
        {
          key: "opsi_b",
          type: "radio",
          label: "Opsi B",
          required: false,
          options: ["Pagi", "Sore"],
          condition: { fieldKey: "opsi_a", equalsValue: "Ya" },
        },
        {
          key: "detail_c",
          type: "short_text",
          label: "Detail C",
          required: false,
          condition: { fieldKey: "opsi_b", equalsValue: "Pagi" },
        },
      ],
      afterSubmitAction: "text",
      afterSubmitConfig: { message: "OK" },
    });
    expect(chained.ok).toBe(false);
    if (!chained.ok) {
      expect(chained.issues.some((i) => i.code === "NESTED_CONDITION_FORBIDDEN")).toBe(true);
    }

    // Self-condition MUST fail
    const selfCond = validateFormDefinition({
      slug: "self-cond",
      name: "Self Condition",
      fields: [
        {
          key: "opsi_a",
          type: "radio",
          label: "Opsi A",
          required: true,
          options: ["Ya", "Tidak"],
          condition: { fieldKey: "opsi_a", equalsValue: "Ya" },
        },
      ],
      afterSubmitAction: "text",
      afterSubmitConfig: { message: "OK" },
    });
    expect(selfCond.ok).toBe(false);
    if (!selfCond.ok) {
      expect(selfCond.issues.some((i) => i.code === "SELF_CONDITION")).toBe(true);
    }
  });

  it("validates 1-level conditional required fields consistently server-side and snapshots labels/types", () => {
    const published = makeValidPublishedForm();

    // Case 1: perlu_survei = "Ya" -> lokasi_survei is visible & REQUIRED -> omitting it MUST fail!
    const missingCond = validateCustomFormSubmission(
      published,
      {
        nama_pic: "Rina Wijaya",
        nama_perusahaan: "PT Nusantara Maju",
        no_whatsapp: "0812-3456-7890",
        kategori_kebutuhan: "Maklon / OEM",
        perlu_survei: "Ya",
        rincian_kebutuhan: "Produksi 1000 pcs kemasan",
        persetujuan_privasi: true,
      },
      { explicitPrivacyConsent: true },
    );
    expect(missingCond.ok).toBe(false);
    if (!missingCond.ok) {
      expect(missingCond.fields.some((f) => f.field === "lokasi_survei" && f.code === "REQUIRED")).toBe(
        true,
      );
    }

    // Case 2: perlu_survei = "Tidak" -> lokasi_survei is hidden -> omitting it MUST pass and NOT appear in snapshot!
    const hiddenCond = validateCustomFormSubmission(
      published,
      {
        nama_pic: "Rina Wijaya",
        nama_perusahaan: "PT Nusantara Maju",
        no_whatsapp: "0812-3456-7890",
        email_kantor: "RINA@NUSANTARA.CO.ID",
        kategori_kebutuhan: "Maklon / OEM",
        estimasi_jumlah: "500",
        perlu_survei: "Tidak",
        lokasi_survei: "Ini harus diabaikan karena tersembunyi",
        rincian_kebutuhan: "Produksi 500 pcs kemasan",
        persetujuan_privasi: true,
      },
      { explicitPrivacyConsent: true },
    );
    expect(hiddenCond.ok).toBe(true);
    if (hiddenCond.ok) {
      expect(hiddenCond.data.snapshot.answers.some((a) => a.key === "lokasi_survei")).toBe(false);
      expect(hiddenCond.data.projectedLead.phoneE164).toBe("6281234567890");
      expect(hiddenCond.data.projectedLead.email).toBe("rina@nusantara.co.id");
      expect(hiddenCond.data.projectedLead.message).toContain("Nama PIC: Rina Wijaya");
      expect(hiddenCond.data.projectedLead.message).toContain("Nama Perusahaan / Instansi: PT Nusantara Maju");
    }

    // Case 2b (Regression): custom consent_checkbox alone MUST NOT bypass mandatory UU PDP privacyConsent!
    const missingMandatoryConsent = validateCustomFormSubmission(
      published,
      {
        nama_pic: "Rina Wijaya",
        nama_perusahaan: "PT Nusantara Maju",
        no_whatsapp: "0812-3456-7890",
        kategori_kebutuhan: "Maklon / OEM",
        perlu_survei: "Tidak",
        rincian_kebutuhan: "Produksi 500 pcs kemasan",
        persetujuan_privasi: true,
      },
      { explicitPrivacyConsent: false },
    );
    expect(missingMandatoryConsent.ok).toBe(false);
    if (!missingMandatoryConsent.ok) {
      expect(
        missingMandatoryConsent.fields.some(
          (f) => f.field === "privacyConsent" && f.code === "PRIVACY_CONSENT_REQUIRED",
        ),
      ).toBe(true);
    }

    // Case 3: perlu_survei = "Ya" WITH lokasi_survei -> succeeds & snapshots label/type
    const visibleCond = validateCustomFormSubmission(
      published,
      {
        nama_pic: "Rina Wijaya",
        nama_perusahaan: "PT Nusantara Maju",
        no_whatsapp: "+62 812 9988 7766",
        kategori_kebutuhan: "Jasa Proyek / Kontraktor",
        perlu_survei: "Ya",
        lokasi_survei: "Cikarang Pusat",
        rincian_kebutuhan: "Renovasi gudang",
        persetujuan_privasi: "on",
      },
      { explicitPrivacyConsent: true },
    );
    expect(visibleCond.ok).toBe(true);
    if (visibleCond.ok) {
      const lokasi = visibleCond.data.snapshot.answers.find((a) => a.key === "lokasi_survei");
      expect(lokasi).toEqual({
        key: "lokasi_survei",
        label: "Kota / Alamat Lokasi Survei",
        type: "short_text",
        value: "Cikarang Pusat",
        displayValue: "Cikarang Pusat",
      });
    }

    // Case 4: invalid calendar date (Feb 30) and unknown answer keys MUST fail
    const bookingTpl = getFormVerticalTemplate("booking_layanan")!;
    const bookingPublished = makeValidPublishedForm({
      slug: bookingTpl.defaultSlug,
      name: bookingTpl.defaultName,
      fields: [...bookingTpl.fields],
    });
    const invalidDate = validateCustomFormSubmission(
      bookingPublished,
      {
        nama_lengkap: "Budi",
        no_whatsapp: "081234567890",
        jenis_layanan: "Konsultasi Awal",
        tanggal_booking: "2026-02-30",
        sesi_waktu: "Pagi (09.00–12.00)",
        persetujuan_privasi: true,
        injected_extra: "nope",
      },
      { explicitPrivacyConsent: true },
    );
    expect(invalidDate.ok).toBe(false);
    if (!invalidDate.ok) {
      expect(invalidDate.fields.some((f) => f.field === "tanggal_booking" && f.code === "INVALID_DATE")).toBe(true);
      expect(invalidDate.fields.some((f) => f.field === "injected_extra" && f.code === "UNKNOWN_FIELD")).toBe(true);
    }
  });

  it("builds single-encoded WhatsApp summary URL and never fabricates phone numbers or unsafe redirects", () => {
    const published = makeValidPublishedForm();
    const submitted = validateCustomFormSubmission(
      published,
      {
        nama_pic: "Rina & Co",
        nama_perusahaan: "PT Nusantara 100%",
        no_whatsapp: "081234567890",
        kategori_kebutuhan: "Maklon / OEM",
        perlu_survei: "Ya",
        lokasi_survei: "Bekasi",
        rincian_kebutuhan: "Estimasi Rp 50.000/unit",
        persetujuan_privasi: true,
      },
      { explicitPrivacyConsent: true },
    );
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const wa = buildCustomFormWhatsAppSummaryUrl({
      formName: published.name,
      answers: submitted.data.snapshot.answers,
      tenantPhone: "0811-2233-4455",
      introText: published.afterSubmitConfig.whatsappIntro,
      pageUrl: "https://alpha.situsku.click/penawaran?utm_source=ig",
    });
    expect(wa).not.toBeNull();
    expect(wa!.phone).toBe("6281122334455");
    expect(wa!.url.startsWith("https://wa.me/6281122334455?text=")).toBe(true);
    // Single-encoding check: decodeURIComponent once yields exact original symbols (`&`, `%`)
    const decoded = decodeURIComponent(wa!.url.split("?text=")[1]!);
    expect(decoded).toContain("- Nama PIC: Rina & Co");
    expect(decoded).toContain("- Nama Perusahaan / Instansi: PT Nusantara 100%");
    expect(decoded).toContain("- Kota / Alamat Lokasi Survei: Bekasi");
    expect(decoded).toContain("https://alpha.situsku.click/penawaran");
    expect(decoded).not.toContain("utm_source");

    // Missing phone -> NEVER fabricates a number; falls back cleanly to "text"
    const noPhone = resolveCustomFormAfterSubmit({
      publishedDef: published,
      snapshot: submitted.data.snapshot,
      tenantPhone: null,
      pageUrl: "https://alpha.situsku.click/penawaran",
    });
    expect(noPhone.action).toBe("text");
    expect(noPhone.whatsappUrl).toBeNull();

    // Redirect URL safety checks
    expect(validateSafeAfterSubmitUrl("https://contoh.co.id/terima-kasih").ok).toBe(true);
    expect(validateSafeAfterSubmitUrl("/terima-kasih").ok).toBe(true);
    expect(validateSafeAfterSubmitUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateSafeAfterSubmitUrl("data:text/html,<script>alert(1)</script>").ok).toBe(false);
    expect(validateSafeAfterSubmitUrl("http://insecure.example.com").ok).toBe(false);
    expect(validateSafeAfterSubmitUrl("//evil.example.com").ok).toBe(false);
    expect(validateSafeAfterSubmitUrl("https://127.0.0.1/admin").ok).toBe(false);
  });

  it("identifies regulated health categories for UU PDP warning and keeps bundled migration 0016 byte-identical", () => {
    expect(isHealthSensitiveBusinessCategory("medical_clinic")).toBe(true);
    expect(isHealthSensitiveBusinessCategory("dentist")).toBe(true);
    expect(isHealthSensitiveBusinessCategory("health_and_beauty")).toBe(true);
    expect(isHealthSensitiveBusinessCategory("MedicalClinic")).toBe(true);
    expect(isHealthSensitiveBusinessCategory("b2b_corporate")).toBe(false);
    expect(isHealthSensitiveBusinessCategory("restaurant")).toBe(false);
    expect(isHealthSensitiveBusinessCategory(null)).toBe(false);

    const diskPath = path.resolve(
      import.meta.dirname,
      "../../packages/db/migrations/tenant/0016_custom_forms_indexes.sql",
    );
    const diskSql = fs.readFileSync(diskPath, "utf8");
    expect(CUSTOM_FORMS_MIGRATION.version).toBe(16);
    expect(CUSTOM_FORMS_MIGRATION_SQL).toBe(diskSql);
  });
});

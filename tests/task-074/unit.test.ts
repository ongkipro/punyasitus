import fs from "node:fs";
import path from "node:path";
import {
  AI_WRITING_OUTPUT_BOUNDS,
  AiWritingProviderError,
  DEFAULT_WORKERS_AI_GATEWAY_ID,
  DEFAULT_WORKERS_AI_MODEL,
  aiWritingSuggestRequestSchema,
  buildAiWritingAuditMetadata,
  buildAiWritingProviderRequest,
  createCloudflareWorkersAiPort,
  detectPiiInSelectedFields,
  extractWorkersAiTextAndTokens,
  findForbiddenAiWritingKey,
  formatPiiBlockedMessageId,
  minimizeAiWritingFields,
  sanitizeAiOutputText,
  scanTextForPii,
  type WorkersAiBindingLike,
} from "@punyasitus/core/ai-writing/index";
import { PLATFORM_0029_AI_WRITING_USAGE_SQL } from "@punyasitus/db/ai-usage/index";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-074 unit checks — PII blocker, field minimization, Workers AI port & zero-prompt telemetry", () => {
  it("keeps bundled 0029_ai_writing_usage SQL byte-for-byte identical to migration file on disk", () => {
    const sqlOnDisk = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/platform/0029_ai_writing_usage.sql"),
      "utf8",
    );
    expect(PLATFORM_0029_AI_WRITING_USAGE_SQL).toBe(sqlOnDisk);
  });

  it("detects email addresses across common formats without leaking raw email values", () => {
    const cases = [
      "Hubungi admin@tokomaju.id untuk info lebih lanjut.",
      "Email resmi kami: budi.santoso+sales@perusahaan.co.id.",
      "Kirim penawaran ke CS_Tim-01@sub.domain.com sekarang.",
      "hubungi kami...info@toko.id",
      "kontak---sales@perusahaan.co.id",
    ];
    for (const sample of cases) {
      const counts = scanTextForPii(sample);
      expect(counts.email, `Expected email detected in: ${sample}`).toBeGreaterThanOrEqual(1);

      const check = detectPiiInSelectedFields({ currentText: sample });
      expect(check.blocked).toBe(true);
      expect(check.detectedKinds).toContain("email");
      const msg = formatPiiBlockedMessageId(check.detectedKinds);
      expect(msg).not.toContain("@");
      expect(JSON.stringify(check)).not.toContain("@");
    }
  });

  it("detects Indonesian mobile/landline, international phone formats, and WhatsApp links", () => {
    const phones = [
      "Hubungi 081234567890 sekarang",
      "WA kami di 0812-3456-7890",
      "Kontak +62 812-3456-7890 atau +628112233445",
      "Nomor internasional (+62) 812 3456 7890 dan (+62)812-3456-7890",
      "Nomor WA 6281398765432",
      "Glued labels WA08123456789",
      "Glued phone Tel08123456789",
      "Glued mobile HP08123456789",
      "Trailing letter 08123456789a",
      "Hubungi 10 08123456789",
      "Harga 150.000 081234567890",
      "Tahun 2018 0812-3456-7890",
      "Kantor Jakarta (021) 555-1234",
      "Telepon Bandung 022-4201234",
      "Cabang Bali 0361-123456",
      "Singapore office +65 9123 4567",
      "US helpline +1 (555) 123-4567",
      "International dial 0062 812 3456 7890",
      "Chat cepat https://wa.me/628123456789",
    ];

    for (const sample of phones) {
      const counts = scanTextForPii(sample);
      expect(counts.phone, `Expected phone detected in: ${sample}`).toBeGreaterThanOrEqual(1);

      const check = detectPiiInSelectedFields({ currentText: sample });
      expect(check.blocked).toBe(true);
      expect(check.detectedKinds).toContain("phone");
      expect(JSON.stringify(check)).not.toContain("812");
      expect(JSON.stringify(check)).not.toContain("555");
    }
  });

  it("detects Indonesian NIK (16-digit) and formatted NPWP identifiers", () => {
    const ids = [
      "Data pemohon 3171051205900001 terdaftar",
      "NIK: 3201016508950002",
      "No. KTP 1234567890123456",
      "NPWP perusahaan 12.345.678.9-012.345",
      "NPWP 123456789012345",
      "NPWP: 123456789012345",
    ];
    for (const sample of ids) {
      const counts = scanTextForPii(sample);
      expect(counts.nik, `Expected NIK/NPWP detected in: ${sample}`).toBeGreaterThanOrEqual(1);
      const check = detectPiiInSelectedFields({ summary: sample });
      expect(check.blocked).toBe(true);
      expect(check.detectedKinds).toContain("nik");
      expect(JSON.stringify(check)).not.toContain("317105");
    }
  });

  it("avoids false positives on normal Indonesian business copy, IDR prices, hours, and dates", () => {
    const cleanCopy = [
      "Paket renovasi kantor mulai Rp 179.000 per meter persegi hingga Rp 12.500.000.",
      "Harga tahunan IDR 1.790.000 hemat 2 bulan untuk semua fitur.",
      "Jam operasional Senin–Jumat 08.00 - 17.00 WIB, Sabtu 09.00-14.00.",
      "Berdiri sejak 2018, melayani 10-50 perusahaan di Jakarta dan Surabaya.",
      "Jarak tempuh kendaraan bekas 150.000 km, rilis 2026-11-23, SK PPIU 123/2025.",
      "Kode referensi katalog a1b2081234567890cdef1234 dan sku9908123456789012.",
    ];
    for (const sample of cleanCopy) {
      const check = detectPiiInSelectedFields({ currentText: sample });
      expect(check.blocked, `Unexpected PII false positive in: ${sample}`).toBe(false);
    }
  });

  it("runs in strictly linear O(n) time on large adversarial inputs (zero ReDoS)", () => {
    const adversarialEmail = `${"a".repeat(25_000)}@${"b.".repeat(5_000)}invalid`;
    const adversarialPhone = `${"0812-".repeat(8_000)}x`;
    const adversarialParens = `${"(".repeat(20_000)}021${")".repeat(20_000)}`;

    const start = performance.now();
    scanTextForPii(adversarialEmail);
    scanTextForPii(adversarialPhone);
    scanTextForPii(adversarialParens);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(150);
  });

  it("enforces strict field selection, rejects leads/account keys, and minimizes provider payload", () => {
    expect(findForbiddenAiWritingKey({ leads: [{ name: "Budi" }] })).toBe("leads");
    expect(findForbiddenAiWritingKey({ fields: { email: "a@b.id" } })).toBe("fields.email");
    expect(findForbiddenAiWritingKey({ tenantId: "01ABC" })).toBe("tenantId");

    // Rejects control-character-only inputs that normalize to empty
    const controlOnlyErr = aiWritingSuggestRequestSchema.safeParse({
      fieldKind: "title",
      selectedFields: ["currentText"],
      fields: {
        currentText: "\u0000\u0007\u001b\u007f",
      },
    });
    expect(controlOnlyErr.success).toBe(false);

    // Rejects supplying unselected fields
    const unselectedErr = aiWritingSuggestRequestSchema.safeParse({
      fieldKind: "title",
      selectedFields: ["title"],
      fields: {
        title: "Jasa Arsitek",
        summary: "Unselected secret context",
      },
    });
    expect(unselectedErr.success).toBe(false);

    // Valid minimized payload includes ONLY selected fields + authoritative vertical
    const minimized = minimizeAiWritingFields(
      {
        fieldKind: "offering_description",
        selectedFields: ["title", "category"],
        fields: {
          title: "Renovasi Kantor Modern",
          category: "Arsitektur",
          summary: "MUST_BE_DROPPED_UNSELECTED",
        },
        tone: "profesional",
      },
      "compro",
    );

    expect(minimized.vertical).toBe("compro");
    expect(minimized.selectedFieldKeys).toEqual(["title", "category"]);
    expect(minimized.selectedFields).toEqual({
      title: "Renovasi Kantor Modern",
      category: "Arsitektur",
    });
    expect("summary" in minimized.selectedFields).toBe(false);

    const providerReq = buildAiWritingProviderRequest(minimized);
    expect(providerReq.userPrompt).toContain("Renovasi Kantor Modern");
    expect(providerReq.userPrompt).toContain("Arsitektur");
    expect(providerReq.userPrompt).not.toContain("MUST_BE_DROPPED_UNSELECTED");
    expect(providerReq.gatewayId).toBe(DEFAULT_WORKERS_AI_GATEWAY_ID);
  });

  it("sanitizes HTML/markdown from AI output and enforces field-kind length caps", () => {
    const rawHtml = '```html\n"<h1>Jasa Renovasi <b>Kantor</b> Modern Jakarta</h1>"\n```';
    const titleOut = sanitizeAiOutputText(rawHtml, "title");
    expect(titleOut).not.toContain("<");
    expect(titleOut).not.toContain("```");
    expect(titleOut).toBe("Jasa Renovasi Kantor Modern Jakarta");

    const overlongMeta = "Renovasi kantor profesional di Jakarta ".repeat(15);
    const metaOut = sanitizeAiOutputText(overlongMeta, "meta_description");
    expect(metaOut.length).toBeLessThanOrEqual(AI_WRITING_OUTPUT_BOUNDS.meta_description.maxChars);
    expect(metaOut.includes("\n")).toBe(false);
  });

  it("routes Workers AI adapter through AI Gateway, parses response shapes, and handles errors/timeouts cleanly", async () => {
    expect(extractWorkersAiTextAndTokens({ response: "Halo dunia", usage: { total_tokens: 42 } })).toEqual({
      text: "Halo dunia",
      tokenCount: 42,
    });
    expect(
      extractWorkersAiTextAndTokens({
        choices: [{ message: { content: "Judul bagus" } }],
        usage: { prompt_tokens: 15, completion_tokens: 10 },
      }),
    ).toEqual({
      text: "Judul bagus",
      tokenCount: 25,
    });

    const calls: Array<{ model: string; inputs: unknown; options: unknown }> = [];
    const mockAi: WorkersAiBindingLike = {
      async run(model, inputs, options) {
        calls.push({ model, inputs, options });
        return {
          response: "Jasa Renovasi Kantor Modern Profesional di Jakarta",
          usage: { total_tokens: 68 },
        };
      },
    };

    const port = createCloudflareWorkersAiPort({ ai: mockAi });
    const req = buildAiWritingProviderRequest(
      minimizeAiWritingFields(
        {
          fieldKind: "title",
          selectedFields: ["currentText"],
          fields: { currentText: "renovasi kantor jakarta" },
          tone: "profesional",
        },
        "compro",
      ),
    );
    const res = await port.generateSuggestion(req);
    expect(res.suggestion).toBe("Jasa Renovasi Kantor Modern Profesional di Jakarta");
    expect(res.model).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(res.tokenCount).toBe(68);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({
      gateway: {
        id: DEFAULT_WORKERS_AI_GATEWAY_ID,
        skipCache: true,
      },
    });

    // Provider error never leaks prompt text
    const failingPort = createCloudflareWorkersAiPort({
      ai: {
        async run() {
          throw new Error("Upstream failed on prompt SECRET_PROMPT_TEXT");
        },
      },
    });
    await expect(failingPort.generateSuggestion(req)).rejects.toMatchObject({
      code: "AI_PROVIDER_ERROR",
      status: 502,
    });
    try {
      await failingPort.generateSuggestion(req);
    } catch (err) {
      expect(err).toBeInstanceOf(AiWritingProviderError);
      expect((err as Error).message).not.toContain("SECRET_PROMPT_TEXT");
    }

    // Timeout produces 504 AI_PROVIDER_TIMEOUT
    const slowPort = createCloudflareWorkersAiPort({
      ai: {
        run() {
          return new Promise(() => {
            // never resolves
          });
        },
      },
      timeoutMs: 25,
    });
    await expect(slowPort.generateSuggestion(req)).rejects.toMatchObject({
      code: "AI_PROVIDER_TIMEOUT",
      status: 504,
    });
  });

  it("strips prompt/suggestion/PII fields from audit metadata (zero prompt logging)", () => {
    const meta = buildAiWritingAuditMetadata({
      fieldKind: "excerpt",
      vertical: "travel",
      tone: "ramah",
      selectedFieldKeys: ["title", "currentText"],
      status: "succeeded",
      model: DEFAULT_WORKERS_AI_MODEL,
      tokenCount: 120,
      latencyMs: 340,
      quotaUsed: 5,
      quotaLimit: 100,
      quotaRemaining: 95,
      prompt: "SECRET_PROMPT_SHOULD_NOT_APPEAR",
      suggestion: "SECRET_SUGGESTION_SHOULD_NOT_APPEAR",
      email: "leak@example.com",
    });

    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("SECRET_PROMPT_SHOULD_NOT_APPEAR");
    expect(serialized).not.toContain("SECRET_SUGGESTION_SHOULD_NOT_APPEAR");
    expect(serialized).not.toContain("leak@example.com");
    expect(meta.selectedFieldKeys).toEqual(["title", "currentText"]);
    expect(meta.tokenCount).toBe(120);
  });
});

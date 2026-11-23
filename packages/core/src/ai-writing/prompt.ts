import {
  AI_WRITING_OUTPUT_BOUNDS,
  AI_WRITING_VERTICAL_LABELS,
  DEFAULT_WORKERS_AI_GATEWAY_ID,
  type AiWritingMinimizedInput,
  type AiWritingProviderRequest,
} from "./types.ts";

/**
 * Deterministic Bahasa Indonesia prompt builder for AI Writing Suggestions
 * (REQ-075, PLAN §18.4, DEC-046).
 *
 * Security & privacy invariant:
 * Accepts ONLY `AiWritingMinimizedInput` (selected editorial fields + tenant vertical + tone).
 * Never injects tenant identifiers, user accounts, visitor leads, or contact info.
 */

const TONE_GUIDANCE_ID: Readonly<Record<AiWritingMinimizedInput["tone"], string>> = {
  profesional: "Gunakan bahasa Indonesia yang profesional, jelas, terpercaya, dan tidak berlebihan.",
  ramah: "Gunakan bahasa Indonesia yang ramah, hangat, sopan, dan mudah dipahami pelanggan.",
  ringkas: "Gunakan bahasa Indonesia yang padat, langsung ke inti, dan mudah dipindai.",
  persuasif:
    "Gunakan bahasa Indonesia yang meyakinkan berbasis manfaat nyata tanpa klaim palsu atau urgensi buatan.",
};

const FIELD_INSTRUCTIONS_ID: Readonly<Record<AiWritingMinimizedInput["fieldKind"], string>> = {
  title:
    "Buatkan 1 draf judul halaman/konten dalam bahasa Indonesia. Kembalikan hanya satu baris teks polos tanpa tanda kutip, tanpa HTML, dan maksimal 120 karakter.",
  excerpt:
    "Buatkan 1 draf ringkasan singkat (1-2 kalimat) dalam bahasa Indonesia. Kembalikan teks polos tanpa HTML dan maksimal 300 karakter.",
  offering_description:
    "Buatkan 1 draf deskripsi produk/layanan dalam bahasa Indonesia (1-3 paragraf teks polos yang rapi). Jelaskan manfaat dan cakupan layanan berdasarkan info yang diberikan tanpa mengarang harga, jadwal, atau izin resmi. Maksimal 1500 karakter.",
  meta_description:
    "Buatkan 1 draf deskripsi meta SEO dalam bahasa Indonesia yang informatif untuk hasil pencarian. Kembalikan satu baris teks polos tanpa HTML dan maksimal 160 karakter.",
};

export function buildAiWritingProviderRequest(
  minimized: AiWritingMinimizedInput,
  options: { readonly gatewayId?: string } = {},
): AiWritingProviderRequest {
  const bounds = AI_WRITING_OUTPUT_BOUNDS[minimized.fieldKind];
  const verticalLabel = AI_WRITING_VERTICAL_LABELS[minimized.vertical];

  const systemPrompt = [
    "Anda adalah asisten penulisan editorial bahasa Indonesia untuk pemilik bisnis kecil dan menengah (B2B/UMKM).",
    `Jenis usaha: ${verticalLabel} (${minimized.vertical}).`,
    FIELD_INSTRUCTIONS_ID[minimized.fieldKind],
    TONE_GUIDANCE_ID[minimized.tone],
    "Aturan wajib:",
    "- Tulis hanya teks polos bahasa Indonesia (dilarang HTML, Markdown, atau penjelasan tambahan).",
    "- Jangan pernah mengarang harga, diskon, testimoni, kuota palsu, nomor telepon, alamat email, atau nomor izin resmi (NIB, SK PPIU, SIP/STR, Halal).",
    "- Hanya gunakan fakta yang tercantum pada konteks terpilih di bawah.",
  ].join("\n");

  const contextLines: string[] = [
    `Target field: ${bounds.labelId} (${minimized.fieldKind})`,
    `Jenis usaha: ${verticalLabel}`,
    `Gaya bahasa: ${minimized.tone}`,
  ];

  const f = minimized.selectedFields;
  if (f.category) {
    contextLines.push(`Kategori: ${f.category}`);
  }
  if (f.title) {
    contextLines.push(`Judul referensi: ${f.title}`);
  }
  if (f.currentText) {
    contextLines.push(`Teks saat ini:\n${f.currentText}`);
  }
  if (f.summary) {
    contextLines.push(`Ringkasan/catatan referensi:\n${f.summary}`);
  }
  if (f.keyPoints && f.keyPoints.length > 0) {
    contextLines.push(`Poin utama:\n${f.keyPoints.map((pt) => `- ${pt}`).join("\n")}`);
  }

  return {
    fieldKind: minimized.fieldKind,
    vertical: minimized.vertical,
    tone: minimized.tone,
    selectedFieldKeys: minimized.selectedFieldKeys,
    selectedFields: minimized.selectedFields,
    systemPrompt,
    userPrompt: contextLines.join("\n\n"),
    maxOutputChars: bounds.maxChars,
    maxTokens: bounds.maxTokens,
    gatewayId: options.gatewayId?.trim() || DEFAULT_WORKERS_AI_GATEWAY_ID,
  };
}

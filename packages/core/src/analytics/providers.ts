/**
 * Direct Analytics Provider Contracts, Strict ID Validation, and Event Mapping Table
 * (`packages/core/src/analytics/providers.ts`; TASK-022, REQ-027, REQ-017, REQ-033, REQ-039).
 *
 * Scope boundary:
 * - Supports ONLY direct GA4 (`G-*`), Meta Pixel (`10-20` digits), and TikTok Pixel (`10-32` uppercase alphanumeric).
 * - Tenant Google Tag Manager (`GTM-*`) is intentionally rejected here and owned by `TASK-076`
 *   (which adds owner-only audited risk acknowledgement and Consent Mode defaults).
 * - Arbitrary `<script>` tags, inline JavaScript snippets, and non-matching identifiers are rejected with `422 VALIDATION_ERROR`.
 */

export const DIRECT_ANALYTICS_PROVIDERS = ["ga4", "meta", "tiktok"] as const;
export type DirectAnalyticsProvider = (typeof DIRECT_ANALYTICS_PROVIDERS)[number];

export type AnalyticsConsentCategory = "analytics" | "marketing";

export const GA4_MEASUREMENT_ID_RE = /^G-[A-Z0-9]{6,16}$/;
export const META_PIXEL_ID_RE = /^[0-9]{10,20}$/;
export const TIKTOK_PIXEL_ID_RE = /^[A-Z0-9]{10,32}$/;

const GTM_CONTAINER_ID_RE = /^GTM-[A-Z0-9_-]+$/i;
const SCRIPT_OR_JS_INJECTION_RE =
  /(<\s*\/?\s*script\b|<\s*\/?\s*[a-z]+[^>]*>|javascript:|data:|vbscript:|on[a-z]+\s*=|[;{}()`]|\r|\n|\0)/i;

export const DIRECT_ANALYTICS_CONFIG_KEYS = [
  "ga4MeasurementId",
  "metaPixelId",
  "tiktokPixelId",
] as const;

export type DirectAnalyticsConfigKey = (typeof DIRECT_ANALYTICS_CONFIG_KEYS)[number];

export interface DirectAnalyticsConfig {
  readonly ga4MeasurementId: string | null;
  readonly metaPixelId: string | null;
  readonly tiktokPixelId: string | null;
}

export interface AnalyticsValidationField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export type DirectAnalyticsValidationResult =
  | {
      readonly ok: true;
      readonly config: DirectAnalyticsConfig;
      /** Contains ONLY the keys explicitly present in the input payload (supports partial PATCH). */
      readonly patch: Partial<DirectAnalyticsConfig>;
    }
  | {
      readonly ok: false;
      readonly code: "VALIDATION_ERROR";
      readonly message: string;
      readonly fields: readonly AnalyticsValidationField[];
    };

export interface AnalyticsProviderDescriptor {
  readonly id: DirectAnalyticsProvider;
  readonly configKey: DirectAnalyticsConfigKey;
  readonly label: string;
  readonly consentCategory: AnalyticsConsentCategory;
  readonly formatHintId: string;
  readonly exampleId: string;
  readonly buildProductionScriptUrl: (validatedId: string) => string;
}

export const ANALYTICS_PROVIDER_DESCRIPTORS: Readonly<
  Record<DirectAnalyticsProvider, AnalyticsProviderDescriptor>
> = {
  ga4: {
    id: "ga4",
    configKey: "ga4MeasurementId",
    label: "Google Analytics 4 (GA4)",
    consentCategory: "analytics",
    formatHintId: "Format: G- diikuti 6–16 huruf kapital atau angka (contoh: G-AB12CD34EF).",
    exampleId: "G-AB12CD34EF",
    buildProductionScriptUrl: (id) =>
      `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`,
  },
  meta: {
    id: "meta",
    configKey: "metaPixelId",
    label: "Meta Pixel",
    consentCategory: "marketing",
    formatHintId: "Format: 10–20 digit angka tanpa spasi (contoh: 123456789012345).",
    exampleId: "123456789012345",
    buildProductionScriptUrl: () => "https://connect.facebook.net/en_US/fbevents.js",
  },
  tiktok: {
    id: "tiktok",
    configKey: "tiktokPixelId",
    label: "TikTok Pixel",
    consentCategory: "marketing",
    formatHintId: "Format: 10–32 huruf kapital atau angka (contoh: C1234567890ABCDEF).",
    exampleId: "C1234567890ABCDEF",
    buildProductionScriptUrl: (id) =>
      `https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(id)}&lib=ttq`,
  },
};

/**
 * Canonical PunyaSitus client-side analytics signal names (PLAN §7.3, REQ-027, REQ-033).
 *
 * Note: `wa_click` (used in first-party `/api/events`) is normalized to `whatsapp_click`
 * by the dispatcher so both names map consistently across providers.
 */
export const CANONICAL_SIGNAL_EVENTS = [
  "page_view",
  "whatsapp_click",
  "external_click",
  "lead_submitted",
  "view_item",
] as const;

export type CanonicalSignalEvent = (typeof CANONICAL_SIGNAL_EVENTS)[number];
export type SignalEventAlias = CanonicalSignalEvent | "wa_click";

export interface ProviderEventMappingRow {
  readonly canonicalEvent: CanonicalSignalEvent;
  readonly labelId: string;
  readonly triggerRuleId: string;
  readonly providers: Readonly<{
    readonly ga4: { readonly eventName: string; readonly consentCategory: "analytics" };
    readonly meta: { readonly eventName: string; readonly consentCategory: "marketing" };
    readonly tiktok: {
      readonly eventName: string;
      readonly method: "page" | "track";
      readonly consentCategory: "marketing";
    };
  }>;
  readonly piiPolicyId: string;
}

/**
 * Explicit, documented provider-specific event mappings for direct GA4, Meta Pixel,
 * and TikTok Pixel (TASK-022 / REQ-027 / REQ-033).
 *
 * Invariants:
 * - Clicks (`whatsapp_click`, `external_click`) are interest signals, never confirmed sales.
 * - `lead_submitted` fires at most ONCE per persisted `leadId` ONLY AFTER `POST /api/leads`
 *   confirms durable persistence (never on button click, validation failure, 429, or 503).
 * - ZERO visitor PII (email, phone, full name, message, raw query strings) is ever forwarded.
 */
export const ANALYTICS_PROVIDER_EVENT_MAPPINGS: Readonly<
  Record<CanonicalSignalEvent, ProviderEventMappingRow>
> = {
  page_view: {
    canonicalEvent: "page_view",
    labelId: "Kunjungan Halaman",
    triggerRuleId: "Dikirim saat pengunjung memberi izin analitik/pemasaran pada halaman publik.",
    providers: {
      ga4: { eventName: "page_view", consentCategory: "analytics" },
      meta: { eventName: "PageView", consentCategory: "marketing" },
      tiktok: { eventName: "PageView", method: "page", consentCategory: "marketing" },
    },
    piiPolicyId: "Hanya mengirim path halaman tanpa query string, tanpa email/telepon.",
  },
  whatsapp_click: {
    canonicalEvent: "whatsapp_click",
    labelId: "Klik CTA WhatsApp",
    triggerRuleId: "Dikirim non-blocking saat tautan WhatsApp diklik; navigasi tetap berjalan walau pelacak gagal.",
    providers: {
      ga4: { eventName: "whatsapp_click", consentCategory: "analytics" },
      meta: { eventName: "Contact", consentCategory: "marketing" },
      tiktok: { eventName: "Contact", method: "track", consentCategory: "marketing" },
    },
    piiPolicyId: "Tanpa nomor telepon pengunjung atau isi pesan WhatsApp.",
  },
  external_click: {
    canonicalEvent: "external_click",
    labelId: "Klik Tautan Eksternal",
    triggerRuleId: "Dikirim non-blocking saat tombol tautan eksternal/marketplace diklik.",
    providers: {
      ga4: { eventName: "external_click", consentCategory: "analytics" },
      meta: { eventName: "ViewContent", consentCategory: "marketing" },
      tiktok: { eventName: "ClickButton", method: "track", consentCategory: "marketing" },
    },
    piiPolicyId: "Hanya mengirim path halaman & kategori konten tanpa query parameter.",
  },
  lead_submitted: {
    canonicalEvent: "lead_submitted",
    labelId: "Prospek Tersimpan",
    triggerRuleId: "Dikirim tepat SATU KALI per leadId hanya SETELAH POST /api/leads mengonfirmasi penyimpanan.",
    providers: {
      ga4: { eventName: "generate_lead", consentCategory: "analytics" },
      meta: { eventName: "Lead", consentCategory: "marketing" },
      tiktok: { eventName: "SubmitForm", method: "track", consentCategory: "marketing" },
    },
    piiPolicyId: "Dilarang mengirim nama, email, nomor WhatsApp, atau isi pesan formulir ke piksel pihak ketiga.",
  },
  view_item: {
    canonicalEvent: "view_item",
    labelId: "Lihat Detail Penawaran",
    triggerRuleId: "Dikirim pada halaman detail layanan, produk, paket tur, atau kendaraan setelah izin aktif.",
    providers: {
      ga4: { eventName: "view_item", consentCategory: "analytics" },
      meta: { eventName: "ViewContent", consentCategory: "marketing" },
      tiktok: { eventName: "ViewContent", method: "track", consentCategory: "marketing" },
    },
    piiPolicyId: "Hanya mengirim jenis penawaran, kategori non-PII, dan mata uang/harga publik bila ada.",
  },
};

export function createEmptyDirectAnalyticsConfig(): DirectAnalyticsConfig {
  return {
    ga4MeasurementId: null,
    metaPixelId: null,
    tiktokPixelId: null,
  };
}

export function normalizeCanonicalSignalEvent(name: string): CanonicalSignalEvent | null {
  if (name === "wa_click") return "whatsapp_click";
  if (
    name === "page_view" ||
    name === "whatsapp_click" ||
    name === "external_click" ||
    name === "lead_submitted" ||
    name === "view_item"
  ) {
    return name;
  }
  return null;
}

export function isValidProviderId(provider: DirectAnalyticsProvider, id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (SCRIPT_OR_JS_INJECTION_RE.test(id)) return false;
  if (GTM_CONTAINER_ID_RE.test(id)) return false;
  switch (provider) {
    case "ga4":
      return GA4_MEASUREMENT_ID_RE.test(id);
    case "meta":
      return META_PIXEL_ID_RE.test(id);
    case "tiktok":
      return TIKTOK_PIXEL_ID_RE.test(id);
  }
}

function validateSingleProviderField(
  provider: DirectAnalyticsProvider,
  raw: unknown,
  fields: AnalyticsValidationField[],
): string | null {
  const descriptor = ANALYTICS_PROVIDER_DESCRIPTORS[provider];
  const field = descriptor.configKey;

  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== "string") {
    fields.push({
      field,
      code: "INVALID_TYPE",
      message: `${descriptor.label} ID harus berupa teks atau kosong.`,
    });
    return null;
  }

  // Empty or whitespace-only clears the setting
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Reject raw HTML, <script> tags, JS snippets, or control characters explicitly
  if (SCRIPT_OR_JS_INJECTION_RE.test(raw)) {
    fields.push({
      field,
      code: "FORBIDDEN_SCRIPT_SNIPPET",
      message: `${descriptor.label} hanya menerima ID pelacak yang valid; tag <script> atau kode JavaScript ditolak.`,
    });
    return null;
  }

  // Reject GTM IDs explicitly (GTM is handled separately in TASK-076 with owner risk acknowledgement)
  if (GTM_CONTAINER_ID_RE.test(trimmed)) {
    fields.push({
      field,
      code: "GTM_NOT_ALLOWED_HERE",
      message:
        "Google Tag Manager (GTM-*) tidak diatur di formulir pelacak langsung ini. Pengaturan GTM tersedia terpisah dengan persetujuan risiko khusus pemilik situs.",
    });
    return null;
  }

  if (!isValidProviderId(provider, trimmed)) {
    fields.push({
      field,
      code: "INVALID_ANALYTICS_ID",
      message: `ID ${descriptor.label} tidak valid. ${descriptor.formatHintId}`,
    });
    return null;
  }

  return trimmed;
}

/**
 * Strictly validates direct analytics settings input (`ga4MeasurementId`, `metaPixelId`, `tiktokPixelId`).
 * Rejects GTM container IDs (`gtmContainerId` / `GTM-*`), raw `<script>` tags, JS snippets,
 * unknown fields, and malformed IDs with `422 VALIDATION_ERROR`.
 */
export function validateDirectAnalyticsInput(input: unknown): DirectAnalyticsValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Payload konfigurasi analitik harus berupa objek JSON.",
      fields: [
        {
          field: "body",
          code: "INVALID_PAYLOAD",
          message: "Expected an object with direct analytics provider IDs.",
        },
      ],
    };
  }

  const record = input as Record<string, unknown>;
  const fields: AnalyticsValidationField[] = [];
  const allowed = new Set<string>(DIRECT_ANALYTICS_CONFIG_KEYS);

  for (const key of Object.keys(record)) {
    if (key === "gtmContainerId" || key === "gtmId" || key === "gtm") {
      fields.push({
        field: key,
        code: "GTM_NOT_ALLOWED_HERE",
        message:
          "Google Tag Manager (GTM) tidak diizinkan pada pengaturan analitik langsung ini dan dikelola terpisah dengan persetujuan risiko pemilik situs.",
      });
      continue;
    }
    if (!allowed.has(key)) {
      fields.push({
        field: key,
        code: "UNKNOWN_FIELD",
        message: `Field "${key}" tidak diizinkan dalam pengaturan analitik langsung.`,
      });
    }
  }

  const hasGa4 = Object.prototype.hasOwnProperty.call(record, "ga4MeasurementId");
  const hasMeta = Object.prototype.hasOwnProperty.call(record, "metaPixelId");
  const hasTiktok = Object.prototype.hasOwnProperty.call(record, "tiktokPixelId");

  const ga4MeasurementId = validateSingleProviderField("ga4", record.ga4MeasurementId, fields);
  const metaPixelId = validateSingleProviderField("meta", record.metaPixelId, fields);
  const tiktokPixelId = validateSingleProviderField("tiktok", record.tiktokPixelId, fields);

  if (fields.length > 0) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message:
        fields[0]?.message ??
        "Konfigurasi ID analitik tidak valid. Periksa format GA4, Meta Pixel, atau TikTok Pixel.",
      fields,
    };
  }

  const patch: {
    ga4MeasurementId?: string | null;
    metaPixelId?: string | null;
    tiktokPixelId?: string | null;
  } = {};
  if (hasGa4) patch.ga4MeasurementId = ga4MeasurementId;
  if (hasMeta) patch.metaPixelId = metaPixelId;
  if (hasTiktok) patch.tiktokPixelId = tiktokPixelId;

  return {
    ok: true,
    config: {
      ga4MeasurementId,
      metaPixelId,
      tiktokPixelId,
    },
    patch,
  };
}

/**
 * Safely extracts ONLY validated direct GA4/Meta/TikTok IDs from an untrusted/stored object
 * (such as `site_settings.analytics_config_json`), silently ignoring any invalid or non-direct keys
 * (including any GTM container ID) so malformed/untrusted data can never be rendered into public HTML.
 */
export function parseStoredDirectAnalyticsConfig(raw: unknown): DirectAnalyticsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createEmptyDirectAnalyticsConfig();
  }
  const rec = raw as Record<string, unknown>;
  return {
    ga4MeasurementId: isValidProviderId("ga4", rec.ga4MeasurementId)
      ? rec.ga4MeasurementId
      : null,
    metaPixelId: isValidProviderId("meta", rec.metaPixelId) ? rec.metaPixelId : null,
    tiktokPixelId: isValidProviderId("tiktok", rec.tiktokPixelId) ? rec.tiktokPixelId : null,
  };
}

export function hasAnyConfiguredDirectProvider(config: DirectAnalyticsConfig): boolean {
  return Boolean(config.ga4MeasurementId || config.metaPixelId || config.tiktokPixelId);
}

export function getProviderIdFromConfig(
  config: DirectAnalyticsConfig,
  provider: DirectAnalyticsProvider,
): string | null {
  switch (provider) {
    case "ga4":
      return isValidProviderId("ga4", config.ga4MeasurementId) ? config.ga4MeasurementId : null;
    case "meta":
      return isValidProviderId("meta", config.metaPixelId) ? config.metaPixelId : null;
    case "tiktok":
      return isValidProviderId("tiktok", config.tiktokPixelId) ? config.tiktokPixelId : null;
  }
}

export type ProviderScriptOverrides = Readonly<Partial<Record<DirectAnalyticsProvider, string>>>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Validates an explicit test-harness vendor script override URL.
 * Rejects protocol-relative `//` URLs, non-HTTPS remote origins, credentials, and whitespace.
 * Allows ONLY:
 * - Single-slash root-relative paths (`/mock/...`)
 * - Explicit `https://` URLs without embedded credentials
 * - Explicit loopback `http://127.0.0.1` / `http://localhost` URLs for local test harnesses
 */
export function isSafeTestScriptOverrideUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return false;
  if (/[\s\r\n]/.test(trimmed)) return false;
  // Strictly reject protocol-relative URLs like `//evil.com/script.js`
  if (trimmed.startsWith("//")) return false;

  if (trimmed.startsWith("/")) {
    return /^\/(?!\/)[^\s]+$/.test(trimmed);
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.username !== "" || parsed.password !== "") {
      return false;
    }
    if (parsed.protocol === "https:") {
      return true;
    }
    if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Builds the vendor script URL for a validated provider ID.
 * Supports explicit `testScriptOverrides` ONLY when injected programmatically by a test harness
 * (never from untrusted URL query parameters in production).
 */
export function buildProviderScriptUrl(
  provider: DirectAnalyticsProvider,
  id: string,
  testScriptOverrides?: ProviderScriptOverrides,
): string | null {
  if (!isValidProviderId(provider, id)) {
    return null;
  }

  const override = testScriptOverrides?.[provider];
  if (override !== undefined) {
    if (!isSafeTestScriptOverrideUrl(override)) {
      return null;
    }
    const trimmed = override.trim();
    const sep = trimmed.includes("?") ? "&" : "?";
    return `${trimmed}${sep}id=${encodeURIComponent(id)}`;
  }

  return ANALYTICS_PROVIDER_DESCRIPTORS[provider].buildProductionScriptUrl(id);
}

import {
  AUTOLARIS_COD_VALUE,
  AUTOLARIS_DEFAULT_ACCOUNT_ID,
  AUTOLARIS_DIGITAL_COURIR_ID,
  AUTOLARIS_REFF_ID_MAX_LENGTH,
  BillingProviderError,
  BillingValidationError,
  DEFAULT_MONTHLY_PRICE_IDR,
  MIN_AUTOLARIS_CHARGE_IDR,
  MAX_IDR_AMOUNT,
  assertExactIdrInteger,
  classifyAllowedChannel,
  filterAllowedAutoLarisChannels,
  validateProviderCosts,
  type RawAutoLarisPaymentChannel,
  type ValidatedPaymentChannel,
} from "@punyasitus/core/billing/index";
import type {
  AutoLarisBillingClient,
  AutoLarisDigitalProfileConfig,
  AutoLarisRelayConfig,
  SubmitDigitalOrderInput,
  ValidatedAutoLarisSubmitResult,
} from "./types.ts";

/**
 * AutoLaris H2H static-IP relay client for PunyaSitus platform subscription billing
 * (PLAN §16.1, §16.2, §16.4; REQ-056).
 *
 * Hard invariants:
 * - Strictly targets ONLY the configured HTTPS static-IP relay URL (SSRF-hardened).
 * - Exposes ONLY `GET /api/h2h/list_payment` and `POST /api/h2h/submit` (`courir_id: 1`, `cod_value: "0"`).
 * - NEVER calls `/api/h2h/create_payment` or any shipping endpoint (`/ongkir`, `/order`, `/lacak`, `/cancel`, `/pickup`).
 * - Runtime QRIS and Bank Virtual Account ONLY channel validation.
 * - Never leaks API keys or Authorization headers in logs, return values, or error messages.
 * - Strictly separates definite provider refusals from uncertain timeouts/5xx (`creation_unknown`)
 *   and suspicious `rc: "00"` payload/fee anomalies (`review`).
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

const PERMITTED_AUTOLARIS_PATHS = new Set<string>([
  "/api/h2h/list_payment",
  "/api/h2h/submit",
]);

const DEFAULT_ALLOWED_REDIRECT_SUFFIXES: readonly string[] = [
  "autolaris.com",
];

const DEFAULT_DIGITAL_PROFILE: AutoLarisDigitalProfileConfig = {
  originAreaId: 3173060,
  destinationAreaId: 3173060,
  shipperName: "PunyaSitus Platform",
  shipperPhone: "081100000000",
  shipperEmail: "billing@punyasitus.com",
  shipperAddress: "Digital Subscription Service",
};

const PRIVATE_OR_LOCAL_HOST_RE =
  /^(?:localhost|.*\.localhost|.*\.local|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[.*\])$/i;
const RAW_IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const REFF_ID_RE = /^[A-Za-z0-9_-]{4,30}$/;
const AUTOLARIS_MYSQL_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

function isPrivateOrRawIpHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!lower) return true;
  if (PRIVATE_OR_LOCAL_HOST_RE.test(lower)) return true;
  if (RAW_IPV4_RE.test(lower)) return true;
  if (lower.includes(":")) return true;
  return false;
}

/**
 * Validates the configured AutoLaris static-IP relay base URL (SSRF prevention).
 */
export function validateAutoLarisRelayUrl(rawBaseUrl: string): URL {
  const trimmed = rawBaseUrl.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new BillingProviderError(
      "relay_config_error",
      "INVALID_RELAY_URL",
      "Konfigurasi URL relay AutoLaris tidak valid.",
    );
  }

  if (trimmed.includes("..") || trimmed.includes("\\")) {
    throw new BillingProviderError(
      "relay_config_error",
      "INVALID_RELAY_URL",
      "Path relay AutoLaris tidak valid.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BillingProviderError(
      "relay_config_error",
      "INVALID_RELAY_URL",
      "Konfigurasi URL relay AutoLaris gagal diparsing.",
    );
  }

  if (parsed.protocol !== "https:") {
    throw new BillingProviderError(
      "relay_config_error",
      "INSECURE_RELAY_URL",
      "Relay AutoLaris wajib menggunakan HTTPS.",
    );
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new BillingProviderError(
      "relay_config_error",
      "RELAY_URL_EMBEDDED_CREDENTIALS",
      "URL relay AutoLaris tidak boleh mengandung kredensial.",
    );
  }

  if (parsed.search !== "" || parsed.hash !== "") {
    throw new BillingProviderError(
      "relay_config_error",
      "INVALID_RELAY_URL",
      "URL relay AutoLaris tidak boleh mengandung query string atau fragment.",
    );
  }

  if (isPrivateOrRawIpHost(parsed.hostname)) {
    throw new BillingProviderError(
      "relay_config_error",
      "FORBIDDEN_RELAY_HOST",
      "Host relay AutoLaris tidak diizinkan (alamat lokal/privat/IP mentah ditolak).",
    );
  }

  if (parsed.pathname.includes("..") || parsed.pathname.includes("\\")) {
    throw new BillingProviderError(
      "relay_config_error",
      "INVALID_RELAY_URL",
      "Path relay AutoLaris tidak valid.",
    );
  }

  return parsed;
}

function buildPermittedEndpointUrl(baseUrl: URL, apiPath: string): string {
  if (!PERMITTED_AUTOLARIS_PATHS.has(apiPath)) {
    throw new BillingProviderError(
      "relay_config_error",
      "FORBIDDEN_AUTOLARIS_ENDPOINT",
      "Endpoint AutoLaris tidak diizinkan oleh kebijakan langganan digital.",
    );
  }
  const cleanPrefix = baseUrl.pathname.replace(/\/+$/, "");
  return `${baseUrl.origin}${cleanPrefix}${apiPath}`;
}

export function validateApprovedPaymentRedirectUrl(
  rawUrl: unknown,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_REDIRECT_SUFFIXES,
): string | null {
  if (rawUrl === null || rawUrl === undefined) return null;
  if (typeof rawUrl !== "string") {
    throw new BillingValidationError(
      "INVALID_REDIRECT_URL",
      "URL redirect pembayaran provider harus berupa string.",
    );
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2048 || /\s/.test(trimmed) || trimmed.includes("..") || trimmed.includes("\\")) {
    throw new BillingValidationError(
      "INVALID_REDIRECT_URL",
      "URL redirect pembayaran provider tidak valid.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BillingValidationError(
      "INVALID_REDIRECT_URL",
      "URL redirect pembayaran provider gagal diparsing.",
    );
  }

  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new BillingValidationError(
      "UNSAFE_REDIRECT_URL",
      "URL redirect pembayaran wajib HTTPS tanpa kredensial tertanam.",
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrRawIpHost(host)) {
    throw new BillingValidationError(
      "UNSAFE_REDIRECT_URL",
      "URL redirect pembayaran menunjuk ke host lokal atau IP mentah.",
    );
  }

  const allowed = allowedHosts.some((entry) => {
    const clean = entry.trim().toLowerCase().replace(/^\*\./, "");
    return clean.length > 0 && (host === clean || host.endsWith(`.${clean}`));
  });

  if (!allowed) {
    throw new BillingValidationError(
      "UNAPPROVED_REDIRECT_HOST",
      "URL redirect pembayaran mengarah ke domain yang tidak disetujui.",
    );
  }

  return parsed.toString();
}

function parseAutoLarisExpiredTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const mysqlMatch = AUTOLARIS_MYSQL_DATETIME_RE.exec(trimmed);
  if (mysqlMatch) {
    // AutoLaris returns Indonesia local time (WIB, UTC+07:00) in "YYYY-MM-DD HH:mm:ss" format.
    const isoWib = `${mysqlMatch[1]}-${mysqlMatch[2]}-${mysqlMatch[3]}T${mysqlMatch[4]}:${mysqlMatch[5]}:${mysqlMatch[6]}+07:00`;
    const parsed = Date.parse(isoWib);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveBankNameFromChannelCode(channelCode: string): string | null {
  if (!channelCode.startsWith("VA")) return null;
  const bankToken = channelCode.replace(/^VA_?/, "").trim();
  if (!bankToken) return null;
  const map: Readonly<Record<string, string>> = {
    BCA: "Bank BCA",
    BNI: "Bank BNI",
    BRI: "Bank BRI",
    MANDIRI: "Bank Mandiri",
    PERMATA: "Bank Permata",
    BSI: "Bank Syariah Indonesia",
    CIMB: "Bank CIMB Niaga",
    DANAMON: "Bank Danamon",
  };
  return map[bankToken] ?? `Bank ${bankToken}`;
}

function sanitizeText(input: string, maxLength: number, fallback: string): string {
  const cleaned = input.replace(/[\r\n\t\p{Cc}]+/gu, " ").trim();
  return (cleaned || fallback).slice(0, maxLength);
}

interface AutoLarisEnvelope {
  readonly rc?: unknown;
  readonly ket?: unknown;
  readonly data?: unknown;
}

async function fetchJsonWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ readonly response: Response; readonly rawText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("AUTOLARIS_TIMEOUT"), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    const rawText = await response.text();
    return { response, rawText };
  } catch (err) {
    const isAbort =
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError") ||
      err === "AUTOLARIS_TIMEOUT";
    throw new BillingProviderError(
      "uncertain_timeout_or_network",
      isAbort ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR",
      isAbort
        ? "Koneksi ke relay AutoLaris melewati batas waktu; rekonsiliasi diperlukan."
        : "Gagal menghubungi relay AutoLaris; status transaksi belum pasti.",
    );
  } finally {
    clearTimeout(timer);
  }
}

export function createAutoLarisClient(config: AutoLarisRelayConfig): AutoLarisBillingClient {
  const relayBaseUrl = validateAutoLarisRelayUrl(config.relayBaseUrl);
  const apiKey = config.apiKey.trim();
  if (!apiKey || apiKey.length < 8) {
    throw new BillingProviderError(
      "relay_config_error",
      "AUTOLARIS_NOT_CONFIGURED",
      "Kredensial server AutoLaris belum dikonfigurasi.",
    );
  }

  const providerAccountId = (config.providerAccountId ?? AUTOLARIS_DEFAULT_ACCOUNT_ID)
    .trim()
    .slice(0, 64) || AUTOLARIS_DEFAULT_ACCOUNT_ID;
  const timeoutMs = Math.max(
    MIN_TIMEOUT_MS,
    Math.min(MAX_TIMEOUT_MS, Math.trunc(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  );
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const allowedRedirectHosts = config.allowedRedirectHosts ?? DEFAULT_ALLOWED_REDIRECT_SUFFIXES;
  const digitalProfile: AutoLarisDigitalProfileConfig = {
    ...DEFAULT_DIGITAL_PROFILE,
    ...config.digitalProfile,
  };

  return {
    providerAccountId,
    relayOrigin: relayBaseUrl.origin,

    async listPaymentChannels(
      referenceBaseAmountIdr: number = DEFAULT_MONTHLY_PRICE_IDR,
    ): Promise<readonly ValidatedPaymentChannel[]> {
      const safeRefBase = assertExactIdrInteger(referenceBaseAmountIdr, "referenceBaseAmountIdr", {
        min: MIN_AUTOLARIS_CHARGE_IDR,
        max: MAX_IDR_AMOUNT,
      });
      const url = buildPermittedEndpointUrl(relayBaseUrl, "/api/h2h/list_payment");

      const { response, rawText } = await fetchJsonWithTimeout(
        fetchImpl,
        url,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
        },
        timeoutMs,
      );

      if (response.status === 401 || response.status === 403) {
        throw new BillingProviderError(
          "definite_refusal",
          "PROVIDER_AUTH_ERROR",
          "Autentikasi relay AutoLaris ditolak.",
        );
      }

      if (!response.ok) {
        throw new BillingProviderError(
          response.status >= 500 ? "uncertain_timeout_or_network" : "definite_refusal",
          response.status >= 500 ? "PROVIDER_UPSTREAM_5XX" : "PROVIDER_HTTP_ERROR",
          "Gagal memuat daftar channel pembayaran dari AutoLaris.",
        );
      }

      let envelope: AutoLarisEnvelope;
      try {
        envelope = JSON.parse(rawText) as AutoLarisEnvelope;
      } catch {
        throw new BillingProviderError(
          "invalid_provider_payload",
          "PROVIDER_MALFORMED_JSON",
          "Respons daftar channel AutoLaris tidak valid.",
        );
      }

      if (!envelope || typeof envelope !== "object" || envelope.rc !== "00" || !Array.isArray(envelope.data)) {
        throw new BillingProviderError(
          "definite_refusal",
          "PROVIDER_LIST_PAYMENT_FAILED",
          "Daftar channel pembayaran AutoLaris tidak tersedia saat ini.",
        );
      }

      return filterAllowedAutoLarisChannels(
        envelope.data as readonly RawAutoLarisPaymentChannel[],
        safeRefBase,
      );
    },

    async submitDigitalSubscriptionOrder(
      input: SubmitDigitalOrderInput,
    ): Promise<ValidatedAutoLarisSubmitResult> {
      const reffId = input.reffId.trim();
      if (!REFF_ID_RE.test(reffId) || reffId.length > AUTOLARIS_REFF_ID_MAX_LENGTH) {
        throw new BillingValidationError(
          "INVALID_REFF_ID",
          "Referensi transaksi partner (reff_id) tidak valid.",
        );
      }

      const classified = classifyAllowedChannel(input.channelCode);
      if (!classified.ok) {
        throw new BillingValidationError(classified.code, classified.reason, [
          { field: "channelCode", code: classified.code, message: classified.reason },
        ]);
      }
      if (classified.kind !== input.channelKind) {
        throw new BillingValidationError(
          "CHANNEL_KIND_MISMATCH",
          `channelKind "${input.channelKind}" tidak sesuai dengan channelCode "${classified.normalizedCode}".`,
          [
            {
              field: "channelKind",
              code: "CHANNEL_KIND_MISMATCH",
              message: `Expected channelKind "${classified.kind}" for channel "${classified.normalizedCode}".`,
            },
          ],
        );
      }

      const netAmountIdr = assertExactIdrInteger(input.netAmountIdr, "netAmountIdr", {
        min: MIN_AUTOLARIS_CHARGE_IDR,
        max: MAX_IDR_AMOUNT,
      });

      const itemLabel =
        input.plan === "yearly"
          ? `Langganan PunyaSitus Tahunan (${sanitizeText(input.tenantHandle, 40, "tenant")})`
          : `Langganan PunyaSitus Bulanan (${sanitizeText(input.tenantHandle, 40, "tenant")})`;

      const submitBody = {
        reff_id: reffId,
        channel_code: classified.normalizedCode,
        courir_id: AUTOLARIS_DIGITAL_COURIR_ID,
        origin: digitalProfile.originAreaId,
        destination: digitalProfile.destinationAreaId,
        weight: "1",
        length: "1",
        width: "1",
        height: "1",
        shipper_name: digitalProfile.shipperName,
        shipper_phone: digitalProfile.shipperPhone,
        shipper_email: digitalProfile.shipperEmail,
        shipper_address: digitalProfile.shipperAddress,
        receiver_name: sanitizeText(input.payerName, 100, "Pemilik Situs"),
        receiver_phone: sanitizeText(input.payerPhone ?? "081100000000", 20, "081100000000"),
        receiver_email: sanitizeText(input.payerEmail, 120, "owner@punyasitus.com"),
        receiver_address: "Digital Subscription (Non-Physical)",
        callback_url: "",
        grand_total: String(netAmountIdr),
        cod_value: AUTOLARIS_COD_VALUE,
        longitude: "",
        latitude: "",
        remark: `PunyaSitus ${input.plan} subscription`,
        order_details: [
          {
            name: itemLabel,
            qty: "1",
            unit_price: String(netAmountIdr),
          },
        ],
      };

      const url = buildPermittedEndpointUrl(relayBaseUrl, "/api/h2h/submit");
      const { response, rawText } = await fetchJsonWithTimeout(
        fetchImpl,
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(submitBody),
        },
        timeoutMs,
      );

      if (response.status >= 500) {
        throw new BillingProviderError(
          "uncertain_timeout_or_network",
          `PROVIDER_HTTP_${response.status}`,
          "Relay AutoLaris mengembalikan galat server; status transaksi belum pasti.",
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw new BillingProviderError(
          "definite_refusal",
          "PROVIDER_AUTH_ERROR",
          "Autentikasi relay AutoLaris ditolak.",
        );
      }

      if (!response.ok) {
        throw new BillingProviderError(
          "definite_refusal",
          `PROVIDER_HTTP_${response.status}`,
          "Permintaan pembuatan instruksi pembayaran ditolak oleh AutoLaris.",
        );
      }

      let envelope: AutoLarisEnvelope;
      try {
        envelope = JSON.parse(rawText) as AutoLarisEnvelope;
      } catch {
        // HTTP 2xx with unparseable body means provider may have created the charge -> uncertain!
        throw new BillingProviderError(
          "uncertain_timeout_or_network",
          "PROVIDER_MALFORMED_RESPONSE",
          "Respons sukses AutoLaris tidak dapat diparsing; rekonsiliasi diperlukan.",
        );
      }

      if (!envelope || typeof envelope !== "object" || typeof envelope.rc !== "string") {
        throw new BillingProviderError(
          "uncertain_timeout_or_network",
          "PROVIDER_MALFORMED_ENVELOPE",
          "Struktur respons AutoLaris tidak valid; rekonsiliasi diperlukan.",
        );
      }

      if (envelope.rc !== "00") {
        const safeCode =
          envelope.rc === "07"
            ? "PROVIDER_CHANNEL_INACTIVE"
            : envelope.rc === "01"
              ? "PROVIDER_INVALID_PARAMETER"
              : "PROVIDER_SUBMIT_REJECTED";
        throw new BillingProviderError(
          "definite_refusal",
          safeCode,
          "AutoLaris menolak pembuatan instruksi pembayaran untuk channel ini.",
        );
      }

      // rc === "00": provider accepted creation — validate every critical field strictly.
      // Any anomaly here MUST enter `review` (preserving providerTransactionId if present), NEVER silent overwrite or paid!
      const data = envelope.data as Record<string, unknown> | null | undefined;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new BillingProviderError(
          "invalid_provider_payload",
          "PROVIDER_MISSING_DATA",
          "Payload data AutoLaris kosong meskipun rc=00; memerlukan tinjauan.",
        );
      }

      const rawTrxId = data.transaction_id;
      const providerTransactionId =
        typeof rawTrxId === "string"
          ? rawTrxId.trim()
          : typeof rawTrxId === "number" && Number.isSafeInteger(rawTrxId)
            ? String(rawTrxId)
            : "";

      if (!providerTransactionId || providerTransactionId.length > 80) {
        throw new BillingProviderError(
          "invalid_provider_payload",
          "PROVIDER_MISSING_TRANSACTION_ID",
          "AutoLaris tidak mengembalikan transaction_id yang valid; memerlukan tinjauan.",
        );
      }

      const returnedReffId =
        typeof data.reff_id === "string" ? data.reff_id.trim() : "";
      if (returnedReffId !== reffId) {
        throw new BillingProviderError(
          "invalid_provider_payload",
          "PROVIDER_REFF_ID_MISMATCH",
          "Referensi reff_id dari AutoLaris tidak sesuai dengan permintaan.",
          { providerTransactionId },
        );
      }

      const returnedChannel =
        typeof data.channel_code === "string"
          ? data.channel_code.trim().toUpperCase()
          : "";
      if (returnedChannel !== classified.normalizedCode) {
        throw new BillingProviderError(
          "invalid_provider_payload",
          "PROVIDER_CHANNEL_MISMATCH",
          "Channel pembayaran pada respons AutoLaris tidak sesuai dengan pilihan.",
          { providerTransactionId },
        );
      }

      let costs;
      try {
        costs = validateProviderCosts({
          expectedNetAmountIdr: netAmountIdr,
          biayaKirim: data.biaya_kirim,
          biayaCod: data.biaya_cod,
          biayaAsuransi: data.biaya_asuransi,
          biayaAdmin: data.biaya_admin,
          diskon: data.diskon,
          total: data.total,
        });
      } catch (err) {
        const reasonCode =
          err instanceof BillingValidationError ? err.reasonCode : "INVALID_PROVIDER_COSTS";
        throw new BillingProviderError(
          "invalid_provider_payload",
          reasonCode,
          err instanceof Error
            ? err.message
            : "Rincian biaya AutoLaris tidak sesuai dengan kebijakan.",
          { providerTransactionId },
        );
      }

      const paymentInfo = data.payment_info as Record<string, unknown> | null | undefined;
      if (!paymentInfo || typeof paymentInfo !== "object" || Array.isArray(paymentInfo)) {
        throw new BillingProviderError(
          "invalid_provider_payload",
          "PROVIDER_MISSING_PAYMENT_INFO",
          "Instruksi pembayaran (payment_info) tidak tersedia dari AutoLaris.",
          { providerTransactionId },
        );
      }

      const rawQr = typeof paymentInfo.qr === "string" ? paymentInfo.qr.trim() : "";
      const rawVa = typeof paymentInfo.va === "string" ? paymentInfo.va.trim() : "";
      let paymentRedirectUrl: string | null;
      try {
        paymentRedirectUrl = validateApprovedPaymentRedirectUrl(
          paymentInfo.url,
          allowedRedirectHosts,
        );
      } catch (err) {
        const reasonCode =
          err instanceof BillingValidationError ? err.reasonCode : "INVALID_REDIRECT_URL";
        throw new BillingProviderError(
          "invalid_provider_payload",
          reasonCode,
          err instanceof Error ? err.message : "URL redirect pembayaran tidak valid.",
          { providerTransactionId },
        );
      }

      if (classified.kind === "QRIS" && !rawQr) {
        throw new BillingProviderError(
          "invalid_provider_payload",
          "MISSING_QRIS_PAYLOAD",
          "Payload QRIS kosong pada respons AutoLaris.",
          { providerTransactionId },
        );
      }

      if (classified.kind === "VA" && !rawVa) {
        throw new BillingProviderError(
          "invalid_provider_payload",
          "MISSING_VA_NUMBER",
          "Nomor Virtual Account kosong pada respons AutoLaris.",
          { providerTransactionId },
        );
      }

      if (rawQr.length > 4096 || rawVa.length > 64) {
        throw new BillingProviderError(
          "invalid_provider_payload",
          "OVERSIZED_PAYMENT_INSTRUCTION",
          "Instruksi pembayaran AutoLaris melebihi panjang maksimum.",
          { providerTransactionId },
        );
      }

      const expiresAtMs = parseAutoLarisExpiredTimestamp(paymentInfo.expired);
      const expiresAtIso = expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : null;

      return {
        providerAccountId,
        providerTransactionId,
        reffId,
        channelKind: classified.kind,
        channelCode: classified.normalizedCode,
        channelFeeIdr: costs.channelFeeIdr,
        grossAdminFeeIdr: costs.grossAdminFeeIdr,
        providerDiscountIdr: costs.providerDiscountIdr,
        totalPayableIdr: costs.totalPayableIdr,
        qrisPayload: rawQr || null,
        vaNumber: rawVa || null,
        bankName: classified.kind === "VA" ? deriveBankNameFromChannelCode(classified.normalizedCode) : null,
        paymentRedirectUrl,
        expiresAtMs,
        expiresAtIso,
      };
    },
  };
}

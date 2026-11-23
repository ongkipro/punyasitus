import {
  ANALYTICS_EVENT_DEDUP_TTL_MS,
  createClientEventDedupStore,
  deriveDeterministicLeadEventId,
  generateAnalyticsEventId,
  isValidAnalyticsUuid,
  normalizeAnalyticsEventIdToUuid,
  normalizeTenantDedupScope,
  sanitizeClientEventId,
  type ClientDedupStorageLike,
  type ClientEventDedupStore,
} from "./dedup.ts";
import {
  buildGtmNoscriptUrl,
  buildGtmScriptUrl,
  buildGoogleConsentModeUpdate,
  buildPsExternalClickEvent,
  buildPsLeadSubmittedEvent,
  buildPsPageViewEvent,
  buildPsWaClickEvent,
  GTM_CONSENT_MODE_V2_DEFAULT,
  isValidGtmContainerId,
  normalizeGtmPageType,
  type GoogleConsentModeV2DefaultParams,
  type GoogleConsentModeV2UpdateParams,
  type GtmPageType,
  type PsDataLayerEventPayload,
  type VendorDeliveryModes,
} from "./gtm.ts";
import type {
  InsightContentKind,
  InsightSourceBucket,
  PersistedArrivalSource,
} from "./insights.ts";
import {
  ANALYTICS_PROVIDER_DESCRIPTORS,
  ANALYTICS_PROVIDER_EVENT_MAPPINGS,
  buildProviderScriptUrl,
  DIRECT_ANALYTICS_PROVIDERS,
  getProviderIdFromConfig,
  normalizeCanonicalSignalEvent,
  parseStoredDirectAnalyticsConfig,
  type CanonicalSignalEvent,
  type DirectAnalyticsConfig,
  type DirectAnalyticsProvider,
  type ProviderScriptOverrides,
  type SignalEventAlias,
} from "./providers.ts";

/**
 * Consent-Aware Analytics Signal Dispatcher & PII-Stripping Engine
 * (`packages/core/src/analytics/signals.ts`; TASK-022 & TASK-076, REQ-027, REQ-017, REQ-033, REQ-039).
 *
 * Core security & privacy invariants:
 * 1. STRICT ZERO-TAGS-BEFORE-CONSENT: defaults strictly to `{ analytics: false, marketing: false }`.
 *    No vendor or GTM script loads and no signal dispatches until explicit visitor consent is granted
 *    for the provider's category (`analytics` for GA4 & GTM; `marketing` for Meta & TikTok).
 * 2. CONSENT MODE V2 BEFORE GTM: sets Google Consent Mode v2 defaults to `denied` BEFORE `gtm.js`
 *    ever loads, and pushes Consent Mode updates whenever consent changes or is revoked.
 * 3. NO DOUBLE COUNTING: when GTM is active, any vendor routed via `"gtm"` is suppressed from direct
 *    dispatch even if a legacy direct ID is present.
 * 4. IMMEDIATE HALT ON DECLINE/REVOCATION: revoking consent immediately stops all future
 *    dispatches and notifies the adapter to tear down / disable vendor & GTM tags.
 * 5. ONE LEAD SIGNAL AFTER PERSISTENCE: `dispatchLeadSubmitted` requires `persisted === true`
 *    and a valid positive `leadId`, and deduplicates strictly by `leadId` so a persisted lead
 *    can fire at most ONCE across retries, double-clicks, or repeated DOM observations.
 * 6. ZERO PII LEAKAGE: allowlist-first sanitization + forbidden-field denylist + email/phone
 *    regex scrubbing guarantees visitor name, email, phone, message, and raw query strings
 *    are NEVER forwarded to GA4, Meta Pixel, TikTok Pixel, or GTM `ps_*` `dataLayer` events.
 * 7. FAULT ISOLATION: every provider/GTM load/dispatch/revoke call is wrapped in `try/catch` so
 *    ad-blockers, failed network scripts, or throwing vendor globals NEVER break CTAs or forms.
 */

export interface AnalyticsConsentState {
  readonly version: number;
  readonly analytics: boolean;
  readonly marketing: boolean;
  readonly hasDecision: boolean;
}

export type SanitizedSignalParams = Readonly<Record<string, string | number | boolean>>;

export interface ProviderDeliveryRecord {
  readonly provider: DirectAnalyticsProvider;
  readonly providerEventName: string;
  readonly eventId: string;
}

export interface ProviderSkipRecord {
  readonly provider: DirectAnalyticsProvider | "gtm" | "first_party";
  readonly reason:
    | "NOT_CONFIGURED"
    | "CONSENT_DENIED"
    | "INVALID_ID"
    | "ROUTED_VIA_GTM"
    | "DUPLICATE_EVENT_ID";
}

export interface ProviderErrorRecord {
  readonly provider: DirectAnalyticsProvider | "gtm" | "first_party";
  readonly phase: "load" | "send" | "revoke" | "consent";
  readonly message: string;
}

export type FirstPartySignalEventName =
  | "wa_click"
  | "external_click"
  | "lead_submitted"
  | "page_view";

export interface FirstPartyEventPayload {
  readonly eventId: string;
  readonly eventName: FirstPartySignalEventName;
  readonly path: string;
  readonly routeKind?: InsightContentKind;
  readonly sourceCategory?: InsightSourceBucket;
  readonly referrerHost?: string;
  readonly utmSource?: string;
  readonly utmMedium?: string;
}

export interface AnalyticsFirstPartyAdapter {
  readonly sendEvent: (payload: FirstPartyEventPayload) => void;
}

export interface SignalDispatchReport {
  readonly ok: boolean;
  readonly deduplicated?: boolean;
  readonly eventName: CanonicalSignalEvent | null;
  readonly eventId: string;
  readonly sanitizedParams: SanitizedSignalParams;
  readonly deliveredTo: readonly ProviderDeliveryRecord[];
  readonly gtmEventPushed?: PsDataLayerEventPayload | null;
  readonly firstPartySent?: boolean;
  readonly skipped: readonly ProviderSkipRecord[];
  readonly errors: readonly ProviderErrorRecord[];
}

export interface LeadSignalInput {
  readonly leadId: number | string | null | undefined;
  readonly persisted: boolean;
  readonly eventId?: string;
  readonly formId?: string;
  readonly page_path?: string;
  readonly content_category?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export type LeadSignalResult =
  | {
      readonly ok: true;
      readonly leadId: string;
      readonly report: SignalDispatchReport;
    }
  | {
      readonly ok: false;
      readonly reason: "NOT_PERSISTED" | "INVALID_LEAD_ID" | "DUPLICATE_LEAD_ID";
      readonly leadId: string | null;
    };

export interface AnalyticsProviderAdapter {
  readonly loadProvider: (
    provider: DirectAnalyticsProvider,
    providerId: string,
    scriptUrl: string,
  ) => void;
  readonly sendEvent: (
    provider: DirectAnalyticsProvider,
    providerId: string,
    providerEventName: string,
    params: SanitizedSignalParams,
    meta: {
      readonly canonicalEvent: CanonicalSignalEvent;
      readonly eventId: string;
      readonly tiktokMethod: "page" | "track";
    },
  ) => void;
  readonly revokeProvider?: (provider: DirectAnalyticsProvider, providerId: string) => void;
}

export interface AnalyticsGtmAdapter {
  readonly initConsentDefault: (defaults: GoogleConsentModeV2DefaultParams) => void;
  readonly updateConsentMode: (update: GoogleConsentModeV2UpdateParams) => void;
  readonly loadGtm: (
    containerId: string,
    scriptUrl: string,
    noscriptUrl: string,
    nonce?: string,
  ) => void;
  readonly pushDataLayerEvent: (payload: PsDataLayerEventPayload) => void;
  readonly revokeGtm?: (containerId: string) => void;
}

export interface AnalyticsDispatcherGtmOptions {
  readonly enabled: boolean;
  readonly containerId: string | null;
  readonly vendorModes?: Partial<VendorDeliveryModes>;
  readonly cspNonce?: string;
  readonly ssrLoaded?: boolean;
  readonly pageType?: GtmPageType;
  readonly contentId?: string | null;
  readonly testScriptUrl?: string;
  readonly testNoscriptUrl?: string;
}

export interface AnalyticsDispatcherOptions {
  readonly config: Partial<DirectAnalyticsConfig> | null | undefined;
  readonly adapter: AnalyticsProviderAdapter;
  readonly gtm?: AnalyticsDispatcherGtmOptions | null;
  readonly gtmAdapter?: AnalyticsGtmAdapter;
  readonly firstPartyAdapter?: AnalyticsFirstPartyAdapter;
  readonly tenantScope?: string | null;
  readonly dedupTtlMs?: number;
  readonly dedupStorage?: ClientDedupStorageLike | null;
  readonly dedupStore?: ClientEventDedupStore;
  readonly now?: () => number;
  readonly expectedPolicyVersion?: number;
  readonly initialConsent?: Partial<AnalyticsConsentState> | null;
  readonly autoPageView?: boolean;
  readonly currentPath?: () => string;
  /** Optional tab-scoped arrival source resolver (`sessionStorage`, zero cookies; TASK-072). */
  readonly getArrivalSource?: () => PersistedArrivalSource | null;
  /** Optional default route kind for cookieless first-party `page_view` / CTA events (TASK-072). */
  readonly defaultRouteKind?: InsightContentKind;
  readonly generateEventId?: () => string;
  readonly testScriptOverrides?: ProviderScriptOverrides;
  readonly hasPersistedLeadMarker?: (leadKey: string) => boolean;
  readonly savePersistedLeadMarker?: (leadKey: string) => void;
}

export interface AnalyticsDispatcherSnapshot {
  readonly config: DirectAnalyticsConfig;
  readonly consent: AnalyticsConsentState;
  readonly loadedProviders: readonly DirectAnalyticsProvider[];
  readonly activeProviders: readonly DirectAnalyticsProvider[];
  readonly dispatchedLeadIds: readonly string[];
  readonly gtmEnabled: boolean;
  readonly gtmContainerId: string | null;
  readonly gtmLoaded: boolean;
}

export interface AnalyticsSignalDispatcher {
  readonly getState: () => AnalyticsDispatcherSnapshot;
  readonly updateConsent: (
    next: Partial<AnalyticsConsentState>,
  ) => readonly ProviderErrorRecord[];
  readonly dispatch: (
    eventName: SignalEventAlias | string,
    rawParams?: Readonly<Record<string, unknown>>,
  ) => SignalDispatchReport;
  readonly dispatchLeadSubmitted: (input: LeadSignalInput) => LeadSignalResult;
}

const EMAIL_PII_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_PII_RE = /(?:\+?\d[\d\s().-]{7,18}\d)/;

function stripControlChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      out += value[i];
    }
  }
  return out;
}

const FORBIDDEN_PII_KEYS = new Set([
  "name",
  "fullname",
  "firstname",
  "lastname",
  "visitorname",
  "customername",
  "leadname",
  "phone",
  "phonee164",
  "phonenumber",
  "mobile",
  "whatsapp",
  "wa",
  "tel",
  "telephone",
  "email",
  "emailaddress",
  "mail",
  "message",
  "pesan",
  "body",
  "comment",
  "notes",
  "internalnotes",
  "address",
  "alamat",
  "query",
  "querystring",
  "search",
  "searchparams",
  "rawurl",
  "cookie",
  "cookies",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "password",
  "secret",
  "ip",
  "ipaddress",
  "useragent",
  "lead",
  "leads",
  "leadfields",
  "formdata",
  "fields",
  "submission",
  "customer",
  "contact",
  "preferreddate",
  "preferredtime",
  "branch",
  "utm",
  "utmsource",
  "utmmedium",
  "utmcampaign",
  "utmterm",
  "utmcontent",
  "gclid",
  "fbclid",
  "ttclid",
]);

const ALLOWED_SIGNAL_PARAM_KEYS = new Set([
  "event_id",
  "page_path",
  "content_type",
  "offering_type",
  "content_category",
  "content_name",
  "cta_mode",
  "currency",
  "value",
  "lead_ref",
]);

const ALLOWED_CTA_MODES = new Set(["whatsapp", "external_link", "inquiry", "book", "phone"]);
const ALLOWED_CONTENT_TYPES = new Set([
  "page",
  "post",
  "service",
  "product",
  "tour",
  "vehicle",
  "outlet",
  "contact_form",
  "whatsapp",
  "external",
]);

function normalizeKeyForPiiCheck(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function containsPiiString(value: string): boolean {
  return EMAIL_PII_RE.test(value) || PHONE_PII_RE.test(value);
}

/**
 * Normalizes a relative path or URL into a query-free, fragment-free, PII-free relative path.
 */
export function sanitizeSignalPagePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = stripControlChars(raw).trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:")
  ) {
    return null;
  }

  let pathname: string;
  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//")) return null;
    pathname = trimmed.split(/[?#]/, 1)[0] ?? "/";
  } else {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return null;
      }
      pathname = parsed.pathname || "/";
    } catch {
      return null;
    }
  }

  if (!pathname.startsWith("/") || containsPiiString(pathname)) {
    return null;
  }

  return pathname.slice(0, 200);
}

/**
 * Strips ALL PII fields, PII-like values (email / phone), query strings, and unknown keys
 * before any payload can reach GA4, Meta Pixel, or TikTok Pixel.
 */
export function sanitizeAnalyticsSignalPayload(
  rawParams: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, string | number | boolean> {
  const clean: Record<string, string | number | boolean> = {};
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return clean;
  }

  for (const [rawKey, rawVal] of Object.entries(rawParams)) {
    if (FORBIDDEN_PII_KEYS.has(normalizeKeyForPiiCheck(rawKey))) {
      continue;
    }
    if (!ALLOWED_SIGNAL_PARAM_KEYS.has(rawKey)) {
      continue;
    }

    if (rawKey === "event_id") {
      const safeEventId = sanitizeClientEventId(rawVal);
      if (safeEventId) {
        clean.event_id = safeEventId;
      }
      continue;
    }

    if (rawKey === "page_path") {
      const safePath = sanitizeSignalPagePath(rawVal);
      if (safePath) clean.page_path = safePath;
      continue;
    }

    if (rawKey === "value") {
      if (typeof rawVal === "number" && Number.isFinite(rawVal) && rawVal >= 0) {
        clean.value = Math.round(rawVal * 100) / 100;
      }
      continue;
    }

    if (rawKey === "currency") {
      if (typeof rawVal === "string") {
        const upper = rawVal.trim().toUpperCase();
        if (/^[A-Z]{3}$/.test(upper)) {
          clean.currency = upper;
        }
      }
      continue;
    }

    if (rawKey === "cta_mode") {
      if (typeof rawVal === "string" && ALLOWED_CTA_MODES.has(rawVal.trim())) {
        clean.cta_mode = rawVal.trim();
      }
      continue;
    }

    if (rawKey === "content_type" || rawKey === "offering_type") {
      if (typeof rawVal === "string" && ALLOWED_CONTENT_TYPES.has(rawVal.trim())) {
        clean[rawKey] = rawVal.trim();
      }
      continue;
    }

    if (rawKey === "lead_ref") {
      if (typeof rawVal === "string") {
        const trimmed = rawVal.trim();
        if (/^lead_[a-zA-Z0-9_-]{1,48}$/.test(trimmed)) {
          clean.lead_ref = trimmed;
        }
      }
      continue;
    }

    if (typeof rawVal === "string") {
      const trimmed = stripControlChars(rawVal).trim();
      if (!trimmed) continue;
      // Strip URL query strings if a string looks like a URL
      if (
        trimmed.includes("?") &&
        (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("/"))
      ) {
        const stripped = sanitizeSignalPagePath(trimmed);
        if (stripped) clean[rawKey] = stripped;
        continue;
      }
      if (containsPiiString(trimmed)) {
        continue;
      }
      clean[rawKey] = trimmed.slice(0, 128);
    } else if (typeof rawVal === "boolean") {
      clean[rawKey] = rawVal;
    }
  }

  return clean;
}

export function canDispatchToProvider(
  provider: DirectAnalyticsProvider,
  consent: AnalyticsConsentState,
  expectedPolicyVersion = 1,
): boolean {
  if (!consent.hasDecision) return false;
  if (consent.version !== expectedPolicyVersion) return false;
  const category = ANALYTICS_PROVIDER_DESCRIPTORS[provider].consentCategory;
  return category === "analytics" ? consent.analytics === true : consent.marketing === true;
}

export function canDispatchToGtm(
  consent: AnalyticsConsentState,
  expectedPolicyVersion = 1,
): boolean {
  return (
    consent.hasDecision === true &&
    consent.version === expectedPolicyVersion &&
    consent.analytics === true
  );
}

function defaultEventId(): string {
  return generateAnalyticsEventId();
}

function mapCanonicalToFirstPartyEvent(
  canonical: CanonicalSignalEvent,
): FirstPartySignalEventName | null {
  switch (canonical) {
    case "whatsapp_click":
      return "wa_click";
    case "external_click":
      return "external_click";
    case "page_view":
      return "page_view";
    // `lead_submitted` is intentionally excluded here because `POST /api/leads` already
    // increments `analytics_daily.lead_submits` authoritatively on durable persistence;
    // emitting it from client `firstPartyAdapter` would double-count leads.
    case "lead_submitted":
    default:
      return null;
  }
}

function normalizeLeadId(raw: number | string | null | undefined): string | null {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 1) return null;
    return String(raw);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^[1-9][0-9]{0,12}$/.test(trimmed)) return trimmed;
    if (/^[a-zA-Z0-9_-]{4,64}$/.test(trimmed) && trimmed !== "0") return trimmed;
  }
  return null;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return typeof err === "string" && err ? err : "Unknown provider error";
}

function buildGtmEventForCanonical(
  canonical: CanonicalSignalEvent,
  eventId: string,
  pagePath: string,
  rawParams: Readonly<Record<string, unknown>> | undefined,
  gtmDefaults: { readonly pageType: GtmPageType; readonly contentId: string | null },
): PsDataLayerEventPayload | null {
  switch (canonical) {
    case "page_view":
      return buildPsPageViewEvent({
        eventId,
        pageType: rawParams?.page_type ?? gtmDefaults.pageType,
        contentId: rawParams?.content_id ?? gtmDefaults.contentId,
        pagePath,
      });
    case "whatsapp_click":
      return buildPsWaClickEvent({
        eventId,
        itemId: rawParams?.item_id,
        itemTitle: rawParams?.item_title ?? rawParams?.content_name,
        placement: rawParams?.placement,
        pagePath,
      });
    case "external_click":
      return buildPsExternalClickEvent({
        eventId,
        itemId: rawParams?.item_id,
        destinationHost: rawParams?.destination_host,
        destinationUrl: rawParams?.destination_url,
        pagePath,
      });
    case "lead_submitted":
      return buildPsLeadSubmittedEvent({
        eventId,
        formId: rawParams?.form_id,
        pagePath,
      });
    default:
      return null;
  }
}

export function createAnalyticsSignalDispatcher(
  options: AnalyticsDispatcherOptions,
): AnalyticsSignalDispatcher {
  const expectedPolicyVersion = options.expectedPolicyVersion ?? 1;
  const autoPageView = options.autoPageView ?? true;
  const rawConfig = parseStoredDirectAnalyticsConfig(options.config);
  const generateEventId = options.generateEventId ?? defaultEventId;
  const nowFn = options.now ?? Date.now;
  const tenantScope = normalizeTenantDedupScope(options.tenantScope);

  const gtmOpt = options.gtm ?? null;
  const gtmContainerId =
    gtmOpt?.enabled === true && isValidGtmContainerId(gtmOpt.containerId)
      ? gtmOpt.containerId
      : null;
  const gtmEnabled = gtmContainerId !== null;
  const gtmVendorModes: VendorDeliveryModes = {
    ga4: gtmOpt?.vendorModes?.ga4 === "gtm" ? "gtm" : "direct",
    meta: gtmOpt?.vendorModes?.meta === "gtm" ? "gtm" : "direct",
    tiktok: gtmOpt?.vendorModes?.tiktok === "gtm" ? "gtm" : "direct",
  };
  const gtmDefaults = {
    pageType: normalizeGtmPageType(gtmOpt?.pageType),
    contentId: gtmOpt?.contentId ?? null,
  };

  // Enforce mutual exclusion: any vendor routed via active GTM is never loaded directly
  const config: DirectAnalyticsConfig = {
    ga4MeasurementId: gtmEnabled && gtmVendorModes.ga4 === "gtm" ? null : rawConfig.ga4MeasurementId,
    metaPixelId: gtmEnabled && gtmVendorModes.meta === "gtm" ? null : rawConfig.metaPixelId,
    tiktokPixelId: gtmEnabled && gtmVendorModes.tiktok === "gtm" ? null : rawConfig.tiktokPixelId,
  };

  let consent: AnalyticsConsentState = {
    version: options.initialConsent?.version ?? expectedPolicyVersion,
    analytics: false,
    marketing: false,
    hasDecision: false,
  };

  // REQ-039: ZERO localStorage/sessionStorage writes before explicit `analytics` consent is granted.
  const canPersistClientStorage = () => canDispatchToGtm(consent, expectedPolicyVersion);
  const dedupStore =
    options.dedupStore ??
    createClientEventDedupStore({
      tenantScope,
      ttlMs: options.dedupTtlMs ?? ANALYTICS_EVENT_DEDUP_TTL_MS,
      storage: options.dedupStorage ?? null,
      canPersistStorage: canPersistClientStorage,
    });
  const pageLoadEventId = normalizeAnalyticsEventIdToUuid(generateEventId(), tenantScope);

  const loadedProviders = new Set<DirectAnalyticsProvider>();
  const pageViewSentProviders = new Set<DirectAnalyticsProvider>();
  const dispatchedLeadIds = new Set<string>();

  let gtmConsentDefaultInitialized = false;
  let gtmLoaded = gtmEnabled && gtmOpt?.ssrLoaded === true;
  let gtmPageViewSent = false;

  function ensureGtmConsentDefault(errors: ProviderErrorRecord[]): void {
    if (!gtmEnabled || !options.gtmAdapter || gtmConsentDefaultInitialized) return;
    try {
      options.gtmAdapter.initConsentDefault(GTM_CONSENT_MODE_V2_DEFAULT);
      gtmConsentDefaultInitialized = true;
    } catch (err) {
      errors.push({ provider: "gtm", phase: "consent", message: toErrorMessage(err) });
    }
  }

  // Always set Google Consent Mode v2 default-denied BEFORE any GTM load can ever occur
  if (gtmEnabled && options.gtmAdapter) {
    ensureGtmConsentDefault([]);
  }

  function isProviderRoutedViaGtm(provider: DirectAnalyticsProvider): boolean {
    return gtmEnabled && gtmVendorModes[provider] === "gtm";
  }

  function getActiveProviders(): DirectAnalyticsProvider[] {
    const active: DirectAnalyticsProvider[] = [];
    for (const provider of DIRECT_ANALYTICS_PROVIDERS) {
      if (isProviderRoutedViaGtm(provider)) continue;
      const id = getProviderIdFromConfig(config, provider);
      if (id && canDispatchToProvider(provider, consent, expectedPolicyVersion)) {
        active.push(provider);
      }
    }
    return active;
  }

  function ensureGtmLoaded(errors: ProviderErrorRecord[]): boolean {
    if (!gtmEnabled || !gtmContainerId || !options.gtmAdapter) return false;
    if (!canDispatchToGtm(consent, expectedPolicyVersion)) return false;

    ensureGtmConsentDefault(errors);

    if (!gtmLoaded) {
      const scriptUrl = buildGtmScriptUrl(gtmContainerId, gtmOpt?.testScriptUrl);
      const noscriptUrl = buildGtmNoscriptUrl(gtmContainerId, gtmOpt?.testNoscriptUrl);
      if (!scriptUrl || !noscriptUrl) return false;
      try {
        options.gtmAdapter.updateConsentMode(buildGoogleConsentModeUpdate(consent));
        options.gtmAdapter.loadGtm(gtmContainerId, scriptUrl, noscriptUrl, gtmOpt?.cspNonce);
        gtmLoaded = true;
      } catch (err) {
        errors.push({ provider: "gtm", phase: "load", message: toErrorMessage(err) });
        return false;
      }
    }
    return true;
  }

  function sendFirstPartyIfEligible(
    canonical: CanonicalSignalEvent,
    eventId: string,
    pagePath: string,
    nowMs: number,
    skipped: ProviderSkipRecord[],
    errors: ProviderErrorRecord[],
  ): boolean {
    if (!options.firstPartyAdapter) return false;
    const fpName = mapCanonicalToFirstPartyEvent(canonical);
    if (!fpName) return false;
    if (!isValidAnalyticsUuid(eventId)) return false;

    const channelKey = `ch:first_party:${eventId}`;
    if (dedupStore.has(channelKey, nowMs)) {
      skipped.push({ provider: "first_party", reason: "DUPLICATE_EVENT_ID" });
      return false;
    }

    let arrival: PersistedArrivalSource | null = null;
    if (options.getArrivalSource) {
      try {
        arrival = options.getArrivalSource();
      } catch {
        arrival = null;
      }
    }

    dedupStore.claim(channelKey, nowMs);
    try {
      options.firstPartyAdapter.sendEvent({
        eventId,
        eventName: fpName,
        path: pagePath,
        ...(options.defaultRouteKind ? { routeKind: options.defaultRouteKind } : {}),
        ...(arrival?.sourceCategory ? { sourceCategory: arrival.sourceCategory } : {}),
        ...(arrival?.referrerHost ? { referrerHost: arrival.referrerHost } : {}),
        ...(arrival?.utmSource ? { utmSource: arrival.utmSource } : {}),
        ...(arrival?.utmMedium ? { utmMedium: arrival.utmMedium } : {}),
      });
      return true;
    } catch (err) {
      errors.push({ provider: "first_party", phase: "send", message: toErrorMessage(err) });
      return false;
    }
  }

  function dispatchInternal(
    eventName: SignalEventAlias | string,
    rawParams?: Readonly<Record<string, unknown>>,
    restrictToProviders?: ReadonlySet<DirectAnalyticsProvider>,
    includeGtm = true,
    internalOpts?: {
      readonly isProgressivePageView?: boolean;
    },
  ): SignalDispatchReport {
    const nowMs = nowFn();
    const canonical = normalizeCanonicalSignalEvent(eventName);
    const sanitized = sanitizeAnalyticsSignalPayload(rawParams);
    const rawEventId =
      typeof sanitized.event_id === "string" && sanitized.event_id.length > 0
        ? sanitized.event_id
        : generateEventId();
    // Deterministically normalize ANY sanitized event_id (including non-UUID tokens like "abc_1")
    // to a valid RFC 4122 UUID BEFORE dispatching to ALL channels so /api/events, GTM dataLayer,
    // and direct GA4/Meta/TikTok always receive the exact same UUID and never diverge.
    const eventId = normalizeAnalyticsEventIdToUuid(rawEventId, tenantScope);
    sanitized.event_id = eventId;

    if (!sanitized.page_path && options.currentPath) {
      try {
        const resolved = sanitizeSignalPagePath(options.currentPath());
        if (resolved) sanitized.page_path = resolved;
      } catch {
        // Ignore path resolution errors
      }
    }

    if (!canonical) {
      return {
        ok: false,
        deduplicated: false,
        eventName: null,
        eventId,
        sanitizedParams: sanitized,
        deliveredTo: [],
        gtmEventPushed: null,
        firstPartySent: false,
        skipped: [],
        errors: [],
      };
    }

    const mapping = ANALYTICS_PROVIDER_EVENT_MAPPINGS[canonical];
    const deliveredTo: ProviderDeliveryRecord[] = [];
    const skipped: ProviderSkipRecord[] = [];
    const errors: ProviderErrorRecord[] = [];
    const isProgressivePageView = internalOpts?.isProgressivePageView === true;
    const logicalEventKey = `evt:${eventId}`;

    // Per-event 24h dedup by (tenantScope, eventId) across direct tags, GTM dataLayer & first-party
    if (!isProgressivePageView) {
      if (dedupStore.has(logicalEventKey, nowMs)) {
        for (const provider of DIRECT_ANALYTICS_PROVIDERS) {
          if (restrictToProviders && !restrictToProviders.has(provider)) continue;
          if (isProviderRoutedViaGtm(provider)) {
            skipped.push({ provider, reason: "ROUTED_VIA_GTM" });
          } else if (getProviderIdFromConfig(config, provider)) {
            skipped.push({ provider, reason: "DUPLICATE_EVENT_ID" });
          }
        }
        if (includeGtm && gtmEnabled && options.gtmAdapter) {
          skipped.push({ provider: "gtm", reason: "DUPLICATE_EVENT_ID" });
        }
        if (options.firstPartyAdapter) {
          skipped.push({ provider: "first_party", reason: "DUPLICATE_EVENT_ID" });
        }
        return {
          ok: true,
          deduplicated: true,
          eventName: canonical,
          eventId,
          sanitizedParams: sanitized,
          deliveredTo: [],
          gtmEventPushed: null,
          firstPartySent: false,
          skipped,
          errors: [],
        };
      }
      dedupStore.claim(logicalEventKey, nowMs);
    }

    const resolvedPagePath =
      typeof sanitized.page_path === "string" ? sanitized.page_path : "/";

    // Cookieless first-party event parity (same UUID as direct tags & GTM dataLayer).
    // Always skipped for `lead_submitted` because `POST /api/leads` already increments
    // `analytics_daily.lead_submits` authoritatively on durable persistence (prevents 2x count
    // whether called via `dispatchLeadSubmitted`, `trackEvent("lead_submitted")`, or DOM triggers).
    const firstPartySent =
      canonical === "lead_submitted"
        ? false
        : sendFirstPartyIfEligible(
            canonical,
            eventId,
            resolvedPagePath,
            nowMs,
            skipped,
            errors,
          );

    for (const provider of DIRECT_ANALYTICS_PROVIDERS) {
      if (restrictToProviders && !restrictToProviders.has(provider)) {
        continue;
      }
      if (isProviderRoutedViaGtm(provider)) {
        skipped.push({ provider, reason: "ROUTED_VIA_GTM" });
        continue;
      }
      const id = getProviderIdFromConfig(config, provider);
      if (!id) {
        skipped.push({ provider, reason: "NOT_CONFIGURED" });
        continue;
      }
      if (!canDispatchToProvider(provider, consent, expectedPolicyVersion)) {
        skipped.push({ provider, reason: "CONSENT_DENIED" });
        continue;
      }

      const providerChannelKey = `ch:${provider}:${eventId}`;
      if (dedupStore.has(providerChannelKey, nowMs)) {
        skipped.push({ provider, reason: "DUPLICATE_EVENT_ID" });
        continue;
      }

      // Ensure provider script is loaded before sending (only when consented)
      if (!loadedProviders.has(provider)) {
        const scriptUrl = buildProviderScriptUrl(provider, id, options.testScriptOverrides);
        if (!scriptUrl) {
          skipped.push({ provider, reason: "INVALID_ID" });
          continue;
        }
        try {
          options.adapter.loadProvider(provider, id, scriptUrl);
          loadedProviders.add(provider);
        } catch (err) {
          errors.push({ provider, phase: "load", message: toErrorMessage(err) });
          continue;
        }
      }

      const providerEventName = mapping.providers[provider].eventName;
      const tiktokMethod = mapping.providers.tiktok.method;

      dedupStore.claim(providerChannelKey, nowMs);
      try {
        options.adapter.sendEvent(provider, id, providerEventName, sanitized, {
          canonicalEvent: canonical,
          eventId,
          tiktokMethod,
        });
        deliveredTo.push({ provider, providerEventName, eventId });
      } catch (err) {
        errors.push({ provider, phase: "send", message: toErrorMessage(err) });
      }
    }

    let gtmEventPushed: PsDataLayerEventPayload | null = null;
    if (
      includeGtm &&
      gtmEnabled &&
      options.gtmAdapter &&
      canDispatchToGtm(consent, expectedPolicyVersion)
    ) {
      const gtmChannelKey = `ch:gtm:${eventId}`;
      if (dedupStore.has(gtmChannelKey, nowMs)) {
        skipped.push({ provider: "gtm", reason: "DUPLICATE_EVENT_ID" });
      } else {
        const ready = ensureGtmLoaded(errors);
        if (ready) {
          const psPayload = buildGtmEventForCanonical(
            canonical,
            eventId,
            resolvedPagePath,
            rawParams,
            gtmDefaults,
          );
          if (psPayload) {
            dedupStore.claim(gtmChannelKey, nowMs);
            try {
              options.gtmAdapter.pushDataLayerEvent(psPayload);
              gtmEventPushed = psPayload;
            } catch (err) {
              errors.push({ provider: "gtm", phase: "send", message: toErrorMessage(err) });
            }
          }
        }
      }
    }

    return {
      ok: errors.length === 0,
      deduplicated: false,
      eventName: canonical,
      eventId,
      sanitizedParams: sanitized,
      deliveredTo,
      gtmEventPushed,
      firstPartySent,
      skipped,
      errors,
    };
  }

  function updateConsent(next: Partial<AnalyticsConsentState>): readonly ProviderErrorRecord[] {
    const nextState: AnalyticsConsentState = {
      version:
        typeof next.version === "number" && Number.isInteger(next.version)
          ? next.version
          : expectedPolicyVersion,
      analytics: Boolean(next.analytics),
      marketing: Boolean(next.marketing),
      hasDecision: Boolean(next.hasDecision),
    };

    const errors: ProviderErrorRecord[] = [];
    const wasStorageAllowed = canPersistClientStorage();
    consent = nextState;
    if (wasStorageAllowed && !canPersistClientStorage()) {
      dedupStore.clearPersistedStorage();
    }

    const newlyConsentedForPageView = new Set<DirectAnalyticsProvider>();

    for (const provider of DIRECT_ANALYTICS_PROVIDERS) {
      if (isProviderRoutedViaGtm(provider)) continue;
      const id = getProviderIdFromConfig(config, provider);
      if (!id) continue;

      const allowed = canDispatchToProvider(provider, consent, expectedPolicyVersion);
      if (allowed) {
        if (!loadedProviders.has(provider)) {
          const scriptUrl = buildProviderScriptUrl(provider, id, options.testScriptOverrides);
          if (scriptUrl) {
            try {
              options.adapter.loadProvider(provider, id, scriptUrl);
              loadedProviders.add(provider);
            } catch (err) {
              errors.push({ provider, phase: "load", message: toErrorMessage(err) });
              continue;
            }
          }
        }
        if (autoPageView && !pageViewSentProviders.has(provider)) {
          newlyConsentedForPageView.add(provider);
        }
      } else {
        // Declined or revoked: immediately stop dispatch and notify adapter to tear down/disable
        pageViewSentProviders.delete(provider);
        if (loadedProviders.has(provider)) {
          loadedProviders.delete(provider);
          try {
            options.adapter.revokeProvider?.(provider, id);
          } catch (err) {
            errors.push({ provider, phase: "revoke", message: toErrorMessage(err) });
          }
        }
      }
    }

    let shouldSendGtmPageView = false;
    if (gtmEnabled && gtmContainerId && options.gtmAdapter) {
      ensureGtmConsentDefault(errors);
      const consentModeUpdate = buildGoogleConsentModeUpdate(consent);
      try {
        options.gtmAdapter.updateConsentMode(consentModeUpdate);
      } catch (err) {
        errors.push({ provider: "gtm", phase: "consent", message: toErrorMessage(err) });
      }

      if (canDispatchToGtm(consent, expectedPolicyVersion)) {
        const ready = ensureGtmLoaded(errors);
        if (ready && autoPageView && !gtmPageViewSent) {
          shouldSendGtmPageView = true;
        }
      } else {
        gtmPageViewSent = false;
        if (gtmLoaded) {
          gtmLoaded = false;
          try {
            options.gtmAdapter.revokeGtm?.(gtmContainerId);
          } catch (err) {
            errors.push({ provider: "gtm", phase: "revoke", message: toErrorMessage(err) });
          }
        }
      }
    }

    if (newlyConsentedForPageView.size > 0 || shouldSendGtmPageView) {
      const report = dispatchInternal(
        "page_view",
        { event_id: pageLoadEventId },
        newlyConsentedForPageView.size > 0 ? newlyConsentedForPageView : new Set(),
        shouldSendGtmPageView,
        { isProgressivePageView: true },
      );
      for (const delivered of report.deliveredTo) {
        pageViewSentProviders.add(delivered.provider);
      }
      if (report.gtmEventPushed) {
        gtmPageViewSent = true;
      }
      errors.push(...report.errors);
    }

    return errors;
  }

  /**
   * Dispatches `lead_submitted` at most ONCE per persisted `leadId` ONLY AFTER server persistence.
   *
   * Privacy-by-design non-retroactive rule:
   * - If visitor consent is NOT granted at the time of persistence, zero third-party vendor signals
   *   or GTM `ps_lead_submitted` events are emitted and the lead is NEVER queued for retroactive
   *   third-party dispatch if consent is granted later.
   */
  function dispatchLeadSubmitted(input: LeadSignalInput): LeadSignalResult {
    if (input.persisted !== true) {
      return {
        ok: false,
        reason: "NOT_PERSISTED",
        leadId: null,
      };
    }

    const normalizedLeadId = normalizeLeadId(input.leadId);
    if (!normalizedLeadId) {
      return {
        ok: false,
        reason: "INVALID_LEAD_ID",
        leadId: null,
      };
    }

    const nowMs = nowFn();
    const rawLeadEventId =
      sanitizeClientEventId(input.eventId) ??
      deriveDeterministicLeadEventId(normalizedLeadId, tenantScope);
    const eventId = normalizeAnalyticsEventIdToUuid(rawLeadEventId, tenantScope);

    const markerKey = `lead_${normalizedLeadId}`;
    if (dispatchedLeadIds.has(normalizedLeadId) || dedupStore.has(`evt:${eventId}`, nowMs)) {
      dispatchedLeadIds.add(normalizedLeadId);
      return {
        ok: false,
        reason: "DUPLICATE_LEAD_ID",
        leadId: normalizedLeadId,
      };
    }

    if (canPersistClientStorage()) {
      try {
        if (options.hasPersistedLeadMarker?.(markerKey)) {
          dispatchedLeadIds.add(normalizedLeadId);
          return {
            ok: false,
            reason: "DUPLICATE_LEAD_ID",
            leadId: normalizedLeadId,
          };
        }
      } catch {
        // Storage unavailable (e.g. private browsing) — continue with in-memory dedup set
      }
    }

    dispatchedLeadIds.add(normalizedLeadId);
    if (canPersistClientStorage()) {
      try {
        options.savePersistedLeadMarker?.(markerKey);
      } catch {
        // Non-blocking
      }
    }

    const report = dispatchInternal("lead_submitted", {
      ...(input.extra ?? {}),
      event_id: eventId,
      lead_ref: markerKey,
      content_type: "contact_form",
      ...(input.formId ? { form_id: input.formId } : {}),
      ...(input.page_path ? { page_path: input.page_path } : {}),
      ...(input.content_category ? { content_category: input.content_category } : {}),
    });

    return {
      ok: true,
      leadId: normalizedLeadId,
      report,
    };
  }

  // Emit ONE cookieless first-party `page_view` (no cookies, no third-party tags) sharing `pageLoadEventId`.
  if (autoPageView && options.firstPartyAdapter) {
    let initialPath = "/";
    if (options.currentPath) {
      try {
        initialPath = sanitizeSignalPagePath(options.currentPath()) ?? "/";
      } catch {
        initialPath = "/";
      }
    }
    sendFirstPartyIfEligible("page_view", pageLoadEventId, initialPath, nowFn(), [], []);
  }

  // Apply explicit initial consent ONLY if caller already has an affirmative decision
  if (options.initialConsent?.hasDecision) {
    updateConsent(options.initialConsent);
  }

  return {
    getState: () => ({
      config,
      consent: { ...consent },
      loadedProviders: [...loadedProviders],
      activeProviders: getActiveProviders(),
      dispatchedLeadIds: [...dispatchedLeadIds],
      gtmEnabled,
      gtmContainerId,
      gtmLoaded,
    }),
    updateConsent,
    dispatch: (eventName, rawParams) => dispatchInternal(eventName, rawParams),
    dispatchLeadSubmitted,
  };
}

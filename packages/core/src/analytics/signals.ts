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
 * (`packages/core/src/analytics/signals.ts`; TASK-022, REQ-027, REQ-017, REQ-033, REQ-039).
 *
 * Core security & privacy invariants:
 * 1. STRICT ZERO-TAGS-BEFORE-CONSENT: defaults strictly to `{ analytics: false, marketing: false }`.
 *    No vendor script loads and no signal dispatches until explicit visitor consent is granted
 *    for the provider's category (`analytics` for GA4; `marketing` for Meta & TikTok).
 * 2. IMMEDIATE HALT ON DECLINE/REVOCATION: revoking consent immediately stops all future
 *    dispatches and notifies the adapter to tear down / disable vendor tags.
 * 3. ONE LEAD SIGNAL AFTER PERSISTENCE: `dispatchLeadSubmitted` requires `persisted === true`
 *    and a valid positive `leadId`, and deduplicates strictly by `leadId` so a persisted lead
 *    can fire at most ONCE across retries, double-clicks, or repeated DOM observations.
 * 4. ZERO PII LEAKAGE: allowlist-first sanitization + forbidden-field denylist + email/phone
 *    regex scrubbing guarantees visitor name, email, phone, message, and raw query strings
 *    are NEVER forwarded to GA4, Meta Pixel, or TikTok Pixel.
 * 5. FAULT ISOLATION: every provider load/dispatch/revoke call is wrapped in `try/catch` so
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
  readonly provider: DirectAnalyticsProvider;
  readonly reason: "NOT_CONFIGURED" | "CONSENT_DENIED" | "INVALID_ID";
}

export interface ProviderErrorRecord {
  readonly provider: DirectAnalyticsProvider;
  readonly phase: "load" | "send" | "revoke";
  readonly message: string;
}

export interface SignalDispatchReport {
  readonly ok: boolean;
  readonly eventName: CanonicalSignalEvent | null;
  readonly eventId: string;
  readonly sanitizedParams: SanitizedSignalParams;
  readonly deliveredTo: readonly ProviderDeliveryRecord[];
  readonly skipped: readonly ProviderSkipRecord[];
  readonly errors: readonly ProviderErrorRecord[];
}

export interface LeadSignalInput {
  readonly leadId: number | string | null | undefined;
  readonly persisted: boolean;
  readonly eventId?: string;
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

export interface AnalyticsDispatcherOptions {
  readonly config: Partial<DirectAnalyticsConfig> | null | undefined;
  readonly adapter: AnalyticsProviderAdapter;
  readonly expectedPolicyVersion?: number;
  readonly initialConsent?: Partial<AnalyticsConsentState> | null;
  readonly autoPageView?: boolean;
  readonly currentPath?: () => string;
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

function defaultEventId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    }
  } catch {
    // Fallback below
  }
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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

export function createAnalyticsSignalDispatcher(
  options: AnalyticsDispatcherOptions,
): AnalyticsSignalDispatcher {
  const expectedPolicyVersion = options.expectedPolicyVersion ?? 1;
  const autoPageView = options.autoPageView ?? true;
  const config = parseStoredDirectAnalyticsConfig(options.config);
  const generateEventId = options.generateEventId ?? defaultEventId;

  let consent: AnalyticsConsentState = {
    version: options.initialConsent?.version ?? expectedPolicyVersion,
    analytics: false,
    marketing: false,
    hasDecision: false,
  };

  const loadedProviders = new Set<DirectAnalyticsProvider>();
  const pageViewSentProviders = new Set<DirectAnalyticsProvider>();
  const dispatchedLeadIds = new Set<string>();

  function getActiveProviders(): DirectAnalyticsProvider[] {
    const active: DirectAnalyticsProvider[] = [];
    for (const provider of DIRECT_ANALYTICS_PROVIDERS) {
      const id = getProviderIdFromConfig(config, provider);
      if (id && canDispatchToProvider(provider, consent, expectedPolicyVersion)) {
        active.push(provider);
      }
    }
    return active;
  }

  function dispatchInternal(
    eventName: SignalEventAlias | string,
    rawParams?: Readonly<Record<string, unknown>>,
    restrictToProviders?: ReadonlySet<DirectAnalyticsProvider>,
  ): SignalDispatchReport {
    const canonical = normalizeCanonicalSignalEvent(eventName);
    const sanitized = sanitizeAnalyticsSignalPayload(rawParams);
    const eventId =
      typeof sanitized.event_id === "string" && sanitized.event_id.length > 0
        ? sanitized.event_id
        : generateEventId();
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
        eventName: null,
        eventId,
        sanitizedParams: sanitized,
        deliveredTo: [],
        skipped: [],
        errors: [],
      };
    }

    const mapping = ANALYTICS_PROVIDER_EVENT_MAPPINGS[canonical];
    const deliveredTo: ProviderDeliveryRecord[] = [];
    const skipped: ProviderSkipRecord[] = [];
    const errors: ProviderErrorRecord[] = [];

    for (const provider of DIRECT_ANALYTICS_PROVIDERS) {
      if (restrictToProviders && !restrictToProviders.has(provider)) {
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

    return {
      ok: errors.length === 0,
      eventName: canonical,
      eventId,
      sanitizedParams: sanitized,
      deliveredTo,
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
    consent = nextState;

    const newlyConsentedForPageView = new Set<DirectAnalyticsProvider>();

    for (const provider of DIRECT_ANALYTICS_PROVIDERS) {
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

    if (newlyConsentedForPageView.size > 0) {
      const report = dispatchInternal("page_view", undefined, newlyConsentedForPageView);
      for (const delivered of report.deliveredTo) {
        pageViewSentProviders.add(delivered.provider);
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
   *   are emitted and the lead is NEVER queued for retroactive third-party dispatch if consent is
   *   granted later (first-party cookieless counts still record server-side on `POST /api/leads`).
   */
  function dispatchLeadSubmitted(input: LeadSignalInput): LeadSignalResult {
    // Strict invariant: NEVER fire lead conversion signal before server persistence is confirmed!
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

    const markerKey = `lead_${normalizedLeadId}`;
    if (dispatchedLeadIds.has(normalizedLeadId)) {
      return {
        ok: false,
        reason: "DUPLICATE_LEAD_ID",
        leadId: normalizedLeadId,
      };
    }

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

    dispatchedLeadIds.add(normalizedLeadId);
    try {
      options.savePersistedLeadMarker?.(markerKey);
    } catch {
      // Non-blocking
    }

    const eventId = input.eventId?.trim() || `lead_${normalizedLeadId}`;
    const report = dispatchInternal("lead_submitted", {
      ...(input.extra ?? {}),
      event_id: eventId,
      lead_ref: markerKey,
      content_type: "contact_form",
      ...(input.page_path ? { page_path: input.page_path } : {}),
      ...(input.content_category ? { content_category: input.content_category } : {}),
    });

    return {
      ok: true,
      leadId: normalizedLeadId,
      report,
    };
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
    }),
    updateConsent,
    dispatch: (eventName, rawParams) => dispatchInternal(eventName, rawParams),
    dispatchLeadSubmitted,
  };
}

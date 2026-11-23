import {
  type AnalyticsHeadBootstrapPayload,
} from "@punyasitus/core/analytics/config";
import {
  type GoogleConsentModeV2DefaultParams,
  type GoogleConsentModeV2UpdateParams,
  type PsDataLayerEventPayload,
} from "@punyasitus/core/analytics/gtm";
import {
  type DirectAnalyticsProvider,
  type SignalEventAlias,
} from "@punyasitus/core/analytics/providers";
import {
  createAnalyticsSignalDispatcher,
  type AnalyticsConsentState,
  type AnalyticsGtmAdapter,
  type AnalyticsProviderAdapter,
  type AnalyticsSignalDispatcher,
  type LeadSignalInput,
  type LeadSignalResult,
  type SanitizedSignalParams,
  type SignalDispatchReport,
} from "@punyasitus/core/analytics/signals";

/**
 * Public-Site Consent-Aware Direct Analytics & Easy GTM Runtime
 * (`apps/web/src/scripts/analytics.ts`;
 * TASK-022 & TASK-076, REQ-027, REQ-017, REQ-033, REQ-039, PLAN §18.1).
 *
 * Guarantees:
 * - Zero GA4 / Meta Pixel / TikTok Pixel / GTM `<script>` tags or network calls until explicit
 *   visitor consent (`analytics` for GA4 & GTM; `marketing` for Meta & TikTok) is granted via
 *   `Consent.astro` (`__Host-ps_consent` cookie / `punyasitus:consent-change` event).
 * - Google Consent Mode v2 defaults are set to `denied` BEFORE GTM ever loads and update on
 *   every consent grant, change, or revocation.
 * - Standard PII-free `ps_*` `dataLayer` events (`ps_page_view`, `ps_wa_click`,
 *   `ps_external_click` with host-only `destination_host`, `ps_lead_submitted` once per persisted lead).
 * - Official vendor bootstrap shims:
 *   - GA4 `gtag()` pushes real `IArguments` objects onto `window.dataLayer` (required by `gtag.js`).
 *   - Meta `fbq` matches official `callMethod.apply` / `queue.push(arguments)` + `_fbq` / `loaded` / `version = "2.0"`.
 *   - TikTok `ttq` matches official `TiktokAnalyticsObject = "ttq"`, `methods`, `setAndDefer`, `instance`, `load` (`_i`/`_t`/`_o`).
 * - Immediate teardown & halt on decline or consent revocation.
 * - Full `try/catch` fault isolation around every vendor/GTM call & script load so blocked or
 *   throwing ad-network/GTM scripts NEVER break WhatsApp CTAs, external links, or contact forms.
 */

interface ConsentWindowEventDetail {
  readonly preferences?: {
    readonly version?: number;
    readonly analytics?: boolean;
    readonly marketing?: boolean;
  };
  readonly hasDecision?: boolean;
  readonly withdrawn?: boolean;
}

interface LeadPersistedEventDetail {
  readonly leadId?: number | string;
  readonly persisted?: boolean;
  readonly eventId?: string;
  readonly formId?: string;
  readonly page_path?: string;
  readonly content_category?: string;
}

export interface PunyaSitusAnalyticsGlobal {
  readonly trackEvent: (
    eventName: SignalEventAlias | string,
    params?: Readonly<Record<string, unknown>>,
  ) => SignalDispatchReport;
  readonly trackLeadSubmitted: (input: LeadSignalInput) => LeadSignalResult;
  readonly updateConsent: (next: Partial<AnalyticsConsentState>) => void;
  readonly getState: AnalyticsSignalDispatcher["getState"];
}

export interface MetaFbqFunction {
  (...args: unknown[]): void;
  callMethod?: (...args: unknown[]) => void;
  queue?: IArguments[];
  loaded?: boolean;
  version?: string;
  push?: MetaFbqFunction;
}

export interface TikTokInstanceQueue extends Array<unknown> {
  _u?: string;
  [method: string]: unknown;
}

export interface TikTokQueueGlobal extends Array<unknown> {
  methods?: string[];
  setAndDefer?: (target: TikTokInstanceQueue | TikTokQueueGlobal, method: string) => void;
  instance?: (pixelId: string) => TikTokInstanceQueue;
  load?: (pixelId: string, options?: Record<string, unknown>) => void;
  page?: (props?: Record<string, unknown>) => void;
  track?: (
    event: string,
    props?: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => void;
  revokeConsent?: () => void;
  grantConsent?: () => void;
  _i?: Record<string, TikTokInstanceQueue>;
  _t?: Record<string, number>;
  _o?: Record<string, Record<string, unknown>>;
  [method: string]: unknown;
}

export interface AnalyticsBrowserWindow {
  __punyasitusConsent?: {
    readonly version?: number;
    readonly analytics?: boolean;
    readonly marketing?: boolean;
    readonly hasDecision?: boolean;
  };
  __punyasitusAnalytics?: PunyaSitusAnalyticsGlobal;
  __psConsentDefaultSet?: boolean;
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  fbq?: MetaFbqFunction;
  _fbq?: MetaFbqFunction;
  TiktokAnalyticsObject?: string;
  ttq?: TikTokQueueGlobal;
  [key: string]: unknown;
}

export const TIKTOK_OFFICIAL_METHODS = [
  "page",
  "track",
  "identify",
  "instances",
  "debug",
  "on",
  "off",
  "once",
  "ready",
  "alias",
  "group",
  "enableCookie",
  "disableCookie",
  "holdConsent",
  "revokeConsent",
  "grantConsent",
] as const;

const LEAD_SESSION_STORAGE_PREFIX = "ps_lead_sig_v1:";
const PRG_LEAD_SUBMIT_PENDING_KEY = "ps_lead_submit_pending";
const PRG_LEAD_SUBMIT_TTL_MS = 5 * 60 * 1000;
const GTM_CSP_RELOAD_GUARD_KEY = "ps_gtm_csp_reload_v1";
const GTM_CSP_RELOAD_COOLDOWN_MS = 15_000;

/**
 * Determines whether granting analytics consent on a GTM-enabled page that was originally
 * served under `strict` CSP (before consent) should perform a single guarded reload so the
 * server responds with the fresh per-response nonce and `gtm-relaxed` CSP header.
 *
 * Loop-safe: records a short-lived `sessionStorage` guard keyed by pathname so a page can
 * NEVER enter a reload loop if cookies are blocked or the server stays on strict CSP.
 */
export function shouldReloadForConsentedGtmCsp(params: {
  readonly gtmEnabled: boolean;
  readonly cspProfile: "strict" | "gtm-relaxed";
  readonly ssrLoaded: boolean;
  readonly nextAnalyticsGranted: boolean;
  readonly pathname: string;
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;
  readonly nowMs?: number;
}): boolean {
  const nowMs = params.nowMs ?? Date.now();

  if (params.cspProfile === "gtm-relaxed" || params.ssrLoaded) {
    try {
      params.storage?.removeItem(GTM_CSP_RELOAD_GUARD_KEY);
    } catch {
      // Ignore disabled storage
    }
    return false;
  }

  if (!params.gtmEnabled || !params.nextAnalyticsGranted) {
    return false;
  }

  try {
    const raw = params.storage?.getItem(GTM_CSP_RELOAD_GUARD_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { readonly path?: string; readonly at?: number };
      if (
        parsed.path === params.pathname &&
        typeof parsed.at === "number" &&
        nowMs - parsed.at >= 0 &&
        nowMs - parsed.at < GTM_CSP_RELOAD_COOLDOWN_MS
      ) {
        return false;
      }
    }
    params.storage?.setItem(
      GTM_CSP_RELOAD_GUARD_KEY,
      JSON.stringify({ path: params.pathname, at: nowMs }),
    );
    return true;
  } catch {
    // If sessionStorage is blocked, do not risk an unguarded reload loop
    return false;
  }
}

/**
 * Official GA4 `gtag()` shim: MUST push real `IArguments` objects onto `window.dataLayer`
 * because production `gtag.js` and GTM Consent Mode ignore plain `Array` entries.
 */
export function ensureOfficialGtagShim(win: AnalyticsBrowserWindow): void {
  if (!Array.isArray(win.dataLayer)) {
    win.dataLayer = [];
  }
  if (typeof win.gtag !== "function") {
    win.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      win.dataLayer?.push(arguments);
    };
  }
}

/**
 * Sets Google Consent Mode v2 defaults to `denied` exactly once BEFORE any GTM load.
 */
export function ensureConsentModeV2DefaultDenied(
  win: AnalyticsBrowserWindow,
  defaults: GoogleConsentModeV2DefaultParams,
): void {
  ensureOfficialGtagShim(win);
  if (win.__psConsentDefaultSet) return;
  win.gtag?.("consent", "default", { ...defaults });
  win.__psConsentDefaultSet = true;
}

/**
 * Pushes a Google Consent Mode v2 update onto `window.dataLayer` via `gtag("consent", "update", ...)`.
 */
export function updateGoogleConsentModeV2(
  win: AnalyticsBrowserWindow,
  update: GoogleConsentModeV2UpdateParams,
): void {
  ensureOfficialGtagShim(win);
  win.gtag?.("consent", "update", { ...update });
}

/**
 * Official Meta Pixel `fbq` bootstrap shim (`callMethod.apply` / `queue.push(arguments)`,
 * `push = fbq`, `loaded = true`, `version = "2.0"`, `_fbq = fbq`).
 */
export function ensureOfficialFbqShim(win: AnalyticsBrowserWindow): void {
  if (typeof win.fbq === "function") return;
  const fbqFn: MetaFbqFunction = function fbq() {
    if (typeof fbqFn.callMethod === "function") {
      // eslint-disable-next-line prefer-rest-params, prefer-spread
      fbqFn.callMethod.apply(fbqFn, arguments as unknown as unknown[]);
    } else {
      // eslint-disable-next-line prefer-rest-params
      fbqFn.queue?.push(arguments);
    }
  };
  if (!win._fbq) win._fbq = fbqFn;
  fbqFn.push = fbqFn;
  fbqFn.loaded = true;
  fbqFn.version = "2.0";
  fbqFn.queue = [];
  win.fbq = fbqFn;
}

/**
 * Official TikTok Events SDK `ttq` bootstrap shim (`TiktokAnalyticsObject = "ttq"`,
 * `methods`, `setAndDefer`, `instance`, and `load` initializing `_i`, `_t`, `_o`).
 */
export function ensureOfficialTtqShim(
  win: AnalyticsBrowserWindow,
  scriptUrl = "https://analytics.tiktok.com/i18n/pixel/events.js",
): void {
  win.TiktokAnalyticsObject = "ttq";
  if (win.ttq && typeof win.ttq.load === "function" && typeof win.ttq.setAndDefer === "function") {
    return;
  }
  const ttq = (win.ttq = (win.ttq || []) as TikTokQueueGlobal);
  ttq.methods = [...TIKTOK_OFFICIAL_METHODS];
  ttq.setAndDefer = function setAndDefer(
    target: TikTokInstanceQueue | TikTokQueueGlobal,
    method: string,
  ) {
    target[method] = function () {
      // eslint-disable-next-line prefer-rest-params
      target.push([method].concat(Array.prototype.slice.call(arguments, 0)));
    };
  };
  for (let i = 0; i < ttq.methods.length; i += 1) {
    const methodName = ttq.methods[i];
    if (methodName) ttq.setAndDefer(ttq, methodName);
  }
  ttq.instance = function instance(pixelId: string): TikTokInstanceQueue {
    const inst = (ttq._i?.[pixelId] || []) as unknown as TikTokInstanceQueue;
    const methods = ttq.methods ?? [];
    for (let i = 0; i < methods.length; i += 1) {
      const methodName = methods[i];
      if (methodName) ttq.setAndDefer?.(inst, methodName);
    }
    return inst;
  };
  ttq.load = function load(pixelId: string, options?: Record<string, unknown>) {
    ttq._i = ttq._i || {};
    const queue = [] as unknown as TikTokInstanceQueue;
    queue._u = scriptUrl;
    ttq._i[pixelId] = queue;
    ttq._t = ttq._t || {};
    ttq._t[pixelId] = +new Date();
    ttq._o = ttq._o || {};
    ttq._o[pixelId] = options || {};
  };
}

function readConsentFromBrowserCookie(
  cookieName: string,
  expectedPolicyVersion: number,
): AnalyticsConsentState {
  const fallback: AnalyticsConsentState = {
    version: expectedPolicyVersion,
    analytics: false,
    marketing: false,
    hasDecision: false,
  };

  try {
    const raw = document.cookie || "";
    if (!raw) return fallback;
    const parts = raw.split(";");
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      if (part.slice(0, eq).trim() !== cookieName) continue;
      const decoded = decodeURIComponent(part.slice(eq + 1).trim());
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.version === expectedPolicyVersion &&
        typeof parsed.analytics === "boolean" &&
        typeof parsed.marketing === "boolean" &&
        typeof parsed.updatedAt === "string" &&
        parsed.updatedAt.length > 0
      ) {
        return {
          version: expectedPolicyVersion,
          analytics: parsed.analytics,
          marketing: parsed.marketing,
          hasDecision: true,
        };
      }
    }
  } catch {
    // Malformed cookie strictly falls back to default-deny
  }
  return fallback;
}

function readInitialBrowserConsent(
  win: AnalyticsBrowserWindow,
  cookieName: string,
  expectedPolicyVersion: number,
): AnalyticsConsentState {
  const fromGlobal = win.__punyasitusConsent;
  if (
    fromGlobal &&
    typeof fromGlobal === "object" &&
    fromGlobal.hasDecision === true &&
    fromGlobal.version === expectedPolicyVersion &&
    typeof fromGlobal.analytics === "boolean" &&
    typeof fromGlobal.marketing === "boolean"
  ) {
    return {
      version: expectedPolicyVersion,
      analytics: fromGlobal.analytics,
      marketing: fromGlobal.marketing,
      hasDecision: true,
    };
  }
  return readConsentFromBrowserCookie(cookieName, expectedPolicyVersion);
}

function injectVendorScriptTag(provider: DirectAnalyticsProvider, scriptUrl: string): void {
  const existing = document.querySelector(
    `script[data-ps-analytics-vendor="${provider}"][data-ps-analytics-loaded="true"]`,
  );
  if (existing) return;

  const script = document.createElement("script");
  script.async = true;
  script.src = scriptUrl;
  script.dataset.psAnalyticsVendor = provider;
  script.dataset.psAnalyticsLoaded = "true";
  // Swallow network/ad-blocker script load failures cleanly so pages never fail
  script.addEventListener("error", () => {
    script.dataset.psAnalyticsLoadError = "true";
  });
  (document.head ?? document.documentElement).appendChild(script);
}

function removeVendorScriptTag(provider: DirectAnalyticsProvider): void {
  const scripts = document.querySelectorAll(`script[data-ps-analytics-vendor="${provider}"]`);
  for (const node of scripts) {
    node.remove();
  }
}

function injectGtmScriptTag(containerId: string, scriptUrl: string, nonce?: string): void {
  const existing = document.querySelector(
    `script[data-ps-gtm-loaded="true"][data-ps-gtm-container="${CSS.escape(containerId)}"]`,
  );
  if (existing) return;

  const script = document.createElement("script");
  script.async = true;
  script.src = scriptUrl;
  script.dataset.psGtmLoaded = "true";
  script.dataset.psGtmContainer = containerId;
  if (nonce) {
    script.setAttribute("nonce", nonce);
  }
  script.addEventListener("error", () => {
    script.dataset.psGtmLoadError = "true";
  });
  (document.head ?? document.documentElement).appendChild(script);
}

function removeGtmElements(): void {
  const scripts = document.querySelectorAll('script[data-ps-gtm-loaded="true"]');
  for (const node of scripts) {
    node.remove();
  }
  const noscripts = document.querySelectorAll('noscript[data-ps-gtm-noscript="true"]');
  for (const node of noscripts) {
    node.remove();
  }
}

export function createBrowserProviderAdapter(
  win: AnalyticsBrowserWindow,
  injectScript: (provider: DirectAnalyticsProvider, scriptUrl: string) => void = injectVendorScriptTag,
  removeScript: (provider: DirectAnalyticsProvider) => void = removeVendorScriptTag,
): AnalyticsProviderAdapter {
  return {
    loadProvider(provider, providerId, scriptUrl) {
      if (provider === "ga4") {
        win[`ga-disable-${providerId}`] = false;
        ensureOfficialGtagShim(win);
        injectScript("ga4", scriptUrl);
        win.gtag?.("js", new Date());
        win.gtag?.("config", providerId, { send_page_view: false });
        return;
      }

      if (provider === "meta") {
        ensureOfficialFbqShim(win);
        injectScript("meta", scriptUrl);
        win.fbq?.("consent", "grant");
        win.fbq?.("init", providerId);
        return;
      }

      if (provider === "tiktok") {
        ensureOfficialTtqShim(win, scriptUrl);
        injectScript("tiktok", scriptUrl);
        win.ttq?.load?.(providerId);
        win.ttq?.grantConsent?.();
      }
    },

    sendEvent(provider, _providerId, providerEventName, params: SanitizedSignalParams, meta) {
      if (provider === "ga4") {
        ensureOfficialGtagShim(win);
        win.gtag?.("event", providerEventName, { ...params });
        return;
      }

      if (provider === "meta") {
        ensureOfficialFbqShim(win);
        const metaParams: Record<string, string | number | boolean> = { ...params };
        delete metaParams.event_id;
        win.fbq?.("track", providerEventName, metaParams, { eventID: meta.eventId });
        return;
      }

      if (provider === "tiktok") {
        ensureOfficialTtqShim(win);
        const ttParams: Record<string, string | number | boolean> = { ...params };
        delete ttParams.event_id;
        if (meta.tiktokMethod === "page") {
          win.ttq?.page?.(ttParams);
        } else {
          win.ttq?.track?.(providerEventName, ttParams, { event_id: meta.eventId });
        }
      }
    },

    revokeProvider(provider, providerId) {
      removeScript(provider);
      if (provider === "ga4") {
        win[`ga-disable-${providerId}`] = true;
      } else if (provider === "meta") {
        win.fbq?.("consent", "revoke");
      } else if (provider === "tiktok") {
        win.ttq?.revokeConsent?.();
      }
    },
  };
}

export function createBrowserGtmAdapter(
  win: AnalyticsBrowserWindow,
  injectGtm: (containerId: string, scriptUrl: string, nonce?: string) => void = injectGtmScriptTag,
  removeGtm: () => void = removeGtmElements,
): AnalyticsGtmAdapter {
  return {
    initConsentDefault(defaults) {
      ensureConsentModeV2DefaultDenied(win, defaults);
    },

    updateConsentMode(update) {
      updateGoogleConsentModeV2(win, update);
    },

    loadGtm(containerId, scriptUrl, _noscriptUrl, nonce) {
      ensureOfficialGtagShim(win);
      win.dataLayer?.push({ "gtm.start": Date.now(), event: "gtm.js" });
      injectGtm(containerId, scriptUrl, nonce);
    },

    pushDataLayerEvent(payload: PsDataLayerEventPayload) {
      ensureOfficialGtagShim(win);
      win.dataLayer?.push({ ...payload });
    },

    revokeGtm() {
      removeGtm();
    },
  };
}

function isWhatsAppHref(href: string): boolean {
  try {
    const parsed = new URL(href, window.location.origin);
    const host = parsed.hostname.toLowerCase();
    return host === "wa.me" || host === "api.whatsapp.com" || host === "web.whatsapp.com";
  } catch {
    return false;
  }
}

function extractAcceptedLeadIdFromText(text: string): string | null {
  const match = text.match(/\(#([1-9][0-9]{0,12})\)/);
  return match?.[1] ?? null;
}

function readBootstrapPayload(): AnalyticsHeadBootstrapPayload | null {
  const el = document.querySelector<HTMLScriptElement>(
    'script[data-ps-analytics-config="true"]#ps-analytics-config, script[data-ps-analytics-config="true"]',
  );
  if (!el || !el.textContent) return null;
  try {
    const parsed = JSON.parse(el.textContent) as AnalyticsHeadBootstrapPayload;
    if (!parsed || typeof parsed !== "object" || !parsed.providers) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Consumes a fresh same-session form-submit marker (`ps_lead_submit_pending`) so that
 * SSR PRG query params (`?leadStatus=accepted&leadNumber=N`) only trigger a conversion
 * when paired with a real same-session lead form submission (blocks crafted-URL forging).
 */
export function consumeFreshPrgLeadSubmitMarker(
  storage: Pick<Storage, "getItem" | "removeItem"> | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(PRG_LEAD_SUBMIT_PENDING_KEY);
    storage.removeItem(PRG_LEAD_SUBMIT_PENDING_KEY);
    if (!raw) return false;
    const submittedAt = Number(raw);
    if (!Number.isFinite(submittedAt)) return false;
    const age = nowMs - submittedAt;
    return age >= 0 && age <= PRG_LEAD_SUBMIT_TTL_MS;
  } catch {
    return false;
  }
}

function attachLeadPersistenceObservers(dispatcher: AnalyticsSignalDispatcher): void {
  const currentPath = () => window.location.pathname || "/";

  // 0. Record a short-lived same-session marker when a native lead form submits (for PRG fallback)
  document.addEventListener(
    "submit",
    (event) => {
      try {
        const target = event.target;
        if (target instanceof HTMLFormElement && target.dataset.leadForm === "true") {
          window.sessionStorage.setItem(PRG_LEAD_SUBMIT_PENDING_KEY, String(Date.now()));
        }
      } catch {
        // Ignore private browsing / disabled storage
      }
    },
    { capture: true, passive: true },
  );

  // 1. SSR PRG confirmation banner (`?leadStatus=accepted&leadNumber=42`), gated by same-session submit marker
  try {
    const prgBanner = document.querySelector<HTMLElement>(
      '[data-testid="lead-form-status"][data-status="accepted"]',
    );
    if (prgBanner) {
      const params = new URLSearchParams(window.location.search);
      const leadStatus = params.get("leadStatus");
      const leadNumber = params.get("leadNumber");
      if (
        leadStatus === "accepted" &&
        leadNumber &&
        /^[1-9][0-9]{0,12}$/.test(leadNumber) &&
        consumeFreshPrgLeadSubmitMarker(window.sessionStorage)
      ) {
        const formId =
          prgBanner.closest<HTMLElement>("[data-ps-form-id]")?.dataset.psFormId ??
          prgBanner.dataset.formId ??
          "contact_default";
        dispatcher.dispatchLeadSubmitted({
          leadId: leadNumber,
          persisted: true,
          formId,
          page_path: currentPath(),
        });
      }
    }
  } catch {
    // Non-blocking
  }

  // 2. Progressive-enhancement `SectionContactForm.astro` live confirmation observer
  try {
    const liveBanners = document.querySelectorAll<HTMLElement>(
      '[data-testid="lead-form-live-status"]',
    );
    const checkLiveBanner = (banner: HTMLElement) => {
      if (banner.dataset.status !== "accepted" || banner.hidden) return;
      const leadId =
        banner.dataset.leadId || extractAcceptedLeadIdFromText(banner.textContent || "");
      if (!leadId) return;
      try {
        window.sessionStorage.removeItem(PRG_LEAD_SUBMIT_PENDING_KEY);
      } catch {
        // Non-blocking
      }
      const formId =
        banner.dataset.formId ??
        banner.closest<HTMLElement>("[data-ps-form-id]")?.dataset.psFormId ??
        banner.closest<HTMLFormElement>("form")?.id ??
        "contact_default";
      dispatcher.dispatchLeadSubmitted({
        leadId,
        persisted: true,
        formId,
        page_path: currentPath(),
      });
    };

    for (const banner of liveBanners) {
      checkLiveBanner(banner);
      if (typeof MutationObserver === "function") {
        const observer = new MutationObserver(() => checkLiveBanner(banner));
        observer.observe(banner, {
          attributes: true,
          attributeFilter: ["data-status", "data-lead-id", "hidden"],
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    }
  } catch {
    // Non-blocking
  }

  // 3. Explicit custom event hook (`window.dispatchEvent(new CustomEvent("punyasitus:lead-persisted", ...))`)
  window.addEventListener("punyasitus:lead-persisted", (event) => {
    try {
      const detail = (event as CustomEvent<LeadPersistedEventDetail>).detail;
      if (!detail || detail.persisted !== true) return;
      dispatcher.dispatchLeadSubmitted({
        leadId: detail.leadId,
        persisted: true,
        eventId: detail.eventId,
        formId: detail.formId,
        page_path: detail.page_path ?? currentPath(),
        content_category: detail.content_category,
      });
    } catch {
      // Non-blocking
    }
  });
}

function attachNonBlockingCtaListeners(dispatcher: AnalyticsSignalDispatcher): void {
  document.addEventListener(
    "click",
    (event) => {
      try {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        const explicitEl = target.closest<HTMLElement>("[data-ps-analytics-event]");
        if (explicitEl) {
          const eventName = explicitEl.dataset.psAnalyticsEvent;
          if (eventName) {
            const href =
              explicitEl instanceof HTMLAnchorElement
                ? explicitEl.getAttribute("href") || undefined
                : explicitEl.closest<HTMLAnchorElement>("a[href]")?.getAttribute("href") || undefined;
            dispatcher.dispatch(eventName, {
              page_path: window.location.pathname || "/",
              content_category: explicitEl.dataset.psAnalyticsCategory,
              content_type: explicitEl.dataset.psAnalyticsContentType,
              cta_mode: explicitEl.dataset.psAnalyticsCtaMode,
              item_id: explicitEl.dataset.psItemId,
              item_title: explicitEl.dataset.psItemTitle,
              placement: explicitEl.dataset.psPlacement,
              destination_url: href,
            });
            return;
          }
        }

        const anchor = target.closest<HTMLAnchorElement>("a[href]");
        if (!anchor) return;
        const href = anchor.getAttribute("href") || "";
        if (!href) return;

        if (isWhatsAppHref(href)) {
          dispatcher.dispatch("whatsapp_click", {
            page_path: window.location.pathname || "/",
            cta_mode: "whatsapp",
            content_type: "whatsapp",
            item_id: anchor.dataset.psItemId,
            item_title: anchor.dataset.psItemTitle,
            placement: anchor.dataset.psPlacement ?? "other",
          });
        } else if (anchor.dataset.psExternalCta === "true") {
          dispatcher.dispatch("external_click", {
            page_path: window.location.pathname || "/",
            cta_mode: "external_link",
            content_type: "external",
            item_id: anchor.dataset.psItemId,
            destination_url: href,
          });
        }
      } catch {
        // Fault-isolated: NEVER block or interfere with user navigation!
      }
    },
    { capture: true, passive: true },
  );
}

let initialized = false;

export function initAnalyticsDispatcher(): PunyaSitusAnalyticsGlobal | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }

  const win = window as unknown as AnalyticsBrowserWindow;
  if (initialized && win.__punyasitusAnalytics) {
    return win.__punyasitusAnalytics;
  }

  const bootstrap = readBootstrapPayload();
  if (!bootstrap) {
    return null;
  }

  initialized = true;

  const initialConsent = readInitialBrowserConsent(
    win,
    bootstrap.cookieName,
    bootstrap.policyVersion,
  );

  const dispatcher = createAnalyticsSignalDispatcher({
    config: bootstrap.providers,
    adapter: createBrowserProviderAdapter(win),
    gtm: bootstrap.gtm
      ? {
          enabled: bootstrap.gtm.enabled,
          containerId: bootstrap.gtm.containerId,
          vendorModes: bootstrap.gtm.vendorModes,
          cspNonce: bootstrap.gtm.cspNonce,
          ssrLoaded: bootstrap.gtm.ssrLoaded,
          pageType: bootstrap.gtm.pageType,
          contentId: bootstrap.gtm.contentId,
          testScriptUrl: bootstrap.gtm.testScriptUrl,
          testNoscriptUrl: bootstrap.gtm.testNoscriptUrl,
        }
      : null,
    gtmAdapter: bootstrap.gtm ? createBrowserGtmAdapter(win) : undefined,
    expectedPolicyVersion: bootstrap.policyVersion,
    initialConsent,
    autoPageView: bootstrap.autoPageView,
    currentPath: () => window.location.pathname || "/",
    testScriptOverrides: bootstrap.testScriptOverrides,
    hasPersistedLeadMarker: (key) => {
      try {
        return window.sessionStorage.getItem(`${LEAD_SESSION_STORAGE_PREFIX}${key}`) === "1";
      } catch {
        return false;
      }
    },
    savePersistedLeadMarker: (key) => {
      try {
        window.sessionStorage.setItem(`${LEAD_SESSION_STORAGE_PREFIX}${key}`, "1");
      } catch {
        // Ignore private browsing / disabled storage
      }
    },
  });

  // Clear any prior GTM CSP reload guard once the page has been served under gtm-relaxed CSP
  if (bootstrap.gtm?.cspProfile === "gtm-relaxed" || bootstrap.gtm?.ssrLoaded) {
    try {
      window.sessionStorage.removeItem(GTM_CSP_RELOAD_GUARD_KEY);
    } catch {
      // Ignore disabled storage
    }
  }

  // React live to Consent.astro decisions and revocations
  window.addEventListener("punyasitus:consent-change", (event) => {
    try {
      const detail = (event as CustomEvent<ConsentWindowEventDetail>).detail;
      if (!detail) return;
      const prefs = detail.preferences;
      const nextAnalytics = Boolean(prefs?.analytics) && !detail.withdrawn;
      const nextMarketing = Boolean(prefs?.marketing) && !detail.withdrawn;
      const nextHasDecision = Boolean(detail.hasDecision) && !detail.withdrawn;

      // First-visit consent on a GTM-enabled page served under pre-consent strict CSP:
      // perform ONE guarded reload so the server emits the fresh nonce + gtm-relaxed CSP.
      if (
        bootstrap.gtm?.enabled &&
        shouldReloadForConsentedGtmCsp({
          gtmEnabled: bootstrap.gtm.enabled,
          cspProfile: bootstrap.gtm.cspProfile,
          ssrLoaded: bootstrap.gtm.ssrLoaded,
          nextAnalyticsGranted: nextAnalytics && nextHasDecision,
          pathname: window.location.pathname || "/",
          storage: window.sessionStorage,
        })
      ) {
        window.location.reload();
        return;
      }

      dispatcher.updateConsent({
        version: prefs?.version ?? bootstrap.policyVersion,
        analytics: nextAnalytics,
        marketing: nextMarketing,
        hasDecision: nextHasDecision,
      });
    } catch {
      // Fault-isolated
    }
  });

  attachNonBlockingCtaListeners(dispatcher);
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => attachLeadPersistenceObservers(dispatcher),
      { once: true },
    );
  } else {
    attachLeadPersistenceObservers(dispatcher);
  }

  const api: PunyaSitusAnalyticsGlobal = {
    trackEvent: (eventName, params) => dispatcher.dispatch(eventName, params),
    trackLeadSubmitted: (input) => dispatcher.dispatchLeadSubmitted(input),
    updateConsent: (next) => {
      dispatcher.updateConsent(next);
    },
    getState: () => dispatcher.getState(),
  };

  win.__punyasitusAnalytics = api;
  return api;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  initAnalyticsDispatcher();
}

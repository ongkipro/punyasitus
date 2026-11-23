import {
  isValidCspNonce,
  type PublicCspProfile,
} from "./csp.ts";
import {
  isValidGtmContainerId,
  normalizeGtmPageType,
  parseStoredAnalyticsSettings,
  resolveEffectivePublicAnalyticsConfig,
  type GtmPageType,
  type StoredAnalyticsSettings,
  type VendorDeliveryModes,
} from "./gtm.ts";
import {
  hasAnyConfiguredDirectProvider,
  isSafeTestScriptOverrideUrl,
  parseStoredDirectAnalyticsConfig,
  type DirectAnalyticsConfig,
  type ProviderScriptOverrides,
} from "./providers.ts";

/**
 * SSR Bootstrap Serialization Helpers for `<AnalyticsHead.astro>`
 * (`packages/core/src/analytics/config.ts`; TASK-022 & TASK-076, REQ-027, REQ-039).
 */

export const ANALYTICS_BOOTSTRAP_SCHEMA_VERSION = 1 as const;

export interface AnalyticsHeadGtmBootstrap {
  readonly enabled: true;
  readonly containerId: string;
  readonly vendorModes: VendorDeliveryModes;
  readonly cspProfile: PublicCspProfile;
  readonly cspNonce?: string;
  readonly ssrLoaded: boolean;
  readonly pageType: GtmPageType;
  readonly contentId: string | null;
  readonly testScriptUrl?: string;
  readonly testNoscriptUrl?: string;
}

export interface AnalyticsHeadBootstrapPayload {
  readonly schemaVersion: typeof ANALYTICS_BOOTSTRAP_SCHEMA_VERSION;
  readonly policyVersion: number;
  readonly cookieName: string;
  readonly autoPageView: boolean;
  readonly providers: DirectAnalyticsConfig;
  readonly gtm?: AnalyticsHeadGtmBootstrap;
  readonly testScriptOverrides?: ProviderScriptOverrides;
}

export interface BuildAnalyticsHeadOptions {
  readonly config: Partial<DirectAnalyticsConfig> | null | undefined;
  /** Optional full stored analytics settings including GTM container ID, modes, and owner risk ack. */
  readonly gtmConfig?: Partial<StoredAnalyticsSettings> | null;
  /** Authoritative platform operator kill switch state (`true` forcibly suppresses GTM). */
  readonly operatorKillSwitchActive?: boolean;
  readonly surface?: "tenant" | "app" | "console" | "marketing" | "preview" | "error";
  readonly isPreview?: boolean;
  readonly policyVersion?: number;
  readonly cookieName?: string;
  readonly autoPageView?: boolean;
  /** Per-response CSP profile computed by middleware (`"strict"` before consent, `"gtm-relaxed"` after). */
  readonly cspProfile?: PublicCspProfile;
  /** Per-response cryptographic CSP nonce (only passed when GTM is consented on public pages). */
  readonly cspNonce?: string | null;
  /** True ONLY when SSR already emitted the consented GTM snippet in `<head>`. */
  readonly gtmSsrLoaded?: boolean;
  /** Non-PII page kind for `ps_page_view` dataLayer contract. */
  readonly pageType?: GtmPageType;
  /** Non-PII content identifier for `ps_page_view` dataLayer contract. */
  readonly contentId?: string | null;
  /**
   * Must be explicitly `true` (set ONLY when `APP_ENV` is `"local"` or `"test"`) for
   * `testScriptOverrides` / `testGtmScriptUrl` to be serialized into the bootstrap payload.
   * Defaults to `false`.
   */
  readonly allowTestOverrides?: boolean;
  /**
   * Explicit programmatic test-harness override for direct vendor script URLs.
   * Stripped completely unless `allowTestOverrides === true`.
   */
  readonly testScriptOverrides?: ProviderScriptOverrides;
  /**
   * Explicit programmatic test-harness override for GTM `gtm.js` URL.
   * Stripped completely unless `allowTestOverrides === true`.
   */
  readonly testGtmScriptUrl?: string;
  /**
   * Explicit programmatic test-harness override for GTM `ns.html` noscript iframe URL.
   * Stripped completely unless `allowTestOverrides === true`.
   */
  readonly testGtmNoscriptUrl?: string;
}

/**
 * Builds the inert JSON bootstrap payload for `<AnalyticsHead.astro>`, or returns `null`
 * whenever analytics must be suppressed (non-tenant surface, preview mode, or zero active trackers).
 */
export function buildAnalyticsHeadBootstrapPayload(
  options: BuildAnalyticsHeadOptions,
): AnalyticsHeadBootstrapPayload | null {
  const surface = options.surface ?? "tenant";
  if (surface !== "tenant" || options.isPreview === true) {
    return null;
  }

  let providers: DirectAnalyticsConfig;
  let gtmBootstrap: AnalyticsHeadGtmBootstrap | undefined;

  if (options.gtmConfig) {
    const mergedRaw = {
      ...(options.config ?? {}),
      ...options.gtmConfig,
    };
    const parsedFull = parseStoredAnalyticsSettings(mergedRaw);
    const effective = resolveEffectivePublicAnalyticsConfig(
      parsedFull,
      options.operatorKillSwitchActive === true,
    );
    providers = effective.directProviders;

    if (effective.gtm.enabled && isValidGtmContainerId(effective.gtm.containerId)) {
      const safeGtmScript =
        options.allowTestOverrides === true && isSafeTestScriptOverrideUrl(options.testGtmScriptUrl)
          ? options.testGtmScriptUrl.trim()
          : undefined;
      const safeGtmNoscript =
        options.allowTestOverrides === true &&
        isSafeTestScriptOverrideUrl(options.testGtmNoscriptUrl)
          ? options.testGtmNoscriptUrl.trim()
          : undefined;
      const safeNonce = isValidCspNonce(options.cspNonce) ? options.cspNonce : undefined;
      const safeContentId =
        typeof options.contentId === "string" &&
        /^[a-zA-Z0-9._:/-]{1,64}$/.test(options.contentId.trim())
          ? options.contentId.trim()
          : null;

      gtmBootstrap = {
        enabled: true,
        containerId: effective.gtm.containerId,
        vendorModes: effective.vendorModes,
        cspProfile: options.cspProfile === "gtm-relaxed" ? "gtm-relaxed" : "strict",
        ...(safeNonce ? { cspNonce: safeNonce } : {}),
        ssrLoaded: options.gtmSsrLoaded === true,
        pageType: normalizeGtmPageType(options.pageType),
        contentId: safeContentId,
        ...(safeGtmScript ? { testScriptUrl: safeGtmScript } : {}),
        ...(safeGtmNoscript ? { testNoscriptUrl: safeGtmNoscript } : {}),
      };
    }
  } else {
    providers = parseStoredDirectAnalyticsConfig(options.config);
  }

  if (!hasAnyConfiguredDirectProvider(providers) && !gtmBootstrap) {
    return null;
  }

  const policyVersion =
    typeof options.policyVersion === "number" &&
    Number.isInteger(options.policyVersion) &&
    options.policyVersion >= 1
      ? options.policyVersion
      : 1;

  const cookieName =
    typeof options.cookieName === "string" && options.cookieName.startsWith("__Host-")
      ? options.cookieName
      : "__Host-ps_consent";

  const sanitizedOverrides: Partial<Record<"ga4" | "meta" | "tiktok", string>> = {};
  if (options.allowTestOverrides === true && options.testScriptOverrides) {
    for (const key of ["ga4", "meta", "tiktok"] as const) {
      const val = options.testScriptOverrides[key];
      if (isSafeTestScriptOverrideUrl(val)) {
        sanitizedOverrides[key] = val.trim();
      }
    }
  }

  return {
    schemaVersion: ANALYTICS_BOOTSTRAP_SCHEMA_VERSION,
    policyVersion,
    cookieName,
    autoPageView: options.autoPageView ?? true,
    providers,
    ...(gtmBootstrap ? { gtm: gtmBootstrap } : {}),
    ...(Object.keys(sanitizedOverrides).length > 0
      ? { testScriptOverrides: sanitizedOverrides }
      : {}),
  };
}

/**
 * Safely serializes JSON for embedding inside `<script type="application/json">`,
 * escaping `<`, `>`, `&`, `\u2028`, and `\u2029` so `</script>` breakout is impossible.
 */
export function safeSerializeAnalyticsBootstrap(payload: AnalyticsHeadBootstrapPayload): string {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export * from "./csp.ts";
export * from "./gtm-template.ts";
export * from "./gtm.ts";
export * from "./providers.ts";
export * from "./signals.ts";

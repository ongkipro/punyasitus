import {
  hasAnyConfiguredDirectProvider,
  isSafeTestScriptOverrideUrl,
  parseStoredDirectAnalyticsConfig,
  type DirectAnalyticsConfig,
  type ProviderScriptOverrides,
} from "./providers.ts";

/**
 * SSR Bootstrap Serialization Helpers for `<AnalyticsHead.astro>`
 * (`packages/core/src/analytics/config.ts`; TASK-022, REQ-027, REQ-039).
 */

export const ANALYTICS_BOOTSTRAP_SCHEMA_VERSION = 1 as const;

export interface AnalyticsHeadBootstrapPayload {
  readonly schemaVersion: typeof ANALYTICS_BOOTSTRAP_SCHEMA_VERSION;
  readonly policyVersion: number;
  readonly cookieName: string;
  readonly autoPageView: boolean;
  readonly providers: DirectAnalyticsConfig;
  readonly testScriptOverrides?: ProviderScriptOverrides;
}

export interface BuildAnalyticsHeadOptions {
  readonly config: Partial<DirectAnalyticsConfig> | null | undefined;
  readonly surface?: "tenant" | "app" | "console" | "marketing" | "preview" | "error";
  readonly isPreview?: boolean;
  readonly policyVersion?: number;
  readonly cookieName?: string;
  readonly autoPageView?: boolean;
  /**
   * Must be explicitly `true` (set ONLY when `APP_ENV` is `"local"` or `"test"`) for
   * `testScriptOverrides` to be serialized into the bootstrap payload. Defaults to `false`.
   */
  readonly allowTestOverrides?: boolean;
  /**
   * Explicit programmatic test-harness override for vendor script URLs.
   * Stripped completely unless `allowTestOverrides === true`.
   * NEVER populate from untrusted URL query parameters in production.
   */
  readonly testScriptOverrides?: ProviderScriptOverrides;
}

/**
 * Builds the inert JSON bootstrap payload for `<AnalyticsHead.astro>`, or returns `null`
 * whenever analytics must be suppressed (non-tenant surface, preview mode, or zero valid IDs).
 */
export function buildAnalyticsHeadBootstrapPayload(
  options: BuildAnalyticsHeadOptions,
): AnalyticsHeadBootstrapPayload | null {
  const surface = options.surface ?? "tenant";
  if (surface !== "tenant" || options.isPreview === true) {
    return null;
  }

  const providers = parseStoredDirectAnalyticsConfig(options.config);
  if (!hasAnyConfiguredDirectProvider(providers)) {
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

export * from "./providers.ts";
export * from "./signals.ts";

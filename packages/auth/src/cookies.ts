/**
 * Host-only `__Host-` cookie contract and surface secret isolation for PunyaSitus
 * (PLAN §3.2, §4; DEC-018, DEC-035 C11, DEC-036; REQ-034).
 *
 * Better Auth 1.7.x prepends `__Secure-` whenever `advanced.useSecureCookies` is true.
 * To emit genuine RFC 6265bis `__Host-` cookies without producing `__Secure-__Host-*`,
 * we set `useSecureCookies: false`, `crossSubDomainCookies.enabled: false`, explicit
 * `__Host-` names, and `defaultCookieAttributes` with `secure: true, httpOnly: true,
 * sameSite: "lax", path: "/"` (and NO `domain` attribute).
 */

export type AuthSurface = "app" | "console";

export const APP_COOKIE_PREFIX = "__Host-ps" as const;
export const APP_SESSION_COOKIE_NAME = "__Host-ps_session" as const;
export const APP_SESSION_DATA_COOKIE_NAME = "__Host-ps_session_data" as const;
export const APP_DONT_REMEMBER_COOKIE_NAME = "__Host-ps_dont_remember" as const;

export const CONSOLE_COOKIE_PREFIX = "__Host-ps_console" as const;
export const CONSOLE_SESSION_COOKIE_NAME = "__Host-ps_console_session" as const;
export const CONSOLE_SESSION_DATA_COOKIE_NAME = "__Host-ps_console_session_data" as const;
export const CONSOLE_DONT_REMEMBER_COOKIE_NAME = "__Host-ps_console_dont_remember" as const;

export interface HostCookieAttributes {
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: "lax";
  readonly path: "/";
}

export interface SurfaceAuthCookieConfig {
  readonly surface: AuthSurface;
  readonly cookiePrefix: string;
  readonly sessionCookieName: string;
  readonly sessionDataCookieName: string;
  readonly dontRememberCookieName: string;
  readonly defaultCookieAttributes: HostCookieAttributes;
  readonly betterAuthAdvancedCookies: {
    readonly session_token: {
      readonly name: string;
      readonly attributes: HostCookieAttributes;
    };
    readonly session_data: {
      readonly name: string;
      readonly attributes: HostCookieAttributes;
    };
    readonly dont_remember: {
      readonly name: string;
      readonly attributes: HostCookieAttributes;
    };
  };
}

export const HOST_COOKIE_ATTRIBUTES: HostCookieAttributes = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
});

/**
 * Returns the host-only `__Host-` cookie configuration for either `app.punyasitus.com`
 * or `console.punyasitus.com`. The two surfaces never share cookie names.
 */
export function getAuthCookieConfig(surface: AuthSurface): SurfaceAuthCookieConfig {
  const isConsole = surface === "console";
  const cookiePrefix = isConsole ? CONSOLE_COOKIE_PREFIX : APP_COOKIE_PREFIX;
  const sessionCookieName = isConsole ? CONSOLE_SESSION_COOKIE_NAME : APP_SESSION_COOKIE_NAME;
  const sessionDataCookieName = isConsole
    ? CONSOLE_SESSION_DATA_COOKIE_NAME
    : APP_SESSION_DATA_COOKIE_NAME;
  const dontRememberCookieName = isConsole
    ? CONSOLE_DONT_REMEMBER_COOKIE_NAME
    : APP_DONT_REMEMBER_COOKIE_NAME;

  return {
    surface,
    cookiePrefix,
    sessionCookieName,
    sessionDataCookieName,
    dontRememberCookieName,
    defaultCookieAttributes: { ...HOST_COOKIE_ATTRIBUTES },
    betterAuthAdvancedCookies: {
      session_token: {
        name: sessionCookieName,
        attributes: { ...HOST_COOKIE_ATTRIBUTES },
      },
      session_data: {
        name: sessionDataCookieName,
        attributes: { ...HOST_COOKIE_ATTRIBUTES },
      },
      dont_remember: {
        name: dontRememberCookieName,
        attributes: { ...HOST_COOKIE_ATTRIBUTES },
      },
    },
  };
}

export interface HostCookieValidationResult {
  readonly valid: boolean;
  readonly cookieName: string;
  readonly violations: readonly string[];
}

/**
 * Validates that a serialized `Set-Cookie` header satisfies RFC 6265bis `__Host-`
 * and PunyaSitus PLAN §4 invariants (`__Host-` prefix, `HttpOnly`, `Secure`,
 * `Path=/`, `SameSite=Lax`, and NO `Domain=` attribute).
 */
export function validateHostCookieHeader(setCookieHeader: string): HostCookieValidationResult {
  const parts = setCookieHeader
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const nameValue = parts[0] ?? "";
  const eqIdx = nameValue.indexOf("=");
  const cookieName = eqIdx === -1 ? nameValue.trim() : nameValue.slice(0, eqIdx).trim();

  const violations: string[] = [];

  if (!cookieName.startsWith("__Host-")) {
    violations.push(`Cookie "${cookieName}" must start with "__Host-"`);
  }
  if (cookieName.startsWith("__Secure-")) {
    violations.push(`Cookie "${cookieName}" must not use "__Secure-" instead of "__Host-"`);
  }

  let hasSecure = false;
  let hasHttpOnly = false;
  let pathValue: string | null = null;
  let sameSiteValue: string | null = null;
  let hasDomain = false;

  for (let i = 1; i < parts.length; i += 1) {
    const attr = parts[i];
    if (!attr) continue;
    const attrEq = attr.indexOf("=");
    const attrName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
    const attrVal = attrEq === -1 ? "" : attr.slice(attrEq + 1).trim();

    if (attrName === "secure") hasSecure = true;
    else if (attrName === "httponly") hasHttpOnly = true;
    else if (attrName === "domain") hasDomain = true;
    else if (attrName === "path") pathValue = attrVal;
    else if (attrName === "samesite") sameSiteValue = attrVal.toLowerCase();
  }

  if (!hasSecure) violations.push("Missing Secure attribute");
  if (!hasHttpOnly) violations.push("Missing HttpOnly attribute");
  if (hasDomain) violations.push("Must not include Domain attribute");
  if (pathValue !== "/") violations.push(`Path must be "/" (got ${pathValue ?? "missing"})`);
  if (sameSiteValue !== "lax" && sameSiteValue !== "strict") {
    violations.push(`SameSite must be Lax or Strict (got ${sameSiteValue ?? "missing"})`);
  }

  return {
    valid: violations.length === 0,
    cookieName,
    violations,
  };
}

/**
 * Extracts cookie names from a `Cookie` request header.
 */
export function extractCookieNames(cookieHeader: string | null | undefined): readonly string[] {
  if (!cookieHeader || cookieHeader.trim().length === 0) return [];
  const names: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    const name = (eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx)).trim();
    if (name.length > 0) names.push(name);
  }
  return names;
}

/**
 * Returns true if the request carries any PunyaSitus `__Host-` authentication session cookie
 * (excluding the tenant public consent cookie `__Host-ps_consent`).
 */
export function hasHostSessionCookie(
  cookieHeader: string | null | undefined,
  surface?: AuthSurface,
): boolean {
  const names = extractCookieNames(cookieHeader);
  if (names.length === 0) return false;

  if (surface === "app") {
    return names.some(
      (n) =>
        n === APP_SESSION_COOKIE_NAME ||
        n.startsWith(`${APP_SESSION_COOKIE_NAME}.`) ||
        n === APP_SESSION_DATA_COOKIE_NAME ||
        n.startsWith(`${APP_COOKIE_PREFIX}.`),
    );
  }

  if (surface === "console") {
    return names.some(
      (n) =>
        n === CONSOLE_SESSION_COOKIE_NAME ||
        n.startsWith(`${CONSOLE_SESSION_COOKIE_NAME}.`) ||
        n === CONSOLE_SESSION_DATA_COOKIE_NAME ||
        n.startsWith(`${CONSOLE_COOKIE_PREFIX}.`),
    );
  }

  return names.some(
    (n) =>
      n === APP_SESSION_COOKIE_NAME ||
      n.startsWith(`${APP_SESSION_COOKIE_NAME}.`) ||
      n === CONSOLE_SESSION_COOKIE_NAME ||
      n.startsWith(`${CONSOLE_SESSION_COOKIE_NAME}.`) ||
      (n.startsWith("__Host-") && n !== "__Host-ps_consent"),
  );
}

/**
 * Enforces the PLAN §4 requirement that `app.punyasitus.com` and `console.punyasitus.com`
 * sign their `__Host-` cookies with separate high-entropy secrets (>= 32 chars).
 */
export function assertDistinctSurfaceSecrets(appSecret: string, consoleSecret: string): void {
  const trimmedApp = appSecret.trim();
  const trimmedConsole = consoleSecret.trim();
  if (trimmedApp.length < 32) {
    throw new Error("App auth secret must be at least 32 characters");
  }
  if (trimmedConsole.length < 32) {
    throw new Error("Console auth secret must be at least 32 characters");
  }
  if (trimmedApp === trimmedConsole) {
    throw new Error(
      "App and console surfaces must use distinct signing secrets (PLAN §4 cookie isolation)",
    );
  }
}

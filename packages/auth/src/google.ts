import {
  appendPlatformAudit,
  getActivePlatformOperator,
  type PlatformOperatorRecord,
} from "@punyasitus/db/platform";
import type { AuthSurface } from "./cookies.ts";

/**
 * Primary Google Sign-In (`Masuk dengan Google`), verified account-linking policy,
 * console allowlist + active operator enforcement, and role-based session lifetime policies
 * (`DEC-045`, `REQ-090`, `PLAN §4`; TASK-090).
 *
 * Security invariants:
 * - Google OAuth NEVER auto-links onto an existing unverified email account (`email_verified = 0`),
 *   preventing account pre-hijacking (`403 UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED`).
 * - Existing verified accounts (`email_verified = 1`) reuse the exact existing `users.id`
 *   without creating a duplicate user row or extra trial.
 * - Unverified Google profiles (`email_verified !== true`) are always rejected
 *   (`403 GOOGLE_EMAIL_UNVERIFIED`).
 * - `console.punyasitus.com` fails closed unless the Google email is verified, present in
 *   `CONSOLE_GOOGLE_ALLOWLIST`, AND maps to an active `platform_operators` grant (`revoked_at IS NULL`).
 * - Console Google sign-in NEVER writes to `session_two_factor_verifications`, so TASK-067's
 *   central middleware gate still enforces mandatory TOTP before any console access.
 * - Raw OAuth tokens, secrets, and authorization codes are NEVER written to `platform_audit`.
 */

export interface SessionLifetimePolicy {
  readonly tier: "tenant" | "agency" | "affiliate" | "superadmin";
  readonly idleTimeoutSeconds: number;
  readonly absoluteTimeoutSeconds: number;
}

/**
 * Canonical `DEC-045` session lifetime ceilings per role/surface:
 * - `tenant`: 8h idle / 7d absolute
 * - `agency` & `affiliate`: 60m idle / 12h absolute
 * - `superadmin` / `console`: 30m idle / 8h absolute
 */
export const SESSION_LIFETIME_POLICIES: Readonly<{
  readonly tenant: SessionLifetimePolicy;
  readonly agency: SessionLifetimePolicy;
  readonly affiliate: SessionLifetimePolicy;
  readonly superadmin: SessionLifetimePolicy;
  readonly console: SessionLifetimePolicy;
}> = Object.freeze({
  tenant: Object.freeze({
    tier: "tenant",
    idleTimeoutSeconds: 8 * 60 * 60, // 8h (28_800s)
    absoluteTimeoutSeconds: 7 * 24 * 60 * 60, // 7d (604_800s)
  }),
  agency: Object.freeze({
    tier: "agency",
    idleTimeoutSeconds: 60 * 60, // 60m (3_600s)
    absoluteTimeoutSeconds: 12 * 60 * 60, // 12h (43_200s)
  }),
  affiliate: Object.freeze({
    tier: "affiliate",
    idleTimeoutSeconds: 60 * 60, // 60m (3_600s)
    absoluteTimeoutSeconds: 12 * 60 * 60, // 12h (43_200s)
  }),
  superadmin: Object.freeze({
    tier: "superadmin",
    idleTimeoutSeconds: 30 * 60, // 30m (1_800s)
    absoluteTimeoutSeconds: 8 * 60 * 60, // 8h (28_800s)
  }),
  console: Object.freeze({
    tier: "superadmin",
    idleTimeoutSeconds: 30 * 60, // 30m (1_800s)
    absoluteTimeoutSeconds: 8 * 60 * 60, // 8h (28_800s)
  }),
});

/**
 * Resolves the `DEC-045` idle and absolute session lifetime policy for a given surface or role.
 */
export function resolveSessionLifetimePolicy(surfaceOrRole: string): SessionLifetimePolicy {
  const normalized = surfaceOrRole.trim().toLowerCase();
  if (
    normalized === "console" ||
    normalized === "superadmin" ||
    normalized === "platform_operator"
  ) {
    return SESSION_LIFETIME_POLICIES.superadmin;
  }
  if (
    normalized === "agency" ||
    normalized === "agency_admin" ||
    normalized === "agency_staff"
  ) {
    return SESSION_LIFETIME_POLICIES.agency;
  }
  if (normalized === "affiliate") {
    return SESSION_LIFETIME_POLICIES.affiliate;
  }
  return SESSION_LIFETIME_POLICIES.tenant;
}

const SESSION_TOUCH_MIN_INTERVAL_MS = 60_000; // throttle activity writes to <= 1/min

function pathMatchesPrefix(pathnameLower: string, prefix: string): boolean {
  return pathnameLower === prefix || pathnameLower.startsWith(`${prefix}/`);
}

interface RoleTierLookupRow {
  readonly is_agency: number;
  readonly is_affiliate: number;
}

/**
 * Resolves the strictest applicable `DEC-045` session lifetime ceiling for a live `(userId, surface, pathname)`:
 * - `console` surface or `/console` / `/api/console` -> `superadmin` (30m idle / 8h absolute)
 * - Agency owner, `agency_staff` member, affiliate user, or `/agency` / `/affiliate` path -> `agency`/`affiliate` (60m idle / 12h absolute)
 * - Otherwise -> `tenant` (8h idle / 7d absolute)
 */
export async function resolveEffectiveSessionLifetimePolicy(
  platformDb: D1Database,
  params: {
    readonly userId: string;
    readonly surface: AuthSurface;
    readonly pathname?: string;
  },
): Promise<SessionLifetimePolicy> {
  const pathLower = (params.pathname ?? "").trim().toLowerCase();
  if (
    params.surface === "console" ||
    pathMatchesPrefix(pathLower, "/console") ||
    pathMatchesPrefix(pathLower, "/api/console")
  ) {
    return SESSION_LIFETIME_POLICIES.superadmin;
  }

  if (
    pathMatchesPrefix(pathLower, "/agency") ||
    pathMatchesPrefix(pathLower, "/api/agency")
  ) {
    return SESSION_LIFETIME_POLICIES.agency;
  }

  if (
    pathMatchesPrefix(pathLower, "/affiliate") ||
    pathMatchesPrefix(pathLower, "/api/affiliate")
  ) {
    return SESSION_LIFETIME_POLICIES.affiliate;
  }

  const row = await platformDb
    .prepare(
      `
      SELECT
        (
          EXISTS(SELECT 1 FROM agencies WHERE owner_user_id = ?)
          OR EXISTS(SELECT 1 FROM members WHERE user_id = ? AND role = 'agency_staff')
        ) AS is_agency,
        EXISTS(SELECT 1 FROM affiliates WHERE user_id = ?) AS is_affiliate
      `,
    )
    .bind(params.userId, params.userId, params.userId)
    .first<RoleTierLookupRow>();

  if (row?.is_agency === 1) {
    return SESSION_LIFETIME_POLICIES.agency;
  }
  if (row?.is_affiliate === 1) {
    return SESSION_LIFETIME_POLICIES.affiliate;
  }

  return SESSION_LIFETIME_POLICIES.tenant;
}

export type SessionLifetimeCheckResult =
  | {
      readonly valid: true;
      readonly policy: SessionLifetimePolicy;
    }
  | {
      readonly valid: false;
      readonly reason: "missing" | "idle_timeout" | "absolute_timeout";
      readonly policy: SessionLifetimePolicy;
    };

interface SessionTimestampRow {
  readonly id: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly expires_at: number;
}

/**
 * Enforces `DEC-045` idle and absolute session lifetime ceilings directly against
 * `PLATFORM_DB.sessions`. Revokes the session row immediately when either ceiling is exceeded,
 * and caps `expires_at` to `created_at + absoluteTimeoutSeconds * 1000` when refreshing activity
 * so sliding expiry can never outlive the absolute ceiling.
 */
export async function enforceSessionLifetimeCeiling(
  platformDb: D1Database,
  params: {
    readonly sessionId: string;
    readonly userId: string;
    readonly surface: AuthSurface;
    readonly pathname?: string;
    readonly nowMs?: number;
  },
): Promise<SessionLifetimeCheckResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const policy = await resolveEffectiveSessionLifetimePolicy(platformDb, {
    userId: params.userId,
    surface: params.surface,
    pathname: params.pathname,
  });

  const row = await platformDb
    .prepare(
      "SELECT id, created_at, updated_at, expires_at FROM sessions WHERE id = ? AND user_id = ? LIMIT 1",
    )
    .bind(params.sessionId, params.userId)
    .first<SessionTimestampRow>();

  if (!row) {
    return { valid: false, reason: "missing", policy };
  }

  const absoluteLimitMs = policy.absoluteTimeoutSeconds * 1000;
  const idleLimitMs = policy.idleTimeoutSeconds * 1000;

  if (nowMs - row.created_at > absoluteLimitMs || row.expires_at <= nowMs) {
    await platformDb
      .prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
      .bind(params.sessionId, params.userId)
      .run();
    return { valid: false, reason: "absolute_timeout", policy };
  }

  if (nowMs - row.updated_at > idleLimitMs) {
    await platformDb
      .prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
      .bind(params.sessionId, params.userId)
      .run();
    return { valid: false, reason: "idle_timeout", policy };
  }

  const absoluteExpiresAtMs = row.created_at + absoluteLimitMs;
  const shouldTouch =
    nowMs - row.updated_at >= SESSION_TOUCH_MIN_INTERVAL_MS ||
    row.expires_at > absoluteExpiresAtMs;
  if (shouldTouch) {
    const cappedExpiresAt = Math.min(row.expires_at, absoluteExpiresAtMs);
    await platformDb
      .prepare(
        "UPDATE sessions SET updated_at = ?, expires_at = ? WHERE id = ? AND user_id = ?",
      )
      .bind(nowMs, cappedExpiresAt, params.sessionId, params.userId)
      .run();
  }

  return { valid: true, policy };
}

export type GooglePolicyErrorCode =
  | "GOOGLE_EMAIL_UNVERIFIED"
  | "CONSOLE_GOOGLE_NOT_ALLOWED"
  | "PLATFORM_OPERATOR_REQUIRED"
  | "UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED";

export const GOOGLE_OAUTH_DENIAL_CODES: ReadonlySet<GooglePolicyErrorCode> = new Set([
  "GOOGLE_EMAIL_UNVERIFIED",
  "CONSOLE_GOOGLE_NOT_ALLOWED",
  "PLATFORM_OPERATOR_REQUIRED",
  "UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED",
]);

export function mapGoogleOAuthCallbackError(
  rawCode: string | null | undefined,
): { readonly code: GooglePolicyErrorCode; readonly message: string } | null {
  const trimmed = rawCode?.trim() ?? "";
  if (!trimmed) return null;

  if (trimmed === "account_not_linked" || trimmed === "UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED") {
    return {
      code: "UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED",
      message:
        "Akun dengan email ini belum terverifikasi. Verifikasi email Anda terlebih dahulu sebelum menghubungkan Google.",
    };
  }
  if (trimmed === "CONSOLE_GOOGLE_NOT_ALLOWED") {
    return {
      code: "CONSOLE_GOOGLE_NOT_ALLOWED",
      message: "Akun Google ini tidak diizinkan masuk ke Console Operasional Platform.",
    };
  }
  if (trimmed === "PLATFORM_OPERATOR_REQUIRED") {
    return {
      code: "PLATFORM_OPERATOR_REQUIRED",
      message: "Akses Console Operasional memerlukan status operator platform yang aktif.",
    };
  }
  if (trimmed === "GOOGLE_EMAIL_UNVERIFIED") {
    return {
      code: "GOOGLE_EMAIL_UNVERIFIED",
      message: "Email akun Google Anda belum terverifikasi oleh Google.",
    };
  }
  return null;
}

/**
 * Parses `CONSOLE_GOOGLE_ALLOWLIST` (comma/semicolon/newline-separated string, array, or Set)
 * into a normalized lowercase `ReadonlySet<string>`.
 */
export function parseConsoleGoogleEmailAllowlist(
  raw?: string | readonly string[] | ReadonlySet<string> | null,
): ReadonlySet<string> {
  const result = new Set<string>();
  if (!raw) return result;

  const entries: Iterable<string> =
    typeof raw === "string" ? raw.split(/[\s,;]+/) : raw;

  for (const item of entries) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().toLowerCase();
    if (normalized.length > 3 && normalized.includes("@") && !normalized.includes(" ")) {
      result.add(normalized);
    }
  }
  return result;
}

interface ExistingUserLookupRow {
  readonly id: string;
  readonly email: string;
  readonly email_verified: number;
}

export type ConsoleGooglePolicyResult =
  | {
      readonly allowed: true;
      readonly userId: string;
      readonly email: string;
      readonly operator: PlatformOperatorRecord;
    }
  | {
      readonly allowed: false;
      readonly status: 403;
      readonly code: GooglePolicyErrorCode;
      readonly message: string;
    };

async function recordDeniedConsoleGoogleAudit(
  platformDb: D1Database,
  params: {
    readonly enabled: boolean;
    readonly actorUserId: string | null;
    readonly targetId: string;
    readonly code: GooglePolicyErrorCode;
    readonly reason: string;
    readonly emailDomain: string | null;
    readonly requestId?: string | null;
    readonly nowMs: number;
  },
): Promise<void> {
  if (!params.enabled) return;
  try {
    await appendPlatformAudit(platformDb, {
      actorUserId: params.actorUserId,
      actorRole: "google_oauth_candidate",
      action: "console.google_signin",
      targetType: "console_auth",
      targetId: params.targetId,
      reason: params.reason,
      requireReason: false,
      outcome: "denied",
      requestId: params.requestId ?? null,
      metadata: {
        provider: "google",
        code: params.code,
        emailDomain: params.emailDomain,
      },
      createdAtMs: params.nowMs,
    });
  } catch {
    // Always fail closed even if best-effort deny auditing fails.
  }
}

function extractEmailDomain(email: string): string | null {
  const atIdx = email.lastIndexOf("@");
  if (atIdx === -1) return null;
  const domain = email.slice(atIdx + 1).trim().toLowerCase();
  return domain.length > 0 ? domain.slice(0, 120) : null;
}

/**
 * Evaluates whether a Google OAuth identity is permitted on `console.punyasitus.com`:
 * 1. Google email MUST be verified (`emailVerified === true`).
 * 2. `CONSOLE_GOOGLE_ALLOWLIST` MUST be non-empty and contain the normalized email.
 * 3. A verified local user row (`email_verified = 1`) MUST exist with an active
 *    `platform_operators` grant (`revoked_at IS NULL`).
 *
 * Every denial writes a sanitized `denied` audit record to `platform_audit` (never logging tokens/secrets).
 */
export async function evaluateConsoleGooglePolicy(
  platformDb: D1Database,
  params: {
    readonly email: string;
    readonly emailVerified: boolean;
    readonly allowlist?: string | readonly string[] | ReadonlySet<string> | null;
    readonly requestId?: string | null;
    readonly nowMs?: number;
    readonly auditOnDeny?: boolean;
  },
): Promise<ConsoleGooglePolicyResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const auditOnDeny = params.auditOnDeny ?? true;
  const normalizedEmail = params.email.trim().toLowerCase();
  const emailDomain = extractEmailDomain(normalizedEmail);
  const allowlistSet = parseConsoleGoogleEmailAllowlist(params.allowlist);

  if (params.emailVerified !== true || !normalizedEmail || !normalizedEmail.includes("@")) {
    await recordDeniedConsoleGoogleAudit(platformDb, {
      enabled: auditOnDeny,
      actorUserId: null,
      targetId: "console_google_allowlist",
      code: "CONSOLE_GOOGLE_NOT_ALLOWED",
      reason: "Unverified Google email rejected on console surface",
      emailDomain,
      requestId: params.requestId,
      nowMs,
    });
    return {
      allowed: false,
      status: 403,
      code: "CONSOLE_GOOGLE_NOT_ALLOWED",
      message: "Akun Google ini tidak diizinkan masuk ke Console Operasional Platform.",
    };
  }

  if (allowlistSet.size === 0 || !allowlistSet.has(normalizedEmail)) {
    await recordDeniedConsoleGoogleAudit(platformDb, {
      enabled: auditOnDeny,
      actorUserId: null,
      targetId: "console_google_allowlist",
      code: "CONSOLE_GOOGLE_NOT_ALLOWED",
      reason:
        allowlistSet.size === 0
          ? "Console Google allowlist is empty (fail closed)"
          : "Google account is not in console operator allowlist",
      emailDomain,
      requestId: params.requestId,
      nowMs,
    });
    return {
      allowed: false,
      status: 403,
      code: "CONSOLE_GOOGLE_NOT_ALLOWED",
      message: "Akun Google ini tidak diizinkan masuk ke Console Operasional Platform.",
    };
  }

  const existingUser = await platformDb
    .prepare("SELECT id, email, email_verified FROM users WHERE lower(email) = ? LIMIT 1")
    .bind(normalizedEmail)
    .first<ExistingUserLookupRow>();

  if (!existingUser) {
    await recordDeniedConsoleGoogleAudit(platformDb, {
      enabled: auditOnDeny,
      actorUserId: null,
      targetId: "console_operator_grant",
      code: "PLATFORM_OPERATOR_REQUIRED",
      reason: "Allowlisted Google email has no provisioned platform operator account",
      emailDomain,
      requestId: params.requestId,
      nowMs,
    });
    return {
      allowed: false,
      status: 403,
      code: "PLATFORM_OPERATOR_REQUIRED",
      message: "Akses Console Operasional memerlukan status operator platform yang aktif.",
    };
  }

  if (existingUser.email_verified !== 1) {
    await recordDeniedConsoleGoogleAudit(platformDb, {
      enabled: auditOnDeny,
      actorUserId: existingUser.id,
      targetId: existingUser.id,
      code: "UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED",
      reason: "Refused Google auto-link onto unverified local operator account",
      emailDomain,
      requestId: params.requestId,
      nowMs,
    });
    return {
      allowed: false,
      status: 403,
      code: "UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED",
      message:
        "Akun dengan email ini belum terverifikasi. Verifikasi email Anda terlebih dahulu sebelum menghubungkan Google.",
    };
  }

  const activeOperator = await getActivePlatformOperator(platformDb, existingUser.id);
  if (!activeOperator) {
    await recordDeniedConsoleGoogleAudit(platformDb, {
      enabled: auditOnDeny,
      actorUserId: existingUser.id,
      targetId: existingUser.id,
      code: "PLATFORM_OPERATOR_REQUIRED",
      reason: "Allowlisted Google user lacks an active platform_operators grant",
      emailDomain,
      requestId: params.requestId,
      nowMs,
    });
    return {
      allowed: false,
      status: 403,
      code: "PLATFORM_OPERATOR_REQUIRED",
      message: "Akses Console Operasional memerlukan status operator platform yang aktif.",
    };
  }

  return {
    allowed: true,
    userId: existingUser.id,
    email: normalizedEmail,
    operator: activeOperator,
  };
}

export type GoogleAccountLinkPolicyResult =
  | {
      readonly allowed: true;
      readonly action: "create_verified_user";
      readonly existingUserId: null;
      readonly email: string;
    }
  | {
      readonly allowed: true;
      readonly action: "link_existing_verified_user";
      readonly existingUserId: string;
      readonly email: string;
    }
  | {
      readonly allowed: false;
      readonly status: 403;
      readonly code: "GOOGLE_EMAIL_UNVERIFIED" | "UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED";
      readonly message: string;
    };

/**
 * Evaluates verified account-linking policy for Google OAuth sign-in on `app.punyasitus.com`:
 * - Rejects unverified Google profiles (`403 GOOGLE_EMAIL_UNVERIFIED`).
 * - No existing user -> `create_verified_user`.
 * - Existing verified user (`email_verified = 1`) -> `link_existing_verified_user` (reuses `users.id`,
 *   preventing duplicate users and extra trials).
 * - Existing unverified user (`email_verified = 0`) -> DENIES (`403 UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED`)
 *   to prevent pre-hijacking.
 */
export async function evaluateGoogleAccountLinkPolicy(
  platformDb: D1Database,
  params: {
    readonly email: string;
    readonly googleEmailVerified: boolean;
  },
): Promise<GoogleAccountLinkPolicyResult> {
  const normalizedEmail = params.email.trim().toLowerCase();
  if (params.googleEmailVerified !== true || !normalizedEmail || !normalizedEmail.includes("@")) {
    return {
      allowed: false,
      status: 403,
      code: "GOOGLE_EMAIL_UNVERIFIED",
      message: "Email akun Google Anda belum terverifikasi oleh Google.",
    };
  }

  const existingUser = await platformDb
    .prepare("SELECT id, email, email_verified FROM users WHERE lower(email) = ? LIMIT 1")
    .bind(normalizedEmail)
    .first<ExistingUserLookupRow>();

  if (!existingUser) {
    return {
      allowed: true,
      action: "create_verified_user",
      existingUserId: null,
      email: normalizedEmail,
    };
  }

  if (existingUser.email_verified !== 1) {
    return {
      allowed: false,
      status: 403,
      code: "UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED",
      message:
        "Akun dengan email ini belum terverifikasi. Verifikasi email Anda terlebih dahulu sebelum menghubungkan Google.",
    };
  }

  return {
    allowed: true,
    action: "link_existing_verified_user",
    existingUserId: existingUser.id,
    email: normalizedEmail,
  };
}

export interface GoogleOAuthCallbackProfile {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name?: string | null;
  readonly picture?: string | null;
}

export type CompleteGoogleOAuthCallbackResult =
  | {
      readonly ok: true;
      readonly action:
        | "create_verified_user"
        | "link_existing_verified_user"
        | "sign_in_existing_google_user";
      readonly existingUserId: string | null;
      readonly email: string;
      readonly emailVerified: true;
      readonly sessionLifetimePolicy: SessionLifetimePolicy;
    }
  | {
      readonly ok: false;
      readonly status: 403;
      readonly code: GooglePolicyErrorCode;
      readonly message: string;
    };

/**
 * Shared admission evaluator used by BOTH Better Auth's Google OAuth callback hooks
 * and direct callers/tests so every Google callback invariant is enforced identically.
 */
export async function completeGoogleOAuthCallback(
  platformDb: D1Database,
  params: {
    readonly surface: AuthSurface;
    readonly profile: GoogleOAuthCallbackProfile;
    readonly consoleGoogleAllowlist?: string | readonly string[] | ReadonlySet<string> | null;
    readonly requestId?: string | null;
    readonly nowMs?: number;
    readonly auditOnDeny?: boolean;
  },
): Promise<CompleteGoogleOAuthCallbackResult> {
  const sessionLifetimePolicy = resolveSessionLifetimePolicy(params.surface);

  if (params.surface === "console") {
    const consolePolicy = await evaluateConsoleGooglePolicy(platformDb, {
      email: params.profile.email,
      emailVerified: params.profile.emailVerified,
      allowlist: params.consoleGoogleAllowlist,
      requestId: params.requestId,
      nowMs: params.nowMs,
      auditOnDeny: params.auditOnDeny,
    });
    if (!consolePolicy.allowed) {
      return {
        ok: false,
        status: consolePolicy.status,
        code: consolePolicy.code,
        message: consolePolicy.message,
      };
    }

    const existingGoogleAccount = await platformDb
      .prepare(
        "SELECT id FROM accounts WHERE provider_id = 'google' AND account_id = ? AND user_id = ? LIMIT 1",
      )
      .bind(params.profile.sub, consolePolicy.userId)
      .first<{ readonly id: string }>();

    return {
      ok: true,
      action: existingGoogleAccount
        ? "sign_in_existing_google_user"
        : "link_existing_verified_user",
      existingUserId: consolePolicy.userId,
      email: consolePolicy.email,
      emailVerified: true,
      sessionLifetimePolicy,
    };
  }

  const linkPolicy = await evaluateGoogleAccountLinkPolicy(platformDb, {
    email: params.profile.email,
    googleEmailVerified: params.profile.emailVerified,
  });
  if (!linkPolicy.allowed) {
    return {
      ok: false,
      status: linkPolicy.status,
      code: linkPolicy.code,
      message: linkPolicy.message,
    };
  }

  if (linkPolicy.existingUserId) {
    const existingGoogleAccount = await platformDb
      .prepare(
        "SELECT id FROM accounts WHERE provider_id = 'google' AND account_id = ? AND user_id = ? LIMIT 1",
      )
      .bind(params.profile.sub, linkPolicy.existingUserId)
      .first<{ readonly id: string }>();

    if (existingGoogleAccount) {
      return {
        ok: true,
        action: "sign_in_existing_google_user",
        existingUserId: linkPolicy.existingUserId,
        email: linkPolicy.email,
        emailVerified: true,
        sessionLifetimePolicy,
      };
    }
  }

  return {
    ok: true,
    action: linkPolicy.action,
    existingUserId: linkPolicy.existingUserId,
    email: linkPolicy.email,
    emailVerified: true,
    sessionLifetimePolicy,
  };
}

export interface DecodedGoogleIdTokenProfile {
  readonly aud: string;
  readonly azp: string;
  readonly email: string;
  readonly email_verified: boolean;
  readonly exp: number;
  readonly family_name: string;
  readonly given_name: string;
  readonly hd?: string | undefined;
  readonly iat: number;
  readonly iss: string;
  readonly name: string;
  readonly picture: string;
  readonly sub: string;
}

const GOOGLE_VALID_ISSUERS: ReadonlySet<string> = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);
const GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS = 60;

export interface DecodeGoogleIdTokenOptions {
  readonly expectedClientId?: string | null;
  readonly nowMs?: number;
}

/**
 * Decodes and validates OIDC claims (`iss`, `aud`, `exp`, `sub`, `email`) of an `id_token`
 * obtained directly from Google's server-to-server token endpoint (`https://oauth2.googleapis.com/token`).
 * Works identically in Node and Cloudflare `workerd` with zero extra runtime dependencies.
 */
export function decodeGoogleIdTokenPayload(
  idToken: string,
  options: DecodeGoogleIdTokenOptions = {},
): DecodedGoogleIdTokenProfile | null {
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  const payloadB64Url = parts[1];
  if (!payloadB64Url) return null;

  try {
    const base64 = payloadB64Url.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (base64.length % 4)) % 4;
    const padded = base64 + "=".repeat(padLen);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const jsonText = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(jsonText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const sub = typeof record.sub === "string" ? record.sub.trim() : "";
    const email = typeof record.email === "string" ? record.email.trim() : "";
    if (!sub || !email) return null;

    const iss = typeof record.iss === "string" ? record.iss.trim() : "";
    if (!iss || !GOOGLE_VALID_ISSUERS.has(iss)) {
      return null;
    }

    const aud = typeof record.aud === "string" ? record.aud.trim() : "";
    if (options.expectedClientId !== undefined) {
      const expectedClientId = options.expectedClientId?.trim() ?? "";
      if (!expectedClientId || aud !== expectedClientId) {
        return null;
      }
    }

    const exp = typeof record.exp === "number" && Number.isFinite(record.exp) ? record.exp : 0;
    const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
    if (exp <= 0 || exp + GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS < nowSeconds) {
      return null;
    }

    const emailVerified = record.email_verified === true || record.email_verified === "true";
    const name =
      typeof record.name === "string" && record.name.trim().length > 0
        ? record.name.trim()
        : email.split("@")[0] ?? "Pengguna Google";
    const picture = typeof record.picture === "string" ? record.picture : "";
    const hd = typeof record.hd === "string" ? record.hd : undefined;
    const givenName = typeof record.given_name === "string" ? record.given_name : "";
    const familyName = typeof record.family_name === "string" ? record.family_name : "";
    const azp = typeof record.azp === "string" ? record.azp : "";
    const iat = typeof record.iat === "number" ? record.iat : 0;

    return {
      aud,
      azp,
      email,
      email_verified: emailVerified,
      exp,
      family_name: familyName,
      given_name: givenName,
      hd,
      iat,
      iss: iss || "https://accounts.google.com",
      name,
      picture,
      sub,
    };
  } catch {
    return null;
  }
}

export const GOOGLE_OIDC_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo" as const;

/**
 * Resolves Google profile claims from `idToken` (preferred OIDC flow, validating `iss`/`aud`/`exp`)
 * or falls back to Google's OIDC UserInfo endpoint when only `accessToken` is returned.
 */
export async function resolveGoogleProfileFromTokens(
  token: {
    readonly idToken?: string;
    readonly accessToken?: string;
  },
  fetchFn: typeof fetch = globalThis.fetch,
  options: DecodeGoogleIdTokenOptions = {},
): Promise<{
  readonly user: {
    readonly name: string;
    readonly email: string;
    readonly image?: string;
    readonly emailVerified: boolean;
  };
  readonly data: DecodedGoogleIdTokenProfile;
} | null> {
  if (token.idToken) {
    const decoded = decodeGoogleIdTokenPayload(token.idToken, options);
    if (!decoded) {
      // Fail closed when an idToken is present but fails claim validation (wrong iss/aud or expired)
      return null;
    }
    return {
      user: {
        name: decoded.name,
        email: decoded.email,
        image: decoded.picture || undefined,
        emailVerified: decoded.email_verified,
      },
      data: decoded,
    };
  }

  if (token.accessToken) {
    try {
      const response = await fetchFn(GOOGLE_OIDC_USERINFO_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: "application/json",
        },
        redirect: "manual",
      });
      if (!response.ok) return null;
      const parsed: unknown = await response.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      const sub = typeof record.sub === "string" ? record.sub.trim() : "";
      const email = typeof record.email === "string" ? record.email.trim() : "";
      if (!sub || !email) return null;
      const emailVerified = record.email_verified === true || record.email_verified === "true";
      const name =
        typeof record.name === "string" && record.name.trim().length > 0
          ? record.name.trim()
          : email.split("@")[0] ?? "Pengguna Google";
      const picture = typeof record.picture === "string" ? record.picture : "";
      const hd = typeof record.hd === "string" ? record.hd : undefined;
      const profile: DecodedGoogleIdTokenProfile = {
        aud: "",
        azp: "",
        email,
        email_verified: emailVerified,
        exp: 0,
        family_name: typeof record.family_name === "string" ? record.family_name : "",
        given_name: typeof record.given_name === "string" ? record.given_name : "",
        hd,
        iat: 0,
        iss: "https://accounts.google.com",
        name,
        picture,
        sub,
      };
      return {
        user: {
          name: profile.name,
          email: profile.email,
          image: profile.picture || undefined,
          emailVerified: profile.email_verified,
        },
        data: profile,
      };
    } catch {
      return null;
    }
  }

  return null;
}

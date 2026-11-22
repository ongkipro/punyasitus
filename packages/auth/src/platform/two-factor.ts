import {
  appendPlatformAudit,
  bootstrapInitialPlatformOperator,
  buildPlatformAuditStatement,
  type PlatformAuditRecord,
} from "@punyasitus/db/platform";
import type { PunyaSitusAuth } from "../index.ts";

/**
 * Session-level Two-Factor Authentication ledger, RFC 6238 TOTP helpers, secret redaction,
 * audited lost-factor recovery, and reusable 2FA operator test fixtures
 * (REQ-068, DEC-021, PLAN §13; TASK-067).
 *
 * Core security invariants:
 * - No TOTP secret, seed, `otpauth://` URI, or backup code is EVER logged or persisted in `platform_audit`.
 * - Every privileged operator session must record a live row in `session_two_factor_verifications`
 *   matching the active `sessions.id`; password-only or OAuth-only sessions never pass.
 * - `requireRecentSecondFactor` enforces a strict 10-minute verification window (`600_000` ms).
 */

export const DEFAULT_SECOND_FACTOR_WINDOW_MS = 10 * 60 * 1000; // 10 minutes (PLAN §13)

export type SessionSecondFactorMethod = "totp" | "backup_code";

export const SESSION_2FA_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS session_two_factor_verifications (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('totp', 'backup_code')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_two_factor_verifications_user_id_idx
  ON session_two_factor_verifications(user_id);
`.trim();

export const SESSION_2FA_MIGRATION_SQL = `
-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0003_session_two_factor_state
-- Additive session-level 2FA verification ledger and Better Auth 1.7.27 two_factors parity
-- (REQ-068, DEC-021, PLAN §13).

${SESSION_2FA_TABLE_SQL}

ALTER TABLE two_factors ADD COLUMN verified INTEGER NOT NULL DEFAULT 1 CHECK (verified IN (0, 1));
ALTER TABLE two_factors ADD COLUMN failed_verification_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_verification_count >= 0);
ALTER TABLE two_factors ADD COLUMN locked_until INTEGER;
`.trim();

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const OTPAUTH_URI_RE = /otpauth:\/\/[^\s'"<>]+/gi;
const BACKUP_CODE_RE = /\b[A-Za-z0-9]{5}-[A-Za-z0-9]{5}\b/g;
const BASE32_TOTP_SECRET_RE =
  /\b(?:(?=[A-Z2-7]*[A-Z])(?=[A-Z2-7]*[2-7])[A-Z2-7]{16,}|[A-Z2-7]{32,})={0,6}\b/g;
const TWO_FACTOR_SECRET_KV_RE =
  /\b(totp[_-]?(?:secret|seed|uri|code)|backup[_-]?codes?|manual[_-]?secret|otpauth[_-]?uri|secret)\s*([:=])\s*([^\s,;'"}\]]+)/gi;

/**
 * Redacts `otpauth://` URIs, TOTP secrets/seeds (KV and bare Base32), and backup code tokens
 * from any diagnostic string.
 */
export function redactTwoFactorSensitiveText(input: string): string {
  return String(input ?? "")
    .replace(OTPAUTH_URI_RE, "[REDACTED_OTPAUTH]")
    .replace(
      TWO_FACTOR_SECRET_KV_RE,
      (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`,
    )
    .replace(BACKUP_CODE_RE, "[REDACTED_BACKUP_CODE]")
    .replace(BASE32_TOTP_SECRET_RE, "[REDACTED_TOTP_SECRET]");
}

/**
 * Extracts the raw Base32 secret from a standard `otpauth://totp/...` URI for manual authenticator entry.
 */
export function extractManualTotpSecret(totpUri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(totpUri);
  } catch {
    throw new Error("Invalid otpauth URI.");
  }
  if (parsed.protocol !== "otpauth:") {
    throw new Error("URI must use the otpauth: protocol.");
  }
  const secret = parsed.searchParams.get("secret")?.trim().toUpperCase() ?? "";
  if (!secret || !/^[A-Z2-7]+=*$/.test(secret)) {
    throw new Error("Missing or invalid Base32 secret in otpauth URI.");
  }
  return secret;
}

/**
 * Decodes an RFC 4648 Base32 string into raw bytes (used for RFC 6238 TOTP generation in fixtures/tests).
 */
export function decodeBase32(base32Input: string): Uint8Array {
  const clean = base32Input.trim().toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  if (clean.length === 0) {
    throw new Error("Base32 input must not be empty.");
  }
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i] ?? "";
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character "${ch}".`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/**
 * Generates an RFC 6238 TOTP 6-digit code from a Base32 secret (as carried inside `otpauth://` URIs)
 * using Web Crypto HMAC-SHA1. Works identically in Node and Cloudflare `workerd`.
 */
export async function generateTotpCodeFromBase32Secret(
  base32Secret: string,
  options: {
    readonly timestampMs?: number;
    readonly periodSeconds?: number;
    readonly digits?: number;
  } = {},
): Promise<string> {
  const periodSeconds = options.periodSeconds ?? 30;
  const digits = options.digits ?? 6;
  const timestampMs = options.timestampMs ?? Date.now();
  const counter = Math.floor(timestampMs / 1000 / periodSeconds);

  const counterBytes = new Uint8Array(8);
  let remaining = counter;
  for (let i = 7; i >= 0; i -= 1) {
    counterBytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }

  const keyBytes = decodeBase32(base32Secret);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const hmac = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, counterBytes.buffer as ArrayBuffer),
  );

  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);

  const mod = 10 ** digits;
  return String(binary % mod).padStart(digits, "0");
}

interface TableInfoRow {
  readonly name: string;
}

/**
 * Idempotently applies migration `0003_session_two_factor_state` to `PLATFORM_DB`
 * without altering `PLATFORM_MIGRATIONS` (keeping `TASK-001` checksums untouched).
 */
export async function applySessionTwoFactorMigration(platformDb: D1Database): Promise<void> {
  await platformDb
    .prepare(
      `CREATE TABLE IF NOT EXISTS session_two_factor_verifications (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        verified_at INTEGER NOT NULL,
        method TEXT NOT NULL CHECK (method IN ('totp', 'backup_code')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    )
    .run();
  await platformDb
    .prepare(
      `CREATE INDEX IF NOT EXISTS session_two_factor_verifications_user_id_idx
       ON session_two_factor_verifications(user_id)`,
    )
    .run();

  const colsResult = await platformDb
    .prepare("PRAGMA table_info(two_factors)")
    .all<TableInfoRow>();
  const existingCols = new Set((colsResult.results ?? []).map((r) => r.name));

  if (existingCols.size > 0) {
    if (!existingCols.has("verified")) {
      await platformDb
        .prepare(
          "ALTER TABLE two_factors ADD COLUMN verified INTEGER NOT NULL DEFAULT 1 CHECK (verified IN (0, 1))",
        )
        .run();
    }
    if (!existingCols.has("failed_verification_count")) {
      await platformDb
        .prepare(
          "ALTER TABLE two_factors ADD COLUMN failed_verification_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_verification_count >= 0)",
        )
        .run();
    }
    if (!existingCols.has("locked_until")) {
      await platformDb
        .prepare("ALTER TABLE two_factors ADD COLUMN locked_until INTEGER")
        .run();
    }
  }
}

export interface SessionSecondFactorRecord {
  readonly sessionId: string;
  readonly userId: string;
  readonly verifiedAtMs: number;
  readonly method: SessionSecondFactorMethod;
}

export interface SessionSecondFactorState {
  readonly sessionId: string;
  readonly userId: string;
  readonly twoFactorEnabled: boolean;
  readonly sessionVerified: boolean;
  readonly verifiedAtMs: number | null;
  readonly method: SessionSecondFactorMethod | null;
}

/**
 * Records (or refreshes) the 2FA verification timestamp for an active session in
 * `session_two_factor_verifications`.
 */
export async function recordSessionSecondFactorVerification(
  platformDb: D1Database,
  params: {
    readonly sessionId: string;
    readonly userId: string;
    readonly method: SessionSecondFactorMethod;
    readonly nowMs?: number;
  },
): Promise<SessionSecondFactorRecord> {
  const sessionId = params.sessionId.trim();
  const userId = params.userId.trim();
  if (!sessionId || !userId) {
    throw new Error("sessionId and userId are required to record 2FA verification.");
  }
  const nowMs = Math.trunc(params.nowMs ?? Date.now());

  await platformDb
    .prepare(
      `
      INSERT INTO session_two_factor_verifications (
        session_id, user_id, verified_at, method, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        user_id = excluded.user_id,
        verified_at = excluded.verified_at,
        method = excluded.method,
        updated_at = excluded.updated_at
      `,
    )
    .bind(sessionId, userId, nowMs, params.method, nowMs, nowMs)
    .run();

  return {
    sessionId,
    userId,
    verifiedAtMs: nowMs,
    method: params.method,
  };
}

interface UserTwoFactorFlagRow {
  readonly two_factor_enabled: number;
}

interface SessionTwoFactorDbRow {
  readonly verified_at: number;
  readonly method: SessionSecondFactorMethod;
}

/**
 * Reads live `users.two_factor_enabled` and `session_two_factor_verifications.verified_at`
 * for the given `(sessionId, userId)` pair. Fails closed (`sessionVerified: false`) if the
 * verification table has not been migrated yet.
 */
export async function getSessionSecondFactorState(
  platformDb: D1Database,
  params: {
    readonly sessionId: string;
    readonly userId: string;
  },
): Promise<SessionSecondFactorState> {
  const sessionId = params.sessionId.trim();
  const userId = params.userId.trim();
  if (!sessionId || !userId) {
    return {
      sessionId,
      userId,
      twoFactorEnabled: false,
      sessionVerified: false,
      verifiedAtMs: null,
      method: null,
    };
  }

  const userRow = await platformDb
    .prepare("SELECT two_factor_enabled FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<UserTwoFactorFlagRow>();

  const twoFactorEnabled = userRow?.two_factor_enabled === 1;

  let verificationRow: SessionTwoFactorDbRow | null = null;
  try {
    verificationRow = await platformDb
      .prepare(
        `
        SELECT verified_at, method
        FROM session_two_factor_verifications
        WHERE session_id = ? AND user_id = ?
        LIMIT 1
        `,
      )
      .bind(sessionId, userId)
      .first<SessionTwoFactorDbRow>();
  } catch {
    // Table not migrated yet -> fail closed (verificationRow stays null)
  }

  const verifiedAtMs =
    verificationRow && Number.isFinite(verificationRow.verified_at)
      ? verificationRow.verified_at
      : null;

  return {
    sessionId,
    userId,
    twoFactorEnabled,
    sessionVerified: twoFactorEnabled && verifiedAtMs !== null,
    verifiedAtMs,
    method: verifiedAtMs !== null && verificationRow ? verificationRow.method : null,
  };
}

/**
 * Clears an operator's enrolled TOTP factor, verification state, and active sessions
 * atomically with a sanitized `platform_audit` entry (used for trusted-environment
 * lost-factor recovery in `workerd` tests and recovery helpers).
 */
export async function executeAuditedOperatorTwoFactorRecovery(
  platformDb: D1Database,
  params: {
    readonly userId: string;
    readonly reason: string;
    readonly requestId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{ readonly userId: string; readonly audit: PlatformAuditRecord }> {
  const userId = params.userId.trim();
  if (!userId) {
    throw new Error("userId is required for audited 2FA recovery.");
  }
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const sanitizedReason = redactTwoFactorSensitiveText(params.reason);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(platformDb, {
    actorUserId: null,
    actorRole: "system_recovery",
    action: "platform_operator.recover_2fa",
    targetType: "platform_operator",
    targetId: userId,
    reason: sanitizedReason,
    requireReason: true,
    outcome: "success",
    requestId: params.requestId ?? null,
    metadata: {
      reset2fa: true,
      sessionsCleared: true,
    },
    createdAtMs: nowMs,
  });

  await platformDb.batch([
    platformDb.prepare("DELETE FROM two_factors WHERE user_id = ?").bind(userId),
    platformDb
      .prepare("UPDATE users SET two_factor_enabled = 0, updated_at = ? WHERE id = ?")
      .bind(nowMs, userId),
    platformDb
      .prepare("DELETE FROM session_two_factor_verifications WHERE user_id = ?")
      .bind(userId),
    platformDb.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    auditStmt,
  ]);

  return { userId, audit: auditEntry };
}

/**
 * Records a sanitized 2FA audit event (never storing secrets, TOTP codes, URIs, or backup codes).
 */
export async function appendTwoFactorAuditEvent(
  platformDb: D1Database,
  params: {
    readonly actorUserId: string | null;
    readonly actorRole: string;
    readonly action: string;
    readonly targetId: string;
    readonly outcome: "success" | "denied" | "error";
    readonly reason?: string | null;
    readonly requestId?: string | null;
    readonly metadata?: Readonly<Record<string, unknown>> | null;
    readonly nowMs?: number;
  },
): Promise<void> {
  try {
    await appendPlatformAudit(platformDb, {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: params.action,
      targetType: "platform_operator",
      targetId: params.targetId,
      reason: params.reason ? redactTwoFactorSensitiveText(params.reason) : null,
      requireReason: false,
      outcome: params.outcome,
      requestId: params.requestId ?? null,
      metadata: params.metadata ?? null,
      createdAtMs: params.nowMs,
    });
  } catch {
    // Non-blocking audit logging on passive read/denied paths; never expose raw secrets.
  }
}

export function extractSetCookiePairs(headers: Headers): readonly string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const rawList =
    typeof withGetSetCookie.getSetCookie === "function"
      ? withGetSetCookie.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie") as string]
        : [];
  const pairs: string[] = [];
  for (const raw of rawList) {
    const first = raw.split(";")[0]?.trim();
    if (first && first.includes("=")) {
      pairs.push(first);
    }
  }
  return pairs;
}

export function mergeCookieHeaders(
  existingCookieHeader: string | null | undefined,
  responseHeaders: Headers,
): string {
  const jar = new Map<string, string>();
  const addPair = (pair: string) => {
    const eq = pair.indexOf("=");
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) return;
    if (value === "") {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  };
  if (existingCookieHeader) {
    for (const part of existingCookieHeader.split(";")) {
      const trimmed = part.trim();
      if (trimmed) addPair(trimmed);
    }
  }
  for (const pair of extractSetCookiePairs(responseHeaders)) {
    addPair(pair);
  }
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export interface TwoFactorEnrolledOperatorFixture {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
  };
  readonly session: {
    readonly id: string;
    readonly userId: string;
    readonly token: string;
  };
  readonly cookieHeader: string;
  readonly totpUri: string;
  readonly manualSecret: string;
  readonly backupCodes: readonly string[];
  readonly verifiedAtMs: number;
  readonly generateCurrentTotpCode: (timestampMs?: number) => Promise<string>;
}

/**
 * Reusable test fixture helper for downstream platform tasks (`TASK-026`, `TASK-046`,
 * `TASK-047`, `TASK-048`, `TASK-067`): provisions a verified account, grants active
 * `platform_operators` authority, enrolls real Better Auth TOTP 2FA, verifies it,
 * and records `session_two_factor_verifications` on the resulting session.
 */
export async function createTwoFactorEnrolledOperatorFixture(
  platformDb: D1Database,
  params: {
    readonly auth: PunyaSitusAuth;
    readonly email: string;
    readonly password: string;
    readonly name?: string;
    readonly reason?: string;
    readonly nowMs?: number;
  },
): Promise<TwoFactorEnrolledOperatorFixture> {
  await applySessionTwoFactorMigration(platformDb);

  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const name = params.name ?? "Platform Operator Fixture";

  const signUpRes = await params.auth.api.signUpEmail({
    body: {
      email: params.email,
      password: params.password,
      name,
    },
    asResponse: true,
  });
  if (!signUpRes.ok) {
    throw new Error(`Fixture signUpEmail failed (${signUpRes.status}).`);
  }

  let cookieHeader = mergeCookieHeaders(null, signUpRes.headers);
  const initialSession = await params.auth.api.getSession({
    headers: new Headers({ cookie: cookieHeader }),
  });
  if (!initialSession?.user || !initialSession.session) {
    throw new Error("Fixture could not resolve initial session after signUpEmail.");
  }

  // Mark email verified and bootstrap/grant active platform operator
  await platformDb
    .prepare("UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?")
    .bind(nowMs, initialSession.user.id)
    .run();

  await bootstrapInitialPlatformOperator(platformDb, {
    userId: initialSession.user.id,
    reason: params.reason ?? "Synthetic test fixture bootstrap for 2FA-enrolled operator",
    allowAdditional: true,
    nowMs,
  });

  // Enable Better Auth TOTP 2FA
  const enableRes = await params.auth.api.enableTwoFactor({
    headers: new Headers({ cookie: cookieHeader }),
    body: {
      password: params.password,
      issuer: "PunyaSitus",
    },
    asResponse: true,
  });
  if (!enableRes.ok) {
    throw new Error(`Fixture enableTwoFactor failed (${enableRes.status}).`);
  }
  cookieHeader = mergeCookieHeaders(cookieHeader, enableRes.headers);
  const enableBody = (await enableRes.json()) as {
    readonly totpURI?: string;
    readonly backupCodes?: readonly string[];
  };
  const totpUri = enableBody.totpURI ?? "";
  const backupCodes = enableBody.backupCodes ?? [];
  const manualSecret = extractManualTotpSecret(totpUri);

  // Confirm enrollment with live RFC 6238 TOTP code
  const totpCode = await generateTotpCodeFromBase32Secret(manualSecret);
  const verifyRes = await params.auth.api.verifyTOTP({
    headers: new Headers({ cookie: cookieHeader }),
    body: { code: totpCode },
    asResponse: true,
  });
  if (!verifyRes.ok) {
    throw new Error(`Fixture verifyTOTP failed (${verifyRes.status}).`);
  }
  cookieHeader = mergeCookieHeaders(cookieHeader, verifyRes.headers);

  const verifiedSession = await params.auth.api.getSession({
    headers: new Headers({ cookie: cookieHeader }),
  });
  if (!verifiedSession?.user || !verifiedSession.session) {
    throw new Error("Fixture could not resolve verified session after verifyTOTP.");
  }

  await recordSessionSecondFactorVerification(platformDb, {
    sessionId: verifiedSession.session.id,
    userId: verifiedSession.user.id,
    method: "totp",
    nowMs,
  });

  return {
    user: {
      id: verifiedSession.user.id,
      email: verifiedSession.user.email,
      name: verifiedSession.user.name,
    },
    session: {
      id: verifiedSession.session.id,
      userId: verifiedSession.session.userId,
      token: verifiedSession.session.token,
    },
    cookieHeader,
    totpUri,
    manualSecret,
    backupCodes,
    verifiedAtMs: nowMs,
    generateCurrentTotpCode: (ts?: number) =>
      generateTotpCodeFromBase32Secret(manualSecret, { timestampMs: ts }),
  };
}

export { encodeQrMatrix, generateTotpQrSvg, type QrCodeMatrix } from "./qr.ts";

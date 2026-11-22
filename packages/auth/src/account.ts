import {
  ALLOWED_EMAIL_SENDER,
  DEFAULT_EMAIL_SENDER_NAME,
  renderEmailTemplate,
  type EmailPort,
} from "@punyasitus/core/email/index";
import type { ApiErrorCode } from "@punyasitus/core/schemas";
import { createSqliteDrizzle } from "@punyasitus/db/connections";
import { accounts, platformSchema, sessions, users, verifications } from "@punyasitus/db/platform";
import { verifyPassword } from "better-auth/crypto";
import { and, desc, eq, gt } from "drizzle-orm";

/**
 * Own-account operations for the authenticated user (PLAN §11.2; REQ-034).
 *
 * Security invariants:
 * - Current user only (every query is strictly scoped to `userId`).
 * - Email change, password change, and active-session revocation REQUIRE recent
 *   reauthentication (`currentPassword` verified against stored credential hash,
 *   or an explicit fresh-reauth timestamp within `reauthWindowMs`).
 * - Active session list NEVER exposes raw session tokens to the UI.
 * - Verification links are single-use, expiring, and never logged.
 */

export const DEFAULT_REAUTH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const EMAIL_VERIFY_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

const SIMPLE_EMAIL_RE = /^[^\s@<>,;"'\\]+@[^\s@<>,;"'\\]+\.[^\s@<>,;"'\\]{2,}$/;

export class AccountOperationError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422;
  readonly code: ApiErrorCode;

  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 422,
    code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccountOperationError";
    this.status = status;
    this.code = code;
  }
}

export interface ReauthenticationProof {
  readonly userId: string;
  readonly currentPassword?: string;
  /**
   * Optional explicit timestamp (epoch ms) when the user completed a step-up / fresh
   * reauthentication check. Regular session creation alone does not satisfy reauth
   * unless `allowFreshSession` is explicitly set AND `sessionCreatedAt` is within window.
   */
  readonly reauthenticatedAtMs?: number | null;
  readonly sessionCreatedAt?: Date | number;
  readonly allowFreshSession?: boolean;
  readonly reauthWindowMs?: number;
  readonly nowMs?: number;
}

export interface AccountProfileDto {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface ActiveSessionDto {
  readonly id: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly isCurrent: boolean;
}

function generateSecureToken(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i += 1) {
    hex += (buf[i] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Verifies a plaintext password against the user's Better Auth `credential` account hash.
 */
export async function verifyUserPassword(
  platformDb: D1Database,
  userId: string,
  password: string,
): Promise<boolean> {
  if (!userId.trim() || !password) return false;
  const db = createSqliteDrizzle(platformDb, platformSchema);
  const rows = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
    .limit(1);

  const hash = rows[0]?.password;
  if (!hash) return false;

  try {
    return await verifyPassword({ hash, password });
  } catch {
    return false;
  }
}

/**
 * Enforces recent reauthentication before sensitive account mutations
 * (email change, password change, active session revocation; PLAN §11.2).
 */
export async function assertRecentReauthentication(
  platformDb: D1Database,
  proof: ReauthenticationProof,
): Promise<{ readonly method: "password" | "fresh_reauth" }> {
  const nowMs = proof.nowMs ?? Date.now();
  const windowMs = proof.reauthWindowMs ?? DEFAULT_REAUTH_WINDOW_MS;

  if (typeof proof.currentPassword === "string" && proof.currentPassword.length > 0) {
    const valid = await verifyUserPassword(platformDb, proof.userId, proof.currentPassword);
    if (!valid) {
      throw new AccountOperationError(
        403,
        "REAUTH_REQUIRED",
        "Kata sandi saat ini tidak sesuai. Silakan periksa kembali.",
      );
    }
    return { method: "password" };
  }

  if (typeof proof.reauthenticatedAtMs === "number" && Number.isFinite(proof.reauthenticatedAtMs)) {
    const elapsed = nowMs - proof.reauthenticatedAtMs;
    if (elapsed >= 0 && elapsed <= windowMs) {
      return { method: "fresh_reauth" };
    }
    throw new AccountOperationError(
      403,
      "REAUTH_REQUIRED",
      "Jendela autentikasi ulang telah kedaluwarsa. Masukkan kata sandi Anda untuk melanjutkan.",
    );
  }

  if (proof.allowFreshSession && proof.sessionCreatedAt !== undefined) {
    const createdMs =
      proof.sessionCreatedAt instanceof Date
        ? proof.sessionCreatedAt.getTime()
        : proof.sessionCreatedAt;
    const elapsed = nowMs - createdMs;
    if (elapsed >= 0 && elapsed <= windowMs) {
      return { method: "fresh_reauth" };
    }
    throw new AccountOperationError(
      403,
      "REAUTH_REQUIRED",
      "Sesi tidak lagi baru. Masukkan kata sandi saat ini untuk autentikasi ulang.",
    );
  }

  throw new AccountOperationError(
    403,
    "REAUTH_REQUIRED",
    "Autentikasi ulang diperlukan untuk tindakan ini. Masukkan kata sandi Anda saat ini.",
  );
}

/**
 * Updates the current user's private display name (`users.name`).
 */
export async function updateAccountProfile(
  platformDb: D1Database,
  params: {
    readonly userId: string;
    readonly name: string;
  },
): Promise<AccountProfileDto> {
  const cleanName = params.name.trim();
  if (cleanName.length < 2 || cleanName.length > 120 || /[\r\n\0]/.test(cleanName)) {
    throw new AccountOperationError(
      422,
      "VALIDATION_ERROR",
      "Nama tampilan harus terdiri dari 2 hingga 120 karakter.",
    );
  }

  const db = createSqliteDrizzle(platformDb, platformSchema);
  const now = new Date();
  await db
    .update(users)
    .set({ name: cleanName, updatedAt: now })
    .where(eq(users.id, params.userId));

  const updated = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.id, params.userId))
    .limit(1);

  const row = updated[0];
  if (!row) {
    throw new AccountOperationError(404, "NOT_FOUND", "Akun tidak ditemukan.");
  }

  return row;
}

/**
 * Changes the current user's account email after enforcing recent reauthentication.
 * Resets `emailVerified` to false and optionally dispatches a single-use verification link
 * through the configured `EmailPort` (local mail sink in dev/CI).
 */
export async function changeAccountEmail(
  platformDb: D1Database,
  params: {
    readonly userId: string;
    readonly newEmail: string;
    readonly currentPassword?: string;
    readonly reauthenticatedAtMs?: number | null;
    readonly sessionCreatedAt?: Date | number;
    readonly allowFreshSession?: boolean;
    readonly reauthWindowMs?: number;
    readonly nowMs?: number;
    readonly emailPort?: EmailPort | null;
    readonly baseURL?: string;
  },
): Promise<AccountProfileDto & { readonly verificationSent: boolean }> {
  await assertRecentReauthentication(platformDb, {
    userId: params.userId,
    currentPassword: params.currentPassword,
    reauthenticatedAtMs: params.reauthenticatedAtMs,
    sessionCreatedAt: params.sessionCreatedAt,
    allowFreshSession: params.allowFreshSession,
    reauthWindowMs: params.reauthWindowMs,
    nowMs: params.nowMs,
  });

  const normalizedEmail = params.newEmail.trim().toLowerCase();
  if (
    !normalizedEmail ||
    normalizedEmail.length > 320 ||
    /[\r\n\0]/.test(normalizedEmail) ||
    !SIMPLE_EMAIL_RE.test(normalizedEmail)
  ) {
    throw new AccountOperationError(422, "VALIDATION_ERROR", "Format alamat email baru tidak valid.");
  }

  const db = createSqliteDrizzle(platformDb, platformSchema);
  const currentRows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, params.userId))
    .limit(1);

  const currentUser = currentRows[0];
  if (!currentUser) {
    throw new AccountOperationError(404, "NOT_FOUND", "Akun tidak ditemukan.");
  }

  if (currentUser.email.toLowerCase() === normalizedEmail) {
    throw new AccountOperationError(
      422,
      "VALIDATION_ERROR",
      "Email baru harus berbeda dari email saat ini.",
    );
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (existing[0] && existing[0].id !== params.userId) {
    throw new AccountOperationError(
      409,
      "CONFLICT",
      "Alamat email tersebut tidak dapat digunakan.",
    );
  }

  const nowMs = params.nowMs ?? Date.now();
  const now = new Date(nowMs);
  await db
    .update(users)
    .set({
      email: normalizedEmail,
      emailVerified: false,
      updatedAt: now,
    })
    .where(eq(users.id, params.userId));

  let verificationSent = false;
  if (params.emailPort) {
    const rawToken = generateSecureToken(24);
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = new Date(nowMs + EMAIL_VERIFY_TOKEN_TTL_MS);

    await db.insert(verifications).values({
      id: `ver_${generateSecureToken(12)}`,
      identifier: `email-change:${params.userId}:${normalizedEmail}`,
      value: tokenHash,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    const base = (params.baseURL ?? "https://app.punyasitus.com").replace(/\/+$/, "");
    const verifyUrl = `${base}/account?verifyEmailToken=${encodeURIComponent(rawToken)}`;
    const rendered = renderEmailTemplate("verify-email", {
      recipientName: currentUser.name,
      verifyUrl,
      expiresInMinutes: Math.round(EMAIL_VERIFY_TOKEN_TTL_MS / 60_000),
    });

    await params.emailPort.send({
      messageKey: `email-change:${params.userId}:${tokenHash.slice(0, 16)}`,
      template: "verify-email",
      from: ALLOWED_EMAIL_SENDER,
      fromName: DEFAULT_EMAIL_SENDER_NAME,
      to: normalizedEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      oneShot: true,
    });
    verificationSent = true;
  }

  return {
    id: currentUser.id,
    name: currentUser.name,
    email: normalizedEmail,
    emailVerified: false,
    verificationSent,
  };
}

export interface BetterAuthPasswordChanger {
  readonly api: {
    changePassword(input: {
      headers: Headers;
      body: {
        currentPassword: string;
        newPassword: string;
        revokeOtherSessions?: boolean;
      };
    }): Promise<unknown>;
  };
}

/**
 * Changes the current user's password via Better Auth after enforcing password reauthentication.
 * Revokes other active sessions by default (`revokeOtherSessions: true`).
 */
export async function changeAccountPassword(
  platformDb: D1Database,
  auth: BetterAuthPasswordChanger,
  params: {
    readonly userId: string;
    readonly headers: Headers;
    readonly currentPassword?: string;
    readonly newPassword: string;
    readonly revokeOtherSessions?: boolean;
  },
): Promise<{ readonly changed: true; readonly revokedOtherSessions: boolean }> {
  if (!params.currentPassword || params.currentPassword.length === 0) {
    throw new AccountOperationError(
      403,
      "REAUTH_REQUIRED",
      "Kata sandi saat ini wajib diisi untuk mengubah kata sandi.",
    );
  }

  if (params.newPassword.length < 8 || params.newPassword.length > 128) {
    throw new AccountOperationError(
      422,
      "VALIDATION_ERROR",
      "Kata sandi baru harus terdiri dari 8 hingga 128 karakter.",
    );
  }

  if (params.newPassword === params.currentPassword) {
    throw new AccountOperationError(
      422,
      "VALIDATION_ERROR",
      "Kata sandi baru harus berbeda dari kata sandi saat ini.",
    );
  }

  await assertRecentReauthentication(platformDb, {
    userId: params.userId,
    currentPassword: params.currentPassword,
  });

  const revokeOthers = params.revokeOtherSessions ?? true;
  await auth.api.changePassword({
    headers: params.headers,
    body: {
      currentPassword: params.currentPassword,
      newPassword: params.newPassword,
      revokeOtherSessions: revokeOthers,
    },
  });

  return {
    changed: true,
    revokedOtherSessions: revokeOthers,
  };
}

/**
 * Lists non-expired sessions for the current user without exposing raw session tokens.
 */
export async function listAccountSessions(
  platformDb: D1Database,
  params: {
    readonly userId: string;
    readonly currentSessionId: string;
    readonly nowMs?: number;
  },
): Promise<readonly ActiveSessionDto[]> {
  const db = createSqliteDrizzle(platformDb, platformSchema);
  const now = new Date(params.nowMs ?? Date.now());

  const rows = await db
    .select({
      id: sessions.id,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, params.userId), gt(sessions.expiresAt, now)))
    .orderBy(desc(sessions.createdAt));

  return rows.map((row) => ({
    id: row.id,
    ipAddress: row.ipAddress ?? null,
    userAgent: row.userAgent ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    isCurrent: row.id === params.currentSessionId,
  }));
}

/**
 * Revokes an active session belonging to the current user after enforcing recent reauthentication.
 * Attempting to revoke another user's session ID returns 404 (no cross-user disclosure).
 */
export async function revokeAccountSession(
  platformDb: D1Database,
  params: {
    readonly userId: string;
    readonly currentSessionId: string;
    readonly targetSessionId: string;
    readonly currentPassword?: string;
    readonly reauthenticatedAtMs?: number | null;
    readonly sessionCreatedAt?: Date | number;
    readonly allowFreshSession?: boolean;
    readonly reauthWindowMs?: number;
    readonly nowMs?: number;
  },
): Promise<{
  readonly revoked: true;
  readonly sessionId: string;
  readonly revokedCurrent: boolean;
}> {
  await assertRecentReauthentication(platformDb, {
    userId: params.userId,
    currentPassword: params.currentPassword,
    reauthenticatedAtMs: params.reauthenticatedAtMs,
    sessionCreatedAt: params.sessionCreatedAt,
    allowFreshSession: params.allowFreshSession,
    reauthWindowMs: params.reauthWindowMs,
    nowMs: params.nowMs,
  });

  const targetId = params.targetSessionId.trim();
  if (!targetId) {
    throw new AccountOperationError(422, "VALIDATION_ERROR", "ID sesi wajib diisi.");
  }

  const db = createSqliteDrizzle(platformDb, platformSchema);
  const existing = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, targetId), eq(sessions.userId, params.userId)))
    .limit(1);

  if (!existing[0]) {
    throw new AccountOperationError(404, "NOT_FOUND", "Sesi aktif tidak ditemukan.");
  }

  await db
    .delete(sessions)
    .where(and(eq(sessions.id, targetId), eq(sessions.userId, params.userId)));

  return {
    revoked: true,
    sessionId: targetId,
    revokedCurrent: targetId === params.currentSessionId,
  };
}

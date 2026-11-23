import {
  ALLOWED_EMAIL_SENDER,
  DEFAULT_EMAIL_SENDER_NAME,
  renderEmailTemplate,
  type EmailDeliveryOutcome,
  type EmailPort,
} from "@punyasitus/core/email/index";
import {
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  generateSecureHexToken,
  RESEND_VERIFICATION_COOLDOWN_MS,
  RESEND_VERIFICATION_MAX_PER_HOUR,
  RESEND_VERIFICATION_WINDOW_MS,
  sha256Hex,
} from "@punyasitus/core/onboarding/index";
import { buildPlatformAuditStatement } from "@punyasitus/db/platform";

/**
 * Verified-email token issuance, rate-limited resend, single-use hashed redemption,
 * replay safety, expired-link recovery, and graceful email-outage handling
 * (`packages/auth/src/onboarding/index.ts`; REQ-059, PLAN §17.2, §17.4, TASK-058).
 *
 * Security invariants:
 * - Tokens are 256-bit random hex values stored ONLY as SHA-256 digests (`onboarding-verify:<hash>`)
 *   in `PLATFORM_DB.verifications`. Plaintext tokens are never persisted or audited.
 * - Single-use redemption runs atomically in one `D1Database.batch` using CAS on `verifications.value`.
 * - Replayed redemption of an already-verified account succeeds idempotently (`replayed: true`).
 * - Expired links fail explicitly (`status: "expired"`) so the UI offers a resend CTA.
 * - Resends enforce a 60s cooldown and max 3 sends per hour per user (PLAN §17.4).
 * - Email delivery failures surface a structured `email_outage` status without leaking internals.
 */

const VERIFY_IDENTIFIER_PREFIX = "onboarding-verify:" as const;
const VERIFY_RATE_LIMIT_PREFIX = "onboarding-verify-rl:" as const;
const HEX_TOKEN_RE = /^[a-f0-9]{32,128}$/i;

export type OnboardingAuthErrorCode =
  | "UNAUTHENTICATED"
  | "EMAIL_NOT_VERIFIED"
  | "INVALID_VERIFICATION_TOKEN"
  | "VERIFICATION_TOKEN_EXPIRED"
  | "RATE_LIMITED"
  | "EMAIL_DELIVERY_FAILED"
  | "VALIDATION_ERROR";

export class OnboardingAuthError extends Error {
  readonly status: 400 | 401 | 403 | 410 | 422 | 429 | 503;
  readonly code: OnboardingAuthErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(
    status: 400 | 401 | 403 | 410 | 422 | 429 | 503,
    code: OnboardingAuthErrorCode,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "OnboardingAuthError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface StoredVerificationPayload {
  readonly userId: string;
  readonly email: string;
  readonly createdAtMs: number;
  readonly consumedAtMs: number | null;
}

interface UserRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly email_verified: number;
}

export interface IssueEmailVerificationResult {
  readonly status: "sent" | "already_verified" | "email_outage" | "not_found";
  readonly emailSent: boolean;
  readonly userId?: string;
  readonly expiresAtMs?: number;
  readonly deliveryOutcome?: EmailDeliveryOutcome;
  readonly errorCode?: string | null;
  /** Internal only for unit/integration tests; HTTP endpoints MUST NEVER serialize this field. */
  readonly rawToken?: string;
}

export interface RedeemEmailVerificationResult {
  readonly status: "verified" | "already_verified" | "expired";
  readonly replayed: boolean;
  readonly userId: string;
  readonly email: string;
}

export interface VerifiedOnboardingUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: true;
}

/**
 * Authoritatively checks `PLATFORM_DB.users.email_verified === 1` for a user.
 * Fails closed (`403 EMAIL_NOT_VERIFIED`) if email is not verified.
 */
export async function assertVerifiedOnboardingUser(
  platformDb: D1Database,
  userId: string,
): Promise<VerifiedOnboardingUser> {
  const cleanId = userId.trim();
  if (!cleanId) {
    throw new OnboardingAuthError(
      401,
      "UNAUTHENTICATED",
      "Sesi pengguna tidak ditemukan. Silakan masuk kembali.",
    );
  }

  const row = await platformDb
    .prepare("SELECT id, name, email, email_verified FROM users WHERE id = ? LIMIT 1")
    .bind(cleanId)
    .first<UserRow>();

  if (!row) {
    throw new OnboardingAuthError(
      401,
      "UNAUTHENTICATED",
      "Akun pengguna tidak ditemukan. Silakan masuk kembali.",
    );
  }

  if (row.email_verified !== 1) {
    throw new OnboardingAuthError(
      403,
      "EMAIL_NOT_VERIFIED",
      "Alamat email Anda belum terverifikasi. Selesaikan verifikasi email sebelum membuat website.",
    );
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: true,
  };
}

/**
 * Issues a single-use expiring hashed verification token and dispatches the
 * Bahasa Indonesia `verify-email` template through `EmailPort`.
 * Enforces PLAN §17.4 rate limits (60s cooldown + max 3 sends per hour).
 */
export async function issueEmailVerificationToken(
  platformDb: D1Database,
  params: {
    readonly userId?: string;
    readonly email?: string;
    readonly baseURL?: string;
    readonly emailPort?: EmailPort | null;
    readonly ttlMs?: number;
    readonly nowMs?: number;
    readonly enforceRateLimit?: boolean;
  },
): Promise<IssueEmailVerificationResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const ttlMs = Math.max(60_000, Math.trunc(params.ttlMs ?? EMAIL_VERIFICATION_TOKEN_TTL_MS));
  const enforceRateLimit = params.enforceRateLimit !== false;

  let user: UserRow | null = null;
  if (params.userId && params.userId.trim()) {
    user = await platformDb
      .prepare("SELECT id, name, email, email_verified FROM users WHERE id = ? LIMIT 1")
      .bind(params.userId.trim())
      .first<UserRow>();
  } else if (params.email && params.email.trim()) {
    user = await platformDb
      .prepare("SELECT id, name, email, email_verified FROM users WHERE lower(email) = ? LIMIT 1")
      .bind(params.email.trim().toLowerCase())
      .first<UserRow>();
  }

  if (!user) {
    return { status: "not_found", emailSent: false };
  }

  if (user.email_verified === 1) {
    return {
      status: "already_verified",
      emailSent: false,
      userId: user.id,
    };
  }

  const rateLimitIdentifier = `${VERIFY_RATE_LIMIT_PREFIX}${user.id}`;
  if (enforceRateLimit) {
    const windowStartMs = nowMs - RESEND_VERIFICATION_WINDOW_MS;
    const recentRows = await platformDb
      .prepare(
        `SELECT created_at FROM verifications
         WHERE identifier = ? AND created_at > ?
         ORDER BY created_at DESC
         LIMIT 10`,
      )
      .bind(rateLimitIdentifier, windowStartMs)
      .all<{ readonly created_at: number }>();

    const sends = recentRows.results ?? [];
    const latest = sends[0];
    if (latest && nowMs - latest.created_at < RESEND_VERIFICATION_COOLDOWN_MS) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((RESEND_VERIFICATION_COOLDOWN_MS - (nowMs - latest.created_at)) / 1000),
      );
      throw new OnboardingAuthError(
        429,
        "RATE_LIMITED",
        `Tunggu ${retryAfterSeconds} detik sebelum meminta tautan verifikasi lagi.`,
        retryAfterSeconds,
      );
    }

    if (sends.length >= RESEND_VERIFICATION_MAX_PER_HOUR) {
      const oldestInWindow = sends[RESEND_VERIFICATION_MAX_PER_HOUR - 1];
      const retryAfterSeconds = oldestInWindow
        ? Math.max(1, Math.ceil((oldestInWindow.created_at + RESEND_VERIFICATION_WINDOW_MS - nowMs) / 1000))
        : 60;
      throw new OnboardingAuthError(
        429,
        "RATE_LIMITED",
        "Batas pengiriman tautan verifikasi (maksimal 3 kali per jam) tercapai. Silakan coba lagi nanti.",
        retryAfterSeconds,
      );
    }
  }

  const rawToken = generateSecureHexToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const expiresAtMs = nowMs + ttlMs;
  const payload: StoredVerificationPayload = {
    userId: user.id,
    email: user.email.trim().toLowerCase(),
    createdAtMs: nowMs,
    consumedAtMs: null,
  };

  await platformDb.batch([
    platformDb
      .prepare(
        `INSERT INTO verifications (id, identifier, value, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `emver_${generateSecureHexToken(12)}`,
        `${VERIFY_IDENTIFIER_PREFIX}${tokenHash}`,
        JSON.stringify(payload),
        expiresAtMs,
        nowMs,
        nowMs,
      ),
    platformDb
      .prepare(
        `INSERT INTO verifications (id, identifier, value, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `emvrl_${generateSecureHexToken(12)}`,
        rateLimitIdentifier,
        "sent",
        nowMs + RESEND_VERIFICATION_WINDOW_MS,
        nowMs,
        nowMs,
      ),
  ]);

  if (!params.emailPort) {
    return {
      status: "email_outage",
      emailSent: false,
      userId: user.id,
      expiresAtMs,
      deliveryOutcome: "skipped",
      errorCode: "EMAIL_TRANSPORT_UNAVAILABLE",
      rawToken,
    };
  }

  const baseUrl = (params.baseURL ?? "https://app.punyasitus.com").replace(/\/+$/, "");
  const verifyUrl = `${baseUrl}/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
  const rendered = renderEmailTemplate("verify-email", {
    recipientName: user.name,
    verifyUrl,
    expiresInMinutes: Math.max(1, Math.round(ttlMs / 60_000)),
  });

  try {
    const sendRes = await params.emailPort.send({
      messageKey: `onboarding-verify-email:${user.id}:${tokenHash.slice(0, 16)}`,
      template: "verify-email",
      from: ALLOWED_EMAIL_SENDER,
      fromName: DEFAULT_EMAIL_SENDER_NAME,
      to: user.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      oneShot: true,
    });

    if (sendRes.outcome !== "submitted") {
      return {
        status: "email_outage",
        emailSent: false,
        userId: user.id,
        expiresAtMs,
        deliveryOutcome: sendRes.outcome,
        errorCode: sendRes.errorCode ?? "EMAIL_DELIVERY_FAILED",
        rawToken,
      };
    }

    return {
      status: "sent",
      emailSent: true,
      userId: user.id,
      expiresAtMs,
      deliveryOutcome: "submitted",
      errorCode: null,
      rawToken,
    };
  } catch {
    return {
      status: "email_outage",
      emailSent: false,
      userId: user.id,
      expiresAtMs,
      deliveryOutcome: "unknown",
      errorCode: "EMAIL_PROVIDER_ERROR",
      rawToken,
    };
  }
}

/**
 * Atomically redeems a single-use hashed email verification token.
 * - Replay-safe: re-submitting an already-redeemed token for an already-verified account
 *   returns `{ status: "already_verified", replayed: true }` with zero duplicate side effects.
 * - Expired tokens for unverified accounts return `{ status: "expired" }` for resend recovery.
 */
export async function redeemEmailVerificationToken(
  platformDb: D1Database,
  params: {
    readonly token: string;
    readonly requestId?: string | null;
    readonly nowMs?: number;
  },
): Promise<RedeemEmailVerificationResult> {
  const rawToken = typeof params.token === "string" ? params.token.trim() : "";
  if (!HEX_TOKEN_RE.test(rawToken)) {
    throw new OnboardingAuthError(
      400,
      "INVALID_VERIFICATION_TOKEN",
      "Tautan verifikasi email tidak valid atau rusak.",
    );
  }

  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const tokenHash = await sha256Hex(rawToken);
  const identifier = `${VERIFY_IDENTIFIER_PREFIX}${tokenHash}`;

  const row = await platformDb
    .prepare(
      `SELECT id, value, expires_at
       FROM verifications
       WHERE identifier = ?
       LIMIT 1`,
    )
    .bind(identifier)
    .first<{ readonly id: string; readonly value: string; readonly expires_at: number }>();

  if (!row) {
    throw new OnboardingAuthError(
      400,
      "INVALID_VERIFICATION_TOKEN",
      "Tautan verifikasi email tidak ditemukan atau sudah tidak berlaku.",
    );
  }

  let parsed: StoredVerificationPayload;
  try {
    const raw = JSON.parse(row.value) as Partial<StoredVerificationPayload>;
    if (typeof raw.userId !== "string" || typeof raw.email !== "string") {
      throw new Error("Malformed payload");
    }
    parsed = {
      userId: raw.userId,
      email: raw.email.toLowerCase(),
      createdAtMs: typeof raw.createdAtMs === "number" ? raw.createdAtMs : nowMs,
      consumedAtMs: typeof raw.consumedAtMs === "number" ? raw.consumedAtMs : null,
    };
  } catch {
    throw new OnboardingAuthError(
      400,
      "INVALID_VERIFICATION_TOKEN",
      "Data verifikasi email tidak valid.",
    );
  }

  const user = await platformDb
    .prepare("SELECT id, name, email, email_verified FROM users WHERE id = ? LIMIT 1")
    .bind(parsed.userId)
    .first<UserRow>();

  if (!user || user.email.trim().toLowerCase() !== parsed.email) {
    throw new OnboardingAuthError(
      400,
      "INVALID_VERIFICATION_TOKEN",
      "Tautan verifikasi tidak lagi cocok dengan alamat email akun Anda.",
    );
  }

  // Idempotent replay: token was already redeemed or account is already verified
  if (parsed.consumedAtMs !== null || user.email_verified === 1) {
    return {
      status: "already_verified",
      replayed: true,
      userId: user.id,
      email: user.email,
    };
  }

  // Expired link recovery path
  if (row.expires_at <= nowMs) {
    return {
      status: "expired",
      replayed: false,
      userId: user.id,
      email: user.email,
    };
  }

  const consumedPayload: StoredVerificationPayload = {
    ...parsed,
    consumedAtMs: nowMs,
  };
  const consumedJson = JSON.stringify(consumedPayload);

  const { statement: auditStmt } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: user.id,
      actorRole: "owner",
      action: "onboarding.email.verified",
      targetType: "user",
      targetId: user.id,
      outcome: "success",
      requestId: params.requestId ?? null,
      metadata: {
        tokenHashPrefix: tokenHash.slice(0, 12),
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  // Atomic CAS redemption: if two requests race, only one flips the row and appends the audit entry.
  const [consumeRes] = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE verifications
         SET value = ?, updated_at = ?
         WHERE id = ? AND value = ?`,
      )
      .bind(consumedJson, nowMs, row.id, row.value),
    auditStmt,
    platformDb
      .prepare(
        `UPDATE users
         SET email_verified = 1, updated_at = ?
         WHERE id = ? AND lower(email) = ?`,
      )
      .bind(nowMs, user.id, parsed.email),
  ]);

  if ((consumeRes?.meta?.changes ?? 0) !== 1) {
    // Concurrent replay race: confirm user is now verified and treat as idempotent replay
    const recheck = await platformDb
      .prepare("SELECT email_verified FROM users WHERE id = ? LIMIT 1")
      .bind(user.id)
      .first<{ readonly email_verified: number }>();
    if (recheck?.email_verified === 1) {
      return {
        status: "already_verified",
        replayed: true,
        userId: user.id,
        email: user.email,
      };
    }
    throw new OnboardingAuthError(
      400,
      "INVALID_VERIFICATION_TOKEN",
      "Tautan verifikasi sudah diproses. Silakan muat ulang halaman.",
    );
  }

  return {
    status: "verified",
    replayed: false,
    userId: user.id,
    email: user.email,
  };
}

import type { PunyaSitusAuth } from "../index.ts";
import {
  applySessionTwoFactorMigration,
  extractManualTotpSecret,
  generateTotpCodeFromBase32Secret,
  mergeCookieHeaders,
  recordSessionSecondFactorVerification,
} from "../platform/two-factor.ts";

/**
 * Reusable test fixture helper that creates a verified app user, optionally enrolls
 * real Better Auth TOTP 2FA, and optionally records `session_two_factor_verifications`
 * (REQ-083, REQ-068, TASK-083).
 */
export interface AgencyUserFixture {
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
  readonly twoFactorEnrolled: boolean;
  readonly twoFactorVerified: boolean;
  readonly manualSecret: string | null;
  readonly backupCodes: readonly string[];
}

export async function createAgencyUserFixture(
  platformDb: D1Database,
  params: {
    readonly auth: PunyaSitusAuth;
    readonly email: string;
    readonly password: string;
    readonly name?: string;
    readonly emailVerified?: boolean;
    readonly enrollTwoFactor?: boolean;
    readonly verifySessionTwoFactor?: boolean;
    readonly nowMs?: number;
  },
): Promise<AgencyUserFixture> {
  await applySessionTwoFactorMigration(platformDb);
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const name = params.name ?? "Admin Agensi Fixture";
  const enrollTwoFactor = params.enrollTwoFactor ?? true;
  const verifySessionTwoFactor = params.verifySessionTwoFactor ?? enrollTwoFactor;

  const signUpRes = await params.auth.api.signUpEmail({
    body: {
      email: params.email,
      password: params.password,
      name,
    },
    asResponse: true,
  });
  if (!signUpRes.ok) {
    throw new Error(`Agency fixture signUpEmail failed (${signUpRes.status}).`);
  }

  let cookieHeader = mergeCookieHeaders(null, signUpRes.headers);
  const initialSession = await params.auth.api.getSession({
    headers: new Headers({ cookie: cookieHeader }),
  });
  if (!initialSession?.user || !initialSession.session) {
    throw new Error("Agency fixture could not resolve initial session.");
  }

  if (params.emailVerified !== false) {
    await platformDb
      .prepare("UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?")
      .bind(nowMs, initialSession.user.id)
      .run();
  }

  if (!enrollTwoFactor) {
    return {
      user: {
        id: initialSession.user.id,
        email: initialSession.user.email,
        name: initialSession.user.name,
      },
      session: {
        id: initialSession.session.id,
        userId: initialSession.session.userId,
        token: initialSession.session.token,
      },
      cookieHeader,
      twoFactorEnrolled: false,
      twoFactorVerified: false,
      manualSecret: null,
      backupCodes: [],
    };
  }

  const enableRes = await params.auth.api.enableTwoFactor({
    headers: new Headers({ cookie: cookieHeader }),
    body: {
      password: params.password,
      issuer: "PunyaSitus",
    },
    asResponse: true,
  });
  if (!enableRes.ok) {
    throw new Error(`Agency fixture enableTwoFactor failed (${enableRes.status}).`);
  }
  cookieHeader = mergeCookieHeaders(cookieHeader, enableRes.headers);
  const enableBody = (await enableRes.json()) as {
    readonly totpURI?: string;
    readonly backupCodes?: readonly string[];
  };
  const manualSecret = extractManualTotpSecret(enableBody.totpURI ?? "");
  const backupCodes = enableBody.backupCodes ?? [];

  const totpCode = await generateTotpCodeFromBase32Secret(manualSecret);
  const verifyRes = await params.auth.api.verifyTOTP({
    headers: new Headers({ cookie: cookieHeader }),
    body: { code: totpCode },
    asResponse: true,
  });
  if (!verifyRes.ok) {
    throw new Error(`Agency fixture verifyTOTP failed (${verifyRes.status}).`);
  }
  cookieHeader = mergeCookieHeaders(cookieHeader, verifyRes.headers);

  const verifiedSession = await params.auth.api.getSession({
    headers: new Headers({ cookie: cookieHeader }),
  });
  if (!verifiedSession?.user || !verifiedSession.session) {
    throw new Error("Agency fixture could not resolve verified session.");
  }

  if (verifySessionTwoFactor) {
    await recordSessionSecondFactorVerification(platformDb, {
      sessionId: verifiedSession.session.id,
      userId: verifiedSession.user.id,
      method: "totp",
      nowMs,
    });
  }

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
    twoFactorEnrolled: true,
    twoFactorVerified: verifySessionTwoFactor,
    manualSecret,
    backupCodes,
  };
}

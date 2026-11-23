import {
  buildCanonicalMcpResource,
  fetchCimdMetadataDocument,
  isMatchingMcpResource,
  isValidPkceCodeChallenge,
  MCP_ALLOWED_MEMBER_DB_ROLES,
  MCP_GRANT_MAX_LIFETIME_MS,
  McpConsentSubmitSchema,
  parseAndNormalizeMcpScopes,
  validateOAuthRedirectUri,
  verifyPkceS256,
  type FetchCimdOptions,
  type McpScope,
} from "@punyasitus/core/mcp/index";
import {
  consumeMcpAuthCodeAtomically,
  createMcpOAuthGrant,
  getMcpOAuthClient,
  issueMcpAuthCode,
  issueMcpTokenPair,
  lookupMcpAccessToken,
  revokeMcpGrantById,
  revokeMcpTokenByValue,
  rotateMcpRefreshTokenAtomically,
  touchMcpGrantLastUsedBestEffort,
  upsertMcpOAuthClient,
  type StoredMcpClient,
} from "@punyasitus/db/mcp/index";
import { appendPlatformAudit } from "@punyasitus/db/platform";
import { loadLiveTenantEntitlement, type LiveTenantEntitlement } from "../entitlements/index.ts";
import { AuthorizationError } from "../permissions.ts";
import { resolveAuthorizedTenantMember, type AuthorizedTenantMember } from "../session-guard.ts";

/**
 * OAuth 2.1 + PKCE S256 + RFC 8707 Resource Indicator + SSRF-safe CIMD +
 * live per-call membership & entitlement verification for Tenant MCP Server
 * (REQ-076, ADR-0008, PLAN §18.3, TASK-075).
 */

const MCP_ENTITLED_TENANT_STATUSES = new Set(["trial", "active", "grace"]);

export interface ValidatedAuthorizeParams {
  readonly client: StoredMcpClient;
  readonly redirectUri: string;
  readonly resource: string;
  readonly scopes: readonly McpScope[];
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  readonly state: string;
}

export type ValidateAuthorizeResult =
  | { readonly ok: true; readonly params: ValidatedAuthorizeParams }
  | { readonly ok: false; readonly status: 400 | 403; readonly error: string; readonly description: string };

export interface ResolveMcpClientOptions extends FetchCimdOptions {
  readonly nowMs?: number;
  /**
   * When `false` (used by `GET /auth/consent`), strictly reads pre-validated clients from
   * `PLATFORM_DB` without triggering any outbound CIMD HTTP fetch or D1 upsert.
   * Defaults to `true` (used by rate-limited `GET /oauth2/authorize`).
   */
  readonly allowOutboundCimdFetch?: boolean;
}

/**
 * Resolves and validates a CIMD client document with SSRF protection (HTTPS public host,
 * no redirects, size/timeout cap) and caches the validated client metadata in `PLATFORM_DB`.
 */
export async function resolveAndValidateMcpClient(
  platformDb: D1Database,
  rawClientId: string,
  options: ResolveMcpClientOptions = {},
): Promise<
  | { readonly ok: true; readonly client: StoredMcpClient }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const clientId = rawClientId.trim();
  if (!clientId) {
    return { ok: false, code: "invalid_client", message: "client_id wajib diisi." };
  }

  const allowOutbound = options.allowOutboundCimdFetch !== false;

  // If client_id looks like a URL (CIMD) and outbound fetch is explicitly allowed,
  // fetch & validate via SSRF-hardened CIMD fetcher and cache in PLATFORM_DB.
  if (
    allowOutbound &&
    (clientId.includes("://") || clientId.startsWith("http:") || clientId.startsWith("https:"))
  ) {
    const fetched = await fetchCimdMetadataDocument(clientId, options);
    if (!fetched.ok) {
      return { ok: false, code: fetched.code, message: fetched.message };
    }
    const stored = await upsertMcpOAuthClient(platformDb, fetched.document, {
      source: "cimd",
      nowMs: options.nowMs,
    });
    if (stored.disabled) {
      return { ok: false, code: "invalid_client", message: "Klien OAuth dinonaktifkan." };
    }
    return { ok: true, client: stored };
  }

  // Strictly read pre-validated cached CIMD or static client from DB (ZERO outbound fetch / D1 write!)
  const existing = await getMcpOAuthClient(platformDb, clientId);
  if (!existing || existing.disabled) {
    return {
      ok: false,
      code: "invalid_client",
      message: allowOutbound
        ? "client_id tidak dikenali. Gunakan URL Client ID Metadata Document (CIMD) HTTPS yang valid."
        : "Permintaan otorisasi klien harus dimulai melalui endpoint /oauth2/authorize terlebih dahulu.",
    };
  }
  return { ok: true, client: existing };
}

/**
 * Validates OAuth 2.1 `/oauth2/authorize` query parameters strictly BEFORE showing consent.
 * Enforces: `response_type=code`, SSRF-safe CIMD `client_id`, exact `redirect_uri` match,
 * `code_challenge_method=S256`, RFC 8707 canonical `resource`, and valid MCP scopes.
 */
export async function validateMcpAuthorizeRequest(
  platformDb: D1Database,
  searchParams: URLSearchParams,
  adminOrigin: string,
  options: ResolveMcpClientOptions = {},
): Promise<ValidateAuthorizeResult> {
  const responseType = (searchParams.get("response_type") ?? "").trim();
  if (responseType !== "code") {
    return {
      ok: false,
      status: 400,
      error: "unsupported_response_type",
      description: "Hanya response_type=code (OAuth 2.1 Authorization Code + PKCE) yang didukung.",
    };
  }

  const clientId = (searchParams.get("client_id") ?? "").trim();
  const clientRes = await resolveAndValidateMcpClient(platformDb, clientId, options);
  if (!clientRes.ok) {
    return {
      ok: false,
      status: 400,
      error: "invalid_client",
      description: clientRes.message,
    };
  }

  const redirectUri = (searchParams.get("redirect_uri") ?? "").trim();
  const redirectValidation = validateOAuthRedirectUri(redirectUri);
  if (!redirectValidation.ok || !clientRes.client.redirectUris.includes(redirectUri)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: "redirect_uri tidak cocok secara persis dengan dokumen metadata klien.",
    };
  }

  const codeChallengeMethod = (searchParams.get("code_challenge_method") ?? "").trim();
  const codeChallenge = (searchParams.get("code_challenge") ?? "").trim();
  if (codeChallengeMethod !== "S256" || !isValidPkceCodeChallenge(codeChallenge)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: "PKCE wajib menggunakan code_challenge_method=S256 dan code_challenge yang valid.",
    };
  }

  const canonicalResource = buildCanonicalMcpResource(adminOrigin);
  const resource = (searchParams.get("resource") ?? "").trim();
  if (!isMatchingMcpResource(resource, canonicalResource)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_target",
      description: `Parameter RFC 8707 resource wajib cocok dengan ${canonicalResource}.`,
    };
  }

  const rawScope = searchParams.get("scope") ?? "content:read";
  const scopeParsed = parseAndNormalizeMcpScopes(rawScope);
  if (!scopeParsed.ok) {
    return {
      ok: false,
      status: 400,
      error: "invalid_scope",
      description: `Scope tidak valid: ${scopeParsed.invalidScopes.join(", ") || "(kosong)"}.`,
    };
  }

  const state = (searchParams.get("state") ?? "").trim();

  return {
    ok: true,
    params: {
      client: clientRes.client,
      redirectUri,
      resource: canonicalResource,
      scopes: scopeParsed.scopes,
      codeChallenge,
      codeChallengeMethod: "S256",
      state,
    },
  };
}

export type SubmitConsentResult =
  | { readonly ok: true; readonly decision: "approve" | "deny"; readonly redirectTo: string; readonly grantId?: string }
  | { readonly ok: false; readonly status: 400 | 403 | 404 | 422; readonly code: string; readonly message: string };

/**
 * Processes an authenticated, CSRF/Origin-verified human consent submission on `/auth/consent`.
 *
 * Enforces:
 * - Only active `owner` or `admin` members of the selected tenant can connect AI agents (`editor` -> 403).
 * - Exactly ONE website (`tenantId`) is bound per grant.
 * - `leads:read` requires explicit `piiConsentAcked: true`.
 * - Locked / suspended / purged tenants cannot grant new MCP connections.
 * - Issues a single-use PKCE authorization code bound to client + redirect_uri + resource + grant.
 */
export async function submitMcpConsentDecision(
  platformDb: D1Database,
  params: {
    readonly userId: string;
    readonly rawBody: unknown;
    readonly adminOrigin: string;
    readonly requestId?: string | null;
    readonly nowMs?: number;
  } & FetchCimdOptions,
): Promise<SubmitConsentResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const parsed = McpConsentSubmitSchema.safeParse(params.rawBody);
  if (!parsed.success) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Data persetujuan OAuth tidak valid.",
    };
  }

  const input = parsed.data;
  const canonicalResource = buildCanonicalMcpResource(params.adminOrigin);
  if (!isMatchingMcpResource(input.resource, canonicalResource)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_RESOURCE",
      message: `Parameter resource wajib cocok dengan ${canonicalResource}.`,
    };
  }

  const clientRes = await resolveAndValidateMcpClient(platformDb, input.clientId, {
    fetchFn: params.fetchFn,
    timeoutMs: params.timeoutMs,
    maxBytes: params.maxBytes,
    nowMs,
  });
  if (!clientRes.ok) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_CLIENT",
      message: clientRes.message,
    };
  }

  const redirectCheck = validateOAuthRedirectUri(input.redirectUri);
  if (!redirectCheck.ok || !clientRes.client.redirectUris.includes(input.redirectUri)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_REDIRECT_URI",
      message: "redirect_uri tidak cocok dengan dokumen metadata klien.",
    };
  }

  if (!isValidPkceCodeChallenge(input.codeChallenge)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_PKCE",
      message: "code_challenge PKCE S256 tidak valid.",
    };
  }

  const redirectUrl = new URL(input.redirectUri);

  if (input.decision === "deny") {
    redirectUrl.searchParams.set("error", "access_denied");
    redirectUrl.searchParams.set("error_description", "Pengguna menolak permintaan akses.");
    if (input.state) redirectUrl.searchParams.set("state", input.state);
    return {
      ok: true,
      decision: "deny",
      redirectTo: redirectUrl.toString(),
    };
  }

  if (!input.tenantId?.trim()) {
    return {
      ok: false,
      status: 422,
      code: "TENANT_REQUIRED",
      message: "Pilih tepat satu situs web yang akan dihubungkan.",
    };
  }

  const scopeParsed = parseAndNormalizeMcpScopes(input.scopes ?? []);
  if (!scopeParsed.ok) {
    return {
      ok: false,
      status: 422,
      code: "INVALID_SCOPE",
      message: "Pilih minimal satu izin akses yang valid.",
    };
  }

  if (scopeParsed.scopes.includes("leads:read") && !input.piiConsentAcked) {
    return {
      ok: false,
      status: 422,
      code: "PII_CONSENT_REQUIRED",
      message:
        "Anda wajib menyetujui pernyataan pengiriman data pribadi prospek sebelum mengaktifkan izin leads:read.",
    };
  }

  // Live RBAC check: ONLY owner or admin can connect AI agents (`editor` -> 403!)
  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(platformDb, {
      userId: params.userId,
      tenantId: input.tenantId.trim(),
      surface: "app",
      nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        status: err.status === 404 ? 404 : 403,
        code: err.code,
        message: "Anda tidak memiliki akses pada situs yang dipilih.",
      };
    }
    throw err;
  }

  if (!MCP_ALLOWED_MEMBER_DB_ROLES.has(member.dbRole as "owner" | "admin")) {
    await appendPlatformAudit(platformDb, {
      actorUserId: params.userId,
      actorRole: member.dbRole,
      action: "mcp.oauth.consent_denied_role",
      targetType: "tenant",
      targetId: member.tenantId,
      tenantId: member.tenantId,
      outcome: "denied",
      requestId: params.requestId ?? null,
      metadata: { clientId: clientRes.client.clientId, memberRole: member.dbRole },
      createdAtMs: nowMs,
    });
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Hanya Pemilik (Owner) atau Admin situs yang dapat menghubungkan agen AI.",
    };
  }

  // Live entitlement check
  const entitlement = await loadLiveTenantEntitlement(
    platformDb,
    { tenantId: member.tenantId },
    { nowMs },
  );
  if (!entitlement || !MCP_ENTITLED_TENANT_STATUSES.has(entitlement.evaluation.effectiveStatus)) {
    return {
      ok: false,
      status: 403,
      code: "SUBSCRIPTION_LOCKED",
      message:
        "Situs sedang terkunci atau ditangguhkan sehingga tidak dapat dihubungkan ke agen AI.",
    };
  }

  const { grantId } = await createMcpOAuthGrant(platformDb, {
    clientId: clientRes.client.clientId,
    userId: params.userId,
    tenantId: member.tenantId,
    resource: canonicalResource,
    scopes: scopeParsed.scopes,
    piiConsentAcked: scopeParsed.scopes.includes("leads:read") && input.piiConsentAcked,
    requestId: params.requestId ?? null,
    nowMs,
  });

  const { code } = await issueMcpAuthCode(platformDb, {
    grantId,
    clientId: clientRes.client.clientId,
    userId: params.userId,
    tenantId: member.tenantId,
    redirectUri: input.redirectUri,
    resource: canonicalResource,
    scopes: scopeParsed.scopes,
    codeChallenge: input.codeChallenge,
    nowMs,
  });

  redirectUrl.searchParams.set("code", code);
  if (input.state) redirectUrl.searchParams.set("state", input.state);

  return {
    ok: true,
    decision: "approve",
    redirectTo: redirectUrl.toString(),
    grantId,
  };
}

export type TokenEndpointResult =
  | {
      readonly ok: true;
      readonly status: 200;
      readonly body: {
        readonly access_token: string;
        readonly token_type: "Bearer";
        readonly expires_in: number;
        readonly refresh_token: string;
        readonly scope: string;
        readonly resource: string;
      };
    }
  | {
      readonly ok: false;
      readonly status: 400 | 401;
      readonly body: {
        readonly error: string;
        readonly error_description: string;
      };
    };

/**
 * Handles `POST /oauth2/token` for `grant_type=authorization_code` (with strict PKCE S256,
 * single-use code enforcement, exact redirect_uri & RFC 8707 resource match) and
 * `grant_type=refresh_token` (with rotating refresh tokens & replay-family revocation).
 */
export async function exchangeMcpOAuthToken(
  platformDb: D1Database,
  formParams: URLSearchParams,
  adminOrigin: string,
  options: { readonly requestId?: string | null; readonly nowMs?: number } = {},
): Promise<TokenEndpointResult> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const grantType = (formParams.get("grant_type") ?? "").trim();
  const clientId = (formParams.get("client_id") ?? "").trim();
  const canonicalResource = buildCanonicalMcpResource(adminOrigin);
  const requestedResource = (formParams.get("resource") ?? "").trim();

  if (!clientId) {
    return {
      ok: false,
      status: 400,
      body: { error: "invalid_request", error_description: "client_id wajib diisi." },
    };
  }

  if (!isMatchingMcpResource(requestedResource, canonicalResource)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_target",
        error_description: `Parameter RFC 8707 resource wajib cocok dengan ${canonicalResource}.`,
      },
    };
  }

  if (grantType === "authorization_code") {
    const code = (formParams.get("code") ?? "").trim();
    const redirectUri = (formParams.get("redirect_uri") ?? "").trim();
    const codeVerifier = (formParams.get("code_verifier") ?? "").trim();

    if (!code || !redirectUri || !codeVerifier) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "code, redirect_uri, dan code_verifier wajib diisi.",
        },
      };
    }

    const consumed = await consumeMcpAuthCodeAtomically(platformDb, code, {
      requestId: options.requestId ?? null,
      nowMs,
    });
    if (!consumed.ok) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_grant",
          error_description:
            consumed.reason === "reused"
              ? "Kode otorisasi telah digunakan sebelumnya; seluruh akses terkait telah dicabut."
              : "Kode otorisasi tidak valid atau telah kedaluwarsa.",
        },
      };
    }

    const rec = consumed.record;
    const pkceValid = await verifyPkceS256(codeVerifier, rec.codeChallenge);
    if (
      rec.clientId !== clientId ||
      rec.redirectUri !== redirectUri ||
      !isMatchingMcpResource(rec.resource, canonicalResource) ||
      !pkceValid
    ) {
      await revokeMcpGrantById(platformDb, {
        grantId: rec.grantId,
        reason: "authorization_code_binding_mismatch",
        actorRole: "system",
        requestId: options.requestId ?? null,
        nowMs,
      });
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_grant",
          error_description:
            "Verifikasi client_id, redirect_uri, resource, atau PKCE code_verifier gagal.",
        },
      };
    }

    // Re-verify live membership & entitlement before minting tokens
    const liveCheck = await verifyLiveMcpMemberAndEntitlement(platformDb, {
      userId: rec.userId,
      tenantId: rec.tenantId,
      nowMs,
    });
    if (!liveCheck.ok) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: liveCheck.message,
        },
      };
    }

    const tokenPair = await issueMcpTokenPair(platformDb, {
      grantId: rec.grantId,
      resource: canonicalResource,
      scopes: rec.scopes,
      nowMs,
    });

    await appendPlatformAudit(platformDb, {
      actorUserId: rec.userId,
      actorRole: liveCheck.member.dbRole,
      action: "mcp.oauth.token_issued",
      targetType: "mcp_grant",
      targetId: rec.grantId,
      tenantId: rec.tenantId,
      outcome: "success",
      requestId: options.requestId ?? null,
      metadata: {
        clientId: rec.clientId,
        resource: canonicalResource,
        scopes: rec.scopes,
      },
      createdAtMs: nowMs,
    });

    return {
      ok: true,
      status: 200,
      body: {
        access_token: tokenPair.accessToken,
        token_type: "Bearer",
        expires_in: tokenPair.expiresInSeconds,
        refresh_token: tokenPair.refreshToken,
        scope: rec.scopes.join(" "),
        resource: canonicalResource,
      },
    };
  }

  if (grantType === "refresh_token") {
    const refreshToken = (formParams.get("refresh_token") ?? "").trim();
    if (!refreshToken) {
      return {
        ok: false,
        status: 400,
        body: { error: "invalid_request", error_description: "refresh_token wajib diisi." },
      };
    }

    const rotated = await rotateMcpRefreshTokenAtomically(platformDb, {
      rawRefreshToken: refreshToken,
      clientId,
      requestedResource: canonicalResource,
      requestId: options.requestId ?? null,
      nowMs,
    });

    if (!rotated.ok) {
      const errorCode = rotated.reason === "client_disabled" ? "invalid_client" : "invalid_grant";
      const description =
        rotated.reason === "replayed"
          ? "Refresh token telah digunakan ulang; seluruh keluarga token dan grant telah dicabut."
          : rotated.reason === "client_disabled"
            ? "Klien OAuth telah dinonaktifkan oleh operator platform."
            : rotated.reason === "grant_lifetime_exceeded"
              ? "Masa berlaku maksimum koneksi aplikasi AI telah berakhir. Hubungkan ulang aplikasi AI."
              : "Refresh token tidak valid, dicabut, atau telah kedaluwarsa.";
      return {
        ok: false,
        status: 400,
        body: {
          error: errorCode,
          error_description: description,
        },
      };
    }

    // Re-verify live membership & entitlement on refresh too
    const liveCheck = await verifyLiveMcpMemberAndEntitlement(platformDb, {
      userId: rotated.userId,
      tenantId: rotated.tenantId,
      nowMs,
    });
    if (!liveCheck.ok) {
      await revokeMcpGrantById(platformDb, {
        grantId: rotated.grantId,
        reason: "live_membership_or_entitlement_lost_on_refresh",
        actorRole: "system",
        requestId: options.requestId ?? null,
        nowMs,
      });
      return {
        ok: false,
        status: 400,
        body: { error: "invalid_grant", error_description: liveCheck.message },
      };
    }

    return {
      ok: true,
      status: 200,
      body: {
        access_token: rotated.tokenPair.accessToken,
        token_type: "Bearer",
        expires_in: rotated.tokenPair.expiresInSeconds,
        refresh_token: rotated.tokenPair.refreshToken,
        scope: rotated.scopes.join(" "),
        resource: canonicalResource,
      },
    };
  }

  return {
    ok: false,
    status: 400,
    body: {
      error: "unsupported_grant_type",
      error_description: "Hanya authorization_code dan refresh_token yang didukung.",
    },
  };
}

export async function handleMcpTokenRevocation(
  platformDb: D1Database,
  formParams: URLSearchParams,
  options: { readonly requestId?: string | null; readonly nowMs?: number } = {},
): Promise<{ readonly status: 200; readonly body: { readonly revoked: true } }> {
  const token = (formParams.get("token") ?? "").trim();
  const clientId = (formParams.get("client_id") ?? "").trim() || undefined;
  if (token) {
    await revokeMcpTokenByValue(platformDb, token, {
      clientId,
      requestId: options.requestId ?? null,
      nowMs: options.nowMs,
    });
  }
  // RFC 7009 always returns 200 OK even for unknown tokens
  return { status: 200, body: { revoked: true } };
}

export type LiveMcpAccessCheckResult =
  | {
      readonly ok: true;
      readonly member: AuthorizedTenantMember;
      readonly entitlement: LiveTenantEntitlement;
    }
  | {
      readonly ok: false;
      readonly status: 403;
      readonly code: "MEMBERSHIP_REVOKED" | "ROLE_INSUFFICIENT" | "SUBSCRIPTION_LOCKED";
      readonly message: string;
    };

/**
 * Live per-call verification of tenant membership, `owner`/`admin` role, and active entitlement.
 */
export async function verifyLiveMcpMemberAndEntitlement(
  platformDb: D1Database,
  params: { readonly userId: string; readonly tenantId: string; readonly nowMs?: number },
): Promise<LiveMcpAccessCheckResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());

  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(platformDb, {
      userId: params.userId,
      tenantId: params.tenantId,
      surface: "app",
      nowMs,
    });
  } catch {
    return {
      ok: false,
      status: 403,
      code: "MEMBERSHIP_REVOKED",
      message: "Keanggotaan Anda pada situs ini tidak lagi aktif.",
    };
  }

  if (!MCP_ALLOWED_MEMBER_DB_ROLES.has(member.dbRole as "owner" | "admin")) {
    return {
      ok: false,
      status: 403,
      code: "ROLE_INSUFFICIENT",
      message: "Peran Anda saat ini tidak memiliki izin akses agen AI (khusus Owner/Admin).",
    };
  }

  const entitlement = await loadLiveTenantEntitlement(
    platformDb,
    { tenantId: params.tenantId },
    { nowMs },
  );
  if (!entitlement || !MCP_ENTITLED_TENANT_STATUSES.has(entitlement.evaluation.effectiveStatus)) {
    return {
      ok: false,
      status: 403,
      code: "SUBSCRIPTION_LOCKED",
      message: "Akses MCP diblokir karena status langganan situs sedang terkunci atau ditangguhkan.",
    };
  }

  return { ok: true, member, entitlement };
}

export interface VerifiedMcpBearerContext {
  readonly tokenId: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly memberRole: "owner" | "admin";
  readonly resource: string;
  readonly scopes: ReadonlySet<McpScope>;
  readonly piiConsentAcked: boolean;
}

export type VerifyMcpBearerResult =
  | { readonly ok: true; readonly context: VerifiedMcpBearerContext }
  | {
      readonly ok: false;
      readonly status: 401 | 403;
      readonly oauthError: "invalid_token" | "insufficient_scope" | "access_denied";
      readonly code: string;
      readonly message: string;
      readonly grantId?: string;
      readonly tenantId?: string;
      readonly userId?: string;
      readonly clientId?: string;
    };

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorizationHeader.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Authoritative per-call `/mcp` bearer verifier:
 * 1. Extracts `Authorization: Bearer <token>` (NEVER reads session cookies!).
 * 2. Validates token exists, is not expired, not revoked, not rotated, grant is active.
 * 3. Strictly validates RFC 8707 `resource` on both token and grant against `canonicalResource`.
 * 4. Performs LIVE membership (`owner`/`admin` only) and LIVE entitlement checks (`locked`/`suspended` -> denied with zero data).
 */
export async function verifyMcpBearerAccess(
  platformDb: D1Database,
  params: {
    readonly authorizationHeader: string | null;
    readonly canonicalResource: string;
    readonly nowMs?: number;
  },
): Promise<VerifyMcpBearerResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const rawToken = extractBearerToken(params.authorizationHeader);
  if (!rawToken) {
    return {
      ok: false,
      status: 401,
      oauthError: "invalid_token",
      code: "MISSING_BEARER_TOKEN",
      message: "Header Authorization: Bearer wajib digunakan untuk mengakses /mcp.",
    };
  }

  const record = await lookupMcpAccessToken(platformDb, rawToken);
  if (!record) {
    return {
      ok: false,
      status: 401,
      oauthError: "invalid_token",
      code: "INVALID_TOKEN",
      message: "Token akses MCP tidak valid.",
    };
  }

  if (
    record.revokedAt !== null ||
    record.rotatedAt !== null ||
    record.grantStatus !== "active" ||
    record.clientDisabled
  ) {
    return {
      ok: false,
      status: 401,
      oauthError: "invalid_token",
      code: "TOKEN_REVOKED",
      message: "Token akses MCP telah dicabut atau tidak lagi aktif.",
      grantId: record.grantId,
      tenantId: record.tenantId,
      userId: record.userId,
      clientId: record.clientId,
    };
  }

  if (nowMs >= record.accessExpiresAt || nowMs >= record.grantCreatedAt + MCP_GRANT_MAX_LIFETIME_MS) {
    return {
      ok: false,
      status: 401,
      oauthError: "invalid_token",
      code: "TOKEN_EXPIRED",
      message: "Token akses MCP telah kedaluwarsa. Gunakan refresh_token atau hubungkan ulang aplikasi AI.",
      grantId: record.grantId,
      tenantId: record.tenantId,
      userId: record.userId,
      clientId: record.clientId,
    };
  }

  // RFC 8707 audience / resource verification — reject missing or mismatched resource!
  if (
    !record.resource ||
    !isMatchingMcpResource(record.resource, params.canonicalResource) ||
    !isMatchingMcpResource(record.grantResource, params.canonicalResource)
  ) {
    return {
      ok: false,
      status: 401,
      oauthError: "invalid_token",
      code: "RESOURCE_MISMATCH",
      message: "Audiens/resource RFC 8707 pada token tidak cocok dengan server MCP ini.",
      grantId: record.grantId,
      tenantId: record.tenantId,
      userId: record.userId,
      clientId: record.clientId,
    };
  }

  // Live membership (`owner`/`admin` only) + live entitlement check on EVERY call!
  const live = await verifyLiveMcpMemberAndEntitlement(platformDb, {
    userId: record.userId,
    tenantId: record.tenantId,
    nowMs,
  });
  if (!live.ok) {
    return {
      ok: false,
      status: 403,
      oauthError: "access_denied",
      code: live.code,
      message: live.message,
      grantId: record.grantId,
      tenantId: record.tenantId,
      userId: record.userId,
      clientId: record.clientId,
    };
  }

  await touchMcpGrantLastUsedBestEffort(platformDb, record.grantId, nowMs);

  return {
    ok: true,
    context: {
      tokenId: record.tokenId,
      grantId: record.grantId,
      clientId: record.clientId,
      clientName: record.clientName,
      userId: record.userId,
      tenantId: record.tenantId,
      organizationId: live.member.organizationId,
      tenantHandle: live.member.handle,
      tenantName: live.member.tenantName,
      memberRole: live.member.dbRole as "owner" | "admin",
      resource: record.resource,
      scopes: new Set(record.scopes),
      piiConsentAcked: record.piiConsentAcked,
    },
  };
}
